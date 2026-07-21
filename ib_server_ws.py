import asyncio
import json
import logging
import sqlite3
from typing import Any

from ib_async import Stock
from websockets.exceptions import ConnectionClosed

from ib_server_iv_term_structure import build_iv_term_structure_payload_evidence
from ib_server_market_data import (
    cancel_mkt_data_if_unused,
    extract_option_contract_identity,
    option_contract_timing_is_publishable,
    req_mkt_data_pooled,
)
from runtime_contracts import (
    ApiMarketDataResetPayload,
    HistoricalBarsResponsePayload,
    HistoricalReplayErrorPayload,
    IvTermStructureErrorPayload,
    IvTermStructureSyncStartedPayload,
    ManualUnderlyingSyncPayload,
    OptionContractMetadataPayload,
)

IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS_DEFAULT = 75.0
IV_TERM_STRUCTURE_PROTOCOL_VERSION = '20260719.5'
# Floors a misconfigured 0/negative timeout so catalog resolution always gets a
# usable window. Tests that stall the handler must outlast this, not undercut it.
IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS_FLOOR = 1.0


def purge_combo_order_tracking_for_websocket(
    ws,
    combo_order_tracking_by_order_id,
    combo_order_tracking_by_perm_id,
    *,
    is_terminal_combo_tracking=None,
):
    """Drop terminal trackings and orphan live ones when a client disconnects.

    Live (non-terminal) trackings must survive the disconnect: the broker order
    is still working in TWS, and a reconnecting session re-adopts them through
    `request_active_combo_orders_snapshot`. Without a terminal predicate this
    conservatively orphans everything rather than dropping fill attribution.
    """
    seen_tracking_ids = set()
    trackings = list(combo_order_tracking_by_order_id.values()) + list(combo_order_tracking_by_perm_id.values())
    for tracking in trackings:
        tracking_identity = id(tracking)
        if tracking_identity in seen_tracking_ids:
            continue
        seen_tracking_ids.add(tracking_identity)
        if tracking.get('websocket') is not ws:
            continue

        if callable(is_terminal_combo_tracking) and is_terminal_combo_tracking(tracking):
            order_id = tracking.get('orderId')
            perm_id = tracking.get('permId')
            if order_id is not None:
                combo_order_tracking_by_order_id.pop(order_id, None)
            if perm_id is not None:
                combo_order_tracking_by_perm_id.pop(perm_id, None)
        else:
            tracking['websocket'] = None


def purge_hedge_order_tracking_for_websocket(
    ws,
    *,
    iter_unique_hedge_order_trackings,
    is_terminal_hedge_tracking,
    hedge_order_tracking_by_order_id,
    hedge_order_tracking_by_perm_id,
):
    for tracking in iter_unique_hedge_order_trackings():
        if tracking.get('websocket') is not ws:
            continue
        if is_terminal_hedge_tracking(tracking):
            order_id = tracking.get('orderId')
            perm_id = tracking.get('permId')
            if order_id is not None:
                hedge_order_tracking_by_order_id.pop(order_id, None)
            if perm_id is not None:
                hedge_order_tracking_by_perm_id.pop(perm_id, None)
        else:
            tracking['websocket'] = None


async def dispatch_execution_action(env, websocket, data, client_ip='Unknown'):
    execution_engine = env['execution_engine']
    if hasattr(execution_engine, 'handle_hedge_action'):
        payload = await execution_engine.handle_hedge_action(
            websocket,
            data,
            client_ip=client_ip,
        )
        if payload is not None:
            return payload

    return await execution_engine.handle_combo_action(
        websocket,
        data,
        client_ip=client_ip,
    )


async def _handle_request_historical_snapshot(env, websocket, data, client_ip):
    raw_underlying = data.get('underlying')
    options_data = data.get('options', [])
    requested_date = env['normalize_replay_date'](data.get('replayDate'))
    underlying_request = env['build_underlying_request'](raw_underlying, options_data)

    logging.info(
        f"Received historical snapshot request from {client_ip} "
        f"for date {requested_date or '<latest>'}, "
        f"underlying {env['describe_contract_request'](underlying_request)}, "
        f"{len(options_data)} options"
    )

    await env['cancel_iv_term_structure_sync_task'](websocket)
    env['unsubscribe_client_safely'](websocket)

    try:
        payload = env['historical_replay_service'].build_snapshot_payload(
            requested_date,
            underlying_request if isinstance(underlying_request, dict) else {},
            options_data,
        )
    except (sqlite3.Error, ValueError) as exc:
        logging.exception("Historical replay snapshot failed")
        error_payload: HistoricalReplayErrorPayload = {
            'action': 'historical_replay_error',
            'message': str(exc),
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    if payload is None:
        error_payload = {
            'action': 'historical_replay_error',
            'message': (
                f"No underlying historical quote was found for "
                f"{env['describe_contract_request'](underlying_request)} "
                f"on {requested_date or 'the latest available date'}."
            ),
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    await env['send_message_safe'](websocket, json.dumps(payload))


def _req_mkt_data_pooled(env, qualified_contract, generic_ticks=''):
    return req_mkt_data_pooled(
        qualified_contract,
        generic_ticks,
        ib=env['ib'],
        client_subscriptions=env['client_subscriptions'],
        generic_ticks_by_con_id=env.setdefault('market_data_generic_ticks_by_con_id', {}),
    )


def _capture_api_market_data_generation(env):
    getter = env.get('get_api_market_data_generation')
    return getter() if callable(getter) else None


def _api_market_data_generation_is_current(env, captured_generation):
    getter = env.get('get_api_market_data_generation')
    reset_in_progress = env.get('api_market_data_reset_in_progress')
    if callable(reset_in_progress) and reset_in_progress():
        return False
    return captured_generation is None or not callable(getter) or getter() == captured_generation


def _option_contract_metadata_is_publishable(qualified_option, timing):
    if not option_contract_timing_is_publishable(timing):
        return False
    timing_sec_type = str((timing or {}).get('secType') or '').strip().upper()
    qualified_sec_type = str(getattr(qualified_option, 'secType', '') or '').strip().upper()
    return not timing_sec_type or not qualified_sec_type or timing_sec_type == qualified_sec_type


async def _send_option_contract_metadata(env, websocket, leg_id, qualified_option, timing):
    """Handoff ContractDetails without pretending it is a market quote.

    A pooled ticker may already belong to IVTS or another browser tab and may
    not emit a new price event after this websocket attaches.  Exact expiry
    timing therefore travels on its own channel at subscribe time.  The
    browser must not use this message to refresh BBO/feed timestamps.
    """
    if not _option_contract_metadata_is_publishable(qualified_option, timing):
        return False
    metadata = extract_option_contract_identity(qualified_option)
    metadata.update(dict(timing or {}))
    payload: OptionContractMetadataPayload = {
        'action': 'option_contract_metadata',
        'contractMetadataOnly': True,
        'options': {str(leg_id): metadata},
    }
    return await env['send_message_safe'](websocket, json.dumps(payload))


def _describe_unresolved_option(opt, reason, detail=''):
    """Build the client-facing record for an option leg that never subscribed.

    The frontend renders the wording; this only carries the identity the user
    typed (strike/right/expiry) plus a machine-readable reason so a missing
    strike is distinguishable from a malformed request.
    """
    record = {
        'id': opt.get('id'),
        'reason': reason,
        'symbol': str(opt.get('symbol') or opt.get('underlyingSymbol') or ''),
        'right': str(opt.get('right') or ''),
        'strike': opt.get('strike'),
        'expDate': str(opt.get('expDate') or ''),
    }
    detail_text = str(detail or '').strip()
    if detail_text:
        record['detail'] = detail_text
    return record


async def _send_option_subscription_status(env, websocket, unresolved):
    """Tell the client which requested option legs produced no subscription.

    Without this the leg id is simply absent from every market-data payload,
    which the frontend cannot distinguish from "quote has not arrived yet" --
    the toggle appears to hang forever.  Sent unconditionally so a previously
    unresolved leg that now qualifies clears its warning.
    """
    payload = {
        'action': 'option_subscription_status',
        'unresolved': unresolved,
    }
    return await env['send_message_safe'](websocket, json.dumps(payload))


async def _handle_subscribe(env, websocket, data, client_ip):
    subscription_generation = _capture_api_market_data_generation(env)
    if not _api_market_data_generation_is_current(env, subscription_generation):
        return
    raw_underlying = data.get('underlying')
    options_data = data.get('options', [])
    futures_data = data.get('futures', [])
    stocks_data = data.get('stocks', [])
    carry_references_data = data.get('carryReferences', [])
    greeks_enabled = env['normalize_bool'](data.get('greeksEnabled'), False)
    underlying_request = env['build_underlying_request'](raw_underlying, options_data)
    env['get_client_subscription_settings'](websocket)['greeks_enabled'] = greeks_enabled

    logging.info(
        f"Received subscription request from {client_ip} "
        f"for underlying {env['describe_contract_request'](underlying_request)}, "
        f"{len(options_data)} options, {len(futures_data)} futures, {len(stocks_data)} stocks, "
        f"and {len(carry_references_data)} optional carry references "
        f"(greeks={'on' if greeks_enabled else 'off'})"
    )

    try:
        underlying_contract = env['build_contract_from_request'](underlying_request)
    except Exception as exc:
        logging.error(f"Invalid underlying request from {client_ip}: {underlying_request!r} ({exc})")
        return

    await env['cancel_iv_term_structure_sync_task'](websocket)
    env['unsubscribe_client_safely'](websocket)

    qualified_underlying = await env['qualify_one'](underlying_contract, underlying_request)
    if not _api_market_data_generation_is_current(env, subscription_generation):
        return
    if qualified_underlying is None:
        logging.warning(
            f"Failed to qualify underlying {env['describe_contract_request'](underlying_request)}; "
            f"continuing with option subscriptions only"
        )
    else:
        ticker = _req_mkt_data_pooled(env, qualified_underlying)
        env['client_subscriptions'][websocket]['underlying'] = ticker

    unresolved_options = []
    for opt in options_data:
        leg_id = opt['id']
        try:
            opt_contract = env['build_contract_from_request'](opt)
        except Exception as exc:
            logging.error(f"Invalid option request for leg {leg_id}: {opt!r} ({exc})")
            unresolved_options.append(_describe_unresolved_option(opt, 'invalid_request', exc))
            continue

        qualified_option = await env['qualify_one'](opt_contract, opt)
        if not _api_market_data_generation_is_current(env, subscription_generation):
            return
        if qualified_option is None:
            logging.error(f"Failed to qualify option leg {leg_id}: {env['describe_contract_request'](opt)}")
            unresolved_options.append(_describe_unresolved_option(opt, 'contract_not_found'))
            continue

        timing = {}
        timing_resolver = env.get('resolve_option_contract_timing')
        if callable(timing_resolver):
            try:
                timing = await timing_resolver(qualified_option)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logging.warning(
                    'Option timing resolution failed for leg %s: %s; '
                    'exact contract timing remains unavailable.',
                    leg_id,
                    exc,
                )

        if not _api_market_data_generation_is_current(env, subscription_generation):
            return
        generic_ticks = '106' if greeks_enabled else ''
        opt_ticker = _req_mkt_data_pooled(env, qualified_option, generic_ticks)
        env['client_subscriptions'][websocket][leg_id] = opt_ticker
        await _send_option_contract_metadata(
            env,
            websocket,
            leg_id,
            qualified_option,
            timing,
        )
        if not _api_market_data_generation_is_current(env, subscription_generation):
            return

    # Report before the futures/stock legs so a missing strike surfaces even if
    # a later qualification stalls on a slow reqContractDetails round trip.
    if options_data:
        if unresolved_options:
            logging.warning(
                '%d of %d requested option legs could not be subscribed for %s; notifying client',
                len(unresolved_options),
                len(options_data),
                client_ip,
            )
        await _send_option_subscription_status(env, websocket, unresolved_options)

    for future_req in futures_data:
        future_id = future_req.get('id')
        if not future_id:
            continue

        try:
            future_contract = env['build_contract_from_request'](future_req)
        except Exception as exc:
            logging.error(f"Invalid future request {future_req!r} ({exc})")
            continue

        qualified_future = await env['qualify_one'](future_contract, future_req)
        if not _api_market_data_generation_is_current(env, subscription_generation):
            return
        if qualified_future is None:
            logging.error(
                f"Failed to qualify future subscription {future_id}: "
                f"{env['describe_contract_request'](future_req)}"
            )
            continue

        future_ticker = _req_mkt_data_pooled(env, qualified_future)
        env['client_subscriptions'][websocket][f'future_{future_id}'] = future_ticker

    # These references are diagnostics only (for example SPX against ES).
    # Failure must never block FOP subscriptions or alter the futures price
    # passed to Black-76.
    for reference_req in carry_references_data:
        reference_id = str(reference_req.get('id') or '').strip()
        if not reference_id:
            continue
        try:
            reference_contract = env['build_contract_from_request'](reference_req)
        except Exception as exc:
            logging.warning(
                'Invalid optional carry reference %r (%s); continuing without it',
                reference_req,
                exc,
            )
            continue
        try:
            qualified_reference = await env['qualify_one'](reference_contract, reference_req)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logging.warning(
                'Optional carry reference %s qualification failed (%s); continuing without it',
                env['describe_contract_request'](reference_req),
                exc,
            )
            continue
        if not _api_market_data_generation_is_current(env, subscription_generation):
            return
        if qualified_reference is None:
            logging.warning(
                'Optional carry reference %s could not be qualified; continuing without it',
                env['describe_contract_request'](reference_req),
            )
            continue
        try:
            reference_ticker = _req_mkt_data_pooled(env, qualified_reference)
        except Exception as exc:
            logging.warning(
                'Optional carry reference %s subscription failed (%s); continuing without it',
                env['describe_contract_request'](reference_req),
                exc,
            )
            continue
        env['client_subscriptions'][websocket][f'carry_reference_{reference_id}'] = reference_ticker

    for stock_sym in stocks_data:
        stock_contract = Stock(stock_sym, 'SMART', 'USD')
        qualified_stock = await env['qualify_one'](stock_contract)
        if not _api_market_data_generation_is_current(env, subscription_generation):
            return
        if qualified_stock is None:
            logging.error(f"Failed to qualify hedge stock {stock_sym}")
            continue

        stock_ticker = _req_mkt_data_pooled(env, qualified_stock)

        def make_stock_tick_handler(symbol, ws):
            def _on_stock_tick(ticker):
                price = env['extract_market_price'](ticker)
                if price is not None:
                    payload: dict[str, Any] = {'options': {}, 'stocks': {symbol: {'mark': price}}}
                    asyncio.create_task(env['send_message_safe'](ws, json.dumps(payload)))
            return _on_stock_tick

        stock_ticker.updateEvent += make_stock_tick_handler(stock_sym, websocket)
        env['client_subscriptions'][websocket][f'stock_{stock_sym}'] = stock_ticker
        logging.info(f"Subscribed to stock: {stock_sym}")


async def _handle_sync_underlying(env, websocket, data, client_ip):
    subscription_generation = _capture_api_market_data_generation(env)
    if not _api_market_data_generation_is_current(env, subscription_generation):
        return
    raw_underlying = data.get('underlying')
    underlying_request = env['build_underlying_request'](raw_underlying, [])
    try:
        contract = env['build_contract_from_request'](underlying_request)
    except Exception as exc:
        logging.error(f"Invalid manual sync request: {underlying_request!r} ({exc})")
        return

    qualified_underlying = await env['qualify_one'](contract, underlying_request)
    if not _api_market_data_generation_is_current(env, subscription_generation):
        return
    if qualified_underlying is None:
        logging.error(f"Failed to manual sync underlying {env['describe_contract_request'](underlying_request)}")
        return

    ticker = _req_mkt_data_pooled(env, qualified_underlying)
    try:
        await asyncio.sleep(0.5)
        if not _api_market_data_generation_is_current(env, subscription_generation):
            return
        quote = env['extract_quote_snapshot'](ticker, getattr(qualified_underlying, 'secType', ''))

        if quote is not None:
            payload: ManualUnderlyingSyncPayload = {
                'underlyingPrice': quote['mark'],
                'underlyingQuote': quote,
                'options': {},
            }
            await env['send_message_safe'](websocket, json.dumps(payload))
    finally:
        cancel_mkt_data_if_unused(
            ticker,
            client_subscriptions=env['client_subscriptions'],
            ib=env['ib'],
            generic_ticks_by_con_id=env.setdefault('market_data_generic_ticks_by_con_id', {}),
        )


async def _handle_request_historical_bars(env, websocket, data, client_ip):
    raw_underlying = data.get('underlying')
    options_data = data.get('options', [])
    underlying_request = env['build_underlying_request'](raw_underlying, options_data)
    bar_size = str(data.get('barSize') or '1 day').strip() or '1 day'
    duration_str = str(data.get('durationStr') or '2 Y').strip() or '2 Y'
    use_rth = env['normalize_bool'](data.get('useRTH'), True)
    limit = env['coerce_positive_int'](data.get('limit'), 260)
    request_id = str(data.get('requestId') or '').strip()

    logging.info(
        f"Received historical bars request from {client_ip} "
        f"for {env['describe_contract_request'](underlying_request)} "
        f"barSize={bar_size} duration={duration_str} useRTH={use_rth} limit={limit}"
    )

    payload: HistoricalBarsResponsePayload | None = None
    ib_error_message = ''
    try:
        payload = await env['request_ib_historical_bars'](
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
            env['describe_contract_request'](underlying_request),
            exc,
        )

    if payload is None and bar_size == '1 day':
        fallback_symbol = env['normalize_symbol'](
            (underlying_request or {}).get('symbol')
            if isinstance(underlying_request, dict)
            else underlying_request
        )
        payload = env['historical_replay_service'].build_underlying_daily_bars_payload(
            fallback_symbol,
            limit=limit,
        )
        if payload is not None:
            payload['fallbackReason'] = ib_error_message or 'IB historical bars unavailable.'

    if payload is None:
        error_payload: HistoricalReplayErrorPayload = {
            'action': 'historical_bars_error',
            'requestId': request_id,
            'message': ib_error_message or (
                f"No historical bars were available for "
                f"{env['describe_contract_request'](underlying_request)}."
            ),
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    if request_id:
        payload['requestId'] = request_id
    await env['send_message_safe'](websocket, json.dumps(payload))


async def dispatch_client_message(env, websocket, data, client_ip='Unknown'):
    action = data.get('action')
    if action == 'request_historical_snapshot':
        await _handle_request_historical_snapshot(env, websocket, data, client_ip)
    elif action == 'subscribe':
        await _handle_subscribe(env, websocket, data, client_ip)
    elif action == 'subscribe_iv_term_structure':
        try:
            timeout_seconds = max(
                IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS_FLOOR,
                float(env.get(
                    'iv_term_structure_catalog_timeout_seconds',
                    IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS_DEFAULT,
                )),
            )
        except (TypeError, ValueError):
            timeout_seconds = IV_TERM_STRUCTURE_CATALOG_TIMEOUT_SECONDS_DEFAULT
        underlying = data.get('underlying') if isinstance(data.get('underlying'), dict) else {}
        option_template = data.get('optionTemplate') if isinstance(data.get('optionTemplate'), dict) else {}
        symbol = str(
            option_template.get('symbol')
            or underlying.get('symbol')
            or ''
        ).strip().upper()
        client_protocol_version = str(data.get('clientProtocolVersion') or '').strip()
        protocol_matches = client_protocol_version == IV_TERM_STRUCTURE_PROTOCOL_VERSION
        started_payload: IvTermStructureSyncStartedPayload = {
            **build_iv_term_structure_payload_evidence('catalog_request_accepted_no_quote_snapshot'),
            'action': 'iv_term_structure_sync_started',
            'symbol': symbol,
            'protocolVersion': IV_TERM_STRUCTURE_PROTOCOL_VERSION,
            'clientProtocolVersion': client_protocol_version,
            'catalogTimeoutSeconds': timeout_seconds,
            'accepted': protocol_matches,
            'message': (
                'IV term structure request accepted; resolving the underlying and option expiry catalog.'
                if protocol_matches else
                f'IV term structure protocol mismatch: client {client_protocol_version or "missing"}, '
                f'server {IV_TERM_STRUCTURE_PROTOCOL_VERSION}. Refresh the page and restart the backend.'
            ),
        }
        logging.info(
            "%s IV term structure request from %s for %s clientProtocol=%s serverProtocol=%s",
            'Accepted' if protocol_matches else 'Rejected',
            client_ip,
            symbol or '<missing>',
            client_protocol_version or '<missing>',
            IV_TERM_STRUCTURE_PROTOCOL_VERSION,
        )
        await env['send_message_safe'](websocket, json.dumps(started_payload))
        if not protocol_matches:
            return
        try:
            await asyncio.wait_for(
                env['handle_iv_term_structure_subscription'](websocket, client_ip, data),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            logging.warning(
                "IV term structure catalog resolution timed out for %s after %.1fs",
                symbol or '<missing>',
                timeout_seconds,
            )
            timeout_payload: IvTermStructureErrorPayload = {
                **build_iv_term_structure_payload_evidence('error_payload_no_quote_snapshot'),
                'action': 'iv_term_structure_error',
                'symbol': symbol,
                'message': (
                    f'IB contract/option-chain discovery timed out after {timeout_seconds:.0f}s. '
                    'Confirm market-data farm 2104 and sec-def farm 2158 are connected, '
                    'then retry with fewer option streams.'
                ),
            }
            await env['send_message_safe'](websocket, json.dumps(timeout_payload))
    elif action == 'request_ib_connection_status':
        await env['send_message_safe'](
            websocket,
            json.dumps(env['build_ib_connection_status_payload']()),
        )
    elif action == 'connect_ib':
        message = await env['ensure_ib_connect_task']()
        await env['send_message_safe'](
            websocket,
            json.dumps(env['build_ib_connection_status_payload'](message)),
        )
    elif action == 'reset_api_market_data_subscriptions':
        if data.get('confirmed') is not True:
            payload: ApiMarketDataResetPayload = {
                'action': 'api_market_data_subscriptions_reset',
                'success': False,
                'message': 'Explicit confirmation is required before clearing all API market-data subscriptions.',
            }
            await env['send_message_safe'](websocket, json.dumps(payload))
            return

        try:
            payload = await env['reset_all_api_market_data_subscriptions'](client_ip)
        except Exception as exc:
            logging.exception("Global API market-data subscription reset failed")
            payload = {
                'action': 'api_market_data_subscriptions_reset',
                'success': False,
                'message': f'Failed to clear all API market-data subscriptions: {exc}',
            }

        recipients = set(env['connected_clients'])
        recipients.add(websocket)
        await asyncio.gather(*(
            env['send_message_safe'](recipient, json.dumps(payload))
            for recipient in recipients
        ))
    elif action == 'sync_underlying':
        await _handle_sync_underlying(env, websocket, data, client_ip)
    elif action == 'request_historical_bars':
        await _handle_request_historical_bars(env, websocket, data, client_ip)
    elif action == 'request_discount_curve':
        resolver = env.get('get_discount_curve_snapshot')
        if not callable(resolver):
            await env['send_message_safe'](websocket, json.dumps({
                'action': 'discount_curve_snapshot',
                'status': 'unavailable',
                'error': 'This backend does not provide a discount curve.',
                'curve': None,
            }))
        else:
            payload = await resolver(data)
            await env['send_message_safe'](websocket, json.dumps(payload))
    elif action == 'request_portfolio_avg_cost_snapshot':
        logging.info(f"Received portfolio avg cost snapshot request from {client_ip}")
        env['send_portfolio_avg_cost_snapshot'](websocket)
    elif action == 'request_portfolio_positions_snapshot':
        logging.info(f"Received portfolio positions snapshot request from {client_ip}")
        env['send_portfolio_positions_snapshot'](websocket)
    elif action == 'request_managed_accounts_snapshot':
        logging.info(f"Received managed accounts snapshot request from {client_ip}")
        env['send_managed_accounts_snapshot'](websocket)
    elif action == 'request_active_hedge_orders_snapshot':
        logging.info(f"Received active hedge orders snapshot request from {client_ip}")
        await env['send_message_safe'](
            websocket,
            json.dumps(env['build_active_hedge_orders_snapshot'](websocket, data)),
        )
    elif action == 'request_active_combo_orders_snapshot':
        logging.info(f"Received active combo orders snapshot request from {client_ip}")
        await env['send_message_safe'](
            websocket,
            json.dumps(env['build_active_combo_orders_snapshot'](websocket, data)),
        )
    else:
        payload = await dispatch_execution_action(
            env,
            websocket,
            data,
            client_ip=client_ip,
        )
        if payload is not None:
            await env['send_message_safe'](websocket, json.dumps(payload))


async def handle_ws_client(env, websocket):
    client_ip = websocket.remote_address[0] if websocket.remote_address else 'Unknown'
    logging.info(f"Client connected: {client_ip}")
    env['connected_clients'].add(websocket)
    env['client_subscriptions'][websocket] = {}
    env['client_subscription_settings'][websocket] = {'greeks_enabled': False}
    env['send_portfolio_avg_cost_snapshot'](websocket)
    env['send_portfolio_positions_snapshot'](websocket)
    env['send_managed_accounts_snapshot'](websocket)

    try:
        async for message in websocket:
            # One malformed message or handler bug must not tear down the
            # session: a disconnect orphans live-order supervision, so the
            # loop only exits when the connection itself closes.
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                logging.warning(f"Ignoring malformed WebSocket message from {client_ip}")
                continue
            if not isinstance(data, dict):
                logging.warning(f"Ignoring non-object WebSocket message from {client_ip}")
                continue

            try:
                await dispatch_client_message(env, websocket, data, client_ip=client_ip)
            except ConnectionClosed:
                raise
            except Exception:
                logging.exception(
                    f"Error handling action {data.get('action')!r} from {client_ip}; connection kept alive"
                )
    except ConnectionClosed:
        pass
    finally:
        logging.info(f"Client disconnected: {client_ip}")
        await env['cancel_iv_term_structure_sync_task'](websocket)
        env['unsubscribe_client_safely'](websocket)
        purge_combo_order_tracking_for_websocket(
            websocket,
            env['combo_order_tracking_by_order_id'],
            env['combo_order_tracking_by_perm_id'],
            is_terminal_combo_tracking=env.get('is_terminal_combo_tracking'),
        )
        purge_hedge_order_tracking_for_websocket(
            websocket,
            iter_unique_hedge_order_trackings=env['iter_unique_hedge_order_trackings'],
            is_terminal_hedge_tracking=env['is_terminal_hedge_tracking'],
            hedge_order_tracking_by_order_id=env['hedge_order_tracking_by_order_id'],
            hedge_order_tracking_by_perm_id=env['hedge_order_tracking_by_perm_id'],
        )
        execution_engine = env['execution_engine']
        release_managed = (
            getattr(execution_engine, 'release_managed_for_websocket', None)
            or getattr(execution_engine, 'cancel_managed_for_websocket', None)
        )
        if callable(release_managed):
            release_managed(websocket)
        env['connected_clients'].discard(websocket)
        env['client_subscriptions'].pop(websocket, None)
        env['client_subscription_settings'].pop(websocket, None)


def build_ws_client_handler(env):
    async def _handler(websocket):
        await handle_ws_client(env, websocket)

    return _handler
