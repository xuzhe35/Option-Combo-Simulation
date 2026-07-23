"""Command-line interface for the standalone daily yield curve.

Examples:
    python -m yield_curve update
    python -m yield_curve update --if-needed
    python -m yield_curve status
"""

from __future__ import annotations

import argparse
import json
import sys

from .repository import DEFAULT_DATA_DIR, YieldCurveRepository
from .updater import YieldCurveUpdater


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build and inspect the unified USD reference curve")
    subparsers = parser.add_subparsers(dest="command")

    update = subparsers.add_parser("update", help="download official sources and write today's snapshot")
    update.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    update.add_argument("--timeout", type=float, default=20.0)
    update.add_argument("--date", help="market as-of date, YYYY-MM-DD (default: most recent New York business day)")
    update.add_argument("--if-needed", action="store_true", help="skip when this market date already exists")
    update.add_argument("--json", action="store_true", help="print the complete result as JSON")

    status = subparsers.add_parser("status", help="show the latest local snapshot without network access")
    status.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    status.add_argument("--json", action="store_true", help="print machine-readable JSON")
    return parser


def _print_status(status, as_json=False):
    if as_json:
        print(json.dumps(status, ensure_ascii=False, sort_keys=True, indent=2))
        return
    if not status.get("available"):
        print("Yield curve: unavailable")
        print("Data directory: {}".format(status.get("dataDir") or ""))
        return
    print("Yield curve: {}".format(status.get("snapshotId") or "available"))
    print("Curve as-of: {}".format(status.get("curveAsOf") or ""))
    print("Source effective date: {}".format(status.get("effectiveDate") or ""))
    print("Available as-of: {}".format(status.get("availableAsOf") or ""))
    print("Source: {}".format(status.get("source") or ""))
    print("Latest file: {}".format(status.get("latestPath") or ""))


def main(argv=None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0].startswith("-"):
        arguments.insert(0, "update")
    parser = _parser()
    args = parser.parse_args(arguments)
    repository = YieldCurveRepository(args.data_dir)
    if args.command == "status":
        status = repository.status()
        _print_status(status, as_json=args.json)
        return 0 if status.get("available") else 1

    updater = YieldCurveUpdater(repository=repository, timeout=args.timeout)
    result = updater.update(requested_date=args.date, if_needed=args.if_needed)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    else:
        snapshot = result.get("snapshot") or {}
        print(
            "Yield curve {}: curveAsOf={} effectiveDate={} snapshotId={}".format(
                result.get("status") or "unknown",
                snapshot.get("curveAsOf") or "",
                snapshot.get("effectiveDate") or "",
                snapshot.get("snapshotId") or "",
            )
        )
        if result.get("error"):
            print("Warning: {}".format(result["error"]), file=sys.stderr)
        paths = result.get("paths") or {}
        if paths.get("latestPath"):
            print("Latest file: {}".format(paths["latestPath"]))
    return 0 if result.get("snapshot") else 1


if __name__ == "__main__":
    sys.exit(main())
