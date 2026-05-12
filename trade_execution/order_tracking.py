"""Shared order-tracking helpers used by server and adapter layers."""

from __future__ import annotations

import re
from typing import Any, TypedDict


class OrderTrackingRecord(TypedDict, total=False):
    websocket: Any
    trade: Any
    account: str
    orderId: int
    permId: int
    status: str
    filled: float
    remaining: float
    avgFillPrice: float
    lastFillPrice: float
    whyHeld: str
    mktCapPrice: float
    statusMessage: str
    groupId: str
    groupName: str
    hedgeId: str
    symbol: str
    secType: str
    localSymbol: str
    quantity: float
    orderType: str
    limitPrice: float
    referencePrice: float
    currentNetDelta: float
    projectedNetDelta: float
    targetLower: float
    targetUpper: float
    cancelRequested: bool
    executionMode: str
    executionIntent: str


ORDER_STATUS_TRACKING_FIELDS = (
    'permId',
    'status',
    'filled',
    'remaining',
    'avgFillPrice',
    'lastFillPrice',
    'whyHeld',
    'mktCapPrice',
)


def resolve_tracking(
    order_id_map: dict[int, OrderTrackingRecord],
    perm_id_map: dict[int, OrderTrackingRecord],
    order_id: int | None,
    perm_id: int | None,
) -> OrderTrackingRecord | None:
    tracking = None
    if order_id is not None:
        tracking = order_id_map.get(order_id)
    if tracking is None and perm_id is not None:
        tracking = perm_id_map.get(perm_id)
    if tracking is not None and order_id is not None:
        order_id_map[order_id] = tracking
    if tracking is not None and perm_id is not None:
        perm_id_map[perm_id] = tracking
    return tracking


def update_tracking_snapshot(
    tracking: OrderTrackingRecord | None,
    *,
    order: Any = None,
    order_status: Any = None,
    trade: Any = None,
    status_message: str | None = None,
    order_field_mappings: tuple[tuple[str, str], ...] = (),
) -> None:
    if tracking is None:
        return

    if trade is not None:
        tracking['trade'] = trade
        if order is None:
            order = getattr(trade, 'order', None)
        if order_status is None:
            order_status = getattr(trade, 'orderStatus', None)

    if order is not None:
        account = str(getattr(order, 'account', '') or '').strip()
        if account:
            tracking['account'] = account

        order_id = getattr(order, 'orderId', None)
        if order_id is not None:
            tracking['orderId'] = order_id

        for source_field, target_field in tuple(order_field_mappings or ()):
            value = getattr(order, source_field, None)
            if value is not None:
                tracking[target_field] = value

    if order_status is not None:
        for field in ORDER_STATUS_TRACKING_FIELDS:
            value = getattr(order_status, field, None)
            if value is not None:
                tracking[field] = value

    if status_message:
        tracking['statusMessage'] = status_message


def coerce_int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def extract_trade_status_message(trade: Any) -> str:
    trade_log = list(getattr(trade, 'log', None) or [])
    for entry in reversed(trade_log):
        message = str(getattr(entry, 'message', '') or '').strip()
        error_code = getattr(entry, 'errorCode', None)
        if message:
            if error_code not in (None, '', 0, '0'):
                return f'IB {error_code}: {message}'
            return message

    advanced_error = str(getattr(trade, 'advancedError', '') or '').strip()
    if advanced_error:
        return advanced_error

    for entry in reversed(trade_log):
        error_code = getattr(entry, 'errorCode', None)
        if error_code not in (None, '', 0, '0'):
            return f'IB error code {error_code}.'

    return ''


def normalize_ib_error_text(error_string: Any) -> str:
    text = str(error_string or '').strip()
    if not text:
        return ''

    text = re.sub(r'<br\s*/?>', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def format_ib_order_error_message(error_code: Any, error_string: Any) -> str:
    normalized_text = normalize_ib_error_text(error_string)
    if error_code not in (None, '', 0, '0'):
        code_text = f'IB {coerce_int_or_none(error_code) or error_code}'
        return f'{code_text}: {normalized_text}' if normalized_text else f'{code_text}.'
    return normalized_text


def infer_ib_order_error_status(error_code: Any, current_status: Any) -> str | None:
    status = str(current_status or '').strip()
    if status in {'Filled', 'Cancelled', 'ApiCancelled', 'Inactive'}:
        return status

    parsed_code = coerce_int_or_none(error_code)
    if parsed_code == 202:
        return 'Cancelled'
    if parsed_code is not None and parsed_code >= 200:
        return 'Inactive'
    return status or None


def record_order_error(
    tracking: OrderTrackingRecord,
    error_code: Any,
    error_string: Any,
    *,
    status_resolver=infer_ib_order_error_status,
) -> str:
    message = format_ib_order_error_message(error_code, error_string)
    if not message:
        return ''

    tracking['statusMessage'] = message
    implied_status = status_resolver(error_code, tracking.get('status'))
    if implied_status:
        tracking['status'] = implied_status
    return message
