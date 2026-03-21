const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'group_order_builder.js',
    tests: [
        {
            name: 'builds open-intent payloads with explicit execution metadata',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                ]);

                const payload = ctx.OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(
                    {
                        id: 'group_open',
                        name: 'Open Builder Test',
                        legs: [
                            { id: 'leg_1', type: 'call', pos: 1, strike: 500, expDate: '2026-04-17' },
                            { id: 'leg_2', type: 'call', pos: -1, strike: 510, expDate: '2026-04-17' },
                        ],
                    },
                    {
                        underlyingSymbol: 'SPY',
                        underlyingContractMonth: '',
                        baseDate: '2026-03-15',
                        simulatedDate: '2026-03-15',
                    },
                    {
                        action: 'submit_combo_order',
                        executionMode: 'submit',
                        intent: 'open',
                        source: 'trial_trigger',
                        managedRepriceThreshold: 0.02,
                        timeInForce: 'GTC',
                    }
                );

                assert.equal(payload.executionIntent, 'open');
                assert.equal(payload.requestSource, 'trial_trigger');
                assert.equal(payload.timeInForce, 'GTC');
                assert.equal(payload.managedRepriceThreshold, 0.02);
                assert.equal(payload.legs[0].pos, 1);
                assert.equal(payload.legs[1].pos, -1);
            },
        },
        {
            name: 'builds close-intent leg requests by reversing group positions',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                ]);

                const payload = ctx.OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(
                    {
                        id: 'group_close',
                        name: 'Close Builder Test',
                        legs: [
                            { id: 'leg_1', type: 'call', pos: 2, strike: 500, expDate: '2026-04-17' },
                            { id: 'leg_2', type: 'put', pos: -3, strike: 480, expDate: '2026-04-17' },
                        ],
                    },
                    {
                        underlyingSymbol: 'SPY',
                        underlyingContractMonth: '',
                        baseDate: '2026-03-15',
                        simulatedDate: '2026-03-15',
                    },
                    {
                        executionMode: 'submit',
                        intent: 'close',
                        source: 'close_group',
                    }
                );

                assert.equal(payload.executionIntent, 'close');
                assert.equal(payload.requestSource, 'close_group');
                assert.equal(payload.legs[0].pos, -2);
                assert.equal(payload.legs[1].pos, 3);
            },
        },
    ],
};
