/**
 * WebSocket & Live Data Integration
 * ====================================
 * Extracted from app.js for maintainability.
 *
 * Depends on (global):
 *   - state, currencyFormatter, flashElement   (app.js)
 *   - updateDerivedValues                       (app.js)
 */

// -------------------------------------------------------------
// WebSocket Connection (Exponential Backoff)
// -------------------------------------------------------------

let ws = null;
let isWsConnected = false;

const DEFAULT_WS_HOST = '127.0.0.1';
const DEFAULT_WS_PORT = 8765;
const WS_HOST_STORAGE_KEY = 'optionComboWsHost';
const WS_PORT_STORAGE_KEY = 'optionComboWsPort';

// Exponential backoff state
const WS_BASE_DELAY = 5000;   // 5s initial
const WS_MAX_DELAY = 60000;   // 60s cap
let _wsReconnectDelay = WS_BASE_DELAY;
let _wsReconnectTimer = null;
let _legacyLiveDataWarningShown = false;
let _historicalReplayOrderCounter = 900000;
const _liveQuoteRuntime = {
    underlyingQuote: null,
    optionQuotesById: new Map(),
    futureQuotesById: new Map(),
    stockQuotesBySymbol: new Map(),
};
const _liveQuoteSnapshotFields = ['bid', 'ask', 'mark', 'iv'];

function _cloneLiveQuoteSnapshot(rawQuote) {
    if (!rawQuote || typeof rawQuote !== 'object') {
        return null;
    }

    const snapshot = {};
    ['bid', 'ask', 'mark', 'iv'].forEach((field) => {
        const parsed = parseFloat(rawQuote[field]);
        if (Number.isFinite(parsed) && parsed > 0) {
            snapshot[field] = parsed;
        }
    });

    return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function _areLiveQuoteSnapshotsEqual(left, right) {
    if (left === right) {
        return true;
    }
    if (!left || !right) {
        return left === right;
    }
    return _liveQuoteSnapshotFields.every((field) => {
        const leftHasField = Object.prototype.hasOwnProperty.call(left, field);
        const rightHasField = Object.prototype.hasOwnProperty.call(right, field);
        return leftHasField === rightHasField
            && (!leftHasField || left[field] === right[field]);
    });
}

function _resetLiveQuoteRuntime() {
    _liveQuoteRuntime.underlyingQuote = null;
    _liveQuoteRuntime.optionQuotesById.clear();
    _liveQuoteRuntime.futureQuotesById.clear();
    _liveQuoteRuntime.stockQuotesBySymbol.clear();
}

function _setUnderlyingQuoteSnapshot(rawQuote) {
    const nextSnapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (_areLiveQuoteSnapshotsEqual(_liveQuoteRuntime.underlyingQuote, nextSnapshot)) {
        return false;
    }
    _liveQuoteRuntime.underlyingQuote = nextSnapshot;
    return true;
}

function _setOptionQuoteSnapshot(subId, rawQuote) {
    if (!subId) return false;
    const snapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (!snapshot) return false;
    const previousSnapshot = _liveQuoteRuntime.optionQuotesById.get(subId) || null;
    if (_areLiveQuoteSnapshotsEqual(previousSnapshot, snapshot)) {
        return false;
    }
    _liveQuoteRuntime.optionQuotesById.set(subId, snapshot);
    return true;
}

function _setFutureQuoteSnapshot(subId, rawQuote) {
    if (!subId) return false;
    const snapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (!snapshot) return false;
    const previousSnapshot = _liveQuoteRuntime.futureQuotesById.get(subId) || null;
    if (_areLiveQuoteSnapshotsEqual(previousSnapshot, snapshot)) {
        return false;
    }
    _liveQuoteRuntime.futureQuotesById.set(subId, snapshot);
    return true;
}

function _setStockQuoteSnapshot(symbol, rawQuote) {
    if (!symbol) return false;
    const snapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (!snapshot) return false;
    const previousSnapshot = _liveQuoteRuntime.stockQuotesBySymbol.get(symbol) || null;
    if (_areLiveQuoteSnapshotsEqual(previousSnapshot, snapshot)) {
        return false;
    }
    _liveQuoteRuntime.stockQuotesBySymbol.set(symbol, snapshot);
    return true;
}

function _formatSymbolPriceInputValue(symbol, value) {
    if (typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.formatPriceInputValue === 'function') {
        return OptionComboProductRegistry.formatPriceInputValue(symbol, value);
    }
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed.toFixed(2) : '';
}

function _formatSymbolPriceDisplay(symbol, value) {
    if (typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.formatPriceDisplay === 'function') {
        return OptionComboProductRegistry.formatPriceDisplay(symbol, value);
    }
    return currencyFormatter.format(value);
}

function _refreshForwardRatePanelUi() {
    if (typeof OptionComboControlPanelUI === 'undefined') {
        return;
    }
    if (typeof OptionComboControlPanelUI.refreshForwardRatePanel === 'function') {
        OptionComboControlPanelUI.refreshForwardRatePanel();
        return;
    }
    if (typeof OptionComboControlPanelUI.refreshBoundDynamicControls === 'function') {
        OptionComboControlPanelUI.refreshBoundDynamicControls();
    }
}

function _refreshFuturesPoolPanelUi() {
    if (typeof OptionComboControlPanelUI === 'undefined') {
        return;
    }
    if (typeof OptionComboControlPanelUI.refreshFuturesPoolPanel === 'function') {
        OptionComboControlPanelUI.refreshFuturesPoolPanel();
        return;
    }
    if (typeof OptionComboControlPanelUI.refreshBoundDynamicControls === 'function') {
        OptionComboControlPanelUI.refreshBoundDynamicControls();
    }
}

function _normalizeLivePriceMode(group) {
    if (typeof OptionComboSessionLogic !== 'undefined'
        && typeof OptionComboSessionLogic.normalizeGroupLivePriceMode === 'function') {
        return OptionComboSessionLogic.normalizeGroupLivePriceMode(group && group.livePriceMode);
    }
    return String(group && group.livePriceMode || '').trim().toLowerCase() === 'midpoint'
        ? 'midpoint'
        : 'mark';
}

function _addAllGroupIds(targetSet) {
    (state.groups || []).forEach((group) => {
        if (group && group.id) {
            targetSet.add(group.id);
        }
    });
}

function _addGroupsAffectedByOptionQuoteIds(targetSet, optionQuoteIds) {
    if (!(targetSet instanceof Set) || !Array.isArray(optionQuoteIds) || optionQuoteIds.length === 0) {
        return;
    }

    const quoteIdSet = new Set(optionQuoteIds.filter(Boolean));
    if (quoteIdSet.size === 0) {
        return;
    }

    (state.groups || []).forEach((group) => {
        if ((group && group.legs || []).some(leg => quoteIdSet.has(leg && leg.id))) {
            targetSet.add(group.id);
        }
    });
}

function _addGroupsAffectedByUnderlyingMidpoint(targetSet) {
    if (!(targetSet instanceof Set)) {
        return;
    }

    (state.groups || []).forEach((group) => {
        if (_normalizeLivePriceMode(group) !== 'midpoint') {
            return;
        }
        if ((group && group.legs || []).some(leg => _isUnderlyingLeg(leg))) {
            targetSet.add(group.id);
        }
    });
}

function _scheduleDerivedValueRefresh(changeSet, allowIncrementalUpdate) {
    if (renderScheduled) {
        return;
    }

    renderScheduled = true;
    requestAnimationFrame(() => {
        try {
            const groupIds = Array.isArray(changeSet && changeSet.groupIds) ? changeSet.groupIds.filter(Boolean) : [];
            const hedgeIds = Array.isArray(changeSet && changeSet.hedgeIds) ? changeSet.hedgeIds.filter(Boolean) : [];
            const hasIncrementalTargets = groupIds.length > 0 || hedgeIds.length > 0;
            const appRuntime = typeof window !== 'undefined' && window.__optionComboApp && typeof window.__optionComboApp === 'object'
                ? window.__optionComboApp
                : null;
            const incrementalUpdater = typeof updateLiveQuoteDerivedValues === 'function'
                ? updateLiveQuoteDerivedValues
                : (appRuntime && typeof appRuntime.updateLiveQuoteDerivedValues === 'function'
                    ? appRuntime.updateLiveQuoteDerivedValues
                    : null);

            if (allowIncrementalUpdate && hasIncrementalTargets && typeof incrementalUpdater === 'function') {
                incrementalUpdater({
                    groupIds,
                    hedgeIds,
                });
                return;
            }

            updateDerivedValues();
        } finally {
            renderScheduled = false;
        }
    });
}

function getLiveOptionQuote(subId) {
    const snapshot = _liveQuoteRuntime.optionQuotesById.get(subId);
    return snapshot ? { ...snapshot } : null;
}

function getLiveStockQuote(symbol) {
    const snapshot = _liveQuoteRuntime.stockQuotesBySymbol.get(symbol);
    return snapshot ? { ...snapshot } : null;
}

function getLiveFutureQuote(subId) {
    const snapshot = _liveQuoteRuntime.futureQuotesById.get(subId);
    return snapshot ? { ...snapshot } : null;
}

function getUnderlyingQuote() {
    return _liveQuoteRuntime.underlyingQuote
        ? { ..._liveQuoteRuntime.underlyingQuote }
        : null;
}

window.OptionComboWsLiveQuotes = {
    getOptionQuote: getLiveOptionQuote,
    getFutureQuote: getLiveFutureQuote,
    getStockQuote: getLiveStockQuote,
    getUnderlyingQuote,
    clear: _resetLiveQuoteRuntime,
};

function _getMarketDataMode() {
    return state && state.marketDataMode === 'historical' ? 'historical' : 'live';
}

function _isHistoricalMode() {
    return _getMarketDataMode() === 'historical';
}

function _normalizeLiveComboOrderAccount(value) {
    return String(value || '').trim();
}

function _getSelectedLiveComboOrderAccount() {
    return _normalizeLiveComboOrderAccount(state && state.selectedLiveComboOrderAccount);
}

function _hasSelectedLiveComboOrderAccount() {
    return !!_getSelectedLiveComboOrderAccount();
}

function _getLiveComboOrderAccountRequirementMessage() {
    const accounts = Array.isArray(state && state.liveComboOrderAccounts)
        ? state.liveComboOrderAccounts.filter((account) => _normalizeLiveComboOrderAccount(account))
        : [];
    if (state && state.liveComboOrderAccountsConnected === true && accounts.length > 0) {
        return 'Select a TWS account before sending live combo orders.';
    }
    return 'Waiting for TWS account list before sending live combo orders.';
}

function _getHistoricalReplayDate() {
    const rawValue = state && typeof state.historicalQuoteDate === 'string' && state.historicalQuoteDate
        ? state.historicalQuoteDate
        : (state && typeof state.baseDate === 'string'
            ? state.baseDate
            : '');
    return _normalizeHistoricalDateKey(rawValue);
}

function _getHistoricalEntryDate() {
    const rawValue = state && typeof state.baseDate === 'string'
        ? state.baseDate
        : '';
    return _normalizeHistoricalDateKey(rawValue);
}

function _getQuoteSourceKind(data) {
    return data && data.historicalReplay ? 'historical' : 'live';
}

function _getQuoteReferenceDate() {
    if (typeof OptionComboPricingContext !== 'undefined'
        && typeof OptionComboPricingContext.resolveQuoteDate === 'function') {
        return OptionComboPricingContext.resolveQuoteDate(state);
    }
    return _isHistoricalMode()
        ? (_getHistoricalReplayDate() || state.baseDate || '')
        : (state.baseDate || state.simulatedDate || '');
}

function _isUnderlyingLeg(legOrType) {
    return OptionComboProductRegistry.isUnderlyingLeg(legOrType);
}

function _normalizeWsPort(rawValue) {
    const parsed = parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return DEFAULT_WS_PORT;
    }
    return parsed;
}

function _normalizeWsHost(rawValue) {
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

function _getSavedWsHost() {
    try {
        return _normalizeWsHost(localStorage.getItem(WS_HOST_STORAGE_KEY));
    } catch (e) {
        return DEFAULT_WS_HOST;
    }
}

function _setSavedWsHost(host) {
    const safeHost = _normalizeWsHost(host);
    try {
        localStorage.setItem(WS_HOST_STORAGE_KEY, safeHost);
    } catch (e) {
        // Ignore localStorage failures and keep using the runtime value.
    }
    return safeHost;
}

function _getSavedWsPort() {
    try {
        return _normalizeWsPort(localStorage.getItem(WS_PORT_STORAGE_KEY));
    } catch (e) {
        return DEFAULT_WS_PORT;
    }
}

function _setSavedWsPort(port) {
    const safePort = _normalizeWsPort(port);
    try {
        localStorage.setItem(WS_PORT_STORAGE_KEY, String(safePort));
    } catch (e) {
        // Ignore localStorage failures and keep using the runtime value.
    }
    return safePort;
}

function _syncWsHostInput(host) {
    const input = document.getElementById('wsHostInput');
    if (input) input.value = _normalizeWsHost(host);
}

function _syncWsPortInput(port) {
    const input = document.getElementById('wsPortInput');
    if (input) input.value = String(_normalizeWsPort(port));
}

function _getCurrentWsHost() {
    const input = document.getElementById('wsHostInput');
    if (input && input.value) return _normalizeWsHost(input.value);
    return _getSavedWsHost();
}

function _getCurrentWsPort() {
    const input = document.getElementById('wsPortInput');
    if (input && input.value) return _normalizeWsPort(input.value);
    return _getSavedWsPort();
}

function _getWsUrl() {
    return `ws://${_getCurrentWsHost()}:${_getCurrentWsPort()}`;
}

function _clearWsReconnectTimer() {
    if (_wsReconnectTimer) {
        clearTimeout(_wsReconnectTimer);
        _wsReconnectTimer = null;
    }
}

function updateWsStatusUI(status, nextRetrySec) {
    const el = document.getElementById('wsStatus');
    if (!el) return;

    const host = _getCurrentWsHost();
    const port = _getCurrentWsPort();
    const endpoint = `${host}:${port}`;
    if (status === 'connected') {
        el.textContent = `Connected ${endpoint}`;
        el.className = 'ws-status ws-connected';
    } else if (status === 'error') {
        el.textContent = `Error ${endpoint}`;
        el.className = 'ws-status ws-error';
    } else {
        const suffix = nextRetrySec != null ? ` - Retry in ${nextRetrySec}s` : '';
        el.textContent = `Disconnected ${endpoint}${suffix}`;
        el.className = 'ws-status ws-disconnected';
    }
}

function connectWebSocket() {
    _clearWsReconnectTimer();

    const wsUrl = _getWsUrl();
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        isWsConnected = true;
        _wsReconnectDelay = WS_BASE_DELAY;
        console.log(`WebSocket Connected to IB Gateway Backend at ${wsUrl}`);
        updateWsStatusUI('connected');
        handleLiveSubscriptions();
    };

    ws.onclose = () => {
        isWsConnected = false;
        state.liveComboOrderAccountsConnected = false;
        if (typeof OptionComboControlPanelUI !== 'undefined'
            && typeof OptionComboControlPanelUI.refreshBoundDynamicControls === 'function') {
            OptionComboControlPanelUI.refreshBoundDynamicControls();
        }
        const delaySec = Math.round(_wsReconnectDelay / 1000);
        console.log(`WebSocket Disconnected. Reconnecting in ${delaySec}s...`);
        updateWsStatusUI('disconnected', delaySec);
        _wsReconnectTimer = setTimeout(connectWebSocket, _wsReconnectDelay);
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, WS_MAX_DELAY);
    };

    ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        state.liveComboOrderAccountsConnected = false;
        if (typeof OptionComboControlPanelUI !== 'undefined'
            && typeof OptionComboControlPanelUI.refreshBoundDynamicControls === 'function') {
            OptionComboControlPanelUI.refreshBoundDynamicControls();
        }
        updateWsStatusUI('error');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (_handleManagedAccountsMessage(data)) {
                return;
            }
            if (_handlePortfolioAvgCostMessage(data)) {
                return;
            }
            if (_handleComboOrderMessage(data)) {
                return;
            }
            if (_handleHistoricalReplayMessage(data)) {
                return;
            }
            processLiveMarketData(data);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    };
}

function reconnectWebSocket() {
    _clearWsReconnectTimer();
    isWsConnected = false;

    if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try {
            ws.close();
        } catch (e) {
            // Ignore close errors and reconnect below.
        }
        ws = null;
    }

    updateWsStatusUI('disconnected');
    connectWebSocket();
}

function requestPortfolioAvgCostSnapshot() {
    if (!isWsConnected || !ws) {
        return false;
    }

    ws.send(JSON.stringify({
        action: 'request_portfolio_avg_cost_snapshot',
    }));
    return true;
}

function requestManagedAccountsSnapshot() {
    if (!isWsConnected || !ws || _isHistoricalMode()) {
        return false;
    }

    ws.send(JSON.stringify({
        action: 'request_managed_accounts_snapshot',
    }));
    return true;
}

function requestContinueManagedComboOrder(group, runtimeKind = 'tradeTrigger') {
    if (!group || !isWsConnected || !ws) {
        return false;
    }

    const executionRuntime = _getExecutionRuntimeByKind(group, runtimeKind);
    const preview = executionRuntime && executionRuntime.lastPreview;
    if (!executionRuntime || !preview || !preview.orderId) {
        _markExecutionError(group, 'No resumable managed combo order was found.', runtimeKind);
        renderGroups();
        return false;
    }

    if (executionRuntime.pendingRequest) {
        return false;
    }

    executionRuntime.pendingRequest = true;
    executionRuntime.lastError = '';
    executionRuntime.status = 'pending_resume';
    ws.send(JSON.stringify({
        action: 'resume_managed_combo_order',
        groupId: group.id,
        orderId: preview.orderId,
        permId: preview.permId || null,
        executionIntent: runtimeKind === 'closeExecution' ? 'close' : 'open',
        requestSource: runtimeKind === 'closeExecution' ? 'close_group' : 'trial_trigger',
    }));
    renderGroups();
    return true;
}

function requestConcedeManagedComboOrder(group, concessionRatio, runtimeKind = 'tradeTrigger') {
    if (!group || !isWsConnected || !ws) {
        return false;
    }

    const executionRuntime = _getExecutionRuntimeByKind(group, runtimeKind);
    const preview = executionRuntime && executionRuntime.lastPreview;
    if (!executionRuntime || !preview || !preview.orderId) {
        _markExecutionError(group, 'No live combo order is available for concession repricing.', runtimeKind);
        renderGroups();
        return false;
    }

    if (executionRuntime.pendingRequest) {
        return false;
    }

    const parsedRatio = parseFloat(concessionRatio);
    if (!Number.isFinite(parsedRatio)) {
        _markExecutionError(group, 'Invalid concession ratio.', runtimeKind);
        renderGroups();
        return false;
    }

    executionRuntime.pendingRequest = true;
    executionRuntime.lastError = '';
    executionRuntime.status = 'pending_concede';
    ws.send(JSON.stringify({
        action: 'concede_managed_combo_order',
        groupId: group.id,
        orderId: preview.orderId,
        permId: preview.permId || null,
        concessionRatio: parsedRatio,
        executionIntent: runtimeKind === 'closeExecution' ? 'close' : 'open',
        requestSource: runtimeKind === 'closeExecution' ? 'close_group' : 'trial_trigger',
    }));
    renderGroups();
    return true;
}

function requestCancelManagedComboOrder(group, reason = 'manual_cancel', runtimeKind = 'tradeTrigger') {
    if (!group) {
        return false;
    }

    const executionRuntime = _getExecutionRuntimeByKind(group, runtimeKind);
    const preview = executionRuntime && executionRuntime.lastPreview;
    if (!executionRuntime || !preview || !preview.orderId) {
        _markExecutionError(group, 'No cancellable combo order was found.', runtimeKind);
        renderGroups();
        return false;
    }

    if (executionRuntime.pendingRequest) {
        return false;
    }

    if (_isHistoricalMode()) {
        const brokerStatus = String(preview.status || '').trim();
        if (['Filled', 'Cancelled', 'ApiCancelled', 'Inactive'].includes(brokerStatus)) {
            _markExecutionError(group, 'This historical replay order is already closed.', runtimeKind);
            renderGroups();
            return false;
        }

        executionRuntime.pendingRequest = false;
        executionRuntime.lastError = '';
        executionRuntime.lastPreview = {
            ...preview,
            status: 'Cancelled',
            remaining: 0,
            filled: Number.isFinite(preview.filled) ? preview.filled : 0,
            managedMode: false,
            managedState: 'cancelled',
            statusMessage: `Historical replay simulated order cancelled on ${_getHistoricalReplayDate() || 'the selected day'} (${reason}).`,
        };
        executionRuntime.status = preview.executionMode === 'test_submit'
            ? 'test_submitted'
            : (preview.executionMode === 'preview' ? 'previewed' : 'submitted');
        renderGroups();
        updateDerivedValues();
        return true;
    }

    if (!isWsConnected || !ws) {
        return false;
    }

    executionRuntime.pendingRequest = true;
    executionRuntime.lastError = '';
    executionRuntime.status = 'pending_cancel';
    ws.send(JSON.stringify({
        action: 'cancel_managed_combo_order',
        groupId: group.id,
        orderId: preview.orderId,
        permId: preview.permId || null,
        reason,
        executionIntent: runtimeKind === 'closeExecution' ? 'close' : 'open',
        requestSource: runtimeKind === 'closeExecution' ? 'close_group' : 'trial_trigger',
    }));
    renderGroups();
    return true;
}

function _buildCloseGroupComboOrderPayload(group, closeExecution, executionMode = 'submit') {
    if (!closeExecution) {
        return null;
    }

    if (typeof OptionComboGroupOrderBuilder === 'undefined'
        || typeof OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload !== 'function') {
        return null;
    }

    return OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(group, state, {
        action: executionMode === 'preview' ? 'preview_combo_order' : 'submit_combo_order',
        executionMode,
        intent: 'close',
        source: 'close_group',
        managedRepriceThreshold: closeExecution.repriceThreshold,
        managedConcessionRatio: closeExecution.concessionRatio,
        timeInForce: closeExecution.timeInForce,
    });
}

function _roundHistoricalReplayPrice(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 10000) / 10000 : null;
}

function _nextHistoricalReplayOrderIds() {
    _historicalReplayOrderCounter += 1;
    return {
        orderId: _historicalReplayOrderCounter,
        permId: 800000000 + _historicalReplayOrderCounter,
    };
}

function _buildHistoricalReplayLocalSymbol(leg) {
    if (_isUnderlyingLeg(leg)) {
        return state.underlyingSymbol || 'Underlying';
    }

    return `${state.underlyingSymbol} ${String(leg.expDate || '')} ${String(leg.type || '').toUpperCase()} ${leg.strike}`;
}

function _resolveHistoricalReplayClosePrice(leg, allowIntrinsicFallback = true) {
    if (!leg) {
        return null;
    }

    const replayDate = _normalizeHistoricalDateKey(_getHistoricalReplayDate());
    const expiryDate = _normalizeHistoricalDateKey(leg.expDate);
    const isExpiredOption = !_isUnderlyingLeg(leg)
        && !!replayDate
        && !!expiryDate
        && expiryDate <= replayDate;

    if (_isUnderlyingLeg(leg)) {
        return _roundHistoricalReplayPrice(state.underlyingPrice);
    }

    if (isExpiredOption) {
        if (!allowIntrinsicFallback || !Number.isFinite(state.underlyingPrice)) {
            return null;
        }

        const settlementUnderlyingPrice = Number.isFinite(parseFloat(leg.historicalExpiryUnderlyingPrice))
            ? parseFloat(leg.historicalExpiryUnderlyingPrice)
            : state.underlyingPrice;
        if (String(leg.type || '').toLowerCase() === 'call') {
            return _roundHistoricalReplayPrice(Math.max(0, settlementUnderlyingPrice - (parseFloat(leg.strike) || 0)));
        }
        if (String(leg.type || '').toLowerCase() === 'put') {
            return _roundHistoricalReplayPrice(Math.max(0, (parseFloat(leg.strike) || 0) - settlementUnderlyingPrice));
        }
        return null;
    }

    if (leg.currentPriceSource !== 'missing'
        && Number.isFinite(leg.currentPrice)
        && leg.currentPrice > 0) {
        return _roundHistoricalReplayPrice(leg.currentPrice);
    }

    if (!allowIntrinsicFallback || !replayDate || !expiryDate || expiryDate > replayDate || !Number.isFinite(state.underlyingPrice)) {
        return null;
    }

    return null;
}

function _resolveHistoricalReplayEntryPrice(leg) {
    if (!leg) {
        return null;
    }

    if (_isUnderlyingLeg(leg)) {
        if (leg.currentPriceSource !== 'missing'
            && Number.isFinite(leg.currentPrice)
            && leg.currentPrice > 0) {
            return _roundHistoricalReplayPrice(leg.currentPrice);
        }
        return Number.isFinite(state.underlyingPrice)
            ? _roundHistoricalReplayPrice(state.underlyingPrice)
            : null;
    }

    if (leg.currentPriceSource !== 'missing'
        && Number.isFinite(leg.currentPrice)
        && leg.currentPrice > 0) {
        return _roundHistoricalReplayPrice(leg.currentPrice);
    }

    return null;
}

function _buildHistoricalClosePreview(group, settledLegs) {
    const netMark = settledLegs.reduce((sum, leg) => sum + ((leg.closePrice || 0) * (parseFloat(leg.pos) || 0)), 0);

    return {
        executionIntent: 'close',
        executionMode: 'historical_replay',
        status: 'Filled',
        comboSymbol: group && group.name ? group.name : 'Historical Replay',
        orderAction: 'CLOSE',
        totalQuantity: 1,
        limitPrice: _roundHistoricalReplayPrice(netMark),
        pricingSource: 'historical_replay',
        statusMessage: `Settled using replay quotes from ${_getHistoricalReplayDate() || 'the selected day'}.`,
        legs: settledLegs.map((leg) => ({
            executionAction: (parseFloat(leg.pos) || 0) > 0 ? 'SELL' : 'BUY',
            ratio: Math.abs(parseInt(leg.pos, 10) || 0),
            localSymbol: _buildHistoricalReplayLocalSymbol(leg),
            mark: leg.closePrice,
        })),
    };
}

function _buildHistoricalOrderStatusUpdate(preview, status) {
    return {
        ...preview,
        status,
        filled: status === 'Filled' ? 1 : (preview.filled || 0),
        remaining: status === 'Filled' ? 0 : (preview.remaining || 1),
        avgFillPrice: Number.isFinite(preview.limitPrice) ? preview.limitPrice : null,
    };
}

function _buildHistoricalFillCostPayload(group, runtimeKind, preview) {
    if (!group || !preview || !Array.isArray(preview.legs)) {
        return null;
    }

    const legs = preview.legs
        .map((previewLeg) => {
            const groupLeg = (group.legs || []).find((leg) => leg.id === previewLeg.id);
            if (!groupLeg) {
                return null;
            }

            const avgFillPrice = runtimeKind === 'closeExecution'
                ? _resolveHistoricalReplayClosePrice(groupLeg, true)
                : _resolveHistoricalReplayEntryPrice(groupLeg);
            if (!Number.isFinite(avgFillPrice) || avgFillPrice < 0) {
                return null;
            }

            return {
                id: groupLeg.id,
                avgFillPrice,
            };
        })
        .filter(Boolean);

    if (legs.length === 0) {
        return null;
    }

    return {
        action: 'combo_order_fill_cost_update',
        groupId: group.id,
        orderFill: {
            orderId: preview.orderId || null,
            permId: preview.permId || null,
            requestSource: preview.requestSource || '',
            executionIntent: preview.executionIntent || '',
            executionMode: preview.executionMode || '',
            status: 'Filled',
            avgFillPrice: Number.isFinite(preview.limitPrice) ? preview.limitPrice : null,
            legs,
        },
    };
}

function _applyHistoricalComboFill(group, runtimeKind, preview) {
    if (!group || !preview || String(preview.executionMode || '').trim() !== 'submit') {
        return false;
    }

    _applyComboOrderStatusUpdate({
        action: 'combo_order_status_update',
        groupId: group.id,
        orderStatus: _buildHistoricalOrderStatusUpdate(preview, 'Filled'),
    });

    const fillPayload = _buildHistoricalFillCostPayload(group, runtimeKind, preview);
    if (fillPayload) {
        _applyComboOrderFillCostUpdate(fillPayload);
    }

    if (runtimeKind === 'closeExecution' && !_groupHasOpenPositions(group)) {
        group.viewMode = 'settlement';
        renderGroups();
        updateDerivedValues();
    }

    return true;
}

function _markHistoricalReplayEntryError(message) {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(message);
    } else {
        console.error(message);
    }
}

function _lockHistoricalReplayEntryCosts(group) {
    if (!group) {
        return false;
    }

    if (!_groupHasOpenPositions(group)) {
        _markHistoricalReplayEntryError('This group has no open legs to enter.');
        return false;
    }

    const missingLegs = [];
    (group.legs || []).forEach((leg) => {
        const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
        const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined;
        if (pos < 0.0001 || hasClosePrice) {
            return;
        }

        const entryPrice = _resolveHistoricalReplayEntryPrice(leg);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            missingLegs.push(leg);
            return;
        }

        leg.cost = entryPrice;
        leg.costSource = 'historical_replay_entry';
        leg.entryReplayDate = _getHistoricalReplayDate() || state.simulatedDate || '';
        leg.executionReportedCost = false;
        delete leg.executionReportOrderId;
        delete leg.executionReportPermId;
    });

    if (missingLegs.length > 0) {
        _markHistoricalReplayEntryError(`Historical entry price is unavailable for ${missingLegs.length} leg(s) on ${_getHistoricalReplayDate() || 'the selected day'}.`);
        return false;
    }

    const trigger = _getTradeTrigger(group);
    if (trigger) {
        trigger.enabled = false;
        trigger.pendingRequest = false;
        trigger.status = 'idle';
        trigger.lastError = '';
    }

    group.viewMode = 'active';
    renderGroups();
    updateDerivedValues();
    return true;
}

function _buildHistoricalTriggerOrderPreview(group, executionMode) {
    const trigger = _getTradeTrigger(group);
    const replayDate = _getHistoricalReplayDate() || 'the selected day';
    const missingLegs = [];
    const previewLegs = [];
    let netMark = 0;

    (group.legs || []).forEach((leg) => {
        const pos = parseFloat(leg && leg.pos) || 0;
        if (Math.abs(pos) < 0.0001) {
            return;
        }

        const mark = _resolveHistoricalReplayEntryPrice(leg);
        if (!Number.isFinite(mark) || mark < 0) {
            missingLegs.push(leg);
            return;
        }

        netMark += mark * pos;
        previewLegs.push({
            id: leg.id,
            executionAction: pos > 0 ? 'BUY' : 'SELL',
            ratio: Math.abs(parseInt(pos, 10) || 0),
            localSymbol: _buildHistoricalReplayLocalSymbol(leg),
            symbol: state.underlyingSymbol || '',
            mark,
        });
    });

    if (missingLegs.length > 0) {
        return {
            error: `Historical replay quote is unavailable for ${missingLegs.length} leg(s) on ${replayDate}.`,
        };
    }

    if (previewLegs.length === 0) {
        return {
            error: 'This group has no non-zero legs to simulate.',
        };
    }

    const limitPrice = _roundHistoricalReplayPrice(Math.abs(netMark));
    const preview = {
        executionIntent: 'open',
        executionMode,
        requestSource: 'trial_trigger',
        comboSymbol: group && group.name ? group.name : 'Historical Replay',
        orderAction: netMark >= 0 ? 'BUY' : 'SELL',
        totalQuantity: 1,
        limitPrice,
        timeInForce: trigger && trigger.timeInForce ? trigger.timeInForce : 'DAY',
        pricingSource: 'historical_replay',
        pricingNote: 'Built from replay-day leg quotes. No live TWS order was sent.',
        statusMessage: executionMode === 'preview'
            ? `Historical replay preview created from ${replayDate}.`
            : `Historical replay simulated ${executionMode === 'test_submit' ? 'test submit' : 'submit'} created from ${replayDate}. No live TWS order was sent.`,
        legs: previewLegs,
    };

    if (executionMode !== 'preview') {
        const orderIds = _nextHistoricalReplayOrderIds();
        preview.status = 'Submitted';
        preview.orderId = orderIds.orderId;
        preview.permId = orderIds.permId;
        preview.filled = 0;
        preview.remaining = 1;
        preview.managedMode = false;
        preview.managedState = 'simulated';
    }

    return { preview };
}

function _applyHistoricalTriggerOrderPreview(group, executionMode) {
    const trigger = _getTradeTrigger(group);
    if (!trigger) {
        return false;
    }

    const result = _buildHistoricalTriggerOrderPreview(group, executionMode);
    if (!result || !result.preview) {
        _markTradeTriggerError(group, result && result.error
            ? result.error
            : 'Unable to build a historical replay combo order preview.');
        renderGroups();
        return false;
    }

    const applyResult = _applyComboOrderResult({
        action: executionMode === 'preview' ? 'combo_order_preview_result' : 'combo_order_submit_result',
        groupId: group.id,
        preview: executionMode === 'preview' ? result.preview : undefined,
        order: executionMode === 'preview' ? undefined : result.preview,
    });
    if (executionMode === 'submit') {
        _applyHistoricalComboFill(group, 'tradeTrigger', result.preview);
    }
    return applyResult;
}

function _settleHistoricalReplayGroup(group) {
    const closeExecution = _getCloseExecution(group);
    if (!closeExecution) {
        return false;
    }

    if (!_groupHasOpenPositions(group)) {
        _markCloseExecutionError(group, 'This group has no open position to close.');
        return false;
    }

    if (!_groupHasCostForAllPositionedLegs(group)) {
        _markCloseExecutionError(group, 'Historical settlement needs a locked entry cost for every open leg. Use Enter @ Replay Day or let base-day quotes seed the costs first.');
        return false;
    }

    const missingLegs = [];
    const settledLegs = [];

    (group.legs || []).forEach((leg) => {
        const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
        if (pos < 0.0001 || (leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined)) {
            return;
        }

        const closePrice = _resolveHistoricalReplayClosePrice(leg, true);
        if (!Number.isFinite(closePrice) || closePrice < 0) {
            missingLegs.push(leg);
            return;
        }

        leg.closePrice = closePrice;
        settledLegs.push(leg);
    });

    if (missingLegs.length > 0) {
        _markCloseExecutionError(group, `Historical close price is unavailable for ${missingLegs.length} leg(s) on ${_getHistoricalReplayDate() || 'the selected day'}.`);
        return false;
    }

    group.settleUnderlyingPrice = Number.isFinite(state.underlyingPrice) ? state.underlyingPrice : group.settleUnderlyingPrice;
    group.viewMode = 'settlement';

    closeExecution.pendingRequest = false;
    closeExecution.lastError = '';
    closeExecution.status = 'submitted';
    closeExecution.lastPreview = _buildHistoricalClosePreview(group, settledLegs);

    renderGroups();
    if (typeof updateDerivedValues === 'function') {
        updateDerivedValues();
    }
    return true;
}

function requestCloseGroupComboOrder(group) {
    if (!group) return false;
    if (_isHistoricalMode()) {
        const didSettle = _settleHistoricalReplayGroup(group);
        if (!didSettle) {
            renderGroups();
        }
        return didSettle;
    }
    if (!isWsConnected || !ws) {
        _markCloseExecutionError(group, 'WebSocket is not connected.');
        renderGroups();
        return false;
    }
    if (!_groupHasOpenPositions(group)) {
        _markCloseExecutionError(group, 'This group has no open position to close.');
        renderGroups();
        return false;
    }
    if (typeof OptionComboSessionLogic !== 'undefined'
        && typeof OptionComboSessionLogic.getRenderableGroupViewMode === 'function'
        && OptionComboSessionLogic.getRenderableGroupViewMode(group) !== 'active') {
        _markCloseExecutionError(group, 'Close Group is only available when this group is in Active mode.');
        renderGroups();
        return false;
    }

    const closeExecution = _getCloseExecution(group);
    if (!closeExecution || closeExecution.pendingRequest) {
        return false;
    }

    const executionMode = closeExecution.executionMode === 'submit' || closeExecution.executionMode === 'test_submit'
        ? closeExecution.executionMode
        : 'preview';

    if ((executionMode === 'submit' || executionMode === 'test_submit') && state.allowLiveComboOrders !== true) {
        _markCloseExecutionError(group, 'Global live combo order switch is OFF.');
        renderGroups();
        return false;
    }
    if ((executionMode === 'submit' || executionMode === 'test_submit') && !_hasSelectedLiveComboOrderAccount()) {
        _markCloseExecutionError(group, _getLiveComboOrderAccountRequirementMessage());
        if (state.allowLiveComboOrders === true) {
            requestManagedAccountsSnapshot();
        }
        renderGroups();
        return false;
    }

    const payload = _buildCloseGroupComboOrderPayload(group, closeExecution, executionMode);
    if (!payload) {
        _markCloseExecutionError(group, 'Unable to build close-group combo order payload.');
        renderGroups();
        return false;
    }

    closeExecution.pendingRequest = true;
    closeExecution.lastError = '';
    if (executionMode === 'preview') {
        closeExecution.status = 'pending_preview';
    } else {
        payload.action = 'validate_combo_order';
        closeExecution.status = 'pending_validation';
    }
    ws.send(JSON.stringify(payload));
    renderGroups();
    return true;
}

function requestHistoricalReplayEntryGroup(group) {
    if (!_isHistoricalMode()) {
        return false;
    }

    const didLock = _lockHistoricalReplayEntryCosts(group);
    if (!didLock) {
        renderGroups();
    }
    return didLock;
}

function requestHistoricalReplayExpirySettlementSync(group) {
    if (!_isHistoricalMode()) {
        return false;
    }

    const didSync = _applyHistoricalAutoExpirySettlement(group);
    renderGroups();
    updateDerivedValues();
    return didSync;
}

function toggleWsPortControls() {
    const controls = document.getElementById('wsPortControls');
    if (!controls) return;
    controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
}

function applyWsPort() {
    applyWsEndpoint();
}

function applyWsEndpoint() {
    const hostInput = document.getElementById('wsHostInput');
    const portInput = document.getElementById('wsPortInput');
    if (!portInput) return;

    const safeHost = _normalizeWsHost(hostInput && hostInput.value);
    const safePort = _normalizeWsPort(portInput.value);
    if (hostInput) hostInput.value = safeHost;
    portInput.value = String(safePort);
    _setSavedWsHost(safeHost);
    _setSavedWsPort(safePort);
    reconnectWebSocket();
}

function resetWsPort() {
    resetWsEndpoint();
}

function resetWsEndpoint() {
    _setSavedWsHost(DEFAULT_WS_HOST);
    _setSavedWsPort(DEFAULT_WS_PORT);
    _syncWsHostInput(DEFAULT_WS_HOST);
    _syncWsPortInput(DEFAULT_WS_PORT);
    reconnectWebSocket();
}

function initWsPortControls() {
    const savedHost = _getSavedWsHost();
    const savedPort = _getSavedWsPort();
    _syncWsHostInput(savedHost);
    _syncWsPortInput(savedPort);
    updateWsStatusUI('disconnected');
}

window.toggleWsPortControls = toggleWsPortControls;
window.applyWsPort = applyWsPort;
window.resetWsPort = resetWsPort;
window.applyWsEndpoint = applyWsEndpoint;
window.resetWsEndpoint = resetWsEndpoint;
window.requestPortfolioAvgCostSnapshot = requestPortfolioAvgCostSnapshot;
window.requestContinueManagedComboOrder = requestContinueManagedComboOrder;
window.requestConcedeManagedComboOrder = requestConcedeManagedComboOrder;
window.requestCancelManagedComboOrder = requestCancelManagedComboOrder;
window.requestCloseGroupComboOrder = requestCloseGroupComboOrder;
window.requestHistoricalReplayEntryGroup = requestHistoricalReplayEntryGroup;
window.requestHistoricalReplayExpirySettlementSync = requestHistoricalReplayExpirySettlementSync;

// -------------------------------------------------------------
// Subscription Management
// -------------------------------------------------------------

function _toContractMonth(dateStr) {
    const normalizedDate = _normalizeHistoricalDateKey(dateStr);
    if (normalizedDate) return normalizedDate.replace(/-/g, '').slice(0, 6);
    return String(dateStr || '').replace(/\D/g, '').slice(0, 6);
}

function _normalizeHistoricalDateKey(value) {
    const rawValue = String(value || '').trim();
    if (!rawValue) return '';

    if (typeof OptionComboDateUtils !== 'undefined'
        && typeof OptionComboDateUtils.normalizeDateInput === 'function') {
        const normalized = String(OptionComboDateUtils.normalizeDateInput(rawValue) || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
            return normalized;
        }
    }

    const digitsOnly = rawValue.replace(/\D/g, '');
    if (digitsOnly.length === 8) {
        return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6, 8)}`;
    }

    return '';
}

function _toContractDateCode(dateStr) {
    const normalizedDate = _normalizeHistoricalDateKey(dateStr);
    if (normalizedDate) return normalizedDate.replace(/-/g, '');
    return String(dateStr || '').replace(/\D/g, '').slice(0, 8);
}

function _resolveFuturesPoolEntryById(entryId) {
    if (!entryId) return null;
    return (state.futuresPool || []).find(entry => entry.id === entryId) || null;
}

function _buildFuturesPoolRequests(profile) {
    if (!profile || profile.underlyingSecType !== 'FUT') {
        return [];
    }

    return (state.futuresPool || [])
        .filter(entry => /^\d{6}$/.test(String(entry && entry.contractMonth || '')))
        .map(entry => ({
            id: entry.id,
            secType: 'FUT',
            symbol: profile.underlyingSymbol,
            exchange: profile.underlyingExchange,
            currency: profile.currency || 'USD',
            multiplier: String(profile.optionMultiplier || ''),
            contractMonth: entry.contractMonth,
        }));
}

function _buildUnderlyingRequest(profile, optionRequests, futuresRequests) {
    const defaultUnderlyingContractMonth = profile?.underlyingSecType === 'FUT'
        && typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth === 'function'
        ? OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            _getQuoteReferenceDate()
        )
        : '';
    const request = {
        enteredSymbol: state.underlyingSymbol,
        family: profile.family,
        secType: profile.underlyingSecType,
        symbol: profile.underlyingSymbol,
        exchange: profile.underlyingExchange,
        currency: profile.currency || 'USD',
    };

    if (profile.underlyingSecType === 'FUT') {
        const anchorFuture = Array.isArray(futuresRequests) && futuresRequests.length > 0
            ? futuresRequests.slice().sort((left, right) => String(left.contractMonth || '').localeCompare(String(right.contractMonth || '')))[0]
            : null;
        request.contractMonth = state.underlyingContractMonth
            || anchorFuture?.contractMonth
            || defaultUnderlyingContractMonth
            || optionRequests[0]?.underlyingContractMonth
            || optionRequests[0]?.contractMonth
            || _toContractMonth(_getQuoteReferenceDate())
            || _toContractMonth(state.baseDate);
        request.multiplier = String(profile.optionMultiplier || '');
    }

    return request;
}

function _buildHistoricalSnapshotPayload(underlyingRequest, optionRequests, futuresRequests) {
    return {
        action: 'request_historical_snapshot',
        replayDate: _getHistoricalReplayDate(),
        underlying: underlyingRequest,
        options: optionRequests,
        futures: futuresRequests,
        stocks: [],
    };
}

function handleLiveSubscriptions() {
    if (!isWsConnected || !ws) return;
    _resetLiveQuoteRuntime();
    const profile = typeof OptionComboProductRegistry === 'undefined'
        ? null
        : OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol);
    if (!_isHistoricalMode()
        && typeof OptionComboProductRegistry !== 'undefined'
        && !OptionComboProductRegistry.supportsLegacyLiveData(state.underlyingSymbol)) {
        if (!_legacyLiveDataWarningShown) {
            console.warn(`Legacy live-data subscriptions are not implemented for ${state.underlyingSymbol}. Use manual prices for now.`);
            _legacyLiveDataWarningShown = true;
        }
        return;
    }

    const optionRequests = [];
    const futuresRequests = _buildFuturesPoolRequests(profile || {});
    const payload = {
        action: 'subscribe',
        underlying: null,
        options: optionRequests,
        futures: futuresRequests,
        stocks: []
    };

    if (profile?.underlyingSecType === 'IND'
        && typeof OptionComboIndexForwardRate !== 'undefined'
        && typeof OptionComboIndexForwardRate.buildSampleSubscriptionId === 'function') {
        (state.forwardRateSamples || []).forEach((sample) => {
            if (!sample || !sample.expDate || !Number.isFinite(parseFloat(sample.strike))) {
                return;
            }

            const optionContractSpec = typeof OptionComboProductRegistry !== 'undefined'
                && typeof OptionComboProductRegistry.resolveOptionContractSpec === 'function'
                ? OptionComboProductRegistry.resolveOptionContractSpec(state.underlyingSymbol, sample.expDate)
                : null;

            ['call', 'put'].forEach((rightLabel) => {
                optionRequests.push({
                    id: OptionComboIndexForwardRate.buildSampleSubscriptionId(sample, rightLabel),
                    secType: profile?.optionSecType || 'OPT',
                    symbol: optionContractSpec?.symbol || profile?.optionSymbol || state.underlyingSymbol,
                    underlyingSymbol: profile?.underlyingSymbol || state.underlyingSymbol,
                    exchange: profile?.optionExchange || 'SMART',
                    underlyingExchange: profile?.underlyingExchange || profile?.optionExchange || 'SMART',
                    currency: profile?.currency || 'USD',
                    multiplier: String(profile?.optionMultiplier || 100),
                    underlyingMultiplier: String(profile?.optionMultiplier || 100),
                    tradingClass: optionContractSpec?.tradingClass
                        || (profile?.tradingClass || undefined),
                    right: rightLabel === 'put' ? 'P' : 'C',
                    strike: parseFloat(sample.strike),
                        expDate: _toContractDateCode(sample.expDate),
                    contractMonth: _toContractMonth(sample.expDate),
                });
            });
        });
    }

    // Collect all legs from groups that have Live Data == true
    state.groups.forEach(group => {
        if (group.liveData) {
            group.legs.forEach(leg => {
                if (!_isUnderlyingLeg(leg)) {
                    const selectedFuture = _resolveFuturesPoolEntryById(leg.underlyingFutureId);
                    const optionContractSpec = typeof OptionComboProductRegistry !== 'undefined'
                        && typeof OptionComboProductRegistry.resolveOptionContractSpec === 'function'
                        ? OptionComboProductRegistry.resolveOptionContractSpec(state.underlyingSymbol, leg.expDate)
                        : null;
                    optionRequests.push({
                        id: leg.id,
                        secType: profile?.optionSecType || 'OPT',
                        symbol: optionContractSpec?.symbol || profile?.optionSymbol || state.underlyingSymbol,
                        underlyingSymbol: profile?.underlyingSymbol || state.underlyingSymbol,
                        exchange: profile?.optionExchange || 'SMART',
                        underlyingExchange: profile?.underlyingExchange || profile?.optionExchange || 'SMART',
                        currency: profile?.currency || 'USD',
                        multiplier: String(profile?.optionMultiplier || 100),
                        underlyingMultiplier: String(profile?.optionMultiplier || 100),
                        tradingClass: optionContractSpec?.tradingClass
                            || (profile?.tradingClass || undefined),
                        right: leg.type.charAt(0).toUpperCase(), // 'C' or 'P'
                        strike: leg.strike,
                        expDate: _toContractDateCode(leg.expDate),
                        contractMonth: _toContractMonth(leg.expDate),
                        underlyingContractMonth: selectedFuture?.contractMonth
                            || state.underlyingContractMonth
                            || (typeof OptionComboProductRegistry !== 'undefined'
                                && typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth === 'function'
                                ? OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
                                    state.underlyingSymbol,
                                    _getQuoteReferenceDate()
                                )
                                : ''),
                    });
                }
            });
        }
    });

    payload.underlying = _buildUnderlyingRequest(profile || {
        family: 'DEFAULT_EQUITY',
        underlyingSecType: 'STK',
        underlyingSymbol: state.underlyingSymbol,
        underlyingExchange: 'SMART',
        currency: 'USD',
    }, optionRequests, futuresRequests);

    // Collect all hedge stocks that have Live Data == true
    state.hedges.forEach(hedge => {
        if (hedge.liveData && hedge.symbol) {
            payload.stocks.push(hedge.symbol);
        }
    });

    if (_isHistoricalMode()) {
        ws.send(JSON.stringify(_buildHistoricalSnapshotPayload(payload.underlying, optionRequests, futuresRequests)));
        return;
    }

    ws.send(JSON.stringify(payload));
    requestPortfolioAvgCostSnapshot();
    if (state.allowLiveComboOrders === true
        || !Array.isArray(state.liveComboOrderAccounts)
        || state.liveComboOrderAccounts.length === 0
        || state.liveComboOrderAccountsConnected !== true) {
        requestManagedAccountsSnapshot();
    }
}

function requestUnderlyingPriceSync() {
    if (!isWsConnected || !ws) {
        alert("Live Market Data WebSocket is not connected.");
        return;
    }

    if (_isHistoricalMode()) {
        handleLiveSubscriptions();
        return;
    }

    if (typeof OptionComboProductRegistry !== 'undefined'
        && !OptionComboProductRegistry.supportsLegacyLiveData(state.underlyingSymbol)) {
        alert(`Live underlying sync is not implemented yet for ${state.underlyingSymbol}. Please enter the underlying price manually.`);
        return;
    }

    const payload = {
        action: 'sync_underlying',
        underlying: _buildUnderlyingRequest(
            typeof OptionComboProductRegistry === 'undefined'
                ? {
                    family: 'DEFAULT_EQUITY',
                    underlyingSecType: 'STK',
                    underlyingSymbol: state.underlyingSymbol,
                    underlyingExchange: 'SMART',
                    currency: 'USD',
                }
                : OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol),
            [],
            _buildFuturesPoolRequests(
                typeof OptionComboProductRegistry === 'undefined'
                    ? { underlyingSecType: 'STK' }
                    : OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol)
            )
        )
    };

    ws.send(JSON.stringify(payload));
}

function _findGroupById(groupId) {
    return (state.groups || []).find(group => group.id === groupId);
}

function _isPortfolioAvgCostSyncEnabled(group) {
    if (typeof OptionComboSessionLogic !== 'undefined'
        && typeof OptionComboSessionLogic.isPortfolioAvgCostSyncEnabled === 'function') {
        return OptionComboSessionLogic.isPortfolioAvgCostSyncEnabled(group);
    }
    return !!(group && group.syncAvgCostFromPortfolio);
}

function _normalizeContractDate(value) {
    return String(value || '').replace(/[^0-9]/g, '').slice(0, 8);
}

function _normalizeRightCode(value) {
    return String(value || '').trim().toUpperCase().slice(0, 1);
}

function _normalizeSecType(value) {
    return String(value || '').trim().toUpperCase();
}

function _resolveLegContractDescriptor(leg) {
    const profile = typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.resolveUnderlyingProfile === 'function'
        ? OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol)
        : {
            optionSecType: 'OPT',
            underlyingSecType: 'STK',
            optionSymbol: state.underlyingSymbol,
            underlyingSymbol: state.underlyingSymbol,
        };

    const optionContractSpec = typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.resolveOptionContractSpec === 'function'
        ? OptionComboProductRegistry.resolveOptionContractSpec(state.underlyingSymbol, leg && leg.expDate)
        : null;

    if (_isUnderlyingLeg(leg)) {
        return {
            secType: _normalizeSecType(profile.underlyingSecType || 'STK'),
            symbol: String(profile.underlyingSymbol || state.underlyingSymbol || '').trim().toUpperCase(),
            right: '',
            expDate: '',
            strike: null,
        };
    }

    return {
        secType: _normalizeSecType(profile.optionSecType || 'OPT'),
        symbol: String(
            optionContractSpec?.symbol
            || profile.optionSymbol
            || state.underlyingSymbol
            || ''
        ).trim().toUpperCase(),
        right: _normalizeRightCode(leg.type),
        expDate: _normalizeContractDate(leg.expDate),
        strike: parseFloat(leg.strike),
    };
}

function _matchesPortfolioAvgCostItem(leg, item) {
    const descriptor = _resolveLegContractDescriptor(leg);
    if (descriptor.secType !== _normalizeSecType(item.secType)) {
        return false;
    }
    if (descriptor.symbol !== String(item.symbol || '').trim().toUpperCase()) {
        return false;
    }

    if (_isUnderlyingLeg(leg)) {
        return true;
    }

    if (descriptor.right !== _normalizeRightCode(item.right)) {
        return false;
    }
    if (_normalizeContractDate(descriptor.expDate) !== _normalizeContractDate(item.expDate)) {
        return false;
    }

    const itemStrike = parseFloat(item.strike);
    if (!Number.isFinite(descriptor.strike) || !Number.isFinite(itemStrike)) {
        return false;
    }

    return Math.abs(descriptor.strike - itemStrike) < 0.0001;
}

function _parsePositivePortfolioMarketPrice(rawValue) {
    const parsed = parseFloat(rawValue);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function _parsePortfolioPnlValue(rawValue) {
    const parsed = parseFloat(rawValue);
    return Number.isFinite(parsed) ? parsed : null;
}

function _applyPortfolioValuationToLeg(leg, item) {
    let changed = false;

    const nextPortfolioMarketPrice = _parsePositivePortfolioMarketPrice(item.marketPrice);
    if (nextPortfolioMarketPrice === null) {
        if (leg.portfolioMarketPrice !== null && leg.portfolioMarketPrice !== undefined) {
            leg.portfolioMarketPrice = null;
            changed = true;
        }
        if (leg.portfolioMarketPriceSource) {
            leg.portfolioMarketPriceSource = '';
            changed = true;
        }
    } else if (Math.abs((parseFloat(leg.portfolioMarketPrice) || 0) - nextPortfolioMarketPrice) > 0.0001
        || leg.portfolioMarketPriceSource !== 'tws_portfolio') {
        leg.portfolioMarketPrice = nextPortfolioMarketPrice;
        leg.portfolioMarketPriceSource = 'tws_portfolio';
        changed = true;
    }

    const nextPortfolioUnrealizedPnl = _parsePortfolioPnlValue(item.unrealizedPNL);
    if (nextPortfolioUnrealizedPnl === null) {
        if (leg.portfolioUnrealizedPnl !== null && leg.portfolioUnrealizedPnl !== undefined) {
            leg.portfolioUnrealizedPnl = null;
            changed = true;
        }
    } else if (Math.abs((parseFloat(leg.portfolioUnrealizedPnl) || 0) - nextPortfolioUnrealizedPnl) > 0.0001) {
        leg.portfolioUnrealizedPnl = nextPortfolioUnrealizedPnl;
        changed = true;
    }

    return changed;
}

function _applyPortfolioAvgCostUpdate(data) {
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (items.length === 0) {
        return true;
    }

    let stateChanged = false;

    state.groups.forEach(group => {
        (group.legs || []).forEach(leg => {
            const match = items.find(item => {
                const position = parseFloat(item.position);
                if (!Number.isFinite(position) || position === 0) {
                    return false;
                }
                if (Math.sign(position) !== Math.sign(parseFloat(leg.pos) || 0)) {
                    return false;
                }
                return _matchesPortfolioAvgCostItem(leg, item);
            });

            if (!match) {
                return;
            }

            stateChanged = _applyPortfolioValuationToLeg(leg, match) || stateChanged;

            if (!_isPortfolioAvgCostSyncEnabled(group) || (leg && leg.costSource === 'execution_report')) {
                return;
            }

            const nextCost = Math.abs(parseFloat(match.avgCostPerUnit));
            if (!Number.isFinite(nextCost) || nextCost <= 0) {
                return;
            }

            if (Math.abs((parseFloat(leg.cost) || 0) - nextCost) <= 0.0001) {
                return;
            }

            leg.cost = nextCost;
            leg.costSource = 'portfolio_avg_cost';
            leg.executionReportedCost = false;
            stateChanged = true;

            const row = document.querySelector(`tr[data-id="${leg.id}"]`);
            if (row) {
                const costInput = row.querySelector('.cost-input');
                if (costInput) {
                    costInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, nextCost);
                    flashElement(costInput);
                }
            }
        });

        if (typeof OptionComboSessionLogic !== 'undefined'
            && typeof OptionComboSessionLogic.groupHasDeterministicCost === 'function'
            && typeof OptionComboSessionLogic.getRenderableGroupViewMode === 'function') {
            const trigger = _getTradeTrigger(group);
            const brokerStatus = String(trigger && trigger.lastPreview && trigger.lastPreview.status || '').trim();
            const executionMode = String(trigger && trigger.lastPreview && trigger.lastPreview.executionMode || '').trim();
            const renderMode = OptionComboSessionLogic.getRenderableGroupViewMode(group);

            if (renderMode === 'trial'
                && brokerStatus === 'Filled'
                && executionMode === 'submit'
                && OptionComboSessionLogic.groupHasDeterministicCost(group)) {
                group.viewMode = 'active';
                stateChanged = true;
            }
        }
    });

    if (stateChanged) {
        if (typeof renderGroups === 'function') {
            renderGroups();
        } else {
            updateDerivedValues();
        }
    }

    return true;
}

function _groupHasCostForAllPositionedLegs(group) {
    return (group.legs || []).every(leg => {
        const pos = parseFloat(leg && leg.pos);
        if (!Number.isFinite(pos) || Math.abs(pos) < 0.0001) {
            return true;
        }
        return Math.abs(parseFloat(leg.cost) || 0) > 0;
    });
}

function _shouldHistoricalAutoCloseAtExpiry(group) {
    if (group && typeof group === 'object'
        && typeof OptionComboSessionLogic !== 'undefined'
        && typeof OptionComboSessionLogic.normalizeHistoricalAutoCloseAtExpiry === 'function') {
        group.historicalAutoCloseAtExpiry = OptionComboSessionLogic.normalizeHistoricalAutoCloseAtExpiry(
            group.historicalAutoCloseAtExpiry
        );
        return group.historicalAutoCloseAtExpiry;
    }

    if (group && typeof group === 'object') {
        group.historicalAutoCloseAtExpiry = group.historicalAutoCloseAtExpiry !== false;
        return group.historicalAutoCloseAtExpiry;
    }

    return true;
}

function _getTradeTrigger(group) {
    if (!group) return null;
    return OptionComboTradeTriggerLogic.ensureGroupTradeTrigger(group);
}

function _getCloseExecution(group) {
    if (!group) return null;
    group.closeExecution = OptionComboSessionLogic.normalizeCloseExecution(group.closeExecution);
    return group.closeExecution;
}

function _getExecutionRuntimeByKind(group, runtimeKind) {
    return runtimeKind === 'closeExecution'
        ? _getCloseExecution(group)
        : _getTradeTrigger(group);
}

function _resolveExecutionRuntime(group, payload) {
    const descriptor = payload && typeof payload === 'object' ? payload : {};
    const requestSource = String(descriptor.requestSource || descriptor.source || '').trim().toLowerCase();
    const executionIntent = String(descriptor.executionIntent || descriptor.intent || '').trim().toLowerCase();
    const tradeTrigger = _getTradeTrigger(group);
    const closeExecution = _getCloseExecution(group);
    const descriptorOrderId = descriptor.orderId;
    const descriptorPermId = descriptor.permId;

    let runtimeKind = null;
    if (requestSource === 'close_group' || executionIntent === 'close') {
        runtimeKind = 'closeExecution';
    } else if (requestSource === 'trial_trigger' || executionIntent === 'open') {
        runtimeKind = 'tradeTrigger';
    } else {
        const closePreview = closeExecution && closeExecution.lastPreview && typeof closeExecution.lastPreview === 'object'
            ? closeExecution.lastPreview
            : null;
        const triggerPreview = tradeTrigger && tradeTrigger.lastPreview && typeof tradeTrigger.lastPreview === 'object'
            ? tradeTrigger.lastPreview
            : null;
        const closeMatchesOrder = !!(
            closePreview
            && (
                (descriptorOrderId != null && closePreview.orderId === descriptorOrderId)
                || (descriptorPermId != null && closePreview.permId === descriptorPermId)
            )
        );
        const triggerMatchesOrder = !!(
            triggerPreview
            && (
                (descriptorOrderId != null && triggerPreview.orderId === descriptorOrderId)
                || (descriptorPermId != null && triggerPreview.permId === descriptorPermId)
            )
        );

        if (closeMatchesOrder && !triggerMatchesOrder) {
            runtimeKind = 'closeExecution';
        } else if (triggerMatchesOrder && !closeMatchesOrder) {
            runtimeKind = 'tradeTrigger';
        } else if (closeExecution && closeExecution.pendingRequest === true && !(tradeTrigger && tradeTrigger.pendingRequest === true)) {
            runtimeKind = 'closeExecution';
        } else if (tradeTrigger && tradeTrigger.pendingRequest === true && !(closeExecution && closeExecution.pendingRequest === true)) {
            runtimeKind = 'tradeTrigger';
        } else {
            runtimeKind = 'tradeTrigger';
        }
    }

    return {
        runtime: runtimeKind === 'closeExecution' ? closeExecution : tradeTrigger,
        runtimeKind,
    };
}

function _markTradeTriggerError(group, message) {
    const trigger = _getTradeTrigger(group);
    if (!trigger) return;

    trigger.enabled = false;
    trigger.pendingRequest = false;
    trigger.status = 'error';
    trigger.lastError = message;
}

function _markCloseExecutionError(group, message) {
    const closeExecution = _getCloseExecution(group);
    if (!closeExecution) return;

    closeExecution.pendingRequest = false;
    closeExecution.status = 'error';
    closeExecution.lastError = message;
}

function _markExecutionError(group, message, runtimeKind) {
    if (runtimeKind === 'closeExecution') {
        _markCloseExecutionError(group, message);
        return;
    }

    _markTradeTriggerError(group, message);
}

function _groupHasOpenPositions(group) {
    if (typeof OptionComboSessionLogic !== 'undefined'
        && typeof OptionComboSessionLogic.groupHasOpenPosition === 'function') {
        return OptionComboSessionLogic.groupHasOpenPosition(group);
    }

    return (group.legs || []).some((leg) => {
        const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
        const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== '';
        return pos > 0.0001 && !hasClosePrice;
    });
}

function _maybePromoteFilledTrialGroupToActive(group, runtime) {
    if (typeof OptionComboSessionLogic === 'undefined'
        || typeof OptionComboSessionLogic.getRenderableGroupViewMode !== 'function') {
        return;
    }

    const brokerStatus = String(runtime && runtime.lastPreview && runtime.lastPreview.status || '').trim();
    const executionMode = String(runtime && runtime.lastPreview && runtime.lastPreview.executionMode || '').trim();
    const renderMode = OptionComboSessionLogic.getRenderableGroupViewMode(group);

    if (renderMode === 'trial'
        && brokerStatus === 'Filled'
        && executionMode === 'submit'
        && _groupHasCostForAllPositionedLegs(group)) {
        group.viewMode = 'active';
    }
}

function _sendValidatedComboSubmit(group, executionMode) {
    if (!group) {
        return false;
    }

    if (_isHistoricalMode()) {
        const trigger = _getTradeTrigger(group);
        if (!trigger) {
            return false;
        }

        trigger.pendingRequest = true;
        trigger.lastError = '';
        trigger.status = executionMode === 'test_submit' ? 'pending_test_submit' : 'pending_submit';
        return _applyHistoricalTriggerOrderPreview(group, executionMode);
    }

    if (!isWsConnected || !ws) {
        return false;
    }

    const payload = typeof OptionComboTradeTriggerLogic !== 'undefined'
        && typeof OptionComboTradeTriggerLogic.buildComboOrderRequestPayload === 'function'
        ? OptionComboTradeTriggerLogic.buildComboOrderRequestPayload(group, state, executionMode)
        : null;

    if (!payload) {
        _markTradeTriggerError(group, 'Unable to build combo submit payload.');
        renderGroups();
        return false;
    }

    const trigger = _getTradeTrigger(group);
    if (!trigger) {
        return false;
    }

    trigger.pendingRequest = true;
    trigger.lastError = '';
    trigger.status = executionMode === 'test_submit' ? 'pending_test_submit' : 'pending_submit';
    ws.send(JSON.stringify(payload));
    renderGroups();
    return true;
}

function _requestTrialGroupComboOrder(group) {
    if (!group) return;
    const trigger = _getTradeTrigger(group);
    if (!trigger) return;

    const executionMode = trigger.executionMode === 'submit' || trigger.executionMode === 'test_submit'
        ? trigger.executionMode
        : 'preview';

    if (_isHistoricalMode()) {
        trigger.pendingRequest = true;
        trigger.status = executionMode === 'submit'
            ? 'pending_submit'
            : (executionMode === 'test_submit' ? 'pending_test_submit' : 'pending_preview');
        trigger.lastError = '';
        trigger.lastTriggeredAt = new Date().toISOString();
        trigger.lastTriggerPrice = state.underlyingPrice;
        _applyHistoricalTriggerOrderPreview(group, executionMode);
        return;
    }

    if (!isWsConnected || !ws) {
        _markTradeTriggerError(group, 'WebSocket is not connected.');
        renderGroups();
        return;
    }

    if ((executionMode === 'submit' || executionMode === 'test_submit') && state.allowLiveComboOrders !== true) {
        _markTradeTriggerError(group, 'Global live combo order switch is OFF.');
        renderGroups();
        return;
    }
    if ((executionMode === 'submit' || executionMode === 'test_submit') && !_hasSelectedLiveComboOrderAccount()) {
        _markTradeTriggerError(group, _getLiveComboOrderAccountRequirementMessage());
        if (state.allowLiveComboOrders === true) {
            requestManagedAccountsSnapshot();
        }
        renderGroups();
        return;
    }

    const payload = typeof OptionComboTradeTriggerLogic !== 'undefined'
        && typeof OptionComboTradeTriggerLogic.buildComboOrderRequestPayload === 'function'
        ? OptionComboTradeTriggerLogic.buildComboOrderRequestPayload(group, state, executionMode)
        : null;

    if (!payload) {
        _markTradeTriggerError(group, 'Unable to build combo order payload.');
        renderGroups();
        return;
    }

    trigger.pendingRequest = true;
    if (executionMode === 'submit' || executionMode === 'test_submit') {
        payload.action = 'validate_combo_order';
        trigger.status = 'pending_validation';
    } else {
        trigger.status = 'pending_preview';
    }
    trigger.lastError = '';
    trigger.lastTriggeredAt = new Date().toISOString();
    trigger.lastTriggerPrice = state.underlyingPrice;

    ws.send(JSON.stringify(payload));
    renderGroups();
}

function _applyComboOrderValidationResult(data) {
    const group = _findGroupById(data.groupId);
    if (!group) return true;

    const validation = data.validation || {};
    const { runtime, runtimeKind } = _resolveExecutionRuntime(group, validation);
    if (!runtime) return true;

    if (validation.valid !== true) {
        _markExecutionError(group, 'Combo validation failed.', runtimeKind);
        renderGroups();
        return true;
    }

    if (!isWsConnected || !ws) {
        _markExecutionError(group, 'WebSocket is not connected.', runtimeKind);
        renderGroups();
        return true;
    }

    const nextMode = validation.executionMode === 'test_submit' ? 'test_submit' : 'submit';
    if (_isHistoricalMode()) {
        if (runtimeKind === 'closeExecution') {
            requestCloseGroupComboOrder(group);
            return true;
        }
        runtime.pendingRequest = false;
        _sendValidatedComboSubmit(group, nextMode);
        return true;
    }
    if (state.allowLiveComboOrders !== true) {
        _markExecutionError(group, 'Global live combo order switch is OFF.', runtimeKind);
        renderGroups();
        return true;
    }
    if (!_hasSelectedLiveComboOrderAccount()) {
        _markExecutionError(group, _getLiveComboOrderAccountRequirementMessage(), runtimeKind);
        requestManagedAccountsSnapshot();
        renderGroups();
        return true;
    }

    runtime.pendingRequest = false;
    if (runtimeKind === 'closeExecution') {
        const payload = _buildCloseGroupComboOrderPayload(group, runtime, nextMode);
        if (!payload) {
            _markCloseExecutionError(group, 'Unable to build close-group combo submit payload.');
            renderGroups();
            return true;
        }

        runtime.pendingRequest = true;
        runtime.lastError = '';
        runtime.status = 'pending_submit';
        ws.send(JSON.stringify(payload));
        renderGroups();
        return true;
    }

    return _sendValidatedComboSubmit(group, nextMode);
}

function _applyComboOrderResult(data) {
    const group = _findGroupById(data.groupId);
    if (!group) return true;

    const payload = data.preview || data.order || {};
    const { runtime, runtimeKind } = _resolveExecutionRuntime(group, payload);
    if (!runtime) return true;

    runtime.pendingRequest = false;
    if (runtimeKind === 'tradeTrigger') {
        runtime.enabled = false;
    }
    runtime.lastPreview = payload || null;
    const orderStatus = String((runtime.lastPreview && runtime.lastPreview.status) || '').trim();
    const statusMessage = String((runtime.lastPreview && runtime.lastPreview.statusMessage) || '').trim();
    if (data.action === 'combo_order_submit_result'
        && ['Cancelled', 'Inactive', 'ApiCancelled'].includes(orderStatus)) {
        runtime.lastError = statusMessage || `TWS returned ${orderStatus}.`;
        runtime.status = 'error';
    } else if (data.action === 'combo_order_submit_result') {
        runtime.lastError = '';
        runtime.status = runtime.lastPreview && runtime.lastPreview.executionMode === 'test_submit'
            ? 'test_submitted'
            : 'submitted';
    } else {
        runtime.lastError = '';
        runtime.status = 'previewed';
    }

    if (data.action === 'combo_order_submit_result'
        && String(runtime.lastPreview && runtime.lastPreview.status || '').trim() === 'Filled'
        && String(runtime.lastPreview && runtime.lastPreview.executionMode || '').trim() === 'submit') {
        if (runtimeKind !== 'closeExecution') {
            _maybePromoteFilledTrialGroupToActive(group, runtime);
        }
    }

    renderGroups();
    updateDerivedValues();
    return true;
}

function _applyComboOrderStatusUpdate(data) {
    const group = _findGroupById(data.groupId);
    if (!group) return true;

    const update = data.orderStatus || {};
    const { runtime, runtimeKind } = _resolveExecutionRuntime(group, update);
    if (!runtime) return true;

    if (!runtime.lastPreview || typeof runtime.lastPreview !== 'object') {
        runtime.lastPreview = {};
    }

    if (update.managedMode === false) {
        const {
            managedMode,
            managedState,
            workingLimitPrice,
            latestComboMid,
            bestComboPrice,
            worstComboPrice,
            managedRepriceThreshold,
            managedConcessionRatio,
            repricingCount,
            maxRepriceCount,
            lastRepriceAt,
            managedMessage,
            canContinueRepricing,
            canConcedePricing,
            continueActionLabel,
            ...nonManagedPreview
        } = runtime.lastPreview;
        runtime.lastPreview = nonManagedPreview;
    }

    runtime.lastPreview = {
        ...runtime.lastPreview,
        ...update,
    };

    if (update.executionMode === 'test_submit') {
        runtime.status = 'test_submitted';
    } else if (update.executionMode === 'submit') {
        runtime.status = 'submitted';
    }

    if (String(runtime.lastPreview.status || '').trim() === 'Filled'
        && String(runtime.lastPreview.executionMode || '').trim() === 'submit') {
        if (runtimeKind !== 'closeExecution') {
            _maybePromoteFilledTrialGroupToActive(group, runtime);
        }
    }

    renderGroups();
    updateDerivedValues();
    return true;
}

function _applyComboOrderResumeResult(data) {
    const group = _findGroupById(data.groupId);
    if (!group) return true;

    const orderStatus = data.orderStatus || {};
    const { runtime } = _resolveExecutionRuntime(group, orderStatus);
    if (!runtime) return true;

    runtime.pendingRequest = false;
    runtime.lastError = '';
    if (!runtime.lastPreview || typeof runtime.lastPreview !== 'object') {
        runtime.lastPreview = {};
    }
    runtime.lastPreview = {
        ...runtime.lastPreview,
        ...orderStatus,
    };
    runtime.status = 'submitted';
    renderGroups();
    updateDerivedValues();
    return true;
}

function _applyComboOrderConcedeResult(data) {
    const group = _findGroupById(data.groupId);
    if (!group) return true;

    const orderStatus = data.orderStatus || {};
    const { runtime } = _resolveExecutionRuntime(group, orderStatus);
    if (!runtime) return true;

    runtime.pendingRequest = false;
    runtime.lastError = '';
    if (!runtime.lastPreview || typeof runtime.lastPreview !== 'object') {
        runtime.lastPreview = {};
    }
    runtime.lastPreview = {
        ...runtime.lastPreview,
        ...orderStatus,
    };
    runtime.status = 'submitted';
    renderGroups();
    updateDerivedValues();
    return true;
}

function _applyComboOrderCancelResult(data) {
    const group = _findGroupById(data.groupId);
    if (!group) return true;

    const orderStatus = data.orderStatus || {};
    const { runtime } = _resolveExecutionRuntime(group, orderStatus);
    if (!runtime) return true;

    runtime.pendingRequest = false;
    runtime.lastError = '';
    if (!runtime.lastPreview || typeof runtime.lastPreview !== 'object') {
        runtime.lastPreview = {};
    }
    runtime.lastPreview = {
        ...runtime.lastPreview,
        ...orderStatus,
    };
    runtime.status = 'pending_cancel';
    renderGroups();
    updateDerivedValues();
    return true;
}

function _applyComboOrderFillCostUpdate(data) {
    const group = _findGroupById(data.groupId);
    if (!group) return true;

    const orderFill = data.orderFill || {};
    const { runtime, runtimeKind } = _resolveExecutionRuntime(group, orderFill);
    const legs = Array.isArray(orderFill.legs) ? orderFill.legs : [];
    if (legs.length === 0) {
        return true;
    }

    let stateChanged = false;
    legs.forEach(fillLeg => {
        const leg = (group.legs || []).find(item => item.id === fillLeg.id);
        if (!leg) {
            return;
        }

        const nextCost = Math.abs(parseFloat(fillLeg.avgFillPrice));
        if (!Number.isFinite(nextCost) || nextCost <= 0) {
            return;
        }

        if (runtimeKind === 'closeExecution') {
            if (Math.abs((parseFloat(leg.closePrice) || 0) - nextCost) <= 0.0001
                && leg.closePriceSource === 'execution_report') {
                return;
            }

            leg.closePrice = nextCost;
            leg.closePriceSource = 'execution_report';
            leg.closeExecutionOrderId = orderFill.orderId || null;
            leg.closeExecutionPermId = orderFill.permId || null;
        } else {
            if (Math.abs((parseFloat(leg.cost) || 0) - nextCost) <= 0.0001
                && leg.costSource === 'execution_report') {
                return;
            }

            leg.cost = nextCost;
            leg.costSource = 'execution_report';
            leg.executionReportedCost = true;
            leg.executionReportOrderId = orderFill.orderId || null;
            leg.executionReportPermId = orderFill.permId || null;
        }
        stateChanged = true;

        const row = document.querySelector(`tr[data-id="${leg.id}"]`);
        if (row) {
            const targetInput = runtimeKind === 'closeExecution'
                ? row.querySelector('.close-price-input')
                : row.querySelector('.cost-input');
            if (targetInput) {
                targetInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, nextCost);
                flashElement(targetInput);
            }
        }
    });

    if (!stateChanged) {
        return true;
    }

    if (runtime && (!runtime.lastPreview || typeof runtime.lastPreview !== 'object')) {
        runtime.lastPreview = {};
    }
    if (runtime && runtime.lastPreview) {
        if (runtimeKind === 'closeExecution') {
            runtime.lastPreview.closePriceSource = 'execution_report';
        } else {
            runtime.lastPreview.costSource = 'execution_report';
        }
    }

    if (runtimeKind !== 'closeExecution') {
        _maybePromoteFilledTrialGroupToActive(group, runtime);
    }

    renderGroups();
    return true;
}

function _applyComboOrderError(data) {
    const group = _findGroupById(data.groupId);
    if (!group) return true;

    const { runtimeKind } = _resolveExecutionRuntime(group, data);
    _markExecutionError(group, data.message || 'Combo order request failed.', runtimeKind);
    renderGroups();
    return true;
}

function _handleComboOrderMessage(data) {
    if (!data || typeof data !== 'object' || !data.action) {
        return false;
    }

    if (data.action === 'combo_order_validation_result') {
        return _applyComboOrderValidationResult(data);
    }

    if (data.action === 'combo_order_preview_result' || data.action === 'combo_order_submit_result') {
        return _applyComboOrderResult(data);
    }

    if (data.action === 'combo_order_status_update') {
        return _applyComboOrderStatusUpdate(data);
    }

    if (data.action === 'combo_order_resume_result') {
        return _applyComboOrderResumeResult(data);
    }

    if (data.action === 'combo_order_concede_result') {
        return _applyComboOrderConcedeResult(data);
    }

    if (data.action === 'combo_order_cancel_result') {
        return _applyComboOrderCancelResult(data);
    }

    if (data.action === 'combo_order_fill_cost_update') {
        return _applyComboOrderFillCostUpdate(data);
    }

    if (data.action === 'combo_order_error') {
        return _applyComboOrderError(data);
    }

    return false;
}

function _handlePortfolioAvgCostMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'portfolio_avg_cost_update') {
        return false;
    }

    return _applyPortfolioAvgCostUpdate(data);
}

function _applyManagedAccountsUpdate(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }

    const nextAccounts = Array.isArray(data.accounts)
        ? data.accounts
            .map((account) => _normalizeLiveComboOrderAccount(account))
            .filter((account, index, list) => account && list.indexOf(account) === index)
        : [];
    const nextConnected = data.ibConnected === true;
    const previousAccounts = Array.isArray(state.liveComboOrderAccounts)
        ? state.liveComboOrderAccounts.map((account) => _normalizeLiveComboOrderAccount(account))
        : [];
    const previousSelection = _getSelectedLiveComboOrderAccount();
    let nextSelection = previousSelection;

    if (!nextSelection || !nextAccounts.includes(nextSelection)) {
        nextSelection = nextAccounts.length === 1 ? nextAccounts[0] : '';
    }

    const accountsChanged = JSON.stringify(previousAccounts) !== JSON.stringify(nextAccounts);
    const selectionChanged = previousSelection !== nextSelection;
    const connectedChanged = (state.liveComboOrderAccountsConnected === true) !== nextConnected;

    state.liveComboOrderAccounts = nextAccounts;
    state.liveComboOrderAccountsConnected = nextConnected;
    state.selectedLiveComboOrderAccount = nextSelection;

    if (accountsChanged || selectionChanged || connectedChanged) {
        if (typeof OptionComboControlPanelUI !== 'undefined'
            && typeof OptionComboControlPanelUI.refreshBoundDynamicControls === 'function') {
            OptionComboControlPanelUI.refreshBoundDynamicControls();
        }
    }

    return true;
}

function _handleManagedAccountsMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'managed_accounts_update') {
        return false;
    }

    return _applyManagedAccountsUpdate(data);
}

function evaluateTrialTradeTriggers() {
    const evaluator = typeof OptionComboTradeTriggerLogic !== 'undefined'
        ? OptionComboTradeTriggerLogic
        : null;
    if (!evaluator || typeof evaluator.shouldFireTradeTrigger !== 'function') {
        return;
    }

    state.groups.forEach(group => {
        const renderMode = typeof evaluator.getRenderableGroupViewMode === 'function'
            ? evaluator.getRenderableGroupViewMode(group)
            : (group.viewMode || 'active');

        if (evaluator.shouldFireTradeTrigger(group, state.underlyingPrice, renderMode)) {
            _requestTrialGroupComboOrder(group);
        }
    });
}

function evaluateTriggeredOrderExitConditions() {
    const evaluator = typeof OptionComboTradeTriggerLogic !== 'undefined'
        ? OptionComboTradeTriggerLogic
        : null;
    if (!evaluator || typeof evaluator.shouldCancelTriggeredOrder !== 'function') {
        return;
    }

    state.groups.forEach(group => {
        if (evaluator.shouldCancelTriggeredOrder(group, state.underlyingPrice)) {
            requestCancelManagedComboOrder(group, 'exit_condition');
        }
    });
}

function _collectLiveIvNeighbors(targetLeg) {
    const targetStrike = Number(targetLeg && targetLeg.strike);
    if (!Number.isFinite(targetStrike)) {
        return { lower: null, upper: null };
    }

    let lower = null;
    let upper = null;

    state.groups.forEach(group => {
        (group.legs || []).forEach(candidate => {
            if (candidate === targetLeg) return;
            if (String(candidate.type || '').toLowerCase() !== String(targetLeg.type || '').toLowerCase()) return;
            if (String(candidate.expDate || '') !== String(targetLeg.expDate || '')) return;
            if (candidate.ivSource !== 'live' || !Number.isFinite(candidate.iv) || candidate.iv <= 0) return;

            const candidateStrike = Number(candidate.strike);
            if (!Number.isFinite(candidateStrike)) return;

            if (candidateStrike < targetStrike) {
                if (!lower || candidateStrike > lower.strike) {
                    lower = { strike: candidateStrike, iv: candidate.iv };
                }
            } else if (candidateStrike > targetStrike) {
                if (!upper || candidateStrike < upper.strike) {
                    upper = { strike: candidateStrike, iv: candidate.iv };
                }
            }
        });
    });

    return { lower, upper };
}

function _applyEstimatedOptionIvFallback(changedGroupIds) {
    if (_isHistoricalMode()) {
        return false;
    }

    let changed = false;

    state.groups.forEach(group => {
        if (!group.liveData) {
            return;
        }

        (group.legs || []).forEach(leg => {
            if (_isUnderlyingLeg(leg)) {
                return;
            }
            if (String(leg.type || '').toLowerCase() !== 'call' && String(leg.type || '').toLowerCase() !== 'put') {
                return;
            }
            if (leg.ivManualOverride === true) {
                return;
            }
            if (leg.ivSource === 'live') {
                return;
            }

            const neighbors = _collectLiveIvNeighbors(leg);
            if (neighbors.lower && neighbors.upper) {
                const estimatedIv = (neighbors.lower.iv + neighbors.upper.iv) / 2;
                const needsUpdate = leg.ivSource !== 'estimated' || Math.abs((leg.iv || 0) - estimatedIv) > 0.000001;
                if (needsUpdate) {
                    leg.iv = estimatedIv;
                    leg.ivSource = 'estimated';
                    leg.ivManualOverride = false;
                    changed = true;
                    if (changedGroupIds instanceof Set && group && group.id) {
                        changedGroupIds.add(group.id);
                    }
                }
            } else if (leg.ivSource === 'estimated') {
                leg.ivSource = 'missing';
                changed = true;
                if (changedGroupIds instanceof Set && group && group.id) {
                    changedGroupIds.add(group.id);
                }
            }
        });
    });

    return changed;
}

// -------------------------------------------------------------
// Live Market Data Processing
// -------------------------------------------------------------

function _applyHistoricalReplayMetadata(data) {
    if (!data || !data.historicalReplay || typeof data.historicalReplay !== 'object') {
        return false;
    }

    let stateChanged = false;
    const availableStartDate = String(data.historicalReplay.availableStartDate || '').trim();
    const availableEndDate = String(data.historicalReplay.availableEndDate || '').trim();
    const effectiveDate = String(data.historicalReplay.effectiveDate || '').trim();
    const riskFreeRate = parseFloat(data.riskFreeRate);
    if (_isHistoricalMode() && effectiveDate) {
        if (availableStartDate && state.historicalAvailableStartDate !== availableStartDate) {
            state.historicalAvailableStartDate = availableStartDate;
            stateChanged = true;
        }
        if (availableEndDate && state.historicalAvailableEndDate !== availableEndDate) {
            state.historicalAvailableEndDate = availableEndDate;
            stateChanged = true;
        }
        if ((!state.baseDate)
            || (availableStartDate && state.baseDate < availableStartDate)
            || (availableEndDate && state.baseDate > availableEndDate)) {
            state.baseDate = effectiveDate;
            stateChanged = true;
        }
        if (state.historicalQuoteDate !== effectiveDate) {
            state.historicalQuoteDate = effectiveDate;
            stateChanged = true;
        }
        if (!state.simulatedDate || state.simulatedDate < effectiveDate) {
            state.simulatedDate = effectiveDate;
            stateChanged = true;
        }
        if (Number.isFinite(riskFreeRate) && riskFreeRate >= 0) {
            const currentRate = parseFloat(state.interestRate);
            if (!Number.isFinite(currentRate) || Math.abs(currentRate - riskFreeRate) > 0.0000001) {
                state.interestRate = riskFreeRate;
                stateChanged = true;
            }
        }
        if (typeof OptionComboControlPanelUI !== 'undefined'
            && typeof OptionComboControlPanelUI.refreshBoundDynamicControls === 'function') {
            OptionComboControlPanelUI.refreshBoundDynamicControls();
        }
    }

    return stateChanged;
}

function _clearHistoricalExpiryUnderlyingAnchor(leg) {
    let changed = false;

    if (leg.historicalExpiryUnderlyingPrice !== null && leg.historicalExpiryUnderlyingPrice !== undefined) {
        leg.historicalExpiryUnderlyingPrice = null;
        changed = true;
    }

    if (leg.historicalExpiryUnderlyingDate) {
        leg.historicalExpiryUnderlyingDate = '';
        changed = true;
    }

    return changed;
}

function _applyHistoricalExpiryUnderlyingAnchors(data) {
    if (!_isHistoricalMode() || !data || !data.historicalReplay || typeof data.historicalReplay !== 'object') {
        return false;
    }

    const effectiveDate = _normalizeHistoricalDateKey(data.historicalReplay.effectiveDate);
    const expiryUnderlyingQuotes = data.historicalReplay.expiryUnderlyingQuotes
        && typeof data.historicalReplay.expiryUnderlyingQuotes === 'object'
        ? data.historicalReplay.expiryUnderlyingQuotes
        : {};
    const normalizedExpiryUnderlyingQuotes = {};
    Object.entries(expiryUnderlyingQuotes).forEach(([dateKey, snapshot]) => {
        const normalizedDateKey = _normalizeHistoricalDateKey(dateKey)
            || _normalizeHistoricalDateKey(snapshot && (snapshot.requestedDate || snapshot.effectiveDate));
        if (!normalizedDateKey) {
            return;
        }
        normalizedExpiryUnderlyingQuotes[normalizedDateKey] = snapshot;
    });
    let stateChanged = false;

    (state.groups || []).forEach((group) => {
        (group.legs || []).forEach((leg) => {
            if (_isUnderlyingLeg(leg)) {
                return;
            }

            const expiryDate = _normalizeHistoricalDateKey(leg && leg.expDate);
            if (!expiryDate || !effectiveDate || expiryDate > effectiveDate) {
                stateChanged = _clearHistoricalExpiryUnderlyingAnchor(leg) || stateChanged;
                return;
            }

            const expirySnapshot = normalizedExpiryUnderlyingQuotes[expiryDate];
            const nextPrice = expirySnapshot ? parseFloat(expirySnapshot.price) : null;
            const nextEffectiveDate = expirySnapshot ? String(expirySnapshot.effectiveDate || '').trim() : '';
            if (!Number.isFinite(nextPrice)) {
                stateChanged = _clearHistoricalExpiryUnderlyingAnchor(leg) || stateChanged;
                return;
            }

            if (Math.abs((parseFloat(leg.historicalExpiryUnderlyingPrice) || 0) - nextPrice) > 0.000001
                || String(leg.historicalExpiryUnderlyingDate || '') !== nextEffectiveDate) {
                leg.historicalExpiryUnderlyingPrice = nextPrice;
                leg.historicalExpiryUnderlyingDate = nextEffectiveDate;
                stateChanged = true;
            }
        });
    });

    return stateChanged;
}

function _markOptionQuoteMissing(leg) {
    let stateChanged = false;

    if (leg.currentPriceSource !== 'missing') {
        leg.currentPriceSource = 'missing';
        stateChanged = true;
    }

    if (leg.ivManualOverride !== true && leg.ivSource !== 'missing') {
        leg.ivSource = 'missing';
        stateChanged = true;
    }

    return stateChanged;
}

function _applyHistoricalBaseDateCosts() {
    if (!_isHistoricalMode() || _getHistoricalReplayDate() !== _getHistoricalEntryDate()) {
        return false;
    }

    let stateChanged = false;

    (state.groups || []).forEach((group) => {
        if (!group || group.liveData !== true) {
            return;
        }

        const trigger = _getTradeTrigger(group);
        if ((group.viewMode || 'trial') === 'trial' && trigger && trigger.enabled === true) {
            return;
        }

        let capturedEveryOpenLeg = true;
        (group.legs || []).forEach((leg) => {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            if (pos < 0.0001 || (leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined)) {
                return;
            }

            const hasLockedManualCost = Number.isFinite(parseFloat(leg.cost))
                && parseFloat(leg.cost) > 0
                && leg.costSource
                && leg.costSource !== 'historical_base';
            if (hasLockedManualCost) {
                return;
            }

            const baseCost = _resolveHistoricalReplayClosePrice(leg, false);
            if (!Number.isFinite(baseCost) || baseCost <= 0) {
                capturedEveryOpenLeg = false;
                return;
            }

            if (Math.abs((parseFloat(leg.cost) || 0) - baseCost) > 0.000001 || leg.costSource !== 'historical_base') {
                leg.cost = baseCost;
                leg.costSource = 'historical_base';
                stateChanged = true;
            }
        });

        if (capturedEveryOpenLeg
            && _groupHasCostForAllPositionedLegs(group)
            && (group.viewMode || 'trial') === 'trial') {
            group.viewMode = 'active';
            stateChanged = true;
        }
    });

    return stateChanged;
}

function _applyHistoricalAutoExpirySettlement(targetGroup = null) {
    if (!_isHistoricalMode()) {
        return false;
    }

    const replayDate = _normalizeHistoricalDateKey(_getHistoricalReplayDate());
    if (!replayDate) {
        return false;
    }

    let stateChanged = false;

    const groupsToSync = targetGroup ? [targetGroup] : (state.groups || []);
    groupsToSync.forEach((group) => {
        if (!group || !_groupHasCostForAllPositionedLegs(group)) {
            return;
        }

        const autoCloseAtExpiry = _shouldHistoricalAutoCloseAtExpiry(group);
        let autoSettledAnyLeg = false;
        (group.legs || []).forEach((leg) => {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined;
            const isAutoSettledClose = leg && leg.closePriceSource === 'historical_expiry_auto';
            const expiryDate = _normalizeHistoricalDateKey(leg && leg.expDate);

            if (_isUnderlyingLeg(leg) || pos < 0.0001 || !expiryDate) {
                return;
            }

            if (isAutoSettledClose && (!autoCloseAtExpiry || expiryDate > replayDate)) {
                leg.closePrice = null;
                leg.closePriceSource = '';
                leg.autoSettledAtReplayDate = null;
                stateChanged = true;
                return;
            }

            if (!autoCloseAtExpiry || hasClosePrice || expiryDate > replayDate) {
                return;
            }

            const closePrice = _resolveHistoricalReplayClosePrice(leg, true);
            if (!Number.isFinite(closePrice) || closePrice < 0) {
                return;
            }

            if (Math.abs((parseFloat(leg.closePrice) || 0) - closePrice) > 0.000001
                || leg.closePriceSource !== 'historical_expiry_auto') {
                leg.closePrice = closePrice;
                leg.closePriceSource = 'historical_expiry_auto';
                leg.autoSettledAtReplayDate = replayDate;
                autoSettledAnyLeg = true;
                stateChanged = true;
            }
        });

        if (autoSettledAnyLeg && !_groupHasOpenPositions(group) && group.viewMode !== 'settlement') {
            group.viewMode = 'settlement';
            stateChanged = true;
        }
    });

    return stateChanged;
}

function _handleHistoricalReplayMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'historical_replay_error') {
        return false;
    }

    console.error(data.message || 'Historical replay request failed.');
    return true;
}

let renderScheduled = false;

function processLiveMarketData(data) {
    let stateChanged = _applyHistoricalReplayMetadata(data);
    stateChanged = _applyHistoricalExpiryUnderlyingAnchors(data) || stateChanged;
    const quoteSourceKind = _getQuoteSourceKind(data);
    const nextUnderlyingPrice = parseFloat(data && data.underlyingPrice);
    const hasUnderlyingPrice = Number.isFinite(nextUnderlyingPrice);
    const incrementalGroupIds = new Set();
    const incrementalHedgeIds = new Set();
    const changedOptionQuoteIds = [];
    const liveMode = !_isHistoricalMode();
    let optionQuotesChanged = false;
    let futureQuotesChanged = false;
    let underlyingQuoteChanged = false;

    if (data.underlyingQuote && typeof data.underlyingQuote === 'object') {
        underlyingQuoteChanged = _setUnderlyingQuoteSnapshot(data.underlyingQuote);
    } else if (hasUnderlyingPrice) {
        underlyingQuoteChanged = _setUnderlyingQuoteSnapshot({ mark: nextUnderlyingPrice });
    }

    if (data.options) {
        Object.entries(data.options).forEach(([subId, quote]) => {
            const quoteChanged = _setOptionQuoteSnapshot(subId, quote);
            optionQuotesChanged = quoteChanged || optionQuotesChanged;
            if (quoteChanged) {
                changedOptionQuoteIds.push(subId);
            }
        });

        if (optionQuotesChanged && (state.forwardRateSamples || []).length > 0) {
            _refreshForwardRatePanelUi();
        }
    }

    if (data.futures) {
        Object.entries(data.futures).forEach(([subId, quote]) => {
            futureQuotesChanged = _setFutureQuoteSnapshot(subId, quote) || futureQuotesChanged;
        });
    }

    if (data.stocks) {
        Object.entries(data.stocks).forEach(([symbol, quote]) => {
            _setStockQuoteSnapshot(symbol, quote);
        });
    }

    if (liveMode && underlyingQuoteChanged) {
        _addGroupsAffectedByUnderlyingMidpoint(incrementalGroupIds);
    }
    if (liveMode && optionQuotesChanged) {
        _addGroupsAffectedByOptionQuoteIds(incrementalGroupIds, changedOptionQuoteIds);
    }
    if (liveMode && futureQuotesChanged) {
        _addAllGroupIds(incrementalGroupIds);
    }

    if (data.futures) {
        (state.futuresPool || []).forEach((entry) => {
            const quote = data.futures[entry.id];
            if (!quote) return;

            const nextBid = quote.bid !== undefined ? quote.bid : entry.bid;
            const nextAsk = quote.ask !== undefined ? quote.ask : entry.ask;
            const nextMark = quote.mark !== undefined ? quote.mark : entry.mark;
            const quoteChanged = nextBid !== entry.bid
                || nextAsk !== entry.ask
                || nextMark !== entry.mark;
            if (!quoteChanged) {
                return;
            }

            entry.bid = nextBid;
            entry.ask = nextAsk;
            entry.mark = nextMark;
            entry.lastQuotedAt = new Date().toISOString();
        });

        state.groups.forEach(group => {
            if (!group.liveData) {
                return;
            }

            group.legs.forEach(leg => {
                if (!_isUnderlyingLeg(leg) || !leg.underlyingFutureId || data.futures[leg.underlyingFutureId] === undefined) {
                    return;
                }

                const liveMark = data.futures[leg.underlyingFutureId].mark;
                if (!(liveMark > 0)) {
                    return;
                }

                const markChanged = Math.abs(liveMark - leg.currentPrice) > 0.001;
                const sourceChanged = leg.currentPriceSource !== quoteSourceKind;
                if (!markChanged && !sourceChanged) {
                    return;
                }

                leg.currentPrice = liveMark;
                leg.currentPriceSource = quoteSourceKind;
                stateChanged = true;
                if (liveMode && group && group.id) {
                    incrementalGroupIds.add(group.id);
                }

                const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                if (row) {
                    const currentPriceInput = row.querySelector('.current-price-input');
                    if (currentPriceInput) {
                        currentPriceInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, liveMark);
                        flashElement(currentPriceInput);
                    }
                }
            });
        });

        if (futureQuotesChanged && (state.futuresPool || []).length > 0) {
            _refreshFuturesPoolPanelUi();
        }
    }

    const currentUnderlyingPrice = parseFloat(state && state.underlyingPrice);
    const underlyingPriceChanged = hasUnderlyingPrice
        && (!Number.isFinite(currentUnderlyingPrice)
            || Math.abs(nextUnderlyingPrice - currentUnderlyingPrice) > 0.000001);
    if (hasUnderlyingPrice && underlyingPriceChanged) {
        state.underlyingPrice = nextUnderlyingPrice;
        const underlyingPriceInput = document.getElementById('underlyingPrice');
        const underlyingPriceSlider = document.getElementById('underlyingPriceSlider');
        const underlyingPriceDisplay = document.getElementById('underlyingPriceDisplay');
        const nextInputValue = _formatSymbolPriceInputValue(state.underlyingSymbol, state.underlyingPrice);
        const nextDisplayValue = _formatSymbolPriceDisplay(state.underlyingSymbol, state.underlyingPrice);
        if (underlyingPriceInput && underlyingPriceInput.value !== nextInputValue) {
            underlyingPriceInput.value = nextInputValue;
        }
        if (underlyingPriceSlider && String(underlyingPriceSlider.value) !== String(state.underlyingPrice)) {
            underlyingPriceSlider.value = state.underlyingPrice;
        }
        if (underlyingPriceDisplay && underlyingPriceDisplay.textContent !== nextDisplayValue) {
            underlyingPriceDisplay.textContent = nextDisplayValue;
        }
        if (!_isHistoricalMode()) {
            evaluateTrialTradeTriggers();
            evaluateTriggeredOrderExitConditions();
        }
        stateChanged = true;
        if (liveMode) {
            _addAllGroupIds(incrementalGroupIds);
        }
    }

    if (data.options) {
        state.groups.forEach(group => {
            if (!group.liveData) {
                return;
            }

            group.legs.forEach(leg => {
                if (data.options[leg.id] === undefined) {
                    return;
                }

                const replayQuote = data.options[leg.id] || {};
                const liveMark = replayQuote.mark;
                const liveIV = replayQuote.iv;

                if (replayQuote.missing === true) {
                    const legChanged = _markOptionQuoteMissing(leg);
                    stateChanged = legChanged || stateChanged;
                    if (legChanged && liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }
                    return;
                }

                if (liveMark > 0) {
                    const markChanged = Math.abs(liveMark - leg.currentPrice) > 0.001;
                    const sourceChanged = leg.currentPriceSource !== quoteSourceKind;
                    if (markChanged || sourceChanged) {
                        leg.currentPrice = liveMark;
                        leg.currentPriceSource = quoteSourceKind;
                        stateChanged = true;
                        if (liveMode && group && group.id) {
                            incrementalGroupIds.add(group.id);
                        }

                        const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                        if (row) {
                            const currentPriceInput = row.querySelector('.current-price-input');
                            if (currentPriceInput) {
                                currentPriceInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, liveMark);
                                flashElement(currentPriceInput);
                            }
                        }
                    }
                }

                const ivManuallyOverridden = leg.ivManualOverride === true;

                if (liveIV && liveIV > 0 && !ivManuallyOverridden) {
                    const nextIvSource = quoteSourceKind === 'historical' ? 'historical' : 'live';
                    const ivChanged = Math.abs(liveIV - leg.iv) > 0.000001 || leg.ivSource !== nextIvSource || leg.ivManualOverride === true;
                    leg.iv = liveIV;
                    leg.ivSource = nextIvSource;
                    leg.ivManualOverride = false;
                    stateChanged = stateChanged || ivChanged;
                    if (ivChanged && liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }

                    const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                    if (row && ivChanged) {
                        const ivInput = row.querySelector('.iv-input');
                        if (ivInput && document.activeElement !== ivInput) {
                            const ivDisplay = typeof OptionComboPricingCore !== 'undefined'
                                && typeof OptionComboPricingCore.describeLegIvInput === 'function'
                                ? OptionComboPricingCore.describeLegIvInput(leg)
                                : {
                                    value: `${(liveIV * 100).toFixed(4)}%`,
                                    title: 'Live IV from TWS',
                                };
                            ivInput.value = ivDisplay.value;
                            ivInput.title = ivDisplay.title;
                            flashElement(ivInput);
                        }
                    }
                } else if (!(liveIV && liveIV > 0) && !ivManuallyOverridden && leg.ivSource !== 'missing') {
                    leg.ivSource = 'missing';
                    stateChanged = true;
                    if (liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }

                    const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                    if (row) {
                        const ivInput = row.querySelector('.iv-input');
                        if (ivInput && document.activeElement !== ivInput) {
                            const ivDisplay = typeof OptionComboPricingCore !== 'undefined'
                                && typeof OptionComboPricingCore.describeLegIvInput === 'function'
                                ? OptionComboPricingCore.describeLegIvInput(leg)
                                : {
                                    value: 'N/A',
                                    title: 'Live IV is unavailable from TWS for this contract.',
                                };
                            ivInput.value = ivDisplay.value;
                            ivInput.title = ivDisplay.title;
                        }
                    }
                }
            });
        });

        if (_applyEstimatedOptionIvFallback(incrementalGroupIds)) {
            stateChanged = true;
        }
    }

    if (data.stocks) {
        state.hedges.forEach(hedge => {
            if (hedge.liveData && data.stocks[hedge.symbol] !== undefined) {
                const liveMark = data.stocks[hedge.symbol].mark;
                const markChanged = liveMark > 0 && Math.abs(liveMark - hedge.currentPrice) > 0.001;
                const sourceChanged = liveMark > 0 && hedge.currentPriceSource !== quoteSourceKind;
                if (liveMark > 0 && (markChanged || sourceChanged)) {
                    hedge.currentPrice = liveMark;
                    hedge.currentPriceSource = quoteSourceKind;
                    stateChanged = true;
                    if (liveMode && hedge && hedge.id) {
                        incrementalHedgeIds.add(hedge.id);
                    }

                    const row = document.querySelector(`tr.hedge-row[data-id="${hedge.id}"]`);
                    if (row) {
                        const currentPriceInput = row.querySelector('.current-price-input');
                        if (currentPriceInput) {
                            currentPriceInput.value = _formatSymbolPriceInputValue(hedge.symbol, liveMark);
                            flashElement(currentPriceInput);
                        }
                    }
                }
            }
        });
    }

    if (hasUnderlyingPrice) {
        const usesFuturesPool = typeof OptionComboProductRegistry !== 'undefined'
            && typeof OptionComboProductRegistry.usesFuturesPool === 'function'
            && OptionComboProductRegistry.usesFuturesPool(state.underlyingSymbol);
        state.groups.forEach(group => {
            if (!group.liveData) {
                return;
            }

            group.legs.forEach(leg => {
                if (usesFuturesPool && leg.underlyingFutureId) {
                    return;
                }
                if (_isUnderlyingLeg(leg) && (
                    Math.abs(nextUnderlyingPrice - leg.currentPrice) > 0.001
                    || leg.currentPriceSource !== quoteSourceKind
                )) {
                    leg.currentPrice = nextUnderlyingPrice;
                    leg.currentPriceSource = quoteSourceKind;
                    stateChanged = true;
                    if (liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }

                    const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                    if (row) {
                        const currentPriceInput = row.querySelector('.current-price-input');
                        if (currentPriceInput) {
                            currentPriceInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, nextUnderlyingPrice);
                            flashElement(currentPriceInput);
                        }
                    }
                }
            });
        });

        if (_applyEstimatedOptionIvFallback(incrementalGroupIds)) {
            stateChanged = true;
        }
    }

    if (_applyHistoricalBaseDateCosts()) {
        stateChanged = true;
    }

    if (_applyHistoricalAutoExpirySettlement()) {
        stateChanged = true;
    }

    if (_isHistoricalMode() && hasUnderlyingPrice && underlyingPriceChanged) {
        evaluateTrialTradeTriggers();
        evaluateTriggeredOrderExitConditions();
    }

    const hasIncrementalTargets = incrementalGroupIds.size > 0 || incrementalHedgeIds.size > 0;
    if (stateChanged || hasIncrementalTargets) {
        _scheduleDerivedValueRefresh({
            groupIds: Array.from(incrementalGroupIds),
            hedgeIds: Array.from(incrementalHedgeIds),
        }, liveMode && hasIncrementalTargets);
    }
}

// Connect immediately on load
initWsPortControls();
connectWebSocket();
