"""Thin websocket-backend adapter for the standalone yield-curve service."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import Dict, Optional, Union

from .repository import DEFAULT_DATA_DIR, YieldCurveRepository
from .updater import most_recent_market_business_date


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class YieldCurveBackendAdapter:
    """Read canonical snapshots and self-heal through the independent CLI.

    There is intentionally no downloader/provider logic here.  Historical
    dated requests are read-only and can never trigger a current-data update.
    """

    def __init__(
        self,
        data_dir: Optional[Union[str, os.PathLike]] = None,
        auto_update_if_missing: bool = True,
        auto_update_if_stale: bool = True,
        source_timeout_seconds: float = 20.0,
        process_timeout_seconds: float = 60.0,
        logger: Optional[logging.Logger] = None,
    ):
        self.repository = YieldCurveRepository(data_dir or DEFAULT_DATA_DIR)
        self.auto_update_if_missing = bool(auto_update_if_missing)
        self.auto_update_if_stale = bool(auto_update_if_stale)
        self.source_timeout_seconds = max(1.0, float(source_timeout_seconds))
        self.process_timeout_seconds = max(5.0, float(process_timeout_seconds))
        self.logger = logger or logging.getLogger("yield_curve.backend")
        self._update_lock = None
        self._attempted_dates = set()

    async def _run_update_once(self, target_date: str) -> Dict[str, object]:
        if self._update_lock is None:
            self._update_lock = asyncio.Lock()
        async with self._update_lock:
            if target_date in self._attempted_dates:
                return {"attempted": False, "error": "Automatic update was already attempted for this market date."}
            self._attempted_dates.add(target_date)
            command = [
                sys.executable,
                "-m",
                "yield_curve",
                "update",
                "--if-needed",
                "--data-dir",
                str(self.repository.data_dir),
                "--timeout",
                str(self.source_timeout_seconds),
            ]
            process = None
            try:
                process = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=str(PROJECT_ROOT),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.process_timeout_seconds,
                )
            except asyncio.TimeoutError:
                if process and process.returncode is None:
                    process.kill()
                    await process.communicate()
                return {
                    "attempted": True,
                    "error": "Yield-curve updater timed out after {:.0f}s.".format(self.process_timeout_seconds),
                }
            except (OSError, RuntimeError) as exc:
                return {"attempted": True, "error": "Could not start yield-curve updater: {}".format(exc)}
            output = stdout.decode("utf-8", "replace").strip() if stdout else ""
            error_output = stderr.decode("utf-8", "replace").strip() if stderr else ""
            if process.returncode != 0:
                return {
                    "attempted": True,
                    "error": error_output or output or "Yield-curve updater exited with status {}.".format(process.returncode),
                }
            if output:
                self.logger.info("Yield-curve updater: %s", output.splitlines()[-1])
            return {"attempted": True, "error": error_output}

    async def build_payload(self, request: Optional[Dict[str, object]] = None) -> Dict[str, object]:
        data = request if isinstance(request, dict) else {}
        requested_date = str(data.get("requestedDate") or "").strip()
        if requested_date:
            snapshot = await asyncio.to_thread(self.repository.load_on_or_before, requested_date)
            return {
                "action": "discount_curve_snapshot",
                "status": "cached" if snapshot else "unavailable",
                "fallbackUsed": False,
                "refreshAttempted": False,
                "error": "" if snapshot else (
                    "No unified yield-curve snapshot is cached on or before the requested date."
                ),
                "curve": snapshot,
            }

        snapshot = await asyncio.to_thread(self.repository.load_latest)
        # Weekend/holiday sessions quote against the last business day, so a
        # Friday-stamped snapshot must not be treated as stale on Saturday or
        # Sunday (that would re-run the updater on every weekend request).
        target_date = most_recent_market_business_date().isoformat()
        curve_date = str(snapshot.get("curveAsOf") or "") if snapshot else ""
        missing = snapshot is None
        stale = bool(snapshot and curve_date < target_date)
        refresh_allowed = data.get("refresh") is not False
        should_update = refresh_allowed and (
            (missing and self.auto_update_if_missing)
            or (stale and self.auto_update_if_stale)
        )
        update_result = {"attempted": False, "error": ""}
        if should_update:
            update_result = await self._run_update_once(target_date)
            snapshot = await asyncio.to_thread(self.repository.load_latest)
            curve_date = str(snapshot.get("curveAsOf") or "") if snapshot else ""
            stale = bool(snapshot and curve_date < target_date)

        error = str(update_result.get("error") or "")
        if not snapshot and not error:
            error = "No unified SOFR/Treasury yield-curve snapshot is available."
        elif stale and not error:
            error = "Yield-curve snapshot {} is older than market date {}.".format(curve_date, target_date)
        fallback_used = bool(snapshot and error)
        status = (
            "updated" if snapshot and update_result.get("attempted") and not error and not stale
            else "cache_fallback" if fallback_used
            else "cached" if snapshot
            else "unavailable"
        )
        return {
            "action": "discount_curve_snapshot",
            "status": status,
            "fallbackUsed": fallback_used,
            "refreshAttempted": update_result.get("attempted") is True,
            "error": error,
            "curve": snapshot,
        }


__all__ = ["YieldCurveBackendAdapter"]
