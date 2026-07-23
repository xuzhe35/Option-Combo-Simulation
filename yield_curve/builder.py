"""Canonical USD reference discount-curve policy.

The curve is deliberately a transparent proxy, not an official OIS zero
curve.  Up to 30 calendar days it uses the latest official overnight SOFR as
a flat future-overnight assumption.  Beyond 30 days it transitions smoothly
to the forward slope of the official Treasury CMT par-yield proxy.

The canonical stored quantity is ``discountFactor``.  ``zeroRate`` and
``continuousRate`` are derived ACT/365F display values.  Interest always uses
calendar time; the option variance/weekend lambda clock never enters here.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timezone
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


CURVE_SCHEMA_VERSION = 2
SHORT_END_DAYS = 30
DEFAULT_DAY_COUNT_BASIS = 365.0
DEFAULT_MAX_EXTRAPOLATION_DAYS = 31


def _finite(value: object, label: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("{} must be numeric".format(label)) from exc
    if not math.isfinite(parsed):
        raise ValueError("{} must be finite".format(label))
    return parsed


def _iso_date(value: object) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value or "").strip().replace("/", "-")
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError("date must be YYYY-MM-DD or YYYYMMDD")


def _utc_iso(value: Optional[datetime] = None) -> str:
    instant = value or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def sofr_act360_to_continuous_act365f(sofr_rate: float) -> float:
    """Convert one ACT/360 simple overnight accrual to an ACT/365F CC rate.

    The conversion preserves the one-day discount factor exactly:

    ``exp(-z/365) == 1 / (1 + sofr/360)``.
    """
    rate = _finite(sofr_rate, "sofr_rate")
    if 1.0 + rate / 360.0 <= 0:
        raise ValueError("sofr_rate is outside the convertible range")
    return 365.0 * math.log1p(rate / 360.0)


def _discount_point(
    tenor_days: int,
    log_discount_cost: float,
    source: str,
    source_effective_date: str,
    input_rate: Optional[float],
    input_semantics: str,
    quality_flags: Sequence[str],
    quote_as_of: str,
    tenor_code: str = "",
    input_par_yield: Optional[float] = None,
) -> Dict[str, object]:
    days = int(tenor_days)
    if days <= 0:
        raise ValueError("curve tenor days must be positive")
    cost = _finite(log_discount_cost, "log_discount_cost")
    discount = math.exp(-cost)
    if not math.isfinite(discount) or discount <= 0:
        raise ValueError("discount factor must be positive")
    zero_rate = cost / (days / DEFAULT_DAY_COUNT_BASIS)
    quality = {
        "status": "degraded",
        "flags": sorted(set(str(flag) for flag in quality_flags if str(flag))),
    }
    point: Dict[str, object] = {
        "tenorCode": str(tenor_code or ""),
        "tenorDays": days,
        "discountFactor": discount,
        "zeroRate": zero_rate,
        "continuousRate": zero_rate,
        "continuousRateIsProxy": True,
        "proxy": True,
        "source": str(source),
        "sourceEffectiveDate": str(source_effective_date),
        "quoteAsOf": quote_as_of,
        "inputSemantics": str(input_semantics),
        "inputRate": input_rate,
        "quality": quality,
    }
    if input_par_yield is not None:
        point["inputParYield"] = float(input_par_yield)
    return point


def _treasury_log_points(treasury: Mapping[str, object]) -> List[Tuple[int, float, Mapping[str, object]]]:
    output = []
    for point in treasury.get("points", []) if isinstance(treasury, Mapping) else []:
        if not isinstance(point, Mapping):
            continue
        try:
            days = int(point.get("tenorDays"))
            rate = _finite(point.get("continuousRate"), "Treasury continuousRate")
        except (TypeError, ValueError):
            continue
        if days <= 0:
            continue
        output.append((days, rate * days / DEFAULT_DAY_COUNT_BASIS, point))
    output.sort(key=lambda item: item[0])
    deduped = []
    seen = set()
    for item in output:
        if item[0] in seen:
            continue
        seen.add(item[0])
        deduped.append(item)
    return deduped


def _log_cost_at(points: Sequence[Tuple[int, float, Mapping[str, object]]], days: float) -> float:
    if not points:
        raise ValueError("Treasury curve has no points")
    target = float(days)
    if target <= points[0][0]:
        zero = points[0][1] / (points[0][0] / DEFAULT_DAY_COUNT_BASIS)
        return zero * target / DEFAULT_DAY_COUNT_BASIS
    if target >= points[-1][0]:
        zero = points[-1][1] / (points[-1][0] / DEFAULT_DAY_COUNT_BASIS)
        return zero * target / DEFAULT_DAY_COUNT_BASIS
    for left, right in zip(points, points[1:]):
        if left[0] <= target <= right[0]:
            weight = (target - left[0]) / (right[0] - left[0])
            return left[1] + weight * (right[1] - left[1])
    raise ValueError("Treasury tenor interpolation failed")


def _source_effective_dates(
    sofr: Optional[Mapping[str, object]],
    treasury: Optional[Mapping[str, object]],
) -> List[str]:
    dates = []
    for source in (sofr, treasury):
        if not source:
            continue
        try:
            dates.append(_iso_date(source.get("effectiveDate")))
        except ValueError:
            continue
    return dates


def _snapshot_id(payload: Mapping[str, object]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "usd-reference:{}".format(hashlib.sha256(canonical).hexdigest()[:20])


def build_discount_curve_snapshot(
    requested_date: object,
    sofr: Optional[Mapping[str, object]],
    treasury: Optional[Mapping[str, object]],
    generated_at: Optional[datetime] = None,
) -> Dict[str, object]:
    """Build one canonical hybrid discount-curve snapshot.

    At least one source is required.  With both sources present, daily nodes
    over the 30-day-to-first-CMT interval approximate a C1 smooth transition
    in instantaneous-forward space.  Beyond that interval only the Treasury
    *slope* is retained; the discount level remains anchored to SOFR at day 30.
    """
    curve_as_of = _iso_date(requested_date)
    available_as_of = _utc_iso(generated_at)
    source_dates = _source_effective_dates(sofr, treasury)
    if not source_dates:
        raise ValueError("at least one valid SOFR or Treasury source is required")
    for effective in source_dates:
        if effective > curve_as_of:
            raise ValueError("source effective date {} is after curve as-of {}".format(effective, curve_as_of))

    points: List[Dict[str, object]] = []
    quality_flags = ["reference_curve_is_proxy", "not_bootstrapped_ois_zero_curve"]
    sofr_rate = None
    sofr_cc = None
    if sofr:
        sofr_rate = _finite(sofr.get("rate"), "SOFR rate")
        sofr_cc = sofr_act360_to_continuous_act365f(sofr_rate)
        sofr_effective = _iso_date(sofr.get("effectiveDate"))
        sofr_flags = ["overnight_sofr_flat_proxy", "act360_to_continuous_act365f"]
        for days, tenor_code in ((1, "ON"), (SHORT_END_DAYS, "30d")):
            points.append(_discount_point(
                days,
                sofr_cc * days / DEFAULT_DAY_COUNT_BASIS,
                source=str(sofr.get("source") or "nyfed:sofr"),
                source_effective_date=sofr_effective,
                input_rate=sofr_rate,
                input_semantics="overnight_sofr_flat_future_proxy_act360_simple",
                quality_flags=sofr_flags,
                quote_as_of=available_as_of,
                tenor_code=tenor_code,
            ))
        quality_flags.extend(sofr_flags)

    treasury_points = _treasury_log_points(treasury or {})
    treasury_effective = _iso_date(treasury.get("effectiveDate")) if treasury else ""
    if sofr_cc is not None and treasury_points:
        later_points = [item for item in treasury_points if item[0] > SHORT_END_DAYS]
        if later_points:
            transition_end = later_points[0][0]
            treasury_start_cost = _log_cost_at(treasury_points, SHORT_END_DAYS)
            treasury_end_cost = _log_cost_at(treasury_points, transition_end)
            transition_years = (transition_end - SHORT_END_DAYS) / DEFAULT_DAY_COUNT_BASIS
            treasury_forward = (treasury_end_cost - treasury_start_cost) / transition_years
            sofr_anchor_cost = sofr_cc * SHORT_END_DAYS / DEFAULT_DAY_COUNT_BASIS
            treasury_flags = ["cmt_par_yield_proxy", "not_bootstrapped_zero_curve"]
            blend_flags = treasury_flags + ["smooth_forward_blend"]
            for days in range(SHORT_END_DAYS + 1, transition_end + 1):
                u = (days - SHORT_END_DAYS) / (transition_end - SHORT_END_DAYS)
                # Integral from 0..u of smoothstep(v)=3v^2-2v^3.
                smooth_integral = u ** 3 - 0.5 * u ** 4
                log_cost = sofr_anchor_cost + transition_years * (
                    sofr_cc * u + (treasury_forward - sofr_cc) * smooth_integral
                )
                points.append(_discount_point(
                    days,
                    log_cost,
                    source="hybrid:nyfed_sofr+treasury_cmt",
                    source_effective_date=min(_iso_date(sofr.get("effectiveDate")), treasury_effective),
                    input_rate=None,
                    input_semantics="smoothstep_instantaneous_forward_blend",
                    quality_flags=blend_flags,
                    quote_as_of=available_as_of,
                    tenor_code="blend{}d".format(days),
                ))
            hybrid_end_cost = -math.log(float(points[-1]["discountFactor"]))
            for days, raw_cost, raw_point in later_points[1:]:
                log_cost = hybrid_end_cost + (raw_cost - treasury_end_cost)
                points.append(_discount_point(
                    days,
                    log_cost,
                    source=str(treasury.get("source") or "treasury:daily_treasury_yield_curve"),
                    source_effective_date=treasury_effective,
                    input_rate=float(raw_point.get("parYield")),
                    input_par_yield=float(raw_point.get("parYield")),
                    input_semantics="cmt_par_yield_forward_slope_proxy_sofr_anchored",
                    quality_flags=treasury_flags + ["sofr_level_anchor"],
                    quote_as_of=available_as_of,
                    tenor_code=str(raw_point.get("tenorCode") or ""),
                ))
            quality_flags.extend(blend_flags + ["sofr_level_anchor"])
        else:
            quality_flags.append("treasury_has_no_tenor_beyond_short_end")
    elif treasury_points:
        treasury_flags = ["cmt_par_yield_proxy", "not_bootstrapped_zero_curve", "sofr_unavailable"]
        for days, log_cost, raw_point in treasury_points:
            points.append(_discount_point(
                days,
                log_cost,
                source=str(treasury.get("source") or "treasury:daily_treasury_yield_curve"),
                source_effective_date=treasury_effective,
                input_rate=float(raw_point.get("parYield")),
                input_par_yield=float(raw_point.get("parYield")),
                input_semantics="cmt_par_yield_as_zero_proxy",
                quality_flags=treasury_flags,
                quote_as_of=available_as_of,
                tenor_code=str(raw_point.get("tenorCode") or ""),
            ))
        quality_flags.extend(treasury_flags)
    elif sofr_cc is not None:
        quality_flags.append("treasury_unavailable_short_end_only")

    points.sort(key=lambda point: int(point["tenorDays"]))
    deduped: List[Dict[str, object]] = []
    seen = set()
    for point in points:
        days = int(point["tenorDays"])
        if days in seen:
            continue
        seen.add(days)
        deduped.append(point)
    if not deduped:
        raise ValueError("curve construction produced no points")

    effective_date = min(source_dates)
    source_names = [
        str(source.get("source") or "")
        for source in (sofr, treasury)
        if source and str(source.get("source") or "")
    ]
    sources = {}
    if sofr:
        sources["sofr"] = dict(sofr)
    if treasury:
        sources["treasury"] = dict(treasury)
    payload: Dict[str, object] = {
        "schemaVersion": CURVE_SCHEMA_VERSION,
        "kind": "hybrid_discount_curve" if sofr and treasury_points else (
            "sofr_discount_curve" if sofr else "treasury_discount_curve"
        ),
        "curveId": "usd-reference-discount",
        "currency": "USD",
        "requestedDate": curve_as_of,
        "curveAsOf": curve_as_of,
        "asOf": curve_as_of,
        "effectiveDate": effective_date,
        "availableAsOf": available_as_of,
        "quoteAsOf": available_as_of,
        "valuationCutoff": "EOD",
        "source": "+".join(source_names),
        "points": deduped,
        "dayCountBasis": 365,
        "maxInterpolationGapDays": 370,
        "maxExtrapolationDays": DEFAULT_MAX_EXTRAPOLATION_DAYS,
        "curveSemantics": {
            "curveType": "usd_reference_discount_proxy",
            "canonicalValue": "discount_factor",
            "rateConvention": "continuous_act365f",
            "interpolation": "linear_log_discount_factor",
            "discountRateSemantics": "sofr_short_end_treasury_cmt_forward_slope_proxy",
            "discountingIsApproximate": True,
            "officialZeroCouponCurve": False,
            "varianceClockIndependent": True,
        },
        "discountRateSemantics": "sofr_short_end_treasury_cmt_forward_slope_proxy",
        "policy": {
            "shortEnd": "latest_official_overnight_sofr_flat_proxy",
            "shortEndMaxDays": SHORT_END_DAYS,
            "transition": "smoothstep_instantaneous_forward_to_first_treasury_node",
            "longEnd": "treasury_cmt_proxy_forward_slope_sofr_anchored",
            "sofrAveragesUsage": "diagnostics_only_backward_looking_not_curve_nodes",
        },
        "quality": {
            "status": "degraded",
            "flags": sorted(set(quality_flags)),
        },
        "sources": sources,
    }
    payload["snapshotId"] = _snapshot_id(payload)
    for point in payload["points"]:
        point["snapshotId"] = payload["snapshotId"]
    return payload


def resolve_snapshot_discount(snapshot: Mapping[str, object], maturity_days: float) -> Dict[str, object]:
    """Resolve ``D(T)`` from a canonical snapshot using log-D interpolation."""
    days = _finite(maturity_days, "maturity_days")
    if days < 0:
        raise ValueError("maturity_days must be non-negative")
    raw_points = snapshot.get("points", []) if isinstance(snapshot, Mapping) else []
    points = []
    for point in raw_points:
        if not isinstance(point, Mapping):
            continue
        try:
            tenor = float(point.get("tenorDays"))
            discount = _finite(point.get("discountFactor"), "discountFactor")
        except (TypeError, ValueError):
            continue
        if tenor > 0 and discount > 0:
            points.append((tenor, -math.log(discount), point))
    points.sort(key=lambda item: item[0])
    if not points:
        raise ValueError("snapshot contains no valid discount points")
    max_extrapolation = float(snapshot.get("maxExtrapolationDays", DEFAULT_MAX_EXTRAPOLATION_DAYS))
    if days <= points[0][0]:
        if points[0][0] - days > max_extrapolation:
            raise ValueError("maturity is outside the short-end extrapolation bound")
        zero = points[0][1] / (points[0][0] / DEFAULT_DAY_COUNT_BASIS)
        log_cost = zero * days / DEFAULT_DAY_COUNT_BASIS
        method = "extrapolated_flat" if days < points[0][0] else "exact"
    elif days >= points[-1][0]:
        if days - points[-1][0] > max_extrapolation:
            raise ValueError("maturity is outside the long-end extrapolation bound")
        zero = points[-1][1] / (points[-1][0] / DEFAULT_DAY_COUNT_BASIS)
        log_cost = zero * days / DEFAULT_DAY_COUNT_BASIS
        method = "extrapolated_flat" if days > points[-1][0] else "exact"
    else:
        left, right = points[0], points[-1]
        for candidate_left, candidate_right in zip(points, points[1:]):
            if candidate_left[0] <= days <= candidate_right[0]:
                left, right = candidate_left, candidate_right
                break
        if days == left[0]:
            log_cost = left[1]
            method = "exact"
        elif days == right[0]:
            log_cost = right[1]
            method = "exact"
        else:
            weight = (days - left[0]) / (right[0] - left[0])
            log_cost = left[1] + weight * (right[1] - left[1])
            method = "interpolated_log_discount"
    discount = math.exp(-log_cost)
    zero_rate = log_cost / (days / DEFAULT_DAY_COUNT_BASIS) if days > 0 else 0.0
    return {
        "maturityDays": days,
        "discountFactor": discount,
        "continuousRate": zero_rate,
        "zeroRate": zero_rate,
        "method": method,
        "snapshotId": str(snapshot.get("snapshotId") or ""),
        "source": str(snapshot.get("source") or ""),
    }


__all__ = [
    "CURVE_SCHEMA_VERSION",
    "DEFAULT_MAX_EXTRAPOLATION_DAYS",
    "SHORT_END_DAYS",
    "build_discount_curve_snapshot",
    "resolve_snapshot_discount",
    "sofr_act360_to_continuous_act365f",
]
