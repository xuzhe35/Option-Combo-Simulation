const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBrowserScripts(relativePaths, overrides = {}) {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const scriptQueue = [];
    const seenPaths = new Set();
    for (const relativePath of relativePaths) {
        if (relativePath === 'js/market_holidays.js'
            && !Object.prototype.hasOwnProperty.call(overrides, 'OptionComboOfficialExchangeCalendars')
            && !seenPaths.has('js/official_exchange_calendars.generated.js')) {
            scriptQueue.push('js/official_exchange_calendars.generated.js');
            seenPaths.add('js/official_exchange_calendars.generated.js');
        }
        if ((relativePath === 'js/iv_term_structure_core.js'
            || relativePath === 'js/implied_lambda_handoff.js')
            && !seenPaths.has('js/market_holidays.js')) {
            if (!Object.prototype.hasOwnProperty.call(overrides, 'OptionComboOfficialExchangeCalendars')
                && !seenPaths.has('js/official_exchange_calendars.generated.js')) {
                scriptQueue.push('js/official_exchange_calendars.generated.js');
                seenPaths.add('js/official_exchange_calendars.generated.js');
            }
            scriptQueue.push('js/market_holidays.js');
            seenPaths.add('js/market_holidays.js');
        }
        if (['js/index_forward_rate.js', 'js/pricing_context.js', 'js/ws_client.js'].includes(relativePath)
            && !Object.prototype.hasOwnProperty.call(overrides, 'OptionComboMarketCurves')
            && !seenPaths.has('js/market_curves.js')) {
            scriptQueue.push('js/market_curves.js');
            seenPaths.add('js/market_curves.js');
        }
        if (relativePath === 'js/ws_client.js' && !seenPaths.has('js/combo_order_transport.js')) {
            scriptQueue.push('js/combo_order_transport.js');
            seenPaths.add('js/combo_order_transport.js');
        }
        if (relativePath === 'js/ws_client.js' && !seenPaths.has('js/delta_hedge_transport.js')) {
            scriptQueue.push('js/delta_hedge_transport.js');
            seenPaths.add('js/delta_hedge_transport.js');
        }
        if (!seenPaths.has(relativePath)) {
            scriptQueue.push(relativePath);
            seenPaths.add(relativePath);
        }
    }
    const context = vm.createContext({
        console,
        Math,
        Date,
        Intl,
        setTimeout,
        clearTimeout,
        ...overrides,
    });

    context.window = context;
    context.global = context;
    context.globalThis = context;

    for (const relativePath of scriptQueue) {
        const fullPath = path.join(projectRoot, relativePath);
        const code = fs.readFileSync(fullPath, 'utf8');
        const script = new vm.Script(code, { filename: fullPath });
        script.runInContext(context);
    }

    return context;
}

function loadPricingContext() {
    return loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/market_curves.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
        'js/pricing_core.js',
        'js/bsm.js',
    ]);
}

function loadAmortizedContext() {
    return loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/market_curves.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
        'js/pricing_core.js',
        'js/amortized.js',
    ]);
}

function loadValuationContext(overrides = {}) {
    return loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/market_curves.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
        'js/pricing_core.js',
        'js/amortized.js',
        'js/valuation.js',
    ], overrides);
}

function loadSessionLogicContext() {
    return loadBrowserScripts([
        'js/session_logic.js',
    ]);
}

function loadSessionUIContext(overrides = {}) {
    return loadBrowserScripts([
        'js/session_ui.js',
    ], overrides);
}

function createDomStub(options = {}) {
    const elements = options.elements || {};
    const listeners = {};
    const body = options.body || {
        dataset: { optionComboPage: options.pageKind || 'portfolio' },
        appendChild() {},
        removeChild() {},
    };

    const document = {
        title: '',
        activeElement: null,
        body,
        _listeners: listeners,
        addEventListener(type, handler) {
            listeners[type] = handler;
        },
        getElementById(id) {
            return Object.prototype.hasOwnProperty.call(elements, id)
                ? elements[id]
                : null;
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        createElement() {
            return {
                style: {},
                click() {},
                appendChild() {},
                remove() {},
            };
        },
    };

    return {
        document,
        elements,
        trigger(type) {
            if (typeof listeners[type] === 'function') {
                listeners[type]();
            }
        },
    };
}

function loadAppContext(options = {}) {
    const dom = createDomStub({
        elements: options.elements,
        body: options.body,
        pageKind: options.pageKind,
    });

    const callLog = {
        bindControlPanelEvents: [],
        bindDeltaHedgePanel: [],
        renderGroups: [],
        renderHedges: [],
        computePortfolioDerivedData: [],
        syncWorkspaceChrome: [],
        refreshSimTimeBasisUi: [],
        refreshSimulationDateUi: [],
        setInterval: [],
    };

    const overrides = {
        URL,
        URLSearchParams,
        requestAnimationFrame(callback) {
            callback();
            return 1;
        },
        setInterval(handler, delay) {
            callLog.setInterval.push({ handler, delay });
            return callLog.setInterval.length;
        },
        clearInterval() {},
        Blob: class Blob {
            constructor(parts, init = {}) {
                this.parts = parts;
                this.type = init.type || '';
            }
        },
        URL: {
            createObjectURL() {
                return 'blob:test';
            },
            revokeObjectURL() {},
        },
        FileReader: class FileReader {
            readAsText(file) {
                if (typeof this.onload === 'function') {
                    this.onload({ target: { result: file && file.__text || '' } });
                }
            }
        },
        alert() {},
        document: dom.document,
        location: {
            search: options.search || '',
        },
        OptionComboSessionLogic: {
            createDefaultDeltaHedgeConfig() {
                return { autoSubmitEnabled: false };
            },
            groupHasDeterministicCost(group) {
                return !!(group && group.hasDeterministicCost);
            },
            groupHasOpenPosition(group) {
                return !!(group && group.hasOpenPosition);
            },
            getRenderableGroupViewMode(group) {
                return group && group.viewMode ? group.viewMode : 'active';
            },
            isGroupIncludedInGlobal(group) {
                return group && group.includeInGlobal !== false;
            },
            resolveGroupViewModeChange(_group, mode) {
                return mode;
            },
            normalizeDeltaHedgeConfig(config) {
                return config && typeof config === 'object' ? config : {};
            },
            normalizeImportedState(_state, importedState) {
                return importedState;
            },
            normalizeSimTimeBasis(value) {
                const normalized = String(value || '').trim().toLowerCase();
                return ['calendar', 'trading', 'weighted'].includes(normalized) ? normalized : 'calendar';
            },
            normalizeSimWeekendWeight(value) {
                const parsed = parseFloat(value);
                return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.3;
            },
            normalizeSimUseImpliedLambda(value) {
                return value !== false;
            },
            normalizeProjectionConvergenceMode(value) {
                return String(value || '').trim().toLowerCase() === 'legacy-input-iv'
                    ? 'legacy-input-iv'
                    : 'strict-bbo';
            },
            resolveSimWeekendWeight(basis, weight) {
                if (basis === 'trading') return 0;
                if (basis === 'weighted') {
                    const parsed = parseFloat(weight);
                    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.3;
                }
                return 1;
            },
            buildExportState(state) {
                return JSON.parse(JSON.stringify(state));
            },
        },
        OptionComboValuation: {
            isSettlementScenarioMode(viewMode) {
                return viewMode === 'settlement';
            },
            computePortfolioDerivedData(state) {
                callLog.computePortfolioDerivedData.push(state);
                return {
                    groupResults: [],
                    hedgeResults: [],
                    groupResultsById: new Map(),
                    hedgeResultsById: new Map(),
                };
            },
            computeGroupDerivedData(group) {
                return { id: group.id };
            },
            computeHedgeDerivedData(hedge) {
                return { id: hedge.id };
            },
            buildPortfolioDerivedDataFromResults() {
                return {
                    groupResults: [],
                    hedgeResults: [],
                    groupResultsById: new Map(),
                    hedgeResultsById: new Map(),
                };
            },
            computeGroupDeltaSummary(group) {
                return { id: group.id };
            },
        },
        OptionComboProductRegistry: {
            resolveUnderlyingProfile(symbol) {
                return {
                    family: symbol === 'ES' ? 'ES' : 'DEFAULT_EQUITY',
                    underlyingSecType: symbol === 'ES' ? 'FUT' : 'STK',
                    supportsAmortized: symbol !== 'CL',
                    supportsUnderlyingLegs: true,
                };
            },
            supportsAmortizedMode(symbol) {
                return symbol !== 'CL';
            },
            supportsUnderlyingLegs() {
                return true;
            },
            resolveDefaultUnderlyingContractMonth(symbol, dateText) {
                return symbol === 'ES' ? '202606' : `stub_${String(dateText || '').replace(/-/g, '')}`;
            },
        },
        OptionComboPageCapabilities: {
            hasFeature(featureName) {
                if (Object.prototype.hasOwnProperty.call(options.features || {}, featureName)) {
                    return options.features[featureName];
                }
                return featureName === 'deltaHedgePanel';
            },
        },
        OptionComboControlPanelUI: {
            bindControlPanelEvents(state, formatter, deps) {
                callLog.bindControlPanelEvents.push({ state, formatter, deps });
            },
            refreshSimTimeBasisUi(state) {
                callLog.refreshSimTimeBasisUi.push(state);
            },
            refreshSimulationDateUi(state) {
                callLog.refreshSimulationDateUi.push(state);
            },
            toggleSidebar() {},
        },
        OptionComboDeltaHedgeUI: {
            bindDeltaHedgePanel(state, deps) {
                callLog.bindDeltaHedgePanel.push({ state, deps });
            },
            applyRecommendationPreview() {
                return null;
            },
            applyBrokerPreviewState() {},
            applyAutomationState() {},
        },
        OptionComboGroupEditorUI: {
            addGroup() {},
            removeGroup() {},
            addLegToGroupById() {},
            addLegToGroup() {},
            removeLeg() {},
            renderGroups(state, deps) {
                callLog.renderGroups.push({ state, deps });
            },
            toggleGroupCollapse() {},
        },
        OptionComboHedgeEditorUI: {
            addHedge() {},
            removeHedge() {},
            renderHedges(state, deps) {
                callLog.renderHedges.push({ state, deps });
            },
        },
        OptionComboHedgeUI: {
            applyHedgeDerivedData() {},
            applyHedgeRowDerivedData() {},
        },
        OptionComboGroupUI: {
            applyGroupDerivedData() {},
            applyGroupDeltaSummary() {},
        },
        OptionComboGlobalUI: {
            applyGlobalDerivedData() {},
        },
        OptionComboSessionUI: {
            syncWorkspaceChrome(state) {
                callLog.syncWorkspaceChrome.push(state);
            },
            syncControlPanel() {},
        },
        OptionComboAmortized: {
            calculateAmortizedCost() {
                return 0;
            },
            calculateCombinedAmortizedCost() {
                return 0;
            },
        },
        handleLiveSubscriptions() {},
        requestManagedAccountsSnapshot() {},
        settleHistoricalReplayGroups() {
            return 0;
        },
        requestPortfolioAvgCostSnapshot() {},
        requestContinueManagedComboOrder() {},
        requestConcedeManagedComboOrder() {},
        requestCancelManagedComboOrder() {},
        requestCloseGroupComboOrder() {
            return false;
        },
        requestHistoricalReplayEntryGroup() {
            return false;
        },
        requestHistoricalReplayExpirySettlementSync() {
            return false;
        },
        requestDeltaHedgeBrokerPreview() {
            return false;
        },
        requestDeltaHedgeSubmit() {
            return false;
        },
        requestDeltaHedgeCancel() {
            return false;
        },
        addDays(baseDate) {
            return baseDate;
        },
        diffDays() {
            return 0;
        },
        calendarToTradingDays() {
            return 0;
        },
        updateProbCharts() {},
        triggerChartRedraw() {},
        drawGroupChart() {},
        drawAmortizationChart() {},
        drawGlobalChart() {},
        drawGlobalAmortizedChart() {},
        ...options.overrides,
    };

    const context = loadBrowserScripts([
        'js/app.js',
    ], overrides);

    return {
        context,
        dom,
        callLog,
        triggerDomReady() {
            dom.trigger('DOMContentLoaded');
        },
    };
}

module.exports = {
    loadBrowserScripts,
    loadPricingContext,
    loadAmortizedContext,
    loadValuationContext,
    loadSessionLogicContext,
    loadSessionUIContext,
    loadAppContext,
};
