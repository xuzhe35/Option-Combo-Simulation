"""Admin WebSocket protocol for the workspace database admin page.

Phase 2 scope (CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md): read-only
capability/status, fast storage stats, a background exact-stats job, and job
polling. Both backends route the same actions through here so Live and
Historical answer with identical shapes and stable error codes.

Hard rules carried over from the persistence layer and tightened for admin:
- loopback is checked BEFORE the database is lazily opened;
- an exception must never escape handle_admin_action() — one bad admin
  request must not tear down a socket carrying market data;
- responses never contain filesystem paths, SQL, or payload content; store
  error details go to the server log, the browser gets the stable code.
"""

import asyncio
import json
import logging
import re
import threading
import time

import portfolio_archive
import portfolio_store_ws
from portfolio_store import (
    DEFAULT_REVISION_KEEP_DAILY_DAYS,
    DEFAULT_REVISION_KEEP_RECENT,
    PortfolioStoreError,
    SCHEMA_USER_VERSION,
)

logger = logging.getLogger('portfolio_admin.ws')

ADMIN_SERVER_ACTIONS = {
    'request_workspace_admin_status': 'workspace_admin_status',
    'request_workspace_storage_stats': 'workspace_storage_stats',
    'get_workspace_maintenance_job': 'workspace_maintenance_job',
}

ADMIN_CLIENT_ACTIONS = frozenset(ADMIN_SERVER_ACTIONS)

STATS_MODES = ('fast', 'exact')

_TOKEN_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$')


async def handle_admin_action(store_env, websocket, data, *,
                              client_ip='Unknown', send=None):
    """Answer an admin action. Returns True when the action belonged to the
    admin protocol (a response was sent), False otherwise."""
    action = data.get('action') if isinstance(data, dict) else None
    if action not in ADMIN_CLIENT_ACTIONS:
        return False
    try:
        response = await _build_admin_response(
            store_env, websocket, data, client_ip=client_ip
        )
    except Exception:
        logger.exception('admin handler failed for action %r', action)
        response = _error_response(
            ADMIN_SERVER_ACTIONS[action], _request_id(data),
            'admin_unavailable', 'internal admin error',
        )
    try:
        message = json.dumps(response)
        if send is not None:
            await send(websocket, message)
        else:
            await websocket.send(message)
    except Exception:
        logger.warning('failed to send admin response for %r', action)
    return True


async def _build_admin_response(store_env, websocket, data, *, client_ip):
    action = data.get('action')
    server_action = ADMIN_SERVER_ACTIONS[action]
    request_id = _request_id(data)
    started = time.monotonic()

    store_env = store_env or {}
    # Loopback check strictly before the lazy database open.
    if not portfolio_store_ws.is_loopback_address(
        getattr(websocket, 'remote_address', None)
    ):
        logger.warning(
            'rejected non-loopback admin request %s from %s', action, client_ip
        )
        return _error_response(
            server_action, request_id,
            'remote_access_disabled', 'admin protocol is loopback-only',
        )

    if not store_env.get('_initialized') and store_env.get('_init_lock') is not None:
        await asyncio.to_thread(
            portfolio_store_ws.ensure_store_initialized, store_env
        )
    store = store_env.get('store')

    if action == 'request_workspace_admin_status':
        response = {
            'action': server_action,
            'requestId': request_id,
            'success': True,
            'available': store is not None,
        }
        if store is None:
            response['reason'] = store_env.get('reason') or 'admin_unavailable'
            return response
        current_job = await asyncio.to_thread(store.latest_active_maintenance_job)
        response.update({
            'schemaVersion': SCHEMA_USER_VERSION,
            'capability': {
                'readOnly': True,
                'statsFast': True,
                'statsExact': True,
                'archivePreview': False,
                'archiveExecute': False,
                'restore': False,
            },
            'policy': _policy(store_env),
            'currentJob': current_job,
        })
        _log(action, request_id, started)
        return response

    if store is None:
        return _error_response(
            server_action, request_id,
            store_env.get('reason') or 'admin_unavailable',
            'workspace store is unavailable',
        )

    try:
        if action == 'request_workspace_storage_stats':
            mode = data.get('mode', 'fast')
            if mode not in STATS_MODES:
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    f'mode must be one of {STATS_MODES}',
                )
            if mode == 'fast':
                stats = await asyncio.to_thread(_fast_stats, store, store_env)
                _log(action, request_id, started)
                return {
                    'action': server_action,
                    'requestId': request_id,
                    'success': True,
                    'mode': 'fast',
                    **stats,
                }
            job = await asyncio.to_thread(_start_exact_stats_job, store_env)
            _log(action, request_id, started)
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'mode': 'exact',
                'job': job,
            }

        if action == 'get_workspace_maintenance_job':
            job_id = data.get('jobId')
            if not isinstance(job_id, str) or not _TOKEN_RE.match(job_id):
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    'jobId must match the restricted token format',
                )
            job = await asyncio.to_thread(store.get_maintenance_job, job_id)
            if job is None:
                return _error_response(
                    server_action, request_id, 'job_not_found',
                    'no such maintenance job',
                )
            _log(action, request_id, started)
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'job': job,
            }
    except PortfolioStoreError as exc:
        # Stable code only; details (which may contain paths) go to the log.
        logger.warning(
            'admin %s request=%s failed code=%s: %s',
            action, request_id, exc.code, exc,
        )
        return _error_response(
            server_action, request_id, exc.code,
            'admin request failed; see server log',
        )

    return _error_response(
        server_action, request_id, 'invalid_request',
        f'unhandled admin action {action}',
    )


def _policy(store_env):
    return {
        'revisionKeepRecent': store_env.get(
            '_revision_keep_recent', DEFAULT_REVISION_KEEP_RECENT
        ),
        'revisionKeepDailyDays': store_env.get(
            '_revision_keep_daily_days', DEFAULT_REVISION_KEEP_DAILY_DAYS
        ),
        'archiveDeletedAfterDays': store_env.get(
            '_archive_deleted_after_days',
            portfolio_archive.DEFAULT_ARCHIVE_DELETED_AFTER_DAYS,
        ),
        'archiveAutoRun': False,
    }


def _fast_stats(store, store_env):
    """Runs on a worker thread: counters + PRAGMAs + candidate summary."""
    raw = store.storage_stats()
    snapshot = store.retention_snapshot()
    policy = _policy(store_env)
    now = store.now_utc()

    old_candidates = 0
    old_candidate_bytes = 0
    documents_with_candidates = 0
    for doc in snapshot['liveDocuments']:
        if not doc['revisions']:
            continue
        result = portfolio_archive.compute_revision_candidates(
            doc['revisions'],
            current_revision=doc['currentRevision'],
            keep_recent=policy['revisionKeepRecent'],
            keep_daily_days=policy['revisionKeepDailyDays'],
            now=now,
        )
        if result['candidates']:
            documents_with_candidates += 1
            old_candidates += len(result['candidates'])
            old_candidate_bytes += sum(
                row['payloadBytes'] for row in result['candidates']
            )

    deleted_result = portfolio_archive.compute_deleted_document_candidates(
        snapshot['deletedDocuments'],
        archive_deleted_after_days=policy['archiveDeletedAfterDays'],
        now=now,
    )
    expired_docs = deleted_result['candidates']

    metrics = portfolio_archive.assemble_storage_metrics(
        page_count=raw['pageCount'],
        page_size=raw['pageSize'],
        freelist_count=raw['freelistCount'],
        logical_payload_bytes=raw['logicalPayloadBytes'],
        db_file_bytes=raw['dbFileBytes'],
        wal_bytes=raw['walBytes'],
        shm_bytes=raw['shmBytes'],
    )
    return {
        'generatedAtUtc': now.isoformat(timespec='milliseconds').replace(
            '+00:00', 'Z'
        ),
        'documents': {
            'active': raw['activeDocuments'],
            'recentlyDeleted': raw['deletedDocuments'],
        },
        'revisions': {
            'count': raw['revisionCount'],
            'receiptCount': raw['receiptCount'],
            'receiptBytesEstimate': raw['receiptBytesEstimate'],
        },
        'storage': metrics,
        'recent': raw['recent'],
        'archive': raw['archive'],
        'candidates': {
            'oldRevisions': {
                'candidateCount': old_candidates,
                'candidateBytes': old_candidate_bytes,
                'documentCount': documents_with_candidates,
            },
            'expiredDeletedDocuments': {
                'documentCount': len(expired_docs),
                'revisionCount': sum(
                    doc['revisionCount'] for doc in expired_docs
                ),
                'payloadBytes': sum(
                    doc['payloadBytes'] for doc in expired_docs
                ),
            },
        },
    }


def _start_exact_stats_job(store_env):
    """Create the job row, then run the scan on a daemon thread under the
    shared maintenance lock. The creation ACK and the job outcome are two
    distinct states; the page polls get_workspace_maintenance_job."""
    store = store_env['store']
    job = store.create_maintenance_job(job_type='exact_stats')
    thread = threading.Thread(
        target=_run_exact_stats_job,
        args=(store_env, job['jobId']),
        name=f'exact-stats-{job["jobId"]}',
        daemon=True,
    )
    thread.start()
    return job


def _run_exact_stats_job(store_env, job_id):
    store = store_env.get('store')
    lock = store_env.get('_maintenance_lock')
    if store is None or lock is None:
        return
    if not lock.acquire(blocking=False):
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='maintenance_busy',
                error_message='another maintenance task is running',
            )
        except Exception:
            logger.exception('failed to mark exact-stats job busy')
        return
    try:
        store.start_maintenance_job(job_id)
        summary = store.exact_storage_scan()
        store.finish_maintenance_job(job_id, status='completed', summary=summary)
    except PortfolioStoreError as exc:
        logger.warning('exact stats job %s failed: %s', job_id, exc)
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code=exc.code,
                error_message='exact stats scan failed; see server log',
            )
        except Exception:
            logger.exception('failed to record exact-stats failure')
    except Exception:
        logger.exception('exact stats job %s crashed', job_id)
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='internal_store_error',
                error_message='exact stats scan failed; see server log',
            )
        except Exception:
            logger.exception('failed to record exact-stats failure')
    finally:
        lock.release()


def _request_id(data):
    request_id = data.get('requestId') if isinstance(data, dict) else None
    return request_id if isinstance(request_id, str) else ''


def _error_response(server_action, request_id, code, message):
    return {
        'action': server_action,
        'requestId': request_id,
        'success': False,
        'code': code,
        'message': message,
    }


def _log(action, request_id, started):
    elapsed_ms = int((time.monotonic() - started) * 1000)
    logger.info('admin %s request=%s ok in %dms', action, request_id, elapsed_ms)
