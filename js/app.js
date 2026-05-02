/**
 * Main Application Logic for Option Combo Simulator
 */

// Formatters
const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
});

const percentFormatter = new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
});

// App State
const today = new Date();
const initialDateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

function resolveBootstrapRuntimeConfig() {
    const bootstrap = (typeof window !== 'undefined' && window.OptionComboBootstrap && typeof window.OptionComboBootstrap === 'object')
        ? window.OptionComboBootstrap
        : {};
    const search = typeof window !== 'undefined' && window.location && typeof window.location.search === 'string'
        ? window.location.search
        : '';
    const params = typeof URLSearchParams !== 'undefined' && search
        ? new URLSearchParams(search)
        : null;

    let workspaceVariant = String(
        bootstrap.workspaceVariant
        || bootstrap.entry
        || (params ? (params.get('workspaceVariant') || params.get('entry') || '') : '')
        || ''
    ).trim().toLowerCase();
    if (workspaceVariant !== 'historical' && workspaceVariant !== 'live') {
        workspaceVariant = '';
    }

    let requestedMode = bootstrap.marketDataMode;
    if (!requestedMode && params) {
        requestedMode = params.get('marketDataMode') || params.get('mode') || '';
    }
    if (workspaceVariant && !requestedMode) {
        requestedMode = workspaceVariant;
    }

    const marketDataMode = String(requestedMode || '').trim().toLowerCase() === 'historical'
        ? 'historical'
        : 'live';

    let marketDataModeLocked = bootstrap.marketDataModeLocked === true || bootstrap.lockMarketDataMode === true;
    if (!marketDataModeLocked && params) {
        const lockValue = String(params.get('marketDataModeLocked') || params.get('lockMarketDataMode') || '').trim().toLowerCase();
        marketDataModeLocked = lockValue === '1' || lockValue === 'true' || lockValue === 'yes';
    }
    if (workspaceVariant && bootstrap.marketDataModeLocked === undefined && bootstrap.lockMarketDataMode === undefined && !params?.has('marketDataModeLocked') && !params?.has('lockMarketDataMode')) {
        marketDataModeLocked = true;
    }

    return {
        marketDataMode: workspaceVariant === 'historical'
            ? 'historical'
            : (workspaceVariant === 'live' ? 'live' : marketDataMode),
        workspaceVariant,
        marketDataModeLocked,
    };
}

const bootstrapRuntimeConfig = resolveBootstrapRuntimeConfig();
if (typeof window !== 'undefined') {
    window.OptionComboRuntimeConfig = bootstrapRuntimeConfig;
}

const state = {
    importedSessionTitle: '',
    underlyingSymbol: 'SPY',
    underlyingContractMonth: '',
    underlyingPrice: 100.00,
    baseDate: initialDateStr, // Today local YYYY-MM-DD
    simulatedDate: initialDateStr, // Initially same as baseDate
    marketDataMode: bootstrapRuntimeConfig.marketDataMode,
    workspaceVariant: bootstrapRuntimeConfig.workspaceVariant,
    marketDataModeLocked: bootstrapRuntimeConfig.marketDataModeLocked === true,
    historicalQuoteDate: '',
    historicalAvailableStartDate: '',
    historicalAvailableEndDate: '',
    interestRate: 0.03, // 3% default risk-free rate
    ivOffset: 0.0, // 0%
    greeksEnabled: false,
    deltaHedge: OptionComboSessionLogic.createDefaultDeltaHedgeConfig(),
    primaryControlPanelCollapsed: false,
    allowLiveComboOrders: false,
    allowLiveHedgeOrders: false,
    liveComboOrderAccounts: [],
    liveComboOrderAccountsConnected: false,
    selectedLiveComboOrderAccount: '',
    forwardRateSamples: [],
    futuresPool: [],
    viewMode: 'active', // 'active' (Historical Entry Cost) or 'trial' (Current Live Price)
    groups: [],
    hedges: [] // {id, symbol, currentPrice, pos, cost, liveData}
};

window.__optionComboApp = {
    getState: () => state,
    renderGroups: () => renderGroups(),
    renderHedges: () => renderHedges(),
    updateLiveQuoteDerivedValues: (changeSet) => updateLiveQuoteDerivedValues(changeSet),
    updateLiveQuoteGroupDeltaValues: (changeSet) => updateLiveQuoteGroupDeltaValues(changeSet),
    runDeltaHedgeAutoSupervisor: () => runDeltaHedgeAutoSupervisor(),
};

// Throttle flag for slider-driven updates (one rAF per frame max)
let _sliderRafPending = false;
let _latestPortfolioDerivedData = null;
function throttledUpdate() {
    if (!_sliderRafPending) {
        _sliderRafPending = true;
        requestAnimationFrame(() => {
            updateDerivedValues();
            _sliderRafPending = false;
        });
    }
}

// Date helper functions such as diffDays, addDays, calendarToTradingDays
// have been unified globally in bsm.js

document.addEventListener('DOMContentLoaded', () => {
    bindControlPanelEvents();
    renderGroups();
    renderHedges();
    updateDerivedValues();
    setInterval(() => {
        runDeltaHedgeAutoSupervisor();
    }, 5000);
});

// Calculate unique ID
function generateId() {
    return '_' + Math.random().toString(36).substr(2, 9);
}

// Visual flash effect for DOM input elements (e.g. live data updates)
function flashElement(el) {
    el.style.backgroundColor = 'rgba(74, 222, 128, 0.4)';
    setTimeout(() => {
        el.style.transition = 'background-color 0.8s ease';
        el.style.backgroundColor = 'transparent';
        setTimeout(() => el.style.transition = '', 800);
    }, 50);
}

function isSettlementScenarioMode(viewMode) {
    return OptionComboValuation.isSettlementScenarioMode(viewMode);
}

function groupHasDeterministicCost(group) {
    return OptionComboSessionLogic.groupHasDeterministicCost(group);
}

function groupHasOpenPosition(group) {
    return OptionComboSessionLogic.groupHasOpenPosition(group);
}

function getUnderlyingProfile() {
    if (typeof OptionComboProductRegistry === 'undefined') {
        return null;
    }
    return OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol);
}

// -------------------------------------------------------------
// DOM Event Binding
// -------------------------------------------------------------
function bindControlPanelEvents() {
    OptionComboControlPanelUI.bindControlPanelEvents(state, currencyFormatter, {
        updateDerivedValues,
        throttledUpdate,
        handleLiveSubscriptions,
        requestManagedAccountsSnapshot,
        settleHistoricalReplayGroups,
        renderGroups,
        generateId,
        addDays,
        diffDays,
        calendarToTradingDays,
    });
    if (typeof OptionComboDeltaHedgeUI !== 'undefined'
        && typeof OptionComboDeltaHedgeUI.bindDeltaHedgePanel === 'function') {
        OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {
            updateDerivedValues,
            requestBrokerPreview: typeof requestDeltaHedgeBrokerPreview === 'function'
                ? requestDeltaHedgeBrokerPreview
                : null,
            requestSubmit: typeof requestDeltaHedgeSubmit === 'function'
                ? requestDeltaHedgeSubmit
                : null,
            requestCancel: typeof requestDeltaHedgeCancel === 'function'
                ? requestDeltaHedgeCancel
                : null,
        });
    }
}

// -------------------------------------------------------------
// Group & Leg Management & Rendering
// -------------------------------------------------------------

// getMultiplier() has been unified globally in bsm.js

function addGroup() {
    OptionComboGroupEditorUI.addGroup(state, generateId, {
        addDays,
        renderGroups,
    });
}

function removeGroup(groupId) {
    OptionComboGroupEditorUI.removeGroup(state, groupId, {
        handleLiveSubscriptions,
        renderGroups,
    });
}

// -------------------------------------------------------------
// Hedge Management & Rendering
// -------------------------------------------------------------
function addHedge() {
    OptionComboHedgeEditorUI.addHedge(state, renderHedges, generateId);
}

function removeHedge(btn) {
    OptionComboHedgeEditorUI.removeHedge(state, btn, {
        handleLiveSubscriptions,
        renderHedges,
    });
}

// We expose globally so index.html templates can call it
window.addHedge = addHedge;
window.removeHedge = removeHedge;

function renderHedges() {
    OptionComboHedgeEditorUI.renderHedges(state, {
        updateDerivedValues,
        handleLiveSubscriptions,
    });
}

function toggleSidebar() {
    OptionComboControlPanelUI.toggleSidebar();
}

function addLegToGroupById(groupId) {
    OptionComboGroupEditorUI.addLegToGroupById(state, groupId, generateId, {
        addDays,
        renderGroups,
    });
}

function addLegToGroup(buttonEl) {
    OptionComboGroupEditorUI.addLegToGroup(state, buttonEl, generateId, {
        addDays,
        renderGroups,
    });
}

function removeLeg(groupId, legId) {
    OptionComboGroupEditorUI.removeLeg(state, groupId, legId, {
        handleLiveSubscriptions,
        renderGroups,
    });
}

function renderGroups() {
    OptionComboGroupEditorUI.renderGroups(state, {
        addDays,
        updateDerivedValues,
        updateProbCharts,
        handleLiveSubscriptions,
        groupHasDeterministicCost,
        groupHasOpenPosition,
        getRenderableGroupViewMode: OptionComboSessionLogic.getRenderableGroupViewMode,
        isGroupIncludedInGlobal: OptionComboSessionLogic.isGroupIncludedInGlobal,
        supportsAmortizedMode(symbol) {
            return typeof OptionComboProductRegistry === 'undefined'
                ? true
                : OptionComboProductRegistry.supportsAmortizedMode(symbol);
        },
        supportsUnderlyingLegs(symbol) {
            return typeof OptionComboProductRegistry === 'undefined'
                ? true
                : OptionComboProductRegistry.supportsUnderlyingLegs(symbol);
        },
        requestPortfolioAvgCostSnapshot,
        requestContinueManagedComboOrder,
        requestConcedeManagedComboOrder,
        requestCancelManagedComboOrder,
        requestCloseGroupComboOrder,
        enterHistoricalReplayGroup,
        syncHistoricalReplayExpirySettlement,
        getUnderlyingProfile,
        generateId,
        renderGroups,
    });
}

// -------------------------------------------------------------
// Core Calculations
// -------------------------------------------------------------

function setGroupViewMode(btn, mode) {
    if (mode === 'amortized'
        && typeof OptionComboProductRegistry !== 'undefined'
        && !OptionComboProductRegistry.supportsAmortizedMode(state.underlyingSymbol)) {
        return;
    }

    const card = btn.closest('.group-card');
    if (!card) return;
    const groupId = card.dataset.groupId;
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return;

    const nextMode = OptionComboSessionLogic.resolveGroupViewModeChange(group, mode);
    if (nextMode === (group.viewMode || 'active')) return;
    group.viewMode = nextMode;

    // Trigger a full re-render of the group to handle complex visibility toggles.
    renderGroups();

    // Explicitly redraw charts related to this group.
    triggerChartRedraw(btn);
    updateProbCharts();
}

function applyHedgeDerivedData(derivedData) {
    OptionComboHedgeUI.applyHedgeDerivedData(derivedData, currencyFormatter);
}

function applyHedgeRowDerivedData(row, hedgeResult) {
    if (!row || !hedgeResult) return;
    if (typeof OptionComboHedgeUI !== 'undefined'
        && typeof OptionComboHedgeUI.applyHedgeRowDerivedData === 'function') {
        OptionComboHedgeUI.applyHedgeRowDerivedData(row, hedgeResult, currencyFormatter);
    }
}

function applyGroupDerivedData(card, groupResult) {
    OptionComboGroupUI.applyGroupDerivedData(card, groupResult, currencyFormatter, {
        drawGroupChart,
        drawAmortizationChart,
    });
}

function applyGroupDeltaSummary(card, groupResult) {
    if (!card || !groupResult) return;
    if (typeof OptionComboGroupUI !== 'undefined'
        && typeof OptionComboGroupUI.applyGroupDeltaSummary === 'function') {
        OptionComboGroupUI.applyGroupDeltaSummary(card, groupResult);
    }
}

function applyGlobalDerivedData(derivedData) {
    OptionComboGlobalUI.applyGlobalDerivedData(derivedData, currencyFormatter, {
        drawGlobalChart,
        drawGlobalAmortizedChart,
    });
}

function _cachePortfolioDerivedData(derivedData) {
    _latestPortfolioDerivedData = derivedData || null;
    return derivedData;
}

function _syncWorkspaceChrome() {
    if (typeof OptionComboSessionUI !== 'undefined'
        && typeof OptionComboSessionUI.syncWorkspaceChrome === 'function') {
        OptionComboSessionUI.syncWorkspaceChrome(state);
    }
}

function _applyPortfolioDerivedData(derivedData, options = {}) {
    if (!derivedData) {
        return;
    }

    if (options.syncWorkspaceChrome === true) {
        _syncWorkspaceChrome();
    }

    const groupIds = Array.isArray(options.groupIds) ? options.groupIds.filter(Boolean) : null;
    const hedgeIds = Array.isArray(options.hedgeIds) ? options.hedgeIds.filter(Boolean) : null;

    if (hedgeIds && hedgeIds.length > 0) {
        hedgeIds.forEach((hedgeId) => {
            const row = document.querySelector(`.hedge-row[data-id="${hedgeId}"]`);
            const hedgeResult = derivedData.hedgeResultsById.get(hedgeId);
            if (!row || !hedgeResult) return;
            applyHedgeRowDerivedData(row, hedgeResult);
        });
    } else {
        applyHedgeDerivedData(derivedData);
    }

    if (groupIds && groupIds.length > 0) {
        groupIds.forEach((groupId) => {
            const card = document.querySelector(`.group-card[data-group-id="${groupId}"]`);
            const groupResult = derivedData.groupResultsById.get(groupId);
            if (!card || !groupResult) return;
            applyGroupDerivedData(card, groupResult);
        });
    } else {
        document.querySelectorAll('.group-card').forEach(card => {
            const groupResult = derivedData.groupResultsById.get(card.dataset.groupId);
            if (!groupResult) return;
            applyGroupDerivedData(card, groupResult);
        });
    }

    applyGlobalDerivedData(derivedData);
    if (typeof OptionComboDeltaHedgeUI !== 'undefined'
        && typeof OptionComboDeltaHedgeUI.applyRecommendationPreview === 'function') {
        OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData);
        if (typeof OptionComboDeltaHedgeUI.applyBrokerPreviewState === 'function') {
            OptionComboDeltaHedgeUI.applyBrokerPreviewState(state);
        }
        runDeltaHedgeAutoSupervisor(derivedData);
    }
}

function updateDerivedValues() {
    const derivedData = _cachePortfolioDerivedData(
        OptionComboValuation.computePortfolioDerivedData(state)
    );
    _applyPortfolioDerivedData(derivedData, {
        syncWorkspaceChrome: true,
    });
    return derivedData;
}

function updateLiveQuoteDerivedValues(changeSet = {}) {
    if (!_latestPortfolioDerivedData
        || typeof OptionComboValuation === 'undefined'
        || typeof OptionComboValuation.computeGroupDerivedData !== 'function'
        || typeof OptionComboValuation.computeHedgeDerivedData !== 'function'
        || typeof OptionComboValuation.buildPortfolioDerivedDataFromResults !== 'function') {
        return updateDerivedValues();
    }

    const groupIds = Array.from(new Set(
        Array.isArray(changeSet.groupIds) ? changeSet.groupIds.filter(Boolean) : []
    ));
    const hedgeIds = Array.from(new Set(
        Array.isArray(changeSet.hedgeIds) ? changeSet.hedgeIds.filter(Boolean) : []
    ));

    if (groupIds.length === 0 && hedgeIds.length === 0) {
        return _latestPortfolioDerivedData;
    }

    const nextGroupResults = _latestPortfolioDerivedData.groupResults.slice();
    const nextHedgeResults = _latestPortfolioDerivedData.hedgeResults.slice();

    groupIds.forEach((groupId) => {
        const group = state.groups.find(candidate => candidate.id === groupId);
        if (!group) return;
        const nextGroupResult = OptionComboValuation.computeGroupDerivedData(group, state);
        const existingIndex = nextGroupResults.findIndex(result => result.id === groupId);
        if (existingIndex >= 0) {
            nextGroupResults[existingIndex] = nextGroupResult;
        } else {
            nextGroupResults.push(nextGroupResult);
        }
    });

    hedgeIds.forEach((hedgeId) => {
        const hedge = state.hedges.find(candidate => candidate.id === hedgeId);
        if (!hedge) return;
        const nextHedgeResult = OptionComboValuation.computeHedgeDerivedData(hedge);
        const existingIndex = nextHedgeResults.findIndex(result => result.id === hedgeId);
        if (existingIndex >= 0) {
            nextHedgeResults[existingIndex] = nextHedgeResult;
        } else {
            nextHedgeResults.push(nextHedgeResult);
        }
    });

    const derivedData = _cachePortfolioDerivedData(
        OptionComboValuation.buildPortfolioDerivedDataFromResults(
            state,
            nextGroupResults,
            nextHedgeResults
        )
    );

    _applyPortfolioDerivedData(derivedData, {
        groupIds,
        hedgeIds,
    });
    return derivedData;
}

function _getAutoOrderDateKey(now = new Date()) {
    const date = now instanceof Date ? now : new Date(now);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function _recordDeltaHedgeAutoSubmitAttempt(decision, now = new Date()) {
    if (!state.deltaHedge || typeof state.deltaHedge !== 'object') {
        return;
    }
    const dateKey = decision && decision.dateKey
        ? decision.dateKey
        : _getAutoOrderDateKey(now);
    const currentDateKey = String(state.deltaHedge.autoOrderCountDate || '');
    const currentCount = currentDateKey === dateKey
        ? Math.max(0, Math.floor(Number(state.deltaHedge.autoOrderCount) || 0))
        : 0;
    const timestamp = now.toISOString();
    state.deltaHedge.autoOrderCountDate = dateKey;
    state.deltaHedge.autoOrderCount = currentCount + 1;
    state.deltaHedge.lastAutoOrderAt = timestamp;
    state.deltaHedge.lastOrderEventAt = timestamp;
    state.deltaHedge.autoLastSubmittedKey = decision && decision.executionKey
        ? decision.executionKey
        : '';
}

function _appendDeltaHedgeAutoDecisionLog(decision, now = new Date()) {
    if (!state.deltaHedge || typeof state.deltaHedge !== 'object' || !decision) {
        return;
    }
    const log = Array.isArray(state.deltaHedge.autoDecisionLog)
        ? state.deltaHedge.autoDecisionLog.slice(-99)
        : [];
    log.push({
        at: now.toISOString(),
        action: decision.action || '',
        reason: decision.reason || '',
        executionKey: decision.executionKey || '',
        orderCount: Number.isFinite(Number(decision.orderCount)) ? Number(decision.orderCount) : null,
    });
    state.deltaHedge.autoDecisionLog = log;
}

function runDeltaHedgeAutoSupervisor(derivedData = _latestPortfolioDerivedData) {
    if (typeof OptionComboDeltaHedgeLogic === 'undefined'
        || typeof OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation !== 'function') {
        return null;
    }
    if (!state.deltaHedge || typeof state.deltaHedge !== 'object') {
        return null;
    }

    const runtime = state.deltaHedge;
    const recommendation = runtime.lastRecommendation
        || (typeof OptionComboDeltaHedgeUI !== 'undefined'
            && typeof OptionComboDeltaHedgeUI.applyRecommendationPreview === 'function'
            ? OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData || {})
            : null);
    const hasActiveRestingOrder = typeof OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder === 'function'
        && OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder(runtime);
    const now = new Date();
    const decision = OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
        deltaHedge: runtime,
        recommendation,
        liveMode: state.marketDataMode !== 'historical',
        greeksEnabled: state.greeksEnabled === true,
        allowLiveHedgeOrders: state.allowLiveHedgeOrders === true,
        selectedAccount: state.selectedLiveComboOrderAccount,
        pendingRequest: runtime.pendingRequest === true,
        hasActiveRestingOrder,
        lastPreview: runtime.lastPreview,
        lastPreviewAt: runtime.lastPreviewAt,
        now,
    });

    runtime.autoLastDecision = decision;
    runtime.autoStatus = decision.reason || decision.action || '';
    if (runtime.autoSubmitEnabled === true) {
        _appendDeltaHedgeAutoDecisionLog(decision, now);
    }
    if (typeof OptionComboDeltaHedgeUI !== 'undefined'
        && typeof OptionComboDeltaHedgeUI.applyAutomationState === 'function') {
        OptionComboDeltaHedgeUI.applyAutomationState(state);
    }

    if (decision.action === 'request_preview'
        && typeof requestDeltaHedgeBrokerPreview === 'function'
        && recommendation
        && recommendation.actionable === true) {
        const lastPreviewAttemptMs = Date.parse(runtime.lastAutoPreviewAttemptAt || '');
        if (Number.isFinite(lastPreviewAttemptMs) && now.getTime() - lastPreviewAttemptMs < 5000) {
            return decision;
        }
        runtime.lastAutoPreviewAttemptAt = now.toISOString();
        requestDeltaHedgeBrokerPreview(recommendation, {
            requestSource: 'delta_hedge_auto_preview',
        });
        return decision;
    }

    if (decision.action === 'cancel_stale_order'
        && typeof requestDeltaHedgeCancel === 'function') {
        const canceled = requestDeltaHedgeCancel({
            requestSource: 'delta_hedge_auto_stale_cancel',
            reason: 'auto_stale_cancel',
        });
        if (canceled) {
            runtime.autoLastDecision = {
                ...decision,
                action: 'cancel_requested',
            };
            runtime.autoStatus = 'cancel_requested';
            if (typeof OptionComboDeltaHedgeUI !== 'undefined'
                && typeof OptionComboDeltaHedgeUI.applyAutomationState === 'function') {
                OptionComboDeltaHedgeUI.applyAutomationState(state);
            }
        }
        return decision;
    }

    if (decision.action === 'submit'
        && typeof requestDeltaHedgeSubmit === 'function'
        && recommendation
        && recommendation.actionable === true) {
        const submitted = requestDeltaHedgeSubmit(recommendation, {
            requestSource: 'delta_hedge_auto_submit',
        });
        if (submitted) {
            _recordDeltaHedgeAutoSubmitAttempt(decision, now);
            runtime.autoLastDecision = {
                ...decision,
                action: 'submitted',
            };
            runtime.autoStatus = 'submitted';
            if (typeof OptionComboDeltaHedgeUI !== 'undefined'
                && typeof OptionComboDeltaHedgeUI.applyAutomationState === 'function') {
                OptionComboDeltaHedgeUI.applyAutomationState(state);
            }
        }
        return decision;
    }

    return decision;
}

if (typeof window !== 'undefined') {
    window.runDeltaHedgeAutoSupervisor = runDeltaHedgeAutoSupervisor;
}

function _hasGroupDeltaSummaryChanged(currentGroupResult, nextGroupDeltaSummary) {
    if (!currentGroupResult || !nextGroupDeltaSummary) {
        return true;
    }

    return currentGroupResult.groupDeltaDisplayable !== nextGroupDeltaSummary.groupDeltaDisplayable
        || currentGroupResult.groupDeltaAvailable !== nextGroupDeltaSummary.groupDeltaAvailable
        || currentGroupResult.groupDelta !== nextGroupDeltaSummary.groupDelta
        || currentGroupResult.groupDeltaLegCount !== nextGroupDeltaSummary.groupDeltaLegCount
        || currentGroupResult.groupDeltaMissingLegCount !== nextGroupDeltaSummary.groupDeltaMissingLegCount;
}

function updateLiveQuoteGroupDeltaValues(changeSet = {}) {
    if (!_latestPortfolioDerivedData
        || typeof OptionComboValuation === 'undefined'
        || typeof OptionComboValuation.computeGroupDeltaSummary !== 'function') {
        return updateDerivedValues();
    }

    const groupIds = Array.from(new Set(
        Array.isArray(changeSet.groupIds) ? changeSet.groupIds.filter(Boolean) : []
    ));
    if (groupIds.length === 0) {
        return _latestPortfolioDerivedData;
    }

    const nextGroupResults = _latestPortfolioDerivedData.groupResults.slice();
    let changedAny = false;

    groupIds.forEach((groupId) => {
        const group = state.groups.find(candidate => candidate.id === groupId);
        const existingIndex = nextGroupResults.findIndex(result => result.id === groupId);
        if (!group || existingIndex < 0) {
            return;
        }

        const currentGroupResult = nextGroupResults[existingIndex];
        const nextGroupDeltaSummary = OptionComboValuation.computeGroupDeltaSummary(group, state);
        if (!_hasGroupDeltaSummaryChanged(currentGroupResult, nextGroupDeltaSummary)) {
            return;
        }

        nextGroupResults[existingIndex] = {
            ...currentGroupResult,
            ...nextGroupDeltaSummary,
        };
        changedAny = true;
    });

    if (!changedAny) {
        return _latestPortfolioDerivedData;
    }

    const derivedData = _cachePortfolioDerivedData(
        typeof OptionComboValuation.buildPortfolioDerivedDataFromResults === 'function'
            ? OptionComboValuation.buildPortfolioDerivedDataFromResults(
                state,
                nextGroupResults,
                _latestPortfolioDerivedData.hedgeResults || []
            )
            : {
                ..._latestPortfolioDerivedData,
                groupResults: nextGroupResults,
                groupResultsById: new Map(nextGroupResults.map(result => [result.id, result])),
            }
    );

    groupIds.forEach((groupId) => {
        const card = document.querySelector(`.group-card[data-group-id="${groupId}"]`);
        const groupResult = derivedData.groupResultsById.get(groupId);
        if (!card || !groupResult) return;
        applyGroupDeltaSummary(card, groupResult);
    });

    if (typeof OptionComboDeltaHedgeUI !== 'undefined'
        && typeof OptionComboDeltaHedgeUI.applyRecommendationPreview === 'function') {
        OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData);
    }

    return derivedData;
}

function settleHistoricalReplayGroups() {
    if (state.marketDataMode !== 'historical') {
        return 0;
    }

    let settledCount = 0;
    state.groups.forEach((group) => {
        if (requestCloseGroupComboOrder(group)) {
            settledCount += 1;
        }
    });

    return settledCount;
}

function enterHistoricalReplayGroup(group) {
    if (state.marketDataMode !== 'historical'
        || typeof requestHistoricalReplayEntryGroup !== 'function') {
        return false;
    }

    return requestHistoricalReplayEntryGroup(group);
}

function syncHistoricalReplayExpirySettlement(group) {
    if (state.marketDataMode !== 'historical'
        || typeof requestHistoricalReplayExpirySettlementSync !== 'function') {
        return false;
    }

    return requestHistoricalReplayExpirySettlementSync(group);
}

let currentFileHandle = null;

async function handleImportBtnClick() {
    if (window.showOpenFilePicker) {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [{
                    description: 'JSON Files',
                    accept: {
                        'application/json': ['.json'],
                    },
                }],
                multiple: false
            });
            currentFileHandle = fileHandle;
            const file = await fileHandle.getFile();
            document.getElementById('saveBtn').style.display = 'inline-flex';
            processImportedFile(file);
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error("Error opening file picker:", error);
                document.getElementById('importFile').click();
            }
        }
    } else {
        document.getElementById('importFile').click();
    }
}

async function saveToJSON() {
    const dataStr = JSON.stringify(OptionComboSessionLogic.buildExportState(state), null, 2);
    const saveBtn = document.getElementById('saveBtn');

    if (currentFileHandle && saveBtn) {
        try {
            const writable = await currentFileHandle.createWritable();
            await writable.write(dataStr);
            await writable.close();

            const originalHTML = saveBtn.innerHTML;
            saveBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Saved!`;
            setTimeout(() => {
                saveBtn.innerHTML = originalHTML;
            }, 2000);
            return;
        } catch (error) {
            console.error("Error saving directly to file:", error);
        }
    }

    exportToJSON();
}

function exportToJSON() {
    const dataStr = JSON.stringify(OptionComboSessionLogic.buildExportState(state), null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `option_combo_sim_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importFromJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    currentFileHandle = null;
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) saveBtn.style.display = 'none';

    processImportedFile(file);
    event.target.value = '';
}

function applyImportedState(normalizedState, importedSessionTitle = '') {
    state.importedSessionTitle = String(importedSessionTitle || '').trim();
    state.underlyingSymbol = normalizedState.underlyingSymbol;
    state.underlyingContractMonth = normalizedState.underlyingContractMonth;
    state.underlyingPrice = normalizedState.underlyingPrice;
    state.baseDate = normalizedState.baseDate;
    state.simulatedDate = normalizedState.simulatedDate;
    state.marketDataMode = normalizedState.marketDataMode === 'historical' ? 'historical' : 'live';
    if (state.marketDataModeLocked === true) {
        state.marketDataMode = state.workspaceVariant === 'historical' ? 'historical' : 'live';
    }
    state.historicalQuoteDate = normalizedState.historicalQuoteDate
        || (state.marketDataMode === 'historical' ? (normalizedState.baseDate || normalizedState.simulatedDate || '') : '');
    state.historicalAvailableStartDate = '';
    state.historicalAvailableEndDate = '';
    state.interestRate = normalizedState.interestRate;
    state.ivOffset = normalizedState.ivOffset;
    state.greeksEnabled = normalizedState.greeksEnabled === true;
    state.deltaHedge = OptionComboSessionLogic.normalizeDeltaHedgeConfig(normalizedState.deltaHedge);
    state.primaryControlPanelCollapsed = normalizedState.primaryControlPanelCollapsed === true;
    state.allowLiveComboOrders = normalizedState.allowLiveComboOrders === true;
    if (state.marketDataMode !== 'live') {
        state.allowLiveComboOrders = false;
    }
    state.allowLiveHedgeOrders = normalizedState.allowLiveHedgeOrders === true && state.marketDataMode === 'live';
    state.liveComboOrderAccounts = Array.isArray(normalizedState.liveComboOrderAccounts)
        ? normalizedState.liveComboOrderAccounts.slice()
        : [];
    state.liveComboOrderAccountsConnected = normalizedState.liveComboOrderAccountsConnected === true;
    state.selectedLiveComboOrderAccount = typeof normalizedState.selectedLiveComboOrderAccount === 'string'
        ? normalizedState.selectedLiveComboOrderAccount
        : '';
    state.forwardRateSamples = normalizedState.forwardRateSamples || [];
    state.futuresPool = normalizedState.futuresPool || [];
    state.groups = normalizedState.groups;
    state.hedges = normalizedState.hedges;

    if (!state.underlyingContractMonth
        && typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth === 'function') {
        state.underlyingContractMonth = OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            state.simulatedDate || state.baseDate
        );
    }
}

function processImportedFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const importedState = JSON.parse(e.target.result);

            if (importedState && typeof importedState === 'object') {
                const normalizedState = OptionComboSessionLogic.normalizeImportedState(
                    state,
                    importedState,
                    initialDateStr,
                    generateId,
                    addDays
                );

                applyImportedState(normalizedState, file && typeof file.name === 'string' ? file.name : '');
                OptionComboSessionUI.syncControlPanel(state, currencyFormatter, {
                    diffDays,
                    calendarToTradingDays,
                });

                renderGroups();
                renderHedges();
                handleLiveSubscriptions();
            } else {
                alert("Invalid JSON format.");
            }
        } catch (error) {
            console.error("JSON Import Error:", error);
            alert("Error parsing JSON file or loading state. Check the console for details.");
        }
    };
    reader.readAsText(file);
}

// WebSocket & Live Data Integration -> see ws_client.js
function calculateAmortizedCost(group, evalUnderlyingPrice, globalState) {
    return OptionComboAmortized.calculateAmortizedCost(group, evalUnderlyingPrice, globalState);
}

function calculateCombinedAmortizedCost(groups, globalState) {
    return OptionComboAmortized.calculateCombinedAmortizedCost(groups, globalState);
}

window.toggleGroupCollapse = OptionComboGroupEditorUI.toggleGroupCollapse;
