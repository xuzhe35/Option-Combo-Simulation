"""
Pure helpers for the standalone IV term structure workflow.

Keep this module free of IB-specific side effects so we can unit test the
selection rules separately from websocket orchestration in ib_server.py.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Iterable


DEFAULT_MAX_DTE = 200
DEFAULT_STRIKE_RADIUS = 1
DEFAULT_BUCKET_DEFINITIONS = (
    {"label": "1D", "targetDays": 1},
    {"label": "3D", "targetDays": 3},
    {"label": "1W", "targetDays": 7},
    {"label": "3W", "targetDays": 21},
    {"label": "1M", "targetDays": 30},
    {"label": "3M", "targetDays": 90},
    {"label": "6M", "targetDays": 180},
)


def _parse_anchor_date(value: str | date | datetime | None) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    normalized = str(value or "").strip()
    if not normalized:
        return None

    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(normalized, fmt).date()
        except ValueError:
            continue

    return None


def normalize_expiry_code(value: object) -> str:
    normalized = str(value or "").strip()
    if len(normalized) == 10 and normalized[4] == "-" and normalized[7] == "-":
        normalized = normalized.replace("-", "")
    return normalized if len(normalized) == 8 and normalized.isdigit() else ""


def calculate_calendar_dte(anchor_date: str | date | datetime | None, expiry_code: object) -> int | None:
    anchor = _parse_anchor_date(anchor_date)
    expiry = normalize_expiry_code(expiry_code)
    if anchor is None or not expiry:
        return None

    try:
        expiry_date = datetime.strptime(expiry, "%Y%m%d").date()
    except ValueError:
        return None

    return (expiry_date - anchor).days


def filter_expiry_rows(
    expirations: Iterable[object],
    anchor_date: str | date | datetime | None,
    max_dte: int = DEFAULT_MAX_DTE,
) -> list[dict[str, int | str]]:
    rows: list[dict[str, int | str]] = []
    seen_expiries: set[str] = set()

    for raw_expiry in expirations or []:
        expiry = normalize_expiry_code(raw_expiry)
        if not expiry or expiry in seen_expiries:
            continue

        dte = calculate_calendar_dte(anchor_date, expiry)
        if dte is None or dte < 0 or dte > max(0, int(max_dte or 0)):
            continue

        rows.append({"expiry": expiry, "dte": dte})
        seen_expiries.add(expiry)

    rows.sort(key=lambda item: (int(item["dte"]), str(item["expiry"])))
    return rows


def pick_strike_window(
    strikes: Iterable[object],
    underlying_price: object,
    radius: int = DEFAULT_STRIKE_RADIUS,
) -> dict[str, float | list[float] | None]:
    try:
        target_price = float(underlying_price)
    except (TypeError, ValueError):
        return {"atm_strike": None, "window_strikes": []}

    if not (target_price == target_price):  # NaN guard
        return {"atm_strike": None, "window_strikes": []}

    normalized_strikes = []
    seen = set()
    for raw_strike in strikes or []:
        try:
            strike = float(raw_strike)
        except (TypeError, ValueError):
            continue
        if not (strike == strike):
            continue
        if strike in seen:
            continue
        seen.add(strike)
        normalized_strikes.append(strike)

    if not normalized_strikes:
        return {"atm_strike": None, "window_strikes": []}

    normalized_strikes.sort()
    best_index = min(
        range(len(normalized_strikes)),
        key=lambda index: (abs(normalized_strikes[index] - target_price), normalized_strikes[index]),
    )
    safe_radius = max(0, int(radius or 0))
    start = max(0, best_index - safe_radius)
    end = min(len(normalized_strikes), best_index + safe_radius + 1)
    window = normalized_strikes[start:end]

    return {
        "atm_strike": normalized_strikes[best_index],
        "window_strikes": window,
    }


def _normalize_unique_strikes(strikes: Iterable[object]) -> list[float]:
    normalized_strikes = []
    seen = set()
    for raw_strike in strikes or []:
        try:
            strike = float(raw_strike)
        except (TypeError, ValueError):
            continue
        if not (strike == strike):
            continue
        if strike in seen:
            continue
        seen.add(strike)
        normalized_strikes.append(strike)

    normalized_strikes.sort()
    return normalized_strikes


def pick_shared_strike_window(
    expiry_strikes: dict[str, Iterable[object]],
    underlying_price: object,
    radius: int = DEFAULT_STRIKE_RADIUS,
) -> dict[str, object]:
    try:
        target_price = float(underlying_price)
    except (TypeError, ValueError):
        return {"atm_strike": None, "window_strikes": [], "covered_expiries": []}

    if not (target_price == target_price):
        return {"atm_strike": None, "window_strikes": [], "covered_expiries": []}

    coverage_by_strike: dict[float, set[str]] = {}
    for expiry, raw_strikes in (expiry_strikes or {}).items():
        normalized_expiry = normalize_expiry_code(expiry)
        if not normalized_expiry:
            continue

        for strike in _normalize_unique_strikes(raw_strikes or []):
            coverage_by_strike.setdefault(strike, set()).add(normalized_expiry)

    if not coverage_by_strike:
        return {"atm_strike": None, "window_strikes": [], "covered_expiries": []}

    max_coverage = max(len(expiries) for expiries in coverage_by_strike.values())
    best_coverage_strikes = sorted(
        strike for strike, expiries in coverage_by_strike.items()
        if len(expiries) == max_coverage
    )
    strike_window = pick_strike_window(best_coverage_strikes, target_price, radius)
    atm_strike = strike_window.get("atm_strike")
    covered_expiries = sorted(coverage_by_strike.get(atm_strike, set())) if atm_strike is not None else []

    return {
        "atm_strike": atm_strike,
        "window_strikes": strike_window.get("window_strikes") or [],
        "covered_expiries": covered_expiries,
    }


def choose_trading_class(
    trading_classes: Iterable[object],
    requested_trading_class: object = "",
) -> str:
    requested = str(requested_trading_class or "").strip()
    if requested:
        return requested

    unique_classes: list[str] = []
    seen: set[str] = set()
    for raw_value in trading_classes or []:
        normalized = str(raw_value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_classes.append(normalized)

    return unique_classes[0] if len(unique_classes) == 1 else ""


def build_expiry_strike_selections(
    contract_rows: Iterable[dict[str, object]],
    underlying_price: object,
    radius: int = DEFAULT_STRIKE_RADIUS,
) -> dict[str, dict[str, object]]:
    grouped: dict[str, dict[str, list[object]]] = {}

    for row in contract_rows or []:
        if not isinstance(row, dict):
            continue
        expiry = normalize_expiry_code(row.get("expiry"))
        if not expiry:
            continue

        bucket = grouped.setdefault(expiry, {"strikes": [], "tradingClasses": []})
        bucket["strikes"].append(row.get("strike"))
        bucket["tradingClasses"].append(row.get("tradingClass"))

    strike_sets_by_expiry = {
        expiry: set(_normalize_unique_strikes(bucket.get("strikes") or []))
        for expiry, bucket in grouped.items()
    }
    shared_strike_window = pick_shared_strike_window(strike_sets_by_expiry, underlying_price, radius)
    shared_atm_strike = shared_strike_window.get("atm_strike")
    shared_window_strikes = shared_strike_window.get("window_strikes") or []

    selections: dict[str, dict[str, object]] = {}
    for expiry, bucket in grouped.items():
        expiry_strikes = strike_sets_by_expiry.get(expiry) or set()
        has_shared_atm = shared_atm_strike is not None and shared_atm_strike in expiry_strikes
        selections[expiry] = {
            "atm_strike": shared_atm_strike if has_shared_atm else None,
            "window_strikes": [
                strike for strike in shared_window_strikes
                if strike in expiry_strikes
            ] if has_shared_atm else [],
            "tradingClass": choose_trading_class(bucket.get("tradingClasses") or []),
        }

    return selections
