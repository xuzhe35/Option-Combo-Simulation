#!/usr/bin/env python3
"""PID-1 process supervision for the Option Combo Docker image.

The supervisor owns only container lifecycle concerns:

* the HTTP server and ``ib_server.py`` are critical child processes;
* an ordinary IB/TWS disconnect is observed through the backend WebSocket and
  left to the backend's single reconnect owner, without restarting a child;
* yield-curve maintenance runs independently of IB connectivity.

The module deliberately uses direct argument lists (never a shell), starts each
child in its own process group, and forwards termination signals to those
groups.  It can therefore be used as PID 1 without leaving grandchildren
behind when Docker stops the container.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import logging
import os
import signal
import sys
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo


LOGGER = logging.getLogger("option_combo_supervisor")

DEFAULT_REPO_DIR = Path("/app/Option-Combo-Simulation")
DEFAULT_HTTP_PORT = 8000
DEFAULT_WS_PORT = 8765
DEFAULT_IB_STATUS_HOST = "127.0.0.1"
DEFAULT_IB_STATUS_POLL_SECONDS = 30.0
DEFAULT_WS_RETRY_SECONDS = 5.0
DEFAULT_WS_RESPONSE_TIMEOUT_SECONDS = 10.0
DEFAULT_YIELD_CURVE_DATA_DIR = Path("/app/state/yield_curve")
DEFAULT_YIELD_PROCESS_TIMEOUT_SECONDS = 120.0
DEFAULT_YIELD_DAILY_HOUR_NY = 9
DEFAULT_YIELD_DAILY_MINUTE_NY = 30
YIELD_ATTEMPT_MARKER_FILENAME = ".option_combo_last_yield_attempt_ny"
YIELD_ATTEMPT_LOCK_FILENAME = ".option_combo_yield_attempt_claim.lock"
NEW_YORK_TIMEZONE = ZoneInfo("America/New_York")
# Docker's default stop timeout is ten seconds.  Keep the internal grace below
# that boundary so PID 1 still has time to escalate and reap before Docker
# applies its own unconditional SIGKILL.
DEFAULT_SHUTDOWN_GRACE_SECONDS = 8.0

SpawnExec = Callable[..., Awaitable[Any]]
WaitForStop = Callable[[asyncio.Event, float], Awaitable[bool]]
ProcessSignaler = Callable[[Any, int], None]


def _positive_float_from_env(name: str, default: float, minimum: float = 0.1) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        LOGGER.warning("Ignoring invalid numeric setting %s.", name)
        return default
    if value < minimum:
        LOGGER.warning("Ignoring %s below its minimum of %s.", name, minimum)
        return default
    return value


def _port_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        LOGGER.warning("Ignoring invalid port setting %s.", name)
        return default
    if not 1 <= value <= 65535:
        LOGGER.warning("Ignoring out-of-range port setting %s.", name)
        return default
    return value


def _hour_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        LOGGER.warning("Ignoring invalid hour setting %s.", name)
        return default
    if not 0 <= value <= 23:
        LOGGER.warning("Ignoring out-of-range hour setting %s.", name)
        return default
    return value


def _minute_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        LOGGER.warning("Ignoring invalid minute setting %s.", name)
        return default
    if not 0 <= value <= 59:
        LOGGER.warning("Ignoring out-of-range minute setting %s.", name)
        return default
    return value


def _ib_status_host_from_env() -> str:
    """Resolve a connectable local address from the backend bind setting."""

    explicit = str(os.environ.get("OPTION_COMBO_IB_STATUS_HOST") or "").strip()
    if explicit:
        return explicit.strip("[]")

    configured_hosts = str(os.environ.get("WS_HOST") or "").split(",")
    for raw_host in configured_hosts:
        host = raw_host.strip().strip("[]")
        if not host:
            continue
        if host in {"0.0.0.0", "*"}:
            return DEFAULT_IB_STATUS_HOST
        if host == "::":
            return "::1"
        return host
    return DEFAULT_IB_STATUS_HOST


async def wait_for_stop(stop_event: asyncio.Event, timeout_seconds: float) -> bool:
    """Return True when stopped, or False after the timeout elapses."""

    if stop_event.is_set():
        return True
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=max(0.0, timeout_seconds))
        return True
    except asyncio.TimeoutError:
        return False


def signal_process_group(process: Any, signum: int) -> None:
    """Signal a child process group, tolerating a concurrent child exit."""

    if getattr(process, "returncode", None) is not None:
        return
    pid = getattr(process, "pid", None)
    if not pid:
        return
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        return


async def terminate_process(
    process: Any,
    *,
    process_signaler: ProcessSignaler,
    grace_seconds: float,
    initial_signal: int = signal.SIGTERM,
) -> None:
    """Stop and reap one process, escalating to SIGKILL after a grace period."""

    if getattr(process, "returncode", None) is not None:
        return
    process_signaler(process, initial_signal)
    waiter = asyncio.create_task(process.wait())
    done, _pending = await asyncio.wait({waiter}, timeout=grace_seconds)
    if done:
        waiter.result()
        return
    LOGGER.error("Child pid=%s ignored signal %s; sending SIGKILL.", process.pid, initial_signal)
    process_signaler(process, signal.SIGKILL)
    await waiter


@dataclass(frozen=True)
class SupervisorConfig:
    repo_dir: Path
    python_executable: str
    http_port: int = DEFAULT_HTTP_PORT
    ws_port: int = DEFAULT_WS_PORT
    ib_status_host: str = DEFAULT_IB_STATUS_HOST
    ib_status_poll_seconds: float = DEFAULT_IB_STATUS_POLL_SECONDS
    ws_retry_seconds: float = DEFAULT_WS_RETRY_SECONDS
    ws_response_timeout_seconds: float = DEFAULT_WS_RESPONSE_TIMEOUT_SECONDS
    yield_curve_data_dir: Path = DEFAULT_YIELD_CURVE_DATA_DIR
    yield_process_timeout_seconds: float = DEFAULT_YIELD_PROCESS_TIMEOUT_SECONDS
    yield_daily_hour_ny: int = DEFAULT_YIELD_DAILY_HOUR_NY
    yield_daily_minute_ny: int = DEFAULT_YIELD_DAILY_MINUTE_NY
    shutdown_grace_seconds: float = DEFAULT_SHUTDOWN_GRACE_SECONDS

    @classmethod
    def from_environment(cls, repo_dir: Path) -> "SupervisorConfig":
        return cls(
            repo_dir=repo_dir,
            python_executable=sys.executable,
            http_port=DEFAULT_HTTP_PORT,
            ws_port=_port_from_env("WS_PORT", DEFAULT_WS_PORT),
            ib_status_host=_ib_status_host_from_env(),
            ib_status_poll_seconds=_positive_float_from_env(
                "OPTION_COMBO_IB_STATUS_POLL_SECONDS",
                DEFAULT_IB_STATUS_POLL_SECONDS,
            ),
            ws_retry_seconds=_positive_float_from_env(
                "OPTION_COMBO_WS_RETRY_SECONDS",
                DEFAULT_WS_RETRY_SECONDS,
            ),
            ws_response_timeout_seconds=_positive_float_from_env(
                "OPTION_COMBO_WS_RESPONSE_TIMEOUT_SECONDS",
                DEFAULT_WS_RESPONSE_TIMEOUT_SECONDS,
            ),
            yield_curve_data_dir=Path(
                os.environ.get(
                    "YIELD_CURVE_DATA_DIR",
                    str(DEFAULT_YIELD_CURVE_DATA_DIR),
                )
            ),
            yield_process_timeout_seconds=_positive_float_from_env(
                "OPTION_COMBO_YIELD_PROCESS_TIMEOUT_SECONDS",
                DEFAULT_YIELD_PROCESS_TIMEOUT_SECONDS,
                minimum=1.0,
            ),
            yield_daily_hour_ny=_hour_from_env(
                "OPTION_COMBO_YIELD_DAILY_HOUR_NY",
                DEFAULT_YIELD_DAILY_HOUR_NY,
            ),
            yield_daily_minute_ny=_minute_from_env(
                "OPTION_COMBO_YIELD_DAILY_MINUTE_NY",
                DEFAULT_YIELD_DAILY_MINUTE_NY,
            ),
            shutdown_grace_seconds=_positive_float_from_env(
                "OPTION_COMBO_SHUTDOWN_GRACE_SECONDS",
                DEFAULT_SHUTDOWN_GRACE_SECONDS,
                minimum=1.0,
            ),
        )


@dataclass(frozen=True)
class YieldUpdateOutcome:
    status: str
    returncode: int
    unsuccessful: bool
    curve_as_of: str = ""
    error: str = ""
    warning: str = ""


def parse_yield_update_result(
    returncode: int,
    stdout: bytes | str,
) -> YieldUpdateOutcome:
    """Interpret ``yield_curve update --json`` output.

    ``cache_fallback`` intentionally exits zero because a cached snapshot is
    still usable. The outcome remains unsuccessful for logging, but the daily
    scheduler does not retry it on the same New York date.
    """

    text = stdout.decode("utf-8", errors="replace") if isinstance(stdout, bytes) else str(stdout)
    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return YieldUpdateOutcome(
            status="invalid_output",
            returncode=int(returncode),
            unsuccessful=True,
        )
    if not isinstance(payload, Mapping):
        return YieldUpdateOutcome(
            status="invalid_output",
            returncode=int(returncode),
            unsuccessful=True,
        )

    status = str(payload.get("status") or "unknown").strip().lower()
    snapshot = payload.get("snapshot")
    curve_as_of = ""
    if isinstance(snapshot, Mapping):
        curve_as_of = str(snapshot.get("curveAsOf") or "")
    error = str(payload.get("error") or "").strip()
    warning = str(payload.get("warning") or "").strip()

    complete_status = status in {"updated", "not_due"}
    complete_snapshot = isinstance(snapshot, Mapping)
    unsuccessful = (
        int(returncode) != 0
        or not complete_status
        or not complete_snapshot
    )
    return YieldUpdateOutcome(
        status=status,
        returncode=int(returncode),
        unsuccessful=unsuccessful,
        curve_as_of=curve_as_of,
        error=error,
        warning=warning,
    )


class YieldCurveScheduler:
    """Run at most one persistent updater attempt per New York weekday."""

    def __init__(
        self,
        config: SupervisorConfig,
        *,
        spawn_exec: SpawnExec = asyncio.create_subprocess_exec,
        wait_for_stop_fn: WaitForStop = wait_for_stop,
        process_signaler: ProcessSignaler = signal_process_group,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ):
        self.config = config
        self._spawn_exec = spawn_exec
        self._wait_for_stop = wait_for_stop_fn
        self._process_signaler = process_signaler
        self._now = now
        self._active_process: Optional[Any] = None
        self._attempt_marker_path = (
            self.config.yield_curve_data_dir / YIELD_ATTEMPT_MARKER_FILENAME
        )
        self._attempt_lock_path = (
            self.config.yield_curve_data_dir / YIELD_ATTEMPT_LOCK_FILENAME
        )

    def _new_york_now(self) -> datetime:
        instant = self._now()
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=timezone.utc)
        return instant.astimezone(NEW_YORK_TIMEZONE)

    def _scheduled_time(self, local_date: date) -> datetime:
        return datetime(
            local_date.year,
            local_date.month,
            local_date.day,
            self.config.yield_daily_hour_ny,
            self.config.yield_daily_minute_ny,
            tzinfo=NEW_YORK_TIMEZONE,
        )

    def _next_scheduled_attempt(
        self,
        local_now: datetime,
        last_attempt_date: Optional[date],
    ) -> datetime:
        local_now = local_now.astimezone(NEW_YORK_TIMEZONE)
        candidate_date = local_now.date()
        attempted_today = (
            last_attempt_date is not None
            and last_attempt_date >= candidate_date
        )
        candidate = self._scheduled_time(candidate_date)
        if candidate_date.weekday() < 5 and not attempted_today:
            if local_now >= candidate:
                return local_now
            return candidate

        candidate_date += timedelta(days=1)
        while candidate_date.weekday() >= 5:
            candidate_date += timedelta(days=1)
        return self._scheduled_time(candidate_date)

    def _marker_modified_date(self, reference_date: date) -> Optional[date]:
        try:
            modified = self._attempt_marker_path.stat().st_mtime
        except OSError:
            return None
        modified_date = datetime.fromtimestamp(
            modified,
            tz=timezone.utc,
        ).astimezone(NEW_YORK_TIMEZONE).date()
        return min(modified_date, reference_date)

    def _read_attempt_date(
        self,
        reference_date: date,
    ) -> tuple[Optional[date], bool, bool]:
        """Return date, readability, and whether fail-closed repair is needed."""

        try:
            raw = self._attempt_marker_path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return None, True, False
        except UnicodeError:
            raw = ""
        except OSError as exc:
            LOGGER.error(
                "Cannot read yield-curve attempt marker %s (%s); "
                "skipping today's optional attempt.",
                self._attempt_marker_path,
                type(exc).__name__,
            )
            return None, False, False
        try:
            persisted_date = date.fromisoformat(raw)
        except ValueError:
            persisted_date = None

        if persisted_date is not None and persisted_date <= reference_date:
            return persisted_date, True, False

        fallback_date = self._marker_modified_date(reference_date)
        if fallback_date is None:
            LOGGER.error(
                "Cannot establish a safe date for invalid yield-curve "
                "attempt marker %s; skipping today's optional attempt.",
                self._attempt_marker_path,
            )
            return None, False, False
        if persisted_date is None:
            LOGGER.warning(
                "Invalid yield-curve attempt marker %s is treated as an "
                "attempt on its modified New York date %s.",
                self._attempt_marker_path,
                fallback_date,
            )
        else:
            LOGGER.warning(
                "Future yield-curve attempt marker date %s is clamped to %s.",
                persisted_date,
                fallback_date,
            )
        return fallback_date, True, True

    def _write_attempt_date(self, attempt_date: date) -> bool:
        """Atomically persist a date before any updater network work begins."""

        temporary_path = self._attempt_marker_path.with_name(
            ".{}.{}.tmp".format(
                self._attempt_marker_path.name,
                uuid.uuid4().hex,
            )
        )
        try:
            self.config.yield_curve_data_dir.mkdir(parents=True, exist_ok=True)
            with temporary_path.open("x", encoding="utf-8", newline="\n") as marker:
                marker.write(attempt_date.isoformat() + "\n")
                marker.flush()
                os.fsync(marker.fileno())
            os.replace(temporary_path, self._attempt_marker_path)
            if hasattr(os, "O_DIRECTORY"):
                directory_fd = os.open(
                    str(self.config.yield_curve_data_dir),
                    os.O_RDONLY | os.O_DIRECTORY,
                )
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            return True
        except OSError as exc:
            LOGGER.error(
                "Cannot persist yield-curve attempt marker %s (%s); "
                "skipping this optional attempt.",
                self._attempt_marker_path,
                type(exc).__name__,
            )
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                LOGGER.warning(
                    "Could not remove temporary yield-curve marker %s.",
                    temporary_path,
                )
            return False

    def _acquire_attempt_lock(self) -> Optional[int]:
        try:
            self.config.yield_curve_data_dir.mkdir(parents=True, exist_ok=True)
            lock_fd = os.open(
                str(self._attempt_lock_path),
                os.O_CREAT | os.O_RDWR,
                0o600,
            )
        except OSError as exc:
            LOGGER.error(
                "Cannot open yield-curve attempt lock %s (%s); "
                "skipping this optional maintenance operation.",
                self._attempt_lock_path,
                type(exc).__name__,
            )
            return None

        try:
            fcntl.flock(
                lock_fd,
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )
            return lock_fd
        except BlockingIOError:
            LOGGER.warning(
                "Another supervisor owns the optional yield-curve attempt "
                "lock; this supervisor will skip the operation."
            )
        except OSError as exc:
            LOGGER.error(
                "Cannot acquire yield-curve attempt lock %s (%s); "
                "skipping this optional maintenance operation.",
                self._attempt_lock_path,
                type(exc).__name__,
            )
        try:
            os.close(lock_fd)
        except OSError:
            LOGGER.warning(
                "Could not close unclaimed yield-curve attempt lock %s.",
                self._attempt_lock_path,
            )
        return None

    def _release_attempt_lock(self, lock_fd: int) -> None:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except OSError:
            LOGGER.warning(
                "Could not explicitly release yield-curve attempt lock %s.",
                self._attempt_lock_path,
            )
        try:
            os.close(lock_fd)
        except OSError:
            LOGGER.warning(
                "Could not close yield-curve attempt lock %s.",
                self._attempt_lock_path,
            )

    def _load_attempt_date(
        self,
        reference_date: date,
    ) -> tuple[Optional[date], bool]:
        """Read and repair marker anomalies under the interprocess lock."""

        lock_fd = self._acquire_attempt_lock()
        if lock_fd is None:
            return reference_date, False
        try:
            persisted_date, marker_readable, repair_needed = (
                self._read_attempt_date(reference_date)
            )
            if (
                marker_readable
                and repair_needed
                and persisted_date is not None
                and not self._write_attempt_date(persisted_date)
            ):
                return reference_date, False
            return persisted_date, marker_readable
        finally:
            self._release_attempt_lock(lock_fd)

    def _claim_attempt_date(self, attempt_date: date) -> bool:
        """Serialize the read/write claim across supervisors sharing a volume."""

        lock_fd = self._acquire_attempt_lock()
        if lock_fd is None:
            return False
        try:
            persisted_date, marker_readable, repair_needed = (
                self._read_attempt_date(attempt_date)
            )
            if not marker_readable:
                return False
            if persisted_date is not None and persisted_date >= attempt_date:
                if repair_needed:
                    self._write_attempt_date(persisted_date)
                return False
            return self._write_attempt_date(attempt_date)
        finally:
            self._release_attempt_lock(lock_fd)

    def _command(self, *, if_needed: bool) -> list[str]:
        command = [
            self.config.python_executable,
            "-m",
            "yield_curve",
            "update",
        ]
        if if_needed:
            command.append("--if-needed")
        command.extend(
            [
                "--data-dir",
                str(self.config.yield_curve_data_dir),
                "--json",
            ]
        )
        return command

    async def run_once(self, *, if_needed: bool) -> YieldUpdateOutcome:
        command = self._command(if_needed=if_needed)
        try:
            process = await self._spawn_exec(
                *command,
                cwd=str(self.config.repo_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except (OSError, RuntimeError) as exc:
            LOGGER.error("Unable to start yield-curve updater: %s", type(exc).__name__)
            return YieldUpdateOutcome(
                status="spawn_error",
                returncode=1,
                unsuccessful=True,
            )

        self._active_process = process
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=self.config.yield_process_timeout_seconds,
            )
        except asyncio.TimeoutError:
            LOGGER.error("Yield-curve updater exceeded its %.0fs timeout.", self.config.yield_process_timeout_seconds)
            await terminate_process(
                process,
                process_signaler=self._process_signaler,
                grace_seconds=self.config.shutdown_grace_seconds,
            )
            return YieldUpdateOutcome(
                status="timeout",
                returncode=1,
                unsuccessful=True,
            )
        except asyncio.CancelledError:
            await terminate_process(
                process,
                process_signaler=self._process_signaler,
                grace_seconds=self.config.shutdown_grace_seconds,
            )
            raise
        finally:
            self._active_process = None

        outcome = parse_yield_update_result(process.returncode or 0, stdout)
        log = LOGGER.warning if outcome.unsuccessful or outcome.warning else LOGGER.info
        diagnostic = outcome.error or outcome.warning
        diagnostic_name = "error" if outcome.error or outcome.unsuccessful else "warning"
        if not diagnostic and outcome.unsuccessful:
            diagnostic = (
                stderr.decode("utf-8", errors="replace")
                if isinstance(stderr, bytes)
                else str(stderr or "")
            ).strip()
        diagnostic = " ".join(diagnostic.split())[:1000]
        if diagnostic:
            log(
                "Yield-curve updater status=%s curveAsOf=%s %s=%s.",
                outcome.status,
                outcome.curve_as_of or "<none>",
                diagnostic_name,
                diagnostic,
            )
        else:
            log(
                "Yield-curve updater status=%s curveAsOf=%s.",
                outcome.status,
                outcome.curve_as_of or "<none>",
            )
        return outcome

    async def run(self, stop_event: asyncio.Event) -> None:
        local_today = self._new_york_now().date()
        last_attempt_date, marker_readable = self._load_attempt_date(local_today)
        if not marker_readable:
            # Fail closed: an unreadable marker must not turn a restart into a
            # second network attempt for the same New York date.
            last_attempt_date = self._new_york_now().date()

        while not stop_event.is_set():
            local_now = self._new_york_now()
            next_attempt = self._next_scheduled_attempt(
                local_now,
                last_attempt_date,
            )
            delay = max(
                (
                    next_attempt.astimezone(timezone.utc)
                    - local_now.astimezone(timezone.utc)
                ).total_seconds(),
                0.0,
            )
            if delay > 0:
                LOGGER.info(
                    "Next optional yield-curve attempt is %s "
                    "(in %.0fs).",
                    next_attempt.isoformat(),
                    delay,
                )
                if await self._wait_for_stop(stop_event, delay):
                    return
                continue

            attempt_date = local_now.date()
            last_attempt_date = attempt_date
            if not self._claim_attempt_date(attempt_date):
                continue

            LOGGER.info(
                "Running the daily optional yield-curve attempt for %s.",
                attempt_date.isoformat(),
            )
            outcome = await self.run_once(if_needed=True)
            if outcome.unsuccessful:
                LOGGER.warning(
                    "Yield-curve attempt for %s was not successful; "
                    "retaining the previous snapshot and waiting until the "
                    "next New York weekday.",
                    attempt_date.isoformat(),
                )


def websocket_connector(uri: str, **kwargs: Any) -> Any:
    """Import lazily so unit tests do not require the runtime dependency."""

    import websockets

    return websockets.connect(uri, **kwargs)


def status_request_id() -> str:
    return f"option-combo-supervisor:{uuid.uuid4().hex}"


class IBStatusMonitor:
    """Observe IB state while leaving reconnect ownership to the backend."""

    def __init__(
        self,
        config: SupervisorConfig,
        *,
        connector: Callable[..., Any] = websocket_connector,
        wait_for_stop_fn: WaitForStop = wait_for_stop,
        request_id_factory: Callable[[], str] = status_request_id,
    ):
        self.config = config
        self._connector = connector
        self._wait_for_stop = wait_for_stop_fn
        self._request_id_factory = request_id_factory
        self._last_observed_state: Optional[tuple[bool, bool, bool]] = None
        uri_host = (
            f"[{config.ib_status_host}]"
            if ":" in config.ib_status_host
            else config.ib_status_host
        )
        self.uri = f"ws://{uri_host}:{config.ws_port}"

    async def _receive_action(
        self,
        websocket: Any,
        expected_action: str,
        request_id: str,
    ) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.config.ws_response_timeout_seconds
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError
            raw = await asyncio.wait_for(websocket.recv(), timeout=remaining)
            try:
                payload = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if (
                isinstance(payload, dict)
                and payload.get("action") == expected_action
                and payload.get("requestId") == request_id
            ):
                return payload

    async def poll_socket(self, websocket: Any) -> Dict[str, Any]:
        request_id = str(self._request_id_factory() or "").strip()
        if not request_id:
            raise RuntimeError("Status request ID factory returned an empty value.")
        await websocket.send(
            json.dumps(
                {
                    "action": "request_ib_connection_status",
                    "requestId": request_id,
                }
            )
        )
        status = await self._receive_action(
            websocket,
            "ib_connection_status",
            request_id,
        )
        observed_state = (
            status.get("connected") is True,
            status.get("connecting") is True,
            status.get("reconnecting") is True,
        )
        if observed_state != self._last_observed_state:
            connected, connecting, reconnecting = observed_state
            if connected:
                LOGGER.info("IB connection status: connected.")
            elif connecting:
                LOGGER.warning(
                    "IB connection status: connection attempt in progress."
                )
            elif reconnecting:
                LOGGER.warning(
                    "IB connection status: disconnected; backend retry is scheduled."
                )
            else:
                LOGGER.warning(
                    "IB connection status: disconnected; no backend retry is active."
                )
            self._last_observed_state = observed_state
        return status

    async def run(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                async with self._connector(
                    self.uri,
                    open_timeout=self.config.ws_response_timeout_seconds,
                    close_timeout=self.config.ws_response_timeout_seconds,
                    ping_interval=20,
                    ping_timeout=20,
                ) as websocket:
                    LOGGER.info("Connected supervisor monitor to %s.", self.uri)
                    while not stop_event.is_set():
                        await self.poll_socket(websocket)
                        if await self._wait_for_stop(
                            stop_event,
                            self.config.ib_status_poll_seconds,
                        ):
                            return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOGGER.warning(
                    "Backend status monitor unavailable (%s); retrying in %.0fs.",
                    type(exc).__name__,
                    self.config.ws_retry_seconds,
                )
                if await self._wait_for_stop(stop_event, self.config.ws_retry_seconds):
                    return


class ApplicationSupervisor:
    """Own critical children plus required and optional background loops."""

    def __init__(
        self,
        config: SupervisorConfig,
        monitor: IBStatusMonitor,
        yield_scheduler: YieldCurveScheduler,
        *,
        spawn_exec: SpawnExec = asyncio.create_subprocess_exec,
        process_signaler: ProcessSignaler = signal_process_group,
        install_signal_handlers: bool = True,
    ):
        self.config = config
        self.monitor = monitor
        self.yield_scheduler = yield_scheduler
        self._spawn_exec = spawn_exec
        self._process_signaler = process_signaler
        self._install_signal_handlers_enabled = install_signal_handlers
        self._children: Dict[str, Any] = {}
        self._stop_event = asyncio.Event()
        self._received_signal: Optional[int] = None
        self._installed_signals: list[int] = []

    def request_shutdown(self, signum: int) -> None:
        if self._received_signal is None:
            self._received_signal = signum
            LOGGER.info("Received signal %s; stopping supervised services.", signum)
        self._stop_event.set()

    def _install_signal_handlers(self) -> None:
        if not self._install_signal_handlers_enabled:
            return
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(signum, self.request_shutdown, signum)
            except (NotImplementedError, RuntimeError):
                continue
            self._installed_signals.append(signum)

    def _remove_signal_handlers(self) -> None:
        if not self._installed_signals:
            return
        loop = asyncio.get_running_loop()
        for signum in self._installed_signals:
            loop.remove_signal_handler(signum)
        self._installed_signals.clear()

    async def _start_critical_children(self) -> None:
        commands: Sequence[tuple[str, list[str]]] = (
            (
                "http_server",
                [
                    self.config.python_executable,
                    "-u",
                    "-m",
                    "http.server",
                    str(self.config.http_port),
                ],
            ),
            (
                "ib_server",
                [
                    self.config.python_executable,
                    "-u",
                    "ib_server.py",
                ],
            ),
        )
        for name, command in commands:
            process = await self._spawn_exec(
                *command,
                cwd=str(self.config.repo_dir),
                start_new_session=True,
            )
            self._children[name] = process
            LOGGER.info("Started %s pid=%s.", name, process.pid)

    async def _stop_critical_children(self, initial_signal: int) -> None:
        running = [
            process
            for process in self._children.values()
            if getattr(process, "returncode", None) is None
        ]
        if not running:
            return
        for process in running:
            self._process_signaler(process, initial_signal)
        waiters = {
            asyncio.create_task(process.wait()): process
            for process in running
        }
        _done, pending = await asyncio.wait(
            waiters,
            timeout=self.config.shutdown_grace_seconds,
        )
        if not pending:
            return
        LOGGER.error("Critical children did not stop in time; sending SIGKILL.")
        for waiter in pending:
            process = waiters[waiter]
            if getattr(process, "returncode", None) is None:
                self._process_signaler(process, signal.SIGKILL)
        await asyncio.gather(*pending)

    @staticmethod
    def _unexpected_child_exit_code(returncode: int) -> int:
        if returncode > 0:
            return returncode
        if returncode < 0:
            return 128 + abs(returncode)
        return 1

    async def _run_optional_yield_scheduler(self) -> None:
        try:
            await self.yield_scheduler.run(self._stop_event)
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception(
                "Optional yield-curve scheduler failed; "
                "the container will continue without it."
            )
        else:
            if not self._stop_event.is_set():
                LOGGER.error(
                    "Optional yield-curve scheduler stopped unexpectedly; "
                    "the container will continue without it."
                )
        if not self._stop_event.is_set():
            await self._stop_event.wait()

    async def run(self) -> int:
        self._install_signal_handlers()
        critical_waiters: Dict[asyncio.Task[Any], str] = {}
        background_tasks: Dict[asyncio.Task[Any], str] = {}
        stop_waiter: Optional[asyncio.Task[Any]] = None
        exit_code = 1

        try:
            await self._start_critical_children()
            for name, process in self._children.items():
                critical_waiters[asyncio.create_task(process.wait())] = name

            background_tasks = {
                asyncio.create_task(self.monitor.run(self._stop_event)): "ib_status_monitor",
                asyncio.create_task(self._run_optional_yield_scheduler()): "yield_curve_scheduler",
            }
            stop_waiter = asyncio.create_task(self._stop_event.wait())
            watched = set(critical_waiters) | set(background_tasks) | {stop_waiter}
            done, _pending = await asyncio.wait(
                watched,
                return_when=asyncio.FIRST_COMPLETED,
            )

            if self._received_signal is not None or stop_waiter in done:
                exit_code = 0
            else:
                completed = next(iter(done))
                if completed in critical_waiters:
                    name = critical_waiters[completed]
                    returncode = int(completed.result())
                    LOGGER.error("Critical child %s exited with code %s.", name, returncode)
                    exit_code = self._unexpected_child_exit_code(returncode)
                else:
                    name = background_tasks.get(completed, "background_task")
                    try:
                        completed.result()
                    except Exception:
                        LOGGER.exception("Required supervisor task %s failed.", name)
                    else:
                        LOGGER.error("Required supervisor task %s stopped unexpectedly.", name)
                    exit_code = 1
        except (OSError, RuntimeError):
            LOGGER.exception("Unable to start or supervise critical services.")
            exit_code = 1
        finally:
            self._stop_event.set()
            background_and_stop = list(background_tasks)
            if stop_waiter is not None:
                background_and_stop.append(stop_waiter)
            for task in background_and_stop:
                if not task.done():
                    task.cancel()

            initial_signal = self._received_signal or signal.SIGTERM
            critical_shutdown = asyncio.create_task(
                self._stop_critical_children(initial_signal)
            )
            if background_and_stop:
                await asyncio.gather(*background_and_stop, return_exceptions=True)
            await critical_shutdown
            if critical_waiters:
                await asyncio.gather(*critical_waiters, return_exceptions=True)
            self._remove_signal_handlers()
        return exit_code


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Supervise Option Combo container services")
    parser.add_argument(
        "--repo-dir",
        default=os.environ.get("OPTION_COMBO_REPO_DIR", str(DEFAULT_REPO_DIR)),
        help="runtime Option-Combo-Simulation checkout",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = _build_parser().parse_args(argv)
    repo_dir = Path(args.repo_dir).resolve()
    if not repo_dir.is_dir() or not (repo_dir / "ib_server.py").is_file():
        LOGGER.error("Invalid runtime repository directory: %s", repo_dir)
        return 2

    config = SupervisorConfig.from_environment(repo_dir)
    monitor = IBStatusMonitor(config)
    scheduler = YieldCurveScheduler(config)
    supervisor = ApplicationSupervisor(config, monitor, scheduler)
    return asyncio.run(supervisor.run())


if __name__ == "__main__":
    raise SystemExit(main())
