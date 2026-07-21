#!/usr/bin/env python3
"""Estimate the option-implied weight of non-trading days from EOD chains.

The estimator uses adjacent ATM expiries observed on the same quote date.
For each expiry interval it computes the increase in total implied variance.
Intervals containing only trading days provide a local variance-per-trading-
day baseline.  Weekend/holiday intervals are compared with that same-date,
nearby-DTE baseline and solve

    forward variance = baseline * (trading_days + lambda * nontrading_days).

The default path derives each expiry's forward from call-put parity and then
numerically inverts the observed straddle with Black-76.  It therefore does
not depend on a vendor IV field or on the old short-time ATM approximation.

This is a research diagnostic, not a trading signal.  It deliberately uses
robust medians because expiry-specific event variance and EOD quote noise make
individual interval estimates extremely noisy.
"""

from __future__ import annotations

import argparse
import bisect
import math
import sqlite3
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path


DEFAULT_DB = (
    Path(__file__).resolve().parents[3]
    / "Options DB"
    / "US_Stocks"
    / "market_data.cleaned.db"
)


@dataclass(frozen=True)
class SurfacePoint:
    quote_date: date
    expiry: date
    dte: int
    iv: float
    total_variance: float


@dataclass(frozen=True)
class Interval:
    quote_date: date
    front_dte: int
    midpoint_dte: float
    trading_days: int
    nontrading_days: int
    forward_variance: float


def _parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return math.nan
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _mad_filter(values: list[float], scale: float = 5.0) -> list[float]:
    if len(values) < 5:
        return values
    center = statistics.median(values)
    mad = statistics.median(abs(value - center) for value in values)
    if mad <= 0:
        return values
    limit = scale * 1.4826 * mad
    return [value for value in values if abs(value - center) <= limit]


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _black76_straddle_from_total_vol(
    forward: float,
    strike: float,
    time_years: float,
    rate: float,
    total_vol: float,
) -> float | None:
    if forward <= 0 or strike <= 0 or time_years <= 0 or total_vol < 0:
        return None
    discount = math.exp(-rate * time_years)
    if total_vol == 0:
        return discount * abs(forward - strike)
    d1 = math.log(forward / strike) / total_vol + total_vol / 2.0
    d2 = d1 - total_vol
    return discount * (
        forward * (2.0 * _normal_cdf(d1) - 1.0)
        - strike * (2.0 * _normal_cdf(d2) - 1.0)
    )


def _invert_straddle_total_variance(
    forward: float,
    strike: float,
    time_years: float,
    rate: float,
    straddle_price: float,
) -> float | None:
    if straddle_price <= 0:
        return None
    floor = _black76_straddle_from_total_vol(
        forward, strike, time_years, rate, 0.0
    )
    if floor is None or straddle_price <= floor * (1.0 + 1e-12) + 1e-12:
        return None
    low = 0.0
    high = 6.0
    high_price = _black76_straddle_from_total_vol(
        forward, strike, time_years, rate, high
    )
    if high_price is None or high_price < straddle_price:
        return None
    for _ in range(80):
        midpoint = (low + high) / 2.0
        price = _black76_straddle_from_total_vol(
            forward, strike, time_years, rate, midpoint
        )
        if price is None:
            return None
        if price < straddle_price:
            low = midpoint
        else:
            high = midpoint
    total_vol = (low + high) / 2.0
    return total_vol * total_vol


def _load_trading_dates(connection: sqlite3.Connection, symbol: str) -> list[date]:
    rows = connection.execute(
        "SELECT price_date FROM underlying_prices WHERE symbol = ? ORDER BY price_date",
        (symbol,),
    )
    return [_parse_date(row[0]) for row in rows]


def _load_underlying_closes(
    connection: sqlite3.Connection, symbol: str, start: str, end: str
) -> list[tuple[date, float]]:
    rows = connection.execute(
        """
        SELECT price_date, close
        FROM underlying_prices
        WHERE symbol = ? AND price_date BETWEEN ? AND ?
        ORDER BY price_date
        """,
        (symbol, start, end),
    )
    return [(_parse_date(row[0]), float(row[1])) for row in rows]


def _count_trading_days(trading_dates: list[date], start: date, end: date) -> int:
    return bisect.bisect_left(trading_dates, end) - bisect.bisect_left(
        trading_dates, start
    )


def _load_atm_surface(
    connection: sqlite3.Connection,
    symbol: str,
    start: str,
    end: str,
    min_dte: int,
    max_dte: int,
    max_spread_pct: float,
    variance_source: str,
    interest_rate: float,
) -> list[SurfacePoint]:
    # Pick the nearest-to-spot strike that has a complete, two-sided call/put
    # pair. Averaging call and put vendor IV reduces one-sided EOD noise. The
    # paired price/spread checks reject the most obvious stale observations.
    sql = """
        WITH paired AS (
            SELECT
                qd.date AS quote_date,
                ed.date AS expiry,
                CAST(julianday(ed.date) - julianday(qd.date) AS INTEGER) AS dte,
                u.close AS spot,
                od.strike AS strike,
                AVG(od.implied_volatility) AS atm_iv,
                MAX(CASE WHEN od.type = 'call' THEN od.bid END) AS call_bid,
                MAX(CASE WHEN od.type = 'call' THEN od.ask END) AS call_ask,
                MAX(CASE WHEN od.type = 'put' THEN od.bid END) AS put_bid,
                MAX(CASE WHEN od.type = 'put' THEN od.ask END) AS put_ask,
                COUNT(DISTINCT od.type) AS sides
            FROM options_data_clean od
            JOIN symbols s ON s.symbol_id = od.symbol_ref
            JOIN dates qd ON qd.date_id = od.date_ref
            JOIN dates ed ON ed.date_id = od.expiration_ref
            JOIN underlying_prices u
              ON u.symbol = s.symbol AND u.price_date = qd.date
            WHERE s.symbol = ?
              AND qd.date BETWEEN ? AND ?
              AND julianday(ed.date) - julianday(qd.date) BETWEEN ? AND ?
              AND od.strike BETWEEN u.close * 0.94 AND u.close * 1.06
              AND od.type IN ('call', 'put')
              AND od.bid > 0 AND od.ask > 0 AND od.ask >= od.bid
            GROUP BY qd.date, ed.date, u.close, od.strike
            HAVING sides = 2
               AND call_bid > 0 AND call_ask > 0
               AND put_bid > 0 AND put_ask > 0
               AND (call_ask - call_bid) / ((call_ask + call_bid) / 2.0) <= ?
               AND (put_ask - put_bid) / ((put_ask + put_bid) / 2.0) <= ?
        ), ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY quote_date, expiry
                ORDER BY ABS(
                    (call_bid + call_ask) / 2.0
                    - (put_bid + put_ask) / 2.0
                ), ABS(strike - spot), strike
            ) AS strike_rank
            FROM paired
        )
        SELECT quote_date, expiry, dte, atm_iv, spot, strike,
               (call_bid + call_ask) / 2.0 AS call_mid,
               (put_bid + put_ask) / 2.0 AS put_mid
        FROM ranked
        WHERE strike_rank = 1
        ORDER BY quote_date, expiry
    """
    rows = connection.execute(
        sql,
        (symbol, start, end, min_dte, max_dte, max_spread_pct, max_spread_pct),
    )
    points = []
    for row in rows:
        dte = int(row[2])
        raw_iv = row[3]
        iv = float(raw_iv) if raw_iv is not None else math.nan
        if variance_source == "straddle":
            strike, call_mid, put_mid = map(float, row[5:8])
            time_years = dte / 365.0
            discount = math.exp(-interest_rate * time_years)
            if strike <= 0 or discount <= 0:
                continue
            # European call-put parity: C-P = D(F-K).  Solving F from the same
            # two market mids avoids mixing a separately-timed spot/future into
            # the inversion and naturally handles carry/dividend expectations.
            forward = strike + (call_mid - put_mid) / discount
            total_variance = _invert_straddle_total_variance(
                forward,
                strike,
                time_years,
                interest_rate,
                call_mid + put_mid,
            )
            if total_variance is None:
                continue
        else:
            if not math.isfinite(iv) or iv <= 0.03:
                continue
            total_variance = iv * iv * dte / 365.0
        points.append(
            SurfacePoint(
                quote_date=_parse_date(row[0]),
                expiry=_parse_date(row[1]),
                dte=dte,
                iv=iv if math.isfinite(iv) else math.nan,
                total_variance=total_variance,
            )
        )
    return points


def _build_intervals(
    points: list[SurfacePoint],
    trading_dates: list[date],
    max_expiry_gap: int,
) -> list[Interval]:
    by_quote_date: dict[date, list[SurfacePoint]] = defaultdict(list)
    for point in points:
        by_quote_date[point.quote_date].append(point)

    intervals = []
    for quote_date, surface in by_quote_date.items():
        ordered = sorted(surface, key=lambda point: point.expiry)
        for front, back in zip(ordered, ordered[1:]):
            calendar_days = (back.expiry - front.expiry).days
            if calendar_days <= 0 or calendar_days > max_expiry_gap:
                continue
            trading_days = _count_trading_days(
                trading_dates, front.expiry, back.expiry
            )
            nontrading_days = calendar_days - trading_days
            forward_variance = back.total_variance - front.total_variance
            if trading_days <= 0 or nontrading_days < 0 or forward_variance <= 0:
                continue
            intervals.append(
                Interval(
                    quote_date=quote_date,
                    front_dte=front.dte,
                    midpoint_dte=(front.dte + back.dte) / 2.0,
                    trading_days=trading_days,
                    nontrading_days=nontrading_days,
                    forward_variance=forward_variance,
                )
            )
    return intervals


def _estimate_lambdas(
    intervals: list[Interval],
    baseline_window_days: float,
    min_baselines: int,
) -> list[tuple[Interval, float]]:
    by_quote_date: dict[date, list[Interval]] = defaultdict(list)
    for interval in intervals:
        by_quote_date[interval.quote_date].append(interval)

    estimates = []
    for quote_date, daily_intervals in by_quote_date.items():
        pure = [item for item in daily_intervals if item.nontrading_days == 0]
        weekend = [item for item in daily_intervals if item.nontrading_days > 0]
        for target in weekend:
            candidates = [
                item.forward_variance / item.trading_days
                for item in pure
                if abs(item.midpoint_dte - target.midpoint_dte)
                <= baseline_window_days
            ]
            candidates = _mad_filter(candidates)
            if len(candidates) < min_baselines:
                continue
            baseline = statistics.median(candidates)
            if baseline <= 0:
                continue
            estimate = (
                target.forward_variance / baseline - target.trading_days
            ) / target.nontrading_days
            if math.isfinite(estimate):
                estimates.append((target, estimate))
    return estimates


def _summarize(label: str, values: list[float]) -> str:
    if not values:
        return f"{label:>10}  n=0"
    filtered = _mad_filter(values)
    admissible = [value for value in filtered if 0 <= value <= 1]
    admissible_median = (
        f"{statistics.median(admissible):6.3f}" if admissible else "    --"
    )
    return (
        f"{label:>10}  n={len(values):5d}  "
        f"raw_med={statistics.median(filtered):6.3f}  "
        f"valid_med={admissible_median}  "
        f"p25={_percentile(filtered, 0.25):6.3f}  "
        f"p75={_percentile(filtered, 0.75):6.3f}  "
        f"mean={statistics.fmean(filtered):6.3f}  "
        f"valid[0,1]={len(admissible) / len(filtered):5.1%}"
    )


def _winsorized_mean(values: list[float], tail: float = 0.01) -> float:
    if not values:
        return math.nan
    lower = _percentile(values, tail)
    upper = _percentile(values, 1.0 - tail)
    return statistics.fmean(min(upper, max(lower, value)) for value in values)


def _realized_lambda(closes: list[tuple[date, float]]) -> tuple[int, int, float, float]:
    one_day = []
    weekend = []
    for (previous_date, previous_close), (current_date, current_close) in zip(
        closes, closes[1:]
    ):
        gap = (current_date - previous_date).days
        squared_return = math.log(current_close / previous_close) ** 2
        if gap == 1:
            one_day.append(squared_return)
        elif gap == 3:
            weekend.append(squared_return)
    if not one_day or not weekend:
        return len(one_day), len(weekend), math.nan, math.nan
    raw = (statistics.fmean(weekend) / statistics.fmean(one_day) - 1.0) / 2.0
    winsorized = (
        _winsorized_mean(weekend) / _winsorized_mean(one_day) - 1.0
    ) / 2.0
    return len(one_day), len(weekend), raw, winsorized


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--symbol", default="SPY")
    parser.add_argument("--start", default="2022-01-01")
    parser.add_argument("--end", default="2026-06-26")
    parser.add_argument("--min-dte", type=int, default=2)
    parser.add_argument("--max-dte", type=int, default=60)
    parser.add_argument("--max-expiry-gap", type=int, default=7)
    parser.add_argument("--max-spread-pct", type=float, default=0.35)
    parser.add_argument("--baseline-window", type=float, default=7.0)
    parser.add_argument("--min-baselines", type=int, default=2)
    parser.add_argument(
        "--rate", type=float, default=0.04,
        help="annual continuously-compounded discount rate used by parity/Black-76",
    )
    parser.add_argument(
        "--variance-source", choices=("vendor_iv", "straddle"), default="straddle"
    )
    args = parser.parse_args()

    db_path = args.db.expanduser().resolve()
    uri = f"{db_path.as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        trading_dates = _load_trading_dates(connection, args.symbol.upper())
        closes = _load_underlying_closes(
            connection, args.symbol.upper(), args.start, args.end
        )
        points = _load_atm_surface(
            connection,
            args.symbol.upper(),
            args.start,
            args.end,
            args.min_dte,
            args.max_dte,
            args.max_spread_pct,
            args.variance_source,
            args.rate,
        )

    intervals = _build_intervals(points, trading_dates, args.max_expiry_gap)
    estimates = _estimate_lambdas(
        intervals, args.baseline_window, args.min_baselines
    )

    print(
        f"symbol={args.symbol.upper()} range={args.start}..{args.end} "
        f"source={args.variance_source} "
        f"surface_points={len(points)} intervals={len(intervals)} "
        f"lambda_estimates={len(estimates)}"
    )
    one_day_n, weekend_n, realized_raw, realized_winsorized = _realized_lambda(closes)
    print(
        f"realized close-close: weekday_n={one_day_n} weekend_n={weekend_n} "
        f"lambda_raw={realized_raw:.3f} lambda_winsor_1pct={realized_winsorized:.3f}"
    )
    print(_summarize("all", [value for _, value in estimates]))
    bands = [(2, 7), (8, 14), (15, 30), (31, 60)]
    for lower, upper in bands:
        values = [
            value
            for interval, value in estimates
            if lower <= interval.front_dte <= upper
        ]
        print(_summarize(f"DTE {lower}-{upper}", values))

    for year in range(_parse_date(args.start).year, _parse_date(args.end).year + 1):
        values = [
            value
            for interval, value in estimates
            if interval.quote_date.year == year
        ]
        print(_summarize(str(year), values))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
