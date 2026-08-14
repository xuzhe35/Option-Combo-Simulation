"""Phase 0 tests for portfolio_archive.py — frozen candidate rules and
storage-metric vocabulary (CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md).

Pure stdlib, temp directories only. The parity test drives the SAME fixture
through the pure candidate rule and through PortfolioStore.prune_revisions to
prove the rule matches today's retention behavior exactly.
"""

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


if __name__ == '__main__':
    unittest.main()
