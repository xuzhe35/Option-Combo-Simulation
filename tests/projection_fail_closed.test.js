const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const pricingScripts = [
    'js/official_exchange_calendars.generated.js',
    'js/market_holidays.js',
    'js/date_utils.js',
    'js/product_registry.js',
    'js/market_curves.js',
    'js/index_forward_rate.js',
    'js/pricing_context.js',
    'js/pricing_core.js',
];

function missingBoundFutureState() {
    return {
        underlyingSymbol: 'CL',
        underlyingContractMonth: '202604',
        underlyingPrice: 70,
        baseDate: '2026-03-14',
        simulatedDate: '2026-03-20',
        interestRate: 0.03,
        ivOffset: 0,
        futuresPool: [
            { id: 'future_apr', contractMonth: '202604', mark: 70 },
            { id: 'future_jul', contractMonth: '202607', mark: null },
        ],
    };
}

function optionGroup() {
    return {
        id: 'cl-calendar',
        viewMode: 'active',
        legs: [{
            id: 'cl-jul-call',
            type: 'call',
            pos: 1,
            strike: 75,
            expDate: '2026-04-20',
            iv: 0.3,
            cost: 1.2,
            closePrice: null,
            underlyingFutureId: 'future_jul',
        }],
    };
}

module.exports = {
    name: 'projection fail-closed',
    tests: [
        {
            name: 'main P&L chart renders an unavailable state instead of a wrong-month curve',
            run() {
                const messages = [];
                const canvasContext = {
                    clearRect() {},
                    scale() {},
                    fillText(message) { messages.push(String(message)); },
                };
                const canvas = {
                    getContext: () => canvasContext,
                    addEventListener() {},
                    parentElement: {
                        getBoundingClientRect: () => ({ width: 800, height: 400 }),
                    },
                    style: {},
                };
                const ctx = loadBrowserScripts([...pricingScripts, 'js/chart.js'], { devicePixelRatio: 1 });
                const PnLChart = new vm.Script('PnLChart').runInContext(ctx);
                const chart = new PnLChart(canvas);
                chart.draw(optionGroup(), missingBoundFutureState(), 55, 85);

                assert.equal(chart.lastRenderData, null);
                assert.ok(messages.some(message => /bound futures quote is missing/i.test(message)));
            },
        },
        {
            name: 'Chart Lab returns no points when the bound futures quote is unavailable',
            run() {
                const ctx = loadBrowserScripts([...pricingScripts, 'js/chart_lab.js'], {
                    document: {
                        readyState: 'loading',
                        addEventListener() {},
                        getElementById: () => null,
                    },
                });
                const curve = ctx.OptionComboChartLab._test.projectionCurve(
                    optionGroup(),
                    missingBoundFutureState(),
                    55,
                    85
                );

                assert.deepEqual(Array.from(curve.points), []);
                assert.match(curve.error, /bound futures quote is missing/i);
            },
        },
        {
            name: 'Chart Lab keeps INDEX and FOP projection prices atomic with the main websocket timestamp',
            run() {
                const ctx = loadBrowserScripts([...pricingScripts, 'js/chart_lab.js'], {
                    document: {
                        readyState: 'loading',
                        addEventListener() {},
                        getElementById: () => null,
                    },
                });
                const buildProjectionPricingState = ctx.OptionComboChartLab._test.buildProjectionPricingState;
                const cases = [
                    {
                        name: 'INDEX',
                        chartOnlyPrice: 6108.25,
                        state: {
                            underlyingSymbol: 'SPX',
                            underlyingPrice: 6100.5,
                            liveQuoteAsOf: '2026-07-20T19:59:58.000Z',
                            // Deliberately DISTINCT from liveQuoteAsOf above:
                            // a sentinel that a substituted timestamp cannot
                            // accidentally match. See the assertions below.
                            indexForwardRateSamples: [{
                                spotPrice: 6100.5,
                                quoteAsOf: '2026-07-20T19:59:41.000Z',
                            }],
                        },
                    },
                    {
                        name: 'FOP',
                        chartOnlyPrice: 6341.75,
                        state: {
                            underlyingSymbol: 'ES',
                            underlyingPrice: 6336.25,
                            liveQuoteAsOf: '2026-07-20T19:59:57.000Z',
                            // Distinct sentinel, as above.
                            futuresPool: [{
                                id: 'es-sep',
                                mark: 6336.25,
                                quoteAsOf: '2026-07-20T19:59:12.000Z',
                                contractMonth: '202609',
                            }],
                        },
                    },
                ];

                cases.forEach((testCase) => {
                    const snapshot = buildProjectionPricingState(testCase.state, testCase.chartOnlyPrice);
                    assert.notEqual(snapshot, testCase.state, `${testCase.name} snapshot should be isolated`);
                    assert.equal(snapshot.underlyingPrice, testCase.state.underlyingPrice);
                    assert.equal(snapshot.liveQuoteAsOf, testCase.state.liveQuoteAsOf);
                    assert.notEqual(snapshot.underlyingPrice, testCase.chartOnlyPrice);
                });
                // Asserting these nested timestamps against liveQuoteAsOf would
                // compare two copies of the same author-written literal and hold
                // for ANY implementation. buildProjectionPricingState is a
                // shallow spread, so there is no nested propagation to pin.
                // What IS worth pinning is the documented contract at that
                // boundary: the Chart Lab price stream must never rewrite the
                // main socket's carry / futures observations. The sentinels
                // differ from liveQuoteAsOf, so a substituted timestamp fails.
                const indexSnapshot = buildProjectionPricingState(
                    cases[0].state, cases[0].chartOnlyPrice
                );
                assert.equal(
                    indexSnapshot.indexForwardRateSamples[0].quoteAsOf,
                    '2026-07-20T19:59:41.000Z'
                );
                assert.equal(indexSnapshot.indexForwardRateSamples[0].spotPrice, 6100.5);
                assert.notEqual(
                    indexSnapshot.indexForwardRateSamples[0].spotPrice,
                    cases[0].chartOnlyPrice
                );

                const fopSnapshot = buildProjectionPricingState(
                    cases[1].state, cases[1].chartOnlyPrice
                );
                assert.equal(fopSnapshot.futuresPool[0].quoteAsOf, '2026-07-20T19:59:12.000Z');
                assert.equal(fopSnapshot.futuresPool[0].mark, 6336.25);
                assert.notEqual(fopSnapshot.futuresPool[0].mark, cases[1].chartOnlyPrice);
            },
        },
        {
            name: 'main chart and Chart Lab block short-dated legs without contract timing',
            run() {
                const messages = [];
                const canvas = {
                    getContext: () => ({
                        clearRect() {},
                        scale() {},
                        fillText(message) { messages.push(String(message)); },
                    }),
                    addEventListener() {},
                    parentElement: {
                        getBoundingClientRect: () => ({ width: 800, height: 400 }),
                    },
                    style: {},
                };
                const group = {
                    id: 'short-dated-gate',
                    viewMode: 'active',
                    legs: [{
                        id: 'short-call', type: 'call', pos: 1, strike: 100,
                        expDate: '2026-07-16', iv: 0.25, cost: 1, closePrice: null,
                    }],
                };
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 100,
                    baseDate: '2026-07-01',
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: '2026-07-10T19:00:00Z',
                    simulatedDate: '2026-07-10',
                    marketDataMode: 'live',
                    requireExactContractTiming: true,
                    simulationTiming: {
                        available: true,
                        status: 'ok',
                        simulationDate: '2026-07-10',
                        targetAsOf: '2026-07-10T19:00:00Z',
                    },
                    interestRate: 0.03,
                    useMarketDiscountCurve: false,
                    ivOffset: 0,
                    groups: [group],
                };
                const ctx = loadBrowserScripts(
                    [...pricingScripts, 'js/chart.js', 'js/chart_lab.js'],
                    {
                        devicePixelRatio: 1,
                        document: {
                            readyState: 'loading',
                            addEventListener() {},
                            getElementById: () => null,
                        },
                    }
                );
                const PnLChart = new vm.Script('PnLChart').runInContext(ctx);
                const chart = new PnLChart(canvas);
                chart.draw(group, state, 80, 120);
                assert.equal(chart.lastRenderData, null);
                assert.ok(messages.some(message => /exact_contract_timing_missing/i.test(message)));

                const curve = ctx.OptionComboChartLab._test.projectionCurve(group, state, 80, 120);
                assert.deepEqual(Array.from(curve.points), []);
                assert.match(curve.error, /exact_contract_timing_missing/i);
            },
        },
        {
            name: 'shared simulated-price boundary rejects null underlyings',
            run() {
                const ctx = loadBrowserScripts(pricingScripts);
                const price = ctx.OptionComboPricingCore.computeSimulatedPrice(
                    { type: 'call', isUnderlyingLeg: false, strike: 75, T: 0.1, rateT: 0.1, simIV: 0.3 },
                    { type: 'call', closePrice: null },
                    null,
                    0.03,
                    'active',
                    '2026-03-20',
                    '2026-03-14',
                    0
                );
                assert.equal(price, null);

                const frozenExpiryPrice = ctx.OptionComboPricingCore.computeSimulatedPrice(
                    {
                        type: 'call', isUnderlyingLeg: false, isExpired: true,
                        expiryUnderlyingPrice: 80, strike: 75, T: 0, rateT: 0, simIV: null,
                    },
                    { type: 'call', closePrice: null },
                    null,
                    0.03,
                    'active',
                    '2026-03-20',
                    '2026-03-14',
                    0
                );
                assert.equal(frozenExpiryPrice, 5);
            },
        },
        {
            name: 'strict convergence gate requires local BBO IV only for legs alive at target',
            run() {
                const ctx = loadBrowserScripts(pricingScripts);
                const core = ctx.OptionComboPricingCore;
                const raw = [
                    { id: 'near', type: 'call', pos: -1, expDate: '2026-07-15', closePrice: null },
                    { id: 'far', type: 'call', pos: 1, expDate: '2026-07-17', closePrice: null },
                ];
                const processed = [
                    {
                        isUnderlyingLeg: false,
                        isExpired: true,
                        localIvAnchorAttempted: false,
                        localIvAnchorAvailable: false,
                        localIvAnchorStatus: 'not_two_sided_bbo',
                    },
                    {
                        isUnderlyingLeg: false,
                        isExpired: false,
                        localIvAnchorAttempted: false,
                        localIvAnchorAvailable: false,
                        localIvAnchorStatus: 'not_two_sided_bbo',
                    },
                ];
                const strict = core.assessProjectionConvergence(
                    { marketDataMode: 'live' },
                    raw,
                    processed
                );
                assert.equal(strict.ready, false);
                assert.deepEqual(Array.from(strict.affectedLegIds), ['far']);
                assert.match(core.formatProjectionConvergenceFailure(strict), /far/);

                processed[1] = {
                    ...processed[1],
                    localIvAnchorAttempted: true,
                    localIvAnchorAvailable: true,
                    localIvAnchorStatus: 'ok',
                    simIVSource: 'local-bbo-implied',
                };
                assert.equal(core.assessProjectionConvergence(
                    { marketDataMode: 'live' }, raw, processed
                ).ready, true);
                const disconnected = core.assessProjectionConvergence(
                    {
                        marketDataMode: 'live',
                        liveProjectionFeedConnected: false,
                    },
                    raw,
                    processed
                );
                assert.equal(disconnected.status, 'strict_convergence_feed_disconnected');
                assert.deepEqual(Array.from(disconnected.affectedLegIds), ['far']);
                assert.match(
                    core.formatProjectionConvergenceFailure(disconnected),
                    /feed is disconnected/i
                );
                assert.equal(core.assessProjectionConvergence(
                    { marketDataMode: 'historical' }, raw, processed.slice(0, 1)
                ).status, 'historical_replay');
                assert.equal(core.assessProjectionConvergence(
                    { marketDataMode: 'live', projectionConvergenceMode: 'legacy-input-iv' },
                    raw,
                    []
                ).status, 'legacy_input_iv');
                assert.equal(core.assessProjectionConvergence(
                    { marketDataMode: 'live', projectionConvergenceMode: 'best-effort-input-iv' },
                    raw,
                    []
                ).status, 'best_effort_input_iv');

                const scalarBypass = core.assessProjectionConvergence(
                    {
                        marketDataMode: 'live',
                        projectionConvergenceMode: 'legacy-input-iv',
                        simTimeBasis: 'calendar',
                        simUseImpliedLambda: false,
                        simImpliedLambdaCoverage: {
                            required: true,
                            ready: false,
                            status: 'implied_lambda_disabled',
                            requiredDates: ['2026-07-18', '2026-07-19'],
                            missingDates: [],
                            affectedLegIds: ['far'],
                        },
                    },
                    raw,
                    processed
                );
                assert.equal(scalarBypass.ready, false);
                const bestEffortStillNeedsLambda = core.assessProjectionConvergence(
                    {
                        marketDataMode: 'live',
                        projectionConvergenceMode: 'best-effort-input-iv',
                        simImpliedLambdaCoverage: {
                            required: true,
                            ready: false,
                            status: 'coverage_incomplete',
                            missingDates: ['2026-07-18', '2026-07-19'],
                            affectedLegIds: ['far'],
                        },
                    },
                    raw,
                    processed
                );
                assert.equal(bestEffortStillNeedsLambda.ready, false);
                assert.equal(
                    bestEffortStillNeedsLambda.status,
                    'structured_implied_lambda_required'
                );
                assert.equal(scalarBypass.status, 'structured_implied_lambda_required');
                assert.match(
                    core.formatProjectionConvergenceFailure(scalarBypass),
                    /mandatory.*weekend.*full exchange holiday/i
                );
                assert.match(
                    core.formatProjectionConvergenceFailure(scalarBypass),
                    /2026-07-18/
                );

                const noClosure = core.assessProjectionConvergence(
                    {
                        marketDataMode: 'live',
                        projectionConvergenceMode: 'legacy-input-iv',
                        simUseImpliedLambda: false,
                        simImpliedLambdaCoverage: {
                            required: false,
                            ready: true,
                            status: 'not_required',
                        },
                    },
                    raw,
                    processed
                );
                assert.equal(noClosure.ready, true);
                assert.equal(noClosure.status, 'legacy_input_iv');
            },
        },
        {
            name: 'main chart and Chart Lab enforce strict live BBO convergence but exempt target-expired legs',
            run() {
                const messages = [];
                const gradient = { addColorStop() {} };
                const canvasContext = new Proxy({
                    fillText(message) { messages.push(String(message)); },
                    measureText(value) { return { width: String(value || '').length * 7 }; },
                    createLinearGradient() { return gradient; },
                }, {
                    get(target, key) {
                        if (key in target) return target[key];
                        return () => {};
                    },
                });
                const canvas = {
                    getContext: () => canvasContext,
                    addEventListener() {},
                    parentElement: {
                        getBoundingClientRect: () => ({ width: 800, height: 400 }),
                    },
                    style: {},
                };
                const farGroup = {
                    id: 'strict-far',
                    viewMode: 'active',
                    legs: [{
                        id: 'far-call', type: 'call', pos: 1, strike: 100,
                        expDate: '2026-07-17', iv: 0.25, cost: 1,
                        currentPrice: 1.2, currentPriceSource: 'live', closePrice: null,
                    }],
                };
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 100,
                    baseDate: '2026-07-01',
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: '2026-07-10T19:00:00Z',
                    simulatedDate: '2026-07-15',
                    marketDataMode: 'live',
                    requireExactContractTiming: false,
                    interestRate: 0.03,
                    useMarketDiscountCurve: false,
                    ivOffset: 0,
                    groups: [farGroup],
                };
                const ctx = loadBrowserScripts(
                    [...pricingScripts, 'js/chart.js', 'js/chart_lab.js'],
                    {
                        devicePixelRatio: 1,
                        document: {
                            readyState: 'loading',
                            addEventListener() {},
                            getElementById: () => null,
                            createElement() {
                                return {
                                    width: 0,
                                    height: 0,
                                    getContext: () => canvasContext,
                                };
                            },
                        },
                    }
                );
                const PnLChart = new vm.Script('PnLChart').runInContext(ctx);
                const chart = new PnLChart(canvas);
                chart.draw(farGroup, state, 80, 120);
                assert.equal(chart.lastRenderData, null);
                assert.ok(messages.some(message => /strict live convergence/i.test(message)));

                const bestEffortChart = new PnLChart(canvas);
                bestEffortChart.draw(
                    farGroup,
                    { ...state, projectionConvergenceMode: 'best-effort-input-iv' },
                    80,
                    120
                );
                assert.ok(bestEffortChart.lastRenderData);
                assert.equal(bestEffortChart.lastProjectionQuality.bestEffort, true);
                assert.equal(bestEffortChart.lastProjectionQuality.fallbackCount, 1);
                assert.equal(
                    bestEffortChart.lastProjectionQuality.fallbackLegs[0].id,
                    'far-call'
                );
                const blockedCurve = ctx.OptionComboChartLab._test.projectionCurve(
                    farGroup,
                    state,
                    80,
                    120
                );
                assert.deepEqual(Array.from(blockedCurve.points), []);
                assert.match(blockedCurve.error, /strict live convergence/i);

                const nearGroup = {
                    id: 'expired-near',
                    viewMode: 'active',
                    legs: [{
                        id: 'near-call', type: 'call', pos: -1, strike: 100,
                        expDate: '2026-07-15', iv: 0.25, cost: 1,
                        currentPrice: 1.2, currentPriceSource: 'live', closePrice: null,
                    }],
                };
                const nearState = { ...state, groups: [nearGroup] };
                const nearChart = new PnLChart(canvas);
                nearChart.draw(nearGroup, nearState, 80, 120);
                assert.ok(nearChart.lastRenderData);
                const nearCurve = ctx.OptionComboChartLab._test.projectionCurve(
                    nearGroup,
                    nearState,
                    80,
                    120
                );
                assert.ok(nearCurve.points.length > 0);
                assert.equal(nearCurve.error, undefined);
            },
        },
        {
            name: 'implied lambda incomplete copy names the missing structured weekend and holiday curve',
            run() {
                const ctx = loadBrowserScripts(pricingScripts);
                const message = ctx.OptionComboPricingCore.formatProjectionTimingFailure(
                    'implied_lambda_incomplete',
                    'Simulation'
                );
                assert.match(message, /structured implied λ curve/i);
                assert.match(message, /weekend\/holiday/i);
                assert.match(message, /IV Term Structure/i);
            },
        },
        {
            name: 'missing structured lambda outranks generic BBO failure across payoff entries and lists the date',
            run() {
                const messages = [];
                const canvasContext = new Proxy({
                    fillText(message) { messages.push(String(message)); },
                }, {
                    get(target, key) {
                        if (key in target) return target[key];
                        return () => {};
                    },
                });
                const canvas = {
                    getContext: () => canvasContext,
                    addEventListener() {},
                    parentElement: {
                        getBoundingClientRect: () => ({ width: 800, height: 400 }),
                    },
                    style: {},
                };
                const group = {
                    id: 'lambda-priority',
                    viewMode: 'active',
                    legs: [{
                        id: 'far-call', type: 'call', pos: 1, strike: 100,
                        expDate: '2026-07-21', iv: 0.25, cost: 1,
                        currentPrice: 1.2, currentPriceSource: 'live', closePrice: null,
                    }],
                };
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 100,
                    baseDate: '2026-07-01',
                    liveQuoteDate: '2026-07-17',
                    liveQuoteAsOf: '2026-07-17T19:00:00Z',
                    simulatedDate: '2026-07-20',
                    marketDataMode: 'live',
                    requireExactContractTiming: false,
                    interestRate: 0.03,
                    useMarketDiscountCurve: false,
                    ivOffset: 0,
                    groups: [group],
                    hedges: [],
                };
                const ctx = loadBrowserScripts(
                    [
                        ...pricingScripts,
                        'js/chart.js',
                        'js/amortized.js',
                        'js/valuation.js',
                        'js/chart_lab.js',
                    ],
                    {
                        devicePixelRatio: 1,
                        document: {
                            readyState: 'loading',
                            addEventListener() {},
                            getElementById: () => null,
                        },
                    }
                );
                ctx.OptionComboPricingCore.configureSimTimeBasis({
                    weekendWeight: {
                        default: 0.3,
                        byDate: null,
                        strictByDate: true,
                    },
                });
                const PnLChart = new vm.Script('PnLChart').runInContext(ctx);
                const chart = new PnLChart(canvas);
                chart.draw(group, state, 80, 120);
                const chartMessage = messages.find(message => /structured implied λ/i.test(message));
                assert.ok(chartMessage);
                assert.match(chartMessage, /2026-07-18/);
                assert.doesNotMatch(chartMessage, /strict live convergence/i);

                const curve = ctx.OptionComboChartLab._test.projectionCurve(group, state, 80, 120);
                assert.match(curve.error, /structured implied λ/i);
                assert.match(curve.error, /2026-07-18/);
                assert.doesNotMatch(curve.error, /strict live convergence/i);

                const valuation = ctx.OptionComboValuation.computeGroupDerivedData(group, state);
                assert.equal(valuation.groupSimulationAvailable, false);
                assert.equal(
                    valuation.legResults[0].simulationUnavailableReason,
                    'implied_lambda_incomplete'
                );
                assert.match(valuation.legResults[0].ivTitle, /2026-07-18/);
                assert.doesNotMatch(valuation.legResults[0].ivTitle, /strict live convergence/i);

                const amortized = ctx.OptionComboAmortized.calculateAmortizedCost(
                    { ...group, viewMode: 'amortized' },
                    100,
                    state
                );
                assert.equal(amortized.isSupported, false);
                assert.match(amortized.reason, /structured implied λ/i);
                assert.match(amortized.reason, /2026-07-18/);
                assert.doesNotMatch(amortized.reason, /strict live convergence/i);
            },
        },
    ],
};
