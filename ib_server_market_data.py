import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from math import isfinite
from typing import Any
from uuid import uuid4

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9 fallback
    ZoneInfo = None

try:
    from dateutil.tz import gettz as dateutil_gettz
except ImportError:  # pragma: no cover - optional Windows timezone fallback
    dateutil_gettz = None

from runtime_contracts import (
    IvTermStructureQuoteSnapshotPayload,
    LiveMarketDataPayload,
    MarketReferenceQuoteSnapshot,
    ManualUnderlyingSyncPayload,
    OptionQuoteSnapshot,
    QuoteSnapshot,
)


IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY = 'iv_term_structure_quote_snapshot'
IV_TERM_STRUCTURE_MAX_QUOTE_AGE_SECONDS = 120.0
IV_TERM_STRUCTURE_MAX_QUOTE_SKEW_SECONDS = 120.0


def server_utc_now_iso() -> str:
    """Return a server-generated, timezone-explicit UTC payload timestamp."""
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def normalize_market_data_generation(raw_value: Any) -> int | None:
    try:
        generation = int(raw_value)
    except (TypeError, ValueError):
        return None
    return generation if generation >= 0 else None


def capture_market_data_generation(env: dict[str, Any]) -> int | None:
    getter = env.get('get_api_market_data_generation')
    if not callable(getter):
        return None
    return normalize_market_data_generation(getter())


def market_data_generation_is_current(
    env: dict[str, Any],
    captured_generation: Any,
) -> bool:
    reset_in_progress = env.get('api_market_data_reset_in_progress')
    if callable(reset_in_progress) and reset_in_progress():
        return False
    normalized = normalize_market_data_generation(captured_generation)
    getter = env.get('get_api_market_data_generation')
    if normalized is None or not callable(getter):
        return True
    return normalize_market_data_generation(getter()) == normalized


def stamp_market_data_generation(
    payload: dict[str, Any],
    generation: Any,
) -> dict[str, Any]:
    normalized = normalize_market_data_generation(generation)
    if normalized is not None:
        payload['marketDataGeneration'] = normalized
    return payload


async def send_market_data_payload_if_current(
    env: dict[str, Any],
    websocket: Any,
    payload: dict[str, Any],
    captured_generation: Any,
) -> bool:
    """Stamp and send only while the producing market-data epoch is current."""

    if not market_data_generation_is_current(env, captured_generation):
        return False
    stamp_market_data_generation(payload, captured_generation)
    return await env['send_message_safe'](websocket, json.dumps(payload))


def positive_contract_id(raw_value: Any) -> int | None:
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


# Historical alias kept for in-module readability.
_positive_contract_id = positive_contract_id


def extract_option_contract_identity(contract: Any) -> dict[str, Any]:
    """Serialize identity facts present on an IB-qualified option contract.

    ``underConId`` is deliberately excluded here.  It is a ContractDetails
    field, not a standard Contract field; callers sometimes attach a dynamic
    request hint with that name, but ib_async does not transmit that hint when
    serializing a Contract.  The verified value is added by
    :func:`build_option_contract_timing` from the exact ContractDetails row.
    """
    if contract is None:
        return {}

    identity: dict[str, Any] = {
        'secType': str(getattr(contract, 'secType', '') or '').strip().upper(),
        'symbol': str(getattr(contract, 'symbol', '') or '').strip().upper(),
        'localSymbol': str(getattr(contract, 'localSymbol', '') or '').strip(),
        'exchange': str(getattr(contract, 'exchange', '') or '').strip(),
        'currency': str(getattr(contract, 'currency', '') or '').strip().upper(),
        'multiplier': str(getattr(contract, 'multiplier', '') or '').strip(),
        'tradingClass': str(getattr(contract, 'tradingClass', '') or '').strip(),
        'right': str(getattr(contract, 'right', '') or '').strip().upper(),
    }
    con_id = _positive_contract_id(getattr(contract, 'conId', None))
    if con_id is not None:
        identity['conId'] = con_id

    raw_expiry = str(getattr(contract, 'lastTradeDateOrContractMonth', '') or '').strip()
    expiry_match = re.search(r'(?<!\d)(\d{8})(?!\d)', raw_expiry)
    if expiry_match:
        identity['optionExpiry'] = expiry_match.group(1)

    try:
        strike = float(getattr(contract, 'strike', None))
    except (TypeError, ValueError):
        strike = None
    if strike is not None and isfinite(strike):
        identity['strike'] = strike

    return {key: value for key, value in identity.items() if value not in ('', None)}


def build_option_contract_timing(contract: Any, contract_details: Any) -> dict[str, Any]:
    """Normalize IB ContractDetails last-trade metadata for browser pricing.

    ``realExpirationDate`` can be later than the last trading date, so the
    pricing cutoff deliberately uses ``contract.lastTradeDateOrContractMonth``
    plus ``lastTradeTime``. Raw fields remain in the payload for diagnostics.
    """
    details = contract_details
    details_contract = getattr(details, 'contract', None) or contract
    raw_last_trade_date = str(
        getattr(details_contract, 'lastTradeDateOrContractMonth', '')
        or getattr(contract, 'lastTradeDateOrContractMonth', '')
        or ''
    ).strip()
    date_match = re.search(r'(?<!\d)(\d{8})(?!\d)', raw_last_trade_date)
    last_trade_date = date_match.group(1) if date_match else ''
    last_trade_time = str(getattr(details, 'lastTradeTime', '') or '').strip()
    time_zone_id = str(getattr(details, 'timeZoneId', '') or '').strip()
    real_expiration_date = str(getattr(details, 'realExpirationDate', '') or '').strip()
    result: dict[str, Any] = {
        **extract_option_contract_identity(details_contract),
        'contractIdentitySource': 'ib_contract_details',
        'expiryTimingSource': 'ib_contract_details',
        'lastTradeDate': last_trade_date,
        'lastTradeTime': last_trade_time,
        'timeZoneId': time_zone_id,
        'realExpirationDate': real_expiration_date,
    }
    under_con_id = _positive_contract_id(getattr(details, 'underConId', None))
    if under_con_id is not None:
        result['underConId'] = under_con_id

    time_match = re.search(r'(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)', last_trade_time)
    if not last_trade_date or not time_match or not time_zone_id:
        return result

    zone_name = {
        'US/Eastern': 'America/New_York',
        'US/Central': 'America/Chicago',
        'EST': 'America/New_York',
        'CST': 'America/Chicago',
    }.get(time_zone_id, time_zone_id)
    tzinfo = None
    if ZoneInfo is not None:
        try:
            tzinfo = ZoneInfo(zone_name)
        except Exception:
            tzinfo = None
    if tzinfo is None and dateutil_gettz is not None:
        tzinfo = dateutil_gettz(zone_name)
    if tzinfo is None:
        return result

    try:
        local_dt = datetime.strptime(
            f"{last_trade_date} {int(time_match.group(1)):02d}:{time_match.group(2)}:{time_match.group(3) or '00'}",
            '%Y%m%d %H:%M:%S',
        ).replace(tzinfo=tzinfo)
    except (TypeError, ValueError):
        return result
    result['expiryAsOf'] = local_dt.astimezone(timezone.utc).isoformat(
        timespec='milliseconds'
    ).replace('+00:00', 'Z')
    return result


def option_contract_timing_for_ticker(env: dict[str, Any], ticker: Any) -> dict[str, Any]:
    contract = getattr(ticker, 'contract', None)
    con_id = getattr(contract, 'conId', None)
    result = extract_option_contract_identity(contract)
    timings = env.get('option_contract_timing_by_con_id')
    if not con_id or not isinstance(timings, dict):
        return result
    timing = timings.get(con_id)
    if isinstance(timing, dict):
        # Exact ContractDetails facts override the qualified ticker copy.
        result.update(timing)
    return result


def option_contract_timing_is_complete(timing: Any) -> bool:
    """Whether ContractDetails produced a usable exact last-trade instant.

    ``build_option_contract_timing`` intentionally retains raw identity and
    diagnostic fields even when IB omits a time or timezone.  Such a non-empty
    dict is useful diagnostics, but it is not a positive cache entry: treating
    it as one would make a transient incomplete response permanent for the
    lifetime of the backend process.
    """
    if not isinstance(timing, dict):
        return False
    if str(timing.get('expiryTimingSource') or '').strip() != 'ib_contract_details':
        return False
    if not str(timing.get('lastTradeDate') or '').strip():
        return False
    if not str(timing.get('lastTradeTime') or '').strip():
        return False
    if not str(timing.get('timeZoneId') or '').strip():
        return False
    return parse_utc_evidence(timing.get('expiryAsOf')) is not None


def option_contract_timing_is_publishable(timing: Any) -> bool:
    """Whether exact timing also proves any product-specific identity facts."""
    if not option_contract_timing_is_complete(timing):
        return False
    sec_type = str((timing or {}).get('secType') or '').strip().upper()
    if sec_type != 'FOP':
        return True
    if (timing or {}).get('underlyingBindingVerified') is not True:
        return False
    if _positive_contract_id((timing or {}).get('underConId')) is None:
        return False
    underlying_month = re.sub(
        r'\D', '', str((timing or {}).get('underlyingContractMonth') or '')
    )[:6]
    return len(underlying_month) == 6


def stamp_quote_as_of(
    quote: QuoteSnapshot,
    quote_as_of: str,
    *,
    batch_id: str = '',
    snapshot_id: str = '',
) -> QuoteSnapshot:
    """Attach receipt-batch evidence without mutating a shared ticker object."""
    stamped_quote: QuoteSnapshot = dict(quote)
    stamped_quote['quoteAsOf'] = quote_as_of
    if batch_id:
        stamped_quote['batchId'] = batch_id
    if snapshot_id:
        stamped_quote['snapshotId'] = snapshot_id
    return stamped_quote


def ticker_quote_evidence_key(ticker: Any) -> tuple[str, Any] | None:
    if ticker is None:
        return None
    contract = getattr(ticker, 'contract', None)
    con_id = getattr(contract, 'conId', None)
    if con_id:
        return ('conId', con_id)
    return ('object', id(ticker))


def _evidence_number(raw_value: Any, *, allow_zero: bool = False) -> float | None:
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return None
    if not isfinite(value) or value < 0 or (value == 0 and not allow_zero):
        return None
    return round(value, 8)


def ticker_quote_fingerprint(ticker: Any) -> tuple[Any, ...] | None:
    """Return only fields that can change consumed price evidence.

    IB can place an option ticker in ``pendingTickers`` because model Greeks
    changed while its bid/ask stayed untouched. Such an event must not refresh
    the straddle BBO clock.
    """
    if ticker is None:
        return None
    contract = getattr(ticker, 'contract', None)
    sec_type = str(getattr(contract, 'secType', '') or '').strip().upper()
    allow_zero = sec_type in ('OPT', 'FOP')
    bid = _evidence_number(getattr(ticker, 'bid', None), allow_zero=allow_zero)
    ask = _evidence_number(getattr(ticker, 'ask', None), allow_zero=allow_zero)
    if sec_type in ('OPT', 'FOP'):
        return ('bbo', bid, ask)
    return (
        'quote', bid, ask,
        _evidence_number(getattr(ticker, 'last', None)),
        _evidence_number(getattr(ticker, 'close', None)),
    )


def ticker_has_price_evidence_tick(ticker: Any) -> bool:
    """Whether this pending event explicitly contains consumed price evidence.

    An option straddle consumes bid/ask only, so a last-price tick must not
    make an unchanged option BBO look fresh.  Underlyings may consume last or
    close as a fallback and therefore accept last-price ticks as evidence.
    """
    contract = getattr(ticker, 'contract', None)
    sec_type = str(getattr(contract, 'secType', '') or '').strip().upper()
    accepted_tick_types = {1, 2, 66, 67}
    if sec_type not in ('OPT', 'FOP'):
        accepted_tick_types.update((4, 68))
    for tick in getattr(ticker, 'ticks', None) or ():
        try:
            tick_type = int(getattr(tick, 'tickType', -1))
        except (TypeError, ValueError):
            continue
        # IB tick types: bid=1, ask=2, last=4; delayed bid/ask/last=66/67/68.
        if tick_type in accepted_tick_types:
            return True
    return False


def record_ticker_quote_as_of(env: dict[str, Any], ticker: Any, quote_as_of: str) -> bool:
    """Remember when this process received price evidence for one ticker.

    A coherent full-curve snapshot may copy cached prices, but it must never
    relabel an unchanged BBO because only model Greeks changed. When ib_async
    exposes tick types, an explicit price tick refreshes evidence even if the
    numeric BBO repeats; otherwise a changed price fingerprint is the
    conservative fallback.
    """
    key = ticker_quote_evidence_key(ticker)
    if key is None or not quote_as_of:
        return False
    fingerprints = env.setdefault('market_data_quote_fingerprint_by_ticker_key', {})
    fingerprint = ticker_quote_fingerprint(ticker)
    has_explicit_price_tick = ticker_has_price_evidence_tick(ticker)
    if key not in fingerprints:
        # A newly attached pooled ticker may already contain a cached BBO when
        # its first pending event is only generic tick 106/model Greeks. Seed
        # the comparison state, but do not claim that cached BBO was received
        # in this event unless IB supplied a consumed price tick.
        fingerprints[key] = fingerprint
        if not has_explicit_price_tick:
            return False
    elif fingerprints.get(key) == fingerprint and not has_explicit_price_tick:
        return False
    fingerprints[key] = fingerprint
    evidence = env.setdefault('market_data_quote_as_of_by_ticker_key', {})
    evidence[key] = quote_as_of
    return True


def ticker_quote_as_of(env: dict[str, Any], ticker: Any) -> str:
    key = ticker_quote_evidence_key(ticker)
    if key is None:
        return ''
    evidence = env.get('market_data_quote_as_of_by_ticker_key')
    if not isinstance(evidence, dict):
        return ''
    return str(evidence.get(key) or '').strip()


def parse_utc_evidence(raw_value: Any) -> datetime | None:
    text = str(raw_value or '').strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def extract_market_price(ticker: Any) -> float | None:
    """Extract the best available price from a market-data ticker."""
    price = ticker.marketPrice()
    if not (price == price and price > 0):
        if ticker.last == ticker.last and ticker.last > 0:
            price = ticker.last
        elif ticker.close == ticker.close and ticker.close > 0:
            price = ticker.close
        else:
            return None
    return price


def extract_option_mark_with_source(ticker: Any) -> tuple[float | None, str | None]:
    """Best available option mark plus where it came from.

    Sources: 'bid_ask_mid' (real two-sided market), 'model' (TWS model
    price, i.e. derived from TWS's own IV), 'last_close' (stale trade or
    close). Consumers that must stay independent of TWS's IV model (the
    implied-lambda estimator) accept only 'bid_ask_mid'.
    """
    # A quoted option bid of zero is a legitimate market-data value.  Keep it
    # distinct from IB's missing sentinels (NaN/-1) so a 0.00 x 0.20 market is
    # still recognized as a real, two-sided BBO.
    bid = sanitize_quote_value(getattr(ticker, 'bid', None), allow_zero=True)
    ask = sanitize_quote_value(getattr(ticker, 'ask', None), allow_zero=True)
    if bid is not None and ask is not None and ask >= bid:
        return round((bid + ask) / 2, 4), 'bid_ask_mid'

    if hasattr(ticker, 'modelGreeks') and ticker.modelGreeks:
        opt_price = sanitize_quote_value(
            getattr(ticker.modelGreeks, 'optPrice', None),
            allow_zero=True,
        )
        if opt_price is not None:
            return round(opt_price, 4), 'model'

    fallback = extract_market_price(ticker)
    if fallback is not None and fallback == fallback and fallback > 0:
        return round(fallback, 4), 'last_close'
    return None, None


def extract_option_mark(ticker: Any) -> float | None:
    mark, _source = extract_option_mark_with_source(ticker)
    return mark


def sanitize_quote_value(raw_value: Any, *, allow_zero: bool = False) -> float | None:
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return None

    if not isfinite(value) or value < 0 or (value == 0 and not allow_zero):
        return None
    return round(value, 4)


def extract_quote_snapshot(ticker: Any, sec_type: str = '') -> QuoteSnapshot | None:
    normalized_sec_type = str(sec_type or '').strip().upper()
    is_option = normalized_sec_type in ('OPT', 'FOP')
    bid = sanitize_quote_value(
        getattr(ticker, 'bid', None),
        allow_zero=is_option,
    )
    ask = sanitize_quote_value(
        getattr(ticker, 'ask', None),
        allow_zero=is_option,
    )
    bid_present = bid is not None
    ask_present = ask is not None
    bid_ask_valid = bid_present and ask_present and ask >= bid
    if bid_ask_valid:
        bid_ask_status = 'two_sided'
    elif bid_present and ask_present:
        bid_ask_status = 'crossed'
    elif bid_present:
        bid_ask_status = 'one_sided_bid'
    elif ask_present:
        bid_ask_status = 'one_sided_ask'
    else:
        bid_ask_status = 'missing'

    mark_source: str | None = None
    if is_option:
        mark, mark_source = extract_option_mark_with_source(ticker)
    else:
        market_price = extract_market_price(ticker)
        mark = round(market_price, 4) if market_price is not None else None
        if mark is not None:
            mark_source = 'market_price'

    if mark is None and bid_ask_valid:
        mark = round((bid + ask) / 2, 4)
        mark_source = 'bid_ask_mid'
    if mark is None:
        return None

    # Preserve the compatibility keys, but never fabricate a missing market
    # side from model/last/close.  Consumers can independently inspect quote
    # completeness (bidAsk*) and valuation provenance (markSource).
    snapshot: QuoteSnapshot = {
        'bid': bid,
        'ask': ask,
        'mark': round(mark, 4),
        'bidPresent': bid_present,
        'askPresent': ask_present,
        'bidAskValid': bid_ask_valid,
        'bidAskStatus': bid_ask_status,
    }
    if mark_source is not None:
        snapshot['markSource'] = mark_source
    return snapshot


def extract_market_reference_contract_metadata(
    ticker: Any,
    contract_month_by_con_id: Any = None,
) -> dict[str, Any]:
    """Serialize contract identity needed by Forward/Carry diagnostics.

    In particular, a YYYYMM futures label is not enough to annualize basis.
    ``lastTradeDate`` is emitted only when IB qualified an exact YYYYMMDD date;
    callers must leave annualized carry null when that evidence is absent.

    ``contractMonth`` is the *delivery* month, which is not recoverable from the
    qualified last-trade date: CL Sep 2026 stops trading on 2026-08-20, so the
    date's leading six digits say 202608.  The authoritative value comes from
    ``ContractDetails.contractMonth`` via ``contract_month_by_con_id``, and
    ``contractMonthSource`` tells the browser which evidence it got so a
    date-derived month is never mistaken for a verified one.
    """
    contract = getattr(ticker, 'contract', None)
    if contract is None:
        return {}
    raw_expiry = str(getattr(contract, 'lastTradeDateOrContractMonth', '') or '').strip()
    expiry_match = re.search(r'(?<!\d)(\d{8})(?!\d)', raw_expiry)
    month_match = re.search(r'(?<!\d)(\d{6})(?:\d{2})?(?!\d)', raw_expiry)
    metadata: dict[str, Any] = {
        'secType': str(getattr(contract, 'secType', '') or '').strip().upper(),
        'symbol': str(getattr(contract, 'symbol', '') or '').strip().upper(),
        'localSymbol': str(getattr(contract, 'localSymbol', '') or '').strip(),
        'exchange': str(getattr(contract, 'exchange', '') or '').strip(),
        'currency': str(getattr(contract, 'currency', '') or '').strip().upper(),
        'multiplier': str(getattr(contract, 'multiplier', '') or '').strip(),
    }
    con_id = positive_contract_id(getattr(contract, 'conId', None))
    if con_id is not None:
        metadata['conId'] = con_id
    verified_month = ''
    if con_id is not None and isinstance(contract_month_by_con_id, dict):
        verified_month = str(
            contract_month_by_con_id.get(con_id) or ''
        ).strip()[:6]
    if verified_month:
        metadata['contractMonth'] = verified_month
        metadata['contractMonthSource'] = 'ib_contract_details'
    elif month_match:
        metadata['contractMonth'] = month_match.group(1)
        metadata['contractMonthSource'] = 'last_trade_date'
    if expiry_match:
        metadata['lastTradeDate'] = expiry_match.group(1)
    return {key: value for key, value in metadata.items() if value not in ('', None)}


def extract_option_iv(ticker: Any) -> float | None:
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


def extract_option_delta(ticker: Any) -> float | None:
    for attr_name in ('modelGreeks', 'bidGreeks', 'askGreeks', 'lastGreeks'):
        greeks = getattr(ticker, attr_name, None)
        if not greeks:
            continue
        raw = getattr(greeks, 'delta', None)
        if raw is not None and raw == raw:
            return round(raw, 6)
    return None


def log_option_iv_debug_if_needed(
    sub_id: str,
    ticker: Any,
    iv: float | None,
    option_iv_debug_last_logged: dict[Any, float],
) -> None:
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


def get_client_subscription_settings(websocket: Any, client_subscription_settings: dict[Any, dict[str, Any]]) -> dict[str, Any]:
    settings = client_subscription_settings.get(websocket)
    if not isinstance(settings, dict):
        settings = {'greeks_enabled': False}
        client_subscription_settings[websocket] = settings
    elif 'greeks_enabled' not in settings:
        settings['greeks_enabled'] = False
    return settings


def client_wants_greeks(websocket: Any, client_subscription_settings: dict[Any, dict[str, Any]]) -> bool:
    return get_client_subscription_settings(websocket, client_subscription_settings).get('greeks_enabled') is True


def collect_changed_ticker_keys(tickers: list[Any] | None) -> tuple[set[int], set[int]]:
    changed_ticker_ids = set()
    changed_contract_ids = set()

    for ticker in tickers or []:
        if ticker is None:
            continue

        changed_ticker_ids.add(id(ticker))
        contract = getattr(ticker, 'contract', None)
        con_id = getattr(contract, 'conId', None)
        if con_id:
            changed_contract_ids.add(con_id)

    return changed_ticker_ids, changed_contract_ids


def ticker_matches_change(
    ticker: Any,
    changed_ticker_ids: set[int],
    changed_contract_ids: set[int],
    process_all: bool = False,
) -> bool:
    if process_all:
        return True
    if ticker is None:
        return False
    if id(ticker) in changed_ticker_ids:
        return True

    contract = getattr(ticker, 'contract', None)
    con_id = getattr(contract, 'conId', None)
    return con_id in changed_contract_ids if con_id else False


def _bounded_positive_float(raw_value: Any, default_value: float) -> float:
    try:
        parsed = float(raw_value)
    except (TypeError, ValueError):
        return default_value
    return parsed if parsed > 0 else default_value


def build_iv_term_structure_quote_snapshot(
    env: dict[str, Any],
    websocket: Any,
    *,
    payload_as_of: str | None = None,
    batch_id: str | None = None,
    market_data_generation: Any = None,
) -> IvTermStructureQuoteSnapshotPayload | None:
    """Build one server-side, whole-curve IVTS quote snapshot.

    All prices are read from the ticker cache in one callback turn and share a
    snapshot id, while every leg retains its own last-received quoteAsOf.  A
    payload is coherent only after the intended subscription set succeeded,
    every subscribed leg has a real two-sided market, and all receipt times
    satisfy the configured age/skew gates.
    """
    settings = get_client_subscription_settings(
        websocket,
        env['client_subscription_settings'],
    )
    state = settings.get(IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY)
    if not isinstance(state, dict):
        return None

    payload_as_of = str(payload_as_of or server_utc_now_iso()).strip()
    batch_id = str(batch_id or uuid4().hex).strip()
    snapshot_id = batch_id
    expected_option_ids = tuple(dict.fromkeys(
        str(value or '').strip()
        for value in (state.get('expectedOptionIds') or [])
        if str(value or '').strip().startswith('__ivts__|')
    ))
    subscribed_option_ids = tuple(dict.fromkeys(
        str(value or '').strip()
        for value in (state.get('subscribedOptionIds') or [])
        if str(value or '').strip().startswith('__ivts__|')
    ))
    subscriptions = env['client_subscriptions'].get(websocket, {})
    if not isinstance(subscriptions, dict):
        subscriptions = {}

    payload: IvTermStructureQuoteSnapshotPayload = {
        'action': 'iv_term_structure_quote_snapshot',
        'symbol': str(state.get('symbol') or '').strip().upper(),
        'payloadAsOf': payload_as_of,
        'batchId': batch_id,
        'snapshotId': snapshot_id,
        'quoteComplete': False,
        'coherent': False,
        'coherenceReason': 'ivts_subscription_incomplete',
        'subscriptionComplete': state.get('subscriptionComplete') is True,
        'expectedOptionCount': len(expected_option_ids),
        'subscribedOptionCount': len(subscribed_option_ids),
        'attemptedOptionCount': int(state.get('attemptedOptionCount') or 0),
        'failedOptionCount': int(state.get('failedOptionCount') or 0),
        'timedOutOptionCount': int(state.get('timedOutOptionCount') or 0),
        'snapshotOptionCount': 0,
        'missingSubscriptionOptionIds': sorted(set(expected_option_ids) - set(subscribed_option_ids)),
        'missingQuoteOptionIds': [],
        'invalidQuoteOptionIds': [],
        'invalidContractIdentityOptionIds': [],
        'staleQuoteOptionIds': [],
        'underlyingPrice': None,
        'underlyingQuote': None,
        'options': {},
        'underlyingContractMonth': str(state.get('underlyingContractMonth') or '').strip(),
    }
    snapshot_generation = (
        market_data_generation
        if normalize_market_data_generation(market_data_generation) is not None
        else state.get('marketDataGeneration')
    )
    if normalize_market_data_generation(snapshot_generation) is None:
        snapshot_generation = capture_market_data_generation(env)
    stamp_market_data_generation(payload, snapshot_generation)
    if not payload['subscriptionComplete'] or not expected_option_ids:
        return payload
    if set(expected_option_ids) != set(subscribed_option_ids):
        payload['coherenceReason'] = 'ivts_subscription_set_incomplete'
        return payload

    quote_times: list[datetime] = []
    now = parse_utc_evidence(payload_as_of)
    if now is None:
        payload['coherenceReason'] = 'invalid_payload_time'
        return payload

    underlying_ticker = subscriptions.get('underlying')
    underlying_quote = extract_quote_snapshot(
        underlying_ticker,
        getattr(getattr(underlying_ticker, 'contract', None), 'secType', ''),
    ) if underlying_ticker is not None else None
    underlying_quote_as_of = ticker_quote_as_of(env, underlying_ticker)
    underlying_time = parse_utc_evidence(underlying_quote_as_of)
    if underlying_quote is None:
        payload['coherenceReason'] = 'ivts_underlying_quote_missing'
        return payload
    if underlying_time is None:
        payload['coherenceReason'] = 'ivts_underlying_quote_evidence_missing'
        return payload

    payload['underlyingQuote'] = stamp_quote_as_of(
        underlying_quote,
        underlying_quote_as_of,
        batch_id=batch_id,
        snapshot_id=snapshot_id,
    )
    payload['underlyingPrice'] = underlying_quote.get('mark')
    quote_times.append(underlying_time)

    wants_greeks = client_wants_greeks(websocket, env['client_subscription_settings'])
    missing_quote_ids = []
    invalid_quote_ids = []
    invalid_contract_identity_ids = []
    missing_evidence_ids = []
    for sub_id in subscribed_option_ids:
        ticker = subscriptions.get(sub_id)
        if ticker is None:
            missing_quote_ids.append(sub_id)
            continue
        sec_type = getattr(getattr(ticker, 'contract', None), 'secType', 'OPT')
        quote = extract_quote_snapshot(ticker, sec_type)
        if quote is None:
            missing_quote_ids.append(sub_id)
            continue
        bid = quote.get('bid')
        ask = quote.get('ask')
        if (
            quote.get('markSource') != 'bid_ask_mid'
            or quote.get('bidAskValid') is not True
            or not isinstance(bid, (int, float))
            or not isinstance(ask, (int, float))
            or bid < 0
            or ask < bid
        ):
            invalid_quote_ids.append(sub_id)
            continue
        quote_as_of = ticker_quote_as_of(env, ticker)
        quote_time = parse_utc_evidence(quote_as_of)
        if quote_time is None:
            missing_evidence_ids.append(sub_id)
            continue

        option_quote: OptionQuoteSnapshot = dict(quote)
        option_quote.update(option_contract_timing_for_ticker(env, ticker))
        # FOP expiries/strikes can be identical while referring to different
        # underlying futures.  Qualification already filters candidates by
        # ContractDetails.underConId, but the coherent-snapshot boundary must
        # independently prove that binding as well: a transient timing/details
        # failure must never publish a plausible lambda for the wrong month.
        actual_sec_type = str(option_quote.get('secType') or sec_type or '').strip().upper()
        expected_underlying_month = re.sub(
            r'\D', '', str(payload.get('underlyingContractMonth') or '')
        )[:6]
        actual_underlying_month = re.sub(
            r'\D', '', str(option_quote.get('underlyingContractMonth') or '')
        )[:6]
        if (
            (actual_sec_type == 'FOP' or expected_underlying_month)
            and (
                actual_sec_type != 'FOP'
                or not expected_underlying_month
                or option_quote.get('underlyingBindingVerified') is not True
                or actual_underlying_month != expected_underlying_month
            )
        ):
            invalid_contract_identity_ids.append(sub_id)
            continue
        iv = extract_option_iv(ticker)
        delta = extract_option_delta(ticker) if wants_greeks else None
        if iv is not None and iv == iv and iv > 0:
            option_quote['iv'] = iv
        if delta is not None:
            option_quote['delta'] = delta
        payload['options'][sub_id] = stamp_quote_as_of(
            option_quote,
            quote_as_of,
            batch_id=batch_id,
            snapshot_id=snapshot_id,
        )
        quote_times.append(quote_time)

    payload['snapshotOptionCount'] = len(payload['options'])
    payload['missingQuoteOptionIds'] = missing_quote_ids
    payload['invalidQuoteOptionIds'] = invalid_quote_ids
    payload['invalidContractIdentityOptionIds'] = invalid_contract_identity_ids
    if missing_evidence_ids:
        payload['missingQuoteEvidenceOptionIds'] = missing_evidence_ids
    if missing_quote_ids or invalid_quote_ids:
        payload['coherenceReason'] = 'ivts_quote_set_incomplete'
        return payload
    if invalid_contract_identity_ids:
        payload['coherenceReason'] = 'ivts_option_contract_identity_invalid'
        return payload
    if missing_evidence_ids:
        payload['coherenceReason'] = 'ivts_quote_evidence_missing'
        return payload

    max_age_seconds = _bounded_positive_float(
        env.get('iv_term_structure_max_quote_age_seconds'),
        IV_TERM_STRUCTURE_MAX_QUOTE_AGE_SECONDS,
    )
    max_skew_seconds = _bounded_positive_float(
        env.get('iv_term_structure_max_quote_skew_seconds'),
        IV_TERM_STRUCTURE_MAX_QUOTE_SKEW_SECONDS,
    )
    stale_quote_ids = []
    for sub_id, quote in payload['options'].items():
        quote_time = parse_utc_evidence(quote.get('quoteAsOf'))
        age_seconds = (now - quote_time).total_seconds() if quote_time is not None else float('inf')
        if age_seconds < -1.0 or age_seconds > max_age_seconds:
            stale_quote_ids.append(sub_id)
    underlying_age_seconds = (now - underlying_time).total_seconds()
    if underlying_age_seconds < -1.0 or underlying_age_seconds > max_age_seconds:
        payload['underlyingQuoteStale'] = True
    payload['staleQuoteOptionIds'] = stale_quote_ids
    if stale_quote_ids or payload.get('underlyingQuoteStale'):
        payload['coherenceReason'] = 'ivts_quote_stale'
        return payload

    quote_skew_seconds = (
        (max(quote_times) - min(quote_times)).total_seconds()
        if quote_times else float('inf')
    )
    payload['quoteSkewSeconds'] = round(quote_skew_seconds, 3)
    payload['maxQuoteAgeSeconds'] = max_age_seconds
    payload['maxQuoteSkewSeconds'] = max_skew_seconds
    if quote_skew_seconds > max_skew_seconds:
        payload['coherenceReason'] = 'ivts_quote_skew_exceeded'
        return payload

    payload['quoteComplete'] = True
    payload['coherent'] = True
    payload['coherenceReason'] = 'full_iv_term_structure_quote_snapshot'
    return payload


def build_pending_tickers_handler(env):
    def on_pending_tickers(tickers):
        if not env['connected_clients']:
            return

        market_data_generation = capture_market_data_generation(env)
        if not market_data_generation_is_current(env, market_data_generation):
            return
        payload_as_of = server_utc_now_iso()
        batch_id = uuid4().hex
        changed_ticker_ids, changed_contract_ids = collect_changed_ticker_keys(tickers)
        process_all = not (changed_ticker_ids or changed_contract_ids)
        price_evidence_ticker_ids = set()
        price_evidence_contract_ids = set()
        for changed_ticker in tickers or []:
            if record_ticker_quote_as_of(env, changed_ticker, payload_as_of):
                price_evidence_ticker_ids.add(id(changed_ticker))
                changed_contract = getattr(changed_ticker, 'contract', None)
                changed_con_id = getattr(changed_contract, 'conId', None)
                if changed_con_id:
                    price_evidence_contract_ids.add(changed_con_id)

        for ws in list(env['connected_clients']):
            subs = env['client_subscriptions'].get(ws, {})
            if not subs:
                continue

            ivts_snapshot_event_relevant = bool(
                (price_evidence_ticker_ids or price_evidence_contract_ids)
                and any(
                    (sub_id == 'underlying' or str(sub_id).startswith('__ivts__|'))
                    and ticker_matches_change(
                        ticker,
                        price_evidence_ticker_ids,
                        price_evidence_contract_ids,
                    )
                    for sub_id, ticker in subs.items()
                )
            )

            wants_greeks = client_wants_greeks(ws, env['client_subscription_settings'])
            payload: LiveMarketDataPayload = {
                'payloadAsOf': payload_as_of,
                'batchId': batch_id,
                'quoteComplete': False,
                'coherent': False,
                'coherenceReason': 'incremental_changed_tickers_only',
                'underlyingPrice': None,
                'underlyingQuote': None,
                'options': {},
                'futures': {},
                'stocks': {},
                'carryReferences': {},
            }
            stamp_market_data_generation(payload, market_data_generation)
            has_data = False

            if 'underlying' in subs:
                ticker = subs['underlying']
                if ticker_matches_change(ticker, changed_ticker_ids, changed_contract_ids, process_all):
                    sec_type = getattr(getattr(ticker, 'contract', None), 'secType', '')
                    quote = extract_quote_snapshot(ticker, sec_type)
                    if quote is not None:
                        quote = stamp_quote_as_of(quote, ticker_quote_as_of(env, ticker))
                        payload['underlyingPrice'] = quote['mark']
                        payload['underlyingQuote'] = quote
                        has_data = True

            for sub_id, ticker in subs.items():
                if sub_id == 'underlying':
                    continue
                if not ticker_matches_change(ticker, changed_ticker_ids, changed_contract_ids, process_all):
                    continue

                if sub_id.startswith('stock_'):
                    stock_sym = sub_id.replace('stock_', '')
                    quote = extract_quote_snapshot(ticker, 'STK')
                    if quote is not None:
                        quote = stamp_quote_as_of(quote, ticker_quote_as_of(env, ticker))
                        payload['stocks'][stock_sym] = quote
                        has_data = True
                elif sub_id.startswith('future_'):
                    future_id = sub_id.replace('future_', '')
                    quote = extract_quote_snapshot(ticker, 'FUT')
                    if quote is not None:
                        quote = stamp_quote_as_of(quote, ticker_quote_as_of(env, ticker))
                        quote.update(extract_market_reference_contract_metadata(
                            ticker, env.get('futures_contract_month_by_con_id')
                        ))
                        payload['futures'][future_id] = quote
                        has_data = True
                elif sub_id.startswith('carry_reference_'):
                    reference_id = sub_id.replace('carry_reference_', '')
                    sec_type = getattr(getattr(ticker, 'contract', None), 'secType', '')
                    quote = extract_quote_snapshot(ticker, sec_type)
                    if quote is not None:
                        reference_quote: MarketReferenceQuoteSnapshot = dict(
                            stamp_quote_as_of(quote, ticker_quote_as_of(env, ticker))
                        )
                        reference_quote.update(extract_market_reference_contract_metadata(
                            ticker, env.get('futures_contract_month_by_con_id')
                        ))
                        payload['carryReferences'][reference_id] = reference_quote
                        has_data = True
                else:
                    sec_type = getattr(getattr(ticker, 'contract', None), 'secType', 'OPT')
                    quote = extract_quote_snapshot(ticker, sec_type)
                    if quote is None:
                        continue
                    quote = stamp_quote_as_of(quote, ticker_quote_as_of(env, ticker))

                    iv = extract_option_iv(ticker)
                    delta = extract_option_delta(ticker) if wants_greeks else None
                    env['log_option_iv_debug_if_needed'](sub_id, ticker, iv)

                    option_quote: OptionQuoteSnapshot = dict(quote)
                    option_quote.update(option_contract_timing_for_ticker(env, ticker))
                    payload['options'][sub_id] = option_quote
                    if iv and iv == iv and iv > 0:
                        option_quote['iv'] = iv
                    if delta is not None:
                        option_quote['delta'] = delta
                    has_data = True

            if has_data:
                asyncio.create_task(send_market_data_payload_if_current(
                    env,
                    ws,
                    payload,
                    market_data_generation,
                ))
            if ivts_snapshot_event_relevant:
                full_snapshot = build_iv_term_structure_quote_snapshot(
                    env,
                    ws,
                    payload_as_of=payload_as_of,
                    batch_id=batch_id,
                    market_data_generation=market_data_generation,
                )
                # Incoherent snapshots are explicit invalidation evidence for
                # the browser; silently dropping them would leave the last
                # good lambda active after a crossed/missing/stale BBO.
                if full_snapshot is not None:
                    asyncio.create_task(send_market_data_payload_if_current(
                        env,
                        ws,
                        full_snapshot,
                        market_data_generation,
                    ))

    return on_pending_tickers


def unsubscribe_client_safely(
    ws: Any,
    *,
    client_subscriptions: dict[Any, dict[str, Any]],
    ib: Any,
    generic_ticks_by_con_id: dict[Any, set[str]] | None = None,
    quote_as_of_by_ticker_key: dict[tuple[str, Any], str] | None = None,
    quote_fingerprint_by_ticker_key: dict[tuple[str, Any], tuple[Any, ...]] | None = None,
) -> None:
    subs = client_subscriptions.get(ws, {})
    if not subs:
        return

    active_contracts = {}
    for other_ws, other_subs in client_subscriptions.items():
        if other_ws == ws:
            continue
        for ticker in other_subs.values():
            contract = getattr(ticker, 'contract', None)
            con_id = getattr(contract, 'conId', None)
            if con_id:
                active_contracts[con_id] = True

    cancelled_con_ids = set()
    for ticker in subs.values():
        contract = getattr(ticker, 'contract', None)
        con_id = getattr(contract, 'conId', None)
        if contract is None or not con_id or con_id in active_contracts or con_id in cancelled_con_ids:
            continue
        cancelled_con_ids.add(con_id)
        ib.cancelMktData(contract)
        if generic_ticks_by_con_id is not None:
            generic_ticks_by_con_id.pop(con_id, None)
        if quote_as_of_by_ticker_key is not None:
            quote_as_of_by_ticker_key.pop(('conId', con_id), None)
        if quote_fingerprint_by_ticker_key is not None:
            quote_fingerprint_by_ticker_key.pop(('conId', con_id), None)

    client_subscriptions[ws] = {}


def cancel_all_api_market_data_subscriptions(
    *,
    ib: Any,
    client_subscriptions: dict[Any, dict[str, Any]],
    generic_ticks_by_con_id: dict[Any, set[str]] | None = None,
) -> dict[str, int]:
    """Cancel every market-data ticker known to this IB API client.

    The subsequent API connection reset is still required to release duplicate
    request IDs that may already have fallen out of ib_async's ticker registry.
    """
    known_tickers = []
    try:
        known_tickers.extend(ib.tickers())
    except Exception:
        logging.exception("Unable to enumerate ib_async market-data tickers during global reset")

    for subscriptions in list(client_subscriptions.values()):
        known_tickers.extend(list((subscriptions or {}).values()))

    unique_contracts = []
    seen_contract_keys = set()
    for ticker in known_tickers:
        contract = getattr(ticker, 'contract', None)
        if contract is None:
            continue
        con_id = getattr(contract, 'conId', None)
        contract_key = ('conId', con_id) if con_id else ('object', id(contract))
        if contract_key in seen_contract_keys:
            continue
        seen_contract_keys.add(contract_key)
        unique_contracts.append(contract)

    cancelled_count = 0
    cancel_error_count = 0
    for contract in unique_contracts:
        try:
            result = ib.cancelMktData(contract)
            if result is not False:
                cancelled_count += 1
        except Exception:
            cancel_error_count += 1
            logging.exception(
                "Failed to cancel market data during global API reset: %r",
                contract,
            )

    for websocket in list(client_subscriptions):
        client_subscriptions[websocket] = {}
    if generic_ticks_by_con_id is not None:
        generic_ticks_by_con_id.clear()

    return {
        'knownTickerCount': len(unique_contracts),
        'cancelledTickerCount': cancelled_count,
        'cancelErrorCount': cancel_error_count,
    }


def normalize_generic_tick_set(generic_ticks: Any) -> set[str]:
    return {part.strip() for part in str(generic_ticks or '').split(',') if part.strip()}


def find_pooled_market_data_ticker(con_id: Any, *, client_subscriptions: dict[Any, dict[str, Any]]) -> Any:
    if not con_id:
        return None
    for subs in client_subscriptions.values():
        for ticker in subs.values():
            contract = getattr(ticker, 'contract', None)
            if getattr(contract, 'conId', None) == con_id:
                return ticker
    return None


def req_mkt_data_pooled(
    qualified_contract: Any,
    generic_ticks: str = '',
    *,
    ib: Any,
    client_subscriptions: dict[Any, dict[str, Any]],
    generic_ticks_by_con_id: dict[Any, set[str]] | None = None,
) -> Any:
    """Request market data once per contract.

    ib_insync keeps only the newest reqId per contract, so issuing a second
    reqMktData for a contract that is already streaming leaks the earlier
    market data line in TWS (it can never be cancelled afterwards). Reuse the
    existing ticker instead, whether it belongs to this pass or another client.

    When the new request needs generic ticks the live line was not opened with
    (e.g. greeks tick 106), cancel the line first and reopen it with the merged
    tick list so every subscriber shares one complete stream. ib_insync keeps a
    single Ticker object per contract, so existing subscribers keep receiving
    updates through the reopened line.
    """
    con_id = getattr(qualified_contract, 'conId', None)
    requested_ticks = normalize_generic_tick_set(generic_ticks)
    registry = generic_ticks_by_con_id if generic_ticks_by_con_id is not None else {}

    ticker = find_pooled_market_data_ticker(con_id, client_subscriptions=client_subscriptions)
    if ticker is None:
        if con_id:
            registry[con_id] = requested_ticks
        return ib.reqMktData(qualified_contract, generic_ticks, False, False)

    existing_ticks = registry.get(con_id) or set()
    if requested_ticks - existing_ticks:
        merged_ticks = existing_ticks | requested_ticks
        contract = getattr(ticker, 'contract', None) or qualified_contract
        ib.cancelMktData(contract)
        registry[con_id] = merged_ticks
        return ib.reqMktData(contract, ','.join(sorted(merged_ticks)), False, False)

    return ticker


def cancel_mkt_data_if_unused(
    ticker: Any,
    *,
    client_subscriptions: dict[Any, dict[str, Any]],
    ib: Any,
    generic_ticks_by_con_id: dict[Any, set[str]] | None = None,
    quote_as_of_by_ticker_key: dict[tuple[str, Any], str] | None = None,
    quote_fingerprint_by_ticker_key: dict[tuple[str, Any], tuple[Any, ...]] | None = None,
) -> None:
    """Cancel a market data line only when no tracked subscription still uses it."""
    contract = getattr(ticker, 'contract', None)
    if contract is None:
        return
    con_id = getattr(contract, 'conId', None)
    if con_id:
        for subs in client_subscriptions.values():
            for other_ticker in subs.values():
                other_contract = getattr(other_ticker, 'contract', None)
                if getattr(other_contract, 'conId', None) == con_id:
                    return
    ib.cancelMktData(contract)
    if generic_ticks_by_con_id is not None and con_id:
        generic_ticks_by_con_id.pop(con_id, None)
    if quote_as_of_by_ticker_key is not None:
        key = ('conId', con_id) if con_id else ('object', id(ticker))
        quote_as_of_by_ticker_key.pop(key, None)
    if quote_fingerprint_by_ticker_key is not None:
        key = ('conId', con_id) if con_id else ('object', id(ticker))
        quote_fingerprint_by_ticker_key.pop(key, None)


def coerce_positive_int(value: Any, default_value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default_value
    return parsed if parsed > 0 else default_value


def normalize_bool(value: Any, default_value: bool = True) -> bool:
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


def serialize_historical_bar_time(raw_value: Any) -> str:
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


def serialize_historical_bar(bar):
    try:
        open_value = float(getattr(bar, 'open', None))
        high_value = float(getattr(bar, 'high', None))
        low_value = float(getattr(bar, 'low', None))
        close_value = float(getattr(bar, 'close', None))
    except (TypeError, ValueError):
        return None

    time_value = serialize_historical_bar_time(getattr(bar, 'date', None))
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


async def request_ib_historical_bars(
    env,
    underlying_request,
    *,
    bar_size='1 day',
    duration_str='2 Y',
    use_rth=True,
    limit=260,
):
    ib = env['ib']
    if not ib.isConnected():
        raise RuntimeError('IB is not connected.')

    contract = env['build_contract_from_request'](underlying_request)
    qualified_underlying = await env['qualify_one'](contract, underlying_request)
    if qualified_underlying is None:
        raise RuntimeError(
            f"Failed to qualify underlying {env['describe_contract_request'](underlying_request)}"
        )

    sec_type = str(getattr(qualified_underlying, 'secType', '') or '').strip().upper()
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
        serialized_bar = serialize_historical_bar(raw_bar)
        if serialized_bar is not None:
            serialized_bars.append(serialized_bar)

    if limit and len(serialized_bars) > limit:
        serialized_bars = serialized_bars[-limit:]

    if not serialized_bars:
        raise RuntimeError(
            f"IB returned no historical bars for {env['describe_contract_request'](underlying_request)}."
        )

    if isinstance(underlying_request, dict):
        requested_symbol = underlying_request.get('symbol')
    else:
        requested_symbol = underlying_request

    return {
        'action': 'historical_bars_response',
        'symbol': env['normalize_symbol'](getattr(qualified_underlying, 'symbol', '') or requested_symbol),
        'barSize': bar_size,
        'durationStr': duration_str,
        'dataSource': 'ibkr',
        'useRTH': use_rth,
        'bars': serialized_bars,
    }
