"""Extract risk-free-rate and yield-curve tables into a small standalone DB.

The historical replay backend now sources option chains and underlying bars
from the shared options-chain-service (Options DB workspace), so the only
data it still needs from the legacy bundled SQLite (sqlite_spy/spy_options.db)
is the two rates tables. This script copies them (plus the dates dimension
they reference) into sqlite_spy/rates.db so the multi-GB legacy DB can be
retired.

Usage:
    python3 scripts/extract_rates_db.py \
        [--source sqlite_spy/spy_options.db] [--target sqlite_spy/rates.db]
"""

import argparse
import os
import sqlite3
import sys
from pathlib import Path


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SOURCE = os.path.join(PROJECT_ROOT, "sqlite_spy", "spy_options.db")
DEFAULT_TARGET = os.path.join(PROJECT_ROOT, "sqlite_spy", "rates.db")


def extract(source, target):
    if not os.path.exists(source):
        raise FileNotFoundError(source)
    if os.path.exists(target):
        os.remove(target)

    con = sqlite3.connect(f"{Path(target).resolve().as_uri()}?mode=rwc", uri=True)
    try:
        con.execute(
            "ATTACH DATABASE ? AS src",
            (f"{Path(source).resolve().as_uri()}?mode=ro",),
        )
        con.executescript(
            """
            CREATE TABLE dates (
                date_id INTEGER PRIMARY KEY,
                date TEXT UNIQUE NOT NULL
            );

            CREATE TABLE risk_free_daily_rates (
                id INTEGER PRIMARY KEY,
                date_ref INTEGER NOT NULL,
                rate REAL,
                source TEXT,
                FOREIGN KEY (date_ref) REFERENCES dates(date_id)
            );

            CREATE TABLE yield_curve_daily_rates (
                id INTEGER PRIMARY KEY,
                date_ref INTEGER NOT NULL,
                tenor_code TEXT,
                tenor_days INTEGER,
                rate REAL,
                source TEXT,
                FOREIGN KEY (date_ref) REFERENCES dates(date_id)
            );

            INSERT INTO dates SELECT date_id, date FROM src.dates;

            INSERT INTO risk_free_daily_rates (id, date_ref, rate, source)
            SELECT rowid, date_ref, rate, source FROM src.risk_free_daily_rates;

            INSERT INTO yield_curve_daily_rates
                (id, date_ref, tenor_code, tenor_days, rate, source)
            SELECT rowid, date_ref, tenor_code, tenor_days, rate, source
            FROM src.yield_curve_daily_rates;

            CREATE INDEX idx_rf_date_ref ON risk_free_daily_rates(date_ref);
            CREATE INDEX idx_yc_date_ref ON yield_curve_daily_rates(date_ref);
            """
        )
        con.commit()
        counts = {
            table: con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("dates", "risk_free_daily_rates", "yield_curve_daily_rates")
        }
    finally:
        con.close()
    return counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--target", default=DEFAULT_TARGET)
    args = parser.parse_args(argv)
    counts = extract(args.source, args.target)
    print(f"created {args.target}")
    for table, count in counts.items():
        print(f"  {table}: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
