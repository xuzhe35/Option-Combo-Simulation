import asyncio
import json
import os
import signal
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from option_combo_starter.supervisor import (
    ApplicationSupervisor,
    IBStatusMonitor,
    SupervisorConfig,
    YieldCurveScheduler,
    parse_yield_update_result,
)


def _config(**overrides):
    values = {
        "repo_dir": Path("/synthetic/repo"),
        "python_executable": "/synthetic/python",
        "ib_status_poll_seconds": 30.0,
        "ws_retry_seconds": 5.0,
        "ws_response_timeout_seconds": 1.0,
        "yield_curve_data_dir": Path("/synthetic/state/yield_curve"),
        "yield_check_seconds": 3600.0,
        "yield_retry_seconds": 600.0,
        "yield_process_timeout_seconds": 1.0,
        "yield_post_publication_hour_ny": 18,
        "shutdown_grace_seconds": 1.0,
    }
    values.update(overrides)
    return SupervisorConfig(**values)


class YieldUpdateResultTest(unittest.TestCase):
    def test_cache_fallback_is_retryable_even_with_zero_exit_code(self):
        outcome = parse_yield_update_result(
            0,
            json.dumps(
                {
                    "status": "cache_fallback",
                    "fallbackUsed": True,
                    "snapshot": {"curveAsOf": "2026-07-22"},
                    "error": "source unavailable",
                }
            ),
        )

        self.assertEqual(outcome.status, "cache_fallback")
        self.assertTrue(outcome.retry_soon)
        self.assertTrue(outcome.force_refresh_on_retry)
        self.assertEqual(outcome.curve_as_of, "2026-07-22")
        self.assertEqual(outcome.error, "source unavailable")

    def test_complete_updated_result_uses_regular_check_interval(self):
        outcome = parse_yield_update_result(
            0,
            json.dumps(
                {
                    "status": "updated",
                    "snapshot": {"curveAsOf": "2026-07-23"},
                }
            ),
        )

        self.assertFalse(outcome.retry_soon)
        self.assertFalse(outcome.force_refresh_on_retry)

    def test_invalid_json_and_success_without_snapshot_are_retryable(self):
        invalid = parse_yield_update_result(0, "not-json")
        missing_snapshot = parse_yield_update_result(
            0,
            json.dumps({"status": "updated", "snapshot": None}),
        )

        self.assertEqual(invalid.status, "invalid_output")
        self.assertTrue(invalid.retry_soon)
        self.assertTrue(missing_snapshot.retry_soon)


class SupervisorConfigTest(unittest.TestCase):
    def test_yield_curve_data_dir_defaults_to_persistent_state_and_is_overridable(self):
        with patch.dict(os.environ, {}, clear=True):
            default_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))
        with patch.dict(
            os.environ,
            {"YIELD_CURVE_DATA_DIR": "/synthetic/alternate-yield-state"},
            clear=True,
        ):
            overridden_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))

        self.assertEqual(
            default_config.yield_curve_data_dir,
            Path("/app/state/yield_curve"),
        )
        self.assertEqual(
            overridden_config.yield_curve_data_dir,
            Path("/synthetic/alternate-yield-state"),
        )

    def test_post_publication_hour_defaults_to_18_ny_and_is_overridable(self):
        with patch.dict(os.environ, {}, clear=True):
            default_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))
        with patch.dict(
            os.environ,
            {"OPTION_COMBO_YIELD_POST_PUBLICATION_HOUR_NY": "20"},
            clear=True,
        ):
            overridden_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))

        self.assertEqual(default_config.yield_post_publication_hour_ny, 18)
        self.assertEqual(overridden_config.yield_post_publication_hour_ny, 20)

    def test_status_monitor_uses_backend_bind_host_without_dialing_a_wildcard(self):
        with patch.dict(os.environ, {"WS_HOST": "0.0.0.0"}, clear=True):
            wildcard_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))
        with patch.dict(os.environ, {"WS_HOST": "10.0.0.8"}, clear=True):
            specific_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))
        with patch.dict(os.environ, {"WS_HOST": "::"}, clear=True):
            ipv6_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))

        self.assertEqual(wildcard_config.ib_status_host, "127.0.0.1")
        self.assertEqual(specific_config.ib_status_host, "10.0.0.8")
        self.assertEqual(specific_config.ws_port, 8765)
        self.assertEqual(IBStatusMonitor(ipv6_config).uri, "ws://[::1]:8765")


class _UpdaterProcess:
    _next_pid = 3000

    def __init__(self, payload, returncode=0):
        type(self)._next_pid += 1
        self.pid = type(self)._next_pid
        self.returncode = returncode
        self._payload = payload

    async def communicate(self):
        return json.dumps(self._payload).encode("utf-8"), b""

    async def wait(self):
        return self.returncode


class YieldCurveSchedulerTest(unittest.IsolatedAsyncioTestCase):
    async def test_cache_fallback_retries_without_if_needed_gate(self):
        spawned_commands = []
        processes = [
            _UpdaterProcess(
                {
                    "status": "cache_fallback",
                    "fallbackUsed": True,
                    "snapshot": {"curveAsOf": "2026-07-22"},
                }
            ),
            _UpdaterProcess(
                {
                    "status": "updated",
                    "fallbackUsed": False,
                    "snapshot": {"curveAsOf": "2026-07-23"},
                }
            ),
        ]

        async def spawn_exec(*command, **_kwargs):
            spawned_commands.append(command)
            return processes.pop(0)

        delays = []

        async def fake_wait_for_stop(stop_event, delay):
            delays.append(delay)
            if len(delays) == 2:
                stop_event.set()
                return True
            return False

        scheduler = YieldCurveScheduler(
            _config(),
            spawn_exec=spawn_exec,
            wait_for_stop_fn=fake_wait_for_stop,
            now=lambda: datetime(
                2026,
                7,
                23,
                10,
                0,
                tzinfo=ZoneInfo("America/New_York"),
            ),
        )
        await scheduler.run(asyncio.Event())

        self.assertIn("--if-needed", spawned_commands[0])
        self.assertNotIn("--if-needed", spawned_commands[1])
        self.assertIn("--json", spawned_commands[0])
        data_dir_index = spawned_commands[0].index("--data-dir")
        self.assertEqual(
            spawned_commands[0][data_dir_index + 1],
            "/synthetic/state/yield_curve",
        )
        self.assertEqual(
            spawned_commands[1][spawned_commands[1].index("--data-dir") + 1],
            "/synthetic/state/yield_curve",
        )
        self.assertEqual(delays, [600.0, 3600.0])

    async def test_forces_once_after_ny_publication_hour_then_returns_to_if_needed(self):
        spawned_commands = []
        processes = [
            _UpdaterProcess({
                "status": "not_due",
                "snapshot": {"curveAsOf": "2026-07-23"},
            }),
            _UpdaterProcess({
                "status": "updated",
                "snapshot": {"curveAsOf": "2026-07-23"},
            }),
            _UpdaterProcess({
                "status": "not_due",
                "snapshot": {"curveAsOf": "2026-07-23"},
            }),
        ]

        async def spawn_exec(*command, **_kwargs):
            spawned_commands.append(command)
            return processes.pop(0)

        clock = {
            "now": datetime(
                2026,
                7,
                23,
                17,
                59,
                tzinfo=ZoneInfo("America/New_York"),
            ),
        }
        delays = []

        async def fake_wait_for_stop(stop_event, delay):
            delays.append(delay)
            if len(delays) == 3:
                stop_event.set()
                return True
            clock["now"] += timedelta(seconds=delay)
            return False

        scheduler = YieldCurveScheduler(
            _config(),
            spawn_exec=spawn_exec,
            wait_for_stop_fn=fake_wait_for_stop,
            now=lambda: clock["now"],
        )
        await scheduler.run(asyncio.Event())

        self.assertIn("--if-needed", spawned_commands[0])
        self.assertNotIn("--if-needed", spawned_commands[1])
        self.assertIn("--if-needed", spawned_commands[2])
        self.assertAlmostEqual(delays[0], 60.0, delta=0.01)
        self.assertEqual(delays[1:], [3600.0, 3600.0])

    async def test_failed_post_publication_refresh_retries_forced_after_ten_minutes(self):
        spawned_commands = []
        processes = [
            _UpdaterProcess({
                "status": "not_due",
                "snapshot": {"curveAsOf": "2026-07-23"},
            }),
            _UpdaterProcess({
                "status": "cache_fallback",
                "snapshot": {"curveAsOf": "2026-07-23"},
            }),
            _UpdaterProcess({
                "status": "updated",
                "snapshot": {"curveAsOf": "2026-07-23"},
            }),
        ]

        async def spawn_exec(*command, **_kwargs):
            spawned_commands.append(command)
            return processes.pop(0)

        clock = {
            "now": datetime(
                2026,
                7,
                23,
                18,
                5,
                tzinfo=ZoneInfo("America/New_York"),
            ),
        }
        delays = []

        async def fake_wait_for_stop(stop_event, delay):
            delays.append(delay)
            if len(delays) == 3:
                stop_event.set()
                return True
            clock["now"] += timedelta(seconds=delay)
            return False

        scheduler = YieldCurveScheduler(
            _config(),
            spawn_exec=spawn_exec,
            wait_for_stop_fn=fake_wait_for_stop,
            now=lambda: clock["now"],
        )
        await scheduler.run(asyncio.Event())

        self.assertIn("--if-needed", spawned_commands[0])
        self.assertNotIn("--if-needed", spawned_commands[1])
        self.assertNotIn("--if-needed", spawned_commands[2])
        self.assertAlmostEqual(delays[0], 0.0, delta=0.01)
        self.assertEqual(delays[1], 600.0)


class _FakeWebSocket:
    def __init__(self, incoming):
        self.incoming = list(incoming)
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def recv(self):
        if not self.incoming:
            raise AssertionError("No synthetic WebSocket message remains")
        return json.dumps(self.incoming.pop(0))


class IBStatusMonitorTest(unittest.IsolatedAsyncioTestCase):
    async def test_disconnected_status_is_observed_without_requesting_reconnect(self):
        request_ids = iter(["poll-1", "poll-2"])
        monitor = IBStatusMonitor(
            _config(),
            request_id_factory=lambda: next(request_ids),
        )
        websocket = _FakeWebSocket(
            [
                {"action": "portfolio_avg_cost_snapshot", "items": []},
                {"action": "ib_connection_status", "connected": True},
                {
                    "action": "ib_connection_status",
                    "requestId": "poll-1",
                    "connected": False,
                    "connecting": False,
                },
                {
                    "action": "ib_connection_status",
                    "requestId": "stale-poll",
                    "connected": True,
                },
                {
                    "action": "ib_connection_status",
                    "requestId": "poll-2",
                    "connected": False,
                    "connecting": True,
                },
            ]
        )

        await monitor.poll_socket(websocket)
        await monitor.poll_socket(websocket)

        self.assertEqual(
            websocket.sent,
            [
                {
                    "action": "request_ib_connection_status",
                    "requestId": "poll-1",
                },
                {
                    "action": "request_ib_connection_status",
                    "requestId": "poll-2",
                },
            ],
        )
        self.assertEqual(websocket.incoming, [])

    async def test_connected_status_never_requests_reconnect(self):
        monitor = IBStatusMonitor(
            _config(),
            request_id_factory=lambda: "connected-poll",
        )
        websocket = _FakeWebSocket(
            [{
                "action": "ib_connection_status",
                "requestId": "connected-poll",
                "connected": True,
                "connecting": False,
            }]
        )

        status = await monitor.poll_socket(websocket)

        self.assertTrue(status["connected"])
        self.assertEqual(
            websocket.sent,
            [{
                "action": "request_ib_connection_status",
                "requestId": "connected-poll",
            }],
        )


class _CriticalProcess:
    _next_pid = 4000

    def __init__(self):
        type(self)._next_pid += 1
        self.pid = type(self)._next_pid
        self.returncode = None
        self._finished = asyncio.Event()

    def finish(self, returncode):
        if self.returncode is None:
            self.returncode = returncode
            self._finished.set()

    async def wait(self):
        await self._finished.wait()
        return self.returncode


class _PassiveBackgroundService:
    async def run(self, stop_event):
        await stop_event.wait()


class ApplicationSupervisorTest(unittest.IsolatedAsyncioTestCase):
    async def _wait_for_children(self, spawned):
        for _ in range(20):
            if len(spawned) == 2:
                return
            await asyncio.sleep(0)
        self.fail("Supervisor did not spawn both critical children")

    async def test_clean_critical_child_exit_becomes_nonzero_supervisor_exit(self):
        spawned = []
        signals = []

        async def spawn_exec(*command, **kwargs):
            process = _CriticalProcess()
            spawned.append((command, kwargs, process))
            return process

        def process_signaler(process, signum):
            signals.append((process, signum))
            process.finish(-signum)

        passive = _PassiveBackgroundService()
        supervisor = ApplicationSupervisor(
            _config(),
            passive,
            passive,
            spawn_exec=spawn_exec,
            process_signaler=process_signaler,
            install_signal_handlers=False,
        )
        run_task = asyncio.create_task(supervisor.run())
        await self._wait_for_children(spawned)

        ib_process = spawned[1][2]
        ib_process.finish(0)
        exit_code = await asyncio.wait_for(run_task, timeout=1.0)

        self.assertEqual(exit_code, 1)
        http_process = spawned[0][2]
        self.assertIn((http_process, signal.SIGTERM), signals)
        self.assertNotIn((ib_process, signal.SIGTERM), signals)
        for _command, kwargs, _process in spawned:
            self.assertEqual(kwargs["cwd"], "/synthetic/repo")
            self.assertTrue(kwargs["start_new_session"])

    async def test_external_signal_is_propagated_without_reporting_child_failure(self):
        spawned = []
        signals = []

        async def spawn_exec(*command, **kwargs):
            process = _CriticalProcess()
            spawned.append((command, kwargs, process))
            return process

        def process_signaler(process, signum):
            signals.append((process, signum))
            process.finish(-signum)

        passive = _PassiveBackgroundService()
        supervisor = ApplicationSupervisor(
            _config(),
            passive,
            passive,
            spawn_exec=spawn_exec,
            process_signaler=process_signaler,
            install_signal_handlers=False,
        )
        run_task = asyncio.create_task(supervisor.run())
        await self._wait_for_children(spawned)

        supervisor.request_shutdown(signal.SIGTERM)
        exit_code = await asyncio.wait_for(run_task, timeout=1.0)

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            signals,
            [
                (spawned[0][2], signal.SIGTERM),
                (spawned[1][2], signal.SIGTERM),
            ],
        )


if __name__ == "__main__":
    unittest.main()
