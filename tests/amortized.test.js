const assert = require('node:assert/strict');

const { loadAmortizedContext, loadBrowserScripts } = require('./helpers/load-browser-scripts');

function almostEqual(actual, expected, tolerance = 1e-6) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

module.exports = {
    name: 'amortized.js',
    tests: [
        {
            name: 'assigns short puts into long shares with premium-adjusted basis',
            run() {
                const ctx = loadAmortizedContext();
                const result = ctx.OptionComboAmortized.calculateAmortizedCost(
                    {
                        viewMode: 'amortized',
                        legs: [
                            {
                                type: 'put',
                                pos: -1,
                                strike: 100,
                                expDate: '2026-03-10',
                                iv: 0.2,
                                cost: 2.5,
                                currentPrice: 0,
                                closePrice: null,
                            },
                        ],
                    },
                    95,
                    {
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-14',
                        ivOffset: 0,
                        interestRate: 0.03,
                        underlyingPrice: 95,
                    }
                );

                assert.equal(result.netShares, 100);
                assert.equal(result.assignmentCash, -10000);
                assert.equal(result.initialCost, -250);
                almostEqual(result.basis, 97.5);
            },
        },
        {
            name: 'treats explicit close prices as realized cash flows instead of assignments',
            run() {
                const ctx = loadAmortizedContext();
                const result = ctx.OptionComboAmortized.calculateAmortizedCost(
                    {
                        viewMode: 'amortized',
                        legs: [
                            {
                                type: 'call',
                                pos: -1,
                                strike: 110,
                                expDate: '2026-03-20',
                                iv: 0.25,
                                cost: 1.2,
                                currentPrice: 0,
                                closePrice: 0.5,
                            },
                        ],
                    },
                    120,
                    {
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-14',
                        ivOffset: 0,
                        interestRate: 0.03,
                        underlyingPrice: 120,
                    }
                );

                assert.equal(result.netShares, 0);
                assert.equal(result.assignmentCash, 0);
                assert.equal(result.residualValue, 0);
                assert.equal(result.totalCash, 70);
            },
        },
        {
            name: 'uses each group scenario override in combined amortized calculations',
            run() {
                const ctx = loadAmortizedContext();
                const result = ctx.OptionComboAmortized.calculateCombinedAmortizedCost(
                    [
                        {
                            viewMode: 'amortized',
                            settleUnderlyingPrice: 95,
                            legs: [
                                {
                                    type: 'put',
                                    pos: -1,
                                    strike: 100,
                                    expDate: '2026-03-10',
                                    iv: 0.2,
                                    cost: 2.5,
                                    currentPrice: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                        {
                            viewMode: 'amortized',
                            settleUnderlyingPrice: 105,
                            legs: [
                                {
                                    type: 'put',
                                    pos: -1,
                                    strike: 100,
                                    expDate: '2026-03-10',
                                    iv: 0.2,
                                    cost: 1.0,
                                    currentPrice: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    {
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-14',
                        ivOffset: 0,
                        interestRate: 0.03,
                        underlyingPrice: 95,
                    }
                );

                assert.equal(result.netShares, 100);
                almostEqual(result.basis, 96.5);
                assert.equal(result.totalCash, -9650);
            },
        },
        {
            name: 'reports amortized mode as unsupported for futures-option families',
            run() {
                const ctx = loadAmortizedContext();
                const result = ctx.OptionComboAmortized.calculateAmortizedCost(
                    {
                        viewMode: 'amortized',
                        legs: [
                            {
                                type: 'put',
                                pos: -1,
                                strike: 6000,
                                expDate: '2026-03-10',
                                iv: 0.2,
                                cost: 12.5,
                                currentPrice: 0,
                                closePrice: null,
                            },
                        ],
                    },
                    5900,
                    {
                        underlyingSymbol: 'ES',
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-14',
                        ivOffset: 0,
                        interestRate: 0.03,
                        underlyingPrice: 5900,
                    }
                );

                assert.equal(result.isSupported, false);
                assert.match(result.reason, /Amortized mode/i);
            },
        },
        {
            name: 'does not coerce a missing scenario underlying into an amortized value',
            run() {
                const ctx = loadBrowserScripts([
                    'js/official_exchange_calendars.generated.js',
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                ], {
                    OptionComboPricingContext: {
                        resolveSimulationDate: state => state.simulatedDate,
                        resolveQuoteDate: state => state.baseDate,
                        resolveLegInterestRate: state => state.interestRate,
                        resolveLegScenarioUnderlyingPrice: () => null,
                        resolveAnchorUnderlyingPrice: state => state.underlyingPrice,
                    },
                });
                const result = ctx.OptionComboAmortized.calculateAmortizedCost({
                    viewMode: 'amortized',
                    legs: [{
                        type: 'call',
                        pos: 1,
                        strike: 100,
                        expDate: '2026-04-20',
                        iv: 0.2,
                        cost: 2,
                        closePrice: null,
                    }],
                }, 100, {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 100,
                    baseDate: '2026-03-14',
                    simulatedDate: '2026-03-20',
                    interestRate: 0.03,
                    ivOffset: 0,
                });

                assert.equal(result.isSupported, false);
                assert.match(result.reason, /pricing underlying quote is missing/i);
            },
        },
        {
            // Regression: the live-mark short circuit in computeSimulatedPrice is
            // keyed on the leg anchor set by processLegData. Feeding the scenario
            // price to both made the anchor comparison trivially true, so every
            // settlement price collapsed onto the live mark and the -30%/+30%
            // cash figures came back identical.
            name: 'amortized cash figure tracks the settlement price instead of pinning to the live mark',
            run() {
                const ctx = loadAmortizedContext();
                const buildGroup = () => ({
                    viewMode: 'settlement',
                    legs: [{
                        type: 'call',
                        pos: -1,
                        strike: 100,
                        expDate: '2026-09-18',
                        expiryAsOf: '2026-09-18T20:00:00Z',
                        iv: 0.25,
                        cost: 4.10,
                        currentPrice: 4.10,
                        currentPriceSource: 'live',
                        closePrice: null,
                    }],
                });
                const state = {
                    underlyingSymbol: 'QQQ',
                    underlyingPrice: 100,
                    baseDate: '2026-07-10',
                    simulatedDate: '2026-07-10',
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: '2026-07-10T18:00:00Z',
                    marketDataMode: 'live',
                    projectionConvergenceMode: 'legacy-input-iv',
                    useMarketDiscountCurve: false,
                    interestRate: 0.03,
                    ivOffset: 0,
                };
                const nocfAt = settlePrice => ctx.OptionComboAmortized
                    .calculateAmortizedCost(buildGroup(), settlePrice, state).nocf;

                const down = nocfAt(70);
                const flat = nocfAt(100);
                const up = nocfAt(130);

                assert.notEqual(down, flat, 'a -30% settlement must not equal the flat case');
                assert.notEqual(flat, up, 'a +30% settlement must not equal the flat case');
                assert.notEqual(down, up, 'the -30% and +30% settlements must not be identical');

                // Short call: the deeper it settles in the money, the worse the
                // net cash outcome, so the figures must fall monotonically.
                assert.ok(
                    down > flat && flat > up,
                    `short-call amortized cash must decrease as the settlement price rises, got ${down}/${flat}/${up}`
                );
            },
        },
    ],
};
