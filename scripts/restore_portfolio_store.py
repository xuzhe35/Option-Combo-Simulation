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
- Installation is journaled: originals are displaced first and tracked,
  and ANY failure — main install included, OSError included — rolls the
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
    (staged_shards, unrecoverable, error)."""
    manifest = portfolio_archive.load_recovery_manifest_for(backup_path)
    if manifest is None and not allow_missing:
        return None, None, (
            f'no recovery manifest references {backup_path.name} — its '
            'publish never completed (or the manifest is gone), so this '
            'file cannot be trusted as a complete recovery set. Pick a '
            'backup named by a recovery-manifest-*.json in the same '
            'folder, or accept a degraded restore with '
            '--allow-missing-shards.'
        )
    if manifest is not None:
        main_entry = manifest['main']
        if (portfolio_archive._sha256_file(backup_path) != main_entry['sha256']
                or backup_path.stat().st_size != main_entry['bytes']):
            if not allow_missing:
                return None, None, (
                    f'{backup_path.name} does not match its recovery '
                    'manifest (hash/size drift) — refusing to restore. '
                    'Accept a degraded restore with --allow-missing-shards.'
                )
            # Degraded mode: the manifest no longer describes this file
            # (e.g. a later failed publish overwrote it). Treat the set as
            # manifest-less; every shard becomes best-effort.
            manifest = None

    main_stage = tmpdir / 'main.db'
    shutil.copyfile(backup_path, main_stage)
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
        entry = manifest_shards.get(archive_id)
        candidate = (shard_src_dir / entry['name']) if entry else None
        ok = (entry is not None and candidate.exists()
              and candidate.stat().st_size == entry['bytes']
              and portfolio_archive._sha256_file(candidate) == entry['sha256'])
        if not ok:
            if allow_missing:
                unrecoverable.append(archive_id)
                continue
            return None, None, (
                f'archive shard {archive_id} has no snapshot matching the '
                'recovery manifest — refusing to install a database whose '
                'archive entries would point at missing or drifted shards. '
                'Re-run with --allow-missing-shards to accept a PARTIAL '
                'recovery.'
            )
        stage = tmpdir / f'{archive_id}.db'
        shutil.copyfile(candidate, stage)
        shard = portfolio_archive.ArchiveShard(stage)
        shard.quick_check()
        if shard.meta()['archive_id'] != archive_id:
            return None, None, (
                f'snapshot {candidate.name} does not contain shard '
                f'{archive_id}'
            )
        staged_shards[archive_id] = (stage, candidate.name)

    error = _cross_verify(main_stage, staged_shards, set(unrecoverable))
    if error:
        return None, None, error
    return staged_shards, sorted(unrecoverable), None


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


def _install_set(backup_path, db_path, staged_shards, archive_dir):
    """Install main + shards, journaled end to end: the old main database
    is displaced and RECORDED before the new one lands, so a failure at
    any later point — new-main copy, post-install check, shard installs —
    rolls the entire previous set back."""
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    displaced = []   # (displaced_path, original_path)
    installed = []   # newly created paths

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
        db_path.parent.mkdir(parents=True, exist_ok=True)
        displaced_main = None
        if db_path.exists():
            displaced_main = db_path.parent / f'{db_path.name}.pre-restore-{stamp}'
            os.replace(db_path, displaced_main)
            displaced.append((str(displaced_main), str(db_path)))
            for suffix in ('-wal', '-shm'):
                sidecar = pathlib.Path(str(db_path) + suffix)
                if sidecar.exists():
                    moved = pathlib.Path(str(displaced_main) + suffix)
                    os.replace(sidecar, moved)
                    displaced.append((str(moved), str(sidecar)))
        shutil.copyfile(backup_path, db_path)
        installed.append(str(db_path))
        installed_store = PortfolioStore(db_path)
        installed_store.initialize().quick_check()
        # The snapshot may carry the PUBLISHER's live maintenance lease and
        # in-flight jobs from backup time. Nothing from that machine runs
        # here (we hold the exclusive runtime lock), so clear them — or the
        # restored machine's own maintenance would be locked out for a full
        # lease TTL and jobs would show running forever.
        conn = sqlite3.connect(db_path)
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
        result = {
            'restored_from': str(backup_path),
            'db_path': str(db_path),
            'displaced_to': str(displaced_main) if displaced_main else None,
        }
        return result, None
    except (PortfolioStoreError, OSError) as exc:
        _rollback()
        return None, f'install failed and was rolled back: {exc}'


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
                staged_shards, unrecoverable, error = _verify_set(
                    backup_path, tmpdir, args.allow_missing_shards,
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
        maintenance.release()
        runtime.release()

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
