import asyncio
import fcntl
import json
import os
import signal
import tempfile
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
        "yield_process_timeout_seconds": 1.0,
        "yield_daily_hour_ny": 9,
        "yield_daily_minute_ny": 30,
        "shutdown_grace_seconds": 1.0,
    }
    values.update(overrides)
    return SupervisorConfig(**values)


class YieldUpdateResultTest(unittest.TestCase):
    def test_cache_fallback_is_unsuccessful_even_with_zero_exit_code(self):
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
        self.assertTrue(outcome.unsuccessful)
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

        self.assertFalse(outcome.unsuccessful)

    def test_complete_updated_result_preserves_nonfatal_warning(self):
        outcome = parse_yield_update_result(
            0,
            json.dumps(
                {
                    "status": "updated",
                    "snapshot": {"curveAsOf": "2026-07-23"},
                    "warning": "dated history archive could not be written",
                }
            ),
        )

        self.assertFalse(outcome.unsuccessful)
        self.assertEqual(
            outcome.warning,
            "dated history archive could not be written",
        )

    def test_invalid_json_and_success_without_snapshot_are_retryable(self):
        invalid = parse_yield_update_result(0, "not-json")
        missing_snapshot = parse_yield_update_result(
            0,
            json.dumps({"status": "updated", "snapshot": None}),
        )

        self.assertEqual(invalid.status, "invalid_output")
        self.assertTrue(invalid.unsuccessful)
        self.assertTrue(missing_snapshot.unsuccessful)


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

    def test_daily_time_defaults_to_0930_ny_and_is_overridable(self):
        with patch.dict(os.environ, {}, clear=True):
            default_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))
        with patch.dict(
            os.environ,
            {
                "OPTION_COMBO_YIELD_DAILY_HOUR_NY": "10",
                "OPTION_COMBO_YIELD_DAILY_MINUTE_NY": "15",
            },
            clear=True,
        ):
            overridden_config = SupervisorConfig.from_environment(Path("/synthetic/repo"))

        self.assertEqual(default_config.yield_daily_hour_ny, 9)
        self.assertEqual(default_config.yield_daily_minute_ny, 30)
        self.assertEqual(overridden_config.yield_daily_hour_ny, 10)
        self.assertEqual(overridden_config.yield_daily_minute_ny, 15)

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
    async def test_waits_until_0930_ny_then_runs_once_with_if_needed(self):
        spawned_commands = []
        process = _UpdaterProcess({
                "status": "updated",
                "snapshot": {"curveAsOf": "2026-07-23"},
        })
        clock = {
            "now": datetime(2026, 7, 23, 9, 29, tzinfo=ZoneInfo("America/New_York")),
        }

        with tempfile.TemporaryDirectory() as data_dir:
            async def spawn_exec(*command, **_kwargs):
                marker = Path(data_dir) / ".option_combo_last_yield_attempt_ny"
                self.assertEqual(marker.read_text(encoding="utf-8").strip(), "2026-07-23")
                spawned_commands.append(command)
                return process

            delays = []

            async def fake_wait_for_stop(stop_event, delay):
                delays.append(delay)
                if spawned_commands:
                    stop_event.set()
                    return True
                clock["now"] += timedelta(seconds=delay)
                return False

            scheduler = YieldCurveScheduler(
                _config(yield_curve_data_dir=Path(data_dir)),
                spawn_exec=spawn_exec,
                wait_for_stop_fn=fake_wait_for_stop,
                now=lambda: clock["now"],
            )
            await scheduler.run(asyncio.Event())

        self.assertEqual(len(spawned_commands), 1)
        self.assertIn("--if-needed", spawned_commands[0])
        self.assertIn("--json", spawned_commands[0])
        data_dir_index = spawned_commands[0].index("--data-dir")
        self.assertEqual(spawned_commands[0][data_dir_index + 1], data_dir)
        self.assertAlmostEqual(delays[0], 60.0, delta=0.01)
        self.assertAlmostEqual(delays[1], 24 * 60 * 60, delta=0.01)

    async def test_failed_attempt_is_not_retried_and_marker_survives_restart(self):
        spawned_commands = []
        clock = {
            "now": datetime(2026, 7, 23, 10, 0, tzinfo=ZoneInfo("America/New_York")),
        }

        with tempfile.TemporaryDirectory() as data_dir:
            async def spawn_exec(*command, **_kwargs):
                spawned_commands.append(command)
                return _UpdaterProcess({
                    "status": "cache_fallback",
                    "snapshot": {"curveAsOf": "2026-07-22"},
                })

            first_delays = []

            async def stop_after_first_attempt(stop_event, delay):
                first_delays.append(delay)
                stop_event.set()
                return True

            first = YieldCurveScheduler(
                _config(yield_curve_data_dir=Path(data_dir)),
                spawn_exec=spawn_exec,
                wait_for_stop_fn=stop_after_first_attempt,
                now=lambda: clock["now"],
            )
            await first.run(asyncio.Event())

            second_delays = []

            async def stop_without_attempt(stop_event, delay):
                second_delays.append(delay)
                stop_event.set()
                return True

            second = YieldCurveScheduler(
                _config(yield_curve_data_dir=Path(data_dir)),
                spawn_exec=spawn_exec,
                wait_for_stop_fn=stop_without_attempt,
                now=lambda: clock["now"] + timedelta(minutes=5),
            )
            await second.run(asyncio.Event())

        self.assertEqual(len(spawned_commands), 1)
        self.assertEqual(len(first_delays), 1)
        self.assertEqual(len(second_delays), 1)
        self.assertAlmostEqual(first_delays[0], 23.5 * 60 * 60, delta=0.01)
        self.assertAlmostEqual(
            second_delays[0],
            23.5 * 60 * 60 - 5 * 60,
            delta=0.01,
        )

    async def test_marker_write_failure_does_not_launch_untracked_attempt(self):
        spawned_commands = []

        async def spawn_exec(*command, **_kwargs):
            spawned_commands.append(command)
            return _UpdaterProcess({
                "status": "updated",
                "snapshot": {"curveAsOf": "2026-07-23"},
            })

        async def stop_after_skip(stop_event, _delay):
            stop_event.set()
            return True

        with tempfile.TemporaryDirectory() as data_dir:
            scheduler = YieldCurveScheduler(
                _config(yield_curve_data_dir=Path(data_dir)),
                spawn_exec=spawn_exec,
                wait_for_stop_fn=stop_after_skip,
                now=lambda: datetime(
                    2026,
                    7,
                    23,
                    10,
                    0,
                    tzinfo=ZoneInfo("America/New_York"),
                ),
            )
            with patch.object(
                scheduler,
                "_claim_attempt_date",
                return_value=False,
            ):
                await scheduler.run(asyncio.Event())

        self.assertEqual(spawned_commands, [])

    def test_attempt_claim_rechecks_persisted_date_across_supervisors(self):
        with tempfile.TemporaryDirectory() as data_dir:
            config = _config(yield_curve_data_dir=Path(data_dir))
            first = YieldCurveScheduler(config)
            second = YieldCurveScheduler(config)
            attempt_date = datetime(2026, 7, 23).date()

            self.assertTrue(first._claim_attempt_date(attempt_date))
            self.assertFalse(second._claim_attempt_date(attempt_date))

    def test_busy_attempt_claim_lock_is_nonblocking_and_fails_closed(self):
        operations = []

        def busy_lock(_descriptor, operation):
            operations.append(operation)
            if operation & fcntl.LOCK_NB:
                raise BlockingIOError

        with tempfile.TemporaryDirectory() as data_dir:
            scheduler = YieldCurveScheduler(
                _config(yield_curve_data_dir=Path(data_dir)),
            )
            with patch(
                "option_combo_starter.supervisor.fcntl.flock",
                side_effect=busy_lock,
            ):
                claimed = scheduler._claim_attempt_date(
                    datetime(2026, 7, 23).date(),
                )

        self.assertFalse(claimed)
        self.assertTrue(operations[0] & fcntl.LOCK_NB)

    async def test_malformed_marker_fails_closed_for_its_modified_ny_date(self):
        spawned_commands = []

        async def spawn_exec(*command, **_kwargs):
            spawned_commands.append(command)
            return _UpdaterProcess({
                "status": "updated",
                "snapshot": {"curveAsOf": "2026-07-23"},
            })

        async def stop_after_skip(stop_event, _delay):
            stop_event.set()
            return True

        with tempfile.TemporaryDirectory() as data_dir:
            marker = Path(data_dir) / ".option_combo_last_yield_attempt_ny"
            marker.write_text("not-a-date\n", encoding="utf-8")
            modified = datetime(
                2026,
                7,
                23,
                9,
                30,
                tzinfo=ZoneInfo("America/New_York"),
            ).timestamp()
            os.utime(marker, (modified, modified))
            scheduler = YieldCurveScheduler(
                _config(yield_curve_data_dir=Path(data_dir)),
                spawn_exec=spawn_exec,
                wait_for_stop_fn=stop_after_skip,
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

        self.assertEqual(spawned_commands, [])

    def test_future_and_non_utf8_markers_are_repaired_fail_closed(self):
        reference_date = datetime(2026, 7, 23).date()
        modified = datetime(
            2026,
            7,
            23,
            9,
            30,
            tzinfo=ZoneInfo("America/New_York"),
        ).timestamp()

        for marker_bytes in (b"2099-01-01\n", b"\xff\xfe"):
            with self.subTest(marker_bytes=marker_bytes):
                with tempfile.TemporaryDirectory() as data_dir:
                    scheduler = YieldCurveScheduler(
                        _config(yield_curve_data_dir=Path(data_dir)),
                    )
                    marker = Path(data_dir) / ".option_combo_last_yield_attempt_ny"
                    marker.write_bytes(marker_bytes)
                    os.utime(marker, (modified, modified))

                    persisted, readable = scheduler._load_attempt_date(
                        reference_date,
                    )

                    self.assertTrue(readable)
                    self.assertEqual(persisted, reference_date)
                    self.assertEqual(
                        marker.read_text(encoding="utf-8").strip(),
                        reference_date.isoformat(),
                    )

    def test_reading_invalid_marker_is_side_effect_free_until_locked_repair(self):
        reference_date = datetime(2026, 7, 23).date()
        marker_bytes = b"not-a-date\n"

        with tempfile.TemporaryDirectory() as data_dir:
            scheduler = YieldCurveScheduler(
                _config(yield_curve_data_dir=Path(data_dir)),
            )
            marker = Path(data_dir) / ".option_combo_last_yield_attempt_ny"
            marker.write_bytes(marker_bytes)

            persisted, readable, repair_needed = scheduler._read_attempt_date(
                reference_date,
            )

            self.assertTrue(readable)
            self.assertTrue(repair_needed)
            self.assertIsNotNone(persisted)
            self.assertEqual(marker.read_bytes(), marker_bytes)

    def test_friday_attempt_schedules_monday_0930_across_dst(self):
        with tempfile.TemporaryDirectory() as data_dir:
            scheduler = YieldCurveScheduler(
                _config(yield_curve_data_dir=Path(data_dir)),
                now=lambda: datetime(
                    2026,
                    10,
                    30,
                    10,
                    0,
                    tzinfo=ZoneInfo("America/New_York"),
                ),
            )
            next_attempt = scheduler._next_scheduled_attempt(
                scheduler._new_york_now(),
                datetime(2026, 10, 30).date(),
            )

        self.assertEqual(
            next_attempt,
            datetime(
                2026,
                11,
                2,
                9,
                30,
                tzinfo=ZoneInfo("America/New_York"),
            ),
        )
        self.assertEqual(
            (
                next_attempt.astimezone(ZoneInfo("UTC"))
                - datetime(
                    2026,
                    10,
                    30,
                    10,
                    0,
                    tzinfo=ZoneInfo("America/New_York"),
                ).astimezone(ZoneInfo("UTC"))
            ).total_seconds(),
            72.5 * 60 * 60,
        )


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


class _ExplodingBackgroundService:
    async def run(self, _stop_event):
        raise RuntimeError("synthetic optional service failure")


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

    async def test_optional_yield_scheduler_failure_does_not_restart_container(self):
        spawned = []

        async def spawn_exec(*command, **kwargs):
            process = _CriticalProcess()
            spawned.append((command, kwargs, process))
            return process

        def process_signaler(process, signum):
            process.finish(-signum)

        supervisor = ApplicationSupervisor(
            _config(),
            _PassiveBackgroundService(),
            _ExplodingBackgroundService(),
            spawn_exec=spawn_exec,
            process_signaler=process_signaler,
            install_signal_handlers=False,
        )
        run_task = asyncio.create_task(supervisor.run())
        await self._wait_for_children(spawned)
        for _ in range(5):
            await asyncio.sleep(0)

        self.assertFalse(run_task.done())
        supervisor.request_shutdown(signal.SIGTERM)
        self.assertEqual(await asyncio.wait_for(run_task, timeout=1.0), 0)


if __name__ == "__main__":
    unittest.main()
