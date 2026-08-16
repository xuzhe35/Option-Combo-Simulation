"""Phase 0 tests for portfolio_archive.py — frozen candidate rules and
storage-metric vocabulary (CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md).

Pure stdlib, temp directories only. The parity test drives the SAME fixture
through the pure candidate rule and through PortfolioStore.prune_revisions to
prove the rule matches today's retention behavior exactly.
"""

import configparser
import hashlib
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from portfolio_archive import (
    DEFAULT_ARCHIVE_AUTO_RUN,
    DEFAULT_ARCHIVE_COMMIT_MAX_PAYLOAD_BYTES,
    DEFAULT_ARCHIVE_COMMIT_MAX_ROWS,
    DEFAULT_ARCHIVE_DELETED_AFTER_DAYS,
    DEFAULT_ARCHIVE_ENABLED,
    DEFAULT_ARCHIVE_MAX_PAYLOAD_BYTES_PER_BATCH,
    PAYLOAD_BYTES_SQL,
    STORAGE_METRIC_FORMULAS,
    assemble_storage_metrics,
    compute_deleted_document_candidates,
    compute_revision_candidates,
)
from portfolio_store import PortfolioStore, canonicalize_payload

NOW = datetime(2026, 8, 8, 12, 0, 0, tzinfo=timezone.utc)
DOC_A = 'doc-aaaaaaaa-1111-4111-8111-111111111111'


def _token(n):
    return f'save-{n:08d}-4000-8000-000000000000'


def _payload(**overrides):
    payload = {
        'sessionSchemaVersion': 1,
        'underlyingSymbol': 'SPY',
        'marketDataMode': 'live',
        'baseDate': '2026-08-03',
        'groups': [{'id': 'g1', 'name': '组合一', 'legs': [{'id': 'l1', 'pos': -2}]}],
        'hedges': [],
    }
    payload.update(overrides)
    return payload


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace(
        '+00:00', 'Z'
    )


def _revision_rows(*specs):
    """specs: (revision, saved_at_datetime) pairs."""
    return [
        {'revision': revision, 'savedAtUtc': _iso(saved_at)}
        for revision, saved_at in specs
    ]


class FakeClock:
    def __init__(self, start):
        self.current = start

    def __call__(self):
        return self.current

    def advance(self, **kwargs):
        self.current = self.current + timedelta(**kwargs)


class RevisionCandidateRuleTest(unittest.TestCase):
    def test_deterministic_and_order_independent(self):
        rows = _revision_rows(
            *((n, NOW - timedelta(days=10, hours=n)) for n in range(1, 8))
        )
        kwargs = dict(current_revision=7, keep_recent=2, keep_daily_days=0, now=NOW)
        first = compute_revision_candidates(rows, **kwargs)
        second = compute_revision_candidates(list(reversed(rows)), **kwargs)
        self.assertEqual(first, second)
        self.assertEqual(
            [row['revision'] for row in first['candidates']], [5, 4, 3, 2, 1]
        )
        self.assertEqual(
            {row['revision']: row['reason'] for row in first['kept']},
            {7: 'current', 6: 'recent'},
        )

    def test_current_revision_is_never_a_candidate(self):
        # Adversarial: current is the OLDEST revision, far outside both the
        # recent window and the daily window.
        rows = _revision_rows(
            (1, NOW - timedelta(days=400)),
            (2, NOW - timedelta(days=2)),
            (3, NOW - timedelta(days=1)),
            (4, NOW),
        )
        result = compute_revision_candidates(
            rows, current_revision=1, keep_recent=1, keep_daily_days=0, now=NOW
        )
        candidate_revisions = {row['revision'] for row in result['candidates']}
        self.assertNotIn(1, candidate_revisions)
        reasons = {row['revision']: row['reason'] for row in result['kept']}
        self.assertEqual(reasons[1], 'current')

    def test_daily_anchor_keeps_last_save_per_day_inside_window(self):
        day1 = NOW - timedelta(days=1)
        day2 = NOW - timedelta(days=2)
        day9 = NOW - timedelta(days=9)
        rows = _revision_rows(
            (1, day9), (2, day9 + timedelta(hours=1)),          # outside window
            (3, day2), (4, day2 + timedelta(hours=2)),          # inside window
            (5, day1), (6, day1 + timedelta(hours=3)),          # inside window
            (7, NOW),
        )
        result = compute_revision_candidates(
            rows, current_revision=7, keep_recent=1, keep_daily_days=7, now=NOW
        )
        reasons = {row['revision']: row['reason'] for row in result['kept']}
        self.assertEqual(reasons[7], 'current')
        self.assertEqual(reasons[6], 'daily_anchor')
        self.assertEqual(reasons[4], 'daily_anchor')
        self.assertEqual(
            [row['revision'] for row in result['candidates']], [5, 3, 2, 1]
        )

    def test_extra_manifest_fields_pass_through(self):
        rows = [
            {'revision': 1, 'savedAtUtc': _iso(NOW - timedelta(days=30)),
             'payloadSha256': 'abc', 'payloadBytes': 123},
            {'revision': 2, 'savedAtUtc': _iso(NOW)},
        ]
        result = compute_revision_candidates(
            rows, current_revision=2, keep_recent=1, keep_daily_days=0, now=NOW
        )
        self.assertEqual(result['candidates'][0]['payloadSha256'], 'abc')
        self.assertEqual(result['candidates'][0]['payloadBytes'], 123)

    def test_missing_current_revision_is_corruption(self):
        rows = _revision_rows((1, NOW))
        with self.assertRaises(ValueError):
            compute_revision_candidates(
                rows, current_revision=2, keep_recent=1, keep_daily_days=0, now=NOW
            )

    def test_duplicate_revisions_rejected(self):
        rows = _revision_rows((1, NOW), (1, NOW))
        with self.assertRaises(ValueError):
            compute_revision_candidates(
                rows, current_revision=1, keep_recent=1, keep_daily_days=0, now=NOW
            )


class DeletedDocumentCandidateRuleTest(unittest.TestCase):
    def _docs(self, deleted_at):
        return [{'documentId': DOC_A, 'deletedAtUtc': deleted_at}]

    def test_inside_grace_period_is_kept(self):
        deleted_at = _iso(NOW - timedelta(days=29, hours=23))
        result = compute_deleted_document_candidates(
            self._docs(deleted_at), archive_deleted_after_days=30, now=NOW
        )
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['kept'][0]['reason'], 'grace_period')

    def test_exact_boundary_is_still_kept(self):
        deleted_at = _iso(NOW - timedelta(days=30))
        result = compute_deleted_document_candidates(
            self._docs(deleted_at), archive_deleted_after_days=30, now=NOW
        )
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['kept'][0]['reason'], 'grace_period')

    def test_beyond_grace_period_is_candidate(self):
        deleted_at = _iso(NOW - timedelta(days=30, milliseconds=1))
        result = compute_deleted_document_candidates(
            self._docs(deleted_at), archive_deleted_after_days=30, now=NOW
        )
        self.assertEqual(result['candidates'][0]['reason'], 'grace_elapsed')
        self.assertEqual(result['kept'], [])

    def test_live_document_with_expired_option_payload_is_never_a_candidate(self):
        # Business expiry is display data only; lifecycle rules must not read
        # it. A live document carrying a long-expired option stays kept.
        docs = [{
            'documentId': DOC_A,
            'deletedAtUtc': None,
            'symbol': 'QQQ',
            'earliestOptionExpiry': '2020-01-17',
        }]
        result = compute_deleted_document_candidates(
            docs, archive_deleted_after_days=0, now=NOW
        )
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['kept'][0]['reason'], 'not_deleted')

    def test_defaults_are_view_only_and_manual(self):
        self.assertTrue(DEFAULT_ARCHIVE_ENABLED)
        self.assertFalse(DEFAULT_ARCHIVE_AUTO_RUN)
        self.assertEqual(DEFAULT_ARCHIVE_DELETED_AFTER_DAYS, 30)
        # Commit chunks must be strictly smaller than copy batches.
        self.assertLess(
            DEFAULT_ARCHIVE_COMMIT_MAX_PAYLOAD_BYTES,
            DEFAULT_ARCHIVE_MAX_PAYLOAD_BYTES_PER_BATCH,
        )
        self.assertLessEqual(DEFAULT_ARCHIVE_COMMIT_MAX_ROWS, 25)


class PruneParityTest(unittest.TestCase):
    """The pure rule and PortfolioStore.prune_revisions must agree exactly."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'portfolio.db'
        self.clock = FakeClock(NOW - timedelta(days=9))
        self.store = PortfolioStore(self.db_path, now=self.clock).initialize()

    def test_candidates_equal_actual_prune_deletions(self):
        revision = None
        token = 0
        # Three saves per day across nine days: cross-day fixture with
        # multiple saves per UTC day, ASCII and Chinese payloads mixed.
        for day in range(9):
            for hour in (9, 13, 17):
                token += 1
                result = self.store.save_workspace(
                    document_id=DOC_A,
                    title='SPY workspace',
                    payload=_payload(baseDate=f'2026-07-{day + 1:02d}',
                                     note=f'第{day}天-{hour}点'),
                    save_token=_token(token),
                    expected_revision=revision,
                )
                revision = result['revision']
                self.clock.advance(hours=4)
            self.clock.advance(hours=12)
        self.clock.current = NOW

        conn = sqlite3.connect(self.db_path)
        try:
            rows = [
                {'revision': r, 'savedAtUtc': s}
                for r, s in conn.execute(
                    'SELECT revision, saved_at_utc FROM workspace_revisions '
                    'WHERE document_id = ?', (DOC_A,)
                )
            ]
            current = conn.execute(
                'SELECT current_revision FROM workspace_documents '
                'WHERE document_id = ?', (DOC_A,)
            ).fetchone()[0]
        finally:
            conn.close()

        keep_recent, keep_daily_days = 5, 4
        predicted = compute_revision_candidates(
            rows, current_revision=current, keep_recent=keep_recent,
            keep_daily_days=keep_daily_days, now=NOW,
        )
        predicted_deleted = {row['revision'] for row in predicted['candidates']}
        self.assertGreater(len(predicted_deleted), 0)

        deleted_count = self.store.prune_revisions(
            keep_recent=keep_recent, keep_daily_days=keep_daily_days
        )
        self.assertEqual(deleted_count, len(predicted_deleted))

        conn = sqlite3.connect(self.db_path)
        try:
            remaining = {
                r for (r,) in conn.execute(
                    'SELECT revision FROM workspace_revisions '
                    'WHERE document_id = ?', (DOC_A,)
                )
            }
        finally:
            conn.close()
        self.assertEqual(remaining, {row['revision'] for row in predicted['kept']})
        self.assertEqual(remaining & predicted_deleted, set())
        self.assertIn(current, remaining)


class StorageMetricVocabularyTest(unittest.TestCase):
    def test_metric_names_are_frozen(self):
        self.assertEqual(
            set(STORAGE_METRIC_FORMULAS),
            {'logicalPayloadBytes', 'allocatedDbBytes', 'reclaimableBytes',
             'walBytes', 'shmBytes', 'dbFileBytes'},
        )

    def test_assembly_formulas(self):
        metrics = assemble_storage_metrics(
            page_count=100, page_size=4096, freelist_count=7,
            logical_payload_bytes=12345, db_file_bytes=409600,
            wal_bytes=8192, shm_bytes=32768,
        )
        self.assertEqual(metrics['allocatedDbBytes'], 409600)
        self.assertEqual(metrics['reclaimableBytes'], 28672)
        self.assertEqual(metrics['logicalPayloadBytes'], 12345)

    def test_missing_inputs_stay_none_not_zero(self):
        metrics = assemble_storage_metrics(
            page_count=None, page_size=4096, freelist_count=None,
            logical_payload_bytes=None, db_file_bytes=None,
        )
        self.assertIsNone(metrics['allocatedDbBytes'])
        self.assertIsNone(metrics['reclaimableBytes'])
        self.assertIsNone(metrics['logicalPayloadBytes'])
        self.assertIsNone(metrics['dbFileBytes'])
        self.assertEqual(metrics['walBytes'], 0)

    def test_chinese_payload_bytes_use_utf8_not_character_count(self):
        payload = _payload(note='中文字节数必须按UTF-8统计')
        encoded = canonicalize_payload(payload)

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = pathlib.Path(tmp.name) / 'portfolio.db'
        store = PortfolioStore(db_path).initialize()
        store.save_workspace(
            document_id=DOC_A, title='中文', payload=payload,
            save_token=_token(1),
        )
        conn = sqlite3.connect(db_path)
        try:
            byte_len, char_len = conn.execute(
                f'SELECT {PAYLOAD_BYTES_SQL}, length(payload_json) '
                'FROM workspace_revisions WHERE document_id = ?', (DOC_A,)
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(byte_len, len(encoded))
        # The v1 formula (character count) demonstrably under-reports.
        self.assertLess(char_len, byte_len)


class BatchSplitTest(unittest.TestCase):
    def _manifest(self, old=(), deleted=()):
        return {'oldRevisions': list(old), 'deletedDocuments': list(deleted)}

    def _row(self, doc, revision, size=10):
        return {'documentId': doc, 'revision': revision,
                'savedAtUtc': _iso(NOW), 'payloadBytes': size,
                'payloadSha256': 'x' * 64}

    def test_old_revisions_pack_to_caps(self):
        rows = [self._row('doc-a', n) for n in range(1, 8)]
        batches = portfolio_archive.split_into_batches(
            self._manifest(old=rows), max_rows=3, max_payload_bytes=10_000,
        )
        self.assertEqual([len(b['rows']) for b in batches], [3, 3, 1])

    def test_byte_cap_flushes_before_overflow(self):
        rows = [self._row('doc-a', n, size=60) for n in range(1, 5)]
        batches = portfolio_archive.split_into_batches(
            self._manifest(old=rows), max_rows=100, max_payload_bytes=150,
        )
        self.assertEqual([len(b['rows']) for b in batches], [2, 2])

    def test_deleted_document_never_splits(self):
        doc = {
            'documentId': DOC_A, 'revisions': [
                self._row(DOC_A, n) for n in range(1, 6)
            ],
        }
        filler = [self._row('doc-fill', n) for n in range(1, 3)]
        batches = portfolio_archive.split_into_batches(
            self._manifest(old=filler, deleted=[doc]),
            max_rows=4, max_payload_bytes=10_000,
        )
        # The 5-revision document exceeds max_rows: it gets its own
        # oversized batch instead of splitting.
        doc_batches = [
            b for b in batches
            if any(row['documentId'] == DOC_A for row in b['rows'])
        ]
        self.assertEqual(len(doc_batches), 1)
        self.assertEqual(len(doc_batches[0]['rows']), 5)
        self.assertTrue(doc_batches[0]['oversized'])


class ArchivePathSafetyTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.archive_dir = pathlib.Path(self._tmp.name) / 'archives'
        self.archive_dir.mkdir()

    def test_valid_id_resolves_inside_dir(self):
        path = portfolio_archive.archive_path_for_id(
            self.archive_dir, 'portfolio-archive-2026-001'
        )
        self.assertEqual(path.parent, self.archive_dir)

    def test_malformed_ids_rejected(self):
        for bad in ('../evil', 'portfolio-archive-2026-001/../x',
                    '/etc/passwd', 'portfolio-archive-26-1', '',
                    'portfolio-archive-2026-0001', None, 123):
            with self.assertRaises(portfolio_archive.ArchiveNotFoundError):
                portfolio_archive.archive_path_for_id(self.archive_dir, bad)

    def test_symlink_escape_rejected(self):
        outside = pathlib.Path(self._tmp.name) / 'outside.db'
        outside.write_bytes(b'x')
        link = self.archive_dir / 'portfolio-archive-2026-002.db'
        link.symlink_to(outside)
        with self.assertRaises(portfolio_archive.ArchiveNotFoundError):
            portfolio_archive.archive_path_for_id(
                self.archive_dir, 'portfolio-archive-2026-002'
            )


import portfolio_archive
import portfolio_maintenance
import portfolio_store_ws


def make_archive_env(tmpdir, *, now=NOW):
    """Store env over a temp DB with a fixed clock, seeded with one live
    document (8 revisions across days, Chinese payloads mixed in) and one
    soft-deleted document past the 30-day grace."""
    config = configparser.ConfigParser()
    config.read_string(
        '[portfolio_store]\n'
        f'db_path = {pathlib.Path(tmpdir) / "portfolio.db"}\n'
        'backup_interval_hours = 0\n'
    )
    env = portfolio_store_ws.create_store_env(config)
    db_path = pathlib.Path(tmpdir) / 'portfolio.db'

    clock = FakeClock(now - timedelta(days=60))
    seeder = PortfolioStore(db_path, now=clock).initialize()
    revision = None
    for n in range(1, 9):
        result = seeder.save_workspace(
            document_id=DOC_A, title='SPY workspace',
            payload=_payload(note=f'第{n}版' if n % 2 else f'rev {n}'),
            save_token=_token(n), expected_revision=revision,
        )
        revision = result['revision']
        clock.advance(days=1)
    clock.current = now - timedelta(days=45)
    seeder.save_workspace(
        document_id='doc-deleted-1111-4111-8111-111111111111',
        title='已删除工作区', payload=_payload(underlyingSymbol='QQQ'),
        save_token=_token(901),
    )
    seeder.save_workspace(
        document_id='doc-deleted-1111-4111-8111-111111111111',
        title='已删除工作区', payload=_payload(underlyingSymbol='QQQ', note='二'),
        save_token=_token(902), expected_revision=1,
    )
    seeder.delete_document('doc-deleted-1111-4111-8111-111111111111', 2)

    env['store'] = PortfolioStore(db_path, now=lambda: now)
    env['store'].initialize()
    env['available'] = True
    env['_initialized'] = True
    return env


ARCHIVE_POLICY = {
    'revisionKeepRecent': 2,
    'revisionKeepDailyDays': 0,
    'archiveDeletedAfterDays': 30,
}


def make_plan(env, policy=None):
    store = env['store']
    preview = portfolio_archive.build_archive_preview(
        store, policy=dict(policy or ARCHIVE_POLICY)
    )
    preview['fingerprint'] = portfolio_archive.compute_generation_fingerprint(
        preview, install_id=store.ensure_install_id(),
        created_at_utc='2026-08-15T00:00:00.000Z', nonce='test-nonce',
    )
    return preview


def run_job(env, plan):
    store = env['store']
    job = store.create_maintenance_job(job_type='archive_copy')
    guard = portfolio_maintenance.acquire_maintenance(env)
    assert guard is not None
    try:
        store.start_maintenance_job(job['jobId'])
        summary = portfolio_archive.run_copy_job(
            env, guard, job['jobId'], plan
        )
        store.finish_maintenance_job(
            job['jobId'], status='completed', summary=summary
        )
        return summary
    finally:
        guard.release()


def active_tables_digest(db_path):
    """Stable digest of every workspace table's contents — the copy-only
    invariant is that this NEVER changes."""
    conn = sqlite3.connect(db_path)
    try:
        digest = []
        for table in ('workspace_documents', 'workspace_revisions',
                      'workspace_save_receipts', 'workspace_archive_entries',
                      'workspace_archive_tombstones'):
            rows = conn.execute(
                f'SELECT * FROM {table} ORDER BY 1, 2'
            ).fetchall()
            digest.append((table, rows))
        return repr(digest)
    finally:
        conn.close()


class CopyOnlyJobTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.env = make_archive_env(self.tmpdir)
        self.store = self.env['store']
        self.db_path = pathlib.Path(self.store.db_path)
        self.archive_dir = self.db_path.parent / 'archives'

    def _shard_conn(self, archive_id='portfolio-archive-2026-001'):
        return sqlite3.connect(self.archive_dir / f'{archive_id}.db')

    def test_copy_job_copies_verifies_and_never_touches_active(self):
        before = active_tables_digest(self.db_path)
        plan = make_plan(self.env)
        self.assertEqual(plan['totals']['oldRevisionCount'], 6)  # 8 revisions minus kept {7,8}
        self.assertEqual(plan['totals']['deletedDocumentCount'], 1)
        self.assertEqual(plan['totals']['revisionCount'], 8)

        summary = run_job(self.env, plan)
        self.assertEqual(summary['copiedRevisions'], 8)
        self.assertTrue(summary['copyOnly'])
        self.assertEqual(summary['skipped'], [])
        self.assertEqual(active_tables_digest(self.db_path), before)

        conn = self._shard_conn(summary['archiveId'])
        try:
            statuses = {row[0] for row in conn.execute(
                'SELECT status FROM archive_batches'
            )}
            self.assertEqual(statuses, {'verified'})
            archived = conn.execute(
                'SELECT count(*) FROM archived_revisions'
            ).fetchone()[0]
            self.assertEqual(archived, 8)
            # Byte-for-byte payload parity with the active database.
            for doc_id, revision, sha, payload in conn.execute(
                'SELECT document_id, revision, payload_sha256, payload_json '
                'FROM archived_revisions'
            ):
                active = sqlite3.connect(self.db_path)
                try:
                    row = active.execute(
                        'SELECT payload_sha256, payload_json '
                        'FROM workspace_revisions '
                        'WHERE document_id = ? AND revision = ?',
                        (doc_id, revision),
                    ).fetchone()
                finally:
                    active.close()
                self.assertIsNotNone(row)
                self.assertEqual(row[0], sha)
                self.assertEqual(row[1], payload)
                self.assertEqual(
                    hashlib.sha256(payload.encode('utf-8')).hexdigest(), sha
                )
        finally:
            conn.close()

        registry = self.store.list_archive_registry()
        self.assertEqual(len(registry), 1)
        self.assertEqual(registry[0]['status'], 'active')
        self.assertEqual(registry[0]['revision_count'], 8)
        self.assertEqual(registry[0]['last_verify_status'], 'ok')

        # Recovery snapshot exists, is verified, and restores.
        from portfolio_store import restore_database
        snapshots = list(
            (self.db_path.parent / 'maintenance-backups').glob(
                'pre-archive-*.db'
            )
        )
        self.assertEqual(len(snapshots), 1)
        restored_path = pathlib.Path(self.tmpdir) / 'restored.db'
        restore_database(snapshots[0], restored_path)
        PortfolioStore(restored_path).initialize().quick_check()

    def test_second_run_is_idempotent_no_duplicates(self):
        first = run_job(self.env, make_plan(self.env))
        before = active_tables_digest(self.db_path)
        second = run_job(self.env, make_plan(self.env))
        self.assertEqual(active_tables_digest(self.db_path), before)
        conn = self._shard_conn(first['archiveId'])
        try:
            archived = conn.execute(
                'SELECT count(*) FROM archived_revisions'
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(archived, 8)  # replays skipped, nothing duplicated

    def test_conflicting_existing_row_aborts_batch(self):
        run_job(self.env, make_plan(self.env))
        conn = self._shard_conn()
        try:
            # Forge a conflicting copy of a row the next run will touch:
            # same PK, different hash.
            conn.execute(
                'UPDATE archived_revisions SET payload_sha256 = ? '
                'WHERE revision = 1', ('f' * 64,),
            )
            conn.commit()
        finally:
            conn.close()
        before = active_tables_digest(self.db_path)
        with self.assertRaises(portfolio_archive.ArchiveConflictError):
            run_job(self.env, make_plan(self.env))
        self.assertEqual(active_tables_digest(self.db_path), before)

    def test_save_after_preview_makes_plan_stale(self):
        plan = make_plan(self.env)
        self.store.save_workspace(
            document_id=DOC_A, title='SPY workspace',
            payload=_payload(note='post-preview'), save_token=_token(500),
            expected_revision=8,
        )
        before = active_tables_digest(self.db_path)
        with self.assertRaises(portfolio_archive.ArchivePlanStaleError):
            run_job(self.env, plan)
        self.assertEqual(active_tables_digest(self.db_path), before)
        self.assertEqual(list(self.archive_dir.glob('*.db')), [])

    def test_undelete_after_preview_makes_plan_stale(self):
        plan = make_plan(self.env)
        self.store.undelete_document(
            'doc-deleted-1111-4111-8111-111111111111', 2
        )
        with self.assertRaises(portfolio_archive.ArchivePlanStaleError):
            run_job(self.env, plan)
        self.assertEqual(list(self.archive_dir.glob('*.db')), [])

    def test_cancel_between_batches_stops_cleanly(self):
        self.env['_archive_max_rows_per_batch'] = 2  # force several batches
        plan = make_plan(self.env)
        store = self.store
        job = store.create_maintenance_job(job_type='archive_copy')
        store.start_maintenance_job(job['jobId'])
        store.request_job_cancel(job['jobId'])
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        try:
            summary = portfolio_archive.run_copy_job(
                self.env, guard, job['jobId'], plan
            )
        finally:
            guard.release()
        self.assertTrue(summary['canceled'])
        self.assertEqual(summary['copiedRevisions'], 0)

    def test_dead_batch_rows_are_cleaned_and_not_reused(self):
        first = run_job(self.env, make_plan(self.env))
        conn = self._shard_conn(first['archiveId'])
        try:
            # Simulate a dead foreign writer: a failed batch that still
            # holds payload rows.
            conn.execute(
                "INSERT INTO archive_batches (batch_id, status, policy_json, "
                "preview_fingerprint, source_schema_version, created_at_utc) "
                "VALUES ('batch-dead000000000000000000', 'failed', '{}', 'x', "
                "2, '2026-08-01T00:00:00.000Z')"
            )
            conn.execute(
                'INSERT INTO archived_revisions (document_id, revision, '
                'save_token, payload_schema_version, payload_sha256, '
                'payload_json, saved_at_utc, payload_bytes, '
                'archive_batch_id, archived_at_utc) VALUES '
                "('doc-ghost-9999-4999-8999-999999999999', 1, "
                "'save-ghost01-4000-8000-000000000000', 1, 'a1', '{}', "
                "'2026-08-01T00:00:00.000Z', 2, "
                "'batch-dead000000000000000000', '2026-08-01T00:00:00.000Z')"
            )
            conn.commit()
        finally:
            conn.close()

        summary = run_job(self.env, make_plan(self.env))
        self.assertIn('batch-dead000000000000000000',
                      summary['cleanedDeadBatches'])
        conn = self._shard_conn(first['archiveId'])
        try:
            ghost = conn.execute(
                'SELECT count(*) FROM archived_revisions '
                "WHERE archive_batch_id = 'batch-dead000000000000000000'"
            ).fetchone()[0]
            dead_status = conn.execute(
                'SELECT status FROM archive_batches '
                "WHERE batch_id = 'batch-dead000000000000000000'"
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(ghost, 0)
        self.assertEqual(dead_status, 'failed')
        # Registry stats exclude the dead batch's rows.
        registry = self.store.list_archive_registry()
        self.assertEqual(registry[0]['revision_count'], 8)

    def test_rollover_seals_full_shard_and_creates_next(self):
        run_job(self.env, make_plan(self.env))
        # Force rollover: any real file exceeds a 1-byte cap.
        self.env['_archive_rollover_bytes'] = 1
        shard, archive_id, _ = portfolio_archive.select_writable_shard(
            self.store, self.archive_dir, rollover_bytes=1,
        )
        self.assertEqual(archive_id, 'portfolio-archive-2026-002')
        registry = {
            row['archive_id']: row for row in self.store.list_archive_registry()
        }
        self.assertEqual(
            registry['portfolio-archive-2026-001']['status'], 'sealed'
        )
        self.assertEqual(
            registry['portfolio-archive-2026-002']['status'], 'active'
        )
        # Sealed shards carry the sealed stamp inside the file too.
        meta = portfolio_archive.ArchiveShard(
            self.archive_dir / 'portfolio-archive-2026-001.db'
        ).meta()
        self.assertIsNotNone(meta['sealed_at_utc'])


if __name__ == '__main__':
    unittest.main()
