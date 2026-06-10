const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function buildHarness(options = {}) {
    const state = options.state || {
        underlyingSymbol: 'SPY',
        underlyingPrice: 671.1,
        simulatedDate: '2026-03-19',
        baseDate: '2026-03-19',
        historicalQuoteDate: '2026-03-19',
        allowLiveComboOrders: true,
        selectedLiveComboOrderAccount: 'F1234567',
        groups: [],
        hedges: [],
    };
    const sent = [];
    let renderCalls = 0;
    let updateCalls = 0;
    let managedSnapshotCalls = 0;
    let flashCalls = 0;

    const ctx = loadBrowserScripts(
        [
            'js/trade_trigger_logic.js',
            'js/session_logic.js',
            'js/product_registry.js',
            'js/group_order_builder.js',
            'js/combo_order_transport.js',
        ],
        {
            state,
            document: {
                getElementById() { return null; },
                querySelector() { return null; },
            },
        }
    );

    const api = ctx.OptionComboComboOrderTransport.createApi({
        state,
        isHistoricalMode() {
            return options.historicalMode === true;
        },
        isWsConnected() {
            return options.wsConnected !== false;
        },
        sendPayload(payload) {
            sent.push(payload);
        },
        renderGroups() {
            renderCalls += 1;
        },
        updateDerivedValues() {
            updateCalls += 1;
        },
        requestManagedAccountsSnapshot() {
            managedSnapshotCalls += 1;
        },
        hasSelectedLiveComboOrderAccount() {
            return !!String(state.selectedLiveComboOrderAccount || '').trim();
        },
        getLiveComboOrderAccountRequirementMessage() {
            return 'Select a TWS account before sending combo orders.';
        },
        findGroupById(groupId) {
            return (state.groups || []).find((group) => group.id === groupId) || null;
        },
        groupHasCostForAllPositionedLegs(group) {
            return (group.legs || []).every((leg) => {
                const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
                if (pos < 0.0001) {
                    return true;
                }
                return Number.isFinite(parseFloat(leg.cost)) && parseFloat(leg.cost) > 0;
            });
        },
        resolveHistoricalReplayClosePrice(leg) {
            return Number.isFinite(parseFloat(leg && leg.currentPrice))
                ? parseFloat(leg.currentPrice)
                : null;
        },
        getHistoricalReplayDate() {
            return state.historicalQuoteDate || state.baseDate || '';
        },
        buildHistoricalTriggerOrderPreview(group, executionMode) {
            const preview = {
                executionMode,
                executionIntent: 'open',
                requestSource: 'trial_trigger',
                status: executionMode === 'preview' ? 'Previewed' : 'Submitted',
                limitPrice: 6.5,
                orderAction: 'BUY',
                legs: (group.legs || []).map((leg) => ({
                    id: leg.id,
                    mark: Number.isFinite(parseFloat(leg.currentPrice)) ? parseFloat(leg.currentPrice) : 0,
                })),
            };
            if (executionMode !== 'preview') {
                preview.orderId = 900001;
                preview.permId = 800900001;
                preview.filled = 0;
                preview.remaining = 1;
            }
            return { preview };
        },
        applyHistoricalComboFill(_group, _runtimeKind, _preview) {},
        formatSymbolPriceInputValue(_symbol, value) {
            return String(value);
        },
        flashElement() {
            flashCalls += 1;
        },
    });

    return {
        api,
        ctx,
        state,
        sent,
        get renderCalls() {
            return renderCalls;
        },
        get updateCalls() {
            return updateCalls;
        },
        get managedSnapshotCalls() {
            return managedSnapshotCalls;
        },
        get flashCalls() {
            return flashCalls;
        },
    };
}

module.exports = {
    name: 'combo_order_transport.js',
    tests: [
        {
            name: 'requests live trigger previews through preview payloads by default',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 671.1,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'F1234567',
                    groups: [
                        {
                            id: 'group_open_preview',
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                executionMode: 'preview',
                                pendingRequest: false,
                                status: 'armed',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02' },
                                { id: 'leg_2', type: 'call', pos: -1, strike: 677, expDate: '2026-04-02' },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });

                harness.api.requestTrialGroupComboOrder(state.groups[0]);

                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'preview_combo_order');
                assert.equal(harness.sent[0].executionIntent, 'open');
                assert.equal(harness.sent[0].requestSource, 'trial_trigger');
                assert.equal(state.groups[0].tradeTrigger.status, 'pending_preview');
            },
        },
        {
            name: 'advances validated trigger submit into a real submit payload',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'F1234567',
                    groups: [
                        {
                            id: 'group_open_submit',
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                executionMode: 'submit',
                                pendingRequest: true,
                                status: 'pending_validation',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02' },
                                { id: 'leg_2', type: 'put', pos: -1, strike: 662, expDate: '2026-04-02' },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });

                const handled = harness.api._test.applyComboOrderValidationResult({
                    action: 'combo_order_validation_result',
                    groupId: 'group_open_submit',
                    validation: {
                        valid: true,
                        executionMode: 'submit',
                    },
                });

                assert.equal(handled, true);
                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'submit_combo_order');
                assert.equal(harness.sent[0].executionIntent, 'open');
                assert.equal(state.groups[0].tradeTrigger.status, 'pending_submit');
                assert.equal(state.groups[0].tradeTrigger.pendingRequest, true);
            },
        },
        {
            name: 'requests close-group previews before any real submission',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 671.1,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'F1234567',
                    groups: [
                        {
                            id: 'group_close_preview',
                            viewMode: 'active',
                            closeExecution: {
                                executionMode: 'preview',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_2', type: 'call', pos: -1, strike: 677, expDate: '2026-04-02', cost: 7.13, closePrice: null },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });

                const result = harness.api.requestCloseGroupComboOrder(state.groups[0]);

                assert.equal(result, true);
                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'preview_combo_order');
                assert.equal(harness.sent[0].executionIntent, 'close');
                assert.equal(harness.sent[0].requestSource, 'close_group');
                assert.equal(state.groups[0].closeExecution.status, 'pending_preview');
            },
        },
        {
            name: 'advances validated close-group submit into a close submit payload',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'F1234567',
                    groups: [
                        {
                            id: 'group_close_submit',
                            viewMode: 'active',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            closeExecution: {
                                executionMode: 'submit',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: true,
                                status: 'pending_validation',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_2', type: 'put', pos: -1, strike: 662, expDate: '2026-04-02', cost: 7.96, closePrice: null },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });

                const handled = harness.api._test.applyComboOrderValidationResult({
                    action: 'combo_order_validation_result',
                    groupId: 'group_close_submit',
                    validation: {
                        valid: true,
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                    },
                });

                assert.equal(handled, true);
                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'submit_combo_order');
                assert.equal(harness.sent[0].executionIntent, 'close');
                assert.equal(harness.sent[0].requestSource, 'close_group');
                assert.equal(state.groups[0].closeExecution.status, 'pending_submit');
            },
        },
        {
            name: 'routes close-group preview results into close execution runtime',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_close_route',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            closeExecution: {
                                executionMode: 'preview',
                                pendingRequest: true,
                                status: 'pending_preview',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                const handled = harness.api._test.applyComboOrderResult({
                    action: 'combo_order_preview_result',
                    groupId: 'group_close_route',
                    preview: {
                        executionMode: 'preview',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        limitPrice: 5.03,
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].closeExecution.status, 'previewed');
                assert.equal(state.groups[0].closeExecution.lastPreview.limitPrice, 5.03);
                assert.equal(state.groups[0].tradeTrigger.lastPreview, null);
            },
        },
        {
            name: 'merges managed status fields and advances resume/concede/cancel flows',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_managed',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    orderId: 1337,
                                },
                                lastError: '',
                            },
                            legs: [],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                harness.api._test.applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_managed',
                    orderStatus: {
                        executionMode: 'submit',
                        orderId: 1337,
                        managedMode: true,
                        managedState: 'watching',
                        workingLimitPrice: 2.25,
                        latestComboMid: 2.31,
                    },
                });
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedState, 'watching');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.workingLimitPrice, 2.25);

                harness.api._test.applyComboOrderResumeResult({
                    action: 'combo_order_resume_result',
                    groupId: 'group_managed',
                    orderStatus: {
                        orderId: 1337,
                        managedState: 'watching',
                    },
                });
                assert.equal(state.groups[0].tradeTrigger.status, 'submitted');

                harness.api._test.applyComboOrderConcedeResult({
                    action: 'combo_order_concede_result',
                    groupId: 'group_managed',
                    orderStatus: {
                        orderId: 1337,
                        managedState: 'watching',
                        managedConcessionRatio: 0.2,
                    },
                });
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedConcessionRatio, 0.2);

                harness.api._test.applyComboOrderCancelResult({
                    action: 'combo_order_cancel_result',
                    groupId: 'group_managed',
                    orderStatus: {
                        orderId: 1337,
                        managedState: 'cancelling',
                    },
                });
                assert.equal(state.groups[0].tradeTrigger.status, 'pending_cancel');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedState, 'cancelling');
            },
        },
        {
            name: 'restores submitted runtime state from an active combo orders snapshot',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_reattach',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                const handled = harness.api.handleMessage({
                    action: 'active_combo_orders_snapshot',
                    orders: [
                        {
                            groupId: 'group_reattach',
                            executionMode: 'submit',
                            executionIntent: 'open',
                            requestSource: 'trial_trigger',
                            status: 'Submitted',
                            orderId: 4400,
                            permId: 4401,
                            managedMode: true,
                            managedState: 'watching',
                            workingLimitPrice: 1.85,
                        },
                    ],
                });

                assert.equal(handled, true);
                const trigger = state.groups[0].tradeTrigger;
                assert.equal(trigger.status, 'submitted');
                assert.equal(trigger.lastPreview.orderId, 4400);
                assert.equal(trigger.lastPreview.permId, 4401);
                assert.equal(trigger.lastPreview.managedState, 'watching');
                assert.equal(trigger.lastPreview.workingLimitPrice, 1.85);
            },
        },
        {
            name: 'writes fill-cost updates into entry cost or close price by runtime kind',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    groups: [
                        {
                            id: 'group_fill_open',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    executionIntent: 'open',
                                    requestSource: 'trial_trigger',
                                    status: 'Submitted',
                                    orderId: 700,
                                },
                                lastError: '',
                            },
                            closeExecution: {
                                executionMode: 'submit',
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    executionIntent: 'close',
                                    requestSource: 'close_group',
                                    status: 'Submitted',
                                    orderId: 701,
                                },
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_call', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_put', type: 'put', pos: -1, strike: 662, expDate: '2026-04-02', cost: 7.96, closePrice: null },
                            ],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                harness.api._test.applyComboOrderFillCostUpdate({
                    action: 'combo_order_fill_cost_update',
                    groupId: 'group_fill_open',
                    orderFill: {
                        executionMode: 'submit',
                        executionIntent: 'open',
                        requestSource: 'trial_trigger',
                        orderId: 700,
                        permId: 1700,
                        legs: [
                            { id: 'leg_call', avgFillPrice: 10.85 },
                        ],
                    },
                });
                assert.equal(state.groups[0].legs[0].cost, 10.85);
                assert.equal(state.groups[0].legs[0].closePrice, null);

                harness.api._test.applyComboOrderFillCostUpdate({
                    action: 'combo_order_fill_cost_update',
                    groupId: 'group_fill_open',
                    orderFill: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        orderId: 701,
                        permId: 1701,
                        legs: [
                            { id: 'leg_put', avgFillPrice: 6.74 },
                        ],
                    },
                });
                assert.equal(state.groups[0].legs[1].cost, 7.96);
                assert.equal(state.groups[0].legs[1].closePrice, 6.74);
            },
        },
        {
            name: 'keeps historical trigger previews local without websocket sends',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 671.1,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    historicalQuoteDate: '2026-03-19',
                    allowLiveComboOrders: true,
                    groups: [
                        {
                            id: 'group_hist_preview',
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                executionMode: 'preview',
                                pendingRequest: false,
                                status: 'armed',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_hist_preview', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', currentPrice: 6.5 },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state, historicalMode: true });

                harness.api.requestTrialGroupComboOrder(state.groups[0]);

                assert.equal(harness.sent.length, 0);
                assert.equal(state.groups[0].tradeTrigger.status, 'previewed');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.pricingSource, undefined);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.limitPrice, 6.5);
            },
        },
        {
            name: 'keeps historical close-group settlement local without websocket sends',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 671.1,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    historicalQuoteDate: '2026-03-19',
                    groups: [
                        {
                            id: 'group_hist_close',
                            viewMode: 'active',
                            closeExecution: {
                                executionMode: 'preview',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_call', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null, currentPrice: 10.85 },
                                { id: 'leg_put', type: 'put', pos: -1, strike: 662, expDate: '2026-04-02', cost: 7.96, closePrice: null, currentPrice: 6.74 },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state, historicalMode: true });

                const didSettle = harness.api.requestCloseGroupComboOrder(state.groups[0]);

                assert.equal(didSettle, true);
                assert.equal(harness.sent.length, 0);
                assert.equal(state.groups[0].viewMode, 'settlement');
                assert.equal(state.groups[0].closeExecution.status, 'submitted');
                assert.equal(state.groups[0].legs[0].closePrice, 10.85);
                assert.equal(state.groups[0].legs[1].closePrice, 6.74);
            },
        },
    ],
};
