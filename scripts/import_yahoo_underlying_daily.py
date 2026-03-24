#!/usr/bin/env python3
"""
Import daily underlying prices from Yahoo Finance into the project SQLite DB.

Default behavior:
- uses sqlite_spy/spy_options.db
- uses ticker SPY
- infers the download start/end from that ticker's option quote-date range
- creates the underlying daily table if it does not exist
- upserts rows so the script is safe to rerun after the DB is refreshed

Examples:
    python scripts/import_yahoo_underlying_daily.py
    python scripts/import_yahoo_underlying_daily.py --ticker SPY
    python scripts/import_yahoo_underlying_daily.py --db-path sqlite_spy/spy_options.db
    python scripts/import_yahoo_underlying_daily.py --start 2008-01-02 --end 2025-04-07

Requirements:
    pip install yfinance pandas
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta
from typing import Iterable

import pandas as pd
import yfinance as yf


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS underlying_daily_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_ref INTEGER NOT NULL,
    date_ref INTEGER NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    adj_close REAL,
    volume INTEGER,
    source TEXT NOT NULL DEFAULT 'yfinance',
    FOREIGN KEY (symbol_ref) REFERENCES symbols(symbol_id),
    FOREIGN KEY (date_ref) REFERENCES dates(date_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_underlying_daily_symbol_date
    ON underlying_daily_prices(symbol_ref, date_ref);
CREATE INDEX IF NOT EXISTS idx_underlying_daily_symbol_ref
    ON underlying_daily_prices(symbol_ref);
CREATE INDEX IF NOT EXISTS idx_underlying_daily_date_ref
    ON underlying_daily_prices(date_ref);
"""


def _project_root() -> str:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(script_dir)


def _default_db_path() -> str:
    return os.path.join(_project_root(), "sqlite_spy", "spy_options.db")


def _parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def _format_date(value: date) -> str:
    return value.isoformat()


def _normalize_download_frame(data: pd.DataFrame, ticker: str) -> pd.DataFrame:
    if data is None or data.empty:
        return pd.DataFrame()

    normalized = data.copy()

    if isinstance(normalized.columns, pd.MultiIndex):
        normalized.columns = [
            str(column[0] if isinstance(column, tuple) else column)
            for column in normalized.columns
        ]

    normalized.index = pd.to_datetime(normalized.index)
    if getattr(normalized.index, "tz", None) is not None:
        normalized.index = normalized.index.tz_localize(None)
    normalized = normalized.rename(
        columns={
            "Open": "open",
            "High": "high",
            "Low": "low",
            "Close": "close",
            "Adj Close": "adj_close",
            "Volume": "volume",
        }
    )

    required_columns = {"open", "high", "low", "close", "volume"}
    missing = sorted(required_columns.difference(normalized.columns))
    if missing:
        raise RuntimeError(
            f"Yahoo Finance response for {ticker} is missing columns: {', '.join(missing)}"
        )

    if "adj_close" not in normalized.columns:
        normalized["adj_close"] = normalized["close"]

    normalized = normalized[
        ["open", "high", "low", "close", "adj_close", "volume"]
    ].copy()
    normalized = normalized[normalized["close"].notna()]
    return normalized


def _download_daily_prices(ticker: str, start_date: date, end_date: date) -> pd.DataFrame:
    yahoo_end = end_date + timedelta(days=1)
    data = yf.download(
        ticker,
        start=_format_date(start_date),
        end=_format_date(yahoo_end),
        interval="1d",
        auto_adjust=False,
        actions=False,
        progress=False,
    )
    return _normalize_download_frame(data, ticker)


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)


def _get_symbol_id(conn: sqlite3.Connection, ticker: str) -> int:
    row = conn.execute(
        "SELECT symbol_id FROM symbols WHERE symbol = ?",
        (ticker,),
    ).fetchone()
    if row:
        return int(row[0])

    cursor = conn.execute(
        "INSERT INTO symbols (symbol) VALUES (?)",
        (ticker,),
    )
    return int(cursor.lastrowid)


def _build_existing_date_cache(conn: sqlite3.Connection) -> dict[str, int]:
    rows = conn.execute(
        "SELECT date_id, date FROM dates"
    ).fetchall()
    return {str(row[1]): int(row[0]) for row in rows}


def _get_or_create_date_id(
    conn: sqlite3.Connection,
    date_cache: dict[str, int],
    iso_date: str,
) -> int:
    date_id = date_cache.get(iso_date)
    if date_id is not None:
        return date_id

    cursor = conn.execute(
        "INSERT INTO dates (date) VALUES (?)",
        (iso_date,),
    )
    date_id = int(cursor.lastrowid)
    date_cache[iso_date] = date_id
    return date_id


def _resolve_option_quote_date_range(
    conn: sqlite3.Connection,
    ticker: str,
) -> tuple[date, date]:
    row = conn.execute(
        """
        SELECT MIN(d.date), MAX(d.date)
        FROM options_data od
        JOIN symbols s ON s.symbol_id = od.symbol_ref
        JOIN dates d ON d.date_id = od.date_ref
        WHERE s.symbol = ?
        """,
        (ticker,),
    ).fetchone()

    if not row or not row[0] or not row[1]:
        raise RuntimeError(
            f"Could not infer quote-date range for {ticker} from options_data. "
            f"Pass --start and --end explicitly."
        )

    return _parse_date(str(row[0])), _parse_date(str(row[1]))


def _coerce_optional_float(value: object) -> float | None:
    if value is None or pd.isna(value):
        return None
    return float(value)


def _coerce_optional_int(value: object) -> int | None:
    if value is None or pd.isna(value):
        return None
    return int(value)


def _build_upsert_rows(
    conn: sqlite3.Connection,
    ticker: str,
    frame: pd.DataFrame,
) -> list[tuple[object, ...]]:
    symbol_id = _get_symbol_id(conn, ticker)
    date_cache = _build_existing_date_cache(conn)
    rows: list[tuple[object, ...]] = []

    for trade_ts, row in frame.iterrows():
        trade_date = pd.Timestamp(trade_ts).date().isoformat()
        date_id = _get_or_create_date_id(conn, date_cache, trade_date)
        rows.append(
            (
                symbol_id,
                date_id,
                _coerce_optional_float(row.get("open")),
                _coerce_optional_float(row.get("high")),
                _coerce_optional_float(row.get("low")),
                _coerce_optional_float(row.get("close")),
                _coerce_optional_float(row.get("adj_close")),
                _coerce_optional_int(row.get("volume")),
                "yfinance",
            )
        )

    return rows


def _upsert_rows(conn: sqlite3.Connection, rows: Iterable[tuple[object, ...]]) -> int:
    materialized_rows = list(rows)
    if not materialized_rows:
        return 0

    conn.executemany(
        """
        INSERT INTO underlying_daily_prices (
            symbol_ref,
            date_ref,
            open,
            high,
            low,
            close,
            adj_close,
            volume,
            source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol_ref, date_ref) DO UPDATE SET
            open = excluded.open,
            high = excluded.high,
            low = excluded.low,
            close = excluded.close,
            adj_close = excluded.adj_close,
            volume = excluded.volume,
            source = excluded.source
        """,
        materialized_rows,
    )
    return len(materialized_rows)


def _count_rows_in_range(
    conn: sqlite3.Connection,
    ticker: str,
    start_date: date,
    end_date: date,
) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*)
        FROM underlying_daily_prices udp
        JOIN symbols s ON s.symbol_id = udp.symbol_ref
        JOIN dates d ON d.date_id = udp.date_ref
        WHERE s.symbol = ?
          AND d.date BETWEEN ? AND ?
        """,
        (ticker, _format_date(start_date), _format_date(end_date)),
    ).fetchone()
    return int(row[0]) if row else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download daily underlying prices from Yahoo Finance and insert them into the SQLite DB."
    )
    parser.add_argument(
        "--db-path",
        default=_default_db_path(),
        help="Path to the SQLite DB. Defaults to sqlite_spy/spy_options.db",
    )
    parser.add_argument(
        "--ticker",
        default="SPY",
        help="Yahoo Finance ticker / symbols.symbol value. Defaults to SPY.",
    )
    parser.add_argument(
        "--start",
        help="Inclusive start date in YYYY-MM-DD. Defaults to the earliest option quote_date for the ticker.",
    )
    parser.add_argument(
        "--end",
        help="Inclusive end date in YYYY-MM-DD. Defaults to the latest option quote_date for the ticker.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = os.path.abspath(args.db_path)
    ticker = str(args.ticker or "SPY").strip().upper()

    if not os.path.exists(db_path):
        print(f"ERROR: SQLite DB not found: {db_path}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(db_path)

    try:
        conn.execute("PRAGMA foreign_keys = ON")
        _ensure_schema(conn)

        inferred_start, inferred_end = _resolve_option_quote_date_range(conn, ticker)
        start_date = _parse_date(args.start) if args.start else inferred_start
        end_date = _parse_date(args.end) if args.end else inferred_end

        if start_date > end_date:
            print("ERROR: start date cannot be later than end date.", file=sys.stderr)
            return 1

        print(f"DB: {db_path}")
        print(f"Ticker: {ticker}")
        print(f"Quote-date range in options DB: {inferred_start} -> {inferred_end}")
        print(f"Download range: {start_date} -> {end_date}")

        existing_before = _count_rows_in_range(conn, ticker, start_date, end_date)
        frame = _download_daily_prices(ticker, start_date, end_date)
        if frame.empty:
            print(
                f"ERROR: Yahoo Finance returned no daily data for {ticker} in {start_date} -> {end_date}.",
                file=sys.stderr,
            )
            return 1

        rows = _build_upsert_rows(conn, ticker, frame)
        upserted = _upsert_rows(conn, rows)
        conn.commit()

        existing_after = _count_rows_in_range(conn, ticker, start_date, end_date)
        print(f"Downloaded rows: {len(frame)}")
        print(f"Rows previously in DB for range: {existing_before}")
        print(f"Rows upserted: {upserted}")
        print(f"Rows now in DB for range: {existing_after}")
        print("Done.")
        return 0
    except Exception as exc:
        conn.rollback()
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
