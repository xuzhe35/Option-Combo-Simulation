#!/usr/bin/env python3
"""
Import the U.S. Treasury daily yield curve history plus a synchronized single-rate proxy.

Default behavior:
- uses sqlite_spy/spy_options.db
- uses today as the default end date
- stores the full Treasury par-yield curve in yield_curve_daily_rates
- syncs one selected tenor into risk_free_daily_rates for the app's current single `r`
- stores rates as decimals (for example 0.0542 for 5.42%)
- uses an overlap window when rerun so monthly updates are incremental but still refresh
  the most recent data

By default this script syncs the Treasury 3-month par yield into
risk_free_daily_rates because the app currently has only one `r` input.

Examples:
    python scripts/import_treasury_risk_free_rate.py
    python scripts/import_treasury_risk_free_rate.py --proxy-tenor 3m
    python scripts/import_treasury_risk_free_rate.py --db-path sqlite_spy/spy_options.db
    python scripts/import_treasury_risk_free_rate.py --start 2008-01-02 --end 2025-04-07
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from typing import Iterable


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS risk_free_daily_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_ref INTEGER NOT NULL UNIQUE,
    rate REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'treasury:daily_treasury_yield_curve:3m',
    FOREIGN KEY (date_ref) REFERENCES dates(date_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_free_daily_date
    ON risk_free_daily_rates(date_ref);
CREATE INDEX IF NOT EXISTS idx_risk_free_daily_rate
    ON risk_free_daily_rates(rate);

CREATE TABLE IF NOT EXISTS yield_curve_daily_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_ref INTEGER NOT NULL,
    tenor_code TEXT NOT NULL,
    tenor_days INTEGER NOT NULL,
    rate REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'treasury:daily_treasury_yield_curve',
    FOREIGN KEY (date_ref) REFERENCES dates(date_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_yield_curve_daily_date_tenor_source
    ON yield_curve_daily_rates(date_ref, tenor_code, source);
CREATE INDEX IF NOT EXISTS idx_yield_curve_daily_date_ref
    ON yield_curve_daily_rates(date_ref);
CREATE INDEX IF NOT EXISTS idx_yield_curve_daily_tenor_code
    ON yield_curve_daily_rates(tenor_code);
"""

TREASURY_CURVE_SOURCE = "treasury:daily_treasury_yield_curve"
INCREMENTAL_OVERLAP_DAYS = 31

TREASURY_XML_URL_TEMPLATE = (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml"
    "?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
)

ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}
DATA_NS = {
    "m": "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata",
    "d": "http://schemas.microsoft.com/ado/2007/08/dataservices",
}

TENOR_METADATA = {
    "1m": {"field": "BC_1MONTH", "days": 30},
    "2m": {"field": "BC_2MONTH", "days": 61},
    "3m": {"field": "BC_3MONTH", "days": 91},
    "4m": {"field": "BC_4MONTH", "days": 122},
    "6m": {"field": "BC_6MONTH", "days": 182},
    "1y": {"field": "BC_1YEAR", "days": 365},
    "2y": {"field": "BC_2YEAR", "days": 730},
    "3y": {"field": "BC_3YEAR", "days": 1095},
    "5y": {"field": "BC_5YEAR", "days": 1825},
    "7y": {"field": "BC_7YEAR", "days": 2555},
    "10y": {"field": "BC_10YEAR", "days": 3650},
    "20y": {"field": "BC_20YEAR", "days": 7300},
    "30y": {"field": "BC_30YEAR", "days": 10950},
}


def _project_root() -> str:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(script_dir)


def _default_db_path() -> str:
    return os.path.join(_project_root(), "sqlite_spy", "spy_options.db")


def _parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def _format_date(value: date) -> str:
    return value.isoformat()


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)


def _build_existing_date_cache(conn: sqlite3.Connection) -> dict[str, int]:
    rows = conn.execute("SELECT date_id, date FROM dates").fetchall()
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


def _resolve_option_quote_date_range(conn: sqlite3.Connection) -> tuple[date, date]:
    row = conn.execute(
        """
        SELECT MIN(d.date), MAX(d.date)
        FROM options_data od
        JOIN dates d ON d.date_id = od.date_ref
        """
    ).fetchone()

    if not row or not row[0] or not row[1]:
        raise RuntimeError(
            "Could not infer quote-date range from options_data. Pass --start and --end explicitly."
        )

    return _parse_date(str(row[0])), _parse_date(str(row[1]))


def _resolve_existing_curve_max_date(conn: sqlite3.Connection) -> date | None:
    try:
        row = conn.execute(
            """
            SELECT MAX(d.date)
            FROM yield_curve_daily_rates yc
            JOIN dates d ON d.date_id = yc.date_ref
            WHERE yc.source = ?
            """,
            (TREASURY_CURVE_SOURCE,),
        ).fetchone()
    except sqlite3.OperationalError:
        return None

    if not row or not row[0]:
        return None
    return _parse_date(str(row[0]))


def _normalize_tenor(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in TENOR_METADATA:
        supported = ", ".join(sorted(TENOR_METADATA))
        raise RuntimeError(f"Unsupported tenor '{value}'. Supported values: {supported}")
    return normalized


def _fetch_treasury_xml(year: int) -> bytes:
    url = TREASURY_XML_URL_TEMPLATE.format(year=year)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "OptionComboSimulation/1.0 (+https://home.treasury.gov/)",
            "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Treasury feed request failed for {year}: HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Treasury feed request failed for {year}: {exc.reason}") from exc


def _coerce_rate_decimal(value: str | None) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    numeric = float(text)
    if not (numeric == numeric):
        return None
    return numeric / 100.0


def _parse_treasury_year(xml_bytes: bytes) -> list[tuple[str, str, int, float]]:
    root = ET.fromstring(xml_bytes)
    rows: list[tuple[str, str, int, float]] = []

    for entry in root.findall("atom:entry", ATOM_NS):
        properties = entry.find("atom:content/m:properties", {**ATOM_NS, **DATA_NS})
        if properties is None:
            continue

        date_el = properties.find(f"d:NEW_DATE", DATA_NS)
        if date_el is None:
            continue

        date_text = str(date_el.text or "").strip()
        if not date_text:
            continue
        iso_date = date_text.split("T", 1)[0]

        for tenor_code, metadata in TENOR_METADATA.items():
            tenor_el = properties.find(f"d:{metadata['field']}", DATA_NS)
            if tenor_el is None:
                continue

            rate_decimal = _coerce_rate_decimal(tenor_el.text)
            if rate_decimal is None:
                continue

            rows.append((iso_date, tenor_code, int(metadata["days"]), rate_decimal))

    return rows


def _download_yield_curve_rows(start_date: date, end_date: date) -> list[tuple[str, str, int, float]]:
    materialized: list[tuple[str, str, int, float]] = []

    for year in range(start_date.year, end_date.year + 1):
        xml_bytes = _fetch_treasury_xml(year)
        materialized.extend(_parse_treasury_year(xml_bytes))

    start_iso = _format_date(start_date)
    end_iso = _format_date(end_date)
    return [
        (iso_date, tenor_code, tenor_days, rate)
        for iso_date, tenor_code, tenor_days, rate in materialized
        if start_iso <= iso_date <= end_iso
    ]


def _build_curve_upsert_rows(
    conn: sqlite3.Connection,
    rows: list[tuple[str, str, int, float]],
    source: str,
) -> list[tuple[object, ...]]:
    date_cache = _build_existing_date_cache(conn)
    upsert_rows: list[tuple[object, ...]] = []

    for iso_date, tenor_code, tenor_days, rate_decimal in rows:
        date_id = _get_or_create_date_id(conn, date_cache, iso_date)
        upsert_rows.append((date_id, tenor_code, tenor_days, rate_decimal, source))

    return upsert_rows


def _build_proxy_upsert_rows(
    conn: sqlite3.Connection,
    rows: list[tuple[str, str, int, float]],
    proxy_tenor: str,
    source: str,
) -> list[tuple[object, ...]]:
    date_cache = _build_existing_date_cache(conn)
    upsert_rows: list[tuple[object, ...]] = []

    for iso_date, tenor_code, _tenor_days, rate_decimal in rows:
        if tenor_code != proxy_tenor:
            continue
        date_id = _get_or_create_date_id(conn, date_cache, iso_date)
        upsert_rows.append((date_id, rate_decimal, source))

    return upsert_rows


def _upsert_curve_rows(conn: sqlite3.Connection, rows: Iterable[tuple[object, ...]]) -> int:
    materialized_rows = list(rows)
    if not materialized_rows:
        return 0

    conn.executemany(
        """
        INSERT INTO yield_curve_daily_rates (
            date_ref,
            tenor_code,
            tenor_days,
            rate,
            source
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date_ref, tenor_code, source) DO UPDATE SET
            tenor_days = excluded.tenor_days,
            rate = excluded.rate
        """,
        materialized_rows,
    )
    return len(materialized_rows)


def _upsert_proxy_rows(conn: sqlite3.Connection, rows: Iterable[tuple[object, ...]]) -> int:
    materialized_rows = list(rows)
    if not materialized_rows:
        return 0

    conn.executemany(
        """
        INSERT INTO risk_free_daily_rates (
            date_ref,
            rate,
            source
        )
        VALUES (?, ?, ?)
        ON CONFLICT(date_ref) DO UPDATE SET
            rate = excluded.rate,
            source = excluded.source
        """,
        materialized_rows,
    )
    return len(materialized_rows)


def _count_proxy_rows_in_range(
    conn: sqlite3.Connection,
    start_date: date,
    end_date: date,
) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*)
        FROM risk_free_daily_rates rf
        JOIN dates d ON d.date_id = rf.date_ref
        WHERE d.date BETWEEN ? AND ?
        """,
        (_format_date(start_date), _format_date(end_date)),
    ).fetchone()
    return int(row[0]) if row else 0


def _count_curve_rows_in_range(
    conn: sqlite3.Connection,
    start_date: date,
    end_date: date,
) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*)
        FROM yield_curve_daily_rates yc
        JOIN dates d ON d.date_id = yc.date_ref
        WHERE d.date BETWEEN ? AND ?
          AND yc.source = ?
        """,
        (_format_date(start_date), _format_date(end_date), TREASURY_CURVE_SOURCE),
    ).fetchone()
    return int(row[0]) if row else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download a daily risk-free proxy rate from the U.S. Treasury XML feed and insert it into the SQLite DB."
    )
    parser.add_argument(
        "--db-path",
        default=_default_db_path(),
        help="Path to the SQLite DB. Defaults to sqlite_spy/spy_options.db",
    )
    parser.add_argument(
        "--proxy-tenor",
        default="3m",
        help="Treasury tenor to sync into risk_free_daily_rates. Defaults to 3m.",
    )
    parser.add_argument(
        "--tenor",
        dest="proxy_tenor_legacy",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--start",
        help="Inclusive start date in YYYY-MM-DD. Defaults to the earliest option quote_date in the DB.",
    )
    parser.add_argument(
        "--end",
        help="Inclusive end date in YYYY-MM-DD. Defaults to today.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = os.path.abspath(args.db_path)
    proxy_tenor = _normalize_tenor(args.proxy_tenor_legacy or args.proxy_tenor)
    proxy_source = f"{TREASURY_CURVE_SOURCE}:{proxy_tenor}"

    if not os.path.exists(db_path):
        print(f"ERROR: SQLite DB not found: {db_path}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(db_path)

    try:
        conn.execute("PRAGMA foreign_keys = ON")
        _ensure_schema(conn)

        inferred_start, inferred_end = _resolve_option_quote_date_range(conn)
        today = date.today()
        end_date = _parse_date(args.end) if args.end else today
        existing_curve_max = _resolve_existing_curve_max_date(conn)
        if args.start:
            start_date = _parse_date(args.start)
        elif existing_curve_max is not None:
            start_date = max(
                inferred_start,
                existing_curve_max - timedelta(days=INCREMENTAL_OVERLAP_DAYS),
            )
        else:
            start_date = inferred_start

        if start_date > end_date:
            print("ERROR: start date cannot be later than end date.", file=sys.stderr)
            return 1

        print(f"DB: {db_path}")
        print("Source: U.S. Treasury Daily Treasury Par Yield Curve XML feed")
        print(f"Proxy tenor: {proxy_tenor}")
        print(f"Quote-date range in options DB: {inferred_start} -> {inferred_end}")
        print(f"Default end date basis: {today}")
        if existing_curve_max is not None:
            print(f"Existing curve max date in DB: {existing_curve_max}")
        print(f"Download range: {start_date} -> {end_date}")

        curve_before = _count_curve_rows_in_range(conn, start_date, end_date)
        proxy_before = _count_proxy_rows_in_range(conn, start_date, end_date)
        downloaded_rows = _download_yield_curve_rows(start_date, end_date)
        if not downloaded_rows:
            print(
                f"ERROR: Treasury feed returned no yield-curve data in {start_date} -> {end_date}.",
                file=sys.stderr,
            )
            return 1

        curve_rows = _build_curve_upsert_rows(conn, downloaded_rows, TREASURY_CURVE_SOURCE)
        proxy_rows = _build_proxy_upsert_rows(conn, downloaded_rows, proxy_tenor, proxy_source)
        curve_upserted = _upsert_curve_rows(conn, curve_rows)
        proxy_upserted = _upsert_proxy_rows(conn, proxy_rows)
        conn.commit()

        curve_after = _count_curve_rows_in_range(conn, start_date, end_date)
        proxy_after = _count_proxy_rows_in_range(conn, start_date, end_date)
        print(f"Downloaded curve points: {len(downloaded_rows)}")
        print(f"Curve rows previously in DB for range: {curve_before}")
        print(f"Curve rows upserted: {curve_upserted}")
        print(f"Curve rows now in DB for range: {curve_after}")
        print(f"Proxy rows previously in DB for range: {proxy_before}")
        print(f"Proxy rows upserted: {proxy_upserted}")
        print(f"Proxy rows now in DB for range: {proxy_after}")
        print("Stored rate values as decimals (example: 0.0542 for 5.42%).")
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
