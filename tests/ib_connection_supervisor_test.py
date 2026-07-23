import asyncio
import pathlib
import sys
import time
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from ib_connection_supervisor import (
    DEFAULT_RETRY_INTERVAL_SECONDS,
    IbConnectionSupervisor,
)


class _FakeEvent:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        if handler not in self.handlers:
            self.handlers.append(handler)
        return self

    def __isub__(self, handler):
        if handler in self.handlers:
            self.handlers.remove(handler)
        return self

    def emit(self, *args):
        for handler in list(self.handlers):
            handler(*args)


class _FakeIB:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.errorEvent = _FakeEvent()
        self.disconnectedEvent = _FakeEvent()
        self.connect_calls = []
        self.disconnect_calls = 0
        self.connected = False

    def isConnected(self):
        return self.connected

    async def connectAsync(self, host, port, *, clientId, timeout):
        self.connect_calls.append({
            'host': host,
            'port': port,
            'clientId': clientId,
            'timeout': timeout,
            'startedAt': time.monotonic(),
        })
        outcome = self.outcomes.pop(0) if self.outcomes else {'success': False}
        await asyncio.sleep(0)
        if outcome.get('success'):
            self.connected = True
            return

        error_code = outcome.get('errorCode')
        if error_code is not None:
            self.errorEvent.emit(-1, error_code, outcome.get('message', 'failed'), None)
        if outcome.get('emitDisconnected'):
            self.disconnectedEvent.emit()
        if outcome.get('emitDisconnectedAfterFailure'):
            asyncio.get_running_loop().call_soon(self.disconnectedEvent.emit)
        raise ConnectionError(outcome.get('message', 'connection failed'))

    def disconnect(self):
        self.disconnect_calls += 1
        self.connected = False
        self.disconnectedEvent.emit()

    def drop_connection(self, *, duplicate_event=False):
        self.connected = False
        self.disconnectedEvent.emit()
        if duplicate_event:
            self.disconnectedEvent.emit()


class _ClearRaceEvent:
    """Inject one wake immediately before clear() to reproduce a lost wake."""

    def __init__(self, before_first_clear):
        self._event = asyncio.Event()
        self._before_first_clear = before_first_clear
        self._injected = False

    def is_set(self):
        return self._event.is_set()

    def set(self):
        self._event.set()

    def clear(self):
        if not self._injected:
            self._injected = True
            self._before_first_clear()
        self._event.clear()

    async def wait(self):
        await self._event.wait()


async def _wait_until(predicate, timeout=0.5):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError('Timed out waiting for asynchronous condition.')
        await asyncio.sleep(0.001)


class IbConnectionSupervisorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        supervisor = getattr(self, 'supervisor', None)
        if supervisor is not None:
            await supervisor.stop(disconnect=True)

    def _build_supervisor(self, fake_ib, **overrides):
        self.supervisor = IbConnectionSupervisor(
            ib=fake_ib,
            host='127.0.0.1',
            port=7496,
            client_id=overrides.pop('client_id', 999),
            retry_interval_seconds=overrides.pop('retry_interval_seconds', 0.05),
            connect_timeout_seconds=overrides.pop('connect_timeout_seconds', 0.02),
            **overrides,
        )
        return self.supervisor

    async def test_default_retry_interval_is_ten_minutes(self):
        fake_ib = _FakeIB([])
        supervisor = IbConnectionSupervisor(
            ib=fake_ib,
            host='127.0.0.1',
            port=7496,
            client_id=999,
        )
        self.supervisor = supervisor

        self.assertEqual(DEFAULT_RETRY_INTERVAL_SECONDS, 600.0)
        self.assertEqual(supervisor.retry_interval_seconds, 600.0)

    async def test_failed_attempts_follow_fixed_attempt_start_cadence(self):
        fake_ib = _FakeIB([
            {
                'success': False,
                'message': 'TWS unavailable',
                'emitDisconnectedAfterFailure': True,
            },
            {'success': True},
        ])
        supervisor = self._build_supervisor(
            fake_ib,
            retry_interval_seconds=0.06,
        )

        supervisor.start()
        await _wait_until(lambda: len(fake_ib.connect_calls) == 1)
        await asyncio.sleep(0.015)
        self.assertEqual(len(fake_ib.connect_calls), 1)

        await _wait_until(lambda: len(fake_ib.connect_calls) == 2)
        await _wait_until(fake_ib.isConnected)
        attempt_gap = (
            fake_ib.connect_calls[1]['startedAt']
            - fake_ib.connect_calls[0]['startedAt']
        )
        self.assertGreaterEqual(attempt_gap, 0.05)
        self.assertTrue(fake_ib.isConnected())
        self.assertEqual(supervisor.state, 'connected')

    async def test_manual_request_wakes_scheduled_retry_without_second_task(self):
        fake_ib = _FakeIB([
            {'success': False, 'message': 'TWS unavailable'},
            {'success': True},
        ])
        supervisor = self._build_supervisor(
            fake_ib,
            retry_interval_seconds=60,
        )

        task = supervisor.start()
        await _wait_until(lambda: len(fake_ib.connect_calls) == 1)
        self.assertTrue(supervisor.request_connect())
        self.assertIs(supervisor.task, task)

        await _wait_until(lambda: len(fake_ib.connect_calls) == 2)
        self.assertTrue(fake_ib.isConnected())

    async def test_post_connect_callback_failure_is_fatal_to_supervisor_task(self):
        fake_ib = _FakeIB([{'success': True}])

        def fail_post_connect():
            raise RuntimeError('post-connect synchronization failed')

        supervisor = self._build_supervisor(
            fake_ib,
            on_connected=fail_post_connect,
        )

        task = supervisor.start()
        with self.assertRaisesRegex(
            RuntimeError,
            'post-connect callback failed',
        ) as raised:
            await asyncio.wait_for(task, timeout=0.2)

        self.assertIsInstance(raised.exception.__cause__, RuntimeError)
        self.assertFalse(supervisor.running)
        self.assertTrue(fake_ib.isConnected())

    async def test_wake_arriving_immediately_before_event_clear_is_not_lost(self):
        fake_ib = _FakeIB([{'success': True}])
        fake_ib.connected = True
        supervisor = self._build_supervisor(fake_ib, retry_interval_seconds=60)

        def request_during_clear():
            fake_ib.connected = False
            self.assertTrue(supervisor.request_connect())

        supervisor._wake_event = _ClearRaceEvent(request_during_clear)
        supervisor.start()

        await _wait_until(lambda: len(fake_ib.connect_calls) == 1, timeout=0.1)
        self.assertTrue(fake_ib.isConnected())

    async def test_successive_326_decrements_retry_promptly_then_floor_uses_normal_cadence(self):
        fake_ib = _FakeIB([
            {'success': False, 'errorCode': 326, 'message': 'client in use'},
            {'success': False, 'errorCode': 326, 'message': 'client in use'},
            {'success': False, 'errorCode': 326, 'message': 'client in use'},
            {'success': True},
        ])
        supervisor = self._build_supervisor(
            fake_ib,
            client_id=3,
            retry_interval_seconds=0.12,
            client_id_retry_interval_seconds=0.01,
        )

        supervisor.start()
        await _wait_until(lambda: len(fake_ib.connect_calls) == 3)
        self.assertEqual(
            [call['clientId'] for call in fake_ib.connect_calls[:3]],
            [3, 2, 1],
        )
        first_gap = fake_ib.connect_calls[1]['startedAt'] - fake_ib.connect_calls[0]['startedAt']
        second_gap = fake_ib.connect_calls[2]['startedAt'] - fake_ib.connect_calls[1]['startedAt']
        self.assertLess(first_gap, 0.08)
        self.assertLess(second_gap, 0.08)

        await asyncio.sleep(0.04)
        self.assertEqual(len(fake_ib.connect_calls), 3)
        await _wait_until(lambda: len(fake_ib.connect_calls) == 4)
        await _wait_until(fake_ib.isConnected)
        floor_gap = fake_ib.connect_calls[3]['startedAt'] - fake_ib.connect_calls[2]['startedAt']
        self.assertGreaterEqual(floor_gap, 0.10)
        self.assertTrue(fake_ib.isConnected())

    async def test_successive_326_errors_decrement_only_to_safe_floor(self):
        fake_ib = _FakeIB([
            {'success': False, 'errorCode': 326, 'message': 'client in use'},
            {'success': False, 'errorCode': 326, 'message': 'client in use'},
            {'success': False, 'errorCode': 502, 'message': 'connection refused'},
            {'success': False, 'errorCode': 326, 'message': 'client in use'},
            {'success': False, 'errorCode': 326, 'message': 'client in use'},
        ])
        supervisor = self._build_supervisor(fake_ib, client_id=3)

        self.assertFalse(await supervisor._connect_once())
        self.assertEqual(supervisor.effective_client_id, 2)
        self.assertEqual(supervisor.last_error_code, 326)

        self.assertFalse(await supervisor._connect_once())
        self.assertEqual(supervisor.effective_client_id, 1)

        self.assertFalse(await supervisor._connect_once())
        self.assertEqual(supervisor.effective_client_id, 1)
        self.assertEqual(supervisor.last_error_code, 502)

        self.assertFalse(await supervisor._connect_once())
        self.assertEqual(supervisor.effective_client_id, 1)
        self.assertFalse(await supervisor._connect_once())
        self.assertEqual(supervisor.effective_client_id, 1)
        self.assertNotIn(0, [call['clientId'] for call in fake_ib.connect_calls])

    async def test_unexpected_disconnect_reconnects_once_even_for_duplicate_event(self):
        disconnected_callbacks = []
        connected_callbacks = []
        fake_ib = _FakeIB([
            {'success': True},
            {'success': True},
        ])
        supervisor = self._build_supervisor(
            fake_ib,
            on_connected=lambda: connected_callbacks.append(True),
            on_disconnected=lambda: disconnected_callbacks.append(True),
        )

        task = supervisor.start()
        await _wait_until(lambda: fake_ib.isConnected())
        fake_ib.drop_connection(duplicate_event=True)

        await _wait_until(lambda: len(fake_ib.connect_calls) == 2)
        await _wait_until(lambda: len(connected_callbacks) == 2)
        await _wait_until(lambda: len(disconnected_callbacks) == 1)
        self.assertIs(supervisor.task, task)
        self.assertEqual(len(fake_ib.connect_calls), 2)
        self.assertTrue(fake_ib.isConnected())

    async def test_disconnect_callback_finishes_before_reconnect_attempt_starts(self):
        callback_started = asyncio.Event()
        allow_callback_to_finish = asyncio.Event()
        callback_finished = asyncio.Event()
        fake_ib = _FakeIB([
            {'success': True},
            {'success': True},
        ])

        async def on_disconnected():
            callback_started.set()
            await allow_callback_to_finish.wait()
            callback_finished.set()

        supervisor = self._build_supervisor(
            fake_ib,
            on_disconnected=on_disconnected,
        )

        supervisor.start()
        await _wait_until(lambda: fake_ib.isConnected())
        fake_ib.drop_connection()
        await callback_started.wait()
        await asyncio.sleep(0.02)

        self.assertEqual(len(fake_ib.connect_calls), 1)
        self.assertFalse(callback_finished.is_set())

        allow_callback_to_finish.set()
        await _wait_until(lambda: len(fake_ib.connect_calls) == 2)
        self.assertTrue(callback_finished.is_set())
        self.assertTrue(fake_ib.isConnected())

    async def test_disconnect_callback_failure_is_fatal_without_reconnect(self):
        fake_ib = _FakeIB([
            {'success': True},
            {'success': True},
        ])

        async def fail_disconnect_recovery():
            raise RuntimeError('disconnect invalidation failed')

        supervisor = self._build_supervisor(
            fake_ib,
            on_disconnected=fail_disconnect_recovery,
        )

        task = supervisor.start()
        await _wait_until(fake_ib.isConnected)
        fake_ib.drop_connection()

        with self.assertRaisesRegex(
            RuntimeError,
            'disconnect callback failed',
        ) as raised:
            await asyncio.wait_for(task, timeout=0.2)

        self.assertIsInstance(raised.exception.__cause__, RuntimeError)
        self.assertFalse(supervisor.running)
        self.assertFalse(fake_ib.isConnected())
        self.assertEqual(len(fake_ib.connect_calls), 1)

    async def test_delayed_disconnect_event_is_ignored_after_connection_is_already_restored(self):
        disconnected_callbacks = []
        fake_ib = _FakeIB([{'success': True}])
        supervisor = self._build_supervisor(
            fake_ib,
            on_disconnected=lambda: disconnected_callbacks.append(True),
        )

        supervisor.start()
        await _wait_until(lambda: fake_ib.isConnected())
        fake_ib.disconnectedEvent.emit()
        await asyncio.sleep(0.02)

        self.assertEqual(len(fake_ib.connect_calls), 1)
        self.assertEqual(disconnected_callbacks, [])
        self.assertEqual(supervisor.state, 'connected')

    async def test_intentional_reset_and_shutdown_suppress_disconnect_recovery(self):
        disconnected_callbacks = []
        fake_ib = _FakeIB([
            {'success': True},
            {'success': True},
        ])
        supervisor = self._build_supervisor(
            fake_ib,
            retry_interval_seconds=60,
            on_disconnected=lambda: disconnected_callbacks.append(True),
        )

        supervisor.start()
        await _wait_until(lambda: fake_ib.isConnected())
        self.assertTrue(supervisor.disconnect_intentionally())
        self.assertEqual(fake_ib.disconnectedEvent.handlers, [])
        await asyncio.sleep(0.01)
        self.assertEqual(len(fake_ib.connect_calls), 1)
        self.assertEqual(disconnected_callbacks, [])

        self.assertTrue(supervisor.request_connect())
        await _wait_until(lambda: len(fake_ib.connect_calls) == 2)
        await _wait_until(lambda: fake_ib.isConnected())
        self.assertEqual(
            fake_ib.disconnectedEvent.handlers,
            [supervisor._handle_disconnected_event],
        )

        await supervisor.stop(disconnect=True)
        self.assertEqual(fake_ib.disconnectedEvent.handlers, [])
        fake_ib.disconnectedEvent.emit()
        await asyncio.sleep(0.01)
        self.assertEqual(len(fake_ib.connect_calls), 2)
        self.assertEqual(disconnected_callbacks, [])
        self.assertEqual(supervisor.state, 'stopped')
