/**
 * DOM-free workspace persistence client.
 *
 * Owns request/response correlation for the persistence WebSocket protocol,
 * save-token idempotency across retries, the current-document envelope, the
 * canonical-payload fingerprint used for unsaved-changes detection, the
 * 5 MiB pre-send size check, and the same-browser advisory writer lease
 * (BroadcastChannel). It never touches the DOM and never talks to the
 * WebSocket directly — ws_client.js injects a sender and forwards store
 * responses into handleMessage().
 *
 * The lease is advisory coordination between this browser's tabs only; the
 * server's expected-revision check remains the real concurrency protection.
 */

(function attachWorkspacePersistence(globalScope) {
    const SERVER_ACTIONS = {
        request_workspace_store_status: 'workspace_store_status',
        list_saved_workspaces: 'saved_workspaces_list',
        load_saved_workspace: 'saved_workspace_loaded',
        save_saved_workspace: 'workspace_saved',
        delete_saved_workspace: 'workspace_deleted',
        list_workspace_revisions: 'workspace_revisions_list',
        restore_workspace_revision: 'workspace_revision_restored',
    };
    const SERVER_ACTION_SET = new Set(Object.values(SERVER_ACTIONS));

    const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
    const DEFAULT_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
    const WRITER_CHANNEL_NAME = 'option-combo-workspace-writer';
    const WRITER_HEARTBEAT_MS = 2000;
    const WRITER_TIMEOUT_MS = 6000;
    const WRITER_QUERY_GRACE_MS = 400;

    function _fallbackStableStringify(value) {
        if (value === undefined || value === null || typeof value !== 'object') {
            const encoded = JSON.stringify(value === undefined ? null : value);
            return encoded === undefined ? 'null' : encoded;
        }
        if (Array.isArray(value)) {
            return '[' + value.map(item => _fallbackStableStringify(item)).join(',') + ']';
        }
        const keys = Object.keys(value).sort();
        const parts = [];
        for (const key of keys) {
            if (value[key] === undefined) continue;
            parts.push(JSON.stringify(key) + ':' + _fallbackStableStringify(value[key]));
        }
        return '{' + parts.join(',') + '}';
    }

    function _defaultCanonicalize(payload) {
        const sessionLogic = globalScope.OptionComboSessionLogic;
        if (sessionLogic && typeof sessionLogic.stableStringify === 'function') {
            return sessionLogic.stableStringify(payload);
        }
        return _fallbackStableStringify(payload);
    }

    function _defaultByteLength(text) {
        if (typeof globalScope.TextEncoder === 'function') {
            return new globalScope.TextEncoder().encode(text).length;
        }
        // Fallback: count UTF-8 bytes without TextEncoder.
        let bytes = 0;
        for (let i = 0; i < text.length; i += 1) {
            const code = text.codePointAt(i);
            if (code > 0xffff) i += 1;
            bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        }
        return bytes;
    }

    function _defaultGenerateId() {
        const cryptoApi = globalScope.crypto;
        if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
            return cryptoApi.randomUUID();
        }
        let id = 'id-';
        for (let i = 0; i < 32; i += 1) {
            id += Math.floor(Math.random() * 16).toString(16);
        }
        return id;
    }

    function _makeError(code, message, response) {
        const error = new Error(message || code);
        error.code = code;
        if (response !== undefined) {
            error.response = response;
        }
        return error;
    }

    function createClient(options) {
        if (!options || typeof options.send !== 'function') {
            throw new Error('workspace persistence client requires a send function');
        }
        const send = options.send;
        const now = options.now || (() => Date.now());
        const setTimeoutFn = options.setTimeoutFn
            || ((fn, ms) => globalScope.setTimeout(fn, ms));
        const clearTimeoutFn = options.clearTimeoutFn
            || (id => globalScope.clearTimeout(id));
        const setIntervalFn = options.setIntervalFn
            || ((fn, ms) => globalScope.setInterval(fn, ms));
        const clearIntervalFn = options.clearIntervalFn
            || (id => globalScope.clearInterval(id));
        const generateId = options.generateId || _defaultGenerateId;
        const canonicalize = options.canonicalize || _defaultCanonicalize;
        const byteLength = options.byteLength || _defaultByteLength;
        const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
        const maxPayloadBytes = options.maxPayloadBytes || DEFAULT_MAX_PAYLOAD_BYTES;
        const heartbeatMs = options.writerHeartbeatMs || WRITER_HEARTBEAT_MS;
        const writerTimeoutMs = options.writerTimeoutMs || WRITER_TIMEOUT_MS;
        const queryGraceMs = options.writerQueryGraceMs || WRITER_QUERY_GRACE_MS;
        const channelFactory = options.channelFactory !== undefined
            ? options.channelFactory
            : () => (typeof globalScope.BroadcastChannel === 'function'
                ? new globalScope.BroadcastChannel(WRITER_CHANNEL_NAME)
                : null);

        const pending = new Map();
        const tabId = generateId();
        let storeAvailable = null; // null = unknown until probed
        let lastStatus = null;
        let envelope = null;
        let saveAttempt = null;
        let onStaleRevision = typeof options.onStaleRevision === 'function'
            ? options.onStaleRevision
            : null;

        // ---------------- request correlation ----------------

        function request(action, fields, requestOptions) {
            const requestId = generateId();
            const message = JSON.stringify({ action, requestId, ...(fields || {}) });
            return new Promise((resolve, reject) => {
                const entry = { action, resolve, reject, timer: null };
                entry.timer = setTimeoutFn(() => {
                    pending.delete(requestId);
                    reject(_makeError('timeout', `${action} timed out`));
                }, (requestOptions && requestOptions.timeoutMs) || requestTimeoutMs);
                pending.set(requestId, entry);
                let sent = false;
                try {
                    sent = send(message) !== false;
                } catch (error) {
                    sent = false;
                }
                if (!sent) {
                    clearTimeoutFn(entry.timer);
                    pending.delete(requestId);
                    reject(_makeError('disconnected', 'WebSocket is not connected'));
                }
            });
        }

        function handleMessage(data) {
            if (!data || typeof data !== 'object' || typeof data.action !== 'string') {
                return false;
            }
            if (!SERVER_ACTION_SET.has(data.action)) {
                return false;
            }
            const requestId = typeof data.requestId === 'string' ? data.requestId : '';
            const entry = pending.get(requestId);
            if (!entry) {
                // Late or unsolicited store reply: consumed, never forwarded
                // to market-data handlers.
                return true;
            }
            pending.delete(requestId);
            clearTimeoutFn(entry.timer);
            if (data.success === true) {
                entry.resolve(data);
            } else {
                entry.reject(_makeError(
                    data.code || 'internal_store_error', data.message, data
                ));
            }
            return true;
        }

        function handleSocketClosed() {
            const entries = Array.from(pending.values());
            pending.clear();
            for (const entry of entries) {
                clearTimeoutFn(entry.timer);
                entry.reject(_makeError('disconnected', 'WebSocket closed'));
            }
            storeAvailable = null;
        }

        function handleSocketOpen() {
            // Capability re-probe only. Never auto-replay a save: an unknown
            // save outcome stays parked until the user retries with the same
            // token.
            storeAvailable = null;
            return probeStatus().catch(() => {});
        }

        // ---------------- capability ----------------

        function probeStatus() {
            return request('request_workspace_store_status', {}).then((response) => {
                storeAvailable = response.available === true;
                lastStatus = response;
                return response;
            }).catch((error) => {
                storeAvailable = false;
                throw error;
            });
        }

        // ---------------- document envelope & fingerprint ----------------

        function fingerprintPayload(payload) {
            return canonicalize(payload);
        }

        function bindDocument(document, fingerprint) {
            envelope = {
                documentId: document.documentId,
                title: document.title,
                revision: document.revision,
                updatedAtUtc: document.updatedAtUtc || '',
                lastSavedPayloadFingerprint: fingerprint || '',
            };
            return getEnvelope();
        }

        function clearDocument() {
            envelope = null;
        }

        function getEnvelope() {
            return envelope ? { ...envelope } : null;
        }

        function isDirty(payload) {
            if (!envelope || !envelope.lastSavedPayloadFingerprint) {
                return true;
            }
            return fingerprintPayload(payload) !== envelope.lastSavedPayloadFingerprint;
        }

        // ---------------- store operations ----------------

        function listWorkspaces() {
            return request('list_saved_workspaces', {});
        }

        function loadWorkspace(documentId) {
            return request('load_saved_workspace', { documentId });
        }

        function listRevisions(documentId, listOptions) {
            const fields = { documentId };
            if (listOptions && Number.isInteger(listOptions.limit)) {
                fields.limit = listOptions.limit;
            }
            if (listOptions && Number.isInteger(listOptions.beforeRevision)) {
                fields.beforeRevision = listOptions.beforeRevision;
            }
            return request('list_workspace_revisions', fields);
        }

        function deleteWorkspace(documentId, expectedRevision) {
            return request('delete_saved_workspace', { documentId, expectedRevision });
        }

        function restoreRevision(documentId, revision, expectedRevision) {
            return request('restore_workspace_revision', {
                documentId,
                revision,
                expectedRevision,
                saveToken: generateId(),
            });
        }

        function saveWorkspace(params) {
            const documentId = params.documentId;
            const title = params.title;
            const payload = params.payload;
            const expectedRevision = params.expectedRevision;

            const canonical = fingerprintPayload(payload);
            const bytes = byteLength(canonical);
            if (bytes > maxPayloadBytes) {
                // Never hand the transport a message that would 1009-close a
                // socket that is also carrying live market data.
                return Promise.reject(_makeError(
                    'payload_too_large_local',
                    `workspace payload is ${bytes} bytes; the limit is ${maxPayloadBytes}`
                ));
            }

            // An unknown-outcome save retried with identical content reuses
            // its token so the server can replay instead of double-writing.
            // Different content always gets a fresh token.
            let saveToken;
            if (saveAttempt
                && saveAttempt.status === 'unknown'
                && saveAttempt.documentId === documentId
                && saveAttempt.fingerprint === canonical) {
                saveToken = saveAttempt.saveToken;
            } else {
                saveToken = generateId();
            }
            saveAttempt = {
                saveToken,
                documentId,
                fingerprint: canonical,
                status: 'in_flight',
            };

            const fields = { saveToken, documentId, title, payload };
            if (expectedRevision !== undefined && expectedRevision !== null) {
                fields.expectedRevision = expectedRevision;
            }
            return request('save_saved_workspace', fields).then((response) => {
                saveAttempt = null;
                bindDocument(response.document, canonical);
                _broadcast({
                    type: 'revision_saved',
                    documentId,
                    tabId,
                    revision: response.document.revision,
                });
                return response;
            }).catch((error) => {
                if (error && (error.code === 'timeout' || error.code === 'disconnected')) {
                    // Outcome unknown: keep the token for an identical retry.
                    if (saveAttempt && saveAttempt.saveToken === saveToken) {
                        saveAttempt.status = 'unknown';
                    }
                } else {
                    saveAttempt = null;
                }
                throw error;
            });
        }

        // ---------------- writer lease (same-browser advisory) ----------------

        let channel;
        try {
            channel = channelFactory ? channelFactory() : null;
        } catch (error) {
            channel = null;
        }
        let writerState = 'idle'; // idle|writer|readonly|stale|takeover-pending
        let writerDocumentId = null;
        let heartbeatTimer = null;
        let otherWriter = null; // { tabId, lastSeenAt, revision }
        let pendingAcquire = null; // { resolve, timer }

        if (channel) {
            channel.onmessage = (event) => {
                _handleWriterMessage(event && event.data);
            };
        }

        function _broadcast(message) {
            if (!channel) return;
            try {
                channel.postMessage(message);
            } catch (error) {
                // Coordination is advisory; revision conflicts still protect.
            }
        }

        function _startHeartbeat() {
            _stopHeartbeat();
            heartbeatTimer = setIntervalFn(() => {
                _broadcast(_heartbeatMessage());
            }, heartbeatMs);
        }

        function _stopHeartbeat() {
            if (heartbeatTimer !== null) {
                clearIntervalFn(heartbeatTimer);
                heartbeatTimer = null;
            }
        }

        function _heartbeatMessage() {
            return {
                type: 'writer_heartbeat',
                documentId: writerDocumentId,
                tabId,
                revision: envelope ? envelope.revision : null,
                at: now(),
            };
        }

        function _handleWriterMessage(message) {
            if (!message || typeof message !== 'object') return;
            if (message.tabId === tabId) return;
            if (!writerDocumentId || message.documentId !== writerDocumentId) return;

            if (message.type === 'writer_query') {
                if (writerState === 'writer') {
                    _broadcast(_heartbeatMessage());
                }
                return;
            }
            if (message.type === 'writer_heartbeat' || message.type === 'writer_claim') {
                otherWriter = {
                    tabId: message.tabId,
                    lastSeenAt: now(),
                    revision: message.revision !== undefined ? message.revision : null,
                };
                if (pendingAcquire) {
                    const acquire = pendingAcquire;
                    pendingAcquire = null;
                    clearTimeoutFn(acquire.timer);
                    writerState = 'readonly';
                    acquire.resolve('readonly');
                }
                return;
            }
            if (message.type === 'revision_saved') {
                otherWriter = {
                    tabId: message.tabId,
                    lastSeenAt: now(),
                    revision: message.revision,
                };
                const knownRevision = envelope ? envelope.revision : 0;
                if (writerState !== 'writer'
                    && Number.isInteger(message.revision)
                    && message.revision > knownRevision) {
                    writerState = 'stale';
                    if (onStaleRevision) {
                        onStaleRevision({
                            documentId: message.documentId,
                            revision: message.revision,
                        });
                    }
                }
                return;
            }
            if (message.type === 'writer_release') {
                if (otherWriter && otherWriter.tabId === message.tabId) {
                    otherWriter = null;
                }
            }
        }

        function acquireWriterLease(documentId) {
            releaseWriterLease();
            writerDocumentId = documentId;
            otherWriter = null;
            if (!channel) {
                // No BroadcastChannel: single-writer coordination is
                // unavailable, the server revision check is the protection.
                writerState = 'writer';
                return Promise.resolve('writer');
            }
            return new Promise((resolve) => {
                // Register the acquire BEFORE the query goes out: an existing
                // writer may answer synchronously (test bus) or fast, and its
                // heartbeat must find this pending acquire to resolve it.
                pendingAcquire = { resolve, timer: null };
                pendingAcquire.timer = setTimeoutFn(() => {
                    if (!pendingAcquire) return;
                    pendingAcquire = null;
                    writerState = 'writer';
                    _broadcast({
                        type: 'writer_claim',
                        documentId,
                        tabId,
                        revision: envelope ? envelope.revision : null,
                    });
                    _startHeartbeat();
                    resolve('writer');
                }, queryGraceMs);
                _broadcast({ type: 'writer_query', documentId, tabId });
            });
        }

        function releaseWriterLease() {
            if (writerState === 'writer' && writerDocumentId) {
                _broadcast({
                    type: 'writer_release',
                    documentId: writerDocumentId,
                    tabId,
                });
            }
            _stopHeartbeat();
            if (pendingAcquire) {
                clearTimeoutFn(pendingAcquire.timer);
                pendingAcquire = null;
            }
            writerState = 'idle';
            writerDocumentId = null;
            otherWriter = null;
        }

        function requestTakeover() {
            if (writerState === 'writer') {
                return { allowed: false, reason: 'already_writer' };
            }
            if (!writerDocumentId) {
                return { allowed: false, reason: 'no_document' };
            }
            if (otherWriter && (now() - otherWriter.lastSeenAt) < writerTimeoutMs) {
                return { allowed: false, reason: 'writer_active' };
            }
            // Takeover is only permitted through a fresh server load: the
            // caller must reload the latest revision, then completeTakeover().
            writerState = 'takeover-pending';
            return { allowed: true, mustReloadFirst: true };
        }

        function completeTakeover() {
            if (writerState !== 'takeover-pending') {
                return false;
            }
            writerState = 'writer';
            otherWriter = null;
            _broadcast({
                type: 'writer_claim',
                documentId: writerDocumentId,
                tabId,
                revision: envelope ? envelope.revision : null,
            });
            _startHeartbeat();
            return true;
        }

        function getWriterState() {
            return {
                state: writerState,
                documentId: writerDocumentId,
                tabId,
                otherWriter: otherWriter ? { ...otherWriter } : null,
            };
        }

        function setStaleRevisionHandler(handler) {
            onStaleRevision = typeof handler === 'function' ? handler : null;
        }

        return {
            // transport
            handleMessage,
            handleSocketOpen,
            handleSocketClosed,
            // capability
            probeStatus,
            isStoreAvailable: () => storeAvailable,
            getLastStatus: () => lastStatus,
            // envelope & dirty tracking
            fingerprintPayload,
            bindDocument,
            clearDocument,
            getEnvelope,
            isDirty,
            // operations
            listWorkspaces,
            loadWorkspace,
            listRevisions,
            deleteWorkspace,
            restoreRevision,
            saveWorkspace,
            // writer lease
            acquireWriterLease,
            releaseWriterLease,
            requestTakeover,
            completeTakeover,
            getWriterState,
            setStaleRevisionHandler,
            // introspection for tests
            _test: {
                pendingCount: () => pending.size,
                getSaveAttempt: () => (saveAttempt ? { ...saveAttempt } : null),
                tabId,
            },
        };
    }

    globalScope.OptionComboWorkspacePersistence = {
        createClient,
        SERVER_ACTIONS,
        DEFAULT_MAX_PAYLOAD_BYTES,
        WRITER_CHANNEL_NAME,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
