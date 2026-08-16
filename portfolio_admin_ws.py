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
import uuid

import portfolio_archive
import portfolio_maintenance
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
    'preview_workspace_archive': 'workspace_archive_previewed',
    'execute_workspace_archive': 'workspace_archive_started',
    'cancel_workspace_maintenance_job': 'workspace_maintenance_cancel_requested',
    'list_workspace_maintenance_jobs': 'workspace_maintenance_jobs_list',
    'list_workspace_archive_batches': 'workspace_archive_batches_list',
    'list_archived_workspaces': 'archived_workspaces_list',
    'request_workspace_space_reclaim': 'workspace_space_reclaim_started',
    'restore_archived_workspace': 'workspace_archive_restore_started',
}

RESTORE_MODES = ('revision', 'copy')

MAX_PAGE_SIZE = 100

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
        archive_enabled = store_env.get('_archive_enabled', True) is True
        response.update({
            'schemaVersion': SCHEMA_USER_VERSION,
            'capability': {
                'readOnly': True,
                'statsFast': True,
                'statsExact': True,
                'archivePreview': archive_enabled,
                # Full archive: copy + verify, then verified removal from
                # the active database in bounded chunk transactions.
                'archiveExecute': archive_enabled,
                # Restore: archived revision -> new head, whole document ->
                # copy with a fresh id. Rehydrate Original stays absent
                # until its re-archive semantics are implemented and tested.
                'restore': archive_enabled,
                'rehydrateOriginal': False,
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

        if action == 'preview_workspace_archive':
            if store_env.get('_archive_enabled', True) is not True:
                return _error_response(
                    server_action, request_id, 'archive_disabled',
                    'archiving is disabled by configuration',
                )
            plan = await asyncio.to_thread(_create_archive_plan, store_env)
            _log(action, request_id, started)
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'planToken': plan['planToken'],
                'expiresInSeconds': plan['ttlSeconds'],
                'policy': plan['policy'],
                'totals': plan['totals'],
                'manifestHashPrefix': plan['manifestHash'][:16],
                'copyOnly': True,
            }

        if action == 'execute_workspace_archive':
            if store_env.get('_archive_enabled', True) is not True:
                return _error_response(
                    server_action, request_id, 'archive_disabled',
                    'archiving is disabled by configuration',
                )
            token = data.get('planToken')
            if not isinstance(token, str) or not _TOKEN_RE.match(token):
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    'planToken must match the restricted token format',
                )
            result = await asyncio.to_thread(
                _consume_plan_and_start_job, store_env, token
            )
            if 'errorCode' in result:
                return _error_response(
                    server_action, request_id, result['errorCode'],
                    result['message'],
                )
            _log(action, request_id, started)
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'job': result['job'],
                'alreadyStarted': result['alreadyStarted'],
                'copyOnly': True,
            }

        if action == 'list_workspace_maintenance_jobs':
            page, page_size = _page_params(data)
            if page is None:
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    f'page must be >= 1 and pageSize 1..{MAX_PAGE_SIZE}',
                )
            listing = await asyncio.to_thread(
                lambda: store.list_maintenance_jobs(
                    limit=page_size, offset=(page - 1) * page_size,
                )
            )
            _log(action, request_id, started)
            return {
                'action': server_action, 'requestId': request_id,
                'success': True, 'page': page, 'pageSize': page_size,
                'total': listing['total'], 'jobs': listing['jobs'],
            }

        if action == 'list_archived_workspaces':
            page, page_size = _page_params(data)
            if page is None:
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    f'page must be >= 1 and pageSize 1..{MAX_PAGE_SIZE}',
                )
            listing = await asyncio.to_thread(
                lambda: store.list_archived_documents_summary(
                    limit=page_size, offset=(page - 1) * page_size,
                )
            )
            _log(action, request_id, started)
            return {
                'action': server_action, 'requestId': request_id,
                'success': True, 'page': page, 'pageSize': page_size,
                'total': listing['total'],
                'documents': listing['documents'],
            }

        if action == 'list_workspace_archive_batches':
            page, page_size = _page_params(data)
            if page is None:
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    f'page must be >= 1 and pageSize 1..{MAX_PAGE_SIZE}',
                )
            archive_id = data.get('archiveId')
            result = await asyncio.to_thread(
                _list_shard_batches, store_env, archive_id, page, page_size,
            )
            if 'errorCode' in result:
                return _error_response(
                    server_action, request_id, result['errorCode'],
                    result['message'],
                )
            _log(action, request_id, started)
            return {
                'action': server_action, 'requestId': request_id,
                'success': True, 'archiveId': archive_id,
                'page': page, 'pageSize': page_size,
                'total': result['total'], 'batches': result['batches'],
            }

        if action == 'request_workspace_space_reclaim':
            result = await asyncio.to_thread(_start_reclaim_job, store_env)
            if 'errorCode' in result:
                return _error_response(
                    server_action, request_id, result['errorCode'],
                    result['message'],
                )
            _log(action, request_id, started)
            return {
                'action': server_action, 'requestId': request_id,
                'success': True, 'job': result['job'],
            }

        if action == 'restore_archived_workspace':
            mode = data.get('mode')
            if mode not in RESTORE_MODES:
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    f'mode must be one of {RESTORE_MODES} '
                    '(rehydrate is not available in this version)',
                )
            document_id = data.get('documentId')
            if not isinstance(document_id, str) or not _TOKEN_RE.match(document_id):
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    'documentId must match the restricted token format',
                )
            revision = data.get('revision')
            if mode == 'revision' and (
                    isinstance(revision, bool) or not isinstance(revision, int)
                    or revision < 1):
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    'revision must be a positive integer for mode "revision"',
                )
            job = await asyncio.to_thread(
                _start_restore_job, store_env, mode, document_id, revision,
            )
            _log(action, request_id, started)
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'job': job,
            }

        if action == 'cancel_workspace_maintenance_job':
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
            accepted = await asyncio.to_thread(store.request_job_cancel, job_id)
            _log(action, request_id, started)
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'jobId': job_id,
                'cancelRequested': bool(accepted),
                'jobStatus': job['status'],
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
        'archive': {
            **raw['archive'],
            'archiveIds': [
                row['archive_id'] for row in store.list_archive_registry()
            ],
        },
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


def _create_archive_plan(store_env):
    """Build the preview manifest server-side and register a single-use
    planToken. The full manifest never leaves the server; the page only
    receives totals. Tokens are process-local: a backend restart or the
    other backend cannot execute them (plan section 9.1)."""
    store = store_env['store']
    policy = _policy(store_env)
    preview = portfolio_archive.build_archive_preview(store, policy={
        'revisionKeepRecent': policy['revisionKeepRecent'],
        'revisionKeepDailyDays': policy['revisionKeepDailyDays'],
        'archiveDeletedAfterDays': policy['archiveDeletedAfterDays'],
    })
    ttl_seconds = store_env.get('_archive_plan_ttl_seconds', 900)
    created_at = store.now_utc().isoformat(
        timespec='milliseconds'
    ).replace('+00:00', 'Z')
    nonce = uuid.uuid4().hex
    token = f'plan-{uuid.uuid4().hex}'
    plan = dict(preview)
    plan.update({
        'planToken': token,
        'ttlSeconds': ttl_seconds,
        'createdAtUtc': created_at,
        'expiresAtMonotonic': time.monotonic() + ttl_seconds,
        'serverInstanceId': store_env.get('_server_instance_id'),
        'fingerprint': portfolio_archive.compute_generation_fingerprint(
            preview, install_id=store.ensure_install_id(),
            created_at_utc=created_at, nonce=nonce,
        ),
        'consumedByJobId': None,
    })
    plans = store_env.setdefault('_archive_plans', {})
    # Prune expired plans so the registry cannot grow unbounded.
    now_monotonic = time.monotonic()
    for stale_token in [
        key for key, value in plans.items()
        if value['expiresAtMonotonic'] <= now_monotonic
        and value['consumedByJobId'] is None
    ]:
        del plans[stale_token]
    plans[token] = plan
    return plan


def _consume_plan_and_start_job(store_env, token):
    """Validate + consume the plan token, create the job, start the worker.
    Runs on a worker thread; returns either {'job': ..} or an error dict."""
    store = store_env['store']
    plans = store_env.get('_archive_plans') or {}
    plan = plans.get(token)
    if plan is None:
        return {'errorCode': 'archive_plan_expired',
                'message': 'unknown or expired plan token; run a new preview'}
    if plan['consumedByJobId'] is not None:
        job = store.get_maintenance_job(plan['consumedByJobId'])
        if job is not None:
            return {'job': job, 'alreadyStarted': True}
        return {'errorCode': 'archive_plan_already_consumed',
                'message': 'plan token was already executed'}
    if plan['expiresAtMonotonic'] <= time.monotonic():
        return {'errorCode': 'archive_plan_expired',
                'message': 'plan token expired; run a new preview'}
    if plan['serverInstanceId'] != store_env.get('_server_instance_id'):
        return {'errorCode': 'archive_plan_stale',
                'message': 'plan token belongs to another backend instance'}

    import os as _os
    job = store.create_maintenance_job(
        job_type='archive_copy',
        requested_policy=plan['policy'],
        owner_instance_id=store_env.get('_server_instance_id'),
        owner_pid=_os.getpid(),
    )
    plan['consumedByJobId'] = job['jobId']
    thread = threading.Thread(
        target=_run_archive_copy_job,
        args=(store_env, job['jobId'], plan),
        name=f'archive-copy-{job["jobId"]}',
        daemon=True,
    )
    thread.start()
    return {'job': job, 'alreadyStarted': False}


def _run_archive_copy_job(store_env, job_id, plan):
    store = store_env.get('store')
    if store is None:
        return
    guard = portfolio_maintenance.acquire_maintenance(store_env)
    if guard is None:
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='maintenance_busy',
                error_message='another maintenance task is running',
            )
        except Exception:
            logger.exception('failed to mark archive job busy')
        return
    try:
        store.start_maintenance_job(job_id, fencing_token=guard.fencing_token)
        summary = portfolio_archive.run_archive_job(store_env, guard, job_id, plan)
        status = 'canceled' if summary.get('canceled') else 'completed'
        store.finish_maintenance_job(job_id, status=status, summary=summary)
    except PortfolioStoreError as exc:
        logger.warning('archive copy job %s failed: %s (%s)',
                       job_id, exc, exc.code)
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code=exc.code,
                error_message='archive copy failed; see server log',
            )
        except Exception:
            logger.exception('failed to record archive-copy failure')
    except Exception:
        logger.exception('archive copy job %s crashed', job_id)
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='internal_store_error',
                error_message='archive copy failed; see server log',
            )
        except Exception:
            logger.exception('failed to record archive-copy failure')
    finally:
        guard.release()


def _start_exact_stats_job(store_env):
    """Create the job row, then run the scan on a daemon thread under the
    shared maintenance lock. The creation ACK and the job outcome are two
    distinct states; the page polls get_workspace_maintenance_job."""
    store = store_env['store']
    import os as _os
    job = store.create_maintenance_job(
        job_type='exact_stats',
        owner_instance_id=store_env.get('_server_instance_id'),
        owner_pid=_os.getpid(),
    )
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
    if store is None:
        return
    guard = portfolio_maintenance.acquire_maintenance(store_env)
    if guard is None:
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='maintenance_busy',
                error_message='another maintenance task is running',
            )
        except Exception:
            logger.exception('failed to mark exact-stats job busy')
        return
    try:
        store.start_maintenance_job(job_id, fencing_token=guard.fencing_token)
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
        guard.release()


def _page_params(data):
    """Validated (page, pageSize) or (None, None) on any violation."""
    page = data.get('page', 1)
    page_size = data.get('pageSize', 25)
    if (isinstance(page, bool) or not isinstance(page, int) or page < 1
            or isinstance(page_size, bool) or not isinstance(page_size, int)
            or not 1 <= page_size <= MAX_PAGE_SIZE):
        return None, None
    return page, page_size


def _list_shard_batches(store_env, archive_id, page, page_size):
    """Read one registered shard's batch list. The archive id must be
    registered and its file present; ids never reach the filesystem
    without the strict pattern + containment check."""
    store = store_env['store']
    registry = {
        row['archive_id']: row for row in store.list_archive_registry()
    }
    row = registry.get(archive_id) if isinstance(archive_id, str) else None
    if row is None:
        return {'errorCode': 'archive_not_found',
                'message': 'unknown archive id'}
    archive_dir = portfolio_archive.resolve_archive_dir(
        store.db_path, config=store_env.get('_config')
    )
    try:
        path = portfolio_archive.archive_path_for_id(archive_dir, archive_id)
    except PortfolioStoreError as exc:
        return {'errorCode': exc.code, 'message': 'unknown archive id'}
    if not path.exists():
        return {'errorCode': 'archive_not_found',
                'message': 'archive shard file is missing'}
    shard = portfolio_archive.ArchiveShard(path, now=store.now_utc)
    batches = shard.list_batches((
        'copying', 'copied', 'verified', 'main_committed',
        'cancel_requested', 'cleanup_pending', 'canceled', 'failed',
    ))
    batches.sort(key=lambda b: (b['created_at_utc'], b['batch_id']),
                 reverse=True)
    window = batches[(page - 1) * page_size:page * page_size]
    return {
        'total': len(batches),
        'batches': [
            {
                'batchId': b['batch_id'],
                'status': b['status'],
                'documentCount': b['document_count'],
                'revisionCount': b['revision_count'],
                'payloadBytes': b['payload_bytes'],
                'manifestShaPrefix': (b['manifest_sha256'] or '')[:16],
                'createdAtUtc': b['created_at_utc'],
                'verifiedAtUtc': b['verified_at_utc'],
                'committedAtUtc': b['committed_at_utc'],
            }
            for b in window
        ],
    }


def _start_reclaim_job(store_env):
    """Bounded incremental vacuum as a background job. Refused when the
    freelist is below the configured threshold — reclaiming then would be
    churn with nothing to reclaim."""
    store = store_env['store']
    threshold = store_env.get('_vacuum_freelist_pages', 256)
    freelist = store.freelist_count()
    if threshold <= 0 or freelist < threshold:
        return {'errorCode': 'unsafe_reclaim_refused',
                'message': f'freelist has {freelist} pages; '
                           f'threshold is {threshold}'}
    import os as _os
    job = store.create_maintenance_job(
        job_type='space_reclaim',
        owner_instance_id=store_env.get('_server_instance_id'),
        owner_pid=_os.getpid(),
    )
    thread = threading.Thread(
        target=_run_reclaim_job, args=(store_env, job['jobId']),
        name=f'space-reclaim-{job["jobId"]}', daemon=True,
    )
    thread.start()
    return {'job': job}


def _run_reclaim_job(store_env, job_id):
    store = store_env.get('store')
    if store is None:
        return
    guard = portfolio_maintenance.acquire_maintenance(store_env)
    if guard is None:
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='maintenance_busy',
                error_message='another maintenance task is running',
            )
        except Exception:
            logger.exception('failed to mark reclaim job busy')
        return
    try:
        store.start_maintenance_job(job_id, fencing_token=guard.fencing_token)
        before = store.freelist_count()
        store.incremental_vacuum(
            max_pages=store_env.get('_vacuum_max_pages', 512)
        )
        store.quick_check()
        store.finish_maintenance_job(job_id, status='completed', summary={
            'freelistPagesBefore': before,
            'freelistPagesAfter': store.freelist_count(),
            'maxPages': store_env.get('_vacuum_max_pages', 512),
        })
    except PortfolioStoreError as exc:
        logger.warning('space reclaim job %s failed: %s', job_id, exc)
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code=exc.code,
                error_message='space reclaim failed; see server log',
            )
        except Exception:
            logger.exception('failed to record reclaim failure')
    except Exception:
        logger.exception('space reclaim job %s crashed', job_id)
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='internal_store_error',
                error_message='space reclaim failed; see server log',
            )
        except Exception:
            logger.exception('failed to record reclaim failure')
    finally:
        guard.release()


def _start_restore_job(store_env, mode, document_id, revision):
    import os as _os
    store = store_env['store']
    job = store.create_maintenance_job(
        job_type='archive_restore',
        requested_policy={'mode': mode, 'documentId': document_id,
                          'revision': revision},
        owner_instance_id=store_env.get('_server_instance_id'),
        owner_pid=_os.getpid(),
    )
    thread = threading.Thread(
        target=_run_restore_job,
        args=(store_env, job['jobId'], mode, document_id, revision),
        name=f'archive-restore-{job["jobId"]}', daemon=True,
    )
    thread.start()
    return job


def _run_restore_job(store_env, job_id, mode, document_id, revision):
    store = store_env.get('store')
    if store is None:
        return
    guard = portfolio_maintenance.acquire_maintenance(store_env)
    if guard is None:
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='maintenance_busy',
                error_message='another maintenance task is running',
            )
        except Exception:
            logger.exception('failed to mark restore job busy')
        return
    try:
        store.start_maintenance_job(job_id, fencing_token=guard.fencing_token)
        if mode == 'revision':
            summary = portfolio_archive.restore_archived_revision(
                store_env, document_id=document_id, revision=revision,
            )
        else:
            summary = portfolio_archive.restore_archived_document_as_copy(
                store_env, document_id=document_id,
            )
        store.finish_maintenance_job(job_id, status='completed',
                                     summary=summary)
    except PortfolioStoreError as exc:
        logger.warning('restore job %s failed: %s (%s)', job_id, exc, exc.code)
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code=exc.code,
                error_message='restore failed; see server log',
            )
        except Exception:
            logger.exception('failed to record restore failure')
    except Exception:
        logger.exception('restore job %s crashed', job_id)
        try:
            store.finish_maintenance_job(
                job_id, status='failed', error_code='internal_store_error',
                error_message='restore failed; see server log',
            )
        except Exception:
            logger.exception('failed to record restore failure')
    finally:
        guard.release()


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
