"""Phase 3 fault-injection matrix for the copy-only archive executor.

Every scenario asserts the same invariant afterwards: the active database's
workspace tables are structurally IDENTICAL to before the fault — the
copy-only phase must never modify them, no matter how the archive side
fails. Faults covered: disk full, read-only archive directory, write
interruption mid-copy, and a corrupted shard file.
"""

import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_archive
import portfolio_maintenance

from tests.portfolio_archive_test import (
    active_tables_digest,
    make_archive_env,
    make_plan,
    run_job,
)


class FaultInjectionTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.env = make_archive_env(self.tmpdir)
        self.store = self.env['store']
        self.db_path = pathlib.Path(self.store.db_path)
        self.archive_dir = self.db_path.parent / 'archives'
        self.before = active_tables_digest(self.db_path)

    def _assert_active_untouched(self):
        self.assertEqual(active_tables_digest(self.db_path), self.before)
        self.store.quick_check()


class DiskFullTest(FaultInjectionTestBase):
    def test_insufficient_space_refuses_before_any_write(self):
        fake_usage = mock.Mock(return_value=mock.Mock(free=1024))
        with mock.patch.object(portfolio_archive, '_disk_usage', fake_usage):
            with self.assertRaises(
                portfolio_archive.InsufficientDiskSpaceError
            ):
                run_job(self.env, make_plan(self.env))
        self._assert_active_untouched()
        # Refused before the snapshot and before any shard was created.
        self.assertEqual(list(self.archive_dir.glob('*.db')), [])
        self.assertEqual(
            list((self.db_path.parent / 'maintenance-backups').glob('*.db')),
            [],
        )


class ReadOnlyArchiveDirTest(FaultInjectionTestBase):
    def test_unwritable_archive_dir_fails_closed(self):
        self.archive_dir.mkdir()
        os.chmod(self.archive_dir, 0o555)
        self.addCleanup(os.chmod, self.archive_dir, 0o755)
        with self.assertRaises(portfolio_archive.ArchiveError):
            run_job(self.env, make_plan(self.env))
        self._assert_active_untouched()
        self.assertEqual(list(self.archive_dir.glob('*.db')), [])


class WriteInterruptionTest(FaultInjectionTestBase):
    def test_interrupted_copy_leaves_no_partial_batch_and_retries_clean(self):
        self.env['_archive_max_rows_per_batch'] = 3  # several batches
        original = portfolio_archive.ArchiveShard.copy_batch
        calls = {'n': 0}

        def failing_copy(shard_self, **kwargs):
            calls['n'] += 1
            if calls['n'] == 2:
                raise portfolio_archive.ArchiveError(
                    'simulated write interruption'
                )
            return original(shard_self, **kwargs)

        with mock.patch.object(
            portfolio_archive.ArchiveShard, 'copy_batch', failing_copy
        ):
            with self.assertRaises(portfolio_archive.ArchiveError):
                run_job(self.env, make_plan(self.env))
        self._assert_active_untouched()

        # Batch 1 committed and verified; batch 2 rolled back completely —
        # no partial rows, no 'copying' stub.
        shard_path = next(self.archive_dir.glob('*.db'))
        conn = sqlite3.connect(shard_path)
        try:
            statuses = [row[0] for row in conn.execute(
                'SELECT status FROM archive_batches ORDER BY created_at_utc'
            )]
            self.assertEqual(statuses, ['verified'])
            orphans = conn.execute(
                'SELECT count(*) FROM archived_revisions r '
                'LEFT JOIN archive_batches b ON b.batch_id = r.archive_batch_id '
                'WHERE b.batch_id IS NULL'
            ).fetchone()[0]
            self.assertEqual(orphans, 0)
        finally:
            conn.close()

        # A clean retry completes the copy without duplicating batch 1.
        summary = run_job(self.env, make_plan(self.env))
        self._assert_active_untouched()
        conn = sqlite3.connect(shard_path)
        try:
            archived = conn.execute(
                'SELECT count(*) FROM archived_revisions'
            ).fetchone()[0]
            duplicates = conn.execute(
                'SELECT count(*) FROM (SELECT document_id, revision, count(*) c '
                'FROM archived_revisions GROUP BY 1, 2 HAVING c > 1)'
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(archived, 8)
        self.assertEqual(duplicates, 0)
        self.assertEqual(summary['archiveId'], shard_path.stem)


class CorruptShardTest(FaultInjectionTestBase):
    def test_corrupted_shard_fails_closed_and_active_survives(self):
        run_job(self.env, make_plan(self.env))
        shard_path = next(self.archive_dir.glob('*.db'))
        with open(shard_path, 'r+b') as handle:
            handle.seek(4096)
            handle.write(os.urandom(4096))
        pathlib.Path(str(shard_path) + '-wal').unlink(missing_ok=True)
        pathlib.Path(str(shard_path) + '-shm').unlink(missing_ok=True)

        before = active_tables_digest(self.db_path)
        with self.assertRaises(portfolio_archive.PortfolioStoreError):
            run_job(self.env, make_plan(self.env))
        self.assertEqual(active_tables_digest(self.db_path), before)
        self.store.quick_check()


class LeaseLossTest(FaultInjectionTestBase):
    def test_lost_lease_stops_copy_between_batches(self):
        self.env['_archive_max_rows_per_batch'] = 3
        plan = make_plan(self.env)
        store = self.store
        job = store.create_maintenance_job(job_type='archive_copy')
        store.start_maintenance_job(job['jobId'])
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        self.assertIsNotNone(guard)
        try:
            # Simulate a takeover: another instance fences us out mid-run.
            original_verify = guard.verify
            calls = {'n': 0}

            def failing_verify():
                calls['n'] += 1
                if calls['n'] >= 2:
                    return False
                return original_verify()

            guard.verify = failing_verify
            with self.assertRaises(
                portfolio_archive.MaintenanceLeaseLostError
            ):
                portfolio_archive.run_copy_job(
                    self.env, guard, job['jobId'], plan
                )
        finally:
            guard.release()
        self._assert_active_untouched()


if __name__ == '__main__':
    unittest.main()
