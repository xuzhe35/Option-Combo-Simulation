"""Tests for portfolio_store.py — pure stdlib, temp directories only.

Covers the phase-1 acceptance list: schema, CRUD round-trips across restarts,
optimistic concurrency, save-token idempotency (sequential and concurrent),
soft delete, restore, validation before the transaction, retention pruning,
corruption/unwritable-path containment, path resolution, and backup.
"""

import configparser
import hashlib
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from portfolio_store import (
    ACCEPTED_PAYLOAD_SCHEMA_VERSIONS,
    DatabaseCorruptError,
    DocumentDeletedError,
    DocumentNotFoundError,
    DuplicateSaveTokenError,
    InvalidPayloadError,
    InvalidRequestError,
    PayloadTooLargeError,
    PortfolioStore,
    RevisionConflictError,
    SCHEMA_USER_VERSION,
    StoreUnavailableError,
    canonicalize_payload,
    default_app_data_dir,
    resolve_db_path,
)


DOC_A = 'doc-aaaaaaaa-1111-4111-8111-111111111111'
DOC_B = 'doc-bbbbbbbb-2222-4222-8222-222222222222'


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


class FakeClock:
    def __init__(self, start):
        self.current = start

    def __call__(self):
        return self.current

    def advance(self, **kwargs):
        self.current = self.current + timedelta(**kwargs)


class PortfolioStoreTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'portfolio.db'
        self.clock = FakeClock(datetime(2026, 8, 8, 12, 0, 0, tzinfo=timezone.utc))
        self.store = PortfolioStore(self.db_path, now=self.clock).initialize()

    def _create_doc(self, document_id=DOC_A, title='SPY workspace', token_n=1,
                    payload=None):
        return self.store.save_workspace(
            document_id=document_id,
            title=title,
            payload=payload if payload is not None else _payload(),
            save_token=_token(token_n),
        )


class SchemaTest(PortfolioStoreTestBase):
    def test_schema_objects_and_versions(self):
        conn = sqlite3.connect(self.db_path)
        try:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            self.assertIn('workspace_documents', tables)
            self.assertIn('workspace_revisions', tables)
            indexes = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='index'"
                )
            }
            self.assertIn('idx_workspace_documents_updated', indexes)
            self.assertEqual(
                conn.execute('PRAGMA user_version').fetchone()[0],
                SCHEMA_USER_VERSION,
            )
            # 2 == INCREMENTAL; must be chosen before the first table exists.
            self.assertEqual(conn.execute('PRAGMA auto_vacuum').fetchone()[0], 2)
            self.assertEqual(
                conn.execute('PRAGMA journal_mode').fetchone()[0], 'wal'
            )
        finally:
            conn.close()

    def test_initialize_is_idempotent(self):
        PortfolioStore(self.db_path).initialize()
        self.assertEqual(self.store.list_documents(), [])

    def test_refuses_foreign_database_file(self):
        foreign = pathlib.Path(self._tmp.name) / 'foreign.db'
        conn = sqlite3.connect(foreign)
        conn.execute('CREATE TABLE unrelated (x)')
        conn.commit()
        conn.close()
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(foreign).initialize()
        conn = sqlite3.connect(foreign)
        try:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            self.assertEqual(tables, {'unrelated'})
        finally:
            conn.close()


class CrudRoundTripTest(PortfolioStoreTestBase):
    def test_create_then_reload_after_restart(self):
        created = self._create_doc()
        self.assertEqual(created['revision'], 1)
        self.assertEqual(created['symbol'], 'SPY')
        self.assertEqual(created['marketDataMode'], 'live')
        self.assertFalse(created['idempotentReplay'])

        reopened = PortfolioStore(self.db_path).initialize()
        docs = reopened.list_documents()
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]['documentId'], DOC_A)
        self.assertEqual(docs[0]['revision'], 1)

        loaded = reopened.load_workspace(DOC_A)
        self.assertEqual(loaded['payload'], _payload())
        self.assertEqual(loaded['payloadSchemaVersion'], 1)
        expected_sha = hashlib.sha256(canonicalize_payload(_payload())).hexdigest()
        self.assertEqual(loaded['payloadSha256'], expected_sha)

    def test_unicode_round_trip(self):
        payload = _payload(underlyingSymbol='SPY', note='中文注释 λ=0.3 ✓')
        self._create_doc(payload=payload)
        loaded = self.store.load_workspace(DOC_A)
        self.assertEqual(loaded['payload']['note'], '中文注释 λ=0.3 ✓')

    def test_save_with_correct_expected_revision(self):
        self._create_doc()
        result = self.store.save_workspace(
            document_id=DOC_A,
            title='SPY workspace v2',
            payload=_payload(baseDate='2026-08-04'),
            save_token=_token(2),
            expected_revision=1,
        )
        self.assertEqual(result['revision'], 2)
        loaded = self.store.load_workspace(DOC_A)
        self.assertEqual(loaded['title'], 'SPY workspace v2')
        self.assertEqual(loaded['payload']['baseDate'], '2026-08-04')

    def test_stale_expected_revision_conflicts_without_changes(self):
        self._create_doc()
        self.store.save_workspace(
            document_id=DOC_A, title='v2', payload=_payload(baseDate='2026-08-04'),
            save_token=_token(2), expected_revision=1,
        )
        with self.assertRaises(RevisionConflictError) as ctx:
            self.store.save_workspace(
                document_id=DOC_A, title='stale', payload=_payload(baseDate='2026-08-05'),
                save_token=_token(3), expected_revision=1,
            )
        self.assertEqual(ctx.exception.current_revision, 2)
        loaded = self.store.load_workspace(DOC_A)
        self.assertEqual(loaded['revision'], 2)
        self.assertEqual(loaded['payload']['baseDate'], '2026-08-04')
        self.assertEqual(loaded['title'], 'v2')

    def test_create_conflict_when_document_exists(self):
        self._create_doc()
        with self.assertRaises(RevisionConflictError):
            self.store.save_workspace(
                document_id=DOC_A, title='again', payload=_payload(),
                save_token=_token(9),
            )

    def test_symbol_and_mode_derived_from_payload(self):
        self._create_doc(payload=_payload(
            underlyingSymbol='  gld ', marketDataMode='historical'
        ))
        doc = self.store.list_documents()[0]
        self.assertEqual(doc['symbol'], 'GLD')
        self.assertEqual(doc['marketDataMode'], 'historical')


class SaveTokenIdempotencyTest(PortfolioStoreTestBase):
    def test_sequential_retry_returns_original_result(self):
        first = self._create_doc()
        retry = self.store.save_workspace(
            document_id=DOC_A, title='SPY workspace', payload=_payload(),
            save_token=_token(1),
        )
        self.assertEqual(retry['revision'], first['revision'])
        self.assertTrue(retry['idempotentReplay'])
        self.assertEqual(len(self.store.list_revisions(DOC_A)), 1)

    def test_same_token_different_payload_rejected(self):
        self._create_doc()
        with self.assertRaises(DuplicateSaveTokenError):
            self.store.save_workspace(
                document_id=DOC_A, title='SPY workspace',
                payload=_payload(baseDate='2026-09-01'),
                save_token=_token(1), expected_revision=1,
            )
        self.assertEqual(len(self.store.list_revisions(DOC_A)), 1)

    def test_same_token_different_document_rejected(self):
        self._create_doc()
        with self.assertRaises(DuplicateSaveTokenError):
            self.store.save_workspace(
                document_id=DOC_B, title='other', payload=_payload(),
                save_token=_token(1),
            )


class ConcurrencyTest(PortfolioStoreTestBase):
    def _run_pair(self, call_a, call_b):
        barrier = threading.Barrier(2)
        results = {}

        def runner(key, call):
            barrier.wait()
            try:
                results[key] = ('ok', call())
            except Exception as exc:  # noqa: BLE001 - recorded for assertions
                results[key] = ('error', exc)

        threads = [
            threading.Thread(target=runner, args=('a', call_a)),
            threading.Thread(target=runner, args=('b', call_b)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual(len(results), 2)
        return results

    def test_concurrent_saves_from_same_revision(self):
        self._create_doc()
        results = self._run_pair(
            lambda: self.store.save_workspace(
                document_id=DOC_A, title='A', payload=_payload(baseDate='2026-08-04'),
                save_token=_token(11), expected_revision=1,
            ),
            lambda: self.store.save_workspace(
                document_id=DOC_A, title='B', payload=_payload(baseDate='2026-08-05'),
                save_token=_token(12), expected_revision=1,
            ),
        )
        statuses = sorted(status for status, _ in results.values())
        self.assertEqual(statuses, ['error', 'ok'])
        error = next(v for s, v in results.values() if s == 'error')
        self.assertIsInstance(error, RevisionConflictError)
        self.assertEqual(self.store.load_workspace(DOC_A)['revision'], 2)
        self.assertEqual(len(self.store.list_revisions(DOC_A)), 2)

    def test_concurrent_identical_save_token_yields_one_revision(self):
        self._create_doc()
        payload = _payload(baseDate='2026-08-04')
        call = lambda: self.store.save_workspace(  # noqa: E731
            document_id=DOC_A, title='same', payload=payload,
            save_token=_token(21), expected_revision=1,
        )
        results = self._run_pair(call, call)
        statuses = [status for status, _ in results.values()]
        self.assertEqual(statuses, ['ok', 'ok'])
        revisions = {value['revision'] for _, value in results.values()}
        self.assertEqual(revisions, {2})
        replays = sorted(value['idempotentReplay'] for _, value in results.values())
        self.assertEqual(replays, [False, True])
        self.assertEqual(len(self.store.list_revisions(DOC_A)), 2)

    def test_concurrent_same_token_different_payload(self):
        self._create_doc()
        results = self._run_pair(
            lambda: self.store.save_workspace(
                document_id=DOC_A, title='A', payload=_payload(baseDate='2026-08-04'),
                save_token=_token(31), expected_revision=1,
            ),
            lambda: self.store.save_workspace(
                document_id=DOC_A, title='B', payload=_payload(baseDate='2026-08-05'),
                save_token=_token(31), expected_revision=1,
            ),
        )
        statuses = sorted(status for status, _ in results.values())
        self.assertEqual(statuses, ['error', 'ok'])
        error = next(v for s, v in results.values() if s == 'error')
        self.assertIsInstance(error, DuplicateSaveTokenError)
        self.assertEqual(len(self.store.list_revisions(DOC_A)), 2)


class SoftDeleteAndRestoreTest(PortfolioStoreTestBase):
    def test_soft_delete_hides_but_keeps_revisions(self):
        self._create_doc()
        self.store.delete_document(DOC_A, expected_revision=1)
        self.assertEqual(self.store.list_documents(), [])
        deleted = self.store.list_documents(include_deleted=True)
        self.assertEqual(len(deleted), 1)
        self.assertIsNotNone(deleted[0]['deletedAtUtc'])
        with self.assertRaises(DocumentDeletedError):
            self.store.load_workspace(DOC_A)
        with self.assertRaises(DocumentDeletedError):
            self.store.save_workspace(
                document_id=DOC_A, title='x', payload=_payload(),
                save_token=_token(5), expected_revision=1,
            )
        self.assertEqual(len(self.store.list_revisions(DOC_A)), 1)

    def test_delete_requires_current_revision(self):
        self._create_doc()
        with self.assertRaises(RevisionConflictError):
            self.store.delete_document(DOC_A, expected_revision=7)
        self.assertEqual(len(self.store.list_documents()), 1)

    def test_restore_copies_old_payload_as_new_revision(self):
        self._create_doc(payload=_payload(baseDate='2026-08-01'))
        self.store.save_workspace(
            document_id=DOC_A, title='v2', payload=_payload(baseDate='2026-08-02'),
            save_token=_token(2), expected_revision=1,
        )
        restored = self.store.restore_revision(
            document_id=DOC_A, revision=1, save_token=_token(3), expected_revision=2,
        )
        self.assertEqual(restored['revision'], 3)
        loaded = self.store.load_workspace(DOC_A)
        self.assertEqual(loaded['payload']['baseDate'], '2026-08-01')
        revisions = self.store.list_revisions(DOC_A)
        self.assertEqual([r['revision'] for r in revisions], [3, 2, 1])
        # History is untouched: revision 2 still holds its own payload hash.
        sha_v2 = hashlib.sha256(
            canonicalize_payload(_payload(baseDate='2026-08-02'))
        ).hexdigest()
        self.assertEqual(revisions[1]['payloadSha256'], sha_v2)

    def test_restore_missing_revision(self):
        self._create_doc()
        with self.assertRaises(DocumentNotFoundError):
            self.store.restore_revision(
                document_id=DOC_A, revision=99, save_token=_token(4),
                expected_revision=1,
            )


class ValidationTest(PortfolioStoreTestBase):
    def _assert_rejected(self, exc_type, **kwargs):
        defaults = {
            'document_id': DOC_B,
            'title': 'valid title',
            'payload': _payload(),
            'save_token': _token(90),
        }
        defaults.update(kwargs)
        with self.assertRaises(exc_type):
            self.store.save_workspace(**defaults)
        self.assertEqual(
            [d['documentId'] for d in self.store.list_documents()], []
        )

    def test_rejects_non_object_payload(self):
        self._assert_rejected(InvalidPayloadError, payload=['not', 'an', 'object'])
        self._assert_rejected(InvalidPayloadError, payload='scalar')

    def test_rejects_non_finite_numbers(self):
        self._assert_rejected(
            InvalidPayloadError, payload=_payload(bad=float('nan'))
        )
        self._assert_rejected(
            InvalidPayloadError, payload=_payload(bad=float('inf'))
        )

    def test_rejects_oversized_payload_before_transaction(self):
        small_store = PortfolioStore(
            pathlib.Path(self._tmp.name) / 'small.db', max_payload_bytes=256,
        ).initialize()
        with self.assertRaises(PayloadTooLargeError):
            small_store.save_workspace(
                document_id=DOC_B, title='big', save_token=_token(91),
                payload=_payload(filler='x' * 512),
            )
        self.assertEqual(small_store.list_documents(), [])

    def test_rejects_bad_titles(self):
        self._assert_rejected(InvalidRequestError, title='')
        self._assert_rejected(InvalidRequestError, title='   ')
        self._assert_rejected(InvalidRequestError, title='x' * 121)

    def test_rejects_bad_tokens(self):
        self._assert_rejected(InvalidRequestError, document_id='short')
        self._assert_rejected(InvalidRequestError, document_id='has spaces here!')
        self._assert_rejected(InvalidRequestError, save_token='bad token')

    def test_rejects_wrong_collection_types(self):
        self._assert_rejected(
            InvalidPayloadError, payload=_payload(groups={'not': 'a list'})
        )

    def test_rejects_unknown_schema_version(self):
        bad = max(ACCEPTED_PAYLOAD_SCHEMA_VERSIONS) + 1
        self._assert_rejected(
            InvalidPayloadError, payload=_payload(sessionSchemaVersion=bad)
        )
        self._assert_rejected(
            InvalidPayloadError, payload=_payload(sessionSchemaVersion=True)
        )

    def test_rejects_excessive_nesting(self):
        nested = {'sessionSchemaVersion': 1}
        cursor = nested
        for _ in range(80):
            cursor['child'] = {}
            cursor = cursor['child']
        self._assert_rejected(InvalidPayloadError, payload=nested)

    def test_legacy_schema_version_zero_accepted(self):
        payload = _payload()
        del payload['sessionSchemaVersion']
        self._create_doc(payload=payload)
        self.assertEqual(
            self.store.load_workspace(DOC_A)['payloadSchemaVersion'], 0
        )


class RevisionListingAndPruneTest(PortfolioStoreTestBase):
    def _build_two_saves_per_day(self, days):
        """Revisions 1..2*days, two per UTC day starting 2026-08-01."""
        self.clock.current = datetime(2026, 8, 1, 9, 0, 0, tzinfo=timezone.utc)
        self._create_doc(token_n=100)
        revision = 1
        for _ in range(2 * days - 1):
            self.clock.advance(hours=12)
            revision += 1
            self.store.save_workspace(
                document_id=DOC_A, title='SPY workspace',
                payload=_payload(baseDate=f'rev-{revision}'),
                save_token=_token(100 + revision), expected_revision=revision - 1,
            )
        return revision

    def test_list_revisions_pagination(self):
        last = self._build_two_saves_per_day(days=3)
        self.assertEqual(last, 6)
        page1 = self.store.list_revisions(DOC_A, limit=4)
        self.assertEqual([r['revision'] for r in page1], [6, 5, 4, 3])
        page2 = self.store.list_revisions(
            DOC_A, limit=4, before_revision=page1[-1]['revision']
        )
        self.assertEqual([r['revision'] for r in page2], [2, 1])

    def test_prune_keeps_current_recent_and_daily(self):
        self._build_two_saves_per_day(days=6)  # revisions 1..12 on days 1..6
        deleted = self.store.prune_revisions(keep_recent=3, keep_daily_days=5)
        self.assertEqual(deleted, 4)
        remaining = [r['revision'] for r in self.store.list_revisions(DOC_A, limit=50)]
        # current+recent {12,11,10}; daily-last per remaining day {9,8,6,4,2}.
        self.assertEqual(remaining, [12, 11, 10, 9, 8, 6, 4, 2])
        self.assertEqual(self.store.load_workspace(DOC_A)['revision'], 12)

    def test_prune_drops_days_older_than_window(self):
        self._build_two_saves_per_day(days=6)
        deleted = self.store.prune_revisions(keep_recent=3, keep_daily_days=2)
        self.assertEqual(deleted, 7)
        remaining = [r['revision'] for r in self.store.list_revisions(DOC_A, limit=50)]
        self.assertEqual(remaining, [12, 11, 10, 9, 8])

    def test_incremental_vacuum_after_prune(self):
        self._build_two_saves_per_day(days=6)
        self.store.prune_revisions(keep_recent=1, keep_daily_days=0)
        self.store.incremental_vacuum(max_pages=64)
        self.assertEqual(self.store.quick_check(), 'ok')
        self.assertGreaterEqual(self.store.freelist_count(), 0)


class LongRunTest(PortfolioStoreTestBase):
    def test_hundred_save_restart_load_cycles_stay_consistent(self):
        """Phase-6 endurance: every save reopens the store (a restart), the
        revision chain stays dense, and quick_check stays ok throughout."""
        self._create_doc(payload=_payload(baseDate='day-1'))
        for i in range(2, 101):
            self.clock.advance(minutes=7)
            store = PortfolioStore(self.db_path, now=self.clock).initialize()
            result = store.save_workspace(
                document_id=DOC_A, title='SPY workspace',
                payload=_payload(baseDate=f'day-{i}'),
                save_token=_token(1000 + i), expected_revision=i - 1,
            )
            self.assertEqual(result['revision'], i)

        final = PortfolioStore(self.db_path).initialize()
        self.assertEqual(final.quick_check(), 'ok')
        loaded = final.load_workspace(DOC_A)
        self.assertEqual(loaded['revision'], 100)
        self.assertEqual(loaded['payload']['baseDate'], 'day-100')
        revisions = final.list_revisions(DOC_A, limit=200)
        self.assertEqual([r['revision'] for r in revisions], list(range(100, 0, -1)))

        # Retention + bounded vacuum after the marathon still verifies clean.
        final_with_clock = PortfolioStore(self.db_path, now=self.clock)
        deleted = final_with_clock.prune_revisions(keep_recent=10, keep_daily_days=0)
        self.assertGreater(deleted, 0)
        final_with_clock.incremental_vacuum(max_pages=1024)
        self.assertEqual(final_with_clock.quick_check(), 'ok')
        self.assertEqual(
            final_with_clock.load_workspace(DOC_A)['payload']['baseDate'], 'day-100'
        )


class FailureContainmentTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = pathlib.Path(self._tmp.name)

    def test_corrupt_file_is_reported_not_overwritten(self):
        corrupt = self.base / 'corrupt.db'
        garbage = b'this is definitely not a sqlite database file' * 8
        corrupt.write_bytes(garbage)
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(corrupt).initialize()
        self.assertEqual(corrupt.read_bytes(), garbage)

    @unittest.skipIf(os.geteuid() == 0, 'permission checks are void as root')
    def test_unwritable_directory_reports_unavailable(self):
        locked_dir = self.base / 'locked'
        locked_dir.mkdir()
        os.chmod(locked_dir, 0o500)
        self.addCleanup(os.chmod, locked_dir, 0o700)
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(locked_dir / 'sub' / 'portfolio.db').initialize()
        with self.assertRaises(StoreUnavailableError):
            PortfolioStore(locked_dir / 'portfolio.db').initialize()


class BackupTest(PortfolioStoreTestBase):
    def test_backup_passes_quick_check_and_reopens(self):
        self._create_doc()
        self.store.save_workspace(
            document_id=DOC_A, title='v2', payload=_payload(baseDate='2026-08-04'),
            save_token=_token(2), expected_revision=1,
        )
        dest = pathlib.Path(self._tmp.name) / 'backups' / 'portfolio-backup.db'
        self.store.backup_to(dest)
        restored = PortfolioStore(dest).initialize()
        loaded = restored.load_workspace(DOC_A)
        self.assertEqual(loaded['revision'], 2)
        self.assertEqual(loaded['payload']['baseDate'], '2026-08-04')
        self.assertEqual(
            loaded['payloadSha256'],
            self.store.load_workspace(DOC_A)['payloadSha256'],
        )


class PublishBackupTest(PortfolioStoreTestBase):
    def setUp(self):
        super().setUp()
        self.backup_dir = pathlib.Path(self._tmp.name) / 'synced-backups'

    def test_publish_creates_verified_timestamped_snapshot(self):
        from portfolio_store import restore_database

        self._create_doc()
        published = self.store.publish_backup(self.backup_dir)
        self.assertTrue(published.exists())
        self.assertRegex(
            published.name, r'^portfolio-\d{8}T\d{6}Z-schema1-[0-9a-f]{16}\.db$'
        )
        # No partials, no WAL/SHM ever land in the synced folder.
        leftovers = [p.name for p in self.backup_dir.iterdir() if p != published]
        self.assertEqual(leftovers, [])
        # The published file restores into a working database elsewhere.
        new_machine_db = pathlib.Path(self._tmp.name) / 'new-machine' / 'portfolio.db'
        restore_database(published, new_machine_db)
        restored = PortfolioStore(new_machine_db).initialize()
        self.assertEqual(
            restored.load_workspace(DOC_A)['payloadSha256'],
            self.store.load_workspace(DOC_A)['payloadSha256'],
        )

    def test_install_id_is_stable_and_scopes_retention(self):
        self._create_doc()
        install_id = self.store.ensure_install_id()
        self.assertEqual(PortfolioStore(self.db_path).ensure_install_id(), install_id)

        # A foreign machine's backups must never be pruned by this one.
        self.backup_dir.mkdir(parents=True)
        foreign = self.backup_dir / 'portfolio-20200101T000000Z-schema1-feedfacefeedface.db'
        foreign.write_bytes(b'foreign machine backup')

        for _ in range(20):
            self.clock.advance(days=1)
            self.store.publish_backup(self.backup_dir, keep_daily=3, keep_weekly=2)

        self.assertTrue(foreign.exists())
        own = [
            p.name for p in self.backup_dir.iterdir()
            if install_id in p.name
        ]
        # 3 dailies plus up to 2 older weekly anchors.
        self.assertLessEqual(len(own), 5)
        self.assertGreaterEqual(len(own), 3)
        newest_stamp = self.store.latest_own_backup_stamp(self.backup_dir)
        self.assertIsNotNone(newest_stamp)
        self.assertIn(newest_stamp, ''.join(own))

    def test_restore_refuses_partials_and_preserves_old_database(self):
        from portfolio_store import restore_database

        self._create_doc()
        published = self.store.publish_backup(self.backup_dir)
        partial = self.backup_dir / (published.name + '.partial')
        partial.write_bytes(b'half written')
        with self.assertRaises(StoreUnavailableError):
            restore_database(partial, pathlib.Path(self._tmp.name) / 'x.db')

        # Restoring over an existing database displaces it, never deletes it.
        target_dir = pathlib.Path(self._tmp.name) / 'existing'
        target_db = target_dir / 'portfolio.db'
        existing = PortfolioStore(target_db, now=self.clock).initialize()
        existing.save_workspace(
            document_id=DOC_B, title='existing book', payload=_payload(),
            save_token=_token(70),
        )
        result = restore_database(published, target_db)
        self.assertIsNotNone(result['displaced_to'])
        displaced = pathlib.Path(result['displaced_to'])
        self.assertTrue(displaced.exists())
        self.assertEqual(
            [d['documentId'] for d in PortfolioStore(target_db).initialize().list_documents()],
            [DOC_A],
        )
        self.assertEqual(
            [d['documentId'] for d in PortfolioStore(displaced).initialize().list_documents()],
            [DOC_B],
        )


class PathResolutionTest(unittest.TestCase):
    def test_env_override_wins(self):
        env = {'OPTION_COMBO_PORTFOLIO_DB_PATH': '/custom/spot/portfolio.db'}
        self.assertEqual(
            resolve_db_path(env=env), pathlib.Path('/custom/spot/portfolio.db')
        )

    def test_config_value_beats_platform_default(self):
        config = configparser.ConfigParser()
        config.read_string('[portfolio_store]\ndb_path = /from/config.db\n')
        self.assertEqual(
            resolve_db_path(config=config, env={}),
            pathlib.Path('/from/config.db'),
        )

    def test_blank_config_value_falls_through(self):
        config = configparser.ConfigParser()
        config.read_string('[portfolio_store]\ndb_path =\n')
        resolved = resolve_db_path(config=config, env={'HOME': '/home/u'},
                                   platform='linux')
        self.assertEqual(
            resolved,
            pathlib.Path('/home/u/.local/share/option-combo-simulator/portfolio.db'),
        )

    def test_platform_defaults(self):
        env = {'HOME': '/home/u'}
        self.assertEqual(
            default_app_data_dir(platform='darwin', env=env),
            pathlib.Path('/home/u/Library/Application Support/Option Combo Simulator'),
        )
        self.assertEqual(
            default_app_data_dir(
                platform='win32', env={'LOCALAPPDATA': 'C:/Users/u/AppData/Local'}
            ),
            pathlib.Path('C:/Users/u/AppData/Local/OptionComboSimulator'),
        )
        self.assertEqual(
            default_app_data_dir(
                platform='linux', env={'HOME': '/home/u', 'XDG_DATA_HOME': '/xdg'}
            ),
            pathlib.Path('/xdg/option-combo-simulator'),
        )


if __name__ == '__main__':
    unittest.main()
