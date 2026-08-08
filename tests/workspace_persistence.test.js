const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function createFakeTimers() {
    let nextId = 1;
    const timers = new Map();
    return {
        set(fn, ms) {
            const id = nextId++;
            timers.set(id, { fn, ms, interval: false });
            return id;
        },
        setInterval(fn, ms) {
            const id = nextId++;
            timers.set(id, { fn, ms, interval: true });
            return id;
        },
        clear(id) {
            timers.delete(id);
        },
        fireAll() {
            for (const [id, timer] of Array.from(timers.entries())) {
                if (!timer.interval) {
                    timers.delete(id);
                }
                timer.fn();
            }
        },
        count() {
            return timers.size;
        },
    };
}

function createChannelBus() {
    const channels = [];
    return {
        create() {
            const channel = {
                onmessage: null,
                postMessage(message) {
                    for (const other of channels) {
                        if (other !== channel && typeof other.onmessage === 'function') {
                            other.onmessage({ data: message });
                        }
                    }
                },
                close() {},
            };
            channels.push(channel);
            return channel;
        },
    };
}

// Shared across harnesses: two fake tabs must never collide on tab IDs the
// way separate per-harness counters would (real clients use crypto UUIDs).
let idCounter = 0;

function createHarness(overrides = {}) {
    const ctx = loadBrowserScripts(['js/workspace_persistence.js']);
    const timers = createFakeTimers();
    const sent = [];
    const clock = { t: 1_000_000 };
    const client = ctx.OptionComboWorkspacePersistence.createClient({
        send: (message) => {
            sent.push(JSON.parse(message));
            return true;
        },
        setTimeoutFn: (fn, ms) => timers.set(fn, ms),
        clearTimeoutFn: id => timers.clear(id),
        setIntervalFn: (fn, ms) => timers.setInterval(fn, ms),
        clearIntervalFn: id => timers.clear(id),
        generateId: () => `gen-${++idCounter}`,
        now: () => clock.t,
        channelFactory: null,
        ...overrides,
    });
    return { ctx, client, timers, sent, clock };
}

function workspacePayload(baseDate = '2026-08-03') {
    return {
        sessionSchemaVersion: 1,
        underlyingSymbol: 'SPY',
        marketDataMode: 'live',
        baseDate,
        groups: [],
        hedges: [],
    };
}

async function rejection(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected promise to reject');
}

module.exports = {
    name: 'workspace_persistence.js',
    tests: [
        {
            name: 'correlates concurrent requests and resolves them out of order',
            async run() {
                const { client, sent } = createHarness();
                const first = client.listWorkspaces();
                const second = client.loadWorkspace('doc-aaaaaaaa-1111-4111-8111-111111111111');
                assert.equal(sent.length, 2);

                // Answer the second request first.
                assert.equal(client.handleMessage({
                    action: 'saved_workspace_loaded',
                    requestId: sent[1].requestId,
                    success: true,
                    document: { documentId: sent[1].documentId, revision: 3 },
                    payload: workspacePayload(),
                }), true);
                assert.equal(client.handleMessage({
                    action: 'saved_workspaces_list',
                    requestId: sent[0].requestId,
                    success: true,
                    documents: [],
                }), true);

                const loaded = await second;
                assert.equal(loaded.document.revision, 3);
                const listed = await first;
                assert.deepEqual(listed.documents, []);
                assert.equal(client._test.pendingCount(), 0);
            },
        },
        {
            name: 'rejects a request when its timeout fires',
            async run() {
                const { client, timers } = createHarness();
                const promise = client.listWorkspaces();
                timers.fireAll();
                const error = await rejection(promise);
                assert.equal(error.code, 'timeout');
                assert.equal(client._test.pendingCount(), 0);
            },
        },
        {
            name: 'socket close rejects pending work and parks the save attempt',
            async run() {
                const { client, sent } = createHarness();
                const savePromise = client.saveWorkspace({
                    documentId: 'doc-aaaaaaaa-1111-4111-8111-111111111111',
                    title: 'SPY workspace',
                    payload: workspacePayload(),
                });
                assert.equal(sent.length, 1);
                client.handleSocketClosed();
                const error = await rejection(savePromise);
                assert.equal(error.code, 'disconnected');
                const attempt = client._test.getSaveAttempt();
                assert.equal(attempt.status, 'unknown');
                assert.equal(attempt.saveToken, sent[0].saveToken);
            },
        },
        {
            name: 'an identical retry after an unknown outcome reuses the save token',
            async run() {
                const { client, sent } = createHarness();
                const documentId = 'doc-aaaaaaaa-1111-4111-8111-111111111111';
                const payload = workspacePayload();

                const firstAttempt = client.saveWorkspace({
                    documentId, title: 'SPY workspace', payload,
                });
                client.handleSocketClosed();
                await rejection(firstAttempt);

                const retry = client.saveWorkspace({
                    documentId, title: 'SPY workspace', payload,
                });
                assert.equal(sent.length, 2);
                assert.equal(sent[1].saveToken, sent[0].saveToken);
                client.handleMessage({
                    action: 'workspace_saved',
                    requestId: sent[1].requestId,
                    success: true,
                    document: {
                        documentId, title: 'SPY workspace', symbol: 'SPY',
                        marketDataMode: 'live', revision: 1,
                        updatedAtUtc: '2026-08-08T12:00:00.000Z',
                    },
                    idempotentReplay: true,
                });
                await retry;
                assert.equal(client._test.getSaveAttempt(), null);
                assert.equal(client.getEnvelope().revision, 1);

                // Different content must never ride on the old token.
                const changed = client.saveWorkspace({
                    documentId, title: 'SPY workspace',
                    payload: workspacePayload('2026-08-04'),
                    expectedRevision: 1,
                });
                assert.equal(sent.length, 3);
                assert.notEqual(sent[2].saveToken, sent[0].saveToken);
                client.handleMessage({
                    action: 'workspace_saved',
                    requestId: sent[2].requestId,
                    success: true,
                    document: { documentId, revision: 2, title: 'SPY workspace' },
                });
                await changed;
            },
        },
        {
            name: 'a definitive error clears the attempt and never binds the envelope',
            async run() {
                const { client, sent } = createHarness();
                const documentId = 'doc-aaaaaaaa-1111-4111-8111-111111111111';
                const promise = client.saveWorkspace({
                    documentId, title: 'SPY workspace',
                    payload: workspacePayload(), expectedRevision: 1,
                });
                client.handleMessage({
                    action: 'workspace_saved',
                    requestId: sent[0].requestId,
                    success: false,
                    code: 'revision_conflict',
                    message: 'document is at revision 5',
                    currentRevision: 5,
                });
                const error = await rejection(promise);
                assert.equal(error.code, 'revision_conflict');
                assert.equal(error.response.currentRevision, 5);
                assert.equal(client.getEnvelope(), null);
                assert.equal(client._test.getSaveAttempt(), null);
            },
        },
        {
            name: 'oversized payloads are rejected locally without touching the socket',
            async run() {
                const { client, sent } = createHarness({ maxPayloadBytes: 64 });
                const error = await rejection(client.saveWorkspace({
                    documentId: 'doc-aaaaaaaa-1111-4111-8111-111111111111',
                    title: 'big',
                    payload: workspacePayload('x'.repeat(256)),
                }));
                assert.equal(error.code, 'payload_too_large_local');
                assert.equal(sent.length, 0);
            },
        },
        {
            name: 'reconnect re-probes capability and never replays a save',
            async run() {
                const { client, sent } = createHarness();
                client.saveWorkspace({
                    documentId: 'doc-aaaaaaaa-1111-4111-8111-111111111111',
                    title: 'SPY workspace',
                    payload: workspacePayload(),
                }).catch(() => {});
                client.handleSocketClosed();
                sent.length = 0;

                const probe = client.handleSocketOpen();
                assert.equal(sent.length, 1);
                assert.equal(sent[0].action, 'request_workspace_store_status');
                client.handleMessage({
                    action: 'workspace_store_status',
                    requestId: sent[0].requestId,
                    success: true,
                    available: true,
                    maxPayloadBytes: 5242880,
                });
                await probe;
                assert.equal(client.isStoreAvailable(), true);
                // Still exactly one message: no save was replayed.
                assert.equal(sent.length, 1);
            },
        },
        {
            name: 'consumes only persistence actions and tolerates late replies',
            run() {
                const { client } = createHarness();
                assert.equal(client.handleMessage({ action: 'market_data' }), false);
                assert.equal(client.handleMessage({ action: 'combo_order_preview_result' }), false);
                assert.equal(client.handleMessage(null), false);
                // A late store reply is consumed so it never reaches the
                // market-data pipeline, even with no pending request.
                assert.equal(client.handleMessage({
                    action: 'workspace_saved',
                    requestId: 'req-long-gone',
                    success: true,
                }), true);
            },
        },
        {
            name: 'successful save binds the envelope and settles the fingerprint',
            async run() {
                const { client, sent } = createHarness();
                const documentId = 'doc-aaaaaaaa-1111-4111-8111-111111111111';
                const payload = workspacePayload();
                // Unbound with a differing baseline: protected as dirty.
                client.setUnboundBaseline(workspacePayload('1999-01-01'));
                assert.equal(client.isDirty(payload), true);

                const promise = client.saveWorkspace({
                    documentId, title: 'SPY workspace', payload,
                });
                client.handleMessage({
                    action: 'workspace_saved',
                    requestId: sent[0].requestId,
                    success: true,
                    document: {
                        documentId, title: 'SPY workspace', symbol: 'SPY',
                        marketDataMode: 'live', revision: 1,
                        updatedAtUtc: '2026-08-08T12:00:00.000Z',
                    },
                });
                await promise;
                const envelope = client.getEnvelope();
                assert.equal(envelope.documentId, documentId);
                assert.equal(envelope.revision, 1);
                assert.equal(client.isDirty(payload), false);
                assert.equal(client.isDirty(workspacePayload('2026-08-09')), true);
                // Key order must not affect the fingerprint.
                const reordered = {};
                for (const key of Object.keys(payload).sort().reverse()) {
                    reordered[key] = payload[key];
                }
                assert.equal(client.isDirty(reordered), false);
            },
        },
        {
            name: 'unbound workspaces are guarded by the baseline fingerprint',
            run() {
                const { client } = createHarness();
                const pristine = workspacePayload();

                // Before bootstrap seeds a baseline: never nag.
                assert.equal(client.isDirty(pristine), false);

                // Pristine baseline: untouched stays clean, edits turn dirty.
                client.setUnboundBaseline(pristine);
                assert.equal(client.isDirty(workspacePayload()), false);
                assert.equal(client.isDirty(workspacePayload('2026-08-09')), true);

                // Deleting the bound home marks the draft explicitly dirty.
                client.markUnboundDirty();
                assert.equal(client.isDirty(workspacePayload()), true);

                // Binding a document supersedes the unbound baseline.
                client.bindDocument(
                    { documentId: 'doc-aaaaaaaa-1111-4111-8111-111111111111',
                      title: 'T', revision: 1, updatedAtUtc: '' },
                    client.fingerprintPayload(pristine)
                );
                assert.equal(client.isDirty(pristine), false);
            },
        },
        {
            name: 'an identical duplicate save rides the in-flight promise',
            async run() {
                const { client, sent } = createHarness();
                const documentId = 'doc-aaaaaaaa-1111-4111-8111-111111111111';
                const payload = workspacePayload();

                const first = client.saveWorkspace({
                    documentId, title: 'SPY workspace', payload,
                });
                const duplicate = client.saveWorkspace({
                    documentId, title: 'SPY workspace', payload,
                });
                assert.equal(first, duplicate);
                assert.equal(sent.length, 1);

                client.handleMessage({
                    action: 'workspace_saved',
                    requestId: sent[0].requestId,
                    success: true,
                    document: { documentId, title: 'SPY workspace', revision: 1 },
                });
                const [a, b] = await Promise.all([first, duplicate]);
                assert.equal(a.document.revision, 1);
                assert.equal(b.document.revision, 1);
                assert.equal(client._test.hasInFlightSave(), false);
            },
        },
        {
            name: 'a different save while one is in flight is refused, not interleaved',
            async run() {
                const { client, sent } = createHarness();
                const documentId = 'doc-aaaaaaaa-1111-4111-8111-111111111111';

                const first = client.saveWorkspace({
                    documentId, title: 'SPY workspace', payload: workspacePayload(),
                });
                const refused = await rejection(client.saveWorkspace({
                    documentId, title: 'SPY workspace',
                    payload: workspacePayload('2026-08-09'),
                }));
                assert.equal(refused.code, 'save_in_progress');
                assert.equal(sent.length, 1);
                // The refused call never touched the first attempt's token.
                assert.equal(
                    client._test.getSaveAttempt().saveToken, sent[0].saveToken
                );

                client.handleMessage({
                    action: 'workspace_saved',
                    requestId: sent[0].requestId,
                    success: true,
                    document: { documentId, title: 'SPY workspace', revision: 1 },
                });
                await first;
                // After settling, a new save proceeds normally.
                const next = client.saveWorkspace({
                    documentId, title: 'SPY workspace',
                    payload: workspacePayload('2026-08-09'),
                    expectedRevision: 1,
                });
                assert.equal(sent.length, 2);
                client.handleMessage({
                    action: 'workspace_saved',
                    requestId: sent[1].requestId,
                    success: true,
                    document: { documentId, title: 'SPY workspace', revision: 2 },
                });
                await next;
            },
        },
        {
            name: 'second tab becomes read-only and learns about newer revisions',
            async run() {
                const bus = createChannelBus();
                const a = createHarness({ channelFactory: () => bus.create() });
                const b = createHarness({ channelFactory: () => bus.create() });
                const documentId = 'doc-aaaaaaaa-1111-4111-8111-111111111111';

                const aLease = a.client.acquireWriterLease(documentId);
                a.timers.fireAll(); // grace expires with no competing writer
                assert.equal(await aLease, 'writer');
                assert.equal(a.client.getWriterState().state, 'writer');

                // A answers B's query synchronously, before B's grace timer.
                const bLease = b.client.acquireWriterLease(documentId);
                assert.equal(await bLease, 'readonly');
                assert.equal(b.client.getWriterState().state, 'readonly');

                const staleEvents = [];
                b.client.setStaleRevisionHandler(event => staleEvents.push(event));

                const savePromise = a.client.saveWorkspace({
                    documentId, title: 'SPY workspace', payload: workspacePayload(),
                });
                a.client.handleMessage({
                    action: 'workspace_saved',
                    requestId: a.sent[a.sent.length - 1].requestId,
                    success: true,
                    document: {
                        documentId, title: 'SPY workspace', revision: 2,
                        updatedAtUtc: '2026-08-08T12:00:00.000Z',
                    },
                });
                await savePromise;
                assert.equal(staleEvents.length, 1);
                assert.equal(staleEvents[0].revision, 2);
                assert.equal(b.client.getWriterState().state, 'stale');
            },
        },
        {
            name: 'takeover waits for heartbeat expiry and forces a reload first',
            async run() {
                const bus = createChannelBus();
                const a = createHarness({ channelFactory: () => bus.create() });
                const b = createHarness({ channelFactory: () => bus.create() });
                const documentId = 'doc-aaaaaaaa-1111-4111-8111-111111111111';

                const aLease = a.client.acquireWriterLease(documentId);
                a.timers.fireAll();
                await aLease;
                const bLease = b.client.acquireWriterLease(documentId);
                assert.equal(await bLease, 'readonly');

                // Writer still fresh: takeover denied.
                const denied = b.client.requestTakeover();
                assert.equal(denied.allowed, false);
                assert.equal(denied.reason, 'writer_active');

                // Writer tab dies silently; its heartbeat ages out.
                b.clock.t += 60_000;
                const granted = b.client.requestTakeover();
                assert.equal(granted.allowed, true);
                assert.equal(granted.mustReloadFirst, true);
                assert.equal(b.client.getWriterState().state, 'takeover-pending');
                assert.equal(b.client.completeTakeover(), true);
                assert.equal(b.client.getWriterState().state, 'writer');
            },
        },
        {
            name: 'missing BroadcastChannel support degrades to solo writer',
            async run() {
                const { client } = createHarness({ channelFactory: null });
                const lease = await client.acquireWriterLease(
                    'doc-aaaaaaaa-1111-4111-8111-111111111111'
                );
                assert.equal(lease, 'writer');
                assert.equal(client.getWriterState().state, 'writer');
            },
        },
        {
            name: 'uses the session-logic canonicalizer when both scripts are loaded',
            run() {
                const ctx = loadBrowserScripts([
                    'js/session_logic.js',
                    'js/workspace_persistence.js',
                ]);
                const sent = [];
                const client = ctx.OptionComboWorkspacePersistence.createClient({
                    send: message => { sent.push(message); return true; },
                    channelFactory: null,
                });
                const payload = { b: 2, a: 1 };
                assert.equal(
                    client.fingerprintPayload(payload),
                    ctx.OptionComboSessionLogic.stableStringify(payload)
                );
            },
        },
    ],
};
