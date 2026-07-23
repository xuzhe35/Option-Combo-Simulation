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
const localInitialDateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
const initialDateStr = window.OptionComboPricingContext
    && typeof window.OptionComboPricingContext.resolveLiveQuoteDate === 'function'
    ? (window.OptionComboPricingContext.resolveLiveQuoteDate({
        marketDataMode: 'live',
        underlyingSymbol: 'SPY',
    }, today.toISOString()) || localInitialDateStr)
    : localInitialDateStr;

/**
 * @typedef {Object} OptionComboBootstrapRuntimeConfig
 * @property {'live'|'historical'} marketDataMode
 * @property {''|'live'|'historical'} workspaceVariant
 * @property {boolean} marketDataModeLocked
 */

/** @returns {OptionComboBootstrapRuntimeConfig} */
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
    baseDate: initialDateStr, // Entry/session date; never rolled by live quotes
    simulatedDate: initialDateStr, // Scenario target; initially the live market date
    marketDataMode: bootstrapRuntimeConfig.marketDataMode,
    workspaceVariant: bootstrapRuntimeConfig.workspaceVariant,
    marketDataModeLocked: bootstrapRuntimeConfig.marketDataModeLocked === true,
    historicalQuoteDate: '',
    liveQuoteDate: '',
    liveQuoteAsOf: '',
    // Subscription ids the backend could not qualify, keyed by leg id.
    liveSubscriptionUnresolvedById: {},
    historicalAvailableStartDate: '',
    historicalAvailableEndDate: '',
    historicalTradingDates: [],
    // Continuously compounded discount-rate fallback.  A live/historical
    // discount curve overrides this scalar when useMarketDiscountCurve=true.
    interestRate: 0.03,
    useMarketDiscountCurve: true,
    discountCurve: null,
    discountCurveLastError: '',
    discountCurveRequestPending: false,
    discountCurveRequestManual: false,
    discountCurveLastResponseStatus: '',
    discountCurveLastLoadedAt: '',
    discountCurveLastLoadWasManual: false,
    ivOffset: 0.0, // 0%
    simTimeBasis: 'weighted', // 'calendar' (TWS default) | 'trading' | 'weighted'
    simWeekendWeight: 0.3, // λ: weekend/holiday variance weight used by 'weighted'
    // Strict-by-default: a live weighted-clock projection must consume the
    // IVTS per-non-trading-day curve (or visibly fail closed).  The scalar λ
    // remains an explicit opt-out selected by the user, never an implicit
    // compatibility fallback for old sessions.
    simUseImpliedLambda: true,
    simImpliedLambdaEntry: null, // runtime cache of the matched IVTS handoff entry (not exported)
    simImpliedLambdaFileEntry: null, // explicit portable-file fallback; never populated by localStorage
    simImpliedLambdaCoverage: null, // runtime per-live-leg coverage audit; never exported
    simulationTiming: null, // runtime portfolio-global valuation instant; never exported
    // Accuracy-first live What-If gate. Every option that remains alive at the
    // target must have a fresh valid two-sided BBO whose IV this runtime can
    // invert locally. `legacy-input-iv` is import-only compatibility mode.
    projectionConvergenceMode: 'strict-bbo',
    liveProjectionFeedConnected: false, // runtime websocket health; not exported
    liveProjectionFeedStale: true, // runtime market-data watchdog; not exported
    liveProjectionLastReceivedAt: '', // local receipt clock; not exported
    // Live short-dated/FOP/INDEX projections require IB contract-level expiry
    // timestamps. Historical replay and an explicit false opt-out retain the
    // legacy product-profile cutoff behavior.
    requireExactContractTiming: true,
    greeksEnabled: false,
    deltaHedge: OptionComboSessionLogic.createDefaultDeltaHedgeConfig(),
    primaryControlPanelCollapsed: false,
    allowLiveComboOrders: false,
    allowLiveHedgeOrders: false,
    liveComboOrderAccounts: [],
    liveComboOrderAccountsConnected: false,
    selectedLiveComboOrderAccount: '',
    portfolioPositions: [],
    portfolioPositionsConnected: false,
    pendingLegExistsCheckGroupId: '',
    forwardRateSamples: [],
    futuresPool: [],
    viewMode: 'active', // 'active' (Historical Entry Cost) or 'trial' (Current Live Price)
    groups: [],
    hedges: [] // {id, symbol, currentPrice, pos, cost, liveData}
};

window.__optionComboApp = {
    getState: () => state,
    getSessionFileTargetState: () => ({
        hasFileTarget: sessionHasFileTarget || !!currentFileHandle,
        hasWritableFileHandle: !!currentFileHandle,
    }),
    renderGroups: () => renderGroups(),
    renderHedges: () => renderHedges(),
    updateLiveQuoteDerivedValues: (changeSet) => updateLiveQuoteDerivedValues(changeSet),
    updateLiveQuoteGroupDeltaValues: (changeSet) => updateLiveQuoteGroupDeltaValues(changeSet),
    runDeltaHedgeAutoSupervisor: () => runDeltaHedgeAutoSupervisor(),
};

// Throttle flag for slider-driven updates (one rAF per frame max)
let _sliderRafPending = false;
let _latestPortfolioDerivedData = null;
let _impliedLambdaRefreshPending = false;
let _impliedLambdaRefreshRequested = false;
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

// Consumes a Calendar Finder handoff written by the IV term structure page
// and materializes it as one combo group (sell short straddle, buy long straddle).
function consumePendingCalendarHandoff() {
    const handoffApi = typeof OptionComboCalendarHandoff !== 'undefined' && OptionComboCalendarHandoff
        ? OptionComboCalendarHandoff
        : null;
    if (!handoffApi || typeof handoffApi.takeHandoffPayload !== 'function') {
        return false;
    }

    const payload = handoffApi.takeHandoffPayload();
    if (!payload) {
        return false;
    }

    state.underlyingSymbol = payload.symbol;
    state.underlyingContractMonth = String(payload.underlyingContractMonth || '')
        .replace(/\D/g, '').slice(0, 6);
    state.simImpliedLambdaEntry = null;
    state.simImpliedLambdaFileEntry = null;
    state.simImpliedLambdaCoverage = null;
    state.simulationTiming = null;
    if (Number.isFinite(payload.underlyingPrice) && payload.underlyingPrice > 0) {
        state.underlyingPrice = payload.underlyingPrice;
    }

    const productRegistry = _getProductRegistryApi();
    if (!state.underlyingContractMonth
        && productRegistry
        && typeof productRegistry.resolveDefaultUnderlyingContractMonth === 'function') {
        state.underlyingContractMonth = productRegistry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            state.simulatedDate || state.baseDate
        );
    }

    const profile = productRegistry && typeof productRegistry.resolveUnderlyingProfile === 'function'
        ? productRegistry.resolveUnderlyingProfile(state.underlyingSymbol)
        : null;
    const requiresFutureBinding = !!(profile && (
        profile.requiresPerLegForwardBinding === true
        || String(profile.optionSecType || '').trim().toUpperCase() === 'FOP'
        || String(profile.underlyingSecType || '').trim().toUpperCase() === 'FUT'
    ));
    let handoffFutureId = '';
    if (requiresFutureBinding && /^\d{6}$/.test(state.underlyingContractMonth)) {
        if (!Array.isArray(state.futuresPool)) state.futuresPool = [];
        let futureEntry = state.futuresPool.find(entry =>
            String(entry && entry.contractMonth || '').replace(/\D/g, '').slice(0, 6)
                === state.underlyingContractMonth
        );
        const payloadFuture = payload.underlyingFuture && typeof payload.underlyingFuture === 'object'
            ? payload.underlyingFuture
            : {};
        if (!futureEntry) {
            futureEntry = {
                id: generateId(),
                contractMonth: state.underlyingContractMonth,
                bid: null,
                ask: null,
                mark: Number.isFinite(parseFloat(payloadFuture.mark))
                    ? parseFloat(payloadFuture.mark)
                    : (Number.isFinite(payload.underlyingPrice) ? payload.underlyingPrice : null),
                quoteAsOf: String(payloadFuture.quoteAsOf || '').trim(),
                lastQuotedAt: String(payloadFuture.quoteAsOf || '').trim() || null,
                conId: Number.isFinite(parseInt(payloadFuture.conId, 10))
                    ? parseInt(payloadFuture.conId, 10)
                    : null,
                localSymbol: String(payloadFuture.localSymbol || '').trim(),
                exchange: String(payloadFuture.exchange || profile.underlyingExchange || '').trim(),
                currency: String(payloadFuture.currency || profile.currency || 'USD').trim().toUpperCase(),
                multiplier: String(payloadFuture.multiplier || profile.underlyingLegMultiplier || '').trim(),
                secType: 'FUT',
                symbol: state.underlyingSymbol,
            };
            state.futuresPool.push(futureEntry);
        }
        handoffFutureId = String(futureEntry.id || '');
    }

    OptionComboGroupEditorUI.addGroup(state, generateId, {
        addDays,
        renderGroups: () => {},
    });
    const group = state.groups[state.groups.length - 1];
    if (group) {
        group.name = handoffApi.buildGroupName(payload);
        group.legs = handoffApi.buildCalendarLegs(payload, generateId, handoffFutureId);
        group.liveData = true;
    }

    OptionComboSessionUI.syncControlPanel(state, currencyFormatter, {
        diffDays,
        calendarToTradingDays,
        requestDiscountCurveSnapshot: typeof requestDiscountCurveSnapshot === 'function'
            ? requestDiscountCurveSnapshot
            : null,
    });
    if (typeof handleLiveSubscriptions === 'function') {
        handleLiveSubscriptions();
    }
    return true;
}

document.addEventListener('DOMContentLoaded', () => {
    _syncSessionFileActionButtons();
    bindControlPanelEvents();
    consumePendingCalendarHandoff();
    renderGroups();
    renderHedges();
    updateDerivedValues();
    setInterval(() => {
        runDeltaHedgeAutoSupervisor();
    }, 5000);
});

// Re-price when the IVTS tab explicitly syncs a new implied-lambda array (the
// 'storage' event only fires for writes from other tabs).
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (event) => {
        const handoff = typeof OptionComboImpliedLambdaHandoff !== 'undefined'
            ? OptionComboImpliedLambdaHandoff
            : null;
        if (!handoff || !event || event.key !== handoff.STORAGE_KEY) {
            return;
        }
        if (state.simUseImpliedLambda === true && state.simTimeBasis === 'weighted') {
            _scheduleImpliedLambdaRefresh();
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden !== true && _impliedLambdaRefreshRequested) {
            _scheduleImpliedLambdaRefresh();
        }
    });
}

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

function _getProductRegistryApi() {
    return typeof OptionComboProductRegistry !== 'undefined' && OptionComboProductRegistry
        ? OptionComboProductRegistry
        : null;
}

function _getPageCapabilitiesApi() {
    return typeof OptionComboPageCapabilities !== 'undefined' && OptionComboPageCapabilities
        ? OptionComboPageCapabilities
        : null;
}

function _getDeltaHedgeUiApi() {
    return typeof OptionComboDeltaHedgeUI !== 'undefined' && OptionComboDeltaHedgeUI
        ? OptionComboDeltaHedgeUI
        : null;
}

function _getDeltaHedgeLogicApi() {
    return typeof OptionComboDeltaHedgeLogic !== 'undefined' && OptionComboDeltaHedgeLogic
        ? OptionComboDeltaHedgeLogic
        : null;
}

function _getValuationApi() {
    return typeof OptionComboValuation !== 'undefined' && OptionComboValuation
        ? OptionComboValuation
        : null;
}

function _getSessionUiApi() {
    return typeof OptionComboSessionUI !== 'undefined' && OptionComboSessionUI
        ? OptionComboSessionUI
        : null;
}

function _getGroupUiApi() {
    return typeof OptionComboGroupUI !== 'undefined' && OptionComboGroupUI
        ? OptionComboGroupUI
        : null;
}

function _getHedgeUiApi() {
    return typeof OptionComboHedgeUI !== 'undefined' && OptionComboHedgeUI
        ? OptionComboHedgeUI
        : null;
}

function _runUiRefreshSafely(label, callback, fallbackValue) {
    try {
        return callback();
    } catch (error) {
        console.error(`UI refresh failed (${label}):`, error);
        return fallbackValue;
    }
}

function getUnderlyingProfile() {
    const productRegistry = _getProductRegistryApi();
    if (!productRegistry || typeof productRegistry.resolveUnderlyingProfile !== 'function') {
        return null;
    }
    return productRegistry.resolveUnderlyingProfile(state.underlyingSymbol);
}

function _pageHasFeature(featureName, fallback = true) {
    const pageCapabilities = _getPageCapabilitiesApi();
    if (!pageCapabilities || typeof pageCapabilities.hasFeature !== 'function') {
        return fallback === true;
    }
    return pageCapabilities.hasFeature(featureName);
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
        requestDiscountCurveSnapshot: typeof requestDiscountCurveSnapshot === 'function'
            ? requestDiscountCurveSnapshot
            : null,
    });
    const deltaHedgeUi = _getDeltaHedgeUiApi();
    if (_pageHasFeature('deltaHedgePanel')
        && deltaHedgeUi
        && typeof deltaHedgeUi.bindDeltaHedgePanel === 'function') {
        deltaHedgeUi.bindDeltaHedgePanel(state, {
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
            const productRegistry = _getProductRegistryApi();
            return !productRegistry || typeof productRegistry.supportsAmortizedMode !== 'function'
                ? true
                : productRegistry.supportsAmortizedMode(symbol);
        },
        supportsUnderlyingLegs(symbol) {
            const productRegistry = _getProductRegistryApi();
            return !productRegistry || typeof productRegistry.supportsUnderlyingLegs !== 'function'
                ? true
                : productRegistry.supportsUnderlyingLegs(symbol);
        },
        requestPortfolioAvgCostSnapshot,
        requestLegExistsCheck: typeof requestLegExistsCheck === 'function'
            ? requestLegExistsCheck
            : null,
        requestContinueManagedComboOrder,
        requestConcedeManagedComboOrder,
        requestManualConcedeManagedComboOrder: typeof requestManualConcedeManagedComboOrder === 'function'
            ? requestManualConcedeManagedComboOrder
            : null,
        requestCancelManagedComboOrder,
        requestCloseGroupComboOrder,
        requestEquivalentCloseGroupComboOrder: typeof requestEquivalentCloseGroupComboOrder === 'function'
            ? requestEquivalentCloseGroupComboOrder
            : null,
        requestCloseLegComboOrder: typeof requestCloseLegComboOrder === 'function'
            ? requestCloseLegComboOrder
            : null,
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
    const productRegistry = _getProductRegistryApi();
    if (mode === 'amortized'
        && productRegistry
        && typeof productRegistry.supportsAmortizedMode === 'function'
        && !productRegistry.supportsAmortizedMode(state.underlyingSymbol)) {
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
    _runUiRefreshSafely('hedgeDerivedData', () => {
        OptionComboHedgeUI.applyHedgeDerivedData(derivedData, currencyFormatter);
    });
}

function applyHedgeRowDerivedData(row, hedgeResult) {
    if (!row || !hedgeResult) return;
    const hedgeUi = _getHedgeUiApi();
    if (hedgeUi && typeof hedgeUi.applyHedgeRowDerivedData === 'function') {
        _runUiRefreshSafely('hedgeRowDerivedData', () => {
            hedgeUi.applyHedgeRowDerivedData(row, hedgeResult, currencyFormatter);
        });
    }
}

function applyGroupDerivedData(card, groupResult) {
    _runUiRefreshSafely('groupDerivedData', () => {
        OptionComboGroupUI.applyGroupDerivedData(card, groupResult, currencyFormatter, {
            drawGroupChart,
            drawAmortizationChart,
        });
    });
}

function applyGroupDeltaSummary(card, groupResult) {
    if (!card || !groupResult) return;
    const groupUi = _getGroupUiApi();
    if (groupUi && typeof groupUi.applyGroupDeltaSummary === 'function') {
        _runUiRefreshSafely('groupDeltaSummary', () => {
            groupUi.applyGroupDeltaSummary(card, groupResult);
        });
    }
}

function applyGlobalDerivedData(derivedData) {
    _runUiRefreshSafely('globalDerivedData', () => {
        OptionComboGlobalUI.applyGlobalDerivedData(derivedData, currencyFormatter, {
            drawGlobalChart,
            drawGlobalAmortizedChart,
        });
    });
}

function _cachePortfolioDerivedData(derivedData) {
    _latestPortfolioDerivedData = derivedData || null;
    return derivedData;
}

function _syncWorkspaceChrome() {
    const sessionUi = _getSessionUiApi();
    if (sessionUi && typeof sessionUi.syncWorkspaceChrome === 'function') {
        _runUiRefreshSafely('workspaceChrome', () => {
            sessionUi.syncWorkspaceChrome(state);
        });
    }
}

function _scheduleImpliedLambdaRefresh() {
    if (state.simUseImpliedLambda !== true || state.simTimeBasis !== 'weighted') {
        _impliedLambdaRefreshRequested = false;
        return false;
    }

    _impliedLambdaRefreshRequested = true;
    if (typeof document !== 'undefined' && document.hidden === true) {
        return false;
    }
    if (_impliedLambdaRefreshPending) {
        return false;
    }

    _impliedLambdaRefreshPending = true;
    const runRefresh = () => {
        _impliedLambdaRefreshPending = false;
        if (!_impliedLambdaRefreshRequested
            || state.simUseImpliedLambda !== true
            || state.simTimeBasis !== 'weighted') {
            return;
        }
        if (typeof document !== 'undefined' && document.hidden === true) {
            return;
        }
        _impliedLambdaRefreshRequested = false;
        updateDerivedValues();
    };

    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(runRefresh);
    } else {
        runRefresh();
    }
    return true;
}

function _refreshSimTimeBasisUi() {
    const controlPanelUi = typeof OptionComboControlPanelUI !== 'undefined'
        ? OptionComboControlPanelUI
        : null;
    if (controlPanelUi && typeof controlPanelUi.refreshSimTimeBasisUi === 'function') {
        _runUiRefreshSafely('simTimeBasisUi', () => {
            controlPanelUi.refreshSimTimeBasisUi(state);
        });
    }
}

function _refreshSimulationDateUi() {
    const controlPanelUi = typeof OptionComboControlPanelUI !== 'undefined'
        ? OptionComboControlPanelUI
        : null;
    if (controlPanelUi && typeof controlPanelUi.refreshSimulationDateUi === 'function') {
        _runUiRefreshSafely('simulationDateUi', () => {
            controlPanelUi.refreshSimulationDateUi(state);
        });
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
    const deltaHedgeUi = _getDeltaHedgeUiApi();
    if (_pageHasFeature('deltaHedgePanel')
        && deltaHedgeUi
        && typeof deltaHedgeUi.applyRecommendationPreview === 'function') {
        _runUiRefreshSafely('deltaHedgeRecommendationPreview', () => {
            deltaHedgeUi.applyRecommendationPreview(state, derivedData);
        });
        if (typeof deltaHedgeUi.applyBrokerPreviewState === 'function') {
            _runUiRefreshSafely('deltaHedgeBrokerPreviewState', () => {
                deltaHedgeUi.applyBrokerPreviewState(state);
            });
        }
        _runUiRefreshSafely('deltaHedgeAutoSupervisor', () => {
            runDeltaHedgeAutoSupervisor(derivedData);
        });
    }
}

function _peekImpliedLambdaEntry() {
    const handoff = typeof OptionComboImpliedLambdaHandoff !== 'undefined'
        ? OptionComboImpliedLambdaHandoff
        : null;
    if (!handoff || state.marketDataMode === 'historical') {
        return null;
    }
    // Futures identity is symbol + contract month: a lambda surface solved on
    // a different underlying future must not be silently substituted.
    const expectedAnchorDate = String(state.liveQuoteDate || '').trim();
    // The live exchange trade date is part of the V2 identity.  Before the
    // first real quote establishes it, accepting a merely fresh entry would
    // let yesterday's (or another session's) surface leak into pricing.
    if (!expectedAnchorDate) {
        return null;
    }
    const storedEntry = handoff.peekSymbolEntry(
        state.underlyingSymbol,
        undefined,
        Date.now(),
        state.underlyingContractMonth,
        expectedAnchorDate
    );
    if (storedEntry) {
        // Once browser storage is demonstrably available, it is the live
        // source of truth. Do not resurrect an older portable file after a
        // later IVTS invalidation removes the stored surface.
        state.simImpliedLambdaFileEntry = null;
        return storedEntry;
    }

    // Loading a portable JSON file is an explicit request and must still
    // work when localStorage is unavailable (private browsing / blocked
    // storage). Keep the parsed entry in this tab as a fail-soft runtime
    // fallback. A stored IVTS publication wins whenever one is available.
    const runtimeEntry = typeof handoff.normalizeSymbolEntry === 'function'
        ? handoff.normalizeSymbolEntry(state.simImpliedLambdaFileEntry, Date.now())
        : null;
    const expectedSymbol = String(state.underlyingSymbol || '').trim().toUpperCase();
    const runtimeSymbol = String(runtimeEntry && runtimeEntry.symbol || '').trim().toUpperCase();
    const expectedKey = typeof handoff.entryStorageKey === 'function'
        ? handoff.entryStorageKey(expectedSymbol, state.underlyingContractMonth)
        : expectedSymbol;
    const runtimeKey = typeof handoff.entryStorageKey === 'function'
        ? handoff.entryStorageKey(runtimeSymbol, runtimeEntry && runtimeEntry.underlyingContractMonth)
        : runtimeSymbol;
    return expectedSymbol && runtimeKey === expectedKey
        && runtimeEntry.anchorDate === expectedAnchorDate
        ? runtimeEntry
        : null;
}

function _syncSimTimeBasisPricingConfig() {
    const pricingCore = typeof OptionComboPricingCore !== 'undefined' ? OptionComboPricingCore : null;
    const sessionLogic = typeof OptionComboSessionLogic !== 'undefined' ? OptionComboSessionLogic : null;
    if (!pricingCore
        || typeof pricingCore.configureSimTimeBasis !== 'function'
        || !sessionLogic
        || typeof sessionLogic.resolveSimWeekendWeight !== 'function') {
        return;
    }
    const impliedEntry = state.simUseImpliedLambda === true ? _peekImpliedLambdaEntry() : null;
    state.simImpliedLambdaEntry = impliedEntry;
    const pricingContext = typeof OptionComboPricingContext !== 'undefined'
        ? OptionComboPricingContext
        : null;
    state.simulationTiming = pricingContext
        && typeof pricingContext.resolveSimulationTiming === 'function'
        ? pricingContext.resolveSimulationTiming(state)
        : null;
    state.simImpliedLambdaCoverage = pricingContext
        && typeof pricingContext.assessProjectionLambdaCoverage === 'function'
        ? pricingContext.assessProjectionLambdaCoverage(state, impliedEntry)
        : null;
    const weekendWeight = typeof sessionLogic.resolveSimWeekendWeightSpec === 'function'
        ? sessionLogic.resolveSimWeekendWeightSpec(
            state.simTimeBasis,
            state.simWeekendWeight,
            state.simUseImpliedLambda,
            impliedEntry
        )
        : sessionLogic.resolveSimWeekendWeight(state.simTimeBasis, state.simWeekendWeight);
    pricingCore.configureSimTimeBasis({
        weekendWeight,
        observedTradingDates: state.marketDataMode === 'historical'
            ? state.historicalTradingDates
            : null,
    });
}

function updateDerivedValues() {
    _syncSimTimeBasisPricingConfig();
    const derivedData = _cachePortfolioDerivedData(
        OptionComboValuation.computePortfolioDerivedData(state)
    );
    _applyPortfolioDerivedData(derivedData, {
        syncWorkspaceChrome: true,
    });
    // _syncSimTimeBasisPricingConfig above may have accepted, replaced, or
    // expired a cross-tab V2 entry. Keep the visible status in the same full
    // refresh transaction as the pricing state.
    _refreshSimTimeBasisUi();
    // simulationTiming is recomputed at the start of this transaction. Keep
    // the Timeline target text aligned with the exact state used by valuation,
    // including rAF-throttled date-slider changes.
    _refreshSimulationDateUi();
    return derivedData;
}

function updateLiveQuoteDerivedValues(changeSet = {}) {
    const valuationApi = _getValuationApi();
    if (!_latestPortfolioDerivedData
        || !valuationApi
        || typeof valuationApi.computeGroupDerivedData !== 'function'
        || typeof valuationApi.computeHedgeDerivedData !== 'function'
        || typeof valuationApi.buildPortfolioDerivedDataFromResults !== 'function') {
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
        const nextGroupResult = valuationApi.computeGroupDerivedData(group, state);
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
        const nextHedgeResult = valuationApi.computeHedgeDerivedData(hedge);
        const existingIndex = nextHedgeResults.findIndex(result => result.id === hedgeId);
        if (existingIndex >= 0) {
            nextHedgeResults[existingIndex] = nextHedgeResult;
        } else {
            nextHedgeResults.push(nextHedgeResult);
        }
    });

    const derivedData = _cachePortfolioDerivedData(
        valuationApi.buildPortfolioDerivedDataFromResults(
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
    const deltaHedgeLogic = _getDeltaHedgeLogicApi();
    if (!_pageHasFeature('deltaHedgePanel')) {
        return null;
    }
    if (!deltaHedgeLogic || typeof deltaHedgeLogic.evaluateDeltaHedgeAutomation !== 'function') {
        return null;
    }
    if (!state.deltaHedge || typeof state.deltaHedge !== 'object') {
        return null;
    }

    const runtime = state.deltaHedge;
    const deltaHedgeUi = _getDeltaHedgeUiApi();
    const recommendation = runtime.lastRecommendation
        || (deltaHedgeUi
            && typeof deltaHedgeUi.applyRecommendationPreview === 'function'
            ? _runUiRefreshSafely(
                'deltaHedgeRecommendationPreview',
                () => deltaHedgeUi.applyRecommendationPreview(state, derivedData || {}),
                null
            )
            : null);
    const hasActiveRestingOrder = typeof deltaHedgeLogic.hasActiveRestingHedgeOrder === 'function'
        && deltaHedgeLogic.hasActiveRestingHedgeOrder(runtime);
    const now = new Date();
    let decision = deltaHedgeLogic.evaluateDeltaHedgeAutomation({
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
    if (decision && decision.action === 'submit') {
        const safety = typeof OptionComboOrderSafety !== 'undefined' ? OptionComboOrderSafety : null;
        if (!safety || typeof safety.buildHedgeIntent !== 'function' || typeof safety.analyzePositionImpact !== 'function') {
            decision = { ...decision, action: 'blocked', reason: 'order_safety_unavailable' };
        } else {
            const impact = safety.analyzePositionImpact(safety.buildHedgeIntent(state, recommendation), state);
            if (impact.available !== true) {
                decision = { ...decision, action: 'blocked', reason: 'position_snapshot_unavailable' };
            } else if ((impact.warnings || []).length > 0) {
                decision = { ...decision, action: 'blocked', reason: 'position_conflict_requires_confirmation' };
            }
        }
    }

    runtime.autoLastDecision = decision;
    runtime.autoStatus = decision.reason || decision.action || '';
    if (runtime.autoSubmitEnabled === true) {
        _appendDeltaHedgeAutoDecisionLog(decision, now);
    }
    if (deltaHedgeUi && typeof deltaHedgeUi.applyAutomationState === 'function') {
        _runUiRefreshSafely('deltaHedgeAutomationState', () => {
            deltaHedgeUi.applyAutomationState(state);
        });
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
            if (deltaHedgeUi && typeof deltaHedgeUi.applyAutomationState === 'function') {
                _runUiRefreshSafely('deltaHedgeAutomationState', () => {
                    deltaHedgeUi.applyAutomationState(state);
                });
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
            if (deltaHedgeUi && typeof deltaHedgeUi.applyAutomationState === 'function') {
                _runUiRefreshSafely('deltaHedgeAutomationState', () => {
                    deltaHedgeUi.applyAutomationState(state);
                });
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
    const valuationApi = _getValuationApi();
    if (!_latestPortfolioDerivedData
        || !valuationApi
        || typeof valuationApi.computeGroupDeltaSummary !== 'function') {
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
        const nextGroupDeltaSummary = valuationApi.computeGroupDeltaSummary(group, state);
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
        typeof valuationApi.buildPortfolioDerivedDataFromResults === 'function'
            ? valuationApi.buildPortfolioDerivedDataFromResults(
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

    const deltaHedgeUi = _getDeltaHedgeUiApi();
    if (_pageHasFeature('deltaHedgePanel')
        && deltaHedgeUi
        && typeof deltaHedgeUi.applyRecommendationPreview === 'function') {
        _runUiRefreshSafely('deltaHedgeRecommendationPreview', () => {
            deltaHedgeUi.applyRecommendationPreview(state, derivedData);
        });
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
let sessionHasFileTarget = false;

function _getJsonFilePickerTypes() {
    return [{
        description: 'JSON Files',
        accept: {
            'application/json': ['.json'],
        },
    }];
}

function _sanitizeSessionFileName(value) {
    const raw = String(value || '').trim();
    const cleaned = raw
        .replace(/\.json$/i, '')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || '';
}

function _resolveSuggestedSessionFileName(options = {}) {
    const importedName = _sanitizeSessionFileName(state.importedSessionTitle);
    if (importedName) {
        return `${importedName}${options.copy === true ? ' copy' : ''}.json`;
    }

    const symbol = _sanitizeSessionFileName(state.underlyingSymbol).toUpperCase();
    const datePart = String(state.simulatedDate || state.baseDate || new Date().toISOString().slice(0, 10)).trim();
    if (symbol) {
        return `${symbol}_${datePart}${options.copy === true ? '_copy' : ''}.json`;
    }
    return `option_combo_sim_${new Date().toISOString().slice(0, 10)}${options.copy === true ? '_copy' : ''}.json`;
}

function _hasSessionFileTarget() {
    return sessionHasFileTarget || !!currentFileHandle;
}

function _syncSessionFileActionButtons() {
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.style.display = 'inline-flex';
    }

    const saveAsBtn = document.getElementById('saveAsBtn');
    if (saveAsBtn) {
        saveAsBtn.style.display = _hasSessionFileTarget() ? 'inline-flex' : 'none';
    }
}

function _setSessionFileTarget(fileHandle, fileName = '') {
    currentFileHandle = fileHandle || null;
    sessionHasFileTarget = true;

    const resolvedName = typeof fileName === 'string' && fileName.trim()
        ? fileName.trim()
        : (currentFileHandle && typeof currentFileHandle.name === 'string' ? currentFileHandle.name.trim() : '');
    if (resolvedName) {
        state.importedSessionTitle = resolvedName;
    }

    _syncSessionFileActionButtons();
}

function _markSaveButtonSaved(saveBtn) {
    if (!saveBtn) {
        return;
    }
    const originalHTML = saveBtn.innerHTML;
    saveBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Saved!`;
    setTimeout(() => {
        saveBtn.innerHTML = originalHTML;
    }, 2000);
}

async function _writeSessionDataToFileHandle(fileHandle, dataStr, saveBtn) {
    if (!fileHandle || typeof fileHandle.createWritable !== 'function') {
        return false;
    }

    try {
        const writable = await fileHandle.createWritable();
        await writable.write(dataStr);
        await writable.close();
        _markSaveButtonSaved(saveBtn);
        return true;
    } catch (error) {
        console.error("Error saving directly to file:", error);
        return false;
    }
}

function _showManualSaveUnsupportedAlert() {
    const message = 'This browser cannot choose a save location for JSON files. Open the app in Chrome or Edge to use Save and Save As.';
    console.warn(message);
    if (typeof alert === 'function') {
        alert(message);
    }
}

async function _saveSessionToPickedFile(options = {}) {
    if (!window.showSaveFilePicker) {
        _showManualSaveUnsupportedAlert();
        return false;
    }

    try {
        const fileHandle = await window.showSaveFilePicker({
            suggestedName: _resolveSuggestedSessionFileName({ copy: options.copy === true }),
            types: _getJsonFilePickerTypes(),
        });
        const dataStr = JSON.stringify(OptionComboSessionLogic.buildExportState(state), null, 2);
        const saveBtn = document.getElementById('saveBtn');
        const saved = await _writeSessionDataToFileHandle(fileHandle, dataStr, saveBtn);
        if (!saved) {
            if (typeof alert === 'function') {
                alert('Unable to write the selected JSON file. Choose another location and try again.');
            }
            return false;
        }
        _setSessionFileTarget(fileHandle);
        return true;
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error("Error opening save picker:", error);
            if (typeof alert === 'function') {
                alert('Unable to open the save dialog. Choose another location and try again.');
            }
        }
        return false;
    }
}

async function handleImportBtnClick() {
    if (window.showOpenFilePicker) {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: _getJsonFilePickerTypes(),
                multiple: false
            });
            const file = await fileHandle.getFile();
            processImportedFile(file, { fileHandle });
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

    if (currentFileHandle) {
        const saved = await _writeSessionDataToFileHandle(currentFileHandle, dataStr, saveBtn);
        if (saved) {
            return true;
        }
        if (typeof alert === 'function') {
            alert('Unable to save back to the current JSON file. Use Save As to choose a writable copy.');
        }
        return false;
    }

    return _saveSessionToPickedFile({ copy: false });
}

async function saveAsJSON() {
    return _saveSessionToPickedFile({ copy: true });
}

function importFromJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

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
    // Live quote clocks are transport-derived runtime state. Never revive a
    // stale market date from a saved session.
    state.liveQuoteDate = '';
    state.liveQuoteAsOf = '';
    state.historicalAvailableStartDate = '';
    state.historicalAvailableEndDate = '';
    state.interestRate = normalizedState.interestRate;
    state.useMarketDiscountCurve = normalizedState.useMarketDiscountCurve !== false;
    state.discountCurve = normalizedState.discountCurve && typeof normalizedState.discountCurve === 'object'
        ? normalizedState.discountCurve
        : null;
    state.discountCurveLastError = '';
    state.discountCurveRequestPending = false;
    state.discountCurveRequestManual = false;
    state.discountCurveLastResponseStatus = '';
    state.discountCurveLastLoadedAt = '';
    state.discountCurveLastLoadWasManual = false;
    state.ivOffset = normalizedState.ivOffset;
    state.simTimeBasis = OptionComboSessionLogic.normalizeSimTimeBasis(normalizedState.simTimeBasis);
    state.simWeekendWeight = OptionComboSessionLogic.normalizeSimWeekendWeight(normalizedState.simWeekendWeight);
    state.simUseImpliedLambda = typeof OptionComboSessionLogic.normalizeSimUseImpliedLambda === 'function'
        ? OptionComboSessionLogic.normalizeSimUseImpliedLambda(normalizedState.simUseImpliedLambda)
        : normalizedState.simUseImpliedLambda !== false;
    // The data itself is runtime market state and must be reloaded from a
    // validated IVTS publication/file for the imported symbol. Never leak the
    // previous workspace's array into a newly imported session.
    state.simImpliedLambdaEntry = null;
    state.simImpliedLambdaFileEntry = null;
    state.simImpliedLambdaCoverage = null;
    state.simulationTiming = null;
    state.projectionConvergenceMode = typeof OptionComboSessionLogic.normalizeProjectionConvergenceMode === 'function'
        ? OptionComboSessionLogic.normalizeProjectionConvergenceMode(
            normalizedState.projectionConvergenceMode
        )
        : 'strict-bbo';
    state.liveProjectionFeedConnected = false;
    state.liveProjectionFeedStale = true;
    state.liveProjectionLastReceivedAt = '';
    // Exact live expiry cutoffs are an invariant, not an imported preference.
    state.requireExactContractTiming = true;
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

    const productRegistry = _getProductRegistryApi();
    if (!state.underlyingContractMonth
        && productRegistry
        && typeof productRegistry.resolveDefaultUnderlyingContractMonth === 'function') {
        state.underlyingContractMonth = productRegistry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            state.simulatedDate || state.baseDate
        );
    }
}

function _parseImportedJsonText(rawText) {
    const text = typeof rawText === 'string' ? rawText : '';
    // Windows-authored JSON files may include a UTF-8 BOM prefix.
    return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function processImportedFile(file, options = {}) {
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const importedState = _parseImportedJsonText(e && e.target ? e.target.result : '');

            if (importedState && typeof importedState === 'object') {
                const normalizedState = OptionComboSessionLogic.normalizeImportedState(
                    state,
                    importedState,
                    initialDateStr,
                    generateId,
                    addDays
                );

                applyImportedState(normalizedState, file && typeof file.name === 'string' ? file.name : '');
                _setSessionFileTarget(options.fileHandle || null, file && typeof file.name === 'string' ? file.name : '');
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
