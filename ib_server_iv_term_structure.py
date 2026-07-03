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
    pick_strike_window,
)


def normalize_symbol(value: Any) -> str:
    return str(value or '').strip().upper()


def to_expiry(value: Any) -> str:
    return str(value or '').replace('-', '')


def to_contract_month(value: Any) -> str:
    normalized = ''.join(ch for ch in str(value or '').strip() if ch.isdigit())
    return normalized[:6] if len(normalized) >= 6 else ''


def shift_contract_month(contract_month: Any, delta_months: int) -> str:
    normalized = to_contract_month(contract_month)
    if not normalized:
        return ''

    try:
        year = int(normalized[:4])
        month = int(normalized[4:6])
    except ValueError:
        return ''
    if month < 1 or month > 12:
        return ''

    zero_indexed = (year * 12) + (month - 1) + int(delta_months or 0)
    shifted_year = zero_indexed // 12
    shifted_month = (zero_indexed % 12) + 1
    return f'{shifted_year}{shifted_month:02d}'


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
    template_sec_type = normalize_symbol(template.get('secType') or template.get('sec_type'))
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

    if template_trading_class and template_sec_type != 'FOP':
        trading_class_matches = [
            chain for chain in chains
            if str(getattr(chain, 'tradingClass', '') or '').strip().upper() == template_trading_class
        ]
        if trading_class_matches:
            chains = trading_class_matches

    return chains


def merge_iv_term_structure_chain_fields(option_chains, option_template):
    template = option_template if isinstance(option_template, dict) else {}
    template_sec_type = normalize_symbol(template.get('secType') or template.get('sec_type'))
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
            requested_trading_class=''
            if template_sec_type == 'FOP'
            else (template.get('tradingClass') or template.get('trading_class') or ''),
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


async def resolve_iv_term_structure_common_selections_from_candidates(
    env,
    option_symbol,
    option_sec_type,
    option_exchange,
    option_currency,
    option_multiplier,
    expiry_rows,
    underlying_price,
    candidate_strikes,
    strike_radius,
    option_trading_class='',
    qualified_underlying=None,
):
    expiries = []
    seen_expiries = set()
    for expiry_row in expiry_rows or []:
        expiry = str((expiry_row or {}).get('expiry') or '').strip()
        if not expiry or expiry in seen_expiries:
            continue
        seen_expiries.add(expiry)
        expiries.append(expiry)

    if not expiries:
        return {}

    normalized_candidates = []
    seen_strikes = set()
    for raw_strike in candidate_strikes or []:
        strike = to_strike(raw_strike)
        serialized = serialize_finite_number(strike)
        if serialized is None or serialized in seen_strikes:
            continue
        seen_strikes.add(serialized)
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
    probe_semaphore = asyncio.Semaphore(8)

    async def probe_expiry_index(expiry, index):
        cache_key = (expiry, index)
        if cache_key not in probe_cache:
            async with probe_semaphore:
                probe_cache[cache_key] = await fetch_iv_term_structure_contract_rows_for_exact_strike(
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
        return probe_cache[cache_key]

    async def rows_by_expiry_for_index(index):
        rows_by_expiry = {}
        results = await asyncio.gather(*(probe_expiry_index(expiry, index) for expiry in expiries))
        for expiry, rows in zip(expiries, results):
            if rows:
                rows_by_expiry[expiry] = rows
        return rows_by_expiry

    safe_radius = max(0, int(strike_radius or 0))
    max_probe_count = min(len(search_indices), max(25, (safe_radius * 2 + 1) * 10))
    atm_index = None
    atm_rows_by_expiry = {}
    for index in search_indices[:max_probe_count]:
        rows_by_expiry = await rows_by_expiry_for_index(index)
        if not rows_by_expiry:
            continue

        current_key = (
            -len(rows_by_expiry),
            abs(normalized_candidates[index] - target_price),
            normalized_candidates[index],
        )
        best_key = (
            -len(atm_rows_by_expiry),
            abs(normalized_candidates[atm_index] - target_price) if atm_index is not None else float('inf'),
            normalized_candidates[atm_index] if atm_index is not None else float('inf'),
        )
        if atm_index is None or current_key < best_key:
            atm_index = index
            atm_rows_by_expiry = rows_by_expiry
            if len(atm_rows_by_expiry) == len(expiries):
                break

    if atm_index is None:
        return {}

    selected_indices = [atm_index]
    rows_by_index_and_expiry = {atm_index: atm_rows_by_expiry}

    lower_index = atm_index - 1
    while lower_index >= 0 and len([idx for idx in selected_indices if idx < atm_index]) < safe_radius:
        rows_by_expiry = await rows_by_expiry_for_index(lower_index)
        if rows_by_expiry:
            selected_indices.append(lower_index)
            rows_by_index_and_expiry[lower_index] = rows_by_expiry
        lower_index -= 1

    upper_index = atm_index + 1
    while upper_index < len(normalized_candidates) and len([idx for idx in selected_indices if idx > atm_index]) < safe_radius:
        rows_by_expiry = await rows_by_expiry_for_index(upper_index)
        if rows_by_expiry:
            selected_indices.append(upper_index)
            rows_by_index_and_expiry[upper_index] = rows_by_expiry
        upper_index += 1

    selected_indices = sorted(set(selected_indices))
    selections = {}
    for expiry in expiries:
        if expiry not in atm_rows_by_expiry:
            selections[expiry] = {
                'atm_strike': None,
                'window_strikes': [],
                'tradingClass': option_trading_class,
            }
            continue

        selected_rows = []
        expiry_window_strikes = []
        for index in selected_indices:
            rows = rows_by_index_and_expiry.get(index, {}).get(expiry) or []
            if rows:
                selected_rows.extend(rows)
                expiry_window_strikes.append(normalized_candidates[index])
        selections[expiry] = {
            'atm_strike': normalized_candidates[atm_index],
            'window_strikes': expiry_window_strikes,
            'tradingClass': choose_trading_class(
                [row.get('tradingClass') for row in selected_rows],
                option_trading_class,
            ),
        }

    return selections


def build_iv_term_structure_global_candidate_selections(
    expiry_rows,
    underlying_price,
    candidate_strikes,
    strike_radius,
    option_trading_class='',
):
    strike_window = pick_strike_window(candidate_strikes, underlying_price, strike_radius)
    atm_strike = serialize_finite_number(strike_window.get('atm_strike'))
    if atm_strike is None:
        return {}

    selections = {}
    for expiry_row in expiry_rows or []:
        expiry = str((expiry_row or {}).get('expiry') or '').strip()
        if not expiry:
            continue
        selections[expiry] = {
            'atm_strike': atm_strike,
            'window_strikes': [atm_strike],
            'tradingClass': option_trading_class,
        }

    return selections


def choose_iv_term_structure_shared_atm_strike(expiry_selections, underlying_price):
    coverage_by_strike = {}
    for selection in (expiry_selections or {}).values():
        serialized = serialize_finite_number((selection or {}).get('atm_strike'))
        if serialized is None:
            continue
        coverage_by_strike[serialized] = coverage_by_strike.get(serialized, 0) + 1

    if not coverage_by_strike:
        return None

    try:
        target_price = float(underlying_price)
    except (TypeError, ValueError):
        target_price = None

    return min(
        coverage_by_strike,
        key=lambda strike: (
            -coverage_by_strike[strike],
            abs(strike - target_price) if target_price is not None and target_price == target_price else 0,
            strike,
        ),
    )


def expand_iv_term_structure_shared_atm_to_all_expiries(
    expiry_rows,
    expiry_selections,
    shared_atm_strike,
    option_trading_class='',
):
    atm_strike = serialize_finite_number(shared_atm_strike)
    if atm_strike is None:
        return expiry_selections if isinstance(expiry_selections, dict) else {}

    existing = expiry_selections if isinstance(expiry_selections, dict) else {}
    expanded = {}
    for expiry_row in expiry_rows or []:
        expiry = str((expiry_row or {}).get('expiry') or '').strip()
        if not expiry:
            continue

        current = existing.get(expiry) if isinstance(existing.get(expiry), dict) else {}
        expanded[expiry] = {
            'atm_strike': atm_strike,
            'window_strikes': [atm_strike],
            'tradingClass': str(current.get('tradingClass') or option_trading_class or '').strip(),
        }

    return expanded


def build_iv_term_structure_expiry_bundle(
    expiry_row,
    option_symbol,
    option_sec_type,
    option_exchange,
    option_currency,
    option_multiplier,
    underlying_symbol,
    underlying_exchange,
    fallback_trading_class='',
    underlying_contract_month='',
    underlying_currency='',
    underlying_multiplier='',
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
                if underlying_contract_month:
                    option_request['underlyingContractMonth'] = underlying_contract_month
                if underlying_currency:
                    option_request['underlyingCurrency'] = underlying_currency
                if underlying_multiplier:
                    option_request['underlyingMultiplier'] = str(underlying_multiplier)
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
        underlying_contract_month = ''
        underlying_currency = 'USD'
        underlying_multiplier = ''
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
            underlying_contract_month = to_contract_month(sync_context.get('underlyingContractMonth'))
            underlying_currency = str(sync_context.get('underlyingCurrency') or option_currency).strip() or option_currency
            underlying_multiplier = str(sync_context.get('underlyingMultiplier') or option_multiplier).strip()
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
        contract_lookup_count = 0
        progress_lock = asyncio.Lock()
        concurrency_limit = min(6, max(1, total_expiry_count))
        semaphore = asyncio.Semaphore(concurrency_limit)
        contract_rows_by_expiry = {}

        async def send_sync_progress(message, lookup_count=None):
            patch_payload: IvTermStructureCatalogPatchPayload = {
                'action': 'iv_term_structure_catalog_patch',
                'symbol': option_symbol,
                'expiryRows': [],
                'optionDescriptors': {},
                'resolvedExpiryCount': int(lookup_count or 0),
                'totalExpiryCount': total_expiry_count,
                'subscribedOptionCount': subscribed_option_count,
                'expectedOptionCount': expected_option_count,
                'subscriptionPending': True,
            }
            normalized_message = str(message or '').strip()
            if normalized_message:
                patch_payload['message'] = normalized_message
            await env['send_message_safe'](websocket, json.dumps(patch_payload))

        async def fetch_expiry_contract_rows(expiry_row):
            nonlocal contract_lookup_count

            expiry = str((expiry_row or {}).get('expiry') or '').strip()
            if not expiry or websocket not in env['client_subscriptions']:
                return expiry, []

            rows = []
            try:
                async with semaphore:
                    rows = await fetch_iv_term_structure_contract_rows_for_expiry(
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
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.exception(
                    "IV term structure contract-row fetch failed for %s %s",
                    option_symbol or '<missing>',
                    expiry or '<missing>',
                )

            async with progress_lock:
                contract_lookup_count += 1
                lookup_count = contract_lookup_count
            await send_sync_progress(
                f'Resolved option-chain details for {lookup_count} of {total_expiry_count} expiries. Selecting shared ATM strike...',
                lookup_count=lookup_count,
            )
            return expiry, rows

        if prioritized_expiry_rows:
            await send_sync_progress(
                f'Resolving option-chain details for {total_expiry_count} expiries before selecting a shared ATM strike...',
                lookup_count=0,
            )
            fetch_results = await asyncio.gather(
                *(fetch_expiry_contract_rows(expiry_row) for expiry_row in prioritized_expiry_rows)
            )
            contract_rows_by_expiry = {
                expiry: rows
                for expiry, rows in fetch_results
                if expiry
            }

        all_contract_rows = []
        for rows in contract_rows_by_expiry.values():
            all_contract_rows.extend(rows or [])

        expiry_selections = build_expiry_strike_selections(
            all_contract_rows,
            underlying_price,
            strike_radius,
        )

        has_selected_atm = any(
            (selection or {}).get('atm_strike') is not None
            for selection in expiry_selections.values()
        )
        if has_selected_atm:
            shared_atm_strike = choose_iv_term_structure_shared_atm_strike(
                expiry_selections,
                underlying_price,
            )
            expiry_selections = expand_iv_term_structure_shared_atm_to_all_expiries(
                prioritized_expiry_rows,
            expiry_selections,
            shared_atm_strike,
            option_trading_class=option_trading_class,
        )
        if not has_selected_atm:
            expiry_selections = build_iv_term_structure_global_candidate_selections(
                prioritized_expiry_rows,
                underlying_price,
                global_candidate_strikes,
                strike_radius,
                option_trading_class=option_trading_class,
            )
            has_selected_atm = any(
                (selection or {}).get('atm_strike') is not None
                for selection in expiry_selections.values()
            )
            if not has_selected_atm:
                await send_sync_progress(
                    'The option-chain strike list did not produce a usable ATM window. Probing exact contracts near the underlying price...',
                    lookup_count=contract_lookup_count,
                )
                fallback_selections = await resolve_iv_term_structure_common_selections_from_candidates(
                    env,
                    option_symbol,
                    option_sec_type,
                    option_exchange,
                    option_currency,
                    option_multiplier,
                    prioritized_expiry_rows,
                    underlying_price,
                    global_candidate_strikes,
                    strike_radius,
                    option_trading_class=option_trading_class,
                    qualified_underlying=qualified_underlying,
                )
                if fallback_selections:
                    expiry_selections = fallback_selections
                    shared_atm_strike = choose_iv_term_structure_shared_atm_strike(
                        expiry_selections,
                        underlying_price,
                    )
                    expiry_selections = expand_iv_term_structure_shared_atm_to_all_expiries(
                        prioritized_expiry_rows,
                        expiry_selections,
                        shared_atm_strike,
                        option_trading_class=option_trading_class,
                    )

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
                expiry_selection = expiry_selections.get(expiry) or {}
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
                    underlying_contract_month=underlying_contract_month,
                    underlying_currency=underlying_currency,
                    underlying_multiplier=underlying_multiplier,
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
    underlying_contract_month = to_contract_month(
        option_template.get('underlyingContractMonth')
        or (underlying_request or {}).get('contractMonth')
    )
    underlying_sec_type = normalize_symbol((underlying_request or {}).get('secType') or (underlying_request or {}).get('sec_type'))
    underlying_currency_hint = (
        option_template.get('underlyingCurrency')
        or (underlying_request or {}).get('currency')
        or option_template.get('currency')
        or 'USD'
    )
    underlying_multiplier_hint = str(
        option_template.get('underlyingMultiplier')
        or (underlying_request or {}).get('multiplier')
        or option_template.get('multiplier')
        or ''
    )
    if underlying_sec_type == 'FUT' and not underlying_contract_month:
        error_payload = {
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': f'Choose an underlying futures month for {underlying_symbol or "this FOP"} before syncing.',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return
    if underlying_sec_type == 'FUT' and underlying_contract_month and isinstance(underlying_request, dict):
        underlying_request = {
            **underlying_request,
            'contractMonth': underlying_contract_month,
            'currency': underlying_currency_hint,
            'multiplier': underlying_multiplier_hint,
        }
    requested_underlying_contract_month = underlying_contract_month

    logging.info(
        "Received IV term structure subscription request from %s for %s maxDte=%s strikeRadius=%s underlyingMonth=%s",
        client_ip,
        underlying_symbol or '<missing>',
        max_dte,
        strike_radius,
        underlying_contract_month or '<none>',
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
        underlying_description = env["describe_contract_request"](underlying_request)
        if underlying_sec_type == 'FUT':
            details = [underlying_symbol or '<missing>']
            if underlying_contract_month:
                details.append(underlying_contract_month)
            if underlying_multiplier_hint:
                details.append(f"x{underlying_multiplier_hint}")
            underlying_description = f"FUT {' '.join(details)}"
        error_payload = {
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': f'Failed to qualify underlying {underlying_description}.',
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

    async def resolve_chain_fields_for_underlying(current_underlying_request, current_qualified_underlying):
        fut_fop_exchange = resolve_iv_term_structure_secdef_exchange(option_template, current_underlying_request)
        current_option_chains = await request_option_chains(
            underlying_symbol,
            fut_fop_exchange,
            normalize_symbol(
                getattr(current_qualified_underlying, 'secType', '')
                or (current_underlying_request or {}).get('secType')
            ),
            getattr(current_qualified_underlying, 'conId', 0),
        )
        current_merged_chain_fields = merge_iv_term_structure_chain_fields(
            current_option_chains,
            option_template,
        )
        current_expiry_rows = filter_expiry_rows(
            current_merged_chain_fields['expirations'],
            anchor_date,
            max_dte,
        )
        return current_option_chains, current_merged_chain_fields, current_expiry_rows

    option_chains, merged_chain_fields, expiry_rows = await resolve_chain_fields_for_underlying(
        underlying_request,
        qualified_underlying,
    )
    underlying_roll_message = ''
    if underlying_sec_type == 'FUT' and not expiry_rows:
        logging.info(
            "No usable IV term structure FOP expiries for %s %s; searching later underlying futures months",
            underlying_symbol or '<missing>',
            underlying_contract_month or '<none>',
        )
        for offset in range(1, 19):
            candidate_contract_month = shift_contract_month(underlying_contract_month, offset)
            if not candidate_contract_month:
                continue
            candidate_underlying_request = {
                **underlying_request,
                'contractMonth': candidate_contract_month,
                'currency': underlying_currency_hint,
                'multiplier': underlying_multiplier_hint,
            }
            try:
                candidate_underlying_contract = env['build_contract_from_request'](candidate_underlying_request)
            except Exception:
                logging.exception(
                    "Skipping IV term structure fallback underlying %s %s because request build failed",
                    underlying_symbol or '<missing>',
                    candidate_contract_month,
                )
                continue
            candidate_qualified_underlying = await env['qualify_one'](
                candidate_underlying_contract,
                candidate_underlying_request,
            )
            if candidate_qualified_underlying is None:
                continue

            candidate_option_chains, candidate_merged_chain_fields, candidate_expiry_rows = await resolve_chain_fields_for_underlying(
                candidate_underlying_request,
                candidate_qualified_underlying,
            )
            if candidate_expiry_rows:
                logging.info(
                    "Using fallback IV term structure underlying %s %s instead of %s; found %s expiries",
                    underlying_symbol or '<missing>',
                    candidate_contract_month,
                    requested_underlying_contract_month or '<none>',
                    len(candidate_expiry_rows),
                )
                underlying_request = candidate_underlying_request
                underlying_contract_month = candidate_contract_month
                qualified_underlying = candidate_qualified_underlying
                option_chains = candidate_option_chains
                merged_chain_fields = candidate_merged_chain_fields
                expiry_rows = candidate_expiry_rows
                underlying_roll_message = (
                    f'{underlying_symbol} {requested_underlying_contract_month} had no active FOP expiries; '
                    f'using {underlying_symbol} {underlying_contract_month} instead.'
                )
                break

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

    expiry_payload_rows = []
    option_descriptors = {}

    option_symbol = normalize_symbol(option_template.get('symbol') or underlying_symbol)
    option_sec_type = normalize_symbol(option_template.get('secType') or option_template.get('sec_type') or 'OPT')
    option_exchange = option_template.get('exchange') or 'SMART'
    option_currency = option_template.get('currency') or (underlying_request or {}).get('currency') or 'USD'
    option_multiplier = str(option_template.get('multiplier') or '100')
    option_template_trading_class = option_template.get('tradingClass') or option_template.get('trading_class') or ''
    option_trading_class = (
        merged_chain_fields.get('tradingClass')
        or ('' if option_sec_type == 'FOP' else option_template_trading_class)
        or ''
    )
    underlying_exchange = option_template.get('underlyingExchange') or (underlying_request or {}).get('exchange') or option_exchange
    underlying_currency = option_template.get('underlyingCurrency') or (underlying_request or {}).get('currency') or option_currency
    underlying_multiplier = str(option_template.get('underlyingMultiplier') or (underlying_request or {}).get('multiplier') or option_multiplier)

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
            underlying_contract_month=underlying_contract_month,
            underlying_currency=underlying_currency,
            underlying_multiplier=underlying_multiplier,
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
        'underlyingContractMonth': underlying_contract_month,
        'requestedUnderlyingContractMonth': requested_underlying_contract_month,
    }
    if underlying_roll_message:
        payload['message'] = underlying_roll_message
    if not expiry_payload_rows:
        suffix = ''
        if underlying_sec_type == 'FUT' and requested_underlying_contract_month:
            suffix = f' for {underlying_symbol} {requested_underlying_contract_month}. Try a later underlying futures month.'
        payload['warning'] = f'No option expiries were available within {max_dte} calendar days{suffix}'

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
                'underlyingContractMonth': underlying_contract_month,
                'underlyingCurrency': underlying_currency,
                'underlyingMultiplier': underlying_multiplier,
                'optionTradingClass': option_trading_class,
                'qualifiedUnderlying': qualified_underlying,
                'underlyingPrice': underlying_price,
                'strikeRadius': strike_radius,
                'globalCandidateStrikes': merged_chain_fields.get('strikes') or [],
            })
        )
        track_iv_term_structure_sync_task(env, websocket, task)
