import asyncio
import json
import logging
import os
import random
import signal
import sqlite3
import configparser
from contextlib import AsyncExitStack
from datetime import datetime
from ib_async import *
import websockets

from historical_replay_service import HistoricalReplayService, normalize_replay_date
from trade_execution.engine import ExecutionEngine
from trade_execution.adapters.ibkr import IbkrExecutionAdapter

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Load Config
config = configparser.ConfigParser()
config.read('config.ini')

TWS_HOST = config.get('tws', 'host', fallback='127.0.0.1')
TWS_PORT = config.getint('tws', 'port', fallback=7496)
TWS_CLIENT_ID = config.getint('tws', 'client_id', fallback=999)

CONFIGURED_WS_HOST = config.get('server', 'ws_host', fallback='127.0.0.1').strip()
WS_PORT = config.getint('server', 'ws_port', fallback=8765)
MANAGED_REPRICE_THRESHOLD_DEFAULT = config.getfloat('execution', 'managed_reprice_threshold_default', fallback=0.01)
MANAGED_REPRICE_INTERVAL_SECONDS = config.getfloat('execution', 'managed_reprice_interval_seconds', fallback=2.0)
MANAGED_REPRICE_MAX_UPDATES = config.getint('execution', 'managed_reprice_max_updates', fallback=12)
MANAGED_REPRICE_TIMEOUT_SECONDS = config.getfloat('execution', 'managed_reprice_timeout_seconds', fallback=600.0)
HISTORICAL_SQLITE_DB = os.path.abspath(
    config.get('historical', 'sqlite_db_path', fallback=os.path.join('sqlite_spy', 'spy_options.db'))
)

def _parse_ws_hosts(raw_value):
    hosts = []
    for candidate in str(raw_value or '').split(','):
        host = candidate.strip()
        if host and host not in hosts:
            hosts.append(host)
    return hosts or ['127.0.0.1']


WS_HOSTS = _parse_ws_hosts(CONFIGURED_WS_HOST)

for host in WS_HOSTS:
    if host not in ('127.0.0.1', 'localhost', '::1', '[::1]'):
        logging.warning(
            "WebSocket server is listening on non-loopback host %r. "
            "Restrict access with Tailscale ACLs and the OS firewall.",
            host,
        )

ib = IB()
connected_clients = set()
# Map websocket -> { leg_id: Ticker }
client_subscriptions = {}
qualified_underlyings = {}
portfolio_avg_cost_cache = {}
combo_order_tracking_by_order_id = {}
combo_order_tracking_by_perm_id = {}
option_iv_debug_last_logged = {}
historical_replay_service = HistoricalReplayService(
    HISTORICAL_SQLITE_DB,
    logger=logging.getLogger('historical_replay.sqlite'),
)

SUPPORTED_LIVE_FAMILIES = {
    'ES': {
        'underlying_sec_type': 'FUT',
        'option_sec_type': 'FOP',
        'underlying_symbol': 'ES',
        'option_symbol': 'ES',
        'exchange': 'CME',
        'currency': 'USD',
        'multiplier': '50',
        'trading_class': 'E3A',
    },
    'NQ': {
        'underlying_sec_type': 'FUT',
        'option_sec_type': 'FOP',
        'underlying_symbol': 'NQ',
        'option_symbol': 'NQ',
        'exchange': 'CME',
        'currency': 'USD',
        'multiplier': '20',
        'trading_class': 'Q3A',
    },
    'CL': {
        'underlying_sec_type': 'FUT',
        'option_sec_type': 'FOP',
        'underlying_symbol': 'CL',
        'option_symbol': 'CL',
        'exchange': 'NYMEX',
        'currency': 'USD',
        'multiplier': '1000',
        'trading_class': 'ML3',
    },
}

INDEX_EXCHANGE_FALLBACKS = {
    'SPX': ('CBOE', 'SMART', ''),
    'NDX': ('NASDAQ', 'SMART', ''),
}


def _record_combo_order_submission(websocket, request, result):
    tracking = {
        'websocket': websocket,
        'groupId': request.group_id,
        'groupName': request.group_name,
        'executionMode': request.execution_mode,
        'executionIntent': request.execution_intent,
        'requestSource': request.request_source,
        'legs': list(getattr(result, 'tracking_legs', []) or []),
        'fillTotals': {},
        'seenExecIds': set(),
    }
    if result.order_id is not None:
        combo_order_tracking_by_order_id[result.order_id] = tracking
    if result.perm_id is not None:
        combo_order_tracking_by_perm_id[result.perm_id] = tracking


async def _emit_combo_order_update(websocket, payload):
    await send_message_safe(websocket, json.dumps(payload))


execution_adapter = IbkrExecutionAdapter(
    ib=ib,
    client_subscriptions=client_subscriptions,
    qualified_underlyings=qualified_underlyings,
    supported_live_families=SUPPORTED_LIVE_FAMILIES,
    index_exchange_fallbacks=INDEX_EXCHANGE_FALLBACKS,
    managed_reprice_threshold=MANAGED_REPRICE_THRESHOLD_DEFAULT,
    managed_reprice_interval_seconds=MANAGED_REPRICE_INTERVAL_SECONDS,
    managed_reprice_max_updates=MANAGED_REPRICE_MAX_UPDATES,
    managed_reprice_timeout_seconds=MANAGED_REPRICE_TIMEOUT_SECONDS,
    logger=logging.getLogger('trade_execution.ibkr'),
    emit_order_update=_emit_combo_order_update,
)

execution_engine = ExecutionEngine(
    execution_adapter,
    logger=logging.getLogger('trade_execution.engine'),
    on_submit_result=_record_combo_order_submission,
)


def _normalize_contract_date(value):
    return str(value or '').replace('-', '').strip()


def _portfolio_avg_cost_cache_key(item_payload):
    return (
        str(item_payload.get('account') or '').strip(),
        str(item_payload.get('secType') or '').strip().upper(),
        str(item_payload.get('symbol') or '').strip().upper(),
        _normalize_contract_date(item_payload.get('expDate')),
        str(item_payload.get('right') or '').strip().upper(),
        str(item_payload.get('strike')),
        str(item_payload.get('localSymbol') or '').strip(),
    )


def _serialize_finite_number(raw_value, digits=4):
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return None

    if value != value:
        return None
    return round(value, digits)


def _serialize_portfolio_avg_cost_item(portfolio_item):
    contract = getattr(portfolio_item, 'contract', None)
    if contract is None:
        return None

    position = getattr(portfolio_item, 'position', None)
    average_cost = getattr(portfolio_item, 'averageCost', None)
    if position in (None, 0) or average_cost in (None, 0):
        return None

    try:
        position_value = float(position)
        average_cost_value = float(average_cost)
    except (TypeError, ValueError):
        return None

    if position_value == 0 or average_cost_value == 0:
        return None

    sec_type = str(getattr(contract, 'secType', '') or '').upper()
    multiplier_raw = getattr(contract, 'multiplier', '') or ''
    try:
        multiplier_value = float(multiplier_raw) if multiplier_raw not in ('', None) else 1.0
    except (TypeError, ValueError):
        multiplier_value = 1.0

    avg_cost_per_unit = abs(average_cost_value)
    if sec_type in ('OPT', 'FOP', 'FUT') and multiplier_value > 0:
        avg_cost_per_unit = abs(average_cost_value) / multiplier_value

    if not (avg_cost_per_unit == avg_cost_per_unit and avg_cost_per_unit > 0):
        return None

    market_price = _serialize_finite_number(getattr(portfolio_item, 'marketPrice', None))
    unrealized_pnl = _serialize_finite_number(getattr(portfolio_item, 'unrealizedPNL', None))
    realized_pnl = _serialize_finite_number(getattr(portfolio_item, 'realizedPNL', None))

    return {
        'account': getattr(portfolio_item, 'account', '') or '',
        'secType': sec_type,
        'symbol': getattr(contract, 'symbol', '') or '',
        'localSymbol': getattr(contract, 'localSymbol', '') or '',
        'expDate': _normalize_contract_date(getattr(contract, 'lastTradeDateOrContractMonth', '') or ''),
        'right': getattr(contract, 'right', '') or '',
        'strike': getattr(contract, 'strike', None),
        'multiplier': str(multiplier_raw or ''),
        'position': position_value,
        'averageCost': average_cost_value,
        'avgCostPerUnit': round(avg_cost_per_unit, 4),
        'marketPrice': market_price,
        'unrealizedPNL': unrealized_pnl,
        'realizedPNL': realized_pnl,
    }


def _build_portfolio_avg_cost_payload(items):
    return {
        'action': 'portfolio_avg_cost_update',
        'items': items,
    }


def _get_managed_accounts():
    if not ib.isConnected():
        return []

    try:
        raw_accounts = ib.managedAccounts()
    except Exception:
        logging.exception("Failed to read managed accounts from ib_async")
        return []

    accounts = []
    for raw_account in raw_accounts or []:
        account = str(raw_account or '').strip()
        if account and account not in accounts:
            accounts.append(account)
    return accounts


def _build_managed_accounts_payload():
    accounts = _get_managed_accounts()
    payload = {
        'action': 'managed_accounts_update',
        'accounts': accounts,
        'ibConnected': ib.isConnected(),
    }
    if accounts:
        payload['defaultAccount'] = accounts[0]
    return payload


def _broadcast_managed_accounts_snapshot():
    if not connected_clients:
        return

    message = json.dumps(_build_managed_accounts_payload())
    for ws in list(connected_clients):
        asyncio.create_task(send_message_safe(ws, message))


def _send_managed_accounts_snapshot(websocket):
    asyncio.create_task(send_message_safe(websocket, json.dumps(_build_managed_accounts_payload())))


def _broadcast_portfolio_avg_cost_items(items):
    if not items or not connected_clients:
        return

    message = json.dumps(_build_portfolio_avg_cost_payload(items))
    for ws in list(connected_clients):
        asyncio.create_task(send_message_safe(ws, message))


def _send_portfolio_avg_cost_snapshot(websocket):
    if not portfolio_avg_cost_cache:
        return
    message = json.dumps(_build_portfolio_avg_cost_payload(list(portfolio_avg_cost_cache.values())))
    asyncio.create_task(send_message_safe(websocket, message))


def on_update_portfolio_item(portfolio_item):
    item = _serialize_portfolio_avg_cost_item(portfolio_item)
    if not item:
        return

    portfolio_avg_cost_cache[_portfolio_avg_cost_cache_key(item)] = item
    logging.info(
        f"Broadcasting portfolio avg cost update: "
        f"{item.get('secType')} {item.get('localSymbol') or item.get('symbol')} "
        f"position={item.get('position')} avgCostPerUnit={item.get('avgCostPerUnit')} "
        f"marketPrice={item.get('marketPrice')}"
    )
    _broadcast_portfolio_avg_cost_items([item])


ib.updatePortfolioEvent += on_update_portfolio_item


def _resolve_combo_order_tracking(order_id, perm_id):
    tracking = None
    if order_id is not None:
        tracking = combo_order_tracking_by_order_id.get(order_id)
    if tracking is None and perm_id is not None:
        tracking = combo_order_tracking_by_perm_id.get(perm_id)
    if tracking is not None and order_id is not None:
        combo_order_tracking_by_order_id[order_id] = tracking
    if tracking is not None and perm_id is not None:
        combo_order_tracking_by_perm_id[perm_id] = tracking
    return tracking


def _normalize_execution_side(value):
    return str(value or '').strip().upper()


def _resolve_tracking_leg_for_fill(tracking, con_id, execution_side):
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


def _build_combo_order_fill_cost_payload(tracking, order_id, perm_id):
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


def _build_combo_order_status_payload(trade, tracking):
    order = getattr(trade, 'order', None)
    order_status = getattr(trade, 'orderStatus', None)
    trade_log = getattr(trade, 'log', None) or []
    last_message = ''
    if trade_log:
        last_message = getattr(trade_log[-1], 'message', '') or ''

    payload = {
        'action': 'combo_order_status_update',
        'groupId': tracking.get('groupId'),
        'orderStatus': {
            'groupId': tracking.get('groupId'),
            'groupName': tracking.get('groupName'),
            'executionMode': tracking.get('executionMode'),
            'executionIntent': tracking.get('executionIntent'),
            'requestSource': tracking.get('requestSource'),
            'orderId': getattr(order, 'orderId', None),
            'permId': getattr(order_status, 'permId', None),
            'status': getattr(order_status, 'status', None),
            'filled': getattr(order_status, 'filled', None),
            'remaining': getattr(order_status, 'remaining', None),
            'avgFillPrice': getattr(order_status, 'avgFillPrice', None),
            'lastFillPrice': getattr(order_status, 'lastFillPrice', None),
            'whyHeld': getattr(order_status, 'whyHeld', None),
            'mktCapPrice': getattr(order_status, 'mktCapPrice', None),
            'statusMessage': last_message or None,
        },
    }
    managed_snapshot = execution_engine.get_managed_order_snapshot(
        payload['orderStatus'].get('orderId'),
        payload['orderStatus'].get('permId'),
    )
    if managed_snapshot:
        payload['orderStatus'].update(managed_snapshot)
    else:
        payload['orderStatus']['managedMode'] = False
    return payload


def on_combo_order_status(trade):
    order = getattr(trade, 'order', None)
    order_status = getattr(trade, 'orderStatus', None)
    if order is None or order_status is None:
        return

    order_id = getattr(order, 'orderId', None)
    perm_id = getattr(order_status, 'permId', None)
    tracking = _resolve_combo_order_tracking(order_id, perm_id)
    if tracking is None:
        return

    websocket = tracking.get('websocket')
    if websocket is None:
        return

    payload = _build_combo_order_status_payload(trade, tracking)
    logging.info(
        f"Broadcasting combo order status update: groupId={tracking.get('groupId')} "
        f"orderId={payload['orderStatus'].get('orderId')} permId={payload['orderStatus'].get('permId')} "
        f"status={payload['orderStatus'].get('status')} "
        f"filled={payload['orderStatus'].get('filled')} remaining={payload['orderStatus'].get('remaining')}"
    )
    asyncio.create_task(send_message_safe(websocket, json.dumps(payload)))


ib.orderStatusEvent += on_combo_order_status


def on_combo_order_exec_details(trade, fill):
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

    tracking = _resolve_combo_order_tracking(order_id, perm_id)
    if tracking is None or tracking.get('executionMode') != 'submit':
        return

    websocket = tracking.get('websocket')
    if websocket is None:
        return

    exec_id = str(getattr(execution, 'execId', '') or '').strip()
    seen_exec_ids = tracking.setdefault('seenExecIds', set())
    if exec_id and exec_id in seen_exec_ids:
        return

    con_id = getattr(contract, 'conId', None)
    execution_side = _normalize_execution_side(getattr(execution, 'side', None))
    leg = _resolve_tracking_leg_for_fill(tracking, con_id, execution_side)
    if leg is None:
        logging.warning(
            f"Unable to attribute combo fill leg for groupId={tracking.get('groupId')} "
            f"orderId={order_id} permId={perm_id} conId={con_id} side={execution_side}"
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
        f"Broadcasting combo execution fill cost: groupId={tracking.get('groupId')} "
        f"orderId={order_id} permId={perm_id} legId={leg_id} "
        f"localSymbol={leg.get('localSymbol')} side={execution_side} "
        f"qty={fill_total['filledQuantity']} avgFillPrice={avg_fill_price}"
    )
    payload = _build_combo_order_fill_cost_payload(tracking, order_id, perm_id)
    asyncio.create_task(send_message_safe(websocket, json.dumps(payload)))


ib.execDetailsEvent += on_combo_order_exec_details

async def connect_ib():
    """Connect to IB TWS/Gateway. Retries indefinitely — one connection per session.

    If Error 326 (client ID already in use) is received during the handshake,
    automatically picks a new random client ID and retries immediately.
    """
    client_id = TWS_CLIENT_ID

    while not ib.isConnected():
        # Temporary listener to capture any error codes emitted during the handshake.
        error_codes: list[int] = []
        def _capture_error(reqId, errorCode, errorString, contract):
            error_codes.append(errorCode)

        ib.errorEvent += _capture_error
        try:
            logging.info(f"Connecting to IB TWS/Gateway at {TWS_HOST}:{TWS_PORT} (Client ID: {client_id})...")
            await ib.connectAsync(TWS_HOST, TWS_PORT, clientId=client_id, timeout=20)
            logging.info(f"Successfully connected to IB (Client ID: {client_id}).")
            # Enforce Real-Time Data (1)
            ib.reqMarketDataType(1)
            logging.info("Managed accounts available: %s", ', '.join(_get_managed_accounts()) or '<none>')
            _broadcast_managed_accounts_snapshot()
        except Exception as e:
            if 326 in error_codes:
                # Error 326: "Client ID already in use" — pick a random ID and retry immediately
                client_id = random.randint(1, 998)
                logging.warning(f"Client ID already in use (Error 326). Retrying with Client ID: {client_id}...")
                await asyncio.sleep(1)
            else:
                logging.error(f"Connection failed: {e}. Retrying in 5 seconds...")
                await asyncio.sleep(5)
        finally:
            # Always remove the temporary listener so it doesn't fire during normal operation
            ib.errorEvent -= _capture_error

def _extract_market_price(ticker):
    """Extract the best available price from a market-data ticker.
    Fallback chain: marketPrice() → last → close.
    Returns the price (float) or None if no valid price is available.
    """
    price = ticker.marketPrice()
    if not (price == price and price > 0):  # NaN check
        if ticker.last == ticker.last and ticker.last > 0:
            price = ticker.last
        elif ticker.close == ticker.close and ticker.close > 0:
            price = ticker.close
        else:
            return None
    return price

def _normalize_symbol(value):
    return str(value or '').strip().upper()

def _to_contract_month(value):
    cleaned = str(value or '').replace('-', '')
    return cleaned[:6]

def _to_expiry(value):
    return str(value or '').replace('-', '')

def _to_strike(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

def _resolve_family_defaults(symbol):
    normalized = _normalize_symbol(symbol)
    return SUPPORTED_LIVE_FAMILIES.get(normalized)

def _resolve_index_exchange_candidates(symbol, requested_exchange):
    normalized_symbol = _normalize_symbol(symbol)
    requested = str(requested_exchange or '').strip()
    candidates = []

    if requested:
        candidates.append(requested)

    for exchange in INDEX_EXCHANGE_FALLBACKS.get(normalized_symbol, ()):
        if exchange not in candidates:
            candidates.append(exchange)

    if '' not in candidates:
        candidates.append('')

    return candidates

def _resolve_weekly_fop_trading_class(symbol, expiry, current_trading_class):
    defaults = _resolve_family_defaults(symbol)
    if not defaults:
        return current_trading_class

    base_trading_class = current_trading_class or defaults.get('trading_class') or ''
    if not base_trading_class or len(base_trading_class) < 2:
        return base_trading_class

    try:
        expiry_date = datetime.strptime(expiry, '%Y%m%d')
    except (TypeError, ValueError):
        return base_trading_class

    weekday_suffix = {
        0: 'A',  # Monday
        1: 'B',  # Tuesday
        2: 'C',  # Wednesday
        3: 'D',  # Thursday
    }.get(expiry_date.weekday())

    if weekday_suffix:
        return f"{base_trading_class[:-1]}{weekday_suffix}"
    return base_trading_class

def _extract_contract_expiry(contract):
    raw_value = str(getattr(contract, 'lastTradeDateOrContractMonth', '') or '').strip()
    return raw_value[:8] if len(raw_value) >= 8 else raw_value

def _filter_derivative_contract_candidates(contract_details_list, contract_request, qualified_underlying=None):
    requested_expiry = _to_expiry(
        (contract_request or {}).get('expDate')
        or (contract_request or {}).get('expiry')
        or (contract_request or {}).get('contractMonth')
    )
    requested_right = _normalize_symbol((contract_request or {}).get('right'))
    requested_strike = _to_strike((contract_request or {}).get('strike'))
    requested_multiplier = str((contract_request or {}).get('multiplier') or '')
    requested_exchange = str((contract_request or {}).get('exchange') or '').strip().upper()
    requested_under_con_id = getattr(qualified_underlying, 'conId', None)

    matches = []
    for detail in contract_details_list or []:
        candidate = getattr(detail, 'contract', None)
        if candidate is None:
            continue

        candidate_expiry = _extract_contract_expiry(candidate)
        if requested_expiry and candidate_expiry and candidate_expiry != requested_expiry:
            continue

        candidate_right = _normalize_symbol(getattr(candidate, 'right', ''))
        if requested_right and candidate_right and candidate_right != requested_right:
            continue

        candidate_strike = _to_strike(getattr(candidate, 'strike', None))
        if requested_strike is not None and candidate_strike is not None and abs(candidate_strike - requested_strike) > 0.000001:
            continue

        candidate_under_con_id = getattr(candidate, 'underConId', None)
        if requested_under_con_id and candidate_under_con_id and candidate_under_con_id != requested_under_con_id:
            continue

        score = 0
        if requested_under_con_id and candidate_under_con_id == requested_under_con_id:
            score += 100
        if requested_exchange and str(getattr(candidate, 'exchange', '') or '').strip().upper() == requested_exchange:
            score += 10
        if requested_multiplier and str(getattr(candidate, 'multiplier', '') or '') == requested_multiplier:
            score += 5
        if getattr(candidate, 'tradingClass', ''):
            score += 1

        matches.append((score, candidate))

    matches.sort(key=lambda item: item[0], reverse=True)
    return [candidate for _, candidate in matches]

async def _fallback_qualify_derivative_contract(contract, contract_request=None, qualified_underlying=None):
    if not isinstance(contract_request, dict):
        return None

    sec_type = _normalize_symbol(contract_request.get('secType') or contract_request.get('sec_type'))
    if sec_type not in ('OPT', 'FOP'):
        return None

    exchange = contract_request.get('exchange') or getattr(contract, 'exchange', '') or ''
    currency = contract_request.get('currency') or getattr(contract, 'currency', '') or 'USD'
    multiplier = str(contract_request.get('multiplier') or getattr(contract, 'multiplier', '') or '')
    expiry = _to_expiry(contract_request.get('expDate') or contract_request.get('expiry') or getattr(contract, 'lastTradeDateOrContractMonth', ''))
    strike = _to_strike(contract_request.get('strike') or getattr(contract, 'strike', None))
    right = _normalize_symbol(contract_request.get('right') or getattr(contract, 'right', ''))
    defaults = _resolve_family_defaults(contract_request.get('symbol') or contract_request.get('underlyingSymbol') or getattr(contract, 'symbol', '')) or {}

    symbol_candidates = []
    for candidate_symbol in (
        contract_request.get('symbol'),
        contract_request.get('underlyingSymbol'),
        defaults.get('option_symbol'),
        defaults.get('underlying_symbol'),
        getattr(contract, 'symbol', ''),
    ):
        normalized_candidate = _normalize_symbol(candidate_symbol)
        if normalized_candidate and normalized_candidate not in symbol_candidates:
            symbol_candidates.append(normalized_candidate)

    for candidate_symbol in symbol_candidates:
        probe = Contract(
            secType=sec_type,
            symbol=candidate_symbol,
            lastTradeDateOrContractMonth=expiry,
            strike=float(strike) if strike is not None else 0.0,
            right=right,
            exchange=exchange,
            currency=currency,
            multiplier=multiplier,
        )
        if qualified_underlying is not None and getattr(qualified_underlying, 'conId', None):
            probe.underConId = qualified_underlying.conId

        try:
            contract_details = await ib.reqContractDetailsAsync(probe)
        except Exception as exc:
            logging.warning(
                f"FOP fallback contract-details lookup failed for {_describe_contract_request(contract_request)} "
                f"using symbol {candidate_symbol}: {exc}"
            )
            continue

        filtered_candidates = _filter_derivative_contract_candidates(
            contract_details,
            contract_request,
            qualified_underlying=qualified_underlying,
        )
        if filtered_candidates:
            selected = filtered_candidates[0]
            logging.info(
                f"Qualified {_describe_contract_request(contract_request)} using contract-details fallback "
                f"symbol={selected.symbol} tradingClass={getattr(selected, 'tradingClass', '') or '<blank>'} "
                f"expiry={_extract_contract_expiry(selected)}"
            )
            return selected

    return None

async def _qualify_underlying_future(symbol, contract_month, exchange, currency, multiplier):
    cache_key = (
        _normalize_symbol(symbol),
        _to_contract_month(contract_month),
        exchange or '',
        currency or 'USD',
        str(multiplier or ''),
    )
    if cache_key in qualified_underlyings:
        return qualified_underlyings[cache_key]

    future_contract = Contract(
        secType='FUT',
        symbol=cache_key[0],
        lastTradeDateOrContractMonth=cache_key[1],
        exchange=cache_key[2],
        currency=cache_key[3],
        multiplier=cache_key[4],
    )
    results = await ib.qualifyContractsAsync(future_contract)
    if not results or results[0] is None:
        return None

    qualified_underlyings[cache_key] = results[0]
    return results[0]

def _build_contract_from_request(contract_data):
    if not isinstance(contract_data, dict):
        symbol = _normalize_symbol(contract_data)
        return Stock(symbol, 'SMART', 'USD')

    sec_type = _normalize_symbol(contract_data.get('secType') or contract_data.get('sec_type'))
    symbol = _normalize_symbol(contract_data.get('symbol'))
    exchange = contract_data.get('exchange') or ''
    currency = contract_data.get('currency') or 'USD'
    multiplier = str(contract_data.get('multiplier') or '')
    trading_class = contract_data.get('tradingClass') or contract_data.get('trading_class') or ''
    strike = contract_data.get('strike')
    right = _normalize_symbol(contract_data.get('right'))
    expiry = _to_expiry(contract_data.get('expDate') or contract_data.get('expiry'))
    contract_month = _to_contract_month(contract_data.get('contractMonth'))
    trading_class = _resolve_weekly_fop_trading_class(symbol, expiry, trading_class)

    if sec_type == 'STK':
        return Stock(symbol, exchange or 'SMART', currency)

    if sec_type == 'IND':
        return Contract(secType='IND', symbol=symbol, exchange=exchange, currency=currency)

    if sec_type == 'FUT':
        return Contract(
            secType='FUT',
            symbol=symbol,
            lastTradeDateOrContractMonth=contract_month,
            exchange=exchange,
            currency=currency,
            multiplier=multiplier,
        )

    if sec_type in ('OPT', 'FOP'):
        return Contract(
            secType=sec_type,
            symbol=symbol,
            lastTradeDateOrContractMonth=expiry or contract_month,
            strike=float(strike),
            right=right,
            exchange=exchange,
            currency=currency,
            multiplier=multiplier,
            tradingClass=trading_class,
        )

    raise ValueError(f"Unsupported secType in request: {sec_type!r}")

async def _qualify_one(contract, contract_request=None):
    sec_type = ''
    underlying_contract_month = ''
    qualified_underlying = None
    if isinstance(contract_request, dict):
        sec_type = _normalize_symbol(contract_request.get('secType') or contract_request.get('sec_type'))
        if sec_type == 'FOP':
            underlying_contract_month = _to_contract_month(contract_request.get('underlyingContractMonth'))
            if underlying_contract_month:
                defaults = _resolve_family_defaults(contract_request.get('symbol'))
                underlying_symbol = _normalize_symbol(
                    contract_request.get('underlyingSymbol')
                    or (defaults or {}).get('underlying_symbol')
                    or contract_request.get('symbol')
                )
                underlying_exchange = (
                    contract_request.get('underlyingExchange')
                    or (defaults or {}).get('exchange')
                    or contract_request.get('exchange')
                    or ''
                )
                underlying_currency = (
                    contract_request.get('underlyingCurrency')
                    or contract_request.get('currency')
                    or (defaults or {}).get('currency')
                    or 'USD'
                )
                underlying_multiplier = str(
                    contract_request.get('underlyingMultiplier')
                    or (defaults or {}).get('multiplier')
                    or contract_request.get('multiplier')
                    or ''
                )
                qualified_underlying = await _qualify_underlying_future(
                    underlying_symbol,
                    underlying_contract_month,
                    underlying_exchange,
                    underlying_currency,
                    underlying_multiplier,
                )
                if qualified_underlying is None:
                    logging.error(
                        f"Failed to qualify underlying FUT {underlying_symbol} {underlying_contract_month} "
                        f"for option {_describe_contract_request(contract_request)}"
                    )
                    return None
                contract.underConId = qualified_underlying.conId

    results = await ib.qualifyContractsAsync(contract)
    if (not results or results[0] is None) and sec_type == 'IND' and isinstance(contract_request, dict):
        original_exchange = contract.exchange
        for candidate_exchange in _resolve_index_exchange_candidates(contract.symbol, original_exchange):
            if candidate_exchange == original_exchange:
                continue

            contract.exchange = candidate_exchange
            results = await ib.qualifyContractsAsync(contract)
            if results and results[0] is not None:
                logging.info(
                    f"Qualified {_describe_contract_request(contract_request)} using IND exchange fallback "
                    f"{candidate_exchange or '<blank>'} instead of {original_exchange or '<blank>'}"
                )
                break

    if (not results or results[0] is None) and sec_type == 'FOP' and underlying_contract_month and getattr(contract, 'tradingClass', ''):
        original_trading_class = contract.tradingClass
        contract.tradingClass = ''
        results = await ib.qualifyContractsAsync(contract)
        if results and results[0] is not None:
            logging.info(
                f"Qualified {_describe_contract_request(contract_request)} using underConId fallback "
                f"without tradingClass {original_trading_class}"
            )
    if not results or results[0] is None:
        fallback_contract = await _fallback_qualify_derivative_contract(
            contract,
            contract_request=contract_request,
            qualified_underlying=qualified_underlying,
        )
        if fallback_contract is not None:
            return fallback_contract
    if not results or results[0] is None:
        return None
    return results[0]

def _build_underlying_request(raw_underlying, options_data):
    if isinstance(raw_underlying, dict):
        return raw_underlying

    symbol = _normalize_symbol(raw_underlying)
    defaults = _resolve_family_defaults(symbol)
    if not defaults:
        return raw_underlying

    option_contract_month = ''
    if options_data:
        option_contract_month = _to_contract_month(options_data[0].get('contractMonth') or options_data[0].get('expDate'))

    return {
        'secType': defaults['underlying_sec_type'],
        'symbol': defaults['underlying_symbol'],
        'exchange': defaults['exchange'],
        'currency': defaults['currency'],
        'multiplier': defaults['multiplier'],
        'contractMonth': option_contract_month,
    }

def _describe_contract_request(contract_data):
    if isinstance(contract_data, dict):
        sec_type = _normalize_symbol(contract_data.get('secType') or contract_data.get('sec_type'))
        symbol = _normalize_symbol(contract_data.get('symbol'))
        return f"{sec_type or 'UNKNOWN'} {symbol or '<missing>'}".strip()
    return _normalize_symbol(contract_data) or '<missing>'


def _extract_option_mark(ticker):
    bid = getattr(ticker, 'bid', None)
    ask = getattr(ticker, 'ask', None)
    if bid and ask and bid == bid and ask == ask and bid > 0 and ask > 0:
        return round((bid + ask) / 2, 4)

    if hasattr(ticker, 'modelGreeks') and ticker.modelGreeks:
        opt_price = getattr(ticker.modelGreeks, 'optPrice', None)
        if opt_price is not None and opt_price == opt_price and opt_price > 0:
            return round(opt_price, 4)

    fallback = ticker.marketPrice()
    if fallback == fallback and fallback > 0:
        return round(fallback, 4)
    return None


def _sanitize_quote_value(raw_value):
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return None

    if value != value or value <= 0:
        return None
    return round(value, 4)


def _extract_quote_snapshot(ticker, sec_type=''):
    normalized_sec_type = _normalize_symbol(sec_type)
    bid = _sanitize_quote_value(getattr(ticker, 'bid', None))
    ask = _sanitize_quote_value(getattr(ticker, 'ask', None))

    if normalized_sec_type in ('OPT', 'FOP'):
        mark = _extract_option_mark(ticker)
    else:
        market_price = _extract_market_price(ticker)
        mark = round(market_price, 4) if market_price is not None else None

    if mark is None and bid is not None and ask is not None:
        mark = round((bid + ask) / 2, 4)
    if mark is None:
        return None

    if bid is None:
        bid = mark
    if ask is None:
        ask = mark

    return {
        'bid': bid,
        'ask': ask,
        'mark': round(mark, 4),
    }


def _extract_option_iv(ticker):
    for attr_name in ('modelGreeks', 'bidGreeks', 'askGreeks', 'lastGreeks'):
        greeks = getattr(ticker, attr_name, None)
        if not greeks:
            continue
        raw = getattr(greeks, 'impliedVol', None)
        if raw is not None and raw == raw and raw > 0:
            return raw

    raw = getattr(ticker, 'impliedVolatility', None)
    if raw is not None and raw == raw and raw > 0:
        return raw
    return None


def _extract_option_delta(ticker):
    for attr_name in ('modelGreeks', 'bidGreeks', 'askGreeks', 'lastGreeks'):
        greeks = getattr(ticker, attr_name, None)
        if not greeks:
            continue
        raw = getattr(greeks, 'delta', None)
        if raw is not None and raw == raw:
            return round(raw, 6)
    return None


def _log_option_iv_debug_if_needed(sub_id, ticker, iv):
    contract = getattr(ticker, 'contract', None)
    symbol = str(getattr(contract, 'symbol', '') or '').upper()
    if symbol != 'SLV':
        return

    con_id = getattr(contract, 'conId', None) or sub_id
    now = datetime.utcnow().timestamp()
    last_logged_at = option_iv_debug_last_logged.get(con_id, 0)
    if now - last_logged_at < 15:
        return
    option_iv_debug_last_logged[con_id] = now

    def _extract_greek_iv(attr_name):
        greeks = getattr(ticker, attr_name, None)
        if not greeks:
            return None
        return getattr(greeks, 'impliedVol', None)

    logging.info(
        "SLV IV debug: subId=%s localSymbol=%s iv=%s bid=%s ask=%s "
        "modelIV=%s bidIV=%s askIV=%s lastIV=%s impliedVolatility=%s",
        sub_id,
        getattr(contract, 'localSymbol', None),
        iv,
        getattr(ticker, 'bid', None),
        getattr(ticker, 'ask', None),
        _extract_greek_iv('modelGreeks'),
        _extract_greek_iv('bidGreeks'),
        _extract_greek_iv('askGreeks'),
        _extract_greek_iv('lastGreeks'),
        getattr(ticker, 'impliedVolatility', None),
    )

def on_pending_tickers(tickers):
    """
    Callback fired by ib_async when streaming data ticks arrive.
    We batch process these and send customized state to each connected WS client.
    """
    if not connected_clients:
        return
        
    for ws in list(connected_clients):
        # Build a custom payload for this specific client based on their subscriptions
        subs = client_subscriptions.get(ws, {})
        if not subs:
            continue
            
        payload = {
            "underlyingPrice": None,
            "underlyingQuote": None,
            "options": {},
            "futures": {},
            "stocks": {}
        }
        
        has_data = False
        
        if 'underlying' in subs:
            ticker = subs['underlying']
            sec_type = getattr(getattr(ticker, 'contract', None), 'secType', '')
            quote = _extract_quote_snapshot(ticker, sec_type)
            if quote is not None:
                payload["underlyingPrice"] = quote["mark"]
                payload["underlyingQuote"] = quote
                has_data = True

        for sub_id, ticker in subs.items():
            if sub_id == 'underlying':
                continue  # already handled above

            elif sub_id.startswith('stock_'):
                # --- Stock / ETF hedge ---
                stock_sym = sub_id.replace('stock_', '')
                quote = _extract_quote_snapshot(ticker, 'STK')
                if quote is not None:
                    payload["stocks"][stock_sym] = quote
                    has_data = True

            elif sub_id.startswith('future_'):
                future_id = sub_id.replace('future_', '')
                quote = _extract_quote_snapshot(ticker, 'FUT')
                if quote is not None:
                    payload["futures"][future_id] = quote
                    has_data = True

            else:
                # --- Option leg ---
                sec_type = getattr(getattr(ticker, 'contract', None), 'secType', 'OPT')
                quote = _extract_quote_snapshot(ticker, sec_type)

                # Extract IV: prefer modelGreeks.impliedVol (from Generic Tick 106),
                # fall back to ticker.impliedVolatility if available.
                # Both can be NaN, so filter explicitly.
                iv = None
                if hasattr(ticker, 'modelGreeks') and ticker.modelGreeks:
                    raw = getattr(ticker.modelGreeks, 'impliedVol', None)
                    if raw is not None and raw == raw and raw > 0:  # filter NaN
                        iv = raw
                if iv is None:
                    raw = getattr(ticker, 'impliedVolatility', None)
                    if raw is not None and raw == raw and raw > 0:
                        iv = raw
                if iv is None:
                    iv = _extract_option_iv(ticker)
                delta = _extract_option_delta(ticker)
                _log_option_iv_debug_if_needed(sub_id, ticker, iv)

                if quote is not None:
                    payload["options"][sub_id] = quote

                    if iv and iv == iv and iv > 0: # Check for NaN
                        payload["options"][sub_id]["iv"] = iv
                    if delta is not None:
                        payload["options"][sub_id]["delta"] = delta
                    has_data = True
                    
        # Send data only to the client that requested it
        if has_data:
            message = json.dumps(payload)
            # asyncio.create_task ensures we don't block the tick event thread
            asyncio.create_task(send_message_safe(ws, message))

async def send_message_safe(ws, message):
    try:
        await ws.send(message)
    except Exception as e:
        # Ignore normal disconnect errors; the finally block in handle_ws_client will clean up
        pass

def unsubscribe_client_safely(ws):
    """
    Removes a client's subscriptions. If no other client is watching a specific 
    Ticker contract anymore, we tell IB to cancel the market data stream.
    """
    subs = client_subscriptions.get(ws, {})
    if not subs:
        return
        
    # Count how many total clients are watching each contract ID
    active_contracts = {}
    for other_ws, other_subs in client_subscriptions.items():
        if other_ws != ws:
            for t in other_subs.values():
                active_contracts[t.contract.conId] = True
                
    # Cancel the data stream if this client was the last one watching it
    for ticker in subs.values():
        if ticker.contract.conId not in active_contracts:
            ib.cancelMktData(ticker.contract)
            
    client_subscriptions[ws] = {}


def _coerce_positive_int(value, default_value):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default_value
    return parsed if parsed > 0 else default_value


def _normalize_bool(value, default_value=True):
    if value is None:
        return default_value
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ('1', 'true', 'yes', 'y', 'on'):
        return True
    if text in ('0', 'false', 'no', 'n', 'off'):
        return False
    return default_value


def _serialize_historical_bar_time(raw_value):
    if raw_value is None:
        return ''
    if hasattr(raw_value, 'date'):
        try:
            return raw_value.date().isoformat()
        except Exception:
            pass

    text = str(raw_value).strip()
    if not text:
        return ''

    normalized = text.replace('/', '-')
    for fmt in ('%Y-%m-%d', '%Y%m%d', '%Y-%m-%d %H:%M:%S', '%Y%m%d %H:%M:%S'):
        try:
            parsed = datetime.strptime(normalized, fmt)
            return parsed.date().isoformat()
        except ValueError:
            continue
    return normalized


def _serialize_historical_bar(bar):
    try:
        open_value = float(getattr(bar, 'open', None))
        high_value = float(getattr(bar, 'high', None))
        low_value = float(getattr(bar, 'low', None))
        close_value = float(getattr(bar, 'close', None))
    except (TypeError, ValueError):
        return None

    time_value = _serialize_historical_bar_time(getattr(bar, 'date', None))
    if not time_value:
        return None

    volume_raw = getattr(bar, 'volume', None)
    try:
        volume_value = int(volume_raw) if volume_raw is not None else None
    except (TypeError, ValueError):
        volume_value = None

    return {
        'time': time_value,
        'open': open_value,
        'high': high_value,
        'low': low_value,
        'close': close_value,
        'volume': volume_value,
    }


async def _request_ib_historical_bars(
    underlying_request,
    *,
    bar_size='1 day',
    duration_str='2 Y',
    use_rth=True,
    limit=260,
):
    if not ib.isConnected():
        raise RuntimeError('IB is not connected.')

    contract = _build_contract_from_request(underlying_request)
    qualified_underlying = await _qualify_one(contract, underlying_request)
    if qualified_underlying is None:
        raise RuntimeError(
            f"Failed to qualify underlying {_describe_contract_request(underlying_request)}"
        )

    sec_type = _normalize_symbol(getattr(qualified_underlying, 'secType', ''))
    what_to_show = 'MIDPOINT' if sec_type in ('IND', 'CASH') else 'TRADES'

    request_historical = getattr(ib, 'reqHistoricalDataAsync', None)
    if not callable(request_historical):
        raise RuntimeError('The current ib_async build does not expose reqHistoricalDataAsync.')

    raw_bars = await request_historical(
        qualified_underlying,
        endDateTime='',
        durationStr=duration_str,
        barSizeSetting=bar_size,
        whatToShow=what_to_show,
        useRTH=use_rth,
        formatDate=1,
        keepUpToDate=False,
    )

    serialized_bars = []
    for raw_bar in raw_bars or []:
        serialized_bar = _serialize_historical_bar(raw_bar)
        if serialized_bar is not None:
            serialized_bars.append(serialized_bar)

    if limit and len(serialized_bars) > limit:
        serialized_bars = serialized_bars[-limit:]

    if not serialized_bars:
        raise RuntimeError(
            f"IB returned no historical bars for {_describe_contract_request(underlying_request)}."
        )

    if isinstance(underlying_request, dict):
        requested_symbol = underlying_request.get('symbol')
    else:
        requested_symbol = underlying_request

    return {
        'action': 'historical_bars_response',
        'symbol': _normalize_symbol(getattr(qualified_underlying, 'symbol', '') or requested_symbol),
        'barSize': bar_size,
        'durationStr': duration_str,
        'dataSource': 'ibkr',
        'useRTH': use_rth,
        'bars': serialized_bars,
    }


def _purge_combo_order_tracking_for_websocket(ws):
    stale_order_ids = [
        order_id for order_id, tracking in combo_order_tracking_by_order_id.items()
        if tracking.get('websocket') is ws
    ]
    for order_id in stale_order_ids:
        combo_order_tracking_by_order_id.pop(order_id, None)

    stale_perm_ids = [
        perm_id for perm_id, tracking in combo_order_tracking_by_perm_id.items()
        if tracking.get('websocket') is ws
    ]
    for perm_id in stale_perm_ids:
        combo_order_tracking_by_perm_id.pop(perm_id, None)

async def handle_ws_client(websocket):
    client_ip = websocket.remote_address[0] if websocket.remote_address else 'Unknown'
    logging.info(f"Client connected: {client_ip}")
    connected_clients.add(websocket)
    client_subscriptions[websocket] = {}
    _send_portfolio_avg_cost_snapshot(websocket)
    _send_managed_accounts_snapshot(websocket)
    
    try:
        async for message in websocket:
            data = json.loads(message)

            if data.get('action') == 'request_historical_snapshot':
                raw_underlying = data.get('underlying')
                options_data = data.get('options', [])
                requested_date = normalize_replay_date(data.get('replayDate'))
                underlying_request = _build_underlying_request(raw_underlying, options_data)

                logging.info(
                    f"Received historical snapshot request from {client_ip} "
                    f"for date {requested_date or '<latest>'}, "
                    f"underlying {_describe_contract_request(underlying_request)}, "
                    f"{len(options_data)} options"
                )

                unsubscribe_client_safely(websocket)

                try:
                    payload = historical_replay_service.build_snapshot_payload(
                        requested_date,
                        underlying_request if isinstance(underlying_request, dict) else {},
                        options_data,
                    )
                except (sqlite3.Error, ValueError) as exc:
                    logging.exception("Historical replay snapshot failed")
                    await send_message_safe(websocket, json.dumps({
                        "action": "historical_replay_error",
                        "message": str(exc),
                    }))
                    continue

                if payload is None:
                    await send_message_safe(websocket, json.dumps({
                        "action": "historical_replay_error",
                        "message": (
                            f"No underlying historical quote was found for "
                            f"{_describe_contract_request(underlying_request)} "
                            f"on {requested_date or 'the latest available date'}."
                        ),
                    }))
                    continue

                await send_message_safe(websocket, json.dumps(payload))

            elif data.get('action') == 'subscribe':
                raw_underlying = data.get('underlying')
                options_data = data.get('options', [])
                futures_data = data.get('futures', [])
                stocks_data = data.get('stocks', [])
                underlying_request = _build_underlying_request(raw_underlying, options_data)

                logging.info(
                    f"Received subscription request from {client_ip} "
                    f"for underlying {_describe_contract_request(underlying_request)}, "
                    f"{len(options_data)} options, {len(futures_data)} futures, and {len(stocks_data)} stocks"
                )

                try:
                    underlying_contract = _build_contract_from_request(underlying_request)
                except Exception as e:
                    logging.error(f"Invalid underlying request from {client_ip}: {underlying_request!r} ({e})")
                    continue

                # Unsubscribe old streams for this specific client safely
                unsubscribe_client_safely(websocket)

                qualified_underlying = await _qualify_one(underlying_contract, underlying_request)
                if qualified_underlying is None:
                    logging.warning(
                        f"Failed to qualify underlying {_describe_contract_request(underlying_request)}; "
                        f"continuing with option subscriptions only"
                    )
                else:
                    # Subscribe underlying price stream.
                    ticker = ib.reqMktData(qualified_underlying, '', False, False)
                    client_subscriptions[websocket]['underlying'] = ticker

                # Process options / FOP legs.
                for opt in options_data:
                    leg_id = opt['id']
                    try:
                        opt_contract = _build_contract_from_request(opt)
                    except Exception as e:
                        logging.error(f"Invalid option request for leg {leg_id}: {opt!r} ({e})")
                        continue

                    qualified_option = await _qualify_one(opt_contract, opt)
                    if qualified_option is None:
                        logging.error(f"Failed to qualify option leg {leg_id}: {_describe_contract_request(opt)}")
                        continue

                    # Generic tick 106 requests option IV/model data; IB also serves it for FOP.
                    opt_ticker = ib.reqMktData(qualified_option, '106', False, False)
                    client_subscriptions[websocket][leg_id] = opt_ticker

                # Process explicitly subscribed futures.
                for future_req in futures_data:
                    future_id = future_req.get('id')
                    if not future_id:
                        continue

                    try:
                        future_contract = _build_contract_from_request(future_req)
                    except Exception as e:
                        logging.error(f"Invalid future request {future_req!r} ({e})")
                        continue

                    qualified_future = await _qualify_one(future_contract, future_req)
                    if qualified_future is None:
                        logging.error(f"Failed to qualify future subscription {future_id}: {_describe_contract_request(future_req)}")
                        continue

                    future_ticker = ib.reqMktData(qualified_future, '', False, False)
                    client_subscriptions[websocket][f"future_{future_id}"] = future_ticker

                # Process stock hedges.
                for stock_sym in stocks_data:
                    stock_contract = Stock(stock_sym, 'SMART', 'USD')
                    qualified_stock = await _qualify_one(stock_contract)
                    if qualified_stock is None:
                        logging.error(f"Failed to qualify hedge stock {stock_sym}")
                        continue

                    stock_ticker = ib.reqMktData(qualified_stock, '', False, False)
                    
                    def make_stock_tick_handler(s, ws):
                        def _on_stock_tick(t):
                            price = _extract_market_price(t)
                            if price is not None:
                                payload = {"options": {}, "stocks": {s: {"mark": price}}}
                                asyncio.create_task(send_message_safe(ws, json.dumps(payload)))
                        return _on_stock_tick
                    
                    stock_ticker.updateEvent += make_stock_tick_handler(stock_sym, websocket)
                    client_subscriptions[websocket][f"stock_{stock_sym}"] = stock_ticker
                    logging.info(f"Subscribed to stock: {stock_sym}")

            elif data.get('action') == 'sync_underlying':
                raw_underlying = data.get('underlying')
                underlying_request = _build_underlying_request(raw_underlying, [])
                try:
                    contract = _build_contract_from_request(underlying_request)
                except Exception as e:
                    logging.error(f"Invalid manual sync request: {underlying_request!r} ({e})")
                    continue

                qualified_underlying = await _qualify_one(contract, underlying_request)
                if qualified_underlying is None:
                    logging.error(f"Failed to manual sync underlying {_describe_contract_request(underlying_request)}")
                else:
                    ticker = ib.reqMktData(qualified_underlying, '', False, False)
                    # Wait momentarily for IB to populate a snapshot-like first tick.
                    await asyncio.sleep(0.5)
                    quote = _extract_quote_snapshot(ticker, getattr(qualified_underlying, 'secType', ''))

                    if quote is not None:
                        payload = {
                            "underlyingPrice": quote["mark"],
                            "underlyingQuote": quote,
                            "options": {}
                        }
                        await send_message_safe(websocket, json.dumps(payload))

            elif data.get('action') == 'request_historical_bars':
                raw_underlying = data.get('underlying')
                options_data = data.get('options', [])
                underlying_request = _build_underlying_request(raw_underlying, options_data)
                bar_size = str(data.get('barSize') or '1 day').strip() or '1 day'
                duration_str = str(data.get('durationStr') or '2 Y').strip() or '2 Y'
                use_rth = _normalize_bool(data.get('useRTH'), True)
                limit = _coerce_positive_int(data.get('limit'), 260)
                request_id = str(data.get('requestId') or '').strip()

                logging.info(
                    f"Received historical bars request from {client_ip} "
                    f"for {_describe_contract_request(underlying_request)} "
                    f"barSize={bar_size} duration={duration_str} useRTH={use_rth} limit={limit}"
                )

                payload = None
                ib_error_message = ''
                try:
                    payload = await _request_ib_historical_bars(
                        underlying_request,
                        bar_size=bar_size,
                        duration_str=duration_str,
                        use_rth=use_rth,
                        limit=limit,
                    )
                except Exception as exc:
                    ib_error_message = str(exc)
                    logging.warning(
                        "Historical bars request via IB failed for %s: %s",
                        _describe_contract_request(underlying_request),
                        exc,
                    )

                if payload is None and bar_size == '1 day':
                    fallback_symbol = _normalize_symbol(
                        (underlying_request or {}).get('symbol')
                        if isinstance(underlying_request, dict)
                        else underlying_request
                    )
                    payload = historical_replay_service.build_underlying_daily_bars_payload(
                        fallback_symbol,
                        limit=limit,
                    )
                    if payload is not None:
                        payload['fallbackReason'] = ib_error_message or 'IB historical bars unavailable.'

                if payload is None:
                    await send_message_safe(websocket, json.dumps({
                        'action': 'historical_bars_error',
                        'requestId': request_id,
                        'message': ib_error_message or (
                            f"No historical bars were available for "
                            f"{_describe_contract_request(underlying_request)}."
                        ),
                    }))
                    continue

                if request_id:
                    payload['requestId'] = request_id
                await send_message_safe(websocket, json.dumps(payload))

            elif data.get('action') == 'request_portfolio_avg_cost_snapshot':
                logging.info(f"Received portfolio avg cost snapshot request from {client_ip}")
                _send_portfolio_avg_cost_snapshot(websocket)

            elif data.get('action') == 'request_managed_accounts_snapshot':
                logging.info(f"Received managed accounts snapshot request from {client_ip}")
                _send_managed_accounts_snapshot(websocket)

            else:
                payload = await execution_engine.handle_combo_action(
                    websocket,
                    data,
                    client_ip=client_ip,
                )
                if payload is not None:
                    await send_message_safe(websocket, json.dumps(payload))

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        logging.info(f"Client disconnected: {client_ip}")
        # Clean up all tracking logic for this exact websocket
        unsubscribe_client_safely(websocket)
        _purge_combo_order_tracking_for_websocket(websocket)
        execution_engine.cancel_managed_for_websocket(websocket)
        if websocket in connected_clients:
            connected_clients.remove(websocket)
        client_subscriptions.pop(websocket, None)

async def main():
    ib_connect_task = None
    try:
        # Register the tick callback
        ib.pendingTickersEvent += on_pending_tickers

        # Start IB connection in the background so historical replay can work
        # even when TWS/Gateway is not running.
        ib_connect_task = asyncio.create_task(connect_ib())
        logging.info("Started background IB connection task.")

        # Start one WebSocket listener per configured interface so localhost and
        # a Tailscale/LAN address can both reach the same ib_server.py process.
        ws_servers = []
        try:
            for ws_host in WS_HOSTS:
                logging.info(f"Starting WebSocket server on ws://{ws_host}:{WS_PORT}")
                ws_servers.append(await websockets.serve(handle_ws_client, ws_host, WS_PORT))
        except OSError as e:
            for ws_server in ws_servers:
                ws_server.close()
                await ws_server.wait_closed()
            logging.error(
                f"Cannot bind WebSocket server on host {ws_host} port {WS_PORT}: {e}\n"
                f"  Confirm the address exists on this machine and the port is free, then restart."
            )
            return

        async with AsyncExitStack() as stack:
            for ws_server in ws_servers:
                await stack.enter_async_context(ws_server)

            # Keep the event loop running forever, yielding to ib_async's network operations.
            while True:
                await asyncio.sleep(1)
    finally:
        if ib_connect_task and not ib_connect_task.done():
            ib_connect_task.cancel()
        # Guaranteed cleanup: runs on Ctrl+C, SIGTERM, or any unhandled exception
        if ib.isConnected():
            logging.info("Disconnecting from IB...")
            ib.disconnect()
            logging.info("Disconnected from IB.")

if __name__ == "__main__":
    # Treat SIGTERM (e.g. `kill`, service stop, terminal closure) identically to
    # Ctrl+C so the finally block in main() always fires and IB is cleanly disconnected.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Server stopped by user.")
