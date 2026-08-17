const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function makeElement(id) {
    return {
        id,
        textContent: '',
        title: '',
        disabled: false,
        value: '',
        innerHTML: '',
        dataset: {},
        listeners: {},
        addEventListener(type, handler) {
            (this.listeners[type] = this.listeners[type] || []).push(handler);
        },
        click() {
            (this.listeners.click || []).forEach((handler) =>
                handler({ target: this }));
        },
        type(text) {
            this.value = text;
            (this.listeners.input || []).forEach((handler) =>
                handler({ target: this }));
        },
    };
}

function makeDocument() {
    const elements = new Map();
    return {
        readyState: 'complete',
        elements,
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, makeElement(id));
            }
            return elements.get(id);
        },
        addEventListener() {},
    };
}

function makeHarness() {
    const sockets = [];
    const timers = [];
    const storageWrites = [];
    class MockWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            this.listeners = {};
            sockets.push(this);
        }

        addEventListener(type, listener) {
            (this.listeners[type] = this.listeners[type] || []).push(listener);
        }

        send(message) {
            this.sent.push(message);
        }

        emit(type, event) {
            if (type === 'open') this.readyState = 1;
            if (type === 'close') this.readyState = 3;
            (this.listeners[type] || []).forEach((listener) => listener(event || {}));
        }
    }
    const document = makeDocument();
    const context = loadBrowserScripts([
        'js/workspace_db_admin_core.js',
        'js/workspace_db_admin.js',
    ], {
        document,
        WebSocket: MockWebSocket,
        localStorage: {
            getItem: () => null,
            setItem(key, value) {
                storageWrites.push({ key, value });
            },
        },
        setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimeout() {},
    });
    return { context, document, sockets, timers, storageWrites };
}

function sentActions(socket) {
    return socket.sent.map((raw) => JSON.parse(raw).action);
}

function statusFrame(overrides = {}) {
    return JSON.stringify({
        action: 'workspace_admin_status',
        requestId: 'x',
        success: true,
        available: true,
        schemaVersion: 2,
        capability: {
            readOnly: true, statsFast: true, statsExact: true,
            archivePreview: true, archiveExecute: true, restore: true,
        },
        policy: {
            revisionKeepRecent: 50, revisionKeepDailyDays: 90,
            archiveDeletedAfterDays: 30, archiveAutoRun: false,
        },
        currentJob: null,
        ...overrides,
    });
}

function previewFrame(overrides = {}) {
    return JSON.stringify({
        action: 'workspace_archive_previewed',
        requestId: 'x',
        success: true,
        planToken: 'plan-feedfacefeedfacefeedfacefeedface',
        expiresInSeconds: 900,
        totals: {
            revisionCount: 8, payloadBytes: 70000,
            oldRevisionCount: 6, deletedDocumentCount: 1,
        },
        manifestHashPrefix: 'abcd1234abcd1234',
        copyOnly: false,
        ...overrides,
    });
}

function connectAndStatus() {
    const harness = makeHarness();
    harness.sockets[0].emit('open');
    harness.sockets[0].emit('message', { data: statusFrame() });
    harness.sockets[0].sent.length = 0;
    return harness;
}

module.exports = {
    name: 'workspace_db_admin page',
    tests: [
        {
            name: 'the page script manifest holds only its own three assets',
            run() {
                const html = fs.readFileSync(
                    path.join(PROJECT_ROOT, 'workspace_db_admin.html'), 'utf8'
                );
                const references = [];
                const pattern = /\b(?:src|href)="([A-Za-z0-9_./-]+\.(?:js|css))(?:\?v=[^"]*)?"/g;
                let match = pattern.exec(html);
                while (match !== null) {
                    references.push(match[1]);
                    match = pattern.exec(html);
                }
                assert.deepEqual(references.sort(), [
                    'js/workspace_db_admin.js',
                    'js/workspace_db_admin_core.js',
                    'workspace_db_admin.css',
                ]);
                for (const forbidden of ['app.js', 'ws_client.js', 'order', 'valuation', 'pricing']) {
                    assert.equal(html.includes(`js/${forbidden}`), false,
                        `page must not reference ${forbidden}`);
                }
            },
        },
        {
            name: 'on open the page requests status, stats, and the lists',
            run() {
                const { sockets } = makeHarness();
                sockets[0].emit('open');
                assert.deepEqual(sentActions(sockets[0]), [
                    'request_workspace_admin_status',
                    'request_workspace_storage_stats',
                    'list_workspace_maintenance_jobs',
                    'list_archived_workspaces',
                ]);
            },
        },
        {
            name: 'stats render values, unavailable fields, and the shard select',
            run() {
                const { document, sockets } = connectAndStatus();
                sockets[0].emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_storage_stats', requestId: 'x',
                        success: true, mode: 'fast',
                        generatedAtUtc: '2026-08-16T00:00:00.000Z',
                        documents: { active: 7, recentlyDeleted: 1 },
                        revisions: { count: 42, receiptCount: 42,
                                     receiptBytesEstimate: 9000 },
                        storage: { logicalPayloadBytes: 123456 },
                        recent: {
                            last7Days: { revisions: 5, payloadBytes: 1000 },
                            last30Days: { revisions: 20, payloadBytes: 40000 },
                        },
                        archive: {
                            archiveCount: 1, sealedCount: 0, missingCount: 0,
                            fileBytes: 4096, logicalPayloadBytes: 100,
                            revisionCount: 3, lastVerifiedAtUtc: null,
                            archiveIds: ['portfolio-archive-2026-001'],
                        },
                        candidates: {
                            oldRevisions: { candidateCount: 3,
                                            candidateBytes: 777,
                                            documentCount: 1 },
                            expiredDeletedDocuments: { documentCount: 1,
                                                       revisionCount: 4,
                                                       payloadBytes: 555 },
                        },
                    }),
                });
                const value = (id) => document.getElementById(id).textContent;
                assert.equal(value('stat-active-documents'), '7');
                assert.equal(value('stat-logical-bytes'), '120.6 KiB');
                assert.equal(
                    document.getElementById('stat-logical-bytes').title,
                    '123,456 B'
                );
                // Partial storage: everything else is unavailable, never 0.
                assert.equal(value('stat-allocated-bytes'), 'unavailable');
                assert.equal(value('candidate-old-revisions'), '3');
                // The shard select is populated from the registry ids.
                const select = document.getElementById('batch-archive-select');
                assert.equal(select.disabled, false);
                assert.match(select.innerHTML, /portfolio-archive-2026-001/);
            },
        },
        {
            name: 'preview -> exact confirmation -> execute sends the token once',
            run() {
                const { document, sockets, storageWrites } = connectAndStatus();
                const socket = sockets[0];

                const previewButton = document.getElementById('btn-preview-archive');
                assert.equal(previewButton.disabled, false);
                previewButton.click();
                assert.deepEqual(sentActions(socket), ['preview_workspace_archive']);
                socket.sent.length = 0;
                socket.emit('message', { data: previewFrame() });

                const executeButton = document.getElementById('btn-execute-archive');
                const input = document.getElementById('confirm-input');
                assert.equal(executeButton.disabled, true);
                assert.match(
                    document.getElementById('confirm-hint').textContent,
                    /ARCHIVE 8 REVISIONS/
                );

                // Wrong phrase: still disabled, click is inert.
                input.type('ARCHIVE 7 REVISIONS');
                assert.equal(executeButton.disabled, true);
                executeButton.click();
                assert.deepEqual(sentActions(socket), []);

                input.type('ARCHIVE 8 REVISIONS');
                assert.equal(executeButton.disabled, false);
                executeButton.click();
                const request = JSON.parse(socket.sent[0]);
                assert.equal(request.action, 'execute_workspace_archive');
                assert.equal(request.planToken,
                    'plan-feedfacefeedfacefeedfacefeedface');
                // The typed phrase travels with the request: the SERVER
                // validates it — the button state is only UX.
                assert.equal(request.confirmation, 'ARCHIVE 8 REVISIONS');

                // The token never touched localStorage.
                assert.deepEqual(storageWrites, []);
            },
        },
        {
            name: 'a running archive job disables execute and tracks stages',
            run() {
                const { document, sockets, timers } = connectAndStatus();
                const socket = sockets[0];
                socket.emit('message', { data: previewFrame() });
                document.getElementById('confirm-input').type('ARCHIVE 8 REVISIONS');
                document.getElementById('btn-execute-archive').click();
                socket.sent.length = 0;
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_archive_started', requestId: 'x',
                        success: true, alreadyStarted: false, copyOnly: false,
                        job: { jobId: 'job-11111111111111111111',
                               jobType: 'archive_copy', status: 'queued' },
                    }),
                });
                const cancelButton = document.getElementById('btn-cancel-job');
                assert.equal(cancelButton.disabled, false);  // copy stage

                // Poll returns the committing stage: Cancel is withdrawn.
                timers[timers.length - 1].callback();
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_maintenance_job', requestId: 'x',
                        success: true,
                        job: { jobId: 'job-11111111111111111111',
                               jobType: 'archive_copy', status: 'running',
                               summary: { stage: 'committing' } },
                    }),
                });
                assert.equal(cancelButton.disabled, true);
                assert.match(
                    document.getElementById('job-status').textContent,
                    /cannot cancel/
                );
                // The consumed plan is gone: execute is disabled again.
                assert.equal(
                    document.getElementById('btn-execute-archive').disabled,
                    true
                );
            },
        },
        {
            name: 'a failed job renders guidance, never a zero-rows success',
            run() {
                const { document, sockets, timers } = connectAndStatus();
                const socket = sockets[0];
                socket.emit('message', { data: previewFrame() });
                document.getElementById('confirm-input').type('ARCHIVE 8 REVISIONS');
                document.getElementById('btn-execute-archive').click();
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_archive_started', requestId: 'x',
                        success: true, alreadyStarted: false,
                        job: { jobId: 'job-22222222222222222222',
                               jobType: 'archive_copy', status: 'queued' },
                    }),
                });
                timers[timers.length - 1].callback();
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_maintenance_job', requestId: 'x',
                        success: true,
                        job: { jobId: 'job-22222222222222222222',
                               jobType: 'archive_copy', status: 'failed',
                               errorCode: 'archive_plan_stale' },
                    }),
                });
                const jobLine = document.getElementById('job-status').textContent;
                assert.match(jobLine, /failed/);
                assert.equal(jobLine.includes('removed 0'), false);
                assert.match(
                    document.getElementById('guidance-line').textContent,
                    /[Pp]review/
                );
            },
        },
        {
            name: 'reconnect recovers the running job from admin status',
            run() {
                const { document, sockets, timers } = makeHarness();
                sockets[0].emit('open');
                sockets[0].emit('close');
                timers[timers.length - 1].callback();  // reconnect timer
                const second = sockets[1];
                second.emit('open');
                second.emit('message', {
                    data: statusFrame({
                        currentJob: {
                            jobId: 'job-33333333333333333333',
                            jobType: 'archive_copy', status: 'running',
                            summary: { stage: 'copying' },
                        },
                    }),
                });
                second.sent.length = 0;
                timers[timers.length - 1].callback();  // job poll timer
                const request = JSON.parse(second.sent[0]);
                assert.equal(request.action, 'get_workspace_maintenance_job');
                assert.equal(request.jobId, 'job-33333333333333333333');
                // The preview did not survive the reconnect.
                assert.equal(
                    document.getElementById('btn-execute-archive').disabled,
                    true
                );
            },
        },
        {
            name: 'tables render rows, empty states, and escaped content',
            run() {
                const { document, sockets } = connectAndStatus();
                const socket = sockets[0];
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'archived_workspaces_list', requestId: 'x',
                        success: true, page: 1, pageSize: 10, total: 1,
                        documents: [{
                            documentId: 'doc-x', kind: 'deleted_document',
                            title: '<script>alert(1)</script>', symbol: 'QQQ',
                            revisionCount: null, payloadBytes: null,
                            archiveId: 'portfolio-archive-2026-001',
                            archivedAtUtc: '2026-08-16T00:00:00.000Z',
                        }],
                    }),
                });
                const body = document.getElementById('archived-docs-body');
                assert.match(body.innerHTML, /&lt;script&gt;/);
                assert.equal(body.innerHTML.includes('<script>'), false);
                assert.match(
                    document.getElementById('docs-page-label').textContent,
                    /page 1 \/ 1/
                );

                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_maintenance_jobs_list', requestId: 'x',
                        success: true, page: 1, pageSize: 10, total: 0, jobs: [],
                    }),
                });
                assert.match(
                    document.getElementById('jobs-table-body').innerHTML,
                    /No tasks yet/
                );
            },
        },
        {
            name: 'restore buttons send the right mode, id, and revision',
            run() {
                const { document, sockets } = connectAndStatus();
                const socket = sockets[0];
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'archived_workspaces_list', requestId: 'x',
                        success: true, page: 1, pageSize: 10, total: 2,
                        documents: [
                            {
                                documentId: 'doc-whole-1111-4111-8111-111111111111',
                                kind: 'deleted_document', title: 'Old one',
                                symbol: 'QQQ', revisionCount: null,
                                payloadBytes: null, lastArchivedRevision: 2,
                                archiveId: 'portfolio-archive-2026-001',
                                archivedAtUtc: '2026-08-16T00:00:00.000Z',
                            },
                            {
                                documentId: 'doc-part-2222-4222-8222-222222222222',
                                kind: 'partial_history', title: 'Live one',
                                symbol: 'SPY', revisionCount: 6,
                                payloadBytes: 4096, lastArchivedRevision: 6,
                                archiveId: 'portfolio-archive-2026-001',
                                archivedAtUtc: '2026-08-16T00:00:00.000Z',
                            },
                        ],
                    }),
                });
                socket.sent.length = 0;

                document.getElementById('restore-doc-0').click();
                let request = JSON.parse(socket.sent.shift());
                assert.equal(request.action, 'restore_archived_workspace');
                assert.equal(request.mode, 'copy');
                assert.equal(request.documentId,
                    'doc-whole-1111-4111-8111-111111111111');

                // The rendered row pre-fills the revision input with the
                // last archived revision (mock DOM does not parse
                // innerHTML, so the pre-fill is asserted on the markup).
                assert.match(
                    document.getElementById('archived-docs-body').innerHTML,
                    /id="restore-rev-1"[^>]*value="6"/
                );
                const input = document.getElementById('restore-rev-1');
                input.value = '3';
                document.getElementById('restore-doc-1').click();
                request = JSON.parse(socket.sent.shift());
                assert.equal(request.mode, 'revision');
                assert.equal(request.revision, 3);
                assert.equal(request.documentId,
                    'doc-part-2222-4222-8222-222222222222');

                // A completed restore job renders its provenance.
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_archive_restore_started',
                        requestId: 'x', success: true,
                        job: { jobId: 'job-44444444444444444444',
                               jobType: 'archive_restore', status: 'queued' },
                    }),
                });
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_maintenance_job', requestId: 'x',
                        success: true,
                        job: {
                            jobId: 'job-44444444444444444444',
                            jobType: 'archive_restore', status: 'completed',
                            summary: {
                                mode: 'revision',
                                documentId: 'doc-part-2222-4222-8222-222222222222',
                                sourceRevision: 3, restoredRevision: 9,
                                sourceArchiveId: 'portfolio-archive-2026-001',
                            },
                        },
                    }),
                });
                assert.match(
                    document.getElementById('job-status').textContent,
                    /restored revision 3 .* as new revision 9/
                );
            },
        },
        {
            name: 'verify shard button runs a polled verification job',
            run() {
                const { document, sockets } = connectAndStatus();
                const socket = sockets[0];
                const verifyButton = document.getElementById('btn-verify-archive');
                assert.equal(verifyButton.disabled, true);  // no shard yet
                const select = document.getElementById('batch-archive-select');
                select.value = 'portfolio-archive-2026-001';
                (select.listeners.change || []).forEach((handler) =>
                    handler({ target: select }));
                // Selecting a shard re-renders the buttons: Verify enables
                // without waiting for any other event (regression: it once
                // stayed disabled until an unrelated render).
                assert.equal(verifyButton.disabled, false);
                socket.sent.length = 0;
                verifyButton.click();
                const requests = socket.sent.map((raw) => JSON.parse(raw));
                const verify = requests.find(
                    (r) => r.action === 'verify_workspace_archive');
                assert.ok(verify, 'verify request not sent');
                assert.equal(verify.archiveId, 'portfolio-archive-2026-001');

                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_archive_verify_started',
                        requestId: 'x', success: true,
                        job: { jobId: 'job-55555555555555555555',
                               jobType: 'archive_verify', status: 'queued' },
                    }),
                });
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_maintenance_job', requestId: 'x',
                        success: true,
                        job: {
                            jobId: 'job-55555555555555555555',
                            jobType: 'archive_verify', status: 'completed',
                            summary: {
                                archiveId: 'portfolio-archive-2026-001',
                                status: 'ok', verifiedRevisions: 8,
                                verifiedBytes: 70000, orphanFiles: [],
                            },
                        },
                    }),
                });
                assert.match(
                    document.getElementById('job-status').textContent,
                    /8 revisions verified/
                );
            },
        },
        {
            name: 'reclaim requests the bounded job and surfaces refusal',
            run() {
                const { document, sockets } = connectAndStatus();
                const socket = sockets[0];
                const reclaim = document.getElementById('btn-reclaim');
                assert.equal(reclaim.disabled, false);
                reclaim.click();
                assert.deepEqual(sentActions(socket),
                    ['request_workspace_space_reclaim']);
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_space_reclaim_started',
                        requestId: 'x', success: false,
                        code: 'unsafe_reclaim_refused',
                        message: 'below threshold',
                    }),
                });
                assert.match(
                    document.getElementById('guidance-line').textContent,
                    /below the reclaim threshold/
                );
            },
        },
        {
            name: 'every outbound action stays inside the admin allowlist',
            run() {
                const { context, document, sockets, timers } = connectAndStatus();
                const socket = sockets[0];
                socket.emit('message', { data: previewFrame() });
                document.getElementById('confirm-input').type('ARCHIVE 8 REVISIONS');
                document.getElementById('btn-execute-archive').click();
                document.getElementById('btn-refresh-stats').click();
                document.getElementById('btn-reclaim').click();
                timers.forEach(({ callback }) => callback());
                const allowed = new Set(
                    context.OptionComboWorkspaceDbAdminCore.ALLOWED_CLIENT_ACTIONS
                );
                for (const raw of socket.sent) {
                    const action = JSON.parse(raw).action;
                    assert.equal(allowed.has(action), true,
                        `unexpected outbound action ${action}`);
                }
            },
        },
    ],
};
