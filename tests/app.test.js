const assert = require('node:assert/strict');

const { loadAppContext, loadBrowserScripts } = require('./helpers/load-browser-scripts');

function createSaveButtonElements() {
    return {
        saveBtn: { style: {}, innerHTML: 'Save' },
        saveAsBtn: { style: {}, innerHTML: 'Save As' },
    };
}

function createWritableFileHandle(name, writes) {
    return {
        name,
        async createWritable() {
            return {
                async write(text) {
                    writes.push(text);
                },
                async close() {},
            };
        },
    };
}

function createImportedSession(overrides = {}) {
    return {
        underlyingSymbol: 'SPY',
        underlyingContractMonth: '',
        underlyingPrice: 501.25,
        baseDate: '2026-05-01',
        simulatedDate: '2026-05-02',
        marketDataMode: 'live',
        historicalQuoteDate: '',
        interestRate: 0.03,
        ivOffset: 0,
        greeksEnabled: false,
        deltaHedge: {},
        primaryControlPanelCollapsed: false,
        allowLiveComboOrders: false,
        allowLiveHedgeOrders: false,
        liveComboOrderAccounts: [],
        liveComboOrderAccountsConnected: false,
        selectedLiveComboOrderAccount: '',
        forwardRateSamples: [],
        futuresPool: [],
        groups: [],
        hedges: [],
        ...overrides,
    };
}

module.exports = {
    name: 'app.js',
    tests: [
        {
            name: 'resolves bootstrap runtime config and initial state from query params',
            run() {
                const { context } = loadAppContext({
                    search: '?entry=historical&lockMarketDataMode=1',
                });

                assert.equal(context.OptionComboRuntimeConfig.marketDataMode, 'historical');
                assert.equal(context.OptionComboRuntimeConfig.workspaceVariant, 'historical');
                assert.equal(context.OptionComboRuntimeConfig.marketDataModeLocked, true);

                const state = context.__optionComboApp.getState();
                assert.equal(state.marketDataMode, 'historical');
                assert.equal(state.workspaceVariant, 'historical');
                assert.equal(state.marketDataModeLocked, true);
                assert.equal(state.requireExactContractTiming, true);
                assert.equal(state.projectionConvergenceMode, 'best-effort-input-iv');
            },
        },
        {
            name: 'bootstraps DOMContentLoaded with app orchestration hooks',
            run() {
                const harness = loadAppContext({
                    features: {
                        deltaHedgePanel: true,
                    },
                });

                harness.triggerDomReady();

                assert.equal(harness.callLog.bindControlPanelEvents.length, 1);
                assert.equal(harness.callLog.renderGroups.length, 1);
                assert.equal(harness.callLog.renderHedges.length, 1);
                assert.equal(harness.callLog.computePortfolioDerivedData.length, 1);
                assert.equal(harness.callLog.syncWorkspaceChrome.length, 1);
                assert.equal(harness.callLog.refreshSimTimeBasisUi.length, 1);
                assert.equal(harness.callLog.refreshSimulationDateUi.length, 1);
                assert.equal(harness.callLog.bindDeltaHedgePanel.length, 1);
                assert.deepEqual(harness.callLog.setInterval.map(item => item.delay), [5000]);
            },
        },
        {
            name: 'refreshes the visible pricing target after simulation timing is recomputed',
            run() {
                let boundDeps = null;
                const timelineRefreshes = [];
                const harness = loadAppContext({
                    overrides: {
                        OptionComboPricingContext: {
                            resolveSimulationTiming(state) {
                                return {
                                    available: true,
                                    status: 'ok',
                                    targetAsOf: `${state.simulatedDate}T20:00:00.000Z`,
                                    source: 'product-profile-cutoff',
                                };
                            },
                            assessProjectionLambdaCoverage() {
                                return null;
                            },
                        },
                        OptionComboPricingCore: {
                            configureSimTimeBasis() {},
                        },
                        OptionComboControlPanelUI: {
                            bindControlPanelEvents(_state, _formatter, deps) {
                                boundDeps = deps;
                            },
                            refreshSimTimeBasisUi() {},
                            refreshSimulationDateUi(state) {
                                timelineRefreshes.push({
                                    simulatedDate: state.simulatedDate,
                                    targetAsOf: state.simulationTiming
                                        && state.simulationTiming.targetAsOf,
                                });
                            },
                            toggleSidebar() {},
                        },
                    },
                });

                harness.triggerDomReady();
                const state = harness.context.__optionComboApp.getState();
                state.simulatedDate = '2026-07-27';
                boundDeps.updateDerivedValues();

                assert.deepEqual(timelineRefreshes.at(-1), {
                    simulatedDate: '2026-07-27',
                    targetAsOf: '2026-07-27T20:00:00.000Z',
                });
            },
        },
        {
            name: 'initializes session file actions with Save visible and Save As hidden',
            run() {
                const elements = createSaveButtonElements();
                elements.saveBtn.style.display = 'none';
                elements.saveAsBtn.style.display = 'inline-flex';

                const harness = loadAppContext({ elements });
                harness.triggerDomReady();

                assert.equal(elements.saveBtn.style.display, 'inline-flex');
                assert.equal(elements.saveAsBtn.style.display, 'none');
                const fileTargetState = harness.context.__optionComboApp.getSessionFileTargetState();
                assert.equal(fileTargetState.hasFileTarget, false);
                assert.equal(fileTargetState.hasWritableFileHandle, false);
                assert.equal(harness.context.exportToJSON, undefined);
            },
        },
        {
            name: 'Save chooses a JSON location when no session file is bound',
            async run() {
                const elements = createSaveButtonElements();
                const writes = [];
                let pickerOptions = null;
                const fileHandle = createWritableFileHandle('Fresh Session.json', writes);
                const harness = loadAppContext({
                    elements,
                    overrides: {
                        showSaveFilePicker(options) {
                            pickerOptions = options;
                            return Promise.resolve(fileHandle);
                        },
                        setTimeout(callback) {
                            callback();
                            return 1;
                        },
                    },
                });

                harness.triggerDomReady();
                const saved = await harness.context.saveToJSON();

                assert.equal(saved, true);
                assert.ok(pickerOptions);
                assert.match(pickerOptions.suggestedName, /\.json$/);
                assert.doesNotMatch(pickerOptions.suggestedName, /copy/i);
                assert.equal(JSON.parse(writes[0]).underlyingSymbol, 'SPY');
                assert.equal(harness.context.__optionComboApp.getState().importedSessionTitle, 'Fresh Session.json');
                const fileTargetState = harness.context.__optionComboApp.getSessionFileTargetState();
                assert.equal(fileTargetState.hasFileTarget, true);
                assert.equal(fileTargetState.hasWritableFileHandle, true);
                assert.equal(elements.saveAsBtn.style.display, 'inline-flex');
            },
        },
        {
            name: 'Save As appears after import and suggests a copy filename',
            async run() {
                const elements = createSaveButtonElements();
                const writes = [];
                let pickerOptions = null;
                const fileHandle = createWritableFileHandle('SPY Session copy.json', writes);
                const harness = loadAppContext({
                    elements,
                    overrides: {
                        showSaveFilePicker(options) {
                            pickerOptions = options;
                            return Promise.resolve(fileHandle);
                        },
                        setTimeout(callback) {
                            callback();
                            return 1;
                        },
                    },
                });

                harness.triggerDomReady();
                harness.context.processImportedFile({
                    name: 'SPY Session.json',
                    __text: JSON.stringify(createImportedSession()),
                });

                assert.equal(elements.saveAsBtn.style.display, 'inline-flex');
                const importedFileTargetState = harness.context.__optionComboApp.getSessionFileTargetState();
                assert.equal(importedFileTargetState.hasFileTarget, true);
                assert.equal(importedFileTargetState.hasWritableFileHandle, false);

                const saved = await harness.context.saveAsJSON();

                assert.equal(saved, true);
                assert.equal(pickerOptions.suggestedName, 'SPY Session copy.json');
                assert.equal(JSON.parse(writes[0]).underlyingPrice, 501.25);
                assert.equal(harness.context.__optionComboApp.getState().importedSessionTitle, 'SPY Session copy.json');
                const savedFileTargetState = harness.context.__optionComboApp.getSessionFileTargetState();
                assert.equal(savedFileTargetState.hasFileTarget, true);
                assert.equal(savedFileTargetState.hasWritableFileHandle, true);
            },
        },
        {
            name: 'skips delta hedge panel bootstrap when capability is disabled',
            run() {
                const harness = loadAppContext({
                    features: {
                        deltaHedgePanel: false,
                    },
                });

                harness.triggerDomReady();

                assert.equal(harness.callLog.bindControlPanelEvents.length, 1);
                assert.equal(harness.callLog.bindDeltaHedgePanel.length, 0);
            },
        },
        {
            name: 'bootstraps DOMContentLoaded without optional delta hedge page modules',
            run() {
                const harness = loadAppContext({
                    overrides: {
                        OptionComboPageCapabilities: undefined,
                        OptionComboDeltaHedgeUI: undefined,
                    },
                });

                assert.doesNotThrow(() => {
                    harness.triggerDomReady();
                });

                assert.equal(harness.callLog.bindControlPanelEvents.length, 1);
                assert.equal(harness.callLog.bindDeltaHedgePanel.length, 0);
            },
        },
        {
            name: 'falls back to full derived recompute when incremental valuation helpers are unavailable',
            run() {
                const harness = loadAppContext({
                    overrides: {
                        OptionComboValuation: {
                            isSettlementScenarioMode(viewMode) {
                                return viewMode === 'settlement';
                            },
                            computePortfolioDerivedData(state) {
                                harness.callLog.computePortfolioDerivedData.push(state);
                                return {
                                    groupResults: [],
                                    hedgeResults: [],
                                    groupResultsById: new Map(),
                                    hedgeResultsById: new Map(),
                                };
                            },
                        },
                    },
                });

                harness.triggerDomReady();
                assert.equal(harness.callLog.computePortfolioDerivedData.length, 1);

                const derivedData = harness.context.__optionComboApp.updateLiveQuoteDerivedValues({
                    groupIds: ['group_1'],
                });

                assert.ok(derivedData);
                assert.equal(harness.callLog.computePortfolioDerivedData.length, 2);
            },
        },
        {
            name: 'continues bootstrap when workspace chrome sync throws',
            run() {
                const harness = loadAppContext({
                    overrides: {
                        OptionComboSessionUI: {
                            syncWorkspaceChrome() {
                                throw new Error('workspace chrome exploded');
                            },
                            syncControlPanel() {},
                        },
                    },
                });

                assert.doesNotThrow(() => {
                    harness.triggerDomReady();
                });

                assert.equal(harness.callLog.bindControlPanelEvents.length, 1);
                assert.equal(harness.callLog.computePortfolioDerivedData.length, 1);
            },
        },
        {
            name: 'continues derived refresh when delta hedge panel rendering throws',
            run() {
                const harness = loadAppContext({
                    features: {
                        deltaHedgePanel: true,
                    },
                    overrides: {
                        OptionComboDeltaHedgeUI: {
                            bindDeltaHedgePanel(state, deps) {
                                harness.callLog.bindDeltaHedgePanel.push({ state, deps });
                            },
                            applyRecommendationPreview() {
                                throw new Error('preview render exploded');
                            },
                            applyBrokerPreviewState() {
                                throw new Error('broker preview render exploded');
                            },
                            applyAutomationState() {},
                        },
                    },
                });

                assert.doesNotThrow(() => {
                    harness.triggerDomReady();
                });

                assert.equal(harness.callLog.bindControlPanelEvents.length, 1);
                assert.equal(harness.callLog.computePortfolioDerivedData.length, 1);
                assert.equal(harness.callLog.bindDeltaHedgePanel.length, 1);
            },
        },
        {
            name: 'requests implied lambda for the exact futures month and live quote anchor',
            run() {
                const peekCalls = [];
                const configured = [];
                const matchedEntry = {
                    symbol: 'ES',
                    underlyingContractMonth: '202606',
                    anchorDate: '2026-05-06',
                    varianceSource: 'straddle',
                    quality: { status: 'ok' },
                    byDate: { '2026-05-09': 0.2 },
                };
                const harness = loadAppContext({
                    overrides: {
                        OptionComboPricingCore: {
                            configureSimTimeBasis(config) {
                                configured.push(config);
                            },
                        },
                        OptionComboImpliedLambdaHandoff: {
                            peekSymbolEntry(...args) {
                                peekCalls.push(args);
                                return matchedEntry;
                            },
                            entryStorageKey(symbol, month) {
                                return month ? `${symbol}#${month}` : symbol;
                            },
                            normalizeSymbolEntry() {
                                return null;
                            },
                        },
                    },
                });
                const state = harness.context.__optionComboApp.getState();
                state.underlyingSymbol = 'ES';
                state.underlyingContractMonth = '202606';
                state.liveQuoteDate = '2026-05-06';
                state.simUseImpliedLambda = true;

                harness.context.__optionComboApp.updateLiveQuoteDerivedValues();
                assert.equal(peekCalls.length, 1);
                assert.equal(peekCalls[0][0], 'ES');
                assert.equal(peekCalls[0][3], '202606');
                assert.equal(peekCalls[0][4], '2026-05-06');
                assert.equal(state.simImpliedLambdaEntry, matchedEntry);
                assert.equal(configured.length, 1);
            },
        },
        {
            name: 'fails closed on implied lambda until the first live quote establishes an anchor date',
            run() {
                let peekCount = 0;
                const harness = loadAppContext({
                    overrides: {
                        OptionComboPricingCore: { configureSimTimeBasis() {} },
                        OptionComboImpliedLambdaHandoff: {
                            peekSymbolEntry() {
                                peekCount += 1;
                                return { symbol: 'SPY', anchorDate: '2026-05-06' };
                            },
                        },
                    },
                });
                const state = harness.context.__optionComboApp.getState();
                state.underlyingSymbol = 'SPY';
                state.liveQuoteDate = '';
                state.simUseImpliedLambda = true;
                state.simImpliedLambdaFileEntry = {
                    symbol: 'SPY', anchorDate: '2026-05-06', byDate: { '2026-05-09': 0.2 },
                };

                harness.context.__optionComboApp.updateLiveQuoteDerivedValues();
                assert.equal(peekCount, 0);
                assert.equal(state.simImpliedLambdaEntry, null);
            },
        },
        {
            name: 'does not poll frozen implied-lambda entries for wall-clock expiry',
            run() {
                let storedEntry = {
                    symbol: 'SPY', anchorDate: '2026-05-06', snapshotId: 'fresh-1',
                    varianceSource: 'straddle', quality: { status: 'ok' },
                    byDate: { '2026-05-09': 0.2 },
                };
                const harness = loadAppContext({
                    overrides: {
                        OptionComboPricingCore: {
                            configureSimTimeBasis() {},
                        },
                        OptionComboImpliedLambdaHandoff: {
                            STORAGE_KEY: 'optionComboImpliedLambdaV2',
                            peekSymbolEntry() {
                                return storedEntry;
                            },
                            normalizeSymbolEntry(input) {
                                return input || null;
                            },
                            entryStorageKey(symbol, month) {
                                return month ? `${symbol}#${month}` : symbol;
                            },
                        },
                    },
                });
                const state = harness.context.__optionComboApp.getState();
                state.underlyingSymbol = 'SPY';
                state.liveQuoteDate = '2026-05-06';
                state.simTimeBasis = 'weighted';
                state.simUseImpliedLambda = true;

                harness.context.__optionComboApp.updateLiveQuoteDerivedValues();
                assert.equal(state.simImpliedLambdaEntry, storedEntry);
                assert.equal(state.simImpliedLambdaFileEntry, null);
                harness.triggerDomReady();

                const freshnessTimer = harness.callLog.setInterval.find((item) => item.delay === 15000);
                assert.equal(freshnessTimer, undefined);
                assert.equal(state.simImpliedLambdaEntry, storedEntry);
            },
        },
        {
            name: 'coalesces same-origin implied lambda syncs and defers hidden-tab valuation',
            run() {
                const windowListeners = {};
                const rafCallbacks = [];
                const entry = {
                    symbol: 'SPY', anchorDate: '2026-05-06', snapshotId: 'manual-1',
                    varianceSource: 'straddle', quality: { status: 'ok' },
                    byDate: { '2026-05-09': 0.2 },
                };
                const harness = loadAppContext({
                    overrides: {
                        addEventListener(type, handler) {
                            windowListeners[type] = handler;
                        },
                        requestAnimationFrame(callback) {
                            rafCallbacks.push(callback);
                            return rafCallbacks.length;
                        },
                        OptionComboPricingCore: { configureSimTimeBasis() {} },
                        OptionComboImpliedLambdaHandoff: {
                            STORAGE_KEY: 'optionComboImpliedLambdaV2',
                            peekSymbolEntry() {
                                return entry;
                            },
                            entryStorageKey(symbol) {
                                return symbol;
                            },
                            normalizeSymbolEntry() {
                                return null;
                            },
                        },
                    },
                });
                const state = harness.context.__optionComboApp.getState();
                state.underlyingSymbol = 'SPY';
                state.liveQuoteDate = '2026-05-06';
                state.simTimeBasis = 'weighted';
                state.simUseImpliedLambda = true;

                assert.equal(typeof windowListeners.storage, 'function');
                const before = harness.callLog.computePortfolioDerivedData.length;
                windowListeners.storage({ key: 'optionComboImpliedLambdaV2' });
                windowListeners.storage({ key: 'optionComboImpliedLambdaV2' });
                assert.equal(rafCallbacks.length, 1);
                assert.equal(harness.callLog.computePortfolioDerivedData.length, before);
                rafCallbacks.shift()();
                assert.equal(harness.callLog.computePortfolioDerivedData.length, before + 1);

                harness.dom.document.hidden = true;
                windowListeners.storage({ key: 'optionComboImpliedLambdaV2' });
                assert.equal(rafCallbacks.length, 0);
                assert.equal(harness.callLog.computePortfolioDerivedData.length, before + 1);

                harness.dom.document.hidden = false;
                harness.dom.trigger('visibilitychange');
                assert.equal(rafCallbacks.length, 1);
                rafCallbacks.shift()();
                assert.equal(harness.callLog.computePortfolioDerivedData.length, before + 2);
            },
        },
        {
            name: 'applyImportedState fills missing futures contract month from product registry',
            run() {
                const { context } = loadAppContext();
                context.__optionComboApp.getState().simImpliedLambdaEntry = {
                    symbol: 'SPY',
                    byDate: { '2026-05-02': 0.2 },
                };

                context.applyImportedState({
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '',
                    underlyingPrice: 5300,
                    baseDate: '2026-05-01',
                    simulatedDate: '2026-05-07',
                    marketDataMode: 'live',
                    historicalQuoteDate: '',
                    liveQuoteDate: '2026-05-06',
                    liveQuoteAsOf: '2026-05-06T20:00:00Z',
                    interestRate: 0.03,
                    ivOffset: 0,
                    simTimeBasis: 'weighted',
                    simWeekendWeight: 0.3,
                    simUseImpliedLambda: true,
                    greeksEnabled: false,
                    deltaHedge: {},
                    primaryControlPanelCollapsed: false,
                    allowLiveComboOrders: false,
                    allowLiveHedgeOrders: false,
                    liveComboOrderAccounts: [],
                    liveComboOrderAccountsConnected: false,
                    selectedLiveComboOrderAccount: '',
                    forwardRateSamples: [],
                    futuresPool: [],
                    groups: [],
                    hedges: [],
                });

                const state = context.__optionComboApp.getState();
                assert.equal(state.underlyingSymbol, 'ES');
                assert.equal(state.underlyingContractMonth, '202606');
                assert.equal(state.underlyingPrice, 5300);
                assert.equal(state.liveQuoteDate, '');
                assert.equal(state.liveQuoteAsOf, '');
                assert.equal(state.simUseImpliedLambda, true);
                assert.equal(state.simImpliedLambdaEntry, null);
                assert.equal(state.requireExactContractTiming, true);
                assert.equal(state.projectionConvergenceMode, 'best-effort-input-iv');
            },
        },
        {
            name: 'does not import a contract-timing safety opt-out',
            run() {
                const { context } = loadAppContext();
                context.applyImportedState(createImportedSession({
                    requireExactContractTiming: false,
                    projectionConvergenceMode: 'legacy-input-iv',
                }));
                assert.equal(
                    context.__optionComboApp.getState().requireExactContractTiming,
                    true
                );
                assert.equal(
                    context.__optionComboApp.getState().projectionConvergenceMode,
                    'best-effort-input-iv'
                );
            },
        },
        {
            name: 'applyImportedState tolerates missing product registry for contract-month fallback',
            run() {
                const { context } = loadAppContext({
                    overrides: {
                        OptionComboProductRegistry: undefined,
                    },
                });

                assert.doesNotThrow(() => {
                    context.applyImportedState({
                        underlyingSymbol: 'ES',
                        underlyingContractMonth: '',
                        underlyingPrice: 5300,
                        baseDate: '2026-05-01',
                        simulatedDate: '2026-05-07',
                        marketDataMode: 'live',
                        historicalQuoteDate: '',
                        interestRate: 0.03,
                        ivOffset: 0,
                        greeksEnabled: false,
                        deltaHedge: {},
                        primaryControlPanelCollapsed: false,
                        allowLiveComboOrders: false,
                        allowLiveHedgeOrders: false,
                        liveComboOrderAccounts: [],
                        liveComboOrderAccountsConnected: false,
                        selectedLiveComboOrderAccount: '',
                        forwardRateSamples: [],
                        futuresPool: [],
                        groups: [],
                        hedges: [],
                    });
                });

                const state = context.__optionComboApp.getState();
                assert.equal(state.underlyingSymbol, 'ES');
                assert.equal(state.underlyingContractMonth, '');
            },
        },
        {
            name: 'processImportedFile accepts UTF-8 BOM prefixed json',
            run() {
                const alerts = [];
                const harness = loadAppContext({
                    overrides: {
                        alert(message) {
                            alerts.push(message);
                        },
                    },
                });

                harness.context.processImportedFile({
                    name: 'SPY Session.json',
                    __text: '\uFEFF' + JSON.stringify({
                        underlyingSymbol: 'SPY',
                        underlyingContractMonth: '',
                        underlyingPrice: 501.25,
                        baseDate: '2026-05-01',
                        simulatedDate: '2026-05-02',
                        marketDataMode: 'live',
                        historicalQuoteDate: '',
                        interestRate: 0.03,
                        ivOffset: 0,
                        greeksEnabled: false,
                        deltaHedge: {},
                        primaryControlPanelCollapsed: false,
                        allowLiveComboOrders: false,
                        allowLiveHedgeOrders: false,
                        liveComboOrderAccounts: [],
                        liveComboOrderAccountsConnected: false,
                        selectedLiveComboOrderAccount: '',
                        forwardRateSamples: [],
                        futuresPool: [],
                        groups: [],
                        hedges: [],
                    }),
                });

                assert.deepEqual(alerts, []);
                const state = harness.context.__optionComboApp.getState();
                assert.equal(state.underlyingSymbol, 'SPY');
                assert.equal(state.underlyingPrice, 501.25);
                assert.equal(state.importedSessionTitle, 'SPY Session.json');
                assert.equal(harness.callLog.renderGroups.length, 1);
                assert.equal(harness.callLog.renderHedges.length, 1);
            },
        },
        {
            name: 'consumes a pending calendar handoff into a combo group on startup',
            run() {
                const takeCalls = [];
                const harness = loadAppContext({
                    overrides: {
                        OptionComboCalendarHandoff: {
                            takeHandoffPayload() {
                                takeCalls.push(true);
                                return {
                                    version: 1,
                                    symbol: 'ES',
                                    underlyingPrice: 6010.25,
                                    underlyingContractMonth: '202609',
                                    underlyingFuture: {
                                        contractMonth: '202609',
                                        conId: 12345,
                                        localSymbol: 'ESU6',
                                        exchange: 'CME',
                                        currency: 'USD',
                                        quoteAsOf: '2026-06-12T15:00:00Z',
                                        mark: 6010.25,
                                    },
                                    shortExpiry: '20260630',
                                    longExpiry: '20260720',
                                    shortStrike: 6010,
                                    longStrike: 6015,
                                };
                            },
                            buildGroupName(payload) {
                                return `${payload.symbol} Calendar ${payload.shortExpiry}/${payload.longExpiry}`;
                            },
                            buildCalendarLegs(payload, generateId, underlyingFutureId) {
                                return [
                                    { id: generateId(), pos: -1, type: 'call', underlyingFutureId },
                                    { id: generateId(), pos: -1, type: 'put', underlyingFutureId },
                                    { id: generateId(), pos: 1, type: 'call', underlyingFutureId },
                                    { id: generateId(), pos: 1, type: 'put', underlyingFutureId },
                                ];
                            },
                        },
                        OptionComboGroupEditorUI: {
                            addGroup(state, generateId) {
                                state.groups.push({
                                    id: generateId(),
                                    name: `Combo Group ${state.groups.length + 1}`,
                                    legs: [{ id: generateId() }],
                                });
                            },
                            removeGroup() {},
                            addLegToGroupById() {},
                            addLegToGroup() {},
                            removeLeg() {},
                            renderGroups() {},
                            toggleGroupCollapse() {},
                        },
                    },
                });

                harness.triggerDomReady();

                assert.equal(takeCalls.length, 1);
                const state = harness.context.__optionComboApp.getState();
                assert.equal(state.underlyingSymbol, 'ES');
                assert.equal(state.underlyingPrice, 6010.25);
                assert.equal(state.underlyingContractMonth, '202609');
                assert.equal(state.futuresPool.length, 1);
                assert.equal(state.futuresPool[0].contractMonth, '202609');
                assert.equal(state.futuresPool[0].conId, 12345);
                assert.equal(state.groups.length, 1);
                assert.equal(state.groups[0].name, 'ES Calendar 20260630/20260720');
                assert.equal(state.groups[0].legs.length, 4);
                assert.equal(state.groups[0].liveData, true);
                assert.equal(state.groups[0].legs[0].underlyingFutureId, state.futuresPool[0].id);
                assert.deepEqual(Array.from(state.groups[0].legs, (leg) => leg.pos), [-1, -1, 1, 1]);
            },
        },
        {
            name: 'boots normally when no calendar handoff is pending',
            run() {
                const harness = loadAppContext({
                    overrides: {
                        OptionComboCalendarHandoff: {
                            takeHandoffPayload() {
                                return null;
                            },
                        },
                    },
                });

                harness.triggerDomReady();

                const state = harness.context.__optionComboApp.getState();
                assert.equal(state.underlyingSymbol, 'SPY');
                assert.equal(state.groups.length, 0);
                assert.equal(harness.callLog.renderGroups.length, 1);
            },
        },
        {
            name: 'first DB Save names the workspace and creates revision 1',
            async run() {
                const elements = createSaveButtonElements();
                const { client: fakeClient, calls } = createFakePersistenceClient();
                const harness = loadAppContext({
                    elements,
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();

                const saved = await harness.context.saveWorkspaceToStore();
                assert.equal(saved, true);
                assert.equal(calls.save.length, 1);
                assert.equal(calls.save[0].title, 'Stub Workspace');
                assert.equal(calls.save[0].expectedRevision, undefined);
                assert.ok(calls.save[0].documentId);
                assert.deepEqual(calls.lease, [calls.save[0].documentId]);
                const state = harness.context.__optionComboApp.getState();
                assert.equal(state.importedSessionTitle, 'Stub Workspace');
                // The payload the client received is disarmed snapshot data.
                assert.equal(calls.save[0].payload.importedSessionTitle, 'Stub Workspace');
                assert.match(elements.saveBtn.innerHTML, /Saved!/);
            },
        },
        {
            name: 'bound DB Save carries the expected revision and document id',
            async run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();

                const saved = await harness.context.saveWorkspaceToStore();
                assert.equal(saved, true);
                assert.equal(calls.save[0].documentId, 'doc-bound-1');
                assert.equal(calls.save[0].expectedRevision, 3);
                assert.equal(calls.save[0].title, 'Bound');
                // An already-bound save does not re-acquire the lease.
                assert.equal(calls.lease.length, 0);
            },
        },
        {
            name: 'Save a Copy posts a fresh document id and leaves the old one alone',
            async run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();

                const saved = await harness.context.saveWorkspaceCopyToStore();
                assert.equal(saved, true);
                assert.equal(calls.save.length, 1);
                assert.notEqual(calls.save[0].documentId, 'doc-bound-1');
                assert.equal(calls.save[0].expectedRevision, undefined);
            },
        },
        {
            name: 'a failed DB save reports failure and never shows Saved',
            async run() {
                const elements = createSaveButtonElements();
                const alerts = [];
                const { client: fakeClient } = createFakePersistenceClient({
                    saveWorkspace() {
                        const error = new Error('boom');
                        error.code = 'internal_store_error';
                        return Promise.reject(error);
                    },
                });
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                const harness = loadAppContext({
                    elements,
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        alert(message) { alerts.push(message); },
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();

                const saved = await harness.context.saveWorkspaceToStore();
                assert.equal(saved, false);
                assert.equal(elements.saveBtn.innerHTML, 'Save');
                assert.match(alerts.join('\n'), /internal_store_error/);
            },
        },
        {
            name: 'revision conflict can branch into Save a Copy',
            async run() {
                const saves = [];
                const { client: fakeClient, calls } = createFakePersistenceClient({
                    saveWorkspace(params) {
                        saves.push(params);
                        if (saves.length === 1) {
                            const error = new Error('conflict');
                            error.code = 'revision_conflict';
                            error.response = { currentRevision: 9 };
                            return Promise.reject(error);
                        }
                        return Promise.resolve({
                            document: {
                                documentId: params.documentId,
                                title: params.title,
                                revision: 1,
                                updatedAtUtc: '2026-08-08T12:00:00.000Z',
                            },
                        });
                    },
                });
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                const conflictChoices = [];
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                        OptionComboSessionUI: {
                            syncWorkspaceChrome() {},
                            syncControlPanel() {},
                            resolveDocumentTitle() { return 'Copy Title'; },
                            promptWorkspaceTitle() { return 'Copy Title'; },
                            confirmUnsavedChanges() { return 'discard'; },
                            chooseConflictResolution(details) {
                                conflictChoices.push(details);
                                return 'save-copy';
                            },
                            confirmWorkspaceDelete() { return true; },
                            showWorkspaceStoreUnavailable() {},
                            formatWorkspaceListRow() { return ''; },
                            showWorkspaceListDialog() { return Promise.resolve(null); },
                        },
                    },
                });
                harness.triggerDomReady();

                const saved = await harness.context.saveWorkspaceToStore();
                assert.equal(saved, true);
                assert.equal(saves.length, 2);
                assert.equal(conflictChoices.length, 1);
                assert.equal(conflictChoices[0].currentRevision, 9);
                assert.equal(saves[0].documentId, 'doc-bound-1');
                assert.notEqual(saves[1].documentId, 'doc-bound-1');
                assert.equal(saves[1].expectedRevision, undefined);
                assert.equal(calls.lease.length, 1);
            },
        },
        {
            name: 'opening a stored workspace replaces the current one and rebinds identity',
            async run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                const normalizeCalls = [];
                const storedPayload = createImportedSession({
                    underlyingSymbol: 'GLD',
                    groups: [{ id: 'stored_group', legs: [] }],
                    hedges: [{ id: 'stored_hedge' }],
                });
                fakeClient.loadWorkspace = () => Promise.resolve({
                    document: {
                        documentId: 'doc-open-1', title: 'GLD book', revision: 5,
                        updatedAtUtc: '2026-08-08T12:00:00.000Z',
                    },
                    payload: storedPayload,
                });
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();
                const context = harness.context;
                const state = context.__optionComboApp.getState();
                state.groups = [{ id: 'old_group' }];
                state.hedges = [{ id: 'old_hedge' }];

                // Observe the mode the app passes to the pure normalizer.
                const originalNormalize = context.OptionComboSessionLogic.normalizeImportedState;
                context.OptionComboSessionLogic.normalizeImportedState =
                    (currentState, imported, dateStr, genId, addDaysFn, options) => {
                        normalizeCalls.push(options);
                        return originalNormalize(currentState, imported, dateStr, genId, addDaysFn, options);
                    };

                const opened = await context._openWorkspaceDocument('doc-open-1');
                assert.equal(opened, true);
                assert.equal(normalizeCalls.length, 1);
                assert.equal(normalizeCalls[0].mode, 'replace');
                // The stub normalizer returns the imported payload as-is, so
                // replace semantics show up as the stored groups only.
                assert.equal(state.groups.length, 1);
                assert.equal(state.groups[0].id, 'stored_group');
                assert.equal(state.hedges[0].id, 'stored_hedge');
                assert.equal(state.underlyingSymbol, 'GLD');
                // Identity is rebound and the lease acquired for the new doc.
                assert.equal(fakeClient.envelope.documentId, 'doc-open-1');
                assert.equal(fakeClient.envelope.revision, 5);
                assert.deepEqual(calls.lease, ['doc-open-1']);
                assert.ok(harness.callLog.renderGroups.length >= 1);
            },
        },
        {
            name: 'a rejected stored payload leaves the current workspace untouched',
            async run() {
                const { client: fakeClient } = createFakePersistenceClient();
                fakeClient.loadWorkspace = () => Promise.resolve({
                    document: { documentId: 'doc-bad', title: 'Bad', revision: 1 },
                    payload: { broken: true },
                });
                const alerts = [];
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        alert(message) { alerts.push(message); },
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();
                const context = harness.context;
                const state = context.__optionComboApp.getState();
                state.groups = [{ id: 'old_group' }];
                context.OptionComboSessionLogic.normalizeImportedState = () => {
                    throw new Error('unusable payload');
                };

                const opened = await context._openWorkspaceDocument('doc-bad');
                assert.equal(opened, false);
                assert.equal(state.groups.length, 1);
                assert.equal(state.groups[0].id, 'old_group');
                assert.equal(fakeClient.envelope, null);
                assert.match(alerts.join('\n'), /unchanged/);
            },
        },
        {
            name: 'JSON import unbinds the database document',
            async run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();
                harness.context.processImportedFile({
                    name: 'SPY Session.json',
                    __text: JSON.stringify(createImportedSession()),
                });
                assert.equal(fakeClient.envelope, null);
                assert.equal(calls.released, 1);
            },
        },
        {
            name: 'bootstrap seeds the unbound dirty baseline',
            run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();
                assert.equal(calls.baseline.length, 1);
                // The stale-revision handler is registered exactly once.
                assert.equal(calls.staleHandlers.length, 1);
            },
        },
        {
            name: 'JSON import re-seeds the unbound baseline after unbinding',
            run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();
                const seededAtBoot = calls.baseline.length;
                harness.context.processImportedFile({
                    name: 'SPY Session.json',
                    __text: JSON.stringify(createImportedSession()),
                });
                assert.equal(fakeClient.envelope, null);
                assert.equal(calls.baseline.length, seededAtBoot + 1);
            },
        },
        {
            name: 'deleting the bound document marks the draft dirty',
            async run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                fakeClient.listWorkspaces = () => Promise.resolve({
                    documents: [{
                        documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    }],
                });
                fakeClient.deleteWorkspace = () => Promise.resolve({});
                const dialogResults = [
                    { action: 'delete', documentId: 'doc-bound-1' },
                    null,
                ];
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                        OptionComboSessionUI: {
                            syncWorkspaceChrome() {},
                            syncControlPanel() {},
                            resolveDocumentTitle() { return 'T'; },
                            promptWorkspaceTitle() { return 'T'; },
                            confirmUnsavedChanges() { return 'discard'; },
                            chooseConflictResolution() { return 'cancel'; },
                            chooseStaleResolution() { return 'cancel'; },
                            chooseTakeoverResolution() { return 'cancel'; },
                            confirmWorkspaceDelete() { return true; },
                            confirmWorkspaceUndelete() { return true; },
                            showWorkspaceStoreUnavailable() {},
                            formatWorkspaceListRow() { return ''; },
                            showWorkspaceListDialog() {
                                return Promise.resolve(dialogResults.shift());
                            },
                        },
                    },
                });
                harness.triggerDomReady();
                await harness.context.openWorkspaceFromStore();
                assert.equal(fakeClient.envelope, null);
                assert.equal(calls.markedDirty, 1);
                assert.equal(calls.released, 1);
            },
        },
        {
            name: 'rapid Save clicks collapse into a single client save',
            async run() {
                const elements = createSaveButtonElements();
                elements.saveCopyBtn = { style: {}, innerHTML: 'Save a Copy' };
                let resolveSave;
                const { client: fakeClient, calls } = createFakePersistenceClient({
                    saveWorkspace(params) {
                        calls.save.push(params);
                        return new Promise((resolve) => { resolveSave = resolve; });
                    },
                });
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                const harness = loadAppContext({
                    elements,
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                    },
                });
                harness.triggerDomReady();

                const attempts = [];
                for (let i = 0; i < 10; i += 1) {
                    attempts.push(harness.context.saveWorkspaceToStore());
                }
                // The lock spans the whole ACK wait: buttons disabled and
                // exactly one client call.
                assert.equal(calls.save.length, 1);
                assert.equal(elements.saveBtn.disabled, true);
                assert.equal(elements.saveCopyBtn.disabled, true);

                resolveSave({
                    document: {
                        documentId: 'doc-bound-1', title: 'Bound', revision: 4,
                        updatedAtUtc: '2026-08-08T12:00:00.000Z',
                    },
                });
                const results = await Promise.all(attempts);
                assert.equal(results.filter(Boolean).length, 1);
                assert.equal(calls.save.length, 1);
                assert.equal(elements.saveBtn.disabled, false);
                assert.equal(elements.saveCopyBtn.disabled, false);
            },
        },
        {
            name: 'readonly save offers takeover once the writer is gone',
            async run() {
                const loads = [];
                const { client: fakeClient, calls } = createFakePersistenceClient();
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                fakeClient.getWriterState = () => ({ state: 'readonly' });
                fakeClient.canTakeover = () => {
                    calls.takeoverQueries += 1;
                    return { allowed: true, mustReloadFirst: true };
                };
                fakeClient.loadWorkspace = (documentId) => {
                    loads.push(documentId);
                    return Promise.resolve({
                        document: {
                            documentId, title: 'Bound', revision: 9,
                            updatedAtUtc: '2026-08-08T12:00:00.000Z',
                        },
                        payload: createImportedSession(),
                    });
                };
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                        OptionComboSessionUI: {
                            syncWorkspaceChrome() {},
                            syncControlPanel() {},
                            resolveDocumentTitle() { return 'T'; },
                            promptWorkspaceTitle() { return 'T'; },
                            confirmUnsavedChanges() { return 'discard'; },
                            chooseConflictResolution() { return 'cancel'; },
                            chooseStaleResolution() { return 'cancel'; },
                            chooseTakeoverResolution() { return 'take-over'; },
                            confirmWorkspaceDelete() { return true; },
                            confirmWorkspaceUndelete() { return true; },
                            showWorkspaceStoreUnavailable() {},
                            formatWorkspaceListRow() { return ''; },
                            showWorkspaceListDialog() { return Promise.resolve(null); },
                        },
                    },
                });
                harness.triggerDomReady();

                const saved = await harness.context.saveWorkspaceToStore();
                // Takeover replaces local edits with the latest revision; it
                // is not a save, so the call reports false.
                assert.equal(saved, false);
                assert.equal(calls.takeoverQueries, 1);
                assert.equal(calls.takeoverBegun, 1);
                assert.deepEqual(loads, ['doc-bound-1']);
                assert.equal(calls.takeoverCompleted, 1);
                assert.equal(calls.takeoverCancelled, 0);
                // The takeover reload claims the lease via completeTakeover,
                // never via a plain acquire (which would drop pending state).
                assert.equal(calls.lease.length, 0);
                assert.equal(calls.save.length, 0);
            },
        },
        {
            name: 'a failed takeover reload rolls the state back',
            async run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                fakeClient.getWriterState = () => ({ state: 'readonly' });
                fakeClient.canTakeover = () => ({ allowed: true, mustReloadFirst: true });
                fakeClient.loadWorkspace = () => {
                    const error = new Error('gone');
                    error.code = 'document_not_found';
                    return Promise.reject(error);
                };
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                        alert() {},
                        OptionComboSessionUI: {
                            syncWorkspaceChrome() {},
                            syncControlPanel() {},
                            resolveDocumentTitle() { return 'T'; },
                            promptWorkspaceTitle() { return 'T'; },
                            confirmUnsavedChanges() { return 'discard'; },
                            chooseConflictResolution() { return 'cancel'; },
                            chooseStaleResolution() { return 'cancel'; },
                            chooseTakeoverResolution() { return 'take-over'; },
                            confirmWorkspaceDelete() { return true; },
                            confirmWorkspaceUndelete() { return true; },
                            showWorkspaceStoreUnavailable() {},
                            formatWorkspaceListRow() { return ''; },
                            showWorkspaceListDialog() { return Promise.resolve(null); },
                        },
                    },
                });
                harness.triggerDomReady();

                const saved = await harness.context.saveWorkspaceToStore();
                assert.equal(saved, false);
                assert.equal(calls.takeoverBegun, 1);
                assert.equal(calls.takeoverCompleted, 0);
                assert.equal(calls.takeoverCancelled, 1);
                assert.equal(calls.save.length, 0);
            },
        },
        {
            name: 'an unknown first-save retry resumes the same document id',
            async run() {
                let failNext = true;
                let unknownAttempt = null;
                const prompts = [];
                const { client: fakeClient, calls } = createFakePersistenceClient({
                    saveWorkspace(params) {
                        calls.save.push(params);
                        if (failNext) {
                            failNext = false;
                            unknownAttempt = {
                                documentId: params.documentId,
                                title: params.title,
                                expectedRevision: params.expectedRevision,
                                fingerprint: JSON.stringify(params.payload),
                                saveToken: 'token-1',
                            };
                            const error = new Error('lost ack');
                            error.code = 'timeout';
                            return Promise.reject(error);
                        }
                        unknownAttempt = null;
                        return Promise.resolve({
                            document: {
                                documentId: params.documentId,
                                title: params.title,
                                revision: 1,
                                updatedAtUtc: '2026-08-08T12:00:00.000Z',
                            },
                        });
                    },
                });
                fakeClient.getUnknownSaveAttempt = () =>
                    (unknownAttempt ? { ...unknownAttempt } : null);
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                        alert() {},
                        OptionComboSessionUI: {
                            syncWorkspaceChrome() {},
                            syncControlPanel() {},
                            resolveDocumentTitle() { return 'My Book'; },
                            promptWorkspaceTitle(suggested) {
                                prompts.push(suggested);
                                return 'My Book';
                            },
                            confirmUnsavedChanges() { return 'discard'; },
                            chooseConflictResolution() { return 'cancel'; },
                            chooseStaleResolution() { return 'cancel'; },
                            chooseTakeoverResolution() { return 'cancel'; },
                            confirmWorkspaceDelete() { return true; },
                            confirmWorkspaceUndelete() { return true; },
                            showWorkspaceStoreUnavailable() {},
                            formatWorkspaceListRow() { return ''; },
                            showWorkspaceListDialog() { return Promise.resolve(null); },
                        },
                    },
                });
                harness.triggerDomReady();

                const first = await harness.context.saveWorkspaceToStore();
                assert.equal(first, false);
                const retried = await harness.context.saveWorkspaceToStore();
                assert.equal(retried, true);
                // Same document id resumed, and the user was not re-prompted
                // for a name on the resuming retry.
                assert.equal(calls.save.length, 2);
                assert.equal(calls.save[1].documentId, calls.save[0].documentId);
                assert.equal(calls.save[1].title, calls.save[0].title);
                assert.equal(prompts.length, 1);
            },
        },
        {
            name: 'takeover cancel and reload failure keep read-only protection (real state machine)',
            async run() {
                // Two REAL persistence clients on a shared channel bus; the
                // app drives client B. No fake takeover methods: every state
                // transition below is the production state machine.
                const persistenceCtx = loadBrowserScripts(['js/workspace_persistence.js']);
                const channels = [];
                const busFactory = () => {
                    const channel = {
                        onmessage: null,
                        postMessage(message) {
                            for (const other of channels) {
                                if (other !== channel
                                    && typeof other.onmessage === 'function') {
                                    other.onmessage({ data: message });
                                }
                            }
                        },
                        close() {},
                    };
                    channels.push(channel);
                    return channel;
                };
                let idCounter = 0;
                const clock = { t: 1_000_000 };
                const makeRealClient = (sent) => {
                    const timers = [];
                    const client = persistenceCtx.OptionComboWorkspacePersistence.createClient({
                        send: (message) => { sent.push(JSON.parse(message)); return true; },
                        setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
                        clearTimeoutFn: () => {},
                        setIntervalFn: () => 1,
                        clearIntervalFn: () => {},
                        generateId: () => `real-${++idCounter}`,
                        now: () => clock.t,
                        channelFactory: busFactory,
                    });
                    return {
                        client,
                        fireTimers: () => timers.splice(0).forEach(fn => fn()),
                    };
                };
                const sentA = [];
                const sentB = [];
                const a = makeRealClient(sentA);
                const b = makeRealClient(sentB);
                const documentId = 'doc-aaaaaaaa-1111-4111-8111-111111111111';

                const aLease = a.client.acquireWriterLease(documentId);
                a.fireTimers(); // grace expires unopposed: A is the writer
                assert.equal(await aLease, 'writer');
                b.client.bindDocument(
                    { documentId, title: 'Bound', revision: 3, updatedAtUtc: '' },
                    'fp'
                );
                assert.equal(await b.client.acquireWriterLease(documentId), 'readonly');

                const takeoverChoices = ['cancel', 'take-over'];
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => b.client,
                        setTimeout() { return 1; },
                        alert() {},
                        confirm() { return false; },
                        OptionComboSessionUI: {
                            syncWorkspaceChrome() {},
                            syncControlPanel() {},
                            resolveDocumentTitle() { return 'T'; },
                            promptWorkspaceTitle() { return 'T'; },
                            confirmUnsavedChanges() { return 'discard'; },
                            chooseConflictResolution() { return 'cancel'; },
                            chooseStaleResolution() { return 'cancel'; },
                            chooseTakeoverResolution() {
                                return takeoverChoices.shift();
                            },
                            confirmWorkspaceDelete() { return true; },
                            confirmWorkspaceUndelete() { return true; },
                            showWorkspaceStoreUnavailable() {},
                            formatWorkspaceListRow() { return ''; },
                            showWorkspaceListDialog() { return Promise.resolve(null); },
                        },
                    },
                });
                harness.triggerDomReady();

                // 1. Writer alive: not eligible, save refused, still readonly.
                assert.equal(await harness.context.saveWorkspaceToStore(), false);
                assert.equal(b.client.getWriterState().state, 'readonly');

                // 2. Writer ages out; the user cancels the takeover offer.
                //    The pure eligibility query left the state untouched.
                clock.t += 60_000;
                assert.equal(await harness.context.saveWorkspaceToStore(), false);
                assert.equal(b.client.getWriterState().state, 'readonly');

                // 3. Take over, but the reload fails: full rollback.
                const savePromise = harness.context.saveWorkspaceToStore();
                const loadRequest = sentB.find(
                    message => message.action === 'load_saved_workspace'
                );
                assert.ok(loadRequest, 'takeover must reload before claiming');
                b.client.handleMessage({
                    action: 'saved_workspace_loaded',
                    requestId: loadRequest.requestId,
                    success: false,
                    code: 'document_not_found',
                    message: 'gone',
                });
                assert.equal(await savePromise, false);
                assert.equal(b.client.getWriterState().state, 'readonly');

                // 4. takeover-pending itself never saves the bound document.
                assert.equal(b.client.beginTakeover(), true);
                assert.equal(b.client.getWriterState().state, 'takeover-pending');
                assert.equal(await harness.context.saveWorkspaceToStore(), false);
                assert.equal(
                    sentB.filter(m => m.action === 'save_saved_workspace').length, 0
                );
                assert.equal(b.client.cancelTakeover(), true);
                assert.equal(b.client.getWriterState().state, 'readonly');
            },
        },
        {
            name: 'a consumed calendar handoff starts dirty; a plain boot stays clean',
            run() {
                const plain = createFakePersistenceClient();
                const plainHarness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => plain.client,
                        setTimeout() { return 1; },
                    },
                });
                plainHarness.triggerDomReady();
                assert.equal(plain.calls.baseline.length, 1);
                assert.equal(plain.calls.markedDirty, 0);

                const handoff = createFakePersistenceClient();
                const handoffHarness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => handoff.client,
                        setTimeout() { return 1; },
                        OptionComboCalendarHandoff: {
                            takeHandoffPayload() {
                                return {
                                    symbol: 'ES',
                                    underlyingContractMonth: '202606',
                                    underlyingPrice: 6000,
                                };
                            },
                            buildGroupName() { return 'ES calendar'; },
                            buildCalendarLegs() { return []; },
                        },
                    },
                });
                handoffHarness.triggerDomReady();
                // Baseline is still the pristine reference, and the one-shot
                // handoff content is explicitly protected as unsaved work.
                assert.equal(handoff.calls.baseline.length, 1);
                assert.equal(handoff.calls.markedDirty, 1);
            },
        },
        {
            name: 'stale notifications can branch into Save a Copy',
            async run() {
                const { client: fakeClient, calls } = createFakePersistenceClient();
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                        OptionComboSessionUI: {
                            syncWorkspaceChrome() {},
                            syncControlPanel() {},
                            resolveDocumentTitle() { return 'Copy'; },
                            promptWorkspaceTitle() { return 'Copy'; },
                            confirmUnsavedChanges() { return 'discard'; },
                            chooseConflictResolution() { return 'cancel'; },
                            chooseStaleResolution() { return 'save-copy'; },
                            chooseTakeoverResolution() { return 'cancel'; },
                            confirmWorkspaceDelete() { return true; },
                            confirmWorkspaceUndelete() { return true; },
                            showWorkspaceStoreUnavailable() {},
                            formatWorkspaceListRow() { return ''; },
                            showWorkspaceListDialog() { return Promise.resolve(null); },
                        },
                    },
                });
                harness.triggerDomReady();
                assert.equal(calls.staleHandlers.length, 1);
                calls.staleHandlers[0]({ documentId: 'doc-bound-1', revision: 7 });
                // Give the async save-copy a microtask turn.
                await Promise.resolve();
                await Promise.resolve();
                assert.equal(calls.save.length, 1);
                assert.equal(calls.save[0].expectedRevision, undefined);
            },
        },
        {
            name: 'read-only tabs cannot overwrite the writer document',
            async run() {
                const confirms = [];
                const { client: fakeClient, calls } = createFakePersistenceClient();
                fakeClient.envelope = {
                    documentId: 'doc-bound-1', title: 'Bound', revision: 3,
                    updatedAtUtc: '', lastSavedPayloadFingerprint: 'fp',
                };
                fakeClient.getWriterState = () => ({ state: 'readonly' });
                const harness = loadAppContext({
                    elements: createSaveButtonElements(),
                    overrides: {
                        getWorkspacePersistenceClient: () => fakeClient,
                        setTimeout() { return 1; },
                        confirm(message) { confirms.push(message); return false; },
                    },
                });
                harness.triggerDomReady();

                const saved = await harness.context.saveWorkspaceToStore();
                assert.equal(saved, false);
                assert.equal(calls.save.length, 0);
                assert.match(confirms.join('\n'), /read-only/);
            },
        },
    ],
};

function createFakePersistenceClient(overrides = {}) {
    const calls = {
        save: [], lease: [], released: 0,
        baseline: [], markedDirty: 0, staleHandlers: [],
        takeoverQueries: 0, takeoverBegun: 0, takeoverCancelled: 0,
        takeoverCompleted: 0, undelete: [],
    };
    const client = {
        envelope: null,
        getEnvelope() { return this.envelope ? { ...this.envelope } : null; },
        getWriterState() { return { state: 'writer' }; },
        fingerprintPayload(payload) { return JSON.stringify(payload); },
        isDirty() { return false; },
        setUnboundBaseline(payload) { calls.baseline.push(payload); },
        markUnboundDirty() { calls.markedDirty += 1; },
        setStaleRevisionHandler(handler) { calls.staleHandlers.push(handler); },
        getUnknownSaveAttempt() { return null; },
        canTakeover() {
            calls.takeoverQueries += 1;
            return { allowed: false, reason: 'writer_active' };
        },
        beginTakeover() { calls.takeoverBegun += 1; return true; },
        cancelTakeover() { calls.takeoverCancelled += 1; return true; },
        completeTakeover() { calls.takeoverCompleted += 1; return true; },
        undeleteWorkspace(documentId, expectedRevision) {
            calls.undelete.push({ documentId, expectedRevision });
            return Promise.resolve({});
        },
        bindDocument(document, fingerprint) {
            this.envelope = {
                documentId: document.documentId,
                title: document.title,
                revision: document.revision,
                updatedAtUtc: document.updatedAtUtc || '',
                lastSavedPayloadFingerprint: fingerprint || '',
            };
        },
        clearDocument() { this.envelope = null; },
        releaseWriterLease() { calls.released += 1; },
        acquireWriterLease(documentId) {
            calls.lease.push(documentId);
            return Promise.resolve('writer');
        },
        saveWorkspace(params) {
            calls.save.push(params);
            return Promise.resolve({
                document: {
                    documentId: params.documentId,
                    title: params.title,
                    symbol: 'SPY',
                    marketDataMode: 'live',
                    revision: params.expectedRevision ? params.expectedRevision + 1 : 1,
                    updatedAtUtc: '2026-08-08T12:00:00.000Z',
                },
            }).then((response) => {
                client.bindDocument(response.document, client.fingerprintPayload(params.payload));
                return response;
            });
        },
        listWorkspaces() { return Promise.resolve({ documents: [] }); },
        loadWorkspace() { return Promise.reject(new Error('not stubbed')); },
        deleteWorkspace() { return Promise.resolve({}); },
        ...overrides,
    };
    return { client, calls };
}
