const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const DEFAULT_QUOTE_AS_OF = '2026-07-01T14:00:00.000Z';
const DEFAULT_EXPIRY_AS_OF = '2026-07-31T14:00:00.000Z';

function realBbo(bid, ask, extra = {}) {
    return {
        bid,
        ask,
        mark: (bid + ask) / 2,
        markSource: 'bid_ask_mid',
        bidPresent: true,
        askPresent: true,
        bidAskValid: ask >= bid,
        bidAskStatus: ask >= bid ? 'two_sided' : 'crossed',
        quoteAsOf: DEFAULT_QUOTE_AS_OF,
        ...extra,
    };
}

function exactOptionBbo(bid, ask, extra = {}) {
    const expiryAsOf = extra.expiryAsOf || DEFAULT_EXPIRY_AS_OF;
    const expiryDate = expiryAsOf.slice(0, 10).replace(/-/g, '');
    return realBbo(bid, ask, {
        expiryAsOf,
        expiryTimingSource: 'ib_contract_details',
        lastTradeDate: expiryDate,
        ...extra,
    });
}

function parityQuotes(callBid, callAsk, putBid, putAsk, spot, extra = {}) {
    return {
        callQuote: exactOptionBbo(callBid, callAsk, extra),
        putQuote: exactOptionBbo(putBid, putAsk, extra),
        underlyingQuote: realBbo(spot - 0.5, spot + 0.5, {
            quoteAsOf: extra.quoteAsOf || DEFAULT_QUOTE_AS_OF,
        }),
    };
}

module.exports = {
    name: 'index_forward_rate.js',
    tests: [
        {
            name: 'computes daily carry from a matched call/put sample',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);
                const sample = {
                    id: 'sample_1',
                    daysToExpiry: 30,
                    strike: 5800,
                };
                const state = {
                    underlyingPrice: 5750,
                };

                const snapshot = ctx.OptionComboIndexForwardRate.computeSampleSnapshot(
                    sample,
                    state,
                    parityQuotes(125, 127, 170, 172, 5750)
                );

                assert.equal(snapshot.callMid, 126);
                assert.equal(snapshot.putMid, 171);
                assert.equal(snapshot.syntheticForward, 5755);
                const expectedDailyCarry = Math.log(5755 / 5750) / 30;
                assert.ok(Math.abs(snapshot.dailyCarry - expectedDailyCarry) < 1e-12);
                assert.ok(Math.abs(snapshot.impliedRate - expectedDailyCarry * 365) < 1e-12);
            },
        },
        {
            name: 'accepts a real zero-bid BBO and rejects model marks for parity',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);
                const sample = { id: 'zero_bid', daysToExpiry: 30, strike: 100 };
                const state = { underlyingPrice: 100 };
                const zeroBid = exactOptionBbo(0, 0.20);
                const putBbo = exactOptionBbo(0.08, 0.12);
                const underlyingQuote = realBbo(99.5, 100.5);

                const snapshot = ctx.OptionComboIndexForwardRate.computeSampleSnapshot(
                    sample,
                    state,
                    { callQuote: zeroBid, putQuote: putBbo, underlyingQuote }
                );
                assert.equal(snapshot.callMid, 0.10);
                assert.equal(snapshot.putMid, 0.10);

                const modelOnly = {
                    bid: null,
                    ask: 0.20,
                    mark: 0.04,
                    markSource: 'model',
                    bidPresent: false,
                    askPresent: true,
                    bidAskValid: false,
                    quoteAsOf: DEFAULT_QUOTE_AS_OF,
                    expiryAsOf: DEFAULT_EXPIRY_AS_OF,
                    expiryTimingSource: 'ib_contract_details',
                    lastTradeDate: '20260731',
                };
                assert.equal(ctx.OptionComboIndexForwardRate.computeSampleSnapshot(
                    sample,
                    state,
                    { callQuote: modelOnly, putQuote: putBbo, underlyingQuote }
                ), null);
            },
        },
        {
            name: 'refreshes saved sample fields from quote cache helpers',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);
                const sample = {
                    id: 'sample_2',
                    daysToExpiry: 90,
                    strike: 5900,
                    dailyCarry: null,
                    impliedRate: null,
                    isStale: true,
                    lastComputedAt: null,
                };
                const state = {
                    underlyingPrice: 5850,
                };

                const quoteSource = {
                    getOptionQuote(id) {
                        if (id.endsWith('_call')) {
                            return exactOptionBbo(131, 133, {
                                expiryAsOf: '2026-09-29T14:00:00.000Z',
                            });
                        }
                        if (id.endsWith('_put')) {
                            return exactOptionBbo(180, 182, {
                                expiryAsOf: '2026-09-29T14:00:00.000Z',
                            });
                        }
                        return null;
                    },
                    getUnderlyingQuote() {
                        return realBbo(5849.5, 5850.5);
                    },
                };

                const result = ctx.OptionComboIndexForwardRate.refreshForwardRateSample(sample, state, quoteSource);

                assert.equal(result.snapshot.syntheticForward, 5851);
                assert.equal(sample.isStale, false);
                const expectedDailyCarry = Math.log(5851 / 5850) / 90;
                assert.ok(Math.abs(sample.dailyCarry - expectedDailyCarry) < 1e-12);
                assert.ok(Math.abs(sample.impliedRate - expectedDailyCarry * 365) < 1e-12);
                assert.equal(sample.lastComputedAt, DEFAULT_QUOTE_AS_OF);
                assert.equal(sample.tenorDays, 90);
                assert.deepEqual(Array.from(sample.quality.flags), []);
            },
        },
        {
            name: 'prefers an exact expiry sample before falling back to nearest tenor',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);

                const exactExpiryCarry = ctx.OptionComboIndexForwardRate.resolveDailyCarryForTarget(
                    [
                        {
                            id: 'nearby_1',
                            expDate: '2026-04-15',
                            daysToExpiry: 29,
                            dailyCarry: 0.00021,
                        },
                        {
                            id: 'exact_expiry',
                            expDate: '2026-06-18',
                            daysToExpiry: 93,
                            dailyCarry: 0.00047,
                        },
                    ],
                    {
                        expDate: '2026-06-18',
                        daysToExpiry: 90,
                    }
                );

                assert.ok(Math.abs(exactExpiryCarry - 0.00047) < 1e-12);
            },
        },
        {
            name: 'falls back to exact tenor and then nearest tenor when expiry is unavailable',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);

                const exactTenorCarry = ctx.OptionComboIndexForwardRate.resolveDailyCarryForTarget(
                    [
                        {
                            id: 'sample_30',
                            expDate: '2026-04-19',
                            daysToExpiry: 30,
                            dailyCarry: 0.00019,
                        },
                        {
                            id: 'sample_90',
                            expDate: '2026-06-18',
                            daysToExpiry: 90,
                            dailyCarry: 0.00041,
                        },
                    ],
                    {
                        expDate: '2026-05-20',
                        daysToExpiry: 90,
                    }
                );

                const nearestCarry = ctx.OptionComboIndexForwardRate.resolveDailyCarryForTarget(
                    [
                        {
                            id: 'sample_45',
                            expDate: '2026-05-04',
                            daysToExpiry: 45,
                            dailyCarry: 0.00022,
                        },
                        {
                            id: 'sample_120',
                            expDate: '2026-07-18',
                            daysToExpiry: 120,
                            dailyCarry: 0.0005,
                        },
                    ],
                    {
                        expDate: '2026-05-20',
                        daysToExpiry: 60,
                    }
                );

                assert.equal(exactTenorCarry, 0.00041);
                const expectedInterpolatedCarry = 0.00022
                    + (0.0005 - 0.00022) * ((60 - 45) / (120 - 45));
                assert.ok(Math.abs(nearestCarry - expectedInterpolatedCarry) < 1e-12);
            },
        },
        {
            name: 'rejects live carry samples that lag the current quote snapshot',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);
                const samples = [{
                    id: 'freshness_sample',
                    expDate: '2026-07-31',
                    daysToExpiry: 12,
                    carryRate: 0.04,
                    quoteAsOf: '2026-07-19T14:00:00Z',
                    isStale: false,
                }];

                const fresh = ctx.OptionComboIndexForwardRate.resolveCarryRateForTarget(samples, {
                    expDate: '2026-07-31',
                    daysToExpiry: 12,
                    quoteAsOf: '2026-07-19T14:01:59Z',
                });
                const stale = ctx.OptionComboIndexForwardRate.resolveCarryRateForTarget(samples, {
                    expDate: '2026-07-31',
                    daysToExpiry: 12,
                    quoteAsOf: '2026-07-19T14:02:01Z',
                });

                assert.equal(fresh, 0.04);
                assert.equal(stale, null);
            },
        },
        {
            name: 'uses a weekend-stamped discount curve for the Friday parity snapshot',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                ]);
                const rate = 0.04;
                // Sunday updater run: curveAsOf postdates the Friday quote
                // date while the economic data (effectiveDate) does not.
                const curve = ctx.OptionComboMarketCurves.createDiscountCurveFromSnapshot({
                    schemaVersion: 2,
                    kind: 'hybrid_discount_curve',
                    snapshotId: 'usd-reference:weekend-parity',
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
                    liveQuoteDate: '2026-07-17',
                    underlyingPrice: 5750,
                    // A manual fallback at r=0 would leave the discount factor
                    // at exactly 1, so a curve-discounted forward proves the
                    // weekend-stamped curve was accepted.
                    interestRate: 0,
                    useMarketDiscountCurve: true,
                    discountCurve: curve,
                };

                const snapshot = ctx.OptionComboIndexForwardRate.computeSampleSnapshot(
                    { id: 'weekend_sample', daysToExpiry: 30, strike: 5800 },
                    state,
                    parityQuotes(125, 127, 170, 172, 5750, {
                        quoteAsOf: '2026-07-17T14:00:00.000Z',
                        expiryAsOf: '2026-08-16T14:00:00.000Z',
                    })
                );

                const curveDiscountFactor = Math.exp(-rate * 30 / 365);
                assert.ok(Math.abs(
                    snapshot.syntheticForward - (5800 + (126 - 171) / curveDiscountFactor)
                ) < 1e-9);
                assert.notEqual(snapshot.syntheticForward, 5755);
            },
        },
        {
            name: 'uses exact ContractDetails seconds for short-tenor discounting and annualization',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);
                const quoteAsOf = '2026-07-17T20:00:20.000Z';
                const expiryAsOf = '2026-07-20T13:30:00.000Z';
                const quotes = parityQuotes(3.9, 4.1, 3.9, 4.1, 100, {
                    quoteAsOf,
                    expiryAsOf,
                });
                const snapshot = ctx.OptionComboIndexForwardRate.computeSampleSnapshot(
                    { id: 'short_weekend', expDate: '2026-07-20', daysToExpiry: 3, strike: 100 },
                    { interestRate: 0.05, liveQuoteAsOf: quoteAsOf },
                    quotes
                );

                const expectedSeconds = (Date.parse(expiryAsOf) - Date.parse(quoteAsOf)) / 1000;
                const expectedDays = expectedSeconds / 86400;
                assert.equal(snapshot.tenorSeconds, expectedSeconds);
                assert.ok(Math.abs(snapshot.tenorDays - expectedDays) < 1e-12);
                assert.ok(Math.abs(snapshot.discountFactor - Math.exp(-0.05 * expectedDays / 365)) < 1e-12);
                assert.equal(snapshot.carryRate, 0);
            },
        },
        {
            name: 'preserves fractional target days when projecting an index forward',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);
                const forward = ctx.OptionComboIndexForwardRate.resolveForwardPriceFromSpot(
                    100,
                    0.001,
                    0.5
                );
                assert.ok(Math.abs(forward - 100 * Math.exp(0.0005)) < 1e-12);
            },
        },
        {
            name: 'clears the last carry immediately when a BBO becomes crossed',
            run() {
                const ctx = loadBrowserScripts(['js/index_forward_rate.js']);
                const sample = { id: 'invalidate', strike: 100 };
                let callQuote = exactOptionBbo(4.9, 5.1);
                const quoteSource = {
                    getOptionQuote(id) {
                        return id.endsWith('_call') ? callQuote : exactOptionBbo(4.9, 5.1);
                    },
                    getUnderlyingQuote() {
                        return realBbo(99.5, 100.5);
                    },
                };
                const first = ctx.OptionComboIndexForwardRate.refreshForwardRateSample(
                    sample,
                    {},
                    quoteSource
                );
                assert.ok(first.snapshot);
                assert.equal(sample.isStale, false);

                callQuote = exactOptionBbo(5.2, 5.0);
                const invalid = ctx.OptionComboIndexForwardRate.refreshForwardRateSample(
                    sample,
                    {},
                    quoteSource
                );
                assert.equal(invalid.snapshot, null);
                assert.equal(invalid.reason, 'call_bbo_unavailable');
                assert.equal(sample.carryRate, null);
                assert.equal(sample.forwardPrice, null);
                assert.equal(sample.isStale, true);
                assert.equal(sample.quality.status, 'unavailable');
            },
        },
        {
            name: 'returns a structured parity carry observation without relabeling it as discount r',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                ]);
                const sample = {
                    id: 'spx_jul',
                    expDate: '2026-07-31',
                    daysToExpiry: 12,
                    daysToExpiryAsOf: '2026-07-19',
                    carryRate: 0.021,
                    forwardPrice: 6305,
                    spotPrice: 6300,
                    discountRate: 0.0367,
                    discountFactor: 0.9988,
                    discountSource: 'nyfed:sofr',
                    quoteAsOf: '2026-07-19T14:00:00Z',
                    quality: { status: 'good', flags: [] },
                    isStale: false,
                };
                const observation = ctx.OptionComboIndexForwardRate.resolveCarryObservationForTarget(
                    [sample],
                    {
                        expDate: '2026-07-31',
                        daysToExpiry: 12,
                        quoteAsOf: '2026-07-19T14:01:00Z',
                    }
                );

                assert.equal(observation.kind, 'carry');
                assert.equal(observation.source, 'option_put_call_parity');
                assert.equal(observation.carryRate, 0.021);
                assert.equal(observation.forwardPrice, 6305);
                assert.equal(observation.discountRate, 0.0367);
                assert.notEqual(observation.carryRate, observation.discountRate);
                assert.equal(observation.resolution.method, 'exact_expiry');

                const snapshot = ctx.OptionComboIndexForwardRate.buildCarrySnapshot(
                    [sample],
                    { asOf: '2026-07-19', quoteAsOf: '2026-07-19T14:01:00Z' }
                );
                assert.equal(snapshot.kind, 'carry');
                assert.equal(snapshot.discountCurveIndependent, true);
                assert.equal(snapshot.points.length, 1);
                assert.equal(snapshot.points[0].sampleId, 'spx_jul');
            },
        },
    ],
};
