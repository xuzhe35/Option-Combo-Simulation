"""Cross-expiry reverse fly (E15): buy the front ATM straddle, sell
BACK-expiry wings one EM away — vs the same-expiry reverse fly on identical
weeks.

Hypothesis (user): in deep contango the front straddle is cheap while the
back IV is bulged, so selling the far wings collects richer premium than the
same-expiry wings. Counter-mechanism to watch: back wings do not decay to
zero by front expiry (they are bought back with time value intact) and the
position is short back vega exactly in the big-move weeks the reverse fly
needs.

Usage:
    python3 scripts/backtest_cross_expiry_reverse_fly.py --symbol SPY \
        --csv out.csv

Reuses the calendar-vs-fly backtest's service helpers; entries, expiry
selection, calendar handling and regime tagging are identical.
"""

import argparse
import csv
import importlib.util
import statistics
import sys
from pathlib import Path

LIB_PATH = Path(__file__).resolve().parent / "backtest_calendar_vs_iron_fly.py"
_spec = importlib.util.spec_from_file_location("btlib", LIB_PATH)
lib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lib)


def run(args):
    lam = args.lam
    dates_payload = lib._get("/v1/trading-dates", {
        "symbol": args.symbol, "start": "1900-01-01", "end": "2999-12-31",
    })
    data_dates = [lib._parse_date(d) for d in dates_payload["dates"]]
    audit_payload = lib._get("/v1/audit/missing-dates", {"symbol": args.symbol}) or {}
    gap_dates = [lib._parse_date(item["quoteDate"])
                 for item in audit_payload.get("missingDates", [])]
    observed = sorted(set(data_dates) | set(gap_dates))
    official = lib._load_official_calendar("NYSE")
    calendar_dates = lib._overlay_official_calendar(observed, official)
    entries, trading_dates, last_covered, missing_entries = lib._prepare_calendar(
        data_dates, gap_dates, lib._parse_date(args.start), lib._parse_date(args.end),
        calendar_dates=calendar_dates)

    trades, skips = [], {}
    if missing_entries:
        skips["missing entry-day data"] = len(missing_entries)

    def skip(reason):
        skips[reason] = skips.get(reason, 0) + 1

    for entry in entries:
        expirations_payload = lib._get("/v1/expirations", {
            "symbol": args.symbol, "date": entry.isoformat(), "mode": "exact",
        })
        if expirations_payload is None:
            skip("no expirations")
            continue
        expirations = expirations_payload["expirations"]
        front = lib._pick_expiry(expirations, entry, args.front_dte,
                                 args.front_dte - 2, args.front_dte + 2)
        if front is None:
            skip("no front expiry")
            continue
        front_dte = (front - entry).days
        back_target = round(front_dte * args.back_mult)
        back = lib._pick_expiry(expirations, entry, back_target,
                                front_dte + 4, back_target + 5)
        if back is None:
            skip("no back expiry")
            continue
        if last_covered is None or back > last_covered:
            skip("calendar coverage")
            continue

        under = lib._get("/v1/underlying", {
            "symbol": args.symbol, "date": entry.isoformat(), "mode": "exact",
        })
        if under is None or not under["bar"].get("close"):
            skip("no underlying")
            continue
        spot = under["bar"]["close"]

        window = {"minStrike": spot * 0.85, "maxStrike": spot * 1.15}
        front_chain = lib._quote_map(lib._get("/v1/chain", {
            "symbol": args.symbol, "date": entry.isoformat(),
            "expiration": front.isoformat(), "mode": "exact", **window,
        }))
        back_chain = lib._quote_map(lib._get("/v1/chain", {
            "symbol": args.symbol, "date": entry.isoformat(),
            "expiration": back.isoformat(), "mode": "exact", **window,
        }))
        if not front_chain or not back_chain:
            skip("empty chain")
            continue

        atm = lib._atm_strike(front_chain, spot)
        if atm is None:
            skip("no ATM strike")
            continue
        fc = lib._usable_mark(front_chain.get((atm, "call")))
        fp = lib._usable_mark(front_chain.get((atm, "put")))
        if fc is None or fp is None:
            skip("unusable ATM marks")
            continue
        straddle_cost = fc + fp
        em = straddle_cost

        # Same-expiry wings (reference structure) and back-expiry wings
        # (the hypothesis) at the same +-EM distance.
        fw_call, fw_put = lib._wing_strikes(front_chain, atm, em)
        bw_call, bw_put = lib._wing_strikes(back_chain, atm, em)
        if None in (fw_call, fw_put, bw_call, bw_put):
            skip("no wings")
            continue
        fwc = lib._usable_mark(front_chain[(fw_call, "call")])
        fwp = lib._usable_mark(front_chain[(fw_put, "put")])
        bwc = lib._usable_mark(back_chain[(bw_call, "call")])
        bwp = lib._usable_mark(back_chain[(bw_put, "put")])
        front_wing_credit = fwc + fwp
        back_wing_credit = bwc + bwp

        # Regime tag: identical to the main backtest.
        front_trad = lib._trading_day_count(trading_dates, entry, front)
        back_trad = lib._trading_day_count(trading_dates, entry, back)
        front_iv = [front_chain[(atm, t)].get("impliedVolatility") for t in ("call", "put")]
        back_atm = lib._atm_strike(back_chain, spot)
        back_iv = [back_chain[(back_atm, t)].get("impliedVolatility")
                   for t in ("call", "put")] if back_atm is not None else [None]
        if not all(front_iv) or not all(back_iv):
            skip("missing IV")
            continue
        front_iv_td = lib._td_iv(sum(front_iv) / 2, front_dte, front_trad, lam)
        back_iv_td = lib._td_iv(sum(back_iv) / 2, (back - entry).days, back_trad, lam)
        if not front_iv_td or not back_iv_td:
            skip("bad IV conversion")
            continue
        slope_td = front_iv_td / back_iv_td

        # ---- exit at front expiry ----
        exit_under = lib._get("/v1/underlying", {
            "symbol": args.symbol, "date": front.isoformat(), "mode": "on_or_before",
        })
        if exit_under is None or not exit_under["bar"].get("close"):
            skip("no exit underlying")
            continue
        settle = exit_under["bar"]["close"]
        straddle_intrinsic = abs(settle - atm)

        # Back wings bought back at front expiry (intrinsic floor on stale
        # deep-ITM marks, same convention as the calendar's back leg).
        exit_marks = []
        for opt_type, strike in (("call", bw_call), ("put", bw_put)):
            payload = lib._get("/v1/quote", {
                "symbol": args.symbol, "date": front.isoformat(),
                "expiration": back.isoformat(), "type": opt_type,
                "strike": strike, "mode": "on_or_before",
            })
            exit_marks.append(lib._usable_mark((payload or {}).get("quote")))
        if any(m is None for m in exit_marks):
            skip("no back-wing exit quote")
            continue
        bwc_exit = max(exit_marks[0], max(settle - bw_call, 0))
        bwp_exit = max(exit_marks[1], max(bw_put - settle, 0))

        slip = args.slippage
        front_wing_intrinsic = max(settle - fw_call, 0) + max(fw_put - settle, 0)
        # Same-expiry reverse fly: 4 legs traded once (wings expire).
        rfly_pnl = (straddle_intrinsic - straddle_cost + front_wing_credit
                    - front_wing_intrinsic - slip * 4) * 100
        # Cross-expiry: 4 legs at entry + 2 back wings bought back at exit.
        xrf_pnl = (straddle_intrinsic - straddle_cost + back_wing_credit
                   - (bwc_exit + bwp_exit) - slip * 6) * 100

        trades.append({
            "entry": entry.isoformat(),
            "front": front.isoformat(),
            "back": back.isoformat(),
            "spot": round(spot, 2),
            "atm": atm,
            "settle": round(settle, 2),
            "slope_td": round(slope_td, 4),
            "em": round(em, 4),
            "front_wing_credit": round(front_wing_credit, 4),
            "back_wing_credit": round(back_wing_credit, 4),
            "back_wing_exit": round(bwc_exit + bwp_exit, 4),
            "rfly_pnl": round(rfly_pnl, 2),
            "xrf_pnl": round(xrf_pnl, 2),
        })

    return trades, skips


def _stats(values):
    if not values:
        return "n=0"
    n = len(values)
    mean = statistics.mean(values)
    sd = statistics.pstdev(values) if n > 1 else 0.0
    sharpe = mean / sd * 52 ** 0.5 if sd else float("nan")
    win = 100 * sum(1 for v in values if v > 0) / n
    return (f"n={n:4d}  mean={mean:+7.1f}  med={statistics.median(values):+7.1f}"
            f"  win={win:4.1f}%  worst={min(values):+8.1f}  sum={sum(values):+9.0f}"
            f"  Sharpe={sharpe:5.2f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default="SPY")
    parser.add_argument("--start", default="2010-01-01")
    parser.add_argument("--end", default="2026-06-26")
    parser.add_argument("--front-dte", type=int, default=7)
    parser.add_argument("--back-mult", type=float, default=2.0)
    parser.add_argument("--lambda", dest="lam", type=float, default=0.3)
    parser.add_argument("--slippage", type=float, default=0.0)
    parser.add_argument("--csv", default="")
    args = parser.parse_args()

    trades, skips = run(args)
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
          f"  trades {len(trades)}  lambda {args.lam}  slippage {args.slippage}")
    print(f"Skips: {skips}")
    zones = (("deep contango", lambda s: s < 0.95),
             ("neutral", lambda s: 0.95 <= s <= 1.05),
             ("backwardation", lambda s: s > 1.05))
    for label, keep in zones + (("ALL", lambda s: True),):
        subset = [t for t in trades if keep(t["slope_td"])]
        if not subset:
            continue
        print(f"\n### {label} (n={len(subset)})")
        print(f"  same-expiry rfly : {_stats([t['rfly_pnl'] for t in subset])}")
        print(f"  cross-expiry rfly: {_stats([t['xrf_pnl'] for t in subset])}")
        paired = [t["xrf_pnl"] - t["rfly_pnl"] for t in subset]
        print(f"  paired xrf-rfly  : mean {statistics.mean(paired):+.1f}"
              f"  med {statistics.median(paired):+.1f}"
              f"  xrf wins {100 * sum(1 for d in paired if d > 0) / len(paired):.0f}%")
        credit_f = statistics.mean(t["front_wing_credit"] for t in subset)
        credit_b = statistics.mean(t["back_wing_credit"] for t in subset)
        exit_b = statistics.mean(t["back_wing_exit"] for t in subset)
        print(f"  wing econ: front credit {credit_f:.2f} (expires) | "
              f"back credit {credit_b:.2f} -> buyback {exit_b:.2f} "
              f"(harvested {credit_b - exit_b:+.2f})")


if __name__ == "__main__":
    main()
