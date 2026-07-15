"""Backfill IVTS history samples from the options-chain database so the
dashboard's MRR watermark starts warm (n=26) instead of collecting for
8+ weeks.

For each symbol present in both the chain DB and iv_term_structure/data/,
this synthesizes one sample per trading week (the week's last session):
underlying close + the ~7DTE ATM straddle mark — exactly the two inputs
computeDisplacementWatermark consumes. Existing samples are preserved;
backfill never overwrites a date that already has a real sample.

Usage:
    python3 scripts/backfill_ivts_mrr_history.py            # dry run
    python3 scripts/backfill_ivts_mrr_history.py --write    # apply
    python3 scripts/backfill_ivts_mrr_history.py --weeks 60 --symbols SPY,QQQ

Files are git-tracked; revert with `git checkout -- iv_term_structure/data/`.
"""

import argparse
import json
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

SERVICE_URL = "http://127.0.0.1:8750"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "iv_term_structure" / "data"

# The watermark's front-row acceptance window (frontTargetDte +- 3).
FRONT_TARGET, FRONT_LO, FRONT_HI = 7, 4, 10


def _get(path, params):
    query = urllib.parse.urlencode(params)
    with urllib.request.urlopen(f"{SERVICE_URL}{path}?{query}", timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _usable_mark(quote):
    if not quote:
        return None
    bid, ask = quote.get("bid") or 0, quote.get("ask") or 0
    if bid > 0 and ask > 0:
        return (bid + ask) / 2.0
    mark = quote.get("mark") or 0
    return mark if mark > 0 else None


def _weekly_entries(symbol, weeks):
    dates = _get("/v1/trading-dates", {"symbol": symbol, "start": "1900-01-01", "end": "2999-12-31"})["dates"]
    by_week = {}
    for text in dates:
        day = datetime.strptime(text, "%Y-%m-%d").date()
        by_week[day.isocalendar()[:2]] = max(day, by_week.get(day.isocalendar()[:2], day))
    return sorted(by_week.values())[-weeks:]


def _build_sample(symbol, entry):
    payload = _get("/v1/expirations", {"symbol": symbol, "date": entry.isoformat(), "mode": "exact"})
    best, best_dist = None, None
    for item in payload["expirations"]:
        expiry = datetime.strptime(item["expiration"], "%Y-%m-%d").date()
        dte = (expiry - entry).days
        if FRONT_LO <= dte <= FRONT_HI and (best is None or abs(dte - FRONT_TARGET) < best_dist):
            best, best_dist = expiry, abs(dte - FRONT_TARGET)
    if best is None:
        return None, "no ~7DTE expiry"

    under = _get("/v1/underlying", {"symbol": symbol, "date": entry.isoformat(), "mode": "exact"})
    spot = (under or {}).get("bar", {}).get("close")
    if not spot:
        return None, "no underlying close"

    chain = _get("/v1/chain", {
        "symbol": symbol, "date": entry.isoformat(), "expiration": best.isoformat(),
        "mode": "exact", "minStrike": spot * 0.9, "maxStrike": spot * 1.1,
    })
    quotes = {}
    for quote in (chain or {}).get("quotes", []):
        quotes.setdefault(quote["strike"], {})[quote["type"]] = quote
    atm, call_mark, put_mark, atm_dist = None, None, None, None
    for strike, pair in quotes.items():
        cm, pm = _usable_mark(pair.get("call")), _usable_mark(pair.get("put"))
        if cm is None or pm is None:
            continue
        dist = abs(strike - spot)
        if atm is None or dist < atm_dist:
            atm, call_mark, put_mark, atm_dist = strike, cm, pm, dist
    if atm is None:
        return None, "no usable ATM pair"

    call_iv = quotes[atm]["call"].get("impliedVolatility")
    put_iv = quotes[atm]["put"].get("impliedVolatility")
    dte = (best - entry).days
    return {
        "symbol": symbol,
        "sampledAt": f"{entry.isoformat()}T20:00:00.000Z",
        "quoteDate": entry.isoformat(),
        "underlyingPrice": round(spot, 4),
        "buckets": [],
        "details": [{
            "expiry": best.strftime("%Y%m%d"),
            "dte": dte,
            "atmStrike": atm,
            "callIv": call_iv,
            "putIv": put_iv,
            "atmIv": (call_iv + put_iv) / 2 if call_iv and put_iv else None,
            "callMark": round(call_mark, 4),
            "putMark": round(put_mark, 4),
            "atmStraddleMark": round(call_mark + put_mark, 4),
            "hasCompletePair": True,
            "atmCallSubId": "",
            "atmPutSubId": "",
        }],
        "backfilled": True,
    }, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", default="")
    parser.add_argument("--weeks", type=int, default=40)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    db_symbols = {item["symbol"] for item in _get("/v1/symbols", {})["symbols"]}
    file_symbols = {path.stem for path in DATA_DIR.glob("*.json")}
    wanted = ([s.strip().upper() for s in args.symbols.split(",") if s.strip()]
              if args.symbols else sorted(db_symbols & file_symbols))
    skipped = sorted(file_symbols - db_symbols)
    if skipped and not args.symbols:
        print(f"skip (no chain-DB history): {', '.join(skipped)}")

    for symbol in wanted:
        if symbol not in db_symbols:
            print(f"{symbol}: not in chain DB, skipped")
            continue
        path = DATA_DIR / f"{symbol}.json"
        document = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
            "symbol": symbol, "version": 1, "samples": [],
        }
        existing_dates = {str(s.get("quoteDate") or s.get("sampledAt", ""))[:10]
                          for s in document.get("samples", [])}
        added, failures = [], {}
        for entry in _weekly_entries(symbol, args.weeks):
            if entry.isoformat() in existing_dates:
                continue
            try:
                sample, reason = _build_sample(symbol, entry)
            except Exception as exc:  # network hiccup: skip the week, keep going
                sample, reason = None, f"error: {exc}"
            if sample is None:
                failures[reason] = failures.get(reason, 0) + 1
                continue
            added.append(sample)

        merged = sorted(document.get("samples", []) + added,
                        key=lambda s: str(s.get("quoteDate") or s.get("sampledAt", "")))
        print(f"{symbol}: +{len(added)} backfilled (existing {len(existing_dates)}, "
              f"total {len(merged)}){'  failures ' + str(failures) if failures else ''}")
        if args.write and added:
            document["samples"] = merged
            path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"  wrote {path.relative_to(PROJECT_ROOT)}")
    if not args.write:
        print("\ndry run — rerun with --write to apply (git-tracked, revert via git checkout)")


if __name__ == "__main__":
    main()
