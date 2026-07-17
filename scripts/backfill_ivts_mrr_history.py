"""Backfill IVTS history samples from the options-chain database so the
dashboard's MRR watermark starts warm (n=26) instead of collecting for
8+ weeks.

For each symbol present in both the chain DB and iv_term_structure/data/,
this synthesizes one sample per completed trading week (the official week's
last session): underlying close + the ~7DTE ATM straddle mark — exactly the
two inputs computeDisplacementWatermark consumes. Real/manual samples are
preserved. Synthetic rows that are not a validated week-end session are
removed on --write instead of poisoning the live watermark forever.

Usage:
    python3 scripts/backfill_ivts_mrr_history.py            # dry run
    python3 scripts/backfill_ivts_mrr_history.py --write    # apply
    python3 scripts/backfill_ivts_mrr_history.py --weeks 60 --symbols SPY,QQQ

Files are git-tracked; revert with `git checkout -- iv_term_structure/data/`.
"""

import argparse
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SERVICE_URL = "http://127.0.0.1:8750"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "iv_term_structure" / "data"
OFFICIAL_CALENDAR_PATH = PROJECT_ROOT / "exchange_calendars" / "official_exchange_calendars.json"
CALENDAR_ID = "NYSE"
MARKET_TIMEZONE = ZoneInfo("America/New_York")
REGULAR_OPTION_CLOSE = time(16, 15)
OFFICIAL_CALENDAR_MAX_AGE_DAYS = 14

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


def _parse_date(value):
    return datetime.strptime(str(value), "%Y-%m-%d").date()


def _load_official_calendar(calendar_id=CALENDAR_ID):
    try:
        payload = json.loads(OFFICIAL_CALENDAR_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return (payload.get("calendars") or {}).get(calendar_id)


def _official_coverage(official_calendar):
    if not official_calendar:
        return None
    try:
        return (
            _parse_date(official_calendar["coverageStart"]),
            _parse_date(official_calendar["coverageEnd"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _require_fresh_official_calendar(official_calendar, now):
    """Reject missing, stale, or non-authoritative calendar snapshots.

    The chain database is useful evidence for old observed sessions, but it
    cannot authenticate the current holiday/early-close schedule.  Require a
    freshly downloaded NYSE snapshot before granting any row the durable
    ``weeklySessionValidated`` provenance bit.
    """
    if not isinstance(official_calendar, dict):
        raise RuntimeError("official NYSE calendar snapshot is unavailable")
    if str(official_calendar.get("calendarKey") or "").upper() != CALENDAR_ID:
        raise RuntimeError("official calendar key does not match NYSE")
    if official_calendar.get("sourceKind") != "official_html":
        raise RuntimeError("NYSE calendar source is not official_html")
    source_url = str(official_calendar.get("sourceUrl") or "")
    if not source_url.startswith("https://www.nyse.com/"):
        raise RuntimeError("NYSE calendar source URL is not authoritative")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", str(official_calendar.get("sourceSha256") or "")):
        raise RuntimeError("NYSE calendar source hash is missing or invalid")
    if _official_coverage(official_calendar) is None:
        raise RuntimeError("NYSE calendar coverage is missing or invalid")

    now_value = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    raw_fetched_at = str(official_calendar.get("fetchedAt") or "").strip()
    try:
        fetched_at = datetime.fromisoformat(raw_fetched_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeError("NYSE calendar fetchedAt is missing or invalid") from exc
    if fetched_at.tzinfo is None:
        raise RuntimeError("NYSE calendar fetchedAt must include a timezone")
    age = now_value.astimezone(timezone.utc) - fetched_at.astimezone(timezone.utc)
    if age < -timedelta(minutes=5):
        raise RuntimeError("NYSE calendar fetchedAt is in the future")
    if age > timedelta(days=OFFICIAL_CALENDAR_MAX_AGE_DAYS):
        raise RuntimeError(
            f"NYSE calendar snapshot is stale ({age.days} days old; "
            f"maximum {OFFICIAL_CALENDAR_MAX_AGE_DAYS})"
        )
    return official_calendar


def _overlay_official_calendar(observed_dates, official_calendar):
    """Replace the downloaded coverage window with official exchange truth.

    Outside that snapshot, explicit chain-service sessions plus its audited
    missing dates remain the historical calendar authority.
    """
    coverage = _official_coverage(official_calendar)
    if coverage is None:
        return sorted(set(observed_dates))
    coverage_start, coverage_end = coverage
    closures = {
        _parse_date(item["date"])
        for item in official_calendar.get("closures", [])
        if isinstance(item, dict) and item.get("date")
    }
    merged = {
        day for day in observed_dates
        if day < coverage_start or day > coverage_end
    }
    current = coverage_start
    while current <= coverage_end:
        if current.weekday() < 5 and current not in closures:
            merged.add(current)
        current += timedelta(days=1)
    return sorted(merged)


def _session_close_at(entry, official_calendar):
    close_time = REGULAR_OPTION_CLOSE
    for item in (official_calendar or {}).get("earlyCloses", []):
        if not isinstance(item, dict) or item.get("date") != entry.isoformat():
            continue
        raw = str(item.get("optionCloseTime") or item.get("closeTime") or "").strip()
        try:
            close_time = time.fromisoformat(raw)
        except ValueError:
            close_time = REGULAR_OPTION_CLOSE
        break
    return datetime.combine(entry, close_time, tzinfo=MARKET_TIMEZONE)


def _validated_weekly_entries(symbol, now=None, official_calendar=None):
    """Return every completed, data-backed weekly final session.

    A vendor gap on the expected final session skips the week; it never moves
    entry to an earlier date. The current week is excluded until its final
    official session has closed. A non-Friday tail outside official coverage
    is excluded because an observed-data tail cannot prove completeness.
    """
    now_value = now or datetime.now(timezone.utc)
    if now_value.tzinfo is None:
        now_value = now_value.replace(tzinfo=timezone.utc)
    official_calendar = official_calendar if official_calendar is not None else _load_official_calendar()
    official_calendar = _require_fresh_official_calendar(official_calendar, now_value)

    raw_dates = _get(
        "/v1/trading-dates",
        {"symbol": symbol, "start": "1900-01-01", "end": "2999-12-31"},
    )["dates"]
    data_dates = {_parse_date(text) for text in raw_dates}
    audit = _get("/v1/audit/missing-dates", {"symbol": symbol}) or {}
    gap_dates = {
        _parse_date(item["quoteDate"])
        for item in audit.get("missingDates", [])
        if isinstance(item, dict) and item.get("quoteDate")
    }
    observed_dates = data_dates | gap_dates
    calendar_dates = _overlay_official_calendar(observed_dates, official_calendar)
    coverage = _official_coverage(official_calendar)

    by_week = {}
    for day in calendar_dates:
        by_week.setdefault(day.isocalendar()[:2], []).append(day)
    weekly_last_sessions = sorted(max(days) for days in by_week.values())

    now_market = now_value.astimezone(MARKET_TIMEZONE)
    final_observed_week = max(observed_dates).isocalendar()[:2] if observed_dates else None

    records = []
    for entry in weekly_last_sessions:
        if entry not in data_dates:
            continue
        session_close = _session_close_at(entry, official_calendar)
        if now_market < session_close:
            continue

        inside_official = bool(coverage and coverage[0] <= entry <= coverage[1])
        if not inside_official and entry.isocalendar()[:2] == final_observed_week and entry.weekday() != 4:
            continue
        records.append({
            "date": entry,
            "calendarId": CALENDAR_ID,
            "sessionCloseAt": session_close.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": "official_snapshot" if inside_official else "observed_sessions_plus_gap_audit",
        })
    return records


def _weekly_entries(symbol, weeks, now=None, official_calendar=None):
    records = _validated_weekly_entries(symbol, now=now, official_calendar=official_calendar)
    return [record["date"] for record in records[-weeks:]]


def _build_sample(symbol, entry, validation=None):
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
    validation = validation or {
        "calendarId": CALENDAR_ID,
        "sessionCloseAt": _session_close_at(
            entry, _load_official_calendar()
        ).astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "unknown",
    }
    return {
        "symbol": symbol,
        "sampledAt": validation["sessionCloseAt"],
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
        "weeklySessionValidated": True,
        "calendarId": validation["calendarId"],
        "sessionCloseAt": validation["sessionCloseAt"],
        "weeklySessionSource": validation["source"],
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
        validations = _validated_weekly_entries(symbol)
        validation_by_date = {record["date"].isoformat(): record for record in validations}
        original_samples = list(document.get("samples", []))
        cleaned_samples = []
        removed_invalid = 0
        metadata_updates = 0
        for raw_sample in original_samples:
            quote_date = str(raw_sample.get("quoteDate") or raw_sample.get("sampledAt", ""))[:10]
            validation = validation_by_date.get(quote_date)
            if raw_sample.get("backfilled") is True and validation is None:
                removed_invalid += 1
                continue
            if raw_sample.get("backfilled") is True and validation is not None:
                normalized = {
                    **raw_sample,
                    # The official option close is the observation time.  An
                    # older synthetic 20:00Z timestamp must not lose the
                    # per-day latest-sample tie-break to a pre-close auto row.
                    "sampledAt": validation["sessionCloseAt"],
                    "weeklySessionValidated": True,
                    "calendarId": validation["calendarId"],
                    "sessionCloseAt": validation["sessionCloseAt"],
                    "weeklySessionSource": validation["source"],
                }
                if normalized != raw_sample:
                    metadata_updates += 1
                cleaned_samples.append(normalized)
            else:
                cleaned_samples.append(raw_sample)
        existing_dates = {
            str(sample.get("quoteDate") or sample.get("sampledAt", ""))[:10]
            for sample in cleaned_samples
        }
        added, failures = [], {}
        for validation in validations[-args.weeks:]:
            entry = validation["date"]
            if entry.isoformat() in existing_dates:
                continue
            try:
                sample, reason = _build_sample(symbol, entry, validation=validation)
            except Exception as exc:  # network hiccup: skip the week, keep going
                sample, reason = None, f"error: {exc}"
            if sample is None:
                failures[reason] = failures.get(reason, 0) + 1
                continue
            added.append(sample)

        merged = sorted(cleaned_samples + added,
                        key=lambda s: str(s.get("quoteDate") or s.get("sampledAt", "")))
        print(f"{symbol}: +{len(added)} backfilled (existing {len(existing_dates)}, "
              f"total {len(merged)}, invalid synthetic removed {removed_invalid}, "
              f"metadata refreshed {metadata_updates})"
              f"{'  failures ' + str(failures) if failures else ''}")
        if args.write and (added or removed_invalid or metadata_updates):
            document["samples"] = merged
            path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"  wrote {path.relative_to(PROJECT_ROOT)}")
    if not args.write:
        print("\ndry run — rerun with --write to apply (git-tracked, revert via git checkout)")


if __name__ == "__main__":
    main()
