const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'trade_trigger_logic.js',
    tests: [
        {
            name: 'normalizes default trigger state and trigger firing rules',
            run() {
                const ctx = loadBrowserScripts([
                    'js/session_logic.js',
                    'js/group_order_builder.js',
                    'js/trade_trigger_logic.js',
                ]);

                const trigger = ctx.OptionComboTradeTriggerLogic.normalizeTradeTrigger({
                    enabled: true,
                    condition: 'gte',
                    price: '502.5',
                });

                assert.equal(trigger.enabled, true);
                assert.equal(trigger.condition, 'gte');
                assert.equal(trigger.price, 502.5);
                assert.equal(trigger.executionMode, 'preview');
                assert.equal(trigger.repriceThreshold, 0.01);
                assert.equal(trigger.timeInForce, 'DAY');
                assert.equal(trigger.exitEnabled, false);
                assert.equal(trigger.exitCondition, 'lte');
                assert.equal(trigger.exitPrice, null);
                assert.equal(trigger.isExpanded, false);

                const group = {
                    viewMode: 'trial',
                    liveData: true,
                    tradeTrigger: trigger,
                    legs: [{ cost: 0 }],
                };

                assert.equal(
                    ctx.OptionComboTradeTriggerLogic.shouldFireTradeTrigger(group, 503, 'trial'),
                    true
                );
                assert.equal(
                    ctx.OptionComboTradeTriggerLogic.shouldFireTradeTrigger(group, 500, 'trial'),
                    false
                );
            },
        },
        {
            name: 'builds combo-order payloads from group legs and product metadata',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                    'js/trade_trigger_logic.js',
                ]);

                const payload = ctx.OptionComboTradeTriggerLogic.buildComboOrderRequestPayload(
                    {
                        id: 'group_1',
                        name: 'Test Trigger',
                        tradeTrigger: {
                            enabled: true,
                            executionMode: 'preview',
                            repriceThreshold: 0.02,
                            timeInForce: 'GTC',
                        },
                        legs: [
                            {
                                id: 'leg_1',
                                type: 'call',
                                pos: 1,
                                strike: 500,
                                expDate: '2026-04-17',
                            },
                            {
                                id: 'leg_2',
                                type: 'call',
                                pos: -1,
                                strike: 510,
                                expDate: '2026-04-17',
                            },
                        ],
                    },
                    {
                        underlyingSymbol: 'SPY',
                        underlyingContractMonth: '',
                        baseDate: '2026-03-15',
                        simulatedDate: '2026-03-15',
                    }
                );

                assert.equal(payload.action, 'preview_combo_order');
                assert.equal(payload.managedRepriceThreshold, 0.02);
                assert.equal(payload.timeInForce, 'GTC');
                assert.equal(payload.groupId, 'group_1');
                assert.equal(payload.legs.length, 2);
                assert.equal(payload.legs[0].secType, 'OPT');
                assert.equal(payload.legs[0].symbol, 'SPY');
                assert.equal(payload.legs[0].right, 'C');
                assert.equal(payload.legs[1].pos, -1);
            },
        },
        {
            name: 'routes test-submit trigger mode through submit action payloads',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_order_builder.js',
                    'js/trade_trigger_logic.js',
                ]);

                const payload = ctx.OptionComboTradeTriggerLogic.buildComboOrderRequestPayload(
                    {
                        id: 'group_test',
                        name: 'Test Trigger',
                        tradeTrigger: {
                            enabled: true,
                            executionMode: 'test_submit',
                        },
                        legs: [
                            {
                                id: 'leg_1',
                                type: 'put',
                                pos: 1,
                                strike: 500,
                                expDate: '2026-04-17',
                            },
                        ],
                    },
                    {
                        underlyingSymbol: 'SPY',
                        underlyingContractMonth: '',
                        baseDate: '2026-03-15',
                        simulatedDate: '2026-03-15',
                    }
                );

                assert.equal(payload.action, 'submit_combo_order');
                assert.equal(payload.executionMode, 'test_submit');
            },
        },
        {
            name: 'fires exit condition only after a live order exists and remains open',
            run() {
                const ctx = loadBrowserScripts([
                    'js/group_order_builder.js',
                    'js/trade_trigger_logic.js',
                ]);

                const group = {
                    tradeTrigger: {
                        exitEnabled: true,
                        exitCondition: 'lte',
                        exitPrice: 671.0,
                        pendingRequest: false,
                        lastPreview: {
                            orderId: 2187,
                            status: 'Submitted',
                            executionMode: 'submit',
                        },
                    },
                };

                assert.equal(
                    ctx.OptionComboTradeTriggerLogic.shouldCancelTriggeredOrder(group, 670.95),
                    true
                );
                assert.equal(
                    ctx.OptionComboTradeTriggerLogic.shouldCancelTriggeredOrder(group, 671.2),
                    false
                );
            },
        },
    ],
};
