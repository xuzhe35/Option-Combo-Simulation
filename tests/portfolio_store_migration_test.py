"""Phase 1 tests: v1 -> v2 migration, save receipts, and payload_bytes.

Covers the phase-1 acceptance list of
CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md: journaled resumable
backfill, synthesized-receipt semantics, idempotent re-initialize, refusal
of newer/foreign/corrupt databases, revision+receipt atomicity, replay
surviving payload removal, and the no-cascade guarantee for the new tables.
"""

import hashlib
import json
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from portfolio_store import (
    DuplicateSaveTokenError,
    InvalidRequestError,
    MAINTENANCE_BACKUP_DIRNAME,
    PortfolioStore,
    RevisionConflictError,
    SCHEMA_USER_VERSION,
    StoreUnavailableError,
)

DOC_A = 'doc-aaaaaaaa-1111-4111-8111-111111111111'
DOC_B = 'doc-bbbbbbbb-2222-4222-8222-222222222222'

# The exact v1 DDL as shipped (before payload_bytes / receipts existed).
_V1_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE workspace_documents (
        document_id      TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        symbol           TEXT NOT NULL DEFAULT '',
        market_data_mode TEXT NOT NULL DEFAULT 'live'
                         CHECK (market_data_mode IN ('live', 'historical')),
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        created_at_utc   TEXT NOT NULL,
        updated_at_utc   TEXT NOT NULL,
        deleted_at_utc   TEXT
    )
    """,
    """
    CREATE TABLE workspace_revisions (
        document_id            TEXT NOT NULL,
        revision               INTEGER NOT NULL CHECK (revision >= 1),
        save_token             TEXT NOT NULL UNIQUE,
        payload_schema_version INTEGER NOT NULL,
        payload_sha256         TEXT NOT NULL,
        payload_json           TEXT NOT NULL,
        saved_at_utc           TEXT NOT NULL,
        PRIMARY KEY (document_id, revision),
        FOREIGN KEY (document_id)
            REFERENCES workspace_documents(document_id)
            ON DELETE CASCADE
    )
    """,
    """
    CREATE INDEX idx_workspace_documents_updated
        ON workspace_documents(deleted_at_utc, updated_at_utc DESC)
    """,
)


def _token(n):
    return f'save-{n:08d}-4000-8000-000000000000'


def _payload(**overrides):
    payload = {
        'sessionSchemaVersion': 1,
        'underlyingSymbol': 'SPY',
        'marketDataMode': 'live',
        'baseDate': '2026-08-03',
        'groups': [],
        'hedges': [],
    }
    payload.update(overrides)
    return payload


def _canonical_text(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'))


def _iso(n_minutes):
    base = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)
    stamp = base.timestamp() + n_minutes * 60
    return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat(
        timespec='milliseconds'
    ).replace('+00:00', 'Z')


def build_v1_database(db_path, documents):
    """documents: list of dicts with keys document_id, title, deleted_at_utc
    (or None), and revisions = [(revision, payload_dict, saved_at, token)]."""
    conn = sqlite3.connect(db_path, isolation_level=None)
    try:
        conn.execute('PRAGMA auto_vacuum = INCREMENTAL')
        conn.execute('PRAGMA journal_mode = WAL')
        conn.execute('BEGIN IMMEDIATE')
        for statement in _V1_SCHEMA_STATEMENTS:
            conn.execute(statement)
        conn.execute('PRAGMA user_version = 1')
        conn.execute('COMMIT')
        conn.execute('BEGIN IMMEDIATE')
        for doc in documents:
            revisions = doc['revisions']
            current = max(revision for revision, _, _, _ in revisions)
            conn.execute(
                'INSERT INTO workspace_documents (document_id, title, symbol, '
                'market_data_mode, current_revision, created_at_utc, '
                'updated_at_utc, deleted_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (doc['document_id'], doc['title'], doc.get('symbol', 'SPY'),
                 doc.get('market_data_mode', 'live'), current,
                 revisions[0][2], revisions[-1][2], doc.get('deleted_at_utc')),
            )
            conn.executemany(
                'INSERT INTO workspace_revisions (document_id, revision, '
                'save_token, payload_schema_version, payload_sha256, '
                'payload_json, saved_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                    (
                        doc['document_id'], revision, token, 1,
                        hashlib.sha256(
                            _canonical_text(payload).encode('utf-8')
                        ).hexdigest(),
                        _canonical_text(payload), saved_at,
                    )
                    for revision, payload, saved_at, token in revisions
                ],
            )
        conn.execute('COMMIT')
    finally:
        conn.close()


def _small_v1_fixture(db_path):
    build_v1_database(db_path, [
        {
            'document_id': DOC_A,
            'title': 'SPY workspace',
            'revisions': [
                (1, _payload(note='first'), _iso(0), _token(1)),
                (2, _payload(note='中文备注，多字节内容'), _iso(60), _token(2)),
                (3, _payload(note='third'), _iso(120), _token(3)),
            ],
        },
        {
            'document_id': DOC_B,
            'title': '已删除的工作区',
            'deleted_at_utc': _iso(500),
            'revisions': [
                (1, _payload(underlyingSymbol='QQQ'), _iso(10), _token(11)),
                (2, _payload(underlyingSymbol='QQQ', note='二'), _iso(70), _token(12)),
            ],
        },
    ])


class _CrashAfterBatches(PortfolioStore):
    """Simulates a process crash between backfill batches: batches before
    the crash point are committed, the crashing batch rolls back."""

    def __init__(self, *args, crash_after=3, **kwargs):
        super().__init__(*args, **kwargs)
        self._batches_left = crash_after

    def _journal_batch(self, conn, step, rows_processed, payload_bytes):
        if self._batches_left <= 0:
            raise sqlite3.OperationalError('simulated crash between batches')
        self._batches_left -= 1
        super()._journal_batch(conn, step, rows_processed, payload_bytes)


class MigrationTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = pathlib.Path(self._tmp.name)
        self.db_path = self.root / 'portfolio.db'

    def _query(self, sql, params=()):
        conn = sqlite3.connect(self.db_path)
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def _scalar(self, sql, params=()):
        return self._query(sql, params)[0][0]


class V1UpgradeTest(MigrationTestBase):
    def test_upgrade_backfills_receipts_and_payload_bytes(self):
        _small_v1_fixture(self.db_path)
        store = PortfolioStore(self.db_path).initialize()

        self.assertEqual(self._scalar('PRAGMA user_version'), 2)
        self.assertEqual(
            self._scalar('SELECT count(*) FROM workspace_save_receipts'), 5
        )
        self.assertEqual(
            self._scalar(
                'SELECT count(*) FROM workspace_revisions r '
                'LEFT JOIN workspace_save_receipts s ON s.save_token = r.save_token '
                'WHERE s.save_token IS NULL'
            ),
            0,
        )
        # payload_bytes is the canonical UTF-8 byte count, not characters.
        rows = self._query(
            'SELECT payload_json, payload_bytes FROM workspace_revisions'
        )
        for payload_json, payload_bytes in rows:
            self.assertEqual(payload_bytes, len(payload_json.encode('utf-8')))
        chinese_bytes, chinese_chars = self._query(
            'SELECT payload_bytes, length(payload_json) '
            'FROM workspace_revisions WHERE document_id = ? AND revision = 2',
            (DOC_A,),
        )[0]
        self.assertGreater(chinese_bytes, chinese_chars)

        # Synthesized receipts: current-document title, derived symbol/mode,
        # revision-row facts, operation NULL, no idempotentReplay stored.
        receipt = self._query(
            'SELECT document_id, revision, payload_sha256, payload_bytes, '
            'saved_at_utc, operation, result_json '
            'FROM workspace_save_receipts WHERE save_token = ?', (_token(12),)
        )[0]
        self.assertEqual(receipt[0], DOC_B)
        self.assertEqual(receipt[1], 2)
        self.assertIsNone(receipt[5])
        result = json.loads(receipt[6])
        self.assertEqual(
            set(result),
            {'documentId', 'title', 'symbol', 'marketDataMode', 'revision',
             'updatedAtUtc', 'payloadSha256', 'payloadBytes'},
        )
        self.assertEqual(result['title'], '已删除的工作区')
        self.assertEqual(result['symbol'], 'QQQ')
        self.assertEqual(result['revision'], 2)
        self.assertEqual(result['updatedAtUtc'], receipt[4])
        self.assertEqual(result['payloadSha256'], receipt[2])
        self.assertEqual(result['payloadBytes'], receipt[3])

        # Journal recorded at least one batch per backfill step.
        steps = {
            row[0] for row in self._query(
                'SELECT DISTINCT step FROM workspace_migration_journal'
            )
        }
        self.assertEqual(steps, {'payload_bytes', 'save_receipts'})

        # Pre-migration safety snapshot exists, verifies, and is still v1.
        backups = sorted(
            (self.root / MAINTENANCE_BACKUP_DIRNAME).glob(
                'pre-migration-v1-to-v2-*.db'
            )
        )
        self.assertEqual(len(backups), 1)
        PortfolioStore(backups[0]).quick_check()
        conn = sqlite3.connect(backups[0])
        try:
            self.assertEqual(
                conn.execute('PRAGMA user_version').fetchone()[0], 1
            )
        finally:
            conn.close()

        # Normal operation after migration.
        loaded = store.load_workspace(DOC_A)
        self.assertEqual(loaded['revision'], 3)

    def test_synthesized_result_json_matches_live_save_ack_shape(self):
        _small_v1_fixture(self.db_path)
        PortfolioStore(self.db_path).initialize()
        migrated_keys = set(json.loads(self._scalar(
            'SELECT result_json FROM workspace_save_receipts WHERE save_token = ?',
            (_token(1),),
        )))

        live_db = self.root / 'fresh.db'
        live_store = PortfolioStore(live_db).initialize()
        ack = live_store.save_workspace(
            document_id=DOC_A, title='live', payload=_payload(),
            save_token=_token(90),
        )
        conn = sqlite3.connect(live_db)
        try:
            live_result = json.loads(conn.execute(
                'SELECT result_json FROM workspace_save_receipts '
                'WHERE save_token = ?', (_token(90),),
            ).fetchone()[0])
        finally:
            conn.close()
        self.assertEqual(set(live_result), migrated_keys)
        expected = {k: v for k, v in ack.items() if k != 'idempotentReplay'}
        self.assertEqual(live_result, expected)

    def test_reinitialize_is_idempotent_without_refill(self):
        _small_v1_fixture(self.db_path)
        PortfolioStore(self.db_path).initialize()
        receipts = self._scalar('SELECT count(*) FROM workspace_save_receipts')
        journal = self._scalar('SELECT count(*) FROM workspace_migration_journal')
        PortfolioStore(self.db_path).initialize()
        self.assertEqual(
            self._scalar('SELECT count(*) FROM workspace_save_receipts'), receipts
        )
        self.assertEqual(
            self._scalar('SELECT count(*) FROM workspace_migration_journal'), journal
        )

    def test_replay_survives_revision_removal(self):
        _small_v1_fixture(self.db_path)
        store = PortfolioStore(self.db_path).initialize()
        # Simulate archival: the old revision's payload row disappears.
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                'DELETE FROM workspace_revisions '
                'WHERE document_id = ? AND revision = 1', (DOC_A,)
            )
            conn.commit()
        finally:
            conn.close()

        retry = store.save_workspace(
            document_id=DOC_A, title='whatever', payload=_payload(note='first'),
            save_token=_token(1),
        )
        self.assertTrue(retry['idempotentReplay'])
        self.assertEqual(retry['revision'], 1)
        self.assertEqual(retry['title'], 'SPY workspace')

        with self.assertRaises(DuplicateSaveTokenError):
            store.save_workspace(
                document_id=DOC_A, title='x', payload=_payload(note='DIFFERENT'),
                save_token=_token(1),
            )
        with self.assertRaises(DuplicateSaveTokenError):
            store.save_workspace(
                document_id=DOC_B, title='x', payload=_payload(note='first'),
                save_token=_token(1), expected_revision=2,
            )

    def test_replay_survives_prune(self):
        _small_v1_fixture(self.db_path)
        store = PortfolioStore(self.db_path).initialize()
        deleted = store.prune_revisions(keep_recent=1, keep_daily_days=0)
        self.assertGreater(deleted, 0)
        retry = store.save_workspace(
            document_id=DOC_A, title='whatever', payload=_payload(note='first'),
            save_token=_token(1),
        )
        self.assertTrue(retry['idempotentReplay'])
        self.assertEqual(retry['revision'], 1)


class BatchedBackfillTest(MigrationTestBase):
    REVISIONS = 10_000

    def _bulk_v1_fixture(self):
        revisions = [
            (
                n,
                _payload(note=f'第{n}批' if n % 7 == 0 else f'rev {n}'),
                _iso(n),
                _token(n),
            )
            for n in range(1, self.REVISIONS + 1)
        ]
        build_v1_database(self.db_path, [
            {'document_id': DOC_A, 'title': 'bulk', 'revisions': revisions},
        ])

    def test_bulk_backfill_runs_in_bounded_batches(self):
        self._bulk_v1_fixture()
        PortfolioStore(self.db_path, migration_batch_rows=1000).initialize()
        self.assertEqual(self._scalar('PRAGMA user_version'), 2)
        self.assertEqual(
            self._scalar('SELECT count(*) FROM workspace_save_receipts'),
            self.REVISIONS,
        )
        for step in ('payload_bytes', 'save_receipts'):
            batches = self._scalar(
                'SELECT count(*) FROM workspace_migration_journal WHERE step = ?',
                (step,),
            )
            self.assertGreaterEqual(batches, self.REVISIONS // 1000)
            max_rows = self._scalar(
                'SELECT MAX(rows_processed) FROM workspace_migration_journal '
                'WHERE step = ?', (step,),
            )
            self.assertLessEqual(max_rows, 1000)

    def test_interrupted_migration_resumes_from_journal(self):
        revisions = [
            (n, _payload(note=f'rev {n}'), _iso(n), _token(n))
            for n in range(1, 61)
        ]
        build_v1_database(self.db_path, [
            {'document_id': DOC_A, 'title': 'resume', 'revisions': revisions},
        ])

        crashing = _CrashAfterBatches(
            self.db_path, migration_batch_rows=10, crash_after=3
        )
        with self.assertRaises(StoreUnavailableError):
            crashing.initialize()

        # Half-migrated: version still 1, some committed backfill work kept.
        self.assertEqual(self._scalar('PRAGMA user_version'), 1)
        committed_journal = self._scalar(
            'SELECT count(*) FROM workspace_migration_journal'
        )
        self.assertEqual(committed_journal, 3)

        # The store refuses data operations until migration completes.
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(self.db_path).list_documents()

        # Resume completes from committed work without duplicating rows.
        PortfolioStore(self.db_path, migration_batch_rows=10).initialize()
        self.assertEqual(self._scalar('PRAGMA user_version'), 2)
        self.assertEqual(
            self._scalar('SELECT count(*) FROM workspace_save_receipts'), 60
        )
        self.assertEqual(
            self._scalar(
                'SELECT count(*) FROM workspace_revisions WHERE payload_bytes < 0'
            ),
            0,
        )
        self.assertGreater(
            self._scalar('SELECT count(*) FROM workspace_migration_journal'),
            committed_journal,
        )
        # Only one pre-migration backup: the resume must not take a second.
        backups = list(
            (self.root / MAINTENANCE_BACKUP_DIRNAME).glob(
                'pre-migration-v1-to-v2-*.db'
            )
        )
        self.assertEqual(len(backups), 1)


class RestoreDrillTest(MigrationTestBase):
    def test_pre_migration_snapshot_restores_and_remigrates(self):
        from portfolio_store import restore_database

        _small_v1_fixture(self.db_path)
        store = PortfolioStore(self.db_path).initialize()
        store.save_workspace(
            document_id=DOC_A, title='post-migration save',
            payload=_payload(note='after v2'), save_token=_token(50),
            expected_revision=3,
        )
        backup = next(
            (self.root / MAINTENANCE_BACKUP_DIRNAME).glob(
                'pre-migration-v1-to-v2-*.db'
            )
        )

        # Disaster drill: reinstall the v1 snapshot as the active database.
        # restore_database migrates the staged copy before installing it, so
        # the restored active DB is v2 with complete receipts again.
        result = restore_database(backup, self.db_path)
        self.assertIsNotNone(result['displaced_to'])
        self.assertEqual(self._scalar('PRAGMA user_version'), 2)
        restored = PortfolioStore(self.db_path).initialize()
        loaded = restored.load_workspace(DOC_A)
        self.assertEqual(loaded['revision'], 3)  # pre-snapshot state
        self.assertEqual(
            self._scalar('SELECT count(*) FROM workspace_save_receipts'), 5
        )
        self.assertEqual(
            self._scalar(
                'SELECT count(*) FROM workspace_revisions '
                'WHERE payload_bytes < 0'
            ),
            0,
        )


class RefusalTest(MigrationTestBase):
    def test_newer_schema_refused(self):
        PortfolioStore(self.db_path).initialize()
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute('PRAGMA user_version = 3')
        conn.close()
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(self.db_path).initialize()
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(self.db_path).list_documents()

    def test_foreign_v1_claim_refused(self):
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute('CREATE TABLE unrelated (x)')
        conn.execute('PRAGMA user_version = 1')
        conn.close()
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(self.db_path).initialize()
        conn = sqlite3.connect(self.db_path)
        try:
            tables = {
                row[0] for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            self.assertEqual(tables, {'unrelated'})
            self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 1)
        finally:
            conn.close()

    def test_corrupt_file_not_overwritten(self):
        garbage = b'this is not a sqlite database' * 100
        self.db_path.write_bytes(garbage)
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(self.db_path).initialize()
        self.assertEqual(self.db_path.read_bytes(), garbage)

    def test_backup_failure_leaves_v1_untouched(self):
        _small_v1_fixture(self.db_path)
        # Occupy the maintenance-backups path with a file so mkdir fails.
        (self.root / MAINTENANCE_BACKUP_DIRNAME).write_text('in the way')
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(self.db_path).initialize()
        self.assertEqual(self._scalar('PRAGMA user_version'), 1)
        tables = {
            row[0] for row in self._query(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        self.assertNotIn('workspace_save_receipts', tables)
        self.assertNotIn('workspace_migration_journal', tables)


class ReceiptWriteSemanticsTest(MigrationTestBase):
    def setUp(self):
        super().setUp()
        self.store = PortfolioStore(self.db_path).initialize()

    def _counts(self):
        return (
            self._scalar('SELECT count(*) FROM workspace_revisions'),
            self._scalar('SELECT count(*) FROM workspace_save_receipts'),
        )

    def test_save_writes_revision_and_receipt_together(self):
        self.store.save_workspace(
            document_id=DOC_A, title='t', payload=_payload(),
            save_token=_token(1), operation='create',
        )
        self.assertEqual(self._counts(), (1, 1))
        self.assertEqual(
            self._scalar(
                'SELECT operation FROM workspace_save_receipts '
                'WHERE save_token = ?', (_token(1),),
            ),
            'create',
        )

    def test_default_operation_is_null_never_inferred(self):
        self.store.save_workspace(
            document_id=DOC_A, title='t', payload=_payload(),
            save_token=_token(1),
        )
        self.assertIsNone(
            self._scalar(
                'SELECT operation FROM workspace_save_receipts '
                'WHERE save_token = ?', (_token(1),),
            )
        )

    def test_invalid_operation_rejected_before_any_write(self):
        with self.assertRaises(InvalidRequestError):
            self.store.save_workspace(
                document_id=DOC_A, title='t', payload=_payload(),
                save_token=_token(1), operation='rename',
            )
        self.assertEqual(self._counts(), (0, 0))

    def test_failed_save_writes_neither_row(self):
        self.store.save_workspace(
            document_id=DOC_A, title='t', payload=_payload(),
            save_token=_token(1),
        )
        with self.assertRaises(DuplicateSaveTokenError):
            self.store.save_workspace(
                document_id=DOC_A, title='t', payload=_payload(note='diff'),
                save_token=_token(1), expected_revision=1,
            )
        with self.assertRaises(RevisionConflictError):
            self.store.save_workspace(
                document_id=DOC_A, title='t', payload=_payload(note='x'),
                save_token=_token(2),
            )
        self.assertEqual(self._counts(), (1, 1))

    def test_receipts_survive_document_hard_delete(self):
        self.store.save_workspace(
            document_id=DOC_A, title='t', payload=_payload(),
            save_token=_token(1),
        )
        self.store.save_workspace(
            document_id=DOC_A, title='t', payload=_payload(note='2'),
            save_token=_token(2), expected_revision=1,
        )
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute('PRAGMA foreign_keys = ON')
            conn.execute(
                'DELETE FROM workspace_documents WHERE document_id = ?', (DOC_A,)
            )
            conn.commit()
        finally:
            conn.close()
        # Cascade removed the revisions; the idempotency ledger survives.
        self.assertEqual(self._counts(), (0, 2))

    def test_new_tables_have_no_foreign_keys(self):
        for table in ('workspace_save_receipts', 'workspace_archive_entries',
                      'workspace_archive_tombstones', 'workspace_archives',
                      'workspace_maintenance_jobs', 'workspace_maintenance_lease'):
            self.assertEqual(
                self._query(f'PRAGMA foreign_key_list({table})'), [],
                f'{table} must not cascade from documents/revisions',
            )


if __name__ == '__main__':
    unittest.main()
