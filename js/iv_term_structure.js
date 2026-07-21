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
            { symbol: 'CL', historyPath: 'iv_term_structure/data/CL.json' },
            { symbol: 'SI', historyPath: 'iv_term_structure/data/SI.json' },
            { symbol: 'ES', historyPath: 'iv_term_structure/data/ES.json' },
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
        sortBy: 'best_iv_ratio',
        showAll: false,
    });
    const CALENDAR_FINDER_TOP_LIMIT = 5;
    const CALENDAR_FINDER_STORAGE_KEY = 'optionComboIvtsCalendarFinder';
    const FUTURES_CONTRACT_MONTH_STORAGE_KEY = 'optionComboIvtsFuturesContractMonth';
    const OPTION_STREAM_LIMIT_STORAGE_KEY = 'optionComboIvtsOptionStreamLimit';
    // Ten expiries (20 ATM call/put streams) normally cover at least two
    // adjacent weekends on daily-expiry products and keep the estimator from
    // degrading into one synthetic front observation.
    const DEFAULT_MAX_OPTION_STREAMS = 20;
    const OPTION_STREAM_LIMIT_CHOICES = Object.freeze([10, 20, 40, 0]);
    const TD_IV_LAMBDA_STORAGE_KEY = 'optionComboIvtsTdIvLambdaGlobal';
    const DEFAULT_TD_IV_LAMBDA = 0.3;
    const AUTO_SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
    const AUTO_SAMPLE_MONITOR_INTERVAL_MS = 60 * 1000;
    const AUTO_SAMPLE_RETRY_DELAY_MS = 5 * 60 * 1000;
    const DISCOUNT_CURVE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS = 120;
    // Widest spread between the oldest and newest quote a manually assembled
    // surface may carry and still be called coherent. The incremental quote
    // map is written by per-ticker packets at arbitrary times, so a surface
    // built from it is only "one observation" if its legs were actually
    // observed together.
    const IMPLIED_LAMBDA_MAX_QUOTE_SKEW_SECONDS = 120;
    const CLOCK_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
    const AUTO_HISTORY_PURPOSE = 'iv-term-structure-auto-samples';
    const IV_TERM_STRUCTURE_SNAPSHOT_TIMEOUT_MS = 90 * 1000;
    const IV_TERM_STRUCTURE_ACK_TIMEOUT_MS = 8 * 1000;
    const IV_TERM_STRUCTURE_PROTOCOL_VERSION = '20260719.5';
    const NYSE_OPTION_CLOSE_MINUTES = 16 * 60 + 15;
    const CARD_VIEW_STATE_SECTIONS = Object.freeze([
        {
            key: 'sampling',
            detailsSelector: '.ivts-sampling-details',
            shellSelector: '',
        },
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
        autoSampleMonitorTimerId: null,
        discountCurveRefreshTimerId: null,
        controlWs: null,
        controlWsOpenPromise: null,
        ibStatusPollTimerId: null,
        apiResetInProgress: false,
        tdIvWeekendWeight: DEFAULT_TD_IV_LAMBDA,
        impliedLambdaRate: 0.04,
        discountCurve: null,
        discountCurveStatus: '',
        discountCurveFallbackUsed: false,
        discountCurveLastError: '',
        pageSuspended: false,
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

    function marketCurves() {
        return globalScope.OptionComboMarketCurves;
    }

    function applyDiscountCurveSnapshot(payload) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const snapshot = data.curve && typeof data.curve === 'object' ? data.curve : null;
        if (!snapshot) {
            runtime.discountCurveStatus = String(data.status || 'unavailable').trim();
            runtime.discountCurveFallbackUsed = data.fallbackUsed === true;
            runtime.discountCurveLastError = String(
                data.error || 'No unified daily discount curve is available.'
            ).trim();
            return false;
        }
        const api = marketCurves();
        if (!api) {
            runtime.discountCurveLastError = 'Shared market-curves runtime is unavailable.';
            return false;
        }
        const adapter = typeof api.createDiscountCurveFromSnapshot === 'function'
            ? api.createDiscountCurveFromSnapshot
            : api.createDiscountCurveFromTreasurySnapshot;
        if (typeof adapter !== 'function') {
            runtime.discountCurveLastError = 'Discount-curve snapshot adapter is unavailable.';
            return false;
        }
        try {
            runtime.discountCurve = adapter(snapshot, {
                maxExtrapolationDays: 31,
            });
            runtime.discountCurveStatus = String(data.status || 'cached').trim();
            runtime.discountCurveFallbackUsed = data.fallbackUsed === true;
            runtime.discountCurveLastError = data.fallbackUsed === true
                ? String(data.error || '').trim()
                : '';
            runtime.cardsBySymbol.forEach((card) => {
                if (card) {
                    card.forceBodyRefreshOnce = true;
                    card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
                }
            });
            return true;
        } catch (error) {
            runtime.discountCurveLastError = String(
                error && error.message || 'Discount curve payload is invalid.'
            ).trim();
            return false;
        }
    }

    function formatDiscountCurveStatus() {
        const curve = runtime.discountCurve;
        if (!curve) {
            const fallbackPct = Number.isFinite(runtime.impliedLambdaRate)
                ? (runtime.impliedLambdaRate * 100).toFixed(2)
                : (DEFAULT_IMPLIED_LAMBDA_RATE * 100).toFixed(2);
            return `Fallback r ${fallbackPct}%`;
        }
        const effectiveDate = String(curve.curveAsOf || curve.asOf || curve.effectiveDate || '').trim();
        const hasHybridSources = !!(curve.sources && curve.sources.sofr && curve.sources.treasury);
        const label = hasHybridSources
            ? 'SOFR/CMT reference curve'
            : (curve.isProxy === true ? 'Discount proxy' : 'Discount curve');
        const cached = runtime.discountCurveFallbackUsed ? ' · cached' : '';
        return `${label}${effectiveDate ? ` ${effectiveDate}` : ''}${cached}`;
    }

    function discountCurveStatusTitle() {
        const curve = runtime.discountCurve;
        if (!curve) {
            return `Using manual continuously compounded r fallback. ${runtime.discountCurveLastError || ''}`.trim();
        }
        const metadata = curve.metadata && typeof curve.metadata === 'object'
            ? curve.metadata
            : {};
        const source = String(metadata.source || 'USD reference curve').trim();
        const sofrDate = String(curve.sources && curve.sources.sofr
            && curve.sources.sofr.effectiveDate || '').trim();
        const treasuryDate = String(curve.sources && curve.sources.treasury
            && curve.sources.treasury.effectiveDate || '').trim();
        const semantics = curve.sources && curve.sources.sofr && curve.sources.treasury
            ? `Overnight SOFR flat through 30d, smooth forward blend, then SOFR-anchored Treasury CMT proxy slope. SOFR ${sofrDate || '--'}; Treasury ${treasuryDate || '--'}. SOFR averages are diagnostics only; this is not a bootstrapped OIS zero curve.`
            : (curve.isProxy === true
                ? 'Reference-rate proxy; not a bootstrapped zero/OIS curve.'
                : 'Continuously compounded discount curve.');
        const warning = runtime.discountCurveLastError
            ? ` Last refresh warning: ${runtime.discountCurveLastError}`
            : '';
        return `${source}. ${semantics}${warning}`;
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

    function buildIbStatusAfterApiMarketDataReset(previousStatus, payload, message) {
        const data = payload && typeof payload === 'object' ? payload : {};
        if (data.success === true) {
            return {
                connected: false,
                connecting: data.reconnecting === true,
                message,
            };
        }
        return {
            ...(previousStatus || {}),
            connecting: false,
            message,
        };
    }

    function handleApiMarketDataReset(payload) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const succeeded = data.success === true;
        const message = String(data.message || (
            succeeded
                ? 'All API market-data subscriptions were cleared. Subscribe each page again.'
                : 'Unable to clear API market-data subscriptions.'
        )).trim();

        runtime.apiResetInProgress = false;
        runtime.ibStatus = buildIbStatusAfterApiMarketDataReset(runtime.ibStatus, data, message);

        if (succeeded) {
            runtime.cardsBySymbol.forEach((card) => {
                clearCatalogPatchWatchdog(card);
                if (card.pendingCatalog) {
                    const pending = card.pendingCatalog;
                    card.pendingCatalog = null;
                    clearPendingCatalogTimers(pending);
                    pending.reject(new Error(message));
                }
                card.syncInProgress = false;
                card.sampleInProgress = false;
                card.catalog = null;
                card.quotesBySubId = {};
                card.lambdaSnapshot = null;
                card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
                card.underlyingPrice = null;
                card.lastSyncLabel = '';
                card.catalogPatchCount = 0;
                setCardStatus(card, message, 'error');
            });
        }

        scheduleIbStatusPollIfNeeded();
        render(true);
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeDateKey(value) {
        const compact = String(value || '').slice(0, 10).replace(/[-/]/g, '');
        return /^\d{8}$/.test(compact)
            ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
            : '';
    }

    function dateKeyAtOffset(dateKey, offsetDays) {
        const normalized = normalizeDateKey(dateKey);
        if (!normalized) {
            return '';
        }
        const [year, month, day] = normalized.split('-').map(Number);
        const value = new Date(Date.UTC(year, month - 1, day + offsetDays));
        return value.toISOString().slice(0, 10);
    }

    function isoWeekMonday(dateKey) {
        const normalized = normalizeDateKey(dateKey);
        if (!normalized) {
            return '';
        }
        const day = new Date(`${normalized}T00:00:00Z`).getUTCDay();
        return dateKeyAtOffset(normalized, -(day === 0 ? 6 : day - 1));
    }

    function officialWeekFinalSession(calendarId, dateKey) {
        const monday = isoWeekMonday(dateKey);
        if (!monday || typeof globalScope.getOfficialExchangeCalendarDay !== 'function') {
            return { status: 'calendar_unavailable', date: '' };
        }
        let finalSession = '';
        for (let offset = 0; offset < 5; offset += 1) {
            const candidate = dateKeyAtOffset(monday, offset);
            const info = globalScope.getOfficialExchangeCalendarDay(calendarId, candidate);
            if (!info || info.available !== true) {
                return { status: 'calendar_unavailable', date: '' };
            }
            if (info.status !== 'closed') {
                finalSession = candidate;
            }
        }
        return finalSession
            ? { status: 'ok', date: finalSession }
            : { status: 'calendar_unavailable', date: '' };
    }

    function localTimestampParts(value, timeZone) {
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime())) {
            return null;
        }
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        const parts = {};
        formatter.formatToParts(parsed).forEach((part) => {
            if (part.type !== 'literal') {
                parts[part.type] = part.value;
            }
        });
        return {
            date: `${parts.year}-${parts.month}-${parts.day}`,
            minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
            timestamp: parsed.getTime(),
        };
    }

    function currentExchangeDate(calendarId, nowValue = new Date()) {
        const normalizedCalendarId = String(calendarId || '').toUpperCase();
        const isFuturesCalendar = normalizedCalendarId.startsWith('CME:')
            || normalizedCalendarId.startsWith('NYMEX:')
            || normalizedCalendarId.startsWith('COMEX:');
        const timeZone = normalizedCalendarId === 'NYSE'
            ? 'America/New_York'
            : 'America/Chicago';
        const parts = localTimestampParts(nowValue, timeZone);
        if (!parts) {
            return new Date(nowValue).toISOString().slice(0, 10);
        }

        // Globex sessions opened at 17:00 CT belong to the following exchange
        // trade date.  Using the Chicago civil date here would leave an IVTS
        // page opened on Sunday night anchored to Sunday until manual resync.
        let candidate = isFuturesCalendar && parts.minuteOfDay >= 17 * 60
            ? dateKeyAtOffset(parts.date, 1)
            : parts.date;
        const dateUtils = globalScope.OptionComboDateUtils;
        if (!dateUtils || typeof dateUtils.isTradingDay !== 'function') {
            return candidate;
        }
        for (let offset = 0; offset <= 7; offset += 1) {
            const dateKey = offset === 0 ? candidate : dateKeyAtOffset(candidate, -offset);
            const isTrading = dateUtils.isTradingDay(dateKey, normalizedCalendarId || 'NYSE');
            if (isTrading === true) {
                return dateKey;
            }
            if (isTrading === null) {
                return dateKey;
            }
        }
        return candidate;
    }

    function officialSessionClosePolicy(calendarId, dateKey) {
        if (typeof globalScope.getOfficialExchangeCalendarDay !== 'function') {
            return null;
        }
        const info = globalScope.getOfficialExchangeCalendarDay(calendarId, dateKey);
        if (!info || info.available !== true || info.status === 'closed') {
            return null;
        }
        const detail = info.detail && typeof info.detail === 'object' ? info.detail : {};
        const timeZone = String(detail.timezone || (
            String(calendarId || '').toUpperCase() === 'NYSE'
                ? 'America/New_York'
                : 'America/Chicago'
        ));
        const rawClose = String(detail.optionCloseTime || detail.closeTime || '').trim();
        if (rawClose) {
            const match = rawClose.match(/^(\d{1,2}):(\d{2})$/);
            if (match) {
                return {
                    timeZone,
                    closeMinutes: Number(match[1]) * 60 + Number(match[2]),
                    source: 'official_early_close',
                };
            }
        }
        if (String(calendarId || '').toUpperCase() === 'NYSE') {
            return {
                timeZone: 'America/New_York',
                closeMinutes: NYSE_OPTION_CLOSE_MINUTES,
                source: 'nyse_option_close_policy',
            };
        }
        // The generated CME calendars currently prove trade dates, not each
        // product's option close time. Same-day CME/FOP action therefore
        // remains fail-closed; a later local date is unambiguously complete.
        return { timeZone, closeMinutes: null, source: 'close_time_unavailable' };
    }

    function evaluateSessionTimestamp(calendarId, sessionDate, timestamp) {
        const dateKey = normalizeDateKey(sessionDate);
        const policy = officialSessionClosePolicy(calendarId, dateKey);
        if (!dateKey || !policy) {
            return { status: 'calendar_unavailable' };
        }
        const local = localTimestampParts(timestamp, policy.timeZone);
        if (!local) {
            return { status: 'missing_timestamp' };
        }
        if (local.date < dateKey) {
            return { status: 'future', localDate: local.date };
        }
        if (local.date > dateKey) {
            return { status: 'complete', localDate: local.date, source: policy.source };
        }
        if (!Number.isFinite(policy.closeMinutes)) {
            return { status: 'close_time_unavailable', localDate: local.date };
        }
        return local.minuteOfDay >= policy.closeMinutes
            ? { status: 'complete', localDate: local.date, source: policy.source }
            : { status: 'pre_close', localDate: local.date, source: policy.source };
    }

    function resolveCardCalendarId(card) {
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        return String(profile && profile.calendarId || 'NYSE').toUpperCase();
    }

    function latestCompletedOfficialWeek(calendarId, nowValue) {
        const localDate = currentExchangeDate(calendarId, nowValue);
        const currentWeek = officialWeekFinalSession(calendarId, localDate);
        if (currentWeek.status !== 'ok') {
            return { status: 'calendar_unavailable', date: '' };
        }
        const currentCompletion = evaluateSessionTimestamp(calendarId, currentWeek.date, nowValue);
        if (currentCompletion.status === 'complete') {
            return { status: 'ok', date: currentWeek.date };
        }
        const previousWeekDate = dateKeyAtOffset(isoWeekMonday(localDate), -1);
        return officialWeekFinalSession(calendarId, previousWeekDate);
    }

    function evaluateWeeklySignalReadiness(card, nowValue = new Date(), context = {}) {
        const calendarId = resolveCardCalendarId(card);
        const anchorDate = normalizeDateKey(card && card.catalog && card.catalog.anchorDate);
        // Only the server-declared payload time is evidence. lastSyncLabel is
        // presentation state and must never turn client receipt time into an
        // actionable weekly close.
        const signalAsOf = String(card && card.catalog && card.catalog.payloadAsOf || '').trim();
        if (!anchorDate || !signalAsOf) {
            return { status: 'missing_snapshot', actionable: false, calendarId, anchorDate, signalAsOf };
        }
        const weekEnd = officialWeekFinalSession(calendarId, anchorDate);
        if (weekEnd.status !== 'ok') {
            return { status: 'calendar_unavailable', actionable: false, calendarId, anchorDate, signalAsOf };
        }
        if (anchorDate !== weekEnd.date) {
            return {
                status: 'partial_week', actionable: false, calendarId, anchorDate,
                signalAsOf, expectedSession: weekEnd.date,
            };
        }
        const completion = evaluateSessionTimestamp(calendarId, anchorDate, signalAsOf);
        if (completion.status !== 'complete') {
            return {
                status: completion.status, actionable: false, calendarId, anchorDate,
                signalAsOf, expectedSession: weekEnd.date,
            };
        }
        if (completion.localDate !== anchorDate) {
            return {
                status: 'off_session_snapshot', actionable: false, calendarId, anchorDate,
                signalAsOf, expectedSession: weekEnd.date,
            };
        }
        const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
        if (!Number.isFinite(now.getTime()) || Date.parse(signalAsOf) > now.getTime()) {
            return {
                status: 'future', actionable: false, calendarId, anchorDate,
                signalAsOf, expectedSession: weekEnd.date,
            };
        }
        const latestWeek = latestCompletedOfficialWeek(calendarId, now);
        if (latestWeek.status !== 'ok') {
            return {
                status: 'calendar_unavailable', actionable: false, calendarId, anchorDate,
                signalAsOf, expectedSession: '',
            };
        }
        if (anchorDate !== latestWeek.date) {
            return {
                status: 'stale_anchor', actionable: false, calendarId, anchorDate,
                signalAsOf, expectedSession: latestWeek.date,
            };
        }

        const coreApi = core();
        const detailRows = Array.isArray(context && context.detailRows)
            ? context.detailRows
            : buildDetailRows(card);
        const signal = context && context.signal
            ? context.signal
            : coreApi.computeRegimeSignal(detailRows);
        const coherence = typeof coreApi.evaluateSignalSnapshotCoherence === 'function'
            ? coreApi.evaluateSignalSnapshotCoherence(detailRows, signal, card && card.catalog)
            : { status: 'incoherent_snapshot', coherent: false };
        if (!coherence.coherent) {
            return {
                status: coherence.status, actionable: false, calendarId, anchorDate,
                signalAsOf, expectedSession: latestWeek.date, snapshotId: coherence.snapshotId || '',
            };
        }
        // The official close is observation time, after the regular entry
        // session. Until a separately backtested next-session execution rule
        // exists, a fully coherent close signal is complete but not executable.
        return {
            status: 'execution_protocol_unavailable', actionable: false, signalComplete: true,
            calendarId, anchorDate, signalAsOf, expectedSession: latestWeek.date,
            snapshotId: coherence.snapshotId,
        };
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

    function normalizeAutoHistoryDocument(rawDocument, symbol) {
        const normalized = normalizeHistoryDocument(rawDocument, symbol);
        return {
            symbol,
            version: 1,
            purpose: AUTO_HISTORY_PURPOSE,
            cadenceMinutes: AUTO_SAMPLE_INTERVAL_MS / 60000,
            samples: normalized.samples,
        };
    }

    // Manual history + hourly automatic file. The core is the sole authority
    // that reduces these raw observations to official weekly closes.
    function strategyHistoryDocument(card) {
        const manual = readOnlyHistoryDocument(card);
        const automatic = card && card.autoHistoryDocument
            ? normalizeAutoHistoryDocument(card.autoHistoryDocument, card.symbol)
            : normalizeAutoHistoryDocument(null, card && card.symbol);
        const merged = manual.samples.concat(automatic.samples);
        const sampleTime = (sample) => {
            const parsed = Date.parse(String(sample && sample.sampledAt || '').trim());
            return Number.isFinite(parsed) ? parsed : -Infinity;
        };
        merged.sort((a, b) => sampleTime(a) - sampleTime(b));
        return normalizeHistoryDocument({ samples: merged }, card.symbol);
    }

    function latestAutoSample(autoHistoryDocument) {
        const samples = autoHistoryDocument && Array.isArray(autoHistoryDocument.samples)
            ? autoHistoryDocument.samples
            : [];
        return samples.length ? samples[samples.length - 1] : null;
    }

    function shouldRunAutoSample(autoHistoryDocument, nowValue = new Date()) {
        const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
        if (!Number.isFinite(now.getTime())) {
            return false;
        }
        const latest = latestAutoSample(autoHistoryDocument);
        if (!latest) {
            return true;
        }
        const sampledAt = new Date(latest.sampledAt);
        if (!Number.isFinite(sampledAt.getTime())) {
            return true;
        }
        // Elapsed time is the only trigger. A "the UTC date changed" clause
        // would be redundant on every gap this already catches (including a
        // page closed for days) and would additionally fire a sample minutes
        // after the previous one whenever the UTC day rolled over mid-cadence
        // — 00:00 UTC is ~20:00 ET, which is not a boundary this sampler has
        // any reason to care about.
        return now.getTime() - sampledAt.getTime() >= AUTO_SAMPLE_INTERVAL_MS;
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
        return {
            targetRatio,
            targetPreset,
            tolerancePct,
            shortMinDte,
            shortMaxDte,
            sortBy: DEFAULT_CALENDAR_FINDER_CONFIG.sortBy,
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

    function normalizeFuturesContractMonth(value) {
        const normalized = String(value || '').trim().replace(/[^0-9]/g, '');
        return /^\d{6}$/.test(normalized) ? normalized : '';
    }

    function normalizeOptionStreamLimit(value) {
        const normalized = String(value == null ? '' : value).trim().toLowerCase();
        if (normalized === 'all' || normalized === '0') {
            return 0;
        }
        const parsed = parseInt(normalized, 10);
        return OPTION_STREAM_LIMIT_CHOICES.includes(parsed) && parsed > 0
            ? parsed
            : DEFAULT_MAX_OPTION_STREAMS;
    }

    function loadSavedOptionStreamLimit(symbol) {
        const key = String(symbol || '').trim().toUpperCase();
        if (!key) {
            return null;
        }
        try {
            const parsed = JSON.parse(localStorage.getItem(OPTION_STREAM_LIMIT_STORAGE_KEY) || '{}');
            if (!parsed || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, key)) {
                return null;
            }
            return normalizeOptionStreamLimit(parsed[key]);
        } catch (_) {
            return null;
        }
    }

    function saveOptionStreamLimit(symbol, value) {
        const key = String(symbol || '').trim().toUpperCase();
        if (!key) {
            return;
        }
        let store = {};
        try {
            const parsed = JSON.parse(localStorage.getItem(OPTION_STREAM_LIMIT_STORAGE_KEY) || '{}');
            if (parsed && typeof parsed === 'object') {
                store = parsed;
            }
        } catch (_) {
            // Start fresh when the saved blob is unreadable.
        }
        store[key] = normalizeOptionStreamLimit(value);
        try {
            localStorage.setItem(OPTION_STREAM_LIMIT_STORAGE_KEY, JSON.stringify(store));
        } catch (_) {
            // Runtime state still carries the selected limit when storage is unavailable.
        }
    }

    function normalizeTdIvLambda(value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return DEFAULT_TD_IV_LAMBDA;
        }
        return Math.min(1, Math.max(0, Math.round(parsed * 100) / 100));
    }

    const IMPLIED_LAMBDA_RATE_STORAGE_KEY = 'optionComboIvtsImpliedLambdaRate';
    const DEFAULT_IMPLIED_LAMBDA_RATE = 0.04;

    // Percent in the input, decimal in runtime/storage.
    function normalizeImpliedLambdaRatePct(value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return DEFAULT_IMPLIED_LAMBDA_RATE * 100;
        }
        return Math.min(25, Math.max(-5, Math.round(parsed * 100) / 100));
    }

    function loadSavedImpliedLambdaRate() {
        try {
            const raw = localStorage.getItem(IMPLIED_LAMBDA_RATE_STORAGE_KEY);
            if (raw == null || raw === '') {
                return null;
            }
            const parsed = parseFloat(raw);
            return Number.isFinite(parsed)
                ? normalizeImpliedLambdaRatePct(parsed * 100) / 100
                : null;
        } catch (_) {
            return null;
        }
    }

    function saveImpliedLambdaRate(rateDecimal) {
        try {
            localStorage.setItem(IMPLIED_LAMBDA_RATE_STORAGE_KEY, String(rateDecimal));
        } catch (_) {
            // Runtime state still carries the rate when storage is unavailable.
        }
    }

    function loadSavedTdIvLambda() {
        try {
            const raw = localStorage.getItem(TD_IV_LAMBDA_STORAGE_KEY);
            if (raw == null || raw === '') {
                return null;
            }
            const parsed = parseFloat(raw);
            return Number.isFinite(parsed) ? normalizeTdIvLambda(parsed) : null;
        } catch (_) {
            return null;
        }
    }

    function saveTdIvLambda(value) {
        try {
            localStorage.setItem(TD_IV_LAMBDA_STORAGE_KEY, String(normalizeTdIvLambda(value)));
        } catch (_) {
            // Runtime state still carries the selected lambda when storage is unavailable.
        }
    }

    function isFuturesOptionProfile(profile) {
        return !!(
            profile
            && String(profile.optionSecType || '').trim().toUpperCase() === 'FOP'
            && String(profile.underlyingSecType || '').trim().toUpperCase() === 'FUT'
        );
    }

    function resolveDefaultFuturesContractMonth(symbol, referenceDate) {
        const registry = productRegistry();
        if (registry && typeof registry.resolveDefaultUnderlyingContractMonth === 'function') {
            return normalizeFuturesContractMonth(
                registry.resolveDefaultUnderlyingContractMonth(symbol, referenceDate)
            );
        }
        return '';
    }

    function loadSavedFuturesContractMonth(symbol) {
        const key = String(symbol || '').trim().toUpperCase();
        if (!key) {
            return '';
        }
        try {
            const parsed = JSON.parse(localStorage.getItem(FUTURES_CONTRACT_MONTH_STORAGE_KEY) || '{}');
            return normalizeFuturesContractMonth(parsed && typeof parsed === 'object' ? parsed[key] : '');
        } catch (_) {
            return '';
        }
    }

    function saveFuturesContractMonth(symbol, contractMonth) {
        const key = String(symbol || '').trim().toUpperCase();
        if (!key) {
            return;
        }

        let store = {};
        try {
            const parsed = JSON.parse(localStorage.getItem(FUTURES_CONTRACT_MONTH_STORAGE_KEY) || '{}');
            if (parsed && typeof parsed === 'object') {
                store = parsed;
            }
        } catch (_) {
            // Start fresh when the saved blob is unreadable.
        }

        const normalized = normalizeFuturesContractMonth(contractMonth);
        if (normalized) {
            store[key] = normalized;
        } else {
            delete store[key];
        }

        try {
            localStorage.setItem(FUTURES_CONTRACT_MONTH_STORAGE_KEY, JSON.stringify(store));
        } catch (_) {
            // Runtime state still carries the chosen month when storage is unavailable.
        }
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
                    futuresContractMonth: normalizeFuturesContractMonth(
                        entry && typeof entry === 'object'
                            ? (entry.futuresContractMonth || entry.underlyingContractMonth || entry.contractMonth)
                            : ''
                    ),
                    maxOptionStreams: normalizeOptionStreamLimit(
                        entry && typeof entry === 'object' ? entry.maxOptionStreams : null
                    ),
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
        const profile = resolveProfile(entry.symbol);
        const isFop = isFuturesOptionProfile(profile);
        const today = currentExchangeDate(profile.calendarId || 'NYSE');
        const futuresContractMonth = isFop
            ? (
                normalizeFuturesContractMonth(entry.futuresContractMonth)
                || loadSavedFuturesContractMonth(entry.symbol)
                || resolveDefaultFuturesContractMonth(entry.symbol, today)
            )
            : '';
        const savedOptionStreamLimit = loadSavedOptionStreamLimit(entry.symbol);

        return {
            symbol: entry.symbol,
            historyPath: entry.historyPath,
            profile,
            futuresContractMonth,
            maxOptionStreams: savedOptionStreamLimit == null
                ? normalizeOptionStreamLimit(entry.maxOptionStreams)
                : savedOptionStreamLimit,
            isExpanded: options.isExpanded === true,
            statusMessage: isFop
                ? 'Ready. Choose the underlying futures month, then Sync/Update.'
                : 'Ready. Use Sync/Update to subscribe this ETF only.',
            statusKind: '',
            ws: null,
            wsOpenPromise: null,
            syncInProgress: false,
            sampleInProgress: false,
            autoSampleInProgress: false,
            autoFileSelectionInProgress: false,
            autoSamplingEnabled: false,
            autoHistoryDocument: null,
            autoFileHandle: null,
            autoFileName: '',
            autoSampleRetryAfter: 0,
            lastAutoSampleLabel: '',
            catalog: null,
            quotesBySubId: {},
            // Immutable, server-declared whole-curve snapshot used only by the
            // implied-lambda estimator. Incremental display quotes never mutate
            // this object.
            lambdaSnapshot: null,
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
            tradeDateResyncPending: false,
            impliedLambdaFingerprint: '',
            impliedLambdaPublishedSnapshotId: '',
            impliedLambdaPublicationResult: null,
            impliedLambdaComputedResult: null,
            impliedLambdaComputedEntry: null,
            impliedLambdaComputedAt: '',
            impliedLambdaNeedsRecalculation: false,
            varianceBestEffortEnabled: false,
            resumeAfterPageShow: false,
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

    function isFuturesContractMonthElement(element) {
        return !!(
            element
            && typeof element.matches === 'function'
            && element.matches('input[data-action="futures-contract-month"][data-symbol]')
        );
    }

    function isOptionStreamLimitElement(element) {
        return !!(
            element
            && typeof element.matches === 'function'
            && element.matches('select[data-action="option-stream-limit"][data-symbol]')
        );
    }

    function isFocusedCardControlInCard(cardNode) {
        const activeElement = document && document.activeElement;
        return !!(
            cardNode
            && (
                isBaselineSelectElement(activeElement)
                || isCalendarFinderControlElement(activeElement)
                || isFuturesContractMonthElement(activeElement)
                || isOptionStreamLimitElement(activeElement)
            )
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

    function serverPayloadAsOf(payload) {
        const value = String(payload && payload.payloadAsOf || '').trim();
        return Number.isFinite(Date.parse(value)) ? value : '';
    }

    function quoteWithServerSnapshotEvidence(quote, payload) {
        const source = quote && typeof quote === 'object' ? quote : {};
        const payloadAsOf = serverPayloadAsOf(payload);
        const payloadCanCertifyQuotes = payload && payload.coherent === true
            && payload.quoteComplete === true;
        const quoteAsOf = String(
            source.quoteAsOf || (payloadCanCertifyQuotes ? payloadAsOf : '') || ''
        ).trim();
        const snapshotId = String(
            source.snapshotId || source.batchId
            || (payloadCanCertifyQuotes && payload && (payload.snapshotId || payload.batchId))
            || ''
        ).trim();
        return {
            ...source,
            ...(quoteAsOf ? { quoteAsOf } : {}),
            ...(snapshotId ? { snapshotId } : {}),
        };
    }

    function withdrawImpliedLambda(card) {
        const handoff = typeof OptionComboImpliedLambdaHandoff !== 'undefined'
            ? OptionComboImpliedLambdaHandoff
            : null;
        if (!card || !handoff || typeof handoff.removeSymbolEntry !== 'function') {
            return false;
        }
        const expectedSnapshotId = String(card.impliedLambdaPublishedSnapshotId || '').trim();
        card.impliedLambdaFingerprint = '';
        if (!expectedSnapshotId) {
            // No ownership proof: this key may belong to another live IVTS
            // tab. Freshness validation will age out genuine orphan entries.
            return false;
        }
        const removed = handoff.removeSymbolEntry(
            card.symbol,
            undefined,
            card.futuresContractMonth || null,
            expectedSnapshotId
        );
        if (removed) {
            card.impliedLambdaPublishedSnapshotId = '';
        }
        return removed;
    }

    function evaluateLambdaSnapshotFreshness(snapshot, nowValue = Date.now()) {
        if (!snapshot || typeof snapshot !== 'object') {
            return { fresh: false, status: 'missing_snapshot', ageMs: null };
        }
        const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
        if (!Number.isFinite(nowMs)) {
            return { fresh: false, status: 'invalid_now', ageMs: null };
        }
        const quotes = [
            snapshot.underlyingQuote,
            ...Object.values(snapshot.quotesBySubId && typeof snapshot.quotesBySubId === 'object'
                ? snapshot.quotesBySubId
                : {}),
        ];
        const expectedOptionCount = parseInt(snapshot.expectedOptionCount, 10) || 0;
        if (!quotes[0] || quotes.length !== expectedOptionCount + 1) {
            return { fresh: false, status: 'incomplete_quote_set', ageMs: null };
        }
        const quoteTimes = quotes.map((quote) => Date.parse(String(quote && quote.quoteAsOf || '').trim()));
        if (quoteTimes.some((value) => !Number.isFinite(value))) {
            return { fresh: false, status: 'missing_quote_timestamp', ageMs: null };
        }
        const oldestQuoteMs = Math.min(...quoteTimes);
        const ageMs = nowMs - oldestQuoteMs;
        const configuredMaxSeconds = Number(snapshot.maxQuoteAgeSeconds);
        const maxAgeMs = (
            Number.isFinite(configuredMaxSeconds) && configuredMaxSeconds > 0
                ? configuredMaxSeconds
                : IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS
        ) * 1000;
        if (ageMs < -CLOCK_FUTURE_TOLERANCE_MS) {
            return { fresh: false, status: 'future_quote_timestamp', ageMs, maxAgeMs };
        }
        if (ageMs > maxAgeMs) {
            return { fresh: false, status: 'stale_quote_set', ageMs, maxAgeMs };
        }
        return { fresh: true, status: 'ok', ageMs, maxAgeMs };
    }

    function expireCardImpliedLambdaIfStale(card, nowValue = Date.now()) {
        // Compatibility hook retained for tests/extensions. Calculated lambda
        // is frozen until the user replaces or withdraws it; time alone never
        // expires it.
        void card;
        void nowValue;
        return false;
    }

    function applyCoherentQuoteSnapshot(card, payload, nowValue = new Date()) {
        if (!card || !card.catalog || !payload || typeof payload !== 'object') {
            return { ok: false, reason: 'missing_catalog' };
        }
        if (String(payload.symbol || '').trim().toUpperCase() !== card.symbol) {
            return { ok: false, reason: 'symbol_mismatch' };
        }
        const reject = (details) => {
            card.lambdaSnapshot = null;
            card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
            return { ok: false, ...details };
        };
        const snapshotId = String(payload.snapshotId || payload.batchId || '').trim();
        const payloadAsOf = serverPayloadAsOf(payload);
        if (payload.coherent !== true || payload.quoteComplete !== true
            || !snapshotId || !payloadAsOf) {
            return reject({
                reason: 'incomplete_snapshot',
                coherenceReason: String(payload.coherenceReason || '').trim(),
            });
        }

        const expectedContractMonth = normalizeFuturesContractMonth(card.futuresContractMonth);
        const snapshotContractMonth = normalizeFuturesContractMonth(payload.underlyingContractMonth);
        if (expectedContractMonth && snapshotContractMonth !== expectedContractMonth) {
            return reject({
                reason: 'underlying_contract_month_mismatch',
                expectedContractMonth,
                snapshotContractMonth,
            });
        }

        const profile = card.profile || resolveProfile(card.symbol);
        const anchorDate = normalizeDateKey(payload.anchorDate || card.catalog.anchorDate);
        const currentTradeDate = currentExchangeDate(profile.calendarId || 'NYSE', nowValue);
        if (!anchorDate || anchorDate !== currentTradeDate) {
            return reject({ reason: 'stale_anchor', anchorDate, currentTradeDate });
        }
        const underlyingSource = payload.underlyingQuote;
        const underlyingPrice = Number(payload.underlyingPrice);
        if (!underlyingSource || typeof underlyingSource !== 'object'
            || !(underlyingPrice > 0)
            || !Number.isFinite(Date.parse(String(underlyingSource.quoteAsOf || '').trim()))) {
            return reject({ reason: 'missing_underlying_quote' });
        }
        const underlyingQuote = quoteWithServerSnapshotEvidence(underlyingSource, payload);
        if (String(underlyingQuote.snapshotId || '').trim() !== snapshotId) {
            return reject({ reason: 'underlying_snapshot_mismatch' });
        }

        const optionSources = payload.options && typeof payload.options === 'object'
            ? payload.options
            : {};
        const expectedSubIds = [];
        for (const row of (Array.isArray(card.catalog.expiryRows) ? card.catalog.expiryRows : [])) {
            if (row && row.subscriptionSelected === false) {
                continue;
            }
            for (const subId of [row && row.atmCallSubId, row && row.atmPutSubId]) {
                const normalized = String(subId || '').trim();
                if (normalized) {
                    expectedSubIds.push(normalized);
                }
            }
        }
        if (!expectedSubIds.length || expectedSubIds.some((subId) => !optionSources[subId])) {
            return reject({ reason: 'missing_option_leg' });
        }

        const quotesBySubId = {};
        for (const subId of expectedSubIds) {
            const source = optionSources[subId];
            if (!source || typeof source !== 'object'
                || !Number.isFinite(Date.parse(String(source.quoteAsOf || '').trim()))) {
                return reject({ reason: 'missing_option_timestamp', subId });
            }
            const quote = quoteWithServerSnapshotEvidence(source, payload);
            if (String(quote.snapshotId || '').trim() !== snapshotId) {
                return reject({ reason: 'option_snapshot_mismatch', subId });
            }
            quotesBySubId[subId] = quote;
        }

        const expiryRows = (Array.isArray(card.catalog.expiryRows) ? card.catalog.expiryRows : [])
            .filter((row) => row && row.subscriptionSelected !== false)
            .map((row) => ({ ...row }));
        const snapshot = {
            snapshotId,
            batchId: String(payload.batchId || snapshotId).trim(),
            payloadAsOf,
            anchorDate,
            underlyingContractMonth: snapshotContractMonth || null,
            coherent: true,
            quoteComplete: true,
            coherenceReason: String(payload.coherenceReason || '').trim(),
            underlyingPrice,
            underlyingQuote: { ...underlyingQuote },
            expiryRows,
            quotesBySubId: Object.fromEntries(
                Object.entries(quotesBySubId).map(([subId, quote]) => [subId, { ...quote }])
            ),
            expectedOptionCount: expectedSubIds.length,
            actualOptionCount: Object.keys(quotesBySubId).length,
            maxQuoteAgeSeconds: Number.isFinite(Number(payload.maxQuoteAgeSeconds))
                ? Number(payload.maxQuoteAgeSeconds)
                : IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS,
        };
        card.lambdaSnapshot = snapshot;
        card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry
            && String(card.impliedLambdaComputedEntry.snapshotId || '').trim() !== snapshotId;
        // A whole-curve packet is also the safest visible quote refresh. Later
        // incremental packets may update the live table, but never this object.
        card.quotesBySubId = { ...quotesBySubId };
        updateUnderlyingPrice(card, underlyingPrice);
        card.catalog = {
            ...card.catalog,
            payloadAsOf,
            batchId: snapshot.batchId,
            snapshotId,
            coherent: true,
            quoteComplete: true,
            coherenceReason: snapshot.coherenceReason,
        };
        return { ok: true, snapshot };
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
        if (Number.isFinite(parseInt(payload.attemptedOptionCount, 10))) {
            card.catalog.attemptedOptionCount = parseInt(payload.attemptedOptionCount, 10);
            changed = true;
        }
        if (Number.isFinite(parseInt(payload.failedOptionCount, 10))) {
            card.catalog.failedOptionCount = parseInt(payload.failedOptionCount, 10);
            changed = true;
        }
        if (Number.isFinite(parseInt(payload.timedOutOptionCount, 10))) {
            card.catalog.timedOutOptionCount = parseInt(payload.timedOutOptionCount, 10);
            changed = true;
        }
        if (typeof payload.subscriptionErrorMessage === 'string') {
            card.catalog.subscriptionErrorMessage = payload.subscriptionErrorMessage;
            changed = true;
        }
        if (typeof payload.sharedAtmProbeTimedOut === 'boolean') {
            card.catalog.sharedAtmProbeTimedOut = payload.sharedAtmProbeTimedOut;
            changed = true;
        }
        if (typeof payload.subscriptionPending === 'boolean') {
            card.catalog.subscriptionPending = payload.subscriptionPending;
            changed = true;
        }

        return changed;
    }

    function buildSubscriptionStatus(payload, options = {}) {
        const data = payload && typeof payload === 'object' ? payload : {};
        const complete = options.complete === true;
        const resolvedCount = parseInt(data.resolvedExpiryCount, 10) || 0;
        const totalCount = parseInt(data.totalExpiryCount, 10) || 0;
        const expectedCount = parseInt(data.expectedOptionCount, 10) || 0;
        const attemptedCount = parseInt(data.attemptedOptionCount, 10) || 0;
        const subscribedCount = parseInt(data.subscribedOptionCount, 10) || 0;
        const parsedFailedCount = parseInt(data.failedOptionCount, 10);
        const failedCount = Number.isFinite(parsedFailedCount)
            ? parsedFailedCount
            : (complete ? Math.max(0, expectedCount - subscribedCount) : 0);
        const timedOutCount = parseInt(data.timedOutOptionCount, 10) || 0;
        const errorMessage = String(data.subscriptionErrorMessage || '').trim();
        const progressMessage = String(data.message || '').trim();

        if (errorMessage) {
            const summary = complete
                ? ` Sync finished: subscribed ${subscribedCount} of ${expectedCount}; ${failedCount} failed, ${timedOutCount} timed out.`
                : ` Subscription is still running: checked ${attemptedCount} of ${expectedCount}; subscribed ${subscribedCount}, failed ${failedCount}, timed out ${timedOutCount}.`;
            return { message: `${errorMessage}${summary}`, kind: 'error' };
        }

        if (complete) {
            if (failedCount > 0) {
                return {
                    message: `Subscribed ${subscribedCount} of ${expectedCount} option streams; ${failedCount} contracts failed. Check the server log for IB details.`,
                    kind: 'error',
                };
            }
            return {
                message: `Subscribed ${subscribedCount} of ${expectedCount} option streams. Waiting for live IV updates...`,
                kind: 'success',
            };
        }

        if (progressMessage) {
            return { message: progressMessage, kind: 'success' };
        }
        return {
            message: attemptedCount > 0
                ? `Resolved ${resolvedCount} of ${totalCount} expiries. Checked ${attemptedCount} of ${expectedCount} option contracts; subscribed ${subscribedCount}, failed ${failedCount}...`
                : `Resolved ${resolvedCount} of ${totalCount} expiries. Subscribed ${subscribedCount} of ${expectedCount} option streams...`,
            kind: 'success',
        };
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
        const futuresContractMonth = isFuturesOptionProfile(profile)
            ? normalizeFuturesContractMonth(card && card.futuresContractMonth)
            : '';
        const payload = {
            action: 'subscribe_iv_term_structure',
            clientProtocolVersion: IV_TERM_STRUCTURE_PROTOCOL_VERSION,
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
            anchorDate: currentExchangeDate(profile.calendarId || 'NYSE'),
            maxDte: runtime.config ? runtime.config.maxDte : EMBEDDED_DEFAULT_CONFIG.maxDte,
            strikeRadius: runtime.config ? runtime.config.strikeRadius : EMBEDDED_DEFAULT_CONFIG.strikeRadius,
            maxOptionStreams: normalizeOptionStreamLimit(card && card.maxOptionStreams),
        };

        if (futuresContractMonth) {
            payload.underlying.contractMonth = futuresContractMonth;
            payload.underlying.multiplier = String(profile.underlyingLegMultiplier || profile.optionMultiplier || '');
            payload.optionTemplate.underlyingContractMonth = futuresContractMonth;
            payload.optionTemplate.underlyingCurrency = profile.currency || 'USD';
            payload.optionTemplate.underlyingMultiplier = String(profile.underlyingLegMultiplier || profile.optionMultiplier || '');
        }

        return payload;
    }

    function clearPendingCatalogTimers(pending) {
        if (!pending) {
            return;
        }
        clearTimeout(pending.timeoutId);
        clearTimeout(pending.ackTimeoutId);
        pending.timeoutId = null;
        pending.ackTimeoutId = null;
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

            if (payload && payload.action === 'iv_term_structure_sync_started') {
                if (String(payload.symbol || '').trim().toUpperCase() !== card.symbol) {
                    return;
                }
                const serverProtocolVersion = String(payload.protocolVersion || '').trim();
                const pending = card.pendingCatalog;
                if (pending) {
                    clearTimeout(pending.ackTimeoutId);
                    pending.ackTimeoutId = null;
                    pending.serverAcknowledged = true;
                    if (serverProtocolVersion !== IV_TERM_STRUCTURE_PROTOCOL_VERSION) {
                        card.pendingCatalog = null;
                        clearPendingCatalogTimers(pending);
                        pending.reject(new Error(
                            `IVTS backend protocol mismatch (browser ${IV_TERM_STRUCTURE_PROTOCOL_VERSION}, server ${serverProtocolVersion || 'missing'}). Rebuild and restart the remote backend.`
                        ));
                        return;
                    }
                }
                setCardStatus(
                    card,
                    `Remote backend acknowledged IVTS protocol ${serverProtocolVersion}. Resolving contracts...`,
                    ''
                );
                render();
                return;
            }

            if (payload && payload.action === 'iv_term_structure_snapshot') {
                if (String(payload.symbol || '').trim().toUpperCase() !== card.symbol) {
                    return;
                }
                const payloadAsOf = serverPayloadAsOf(payload);
                card.catalog = { ...payload, payloadAsOf };
                card.quotesBySubId = {};
                card.lambdaSnapshot = null;
                card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
                if (payload.options && typeof payload.options === 'object') {
                    Object.entries(payload.options).forEach(([subId, quote]) => {
                        card.quotesBySubId[subId] = quoteWithServerSnapshotEvidence(quote, payload);
                    });
                }
                card.catalogPatchCount = 0;
                armCatalogPatchWatchdog(card);
                updateUnderlyingPrice(card, payload && payload.underlyingPrice);
                const resolvedFuturesContractMonth = normalizeFuturesContractMonth(payload.underlyingContractMonth);
                if (resolvedFuturesContractMonth && resolvedFuturesContractMonth !== card.futuresContractMonth) {
                    card.futuresContractMonth = resolvedFuturesContractMonth;
                    saveFuturesContractMonth(card.symbol, resolvedFuturesContractMonth);
                    card.forceBodyRefreshOnce = true;
                }
                card.lastSyncLabel = payloadAsOf;
                setCardStatus(
                    card,
                    payload.warning
                        || String(payload.message || '').trim()
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
                    clearPendingCatalogTimers(pending);
                    pending.resolve(payload);
                }
                render();
                return;
            }

            if (payload && payload.action === 'iv_term_structure_quote_snapshot') {
                const applied = applyCoherentQuoteSnapshot(card, payload);
                if (!applied.ok) {
                    updateUnderlyingPrice(card, payload && payload.underlyingPrice);
                    if (payload.options && typeof payload.options === 'object') {
                        Object.entries(payload.options).forEach(([subId, quote]) => {
                            card.quotesBySubId[subId] = quoteWithServerSnapshotEvidence(quote, payload);
                        });
                    }
                    if (applied.reason === 'stale_anchor' && !card.tradeDateResyncPending) {
                        card.tradeDateResyncPending = true;
                        setCardStatus(
                            card,
                            `Exchange trade date rolled from ${applied.anchorDate || '--'} to ${applied.currentTradeDate || '--'}. Resyncing the curve...`,
                            ''
                        );
                        setTimeout(async () => {
                            try {
                                await syncCard(card);
                            } catch (error) {
                                setCardStatus(card, error.message || 'Trade-date resync failed.', 'error');
                                render(true);
                            } finally {
                                card.tradeDateResyncPending = false;
                            }
                        }, 0);
                    } else if (!card.syncInProgress && !card.impliedLambdaComputedEntry) {
                        const fallback = buildBestEffortLambdaSnapshot(card);
                        const message = fallback.ok
                            ? `Strict snapshot incomplete (${applied.coherenceReason || applied.reason}); best-effort calculation is ready from ${fallback.usableExpiryCount} complete expiries.`
                            : `Collecting usable option pairs for implied λ: ${applied.coherenceReason || applied.reason}.`;
                        if (card.statusMessage !== message || card.statusKind !== '') {
                            setCardStatus(card, message, '');
                        }
                    }
                    // Incomplete server snapshots may repeat while TWS fills
                    // receipt evidence. Merge their usable BBOs, but do not
                    // force a synchronous full-card redraw for every packet.
                    render();
                    return;
                }
                card.lastSyncLabel = applied.snapshot.payloadAsOf;
                if (!card.impliedLambdaComputedEntry
                    && /^(?:Strict snapshot incomplete|Collecting usable option pairs)/.test(
                        String(card.statusMessage || '')
                    )) {
                    setCardStatus(
                        card,
                        `Strict coherent quote snapshot ready (${applied.snapshot.actualOptionCount} option legs). Press Calculate λ when you want to freeze it.`,
                        'success'
                    );
                }
                render();
                return;
            }

            if (payload && payload.action === 'api_market_data_subscriptions_reset') {
                handleApiMarketDataReset(payload);
                return;
            }

            if (payload && payload.action === 'iv_term_structure_catalog_patch') {
                if (String(payload.symbol || '').trim().toUpperCase() !== card.symbol) {
                    return;
                }
                if (mergeCatalogPatch(card, payload)) {
                    card.catalogPatchCount += 1;
                    clearCatalogPatchWatchdog(card);
                    const totalCount = parseInt(payload.totalExpiryCount, 10) || (card.catalog && Array.isArray(card.catalog.expiryRows) ? card.catalog.expiryRows.length : 0);
                    const expectedCount = parseInt(payload.expectedOptionCount, 10) || 0;
                    const status = buildSubscriptionStatus({
                        ...payload,
                        totalExpiryCount: parseInt(payload.totalExpiryCount, 10) || totalCount,
                        expectedOptionCount: expectedCount,
                    });
                    setCardStatus(
                        card,
                        status.message,
                        status.kind
                    );
                    render();
                }
                return;
            }

            if (payload && payload.action === 'iv_term_structure_sync_complete') {
                if (String(payload.symbol || '').trim().toUpperCase() !== card.symbol) {
                    return;
                }
                const status = buildSubscriptionStatus(payload, { complete: true });
                const publication = card.impliedLambdaPublicationResult;
                const currentSnapshotId = String(
                    card.lambdaSnapshot && card.lambdaSnapshot.snapshotId || ''
                ).trim();
                const publicationMatches = publication
                    && String(publication.snapshotId || '').trim() === currentSnapshotId;
                if (publicationMatches) {
                    const combinedMessage = status.kind === 'error'
                        ? `${publication.message} ${status.message}`.trim()
                        : publication.message;
                    setCardStatus(
                        card,
                        combinedMessage,
                        publication.ok === true && status.kind !== 'error' ? 'success' : 'error'
                    );
                } else {
                    setCardStatus(card, status.message, status.kind);
                }
                render();
                return;
            }

            if (payload && payload.action === 'iv_term_structure_error') {
                if (String(payload.symbol || '').trim().toUpperCase() === card.symbol || !payload.symbol) {
                    card.lambdaSnapshot = null;
                    card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
                    setCardStatus(card, payload.message || 'IV term structure sync failed.', 'error');
                    if (card.pendingCatalog) {
                        const pending = card.pendingCatalog;
                        card.pendingCatalog = null;
                        clearPendingCatalogTimers(pending);
                        pending.reject(new Error(payload.message || 'IV term structure sync failed.'));
                    }
                    render();
                }
                return;
            }

            updateUnderlyingPrice(card, payload && payload.underlyingPrice);

            if (payload && payload.options && typeof payload.options === 'object') {
                Object.entries(payload.options).forEach(([subId, quote]) => {
                    card.quotesBySubId[subId] = quoteWithServerSnapshotEvidence(quote, payload);
                });
                card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
                // A changed-ticker packet is partial by construction. It may
                // update individual quote evidence, but it cannot advance the
                // catalog's coherent whole-curve payloadAsOf.
                render();
            }
        });

        ws.addEventListener('close', () => {
            if (card.ws !== ws) {
                return;
            }

            clearCatalogPatchWatchdog(card);
            card.lambdaSnapshot = null;
            card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
            card.ws = null;
            card.wsOpenPromise = null;
            if (card.pendingCatalog) {
                const pending = card.pendingCatalog;
                card.pendingCatalog = null;
                clearPendingCatalogTimers(pending);
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
            ws.send(JSON.stringify({ action: 'request_discount_curve' }));
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
            } else if (payload && payload.action === 'discount_curve_snapshot') {
                applyDiscountCurveSnapshot(payload);
                render(true);
            } else if (payload && payload.action === 'api_market_data_subscriptions_reset') {
                handleApiMarketDataReset(payload);
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
            runtime.discountCurveLastError = 'Control socket disconnected; retaining the last usable curve.';
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
            runtime.discountCurveLastError = 'Unable to refresh the unified daily discount curve.';
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

    async function requestDiscountCurveSnapshot() {
        try {
            const ws = await ensureControlSocket();
            ws.send(JSON.stringify({ action: 'request_discount_curve' }));
            return true;
        } catch (error) {
            runtime.discountCurveLastError = String(
                error && error.message || 'Unable to request the unified daily discount curve.'
            ).trim();
            render(true);
            return false;
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

    async function resetAllApiMarketDataSubscriptionsFromPage() {
        const confirmed = globalScope.confirm(
            'Clear every market-data subscription on this backend\'s current TWS API connection?\n\n'
            + 'This affects every open page and session using the backend. The API client will reconnect with zero streams, and every page must subscribe again. Open orders will not be cancelled.\n\n'
            + 'Running managed-order supervision will lose its live quotes during the reset and may require manual intervention.'
        );
        if (!confirmed) {
            return;
        }

        runtime.apiResetInProgress = true;
        runtime.ibStatus = {
            connected: false,
            connecting: true,
            message: 'Clearing all API market-data subscriptions...',
        };
        render(true);
        try {
            const ws = await ensureControlSocket();
            ws.send(JSON.stringify({
                action: 'reset_api_market_data_subscriptions',
                confirmed: true,
            }));
        } catch (error) {
            runtime.apiResetInProgress = false;
            runtime.ibStatus = {
                connected: false,
                connecting: false,
                message: error.message || 'Unable to request the API subscription reset.',
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
                clearPendingCatalogTimers(pending);
                if (typeof pending.reject === 'function') {
                    pending.reject(new Error('Socket target changed.'));
                }
            }
            card.closeNotice = '';
            card.lambdaSnapshot = null;
            card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
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
                    if (entry && entry.subscriptionSelected === false) {
                        return true;
                    }
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
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        if (isFuturesOptionProfile(profile) && !normalizeFuturesContractMonth(card && card.futuresContractMonth)) {
            throw new Error(`Enter the ${profile.underlyingSymbol || card.symbol} underlying futures month as YYYYMM before syncing.`);
        }

        card.lambdaSnapshot = null;
        card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
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
                const pending = {
                    resolve,
                    reject,
                    timeoutId: null,
                    ackTimeoutId: null,
                    serverAcknowledged: false,
                };
                pending.timeoutId = setTimeout(() => {
                    if (card.pendingCatalog !== pending) {
                        return;
                    }
                    card.pendingCatalog = null;
                    clearPendingCatalogTimers(pending);
                    reject(new Error('Timed out while waiting for the IV term structure snapshot.'));
                }, IV_TERM_STRUCTURE_SNAPSHOT_TIMEOUT_MS);
                pending.ackTimeoutId = setTimeout(() => {
                    if (card.pendingCatalog !== pending || pending.serverAcknowledged) {
                        return;
                    }
                    card.pendingCatalog = null;
                    clearPendingCatalogTimers(pending);
                    reject(new Error(
                        `Remote backend did not acknowledge subscribe_iv_term_structure within ${IV_TERM_STRUCTURE_ACK_TIMEOUT_MS / 1000}s. The WebSocket endpoint is running an older/different backend; rebuild and restart it, then verify the IVTS WS host and port.`
                    ));
                }, IV_TERM_STRUCTURE_ACK_TIMEOUT_MS);
                card.pendingCatalog = pending;
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
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        return core().buildExpiryDetailRows(
            snapshot,
            card.quotesBySubId,
            card.catalog && card.catalog.anchorDate,
            normalizeTdIvLambda(runtime.tdIvWeekendWeight),
            profile.calendarId || 'NYSE'
        );
    }

    function buildLambdaDetailRows(card) {
        const snapshot = card && card.lambdaSnapshot;
        return buildLambdaDetailRowsFromSnapshot(card, snapshot);
    }

    function buildLambdaDetailRowsFromSnapshot(card, snapshot) {
        if (!snapshot || !Array.isArray(snapshot.expiryRows)) {
            return [];
        }
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        return core().buildExpiryDetailRows(
            snapshot.expiryRows,
            snapshot.quotesBySubId,
            snapshot.anchorDate,
            normalizeTdIvLambda(runtime.tdIvWeekendWeight),
            profile.calendarId || 'NYSE'
        );
    }

    // card.quotesBySubId is a live incremental map: per-ticker packets write
    // into it at arbitrary times and it deliberately survives a socket close,
    // so a quote found there proves nothing about when it was observed. Every
    // manual route that reads the map must therefore establish recency from
    // the quote's own timestamp before using it. A quote that cannot prove
    // when it was taken is unusable, never assumed current.
    function inspectQuoteRecency(quoteAsOfValue, nowValue, maxAgeSeconds) {
        const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
        if (!Number.isFinite(nowMs)) {
            return { usable: false, reason: 'invalid_now', quoteAsOf: '', quoteMs: null };
        }
        const raw = String(quoteAsOfValue || '').trim();
        const quoteMs = Date.parse(raw);
        if (!raw || !Number.isFinite(quoteMs)) {
            return { usable: false, reason: 'missing_quote_timestamp', quoteAsOf: '', quoteMs: null };
        }
        const ageMs = nowMs - quoteMs;
        if (ageMs < -CLOCK_FUTURE_TOLERANCE_MS) {
            return { usable: false, reason: 'future_quote_timestamp', quoteAsOf: raw, quoteMs, ageMs };
        }
        const configured = Number(maxAgeSeconds);
        const maxAgeMs = (
            Number.isFinite(configured) && configured > 0
                ? configured
                : IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS
        ) * 1000;
        if (ageMs > maxAgeMs) {
            return { usable: false, reason: 'stale_quote', quoteAsOf: raw, quoteMs, ageMs, maxAgeMs };
        }
        return {
            usable: true,
            reason: '',
            quoteAsOf: new Date(quoteMs).toISOString(),
            quoteMs,
            ageMs,
            maxAgeMs,
        };
    }

    // Measure, rather than assert, whether a set of separately observed quotes
    // can honestly be published as one coherent observation.
    function measureQuoteCoherence(quoteMsValues, maxSkewSeconds) {
        const values = (Array.isArray(quoteMsValues) ? quoteMsValues : [])
            .filter((value) => Number.isFinite(value));
        if (!values.length) {
            return { coherent: false, reason: 'no_quote_timestamps', skewMs: null, oldestMs: null, newestMs: null };
        }
        const oldestMs = Math.min(...values);
        const newestMs = Math.max(...values);
        const skewMs = newestMs - oldestMs;
        const configured = Number(maxSkewSeconds);
        const maxSkewMs = (
            Number.isFinite(configured) && configured > 0
                ? configured
                : IMPLIED_LAMBDA_MAX_QUOTE_SKEW_SECONDS
        ) * 1000;
        if (skewMs > maxSkewMs) {
            return { coherent: false, reason: 'quote_skew_exceeded', skewMs, maxSkewMs, oldestMs, newestMs };
        }
        return { coherent: true, reason: '', skewMs, maxSkewMs, oldestMs, newestMs };
    }

    function inspectBestEffortOptionQuote(
        quote,
        expectedContractMonth = '',
        nowValue = Date.now(),
        maxAgeSeconds = IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS
    ) {
        const source = quote && typeof quote === 'object' ? quote : null;
        if (!source) {
            return { usable: false, reason: 'missing_quote' };
        }
        const bid = Number(source.bid);
        const ask = Number(source.ask);
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0) {
            return { usable: false, reason: 'missing_bbo' };
        }
        if (ask < bid) {
            return { usable: false, reason: 'crossed_market' };
        }
        const expectedMonth = normalizeFuturesContractMonth(expectedContractMonth);
        const actualMonth = normalizeFuturesContractMonth(source.underlyingContractMonth);
        if (expectedMonth && actualMonth && actualMonth !== expectedMonth) {
            return { usable: false, reason: 'underlying_contract_month_mismatch' };
        }
        if (expectedMonth && source.underlyingBindingVerified === false) {
            return { usable: false, reason: 'underlying_binding_rejected' };
        }
        const recency = inspectQuoteRecency(
            source.quoteAsOf || source.payloadAsOf,
            nowValue,
            maxAgeSeconds
        );
        if (!recency.usable) {
            return { usable: false, reason: recency.reason };
        }
        return {
            usable: true,
            bid,
            ask,
            mark: (bid + ask) / 2,
            quoteAsOf: recency.quoteAsOf,
            quoteMs: recency.quoteMs,
        };
    }

    // TWS does not guarantee that every cached BBO arrives with a usable
    // receipt timestamp in the same callback.  A manual Calculate action may
    // therefore take an atomic browser-side observation of the complete pairs
    // that are actually available, skip bad rows, and solve a clearly marked
    // best-effort surface instead of rejecting the whole subscription set.
    function buildBestEffortLambdaSnapshot(card, nowValue = Date.now()) {
        const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
        const catalog = card && card.catalog;
        const rows = catalog && Array.isArray(catalog.expiryRows)
            ? catalog.expiryRows.filter((row) => row && row.subscriptionSelected !== false)
            : [];
        const underlyingPrice = Number(card && card.underlyingPrice);
        const anchorDate = normalizeDateKey(catalog && catalog.anchorDate);
        if (!Number.isFinite(nowMs) || !rows.length || !(underlyingPrice > 0) || !anchorDate) {
            return {
                ok: false,
                reason: 'catalog_or_underlying_unavailable',
                snapshot: null,
                usableExpiryCount: 0,
                skippedExpiryCount: rows.length,
            };
        }

        const observedAt = new Date(nowMs).toISOString();
        const snapshotId = `best-effort-${String(card.symbol || 'unknown').toLowerCase()}-${nowMs}`;
        const expectedMonth = normalizeFuturesContractMonth(card.futuresContractMonth);
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        const dateUtils = globalScope.OptionComboDateUtils;
        const quotesBySubId = {};
        const usableRows = [];
        const skippedRows = [];
        const acceptedQuoteMs = [];
        for (const row of rows) {
            const callSubId = String(row && row.atmCallSubId || '').trim();
            const putSubId = String(row && row.atmPutSubId || '').trim();
            const callCheck = inspectBestEffortOptionQuote(
                callSubId && card.quotesBySubId && card.quotesBySubId[callSubId],
                expectedMonth,
                nowMs,
                IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS
            );
            const putCheck = inspectBestEffortOptionQuote(
                putSubId && card.quotesBySubId && card.quotesBySubId[putSubId],
                expectedMonth,
                nowMs,
                IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS
            );
            if (!callSubId || !putSubId || !callCheck.usable || !putCheck.usable) {
                skippedRows.push({
                    expiry: String(row && row.expiry || '').trim(),
                    callReason: callSubId ? callCheck.reason : 'missing_subscription_id',
                    putReason: putSubId ? putCheck.reason : 'missing_subscription_id',
                });
                continue;
            }
            const expiryDate = normalizeDateKey(row && row.expiry);
            const profileCutoff = expiryDate && dateUtils
                && typeof dateUtils.resolveExpiryCutoffAsOf === 'function'
                ? dateUtils.resolveExpiryCutoffAsOf(
                    { expDate: expiryDate }, profile, expiryDate
                )
                : null;
            const stampQuote = (source, checked) => {
                const existingExpiry = String(source && source.expiryAsOf || '').trim();
                const existingExpiryMs = Date.parse(existingExpiry);
                const expiryAsOf = Number.isFinite(existingExpiryMs)
                    ? new Date(existingExpiryMs).toISOString()
                    : (profileCutoff && profileCutoff.cutoffAsOf || '');
                return {
                    ...source,
                    bid: checked.bid,
                    ask: checked.ask,
                    mark: checked.mark,
                    bidPresent: true,
                    askPresent: true,
                    bidAskValid: true,
                    bidAskStatus: 'two_sided',
                    markSource: 'bid_ask_mid',
                    // The true time the venue stamped this quote. The manual
                    // Calculate action is an atomic browser-side *observation*
                    // of quotes that were taken earlier, so that observation
                    // time is carried separately: overwriting quoteAsOf here
                    // would erase the staleness that freshness checks and
                    // cross-tab ownership arbitration both read.
                    quoteAsOf: checked.quoteAsOf,
                    observedAt,
                    batchId: snapshotId,
                    snapshotId,
                    expiryAsOf,
                    expiryTimeSource: Number.isFinite(existingExpiryMs)
                        ? 'contract'
                        : (profileCutoff && profileCutoff.source || 'date-only'),
                };
            };
            quotesBySubId[callSubId] = stampQuote(card.quotesBySubId[callSubId], callCheck);
            quotesBySubId[putSubId] = stampQuote(card.quotesBySubId[putSubId], putCheck);
            acceptedQuoteMs.push(callCheck.quoteMs, putCheck.quoteMs);
            usableRows.push({ ...row });
        }

        if (usableRows.length < 2) {
            return {
                ok: false,
                reason: 'insufficient_complete_expiry_pairs',
                snapshot: null,
                usableExpiryCount: usableRows.length,
                skippedExpiryCount: skippedRows.length,
                skippedRows,
            };
        }
        // Coherence is measured from the accepted quotes' own timestamps. A
        // set assembled out of the incremental map across a wide interval is
        // reported incoherent and rejected downstream, rather than published
        // as one observation it never was.
        const coherence = measureQuoteCoherence(
            acceptedQuoteMs,
            IMPLIED_LAMBDA_MAX_QUOTE_SKEW_SECONDS
        );
        const oldestQuoteAsOf = Number.isFinite(coherence.oldestMs)
            ? new Date(coherence.oldestMs).toISOString()
            : '';
        // quoteComplete describes the surface actually published: every leg
        // carried here was verified two-sided and timestamped. Expiries that
        // failed inspection are excluded and reported through
        // skippedExpiryCount, which is the route's labelled degradation.
        const quoteComplete = usableRows.length > 0
            && acceptedQuoteMs.length === usableRows.length * 2
            && acceptedQuoteMs.every((value) => Number.isFinite(value));
        return {
            ok: true,
            reason: '',
            usableExpiryCount: usableRows.length,
            skippedExpiryCount: skippedRows.length,
            skippedRows,
            quoteSkewMs: coherence.skewMs,
            snapshot: {
                snapshotId,
                batchId: snapshotId,
                payloadAsOf: observedAt,
                observedAt,
                // Freshness is judged on the oldest leg actually used, never
                // on the moment the user pressed Calculate.
                quoteAsOf: oldestQuoteAsOf,
                quoteSkewMs: coherence.skewMs,
                anchorDate,
                underlyingContractMonth: expectedMonth || null,
                coherent: coherence.coherent === true,
                quoteComplete,
                coherenceReason: coherence.coherent
                    ? 'manual_best_effort_current_bbo'
                    : coherence.reason,
                estimationMode: 'best_effort',
                underlyingPrice,
                underlyingQuote: {
                    mark: underlyingPrice,
                    markSource: 'manual_atomic_observation',
                    quoteAsOf: oldestQuoteAsOf,
                    observedAt,
                    batchId: snapshotId,
                    snapshotId,
                },
                expiryRows: usableRows,
                quotesBySubId,
                expectedOptionCount: usableRows.length * 2,
                actualOptionCount: Object.keys(quotesBySubId).length,
                sourceExpectedExpiryCount: rows.length,
                skippedRows,
                maxQuoteAgeSeconds: IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS,
            },
        };
    }

    // Last-resort manual estimator for the common TWS failure mode where
    // model IV arrives for both ATM legs but one or both real BBOs never do.
    // This is intentionally lower quality than the straddle-price routes and
    // is carried through V2 with explicit vendor-IV provenance.
    function buildVendorIvLambdaSource(card, nowValue = Date.now()) {
        const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
        const catalogExpiryCount = card && card.catalog && Array.isArray(card.catalog.expiryRows)
            ? card.catalog.expiryRows.length
            : 0;
        const anchorDate = normalizeDateKey(card && card.catalog && card.catalog.anchorDate);
        const ivComplete = buildDetailRows(card).filter((row) => (
            row && row.subscriptionSelected !== false
            && Number.isFinite(row.callIv) && row.callIv > 0
            && Number.isFinite(row.putIv) && row.putIv > 0
            && Number.isFinite(row.atmIv) && row.atmIv > 0
        ));
        // Vendor IV is read straight out of the live incremental quote map,
        // so a positive IV alone proves nothing about when it was published.
        // Each leg must carry its own fresh timestamp before the row is used.
        const detailRows = [];
        const skippedRows = [];
        const acceptedQuoteMs = [];
        for (const row of ivComplete) {
            const callRecency = inspectQuoteRecency(
                row.callQuoteAsOf, nowMs, IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS
            );
            const putRecency = inspectQuoteRecency(
                row.putQuoteAsOf, nowMs, IMPLIED_LAMBDA_DEFAULT_MAX_QUOTE_AGE_SECONDS
            );
            if (!callRecency.usable || !putRecency.usable) {
                skippedRows.push({
                    expiry: String(row && row.expiry || '').trim(),
                    callReason: callRecency.reason,
                    putReason: putRecency.reason,
                });
                continue;
            }
            acceptedQuoteMs.push(callRecency.quoteMs, putRecency.quoteMs);
            detailRows.push(row);
        }
        const skippedExpiryCount = Math.max(0, catalogExpiryCount - detailRows.length);
        if (!Number.isFinite(nowMs) || !anchorDate || detailRows.length < 2) {
            return {
                ok: false,
                reason: skippedRows.length && detailRows.length < 2
                    ? 'insufficient_fresh_vendor_iv_pairs'
                    : 'insufficient_complete_vendor_iv_pairs',
                snapshot: null,
                detailRows,
                skippedRows,
                usableExpiryCount: detailRows.length,
                skippedExpiryCount,
            };
        }
        const coherence = measureQuoteCoherence(
            acceptedQuoteMs,
            IMPLIED_LAMBDA_MAX_QUOTE_SKEW_SECONDS
        );
        const observedAt = new Date(nowMs).toISOString();
        const oldestQuoteAsOf = Number.isFinite(coherence.oldestMs)
            ? new Date(coherence.oldestMs).toISOString()
            : '';
        const snapshotId = `vendor-iv-${String(card.symbol || 'unknown').toLowerCase()}-${nowMs}`;
        return {
            ok: true,
            reason: '',
            detailRows,
            skippedRows,
            usableExpiryCount: detailRows.length,
            skippedExpiryCount,
            quoteSkewMs: coherence.skewMs,
            snapshot: {
                snapshotId,
                batchId: snapshotId,
                payloadAsOf: observedAt,
                observedAt,
                // The oldest vendor leg actually used, not the moment the
                // user pressed Calculate. Front and back expiries routinely
                // arrive hours apart; stamping them with one synthetic
                // timestamp would hide exactly that.
                quoteAsOf: oldestQuoteAsOf,
                quoteSkewMs: coherence.skewMs,
                anchorDate,
                underlyingContractMonth: normalizeFuturesContractMonth(
                    card && card.futuresContractMonth
                ) || null,
                coherent: coherence.coherent === true,
                coherenceReason: coherence.coherent
                    ? 'manual_vendor_iv_observation'
                    : coherence.reason,
                quoteComplete: detailRows.length > 0
                    && acceptedQuoteMs.length === detailRows.length * 2
                    && acceptedQuoteMs.every((value) => Number.isFinite(value)),
                estimationMode: 'best_effort',
                sourceQuoteEvidence: 'vendor_atm_iv_fallback',
            },
        };
    }

    function computeImpliedLambdaFromVendorIv(card, source) {
        if (!card || !source || source.ok !== true || !source.snapshot) {
            return null;
        }
        const profile = card.profile || resolveProfile(card.symbol);
        const snapshot = source.snapshot;
        const result = core().computeImpliedWeekendLambdas(
            source.detailRows,
            snapshot.anchorDate,
            {
                varianceSource: 'vendor_iv',
                estimationMode: 'best_effort',
                sourceQuoteEvidence: 'vendor_atm_iv_fallback',
                calendarKey: profile.calendarId || 'NYSE',
                pricingModel: profile.pricingModel === 'black76' ? 'black76' : 'bsm-spot',
                underlyingQuoteIsForward: String(profile.underlyingSecType || '').toUpperCase() === 'FUT',
                timeZone: profile.optionExpiryTimeZone,
                tradeDateRolloverHour: /^(?:CME|NYMEX|COMEX):/.test(
                    String(profile.calendarId || '').toUpperCase()
                ) ? 17 : null,
                snapshotMetadata: {
                    snapshotId: snapshot.snapshotId,
                    underlyingSnapshotId: snapshot.snapshotId,
                    // Reported from what buildVendorIvLambdaSource measured.
                    // A surface whose legs were observed too far apart fails
                    // the downstream quality gate instead of asserting its
                    // way past it.
                    coherent: snapshot.coherent === true,
                    quoteComplete: snapshot.quoteComplete === true,
                    payloadAsOf: snapshot.payloadAsOf,
                    quoteAsOf: snapshot.quoteAsOf || snapshot.payloadAsOf,
                    underlyingQuoteAsOf: snapshot.quoteAsOf || snapshot.payloadAsOf,
                },
            }
        );
        result.methodology = {
            ...(result.methodology || {}),
            estimationMode: 'best_effort',
            sourceQuoteEvidence: 'vendor_atm_iv_fallback',
        };
        result.quality = {
            ...(result.quality || {}),
            estimationMode: 'best_effort',
            strictSnapshot: false,
            sourceQuoteEvidence: 'vendor_atm_iv_fallback',
            sourceExpectedExpiryCount: source.usableExpiryCount + source.skippedExpiryCount,
            usableExpiryCount: source.usableExpiryCount,
            skippedExpiryCount: source.skippedExpiryCount,
        };
        return result;
    }

    function resolveSelectedStraddleBaselineExpiry(card, detailRows) {
        const rows = Array.isArray(detailRows) ? detailRows : [];
        const selected = normalizeExpiryKey(card && card.straddleBaselineExpiry);
        if (selected && rows.some((row) => normalizeExpiryKey(row && row.expiry) === selected)) {
            return selected;
        }
        // Default baseline: the usable expiry nearest 7 DTE (the playbook
        // front leg), so the Vs Base and TD Slope columns work out of the box.
        let best = null;
        for (const row of rows) {
            if (!row || row.hasCompletePair === false
                || !Number.isFinite(row.dte) || row.dte <= 0) {
                continue;
            }
            if (best === null || Math.abs(row.dte - 7) < Math.abs(best.dte - 7)) {
                best = row;
            }
        }
        return best ? normalizeExpiryKey(best.expiry) : '';
    }

    function computeImpliedLambdaFromCurrentSnapshot(card, options = {}) {
        const lambdaSnapshot = options.lambdaSnapshot || (card && card.lambdaSnapshot);
        const bestEffort = options.bestEffort === true
            || !!(lambdaSnapshot && lambdaSnapshot.estimationMode === 'best_effort');
        const lambdaDetailRows = buildLambdaDetailRowsFromSnapshot(card, lambdaSnapshot);
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        const result = typeof core().computeImpliedWeekendLambdas === 'function'
            ? core().computeImpliedWeekendLambdas(
                lambdaDetailRows,
                lambdaSnapshot && lambdaSnapshot.anchorDate,
                {
                    calendarKey: profile.calendarId || 'NYSE',
                    // Strict snapshots use exact ContractDetails expiry
                    // instants. Best-effort observations retain exact clocks
                    // when present and otherwise use the official exchange
                    // date interval, with that downgrade preserved in the
                    // published methodology.
                    requireExactExpiryTimestamps: !bestEffort,
                    requireCoherentSnapshot: true,
                    ...(bestEffort ? {
                        maxQuoteSkewMs: null,
                        maxForwardDeviationPct: null,
                        maxBidAskSpreadPct: null,
                    } : {}),
                    timeZone: profile.optionExpiryTimeZone,
                    tradeDateRolloverHour: /^(?:CME|NYMEX|COMEX):/.test(
                        String(profile.calendarId || '').toUpperCase()
                    ) ? 17 : null,
                    // Pure straddle-price inference: numerically invert the
                    // straddle under the product's pricing model. No vendor
                    // IV is consulted.
                    underlyingPrice: lambdaSnapshot && lambdaSnapshot.underlyingPrice,
                    pricingModel: profile.pricingModel === 'black76' ? 'black76' : 'bsm-spot',
                    underlyingQuoteIsForward: String(profile.underlyingSecType || '').toUpperCase() === 'FUT',
                    interestRate: Number.isFinite(runtime.impliedLambdaRate)
                        ? runtime.impliedLambdaRate
                        : DEFAULT_IMPLIED_LAMBDA_RATE,
                    discountCurve: runtime.discountCurve,
                    snapshotMetadata: lambdaSnapshot ? {
                        snapshotId: lambdaSnapshot.snapshotId,
                        underlyingSnapshotId: lambdaSnapshot.underlyingQuote
                            && lambdaSnapshot.underlyingQuote.snapshotId,
                        coherent: lambdaSnapshot.coherent === true,
                        quoteComplete: lambdaSnapshot.quoteComplete === true,
                        payloadAsOf: lambdaSnapshot.payloadAsOf,
                        // Prefer the measured oldest quote time when the
                        // snapshot carries one. Falling back to payloadAsOf
                        // keeps strict server snapshots, whose payloadAsOf is
                        // itself a certified coherent instant, unchanged.
                        quoteAsOf: lambdaSnapshot.quoteAsOf || lambdaSnapshot.payloadAsOf,
                        underlyingQuoteAsOf: lambdaSnapshot.underlyingQuote
                            && lambdaSnapshot.underlyingQuote.quoteAsOf,
                    } : null,
                }
            )
            : null;
        if (result && bestEffort) {
            result.methodology = {
                ...(result.methodology || {}),
                estimationMode: 'best_effort',
                sourceQuoteEvidence: 'manual_atomic_current_bbo',
            };
            result.quality = {
                ...(result.quality || {}),
                estimationMode: 'best_effort',
                strictSnapshot: false,
                sourceQuoteEvidence: 'manual_atomic_current_bbo',
                sourceExpectedExpiryCount: Number(lambdaSnapshot.sourceExpectedExpiryCount) || null,
                usableExpiryCount: Array.isArray(lambdaSnapshot.expiryRows)
                    ? lambdaSnapshot.expiryRows.length
                    : null,
                skippedExpiryCount: Array.isArray(lambdaSnapshot.skippedRows)
                    ? lambdaSnapshot.skippedRows.length
                    : null,
            };
        }
        return result;
    }

    function buildComparedRows(card) {
        const rawDetailRows = buildDetailRows(card);
        const lambdaDetailRows = buildLambdaDetailRows(card);
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        // The price-derived lambda surface is intentionally a manual snapshot.
        // Live option ticks may refresh raw IV/straddle rows, but they never
        // re-run the estimator or replace the structured curve shown here.
        const impliedLambda = card && card.impliedLambdaComputedResult
            ? card.impliedLambdaComputedResult
            : null;
        // The TWS Call/Put IV is first collected above. Only after the frozen
        // straddle snapshot has solved a qualified per-date lambda curve do we
        // re-annualize the displayed TD IV. This keeps the estimator free of
        // vendor IV while letting its price-derived clock correct the vendor
        // pair. For this display only, the core stamps median-lambda
        // extrapolations beyond direct coverage; the simulator's published
        // per-date curve remains strict.
        const detailRows = typeof core().applyImpliedLambdaClockToRows === 'function'
            ? core().applyImpliedLambdaClockToRows(
                rawDetailRows,
                impliedLambda && impliedLambda.anchorDate
                    || card.catalog && card.catalog.anchorDate,
                impliedLambda,
                profile.calendarId || 'NYSE'
            )
            : rawDetailRows;
        const baselineExpiry = resolveSelectedStraddleBaselineExpiry(card, detailRows);
        let comparedDetailRows = core().buildStraddleComparisonRows(detailRows, baselineExpiry);
        if (typeof core().annotateTdSlopeVsBaseline === 'function') {
            comparedDetailRows = core().annotateTdSlopeVsBaseline(comparedDetailRows, baselineExpiry);
        }
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
            lambdaDetailRows,
            bucketRows: comparedBucketRows,
            impliedLambda,
        };
    }

    function latestQuoteAsOf(detailRows) {
        let latest = '';
        for (const row of (Array.isArray(detailRows) ? detailRows : [])) {
            for (const value of [row && row.callQuoteAsOf, row && row.putQuoteAsOf]) {
                const asOf = String(value || '').trim();
                if (asOf && asOf > latest) {
                    latest = asOf;
                }
            }
        }
        return latest;
    }

    function buildImpliedLambdaEntry(card, comparedRows) {
        const impliedLambda = comparedRows && comparedRows.impliedLambda;
        const lambdaSnapshot = comparedRows && comparedRows.lambdaSnapshot
            || card && card.lambdaSnapshot;
        if (!card || !lambdaSnapshot || !impliedLambda
            || !impliedLambda.quality || impliedLambda.quality.status !== 'ok'
            || impliedLambda.quality.coherent !== true
            || !Object.keys(impliedLambda.byDate || {}).length) {
            return null;
        }
        return {
            symbol: card.symbol,
            underlyingContractMonth: card.futuresContractMonth || null,
            calendarKey: impliedLambda.calendarKey,
            anchorDate: impliedLambda.anchorDate,
            quoteAsOf: impliedLambda.quoteAsOf || lambdaSnapshot.payloadAsOf,
            snapshotId: impliedLambda.snapshotId || lambdaSnapshot.snapshotId,
            methodology: impliedLambda.methodology
                ? { ...impliedLambda.methodology }
                : {
                    pricingModel: impliedLambda.pricingModel,
                    interestRate: impliedLambda.interestRate,
                },
            quality: { ...impliedLambda.quality },
            intervals: Array.isArray(impliedLambda.intervals)
                ? impliedLambda.intervals.map((interval) => ({ ...interval }))
                : [],
            coverageStart: impliedLambda.coverageStart,
            coverageEnd: impliedLambda.coverageEnd,
            medianLambda: impliedLambda.medianLambda,
            byDate: impliedLambda.byDate,
            weekendCount: impliedLambda.okIntervalCount,
            varianceSource: impliedLambda.varianceSource,
        };
    }

    // Download the implied-lambda array as a portable JSON file so a
    // simulator page served from another origin/machine can load it
    // (localStorage publishing only reaches same-origin pages).
    function buildImpliedLambdaExportFilename(doc) {
        const data = doc && typeof doc === 'object' ? doc : {};
        const symbol = String(data.symbol || 'UNKNOWN').trim().toUpperCase()
            .replace(/[^A-Z0-9._-]+/g, '_');
        const contractMonth = /^\d{6}$/.test(String(data.underlyingContractMonth || ''))
            ? `_${data.underlyingContractMonth}`
            : '';
        const quoteMs = Date.parse(String(data.quoteAsOf || ''));
        const quoteKey = Number.isFinite(quoteMs)
            ? new Date(quoteMs).toISOString()
                .replace(/\.\d+Z$/, 'Z')
                .replace(/[-:]/g, '')
            : String(data.anchorDate || 'latest').replace(/-/g, '');
        return `implied_lambda_${symbol}${contractMonth}_${quoteKey}.json`;
    }

    function exportImpliedLambdaFile(card) {
        const handoff = typeof OptionComboImpliedLambdaHandoff !== 'undefined'
            ? OptionComboImpliedLambdaHandoff
            : null;
        const entry = card && card.impliedLambdaComputedEntry;
        const doc = handoff && entry ? handoff.buildExportDocument(entry) : null;
        if (!doc) {
            setCardStatus(card, 'Calculate implied λ first, then export the frozen structured result.', 'error');
            render(true);
            return;
        }
        const payload = JSON.stringify(doc, null, 2);
        const dataBlob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = buildImpliedLambdaExportFilename(doc);
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
        setCardStatus(card, `Implied λ exported: ${Object.keys(doc.byDate).length} dates, median ${doc.medianLambda != null ? doc.medianLambda : '--'}.`, 'success');
        render(true);
    }

    // Publish an already calculated per-weekend array. Live quote ticks never
    // call this path; same-origin simulators are updated only by an explicit
    // Sync action in the IVTS UI.
    function publishImpliedLambdaEntry(card, entry) {
        const handoff = typeof OptionComboImpliedLambdaHandoff !== 'undefined'
            ? OptionComboImpliedLambdaHandoff
            : null;
        if (!handoff) {
            return {
                ok: false,
                status: 'handoff_unavailable',
                entry: null,
                dateCount: 0,
                snapshotId: String(card && card.lambdaSnapshot && card.lambdaSnapshot.snapshotId || '').trim(),
            };
        }
        if (!entry) {
            // An explicit sync without a valid frozen calculation cannot keep
            // claiming ownership of a previously synchronized surface.
            if (card && card.lambdaSnapshot) {
                withdrawImpliedLambda(card);
            }
            return {
                ok: false,
                status: 'not_estimable',
                entry: null,
                dateCount: 0,
                snapshotId: String(card && card.lambdaSnapshot && card.lambdaSnapshot.snapshotId || '').trim(),
            };
        }
        const fingerprint = JSON.stringify(entry);
        const peekCurrentEntry = () => {
            try {
                return typeof handoff.peekSymbolEntry === 'function'
                    ? handoff.peekSymbolEntry(
                        card.symbol,
                        undefined,
                        Date.now(),
                        card.futuresContractMonth || null,
                        entry.anchorDate
                    )
                    : null;
            } catch (_) {
                return null;
            }
        };
        if (card.impliedLambdaFingerprint === fingerprint) {
            const persisted = peekCurrentEntry();
            if (persisted
                && String(persisted.snapshotId || '').trim() === String(entry.snapshotId || '').trim()
                && String(persisted.quoteAsOf || '').trim() === String(entry.quoteAsOf || '').trim()) {
                return {
                    ok: true,
                    status: 'unchanged',
                    entry: persisted,
                    dateCount: Object.keys(persisted.byDate || {}).length,
                    snapshotId: String(entry.snapshotId || '').trim(),
                };
            }
            // Storage may have been cleared or rejected after the previous
            // write. Retry it instead of treating an in-memory fingerprint as
            // proof that the simulator can still read this curve.
            card.impliedLambdaFingerprint = '';
        }
        let saved = false;
        try {
            saved = handoff.saveSymbolEntry(entry) === true;
        } catch (_) {
            saved = false;
        }
        if (saved) {
            card.impliedLambdaFingerprint = fingerprint;
            card.impliedLambdaPublishedSnapshotId = entry.snapshotId;
            return {
                ok: true,
                status: 'published',
                entry,
                dateCount: Object.keys(entry.byDate || {}).length,
                snapshotId: String(entry.snapshotId || '').trim(),
            };
        }

        const existing = peekCurrentEntry();
        const existingQuoteMs = Date.parse(String(existing && existing.quoteAsOf || ''));
        const incomingQuoteMs = Date.parse(String(entry.quoteAsOf || ''));
        if (existing && Number.isFinite(existingQuoteMs) && Number.isFinite(incomingQuoteMs)
            && existingQuoteMs >= incomingQuoteMs) {
            // Another tab owns the same or a newer market observation. Keep
            // that valid shared curve and relinquish this card's old ownership.
            card.impliedLambdaFingerprint = fingerprint;
            card.impliedLambdaPublishedSnapshotId = '';
            return {
                ok: true,
                status: existing.snapshotId === entry.snapshotId
                    ? 'unchanged'
                    : 'newer_publication_active',
                entry: existing,
                dateCount: Object.keys(existing.byDate || {}).length,
                snapshotId: String(entry.snapshotId || '').trim(),
            };
        }
        withdrawImpliedLambda(card);
        return {
            ok: false,
            status: 'save_failed',
            entry,
            dateCount: 0,
            snapshotId: String(entry.snapshotId || '').trim(),
        };
    }

    function publishImpliedLambda(card, comparedRows) {
        return publishImpliedLambdaEntry(
            card,
            buildImpliedLambdaEntry(card, comparedRows)
        );
    }

    function formatImpliedLambdaPublicationStatus(result, optionCount) {
        const outcome = result && typeof result === 'object' ? result : {};
        const dateCount = Math.max(0, parseInt(outcome.dateCount, 10) || 0);
        const dateLabel = `${dateCount} ${dateCount === 1 ? 'date' : 'dates'}`;
        const legCount = Math.max(0, parseInt(optionCount, 10) || 0);
        if (outcome.ok === true) {
            const ownershipNote = outcome.status === 'newer_publication_active'
                ? ' A newer same-origin IVTS snapshot remains active.'
                : '';
            const bestEffort = outcome.entry && outcome.entry.quality
                && outcome.entry.quality.estimationMode === 'best_effort';
            const source = legCount > 0
                ? ` from ${bestEffort ? 'best-effort' : 'coherent'} ${legCount}-leg snapshot`
                : '';
            return `Synced implied λ: ${dateLabel}${source}.${ownershipNote}`;
        }
        if (outcome.status === 'snapshot_missing') {
            return 'Implied λ sync unavailable: no coherent quote snapshot is loaded.';
        }
        if (outcome.status === 'snapshot_stale') {
            return 'Implied λ sync failed: the calculated quote snapshot is stale.';
        }
        if (outcome.status === 'handoff_unavailable') {
            return 'Implied λ sync failed: the V2 handoff runtime is unavailable.';
        }
        if (outcome.status === 'not_estimable') {
            return 'Implied λ sync failed: no quality-approved non-trading interval was calculated.';
        }
        if (outcome.status === 'save_failed') {
            return 'Implied λ sync failed: browser storage or V2 identity/calendar validation rejected the curve.';
        }
        return 'Implied λ sync failed.';
    }

    function calculateImpliedLambda(card, nowValue = Date.now()) {
        if (!card) {
            return {
                ok: false, status: 'card_missing', entry: null, dateCount: 0,
                snapshotId: '', message: 'Cannot calculate implied λ: card state is unavailable.',
            };
        }

        let calculationMode = 'strict';
        let lambdaSnapshot = card.lambdaSnapshot;
        const strictFreshness = evaluateLambdaSnapshotFreshness(lambdaSnapshot, nowValue);
        let impliedLambda = strictFreshness.fresh
            ? computeImpliedLambdaFromCurrentSnapshot(card, { lambdaSnapshot })
            : null;
        let entry = buildImpliedLambdaEntry(card, { impliedLambda, lambdaSnapshot });
        let bestEffortSource = null;
        let vendorIvSource = null;

        // A strict full-curve snapshot is preferred, but it is no longer an
        // all-or-nothing prerequisite.  If TWS omitted timestamps or one
        // callback was incomplete, calculate from the usable two-sided BBO
        // pairs currently visible in the card and skip the bad expiries.
        const strictNeedsCoverageRecovery = !entry || !!(impliedLambda && (
            (Array.isArray(impliedLambda.rowDiagnostics)
                && impliedLambda.rowDiagnostics.some(row => row && row.status !== 'ok'))
            || (Array.isArray(impliedLambda.intervals)
                && impliedLambda.intervals.some(interval => interval && interval.status !== 'ok'))
        ));
        if (strictNeedsCoverageRecovery) {
            bestEffortSource = buildBestEffortLambdaSnapshot(card, nowValue);
            if (bestEffortSource.ok) {
                const estimatedSnapshot = bestEffortSource.snapshot;
                const estimatedLambda = computeImpliedLambdaFromCurrentSnapshot(card, {
                    lambdaSnapshot: estimatedSnapshot,
                    bestEffort: true,
                });
                const estimatedEntry = buildImpliedLambdaEntry(card, {
                    impliedLambda: estimatedLambda,
                    lambdaSnapshot: estimatedSnapshot,
                });
                const strictDateCount = entry ? Object.keys(entry.byDate || {}).length : 0;
                const estimatedDateCount = estimatedEntry
                    ? Object.keys(estimatedEntry.byDate || {}).length
                    : 0;
                if (estimatedEntry && (!entry || estimatedDateCount > strictDateCount)) {
                    calculationMode = 'best_effort';
                    lambdaSnapshot = estimatedSnapshot;
                    impliedLambda = estimatedLambda;
                    entry = estimatedEntry;
                }
            }
        }
        // Vendor ATM IV is the last resort, not a competitor to the price
        // routes. It needs only IV > 0, so it will nearly always cover more
        // expiries than a straddle surface that demands two-sided BBO --
        // ranking by covered-date count alone therefore discarded a clean
        // price-derived curve almost every time it was consulted. It is also
        // circular: applyImpliedLambdaClockToRows re-annualizes displayed
        // vendor IV with the resulting clock. So it runs only when the
        // straddle routes produced nothing usable at all, and never replaces
        // an entry they did produce.
        //
        // Per-date merging of a vendor curve into a straddle curve is
        // deliberately not attempted: the V2 handoff requires every interval
        // to carry the entry's single snapshotId, so a blended entry would be
        // rejected as inconsistent identity.
        const straddleRoutesFailed = !entry;
        if (straddleRoutesFailed) {
            vendorIvSource = buildVendorIvLambdaSource(card, nowValue);
            if (vendorIvSource.ok) {
                const vendorSnapshot = vendorIvSource.snapshot;
                const vendorLambda = computeImpliedLambdaFromVendorIv(card, vendorIvSource);
                const vendorEntry = buildImpliedLambdaEntry(card, {
                    impliedLambda: vendorLambda,
                    lambdaSnapshot: vendorSnapshot,
                });
                if (vendorEntry) {
                    calculationMode = 'vendor_iv_fallback';
                    lambdaSnapshot = vendorSnapshot;
                    impliedLambda = vendorLambda;
                    entry = vendorEntry;
                }
            }
        }
        if (!entry) {
            const diagnostics = impliedLambda && Array.isArray(impliedLambda.rowDiagnostics)
                ? impliedLambda.rowDiagnostics
                : [];
            const usableRows = diagnostics.filter((row) => row && row.status === 'ok').length;
            const reasonCounts = {};
            diagnostics.forEach((row) => {
                const reason = String(row && row.status || 'unusable').trim();
                if (reason !== 'ok') reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
            });
            const reasonSummary = Object.entries(reasonCounts)
                .map(([reason, count]) => `${reason}×${count}`)
                .join(', ');
            const unavailable = {
                ok: false,
                status: 'not_estimable',
                entry: null,
                dateCount: 0,
                snapshotId: String(lambdaSnapshot && lambdaSnapshot.snapshotId || '').trim(),
                message: `Cannot estimate implied λ yet: ${usableRows} usable expiries do not form a solvable weekend interval${reasonSummary ? ` (${reasonSummary})` : ''}.`,
            };
            card.impliedLambdaPublicationResult = unavailable;
            setCardStatus(card, unavailable.message, 'error');
            return unavailable;
        }

        card.impliedLambdaComputedResult = impliedLambda;
        card.impliedLambdaComputedEntry = entry;
        card.impliedLambdaComputedAt = new Date(nowValue).toISOString();
        card.impliedLambdaNeedsRecalculation = false;
        card.impliedLambdaPublicationResult = null;
        const dateCount = Object.keys(entry.byDate || {}).length;
        const result = {
            ok: true,
            status: calculationMode === 'strict' ? 'calculated' : 'estimated',
            calculationMode,
            entry,
            dateCount,
            snapshotId: String(entry.snapshotId || '').trim(),
            message: calculationMode === 'vendor_iv_fallback'
                ? `Estimated implied λ from ${vendorIvSource.usableExpiryCount} ATM Call/Put IV pairs (${vendorIvSource.skippedExpiryCount} skipped): ${dateCount} structured dates, median ${formatNumber(entry.medianLambda, 4)}. Vendor-IV fallback is frozen; choose Sync or Export.`
                : (calculationMode === 'best_effort'
                    ? `Estimated implied λ from ${bestEffortSource.usableExpiryCount} usable BBO expiries (${bestEffortSource.skippedExpiryCount} skipped): ${dateCount} structured dates, median ${formatNumber(entry.medianLambda, 4)}. Choose Sync or Export.`
                    : `Calculated implied λ: ${dateCount} structured dates, median ${formatNumber(entry.medianLambda, 4)}. Choose Sync or Export.`),
        };
        setCardStatus(card, result.message, 'success');
        return result;
    }

    function syncCalculatedImpliedLambda(card) {
        const entry = card && card.impliedLambdaComputedEntry;
        if (!entry) {
            const missing = {
                ok: false,
                status: 'calculation_missing',
                entry: null,
                dateCount: 0,
                snapshotId: '',
                message: 'Calculate implied λ first, then sync the frozen result to local simulators.',
            };
            if (card) {
                card.impliedLambdaPublicationResult = missing;
                setCardStatus(card, missing.message, 'error');
            }
            return missing;
        }

        const result = publishImpliedLambdaEntry(card, entry);
        result.message = result.ok === true
            ? `Synced implied λ to same-origin simulators: ${result.dateCount} structured dates, median ${formatNumber(entry.medianLambda, 4)}.`
            : formatImpliedLambdaPublicationStatus(result, 0);
        card.impliedLambdaPublicationResult = result;
        setCardStatus(card, result.message, result.ok === true ? 'success' : 'error');
        return result;
    }

    // Backward-compatible test/integration name. It now performs calculation
    // only and never writes browser storage.
    function refreshImpliedLambdaPublication(card) {
        return calculateImpliedLambda(card);
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

    function buildCurrentSampleRecord(card) {
        const comparedRows = buildComparedRows(card);
        return core().buildSampleRecord(
            card.symbol,
            card.underlyingPrice,
            comparedRows.bucketRows,
            comparedRows.detailRows,
            new Date().toISOString(),
            card.catalog && card.catalog.anchorDate,
            comparedRows.baselineExpiry
        );
    }

    function hasUsableWatermarkSeed(sampleRecord) {
        return !!(
            sampleRecord
            && Number.isFinite(sampleRecord.underlyingPrice)
            && sampleRecord.underlyingPrice > 0
            && Array.isArray(sampleRecord.details)
            && sampleRecord.details.some((row) => (
                row
                && Number.isFinite(row.dte)
                && row.dte >= 4
                && row.dte <= 10
                && Number.isFinite(row.atmStraddleMark)
                && row.atmStraddleMark > 0
            ))
        );
    }

    async function readAutoHistoryFile(fileHandle, symbol) {
        const file = await fileHandle.getFile();
        const text = await file.text();
        if (!text.trim()) {
            return normalizeAutoHistoryDocument(null, symbol);
        }
        const payload = JSON.parse(text);
        if (payload && payload.symbol && String(payload.symbol).trim().toUpperCase() !== symbol) {
            throw new Error(`Selected auto-sample file belongs to ${payload.symbol}, not ${symbol}.`);
        }
        if (!payload || payload.purpose !== AUTO_HISTORY_PURPOSE) {
            throw new Error('Selected file is not an IV Term Structure automatic-sample JSON.');
        }
        return normalizeAutoHistoryDocument(payload, symbol);
    }

    async function ensureAutoFileWritePermission(fileHandle) {
        if (!fileHandle || typeof fileHandle.requestPermission !== 'function') {
            return;
        }
        const permission = await fileHandle.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
            throw new Error('Write access to the selected Auto JSON was not granted.');
        }
    }

    async function writeAutoHistoryDocument(card) {
        if (!card.autoFileHandle || typeof card.autoFileHandle.createWritable !== 'function') {
            throw new Error('The automatic sample file is no longer writable. Load the Auto JSON again to restore append access.');
        }
        const writable = await card.autoFileHandle.createWritable();
        await writable.write(JSON.stringify(card.autoHistoryDocument, null, 2));
        await writable.close();
    }

    function bindAutoHistoryFile(card, fileHandle, historyDocument) {
        card.autoFileHandle = fileHandle;
        card.autoFileName = String(fileHandle.name || `${card.symbol}.ivts-auto.json`);
        card.autoHistoryDocument = historyDocument;
        const latest = latestAutoSample(historyDocument);
        card.lastAutoSampleLabel = latest && latest.sampledAt ? latest.sampledAt : '';
    }

    async function loadAutoHistoryFile(card) {
        if (typeof globalScope.showOpenFilePicker !== 'function') {
            throw new Error('Loading an automatic JSON requires Chrome or Edge File System Access support.');
        }
        const [fileHandle] = await globalScope.showOpenFilePicker({
            types: [{
                description: 'IV Term Structure automatic samples',
                accept: { 'application/json': ['.json'] },
            }],
            multiple: false,
        });
        await ensureAutoFileWritePermission(fileHandle);
        const historyDocument = await readAutoHistoryFile(fileHandle, card.symbol);
        bindAutoHistoryFile(card, fileHandle, historyDocument);
        return historyDocument;
    }

    async function createAutoHistoryFile(card) {
        if (typeof globalScope.showSaveFilePicker !== 'function') {
            throw new Error('Automatic JSON sampling requires a browser with the File System Access API (Chrome or Edge).');
        }
        const fileHandle = await globalScope.showSaveFilePicker({
            suggestedName: `${card.symbol}.ivts-auto.json`,
            types: [{
                description: 'IV Term Structure automatic samples',
                accept: { 'application/json': ['.json'] },
            }],
        });
        const historyDocument = await readAutoHistoryFile(fileHandle, card.symbol);
        bindAutoHistoryFile(card, fileHandle, historyDocument);
        // showSaveFilePicker creates a zero-byte file. Initialize it before
        // any market-data work so a slow/failed first sync still leaves a
        // valid, inspectable automatic-history document on disk.
        await writeAutoHistoryDocument(card);
        return historyDocument;
    }

    async function prepareAutoHistoryFile(card) {
        if (!card.autoFileHandle) {
            throw new Error('Load an existing Auto JSON or create a new one first.');
        }
        const historyDocument = await readAutoHistoryFile(card.autoFileHandle, card.symbol);
        card.autoHistoryDocument = historyDocument;
        const latest = latestAutoSample(historyDocument);
        card.lastAutoSampleLabel = latest && latest.sampledAt ? latest.sampledAt : '';
        return 'reused';
    }

    function autoSampleButtonLabel(card) {
        if (card && card.autoSamplingEnabled) {
            return 'Stop Auto Sample';
        }
        return card && card.autoFileHandle ? 'Resume Auto Sample' : 'Start Auto Sample';
    }

    function autoAppendTargetLabel(card) {
        return card && card.autoFileHandle && card.autoFileName
            ? card.autoFileName
            : 'Not selected';
    }

    function stopAutoSampling(card, options = {}) {
        card.autoSamplingEnabled = false;
        card.autoSampleRetryAfter = 0;
        if (options.setStatus !== false) {
            setCardStatus(
                card,
                `Automatic sampling stopped. ${card.autoHistoryDocument ? `${card.autoHistoryDocument.samples.length} samples remain in ${card.autoFileName}.` : ''}`,
                ''
            );
        }
        card.forceBodyRefreshOnce = true;
        render(true);
    }

    async function runAutoSample(card, reason = 'hourly', options = {}) {
        if (!card || !card.autoSamplingEnabled || card.autoSampleInProgress) {
            return false;
        }
        if (card.syncInProgress || card.sampleInProgress) {
            card.autoSampleRetryAfter = Date.now() + AUTO_SAMPLE_RETRY_DELAY_MS;
            return false;
        }

        card.autoSampleInProgress = true;
        card.autoSampleRetryAfter = 0;
        setCardStatus(card, `Auto Sample (${reason}): preparing a valid ATM snapshot...`, '');
        render(true);

        try {
            let sampleRecord = options.preferCachedSnapshot === true && hasUsableLiveSnapshot(card)
                ? buildCurrentSampleRecord(card)
                : null;
            if (!hasUsableWatermarkSeed(sampleRecord)) {
                await syncCard(card, { waitForQuotes: true, quoteTimeoutMs: 3500 });
                sampleRecord = buildCurrentSampleRecord(card);
            }
            if (!hasUsableWatermarkSeed(sampleRecord)) {
                throw new Error('No usable 4-10 DTE ATM straddle mark is available yet.');
            }

            // Re-read immediately before writing so a file edited outside this
            // page is not silently replaced with an older in-memory copy.
            const historyDocument = await readAutoHistoryFile(card.autoFileHandle, card.symbol);
            historyDocument.samples = historyDocument.samples.concat(sampleRecord);
            card.autoHistoryDocument = historyDocument;
            await writeAutoHistoryDocument(card);
            card.lastAutoSampleLabel = sampleRecord.sampledAt;
            card.forceBodyRefreshOnce = true;
            setCardStatus(
                card,
                `Auto Sample saved (${reason}). ${historyDocument.samples.length} hourly samples in ${card.autoFileName}; next check in 1 hour.`,
                'success'
            );
            return true;
        } catch (error) {
            card.autoSampleRetryAfter = Date.now() + AUTO_SAMPLE_RETRY_DELAY_MS;
            setCardStatus(
                card,
                `Auto Sample failed; retrying in about 5 minutes. ${error.message || error}`,
                'error'
            );
            return false;
        } finally {
            card.autoSampleInProgress = false;
            render(true);
        }
    }

    async function resumeAutoSampling(card, reason = 'resumed') {
        await prepareAutoHistoryFile(card);
        card.autoSamplingEnabled = true;
        card.forceBodyRefreshOnce = true;
        render(true);
        if (shouldRunAutoSample(card.autoHistoryDocument, new Date())) {
            await runAutoSample(card, reason, { preferCachedSnapshot: true });
            return;
        }
        setCardStatus(
            card,
            `Automatic sampling resumed. Appending hourly to ${card.autoFileName}; the latest sample is not due yet.`,
            'success'
        );
        render(true);
    }

    async function selectAndResumeAutoFile(card, mode) {
        if (card.autoSampleInProgress || card.autoFileSelectionInProgress) {
            return;
        }
        const wasEnabled = card.autoSamplingEnabled;
        const previousFileHandle = card.autoFileHandle;
        card.autoFileSelectionInProgress = true;
        card.autoSamplingEnabled = false;
        card.forceBodyRefreshOnce = true;
        render(true);
        try {
            if (mode === 'load') {
                await loadAutoHistoryFile(card);
            } else {
                await createAutoHistoryFile(card);
            }
            await resumeAutoSampling(card, mode === 'load' ? 'loaded/resumed' : 'new file');
        } catch (error) {
            // Resuming the previous file is only safe while the card still
            // points at it — a dismissed picker. Once a new handle is bound,
            // failing here means that file is unusable, so sampling stays off
            // rather than letting the hourly monitor run against it.
            card.autoSamplingEnabled = wasEnabled && card.autoFileHandle === previousFileHandle;
            if (error && error.name === 'AbortError') {
                return;
            }
            setCardStatus(
                card,
                error.message || (mode === 'load' ? 'Unable to load the automatic JSON.' : 'Unable to create the automatic JSON.'),
                'error'
            );
        } finally {
            card.autoFileSelectionInProgress = false;
            card.forceBodyRefreshOnce = true;
            render(true);
        }
    }

    async function startAutoSampling(card) {
        if (card.autoSamplingEnabled) {
            stopAutoSampling(card);
            return;
        }
        try {
            await resumeAutoSampling(card, 'resumed');
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return;
            }
            setCardStatus(card, error.message || 'Unable to start automatic sampling.', 'error');
            render(true);
        }
    }

    function checkAutoSamplers(reason = 'hourly') {
        const now = new Date();
        runtime.cardsBySymbol.forEach((card) => {
            if (!card.autoSamplingEnabled || card.autoSampleInProgress) {
                return;
            }
            if (card.autoSampleRetryAfter > Date.now()) {
                return;
            }
            if (shouldRunAutoSample(card.autoHistoryDocument, now)) {
                runAutoSample(card, reason);
            }
        });
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
            const sampleRecord = buildCurrentSampleRecord(card);
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
        if (row && row.subscriptionSelected === false) {
            return '<span class="ivts-missing">Not subscribed</span>';
        }
        return row && row.atmStraddleMark != null
            ? escapeHtml(formatMoney(row.atmStraddleMark))
            : '<span class="ivts-missing">Insufficient</span>';
    }

    // Current cumulative ATM total variance. Strict mode uses only a real
    // two-sided Call+Put BBO. The explicit best-effort mode may instead invert
    // the displayed marks, preserving their provenance in the observation.
    // Display W * 10,000 for short-dated readability.
    function resolveTotalVarianceObservation(row, options = {}) {
        const api = core();
        if (!api || typeof api.resolveStraddleTotalVarianceObservation !== 'function') {
            return null;
        }
        return api.resolveStraddleTotalVarianceObservation(row, {
            interestRate: Number.isFinite(runtime.impliedLambdaRate)
                ? runtime.impliedLambdaRate
                : DEFAULT_IMPLIED_LAMBDA_RATE,
            discountCurve: runtime.discountCurve,
            maxQuoteSkewMs: 30 * 1000,
            allowBestEffort: options.bestEffort === true,
        });
    }

    function resolveForwardVarianceObservation(row, previousRow = null, options = {}) {
        const current = resolveTotalVarianceObservation(row, options);
        if (!current) return null;
        const previous = resolveTotalVarianceObservation(previousRow, options);
        if (previousRow && !previous) return null;
        const intervalYears = previous
            ? current.timeYears - previous.timeYears
            : current.timeYears;
        if (!(intervalYears > 0)) return null;
        const forwardVariance = previous
            ? current.totalVariance - previous.totalVariance
            : current.totalVariance;
        const annualizedForwardVariance = forwardVariance / intervalYears;
        if (!Number.isFinite(annualizedForwardVariance)) return null;
        return {
            totalVariance: current.totalVariance,
            previousTotalVariance: previous ? previous.totalVariance : 0,
            intervalYears,
            forwardVariance,
            annualizedForwardVariance,
            variancePoints: annualizedForwardVariance * 10000,
            forwardVolatility: annualizedForwardVariance >= 0
                ? Math.sqrt(annualizedForwardVariance)
                : null,
            isFrontInterval: !previous,
            timeSource: current.timeSource,
            isBestEffort: current.isBestEffort === true
                || !!(previous && previous.isBestEffort === true),
        };
    }

    function buildTotalVarianceCell(row, previousRow = null, options = {}) {
        const observation = resolveTotalVarianceObservation(row, options);
        if (!observation) {
            return '<span class="ivts-missing">--</span>';
        }
        const previous = resolveTotalVarianceObservation(previousRow, options);
        const inverted = Boolean(previous && observation.totalVariance < previous.totalVariance);
        const intervalLabel = previous
            ? `${String(previousRow && previousRow.expiry || 'prior expiry')}→${String(row && row.expiry || 'expiry')}`
            : 'quote→first expiry';
        const changeLabel = previous
            ? `; ΔW×10,000=${((observation.totalVariance - previous.totalVariance) * 10000).toFixed(1)}`
            : '';
        const inversionLabel = inverted
            ? ' Cumulative total variance fell versus the prior usable expiry: hard inversion candidate.'
            : '';
        const sourceLabel = observation.isBestEffort
            ? `best-effort displayed marks (Call ${observation.callMarkSource}, Put ${observation.putMarkSource}${observation.quoteSkewExceeded ? `, quote skew ${(observation.quoteSkewMs / 1000).toFixed(1)}s` : ''})`
            : 'real Call+Put BBO midpoint';
        const qualityLabel = observation.isBestEffort
            ? ' This is an estimate recovered from the visible Straddle marks, not a strict synchronized BBO observation.'
            : ' No vendor IV, fitted λ, or TD IV is used.';
        const title = `ATM cumulative total variance numerically inverted from ${sourceLabel} straddle ${formatMoney(observation.straddlePrice)} at K=${formatNumber(observation.strike, 2)}, parity F=${formatNumber(observation.parityForward, 4)}, displayed as W×10,000 using ${observation.timeSource}`
            + `${changeLabel}. ${intervalLabel}.${inversionLabel}${qualityLabel}`;
        const valueClasses = ['ivts-total-variance'];
        if (inverted) valueClasses.push('is-inverted');
        if (observation.isBestEffort) valueClasses.push('is-estimated');
        const displayValue = `${observation.isBestEffort ? '≈' : ''}${observation.variancePoints.toFixed(1)}`;
        return `<span class="${valueClasses.join(' ')}" title="${escapeHtml(title)}">${escapeHtml(displayValue)}</span>`;
    }

    function buildForwardVarianceCell(row, previousRow = null, options = {}) {
        const observation = resolveForwardVarianceObservation(row, previousRow, options);
        if (!observation) {
            return '<span class="ivts-missing">--</span>';
        }
        const negative = observation.annualizedForwardVariance < 0;
        const intervalLabel = observation.isFrontInterval
            ? 'quote→first expiry'
            : `${String(previousRow && previousRow.expiry || 'prior expiry')}→${String(row && row.expiry || 'expiry')}`;
        const volLabel = observation.forwardVolatility === null
            ? 'undefined because forward variance is negative'
            : `${(observation.forwardVolatility * 100).toFixed(2)}%`;
        const inversionLabel = negative
            ? ' Negative adjacent-expiry forward variance: hard cumulative-variance inversion candidate.'
            : '';
        const qualityLabel = observation.isBestEffort
            ? 'At least one endpoint is a best-effort estimate from displayed Straddle marks rather than a strict synchronized BBO.'
            : 'Both W points are inverted from real Call+Put BBO midpoint straddles; no vendor IV, fitted λ, or TD IV is used.';
        const title = `${intervalLabel}: annualized forward variance = (W₂−W₁)/(T₂−T₁), displayed as FV×10,000; forward vol ${volLabel}. `
            + `${qualityLabel}${inversionLabel}`;
        const valueClasses = ['ivts-forward-variance'];
        if (negative) valueClasses.push('is-negative');
        if (observation.isBestEffort) valueClasses.push('is-estimated');
        const displayValue = `${observation.isBestEffort ? '≈' : ''}${observation.variancePoints.toFixed(1)}`;
        return `<span class="${valueClasses.join(' ')}" title="${escapeHtml(title)}">${escapeHtml(displayValue)}</span>`;
    }

    function buildTdSlopeCell(row, baselineExpiry) {
        if (!baselineExpiry) {
            return '<span class="ivts-missing">--</span>';
        }
        if (row && row.isStraddleBaseline) {
            return '<span class="ivts-ratio">base</span>';
        }
        if (!row || row.tdSlopeVsBaseline == null) {
            return '<span class="ivts-missing">--</span>';
        }
        const defaults = core().STRATEGY_SIGNAL_DEFAULTS || {};
        const low = Number.isFinite(defaults.zoneLow) ? defaults.zoneLow : 0.95;
        const high = Number.isFinite(defaults.zoneHigh) ? defaults.zoneHigh : 1.05;
        // The 0.95/1.05 thresholds are calibrated on the ~2x pair geometry.
        // Wider pairs sit naturally below 1 (normal upward term structure:
        // SPY 14/90 median ~0.91), so zone colors would be misleading there.
        const nearPlaybookGeometry = Number.isFinite(row.tdSlopePairRatio)
            && row.tdSlopePairRatio >= 1.5 && row.tdSlopePairRatio <= 2.6;
        const zoneClass = nearPlaybookGeometry
            ? (row.tdSlopeVsBaseline > high
                ? ' is-slope-backwardation'
                : (row.tdSlopeVsBaseline < low ? ' is-slope-contango' : ''))
            : '';
        const title = 'Ratio of the displayed ATM TD IV for (this expiry, baseline), shorter leg on top. '
            + 'The values therefore include the active structured implied λ correction shown in the TD IV column. '
            + `Zone colors (<${low.toFixed(2)} / >${high.toFixed(2)}) apply only near the calibrated ~2x DTE geometry; `
            + 'wider pairs sit naturally lower — a normal upward term structure, not deep contango. '
            + 'Exploration only: the separate strategy signal above stays pinned to frozen λ=0.3 on the ~7d front / ~2x back pair.';
        return `<span class="ivts-ratio${zoneClass}" title="${escapeHtml(title)}">${escapeHtml(row.tdSlopeVsBaseline.toFixed(3))}</span>`;
    }

    function buildStraddleRatioCell(row, baselineExpiry) {
        if (row && row.subscriptionSelected === false) {
            return '<span class="ivts-missing">--</span>';
        }
        if (!baselineExpiry) {
            return '<span class="ivts-missing">--</span>';
        }
        return row && row.straddleBaselineRatio != null
            ? `<span class="ivts-ratio">${escapeHtml(formatMultiple(row.straddleBaselineRatio))}</span>`
            : '<span class="ivts-missing">Insufficient</span>';
    }

    function buildIvPairCell(row) {
        if (row && row.subscriptionSelected === false) {
            return '<span class="ivts-missing">Not subscribed</span>';
        }
        const text = row ? formatIvPair(row.callIv, row.putIv) : '--/--';
        return row && (row.callIv != null || row.putIv != null)
            ? escapeHtml(text)
            : `<span class="ivts-missing">${escapeHtml(text)}</span>`;
    }

    function buildIvPairTdCell(row) {
        if (row && row.subscriptionSelected === false) {
            return '<span class="ivts-missing">Not subscribed</span>';
        }
        const text = row ? formatIvPair(row.callIvTd, row.putIvTd) : '--/--';
        if (!row || (row.callIvTd == null && row.putIvTd == null)) {
            const missingDates = row && Array.isArray(row.tdIvMissingWeightDates)
                ? row.tdIvMissingWeightDates
                : [];
            const title = row && row.tdIvStatus === 'implied_lambda_incomplete'
                ? `TD IV unavailable: structured implied λ does not cover ${missingDates.join(', ')}. Raise the Option Streams limit and sync again.`
                : (row && row.tdIvStatus === 'calendar_unavailable'
                    ? 'TD IV unavailable: official exchange-calendar coverage is missing.'
                    : 'TD IV is not available for this expiry.');
            return `<span class="ivts-missing" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
        }
        const tradDte = Number.isFinite(row.tradDte) ? row.tradDte : null;
        const lambda = Number.isFinite(row.tdIvWeekendWeight) ? row.tdIvWeekendWeight : 0;
        const appliedWeights = row && row.tdIvAppliedWeights
            && typeof row.tdIvAppliedWeights === 'object'
            ? Object.entries(row.tdIvAppliedWeights)
            : [];
        const extrapolatedDates = row && Array.isArray(row.tdIvExtrapolatedWeightDates)
            ? row.tdIvExtrapolatedWeightDates
            : [];
        const sourceText = row && row.tdIvSource === 'implied_lambda'
            ? `Structured implied λ clock (${appliedWeights.length
                ? appliedWeights.map(([date, weight]) => `${date}=${Number(weight).toFixed(3)}`).join(', ')
                : 'no non-trading date in this horizon'}); common annualization λ=${lambda.toFixed(3)}.`
                + (extrapolatedDates.length
                    ? ` Median λ extrapolated to: ${extrapolatedDates.join(', ')}.`
                    : '')
            : `Fallback scalar λ=${lambda.toFixed(2)}; a qualified structured implied-λ curve is not available yet.`;
        const title = 'Weighted-clock annualized IV preserving the total variance of the TWS Call/Put IV. '
            + sourceText
            + (tradDte != null ? ` Trading DTE: ${tradDte}.` : '')
            + (Number.isFinite(row && row.tdIvEffectiveDte)
                ? ` Effective DTE: ${row.tdIvEffectiveDte}.`
                : '');
        return `<span title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
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
                        <option value="">Auto: nearest 7 DTE</option>
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

    function describeCalendarFinderEmptyState(config, stats) {
        if (!stats || stats.totalExpiries === 0) {
            return 'No expiry rows yet. Sync/Update to subscribe quotes first.';
        }
        if (stats.usableExpiries < 2) {
            return `Waiting for complete ATM IV quotes (${stats.usableExpiries}/${stats.totalExpiries} expiries usable).`;
        }
        if (stats.shortCandidates === 0) {
            return `No sell/buy expiry pairs found among ${stats.usableExpiries} usable expiries. Sync more expiries with later DTE.`;
        }
        return `No long-leg expiry is later than the selected short-leg candidates (${stats.shortCandidates} short candidates). Sync more expiries with later DTE.`;
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
                    <span>${escapeHtml(`${formatMultiple(row.ivRatio)} IV`)}</span>
                    <span>${escapeHtml(`${formatCompactPercent(row.shortAtmIv)} / ${formatCompactPercent(row.longAtmIv)}`)}</span>
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
            ? `Best ${formatMultiple(best.ivRatio)} IV | ${best.shortDte}D -> ${best.longDte}D${secondary ? ` | Next ${secondary.shortDte}D -> ${secondary.longDte}D` : ''}`
            : emptyMessage;
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
                        <button class="ivts-btn ivts-btn-muted ivts-calendar-toggle" data-action="calendar-show-all" data-symbol="${escapeHtml(card.symbol)}" type="button" ${rows.length <= CALENDAR_FINDER_TOP_LIMIT && !config.showAll ? 'disabled' : ''}>${escapeHtml(showAllButtonLabel)}</button>
                    </div>
                    ${best ? `
                        <div class="ivts-calendar-picks" aria-label="Calendar recommendations">
                            ${buildCalendarRecommendation('Best', best, 'Highest short/long IV')}
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
                                    <th>IV Ratio</th>
                                    <th>ATM IV</th>
                                    <th>DTE Ratio</th>
                                    <th>Straddle</th>
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
                                        <td><span class="ivts-ratio">${escapeHtml(formatMultiple(row.ivRatio))}</span></td>
                                        <td>${escapeHtml(`${formatCompactPercent(row.shortAtmIv)}/${formatCompactPercent(row.longAtmIv)}`)}</td>
                                        <td>${escapeHtml(formatCompactMultiple(row.dteRatio))}</td>
                                        <td>${escapeHtml(`${formatMoney(row.shortStraddleMark)}/${formatMoney(row.longStraddleMark)}`)}</td>
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
                                    <th title="TWS Call/Put IV re-annualized after the coherent straddle surface solves implied λ. Directly covered dates use their own λ; later uncovered dates use the current implied-λ median as an explicitly marked display extrapolation.">TD IV</th>
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
                                        <td>${buildIvPairTdCell(row)}</td>
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

    function buildImpliedLambdaCell(row, impliedLambda) {
        const reasons = {
            no_baseline: 'no pure trading-day interval nearby to act as the per-day variance baseline',
            nonpositive_forward_variance: 'forward variance across this interval is not positive',
            calendar_unavailable: 'holiday calendar coverage is unavailable for this range',
            stale_mix: 'quotes were too far apart in time to form one coherent observation',
            unverified_front: 'the first expiry has no live 0DTE point to remove the remaining current session',
            out_of_range: 'legacy data marked this signed estimate as unpublished',
            exact_expiry_timestamp_unavailable: 'the broker omitted the exact expiry cutoff; recalculate to use the product-profile clock fallback',
            missing_bbo: 'one or more option legs lack a real two-sided market',
            crossed_market: 'one or more option markets are crossed',
            wide_market: 'one or more option bid/ask spreads are too wide',
            mixed_snapshot: 'call/put quotes do not belong to the same coherent snapshot',
            missing_row_snapshot: 'the option row has no coherent snapshot identity',
            underlying_stale_mix: 'the option and underlying quotes are not contemporaneous',
            non_market_mark: 'the option mark is not a real two-sided bid/ask midpoint',
            incomplete_price_inputs: 'strike or contemporaneous underlying price is missing',
            forward_mismatch: 'call-put parity forward is too far from the contemporaneous underlying forward',
            invalid_parity_forward: 'call-put parity produced an invalid forward',
            straddle_inversion_failed: 'the observed straddle cannot be inverted to a valid total variance',
        };
        const intervals = impliedLambda && Array.isArray(impliedLambda.intervals)
            ? impliedLambda.intervals
            : [];
        const rowExpiry = normalizeExpiryKey(row && row.expiry);
        const interval = intervals.find((entry) => entry && entry.endExpiry === rowExpiry) || null;
        if (!interval) {
            const diagnostics = impliedLambda && Array.isArray(impliedLambda.rowDiagnostics)
                ? impliedLambda.rowDiagnostics
                : [];
            const diagnostic = diagnostics.find((entry) => (
                entry && normalizeExpiryKey(entry.expiry) === rowExpiry && entry.status !== 'ok'
            ));
            if (diagnostic) {
                const title = `${rowExpiry} — not estimable: ${reasons[diagnostic.status] || diagnostic.status}.`;
                return `<span class="ivts-missing" title="${escapeHtml(title)}">--</span>`;
            }
            return '';
        }
        const dates = Array.isArray(interval.nonTradingDates) ? interval.nonTradingDates.join(', ') : '';
        if (interval.status !== 'ok') {
            const raw = Number.isFinite(interval.rawLambda)
                ? ` Raw λ=${interval.rawLambda}.`
                : '';
            const title = `${dates || rowExpiry} — not estimable: ${reasons[interval.status] || interval.status}.${raw}`;
            return `<span class="ivts-missing" title="${escapeHtml(title)}">--</span>`;
        }
        const discounting = impliedLambda && impliedLambda.methodology
            && impliedLambda.methodology.discounting || impliedLambda && impliedLambda.discounting || null;
        let discountLabel = `manual fallback r=${impliedLambda && Number.isFinite(impliedLambda.interestRate)
            ? (impliedLambda.interestRate * 100).toFixed(2)
            : '4.00'}%`;
        if (discounting && discounting.curveRowCount > 0) {
            const curveName = discounting.isProxy ? 'reference discount proxy r/D' : 'discount curve r/D';
            discountLabel = `per-expiry ${curveName}${discounting.curveAsOf ? ` as of ${discounting.curveAsOf}` : ''}`;
            if (discounting.fallbackRowCount > 0) {
                discountLabel += `; ${discounting.fallbackRowCount} row(s) used manual fallback`;
            }
        }
        const sourceLabel = impliedLambda && impliedLambda.varianceSource === 'vendor_iv'
            ? 'vendor IV'
            : `ATM straddle prices, parity-forward discounted inversion using ${discountLabel}`;
        const rawLambda = Number.isFinite(interval.rawLambda)
            ? interval.rawLambda
            : (Number.isFinite(interval.lambda) ? interval.lambda : null);
        if (rawLambda === null) {
            return '<span class="ivts-missing" title="Missing raw lambda diagnostic">--</span>';
        }
        const inversionLabel = rawLambda < 0 ? ' Inverted term structure; signed λ is preserved.' : '';
        const baselineLabel = interval.baselineMode === 'nearest_extrapolated'
            ? '; nearest-baseline extrapolation'
            : '';
        const clockLabel = interval.profileClockFallback
            ? '; product-profile expiry clock fallback'
            : '';
        const title = `Implied weight of ${dates} solved from adjacent-expiry forward variance`
            + ` (${sourceLabel}; baseline n=${interval.baselineCount}${baselineLabel}${clockLabel}${interval.isFront ? '; verified front interval' : ''}).`
            + ` Raw λ=${rawLambda}.`;
        const valueClass = rawLambda < 0 ? 'ivts-ratio ivts-lambda-inverted' : 'ivts-ratio';
        return `<span class="${valueClass}" title="${escapeHtml(title + inversionLabel)}">${escapeHtml(rawLambda.toFixed(3))}</span>`;
    }

    function buildVarianceRecoveryControl(card, comparedRows) {
        const detailRows = getPrimaryExpiryRows(comparedRows);
        let strictMissingCount = 0;
        let recoverableCount = 0;
        let estimatedCount = 0;
        for (const row of detailRows) {
            const strict = resolveTotalVarianceObservation(row);
            if (strict) continue;
            strictMissingCount += 1;
            const estimate = resolveTotalVarianceObservation(row, { bestEffort: true });
            if (estimate) {
                recoverableCount += 1;
                if (card && card.varianceBestEffortEnabled) estimatedCount += 1;
            }
        }
        const enabled = !!(card && card.varianceBestEffortEnabled);
        const buttonLabel = enabled ? 'Strict Var Only' : 'Estimate Missing Var';
        const summary = enabled
            ? `Best-effort on · ${estimatedCount} recovered · estimated values are marked ≈`
            : (!detailRows.length
                ? 'Sync expiry data first; strict BBO remains the default.'
                : (recoverableCount
                ? `${recoverableCount} of ${strictMissingCount} missing variance rows can be recovered from the displayed Straddle marks.`
                : (strictMissingCount
                    ? `${strictMissingCount} variance rows are missing, but their displayed marks are not sufficient for inversion.`
                    : 'All visible variance rows currently have strict two-sided BBO evidence.')));
        return `
            <div class="ivts-variance-recovery ${enabled ? 'is-enabled' : ''}">
                <button class="ivts-btn ivts-btn-auto ${enabled ? 'is-running' : ''}" data-action="variance-best-effort" data-symbol="${escapeHtml(card.symbol)}" type="button" ${!enabled && recoverableCount === 0 ? 'disabled' : ''}>${escapeHtml(buttonLabel)}</button>
                <span>${escapeHtml(summary)}</span>
            </div>
        `;
    }

    function buildPrimaryExpiryTable(comparedRows, options = {}) {
        const detailRows = getPrimaryExpiryRows(comparedRows);
        const baselineExpiry = comparedRows.baselineExpiry;
        const impliedLambda = comparedRows.impliedLambda;
        const usableIntervals = impliedLambda && Array.isArray(impliedLambda.intervals)
            ? impliedLambda.intervals.filter(interval => interval && interval.status === 'ok')
            : [];
        const invertedCount = usableIntervals.filter(interval => Number(interval.rawLambda) < 0).length;
        const extrapolatedCount = usableIntervals.filter(
            interval => interval.baselineMode === 'nearest_extrapolated'
        ).length;
        const profileClockCount = usableIntervals.filter(
            interval => interval.profileClockFallback === true
        ).length;
        const coverageNotes = [];
        if (impliedLambda && Number.isFinite(impliedLambda.okIntervalCount)) {
            coverageNotes.push(`Impl λ covers ${impliedLambda.okIntervalCount} weekend${impliedLambda.okIntervalCount === 1 ? '' : 's'}`);
        }
        if (invertedCount) coverageNotes.push(`${invertedCount} inverted (signed)`);
        if (extrapolatedCount) coverageNotes.push(`${extrapolatedCount} nearest-baseline estimate${extrapolatedCount === 1 ? '' : 's'}`);
        if (profileClockCount) coverageNotes.push(`${profileClockCount} product-profile clock fallback${profileClockCount === 1 ? '' : 's'}`);
        const impliedCoverageNote = coverageNotes.length
            ? ` · ${coverageNotes.join(' · ')}`
            : '';
        const tdIvSourceNote = detailRows.some((row) => row && row.tdIvSource === 'implied_lambda')
            ? ` · TD IV: ${impliedLambda && impliedLambda.varianceSource === 'vendor_iv'
                ? 'vendor-IV fallback λ'
                : 'price-derived implied λ'} (median extrapolated outside direct coverage)`
            : ' · TD IV: fallback scalar λ';
        const totalVarianceCells = [];
        const forwardVarianceCells = [];
        let previousExpiryRow = null;
        const varianceOptions = { bestEffort: options.bestEffort === true };
        for (const row of detailRows) {
            totalVarianceCells.push(buildTotalVarianceCell(row, previousExpiryRow, varianceOptions));
            forwardVarianceCells.push(buildForwardVarianceCell(row, previousExpiryRow, varianceOptions));
            // Fwd Var is adjacent-expiry by definition. Never bridge across a
            // missing row; best-effort mode can explicitly recover that row.
            previousExpiryRow = row;
        }
        return `
            <div class="ivts-table-caption">All Expiries (${detailRows.length})${escapeHtml(tdIvSourceNote)}${escapeHtml(impliedCoverageNote)}</div>
            <div class="ivts-table-shell ivts-details-table-shell">
                <table class="ivts-table ivts-table-details">
                    <thead>
                        <tr>
                            <th>Expiry</th>
                            <th>DTE</th>
                            <th>ATM Straddle</th>
                            <th title="Cumulative ATM total variance inverted from the real two-sided Call+Put BBO midpoint straddle, displayed as W×10,000. With best-effort enabled, missing strict rows may use displayed Call/Put marks and are marked ≈. Vendor IV, fitted λ, and TD IV are never used directly.">Total Var</th>
                            <th title="Adjacent-expiry annualized forward variance (W₂−W₁)/(T₂−T₁), displayed as FV×10,000. It never bridges a missing expiry. With best-effort enabled, any interval using an estimated endpoint is marked ≈.">Fwd Var</th>
                            <th>Call/Put IV</th>
                            <th title="TWS Call/Put IV re-annualized after the coherent straddle surface solves implied λ. Directly covered dates use their own λ; later uncovered dates use the current implied-λ median as an explicitly marked display extrapolation.">TD IV</th>
                            <th title="Ratio of the displayed ATM TD IV versus the baseline expiry, shorter leg on top. This uses the same implied-λ-corrected values shown in TD IV; the separate strategy signal remains frozen at λ=0.3.">TD Slope</th>
                            <th>Vs Base</th>
                            <th title="Option-implied weight of the non-trading days ending at this expiry (weekend/holiday), solved from adjacent-expiry forward variance against a nearby pure trading-day baseline. Published to the simulator as a per-date array.">Impl λ</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${detailRows.map((row, rowIndex) => `
                            <tr class="${row.isStraddleBaseline ? 'is-straddle-baseline' : ''}">
                                <td>${escapeHtml(row.expiry)}</td>
                                <td>${escapeHtml(row.dte)}</td>
                                <td>${buildStraddlePriceCell(row)}</td>
                                <td>${totalVarianceCells[rowIndex]}</td>
                                <td>${forwardVarianceCells[rowIndex]}</td>
                                <td>${buildIvPairCell(row)}</td>
                                <td>${buildIvPairTdCell(row)}</td>
                                <td>${buildTdSlopeCell(row, baselineExpiry)}</td>
                                <td>${buildStraddleRatioCell(row, baselineExpiry)}</td>
                                <td>${buildImpliedLambdaCell(row, impliedLambda)}</td>
                            </tr>
                        `).join('') || `
                            <tr>
                                <td colspan="10" class="ivts-missing">No expiry rows have been synced yet.</td>
                            </tr>
                        `}
                    </tbody>
                </table>
            </div>
        `;
    }

    const STRATEGY_ZONE_LABELS = Object.freeze({
        long_displacement: 'LONG DISPLACEMENT',
        stand_down: 'STAND DOWN',
        sell_calendar: 'SELL CALENDAR',
        calendar_unavailable: 'CALENDAR UNAVAILABLE',
        preview: 'PREVIEW / NO ACTION',
        mrr_unavailable: 'MRR UNAVAILABLE',
        no_signal: 'NO SIGNAL',
    });

    function buildStrategySignalPanel(card, comparedRows, historyDocument, nowValue = new Date()) {
        const coreApi = core();
        if (typeof coreApi.computeRegimeSignal !== 'function') {
            return '';
        }
        const detailRows = comparedRows && Array.isArray(comparedRows.detailRows)
            ? comparedRows.detailRows
            : [];
        const samples = historyDocument && Array.isArray(historyDocument.samples)
            ? historyDocument.samples
            : [];
        const signal = coreApi.computeRegimeSignal(detailRows);
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        const calendarId = resolveCardCalendarId(card);
        const signalReadiness = evaluateWeeklySignalReadiness(card, nowValue, { detailRows, signal });
        const watermark = coreApi.computeDisplacementWatermark(samples, {
            // MRR freshness is judged against wall-clock now. The signal's
            // close timestamp authenticates that signal only; it must not
            // rewind the watermark staleness clock.
            asOf: nowValue,
            calendarKey: calendarId,
        });
        const coverageStart = signal.status === 'ok'
            ? String(card && card.catalog && card.catalog.anchorDate || signal.front.expiry || '')
            : '';
        const coverageEnd = signal.status === 'ok' ? signal.back.expiry : coverageStart;
        const calendarAvailable = typeof globalScope.isOfficialExchangeCalendarAvailable === 'function'
            ? globalScope.isOfficialExchangeCalendarAvailable(calendarId, coverageStart, coverageEnd)
            : calendarId === 'NYSE';
        let suggestion = signal.status !== 'ok' || calendarAvailable
            ? coreApi.buildStrategySuggestion(signal, watermark)
            : { stance: 'calendar_unavailable', structure: null, exitRule: null };
        if (signal.status === 'ok' && calendarAvailable && !signalReadiness.actionable) {
            suggestion = signalReadiness.signalComplete
                ? { stance: 'awaiting_execution_protocol', structure: null, exitRule: null }
                : { stance: 'awaiting_official_close', structure: null, exitRule: null };
        }

        const signalZone = signal.status === 'ok'
            ? (calendarAvailable ? signal.zone : 'calendar_unavailable')
            : 'no_signal';
        const zone = signalZone === 'calendar_unavailable' || signalZone === 'no_signal'
            ? signalZone
            : (!signalReadiness.actionable
                ? 'preview'
                : (suggestion.stance === 'awaiting_watermark' ? 'mrr_unavailable' : signalZone));
        const calendarNote = calendarAvailable
            ? ''
            : ` · calendar unavailable (${escapeHtml(calendarId)} official snapshot missing/stale)`;
        const slopeText = signal.status === 'ok'
            ? `${signal.slope.toFixed(3)} · F ${escapeHtml(signal.front.expiry)} (${signal.front.dte}d) / B ${escapeHtml(signal.back.expiry)} (${signal.back.dte}d)${calendarNote}`
            : escapeHtml(signal.reason || 'sync the nearest expiries first');
        const signalDefaults = coreApi.STRATEGY_SIGNAL_DEFAULTS || {};
        const zoneLow = Number.isFinite(signalDefaults.zoneLow) ? signalDefaults.zoneLow : 0.95;
        const zoneHigh = Number.isFinite(signalDefaults.zoneHigh) ? signalDefaults.zoneHigh : 1.05;
        const zoneMapText = [
            { key: 'long_displacement', text: `<${zoneLow.toFixed(2)} reverse fly` },
            { key: 'stand_down', text: `${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)} stand down` },
            { key: 'sell_calendar', text: `>${zoneHigh.toFixed(2)} calendar` },
        ].map((segment) => `<span class="ivts-zone-seg${signalZone === segment.key ? ' is-active' : ''}">${escapeHtml(segment.text)}</span>`)
            .join('<span class="ivts-zone-sep">·</span>');
        const watermarkValue = watermark.status === 'ok'
            ? `${watermark.mean.toFixed(2)} (n=${watermark.count})`
            : (watermark.status === 'collecting'
                ? `collecting ${watermark.count}/${watermark.required}`
                : `n=${watermark.count}/${watermark.required}`);
        const watermarkDiagnostics = [
            Number(watermark.missingOfficialCloseWeeks) > 0
                ? `${watermark.missingOfficialCloseWeeks} missing weekly close`
                : '',
            Number(watermark.incompleteOfficialCloseWeeks) > 0
                ? `${watermark.incompleteOfficialCloseWeeks} incomplete weekly close`
                : '',
        ].filter(Boolean).join(' · ');
        const watermarkText = watermark.status === 'ok'
            ? `${watermarkValue}${watermark.latestObservationDate ? ` · through ${watermark.latestObservationDate}` : ''}`
            : `${watermark.status}${watermark.reason ? `: ${watermark.reason}` : ''}`
                + `${watermark.latestObservationDate ? ` · last ${watermark.latestObservationDate}` : ''}`
                + ` · ${watermarkValue}${watermarkDiagnostics ? ` · ${watermarkDiagnostics}` : ''}`;
        const readinessLabels = {
            ok: 'official weekly close observed / no action',
            missing_snapshot: 'no timestamped snapshot',
            calendar_unavailable: 'official calendar unavailable',
            partial_week: `partial week; expected ${signalReadiness.expectedSession || '--'}`,
            pre_close: 'preview before official option close',
            close_time_unavailable: 'official option close time unavailable',
            missing_timestamp: 'snapshot timestamp missing',
            future: 'future-dated snapshot rejected',
            off_session_snapshot: 'snapshot is not from the official weekly-close session',
            stale_anchor: `stale anchor; expected ${signalReadiness.expectedSession || '--'}`,
            missing_snapshot_timestamp: 'server snapshot timestamp missing',
            missing_snapshot_id: 'server snapshot id missing',
            incoherent_snapshot: 'server reports an incremental/incomplete curve',
            insufficient_signal: 'required signal legs unavailable',
            missing_snapshot_leg: 'required snapshot leg missing',
            mixed_snapshot_legs: 'required legs span different snapshots',
            stale_snapshot_leg: 'required leg quote is stale within the snapshot',
            execution_protocol_unavailable: 'official signal complete; no next-session execution protocol',
        };
        const signalAsOfText = signalReadiness.signalAsOf
            ? `${signalReadiness.signalAsOf} · ${readinessLabels[signalReadiness.status] || signalReadiness.status}`
            : (readinessLabels[signalReadiness.status] || signalReadiness.status);
        const benchmarkFamily = String(profile && (profile.enteredSymbol || profile.family) || (card && card.symbol) || '').toUpperCase();
        const mrrBenchmark = typeof coreApi.getMrrResearchBenchmark === 'function'
            ? coreApi.getMrrResearchBenchmark(benchmarkFamily)
            : null;
        const mrrBenchmarkRow = mrrBenchmark
            ? `<div class="ivts-strategy-row" title="${escapeHtml(`Deep-contango era means from the E10/E11 backtests, measured on ${mrrBenchmark.measuredOn} chains. Reference only — the live per-symbol MRR above decides the gate. ${mrrBenchmark.note}`)}">`
                + '<span>MRR research ref</span>'
                + `<span>${escapeHtml(mrrBenchmark.eras.map((era) => `${era.span} ${era.value.toFixed(2)}`).join(' · '))} (${escapeHtml(mrrBenchmark.label)}${mrrBenchmark.measuredOn === benchmarkFamily ? '' : ` via ${escapeHtml(mrrBenchmark.measuredOn)}`})</span>`
                + '</div>'
            : '';
        const suggestionText = suggestion.structure
            ? `${suggestion.structure} — ${suggestion.exitRule}`
            : (suggestion.stance === 'no_signal'
                ? 'No signal: subscribe/sync the ~7d and ~14d expiries.'
                : (suggestion.stance === 'calendar_unavailable'
                    ? `${calendarId} official trading calendar is unavailable — no strategy suggestion.`
                    : (suggestion.stance === 'awaiting_execution_protocol'
                        ? 'Preview only: the official weekly-close signal is complete, but no backtested next-session execution protocol exists.'
                    : (suggestion.stance === 'awaiting_official_close'
                        ? 'Preview only: sync the official final weekly session after option close before acting.'
                    : (suggestion.stance === 'awaiting_watermark'
                        ? 'Zone favors reverse fly, but the watermark must prove it first — keep weekly samples, no structure yet.'
                        : 'No options this week; delta book only.')))));
        const panelTitle = signal.status !== 'ok'
            ? 'Sync the required front and back expiries before evaluating the official-calendar strategy signal.'
            : (calendarAvailable
            ? 'Frozen playbook from VRP_RESEARCH_MEMO.md: slope<0.95 reverse iron fly (hold), 0.95-1.05 stand down, >1.05 calendar (tp50). Signal lambda fixed at 0.3 regardless of the TD IV display lambda. Official-close signals remain preview-only until a next-session execution protocol is separately backtested; reverse-fly research also requires fresh, verified weekly-close MRR history.'
            : `${calendarId} official trading calendar is missing or does not cover these expiries. No strategy suggestion is produced.`);

        return `
            <div class="ivts-strategy-signal is-${escapeHtml(zone)}"
                title="${escapeHtml(panelTitle)}">
                <div class="ivts-strategy-headline">
                    <span class="ivts-strategy-zone">${STRATEGY_ZONE_LABELS[zone] || zone}</span>
                    <span class="ivts-strategy-disclaimer">suggestion only · paper/sim first</span>
                </div>
                <div class="ivts-strategy-row"><span>TD slope (λ=0.3)</span><span>${slopeText}</span></div>
                <div class="ivts-strategy-row"><span>Signal as of</span><span>${escapeHtml(signalAsOfText)}</span></div>
                <div class="ivts-strategy-row"><span>Zones</span><span class="ivts-zone-map">${zoneMapText}</span></div>
                <div class="ivts-strategy-row"><span>MRR watermark (|move|/EM)</span><span>${watermarkText}</span></div>
                ${mrrBenchmarkRow}
                <div class="ivts-strategy-row ivts-strategy-suggestion"><span>This week</span><span>${escapeHtml(suggestionText)}</span></div>
            </div>
        `;
    }

    function buildImpliedLambdaPanel(card, nowValue = Date.now()) {
        const entry = card && card.impliedLambdaComputedEntry;
        const snapshot = card && card.lambdaSnapshot;
        const snapshotFreshness = evaluateLambdaSnapshotFreshness(snapshot, nowValue);
        const bestEffortSource = buildBestEffortLambdaSnapshot(card, nowValue);
        const vendorIvSource = buildVendorIvLambdaSource(card, nowValue);
        const calculationReady = snapshotFreshness.fresh
            || bestEffortSource.ok || vendorIvSource.ok;
        const byDateEntries = entry && entry.byDate && typeof entry.byDate === 'object'
            ? Object.entries(entry.byDate).sort(([left], [right]) => left.localeCompare(right))
            : [];
        const isBestEffort = !!(entry && entry.quality
            && entry.quality.estimationMode === 'best_effort');
        const isVendorIvFallback = !!(entry
            && entry.varianceSource === 'vendor_iv'
            && entry.quality
            && entry.quality.sourceQuoteEvidence === 'vendor_atm_iv_fallback');
        const synchronized = !!entry
            && String(card.impliedLambdaPublishedSnapshotId || '').trim()
                === String(entry.snapshotId || '').trim()
            && card.impliedLambdaPublicationResult
            && card.impliedLambdaPublicationResult.ok === true;
        const needsRecalculation = !!entry && (
            card.impliedLambdaNeedsRecalculation === true
            || (!!snapshot && String(snapshot.snapshotId || '').trim()
                !== String(entry.snapshotId || '').trim())
        );
        const statusClass = !entry
            ? 'is-empty'
            : (synchronized ? 'is-synced' : (isBestEffort ? 'is-estimated' : 'is-calculated'));
        const statusLabel = !entry
            ? 'Not calculated'
            : (synchronized
                ? `${isVendorIvFallback ? 'Vendor-IV fallback · ' : (isBestEffort ? 'Best-effort · ' : '')}${needsRecalculation ? 'Synced · newer quotes available' : 'Synced'}`
                : `${isVendorIvFallback ? 'Vendor-IV fallback' : (isBestEffort ? 'Best-effort estimate' : 'Calculated')}${needsRecalculation ? ' · newer quotes available' : ' · not synced'}`);
        const structureRows = byDateEntries.map(([date, lambda]) => `
            <div class="ivts-lambda-date-row">
                <time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>
                <strong class="${Number(lambda) < 0 ? 'ivts-lambda-inverted' : ''}">λ ${escapeHtml(formatNumber(lambda, 4))}</strong>
            </div>
        `).join('');
        const note = !entry
            ? 'Press Calculate λ to use a strict snapshot when available, then usable two-sided BBO pairs, and finally the visible ATM Call/Put IV pairs.'
            : (needsRecalculation
                ? `The displayed ${isVendorIvFallback ? 'vendor-IV fallback' : (isBestEffort ? 'best-effort estimate' : 'curve')} is frozen. Newer quotes are available; recalculate only when you want to replace it.`
                : `This ${isVendorIvFallback ? 'vendor-IV fallback' : (isBestEffort ? 'best-effort estimate' : 'structured curve')} is frozen and will not move with individual option ticks.`);
        const sourceStatus = snapshotFreshness.fresh
            ? 'Strict coherent source ready'
            : (bestEffortSource.ok
                ? `Best-effort ready · ${bestEffortSource.usableExpiryCount} expiries usable${bestEffortSource.skippedExpiryCount ? ` · ${bestEffortSource.skippedExpiryCount} skipped` : ''}`
                : (vendorIvSource.ok
                    ? `ATM-IV fallback ready · ${vendorIvSource.usableExpiryCount} expiries usable${vendorIvSource.skippedExpiryCount ? ` · ${vendorIvSource.skippedExpiryCount} skipped` : ''}`
                    : 'Waiting for at least two usable Call/Put IV pairs'));
        const invertedIntervalCount = Number(entry && entry.quality
            && entry.quality.invertedIntervalCount) || 0;
        const extrapolatedBaselineIntervalCount = Number(entry && entry.quality
            && entry.quality.extrapolatedBaselineIntervalCount) || 0;
        const profileClockFallbackIntervalCount = Number(entry && entry.quality
            && entry.quality.profileClockFallbackIntervalCount) || 0;
        const qualityParts = !entry ? [] : [
            isVendorIvFallback
                ? `${Number(entry.quality && entry.quality.usableExpiryCount) || 0} ATM-IV pairs · vendor fallback`
                : (isBestEffort
                ? `${Number(entry.quality && entry.quality.usableExpiryCount) || 0} used · ${Number(entry.quality && entry.quality.skippedExpiryCount) || 0} skipped`
                : 'Strict snapshot'),
        ];
        if (invertedIntervalCount) qualityParts.push(`${invertedIntervalCount} inverted`);
        if (extrapolatedBaselineIntervalCount) {
            qualityParts.push(`${extrapolatedBaselineIntervalCount} baseline extrapolated`);
        }
        if (profileClockFallbackIntervalCount) {
            qualityParts.push(`${profileClockFallbackIntervalCount} profile-clock fallback`);
        }
        const qualityText = qualityParts.length ? qualityParts.join(' · ') : '--';

        return `
            <section class="ivts-lambda-panel" aria-label="${escapeHtml(card.symbol)} structured implied lambda">
                <div class="ivts-lambda-panel-head">
                    <div>
                        <span class="ivts-lambda-eyebrow">Manual pricing snapshot</span>
                        <h3>Structured implied λ</h3>
                    </div>
                    <span class="ivts-lambda-state ${statusClass}" data-lambda-field="state">${escapeHtml(statusLabel)}</span>
                </div>
                <p class="ivts-lambda-note" data-lambda-field="note">${escapeHtml(note)}</p>
                <div class="ivts-lambda-metrics">
                    <div><span>Median λ</span><strong data-lambda-field="median">${entry ? escapeHtml(formatNumber(entry.medianLambda, 4)) : '--'}</strong></div>
                    <div><span>Structured dates</span><strong data-lambda-field="date-count">${byDateEntries.length}</strong></div>
                    <div><span>Coverage</span><strong data-lambda-field="coverage">${entry ? escapeHtml(`${entry.coverageStart || '--'} → ${entry.coverageEnd || '--'}`) : '--'}</strong></div>
                    <div><span>Calculated</span><strong data-lambda-field="calculated">${entry ? escapeHtml(formatTimestamp(card.impliedLambdaComputedAt)) : '--'}</strong></div>
                    <div><span>Market snapshot</span><strong data-lambda-field="market-snapshot">${entry ? escapeHtml(formatTimestamp(entry.quoteAsOf)) : '--'}</strong></div>
                    <div><span>Source ID</span><strong data-lambda-field="source-id" title="${entry ? escapeHtml(entry.snapshotId || '') : ''}">${entry ? escapeHtml(String(entry.snapshotId || '').slice(0, 12)) : '--'}</strong></div>
                    <div><span>Quote quality</span><strong data-lambda-field="quote-quality">${escapeHtml(qualityText)}</strong></div>
                </div>
                <div class="ivts-lambda-actions">
                    <button class="ivts-btn ivts-btn-primary" data-action="implied-lambda-calculate" data-symbol="${escapeHtml(card.symbol)}" type="button" ${calculationReady ? '' : 'disabled'}>Calculate λ</button>
                    <button class="ivts-btn ivts-btn-auto" data-action="implied-lambda-sync" data-symbol="${escapeHtml(card.symbol)}" type="button" ${entry ? '' : 'disabled'}>Sync to Simulators</button>
                    <button class="ivts-btn ivts-btn-muted" data-action="implied-lambda-export" data-symbol="${escapeHtml(card.symbol)}" type="button" ${entry ? '' : 'disabled'}>Export JSON</button>
                    <span class="ivts-lambda-source-status" data-lambda-field="source-status">${escapeHtml(sourceStatus)}</span>
                </div>
                <details class="ivts-details ivts-lambda-structure" ${entry ? '' : 'hidden'}>
                    <summary data-lambda-field="structure-summary">Exact date → λ structure (${byDateEntries.length})</summary>
                    <div class="ivts-lambda-date-grid" data-lambda-field="structure-grid">
                        ${structureRows || '<span class="ivts-missing">No structured dates</span>'}
                    </div>
                </details>
            </section>
        `;
    }

    function updateImpliedLambdaPanelElement(currentPanel, nextPanel) {
        if (!currentPanel || !nextPanel) {
            return false;
        }

        currentPanel.className = nextPanel.className;
        const ariaLabel = nextPanel.getAttribute('aria-label');
        if (ariaLabel) {
            currentPanel.setAttribute('aria-label', ariaLabel);
        }

        nextPanel.querySelectorAll('[data-lambda-field]').forEach((nextNode) => {
            const field = nextNode.getAttribute('data-lambda-field');
            const currentNode = currentPanel.querySelector(`[data-lambda-field="${field}"]`);
            if (!currentNode) {
                return;
            }
            currentNode.className = nextNode.className;
            if (field === 'structure-grid') {
                currentNode.innerHTML = nextNode.innerHTML;
            } else {
                currentNode.textContent = nextNode.textContent;
            }
            if (nextNode.hasAttribute('title')) {
                currentNode.setAttribute('title', nextNode.getAttribute('title'));
            } else {
                currentNode.removeAttribute('title');
            }
        });

        nextPanel.querySelectorAll('[data-action^="implied-lambda-"]').forEach((nextButton) => {
            const action = nextButton.getAttribute('data-action');
            const currentButton = currentPanel.querySelector(`[data-action="${action}"]`);
            if (!currentButton) {
                return;
            }
            currentButton.disabled = nextButton.disabled;
            currentButton.hidden = nextButton.hidden;
            currentButton.className = nextButton.className;
            currentButton.textContent = nextButton.textContent;
            currentButton.setAttribute('data-symbol', nextButton.getAttribute('data-symbol') || '');
        });

        const currentStructure = currentPanel.querySelector('.ivts-lambda-structure');
        const nextStructure = nextPanel.querySelector('.ivts-lambda-structure');
        if (currentStructure && nextStructure) {
            currentStructure.hidden = nextStructure.hidden;
        }
        return true;
    }

    function replaceCardBodyMarkup(card, bodyNode) {
        const markup = buildCardBodyMarkup(card);
        const currentPanel = bodyNode.querySelector('.ivts-lambda-panel');
        if (!currentPanel || !document || typeof document.createElement !== 'function') {
            bodyNode.innerHTML = markup;
            return false;
        }

        const template = document.createElement('template');
        template.innerHTML = markup;
        const nextPanel = template.content.querySelector('.ivts-lambda-panel');
        if (!nextPanel || !updateImpliedLambdaPanelElement(currentPanel, nextPanel)) {
            bodyNode.innerHTML = markup;
            return false;
        }

        // Quote ticks still refresh the rest of the expanded card, but the
        // manual lambda panel remains attached. Keeping this exact subtree
        // preserves pointer hover/focus and prevents its button transitions
        // from restarting every 120 ms.
        const nextNodes = Array.from(template.content.childNodes);
        const panelIndex = nextNodes.indexOf(nextPanel);
        if (panelIndex < 0) {
            bodyNode.innerHTML = markup;
            return false;
        }
        Array.from(bodyNode.childNodes).forEach((node) => {
            if (node !== currentPanel) {
                bodyNode.removeChild(node);
            }
        });
        nextNodes.slice(0, panelIndex).forEach((node) => {
            bodyNode.insertBefore(node, currentPanel);
        });
        nextNodes.slice(panelIndex + 1).forEach((node) => {
            bodyNode.appendChild(node);
        });
        return true;
    }

    function buildCardBodyMarkup(card) {
        const historyDocument = strategyHistoryDocument(card);
        const autoHistoryDocument = normalizeAutoHistoryDocument(card.autoHistoryDocument, card.symbol);
        const autoStatus = card.autoSamplingEnabled
            ? (card.autoSampleInProgress ? 'Sampling now' : `Running hourly · ${card.autoFileName || 'auto JSON'}`)
            : (card.autoFileHandle ? 'Paused' : 'Not configured');
        const comparedRows = buildComparedRows(card);
        return `
            <div class="ivts-status ${card.statusKind ? `is-${escapeHtml(card.statusKind)}` : ''}">
                ${escapeHtml(card.statusMessage)}
            </div>

            ${buildImpliedLambdaPanel(card)}
            ${buildStrategySignalPanel(card, comparedRows, historyDocument)}
            ${buildOptionStreamLimitControl(card)}

            <details class="ivts-details ivts-sampling-details">
                <summary>
                    <span>Sampling details</span>
                    <span class="ivts-details-summary-meta">
                        Underlying ${card.underlyingPrice != null ? `$${formatNumber(card.underlyingPrice, 2)}` : '--'}
                        · ${historyDocument.samples.length} combined
                        · ${autoHistoryDocument.samples.length} auto
                    </span>
                </summary>
                <div class="ivts-facts">
                    <div class="ivts-fact">
                        <span class="ivts-fact-label">Underlying</span>
                        <span class="ivts-fact-value">${card.underlyingPrice != null ? `$${formatNumber(card.underlyingPrice, 2)}` : '--'}</span>
                    </div>
                    <div class="ivts-fact">
                        <span class="ivts-fact-label">Combined Samples</span>
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
                    <div class="ivts-fact">
                        <span class="ivts-fact-label">Auto Samples</span>
                        <span class="ivts-fact-value">${autoHistoryDocument.samples.length}</span>
                    </div>
                    <div class="ivts-fact">
                        <span class="ivts-fact-label">Auto Sampling</span>
                        <span class="ivts-fact-value">${escapeHtml(autoStatus)}</span>
                        <span class="ivts-fact-note">Last: ${escapeHtml(formatTimestamp(card.lastAutoSampleLabel))}</span>
                    </div>
                    <div class="ivts-fact">
                        <span class="ivts-fact-label">Append Target</span>
                        <span class="ivts-fact-value">${escapeHtml(autoAppendTargetLabel(card))}</span>
                        <span class="ivts-fact-note">Hourly automatic samples are written only to this file.</span>
                    </div>
                </div>
            </details>

            ${buildBaselineControl(card, comparedRows)}
            ${buildCalendarFinderSection(card, comparedRows)}
            ${buildVarianceRecoveryControl(card, comparedRows)}
            ${buildPrimaryExpiryTable(comparedRows, { bestEffort: card.varianceBestEffortEnabled === true })}
            ${buildBucketSummaryTable(comparedRows)}
        `;
    }

    function buildOptionStreamLimitControl(card) {
        const selectedLimit = normalizeOptionStreamLimit(card && card.maxOptionStreams);
        const selectedExpiryCount = selectedLimit > 0 ? Math.floor(selectedLimit / 2) : null;
        return `
            <div class="ivts-subscription-control">
                <label class="ivts-subscription-field">
                    <span>Live Option Streams</span>
                    <select data-action="option-stream-limit" data-symbol="${escapeHtml(card.symbol)}">
                        <option value="10" ${selectedLimit === 10 ? 'selected' : ''}>10 streams (5 expiries)</option>
                        <option value="20" ${selectedLimit === 20 ? 'selected' : ''}>20 streams (10 expiries)</option>
                        <option value="40" ${selectedLimit === 40 ? 'selected' : ''}>40 streams (20 expiries)</option>
                        <option value="0" ${selectedLimit === 0 ? 'selected' : ''}>All streams</option>
                    </select>
                </label>
                <span class="ivts-subscription-summary">
                    ${selectedExpiryCount == null
                        ? 'Subscribe every available expiry.'
                        : `Subscribe the nearest ${selectedExpiryCount} expiries first.`}
                </span>
                ${buildFuturesContractControl(card)}
            </div>
        `;
    }

    function buildFuturesContractControl(card) {
        const profile = card && card.profile ? card.profile : resolveProfile(card && card.symbol);
        if (!isFuturesOptionProfile(profile)) {
            return '';
        }

        const contractMonth = normalizeFuturesContractMonth(card && card.futuresContractMonth);
        const underlyingSymbol = profile.underlyingSymbol || card.symbol;
        return `
            <label class="ivts-futures-field">
                <span>Underlying FUT Month</span>
                <input
                    data-action="futures-contract-month"
                    data-symbol="${escapeHtml(card.symbol)}"
                    type="text"
                    inputmode="numeric"
                    pattern="\\d{6}"
                    maxlength="6"
                    placeholder="YYYYMM"
                    value="${escapeHtml(contractMonth)}"
                >
            </label>
            <span class="ivts-futures-summary">${escapeHtml(underlyingSymbol)} ${escapeHtml(contractMonth || 'YYYYMM')}</span>
        `;
    }

    function buildCardHeaderSummary(card) {
        const historyDocument = strategyHistoryDocument(card);
        return `
            <div class="ivts-card-overview" aria-label="${escapeHtml(card.symbol)} summary">
                <span>Underlying <strong data-field="header-underlying">${card.underlyingPrice != null ? `$${formatNumber(card.underlyingPrice, 2)}` : '--'}</strong></span>
                <span>Samples <strong data-field="header-samples">${historyDocument.samples.length}</strong></span>
                <span>Auto <strong data-field="header-auto-status">${card.autoSamplingEnabled ? 'Hourly' : 'Off'}</strong></span>
                <span>Append Target <strong data-field="header-auto-target">${escapeHtml(autoAppendTargetLabel(card))}</strong></span>
                <span>Last Sync <strong data-field="header-last-sync">${escapeHtml(formatTimestamp(card.lastSyncLabel))}</strong></span>
            </div>
            <div class="ivts-card-header-status ${card.statusKind ? `is-${escapeHtml(card.statusKind)}` : ''}" data-field="header-status">
                ${escapeHtml(card.statusMessage)}
            </div>
        `;
    }

    function buildCardMarkup(card) {
        const busy = card.syncInProgress || card.sampleInProgress || card.autoSampleInProgress || card.autoFileSelectionInProgress;
        const sampleDisabled = busy || (!card.currentFileHandle && (globalScope.showOpenFilePicker || !card.historyDocument));
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
                        <button class="ivts-btn ivts-btn-primary" data-action="sync" data-symbol="${escapeHtml(card.symbol)}" ${busy ? 'disabled' : ''}>Sync/Update</button>
                        <button class="ivts-btn ivts-btn-warm" data-action="sample" data-symbol="${escapeHtml(card.symbol)}" ${sampleDisabled ? 'disabled' : ''}>Sample</button>
                        <button class="ivts-btn ivts-btn-auto" data-action="auto-load" data-symbol="${escapeHtml(card.symbol)}" ${busy ? 'disabled' : ''}>Load/Resume Auto JSON</button>
                        <button class="ivts-btn ivts-btn-muted" data-action="auto-new" data-symbol="${escapeHtml(card.symbol)}" ${busy ? 'disabled' : ''}>New Auto JSON</button>
                        <button class="ivts-btn ivts-btn-auto ${card.autoSamplingEnabled ? 'is-running' : ''}" data-action="auto-sample" data-symbol="${escapeHtml(card.symbol)}" ${card.autoFileHandle ? '' : 'hidden'} ${busy ? 'disabled' : ''}>${autoSampleButtonLabel(card)}</button>
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

        const historyDocument = strategyHistoryDocument(card);
        const headerUnderlying = cardNode.querySelector('[data-field="header-underlying"]');
        const headerSamples = cardNode.querySelector('[data-field="header-samples"]');
        const headerAutoStatus = cardNode.querySelector('[data-field="header-auto-status"]');
        const headerAutoTarget = cardNode.querySelector('[data-field="header-auto-target"]');
        const headerLastSync = cardNode.querySelector('[data-field="header-last-sync"]');
        const headerStatus = cardNode.querySelector('[data-field="header-status"]');
        if (headerUnderlying) {
            headerUnderlying.textContent = card.underlyingPrice != null ? `$${formatNumber(card.underlyingPrice, 2)}` : '--';
        }
        if (headerSamples) {
            headerSamples.textContent = String(historyDocument.samples.length);
        }
        if (headerAutoStatus) {
            headerAutoStatus.textContent = card.autoSamplingEnabled
                ? (card.autoSampleInProgress ? 'Sampling' : 'Hourly')
                : (card.autoFileHandle ? 'Paused' : 'Off');
        }
        if (headerAutoTarget) {
            headerAutoTarget.textContent = autoAppendTargetLabel(card);
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

        const busy = card.syncInProgress || card.sampleInProgress || card.autoSampleInProgress || card.autoFileSelectionInProgress;
        const sampleDisabled = busy || (!card.currentFileHandle && (globalScope.showOpenFilePicker || !card.historyDocument));
        const unsubscribeDisabled = !card.ws || (card.ws.readyState !== WebSocket.OPEN && card.ws.readyState !== WebSocket.CONNECTING);
        const openButton = cardNode.querySelector('[data-action="open"]');
        const syncButton = cardNode.querySelector('[data-action="sync"]');
        const sampleButton = cardNode.querySelector('[data-action="sample"]');
        const autoLoadButton = cardNode.querySelector('[data-action="auto-load"]');
        const autoNewButton = cardNode.querySelector('[data-action="auto-new"]');
        const autoSampleButton = cardNode.querySelector('[data-action="auto-sample"]');
        const unsubscribeButton = cardNode.querySelector('[data-action="unsubscribe"]');

        if (openButton) {
            openButton.disabled = false;
        }
        if (syncButton) {
            syncButton.disabled = !!busy;
        }
        if (sampleButton) {
            sampleButton.disabled = !!sampleDisabled;
        }
        if (autoLoadButton) {
            autoLoadButton.disabled = !!busy;
        }
        if (autoNewButton) {
            autoNewButton.disabled = !!busy;
        }
        if (autoSampleButton) {
            autoSampleButton.hidden = !card.autoFileHandle;
            autoSampleButton.disabled = !!busy;
            autoSampleButton.textContent = autoSampleButtonLabel(card);
            autoSampleButton.classList.toggle('is-running', card.autoSamplingEnabled);
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
        replaceCardBodyMarkup(card, bodyNode);
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
        } else {
            return;
        }

        card.calendarFinder = normalizeCalendarFinderConfig(nextConfig);
        saveCalendarFinderConfig(card.symbol, card.calendarFinder);
        card.forceBodyRefreshOnce = true;
        render(true);
    }

    function applyFuturesContractMonthChange(field) {
        const card = getCard(field.getAttribute('data-symbol'));
        if (!card) {
            return;
        }

        // Remove the entry under the old contract-month key before the card
        // adopts the newly selected underlying future.
        withdrawImpliedLambda(card);
        const normalized = normalizeFuturesContractMonth(field.value);
        card.futuresContractMonth = normalized;
        saveFuturesContractMonth(card.symbol, normalized);
        card.catalog = null;
        card.quotesBySubId = {};
        card.lambdaSnapshot = null;
        card.impliedLambdaPublicationResult = null;
        card.impliedLambdaComputedResult = null;
        card.impliedLambdaComputedEntry = null;
        card.impliedLambdaComputedAt = '';
        card.impliedLambdaNeedsRecalculation = false;
        card.underlyingPrice = null;
        card.lastSyncLabel = '';
        card.forceBodyRefreshOnce = true;
        setCardStatus(
            card,
            normalized
                ? `Underlying futures month set to ${normalized}. Sync/Update to load FOP expiries.`
                : 'Enter a 6-digit underlying futures month before syncing this FOP.',
            normalized ? '' : 'error'
        );
        render(true);
    }

    function applyOptionStreamLimitChange(field) {
        const card = getCard(field.getAttribute('data-symbol'));
        if (!card) {
            return;
        }

        const maxOptionStreams = normalizeOptionStreamLimit(field.value);
        card.maxOptionStreams = maxOptionStreams;
        saveOptionStreamLimit(card.symbol, maxOptionStreams);
        card.catalog = null;
        card.quotesBySubId = {};
        card.lambdaSnapshot = null;
        card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
        card.lastSyncLabel = '';
        card.forceBodyRefreshOnce = true;
        setCardStatus(
            card,
            maxOptionStreams > 0
                ? `Option stream limit set to ${maxOptionStreams}. Sync/Update to subscribe the nearest ${Math.floor(maxOptionStreams / 2)} expiries.`
                : 'Option stream limit set to All. Sync/Update to subscribe every available expiry.',
            ''
        );
        render(true);
    }

    function applyTdIvLambdaChange(rawValue) {
        // Shared fallback lens: it re-annualizes already-subscribed quotes
        // only while no qualified straddle-implied curve is available. Once
        // implied lambda exists, strict per-date weights win. Neither path
        // needs a catalog reset or resubscription.
        const lambda = normalizeTdIvLambda(rawValue);
        runtime.tdIvWeekendWeight = lambda;
        saveTdIvLambda(lambda);
        const input = document.getElementById('ivtsTdIvLambdaInput');
        if (input) {
            input.value = lambda.toFixed(2);
        }
        runtime.cardsBySymbol.forEach((card) => {
            card.forceBodyRefreshOnce = true;
        });
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
            underlyingContractMonth: card.futuresContractMonth || null,
            underlyingQuote: card.lambdaSnapshot && card.lambdaSnapshot.underlyingQuote
                ? card.lambdaSnapshot.underlyingQuote
                : null,
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
            clearPendingCatalogTimers(pending);
            pending.reject(new Error('Subscription was cancelled.'));
        }

        card.syncInProgress = false;
        card.sampleInProgress = false;
        card.closeNotice = options.notice || 'Subscription closed. Showing the last received snapshot.';
        card.lambdaSnapshot = null;
        card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;

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
        const firstSuspend = runtime.pageSuspended !== true;
        runtime.pageSuspended = true;
        clearIbStatusPollTimer();
        if (runtime.autoSampleMonitorTimerId != null) {
            clearInterval(runtime.autoSampleMonitorTimerId);
            runtime.autoSampleMonitorTimerId = null;
        }
        if (runtime.discountCurveRefreshTimerId != null) {
            clearInterval(runtime.discountCurveRefreshTimerId);
            runtime.discountCurveRefreshTimerId = null;
        }
        const controlWs = runtime.controlWs;
        runtime.controlWs = null;
        runtime.controlWsOpenPromise = null;
        if (controlWs) {
            try {
                controlWs.close(1000, 'pagehide');
            } catch (_) {
                // Ignore best-effort shutdown failures during page exit.
            }
        }
        runtime.cardsBySymbol.forEach((card) => {
            if (!card) {
                return;
            }
            if (firstSuspend) {
                // A card only owns a data socket after it has been opened or
                // asked to sync. Preserve that intent across a bfcache pause.
                card.resumeAfterPageShow = !!card.ws;
            }
            clearCatalogPatchWatchdog(card);
            card.syncInProgress = false;
            card.sampleInProgress = false;
            if (card.pendingCatalog) {
                const pending = card.pendingCatalog;
                card.pendingCatalog = null;
                clearPendingCatalogTimers(pending);
                if (typeof pending.reject === 'function') {
                    pending.reject(new Error('Page was hidden before the IVTS sync completed.'));
                }
            }
            card.lambdaSnapshot = null;
            card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
            const ws = card.ws;
            card.ws = null;
            card.wsOpenPromise = null;
            if (ws) {
                try {
                    ws.close(1000, 'pagehide');
                } catch (_) {
                    // Ignore best-effort shutdown failures during page exit.
                }
            }
            card.forceBodyRefreshOnce = true;
            setCardStatus(
                card,
                'Live IVTS paused while this page is hidden; the last calculated implied λ is preserved.',
                ''
            );
        });
        // A bfcache page keeps its JavaScript heap and DOM. Commit the paused
        // state now so the UI shows that its frozen calculation needs a fresh
        // coherent source snapshot before the next calculation.
        render(true);
    }

    async function resumePageAfterCache(event, dependencies = {}) {
        const wasPersisted = !!(event && event.persisted === true);
        if (runtime.pageSuspended !== true && !wasPersisted) {
            return { resumed: false, controlRestored: false, resyncedSymbols: [] };
        }

        runtime.pageSuspended = false;
        startAutoSampleMonitor();
        startDiscountCurveRefreshMonitor();

        const cardsToResume = [];
        runtime.cardsBySymbol.forEach((card) => {
            if (!card || card.resumeAfterPageShow !== true) {
                return;
            }
            card.resumeAfterPageShow = false;
            card.forceBodyRefreshOnce = true;
            setCardStatus(card, 'Page restored. Resyncing live IVTS and implied λ...', '');
            cardsToResume.push(card);
        });
        render(true);

        const ensureControl = typeof dependencies.ensureControlSocket === 'function'
            ? dependencies.ensureControlSocket
            : ensureControlSocket;
        let controlRestored = false;
        try {
            await ensureControl();
            controlRestored = true;
        } catch (error) {
            runtime.ibStatus = {
                connected: false,
                connecting: false,
                message: error && error.message || 'Unable to restore the control socket.',
            };
            runtime.discountCurveLastError = 'Unable to refresh the unified daily discount curve after page restore.';
        }

        const sync = typeof dependencies.syncCard === 'function'
            ? dependencies.syncCard
            : syncCard;
        const resyncedSymbols = [];
        await Promise.all(cardsToResume.map(async (card) => {
            try {
                await sync(card, { waitForQuotes: false });
                resyncedSymbols.push(card.symbol);
            } catch (error) {
                setCardStatus(
                    card,
                    error && error.message || 'Unable to resync IVTS after page restore.',
                    'error'
                );
            }
        }));
        render(true);
        return { resumed: true, controlRestored, resyncedSymbols };
    }

    function startAutoSampleMonitor() {
        if (runtime.autoSampleMonitorTimerId != null) {
            return;
        }
        runtime.autoSampleMonitorTimerId = setInterval(() => {
            checkAutoSamplers('hourly');
        }, AUTO_SAMPLE_MONITOR_INTERVAL_MS);
    }

    function startDiscountCurveRefreshMonitor() {
        if (runtime.discountCurveRefreshTimerId != null) {
            return;
        }
        runtime.discountCurveRefreshTimerId = setInterval(() => {
            requestDiscountCurveSnapshot();
        }, DISCOUNT_CURVE_REFRESH_INTERVAL_MS);
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
            if (action === 'implied-lambda-calculate') {
                calculateImpliedLambda(card);
                card.forceBodyRefreshOnce = true;
                render(true);
                return;
            }
            if (action === 'implied-lambda-sync') {
                syncCalculatedImpliedLambda(card);
                card.forceBodyRefreshOnce = true;
                render(true);
                return;
            }
            if (action === 'implied-lambda-export') {
                exportImpliedLambdaFile(card);
                return;
            }
            if (action === 'variance-best-effort') {
                card.varianceBestEffortEnabled = !card.varianceBestEffortEnabled;
                card.forceBodyRefreshOnce = true;
                render(true);
                return;
            }
            if (action === 'auto-load') {
                await selectAndResumeAutoFile(card, 'load');
                return;
            }
            if (action === 'auto-new') {
                await selectAndResumeAutoFile(card, 'new');
                return;
            }
            if (action === 'auto-sample') {
                await startAutoSampling(card);
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
            const optionStreamLimitField = event.target.closest('select[data-action="option-stream-limit"][data-symbol]');
            if (optionStreamLimitField) {
                applyOptionStreamLimitChange(optionStreamLimitField);
                return;
            }

            const futuresMonthField = event.target.closest('input[data-action="futures-contract-month"][data-symbol]');
            if (futuresMonthField) {
                applyFuturesContractMonthChange(futuresMonthField);
                return;
            }

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
            const field = event.target.closest('select[data-action="baseline"][data-symbol], [data-action^="calendar-"][data-symbol], input[data-action="futures-contract-month"][data-symbol], select[data-action="option-stream-limit"][data-symbol]');
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
            IV_TERM_STRUCTURE_SNAPSHOT_TIMEOUT_MS,
            IV_TERM_STRUCTURE_ACK_TIMEOUT_MS,
            IV_TERM_STRUCTURE_PROTOCOL_VERSION,
            normalizeWsHost,
            normalizeWsPort,
            currentExchangeDate,
            normalizeFuturesContractMonth,
            normalizeOptionStreamLimit,
            resolveDefaultExpandedSymbol,
            createCardState,
            isBaselineSelectElement,
            isFuturesContractMonthElement,
            isOptionStreamLimitElement,
            isFocusedBaselineSelectInCard,
            getPrimaryExpiryRows,
            resolveSelectedStraddleBaselineExpiry,
            formatIvPair,
            resolveTotalVarianceObservation,
            resolveForwardVarianceObservation,
            buildTotalVarianceCell,
            buildForwardVarianceCell,
            buildVarianceRecoveryControl,
            buildIvPairTdCell,
            buildImpliedLambdaCell,
            latestQuoteAsOf,
            applyCoherentQuoteSnapshot,
            buildLambdaDetailRows,
            buildBestEffortLambdaSnapshot,
            inspectBestEffortOptionQuote,
            inspectQuoteRecency,
            measureQuoteCoherence,
            buildVendorIvLambdaSource,
            computeImpliedLambdaFromVendorIv,
            computeImpliedLambdaFromCurrentSnapshot,
            buildImpliedLambdaEntry,
            buildImpliedLambdaExportFilename,
            withdrawImpliedLambda,
            publishImpliedLambda,
            publishImpliedLambdaEntry,
            calculateImpliedLambda,
            syncCalculatedImpliedLambda,
            refreshImpliedLambdaPublication,
            formatImpliedLambdaPublicationStatus,
            attachSocketHandlers,
            buildSubscribePayload,
            buildSubscriptionStatus,
            buildIbStatusAfterApiMarketDataReset,
            applyDiscountCurveSnapshot,
            formatDiscountCurveStatus,
            discountCurveStatusTitle,
            attachControlSocketHandlers,
            applyRuntimeConfig,
            getCard,
            closeAllSocketsForPageExit,
            resumePageAfterCache,
            setControlSocketForTest: (ws) => {
                runtime.controlWs = ws;
            },
            getDiscountCurveState: () => ({
                curve: runtime.discountCurve,
                status: runtime.discountCurveStatus,
                fallbackUsed: runtime.discountCurveFallbackUsed,
                error: runtime.discountCurveLastError,
            }),
            buildOptionStreamLimitControl,
            buildImpliedLambdaPanel,
            updateImpliedLambdaPanelElement,
            replaceCardBodyMarkup,
            buildPrimaryExpiryTable,
            buildCardMarkup,
            normalizeCalendarFinderConfig,
            buildCalendarFinderSection,
            describeCalendarFinderEmptyState,
            loadSavedCalendarFinderConfig,
            saveCalendarFinderConfig,
            loadSavedOptionStreamLimit,
            saveOptionStreamLimit,
            normalizeTdIvLambda,
            loadSavedTdIvLambda,
            saveTdIvLambda,
            buildStrategySignalPanel,
            officialWeekFinalSession,
            latestCompletedOfficialWeek,
            evaluateSessionTimestamp,
            evaluateWeeklySignalReadiness,
            serverPayloadAsOf,
            quoteWithServerSnapshotEvidence,
            normalizeAutoHistoryDocument,
            strategyHistoryDocument,
            shouldRunAutoSample,
            hasUsableWatermarkSeed,
            writeAutoHistoryDocument,
            bindAutoHistoryFile,
            loadAutoHistoryFile,
            createAutoHistoryFile,
            prepareAutoHistoryFile,
            autoSampleButtonLabel,
            autoAppendTargetLabel,
            captureCardViewState,
            restoreCardViewState,
            evaluateLambdaSnapshotFreshness,
            expireCardImpliedLambdaIfStale,
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
        const discountCurveStatus = document.getElementById('ivtsDiscountCurveStatus');
        if (discountCurveStatus) {
            discountCurveStatus.textContent = formatDiscountCurveStatus();
            discountCurveStatus.title = discountCurveStatusTitle();
        }
        const ibConnectButton = document.getElementById('ivtsIbConnectButton');
        if (ibConnectButton) {
            ibConnectButton.disabled = !!(runtime.ibStatus && (runtime.ibStatus.connected || runtime.ibStatus.connecting));
            ibConnectButton.textContent = runtime.ibStatus && runtime.ibStatus.connected
                ? 'IB Connected'
                : (runtime.ibStatus && runtime.ibStatus.connecting ? 'Connecting...' : 'Connect IB');
        }
        const apiResetButton = document.getElementById('ivtsApiResetButton');
        if (apiResetButton) {
            apiResetButton.disabled = runtime.apiResetInProgress;
            apiResetButton.textContent = runtime.apiResetInProgress
                ? 'Clearing All API Streams...'
                : 'Clear All API Streams';
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
            const apiResetButton = document.getElementById('ivtsApiResetButton');
            if (apiResetButton) {
                apiResetButton.addEventListener('click', () => {
                    resetAllApiMarketDataSubscriptionsFromPage();
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
            const tdIvLambdaInput = document.getElementById('ivtsTdIvLambdaInput');
            if (tdIvLambdaInput) {
                const savedTdIvLambda = loadSavedTdIvLambda();
                runtime.tdIvWeekendWeight = savedTdIvLambda == null
                    ? DEFAULT_TD_IV_LAMBDA
                    : savedTdIvLambda;
                tdIvLambdaInput.value = runtime.tdIvWeekendWeight.toFixed(2);
                tdIvLambdaInput.addEventListener('change', (event) => {
                    applyTdIvLambdaChange(event.target.value);
                });
            }
            const impliedLambdaRateInput = document.getElementById('ivtsImpliedLambdaRateInput');
            {
                const savedRate = loadSavedImpliedLambdaRate();
                runtime.impliedLambdaRate = savedRate == null
                    ? DEFAULT_IMPLIED_LAMBDA_RATE
                    : savedRate;
            }
            if (impliedLambdaRateInput) {
                impliedLambdaRateInput.value = (runtime.impliedLambdaRate * 100).toFixed(2);
                impliedLambdaRateInput.addEventListener('change', (event) => {
                    const ratePct = normalizeImpliedLambdaRatePct(event.target.value);
                    runtime.impliedLambdaRate = ratePct / 100;
                    saveImpliedLambdaRate(runtime.impliedLambdaRate);
                    impliedLambdaRateInput.value = ratePct.toFixed(2);
                    runtime.cardsBySymbol.forEach((card) => {
                        card.forceBodyRefreshOnce = true;
                        card.impliedLambdaNeedsRecalculation = !!card.impliedLambdaComputedEntry;
                    });
                    render(true);
                });
            }
            globalScope.addEventListener('pagehide', closeAllSocketsForPageExit, { capture: true });
            globalScope.addEventListener('beforeunload', closeAllSocketsForPageExit, { capture: true });
            globalScope.addEventListener('pageshow', (event) => {
                void resumePageAfterCache(event);
            });
            globalScope.addEventListener('focus', () => {
                checkAutoSamplers('page focus');
            });
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    checkAutoSamplers('page visible');
                }
            });
            startAutoSampleMonitor();
            startDiscountCurveRefreshMonitor();
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
