import asyncio
import json
import logging
from datetime import datetime
from typing import Any

from ib_async import Contract

from runtime_contracts import (
    IvTermStructureCatalogPatchPayload,
    IvTermStructureErrorPayload,
    IvTermStructureExpiryRowPayload,
    IvTermStructureOptionDescriptor,
    IvTermStructureSnapshotPayload,
    IvTermStructureSyncCompletePayload,
)
from iv_term_structure_service import (
    build_expiry_strike_selections,
    choose_trading_class,
    filter_expiry_rows,
)


def normalize_symbol(value: Any) -> str:
    return str(value or '').strip().upper()


def to_expiry(value: Any) -> str:
    return str(value or '').replace('-', '')


def to_strike(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def serialize_finite_number(raw_value: Any, digits: int = 4) -> float | None:
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return None
    if value != value:
        return None
    return round(value, digits)


def extract_contract_expiry(contract: Any) -> str:
    raw_value = str(getattr(contract, 'lastTradeDateOrContractMonth', '') or '').strip()
    return raw_value[:8] if len(raw_value) >= 8 else raw_value


def format_iv_term_structure_strike_token(value: Any) -> str:
    try:
        strike = float(value)
    except (TypeError, ValueError):
        return ''

    if strike != strike:
        return ''
    if strike.is_integer():
        return str(int(strike))
    return f"{strike:.4f}".rstrip('0').rstrip('.')


def build_iv_term_structure_sub_id(symbol: Any, expiry: Any, strike: Any, right: Any) -> str:
    return "__ivts__|{symbol}|{expiry}|{strike}|{right}".format(
        symbol=normalize_symbol(symbol) or 'UNKNOWN',
        expiry=str(expiry or '').strip() or 'UNKNOWN',
        strike=format_iv_term_structure_strike_token(strike) or 'UNKNOWN',
        right=normalize_symbol(right) or 'UNKNOWN',
    )


def filter_iv_term_structure_option_chains(option_chains, option_template):
    chains = list(option_chains or [])
    if not chains:
        return []

    template = option_template if isinstance(option_template, dict) else {}
    template_multiplier = str(template.get('multiplier') or '').strip()
    template_exchange = str(template.get('exchange') or '').strip().upper()
    template_trading_class = str(template.get('tradingClass') or template.get('trading_class') or '').strip().upper()

    if template_multiplier:
        multiplier_matches = [
            chain for chain in chains
            if str(getattr(chain, 'multiplier', '') or '').strip() == template_multiplier
        ]
        if multiplier_matches:
            chains = multiplier_matches

    if template_exchange:
        exchange_matches = [
            chain for chain in chains
            if str(getattr(chain, 'exchange', '') or '').strip().upper() == template_exchange
        ]
        if exchange_matches:
            chains = exchange_matches

    if template_trading_class:
        trading_class_matches = [
            chain for chain in chains
            if str(getattr(chain, 'tradingClass', '') or '').strip().upper() == template_trading_class
        ]
        if trading_class_matches:
            chains = trading_class_matches

    return chains


def merge_iv_term_structure_chain_fields(option_chains, option_template):
    chains = filter_iv_term_structure_option_chains(option_chains, option_template)
    expirations = set()
    strikes = set()
    chain_trading_classes = []

    for chain in chains:
        expirations.update(str(value or '').strip() for value in getattr(chain, 'expirations', []) or [])
        strikes.update(getattr(chain, 'strikes', []) or [])
        chain_trading_classes.append(str(getattr(chain, 'tradingClass', '') or '').strip())

    return {
        'chains': chains,
        'expirations': sorted(expirations),
        'strikes': sorted(strikes),
        'tradingClass': choose_trading_class(
            chain_trading_classes,
            requested_trading_class=(option_template or {}).get('tradingClass') or (option_template or {}).get('trading_class') or '',
        ),
    }


def resolve_iv_term_structure_secdef_exchange(option_template, underlying_request):
    template = option_template if isinstance(option_template, dict) else {}
    underlying = underlying_request if isinstance(underlying_request, dict) else {}
    option_sec_type = normalize_symbol(template.get('secType') or template.get('sec_type'))
    underlying_sec_type = normalize_symbol(underlying.get('secType') or underlying.get('sec_type'))

    if option_sec_type == 'FOP' or underlying_sec_type == 'FUT':
        return str(template.get('exchange') or underlying.get('exchange') or '').strip()

    return ''


async def fetch_iv_term_structure_contract_rows_for_expiry(
    env,
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
    probe = Contract(
        secType=option_sec_type,
        symbol=option_symbol,
        lastTradeDateOrContractMonth=str(expiry or '').strip(),
        exchange=option_exchange,
        currency=option_currency,
        multiplier=str(option_multiplier or ''),
    )
    if option_trading_class:
        probe.tradingClass = option_trading_class
    if qualified_underlying is not None and getattr(qualified_underlying, 'conId', None):
        probe.underConId = qualified_underlying.conId

    try:
        contract_details_list = await asyncio.wait_for(
            env['ib'].reqContractDetailsAsync(probe),
            timeout=max(0.5, float(timeout_seconds or 0.0)),
        )
    except asyncio.TimeoutError:
        logging.warning(
            "IV term structure contract-details lookup timed out for %s %s",
            normalize_symbol(option_symbol) or '<missing>',
            str(expiry or '').strip() or '<missing>',
        )
        return []
    except Exception as exc:
        logging.warning(
            "IV term structure contract-details lookup failed for %s %s: %s",
            normalize_symbol(option_symbol) or '<missing>',
            str(expiry or '').strip() or '<missing>',
            exc,
        )
        return []

    rows = []
    normalized_expiry = to_expiry(expiry)
    requested_under_con_id = getattr(qualified_underlying, 'conId', None)
    requested_multiplier = str(option_multiplier or '').strip()

    for detail in contract_details_list or []:
        candidate = getattr(detail, 'contract', None)
        if candidate is None:
            continue

        candidate_expiry = extract_contract_expiry(candidate)
        if normalized_expiry and candidate_expiry and candidate_expiry != normalized_expiry:
            continue

        candidate_under_con_id = getattr(candidate, 'underConId', None)
        if requested_under_con_id and candidate_under_con_id and candidate_under_con_id != requested_under_con_id:
            continue

        candidate_multiplier = str(getattr(candidate, 'multiplier', '') or '').strip()
        if requested_multiplier and candidate_multiplier and candidate_multiplier != requested_multiplier:
            continue

        strike = to_strike(getattr(candidate, 'strike', None))
        if strike is None:
            continue

        rows.append({
            'expiry': candidate_expiry or normalized_expiry,
            'strike': strike,
            'tradingClass': str(getattr(candidate, 'tradingClass', '') or '').strip(),
        })

    return rows


async def fetch_iv_term_structure_contract_rows_for_exact_strike(
    env,
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
    probe = Contract(
        secType=option_sec_type,
        symbol=option_symbol,
        lastTradeDateOrContractMonth=str(expiry or '').strip(),
        strike=float(strike),
        exchange=option_exchange,
        currency=option_currency,
        multiplier=str(option_multiplier or ''),
    )
    if option_trading_class:
        probe.tradingClass = option_trading_class
    if qualified_underlying is not None and getattr(qualified_underlying, 'conId', None):
        probe.underConId = qualified_underlying.conId

    try:
        contract_details_list = await asyncio.wait_for(
            env['ib'].reqContractDetailsAsync(probe),
            timeout=max(0.25, float(timeout_seconds or 0.0)),
        )
    except asyncio.TimeoutError:
        return []
    except Exception:
        return []

    rows = []
    normalized_expiry = to_expiry(expiry)
    requested_under_con_id = getattr(qualified_underlying, 'conId', None)
    requested_multiplier = str(option_multiplier or '').strip()

    for detail in contract_details_list or []:
        candidate = getattr(detail, 'contract', None)
        if candidate is None:
            continue

        candidate_expiry = extract_contract_expiry(candidate)
        if normalized_expiry and candidate_expiry and candidate_expiry != normalized_expiry:
            continue

        candidate_under_con_id = getattr(candidate, 'underConId', None)
        if requested_under_con_id and candidate_under_con_id and candidate_under_con_id != requested_under_con_id:
            continue

        candidate_multiplier = str(getattr(candidate, 'multiplier', '') or '').strip()
        if requested_multiplier and candidate_multiplier and candidate_multiplier != requested_multiplier:
            continue

        candidate_strike = to_strike(getattr(candidate, 'strike', None))
        if candidate_strike is None or serialize_finite_number(candidate_strike) != serialize_finite_number(strike):
            continue

        rows.append({
            'expiry': candidate_expiry or normalized_expiry,
            'strike': candidate_strike,
            'tradingClass': str(getattr(candidate, 'tradingClass', '') or '').strip(),
        })

    return rows


async def resolve_iv_term_structure_expiry_selection_from_candidates(
    env,
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
    normalized_candidates = []
    seen = set()
    for raw_strike in candidate_strikes or []:
        strike = to_strike(raw_strike)
        serialized = serialize_finite_number(strike)
        if serialized is None or serialized in seen:
            continue
        seen.add(serialized)
        normalized_candidates.append(serialized)

    if not normalized_candidates:
        return {}

    normalized_candidates.sort()
    try:
        target_price = float(underlying_price)
    except (TypeError, ValueError):
        return {}
    if not (target_price == target_price):
        return {}

    nearest_index = min(
        range(len(normalized_candidates)),
        key=lambda index: (abs(normalized_candidates[index] - target_price), normalized_candidates[index]),
    )
    search_indices = []
    for offset in range(len(normalized_candidates)):
        left_index = nearest_index - offset
        right_index = nearest_index + offset
        if left_index >= 0 and left_index not in search_indices:
            search_indices.append(left_index)
        if offset and right_index < len(normalized_candidates) and right_index not in search_indices:
            search_indices.append(right_index)

    probe_cache = {}

    async def probe_index(index):
        if index not in probe_cache:
            probe_cache[index] = await fetch_iv_term_structure_contract_rows_for_exact_strike(
                env,
                option_symbol,
                option_sec_type,
                option_exchange,
                option_currency,
                option_multiplier,
                expiry,
                normalized_candidates[index],
                option_trading_class=option_trading_class,
                qualified_underlying=qualified_underlying,
            )
        return probe_cache[index]

    atm_index = None
    for index in search_indices:
        rows = await probe_index(index)
        if rows:
            atm_index = index
            break

    if atm_index is None:
        return {}

    selected_indices = [atm_index]
    safe_radius = max(0, int(strike_radius or 0))

    lower_index = atm_index - 1
    while lower_index >= 0 and len([idx for idx in selected_indices if idx < atm_index]) < safe_radius:
        rows = await probe_index(lower_index)
        if rows:
            selected_indices.append(lower_index)
        lower_index -= 1

    upper_index = atm_index + 1
    while upper_index < len(normalized_candidates) and len([idx for idx in selected_indices if idx > atm_index]) < safe_radius:
        rows = await probe_index(upper_index)
        if rows:
            selected_indices.append(upper_index)
        upper_index += 1

    selected_indices = sorted(set(selected_indices))
    selected_rows = []
    for index in selected_indices:
        selected_rows.extend(await probe_index(index))

    return {
        'atm_strike': normalized_candidates[atm_index],
        'window_strikes': [normalized_candidates[index] for index in selected_indices],
        'tradingClass': choose_trading_class(
            [row.get('tradingClass') for row in selected_rows],
            option_trading_class,
        ),
    }


def build_iv_term_structure_expiry_bundle(
    expiry_row,
    option_symbol,
    option_sec_type,
    option_exchange,
    option_currency,
    option_multiplier,
    underlying_symbol,
    underlying_exchange,
    fallback_trading_class,
    expiry_selection=None,
):
    expiry = str((expiry_row or {}).get('expiry') or '').strip()
    dte = int((expiry_row or {}).get('dte') or 0)
    selection = expiry_selection if isinstance(expiry_selection, dict) else {}
    atm_strike = serialize_finite_number(selection.get('atm_strike'))
    window_strikes = selection.get('window_strikes') if isinstance(selection.get('window_strikes'), (list, tuple)) else []
    expiry_trading_class = (
        str(selection.get('tradingClass') or '').strip()
        or str(fallback_trading_class or '').strip()
    )

    atm_call_sub_id = build_iv_term_structure_sub_id(option_symbol, expiry, atm_strike, 'C') if atm_strike is not None else ''
    atm_put_sub_id = build_iv_term_structure_sub_id(option_symbol, expiry, atm_strike, 'P') if atm_strike is not None else ''

    expiry_payload_row: IvTermStructureExpiryRowPayload = {
        'expiry': expiry,
        'dte': dte,
        'atmStrike': atm_strike,
        'atmCallSubId': atm_call_sub_id,
        'atmPutSubId': atm_put_sub_id,
    }

    option_descriptors: dict[str, IvTermStructureOptionDescriptor] = {}
    option_requests = []

    if expiry and atm_strike is not None and window_strikes:
        for strike in window_strikes:
            serialized_strike = serialize_finite_number(strike)
            if serialized_strike is None:
                continue

            for right in ('C', 'P'):
                sub_id = build_iv_term_structure_sub_id(option_symbol, expiry, serialized_strike, right)
                option_request = {
                    'id': sub_id,
                    'secType': option_sec_type,
                    'symbol': option_symbol,
                    'underlyingSymbol': underlying_symbol,
                    'exchange': option_exchange,
                    'underlyingExchange': underlying_exchange,
                    'currency': option_currency,
                    'multiplier': option_multiplier,
                    'tradingClass': expiry_trading_class,
                    'right': right,
                    'strike': serialized_strike,
                    'expDate': expiry,
                    'contractMonth': expiry[:6],
                }
                option_descriptors[sub_id] = {
                    'expiry': expiry,
                    'dte': dte,
                    'strike': serialized_strike,
                    'right': right,
                    'isAtm': serialized_strike == atm_strike,
                }
                option_requests.append(option_request)

    return {
        'expiryPayloadRow': expiry_payload_row,
        'optionDescriptors': option_descriptors,
        'optionRequests': option_requests,
    }


def prioritize_iv_term_structure_expiry_rows(expiry_rows, bucket_definitions):
    rows = [row for row in (expiry_rows or []) if isinstance(row, dict)]
    if not rows:
        return []

    prioritized = []
    seen_expiries = set()

    for bucket in bucket_definitions or []:
        target_days = int((bucket or {}).get('targetDays') or 0)
        best_row = None
        best_key = None
        for row in rows:
            expiry = str(row.get('expiry') or '').strip()
            if not expiry or expiry in seen_expiries:
                continue
            dte = int(row.get('dte') or 0)
            row_key = (abs(dte - target_days), dte, expiry)
            if best_key is None or row_key < best_key:
                best_key = row_key
                best_row = row
        if best_row is not None:
            expiry = str(best_row.get('expiry') or '').strip()
            seen_expiries.add(expiry)
            prioritized.append(best_row)

    for row in rows:
        expiry = str(row.get('expiry') or '').strip()
        if not expiry or expiry in seen_expiries:
            continue
        seen_expiries.add(expiry)
        prioritized.append(row)

    return prioritized


async def subscribe_iv_term_structure_option_request(env, websocket, option_request):
    sub_id = option_request.get('id')
    try:
        option_contract = env['build_contract_from_request'](option_request)
    except Exception as exc:
        logging.warning(
            "Skipping IV term structure option %s because the contract request was invalid: %s",
            sub_id or '<missing>',
            exc,
        )
        return False

    qualified_option = await env['qualify_one'](option_contract, option_request)
    if qualified_option is None:
        return False

    option_ticker = env['ib'].reqMktData(qualified_option, '106', False, False)
    if websocket not in env['client_subscriptions']:
        env['ib'].cancelMktData(option_ticker.contract)
        return False

    env['client_subscriptions'][websocket][sub_id] = option_ticker
    return True


def track_iv_term_structure_sync_task(env, websocket, task):
    sync_tasks = env['iv_term_structure_sync_tasks']
    sync_tasks[websocket] = task

    def _clear(done_task):
        current = sync_tasks.get(websocket)
        if current is done_task:
            sync_tasks.pop(websocket, None)
        try:
            done_task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logging.exception("IV term structure background sync task failed")

    task.add_done_callback(_clear)


async def cancel_iv_term_structure_sync_task(env, websocket):
    sync_tasks = env['iv_term_structure_sync_tasks']
    task = sync_tasks.pop(websocket, None)
    if task is None:
        return
    if task.done():
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logging.exception("IV term structure background sync task failed")
        return

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        logging.exception("IV term structure background sync task failed during cancellation")


async def run_iv_term_structure_option_sync(env, websocket, symbol, sync_context):
    subscribed_option_count = 0
    expected_option_count = 0

    try:
        expiry_rows = []
        option_symbol = normalize_symbol(symbol)
        option_sec_type = 'OPT'
        option_exchange = 'SMART'
        option_currency = 'USD'
        option_multiplier = '100'
        underlying_symbol = option_symbol
        underlying_exchange = 'SMART'
        option_trading_class = ''
        qualified_underlying = None
        underlying_price = None
        strike_radius = env['iv_term_structure_default_strike_radius']
        global_candidate_strikes = []

        if isinstance(sync_context, dict):
            expiry_rows = list(sync_context.get('expiryRows') or [])
            option_symbol = normalize_symbol(sync_context.get('optionSymbol') or symbol)
            option_sec_type = normalize_symbol(sync_context.get('optionSecType') or 'OPT')
            option_exchange = str(sync_context.get('optionExchange') or 'SMART').strip() or 'SMART'
            option_currency = str(sync_context.get('optionCurrency') or 'USD').strip() or 'USD'
            option_multiplier = str(sync_context.get('optionMultiplier') or '100').strip() or '100'
            underlying_symbol = normalize_symbol(sync_context.get('underlyingSymbol') or option_symbol)
            underlying_exchange = str(sync_context.get('underlyingExchange') or option_exchange).strip() or option_exchange
            option_trading_class = str(sync_context.get('optionTradingClass') or '').strip()
            qualified_underlying = sync_context.get('qualifiedUnderlying')
            underlying_price = sync_context.get('underlyingPrice')
            strike_radius = env['coerce_positive_int'](
                sync_context.get('strikeRadius'),
                env['iv_term_structure_default_strike_radius'],
            )
            global_candidate_strikes = list(sync_context.get('globalCandidateStrikes') or [])

        prioritized_expiry_rows = prioritize_iv_term_structure_expiry_rows(
            expiry_rows,
            env['iv_term_structure_bucket_definitions'],
        )
        resolved_expiry_count = 0
        total_expiry_count = len(prioritized_expiry_rows)
        progress_lock = asyncio.Lock()
        concurrency_limit = min(6, max(1, total_expiry_count))
        semaphore = asyncio.Semaphore(concurrency_limit)

        async def process_expiry(expiry_row):
            nonlocal resolved_expiry_count
            nonlocal expected_option_count
            nonlocal subscribed_option_count

            if websocket not in env['client_subscriptions']:
                return

            expiry = str((expiry_row or {}).get('expiry') or '').strip()
            if not expiry:
                return

            try:
                async with semaphore:
                    expiry_contract_rows = await fetch_iv_term_structure_contract_rows_for_expiry(
                        env,
                        option_symbol,
                        option_sec_type,
                        option_exchange,
                        option_currency,
                        option_multiplier,
                        expiry,
                        option_trading_class=option_trading_class,
                        qualified_underlying=qualified_underlying,
                    )
                expiry_selection = build_expiry_strike_selections(
                    expiry_contract_rows,
                    underlying_price,
                    strike_radius,
                ).get(expiry) or {}
                if not expiry_selection.get('atm_strike'):
                    expiry_selection = await resolve_iv_term_structure_expiry_selection_from_candidates(
                        env,
                        option_symbol,
                        option_sec_type,
                        option_exchange,
                        option_currency,
                        option_multiplier,
                        expiry,
                        underlying_price,
                        global_candidate_strikes,
                        strike_radius,
                        option_trading_class=option_trading_class,
                        qualified_underlying=qualified_underlying,
                    )
                bundle = build_iv_term_structure_expiry_bundle(
                    expiry_row,
                    option_symbol,
                    option_sec_type,
                    option_exchange,
                    option_currency,
                    option_multiplier,
                    underlying_symbol,
                    underlying_exchange,
                    option_trading_class,
                    expiry_selection=expiry_selection,
                )
                option_requests = bundle.get('optionRequests') or []

                async with progress_lock:
                    resolved_expiry_count += 1
                    expected_option_count += len(option_requests)
                    resolved_count = resolved_expiry_count
                    expected_count = expected_option_count
                    subscribed_count = subscribed_option_count

                patch_payload: IvTermStructureCatalogPatchPayload = {
                    'action': 'iv_term_structure_catalog_patch',
                    'symbol': option_symbol,
                    'expiryRows': [bundle.get('expiryPayloadRow') or {}],
                    'optionDescriptors': bundle.get('optionDescriptors') or {},
                    'resolvedExpiryCount': resolved_count,
                    'totalExpiryCount': total_expiry_count,
                    'subscribedOptionCount': subscribed_count,
                    'expectedOptionCount': expected_count,
                    'subscriptionPending': resolved_count < total_expiry_count,
                }
                await env['send_message_safe'](websocket, json.dumps(patch_payload))

                local_subscribed = 0
                for option_request in option_requests:
                    if websocket not in env['client_subscriptions']:
                        break
                    if await subscribe_iv_term_structure_option_request(env, websocket, option_request):
                        local_subscribed += 1

                if local_subscribed:
                    async with progress_lock:
                        subscribed_option_count += local_subscribed
                        resolved_count = resolved_expiry_count
                        expected_count = expected_option_count
                        subscribed_count = subscribed_option_count
                    patch_payload = {
                        'action': 'iv_term_structure_catalog_patch',
                        'symbol': option_symbol,
                        'expiryRows': [],
                        'optionDescriptors': {},
                        'resolvedExpiryCount': resolved_count,
                        'totalExpiryCount': total_expiry_count,
                        'subscribedOptionCount': subscribed_count,
                        'expectedOptionCount': expected_count,
                        'subscriptionPending': resolved_count < total_expiry_count,
                    }
                    await env['send_message_safe'](websocket, json.dumps(patch_payload))
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.exception(
                    "IV term structure expiry worker failed for %s %s",
                    option_symbol or '<missing>',
                    expiry or '<missing>',
                )

        if prioritized_expiry_rows:
            await asyncio.gather(*(process_expiry(expiry_row) for expiry_row in prioritized_expiry_rows))

        complete_payload: IvTermStructureSyncCompletePayload = {
            'action': 'iv_term_structure_sync_complete',
            'symbol': option_symbol,
            'subscribedOptionCount': subscribed_option_count,
            'expectedOptionCount': expected_option_count,
        }
        await env['send_message_safe'](websocket, json.dumps(complete_payload))
    except asyncio.CancelledError:
        logging.info(
            "Cancelled IV term structure background sync for %s",
            normalize_symbol(symbol) or '<missing>',
        )
        raise
    except Exception as exc:
        logging.exception(
            "IV term structure background sync failed for %s",
            normalize_symbol(symbol) or '<missing>',
        )
        error_payload: IvTermStructureErrorPayload = {
            'action': 'iv_term_structure_error',
            'symbol': normalize_symbol(symbol),
            'message': f'Background IV option subscription failed: {exc}',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))


async def handle_iv_term_structure_subscription(env, websocket, client_ip, data):
    if not env['ib'].isConnected():
        error_payload: IvTermStructureErrorPayload = {
            'action': 'iv_term_structure_error',
            'symbol': normalize_symbol((data.get('underlying') or {}).get('symbol')),
            'message': 'IB is not connected.',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    raw_underlying = data.get('underlying')
    underlying_request = env['build_underlying_request'](raw_underlying, [])
    option_template = data.get('optionTemplate') if isinstance(data.get('optionTemplate'), dict) else {}
    max_dte = env['coerce_positive_int'](data.get('maxDte'), env['iv_term_structure_default_max_dte'])
    strike_radius = env['coerce_positive_int'](data.get('strikeRadius'), env['iv_term_structure_default_strike_radius'])
    anchor_date = env['normalize_replay_date'](data.get('anchorDate')) or datetime.utcnow().strftime('%Y-%m-%d')

    underlying_symbol = normalize_symbol(
        option_template.get('underlyingSymbol')
        or (underlying_request or {}).get('symbol')
        or option_template.get('symbol')
    )

    logging.info(
        "Received IV term structure subscription request from %s for %s maxDte=%s strikeRadius=%s",
        client_ip,
        underlying_symbol or '<missing>',
        max_dte,
        strike_radius,
    )

    try:
        underlying_contract = env['build_contract_from_request'](underlying_request)
    except Exception as exc:
        error_payload = {
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': f'Invalid underlying request: {exc}',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    await cancel_iv_term_structure_sync_task(env, websocket)
    env['unsubscribe_client_safely'](websocket)
    env['get_client_subscription_settings'](websocket)['greeks_enabled'] = False

    qualified_underlying = await env['qualify_one'](underlying_contract, underlying_request)
    if qualified_underlying is None:
        error_payload = {
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': f'Failed to qualify underlying {env["describe_contract_request"](underlying_request)}.',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    underlying_ticker = env['ib'].reqMktData(qualified_underlying, '', False, False)
    env['client_subscriptions'][websocket]['underlying'] = underlying_ticker
    await asyncio.sleep(0.75)
    underlying_quote = env['extract_quote_snapshot'](underlying_ticker, getattr(qualified_underlying, 'secType', ''))
    underlying_price = None if underlying_quote is None else underlying_quote.get('mark')

    if underlying_price is None:
        error_payload = {
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': f'No live underlying quote is available yet for {underlying_symbol or "the requested symbol"}.',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    request_option_chains = getattr(env['ib'], 'reqSecDefOptParamsAsync', None)
    if not callable(request_option_chains):
        error_payload = {
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': 'The current ib_async build does not expose reqSecDefOptParamsAsync.',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    fut_fop_exchange = resolve_iv_term_structure_secdef_exchange(option_template, underlying_request)
    option_chains = await request_option_chains(
        underlying_symbol,
        fut_fop_exchange,
        normalize_symbol(getattr(qualified_underlying, 'secType', '') or (underlying_request or {}).get('secType')),
        getattr(qualified_underlying, 'conId', 0),
    )
    merged_chain_fields = merge_iv_term_structure_chain_fields(option_chains, option_template)
    expiry_rows = filter_expiry_rows(
        merged_chain_fields['expirations'],
        anchor_date,
        max_dte,
    )
    expiry_payload_rows = []
    option_descriptors = {}

    option_symbol = normalize_symbol(option_template.get('symbol') or underlying_symbol)
    option_sec_type = normalize_symbol(option_template.get('secType') or option_template.get('sec_type') or 'OPT')
    option_exchange = option_template.get('exchange') or 'SMART'
    option_currency = option_template.get('currency') or (underlying_request or {}).get('currency') or 'USD'
    option_multiplier = str(option_template.get('multiplier') or '100')
    option_trading_class = merged_chain_fields.get('tradingClass') or option_template.get('tradingClass') or option_template.get('trading_class') or ''
    underlying_exchange = option_template.get('underlyingExchange') or (underlying_request or {}).get('exchange') or option_exchange

    for expiry_row in expiry_rows:
        bundle = build_iv_term_structure_expiry_bundle(
            expiry_row,
            option_symbol,
            option_sec_type,
            option_exchange,
            option_currency,
            option_multiplier,
            underlying_symbol,
            underlying_exchange,
            option_trading_class,
            expiry_selection={},
        )
        expiry_payload_rows.append(bundle['expiryPayloadRow'])

    payload: IvTermStructureSnapshotPayload = {
        'action': 'iv_term_structure_snapshot',
        'symbol': option_symbol,
        'anchorDate': anchor_date,
        'maxDte': max_dte,
        'strikeRadius': strike_radius,
        'underlyingPrice': underlying_price,
        'underlyingQuote': underlying_quote,
        'expiryRows': expiry_payload_rows,
        'optionDescriptors': option_descriptors,
        'subscribedOptionCount': 0,
        'expectedOptionCount': 0,
        'subscriptionPending': bool(expiry_payload_rows),
    }
    if not expiry_payload_rows:
        payload['warning'] = f'No option expiries were available within {max_dte} calendar days.'

    await env['send_message_safe'](websocket, json.dumps(payload))
    if expiry_payload_rows:
        task = asyncio.create_task(
            run_iv_term_structure_option_sync(env, websocket, option_symbol, {
                'expiryRows': expiry_rows,
                'optionSymbol': option_symbol,
                'optionSecType': option_sec_type,
                'optionExchange': option_exchange,
                'optionCurrency': option_currency,
                'optionMultiplier': option_multiplier,
                'underlyingSymbol': underlying_symbol,
                'underlyingExchange': underlying_exchange,
                'optionTradingClass': option_trading_class,
                'qualifiedUnderlying': qualified_underlying,
                'underlyingPrice': underlying_price,
                'strikeRadius': strike_radius,
                'globalCandidateStrikes': merged_chain_fields.get('strikes') or [],
            })
        )
        track_iv_term_structure_sync_task(env, websocket, task)
