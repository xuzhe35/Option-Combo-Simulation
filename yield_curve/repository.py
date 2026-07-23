"""Atomic file storage and strict as-of reads for yield-curve snapshots."""

from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import date, datetime
from pathlib import Path
from typing import Dict, Iterable, Mapping, Optional, Union

from .builder import CURVE_SCHEMA_VERSION


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = PROJECT_ROOT / "yield_curve" / "data"


def _normalize_date(value: object) -> str:
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


def _atomic_json_write(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".{}-".format(path.name), suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        if hasattr(os, "O_DIRECTORY"):
            try:
                directory_fd = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
            except OSError:
                directory_fd = None
            if directory_fd is not None:
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def _read_json(path: Path) -> Optional[Dict[str, object]]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _is_snapshot(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    try:
        version = int(payload.get("schemaVersion", 0))
        curve_date = _normalize_date(payload.get("curveAsOf") or payload.get("asOf") or payload.get("effectiveDate"))
    except (TypeError, ValueError):
        return False
    if version < CURVE_SCHEMA_VERSION or not curve_date:
        return False
    points = payload.get("points")
    if not isinstance(points, list) or not points:
        return False
    for point in points:
        if not isinstance(point, dict):
            return False
        try:
            days = float(point.get("tenorDays"))
            discount = float(point.get("discountFactor"))
        except (TypeError, ValueError):
            return False
        if days <= 0 or discount <= 0:
            return False
    return True


def _same_snapshot(
    left: Optional[Mapping[str, object]],
    right: Optional[Mapping[str, object]],
) -> bool:
    if not left or not right:
        return False
    left_id = str(left.get("snapshotId") or "")
    right_id = str(right.get("snapshotId") or "")
    if left_id and right_id:
        return left_id == right_id
    return dict(left) == dict(right)


class UpdateFileLock:
    """Portable best-effort interprocess lock for the small daily updater."""

    def __init__(self, path: Path, stale_after_seconds: float = 180.0):
        self.path = path
        self.stale_after_seconds = float(stale_after_seconds)
        self.acquired = False

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            age = time.time() - self.path.stat().st_mtime
        except (FileNotFoundError, OSError):
            age = 0.0
        if age > self.stale_after_seconds:
            try:
                self.path.unlink()
            except (FileNotFoundError, OSError):
                pass
        try:
            fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return self
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("{}\n".format(os.getpid()))
            handle.flush()
            os.fsync(handle.fileno())
        self.acquired = True
        return self

    def __exit__(self, exc_type, exc, traceback):
        if self.acquired:
            try:
                self.path.unlink()
            except OSError:
                # Cleanup must not replace a completed updater result with an
                # unrelated lock-file exception. A surviving lock remains
                # fail-closed until its normal stale-lock handling succeeds.
                pass
        self.acquired = False


class YieldCurveRepository:
    """Read/write boundary for the canonical JSON snapshot collection."""

    def __init__(self, data_dir: Optional[Union[str, os.PathLike]] = None):
        self.data_dir = Path(data_dir or DEFAULT_DATA_DIR).expanduser().resolve()
        self.latest_path = self.data_dir / "latest.json"
        self.snapshots_dir = self.data_dir / "snapshots"
        self.raw_dir = self.data_dir / "raw"
        self.lock_path = self.data_dir / ".update.lock"

    def _history_paths(self) -> Iterable[Path]:
        if not self.snapshots_dir.exists():
            return []
        return sorted(self.snapshots_dir.glob("*/*.json"), reverse=True)

    def load_latest(self) -> Optional[Dict[str, object]]:
        payload = _read_json(self.latest_path)
        if _is_snapshot(payload):
            return payload
        for path in self._history_paths():
            payload = _read_json(path)
            if _is_snapshot(payload):
                return payload
        return None

    def load_on_or_before(self, requested_date: object) -> Optional[Dict[str, object]]:
        requested = _normalize_date(requested_date)
        candidates = []
        latest = _read_json(self.latest_path)
        if _is_snapshot(latest):
            candidates.append(latest)
        for path in self._history_paths():
            payload = _read_json(path)
            if _is_snapshot(payload):
                candidates.append(payload)
        eligible = []
        seen = set()
        for payload in candidates:
            snapshot_id = str(payload.get("snapshotId") or "")
            if snapshot_id and snapshot_id in seen:
                continue
            if snapshot_id:
                seen.add(snapshot_id)
            curve_date = _normalize_date(
                payload.get("curveAsOf") or payload.get("asOf") or payload.get("effectiveDate")
            )
            if curve_date <= requested:
                eligible.append((curve_date, str(payload.get("availableAsOf") or ""), payload))
        return max(eligible, key=lambda item: (item[0], item[1]))[2] if eligible else None

    def write_snapshot(self, snapshot: Mapping[str, object]) -> Dict[str, str]:
        payload = dict(snapshot)
        if not _is_snapshot(payload):
            raise ValueError("refusing to persist an invalid yield-curve snapshot")
        curve_date = _normalize_date(
            payload.get("curveAsOf") or payload.get("asOf") or payload.get("effectiveDate")
        )
        history_path = self.snapshots_dir / curve_date[:4] / "{}.json".format(curve_date)
        warnings = []

        # latest.json is the commit point and remains a real file, not a
        # symlink, for Windows portability. Publishing it first prevents an
        # uncommitted dated-history file from becoming visible when the commit
        # fails.
        try:
            _atomic_json_write(self.latest_path, payload)
        except OSError as exc:
            # Directory fsync can report an error after os.replace completed.
            # Reconcile against the active file before deciding whether the
            # publication failed.
            active = _read_json(self.latest_path)
            if not _same_snapshot(active, payload):
                raise
            warnings.append(
                "latest snapshot was published, but durability confirmation "
                "raised {}".format(type(exc).__name__)
            )

        history_committed = False
        try:
            _atomic_json_write(history_path, payload)
            history_committed = True
        except OSError as exc:
            # The active snapshot is already committed. A missing archive is
            # non-fatal for live readers and must not be misreported as a
            # fallback to the previous snapshot.
            archived = _read_json(history_path)
            history_committed = _same_snapshot(archived, payload)
            warnings.append(
                "dated history archive {} ({})".format(
                    "was written but durability confirmation failed"
                    if history_committed
                    else "could not be written",
                    type(exc).__name__,
                )
            )

        paths = {
            "historyPath": str(history_path) if history_committed else "",
            "latestPath": str(self.latest_path),
        }
        if warnings:
            paths["warning"] = "; ".join(warnings)
        return paths

    def write_raw_source(self, source_name: str, effective_date: object, payload: Mapping[str, object]) -> str:
        safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(source_name))
        iso_date = _normalize_date(effective_date)
        path = self.raw_dir / safe_name / iso_date[:4] / "{}.json".format(iso_date)
        _atomic_json_write(path, dict(payload))
        return str(path)

    def update_lock(self, stale_after_seconds: float = 180.0) -> UpdateFileLock:
        return UpdateFileLock(self.lock_path, stale_after_seconds=stale_after_seconds)

    def status(self) -> Dict[str, object]:
        latest = self.load_latest()
        return {
            "dataDir": str(self.data_dir),
            "latestPath": str(self.latest_path),
            "available": latest is not None,
            "snapshotId": str(latest.get("snapshotId") or "") if latest else "",
            "curveAsOf": str(latest.get("curveAsOf") or "") if latest else "",
            "effectiveDate": str(latest.get("effectiveDate") or "") if latest else "",
            "availableAsOf": str(latest.get("availableAsOf") or "") if latest else "",
            "source": str(latest.get("source") or "") if latest else "",
        }


__all__ = ["DEFAULT_DATA_DIR", "UpdateFileLock", "YieldCurveRepository"]
