#!/usr/bin/env python3
"""Audit and narrowly repair the known VRP ATM IV floor anomalies.

The vendor value 0.01488 is a widespread floor, so it must never be replaced
globally.  A read-only audit of the ATM front/back pairs selected by the VRP
research found four price/IV-inconsistent pairs. Three QQQ pairs have stale or
non-identifying quotes and must fail closed. Only the SPY pair below has a
continuous, tight BBO history suitable for price inversion. This script
recomputes its common same-strike IV from the call+put BBO midpoints under
Black-76 and only updates rows whose IV is still at the vendor floor.

Dry-run by default.  ``--apply`` uses one SQLite transaction and records every
changed value in ``iv_repair_audit`` inside the target database.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable, Optional


REPAIRABLE_PAIRS = (
    ("SPY", "2010-03-12", "2010-03-31", 115.0),
)

REJECTED_PAIRS = (
    {
        "symbol": "QQQ", "quoteDate": "2014-02-28",
        "expiration": "2014-03-07", "strike": 90.5,
        "reason": "call and put BBOs are frozen across multiple sessions",
    },
    {
        "symbol": "QQQ", "quoteDate": "2014-02-28",
        "expiration": "2014-03-14", "strike": 90.5,
        "reason": "call and put BBOs are frozen across multiple sessions",
    },
    {
        "symbol": "QQQ", "quoteDate": "2017-03-24",
        "expiration": "2017-03-31", "strike": 130.5,
        "reason": "put spread is 58% of ask and pair midpoint violates spot parity",
    },
)

VENDOR_FLOOR_IV = 0.01488
VENDOR_FLOOR_ABS_TOL = 1e-12
MAX_RELATIVE_BBO_SPREAD = 0.10
MIN_REPAIRED_IV = 0.03
MAX_REPAIRED_IV = 2.0
PAIR_QUERY = """
SELECT o.id, o.type, o.bid, o.ask, o.implied_volatility, c.contract_text
FROM options_data_clean o
JOIN symbols s ON s.symbol_id = o.symbol_ref
JOIN dates quote_dates ON quote_dates.date_id = o.date_ref
JOIN dates expirations ON expirations.date_id = o.expiration_ref
JOIN contracts c ON c.contract_id = o.contract_ref
WHERE s.symbol = ?
  AND quote_dates.date = ?
  AND expirations.date = ?
  AND o.strike = ?
ORDER BY o.type
"""


@dataclass(frozen=True)
class Repair:
    row_id: int
    contract: str
    symbol: str
    quote_date: str
    expiration: str
    strike: float
    option_type: str
    old_iv: float
    new_iv: float
    call_mid: float
    put_mid: float
    risk_free_rate: float


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def black76_prices(
    forward: float,
    strike: float,
    tau: float,
    rate: float,
    volatility: float,
) -> tuple[float, float]:
    """Return discounted Black-76 call and put prices."""
    if min(forward, strike, tau, volatility) <= 0:
        raise ValueError("forward, strike, tau and volatility must be positive")
    root_variance = volatility * math.sqrt(tau)
    d1 = (math.log(forward / strike) + 0.5 * volatility * volatility * tau) / root_variance
    d2 = d1 - root_variance
    discount = math.exp(-rate * tau)
    call = discount * (forward * _normal_cdf(d1) - strike * _normal_cdf(d2))
    put = discount * (strike * _normal_cdf(-d2) - forward * _normal_cdf(-d1))
    return call, put


def implied_volatility_from_pair(
    call_mid: float,
    put_mid: float,
    strike: float,
    tau: float,
    rate: float,
) -> tuple[float, float]:
    """Infer same-strike forward and common IV from a call/put price pair."""
    if min(call_mid, put_mid, strike, tau) <= 0:
        raise ValueError("two positive option mids, strike and tau are required")
    discount = math.exp(-rate * tau)
    forward = strike + (call_mid - put_mid) / discount
    target = call_mid + put_mid
    intrinsic = discount * abs(forward - strike)
    if forward <= 0 or target < intrinsic:
        raise ValueError("call/put mids violate discounted intrinsic bounds")

    low, high = 1e-6, 5.0
    high_total = sum(black76_prices(forward, strike, tau, rate, high))
    if high_total < target:
        raise ValueError("pair price requires IV above the 500% safety bound")
    for _ in range(100):
        middle = (low + high) / 2.0
        model_total = sum(black76_prices(forward, strike, tau, rate, middle))
        if model_total < target:
            low = middle
        else:
            high = middle
    return (low + high) / 2.0, forward


def _effective_rate(rates: sqlite3.Connection, quote_date: str) -> float:
    row = rates.execute(
        """
        SELECT rf.rate
        FROM risk_free_daily_rates rf
        JOIN dates d ON d.date_id = rf.date_ref
        WHERE d.date <= ? AND rf.rate IS NOT NULL
        ORDER BY d.date DESC
        LIMIT 1
        """,
        (quote_date,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"no risk-free rate on or before {quote_date}")
    return float(row[0])


def collect_repairs(
    database: sqlite3.Connection,
    rates: sqlite3.Connection,
    pairs: Iterable[tuple[str, str, str, float]] = REPAIRABLE_PAIRS,
) -> tuple[list[Repair], list[dict]]:
    repairs: list[Repair] = []
    pair_audit: list[dict] = []
    for symbol, quote_date, expiration, strike in pairs:
        rows = database.execute(PAIR_QUERY, (symbol, quote_date, expiration, strike)).fetchall()
        if len(rows) != 2:
            raise RuntimeError(
                f"expected exactly two rows for {symbol} {quote_date} {expiration} {strike}; "
                f"found {len(rows)}"
            )
        by_type = {str(row[1]).lower(): row for row in rows}
        if set(by_type) != {"call", "put"} or len(by_type) != len(rows):
            raise RuntimeError(
                f"expected one call and one put for {symbol} {quote_date} {expiration} {strike}"
            )
        call, put = by_type["call"], by_type["put"]
        for row in (call, put):
            bid, ask = row[2], row[3]
            if bid is None or ask is None or bid <= 0 or ask < bid:
                raise RuntimeError(f"unusable two-sided quote for {row[5]} on {quote_date}")
            midpoint = (float(bid) + float(ask)) / 2.0
            relative_spread = (float(ask) - float(bid)) / midpoint
            if relative_spread > MAX_RELATIVE_BBO_SPREAD:
                raise RuntimeError(
                    f"BBO spread is too wide to invert safely for {row[5]} on {quote_date}: "
                    f"{relative_spread:.1%}"
                )

        call_mid = (float(call[2]) + float(call[3])) / 2.0
        put_mid = (float(put[2]) + float(put[3])) / 2.0
        rate = _effective_rate(rates, quote_date)
        tau = (date.fromisoformat(expiration) - date.fromisoformat(quote_date)).days / 365.0
        price_iv, forward = implied_volatility_from_pair(call_mid, put_mid, strike, tau, rate)
        if not (MIN_REPAIRED_IV <= price_iv <= MAX_REPAIRED_IV):
            raise RuntimeError(
                f"price-implied IV {price_iv:.6f} is outside the guarded repair range "
                f"for {symbol} {quote_date} {expiration} {strike}"
            )
        vendor_pair_iv = (float(call[4]) + float(put[4])) / 2.0
        pair_audit.append(
            {
                "symbol": symbol,
                "quoteDate": quote_date,
                "expiration": expiration,
                "strike": strike,
                "callMid": call_mid,
                "putMid": put_mid,
                "forwardFromParity": forward,
                "vendorPairIv": vendor_pair_iv,
                "priceImpliedIv": price_iv,
                "vendorToPriceRatio": vendor_pair_iv / price_iv,
            }
        )
        floor_flags = [
            math.isclose(
                float(row[4]), VENDOR_FLOOR_IV,
                rel_tol=0.0, abs_tol=VENDOR_FLOOR_ABS_TOL,
            )
            for row in (call, put)
        ]
        if any(floor_flags) and not all(floor_flags):
            raise RuntimeError(
                f"partial sentinel state for {symbol} {quote_date} {expiration} {strike}; "
                "refusing a one-leg repair"
            )
        if not all(floor_flags):
            continue
        for row in (call, put):
            old_iv = float(row[4])
            repairs.append(
                Repair(
                    row_id=int(row[0]),
                    contract=str(row[5]),
                    symbol=symbol,
                    quote_date=quote_date,
                    expiration=expiration,
                    strike=strike,
                    option_type=str(row[1]),
                    old_iv=old_iv,
                    new_iv=price_iv,
                    call_mid=call_mid,
                    put_mid=put_mid,
                    risk_free_rate=rate,
                )
            )
    return repairs, pair_audit


def apply_repairs(database: sqlite3.Connection, repairs: Iterable[Repair]) -> int:
    repairs = list(repairs)
    if len({repair.row_id for repair in repairs}) != len(repairs):
        raise RuntimeError("duplicate option row in repair request")
    for repair in repairs:
        if not math.isclose(
            repair.old_iv, VENDOR_FLOOR_IV,
            rel_tol=0.0, abs_tol=VENDOR_FLOOR_ABS_TOL,
        ):
            raise RuntimeError(
                f"row {repair.row_id} old IV is not the exact {VENDOR_FLOOR_IV} sentinel"
            )
        if not (MIN_REPAIRED_IV <= repair.new_iv <= MAX_REPAIRED_IV):
            raise RuntimeError(f"row {repair.row_id} replacement IV is outside safety bounds")
    repaired_at = datetime.now(timezone.utc).isoformat()
    database.execute("BEGIN IMMEDIATE")
    try:
        database.execute(
            """
            CREATE TABLE IF NOT EXISTS iv_repair_audit (
                repair_id INTEGER PRIMARY KEY,
                repaired_at TEXT NOT NULL,
                method TEXT NOT NULL,
                option_row_id INTEGER NOT NULL,
                contract_text TEXT NOT NULL,
                symbol TEXT NOT NULL,
                quote_date TEXT NOT NULL,
                expiration TEXT NOT NULL,
                strike REAL NOT NULL,
                option_type TEXT NOT NULL,
                old_iv REAL NOT NULL,
                new_iv REAL NOT NULL,
                call_mid REAL NOT NULL,
                put_mid REAL NOT NULL,
                risk_free_rate REAL NOT NULL,
                UNIQUE(option_row_id, old_iv, new_iv, method)
            )
            """
        )
        changed = 0
        for repair in repairs:
            cursor = database.execute(
                """
                UPDATE options_data_clean
                SET implied_volatility = ?
                WHERE id = ? AND implied_volatility = ?
                """,
                (repair.new_iv, repair.row_id, repair.old_iv),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"concurrent/unexpected value for row {repair.row_id}; transaction rolled back"
                )
            database.execute(
                """
                INSERT INTO iv_repair_audit (
                    repaired_at, method, option_row_id, contract_text, symbol,
                    quote_date, expiration, strike, option_type, old_iv, new_iv,
                    call_mid, put_mid, risk_free_rate
                ) VALUES (?, 'black76_pair_bbo_mid_v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    repaired_at,
                    repair.row_id,
                    repair.contract,
                    repair.symbol,
                    repair.quote_date,
                    repair.expiration,
                    repair.strike,
                    repair.option_type,
                    repair.old_iv,
                    repair.new_iv,
                    repair.call_mid,
                    repair.put_mid,
                    repair.risk_free_rate,
                ),
            )
            changed += 1
        database.commit()
        return changed
    except Exception:
        database.rollback()
        raise


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path, help="clean options SQLite database")
    parser.add_argument(
        "--rates-db",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "sqlite_spy" / "rates.db",
    )
    parser.add_argument("--apply", action="store_true", help="apply the guarded transaction")
    args = parser.parse_args(argv)

    db_mode = "rw" if args.apply else "ro"
    database = sqlite3.connect(f"file:{args.db.resolve()}?mode={db_mode}", uri=True)
    rates = sqlite3.connect(f"file:{args.rates_db.resolve()}?mode=ro", uri=True)
    try:
        repairs, pairs = collect_repairs(database, rates)
        payload = {
            "mode": "apply" if args.apply else "dry-run",
            "candidatePairCount": len(REPAIRABLE_PAIRS) + len(REJECTED_PAIRS),
            "repairablePairCount": len(REPAIRABLE_PAIRS),
            "rejectedPairCount": len(REJECTED_PAIRS),
            "rejectedPairs": REJECTED_PAIRS,
            "repairRowCount": len(repairs),
            "pairs": pairs,
            "repairs": [asdict(repair) for repair in repairs],
        }
        if args.apply:
            payload["changedRowCount"] = apply_repairs(database, repairs)
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    finally:
        rates.close()
        database.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
