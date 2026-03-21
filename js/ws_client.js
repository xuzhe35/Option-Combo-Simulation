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
const WS_PORT_STORAGE_KEY = 'optionComboWsPort';

// Exponential backoff state
const WS_BASE_DELAY = 5000;   // 5s initial
const WS_MAX_DELAY = 60000;   // 60s cap
let _wsReconnectDelay = WS_BASE_DELAY;
let _wsReconnectTimer = null;
let _legacyLiveDataWarningShown = false;
let _wsLocalOriginWarningShown = false;

function _isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').trim().toLowerCase();
    return normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '[::1]'
        || normalized === '::1';
}

function _isLocalPageContext() {
    if (typeof window === 'undefined' || !window.location) {
        return false;
    }

    const protocol = String(window.location.protocol || '').toLowerCase();
    if (protocol === 'file:') {
        return true;
    }

    return _isLoopbackHostname(window.location.hostname);
}

function _reportLocalOnlyWsRestriction() {
    updateWsStatusUI('local_only');

    if (_wsLocalOriginWarningShown) {
        return;
    }
    _wsLocalOriginWarningShown = true;

    console.warn(
        'WebSocket connection is disabled because this page is not running from a local origin. '
        + 'For safety, live IB connectivity is only enabled from file://, localhost, or 127.0.0.1.'
    );
}

function _isUnderlyingLeg(legOrType) {
    if (typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.isUnderlyingLeg === 'function') {
        return OptionComboProductRegistry.isUnderlyingLeg(legOrType);
    }

    const legType = typeof legOrType === 'string'
        ? legOrType
        : (legOrType && legOrType.type);
    return String(legType || '').trim().toLowerCase() === 'stock';
}

function _normalizeWsPort(rawValue) {
    const parsed = parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return DEFAULT_WS_PORT;
    }
    return parsed;
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

function _syncWsPortInput(port) {
    const input = document.getElementById('wsPortInput');
    if (input) input.value = String(_normalizeWsPort(port));
}

function _getCurrentWsPort() {
    const input = document.getElementById('wsPortInput');
    if (input && input.value) return _normalizeWsPort(input.value);
    return _getSavedWsPort();
}

function _getWsUrl() {
    return `ws://${DEFAULT_WS_HOST}:${_getCurrentWsPort()}`;
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

    const port = _getCurrentWsPort();
    if (status === 'local_only') {
        el.textContent = 'Local-only mode';
        el.className = 'ws-status ws-error';
        return;
    }
    if (status === 'connected') {
        el.textContent = `Connected :${port}`;
        el.className = 'ws-status ws-connected';
    } else if (status === 'error') {
        el.textContent = `Error :${port}`;
        el.className = 'ws-status ws-error';
    } else {
        const suffix = nextRetrySec != null ? ` - Retry in ${nextRetrySec}s` : '';
        el.textContent = `Disconnected :${port}${suffix}`;
        el.className = 'ws-status ws-disconnected';
    }
}

function connectWebSocket() {
    _clearWsReconnectTimer();

    if (!_isLocalPageContext()) {
        isWsConnected = false;
        _reportLocalOnlyWsRestriction();
        return;
    }

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
        const delaySec = Math.round(_wsReconnectDelay / 1000);
        console.log(`WebSocket Disconnected. Reconnecting in ${delaySec}s...`);
        updateWsStatusUI('disconnected', delaySec);
        _wsReconnectTimer = setTimeout(connectWebSocket, _wsReconnectDelay);
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, WS_MAX_DELAY);
    };

    ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        updateWsStatusUI('error');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (_handlePortfolioAvgCostMessage(data)) {
                return;
            }
            if (_handleComboOrderMessage(data)) {
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

    if (!_isLocalPageContext()) {
        _reportLocalOnlyWsRestriction();
        return;
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
    if (!group || !isWsConnected || !ws) {
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
        timeInForce: closeExecution.timeInForce,
    });
}

function requestCloseGroupComboOrder(group) {
    if (!group) return false;
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

function toggleWsPortControls() {
    const controls = document.getElementById('wsPortControls');
    if (!controls) return;
    controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
}

function applyWsPort() {
    const input = document.getElementById('wsPortInput');
    if (!input) return;

    const safePort = _normalizeWsPort(input.value);
    input.value = String(safePort);
    _setSavedWsPort(safePort);
    reconnectWebSocket();
}

function resetWsPort() {
    _setSavedWsPort(DEFAULT_WS_PORT);
    _syncWsPortInput(DEFAULT_WS_PORT);
    reconnectWebSocket();
}

function initWsPortControls() {
    const savedPort = _getSavedWsPort();
    _syncWsPortInput(savedPort);
    updateWsStatusUI('disconnected');
}

window.toggleWsPortControls = toggleWsPortControls;
window.applyWsPort = applyWsPort;
window.resetWsPort = resetWsPort;
window.requestPortfolioAvgCostSnapshot = requestPortfolioAvgCostSnapshot;
window.requestContinueManagedComboOrder = requestContinueManagedComboOrder;
window.requestConcedeManagedComboOrder = requestConcedeManagedComboOrder;
window.requestCancelManagedComboOrder = requestCancelManagedComboOrder;
window.requestCloseGroupComboOrder = requestCloseGroupComboOrder;

// -------------------------------------------------------------
// Subscription Management
// -------------------------------------------------------------

function _toContractMonth(dateStr) {
    if (!dateStr) return '';
    return String(dateStr).replace(/-/g, '').slice(0, 6);
}

function _buildUnderlyingRequest(profile, optionRequests) {
    const defaultUnderlyingContractMonth = profile?.underlyingSecType === 'FUT'
        && typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth === 'function'
        ? OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            state.simulatedDate || state.baseDate
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
        request.contractMonth = state.underlyingContractMonth
            || defaultUnderlyingContractMonth
            || optionRequests[0]?.underlyingContractMonth
            || optionRequests[0]?.contractMonth
            || _toContractMonth(state.simulatedDate)
            || _toContractMonth(state.baseDate);
        request.multiplier = String(profile.optionMultiplier || '');
    }

    return request;
}

function handleLiveSubscriptions() {
    if (!isWsConnected || !ws) return;
    const profile = typeof OptionComboProductRegistry === 'undefined'
        ? null
        : OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol);
    if (typeof OptionComboProductRegistry !== 'undefined'
        && !OptionComboProductRegistry.supportsLegacyLiveData(state.underlyingSymbol)) {
        if (!_legacyLiveDataWarningShown) {
            console.warn(`Legacy live-data subscriptions are not implemented for ${state.underlyingSymbol}. Use manual prices for now.`);
            _legacyLiveDataWarningShown = true;
        }
        return;
    }

    const optionRequests = [];
    const payload = {
        action: 'subscribe',
        underlying: null,
        options: optionRequests,
        stocks: []
    };

    // Collect all legs from groups that have Live Data == true
    state.groups.forEach(group => {
        if (group.liveData) {
            group.legs.forEach(leg => {
                if (!_isUnderlyingLeg(leg)) {
                    optionRequests.push({
                        id: leg.id,
                        secType: profile?.optionSecType || 'OPT',
                        symbol: profile?.optionSymbol || state.underlyingSymbol,
                        underlyingSymbol: profile?.underlyingSymbol || state.underlyingSymbol,
                        exchange: profile?.optionExchange || 'SMART',
                        underlyingExchange: profile?.underlyingExchange || profile?.optionExchange || 'SMART',
                        currency: profile?.currency || 'USD',
                        multiplier: String(profile?.optionMultiplier || 100),
                        underlyingMultiplier: String(profile?.optionMultiplier || 100),
                        tradingClass: typeof OptionComboProductRegistry !== 'undefined'
                            && typeof OptionComboProductRegistry.resolveTradingClass === 'function'
                            ? OptionComboProductRegistry.resolveTradingClass(state.underlyingSymbol, leg.expDate)
                            : (profile?.tradingClass || undefined),
                        right: leg.type.charAt(0).toUpperCase(), // 'C' or 'P'
                        strike: leg.strike,
                        expDate: leg.expDate.replace(/-/g, ''),
                        contractMonth: _toContractMonth(leg.expDate),
                        underlyingContractMonth: state.underlyingContractMonth
                            || (typeof OptionComboProductRegistry !== 'undefined'
                                && typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth === 'function'
                                ? OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
                                    state.underlyingSymbol,
                                    state.simulatedDate || state.baseDate
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
    }, optionRequests);

    // Collect all hedge stocks that have Live Data == true
    state.hedges.forEach(hedge => {
        if (hedge.liveData && hedge.symbol) {
            payload.stocks.push(hedge.symbol);
        }
    });

    ws.send(JSON.stringify(payload));
}

function requestUnderlyingPriceSync() {
    if (!isWsConnected || !ws) {
        alert("Live Market Data WebSocket is not connected.");
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
            []
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
        symbol: String(profile.optionSymbol || state.underlyingSymbol || '').trim().toUpperCase(),
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

function _applyPortfolioAvgCostUpdate(data) {
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (items.length === 0) {
        return true;
    }

    let stateChanged = false;

    state.groups.forEach(group => {
        if (!_isPortfolioAvgCostSyncEnabled(group)) {
            return;
        }

        (group.legs || []).forEach(leg => {
            if (leg && leg.costSource === 'execution_report') {
                return;
            }

            const match = items.find(item => {
                const avgCostPerUnit = parseFloat(item.avgCostPerUnit);
                const position = parseFloat(item.position);
                if (!Number.isFinite(avgCostPerUnit) || avgCostPerUnit <= 0) {
                    return false;
                }
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
                    costInput.value = nextCost.toFixed(2);
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

function _getTradeTrigger(group) {
    if (!group) return null;
    if (typeof OptionComboTradeTriggerLogic !== 'undefined'
        && typeof OptionComboTradeTriggerLogic.ensureGroupTradeTrigger === 'function') {
        return OptionComboTradeTriggerLogic.ensureGroupTradeTrigger(group);
    }
    return group.tradeTrigger || null;
}

function _getCloseExecution(group) {
    if (!group) return null;
    if (typeof OptionComboSessionLogic !== 'undefined'
        && typeof OptionComboSessionLogic.normalizeCloseExecution === 'function') {
        group.closeExecution = OptionComboSessionLogic.normalizeCloseExecution(group.closeExecution);
        return group.closeExecution;
    }

    if (!group.closeExecution || typeof group.closeExecution !== 'object') {
        group.closeExecution = {
            repriceThreshold: 0.01,
            timeInForce: 'DAY',
            status: 'idle',
            pendingRequest: false,
            lastPreview: null,
            lastError: '',
        };
    }

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
    if (!group || !isWsConnected || !ws) {
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
    if (!isWsConnected || !ws) {
        _markTradeTriggerError(group, 'WebSocket is not connected.');
        renderGroups();
        return;
    }

    const trigger = _getTradeTrigger(group);
    if (!trigger) return;

    const executionMode = trigger.executionMode === 'submit' || trigger.executionMode === 'test_submit'
        ? trigger.executionMode
        : 'preview';
    if ((executionMode === 'submit' || executionMode === 'test_submit') && state.allowLiveComboOrders !== true) {
        _markTradeTriggerError(group, 'Global live combo order switch is OFF.');
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
    if (state.allowLiveComboOrders !== true) {
        _markExecutionError(group, 'Global live combo order switch is OFF.', runtimeKind);
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
                targetInput.value = nextCost.toFixed(2);
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

function _applyEstimatedOptionIvFallback() {
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
                }
            } else if (leg.ivSource === 'estimated') {
                leg.ivSource = 'missing';
                changed = true;
            }
        });
    });

    return changed;
}

// -------------------------------------------------------------
// Live Market Data Processing
// -------------------------------------------------------------

let renderScheduled = false;

function processLiveMarketData(data) {
    let stateChanged = false;

    // Update Underlying Price if present
    if (data.underlyingPrice) {
        state.underlyingPrice = data.underlyingPrice;
        document.getElementById('underlyingPrice').value = state.underlyingPrice.toFixed(2);
        document.getElementById('underlyingPriceSlider').value = state.underlyingPrice;
        document.getElementById('underlyingPriceDisplay').textContent = currencyFormatter.format(state.underlyingPrice);
        evaluateTrialTradeTriggers();
        evaluateTriggeredOrderExitConditions();
        stateChanged = true;
    }

    // Update Option Legs
    if (data.options) {
        state.groups.forEach(group => {
            if (group.liveData) {
                group.legs.forEach(leg => {
                    if (data.options[leg.id] !== undefined) {
                        const liveMark = data.options[leg.id].mark;
                        const liveIV = data.options[leg.id].iv;

                        if (liveMark > 0 && Math.abs(liveMark - leg.currentPrice) > 0.001) {
                            leg.currentPrice = liveMark;
                            stateChanged = true;

                            const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                            if (row) {
                                const currentPriceInput = row.querySelector('.current-price-input');
                                if (currentPriceInput) {
                                    currentPriceInput.value = liveMark.toFixed(2);
                                    flashElement(currentPriceInput);
                                }
                            }
                        }

                        const ivManuallyOverridden = leg.ivManualOverride === true;

                        if (liveIV && liveIV > 0 && !ivManuallyOverridden) {
                            const ivChanged = Math.abs(liveIV - leg.iv) > 0.000001 || leg.ivSource !== 'live' || leg.ivManualOverride === true;
                            leg.iv = liveIV;
                            leg.ivSource = 'live';
                            leg.ivManualOverride = false;
                            stateChanged = stateChanged || ivChanged;

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
                    }
                });
            }
        });

        if (_applyEstimatedOptionIvFallback()) {
            stateChanged = true;
        }
    }

    // Update Hedge Stocks + underlying legs in groups
    if (data.stocks) {
        state.hedges.forEach(hedge => {
            if (hedge.liveData && data.stocks[hedge.symbol] !== undefined) {
                const liveMark = data.stocks[hedge.symbol].mark;
                if (liveMark > 0 && Math.abs(liveMark - hedge.currentPrice) > 0.001) {
                    hedge.currentPrice = liveMark;
                    stateChanged = true;

                    const row = document.querySelector(`tr.hedge-row[data-id="${hedge.id}"]`);
                    if (row) {
                        const currentPriceInput = row.querySelector('.current-price-input');
                        if (currentPriceInput) {
                            currentPriceInput.value = liveMark.toFixed(2);
                            flashElement(currentPriceInput);
                        }
                    }
                }
            }
        });

    }

    if (data.underlyingPrice) {
        state.groups.forEach(group => {
            if (group.liveData) {
                group.legs.forEach(leg => {
                    if (_isUnderlyingLeg(leg) && Math.abs(data.underlyingPrice - leg.currentPrice) > 0.001) {
                        leg.currentPrice = data.underlyingPrice;
                        stateChanged = true;

                        const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                        if (row) {
                            const currentPriceInput = row.querySelector('.current-price-input');
                            if (currentPriceInput) {
                                currentPriceInput.value = data.underlyingPrice.toFixed(2);
                                flashElement(currentPriceInput);
                            }
                        }
                    }
                });
            }
        });

        if (_applyEstimatedOptionIvFallback()) {
            stateChanged = true;
        }
    }

    if (stateChanged && !renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(() => {
            updateDerivedValues();
            renderScheduled = false;
        });
    }
}

// Connect immediately on load
initWsPortControls();
connectWebSocket();
