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
            name: 'uses the default combo price increment for ES payload profiles',
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
                assert.equal(payload.profile.priceIncrement, 0.01);
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
            name: 'builds MES and MNQ order payloads with micro futures multipliers',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                ]);

                [
                    { symbol: 'MES', multiplier: '5', strike: 5400 },
                    { symbol: 'MNQ', multiplier: '2', strike: 19500 },
                ].forEach(({ symbol, multiplier, strike }) => {
                    const payload = ctx.OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(
                        {
                            id: `group_${symbol.toLowerCase()}`,
                            name: `${symbol} Builder Test`,
                            legs: [
                                { id: `leg_${symbol.toLowerCase()}_future`, type: 'underlying', pos: 1 },
                                { id: `leg_${symbol.toLowerCase()}_call`, type: 'call', pos: -1, strike, expDate: '2026-06-19' },
                            ],
                        },
                        {
                            underlyingSymbol: symbol,
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

                    assert.equal(payload.profile.family, symbol);
                    assert.equal(payload.profile.optionExchange, 'CME');
                    assert.equal(payload.profile.underlyingExchange, 'CME');
                    assert.equal(payload.legs[0].secType, 'FUT');
                    assert.equal(payload.legs[0].symbol, symbol);
                    assert.equal(payload.legs[0].multiplier, multiplier);
                    assert.equal(payload.legs[1].secType, 'FOP');
                    assert.equal(payload.legs[1].symbol, symbol);
                    assert.equal(payload.legs[1].multiplier, multiplier);
                    assert.equal(payload.legs[1].underlyingMultiplier, multiplier);
                    assert.equal(payload.legs[1].underlyingContractMonth, '202606');
                    assert.equal(Object.prototype.hasOwnProperty.call(payload.legs[1], 'tradingClass'), true);
                    assert.equal(payload.legs[1].tradingClass, undefined);
                });
            },
        },
        {
            name: 'uses per-leg futures pool contract months for FOP order payloads',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                ]);

                const payload = ctx.OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(
                    {
                        id: 'group_mes_calendar',
                        name: 'MES Calendar',
                        legs: [
                            {
                                id: 'leg_mes_call',
                                type: 'call',
                                pos: 5,
                                strike: 7550,
                                expDate: '2026-07-17',
                                underlyingFutureId: 'future_sep',
                            },
                        ],
                    },
                    {
                        underlyingSymbol: 'MES',
                        underlyingContractMonth: '202606',
                        baseDate: '2026-07-01',
                        simulatedDate: '2026-07-01',
                        futuresPool: [
                            { id: 'future_jun', contractMonth: '202606' },
                            { id: 'future_sep', contractMonth: '202609' },
                        ],
                    },
                    {
                        action: 'preview_combo_order',
                        executionMode: 'preview',
                        intent: 'open',
                        source: 'trial_trigger',
                    }
                );

                assert.equal(payload.legs.length, 1);
                assert.equal(payload.legs[0].secType, 'FOP');
                assert.equal(payload.legs[0].symbol, 'MES');
                assert.equal(payload.legs[0].underlyingContractMonth, '202609');
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
        {
            name: 'falls back to default equity contracts when product registry is unavailable',
            run() {
                const ctx = loadBrowserScripts([
                    'js/group_order_builder.js',
                ]);

                const payload = ctx.OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(
                    {
                        id: 'group_no_registry',
                        name: 'No Registry',
                        legs: [
                            { id: 'leg_1', type: 'call', pos: 1, strike: 500, expDate: '2026-04-17' },
                            { id: 'leg_2', type: 'stock', pos: 100, strike: 0, expDate: '' },
                        ],
                    },
                    {
                        underlyingSymbol: 'SPY',
                        underlyingContractMonth: '',
                        baseDate: '2026-03-15',
                        simulatedDate: '2026-03-15',
                    },
                    {
                        executionMode: 'preview',
                        intent: 'open',
                    }
                );

                assert.equal(payload.profile.family, 'DEFAULT_EQUITY');
                assert.equal(payload.legs[0].secType, 'OPT');
                assert.equal(payload.legs[0].symbol, 'SPY');
                assert.equal(payload.legs[1].secType, 'STK');
                assert.equal(payload.legs[1].symbol, 'SPY');
            },
        },
    ],
};
