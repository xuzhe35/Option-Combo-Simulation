const assert = require('node:assert/strict');

const validator = require('../scripts/validate_calendar_projection');

module.exports = {
    name: 'historical calendar projection validator',
    tests: [
        {
            name: 'defaults to the curated weekday, weekend, and holiday cases',
            run() {
                const args = validator.parseArgs([]);
                assert.equal(args.symbol, 'SPY');
                assert.equal(args.cases.length, 3);
                assert.deepEqual(
                    args.cases.map(item => item.label),
                    ['weekday-only control', 'ordinary weekend', 'weekend plus MLK holiday']
                );
            },
        },
        {
            name: 'keeps real zero-bid books for leg pricing but not IVTS lambda calibration',
            run() {
                const row = { bid: 0, ask: 0.2 };
                assert.deepEqual(
                    validator.bbo(row, 3, false),
                    { bid: 0, ask: 0.2, midpoint: 0.1, spreadPct: 2 }
                );
                assert.equal(validator.bbo(row, 3, true), null);
                assert.equal(validator.bbo({ bid: 1.1, ask: 1 }, 3, false), null);
            },
        },
        {
            name: 'marks closure-free horizons not_required and fails closed on missing dates',
            run() {
                const runtime = {
                    OptionComboDateUtils: {
                        resolveWeightedTime(_start, end) {
                            return {
                                available: true,
                                nonTradingDates: end === 'weekday'
                                    ? []
                                    : ['2026-02-28', '2026-03-01'],
                            };
                        },
                    },
                };
                const noClosure = validator.lambdaSpecForInterval(
                    runtime, { byDate: {} }, 'start', 'weekday'
                );
                assert.equal(noClosure.ready, true);
                assert.equal(noClosure.required, false);
                assert.equal(noClosure.status, 'not_required');

                const missing = validator.lambdaSpecForInterval(
                    runtime,
                    { byDate: { '2026-02-28': 0.1 }, medianLambda: 0.1 },
                    'start',
                    'weekend'
                );
                assert.equal(missing.ready, false);
                assert.equal(missing.required, true);
                assert.deepEqual(missing.missingDates, ['2026-03-01']);

                const complete = validator.lambdaSpecForInterval(
                    runtime,
                    {
                        byDate: { '2026-02-28': 0.1, '2026-03-01': 0.2 },
                        medianLambda: 0.15,
                    },
                    'start',
                    'weekend'
                );
                assert.equal(complete.ready, true);
                assert.equal(complete.status, 'complete');
                assert.equal(complete.spec.strictByDate, true);
                assert.deepEqual(complete.spec.byDate, {
                    '2026-02-28': 0.1,
                    '2026-03-01': 0.2,
                });
            },
        },
        {
            name: 'aggregates entry, prior-session, boundary, and clock benchmark errors separately',
            run() {
                const summary = validator.aggregate([
                    {
                        status: 'ok',
                        entryError: 10,
                        priorSessionError: -4,
                        boundaryError: 0.001,
                        entryForecastInsideExitBbo: true,
                        clockBenchmarks: {
                            structured: { error: 10 },
                            lambda0: { error: 12 },
                            lambda0_3: { error: 20 },
                            calendar1: { error: 30 },
                        },
                    },
                    {
                        status: 'ok',
                        entryError: -6,
                        priorSessionError: 2,
                        boundaryError: -0.001,
                        entryForecastInsideExitBbo: false,
                        clockBenchmarks: {
                            structured: { error: -6 },
                            lambda0: { error: -8 },
                            lambda0_3: { error: -18 },
                            calendar1: { error: -28 },
                        },
                    },
                    { status: 'skipped' },
                ]);
                assert.equal(summary.usable, 2);
                assert.equal(summary.entryForecast.meanAbsoluteError, 8);
                assert.equal(summary.priorSessionForecast.meanAbsoluteError, 3);
                assert.equal(summary.targetBoundary.maxAbsoluteError, 0.001);
                assert.equal(
                    summary.researchClockBenchmarks.structured.meanAbsoluteError,
                    8
                );
                assert.equal(
                    summary.researchClockBenchmarks.calendar1.meanAbsoluteError,
                    29
                );
            },
        },
    ],
};
