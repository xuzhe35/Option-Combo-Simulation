#!/usr/bin/env python3
"""Backfill the legacy Treasury rates.db cache.

The live application uses ``python -m yield_curve update`` and JSON snapshots.
This compatibility command remains for old historical replay dates that have
not yet been migrated. Rates are stored as decimals (0.0542 means 5.42%).

Examples:
    python3 scripts/import_treasury_risk_free_rate.py
    python3 scripts/import_treasury_risk_free_rate.py --proxy-tenor 3m
    python3 scripts/import_treasury_risk_free_rate.py --start 2026-01-01
"""

import argparse
import os
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from treasury_yield_curve import (  # noqa: E402
    DEFAULT_INCREMENTAL_OVERLAP_DAYS,
    TREASURY_CURVE_SOURCE,
    TreasuryYieldCurveProvider,
    normalize_date,
    normalize_tenor,
)


DEFAULT_DB_PATH = PROJECT_ROOT / "sqlite_spy" / "rates.db"


def _infer_legacy_date_bounds(db_path):
    """Find an initial range in a legacy DB when no curve exists yet."""
    conn = sqlite3.connect(str(db_path))
    try:
        for sql in (
            """
            SELECT MIN(d.date), MAX(d.date)
            FROM risk_free_daily_rates rf
            JOIN dates d ON d.date_id = rf.date_ref
            """,
            """
            SELECT MIN(d.date), MAX(d.date)
            FROM options_data od
            JOIN dates d ON d.date_id = od.date_ref
            """,
        ):
            try:
                row = conn.execute(sql).fetchone()
            except sqlite3.OperationalError:
                continue
            if row and row[0] and row[1]:
                return normalize_date(str(row[0])), normalize_date(str(row[1]))
    finally:
        conn.close()
    return None


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Download the official U.S. Treasury daily nominal par-yield curve "
            "and atomically update the local rates cache."
        )
    )
    parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help="SQLite cache path (default: sqlite_spy/rates.db)",
    )
    parser.add_argument(
        "--proxy-tenor",
        default="3m",
        help="Par-yield tenor copied to the legacy scalar-rate table (default: 3m)",
    )
    parser.add_argument("--tenor", dest="proxy_tenor_legacy", help=argparse.SUPPRESS)
    parser.add_argument("--start", help="Inclusive YYYY-MM-DD start date")
    parser.add_argument(
        "--end",
        help="Inclusive YYYY-MM-DD end date (default: today)",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    db_path = os.path.abspath(args.db_path)
    if not os.path.exists(db_path):
        print("ERROR: SQLite DB not found: {}".format(db_path), file=sys.stderr)
        return 1

    try:
        proxy_tenor = normalize_tenor(args.proxy_tenor_legacy or args.proxy_tenor)
        end_date = normalize_date(args.end) if args.end else date.today()
    except ValueError as exc:
        print("ERROR: {}".format(exc), file=sys.stderr)
        return 1

    provider = TreasuryYieldCurveProvider(db_path)
    curve_bounds = provider.curve_date_bounds()
    legacy_bounds = curve_bounds or _infer_legacy_date_bounds(db_path)
    if args.start:
        try:
            start_date = normalize_date(args.start)
        except ValueError as exc:
            print("ERROR: {}".format(exc), file=sys.stderr)
            return 1
    elif curve_bounds:
        start_date = max(
            curve_bounds[0],
            curve_bounds[1] - timedelta(days=DEFAULT_INCREMENTAL_OVERLAP_DAYS),
        )
    elif legacy_bounds:
        start_date = legacy_bounds[0]
    else:
        print(
            "ERROR: Could not infer a starting date; pass --start explicitly.",
            file=sys.stderr,
        )
        return 1

    if start_date > end_date:
        print("ERROR: start date cannot be later than end date.", file=sys.stderr)
        return 1

    print("DB: {}".format(db_path))
    print("Source: U.S. Treasury Daily Treasury Par Yield Curve XML feed")
    print("Curve semantics: official par yields; not an official zero-coupon curve")
    print("Proxy tenor: {}".format(proxy_tenor))
    if curve_bounds:
        print("Existing official curve bounds: {} -> {}".format(*curve_bounds))
    print("Download range: {} -> {}".format(start_date, end_date))

    try:
        result = provider.refresh(start_date, end_date, proxy_tenor=proxy_tenor)
    except Exception as exc:
        print("ERROR: {}".format(exc), file=sys.stderr)
        return 1

    print("Downloaded observations: {}".format(result["observationCount"]))
    print("Curve points upserted: {}".format(result["curvePointUpsertCount"]))
    print("Scalar proxy rows upserted: {}".format(result["proxyUpsertCount"]))
    print("Latest effective date: {}".format(result["latestEffectiveDate"]))
    print("Cache update: atomic SQLite transaction")
    print("Stored rate values as decimals (example: 0.0542 for 5.42%).")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
