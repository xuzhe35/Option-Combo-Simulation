import asyncio
import json
import logging
from datetime import datetime
from typing import Any
from uuid import uuid4

from ib_async import Contract

from ib_server_market_data import (
    IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY,
    build_iv_term_structure_quote_snapshot,
    cancel_mkt_data_if_unused,
    req_mkt_data_pooled,
    server_utc_now_iso,
    stamp_quote_as_of,
)
from runtime_contracts import (
    IvTermStructureCatalogPatchPayload,
    IvTermStructureErrorPayload,
    IvTermStructureExpiryRowPayload,
    IvTermStructureOptionDescriptor,
    IvTermStructureSnapshotPayload,
    IvTermStructureSyncCompletePayload,
)
from iv_term_structure_service import (
    choose_trading_class,
    filter_expiry_rows,
    pick_strike_window,
)


IV_TERM_STRUCTURE_OPTION_QUALIFY_TIMEOUT_SECONDS = 8.0
IV_TERM_STRUCTURE_OPTION_SUBSCRIPTION_CONCURRENCY = 4
IV_TERM_STRUCTURE_SHARED_ATM_PROBE_TIMEOUT_SECONDS = 20.0
IV_TERM_STRUCTURE_DEFAULT_MAX_OPTION_STREAMS = 20


def build_iv_term_structure_payload_evidence(coherence_reason: str) -> dict[str, Any]:
    """Describe why an IVTS payload is not a coherent full-curve quote snapshot."""
    return {
        'payloadAsOf': server_utc_now_iso(),
        'batchId': uuid4().hex,
        'quoteComplete': False,
        'coherent': False,
        'coherenceReason': str(coherence_reason or 'no_complete_quote_snapshot'),
    }


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


def normalize_max_option_streams(value: Any, default_value: int = IV_TERM_STRUCTURE_DEFAULT_MAX_OPTION_STREAMS) -> int:
    if value is None or str(value).strip() == '':
        value = default_value
    normalized = str(value).strip().lower()
    if normalized == 'all':
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default_value)
    if parsed <= 0:
        return 0
    return max(2, parsed - (parsed % 2))


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
    template_symbol = normalize_symbol(template.get('symbol'))
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
    elif template_symbol and template_sec_type != 'FOP':
        # Equity/index SecDef responses may include adjusted deliverables such
        # as 2SPY alongside the standard SPY chain. Their expiries can look
        # valid in the merged calendar but have no standard C/P contracts at
        # the requested strike. Prefer the exact-symbol trading class whenever
        # IB exposes one; keep the broader set only when no exact class exists.
        standard_trading_class_matches = [
            chain for chain in chains
            if str(getattr(chain, 'tradingClass', '') or '').strip().upper() == template_symbol
        ]
        if standard_trading_class_matches:
            chains = standard_trading_class_matches

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

    async def request_contract_details():
        semaphore = env.get('iv_term_structure_contract_details_semaphore')
        if semaphore is None:
            return await env['ib'].reqContractDetailsAsync(probe)
        async with semaphore:
            return await env['ib'].reqContractDetailsAsync(probe)

    try:
        contract_details_list = await asyncio.wait_for(
            request_contract_details(),
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

        # underConId is returned on ContractDetails, not on its Contract.
        candidate_under_con_id = getattr(detail, 'underConId', None)
        if requested_under_con_id and candidate_under_con_id != requested_under_con_id:
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
            'right': normalize_symbol(getattr(candidate, 'right', '')),
            'tradingClass': str(getattr(candidate, 'tradingClass', '') or '').strip(),
            'contract': candidate,
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

    async def request_contract_details():
        semaphore = env.get('iv_term_structure_contract_details_semaphore')
        if semaphore is None:
            return await env['ib'].reqContractDetailsAsync(probe)
        async with semaphore:
            return await env['ib'].reqContractDetailsAsync(probe)

    try:
        contract_details_list = await asyncio.wait_for(
            request_contract_details(),
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

        # underConId is returned on ContractDetails, not on its Contract.
        candidate_under_con_id = getattr(detail, 'underConId', None)
        if requested_under_con_id and candidate_under_con_id != requested_under_con_id:
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
            'right': normalize_symbol(getattr(candidate, 'right', '')),
            'tradingClass': str(getattr(candidate, 'tradingClass', '') or '').strip(),
            'contract': candidate,
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

    search_indices = sorted(
        range(len(normalized_candidates)),
        key=lambda index: (
            abs(normalized_candidates[index] - target_price),
            normalized_candidates[index],
        ),
    )

    probe_cache = {}
    probe_semaphore = asyncio.Semaphore(4)

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
            rights = {
                normalize_symbol(row.get('right'))
                for row in rows or []
                if isinstance(row, dict)
            }
            if 'C' in rights and 'P' in rights:
                rows_by_expiry[expiry] = rows
        return rows_by_expiry

    safe_radius = max(0, int(strike_radius or 0))
    max_probe_count = min(len(search_indices), 7)
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
                'contractRows': [],
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
            'contractRows': selected_rows,
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
            'contractRows': list(current.get('contractRows') or [])
            if serialize_finite_number(current.get('atm_strike')) == atm_strike
            else [],
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


async def subscribe_iv_term_structure_option_request(
    env,
    websocket,
    option_request,
    qualified_option=None,
    result_details=None,
):
    sub_id = option_request.get('id')

    def record_failure(kind, message):
        if isinstance(result_details, dict):
            result_details['kind'] = str(kind or 'error')
            result_details['message'] = str(message or '').strip()

    if qualified_option is None:
        try:
            option_contract = env['build_contract_from_request'](option_request)
        except Exception as exc:
            message = f'Invalid option contract request for {sub_id or "an unknown option"}: {exc}'
            logging.warning(
                "Skipping IV term structure option %s because the contract request was invalid: %s",
                sub_id or '<missing>',
                exc,
            )
            record_failure('invalid_contract', message)
            return False

        timeout_seconds = env.get(
            'iv_term_structure_option_qualify_timeout_seconds',
            IV_TERM_STRUCTURE_OPTION_QUALIFY_TIMEOUT_SECONDS,
        )
        effective_timeout_seconds = max(0.25, float(timeout_seconds or 0.0))
        try:
            qualified_option = await asyncio.wait_for(
                env['qualify_one'](option_contract, option_request),
                timeout=effective_timeout_seconds,
            )
        except asyncio.TimeoutError:
            message = (
                f'Option subscription timed out after {effective_timeout_seconds:.1f}s while resolving '
                f'{option_request.get("symbol") or "option"} {option_request.get("expDate") or ""} '
                f'{option_request.get("strike") or ""}{option_request.get("right") or ""}.'
            )
            logging.warning(
                "IV term structure option qualification timed out for %s after %.1fs",
                sub_id or '<missing>',
                effective_timeout_seconds,
            )
            record_failure('qualification_timeout', message)
            return False
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            message = f'Option contract resolution failed for {sub_id or "an unknown option"}: {exc}'
            logging.warning(
                "IV term structure option qualification failed for %s: %s",
                sub_id or '<missing>',
                exc,
            )
            record_failure('qualification_error', message)
            return False

    if qualified_option is None:
        message = f'IB returned no qualified contract for {sub_id or "an unknown option"}.'
        logging.warning(
            "IB returned no qualified contract for IV term structure option %s",
            sub_id or '<missing>',
        )
        record_failure('qualification_empty', message)
        return False

    timing_resolver = env.get('resolve_option_contract_timing')
    if callable(timing_resolver):
        try:
            timing = await timing_resolver(qualified_option)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logging.warning(
                'IV term structure option timing resolution failed for %s: %s; using product fallback.',
                sub_id or '<missing>',
                exc,
            )

    try:
        option_ticker = req_mkt_data_pooled(
            qualified_option,
            '106',
            ib=env['ib'],
            client_subscriptions=env['client_subscriptions'],
            generic_ticks_by_con_id=env.setdefault('market_data_generic_ticks_by_con_id', {}),
        )
    except Exception as exc:
        message = f'IB market-data subscription failed for {sub_id or "an unknown option"}: {exc}'
        logging.warning(
            "IB market-data subscription failed for IV term structure option %s: %s",
            sub_id or '<missing>',
            exc,
        )
        record_failure('market_data_error', message)
        return False
    if websocket not in env['client_subscriptions']:
        cancel_mkt_data_if_unused(
            option_ticker,
            client_subscriptions=env['client_subscriptions'],
            ib=env['ib'],
            generic_ticks_by_con_id=env.setdefault('market_data_generic_ticks_by_con_id', {}),
            quote_as_of_by_ticker_key=env.setdefault('market_data_quote_as_of_by_ticker_key', {}),
            quote_fingerprint_by_ticker_key=env.setdefault('market_data_quote_fingerprint_by_ticker_key', {}),
        )
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
    attempted_option_count = 0
    failed_option_count = 0
    timed_out_option_count = 0
    subscription_error_message = ''
    shared_atm_probe_timed_out = False
    snapshot_state_id = ''
    expected_option_ids: set[str] = set()
    subscribed_option_ids: set[str] = set()

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
        max_option_streams = IV_TERM_STRUCTURE_DEFAULT_MAX_OPTION_STREAMS
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
            max_option_streams = normalize_max_option_streams(
                sync_context.get('maxOptionStreams'),
                IV_TERM_STRUCTURE_DEFAULT_MAX_OPTION_STREAMS,
            )
            global_candidate_strikes = list(sync_context.get('globalCandidateStrikes') or [])
            snapshot_state_id = str(sync_context.get('snapshotStateId') or '').strip()

        prioritized_expiry_rows = prioritize_iv_term_structure_expiry_rows(
            expiry_rows,
            env['iv_term_structure_bucket_definitions'],
        )
        resolved_expiry_count = 0
        total_expiry_count = len(prioritized_expiry_rows)
        chronological_expiry_rows = sorted(
            prioritized_expiry_rows,
            key=lambda row: (
                int((row or {}).get('dte') or 0),
                str((row or {}).get('expiry') or ''),
            ),
        )
        subscription_expiry_limit = max_option_streams // 2 if max_option_streams > 0 else 0
        subscription_expiry_rows = (
            chronological_expiry_rows[:subscription_expiry_limit]
            if subscription_expiry_limit > 0
            else chronological_expiry_rows
        )
        subscription_expiries = {
            str((row or {}).get('expiry') or '').strip()
            for row in subscription_expiry_rows
            if str((row or {}).get('expiry') or '').strip()
        }
        progress_lock = asyncio.Lock()
        try:
            subscription_concurrency = int(env.get(
                'iv_term_structure_option_subscription_concurrency',
                IV_TERM_STRUCTURE_OPTION_SUBSCRIPTION_CONCURRENCY,
            ))
        except (TypeError, ValueError):
            subscription_concurrency = IV_TERM_STRUCTURE_OPTION_SUBSCRIPTION_CONCURRENCY
        option_subscription_semaphore = env.get('iv_term_structure_option_subscription_semaphore')
        if option_subscription_semaphore is None:
            option_subscription_semaphore = asyncio.Semaphore(max(1, subscription_concurrency))

        async def send_sync_progress(message):
            patch_payload: IvTermStructureCatalogPatchPayload = {
                **build_iv_term_structure_payload_evidence('catalog_progress_without_complete_option_quotes'),
                'action': 'iv_term_structure_catalog_patch',
                'symbol': option_symbol,
                'expiryRows': [],
                'optionDescriptors': {},
                'resolvedExpiryCount': resolved_expiry_count,
                'totalExpiryCount': total_expiry_count,
                'subscribedOptionCount': subscribed_option_count,
                'expectedOptionCount': expected_option_count,
                'attemptedOptionCount': attempted_option_count,
                'failedOptionCount': failed_option_count,
                'timedOutOptionCount': timed_out_option_count,
                'subscriptionErrorMessage': subscription_error_message,
                'sharedAtmProbeTimedOut': shared_atm_probe_timed_out,
                'subscriptionPending': True,
            }
            normalized_message = str(message or '').strip()
            if normalized_message:
                patch_payload['message'] = normalized_message
            await env['send_message_safe'](websocket, json.dumps(patch_payload))

        expiry_selections = {}
        if subscription_expiry_rows:
            await send_sync_progress(
                f'Checking exact option contracts for {len(subscription_expiry_rows)} selected expiries...',
            )
            probe_timeout_seconds = env.get(
                'iv_term_structure_shared_atm_probe_timeout_seconds',
                IV_TERM_STRUCTURE_SHARED_ATM_PROBE_TIMEOUT_SECONDS,
            )
            try:
                expiry_selections = await asyncio.wait_for(
                    resolve_iv_term_structure_common_selections_from_candidates(
                        env,
                        option_symbol,
                        option_sec_type,
                        option_exchange,
                        option_currency,
                        option_multiplier,
                        subscription_expiry_rows,
                        underlying_price,
                        global_candidate_strikes,
                        0,
                        option_trading_class=option_trading_class,
                        qualified_underlying=qualified_underlying,
                    ),
                    timeout=max(1.0, float(probe_timeout_seconds or 0.0)),
                )
            except asyncio.TimeoutError:
                shared_atm_probe_timed_out = True
                subscription_error_message = (
                    f'Shared ATM contract check timed out after {float(probe_timeout_seconds or 0.0):.1f}s. '
                    'The server is continuing with bounded fallback contract resolution.'
                )
                logging.warning(
                    "IV term structure shared ATM probe timed out for %s after %.1fs",
                    option_symbol or '<missing>',
                    float(probe_timeout_seconds or 0.0),
                )
                expiry_selections = {}

        has_selected_atm = any(
            (selection or {}).get('atm_strike') is not None
            for selection in expiry_selections.values()
        )
        if not has_selected_atm:
            await send_sync_progress(
                'Exact shared-ATM probes did not return in time. Falling back to the nearest option-chain strike with bounded qualification...',
            )
            expiry_selections = build_iv_term_structure_global_candidate_selections(
                subscription_expiry_rows,
                underlying_price,
                global_candidate_strikes,
                0,
                option_trading_class=option_trading_class,
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

        qualified_options_by_key = {}
        for selection in expiry_selections.values():
            for row in (selection or {}).get('contractRows') or []:
                if not isinstance(row, dict):
                    continue
                contract = row.get('contract')
                expiry = to_expiry(row.get('expiry'))
                strike = serialize_finite_number(row.get('strike'))
                right = normalize_symbol(row.get('right'))
                if contract is None or not expiry or strike is None or right not in ('C', 'P'):
                    continue
                qualified_options_by_key.setdefault((expiry, strike, right), contract)

        async def process_expiry(expiry_row):
            nonlocal resolved_expiry_count
            nonlocal expected_option_count
            nonlocal subscribed_option_count
            nonlocal attempted_option_count
            nonlocal failed_option_count
            nonlocal timed_out_option_count
            nonlocal subscription_error_message

            if websocket not in env['client_subscriptions']:
                return

            expiry = str((expiry_row or {}).get('expiry') or '').strip()
            if not expiry:
                return

            try:
                expiry_selection = expiry_selections.get(expiry) or {}
                subscription_selected = expiry in subscription_expiries
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
                expiry_payload_row = dict(bundle.get('expiryPayloadRow') or {})
                expiry_payload_row['subscriptionSelected'] = subscription_selected
                option_requests = (bundle.get('optionRequests') or []) if subscription_selected else []
                option_descriptors = (bundle.get('optionDescriptors') or {}) if subscription_selected else {}

                async with progress_lock:
                    resolved_expiry_count += 1
                    expected_option_count += len(option_requests)
                    expected_option_ids.update(
                        str(request.get('id') or '').strip()
                        for request in option_requests
                        if str(request.get('id') or '').strip()
                    )
                    resolved_count = resolved_expiry_count
                    expected_count = expected_option_count
                    subscribed_count = subscribed_option_count

                patch_payload: IvTermStructureCatalogPatchPayload = {
                    **build_iv_term_structure_payload_evidence('catalog_progress_without_complete_option_quotes'),
                    'action': 'iv_term_structure_catalog_patch',
                    'symbol': option_symbol,
                    'expiryRows': [expiry_payload_row],
                    'optionDescriptors': option_descriptors,
                    'resolvedExpiryCount': resolved_count,
                    'totalExpiryCount': total_expiry_count,
                    'subscribedOptionCount': subscribed_count,
                    'expectedOptionCount': expected_count,
                    'attemptedOptionCount': attempted_option_count,
                    'failedOptionCount': failed_option_count,
                    'timedOutOptionCount': timed_out_option_count,
                    'subscriptionErrorMessage': subscription_error_message,
                    'sharedAtmProbeTimedOut': shared_atm_probe_timed_out,
                    'subscriptionPending': True,
                }
                await env['send_message_safe'](websocket, json.dumps(patch_payload))

                for option_request in option_requests:
                    if websocket not in env['client_subscriptions']:
                        break
                    option_key = (
                        to_expiry(option_request.get('expDate') or option_request.get('expiry')),
                        serialize_finite_number(option_request.get('strike')),
                        normalize_symbol(option_request.get('right')),
                    )
                    subscription_result = {}
                    async with option_subscription_semaphore:
                        subscribed = await subscribe_iv_term_structure_option_request(
                            env,
                            websocket,
                            option_request,
                            qualified_option=qualified_options_by_key.get(option_key),
                            result_details=subscription_result,
                        )

                    async with progress_lock:
                        attempted_option_count += 1
                        if subscribed:
                            subscribed_option_count += 1
                            subscribed_option_ids.add(str(option_request.get('id') or '').strip())
                        else:
                            failed_option_count += 1
                            if subscription_result.get('kind') == 'qualification_timeout':
                                timed_out_option_count += 1
                            if subscription_result.get('message'):
                                subscription_error_message = subscription_result['message']
                        resolved_count = resolved_expiry_count
                        expected_count = expected_option_count
                        subscribed_count = subscribed_option_count
                        attempted_count = attempted_option_count
                        failed_count = failed_option_count
                        timed_out_count = timed_out_option_count
                        current_error_message = subscription_error_message
                    patch_payload = {
                        **build_iv_term_structure_payload_evidence('catalog_progress_without_complete_option_quotes'),
                        'action': 'iv_term_structure_catalog_patch',
                        'symbol': option_symbol,
                        'expiryRows': [],
                        'optionDescriptors': {},
                        'resolvedExpiryCount': resolved_count,
                        'totalExpiryCount': total_expiry_count,
                        'subscribedOptionCount': subscribed_count,
                        'expectedOptionCount': expected_count,
                        'attemptedOptionCount': attempted_count,
                        'failedOptionCount': failed_count,
                        'timedOutOptionCount': timed_out_count,
                        'subscriptionErrorMessage': current_error_message,
                        'sharedAtmProbeTimedOut': shared_atm_probe_timed_out,
                        'subscriptionPending': (
                            resolved_count < total_expiry_count
                            or attempted_count < expected_count
                        ),
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

        settings_getter = env.get('get_client_subscription_settings')
        if callable(settings_getter):
            settings = settings_getter(websocket)
            snapshot_state = settings.get(IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY)
            if (
                isinstance(snapshot_state, dict)
                and snapshot_state_id
                and snapshot_state.get('stateId') == snapshot_state_id
            ):
                snapshot_state.update({
                    'symbol': option_symbol,
                    'subscriptionComplete': True,
                    'expectedOptionIds': sorted(expected_option_ids),
                    'subscribedOptionIds': sorted(subscribed_option_ids),
                    'expectedOptionCount': expected_option_count,
                    'subscribedOptionCount': subscribed_option_count,
                    'attemptedOptionCount': attempted_option_count,
                    'failedOptionCount': failed_option_count,
                    'timedOutOptionCount': timed_out_option_count,
                })

        complete_payload: IvTermStructureSyncCompletePayload = {
            **build_iv_term_structure_payload_evidence('subscriptions_ready_without_coherent_quote_snapshot'),
            'action': 'iv_term_structure_sync_complete',
            'symbol': option_symbol,
            'subscribedOptionCount': subscribed_option_count,
            'expectedOptionCount': expected_option_count,
            'attemptedOptionCount': attempted_option_count,
            'failedOptionCount': failed_option_count,
            'timedOutOptionCount': timed_out_option_count,
            'subscriptionErrorMessage': subscription_error_message,
            'sharedAtmProbeTimedOut': shared_atm_probe_timed_out,
        }
        await env['send_message_safe'](websocket, json.dumps(complete_payload))

        # Quotes may already have arrived while contracts were being resolved.
        # Attempt one full snapshot now; if any leg is still missing evidence,
        # the regular pending-ticker path will retry after its next real update.
        if (
            'client_subscription_settings' in env
            and 'market_data_quote_as_of_by_ticker_key' in env
        ):
            full_snapshot = build_iv_term_structure_quote_snapshot(env, websocket)
            if full_snapshot is not None:
                await env['send_message_safe'](websocket, json.dumps(full_snapshot))
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
            **build_iv_term_structure_payload_evidence('error_payload_no_quote_snapshot'),
            'action': 'iv_term_structure_error',
            'symbol': normalize_symbol(symbol),
            'message': f'Background IV option subscription failed: {exc}',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))


async def handle_iv_term_structure_subscription(env, websocket, client_ip, data):
    generation_getter = env.get('get_api_market_data_generation')
    reset_in_progress = env.get('api_market_data_reset_in_progress')
    subscription_generation = generation_getter() if callable(generation_getter) else None

    def subscription_generation_is_current():
        return (
            not (callable(reset_in_progress) and reset_in_progress())
            and (
                subscription_generation is None
                or not callable(generation_getter)
                or generation_getter() == subscription_generation
            )
        )

    if not subscription_generation_is_current():
        return

    if not env['ib'].isConnected():
        error_payload: IvTermStructureErrorPayload = {
            **build_iv_term_structure_payload_evidence('error_payload_no_quote_snapshot'),
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
    max_option_streams = normalize_max_option_streams(
        data.get('maxOptionStreams'),
        IV_TERM_STRUCTURE_DEFAULT_MAX_OPTION_STREAMS,
    )
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
            **build_iv_term_structure_payload_evidence('error_payload_no_quote_snapshot'),
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
        "Received IV term structure subscription request from %s for %s maxDte=%s strikeRadius=%s maxOptionStreams=%s underlyingMonth=%s",
        client_ip,
        underlying_symbol or '<missing>',
        max_dte,
        strike_radius,
        max_option_streams or 'all',
        underlying_contract_month or '<none>',
    )

    try:
        underlying_contract = env['build_contract_from_request'](underlying_request)
    except Exception as exc:
        error_payload = {
            **build_iv_term_structure_payload_evidence('error_payload_no_quote_snapshot'),
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': f'Invalid underlying request: {exc}',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    await cancel_iv_term_structure_sync_task(env, websocket)
    env['unsubscribe_client_safely'](websocket)
    client_settings = env['get_client_subscription_settings'](websocket)
    client_settings['greeks_enabled'] = False
    snapshot_state_id = uuid4().hex
    client_settings[IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY] = {
        'stateId': snapshot_state_id,
        'symbol': underlying_symbol,
        'underlyingContractMonth': underlying_contract_month,
        'subscriptionComplete': False,
        'expectedOptionIds': [],
        'subscribedOptionIds': [],
    }

    qualified_underlying = await env['qualify_one'](underlying_contract, underlying_request)
    if not subscription_generation_is_current():
        return
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
            **build_iv_term_structure_payload_evidence('error_payload_no_quote_snapshot'),
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': f'Failed to qualify underlying {underlying_description}.',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    request_option_chains = getattr(env['ib'], 'reqSecDefOptParamsAsync', None)
    if not callable(request_option_chains):
        error_payload = {
            **build_iv_term_structure_payload_evidence('error_payload_no_quote_snapshot'),
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
            if not subscription_generation_is_current():
                return
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

    if not subscription_generation_is_current():
        return
    underlying_ticker = req_mkt_data_pooled(
        qualified_underlying,
        '',
        ib=env['ib'],
        client_subscriptions=env['client_subscriptions'],
        generic_ticks_by_con_id=env.setdefault('market_data_generic_ticks_by_con_id', {}),
    )
    env['client_subscriptions'][websocket]['underlying'] = underlying_ticker
    await asyncio.sleep(0.75)
    if not subscription_generation_is_current():
        return
    underlying_quote = env['extract_quote_snapshot'](underlying_ticker, getattr(qualified_underlying, 'secType', ''))
    underlying_price = None if underlying_quote is None else underlying_quote.get('mark')

    if underlying_price is None:
        error_payload = {
            **build_iv_term_structure_payload_evidence('error_payload_no_quote_snapshot'),
            'action': 'iv_term_structure_error',
            'symbol': underlying_symbol,
            'message': f'No live underlying quote is available yet for {underlying_symbol or "the requested symbol"}.',
        }
        await env['send_message_safe'](websocket, json.dumps(error_payload))
        return

    expiry_payload_rows = []
    option_descriptors = {}

    option_symbol = normalize_symbol(option_template.get('symbol') or underlying_symbol)
    client_settings[IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY]['symbol'] = option_symbol
    client_settings[IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY]['underlyingContractMonth'] = underlying_contract_month
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

    snapshot_evidence = build_iv_term_structure_payload_evidence(
        'catalog_without_complete_option_quotes',
    )
    underlying_quote = stamp_quote_as_of(
        underlying_quote,
        snapshot_evidence['payloadAsOf'],
    )
    payload: IvTermStructureSnapshotPayload = {
        **snapshot_evidence,
        'action': 'iv_term_structure_snapshot',
        'symbol': option_symbol,
        'anchorDate': anchor_date,
        'maxDte': max_dte,
        'strikeRadius': strike_radius,
        'maxOptionStreams': max_option_streams,
        'underlyingPrice': underlying_price,
        'underlyingQuote': underlying_quote,
        'expiryRows': expiry_payload_rows,
        'optionDescriptors': option_descriptors,
        'subscribedOptionCount': 0,
        'expectedOptionCount': 0,
        'attemptedOptionCount': 0,
        'failedOptionCount': 0,
        'timedOutOptionCount': 0,
        'subscriptionErrorMessage': '',
        'sharedAtmProbeTimedOut': False,
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
    if expiry_payload_rows and subscription_generation_is_current():
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
                'maxOptionStreams': max_option_streams,
                'globalCandidateStrikes': merged_chain_fields.get('strikes') or [],
                'snapshotStateId': snapshot_state_id,
            })
        )
        track_iv_term_structure_sync_task(env, websocket, task)
