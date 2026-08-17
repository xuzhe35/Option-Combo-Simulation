/**
 * Workspace DB admin page — transport and rendering.
 *
 * Dedicated minimal WebSocket client: this page never loads ws_client.js,
 * app.js, or any order/market/valuation script, and every outbound message
 * is routed through the core module's ALLOWED_CLIENT_ACTIONS list.
 *
 * Write flow (plan sections 10.3 / 11): Preview -> review server totals ->
 * type the exact confirmation phrase -> Execute -> poll the job by id. The
 * plan token lives ONLY in this closure's state — never in the URL,
 * localStorage, or logs. A request timeout is never rendered as a failed
 * archive: the page only shows what job polling reports, and after a
 * reconnect it re-discovers the active job from the admin status.
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
    const DOCS_PAGE_SIZE = 10;
    const JOBS_PAGE_SIZE = 10;
    const BATCHES_PAGE_SIZE = 10;

    const state = {
        ws: null,
        connection: 'disconnected',
        status: null,
        stats: null,
        plan: null,               // in-memory only; cleared on use/stale
        confirmationValid: false,
        confirmationText: '',
        activeJob: null,
        reconnectDelay: RECONNECT_BASE_DELAY_MS,
        reconnectTimer: null,
        jobPollTimer: null,
        requestCounter: 0,
        docsPage: 1,
        docsTotal: null,
        batchesArchiveId: '',
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

    function _escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    function _availability() {
        return core.buttonAvailability({
            connection: state.connection,
            storeAvailable: !!(state.status && state.status.available),
            capability: state.status ? state.status.capability : {},
            jobRunning: !!(state.activeJob && !state.activeJob.isTerminal),
            jobStage: core.jobStage(state.activeJob),
            planReady: !!state.plan,
            confirmationValid: state.confirmationValid,
        });
    }

    function _renderButtons() {
        const availability = _availability();
        const buttons = {
            'btn-refresh-stats': availability.refreshStats,
            'btn-exact-stats': availability.exactStats,
            'btn-preview-archive': availability.previewArchive,
            'btn-execute-archive': availability.executeArchive,
            'btn-cancel-job': availability.cancelJob,
            'btn-reclaim': availability.reclaim,
            'btn-verify-archive': availability.reclaim
                && !!state.batchesArchiveId,
        };
        for (const id of Object.keys(buttons)) {
            const element = _element(id);
            if (element) {
                element.disabled = !buttons[id];
            }
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
        _renderArchiveSelect();
    }

    function _renderArchiveSelect() {
        const select = _element('batch-archive-select');
        if (!select) {
            return;
        }
        const ids = (state.stats && state.stats.archive
            && Array.isArray(state.stats.archive.archiveIds))
            ? state.stats.archive.archiveIds : [];
        select.innerHTML = ['<option value="">— select shard —</option>']
            .concat(ids.map((id) =>
                `<option value="${_escapeHtml(id)}"${id === state.batchesArchiveId ? ' selected' : ''}>${_escapeHtml(id)}</option>`))
            .join('');
        select.disabled = ids.length === 0;
    }

    function _renderPlan() {
        const panel = _element('preview-summary');
        const hint = _element('confirm-hint');
        if (!state.plan) {
            if (panel) panel.textContent = 'No preview yet.';
            if (hint) hint.textContent = '';
            _renderButtons();
            return;
        }
        const totals = state.plan.totals;
        const bytes = core.formatBytes(totals.payloadBytes);
        if (panel) {
            panel.textContent =
                `Server plan: ${core.formatCount(totals.revisionCount).human} `
                + `revisions (${core.formatCount(totals.oldRevisionCount).human} old, `
                + `${core.formatCount(totals.deletedDocumentCount).human} deleted `
                + `documents) — ${bytes.human} would leave the active database `
                + `after a verified archive copy. Manifest ${state.plan.manifestHashPrefix}…, `
                + `expires in ${state.plan.expiresInSeconds}s.`;
        }
        if (hint) {
            hint.textContent =
                `Type exactly: ${core.confirmationTemplate(totals)}`;
        }
        _renderButtons();
    }

    function _renderGuidance(text) {
        _setText('guidance-line', text || '');
    }

    function _renderJob() {
        const job = state.activeJob;
        if (!job) {
            _setText('job-status', 'No maintenance job running');
        } else if (job.isTerminal) {
            const suffix = job.errorCode ? ` (${job.errorCode})` : '';
            let line = `${job.jobType || 'job'} ${job.status}${suffix}`;
            const summary = job.summary || {};
            if (job.status === 'completed' && summary.commit) {
                const space = summary.space || {};
                line += ` — removed ${summary.commit.removedRevisions} revisions`
                    + ` (${core.formatBytes(space.logicalRemovedBytes).human} logical)`
                    + `; freelist ${space.freelistPagesBefore}→${space.freelistPagesAfter} pages`
                    + `; file ${core.formatBytes(space.dbFileBytesAfter).human}`;
            } else if (job.status === 'completed'
                       && summary.payloadBytesMismatches !== undefined) {
                line += ` — ${summary.payloadBytesMismatches} byte mismatches, `
                    + `${summary.revisionsMissingReceipts} missing receipts`;
            } else if (job.status === 'completed'
                       && summary.mode === 'copy') {
                line += ` — restored "${summary.title}" as a new workspace `
                    + `(from ${summary.sourceDocumentId} rev `
                    + `${summary.sourceRevision}, shard ${summary.sourceArchiveId})`;
            } else if (job.status === 'completed'
                       && summary.mode === 'revision') {
                line += ` — restored revision ${summary.sourceRevision} of `
                    + `${summary.documentId} as new revision `
                    + `${summary.restoredRevision} (shard ${summary.sourceArchiveId})`;
            } else if (job.status === 'completed'
                       && summary.verifiedRevisions !== undefined) {
                line += ` — ${summary.archiveId} ${summary.status}: `
                    + `${summary.verifiedRevisions} revisions verified`
                    + (summary.orphanFiles && summary.orphanFiles.length
                        ? `; orphan files: ${summary.orphanFiles.join(', ')}`
                        : '');
            } else if (job.status === 'completed'
                       && summary.status === 'missing') {
                line += ` — ${summary.archiveId} is MISSING its shard file`;
            } else if (job.status === 'completed'
                       && summary.freelistPagesBefore !== undefined) {
                line += ` — freelist ${summary.freelistPagesBefore}`
                    + `→${summary.freelistPagesAfter} pages`;
            }
            _setText('job-status', line);
            if (job.status === 'failed' && job.errorCode) {
                _renderGuidance(core.errorGuidance(job.errorCode));
            }
        } else {
            const stage = core.jobStage(job);
            const stageNote = stage === 'committing'
                ? ' — committing to the active database (cannot cancel)'
                : (stage ? ` — ${stage}` : '');
            _setText('job-status', `${job.jobType || 'job'} ${job.status}${stageNote}…`);
        }
        _renderButtons();
    }

    function _renderJobsTable(listing) {
        const body = _element('jobs-table-body');
        if (!body) {
            return;
        }
        if (!listing || listing.items.length === 0) {
            body.innerHTML =
                '<tr><td colspan="5" class="empty">No tasks yet</td></tr>';
            return;
        }
        body.innerHTML = listing.items.map((job) => {
            const error = job.errorCode ? ` (${_escapeHtml(job.errorCode)})` : '';
            return '<tr>'
                + `<td>${_escapeHtml(job.jobType)}</td>`
                + `<td data-status="${_escapeHtml(job.status)}">${_escapeHtml(job.status)}${error}</td>`
                + `<td>${_escapeHtml(job.createdAtUtc)}</td>`
                + `<td>${_escapeHtml(job.finishedAtUtc || '—')}</td>`
                + `<td>${_escapeHtml(job.jobId)}</td>`
                + '</tr>';
        }).join('');
    }

    function _renderDocsTable(listing) {
        const body = _element('archived-docs-body');
        if (!body) {
            return;
        }
        if (!listing || listing.items.length === 0) {
            body.innerHTML =
                '<tr><td colspan="7" class="empty">No archived workspaces</td></tr>';
            _setText('docs-page-label', '');
            return;
        }
        state.docsTotal = listing.total;
        const restoreEnabled = _availability().restore;
        body.innerHTML = listing.items.map((doc, index) => {
            const whole = doc.kind === 'deleted_document';
            const kind = whole ? 'whole document' : 'old revisions';
            const count = doc.revisionCount !== null
                && doc.revisionCount !== undefined
                ? String(doc.revisionCount) : '—';
            const restoreCell = whole
                ? `<button id="restore-doc-${index}" type="button"`
                  + `${restoreEnabled ? '' : ' disabled'}>Restore as copy</button>`
                : `<input id="restore-rev-${index}" type="number" min="1" `
                  + `class="rev-input" value="${_escapeHtml(doc.lastArchivedRevision)}">`
                  + `<button id="restore-doc-${index}" type="button"`
                  + `${restoreEnabled ? '' : ' disabled'}>Restore revision</button>`;
            return '<tr>'
                + `<td>${_escapeHtml(doc.title)}</td>`
                + `<td>${_escapeHtml(doc.symbol)}</td>`
                + `<td>${_escapeHtml(kind)}</td>`
                + `<td>${_escapeHtml(count)}</td>`
                + `<td>${_escapeHtml(doc.archiveId)}</td>`
                + `<td>${_escapeHtml(doc.archivedAtUtc)}</td>`
                + `<td class="restore-cell">${restoreCell}</td>`
                + '</tr>';
        }).join('');
        listing.items.forEach((doc, index) => {
            const button = _element(`restore-doc-${index}`);
            if (!button || typeof button.addEventListener !== 'function') {
                return;
            }
            button.addEventListener('click', () => {
                if (!_availability().restore) {
                    return;
                }
                if (doc.kind === 'deleted_document') {
                    _send('restore_archived_workspace', {
                        mode: 'copy', documentId: doc.documentId,
                    });
                } else {
                    const input = _element(`restore-rev-${index}`);
                    const revision = input
                        ? parseInt(input.value, 10) : NaN;
                    if (!Number.isInteger(revision) || revision < 1) {
                        _renderGuidance(
                            'Enter the archived revision number to restore.'
                        );
                        return;
                    }
                    _send('restore_archived_workspace', {
                        mode: 'revision', documentId: doc.documentId,
                        revision,
                    });
                }
            });
        });
        const pages = Math.max(1, Math.ceil(listing.total / listing.pageSize));
        _setText('docs-page-label', `page ${listing.page} / ${pages}`);
    }

    function _renderBatchesTable(listing) {
        const body = _element('batches-table-body');
        if (!body) {
            return;
        }
        if (!listing || listing.items.length === 0) {
            body.innerHTML =
                '<tr><td colspan="6" class="empty">No batches</td></tr>';
            return;
        }
        body.innerHTML = listing.items.map((batch) =>
            '<tr>'
            + `<td>${_escapeHtml(batch.batchId)}</td>`
            + `<td data-status="${_escapeHtml(batch.status)}">${_escapeHtml(batch.status)}</td>`
            + `<td>${_escapeHtml(batch.revisionCount)}</td>`
            + `<td>${core.formatBytes(batch.payloadBytes).human}</td>`
            + `<td>${_escapeHtml(batch.manifestShaPrefix)}…</td>`
            + `<td>${_escapeHtml(batch.createdAtUtc)}</td>`
            + '</tr>').join('');
    }

    // ------------------------------------------------------------------
    // Data refresh
    // ------------------------------------------------------------------

    function _refreshLists() {
        _send('list_workspace_maintenance_jobs',
            { page: 1, pageSize: JOBS_PAGE_SIZE });
        _send('list_archived_workspaces',
            { page: state.docsPage, pageSize: DOCS_PAGE_SIZE });
        if (state.batchesArchiveId) {
            _send('list_workspace_archive_batches', {
                archiveId: state.batchesArchiveId,
                page: 1, pageSize: BATCHES_PAGE_SIZE,
            });
        }
    }

    function _refreshAll() {
        _send('request_workspace_admin_status');
        _send('request_workspace_storage_stats', { mode: 'fast' });
        _refreshLists();
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
        const action = data.action;
        if (action === 'workspace_admin_status') {
            state.status = core.normalizeAdminStatus(data);
            state.connection = core.connectionReducer(
                state.connection,
                state.status.available ? 'status-available' : 'status-unavailable'
            );
            _renderConnection();
            _renderStatus();
            if (state.status.currentJob && !state.status.currentJob.isTerminal) {
                // Reconnect recovery: an active job discovered from status
                // is re-polled by id; a lost execute ACK never creates a
                // second batch because the plan token is single-use.
                state.activeJob = state.status.currentJob;
                _scheduleJobPoll();
                _renderJob();
            }
        } else if (action === 'workspace_storage_stats') {
            if (data.success === true && data.mode === 'exact') {
                state.activeJob = core.normalizeJob(data.job);
                _scheduleJobPoll();
                _renderJob();
            } else if (data.success === true) {
                state.stats = core.normalizeStorageStats(data);
                _renderStats();
            } else {
                _renderGuidance(core.errorGuidance(data.code));
            }
        } else if (action === 'workspace_archive_previewed') {
            if (data.success === true) {
                state.plan = core.normalizeArchivePreview(data);
                state.confirmationValid = false;
                const input = _element('confirm-input');
                if (input) {
                    input.value = '';
                }
                _renderGuidance('');
            } else {
                state.plan = null;
                _renderGuidance(core.errorGuidance(data.code));
            }
            _renderPlan();
        } else if (action === 'workspace_archive_started') {
            if (data.success === true) {
                state.plan = null;  // token consumed; require a new preview
                state.confirmationValid = false;
                state.activeJob = core.normalizeJob(data.job);
                _scheduleJobPoll();
                _renderPlan();
                _renderJob();
            } else {
                if (data.code === 'archive_plan_stale'
                    || data.code === 'archive_plan_expired') {
                    state.plan = null;
                    _renderPlan();
                }
                _renderGuidance(core.errorGuidance(data.code));
            }
        } else if (action === 'workspace_maintenance_job') {
            if (data.success === true) {
                state.activeJob = core.normalizeJob(data.job);
            }
            if (state.activeJob && !state.activeJob.isTerminal) {
                _scheduleJobPoll();
            } else if (state.activeJob && state.activeJob.isTerminal) {
                _refreshAll();
            }
            _renderJob();
        } else if (action === 'workspace_maintenance_cancel_requested') {
            if (data.success !== true) {
                _renderGuidance(core.errorGuidance(data.code));
            }
        } else if (action === 'workspace_archive_verify_started') {
            if (data.success === true) {
                state.activeJob = core.normalizeJob(data.job);
                _scheduleJobPoll();
                _renderJob();
            } else {
                _renderGuidance(core.errorGuidance(data.code));
            }
        } else if (action === 'workspace_archive_restore_started') {
            if (data.success === true) {
                state.activeJob = core.normalizeJob(data.job);
                _scheduleJobPoll();
                _renderJob();
            } else {
                _renderGuidance(core.errorGuidance(data.code));
            }
        } else if (action === 'workspace_space_reclaim_started') {
            if (data.success === true) {
                state.activeJob = core.normalizeJob(data.job);
                _scheduleJobPoll();
                _renderJob();
            } else {
                _renderGuidance(core.errorGuidance(data.code));
            }
        } else if (action === 'workspace_maintenance_jobs_list') {
            _renderJobsTable(core.normalizePagedList(data, 'jobs'));
        } else if (action === 'archived_workspaces_list') {
            _renderDocsTable(core.normalizePagedList(data, 'documents'));
        } else if (action === 'workspace_archive_batches_list') {
            if (data.success === true) {
                _renderBatchesTable(core.normalizePagedList(data, 'batches'));
            } else {
                _renderGuidance(core.errorGuidance(data.code));
            }
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
            _refreshAll();
        });
        ws.addEventListener('message', (event) => {
            _handleMessage(event.data);
        });
        ws.addEventListener('close', () => {
            state.ws = null;
            // A dropped socket voids the preview (the server may have moved
            // on); the job, if any, is re-discovered after reconnecting.
            state.plan = null;
            state.confirmationValid = false;
            state.connection = core.connectionReducer(state.connection, 'socket-closed');
            _renderConnection();
            _renderPlan();
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

    function _on(id, event, handler) {
        const element = _element(id);
        if (element && typeof element.addEventListener === 'function') {
            element.addEventListener(event, handler);
        }
    }

    function _bindControls() {
        _on('btn-refresh-stats', 'click', () => {
            _refreshAll();
        });
        _on('btn-exact-stats', 'click', () => {
            _send('request_workspace_storage_stats', { mode: 'exact' });
        });
        _on('btn-preview-archive', 'click', () => {
            _send('preview_workspace_archive');
        });
        _on('confirm-input', 'input', (event) => {
            const value = event && event.target ? event.target.value : '';
            state.confirmationText = value;
            state.confirmationValid = !!(state.plan
                && core.validateConfirmation(value, state.plan.totals));
            _renderButtons();
        });
        _on('btn-execute-archive', 'click', () => {
            // The availability rule already required plan + confirmation;
            // re-check here so a stale DOM state can never execute.
            if (!state.plan || !_availability().executeArchive) {
                return;
            }
            _send('execute_workspace_archive', {
                planToken: state.plan.planToken,
                confirmation: state.confirmationText,
            });
        });
        _on('btn-cancel-job', 'click', () => {
            if (state.activeJob && !state.activeJob.isTerminal) {
                _send('cancel_workspace_maintenance_job', {
                    jobId: state.activeJob.jobId,
                });
            }
        });
        _on('btn-reclaim', 'click', () => {
            _send('request_workspace_space_reclaim');
        });
        _on('btn-verify-archive', 'click', () => {
            if (state.batchesArchiveId) {
                _send('verify_workspace_archive', {
                    archiveId: state.batchesArchiveId,
                });
            }
        });
        _on('batch-archive-select', 'change', (event) => {
            state.batchesArchiveId = event && event.target
                ? String(event.target.value || '') : '';
            _renderButtons();  // the Verify button follows the selection
            if (state.batchesArchiveId) {
                _send('list_workspace_archive_batches', {
                    archiveId: state.batchesArchiveId,
                    page: 1, pageSize: BATCHES_PAGE_SIZE,
                });
            } else {
                _renderBatchesTable(null);
            }
        });
        _on('docs-prev', 'click', () => {
            if (state.docsPage > 1) {
                state.docsPage -= 1;
                _send('list_archived_workspaces',
                    { page: state.docsPage, pageSize: DOCS_PAGE_SIZE });
            }
        });
        _on('docs-next', 'click', () => {
            const pages = state.docsTotal === null ? 1
                : Math.max(1, Math.ceil(state.docsTotal / DOCS_PAGE_SIZE));
            if (state.docsPage < pages) {
                state.docsPage += 1;
                _send('list_archived_workspaces',
                    { page: state.docsPage, pageSize: DOCS_PAGE_SIZE });
            }
        });
    }

    function _boot() {
        _bindControls();
        _renderConnection();
        _renderStatus();
        _renderStats();
        _renderPlan();
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
