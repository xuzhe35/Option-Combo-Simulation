const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadApi() {
    return loadBrowserScripts([
        'js/product_registry.js',
        'js/group_order_builder.js',
        'js/leg_position_check.js',
    ]).OptionComboLegPositionCheck;
}

const state = {
    underlyingSymbol: 'SPY',
    underlyingContractMonth: '',
    baseDate: '2026-07-11',
    simulatedDate: '2026-07-11',
};

module.exports = {
    name: 'leg_position_check.js',
    tests: [
        {
            name: 'checks one group for missing and quantity-mismatched TWS legs',
            run() {
                const api = loadApi();
                const group = {
                    id: 'g1',
                    name: 'Call Spread',
                    legs: [
                        { id: 'a', type: 'call', pos: 2, strike: 600, expDate: '2026-09-18' },
                        { id: 'b', type: 'call', pos: -2, strike: 610, expDate: '2026-09-18' },
                    ],
                };
                const result = api.compare([group], state, [{
                    account: 'U1', secType: 'OPT', symbol: 'SPY', expDate: '20260918', right: 'C', strike: 600, position: 1,
                }], 'U1');

                assert.equal(result.ok, false);
                assert.equal(result.issues, 2);
                assert.deepEqual(Array.from(result.rows, (row) => row.status).sort(), ['missing', 'quantity_mismatch']);
            },
        },
        {
            name: 'global check nets identical contracts across groups',
            run() {
                const api = loadApi();
                const groups = [
                    { id: 'g1', name: 'Long', legs: [{ id: 'a', type: 'put', pos: 3, strike: 550, expDate: '2026-09-18' }] },
                    { id: 'g2', name: 'Short', legs: [{ id: 'b', type: 'put', pos: -1, strike: 550, expDate: '2026-09-18' }] },
                ];
                const result = api.compare(groups, state, [{
                    account: 'U1', secType: 'OPT', symbol: 'SPY', expDate: '20260918', right: 'P', strike: 550, position: 2,
                }], 'U1');

                assert.equal(result.ok, true);
                assert.equal(result.rows.length, 1);
                assert.equal(result.rows[0].expected, 2);
                assert.deepEqual(Array.from(result.rows[0].groupNames), ['Long', 'Short']);
            },
        },
        {
            name: 'warns when a new leg reduces a TWS position used by another group',
            run() {
                const api = loadApi();
                const orderLeg = { id: 'new', secType: 'OPT', symbol: 'SPY', expDate: '20260918', right: 'C', strike: 600, pos: -2 };
                const warnings = api.findOrderReductions(
                    [orderLeg],
                    state,
                    [{ account: 'U1', secType: 'OPT', symbol: 'SPY', expDate: '20260918', right: 'C', strike: 600, position: 5 }],
                    'U1',
                    [{ id: 'existing', name: 'Existing Group', legs: [{ id: 'old', type: 'call', pos: 5, strike: 600, expDate: '2026-09-18' }] }],
                    'new-group'
                );

                assert.equal(warnings.length, 1);
                assert.equal(warnings[0].projected, 3);
                assert.equal(warnings[0].reducedQuantity, 2);
                assert.deepEqual(Array.from(warnings[0].otherGroupNames), ['Existing Group']);
            },
        },
        {
            name: 'excludes legs already closed in the workspace',
            run() {
                const api = loadApi();
                const result = api.compare([{
                    id: 'settled', name: 'Settled',
                    legs: [{ id: 'done', type: 'put', pos: -1, strike: 500, expDate: '2026-09-18', closePrice: 0.5 }],
                }], state, [], 'U1');

                assert.equal(result.rows.length, 0);
                assert.equal(result.issues, 0);
            },
        },
    ],
};
