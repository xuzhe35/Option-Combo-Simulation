import asyncio
import json
import logging
from datetime import datetime
from typing import Any

from runtime_contracts import LiveMarketDataPayload, ManualUnderlyingSyncPayload, OptionQuoteSnapshot, QuoteSnapshot


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


def extract_option_mark(ticker: Any) -> float | None:
    bid = getattr(ticker, 'bid', None)
    ask = getattr(ticker, 'ask', None)
    if bid and ask and bid == bid and ask == ask and bid > 0 and ask > 0:
        return round((bid + ask) / 2, 4)

    if hasattr(ticker, 'modelGreeks') and ticker.modelGreeks:
        opt_price = getattr(ticker.modelGreeks, 'optPrice', None)
        if opt_price is not None and opt_price == opt_price and opt_price > 0:
            return round(opt_price, 4)

    fallback = extract_market_price(ticker)
    if fallback == fallback and fallback > 0:
        return round(fallback, 4)
    return None


def sanitize_quote_value(raw_value: Any) -> float | None:
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return None

    if value != value or value <= 0:
        return None
    return round(value, 4)


def extract_quote_snapshot(ticker: Any, sec_type: str = '') -> QuoteSnapshot | None:
    normalized_sec_type = str(sec_type or '').strip().upper()
    bid = sanitize_quote_value(getattr(ticker, 'bid', None))
    ask = sanitize_quote_value(getattr(ticker, 'ask', None))

    if normalized_sec_type in ('OPT', 'FOP'):
        mark = extract_option_mark(ticker)
    else:
        market_price = extract_market_price(ticker)
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


def build_pending_tickers_handler(env):
    def on_pending_tickers(tickers):
        if not env['connected_clients']:
            return

        changed_ticker_ids, changed_contract_ids = collect_changed_ticker_keys(tickers)
        process_all = not (changed_ticker_ids or changed_contract_ids)

        for ws in list(env['connected_clients']):
            subs = env['client_subscriptions'].get(ws, {})
            if not subs:
                continue

            wants_greeks = client_wants_greeks(ws, env['client_subscription_settings'])
            payload: LiveMarketDataPayload = {
                'underlyingPrice': None,
                'underlyingQuote': None,
                'options': {},
                'futures': {},
                'stocks': {},
            }
            has_data = False

            if 'underlying' in subs:
                ticker = subs['underlying']
                if ticker_matches_change(ticker, changed_ticker_ids, changed_contract_ids, process_all):
                    sec_type = getattr(getattr(ticker, 'contract', None), 'secType', '')
                    quote = extract_quote_snapshot(ticker, sec_type)
                    if quote is not None:
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
                        payload['stocks'][stock_sym] = quote
                        has_data = True
                elif sub_id.startswith('future_'):
                    future_id = sub_id.replace('future_', '')
                    quote = extract_quote_snapshot(ticker, 'FUT')
                    if quote is not None:
                        payload['futures'][future_id] = quote
                        has_data = True
                else:
                    sec_type = getattr(getattr(ticker, 'contract', None), 'secType', 'OPT')
                    quote = extract_quote_snapshot(ticker, sec_type)
                    if quote is None:
                        continue

                    iv = extract_option_iv(ticker)
                    delta = extract_option_delta(ticker) if wants_greeks else None
                    env['log_option_iv_debug_if_needed'](sub_id, ticker, iv)

                    option_quote: OptionQuoteSnapshot = dict(quote)
                    payload['options'][sub_id] = option_quote
                    if iv and iv == iv and iv > 0:
                        option_quote['iv'] = iv
                    if delta is not None:
                        option_quote['delta'] = delta
                    has_data = True

            if has_data:
                asyncio.create_task(env['send_message_safe'](ws, json.dumps(payload)))

    return on_pending_tickers


def unsubscribe_client_safely(ws: Any, *, client_subscriptions: dict[Any, dict[str, Any]], ib: Any) -> None:
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

    client_subscriptions[ws] = {}


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
