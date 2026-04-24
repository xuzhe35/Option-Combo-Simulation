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
                        selectedLiveComboOrderAccount: 'F1234567',
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
                assert.equal(payload.account, 'F1234567');
                assert.equal(payload.profile.priceIncrement, 0.01);
                assert.equal(payload.legs[0].pos, 1);
                assert.equal(payload.legs[1].pos, -1);
            },
        },
        {
            name: 'includes ES quarter-point combo price increment in payload profiles',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                ]);

                const payload = ctx.OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(
                    {
                        id: 'group_es',
                        name: 'ES Builder Test',
                        legs: [
                            { id: 'leg_1', type: 'call', pos: 1, strike: 5400, expDate: '2026-06-19' },
                            { id: 'leg_2', type: 'call', pos: -1, strike: 5450, expDate: '2026-06-19' },
                        ],
                    },
                    {
                        underlyingSymbol: 'ES',
                        underlyingContractMonth: '202606',
                        baseDate: '2026-04-16',
                        simulatedDate: '2026-04-16',
                    },
                    {
                        action: 'submit_combo_order',
                        executionMode: 'submit',
                        intent: 'open',
                        source: 'trial_trigger',
                    }
                );

                assert.equal(payload.profile.family, 'ES');
                assert.equal(payload.profile.priceIncrement, 0.25);
            },
        },
        {
            name: 'includes family-specific combo price increment in payload profiles',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                ]);

                const payload = ctx.OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(
                    {
                        id: 'group_hg',
                        name: 'HG Builder Test',
                        legs: [
                            { id: 'leg_1', type: 'call', pos: 5, strike: 6.25, expDate: '2026-07-28' },
                            { id: 'leg_2', type: 'put', pos: 5, strike: 6.25, expDate: '2026-07-28' },
                        ],
                    },
                    {
                        underlyingSymbol: 'HG',
                        underlyingContractMonth: '202607',
                        baseDate: '2026-04-16',
                        simulatedDate: '2026-04-16',
                    },
                    {
                        action: 'submit_combo_order',
                        executionMode: 'submit',
                        intent: 'open',
                        source: 'trial_trigger',
                    }
                );

                assert.equal(payload.profile.family, 'HG');
                assert.equal(payload.profile.priceIncrement, 0.0005);
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
        {
            name: 'close-intent payload excludes already-closed assignment-converted option legs',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                ]);

                const payload = ctx.OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(
                    {
                        id: 'group_close_assignment',
                        name: 'Close Assignment Test',
                        legs: [
                            {
                                id: 'put_685',
                                type: 'put',
                                pos: -4,
                                strike: 685,
                                expDate: '2026-03-27',
                                closePrice: 0,
                                closePriceSource: 'assignment_conversion',
                            },
                            {
                                id: 'stock_685',
                                type: 'stock',
                                pos: 400,
                                strike: 0,
                                expDate: '',
                                cost: 685,
                                assignmentSourceLegId: 'put_685',
                            },
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

                assert.equal(payload.legs.length, 1);
                assert.equal(payload.legs[0].id, 'stock_685');
                assert.equal(payload.legs[0].type, 'stock');
                assert.equal(payload.legs[0].pos, -400);
            },
        },
    ],
};
