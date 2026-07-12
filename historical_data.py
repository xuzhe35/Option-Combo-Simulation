"""Historical replay data access.

Option chains and underlying daily bars come from the shared options-chain
microservice (Options DB workspace, default http://127.0.0.1:8750) instead of
a bundled multi-GB SQLite copy. Risk-free rates and the treasury yield curve
are not part of that service; they live in the small local sqlite_spy/rates.db
(extracted from the legacy DB by scripts/extract_rates_db.py).

The public surface (HistoricalReplayStore method names, arguments, and return
shapes) is unchanged from the bundled-SQLite implementation, so
historical_replay_service.py and both websocket servers work as before.
"""

import json
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime


DEFAULT_CHAIN_SERVICE_URL = 'http://127.0.0.1:8750'
DEFAULT_RATES_DB = os.path.join('sqlite_spy', 'rates.db')
_LATEST_SENTINEL_DATE = '2999-12-31'


def _normalize_iso_date(value):
    text = str(value or '').strip().replace('/', '-')
    if not text:
        return ''
    for fmt in ('%Y-%m-%d', '%Y%m%d'):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return ''


def _normalize_expiry_date(value):
    text = str(value or '').strip().replace('-', '').replace('/', '')
    if not text:
        return ''
    return datetime.strptime(text, '%Y%m%d').date().isoformat()


def _normalize_option_type(value):
    text = str(value or '').strip().upper()
    if text == 'C':
        return 'call'
    if text == 'P':
        return 'put'
    lowered = text.lower()
    if lowered in ('call', 'put'):
        return lowered
    return ''


def _is_positive_number(value):
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return False
    return numeric == numeric and numeric > 0


class ChainServiceError(RuntimeError):
    """The options chain service is unreachable or returned a server error."""


class HistoricalReplayStore:
    def __init__(self, chain_service_url=DEFAULT_CHAIN_SERVICE_URL,
                 rates_db_path=DEFAULT_RATES_DB, logger=None, timeout=10.0):
        self.chain_service_url = str(chain_service_url or DEFAULT_CHAIN_SERVICE_URL).rstrip('/')
        self.rates_db_path = os.path.abspath(rates_db_path) if rates_db_path else ''
        self.logger = logger
        self.timeout = timeout

    # ------------------------- chain service HTTP ------------------------- #

    def _log(self, level, message):
        if self.logger and hasattr(self.logger, level):
            getattr(self.logger, level)(message)

    def _get(self, path, params):
        query = urllib.parse.urlencode(
            {key: value for key, value in params.items() if value not in (None, '')}
        )
        url = f"{self.chain_service_url}{path}?{query}" if query else f"{self.chain_service_url}{path}"
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            body = ''
            try:
                body = exc.read().decode('utf-8', 'replace')
            except Exception:
                pass
            raise ChainServiceError(
                f"options chain service error {exc.code} for {path}: {body[:200]}"
            )
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise ChainServiceError(
                f"options chain service unreachable at {self.chain_service_url} "
                f"({exc}). Start it with: python3 chain_server.py "
                f"(Options DB/chain_service/)"
            )

    def check_service(self):
        """Return the /health payload, raising ChainServiceError when down."""
        return self._get('/health', {})

    # --------------------------- underlying data -------------------------- #

    def get_underlying_date_bounds(self, symbol):
        normalized_symbol = str(symbol or '').strip().upper()
        if not normalized_symbol:
            return None
        payload = self._get('/v1/symbols', {})
        for entry in (payload or {}).get('symbols', []):
            if entry.get('symbol') == normalized_symbol:
                start = entry.get('chainFirstDate')
                end = entry.get('chainLastDate')
                if start and end:
                    return {'startDate': str(start), 'endDate': str(end)}
        return None

    def get_trading_dates(self, symbol, start_date='', end_date=''):
        """Return observed exchange sessions from the chain service.

        This is historical evidence, not a holiday-rule calculation. It is
        used only when the downloaded forward official snapshot does not
        cover an old replay range.
        """
        normalized_symbol = str(symbol or '').strip().upper()
        if not normalized_symbol:
            return []
        payload = self._get('/v1/trading-dates', {
            'symbol': normalized_symbol,
            'start': _normalize_iso_date(start_date) if start_date else '1900-01-01',
            'end': _normalize_iso_date(end_date) if end_date else _LATEST_SENTINEL_DATE,
        })
        dates = []
        for value in (payload or {}).get('dates', []):
            normalized = _normalize_iso_date(value)
            if normalized:
                dates.append(normalized)
        return sorted(set(dates))

    def _underlying_snapshot_from_bar(self, requested_date, payload):
        bar = (payload or {}).get('bar') or {}
        close_price = bar.get('close')
        if close_price is None:
            return None
        close_price = float(close_price)
        return {
            'requestedDate': requested_date,
            'effectiveDate': str(payload.get('effectiveDate') or bar.get('date') or ''),
            'quote': {
                'bid': round(close_price, 4),
                'ask': round(close_price, 4),
                'mark': round(close_price, 4),
                'open': bar.get('open'),
                'high': bar.get('high'),
                'low': bar.get('low'),
                'close': bar.get('close'),
                'adjClose': None,
                'volume': bar.get('volume'),
                'source': 'chain_service:databento_eod',
            },
        }

    def get_underlying_snapshot(self, symbol, quote_date=''):
        normalized_symbol = str(symbol or '').strip().upper()
        if not normalized_symbol:
            return None
        requested_date = _normalize_iso_date(quote_date) if quote_date else ''
        lookup_date = requested_date or _LATEST_SENTINEL_DATE
        payload = self._get('/v1/underlying', {
            'symbol': normalized_symbol,
            'date': lookup_date,
            'mode': 'on_or_before',
        })
        if payload is None:
            return None
        return self._underlying_snapshot_from_bar(requested_date, payload)

    def get_underlying_snapshots(self, symbol, requested_dates):
        normalized_symbol = str(symbol or '').strip().upper()
        normalized_dates = []
        for raw_date in requested_dates or []:
            normalized_date = _normalize_iso_date(raw_date) if raw_date else ''
            if normalized_date and normalized_date not in normalized_dates:
                normalized_dates.append(normalized_date)

        if not normalized_symbol or not normalized_dates:
            return {}

        snapshots = {}
        for requested_date in normalized_dates:
            payload = self._get('/v1/underlying', {
                'symbol': normalized_symbol,
                'date': requested_date,
                'mode': 'on_or_before',
            })
            if payload is None:
                continue
            snapshot = self._underlying_snapshot_from_bar(requested_date, payload)
            if snapshot:
                snapshots[requested_date] = snapshot
        return snapshots

    def get_underlying_daily_bars(self, symbol, start_date='', end_date='', limit=260):
        normalized_symbol = str(symbol or '').strip().upper()
        if not normalized_symbol:
            return []

        try:
            limit_value = int(limit)
        except (TypeError, ValueError):
            limit_value = 260
        if limit_value <= 0:
            limit_value = 260

        payload = self._get('/v1/underlying-bars', {
            'symbol': normalized_symbol,
            'start': _normalize_iso_date(start_date) if start_date else '',
            'end': _normalize_iso_date(end_date) if end_date else '',
            'limit': limit_value,
        })
        if payload is None:
            return []

        bars = []
        for bar in payload.get('bars', []):
            if bar.get('open') is None or bar.get('high') is None \
                    or bar.get('low') is None or bar.get('close') is None:
                continue
            bars.append({
                'time': str(bar.get('date')),
                'open': float(bar['open']),
                'high': float(bar['high']),
                'low': float(bar['low']),
                'close': float(bar['close']),
                'adjClose': None,
                'volume': int(bar['volume']) if bar.get('volume') is not None else None,
                'source': 'chain_service:databento_eod',
            })
        return bars

    # ----------------------------- option data ---------------------------- #

    def get_option_snapshot(self, symbol, quote_date, expiry_date, option_type, strike):
        normalized_symbol = str(symbol or '').strip().upper()
        normalized_quote_date = _normalize_iso_date(quote_date)
        normalized_expiry = _normalize_expiry_date(expiry_date)
        normalized_type = _normalize_option_type(option_type)
        strike_value = float(strike)

        if not normalized_symbol or not normalized_quote_date \
                or not normalized_expiry or not normalized_type:
            return None

        payload = self._get('/v1/quote', {
            'symbol': normalized_symbol,
            'date': normalized_quote_date,
            'expiration': normalized_expiry,
            'type': normalized_type,
            'strike': strike_value,
            'mode': 'exact',
        })
        if payload is None:
            return None
        service_quote = payload.get('quote') or {}

        bid = service_quote.get('bid')
        ask = service_quote.get('ask')
        mark = None
        if _is_positive_number(bid) and _is_positive_number(ask):
            mark = round((float(bid) + float(ask)) / 2.0, 4)
        elif _is_positive_number(service_quote.get('mark')):
            mark = round(float(service_quote['mark']), 4)
        elif _is_positive_number(service_quote.get('last')):
            mark = round(float(service_quote['last']), 4)

        quote = {}
        if _is_positive_number(bid):
            quote['bid'] = round(float(bid), 4)
        if _is_positive_number(ask):
            quote['ask'] = round(float(ask), 4)
        if mark is not None:
            quote['mark'] = mark
            quote.setdefault('bid', mark)
            quote.setdefault('ask', mark)

        if _is_positive_number(service_quote.get('impliedVolatility')):
            quote['iv'] = float(service_quote['impliedVolatility'])
        if service_quote.get('volume') is not None:
            quote['volume'] = service_quote['volume']
        if service_quote.get('openInterest') is not None:
            quote['openInterest'] = service_quote['openInterest']
        if service_quote.get('nonstandardDeliverable'):
            quote['nonstandardDeliverable'] = True

        return quote if quote else None

    # ------------------------- local rates database ------------------------ #

    def _connect_rates(self):
        conn = sqlite3.connect(self.rates_db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _resolve_effective_rates_date(self, conn, table, requested_date=''):
        if requested_date:
            row = conn.execute(
                f"""
                SELECT MAX(d.date)
                FROM {table} t
                JOIN dates d ON d.date_id = t.date_ref
                WHERE d.date <= ?
                """,
                (requested_date,),
            ).fetchone()
            if row and row[0]:
                return str(row[0])

        row = conn.execute(
            f"""
            SELECT MAX(d.date)
            FROM {table} t
            JOIN dates d ON d.date_id = t.date_ref
            """
        ).fetchone()
        return str(row[0]) if row and row[0] else ''

    def get_risk_free_rate_snapshot(self, quote_date=''):
        requested_date = _normalize_iso_date(quote_date) if quote_date else ''

        try:
            with self._connect_rates() as conn:
                effective_date = self._resolve_effective_rates_date(
                    conn, 'risk_free_daily_rates', requested_date
                )
                if not effective_date:
                    return None

                row = conn.execute(
                    """
                    SELECT d.date, rf.rate, rf.source
                    FROM risk_free_daily_rates rf
                    JOIN dates d ON d.date_id = rf.date_ref
                    WHERE d.date = ?
                    LIMIT 1
                    """,
                    (effective_date,),
                ).fetchone()
        except sqlite3.OperationalError:
            return None

        if not row or row['rate'] is None:
            return None

        return {
            'requestedDate': requested_date,
            'effectiveDate': str(row['date']),
            'rate': float(row['rate']),
            'source': str(row['source'] or ''),
        }

    def get_yield_curve_snapshot(self, quote_date=''):
        requested_date = _normalize_iso_date(quote_date) if quote_date else ''

        try:
            with self._connect_rates() as conn:
                effective_date = self._resolve_effective_rates_date(
                    conn, 'yield_curve_daily_rates', requested_date
                )
                if not effective_date:
                    return None

                rows = conn.execute(
                    """
                    SELECT d.date, yc.tenor_code, yc.tenor_days, yc.rate, yc.source
                    FROM yield_curve_daily_rates yc
                    JOIN dates d ON d.date_id = yc.date_ref
                    WHERE d.date = ?
                    ORDER BY yc.tenor_days ASC, yc.tenor_code ASC
                    """,
                    (effective_date,),
                ).fetchall()
        except sqlite3.OperationalError:
            return None

        if not rows:
            return None

        points = [
            {
                'tenorCode': str(row['tenor_code']),
                'tenorDays': int(row['tenor_days']),
                'rate': float(row['rate']),
            }
            for row in rows
            if row['rate'] is not None
        ]
        if not points:
            return None

        return {
            'requestedDate': requested_date,
            'effectiveDate': str(rows[0]['date']),
            'source': str(rows[0]['source'] or ''),
            'points': points,
        }
