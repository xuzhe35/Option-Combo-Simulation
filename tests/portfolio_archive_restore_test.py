"""Phase 6 tests: restoring archived payloads (plan section 13).

Every restore goes through the normal save path — optimistic concurrency,
canonical payload validation, and receipts all apply — and every archived
payload is hash/bytes/schema-verified against BOTH the shard row and the
main-DB index before it is trusted.
"""

import json
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_archive
from portfolio_store import PortfolioStore

from tests.portfolio_archive_commit_test import DOC_DELETED, run_full_job
from tests.portfolio_archive_test import (
    DOC_A,
    make_archive_env,
    make_plan,
)


class RestoreTestBase(unittest.TestCase):
    """Fixture: a full archive job has already moved 6 old revisions of
    DOC_A and the whole soft-deleted document into a verified shard."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.env = make_archive_env(self.tmpdir)
        self.store = self.env['store']
        self.db_path = pathlib.Path(self.store.db_path)
        self.archive_dir = self.db_path.parent / 'archives'
        self.summary = run_full_job(self.env, make_plan(self.env))

    def _archived_payload(self, document_id, revision):
        shard_path = self.archive_dir / f"{self.summary['archiveId']}.db"
        conn = sqlite3.connect(shard_path)
        try:
            return conn.execute(
                'SELECT payload_json FROM archived_revisions '
                'WHERE document_id = ? AND revision = ?',
                (document_id, revision),
            ).fetchone()[0]
        finally:
            conn.close()


class RestoreRevisionTest(RestoreTestBase):
    def test_restores_as_new_head_without_rewriting_history(self):
        before_meta = self.store.load_workspace(DOC_A)
        self.assertEqual(before_meta['revision'], 8)

        result = portfolio_archive.restore_archived_revision(
            self.env, document_id=DOC_A, revision=3,
        )
        self.assertEqual(result['mode'], 'revision')
        self.assertEqual(result['restoredRevision'], 9)  # new head only

        loaded = self.store.load_workspace(DOC_A)
        self.assertEqual(loaded['revision'], 9)
        # Canonical payload equality through the NORMAL load path.
        archived = json.loads(self._archived_payload(DOC_A, 3))
        self.assertEqual(loaded['payload'], archived)
        # Kept revisions 7 and 8 are untouched; no revision was rewritten.
        revisions = {
            r['revision'] for r in self.store.list_revisions(DOC_A, limit=50)
        }
        self.assertEqual(revisions, {7, 8, 9})

        # Receipts stay unique across the restore.
        conn = sqlite3.connect(self.db_path)
        try:
            duplicates = conn.execute(
                'SELECT count(*) FROM (SELECT save_token, count(*) c '
                'FROM workspace_save_receipts GROUP BY 1 HAVING c > 1)'
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(duplicates, 0)

    def test_stale_expected_revision_conflicts_without_changes(self):
        stale_meta = dict(self.store.load_workspace(DOC_A))
        stale_meta['revision'] = 5  # pretend we saw an old head
        with mock.patch.object(
            PortfolioStore, 'load_workspace', return_value=stale_meta,
        ):
            with self.assertRaises(portfolio_archive.RestoreConflictError):
                portfolio_archive.restore_archived_revision(
                    self.env, document_id=DOC_A, revision=3,
                )
        self.assertEqual(self.store.load_workspace(DOC_A)['revision'], 8)

    def test_tampered_shard_payload_refuses_restore(self):
        shard_path = self.archive_dir / f"{self.summary['archiveId']}.db"
        conn = sqlite3.connect(shard_path)
        try:
            conn.execute(
                'UPDATE archived_revisions SET payload_json = ? '
                'WHERE document_id = ? AND revision = 3',
                ('{"tampered":true}', DOC_A),
            )
            conn.commit()
        finally:
            conn.close()
        with self.assertRaises(portfolio_archive.ArchiveVerificationError):
            portfolio_archive.restore_archived_revision(
                self.env, document_id=DOC_A, revision=3,
            )
        self.assertEqual(self.store.load_workspace(DOC_A)['revision'], 8)

    def test_unknown_entry_and_missing_shard_fail_closed(self):
        with self.assertRaises(portfolio_archive.ArchiveNotFoundError):
            portfolio_archive.restore_archived_revision(
                self.env, document_id=DOC_A, revision=99,
            )
        shard_path = self.archive_dir / f"{self.summary['archiveId']}.db"
        moved = shard_path.with_suffix('.db.away')
        shard_path.rename(moved)
        try:
            with self.assertRaises(portfolio_archive.ArchiveNotFoundError):
                portfolio_archive.restore_archived_revision(
                    self.env, document_id=DOC_A, revision=3,
                )
        finally:
            moved.rename(shard_path)


class RestoreAsCopyTest(RestoreTestBase):
    def test_copy_creates_new_document_and_keeps_tombstone(self):
        docs_before = {
            meta['documentId']
            for meta in self.store.list_documents(include_deleted=True)
        }
        result = portfolio_archive.restore_archived_document_as_copy(
            self.env, document_id=DOC_DELETED,
        )
        self.assertEqual(result['mode'], 'copy')
        new_id = result['newDocumentId']
        self.assertNotEqual(new_id, DOC_DELETED)
        self.assertNotIn(new_id, docs_before)
        self.assertEqual(result['restoredRevision'], 1)
        self.assertTrue(result['title'].endswith(' (restored)'))

        # The copy loads canonically identical to the archived payload.
        loaded = self.store.load_workspace(new_id)
        archived = json.loads(self._archived_payload(DOC_DELETED, 2))
        self.assertEqual(loaded['payload'], archived)

        # Existing documents were not overwritten; the tombstone remains,
        # so the original identity stays reserved.
        self.assertEqual(
            docs_before | {new_id},
            {meta['documentId']
             for meta in self.store.list_documents(include_deleted=True)},
        )
        self.assertIsNotNone(self.store.get_archive_tombstone(DOC_DELETED))

    def test_copy_without_tombstone_fails_closed(self):
        with self.assertRaises(portfolio_archive.ArchiveNotFoundError):
            portfolio_archive.restore_archived_document_as_copy(
                self.env, document_id=DOC_A,  # live, never tombstoned
            )

    def test_restore_from_reinstalled_shard_backup(self):
        """Disaster drill: the shard is lost, its static backup copy is
        reinstalled, and restores keep working."""
        shard_path = self.archive_dir / f"{self.summary['archiveId']}.db"
        backup_copy = pathlib.Path(self.tmpdir) / 'shard-static-backup.db'
        shutil.copyfile(shard_path, backup_copy)
        shard_path.unlink()
        pathlib.Path(str(shard_path) + '-wal').unlink(missing_ok=True)
        pathlib.Path(str(shard_path) + '-shm').unlink(missing_ok=True)

        with self.assertRaises(portfolio_archive.ArchiveNotFoundError):
            portfolio_archive.restore_archived_document_as_copy(
                self.env, document_id=DOC_DELETED,
            )

        shutil.copyfile(backup_copy, shard_path)
        result = portfolio_archive.restore_archived_document_as_copy(
            self.env, document_id=DOC_DELETED,
        )
        self.assertEqual(result['restoredRevision'], 1)


if __name__ == '__main__':
    unittest.main()
