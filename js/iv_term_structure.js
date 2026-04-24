(function ivTermStructurePage(globalScope) {
    const CONFIG_PATH = 'iv_term_structure/iv_term_structure_config.json';
    const EMBEDDED_DEFAULT_CONFIG = Object.freeze({
        title: 'IV Term Structure',
        maxDte: 200,
        strikeRadius: 1,
        bucketDefinitions: [
            { label: '1D', targetDays: 1 },
            { label: '3D', targetDays: 3 },
            { label: '1W', targetDays: 7 },
            { label: '3W', targetDays: 21 },
            { label: '1M', targetDays: 30 },
            { label: '3M', targetDays: 90 },
            { label: '6M', targetDays: 180 },
        ],
        symbols: [
            { symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' },
            { symbol: 'QQQ', historyPath: 'iv_term_structure/data/QQQ.json' },
            { symbol: 'GLD', historyPath: 'iv_term_structure/data/GLD.json' },
            { symbol: 'SLV', historyPath: 'iv_term_structure/data/SLV.json' },
            { symbol: 'USO', historyPath: 'iv_term_structure/data/USO.json' },
        ],
    });
    const DEFAULT_WS_HOST = '127.0.0.1';
    const DEFAULT_WS_PORT = 8765;
    const WS_HOST_STORAGE_KEY = 'optionComboWsHost';
    const WS_PORT_STORAGE_KEY = 'optionComboWsPort';
    const RENDER_INTERVAL_MS = 120;

    const runtime = {
        config: null,
        configSourceLabel: '',
        cardsBySymbol: new Map(),
        pendingFileSymbol: '',
        renderTimerId: null,
        controlWs: null,
        controlWsOpenPromise: null,
        ibStatusPollTimerId: null,
        ibStatus: {
            connected: false,
            connecting: false,
            message: 'Not checked yet.',
        },
    };

    function core() {
        return globalScope.OptionComboIvTermStructureCore;
    }

    function productRegistry() {
        return globalScope.OptionComboProductRegistry;
    }

    function getWsHost() {
        try {
            const stored = String(localStorage.getItem(WS_HOST_STORAGE_KEY) || '').trim();
            return stored || DEFAULT_WS_HOST;
        } catch (_) {
            return DEFAULT_WS_HOST;
        }
    }

    function getWsPort() {
        try {
            const parsed = parseInt(localStorage.getItem(WS_PORT_STORAGE_KEY), 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WS_PORT;
        } catch (_) {
            return DEFAULT_WS_PORT;
        }
    }

    function getWsUrl() {
        return `ws://${getWsHost()}:${getWsPort()}`;
    }

    function updateIbStatus(payload) {
        const data = payload && typeof payload === 'object' ? payload : {};
        runtime.ibStatus = {
            connected: data.connected === true,
            connecting: data.connecting === true,
            host: String(data.host || '').trim(),
            port: data.port,
            clientId: data.clientId,
            message: String(data.message || '').trim(),
        };
        scheduleIbStatusPollIfNeeded();
        render(true);
    }

    function formatIbStatus() {
        const status = runtime.ibStatus || {};
        if (status.connected) {
            return 'Connected';
        }
        if (status.connecting) {
            return status.message || 'Connecting...';
        }
        return status.message || 'Not connected';
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeHistoryDocument(rawDocument, symbol) {
        const raw = rawDocument && typeof rawDocument === 'object' ? rawDocument : {};
        const rawSamples = Array.isArray(raw.samples) ? raw.samples : [];
        return {
            symbol,
            version: 1,
            samples: rawSamples,
        };
    }

    function readOnlyHistoryDocument(card) {
        if (card.historyDocument) {
            return card.historyDocument;
        }
        if (card.bundledHistoryDocument) {
            return card.bundledHistoryDocument;
        }
        return normalizeHistoryDocument(null, card.symbol);
    }

    function resolveProfile(symbol) {
        const registry = productRegistry();
        if (registry && typeof registry.resolveUnderlyingProfile === 'function') {
            return registry.resolveUnderlyingProfile(symbol);
        }
        return {
            optionSecType: 'OPT',
            underlyingSecType: 'STK',
            optionSymbol: symbol,
            underlyingSymbol: symbol,
            optionExchange: 'SMART',
            underlyingExchange: 'SMART',
            currency: 'USD',
            optionMultiplier: 100,
            tradingClass: '',
        };
    }

    function normalizeConfig(rawConfig) {
        const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
        const symbols = Array.isArray(config.symbols) ? config.symbols : [];
        const bucketDefinitions = core() && typeof core().cloneBucketDefinitions === 'function'
            ? core().cloneBucketDefinitions(config.bucketDefinitions)
            : [];

        return {
            title: String(config.title || 'IV Term Structure'),
            maxDte: Math.max(1, parseInt(config.maxDte, 10) || 200),
            strikeRadius: Math.max(0, parseInt(config.strikeRadius, 10) || 1),
            bucketDefinitions,
            symbols: symbols.map((entry) => {
                const symbol = String(
                    typeof entry === 'string'
                        ? entry
                        : (entry && entry.symbol) || ''
                ).trim().toUpperCase();
                return {
                    symbol,
                    historyPath: String(
                        entry && typeof entry === 'object' && entry.historyPath
                            ? entry.historyPath
                            : `iv_term_structure/data/${symbol}.json`
                    ).trim(),
                };
            }).filter((entry) => entry.symbol),
        };
    }

    function createCardState(entry) {
        return {
            symbol: entry.symbol,
            historyPath: entry.historyPath,
            statusMessage: 'Ready. Use Sync/Update to subscribe this ETF only.',
            statusKind: '',
            ws: null,
            wsOpenPromise: null,
            syncInProgress: false,
            sampleInProgress: false,
            catalog: null,
            quotesBySubId: {},
            underlyingPrice: null,
            bundledHistoryDocument: null,
            historyDocument: null,
            currentFileHandle: null,
            pendingCatalog: null,
            lastSyncLabel: '',
            lastSampleLabel: '',
            closeNotice: '',
            catalogPatchCount: 0,
            catalogPatchTimeoutId: null,
        };
    }

    function getCard(symbol) {
        return runtime.cardsBySymbol.get(String(symbol || '').trim().toUpperCase()) || null;
    }

    function setCardStatus(card, message, kind) {
        card.statusMessage = String(message || '').trim();
        card.statusKind = kind || '';
    }

    function formatNumber(value, digits) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed.toFixed(digits) : '--';
    }

    function formatPercent(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(2)}%` : '--';
    }

    function formatTimestamp(value) {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return '--';
        }
        const parsed = new Date(normalized);
        if (Number.isNaN(parsed.getTime())) {
            return normalized;
        }
        return parsed.toLocaleString();
    }

    function updateUnderlyingPrice(card, rawValue) {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return false;
        }
        if (card.underlyingPrice === parsed) {
            return false;
        }
        card.underlyingPrice = parsed;
        return true;
    }

    function sortExpiryRows(rows) {
        return (Array.isArray(rows) ? rows : []).slice().sort((left, right) => (
            (parseInt(left && left.dte, 10) || 0) - (parseInt(right && right.dte, 10) || 0)
            || String(left && left.expiry || '').localeCompare(String(right && right.expiry || ''))
        ));
    }

    function mergeCatalogPatch(card, payload) {
        if (!card || !card.catalog || !payload || typeof payload !== 'object') {
            return false;
        }

        let changed = false;
        const patchRows = Array.isArray(payload.expiryRows) ? payload.expiryRows : [];
        if (patchRows.length) {
            const existingRows = Array.isArray(card.catalog.expiryRows) ? card.catalog.expiryRows.slice() : [];
            patchRows.forEach((patchRow) => {
                const expiry = String(patchRow && patchRow.expiry || '').trim();
                if (!expiry) {
                    return;
                }
                const index = existingRows.findIndex((row) => String(row && row.expiry || '').trim() === expiry);
                if (index >= 0) {
                    existingRows[index] = { ...existingRows[index], ...patchRow };
                } else {
                    existingRows.push({ ...patchRow });
                }
                changed = true;
            });
            card.catalog.expiryRows = sortExpiryRows(existingRows);
        }

        if (payload.optionDescriptors && typeof payload.optionDescriptors === 'object') {
            card.catalog.optionDescriptors = {
                ...(card.catalog.optionDescriptors && typeof card.catalog.optionDescriptors === 'object' ? card.catalog.optionDescriptors : {}),
                ...payload.optionDescriptors,
            };
            changed = true;
        }

        if (Number.isFinite(parseInt(payload.expectedOptionCount, 10))) {
            card.catalog.expectedOptionCount = parseInt(payload.expectedOptionCount, 10);
            changed = true;
        }
        if (Number.isFinite(parseInt(payload.subscribedOptionCount, 10))) {
            card.catalog.subscribedOptionCount = parseInt(payload.subscribedOptionCount, 10);
            changed = true;
        }
        if (typeof payload.subscriptionPending === 'boolean') {
            card.catalog.subscriptionPending = payload.subscriptionPending;
            changed = true;
        }

        return changed;
    }

    function clearCatalogPatchWatchdog(card) {
        if (card && card.catalogPatchTimeoutId != null) {
            clearTimeout(card.catalogPatchTimeoutId);
            card.catalogPatchTimeoutId = null;
        }
    }

    function armCatalogPatchWatchdog(card) {
        clearCatalogPatchWatchdog(card);
        if (!card || !card.catalog || !Array.isArray(card.catalog.expiryRows) || !card.catalog.expiryRows.length) {
            return;
        }

        card.catalogPatchTimeoutId = setTimeout(() => {
            card.catalogPatchTimeoutId = null;
            if (!card.catalog || card.catalogPatchCount > 0) {
                return;
            }
            setCardStatus(
                card,
                'No ATM window updates have arrived yet. Try Unsubscribe, then Sync/Update again if this stays unchanged.',
                'error'
            );
            render(true);
        }, 10000);
    }

    function captureCardViewState(container) {
        const snapshot = {};
        if (!container) {
            return snapshot;
        }

        container.querySelectorAll('.ivts-card[data-symbol]').forEach((cardNode) => {
            const symbol = String(cardNode.getAttribute('data-symbol') || '').trim().toUpperCase();
            if (!symbol) {
                return;
            }

            const bucketShell = cardNode.querySelector('.ivts-bucket-table-shell');
            const detailsNode = cardNode.querySelector('.ivts-details');
            const detailsShell = cardNode.querySelector('.ivts-details-table-shell');
            snapshot[symbol] = {
                bucketScrollLeft: bucketShell ? bucketShell.scrollLeft : 0,
                detailsOpen: !!(detailsNode && detailsNode.open),
                detailsScrollLeft: detailsShell ? detailsShell.scrollLeft : 0,
            };
        });

        return snapshot;
    }

    function restoreCardViewState(container, snapshot) {
        if (!container || !snapshot) {
            return;
        }

        container.querySelectorAll('.ivts-card[data-symbol]').forEach((cardNode) => {
            const symbol = String(cardNode.getAttribute('data-symbol') || '').trim().toUpperCase();
            const savedState = symbol ? snapshot[symbol] : null;
            if (!savedState) {
                return;
            }

            const detailsNode = cardNode.querySelector('.ivts-details');
            if (detailsNode) {
                detailsNode.open = !!savedState.detailsOpen;
            }

            const bucketShell = cardNode.querySelector('.ivts-bucket-table-shell');
            if (bucketShell && Number.isFinite(savedState.bucketScrollLeft)) {
                bucketShell.scrollLeft = savedState.bucketScrollLeft;
            }

            const detailsShell = cardNode.querySelector('.ivts-details-table-shell');
            if (detailsShell && Number.isFinite(savedState.detailsScrollLeft)) {
                detailsShell.scrollLeft = savedState.detailsScrollLeft;
            }
        });
    }

    function buildSubscribePayload(card) {
        const profile = resolveProfile(card.symbol);
        return {
            action: 'subscribe_iv_term_structure',
            underlying: {
                secType: profile.underlyingSecType || 'STK',
                symbol: profile.underlyingSymbol || card.symbol,
                exchange: profile.underlyingExchange || 'SMART',
                currency: profile.currency || 'USD',
            },
            optionTemplate: {
                secType: profile.optionSecType || 'OPT',
                symbol: profile.optionSymbol || card.symbol,
                underlyingSymbol: profile.underlyingSymbol || card.symbol,
                exchange: profile.optionExchange || 'SMART',
                underlyingExchange: profile.underlyingExchange || profile.optionExchange || 'SMART',
                currency: profile.currency || 'USD',
                multiplier: String(profile.optionMultiplier || 100),
                tradingClass: profile.tradingClass || '',
            },
            anchorDate: new Date().toISOString().slice(0, 10),
            maxDte: runtime.config.maxDte,
            strikeRadius: runtime.config.strikeRadius,
        };
    }

    function applyRuntimeConfig(rawConfig, sourceLabel) {
        runtime.config = normalizeConfig(rawConfig);
        runtime.configSourceLabel = String(sourceLabel || '').trim();
        runtime.cardsBySymbol.clear();
        runtime.config.symbols.forEach((entry) => {
            runtime.cardsBySymbol.set(entry.symbol, createCardState(entry));
        });
    }

    async function loadConfig() {
        try {
            const response = await fetch(CONFIG_PATH, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`Unable to load ${CONFIG_PATH} (${response.status}).`);
            }
            applyRuntimeConfig(await response.json(), 'config file');
            return;
        } catch (error) {
            applyRuntimeConfig(EMBEDDED_DEFAULT_CONFIG, 'embedded defaults');
            runtime.configSourceLabel = `embedded defaults (${error && error.message ? error.message : 'config fetch failed'})`;
        }
    }

    async function loadBundledHistory(card) {
        try {
            const response = await fetch(card.historyPath, { cache: 'no-store' });
            if (!response.ok) {
                card.bundledHistoryDocument = normalizeHistoryDocument(null, card.symbol);
                return;
            }
            const payload = await response.json();
            card.bundledHistoryDocument = normalizeHistoryDocument(payload, card.symbol);
        } catch (_) {
            card.bundledHistoryDocument = normalizeHistoryDocument(null, card.symbol);
        }
    }

    function attachSocketHandlers(card, ws) {
        ws.addEventListener('open', () => {
            if (card.ws !== ws) {
                return;
            }
            setCardStatus(card, 'Socket connected. Ready to sync live option data.', 'success');
            card.wsOpenPromise = Promise.resolve(ws);
            render();
        });

        ws.addEventListener('message', (event) => {
            if (card.ws !== ws) {
                return;
            }

            let payload = null;
            try {
                payload = JSON.parse(event.data);
            } catch (_) {
                return;
            }

            if (payload && payload.action === 'iv_term_structure_snapshot') {
                if (String(payload.symbol || '').trim().toUpperCase() !== card.symbol) {
                    return;
                }
                card.catalog = payload;
                card.quotesBySubId = {};
                card.catalogPatchCount = 0;
                armCatalogPatchWatchdog(card);
                updateUnderlyingPrice(card, payload && payload.underlyingPrice);
                card.lastSyncLabel = new Date().toISOString();
                setCardStatus(
                    card,
                    payload.warning
                        || (payload.subscriptionPending
                            ? ((parseInt(payload.expectedOptionCount, 10) || 0) > 0
                                ? `Resolved ${Array.isArray(payload.expiryRows) ? payload.expiryRows.length : 0} expiries. Starting ${parseInt(payload.expectedOptionCount, 10) || 0} option subscriptions...`
                                : `Resolved ${Array.isArray(payload.expiryRows) ? payload.expiryRows.length : 0} expiries. Resolving per-expiry ATM windows and starting option subscriptions...`)
                            : `Synced ${Array.isArray(payload.expiryRows) ? payload.expiryRows.length : 0} expiries and ${parseInt(payload.subscribedOptionCount, 10) || 0} option streams.`),
                    payload.warning ? '' : 'success'
                );
                if (card.pendingCatalog) {
                    const pending = card.pendingCatalog;
                    card.pendingCatalog = null;
                    clearTimeout(pending.timeoutId);
                    pending.resolve(payload);
                }
                render();
                return;
            }

            if (payload && payload.action === 'iv_term_structure_catalog_patch') {
                if (String(payload.symbol || '').trim().toUpperCase() !== card.symbol) {
                    return;
                }
                if (mergeCatalogPatch(card, payload)) {
                    card.catalogPatchCount += 1;
                    clearCatalogPatchWatchdog(card);
                    const resolvedCount = parseInt(payload.resolvedExpiryCount, 10) || 0;
                    const totalCount = parseInt(payload.totalExpiryCount, 10) || (card.catalog && Array.isArray(card.catalog.expiryRows) ? card.catalog.expiryRows.length : 0);
                    const expectedCount = parseInt(payload.expectedOptionCount, 10) || 0;
                    const subscribedCount = parseInt(payload.subscribedOptionCount, 10) || 0;
                    setCardStatus(
                        card,
                        `Resolved ${resolvedCount} of ${totalCount} expiries. Subscribed ${subscribedCount} of ${expectedCount} option streams...`,
                        'success'
                    );
                    render();
                }
                return;
            }

            if (payload && payload.action === 'iv_term_structure_sync_complete') {
                if (String(payload.symbol || '').trim().toUpperCase() !== card.symbol) {
                    return;
                }
                setCardStatus(
                    card,
                    `Subscribed ${parseInt(payload.subscribedOptionCount, 10) || 0} of ${parseInt(payload.expectedOptionCount, 10) || 0} option streams. Waiting for live IV updates...`,
                    'success'
                );
                render();
                return;
            }

            if (payload && payload.action === 'iv_term_structure_error') {
                if (String(payload.symbol || '').trim().toUpperCase() === card.symbol || !payload.symbol) {
                    setCardStatus(card, payload.message || 'IV term structure sync failed.', 'error');
                    if (card.pendingCatalog) {
                        const pending = card.pendingCatalog;
                        card.pendingCatalog = null;
                        clearTimeout(pending.timeoutId);
                        pending.reject(new Error(payload.message || 'IV term structure sync failed.'));
                    }
                    render();
                }
                return;
            }

            updateUnderlyingPrice(card, payload && payload.underlyingPrice);

            if (payload && payload.options && typeof payload.options === 'object') {
                Object.entries(payload.options).forEach(([subId, quote]) => {
                    card.quotesBySubId[subId] = quote;
                });
                render();
            }
        });

        ws.addEventListener('close', () => {
            if (card.ws !== ws) {
                return;
            }

            clearCatalogPatchWatchdog(card);
            card.ws = null;
            card.wsOpenPromise = null;
            if (card.pendingCatalog) {
                const pending = card.pendingCatalog;
                card.pendingCatalog = null;
                clearTimeout(pending.timeoutId);
                pending.reject(new Error('Socket closed before the sync completed.'));
            }
            const closeNotice = String(card.closeNotice || '').trim();
            setCardStatus(
                card,
                closeNotice || 'Socket disconnected. Use Sync/Update to reconnect this ETF.',
                ''
            );
            card.closeNotice = '';
            render(true);
        });

        ws.addEventListener('error', () => {
            if (card.ws !== ws) {
                return;
            }
            setCardStatus(card, 'Socket error while syncing live option data.', 'error');
            render();
        });
    }

    async function ensureSocket(card) {
        if (card.ws && card.ws.readyState === WebSocket.OPEN) {
            return card.ws;
        }
        if (card.ws && card.ws.readyState === WebSocket.CONNECTING && card.wsOpenPromise) {
            return card.wsOpenPromise;
        }

        const ws = new WebSocket(getWsUrl());
        card.ws = ws;
        card.wsOpenPromise = new Promise((resolve, reject) => {
            ws.addEventListener('open', () => resolve(ws), { once: true });
            ws.addEventListener('error', () => reject(new Error('Unable to connect websocket.')), { once: true });
        });
        attachSocketHandlers(card, ws);
        return card.wsOpenPromise;
    }

    function attachControlSocketHandlers(ws) {
        ws.addEventListener('open', () => {
            if (runtime.controlWs !== ws) {
                return;
            }
            runtime.controlWsOpenPromise = Promise.resolve(ws);
            ws.send(JSON.stringify({ action: 'request_ib_connection_status' }));
        });

        ws.addEventListener('message', (event) => {
            if (runtime.controlWs !== ws) {
                return;
            }
            let payload = null;
            try {
                payload = JSON.parse(event.data);
            } catch (_) {
                return;
            }
            if (payload && payload.action === 'ib_connection_status') {
                updateIbStatus(payload);
            }
        });

        ws.addEventListener('close', () => {
            if (runtime.controlWs !== ws) {
                return;
            }
            runtime.controlWs = null;
            runtime.controlWsOpenPromise = null;
            runtime.ibStatus = {
                connected: false,
                connecting: false,
                message: 'Control socket disconnected.',
            };
            render(true);
        });

        ws.addEventListener('error', () => {
            if (runtime.controlWs !== ws) {
                return;
            }
            runtime.ibStatus = {
                connected: false,
                connecting: false,
                message: 'Unable to reach ib_server websocket.',
            };
            render(true);
        });
    }

    async function ensureControlSocket() {
        if (runtime.controlWs && runtime.controlWs.readyState === WebSocket.OPEN) {
            return runtime.controlWs;
        }
        if (runtime.controlWs && runtime.controlWs.readyState === WebSocket.CONNECTING && runtime.controlWsOpenPromise) {
            return runtime.controlWsOpenPromise;
        }

        const ws = new WebSocket(getWsUrl());
        runtime.controlWs = ws;
        runtime.controlWsOpenPromise = new Promise((resolve, reject) => {
            ws.addEventListener('open', () => resolve(ws), { once: true });
            ws.addEventListener('error', () => reject(new Error('Unable to connect websocket.')), { once: true });
        });
        attachControlSocketHandlers(ws);
        return runtime.controlWsOpenPromise;
    }

    async function requestIbStatus() {
        try {
            const ws = await ensureControlSocket();
            ws.send(JSON.stringify({ action: 'request_ib_connection_status' }));
        } catch (error) {
            runtime.ibStatus = {
                connected: false,
                connecting: false,
                message: error.message || 'Unable to check IB status.',
            };
            render(true);
        }
    }

    function clearIbStatusPollTimer() {
        if (runtime.ibStatusPollTimerId != null) {
            clearTimeout(runtime.ibStatusPollTimerId);
            runtime.ibStatusPollTimerId = null;
        }
    }

    function scheduleIbStatusPollIfNeeded() {
        clearIbStatusPollTimer();
        if (!runtime.ibStatus || runtime.ibStatus.connecting !== true) {
            return;
        }
        runtime.ibStatusPollTimerId = setTimeout(() => {
            runtime.ibStatusPollTimerId = null;
            requestIbStatus();
        }, 1500);
    }

    async function connectIbFromPage() {
        runtime.ibStatus = {
            connected: false,
            connecting: true,
            message: 'Connecting to IB...',
        };
        render(true);
        try {
            const ws = await ensureControlSocket();
            ws.send(JSON.stringify({ action: 'connect_ib' }));
        } catch (error) {
            runtime.ibStatus = {
                connected: false,
                connecting: false,
                message: error.message || 'Unable to connect IB.',
            };
            render(true);
        }
    }

    async function waitForAtmQuotes(card, timeoutMs) {
        const deadline = Date.now() + Math.max(250, timeoutMs || 0);
        const expiryRows = Array.isArray(card.catalog && card.catalog.expiryRows)
            ? card.catalog.expiryRows
            : [];

        if (!expiryRows.length) {
            return;
        }

        await new Promise((resolve) => {
            function check() {
                const ready = expiryRows.every((entry) => {
                    const hasCall = !entry.atmCallSubId || !!card.quotesBySubId[entry.atmCallSubId];
                    const hasPut = !entry.atmPutSubId || !!card.quotesBySubId[entry.atmPutSubId];
                    return hasCall && hasPut;
                });
                if (ready || Date.now() >= deadline) {
                    resolve();
                    return;
                }
                setTimeout(check, 100);
            }

            check();
        });
    }

    async function syncCard(card, options = {}) {
        const ws = await ensureSocket(card);
        card.syncInProgress = true;
        card.closeNotice = '';
        card.catalog = null;
        card.quotesBySubId = {};
        card.catalogPatchCount = 0;
        clearCatalogPatchWatchdog(card);
        setCardStatus(card, 'Syncing underlying quote, option chain, and ATM windows...', '');
        render(true);

        try {
            const catalog = await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    card.pendingCatalog = null;
                    reject(new Error('Timed out while waiting for the IV term structure snapshot.'));
                }, 30000);
                card.pendingCatalog = { resolve, reject, timeoutId };
                ws.send(JSON.stringify(buildSubscribePayload(card)));
            });

            if (options.waitForQuotes) {
                await waitForAtmQuotes(card, options.quoteTimeoutMs || 2500);
            }

            return catalog;
        } finally {
            card.syncInProgress = false;
            render(true);
        }
    }

    function buildDetailRows(card) {
        const snapshot = card.catalog && Array.isArray(card.catalog.expiryRows)
            ? card.catalog.expiryRows
            : [];
        return core().buildExpiryDetailRows(snapshot, card.quotesBySubId);
    }

    function buildBucketRows(card) {
        return core().buildBucketRows(
            buildDetailRows(card),
            runtime.config.bucketDefinitions
        );
    }

    function hasUsableLiveSnapshot(card) {
        if (!card || !card.catalog || !Array.isArray(card.catalog.expiryRows) || !card.catalog.expiryRows.length) {
            return false;
        }
        return buildDetailRows(card).some((row) => row && row.hasCompletePair);
    }

    async function openHistoryFile(card) {
        try {
            if (globalScope.showOpenFilePicker) {
                const [fileHandle] = await globalScope.showOpenFilePicker({
                    types: [{
                        description: 'JSON Files',
                        accept: { 'application/json': ['.json'] },
                    }],
                    multiple: false,
                });
                const file = await fileHandle.getFile();
                const payload = JSON.parse(await file.text());
                const normalized = normalizeHistoryDocument(payload, card.symbol);
                if (payload && payload.symbol && String(payload.symbol).trim().toUpperCase() !== card.symbol) {
                    throw new Error(`Selected file belongs to ${payload.symbol}, not ${card.symbol}.`);
                }
                card.currentFileHandle = fileHandle;
                card.historyDocument = normalized;
                setCardStatus(card, `History file opened. ${normalized.samples.length} samples ready for append.`, 'success');
                render(true);
                return;
            }

            runtime.pendingFileSymbol = card.symbol;
            const fileInput = document.getElementById('ivtsHistoryFileInput');
            if (fileInput) {
                fileInput.click();
            }
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return;
            }
            setCardStatus(card, error.message || 'Unable to open the selected history file.', 'error');
            render(true);
        }
    }

    async function handleFallbackFileImport(event) {
        const file = event.target.files && event.target.files[0];
        const card = getCard(runtime.pendingFileSymbol);
        runtime.pendingFileSymbol = '';
        if (!file || !card) {
            return;
        }

        try {
            const payload = JSON.parse(await file.text());
            if (payload && payload.symbol && String(payload.symbol).trim().toUpperCase() !== card.symbol) {
                throw new Error(`Selected file belongs to ${payload.symbol}, not ${card.symbol}.`);
            }
            card.currentFileHandle = null;
            card.historyDocument = normalizeHistoryDocument(payload, card.symbol);
            setCardStatus(card, `History file imported. ${card.historyDocument.samples.length} samples loaded in memory.`, 'success');
        } catch (error) {
            setCardStatus(card, error.message || 'Unable to import the selected file.', 'error');
        } finally {
            event.target.value = '';
            render(true);
        }
    }

    async function writeHistoryDocument(card) {
        const payload = JSON.stringify(card.historyDocument, null, 2);

        if (card.currentFileHandle && typeof card.currentFileHandle.createWritable === 'function') {
            const writable = await card.currentFileHandle.createWritable();
            await writable.write(payload);
            await writable.close();
            return;
        }

        const dataBlob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${card.symbol}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
    }

    async function sampleCard(card) {
        const canWriteViaHandle = !!(card.currentFileHandle && typeof card.currentFileHandle.createWritable === 'function');
        const canWriteViaFallbackImport = !globalScope.showOpenFilePicker && !!card.historyDocument;

        if (!canWriteViaHandle && !canWriteViaFallbackImport && globalScope.showOpenFilePicker) {
            setCardStatus(card, 'Open the history file first, then sample into that same file.', 'error');
            render(true);
            return;
        }
        if (!canWriteViaHandle && !canWriteViaFallbackImport) {
            setCardStatus(card, 'Open or import the history file first so new samples have a clean append target.', 'error');
            render(true);
            return;
        }

        card.sampleInProgress = true;
        const shouldResyncBeforeSample = !hasUsableLiveSnapshot(card);
        setCardStatus(
            card,
            shouldResyncBeforeSample
                ? 'No usable live snapshot is cached yet. Syncing before sampling this ETF...'
                : 'Saving the current live snapshot into this ETF history file...',
            ''
        );
        render(true);

        try {
            if (shouldResyncBeforeSample) {
                await syncCard(card, { waitForQuotes: true, quoteTimeoutMs: 2500 });
            }
            const detailRows = buildDetailRows(card);
            const bucketRows = buildBucketRows(card);
            const sampleRecord = core().buildSampleRecord(
                card.symbol,
                card.underlyingPrice,
                bucketRows,
                detailRows,
                new Date().toISOString(),
                card.catalog && card.catalog.anchorDate
            );
            const historyDocument = normalizeHistoryDocument(readOnlyHistoryDocument(card), card.symbol);
            historyDocument.samples = historyDocument.samples.concat(sampleRecord);
            card.historyDocument = historyDocument;
            await writeHistoryDocument(card);
            card.lastSampleLabel = sampleRecord.sampledAt;
            setCardStatus(card, `Sample saved. ${historyDocument.samples.length} total samples in ${card.symbol}.json.`, 'success');
        } catch (error) {
            setCardStatus(card, error.message || 'Sampling failed.', 'error');
        } finally {
            card.sampleInProgress = false;
            render(true);
        }
    }

    function buildBucketTable(card) {
        const bucketRows = buildBucketRows(card);
        return `
            <div class="ivts-table-shell ivts-bucket-table-shell">
                <table class="ivts-table ivts-table-buckets">
                    <thead>
                        <tr>
                            <th>Bucket</th>
                            <th>Matched Expiry</th>
                            <th>DTE</th>
                            <th>ATM Strike</th>
                            <th>Call IV</th>
                            <th>Put IV</th>
                            <th>ATM IV</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${bucketRows.map((row) => `
                            <tr>
                                <td>${escapeHtml(row.label)}</td>
                                <td>${row.matchedExpiry ? escapeHtml(row.matchedExpiry) : '<span class="ivts-missing">--</span>'}</td>
                                <td>${row.matchedDte != null ? escapeHtml(row.matchedDte) : '<span class="ivts-missing">--</span>'}</td>
                                <td>${row.atmStrike != null ? escapeHtml(formatNumber(row.atmStrike, 2)) : '<span class="ivts-missing">--</span>'}</td>
                                <td>${row.callIv != null ? escapeHtml(formatPercent(row.callIv)) : '<span class="ivts-missing">--</span>'}</td>
                                <td>${row.putIv != null ? escapeHtml(formatPercent(row.putIv)) : '<span class="ivts-missing">--</span>'}</td>
                                <td>${row.atmIv != null ? escapeHtml(formatPercent(row.atmIv)) : '<span class="ivts-missing">--</span>'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function buildDetailTable(card) {
        const detailRows = buildDetailRows(card);
        return `
            <details class="ivts-details">
                <summary>Expiry Details (${detailRows.length})</summary>
                <div class="ivts-details-body">
                    <div class="ivts-table-shell ivts-details-table-shell">
                        <table class="ivts-table ivts-table-details">
                            <thead>
                                <tr>
                                    <th>Expiry</th>
                                    <th>DTE</th>
                                    <th>ATM Strike</th>
                                    <th>Call IV</th>
                                    <th>Put IV</th>
                                    <th>ATM IV</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${detailRows.map((row) => `
                                    <tr>
                                        <td>${escapeHtml(row.expiry)}</td>
                                        <td>${escapeHtml(row.dte)}</td>
                                        <td>${row.atmStrike != null ? escapeHtml(formatNumber(row.atmStrike, 2)) : '<span class="ivts-missing">--</span>'}</td>
                                        <td>${row.callIv != null ? escapeHtml(formatPercent(row.callIv)) : '<span class="ivts-missing">--</span>'}</td>
                                        <td>${row.putIv != null ? escapeHtml(formatPercent(row.putIv)) : '<span class="ivts-missing">--</span>'}</td>
                                        <td>${row.atmIv != null ? escapeHtml(formatPercent(row.atmIv)) : '<span class="ivts-missing">--</span>'}</td>
                                    </tr>
                                `).join('') || `
                                    <tr>
                                        <td colspan="6" class="ivts-missing">No expiry rows have been synced yet.</td>
                                    </tr>
                                `}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
        `;
    }

    function buildCardBodyMarkup(card) {
        const historyDocument = readOnlyHistoryDocument(card);
        return `
            <div class="ivts-status ${card.statusKind ? `is-${escapeHtml(card.statusKind)}` : ''}">
                ${escapeHtml(card.statusMessage)}
            </div>

            <div class="ivts-facts">
                <div class="ivts-fact">
                    <span class="ivts-fact-label">Underlying</span>
                    <span class="ivts-fact-value">${card.underlyingPrice != null ? `$${formatNumber(card.underlyingPrice, 2)}` : '--'}</span>
                </div>
                <div class="ivts-fact">
                    <span class="ivts-fact-label">History Samples</span>
                    <span class="ivts-fact-value">${historyDocument.samples.length}</span>
                </div>
                <div class="ivts-fact">
                    <span class="ivts-fact-label">Last Sync</span>
                    <span class="ivts-fact-value">${escapeHtml(formatTimestamp(card.lastSyncLabel))}</span>
                </div>
                <div class="ivts-fact">
                    <span class="ivts-fact-label">Last Sample</span>
                    <span class="ivts-fact-value">${escapeHtml(formatTimestamp(card.lastSampleLabel))}</span>
                </div>
            </div>

            ${buildBucketTable(card)}
            ${buildDetailTable(card)}
        `;
    }

    function buildCardMarkup(card) {
        const sampleDisabled = card.syncInProgress || card.sampleInProgress || (!card.currentFileHandle && (globalScope.showOpenFilePicker || !card.historyDocument));
        const unsubscribeDisabled = !card.ws || (card.ws.readyState !== WebSocket.OPEN && card.ws.readyState !== WebSocket.CONNECTING);
        return `
            <article class="ivts-card" data-symbol="${escapeHtml(card.symbol)}">
                <div class="ivts-card-header">
                    <div>
                        <h2>${escapeHtml(card.symbol)}</h2>
                        <div class="ivts-card-meta">
                            ${escapeHtml(card.historyPath)}
                        </div>
                    </div>
                    <div class="ivts-actions">
                        <button class="ivts-btn" data-action="open" data-symbol="${escapeHtml(card.symbol)}">Open History</button>
                        <button class="ivts-btn ivts-btn-muted" data-action="unsubscribe" data-symbol="${escapeHtml(card.symbol)}" ${unsubscribeDisabled ? 'disabled' : ''}>Unsubscribe</button>
                        <button class="ivts-btn ivts-btn-primary" data-action="sync" data-symbol="${escapeHtml(card.symbol)}" ${card.syncInProgress || card.sampleInProgress ? 'disabled' : ''}>Sync/Update</button>
                        <button class="ivts-btn ivts-btn-warm" data-action="sample" data-symbol="${escapeHtml(card.symbol)}" ${sampleDisabled ? 'disabled' : ''}>Sample</button>
                    </div>
                </div>
                <div class="ivts-card-body">
                    ${buildCardBodyMarkup(card)}
                </div>
            </article>
        `;
    }

    function updateCardElement(card, cardNode) {
        if (!cardNode) {
            return;
        }

        const sampleDisabled = card.syncInProgress || card.sampleInProgress || (!card.currentFileHandle && (globalScope.showOpenFilePicker || !card.historyDocument));
        const unsubscribeDisabled = !card.ws || (card.ws.readyState !== WebSocket.OPEN && card.ws.readyState !== WebSocket.CONNECTING);
        const openButton = cardNode.querySelector('[data-action="open"]');
        const syncButton = cardNode.querySelector('[data-action="sync"]');
        const sampleButton = cardNode.querySelector('[data-action="sample"]');
        const unsubscribeButton = cardNode.querySelector('[data-action="unsubscribe"]');

        if (openButton) {
            openButton.disabled = false;
        }
        if (syncButton) {
            syncButton.disabled = !!(card.syncInProgress || card.sampleInProgress);
        }
        if (sampleButton) {
            sampleButton.disabled = !!sampleDisabled;
        }
        if (unsubscribeButton) {
            unsubscribeButton.disabled = !!unsubscribeDisabled;
        }

        const bodyNode = cardNode.querySelector('.ivts-card-body');
        if (!bodyNode) {
            return;
        }

        const viewState = captureCardViewState(cardNode.parentElement || cardNode);
        bodyNode.innerHTML = buildCardBodyMarkup(card);
        restoreCardViewState(cardNode.parentElement || cardNode, viewState);
    }

    function ensureCardShells(container) {
        const expectedSymbols = runtime.config.symbols.map((entry) => entry.symbol);
        const currentSymbols = Array.from(container.querySelectorAll('.ivts-card[data-symbol]'))
            .map((node) => String(node.getAttribute('data-symbol') || '').trim().toUpperCase());

        const needsRebuild = expectedSymbols.length !== currentSymbols.length
            || expectedSymbols.some((symbol, index) => symbol !== currentSymbols[index]);

        if (!needsRebuild) {
            return;
        }

        container.innerHTML = runtime.config.symbols.map((entry) => buildCardMarkup(getCard(entry.symbol))).join('');
    }

    async function unsubscribeCard(card, options = {}) {
        const preserveView = options.preserveView !== false;
        const renderMode = preserveView ? render : render.bind(null, true);

        if (card.pendingCatalog) {
            const pending = card.pendingCatalog;
            card.pendingCatalog = null;
            clearTimeout(pending.timeoutId);
            pending.reject(new Error('Subscription was cancelled.'));
        }

        card.syncInProgress = false;
        card.sampleInProgress = false;
        card.closeNotice = options.notice || 'Subscription closed. Showing the last received snapshot.';

        if (card.ws) {
            try {
                card.ws.close(1000, 'unsubscribe');
            } catch (_) {
                card.ws = null;
                card.wsOpenPromise = null;
            }
        } else {
            setCardStatus(card, card.closeNotice, '');
            card.closeNotice = '';
        }

        renderMode();
    }

    function closeAllSocketsForPageExit() {
        clearIbStatusPollTimer();
        if (runtime.controlWs) {
            try {
                runtime.controlWs.close(1000, 'pagehide');
            } catch (_) {
                // Ignore best-effort shutdown failures during page exit.
            }
        }
        runtime.cardsBySymbol.forEach((card) => {
            if (!card || !card.ws) {
                return;
            }
            try {
                card.ws.close(1000, 'pagehide');
            } catch (_) {
                // Ignore best-effort shutdown failures during page exit.
            }
        });
    }

    function bindContainerInteractions() {
        const container = document.getElementById('ivtsCards');
        if (!container || container.dataset.bound === 'true') {
            return;
        }

        container.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-action][data-symbol]');
            if (!button) {
                return;
            }

            const card = getCard(button.getAttribute('data-symbol'));
            if (!card) {
                return;
            }

            const action = String(button.getAttribute('data-action') || '').trim();
            if (action === 'open') {
                openHistoryFile(card);
                return;
            }
            if (action === 'unsubscribe') {
                unsubscribeCard(card);
                return;
            }
            if (action === 'sync') {
                try {
                    await syncCard(card, { waitForQuotes: false });
                } catch (error) {
                    setCardStatus(card, error.message || 'Sync failed.', 'error');
                    render(true);
                }
                return;
            }
            if (action === 'sample') {
                sampleCard(card);
            }
        });

        container.dataset.bound = 'true';
    }

    function performRender() {
        const socketStatus = document.getElementById('ivtsSocketStatus');
        if (socketStatus) {
            socketStatus.textContent = getWsUrl();
        }

        const configStatus = document.getElementById('ivtsConfigStatus');
        if (configStatus) {
            configStatus.textContent = runtime.config
                ? `${runtime.config.symbols.length} ETF symbols loaded via ${runtime.configSourceLabel || 'config'}`
                : 'Unavailable';
        }

        const ibStatus = document.getElementById('ivtsIbStatus');
        if (ibStatus) {
            ibStatus.textContent = formatIbStatus();
        }
        const ibConnectButton = document.getElementById('ivtsIbConnectButton');
        if (ibConnectButton) {
            ibConnectButton.disabled = !!(runtime.ibStatus && (runtime.ibStatus.connected || runtime.ibStatus.connecting));
            ibConnectButton.textContent = runtime.ibStatus && runtime.ibStatus.connected
                ? 'IB Connected'
                : (runtime.ibStatus && runtime.ibStatus.connecting ? 'Connecting...' : 'Connect IB');
        }

        const container = document.getElementById('ivtsCards');
        if (!container || !runtime.config) {
            return;
        }
        ensureCardShells(container);
        runtime.config.symbols.forEach((entry) => {
            const card = getCard(entry.symbol);
            const cardNode = container.querySelector(`.ivts-card[data-symbol="${entry.symbol}"]`);
            updateCardElement(card, cardNode);
        });
        bindContainerInteractions();
    }

    function render(immediate = false) {
        if (immediate) {
            if (runtime.renderTimerId != null) {
                clearTimeout(runtime.renderTimerId);
                runtime.renderTimerId = null;
            }
            performRender();
            return;
        }

        if (runtime.renderTimerId != null) {
            return;
        }

        runtime.renderTimerId = setTimeout(() => {
            runtime.renderTimerId = null;
            performRender();
        }, RENDER_INTERVAL_MS);
    }

    async function init() {
        document.getElementById('ivtsSocketStatus').textContent = getWsUrl();
        try {
            await loadConfig();
            await Promise.all(runtime.config.symbols.map((entry) => loadBundledHistory(getCard(entry.symbol))));
            if (typeof document !== 'undefined' && runtime.config && runtime.config.title) {
                document.title = runtime.config.title;
            }
            const fileInput = document.getElementById('ivtsHistoryFileInput');
            if (fileInput) {
                fileInput.addEventListener('change', handleFallbackFileImport);
            }
            const ibConnectButton = document.getElementById('ivtsIbConnectButton');
            if (ibConnectButton) {
                ibConnectButton.addEventListener('click', () => {
                    connectIbFromPage();
                });
            }
            globalScope.addEventListener('pagehide', closeAllSocketsForPageExit, { capture: true });
            globalScope.addEventListener('beforeunload', closeAllSocketsForPageExit, { capture: true });
            render(true);
            requestIbStatus();
        } catch (error) {
            const configStatus = document.getElementById('ivtsConfigStatus');
            if (configStatus) {
                configStatus.textContent = error.message || 'Unable to load config';
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})(typeof window !== 'undefined' ? window : globalThis);
