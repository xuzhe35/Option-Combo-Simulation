#!/usr/bin/env python3
"""Stamp every local script/stylesheet reference with a content hash.

The workspace pages are served as static files, so a browser will happily keep
running yesterday's ``valuation.js`` against today's ``ws_client.js`` unless the
URL changes.  Hand-maintained ``?v=`` tags have failed that job repeatedly:
commit 94ed93b ("Bust stale market calendar script caches") exists for exactly
this, and a 2026-08-06 review still found ten references pointing at a stale tag
while the file behind them had changed.

This replaces the hand-written tag with ``?v=<sha256[:12]>`` of the file's own
bytes, which is the convention ``js/market_holidays.js`` already used.  A tag is
then impossible to forget: it is wrong only if the file changed, and running
this script fixes it.

Usage::

    python3 scripts/stamp_asset_versions.py            # rewrite the pages
    python3 scripts/stamp_asset_versions.py --check    # exit 1 if any drift

``--check`` is what a pre-commit hook or CI step should run.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Every page that loads workspace assets. A page missing from this list keeps
# stale tags forever, so add new pages here when they are created.
PAGES = (
    'index.html',
    'chart_lab.html',
    'iv_term_structure.html',
    'workspace_db_admin.html',
)

HASH_LENGTH = 12

# src="js/foo.js?v=abc" / href="style.css?v=abc". Anything with a scheme (a CDN
# font, say) is skipped by the leading-character class.
ASSET_REFERENCE = re.compile(
    r'(?P<attr>\b(?:src|href)=")(?P<path>[A-Za-z0-9_./-]+\.(?:js|css))(?:\?v=(?P<tag>[^"]*))?(?P<close>")'
)


def content_tag(asset_path: Path) -> str:
    return hashlib.sha256(asset_path.read_bytes()).hexdigest()[:HASH_LENGTH]


def stamp_page(page_path: Path, *, check_only: bool) -> tuple[str, list[str]]:
    """Return (rewritten_text, drift_messages) for one page."""
    original = page_path.read_text(encoding='utf-8')
    drift: list[str] = []
    missing: list[str] = []

    def replace(match: re.Match[str]) -> str:
        relative = match.group('path')
        asset_path = PROJECT_ROOT / relative
        if not asset_path.is_file():
            # A typo'd or deleted asset is a real problem, but it is not this
            # script's job to guess a fix; report it and leave the text alone.
            missing.append(relative)
            return match.group(0)

        expected = content_tag(asset_path)
        current = match.group('tag')
        if current != expected:
            drift.append(
                f'{page_path.name}: {relative} '
                f'{current if current is not None else "(no ?v=)"} -> {expected}'
            )
        return f"{match.group('attr')}{relative}?v={expected}{match.group('close')}"

    rewritten = ASSET_REFERENCE.sub(replace, original)

    for relative in missing:
        drift.append(f'{page_path.name}: MISSING asset {relative}')

    if not check_only and rewritten != original:
        # write_text with the default newline handling would rewrite line
        # endings; these pages are LF and several tracked files in this repo are
        # mixed CRLF, so keep the bytes we were given.
        page_path.write_bytes(rewritten.encode('utf-8'))

    return rewritten, drift


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        '--check',
        action='store_true',
        help='report drift and exit 1 without modifying any page',
    )
    args = parser.parse_args(argv)

    all_drift: list[str] = []
    has_missing = False
    for page_name in PAGES:
        page_path = PROJECT_ROOT / page_name
        if not page_path.is_file():
            print(f'skipping {page_name}: not found', file=sys.stderr)
            continue
        _, drift = stamp_page(page_path, check_only=args.check)
        all_drift.extend(drift)
        has_missing = has_missing or any('MISSING asset' in line for line in drift)

    if not all_drift:
        print('asset versions are current')
        return 0

    for line in all_drift:
        print(line)

    if args.check:
        print(f'\n{len(all_drift)} reference(s) out of date. '
              'Run: python3 scripts/stamp_asset_versions.py')
        return 1

    print(f'\nstamped {len(all_drift)} reference(s)')
    return 1 if has_missing else 0


if __name__ == '__main__':
    raise SystemExit(main())
