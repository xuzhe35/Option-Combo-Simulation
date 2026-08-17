"""Install a verified backup SET (active database + archive shards) as the
active workspace store.

Safety properties:

- The tool holds the same OS maintenance lock the backends use for the
  target database directory: if a backend is running maintenance there, the
  restore refuses instead of racing it (stop the backends first — restoring
  under a live backend corrupts the WAL regardless).
- The ENTIRE set is verified on staged copies before anything moves, and
  shard snapshots are bound to the SAME install id as the main backup file
  name and each shard's own archive_meta.source_install_id — two machines
  publishing into one synced folder can never cross-restore each other's
  payloads.
- A registered shard with no matching snapshot aborts the restore with
  nothing installed (a main database whose archive entries point at missing
  shards is a trap, not a recovery). `--allow-missing-shards` is the
  explicit, dangerous downgrade for partial recovery.
- Installation is transactional at the file level: every displaced original
  is tracked, and ANY failure (including OSError) rolls the whole old set
  back before the tool exits non-zero.

    python scripts/restore_portfolio_store.py <backup.db> --yes [--db-path P]
"""

import argparse
import configparser
import os
import pathlib
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_archive
import portfolio_maintenance
from portfolio_store import (
    PortfolioStore,
    PortfolioStoreError,
    resolve_db_path,
    restore_database,
)

_MAIN_BACKUP_RE = re.compile(
    r'^portfolio-\d{8}T\d{6}Z-schema\d+-([A-Za-z0-9][A-Za-z0-9-]{7,63})\.db$'
)


def _verify_set(backup_path, shard_src_dir, tmpdir, allow_missing):
    """Stage-verify the whole recovery set. Returns (staged_shards,
    unrecoverable) or raises/returns an error string."""
    main_stage = tmpdir / 'main.db'
    shutil.copyfile(backup_path, main_stage)
    staged_store = PortfolioStore(main_stage).initialize()
    staged_store.quick_check()
    registry = staged_store.list_archive_registry()

    match = _MAIN_BACKUP_RE.match(backup_path.name)
    if match is None:
        return None, None, (
            f'{backup_path.name} is not a published backup name; the '
            'install id cannot be determined, so shard snapshots cannot be '
            'matched safely'
        )
    install_id = match.group(1)

    staged_shards = {}
    missing = []
    for row in registry:
        archive_id = row['archive_id']
        # Exact name binding: only THIS install's snapshot of THIS shard.
        # Never glob across installs and pick by mtime — that silently
        # restores another machine's payloads (review 69d509e P1-1).
        candidate = shard_src_dir / f'{archive_id}-{install_id}.db'
        if not candidate.exists():
            missing.append(archive_id)
            continue
        stage = tmpdir / f'{archive_id}.db'
        shutil.copyfile(candidate, stage)
        shard = portfolio_archive.ArchiveShard(stage)
        shard.quick_check()
        meta = shard.meta()
        if meta['archive_id'] != archive_id:
            return None, None, (
                f'snapshot {candidate.name} does not contain shard '
                f'{archive_id}'
            )
        if meta['source_install_id'] != install_id:
            return None, None, (
                f'snapshot {candidate.name} was produced by install '
                f'{meta["source_install_id"]}, not {install_id} — refusing '
                'to mix recovery sets across installs'
            )
        staged_shards[archive_id] = (stage, candidate.name)
    if missing and not allow_missing:
        return None, None, (
            'no snapshot for registered archive shard(s) '
            f'{", ".join(sorted(missing))} (expected '
            f'<archive-id>-{install_id}.db in {shard_src_dir}) — refusing '
            'to install a database whose archive entries would point at '
            'missing shards. Re-run with --allow-missing-shards to accept '
            'a PARTIAL recovery.'
        )
    return staged_shards, sorted(missing), None


def _install_set(backup_path, db_path, staged_shards, archive_dir):
    """Install main + shards with full rollback on ANY failure."""
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    displaced = []   # (displaced_path, original_path) — restore on rollback
    installed = []   # newly created paths — delete on rollback

    def _rollback():
        for path in reversed(installed):
            pathlib.Path(path).unlink(missing_ok=True)
        for moved, original in reversed(displaced):
            try:
                os.replace(moved, original)
            except OSError:
                print(f'ROLLBACK WARNING: could not move {moved} back to '
                      f'{original}; restore it manually', file=sys.stderr)

    try:
        result = restore_database(backup_path, db_path)
        if result['displaced_to']:
            displaced.append((result['displaced_to'], str(db_path)))
            for suffix in ('-wal', '-shm'):
                side = pathlib.Path(result['displaced_to'] + suffix)
                if side.exists():
                    displaced.append((str(side), str(db_path) + suffix))
        installed.append(str(db_path))

        archive_dir.mkdir(parents=True, exist_ok=True)
        for archive_id, (stage, source_name) in staged_shards.items():
            dest = archive_dir / f'{archive_id}.db'
            if dest.exists():
                moved = archive_dir / f'{archive_id}.db.pre-restore-{stamp}'
                os.replace(dest, moved)
                displaced.append((str(moved), str(dest)))
            for suffix in ('-wal', '-shm'):
                sidecar = pathlib.Path(str(dest) + suffix)
                if sidecar.exists():
                    moved = pathlib.Path(
                        f'{dest}.pre-restore-{stamp}{suffix}')
                    os.replace(sidecar, moved)
                    displaced.append((str(moved), str(sidecar)))
            shutil.copyfile(stage, dest)
            installed.append(str(dest))
            portfolio_archive.ArchiveShard(dest).quick_check()
            print(f'installed archive shard {archive_id} '
                  f'(from {source_name})')
        return result, None
    except (PortfolioStoreError, OSError) as exc:
        _rollback()
        return None, f'install failed and was rolled back: {exc}'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', help='main-database backup file published '
                        'by backup_portfolio_store.py (never a .partial)')
    parser.add_argument('--db-path', help='active database (default: auto-resolved)')
    parser.add_argument('--yes', action='store_true',
                        help='confirm the backends are stopped and proceed')
    parser.add_argument('--allow-missing-shards', action='store_true',
                        help='DANGEROUS: install even when registered '
                             'archive shards have no snapshot; archived '
                             'payloads in those shards stay unrecoverable')
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

    # Exclude running backend maintenance via the SAME OS lock the guard
    # chain acquires first. (Backends must be stopped regardless; this
    # makes forgetting that fail closed instead of racing.)
    lock = portfolio_maintenance.OsMaintenanceLock(db_path)
    if not lock.acquire():
        print('maintenance busy: a backend holds the maintenance lock for '
              'this database; stop the backends first', file=sys.stderr)
        return 1
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = pathlib.Path(tmp)
            try:
                staged_shards, unrecoverable, error = _verify_set(
                    backup_path, shard_src_dir, tmpdir,
                    args.allow_missing_shards,
                )
            except (PortfolioStoreError, OSError) as exc:
                print(f'restore failed during verification: {exc}',
                      file=sys.stderr)
                return 1
            if error:
                print(f'restore failed: {error}', file=sys.stderr)
                return 1

            archive_dir = portfolio_archive.resolve_archive_dir(
                db_path, config=config
            )
            result, error = _install_set(
                backup_path, db_path, staged_shards, archive_dir
            )
            if error:
                print(f'restore failed: {error}', file=sys.stderr)
                return 1

        documents = PortfolioStore(db_path).initialize().list_documents()
    except PortfolioStoreError as exc:
        print(f'restore failed ({exc.code}): {exc}', file=sys.stderr)
        return 1
    finally:
        lock.release()

    print(f"restored {result['restored_from']} -> {result['db_path']}")
    if result['displaced_to']:
        print(f"previous database kept at {result['displaced_to']}")
    for archive_id in unrecoverable:
        print(f'WARNING: shard {archive_id} was restored WITHOUT its '
              'snapshot (--allow-missing-shards); its archived payloads '
              'remain unrecoverable', file=sys.stderr)
    print(f'{len(documents)} workspace document(s) visible after restore')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
