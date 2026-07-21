const assert = require('node:assert/strict');

const { loadAppContext } = require('./helpers/load-browser-scripts');

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
                assert.equal(state.projectionConvergenceMode, 'strict-bbo');
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
                assert.equal(state.projectionConvergenceMode, 'strict-bbo');
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
                    'legacy-input-iv'
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
    ],
};
