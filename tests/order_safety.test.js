const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'order_safety.js',
    tests: [
        {
            name: 'binds a hedge preview to the frozen single-leg intent',
            run() {
                const ctx = loadBrowserScripts(['js/leg_position_check.js', 'js/order_safety.js']);
                const state = {
                    selectedLiveComboOrderAccount: 'DU1',
                    deltaHedge: { orderType: 'LMT', limitPrice: 500, hedgeInstrument: { secType: 'FUT', symbol: 'ES', contractMonth: '202609', multiplier: 50 } },
                };
                const intent = ctx.OptionComboOrderSafety.buildHedgeIntent(state, { actionable: true, side: 'SELL', quantity: 2 });
                assert.equal(ctx.OptionComboOrderSafety.previewMatchesIntent({ account: 'DU1', secType: 'FUT', symbol: 'ES', contractMonth: '20260918', multiplier: '50', orderAction: 'SELL', quantity: 2, orderType: 'LMT', limitPrice: 500 }, intent), true);
                assert.equal(ctx.OptionComboOrderSafety.previewMatchesIntent({ account: 'DU1', secType: 'FUT', symbol: 'ES', contractMonth: '20260918', multiplier: '50', orderAction: 'SELL', quantity: 3, orderType: 'LMT', limitPrice: 500 }, intent), false);
            },
        },
        {
            name: 'reports reductions of allocated group positions for delta hedge intent',
            run() {
                const ctx = loadBrowserScripts(['js/product_registry.js', 'js/group_order_builder.js', 'js/leg_position_check.js', 'js/order_safety.js']);
                const state = {
                    underlyingSymbol: 'SPY', selectedLiveComboOrderAccount: 'DU1', portfolioPositionsConnected: true,
                    portfolioPositions: [{ account: 'DU1', secType: 'STK', symbol: 'SPY', position: 100 }],
                    groups: [{ id: 'assigned', name: 'Assigned Shares', legs: [{ id: 'stock', type: 'stock', pos: 100 }] }], hedges: [],
                    deltaHedge: { orderType: 'LMT', limitPrice: 500, hedgeInstrument: { secType: 'STK', symbol: 'SPY', multiplier: 1 } },
                };
                const intent = ctx.OptionComboOrderSafety.buildHedgeIntent(state, { side: 'SELL', quantity: 80 });
                const impact = ctx.OptionComboOrderSafety.analyzePositionImpact(intent, state);
                assert.equal(impact.available, true);
                assert.equal(impact.warnings.length, 1);
                assert.deepEqual(Array.from(impact.warnings[0].otherGroupNames), ['Assigned Shares']);
            },
        },
    ],
};
