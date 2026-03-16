const assert = require('node:assert/strict');

const { loadValuationContext } = require('./helpers/load-browser-scripts');

function almostEqual(actual, expected, tolerance = 1e-6) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

module.exports = {
    name: 'valuation.js',
    tests: [
        {
            name: 'computes hedge live pnl only when current price exists',
            run() {
                const ctx = loadValuationContext();
                const result = ctx.OptionComboValuation.computeHedgeDerivedData({
                    id: 'h1',
                    pos: -100,
                    cost: 20,
                    currentPrice: 18.5,
                });

                assert.equal(result.id, 'h1');
                assert.equal(result.hasLivePnl, true);
                assert.equal(result.pnl, 150);
            },
        },
        {
            name: 'computes group totals and live pnl with trial fallback display state',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingPrice: 102,
                    baseDate: '2026-03-14',
                    simulatedDate: '2026-03-14',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g1',
                    viewMode: 'trial',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'l1',
                            type: 'call',
                            pos: 1,
                            strike: 100,
                            expDate: '2026-04-13',
                            iv: 0.25,
                            cost: 0,
                            currentPrice: 0,
                            closePrice: null,
                        },
                        {
                            id: 'l2',
                            type: 'stock',
                            pos: 10,
                            cost: 95,
                            currentPrice: 101,
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                assert.equal(result.groupCost > 0, true);
                assert.equal(result.groupSimValue > 0, true);
                assert.equal(result.groupHasLiveData, true);
                assert.equal(result.legResults.length, 2);
                assert.equal(result.legResults[0].currentPriceDisplay.value, '');
                assert.equal(result.legResults[0].currentPriceDisplay.title, 'Theoretical model price for today');
                assert.equal(result.legResults[1].currentPriceDisplay.value, '101.00');
            },
        },
        {
            name: 'computes portfolio global totals and combined amortized result',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingPrice: 95,
                    baseDate: '2026-03-01',
                    simulatedDate: '2026-03-14',
                    interestRate: 0.03,
                    ivOffset: 0,
                    hedges: [
                        { id: 'h1', pos: -100, cost: 20, currentPrice: 18.5 },
                    ],
                    groups: [
                        {
                            id: 'g1',
                            viewMode: 'amortized',
                            settleUnderlyingPrice: 95,
                            legs: [
                                {
                                    id: 'l1',
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
                            id: 'g2',
                            viewMode: 'active',
                            settleUnderlyingPrice: null,
                            legs: [
                                {
                                    id: 'l2',
                                    type: 'stock',
                                    pos: 10,
                                    cost: 90,
                                    currentPrice: 96,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computePortfolioDerivedData(globalState);

                assert.equal(result.groupResults.length, 2);
                assert.equal(result.hedgeResults.length, 1);
                assert.equal(result.hasAnyLiveData, true);
                assert.equal(result.hasAnyHedgeLivePnL, true);
                assert.equal(result.combinedAmortizedResult.netShares, 100);
                almostEqual(result.combinedAmortizedResult.basis, 97.5);
                assert.equal(result.globalHedgePnL, 150);
            },
        },
        {
            name: 'excludes unchecked groups from global totals and amortized aggregation',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingPrice: 100,
                    baseDate: '2026-03-01',
                    simulatedDate: '2026-03-01',
                    interestRate: 0.03,
                    ivOffset: 0,
                    hedges: [],
                    groups: [
                        {
                            id: 'g1',
                            includedInGlobal: true,
                            viewMode: 'active',
                            settleUnderlyingPrice: null,
                            legs: [
                                {
                                    id: 'l1',
                                    type: 'stock',
                                    pos: 10,
                                    cost: 90,
                                    currentPrice: 100,
                                    closePrice: null,
                                },
                            ],
                        },
                        {
                            id: 'g2',
                            includedInGlobal: false,
                            viewMode: 'amortized',
                            settleUnderlyingPrice: 95,
                            legs: [
                                {
                                    id: 'l2',
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
                    ],
                };

                const result = ctx.OptionComboValuation.computePortfolioDerivedData(globalState);

                assert.equal(result.groupResults.length, 2);
                assert.equal(result.globalTotalCost, 900);
                assert.equal(result.globalSimulatedValue, 1000);
                assert.equal(result.globalPnL, 100);
                assert.equal(result.amortizedGroups.length, 0);
                assert.equal(result.combinedAmortizedResult, null);
            },
        },
    ],
};
