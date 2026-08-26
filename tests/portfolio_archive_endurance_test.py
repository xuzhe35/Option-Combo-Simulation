"""Phase 7 tests: endurance, cross-process mutual exclusion over the real
code path, the integrated disaster-recovery drill, and the guarded opt-in
auto-archive (CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md).
"""

import concurrent.futures
import configparser
import json
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_archive
import portfolio_maintenance
import portfolio_store_ws
from portfolio_store import PortfolioStore, StoreUnavailableError, restore_database

NOW = datetime(2026, 8, 16, 12, 0, 0, tzinfo=timezone.utc)


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


def _canonical(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'))


def _bulk_fixture(db_path, *, documents=1000, revisions_per_doc=10, now=NOW):
    """1,000 documents x 10 revisions inserted via raw SQL for speed. Every
    row gets a correct sha/bytes and a receipt, exactly as the store would
    have written them; timestamps land 120..320 days in the past so most
    non-current revisions are archive candidates."""
    import hashlib
    store = PortfolioStore(db_path, now=lambda: now).initialize()
    conn = sqlite3.connect(db_path, isolation_level=None)
    try:
        conn.execute('BEGIN IMMEDIATE')
        doc_rows, rev_rows, receipt_rows = [], [], []
        for d in range(documents):
            doc_id = f'doc-{d:08d}-1111-4111-8111-111111111111'
            base_day = now - timedelta(days=320 - (d % 200))
            for r in range(1, revisions_per_doc + 1):
                payload = {'sessionSchemaVersion': 1,
                           'underlyingSymbol': 'SPY',
                           'marketDataMode': 'live',
                           'groups': [], 'hedges': [],
                           'note': f'第{d}号文档 rev {r}'}
                text = _canonical(payload)
                sha = hashlib.sha256(text.encode('utf-8')).hexdigest()
                size = len(text.encode('utf-8'))
                saved = (base_day + timedelta(days=r)).isoformat(
                    timespec='milliseconds').replace('+00:00', 'Z')
                token = f'save-{d:06d}{r:02d}-4000-8000-000000000000'
                rev_rows.append((doc_id, r, token, 1, sha, text, saved, size))
                receipt_rows.append((
                    token, doc_id, r, sha, size, saved, None,
                    _canonical({'documentId': doc_id, 'revision': r,
                                'title': f'doc {d}', 'symbol': 'SPY',
                                'marketDataMode': 'live',
                                'updatedAtUtc': saved, 'payloadSha256': sha,
                                'payloadBytes': size}),
                ))
            doc_rows.append((doc_id, f'doc {d}', 'SPY', 'live',
                             revisions_per_doc,
                             rev_rows[-revisions_per_doc][6],
                             rev_rows[-1][6], None))
        conn.executemany(
            'INSERT INTO workspace_documents (document_id, title, symbol, '
            'market_data_mode, current_revision, created_at_utc, '
            'updated_at_utc, deleted_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            doc_rows,
        )
        conn.executemany(
            'INSERT INTO workspace_revisions (document_id, revision, '
            'save_token, payload_schema_version, payload_sha256, '
            'payload_json, saved_at_utc, payload_bytes) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            rev_rows,
        )
        conn.executemany(
            'INSERT INTO workspace_save_receipts (save_token, document_id, '
            'revision, payload_sha256, payload_bytes, saved_at_utc, '
            'operation, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            receipt_rows,
        )
        conn.execute('COMMIT')
    finally:
        conn.close()
    return store


def _make_env(tmpdir, *, now=NOW, **config_overrides):
    env = portfolio_store_ws.create_store_env(
        _config(tmpdir, **config_overrides)
    )
    db_path = pathlib.Path(tmpdir) / 'portfolio.db'
    env['store'] = PortfolioStore(db_path, now=lambda: now)
    env['store'].initialize()
    env['available'] = True
    env['_initialized'] = True
    return env


ENDURANCE_POLICY = {
    'revisionKeepRecent': 2,
    'revisionKeepDailyDays': 0,
    'archiveDeletedAfterDays': 30,
}


def _plan(env, policy=ENDURANCE_POLICY):
    store = env['store']
    preview = portfolio_archive.build_archive_preview(
        store, policy=dict(policy)
    )
    preview['fingerprint'] = portfolio_archive.compute_generation_fingerprint(
        preview, install_id=store.ensure_install_id(),
        created_at_utc='2026-08-16T00:00:00.000Z', nonce='endurance',
    )
    return preview


def _run(env, plan):
    store = env['store']
    job = store.create_maintenance_job(
        job_type='archive_copy',
        owner_instance_id=env.get('_server_instance_id'),
    )
    guard = portfolio_maintenance.acquire_maintenance(env)
    assert guard is not None
    try:
        store.start_maintenance_job(job['jobId'],
                                    fencing_token=guard.fencing_token)
        summary = portfolio_archive.run_archive_job(
            env, guard, job['jobId'], plan
        )
        store.finish_maintenance_job(job['jobId'], status='completed',
                                     summary=summary)
        return summary
    finally:
        guard.release()


class EnduranceTest(unittest.TestCase):
    """1,000 documents / 10,000 revisions through the full pipeline with
    small batch caps: 100+ batches in one run, concurrent saves during the
    job, convergence, and integrity."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.db_path = pathlib.Path(self.tmpdir) / 'portfolio.db'
        _bulk_fixture(self.db_path)
        self.env = _make_env(self.tmpdir)
        self.env['_archive_max_rows_per_batch'] = 80   # force 100+ batches
        self.env['_archive_commit_max_rows'] = 200     # keep commits fast
        self.store = self.env['store']

    def test_bulk_archive_with_concurrent_saves_converges(self):
        plan = _plan(self.env)
        # keep_recent=2 keeps revisions {9, 10} per doc: 8,000 candidates.
        self.assertEqual(plan['totals']['revisionCount'], 8000)

        # Concurrent load: three writers save fresh revisions to their own
        # documents while the archive job runs. They start only after the
        # job's execution-time revalidation — a save BEFORE that point
        # correctly turns the whole plan stale (tested elsewhere); here we
        # exercise the in-flight concurrency path (skip, never force).
        import threading
        revalidated = threading.Event()
        original_preview = portfolio_archive.build_archive_preview

        def signaling_preview(store, *, policy, now=None):
            result = original_preview(store, policy=policy, now=now)
            revalidated.set()
            return result

        stop = {'flag': False}
        latencies = []

        def _writer(writer_id):
            revalidated.wait(timeout=30)
            doc = f'doc-{writer_id:08d}-1111-4111-8111-111111111111'
            revision = 10
            n = 0
            while not stop['flag'] and n < 200:
                n += 1
                started = time.monotonic()
                result = self.store.save_workspace(
                    document_id=doc, title=f'doc {writer_id}',
                    payload={'sessionSchemaVersion': 1,
                             'underlyingSymbol': 'SPY',
                             'marketDataMode': 'live', 'groups': [],
                             'hedges': [], 'note': f'live save {n}'},
                    save_token=f'save-live{writer_id:02d}{n:04d}'
                               '-4000-8000-000000000000',
                    expected_revision=revision,
                )
                latencies.append(time.monotonic() - started)
                revision = result['revision']
            return n

        with mock.patch.object(
            portfolio_archive, 'build_archive_preview', signaling_preview,
        ):
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                writers = [
                    pool.submit(_writer, wid) for wid in (990, 991, 992)
                ]
                try:
                    summary = _run(self.env, plan)
                finally:
                    stop['flag'] = True
                saves = sum(future.result() for future in writers)

        self.assertGreater(saves, 0)
        # Saves stayed inside the 5s busy timeout with plenty of margin.
        self.assertLess(max(latencies), 5.0)

        # The three written-to documents changed after preview: their
        # candidates are skipped, everything else commits. 100+ batches,
        # no duplicates, no orphans, receipts intact.
        self.assertGreaterEqual(len(summary['batchIds']), 100)
        conn = sqlite3.connect(self.db_path)
        try:
            receipts = conn.execute(
                'SELECT count(*) FROM workspace_save_receipts'
            ).fetchone()[0]
            active_jobs = conn.execute(
                'SELECT count(*) FROM workspace_maintenance_jobs '
                "WHERE status IN ('queued', 'running')"
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertGreaterEqual(receipts, 10_000 + saves)
        self.assertEqual(active_jobs, 0)  # no orphan / unconverged jobs

        shard_path = next(
            (self.db_path.parent / 'archives').glob('*.db')
        )
        conn = sqlite3.connect(shard_path)
        try:
            duplicates = conn.execute(
                'SELECT count(*) FROM (SELECT document_id, revision, '
                'count(*) c FROM archived_revisions GROUP BY 1, 2 '
                'HAVING c > 1)'
            ).fetchone()[0]
            unconverged = conn.execute(
                'SELECT count(*) FROM archive_batches '
                "WHERE status NOT IN ('main_committed', 'failed', 'canceled')"
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(duplicates, 0)
        self.assertEqual(unconverged, 0)

        # A second pass over the (now current) state converges to zero
        # remaining candidates from the original fixture set.
        second = _plan(self.env)
        for row in second['manifest']['oldRevisions']:
            # Only the concurrently-written documents may contribute new
            # candidates; nothing from the archived set reappears.
            self.assertIn(int(row['documentId'][4:12]), (990, 991, 992))

        # Integrity: active and shard both verify clean.
        self.assertEqual(self.store.quick_check(), 'ok')
        portfolio_archive.ArchiveShard(shard_path).quick_check()

    def test_fast_overview_budget_holds_after_archive(self):
        _run(self.env, _plan(self.env))
        started = time.monotonic()
        stats = self.store.storage_stats()
        self.store.retention_snapshot()
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.0)
        self.assertGreater(stats['revisionCount'], 0)


_WORKER_SCRIPT = textwrap.dedent('''
    import configparser, pathlib, sys, time
    repo, db_path, log_path = sys.argv[1], sys.argv[2], sys.argv[3]
    sys.path.insert(0, repo)
    import portfolio_maintenance, portfolio_store_ws
    config = configparser.ConfigParser()
    config.read_string(
        "[portfolio_store]\\ndb_path = " + db_path
        + "\\nbackup_interval_hours = 0\\n"
    )
    env = portfolio_store_ws.create_store_env(config)
    portfolio_store_ws.ensure_store_initialized(env)
    log = open(log_path, "a")
    acquired = 0
    deadline = time.monotonic() + 12
    while acquired < 8 and time.monotonic() < deadline:
        guard = portfolio_maintenance.acquire_maintenance(env)
        if guard is None:
            time.sleep(0.002)
            continue
        start = time.time()
        time.sleep(0.02)  # hold the guard while "working"
        end = time.time()
        guard.release()
        log.write(f"{start:.6f} {end:.6f}\\n")
        log.flush()
        acquired += 1
    log.close()
''')


class DualProcessMutualExclusionTest(unittest.TestCase):
    """Two REAL processes run the production guard path (thread lock -> OS
    flock -> DB lease) against one database; their held intervals must
    never overlap."""

    def test_guard_held_intervals_never_overlap(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(pathlib.Path(tmp) / 'portfolio.db')
            env = _make_env(tmp)
            del env  # DB initialized; workers open it themselves
            script = pathlib.Path(tmp) / 'worker.py'
            script.write_text(_WORKER_SCRIPT, encoding='utf-8')
            log_path = pathlib.Path(tmp) / 'intervals.log'
            workers = [
                subprocess.Popen(
                    [sys.executable, str(script), str(REPO_ROOT), db_path,
                     str(log_path)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                )
                for _ in range(2)
            ]
            for worker in workers:
                _, stderr = worker.communicate(timeout=30)
                self.assertEqual(worker.returncode, 0, stderr.decode())

            intervals = sorted(
                tuple(map(float, line.split()))
                for line in log_path.read_text().splitlines()
            )
            self.assertGreaterEqual(len(intervals), 16)
            for (_, prev_end), (next_start, _) in zip(intervals,
                                                      intervals[1:]):
                self.assertLessEqual(
                    prev_end, next_start,
                    'two processes held the maintenance guard at once',
                )


class DisasterRecoveryDrillTest(unittest.TestCase):
    """Full drill: archive, publish a static snapshot into a synced folder,
    then rebuild on a 'clean machine' directory — active documents open,
    archived history is searchable, and restore still works."""

    def test_backup_to_clean_machine_and_restore_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            from tests.portfolio_archive_test import (
                make_archive_env, make_plan,
            )
            from tests.portfolio_archive_commit_test import (
                DOC_DELETED, run_full_job,
            )
            env = make_archive_env(tmp)
            store = env['store']
            run_full_job(env, make_plan(env))

            # Publish the static snapshots into the "OneDrive" folder: the
            # active database AND every archive shard, through the real
            # publish flow (backup API + verify + atomic rename) — a main
            # backup alone would point at shards a dead disk no longer has.
            synced_dir = pathlib.Path(tmp) / 'synced'
            guard = portfolio_maintenance.acquire_maintenance(env)
            self.assertIsNotNone(guard)
            try:
                outcome = portfolio_archive.publish_recovery_generation(
                    env, synced_dir
                )
            finally:
                guard.release()
            published = outcome['mainPath']
            shard_entries = outcome['shards']
            self.assertTrue(outcome['complete'])
            self.assertEqual(outcome['missingShards'], [])
            self.assertEqual(len(shard_entries), 1)
            install_id = store.ensure_install_id()
            suffix = f'-{install_id}@{outcome["generationId"]}.db'
            self.assertTrue(shard_entries[0]['name'].endswith(suffix))
            # Immutable generations never overwrite even on an accidental
            # same-id retry.
            with mock.patch.object(
                portfolio_archive, 'new_recovery_generation_id',
                return_value=outcome['generationId'],
            ):
                guard = portfolio_maintenance.acquire_maintenance(env)
                self.assertIsNotNone(guard)
                try:
                    with self.assertRaises(StoreUnavailableError):
                        portfolio_archive.publish_recovery_generation(
                            env, synced_dir
                        )
                finally:
                    guard.release()
            # Purity, recursively: only completed databases and the atomic
            # completion manifest land in sync — never WAL/SHM/partials.
            leftovers = [
                p.name for p in synced_dir.rglob('*')
                if (p.is_file() and not p.name.endswith('.db')
                    and not (p.name.startswith('recovery-manifest-')
                             and p.name.endswith('.json')))
            ]
            self.assertEqual(leftovers, [])

            # "Clean machine": restore the active DB from the snapshot and
            # reinstall the shards from their published static backups.
            machine = pathlib.Path(tmp) / 'clean-machine'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            restore_database(published, new_db)
            (machine / 'archives').mkdir()
            for entry in shard_entries:
                shutil.copyfile(
                    synced_dir / 'archives' / entry['name'],
                    machine / 'archives' / f'{entry["archiveId"]}.db',
                )

            new_env = portfolio_store_ws.create_store_env(
                _config(str(machine))
            )
            new_env['store'] = PortfolioStore(new_db, now=lambda: NOW)
            new_env['store'].initialize()
            new_env['available'] = True
            new_env['_initialized'] = True
            new_store = new_env['store']

            # Active documents open; archived history is searchable.
            self.assertEqual(
                new_store.load_workspace(
                    'doc-aaaaaaaa-1111-4111-8111-111111111111'
                )['revision'], 8,
            )
            summary = new_store.list_archived_documents_summary()
            archived_ids = {
                doc['documentId'] for doc in summary['documents']
            }
            self.assertIn(DOC_DELETED, archived_ids)

            # And the archived document restores on the new machine.
            result = portfolio_archive.restore_archived_document_as_copy(
                new_env, document_id=DOC_DELETED,
            )
            self.assertEqual(result['restoredRevision'], 1)


class ManualBackupRestoreCliTest(unittest.TestCase):
    """Review 09c0370 P1-2: the documented manual CLIs must produce and
    consume a COMPLETE recovery set (main DB + shards) under the guard —
    these tests drive the real entry points, not internal helpers."""

    @staticmethod
    def _cli_modules():
        scripts_dir = REPO_ROOT / 'scripts'
        if str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
        import backup_portfolio_store
        import restore_portfolio_store
        return backup_portfolio_store, restore_portfolio_store

    def test_cli_backup_and_restore_full_recovery_set(self):
        backup_cli, restore_cli = self._cli_modules()
        from tests.portfolio_archive_test import make_archive_env, make_plan
        from tests.portfolio_archive_commit_test import (
            DOC_DELETED, run_full_job,
        )
        with tempfile.TemporaryDirectory() as tmp:
            env = make_archive_env(tmp)
            run_full_job(env, make_plan(env))
            db_path = str(env['store'].db_path)
            synced = pathlib.Path(tmp) / 'synced'

            rc = backup_cli.main(
                ['--db-path', db_path, '--backup-dir', str(synced)]
            )
            self.assertEqual(rc, 0)
            main_backups = sorted(synced.glob('portfolio-*.db'))
            shard_backups = sorted((synced / 'archives').glob('*.db'))
            self.assertEqual(len(main_backups), 1)
            self.assertEqual(len(shard_backups), 1)

            machine = pathlib.Path(tmp) / 'machine'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            rc = restore_cli.main(
                [str(main_backups[0]), '--yes', '--db-path', str(new_db)]
            )
            self.assertEqual(rc, 0)
            # Active documents open AND archived payloads restore: the CLI
            # installed the shard set, not just the main database.
            new_env = portfolio_store_ws.create_store_env(
                _config(str(machine))
            )
            new_env['store'] = PortfolioStore(new_db, now=lambda: NOW)
            new_env['store'].initialize()
            new_env['available'] = True
            new_env['_initialized'] = True
            self.assertEqual(
                new_env['store'].load_workspace(
                    'doc-aaaaaaaa-1111-4111-8111-111111111111'
                )['revision'], 8,
            )
            result = portfolio_archive.restore_archived_document_as_copy(
                new_env, document_id=DOC_DELETED,
            )
            self.assertEqual(result['restoredRevision'], 1)

    def test_cli_restore_fails_closed_without_shard_snapshots(self):
        backup_cli, restore_cli = self._cli_modules()
        from tests.portfolio_archive_test import make_archive_env, make_plan
        from tests.portfolio_archive_commit_test import run_full_job
        with tempfile.TemporaryDirectory() as tmp:
            env = make_archive_env(tmp)
            run_full_job(env, make_plan(env))
            synced = pathlib.Path(tmp) / 'synced'
            rc = backup_cli.main([
                '--db-path', str(env['store'].db_path),
                '--backup-dir', str(synced),
            ])
            self.assertEqual(rc, 0)
            for snapshot in (synced / 'archives').glob('*.db'):
                snapshot.unlink()

            machine = pathlib.Path(tmp) / 'machine'
            machine.mkdir()
            new_db = machine / 'portfolio.db'
            rc = restore_cli.main([
                str(next(synced.glob('portfolio-*.db'))), '--yes',
                '--db-path', str(new_db),
            ])
            self.assertEqual(rc, 1)  # refuse: entries would point nowhere
            self.assertFalse(new_db.exists())  # nothing was installed

    def test_cli_backup_reports_busy_while_guard_is_held(self):
        backup_cli, _ = self._cli_modules()
        from tests.portfolio_archive_test import make_archive_env
        with tempfile.TemporaryDirectory() as tmp:
            env = make_archive_env(tmp)
            guard = portfolio_maintenance.acquire_maintenance(env)
            self.assertIsNotNone(guard)
            try:
                rc = backup_cli.main([
                    '--db-path', str(env['store'].db_path),
                    '--backup-dir', str(pathlib.Path(tmp) / 'synced'),
                ])
            finally:
                guard.release()
            self.assertEqual(rc, 1)  # maintenance busy, never a race


class AutoArchiveGuardTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        from tests.portfolio_archive_test import make_archive_env
        self.env = make_archive_env(self.tmpdir)
        self.env['_revision_keep_recent'] = 2
        self.env['_revision_keep_daily_days'] = 0
        self.store = self.env['store']

    def _auto(self, now_monotonic=1000.0):
        guard = portfolio_maintenance.acquire_maintenance(self.env)
        self.assertIsNotNone(guard)
        try:
            return portfolio_archive.run_auto_archive(
                self.env, guard, now_monotonic=now_monotonic,
            )
        finally:
            guard.release()

    def test_off_by_default_archives_nothing(self):
        outcome = self._auto()
        self.assertEqual(outcome, {'ran': False, 'reason': 'auto_run_off'})
        self.assertEqual(
            list((pathlib.Path(self.store.db_path).parent
                  / 'archives').glob('*.db')) if (
                pathlib.Path(self.store.db_path).parent / 'archives'
            ).exists() else [],
            [],
        )

    def test_opt_in_archives_and_second_pass_noops(self):
        self.env['_archive_auto_run'] = True
        outcome = self._auto()
        self.assertTrue(outcome['ran'])
        self.assertGreater(outcome['removed'], 0)
        job = self.store.get_maintenance_job(outcome['jobId'])
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['jobType'], 'archive_auto')
        second = self._auto()
        self.assertEqual(second['reason'], 'no_candidates')

    def test_failure_backs_off_and_low_disk_refuses(self):
        self.env['_archive_auto_run'] = True
        fake_usage = mock.Mock(return_value=mock.Mock(free=1024))
        with mock.patch.object(portfolio_archive, '_disk_usage', fake_usage):
            outcome = self._auto(now_monotonic=1000.0)
        self.assertEqual(outcome['reason'], 'failed')
        self.assertEqual(outcome['errorCode'], 'insufficient_disk_space')
        # Backoff: the very next pass refuses to try again…
        backoff = self._auto(now_monotonic=1001.0)
        self.assertEqual(backoff['reason'], 'backoff')
        # …until the backoff window has elapsed.
        later = self._auto(
            now_monotonic=1000.0
            + portfolio_archive.AUTO_ARCHIVE_FAILURE_BACKOFF_SECONDS + 1
        )
        self.assertTrue(later['ran'])


if __name__ == '__main__':
    unittest.main()
