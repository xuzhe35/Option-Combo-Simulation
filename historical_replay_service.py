import os
from datetime import datetime

from historical_data import HistoricalReplayStore


def normalize_symbol(value):
    return str(value or '').strip().upper()


def to_contract_month(value):
    cleaned = str(value or '').replace('-', '')
    return cleaned[:6]


def describe_contract_request(contract_data):
    if isinstance(contract_data, dict):
        sec_type = normalize_symbol(contract_data.get('secType') or contract_data.get('sec_type'))
        symbol = normalize_symbol(contract_data.get('symbol'))
        return f"{sec_type or 'UNKNOWN'} {symbol or '<missing>'}".strip()
    return normalize_symbol(contract_data) or '<missing>'


def normalize_replay_date(value):
    text = str(value or '').strip().replace('/', '-')
    if not text:
        return ''
    try:
        return datetime.strptime(text, '%Y-%m-%d').date().isoformat()
    except ValueError:
        return ''


def normalize_history_lookup_date(value):
    text = str(value or '').strip().replace('/', '-')
    if not text:
        return ''

    for fmt in ('%Y-%m-%d', '%Y%m%d'):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue

    return ''


class HistoricalReplayService:
    def __init__(self, db_path, logger=None):
        self.store = HistoricalReplayStore(os.path.abspath(db_path), logger=logger)

    def build_snapshot_payload(self, requested_date, underlying_request, options_data):
        underlying_symbol = normalize_symbol(
            (underlying_request or {}).get('symbol')
            or (underlying_request or {}).get('enteredSymbol')
        )
        date_bounds = self.store.get_underlying_date_bounds(underlying_symbol) or {}
        payload = {
            "underlyingPrice": None,
            "underlyingQuote": None,
            "riskFreeRate": None,
            "options": {},
            "futures": {},
            "stocks": {},
            "historicalReplay": {
                "requestedDate": requested_date,
                "effectiveDate": '',
                "dataSource": "historical",
                "availableStartDate": date_bounds.get('startDate', ''),
                "availableEndDate": date_bounds.get('endDate', ''),
                "expiryUnderlyingQuotes": {},
                "riskFreeRateEffectiveDate": '',
                "riskFreeRateSource": '',
                "yieldCurveEffectiveDate": '',
                "yieldCurveSource": '',
                "yieldCurvePoints": [],
            },
        }

        underlying_snapshot = self.store.get_underlying_snapshot(
            underlying_symbol,
            requested_date,
        )
        if not underlying_snapshot:
            return None

        effective_date = str(
            underlying_snapshot.get('effectiveDate')
            or underlying_snapshot.get('requestedDate')
            or requested_date
            or ''
        )
        payload["historicalReplay"]["effectiveDate"] = effective_date

        underlying_quote = underlying_snapshot.get('quote') or {}
        if underlying_quote:
            payload["underlyingQuote"] = underlying_quote
            payload["underlyingPrice"] = underlying_quote.get("mark")

        risk_free_snapshot = self.store.get_risk_free_rate_snapshot(effective_date)
        if risk_free_snapshot:
            payload["riskFreeRate"] = risk_free_snapshot.get("rate")
            payload["historicalReplay"]["riskFreeRateEffectiveDate"] = risk_free_snapshot.get("effectiveDate", '')
            payload["historicalReplay"]["riskFreeRateSource"] = risk_free_snapshot.get("source", '')

        yield_curve_snapshot = self.store.get_yield_curve_snapshot(effective_date)
        if yield_curve_snapshot:
            payload["historicalReplay"]["yieldCurveEffectiveDate"] = yield_curve_snapshot.get("effectiveDate", '')
            payload["historicalReplay"]["yieldCurveSource"] = yield_curve_snapshot.get("source", '')
            payload["historicalReplay"]["yieldCurvePoints"] = list(yield_curve_snapshot.get("points") or [])

        expiry_dates = sorted({
            normalized_expiry
            for normalized_expiry in (
                normalize_history_lookup_date(opt.get('expDate') or opt.get('expiry'))
                for opt in options_data
            )
            if normalized_expiry and effective_date and normalized_expiry <= effective_date
        })
        if expiry_dates:
            expiry_underlying_quotes = self.store.get_underlying_snapshots(
                underlying_symbol,
                expiry_dates,
            )
            payload["historicalReplay"]["expiryUnderlyingQuotes"] = {
                date_key: {
                    "requestedDate": snapshot.get("requestedDate", ''),
                    "effectiveDate": snapshot.get("effectiveDate", ''),
                    "price": ((snapshot.get("quote") or {}).get("mark")),
                    "quote": snapshot.get("quote") or {},
                }
                for date_key, snapshot in expiry_underlying_quotes.items()
                if snapshot and isinstance(snapshot, dict)
            }

        for opt in options_data:
            leg_id = opt.get('id')
            if not leg_id:
                continue

            option_symbol = normalize_symbol(opt.get('symbol') or underlying_symbol)
            option_quote = self.store.get_option_snapshot(
                option_symbol,
                effective_date,
                opt.get('expDate') or opt.get('expiry'),
                opt.get('right') or opt.get('type'),
                opt.get('strike'),
            )
            if option_quote:
                payload["options"][leg_id] = option_quote
            else:
                payload["options"][leg_id] = {"missing": True}

        return payload

    def build_underlying_daily_bars_payload(self, symbol, start_date='', end_date='', limit=260):
        normalized_symbol = normalize_symbol(symbol)
        bars = self.store.get_underlying_daily_bars(
            normalized_symbol,
            start_date=start_date,
            end_date=end_date,
            limit=limit,
        )
        if not bars:
            return None

        return {
            "action": "historical_bars_response",
            "symbol": normalized_symbol,
            "barSize": "1 day",
            "dataSource": "historical",
            "bars": bars,
        }
