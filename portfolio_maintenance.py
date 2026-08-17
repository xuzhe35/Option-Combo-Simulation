"""Cross-process maintenance guard for the workspace database family.

Two backends (ib_server.py, historical_server.py) resolve to the same active
database and may run at once. Every maintenance path — scheduled backup,
retention, archive copy, vacuum, exact stats — must run under this guard.
The in-process threading.Lock alone is NOT a correctness boundary.

Fixed acquisition order (plan section 6.6 / 14.1), release in reverse:

1. the process-local threading.Lock (store_env['_maintenance_lock']);
2. the OS advisory file lock `portfolio.maintenance.lock` next to the
   active database — the hard mutual exclusion while a process is alive;
3. the `workspace_maintenance_lease` row in the active database — the
   observable owner, expiry recovery, and fencing token.

A lease expiry alone never authorizes takeover: a paused holder still owns
the OS lock, so a contender fails at step 2 and reports maintenance busy.
Only after the holder process dies (OS releases the flock) can a new
process take over the expired lease, which increments the fencing token;
workers must re-check their token before every external side effect and
stop when it no longer matches.

Everything here is synchronous and runs on worker threads.
"""

import logging
import os
import sys
import uuid
from pathlib import Path

logger = logging.getLogger('portfolio_maintenance')

LOCK_FILE_NAME = 'portfolio.maintenance.lock'
LEASE_NAME = 'maintenance-primary'
DEFAULT_LEASE_TTL_SECONDS = 60
DEFAULT_LEASE_HEARTBEAT_SECONDS = 15

RUNTIME_LOCK_FILE_NAME = 'portfolio.runtime.lock'
# Windows shared-lock emulation: each backend exclusively locks ONE byte in
# [1, _RUNTIME_SLOTS]; an exclusive taker must win byte 0 AND every slot.
_RUNTIME_SLOTS = 64

if sys.platform.startswith('win'):
    import msvcrt

    def _lock_fd(fd):
        # Lock one byte at offset 0; raises OSError when already held.
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)

    def _unlock_fd(fd):
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass

    def _lock_shared(fd):
        # Probe slots until one is free; raises OSError when all are taken.
        for slot in range(1, _RUNTIME_SLOTS + 1):
            os.lseek(fd, slot, os.SEEK_SET)
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                return slot
            except OSError:
                continue
        raise OSError('no free runtime lock slot')

    def _lock_exclusive_all(fd):
        held = []
        try:
            for slot in range(0, _RUNTIME_SLOTS + 1):
                os.lseek(fd, slot, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                held.append(slot)
        except OSError:
            for slot in held:
                try:
                    os.lseek(fd, slot, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            raise
        return held

    def _unlock_slots(fd, slots):
        for slot in slots if isinstance(slots, list) else [slots]:
            try:
                os.lseek(fd, slot, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
else:
    import fcntl

    def _lock_fd(fd):
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock_fd(fd):
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass

    def _lock_shared(fd):
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        return 'shared'

    def _lock_exclusive_all(fd):
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return 'exclusive'

    def _unlock_slots(fd, slots):
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass


def new_server_instance_id():
    """Non-reusable per-process-boot identity."""
    return f'srv-{uuid.uuid4().hex[:16]}'


class BackendRuntimeLock:
    """Shared runtime-liveness lock a backend holds for its whole process
    life once it opens the workspace store. Restore takes the EXCLUSIVE
    side: a running backend — even one currently doing no maintenance —
    therefore blocks a database replacement, and a replacement in progress
    blocks a backend from opening the store. This is what the short-lived
    maintenance lock cannot provide: ordinary saves never take that one."""

    def __init__(self, db_path):
        self._lock_path = Path(db_path).parent / RUNTIME_LOCK_FILE_NAME
        self._fd = None
        self._slots = None

    def acquire_shared(self):
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            self._slots = _lock_shared(fd)
        except OSError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def acquire_exclusive(self):
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            self._slots = _lock_exclusive_all(fd)
        except OSError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def release(self):
        if self._fd is not None:
            _unlock_slots(self._fd, self._slots)
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
            self._slots = None


class OsMaintenanceLock:
    """Just the OS advisory flock next to a database path — for tools like
    restore that must exclude running backends but have no (usable) database
    to hold a lease in. Backends acquire the SAME file first in their guard
    chain, so holding it here guarantees no backend maintenance can run."""

    def __init__(self, db_path):
        self._lock_path = Path(db_path).parent / LOCK_FILE_NAME
        self._fd = None

    def acquire(self):
        """Non-blocking; False when another process holds maintenance."""
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            _lock_fd(fd)
        except OSError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def release(self):
        if self._fd is not None:
            _unlock_fd(self._fd)
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None


class MaintenanceGuard:
    """A held guard: thread lock + OS flock + DB lease. Single-use."""

    def __init__(self, *, store, thread_lock, lock_fd, lock_path,
                 instance_id, fencing_token, ttl_seconds):
        self._store = store
        self._thread_lock = thread_lock
        self._lock_fd = lock_fd
        self._lock_path = lock_path
        self.instance_id = instance_id
        self.fencing_token = fencing_token
        self._ttl_seconds = ttl_seconds
        self._released = False

    def heartbeat(self):
        """Extend the lease; False means it was lost and work must stop."""
        if self._released:
            return False
        return self._store.maintenance_lease_heartbeat(
            lease_name=LEASE_NAME,
            holder_instance_id=self.instance_id,
            fencing_token=self.fencing_token,
            ttl_seconds=self._ttl_seconds,
        )

    def verify(self):
        """True while this holder+token still owns an unexpired lease.
        Callers check this before every external side effect."""
        if self._released:
            return False
        return self._store.maintenance_lease_verify(
            lease_name=LEASE_NAME,
            holder_instance_id=self.instance_id,
            fencing_token=self.fencing_token,
        )

    def release(self):
        """Reverse order: DB lease, then OS flock, then the thread lock."""
        if self._released:
            return
        self._released = True
        try:
            self._store.maintenance_lease_release(
                lease_name=LEASE_NAME,
                holder_instance_id=self.instance_id,
                fencing_token=self.fencing_token,
            )
        except Exception:
            logger.exception('maintenance lease release failed; continuing')
        if self._lock_fd is not None:
            _unlock_fd(self._lock_fd)
            try:
                os.close(self._lock_fd)
            except OSError:
                pass
        try:
            self._thread_lock.release()
        except RuntimeError:
            logger.exception('maintenance thread lock double-release')


def acquire_maintenance(store_env):
    """Try to acquire the full guard, non-blocking at every layer.

    Returns a MaintenanceGuard or None (report maintenance_busy). Never
    raises for the busy cases; unexpected store errors propagate."""
    if store_env is None:
        return None
    store = store_env.get('store')
    thread_lock = store_env.get('_maintenance_lock')
    if store is None or thread_lock is None:
        return None

    instance_id = store_env.get('_server_instance_id')
    if not instance_id:
        instance_id = new_server_instance_id()
        store_env['_server_instance_id'] = instance_id
    ttl_seconds = store_env.get(
        '_maintenance_lease_ttl_seconds', DEFAULT_LEASE_TTL_SECONDS
    )

    if not thread_lock.acquire(blocking=False):
        return None

    lock_path = Path(store.db_path).parent / LOCK_FILE_NAME
    lock_fd = None
    try:
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            _lock_fd(lock_fd)
        except OSError:
            # Another live process holds maintenance; even an expired DB
            # lease must not be taken over while its OS lock stands.
            os.close(lock_fd)
            lock_fd = None
            thread_lock.release()
            return None

        lease = store.maintenance_lease_acquire(
            lease_name=LEASE_NAME,
            holder_instance_id=instance_id,
            holder_pid=os.getpid(),
            ttl_seconds=ttl_seconds,
        )
        if lease is None:
            # We hold the OS lock, so the recorded holder is not alive on
            # this machine (or is us in a previous incarnation) — but its
            # lease has not expired yet. Fail closed and let expiry pass.
            _unlock_fd(lock_fd)
            os.close(lock_fd)
            lock_fd = None
            thread_lock.release()
            return None

        # Owning the lease also means owning job stewardship: queued or
        # running jobs whose server instance is gone have no executor —
        # mark them interrupted so the page never stares at a ghost.
        try:
            orphaned = store.mark_orphan_maintenance_jobs(instance_id)
            if orphaned:
                logger.info('marked %d orphan maintenance jobs interrupted',
                            orphaned)
        except Exception:
            logger.exception('orphan job sweep failed; guard still held')

        return MaintenanceGuard(
            store=store,
            thread_lock=thread_lock,
            lock_fd=lock_fd,
            lock_path=lock_path,
            instance_id=instance_id,
            fencing_token=lease['fencingToken'],
            ttl_seconds=ttl_seconds,
        )
    except BaseException:
        if lock_fd is not None:
            _unlock_fd(lock_fd)
            try:
                os.close(lock_fd)
            except OSError:
                pass
        thread_lock.release()
        raise
