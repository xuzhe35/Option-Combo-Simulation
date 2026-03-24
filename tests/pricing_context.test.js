const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'pricing_context.js',
    tests: [
        {
            name: 'resolves FOP anchor and per-leg future prices from the futures pool',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingPrice: 72.5,
                    simulatedDate: '2026-03-19',
                    futuresPool: [
                        { id: 'future_jul', contractMonth: '202607', mark: 71.3 },
                        { id: 'future_apr', contractMonth: '202604', mark: 70.1 },
                    ],
                };

                const anchorEntry = pricingContext.resolveAnchorFutureEntry(state);
                assert.equal(anchorEntry.id, 'future_apr');
                assert.equal(pricingContext.resolveAnchorUnderlyingPrice(state), 70.1);
                assert.equal(
                    pricingContext.resolveLegCurrentUnderlyingPrice(state, { underlyingFutureId: 'future_jul' }),
                    71.3
                );
            },
        },
        {
            name: 'maps anchor-price shocks onto bound FOP legs by percentage move',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingPrice: 72.5,
                    simulatedDate: '2026-03-19',
                    futuresPool: [
                        { id: 'future_apr', contractMonth: '202604', mark: 70.0 },
                        { id: 'future_jul', contractMonth: '202607', mark: 76.0 },
                    ],
                };

                const legScenario = pricingContext.resolveLegScenarioUnderlyingPrice(
                    state,
                    { underlyingFutureId: 'future_jul' },
                    71.4
                );

                assert.equal(legScenario.toFixed(4), '77.5200');
            },
        },
        {
            name: 'describes the active FOP anchor future for chart and probability annotations',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingPrice: 72.5,
                    simulatedDate: '2026-03-19',
                    futuresPool: [
                        { id: 'future_jul', contractMonth: '202607', mark: 71.3 },
                        { id: 'future_apr', contractMonth: '202604', mark: 70.1 },
                    ],
                };

                const anchorInfo = pricingContext.resolveAnchorDisplayInfo(state);

                assert.equal(anchorInfo.isFutureAnchor, true);
                assert.equal(anchorInfo.shortLabel, 'CL 2026-04');
                assert.equal(anchorInfo.lineLabel, 'Anchor');
                assert.match(anchorInfo.displayText, /Anchor Future: CL 2026-04 @ \$70\.10/);
                assert.match(anchorInfo.detailText, /same % move/i);
            },
        },
        {
            name: 'falls back to the global underlying price for stock and index families',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;

                assert.equal(
                    pricingContext.resolveAnchorUnderlyingPrice({
                        underlyingSymbol: 'SPY',
                        underlyingPrice: 510.25,
                    }),
                    510.25
                );

                assert.equal(
                    pricingContext.resolveLegScenarioUnderlyingPrice(
                        {
                            underlyingSymbol: 'SPX',
                            underlyingPrice: 5800,
                        },
                        {},
                        5900
                    ),
                    5900
                );
            },
        },
        {
            name: 'uses index forward-rate samples to turn spot into forward for option legs',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 5800,
                    baseDate: '2026-03-17',
                    simulatedDate: '2026-03-17',
                    forwardRateSamples: [
                        {
                            id: 'sample_30d',
                            expDate: '2026-04-16',
                            daysToExpiry: 30,
                            dailyCarry: 0.0003,
                        },
                    ],
                };

                const forwardPrice = pricingContext.resolveLegCurrentUnderlyingPrice(state, {
                    type: 'call',
                    expDate: '2026-04-16',
                });

                assert.equal(forwardPrice.toFixed(4), '5852.4540');
            },
        },
        {
            name: 'prefers an explicit expiry sample over a closer-but-different tenor sample for index legs',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 5800,
                    baseDate: '2026-03-17',
                    simulatedDate: '2026-03-17',
                    forwardRateSamples: [
                        {
                            id: 'sample_nearby',
                            expDate: '2026-04-14',
                            daysToExpiry: 28,
                            dailyCarry: 0.00012,
                        },
                        {
                            id: 'sample_exact',
                            expDate: '2026-06-18',
                            daysToExpiry: 93,
                            dailyCarry: 0.0005,
                        },
                    ],
                };

                const forwardPrice = pricingContext.resolveLegCurrentUnderlyingPrice(state, {
                    type: 'call',
                    expDate: '2026-06-18',
                });

                assert.equal(forwardPrice.toFixed(4), '6076.5167');
            },
        },
        {
            name: 'resolves index leg interest rate from the matched forward-carry sample',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 5800,
                    baseDate: '2026-03-17',
                    simulatedDate: '2026-03-17',
                    interestRate: 0.03,
                    forwardRateSamples: [
                        {
                            id: 'sample_nearby',
                            expDate: '2026-04-14',
                            daysToExpiry: 28,
                            dailyCarry: 0.00012,
                        },
                        {
                            id: 'sample_exact',
                            expDate: '2026-06-18',
                            daysToExpiry: 93,
                            dailyCarry: 0.0005,
                        },
                    ],
                };

                assert.equal(
                    pricingContext.resolveLegInterestRate(state, { type: 'call', expDate: '2026-06-18' }).toFixed(6),
                    (0.0005 * 365).toFixed(6)
                );
                assert.equal(
                    pricingContext.resolveLegInterestRate(state, { type: 'call', expDate: '2026-05-01' }).toFixed(6),
                    (0.00012 * 365).toFixed(6)
                );
                assert.equal(
                    pricingContext.resolveLegInterestRate(state, { type: 'stock' }).toFixed(6),
                    '0.030000'
                );
            },
        },
        {
            name: 'separates historical replay date from the simulation target date',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'historical',
                    baseDate: '2024-01-02',
                    historicalQuoteDate: '2024-03-15',
                    simulatedDate: '2024-06-21',
                };

                assert.equal(pricingContext.resolveQuoteDate(state), '2024-03-15');
                assert.equal(pricingContext.resolveSimulationDate(state), '2024-06-21');

                state.simulatedDate = '2024-03-01';
                assert.equal(pricingContext.resolveSimulationDate(state), '2024-03-15');
            },
        },
    ],
};
