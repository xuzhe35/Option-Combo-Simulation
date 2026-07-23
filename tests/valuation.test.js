const assert = require('node:assert/strict');

const { loadBrowserScripts, loadValuationContext } = require('./helpers/load-browser-scripts');

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
            name: 'applies futures multiplier to hedge pnl and delta',
            run() {
                const ctx = loadValuationContext();
                const result = ctx.OptionComboValuation.computeHedgeDerivedData({
                    id: 'es_hedge', secType: 'FUT', pos: 2, cost: 5000,
                    currentPrice: 5001.25, multiplier: 50, deltaPerUnit: 1,
                });
                assert.equal(result.pnl, 125);
                assert.equal(result.hedgeDelta, 100);
            },
        },
        {
            name: 'allows only one side of a same-strike Call and Put pair to deliver',
            run() {
                const ctx = loadValuationContext();
                const buildState = underlyingPrice => ({
                    underlyingSymbol: 'SPY',
                    underlyingPrice,
                    baseDate: '2026-07-23',
                    simulatedDate: '2026-07-24',
                    groups: [{
                        id: 'short-straddle',
                        legs: [
                            { id: 'short-call', type: 'call', pos: -1, strike: 100, expDate: '2026-07-24', closePrice: null },
                            { id: 'short-put', type: 'put', pos: -1, strike: 100, expDate: '2026-07-24', closePrice: null },
                        ],
                    }],
                });

                const belowStrike = ctx.OptionComboValuation.computeProjectedOptionDelivery(buildState(95));
                assert.equal(belowStrike.callContracts, 0);
                assert.equal(belowStrike.putContracts, -1);
                assert.equal(belowStrike.netDeliverables, 100);

                const aboveStrike = ctx.OptionComboValuation.computeProjectedOptionDelivery(buildState(105));
                assert.equal(aboveStrike.callContracts, -1);
                assert.equal(aboveStrike.putContracts, 0);
                assert.equal(aboveStrike.netDeliverables, -100);

                const atStrike = ctx.OptionComboValuation.computeProjectedOptionDelivery(buildState(100));
                assert.equal(atStrike.callContracts, 0);
                assert.equal(atStrike.putContracts, 0);
                assert.equal(atStrike.netDeliverables, 0);
            },
        },
        {
            name: 'projects included-group SPY delivery from current price through the simulation date',
            run() {
                const ctx = loadValuationContext();
                const result = ctx.OptionComboValuation.computeProjectedOptionDelivery({
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 749.15,
                    baseDate: '2026-07-23',
                    simulatedDate: '2026-07-24',
                    groups: [
                        {
                            id: 'included',
                            includedInGlobal: true,
                            legs: [
                                { id: 'short-calls', type: 'call', pos: -20, strike: 747, expDate: '2026-07-24', closePrice: null },
                                { id: 'otm-put', type: 'put', pos: -4, strike: 740, expDate: '2026-07-24', closePrice: null },
                                { id: 'later-call', type: 'call', pos: 3, strike: 700, expDate: '2026-07-25', closePrice: null },
                            ],
                        },
                        {
                            id: 'excluded-does-not-count',
                            includedInGlobal: false,
                            legs: [
                                { id: 'excluded-itm-call', type: 'call', pos: -7, strike: 700, expDate: '2026-07-24', closePrice: null },
                                { id: 'closed-call', type: 'call', pos: 5, strike: 700, expDate: '2026-07-24', closePrice: 50 },
                            ],
                        },
                    ],
                });

                assert.equal(result.available, true);
                assert.equal(result.status, 'ok');
                assert.equal(result.callContracts, -20);
                assert.equal(result.putContracts, 0);
                assert.equal(result.netDeliverables, -2000);
                assert.equal(result.eligibleLegCount, 2);
                assert.equal(result.itmLegCount, 1);
            },
        },
        {
            name: 'uses the opposite delivery sign for in-the-money puts',
            run() {
                const ctx = loadValuationContext();
                const result = ctx.OptionComboValuation.computeProjectedOptionDelivery({
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 95,
                    baseDate: '2026-07-23',
                    simulatedDate: '2026-07-24',
                    groups: [{
                        id: 'puts',
                        legs: [
                            { id: 'long-put', type: 'put', pos: 2, strike: 100, expDate: '2026-07-24', closePrice: null },
                            { id: 'short-put', type: 'put', pos: -1, strike: 105, expDate: '2026-07-24', closePrice: null },
                        ],
                    }],
                });

                assert.equal(result.putContracts, 1);
                assert.equal(result.netDeliverables, -100);
            },
        },
        {
            name: 'computes group net option cash flow from short proceeds minus long costs',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 100,
                    baseDate: '2026-03-14',
                    simulatedDate: '2026-03-14',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };
                const group = {
                    id: 'cash-flow-group',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'short-calls', type: 'call', pos: -2, strike: 105,
                            expDate: '2026-04-13', iv: 0.25, cost: 3.25,
                            currentPrice: 3, closePrice: null,
                        },
                        {
                            id: 'long-put', type: 'put', pos: 1, strike: 95,
                            expDate: '2026-04-13', iv: 0.25, cost: 1.40,
                            currentPrice: 1.25, closePrice: null,
                        },
                        {
                            id: 'stock', type: 'stock', pos: 10, cost: 99,
                            currentPrice: 100, closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                assert.equal(result.groupNetCashFlow, 510);
            },
        },
        {
            name: 'computes all-groups option leg redundancy from open call and put positions',
            run() {
                const ctx = loadValuationContext();
                const result = ctx.OptionComboValuation.computeOptionLegRedundancy([
                    {
                        id: 'excluded_group_still_counts',
                        includedInGlobal: false,
                        legs: [
                            { id: 'put_buy_1', type: 'put', pos: 10 },
                            { id: 'put_buy_2', type: 'put', pos: 20 },
                            { id: 'call_buy', type: 'call', pos: 5 },
                            { id: 'stock_leg', type: 'stock', pos: 100 },
                        ],
                    },
                    {
                        id: 'g2',
                        legs: [
                            { id: 'put_sell', type: 'put', pos: -24 },
                            { id: 'call_sell', type: 'call', pos: -2 },
                            { id: 'closed_put_sell', type: 'put', pos: -100, closePrice: 1.25 },
                        ],
                    },
                ]);

                assert.equal(result.put.buyContracts, 30);
                assert.equal(result.put.sellContracts, 24);
                assert.equal(result.put.netContracts, 6);
                assert.equal(result.put.redundantContracts, 6);
                assert.equal(result.put.direction, 'long');
                assert.equal(result.call.buyContracts, 5);
                assert.equal(result.call.sellContracts, 2);
                assert.equal(result.call.netContracts, 3);
                assert.equal(result.call.redundantContracts, 3);
                assert.equal(result.call.direction, 'long');
            },
        },
        {
            name: 'computes trial-group totals without exposing fake live pnl from zero-cost legs',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'SPY',
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
                assert.equal(result.groupHasLiveData, false);
                assert.equal(result.groupLivePnL, 0);
                assert.equal(result.legResults.length, 2);
                assert.equal(result.legResults[0].currentPriceDisplay.value, '');
                assert.equal(result.legResults[0].currentPriceDisplay.title, 'Theoretical model price for today');
                assert.equal(result.legResults[1].currentPriceDisplay.value, '101.00');
                assert.equal(result.legResults[0].hasLivePnl, false);
                assert.equal(result.legResults[1].hasLivePnl, false);
            },
        },
        {
            name: 'blocks portfolio valuation when exact short-dated contract timing is missing',
            run() {
                const ctx = loadValuationContext();
                const group = {
                    id: 'timing-gate',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [{
                        id: 'short-call', type: 'call', pos: 1, strike: 100,
                        expDate: '2026-07-16', iv: 0.25, cost: 1,
                        currentPrice: 2, currentPriceSource: 'live', closePrice: null,
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
                    projectionConvergenceMode: 'legacy-input-iv',
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
                    hedges: [],
                };

                const blocked = ctx.OptionComboValuation.computeGroupDerivedData(group, state);
                assert.equal(blocked.groupSimulationAvailable, false);
                assert.equal(blocked.groupSimValue, null);
                assert.equal(blocked.legResults[0].simulationAvailable, false);
                assert.equal(
                    blocked.legResults[0].simulationTimingStatus,
                    'exact_contract_timing_missing'
                );

                group.legs[0].expiryAsOf = '2026-07-16T20:00:00Z';
                const complete = ctx.OptionComboValuation.computeGroupDerivedData(group, state);
                assert.equal(complete.groupSimulationAvailable, true);
                assert.ok(Number.isFinite(complete.groupSimValue));
            },
        },
        {
            name: 'computes portfolio global totals and combined amortized result',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'SPY',
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
            name: 'rebuilds portfolio aggregates consistently from cached group and hedge results',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'SPY',
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
                            viewMode: 'active',
                            settleUnderlyingPrice: null,
                            legs: [
                                {
                                    id: 'l1',
                                    type: 'put',
                                    pos: -1,
                                    strike: 100,
                                    expDate: '2026-03-21',
                                    iv: 0.2,
                                    cost: 2.5,
                                    currentPrice: 6.1,
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

                const fullResult = ctx.OptionComboValuation.computePortfolioDerivedData(globalState);
                const rebuiltResult = ctx.OptionComboValuation.buildPortfolioDerivedDataFromResults(
                    globalState,
                    globalState.groups.map(group => ctx.OptionComboValuation.computeGroupDerivedData(group, globalState)),
                    globalState.hedges.map(hedge => ctx.OptionComboValuation.computeHedgeDerivedData(hedge))
                );

                assert.equal(rebuiltResult.groupResults.length, fullResult.groupResults.length);
                assert.equal(rebuiltResult.hedgeResults.length, fullResult.hedgeResults.length);
                almostEqual(rebuiltResult.globalTotalCost, fullResult.globalTotalCost);
                almostEqual(rebuiltResult.allGroupsNetCashFlow, fullResult.allGroupsNetCashFlow);
                almostEqual(rebuiltResult.globalSimulatedValue, fullResult.globalSimulatedValue);
                almostEqual(rebuiltResult.globalPnL, fullResult.globalPnL);
                almostEqual(rebuiltResult.globalLivePnL, fullResult.globalLivePnL);
                almostEqual(rebuiltResult.globalHedgePnL, fullResult.globalHedgePnL);
                almostEqual(rebuiltResult.combinedLivePnL, fullResult.combinedLivePnL);
            },
        },
        {
            name: 'marks simulations unavailable when an option leg has missing live IV',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'SLV',
                    underlyingPrice: 28,
                    baseDate: '2026-03-19',
                    simulatedDate: '2026-04-01',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_missing_iv',
                    viewMode: 'trial',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'l_missing',
                            type: 'call',
                            pos: 1,
                            strike: 61,
                            expDate: '2026-04-17',
                            iv: 0.2,
                            ivSource: 'missing',
                            currentPrice: 1.23,
                            cost: 0,
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                assert.equal(result.groupSimulationAvailable, false);
                assert.equal(result.groupSimValue, null);
                assert.equal(result.groupPnL, null);
                assert.equal(result.legResults[0].simPricePerShare, null);
                assert.equal(result.legResults[0].ivText, 'Sim IV: N/A (TWS unavailable)');
            },
        },
        {
            name: 'freezes expired historical option value at expiry instead of replay-day underlying',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    marketDataMode: 'historical',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 415.19,
                    baseDate: '2023-01-03',
                    simulatedDate: '2023-02-07',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_expired_hist',
                    viewMode: 'trial',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'l_expired_hist',
                            type: 'call',
                            pos: 1,
                            strike: 381,
                            expDate: '2023-01-27',
                            iv: 0.2,
                            ivSource: 'historical',
                            currentPrice: 35.3007,
                            currentPriceSource: 'manual',
                            cost: 0,
                            closePrice: null,
                            historicalExpiryUnderlyingPrice: 402.13,
                            historicalExpiryUnderlyingDate: '2023-01-27',
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                almostEqual(result.legResults[0].simPricePerShare, 21.13);
                almostEqual(result.groupSimValue, 2113);
                almostEqual(result.groupCost, 3530.07);
                almostEqual(result.groupPnL, -1417.07);
            },
        },
        {
            name: 'excludes unchecked groups from global totals and amortized aggregation',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'SPY',
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
                assert.equal(result.allGroupsNetCashFlow, 250);
                assert.equal(result.globalTotalCost, 900);
                assert.equal(result.globalSimulatedValue, 1000);
                assert.equal(result.globalPnL, 100);
                assert.equal(result.amortizedGroups.length, 0);
                assert.equal(result.combinedAmortizedResult, null);
            },
        },
        {
            name: 'scales futures underlying legs using futures multipliers',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    marketDataMode: 'historical',
                    underlyingSymbol: 'ES',
                    underlyingPrice: 6000,
                    baseDate: '2026-03-14',
                    simulatedDate: '2026-03-14',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_es',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'l_future',
                            type: 'stock',
                            pos: 1,
                            cost: 5900,
                            currentPrice: 5980,
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                assert.equal(result.groupCost, 295000);
                assert.equal(result.groupSimValue, 300000);
                assert.equal(result.groupPnL, 5000);
                assert.equal(result.groupLivePnL, 4000);
                assert.equal(result.legResults[0].currentPriceDisplay.title, 'Current Underlying Future Price');
            },
        },
        {
            name: 'uses the bound futures-pool quote for FOP underlying legs',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    marketDataMode: 'historical',
                    underlyingSymbol: 'CL',
                    underlyingPrice: 72.5,
                    baseDate: '2026-03-14',
                    simulatedDate: '2026-03-14',
                    interestRate: 0.03,
                    ivOffset: 0,
                    futuresPool: [
                        {
                            id: 'future_jul',
                            contractMonth: '202607',
                            mark: 74.2,
                        },
                    ],
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_cl_future',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'l_future',
                            type: 'stock',
                            pos: 1,
                            cost: 73,
                            currentPrice: 0,
                            closePrice: null,
                            underlyingFutureId: 'future_jul',
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                assert.equal(result.groupCost, 73000);
                assert.equal(result.groupSimValue, 74200);
                assert.equal(result.groupPnL, 1200);
                assert.equal(result.legResults[0].currentPriceDisplay.placeholder, '74.20');
            },
        },
        {
            name: 'marks an FOP option projection unavailable instead of using the wrong future',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'CL',
                    underlyingContractMonth: '202604',
                    underlyingPrice: 70,
                    baseDate: '2026-03-14',
                    liveQuoteDate: '2026-03-14',
                    simulatedDate: '2026-03-20',
                    interestRate: 0.03,
                    ivOffset: 0,
                    futuresPool: [
                        { id: 'future_apr', contractMonth: '202604', mark: 70 },
                        { id: 'future_jul', contractMonth: '202607', mark: null },
                    ],
                    groups: [],
                    hedges: [],
                };
                const group = {
                    id: 'g_cl_missing_forward',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [{
                        id: 'cl_call',
                        type: 'call',
                        pos: 1,
                        strike: 75,
                        expDate: '2026-04-20',
                        iv: 0.3,
                        ivSource: 'manual',
                        cost: 1.2,
                        currentPrice: 1.1,
                        currentPriceSource: 'live',
                        closePrice: null,
                        underlyingFutureId: 'future_jul',
                    }],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);
                assert.equal(result.legResults[0].simulationAvailable, false);
                assert.equal(result.legResults[0].simPricePerShare, null);
                assert.equal(result.legResults[0].pnl, null);
            },
        },
        {
            name: 'marks an INDEX option projection unavailable instead of assuming zero carry',
            run() {
                const ctx = loadValuationContext();
                const result = ctx.OptionComboValuation.computeGroupDerivedData({
                    id: 'g_spx_missing_parity',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [{
                        id: 'spx_call', type: 'call', pos: 1, strike: 5800,
                        expDate: '2026-04-16', iv: 0.2, cost: 50,
                        currentPrice: 49, currentPriceSource: 'live', closePrice: null,
                    }],
                }, {
                    underlyingSymbol: 'SPX', underlyingPrice: 5800,
                    baseDate: '2026-03-17', simulatedDate: '2026-03-17',
                    interestRate: 0.03, ivOffset: 0, forwardRateSamples: [],
                    groups: [], hedges: [],
                });

                assert.equal(result.legResults[0].simulationAvailable, false);
                assert.equal(result.legResults[0].simPricePerShare, null);
                assert.equal(result.legResults[0].pnl, null);
            },
        },
        {
            name: 'prefers TWS portfolio market price when computing live pnl',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'USO',
                    underlyingPrice: 91.18,
                    baseDate: '2026-03-27',
                    simulatedDate: '2026-03-27',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_uso',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'uso_short_call',
                            type: 'call',
                            pos: -4,
                            strike: 122,
                            expDate: '2026-04-17',
                            iv: 0.3,
                            cost: 11.1165,
                            currentPrice: 12.22,
                            currentPriceSource: 'live',
                            portfolioMarketPrice: 12.3138218,
                            portfolioMarketPriceSource: 'tws_portfolio',
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                almostEqual(result.legResults[0].liveLegPnL, -478.92872);
                almostEqual(result.groupLivePnL, -478.92872);
                assert.equal(result.legResults[0].livePnlSource, 'tws_portfolio');
                assert.equal(result.groupUsesPortfolioLivePnl, true);
            },
        },
        {
            name: 'defaults live pnl pricing to bid ask midpoint before portfolio mark',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/session_logic.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(subId) {
                            if (subId === 'spx_default_midpoint') {
                                return { bid: 533, ask: 535.5, mark: 221.3 };
                            }
                            return null;
                        },
                        getFutureQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return null;
                        },
                    },
                });

                const globalState = {
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 7270,
                    baseDate: '2026-05-01',
                    simulatedDate: '2026-05-01',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_default_midpoint',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'spx_default_midpoint',
                            type: 'call',
                            pos: 5,
                            strike: 6790,
                            expDate: '2026-06-17',
                            iv: 0.2,
                            cost: 213.34,
                            currentPrice: 221.3,
                            currentPriceSource: 'live',
                            portfolioMarketPrice: 221.3,
                            portfolioMarketPriceSource: 'tws_portfolio',
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                almostEqual(result.legResults[0].liveLegPnL, 160455);
                assert.equal(result.legResults[0].livePnlSource, 'live_midpoint');
                assert.equal(result.legResults[0].currentPriceDisplay.value, '534.25');
                assert.equal(result.groupUsesPortfolioLivePnl, false);
            },
        },
        {
            name: 'falls back to portfolio mark when midpoint is unavailable',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/session_logic.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(subId) {
                            if (subId === 'spx_no_midpoint') {
                                return { bid: 0, ask: 0, mark: 221.3 };
                            }
                            return null;
                        },
                        getFutureQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return null;
                        },
                    },
                });

                const globalState = {
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 7270,
                    baseDate: '2026-05-01',
                    simulatedDate: '2026-05-01',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_mark_fallback',
                    viewMode: 'active',
                    livePriceMode: 'midpoint',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'spx_no_midpoint',
                            type: 'call',
                            pos: 5,
                            strike: 6790,
                            expDate: '2026-06-17',
                            iv: 0.2,
                            cost: 213.34,
                            currentPrice: 0,
                            currentPriceSource: 'missing',
                            portfolioMarketPrice: 221.3,
                            portfolioMarketPriceSource: 'tws_portfolio',
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                almostEqual(result.legResults[0].liveLegPnL, 3980);
                assert.equal(result.legResults[0].livePnlSource, 'tws_portfolio');
                assert.equal(result.groupUsesPortfolioLivePnl, true);
            },
        },
        {
            name: 'uses live bid ask midpoint when the group price source is midpoint',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/session_logic.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(subId) {
                            if (subId === 'uso_midpoint') {
                                return { bid: 15.2, ask: 15.7, mark: 15.45 };
                            }
                            return null;
                        },
                        getFutureQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return null;
                        },
                    },
                });

                const globalState = {
                    underlyingSymbol: 'USO',
                    underlyingPrice: 91.18,
                    baseDate: '2026-03-27',
                    simulatedDate: '2026-03-27',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_midpoint',
                    viewMode: 'active',
                    livePriceMode: 'midpoint',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'uso_midpoint',
                            type: 'call',
                            pos: 5,
                            strike: 129,
                            expDate: '2026-06-18',
                            iv: 0.3,
                            cost: 14.9735,
                            currentPrice: 15.45,
                            currentPriceSource: 'live',
                            portfolioMarketPrice: 15.5985,
                            portfolioMarketPriceSource: 'tws_portfolio',
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                almostEqual(result.legResults[0].liveLegPnL, 238.25);
                assert.equal(result.legResults[0].livePnlSource, 'live_midpoint');
                assert.equal(result.legResults[0].currentPriceDisplay.value, '15.45');
                assert.match(result.legResults[0].currentPriceDisplay.title, /midpoint/i);
                assert.equal(result.groupUsesPortfolioLivePnl, false);
            },
        },
        {
            name: 'computes best effort group delta from live option deltas',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(subId) {
                            if (subId === 'long_call') {
                                return { delta: 0.42 };
                            }
                            if (subId === 'short_put') {
                                return { delta: -0.18 };
                            }
                            return null;
                        },
                        getFutureQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return null;
                        },
                    },
                });

                const globalState = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 610,
                    baseDate: '2026-03-27',
                    simulatedDate: '2026-03-27',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_delta',
                    viewMode: 'active',
                    liveData: true,
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'long_call',
                            type: 'call',
                            pos: 2,
                            strike: 620,
                            expDate: '2026-04-17',
                            iv: 0.2,
                            cost: 4.2,
                            currentPrice: 4.4,
                            closePrice: null,
                        },
                        {
                            id: 'short_put',
                            type: 'put',
                            pos: -1,
                            strike: 590,
                            expDate: '2026-04-17',
                            iv: 0.2,
                            cost: 3.3,
                            currentPrice: 3.1,
                            closePrice: null,
                        },
                    ],
                };

                const deltaSummary = ctx.OptionComboValuation.computeGroupDeltaSummary(group, globalState);
                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                assert.equal(deltaSummary.groupDeltaDisplayable, true);
                assert.equal(deltaSummary.groupDeltaAvailable, true);
                almostEqual(deltaSummary.groupDelta, 102);
                assert.equal(result.groupDeltaDisplayable, true);
                assert.equal(result.groupDeltaAvailable, true);
                almostEqual(result.groupDelta, 102);
            },
        },
        {
            name: 'marks group delta unavailable when any live option delta is missing',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(subId) {
                            if (subId === 'delta_ok') {
                                return { delta: 0.25 };
                            }
                            if (subId === 'delta_missing') {
                                return { mark: 1.1 };
                            }
                            return null;
                        },
                        getFutureQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return null;
                        },
                    },
                });

                const globalState = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 610,
                    baseDate: '2026-03-27',
                    simulatedDate: '2026-03-27',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_delta_na',
                    viewMode: 'active',
                    liveData: true,
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'delta_ok',
                            type: 'call',
                            pos: 1,
                            strike: 620,
                            expDate: '2026-04-17',
                            iv: 0.2,
                            cost: 4.2,
                            currentPrice: 4.4,
                            closePrice: null,
                        },
                        {
                            id: 'delta_missing',
                            type: 'put',
                            pos: 1,
                            strike: 590,
                            expDate: '2026-04-17',
                            iv: 0.2,
                            cost: 3.3,
                            currentPrice: 3.1,
                            closePrice: null,
                        },
                    ],
                };

                const deltaSummary = ctx.OptionComboValuation.computeGroupDeltaSummary(group, globalState);
                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                assert.equal(deltaSummary.groupDeltaDisplayable, true);
                assert.equal(deltaSummary.groupDeltaAvailable, false);
                assert.equal(deltaSummary.groupDelta, null);
                assert.equal(deltaSummary.groupDeltaMissingLegCount, 1);
                assert.equal(result.groupDeltaDisplayable, true);
                assert.equal(result.groupDeltaAvailable, false);
                assert.equal(result.groupDelta, null);
                assert.equal(result.groupDeltaMissingLegCount, 1);
            },
        },
        {
            name: 'keeps group delta hidden while greeks are disabled',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote() {
                            return { delta: 0.42 };
                        },
                        getFutureQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return null;
                        },
                    },
                });

                const globalState = {
                    marketDataMode: 'live',
                    greeksEnabled: false,
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 610,
                    baseDate: '2026-03-27',
                    simulatedDate: '2026-03-27',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_delta_disabled',
                    viewMode: 'active',
                    liveData: true,
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'long_call',
                            type: 'call',
                            pos: 1,
                            strike: 620,
                            expDate: '2026-04-17',
                            iv: 0.2,
                            cost: 4.2,
                            currentPrice: 4.4,
                            closePrice: null,
                        },
                    ],
                };

                const deltaSummary = ctx.OptionComboValuation.computeGroupDeltaSummary(group, globalState);
                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                assert.equal(deltaSummary.groupDeltaDisplayable, false);
                assert.equal(deltaSummary.groupDeltaAvailable, false);
                assert.equal(deltaSummary.groupDelta, null);
                assert.equal(result.groupDeltaDisplayable, false);
                assert.equal(result.groupDeltaAvailable, false);
                assert.equal(result.groupDelta, null);
            },
        },
        {
            name: 'computes portfolio net delta from included groups and existing hedges',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(subId) {
                            if (subId === 'included_call') {
                                return { delta: 0.4 };
                            }
                            if (subId === 'excluded_call') {
                                return { delta: 0.9 };
                            }
                            return null;
                        },
                        getFutureQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return null;
                        },
                    },
                });

                const globalState = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 610,
                    baseDate: '2026-03-27',
                    simulatedDate: '2026-03-27',
                    interestRate: 0.03,
                    ivOffset: 0,
                    hedges: [
                        { id: 'h_existing', pos: -25, cost: 600, currentPrice: 610 },
                    ],
                    groups: [
                        {
                            id: 'g_included_delta',
                            includedInGlobal: true,
                            viewMode: 'active',
                            liveData: true,
                            settleUnderlyingPrice: null,
                            legs: [{
                                id: 'included_call',
                                type: 'call',
                                pos: 2,
                                strike: 620,
                                expDate: '2026-04-17',
                                iv: 0.2,
                                cost: 4.2,
                                currentPrice: 4.4,
                                closePrice: null,
                            }],
                        },
                        {
                            id: 'g_excluded_delta',
                            includedInGlobal: false,
                            viewMode: 'active',
                            liveData: true,
                            settleUnderlyingPrice: null,
                            legs: [{
                                id: 'excluded_call',
                                type: 'call',
                                pos: 10,
                                strike: 620,
                                expDate: '2026-04-17',
                                iv: 0.2,
                                cost: 4.2,
                                currentPrice: 4.4,
                                closePrice: null,
                            }],
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computePortfolioDerivedData(globalState);

                assert.equal(result.portfolioDeltaDisplayable, true);
                assert.equal(result.portfolioDeltaAvailable, true);
                assert.equal(result.portfolioDeltaIncludedGroupCount, 1);
                assert.equal(result.portfolioDeltaMissingGroupCount, 0);
                almostEqual(result.portfolioOptionDelta, 80);
                almostEqual(result.portfolioHedgeDelta, -25);
                almostEqual(result.portfolioNetDelta, 55);
                almostEqual(result.hedgeResults[0].hedgeDelta, -25);
            },
        },
        {
            name: 'missing included group delta blocks portfolio net delta',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(subId) {
                            if (subId === 'delta_ok') {
                                return { delta: 0.25 };
                            }
                            if (subId === 'delta_missing') {
                                return { mark: 1.1 };
                            }
                            return null;
                        },
                        getFutureQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return null;
                        },
                    },
                });

                const globalState = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 610,
                    baseDate: '2026-03-27',
                    simulatedDate: '2026-03-27',
                    interestRate: 0.03,
                    ivOffset: 0,
                    hedges: [
                        { id: 'h_existing', pos: -25, cost: 600, currentPrice: 610 },
                    ],
                    groups: [
                        {
                            id: 'g_delta_ok',
                            includedInGlobal: true,
                            viewMode: 'active',
                            liveData: true,
                            settleUnderlyingPrice: null,
                            legs: [{
                                id: 'delta_ok',
                                type: 'call',
                                pos: 1,
                                strike: 620,
                                expDate: '2026-04-17',
                                iv: 0.2,
                                cost: 4.2,
                                currentPrice: 4.4,
                                closePrice: null,
                            }],
                        },
                        {
                            id: 'g_delta_missing',
                            includedInGlobal: true,
                            viewMode: 'active',
                            liveData: true,
                            settleUnderlyingPrice: null,
                            legs: [{
                                id: 'delta_missing',
                                type: 'put',
                                pos: 1,
                                strike: 590,
                                expDate: '2026-04-17',
                                iv: 0.2,
                                cost: 3.3,
                                currentPrice: 3.1,
                                closePrice: null,
                            }],
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computePortfolioDerivedData(globalState);

                assert.equal(result.portfolioDeltaDisplayable, true);
                assert.equal(result.portfolioDeltaAvailable, false);
                assert.equal(result.portfolioDeltaIncludedGroupCount, 2);
                assert.equal(result.portfolioDeltaMissingGroupCount, 1);
                assert.equal(result.portfolioOptionDelta, null);
                almostEqual(result.portfolioHedgeDelta, -25);
                assert.equal(result.portfolioNetDelta, null);
            },
        },
        {
            name: 'keeps assigned short-put premium realized while tracking resulting stock leg',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 660.67,
                    baseDate: '2026-03-23',
                    simulatedDate: '2026-03-23',
                    interestRate: 0.03,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_assigned_put',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'short_put',
                            type: 'put',
                            pos: -4,
                            strike: 685,
                            expDate: '2026-03-27',
                            iv: 0.2,
                            cost: 12.59,
                            currentPrice: 25.12,
                            closePrice: 0,
                            closePriceSource: 'assignment_conversion',
                        },
                        {
                            id: 'assigned_stock',
                            type: 'stock',
                            pos: 400,
                            cost: 685,
                            currentPrice: 660.67,
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);

                almostEqual(result.groupCost, 268964);
                almostEqual(result.groupSimValue, 264268);
                almostEqual(result.groupPnL, -4696);
                almostEqual(result.groupLivePnL, -4696);
                assert.equal(result.legResults[0].isClosed, true);
                almostEqual(result.legResults[0].pnl, 5036);
                almostEqual(result.legResults[1].liveLegPnL, -9732);
            },
        },
        {
            name: 'uses index carry for the forward but the discount rate for Black-76 pricing',
            run() {
                const ctx = loadValuationContext();
                const globalState = {
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 5800,
                    baseDate: '2026-03-17',
                    simulatedDate: '2026-03-17',
                    interestRate: 0.03,
                    ivOffset: 0,
                    forwardRateSamples: [
                        {
                            id: 'sample_30d',
                            daysToExpiry: 30,
                            dailyCarry: 0.0003,
                        },
                    ],
                    groups: [],
                    hedges: [],
                };

                const group = {
                    id: 'g_spx',
                    viewMode: 'active',
                    settleUnderlyingPrice: null,
                    legs: [
                        {
                            id: 'l_call',
                            type: 'call',
                            pos: 1,
                            strike: 5800,
                            expDate: '2026-04-16',
                            iv: 0.2,
                            cost: 0,
                            currentPrice: 0,
                            closePrice: null,
                        },
                    ],
                };

                const result = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);
                const expectedForward = 5800 * Math.exp(0.0003 * 30);
                const expectedRate = 0.03;
                const expectedPrice = ctx.calculateBlack76Price('call', expectedForward, 5800, 30 / 365, expectedRate, 0.2);

                almostEqual(result.legResults[0].simPricePerShare, expectedPrice, 1e-6);
            },
        },
        {
            name: 'keeps realized pnl from partial closes alongside remaining open position pnl',
            run() {
                const ctx = loadValuationContext();
                const result = ctx.OptionComboValuation.computeGroupDerivedData({
                    id: 'partial_stock', viewMode: 'active', settleUnderlyingPrice: null,
                    legs: [{
                        id: 'stock', type: 'stock', pos: 4, cost: 100,
                        currentPrice: 110, currentPriceSource: 'live', closePrice: null,
                        partialCloseRealizedPnl: 200,
                    }],
                }, {
                    underlyingSymbol: 'SPY', underlyingPrice: 110,
                    baseDate: '2026-07-11', simulatedDate: '2026-07-11',
                    interestRate: 0.03, ivOffset: 0, marketDataMode: 'live', greeksEnabled: false,
                });

                assert.equal(result.groupPnL, 240);
                assert.equal(result.groupLivePnL, 240);
            },
        },
        {
            name: 'keeps fallback observable pricing zero-safe without fabricating a midpoint',
            run() {
                let quote = {
                    bid: 0,
                    ask: 0.20,
                    mark: 0.10,
                    markSource: 'bid_ask_mid',
                    bidPresent: true,
                    askPresent: true,
                    bidAskValid: true,
                };
                const ctx = loadBrowserScripts([
                    'js/official_exchange_calendars.generated.js',
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/pricing_core.js',
                    'js/amortized.js',
                    'js/valuation.js',
                ], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote() { return quote; },
                    },
                });
                const leg = {
                    id: 'fallback-zero', type: 'call', currentPrice: 0.04,
                    currentPriceSource: 'live', portfolioMarketPrice: 0,
                };

                const midpoint = ctx.OptionComboValuation.resolveLegSelectedLivePrice(
                    { livePriceMode: 'midpoint' }, leg, null
                );
                assert.equal(midpoint.price, 0.10);
                assert.equal(midpoint.source, 'live_midpoint');

                quote = {
                    bid: null,
                    ask: 0.20,
                    mark: 0.04,
                    markSource: 'model',
                    bidPresent: false,
                    askPresent: true,
                    bidAskValid: false,
                };
                leg.portfolioMarketPrice = null;
                const oneSided = ctx.OptionComboValuation.resolveLegSelectedLivePrice(
                    { livePriceMode: 'midpoint' }, leg, null
                );
                assert.equal(oneSided.price, 0.04);
                assert.equal(oneSided.source, 'live');

                leg.portfolioMarketPrice = 0;
                const portfolio = ctx.OptionComboValuation.resolveLegSelectedLivePrice(
                    { livePriceMode: 'mark' }, leg, null
                );
                assert.equal(portfolio.price, 0);
                assert.equal(portfolio.source, 'tws_portfolio');
            },
        },
        {
            name: 'uses the same observable mark for exact-now payoff and Live PnL',
            run() {
                const quote = {
                    bid: 0,
                    ask: 0.20,
                    mark: 0.10,
                    markSource: 'bid_ask_mid',
                    bidPresent: true,
                    askPresent: true,
                    bidAskValid: true,
                    quoteAsOf: '2026-07-20T19:59:59Z',
                };
                const ctx = loadValuationContext({
                    OptionComboWsLiveQuotes: {
                        getOptionQuote() { return quote; },
                        getUnderlyingQuote() {
                            return {
                                mark: 100,
                                quoteAsOf: '2026-07-20T19:59:59Z',
                            };
                        },
                    },
                });
                const globalState = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 100,
                    baseDate: '2026-07-01',
                    liveQuoteDate: '2026-07-20',
                    liveQuoteAsOf: '2026-07-20T20:00:00Z',
                    simulatedDate: '2026-07-20',
                    marketDataMode: 'live',
                    interestRate: 0.03,
                    useMarketDiscountCurve: false,
                    ivOffset: 0,
                    groups: [],
                    hedges: [],
                };
                const group = {
                    id: 'exact-now',
                    viewMode: 'active',
                    liveData: true,
                    livePriceMode: 'midpoint',
                    legs: [{
                        id: 'zero-bid-call',
                        type: 'call',
                        pos: 1,
                        strike: 110,
                        expDate: '2026-07-24',
                        iv: 0.25,
                        ivSource: 'live',
                        cost: 0.15,
                        currentPrice: 0.04,
                        currentPriceSource: 'live',
                        closePrice: null,
                        portfolioMarketPrice: 0.12,
                        portfolioMarketPriceAsOf: '2026-07-20T19:59:59Z',
                    }],
                };
                globalState.groups = [group];

                const midpoint = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);
                almostEqual(midpoint.legResults[0].simPricePerShare, 0.10);
                almostEqual(midpoint.legResults[0].liveLegPnL, -5);
                almostEqual(midpoint.legResults[0].pnl, -5);
                assert.match(midpoint.legResults[0].dteText, /96\.0 h/);
                assert.match(midpoint.legResults[0].dteTitle, /product-profile fallback/i);
                assert.match(midpoint.legResults[0].ivText, /Local BBO/i);
                assert.match(midpoint.legResults[0].ivTitle, /re-inverted/i);

                group.livePriceMode = 'mark';
                const mark = ctx.OptionComboValuation.computeGroupDerivedData(group, globalState);
                assert.equal(mark.legResults[0].simPricePerShare, null);
                assert.equal(mark.legResults[0].simulationAvailable, false);
                assert.equal(
                    mark.legResults[0].simulationUnavailableReason,
                    'strict_convergence_bbo_unavailable'
                );
                assert.match(mark.legResults[0].ivText, /strict live BBO required/i);
                almostEqual(mark.legResults[0].liveLegPnL, -3);
                assert.equal(mark.legResults[0].pnl, null);
            },
        },
        {
            // Regression: processLegData was handed the scenario price, so the
            // leg anchor always matched the price being evaluated and the live
            // mark short circuit fired for every settlement scenario. The group
            // value froze at the live mark until an ivOffset nudge escaped it.
            name: 'settlement group value tracks the settlement price instead of pinning to the live mark',
            run() {
                const ctx = loadValuationContext();
                const buildGroup = settleUnderlyingPrice => ({
                    id: 'settle-anchor',
                    viewMode: 'settlement',
                    settleUnderlyingPrice,
                    legs: [{
                        id: 'l1',
                        type: 'call',
                        pos: 1,
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
                const buildState = group => ({
                    underlyingSymbol: 'QQQ',
                    underlyingPrice: 100,
                    baseDate: '2026-07-10',
                    simulatedDate: '2026-07-10',
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: '2026-07-10T18:00:00Z',
                    marketDataMode: 'live',
                    projectionConvergenceMode: 'legacy-input-iv',
                    useMarketDiscountCurve: false,
                    simulationTiming: {
                        available: true,
                        status: 'ok',
                        simulationDate: '2026-07-10',
                        targetAsOf: '2026-07-10T18:00:00Z',
                    },
                    interestRate: 0.03,
                    ivOffset: 0,
                    hedges: [],
                    groups: [group],
                });
                const simValueAt = settleUnderlyingPrice => {
                    const group = buildGroup(settleUnderlyingPrice);
                    const result = ctx.OptionComboValuation.computeGroupDerivedData(
                        group,
                        buildState(group)
                    );
                    assert.equal(
                        result.groupSimulationAvailable,
                        true,
                        `simulation must be available at settle price ${settleUnderlyingPrice}`
                    );
                    return result.groupSimValue;
                };

                const down = simValueAt(70);
                const flat = simValueAt(100);
                const up = simValueAt(130);

                assert.notEqual(down, flat, 'a -30% settlement must not equal the flat case');
                assert.notEqual(flat, up, 'a +30% settlement must not equal the flat case');
                assert.notEqual(down, up, 'the -30% and +30% settlements must not be identical');

                // Long 100-strike call held to a 2026-09-18 expiry: worth almost
                // nothing 30% below the strike and roughly its intrinsic 30 a
                // share (3000 on one contract) 30% above it.
                assert.ok(down < 5, `expected the -30% settlement to be near worthless, got ${down}`);
                assert.ok(
                    up > 2800 && up < 3400,
                    `expected the +30% settlement to be near intrinsic (~3000), got ${up}`
                );
                assert.ok(down < flat && flat < up, 'long-call value must rise with the settlement price');
            },
        },
    ],
};
