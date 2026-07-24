const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadBrowserScripts, loadPricingContext } = require('./helpers/load-browser-scripts');

function loadProbCharts(extra = {}) {
    return loadBrowserScripts(['js/prob_charts.js'], {
        Blob: class Blob { constructor() {} },
        URL: { createObjectURL: () => 'blob:mock' },
        document: { getElementById: () => null },
        ...extra,
    });
}

function loadProbChartsWithPricing(state) {
    return loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/market_curves.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
        'js/pricing_core.js',
        'js/prob_charts.js',
    ], {
        state,
        Blob: class Blob { constructor() {} },
        URL: { createObjectURL: () => 'blob:mock' },
        document: { getElementById: () => null },
    });
}

function captureMcWorkerSource() {
    let workerSource = '';
    loadProbCharts({
        Blob: class Blob {
            constructor(parts) {
                workerSource = String(parts && parts[0] || '');
            }
        },
    });
    assert.ok(workerSource.includes('self.onmessage'));
    return workerSource;
}

function mulberry32(seed) {
    let value = seed >>> 0;
    return function nextRandom() {
        value += 0x6D2B79F5;
        let result = value;
        result = Math.imul(result ^ (result >>> 15), result | 1);
        result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
        return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
}

function runMcWorker(message, seed = 0x5eed1234) {
    let posted = null;
    const workerContext = vm.createContext({
        __testRandom: mulberry32(seed),
        self: {
            postMessage(value) {
                posted = value;
            },
        },
    });
    new vm.Script('Math.random = __testRandom;').runInContext(workerContext);
    new vm.Script(captureMcWorkerSource()).runInContext(workerContext);
    workerContext.self.onmessage({ data: message });
    assert.ok(posted, 'worker did not post a result');
    return posted;
}

function histogramLogVariance(result, anchorPrice) {
    let mass = 0;
    let mean = 0;
    for (let i = 0; i < result.binCenters.length; i++) {
        const probability = result.tDensity[i] * result.binWidth;
        const logReturn = Math.log(result.binCenters[i] / anchorPrice);
        mass += probability;
        mean += probability * logReturn;
    }
    mean /= mass;

    let variance = 0;
    for (let i = 0; i < result.binCenters.length; i++) {
        const probability = result.tDensity[i] * result.binWidth;
        const logReturn = Math.log(result.binCenters[i] / anchorPrice);
        variance += probability * (logReturn - mean) ** 2;
    }
    return variance / mass;
}

// Drive updateProbCharts() far enough to reach its early-return unavailable
// branches, with a fake in-flight Monte Carlo worker already installed. The
// chart/badge setters all no-op when getElementById returns null, so only the
// container has to exist.
function loadProbChartsWithStaleWorker(state, simulationTiming) {
    const ctx = loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/prob_charts.js',
    ], {
        state,
        Blob: class Blob { constructor() {} },
        URL: { createObjectURL: () => 'blob:mock' },
        document: {
            getElementById: (id) => (id === 'probAnalysisContainer'
                ? { style: { display: 'block' } }
                : null),
        },
        OptionComboPricingContext: {
            resolveSimulationDate: (s) => s.simulatedDate,
            resolveQuoteDate: (s) => s.baseDate,
            resolveSimulationTiming: () => simulationTiming,
        },
    });
    const fakeWorker = {
        terminated: false,
        terminate() { this.terminated = true; },
    };
    ctx.__fakeWorker = fakeWorker;
    new vm.Script('_activeWorker = __fakeWorker;').runInContext(ctx);
    return { ctx, fakeWorker };
}

function staleWorkerState() {
    return {
        underlyingSymbol: 'SPY',
        baseDate: '2026-07-20',
        simulatedDate: '2026-07-20',
        liveQuoteAsOf: '2026-07-20T14:00:00Z',
        groups: [{
            id: 'g1',
            includedInGlobal: true,
            legs: [{ type: 'call', pos: 1, strike: 100, expDate: '2026-08-21', iv: 0.2 }],
        }],
    };
}

module.exports = {
    name: 'prob_charts.js',
    tests: [
        {
            name: 'builds a conditional overlay whose density integrates to one and EV matches the sample mean',
            run() {
                const ctx = loadProbCharts();
                const zs = [-1.5, -1.0, -0.5, -0.2, 0.0, 0.1, 0.3, 0.6, 0.9, 1.4];
                const anchor = 700;
                const em = 20;
                const bins = 400;
                const binCenters = Array.from({ length: bins }, (_, i) => 560 + (i + 0.5) * (280 / bins));
                const pnlAt = (price) => price - anchor;

                const overlay = ctx._buildConditionalOverlay(zs, anchor, em, binCenters, pnlAt);
                assert.ok(overlay);
                assert.equal(overlay.n, zs.length);

                // EV = mean of pnl at replayed prices = mean(z) * em
                const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
                assert.ok(Math.abs(overlay.expectedPnL - meanZ * em) < 1e-9);

                // KDE density integrates to ~1 over a range wide enough to
                // hold every sample plus bandwidth tails.
                const binWidth = 280 / bins;
                let area = 0;
                for (let i = 0; i < bins; i++) area += overlay.density[i] * binWidth;
                assert.ok(Math.abs(area - 1) < 0.02, `density area ${area}`);

                // Density mass sits around the replayed prices, not the tails.
                const peakIdx = overlay.density.indexOf(Math.max(...overlay.density));
                assert.ok(Math.abs(binCenters[peakIdx] - anchor) < em * 1.5);
            },
        },
        {
            name: 'MC worker matches BSM and Black-76 with separate variance and discount clocks',
            run() {
                const pricing = loadProbChartsWithPricing({});
                const currentPrice = 103;
                const strike = 100;
                const varianceT = 0.08;
                const discountT = 0.19;
                const rate = 0.0475;
                const volatility = 0.24;
                const common = {
                    df: 5,
                    loc: 0,
                    newScale: 0,
                    stepWeights: [0],
                    nPaths: 1,
                    currentPrice,
                    minS: 50,
                    maxS: 150,
                    bins: 10,
                };

                for (const type of ['call', 'put']) {
                    const baseLeg = {
                        id: `${type}-leg`,
                        type,
                        isUnderlyingLeg: false,
                        isExpired: false,
                        strike,
                        rate,
                        varianceT,
                        discountT,
                        volatility,
                        posMultiplier: 1,
                        costBasis: 0,
                        underlyingScale: 1,
                    };
                    const bsm = runMcWorker({
                        ...common,
                        legs: [{ ...baseLeg, pricingModel: 'bsm-spot' }],
                    });
                    const black76 = runMcWorker({
                        ...common,
                        legs: [{ ...baseLeg, pricingModel: 'black76' }],
                    });
                    const expectedBsm = pricing.calculateOptionPrice(
                        type, currentPrice, strike, varianceT, rate, volatility, discountT
                    );
                    const expectedBlack76 = pricing.calculateBlack76Price(
                        type, currentPrice, strike, varianceT, rate, volatility, discountT
                    );

                    assert.ok(Math.abs(bsm.exactExpectedPnL - expectedBsm) < 1e-10);
                    assert.ok(Math.abs(black76.exactExpectedPnL - expectedBlack76) < 1e-10);
                    assert.ok(
                        Math.abs(black76.exactExpectedPnL - expectedBsm) > 0.1,
                        `${type} should materially distinguish Black-76 from spot BSM`
                    );
                }

                const bsmCall = runMcWorker({
                    ...common,
                    legs: [{
                        id: 'bsm-call', type: 'call', isUnderlyingLeg: false,
                        isExpired: false, pricingModel: 'bsm-spot', strike, rate,
                        varianceT, discountT, volatility, posMultiplier: 1,
                        costBasis: 0, underlyingScale: 1,
                    }],
                }).exactExpectedPnL;
                const bsmPut = runMcWorker({
                    ...common,
                    legs: [{
                        id: 'bsm-put', type: 'put', isUnderlyingLeg: false,
                        isExpired: false, pricingModel: 'bsm-spot', strike, rate,
                        varianceT, discountT, volatility, posMultiplier: 1,
                        costBasis: 0, underlyingScale: 1,
                    }],
                }).exactExpectedPnL;
                assert.ok(Math.abs(
                    (bsmCall - bsmPut)
                    - (currentPrice - strike * Math.exp(-rate * discountT))
                ) < 1e-10);

                const blackCall = runMcWorker({
                    ...common,
                    legs: [{
                        id: 'black-call', type: 'call', isUnderlyingLeg: false,
                        isExpired: false, pricingModel: 'black76', strike, rate,
                        varianceT, discountT, volatility, posMultiplier: 1,
                        costBasis: 0, underlyingScale: 1,
                    }],
                }).exactExpectedPnL;
                const blackPut = runMcWorker({
                    ...common,
                    legs: [{
                        id: 'black-put', type: 'put', isUnderlyingLeg: false,
                        isExpired: false, pricingModel: 'black76', strike, rate,
                        varianceT, discountT, volatility, posMultiplier: 1,
                        costBasis: 0, underlyingScale: 1,
                    }],
                }).exactExpectedPnL;
                assert.ok(Math.abs(
                    (blackCall - blackPut)
                    - Math.exp(-rate * discountT) * (currentPrice - strike)
                ) < 1e-10);
            },
        },
        {
            name: 'MC worker consumes per-date lambda weights and skips zero-weight days without RNG drift',
            run() {
                const common = {
                    df: 8,
                    loc: 0,
                    newScale: 0.012,
                    nPaths: 40000,
                    currentPrice: 100,
                    minS: 40,
                    maxS: 250,
                    bins: 1000,
                    legs: [],
                };
                const fiveTradingDays = runMcWorker({
                    ...common,
                    stepWeights: [1, 1, 1, 1, 1],
                });
                const zeroWeekend = runMcWorker({
                    ...common,
                    stepWeights: [1, 1, 1, 1, 1, 0, 0],
                });
                assert.deepEqual(
                    Array.from(zeroWeekend.tDensity),
                    Array.from(fiveTradingDays.tDensity)
                );

                const structuredWeekend = runMcWorker({
                    ...common,
                    stepWeights: [1, 1, 1, 1, 1, 0.2, 0.7],
                });
                const baseVariance = histogramLogVariance(fiveTradingDays, 100);
                const structuredVariance = histogramLogVariance(structuredWeekend, 100);
                const expectedRatio = 5.9 / 5;
                assert.ok(
                    Math.abs(structuredVariance / baseVariance - expectedRatio) < 0.06,
                    `variance ratio ${structuredVariance / baseVariance} vs ${expectedRatio}`
                );
            },
        },
        {
            name: 'MC worker interpolates a precomputed American binomial price grid',
            run() {
                const result = runMcWorker({
                    df: 5,
                    loc: 0,
                    newScale: 0,
                    stepWeights: [0],
                    nPaths: 1,
                    currentPrice: 100,
                    minS: 90,
                    maxS: 110,
                    bins: 10,
                    legs: [{
                        id: 'american-put',
                        type: 'put',
                        isUnderlyingLeg: false,
                        isExpired: false,
                        pricingModel: 'american-binomial',
                        strike: 100,
                        rate: 0.05,
                        varianceT: 0.1,
                        discountT: 0.1,
                        volatility: 0.2,
                        posMultiplier: 2,
                        costBasis: 1,
                        underlyingScale: 1,
                        americanGridMin: 90,
                        americanGridMax: 110,
                        americanPriceGrid: [12, 2, 0],
                    }],
                });

                assert.equal(result.error, undefined);
                assert.equal(result.exactExpectedPnL, 3);
            },
        },
        {
            name: 'MC worker builds the American grid from parameters matching the module pricer',
            run() {
                // No americanPriceGrid is supplied: the worker must build the
                // 101-point grid in-thread from the parameters and price the leg
                // by interpolation. currentPrice=100 lands exactly on grid node 50
                // (gridMin 50 + 50 * step 1), so the interpolated value equals the
                // module pricer's American value with no interpolation slack.
                const american = loadPricingContext().OptionComboAmericanBinomial;
                const expectedOpt = american.calculateAmericanOptionPrice({
                    type: 'put',
                    spot: 100,
                    strike: 100,
                    varianceTime: 0.1,
                    rateTime: 0.1,
                    riskFreeRate: 0.05,
                    volatility: 0.2,
                    dividendYield: 0,
                    steps: 201,
                });
                const result = runMcWorker({
                    df: 5,
                    loc: 0,
                    newScale: 0,
                    stepWeights: [0],
                    nPaths: 1,
                    currentPrice: 100,
                    minS: 50,
                    maxS: 150,
                    bins: 10,
                    legs: [{
                        id: 'american-built',
                        type: 'put',
                        isUnderlyingLeg: false,
                        isExpired: false,
                        pricingModel: 'american-binomial',
                        strike: 100,
                        rate: 0.05,
                        varianceT: 0.1,
                        discountT: 0.1,
                        volatility: 0.2,
                        dividendYield: 0,
                        binomialSteps: 201,
                        posMultiplier: 2,
                        costBasis: 1,
                        underlyingScale: 1,
                        americanGridMin: 50,
                        americanGridMax: 150,
                        americanGridPoints: 101,
                    }],
                });

                assert.equal(result.error, undefined);
                assert.ok(
                    Math.abs(result.exactExpectedPnL - (2 * expectedOpt - 1)) < 1e-9,
                    `worker-built grid ${result.exactExpectedPnL} should match ${2 * expectedOpt - 1}`
                );
            },
        },
        {
            name: 'MC worker fails closed when American grid parameters are incomplete',
            run() {
                // Neither a prebuilt grid nor a valid step count: the worker must
                // report a pricing-input error rather than build a bad grid.
                const result = runMcWorker({
                    df: 5,
                    loc: 0,
                    newScale: 0,
                    stepWeights: [0],
                    nPaths: 1,
                    currentPrice: 100,
                    minS: 50,
                    maxS: 150,
                    bins: 10,
                    legs: [{
                        id: 'american-bad-params',
                        type: 'put',
                        isUnderlyingLeg: false,
                        isExpired: false,
                        pricingModel: 'american-binomial',
                        strike: 100,
                        rate: 0.05,
                        varianceT: 0.1,
                        discountT: 0.1,
                        volatility: 0.2,
                        dividendYield: 0,
                        posMultiplier: 2,
                        costBasis: 1,
                        underlyingScale: 1,
                        americanGridMin: 50,
                        americanGridMax: 150,
                        americanGridPoints: 101,
                    }],
                });

                assert.ok(result.error, 'expected a pricing-input error');
                assert.equal(result.error.code, 'pricing_input_invalid');
            },
        },
        {
            name: 'coalesces signed lambda days into nonnegative variance blocks without losing total time',
            run() {
                const ctx = loadProbCharts();
                const prepared = ctx._coalesceSignedVarianceWeights([
                    0.5, -0.35, -0.25, 1, 0.4,
                ]);
                assert.equal(prepared.available, true);
                assert.equal(prepared.signedWeightsCoalesced, true);
                assert.equal(prepared.negativeStepCount, 2);
                assert.ok(prepared.stepWeights.every(weight => weight >= 0));
                assert.ok(Math.abs(
                    prepared.stepWeights.reduce((sum, weight) => sum + weight, 0)
                    - 1.3
                ) < 1e-12);

                const result = runMcWorker({
                    df: 8,
                    loc: 0,
                    newScale: 0.012,
                    stepWeights: Array.from(prepared.stepWeights),
                    nPaths: 1000,
                    currentPrice: 100,
                    minS: 40,
                    maxS: 250,
                    bins: 200,
                    legs: [],
                });
                assert.equal(result.error, undefined);

                const impossible = ctx._coalesceSignedVarianceWeights([0.2, -0.5]);
                assert.equal(impossible.available, false);
                assert.equal(impossible.status, 'simulation_clock_nonpositive');
            },
        },
        {
            name: 'MC worker fails closed on missing forwards and unknown models but honors fixed and settled legs',
            run() {
                const common = {
                    df: 5,
                    loc: 0,
                    newScale: 0,
                    stepWeights: [0],
                    nPaths: 1,
                    currentPrice: 100,
                    minS: 50,
                    maxS: 150,
                    bins: 10,
                };
                const liveOption = {
                    id: 'live',
                    type: 'call',
                    isUnderlyingLeg: false,
                    isExpired: false,
                    pricingModel: 'black76',
                    strike: 100,
                    rate: 0.04,
                    varianceT: 0.05,
                    discountT: 0.1,
                    volatility: 0.2,
                    posMultiplier: 1,
                    costBasis: 0,
                };

                const missingForward = runMcWorker({
                    ...common,
                    legs: [{ ...liveOption, underlyingScale: null }],
                });
                assert.equal(missingForward.error.code, 'pricing_underlying_unavailable');
                assert.equal(missingForward.error.field, 'underlyingScale');

                const unknownModel = runMcWorker({
                    ...common,
                    legs: [{ ...liveOption, underlyingScale: 1, pricingModel: 'guess' }],
                });
                assert.equal(unknownModel.error.code, 'pricing_model_unavailable');

                const deterministic = runMcWorker({
                    ...common,
                    legs: [
                        {
                            id: 'closed',
                            fixedPrice: 2,
                            posMultiplier: 3,
                            costBasis: 1,
                        },
                        {
                            id: 'settled',
                            type: 'call',
                            isUnderlyingLeg: false,
                            isExpired: true,
                            strike: 100,
                            expiryUnderlyingPrice: 107,
                            posMultiplier: 2,
                            costBasis: 4,
                        },
                    ],
                });
                assert.equal(deterministic.error, undefined);
                assert.ok(Math.abs(deterministic.exactExpectedPnL - 15) < 1e-12);

                for (const expiryUnderlyingPrice of [0, -5]) {
                    const invalidSettlement = runMcWorker({
                        ...common,
                        legs: [{
                            id: 'bad-settlement',
                            type: 'put',
                            isUnderlyingLeg: false,
                            isExpired: true,
                            strike: 100,
                            expiryUnderlyingPrice,
                            posMultiplier: 1,
                            costBasis: 0,
                        }],
                    });
                    assert.equal(invalidSettlement.error.code, 'pricing_input_invalid');
                    assert.equal(invalidSettlement.error.field, 'expiryUnderlyingPrice');
                }

                const overflow = runMcWorker({
                    ...common,
                    legs: [{
                        ...liveOption,
                        underlyingScale: 1,
                        rate: -1e308,
                        discountT: 10,
                    }],
                });
                assert.equal(overflow.error.code, 'simulation_numeric_overflow');

                const malformed = runMcWorker({ ...common, legs: [null] });
                assert.equal(malformed.error.code, 'pricing_input_invalid');
                assert.equal(malformed.error.field, 'leg');
            },
        },
        {
            name: 'refuses degenerate inputs and thin sample sets',
            run() {
                const ctx = loadProbCharts({
                    REGIME_CONDITIONAL_SAMPLES: {
                        symbols: {
                            SPY: { dc: Array.from({ length: 40 }, (_, i) => (i % 5) / 5 - 0.4), bw: [0.1, 0.2] },
                        },
                    },
                });
                const grid = [90, 100, 110];
                assert.equal(ctx._buildConditionalOverlay(null, 100, 5, grid, () => 0), null);
                assert.equal(ctx._buildConditionalOverlay([0.1, 0.2], 0, 5, grid, () => 0), null);
                assert.equal(ctx._buildConditionalOverlay([0.1, 0.2], 100, 0, grid, () => 0), null);
                // identical samples -> zero sd -> refuse rather than emit spikes
                assert.equal(ctx._buildConditionalOverlay([0.3, 0.3, 0.3], 100, 5, grid, () => 0), null);

                // sample lookup: >=30 required, missing zones and symbols -> null
                assert.ok(ctx._getRegimeConditionalZs('SPY', 'dc'));
                assert.equal(ctx._getRegimeConditionalZs('SPY', 'bw'), null);
                assert.equal(ctx._getRegimeConditionalZs('TLT', 'dc'), null);
            },
        },
        {
            name: 'fails closed when a probability projection leg lacks its bound future quote',
            run() {
                const state = {
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
                    groups: [{
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
                    }],
                };
                const ctx = loadProbChartsWithPricing(state);
                const availability = ctx._resolvePortfolioProjectionAvailability(state, state.groups, 70);
                assert.equal(availability.available, false);
                assert.equal(availability.reason, 'bound_futures_quote_unavailable');
                assert.equal(ctx._computePortfolioPnLAtPrice(72), null);
                assert.equal(
                    ctx._buildConditionalOverlay([-1, 0, 1], 70, 5, [60, 70, 80], () => null),
                    null
                );
            },
        },
        {
            name: 'reports the strict projection gate before the generic missing-IV fallback',
            run() {
                const ctx = loadProbCharts({
                    OptionComboPricingCore: {
                        formatProjectionConvergenceFailure(convergence, subject) {
                            return `${subject}: ${convergence.status}`;
                        },
                    },
                    OptionComboValuation: {
                        computeGroupDerivedData() {
                            return {
                                legResults: [{
                                    processedLeg: { timingStatus: 'ok' },
                                    projectionConvergence: {
                                        ready: false,
                                        status: 'strict_convergence_feed_stale',
                                    },
                                }],
                            };
                        },
                    },
                });
                assert.equal(
                    ctx._resolveProbabilityProjectionFailure({}, [{}]),
                    'Probability simulation: strict_convergence_feed_stale'
                );
            },
        },
        {
            name: 'builds the probability horizon from exact exchange timestamps',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    simWeekendWeight: 0.3,
                    liveQuoteDate: '2026-07-17',
                    liveQuoteAsOf: '2026-07-17T19:30:00Z',
                    simulatedDate: '2026-07-20',
                };
                const ctx = loadProbChartsWithPricing(state);
                ctx.OptionComboPricingCore.configureSimTimeBasis({ weekendWeight: 0.3 });
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const timing = {
                    available: true,
                    targetAsOf: '2026-07-20T20:00:00Z',
                };
                const clock = ctx._resolveProbabilityHorizonClock(
                    ctx.OptionComboPricingContext,
                    profile,
                    '2026-07-17',
                    '2026-07-20',
                    timing
                );
                assert.equal(clock.available, true);
                assert.equal(clock.precision, 'instant');
                assert.ok(Math.abs(clock.calDays - 72.5 / 24) < 1e-12);
                assert.ok(Math.abs(clock.effDays - 1.6208333333333333) < 1e-12);
                assert.ok(Math.abs(
                    clock.stepWeights.reduce((sum, value) => sum + value, 0)
                    - clock.effDays
                ) < 1e-12);
            },
        },
        {
            name: 'keeps signed IVTS inversion in total horizon while presenting nonnegative MC steps',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    simWeekendWeight: 0.3,
                    liveQuoteDate: '2026-07-17',
                    liveQuoteAsOf: '2026-07-17T19:30:00Z',
                    simulatedDate: '2026-07-20',
                };
                const ctx = loadProbChartsWithPricing(state);
                ctx.OptionComboPricingCore.configureSimTimeBasis({
                    weekendWeight: {
                        default: 0.3,
                        byDate: {
                            '2026-07-18': -0.2,
                            '2026-07-19': -0.15,
                        },
                        strictByDate: true,
                    },
                });
                const clock = ctx._resolveProbabilityHorizonClock(
                    ctx.OptionComboPricingContext,
                    ctx.OptionComboProductRegistry.resolveUnderlyingProfile('SPY'),
                    '2026-07-17',
                    '2026-07-20',
                    { available: true, targetAsOf: '2026-07-20T20:00:00Z' }
                );
                assert.equal(clock.available, true);
                assert.equal(clock.signedWeightsCoalesced, true);
                assert.ok(clock.negativeStepCount >= 2);
                assert.ok(clock.rawStepWeights.some(weight => weight < 0));
                assert.ok(clock.stepWeights.every(weight => weight >= 0));
                assert.ok(Math.abs(
                    clock.stepWeights.reduce((sum, weight) => sum + weight, 0)
                    - clock.rawStepWeights.reduce((sum, weight) => sum + weight, 0)
                ) < 1e-12);
                assert.ok(Math.abs(
                    clock.stepWeights.reduce((sum, weight) => sum + weight, 0)
                    - clock.effDays
                ) < 1e-12);
            },
        },
        {
            name: 'keeps a same-date future target as a nonzero probability horizon',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    simWeekendWeight: 0.3,
                    liveQuoteDate: '2026-07-20',
                    liveQuoteAsOf: '2026-07-20T14:00:00Z',
                    simulatedDate: '2026-07-20',
                };
                const ctx = loadProbChartsWithPricing(state);
                ctx.OptionComboPricingCore.configureSimTimeBasis({ weekendWeight: 0.3 });
                const clock = ctx._resolveProbabilityHorizonClock(
                    ctx.OptionComboPricingContext,
                    ctx.OptionComboProductRegistry.resolveUnderlyingProfile('SPY'),
                    '2026-07-20',
                    '2026-07-20',
                    { available: true, targetAsOf: '2026-07-20T20:00:00Z' }
                );
                assert.equal(clock.available, true);
                assert.ok(clock.calDays > 0);
                assert.ok(clock.effDays > 0);
                assert.ok(clock.stepWeights.length > 0);
            },
        },
        {
            name: 'zero-horizon unavailable state terminates the in-flight Monte Carlo worker',
            run() {
                // User drags Days-Passed back to 0 while a 1M-path worker is
                // running. Without the terminate, that worker's onmessage is
                // still live and repaints the density, the Expected P&L badge
                // and the closure-captured horizon label for the horizon the
                // user just abandoned, burying the unavailable state.
                const { ctx, fakeWorker } = loadProbChartsWithStaleWorker(
                    staleWorkerState(),
                    { available: true, targetAsOf: '2026-07-20T14:00:00Z' }
                );
                ctx.updateProbCharts();
                assert.equal(
                    fakeWorker.terminated,
                    true,
                    'stale worker must not survive to repaint the abandoned horizon'
                );
                assert.equal(new vm.Script('_activeWorker').runInContext(ctx), null);
            },
        },
        {
            name: 'timing-unavailable state terminates the in-flight Monte Carlo worker',
            run() {
                const { ctx, fakeWorker } = loadProbChartsWithStaleWorker(
                    staleWorkerState(),
                    { available: false, status: 'contract_timing_missing' }
                );
                ctx.updateProbCharts();
                assert.equal(
                    fakeWorker.terminated,
                    true,
                    'stale worker must not survive to overwrite the unavailable message'
                );
                assert.equal(new vm.Script('_activeWorker').runInContext(ctx), null);
            },
        },
    ],
};
