"""Install a verified backup SET (active database + archive shards) as the
active workspace store.

STOP ib_server.py and historical_server.py first — restoring under a live
backend corrupts the WAL. The ENTIRE set is verified before anything moves:
the main snapshot is staged and quick-checked, its archive registry is
read, and every registered shard's snapshot (from `<backup dir>/archives/`)
is staged and quick-checked too. A registered shard with no snapshot aborts
the restore with nothing installed — a main database whose archive entries
point at missing shards is not a recovery, it is a trap. Existing files are
displaced to timestamped .pre-restore copies, never overwritten.

    python scripts/restore_portfolio_store.py <backup.db> --yes [--db-path P]
"""

import argparse
import configparser
import os
import pathlib
import shutil
import sys
import tempfile
from datetime import datetime, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_archive
from portfolio_store import (
    PortfolioStore,
    PortfolioStoreError,
    resolve_db_path,
    restore_database,
)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', help='main-database backup file published '
                        'by backup_portfolio_store.py (never a .partial)')
    parser.add_argument('--db-path', help='active database (default: auto-resolved)')
    parser.add_argument('--yes', action='store_true',
                        help='confirm the backends are stopped and proceed')
    args = parser.parse_args(argv)

    if not args.yes:
        print('Refusing to restore without --yes.\n'
              '1. Stop ib_server.py and historical_server.py.\n'
              '2. Re-run with --yes.', file=sys.stderr)
        return 1

    config = configparser.ConfigParser()
    config.read(REPO_ROOT / 'config.ini')
    db_path = pathlib.Path(args.db_path) if args.db_path else resolve_db_path(config)
    backup_path = pathlib.Path(args.backup)
    shard_src_dir = backup_path.parent / 'archives'

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = pathlib.Path(tmp)

            # 1. Verify the main snapshot on a staged copy (initialize also
            # migrates old-schema snapshots) and read its shard registry.
            main_stage = tmpdir / 'main.db'
            shutil.copyfile(backup_path, main_stage)
            staged_store = PortfolioStore(main_stage).initialize()
            staged_store.quick_check()
            registry = staged_store.list_archive_registry()

            # 2. Verify EVERY required shard snapshot before touching the
            # target. Shards already marked missing in the registry at
            # backup time cannot be recovered from this set and are
            # reported; any other registered shard without a snapshot
            # aborts the whole restore.
            staged_shards = {}
            unrecoverable = []
            missing_snapshots = []
            for row in registry:
                archive_id = row['archive_id']
                candidates = sorted(
                    shard_src_dir.glob(f'{archive_id}-*.db'),
                    key=lambda p: p.stat().st_mtime, reverse=True,
                ) if shard_src_dir.exists() else []
                if not candidates:
                    if row['missing_since_utc']:
                        unrecoverable.append(archive_id)
                    else:
                        missing_snapshots.append(archive_id)
                    continue
                stage = tmpdir / f'{archive_id}.db'
                shutil.copyfile(candidates[0], stage)
                shard = portfolio_archive.ArchiveShard(stage)
                shard.quick_check()
                if shard.meta()['archive_id'] != archive_id:
                    print(f'restore failed: snapshot {candidates[0].name} '
                          f'does not contain shard {archive_id}',
                          file=sys.stderr)
                    return 1
                staged_shards[archive_id] = (stage, candidates[0].name)
            if missing_snapshots:
                print('restore failed: no snapshot found for registered '
                      f'archive shard(s) {", ".join(missing_snapshots)} in '
                      f'{shard_src_dir} — refusing to install a database '
                      'whose archive entries would point at missing shards',
                      file=sys.stderr)
                return 1

            # 3. The whole set verified: install the main database, then
            # the shards (displacing any existing files).
            result = restore_database(backup_path, db_path)
            archive_dir = portfolio_archive.resolve_archive_dir(
                db_path, config=config
            )
            archive_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            for archive_id, (stage, source_name) in staged_shards.items():
                dest = archive_dir / f'{archive_id}.db'
                if dest.exists():
                    os.replace(dest, archive_dir
                               / f'{archive_id}.db.pre-restore-{stamp}')
                for suffix in ('-wal', '-shm'):
                    sidecar = pathlib.Path(str(dest) + suffix)
                    if sidecar.exists():
                        os.replace(sidecar, pathlib.Path(
                            f'{dest}.pre-restore-{stamp}{suffix}'))
                shutil.copyfile(stage, dest)
                portfolio_archive.ArchiveShard(dest).quick_check()
                print(f'installed archive shard {archive_id} '
                      f'(from {source_name})')

        documents = PortfolioStore(db_path).initialize().list_documents()
    except PortfolioStoreError as exc:
        print(f'restore failed ({exc.code}): {exc}', file=sys.stderr)
        return 1

    print(f"restored {result['restored_from']} -> {result['db_path']}")
    if result['displaced_to']:
        print(f"previous database kept at {result['displaced_to']}")
    for archive_id in unrecoverable:
        print(f'WARNING: shard {archive_id} was already missing at backup '
              'time and could not be restored', file=sys.stderr)
    print(f'{len(documents)} workspace document(s) visible after restore')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
