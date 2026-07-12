"""Backtest: ATM double calendar vs iron butterfly on EOD chains.

Both structures share the same engine — short the front-expiry ATM straddle.
They differ only in the hedge leg:

  * calendar  : buy the same-strike ATM straddle at ~2x DTE (net debit)
  * iron fly  : buy same-expiry wings one expected-move away (net credit)

Entry on the last trading day of each week; both held to front expiry
(the user's actual exit convention). The front straddle and the wings
settle to intrinsic against the expiry-day close; the calendar's back
straddle is sold at its EOD mark on the front expiry date.

Each entry is tagged contango/backwardation from the front/back ATM IV
ratio measured on the weighted trading-day clock (lambda), so the output
answers the regime question directly: is the fly better in contango and
the calendar better in backwardation?

Requires the options-chain service (Options DB workspace):
    python3 chain_server.py   # default http://127.0.0.1:8750

Usage:
    python3 scripts/backtest_calendar_vs_iron_fly.py \
        [--symbol SPY] [--start 2010-01-01] [--end 2026-06-26] \
        [--front-dte 7] [--back-mult 2.0] [--lambda 0.3] \
        [--slippage 0.0] [--csv /path/to/trades.csv]

Slippage is dollars per share per leg applied on every traded leg
(entries and the calendar's back-leg exit); expiring legs settle free.
"""

import argparse
import csv
import json
import math
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime

SERVICE_URL = "http://127.0.0.1:8750"


def _get(path, params):
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{SERVICE_URL}{path}?{query}"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def _parse_date(text):
    return datetime.strptime(text, "%Y-%m-%d").date()


def _trading_day_count(sorted_trading_dates, start, end):
    """Actual trading days in [start, end), from the exchange calendar the
    chain service exposes — weekends AND market holidays excluded, matching
    the dashboard's countTradingDays with the holiday hook loaded."""
    import bisect
    lo = bisect.bisect_left(sorted_trading_dates, start)
    hi = bisect.bisect_left(sorted_trading_dates, end)
    return hi - lo


def _td_iv(iv, cal_dte, trad_dte, lam):
    """Weighted-clock re-annualization; mirrors the frontend formula."""
    if not iv or iv <= 0 or cal_dte <= 0 or trad_dte <= 0:
        return None
    eff_dte = trad_dte + lam * (cal_dte - trad_dte)
    eff_year = 252 + lam * (365 - 252)
    return iv * math.sqrt((cal_dte / 365.0) / (eff_dte / eff_year))


def _usable_mark(quote):
    if not quote:
        return None
    bid = quote.get("bid") or 0
    ask = quote.get("ask") or 0
    if bid > 0 and ask > 0:
        return (bid + ask) / 2.0
    mark = quote.get("mark") or 0
    return mark if mark > 0 else None


def _quote_map(chain_payload):
    quotes = {}
    for quote in (chain_payload or {}).get("quotes", []):
        quotes[(quote["strike"], quote["type"])] = quote
    return quotes


def _pick_expiry(expirations, entry, target_dte, lo, hi):
    best = None
    for item in expirations:
        expiry = _parse_date(item["expiration"])
        dte = (expiry - entry).days
        if dte < lo or dte > hi:
            continue
        if best is None or abs(dte - target_dte) < abs((best - entry).days - target_dte):
            best = expiry
    return best


def _atm_strike(quotes, spot):
    strikes = sorted({s for (s, t) in quotes})
    best, best_dist = None, None
    for strike in strikes:
        call_mark = _usable_mark(quotes.get((strike, "call")))
        put_mark = _usable_mark(quotes.get((strike, "put")))
        if call_mark is None or put_mark is None:
            continue
        dist = abs(strike - spot)
        if best is None or dist < best_dist:
            best, best_dist = strike, dist
    return best


def _nearest_shared_strike(front_quotes, back_quotes, target):
    """Nearest strike with usable call+put marks in BOTH expiries."""
    best, best_dist = None, None
    for strike in sorted({s for (s, t) in front_quotes}):
        usable = all(
            _usable_mark(chain.get((strike, opt)))
            for chain in (front_quotes, back_quotes)
            for opt in ("call", "put")
        )
        if not usable:
            continue
        dist = abs(strike - target)
        if best is None or dist < best_dist:
            best, best_dist = strike, dist
    return best


def _quote_delta(quote):
    delta = (quote or {}).get("delta")
    return delta if isinstance(delta, (int, float)) else None


def _wing_strikes(quotes, atm, width):
    call_wings = sorted(
        s for (s, t) in quotes
        if t == "call" and s >= atm + width and _usable_mark(quotes.get((s, "call")))
    )
    put_wings = sorted(
        (s for (s, t) in quotes
         if t == "put" and s <= atm - width and _usable_mark(quotes.get((s, "put")))),
        reverse=True,
    )
    return (call_wings[0] if call_wings else None,
            put_wings[0] if put_wings else None)


def run(args):
    lam = args.lam
    dates_payload = _get("/v1/trading-dates", {
        "symbol": args.symbol, "start": args.start, "end": args.end,
    })
    trading_dates = [_parse_date(d) for d in dates_payload["dates"]]
    trading_set = set(trading_dates)

    # Last trading day of each ISO week (handles Friday holidays).
    entries = []
    by_week = {}
    for d in trading_dates:
        by_week.setdefault(d.isocalendar()[:2], []).append(d)
    for week_dates in by_week.values():
        entries.append(max(week_dates))
    entries.sort()

    trades = []
    skips = {}

    def skip(reason):
        skips[reason] = skips.get(reason, 0) + 1

    for entry in entries:
        expirations_payload = _get("/v1/expirations", {
            "symbol": args.symbol, "date": entry.isoformat(), "mode": "exact",
        })
        if expirations_payload is None:
            skip("no expirations")
            continue
        expirations = expirations_payload["expirations"]

        front = _pick_expiry(expirations, entry, args.front_dte,
                             args.front_dte - 2, args.front_dte + 2)
        if front is None:
            skip("no front expiry")
            continue
        front_dte = (front - entry).days
        back_target = round(front_dte * args.back_mult)
        back = _pick_expiry(expirations, entry, back_target,
                            front_dte + 4, back_target + 5)
        if back is None:
            skip("no back expiry")
            continue

        under = _get("/v1/underlying", {
            "symbol": args.symbol, "date": entry.isoformat(), "mode": "exact",
        })
        if under is None or not under["bar"].get("close"):
            skip("no underlying")
            continue
        spot = under["bar"]["close"]

        window = {"minStrike": spot * 0.85, "maxStrike": spot * 1.15}
        front_chain = _quote_map(_get("/v1/chain", {
            "symbol": args.symbol, "date": entry.isoformat(),
            "expiration": front.isoformat(), "mode": "exact", **window,
        }))
        back_chain = _quote_map(_get("/v1/chain", {
            "symbol": args.symbol, "date": entry.isoformat(),
            "expiration": back.isoformat(), "mode": "exact", **window,
        }))
        if not front_chain or not back_chain:
            skip("empty chain")
            continue

        atm = _atm_strike(front_chain, spot)
        if atm is None or (atm, "call") not in back_chain or (atm, "put") not in back_chain:
            skip("no shared ATM strike")
            continue

        atm_call_mark = _usable_mark(front_chain.get((atm, "call")))
        atm_put_mark = _usable_mark(front_chain.get((atm, "put")))
        if atm_call_mark is None or atm_put_mark is None:
            skip("unusable ATM marks")
            continue
        expected_move = atm_call_mark + atm_put_mark

        # Optional positive-delta lean: shift the structure center above spot
        # by a fraction of the expected move. The regime tag below still uses
        # the true ATM quotes — the lean is ours, not the market's.
        center = atm
        if args.center_offset_em:
            center = _nearest_shared_strike(
                front_chain, back_chain, spot + args.center_offset_em * expected_move
            )
            if center is None:
                skip("no shared center strike")
                continue

        front_call = front_chain[(center, "call")]
        front_put = front_chain[(center, "put")]
        back_call = back_chain[(center, "call")]
        back_put = back_chain[(center, "put")]
        marks = [_usable_mark(q) for q in (front_call, front_put, back_call, back_put)]
        if any(m is None for m in marks):
            skip("unusable center marks")
            continue
        fc, fp, bc, bp = marks
        straddle_credit = fc + fp
        back_cost = bc + bp

        wing_call, wing_put = _wing_strikes(front_chain, center, straddle_credit)
        if wing_call is None or wing_put is None:
            skip("no wings")
            continue
        wc = _usable_mark(front_chain[(wing_call, "call")])
        wp = _usable_mark(front_chain[(wing_put, "put")])
        fly_credit = straddle_credit - wc - wp
        fly_maxloss = max(wing_call - center, center - wing_put) - fly_credit
        if fly_credit <= 0 or fly_maxloss <= 0:
            skip("degenerate fly")
            continue

        cal_debit = back_cost - straddle_credit
        if cal_debit <= 0:
            skip("credit calendar")
            continue

        # Regime tag on the weighted trading-day clock.
        front_trad = _trading_day_count(trading_dates, entry, front)
        back_trad = _trading_day_count(trading_dates, entry, back)
        atm_quotes = (front_chain[(atm, "call")], front_chain[(atm, "put")],
                      back_chain[(atm, "call")], back_chain[(atm, "put")])
        front_iv = [q.get("impliedVolatility") for q in atm_quotes[:2]]
        back_iv = [q.get("impliedVolatility") for q in atm_quotes[2:]]
        if not all(front_iv) or not all(back_iv):
            skip("missing IV")
            continue
        front_iv_td = _td_iv(sum(front_iv) / 2, front_dte, front_trad, lam)
        back_iv_td = _td_iv(sum(back_iv) / 2, (back - entry).days, back_trad, lam)
        if not front_iv_td or not back_iv_td:
            skip("bad IV conversion")
            continue
        slope_td = front_iv_td / back_iv_td
        regime = "backwardation" if slope_td > 1.0 else "contango"

        # ---- exit at front expiry ----
        exit_under = _get("/v1/underlying", {
            "symbol": args.symbol, "date": front.isoformat(), "mode": "on_or_before",
        })
        if exit_under is None or not exit_under["bar"].get("close"):
            skip("no exit underlying")
            continue
        settle = exit_under["bar"]["close"]

        exit_marks = []
        for opt_type, strike in (("call", center), ("put", center)):
            payload = _get("/v1/quote", {
                "symbol": args.symbol, "date": front.isoformat(),
                "expiration": back.isoformat(), "type": opt_type,
                "strike": strike, "mode": "on_or_before",
            })
            exit_marks.append(_usable_mark((payload or {}).get("quote")))
        if any(m is None for m in exit_marks):
            skip("no back-leg exit quote")
            continue
        # EOD marks on deep-ITM legs are often stale below intrinsic; the
        # straddle can always be exercised, so floor each leg at intrinsic.
        call_exit = max(exit_marks[0], max(settle - center, 0))
        put_exit = max(exit_marks[1], max(center - settle, 0))
        back_exit = call_exit + put_exit

        straddle_intrinsic = abs(settle - center)
        wing_intrinsic = max(settle - wing_call, 0) + max(wing_put - settle, 0)

        deltas = [_quote_delta(q) for q in (
            front_call, front_put,
            front_chain[(wing_call, "call")], front_chain[(wing_put, "put")],
            back_call, back_put,
        )]
        fly_delta = cal_delta = None
        if all(d is not None for d in deltas):
            dc, dp, dwc, dwp, dbc, dbp = deltas
            fly_delta = round((-dc - dp + dwc + dwp) * 100, 1)
            cal_delta = round((dbc + dbp - dc - dp) * 100, 1)

        slip = args.slippage
        fly_pnl = (fly_credit - straddle_intrinsic + wing_intrinsic - slip * 4) * 100
        cal_pnl = (-cal_debit - straddle_intrinsic + back_exit - slip * 6) * 100

        trades.append({
            "entry": entry.isoformat(),
            "front": front.isoformat(),
            "back": back.isoformat(),
            "spot": round(spot, 2),
            "atm": atm,
            "center": center,
            "wing_call": wing_call,
            "wing_put": wing_put,
            "fly_delta": fly_delta,
            "cal_delta": cal_delta,
            "settle": round(settle, 2),
            "regime": regime,
            "slope_td": round(slope_td, 4),
            "straddle_credit": round(straddle_credit, 4),
            "fly_credit": round(fly_credit, 4),
            "fly_maxloss": round(fly_maxloss, 4),
            "cal_debit": round(cal_debit, 4),
            "back_exit": round(back_exit, 4),
            "fly_pnl": round(fly_pnl, 2),
            "cal_pnl": round(cal_pnl, 2),
            "fly_ror": round(fly_pnl / (fly_maxloss * 100), 4),
            "cal_ror": round(cal_pnl / (cal_debit * 100), 4),
        })

    return trades, skips, trading_dates


def _leg_mark(symbol, day, expiration, opt_type, strike):
    payload = _get("/v1/quote", {
        "symbol": symbol, "date": day.isoformat(),
        "expiration": expiration.isoformat(), "type": opt_type,
        "strike": strike, "mode": "exact",
    })
    return _usable_mark((payload or {}).get("quote"))


def fetch_daily_marks(args, trades, trading_dates, path):
    """EOD close-out values for both structures on every day of each trade."""
    fields = ["entry", "date", "straddle_value", "wings_value", "back_value"]
    rows = []
    for trade in trades:
        entry = _parse_date(trade["entry"])
        front = _parse_date(trade["front"])
        back = _parse_date(trade["back"])
        center = trade["center"]
        for day in trading_dates:
            if not (entry < day < front):
                continue
            sc = _leg_mark(args.symbol, day, front, "call", center)
            sp = _leg_mark(args.symbol, day, front, "put", center)
            wc = _leg_mark(args.symbol, day, front, "call", trade["wing_call"])
            wp = _leg_mark(args.symbol, day, front, "put", trade["wing_put"])
            bc = _leg_mark(args.symbol, day, back, "call", center)
            bp = _leg_mark(args.symbol, day, back, "put", center)
            if sc is None or sp is None:
                continue
            rows.append({
                "entry": trade["entry"],
                "date": day.isoformat(),
                "straddle_value": round(sc + sp, 4),
                "wings_value": round(wc + wp, 4) if wc is not None and wp is not None else "",
                "back_value": round(bc + bp, 4) if bc is not None and bp is not None else "",
            })
    with open(path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return rows


EXIT_RULES = ("hold", "tp25", "tp50", "sl100", "tp50_sl100")


def evaluate_exit_rules(trades, mark_rows):
    """Exit-rule P&L per structure. Targets/stops are fractions of the fly
    credit / calendar debit; the first day a threshold is crossed exits at
    that day's marks, otherwise the trade rides to the hold-to-expiry P&L."""
    by_entry = {}
    for row in mark_rows:
        by_entry.setdefault(row["entry"], []).append(row)

    results = {("fly", rule): [] for rule in EXIT_RULES}
    results.update({("cal", rule): [] for rule in EXIT_RULES})

    for trade in trades:
        days = sorted(by_entry.get(trade["entry"], []), key=lambda r: r["date"])
        fly_base = trade["fly_credit"] * 100
        cal_base = trade["cal_debit"] * 100

        fly_path, cal_path = [], []
        for row in days:
            if row["straddle_value"] == "":
                continue
            straddle = float(row["straddle_value"])
            if row["wings_value"] != "":
                fly_path.append((trade["fly_credit"] - (straddle - float(row["wings_value"]))) * 100)
            if row["back_value"] != "":
                cal_path.append(((float(row["back_value"]) - straddle) - trade["cal_debit"]) * 100)

        for structure, path, base, final in (
            ("fly", fly_path, fly_base, trade["fly_pnl"]),
            ("cal", cal_path, cal_base, trade["cal_pnl"]),
        ):
            for rule in EXIT_RULES:
                pnl, held = final, len(path) + 1
                for index, value in enumerate(path):
                    take = ((rule in ("tp25",) and value >= 0.25 * base)
                            or (rule in ("tp50", "tp50_sl100") and value >= 0.50 * base)
                            or (rule in ("sl100", "tp50_sl100") and value <= -1.00 * base))
                    if take:
                        pnl, held = value, index + 1
                        break
                results[(structure, rule)].append({
                    "regime": trade["regime"], "pnl": pnl, "held": held,
                })
    return results


def print_exit_report(results):
    print("\n### exit rules (mean$ / median$ / win% / avg days held)")
    for regime in ("contango", "backwardation", None):
        label = regime or "ALL"
        print(f"\n-- {label} --")
        for structure in ("fly", "cal"):
            parts = []
            for rule in EXIT_RULES:
                sample = [r for r in results[(structure, rule)]
                          if regime is None or r["regime"] == regime]
                if not sample:
                    parts.append(f"{rule}: -")
                    continue
                pnls = [r["pnl"] for r in sample]
                held = statistics.mean(r["held"] for r in sample)
                parts.append(f"{rule}: {statistics.mean(pnls):+.1f}/"
                             f"{statistics.median(pnls):+.1f}/"
                             f"{100 * sum(1 for p in pnls if p > 0) / len(pnls):.0f}%/"
                             f"{held:.1f}d")
            print(f"  {structure}: " + "  ".join(parts))


def _stats(values):
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)
    return {
        "n": n,
        "mean": statistics.mean(ordered),
        "median": statistics.median(ordered),
        "win%": 100.0 * sum(1 for v in ordered if v > 0) / n,
        "p5": ordered[max(0, int(n * 0.05) - 1)] if n >= 20 else ordered[0],
        "worst": ordered[0],
        "sum": sum(ordered),
    }


def _print_block(title, rows):
    print(f"\n### {title}")
    header = f"{'':<16}{'n':>5}{'win%':>7}{'mean$':>9}{'med$':>8}{'p5$':>9}{'worst$':>9}{'sum$':>10}"
    print(header)
    for label, s in rows:
        if s is None:
            print(f"{label:<16}{'-':>5}")
            continue
        print(f"{label:<16}{s['n']:>5}{s['win%']:>7.1f}{s['mean']:>9.1f}"
              f"{s['median']:>8.1f}{s['p5']:>9.1f}{s['worst']:>9.1f}{s['sum']:>10.0f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default="SPY")
    parser.add_argument("--start", default="2010-01-01")
    parser.add_argument("--end", default="2026-06-26")
    parser.add_argument("--front-dte", type=int, default=7)
    parser.add_argument("--back-mult", type=float, default=2.0)
    parser.add_argument("--lambda", dest="lam", type=float, default=0.3)
    parser.add_argument("--slippage", type=float, default=0.0,
                        help="dollars per share per traded leg")
    parser.add_argument("--center-offset-em", type=float, default=0.0,
                        help="shift the structure center by this many expected "
                             "moves above spot (positive-delta lean)")
    parser.add_argument("--marks-csv", default="",
                        help="fetch daily leg marks between entry and front "
                             "expiry, write them here, and evaluate exit rules")
    parser.add_argument("--csv", default="")
    args = parser.parse_args()

    trades, skips, trading_dates = run(args)
    if not trades:
        print("No trades produced.", skips)
        sys.exit(1)

    if args.csv:
        with open(args.csv, "w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(trades[0].keys()))
            writer.writeheader()
            writer.writerows(trades)
        print(f"Wrote {len(trades)} trades to {args.csv}")

    print(f"\nSymbol {args.symbol}  entries {trades[0]['entry']} .. {trades[-1]['entry']}"
          f"  trades {len(trades)}  lambda {args.lam}  slippage {args.slippage}/share/leg"
          f"  centerOffsetEM {args.center_offset_em}")
    print(f"Skips: {skips}")
    deltas_fly = [t["fly_delta"] for t in trades if t["fly_delta"] is not None]
    deltas_cal = [t["cal_delta"] for t in trades if t["cal_delta"] is not None]
    if deltas_fly and deltas_cal:
        print(f"Entry delta (shares/1-lot): fly mean {statistics.mean(deltas_fly):+.1f}"
              f"  cal mean {statistics.mean(deltas_cal):+.1f}")

    for regime in ("contango", "backwardation"):
        subset = [t for t in trades if t["regime"] == regime]
        _print_block(
            f"{regime} (n={len(subset)})",
            [
                ("fly $/1-lot", _stats([t["fly_pnl"] for t in subset])),
                ("cal $/1-lot", _stats([t["cal_pnl"] for t in subset])),
                ("fly RoR", _stats([t["fly_ror"] * 100 for t in subset])),
                ("cal RoR", _stats([t["cal_ror"] * 100 for t in subset])),
            ],
        )
        if subset:
            paired = [t["cal_pnl"] - t["fly_pnl"] for t in subset]
            print(f"paired cal-fly mean: {statistics.mean(paired):+.1f}$"
                  f"  median: {statistics.median(paired):+.1f}$"
                  f"  cal wins {100 * sum(1 for d in paired if d > 0) / len(paired):.0f}%")

    _print_block(
        "ALL trades",
        [
            ("fly $/1-lot", _stats([t["fly_pnl"] for t in trades])),
            ("cal $/1-lot", _stats([t["cal_pnl"] for t in trades])),
            ("fly RoR", _stats([t["fly_ror"] * 100 for t in trades])),
            ("cal RoR", _stats([t["cal_ror"] * 100 for t in trades])),
        ],
    )

    if args.marks_csv:
        mark_rows = fetch_daily_marks(args, trades, trading_dates, args.marks_csv)
        print(f"\nWrote {len(mark_rows)} daily mark rows to {args.marks_csv}")
        print_exit_report(evaluate_exit_rules(trades, mark_rows))


if __name__ == "__main__":
    main()
