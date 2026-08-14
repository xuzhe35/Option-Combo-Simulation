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
        dataset: {},
        listeners: {},
        addEventListener(type, handler) {
            (this.listeners[type] = this.listeners[type] || []).push(handler);
        },
        click() {
            (this.listeners.click || []).forEach((handler) => handler());
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
        localStorage: { getItem: () => null, setItem: () => {} },
        setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimeout() {},
    });
    return { context, document, sockets, timers };
}

function sentActions(socket) {
    return socket.sent.map((raw) => JSON.parse(raw).action);
}

function statsFrame(overrides = {}) {
    return JSON.stringify({
        action: 'workspace_storage_stats',
        requestId: 'x',
        success: true,
        mode: 'fast',
        generatedAtUtc: '2026-08-15T12:00:00.000Z',
        documents: { active: 7, recentlyDeleted: 2 },
        revisions: { count: 42, receiptCount: 42, receiptBytesEstimate: 9000 },
        storage: {
            logicalPayloadBytes: 123456,
            allocatedDbBytes: 262144,
            reclaimableBytes: 8192,
            walBytes: 0,
            shmBytes: 0,
            dbFileBytes: 262144,
        },
        recent: {
            last7Days: { revisions: 5, payloadBytes: 1000 },
            last30Days: { revisions: 20, payloadBytes: 40000 },
        },
        archive: {
            archiveCount: 0, sealedCount: 0, missingCount: 0,
            fileBytes: 0, logicalPayloadBytes: 0, revisionCount: 0,
            lastVerifiedAtUtc: null,
        },
        candidates: {
            oldRevisions: { candidateCount: 3, candidateBytes: 777, documentCount: 1 },
            expiredDeletedDocuments: { documentCount: 1, revisionCount: 4, payloadBytes: 555 },
        },
        ...overrides,
    });
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
                // No trading-page scripts, ever.
                for (const forbidden of ['app.js', 'ws_client.js', 'order', 'valuation', 'pricing']) {
                    assert.equal(html.includes(`js/${forbidden}`), false,
                        `page must not reference ${forbidden}`);
                }
            },
        },
        {
            name: 'on open the page requests status and fast stats only',
            run() {
                const { sockets } = makeHarness();
                assert.equal(sockets.length, 1);
                sockets[0].emit('open');
                assert.deepEqual(sentActions(sockets[0]), [
                    'request_workspace_admin_status',
                    'request_workspace_storage_stats',
                ]);
                const request = JSON.parse(sockets[0].sent[1]);
                assert.equal(request.mode, 'fast');
            },
        },
        {
            name: 'stats render values and keep missing fields as unavailable',
            run() {
                const { document, sockets } = makeHarness();
                sockets[0].emit('open');
                sockets[0].emit('message', {
                    data: statsFrame({ storage: { logicalPayloadBytes: 123456 } }),
                });
                const value = (id) => document.getElementById(id).textContent;
                assert.equal(value('stat-active-documents'), '7');
                assert.equal(value('stat-logical-bytes'), '120.6 KiB');
                assert.equal(
                    document.getElementById('stat-logical-bytes').title,
                    '123,456 B'
                );
                // storage was partial: every other storage metric shows
                // unavailable, never a fabricated 0.
                assert.equal(value('stat-allocated-bytes'), 'unavailable');
                assert.equal(value('stat-wal-bytes'), 'unavailable');
                assert.equal(value('candidate-old-revisions'), '3');
            },
        },
        {
            name: 'store-unavailable status shows a warning state, not zeros',
            run() {
                const { document, sockets } = makeHarness();
                sockets[0].emit('open');
                sockets[0].emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_admin_status',
                        requestId: 'x',
                        success: true,
                        available: false,
                        reason: 'store_unavailable',
                    }),
                });
                const banner = document.getElementById('connection-banner');
                assert.equal(banner.dataset.state, 'unavailable');
                assert.equal(
                    document.getElementById('btn-refresh-stats').disabled, true
                );
                assert.equal(
                    document.getElementById('stat-active-documents').textContent,
                    'unavailable'
                );
            },
        },
        {
            name: 'disconnect flips the banner and schedules a reconnect',
            run() {
                const { document, sockets, timers } = makeHarness();
                sockets[0].emit('open');
                const timersBefore = timers.length;
                sockets[0].emit('close');
                const banner = document.getElementById('connection-banner');
                assert.equal(banner.dataset.state, 'disconnected');
                assert.equal(timers.length, timersBefore + 1);
                // Firing the reconnect timer opens a fresh socket.
                timers[timers.length - 1].callback();
                assert.equal(sockets.length, 2);
            },
        },
        {
            name: 'exact stats runs as a polled background job',
            run() {
                const { document, sockets, timers } = makeHarness();
                const socket = sockets[0];
                socket.emit('open');
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_admin_status', requestId: 'x',
                        success: true, available: true, schemaVersion: 2,
                        capability: { readOnly: true, statsFast: true, statsExact: true },
                        policy: {
                            revisionKeepRecent: 50, revisionKeepDailyDays: 90,
                            archiveDeletedAfterDays: 30, archiveAutoRun: false,
                        },
                        currentJob: null,
                    }),
                });
                socket.sent.length = 0;

                const exactButton = document.getElementById('btn-exact-stats');
                assert.equal(exactButton.disabled, false);
                exactButton.click();
                let request = JSON.parse(socket.sent[0]);
                assert.equal(request.action, 'request_workspace_storage_stats');
                assert.equal(request.mode, 'exact');

                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_storage_stats', requestId: 'x',
                        success: true, mode: 'exact',
                        job: { jobId: 'job-12345678901234567890', jobType: 'exact_stats', status: 'queued' },
                    }),
                });
                // Job is active: exact button disabled, poll timer armed.
                assert.equal(exactButton.disabled, true);
                socket.sent.length = 0;
                timers[timers.length - 1].callback();
                request = JSON.parse(socket.sent[0]);
                assert.equal(request.action, 'get_workspace_maintenance_job');
                assert.equal(request.jobId, 'job-12345678901234567890');

                socket.sent.length = 0;
                socket.emit('message', {
                    data: JSON.stringify({
                        action: 'workspace_maintenance_job', requestId: 'x',
                        success: true,
                        job: {
                            jobId: 'job-12345678901234567890',
                            jobType: 'exact_stats', status: 'completed',
                            summary: { payloadBytesMismatches: 0, revisionsMissingReceipts: 0 },
                        },
                    }),
                });
                // Terminal job refreshes the fast overview and re-enables.
                request = JSON.parse(socket.sent[0]);
                assert.equal(request.action, 'request_workspace_storage_stats');
                assert.equal(request.mode, 'fast');
                assert.equal(exactButton.disabled, false);
                assert.match(
                    document.getElementById('job-status').textContent,
                    /completed/
                );
            },
        },
        {
            name: 'every outbound action stays inside the admin allowlist',
            run() {
                const { context, document, sockets, timers } = makeHarness();
                const socket = sockets[0];
                socket.emit('open');
                socket.emit('message', { data: statsFrame() });
                document.getElementById('btn-refresh-stats').click();
                document.getElementById('btn-exact-stats').click();
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
