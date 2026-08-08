"""Shared WebSocket protocol layer for workspace persistence.

Both backends route the same client actions through here so Live and
Historical answer with identical response shapes, error codes, and revision
behavior. This module owns loopback enforcement, request validation, and
the sync-store-to-event-loop bridge (asyncio.to_thread); it never writes
SQL itself and never leaks database paths or raw SQL errors to the browser.

A raised exception must never escape handle_persistence_action(): one bad
persistence request must not tear down a socket that is also carrying live
market data and order supervision.
"""

import asyncio
import ipaddress
import json
import logging
import threading
import time

from datetime import datetime, timezone

from portfolio_store import (
    ACCEPTED_PAYLOAD_SCHEMA_VERSIONS,
    DEFAULT_BACKUP_KEEP_DAILY,
    DEFAULT_BACKUP_KEEP_WEEKLY,
    DEFAULT_MAX_PAYLOAD_BYTES,
    DEFAULT_REVISION_KEEP_DAILY_DAYS,
    DEFAULT_REVISION_KEEP_RECENT,
    PortfolioStore,
    PortfolioStoreError,
    InvalidRequestError,
    RevisionConflictError,
    SCHEMA_USER_VERSION,
    default_app_data_dir,
    resolve_backup_dir,
    resolve_db_path,
)

DEFAULT_VACUUM_FREELIST_PAGES = 256
DEFAULT_VACUUM_MAX_PAGES = 512

logger = logging.getLogger('portfolio_store.ws')

DEFAULT_MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024

SERVER_ACTIONS = {
    'request_workspace_store_status': 'workspace_store_status',
    'list_saved_workspaces': 'saved_workspaces_list',
    'load_saved_workspace': 'saved_workspace_loaded',
    'save_saved_workspace': 'workspace_saved',
    'delete_saved_workspace': 'workspace_deleted',
    'undelete_saved_workspace': 'workspace_undeleted',
    'list_workspace_revisions': 'workspace_revisions_list',
    'restore_workspace_revision': 'workspace_revision_restored',
}

PERSISTENCE_CLIENT_ACTIONS = frozenset(SERVER_ACTIONS)


def read_max_ws_message_bytes(config=None):
    """The explicit websockets.serve max_size both backends must share.

    The library default is 1 MiB; a save above that would close the whole
    connection with 1009 — on the Live socket that also drops order
    supervision. 8 MiB leaves envelope headroom over the 5 MiB payload cap.
    """
    if config is None:
        return DEFAULT_MAX_WS_MESSAGE_BYTES
    try:
        value = config.getint(
            'server', 'max_ws_message_bytes', fallback=DEFAULT_MAX_WS_MESSAGE_BYTES
        )
    except ValueError:
        return DEFAULT_MAX_WS_MESSAGE_BYTES
    return max(1024 * 1024, value)


def create_store_env(config=None):
    """Describe the store for a backend without touching the filesystem.

    Cheap enough to run at module import (ib_server is imported by tests
    that must never touch the user database). The database itself is opened
    lazily by ensure_store_initialized() on the first loopback persistence
    request; failures only disable persistence while market data, replay,
    and IB keep running."""
    max_payload_bytes = DEFAULT_MAX_PAYLOAD_BYTES
    enabled = True
    if config is not None:
        try:
            enabled = config.getboolean('portfolio_store', 'enabled', fallback=True)
        except ValueError:
            enabled = True
        try:
            max_payload_bytes = config.getint(
                'portfolio_store', 'max_payload_bytes',
                fallback=DEFAULT_MAX_PAYLOAD_BYTES,
            )
        except ValueError:
            max_payload_bytes = DEFAULT_MAX_PAYLOAD_BYTES
        try:
            if config.getboolean('portfolio_store', 'allow_remote', fallback=False):
                logger.warning(
                    'portfolio_store.allow_remote=true is ignored: v1 serves '
                    'loopback clients only (design auth + TLS before opening up).'
                )
        except ValueError:
            pass

    backup_interval_hours = 24.0
    backup_keep_daily = DEFAULT_BACKUP_KEEP_DAILY
    backup_keep_weekly = DEFAULT_BACKUP_KEEP_WEEKLY
    revision_keep_recent = DEFAULT_REVISION_KEEP_RECENT
    revision_keep_daily_days = DEFAULT_REVISION_KEEP_DAILY_DAYS
    vacuum_freelist_pages = DEFAULT_VACUUM_FREELIST_PAGES
    vacuum_max_pages = DEFAULT_VACUUM_MAX_PAGES
    if config is not None:
        try:
            revision_keep_recent = max(1, config.getint(
                'portfolio_store', 'revision_keep_recent',
                fallback=DEFAULT_REVISION_KEEP_RECENT,
            ))
            revision_keep_daily_days = max(0, config.getint(
                'portfolio_store', 'revision_keep_daily_days',
                fallback=DEFAULT_REVISION_KEEP_DAILY_DAYS,
            ))
            vacuum_freelist_pages = max(0, config.getint(
                'portfolio_store', 'vacuum_freelist_pages',
                fallback=DEFAULT_VACUUM_FREELIST_PAGES,
            ))
            vacuum_max_pages = max(1, config.getint(
                'portfolio_store', 'vacuum_max_pages',
                fallback=DEFAULT_VACUUM_MAX_PAGES,
            ))
        except ValueError:
            pass
    if config is not None:
        try:
            backup_interval_hours = config.getfloat(
                'portfolio_store', 'backup_interval_hours', fallback=24.0
            )
        except ValueError:
            backup_interval_hours = 24.0
        try:
            backup_keep_daily = config.getint(
                'portfolio_store', 'backup_keep_daily',
                fallback=DEFAULT_BACKUP_KEEP_DAILY,
            )
            backup_keep_weekly = config.getint(
                'portfolio_store', 'backup_keep_weekly',
                fallback=DEFAULT_BACKUP_KEEP_WEEKLY,
            )
        except ValueError:
            pass

    return {
        'store': None,
        'available': False,
        'reason': 'store_unavailable',
        'max_payload_bytes': max_payload_bytes,
        'allow_remote': False,
        '_enabled': enabled,
        '_config': config,
        '_initialized': False,
        '_init_lock': threading.Lock(),
        '_backup_interval_seconds': max(0.0, backup_interval_hours) * 3600.0,
        '_backup_keep_daily': backup_keep_daily,
        '_backup_keep_weekly': backup_keep_weekly,
        # Real mutex: save-triggered maintenance, shutdown top-up, and forced
        # backups all funnel through this one lock. A dict flag was
        # check-then-set and let two threads run the whole chain in parallel.
        '_maintenance_lock': threading.Lock(),
        '_revision_keep_recent': revision_keep_recent,
        '_revision_keep_daily_days': revision_keep_daily_days,
        '_vacuum_freelist_pages': vacuum_freelist_pages,
        '_vacuum_max_pages': vacuum_max_pages,
    }


def ensure_store_initialized(store_env):
    """Open (or create) the database once, from a worker thread. Idempotent
    and never raises."""
    if store_env is None:
        return None
    lock = store_env.get('_init_lock')
    if lock is None:
        return store_env
    with lock:
        if store_env.get('_initialized'):
            return store_env
        store_env['_initialized'] = True
        if not store_env.get('_enabled', True):
            logger.info('workspace persistence disabled by configuration')
            return store_env
        try:
            db_path = resolve_db_path(config=store_env.get('_config'))
            store = PortfolioStore(
                db_path, max_payload_bytes=store_env['max_payload_bytes']
            ).initialize()
        except PortfolioStoreError as exc:
            logger.error(
                'workspace persistence unavailable (%s): %s — market data and '
                'replay continue; fix the database location and restart.',
                exc.code, exc,
            )
            store_env['reason'] = exc.code
            return store_env
        store_env['store'] = store
        store_env['available'] = True
        store_env['reason'] = ''
        logger.info('workspace persistence ready at %s', store.db_path)
        return store_env


def is_loopback_address(remote_address):
    """Strict loopback check; fails closed on anything unparseable."""
    try:
        host = remote_address[0]
    except (TypeError, IndexError, KeyError):
        return False
    if not isinstance(host, str) or not host:
        return False
    candidate = host.strip().lower()
    if '%' in candidate:  # scoped IPv6 like fe80::1%lo0
        candidate = candidate.split('%', 1)[0]
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


async def handle_persistence_action(store_env, websocket, data, *,
                                    client_ip='Unknown', send=None):
    """Answer a persistence action. Returns True when the action belonged to
    the persistence protocol (a response was sent), False otherwise."""
    action = data.get('action') if isinstance(data, dict) else None
    if action not in PERSISTENCE_CLIENT_ACTIONS:
        return False
    try:
        response = await build_persistence_response(
            store_env, websocket, data, client_ip=client_ip
        )
    except Exception:
        logger.exception('persistence handler failed for action %r', action)
        response = _error_response(
            SERVER_ACTIONS[action], _request_id(data),
            'internal_store_error', 'internal store error',
        )
    try:
        message = json.dumps(response)
        if send is not None:
            await send(websocket, message)
        else:
            await websocket.send(message)
    except Exception:
        logger.warning('failed to send persistence response for %r', action)
    return True


async def build_persistence_response(store_env, websocket, data, *,
                                     client_ip='Unknown'):
    action = data.get('action')
    server_action = SERVER_ACTIONS[action]
    request_id = _request_id(data)
    started = time.monotonic()

    store_env = store_env or {}
    allow_remote = store_env.get('allow_remote', False) is True
    if not allow_remote and not is_loopback_address(
        getattr(websocket, 'remote_address', None)
    ):
        logger.warning(
            'rejected non-loopback persistence request %s from %s',
            action, client_ip,
        )
        if action == 'request_workspace_store_status':
            # No path, schema, or availability detail crosses the boundary.
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'available': False,
                'reason': 'remote_access_disabled',
            }
        return _error_response(
            server_action, request_id,
            'remote_access_disabled', 'persistence is loopback-only',
        )

    if not store_env.get('_initialized') and store_env.get('_init_lock') is not None:
        await asyncio.to_thread(ensure_store_initialized, store_env)

    store = store_env.get('store')
    if action == 'request_workspace_store_status':
        response = {
            'action': server_action,
            'requestId': request_id,
            'success': True,
            'available': store is not None,
        }
        if store is None:
            response['reason'] = store_env.get('reason') or 'store_unavailable'
        else:
            response['storeSchemaVersion'] = SCHEMA_USER_VERSION
            response['acceptedSessionSchemaVersions'] = list(
                ACCEPTED_PAYLOAD_SCHEMA_VERSIONS
            )
            response['maxPayloadBytes'] = store_env.get(
                'max_payload_bytes', DEFAULT_MAX_PAYLOAD_BYTES
            )
        return response

    if store is None:
        return _error_response(
            server_action, request_id,
            store_env.get('reason') or 'store_unavailable',
            'workspace store is unavailable',
        )

    try:
        result = await _dispatch_store_call(store, action, data)
    except RevisionConflictError as exc:
        response = _error_response(server_action, request_id, exc.code, str(exc))
        response['currentRevision'] = exc.current_revision
        response['updatedAtUtc'] = exc.updated_at_utc
        _log_result(action, request_id, data, started, error=exc.code)
        return response
    except PortfolioStoreError as exc:
        _log_result(action, request_id, data, started, error=exc.code)
        return _error_response(server_action, request_id, exc.code, str(exc))
    except Exception:
        logger.exception('unexpected store failure for action %r', action)
        _log_result(action, request_id, data, started, error='internal_store_error')
        return _error_response(
            server_action, request_id, 'internal_store_error', 'internal store error'
        )

    response = {'action': server_action, 'requestId': request_id, 'success': True}
    response.update(result)
    _log_result(action, request_id, data, started, result=result)
    if action == 'save_saved_workspace':
        # Committed data is the trigger for the scheduled static backup.
        # Fire-and-forget off the event loop; a backup failure only logs.
        try:
            asyncio.get_running_loop().create_task(
                asyncio.to_thread(maybe_publish_scheduled_backup, store_env)
            )
        except RuntimeError:
            pass
    return response


def _resolve_effective_backup_dir(store_env):
    configured = resolve_backup_dir(config=store_env.get('_config'))
    if configured is not None:
        return configured
    # Local safety net until the user points backups at a synced folder.
    return default_app_data_dir() / 'backups'


def maybe_publish_scheduled_backup(store_env, *, force=False):
    """Publish a static snapshot when the newest own backup is older than the
    configured interval. Runs on a worker thread; never raises."""
    if store_env is None:
        return False
    store = store_env.get('store')
    interval = store_env.get('_backup_interval_seconds', 24 * 3600.0)
    if store is None or interval <= 0:
        return False
    lock = store_env.get('_maintenance_lock')
    if lock is None:
        return False
    # Non-blocking: concurrent save-triggered maintenance returns fast and
    # never queues behind a running backup. The staleness check happens
    # INSIDE the lock so two threads cannot both deem the backup overdue.
    if not lock.acquire(blocking=False):
        return False
    try:
        backup_dir = _resolve_effective_backup_dir(store_env)
        newest = store.latest_own_backup_stamp(backup_dir)
        if newest is not None and not force:
            newest_at = datetime.strptime(newest, '%Y%m%dT%H%M%SZ').replace(
                tzinfo=timezone.utc
            )
            age = (datetime.now(timezone.utc) - newest_at).total_seconds()
            if age < interval:
                return False
        published = store.publish_backup(
            backup_dir,
            keep_daily=store_env.get('_backup_keep_daily', DEFAULT_BACKUP_KEEP_DAILY),
            keep_weekly=store_env.get('_backup_keep_weekly', DEFAULT_BACKUP_KEEP_WEEKLY),
        )
        logger.info('published scheduled workspace backup: %s', published)
        # A freshly verified backup is the precondition for destructive
        # retention: prune revisions, then reclaim space in a bounded pass
        # only when the freelist justifies it. Failures here never touch
        # the just-published backup or affect saves.
        try:
            deleted = store.prune_revisions(
                keep_recent=store_env.get(
                    '_revision_keep_recent', DEFAULT_REVISION_KEEP_RECENT
                ),
                keep_daily_days=store_env.get(
                    '_revision_keep_daily_days', DEFAULT_REVISION_KEEP_DAILY_DAYS
                ),
            )
            if deleted:
                logger.info(
                    'pruned %d workspace revisions after verified backup', deleted
                )
            threshold = store_env.get(
                '_vacuum_freelist_pages', DEFAULT_VACUUM_FREELIST_PAGES
            )
            if threshold > 0 and store.freelist_count() >= threshold:
                store.incremental_vacuum(
                    max_pages=store_env.get('_vacuum_max_pages', DEFAULT_VACUUM_MAX_PAGES)
                )
                logger.info('reclaimed freelist pages with bounded incremental vacuum')
        except Exception:
            logger.exception('post-backup retention maintenance failed; data intact')
        return True
    except Exception:
        logger.exception('scheduled workspace backup failed; saves are unaffected')
        return False
    finally:
        lock.release()


def publish_backup_best_effort(store_env):
    """Shutdown hook: top up the scheduled backup if it is due. Never raises
    and never blocks shutdown on failure."""
    try:
        maybe_publish_scheduled_backup(store_env)
    except Exception:
        pass


async def _dispatch_store_call(store, action, data):
    if action == 'list_saved_workspaces':
        include_deleted = data.get('includeDeleted') is True
        documents = await asyncio.to_thread(
            lambda: store.list_documents(include_deleted=include_deleted)
        )
        if include_deleted:
            return {'documents': documents}
        for meta in documents:
            meta.pop('deletedAtUtc', None)
        return {'documents': documents}

    if action == 'load_saved_workspace':
        loaded = await asyncio.to_thread(
            store.load_workspace, _required_str(data, 'documentId')
        )
        payload = loaded.pop('payload')
        loaded.pop('deletedAtUtc', None)
        return {'document': loaded, 'payload': payload}

    if action == 'save_saved_workspace':
        result = await asyncio.to_thread(
            lambda: store.save_workspace(
                document_id=_required_str(data, 'documentId'),
                title=data.get('title'),
                payload=data.get('payload'),
                save_token=_required_str(data, 'saveToken'),
                expected_revision=_optional_int(data, 'expectedRevision'),
            )
        )
        idempotent = result.pop('idempotentReplay', False)
        return {'document': result, 'idempotentReplay': idempotent}

    if action == 'delete_saved_workspace':
        return await asyncio.to_thread(
            store.delete_document,
            _required_str(data, 'documentId'),
            _required_int(data, 'expectedRevision'),
        )

    if action == 'undelete_saved_workspace':
        return await asyncio.to_thread(
            store.undelete_document,
            _required_str(data, 'documentId'),
            _required_int(data, 'expectedRevision'),
        )

    if action == 'list_workspace_revisions':
        document_id = _required_str(data, 'documentId')
        revisions = await asyncio.to_thread(
            lambda: store.list_revisions(
                document_id,
                limit=_optional_int(data, 'limit') or 50,
                before_revision=_optional_int(data, 'beforeRevision'),
            )
        )
        return {'documentId': document_id, 'revisions': revisions}

    if action == 'restore_workspace_revision':
        result = await asyncio.to_thread(
            lambda: store.restore_revision(
                document_id=_required_str(data, 'documentId'),
                revision=_required_int(data, 'revision'),
                save_token=_required_str(data, 'saveToken'),
                expected_revision=_required_int(data, 'expectedRevision'),
            )
        )
        idempotent = result.pop('idempotentReplay', False)
        return {'document': result, 'idempotentReplay': idempotent}

    raise InvalidRequestError(f'unhandled persistence action {action}')


def _request_id(data):
    request_id = data.get('requestId') if isinstance(data, dict) else None
    return request_id if isinstance(request_id, str) else ''


def _required_str(data, field):
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise InvalidRequestError(f'{field} is required')
    return value


def _required_int(data, field):
    value = data.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidRequestError(f'{field} must be an integer')
    return value


def _optional_int(data, field):
    value = data.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidRequestError(f'{field} must be an integer')
    return value


def _error_response(server_action, request_id, code, message):
    return {
        'action': server_action,
        'requestId': request_id,
        'success': False,
        'code': code,
        'message': message,
    }


def _log_result(action, request_id, data, started, result=None, error=None):
    elapsed_ms = int((time.monotonic() - started) * 1000)
    document_id = data.get('documentId', '') if isinstance(data, dict) else ''
    if error is not None:
        logger.warning(
            'persistence %s request=%s doc=%s failed code=%s in %dms',
            action, request_id, document_id, error, elapsed_ms,
        )
        return
    revision = ''
    payload_bytes = ''
    if isinstance(result, dict):
        document = result.get('document')
        if isinstance(document, dict):
            revision = document.get('revision', '')
            payload_bytes = document.get('payloadBytes', '')
    logger.info(
        'persistence %s request=%s doc=%s rev=%s bytes=%s ok in %dms',
        action, request_id, document_id, revision, payload_bytes, elapsed_ms,
    )
