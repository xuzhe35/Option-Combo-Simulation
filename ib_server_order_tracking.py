from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, TypedDict

from trade_execution.order_tracking import (
    coerce_int_or_none,
    extract_trade_status_message,
    infer_ib_order_error_status,
    record_order_error,
    resolve_tracking,
    update_tracking_snapshot,
)


DEFAULT_HEDGE_TERMINAL_STATUSES = {
    'filled',
    'cancelled',
    'canceled',
    'apicancelled',
    'api_cancelled',
    'inactive',
    'rejected',
}

DEFAULT_COMBO_TERMINAL_STATUSES = DEFAULT_HEDGE_TERMINAL_STATUSES


class OrderTrackingEnvironment(TypedDict, total=False):
    combo_order_tracking_by_order_id: dict[int, dict[str, Any]]
    combo_order_tracking_by_perm_id: dict[int, dict[str, Any]]
    hedge_order_tracking_by_order_id: dict[int, dict[str, Any]]
    hedge_order_tracking_by_perm_id: dict[int, dict[str, Any]]
    execution_engine: Any
    send_message_safe: Any
    hedge_terminal_statuses: set[str]


def _schedule_payload_send(env: OrderTrackingEnvironment, websocket: Any, payload: dict[str, Any]) -> None:
    send_message_safe = env.get('send_message_safe')
    if websocket is None or not callable(send_message_safe):
        return
    asyncio.create_task(send_message_safe(websocket, json.dumps(payload)))


def resolve_combo_order_tracking(
    env: OrderTrackingEnvironment,
    order_id: int | None,
    perm_id: int | None,
) -> dict[str, Any] | None:
    return resolve_tracking(
        env['combo_order_tracking_by_order_id'],
        env['combo_order_tracking_by_perm_id'],
        order_id,
        perm_id,
    )


def resolve_hedge_order_tracking(
    env: OrderTrackingEnvironment,
    order_id: int | None,
    perm_id: int | None,
) -> dict[str, Any] | None:
    return resolve_tracking(
        env['hedge_order_tracking_by_order_id'],
        env['hedge_order_tracking_by_perm_id'],
        order_id,
        perm_id,
    )


def upsert_combo_order_tracking(
    env: OrderTrackingEnvironment,
    *,
    websocket: Any,
    group_id: Any,
    group_name: Any,
    account: str | None,
    execution_mode: Any,
    execution_intent: Any,
    request_source: Any,
    order_id: int | None,
    perm_id: int | None,
    status: Any = None,
    status_message: Any = None,
    legs: Any = None,
) -> dict[str, Any]:
    """Create or merge a combo tracking record without dropping accumulated fills.

    Submission goes through two passes: a pre-registration immediately after
    placeOrder (so execution reports arriving during the post-submit settle
    window can be attributed) and a final pass once the submit result is known.
    The second pass must not replace fillTotals/seenExecIds captured in between.
    """
    tracking = resolve_combo_order_tracking(env, order_id, perm_id)
    if tracking is None:
        tracking = {
            'fillTotals': {},
            'seenExecIds': set(),
        }

    tracking['websocket'] = websocket
    tracking['groupId'] = group_id
    tracking['groupName'] = group_name
    tracking['account'] = account
    tracking['executionMode'] = execution_mode
    tracking['executionIntent'] = execution_intent
    tracking['requestSource'] = request_source
    if order_id is not None:
        tracking['orderId'] = order_id
    if perm_id is not None:
        tracking['permId'] = perm_id
    if status is not None:
        tracking['status'] = status
    if status_message:
        tracking['statusMessage'] = status_message
    if legs:
        tracking['legs'] = list(legs)
    else:
        tracking.setdefault('legs', [])

    if order_id is not None:
        env['combo_order_tracking_by_order_id'][order_id] = tracking
    if perm_id is not None:
        env['combo_order_tracking_by_perm_id'][perm_id] = tracking
    return tracking


def is_terminal_combo_tracking(env: OrderTrackingEnvironment, tracking: dict[str, Any] | None) -> bool:
    if not tracking:
        return False

    status = _normalize_order_status_text(tracking.get('status'))
    terminal_statuses = env.get('combo_terminal_statuses') or DEFAULT_COMBO_TERMINAL_STATUSES
    if status in terminal_statuses:
        return True

    trade = tracking.get('trade')
    order_status = getattr(trade, 'orderStatus', None) if trade is not None else None
    trade_status = _normalize_order_status_text(getattr(order_status, 'status', None))
    return trade_status in terminal_statuses


def iter_unique_combo_order_trackings(env: OrderTrackingEnvironment):
    seen_tracking_ids = set()
    values = list(env['combo_order_tracking_by_order_id'].values()) + list(env['combo_order_tracking_by_perm_id'].values())
    for tracking in values:
        tracking_identity = id(tracking)
        if tracking_identity in seen_tracking_ids:
            continue
        seen_tracking_ids.add(tracking_identity)
        yield tracking


def build_active_combo_orders_snapshot(
    env: OrderTrackingEnvironment,
    websocket: Any,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Re-attach orphaned combo trackings to a reconnected session and snapshot them.

    Live trackings are returned in the snapshot orders list. Fill totals
    accumulated while the tracking was orphaned are replayed as standard
    combo_order_fill_cost_update pushes so leg costs are written back, and
    trackings that reached a terminal broker status while disconnected get a
    final combo_order_status_update push before being dropped.
    """
    request_data = data if isinstance(data, dict) else {}
    requested_group_id = str(request_data.get('groupId') or '').strip()
    requested_account = str(request_data.get('account') or '').strip()
    orders = []
    for tracking in list(iter_unique_combo_order_trackings(env)):
        if requested_group_id and str(tracking.get('groupId') or '').strip() != requested_group_id:
            continue
        if requested_account and str(tracking.get('account') or '').strip() != requested_account:
            continue
        tracking['websocket'] = websocket

        fill_payload = build_combo_order_fill_cost_payload(
            tracking,
            tracking.get('orderId'),
            tracking.get('permId'),
        )
        if fill_payload['orderFill']['legs']:
            _schedule_payload_send(env, websocket, fill_payload)

        status_payload = build_combo_order_status_payload(env, tracking.get('trade'), tracking)
        if is_terminal_combo_tracking(env, tracking):
            # Deliver the terminal status the page missed while disconnected,
            # then drop the tracking - it needs no further supervision.
            _schedule_payload_send(env, websocket, status_payload)
            order_id = tracking.get('orderId')
            perm_id = tracking.get('permId')
            if order_id is not None:
                env['combo_order_tracking_by_order_id'].pop(order_id, None)
            if perm_id is not None:
                env['combo_order_tracking_by_perm_id'].pop(perm_id, None)
            continue

        orders.append(status_payload['orderStatus'])

    return {
        'action': 'active_combo_orders_snapshot',
        'orders': orders,
    }


def update_combo_order_tracking_snapshot(
    tracking: dict[str, Any] | None,
    *,
    order: Any = None,
    order_status: Any = None,
    trade: Any = None,
    status_message: str | None = None,
) -> None:
    update_tracking_snapshot(
        tracking,
        order=order,
        order_status=order_status,
        trade=trade,
        status_message=status_message,
    )


def update_hedge_order_tracking_snapshot(
    tracking: dict[str, Any] | None,
    *,
    order: Any = None,
    order_status: Any = None,
    trade: Any = None,
    status_message: str | None = None,
) -> None:
    update_tracking_snapshot(
        tracking,
        order=order,
        order_status=order_status,
        trade=trade,
        status_message=status_message,
        order_field_mappings=(
            ('action', 'orderAction'),
            ('totalQuantity', 'quantity'),
            ('orderType', 'orderType'),
            ('lmtPrice', 'limitPrice'),
            ('tif', 'timeInForce'),
        ),
    )


def record_combo_order_error(tracking: dict[str, Any], error_code: Any, error_string: Any) -> str:
    return record_order_error(
        tracking,
        error_code,
        error_string,
        status_resolver=infer_ib_order_error_status,
    )


def record_hedge_order_error(tracking: dict[str, Any], error_code: Any, error_string: Any) -> str:
    return record_combo_order_error(tracking, error_code, error_string)


def _normalize_order_status_text(value: Any) -> str:
    return str(value or '').strip().lower().replace(' ', '_')


def is_terminal_hedge_tracking(env: OrderTrackingEnvironment, tracking: dict[str, Any] | None) -> bool:
    if not tracking:
        return False

    status = _normalize_order_status_text(tracking.get('status'))
    terminal_statuses = env.get('hedge_terminal_statuses') or DEFAULT_HEDGE_TERMINAL_STATUSES
    if status in terminal_statuses:
        return True

    trade = tracking.get('trade')
    order_status = getattr(trade, 'orderStatus', None) if trade is not None else None
    trade_status = _normalize_order_status_text(getattr(order_status, 'status', None))
    return trade_status in terminal_statuses


def iter_unique_hedge_order_trackings(env: OrderTrackingEnvironment):
    seen_tracking_ids = set()
    values = list(env['hedge_order_tracking_by_order_id'].values()) + list(env['hedge_order_tracking_by_perm_id'].values())
    for tracking in values:
        tracking_identity = id(tracking)
        if tracking_identity in seen_tracking_ids:
            continue
        seen_tracking_ids.add(tracking_identity)
        yield tracking


def build_active_hedge_orders_snapshot(
    env: OrderTrackingEnvironment,
    websocket: Any,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    request_data = data if isinstance(data, dict) else {}
    requested_hedge_id = str(request_data.get('hedgeId') or '').strip()
    requested_account = str(request_data.get('account') or '').strip()
    orders = []
    for tracking in iter_unique_hedge_order_trackings(env):
        if is_terminal_hedge_tracking(env, tracking):
            continue
        if requested_hedge_id and str(tracking.get('hedgeId') or '').strip() != requested_hedge_id:
            continue
        if requested_account and str(tracking.get('account') or '').strip() != requested_account:
            continue
        tracking['websocket'] = websocket
        orders.append(build_hedge_order_status_payload(tracking.get('trade'), tracking)['orderStatus'])

    return {
        'action': 'active_hedge_orders_snapshot',
        'orders': orders,
    }


def _normalize_execution_side(value: Any) -> str:
    return str(value or '').strip().upper()


def _resolve_tracking_leg_for_fill(tracking: dict[str, Any], con_id: Any, execution_side: str):
    legs = list(tracking.get('legs') or [])
    if not legs or con_id is None:
        return None

    side_matches = [
        leg for leg in legs
        if leg.get('conId') == con_id
        and _normalize_execution_side(leg.get('expectedExecutionSide')) == execution_side
    ]
    if len(side_matches) == 1:
        return side_matches[0]
    if len(side_matches) > 1:
        return None

    conid_matches = [leg for leg in legs if leg.get('conId') == con_id]
    if len(conid_matches) == 1:
        return conid_matches[0]
    return None


def build_combo_order_fill_cost_payload(
    tracking: dict[str, Any],
    order_id: Any,
    perm_id: Any,
) -> dict[str, Any]:
    fill_totals = tracking.get('fillTotals') or {}
    legs = []
    for leg in tracking.get('legs') or []:
        leg_id = leg.get('id')
        fill_total = fill_totals.get(leg_id)
        if not fill_total:
            continue
        filled_quantity = float(fill_total.get('filledQuantity') or 0)
        filled_notional = float(fill_total.get('filledNotional') or 0)
        if filled_quantity <= 0 or filled_notional <= 0:
            continue

        avg_fill_price = round(filled_notional / filled_quantity, 4)
        legs.append({
            'id': leg_id,
            'conId': leg.get('conId'),
            'localSymbol': leg.get('localSymbol') or '',
            'symbol': leg.get('symbol') or '',
            'secType': leg.get('secType') or '',
            'right': leg.get('right') or '',
            'strike': leg.get('strike'),
            'expDate': leg.get('expDate') or '',
            'targetPosition': leg.get('targetPosition'),
            'executionSide': leg.get('expectedExecutionSide'),
            'filledQuantity': round(filled_quantity, 8),
            'avgFillPrice': avg_fill_price,
            'costSource': 'execution_report',
        })

    return {
        'action': 'combo_order_fill_cost_update',
        'groupId': tracking.get('groupId'),
        'orderFill': {
            'groupId': tracking.get('groupId'),
            'groupName': tracking.get('groupName'),
            'executionMode': tracking.get('executionMode'),
            'executionIntent': tracking.get('executionIntent'),
            'requestSource': tracking.get('requestSource'),
            'orderId': order_id,
            'permId': perm_id,
            'costSource': 'execution_report',
            'legs': legs,
        },
    }


def build_hedge_order_fill_payload(
    tracking: dict[str, Any],
    order_id: Any,
    perm_id: Any,
    execution_id: Any,
    execution_side: str,
    fill_quantity: float,
    fill_price: float,
) -> dict[str, Any]:
    fill_total = tracking.get('fillTotals') or {}
    total_quantity = float(fill_total.get('filledQuantity') or 0)
    total_notional = float(fill_total.get('filledNotional') or 0)
    avg_fill_price = round(total_notional / total_quantity, 4) if total_quantity > 0 else None

    return {
        'action': 'hedge_order_fill_update',
        'hedgeId': tracking.get('hedgeId'),
        'orderFill': {
            'hedgeId': tracking.get('hedgeId'),
            'hedgeName': tracking.get('hedgeName'),
            'account': tracking.get('account'),
            'executionMode': tracking.get('executionMode'),
            'requestSource': tracking.get('requestSource'),
            'orderId': order_id,
            'permId': perm_id,
            'secType': tracking.get('secType'),
            'symbol': tracking.get('symbol'),
            'localSymbol': tracking.get('localSymbol') or '',
            'exchange': tracking.get('exchange') or '',
            'currency': tracking.get('currency') or '',
            'conId': tracking.get('conId'),
            'orderAction': tracking.get('orderAction'),
            'quantity': tracking.get('quantity'),
            'orderType': tracking.get('orderType'),
            'limitPrice': tracking.get('limitPrice'),
            'timeInForce': tracking.get('timeInForce'),
            'executionId': execution_id or None,
            'executionSide': execution_side,
            'lastFillQuantity': round(fill_quantity, 8),
            'lastFillPrice': round(fill_price, 4),
            'filledQuantity': round(total_quantity, 8),
            'avgFillPrice': avg_fill_price,
            'costSource': 'execution_report',
            'currentNetDelta': tracking.get('currentNetDelta'),
            'projectedNetDelta': tracking.get('projectedNetDelta'),
            'targetLower': tracking.get('targetLower'),
            'targetUpper': tracking.get('targetUpper'),
        },
    }


def record_hedge_order_fill(
    tracking: dict[str, Any] | None,
    execution: Any,
    contract: Any,
) -> dict[str, Any] | None:
    if tracking is None or execution is None or contract is None:
        return None

    exec_id = str(getattr(execution, 'execId', '') or '').strip()
    seen_exec_ids = tracking.setdefault('seenExecIds', set())
    if exec_id and exec_id in seen_exec_ids:
        return None

    try:
        filled_quantity = abs(float(getattr(execution, 'shares', 0) or 0))
        fill_price = abs(float(getattr(execution, 'price', 0) or 0))
    except (TypeError, ValueError):
        return None

    if filled_quantity <= 0 or fill_price <= 0:
        return None

    if exec_id:
        seen_exec_ids.add(exec_id)

    order_id = getattr(execution, 'orderId', None)
    if order_id is None:
        order_id = tracking.get('orderId')
    perm_id = getattr(execution, 'permId', None)
    if perm_id is None:
        perm_id = tracking.get('permId')

    con_id = getattr(contract, 'conId', None)
    if con_id is not None:
        tracking['conId'] = con_id
    for source_field, target_field in (
        ('localSymbol', 'localSymbol'),
        ('symbol', 'symbol'),
        ('secType', 'secType'),
        ('exchange', 'exchange'),
        ('currency', 'currency'),
    ):
        value = getattr(contract, source_field, None)
        if value:
            tracking[target_field] = value

    fill_total = tracking.setdefault('fillTotals', {
        'filledQuantity': 0.0,
        'filledNotional': 0.0,
    })
    fill_total['filledQuantity'] = float(fill_total.get('filledQuantity') or 0) + filled_quantity
    fill_total['filledNotional'] = float(fill_total.get('filledNotional') or 0) + filled_quantity * fill_price

    tracking['filled'] = round(fill_total['filledQuantity'], 8)
    tracking['avgFillPrice'] = round(fill_total['filledNotional'] / fill_total['filledQuantity'], 4)
    tracking['lastFillPrice'] = round(fill_price, 4)
    try:
        order_quantity = float(tracking.get('quantity') or 0)
        tracking['remaining'] = round(max(order_quantity - fill_total['filledQuantity'], 0), 8)
    except (TypeError, ValueError):
        pass

    return build_hedge_order_fill_payload(
        tracking,
        order_id,
        perm_id,
        exec_id,
        _normalize_execution_side(getattr(execution, 'side', None)),
        filled_quantity,
        fill_price,
    )


def build_combo_order_status_payload(
    env: OrderTrackingEnvironment,
    trade: Any,
    tracking: dict[str, Any],
) -> dict[str, Any]:
    order = getattr(trade, 'order', None)
    order_status = getattr(trade, 'orderStatus', None)
    status_message = extract_trade_status_message(trade)
    if not status_message:
        status_message = str(tracking.get('statusMessage') or '').strip()

    payload = {
        'action': 'combo_order_status_update',
        'groupId': tracking.get('groupId'),
        'orderStatus': {
            'groupId': tracking.get('groupId'),
            'groupName': tracking.get('groupName'),
            'account': tracking.get('account') or getattr(order, 'account', None),
            'executionMode': tracking.get('executionMode'),
            'executionIntent': tracking.get('executionIntent'),
            'requestSource': tracking.get('requestSource'),
            'orderId': tracking.get('orderId') if tracking.get('orderId') is not None else getattr(order, 'orderId', None),
            'permId': tracking.get('permId') if tracking.get('permId') is not None else getattr(order_status, 'permId', None),
            'status': tracking.get('status') if tracking.get('status') is not None else getattr(order_status, 'status', None),
            'filled': tracking.get('filled') if tracking.get('filled') is not None else getattr(order_status, 'filled', None),
            'remaining': tracking.get('remaining') if tracking.get('remaining') is not None else getattr(order_status, 'remaining', None),
            'avgFillPrice': tracking.get('avgFillPrice') if tracking.get('avgFillPrice') is not None else getattr(order_status, 'avgFillPrice', None),
            'lastFillPrice': tracking.get('lastFillPrice') if tracking.get('lastFillPrice') is not None else getattr(order_status, 'lastFillPrice', None),
            'whyHeld': tracking.get('whyHeld') if tracking.get('whyHeld') is not None else getattr(order_status, 'whyHeld', None),
            'mktCapPrice': tracking.get('mktCapPrice') if tracking.get('mktCapPrice') is not None else getattr(order_status, 'mktCapPrice', None),
            'statusMessage': status_message or None,
        },
    }
    execution_engine = env.get('execution_engine')
    managed_snapshot = None
    if execution_engine is not None and hasattr(execution_engine, 'get_managed_order_snapshot'):
        managed_snapshot = execution_engine.get_managed_order_snapshot(
            payload['orderStatus'].get('orderId'),
            payload['orderStatus'].get('permId'),
        )
    if managed_snapshot:
        payload['orderStatus'].update(managed_snapshot)
    else:
        payload['orderStatus']['managedMode'] = False

    for field in (
        'account',
        'orderId',
        'permId',
        'status',
        'filled',
        'remaining',
        'avgFillPrice',
        'lastFillPrice',
        'whyHeld',
        'mktCapPrice',
    ):
        value = tracking.get(field)
        if value is not None:
            payload['orderStatus'][field] = value

    payload['orderStatus']['statusMessage'] = status_message or None
    return payload


def build_hedge_order_status_payload(trade: Any, tracking: dict[str, Any]) -> dict[str, Any]:
    order = getattr(trade, 'order', None) if trade is not None else None
    order_status = getattr(trade, 'orderStatus', None) if trade is not None else None
    status_message = extract_trade_status_message(trade) if trade is not None else ''
    if not status_message:
        status_message = str(tracking.get('statusMessage') or '').strip()

    payload = {
        'action': 'hedge_order_status_update',
        'hedgeId': tracking.get('hedgeId'),
        'orderStatus': {
            'hedgeId': tracking.get('hedgeId'),
            'hedgeName': tracking.get('hedgeName'),
            'account': tracking.get('account') or getattr(order, 'account', None),
            'executionMode': tracking.get('executionMode'),
            'requestSource': tracking.get('requestSource'),
            'secType': tracking.get('secType'),
            'symbol': tracking.get('symbol'),
            'localSymbol': tracking.get('localSymbol') or '',
            'exchange': tracking.get('exchange') or '',
            'currency': tracking.get('currency') or '',
            'conId': tracking.get('conId'),
            'orderAction': tracking.get('orderAction'),
            'quantity': tracking.get('quantity'),
            'orderType': tracking.get('orderType'),
            'limitPrice': tracking.get('limitPrice'),
            'timeInForce': tracking.get('timeInForce'),
            'contractMonth': tracking.get('contractMonth') or '',
            'multiplier': tracking.get('multiplier') or '',
            'orderId': tracking.get('orderId') if tracking.get('orderId') is not None else getattr(order, 'orderId', None),
            'permId': tracking.get('permId') if tracking.get('permId') is not None else getattr(order_status, 'permId', None),
            'status': tracking.get('status') if tracking.get('status') is not None else getattr(order_status, 'status', None),
            'filled': tracking.get('filled') if tracking.get('filled') is not None else getattr(order_status, 'filled', None),
            'remaining': tracking.get('remaining') if tracking.get('remaining') is not None else getattr(order_status, 'remaining', None),
            'avgFillPrice': tracking.get('avgFillPrice') if tracking.get('avgFillPrice') is not None else getattr(order_status, 'avgFillPrice', None),
            'lastFillPrice': tracking.get('lastFillPrice') if tracking.get('lastFillPrice') is not None else getattr(order_status, 'lastFillPrice', None),
            'whyHeld': tracking.get('whyHeld') if tracking.get('whyHeld') is not None else getattr(order_status, 'whyHeld', None),
            'mktCapPrice': tracking.get('mktCapPrice') if tracking.get('mktCapPrice') is not None else getattr(order_status, 'mktCapPrice', None),
            'currentNetDelta': tracking.get('currentNetDelta'),
            'projectedNetDelta': tracking.get('projectedNetDelta'),
            'targetLower': tracking.get('targetLower'),
            'targetUpper': tracking.get('targetUpper'),
            'statusMessage': status_message or None,
        },
    }

    for field in (
        'account',
        'orderId',
        'permId',
        'status',
        'filled',
        'remaining',
        'avgFillPrice',
        'lastFillPrice',
        'whyHeld',
        'mktCapPrice',
    ):
        value = tracking.get(field)
        if value is not None:
            payload['orderStatus'][field] = value

    payload['orderStatus']['statusMessage'] = status_message or None
    return payload


def build_combo_order_status_handler(env: OrderTrackingEnvironment):
    def on_combo_order_status(trade: Any) -> None:
        order = getattr(trade, 'order', None)
        order_status = getattr(trade, 'orderStatus', None)
        if order is None or order_status is None:
            return

        order_id = getattr(order, 'orderId', None)
        perm_id = getattr(order_status, 'permId', None)
        tracking = resolve_combo_order_tracking(env, order_id, perm_id)
        if tracking is None:
            return

        update_combo_order_tracking_snapshot(
            tracking,
            order=order,
            order_status=order_status,
            trade=trade,
            status_message=extract_trade_status_message(trade),
        )

        websocket = tracking.get('websocket')
        if websocket is None:
            return

        payload = build_combo_order_status_payload(env, trade, tracking)
        logging.info(
            "Broadcasting combo order status update: groupId=%s orderId=%s permId=%s status=%s filled=%s remaining=%s",
            tracking.get('groupId'),
            payload['orderStatus'].get('orderId'),
            payload['orderStatus'].get('permId'),
            payload['orderStatus'].get('status'),
            payload['orderStatus'].get('filled'),
            payload['orderStatus'].get('remaining'),
        )
        _schedule_payload_send(env, websocket, payload)

    return on_combo_order_status


def build_hedge_order_status_handler(env: OrderTrackingEnvironment):
    def on_hedge_order_status(trade: Any) -> None:
        order = getattr(trade, 'order', None)
        order_status = getattr(trade, 'orderStatus', None)
        if order is None or order_status is None:
            return

        order_id = getattr(order, 'orderId', None)
        perm_id = getattr(order_status, 'permId', None)
        tracking = resolve_hedge_order_tracking(env, order_id, perm_id)
        if tracking is None:
            return

        update_hedge_order_tracking_snapshot(
            tracking,
            order=order,
            order_status=order_status,
            trade=trade,
            status_message=extract_trade_status_message(trade),
        )

        websocket = tracking.get('websocket')
        if websocket is None:
            return

        payload = build_hedge_order_status_payload(trade, tracking)
        logging.info(
            "Broadcasting hedge order status update: hedgeId=%s orderId=%s permId=%s status=%s filled=%s remaining=%s",
            tracking.get('hedgeId'),
            payload['orderStatus'].get('orderId'),
            payload['orderStatus'].get('permId'),
            payload['orderStatus'].get('status'),
            payload['orderStatus'].get('filled'),
            payload['orderStatus'].get('remaining'),
        )
        _schedule_payload_send(env, websocket, payload)

    return on_hedge_order_status


def build_combo_order_error_handler(env: OrderTrackingEnvironment):
    def on_combo_order_error(req_id: Any, error_code: Any, error_string: Any, contract: Any) -> None:
        del contract
        order_id = coerce_int_or_none(req_id)
        tracking = resolve_combo_order_tracking(env, order_id, None)
        if tracking is None:
            return

        message = record_combo_order_error(tracking, error_code, error_string)
        if not message:
            return

        websocket = tracking.get('websocket')
        if websocket is None:
            return

        payload = build_combo_order_status_payload(env, tracking.get('trade'), tracking)
        logging.info(
            "Broadcasting combo order error update: groupId=%s orderId=%s permId=%s status=%s statusMessage=%r",
            tracking.get('groupId'),
            payload['orderStatus'].get('orderId'),
            payload['orderStatus'].get('permId'),
            payload['orderStatus'].get('status'),
            payload['orderStatus'].get('statusMessage'),
        )
        _schedule_payload_send(env, websocket, payload)

    return on_combo_order_error


def build_hedge_order_error_handler(env: OrderTrackingEnvironment):
    def on_hedge_order_error(req_id: Any, error_code: Any, error_string: Any, contract: Any) -> None:
        del contract
        order_id = coerce_int_or_none(req_id)
        tracking = resolve_hedge_order_tracking(env, order_id, None)
        if tracking is None:
            return

        message = record_hedge_order_error(tracking, error_code, error_string)
        if not message:
            return

        websocket = tracking.get('websocket')
        if websocket is None:
            return

        payload = build_hedge_order_status_payload(tracking.get('trade'), tracking)
        logging.info(
            "Broadcasting hedge order error update: hedgeId=%s orderId=%s permId=%s status=%s statusMessage=%r",
            tracking.get('hedgeId'),
            payload['orderStatus'].get('orderId'),
            payload['orderStatus'].get('permId'),
            payload['orderStatus'].get('status'),
            payload['orderStatus'].get('statusMessage'),
        )
        _schedule_payload_send(env, websocket, payload)

    return on_hedge_order_error


def build_combo_order_exec_details_handler(env: OrderTrackingEnvironment):
    def on_combo_order_exec_details(trade: Any, fill: Any) -> None:
        execution = getattr(fill, 'execution', None)
        contract = getattr(fill, 'contract', None) or getattr(trade, 'contract', None)
        if execution is None or contract is None:
            return

        if str(getattr(contract, 'secType', '') or '').upper() == 'BAG':
            return

        order_id = getattr(execution, 'orderId', None)
        perm_id = getattr(execution, 'permId', None)
        if order_id is None:
            order_id = getattr(getattr(trade, 'order', None), 'orderId', None)
        if perm_id is None:
            perm_id = getattr(getattr(trade, 'orderStatus', None), 'permId', None)

        tracking = resolve_combo_order_tracking(env, order_id, perm_id)
        if tracking is None or tracking.get('executionMode') != 'submit':
            return

        # Record fills even while the tracking is orphaned (websocket is None
        # after a browser disconnect) so the attributed costs survive until a
        # reconnected session re-adopts the tracking; only the push is skipped.
        exec_id = str(getattr(execution, 'execId', '') or '').strip()
        seen_exec_ids = tracking.setdefault('seenExecIds', set())
        if exec_id and exec_id in seen_exec_ids:
            return

        con_id = getattr(contract, 'conId', None)
        execution_side = _normalize_execution_side(getattr(execution, 'side', None))
        leg = _resolve_tracking_leg_for_fill(tracking, con_id, execution_side)
        if leg is None:
            logging.warning(
                "Unable to attribute combo fill leg for groupId=%s orderId=%s permId=%s conId=%s side=%s",
                tracking.get('groupId'),
                order_id,
                perm_id,
                con_id,
                execution_side,
            )
            return

        try:
            filled_quantity = abs(float(getattr(execution, 'shares', 0) or 0))
            fill_price = abs(float(getattr(execution, 'price', 0) or 0))
        except (TypeError, ValueError):
            return

        if filled_quantity <= 0 or fill_price <= 0:
            return

        if exec_id:
            seen_exec_ids.add(exec_id)

        leg_id = leg.get('id')
        if not leg_id:
            return

        fill_totals = tracking.setdefault('fillTotals', {})
        fill_total = fill_totals.setdefault(leg_id, {
            'filledQuantity': 0.0,
            'filledNotional': 0.0,
        })
        fill_total['filledQuantity'] += filled_quantity
        fill_total['filledNotional'] += filled_quantity * fill_price

        avg_fill_price = round(fill_total['filledNotional'] / fill_total['filledQuantity'], 4)
        logging.info(
            "Broadcasting combo execution fill cost: groupId=%s orderId=%s permId=%s legId=%s localSymbol=%s side=%s qty=%s avgFillPrice=%s",
            tracking.get('groupId'),
            order_id,
            perm_id,
            leg_id,
            leg.get('localSymbol'),
            execution_side,
            fill_total['filledQuantity'],
            avg_fill_price,
        )
        payload = build_combo_order_fill_cost_payload(tracking, order_id, perm_id)
        _schedule_payload_send(env, tracking.get('websocket'), payload)

    return on_combo_order_exec_details


def build_hedge_order_exec_details_handler(env: OrderTrackingEnvironment):
    def on_hedge_order_exec_details(trade: Any, fill: Any) -> None:
        execution = getattr(fill, 'execution', None)
        contract = getattr(fill, 'contract', None) or getattr(trade, 'contract', None)
        if execution is None or contract is None:
            return

        if str(getattr(contract, 'secType', '') or '').upper() == 'BAG':
            return

        order_id = getattr(execution, 'orderId', None)
        perm_id = getattr(execution, 'permId', None)
        if order_id is None:
            order_id = getattr(getattr(trade, 'order', None), 'orderId', None)
        if perm_id is None:
            perm_id = getattr(getattr(trade, 'orderStatus', None), 'permId', None)

        tracking = resolve_hedge_order_tracking(env, order_id, perm_id)
        if tracking is None or tracking.get('executionMode') != 'submit':
            return

        payload = record_hedge_order_fill(tracking, execution, contract)
        if payload is None:
            return

        websocket = tracking.get('websocket')
        if websocket is None:
            return

        logging.info(
            "Broadcasting hedge execution fill: hedgeId=%s orderId=%s permId=%s localSymbol=%s side=%s qty=%s avgFillPrice=%s",
            tracking.get('hedgeId'),
            payload['orderFill'].get('orderId'),
            payload['orderFill'].get('permId'),
            payload['orderFill'].get('localSymbol'),
            payload['orderFill'].get('executionSide'),
            payload['orderFill'].get('filledQuantity'),
            payload['orderFill'].get('avgFillPrice'),
        )
        _schedule_payload_send(env, websocket, payload)

    return on_hedge_order_exec_details
