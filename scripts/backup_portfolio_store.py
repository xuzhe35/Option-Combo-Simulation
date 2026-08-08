"""Publish one verified static backup of the workspace store.

Safe while the backends are running: the snapshot is taken with the SQLite
backup API, quick_check-verified locally, then atomically renamed into the
target folder — the live WAL/SHM are never copied and sync software never
sees a half-written file.

    python scripts/backup_portfolio_store.py [--backup-dir DIR] [--db-path P]
"""

import argparse
import configparser
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from portfolio_store import (
    DEFAULT_BACKUP_KEEP_DAILY,
    DEFAULT_BACKUP_KEEP_WEEKLY,
    PortfolioStore,
    PortfolioStoreError,
    default_app_data_dir,
    resolve_backup_dir,
    resolve_db_path,
)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db-path', help='active database (default: auto-resolved)')
    parser.add_argument('--backup-dir', help='publish target (default: config/env, '
                        'else <app-data>/backups)')
    parser.add_argument('--keep-daily', type=int, default=DEFAULT_BACKUP_KEEP_DAILY)
    parser.add_argument('--keep-weekly', type=int, default=DEFAULT_BACKUP_KEEP_WEEKLY)
    parser.add_argument('--prune-revisions', action='store_true',
                        help='after a successful verified backup, apply the '
                             'revision retention policy and a bounded vacuum')
    parser.add_argument('--revision-keep-recent', type=int, default=50)
    parser.add_argument('--revision-keep-daily-days', type=int, default=90)
    args = parser.parse_args(argv)

    config = configparser.ConfigParser()
    config.read(REPO_ROOT / 'config.ini')

    db_path = pathlib.Path(args.db_path) if args.db_path else resolve_db_path(config)
    backup_dir = (
        pathlib.Path(args.backup_dir) if args.backup_dir
        else (resolve_backup_dir(config) or default_app_data_dir() / 'backups')
    )

    try:
        store = PortfolioStore(db_path).initialize()
        published = store.publish_backup(
            backup_dir, keep_daily=args.keep_daily, keep_weekly=args.keep_weekly,
        )
    except PortfolioStoreError as exc:
        print(f'backup failed ({exc.code}): {exc}', file=sys.stderr)
        return 1
    print(f'published {published}')

    if args.prune_revisions:
        # The verified backup above is the precondition for destructive
        # retention; a failed publish already returned before this point.
        deleted = store.prune_revisions(
            keep_recent=args.revision_keep_recent,
            keep_daily_days=args.revision_keep_daily_days,
        )
        print(f'pruned {deleted} revision(s)')
        if store.freelist_count() > 0:
            store.incremental_vacuum(max_pages=512)
        print(f'quick_check: {store.quick_check()}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
