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
            name: 'processes stock legs without option multiplier inflation',
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

                assert.equal(processed.type, 'stock');
                assert.equal(processed.posMultiplier, -50);
                assert.equal(processed.effectiveCostPerShare, 12.34);
                assert.equal(processed.costBasis, -617);
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
    ],
};
