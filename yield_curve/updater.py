"""Source orchestration for the standalone daily curve updater."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Callable, Dict, Mapping, Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python 3.8 fallback.
    ZoneInfo = None

from .builder import build_discount_curve_snapshot
from .repository import YieldCurveRepository
from .sources.new_york_fed import load_sofr_observation
from .sources.treasury import load_treasury_observation


def current_market_date(now: Optional[datetime] = None) -> date:
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    if ZoneInfo is not None:
        try:
            return instant.astimezone(ZoneInfo("America/New_York")).date()
        except Exception:
            pass
    return instant.astimezone(timezone.utc).date()


def most_recent_market_business_date(now: Optional[datetime] = None) -> date:
    """Latest New York weekday (Mon-Fri) on or before the NY calendar date.

    Official SOFR/Treasury sources never publish weekend observations, so a
    weekend-stamped ``curveAsOf`` would postdate every live quote date that
    resolves back to the Friday session and trip the browser look-ahead gate.
    Exchange holidays are intentionally not modeled here; consumers that need
    exactness compare against the snapshot ``effectiveDate``.
    """
    market_date = current_market_date(now)
    while market_date.weekday() >= 5:
        market_date -= timedelta(days=1)
    return market_date


class YieldCurveUpdater:
    """Download both official sources and atomically publish one snapshot."""

    def __init__(
        self,
        repository: Optional[YieldCurveRepository] = None,
        timeout: float = 20.0,
        sofr_loader: Optional[Callable[[date], Mapping[str, object]]] = None,
        treasury_loader: Optional[Callable[[date], Mapping[str, object]]] = None,
        now: Optional[Callable[[], datetime]] = None,
    ):
        self.repository = repository or YieldCurveRepository()
        self.timeout = max(1.0, float(timeout))
        self._sofr_loader = sofr_loader
        self._treasury_loader = treasury_loader
        self._now = now or (lambda: datetime.now(timezone.utc))

    def _load_sofr(self, target: date) -> Mapping[str, object]:
        if self._sofr_loader:
            return self._sofr_loader(target)
        return load_sofr_observation(target, timeout=self.timeout)

    def _load_treasury(self, target: date) -> Mapping[str, object]:
        if self._treasury_loader:
            return self._treasury_loader(target)
        return load_treasury_observation(target, timeout=self.timeout)

    def update(self, requested_date: Optional[object] = None, if_needed: bool = False) -> Dict[str, object]:
        instant = self._now()
        if requested_date:
            target = None
            for fmt in ("%Y-%m-%d", "%Y%m%d"):
                try:
                    target = datetime.strptime(str(requested_date), fmt).date()
                    break
                except ValueError:
                    continue
            if target is None:
                raise ValueError("requested_date must be YYYY-MM-DD or YYYYMMDD")
        else:
            target = most_recent_market_business_date(instant)
        existing = self.repository.load_latest()
        if if_needed and existing and str(existing.get("curveAsOf") or "") >= target.isoformat():
            return {
                "status": "not_due",
                "refreshAttempted": False,
                "fallbackUsed": False,
                "snapshot": existing,
                "error": "",
            }

        with self.repository.update_lock(stale_after_seconds=max(180.0, self.timeout * 4.0)) as lock:
            if not lock.acquired:
                cached = self.repository.load_latest()
                return {
                    "status": "already_running",
                    "refreshAttempted": False,
                    "fallbackUsed": cached is not None,
                    "snapshot": cached,
                    "error": "Another yield-curve update is already running.",
                }
            # Recheck after acquiring the cross-process lock.
            existing = self.repository.load_latest()
            if if_needed and existing and str(existing.get("curveAsOf") or "") >= target.isoformat():
                return {
                    "status": "not_due",
                    "refreshAttempted": False,
                    "fallbackUsed": False,
                    "snapshot": existing,
                    "error": "",
                }

            source_errors: Dict[str, str] = {}
            sofr = None
            treasury = None
            try:
                sofr = dict(self._load_sofr(target))
            except Exception as exc:
                source_errors["sofr"] = str(exc)
            try:
                treasury = dict(self._load_treasury(target))
            except Exception as exc:
                source_errors["treasury"] = str(exc)

            # A previously complete snapshot is safer than overwriting it with
            # a newly partial one during a temporary source outage.
            if source_errors and existing:
                return {
                    "status": "cache_fallback",
                    "refreshAttempted": True,
                    "fallbackUsed": True,
                    "snapshot": existing,
                    "error": "; ".join("{}: {}".format(key, value) for key, value in source_errors.items()),
                    "sourceErrors": source_errors,
                }
            if not sofr and not treasury:
                return {
                    "status": "unavailable",
                    "refreshAttempted": True,
                    "fallbackUsed": False,
                    "snapshot": None,
                    "error": "; ".join("{}: {}".format(key, value) for key, value in source_errors.items()),
                    "sourceErrors": source_errors,
                }

            snapshot = build_discount_curve_snapshot(
                target,
                sofr,
                treasury,
                generated_at=instant,
            )
            paths = self.repository.write_snapshot(snapshot)
            raw_paths = {}
            if sofr:
                raw_paths["sofr"] = self.repository.write_raw_source(
                    "sofr", sofr["effectiveDate"], sofr
                )
            if treasury:
                raw_paths["treasury"] = self.repository.write_raw_source(
                    "treasury", treasury["effectiveDate"], treasury
                )
            return {
                "status": "updated" if not source_errors else "updated_partial",
                "refreshAttempted": True,
                "fallbackUsed": False,
                "snapshot": snapshot,
                "error": "; ".join("{}: {}".format(key, value) for key, value in source_errors.items()),
                "sourceErrors": source_errors,
                "paths": paths,
                "rawPaths": raw_paths,
            }


__all__ = ["YieldCurveUpdater", "current_market_date", "most_recent_market_business_date"]
