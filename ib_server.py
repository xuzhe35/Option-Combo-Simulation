import asyncio
import json
import logging
import os
import signal
import sqlite3
import configparser
import uuid
from contextlib import AsyncExitStack
from datetime import datetime
from ib_async import *
import websockets

from chain_service_config import resolve_chain_service_url
from historical_replay_service import HistoricalReplayService, normalize_replay_date
from ib_connection_supervisor import (
    DEFAULT_RETRY_INTERVAL_SECONDS as IB_RECONNECT_INTERVAL_SECONDS,
    IbConnectionSupervisor,
)
from yield_curve.backend_adapter import YieldCurveBackendAdapter
from ib_server_order_tracking import (
    build_active_combo_orders_snapshot as build_active_combo_orders_snapshot_via_module,
    build_active_hedge_orders_snapshot as build_active_hedge_orders_snapshot_via_module,
    build_combo_order_error_handler,
    build_combo_order_exec_details_handler,
    build_combo_order_fill_cost_payload as build_combo_order_fill_cost_payload_via_module,
    build_combo_order_status_payload as build_combo_order_status_payload_via_module,
    build_combo_order_status_handler,
    build_hedge_order_fill_payload as build_hedge_order_fill_payload_via_module,
    build_hedge_order_status_payload as build_hedge_order_status_payload_via_module,
    build_hedge_order_error_handler,
    build_hedge_order_exec_details_handler,
    build_hedge_order_status_handler,
    is_terminal_combo_tracking as is_terminal_combo_tracking_via_module,
    is_terminal_hedge_tracking as is_terminal_hedge_tracking_via_module,
    iter_unique_hedge_order_trackings as iter_unique_hedge_order_trackings_via_module,
    record_combo_order_error as record_combo_order_error_via_module,
    record_hedge_order_error as record_hedge_order_error_via_module,
    record_hedge_order_fill as record_hedge_order_fill_via_module,
    resolve_combo_order_tracking as resolve_combo_order_tracking_via_module,
    resolve_hedge_order_tracking as resolve_hedge_order_tracking_via_module,
    update_combo_order_tracking_snapshot as update_combo_order_tracking_snapshot_via_module,
    update_hedge_order_tracking_snapshot as update_hedge_order_tracking_snapshot_via_module,
    upsert_combo_order_tracking as upsert_combo_order_tracking_via_module,
)
from ib_server_iv_term_structure import (
    build_iv_term_structure_expiry_bundle as _build_iv_term_structure_expiry_bundle,
    build_iv_term_structure_sub_id as _build_iv_term_structure_sub_id,
    cancel_iv_term_structure_sync_task as cancel_iv_term_structure_sync_task,
    filter_iv_term_structure_option_chains as _filter_iv_term_structure_option_chains,
    format_iv_term_structure_strike_token as _format_iv_term_structure_strike_token,
    handle_iv_term_structure_subscription as handle_iv_term_structure_subscription,
    merge_iv_term_structure_chain_fields as _merge_iv_term_structure_chain_fields,
    prioritize_iv_term_structure_expiry_rows as _prioritize_iv_term_structure_expiry_rows,
    resolve_iv_term_structure_expiry_selection_from_candidates as resolve_iv_term_structure_expiry_selection_from_candidates,
    resolve_iv_term_structure_secdef_exchange as resolve_iv_term_structure_secdef_exchange,
    run_iv_term_structure_option_sync as run_iv_term_structure_option_sync,
    subscribe_iv_term_structure_option_request as subscribe_iv_term_structure_option_request,
    track_iv_term_structure_sync_task as track_iv_term_structure_sync_task,
    fetch_iv_term_structure_contract_rows_for_exact_strike as fetch_iv_term_structure_contract_rows_for_exact_strike,
    fetch_iv_term_structure_contract_rows_for_expiry as fetch_iv_term_structure_contract_rows_for_expiry,
)
from ib_server_market_data import (
    build_option_contract_timing,
    build_pending_tickers_handler,
    cancel_all_api_market_data_subscriptions,
    coerce_positive_int,
    extract_market_price,
    extract_option_delta,
    extract_option_iv,
    extract_quote_snapshot,
    get_client_subscription_settings,
    log_option_iv_debug_if_needed,
    normalize_market_data_generation,
    normalize_bool,
    option_contract_timing_is_publishable,
    positive_contract_id as _positive_contract_id,
    request_ib_historical_bars,
    unsubscribe_client_safely as unsubscribe_client_safely_via_market_data,
)
from ib_server_ws import (
    IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS_DEFAULT,
    build_ws_client_handler,
    dispatch_execution_action as dispatch_ws_execution_action,
    purge_combo_order_tracking_for_websocket as purge_combo_order_tracking_for_websocket,
    purge_hedge_order_tracking_for_websocket as purge_hedge_order_tracking_for_websocket,
)
from iv_term_structure_service import (
    DEFAULT_BUCKET_DEFINITIONS as IV_TERM_STRUCTURE_BUCKET_DEFINITIONS,
    DEFAULT_MAX_DTE as IV_TERM_STRUCTURE_DEFAULT_MAX_DTE,
    DEFAULT_STRIKE_RADIUS as IV_TERM_STRUCTURE_DEFAULT_STRIKE_RADIUS,
)
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
IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS = config.getfloat(
    'iv_term_structure',
    'catalog_timeout_seconds',
    fallback=IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS_DEFAULT,
)
OPTION_CONTRACT_TIMING_TIMEOUT_SECONDS = max(
    0.5,
    config.getfloat('server', 'option_contract_timing_timeout_seconds', fallback=5.0),
)
CHAIN_SERVICE_URL = resolve_chain_service_url(config)
RATES_SQLITE_DB = os.path.abspath(
    config.get('historical', 'rates_sqlite_db_path', fallback=os.path.join('sqlite_spy', 'rates.db'))
)
YIELD_CURVE_DATA_DIR = os.path.abspath(
    config.get('yield_curve', 'data_dir', fallback=os.path.join('yield_curve', 'data'))
)
YIELD_CURVE_AUTO_UPDATE_IF_MISSING = config.getboolean(
    'yield_curve', 'auto_update_if_missing', fallback=True
)
YIELD_CURVE_AUTO_UPDATE_IF_STALE = config.getboolean(
    'yield_curve', 'auto_update_if_stale', fallback=True
)
YIELD_CURVE_SOURCE_TIMEOUT_SECONDS = max(
    1.0,
    config.getfloat('yield_curve', 'source_timeout_seconds', fallback=20.0),
)
YIELD_CURVE_PROCESS_TIMEOUT_SECONDS = max(
    5.0,
    config.getfloat('yield_curve', 'process_timeout_seconds', fallback=60.0),
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
# Map conId -> set of generic tick tokens the shared market data line was opened with
market_data_generic_ticks_by_con_id = {}
# Per-contract receipt times used by IVTS whole-curve snapshots.  Keeping this
# separate from ticker values prevents a cached leg from being relabeled as a
# fresh quote whenever another contract changes.
market_data_quote_as_of_by_ticker_key = {}
# Price/BBO fingerprints keep generic-tick-only option events from refreshing
# the IVTS quote clock when the cached bid/ask did not actually update.
market_data_quote_fingerprint_by_ticker_key = {}
# Complete contract timing facts are stable and shared by every websocket
# using the same conId.  Incomplete ContractDetails responses are deliberately
# not positive-cache hits so a later subscription can recover without a
# backend restart.
option_contract_timing_by_con_id = {}
option_contract_timing_semaphore = asyncio.Semaphore(4)
# Concurrent pages can request the same conId (notably IVTS plus the portfolio).
# They share one ContractDetails lookup; after an incomplete result the task is
# removed so a later, independent subscription can retry.
option_contract_timing_inflight_by_con_id = {}
# Map websocket -> per-client live-data preferences
client_subscription_settings = {}
ib_connect_task = None
ib_connection_supervisor = None
iv_term_structure_sync_tasks = {}
iv_term_structure_contract_details_semaphore = asyncio.Semaphore(4)
iv_term_structure_option_subscription_semaphore = asyncio.Semaphore(4)
api_market_data_reset_lock = asyncio.Lock()
ib_subscription_recovery_lock = asyncio.Lock()
ib_server_session_id = uuid.uuid4().hex
api_market_data_generation = 0
ib_market_data_state = 'invalidated'
ib_recovery_reason = 'startup'
ib_subscriptions_required = False
ib_automatic_replay_allowed = False
qualified_underlyings = {}
# Verified futures delivery month keyed by the actual IB underlying conId.
# Populated only from ContractDetails.contractMonth, never by copying the
# browser's requested month nor by truncating a qualified last-trade date.
underlying_contract_month_by_con_id = {}
# Concurrent subscriptions of the same FUT share one ContractDetails lookup.
futures_contract_month_inflight_by_con_id = {}
# Deliberately NOT option_contract_timing_semaphore.  A FOP timing resolution
# holds that permit for its whole critical section and awaits the underlying
# futures month from inside it, so reusing the same semaphore here is re-entrant:
# once `option_contract_timing_semaphore` permits worth of FOP resolutions are
# in flight with an unresolved underlying month, they all block on a nested task
# that can never acquire a permit, and the semaphore is left permanently drained.
futures_contract_month_semaphore = asyncio.Semaphore(4)
portfolio_avg_cost_cache = {}
portfolio_position_cache = {}
portfolio_positions_snapshot_ready = False
portfolio_position_broadcast_task = None
combo_order_tracking_by_order_id = {}
combo_order_tracking_by_perm_id = {}
hedge_order_tracking_by_order_id = {}
hedge_order_tracking_by_perm_id = {}
option_iv_debug_last_logged = {}
historical_replay_service = HistoricalReplayService(
    CHAIN_SERVICE_URL,
    RATES_SQLITE_DB,
    logger=logging.getLogger('historical_replay.chain_service'),
    yield_curve_data_dir=YIELD_CURVE_DATA_DIR,
)
yield_curve_backend = YieldCurveBackendAdapter(
    YIELD_CURVE_DATA_DIR,
    auto_update_if_missing=YIELD_CURVE_AUTO_UPDATE_IF_MISSING,
    auto_update_if_stale=YIELD_CURVE_AUTO_UPDATE_IF_STALE,
    source_timeout_seconds=YIELD_CURVE_SOURCE_TIMEOUT_SECONDS,
    process_timeout_seconds=YIELD_CURVE_PROCESS_TIMEOUT_SECONDS,
    logger=logging.getLogger('yield_curve.backend'),
)


async def _get_discount_curve_snapshot(request):
    return await yield_curve_backend.build_payload(request)

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
    'MES': {
        'underlying_sec_type': 'FUT',
        'option_sec_type': 'FOP',
        'underlying_symbol': 'MES',
        'option_symbol': 'MES',
        'exchange': 'CME',
        'currency': 'USD',
        'multiplier': '5',
    },
    'MNQ': {
        'underlying_sec_type': 'FUT',
        'option_sec_type': 'FOP',
        'underlying_symbol': 'MNQ',
        'option_symbol': 'MNQ',
        'exchange': 'CME',
        'currency': 'USD',
        'multiplier': '2',
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
    'SI': {
        'underlying_sec_type': 'FUT',
        'option_sec_type': 'FOP',
        'underlying_symbol': 'SI',
        'option_symbol': 'SI',
        'exchange': 'COMEX',
        'currency': 'USD',
        'multiplier': '5000',
        'trading_class': 'S3T',
    },
}

INDEX_EXCHANGE_FALLBACKS = {
    'SPX': ('CBOE', 'SMART', ''),
    'NDX': ('NASDAQ', 'SMART', ''),
}


def _record_combo_order_placement(websocket, request, trade, tracking_legs):
    """Pre-register fill tracking immediately after placeOrder.

    Execution reports can arrive before the submit result is finalized
    (the adapter sleeps to let the order settle); registering here means
    those early fills are attributed instead of silently dropped.
    """
    order = getattr(trade, 'order', None)
    order_status = getattr(trade, 'orderStatus', None)
    return upsert_combo_order_tracking_via_module(
        _build_order_tracking_environment(),
        websocket=websocket,
        group_id=request.group_id,
        group_name=request.group_name,
        account=str(getattr(order, 'account', '') or request.account or '').strip() or None,
        execution_mode=request.execution_mode,
        execution_intent=request.execution_intent,
        request_source=request.request_source,
        order_id=getattr(order, 'orderId', None),
        perm_id=getattr(order_status, 'permId', None) or None,
        status=getattr(order_status, 'status', None),
        legs=tracking_legs,
    )


def _record_combo_order_submission(websocket, request, result):
    upsert_combo_order_tracking_via_module(
        _build_order_tracking_environment(),
        websocket=websocket,
        group_id=request.group_id,
        group_name=request.group_name,
        account=str(request.account or '').strip() or None,
        execution_mode=request.execution_mode,
        execution_intent=request.execution_intent,
        request_source=request.request_source,
        order_id=result.order_id,
        perm_id=result.perm_id,
        status=result.status,
        status_message=result.status_message,
        legs=list(getattr(result, 'tracking_legs', []) or []),
    )
    # Replay fills already accumulated on the Trade as a safety net: if the
    # pre-registration callback failed, executions that arrived during the
    # post-submit settle window had no tracking and were dropped by the live
    # event handler. seenExecIds dedup makes this replay idempotent.
    trade = getattr(result, 'trade', None)
    for fill in list(getattr(trade, 'fills', None) or []):
        try:
            on_combo_order_exec_details(trade, fill)
        except Exception:
            logging.exception(
                "Failed to replay combo execution fill for groupId=%s orderId=%s",
                request.group_id,
                result.order_id,
            )


def _record_hedge_order_submission(websocket, request, result):
    preview = getattr(result, 'preview', None)
    tracking = {
        'websocket': websocket,
        'hedgeId': request.hedge_id,
        'hedgeName': request.hedge_name,
        'account': str(request.account or getattr(preview, 'account', '') or '').strip() or None,
        'executionMode': request.execution_mode,
        'requestSource': request.request_source,
        'orderId': result.order_id,
        'permId': result.perm_id,
        'status': result.status,
        'statusMessage': result.status_message,
        'secType': getattr(preview, 'sec_type', None) or request.sec_type,
        'symbol': getattr(preview, 'symbol', None) or request.symbol,
        'localSymbol': getattr(preview, 'local_symbol', None) or request.symbol,
        'exchange': getattr(preview, 'exchange', None) or request.exchange,
        'currency': getattr(preview, 'currency', None) or request.currency,
        'conId': getattr(preview, 'con_id', None),
        'orderAction': getattr(preview, 'order_action', None) or request.order_action,
        'quantity': getattr(preview, 'quantity', None) or request.quantity,
        'orderType': getattr(preview, 'order_type', None) or request.order_type,
        'limitPrice': getattr(preview, 'limit_price', None) if getattr(preview, 'limit_price', None) is not None else request.limit_price,
        'timeInForce': getattr(preview, 'time_in_force', None) or request.time_in_force,
        'contractMonth': getattr(preview, 'contract_month', None) or request.contract_month,
        'multiplier': getattr(preview, 'multiplier', None) or request.multiplier,
        'deltaPerUnit': request.delta_per_unit,
        'currentNetDelta': getattr(preview, 'current_net_delta', None)
            if getattr(preview, 'current_net_delta', None) is not None else request.current_net_delta,
        'projectedNetDelta': getattr(preview, 'projected_net_delta', None)
            if getattr(preview, 'projected_net_delta', None) is not None else request.projected_net_delta,
        'targetLower': getattr(preview, 'target_lower', None)
            if getattr(preview, 'target_lower', None) is not None else request.target_lower,
        'targetUpper': getattr(preview, 'target_upper', None)
            if getattr(preview, 'target_upper', None) is not None else request.target_upper,
        'fillTotals': {
            'filledQuantity': 0.0,
            'filledNotional': 0.0,
        },
        'seenExecIds': set(),
    }
    if result.order_id is not None:
        hedge_order_tracking_by_order_id[result.order_id] = tracking
    if result.perm_id is not None:
        hedge_order_tracking_by_perm_id[result.perm_id] = tracking


def _build_order_tracking_environment():
    return {
        'combo_order_tracking_by_order_id': combo_order_tracking_by_order_id,
        'combo_order_tracking_by_perm_id': combo_order_tracking_by_perm_id,
        'hedge_order_tracking_by_order_id': hedge_order_tracking_by_order_id,
        'hedge_order_tracking_by_perm_id': hedge_order_tracking_by_perm_id,
        'execution_engine': execution_engine,
        'send_message_safe': send_message_safe,
    }


def _resolve_combo_order_tracking(order_id, perm_id):
    return resolve_combo_order_tracking_via_module(
        _build_order_tracking_environment(),
        order_id,
        perm_id,
    )


def _resolve_hedge_order_tracking(order_id, perm_id):
    return resolve_hedge_order_tracking_via_module(
        _build_order_tracking_environment(),
        order_id,
        perm_id,
    )


def _update_combo_order_tracking_snapshot(
    tracking,
    *,
    order=None,
    order_status=None,
    trade=None,
    status_message=None,
):
    update_combo_order_tracking_snapshot_via_module(
        tracking,
        order=order,
        order_status=order_status,
        trade=trade,
        status_message=status_message,
    )


def _update_hedge_order_tracking_snapshot(
    tracking,
    *,
    order=None,
    order_status=None,
    trade=None,
    status_message=None,
):
    update_hedge_order_tracking_snapshot_via_module(
        tracking,
        order=order,
        order_status=order_status,
        trade=trade,
        status_message=status_message,
    )


def _record_combo_order_error(tracking, error_code, error_string):
    return record_combo_order_error_via_module(tracking, error_code, error_string)


def _record_hedge_order_error(tracking, error_code, error_string):
    return record_hedge_order_error_via_module(tracking, error_code, error_string)


def _build_combo_order_status_payload(trade, tracking):
    return build_combo_order_status_payload_via_module(
        _build_order_tracking_environment(),
        trade,
        tracking,
    )


def _build_hedge_order_status_payload(trade, tracking):
    return build_hedge_order_status_payload_via_module(trade, tracking)


def _build_combo_order_fill_cost_payload(tracking, order_id, perm_id):
    return build_combo_order_fill_cost_payload_via_module(tracking, order_id, perm_id)


def _build_hedge_order_fill_payload(
    tracking,
    order_id,
    perm_id,
    execution_id,
    execution_side,
    fill_quantity,
    fill_price,
):
    return build_hedge_order_fill_payload_via_module(
        tracking,
        order_id,
        perm_id,
        execution_id,
        execution_side,
        fill_quantity,
        fill_price,
    )


def _record_hedge_order_fill(tracking, execution, contract):
    return record_hedge_order_fill_via_module(tracking, execution, contract)


def _is_terminal_hedge_tracking(tracking):
    return is_terminal_hedge_tracking_via_module(_build_order_tracking_environment(), tracking)


def _is_terminal_combo_tracking(tracking):
    return is_terminal_combo_tracking_via_module(_build_order_tracking_environment(), tracking)


def _build_active_combo_orders_snapshot(websocket, data=None):
    snapshot = build_active_combo_orders_snapshot_via_module(
        _build_order_tracking_environment(),
        websocket,
        data,
    )
    # Adopt managed supervision contexts only for the orders this session
    # actually re-attached (the snapshot is account/group scoped), so one
    # reconnecting tab cannot claim another live session's orders.
    for order in snapshot.get('orders') or []:
        try:
            adopted = execution_engine.adopt_managed_combo_order(
                websocket,
                order.get('orderId'),
                order.get('permId'),
            )
        except Exception:
            logging.exception(
                "Failed to adopt managed combo context for orderId=%s permId=%s",
                order.get('orderId'),
                order.get('permId'),
            )
            continue
        if not adopted:
            logging.warning(
                "Managed combo context for orderId=%s permId=%s is owned by another "
                "live session; resume/concede/cancel stay with that session",
                order.get('orderId'),
                order.get('permId'),
            )
    return snapshot


def _has_active_hedge_order_for_request(websocket, request):
    hedge_id = str(getattr(request, 'hedge_id', '') or '').strip()
    if not hedge_id:
        return False

    seen_tracking_ids = set()
    for tracking in list(hedge_order_tracking_by_order_id.values()) + list(hedge_order_tracking_by_perm_id.values()):
        tracking_identity = id(tracking)
        if tracking_identity in seen_tracking_ids:
            continue
        seen_tracking_ids.add(tracking_identity)
        if str(tracking.get('hedgeId') or '').strip() != hedge_id:
            continue
        request_account = str(getattr(request, 'account', '') or '').strip()
        if request_account and str(tracking.get('account') or '').strip() != request_account:
            continue
        if _is_terminal_hedge_tracking(tracking):
            continue
        order_id = tracking.get('orderId')
        status = tracking.get('status') or 'Submitted'
        return f'Active hedge order already exists for {hedge_id}: orderId={order_id}, status={status}.'
    return False


def _iter_unique_hedge_order_trackings():
    yield from iter_unique_hedge_order_trackings_via_module(_build_order_tracking_environment())


def _build_active_hedge_orders_snapshot(websocket, data=None):
    return build_active_hedge_orders_snapshot_via_module(
        _build_order_tracking_environment(),
        websocket,
        data,
    )


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
    on_combo_order_placed=_record_combo_order_placement,
    portfolio_positions_provider=lambda: _get_authoritative_portfolio_position_items(),
    portfolio_positions_ready_provider=lambda: portfolio_positions_snapshot_ready,
)

execution_engine = ExecutionEngine(
    execution_adapter,
    logger=logging.getLogger('trade_execution.engine'),
    on_submit_result=_record_combo_order_submission,
    on_hedge_submit_result=_record_hedge_order_submission,
    has_active_hedge_order=_has_active_hedge_order_for_request,
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


def _portfolio_avg_cost_cache_key_from_contract(account, contract):
    if contract is None:
        return None

    return (
        str(account or '').strip(),
        str(getattr(contract, 'secType', '') or '').strip().upper(),
        str(getattr(contract, 'symbol', '') or '').strip().upper(),
        _normalize_contract_date(getattr(contract, 'lastTradeDateOrContractMonth', '') or ''),
        str(getattr(contract, 'right', '') or '').strip().upper(),
        str(getattr(contract, 'strike', None)),
        str(getattr(contract, 'localSymbol', '') or '').strip(),
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
        'conId': getattr(contract, 'conId', None),
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


def _serialize_portfolio_position_item(portfolio_item):
    contract = getattr(portfolio_item, 'contract', None)
    if contract is None:
        return None
    try:
        position_value = float(getattr(portfolio_item, 'position', 0) or 0)
    except (TypeError, ValueError):
        return None
    if position_value != position_value or position_value == 0:
        return None

    return {
        'account': getattr(portfolio_item, 'account', '') or '',
        'conId': getattr(contract, 'conId', None),
        'secType': str(getattr(contract, 'secType', '') or '').upper(),
        'symbol': getattr(contract, 'symbol', '') or '',
        'localSymbol': getattr(contract, 'localSymbol', '') or '',
        'expDate': _normalize_contract_date(getattr(contract, 'lastTradeDateOrContractMonth', '') or ''),
        'right': getattr(contract, 'right', '') or '',
        'strike': getattr(contract, 'strike', None),
        'multiplier': str(getattr(contract, 'multiplier', '') or ''),
        'tradingClass': getattr(contract, 'tradingClass', '') or '',
        'position': position_value,
    }


def _get_authoritative_portfolio_position_items():
    """Refresh position quantities from IB's completed reqPositions snapshot.

    updatePortfolioEvent is account-update/valuation oriented and is not
    guaranteed to cover every FOP/FUT position in every TWS configuration.
    IB.positions() is the authoritative, startup-synchronized quantity set.
    """
    global portfolio_positions_snapshot_ready
    if not ib.isConnected():
        portfolio_positions_snapshot_ready = False
        portfolio_position_cache.clear()
        return []

    try:
        raw_positions = list(ib.positions() or [])
    except Exception:
        portfolio_positions_snapshot_ready = False
        logging.exception("Failed to read authoritative TWS position snapshot")
        return list(portfolio_position_cache.values())

    refreshed = {}
    for position_item in raw_positions:
        serialized = _serialize_portfolio_position_item(position_item)
        if serialized is None:
            continue
        refreshed[_portfolio_avg_cost_cache_key(serialized)] = serialized

    portfolio_position_cache.clear()
    portfolio_position_cache.update(refreshed)
    portfolio_positions_snapshot_ready = True
    return list(refreshed.values())


def _build_portfolio_avg_cost_payload(items):
    return {
        'action': 'portfolio_avg_cost_update',
        'items': items,
    }


def _build_portfolio_positions_payload():
    items = _get_authoritative_portfolio_position_items()
    return {
        'action': 'portfolio_positions_snapshot',
        'items': items,
        'ibConnected': ib.isConnected(),
        'positionsReady': portfolio_positions_snapshot_ready,
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


async def send_message_safe(ws, message):
    try:
        await ws.send(message)
        return True
    except Exception as exc:
        logging.warning("WebSocket send failed for %r: %s", getattr(ws, 'remote_address', None), exc)
        return False


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


def _broadcast_portfolio_positions_snapshot():
    if not connected_clients:
        return
    message = json.dumps(_build_portfolio_positions_payload())
    for ws in list(connected_clients):
        asyncio.create_task(send_message_safe(ws, message))


async def _broadcast_portfolio_positions_after_coalesce():
    global portfolio_position_broadcast_task
    try:
        await asyncio.sleep(0.05)
        _broadcast_portfolio_positions_snapshot()
    finally:
        portfolio_position_broadcast_task = None


def _schedule_portfolio_positions_broadcast():
    global portfolio_position_broadcast_task
    if portfolio_position_broadcast_task is not None and not portfolio_position_broadcast_task.done():
        return
    portfolio_position_broadcast_task = asyncio.create_task(_broadcast_portfolio_positions_after_coalesce())


def _send_portfolio_positions_snapshot(websocket):
    asyncio.create_task(send_message_safe(websocket, json.dumps(_build_portfolio_positions_payload())))


def on_update_portfolio_item(portfolio_item):
    position_item = _serialize_portfolio_position_item(portfolio_item)
    position_key = _portfolio_avg_cost_cache_key_from_contract(
        getattr(portfolio_item, 'account', '') or '',
        getattr(portfolio_item, 'contract', None),
    )
    if position_item is not None:
        portfolio_position_cache[_portfolio_avg_cost_cache_key(position_item)] = position_item
    elif position_key is not None:
        portfolio_position_cache.pop(position_key, None)
    _schedule_portfolio_positions_broadcast()

    item = _serialize_portfolio_avg_cost_item(portfolio_item)
    if not item:
        contract = getattr(portfolio_item, 'contract', None)
        cache_key = _portfolio_avg_cost_cache_key_from_contract(
            getattr(portfolio_item, 'account', '') or '',
            contract,
        )
        if cache_key is not None and cache_key in portfolio_avg_cost_cache:
            removed = portfolio_avg_cost_cache.pop(cache_key, None)
            logging.info(
                f"Removed portfolio avg cost cache item after zero/invalid update: "
                f"{(removed or {}).get('secType') or getattr(contract, 'secType', '')} "
                f"{(removed or {}).get('localSymbol') or getattr(contract, 'localSymbol', '')}"
            )
        return

    portfolio_avg_cost_cache[_portfolio_avg_cost_cache_key(item)] = item
    logging.info(
        f"Broadcasting portfolio avg cost update: "
        f"{item.get('secType')} {item.get('localSymbol') or item.get('symbol')} "
        f"position={item.get('position')} avgCostPerUnit={item.get('avgCostPerUnit')} "
        f"marketPrice={item.get('marketPrice')}"
    )
    _broadcast_portfolio_avg_cost_items([item])


def on_position_item(position_item):
    """Keep the authoritative quantity cache current between snapshots."""
    global portfolio_positions_snapshot_ready
    serialized = _serialize_portfolio_position_item(position_item)
    position_key = _portfolio_avg_cost_cache_key_from_contract(
        getattr(position_item, 'account', '') or '',
        getattr(position_item, 'contract', None),
    )
    if serialized is not None:
        portfolio_position_cache[_portfolio_avg_cost_cache_key(serialized)] = serialized
    elif position_key is not None:
        portfolio_position_cache.pop(position_key, None)
    portfolio_positions_snapshot_ready = True
    _schedule_portfolio_positions_broadcast()


ib.updatePortfolioEvent += on_update_portfolio_item
ib.positionEvent += on_position_item


_tracking_env = _build_order_tracking_environment()

on_combo_order_status = build_combo_order_status_handler(_tracking_env)
ib.orderStatusEvent += on_combo_order_status

on_hedge_order_status = build_hedge_order_status_handler(_tracking_env)
ib.orderStatusEvent += on_hedge_order_status

on_combo_order_error = build_combo_order_error_handler(_tracking_env)
ib.errorEvent += on_combo_order_error

on_hedge_order_error = build_hedge_order_error_handler(_tracking_env)
ib.errorEvent += on_hedge_order_error

on_combo_order_exec_details = build_combo_order_exec_details_handler(_tracking_env)
ib.execDetailsEvent += on_combo_order_exec_details

on_hedge_order_exec_details = build_hedge_order_exec_details_handler(_tracking_env)
ib.execDetailsEvent += on_hedge_order_exec_details


async def _broadcast_ib_connection_status(message=''):
    if not connected_clients:
        return
    payload = json.dumps(_build_ib_connection_status_payload(message))
    await asyncio.gather(*(
        send_message_safe(websocket, payload)
        for websocket in list(connected_clients)
    ))


async def _on_ib_supervisor_connected():
    global ib_market_data_state

    async with ib_subscription_recovery_lock:
        ib_market_data_state = 'ready'
        ib.reqMarketDataType(1)
        mark_recovery_complete = getattr(execution_adapter, 'complete_ib_recovery', None)
        if callable(mark_recovery_complete):
            mark_recovery_complete()
        logging.info("Managed accounts available: %s", ', '.join(_get_managed_accounts()) or '<none>')
        _broadcast_managed_accounts_snapshot()
        _broadcast_portfolio_positions_snapshot()
        await _broadcast_ib_connection_status('Connected to IB TWS/Gateway.')


async def _on_ib_supervisor_disconnected():
    global api_market_data_generation
    global ib_automatic_replay_allowed
    global ib_market_data_state
    global ib_recovery_reason
    global ib_subscriptions_required
    global portfolio_positions_snapshot_ready

    async with ib_subscription_recovery_lock:
        api_market_data_generation += 1
        ib_market_data_state = 'invalidated'
        ib_recovery_reason = 'unexpected_disconnect'
        ib_subscriptions_required = True
        ib_automatic_replay_allowed = True

        for task in list(iv_term_structure_sync_tasks.values()):
            if not task.done():
                task.cancel()
        iv_term_structure_sync_tasks.clear()
        for websocket in list(client_subscriptions):
            client_subscriptions[websocket] = {}
        market_data_generic_ticks_by_con_id.clear()
        market_data_quote_as_of_by_ticker_key.clear()
        market_data_quote_fingerprint_by_ticker_key.clear()

        portfolio_positions_snapshot_ready = False
        _broadcast_managed_accounts_snapshot()
        _broadcast_portfolio_positions_snapshot()
        await _broadcast_ib_connection_status(
            f'IB connection was lost. Reconnecting now, then every '
            f'{int(IB_RECONNECT_INTERVAL_SECONDS)} seconds.'
        )
    await execution_adapter.pause_managed_for_ib_recovery(
        reason='unexpected_disconnect'
    )


async def _prepare_ib_live_subscription_generation(
    requested_generation=None,
    has_explicit_generation=False,
):
    """Atomically validate/adopt a request and publish startup invalidation.

    The lock keeps concurrent first-subscription requests behind the same
    invalidation broadcast. This guarantees every new-generation market-data
    response is sent only after connected clients have observed that generation.
    """

    global api_market_data_generation
    global ib_automatic_replay_allowed
    global ib_market_data_state
    global ib_recovery_reason
    global ib_subscriptions_required

    async with ib_subscription_recovery_lock:
        normalized_request_generation = normalize_market_data_generation(
            requested_generation
        )
        if has_explicit_generation and normalized_request_generation is None:
            return {
                'accepted': False,
                'generationChanged': False,
                'marketDataGeneration': api_market_data_generation,
            }

        connected = bool(ib.isConnected())
        can_adopt_startup_transition = (
            not connected
            and has_explicit_generation
            and ib_recovery_reason == 'startup_subscription_wait'
            and ib_subscriptions_required
            and ib_automatic_replay_allowed
            and normalized_request_generation == api_market_data_generation - 1
        )
        if (
            has_explicit_generation
            and normalized_request_generation != api_market_data_generation
            and not can_adopt_startup_transition
        ):
            return {
                'accepted': False,
                'generationChanged': False,
                'marketDataGeneration': api_market_data_generation,
            }

        if connected:
            return {
                'accepted': True,
                'generationChanged': False,
                'marketDataGeneration': api_market_data_generation,
            }
        if ib_recovery_reason == 'explicit_stream_reset':
            # Explicit stream reset is a manual safety boundary. Requests arriving
            # before its replacement connection must not re-enable auto replay.
            return {
                'accepted': True,
                'generationChanged': False,
                'marketDataGeneration': api_market_data_generation,
            }
        if ib_subscriptions_required and ib_automatic_replay_allowed:
            return {
                'accepted': True,
                'generationChanged': False,
                'marketDataGeneration': api_market_data_generation,
            }

        api_market_data_generation += 1
        ib_market_data_state = 'invalidated'
        ib_recovery_reason = 'startup_subscription_wait'
        ib_subscriptions_required = True
        ib_automatic_replay_allowed = True
        await _broadcast_ib_connection_status(
            'A live subscription was requested while IB was unavailable. '
            'It will replay once after the first successful connection.'
        )
        return {
            'accepted': True,
            'generationChanged': True,
            'marketDataGeneration': api_market_data_generation,
        }


async def _mark_ib_subscription_requested_while_disconnected():
    """Compatibility wrapper returning whether it opened a new generation."""

    decision = await _prepare_ib_live_subscription_generation()
    return decision.get('generationChanged') is True


ib_connection_supervisor = IbConnectionSupervisor(
    ib=ib,
    host=TWS_HOST,
    port=TWS_PORT,
    client_id=TWS_CLIENT_ID,
    retry_interval_seconds=IB_RECONNECT_INTERVAL_SECONDS,
    connect_timeout_seconds=20,
    logger=logging.getLogger('ib_connection.supervisor'),
    on_connected=_on_ib_supervisor_connected,
    on_disconnected=_on_ib_supervisor_disconnected,
)


async def connect_ib():
    """Compatibility entry point for the persistent IB connection lifecycle."""
    task = ib_connection_supervisor.start()
    await task


def _build_ib_connection_status_payload(message=''):
    connected = bool(ib.isConnected())
    supervisor = ib_connection_supervisor
    return {
        'action': 'ib_connection_status',
        'serverSessionId': ib_server_session_id,
        'connected': connected,
        'connecting': bool(supervisor and supervisor.connecting and not connected),
        'reconnecting': bool(supervisor and supervisor.reconnecting and not connected),
        'connectionState': supervisor.state if supervisor else ('connected' if connected else 'stopped'),
        'host': TWS_HOST,
        'port': TWS_PORT,
        'clientId': supervisor.effective_client_id if supervisor else TWS_CLIENT_ID,
        'configuredClientId': TWS_CLIENT_ID,
        'retryIntervalSeconds': int(IB_RECONNECT_INTERVAL_SECONDS),
        'marketDataGeneration': api_market_data_generation,
        'marketDataState': ib_market_data_state,
        'recoveryReason': ib_recovery_reason,
        'subscriptionsRequired': ib_subscriptions_required,
        'automaticReplayAllowed': ib_automatic_replay_allowed,
        'message': str(message or '').strip(),
    }


async def _ensure_ib_connect_task():
    global ib_connect_task
    if ib.isConnected():
        return 'IB is already connected.'
    was_running = ib_connection_supervisor.running
    was_connecting = ib_connection_supervisor.connecting
    requested = ib_connection_supervisor.request_connect()
    ib_connect_task = ib_connection_supervisor.task
    if not was_running:
        logging.info("Started background IB connection supervisor.")
    elif requested and not was_connecting:
        logging.info("Manual IB connection request woke the background supervisor.")
    if was_connecting:
        return 'IB connection attempt is already running.'
    return 'Connecting to IB TWS/Gateway...'


async def _reset_all_api_market_data_subscriptions(requested_by='Unknown'):
    """Clear all streams for this IB API client, including untracked leaked lines."""
    global api_market_data_generation
    global ib_automatic_replay_allowed
    global ib_connect_task
    global ib_market_data_state
    global ib_recovery_reason
    global ib_subscriptions_required

    async with api_market_data_reset_lock:
        async with ib_subscription_recovery_lock:
            api_market_data_generation += 1
            ib_market_data_state = 'invalidated'
            ib_recovery_reason = 'explicit_stream_reset'
            ib_subscriptions_required = True
            ib_automatic_replay_allowed = False
            await execution_adapter.pause_managed_for_ib_recovery(
                reason='explicit_stream_reset'
            )
            await _broadcast_ib_connection_status(
                'API market-data streams are being reset. Automatic subscription '
                'replay is blocked until the user subscribes again.'
            )
        tracked_client_count = sum(1 for subscriptions in client_subscriptions.values() if subscriptions)
        active_iv_tasks = [task for task in iv_term_structure_sync_tasks.values() if not task.done()]
        stopped_iv_sync_count = len(active_iv_tasks)
        if active_iv_tasks:
            for task in active_iv_tasks:
                task.cancel()
            await asyncio.gather(*active_iv_tasks, return_exceptions=True)
        iv_term_structure_sync_tasks.clear()

        cancellation = cancel_all_api_market_data_subscriptions(
            ib=ib,
            client_subscriptions=client_subscriptions,
            generic_ticks_by_con_id=market_data_generic_ticks_by_con_id,
        )
        market_data_quote_as_of_by_ticker_key.clear()
        market_data_quote_fingerprint_by_ticker_key.clear()

        connection_was_connected = bool(ib.isConnected())
        connection_reset = False
        if connection_was_connected:
            connection_reset = ib_connection_supervisor.disconnect_intentionally()

        reconnect_message = await _ensure_ib_connect_task()
        reconnecting = bool(ib_connection_supervisor.reconnecting)
        payload = {
            'action': 'api_market_data_subscriptions_reset',
            'success': True,
            'requestedBy': str(requested_by or 'Unknown'),
            'trackedClientCount': tracked_client_count,
            'stoppedIvSyncCount': stopped_iv_sync_count,
            'knownTickerCount': cancellation['knownTickerCount'],
            'cancelledTickerCount': cancellation['cancelledTickerCount'],
            'cancelErrorCount': cancellation['cancelErrorCount'],
            'connectionWasConnected': connection_was_connected,
            'connectionReset': connection_reset,
            'reconnecting': reconnecting,
            'marketDataGeneration': api_market_data_generation,
            'marketDataState': ib_market_data_state,
            'recoveryReason': ib_recovery_reason,
            'subscriptionsRequired': ib_subscriptions_required,
            'automaticReplayAllowed': ib_automatic_replay_allowed,
            'message': (
                f"Cleared all market-data subscriptions for this API client "
                f"({cancellation['knownTickerCount']} known tickers, {tracked_client_count} active web sessions). "
                "The API connection was reset to release untracked request IDs and is reconnecting. "
                "All pages must subscribe again. No orders were cancelled. "
                "Any running managed-order supervision lost its live quotes during the reset and requires manual review."
            ),
        }
        logging.warning(
            "Global API market-data reset requested by %s: %s %s",
            requested_by,
            payload['message'],
            reconnect_message,
        )
        return payload


def _get_api_market_data_generation():
    return api_market_data_generation


def _api_market_data_reset_in_progress():
    return api_market_data_reset_lock.locked()


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
    if _normalize_symbol(defaults.get('option_sec_type')) == 'FOP':
        # Weekly futures-option classes are listing-specific on every exchange.
        # The per-family defaults (E3A/Q3A/ML3/G3T/S3T/H3T) each name one
        # weekday-and-week listing, so they are wrong for most expiries and have
        # produced valid-expiry IB 200 errors.  Always qualify FOPs from their
        # exact contract fields and let IB name the class.
        return ''
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

        # underConId belongs to ContractDetails, not Contract.  Reading it
        # from ``candidate`` silently disabled the intended FOP month filter.
        candidate_under_con_id = getattr(detail, 'underConId', None)
        if requested_under_con_id and candidate_under_con_id != requested_under_con_id:
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

def _futures_identity_con_id(contract):
    """Return a positive conId for a qualified FUT, else None."""
    if contract is None:
        return None
    if _normalize_symbol(getattr(contract, 'secType', '')) != 'FUT':
        return None
    con_id = _positive_contract_id(getattr(contract, 'conId', None))
    return con_id


def _remember_verified_underlying_contract_month(contract, details=None):
    """Cache a FUT delivery month from authoritative ContractDetails evidence.

    Once IB qualifies a future, ``lastTradeDateOrContractMonth`` is rewritten to
    the exact YYYYMMDD last trade date, and for every product whose expiry leads
    delivery that date falls in the *previous* month: CL Sep 2026 stops trading
    in Aug 2026, so truncating the date to six digits reports 202608 for a
    202609 contract.  ``ContractDetails.contractMonth`` is the delivery month IB
    itself publishes, so it is the only accepted evidence here; callers without
    ContractDetails get '' and must resolve it via
    ``_resolve_verified_futures_contract_month``.
    """
    con_id = _futures_identity_con_id(contract)
    if con_id is None:
        return ''
    contract_month = _to_contract_month(getattr(details, 'contractMonth', ''))
    if contract_month:
        underlying_contract_month_by_con_id[con_id] = contract_month
        return contract_month
    return underlying_contract_month_by_con_id.get(con_id, '')


async def _resolve_verified_futures_contract_month(con_id):
    """Resolve a FUT delivery month from IB ContractDetails for one conId.

    Cached per conId because a delivery month is immutable.  Failures return ''
    rather than a date-derived guess; the browser then reports the month as
    unverified instead of silently comparing against the wrong month.
    """
    normalized_con_id = _positive_contract_id(con_id)
    if normalized_con_id is None:
        return ''
    cached_month = _to_contract_month(
        underlying_contract_month_by_con_id.get(normalized_con_id)
    )
    if cached_month:
        return cached_month

    async def resolve_once():
        # The semaphore bounds distinct-contract traffic; same-conId callers are
        # deduplicated by futures_contract_month_inflight_by_con_id below.  It is
        # a dedicated semaphore because a FOP timing resolution awaits this
        # function while holding option_contract_timing_semaphore.
        async with futures_contract_month_semaphore:
            cached = _to_contract_month(
                underlying_contract_month_by_con_id.get(normalized_con_id)
            )
            if cached:
                return cached
            try:
                details_list = await asyncio.wait_for(
                    ib.reqContractDetailsAsync(Contract(conId=normalized_con_id)),
                    timeout=OPTION_CONTRACT_TIMING_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                logging.warning(
                    'Timed out resolving futures delivery month for conId=%s after %.1fs; '
                    'the browser will treat that month as unverified.',
                    normalized_con_id,
                    OPTION_CONTRACT_TIMING_TIMEOUT_SECONDS,
                )
                return ''
            except Exception as exc:
                logging.warning(
                    'Unable to resolve futures delivery month for conId=%s: %s; '
                    'the browser will treat that month as unverified.',
                    normalized_con_id,
                    exc,
                )
                return ''
            selected = next((
                details for details in (details_list or [])
                if _futures_identity_con_id(getattr(details, 'contract', None))
                == normalized_con_id
            ), None)
            if selected is None:
                return ''
            return _remember_verified_underlying_contract_month(
                getattr(selected, 'contract', None), selected
            )

    task = futures_contract_month_inflight_by_con_id.get(normalized_con_id)
    if task is None:
        task = asyncio.create_task(resolve_once())
        futures_contract_month_inflight_by_con_id[normalized_con_id] = task

        def clear_inflight(completed_task):
            if (futures_contract_month_inflight_by_con_id.get(normalized_con_id)
                    is completed_task):
                futures_contract_month_inflight_by_con_id.pop(normalized_con_id, None)

        task.add_done_callback(clear_inflight)

    # A browser disconnect must not cancel a lookup shared with IVTS or another tab.
    return await asyncio.shield(task) or ''


async def _resolve_verified_underlying_contract_month(under_con_id):
    """Resolve an actual FOP underlying month from its IB conId.

    ContractDetails.underConId is the authoritative link from a futures option
    to its FUT.  The browser's requested month is intentionally not accepted as
    evidence here.
    """
    return await _resolve_verified_futures_contract_month(under_con_id)


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
    await _resolve_verified_futures_contract_month(
        _futures_identity_con_id(results[0])
    )
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
    sec_type = _normalize_symbol(getattr(contract, 'secType', ''))
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

    if (not results or results[0] is None) and sec_type in ('OPT', 'FOP') and getattr(contract, 'tradingClass', ''):
        original_trading_class = contract.tradingClass
        contract.tradingClass = ''
        results = await ib.qualifyContractsAsync(contract)
        if results and results[0] is not None:
            logging.info(
                f"Qualified {_describe_contract_request(contract_request)} using tradingClass fallback "
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
    qualified_contract = results[0]
    if sec_type == 'FUT':
        # Resolve the delivery month before the first quote is published so the
        # browser's identity gate has authoritative evidence to compare against.
        await _resolve_verified_futures_contract_month(
            _futures_identity_con_id(qualified_contract)
        )
    return qualified_contract


async def _resolve_option_contract_timing(qualified_option):
    con_id = getattr(qualified_option, 'conId', None)
    if not con_id:
        return {}
    sec_type = _normalize_symbol(getattr(qualified_option, 'secType', ''))
    qualified_expiry = _normalize_contract_date(
        getattr(qualified_option, 'lastTradeDateOrContractMonth', '') or ''
    )
    def cache_is_usable(candidate):
        return (
            option_contract_timing_is_publishable(candidate)
            and (
                not qualified_expiry
                or _normalize_contract_date(candidate.get('lastTradeDate') or '')
                == qualified_expiry
            )
        )

    async def resolve_once():
        # The semaphore bounds distinct-contract traffic.  Same-conId callers
        # are deduplicated by option_contract_timing_inflight_by_con_id below.
        async with option_contract_timing_semaphore:
            cached_timing = option_contract_timing_by_con_id.get(con_id)
            if cache_is_usable(cached_timing):
                return dict(cached_timing)
            timing = {}
            try:
                details_list = await asyncio.wait_for(
                    ib.reqContractDetailsAsync(qualified_option),
                    timeout=OPTION_CONTRACT_TIMING_TIMEOUT_SECONDS,
                )
                selected = next((
                    details for details in (details_list or [])
                    if getattr(getattr(details, 'contract', None), 'conId', None) == con_id
                ), None)
                if selected is not None:
                    timing = build_option_contract_timing(qualified_option, selected)
                    resolved_sec_type = _normalize_symbol(timing.get('secType') or sec_type)
                    if resolved_sec_type == 'FOP':
                        actual_under_con_id = timing.get('underConId')
                        actual_underlying_month = await _resolve_verified_underlying_contract_month(
                            actual_under_con_id
                        )
                        if actual_underlying_month:
                            timing['underlyingContractMonth'] = actual_underlying_month
                            timing['underlyingBindingVerified'] = True
                            timing['underlyingBindingSource'] = 'ib_contract_details_under_con_id'
                            timing['underlyingBindingStatus'] = 'verified'
                        else:
                            timing['underlyingBindingVerified'] = False
                            timing['underlyingBindingStatus'] = (
                                'underlying_month_unresolved'
                                if actual_under_con_id
                                else 'under_con_id_missing'
                            )
            except asyncio.TimeoutError:
                logging.warning(
                    'Timed out resolving option last-trade timing for conId=%s after %.1fs; '
                    'exact timing remains unavailable.',
                    con_id,
                    OPTION_CONTRACT_TIMING_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                logging.warning(
                    'Unable to resolve option last-trade timing for conId=%s: %s; '
                    'exact timing remains unavailable.',
                    con_id,
                    exc,
                )
            # Raw ContractDetails fields without an exact expiryAsOf are useful
            # diagnostics, not stable pricing evidence.  Do not let them become
            # a process-lifetime positive cache entry; a later subscription must
            # be able to retry.  FOP timing additionally needs a verified
            # underlying futures binding before it becomes reusable.
            if cache_is_usable(timing):
                option_contract_timing_by_con_id[con_id] = dict(timing)
            else:
                option_contract_timing_by_con_id.pop(con_id, None)
            return dict(timing)

    cached_timing = option_contract_timing_by_con_id.get(con_id)
    if cache_is_usable(cached_timing):
        return dict(cached_timing)

    task = option_contract_timing_inflight_by_con_id.get(con_id)
    if task is None:
        task = asyncio.create_task(resolve_once())
        option_contract_timing_inflight_by_con_id[con_id] = task

        def clear_inflight(completed_task):
            if option_contract_timing_inflight_by_con_id.get(con_id) is completed_task:
                option_contract_timing_inflight_by_con_id.pop(con_id, None)

        task.add_done_callback(clear_inflight)

    # One browser disconnect must not cancel the lookup shared by IVTS or
    # another portfolio tab.
    timing = await asyncio.shield(task)
    return dict(timing or {})

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


_resolve_iv_term_structure_secdef_exchange = resolve_iv_term_structure_secdef_exchange


def _build_iv_term_structure_environment():
    return {
        'ib': ib,
        'client_subscriptions': client_subscriptions,
        'market_data_generic_ticks_by_con_id': market_data_generic_ticks_by_con_id,
        'market_data_quote_as_of_by_ticker_key': market_data_quote_as_of_by_ticker_key,
        'market_data_quote_fingerprint_by_ticker_key': market_data_quote_fingerprint_by_ticker_key,
        'option_contract_timing_by_con_id': option_contract_timing_by_con_id,
        'futures_contract_month_by_con_id': underlying_contract_month_by_con_id,
        'client_subscription_settings': client_subscription_settings,
        'iv_term_structure_sync_tasks': iv_term_structure_sync_tasks,
        'iv_term_structure_contract_details_semaphore': iv_term_structure_contract_details_semaphore,
        'iv_term_structure_option_subscription_semaphore': iv_term_structure_option_subscription_semaphore,
        'get_api_market_data_generation': _get_api_market_data_generation,
        'api_market_data_reset_in_progress': _api_market_data_reset_in_progress,
        'send_message_safe': send_message_safe,
        'build_underlying_request': _build_underlying_request,
        'build_contract_from_request': _build_contract_from_request,
        'qualify_one': _qualify_one,
        'resolve_option_contract_timing': _resolve_option_contract_timing,
        'unsubscribe_client_safely': unsubscribe_client_safely,
        'get_client_subscription_settings': _get_client_subscription_settings,
        'extract_quote_snapshot': _extract_quote_snapshot,
        'describe_contract_request': _describe_contract_request,
        'coerce_positive_int': _coerce_positive_int,
        'normalize_replay_date': normalize_replay_date,
        'iv_term_structure_default_max_dte': IV_TERM_STRUCTURE_DEFAULT_MAX_DTE,
        'iv_term_structure_default_strike_radius': IV_TERM_STRUCTURE_DEFAULT_STRIKE_RADIUS,
        'iv_term_structure_bucket_definitions': IV_TERM_STRUCTURE_BUCKET_DEFINITIONS,
    }


async def _fetch_iv_term_structure_contract_rows_for_expiry(
    option_symbol,
    option_sec_type,
    option_exchange,
    option_currency,
    option_multiplier,
    expiry,
    option_trading_class='',
    qualified_underlying=None,
    timeout_seconds=8.0,
):
    return await fetch_iv_term_structure_contract_rows_for_expiry(
        _build_iv_term_structure_environment(),
        option_symbol,
        option_sec_type,
        option_exchange,
        option_currency,
        option_multiplier,
        expiry,
        option_trading_class=option_trading_class,
        qualified_underlying=qualified_underlying,
        timeout_seconds=timeout_seconds,
    )


async def _fetch_iv_term_structure_contract_rows_for_exact_strike(
    option_symbol,
    option_sec_type,
    option_exchange,
    option_currency,
    option_multiplier,
    expiry,
    strike,
    option_trading_class='',
    qualified_underlying=None,
    timeout_seconds=3.0,
):
    return await fetch_iv_term_structure_contract_rows_for_exact_strike(
        _build_iv_term_structure_environment(),
        option_symbol,
        option_sec_type,
        option_exchange,
        option_currency,
        option_multiplier,
        expiry,
        strike,
        option_trading_class=option_trading_class,
        qualified_underlying=qualified_underlying,
        timeout_seconds=timeout_seconds,
    )


async def _resolve_iv_term_structure_expiry_selection_from_candidates(
    option_symbol,
    option_sec_type,
    option_exchange,
    option_currency,
    option_multiplier,
    expiry,
    underlying_price,
    candidate_strikes,
    strike_radius,
    option_trading_class='',
    qualified_underlying=None,
):
    return await resolve_iv_term_structure_expiry_selection_from_candidates(
        _build_iv_term_structure_environment(),
        option_symbol,
        option_sec_type,
        option_exchange,
        option_currency,
        option_multiplier,
        expiry,
        underlying_price,
        candidate_strikes,
        strike_radius,
        option_trading_class=option_trading_class,
        qualified_underlying=qualified_underlying,
    )


async def _subscribe_iv_term_structure_option_request(websocket, option_request):
    return await subscribe_iv_term_structure_option_request(
        _build_iv_term_structure_environment(),
        websocket,
        option_request,
    )


def _track_iv_term_structure_sync_task(websocket, task):
    track_iv_term_structure_sync_task(
        _build_iv_term_structure_environment(),
        websocket,
        task,
    )


async def _cancel_iv_term_structure_sync_task(websocket):
    await cancel_iv_term_structure_sync_task(
        _build_iv_term_structure_environment(),
        websocket,
    )


async def _run_iv_term_structure_option_sync(websocket, symbol, sync_context):
    await run_iv_term_structure_option_sync(
        _build_iv_term_structure_environment(),
        websocket,
        symbol,
        sync_context,
    )


async def _handle_iv_term_structure_subscription(
    websocket,
    client_ip,
    data,
    subscription_generation=None,
):
    await handle_iv_term_structure_subscription(
        _build_iv_term_structure_environment(),
        websocket,
        client_ip,
        data,
        subscription_generation=subscription_generation,
    )

def _describe_contract_request(contract_data):
    if isinstance(contract_data, dict):
        sec_type = _normalize_symbol(contract_data.get('secType') or contract_data.get('sec_type'))
        symbol = _normalize_symbol(contract_data.get('symbol'))
        return f"{sec_type or 'UNKNOWN'} {symbol or '<missing>'}".strip()
    return _normalize_symbol(contract_data) or '<missing>'


_extract_quote_snapshot = extract_quote_snapshot
_extract_option_iv = extract_option_iv
_extract_option_delta = extract_option_delta
_coerce_positive_int = coerce_positive_int
_normalize_bool = normalize_bool


def _log_option_iv_debug_if_needed(sub_id, ticker, iv):
    log_option_iv_debug_if_needed(sub_id, ticker, iv, option_iv_debug_last_logged)


def _build_market_data_environment():
    return {
        'ib': ib,
        'connected_clients': connected_clients,
        'client_subscriptions': client_subscriptions,
        'client_subscription_settings': client_subscription_settings,
        'market_data_quote_as_of_by_ticker_key': market_data_quote_as_of_by_ticker_key,
        'market_data_quote_fingerprint_by_ticker_key': market_data_quote_fingerprint_by_ticker_key,
        'option_contract_timing_by_con_id': option_contract_timing_by_con_id,
        'futures_contract_month_by_con_id': underlying_contract_month_by_con_id,
        'get_api_market_data_generation': _get_api_market_data_generation,
        'api_market_data_reset_in_progress': _api_market_data_reset_in_progress,
        'send_message_safe': send_message_safe,
        'log_option_iv_debug_if_needed': _log_option_iv_debug_if_needed,
        'build_contract_from_request': _build_contract_from_request,
        'qualify_one': _qualify_one,
        'describe_contract_request': _describe_contract_request,
        'normalize_symbol': _normalize_symbol,
    }


def _get_client_subscription_settings(websocket):
    return get_client_subscription_settings(websocket, client_subscription_settings)


on_pending_tickers = build_pending_tickers_handler(_build_market_data_environment())


def unsubscribe_client_safely(ws):
    unsubscribe_client_safely_via_market_data(
        ws,
        client_subscriptions=client_subscriptions,
        ib=ib,
        generic_ticks_by_con_id=market_data_generic_ticks_by_con_id,
        quote_as_of_by_ticker_key=market_data_quote_as_of_by_ticker_key,
        quote_fingerprint_by_ticker_key=market_data_quote_fingerprint_by_ticker_key,
    )


async def _request_ib_historical_bars(
    underlying_request,
    *,
    bar_size='1 day',
    duration_str='2 Y',
    use_rth=True,
    limit=260,
):
    return await request_ib_historical_bars(
        _build_market_data_environment(),
        underlying_request,
        bar_size=bar_size,
        duration_str=duration_str,
        use_rth=use_rth,
        limit=limit,
    )


def _build_ws_handler_environment():
    return {
        'connected_clients': connected_clients,
        'client_subscriptions': client_subscriptions,
        'market_data_generic_ticks_by_con_id': market_data_generic_ticks_by_con_id,
        'client_subscription_settings': client_subscription_settings,
        'option_contract_timing_by_con_id': option_contract_timing_by_con_id,
        'futures_contract_month_by_con_id': underlying_contract_month_by_con_id,
        'historical_replay_service': historical_replay_service,
        'get_discount_curve_snapshot': _get_discount_curve_snapshot,
        'execution_engine': execution_engine,
        'send_portfolio_avg_cost_snapshot': _send_portfolio_avg_cost_snapshot,
        'send_portfolio_positions_snapshot': _send_portfolio_positions_snapshot,
        'send_managed_accounts_snapshot': _send_managed_accounts_snapshot,
        'build_underlying_request': _build_underlying_request,
        'normalize_replay_date': normalize_replay_date,
        'describe_contract_request': _describe_contract_request,
        'cancel_iv_term_structure_sync_task': _cancel_iv_term_structure_sync_task,
        'unsubscribe_client_safely': unsubscribe_client_safely,
        'send_message_safe': send_message_safe,
        'normalize_bool': _normalize_bool,
        'build_contract_from_request': _build_contract_from_request,
        'get_client_subscription_settings': _get_client_subscription_settings,
        'qualify_one': _qualify_one,
        'resolve_option_contract_timing': _resolve_option_contract_timing,
        'handle_iv_term_structure_subscription': _handle_iv_term_structure_subscription,
        'iv_term_structure_catalog_timeout_seconds': IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS,
        'build_ib_connection_status_payload': _build_ib_connection_status_payload,
        'prepare_ib_live_subscription_generation': _prepare_ib_live_subscription_generation,
        'mark_ib_subscription_requested': _mark_ib_subscription_requested_while_disconnected,
        'ensure_ib_connect_task': _ensure_ib_connect_task,
        'reset_all_api_market_data_subscriptions': _reset_all_api_market_data_subscriptions,
        'get_api_market_data_generation': _get_api_market_data_generation,
        'api_market_data_reset_in_progress': _api_market_data_reset_in_progress,
        'extract_quote_snapshot': _extract_quote_snapshot,
        'request_ib_historical_bars': _request_ib_historical_bars,
        'coerce_positive_int': _coerce_positive_int,
        'normalize_symbol': _normalize_symbol,
        'build_active_hedge_orders_snapshot': _build_active_hedge_orders_snapshot,
        'build_active_combo_orders_snapshot': _build_active_combo_orders_snapshot,
        'combo_order_tracking_by_order_id': combo_order_tracking_by_order_id,
        'combo_order_tracking_by_perm_id': combo_order_tracking_by_perm_id,
        'hedge_order_tracking_by_order_id': hedge_order_tracking_by_order_id,
        'hedge_order_tracking_by_perm_id': hedge_order_tracking_by_perm_id,
        'iter_unique_hedge_order_trackings': _iter_unique_hedge_order_trackings,
        'is_terminal_hedge_tracking': _is_terminal_hedge_tracking,
        'is_terminal_combo_tracking': _is_terminal_combo_tracking,
        'extract_market_price': _extract_market_price,
        'ib': ib,
    }


def _purge_combo_order_tracking_for_websocket(ws):
    purge_combo_order_tracking_for_websocket(
        ws,
        combo_order_tracking_by_order_id,
        combo_order_tracking_by_perm_id,
        is_terminal_combo_tracking=_is_terminal_combo_tracking,
    )


def _purge_hedge_order_tracking_for_websocket(ws):
    purge_hedge_order_tracking_for_websocket(
        ws,
        iter_unique_hedge_order_trackings=_iter_unique_hedge_order_trackings,
        is_terminal_hedge_tracking=_is_terminal_hedge_tracking,
        hedge_order_tracking_by_order_id=hedge_order_tracking_by_order_id,
        hedge_order_tracking_by_perm_id=hedge_order_tracking_by_perm_id,
    )


async def _dispatch_execution_action(websocket, data, client_ip='Unknown'):
    return await dispatch_ws_execution_action(
        _build_ws_handler_environment(),
        websocket,
        data,
        client_ip=client_ip,
    )


handle_ws_client = build_ws_client_handler(_build_ws_handler_environment())

async def main():
    global ib_connect_task
    try:
        # Register the tick callback
        ib.pendingTickersEvent += on_pending_tickers

        # Start IB connection in the background so historical replay can work
        # even when TWS/Gateway is not running.
        ib_connect_task = ib_connection_supervisor.start()
        logging.info(
            "Started background IB connection supervisor with a %.0f-second retry cadence.",
            IB_RECONNECT_INTERVAL_SECONDS,
        )

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

            try:
                await ib_connect_task
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise RuntimeError(
                    'IB connection supervisor failed unexpectedly.'
                ) from exc
            raise RuntimeError('IB connection supervisor stopped unexpectedly.')
    finally:
        # Guaranteed cleanup: stop retries before disconnecting so Ctrl+C,
        # SIGTERM, or an unhandled exception cannot start a new API session.
        if ib.isConnected():
            logging.info("Disconnecting from IB...")
        await ib_connection_supervisor.stop(disconnect=True)
        ib_connect_task = None
        logging.info("IB connection supervisor stopped.")

if __name__ == "__main__":
    # Treat SIGTERM (e.g. `kill`, service stop, terminal closure) identically to
    # Ctrl+C so the finally block in main() always fires and IB is cleanly disconnected.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Server stopped by user.")
