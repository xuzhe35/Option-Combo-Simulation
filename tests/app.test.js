const assert = require('node:assert/strict');

const { loadAppContext } = require('./helpers/load-browser-scripts');

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
                assert.equal(harness.callLog.bindDeltaHedgePanel.length, 1);
                assert.deepEqual(harness.callLog.setInterval.map(item => item.delay), [5000]);
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
            name: 'applyImportedState fills missing futures contract month from product registry',
            run() {
                const { context } = loadAppContext();

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

                const state = context.__optionComboApp.getState();
                assert.equal(state.underlyingSymbol, 'ES');
                assert.equal(state.underlyingContractMonth, '202606');
                assert.equal(state.underlyingPrice, 5300);
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
    ],
};
