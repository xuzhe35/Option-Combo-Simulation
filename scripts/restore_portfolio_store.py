"""Install a verified backup SET (active database + archive shards) as the
active workspace store, driven by its recovery manifest.

Safety properties:

- Only manifest-complete generations restore: the tool locates the
  recovery manifest that names EXACTLY this main backup and verifies every
  member file's sha256/bytes against it. A main backup left behind by a
  failed publish has no manifest and is refused — it can never pair with
  older shard snapshots.
- The publisher identity comes from the manifest; each shard's
  archive_meta.source_install_id is independent origin metadata, so a
  machine that was itself restored can publish backups that restore again.
- Cross-verification: every archive entry and tombstone in the staged main
  database must resolve to a matching row in the staged shard set.
- The tool takes the backends' runtime lock EXCLUSIVELY: a running backend
  (even one doing no maintenance) blocks the restore, and a backend trying
  to open the store mid-restore fails closed. The OS maintenance lock is
  held too, excluding concurrent backup/archive tools.
- Installation is journaled: every new member is prepared and verified in
  its destination directory before tracked originals are displaced. ANY
  later failure — including a mid-swap rename or SQLite error — rolls the
  entire old set back before the tool exits non-zero.
- `--allow-missing-shards` is the explicit, dangerous partial-recovery
  downgrade.

    python scripts/restore_portfolio_store.py <backup.db> --yes [--db-path P]
"""

import argparse
import configparser
import os
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import uuid
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
)


def _verify_set(backup_path, tmpdir, allow_missing):
    """Stage-verify the manifest-bound recovery set. Returns
    (staged_main, staged_shards, unrecoverable, error)."""
    manifest = portfolio_archive.load_recovery_manifest_for(backup_path)
    if manifest is None and not allow_missing:
        return None, None, None, (
            f'no recovery manifest references {backup_path.name} — its '
            'publish never completed (or the manifest is gone), so this '
            'file cannot be trusted as a complete recovery set. Pick a '
            'backup named by a recovery-manifest-*.json in the same '
            'folder, or accept a degraded restore with '
            '--allow-missing-shards.'
        )
    # Copy first, then hash/verify the immutable staged file. Hashing the
    # synced source and later copying it leaves a TOCTOU window in which a
    # sync client can replace the source with a different valid database.
    main_stage = tmpdir / 'main.db'
    shutil.copyfile(backup_path, main_stage)
    if manifest is not None:
        main_entry = manifest['main']
        if (portfolio_archive._sha256_file(main_stage) != main_entry['sha256']
                or main_stage.stat().st_size != main_entry['bytes']):
            if not allow_missing:
                return None, None, None, (
                    f'{backup_path.name} does not match its recovery '
                    'manifest (hash/size drift) — refusing to restore. '
                    'Accept a degraded restore with --allow-missing-shards.'
                )
            # Degraded mode: the manifest no longer describes this file
            # (e.g. a later failed publish overwrote it). Treat the set as
            # manifest-less; every shard becomes best-effort.
            manifest = None

    staged_store = PortfolioStore(main_stage).initialize()
    staged_store.quick_check()
    registry = staged_store.list_archive_registry()

    manifest_shards = {
        entry['archiveId']: entry for entry in manifest.get('shards', [])
    } if manifest is not None else {}
    shard_src_dir = backup_path.parent / 'archives'
    staged_shards = {}
    unrecoverable = []
    for row in registry:
        archive_id = row['archive_id']
        try:
            stage = portfolio_archive.archive_path_for_id(tmpdir, archive_id)
        except portfolio_archive.ArchiveNotFoundError:
            return None, None, None, (
                f'active database contains invalid archive id '
                f'{archive_id!r}; refusing unsafe restore paths'
            )
        entry = manifest_shards.get(archive_id)
        candidate = (shard_src_dir / entry['name']) if entry else None
        if candidate is None or not candidate.exists():
            if allow_missing:
                unrecoverable.append(archive_id)
                continue
            return None, None, None, (
                f'archive shard {archive_id} has no snapshot matching the '
                'recovery manifest — refusing to install a database whose '
                'archive entries would point at missing or drifted shards. '
                'Re-run with --allow-missing-shards to accept a PARTIAL '
                'recovery.'
            )
        shutil.copyfile(candidate, stage)
        if (stage.stat().st_size != entry['bytes']
                or portfolio_archive._sha256_file(stage) != entry['sha256']):
            stage.unlink(missing_ok=True)
            if allow_missing:
                unrecoverable.append(archive_id)
                continue
            return None, None, None, (
                f'archive shard {archive_id} has no snapshot matching the '
                'recovery manifest — refusing to install a database whose '
                'archive entries would point at missing or drifted shards. '
                'Re-run with --allow-missing-shards to accept a PARTIAL '
                'recovery.'
            )
        shard = portfolio_archive.ArchiveShard(stage)
        shard.quick_check()
        if shard.meta()['archive_id'] != archive_id:
            return None, None, None, (
                f'snapshot {candidate.name} does not contain shard '
                f'{archive_id}'
            )
        staged_shards[archive_id] = (stage, candidate.name)

    error = _cross_verify(main_stage, staged_shards, set(unrecoverable))
    if error:
        return None, None, None, error
    _checkpoint_as_standalone(main_stage)
    return main_stage, staged_shards, sorted(unrecoverable), None


def _cross_verify(main_stage, staged_shards, skipped_ids):
    """Every archive entry / tombstone in the staged main database must
    resolve to a matching row in the staged shard set."""
    shard_rows = {}
    for archive_id, (stage, _) in staged_shards.items():
        conn = sqlite3.connect(stage)
        try:
            shard_rows[archive_id] = {
                (row[0], row[1]): row[2] for row in conn.execute(
                    'SELECT document_id, revision, payload_sha256 '
                    'FROM archived_revisions'
                )
            }
        finally:
            conn.close()
    conn = sqlite3.connect(main_stage)
    try:
        for doc_id, revision, archive_id, sha in conn.execute(
            'SELECT document_id, revision, archive_id, payload_sha256 '
            'FROM workspace_archive_entries'
        ):
            if archive_id in skipped_ids:
                continue
            if shard_rows.get(archive_id, {}).get((doc_id, revision)) != sha:
                return (f'archive entry {doc_id}#{revision} has no matching '
                        f'row in shard {archive_id} — the set is not '
                        'internally consistent')
        for doc_id, last_revision, archive_id in conn.execute(
            'SELECT document_id, last_revision, archive_id '
            'FROM workspace_archive_tombstones'
        ):
            if archive_id in skipped_ids:
                continue
            if (doc_id, last_revision) not in shard_rows.get(archive_id, {}):
                return (f'tombstoned document {doc_id} (rev {last_revision}) '
                        f'has no matching row in shard {archive_id} — the '
                        'set is not internally consistent')
    finally:
        conn.close()
    return None


def _copy_and_fsync(source, destination):
    shutil.copyfile(source, destination)
    with open(destination, 'rb') as handle:
        os.fsync(handle.fileno())


def _checkpoint_as_standalone(path):
    """Fold WAL content into the database before copying/renaming one file."""
    conn = sqlite3.connect(path)
    try:
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        mode = conn.execute('PRAGMA journal_mode = DELETE').fetchone()
        if mode is None or str(mode[0]).lower() != 'delete':
            raise sqlite3.OperationalError(
                'could not make staged database self-contained'
            )
    finally:
        conn.close()


def _remove_file_set(path):
    path = pathlib.Path(path)
    path.unlink(missing_ok=True)
    pathlib.Path(str(path) + '-wal').unlink(missing_ok=True)
    pathlib.Path(str(path) + '-shm').unlink(missing_ok=True)


def _sanitize_restored_main(path):
    """Remove publisher-local live state before the file becomes active."""
    store = PortfolioStore(path).initialize()
    store.quick_check()
    conn = sqlite3.connect(path)
    try:
        conn.execute('DELETE FROM workspace_maintenance_lease')
        conn.execute(
            "UPDATE workspace_maintenance_jobs SET status = 'interrupted', "
            "error_code = 'interrupted', error_message = 'interrupted by "
            "database restore' WHERE status IN ('queued', 'running')"
        )
        conn.commit()
    finally:
        conn.close()
    _checkpoint_as_standalone(path)
    PortfolioStore(path).quick_check()


def _install_set(backup_path, staged_main, db_path, staged_shards, archive_dir,
                 unrecoverable=()):
    """Install main + shards with destination-local preparation and a
    journaled swap. Every displaced old member is recorded before a new
    one lands, so any later failure rolls the previous set back."""
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    nonce = uuid.uuid4().hex
    displaced = []   # (displaced_path, original_path)
    installed = []   # atomically installed paths
    pending = []     # (prepared path, destination, source display name)

    def _rollback():
        warnings = []
        for path in reversed(installed):
            try:
                _remove_file_set(path)
            except OSError as exc:
                warnings.append(f'could not remove failed install {path}: {exc}')
        for moved, original in reversed(displaced):
            try:
                os.replace(moved, original)
            except OSError as exc:
                warnings.append(
                    f'could not move {moved} back to {original}: {exc}'
                )
        for warning in warnings:
            print(f'ROLLBACK WARNING: {warning}; restore it manually',
                  file=sys.stderr)
        return warnings

    def _displace(path):
        path = pathlib.Path(path)
        moved_main = None
        if path.exists():
            moved_main = path.parent / (
                f'{path.name}.pre-restore-{stamp}-{nonce}'
            )
            os.replace(path, moved_main)
            displaced.append((str(moved_main), str(path)))
        for suffix in ('-wal', '-shm'):
            sidecar = pathlib.Path(str(path) + suffix)
            if sidecar.exists():
                moved = path.parent / (
                    f'{path.name}.pre-restore-{stamp}-{nonce}{suffix}'
                )
                os.replace(sidecar, moved)
                displaced.append((str(moved), str(sidecar)))
        return moved_main

    try:
        # Prepare and verify every destination-local temp file BEFORE moving
        # any active member. A short copy or SQLite error therefore leaves the
        # old set untouched and only disposable `.partial` files to clean.
        db_path.parent.mkdir(parents=True, exist_ok=True)
        main_pending = db_path.parent / (
            f'.{db_path.name}.restore-{stamp}-{nonce}.partial'
        )
        pending.append((main_pending, db_path, None))
        _copy_and_fsync(staged_main, main_pending)
        _sanitize_restored_main(main_pending)

        archive_dir.mkdir(parents=True, exist_ok=True)
        for archive_id, (stage, source_name) in staged_shards.items():
            dest = portfolio_archive.archive_path_for_id(
                archive_dir, archive_id
            )
            shard_pending = archive_dir / (
                f'.{archive_id}.db.restore-{stamp}-{nonce}.partial'
            )
            pending.append((shard_pending, dest, source_name))
            _copy_and_fsync(stage, shard_pending)
            portfolio_archive.ArchiveShard(shard_pending).quick_check()

        displaced_main = _displace(db_path)
        for _prepared, dest, _source_name in pending[1:]:
            _displace(dest)
        # A degraded restore must not silently reuse a same-named shard
        # already present on the target machine. Quarantine those old files
        # inside the same rollback journal, leaving the active shard path
        # absent exactly as the warning promises.
        for archive_id in unrecoverable:
            _displace(portfolio_archive.archive_path_for_id(
                archive_dir, archive_id
            ))

        for prepared, dest, _source_name in pending:
            os.replace(prepared, dest)
            installed.append(str(dest))

        installed_store = PortfolioStore(db_path).initialize()
        installed_store.quick_check()
        for _prepared, dest, source_name in pending[1:]:
            portfolio_archive.ArchiveShard(dest).quick_check()
            archive_id = dest.stem
            print(f'installed archive shard {archive_id} '
                  f'(from {source_name})')
        document_count = len(installed_store.list_documents())
        result = {
            'restored_from': str(backup_path),
            'db_path': str(db_path),
            'displaced_to': str(displaced_main) if displaced_main else None,
            'document_count': document_count,
        }
        return result, None
    except BaseException as exc:
        warnings = _rollback()
        suffix = ('; ROLLBACK INCOMPLETE — see warnings above'
                  if warnings else '')
        if not isinstance(exc, Exception):
            raise
        return None, f'install failed and was rolled back: {exc}{suffix}'
    finally:
        for prepared, _dest, _source_name in pending:
            try:
                _remove_file_set(prepared)
            except OSError:
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', help='main-database backup file named by a '
                        'recovery-manifest-*.json (never a .partial)')
    parser.add_argument('--db-path', help='active database (default: auto-resolved)')
    parser.add_argument('--yes', action='store_true',
                        help='confirm the backends are stopped and proceed')
    parser.add_argument('--allow-missing-shards', action='store_true',
                        help='DANGEROUS: install even when registered '
                             'archive shards have no manifest-matching '
                             'snapshot; their archived payloads stay '
                             'unrecoverable')
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

    # Backends hold the SHARED runtime lock for their whole process life;
    # taking it EXCLUSIVELY here fails closed while ANY backend runs —
    # including one that is only doing ordinary saves.
    runtime = portfolio_maintenance.BackendRuntimeLock(db_path)
    if not runtime.acquire_exclusive():
        print('a backend is still running against this database (runtime '
              'lock held); stop ib_server.py / historical_server.py first',
              file=sys.stderr)
        return 1
    maintenance = portfolio_maintenance.OsMaintenanceLock(db_path)
    if not maintenance.acquire():
        runtime.release()
        print('maintenance busy: another backup/archive tool holds the '
              'maintenance lock for this database; retry in a moment',
              file=sys.stderr)
        return 1
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = pathlib.Path(tmp)
            try:
                staged_main, staged_shards, unrecoverable, error = _verify_set(
                    backup_path, tmpdir, args.allow_missing_shards,
                )
            except Exception as exc:
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
                backup_path, staged_main, db_path, staged_shards, archive_dir,
                unrecoverable,
            )
            if error:
                print(f'restore failed: {error}', file=sys.stderr)
                return 1

    except PortfolioStoreError as exc:
        print(f'restore failed ({exc.code}): {exc}', file=sys.stderr)
        return 1
    finally:
        maintenance.release()
        runtime.release()

    print(f"restored {result['restored_from']} -> {result['db_path']}")
    if result['displaced_to']:
        print(f"previous database kept at {result['displaced_to']}")
    for archive_id in unrecoverable:
        print(f'WARNING: shard {archive_id} was restored WITHOUT its '
              'snapshot (--allow-missing-shards); its archived payloads '
              'remain unrecoverable', file=sys.stderr)
    print(
        f"{result['document_count']} workspace document(s) visible after restore"
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
