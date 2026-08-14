"""Phase 2 tests for portfolio_admin_ws.py — read-only admin protocol.

Temp-directory stores only. Covers the phase-2 gate: counts match direct SQL
fixtures, metric classes stay distinct, Unicode exact stats, loopback before
lazy open, no path/SQL/payload leakage, mode allowlists, the exact-stats job
lifecycle, and the fast-overview budget on a 10,000-revision fixture.
"""

import asyncio
import configparser
import json
import pathlib
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_admin_ws
import portfolio_store_ws
from portfolio_admin_ws import ADMIN_CLIENT_ACTIONS, handle_admin_action
from portfolio_store import PortfolioStore

DOC = 'doc-aaaaaaaa-1111-4111-8111-111111111111'
DOC_DELETED = 'doc-bbbbbbbb-2222-4222-8222-222222222222'
LOOPBACK = ('127.0.0.1', 51000)
REMOTE = ('192.168.1.50', 51000)
NOW = datetime(2026, 8, 15, 12, 0, 0, tzinfo=timezone.utc)


class FakeWebSocket:
    def __init__(self, remote_address=LOOPBACK):
        self.remote_address = remote_address
        self.sent = []

    async def send(self, message):
        self.sent.append(message)


def _payload(**overrides):
    payload = {
        'sessionSchemaVersion': 1,
        'underlyingSymbol': 'SPY',
        'marketDataMode': 'live',
        'baseDate': '2026-08-03',
        'groups': [{'id': 'g1', 'name': '组合一', 'legs': []}],
        'hedges': [],
    }
    payload.update(overrides)
    return payload


def _config(tmpdir, **overrides):
    values = {
        'db_path': str(pathlib.Path(tmpdir) / 'portfolio.db'),
        'backup_interval_hours': '0',
    }
    values.update(overrides)
    lines = '\n'.join(f'{key} = {value}' for key, value in values.items())
    config = configparser.ConfigParser()
    config.read_string(f'[portfolio_store]\n{lines}\n')
    return config


def _one_response(env, ws, data):
    handled = asyncio.run(handle_admin_action(env, ws, data))
    assert handled, f'expected {data.get("action")} to be handled'
    responses = [json.loads(message) for message in ws.sent]
    ws.sent.clear()
    assert len(responses) == 1
    return responses[0]


def _wait_for_job(env, ws, job_id, timeout_s=5.0):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        response = _one_response(env, ws, {
            'action': 'get_workspace_maintenance_job',
            'requestId': 'poll-0001-4000-8000-000000000000',
            'jobId': job_id,
        })
        job = response.get('job') or {}
        if job.get('status') in ('completed', 'failed', 'interrupted', 'canceled'):
            return job
        time.sleep(0.02)
    raise AssertionError(f'job {job_id} did not finish within {timeout_s}s')


class AdminWsTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.db_path = pathlib.Path(self.tmpdir) / 'portfolio.db'
        self.env = portfolio_store_ws.create_store_env(_config(self.tmpdir))
        self.ws = FakeWebSocket()

    def _seed(self, revisions_per_doc=3):
        clock = {'now': NOW - timedelta(days=40)}
        store = PortfolioStore(self.db_path, now=lambda: clock['now']).initialize()
        revision = None
        for n in range(1, revisions_per_doc + 1):
            result = store.save_workspace(
                document_id=DOC, title='SPY workspace',
                payload=_payload(note=f'第{n}版'),
                save_token=f'save-{n:07d}a-4000-8000-000000000000',
                expected_revision=revision,
            )
            revision = result['revision']
            clock['now'] += timedelta(days=1)
        # The deleted document's grace period is measured from a pinned
        # timestamp 40 days before NOW, independent of the revision count.
        clock['now'] = NOW - timedelta(days=40)
        store.save_workspace(
            document_id=DOC_DELETED, title='deleted one',
            payload=_payload(underlyingSymbol='QQQ'),
            save_token='save-del0001-4000-8000-000000000000',
        )
        store.delete_document(DOC_DELETED, 1)
        # Pre-initialize the env with a fixed-clock store so candidate math
        # and recent-activity windows are deterministic in this test.
        admin_store = PortfolioStore(self.db_path, now=lambda: NOW).initialize()
        self.env['store'] = admin_store
        self.env['available'] = True
        self.env['_initialized'] = True
        return store


class AdminStatusTest(AdminWsTestBase):
    def test_status_reports_capability_and_policy(self):
        self._seed()
        response = _one_response(self.env, self.ws, {
            'action': 'request_workspace_admin_status',
            'requestId': 'req-0001-4000-8000-000000000000',
        })
        self.assertTrue(response['success'])
        self.assertTrue(response['available'])
        self.assertEqual(response['schemaVersion'], 2)
        self.assertTrue(response['capability']['readOnly'])
        self.assertFalse(response['capability']['archiveExecute'])
        self.assertEqual(response['policy']['revisionKeepRecent'], 50)
        self.assertEqual(response['policy']['archiveDeletedAfterDays'], 30)
        self.assertFalse(response['policy']['archiveAutoRun'])
        self.assertIsNone(response['currentJob'])

    def test_request_id_is_echoed(self):
        response = _one_response(self.env, self.ws, {
            'action': 'request_workspace_admin_status',
            'requestId': 'echo-1234-4000-8000-000000000000',
        })
        self.assertEqual(
            response['requestId'], 'echo-1234-4000-8000-000000000000'
        )

    def test_non_loopback_rejected_before_lazy_open(self):
        remote_ws = FakeWebSocket(remote_address=REMOTE)
        response = _one_response(self.env, remote_ws, {
            'action': 'request_workspace_admin_status',
            'requestId': 'req-0002-4000-8000-000000000000',
        })
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'remote_access_disabled')
        # The database was never opened, let alone created.
        self.assertFalse(self.env['_initialized'])
        self.assertFalse(self.db_path.exists())

    def test_unknown_action_not_swallowed(self):
        handled = asyncio.run(handle_admin_action(self.env, self.ws, {
            'action': 'drop_all_tables',
        }))
        self.assertFalse(handled)
        self.assertEqual(self.ws.sent, [])
        self.assertNotIn('drop_all_tables', ADMIN_CLIENT_ACTIONS)


class FastStatsTest(AdminWsTestBase):
    def _stats(self):
        response = _one_response(self.env, self.ws, {
            'action': 'request_workspace_storage_stats',
            'requestId': 'req-0003-4000-8000-000000000000',
            'mode': 'fast',
        })
        self.assertTrue(response['success'])
        return response

    def test_counts_match_direct_sql(self):
        self._seed(revisions_per_doc=3)
        response = self._stats()
        conn = sqlite3.connect(self.db_path)
        try:
            active, deleted, revisions, logical = conn.execute(
                'SELECT '
                '(SELECT count(*) FROM workspace_documents '
                ' WHERE deleted_at_utc IS NULL), '
                '(SELECT count(*) FROM workspace_documents '
                ' WHERE deleted_at_utc IS NOT NULL), '
                '(SELECT count(*) FROM workspace_revisions), '
                '(SELECT SUM(length(CAST(payload_json AS BLOB))) '
                ' FROM workspace_revisions)'
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(response['documents']['active'], active)
        self.assertEqual(response['documents']['recentlyDeleted'], deleted)
        self.assertEqual(response['revisions']['count'], revisions)
        self.assertEqual(response['storage']['logicalPayloadBytes'], logical)
        self.assertEqual(response['revisions']['receiptCount'], revisions)

    def test_metric_classes_stay_distinct(self):
        self._seed()
        storage = self._stats()['storage']
        conn = sqlite3.connect(self.db_path)
        try:
            page_count = conn.execute('PRAGMA page_count').fetchone()[0]
            page_size = conn.execute('PRAGMA page_size').fetchone()[0]
            freelist = conn.execute('PRAGMA freelist_count').fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(storage['allocatedDbBytes'], page_count * page_size)
        self.assertEqual(storage['reclaimableBytes'], freelist * page_size)
        # Logical payload is measured in payload bytes, not database pages:
        # the two must never be conflated.
        self.assertNotEqual(
            storage['logicalPayloadBytes'], storage['allocatedDbBytes']
        )
        self.assertIsInstance(storage['walBytes'], int)
        self.assertIsInstance(storage['shmBytes'], int)
        self.assertGreater(storage['dbFileBytes'], 0)

    def test_candidate_summary_uses_policy_and_store_clock(self):
        # 60 revisions, keep_recent=50 default: candidates only appear when
        # revisions fall outside both the recent window and the daily-anchor
        # window. All 60 land on distinct days inside 90 days, so none are
        # candidates; the deleted document is 40 days old, past the 30-day
        # grace, so it IS a whole-document candidate.
        self._seed(revisions_per_doc=60)
        response = self._stats()
        candidates = response['candidates']
        self.assertEqual(candidates['oldRevisions']['candidateCount'], 0)
        self.assertEqual(
            candidates['expiredDeletedDocuments']['documentCount'], 1
        )
        self.assertEqual(
            candidates['expiredDeletedDocuments']['revisionCount'], 1
        )
        self.assertGreater(
            candidates['expiredDeletedDocuments']['payloadBytes'], 0
        )

    def test_unicode_logical_bytes_are_utf8(self):
        store = self._seed(revisions_per_doc=1)
        stats = self._stats()
        conn = sqlite3.connect(self.db_path)
        try:
            char_total = conn.execute(
                'SELECT SUM(length(payload_json)) FROM workspace_revisions'
            ).fetchone()[0]
        finally:
            conn.close()
        # Chinese payload content: byte total strictly exceeds char total.
        self.assertGreater(stats['storage']['logicalPayloadBytes'], char_total)

    def test_invalid_mode_rejected(self):
        self._seed()
        response = _one_response(self.env, self.ws, {
            'action': 'request_workspace_storage_stats',
            'requestId': 'req-0004-4000-8000-000000000000',
            'mode': 'DROP TABLE',
        })
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    def test_response_contains_no_path_sql_or_payload(self):
        self._seed()
        response = self._stats()
        text = json.dumps(response)
        self.assertNotIn(str(self.db_path), text)
        self.assertNotIn(self.tmpdir, text)
        self.assertNotIn('SELECT', text)
        self.assertNotIn('组合一', text)  # payload content must not leak

    def test_fast_overview_meets_budget_on_10k_revisions(self):
        store = PortfolioStore(self.db_path).initialize()
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        try:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute(
                'INSERT INTO workspace_documents (document_id, title, symbol, '
                "market_data_mode, current_revision, created_at_utc, "
                "updated_at_utc, deleted_at_utc) "
                "VALUES (?, 'bulk', 'SPY', 'live', 10000, ?, ?, NULL)",
                (DOC, '2026-01-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
            )
            conn.executemany(
                'INSERT INTO workspace_revisions (document_id, revision, '
                'save_token, payload_schema_version, payload_sha256, '
                'payload_json, saved_at_utc, payload_bytes) '
                'VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
                [
                    (DOC, n, f'save-{n:07d}b-4000-8000-000000000000',
                     'deadbeef' * 8, '{"n":%d}' % n,
                     f'2026-{(n % 12) + 1:02d}-01T00:00:00.000Z', 10)
                    for n in range(1, 10_001)
                ],
            )
            conn.execute('COMMIT')
        finally:
            conn.close()

        started = time.monotonic()
        response = self._stats()
        elapsed = time.monotonic() - started
        self.assertEqual(response['revisions']['count'], 10_000)
        # Plan budget is 500ms P95 on target hardware; the CI bound is looser
        # to avoid flakes but still catches accidental payload scans.
        self.assertLess(elapsed, 2.0)


class ExactStatsJobTest(AdminWsTestBase):
    def test_exact_stats_job_lifecycle(self):
        self._seed()
        response = _one_response(self.env, self.ws, {
            'action': 'request_workspace_storage_stats',
            'requestId': 'req-0005-4000-8000-000000000000',
            'mode': 'exact',
        })
        self.assertTrue(response['success'])
        self.assertEqual(response['mode'], 'exact')
        job_id = response['job']['jobId']
        self.assertEqual(response['job']['status'], 'queued')

        job = _wait_for_job(self.env, self.ws, job_id)
        self.assertEqual(job['status'], 'completed')
        summary = job['summary']
        self.assertEqual(summary['payloadBytesMismatches'], 0)
        self.assertEqual(summary['revisionsMissingReceipts'], 0)
        conn = sqlite3.connect(self.db_path)
        try:
            expected = conn.execute(
                'SELECT SUM(length(CAST(payload_json AS BLOB))) '
                'FROM workspace_revisions'
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(summary['logicalPayloadBytes'], expected)

    def test_exact_stats_detects_byte_mismatch(self):
        self._seed()
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                'UPDATE workspace_revisions SET payload_bytes = 1 '
                'WHERE revision = 1 AND document_id = ?', (DOC,)
            )
            conn.commit()
        finally:
            conn.close()
        response = _one_response(self.env, self.ws, {
            'action': 'request_workspace_storage_stats',
            'requestId': 'req-0006-4000-8000-000000000000',
            'mode': 'exact',
        })
        job = _wait_for_job(self.env, self.ws, response['job']['jobId'])
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['summary']['payloadBytesMismatches'], 1)

    def test_busy_maintenance_lock_fails_job_with_stable_code(self):
        self._seed()
        lock = self.env['_maintenance_lock']
        self.assertTrue(lock.acquire(blocking=False))
        try:
            response = _one_response(self.env, self.ws, {
                'action': 'request_workspace_storage_stats',
                'requestId': 'req-0007-4000-8000-000000000000',
                'mode': 'exact',
            })
            job = _wait_for_job(self.env, self.ws, response['job']['jobId'])
        finally:
            lock.release()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(job['errorCode'], 'maintenance_busy')

    def test_unknown_job_and_bad_job_id(self):
        self._seed()
        response = _one_response(self.env, self.ws, {
            'action': 'get_workspace_maintenance_job',
            'requestId': 'req-0008-4000-8000-000000000000',
            'jobId': 'job-00000000000000000000',
        })
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'job_not_found')

        response = _one_response(self.env, self.ws, {
            'action': 'get_workspace_maintenance_job',
            'requestId': 'req-0009-4000-8000-000000000000',
            'jobId': '../etc/passwd',
        })
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')


class ArchiveRegistrySummaryTest(AdminWsTestBase):
    def test_registry_summary_counts_missing_shards(self):
        self._seed()
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                'INSERT INTO workspace_archives (archive_id, '
                'archive_schema_version, status, created_at_utc, '
                'sealed_at_utc, file_bytes, logical_payload_bytes, '
                'revision_count, missing_since_utc) '
                "VALUES ('portfolio-archive-2026-001', 1, 'sealed', "
                "'2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', "
                '1024, 900, 12, NULL)'
            )
            conn.execute(
                'INSERT INTO workspace_archives (archive_id, '
                'archive_schema_version, status, created_at_utc, '
                'file_bytes, logical_payload_bytes, revision_count, '
                'missing_since_utc) '
                "VALUES ('portfolio-archive-2026-002', 1, 'active', "
                "'2026-07-01T00:00:00.000Z', 2048, 100, 3, "
                "'2026-08-01T00:00:00.000Z')"
            )
            conn.commit()
        finally:
            conn.close()
        response = _one_response(self.env, self.ws, {
            'action': 'request_workspace_storage_stats',
            'requestId': 'req-0010-4000-8000-000000000000',
            'mode': 'fast',
        })
        archive = response['archive']
        self.assertEqual(archive['archiveCount'], 2)
        self.assertEqual(archive['sealedCount'], 1)
        self.assertEqual(archive['missingCount'], 1)
        self.assertEqual(archive['fileBytes'], 3072)
        self.assertEqual(archive['revisionCount'], 15)


class BackendParityTest(AdminWsTestBase):
    """Both backends route the same module; this guards the wiring."""

    def test_both_backends_reference_the_shared_admin_handler(self):
        for server_file in ('ib_server_ws.py', 'historical_server.py'):
            text = (REPO_ROOT / server_file).read_text(encoding='utf-8')
            self.assertIn('portfolio_admin_ws.handle_admin_action', text,
                          f'{server_file} must route admin actions')
            self.assertIn('import portfolio_admin_ws', text)


if __name__ == '__main__':
    unittest.main()
