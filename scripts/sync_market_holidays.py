"""One-click maintenance for the NYSE holiday calendar (js/market_holidays.js).

The JS calendar is a rule engine (nth-weekday rules, Easter algorithm,
weekend observance) that needs no annual regeneration. What rules cannot
predict are ad-hoc full-day closures — presidential mourning days, disaster
closures — and rule changes (e.g. Juneteenth only since 2022).

This script treats the ACTUAL exchange trading dates in the
options-chain-service database as ground truth and diffs the JS rule engine
against them, weekday by weekday, over the full data range:

  * data CLOSED but rules say OPEN  -> missing ad-hoc closure
  * data OPEN  but rules say HOLIDAY -> rule over-marks (a rule bug)

Default run is a dry-run report. With --write it regenerates the
`BEGIN/END GENERATED CLOSURES` block inside js/market_holidays.js from the
diff (preserving any manually added FUTURE closures the data cannot see
yet), then re-verifies to zero mismatches.

Usage:
    python3 scripts/sync_market_holidays.py            # verify (annual check)
    python3 scripts/sync_market_holidays.py --write    # fix + verify

Requires: node on PATH, and the options-chain service running
(Options DB workspace: python3 chain_server.py, default 127.0.0.1:8750).

Exit code 0 = calendar matches the data; 1 = mismatches remain.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOLIDAYS_JS = os.path.join(PROJECT_ROOT, "js", "market_holidays.js")
SERVICE_URL = "http://127.0.0.1:8750"
# Labels for well-known ad-hoc closures, used when regenerating the block.
DEFAULT_LABELS = {
    "2012-10-29": "Hurricane Sandy",
    "2012-10-30": "Hurricane Sandy",
    "2018-12-05": "National day of mourning — George H. W. Bush",
    "2025-01-09": "National day of mourning — Jimmy Carter",
}

BLOCK_RE = re.compile(
    r"// BEGIN GENERATED CLOSURES \(scripts/sync_market_holidays\.py\)\n"
    r".*?"
    r"// END GENERATED CLOSURES",
    re.DOTALL,
)

NODE_DRIVER = """
const fs = require('fs');
const vm = require('vm');
// 'use strict' at the top of the target file gives eval() its own scope,
// so run it as a script in the global context instead (same mechanism the
// test harness uses); top-level declarations become globals.
vm.runInThisContext(fs.readFileSync(process.argv[2], 'utf8'));
const [start, end] = [process.argv[3], process.argv[4]];
const out = [];
let d = new Date(start + 'T00:00:00Z');
const stop = new Date(end + 'T00:00:00Z');
while (d <= stop) {
    const key = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && isMarketHoliday(key)) {
        out.push(key);
    }
    d.setUTCDate(d.getUTCDate() + 1);
}
process.stdout.write(JSON.stringify(out));
"""


def fetch_json(path, params=""):
    with urllib.request.urlopen(f"{SERVICE_URL}{path}?{params}", timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def actual_trading_dates():
    payload = fetch_json("/v1/trading-dates",
                         "symbol=SPY&start=1900-01-01&end=2999-12-31")
    dates = payload["dates"]
    # The chain calendar defines its own coverage; verify strictly inside it.
    return min(dates), max(dates), set(dates)


def known_data_gaps():
    """Dates the chain service's own audit marks as missing DATA (vendor
    gaps, wash rejections) — the market was open, the dataset just has a
    hole. These must never be written into the closure list."""
    try:
        payload = fetch_json("/v1/audit/missing-dates", "symbol=SPY")
    except Exception:
        return set()
    return {item["quoteDate"] for item in payload.get("missingDates", [])}


def rule_engine_holidays(start, end):
    """Weekday dates the CURRENT js/market_holidays.js marks as holidays."""
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as handle:
        handle.write(NODE_DRIVER)
        driver = handle.name
    try:
        result = subprocess.run(
            ["node", driver, HOLIDAYS_JS, start, end],
            capture_output=True, text=True, check=True,
        )
        return set(json.loads(result.stdout))
    finally:
        os.unlink(driver)


def weekdays_between(start, end):
    day = datetime.date.fromisoformat(start)
    stop = datetime.date.fromisoformat(end)
    while day <= stop:
        if day.weekday() < 5:
            yield day.isoformat()
        day = day + datetime.timedelta(days=1)


def current_generated_closures(source):
    match = BLOCK_RE.search(source)
    if not match:
        raise SystemExit("GENERATED CLOSURES block not found in js/market_holidays.js")
    return set(re.findall(r"'(\d{4}-\d{2}-\d{2})'", match.group(0)))


def write_generated_block(source, closures, labels):
    lines = ["// BEGIN GENERATED CLOSURES (scripts/sync_market_holidays.py)",
             "const MARKET_CLOSURE_EXCEPTIONS = new Set(["]
    for date in sorted(closures):
        label = labels.get(date, "ad-hoc closure (from exchange data)")
        lines.append(f"    '{date}', // {label}")
    lines.append("]);")
    lines.append("// END GENERATED CLOSURES")
    return BLOCK_RE.sub("\n".join(lines), source)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true",
                        help="regenerate the closures block from the data diff")
    args = parser.parse_args()

    start, end, open_dates = actual_trading_dates()
    print(f"Ground truth: SPY exchange calendar {start} .. {end} "
          f"({len(open_dates)} trading days)")

    source = open(HOLIDAYS_JS).read()
    existing = current_generated_closures(source)
    labels = dict(DEFAULT_LABELS)
    for line in source.splitlines():
        found = re.match(r"\s*'(\d{4}-\d{2}-\d{2})', // (.+)$", line)
        if found:
            labels[found.group(1)] = found.group(2)

    holidays = rule_engine_holidays(start, end)
    data_gaps = known_data_gaps()

    missing_closures = []   # data closed, rules say open, not a known gap
    gap_days = []           # data closed, but the audit says missing data
    over_marked = []        # data open, rules say holiday
    for date in weekdays_between(start, end):
        data_open = date in open_dates
        rule_holiday = date in holidays
        if not data_open and not rule_holiday:
            (gap_days if date in data_gaps else missing_closures).append(date)
        elif data_open and rule_holiday:
            over_marked.append(date)

    if gap_days:
        print(f"\nKnown data gaps (audit: market was open, data is missing) — ignored: {', '.join(gap_days)}")

    future_manual = sorted(d for d in existing if d > end)

    if not missing_closures and not over_marked:
        print("OK: rule engine + exceptions exactly match the exchange calendar.")
        if future_manual:
            print(f"Manual future closures kept: {', '.join(future_manual)}")
        return 0

    if missing_closures:
        print(f"\nMissing ad-hoc closures ({len(missing_closures)}):")
        for date in missing_closures:
            print(f"  {date}  (market closed, rules say open)")
    if over_marked:
        print(f"\nRule over-marks ({len(over_marked)}) — fix the RULES, not the list:")
        for date in over_marked:
            print(f"  {date}  (market open, rules say holiday)")

    if not args.write:
        print("\nDry run. Re-run with --write to update js/market_holidays.js.")
        return 1
    if over_marked:
        print("\nRefusing --write: over-marked days mean a rule bug that a "
              "closure list cannot fix. Correct _computeHolidaysForYear first.")
        return 1

    # New block = data-proven closures in range (newly found + already-listed
    # entries the data still confirms closed) + manual future entries the
    # data cannot see yet.
    new_closures = set(missing_closures) | set(future_manual)
    for date in existing:
        if start <= date <= end and date not in open_dates:
            new_closures.add(date)

    updated = write_generated_block(source, new_closures, labels)
    open(HOLIDAYS_JS, "w").write(updated)
    print(f"\nWrote {len(new_closures)} closures to js/market_holidays.js. Re-verifying...")

    holidays_after = rule_engine_holidays(start, end)
    remaining = [d for d in weekdays_between(start, end)
                 if d not in data_gaps
                 and (((d not in open_dates) and (d not in holidays_after))
                      or ((d in open_dates) and (d in holidays_after)))]
    if remaining:
        print(f"STILL MISMATCHED ({len(remaining)}): {remaining[:10]}")
        return 1
    print("OK: calendar now matches the exchange data. "
          "Run `node tests/run.js` before committing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
