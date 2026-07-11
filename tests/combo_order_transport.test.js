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
    let confirmationContext = null;
    let comboSubmissionConfirmationContext = null;
    let sharedOrderConfirmationContext = null;

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

    if (options.showComboSubmissionConfirmationDialog === true) {
        ctx.OptionComboGroupEditorUI = {
            openComboSubmissionConfirmationDialog(context) {
                comboSubmissionConfirmationContext = context;
                return true;
            },
        };
    }
    if (options.showSharedOrderConfirmationDialog === true) {
        ctx.OptionComboOrderConfirmationUI = {
            open(context) {
                sharedOrderConfirmationContext = context;
                return true;
            },
        };
    }

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
        showCloseConfirmationDialog(context) {
            confirmationContext = context;
            return true;
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
        get confirmationContext() {
            return confirmationContext;
        },
        get comboSubmissionConfirmationContext() {
            return comboSubmissionConfirmationContext;
        },
        get sharedOrderConfirmationContext() {
            return sharedOrderConfirmationContext;
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
                const harness = buildHarness({ state, showComboSubmissionConfirmationDialog: true });

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
                                repriceThreshold: 0.02,
                                concessionRatio: 0.2,
                                timeInForce: 'GTC',
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
                const harness = buildHarness({ state, showComboSubmissionConfirmationDialog: true });
                harness.api.requestTrialGroupComboOrder(state.groups[0]);
                assert.equal(harness.sent[0].action, 'validate_combo_order');
                harness.sent.length = 0;

                const handled = harness.api._test.applyComboOrderValidationResult({
                    action: 'combo_order_validation_result',
                    groupId: 'group_open_submit',
                    validation: {
                        valid: true,
                        executionMode: 'submit',
                        executionPlanToken: 'plan-open-submit',
                    },
                });

                assert.equal(handled, true);
                assert.equal(harness.sent.length, 0);
                state.groups[0].tradeTrigger.repriceThreshold = 0.05;
                state.groups[0].tradeTrigger.concessionRatio = 0;
                state.groups[0].tradeTrigger.timeInForce = 'DAY';
                harness.comboSubmissionConfirmationContext.onConfirm();
                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'submit_combo_order');
                assert.equal(harness.sent[0].executionPlanToken, 'plan-open-submit');
                assert.equal(harness.sent[0].executionIntent, 'open');
                assert.equal(harness.sent[0].managedRepriceThreshold, 0.02);
                assert.equal(harness.sent[0].managedConcessionRatio, 0.2);
                assert.equal(harness.sent[0].timeInForce, 'GTC');
                assert.equal(state.groups[0].tradeTrigger.status, 'pending_submit');
                assert.equal(state.groups[0].tradeTrigger.pendingRequest, true);
            },
        },
        {
            name: 'describes combo confirmation as managed dynamic pricing',
            run() {
                const state = {
                    underlyingSymbol: 'SPY', allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'DU1', portfolioPositionsConnected: true,
                    portfolioPositions: [], hedges: [],
                    groups: [{
                        id: 'managed_combo', viewMode: 'trial',
                        tradeTrigger: {
                            enabled: true, executionMode: 'submit', repriceThreshold: 0.02,
                            concessionRatio: 0.2, timeInForce: 'GTC', pendingRequest: false,
                        },
                        legs: [{ id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02' }],
                    }],
                };
                const harness = buildHarness({ state, showSharedOrderConfirmationDialog: true });
                harness.api.requestTrialGroupComboOrder(state.groups[0]);
                harness.api._test.applyComboOrderValidationResult({
                    action: 'combo_order_validation_result', groupId: 'managed_combo',
                    validation: { valid: true, executionMode: 'submit', executionPlanToken: 'managed-plan' },
                });

                const intent = harness.sharedOrderConfirmationContext.intent;
                assert.equal(intent.orderType, 'MANAGED');
                assert.match(intent.orderDescription, /server dynamic pricing/i);
                assert.equal(intent.timeInForce, 'GTC');
                assert.equal(intent.managedRepriceThreshold, 0.02);
                assert.equal(intent.managedConcessionRatio, 0.2);
            },
        },
        {
            name: 'waits for open-order confirmation and reports TWS position reductions',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'U1',
                    portfolioPositionsConnected: true,
                    portfolioPositions: [
                        { account: 'U1', secType: 'OPT', symbol: 'SPY', expDate: '20260402', right: 'C', strike: 670, position: 3 },
                    ],
                    groups: [{
                        id: 'new_group', name: 'New Short', viewMode: 'trial',
                        tradeTrigger: { enabled: true, executionMode: 'submit', pendingRequest: false, status: 'idle' },
                        legs: [{ id: 'leg_1', type: 'call', pos: -1, strike: 670, expDate: '2026-04-02' }],
                    }, {
                        id: 'existing_group', name: 'Existing Long', viewMode: 'active',
                        legs: [{ id: 'leg_existing', type: 'call', pos: 3, strike: 670, expDate: '2026-04-02' }],
                    }],
                    hedges: [],
                };
                const harness = buildHarness({ state, showComboSubmissionConfirmationDialog: true });
                harness.ctx.OptionComboLegPositionCheck = require('./helpers/load-browser-scripts').loadBrowserScripts([
                    'js/product_registry.js', 'js/group_order_builder.js', 'js/leg_position_check.js',
                ]).OptionComboLegPositionCheck;

                harness.api.requestTrialGroupComboOrder(state.groups[0]);
                assert.equal(harness.sent.length, 1);
                harness.api._test.applyComboOrderValidationResult({
                    action: 'combo_order_validation_result',
                    groupId: 'new_group',
                    validation: { valid: true, executionMode: 'submit', legs: [], executionPlanToken: 'plan-position-warning' },
                });

                assert.equal(harness.sent.length, 1);
                assert.equal(state.groups[0].tradeTrigger.status, 'awaiting_confirmation');
                assert.equal(harness.comboSubmissionConfirmationContext.positionWarnings.length, 1);
                assert.deepEqual(
                    Array.from(harness.comboSubmissionConfirmationContext.positionWarnings[0].otherGroupNames),
                    ['Existing Long']
                );

                harness.comboSubmissionConfirmationContext.onConfirm();
                assert.equal(harness.sent.length, 2);
                assert.equal(harness.sent[1].action, 'submit_combo_order');
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
            name: 'requests close previews for one targeted leg only',
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
                            id: 'group_close_leg_preview',
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
                                { id: 'leg_call', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_stock', type: 'stock', pos: 100, strike: 0, expDate: '', cost: 671.1, closePrice: null },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });

                const result = harness.api.requestCloseLegComboOrder(state.groups[0], state.groups[0].legs[1]);

                assert.equal(result, true);
                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'preview_combo_order');
                assert.equal(harness.sent[0].executionIntent, 'close');
                assert.equal(harness.sent[0].requestSource, 'close_group');
                assert.equal(harness.sent[0].closeTargetScope, 'leg');
                assert.deepEqual(Array.from(harness.sent[0].closeTargetLegIds), ['leg_stock']);
                assert.equal(harness.sent[0].legs.length, 1);
                assert.equal(harness.sent[0].legs[0].id, 'leg_stock');
                assert.equal(harness.sent[0].legs[0].secType, 'STK');
                assert.equal(harness.sent[0].legs[0].pos, -100);
                assert.deepEqual(Array.from(state.groups[0].closeExecution.pendingCloseLegIds), ['leg_stock']);
                assert.equal(state.groups[0].closeExecution.status, 'pending_preview');
            },
        },
        {
            name: 'requests explicit expiry-equivalent close planning from the manual action',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 730,
                    simulatedDate: '2026-07-10',
                    baseDate: '2026-07-10',
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'F1234567',
                    groups: [
                        {
                            id: 'group_manual_equivalent',
                            viewMode: 'active',
                            closeExecution: {
                                executionMode: 'preview',
                                strategy: 'auto',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'deep_call', type: 'call', pos: 1, strike: 700, expDate: '2026-07-17', cost: 31, closePrice: null },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });

                const result = harness.api.requestEquivalentCloseGroupComboOrder(state.groups[0]);

                assert.equal(result, true);
                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'preview_combo_order');
                assert.equal(harness.sent[0].closeStrategy, 'equivalent_expiry');
                assert.equal(state.groups[0].closeExecution.pendingCloseStrategy, 'equivalent_expiry');
            },
        },
        {
            name: 'books expiry-equivalent hedge attribution and switches the group to settlement',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 730,
                    simulatedDate: '2026-07-10',
                    baseDate: '2026-07-10',
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'F1234567',
                    groups: [
                        {
                            id: 'group_filled_equivalent',
                            viewMode: 'active',
                            closeExecution: {
                                executionMode: 'submit',
                                strategy: 'auto',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: true,
                                status: 'pending_submit',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'deep_call', type: 'call', pos: 1, strike: 700, expDate: '2026-07-17', cost: 31, closePrice: null },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });

                harness.api._test.applyComboOrderResult({
                    action: 'combo_order_submit_result',
                    groupId: 'group_filled_equivalent',
                    order: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        status: 'Filled',
                        closePlanStage: 'complete',
                        closePlanComplete: true,
                        assignmentAdjustments: [
                            {
                                kind: 'equivalent_expiry',
                                adjustmentId: 'eq:deep_call',
                                optionLegId: 'deep_call',
                                underlyingLegId: '_expiry_hedge_deep_call',
                                classification: 'itm_hedged',
                                expiry: '20260717',
                                assignmentStrike: 700,
                                requiredUnderlyingQuantity: -100,
                                executedUnderlyingQuantity: -100,
                                internallyNettedUnderlyingQuantity: 0,
                                underlyingSymbol: 'SPY',
                                observedUnderlyingPrice: 730,
                                underlyingAvgFillPrice: 729.95,
                                hedgeBasisPrice: 729.95,
                                underlyingOrderId: 8801,
                                underlyingPermId: 9901,
                            },
                        ],
                    },
                });

                const group = state.groups[0];
                const optionLeg = group.legs.find((leg) => leg.id === 'deep_call');
                const hedgeLeg = group.legs.find((leg) => leg.id === '_expiry_hedge_deep_call');
                assert.equal(group.viewMode, 'settlement');
                assert.equal(optionLeg.closePrice, 0);
                assert.equal(optionLeg.closePriceSource, 'equivalent_expiry_hedged');
                assert.equal(optionLeg.equivalentCloseExecutedUnderlyingQuantity, -100);
                assert.equal(optionLeg.equivalentCloseFillPrice, 729.95);
                assert.equal(hedgeLeg.pos, -100);
                assert.equal(hedgeLeg.cost, 729.95);
                assert.equal(hedgeLeg.closePrice, 700);
                assert.equal(hedgeLeg.closePriceSource, 'equivalent_expiry_offset');
            },
        },
        {
            name: 'requires Close Plan confirmation before validating and submitting a close group',
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
                                pendingRequest: false,
                                status: 'idle',
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

                assert.equal(harness.api.requestCloseGroupComboOrder(state.groups[0]), true);
                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'preview_combo_order');
                assert.equal(harness.sent[0].executionMode, 'preview');
                assert.equal(harness.sent[0].confirmationTargetMode, 'submit');

                harness.api._test.applyComboOrderResult({
                    action: 'combo_order_preview_result',
                    groupId: 'group_close_submit',
                    preview: {
                        executionMode: 'preview',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        closePlanToken: 'token-close-submit',
                        closePlanExpiresAt: new Date(Date.now() + 60000).toISOString(),
                        closePlanLegs: [],
                        closePlanOrders: [],
                    },
                });
                assert.equal(state.groups[0].closeExecution.status, 'awaiting_confirmation');
                assert.ok(harness.confirmationContext);
                assert.equal(harness.confirmationContext.onConfirm(), true);
                assert.equal(harness.sent.length, 2);
                assert.equal(harness.sent[1].action, 'validate_combo_order');
                assert.equal(harness.sent[1].closePlanToken, 'token-close-submit');

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
                assert.equal(harness.sent.length, 3);
                assert.equal(harness.sent[2].action, 'submit_combo_order');
                assert.equal(harness.sent[2].executionIntent, 'close');
                assert.equal(harness.sent[2].requestSource, 'close_group');
                assert.equal(harness.sent[2].closePlanToken, 'token-close-submit');
                assert.equal(state.groups[0].closeExecution.status, 'pending_submit');
            },
        },
        {
            name: 'keeps targeted close leg scope after validation before submit',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'F1234567',
                    groups: [
                        {
                            id: 'group_close_leg_submit',
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
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_call', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_put', type: 'put', pos: -1, strike: 662, expDate: '2026-04-02', cost: 7.96, closePrice: null },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });

                assert.equal(harness.api.requestCloseLegComboOrder(state.groups[0], state.groups[0].legs[1]), true);
                harness.api._test.applyComboOrderResult({
                    action: 'combo_order_preview_result',
                    groupId: 'group_close_leg_submit',
                    preview: {
                        executionMode: 'preview',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        closePlanToken: 'token-close-leg',
                        closePlanExpiresAt: new Date(Date.now() + 60000).toISOString(),
                        closePlanLegs: [],
                        closePlanOrders: [],
                    },
                });
                assert.equal(harness.confirmationContext.onConfirm(), true);

                const handled = harness.api._test.applyComboOrderValidationResult({
                    action: 'combo_order_validation_result',
                    groupId: 'group_close_leg_submit',
                    validation: {
                        valid: true,
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                    },
                });

                assert.equal(handled, true);
                assert.equal(harness.sent.length, 3);
                assert.equal(harness.sent[2].action, 'submit_combo_order');
                assert.equal(harness.sent[2].executionIntent, 'close');
                assert.equal(harness.sent[2].closeTargetScope, 'leg');
                assert.deepEqual(Array.from(harness.sent[2].closeTargetLegIds), ['leg_put']);
                assert.equal(harness.sent[2].legs.length, 1);
                assert.equal(harness.sent[2].legs[0].id, 'leg_put');
                assert.equal(harness.sent[2].legs[0].pos, 1);
                assert.equal(harness.sent[2].closePlanToken, 'token-close-leg');
                assert.equal(state.groups[0].closeExecution.status, 'pending_submit');
            },
        },
        {
            name: 'cancelled Close Plans are revoked and expired plans never advance to validation',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 730,
                    allowLiveComboOrders: true,
                    selectedLiveComboOrderAccount: 'F1234567',
                    groups: [
                        {
                            id: 'group_cancel_plan',
                            viewMode: 'active',
                            closeExecution: {
                                executionMode: 'submit',
                                strategy: 'auto',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'call', type: 'call', pos: 1, strike: 700, expDate: '2026-07-17', cost: 31, closePrice: null },
                            ],
                        },
                    ],
                    hedges: [],
                };
                const harness = buildHarness({ state });
                const group = state.groups[0];

                harness.api.requestCloseGroupComboOrder(group);
                harness.api._test.applyComboOrderResult({
                    action: 'combo_order_preview_result',
                    groupId: group.id,
                    preview: {
                        executionMode: 'preview',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        closePlanToken: 'cancel-token',
                        closePlanExpiresAt: new Date(Date.now() + 60000).toISOString(),
                    },
                });
                assert.equal(harness.confirmationContext.onCancel(), true);
                assert.equal(harness.sent.length, 2);
                assert.equal(harness.sent[1].action, 'cancel_close_plan');
                assert.equal(harness.sent[1].groupId, group.id);
                assert.equal(harness.sent[1].account, 'F1234567');
                assert.equal(harness.sent[1].confirmationTargetMode, 'submit');
                assert.equal(harness.sent[1].closePlanToken, 'cancel-token');
                assert.equal(group.closeExecution.status, 'plan_cancelled');
                assert.equal(group.closeExecution.lastPreview.closePlanToken, undefined);
                assert.equal(group.closeExecution.lastPreview.closePlanConfirmationStatus, 'cancelled');

                group.closeExecution.pendingConfirmationMode = 'submit';
                group.closeExecution.pendingClosePlanPayload = { action: 'preview_combo_order' };
                group.closeExecution.lastPreview = {
                    closePlanToken: 'expired-token',
                    closePlanExpiresAt: new Date(Date.now() - 1000).toISOString(),
                };
                assert.equal(harness.api._test.confirmClosePlan(group), false);
                assert.equal(harness.sent.length, 2);
                assert.equal(group.closeExecution.status, 'error');
                assert.match(group.closeExecution.lastError, /expired/i);
                assert.equal(group.closeExecution.lastPreview.closePlanToken, undefined);
                assert.equal(group.closeExecution.lastPreview.closePlanConfirmationStatus, 'expired');
                assert.equal(harness.api.handleMessage({
                    action: 'combo_order_close_plan_cancel_result',
                    groupId: group.id,
                    closePlan: { revoked: true, status: 'cancelled' },
                }), true);
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
            name: 'applies full assignment adjustments from a staged underlying close result',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_full_assignment',
                            closeExecution: {
                                executionMode: 'submit',
                                pendingRequest: true,
                                status: 'pending_submit',
                                lastPreview: {
                                    executionMode: 'preview',
                                    executionIntent: 'close',
                                    requestSource: 'close_group',
                                    limitPrice: 4.5,
                                },
                                lastError: '',
                            },
                            legs: [
                                { id: 'assigned_put', type: 'put', pos: -16, strike: 415, expDate: '2026-06-18', cost: 3.2, closePrice: null },
                            ],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                const handled = harness.api._test.applyComboOrderResult({
                    action: 'combo_order_submit_result',
                    groupId: 'group_full_assignment',
                    preview: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group_underlying',
                        closePlanStage: 'underlying',
                        closePlanComplete: false,
                        status: 'Filled',
                        orderId: 8101,
                        permId: 9101,
                        assignmentAdjustments: [
                            {
                                adjustmentId: 'assigned_put:full',
                                optionLegId: 'assigned_put',
                                underlyingLegId: 'assigned_put_underlying',
                                assignedOptionPosition: -16,
                                remainingOptionPosition: 0,
                                underlyingQuantity: 1600,
                                underlyingClosePosition: -1600,
                                assignmentStrike: 415,
                                underlyingAvgFillPrice: 413.21,
                                underlyingOrderId: 8101,
                                underlyingPermId: 9101,
                            },
                        ],
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].closeExecution.status, 'submitted');
                assert.equal(state.groups[0].closeExecution.lastPreview.requestSource, 'close_group_underlying');
                assert.equal(state.groups[0].closeExecution.lastPreview.orderId, 8101);
                assert.equal(state.groups[0].legs[0].closePrice, 0);
                assert.equal(state.groups[0].legs[0].closePriceSource, 'assignment_conversion');

                const underlyingLeg = state.groups[0].legs.find((leg) => leg.id === 'assigned_put_underlying');
                assert.ok(underlyingLeg);
                assert.equal(underlyingLeg.type, 'stock');
                assert.equal(underlyingLeg.pos, 1600);
                assert.equal(underlyingLeg.cost, 415);
                assert.equal(underlyingLeg.closePrice, 413.21);
                assert.equal(underlyingLeg.closePriceSource, 'execution_report');
                assert.equal(harness.renderCalls, 1);
                assert.equal(harness.updateCalls, 1);
            },
        },
        {
            name: 'splits partially assigned option legs before adding the underlying leg',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_partial_assignment',
                            closeExecution: {
                                executionMode: 'submit',
                                pendingRequest: true,
                                status: 'pending_submit',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'short_put', type: 'put', pos: -16, strike: 415, expDate: '2026-06-18', cost: 3.2, closePrice: null },
                            ],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                const handled = harness.api._test.applyComboOrderResult({
                    action: 'combo_order_submit_result',
                    groupId: 'group_partial_assignment',
                    preview: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group_underlying',
                        closePlanStage: 'underlying',
                        closePlanComplete: false,
                        status: 'Submitted',
                        orderId: 8102,
                        permId: 9102,
                        assignmentAdjustments: [
                            {
                                adjustmentId: 'short_put:partial',
                                optionLegId: 'short_put',
                                underlyingLegId: 'short_put_underlying',
                                assignedOptionPosition: -10,
                                remainingOptionPosition: -6,
                                underlyingQuantity: 1000,
                                underlyingClosePosition: -1000,
                                assignmentStrike: 415,
                            },
                        ],
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].legs[0].id, 'short_put');
                assert.equal(state.groups[0].legs[0].pos, -6);

                const assignedLeg = state.groups[0].legs.find((leg) => (
                    leg.assignmentAdjustmentId === 'short_put:partial'
                    && leg.assignmentSourceLegId === 'short_put'
                    && leg.id !== 'short_put'
                ));
                assert.ok(assignedLeg);
                assert.equal(assignedLeg.pos, -10);
                assert.equal(assignedLeg.closePrice, 0);
                assert.equal(assignedLeg.closePriceSource, 'assignment_conversion');

                const underlyingLeg = state.groups[0].legs.find((leg) => leg.id === 'short_put_underlying');
                assert.ok(underlyingLeg);
                assert.equal(underlyingLeg.pos, 1000);
                assert.equal(underlyingLeg.costSource, 'assignment_conversion');
            },
        },
        {
            name: 'books the assignment conversion even when the underlying close nets flat',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_netted_assignment',
                            closeExecution: {
                                executionMode: 'submit',
                                pendingRequest: true,
                                status: 'pending_submit',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'assigned_put', type: 'put', pos: -16, strike: 415, expDate: '2026-06-18', cost: 3.2, closePrice: null },
                            ],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                const handled = harness.api._test.applyComboOrderResult({
                    action: 'combo_order_submit_result',
                    groupId: 'group_netted_assignment',
                    preview: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        status: 'Filled',
                        orderId: 8103,
                        permId: 9103,
                        assignmentAdjustments: [
                            {
                                adjustmentId: 'assigned_put:full',
                                optionLegId: 'assigned_put',
                                underlyingLegId: 'assigned_put_underlying',
                                assignedOptionPosition: -16,
                                remainingOptionPosition: 0,
                                // Deliverable preserved; close-order quantity nets to 0.
                                deliverableUnderlyingPosition: 1600,
                                underlyingQuantity: 0,
                                underlyingClosePosition: 0,
                                assignmentStrike: 415,
                            },
                        ],
                    },
                });

                assert.equal(handled, true);
                // The assigned option leg must be booked as closed (no longer a phantom open leg).
                assert.equal(state.groups[0].legs[0].closePrice, 0);
                assert.equal(state.groups[0].legs[0].closePriceSource, 'assignment_conversion');

                const underlyingLeg = state.groups[0].legs.find((leg) => leg.id === 'assigned_put_underlying');
                assert.ok(underlyingLeg);
                assert.equal(underlyingLeg.type, 'stock');
                assert.equal(underlyingLeg.pos, 1600);
                assert.equal(underlyingLeg.cost, 415);
                assert.equal(underlyingLeg.costSource, 'assignment_conversion');
                // No close fill arrived, so the synthetic underlying leg stays open at strike cost.
                assert.equal(underlyingLeg.closePrice, null);
            },
        },
        {
            name: 'keeps option-stage close status when late underlying updates arrive',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_staged_status',
                            closeExecution: {
                                executionMode: 'submit',
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    executionIntent: 'close',
                                    requestSource: 'close_group',
                                    orderId: 2200,
                                    permId: 2201,
                                    status: 'Submitted',
                                },
                                lastError: '',
                            },
                            legs: [
                                { id: 'assigned_put', type: 'put', pos: -16, strike: 415, expDate: '2026-06-18', cost: 3.2, closePrice: null },
                            ],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                const handled = harness.api._test.applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_staged_status',
                    orderStatus: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group_underlying',
                        orderId: 2100,
                        permId: 2101,
                        status: 'Filled',
                        assignmentAdjustments: [
                            {
                                adjustmentId: 'assigned_put:full',
                                optionLegId: 'assigned_put',
                                underlyingLegId: 'assigned_put_underlying',
                                assignedOptionPosition: -16,
                                remainingOptionPosition: 0,
                                underlyingQuantity: 1600,
                                underlyingClosePosition: -1600,
                                assignmentStrike: 415,
                                underlyingAvgFillPrice: 413.21,
                            },
                        ],
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].closeExecution.lastPreview.orderId, 2200);
                assert.equal(state.groups[0].closeExecution.lastPreview.status, 'Submitted');
                assert.equal(state.groups[0].legs[0].closePrice, 0);
                assert.ok(state.groups[0].legs.find((leg) => leg.id === 'assigned_put_underlying'));
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
            name: 'updates managed status without rebuilding group controls',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_managed_refresh',
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    orderId: 1637,
                                    managedMode: true,
                                    managedState: 'watching',
                                    canConcedePricing: true,
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
                    groupId: 'group_managed_refresh',
                    orderStatus: {
                        executionMode: 'submit',
                        orderId: 1637,
                        status: 'Submitted',
                        managedMode: true,
                        managedState: 'watching',
                        workingLimitPrice: 2.25,
                        latestComboMid: 2.31,
                        canConcedePricing: true,
                    },
                });
                harness.api._test.applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_managed_refresh',
                    orderStatus: {
                        executionMode: 'submit',
                        orderId: 1637,
                        status: 'Submitted',
                        managedMode: true,
                        managedState: 'repricing',
                        workingLimitPrice: 2.27,
                        latestComboMid: 2.33,
                        canConcedePricing: true,
                    },
                });

                assert.equal(harness.renderCalls, 0);
                assert.equal(harness.updateCalls, 2);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.workingLimitPrice, 2.27);
            },
        },
        {
            name: 'sends the entered manual chase step from the active working limit',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_manual_concession',
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    orderId: 1640,
                                    permId: 9101640,
                                    managedMode: true,
                                    managedState: 'watching',
                                    canConcedePricing: true,
                                    workingLimitPrice: 2.50,
                                },
                                lastError: '',
                            },
                            legs: [],
                        },
                    ],
                };
                const harness = buildHarness({ state });

                const requested = harness.api.requestManualConcedeManagedComboOrder(state.groups[0], '0.25');

                assert.equal(requested, true);
                assert.equal(state.groups[0].tradeTrigger.status, 'pending_concede');
                assert.equal(harness.sent.length, 1);
                assert.equal(harness.sent[0].action, 'concede_managed_combo_order');
                assert.equal(harness.sent[0].groupId, 'group_manual_concession');
                assert.equal(harness.sent[0].orderId, 1640);
                assert.equal(harness.sent[0].permId, 9101640);
                assert.equal(harness.sent[0].concessionMode, 'step');
                assert.equal(harness.sent[0].concessionStep, 0.25);
                assert.equal(harness.sent[0].executionIntent, 'open');
                assert.equal(harness.sent[0].requestSource, 'trial_trigger');
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
        {
            name: 'keeps historical single-leg close local and leaves other legs open',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 671.1,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    historicalQuoteDate: '2026-03-19',
                    groups: [
                        {
                            id: 'group_hist_close_leg',
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

                const didSettle = harness.api.requestCloseLegComboOrder(state.groups[0], state.groups[0].legs[1]);

                assert.equal(didSettle, true);
                assert.equal(harness.sent.length, 0);
                assert.equal(state.groups[0].viewMode, 'active');
                assert.equal(state.groups[0].closeExecution.status, 'submitted');
                assert.equal(state.groups[0].closeExecution.lastPreview.closeTargetScope, 'leg');
                assert.deepEqual(Array.from(state.groups[0].closeExecution.lastPreview.closeTargetLegIds), ['leg_put']);
                assert.equal(state.groups[0].legs[0].closePrice, null);
                assert.equal(state.groups[0].legs[1].closePrice, 6.74);
            },
        },
    ],
};
