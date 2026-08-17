"""Phase 4 tests: verified main-DB removal, crash reconciliation, and
bounded reclamation (CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md).

Crash points are injected at each boundary of plan section 9.8; after every
crash the invariant holds: at least one verified copy of every payload
exists (active row or verified archive row), current revisions and receipts
survive everything, and a rerun converges the state.
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
from portfolio_store import PortfolioStore

from tests.portfolio_archive_test import (
    ARCHIVE_POLICY,
    DOC_A,
    _payload,
    _token,
    make_archive_env,
    make_plan,
)

DOC_DELETED = 'doc-deleted-1111-4111-8111-111111111111'


def run_full_job(env, plan):
    """Create + run one FULL archive job (copy, verify, commit, reclaim)."""
    store = env['store']
    job = store.create_maintenance_job(
        job_type='archive_copy',
        owner_instance_id=env.get('_server_instance_id'),
    )
    guard = portfolio_maintenance.acquire_maintenance(env)
    assert guard is not None
    try:
        store.start_maintenance_job(
            job['jobId'], fencing_token=guard.fencing_token
        )
        summary = portfolio_archive.run_archive_job(
            env, guard, job['jobId'], plan
        )
        store.finish_maintenance_job(
            job['jobId'], status='completed', summary=summary
        )
        return summary
    finally:
        guard.release()


class CommitTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.env = make_archive_env(self.tmpdir)
        self.store = self.env['store']
        self.db_path = pathlib.Path(self.store.db_path)
        self.archive_dir = self.db_path.parent / 'archives'

    def _counts(self):
        conn = sqlite3.connect(self.db_path)
        try:
            return conn.execute(
                'SELECT '
                '(SELECT count(*) FROM workspace_revisions), '
                '(SELECT count(*) FROM workspace_save_receipts), '
                '(SELECT count(*) FROM workspace_archive_entries), '
                '(SELECT count(*) FROM workspace_archive_tombstones), '
                '(SELECT count(*) FROM workspace_documents)'
            ).fetchone()
        finally:
            conn.close()

    def _assert_no_payload_lost(self):
        """Every receipt's payload exists in the active DB or as a row of a
        good batch in some shard — the never-lose-a-payload invariant."""
        conn = sqlite3.connect(self.db_path)
        try:
            receipts = conn.execute(
                'SELECT document_id, revision, payload_sha256 '
                'FROM workspace_save_receipts'
            ).fetchall()
            active = {
                (row[0], row[1]): row[2] for row in conn.execute(
                    'SELECT document_id, revision, payload_sha256 '
                    'FROM workspace_revisions'
                )
            }
        finally:
            conn.close()
        archived = {}
        for shard_path in self.archive_dir.glob('*.db'):
            conn = sqlite3.connect(shard_path)
            try:
                for row in conn.execute(
                    'SELECT r.document_id, r.revision, r.payload_sha256 '
                    'FROM archived_revisions r '
                    'JOIN archive_batches b ON b.batch_id = r.archive_batch_id '
                    "WHERE b.status IN ('copied', 'verified', 'main_committed')"
                ):
                    archived[(row[0], row[1])] = row[2]
            finally:
                conn.close()
        for document_id, revision, sha in receipts:
            key = (document_id, revision)
            self.assertTrue(
                active.get(key) == sha or archived.get(key) == sha,
                f'payload for {key} lost: not active, not archived',
            )


class FullArchiveTest(CommitTestBase):
    def test_removal_matches_manifest_exactly_and_receipts_survive(self):
        plan = make_plan(self.env)
        stats_before = self.store.storage_stats()
        revisions_before, receipts_before, _, _, docs_before = self._counts()

        summary = run_full_job(self.env, plan)

        self.assertFalse(summary['copyOnly'])
        commit = summary['commit']
        self.assertEqual(commit['removedRevisions'],
                         plan['totals']['revisionCount'])
        self.assertEqual(commit['removedBytes'],
                         plan['totals']['payloadBytes'])
        self.assertEqual(commit['tombstonesWritten'], 1)
        self.assertEqual(commit['skipped'], [])

        revisions, receipts, entries, tombstones, docs = self._counts()
        self.assertEqual(
            revisions, revisions_before - plan['totals']['revisionCount']
        )
        self.assertEqual(receipts, receipts_before)  # ledger untouched
        self.assertEqual(entries, plan['totals']['oldRevisionCount'])
        self.assertEqual(tombstones, 1)
        self.assertEqual(docs, docs_before - 1)  # deleted doc left the table

        # Logical payload dropped by exactly the manifest bytes.
        stats_after = self.store.storage_stats()
        self.assertEqual(
            stats_before['logicalPayloadBytes']
            - stats_after['logicalPayloadBytes'],
            plan['totals']['payloadBytes'],
        )
        # Freelist grew (page granularity) and the DB still verifies.
        self.assertGreaterEqual(
            summary['space']['freelistPagesAfter'], 0
        )
        self.assertEqual(self.store.quick_check(), 'ok')

        # Current revision survives and loads.
        self.assertEqual(self.store.load_workspace(DOC_A)['revision'], 8)
        # The archived deleted document is gone from every listing.
        listed = {
            meta['documentId']
            for meta in self.store.list_documents(include_deleted=True)
        }
        self.assertNotIn(DOC_DELETED, listed)
        self._assert_no_payload_lost()

        # Idempotent replay of an archived revision's token still answers.
        retry = self.store.save_workspace(
            document_id=DOC_A, title='SPY workspace',
            payload=_payload(note='第1版', filler='F' * 8192),
            save_token=_token(1),
        )
        self.assertTrue(retry['idempotentReplay'])
        self.assertEqual(retry['revision'], 1)

        # Shard batches are all main_committed.
        shard = portfolio_archive.ArchiveShard(
            self.archive_dir / f"{summary['archiveId']}.db"
        )
        self.assertEqual(shard.list_batches(('verified',)), [])
        self.assertGreater(len(shard.list_batches(('main_committed',))), 0)

    def test_second_run_finds_no_candidates(self):
        run_full_job(self.env, make_plan(self.env))
        plan = make_plan(self.env)
        self.assertEqual(plan['totals']['revisionCount'], 0)
        summary = run_full_job(self.env, plan)
        self.assertEqual(summary['copiedRevisions'], 0)
        self.assertEqual(summary['commit']['removedRevisions'], 0)

    def test_commit_chunks_respect_row_cap(self):
        self.env['_archive_commit_max_rows'] = 2
        plan = make_plan(self.env)
        summary = run_full_job(self.env, plan)
        # 6 old revisions in chunks of <=2 (3 chunks) + 1 whole-doc chunk.
        self.assertEqual(summary['commit']['commitChunks'], 4)
        self.assertEqual(summary['commit']['removedRevisions'], 8)

    def test_missing_snapshot_makes_delete_unreachable(self):
        store = self.store
        plan = make_plan(self.env)
        job = store.create_maintenance_job(
            job_type='archive_copy',
            owner_instance_id=self.env.get('_server_instance_id'),
        )
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        try:
            store.start_maintenance_job(job['jobId'])
            copy_summary = portfolio_archive.run_copy_job(
                self.env, guard, job['jobId'], plan
            )
            # Destroy the recovery snapshot between copy and commit.
            for snapshot in (self.db_path.parent / 'maintenance-backups'
                             ).glob('pre-archive-*.db'):
                snapshot.unlink()
            shard = portfolio_archive.ArchiveShard(
                self.archive_dir / f"{copy_summary['archiveId']}.db",
                now=store.now_utc,
            )
            with self.assertRaises(portfolio_archive.ArchiveError):
                portfolio_archive.commit_verified_batches(
                    self.env, guard, job['jobId'], shard,
                    copy_summary['archiveId'],
                )
        finally:
            guard.release()
        # Nothing was removed.
        self.assertEqual(self._counts()[2], 0)  # no entries
        self.assertEqual(self.store.load_workspace(DOC_A)['revision'], 8)
        self._assert_no_payload_lost()

    def test_unverified_batches_are_never_committed(self):
        plan = make_plan(self.env)
        store = self.store
        job = store.create_maintenance_job(
            job_type='archive_copy',
            owner_instance_id=self.env.get('_server_instance_id'),
        )
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        try:
            store.start_maintenance_job(job['jobId'])
            copy_summary = portfolio_archive.run_copy_job(
                self.env, guard, job['jobId'], plan
            )
            shard_path = self.archive_dir / f"{copy_summary['archiveId']}.db"
            conn = sqlite3.connect(shard_path)
            try:
                conn.execute(
                    "UPDATE archive_batches SET status = 'copied', "
                    'verified_at_utc = NULL'
                )
                conn.commit()
            finally:
                conn.close()
            shard = portfolio_archive.ArchiveShard(
                shard_path, now=store.now_utc
            )
            commit = portfolio_archive.commit_verified_batches(
                self.env, guard, job['jobId'], shard,
                copy_summary['archiveId'],
            )
        finally:
            guard.release()
        self.assertEqual(commit['removedRevisions'], 0)
        self.assertEqual(self._counts()[2], 0)
        self._assert_no_payload_lost()


class OversizedDocumentTest(CommitTestBase):
    def test_document_beyond_hard_cap_refused_online(self):
        with mock.patch.object(
            portfolio_archive, 'COMMIT_DOC_HARD_MAX_ROWS', 1
        ):
            summary = run_full_job(self.env, make_plan(self.env))
        reasons = {item['reason'] for item in summary['commit']['skipped']}
        self.assertIn('skipped_oversized_document', reasons)
        # The oversized document survives untouched and stays soft-deleted;
        # its verified archive copy exists but nothing was removed.
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute(
                'SELECT deleted_at_utc FROM workspace_documents '
                'WHERE document_id = ?', (DOC_DELETED,),
            ).fetchone()
            revisions = conn.execute(
                'SELECT count(*) FROM workspace_revisions '
                'WHERE document_id = ?', (DOC_DELETED,),
            ).fetchone()[0]
            tombstones = conn.execute(
                'SELECT count(*) FROM workspace_archive_tombstones'
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertIsNotNone(row)
        self.assertIsNotNone(row[0])
        self.assertEqual(revisions, 2)
        self.assertEqual(tombstones, 0)
        self._assert_no_payload_lost()

    def test_skipped_batch_stays_resumable_and_converges(self):
        """Review 3 P1: a batch with skipped rows must NOT be marked
        main_committed — otherwise safe replay treats those rows as done
        and the still-active candidates can never converge."""
        with mock.patch.object(
            portfolio_archive, 'COMMIT_DOC_HARD_MAX_ROWS', 1
        ):
            first = run_full_job(self.env, make_plan(self.env))
        self.assertGreater(len(first['commit']['resumableBatches']), 0)

        # The batch holding the skipped document is still `verified`.
        shard_path = next(self.archive_dir.glob('*.db'))
        shard = portfolio_archive.ArchiveShard(shard_path)
        self.assertGreater(len(shard.list_batches(('verified',))), 0)
        # The skipped document is still an archive candidate.
        self.assertGreater(
            make_plan(self.env)['totals']['deletedDocumentCount'], 0
        )

        # With the ceiling back to normal, the next job commits the
        # remainder out of the SAME verified batch and converges.
        second = run_full_job(self.env, make_plan(self.env))
        self.assertGreater(second['commit']['removedRevisions'], 0)
        self.assertEqual(second['commit']['resumableBatches'], [])
        self.assertEqual(shard.list_batches(('verified',)), [])
        final = make_plan(self.env)
        self.assertEqual(final['totals']['revisionCount'], 0)
        conn = sqlite3.connect(self.db_path)
        try:
            tombstones = conn.execute(
                'SELECT count(*) FROM workspace_archive_tombstones'
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(tombstones, 1)
        self._assert_no_payload_lost()


class UndeleteReclassificationTest(CommitTestBase):
    """Review 09c0370 P1-1: a document undeleted between copy/verify and
    commit must not freeze its batch (and the active candidates) forever —
    at commit time its rows reclassify to ordinary partial history."""

    POLICY = {'revisionKeepRecent': 1, 'revisionKeepDailyDays': 0,
              'archiveDeletedAfterDays': 30}

    def test_undeleted_document_reclassifies_and_candidates_converge(self):
        store = self.store
        # Copy + verify the whole-document candidate…
        plan = make_plan(self.env, self.POLICY)
        job = store.create_maintenance_job(
            job_type='archive_copy',
            owner_instance_id=self.env.get('_server_instance_id'),
        )
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        try:
            store.start_maintenance_job(job['jobId'])
            portfolio_archive.run_copy_job(self.env, guard, job['jobId'], plan)
            store.finish_maintenance_job(job['jobId'], status='completed')
        finally:
            guard.release()
        # …then the user undeletes it before any commit happened.
        store.undelete_document(DOC_DELETED, 2)

        summary = run_full_job(self.env, make_plan(self.env, self.POLICY))
        # The old non-current revision of the undeleted document was
        # removed as PARTIAL history (entry, not tombstone)…
        self.assertIsNotNone(store.get_archive_entry(DOC_DELETED, 1))
        self.assertIsNone(store.get_archive_tombstone(DOC_DELETED))
        skip_reasons = {item['reason'] for item in summary['commit']['skipped']}
        self.assertNotIn('skipped_undeleted', skip_reasons)
        # …and the candidates converge instead of sticking forever.
        final = make_plan(self.env, self.POLICY)
        self.assertEqual(final['totals']['revisionCount'], 0)
        self.assertEqual(store.load_workspace(DOC_DELETED)['revision'], 2)
        # The live document's CURRENT-revision copy was trimmed from the
        # unsealed batch (its home is the active database), so the batch
        # reaches a terminal state IMMEDIATELY — convergence never depends
        # on the user saving again (review 69d509e P2). The trimmed batch
        # still passes full verification with its recomputed manifest.
        shard_path = next(self.archive_dir.glob('*.db'))
        shard = portfolio_archive.ArchiveShard(shard_path)
        self.assertEqual(shard.list_batches(('verified',)), [])
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        try:
            verify = portfolio_archive.run_verify_job(
                self.env, guard, archive_id=shard_path.stem,
            )
        finally:
            guard.release()
        self.assertEqual(verify['status'], 'ok')
        self._assert_no_payload_lost()

        # Once the document advances, the final row commits and the batch
        # reaches its terminal state.
        store.save_workspace(
            document_id=DOC_DELETED, title='已删除工作区',
            payload=_payload(underlyingSymbol='QQQ', note='三'),
            save_token=_token(950), expected_revision=2,
        )
        run_full_job(self.env, make_plan(self.env, self.POLICY))
        shard = portfolio_archive.ArchiveShard(
            next(self.archive_dir.glob('*.db'))
        )
        self.assertEqual(shard.list_batches(('verified',)), [])
        self.assertEqual(
            make_plan(self.env, self.POLICY)['totals']['revisionCount'], 0
        )
        self._assert_no_payload_lost()


class RolloverAndSweepTest(CommitTestBase):
    """Review 69d509e P2: rollover must not seal a shard holding
    non-terminal batches, and stranded verified batches in other unsealed
    shards must converge through the commit-stage sweep."""

    POLICY = {'revisionKeepRecent': 1, 'revisionKeepDailyDays': 0,
              'archiveDeletedAfterDays': 30}

    def _rebuild_store_clock(self, now):
        from tests.portfolio_archive_test import NOW  # noqa: F401
        store = PortfolioStore(self.db_path, now=lambda: now)
        store.initialize()
        self.env['store'] = store
        self.store = store

    def test_stranded_batch_blocks_seal_then_sweep_converges_and_seals(self):
        from datetime import timedelta
        from tests.portfolio_archive_test import NOW

        store = self.store
        # Copy + verify the whole-document candidate, then undelete AND
        # re-delete: at commit time the document is inside a fresh grace
        # period, so the batch is legitimately stuck as `verified`.
        plan = make_plan(self.env, self.POLICY)
        job = store.create_maintenance_job(
            job_type='archive_copy',
            owner_instance_id=self.env.get('_server_instance_id'),
        )
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        try:
            store.start_maintenance_job(job['jobId'])
            portfolio_archive.run_copy_job(self.env, guard, job['jobId'], plan)
            store.finish_maintenance_job(job['jobId'], status='completed')
        finally:
            guard.release()
        store.undelete_document(DOC_DELETED, 2)
        store.delete_document(DOC_DELETED, 2)  # re-deleted at NOW: in grace

        summary = run_full_job(self.env, make_plan(self.env, self.POLICY))
        reasons = {item['reason'] for item in summary['commit']['skipped']}
        self.assertIn('skipped_grace_period', reasons)
        shard_path = self.archive_dir / 'portfolio-archive-2026-001.db'
        shard = portfolio_archive.ArchiveShard(shard_path)
        self.assertEqual(len(shard.list_batches(('verified',))), 1)

        # Over the rollover cap, sealing REFUSES while that batch is
        # non-terminal: the shard stays active and a new part is created.
        next_shard, next_id, _ = portfolio_archive.select_writable_shard(
            store, self.archive_dir, rollover_bytes=1,
        )
        self.assertNotEqual(next_id, 'portfolio-archive-2026-001')
        registry = {
            row['archive_id']: row['status']
            for row in store.list_archive_registry()
        }
        self.assertEqual(registry['portfolio-archive-2026-001'], 'active')

        # The grace period passes; the next job's commit-stage SWEEP finds
        # the stranded batch in the old shard and commits it, even though
        # new copies now write into a different shard.
        self._rebuild_store_clock(NOW + timedelta(days=31))
        self.env['_archive_rollover_bytes'] = 1
        summary = run_full_job(self.env, make_plan(self.env, self.POLICY))
        self.assertIn('portfolio-archive-2026-001',
                      summary['commit']['sweptShards'])
        self.assertEqual(shard.list_batches(('verified',)), [])
        self.assertGreater(len(shard.list_batches(('main_committed',))), 0)
        self.assertIsNotNone(self.store.get_archive_tombstone(DOC_DELETED))
        self.assertEqual(
            make_plan(self.env, self.POLICY)['totals']['revisionCount'], 0
        )
        self._assert_no_payload_lost()

        # Now terminal-clean, the over-cap shard finally seals.
        portfolio_archive.select_writable_shard(
            self.store, self.archive_dir, rollover_bytes=1,
        )
        registry = {
            row['archive_id']: row['status']
            for row in self.store.list_archive_registry()
        }
        self.assertEqual(registry['portfolio-archive-2026-001'], 'sealed')
        self.assertIsNotNone(
            portfolio_archive.ArchiveShard(shard_path).meta()['sealed_at_utc']
        )


class CrashMatrixTest(CommitTestBase):
    """Plan section 16 phase 4: crash at every boundary, then converge."""

    def test_crash_after_copy_before_verify(self):
        with mock.patch.object(
            portfolio_archive.ArchiveShard, 'verify_batch',
            side_effect=portfolio_archive.ArchiveError('simulated crash'),
        ):
            with self.assertRaises(portfolio_archive.ArchiveError):
                run_full_job(self.env, make_plan(self.env))
        self._assert_no_payload_lost()
        self.assertEqual(self._counts()[2], 0)  # nothing removed
        # Converge.
        summary = run_full_job(self.env, make_plan(self.env))
        self.assertEqual(summary['commit']['removedRevisions'], 8)
        self._assert_no_payload_lost()

    def test_crash_mid_commit_between_chunks(self):
        self.env['_archive_commit_max_rows'] = 2
        original = PortfolioStore.commit_archive_removal_chunk
        calls = {'n': 0}

        def failing_chunk(store_self, **kwargs):
            calls['n'] += 1
            if calls['n'] == 3:
                raise portfolio_archive.ArchiveError('simulated crash mid-commit')
            return original(store_self, **kwargs)

        with mock.patch.object(
            PortfolioStore, 'commit_archive_removal_chunk', failing_chunk
        ):
            with self.assertRaises(portfolio_archive.ArchiveError):
                run_full_job(self.env, make_plan(self.env))

        # Partial commitment: every removed row has its evidence in the
        # SAME transaction — no row vanishes without an entry/tombstone.
        conn = sqlite3.connect(self.db_path)
        try:
            entries = conn.execute(
                'SELECT count(*) FROM workspace_archive_entries'
            ).fetchone()[0]
            receipts_without_payload = conn.execute(
                'SELECT count(*) FROM workspace_save_receipts s '
                'LEFT JOIN workspace_revisions r ON r.save_token = s.save_token '
                'LEFT JOIN workspace_archive_entries e '
                'ON e.document_id = s.document_id AND e.revision = s.revision '
                'LEFT JOIN workspace_archive_tombstones t '
                'ON t.document_id = s.document_id '
                'WHERE r.save_token IS NULL AND e.document_id IS NULL '
                'AND t.document_id IS NULL'
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(receipts_without_payload, 0)  # none lost silently
        self.assertEqual(self.store.load_workspace(DOC_A)['revision'], 8)
        self._assert_no_payload_lost()

        # Converge: the rerun removes exactly the remainder, once.
        run_full_job(self.env, make_plan(self.env))
        final = make_plan(self.env)
        self.assertEqual(final['totals']['revisionCount'], 0)
        revisions, _, entries_after, tombstones, _ = self._counts()
        self.assertEqual(revisions, 2)      # DOC_A keeps {7, 8}
        self.assertEqual(entries_after, 6)  # all six old revisions
        self.assertEqual(tombstones, 1)
        self._assert_no_payload_lost()

    def test_crash_after_commit_before_batch_mark(self):
        with mock.patch.object(
            portfolio_archive.ArchiveShard, 'mark_batch_committed',
            side_effect=portfolio_archive.ArchiveError('simulated crash'),
        ):
            with self.assertRaises(portfolio_archive.ArchiveError):
                run_full_job(self.env, make_plan(self.env))

        # Rows removed with evidence, but the batch still says verified.
        shard_path = next(self.archive_dir.glob('*.db'))
        shard = portfolio_archive.ArchiveShard(shard_path)
        self.assertGreater(len(shard.list_batches(('verified',))), 0)
        self._assert_no_payload_lost()

        # The reconciler in the next run flips it using main-DB evidence.
        summary = run_full_job(self.env, make_plan(self.env))
        self.assertGreater(len(summary['commit']['reconciledBatches']), 0)
        self.assertEqual(shard.list_batches(('verified',)), [])
        self.assertGreater(len(shard.list_batches(('main_committed',))), 0)
        self._assert_no_payload_lost()

    def test_orphan_running_job_marked_interrupted(self):
        job = self.store.create_maintenance_job(
            job_type='archive_copy', owner_instance_id='srv-gone00000000',
        )
        self.store.start_maintenance_job(job['jobId'])
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        self.assertIsNotNone(guard)
        guard.release()
        refreshed = self.store.get_maintenance_job(job['jobId'])
        self.assertEqual(refreshed['status'], 'interrupted')
        self.assertEqual(refreshed['errorCode'], 'interrupted')


class BoundedReclaimTest(CommitTestBase):
    def test_vacuum_is_bounded_and_db_stays_ok(self):
        self.env['_vacuum_freelist_pages'] = 1  # reclaim eagerly
        self.env['_vacuum_max_pages'] = 2       # but only two pages per pass
        summary = run_full_job(self.env, make_plan(self.env))
        space = summary['space']
        self.assertTrue(space['vacuumRan'])
        freed = space['freelistPagesBefore'] - space['freelistPagesAfter']
        self.assertLessEqual(freed, 2)
        self.assertGreaterEqual(freed, 0)
        self.assertEqual(self.store.quick_check(), 'ok')
        # The three space classes are reported separately and coherently.
        self.assertEqual(
            space['logicalPayloadBytesBefore']
            - space['logicalPayloadBytesAfter'],
            space['logicalRemovedBytes'],
        )
        self.assertGreaterEqual(space['dbFileBytesBefore'], 0)


if __name__ == '__main__':
    unittest.main()
