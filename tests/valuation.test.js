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
            name: 'uses index forward-rate samples when pricing Black-76 index options',
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
                const expectedRate = 0.0003 * 365;
                const expectedPrice = ctx.calculateBlack76Price('call', expectedForward, 5800, 30 / 365, expectedRate, 0.2);

                almostEqual(result.legResults[0].simPricePerShare, expectedPrice, 1e-6);
            },
        },
    ],
};
