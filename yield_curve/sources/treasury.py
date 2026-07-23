"""In-memory official Treasury CMT adapter for the standalone curve updater."""

from __future__ import annotations

from datetime import date
from typing import Callable, Dict, Optional

from treasury_yield_curve import (
    CURVE_SEMANTICS,
    TREASURY_CURVE_SOURCE,
    TREASURY_METHODOLOGY_URL,
    fetch_treasury_year,
    par_yield_to_continuous_proxy,
    parse_treasury_xml,
    treasury_xml_url,
)


FetchYear = Callable[[int], bytes]


class TreasurySourceError(RuntimeError):
    """No usable official CMT observation was available."""


def load_treasury_observation(
    requested_date: Optional[date] = None,
    timeout: float = 20.0,
    fetcher: Optional[FetchYear] = None,
) -> Dict[str, object]:
    target = requested_date or date.today()
    loader = fetcher or (lambda year: fetch_treasury_year(year, timeout=timeout))
    observations = parse_treasury_xml(loader(target.year))
    candidates = [row for row in observations if str(row.get("date") or "") <= target.isoformat()]
    if not candidates:
        observations = parse_treasury_xml(loader(target.year - 1))
        candidates = [row for row in observations if str(row.get("date") or "") <= target.isoformat()]
    if not candidates:
        raise TreasurySourceError(
            "Treasury feed contains no CMT observation on or before {}".format(target.isoformat())
        )
    selected = max(candidates, key=lambda row: str(row.get("date") or ""))
    effective = str(selected["date"])
    points = []
    for point in selected.get("points", []):
        par_yield = float(point["parYield"])
        points.append({
            "tenorCode": str(point["tenorCode"]),
            "tenorDays": int(point["tenorDays"]),
            "parYield": par_yield,
            "continuousRate": par_yield_to_continuous_proxy(par_yield),
            "inputSemantics": "cmt_par_yield",
            "officialField": str(point.get("officialField") or ""),
        })
    if not points:
        raise TreasurySourceError("Treasury CMT observation {} contains no tenor points".format(effective))
    return {
        "source": TREASURY_CURVE_SOURCE,
        "effectiveDate": effective,
        "quoteAsOfPrecision": "approximate_15_30_America/New_York",
        "quoteConvention": "bond_equivalent_yield_semiannual_par_curve",
        "sourceUrl": treasury_xml_url(target.year),
        "methodologyUrl": TREASURY_METHODOLOGY_URL,
        "curveSemantics": dict(CURVE_SEMANTICS),
        "points": points,
    }


__all__ = ["TreasurySourceError", "load_treasury_observation"]
