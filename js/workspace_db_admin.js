/**
 * Workspace DB admin page — transport and rendering.
 *
 * Dedicated minimal WebSocket client: this page never loads ws_client.js,
 * app.js, or any order/market/valuation script, and every outbound message
 * is routed through the core module's ALLOWED_CLIENT_ACTIONS list. One
 * request timeout is never rendered as a failed archive: the page only shows
 * what the backend reports and re-queries jobs by id after reconnect.
 */

(function bootWorkspaceDbAdmin(globalScope) {
    'use strict';

    const core = globalScope.OptionComboWorkspaceDbAdminCore;
    if (!core) {
        return;
    }

    const DEFAULT_WS_HOST = '127.0.0.1';
    const DEFAULT_WS_PORT = 8765;
    const WS_HOST_STORAGE_KEY = 'optionComboWsHost';
    const WS_PORT_STORAGE_KEY = 'optionComboWsPort';
    const RECONNECT_BASE_DELAY_MS = 5000;
    const RECONNECT_MAX_DELAY_MS = 60000;
    const JOB_POLL_INTERVAL_MS = 1000;

    const state = {
        ws: null,
        connection: 'disconnected',
        status: null,
        stats: null,
        activeJob: null,
        reconnectDelay: RECONNECT_BASE_DELAY_MS,
        reconnectTimer: null,
        jobPollTimer: null,
        requestCounter: 0,
    };

    function _readStorage(key, fallback) {
        try {
            const value = globalScope.localStorage.getItem(key);
            return value === null || value === undefined || value === ''
                ? fallback : value;
        } catch (_) {
            return fallback;
        }
    }

    function _wsUrl() {
        const host = String(_readStorage(WS_HOST_STORAGE_KEY, DEFAULT_WS_HOST))
            .replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '') || DEFAULT_WS_HOST;
        const port = parseInt(_readStorage(WS_PORT_STORAGE_KEY, DEFAULT_WS_PORT), 10);
        const safePort = Number.isInteger(port) && port > 0 && port <= 65535
            ? port : DEFAULT_WS_PORT;
        return `ws://${host}:${safePort}`;
    }

    function _nextRequestId() {
        state.requestCounter += 1;
        return `admin-${String(state.requestCounter).padStart(8, '0')}-page`;
    }

    function _send(action, extra) {
        if (core.ALLOWED_CLIENT_ACTIONS.indexOf(action) === -1) {
            // Structurally unreachable; kept as a hard stop so a future edit
            // cannot quietly widen this page's protocol surface.
            return null;
        }
        if (!state.ws || state.ws.readyState !== 1) {
            return null;
        }
        const request = Object.assign(
            { action, requestId: _nextRequestId() }, extra || {}
        );
        state.ws.send(JSON.stringify(request));
        return request.requestId;
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function _element(id) {
        const doc = globalScope.document;
        return doc && typeof doc.getElementById === 'function'
            ? doc.getElementById(id) : null;
    }

    function _setText(id, text, exactTitle) {
        const element = _element(id);
        if (!element) {
            return;
        }
        element.textContent = text;
        if (exactTitle !== undefined && exactTitle !== null) {
            element.title = exactTitle;
        } else {
            element.title = '';
        }
    }

    function _renderBytes(id, value) {
        const formatted = core.formatBytes(value);
        _setText(id, formatted.human, formatted.exact);
    }

    function _renderCount(id, value) {
        _setText(id, core.formatCount(value).human);
    }

    const CONNECTION_LABELS = {
        disconnected: 'Disconnected — retrying automatically',
        connecting: 'Connecting…',
        connected: 'Connected',
        unavailable: 'Connected — workspace store unavailable',
    };

    function _renderConnection() {
        const banner = _element('connection-banner');
        if (banner) {
            banner.textContent = CONNECTION_LABELS[state.connection]
                || CONNECTION_LABELS.disconnected;
            banner.dataset.state = state.connection;
        }
        _renderButtons();
    }

    function _renderButtons() {
        const availability = core.buttonAvailability({
            connection: state.connection,
            storeAvailable: !!(state.status && state.status.available),
            jobRunning: !!(state.activeJob && !state.activeJob.isTerminal),
        });
        const refresh = _element('btn-refresh-stats');
        if (refresh) {
            refresh.disabled = !availability.refreshStats;
        }
        const exact = _element('btn-exact-stats');
        if (exact) {
            exact.disabled = !availability.exactStats;
        }
    }

    function _renderStatus() {
        const status = state.status;
        _setText('admin-schema-version',
            status && status.schemaVersion !== null
                ? String(status.schemaVersion) : 'unavailable');
        if (status && status.policy) {
            _setText('admin-policy',
                `keep ${status.policy.revisionKeepRecent} recent · daily anchors `
                + `${status.policy.revisionKeepDailyDays}d · deleted grace `
                + `${status.policy.archiveDeletedAfterDays}d · auto-run off`);
        } else {
            _setText('admin-policy', 'unavailable');
        }
        _renderButtons();
    }

    function _renderStats() {
        const stats = state.stats;
        const s = stats || {
            documents: {}, revisions: {}, storage: {}, archive: {},
            recent: { last7Days: {}, last30Days: {} },
            candidates: { oldRevisions: {}, expiredDeletedDocuments: {} },
        };
        _renderCount('stat-active-documents', s.documents.active);
        _renderCount('stat-deleted-documents', s.documents.recentlyDeleted);
        _renderCount('stat-revision-count', s.revisions.count);
        _renderCount('stat-receipt-count', s.revisions.receiptCount);
        _renderBytes('stat-receipt-bytes', s.revisions.receiptBytesEstimate);
        _renderBytes('stat-logical-bytes', s.storage.logicalPayloadBytes);
        _renderBytes('stat-allocated-bytes', s.storage.allocatedDbBytes);
        _renderBytes('stat-reclaimable-bytes', s.storage.reclaimableBytes);
        _renderBytes('stat-wal-bytes', s.storage.walBytes);
        _renderBytes('stat-db-file-bytes', s.storage.dbFileBytes);
        _renderCount('stat-recent7-revisions', s.recent.last7Days.revisions);
        _renderBytes('stat-recent7-bytes', s.recent.last7Days.payloadBytes);
        _renderCount('stat-recent30-revisions', s.recent.last30Days.revisions);
        _renderBytes('stat-recent30-bytes', s.recent.last30Days.payloadBytes);
        _renderCount('stat-archive-count', s.archive.archiveCount);
        _renderCount('stat-archive-missing', s.archive.missingCount);
        _renderBytes('stat-archive-file-bytes', s.archive.fileBytes);
        _renderCount('stat-archive-revisions', s.archive.revisionCount);
        _renderCount('candidate-old-revisions', s.candidates.oldRevisions.candidateCount);
        _renderBytes('candidate-old-revision-bytes', s.candidates.oldRevisions.candidateBytes);
        _renderCount('candidate-deleted-documents', s.candidates.expiredDeletedDocuments.documentCount);
        _renderBytes('candidate-deleted-bytes', s.candidates.expiredDeletedDocuments.payloadBytes);
        _setText('stats-generated-at', stats && stats.generatedAtUtc
            ? stats.generatedAtUtc : 'unavailable');
    }

    function _renderJob() {
        const job = state.activeJob;
        if (!job) {
            _setText('job-status', 'No maintenance job running');
        } else if (job.isTerminal) {
            const suffix = job.errorCode ? ` (${job.errorCode})` : '';
            let line = `${job.jobType || 'job'} ${job.status}${suffix}`;
            if (job.status === 'completed' && job.summary
                && job.summary.payloadBytesMismatches !== undefined) {
                line += ` — ${job.summary.payloadBytesMismatches} byte mismatches, `
                    + `${job.summary.revisionsMissingReceipts} missing receipts`;
            }
            _setText('job-status', line);
        } else {
            _setText('job-status', `${job.jobType || 'job'} ${job.status}…`);
        }
        _renderButtons();
    }

    // ------------------------------------------------------------------
    // Message handling
    // ------------------------------------------------------------------

    function _handleMessage(rawData) {
        let data = null;
        try {
            data = JSON.parse(rawData);
        } catch (_) {
            return;
        }
        if (!data || typeof data !== 'object') {
            return;
        }
        if (data.action === 'workspace_admin_status') {
            state.status = core.normalizeAdminStatus(data);
            state.connection = core.connectionReducer(
                state.connection,
                state.status.available ? 'status-available' : 'status-unavailable'
            );
            _renderConnection();
            _renderStatus();
            if (state.status.currentJob && !state.status.currentJob.isTerminal) {
                state.activeJob = state.status.currentJob;
                _scheduleJobPoll();
                _renderJob();
            }
        } else if (data.action === 'workspace_storage_stats') {
            if (data.success === true && data.mode === 'exact') {
                state.activeJob = core.normalizeJob(data.job);
                _scheduleJobPoll();
                _renderJob();
            } else {
                state.stats = core.normalizeStorageStats(data);
                _renderStats();
            }
        } else if (data.action === 'workspace_maintenance_job') {
            if (data.success === true) {
                state.activeJob = core.normalizeJob(data.job);
            }
            if (state.activeJob && !state.activeJob.isTerminal) {
                _scheduleJobPoll();
            } else if (state.activeJob && state.activeJob.isTerminal) {
                // A finished exact-stats job refreshes the fast overview.
                _send('request_workspace_storage_stats', { mode: 'fast' });
            }
            _renderJob();
        }
    }

    function _scheduleJobPoll() {
        if (state.jobPollTimer !== null || !state.activeJob) {
            return;
        }
        state.jobPollTimer = globalScope.setTimeout(() => {
            state.jobPollTimer = null;
            if (state.activeJob && !state.activeJob.isTerminal) {
                _send('get_workspace_maintenance_job', {
                    jobId: state.activeJob.jobId,
                });
            }
        }, JOB_POLL_INTERVAL_MS);
    }

    // ------------------------------------------------------------------
    // Connection lifecycle
    // ------------------------------------------------------------------

    function _connect() {
        if (state.ws) {
            return;
        }
        state.connection = core.connectionReducer(state.connection, 'socket-connecting');
        _renderConnection();
        let ws;
        try {
            ws = new globalScope.WebSocket(_wsUrl());
        } catch (_) {
            state.connection = core.connectionReducer(state.connection, 'socket-closed');
            _renderConnection();
            _scheduleReconnect();
            return;
        }
        state.ws = ws;
        ws.addEventListener('open', () => {
            state.reconnectDelay = RECONNECT_BASE_DELAY_MS;
            state.connection = core.connectionReducer(state.connection, 'socket-open');
            _renderConnection();
            _send('request_workspace_admin_status');
            _send('request_workspace_storage_stats', { mode: 'fast' });
        });
        ws.addEventListener('message', (event) => {
            _handleMessage(event.data);
        });
        ws.addEventListener('close', () => {
            state.ws = null;
            state.connection = core.connectionReducer(state.connection, 'socket-closed');
            _renderConnection();
            _scheduleReconnect();
        });
        ws.addEventListener('error', () => {
            // close follows; nothing to do here.
        });
    }

    function _scheduleReconnect() {
        if (state.reconnectTimer !== null) {
            return;
        }
        state.reconnectTimer = globalScope.setTimeout(() => {
            state.reconnectTimer = null;
            _connect();
        }, state.reconnectDelay);
        state.reconnectDelay = Math.min(
            state.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS
        );
    }

    function _bindControls() {
        const refresh = _element('btn-refresh-stats');
        if (refresh && typeof refresh.addEventListener === 'function') {
            refresh.addEventListener('click', () => {
                _send('request_workspace_admin_status');
                _send('request_workspace_storage_stats', { mode: 'fast' });
            });
        }
        const exact = _element('btn-exact-stats');
        if (exact && typeof exact.addEventListener === 'function') {
            exact.addEventListener('click', () => {
                _send('request_workspace_storage_stats', { mode: 'exact' });
            });
        }
    }

    function _boot() {
        _bindControls();
        _renderConnection();
        _renderStatus();
        _renderStats();
        _renderJob();
        _connect();
    }

    const doc = globalScope.document;
    if (doc && doc.readyState === 'loading'
        && typeof doc.addEventListener === 'function') {
        doc.addEventListener('DOMContentLoaded', _boot);
    } else if (doc) {
        _boot();
    }

    // Exposed for tests only; not part of any page contract.
    globalScope.OptionComboWorkspaceDbAdminPage = { state };
})(typeof window !== 'undefined' ? window : globalThis);
