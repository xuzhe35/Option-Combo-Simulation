import os
import sqlite3
from datetime import datetime


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


class HistoricalReplayStore:
    def __init__(self, db_path, logger=None):
        self.db_path = os.path.abspath(db_path)
        self.logger = logger

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _log(self, level, message):
        if self.logger and hasattr(self.logger, level):
            getattr(self.logger, level)(message)

    def _get_latest_underlying_date(self, conn, symbol):
        row = conn.execute(
            """
            SELECT MAX(d.date)
            FROM underlying_daily_prices udp
            JOIN symbols s ON s.symbol_id = udp.symbol_ref
            JOIN dates d ON d.date_id = udp.date_ref
            WHERE s.symbol = ?
            """,
            (symbol,),
        ).fetchone()
        return str(row[0]) if row and row[0] else ''

    def _get_latest_risk_free_date(self, conn):
        row = conn.execute(
            """
            SELECT MAX(d.date)
            FROM risk_free_daily_rates rf
            JOIN dates d ON d.date_id = rf.date_ref
            """
        ).fetchone()
        return str(row[0]) if row and row[0] else ''

    def _resolve_effective_underlying_date(self, conn, symbol, requested_date=''):
        if requested_date:
            row = conn.execute(
                """
                SELECT MAX(d.date)
                FROM underlying_daily_prices udp
                JOIN symbols s ON s.symbol_id = udp.symbol_ref
                JOIN dates d ON d.date_id = udp.date_ref
                WHERE s.symbol = ?
                  AND d.date <= ?
                """,
                (symbol, requested_date),
            ).fetchone()
            if row and row[0]:
                return str(row[0])

        return self._get_latest_underlying_date(conn, symbol)

    def _resolve_effective_risk_free_date(self, conn, requested_date=''):
        if requested_date:
            row = conn.execute(
                """
                SELECT MAX(d.date)
                FROM risk_free_daily_rates rf
                JOIN dates d ON d.date_id = rf.date_ref
                WHERE d.date <= ?
                """,
                (requested_date,),
            ).fetchone()
            if row and row[0]:
                return str(row[0])

        return self._get_latest_risk_free_date(conn)

    def _resolve_effective_yield_curve_date(self, conn, requested_date=''):
        if requested_date:
            row = conn.execute(
                """
                SELECT MAX(d.date)
                FROM yield_curve_daily_rates yc
                JOIN dates d ON d.date_id = yc.date_ref
                WHERE d.date <= ?
                """,
                (requested_date,),
            ).fetchone()
            if row and row[0]:
                return str(row[0])

        row = conn.execute(
            """
            SELECT MAX(d.date)
            FROM yield_curve_daily_rates yc
            JOIN dates d ON d.date_id = yc.date_ref
            """
        ).fetchone()
        return str(row[0]) if row and row[0] else ''

    def get_underlying_date_bounds(self, symbol):
        normalized_symbol = str(symbol or '').strip().upper()

        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT MIN(d.date) AS start_date, MAX(d.date) AS end_date
                FROM underlying_daily_prices udp
                JOIN symbols s ON s.symbol_id = udp.symbol_ref
                JOIN dates d ON d.date_id = udp.date_ref
                WHERE s.symbol = ?
                """,
                (normalized_symbol,),
            ).fetchone()

        if not row or not row['start_date'] or not row['end_date']:
            return None

        return {
            'startDate': str(row['start_date']),
            'endDate': str(row['end_date']),
        }

    def get_underlying_snapshot(self, symbol, quote_date=''):
        normalized_symbol = str(symbol or '').strip().upper()
        requested_date = _normalize_iso_date(quote_date) if quote_date else ''

        with self._connect() as conn:
            effective_date = self._resolve_effective_underlying_date(conn, normalized_symbol, requested_date)
            if not effective_date:
                return None

            row = conn.execute(
                """
                SELECT d.date, udp.open, udp.high, udp.low, udp.close, udp.adj_close, udp.volume, udp.source
                FROM underlying_daily_prices udp
                JOIN symbols s ON s.symbol_id = udp.symbol_ref
                JOIN dates d ON d.date_id = udp.date_ref
                WHERE s.symbol = ?
                  AND d.date = ?
                LIMIT 1
                """,
                (normalized_symbol, effective_date),
            ).fetchone()

        if not row:
            return None

        close_price = float(row['close']) if row['close'] is not None else None
        if close_price is None:
            return None

        return {
            'requestedDate': requested_date,
            'effectiveDate': str(row['date']),
            'quote': {
                'bid': round(close_price, 4),
                'ask': round(close_price, 4),
                'mark': round(close_price, 4),
                'open': row['open'],
                'high': row['high'],
                'low': row['low'],
                'close': row['close'],
                'adjClose': row['adj_close'],
                'volume': row['volume'],
                'source': row['source'],
            },
        }

    def get_underlying_snapshots(self, symbol, requested_dates):
        normalized_symbol = str(symbol or '').strip().upper()
        normalized_dates = []
        for raw_date in requested_dates or []:
            normalized_date = _normalize_iso_date(raw_date) if raw_date else ''
            if normalized_date and normalized_date not in normalized_dates:
                normalized_dates.append(normalized_date)

        if not normalized_symbol or not normalized_dates:
            return {}

        with self._connect() as conn:
            snapshots = {}
            for requested_date in normalized_dates:
                effective_date = self._resolve_effective_underlying_date(conn, normalized_symbol, requested_date)
                if not effective_date:
                    continue

                row = conn.execute(
                    """
                    SELECT d.date, udp.open, udp.high, udp.low, udp.close, udp.adj_close, udp.volume, udp.source
                    FROM underlying_daily_prices udp
                    JOIN symbols s ON s.symbol_id = udp.symbol_ref
                    JOIN dates d ON d.date_id = udp.date_ref
                    WHERE s.symbol = ?
                      AND d.date = ?
                    LIMIT 1
                    """,
                    (normalized_symbol, effective_date),
                ).fetchone()

                if not row or row['close'] is None:
                    continue

                close_price = float(row['close'])
                snapshots[requested_date] = {
                    'requestedDate': requested_date,
                    'effectiveDate': str(row['date']),
                    'quote': {
                        'bid': round(close_price, 4),
                        'ask': round(close_price, 4),
                        'mark': round(close_price, 4),
                        'open': row['open'],
                        'high': row['high'],
                        'low': row['low'],
                        'close': row['close'],
                        'adjClose': row['adj_close'],
                        'volume': row['volume'],
                        'source': row['source'],
                    },
                }

        return snapshots

    def get_underlying_daily_bars(self, symbol, start_date='', end_date='', limit=260):
        normalized_symbol = str(symbol or '').strip().upper()
        normalized_start = _normalize_iso_date(start_date) if start_date else ''
        normalized_end = _normalize_iso_date(end_date) if end_date else ''

        try:
            limit_value = int(limit)
        except (TypeError, ValueError):
            limit_value = 260
        if limit_value <= 0:
            limit_value = 260

        if not normalized_symbol:
            return []

        filters = ['s.symbol = ?']
        params = [normalized_symbol]
        if normalized_start:
            filters.append('d.date >= ?')
            params.append(normalized_start)
        if normalized_end:
            filters.append('d.date <= ?')
            params.append(normalized_end)

        where_sql = ' AND '.join(filters)

        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT d.date, udp.open, udp.high, udp.low, udp.close, udp.adj_close, udp.volume, udp.source
                FROM underlying_daily_prices udp
                JOIN symbols s ON s.symbol_id = udp.symbol_ref
                JOIN dates d ON d.date_id = udp.date_ref
                WHERE {where_sql}
                ORDER BY d.date DESC
                LIMIT ?
                """,
                (*params, limit_value),
            ).fetchall()

        ordered_rows = list(reversed(rows))
        bars = []
        for row in ordered_rows:
            if row['open'] is None or row['high'] is None or row['low'] is None or row['close'] is None:
                continue
            bars.append({
                'time': str(row['date']),
                'open': float(row['open']),
                'high': float(row['high']),
                'low': float(row['low']),
                'close': float(row['close']),
                'adjClose': float(row['adj_close']) if row['adj_close'] is not None else None,
                'volume': int(row['volume']) if row['volume'] is not None else None,
                'source': str(row['source'] or ''),
            })

        return bars

    def get_option_snapshot(self, symbol, quote_date, expiry_date, option_type, strike):
        normalized_symbol = str(symbol or '').strip().upper()
        normalized_quote_date = _normalize_iso_date(quote_date)
        normalized_expiry = _normalize_expiry_date(expiry_date)
        normalized_type = _normalize_option_type(option_type)
        strike_value = float(strike)

        if not normalized_symbol or not normalized_quote_date or not normalized_expiry or not normalized_type:
            return None

        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT od.bid, od.ask, od.mark, od.last, od.implied_volatility, od.volume, od.open_interest
                FROM options_data od
                JOIN symbols s ON s.symbol_id = od.symbol_ref
                JOIN dates dq ON dq.date_id = od.date_ref
                JOIN dates de ON de.date_id = od.expiration_ref
                WHERE s.symbol = ?
                  AND dq.date = ?
                  AND de.date = ?
                  AND od.type = ?
                  AND ABS(od.strike - ?) < 0.0001
                ORDER BY od.id
                LIMIT 1
                """,
                (
                    normalized_symbol,
                    normalized_quote_date,
                    normalized_expiry,
                    normalized_type,
                    strike_value,
                ),
            ).fetchone()

        if not row:
            return None

        bid = float(row['bid']) if row['bid'] is not None else None
        ask = float(row['ask']) if row['ask'] is not None else None
        mark = None

        if _is_positive_number(bid) and _is_positive_number(ask):
            mark = round((float(bid) + float(ask)) / 2.0, 4)
        elif _is_positive_number(row['mark']):
            mark = round(float(row['mark']), 4)
        elif _is_positive_number(row['last']):
            mark = round(float(row['last']), 4)

        quote = {}
        if _is_positive_number(bid):
            quote['bid'] = round(float(bid), 4)
        if _is_positive_number(ask):
            quote['ask'] = round(float(ask), 4)
        if mark is not None:
            quote['mark'] = mark
            quote.setdefault('bid', mark)
            quote.setdefault('ask', mark)

        if _is_positive_number(row['implied_volatility']):
            quote['iv'] = float(row['implied_volatility'])
        if row['volume'] is not None:
            quote['volume'] = row['volume']
        if row['open_interest'] is not None:
            quote['openInterest'] = row['open_interest']

        return quote if quote else None

    def get_risk_free_rate_snapshot(self, quote_date=''):
        requested_date = _normalize_iso_date(quote_date) if quote_date else ''

        try:
            with self._connect() as conn:
                effective_date = self._resolve_effective_risk_free_date(conn, requested_date)
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
            with self._connect() as conn:
                effective_date = self._resolve_effective_yield_curve_date(conn, requested_date)
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
