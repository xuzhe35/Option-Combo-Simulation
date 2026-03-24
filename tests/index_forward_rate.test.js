const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

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

                const snapshot = ctx.OptionComboIndexForwardRate.computeSampleSnapshot(sample, state, {
                    callQuote: { bid: 125, ask: 127 },
                    putQuote: { bid: 170, ask: 172 },
                });

                assert.equal(snapshot.callMid, 126);
                assert.equal(snapshot.putMid, 171);
                assert.equal(snapshot.syntheticForward, 5755);
                assert.equal(snapshot.dailyCarry.toFixed(8), '0.00002898');
                assert.equal(snapshot.impliedRate.toFixed(6), '0.010577');
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
                            return { mark: 132 };
                        }
                        if (id.endsWith('_put')) {
                            return { mark: 181 };
                        }
                        return null;
                    },
                };

                const result = ctx.OptionComboIndexForwardRate.refreshForwardRateSample(sample, state, quoteSource);

                assert.equal(result.snapshot.syntheticForward, 5851);
                assert.equal(sample.isStale, false);
                assert.equal(sample.dailyCarry.toFixed(8), '0.00000190');
                assert.equal(sample.impliedRate.toFixed(6), '0.000692');
                assert.equal(typeof sample.lastComputedAt, 'string');
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

                assert.equal(exactExpiryCarry, 0.00047);
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
                assert.equal(nearestCarry, 0.00022);
            },
        },
    ],
};
