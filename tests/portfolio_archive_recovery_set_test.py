"""Review 69d509e regressions: the recovery set must bind to one install,
fail closed on any hole, exclude running maintenance, and roll back a
failed install completely.
"""

import pathlib
import sys
import tempfile
import unittest
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


def _archived_env(root, name):
    """A fully archived environment under root/name: one live document and
    one whole-document archive in shard portfolio-archive-2026-001."""
    home = pathlib.Path(root) / name
    home.mkdir()
    env = make_archive_env(str(home))
    run_full_job(env, make_plan(env))
    return env


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

            # Restoring A's main backup must install A's shard — exact
            # name + archive_meta.source_install_id binding.
            main_a = next(synced.glob(f'portfolio-*-{install_a}.db'))
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
            (synced / 'archives'
             / f'portfolio-archive-2026-001-{install_a}.db').unlink()
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


if __name__ == '__main__':
    unittest.main()
