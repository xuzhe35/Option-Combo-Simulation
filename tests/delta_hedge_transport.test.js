const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function buildController(state, overrides = {}) {
    const ctx = loadBrowserScripts(
        [
            'js/delta_hedge_logic.js',
            'js/delta_hedge_transport.js',
        ],
        {
            state,
        }
    );

    const sentPayloads = [];
    let refreshCalls = 0;
    let managedAccountRequests = 0;

    const controller = ctx.OptionComboDeltaHedgeTransport.createApi({
        state,
        isHistoricalMode: () => overrides.isHistoricalMode === true,
        isWsConnected: () => overrides.isWsConnected !== false,
        sendPayload(payload) {
            sentPayloads.push(payload);
        },
        getSelectedLiveComboOrderAccount: () => overrides.selectedAccount || state.selectedLiveComboOrderAccount || '',
        getLiveHedgeOrderAccountRequirementMessage: () => 'Select a TWS account before sending hedge broker preview.',
        refreshBrokerPreviewUi() {
            refreshCalls += 1;
        },
        requestManagedAccountsSnapshot() {
            managedAccountRequests += 1;
        },
        now: () => '2026-05-03T10:15:30.000Z',
    });

    return {
        controller,
        sentPayloads,
        getRefreshCalls: () => refreshCalls,
        getManagedAccountRequests: () => managedAccountRequests,
    };
}

module.exports = {
    name: 'delta_hedge_transport.js',
    tests: [
        {
            name: 'builds broker preview payloads from actionable recommendations',
            run() {
                const state = {
                    selectedLiveComboOrderAccount: 'DU12345',
                    deltaHedge: {
                        enabled: true,
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
                };
                const { controller } = buildController(state);

                const payload = controller.buildOrderPayload({
                    actionable: true,
                    side: 'SELL',
                    quantity: 55,
                    currentNetDelta: 55,
                    projectedNetDelta: 0,
                    targetLower: -25,
                    targetUpper: 25,
                });

                assert.equal(payload.action, 'validate_hedge_order');
                assert.equal(payload.hedgeId, 'delta_hedge_stk_spy_spot');
                assert.equal(payload.orderAction, 'SELL');
                assert.equal(payload.quantity, 55);
                assert.equal(payload.orderType, 'LMT');
                assert.equal(payload.limitPrice, 481.25);
                assert.equal(payload.account, 'DU12345');
            },
        },
        {
            name: 'requests broker preview through validation payload and pending runtime state',
            run() {
                const state = {
                    selectedLiveComboOrderAccount: 'DU12345',
                    deltaHedge: {
                        enabled: true,
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                        },
                    },
                };
                const { controller, sentPayloads, getRefreshCalls } = buildController(state);

                const requested = controller.requestBrokerPreview({
                    actionable: true,
                    side: 'SELL',
                    quantity: 55,
                    currentNetDelta: 55,
                    projectedNetDelta: 0,
                    targetLower: -25,
                    targetUpper: 25,
                });

                assert.equal(requested, true);
                assert.equal(sentPayloads.length, 1);
                assert.equal(sentPayloads[0].action, 'validate_hedge_order');
                assert.equal(state.deltaHedge.status, 'pending_validation');
                assert.equal(state.deltaHedge.pendingRequest, true);
                assert.deepEqual(state.deltaHedge.pendingPreviewPayload, sentPayloads[0]);
                assert.equal(getRefreshCalls(), 1);
            },
        },
        {
            name: 'requests managed account snapshot when broker preview is blocked by missing account',
            run() {
                const state = {
                    liveComboOrderAccountsConnected: true,
                    liveComboOrderAccounts: ['DU12345'],
                    selectedLiveComboOrderAccount: '',
                    deltaHedge: {
                        enabled: true,
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                        },
                    },
                };
                const { controller, sentPayloads, getManagedAccountRequests } = buildController(state);

                const requested = controller.requestBrokerPreview({
                    actionable: true,
                    side: 'SELL',
                    quantity: 55,
                });

                assert.equal(requested, false);
                assert.equal(sentPayloads.length, 0);
                assert.equal(getManagedAccountRequests(), 1);
                assert.equal(state.deltaHedge.status, 'error');
                assert.match(state.deltaHedge.lastError, /select a tws account/i);
            },
        },
        {
            name: 'submits delta hedge orders after preview and stamps placing runtime state',
            run() {
                const state = {
                    allowLiveHedgeOrders: true,
                    selectedLiveComboOrderAccount: 'DU12345',
                    deltaHedge: {
                        enabled: true,
                        status: 'previewed',
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        lastPreview: {
                            hedgeId: 'delta_hedge_stk_spy_spot',
                            orderId: 7001,
                            permId: 9001,
                        },
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
                };
                const { controller, sentPayloads } = buildController(state);

                const submitted = controller.requestSubmit({
                    actionable: true,
                    side: 'SELL',
                    quantity: 55,
                    currentNetDelta: 55,
                    projectedNetDelta: 0,
                    targetLower: -25,
                    targetUpper: 25,
                });

                assert.equal(submitted, true);
                assert.equal(sentPayloads.length, 1);
                assert.equal(sentPayloads[0].action, 'submit_hedge_order');
                assert.equal(state.deltaHedge.status, 'placing');
                assert.equal(state.deltaHedge.orderState, 'placing');
                assert.equal(state.deltaHedge.lastOrderEventAt, '2026-05-03T10:15:30.000Z');
                assert.deepEqual(state.deltaHedge.pendingSubmitPayload, sentPayloads[0]);
            },
        },
        {
            name: 'cancels active hedge orders without requiring live submit gate',
            run() {
                const state = {
                    deltaHedge: {
                        enabled: true,
                        restingOrder: {
                            hedgeId: 'delta_hedge_stk_spy_spot',
                            orderId: 7001,
                            permId: 9001,
                            status: 'Submitted',
                        },
                    },
                };
                const { controller, sentPayloads } = buildController(state);

                const canceled = controller.requestCancel({
                    requestSource: 'delta_hedge_auto_stale_cancel',
                    reason: 'auto_stale_cancel',
                });

                assert.equal(canceled, true);
                assert.equal(sentPayloads.length, 1);
                assert.equal(sentPayloads[0].action, 'cancel_hedge_order');
                assert.equal(sentPayloads[0].hedgeId, 'delta_hedge_stk_spy_spot');
                assert.equal(sentPayloads[0].orderId, 7001);
                assert.equal(sentPayloads[0].permId, 9001);
                assert.equal(sentPayloads[0].requestSource, 'delta_hedge_auto_stale_cancel');
                assert.equal(sentPayloads[0].reason, 'auto_stale_cancel');
                assert.equal(state.deltaHedge.status, 'cancel_pending');
                assert.equal(state.deltaHedge.pendingRequest, true);
                assert.equal(state.deltaHedge.lastOrderEventAt, '2026-05-03T10:15:30.000Z');
            },
        },
    ],
};
