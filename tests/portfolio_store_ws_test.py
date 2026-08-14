"""Tests for portfolio_store_ws.py — the shared persistence protocol layer.

Runs against temp-directory stores only. The Live-path parity test imports
ib_server_ws (which needs ib_async/websockets); it self-skips when those
bridge dependencies are absent so the rest of the suite stays stdlib-only.
"""

import asyncio
import configparser
import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import portfolio_store_ws
from portfolio_store_ws import (
    PERSISTENCE_CLIENT_ACTIONS,
    create_store_env,
    handle_persistence_action,
    is_loopback_address,
    read_max_ws_message_bytes,
)

DOC = 'doc-aaaaaaaa-1111-4111-8111-111111111111'
LOOPBACK = ('127.0.0.1', 51000)


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
        'groups': [],
        'hedges': [],
    }
    payload.update(overrides)
    return payload


def _config(tmpdir, **portfolio_overrides):
    values = {
        'db_path': str(pathlib.Path(tmpdir) / 'portfolio.db'),
        # Keep the fire-and-forget scheduled backup fully disabled unless a
        # test opts in: with no backup_dir configured it would otherwise
        # publish into the real user application-data directory.
        'backup_interval_hours': '0',
    }
    values.update(portfolio_overrides)
    lines = '\n'.join(f'{key} = {value}' for key, value in values.items())
    config = configparser.ConfigParser()
    config.read_string(f'[portfolio_store]\n{lines}\n')
    return config


def _call(env, ws, data):
    handled = asyncio.run(handle_persistence_action(env, ws, data))
    responses = [json.loads(message) for message in ws.sent]
    ws.sent.clear()
    return handled, responses


def _one_response(env, ws, data):
    handled, responses = _call(env, ws, data)
    assert handled, f'expected {data.get("action")} to be handled'
    assert len(responses) == 1
    return responses[0]


def _save_request(request_n=1, token_n=1, expected_revision=None, **overrides):
    request = {
        'action': 'save_saved_workspace',
        'requestId': f'req-{request_n:04d}-4000-8000-000000000000',
        'saveToken': f'save-{token_n:07d}-4000-8000-000000000000',
        'documentId': DOC,
        'title': 'SPY workspace',
        'payload': _payload(),
    }
    if expected_revision is not None:
        request['expectedRevision'] = expected_revision
    request.update(overrides)
    return request


class ProtocolRoundTripTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.env = create_store_env(_config(self._tmp.name))
        self.ws = FakeWebSocket()

    def test_status_reports_capability(self):
        response = _one_response(self.env, self.ws, {
            'action': 'request_workspace_store_status', 'requestId': 'status-1',
        })
        self.assertEqual(response['action'], 'workspace_store_status')
        self.assertEqual(response['requestId'], 'status-1')
        self.assertTrue(response['success'])
        self.assertTrue(response['available'])
        self.assertEqual(response['maxPayloadBytes'], 5 * 1024 * 1024)
        self.assertIn(1, response['acceptedSessionSchemaVersions'])

    def test_full_document_lifecycle(self):
        created = _one_response(self.env, self.ws, _save_request())
        self.assertEqual(created['action'], 'workspace_saved')
        self.assertTrue(created['success'])
        self.assertEqual(created['document']['revision'], 1)
        self.assertEqual(created['document']['symbol'], 'SPY')
        self.assertFalse(created['idempotentReplay'])

        listed = _one_response(self.env, self.ws, {
            'action': 'list_saved_workspaces', 'requestId': 'list-1',
        })
        self.assertEqual(len(listed['documents']), 1)
        self.assertEqual(listed['documents'][0]['documentId'], DOC)

        loaded = _one_response(self.env, self.ws, {
            'action': 'load_saved_workspace', 'requestId': 'load-1',
            'documentId': DOC,
        })
        self.assertEqual(loaded['action'], 'saved_workspace_loaded')
        self.assertEqual(loaded['payload'], _payload())
        self.assertEqual(loaded['document']['revision'], 1)

        updated = _one_response(self.env, self.ws, _save_request(
            request_n=2, token_n=2, expected_revision=1,
            payload=_payload(baseDate='2026-08-04'),
        ))
        self.assertEqual(updated['document']['revision'], 2)

        revisions = _one_response(self.env, self.ws, {
            'action': 'list_workspace_revisions', 'requestId': 'revs-1',
            'documentId': DOC,
        })
        self.assertEqual(
            [r['revision'] for r in revisions['revisions']], [2, 1]
        )

        restored = _one_response(self.env, self.ws, {
            'action': 'restore_workspace_revision', 'requestId': 'restore-1',
            'documentId': DOC, 'revision': 1,
            'saveToken': 'save-restore1-4000-8000-000000000000',
            'expectedRevision': 2,
        })
        self.assertEqual(restored['action'], 'workspace_revision_restored')
        self.assertEqual(restored['document']['revision'], 3)

        deleted = _one_response(self.env, self.ws, {
            'action': 'delete_saved_workspace', 'requestId': 'del-1',
            'documentId': DOC, 'expectedRevision': 3,
        })
        self.assertEqual(deleted['action'], 'workspace_deleted')
        self.assertTrue(deleted['success'])

        empty = _one_response(self.env, self.ws, {
            'action': 'list_saved_workspaces', 'requestId': 'list-2',
        })
        self.assertEqual(empty['documents'], [])

    def test_revision_conflict_reports_current_revision(self):
        _one_response(self.env, self.ws, _save_request())
        _one_response(self.env, self.ws, _save_request(
            request_n=2, token_n=2, expected_revision=1,
        ))
        conflict = _one_response(self.env, self.ws, _save_request(
            request_n=3, token_n=3, expected_revision=1,
        ))
        self.assertFalse(conflict['success'])
        self.assertEqual(conflict['code'], 'revision_conflict')
        self.assertEqual(conflict['currentRevision'], 2)
        self.assertIn('updatedAtUtc', conflict)

    def test_save_token_retry_is_idempotent_over_protocol(self):
        first = _one_response(self.env, self.ws, _save_request())
        retry = _one_response(self.env, self.ws, _save_request(request_n=9))
        self.assertTrue(retry['success'])
        self.assertEqual(retry['document']['revision'], first['document']['revision'])
        self.assertTrue(retry['idempotentReplay'])

    def test_backend_restart_still_loads_with_same_hash(self):
        saved = _one_response(self.env, self.ws, _save_request())
        restarted_env = create_store_env(_config(self._tmp.name))
        loaded = _one_response(restarted_env, FakeWebSocket(), {
            'action': 'load_saved_workspace', 'requestId': 'load-2',
            'documentId': DOC,
        })
        self.assertEqual(
            loaded['document']['payloadSha256'],
            saved['document']['payloadSha256'],
        )

    def test_invalid_requests_use_stable_codes(self):
        double_encoded = _one_response(self.env, self.ws, _save_request(
            payload=json.dumps(_payload()),
        ))
        self.assertEqual(double_encoded['code'], 'invalid_payload')

        bad_revision = _one_response(self.env, self.ws, _save_request(
            expectedRevision='one',
        ))
        self.assertEqual(bad_revision['code'], 'invalid_request')

        missing_doc = _one_response(self.env, self.ws, {
            'action': 'load_saved_workspace', 'requestId': 'load-x',
            'documentId': 'doc-missing00-4000-8000-000000000000',
        })
        self.assertEqual(missing_doc['code'], 'document_not_found')

    def test_non_persistence_action_is_not_handled(self):
        handled, responses = _call(self.env, self.ws, {'action': 'subscribe'})
        self.assertFalse(handled)
        self.assertEqual(responses, [])

    def test_handler_survives_unexpected_store_failure(self):
        _one_response(self.env, self.ws, _save_request())
        store = self.env['store']
        original = store.save_workspace
        store.save_workspace = lambda **kwargs: (_ for _ in ()).throw(
            RuntimeError('sqlite3.OperationalError: secret /path/leak')
        )
        try:
            response = _one_response(self.env, self.ws, _save_request(
                request_n=5, token_n=5, expected_revision=1,
            ))
        finally:
            store.save_workspace = original
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'internal_store_error')
        self.assertNotIn('/path/leak', response['message'])
        # The socket keeps working afterwards.
        ok = _one_response(self.env, self.ws, {
            'action': 'list_saved_workspaces', 'requestId': 'after-crash',
        })
        self.assertTrue(ok['success'])


class PayloadLimitTest(unittest.TestCase):
    def test_oversized_payload_rejected_with_stable_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = create_store_env(_config(tmp, max_payload_bytes=512))
            response = _one_response(env, FakeWebSocket(), _save_request(
                payload=_payload(filler='x' * 2048),
            ))
            self.assertFalse(response['success'])
            self.assertEqual(response['code'], 'payload_too_large')

    def test_transport_cap_default_and_floor(self):
        self.assertEqual(read_max_ws_message_bytes(None), 8 * 1024 * 1024)
        config = configparser.ConfigParser()
        config.read_string('[server]\nmax_ws_message_bytes = 1024\n')
        self.assertEqual(read_max_ws_message_bytes(config), 1024 * 1024)
        config = configparser.ConfigParser()
        config.read_string('[server]\nmax_ws_message_bytes = 16777216\n')
        self.assertEqual(read_max_ws_message_bytes(config), 16 * 1024 * 1024)


class LoopbackEnforcementTest(unittest.TestCase):
    def test_is_loopback_address_matrix(self):
        self.assertTrue(is_loopback_address(('127.0.0.1', 1)))
        self.assertTrue(is_loopback_address(('127.0.0.53', 1)))
        self.assertTrue(is_loopback_address(('::1', 1)))
        self.assertTrue(is_loopback_address(('::ffff:127.0.0.1', 1)))
        self.assertFalse(is_loopback_address(('::ffff:10.0.0.7', 1)))
        self.assertFalse(is_loopback_address(('192.168.1.7', 1)))
        self.assertFalse(is_loopback_address(('100.100.1.2', 1)))
        self.assertFalse(is_loopback_address(('evil.example', 1)))
        # Fail closed on anything unresolvable.
        self.assertFalse(is_loopback_address(None))
        self.assertFalse(is_loopback_address(()))
        self.assertFalse(is_loopback_address(('', 1)))

    def test_remote_client_gets_no_store_details_and_no_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = create_store_env(_config(tmp))
            remote = FakeWebSocket(remote_address=('192.168.1.7', 40000))

            status = _one_response(env, remote, {
                'action': 'request_workspace_store_status', 'requestId': 'r-1',
            })
            self.assertTrue(status['success'])
            self.assertFalse(status['available'])
            self.assertEqual(status['reason'], 'remote_access_disabled')
            self.assertNotIn('maxPayloadBytes', status)
            self.assertNotIn('storeSchemaVersion', status)

            save = _one_response(env, remote, _save_request())
            self.assertFalse(save['success'])
            self.assertEqual(save['code'], 'remote_access_disabled')

            # Loopback checks run before lazy init: remote probes must not
            # even create the database file.
            self.assertFalse(
                (pathlib.Path(tmp) / 'portfolio.db').exists()
            )

    def test_missing_remote_address_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = create_store_env(_config(tmp))
            response = _one_response(
                env, FakeWebSocket(remote_address=None), _save_request()
            )
            self.assertEqual(response['code'], 'remote_access_disabled')


class UnavailableStoreTest(unittest.TestCase):
    def test_disabled_by_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = create_store_env(_config(tmp, enabled='false'))
            status = _one_response(env, FakeWebSocket(), {
                'action': 'request_workspace_store_status', 'requestId': 's-1',
            })
            self.assertFalse(status['available'])
            save = _one_response(env, FakeWebSocket(), _save_request())
            self.assertEqual(save['code'], 'store_unavailable')

    def test_corrupt_database_disables_persistence_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = pathlib.Path(tmp) / 'portfolio.db'
            garbage = b'not a sqlite file' * 16
            db_path.write_bytes(garbage)
            env = create_store_env(_config(tmp))
            save = _one_response(env, FakeWebSocket(), _save_request())
            self.assertFalse(save['success'])
            self.assertEqual(save['code'], 'store_unavailable')
            # The corrupt file is reported, never replaced.
            self.assertEqual(db_path.read_bytes(), garbage)

    def test_none_env_reports_unavailable(self):
        response_holder = FakeWebSocket()
        handled = asyncio.run(handle_persistence_action(
            None, response_holder, _save_request()
        ))
        self.assertTrue(handled)
        response = json.loads(response_holder.sent[0])
        self.assertEqual(response['code'], 'store_unavailable')


class EventLoopIsolationTest(unittest.TestCase):
    def test_slow_store_does_not_block_light_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = create_store_env(_config(tmp))
            _one_response(env, FakeWebSocket(), _save_request())
            store = env['store']
            original = store.save_workspace

            def slow_save(**kwargs):
                time.sleep(0.3)
                return original(**kwargs)

            store.save_workspace = slow_save
            try:
                async def scenario():
                    ticks = 0

                    async def ticker():
                        nonlocal ticks
                        while True:
                            ticks += 1
                            await asyncio.sleep(0.01)

                    ticker_task = asyncio.create_task(ticker())
                    await handle_persistence_action(
                        env, FakeWebSocket(), _save_request(
                            request_n=2, token_n=2, expected_revision=1,
                        ),
                    )
                    ticker_task.cancel()
                    return ticks

                ticks = asyncio.run(scenario())
            finally:
                store.save_workspace = original
            # A blocked event loop would leave the ticker near zero.
            self.assertGreater(ticks, 10)


class UndeleteProtocolTest(unittest.TestCase):
    def test_delete_recently_deleted_and_undelete_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = create_store_env(_config(tmp))
            ws = FakeWebSocket()
            saved = _one_response(env, ws, _save_request())
            sha = saved['document']['payloadSha256']

            deleted = _one_response(env, ws, {
                'action': 'delete_saved_workspace', 'requestId': 'del-1',
                'documentId': DOC, 'expectedRevision': 1,
            })
            self.assertTrue(deleted['success'])

            # Default list hides it; includeDeleted surfaces it with its
            # deletion time for the Recently Deleted view.
            hidden = _one_response(env, ws, {
                'action': 'list_saved_workspaces', 'requestId': 'list-1',
            })
            self.assertEqual(hidden['documents'], [])
            visible = _one_response(env, ws, {
                'action': 'list_saved_workspaces', 'requestId': 'list-2',
                'includeDeleted': True,
            })
            self.assertEqual(len(visible['documents']), 1)
            self.assertIsNotNone(visible['documents'][0]['deletedAtUtc'])

            restored = _one_response(env, ws, {
                'action': 'undelete_saved_workspace', 'requestId': 'undel-1',
                'documentId': DOC, 'expectedRevision': 1,
            })
            self.assertEqual(restored['action'], 'workspace_undeleted')
            self.assertTrue(restored['success'])

            back = _one_response(env, ws, {
                'action': 'load_saved_workspace', 'requestId': 'load-1',
                'documentId': DOC,
            })
            self.assertEqual(back['document']['revision'], 1)
            self.assertEqual(back['document']['payloadSha256'], sha)

    def test_undelete_conflicts_use_stable_codes(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = create_store_env(_config(tmp))
            ws = FakeWebSocket()
            _one_response(env, ws, _save_request())
            not_deleted = _one_response(env, ws, {
                'action': 'undelete_saved_workspace', 'requestId': 'u-1',
                'documentId': DOC, 'expectedRevision': 1,
            })
            self.assertEqual(not_deleted['code'], 'invalid_request')
            _one_response(env, ws, {
                'action': 'delete_saved_workspace', 'requestId': 'd-1',
                'documentId': DOC, 'expectedRevision': 1,
            })
            stale = _one_response(env, ws, {
                'action': 'undelete_saved_workspace', 'requestId': 'u-2',
                'documentId': DOC, 'expectedRevision': 9,
            })
            self.assertEqual(stale['code'], 'revision_conflict')


class RetentionMaintenanceTest(unittest.TestCase):
    def test_verified_backup_gates_prune_and_vacuum(self):
        with tempfile.TemporaryDirectory() as tmp:
            backup_dir = pathlib.Path(tmp) / 'backups'
            config = _config(
                tmp,
                backup_dir=str(backup_dir),
                backup_interval_hours='24',
                revision_keep_recent='2',
                revision_keep_daily_days='0',
            )
            env = create_store_env(config)
            portfolio_store_ws.ensure_store_initialized(env)
            store = env['store']
            store.save_workspace(
                document_id=DOC, title='SPY workspace', payload=_payload(),
                save_token='save-0000001-4000-8000-000000000000',
            )
            for i in range(2, 8):
                store.save_workspace(
                    document_id=DOC, title='SPY workspace',
                    payload=_payload(baseDate=f'rev-{i}'),
                    save_token=f'save-{i:07d}-4000-8000-000000000000',
                    expected_revision=i - 1,
                )
            self.assertEqual(len(store.list_revisions(DOC, limit=50)), 7)

            # The maintenance pass publishes a verified backup FIRST, then
            # applies the configured retention.
            self.assertTrue(portfolio_store_ws.maybe_publish_scheduled_backup(env))
            self.assertEqual(len(list(backup_dir.iterdir())), 1)
            remaining = [r['revision'] for r in store.list_revisions(DOC, limit=50)]
            # keep_recent=2 keeps {7,6}; the daily window (0 days = today)
            # additionally anchors today's last older revision, 5.
            self.assertEqual(remaining, [7, 6, 5])
            self.assertEqual(store.load_workspace(DOC)['revision'], 7)
            self.assertEqual(store.quick_check(), 'ok')

            # The backup snapshot was taken before pruning: a restore drill
            # from it still holds the full pre-prune history.
            from portfolio_store import PortfolioStore, restore_database
            restored_db = pathlib.Path(tmp) / 'restored' / 'portfolio.db'
            restore_database(next(backup_dir.iterdir()), restored_db)
            restored = PortfolioStore(restored_db).initialize()
            self.assertEqual(len(restored.list_revisions(DOC, limit=50)), 7)

    def test_failed_backup_blocks_pruning(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = _config(tmp, backup_interval_hours='1',
                             revision_keep_recent='1',
                             revision_keep_daily_days='0')
            env = create_store_env(config)
            portfolio_store_ws.ensure_store_initialized(env)
            store = env['store']
            store.save_workspace(
                document_id=DOC, title='SPY workspace', payload=_payload(),
                save_token='save-0000001-4000-8000-000000000000',
            )
            store.save_workspace(
                document_id=DOC, title='SPY workspace',
                payload=_payload(baseDate='rev-2'),
                save_token='save-0000002-4000-8000-000000000000',
                expected_revision=1,
            )
            store.publish_backup = lambda *a, **k: (_ for _ in ()).throw(
                RuntimeError('backup target offline')
            )
            self.assertFalse(portfolio_store_ws.maybe_publish_scheduled_backup(env))
            # No verified backup, no pruning: both revisions survive.
            self.assertEqual(len(store.list_revisions(DOC, limit=50)), 2)


class ScheduledBackupTest(unittest.TestCase):
    def test_stale_interval_publishes_once_then_suppresses(self):
        with tempfile.TemporaryDirectory() as tmp:
            backup_dir = pathlib.Path(tmp) / 'backups'
            config = _config(tmp, backup_dir=str(backup_dir),
                             backup_interval_hours='24')
            env = create_store_env(config)
            # Populate through the store directly so no background task
            # races the assertions below.
            portfolio_store_ws.ensure_store_initialized(env)
            env['store'].save_workspace(
                document_id=DOC, title='SPY workspace', payload=_payload(),
                save_token='save-0000001-4000-8000-000000000000',
            )
            self.assertTrue(portfolio_store_ws.maybe_publish_scheduled_backup(env))
            names = [p.name for p in backup_dir.iterdir()]
            self.assertEqual(len(names), 1)
            from portfolio_store import SCHEMA_USER_VERSION
            self.assertRegex(
                names[0],
                rf'^portfolio-\d{{8}}T\d{{6}}Z-schema{SCHEMA_USER_VERSION}-',
            )
            # A fresh backup suppresses the next publish inside the interval.
            self.assertFalse(portfolio_store_ws.maybe_publish_scheduled_backup(env))
            self.assertTrue(portfolio_store_ws.maybe_publish_scheduled_backup(
                env, force=True
            ))

    def test_backup_failure_never_raises_and_releases_the_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            backup_dir = pathlib.Path(tmp) / 'backups'
            env = create_store_env(_config(tmp, backup_dir=str(backup_dir)))
            _one_response(env, FakeWebSocket(), _save_request())
            # Re-enable scheduling after the save so the manual call below
            # deterministically reaches the (failing) publish.
            env['_backup_interval_seconds'] = 3600.0
            original_publish = env['store'].publish_backup
            env['store'].publish_backup = lambda *a, **k: (_ for _ in ()).throw(
                RuntimeError('disk full')
            )
            self.assertFalse(portfolio_store_ws.maybe_publish_scheduled_backup(env))
            portfolio_store_ws.publish_backup_best_effort(env)  # must not raise
            # The maintenance lock is released after the failure: the next
            # attempt runs and succeeds.
            env['store'].publish_backup = original_publish
            self.assertTrue(portfolio_store_ws.maybe_publish_scheduled_backup(
                env, force=True
            ))

    def test_concurrent_maintenance_runs_exactly_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            backup_dir = pathlib.Path(tmp) / 'backups'
            config = _config(tmp, backup_dir=str(backup_dir),
                             backup_interval_hours='24')
            env = create_store_env(config)
            portfolio_store_ws.ensure_store_initialized(env)
            env['store'].save_workspace(
                document_id=DOC, title='SPY workspace', payload=_payload(),
                save_token='save-0000001-4000-8000-000000000000',
            )
            barrier = threading.Barrier(20)
            results = []
            results_lock = threading.Lock()

            def worker():
                barrier.wait()
                outcome = portfolio_store_ws.maybe_publish_scheduled_backup(env)
                with results_lock:
                    results.append(outcome)

            threads = [threading.Thread(target=worker) for _ in range(20)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)
            # Exactly one thread performed the publish/prune/vacuum chain;
            # the rest returned fast without queueing behind it.
            self.assertEqual(sum(1 for outcome in results if outcome), 1)
            self.assertEqual(len(results), 20)
            self.assertEqual(len(list(backup_dir.iterdir())), 1)

    def test_uninitialized_env_skips_quietly(self):
        self.assertFalse(portfolio_store_ws.maybe_publish_scheduled_backup(None))
        with tempfile.TemporaryDirectory() as tmp:
            env = create_store_env(_config(tmp))
            # Store not lazily initialized yet: nothing to back up.
            self.assertFalse(portfolio_store_ws.maybe_publish_scheduled_backup(env))


class LiveHistoricalParityTest(unittest.TestCase):
    """Both backends must answer the same request identically. The Live path
    goes through ib_server_ws.dispatch_client_message; the Historical path
    calls the shared handler exactly as historical_server.py does."""

    def test_dispatch_parity(self):
        try:
            import ib_server_ws
        except ImportError as exc:
            self.skipTest(f'ib bridge dependencies unavailable: {exc}')

        async def send_via_env(ws, message):
            ws.sent.append(message)

        with tempfile.TemporaryDirectory() as tmp:
            shared_config = _config(tmp)
            live_env_store = create_store_env(shared_config)
            live_ws = FakeWebSocket()
            live_env = {
                'send_message_safe': send_via_env,
                'portfolio_store_env': live_env_store,
            }
            asyncio.run(ib_server_ws.dispatch_client_message(
                live_env, live_ws, _save_request(), client_ip='127.0.0.1',
            ))
            live_response = json.loads(live_ws.sent[0])

        with tempfile.TemporaryDirectory() as tmp:
            historical_store = create_store_env(_config(tmp))
            historical_ws = FakeWebSocket()
            asyncio.run(handle_persistence_action(
                historical_store, historical_ws, _save_request(),
                client_ip='127.0.0.1', send=send_via_env,
            ))
            historical_response = json.loads(historical_ws.sent[0])

        for response in (live_response, historical_response):
            del response['document']['updatedAtUtc']
        self.assertEqual(live_response, historical_response)

    def test_action_set_matches_plan(self):
        self.assertEqual(PERSISTENCE_CLIENT_ACTIONS, {
            'request_workspace_store_status',
            'list_saved_workspaces',
            'load_saved_workspace',
            'save_saved_workspace',
            'delete_saved_workspace',
            'undelete_saved_workspace',
            'list_workspace_revisions',
            'restore_workspace_revision',
        })


if __name__ == '__main__':
    unittest.main()
