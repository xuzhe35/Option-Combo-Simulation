const assert = require('node:assert/strict');

const { loadPricingContext } = require('./helpers/load-browser-scripts');

function almostEqual(actual, expected, tolerance = 1e-6) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

module.exports = {
    name: 'bsm.js',
    tests: [
        {
            name: 'prices benchmark Black-Scholes call and put values',
            run() {
                const ctx = loadPricingContext();

                almostEqual(ctx.calculateOptionPrice('call', 100, 100, 1, 0.05, 0.2), 10.4505756193, 1e-6);
                almostEqual(ctx.calculateOptionPrice('put', 100, 100, 1, 0.05, 0.2), 5.5735180694, 1e-6);
            },
        },
        {
            name: 'falls back to intrinsic value at expiration',
            run() {
                const ctx = loadPricingContext();

                assert.equal(ctx.calculateOptionPrice('call', 105, 100, 0, 0.05, 0.2), 5);
                assert.equal(ctx.calculateOptionPrice('put', 95, 100, -0.01, 0.05, 0.2), 5);
            },
        },
        {
            name: 'handles date math with UTC-safe helpers',
            run() {
                const ctx = loadPricingContext();

                assert.equal(ctx.diffDays('2026-03-14', '2026-03-20'), 6);
                assert.equal(ctx.addDays('2026/03/14', 3), '2026-03-17');
            },
        },
        {
            name: 'counts trading days while skipping weekends and NYSE holidays',
            run() {
                const ctx = loadPricingContext();

                assert.equal(ctx.calendarToTradingDays('2026-07-02', '2026-07-07'), 2);
                assert.equal(ctx.calendarToTradingDays('2026-11-26', '2026-11-30'), 1);
            },
        },
        {
            name: 'processes active option legs with fixed entry cost basis',
            run() {
                const ctx = loadPricingContext();
                const processed = ctx.processLegData(
                    {
                        type: 'call',
                        pos: 2,
                        strike: 100,
                        expDate: '2026-04-13',
                        iv: 0.25,
                        cost: 1.5,
                        currentPrice: 2.1,
                    },
                    '2026-03-14',
                    0.05,
                    '2026-03-14',
                    100,
                    0.03,
                    'active'
                );

                assert.equal(processed.type, 'call');
                assert.equal(processed.isExpired, false);
                assert.equal(processed.calDTE, 30);
                assert.equal(processed.tradDTE, 19);
                almostEqual(processed.T, 30 / 365);
                assert.equal(processed.simIV, 0.30);
                assert.equal(processed.posMultiplier, 200);
                assert.equal(processed.costBasis, 300);
                assert.equal(processed.effectiveCostPerShare, 1.5);
            },
        },
        {
            name: 'uses live mark as effective cost in trial mode',
            run() {
                const ctx = loadPricingContext();
                const processed = ctx.processLegData(
                    {
                        type: 'put',
                        pos: -1,
                        strike: 95,
                        expDate: '2026-04-13',
                        iv: 0.22,
                        cost: 0,
                        currentPrice: 3.4,
                    },
                    '2026-03-14',
                    0,
                    '2026-03-14',
                    100,
                    0.03,
                    'trial'
                );

                assert.equal(processed.posMultiplier, -100);
                assert.equal(processed.effectiveCostPerShare, 3.4);
                assert.equal(processed.costBasis, -340);
            },
        },
        {
            name: 'falls back to theoretical base-date pricing for offline trial legs',
            run() {
                const ctx = loadPricingContext();
                const leg = {
                    type: 'call',
                    pos: 1,
                    strike: 100,
                    expDate: '2026-04-13',
                    iv: 0.25,
                    cost: 0,
                    currentPrice: 0,
                };

                const processed = ctx.processLegData(
                    leg,
                    '2026-03-20',
                    0.01,
                    '2026-03-14',
                    102,
                    0.03,
                    'trial'
                );

                const expected = ctx.calculateOptionPrice('call', 102, 100, 30 / 365, 0.03, 0.25);
                almostEqual(processed.effectiveCostPerShare, expected, 1e-9);
                almostEqual(processed.costBasis, expected * 100, 1e-9);
            },
        },
        {
            name: 'processes equity underlying legs without option multiplier inflation',
            run() {
                const ctx = loadPricingContext();
                const processed = ctx.processLegData(
                    {
                        type: 'stock',
                        pos: -50,
                        cost: 0,
                        currentPrice: 12.34,
                    },
                    '2026-03-14',
                    0,
                    '2026-03-14',
                    15,
                    0.03,
                    'active'
                );

                assert.equal(processed.type, 'underlying');
                assert.equal(processed.isUnderlyingLeg, true);
                assert.equal(processed.posMultiplier, -50);
                assert.equal(processed.effectiveCostPerShare, 12.34);
                assert.equal(processed.costBasis, -617);
            },
        },
        {
            name: 'uses futures point multiplier for futures underlying legs',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const processed = ctx.processLegData(
                    {
                        type: 'stock',
                        pos: 2,
                        cost: 5900,
                        currentPrice: 5980,
                    },
                    '2026-03-14',
                    0,
                    '2026-03-14',
                    6000,
                    0.03,
                    'active',
                    profile
                );

                assert.equal(processed.type, 'underlying');
                assert.equal(processed.contractMultiplier, 50);
                assert.equal(processed.posMultiplier, 100);
                assert.equal(processed.costBasis, 590000);
            },
        },
        {
            name: 'uses product-family multipliers for non-equity option symbols',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const processed = ctx.processLegData(
                    {
                        type: 'call',
                        pos: 1,
                        strike: 6000,
                        expDate: '2026-04-13',
                        iv: 0.25,
                        cost: 12.5,
                        currentPrice: 13.1,
                    },
                    '2026-03-14',
                    0,
                    '2026-03-14',
                    6100,
                    0.03,
                    'active',
                    profile
                );

                assert.equal(ctx.getMultiplier(profile), 50);
                assert.equal(ctx.getSettlementUnitsPerContract(profile), 1);
                assert.equal(processed.contractMultiplier, 50);
                assert.equal(processed.posMultiplier, 50);
                assert.equal(processed.costBasis, 625);
            },
        },
        {
            name: 'computes leg prices for stock, expired options, and live trial bypass',
            run() {
                const ctx = loadPricingContext();

                assert.equal(
                    ctx.computeLegPrice({ type: 'stock' }, 123.45, 0.03),
                    123.45
                );
                assert.equal(ctx.computeLegPrice({ type: 'stock' }, null, 0.03), null);
                assert.equal(
                    ctx.computeLegPrice({
                        type: 'call',
                        isExpired: false,
                        strike: 100,
                        T: 10 / 365,
                        simIV: 0.2,
                    }, null, 0.03),
                    null
                );
                assert.equal(
                    ctx.computeLegPrice({ type: 'call', isExpired: true, strike: 100 }, 103, 0.03),
                    3
                );

                const processedLeg = {
                    type: 'call',
                    isExpired: false,
                    strike: 100,
                    T: 10 / 365,
                    simIV: 0.2,
                    anchorUnderlyingPrice: 101,
                };
                const rawLeg = {
                    currentPrice: 4.56,
                    closePrice: '',
                };

                assert.equal(
                    ctx.computeSimulatedPrice(
                        processedLeg,
                        rawLeg,
                        101,
                        0.03,
                        'trial',
                        '2026-03-14',
                        '2026-03-14',
                        0
                    ),
                    4.56
                );
            },
        },
        {
            name: 'freezes expired option intrinsic at the historical expiry underlying anchor',
            run() {
                const ctx = loadPricingContext();

                assert.ok(
                    Math.abs(
                        ctx.computeLegPrice(
                            {
                                type: 'call',
                                isExpired: true,
                                strike: 381,
                                expiryUnderlyingPrice: 402.13,
                            },
                            415.19,
                            0.03
                        ) - 21.13
                    ) < 1e-9
                );
            },
        },
        {
            name: 'prefers explicit close price overrides over all other pricing logic',
            run() {
                const ctx = loadPricingContext();

                const simulated = ctx.computeSimulatedPrice(
                    {
                        type: 'put',
                        isExpired: false,
                        strike: 100,
                        T: 5 / 365,
                        simIV: 0.3,
                    },
                    {
                        currentPrice: 2.5,
                        closePrice: '1.23',
                    },
                    99,
                    0.03,
                    'trial',
                    '2026-03-14',
                    '2026-03-14',
                    0
                );

                assert.equal(simulated, 1.23);
            },
        },
        {
            name: 'prices benchmark Black-76 futures option call and put values',
            run() {
                const ctx = loadPricingContext();

                // Black-76: F=100, K=100, T=1, r=0.05, σ=0.2
                // d1 = [ln(1) + (0.04/2)*1] / (0.2*1) = 0.02/0.2 = 0.1
                // d2 = 0.1 - 0.2 = -0.1
                // discount = e^(-0.05) ≈ 0.951229
                // Call = 0.951229 * (100*N(0.1) - 100*N(-0.1))
                //      = 0.951229 * 100 * (N(0.1) - N(-0.1))
                //      = 0.951229 * 100 * 2*(N(0.1)-0.5)
                // N(0.1) ≈ 0.53983 => Call ≈ 0.951229 * 100 * 0.07966 ≈ 7.577
                const call = ctx.calculateBlack76Price('call', 100, 100, 1, 0.05, 0.2);
                const put = ctx.calculateBlack76Price('put', 100, 100, 1, 0.05, 0.2);

                // Verify put-call parity: Call - Put = e^(-rT)(F - K) = 0 for ATM
                almostEqual(call - put, 0, 1e-10);
                // Call should be positive and in reasonable range
                assert.ok(call > 7 && call < 8.5, `Black-76 ATM call=${call} not in [7, 8.5]`);
                almostEqual(call, put, 1e-10);
            },
        },
        {
            name: 'Black-76 falls back to intrinsic at expiration',
            run() {
                const ctx = loadPricingContext();

                assert.equal(ctx.calculateBlack76Price('call', 105, 100, 0, 0.05, 0.2), 5);
                assert.equal(ctx.calculateBlack76Price('put', 95, 100, 0, 0.05, 0.2), 5);
                assert.equal(ctx.calculateBlack76Price('call', 95, 100, 0, 0.05, 0.2), 0);
            },
        },
        {
            name: 'calculatePrice dispatcher routes to correct model',
            run() {
                const ctx = loadPricingContext();

                const bsmCall = ctx.calculateOptionPrice('call', 100, 100, 1, 0.05, 0.2);
                const b76Call = ctx.calculateBlack76Price('call', 100, 100, 1, 0.05, 0.2);

                // dispatcher should match direct calls
                almostEqual(ctx.calculatePrice('bsm-spot', 'call', 100, 100, 1, 0.05, 0.2), bsmCall, 1e-12);
                almostEqual(ctx.calculatePrice('black76', 'call', 100, 100, 1, 0.05, 0.2), b76Call, 1e-12);
                // default (unknown model) should fall back to BSM
                almostEqual(ctx.calculatePrice('unknown', 'call', 100, 100, 1, 0.05, 0.2), bsmCall, 1e-12);
            },
        },
        {
            name: 'uses Black-76 pricing for FOP leg data and forward simulation',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('CL');
                assert.equal(profile.pricingModel, 'black76');

                const leg = {
                    type: 'call',
                    pos: 1,
                    strike: 75,
                    expDate: '2026-04-13',
                    iv: 0.30,
                    cost: 0,
                    currentPrice: 0,
                };

                // processLegData should use Black-76 for offline trial cost
                const processed = ctx.processLegData(
                    leg,
                    '2026-03-20',
                    0,
                    '2026-03-14',
                    72.5,
                    0.03,
                    'trial',
                    profile
                );
                assert.equal(processed.pricingModel, 'black76');

                // the offline trial cost should match Black-76 directly
                const baseCalDTE = ctx.diffDays('2026-03-14', '2026-04-13');
                const baseT = baseCalDTE / 365.0;
                const expectedCost = ctx.calculateBlack76Price('call', 72.5, 75, baseT, 0.03, 0.30);
                almostEqual(processed.effectiveCostPerShare, expectedCost, 1e-9);

                // computeLegPrice should also use Black-76
                const simPrice = ctx.computeLegPrice(processed, 74, 0.03);
                const expectedSim = ctx.calculateBlack76Price('call', 74, 75, processed.T, 0.03, processed.simIV);
                almostEqual(simPrice, expectedSim, 1e-9);
            },
        },
        {
            name: 'resolves the MC horizon on the same scalar and per-date lambda clock as repricing',
            run() {
                const ctx = loadPricingContext();

                ctx.configureSimTimeBasis({ weekendWeight: 0.3 });
                const scalar = ctx.resolveSimHorizonClock(
                    '2026-07-10', '2026-07-17', 'NYSE', 'live'
                );
                assert.equal(scalar.available, true);
                assert.equal(scalar.calDays, 7);
                assert.equal(scalar.tradingDays, 5);
                assert.equal(scalar.nonTradingDays, 2);
                almostEqual(scalar.effDays, 5.6, 1e-12);
                assert.deepEqual(Array.from(scalar.stepWeights), [1, 0.3, 0.3, 1, 1, 1, 1]);
                assert.equal(scalar.isCalendarClock, false);
                assert.equal(scalar.usedPerDateWeight, false);

                ctx.configureSimTimeBasis({
                    weekendWeight: {
                        default: 0.3,
                        byDate: {
                            '2026-07-11': 0.1,
                            '2026-07-12': 0.7,
                            // Overrides apply only to actual non-trading dates.
                            '2026-07-13': 0,
                        },
                    },
                });
                const structured = ctx.resolveSimHorizonClock(
                    '2026-07-10', '2026-07-17', 'NYSE', 'live'
                );
                assert.equal(structured.available, true);
                almostEqual(structured.effDays, 5.8, 1e-12);
                assert.deepEqual(
                    Array.from(structured.stepWeights),
                    [1, 0.1, 0.7, 1, 1, 1, 1]
                );
                assert.equal(structured.usedPerDateWeight, true);
            },
        },
        {
            name: 'treats full exchange holidays like weekends and respects product-specific calendars',
            run() {
                const ctx = loadPricingContext();
                ctx.configureSimTimeBasis({ weekendWeight: 0.3 });

                const laborDay = ctx.resolveSimHorizonClock(
                    '2026-09-04', '2026-09-08', 'NYSE', 'live'
                );
                assert.equal(laborDay.available, true);
                assert.equal(laborDay.tradingDays, 1);
                assert.equal(laborDay.nonTradingDays, 3);
                almostEqual(laborDay.effDays, 1.9, 1e-12);
                assert.deepEqual(
                    Array.from(laborDay.steps, step => step.kind),
                    ['trading', 'weekend', 'weekend', 'exchange_holiday']
                );

                // Good Friday 2026 is closed for NYSE and NYMEX CL, while
                // CME ES has a business trade date in the official schedule.
                const nyse = ctx.resolveSimHorizonClock(
                    '2026-04-03', '2026-04-04', 'NYSE', 'live'
                );
                const es = ctx.resolveSimHorizonClock(
                    '2026-04-03', '2026-04-04', 'CME:ES', 'live'
                );
                const cl = ctx.resolveSimHorizonClock(
                    '2026-04-03', '2026-04-04', 'NYMEX:CL', 'live'
                );
                assert.equal(nyse.steps[0].kind, 'exchange_holiday');
                assert.equal(es.steps[0].kind, 'trading');
                assert.equal(cl.steps[0].kind, 'exchange_holiday');
                almostEqual(nyse.effDays, 0.3, 1e-12);
                almostEqual(es.effDays, 1, 1e-12);
                almostEqual(cl.effDays, 0.3, 1e-12);
            },
        },
        {
            name: 'MC horizon fails closed without complete official or observed calendar coverage',
            run() {
                const ctx = loadPricingContext();
                ctx.configureSimTimeBasis({ weekendWeight: 0.3 });

                assert.equal(
                    ctx.resolveSimHorizonClock(
                        '2026-07-10', '2026-07-13', 'UNKNOWN', 'live'
                    ).status,
                    'calendar_unavailable'
                );
                assert.equal(
                    ctx.resolveSimHorizonClock(
                        '2024-07-10', '2024-07-13', 'NYSE', 'live'
                    ).status,
                    'calendar_unavailable'
                );
                // A weekend-only interval must still prove official coverage;
                // CME coverage ends on 2028-05-05.
                assert.equal(
                    ctx.resolveSimHorizonClock(
                        '2028-05-06', '2028-05-08', 'CME:ES', 'live'
                    ).status,
                    'calendar_unavailable'
                );

                ctx.configureSimTimeBasis({ weekendWeight: 0.3 });
                assert.equal(
                    ctx.resolveSimHorizonClock(
                        '2026-07-10', '2026-07-13', 'NYSE', 'historical'
                    ).status,
                    'calendar_unavailable'
                );

                ctx.configureSimTimeBasis({
                    weekendWeight: 0.3,
                    observedTradingDates: ['2026-07-10', '2026-07-13'],
                });
                const observed = ctx.resolveSimHorizonClock(
                    '2026-07-10', '2026-07-13', 'NYSE', 'historical'
                );
                assert.equal(observed.available, true);
                assert.deepEqual(Array.from(observed.stepWeights), [1, 0.3, 0.3]);

                ctx.configureSimTimeBasis({
                    weekendWeight: 0.3,
                    observedTradingDates: ['2026-07-13'],
                });
                assert.equal(
                    ctx.resolveSimHorizonClock(
                        '2026-07-10', '2026-07-13', 'NYSE', 'historical'
                    ).status,
                    'calendar_unavailable'
                );
                assert.equal(
                    ctx.resolveSimHorizonClock(
                        '2026-07-17', '2026-07-10', 'NYSE', 'live'
                    ).status,
                    'invalid_horizon'
                );
                const zero = ctx.resolveSimHorizonClock(
                    '2026-07-10', '2026-07-10', 'NYSE', 'live'
                );
                assert.equal(zero.available, true);
                assert.equal(zero.effDays, 0);
                assert.deepEqual(Array.from(zero.stepWeights), []);
            },
        },
        {
            name: 'counts weighted days with weekends and holidays at the configured weight',
            run() {
                const ctx = loadPricingContext();

                // 2026-07-08 Wed -> 2026-07-13 Mon: 3 trading days + Sat/Sun.
                assert.equal(ctx.countWeightedDays('2026-07-08', '2026-07-13', 0), 3);
                assert.equal(ctx.countWeightedDays('2026-07-08', '2026-07-13', 1), 5);
                assert.equal(ctx.countWeightedDays('2026-07-08', '2026-07-13', 0.5), 4);
                // Thanksgiving 2026-11-26 counts as a non-trading day.
                assert.equal(ctx.countWeightedDays('2026-11-25', '2026-11-27', 0), 1);
                assert.equal(ctx.countWeightedDays('2026-11-25', '2026-11-27', 0.5), 1.5);
                // Out-of-range weights clamp instead of exploding.
                assert.equal(ctx.countWeightedDays('2026-07-08', '2026-07-13', 7), 5);
                assert.equal(ctx.countWeightedDays('2026-07-08', '2026-07-13', -1), 3);
            },
        },
        {
            name: 'counts weighted days with per-date lambda overrides',
            run() {
                const ctx = loadPricingContext();

                // 2026-07-08 Wed -> 2026-07-13 Mon: 3 trading days, and the
                // Sat/Sun each carry their own implied weight instead of the
                // default.
                const spec = { default: 0.5, byDate: { '2026-07-11': 0.25, '2026-07-12': 0.25 } };
                assert.equal(ctx.countWeightedDays('2026-07-08', '2026-07-13', spec), 3.5);
                // A non-trading day without an override uses the default:
                // Thanksgiving 2026-11-26 has no byDate entry here.
                assert.equal(
                    ctx.countWeightedDays('2026-11-25', '2026-11-27', spec),
                    1.5
                );

                const normalized = ctx.OptionComboDateUtils.normalizeWeekendWeightSpec({
                    default: 2,
                    byDate: { '2026-07-11': -3, garbage: 0.5, '2026-07-12': 'x' },
                });
                assert.equal(normalized.default, 1);
                assert.equal(normalized.byDate['2026-07-11'], -3);
                assert.equal('2026-07-12' in normalized.byDate, false);
                assert.equal('garbage' in normalized.byDate, false);
                assert.equal(normalized.minWeight, -3);
                assert.equal(normalized.differsFromCalendar, true);
            },
        },
        {
            name: 'a weekend weighted ABOVE 1 still diverges from the calendar clock',
            run() {
                const ctx = loadPricingContext();
                const dateUtils = ctx.OptionComboDateUtils;
                const pricingCore = ctx.OptionComboPricingCore;

                // Price-derived lambdas are deliberately unclamped, so an
                // event-heavy weekend can exceed 1. minWeight only ever tracks
                // the MINIMUM, so it cannot see this; differsFromCalendar must.
                const heavy = {
                    default: 1,
                    byDate: { '2026-04-04': 1.35, '2026-04-05': 1.35 },
                };
                const spec = dateUtils.normalizeWeekendWeightSpec(heavy);
                assert.equal(spec.minWeight, 1, 'minWeight cannot detect an above-1 weekend');
                assert.equal(spec.differsFromCalendar, true);
                assert.equal(
                    pricingCore.weekendWeightActive(heavy),
                    true,
                    'the weighted-clock path must run, otherwise the weekend is priced at 1.0'
                );

                // The under-weighting this guards against: weighting the two
                // weekend days at 1.35 instead of 1.0 must move the clock.
                assert.equal(
                    dateUtils.countWeightedDays('2026-04-02', '2026-04-06', heavy),
                    2 + 1.35 + 1.35
                );

                // A genuinely flat spec is still the calendar clock.
                const flat = { default: 1, byDate: { '2026-04-04': 1, '2026-04-05': 1 } };
                assert.equal(dateUtils.normalizeWeekendWeightSpec(flat).differsFromCalendar, false);
                assert.equal(pricingCore.weekendWeightActive(flat), false);
                assert.equal(dateUtils.normalizeWeekendWeightSpec(0.3).differsFromCalendar, true);
                assert.equal(dateUtils.normalizeWeekendWeightSpec(1).differsFromCalendar, false);
            },
        },
        {
            name: 'per-date lambda keeps the anchor price and decays each weekend at its own weight',
            run() {
                const ctx = loadPricingContext();
                const leg = { type: 'call', pos: 1, strike: 100, expDate: '2026-07-24', iv: 0.25, cost: 1.5 };
                const anchor = '2026-07-08';

                ctx.configureSimTimeBasis({ weekendWeight: 1 });
                const calendarAnchor = ctx.processLegData(leg, anchor, 0, anchor, 100, 0.05, 'active');
                const calendarPrice = ctx.computeLegPrice(calendarAnchor, 100, 0.05);

                const firstWeekendZero = {
                    default: 0.3,
                    byDate: { '2026-07-11': 0, '2026-07-12': 0 },
                };
                ctx.configureSimTimeBasis({ weekendWeight: firstWeekendZero });
                const specAnchor = ctx.processLegData(leg, anchor, 0, anchor, 100, 0.05, 'active');
                // The IV conversion preserves total variance at the anchor, so
                // per-date weights must not move the anchor-date price either.
                almostEqual(ctx.computeLegPrice(specAnchor, 100, 0.05), calendarPrice, 1e-9);

                // After the first weekend has passed, a zero-weight first
                // weekend burned no variance, so more option value remains
                // than under the uniform 0.3 clock.
                const specMonday = ctx.processLegData(leg, '2026-07-13', 0, anchor, 100, 0.05, 'active');
                const specMondayPrice = ctx.computeLegPrice(specMonday, 100, 0.05);
                ctx.configureSimTimeBasis({ weekendWeight: 0.3 });
                const uniformMonday = ctx.processLegData(leg, '2026-07-13', 0, anchor, 100, 0.05, 'active');
                const uniformMondayPrice = ctx.computeLegPrice(uniformMonday, 100, 0.05);
                assert.ok(specMondayPrice > uniformMondayPrice);
            },
        },
        {
            name: 'structured lambda uses the live quote anchor across multiple weekends',
            run() {
                const ctx = loadPricingContext();
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    baseDate: '2026-07-01',
                    liveQuoteDate: '2026-07-10',
                    simulatedDate: '2026-07-20',
                };
                const leg = {
                    type: 'call',
                    pos: 1,
                    strike: 100,
                    expDate: '2026-07-27',
                    iv: 0.24,
                    cost: 2,
                };
                const weightSpec = {
                    default: 0.35,
                    byDate: {
                        '2026-07-11': 0.10,
                        '2026-07-12': 0.10,
                        '2026-07-18': 0.60,
                        '2026-07-19': 0.60,
                        '2026-07-25': 0.20,
                        '2026-07-26': 0.20,
                    },
                };
                const quoteDate = ctx.OptionComboPricingContext.resolveQuoteDate(state);
                assert.equal(quoteDate, '2026-07-10');
                assert.notEqual(quoteDate, state.baseDate);
                almostEqual(
                    ctx.countWeightedDays(quoteDate, leg.expDate, weightSpec),
                    12.8,
                    1e-12
                );
                almostEqual(
                    ctx.countWeightedDays(state.simulatedDate, leg.expDate, weightSpec),
                    5.4,
                    1e-12
                );

                ctx.configureSimTimeBasis({ weekendWeight: 1 });
                const calendarAnchor = ctx.processLegData(
                    leg, quoteDate, 0, quoteDate, 100, 0.05, 'active'
                );
                const calendarAnchorPrice = ctx.computeLegPrice(calendarAnchor, 100, 0.05);

                ctx.configureSimTimeBasis({ weekendWeight: weightSpec });
                const structuredAnchor = ctx.processLegData(
                    leg, quoteDate, 0, quoteDate, 100, 0.05, 'active'
                );
                almostEqual(
                    ctx.computeLegPrice(structuredAnchor, 100, 0.05),
                    calendarAnchorPrice,
                    1e-9
                );

                const structuredTarget = ctx.processLegData(
                    leg, state.simulatedDate, 0, quoteDate, 100, 0.05, 'active'
                );
                const expectedRemainingVariance = leg.iv * leg.iv * (17 / 365) * (5.4 / 12.8);
                almostEqual(
                    structuredTarget.simIV * structuredTarget.simIV * structuredTarget.T,
                    expectedRemainingVariance,
                    1e-12
                );
                almostEqual(structuredTarget.rateT, 7 / 365, 1e-12);
            },
        },
        {
            name: 'weighted clock at weight 1 reproduces the calendar clock exactly',
            run() {
                const ctx = loadPricingContext();
                const leg = { type: 'call', pos: 1, strike: 100, expDate: '2026-07-17', iv: 0.25, cost: 1.5 };

                const calendarProcessed = ctx.processLegData(leg, '2026-07-08', 0, '2026-07-08', 100, 0.03, 'active');
                ctx.configureSimTimeBasis({ weekendWeight: 1 });
                const weightedProcessed = ctx.processLegData(leg, '2026-07-08', 0, '2026-07-08', 100, 0.03, 'active');

                assert.equal(weightedProcessed.T, calendarProcessed.T);
                assert.equal(weightedProcessed.simIV, calendarProcessed.simIV);
                // Invalid config falls back to the calendar clock.
                assert.equal(ctx.configureSimTimeBasis({ weekendWeight: 'bogus' }), 1);
                assert.equal(ctx.configureSimTimeBasis(null), 1);
            },
        },
        {
            name: 'switching the time basis never changes the price as of the base date',
            run() {
                const ctx = loadPricingContext();
                const leg = { type: 'put', pos: 1, strike: 100, expDate: '2026-07-17', iv: 0.3, cost: 2 };
                const interestRate = 0.05;
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    baseDate: '2026-07-01',
                    liveQuoteDate: '2026-07-08',
                    simulatedDate: '2026-07-08',
                };
                const quoteDate = ctx.OptionComboPricingContext.resolveQuoteDate(state);
                assert.equal(quoteDate, '2026-07-08');

                const calendarProcessed = ctx.processLegData(leg, state.simulatedDate, 0, quoteDate, 100, interestRate, 'active');
                const calendarPrice = ctx.computeLegPrice(calendarProcessed, 100, interestRate);

                ctx.configureSimTimeBasis({ weekendWeight: 0.3 });
                const weightedProcessed = ctx.processLegData(leg, state.simulatedDate, 0, quoteDate, 100, interestRate, 'active');
                const weightedPrice = ctx.computeLegPrice(weightedProcessed, 100, interestRate);

                ctx.configureSimTimeBasis({ weekendWeight: 0 });
                const tradingProcessed = ctx.processLegData(leg, state.simulatedDate, 0, quoteDate, 100, interestRate, 'active');
                const tradingPrice = ctx.computeLegPrice(tradingProcessed, 100, interestRate);

                almostEqual(weightedPrice, calendarPrice, 1e-9);
                almostEqual(tradingPrice, calendarPrice, 1e-9);
                almostEqual(weightedProcessed.rateT, calendarProcessed.rateT, 1e-12);
                almostEqual(tradingProcessed.rateT, calendarProcessed.rateT, 1e-12);
                // The converted IV carries the same total variance: cal 9d/365 vs 7 trading d/252.
                almostEqual(
                    tradingProcessed.simIV,
                    0.3 * Math.sqrt((9 / 365) / (7 / 252)),
                    1e-12
                );
            },
        },
        {
            name: 'Black-76 anchor price is invariant across lambda at nonzero rates and IV adjustment',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('CL');
                const leg = { type: 'call', pos: 1, strike: 75, expDate: '2026-07-20', iv: 0.25, cost: 2 };
                const prices = [];

                [1, 0.3, 0].forEach((weekendWeight) => {
                    ctx.configureSimTimeBasis({ weekendWeight });
                    const processed = ctx.processLegData(
                        leg,
                        '2026-07-15',
                        0.01,
                        '2026-07-15',
                        75,
                        0.05,
                        'active',
                        profile
                    );
                    almostEqual(processed.rateT, 5 / 365, 1e-12);
                    prices.push(ctx.computeLegPrice(processed, 75, 0.05));
                });

                almostEqual(prices[1], prices[0], 1e-9);
                almostEqual(prices[2], prices[0], 1e-9);
            },
        },
        {
            name: 'trading-day clock stops theta over the weekend and keeps the conversion anchored',
            run() {
                const ctx = loadPricingContext();
                const leg = { type: 'call', pos: 1, strike: 100, expDate: '2026-07-17', iv: 0.25, cost: 1.5 };

                ctx.configureSimTimeBasis({ weekendWeight: 0 });
                const saturday = ctx.processLegData(leg, '2026-07-11', 0, '2026-07-08', 100, 0, 'active');
                const monday = ctx.processLegData(leg, '2026-07-13', 0, '2026-07-08', 100, 0, 'active');

                // Sat -> Mon spans only non-trading days: T and IV are frozen,
                // so the simulated price is identical (no phantom weekend theta).
                assert.equal(saturday.T, monday.T);
                assert.equal(saturday.simIV, monday.simIV);
                almostEqual(
                    ctx.computeLegPrice(saturday, 100, 0),
                    ctx.computeLegPrice(monday, 100, 0),
                    1e-12
                );

                // The conversion factor is anchored at the base date, not the
                // simulated date: simIV must not drift as the sim advances.
                const friday = ctx.processLegData(leg, '2026-07-10', 0, '2026-07-08', 100, 0, 'active');
                assert.equal(friday.simIV, saturday.simIV);

                // On the calendar clock the same weekend does decay.
                ctx.configureSimTimeBasis({ weekendWeight: 1 });
                const calSaturday = ctx.processLegData(leg, '2026-07-11', 0, '2026-07-08', 100, 0, 'active');
                const calMonday = ctx.processLegData(leg, '2026-07-13', 0, '2026-07-08', 100, 0, 'active');
                assert.ok(calMonday.T < calSaturday.T);
            },
        },
        {
            name: 'floors the weighted clock so a leg is not marked to intrinsic before its last session',
            run() {
                const ctx = loadPricingContext();
                const leg = { type: 'call', pos: 1, strike: 100, expDate: '2026-07-13', iv: 0.25, cost: 1.5 };

                ctx.configureSimTimeBasis({ weekendWeight: 0 });
                // Saturday before a Monday expiry: zero weighted days remain,
                // but Monday's session has not happened yet.
                const saturday = ctx.processLegData(leg, '2026-07-11', 0, '2026-07-08', 100, 0, 'active');
                assert.equal(saturday.isExpired, false);
                almostEqual(saturday.T, 0.5 / 252, 1e-12);
            },
        },
        {
            name: 'keeps a live ES 0DTE leg active intraday but treats a future expiry-date target as settlement',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const oneMinuteT = 1 / (365 * 24 * 60);
                const liveMark = ctx.calculateBlack76Price(
                    'call', 7530, 7530, oneMinuteT, 0.04, 0.687, oneMinuteT
                );
                const leg = {
                    type: 'call',
                    pos: 1,
                    strike: 7530,
                    expDate: '2026-07-17',
                    iv: 0.687,
                    cost: 1,
                    currentPrice: liveMark,
                    currentPriceSource: 'live',
                };

                const beforeCutoff = ctx.processLegData(
                    leg,
                    '2026-07-17',
                    0,
                    '2026-07-17',
                    7530,
                    0.04,
                    'active',
                    profile,
                    'live',
                    { quoteAsOf: '2026-07-17T19:59:00Z' }
                );
                assert.equal(beforeCutoff.isExpired, false);
                assert.equal(beforeCutoff.intradayActive, true);
                assert.equal(beforeCutoff.intradayTimeSource, 'product-profile');
                assert.equal(beforeCutoff.expiryCutoffAsOf, '2026-07-17T20:00:00.000Z');
                almostEqual(beforeCutoff.T, oneMinuteT, 1e-10);
                almostEqual(ctx.computeLegPrice(beforeCutoff, 7530, 0.04), liveMark, 1e-8);
                almostEqual(
                    ctx.computeSimulatedPrice(
                        beforeCutoff, leg, 7530, 0.04, 'active',
                        '2026-07-17', '2026-07-17', 0
                    ),
                    liveMark,
                    1e-12
                );

                const afterCutoff = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-17', 7530, 0.04,
                    'active', profile, 'live', { quoteAsOf: '2026-07-17T20:00:01Z' }
                );
                assert.equal(afterCutoff.isExpired, true);
                assert.equal(afterCutoff.intradayActive, false);

                const forecastTargetAsOf = '2026-07-17T19:30:00.000Z';
                const forecastAtClose = ctx.processLegData(
                    { ...leg, expiryAsOf: forecastTargetAsOf },
                    '2026-07-17', 0, '2026-07-10', 7530, 0.04,
                    'active', profile, 'live', {
                        quoteAsOf: '2026-07-10T19:00:00Z',
                        targetAsOf: forecastTargetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                    }
                );
                assert.equal(forecastAtClose.isExpired, true);
                assert.equal(forecastAtClose.exactTimingActive, true);
                assert.equal(forecastAtClose.targetAsOf, forecastTargetAsOf);
                assert.equal(ctx.computeLegPrice(forecastAtClose, 7530, 0.04), 0);

                // The same future target is settlement only for the near
                // leg. A calendar's later expiry still carries its remaining
                // weighted time from the target close.
                ctx.configureSimTimeBasis({ weekendWeight: 0.3 });
                const farAtForecastClose = ctx.processLegData(
                    {
                        ...leg,
                        expDate: '2026-07-20',
                        expiryAsOf: '2026-07-20T20:00:00.000Z',
                    },
                    '2026-07-17', 0, '2026-07-10', 7530, 0.04,
                    'active', profile, 'live', {
                        quoteAsOf: '2026-07-10T19:00:00Z',
                        targetAsOf: forecastTargetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                    }
                );
                assert.equal(farAtForecastClose.isExpired, false);
                almostEqual(farAtForecastClose.calDTE, 72.5 / 24, 1e-12);
                almostEqual(farAtForecastClose.rateT, (72.5 / 24) / 365, 1e-12);
                almostEqual(
                    farAtForecastClose.T,
                    1.6208333333333333 / (252 + 0.3 * 113),
                    1e-12
                );

                const contractTimedLeg = {
                    ...leg,
                    expiryAsOf: '2026-07-17T19:30:00.000Z',
                };
                const contractTimed = ctx.processLegData(
                    contractTimedLeg, '2026-07-17', 0, '2026-07-17', 7530, 0.04,
                    'active', profile, 'live', { quoteAsOf: '2026-07-17T19:29:00Z' }
                );
                assert.equal(contractTimed.isExpired, false);
                assert.equal(contractTimed.intradayTimeSource, 'contract');
                assert.equal(contractTimed.expiryCutoffAsOf, '2026-07-17T19:30:00.000Z');
                almostEqual(
                    contractTimed.T,
                    (1 / (24 * 60)) / (252 + 0.3 * 113),
                    1e-12
                );
                almostEqual(
                    contractTimed.simIV * contractTimed.simIV * contractTimed.T,
                    leg.iv * leg.iv * oneMinuteT,
                    1e-12
                );
                const contractExpired = ctx.processLegData(
                    contractTimedLeg, '2026-07-17', 0, '2026-07-17', 7530, 0.04,
                    'active', profile, 'live', { quoteAsOf: '2026-07-17T19:30:00Z' }
                );
                assert.equal(contractExpired.isExpired, true);
            },
        },
        {
            name: 'exact timestamp clock fails closed when strict implied-lambda coverage has a gap',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const farLeg = {
                    type: 'call',
                    pos: 1,
                    strike: 7530,
                    expDate: '2026-07-20',
                    expiryAsOf: '2026-07-20T20:00:00.000Z',
                    iv: 0.20,
                    cost: 1,
                };
                const completeWeights = {
                    default: 0.3,
                    strictByDate: true,
                    byDate: {
                        '2026-07-11': 0.2,
                        '2026-07-12': 0.2,
                        '2026-07-18': 0.4,
                        '2026-07-19': 0.4,
                    },
                };
                const timing = {
                    quoteAsOf: '2026-07-10T19:00:00.000Z',
                    targetAsOf: '2026-07-17T19:30:00.000Z',
                    targetSource: 'near-leg-contract-cutoff',
                };

                ctx.configureSimTimeBasis({ weekendWeight: completeWeights });
                const complete = ctx.processLegData(
                    farLeg, '2026-07-17', 0, '2026-07-10', 7530, 0.04,
                    'active', profile, 'live', timing
                );
                assert.equal(complete.timingAvailable, true);
                assert.ok(Number.isFinite(complete.T));
                assert.ok(Number.isFinite(complete.simIV));

                const missingSunday = {
                    ...completeWeights,
                    byDate: { ...completeWeights.byDate },
                };
                delete missingSunday.byDate['2026-07-19'];
                ctx.configureSimTimeBasis({ weekendWeight: missingSunday });
                const unavailable = ctx.processLegData(
                    farLeg, '2026-07-17', 0, '2026-07-10', 7530, 0.04,
                    'active', profile, 'live', timing
                );
                assert.equal(unavailable.isExpired, false);
                assert.equal(unavailable.timingAvailable, false);
                assert.equal(unavailable.timingStatus, 'implied_lambda_incomplete');
                assert.equal(unavailable.T, null);
                assert.equal(unavailable.simIV, null);
                assert.equal(ctx.computeLegPrice(unavailable, 7530, 0.04), null);

                // The expiring near leg is already deterministic at the
                // shared target cutoff. Missing λ on its quote-time anchor,
                // and even a wildly different discount rate, must not leak
                // into the intrinsic payoff.
                const nearLeg = {
                    ...farLeg,
                    strike: 7500,
                    expDate: '2026-07-17',
                    expiryAsOf: timing.targetAsOf,
                };
                ctx.configureSimTimeBasis({
                    weekendWeight: {
                        default: 0.3,
                        strictByDate: true,
                        byDate: {},
                    },
                });
                const deterministicNear = ctx.processLegData(
                    nearLeg, '2026-07-17', 0, '2026-07-10', 7530, -0.5,
                    'active', profile, 'live', timing
                );
                assert.equal(deterministicNear.isExpired, true);
                assert.equal(deterministicNear.timingAvailable, true);
                assert.equal(deterministicNear.T, 0);
                assert.equal(deterministicNear.rateT, 0);
                assert.equal(ctx.computeLegPrice(deterministicNear, 7530, -0.5), 30);
            },
        },
        {
            name: 'anchors active current-date valuation to the observable live mark at the current underlier only',
            run() {
                const ctx = loadPricingContext();
                const leg = {
                    type: 'put', pos: 1, strike: 100, expDate: '2026-07-24',
                    iv: 0.25, cost: 1, currentPrice: 2.345, currentPriceSource: 'live',
                };
                const quoteAsOf = '2026-07-17T14:00:00.000Z';
                const processed = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-17', 100, 0.03, 'active',
                    null, 'live', {
                        quoteAsOf,
                        targetAsOf: quoteAsOf,
                        targetSource: 'live-quote',
                        observablePrice: 2.345,
                    }
                );
                assert.equal(processed.isObservableQuoteInstant, true);
                assert.equal(
                    ctx.computeSimulatedPrice(
                        processed, leg, 100, 0.03, 'active',
                        '2026-07-17', '2026-07-17', 0
                    ),
                    2.345
                );
                assert.notEqual(
                    ctx.computeSimulatedPrice(
                        processed, leg, 101, 0.03, 'active',
                        '2026-07-17', '2026-07-17', 0
                    ),
                    2.345
                );

                // A later target on the same civil date is a scenario, not the
                // observable quote boundary, and therefore must use the model.
                const laterSameDate = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-17', 100, 0.03, 'active',
                    null, 'live', {
                        quoteAsOf,
                        targetAsOf: '2026-07-17T15:00:00.000Z',
                        targetSource: 'explicit',
                        observablePrice: 2.345,
                    }
                );
                assert.equal(laterSameDate.isObservableQuoteInstant, false);
                assert.notEqual(
                    ctx.computeSimulatedPrice(
                        laterSameDate, leg, 100, 0.03, 'active',
                        '2026-07-17', '2026-07-17', 0
                    ),
                    2.345
                );
            },
        },
        {
            name: 'inverts BSM and Black-76 prices with independent variance and discount clocks',
            run() {
                const ctx = loadPricingContext();
                const cases = [
                    { model: 'bsm-spot', type: 'put', underlying: 101, strike: 100, iv: 0.37 },
                    { model: 'black76', type: 'call', underlying: 7535, strike: 7500, iv: 0.22 },
                ];
                cases.forEach((item) => {
                    const varianceT = 0.0175;
                    const rateT = 0.031;
                    const rate = 0.043;
                    const price = ctx.calculatePrice(
                        item.model,
                        item.type,
                        item.underlying,
                        item.strike,
                        varianceT,
                        rate,
                        item.iv,
                        rateT
                    );
                    const solved = ctx.solveImpliedVolatility(
                        item.model,
                        item.type,
                        item.underlying,
                        item.strike,
                        varianceT,
                        rate,
                        price,
                        rateT
                    );
                    assert.equal(solved.available, true);
                    almostEqual(solved.impliedVolatility, item.iv, 1e-10);
                    almostEqual(solved.totalVariance, item.iv * item.iv * varianceT, 1e-12);
                    almostEqual(solved.modelPrice, price, 1e-10);
                });
            },
        },
        {
            name: 'anchors current and future ES repricing to the local two-sided BBO implied IV',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                ctx.configureSimTimeBasis({ weekendWeight: 0.3 });
                const quoteAsOf = '2026-07-10T19:00:00.000Z';
                const expiryAsOf = '2026-07-20T20:00:00.000Z';
                const quoteForward = 7530;
                const quoteRate = 0.04;
                const localIv = 0.22;
                const leg = {
                    type: 'call',
                    pos: 1,
                    strike: 7530,
                    expDate: '2026-07-20',
                    expiryAsOf,
                    // Deliberately wrong vendor IV: the BBO inversion must win.
                    iv: 0.80,
                    ivSource: 'live',
                    cost: 1,
                    currentPrice: 1,
                    currentPriceSource: 'live',
                };
                const clock = ctx.processLegData(
                    leg, '2026-07-10', 0, '2026-07-10', quoteForward, quoteRate,
                    'active', profile, 'live', {
                        quoteAsOf,
                        targetAsOf: quoteAsOf,
                        targetSource: 'live-quote',
                    }
                );
                const bboMid = ctx.calculateBlack76Price(
                    'call', quoteForward, leg.strike, clock.T, quoteRate, localIv, clock.rateT
                );
                const bboTiming = {
                    quoteAsOf,
                    observablePrice: bboMid,
                    observablePriceSource: 'live_midpoint',
                    observablePriceAsOf: quoteAsOf,
                    observablePriceFresh: true,
                    quotePricingInputsAvailable: true,
                    quotePricingInputStatus: 'ok',
                    quoteUnderlyingPrice: quoteForward,
                    quoteUnderlyingAsOf: quoteAsOf,
                    quoteInterestRate: quoteRate,
                };

                const current = ctx.processLegData(
                    leg, '2026-07-10', 0, '2026-07-10', quoteForward, quoteRate,
                    'active', profile, 'live', {
                        ...bboTiming,
                        targetAsOf: quoteAsOf,
                        targetSource: 'live-quote',
                    }
                );
                assert.equal(current.localIvAnchorAvailable, true);
                assert.equal(current.simIVSource, 'local-bbo-implied');
                almostEqual(current.simIV, localIv, 1e-10);
                almostEqual(current.localAnchorTotalVariance, localIv * localIv * current.T, 1e-12);
                almostEqual(
                    ctx.computeSimulatedPrice(
                        current, leg, quoteForward, quoteRate, 'active',
                        '2026-07-10', '2026-07-10', 0
                    ),
                    bboMid,
                    1e-12
                );

                const targetAsOf = '2026-07-17T19:30:00.000Z';
                const targetRate = 0.045;
                const targetForward = 7540;
                const future = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', quoteForward, targetRate,
                    'active', profile, 'live', {
                        ...bboTiming,
                        targetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                    }
                );
                assert.equal(future.localIvAnchorAvailable, true);
                almostEqual(future.simIV, localIv, 1e-10);
                const expectedFuturePrice = ctx.calculateBlack76Price(
                    'call', targetForward, leg.strike,
                    future.T, targetRate, localIv, future.rateT
                );
                almostEqual(
                    ctx.computeSimulatedPrice(
                        future, leg, targetForward, targetRate, 'active',
                        '2026-07-17', '2026-07-10', 0
                    ),
                    expectedFuturePrice,
                    1e-10
                );

                const modelFallback = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', quoteForward, targetRate,
                    'active', profile, 'live', {
                        ...bboTiming,
                        observablePriceSource: 'tws_model',
                        targetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                    }
                );
                assert.equal(modelFallback.localIvAnchorAttempted, false);
                assert.equal(modelFallback.localIvAnchorStatus, 'not_two_sided_bbo');
                assert.notEqual(modelFallback.simIVSource, 'local-bbo-implied');
                assert.ok(Math.abs(modelFallback.simIV - localIv) > 0.1);

                const staleBbo = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', quoteForward, targetRate,
                    'active', profile, 'live', {
                        ...bboTiming,
                        observablePriceFresh: false,
                        targetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                    }
                );
                assert.equal(staleBbo.localIvAnchorAttempted, true);
                assert.equal(staleBbo.localIvAnchorAvailable, false);
                assert.equal(staleBbo.localIvAnchorStatus, 'option_bbo_stale_or_timestamp_invalid');
                assert.equal(staleBbo.simIV, null);

                const staleBboBestEffort = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', quoteForward, targetRate,
                    'active', profile, 'live', {
                        ...bboTiming,
                        observablePriceFresh: false,
                        targetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                        allowProjectionIvFallback: true,
                    }
                );
                assert.equal(staleBboBestEffort.localIvAnchorAvailable, false);
                assert.ok(Number.isFinite(staleBboBestEffort.simIV));
                assert.equal(staleBboBestEffort.simIVSource, 'best-effort-input-iv');
                assert.equal(staleBboBestEffort.simIVFallbackSource, leg.ivSource || 'manual');

                const thirtySecondBbo = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', quoteForward, targetRate,
                    'active', profile, 'live', {
                        ...bboTiming,
                        observablePriceAsOf: '2026-07-10T19:00:30.000Z',
                        targetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                    }
                );
                assert.equal(thirtySecondBbo.localIvAnchorAvailable, true);

                const overThirtySecondBbo = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', quoteForward, targetRate,
                    'active', profile, 'live', {
                        ...bboTiming,
                        observablePriceAsOf: '2026-07-10T19:00:30.001Z',
                        targetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                    }
                );
                assert.equal(overThirtySecondBbo.localIvAnchorAvailable, false);
                assert.equal(
                    overThirtySecondBbo.localIvAnchorStatus,
                    'option_bbo_stale_or_timestamp_invalid'
                );

                const overThirtySecondUnderlying = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', quoteForward, targetRate,
                    'active', profile, 'live', {
                        ...bboTiming,
                        quoteUnderlyingAsOf: '2026-07-10T19:00:30.001Z',
                        targetAsOf,
                        targetSource: 'near-leg-contract-cutoff',
                    }
                );
                assert.equal(overThirtySecondUnderlying.localIvAnchorAvailable, false);
                assert.equal(
                    overThirtySecondUnderlying.localIvAnchorStatus,
                    'underlying_quote_stale_or_timestamp_invalid'
                );
            },
        },
        {
            name: 'fails closed on a precise live target without a real quote timestamp',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const leg = {
                    type: 'call', pos: 1, strike: 7500,
                    expDate: '2026-07-20', iv: 0.20, cost: 1,
                };
                const targetAsOf = '2026-07-17T19:30:00.000Z';
                const unavailable = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', 7530, 0.04,
                    'active', profile, 'live', { targetAsOf, targetSource: 'explicit' }
                );
                assert.equal(unavailable.exactTimingActive, true);
                assert.equal(unavailable.timingAvailable, false);
                assert.equal(unavailable.timingStatus, 'quote_timestamp_unavailable');
                assert.equal(unavailable.T, null);
                assert.equal(unavailable.simIV, null);

                const explicitlyAllowed = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-10', 7530, 0.04,
                    'active', profile, 'live', {
                        targetAsOf,
                        targetSource: 'explicit',
                        allowLegacyQuoteCutoff: true,
                    }
                );
                assert.equal(explicitlyAllowed.timingAvailable, true);
                assert.ok(Number.isFinite(explicitlyAllowed.T));
            },
        },
        {
            name: 'aligns the post-cutoff live point to each surviving BBO without reviving the near leg',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                ctx.configureSimTimeBasis({ weekendWeight: 1 });
                const globalQuoteAsOf = '2026-07-17T19:30:10.000Z';
                const farBboAsOf = '2026-07-17T19:30:05.000Z';
                const farLeg = {
                    type: 'call', pos: 1, strike: 7530,
                    expDate: '2026-07-20',
                    expiryAsOf: '2026-07-20T20:00:00.000Z',
                    iv: 0.20, cost: 1, currentPrice: 18.25,
                    currentPriceSource: 'live',
                };
                const far = ctx.processLegData(
                    farLeg, '2026-07-17', 0, '2026-07-17', 7530, 0.04,
                    'active', profile, 'live', {
                        quoteAsOf: globalQuoteAsOf,
                        targetAsOf: globalQuoteAsOf,
                        targetSource: 'live-quote-after-near-leg-cutoff',
                        observablePrice: 18.25,
                        observablePriceSource: 'live_midpoint',
                        observablePriceAsOf: farBboAsOf,
                        observablePriceFresh: true,
                        quotePricingInputsAvailable: true,
                        quoteUnderlyingPrice: 7530,
                        quoteUnderlyingAsOf: farBboAsOf,
                        quoteInterestRate: 0.04,
                    }
                );
                assert.equal(far.isExpired, false);
                assert.equal(far.targetAsOf, farBboAsOf);
                assert.equal(far.isObservableQuoteInstant, true);
                assert.equal(
                    ctx.computeSimulatedPrice(
                        far, farLeg, 7530, 0.04, 'active',
                        '2026-07-17', '2026-07-17', 0
                    ),
                    18.25
                );

                const nearBboAsOf = '2026-07-17T19:29:50.000Z';
                const nearLeg = {
                    ...farLeg,
                    strike: 7500,
                    expDate: '2026-07-17',
                    expiryAsOf: '2026-07-17T19:30:00.000Z',
                    currentPrice: 31.50,
                };
                const near = ctx.processLegData(
                    nearLeg, '2026-07-17', 0, '2026-07-17', 7530, 0.04,
                    'active', profile, 'live', {
                        quoteAsOf: globalQuoteAsOf,
                        targetAsOf: globalQuoteAsOf,
                        targetSource: 'live-quote-after-near-leg-cutoff',
                        observablePrice: 31.50,
                        observablePriceSource: 'live_midpoint',
                        observablePriceAsOf: nearBboAsOf,
                        observablePriceFresh: true,
                        quotePricingInputsAvailable: true,
                        quoteUnderlyingPrice: 7530,
                        quoteUnderlyingAsOf: nearBboAsOf,
                        quoteInterestRate: 0.04,
                    }
                );
                assert.equal(near.targetAsOf, globalQuoteAsOf);
                assert.equal(near.isExpired, true);
                assert.equal(near.isObservableQuoteInstant, false);
                assert.equal(
                    ctx.computeSimulatedPrice(
                        near, nearLeg, 7530, 0.04, 'active',
                        '2026-07-17', '2026-07-17', 0
                    ),
                    30
                );
            },
        },
        {
            name: 'distinguishes contract expiry evidence from a product-profile cutoff',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const profileOnly = ctx.resolveExpiryCutoffAsOf(
                    { expDate: '2026-07-17' },
                    profile
                );
                assert.equal(profileOnly.source, 'product-profile');

                const contract = ctx.resolveExpiryCutoffAsOf({
                    expDate: '2026-07-17',
                    expiryAsOf: '2026-07-17T19:30:00Z',
                }, profile);
                assert.equal(contract.source, 'contract');
                assert.equal(contract.cutoffAsOf, '2026-07-17T19:30:00.000Z');

                const invalidEvidence = ctx.resolveExpiryCutoffAsOf({
                    expDate: '2026-07-17',
                    expiryAsOf: 'not-a-timestamp',
                }, profile);
                assert.equal(invalidEvidence.source, 'product-profile');
            },
        },
        {
            name: 'uses intrinsic instead of a stale non-zero mark at the exact expiry cutoff',
            run() {
                const ctx = loadPricingContext();
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const cutoffAsOf = '2026-07-17T20:00:00.000Z';
                const leg = {
                    type: 'call', pos: 1, strike: 7500,
                    expDate: '2026-07-17', expiryAsOf: cutoffAsOf,
                    iv: 0.50, cost: 1, currentPrice: 9.99, currentPriceSource: 'live',
                };
                const processed = ctx.processLegData(
                    leg, '2026-07-17', 0, '2026-07-17', 7530, 0.04,
                    'active', profile, 'live', {
                        quoteAsOf: cutoffAsOf,
                        targetAsOf: cutoffAsOf,
                        targetSource: 'live-quote',
                        observablePrice: 9.99,
                        observablePriceSource: 'live_midpoint',
                        observablePriceAsOf: cutoffAsOf,
                        observablePriceFresh: true,
                        quotePricingInputsAvailable: true,
                        quotePricingInputStatus: 'ok',
                        quoteUnderlyingPrice: 7530,
                        quoteUnderlyingAsOf: cutoffAsOf,
                        quoteInterestRate: 0.04,
                    }
                );
                assert.equal(processed.isExpired, true);
                assert.equal(
                    ctx.computeSimulatedPrice(
                        processed, leg, 7530, 0.04, 'active',
                        '2026-07-17', '2026-07-17', 0
                    ),
                    30
                );
            },
        },
    ],
};
