"""Persistent, single-owner lifecycle management for one IB API connection."""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections.abc import Callable
from typing import Any


IB_CLIENT_ID_IN_USE_ERROR = 326
DEFAULT_RETRY_INTERVAL_SECONDS = 600.0
DEFAULT_CLIENT_ID_RETRY_INTERVAL_SECONDS = 1.0
DEFAULT_CONNECT_TIMEOUT_SECONDS = 20.0
MINIMUM_CLIENT_ID = 1


class IbConnectionSupervisor:
    """Keep one IB API session connected without restarting the host process.

    Failed attempts are scheduled from the start time of the previous attempt,
    so a 20-second handshake timeout does not stretch a ten-minute retry cadence
    to ten minutes and twenty seconds. Manual requests wake the same supervisor
    instead of creating a competing connection task.
    """

    def __init__(
        self,
        *,
        ib: Any,
        host: str,
        port: int,
        client_id: int,
        retry_interval_seconds: float = DEFAULT_RETRY_INTERVAL_SECONDS,
        client_id_retry_interval_seconds: float = DEFAULT_CLIENT_ID_RETRY_INTERVAL_SECONDS,
        connect_timeout_seconds: float = DEFAULT_CONNECT_TIMEOUT_SECONDS,
        minimum_client_id: int = MINIMUM_CLIENT_ID,
        logger: logging.Logger | None = None,
        on_connected: Callable[[], Any] | None = None,
        on_disconnected: Callable[[], Any] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ib = ib
        self.host = str(host)
        self.port = int(port)
        self.minimum_client_id = max(int(minimum_client_id), MINIMUM_CLIENT_ID)
        self.configured_client_id = max(int(client_id), self.minimum_client_id)
        self.effective_client_id = self.configured_client_id
        self.retry_interval_seconds = max(float(retry_interval_seconds), 0.001)
        self.client_id_retry_interval_seconds = max(
            float(client_id_retry_interval_seconds),
            0.001,
        )
        self.connect_timeout_seconds = max(float(connect_timeout_seconds), 0.001)
        self.logger = logger or logging.getLogger(__name__)
        self.on_connected = on_connected
        self.on_disconnected = on_disconnected
        self.monotonic = monotonic

        self.state = "stopped"
        self.next_retry_at: float | None = None
        self.last_error = ""
        self.last_error_code: int | None = None

        self._task: asyncio.Task | None = None
        self._wake_event = asyncio.Event()
        self._wake_generation = 0
        self._force_immediate_attempt = False
        self._last_attempt_decremented_client_id = False
        self._disconnect_recovery_pending = False
        self._disconnect_recovery_task: asyncio.Task | None = None
        self._fatal_callback_error: Exception | None = None
        self._shutting_down = False
        self._intentional_disconnect = False
        self._disconnect_handler_attached = False
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def task(self) -> asyncio.Task | None:
        return self._task

    @property
    def running(self) -> bool:
        return bool(self._task and not self._task.done())

    @property
    def connecting(self) -> bool:
        return self.state == "connecting"

    @property
    def reconnecting(self) -> bool:
        return self.running and not bool(self.ib.isConnected())

    def start(self) -> asyncio.Task:
        """Start the persistent supervisor once and return its task."""
        if self.running:
            return self._task

        self._loop = asyncio.get_running_loop()
        self._shutting_down = False
        self._fatal_callback_error = None
        self._attach_disconnect_handler()
        self._force_immediate_attempt = True
        self._signal_wake()
        self._task = self._loop.create_task(self.run())
        return self._task

    def request_connect(self) -> bool:
        """Wake the supervisor for one immediate attempt.

        Returns False when IB is already connected or shutdown has started.
        """
        if self._shutting_down or self.ib.isConnected():
            return False
        if not self.running:
            self.start()
        self._force_immediate_attempt = True
        self.next_retry_at = None
        self._signal_wake()
        return True

    def disconnect_intentionally(self) -> bool:
        """Disconnect without treating the resulting event as a connection loss.

        The caller decides whether and when to request the next connection. This
        is used by the explicit global market-data reset workflow.
        """
        was_connected = bool(self.ib.isConnected())
        # Detaching around the deliberate close also suppresses an apiEnd event
        # delivered just after IB.disconnect() returns. The handler is attached
        # again only after the replacement connection is fully synchronized.
        self._detach_disconnect_handler()
        self._intentional_disconnect = True
        try:
            if was_connected:
                self.ib.disconnect()
        finally:
            self._intentional_disconnect = False

        self.state = "disconnected"
        self.next_retry_at = None
        return was_connected

    async def stop(self, *, disconnect: bool = True) -> None:
        """Stop retries and optionally close the current API connection."""
        self._shutting_down = True
        self._force_immediate_attempt = False
        self.next_retry_at = None
        self._detach_disconnect_handler()
        self._signal_wake()

        task = self._task
        recovery_task = self._disconnect_recovery_task
        if task is not None and not task.done():
            task.cancel()
        if recovery_task is not None and not recovery_task.done():
            recovery_task.cancel()
        await asyncio.gather(
            *(candidate for candidate in (task, recovery_task) if candidate is not None),
            return_exceptions=True,
        )

        if disconnect and self.ib.isConnected():
            self._intentional_disconnect = True
            try:
                self.ib.disconnect()
            finally:
                self._intentional_disconnect = False

        self._task = None
        self._disconnect_recovery_task = None
        self._disconnect_recovery_pending = False
        self._fatal_callback_error = None
        self.state = "stopped"

    def _signal_wake(self) -> None:
        """Record and publish a wake without relying on Event edge timing."""

        self._wake_generation += 1
        self._wake_event.set()

    async def _wait_for_wake(
        self,
        observed_generation: int,
        timeout_seconds: float | None = None,
    ) -> None:
        """Wait for a newer wake generation, closing the clear/wait race.

        ``asyncio.Event`` is level-triggered, so a plain ``clear(); wait()`` can
        erase a wake that arrives immediately before ``clear``. The generation
        is advanced before every set; checking it again after clear preserves
        that wake even if the Event bit itself was concurrently cleared.
        """

        loop = asyncio.get_running_loop()
        deadline = (
            None
            if timeout_seconds is None
            else loop.time() + max(float(timeout_seconds), 0.0)
        )
        while (
            not self._shutting_down
            and self._wake_generation == observed_generation
        ):
            self._wake_event.clear()
            if self._wake_generation != observed_generation:
                return
            if deadline is None:
                await self._wake_event.wait()
                continue
            remaining = deadline - loop.time()
            if remaining <= 0:
                return
            try:
                await asyncio.wait_for(self._wake_event.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                return

    async def run(self) -> None:
        """Run until cancelled by :meth:`stop`."""
        try:
            while not self._shutting_down:
                fatal_callback_error = self._fatal_callback_error
                if fatal_callback_error is not None:
                    self._fatal_callback_error = None
                    raise fatal_callback_error

                observed_wake_generation = self._wake_generation
                if self._disconnect_recovery_pending:
                    await self._wait_for_wake(observed_wake_generation)
                    continue

                if self.ib.isConnected():
                    self.state = "connected"
                    self.next_retry_at = None
                    self._force_immediate_attempt = False
                    await self._wait_for_wake(observed_wake_generation)
                    continue

                now = self.monotonic()
                attempt_is_due = (
                    self._force_immediate_attempt
                    or self.next_retry_at is None
                    or now >= self.next_retry_at
                )
                if attempt_is_due:
                    self._force_immediate_attempt = False
                    attempt_started_at = self.monotonic()
                    connected = await self._connect_once()
                    if connected:
                        continue
                    if self._last_attempt_decremented_client_id:
                        self.next_retry_at = (
                            self.monotonic() + self.client_id_retry_interval_seconds
                        )
                    else:
                        self.next_retry_at = (
                            attempt_started_at + self.retry_interval_seconds
                        )
                    if (
                        self._force_immediate_attempt
                        or self._wake_generation != observed_wake_generation
                    ):
                        continue

                wait_seconds = max((self.next_retry_at or self.monotonic()) - self.monotonic(), 0.0)
                await self._wait_for_wake(
                    observed_wake_generation,
                    timeout_seconds=wait_seconds,
                )
        except asyncio.CancelledError:
            raise
        finally:
            if self._shutting_down:
                self.state = "stopped"

    async def _connect_once(self) -> bool:
        if self._shutting_down or self.ib.isConnected():
            return bool(self.ib.isConnected())

        self.state = "connecting"
        self._last_attempt_decremented_client_id = False
        attempted_client_id = self.effective_client_id
        error_codes: list[int] = []

        def capture_error(_req_id, error_code, _error_string, _contract) -> None:
            try:
                error_codes.append(int(error_code))
            except (TypeError, ValueError):
                return

        self.ib.errorEvent += capture_error
        try:
            self.logger.info(
                "Connecting to IB TWS/Gateway at %s:%s (Client ID: %s)...",
                self.host,
                self.port,
                attempted_client_id,
            )
            await self.ib.connectAsync(
                self.host,
                self.port,
                clientId=attempted_client_id,
                timeout=self.connect_timeout_seconds,
            )
            if not self.ib.isConnected():
                raise ConnectionError("IB connectAsync returned without an active connection.")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.last_error = str(exc)
            self.last_error_code = (
                IB_CLIENT_ID_IN_USE_ERROR
                if IB_CLIENT_ID_IN_USE_ERROR in error_codes
                else (error_codes[-1] if error_codes else None)
            )
            if IB_CLIENT_ID_IN_USE_ERROR in error_codes:
                previous_client_id = self.effective_client_id
                self.effective_client_id = max(
                    self.minimum_client_id,
                    self.effective_client_id - 1,
                )
                if self.effective_client_id != previous_client_id:
                    self._last_attempt_decremented_client_id = True
                    self.logger.warning(
                        "IB Client ID %s is already in use (Error 326); "
                        "the next attempt will use Client ID %s after %.1f seconds.",
                        previous_client_id,
                        self.effective_client_id,
                        self.client_id_retry_interval_seconds,
                    )
                else:
                    self.logger.warning(
                        "IB Client ID %s is already in use (Error 326), but the "
                        "safe Client ID floor %s has been reached.",
                        previous_client_id,
                        self.minimum_client_id,
                    )
            else:
                self.logger.error(
                    "IB connection attempt failed for Client ID %s: %s. "
                    "The supervisor will retry on its fixed %g-second cadence.",
                    attempted_client_id,
                    exc,
                    self.retry_interval_seconds,
                )
            self.state = "disconnected"
            return False
        finally:
            self.ib.errorEvent -= capture_error

        self.effective_client_id = attempted_client_id
        self.last_error = ""
        self.last_error_code = None
        self.state = "connected"
        self.next_retry_at = None
        self._attach_disconnect_handler()
        self.logger.info(
            "Successfully connected to IB (Client ID: %s).",
            self.effective_client_id,
        )
        await self._invoke_callback(self.on_connected, "post-connect")
        return True

    def _handle_disconnected_event(self) -> None:
        if self._shutting_down:
            self.logger.info("Ignoring IB disconnect event during shutdown.")
            return
        if self._intentional_disconnect:
            self.logger.info("Ignoring expected IB disconnect event.")
            return
        if self.ib.isConnected():
            self.logger.info(
                "Ignoring delayed IB disconnect event because the replacement "
                "connection is already active."
            )
            return
        if self.state == "connecting":
            # A failed connectAsync can emit disconnectedEvent. The failed
            # attempt already owns the fixed-cadence retry decision.
            return

        was_connected = self.state == "connected"
        if not was_connected:
            # Duplicate or delayed apiEnd events must not bypass the scheduled
            # retry after an already-failed connection attempt.
            return
        self.state = "disconnected"
        self.next_retry_at = None
        self._force_immediate_attempt = False
        self._disconnect_recovery_pending = True
        self.logger.warning(
            "IB API connection was lost; attempting an in-process reconnect now, "
            "then every %g seconds until TWS/Gateway is available.",
            self.retry_interval_seconds,
        )
        self._schedule_disconnect_recovery()

    def _schedule_disconnect_recovery(self) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            self._disconnect_recovery_pending = False
            return
        loop.call_soon_threadsafe(self._start_disconnect_recovery_task)

    def _start_disconnect_recovery_task(self) -> None:
        if self._shutting_down:
            self._disconnect_recovery_pending = False
            return
        loop = self._loop
        if loop is None or loop.is_closed():
            self._disconnect_recovery_pending = False
            return
        existing = self._disconnect_recovery_task
        if existing is not None and not existing.done():
            return
        self._disconnect_recovery_task = loop.create_task(
            self._complete_disconnect_recovery()
        )

    async def _complete_disconnect_recovery(self) -> None:
        try:
            await self._invoke_callback(self.on_disconnected, "disconnect")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fatal_callback_error = exc
        finally:
            self._disconnect_recovery_pending = False
            self._disconnect_recovery_task = None
            if self._fatal_callback_error is not None:
                self._signal_wake()
            elif not self._shutting_down and not self.ib.isConnected():
                self._force_immediate_attempt = True
                self.next_retry_at = None
                self._signal_wake()

    async def _invoke_callback(
        self,
        callback: Callable[[], Any] | None,
        label: str,
    ) -> None:
        if callback is None:
            return
        try:
            result = callback()
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            self.logger.exception("IB connection supervisor %s callback failed", label)
            raise RuntimeError(
                f"IB connection supervisor {label} callback failed."
            ) from exc

    def _attach_disconnect_handler(self) -> None:
        if self._disconnect_handler_attached:
            return
        self.ib.disconnectedEvent += self._handle_disconnected_event
        self._disconnect_handler_attached = True

    def _detach_disconnect_handler(self) -> None:
        if not self._disconnect_handler_attached:
            return
        self.ib.disconnectedEvent -= self._handle_disconnected_event
        self._disconnect_handler_attached = False
