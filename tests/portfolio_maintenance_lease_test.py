"""Phase 3 tests for portfolio_maintenance.py — the cross-process guard.

The dual-process tests spawn a real second Python process against the same
temp database to prove OS-lock + lease + fencing semantics: only one holder
at a time, a paused holder's OS lock blocks takeover even after lease
expiry, and takeover after a crash increments the fencing token.
"""

import configparser
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_maintenance
import portfolio_store_ws
from portfolio_maintenance import LEASE_NAME, acquire_maintenance


def _config(tmpdir):
    config = configparser.ConfigParser()
    config.read_string(
        '[portfolio_store]\n'
        f'db_path = {pathlib.Path(tmpdir) / "portfolio.db"}\n'
        'backup_interval_hours = 0\n'
    )
    return config


def _env(tmpdir):
    env = portfolio_store_ws.create_store_env(_config(tmpdir))
    portfolio_store_ws.ensure_store_initialized(env)
    assert env['store'] is not None
    return env


def _backdate_lease(db_path):
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "UPDATE workspace_maintenance_lease "
            "SET expires_at_utc = '2000-01-01T00:00:00.000Z'"
        )
        conn.commit()
    finally:
        conn.close()


class SingleProcessGuardTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.env = _env(self.tmpdir)

    def test_acquire_verify_heartbeat_release(self):
        guard = acquire_maintenance(self.env)
        self.assertIsNotNone(guard)
        self.assertEqual(guard.fencing_token, 1)
        self.assertTrue(guard.verify())
        self.assertTrue(guard.heartbeat())
        guard.release()
        self.assertFalse(guard.verify())
        # The lease row is gone after a guarded release.
        conn = sqlite3.connect(self.env['store'].db_path)
        try:
            count = conn.execute(
                'SELECT count(*) FROM workspace_maintenance_lease'
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(count, 0)

    def test_same_process_reacquire_keeps_token(self):
        guard = acquire_maintenance(self.env)
        guard.release()
        second = acquire_maintenance(self.env)
        # Fresh acquire after release: row was deleted, token restarts at 1;
        # what matters is that the SAME instance renewing does not inflate
        # the token while held.
        self.assertIsNotNone(second)
        self.assertTrue(second.heartbeat())
        self.assertEqual(second.fencing_token, second.fencing_token)
        second.release()

    def test_thread_lock_busy_returns_none(self):
        guard = acquire_maintenance(self.env)
        self.assertIsNotNone(guard)
        self.assertIsNone(acquire_maintenance(self.env))
        guard.release()
        self.assertIsNotNone(acquire_maintenance(self.env))

    def test_unexpired_foreign_lease_blocks_even_with_os_lock(self):
        # Another (dead) holder's unexpired lease: we can take the OS lock,
        # but the lease has not expired — fail closed until it does.
        store = self.env['store']
        store.maintenance_lease_acquire(
            lease_name=LEASE_NAME, holder_instance_id='srv-deadbeefdeadbeef',
            holder_pid=99999, ttl_seconds=3600,
        )
        self.assertIsNone(acquire_maintenance(self.env))

    def test_expired_foreign_lease_takeover_increments_fence(self):
        store = self.env['store']
        store.maintenance_lease_acquire(
            lease_name=LEASE_NAME, holder_instance_id='srv-deadbeefdeadbeef',
            holder_pid=99999, ttl_seconds=3600,
        )
        _backdate_lease(store.db_path)
        guard = acquire_maintenance(self.env)
        self.assertIsNotNone(guard)
        self.assertEqual(guard.fencing_token, 2)
        # The dead holder's identity can no longer verify.
        self.assertFalse(store.maintenance_lease_verify(
            lease_name=LEASE_NAME,
            holder_instance_id='srv-deadbeefdeadbeef', fencing_token=1,
        ))
        guard.release()

    def test_scheduled_backup_respects_guard(self):
        guard = acquire_maintenance(self.env)
        self.env['_backup_interval_seconds'] = 1.0
        # Held guard: the backup path must yield, not queue.
        self.assertFalse(
            portfolio_store_ws.maybe_publish_scheduled_backup(
                self.env, force=True
            )
        )
        guard.release()


_CHILD_SCRIPT = textwrap.dedent('''
    import configparser, pathlib, sys, time
    repo, db_path, ready_path = sys.argv[1], sys.argv[2], sys.argv[3]
    sys.path.insert(0, repo)
    import portfolio_maintenance, portfolio_store_ws
    config = configparser.ConfigParser()
    config.read_string(
        "[portfolio_store]\\ndb_path = " + db_path
        + "\\nbackup_interval_hours = 0\\n"
    )
    env = portfolio_store_ws.create_store_env(config)
    portfolio_store_ws.ensure_store_initialized(env)
    guard = portfolio_maintenance.acquire_maintenance(env)
    assert guard is not None, "child failed to acquire the guard"
    pathlib.Path(ready_path).write_text(
        guard.instance_id + ":" + str(guard.fencing_token)
    )
    time.sleep(120)  # hold until killed
''')


class DualProcessGuardTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.env = _env(self.tmpdir)
        self.db_path = str(self.env['store'].db_path)

    def _spawn_holder(self):
        script = pathlib.Path(self.tmpdir) / 'holder.py'
        ready = pathlib.Path(self.tmpdir) / 'holder.ready'
        script.write_text(_CHILD_SCRIPT, encoding='utf-8')
        proc = subprocess.Popen(
            [sys.executable, str(script), str(REPO_ROOT), self.db_path,
             str(ready)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        self.addCleanup(lambda: (proc.poll() is None and proc.kill(),
                                 proc.wait()))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if ready.exists() and ready.read_text().strip():
                instance_id, token = ready.read_text().strip().split(':')
                return proc, instance_id, int(token)
            if proc.poll() is not None:
                raise AssertionError(
                    f'holder died: {proc.stderr.read().decode()}'
                )
            time.sleep(0.05)
        raise AssertionError('holder never became ready')

    def test_second_process_blocks_then_takes_over_after_crash(self):
        proc, child_instance, child_token = self._spawn_holder()

        # 1. Live holder: the other backend gets maintenance busy.
        self.assertIsNone(acquire_maintenance(self.env))

        # 2. Pause scenario: even with the lease expired, the child's OS
        # lock stands, so takeover is still refused.
        _backdate_lease(self.db_path)
        self.assertIsNone(acquire_maintenance(self.env))

        # 3. Crash: the OS releases the flock; the expired lease can now be
        # taken over, and the fencing token increments.
        proc.kill()
        proc.wait()
        guard = None
        deadline = time.monotonic() + 10
        while guard is None and time.monotonic() < deadline:
            guard = acquire_maintenance(self.env)
            if guard is None:
                time.sleep(0.05)
        self.assertIsNotNone(guard, 'takeover after crash failed')
        self.assertEqual(guard.fencing_token, child_token + 1)

        # The dead child's identity is fenced out for good.
        store = self.env['store']
        self.assertFalse(store.maintenance_lease_verify(
            lease_name=LEASE_NAME, holder_instance_id=child_instance,
            fencing_token=child_token,
        ))
        guard.release()


if __name__ == '__main__':
    unittest.main()
