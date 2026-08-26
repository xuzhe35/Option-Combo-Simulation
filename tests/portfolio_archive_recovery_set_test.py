"""Recovery-set regressions: the recovery set must bind to one install,
fail closed on any hole, exclude running maintenance, and roll back a
failed install completely.
"""

import hashlib
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
SCRIPTS_DIR = REPO_ROOT / 'scripts'
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import backup_portfolio_store as backup_cli
import restore_portfolio_store as restore_cli

import portfolio_archive
import portfolio_maintenance
import portfolio_store_ws
from portfolio_store import PortfolioStore

from tests.portfolio_archive_commit_test import DOC_DELETED, run_full_job
from tests.portfolio_archive_test import make_archive_env, make_plan


def _config(tmpdir):
    import configparser
    config = configparser.ConfigParser()
    config.read_string(
        '[portfolio_store]\n'
        f'db_path = {pathlib.Path(tmpdir) / "portfolio.db"}\n'
        'backup_interval_hours = 0\n'
    )
    return config


def _archived_env(root, name):
    """A fully archived environment under root/name: one live document and
    one whole-document archive in shard portfolio-archive-2026-001."""
    home = pathlib.Path(root) / name
    home.mkdir()
    env = make_archive_env(str(home))
    run_full_job(env, make_plan(env))
    return env


def _add_empty_shard(env, archive_id='portfolio-archive-2026-002'):
    store = env['store']
    archive_dir = pathlib.Path(store.db_path).parent / 'archives'
    path = archive_dir / f'{archive_id}.db'
    shard = portfolio_archive.ArchiveShard(
        path, now=store.now_utc
    ).create(
        archive_id=archive_id,
        source_install_id=store.ensure_install_id(),
        part_year=2026,
        part_number=2,
    )
    meta = shard.meta()
    store.upsert_archive_registry(
        archive_id=archive_id,
        archive_schema_version=portfolio_archive.ARCHIVE_SCHEMA_VERSION,
        status='active',
        created_at_utc=meta['created_at_utc'],
        file_bytes=path.stat().st_size,
    )
    return path


def _publish_generation(env, backup_dir, **kwargs):
    """Exercise the one supported recovery-set publication pipeline."""
    guard = portfolio_maintenance.acquire_maintenance(env)
    if guard is None:
        raise AssertionError('test could not acquire maintenance guard')
    try:
        return portfolio_archive.publish_recovery_generation(
            env, backup_dir, **kwargs
        )
    finally:
        guard.release()


class CrossInstallProtectionTest(unittest.TestCase):
    def test_restore_only_accepts_matching_install_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            synced = pathlib.Path(tmp) / 'synced'
            env_a = _archived_env(tmp, 'machine-a')
            env_b = _archived_env(tmp, 'machine-b')

            rc = backup_cli.main(['--db-path', str(env_a['store'].db_path),
                                  '--backup-dir', str(synced)])
            self.assertEqual(rc, 0)
            rc = backup_cli.main(['--db-path', str(env_b['store'].db_path),
                                  '--backup-dir', str(synced)])
            self.assertEqual(rc, 0)

            install_a = env_a['store'].ensure_install_id()
            install_b = env_b['store'].ensure_install_id()
            self.assertNotEqual(install_a, install_b)
            # Both installs published the SAME archive id side by side.
            shard_names = sorted(
                p.name for p in (synced / 'archives').glob('*.db')
            )
            self.assertEqual(len(shard_names), 2)

            # Restoring A's main backup must install the exact immutable shard
            # member named by A's manifest.
            main_a = next(synced.glob(f'portfolio-*-{install_a}@*.db'))
            machine = pathlib.Path(tmp) / 'restored-a'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            rc = restore_cli.main([str(main_a), '--yes',
                                   '--db-path', str(new_db)])
            self.assertEqual(rc, 0)
            meta = portfolio_archive.ArchiveShard(
                machine / 'archives' / 'portfolio-archive-2026-001.db'
            ).meta()
            self.assertEqual(meta['source_install_id'], install_a)

            # With only B's snapshot present, restoring A fails closed —
            # B's same-named shard is never silently substituted.
            next((synced / 'archives').glob(
                f'portfolio-archive-2026-001-{install_a}@*.db'
            )).unlink()
            machine2 = pathlib.Path(tmp) / 'restored-a2'
            machine2.mkdir()
            rc = restore_cli.main([str(main_a), '--yes',
                                   '--db-path', str(machine2 / 'portfolio.db')])
            self.assertEqual(rc, 1)
            self.assertFalse((machine2 / 'portfolio.db').exists())


class MissingShardFailClosedTest(unittest.TestCase):
    def test_backup_fails_when_registered_shard_file_is_gone(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            shard = next(
                (pathlib.Path(env['store'].db_path).parent
                 / 'archives').glob('*.db')
            )
            shard.unlink()
            synced = pathlib.Path(tmp) / 'synced'
            rc = backup_cli.main(['--db-path', str(env['store'].db_path),
                                  '--backup-dir', str(synced)])
            self.assertEqual(rc, 1)  # never "success" for a holed set

    def test_restore_requires_flag_for_known_missing_shards(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            rc = backup_cli.main(['--db-path', str(store.db_path),
                                  '--backup-dir', str(synced)])
            self.assertEqual(rc, 0)

            # The shard goes missing and a verify job records that in the
            # registry; a NEW main backup then carries missing_since_utc.
            next((pathlib.Path(store.db_path).parent
                  / 'archives').glob('*.db')).unlink()
            guard = portfolio_maintenance.acquire_maintenance(env)
            self.assertIsNotNone(guard)
            try:
                portfolio_archive.run_verify_job(
                    env, guard, archive_id='portfolio-archive-2026-001',
                )
            finally:
                guard.release()
            rc = backup_cli.main(['--db-path', str(store.db_path),
                                  '--backup-dir', str(synced)])
            self.assertEqual(rc, 1)  # the set is still incomplete
            main_backup = max(
                synced.glob('portfolio-*.db'),
                key=lambda p: p.stat().st_mtime,
            )
            # Remove the shard snapshot too: nothing recovers this shard.
            for snapshot in (synced / 'archives').glob('*.db'):
                snapshot.unlink()

            machine = pathlib.Path(tmp) / 'restored'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            # Default: fail closed even though the registry KNOWS the shard
            # was already missing — a silent partial restore is the trap.
            rc = restore_cli.main([str(main_backup), '--yes',
                                   '--db-path', str(new_db)])
            self.assertEqual(rc, 1)
            self.assertFalse(new_db.exists())
            # The explicit dangerous flag performs the partial restore.
            rc = restore_cli.main([str(main_backup), '--yes',
                                   '--allow-missing-shards',
                                   '--db-path', str(new_db)])
            self.assertEqual(rc, 0)
            self.assertTrue(new_db.exists())

    def test_degraded_restore_quarantines_same_named_target_shard(self):
        """A missing source shard must never borrow stale target contents."""
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main([
                '--db-path', str(env['store'].db_path),
                '--backup-dir', str(synced),
            ]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))

            target_dir = pathlib.Path(tmp) / 'restored'
            target_dir.mkdir()
            target_db = target_dir / 'portfolio.db'
            self.assertEqual(restore_cli.main([
                str(main_backup), '--yes', '--db-path', str(target_db),
            ]), 0)
            target_shard = (
                target_dir / 'archives' / 'portfolio-archive-2026-001.db'
            )
            self.assertTrue(target_shard.exists())

            # The source generation loses its shard after the first restore.
            # The second, explicitly degraded restore must quarantine the
            # old target shard instead of silently treating it as this set's
            # missing member.
            for source_shard in (synced / 'archives').glob('*.db'):
                source_shard.unlink()
            self.assertEqual(restore_cli.main([
                str(main_backup), '--yes', '--allow-missing-shards',
                '--db-path', str(target_db),
            ]), 0)
            self.assertFalse(target_shard.exists())
            quarantined = list((target_dir / 'archives').glob(
                'portfolio-archive-2026-001.db.pre-restore-*'
            ))
            # Older SQLite/Python builds may still have WAL/SHM sidecars;
            # those must be quarantined with the database rather than left
            # active. Exactly one item is the database itself.
            quarantined_databases = [
                path for path in quarantined
                if not path.name.endswith(('-wal', '-shm'))
            ]
            self.assertEqual(len(quarantined_databases), 1)


class GenerationConsistencyTest(unittest.TestCase):
    """Review 0edf86e P1-1/P1-2: only manifest-complete generations
    restore, and a restored machine can publish restorable backups."""

    def test_failed_publish_cannot_pair_new_main_with_old_shards(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main(
                ['--db-path', str(store.db_path),
                 '--backup-dir', str(synced)]), 0)
            first_mains = set(synced.glob('portfolio-*.db'))

            # A second generation: more revisions get archived into the
            # shard, then the ACTIVE shard file is lost and the next
            # backup fails — publishing a new main file but NO manifest.
            revision = 8
            for n in (60, 61, 62):
                revision = store.save_workspace(
                    document_id='doc-aaaaaaaa-1111-4111-8111-111111111111',
                    title='SPY workspace',
                    payload={'sessionSchemaVersion': 1,
                             'underlyingSymbol': 'SPY',
                             'marketDataMode': 'live', 'groups': [],
                             'hedges': [], 'note': f'gen2 {n}'},
                    save_token=f'save-gen2{n:04d}-4000-8000-000000000000',
                    expected_revision=revision,
                )['revision']
            run_full_job(env, make_plan(env))
            next((pathlib.Path(store.db_path).parent
                  / 'archives').glob('*.db')).unlink()
            self.assertEqual(backup_cli.main(
                ['--db-path', str(store.db_path),
                 '--backup-dir', str(synced)]), 1)
            new_mains = set(synced.glob('portfolio-*.db')) - first_mains
            self.assertEqual(len(new_mains), 1)

            # The orphaned new main is refused: no manifest names it, so
            # it can never borrow the older shard snapshots.
            machine = pathlib.Path(tmp) / 'restored-new'
            machine.mkdir()
            rc = restore_cli.main([str(new_mains.pop()), '--yes',
                                   '--db-path',
                                   str(machine / 'portfolio.db')])
            self.assertEqual(rc, 1)
            self.assertFalse((machine / 'portfolio.db').exists())

            # The manifest-complete FIRST generation still restores as an
            # internally consistent set.
            machine2 = pathlib.Path(tmp) / 'restored-old'
            machine2.mkdir()
            rc = restore_cli.main([str(first_mains.pop()), '--yes',
                                   '--db-path',
                                   str(machine2 / 'portfolio.db')])
            self.assertEqual(rc, 0)

    def test_failed_multi_shard_publish_preserves_last_complete_generation(self):
        """Review 471c093 P1: refreshing one shard in a failed later
        generation must never overwrite a member of the prior manifest."""
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            second_shard = _add_empty_shard(env)
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main(
                ['--db-path', str(store.db_path),
                 '--backup-dir', str(synced)]), 0)

            manifest_path = next(synced.glob('recovery-manifest-*.json'))
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            first_main = synced / manifest['main']['name']
            first_entry = next(
                entry for entry in manifest['shards']
                if entry['archiveId'] == 'portfolio-archive-2026-001'
            )
            first_snapshot = synced / 'archives' / first_entry['name']
            first_bytes = first_snapshot.read_bytes()

            # The later generation republishes shard 001, then discovers that
            # shard 002 is missing. Its immutable names must leave generation
            # 1 byte-for-byte intact.
            live_first = (pathlib.Path(store.db_path).parent / 'archives'
                          / 'portfolio-archive-2026-001.db')
            conn = sqlite3.connect(live_first)
            try:
                conn.execute(
                    'UPDATE archive_meta SET created_at_utc = ?',
                    ('2026-08-17T11:11:11.111Z',),
                )
                conn.commit()
            finally:
                conn.close()
            second_shard.unlink()
            self.assertEqual(backup_cli.main(
                ['--db-path', str(store.db_path),
                 '--backup-dir', str(synced)]), 1)
            self.assertEqual(first_snapshot.read_bytes(), first_bytes)
            self.assertTrue(manifest_path.exists())

            machine = pathlib.Path(tmp) / 'restored-old'
            machine.mkdir()
            self.assertEqual(restore_cli.main([
                str(first_main), '--yes',
                '--db-path', str(machine / 'portfolio.db'),
            ]), 0)

    def test_restore_installs_the_verified_staged_main(self):
        """Review 471c093 P1: source drift after verification cannot change
        the database that is actually installed."""
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main([
                '--db-path', str(env['store'].db_path),
                '--backup-dir', str(synced),
            ]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))
            original_verify = restore_cli._verify_set

            def verify_then_drift(path, tmpdir, allow_missing):
                result = original_verify(path, tmpdir, allow_missing)
                conn = sqlite3.connect(path)
                try:
                    conn.execute('PRAGMA journal_mode = DELETE')
                    conn.execute(
                        'UPDATE workspace_documents SET title = ?',
                        ('DRIFTED AFTER VERIFICATION',),
                    )
                    conn.commit()
                finally:
                    conn.close()
                return result

            target = pathlib.Path(tmp) / 'restored' / 'portfolio.db'
            with mock.patch.object(
                restore_cli, '_verify_set', side_effect=verify_then_drift,
            ):
                rc = restore_cli.main([
                    str(main_backup), '--yes', '--db-path', str(target),
                ])
            self.assertEqual(rc, 0)
            titles = [
                row['title'] for row in
                PortfolioStore(target).initialize().list_documents()
            ]
            self.assertNotIn('DRIFTED AFTER VERIFICATION', titles)

    def test_manual_manifest_is_written_while_guard_is_still_held(self):
        """Review 471c093 P2: completion cannot interleave with another
        backup/archive process."""
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            original_write = portfolio_archive._write_recovery_manifest
            observations = []

            def checked_write(*args, **kwargs):
                probe = portfolio_maintenance.OsMaintenanceLock(
                    env['store'].db_path
                )
                acquired = probe.acquire()
                observations.append(acquired)
                if acquired:
                    probe.release()
                return original_write(*args, **kwargs)

            with mock.patch.object(
                portfolio_archive, '_write_recovery_manifest',
                side_effect=checked_write,
            ):
                rc = backup_cli.main([
                    '--db-path', str(env['store'].db_path),
                    '--backup-dir', str(synced),
                ])
            self.assertEqual(rc, 0)
            self.assertEqual(observations, [False])

    def test_retention_removes_and_keeps_whole_generations(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            base = datetime(2026, 8, 14, 12, tzinfo=timezone.utc)
            generations = []

            for offset in range(3):
                now = base + timedelta(days=offset)
                store._now = lambda current=now: current
                # Force a distinct logical snapshot so this test exercises
                # deletion of members unique to an expired generation.
                live_shard = (pathlib.Path(store.db_path).parent / 'archives'
                              / 'portfolio-archive-2026-001.db')
                conn = sqlite3.connect(live_shard)
                try:
                    conn.execute(
                        'UPDATE archive_meta SET created_at_utc = ?',
                        (f'2026-08-{14 + offset:02d}T12:00:00.000Z',),
                    )
                    conn.commit()
                finally:
                    conn.close()
                outcome = _publish_generation(
                    env, synced,
                    keep_daily=2,
                    keep_weekly=0,
                )
                generations.append(
                    (outcome['mainPath'], outcome['manifestPath'],
                     [entry['name'] for entry in outcome['shards']])
                )

            old_main, old_manifest, old_shards = generations[0]
            self.assertFalse(old_main.exists())
            self.assertFalse(old_manifest.exists())
            for name in old_shards:
                self.assertFalse((synced / 'archives' / name).exists())

            for index, (main_path, manifest_path, shard_names) in enumerate(
                generations[1:], start=1
            ):
                self.assertTrue(main_path.exists())
                self.assertTrue(manifest_path.exists())
                for name in shard_names:
                    self.assertTrue((synced / 'archives' / name).exists())
                target = pathlib.Path(tmp) / f'restored-{index}' / 'portfolio.db'
                self.assertEqual(restore_cli.main([
                    str(main_path), '--yes', '--db-path', str(target),
                ]), 0)

    def test_same_second_retention_keeps_the_generation_just_completed(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            fixed = datetime(2026, 8, 17, 12, tzinfo=timezone.utc)
            store._now = lambda: fixed
            generations = []

            # The just-completed second id sorts BEFORE the first id. A
            # lexical tie-breaker would therefore keep the wrong generation.
            generation_ids = ('f' * 32, 'a' * 32)
            with mock.patch.object(
                portfolio_archive, 'new_recovery_generation_id',
                side_effect=generation_ids,
            ):
                for _generation_id in generation_ids:
                    outcome = _publish_generation(
                        env, synced, keep_daily=1, keep_weekly=0,
                    )
                    generations.append(
                        (outcome['mainPath'], outcome['manifestPath'],
                         [entry['name'] for entry in outcome['shards']])
                    )

            old_main, old_manifest, old_shards = generations[0]
            current_main, current_manifest, current_shards = generations[1]
            self.assertFalse(old_main.exists())
            self.assertFalse(old_manifest.exists())
            # The unchanged immutable shard is shared by both manifests, so
            # removing the old generation must preserve the current member.
            self.assertEqual(old_shards, current_shards)
            for name in old_shards:
                self.assertTrue((synced / 'archives' / name).exists())
            self.assertTrue(current_main.exists())
            self.assertTrue(current_manifest.exists())
            for name in current_shards:
                self.assertTrue((synced / 'archives' / name).exists())
            target = pathlib.Path(tmp) / 'same-second' / 'portfolio.db'
            self.assertEqual(restore_cli.main([
                str(current_main), '--yes', '--db-path', str(target),
            ]), 0)

    def test_legacy_format_one_manifest_still_restores(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main([
                '--db-path', str(store.db_path),
                '--backup-dir', str(synced),
            ]), 0)

            current_manifest = next(synced.glob('recovery-manifest-*.json'))
            data = json.loads(current_manifest.read_text(encoding='utf-8'))
            main_path = synced / data['main']['name']
            main_meta = portfolio_archive.parse_published_backup_name(
                main_path.name
            )
            legacy_main = synced / (
                f"portfolio-{main_meta['stamp']}-"
                f"schema{main_meta['schemaVersion']}-"
                f"{main_meta['installId']}.db"
            )
            main_path.rename(legacy_main)
            data['main']['name'] = legacy_main.name

            for entry in data['shards']:
                source = synced / 'archives' / entry['name']
                legacy = synced / 'archives' / (
                    f"{entry['archiveId']}-{data['publisherInstallId']}.db"
                )
                source.rename(legacy)
                entry['name'] = legacy.name
            data['format'] = 1
            data.pop('generationId')
            legacy_manifest = synced / (
                f"recovery-manifest-{data['publisherInstallId']}.json"
            )
            legacy_manifest.write_text(
                json.dumps(data, indent=1, sort_keys=True), encoding='utf-8'
            )
            current_manifest.unlink()

            target = pathlib.Path(tmp) / 'legacy' / 'portfolio.db'
            self.assertEqual(restore_cli.main([
                str(legacy_main), '--yes', '--db-path', str(target),
            ]), 0)
            PortfolioStore(target).initialize().quick_check()

    def test_restored_machine_publishes_restorable_backups(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine1')
            synced1 = pathlib.Path(tmp) / 'synced1'
            self.assertEqual(backup_cli.main(
                ['--db-path', str(env['store'].db_path),
                 '--backup-dir', str(synced1)]), 0)

            # Generation 1 restore onto machine 2.
            machine2 = pathlib.Path(tmp) / 'machine2'
            machine2.mkdir()
            db2 = machine2 / 'portfolio.db'
            rc = restore_cli.main([
                str(next(synced1.glob('portfolio-*.db'))), '--yes',
                '--db-path', str(db2)])
            self.assertEqual(rc, 0)

            # Machine 2 (a NEW install id) publishes its own backup: the
            # shard's origin id differs from the new publisher id, which
            # must not break anything (publisher identity lives in the
            # manifest, origin stays metadata).
            synced2 = pathlib.Path(tmp) / 'synced2'
            self.assertEqual(backup_cli.main(
                ['--db-path', str(db2), '--backup-dir', str(synced2)]), 0)

            # Generation 2 restore onto machine 3 — with archives intact.
            machine3 = pathlib.Path(tmp) / 'machine3'
            machine3.mkdir()
            db3 = machine3 / 'portfolio.db'
            rc = restore_cli.main([
                str(next(synced2.glob('portfolio-*.db'))), '--yes',
                '--db-path', str(db3)])
            self.assertEqual(rc, 0)
            new_env = portfolio_store_ws.create_store_env(
                _config(str(machine3))
            )
            new_env['store'] = PortfolioStore(db3)
            new_env['store'].initialize()
            new_env['available'] = True
            new_env['_initialized'] = True
            result = portfolio_archive.restore_archived_document_as_copy(
                new_env, document_id=DOC_DELETED,
            )
            self.assertEqual(result['restoredRevision'], 1)


class RecoveryPublicationHardeningTest(unittest.TestCase):
    """Regressions for every publication finding recorded after 471c093."""

    def test_unchanged_shard_is_shared_until_its_logical_state_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            base = datetime(2026, 8, 14, 12, tzinfo=timezone.utc)

            store._now = lambda: base
            first = _publish_generation(
                env, synced, keep_daily=10, keep_weekly=0
            )
            store._now = lambda: base + timedelta(days=1)
            second = _publish_generation(
                env, synced, keep_daily=10, keep_weekly=0
            )
            self.assertEqual(len(first['publishedShards']), 1)
            self.assertEqual(second['publishedShards'], [])
            self.assertEqual(len(second['reusedShards']), 1)
            self.assertEqual(
                first['shards'][0]['name'], second['shards'][0]['name']
            )
            self.assertEqual(
                len(list((synced / 'archives').glob('*.db'))), 1
            )

            live_shard = (pathlib.Path(store.db_path).parent / 'archives'
                          / 'portfolio-archive-2026-001.db')
            conn = sqlite3.connect(live_shard)
            try:
                conn.execute(
                    'UPDATE archive_meta SET created_at_utc = ?',
                    ('2026-08-16T12:00:00.000Z',),
                )
                conn.commit()
            finally:
                conn.close()
            store._now = lambda: base + timedelta(days=2)
            third = _publish_generation(
                env, synced, keep_daily=10, keep_weekly=0
            )
            self.assertEqual(len(third['publishedShards']), 1)
            self.assertNotEqual(
                second['shards'][0]['sourceFingerprint'],
                third['shards'][0]['sourceFingerprint'],
            )
            self.assertEqual(
                len(list((synced / 'archives').glob('*.db'))), 2
            )

    def test_orphan_cleanup_handles_generation_and_legacy_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            completed = _publish_generation(env, synced)
            referenced = synced / 'archives' / completed['shards'][0]['name']
            install_id = store.ensure_install_id()
            archive_id = 'portfolio-archive-2026-001'
            archive_dir = synced / 'archives'
            old_generation = archive_dir / (
                portfolio_archive.recovery_archive_snapshot_name(
                    archive_id, install_id, 'b' * 32
                )
            )
            old_legacy = archive_dir / (
                portfolio_archive.recovery_archive_snapshot_name(
                    archive_id, install_id
                )
            )
            recent = archive_dir / (
                portfolio_archive.recovery_archive_snapshot_name(
                    archive_id, install_id, 'c' * 32
                )
            )
            foreign = archive_dir / (
                portfolio_archive.recovery_archive_snapshot_name(
                    archive_id, 'foreign-install', 'd' * 32
                )
            )
            for path in (old_generation, old_legacy, recent, foreign):
                path.write_bytes(b'orphan candidate')
            os.utime(old_generation, (1, 1))
            os.utime(old_legacy, (1, 1))
            os.utime(foreign, (1, 1))

            removed = portfolio_archive.cleanup_orphan_archive_snapshots(
                store, synced, grace_seconds=3600, now_epoch=7200
            )
            self.assertCountEqual(
                removed, [old_generation.name, old_legacy.name]
            )
            self.assertTrue(referenced.exists())
            self.assertTrue(recent.exists())
            self.assertTrue(foreign.exists())

    def test_housekeeping_failure_is_warning_after_complete_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            with mock.patch.object(
                portfolio_archive, '_apply_recovery_generation_retention',
                side_effect=PermissionError('OneDrive has the old file open'),
            ):
                rc = backup_cli.main([
                    '--db-path', str(env['store'].db_path),
                    '--backup-dir', str(synced),
                ])
            self.assertEqual(rc, 0)
            manifest_path = next(synced.glob('recovery-manifest-*.json'))
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            main_path = synced / manifest['main']['name']
            target = pathlib.Path(tmp) / 'restored' / 'portfolio.db'
            self.assertEqual(restore_cli.main([
                str(main_path), '--yes', '--db-path', str(target),
            ]), 0)

    def test_manifest_keeps_digest_of_verified_staging_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            original_publish_shards = portfolio_archive._publish_archive_members
            observed = {}

            def publish_then_sync_drift(*args, **kwargs):
                result = original_publish_shards(*args, **kwargs)
                main_path = next(synced.glob('portfolio-*.db'))
                original_bytes = main_path.read_bytes()
                observed['sha256'] = hashlib.sha256(original_bytes).hexdigest()
                observed['bytes'] = len(original_bytes)
                with open(main_path, 'ab') as handle:
                    handle.write(b'sync-client-drift')
                return result

            with mock.patch.object(
                portfolio_archive, '_publish_archive_members',
                side_effect=publish_then_sync_drift,
            ):
                self.assertEqual(backup_cli.main([
                    '--db-path', str(env['store'].db_path),
                    '--backup-dir', str(synced),
                ]), 0)

            manifest_path = next(synced.glob('recovery-manifest-*.json'))
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            main_path = synced / manifest['main']['name']
            self.assertEqual(manifest['main']['sha256'], observed['sha256'])
            self.assertEqual(manifest['main']['bytes'], observed['bytes'])
            self.assertNotEqual(
                manifest['main']['sha256'],
                hashlib.sha256(main_path.read_bytes()).hexdigest(),
            )
            # The sync-side mutation is detected; it was never blessed by a
            # second read from the destination.
            target = pathlib.Path(tmp) / 'restored' / 'portfolio.db'
            self.assertEqual(restore_cli.main([
                str(main_path), '--yes', '--db-path', str(target),
            ]), 1)
            self.assertFalse(target.exists())

    def test_standalone_retention_cannot_delete_manifest_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            base = datetime(2026, 8, 14, 12, tzinfo=timezone.utc)
            store._now = lambda: base
            complete = _publish_generation(
                env, synced, keep_daily=0, keep_weekly=0
            )

            for offset in (1, 2, 3):
                now = base + timedelta(days=offset)
                store._now = lambda current=now: current
                store.publish_backup(
                    synced, keep_daily=0, keep_weekly=0
                )
            self.assertTrue(complete['manifestPath'].exists())
            self.assertTrue(complete['mainPath'].exists())

    def test_publishers_only_call_the_unified_orchestrator(self):
        ws_source = pathlib.Path(
            portfolio_store_ws.__file__
        ).read_text(encoding='utf-8')
        cli_source = pathlib.Path(
            backup_cli.__file__
        ).read_text(encoding='utf-8')
        for source in (ws_source, cli_source):
            self.assertIn('publish_recovery_generation(', source)
            for private_step in (
                    '_publish_backup_artifact(',
                    '_publish_archive_members(',
                    '_write_recovery_manifest(',
                    '_apply_recovery_generation_retention('):
                self.assertNotIn(private_step, source)

    def test_invalid_calendar_stamp_is_not_an_attempt_or_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            store = env['store']
            synced = pathlib.Path(tmp) / 'synced'
            synced.mkdir()
            install_id = store.ensure_install_id()
            bad_name = (
                f'portfolio-20269999T999999Z-schema2-{install_id}'
                f'@{"e" * 32}.db'
            )
            (synced / bad_name).write_bytes(b'not a database')
            manifest_path = synced / (
                f'recovery-manifest-{install_id}@{"e" * 32}.json'
            )
            manifest_path.write_text(json.dumps({
                'format': 3,
                'publisherInstallId': install_id,
                'generationId': 'e' * 32,
                'main': {
                    'name': bad_name,
                    'sha256': '0' * 64,
                    'bytes': 14,
                },
                'shards': [],
            }), encoding='utf-8')
            self.assertIsNone(
                portfolio_archive._load_recovery_manifest(manifest_path)
            )
            self.assertIsNone(portfolio_archive.latest_recovery_attempt_epoch(
                store, synced
            ))


class RuntimeLockTest(unittest.TestCase):
    """Review 0edf86e P1-4: a running backend — even one doing only
    ordinary saves — must block restore, and vice versa."""

    def test_running_backend_blocks_restore_and_vice_versa(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main(
                ['--db-path', str(env['store'].db_path),
                 '--backup-dir', str(synced)]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))

            machine = pathlib.Path(tmp) / 'restored'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            # A "backend" opens the target store through the real init
            # path, which now holds the SHARED runtime lock for life.
            backend_env = portfolio_store_ws.create_store_env(
                _config(str(machine))
            )
            portfolio_store_ws.ensure_store_initialized(backend_env)
            self.assertIsNotNone(backend_env['store'])
            self.assertIn('_runtime_lock', backend_env)
            try:
                rc = restore_cli.main([str(main_backup), '--yes',
                                       '--db-path', str(new_db)])
            finally:
                backend_env['_runtime_lock'].release()
            self.assertEqual(rc, 1)  # ordinary-save backend blocks restore

            # And with a restore's EXCLUSIVE lock held, a backend cannot
            # open the store at all.
            blocker = portfolio_maintenance.BackendRuntimeLock(new_db)
            self.assertTrue(blocker.acquire_exclusive())
            try:
                late_env = portfolio_store_ws.create_store_env(
                    _config(str(machine))
                )
                portfolio_store_ws.ensure_store_initialized(late_env)
                self.assertIsNone(late_env['store'])
            finally:
                blocker.release()


class RestoreGuardAndRollbackTest(unittest.TestCase):
    def test_restore_refuses_while_maintenance_lock_is_held(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main(
                ['--db-path', str(env['store'].db_path),
                 '--backup-dir', str(synced)]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))

            machine = pathlib.Path(tmp) / 'restored'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            blocker = portfolio_maintenance.OsMaintenanceLock(new_db)
            self.assertTrue(blocker.acquire())
            try:
                rc = restore_cli.main([str(main_backup), '--yes',
                                       '--db-path', str(new_db)])
            finally:
                blocker.release()
            self.assertEqual(rc, 1)
            self.assertFalse(new_db.exists())

    def test_failed_main_install_rolls_back_the_old_database(self):
        """Review 0edf86e P1-3: a failure while installing the MAIN
        database (not just the shards) must leave the previous set exactly
        where it was — no empty active path, no stranded displaced copy."""
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main(
                ['--db-path', str(env['store'].db_path),
                 '--backup-dir', str(synced)]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))

            machine = pathlib.Path(tmp) / 'restored'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            self.assertEqual(restore_cli.main(
                [str(main_backup), '--yes', '--db-path', str(new_db)]), 0)
            original_db_bytes = new_db.read_bytes()

            original_copyfile = restore_cli.shutil.copyfile

            def failing_copyfile(src, dst, **kwargs):
                destination = pathlib.Path(dst)
                if (destination.parent == new_db.parent
                        and destination.name.startswith(
                            f'.{new_db.name}.restore-'
                        )):
                    destination.write_bytes(b'partial-main')
                    raise OSError('simulated failure installing main db')
                return original_copyfile(src, dst, **kwargs)

            with mock.patch.object(
                restore_cli.shutil, 'copyfile', failing_copyfile,
            ):
                rc = restore_cli.main(
                    [str(main_backup), '--yes', '--db-path', str(new_db)]
                )
            self.assertEqual(rc, 1)
            # The old database is BACK at the active path — not stranded
            # under a pre-restore name with the active path empty.
            self.assertTrue(new_db.exists())
            self.assertEqual(new_db.read_bytes(), original_db_bytes)
            leftovers = [
                p.name for p in machine.iterdir()
                if 'pre-restore' in p.name
            ]
            self.assertEqual(leftovers, [])
            partials = [
                p.name for p in machine.iterdir()
                if p.name.endswith('.partial')
            ]
            self.assertEqual(partials, [])
            PortfolioStore(new_db).initialize().quick_check()

    def test_sqlite_error_before_switch_leaves_old_set_active(self):
        """Review 471c093 P1: sqlite3.Error participates in the same strong
        rollback boundary as copy and rename failures."""
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main([
                '--db-path', str(env['store'].db_path),
                '--backup-dir', str(synced),
            ]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))

            machine = pathlib.Path(tmp) / 'restored'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            self.assertEqual(restore_cli.main([
                str(main_backup), '--yes', '--db-path', str(new_db),
            ]), 0)
            original_bytes = new_db.read_bytes()

            with mock.patch.object(
                restore_cli, '_sanitize_restored_main',
                side_effect=sqlite3.OperationalError(
                    'simulated disk I/O error'
                ),
            ):
                rc = restore_cli.main([
                    str(main_backup), '--yes', '--db-path', str(new_db),
                ])
            self.assertEqual(rc, 1)
            self.assertEqual(new_db.read_bytes(), original_bytes)
            self.assertEqual([
                p.name for p in machine.iterdir()
                if 'pre-restore' in p.name or p.name.endswith('.partial')
            ], [])

    def test_failed_shard_install_rolls_back_the_whole_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main(
                ['--db-path', str(env['store'].db_path),
                 '--backup-dir', str(synced)]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))

            machine = pathlib.Path(tmp) / 'restored'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            # First restore succeeds and becomes the "existing" target set.
            self.assertEqual(restore_cli.main(
                [str(main_backup), '--yes', '--db-path', str(new_db)]), 0)
            original_db_bytes = new_db.read_bytes()
            shard_dest = machine / 'archives' / 'portfolio-archive-2026-001.db'
            original_shard_bytes = shard_dest.read_bytes()

            # Second restore fails at the shard-install copy (an OSError,
            # not a store error): the ENTIRE previous set must come back.
            original_copyfile = restore_cli.shutil.copyfile
            calls = {'n': 0}

            def failing_copyfile(src, dst, **kwargs):
                calls['n'] += 1
                if 'archives' in str(dst):
                    raise OSError('simulated disk failure during install')
                return original_copyfile(src, dst, **kwargs)

            with mock.patch.object(
                restore_cli.shutil, 'copyfile', failing_copyfile,
            ):
                rc = restore_cli.main(
                    [str(main_backup), '--yes', '--db-path', str(new_db)]
                )
            self.assertEqual(rc, 1)
            # Old main database and old shard are back, byte for byte.
            self.assertEqual(new_db.read_bytes(), original_db_bytes)
            self.assertEqual(shard_dest.read_bytes(), original_shard_bytes)
            # No displaced leftovers linger after the rollback.
            leftovers = [
                p.name for p in (machine / 'archives').iterdir()
                if 'pre-restore' in p.name
            ]
            self.assertEqual(leftovers, [])
            PortfolioStore(new_db).initialize().quick_check()
            portfolio_archive.ArchiveShard(shard_dest).quick_check()

    def test_mid_swap_rename_failure_rolls_back_main_and_shard(self):
        """Fail after the new main lands but before its shard lands."""
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main([
                '--db-path', str(env['store'].db_path),
                '--backup-dir', str(synced),
            ]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))

            machine = pathlib.Path(tmp) / 'restored'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            self.assertEqual(restore_cli.main([
                str(main_backup), '--yes', '--db-path', str(new_db),
            ]), 0)
            shard_dest = (
                machine / 'archives' / 'portfolio-archive-2026-001.db'
            )
            original_db_bytes = new_db.read_bytes()
            original_shard_bytes = shard_dest.read_bytes()
            original_replace = restore_cli.os.replace
            injected = {'done': False}

            def failing_replace(src, dst):
                source = pathlib.Path(src)
                destination = pathlib.Path(dst)
                if (not injected['done']
                        and source.name.startswith(
                            '.portfolio-archive-2026-001.db.restore-'
                        )
                        and destination == shard_dest):
                    injected['done'] = True
                    raise OSError('simulated rename failure after main swap')
                return original_replace(src, dst)

            with mock.patch.object(
                restore_cli.os, 'replace', side_effect=failing_replace,
            ):
                rc = restore_cli.main([
                    str(main_backup), '--yes', '--db-path', str(new_db),
                ])
            self.assertEqual(rc, 1)
            self.assertTrue(injected['done'])
            self.assertEqual(new_db.read_bytes(), original_db_bytes)
            self.assertEqual(shard_dest.read_bytes(), original_shard_bytes)
            leftovers = [
                path.name for folder in (machine, machine / 'archives')
                for path in folder.iterdir()
                if ('pre-restore' in path.name
                    or path.name.endswith('.partial'))
            ]
            self.assertEqual(leftovers, [])
            PortfolioStore(new_db).initialize().quick_check()
            portfolio_archive.ArchiveShard(shard_dest).quick_check()

    def test_keyboard_interrupt_mid_swap_rolls_back_before_reraising(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _archived_env(tmp, 'machine')
            synced = pathlib.Path(tmp) / 'synced'
            self.assertEqual(backup_cli.main([
                '--db-path', str(env['store'].db_path),
                '--backup-dir', str(synced),
            ]), 0)
            main_backup = next(synced.glob('portfolio-*.db'))

            machine = pathlib.Path(tmp) / 'restored'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            self.assertEqual(restore_cli.main([
                str(main_backup), '--yes', '--db-path', str(new_db),
            ]), 0)
            shard_dest = (
                machine / 'archives' / 'portfolio-archive-2026-001.db'
            )
            original_db_bytes = new_db.read_bytes()
            original_shard_bytes = shard_dest.read_bytes()
            original_replace = restore_cli.os.replace
            injected = {'done': False}

            def interrupting_replace(src, dst):
                source = pathlib.Path(src)
                destination = pathlib.Path(dst)
                if (not injected['done']
                        and source.name.startswith(
                            '.portfolio-archive-2026-001.db.restore-'
                        )
                        and destination == shard_dest):
                    injected['done'] = True
                    raise KeyboardInterrupt()
                return original_replace(src, dst)

            with mock.patch.object(
                restore_cli.os, 'replace', side_effect=interrupting_replace,
            ):
                with self.assertRaises(KeyboardInterrupt):
                    restore_cli.main([
                        str(main_backup), '--yes', '--db-path', str(new_db),
                    ])
            self.assertTrue(injected['done'])
            self.assertEqual(new_db.read_bytes(), original_db_bytes)
            self.assertEqual(shard_dest.read_bytes(), original_shard_bytes)
            leftovers = [
                path.name for folder in (machine, machine / 'archives')
                for path in folder.iterdir()
                if ('pre-restore' in path.name
                    or path.name.endswith('.partial'))
            ]
            self.assertEqual(leftovers, [])


if __name__ == '__main__':
    unittest.main()
