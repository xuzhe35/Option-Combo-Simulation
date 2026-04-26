#!/usr/bin/env python3
"""Remove local runtime log and pid files produced by launcher scripts."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

LOG_PATTERNS = (
    "http_server.log",
    "ib_server.log",
    "http_server.codex*.log",
    "ib_server.codex*.log",
)

PID_PATTERNS = (
    "*.pid",
)


@dataclass(frozen=True)
class CleanupTarget:
    path: Path
    kind: str
    size: int
    modified_at: datetime


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clean local Option Combo runtime logs and pid files."
    )
    parser.add_argument(
        "--keep-days",
        type=int,
        default=14,
        help="Keep files modified within this many days. Default: 14.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Remove all matching runtime logs and stale pid files regardless of age.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be removed without deleting anything.",
    )
    parser.add_argument(
        "--include-active-pid",
        action="store_true",
        help="Also remove active pid files and matching codex logs.",
    )
    return parser.parse_args()


def is_process_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def read_pid(path: Path) -> int | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def iter_targets(include_active_pid: bool) -> list[CleanupTarget]:
    targets: dict[Path, str] = {}
    active_pid_stems = set()

    for path in ROOT.glob("*.pid"):
        if not path.is_file():
            continue
        pid = read_pid(path)
        if pid is not None and is_process_running(pid):
            active_pid_stems.add(path.stem)

    for pattern in LOG_PATTERNS:
        for path in ROOT.glob(pattern):
            if path.is_file():
                if not include_active_pid:
                    stem_parts = path.name.split(".")
                    if len(stem_parts) >= 3:
                        pid_stem = ".".join(stem_parts[:2])
                        if pid_stem in active_pid_stems:
                            continue
                targets[path] = "log"

    for pattern in PID_PATTERNS:
        for path in ROOT.glob(pattern):
            if not path.is_file():
                continue
            pid = read_pid(path)
            if path.stem in active_pid_stems and not include_active_pid:
                continue
            targets[path] = "pid"

    result = []
    for path, kind in sorted(targets.items()):
        try:
            stat = path.stat()
        except OSError:
            continue
        result.append(
            CleanupTarget(
                path=path,
                kind=kind,
                size=stat.st_size,
                modified_at=datetime.fromtimestamp(stat.st_mtime),
            )
        )
    return result


def format_size(size: int) -> str:
    units = ("B", "KB", "MB", "GB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{size} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def main() -> int:
    args = parse_args()
    if args.keep_days < 0:
        raise SystemExit("--keep-days must be zero or greater")

    cutoff = datetime.now() - timedelta(days=args.keep_days)
    targets = iter_targets(include_active_pid=args.include_active_pid)
    removable = [
        target for target in targets if args.all or target.modified_at < cutoff
    ]

    if not removable:
        print("No matching runtime logs or stale pid files need cleanup.")
        return 0

    total_bytes = sum(target.size for target in removable)
    action = "Would remove" if args.dry_run else "Removing"
    print(f"{action} {len(removable)} file(s), {format_size(total_bytes)} total:")

    for target in removable:
        rel_path = target.path.relative_to(ROOT)
        modified = target.modified_at.strftime("%Y-%m-%d %H:%M:%S")
        print(f"  {rel_path}  {format_size(target.size)}  modified {modified}")
        if not args.dry_run:
            try:
                target.path.unlink()
            except OSError as exc:
                print(f"    failed: {exc}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
