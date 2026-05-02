const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadContext() {
    return loadBrowserScripts([
        'js/delta_hedge_logic.js',
    ]);
}

module.exports = {
    name: 'delta_hedge_logic.js',
    tests: [
        {
            name: 'normalizes default delta hedge config',
            run() {
                const ctx = loadContext();

                const config = ctx.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig({
                    enabled: true,
                    targetDelta: '10',
                    tolerance: '25',
                    proactiveBuffer: '5',
                    hedgeInstrument: {
                        secType: 'stk',
                        symbol: 'spy',
                        exchange: '',
                        currency: '',
                        multiplier: '1',
                        deltaPerUnit: '1',
                    },
                    orderType: 'mkt',
                    maxOrderQuantity: '100',
                });

                assert.equal(config.enabled, true);
                assert.equal(config.targetDelta, 10);
                assert.equal(config.tolerance, 25);
                assert.equal(config.proactiveBuffer, 5);
                assert.equal(config.hedgeInstrument.secType, 'STK');
                assert.equal(config.hedgeInstrument.symbol, 'SPY');
                assert.equal(config.hedgeInstrument.exchange, 'SMART');
                assert.equal(config.hedgeInstrument.currency, 'USD');
                assert.equal(config.orderType, 'MKT');
                assert.equal(config.maxOrderQuantity, 100);
            },
        },
        {
            name: 'inside tolerance band produces no hedge action',
            run() {
                const ctx = loadContext();

                const recommendation = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                    portfolioDeltaSummary: {
                        portfolioDeltaAvailable: true,
                        portfolioNetDelta: 42,
                    },
                    config: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 50,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
                    greeksEnabled: true,
                    liveMode: true,
                });

                assert.equal(recommendation.actionable, false);
                assert.equal(recommendation.reason, 'inside_tolerance');
                assert.equal(recommendation.currentNetDelta, 42);
                assert.equal(recommendation.targetLower, -50);
                assert.equal(recommendation.targetUpper, 50);
            },
        },
        {
            name: 'proactive buffer arms hedge before the hard tolerance edge',
            run() {
                const ctx = loadContext();

                const recommendation = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                    portfolioDeltaSummary: {
                        portfolioDeltaAvailable: true,
                        portfolioNetDelta: 45,
                    },
                    config: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 50,
                        proactiveBuffer: 10,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
                    greeksEnabled: true,
                    liveMode: true,
                });

                assert.equal(recommendation.actionable, true);
                assert.equal(recommendation.side, 'SELL');
                assert.equal(recommendation.quantity, 45);
                assert.equal(recommendation.targetUpper, 50);
                assert.equal(recommendation.triggerUpper, 40);
            },
        },
        {
            name: 'positive net delta recommends selling stock hedge',
            run() {
                const ctx = loadContext();

                const recommendation = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                    portfolioDeltaSummary: {
                        portfolioDeltaAvailable: true,
                        portfolioNetDelta: 150,
                    },
                    config: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
                    greeksEnabled: true,
                    liveMode: true,
                });

                assert.equal(recommendation.actionable, true);
                assert.equal(recommendation.reason, '');
                assert.equal(recommendation.side, 'SELL');
                assert.equal(recommendation.quantity, 150);
                assert.equal(recommendation.projectedNetDelta, 0);
            },
        },
        {
            name: 'negative net delta recommends buying stock hedge',
            run() {
                const ctx = loadContext();

                const recommendation = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                    portfolioDeltaSummary: {
                        portfolioDeltaAvailable: true,
                        portfolioNetDelta: -62,
                    },
                    config: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
                    greeksEnabled: true,
                    liveMode: true,
                });

                assert.equal(recommendation.actionable, true);
                assert.equal(recommendation.side, 'BUY');
                assert.equal(recommendation.quantity, 62);
                assert.equal(recommendation.projectedNetDelta, 0);
            },
        },
        {
            name: 'futures multiplier sizes recommendation by contract delta unit',
            run() {
                const ctx = loadContext();

                const recommendation = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                    portfolioDeltaSummary: {
                        portfolioDeltaAvailable: true,
                        portfolioNetDelta: 120,
                    },
                    config: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'FUT',
                            symbol: 'ES',
                            contractMonth: '202606',
                            multiplier: 50,
                            deltaPerUnit: 1,
                        },
                    },
                    greeksEnabled: true,
                    liveMode: true,
                });

                assert.equal(recommendation.actionable, true);
                assert.equal(recommendation.side, 'SELL');
                assert.equal(recommendation.quantity, 2);
                assert.equal(recommendation.hedgeDeltaPerUnit, 50);
                assert.equal(recommendation.projectedNetDelta, 20);
            },
        },
        {
            name: 'missing or unavailable delta blocks recommendation',
            run() {
                const ctx = loadContext();

                const recommendation = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                    portfolioDeltaSummary: {
                        portfolioDeltaAvailable: false,
                        portfolioNetDelta: 120,
                        portfolioDeltaMissingGroupCount: 1,
                    },
                    config: {
                        enabled: true,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                        },
                    },
                    greeksEnabled: true,
                    liveMode: true,
                });

                assert.equal(recommendation.actionable, false);
                assert.equal(recommendation.reason, 'delta_unavailable');
            },
        },
        {
            name: 'pending hedge order blocks duplicate recommendation',
            run() {
                const ctx = loadContext();

                const recommendation = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                    portfolioDeltaSummary: {
                        portfolioDeltaAvailable: true,
                        portfolioNetDelta: 120,
                    },
                    config: {
                        enabled: true,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                        },
                    },
                    greeksEnabled: true,
                    liveMode: true,
                    pendingHedgeOrder: true,
                });

                assert.equal(recommendation.actionable, false);
                assert.equal(recommendation.reason, 'pending_hedge_order');
            },
        },
        {
            name: 'projected net delta outside target band requires manual review',
            run() {
                const ctx = loadContext();

                const recommendation = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                    portfolioDeltaSummary: {
                        portfolioDeltaAvailable: true,
                        portfolioNetDelta: 140,
                    },
                    config: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'FUT',
                            symbol: 'ES',
                            multiplier: 100,
                            deltaPerUnit: 1,
                        },
                    },
                    greeksEnabled: true,
                    liveMode: true,
                });

                assert.equal(recommendation.actionable, false);
                assert.equal(recommendation.reason, 'projected_outside_tolerance');
                assert.equal(recommendation.side, 'SELL');
                assert.equal(recommendation.quantity, 1);
                assert.equal(recommendation.projectedNetDelta, 40);
            },
        },
        {
            name: 'selects midpoint before mark for hedge reference price',
            run() {
                const ctx = loadContext();

                const reference = ctx.OptionComboDeltaHedgeLogic.selectHedgeReferencePrice({
                    bid: 99.99,
                    ask: 100.01,
                    mark: 99.5,
                });

                assert.equal(reference.price, 100);
                assert.equal(reference.source, 'midpoint');
            },
        },
        {
            name: 'falls back to mark for hedge reference price',
            run() {
                const ctx = loadContext();

                const reference = ctx.OptionComboDeltaHedgeLogic.selectHedgeReferencePrice({
                    mark: 512.25,
                    last: 512.5,
                });

                assert.equal(reference.price, 512.25);
                assert.equal(reference.source, 'mark');
            },
        },
        {
            name: 'calculates default BUY limit 0.1 percent below reference',
            run() {
                const ctx = loadContext();

                const result = ctx.OptionComboDeltaHedgeLogic.calculateDefaultHedgeLimitPrice({
                    side: 'BUY',
                    quote: {
                        bid: 99.99,
                        ask: 100.01,
                    },
                    tickSize: 0.01,
                });

                assert.equal(result.limitPrice, 99.9);
                assert.equal(result.referencePrice, 100);
                assert.equal(result.source, 'midpoint');
                assert.equal(result.tickSize, 0.01);
            },
        },
        {
            name: 'calculates default SELL limit 0.1 percent above reference',
            run() {
                const ctx = loadContext();

                const result = ctx.OptionComboDeltaHedgeLogic.calculateDefaultHedgeLimitPrice({
                    side: 'SELL',
                    quote: {
                        bid: 99.99,
                        ask: 100.01,
                    },
                    tickSize: 0.01,
                });

                assert.equal(result.limitPrice, 100.1);
                assert.equal(result.referencePrice, 100);
                assert.equal(result.source, 'midpoint');
            },
        },
        {
            name: 'rounds hedge limit away from market using tick size',
            run() {
                const ctx = loadContext();

                const buy = ctx.OptionComboDeltaHedgeLogic.calculateDefaultHedgeLimitPrice({
                    side: 'BUY',
                    quote: { mark: 5125.12 },
                    tickSize: 0.25,
                });
                const sell = ctx.OptionComboDeltaHedgeLogic.calculateDefaultHedgeLimitPrice({
                    side: 'SELL',
                    quote: { mark: 5125.12 },
                    tickSize: 0.25,
                });

                assert.equal(buy.limitPrice, 5119.75);
                assert.equal(sell.limitPrice, 5130.25);
            },
        },
        {
            name: 'blocks default hedge limit price when reference quote is missing',
            run() {
                const ctx = loadContext();

                const result = ctx.OptionComboDeltaHedgeLogic.calculateDefaultHedgeLimitPrice({
                    side: 'BUY',
                    quote: {
                        bid: null,
                        ask: null,
                        mark: null,
                    },
                    tickSize: 0.01,
                });

                assert.equal(result, null);
            },
        },
        {
            name: 'detects active resting hedge orders',
            run() {
                const ctx = loadContext();

                assert.equal(ctx.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder({
                    orderState: 'resting_locked',
                    restingOrder: {
                        orderId: 1001,
                        status: 'Submitted',
                    },
                }), true);
                assert.equal(ctx.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder({
                    orderState: 'filled',
                    restingOrder: {
                        orderId: 1001,
                        status: 'Filled',
                    },
                }), false);
                assert.equal(ctx.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder({
                    orderState: 'stale_needs_review',
                    restingOrder: {
                        orderId: 1001,
                        status: 'Cancelled',
                    },
                }), false);
                assert.equal(ctx.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder({
                    orderState: 'stale_needs_review',
                    restingOrder: {
                        orderId: 1001,
                        status: 'Submitted',
                    },
                }), true);
            },
        },
        {
            name: 'keeps matching active resting hedge order locked',
            run() {
                const ctx = loadContext();

                const result = ctx.OptionComboDeltaHedgeLogic.evaluateRestingHedgeOrderApplicability({
                    restingOrder: {
                        side: 'BUY',
                        quantity: 60,
                        remainingQuantity: 60,
                        projectedNetDeltaAfterFullFill: 0,
                    },
                    recommendation: {
                        actionable: true,
                        side: 'BUY',
                        quantity: 60,
                        projectedNetDelta: 0,
                        targetLower: -25,
                        targetUpper: 25,
                    },
                });

                assert.equal(result.orderState, 'resting_locked');
                assert.equal(result.stale, false);
                assert.equal(result.reason, '');
            },
        },
        {
            name: 'marks resting hedge order stale when delta returns inside tolerance',
            run() {
                const ctx = loadContext();

                const result = ctx.OptionComboDeltaHedgeLogic.evaluateRestingHedgeOrderApplicability({
                    restingOrder: {
                        side: 'BUY',
                        quantity: 60,
                        remainingQuantity: 60,
                    },
                    recommendation: {
                        actionable: false,
                        reason: 'inside_tolerance',
                        targetLower: -25,
                        targetUpper: 25,
                    },
                });

                assert.equal(result.orderState, 'stale_needs_review');
                assert.equal(result.stale, true);
                assert.equal(result.reason, 'delta_inside_tolerance');
            },
        },
        {
            name: 'marks resting hedge order stale when side reverses',
            run() {
                const ctx = loadContext();

                const result = ctx.OptionComboDeltaHedgeLogic.evaluateRestingHedgeOrderApplicability({
                    restingOrder: {
                        side: 'BUY',
                        quantity: 60,
                        remainingQuantity: 60,
                    },
                    recommendation: {
                        actionable: true,
                        side: 'SELL',
                        quantity: 20,
                        projectedNetDelta: 0,
                        targetLower: -25,
                        targetUpper: 25,
                    },
                });

                assert.equal(result.orderState, 'stale_needs_review');
                assert.equal(result.stale, true);
                assert.equal(result.reason, 'opposite_side_required');
            },
        },
        {
            name: 'marks resting hedge order stale when remaining quantity changes materially',
            run() {
                const ctx = loadContext();

                const result = ctx.OptionComboDeltaHedgeLogic.evaluateRestingHedgeOrderApplicability({
                    restingOrder: {
                        side: 'SELL',
                        quantity: 60,
                        remainingQuantity: 60,
                    },
                    recommendation: {
                        actionable: true,
                        side: 'SELL',
                        quantity: 55,
                        projectedNetDelta: 0,
                        targetLower: -25,
                        targetUpper: 25,
                    },
                    quantityTolerance: 0,
                });

                assert.equal(result.orderState, 'stale_needs_review');
                assert.equal(result.stale, true);
                assert.equal(result.reason, 'quantity_changed');
            },
        },
        {
            name: 'auto hedge supervisor requests preview before unattended submit',
            run() {
                const ctx = loadContext();
                const config = ctx.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig({
                    enabled: true,
                    autoSubmitEnabled: true,
                    limitPrice: 99.9,
                    hedgeInstrument: {
                        secType: 'STK',
                        symbol: 'SPY',
                        exchange: 'SMART',
                        currency: 'USD',
                        multiplier: 1,
                        deltaPerUnit: 1,
                    },
                });
                const recommendation = {
                    actionable: true,
                    side: 'BUY',
                    quantity: 60,
                    orderType: 'LMT',
                    projectedNetDelta: 0,
                    hedgeInstrument: config.hedgeInstrument,
                };

                const decision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: config,
                    recommendation,
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });

                assert.equal(decision.action, 'request_preview');
                assert.equal(decision.reason, 'broker_preview_required');
            },
        },
        {
            name: 'auto hedge supervisor submits only after matching fresh preview',
            run() {
                const ctx = loadContext();
                const config = ctx.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig({
                    enabled: true,
                    autoSubmitEnabled: true,
                    limitPrice: 99.9,
                    hedgeInstrument: {
                        secType: 'STK',
                        symbol: 'SPY',
                        exchange: 'SMART',
                        currency: 'USD',
                        multiplier: 1,
                        deltaPerUnit: 1,
                    },
                });
                const recommendation = {
                    actionable: true,
                    side: 'BUY',
                    quantity: 60,
                    orderType: 'LMT',
                    limitPrice: 99.9,
                    projectedNetDelta: 0,
                    hedgeInstrument: config.hedgeInstrument,
                };

                const decision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: {
                        ...config,
                        lastPreview: {
                            orderAction: 'BUY',
                            quantity: 60,
                            orderType: 'LMT',
                            limitPrice: 99.9,
                            symbol: 'SPY',
                        },
                        lastPreviewAt: '2026-04-29T14:29:50Z',
                    },
                    recommendation,
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });

                assert.equal(decision.action, 'submit');
                assert.equal(decision.reason, '');
            },
        },
        {
            name: 'auto hedge supervisor blocks during cooldown and active orders',
            run() {
                const ctx = loadContext();
                const config = ctx.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig({
                    enabled: true,
                    autoSubmitEnabled: true,
                    limitPrice: 99.9,
                    cooldownSeconds: 60,
                    lastOrderEventAt: '2026-04-29T14:29:30Z',
                    hedgeInstrument: {
                        secType: 'STK',
                        symbol: 'SPY',
                        exchange: 'SMART',
                        currency: 'USD',
                        multiplier: 1,
                        deltaPerUnit: 1,
                    },
                });
                const recommendation = {
                    actionable: true,
                    side: 'SELL',
                    quantity: 30,
                    orderType: 'LMT',
                    limitPrice: 99.9,
                    hedgeInstrument: config.hedgeInstrument,
                };

                const cooldownDecision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: config,
                    recommendation,
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });
                assert.equal(cooldownDecision.action, 'blocked');
                assert.equal(cooldownDecision.reason, 'cooldown_active');

                const activeDecision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: {
                        ...config,
                        lastOrderEventAt: '',
                        orderState: 'resting_locked',
                        restingOrder: {
                            orderId: 3001,
                            status: 'Submitted',
                        },
                    },
                    recommendation,
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });
                assert.equal(activeDecision.action, 'blocked');
                assert.equal(activeDecision.reason, 'active_resting_order');
            },
        },
        {
            name: 'auto hedge supervisor cancels stale active orders when enabled',
            run() {
                const ctx = loadContext();
                const config = ctx.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig({
                    enabled: true,
                    autoSubmitEnabled: true,
                    autoCancelStaleOrders: true,
                    limitPrice: 99.9,
                    hedgeInstrument: {
                        secType: 'STK',
                        symbol: 'SPY',
                        exchange: 'SMART',
                        currency: 'USD',
                        multiplier: 1,
                        deltaPerUnit: 1,
                    },
                    orderState: 'stale_needs_review',
                    restingOrder: {
                        orderId: 3001,
                        status: 'Submitted',
                    },
                });

                const decision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: config,
                    recommendation: {
                        actionable: false,
                        reason: 'pending_hedge_order',
                    },
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });

                assert.equal(decision.action, 'cancel_stale_order');
                assert.equal(decision.reason, 'stale_resting_order');

                const disabledDecision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: {
                        ...config,
                        autoCancelStaleOrders: false,
                    },
                    recommendation: {
                        actionable: false,
                        reason: 'pending_hedge_order',
                    },
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });

                assert.equal(disabledDecision.action, 'blocked');
                assert.equal(disabledDecision.reason, 'active_resting_order');
            },
        },
        {
            name: 'auto hedge supervisor enforces notional, daily order limit, and LMT-only mode',
            run() {
                const ctx = loadContext();
                const baseConfig = ctx.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig({
                    enabled: true,
                    autoSubmitEnabled: true,
                    autoMaxOrdersPerDay: 1,
                    autoOrderCountDate: '2026-04-29',
                    autoOrderCount: 1,
                    limitPrice: 99.9,
                    hedgeInstrument: {
                        secType: 'STK',
                        symbol: 'SPY',
                        exchange: 'SMART',
                        currency: 'USD',
                        multiplier: 1,
                        deltaPerUnit: 1,
                    },
                });
                const recommendation = {
                    actionable: true,
                    side: 'SELL',
                    quantity: 30,
                    orderType: 'LMT',
                    limitPrice: 99.9,
                    hedgeInstrument: baseConfig.hedgeInstrument,
                };

                const dailyDecision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: baseConfig,
                    recommendation,
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });
                assert.equal(dailyDecision.action, 'blocked');
                assert.equal(dailyDecision.reason, 'max_daily_orders_reached');

                const notionalDecision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: {
                        ...baseConfig,
                        autoOrderCount: 0,
                        autoMaxNotional: 1000,
                    },
                    recommendation: {
                        ...recommendation,
                        quantity: 20,
                        limitPrice: 99.9,
                    },
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });
                assert.equal(notionalDecision.action, 'blocked');
                assert.equal(notionalDecision.reason, 'exceeds_max_notional');

                const marketDecision = ctx.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeAutomation({
                    deltaHedge: {
                        ...baseConfig,
                        autoOrderCount: 0,
                        orderType: 'MKT',
                    },
                    recommendation: {
                        ...recommendation,
                        orderType: 'MKT',
                    },
                    liveMode: true,
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedAccount: 'DU12345',
                    now: '2026-04-29T14:30:00Z',
                });
                assert.equal(marketDecision.action, 'blocked');
                assert.equal(marketDecision.reason, 'auto_requires_lmt');
            },
        },
    ],
};
