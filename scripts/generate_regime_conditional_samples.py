"""Generate js/regime_conditional_samples.generated.js — the per-symbol,
per-zone conditional outcome samples that power the Probability Analysis
"Regime-conditioned" overlay.

Each sample is one historical week's normalized terminal displacement:
    z = (settle - center) / EM        (EM = the week's ~7DTE ATM straddle)
tagged by the entry week's TD-slope zone (frozen playbook boundaries):
    dc  : slope < 0.95   (deep contango)
    n   : 0.95..1.05     (neutral)
    bw  : slope > 1.05   (backwardation)

Two data modes:
    --csv-dir DIR   read <sym>_base.csv files produced by
                    scripts/backtest_calendar_vs_iron_fly.py --csv (fast)
    (default)       query the options-chain service directly and rebuild the
                    weekly series (slow but self-contained)

Usage:
    python3 scripts/generate_regime_conditional_samples.py --csv-dir /path/to/csvs
    python3 scripts/generate_regime_conditional_samples.py --symbols SPY,QQQ
"""

import argparse
import csv
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = PROJECT_ROOT / "js" / "regime_conditional_samples.generated.js"
DEFAULT_SYMBOLS = ["SPY", "QQQ", "GLD", "SLV", "USO"]

LIB_PATH = Path(__file__).resolve().parent / "backtest_calendar_vs_iron_fly.py"
_spec = importlib.util.spec_from_file_location("btlib", LIB_PATH)
lib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lib)


def _zone(slope):
    return "dc" if slope < 0.95 else ("bw" if slope > 1.05 else "n")


def _from_csv(path):
    rows = list(csv.DictReader(open(path)))
    out = {"dc": [], "n": [], "bw": []}
    for r in rows:
        em = float(r["straddle_credit"])
        if em <= 0:
            continue
        z = (float(r["settle"]) - float(r["center"])) / em
        out[_zone(float(r["slope_td"]))].append(round(z, 3))
    return out, rows[0]["entry"], rows[-1]["entry"]


def _from_service(symbol, start="2010-01-01", end="2099-01-01"):
    """Light re-run of the backtest's weekly loop: slope + EM + settle only."""
    dates_payload = lib._get("/v1/trading-dates", {"symbol": symbol, "start": "1900-01-01", "end": "2999-12-31"})
    data_dates = [lib._parse_date(d) for d in dates_payload["dates"]]
    audit = lib._get("/v1/audit/missing-dates", {"symbol": symbol}) or {}
    gaps = [lib._parse_date(i["quoteDate"]) for i in audit.get("missingDates", [])]
    calendar_dates = lib._overlay_official_calendar(sorted(set(data_dates) | set(gaps)),
                                                    lib._load_official_calendar("NYSE"))
    entries, trading_dates, last_covered, _ = lib._prepare_calendar(
        data_dates, gaps, lib._parse_date(start), lib._parse_date(end), calendar_dates=calendar_dates)

    out = {"dc": [], "n": [], "bw": []}
    first = last = None
    for entry in entries:
        payload = lib._get("/v1/expirations", {"symbol": symbol, "date": entry.isoformat(), "mode": "exact"})
        if payload is None:
            continue
        front = lib._pick_expiry(payload["expirations"], entry, 7, 5, 9)
        if front is None:
            continue
        fdte = (front - entry).days
        back = lib._pick_expiry(payload["expirations"], entry, round(fdte * 2), fdte + 4, round(fdte * 2) + 5)
        if back is None or last_covered is None or back > last_covered:
            continue
        under = lib._get("/v1/underlying", {"symbol": symbol, "date": entry.isoformat(), "mode": "exact"})
        spot = (under or {}).get("bar", {}).get("close")
        if not spot:
            continue
        window = {"minStrike": spot * 0.9, "maxStrike": spot * 1.1}
        fchain = lib._quote_map(lib._get("/v1/chain", {"symbol": symbol, "date": entry.isoformat(),
                                                       "expiration": front.isoformat(), "mode": "exact", **window}))
        bchain = lib._quote_map(lib._get("/v1/chain", {"symbol": symbol, "date": entry.isoformat(),
                                                       "expiration": back.isoformat(), "mode": "exact", **window}))
        atm = lib._atm_strike(fchain, spot)
        batm = lib._atm_strike(bchain, spot)
        if atm is None or batm is None:
            continue
        fc, fp = lib._usable_mark(fchain.get((atm, "call"))), lib._usable_mark(fchain.get((atm, "put")))
        if fc is None or fp is None:
            continue
        f_iv = [fchain[(atm, t)].get("impliedVolatility") for t in ("call", "put")]
        b_iv = [bchain[(batm, t)].get("impliedVolatility") for t in ("call", "put")]
        if not lib._usable_signal_ivs(f_iv + b_iv):
            continue
        bc = lib._usable_mark(bchain.get((batm, "call")))
        bp = lib._usable_mark(bchain.get((batm, "put")))
        if bc is None or bp is None or not (
            lib._signal_iv_price_consistent(sum(f_iv) / 2, fc + fp, atm, fdte)
            and lib._signal_iv_price_consistent(
                sum(b_iv) / 2, bc + bp, batm, (back - entry).days
            )
        ):
            continue
        ftd = lib._td_iv(sum(f_iv) / 2, fdte, lib._trading_day_count(trading_dates, entry, front), 0.3)
        btd = lib._td_iv(sum(b_iv) / 2, (back - entry).days,
                         lib._trading_day_count(trading_dates, entry, back), 0.3)
        if not ftd or not btd:
            continue
        exit_under = lib._get("/v1/underlying", {"symbol": symbol, "date": front.isoformat(), "mode": "on_or_before"})
        settle = (exit_under or {}).get("bar", {}).get("close")
        if not settle:
            continue
        z = (settle - atm) / (fc + fp)
        out[_zone(ftd / btd)].append(round(z, 3))
        first = first or entry.isoformat()
        last = entry.isoformat()
    return out, first, last


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    parser.add_argument("--csv-dir", default="")
    args = parser.parse_args()

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "definition": "z = (settle - center) / front ATM straddle, weekly 7d/14d TD-slope zones (0.95/1.05, lambda=0.3)",
        "symbols": {},
    }
    for symbol in symbols:
        if args.csv_dir:
            path = Path(args.csv_dir) / f"{symbol.lower()}_base.csv"
            if not path.exists():
                print(f"{symbol}: {path} missing, skipped")
                continue
            zones, first, last = _from_csv(path)
        else:
            zones, first, last = _from_service(symbol)
        payload["symbols"][symbol] = {
            "firstEntry": first, "lastEntry": last,
            "dc": zones["dc"], "n": zones["n"], "bw": zones["bw"],
        }
        print(f"{symbol}: dc {len(zones['dc'])}  neutral {len(zones['n'])}  bw {len(zones['bw'])}  ({first} .. {last})")

    body = json.dumps(payload, separators=(",", ":"))
    OUT_PATH.write_text(
        "// GENERATED by scripts/generate_regime_conditional_samples.py — do not edit.\n"
        "// Historical weekly terminal displacements (in EM units) per TD-slope zone;\n"
        "// consumed by prob_charts.js for the regime-conditioned density overlay.\n"
        "(function (globalScope) {\n"
        f"    globalScope.REGIME_CONDITIONAL_SAMPLES = {body};\n"
        "})(typeof globalThis !== 'undefined' ? globalThis : window);\n",
        encoding="utf-8")
    print(f"wrote {OUT_PATH.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
