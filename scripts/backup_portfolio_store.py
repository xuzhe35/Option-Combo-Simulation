"""Publish one verified static backup SET of the workspace store: the
active database plus every registered archive shard.

Safe while the backends are running: the whole publish runs under the same
cross-process maintenance guard the backends use (thread lock, OS file
lock, DB lease), so it can never overlap a running backup, archive, or
vacuum — if one is running, this tool reports busy instead of racing it.
Snapshots are taken with the SQLite backup API, quick_check-verified
locally, then atomically renamed into the target folder — the live WAL/SHM
are never copied and sync software never sees a half-written file.

Without the shard snapshots a main-DB backup is NOT a recovery set: after
archiving, the payloads removed from the active database exist only in the
shards.

    python scripts/backup_portfolio_store.py [--backup-dir DIR] [--db-path P]
"""

import argparse
import configparser
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_archive
import portfolio_maintenance
import portfolio_store_ws
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
    # NOTE: this tool is backup-only by design. The former --prune-revisions
    # flag was removed: the ONLY path that removes revisions is the admin
    # page's archive flow (copy, verify, then remove under the cross-process
    # maintenance guard).
    args = parser.parse_args(argv)

    config = configparser.ConfigParser()
    config.read(REPO_ROOT / 'config.ini')

    db_path = pathlib.Path(args.db_path) if args.db_path else resolve_db_path(config)
    backup_dir = (
        pathlib.Path(args.backup_dir) if args.backup_dir
        else (resolve_backup_dir(config) or default_app_data_dir() / 'backups')
    )

    env = portfolio_store_ws.create_store_env(config)
    try:
        store = PortfolioStore(db_path).initialize()
    except PortfolioStoreError as exc:
        print(f'backup failed ({exc.code}): {exc}', file=sys.stderr)
        return 1
    env['store'] = store
    env['available'] = True
    env['_initialized'] = True

    guard = portfolio_maintenance.acquire_maintenance(env)
    if guard is None:
        print('maintenance busy: a backend is running backup/archive/vacuum '
              'right now; retry in a moment', file=sys.stderr)
        return 1
    try:
        published = store.publish_backup(
            backup_dir, keep_daily=args.keep_daily, keep_weekly=args.keep_weekly,
        )
        shard_backups = portfolio_archive.publish_archive_backups(
            env, backup_dir
        )
        # A recovery set is only complete when EVERY registered shard has a
        # verified snapshot for this install in the target folder.
        install_id = store.ensure_install_id()
        unconfirmed = [
            row['archive_id'] for row in store.list_archive_registry()
            if not (backup_dir / 'archives'
                    / f"{row['archive_id']}-{install_id}.db").exists()
        ]
    except PortfolioStoreError as exc:
        print(f'backup failed ({exc.code}): {exc}', file=sys.stderr)
        return 1
    finally:
        guard.release()

    print(f'published {published}')
    for name in shard_backups['published']:
        print(f'published archive shard snapshot archives/{name}')
    if shard_backups['missing'] or unconfirmed:
        broken = sorted(set(shard_backups['missing']) | set(unconfirmed))
        print('backup INCOMPLETE: registered archive shard(s) '
              f'{", ".join(broken)} have no snapshot in the target — the '
              'published main database references payloads this set cannot '
              'restore', file=sys.stderr)
        return 1
    if not shard_backups['published'] and store.list_archive_registry():
        print('archive shard snapshot(s) already up to date')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
