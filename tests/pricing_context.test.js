const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function almostEqual(actual, expected, tolerance = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

function loadPricingContext(overrides = {}) {
    return loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
    ], overrides);
}

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
                    marketDataMode: 'historical',
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
                    marketDataMode: 'historical',
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
            name: 'fails closed when an explicitly bound FOP future has no quote',
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
                    underlyingContractMonth: '202604',
                    underlyingPrice: 70,
                    liveQuoteDate: '2026-03-19',
                    simulatedDate: '2026-03-19',
                    futuresPool: [
                        { id: 'future_apr', contractMonth: '202604', mark: 70 },
                        { id: 'future_jul', contractMonth: '202607', mark: null },
                    ],
                };
                const leg = { type: 'call', underlyingFutureId: 'future_jul' };
                const observation = pricingContext.resolveLegForwardObservation(state, leg);

                assert.equal(observation.usable, false);
                assert.equal(observation.source, 'bound_futures_quote_unavailable');
                assert.equal(observation.forwardPrice, null);
                assert.equal(
                    pricingContext.resolveLegCurrentUnderlyingPrice(state, leg),
                    null
                );
                assert.equal(
                    pricingContext.resolveLegScenarioUnderlyingPrice(state, leg, 71),
                    null
                );
            },
        },
        {
            name: 'requires a current verified Futures Pool generation and fresh qualified identity for live FOP pricing',
            run() {
                const ctx = loadPricingContext();
                const pricingContext = ctx.OptionComboPricingContext;
                const entry = {
                    id: 'future_sep',
                    contractMonth: '202609',
                    bid: 6299,
                    ask: 6301,
                    mark: 6300,
                    quoteAsOf: '2026-07-17T20:00:00Z',
                    conId: 60901,
                    secType: 'FUT',
                    symbol: 'ES',
                    localSymbol: 'ESU6',
                    exchange: 'CME',
                    currency: 'USD',
                    multiplier: '50.0',
                    qualifiedContractMonth: '202609',
                    requestIdentityVerified: true,
                    liveQuoteIdentityStatus: 'verified',
                    liveQuoteRequestGeneration: 7,
                    liveQuoteRequestId: 'frqg7x1',
                    requestedSecType: 'FUT',
                    requestedSymbol: 'ES',
                    requestedExchange: 'CME',
                    requestedCurrency: 'USD',
                    requestedMultiplier: '50',
                    requestedContractMonth: '202609',
                };
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    underlyingPrice: 6300,
                    liveQuoteAsOf: '2026-07-17T20:00:30Z',
                    liveFuturesRequestGeneration: 7,
                    futuresPool: [entry],
                };
                const leg = { type: 'call', underlyingFutureId: 'future_sep' };

                const accepted = pricingContext.resolveLegForwardObservation(state, leg);
                assert.equal(accepted.usable, true);
                assert.equal(accepted.forwardPrice, 6300);
                assert.equal(accepted.quality.requestGeneration, 7);

                state.liveFuturesRequestGeneration = 8;
                const wrongGeneration = pricingContext.resolveLegForwardObservation(state, leg);
                assert.equal(wrongGeneration.usable, false);
                assert.ok(wrongGeneration.quality.flags.includes('future_request_generation_mismatch'));

                state.liveFuturesRequestGeneration = 7;
                state.liveQuoteAsOf = '2026-07-17T20:02:01Z';
                const stale = pricingContext.resolveLegForwardObservation(state, leg);
                assert.equal(stale.usable, false);
                assert.ok(stale.quality.flags.includes('future_quote_stale'));

                state.liveQuoteAsOf = '2026-07-17T20:00:30Z';
                entry.qualifiedContractMonth = '202612';
                const wrongMonth = pricingContext.resolveLegForwardObservation(state, leg);
                assert.equal(wrongMonth.usable, false);
                assert.ok(wrongMonth.quality.flags.includes('future_contract_month_mismatch'));
            },
        },
        {
            name: 'uses a sole futures-pool entry only as an explicit legacy unbound fallback',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const observation = pricingContext.resolveLegForwardObservation({
                    marketDataMode: 'historical',
                    underlyingSymbol: 'GC',
                    underlyingPrice: 2400,
                    liveQuoteDate: '2026-03-19',
                    simulatedDate: '2026-03-19',
                    futuresPool: [{ id: 'gc_jun', contractMonth: '202606', mark: 2425 }],
                }, { type: 'call', underlyingFutureId: '' });

                assert.equal(observation.forwardPrice, 2425);
                assert.equal(observation.source, 'single_pool_legacy_fallback');
                assert.equal(observation.quality.status, 'degraded');
                assert.deepEqual(
                    Array.from(observation.quality.flags),
                    ['legacy_leg_missing_binding_single_pool_entry_used']
                );
            },
        },
        {
            name: 'builds ES net-carry diagnostics from SPX and actual futures quotes only',
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
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-19',
                    liveQuoteAsOf: '2026-07-19T14:00:00Z',
                    simulatedDate: '2026-07-19',
                    interestRate: 0.99,
                    futuresPool: [
                        {
                            id: 'es_sep', contractMonth: '202609', mark: 6300,
                            lastTradeDate: '20260918', quoteAsOf: '2026-07-19T14:00:00Z',
                        },
                        {
                            id: 'es_dec', contractMonth: '202612', mark: 6350,
                            lastTradeDate: '20261218', quoteAsOf: '2026-07-19T14:00:00Z',
                        },
                    ],
                };
                const snapshot = pricingContext.buildForwardCarrySnapshot(state, {
                    referenceQuote: {
                        secType: 'IND', symbol: 'SPX', currency: 'USD', mark: 6280,
                        quoteAsOf: '2026-07-19T14:00:00Z',
                    },
                });

                assert.equal(snapshot.kind, 'forward_carry_snapshot');
                assert.equal(snapshot.currency, 'USD');
                assert.equal(snapshot.family, 'ES');
                assert.equal(snapshot.carrySemantics, 'equity-index-net-carry');
                assert.equal(snapshot.discountCurveIndependent, true);
                assert.equal(snapshot.reference.symbol, 'SPX');
                assert.equal(snapshot.points.length, 2);
                assert.equal(snapshot.points[0].forwardPrice, 6300);
                assert.equal(snapshot.points[0].futuresPoolEntryId, 'es_sep');
                assert.equal(snapshot.points[0].contractMonth, '202609');
                assert.equal(snapshot.points[0].expiry, '2026-09-18');
                const expected = Math.log(6300 / 6280) / (61 / 365);
                assert.ok(Math.abs(snapshot.points[0].carryRate - expected) < 1e-12);
                assert.notEqual(snapshot.points[0].carryRate, state.interestRate);
                assert.match(snapshot.points[0].carryRateSource, /SPX/);
                assert.equal(snapshot.points[0].carryQuality.usable, true);
                const expectedRoll = Math.log(6350 / 6300) / (91 / 365);
                assert.equal(snapshot.points[1].intervalStartContractMonth, '202609');
                assert.equal(snapshot.points[1].intervalDays, 91);
                assert.ok(Math.abs(snapshot.points[1].annualizedRollSlope - expectedRoll) < 1e-12);
            },
        },
        {
            name: 'keeps outright futures but suppresses annualized carry for stale or skewed reference quotes',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const snapshot = ctx.OptionComboPricingContext.buildForwardCarrySnapshot({
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-19',
                    liveQuoteAsOf: '2026-07-19T14:05:00Z',
                    simulatedDate: '2026-07-19',
                    futuresPool: [
                        {
                            id: 'es_sep', contractMonth: '202609', mark: 6300,
                            lastTradeDate: '20260918', quoteAsOf: '2026-07-19T14:05:00Z',
                        },
                        {
                            id: 'es_dec', contractMonth: '202612', mark: 6350,
                            lastTradeDate: '20261218', quoteAsOf: '2026-07-19T14:00:00Z',
                        },
                    ],
                }, {
                    referenceQuote: {
                        secType: 'IND', symbol: 'SPX', currency: 'USD', mark: 6280,
                        quoteAsOf: '2026-07-19T14:00:00Z',
                    },
                });

                assert.equal(snapshot.points[0].forwardPrice, 6300);
                assert.equal(snapshot.points[0].carryRate, null);
                assert.equal(snapshot.points[0].carryQuality.usable, false);
                assert.ok(snapshot.points[0].carryQuality.flags.includes('future_reference_quote_skew_exceeded'));
                assert.ok(snapshot.points[0].carryQuality.flags.includes('carry_reference_quote_stale'));
                assert.equal(snapshot.points[1].annualizedRollSlope, null);
                assert.equal(snapshot.points[1].intervalQuality.usable, false);
                assert.ok(snapshot.points[1].intervalQuality.flags.includes('futures_interval_quote_skew_exceeded'));
                assert.ok(snapshot.points[1].intervalQuality.flags.includes('interval_end_quote_stale'));
                assert.equal(snapshot.quality.status, 'degraded');

                const monthOnly = ctx.OptionComboPricingContext.buildForwardCarrySnapshot({
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-19',
                    liveQuoteAsOf: '2026-07-19T14:05:00Z',
                    simulatedDate: '2026-07-19',
                    futuresPool: [
                        {
                            id: 'es_month_only', contractMonth: '202609', mark: 6300,
                            quoteAsOf: '2026-07-19T14:05:00Z',
                        },
                        {
                            id: 'es_month_only_2', contractMonth: '202612', mark: 6350,
                            quoteAsOf: '2026-07-19T14:05:00Z',
                        },
                    ],
                }, {
                    referenceQuote: {
                        secType: 'IND', symbol: 'SPX', currency: 'USD', mark: 6280,
                        quoteAsOf: '2026-07-19T14:05:00Z',
                    },
                });
                assert.equal(monthOnly.points[0].expiry, '');
                assert.equal(monthOnly.points[0].carryRate, null);
                assert.ok(monthOnly.points[0].carryQuality.flags.includes('exact_futures_expiry_unavailable'));
                assert.equal(monthOnly.points[1].intervalDays, null);
                assert.equal(monthOnly.points[1].intervalLogSlope, null);
                assert.equal(monthOnly.points[1].annualizedRollSlope, null);
                assert.ok(monthOnly.points[1].intervalQuality.flags.includes('exact_interval_expiries_unavailable'));
            },
        },
        {
            name: 'keeps commodity and metal futures curves as outright market prices without r-implied carry',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                for (const [symbol, semantics] of [
                    ['CL', 'commodity-futures-curve'],
                    ['GC', 'metal-futures-curve'],
                    ['SI', 'metal-futures-curve'],
                ]) {
                    const snapshot = pricingContext.buildForwardCarrySnapshot({
                        underlyingSymbol: symbol,
                        liveQuoteDate: '2026-07-19',
                        simulatedDate: '2026-07-19',
                        interestRate: 0.75,
                        futuresPool: [{
                            id: `${symbol}_front`,
                            contractMonth: '202609',
                            mark: symbol === 'CL' ? 72 : 2500,
                            lastTradeDate: '20260918',
                            quoteAsOf: '2026-07-19T14:00:00Z',
                        }],
                    });
                    assert.equal(snapshot.carrySemantics, semantics);
                    assert.equal(snapshot.reference, null);
                    assert.equal(snapshot.points[0].carryRate, null);
                    assert.equal(snapshot.points[0].source, 'exchange_futures_quote');
                    assert.equal(snapshot.discountCurveIndependent, true);
                }
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
            name: 'uses spot for stock and index underlying legs but not index option carry',
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
                        { type: 'stock' },
                        5900
                    ),
                    5900
                );

                const missingCarry = pricingContext.resolveLegForwardObservation({
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 5800,
                    baseDate: '2026-03-17',
                    simulatedDate: '2026-03-17',
                    forwardRateSamples: [],
                }, {
                    type: 'call',
                    expDate: '2026-04-17',
                });
                assert.equal(missingCarry.usable, false);
                assert.equal(missingCarry.forwardPrice, null);
                assert.equal(missingCarry.source, 'index_parity_carry_unavailable');

                const expirySpot = pricingContext.resolveLegScenarioUnderlyingPrice(
                    {
                        underlyingSymbol: 'SPX',
                        underlyingPrice: 5800,
                        baseDate: '2026-03-17',
                        simulatedDate: '2026-03-17',
                        forwardRateSamples: [],
                    },
                    {
                        type: 'call',
                        expDate: '2026-03-17',
                        tradingClass: 'SPXW',
                    },
                    5900
                );
                assert.equal(expirySpot, 5900);
                const expiredObservation = pricingContext.resolveLegForwardObservation(
                    {
                        underlyingSymbol: 'SPX',
                        underlyingPrice: 5800,
                        baseDate: '2026-03-17',
                        simulatedDate: '2026-03-17',
                        forwardRateSamples: [],
                    },
                    {
                        type: 'call',
                        expDate: '2026-03-17',
                        tradingClass: 'SPXW',
                    },
                    5900
                );
                assert.equal(expiredObservation.usable, true);
                assert.equal(expiredObservation.forwardPrice, 5900);
                assert.equal(expiredObservation.source, 'index_expired_intrinsic_spot');
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

                assert.equal(forwardPrice.toFixed(4), (5800 * Math.exp(0.0003 * 30)).toFixed(4));
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

                assert.equal(forwardPrice.toFixed(4), (5800 * Math.exp(0.0005 * 93)).toFixed(4));
            },
        },
        {
            name: 'keeps index discount rates separate from matched forward-carry samples',
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
                    '0.030000'
                );
                assert.equal(
                    pricingContext.resolveLegInterestRate(state, { type: 'call', expDate: '2026-05-01' }).toFixed(6),
                    '0.030000'
                );
                assert.equal(
                    pricingContext.resolveLegInterestRate(state, { type: 'stock' }).toFixed(6),
                    '0.030000'
                );
            },
        },
        {
            name: 'resolves SPX local-IV inputs on the quote horizon instead of the future target horizon',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;
                const quoteAsOf = '2026-07-10T19:00:00.000Z';
                const carryRate = 0.12;
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 6300,
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: quoteAsOf,
                    simulatedDate: '2026-07-17',
                    interestRate: 0.04,
                    useMarketDiscountCurve: false,
                    forwardRateSamples: [{
                        id: 'spx_10d',
                        expDate: '2026-07-20',
                        daysToExpiry: 10,
                        carryRate,
                        quoteAsOf,
                        quality: { status: 'good', flags: [] },
                    }],
                };
                const leg = { type: 'call', expDate: '2026-07-20' };
                const targetForward = pricingContext.resolveLegCurrentUnderlyingPrice(
                    state, leg, state.underlyingPrice
                );
                const quoteInputs = pricingContext.resolveLegQuotePricingInputs(
                    state,
                    leg,
                    { underlyingPrice: state.underlyingPrice, interestRate: state.interestRate }
                );

                assert.equal(quoteInputs.available, true);
                assert.equal(quoteInputs.underlyingSource, 'option_put_call_parity_carry');
                almostEqual(
                    quoteInputs.underlyingPrice,
                    // Quote 19:00Z -> SPX cutoff 20:00Z ten calendar days
                    // later. Preserve that final hour instead of truncating it.
                    6300 * Math.exp(carryRate * ((10 + 1 / 24) / 365)),
                    1e-9
                );
                almostEqual(
                    targetForward,
                    6300 * Math.exp(carryRate * (3 / 365)),
                    1e-9
                );
                assert.ok(quoteInputs.underlyingPrice > targetForward);
                assert.equal(quoteInputs.interestRate, 0.04);
                assert.equal(quoteInputs.underlyingAsOf, quoteAsOf);
            },
        },
        {
            name: 'keeps the real cash-underlying timestamp for local-IV atomicity',
            run() {
                let underlyingQuote = {
                    mark: 600,
                    quoteAsOf: '2026-07-17T19:57:59Z',
                };
                const ctx = loadPricingContext({
                    OptionComboWsLiveQuotes: {
                        getUnderlyingQuote() {
                            return { ...underlyingQuote };
                        },
                    },
                });
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 600,
                    liveQuoteDate: '2026-07-17',
                    liveQuoteAsOf: '2026-07-17T20:00:00Z',
                    simulatedDate: '2026-07-17',
                    interestRate: 0.04,
                    useMarketDiscountCurve: false,
                };
                const leg = { type: 'call', strike: 600, expDate: '2026-07-24' };

                const stale = pricingContext.resolveLegQuotePricingInputs(
                    state,
                    leg,
                    { underlyingPrice: 600, interestRate: 0.04 }
                );
                assert.equal(stale.available, false);
                assert.equal(stale.status, 'quote_underlying_stale');

                underlyingQuote = {
                    mark: 600.25,
                    quoteAsOf: '2026-07-17T19:59:50Z',
                };
                const fresh = pricingContext.resolveLegQuotePricingInputs(
                    state,
                    leg,
                    { underlyingPrice: 600, interestRate: 0.04 }
                );
                assert.equal(fresh.available, true);
                assert.equal(fresh.underlyingPrice, 600.25);
                assert.equal(fresh.underlyingAsOf, '2026-07-17T19:59:50.000Z');
            },
        },
        {
            name: 'uses the shared curve at the scenario-date remaining tenor',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const api = ctx.OptionComboMarketCurves;
                const pricingContext = ctx.OptionComboPricingContext;
                const rate = 0.04;
                const curve = api.createDiscountCurveFromSnapshot({
                    schemaVersion: 2,
                    kind: 'hybrid_discount_curve',
                    snapshotId: 'usd-reference:scenario-test',
                    curveAsOf: '2026-07-10',
                    effectiveDate: '2026-07-09',
                    availableAsOf: '2026-07-10T12:00:00Z',
                    source: 'nyfed:sofr+treasury:test',
                    curveSemantics: { discountingIsApproximate: true },
                    points: [
                        {
                            tenorDays: 1,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate / 365),
                            proxy: true,
                        },
                        {
                            tenorDays: 30,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate * 30 / 365),
                            proxy: true,
                        },
                    ],
                });
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-10',
                    simulatedDate: '2026-07-15',
                    interestRate: 0.03,
                    useMarketDiscountCurve: true,
                    discountCurve: curve,
                };
                const observation = pricingContext.resolveLegDiscountObservation(
                    state,
                    { type: 'call', expDate: '2026-07-20' },
                    state.interestRate
                );

                assert.equal(observation.tenorDays, 5);
                assert.equal(observation.fallbackUsed, false);
                assert.equal(observation.metadata.snapshotId, 'usd-reference:scenario-test');
                assert.ok(Math.abs(
                    observation.discountFactor - Math.exp(-rate * 5 / 365)
                ) < 1e-12);
            },
        },
        {
            name: 'keeps a weekend-stamped curve for the Friday live quote date',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const rate = 0.04;
                // Sunday updater run: curveAsOf postdates the Friday session
                // the economic data belongs to (effectiveDate).
                const curve = ctx.OptionComboMarketCurves.createDiscountCurveFromSnapshot({
                    schemaVersion: 2,
                    kind: 'hybrid_discount_curve',
                    snapshotId: 'usd-reference:weekend-test',
                    curveAsOf: '2026-07-19',
                    effectiveDate: '2026-07-16',
                    availableAsOf: '2026-07-19T12:00:00Z',
                    source: 'nyfed:sofr+treasury:test',
                    curveSemantics: { discountingIsApproximate: true },
                    points: [
                        {
                            tenorDays: 1,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate / 365),
                            proxy: true,
                        },
                        {
                            tenorDays: 365,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate),
                            proxy: true,
                        },
                    ],
                });
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-17',
                    simulatedDate: '2026-07-17',
                    interestRate: 0.03,
                    useMarketDiscountCurve: true,
                    discountCurve: curve,
                };
                const observation = ctx.OptionComboPricingContext.resolveLegDiscountObservation(
                    state,
                    { type: 'call', expDate: '2026-07-27' },
                    state.interestRate
                );

                assert.equal(observation.fallbackUsed, false);
                assert.equal(observation.metadata.snapshotId, 'usd-reference:weekend-test');
                assert.equal(observation.tenorDays, 10);
            },
        },
        {
            name: 'still rejects a curve whose economic data postdates the quote date',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const rate = 0.04;
                const curve = ctx.OptionComboMarketCurves.createDiscountCurveFromSnapshot({
                    schemaVersion: 2,
                    kind: 'hybrid_discount_curve',
                    snapshotId: 'usd-reference:lookahead-test',
                    curveAsOf: '2026-07-19',
                    effectiveDate: '2026-07-16',
                    availableAsOf: '2026-07-19T12:00:00Z',
                    source: 'nyfed:sofr+treasury:test',
                    curveSemantics: { discountingIsApproximate: true },
                    points: [
                        {
                            tenorDays: 1,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate / 365),
                            proxy: true,
                        },
                        {
                            tenorDays: 365,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate),
                            proxy: true,
                        },
                    ],
                });
                const observation = ctx.OptionComboPricingContext.resolveLegDiscountObservation({
                    marketDataMode: 'historical',
                    underlyingSymbol: 'ES',
                    historicalQuoteDate: '2026-07-10',
                    simulatedDate: '2026-07-10',
                    interestRate: 0.03,
                    useMarketDiscountCurve: true,
                    discountCurve: curve,
                }, { type: 'call', expDate: '2026-08-18' }, 0.03);

                assert.equal(observation.fallbackUsed, true);
                assert.equal(observation.reason, 'market_curve_stale');
                assert.equal(observation.zeroRate, 0.03);
            },
        },
        {
            name: 'summarizes per-leg discount fallback reasons for the status line',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const rate = 0.04;
                const curve = ctx.OptionComboMarketCurves.createDiscountCurveFromSnapshot({
                    schemaVersion: 2,
                    kind: 'hybrid_discount_curve',
                    snapshotId: 'usd-reference:summary-test',
                    curveAsOf: '2026-07-17',
                    effectiveDate: '2026-07-16',
                    availableAsOf: '2026-07-17T21:00:00Z',
                    source: 'nyfed:sofr+treasury:test',
                    curveSemantics: { discountingIsApproximate: true },
                    points: [
                        {
                            tenorDays: 1,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate / 365),
                            proxy: true,
                        },
                        {
                            tenorDays: 365,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate),
                            proxy: true,
                        },
                    ],
                });
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    // 30 calendar days after the data date: past the live
                    // staleness bound, so every open leg silently falls back.
                    liveQuoteDate: '2026-08-15',
                    interestRate: 0.03,
                    useMarketDiscountCurve: true,
                    discountCurve: curve,
                    groups: [
                        {
                            legs: [
                                { type: 'call', expDate: '2026-09-18', pos: 1 },
                                { type: 'put', expDate: '2026-09-18', pos: -1, closePrice: 1.25 },
                            ],
                        },
                        { legs: [{ type: 'put', expDate: '2026-10-16', pos: 1 }] },
                    ],
                };

                const stale = ctx.OptionComboPricingContext.summarizeDiscountFallback(
                    state,
                    state.interestRate
                );
                assert.equal(stale.legCount, 2);
                assert.equal(stale.fallbackCount, 2);
                assert.equal(stale.reasons.length, 1);
                assert.equal(stale.reasons[0].reason, 'market_curve_stale');
                assert.equal(stale.reasons[0].count, 2);

                state.liveQuoteDate = '2026-07-17';
                const healthy = ctx.OptionComboPricingContext.summarizeDiscountFallback(
                    state,
                    state.interestRate
                );
                assert.equal(healthy.legCount, 2);
                assert.equal(healthy.fallbackCount, 0);
                assert.equal(healthy.reasons.length, 0);
            },
        },
        {
            name: 'rejects a discount curve whose currency does not match the product',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const curve = ctx.OptionComboMarketCurves.createDiscountCurve({
                    id: 'eur-test',
                    currency: 'EUR',
                    asOf: '2026-07-19',
                    maxExtrapolationDays: 31,
                    points: [{ tenorDays: 30, zeroRate: 0.02 }],
                });
                const observation = ctx.OptionComboPricingContext.resolveLegDiscountObservation({
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-19',
                    simulatedDate: '2026-07-19',
                    useMarketDiscountCurve: true,
                    discountCurve: curve,
                    interestRate: 0.04,
                }, { type: 'call', expDate: '2026-08-18' });

                assert.equal(observation.fallbackUsed, true);
                assert.equal(observation.reason, 'discount_curve_currency_mismatch');
                assert.equal(observation.zeroRate, 0.04);
            },
        },
        {
            name: 'derives live quote dates from exchange time instead of the browser date',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                ]);
                const pricingContext = ctx.OptionComboPricingContext;

                // Shanghai is already Saturday, but the New York quote still
                // belongs to Friday's SPY session.
                assert.equal(
                    pricingContext.resolveLiveQuoteDate(
                        { marketDataMode: 'live', underlyingSymbol: 'SPY' },
                        '2026-07-18T00:15:00Z'
                    ),
                    '2026-07-17'
                );
                // CME-family sessions opened after 17:00 CT use the following
                // trade date.
                assert.equal(
                    pricingContext.resolveLiveQuoteDate(
                        { marketDataMode: 'live', underlyingSymbol: 'CL' },
                        '2026-07-19T23:30:00Z'
                    ),
                    '2026-07-20'
                );
            },
        },
        {
            name: 'uses the rolling live quote date without changing the entry date',
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
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    baseDate: '2026-07-01',
                    liveQuoteDate: '2026-07-10',
                    simulatedDate: '2026-07-15',
                };

                assert.equal(pricingContext.resolveQuoteDate(state), '2026-07-10');
                assert.equal(pricingContext.resolveSimulationDate(state), '2026-07-15');
                assert.equal(state.baseDate, '2026-07-01');

                state.simulatedDate = '2026-07-05';
                assert.equal(pricingContext.resolveSimulationDate(state), '2026-07-10');
                assert.equal(state.baseDate, '2026-07-01');
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
                    liveQuoteDate: '2099-12-31',
                    simulatedDate: '2024-06-21',
                };

                assert.equal(pricingContext.resolveQuoteDate(state), '2024-03-15');
                assert.equal(pricingContext.resolveSimulationDate(state), '2024-06-21');

                state.simulatedDate = '2024-03-01';
                assert.equal(pricingContext.resolveSimulationDate(state), '2024-03-15');
            },
        },
        {
            name: 'uses the unique near-leg cutoff as one portfolio-global target instant',
            run() {
                const ctx = loadPricingContext();
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: '2026-07-10T19:00:00Z',
                    simulatedDate: '2026-07-17',
                    groups: [{
                        legs: [
                            { id: 'near-call', type: 'call', pos: -1, expDate: '2026-07-17' },
                            { id: 'near-put', type: 'put', pos: -1, expDate: '2026-07-17' },
                            { id: 'far-call', type: 'call', pos: 1, expDate: '2026-07-20' },
                        ],
                    }],
                };

                const timing = pricingContext.resolveSimulationTiming(state);
                assert.equal(timing.available, true);
                assert.equal(timing.targetAsOf, '2026-07-17T20:00:00.000Z');
                assert.equal(timing.source, 'near-leg-profile-cutoff');

                state.groups[0].legs[1].expiryAsOf = '2026-07-17T19:30:00Z';
                const ambiguous = pricingContext.resolveSimulationTiming(state);
                assert.equal(ambiguous.available, false);
                assert.equal(ambiguous.status, 'ambiguous_near_leg_cutoff');
            },
        },
        {
            name: 'requires contract-source timing for target-date and surviving FOP legs',
            run() {
                const ctx = loadPricingContext();
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    requireExactContractTiming: true,
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: '2026-07-10T19:00:00Z',
                    simulatedDate: '2026-07-17',
                    groups: [{ legs: [
                        { id: 'near', type: 'call', pos: -1, expDate: '2026-07-17' },
                        {
                            id: 'far', type: 'call', pos: 1, expDate: '2026-07-20',
                            expiryAsOf: '2026-07-20T20:00:00Z',
                        },
                    ] }],
                };

                const missingNear = pricingContext.resolveSimulationTiming(state);
                assert.equal(missingNear.available, false);
                assert.equal(missingNear.status, 'exact_contract_timing_missing');
                assert.deepEqual(Array.from(missingNear.missingContractTimingLegIds), ['near']);
                assert.deepEqual(
                    Array.from(missingNear.missingContractTimingLegs[0].reasons),
                    ['target_expiry_contract_timing_missing']
                );

                state.groups[0].legs[0].expiryAsOf = '2026-07-17T19:30:00Z';
                delete state.groups[0].legs[1].expiryAsOf;
                const missingFar = pricingContext.resolveSimulationTiming(state);
                assert.equal(missingFar.available, false);
                assert.deepEqual(Array.from(missingFar.missingContractTimingLegIds), ['far']);
                assert.ok(missingFar.missingContractTimingLegs[0].reasons.includes(
                    'product_surviving_leg_contract_timing_missing'
                ));

                state.groups[0].legs[1].expiryAsOf = '2026-07-20T20:00:00Z';
                const complete = pricingContext.resolveSimulationTiming(state);
                assert.equal(complete.available, true);
                assert.equal(complete.source, 'near-leg-contract-cutoff');
                assert.equal(complete.contractTimingStatus, 'complete');
                assert.deepEqual(Array.from(complete.missingContractTimingLegIds), []);
            },
        },
        {
            name: 'keeps a same-day near-expiry target at the contract cutoff until it passes',
            run() {
                const ctx = loadPricingContext();
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    requireExactContractTiming: true,
                    underlyingSymbol: 'ES',
                    liveQuoteDate: '2026-07-17',
                    liveQuoteAsOf: '2026-07-17T19:25:00Z',
                    simulatedDate: '2026-07-17',
                    groups: [{ legs: [
                        {
                            id: 'near', type: 'call', pos: -1,
                            expDate: '2026-07-17',
                            expiryAsOf: '2026-07-17T19:30:00Z',
                        },
                        {
                            id: 'far', type: 'call', pos: 1,
                            expDate: '2026-07-20',
                            expiryAsOf: '2026-07-20T20:00:00Z',
                        },
                    ] }],
                };

                const beforeCutoff = pricingContext.resolveSimulationTiming(state);
                assert.equal(beforeCutoff.available, true);
                assert.equal(beforeCutoff.targetAsOf, '2026-07-17T19:30:00.000Z');
                assert.equal(beforeCutoff.source, 'near-leg-contract-cutoff');

                state.liveQuoteAsOf = '2026-07-17T19:31:00Z';
                const afterCutoff = pricingContext.resolveSimulationTiming(state);
                assert.equal(afterCutoff.available, true);
                assert.equal(afterCutoff.targetAsOf, '2026-07-17T19:31:00.000Z');
                assert.equal(afterCutoff.source, 'live-quote-after-near-leg-cutoff');
                assert.equal(afterCutoff.nearLegCutoffAsOf, '2026-07-17T19:30:00.000Z');
            },
        },
        {
            name: 'requires exact timing for any surviving leg inside seven days and preserves opt-outs',
            run() {
                const ctx = loadPricingContext();
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    requireExactContractTiming: true,
                    underlyingSymbol: 'SPY',
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: '2026-07-10T19:00:00Z',
                    simulatedDate: '2026-07-10',
                    groups: [{ legs: [{
                        id: 'short-dated', type: 'put', pos: 1, expDate: '2026-07-16',
                    }] }],
                };

                const blocked = pricingContext.resolveSimulationTiming(state);
                assert.equal(blocked.available, false);
                assert.equal(blocked.status, 'exact_contract_timing_missing');
                assert.deepEqual(Array.from(blocked.missingContractTimingLegIds), ['short-dated']);
                assert.ok(blocked.missingContractTimingLegs[0].remainingDays < 7);
                assert.ok(blocked.missingContractTimingLegs[0].reasons.includes(
                    'short_dated_surviving_leg_contract_timing_missing'
                ));

                state.groups[0].legs[0].expDate = '2026-07-18';
                const outsideWindow = pricingContext.resolveSimulationTiming(state);
                assert.equal(outsideWindow.available, true);

                state.groups[0].legs[0].expDate = '2026-07-16';
                state.requireExactContractTiming = false;
                const explicitlyDisabled = pricingContext.resolveSimulationTiming(state);
                assert.equal(explicitlyDisabled.available, true);
                assert.equal(explicitlyDisabled.contractTimingStatus, 'not_required');

                state.requireExactContractTiming = true;
                state.marketDataMode = 'historical';
                state.historicalQuoteDate = '2026-07-10';
                const historical = pricingContext.resolveSimulationTiming(state);
                assert.equal(historical.available, true);
                assert.equal(historical.contractTimingStatus, 'not_required');
            },
        },
        {
            name: 'blocks intrinsic settlement projections for standard AM-settled SPX legs',
            run() {
                const ctx = loadPricingContext();
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    requireExactContractTiming: true,
                    underlyingSymbol: 'SPX',
                    liveQuoteDate: '2026-06-10',
                    liveQuoteAsOf: '2026-06-10T19:00:00Z',
                    simulatedDate: '2026-06-17',
                    groups: [{ legs: [{
                        id: 'spx-am', type: 'call', pos: -1,
                        expDate: '2026-06-17', tradingClass: 'SPX',
                        expiryAsOf: '2026-06-17T21:00:00Z',
                    }] }],
                };

                const blocked = pricingContext.resolveSimulationTiming(state);
                assert.equal(blocked.available, false);
                assert.equal(blocked.status, 'deferred_settlement_fixing_unsupported');
                assert.deepEqual(Array.from(blocked.deferredSettlementLegIds), ['spx-am']);

                // A date-only same-day target still means the expiry cutoff,
                // so the unsupported later SET fixing remains blocked even
                // while the contract is currently trading.
                state.liveQuoteDate = '2026-06-17';
                state.liveQuoteAsOf = '2026-06-17T19:00:00Z';
                const sameDayExpiryProjection = pricingContext.resolveSimulationTiming(state);
                assert.equal(sameDayExpiryProjection.available, false);
                assert.equal(
                    sameDayExpiryProjection.status,
                    'deferred_settlement_fixing_unsupported'
                );

                // An explicit timestamp is the separate Now/intraday mode.
                state.simulationTargetAsOf = state.liveQuoteAsOf;
                const stillLive = pricingContext.resolveSimulationTiming(state);
                assert.equal(stillLive.available, true);
                delete state.simulationTargetAsOf;

                // PM-settled SPXW has no separate next-session SET gap.
                state.liveQuoteDate = '2026-06-10';
                state.liveQuoteAsOf = '2026-06-10T19:00:00Z';
                state.simulatedDate = '2026-06-18';
                state.groups[0].legs[0] = {
                    id: 'spxw-pm', type: 'call', pos: -1,
                    expDate: '2026-06-18', tradingClass: 'SPXW',
                    expiryAsOf: '2026-06-18T20:00:00Z',
                };
                assert.equal(pricingContext.resolveSimulationTiming(state).available, true);

                // Traditional quarterly ES options use an AM SOQ as well;
                // same-date weekly/PM classes are deliberately not inferred.
                state.underlyingSymbol = 'ES';
                state.liveQuoteDate = '2026-09-10';
                state.liveQuoteAsOf = '2026-09-10T19:00:00Z';
                state.simulatedDate = '2026-09-18';
                state.groups[0].legs[0] = {
                    id: 'es-quarterly-am', type: 'put', pos: -1,
                    expDate: '2026-09-18', tradingClass: 'ES',
                    expiryAsOf: '2026-09-18T13:30:00Z',
                };
                const esBlocked = pricingContext.resolveSimulationTiming(state);
                assert.equal(esBlocked.status, 'deferred_settlement_fixing_unsupported');
                assert.deepEqual(
                    Array.from(esBlocked.deferredSettlementLegIds),
                    ['es-quarterly-am']
                );
            },
        },
        {
            name: 'audits every far-leg weekend and holiday without scalar hole filling',
            run() {
                const ctx = loadPricingContext();
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '202609',
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: '2026-07-10T20:00:00Z',
                    simulatedDate: '2026-07-17',
                    simTimeBasis: 'weighted',
                    simUseImpliedLambda: true,
                    futuresPool: [{ id: 'esu6', contractMonth: '202609', mark: 6300 }],
                    groups: [{
                        legs: [
                            { id: 'near', type: 'call', pos: -1, expDate: '2026-07-17', underlyingFutureId: 'esu6' },
                            { id: 'far', type: 'call', pos: 1, expDate: '2026-07-20', underlyingFutureId: 'esu6' },
                        ],
                    }],
                };
                const requiredProbe = pricingContext.assessProjectionLambdaCoverage(state, null);
                assert.equal(requiredProbe.status, 'missing_entry');
                assert.deepEqual(
                    Array.from(requiredProbe.requiredDates),
                    ['2026-07-11', '2026-07-12', '2026-07-18', '2026-07-19']
                );
                assert.deepEqual(Array.from(requiredProbe.affectedLegIds), ['far']);

                const entry = {
                    schemaVersion: 2,
                    varianceSource: 'straddle',
                    symbol: 'ES',
                    anchorDate: '2026-07-10',
                    calendarKey: 'CME:ES',
                    underlyingContractMonth: '202609',
                    methodology: { pricingModel: 'black76' },
                    quality: { status: 'ok', coherent: true, quoteComplete: true },
                    byDate: {
                        '2026-07-11': 0.12,
                        '2026-07-12': 0.12,
                        '2026-07-18': 0.09,
                    },
                };
                const incomplete = pricingContext.assessProjectionLambdaCoverage(state, entry);
                assert.equal(incomplete.status, 'incomplete_coverage');
                assert.deepEqual(Array.from(incomplete.missingDates), ['2026-07-19']);

                entry.byDate['2026-07-19'] = 0.09;
                const complete = pricingContext.assessProjectionLambdaCoverage(state, entry);
                assert.equal(complete.ready, true);
                assert.equal(complete.status, 'complete');

                const auditedVendor = {
                    ...entry,
                    varianceSource: 'vendor_iv',
                    quality: {
                        ...entry.quality,
                        estimationMode: 'best_effort',
                        sourceQuoteEvidence: 'vendor_atm_iv_fallback',
                    },
                };
                assert.equal(
                    pricingContext.assessProjectionLambdaCoverage(state, auditedVendor).status,
                    'complete'
                );
            },
        },
        {
            name: 'does not require lambda when every still-live leg stays inside trading dates',
            run() {
                const ctx = loadPricingContext();
                const coverage = ctx.OptionComboPricingContext.assessProjectionLambdaCoverage({
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    liveQuoteDate: '2026-07-20',
                    liveQuoteAsOf: '2026-07-20T20:00:00Z',
                    simulatedDate: '2026-07-21',
                    simTimeBasis: 'weighted',
                    simUseImpliedLambda: true,
                    groups: [{ legs: [
                        { id: 'near', type: 'call', pos: -1, expDate: '2026-07-21' },
                        { id: 'far', type: 'call', pos: 1, expDate: '2026-07-22' },
                    ] }],
                }, null);
                assert.equal(coverage.ready, true);
                assert.equal(coverage.status, 'not_required');
                assert.deepEqual(Array.from(coverage.requiredDates), []);
            },
        },
        {
            name: 'requires structured lambda for a full holiday crossed by a surviving leg',
            run() {
                const ctx = loadPricingContext();
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    requireExactContractTiming: true,
                    underlyingSymbol: 'SPY',
                    liveQuoteDate: '2026-09-04',
                    liveQuoteAsOf: '2026-09-04T20:00:00Z',
                    simulatedDate: '2026-09-04',
                    simTimeBasis: 'weighted',
                    simUseImpliedLambda: true,
                    groups: [{ legs: [{
                        id: 'far-after-labor-day',
                        type: 'call',
                        pos: 1,
                        expDate: '2026-09-08',
                        expiryAsOf: '2026-09-08T20:00:00Z',
                    }] }],
                };
                const missing = pricingContext.assessProjectionLambdaCoverage(state, null);
                assert.equal(missing.status, 'missing_entry');
                assert.deepEqual(
                    Array.from(missing.requiredDates),
                    ['2026-09-05', '2026-09-06', '2026-09-07']
                );

                const entry = {
                    schemaVersion: 2,
                    varianceSource: 'straddle',
                    symbol: 'SPY',
                    anchorDate: '2026-09-04',
                    calendarKey: 'NYSE',
                    methodology: { pricingModel: 'bsm-spot' },
                    quality: { status: 'ok', coherent: true, quoteComplete: true },
                    byDate: {
                        '2026-09-05': 0.12,
                        '2026-09-06': 0.12,
                    },
                };
                const incomplete = pricingContext.assessProjectionLambdaCoverage(state, entry);
                assert.equal(incomplete.status, 'incomplete_coverage');
                assert.deepEqual(Array.from(incomplete.missingDates), ['2026-09-07']);
                entry.byDate['2026-09-07'] = 0.12;
                assert.equal(
                    pricingContext.assessProjectionLambdaCoverage(state, entry).status,
                    'complete'
                );
            },
        },
        {
            name: 'uses real zero-bid BBO and never fabricates a midpoint from a one-sided book',
            run() {
                let optionSnapshot = {
                    bid: 0,
                    ask: 0.20,
                    mark: 0.10,
                    markSource: 'bid_ask_mid',
                    bidPresent: true,
                    askPresent: true,
                    bidAskValid: true,
                    bidAskStatus: 'two_sided',
                    quoteAsOf: '2026-07-20T19:59:59Z',
                };
                const ctx = loadPricingContext({
                    OptionComboWsLiveQuotes: {
                        getOptionQuote() { return optionSnapshot; },
                    },
                });
                const pricingContext = ctx.OptionComboPricingContext;
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    liveQuoteAsOf: '2026-07-20T20:00:00Z',
                };
                const group = { livePriceMode: 'midpoint' };
                const leg = { id: 'zero-bid', type: 'call', currentPrice: 0.04, currentPriceSource: 'live' };
                const bbo = pricingContext.resolveObservableLegPrice(state, group, leg);
                assert.equal(bbo.price, 0.10);
                assert.equal(bbo.source, 'live_midpoint');
                assert.equal(bbo.fresh, true);

                const disconnected = pricingContext.resolveObservableLegPrice(
                    { ...state, liveProjectionFeedConnected: false },
                    group,
                    leg
                );
                assert.equal(disconnected.available, true);
                assert.equal(disconnected.price, 0.10);
                assert.equal(disconnected.fresh, false);
                assert.match(disconnected.quality, /feed_disconnected/);

                optionSnapshot = {
                    bid: null,
                    ask: 0.20,
                    mark: 0.04,
                    markSource: 'model',
                    bidPresent: false,
                    askPresent: true,
                    bidAskValid: false,
                    bidAskStatus: 'one_sided_ask',
                    quoteAsOf: '2026-07-20T19:59:59Z',
                };
                const oneSided = pricingContext.resolveObservableLegPrice(state, group, leg);
                assert.equal(oneSided.price, 0.04);
                assert.equal(oneSided.source, 'tws_model');

                // New transport validity is authoritative. A stale legacy
                // markSource must not overrule an explicit invalid BBO.
                optionSnapshot = {
                    bid: 0,
                    ask: 0.20,
                    mark: 0.10,
                    markSource: 'bid_ask_mid',
                    bidPresent: true,
                    askPresent: true,
                    bidAskValid: false,
                    bidAskStatus: 'crossed_or_invalid',
                    quoteAsOf: '2026-07-20T19:59:59Z',
                };
                const contradictory = pricingContext.resolveObservableLegPrice(state, group, leg);
                assert.notEqual(contradictory.source, 'live_midpoint');
                assert.notEqual(contradictory.source, 'live_bid_ask_mid');
            },
        },
    ],
};
