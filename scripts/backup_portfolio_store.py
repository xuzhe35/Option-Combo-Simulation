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
        recovery = portfolio_archive.publish_recovery_generation(
            env, backup_dir,
            keep_daily=args.keep_daily,
            keep_weekly=args.keep_weekly,
        )
    except Exception as exc:
        code = getattr(exc, 'code', 'store_unavailable')
        print(f'backup failed ({code}): {exc}', file=sys.stderr)
        return 1
    finally:
        guard.release()

    for warning in recovery['housekeepingWarnings']:
        print(f'backup housekeeping WARNING: {warning}', file=sys.stderr)
    if not recovery['complete']:
        print('backup INCOMPLETE: registered archive shard(s) '
              f'{", ".join(recovery["missingShards"])} have no local '
              'snapshot; no recovery manifest was written and the next '
              'scheduled retry will honor the configured interval',
              file=sys.stderr)
        return 1
    print(f"published {recovery['mainPath']}")
    for name in recovery['publishedShards']:
        print(f'published archive shard snapshot archives/{name}')
    for name in recovery['reusedShards']:
        print(f'reused archive shard snapshot archives/{name}')
    print(
        f"published recovery manifest {recovery['manifestPath'].name}"
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
