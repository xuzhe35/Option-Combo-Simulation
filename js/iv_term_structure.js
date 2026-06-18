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
    const CALENDAR_TARGET_PRESETS = Object.freeze(['1.5', '2', '2.5', '3']);
    const DEFAULT_CALENDAR_FINDER_CONFIG = Object.freeze({
        targetRatio: 2,
        targetPreset: '2',
        tolerancePct: 25,
        shortMinDte: 3,
        shortMaxDte: 60,
        sortBy: 'best_value',
        showAll: false,
    });
    const CALENDAR_FINDER_TOP_LIMIT = 5;
    const CALENDAR_FINDER_STORAGE_KEY = 'optionComboIvtsCalendarFinder';
    const CARD_VIEW_STATE_SECTIONS = Object.freeze([
        {
            key: 'calendar',
            detailsSelector: '.ivts-calendar-finder',
            shellSelector: '.ivts-calendar-table-shell',
        },
        {
            key: 'bucket',
            detailsSelector: '.ivts-bucket-summary',
            shellSelector: '.ivts-bucket-table-shell',
        },
        {
            key: 'details',
            detailsSelector: '',
            shellSelector: '.ivts-details-table-shell',
        },
    ]);

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

    function normalizeWsPort(rawValue) {
        const parsed = parseInt(rawValue, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
            return DEFAULT_WS_PORT;
        }
        return parsed;
    }

    function normalizeWsHost(rawValue) {
        const trimmed = String(rawValue || '').trim();
        if (!trimmed) {
            return DEFAULT_WS_HOST;
        }

        let candidate = trimmed
            .replace(/^[a-z]+:\/\//i, '')
            .replace(/[/?#].*$/, '');

        if (candidate.startsWith('[')) {
            const bracketedMatch = candidate.match(/^\[[^\]]+\]/);
            if (bracketedMatch) {
                candidate = bracketedMatch[0];
            }
        } else if ((candidate.match(/:/g) || []).length === 1) {
            candidate = candidate.replace(/:\d+$/, '');
        }

        return candidate || DEFAULT_WS_HOST;
    }

    function getWsHost() {
        try {
            return normalizeWsHost(localStorage.getItem(WS_HOST_STORAGE_KEY));
        } catch (_) {
            return DEFAULT_WS_HOST;
        }
    }

    function getWsPort() {
        try {
            return normalizeWsPort(localStorage.getItem(WS_PORT_STORAGE_KEY));
        } catch (_) {
            return DEFAULT_WS_PORT;
        }
    }

    function setSavedWsHost(host) {
        const safeHost = normalizeWsHost(host);
        try {
            localStorage.setItem(WS_HOST_STORAGE_KEY, safeHost);
        } catch (_) {
            // Keep the runtime value even when storage is unavailable.
        }
        return safeHost;
    }

    function setSavedWsPort(port) {
        const safePort = normalizeWsPort(port);
        try {
            localStorage.setItem(WS_PORT_STORAGE_KEY, String(safePort));
        } catch (_) {
            // Keep the runtime value even when storage is unavailable.
        }
        return safePort;
    }

    function getWsUrl() {
        return `ws://${getWsHost()}:${getWsPort()}`;
    }

    function syncWsEndpointInputs() {
        const hostInput = document.getElementById('ivtsWsHostInput');
        const portInput = document.getElementById('ivtsWsPortInput');
        if (hostInput && document.activeElement !== hostInput) {
            hostInput.value = getWsHost();
        }
        if (portInput && document.activeElement !== portInput) {
            portInput.value = String(getWsPort());
        }
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
        return String(value == null ? '' : value)
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

    function normalizeCalendarFinderConfig(rawConfig) {
        const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
        const parsedTargetRatio = parseFloat(raw.targetRatio);
        const targetRatio = Number.isFinite(parsedTargetRatio) && parsedTargetRatio > 0
            ? Math.min(8, Math.max(1.05, parsedTargetRatio))
            : DEFAULT_CALENDAR_FINDER_CONFIG.targetRatio;
        const rawPreset = String(raw.targetPreset || '').trim();
        const targetPreset = rawPreset === 'custom' || CALENDAR_TARGET_PRESETS.includes(rawPreset)
            ? rawPreset
            : (CALENDAR_TARGET_PRESETS.includes(String(targetRatio)) ? String(targetRatio) : 'custom');
        const parsedTolerancePct = parseInt(raw.tolerancePct, 10);
        const tolerancePct = [15, 25, 40].includes(parsedTolerancePct)
            ? parsedTolerancePct
            : DEFAULT_CALENDAR_FINDER_CONFIG.tolerancePct;
        const parsedShortMinDte = parseInt(raw.shortMinDte, 10);
        const parsedShortMaxDte = parseInt(raw.shortMaxDte, 10);
        const shortMinDte = Number.isFinite(parsedShortMinDte) && parsedShortMinDte >= 0
            ? parsedShortMinDte
            : DEFAULT_CALENDAR_FINDER_CONFIG.shortMinDte;
        const shortMaxDte = Number.isFinite(parsedShortMaxDte) && parsedShortMaxDte >= shortMinDte
            ? parsedShortMaxDte
            : Math.max(DEFAULT_CALENDAR_FINDER_CONFIG.shortMaxDte, shortMinDte);
        const sortBy = ['best_value', 'cheapest_long', 'closest_ratio'].includes(raw.sortBy)
            ? raw.sortBy
            : DEFAULT_CALENDAR_FINDER_CONFIG.sortBy;

        return {
            targetRatio,
            targetPreset,
            tolerancePct,
            shortMinDte,
            shortMaxDte,
            sortBy,
            showAll: raw.showAll === true,
        };
    }

    function loadSavedCalendarFinderConfig(symbol) {
        const key = String(symbol || '').trim().toUpperCase();
        if (!key) {
            return null;
        }
        try {
            const parsed = JSON.parse(localStorage.getItem(CALENDAR_FINDER_STORAGE_KEY) || '{}');
            const entry = parsed && typeof parsed === 'object' ? parsed[key] : null;
            return entry && typeof entry === 'object' ? entry : null;
        } catch (_) {
            return null;
        }
    }

    function saveCalendarFinderConfig(symbol, config) {
        const key = String(symbol || '').trim().toUpperCase();
        if (!key) {
            return;
        }
        let store = {};
        try {
            const parsed = JSON.parse(localStorage.getItem(CALENDAR_FINDER_STORAGE_KEY) || '{}');
            if (parsed && typeof parsed === 'object') {
                store = parsed;
            }
        } catch (_) {
            // Start a fresh store when the saved blob is unreadable.
        }
        store[key] = normalizeCalendarFinderConfig(config);
        try {
            localStorage.setItem(CALENDAR_FINDER_STORAGE_KEY, JSON.stringify(store));
        } catch (_) {
            // Keep the runtime value even when storage is unavailable.
        }
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

    function resolveDefaultExpandedSymbol(symbols) {
        const entries = Array.isArray(symbols) ? symbols : [];
        const spyEntry = entries.find((entry) => String(entry && entry.symbol || '').trim().toUpperCase() === 'SPY');
        const fallbackEntry = entries.find((entry) => String(entry && entry.symbol || '').trim());
        return String((spyEntry || fallbackEntry || {}).symbol || '').trim().toUpperCase();
    }

    function createCardState(entry, options = {}) {
        return {
            symbol: entry.symbol,
            historyPath: entry.historyPath,
            isExpanded: options.isExpanded === true,
            statusMessage: 'Ready. Use Sync/Update to subscribe this ETF only.',
            statusKind: '',
            ws: null,
            wsOpenPromise: null,
            syncInProgress: false,
            sampleInProgress: false,
            catalog: null,
            quotesBySubId: {},
            underlyingPrice: null,
            forceBodyRefreshOnce: false,
            bundledHistoryDocument: null,
            historyDocument: null,
            currentFileHandle: null,
            pendingCatalog: null,
            lastSyncLabel: '',
            lastSampleLabel: '',
            closeNotice: '',
            straddleBaselineExpiry: '',
            calendarFinder: normalizeCalendarFinderConfig(
                loadSavedCalendarFinderConfig(entry.symbol) || DEFAULT_CALENDAR_FINDER_CONFIG
            ),
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

    function formatCompactPercent(value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return '--';
        }
        return `${(parsed * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
    }

    function formatIvPair(callIv, putIv) {
        return `${formatCompactPercent(callIv)}/${formatCompactPercent(putIv)}`;
    }

    function formatMoney(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : '--';
    }

    function formatMultiple(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? `${parsed.toFixed(2)}X` : '--';
    }

    function formatCompactMultiple(value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return '--';
        }
        return `${parsed.toFixed(2).replace(/\.?0+$/, '')}X`;
    }

    function normalizeExpiryKey(value) {
        const normalized = String(value || '').trim().replace(/-/g, '');
        return /^\d{8}$/.test(normalized) ? normalized : '';
    }

    function isBaselineSelectElement(element) {
        return !!(
            element
            && typeof element.matches === 'function'
            && element.matches('select[data-action="baseline"][data-symbol]')
        );
    }

    function isCalendarFinderControlElement(element) {
        return !!(
            element
            && typeof element.matches === 'function'
            && element.matches('[data-action^="calendar-"][data-symbol]')
        );
    }

    function isFocusedCardControlInCard(cardNode) {
        const activeElement = document && document.activeElement;
        return !!(
            cardNode
            && (isBaselineSelectElement(activeElement) || isCalendarFinderControlElement(activeElement))
            && typeof cardNode.contains === 'function'
            && cardNode.contains(activeElement)
        );
    }

    function isFocusedBaselineSelectInCard(cardNode) {
        const activeElement = document && document.activeElement;
        return !!(
            cardNode
            && isBaselineSelectElement(activeElement)
            && typeof cardNode.contains === 'function'
            && cardNode.contains(activeElement)
        );
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

            const sections = {};
            CARD_VIEW_STATE_SECTIONS.forEach((section) => {
                const detailsNode = section.detailsSelector
                    ? cardNode.querySelector(section.detailsSelector)
                    : null;
                const shellNode = section.shellSelector
                    ? cardNode.querySelector(section.shellSelector)
                    : null;
                sections[section.key] = {
                    open: detailsNode ? !!detailsNode.open : null,
                    scrollLeft: shellNode ? shellNode.scrollLeft : 0,
                    scrollTop: shellNode ? shellNode.scrollTop : 0,
                };
            });
            snapshot[symbol] = { sections };
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

            const sections = savedState.sections && typeof savedState.sections === 'object'
                ? savedState.sections
                : {};
            CARD_VIEW_STATE_SECTIONS.forEach((section) => {
                const sectionState = sections[section.key] || {};
                const detailsNode = section.detailsSelector
                    ? cardNode.querySelector(section.detailsSelector)
                    : null;
                if (detailsNode && typeof sectionState.open === 'boolean') {
                    detailsNode.open = sectionState.open;
                }

                const shellNode = section.shellSelector
                    ? cardNode.querySelector(section.shellSelector)
                    : null;
                if (shellNode && Number.isFinite(sectionState.scrollLeft)) {
                    shellNode.scrollLeft = sectionState.scrollLeft;
                }
                if (shellNode && Number.isFinite(sectionState.scrollTop)) {
                    shellNode.scrollTop = sectionState.scrollTop;
                }
            });
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
        const defaultExpandedSymbol = resolveDefaultExpandedSymbol(runtime.config.symbols);
        runtime.config.symbols.forEach((entry) => {
            runtime.cardsBySymbol.set(entry.symbol, createCardState(entry, {
                isExpanded: entry.symbol === defaultExpandedSymbol,
            }));
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

    function closeSocketsForEndpointChange() {
        clearIbStatusPollTimer();
        if (runtime.controlWs) {
            try {
                runtime.controlWs.close(1000, 'endpoint changed');
            } catch (_) {
                // Ignore best-effort shutdown failures.
            }
        }
        runtime.controlWs = null;
        runtime.controlWsOpenPromise = null;
        runtime.ibStatus = {
            connected: false,
            connecting: false,
            message: 'Socket target updated.',
        };

        runtime.cardsBySymbol.forEach((card) => {
            clearCatalogPatchWatchdog(card);
            card.syncInProgress = false;
            card.sampleInProgress = false;
            if (card.pendingCatalog) {
                const pending = card.pendingCatalog;
                card.pendingCatalog = null;
                clearTimeout(pending.timeoutId);
                if (typeof pending.reject === 'function') {
                    pending.reject(new Error('Socket target changed.'));
                }
            }
            card.closeNotice = '';
            if (card.ws) {
                try {
                    card.ws.close(1000, 'endpoint changed');
                } catch (_) {
                    // Ignore best-effort shutdown failures.
                }
            }
            card.ws = null;
            card.wsOpenPromise = null;
            setCardStatus(card, 'Socket target updated. Use Sync/Update to reconnect this ETF.', '');
        });
    }

    function applyWsEndpointFromPage() {
        const hostInput = document.getElementById('ivtsWsHostInput');
        const portInput = document.getElementById('ivtsWsPortInput');
        setSavedWsHost(hostInput ? hostInput.value : getWsHost());
        setSavedWsPort(portInput ? portInput.value : getWsPort());
        syncWsEndpointInputs();
        closeSocketsForEndpointChange();
        render(true);
    }

    function resetWsEndpointFromPage() {
        setSavedWsHost(DEFAULT_WS_HOST);
        setSavedWsPort(DEFAULT_WS_PORT);
        syncWsEndpointInputs();
        closeSocketsForEndpointChange();
        render(true);
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

    function resolveSelectedStraddleBaselineExpiry(card, detailRows) {
        const selected = normalizeExpiryKey(card && card.straddleBaselineExpiry);
        if (!selected) {
            return '';
        }
        return (Array.isArray(detailRows) ? detailRows : []).some((row) => normalizeExpiryKey(row && row.expiry) === selected)
            ? selected
            : '';
    }

    function buildComparedRows(card) {
        const detailRows = buildDetailRows(card);
        const baselineExpiry = resolveSelectedStraddleBaselineExpiry(card, detailRows);
        const comparedDetailRows = core().buildStraddleComparisonRows(detailRows, baselineExpiry);
        const bucketDefinitions = runtime.config && Array.isArray(runtime.config.bucketDefinitions)
            ? runtime.config.bucketDefinitions
            : null;
        const comparedBucketRows = core().buildStraddleComparisonRows(
            core().buildBucketRows(detailRows, bucketDefinitions),
            baselineExpiry
        );
        const baselineRow = comparedDetailRows.find((row) => row && row.isStraddleBaseline) || null;

        return {
            baselineExpiry,
            baselineRow,
            detailRows: comparedDetailRows,
            bucketRows: comparedBucketRows,
        };
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
            const comparedRows = buildComparedRows(card);
            const sampleRecord = core().buildSampleRecord(
                card.symbol,
                card.underlyingPrice,
                comparedRows.bucketRows,
                comparedRows.detailRows,
                new Date().toISOString(),
                card.catalog && card.catalog.anchorDate,
                comparedRows.baselineExpiry
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

    function buildStraddlePriceCell(row) {
        return row && row.atmStraddleMark != null
            ? escapeHtml(formatMoney(row.atmStraddleMark))
            : '<span class="ivts-missing">Insufficient</span>';
    }

    function buildStraddleRatioCell(row, baselineExpiry) {
        if (!baselineExpiry) {
            return '<span class="ivts-missing">--</span>';
        }
        return row && row.straddleBaselineRatio != null
            ? `<span class="ivts-ratio">${escapeHtml(formatMultiple(row.straddleBaselineRatio))}</span>`
            : '<span class="ivts-missing">Insufficient</span>';
    }

    function buildIvPairCell(row) {
        const text = row ? formatIvPair(row.callIv, row.putIv) : '--/--';
        return row && (row.callIv != null || row.putIv != null)
            ? escapeHtml(text)
            : `<span class="ivts-missing">${escapeHtml(text)}</span>`;
    }

    function buildBaselineControl(card, comparedRows) {
        const detailRows = comparedRows && Array.isArray(comparedRows.detailRows) ? comparedRows.detailRows : [];
        const selectedExpiry = comparedRows ? comparedRows.baselineExpiry : '';
        const baselineRow = comparedRows ? comparedRows.baselineRow : null;
        const baselineSummary = selectedExpiry
            ? (baselineRow && baselineRow.atmStraddleMark != null
                ? `Base ATM straddle ${formatMoney(baselineRow.atmStraddleMark)}`
                : 'Selected baseline has insufficient data.')
            : 'Select a synced expiry to compare ATM straddle prices.';
        return `
            <div class="ivts-baseline-control">
                <label for="ivtsBaseline-${escapeHtml(card.symbol)}">
                    <span class="ivts-fact-label">Straddle Baseline</span>
                </label>
                <div class="ivts-baseline-row">
                    <select id="ivtsBaseline-${escapeHtml(card.symbol)}" class="ivts-baseline-select" data-action="baseline" data-symbol="${escapeHtml(card.symbol)}">
                        <option value="">Select expiry</option>
                        ${detailRows.map((row) => {
                            const expiry = normalizeExpiryKey(row && row.expiry);
                            const priceLabel = row && row.atmStraddleMark != null
                                ? `, ${formatMoney(row.atmStraddleMark)} straddle`
                                : ', insufficient data';
                            return `<option value="${escapeHtml(expiry)}" ${expiry && expiry === selectedExpiry ? 'selected' : ''}>${escapeHtml(`${expiry} (${row.dte}D${priceLabel})`)}</option>`;
                        }).join('')}
                    </select>
                    <span class="ivts-baseline-summary">${escapeHtml(baselineSummary)}</span>
                </div>
            </div>
        `;
    }

    function getCalendarFinderRows(card, comparedRows) {
        const config = normalizeCalendarFinderConfig(card && card.calendarFinder);
        const detailRows = comparedRows && Array.isArray(comparedRows.detailRows) ? comparedRows.detailRows : [];
        return core().buildCalendarFinderRows(detailRows, config);
    }

    function buildCalendarTargetOptions(config) {
        return CALENDAR_TARGET_PRESETS.map((value) => (
            `<option value="${escapeHtml(value)}" ${config.targetPreset === value ? 'selected' : ''}>${escapeHtml(value)}X</option>`
        )).join('') + `<option value="custom" ${config.targetPreset === 'custom' ? 'selected' : ''}>Custom</option>`;
    }

    function buildCalendarToleranceOptions(config) {
        return [15, 25, 40].map((value) => (
            `<option value="${value}" ${config.tolerancePct === value ? 'selected' : ''}>+/-${value}%</option>`
        )).join('');
    }

    function buildCalendarSortOptions(config) {
        const labels = {
            best_value: 'Best Value',
            cheapest_long: 'Cheapest Long',
            closest_ratio: 'Closest Ratio',
        };
        return ['best_value', 'cheapest_long', 'closest_ratio'].map((value) => (
            `<option value="${escapeHtml(value)}" ${config.sortBy === value ? 'selected' : ''}>${escapeHtml(labels[value])}</option>`
        )).join('');
    }

    function describeCalendarFinderEmptyState(config, stats) {
        if (!stats || stats.totalExpiries === 0) {
            return 'No expiry rows yet. Sync/Update to subscribe quotes first.';
        }
        if (stats.usableExpiries < 2) {
            return `Waiting for complete straddle quotes (${stats.usableExpiries}/${stats.totalExpiries} expiries usable).`;
        }
        if (stats.shortCandidates === 0) {
            return `No short-leg expiry inside ${config.shortMinDte}-${config.shortMaxDte} DTE (${stats.usableExpiries} usable expiries). Widen the Short DTE range.`;
        }
        return `No long leg within +/-${config.tolerancePct}% of the ${formatCompactMultiple(config.targetRatio)} DTE ratio (${stats.shortCandidates} short candidates). Raise the tolerance or change the target.`;
    }

    function getCalendarFinderSecondaryRow(rows) {
        const picker = core() && core().pickCalendarFinderSecondaryCandidate;
        if (typeof picker === 'function') {
            return picker(rows);
        }
        return Array.isArray(rows) && rows.length > 1 ? rows[1] : null;
    }

    function isSameCalendarCandidate(left, right) {
        return !!(
            left
            && right
            && left.shortExpiry === right.shortExpiry
            && left.longExpiry === right.longExpiry
            && left.shortDte === right.shortDte
            && left.longDte === right.longDte
        );
    }

    function describeCalendarSecondaryReason(best, secondary) {
        if (
            best
            && secondary
            && Number.isFinite(secondary.shortDte)
            && Number.isFinite(best.shortDte)
            && secondary.shortDte > best.shortDte
        ) {
            return 'Later short leg';
        }
        return 'Second ranked';
    }

    function getCalendarCandidateRank(rows, row) {
        if (!Array.isArray(rows) || !row) {
            return null;
        }
        const index = rows.findIndex((candidate) => isSameCalendarCandidate(candidate, row));
        return index >= 0 ? index + 1 : null;
    }

    function buildVisibleCalendarRows(rows, secondary, showAll) {
        if (!Array.isArray(rows) || showAll) {
            return Array.isArray(rows) ? rows : [];
        }

        const visibleRows = rows.slice(0, CALENDAR_FINDER_TOP_LIMIT);
        if (secondary && !visibleRows.some((row) => isSameCalendarCandidate(row, secondary))) {
            visibleRows.push(secondary);
        }
        return visibleRows;
    }

    function buildCalendarRecommendation(label, row, note) {
        if (!row) {
            return '';
        }
        const modifier = label === 'Next' ? ' is-secondary' : '';
        return `
            <div class="ivts-calendar-pick${modifier}">
                <div class="ivts-calendar-pick-head">
                    <span class="ivts-calendar-pick-label">${escapeHtml(label)}</span>
                    <span class="ivts-calendar-pick-note">${escapeHtml(note || '')}</span>
                </div>
                <div class="ivts-calendar-pick-main">${escapeHtml(`${row.shortExpiry} / ${row.longExpiry}`)}</div>
                <div class="ivts-calendar-pick-meta">
                    <span>${escapeHtml(`${row.shortDte}D -> ${row.longDte}D`)}</span>
                    <span>${escapeHtml(`${formatCompactMultiple(row.priceMultiple)} price`)}</span>
                    <span>${escapeHtml(`${formatMultiple(row.valueScore)} value`)}</span>
                </div>
            </div>
        `;
    }

    function buildCalendarFinderSection(card, comparedRows) {
        const config = normalizeCalendarFinderConfig(card && card.calendarFinder);
        const detailRows = comparedRows && Array.isArray(comparedRows.detailRows) ? comparedRows.detailRows : [];
        const rows = getCalendarFinderRows({ ...card, calendarFinder: config }, comparedRows);
        const stats = core().buildCalendarFinderStats(detailRows, config);
        const best = rows[0] || null;
        const secondary = getCalendarFinderSecondaryRow(rows);
        const visibleRows = buildVisibleCalendarRows(rows, secondary, config.showAll);
        const secondaryReason = secondary ? describeCalendarSecondaryReason(best, secondary) : '';
        const emptyMessage = describeCalendarFinderEmptyState(config, stats);
        const summary = best
            ? `Best ${formatMultiple(best.valueScore)} | ${best.shortDte}D -> ${best.longDte}D${secondary ? ` | Next ${secondary.shortDte}D -> ${secondary.longDte}D` : ''}`
            : emptyMessage;
        const customDisabled = config.targetPreset !== 'custom' ? 'disabled' : '';
        const showAllButtonLabel = config.showAll
            ? 'Top 5'
            : (rows.length > CALENDAR_FINDER_TOP_LIMIT ? `Show All (${rows.length})` : 'Show All');

        return `
            <details class="ivts-details ivts-calendar-finder">
                <summary>
                    <span>Calendar Finder</span>
                    <span class="ivts-calendar-summary">${escapeHtml(summary)}</span>
                </summary>
                <div class="ivts-details-body ivts-calendar-body">
                    <div class="ivts-calendar-controls">
                        <label class="ivts-calendar-field">
                            <span class="ivts-fact-label">Target Ratio</span>
                            <select data-action="calendar-target-preset" data-symbol="${escapeHtml(card.symbol)}">
                                ${buildCalendarTargetOptions(config)}
                            </select>
                        </label>
                        <label class="ivts-calendar-field ivts-calendar-custom-field">
                            <span class="ivts-fact-label">Custom</span>
                            <input data-action="calendar-target-custom" data-symbol="${escapeHtml(card.symbol)}" type="number" min="1.05" max="8" step="0.05" value="${escapeHtml(formatNumber(config.targetRatio, 2))}" ${customDisabled}>
                        </label>
                        <label class="ivts-calendar-field">
                            <span class="ivts-fact-label">Tolerance</span>
                            <select data-action="calendar-tolerance" data-symbol="${escapeHtml(card.symbol)}">
                                ${buildCalendarToleranceOptions(config)}
                            </select>
                        </label>
                        <label class="ivts-calendar-field">
                            <span class="ivts-fact-label">Short DTE</span>
                            <span class="ivts-calendar-range">
                                <input data-action="calendar-short-min" data-symbol="${escapeHtml(card.symbol)}" type="number" min="0" max="999" step="1" value="${escapeHtml(config.shortMinDte)}">
                                <input data-action="calendar-short-max" data-symbol="${escapeHtml(card.symbol)}" type="number" min="0" max="999" step="1" value="${escapeHtml(config.shortMaxDte)}">
                            </span>
                        </label>
                        <label class="ivts-calendar-field">
                            <span class="ivts-fact-label">Sort</span>
                            <select data-action="calendar-sort" data-symbol="${escapeHtml(card.symbol)}">
                                ${buildCalendarSortOptions(config)}
                            </select>
                        </label>
                        <button class="ivts-btn ivts-btn-muted ivts-calendar-toggle" data-action="calendar-show-all" data-symbol="${escapeHtml(card.symbol)}" type="button" ${rows.length <= CALENDAR_FINDER_TOP_LIMIT && !config.showAll ? 'disabled' : ''}>${escapeHtml(showAllButtonLabel)}</button>
                    </div>
                    ${best ? `
                        <div class="ivts-calendar-picks" aria-label="Calendar recommendations">
                            ${buildCalendarRecommendation('Best', best, 'Lowest value score')}
                            ${buildCalendarRecommendation('Next', secondary, secondaryReason)}
                        </div>
                    ` : ''}
                    <div class="ivts-table-shell ivts-calendar-table-shell">
                        <table class="ivts-table ivts-table-calendar">
                            <thead>
                                <tr>
                                    <th>Rank</th>
                                    <th>Sell Expiry</th>
                                    <th>Buy Expiry</th>
                                    <th>DTE Ratio</th>
                                    <th>Straddle</th>
                                    <th>Price</th>
                                    <th>Value</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${visibleRows.map((row, index) => {
                                    const canLoad = row.shortAtmStrike != null && row.longAtmStrike != null;
                                    const isBest = isSameCalendarCandidate(row, best);
                                    const isSecondary = isSameCalendarCandidate(row, secondary);
                                    const rowClasses = ['ivts-calendar-row'];
                                    if (isBest) {
                                        rowClasses.push('is-calendar-best');
                                    }
                                    if (isSecondary) {
                                        rowClasses.push('is-calendar-secondary');
                                    }
                                    const rankBadge = isBest
                                        ? '<span class="ivts-rank-badge">Best</span>'
                                        : (isSecondary ? '<span class="ivts-rank-badge is-secondary">Next</span>' : '');
                                    const rank = getCalendarCandidateRank(rows, row) || index + 1;
                                    return `
                                    <tr class="${escapeHtml(rowClasses.join(' '))}">
                                        <td><span class="ivts-rank-number">${rank}</span>${rankBadge}</td>
                                        <td>${escapeHtml(`${row.shortExpiry} (${row.shortDte}D)`)}</td>
                                        <td>${escapeHtml(`${row.longExpiry} (${row.longDte}D)`)}</td>
                                        <td>${escapeHtml(formatCompactMultiple(row.dteRatio))}</td>
                                        <td>${escapeHtml(`${formatMoney(row.shortStraddleMark)}/${formatMoney(row.longStraddleMark)}`)}</td>
                                        <td>${escapeHtml(formatCompactMultiple(row.priceMultiple))}</td>
                                        <td><span class="ivts-ratio">${escapeHtml(formatMultiple(row.valueScore))}</span></td>
                                        <td><button class="ivts-btn ivts-btn-muted ivts-calendar-load" data-action="calendar-load" data-symbol="${escapeHtml(card.symbol)}" data-short-expiry="${escapeHtml(row.shortExpiry)}" data-long-expiry="${escapeHtml(row.longExpiry)}" type="button" ${canLoad ? '' : 'disabled'} title="${canLoad ? 'Open this calendar in the simulator' : 'ATM strikes are not resolved yet'}">Load</button></td>
                                    </tr>
                                `;
                                }).join('') || `
                                    <tr>
                                        <td colspan="8" class="ivts-missing">${escapeHtml(emptyMessage)}</td>
                                    </tr>
                                `}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
        `;
    }

    function getPrimaryExpiryRows(comparedRows) {
        return comparedRows && Array.isArray(comparedRows.detailRows)
            ? comparedRows.detailRows
            : [];
    }

    function buildBucketSummaryTable(comparedRows) {
        const bucketRows = comparedRows.bucketRows;
        const baselineExpiry = comparedRows.baselineExpiry;
        return `
            <details class="ivts-details ivts-bucket-summary">
                <summary>Bucket Summary (${bucketRows.length})</summary>
                <div class="ivts-details-body">
                    <div class="ivts-table-shell ivts-bucket-table-shell">
                        <table class="ivts-table ivts-table-buckets">
                            <thead>
                                <tr>
                                    <th>Bucket</th>
                                    <th>Matched Expiry</th>
                                    <th>DTE</th>
                                    <th>ATM Strike</th>
                                    <th>Call/Put IV</th>
                                    <th>ATM Straddle</th>
                                    <th>Vs Base</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${bucketRows.map((row) => `
                                    <tr class="${row.isStraddleBaseline ? 'is-straddle-baseline' : ''}">
                                        <td>${escapeHtml(row.label)}</td>
                                        <td>${row.matchedExpiry ? escapeHtml(row.matchedExpiry) : '<span class="ivts-missing">--</span>'}</td>
                                        <td>${row.matchedDte != null ? escapeHtml(row.matchedDte) : '<span class="ivts-missing">--</span>'}</td>
                                        <td>${row.atmStrike != null ? escapeHtml(formatNumber(row.atmStrike, 2)) : '<span class="ivts-missing">--</span>'}</td>
                                        <td>${buildIvPairCell(row)}</td>
                                        <td>${buildStraddlePriceCell(row)}</td>
                                        <td>${buildStraddleRatioCell(row, baselineExpiry)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>
        `;
    }

    function buildPrimaryExpiryTable(comparedRows) {
        const detailRows = getPrimaryExpiryRows(comparedRows);
        const baselineExpiry = comparedRows.baselineExpiry;
        return `
            <div class="ivts-table-caption">All Expiries (${detailRows.length})</div>
            <div class="ivts-table-shell ivts-details-table-shell">
                <table class="ivts-table ivts-table-details">
                    <thead>
                        <tr>
                            <th>Expiry</th>
                            <th>DTE</th>
                            <th>ATM Strike</th>
                            <th>Call/Put IV</th>
                            <th>ATM Straddle</th>
                            <th>Vs Base</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${detailRows.map((row) => `
                            <tr class="${row.isStraddleBaseline ? 'is-straddle-baseline' : ''}">
                                <td>${escapeHtml(row.expiry)}</td>
                                <td>${escapeHtml(row.dte)}</td>
                                <td>${row.atmStrike != null ? escapeHtml(formatNumber(row.atmStrike, 2)) : '<span class="ivts-missing">--</span>'}</td>
                                <td>${buildIvPairCell(row)}</td>
                                <td>${buildStraddlePriceCell(row)}</td>
                                <td>${buildStraddleRatioCell(row, baselineExpiry)}</td>
                            </tr>
                        `).join('') || `
                            <tr>
                                <td colspan="6" class="ivts-missing">No expiry rows have been synced yet.</td>
                            </tr>
                        `}
                    </tbody>
                </table>
            </div>
        `;
    }

    function buildCardBodyMarkup(card) {
        const historyDocument = readOnlyHistoryDocument(card);
        const comparedRows = buildComparedRows(card);
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

            ${buildBaselineControl(card, comparedRows)}
            ${buildCalendarFinderSection(card, comparedRows)}
            ${buildPrimaryExpiryTable(comparedRows)}
            ${buildBucketSummaryTable(comparedRows)}
        `;
    }

    function buildCardHeaderSummary(card) {
        const historyDocument = readOnlyHistoryDocument(card);
        return `
            <div class="ivts-card-overview" aria-label="${escapeHtml(card.symbol)} summary">
                <span>Underlying <strong data-field="header-underlying">${card.underlyingPrice != null ? `$${formatNumber(card.underlyingPrice, 2)}` : '--'}</strong></span>
                <span>Samples <strong data-field="header-samples">${historyDocument.samples.length}</strong></span>
                <span>Last Sync <strong data-field="header-last-sync">${escapeHtml(formatTimestamp(card.lastSyncLabel))}</strong></span>
            </div>
            <div class="ivts-card-header-status ${card.statusKind ? `is-${escapeHtml(card.statusKind)}` : ''}" data-field="header-status">
                ${escapeHtml(card.statusMessage)}
            </div>
        `;
    }

    function buildCardMarkup(card) {
        const sampleDisabled = card.syncInProgress || card.sampleInProgress || (!card.currentFileHandle && (globalScope.showOpenFilePicker || !card.historyDocument));
        const unsubscribeDisabled = !card.ws || (card.ws.readyState !== WebSocket.OPEN && card.ws.readyState !== WebSocket.CONNECTING);
        const expanded = card.isExpanded === true;
        return `
            <article class="ivts-card ${expanded ? 'is-expanded' : 'is-collapsed'}" data-symbol="${escapeHtml(card.symbol)}">
                <div class="ivts-card-header">
                    <div class="ivts-card-heading">
                        <div class="ivts-card-title-row">
                            <button class="ivts-card-toggle" data-action="toggle-card" data-symbol="${escapeHtml(card.symbol)}" type="button" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="ivts-card-body-${escapeHtml(card.symbol)}" title="${expanded ? 'Collapse' : 'Expand'} ${escapeHtml(card.symbol)}">
                                <span aria-hidden="true">${expanded ? '-' : '+'}</span>
                                <span class="ivts-sr-only">${expanded ? 'Collapse' : 'Expand'} ${escapeHtml(card.symbol)}</span>
                            </button>
                            <h2>${escapeHtml(card.symbol)}</h2>
                        </div>
                        <div class="ivts-card-meta">
                            ${escapeHtml(card.historyPath)}
                        </div>
                        ${buildCardHeaderSummary(card)}
                    </div>
                    <div class="ivts-actions">
                        <button class="ivts-btn" data-action="open" data-symbol="${escapeHtml(card.symbol)}">Open History</button>
                        <button class="ivts-btn ivts-btn-muted" data-action="unsubscribe" data-symbol="${escapeHtml(card.symbol)}" ${unsubscribeDisabled ? 'disabled' : ''}>Unsubscribe</button>
                        <button class="ivts-btn ivts-btn-primary" data-action="sync" data-symbol="${escapeHtml(card.symbol)}" ${card.syncInProgress || card.sampleInProgress ? 'disabled' : ''}>Sync/Update</button>
                        <button class="ivts-btn ivts-btn-warm" data-action="sample" data-symbol="${escapeHtml(card.symbol)}" ${sampleDisabled ? 'disabled' : ''}>Sample</button>
                    </div>
                </div>
                <div id="ivts-card-body-${escapeHtml(card.symbol)}" class="ivts-card-body" ${expanded ? '' : 'hidden'}>
                    ${buildCardBodyMarkup(card)}
                </div>
            </article>
        `;
    }

    function updateCardChrome(card, cardNode) {
        const expanded = card.isExpanded === true;
        cardNode.classList.toggle('is-expanded', expanded);
        cardNode.classList.toggle('is-collapsed', !expanded);

        const toggleButton = cardNode.querySelector('[data-action="toggle-card"]');
        if (toggleButton) {
            toggleButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            toggleButton.title = `${expanded ? 'Collapse' : 'Expand'} ${card.symbol}`;
            const visible = toggleButton.querySelector('[aria-hidden="true"]');
            if (visible) {
                visible.textContent = expanded ? '-' : '+';
            }
            const srOnly = toggleButton.querySelector('.ivts-sr-only');
            if (srOnly) {
                srOnly.textContent = `${expanded ? 'Collapse' : 'Expand'} ${card.symbol}`;
            }
        }

        const historyDocument = readOnlyHistoryDocument(card);
        const headerUnderlying = cardNode.querySelector('[data-field="header-underlying"]');
        const headerSamples = cardNode.querySelector('[data-field="header-samples"]');
        const headerLastSync = cardNode.querySelector('[data-field="header-last-sync"]');
        const headerStatus = cardNode.querySelector('[data-field="header-status"]');
        if (headerUnderlying) {
            headerUnderlying.textContent = card.underlyingPrice != null ? `$${formatNumber(card.underlyingPrice, 2)}` : '--';
        }
        if (headerSamples) {
            headerSamples.textContent = String(historyDocument.samples.length);
        }
        if (headerLastSync) {
            headerLastSync.textContent = formatTimestamp(card.lastSyncLabel);
        }
        if (headerStatus) {
            headerStatus.textContent = card.statusMessage;
            headerStatus.className = `ivts-card-header-status${card.statusKind ? ` is-${card.statusKind}` : ''}`;
            headerStatus.setAttribute('data-field', 'header-status');
        }

        const bodyNode = cardNode.querySelector('.ivts-card-body');
        if (bodyNode) {
            bodyNode.hidden = !expanded;
        }
    }

    function updateCardElement(card, cardNode) {
        if (!cardNode) {
            return;
        }

        updateCardChrome(card, cardNode);

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

        const forceBodyRefresh = card.forceBodyRefreshOnce === true;
        card.forceBodyRefreshOnce = false;
        if (!forceBodyRefresh && isFocusedCardControlInCard(cardNode)) {
            return;
        }

        const viewState = captureCardViewState(cardNode.parentElement || cardNode);
        bodyNode.innerHTML = buildCardBodyMarkup(card);
        restoreCardViewState(cardNode.parentElement || cardNode, viewState);
    }

    function applyCalendarFinderFieldChange(field) {
        const card = getCard(field.getAttribute('data-symbol'));
        if (!card) {
            return;
        }

        const action = String(field.getAttribute('data-action') || '').trim();
        const nextConfig = normalizeCalendarFinderConfig(card.calendarFinder);
        if (action === 'calendar-target-preset') {
            const value = String(field.value || '').trim();
            if (value === 'custom') {
                nextConfig.targetPreset = 'custom';
            } else if (CALENDAR_TARGET_PRESETS.includes(value)) {
                nextConfig.targetPreset = value;
                nextConfig.targetRatio = parseFloat(value);
            }
        } else if (action === 'calendar-target-custom') {
            nextConfig.targetPreset = 'custom';
            nextConfig.targetRatio = field.value;
        } else if (action === 'calendar-tolerance') {
            nextConfig.tolerancePct = field.value;
        } else if (action === 'calendar-short-min') {
            nextConfig.shortMinDte = field.value;
        } else if (action === 'calendar-short-max') {
            nextConfig.shortMaxDte = field.value;
        } else if (action === 'calendar-sort') {
            nextConfig.sortBy = field.value;
        } else {
            return;
        }

        card.calendarFinder = normalizeCalendarFinderConfig(nextConfig);
        saveCalendarFinderConfig(card.symbol, card.calendarFinder);
        card.forceBodyRefreshOnce = true;
        render(true);
    }

    function toggleCalendarFinderShowAll(button) {
        const card = getCard(button.getAttribute('data-symbol'));
        if (!card) {
            return;
        }
        const nextConfig = normalizeCalendarFinderConfig(card.calendarFinder);
        nextConfig.showAll = !nextConfig.showAll;
        card.calendarFinder = normalizeCalendarFinderConfig(nextConfig);
        saveCalendarFinderConfig(card.symbol, card.calendarFinder);
        card.forceBodyRefreshOnce = true;
        render(true);
    }

    function toggleCardExpanded(card) {
        if (!card) {
            return;
        }
        card.isExpanded = card.isExpanded !== true;
        render(true);
    }

    function loadCalendarCandidate(button) {
        const card = getCard(button.getAttribute('data-symbol'));
        if (!card) {
            return;
        }
        const handoff = typeof OptionComboCalendarHandoff !== 'undefined' ? OptionComboCalendarHandoff : null;
        if (!handoff) {
            setCardStatus(card, 'Calendar handoff module is not loaded.', 'error');
            render(true);
            return;
        }

        const shortExpiry = String(button.getAttribute('data-short-expiry') || '').trim();
        const longExpiry = String(button.getAttribute('data-long-expiry') || '').trim();
        const rows = getCalendarFinderRows(card, buildComparedRows(card));
        const row = rows.find((entry) => entry.shortExpiry === shortExpiry && entry.longExpiry === longExpiry) || null;
        if (!row) {
            setCardStatus(card, 'That calendar candidate is no longer available. Refresh and retry.', 'error');
            render(true);
            return;
        }

        const payload = handoff.buildHandoffPayload({
            symbol: card.symbol,
            underlyingPrice: card.underlyingPrice,
            row,
        });
        if (!payload || !handoff.saveHandoffPayload(payload)) {
            setCardStatus(card, 'Could not hand the calendar off to the simulator (missing strikes or storage blocked).', 'error');
            render(true);
            return;
        }

        setCardStatus(card, `Opening simulator with the ${shortExpiry}/${longExpiry} calendar...`, '');
        render(true);
        window.open('index.html', '_blank');
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
            if (action === 'toggle-card') {
                toggleCardExpanded(card);
                return;
            }
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
                return;
            }
            if (action === 'calendar-show-all') {
                toggleCalendarFinderShowAll(button);
                return;
            }
            if (action === 'calendar-load') {
                loadCalendarCandidate(button);
            }
        });

        container.addEventListener('change', (event) => {
            const calendarField = event.target.closest('[data-action^="calendar-"][data-symbol]');
            if (calendarField && calendarField.getAttribute('data-action') !== 'calendar-show-all') {
                applyCalendarFinderFieldChange(calendarField);
                return;
            }

            const field = event.target.closest('select[data-action="baseline"][data-symbol]');
            if (!field) {
                return;
            }
            const card = getCard(field.getAttribute('data-symbol'));
            if (!card) {
                return;
            }
            card.straddleBaselineExpiry = normalizeExpiryKey(field.value);
            card.forceBodyRefreshOnce = true;
            render(true);
        });

        container.addEventListener('focusout', (event) => {
            const field = event.target.closest('select[data-action="baseline"][data-symbol], [data-action^="calendar-"][data-symbol]');
            if (!field) {
                return;
            }
            setTimeout(() => {
                render(true);
            }, 0);
        });

        container.dataset.bound = 'true';
    }

    globalScope.OptionComboIvTermStructurePage = {
        _test: {
            normalizeWsHost,
            normalizeWsPort,
            resolveDefaultExpandedSymbol,
            createCardState,
            isBaselineSelectElement,
            isFocusedBaselineSelectInCard,
            getPrimaryExpiryRows,
            formatIvPair,
            buildPrimaryExpiryTable,
            buildCardMarkup,
            normalizeCalendarFinderConfig,
            buildCalendarFinderSection,
            describeCalendarFinderEmptyState,
            loadSavedCalendarFinderConfig,
            saveCalendarFinderConfig,
            captureCardViewState,
            restoreCardViewState,
        },
    };

    function performRender() {
        const socketStatus = document.getElementById('ivtsSocketStatus');
        if (socketStatus) {
            socketStatus.textContent = getWsUrl();
        }
        syncWsEndpointInputs();

        const configStatus = document.getElementById('ivtsConfigStatus');
        if (configStatus) {
            configStatus.textContent = runtime.config
                ? `${runtime.config.symbols.length} symbols via ${runtime.configSourceLabel || 'config'}`
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
            const wsApplyButton = document.getElementById('ivtsWsApplyButton');
            if (wsApplyButton) {
                wsApplyButton.addEventListener('click', () => {
                    applyWsEndpointFromPage();
                });
            }
            const wsResetButton = document.getElementById('ivtsWsResetButton');
            if (wsResetButton) {
                wsResetButton.addEventListener('click', () => {
                    resetWsEndpointFromPage();
                });
            }
            ['ivtsWsHostInput', 'ivtsWsPortInput'].forEach((id) => {
                const input = document.getElementById(id);
                if (!input) {
                    return;
                }
                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        applyWsEndpointFromPage();
                    }
                });
            });
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
