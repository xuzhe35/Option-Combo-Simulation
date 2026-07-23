const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'iv_term_structure_core.js',
    tests: [
        {
            name: 'builds expiry detail rows from paired ATM call and put quotes',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const rows = ctx.OptionComboIvTermStructureCore.buildExpiryDetailRows(
                    [
                        {
                            expiry: '20260424',
                            dte: 1,
                            timeYears: 0.001,
                            atmStrike: 500,
                            atmCallSubId: 'spy_call_1d',
                            atmPutSubId: 'spy_put_1d',
                        },
                        {
                            expiry: '20260515',
                            dte: 22,
                            atmStrike: 505,
                            subscriptionSelected: false,
                            atmCallSubId: 'spy_call_3w',
                            atmPutSubId: 'spy_put_3w',
                        },
                    ],
                    {
                        spy_call_1d: { iv: 0.21, bid: 5, ask: 5.2, mark: 5.1 },
                        spy_put_1d: { iv: 0.25, bid: 4.7, ask: 4.9, mark: 4.8 },
                        spy_call_3w: { iv: 0.24, mark: 7.2 },
                        spy_put_3w: { iv: 0.28, mark: 6.9 },
                    }
                );

                assert.equal(rows.length, 2);
                assert.equal(rows[0].expiry, '20260424');
                assert.equal(rows[0].dte, 1);
                assert.equal(rows[0].timeYears, 0.001);
                assert.equal(rows[0].atmStrike, 500);
                assert.equal(rows[0].callIv, 0.21);
                assert.equal(rows[0].putIv, 0.25);
                assert.equal(rows[0].atmIv, 0.23);
                assert.equal(rows[0].callMark, 5.1);
                assert.equal(rows[0].putMark, 4.8);
                assert.equal(rows[0].callBid, 5);
                assert.equal(rows[0].callAsk, 5.2);
                assert.equal(rows[0].putBid, 4.7);
                assert.equal(rows[0].putAsk, 4.9);
                assert.equal(rows[0].atmStraddleMark, 9.9);
                assert.equal(rows[0].hasCompleteStraddle, true);
                assert.equal(rows[0].subscriptionSelected, true);
                assert.equal(rows[1].atmIv, 0.26);
                assert.equal(rows[1].atmStraddleMark, 14.1);
                assert.equal(rows[1].subscriptionSelected, false);
            },
        },
        {
            name: 'leaves ATM IV empty when either side of the paired strike is missing',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const rows = ctx.OptionComboIvTermStructureCore.buildExpiryDetailRows(
                    [
                        {
                            expiry: '20261021',
                            dte: 181,
                            atmStrike: 550,
                            atmCallSubId: 'spy_call_6m',
                            atmPutSubId: 'spy_put_6m',
                        },
                    ],
                    {
                        spy_call_6m: { iv: 0.29, mark: 12.3 },
                    }
                );

                assert.equal(rows.length, 1);
                assert.equal(rows[0].callIv, 0.29);
                assert.equal(rows[0].putIv, null);
                assert.equal(rows[0].atmIv, null);
                assert.equal(rows[0].hasCompletePair, false);
                assert.equal(rows[0].atmStraddleMark, null);
                assert.equal(rows[0].hasCompleteStraddle, false);
            },
        },
        {
            name: 'uses matching contract expiry timestamps for exact intraday straddle time',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const rows = ctx.OptionComboIvTermStructureCore.buildExpiryDetailRows(
                    [{
                        expiry: '20260717',
                        dte: 0,
                        timeYears: 0.123,
                        atmStrike: 7530,
                        atmCallSubId: 'call',
                        atmPutSubId: 'put',
                    }],
                    {
                        call: {
                            iv: 0.687, mark: 2.8,
                            quoteAsOf: '2026-07-17T19:59:00.000Z',
                            expiryAsOf: '2026-07-17T20:00:00.000Z',
                        },
                        put: {
                            iv: 0.687, mark: 2.9,
                            quoteAsOf: '2026-07-17T19:58:59.000Z',
                            expiryAsOf: '2026-07-17T20:00:00.000Z',
                        },
                    }
                );
                const oneMinuteYears = 1 / (365 * 24 * 60);
                assert.ok(Math.abs(rows[0].timeYears - oneMinuteYears) < 1e-14);
                assert.equal(rows[0].callExpiryAsOf, '2026-07-17T20:00:00.000Z');
                assert.equal(rows[0].putExpiryAsOf, '2026-07-17T20:00:00.000Z');
            },
        },
        {
            name: 'maps detail rows into nearest bucket rows with straddle marks',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const detailRows = [
                    { expiry: '20260424', dte: 1, atmStrike: 500, atmIv: 0.20, atmStraddleMark: 3.25, hasCompleteStraddle: true },
                    { expiry: '20260428', dte: 5, atmStrike: 501, atmIv: 0.205, atmStraddleMark: 5.5, hasCompleteStraddle: true },
                    { expiry: '20260502', dte: 9, atmStrike: 502, atmIv: 0.21, atmStraddleMark: 8.75, hasCompleteStraddle: true },
                    { expiry: '20260516', dte: 23, atmStrike: 503, atmIv: 0.215, atmStraddleMark: 13.1, hasCompleteStraddle: true },
                    { expiry: '20260526', dte: 33, atmStrike: 504, atmIv: 0.22, atmStraddleMark: 17.5, hasCompleteStraddle: true },
                    { expiry: '20260723', dte: 91, atmStrike: 510, atmIv: 0.24, atmStraddleMark: 28.9, hasCompleteStraddle: true },
                ];

                const bucketRows = ctx.OptionComboIvTermStructureCore.buildBucketRows(detailRows, [
                    { label: '1D', targetDays: 1 },
                    { label: '3D', targetDays: 3 },
                    { label: '1W', targetDays: 7 },
                    { label: '3W', targetDays: 21 },
                    { label: '1M', targetDays: 30 },
                    { label: '3M', targetDays: 90 },
                    { label: '6M', targetDays: 180 },
                ]);

                assert.equal(bucketRows.length, 7);
                assert.equal(bucketRows[0].matchedExpiry, '20260424');
                assert.equal(bucketRows[0].matchedDte, 1);
                assert.equal(bucketRows[1].matchedExpiry, '20260424');
                assert.equal(bucketRows[1].matchedDte, 1);
                assert.equal(bucketRows[2].matchedExpiry, '20260428');
                assert.equal(bucketRows[2].matchedDte, 5);
                assert.equal(bucketRows[3].matchedExpiry, '20260516');
                assert.equal(bucketRows[3].matchedDte, 23);
                assert.equal(bucketRows[4].matchedExpiry, '20260526');
                assert.equal(bucketRows[4].matchedDte, 33);
                assert.equal(bucketRows[5].matchedExpiry, '20260723');
                assert.equal(bucketRows[5].matchedDte, 91);
                assert.equal(bucketRows[6].matchedExpiry, '20260723');
                assert.equal(bucketRows[6].matchedDte, 91);
                assert.equal(bucketRows[6].atmIv, 0.24);
                assert.equal(bucketRows[6].atmStraddleMark, 28.9);
                assert.equal(bucketRows[6].hasCompleteStraddle, true);
            },
        },
        {
            name: 'adds straddle baseline ratios against a selected actual expiry',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const rows = ctx.OptionComboIvTermStructureCore.buildStraddleComparisonRows(
                    [
                        { expiry: '20260501', dte: 10, atmStraddleMark: 18 },
                        { expiry: '20260522', dte: 31, atmStraddleMark: 30 },
                        { expiry: '20260619', dte: 59, atmStraddleMark: 50 },
                    ],
                    '20260522'
                );

                assert.equal(rows[0].straddleBaselineExpiry, '20260522');
                assert.equal(rows[0].straddleBaselineMark, 30);
                assert.equal(rows[0].straddleBaselineRatio, 0.6);
                assert.equal(rows[0].isStraddleBaseline, false);
                assert.equal(rows[1].straddleBaselineRatio, 1);
                assert.equal(rows[1].isStraddleBaseline, true);
                assert.equal(rows[2].straddleBaselineRatio, 1.666667);
            },
        },
        {
            name: 'leaves straddle ratios empty when the row or selected baseline lacks a complete price',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const missingRowPrice = ctx.OptionComboIvTermStructureCore.buildStraddleComparisonRows(
                    [
                        { expiry: '20260501', dte: 10, atmStraddleMark: null },
                        { expiry: '20260522', dte: 31, atmStraddleMark: 30 },
                    ],
                    '20260522'
                );

                assert.equal(missingRowPrice[0].straddleBaselineMark, 30);
                assert.equal(missingRowPrice[0].straddleBaselineRatio, null);

                const missingBaselinePrice = ctx.OptionComboIvTermStructureCore.buildStraddleComparisonRows(
                    [
                        { expiry: '20260501', dte: 10, atmStraddleMark: 18 },
                        { expiry: '20260522', dte: 31, atmStraddleMark: null },
                    ],
                    '20260522'
                );

                assert.equal(missingBaselinePrice[0].straddleBaselineMark, null);
                assert.equal(missingBaselinePrice[0].straddleBaselineRatio, null);
                assert.equal(missingBaselinePrice[1].isStraddleBaseline, true);
            },
        },
        {
            name: 'stores selected straddle baseline metadata in sample records',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const detailRows = ctx.OptionComboIvTermStructureCore.buildStraddleComparisonRows(
                    [
                        { expiry: '20260501', dte: 10, atmStraddleMark: 18 },
                        { expiry: '20260522', dte: 31, atmStraddleMark: 30 },
                        { expiry: '20260619', dte: 59, atmStraddleMark: 50 },
                    ],
                    '20260522'
                );
                const sample = ctx.OptionComboIvTermStructureCore.buildSampleRecord(
                    'SPY',
                    500,
                    [],
                    detailRows,
                    '2026-04-23T15:45:04.357Z',
                    '2026-04-23',
                    '20260522'
                );

                assert.equal(sample.straddleBaselineExpiry, '20260522');
                assert.equal(sample.straddleBaselineMark, 30);
                assert.equal(sample.details[2].straddleBaselineRatio, 1.666667);
            },
        },
        {
            name: 'ranks all calendar candidates by highest short-long ATM IV ratio',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const rows = ctx.OptionComboIvTermStructureCore.buildCalendarFinderRows([
                    { expiry: '20260620', dte: 10, atmIv: 0.5, atmStraddleMark: 10, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260623', dte: 13, atmIv: 0.3, atmStraddleMark: 12, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260630', dte: 20, atmIv: 0.4, atmStraddleMark: 16, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260710', dte: 30, atmIv: 0.55, atmStraddleMark: 18, hasCompletePair: true, hasCompleteStraddle: true },
                ], {
                    targetRatio: 2,
                    tolerancePct: 25,
                    shortMinDte: 3,
                    shortMaxDte: 60,
                    sortBy: 'best_iv_ratio',
                });

                assert.equal(rows.length, 6);
                assert.equal(rows[0].shortExpiry, '20260620');
                assert.equal(rows[0].longExpiry, '20260623');
                assert.equal(rows[0].dteRatio, 1.3);
                assert.equal(rows[0].shortAtmIv, 0.5);
                assert.equal(rows[0].longAtmIv, 0.3);
                assert.equal(rows[0].ivRatio, 1.666667);
                assert.equal(rows[1].shortExpiry, '20260620');
                assert.equal(rows[1].longExpiry, '20260630');
                assert.equal(rows[1].ivRatio, 1.25);
            },
        },
        {
            name: 'skips calendar candidates with insufficient IV but does not filter by short DTE range',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const rows = ctx.OptionComboIvTermStructureCore.buildCalendarFinderRows([
                    { expiry: '20260610', dte: 0, atmIv: 0.8, atmStraddleMark: 4, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260613', dte: 3, atmIv: null, atmStraddleMark: 6, hasCompletePair: false, hasCompleteStraddle: true },
                    { expiry: '20260620', dte: 10, atmIv: 0.5, atmStraddleMark: 10, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260701', dte: 21, atmIv: 0.4, atmStraddleMark: 16, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260810', dte: 61, atmIv: 0.3, atmStraddleMark: 36, hasCompletePair: true, hasCompleteStraddle: true },
                ], {
                    targetRatio: 2,
                    tolerancePct: 25,
                    shortMinDte: 3,
                    shortMaxDte: 15,
                });

                assert.equal(rows.length, 3);
                assert.equal(rows[0].shortExpiry, '20260620');
                assert.equal(rows[0].longExpiry, '20260810');
                assert.equal(rows[0].ivRatio, 1.666667);
                assert.equal(rows[1].shortExpiry, '20260701');
                assert.equal(rows[1].longExpiry, '20260810');
                assert.equal(rows[2].longExpiry, '20260701');
            },
        },
        {
            name: 'does not filter calendar candidates by target DTE ratio',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const rows = ctx.OptionComboIvTermStructureCore.buildCalendarFinderRows([
                    { expiry: '20260620', dte: 10, atmIv: 0.5, atmStraddleMark: 10, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260623', dte: 13, atmIv: 0.3, atmStraddleMark: 12, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260710', dte: 30, atmIv: 0.4, atmStraddleMark: 18, hasCompletePair: true, hasCompleteStraddle: true },
                ], {
                    targetRatio: 8,
                    tolerancePct: 1,
                    sortBy: 'best_iv_ratio',
                });

                assert.equal(rows.length, 3);
                assert.equal(rows[0].shortExpiry, '20260620');
                assert.equal(rows[0].longExpiry, '20260623');
                assert.equal(rows[0].dteRatio, 1.3);
            },
        },
        {
            name: 'picks a secondary calendar candidate with a later short leg when available',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                const secondary = core.pickCalendarFinderSecondaryCandidate([
                    { shortExpiry: '20260615', longExpiry: '20260630', shortDte: 5, longDte: 10 },
                    { shortExpiry: '20260615', longExpiry: '20260706', shortDte: 5, longDte: 16 },
                    { shortExpiry: '20260630', longExpiry: '20260720', shortDte: 20, longDte: 40 },
                ]);

                assert.equal(secondary.shortExpiry, '20260630');
                assert.equal(secondary.longExpiry, '20260720');
            },
        },
        {
            name: 'falls back to the second ranked calendar candidate when no later short leg exists',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                const secondary = core.pickCalendarFinderSecondaryCandidate([
                    { shortExpiry: '20260615', longExpiry: '20260630', shortDte: 5, longDte: 10 },
                    { shortExpiry: '20260615', longExpiry: '20260706', shortDte: 5, longDte: 16 },
                ]);

                assert.equal(secondary.shortExpiry, '20260615');
                assert.equal(secondary.longExpiry, '20260706');
            },
        },
        {
            name: 'carries per-leg marks into calendar candidates for simulator handoff',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const rows = ctx.OptionComboIvTermStructureCore.buildCalendarFinderRows([
                    { expiry: '20260630', dte: 20, atmIv: 0.5, atmStraddleMark: 10, callMark: 5.2, putMark: 4.8, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260720', dte: 40, atmIv: 0.4, atmStraddleMark: 14, callMark: 7.5, putMark: 6.5, hasCompletePair: true, hasCompleteStraddle: true },
                ], { targetRatio: 2, tolerancePct: 25 });

                assert.equal(rows.length, 1);
                assert.equal(rows[0].shortCallMark, 5.2);
                assert.equal(rows[0].shortPutMark, 4.8);
                assert.equal(rows[0].longCallMark, 7.5);
                assert.equal(rows[0].longPutMark, 6.5);
            },
        },
        {
            name: 'reports calendar finder stats explaining empty results',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;
                const options = { targetRatio: 2, tolerancePct: 25, shortMinDte: 3, shortMaxDte: 25 };

                const stats = core.buildCalendarFinderStats([
                    { expiry: '20260610', dte: 0, atmIv: 0.8, atmStraddleMark: 4, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260620', dte: 10, atmIv: 0.5, atmStraddleMark: 10, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260630', dte: 20, atmIv: null, atmStraddleMark: 14, hasCompletePair: false, hasCompleteStraddle: true },
                    { expiry: '20260701', dte: 21, atmIv: 0.4, atmStraddleMark: 16, hasCompletePair: true, hasCompleteStraddle: true },
                    { expiry: '20260810', dte: 61, atmIv: 0.3, atmStraddleMark: 36, hasCompletePair: true, hasCompleteStraddle: true },
                ], options);

                // The 0-DTE row is excluded by the dte > 0 guard; the null-IV row is unusable.
                assert.equal(stats.totalExpiries, 5);
                assert.equal(stats.usableExpiries, 3);
                assert.equal(stats.shortCandidates, 2);
                assert.equal(stats.pairCount, 3);

                const emptyStats = core.buildCalendarFinderStats([], options);
                assert.equal(emptyStats.totalExpiries, 0);
                assert.equal(emptyStats.usableExpiries, 0);
                assert.equal(emptyStats.shortCandidates, 0);
                assert.equal(emptyStats.pairCount, 0);
            },
        },
        {
            name: 'counts trading days only inside official calendar coverage',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                // 2026-07-08 is a Wednesday; 07-10 Friday; 07-13 Monday.
                assert.equal(core.countTradingDays('2026-07-08', '20260710'), 2);
                assert.equal(core.countTradingDays('2026-07-08', '20260713'), 3);
                assert.equal(core.countTradingDays('2026-07-08', '2026-07-08'), 0);
                assert.equal(core.countTradingDays('', '20260713'), null);
                assert.equal(core.countTradingDays('2026-07-14', '20260713'), null);

                ctx.isMarketHoliday = (dateKey, calendarKey) => (
                    dateKey === '2026-07-09' && calendarKey === 'CME:ES'
                );
                assert.equal(core.countTradingDays('2026-07-08', '20260710', 'NYSE'), 2);
                assert.equal(core.countTradingDays('2026-07-08', '20260710', 'CME:ES'), 1);

                // Even a supplied holiday callback cannot authorize dates for
                // which the formal exchange snapshot has no coverage.
                ctx.isOfficialExchangeCalendarAvailable = () => false;
                assert.equal(core.countTradingDays('2026-07-08', '20260710', 'NYSE'), null);
            },
        },
        {
            name: 'trading-day IV equalizes fairly priced expiries on both sides of a weekend',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                // Fair pricing at constant per-trading-day variance: the Monday
                // expiry carries 3 trading days over 5 calendar days, so its
                // calendar-annualized IV is dragged down by sqrt(219/365).
                const nearCalendarIv = 0.29;
                const farCalendarIv = 0.29 * Math.sqrt(219 / 365);

                const rows = core.buildExpiryDetailRows(
                    [
                        { expiry: '20260710', dte: 2, atmStrike: 500, atmCallSubId: 'c_near', atmPutSubId: 'p_near' },
                        { expiry: '20260713', dte: 5, atmStrike: 500, atmCallSubId: 'c_far', atmPutSubId: 'p_far' },
                    ],
                    {
                        c_near: { iv: nearCalendarIv, mark: 3.0 },
                        p_near: { iv: nearCalendarIv, mark: 3.1 },
                        c_far: { iv: farCalendarIv, mark: 3.6 },
                        p_far: { iv: farCalendarIv, mark: 3.7 },
                    },
                    '2026-07-08'
                );

                assert.equal(rows.length, 2);
                assert.equal(rows[0].tradDte, 2);
                assert.equal(rows[1].tradDte, 3);
                assert.equal(
                    rows[0].callIvTd,
                    core.computeTradingDayAnnualizedIv(nearCalendarIv, 2, 2)
                );
                assert.equal(
                    rows[1].callIvTd,
                    core.computeTradingDayAnnualizedIv(farCalendarIv, 5, 3)
                );
                // Calendar IVs show a phantom ~29% inversion...
                assert.ok(rows[0].callIv / rows[1].callIv > 1.28);
                // ...which the trading-day clock removes almost exactly.
                assert.ok(Math.abs(rows[0].callIvTd - rows[1].callIvTd) < 0.0001);
                assert.ok(Math.abs(rows[0].atmIvTd - rows[1].atmIvTd) < 0.0001);
            },
        },
        {
            name: 'weighted lambda interpolates the TD IV between trading-day and calendar clocks',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                // λ=1 must reproduce the TWS calendar quote exactly.
                assert.equal(core.computeTradingDayAnnualizedIv(0.25, 5, 3, 1), 0.25);
                // λ=0 matches the original trading-day formula (default).
                assert.equal(
                    core.computeTradingDayAnnualizedIv(0.25, 5, 3, 0),
                    core.computeTradingDayAnnualizedIv(0.25, 5, 3)
                );
                // λ=0.3: effDte = 3 + 0.3*2 = 3.6, effYear = 252 + 0.3*113 = 285.9.
                const expected = 0.25 * Math.sqrt((5 / 365) / (3.6 / 285.9));
                assert.ok(Math.abs(core.computeTradingDayAnnualizedIv(0.25, 5, 3, 0.3) - expected) < 1e-6);
                // Out-of-range and junk weights clamp to [0, 1] / default 0.
                assert.equal(
                    core.computeTradingDayAnnualizedIv(0.25, 5, 3, 9),
                    core.computeTradingDayAnnualizedIv(0.25, 5, 3, 1)
                );
                assert.equal(
                    core.computeTradingDayAnnualizedIv(0.25, 5, 3, 'junk'),
                    core.computeTradingDayAnnualizedIv(0.25, 5, 3, 0)
                );

                // The lambda flows through detail rows and is stamped on them.
                const rows = core.buildExpiryDetailRows(
                    [{ expiry: '20260713', dte: 5, atmStrike: 500, atmCallSubId: 'c', atmPutSubId: 'p' }],
                    { c: { iv: 0.25, mark: 1 }, p: { iv: 0.25, mark: 1 } },
                    '2026-07-08',
                    0.3
                );
                assert.equal(rows[0].tdIvWeekendWeight, 0.3);
                assert.ok(Math.abs(rows[0].callIvTd - expected) < 1e-6);
                const bucketRows = core.buildBucketRows(rows, [{ label: '1W', targetDays: 7 }]);
                assert.equal(bucketRows[0].tdIvWeekendWeight, 0.3);

                // At λ=1 the TD IV column equals the TWS column for every row.
                const calendarRows = core.buildExpiryDetailRows(
                    [{ expiry: '20260713', dte: 5, atmStrike: 500, atmCallSubId: 'c', atmPutSubId: 'p' }],
                    { c: { iv: 0.25, mark: 1 }, p: { iv: 0.21, mark: 1 } },
                    '2026-07-08',
                    1
                );
                assert.equal(calendarRows[0].callIvTd, 0.25);
                assert.equal(calendarRows[0].putIvTd, 0.21);
            },
        },
        {
            name: 'feeds straddle-implied per-date lambda into TD IV and marks median extrapolation beyond coverage',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;
                const vendorIv = 0.2;
                const rows = [
                    { expiry: '20260724', dte: 4, tradDte: 4, callIv: vendorIv, putIv: vendorIv },
                    { expiry: '20260727', dte: 7, tradDte: 5, callIv: vendorIv, putIv: vendorIv },
                    { expiry: '20260803', dte: 14, tradDte: 10, callIv: vendorIv, putIv: vendorIv },
                ];
                const implied = {
                    varianceSource: 'straddle',
                    medianLambda: 0.2,
                    byDate: {
                        '2026-07-25': 0.2,
                        '2026-07-26': 0.2,
                    },
                    quality: {
                        status: 'ok', coherent: true, quoteComplete: true,
                    },
                };

                const corrected = core.applyImpliedLambdaClockToRows(
                    rows, '2026-07-20', implied, 'NYSE'
                );
                const effYear = 252 + 0.2 * 113;
                const fridayExpected = vendorIv * Math.sqrt((4 / 365) / (4 / effYear));
                const mondayExpected = vendorIv * Math.sqrt((7 / 365) / (5.4 / effYear));

                assert.equal(corrected[0].tdIvSource, 'implied_lambda');
                assert.equal(corrected[0].tdIvStatus, 'ok');
                assert.equal(Object.keys(corrected[0].tdIvAppliedWeights).length, 0);
                assert.ok(Math.abs(corrected[0].callIvTd - fridayExpected) < 1e-6);

                assert.equal(corrected[1].tdIvEffectiveDte, 5.4);
                assert.equal(corrected[1].tdIvAppliedWeights['2026-07-25'], 0.2);
                assert.equal(corrected[1].tdIvAppliedWeights['2026-07-26'], 0.2);
                assert.ok(Math.abs(corrected[1].callIvTd - mondayExpected) < 1e-6);

                const farExpected = vendorIv * Math.sqrt((14 / 365) / (10.8 / effYear));
                assert.equal(corrected[2].tdIvStatus, 'ok_extrapolated');
                assert.ok(Math.abs(corrected[2].callIvTd - farExpected) < 1e-6);
                assert.ok(Math.abs(corrected[2].putIvTd - farExpected) < 1e-6);
                assert.deepEqual(
                    Array.from(corrected[2].tdIvExtrapolatedWeightDates),
                    ['2026-08-01', '2026-08-02']
                );
                assert.equal(corrected[2].tdIvAppliedWeights['2026-08-01'], 0.2);
                assert.equal(corrected[2].tdIvAppliedWeights['2026-08-02'], 0.2);

                const bucket = core.buildBucketRows(corrected, [{ label: '1W', targetDays: 7 }])[0];
                assert.equal(bucket.tdIvSource, 'implied_lambda');
                assert.equal(bucket.tdIvEffectiveDte, 5.4);
                assert.equal(bucket.tdIvAppliedWeights['2026-07-25'], 0.2);
            },
        },
        {
            name: 'classifies the regime zone from the frozen-lambda TD slope',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                const row = (expiry, dte, tradDte, atmIv) => ({
                    expiry, dte, tradDte, atmIv, hasCompletePair: true, subscriptionSelected: true,
                });

                // Fair pricing: choose the back calendar IV so both legs carry
                // the same frozen-lambda TD IV; the conversion is linear in iv,
                // so back it out from the converter itself -> slope 1, stand_down.
                const frontTd = core.computeTradingDayAnnualizedIv(0.2, 7, 5, 0.3);
                const backIv = frontTd / core.computeTradingDayAnnualizedIv(1, 14, 10, 0.3);
                const fair = core.computeRegimeSignal([
                    row('20260717', 7, 5, 0.2),
                    row('20260724', 14, 10, backIv),
                ]);
                assert.equal(fair.status, 'ok');
                assert.equal(fair.zone, 'stand_down');
                assert.ok(Math.abs(fair.slope - 1) < 0.001);

                const backwardation = core.computeRegimeSignal([
                    row('20260717', 7, 5, 0.30),
                    row('20260724', 14, 10, 0.22),
                ]);
                assert.equal(backwardation.zone, 'sell_calendar');
                assert.ok(backwardation.slope > 1.05);
                assert.equal(backwardation.front.dte, 7);
                assert.equal(backwardation.back.dte, 14);

                const contango = core.computeRegimeSignal([
                    row('20260717', 7, 5, 0.15),
                    row('20260724', 14, 10, 0.21),
                ]);
                assert.equal(contango.zone, 'long_displacement');

                // A positive vendor-floor leg must not create a fake extreme
                // slope. ATM-only research fixtures remain supported, while
                // live rows that expose leg IVs must clear the floor on both.
                const sentinel = core.computeRegimeSignal([
                    { ...row('20260717', 7, 5, 0.15), callIv: 0.15, putIv: 0.15 },
                    { ...row('20260724', 14, 10, 0.09), callIv: 0.01488, putIv: 0.16 },
                ]);
                assert.equal(sentinel.status, 'insufficient');

                const priceMismatch = core.computeRegimeSignal([
                    { ...row('20260717', 7, 5, 0.15), atmStrike: 500, atmStraddleMark: 10 },
                    { ...row('20260724', 14, 10, 0.07), atmStrike: 500, atmStraddleMark: 15 },
                ]);
                assert.equal(priceMismatch.status, 'insufficient');

                // Live rows cannot bypass the same price/IV gate by omitting
                // the marks or strike while still exposing leg IVs.
                const missingLivePriceEvidence = core.computeRegimeSignal([
                    { ...row('20260717', 7, 5, 0.20), callIv: 0.20, putIv: 0.20 },
                    { ...row('20260724', 14, 10, 0.20), callIv: 0.20, putIv: 0.20 },
                ]);
                assert.equal(missingLivePriceEvidence.status, 'insufficient');

                // Boundary classification uses the UNROUNDED slope: a raw
                // slope of 0.94996 (which rounds to 0.9500 for display) must
                // stay in long_displacement; 1.05004 must stay sell_calendar.
                const factorRatio = core.computeTradingDayAnnualizedIv(1, 14, 10, 0.3)
                    / core.computeTradingDayAnnualizedIv(1, 7, 5, 0.3);
                const justBelow = core.computeRegimeSignal([
                    row('20260717', 7, 5, 0.94996 * 0.2 * factorRatio),
                    row('20260724', 14, 10, 0.2),
                ]);
                assert.equal(justBelow.zone, 'long_displacement');
                assert.equal(justBelow.slope, 0.95); // display rounds, class does not
                const justAbove = core.computeRegimeSignal([
                    row('20260717', 7, 5, 1.05004 * 0.2 * factorRatio),
                    row('20260724', 14, 10, 0.2),
                ]);
                assert.equal(justAbove.zone, 'sell_calendar');

                // Missing back expiry -> insufficient, never a fake zone.
                const missing = core.computeRegimeSignal([row('20260717', 7, 5, 0.2)]);
                assert.equal(missing.status, 'insufficient');
                // Unsubscribed rows are ignored.
                const unsub = core.computeRegimeSignal([
                    row('20260717', 7, 5, 0.2),
                    { ...row('20260724', 14, 10, 0.2), subscriptionSelected: false },
                ]);
                assert.equal(unsub.status, 'insufficient');
            },
        },
        {
            name: 'requires one fresh complete server snapshot for all four signal legs',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;
                const asOf = '2026-07-17T20:20:00Z';
                const row = (expiry, dte, tradDte, atmIv, snapshotId = 'close-1', quoteAsOf = asOf) => ({
                    expiry, dte, tradDte, atmIv,
                    hasCompletePair: true, subscriptionSelected: true,
                    callSnapshotId: snapshotId, putSnapshotId: snapshotId,
                    callQuoteAsOf: quoteAsOf, putQuoteAsOf: quoteAsOf,
                });
                const rows = [
                    row('20260717', 7, 5, 0.30),
                    row('20260724', 14, 10, 0.22),
                ];
                const signal = core.computeRegimeSignal(rows);
                const evidence = {
                    payloadAsOf: asOf, snapshotId: 'close-1', coherent: true, quoteComplete: true,
                };
                assert.equal(
                    core.evaluateSignalSnapshotCoherence(rows, signal, evidence).status,
                    'ok'
                );

                const mixed = rows.map((entry, index) => (
                    index === 1 ? { ...entry, putSnapshotId: 'incremental-2' } : entry
                ));
                assert.equal(
                    core.evaluateSignalSnapshotCoherence(mixed, signal, evidence).status,
                    'mixed_snapshot_legs'
                );
                const stale = rows.map((entry, index) => (
                    index === 0 ? { ...entry, callQuoteAsOf: '2026-07-17T20:00:00Z' } : entry
                ));
                assert.equal(
                    core.evaluateSignalSnapshotCoherence(stale, signal, evidence).status,
                    'stale_snapshot_leg'
                );
                assert.equal(
                    core.evaluateSignalSnapshotCoherence(rows, signal, {
                        ...evidence, coherent: false, quoteComplete: false,
                    }).status,
                    'incoherent_snapshot'
                );
            },
        },
        {
            name: 'computes MRR from official weekly closes instead of adjacent dense daily samples',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                const sample = (quoteDate, price, em) => ({
                    symbol: 'SPY', quoteDate, underlyingPrice: price, backfilled: true,
                    details: [{ dte: 7, atmStraddleMark: em }],
                });

                // A deliberately dense sequence has a noisy Tuesday plus the
                // official Friday close in every week. Adjacent-day logic
                // would produce 17 noisy ratios; official weekly-close logic
                // must produce exactly eight, all equal to 1.0.
                const tuesdays = ['2026-01-06', '2026-01-13', '2026-01-20', '2026-01-27', '2026-02-03',
                                  '2026-02-10', '2026-02-17', '2026-02-24', '2026-03-03'];
                const fridays = ['2026-01-09', '2026-01-16', '2026-01-23', '2026-01-30', '2026-02-06',
                                 '2026-02-13', '2026-02-20', '2026-02-27', '2026-03-06'];
                const samples = [];
                for (let index = 0; index < fridays.length; index += 1) {
                    samples.push(sample(tuesdays[index], 100 + index * 37, 5));
                    samples.push(sample(fridays[index], 500 + index * 5, 5));
                }
                const wm = core.computeDisplacementWatermark(samples, { asOf: '2026-03-09T12:00:00Z' });
                assert.equal(wm.status, 'ok');
                assert.equal(wm.count, 8);
                assert.ok(Math.abs(wm.mean - 1) < 1e-9);
                assert.equal(wm.weeklySampleCount, 9);
                assert.equal(wm.latestOfficialSampleDate, '2026-03-06');
                assert.equal(wm.latestObservationDate, '2026-03-06');
                assert.equal(wm.asOf, '2026-03-09');
                assert.equal(wm.ageDays, 3);
                assert.equal(wm.calendarKey, 'NYSE');

                // Fewer than 8 usable pairs -> collecting.
                const collecting = core.computeDisplacementWatermark(
                    fridays.slice(0, 5).map((date, index) => sample(date, 500 + index * 5, 5)),
                    { asOf: '2026-02-09' }
                );
                assert.equal(collecting.status, 'collecting');
                assert.equal(collecting.count, 4);

                // Both dates are official closes, but a missing intervening
                // week creates a >12d gap and therefore no observation.
                const skipped = core.computeDisplacementWatermark([
                    sample('2026-03-06', 500, 5),
                    sample('2026-03-27', 520, 5),
                ], { asOf: '2026-03-30' });
                assert.equal(skipped.count, 0);

                // Independence Day closes NYSE on Friday 3 July, so Thursday
                // 2 July is the official week close. The Monday snapshot is
                // ignored, and the 6-day close-to-close gap scales the EM.
                const scaled = core.computeDisplacementWatermark([
                    sample('2026-06-26', 500, 7),
                    sample('2026-06-29', 900, 7),
                    sample('2026-07-02', 500 + 7 * Math.sqrt(6 / 7), 7),
                ], { asOf: '2026-07-06' });
                assert.equal(scaled.status, 'collecting');
                assert.ok(Math.abs(scaled.latest - 1) < 1e-4);
                assert.equal(scaled.latestOfficialSampleDate, '2026-07-02');
                assert.equal(scaled.missingOfficialCloseWeeks, 0);
            },
        },
        {
            name: 'excludes incomplete weeks and fails closed on stale or unavailable MRR history',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                const stamped = (quoteDate, sampledAt, price) => ({
                    quoteDate,
                    sampledAt,
                    underlyingPrice: price,
                    details: [{ dte: 7, atmStraddleMark: 5 }],
                });

                // How merged history actually arrives: manual snapshots are
                // concatenated ahead of hourly automatic snapshots, so source
                // order and timestamp order disagree. The latest snapshot on
                // each official Friday must win.
                const manual = [
                    stamped('2026-05-08', '2026-05-08T20:20:00Z', 500),
                    stamped('2026-05-15', '2026-05-15T20:20:00Z', 505),
                ];
                const automatic = [
                    stamped('2026-05-08', '2026-05-08T17:00:00Z', 400),
                    stamped('2026-05-15', '2026-05-15T17:00:00Z', 400),
                    // Much later after-hours marks must not replace the
                    // 16:20 ET observation nearest the 16:15 option close.
                    stamped('2026-05-08', '2026-05-08T23:00:00Z', 900),
                    stamped('2026-05-15', '2026-05-15T23:00:00Z', 100),
                ];
                const options = { asOf: '2026-05-18' };
                const merged = core.computeDisplacementWatermark(manual.concat(automatic), options);
                // |505 - 500| / 5 = 1.0. Had the trailing automatic samples
                // won, both days would read 400 and the ratio would be 0.
                assert.equal(merged.count, 1);
                assert.ok(Math.abs(merged.latest - 1) < 1e-9);

                const lateOnly = core.computeDisplacementWatermark([
                    stamped('2026-05-08', '2026-05-08T23:00:00Z', 900),
                    stamped('2026-05-15', '2026-05-15T23:00:00Z', 100),
                ], options);
                assert.equal(lateOnly.weeklySampleCount, 0);
                assert.equal(lateOnly.incompleteOfficialCloseWeeks, 2);

                // Sorted input must agree with concatenated input.
                const sorted = core.computeDisplacementWatermark(
                    manual.concat(automatic).sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt)),
                    options
                );
                assert.deepEqual(sorted, merged);

                // Without timestamps there is nothing better than array order,
                // so the historical last-wins behaviour stays.
                const untimestamped = core.computeDisplacementWatermark([
                    { quoteDate: '2026-05-08', officialClose: true, underlyingPrice: 500, details: [{ dte: 7, atmStraddleMark: 5 }] },
                    { quoteDate: '2026-05-15', officialClose: true, underlyingPrice: 400, details: [{ dte: 7, atmStraddleMark: 5 }] },
                    { quoteDate: '2026-05-15', officialClose: true, underlyingPrice: 505, details: [{ dte: 7, atmStraddleMark: 5 }] },
                ], options);
                assert.ok(Math.abs(untimestamped.latest - 1) < 1e-9);

                const middayOnly = core.computeDisplacementWatermark([
                    stamped('2026-05-08', '2026-05-08T17:00:00Z', 500),
                    stamped('2026-05-15', '2026-05-15T17:00:00Z', 505),
                ], options);
                assert.equal(middayOnly.weeklySampleCount, 0);
                assert.equal(middayOnly.incompleteOfficialCloseWeeks, 2);

                // The current week is excluded even when an hourly sample is
                // present. Once the week is over, a Monday-only partial sample
                // still cannot stand in for Thursday 2 July's official close.
                const partial = core.computeDisplacementWatermark([
                    stamped('2026-06-26', '2026-06-26T20:20:00Z', 500),
                    stamped('2026-06-29', '2026-06-29T20:20:00Z', 510),
                ], { asOf: '2026-07-06' });
                assert.equal(partial.weeklySampleCount, 1);
                assert.equal(partial.missingOfficialCloseWeeks, 1);
                assert.equal(partial.latestOfficialSampleDate, '2026-06-26');

                const incomplete = core.computeDisplacementWatermark([
                    ...manual,
                    stamped('2026-05-18', '2026-05-18T19:55:00Z', 510),
                ], { asOf: '2026-05-20' });
                assert.equal(incomplete.excludedCurrentWeekSamples, 1);
                assert.equal(incomplete.latestOfficialSampleDate, '2026-05-15');

                // The current final session becomes usable after its official
                // close; no artificial wait until Monday. The same sample is
                // future/incomplete when evaluated five minutes earlier.
                const fridaySample = stamped('2026-05-22', '2026-05-22T20:15:00Z', 510);
                const beforeClose = core.computeDisplacementWatermark(
                    [...manual, fridaySample], { asOf: '2026-05-22T20:14:00Z' }
                );
                assert.equal(beforeClose.latestOfficialSampleDate, '2026-05-15');
                const afterClose = core.computeDisplacementWatermark(
                    [...manual, fridaySample], { asOf: '2026-05-22T20:20:00Z' }
                );
                assert.equal(afterClose.latestOfficialSampleDate, '2026-05-22');
                assert.equal(afterClose.count, 2);

                const stale = core.computeDisplacementWatermark(manual, { asOf: '2026-06-01' });
                assert.equal(stale.status, 'stale');
                assert.equal(stale.ageDays, 17);
                assert.equal(stale.mean, null);
                assert.match(stale.reason, /17 days old/);

                ctx.isOfficialExchangeCalendarAvailable = () => false;
                const unavailable = core.computeDisplacementWatermark(manual, options);
                assert.equal(unavailable.status, 'calendar_unavailable');
                assert.equal(unavailable.mean, null);

                // Historical backfill provenance is allowed before the
                // downloaded official snapshot coverage; ordinary samples
                // above remain unavailable under the same calendar failure.
                const validatedHistory = manual.map((sample) => ({
                    ...sample, backfilled: true, weeklySessionValidated: true,
                }));
                const historical = core.computeDisplacementWatermark(validatedHistory, options);
                assert.equal(historical.status, 'collecting');
                assert.equal(historical.count, 1);
            },
        },
        {
            name: 'maps zone and watermark onto the frozen strategy playbook',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;
                const okSignal = (zone, slope) => ({
                    status: 'ok', zone, slope,
                    front: { expiry: '20260717', dte: 7, ivTd: 0.2 },
                    back: { expiry: '20260724', dte: 14, ivTd: 0.2 },
                });
                const wmOk = { status: 'ok', mean: 1.08, count: 26, required: 8 };
                const wmLow = { status: 'ok', mean: 0.88, count: 26, required: 8 };
                const wmCollecting = { status: 'collecting', mean: null, count: 3, required: 8 };
                const wmStale = {
                    status: 'stale', mean: null, count: 26, required: 8,
                    reason: 'latest official weekly MRR observation is 17 days old',
                };

                const cal = core.buildStrategySuggestion(okSignal('sell_calendar', 1.12), wmOk);
                assert.equal(cal.stance, 'sell_calendar');
                assert.match(cal.exitRule, /\+50%/);

                const rev = core.buildStrategySuggestion(okSignal('long_displacement', 0.9), wmOk);
                assert.equal(rev.stance, 'long_displacement');
                assert.match(rev.exitRule, /Hold to expiry/);

                // The watermark veto: displacement era gone -> stand down.
                const veto = core.buildStrategySuggestion(okSignal('long_displacement', 0.9), wmLow);
                assert.equal(veto.stance, 'stand_down');
                assert.ok(veto.reasons.some((r) => r.includes('veto')));

                // Fail closed: a collecting (or absent) watermark cannot prove
                // the displacement era, so no structure is suggested yet.
                const collecting = core.buildStrategySuggestion(okSignal('long_displacement', 0.9), wmCollecting);
                assert.equal(collecting.stance, 'awaiting_watermark');
                assert.equal(collecting.structure, null);
                assert.ok(collecting.reasons.some((r) => r.includes('3/8')));
                const absent = core.buildStrategySuggestion(okSignal('long_displacement', 0.9), null);
                assert.equal(absent.stance, 'awaiting_watermark');
                const stale = core.buildStrategySuggestion(okSignal('long_displacement', 0.9), wmStale);
                assert.equal(stale.stance, 'awaiting_watermark');
                assert.equal(stale.structure, null);
                assert.ok(stale.reasons.some((r) => r.includes('17 days old')));

                const neutral = core.buildStrategySuggestion(okSignal('stand_down', 1.0), wmOk);
                assert.equal(neutral.stance, 'stand_down');

                const none = core.buildStrategySuggestion({ status: 'insufficient', reason: 'x' }, wmOk);
                assert.equal(none.stance, 'no_signal');
            },
        },
        {
            name: 'annotates pairwise TD slope vs baseline with shorter-leg-on-top convention',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;
                const rows = [
                    { expiry: '20260713', dte: 0, atmIv: 0.99, atmIvTd: null, hasCompletePair: true },
                    { expiry: '20260715', dte: 2, atmIv: 0.01, atmIvTd: 0.1375, hasCompletePair: true },
                    { expiry: '20260717', dte: 4, atmIv: 0.99, atmIvTd: 0.1337, hasCompletePair: true },
                    { expiry: '20260720', dte: 7, atmIv: 0.01, atmIvTd: 0.1150, hasCompletePair: true },
                    { expiry: '20260724', dte: 11, atmIv: 0.99, atmIvTd: 0.1100, hasCompletePair: false },
                ];

                const vs2d = core.annotateTdSlopeVsBaseline(rows, '20260715');
                const byExpiry = (annotated, expiry) => annotated.find((r) => r.expiry === expiry);
                // Baseline row itself carries no slope; a missing displayed
                // TD IV and incomplete pairs are excluded.
                assert.equal(byExpiry(vs2d, '20260715').tdSlopeVsBaseline, null);
                assert.equal(byExpiry(vs2d, '20260713').tdSlopeVsBaseline, null);
                assert.equal(byExpiry(vs2d, '20260724').tdSlopeVsBaseline, null);
                // The poisoned raw ATM IVs above are deliberately opposite.
                // 2d displayed TD IV is still above 4d displayed TD IV, so the
                // pair must read backwardation (>1) from atmIvTd.
                const pair24 = byExpiry(vs2d, '20260717').tdSlopeVsBaseline;
                assert.ok(pair24 > 1, `expected 2d/4d pair > 1, got ${pair24}`);

                // Shorter-leg-on-top: the same pair yields the same slope no
                // matter which side is chosen as baseline.
                const vs4d = core.annotateTdSlopeVsBaseline(rows, '20260717');
                assert.equal(byExpiry(vs4d, '20260715').tdSlopeVsBaseline, pair24);

                // The pair's DTE ratio rides along so the UI can confine the
                // 0.95/1.05 coloring to the calibrated ~2x geometry.
                assert.equal(byExpiry(vs2d, '20260717').tdSlopePairRatio, 2);
                assert.equal(byExpiry(vs2d, '20260720').tdSlopePairRatio, 3.5);
                assert.equal(byExpiry(vs2d, '20260715').tdSlopePairRatio, null);

                // A later pair likewise uses the displayed TD values. The
                // separate regime signal intentionally remains on frozen
                // lambda=0.3 and is not required to match this display column.
                const vs7d = core.annotateTdSlopeVsBaseline(rows.map((r) => ({
                    ...r, hasCompletePair: r.expiry !== '20260724' ? r.hasCompletePair : true,
                })), '20260720');
                assert.equal(
                    byExpiry(vs7d, '20260724').tdSlopeVsBaseline,
                    Math.round((0.115 / 0.11) * 10000) / 10000
                );
                assert.equal(byExpiry(vs7d, '20260724').tdSlopeSource, 'display_atm_td_iv');

                // No baseline -> annotation present but null everywhere.
                const none = core.annotateTdSlopeVsBaseline(rows, '');
                assert.ok(none.every((r) => r.tdSlopeVsBaseline === null));
            },
        },
        {
            name: 'exposes per-family MRR research benchmarks with ETF proxy attribution',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                // FOP families resolve to the ETF-measured research asset.
                const gold = core.getMrrResearchBenchmark('GC');
                assert.ok(gold);
                assert.equal(gold.measuredOn, 'GLD');
                assert.equal(core.getMrrResearchBenchmark('GLD'), gold);
                assert.ok(gold.eras.some((era) => era.span === '2020-24' && era.value === 0.78));
                assert.ok(gold.eras.some((era) => era.span === '2025-26' && era.value === 1.37));

                const sp = core.getMrrResearchBenchmark('es');
                assert.ok(sp);
                assert.equal(sp.measuredOn, 'SPY');
                assert.ok(sp.eras.some((era) => era.span === '2020-26' && era.value === 1.10));

                // Instruments outside the study get no borrowed number.
                assert.equal(core.getMrrResearchBenchmark('TLT'), null);
                assert.equal(core.getMrrResearchBenchmark('DEFAULT_EQUITY'), null);
                assert.equal(core.getMrrResearchBenchmark(''), null);
            },
        },
        {
            name: 'leaves trading-day IV empty without an anchor date and propagates it into buckets',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                const withoutAnchor = core.buildExpiryDetailRows(
                    [{ expiry: '20260713', dte: 5, atmStrike: 500, atmCallSubId: 'c', atmPutSubId: 'p' }],
                    { c: { iv: 0.2, mark: 1 }, p: { iv: 0.22, mark: 1 } }
                );
                assert.equal(withoutAnchor[0].tradDte, null);
                assert.equal(withoutAnchor[0].callIvTd, null);
                assert.equal(withoutAnchor[0].putIvTd, null);
                assert.equal(withoutAnchor[0].atmIvTd, null);

                const detailRows = core.buildExpiryDetailRows(
                    [{ expiry: '20260713', dte: 5, atmStrike: 500, atmCallSubId: 'c', atmPutSubId: 'p' }],
                    { c: { iv: 0.2, mark: 1 }, p: { iv: 0.22, mark: 1 } },
                    '2026-07-08'
                );
                const bucketRows = core.buildBucketRows(detailRows, [{ label: '1W', targetDays: 7 }]);
                assert.equal(bucketRows[0].tradDte, 3);
                assert.equal(bucketRows[0].callIvTd, detailRows[0].callIvTd);
                assert.equal(bucketRows[0].putIvTd, detailRows[0].putIvTd);
                assert.equal(bucketRows[0].atmIvTd, detailRows[0].atmIvTd);
            },
        },
        {
            name: 'computeImpliedWeekendLambdas recovers the priced weekend weight from the surface',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;

                // Legitimate Black-76 price surface: a flat 8e-5 per-trading-
                // day variance with weekends priced at lambda 0.2, call/put
                // mids generated by pricing_core's INDEPENDENT Black-76
                // implementation at a strike 2.5 points off the future (the
                // review's failing scenario for the old approximation).
                // Anchor 2026-07-17 is a Friday.
                const pctx = require('./helpers/load-browser-scripts').loadPricingContext();
                const lambdaTrue = 0.2;
                const dailyVar = 8e-5;
                const future = 7530;
                const strike = 7527.5;
                const rate = 0.04;
                const snapshotId = 'surface-close-1';
                const snapshotMetadata = {
                    snapshotId,
                    underlyingSnapshotId: snapshotId,
                    coherent: true,
                    quoteComplete: true,
                    quoteAsOf: '2026-07-17T20:00:10Z',
                    underlyingQuoteAsOf: '2026-07-17T20:00:05Z',
                };
                const makeRow = (expiry, dte, tradDays) => {
                    const totalVar = dailyVar * (tradDays + lambdaTrue * (dte - tradDays));
                    const sigma = Math.sqrt(totalVar / (dte / 365));
                    const callMark = pctx.calculateBlack76Price('call', future, strike, dte / 365, rate, sigma);
                    const putMark = pctx.calculateBlack76Price('put', future, strike, dte / 365, rate, sigma);
                    return {
                        expiry,
                        dte,
                        atmStrike: strike,
                        callMark,
                        putMark,
                        callBid: callMark * 0.995,
                        callAsk: callMark * 1.005,
                        putBid: putMark * 0.995,
                        putAsk: putMark * 1.005,
                        callMarkSource: 'bid_ask_mid',
                        putMarkSource: 'bid_ask_mid',
                        callQuoteAsOf: '2026-07-17T20:00:00Z',
                        putQuoteAsOf: '2026-07-17T20:00:10Z',
                        callSnapshotId: snapshotId,
                        putSnapshotId: snapshotId,
                        atmIv: 9.99, // poisoned vendor IV: must never be consulted
                    };
                };
                const rows = [
                    makeRow('20260720', 3, 1),
                    makeRow('20260721', 4, 2),
                    makeRow('20260722', 5, 3),
                    makeRow('20260723', 6, 4),
                    makeRow('20260724', 7, 5),
                    makeRow('20260727', 10, 6),
                    makeRow('20260728', 11, 7),
                ];

                const result = core.computeImpliedWeekendLambdas(rows, '2026-07-17', {
                    underlyingPrice: future,
                    pricingModel: 'black76',
                    interestRate: rate,
                    snapshotMetadata,
                });
                assert.equal(result.anchorDate, '2026-07-17');
                assert.equal(result.varianceSource, 'straddle');
                assert.equal(result.pricingModel, 'black76');
                assert.equal(result.pureIntervalCount, 5);

                const front = result.intervals.find((interval) => interval.isFront);
                assert.ok(front);
                assert.equal(front.status, 'unverified_front');
                assert.equal(front.tradingDays, 1);
                assert.equal(front.nonTradingDays, 2);
                assert.deepEqual([...front.nonTradingDates], ['2026-07-18', '2026-07-19']);
                assert.equal(front.lambda, null);
                assert.ok(!('2026-07-18' in result.byDate));

                const second = result.intervals.find((interval) => interval.endExpiry === '20260727');
                assert.ok(second);
                assert.equal(second.status, 'ok');
                assert.equal(second.startExpiry, '20260724');
                assert.equal(second.snapshotId, snapshotId);
                assert.equal(second.quoteAsOf, '2026-07-17T20:00:10.000Z');
                assert.deepEqual([...second.nonTradingDates], ['2026-07-25', '2026-07-26']);
                assert.ok(Math.abs(second.lambda - lambdaTrue) < 1e-3);

                assert.ok(Math.abs(result.medianLambda - lambdaTrue) < 1e-3);
                assert.ok(Math.abs(result.byDate['2026-07-26'] - lambdaTrue) < 1e-3);

                // Only an explicitly completed-session anchor may publish the
                // synthetic front interval.
                const verified = core.computeImpliedWeekendLambdas(rows, '2026-07-17', {
                    underlyingPrice: future,
                    pricingModel: 'black76',
                    interestRate: rate,
                    snapshotMetadata,
                    frontIntervalVerified: true,
                });
                const verifiedFront = verified.intervals.find((interval) => interval.isFront);
                assert.equal(verifiedFront.status, 'ok');
                assert.ok(Math.abs(verifiedFront.lambda - lambdaTrue) < 1e-3);
                assert.ok(Math.abs(verified.byDate['2026-07-18'] - lambdaTrue) < 1e-3);
            },
        },
        {
            name: 'solves exported lambda on exact expiry seconds when adjacent cutoffs differ',
            run() {
                const ctx = loadBrowserScripts([
                    'js/date_utils.js',
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;
                const dateUtils = ctx.OptionComboDateUtils;
                const pctx = require('./helpers/load-browser-scripts').loadPricingContext();
                const lambdaTrue = 0.2;
                const dailyVar = 8e-5;
                const future = 7530;
                const strike = 7530;
                const rate = 0.04;
                const quoteAsOf = '2026-07-17T20:00:00.000Z';
                const snapshotId = 'fractional-expiry-clock';
                const expiries = [
                    ['20260720', 3, '2026-07-20T20:00:00.000Z'],
                    ['20260721', 4, '2026-07-21T19:00:00.000Z'],
                    ['20260722', 5, '2026-07-22T20:00:00.000Z'],
                    ['20260723', 6, '2026-07-23T19:00:00.000Z'],
                    ['20260724', 7, '2026-07-24T20:00:00.000Z'],
                    ['20260727', 10, '2026-07-27T19:00:00.000Z'],
                    ['20260728', 11, '2026-07-28T20:00:00.000Z'],
                ];
                const rows = expiries.map(([expiry, dte, expiryAsOf]) => {
                    const clock = dateUtils.resolveWeightedTime(
                        quoteAsOf,
                        expiryAsOf,
                        lambdaTrue,
                        'NYSE',
                        null,
                        'America/New_York',
                        null
                    );
                    assert.equal(clock.available, true);
                    const timeYears = (Date.parse(expiryAsOf) - Date.parse(quoteAsOf))
                        / (365 * 86400000);
                    const totalVariance = dailyVar * clock.effectiveDays;
                    const sigma = Math.sqrt(totalVariance / timeYears);
                    const callMark = pctx.calculateBlack76Price(
                        'call', future, strike, timeYears, rate, sigma
                    );
                    const putMark = pctx.calculateBlack76Price(
                        'put', future, strike, timeYears, rate, sigma
                    );
                    return {
                        expiry,
                        dte,
                        timeYears,
                        atmStrike: strike,
                        callMark,
                        putMark,
                        callBid: callMark * 0.995,
                        callAsk: callMark * 1.005,
                        putBid: putMark * 0.995,
                        putAsk: putMark * 1.005,
                        callMarkSource: 'bid_ask_mid',
                        putMarkSource: 'bid_ask_mid',
                        callQuoteAsOf: quoteAsOf,
                        putQuoteAsOf: quoteAsOf,
                        callExpiryAsOf: expiryAsOf,
                        putExpiryAsOf: expiryAsOf,
                        callSnapshotId: snapshotId,
                        putSnapshotId: snapshotId,
                    };
                });
                const options = {
                    calendarKey: 'NYSE',
                    timeZone: 'America/New_York',
                    requireExactExpiryTimestamps: true,
                    underlyingPrice: future,
                    pricingModel: 'black76',
                    interestRate: rate,
                    snapshotMetadata: {
                        snapshotId,
                        underlyingSnapshotId: snapshotId,
                        coherent: true,
                        quoteComplete: true,
                        quoteAsOf,
                        underlyingQuoteAsOf: quoteAsOf,
                    },
                };
                const result = core.computeImpliedWeekendLambdas(
                    rows, '2026-07-17', options
                );
                const weekend = result.intervals.find(
                    interval => interval.endExpiry === '20260727'
                );
                assert.ok(weekend);
                assert.equal(weekend.status, 'ok');
                assert.equal(weekend.exactTimestampClock, true);
                assert.equal(weekend.startAsOf, '2026-07-24T20:00:00.000Z');
                assert.equal(weekend.endAsOf, '2026-07-27T19:00:00.000Z');
                assert.equal(weekend.calendarDays, 3);
                assert.equal(weekend.tradingDays, 1);
                assert.equal(weekend.nonTradingDays, 2);
                assert.ok(Math.abs(weekend.varianceCalendarDays - 71 / 24) < 1e-12);
                assert.ok(Math.abs(weekend.varianceTradingDays - 23 / 24) < 1e-12);
                assert.ok(Math.abs(weekend.varianceNonTradingDays - 2) < 1e-12);
                assert.ok(Math.abs(weekend.lambda - lambdaTrue) < 1e-3);
                assert.equal(result.byDate['2026-07-26'], weekend.lambda);
                assert.equal(
                    result.methodology.intervalClock,
                    'contract-expiry-fractional-seconds'
                );

                const missingExact = core.computeImpliedWeekendLambdas(
                    rows.map(row => ({
                        ...row,
                        callExpiryAsOf: '',
                        putExpiryAsOf: '',
                    })),
                    '2026-07-17',
                    options
                );
                assert.equal(
                    missingExact.quality.status,
                    'exact_expiry_timestamp_unavailable'
                );
                assert.ok(missingExact.rowDiagnostics.every(
                    row => row.status === 'exact_expiry_timestamp_unavailable'
                ));
                assert.deepEqual(Object.keys(missingExact.byDate), []);
            },
        },
        {
            name: 'keeps early-close dates trading while full holidays require lambda',
            run() {
                const ctx = loadBrowserScripts([
                    'js/date_utils.js',
                    'js/iv_term_structure_core.js',
                ]);
                const strictNoDates = {
                    default: 0.3,
                    strictByDate: true,
                    byDate: {},
                };
                const earlyClose = ctx.OptionComboDateUtils.resolveWeightedTime(
                    '2026-11-27T17:00:00.000Z',
                    '2026-11-27T18:15:00.000Z',
                    strictNoDates,
                    'NYSE',
                    null,
                    'America/New_York',
                    null
                );
                assert.equal(earlyClose.available, true);
                assert.deepEqual([...earlyClose.nonTradingDates], []);
                assert.ok(Math.abs(earlyClose.tradingDays - 1.25 / 24) < 1e-12);

                const laborDay = ctx.OptionComboDateUtils.resolveWeightedTime(
                    '2026-09-07T14:00:00.000Z',
                    '2026-09-07T15:00:00.000Z',
                    strictNoDates,
                    'NYSE',
                    null,
                    'America/New_York',
                    null
                );
                assert.equal(laborDay.available, false);
                assert.equal(laborDay.status, 'implied_lambda_incomplete');
                assert.deepEqual([...laborDay.missingWeightDates], ['2026-09-07']);
            },
        },
        {
            name: 'uses a real 0DTE straddle to remove the remaining Friday session intraday',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;
                const pctx = require('./helpers/load-browser-scripts').loadPricingContext();
                const lambdaTrue = 0.2;
                const dailyVar = 8e-5;
                const future = 7530;
                const strike = 7530;
                const rate = 0.04;

                const solveAt = (remainingFridayUnits, label) => {
                    const snapshotId = `intraday-${label}`;
                    const asOf = label === 'open'
                        ? '2026-07-17T13:31:00Z'
                        : '2026-07-17T18:00:00Z';
                    let cumulative = remainingFridayUnits * dailyVar;
                    const schedule = [
                        ['20260717', 0, 0],
                        ['20260720', 3, 1 + 2 * lambdaTrue],
                        ['20260721', 4, 1],
                        ['20260722', 5, 1],
                        ['20260723', 6, 1],
                        ['20260724', 7, 1],
                        ['20260727', 10, 1 + 2 * lambdaTrue],
                        ['20260728', 11, 1],
                    ];
                    const rows = schedule.map(([expiry, dte, addedUnits], index) => {
                        if (index > 0) cumulative += addedUnits * dailyVar;
                        const timeYears = dte === 0
                            ? Math.max(remainingFridayUnits * 6.5, 1 / 60) / (365 * 24)
                            : dte / 365;
                        const sigma = Math.sqrt(cumulative / timeYears);
                        const callMark = pctx.calculateBlack76Price(
                            'call', future, strike, timeYears, rate, sigma
                        );
                        const putMark = pctx.calculateBlack76Price(
                            'put', future, strike, timeYears, rate, sigma
                        );
                        return {
                            expiry,
                            dte,
                            timeYears,
                            atmStrike: strike,
                            callMark,
                            putMark,
                            callBid: callMark * 0.995,
                            callAsk: callMark * 1.005,
                            putBid: putMark * 0.995,
                            putAsk: putMark * 1.005,
                            callMarkSource: 'bid_ask_mid',
                            putMarkSource: 'bid_ask_mid',
                            callQuoteAsOf: asOf,
                            putQuoteAsOf: asOf,
                            callSnapshotId: snapshotId,
                            putSnapshotId: snapshotId,
                        };
                    });
                    return core.computeImpliedWeekendLambdas(rows, '2026-07-17', {
                        underlyingPrice: future,
                        pricingModel: 'black76',
                        interestRate: rate,
                        snapshotMetadata: {
                            snapshotId,
                            underlyingSnapshotId: snapshotId,
                            coherent: true,
                            quoteComplete: true,
                            quoteAsOf: asOf,
                            underlyingQuoteAsOf: asOf,
                        },
                    });
                };

                for (const [remaining, label] of [[0.95, 'open'], [0.25, 'midday']]) {
                    const result = solveAt(remaining, label);
                    const immediateWeekend = result.intervals.find(
                        (interval) => interval.endExpiry === '20260720'
                    );
                    assert.ok(immediateWeekend);
                    assert.equal(immediateWeekend.isFront, false);
                    assert.equal(immediateWeekend.status, 'ok');
                    assert.ok(Math.abs(immediateWeekend.lambda - lambdaTrue) < 1e-3);
                    assert.ok(Math.abs(result.byDate['2026-07-18'] - lambdaTrue) < 1e-3);
                }
            },
        },
        {
            name: 'computeImpliedWeekendLambdas survives an event day in the baseline window',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;

                const lambdaTrue = 0.1;
                const dailyVar = 8e-5;
                const rowFromTotalVar = (expiry, dte, totalVar) => (
                    { expiry, dte, atmIv: Math.sqrt(totalVar * 365 / dte) }
                );
                let cumVar = 0;
                const rows = [];
                const schedule = [
                    ['20260720', 3, 1 + 2 * lambdaTrue],
                    ['20260721', 4, 1],
                    ['20260722', 5, 3],   // event day: triple variance (FOMC-style)
                    ['20260723', 6, 1],
                    ['20260724', 7, 1],
                    ['20260727', 10, 1 + 2 * lambdaTrue],
                    ['20260728', 11, 1],
                ];
                for (const [expiry, dte, dayUnits] of schedule) {
                    cumVar += dailyVar * dayUnits;
                    rows.push(rowFromTotalVar(expiry, dte, cumVar));
                }

                const result = core.computeImpliedWeekendLambdas(rows, '2026-07-17', { varianceSource: 'vendor_iv' });
                assert.equal(result.varianceSource, 'vendor_iv');
                const second = result.intervals.find((interval) => interval.endExpiry === '20260727');
                assert.equal(second.status, 'ok');
                // Median baseline ignores the single 3x event day.
                assert.ok(Math.abs(second.lambda - lambdaTrue) < 1e-3);
            },
        },
        {
            name: 'computeImpliedWeekendLambdas flags unusable intervals instead of guessing',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;

                // Inverted front: the 20260727 expiry quotes BELOW the 20260724
                // total variance, so the weekend interval has negative forward
                // variance and must be flagged, not extrapolated.
                const rows = [
                    { expiry: '20260720', dte: 3, atmIv: 0.14 },
                    { expiry: '20260721', dte: 4, atmIv: 0.14 },
                    { expiry: '20260722', dte: 5, atmIv: 0.14 },
                    { expiry: '20260723', dte: 6, atmIv: 0.14 },
                    { expiry: '20260724', dte: 7, atmIv: 0.14 },
                    { expiry: '20260727', dte: 10, atmIv: 0.11 },
                ];
                const result = core.computeImpliedWeekendLambdas(rows, '2026-07-17', { varianceSource: 'vendor_iv' });
                const bad = result.intervals.find((interval) => interval.endExpiry === '20260727');
                assert.equal(bad.status, 'nonpositive_forward_variance');
                assert.equal(bad.lambda, null);
                assert.ok(!('2026-07-25' in result.byDate));

                // Weekly-only surface: every interval spans a weekend, so there
                // is no pure trading-day baseline anywhere.
                const weeklies = [
                    { expiry: '20260724', dte: 7, atmIv: 0.14 },
                    { expiry: '20260731', dte: 14, atmIv: 0.14 },
                ];
                const weeklyResult = core.computeImpliedWeekendLambdas(weeklies, '2026-07-17', { varianceSource: 'vendor_iv' });
                assert.equal(weeklyResult.intervals[0].status, 'unverified_front');
                assert.equal(weeklyResult.intervals[1].status, 'no_baseline');
                assert.equal(weeklyResult.medianLambda, null);
            },
        },
        {
            name: 'preserves and publishes signed lambda outside the conventional clock range',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;
                const dailyVar = 8e-5;
                const makeRows = (weekendLambda) => {
                    let totalVar = 0;
                    return [
                        ['20260720', 3, 1.4],
                        ['20260721', 4, 1],
                        ['20260722', 5, 1],
                        ['20260723', 6, 1],
                        ['20260724', 7, 1],
                        ['20260727', 10, 1 + 2 * weekendLambda],
                    ].map(([expiry, dte, units]) => {
                        totalVar += dailyVar * units;
                        return { expiry, dte, atmIv: Math.sqrt(totalVar * 365 / dte) };
                    });
                };

                for (const signedLambda of [-0.2, 1.2]) {
                    const result = core.computeImpliedWeekendLambdas(
                        makeRows(signedLambda),
                        '2026-07-17',
                        { varianceSource: 'vendor_iv' }
                    );
                    const interval = result.intervals.find((row) => row.endExpiry === '20260727');
                    assert.equal(interval.status, 'ok');
                    assert.ok(Math.abs(interval.rawLambda - signedLambda) < 1e-6);
                    assert.ok(Math.abs(interval.lambda - signedLambda) < 1e-4);
                    assert.equal(interval.lambdaClamped, signedLambda < 0 ? 0 : 1);
                    assert.equal(
                        interval.conventionalRange,
                        signedLambda < 0 ? 'inverted' : 'above_calendar'
                    );
                    assert.equal(interval.isInverted, signedLambda < 0);
                    assert.ok(Math.abs(result.byDate['2026-07-25'] - signedLambda) < 1e-4);
                    assert.ok(Math.abs(result.medianLambda - signedLambda) < 1e-4);
                    assert.equal(result.quality.status, 'ok');
                }
            },
        },
        {
            name: 'uses nearest pure-trading baselines for later weekly weekends',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;
                const dailyVar = 8e-5;
                let totalVar = 0;
                const rows = [
                    ['20260720', 3, 1],
                    ['20260721', 4, 1],
                    ['20260722', 5, 1],
                    ['20260723', 6, 1],
                    ['20260724', 7, 1],
                    ['20260727', 10, 1.2],
                    ['20260803', 17, 5.4],
                    ['20260810', 24, 5.4],
                ].map(([expiry, dte, varianceUnits]) => {
                    totalVar += dailyVar * varianceUnits;
                    return { expiry, dte, atmIv: Math.sqrt(totalVar * 365 / dte) };
                });
                const result = core.computeImpliedWeekendLambdas(
                    rows, '2026-07-17', { varianceSource: 'vendor_iv' }
                );
                const later = result.intervals.find(
                    interval => interval.endExpiry === '20260810'
                );
                assert.equal(later.status, 'ok');
                assert.equal(later.baselineMode, 'nearest_extrapolated');
                assert.ok(Number.isFinite(later.lambda));
                assert.equal(result.byDate['2026-08-08'], later.lambda);
                assert.equal(result.byDate['2026-08-09'], later.lambda);
            },
        },
        {
            name: 'computeImpliedWeekendLambdas treats holidays as non-trading days',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;

                // 2026-09-07 is Labor Day: the 20260904 -> 20260908 interval
                // holds Sat + Sun + holiday Monday (3 non-trading days).
                const lambdaTrue = 0.15;
                const dailyVar = 8e-5;
                const makeRow = (expiry, dte, tradDays) => {
                    const totalVar = dailyVar * (tradDays + lambdaTrue * (dte - tradDays));
                    return { expiry, dte, atmIv: Math.sqrt(totalVar * 365 / dte) };
                };
                // Anchor 2026-09-03 (Thursday).
                const rows = [
                    makeRow('20260904', 1, 1),
                    makeRow('20260908', 5, 2),
                    makeRow('20260909', 6, 3),
                    makeRow('20260910', 7, 4),
                    makeRow('20260911', 8, 5),
                ];
                const result = core.computeImpliedWeekendLambdas(rows, '2026-09-03', { varianceSource: 'vendor_iv' });
                const holidaySpan = result.intervals.find((interval) => interval.endExpiry === '20260908');
                assert.ok(holidaySpan);
                assert.equal(holidaySpan.status, 'ok');
                assert.equal(holidaySpan.tradingDays, 1);
                assert.equal(holidaySpan.nonTradingDays, 3);
                assert.deepEqual(
                    [...holidaySpan.nonTradingDates],
                    ['2026-09-05', '2026-09-06', '2026-09-07']
                );
                assert.deepEqual(
                    [...holidaySpan.weekendDates],
                    ['2026-09-05', '2026-09-06']
                );
                assert.deepEqual([...holidaySpan.holidayDates], ['2026-09-07']);
                assert.equal(holidaySpan.nonTradingDateKinds['2026-09-05'], 'weekend');
                assert.equal(
                    holidaySpan.nonTradingDateKinds['2026-09-07'],
                    'exchange_holiday'
                );
                assert.ok(Math.abs(holidaySpan.lambda - lambdaTrue) < 1e-3);
                assert.ok(Math.abs(result.byDate['2026-09-07'] - lambdaTrue) < 1e-3);
            },
        },
        {
            name: 'straddle inversion is exact for off-forward Black-76 and BSM surfaces',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;
                const pctx = require('./helpers/load-browser-scripts').loadPricingContext();

                // The straddle pricer must agree with pricing_core's separate
                // BSM and Black-76 implementations (non-circular benchmark).
                const bsmStraddle = pctx.calculateOptionPrice('call', 100, 100, 1, 0.05, 0.2)
                    + pctx.calculateOptionPrice('put', 100, 100, 1, 0.05, 0.2);
                assert.ok(Math.abs(
                    core.priceStraddleFromTotalVol('bsm-spot', 100, 100, 1, 0.05, 0.2) - bsmStraddle
                ) < 1e-9);
                const b76Straddle = pctx.calculateBlack76Price('call', 7530, 7500, 0.05, 0.04, 0.14)
                    + pctx.calculateBlack76Price('put', 7530, 7500, 0.05, 0.04, 0.14);
                assert.ok(Math.abs(
                    core.priceStraddleFromTotalVol('black76', 7530, 7500, 0.05, 0.04, 0.14 * Math.sqrt(0.05)) - b76Straddle
                ) < 1e-9);

                const lambdaTrue = 0.2;
                const dailyVar = 8e-5;
                const snapshotId = 'exact-surface-1';
                const snapshotMetadata = {
                    snapshotId,
                    underlyingSnapshotId: snapshotId,
                    coherent: true,
                    quoteComplete: true,
                    quoteAsOf: '2026-07-17T20:00:00Z',
                    underlyingQuoteAsOf: '2026-07-17T20:00:00Z',
                };
                const buildRows = (price, strike, priceFn) => [
                    ['20260720', 3, 1], ['20260721', 4, 2], ['20260722', 5, 3],
                    ['20260723', 6, 4], ['20260724', 7, 5], ['20260727', 10, 6],
                    ['20260728', 11, 7],
                ].map(([expiry, dte, trad]) => {
                    const totalVar = dailyVar * (trad + lambdaTrue * (dte - trad));
                    const sigma = Math.sqrt(totalVar / (dte / 365));
                    const callMark = priceFn('call', price, strike, dte / 365, 0.04, sigma);
                    const putMark = priceFn('put', price, strike, dte / 365, 0.04, sigma);
                    return {
                        expiry,
                        dte,
                        atmStrike: strike,
                        callMark,
                        putMark,
                        callBid: callMark * 0.995,
                        callAsk: callMark * 1.005,
                        putBid: putMark * 0.995,
                        putAsk: putMark * 1.005,
                        callMarkSource: 'bid_ask_mid',
                        putMarkSource: 'bid_ask_mid',
                        callQuoteAsOf: '2026-07-17T20:00:00Z',
                        putQuoteAsOf: '2026-07-17T20:00:00Z',
                        callSnapshotId: snapshotId,
                        putSnapshotId: snapshotId,
                        atmIv: 9.99,
                    };
                });

                // Black-76, strike a full 5 points off the future: the old
                // approximation read lambda ~0.13 here; exact inversion holds.
                const b76 = core.computeImpliedWeekendLambdas(
                    buildRows(7530, 7525, pctx.calculateBlack76Price),
                    '2026-07-17',
                    {
                        underlyingPrice: 7530,
                        pricingModel: 'black76',
                        interestRate: 0.04,
                        snapshotMetadata,
                        frontIntervalVerified: true,
                    }
                );
                const b76Front = b76.intervals.find((interval) => interval.isFront);
                assert.ok(Math.abs(b76Front.lambda - lambdaTrue) < 1e-3);

                // BSM equity ETF surface, strike below spot, nonzero rate.
                const bsm = core.computeImpliedWeekendLambdas(
                    buildRows(660, 659, pctx.calculateOptionPrice),
                    '2026-07-17',
                    {
                        underlyingPrice: 660,
                        pricingModel: 'bsm-spot',
                        interestRate: 0.04,
                        snapshotMetadata,
                        frontIntervalVerified: true,
                    }
                );
                const bsmFront = bsm.intervals.find((interval) => interval.isFront);
                assert.ok(Math.abs(bsmFront.lambda - lambdaTrue) < 1e-3);
            },
        },
        {
            name: 'uses the shared discount curve per expiry without assuming q=0 for spot products',
            run() {
                const ctx = loadBrowserScripts([
                    'js/market_curves.js',
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;
                const curves = ctx.OptionComboMarketCurves;
                const pctx = require('./helpers/load-browser-scripts').loadPricingContext();
                const discountCurve = curves.createDiscountCurve({
                    id: 'test-per-expiry-discount',
                    asOf: '2026-07-17',
                    maxExtrapolationDays: 31,
                    source: 'test_zero_curve',
                    quoteAsOf: '2026-07-17T20:00:00Z',
                    quality: { status: 'good' },
                    points: [
                        { tenorDays: 3, zeroRate: 0.10 },
                        { tenorDays: 7, zeroRate: 0.35 },
                        { tenorDays: 11, zeroRate: 0.60 },
                    ],
                });
                const lambdaTrue = 0.2;
                const dailyVar = 8e-5;
                const spot = 660;
                const strike = 658;
                const carryRate = -1.0;
                const snapshotId = 'spot-dividend-surface';
                const asOf = '2026-07-17T20:00:00Z';
                const schedule = [
                    ['20260720', 3, 1], ['20260721', 4, 2], ['20260722', 5, 3],
                    ['20260723', 6, 4], ['20260724', 7, 5], ['20260727', 10, 6],
                    ['20260728', 11, 7],
                ];
                const rows = schedule.map(([expiry, dte, trad]) => {
                    const timeYears = dte / 365;
                    const discount = curves.resolveDiscount(discountCurve, { tenorDays: dte });
                    const forward = spot * Math.exp(carryRate * timeYears);
                    const totalVar = dailyVar * (trad + lambdaTrue * (dte - trad));
                    const sigma = Math.sqrt(totalVar / timeYears);
                    const callMark = pctx.calculateBlack76Price(
                        'call', forward, strike, timeYears, discount.zeroRate, sigma
                    );
                    const putMark = pctx.calculateBlack76Price(
                        'put', forward, strike, timeYears, discount.zeroRate, sigma
                    );
                    return {
                        expiry,
                        dte,
                        timeYears,
                        atmStrike: strike,
                        callBid: callMark * 0.995,
                        callAsk: callMark * 1.005,
                        putBid: putMark * 0.995,
                        putAsk: putMark * 1.005,
                        callMarkSource: 'bid_ask_mid',
                        putMarkSource: 'bid_ask_mid',
                        callQuoteAsOf: asOf,
                        putQuoteAsOf: asOf,
                        callSnapshotId: snapshotId,
                        putSnapshotId: snapshotId,
                    };
                });
                const result = core.computeImpliedWeekendLambdas(rows, '2026-07-17', {
                    underlyingPrice: spot,
                    pricingModel: 'bsm-spot',
                    interestRate: 0.04,
                    discountCurve,
                    snapshotMetadata: {
                        snapshotId,
                        underlyingSnapshotId: snapshotId,
                        coherent: true,
                        quoteComplete: true,
                        quoteAsOf: asOf,
                        underlyingQuoteAsOf: asOf,
                    },
                    frontIntervalVerified: true,
                });

                const dteSeven = result.rowDiagnostics.find((row) => row.expiry === '20260724');
                assert.equal(dteSeven.status, 'ok');
                assert.ok(Math.abs(dteSeven.discountRate - 0.35) < 1e-10);
                assert.equal(dteSeven.discountSource, 'test_zero_curve');
                assert.equal(dteSeven.discountFallbackUsed, false);
                assert.equal(dteSeven.referenceForward, null);
                assert.equal(dteSeven.referenceForwardSource, null);
                const weekend = result.intervals.find((row) => row.endExpiry === '20260727');
                assert.equal(weekend.status, 'ok');
                assert.ok(Math.abs(weekend.lambda - lambdaTrue) < 1e-3);
                assert.equal(result.discounting.curveRowCount, rows.length);
                assert.equal(result.discounting.fallbackRowCount, 0);
                assert.equal(result.methodology.discounting.source, 'test_zero_curve');

                // Cash indexes use discounted-forward pricing too, but their
                // subscribed IND quote is spot rather than a futures forward.
                // Explicit product semantics must therefore suppress the same
                // invalid spot-vs-parity rejection on the Black-76 route.
                const indexResult = core.computeImpliedWeekendLambdas(rows, '2026-07-17', {
                    underlyingPrice: spot,
                    pricingModel: 'black76',
                    underlyingQuoteIsForward: false,
                    interestRate: 0.04,
                    discountCurve,
                    snapshotMetadata: {
                        snapshotId,
                        underlyingSnapshotId: snapshotId,
                        coherent: true,
                        quoteComplete: true,
                        quoteAsOf: asOf,
                        underlyingQuoteAsOf: asOf,
                    },
                    frontIntervalVerified: true,
                });
                const indexDiagnostic = indexResult.rowDiagnostics.find(
                    (row) => row.expiry === '20260724'
                );
                assert.equal(indexDiagnostic.status, 'ok');
                assert.equal(indexDiagnostic.referenceForward, null);
                assert.equal(indexResult.methodology.underlyingQuoteIsForward, false);

                const staleCurve = curves.createDiscountCurve({
                    id: 'stale-test-discount',
                    asOf: '2026-07-01',
                    source: 'stale_test_zero_curve',
                    quoteAsOf: '2026-07-01T20:00:00Z',
                    quality: { status: 'good' },
                    points: [
                        { tenorDays: 3, zeroRate: 0.10 },
                        { tenorDays: 7, zeroRate: 0.35 },
                        { tenorDays: 11, zeroRate: 0.60 },
                    ],
                });
                const staleResult = core.computeImpliedWeekendLambdas(rows, '2026-07-17', {
                    underlyingPrice: spot,
                    pricingModel: 'bsm-spot',
                    interestRate: 0.04,
                    discountCurve: staleCurve,
                    snapshotMetadata: {
                        snapshotId,
                        underlyingSnapshotId: snapshotId,
                        coherent: true,
                        quoteComplete: true,
                        quoteAsOf: asOf,
                        underlyingQuoteAsOf: asOf,
                    },
                });
                assert.equal(staleResult.discounting.curveConfigured, true);
                assert.equal(staleResult.discounting.curveUsable, false);
                assert.equal(staleResult.discounting.curveFallbackReason, 'curve_stale');
                assert.equal(staleResult.discounting.curveAgeDays, 16);
                assert.equal(staleResult.discounting.fallbackRowCount, rows.length);
                assert.equal(staleResult.rowDiagnostics[0].discountFallbackReason, 'curve_stale');
                assert.equal(staleResult.rowDiagnostics[0].discountRate, 0.04);

                const futureCurve = curves.createDiscountCurve({
                    id: 'future-test-discount',
                    asOf: '2026-07-18',
                    source: 'future_test_zero_curve',
                    quoteAsOf: '2026-07-18T20:00:00Z',
                    quality: { status: 'good' },
                    points: [{ tenorDays: 7, zeroRate: 0.05 }],
                });
                const futureResult = core.computeImpliedWeekendLambdas(rows, '2026-07-17', {
                    underlyingPrice: spot,
                    pricingModel: 'bsm-spot',
                    interestRate: 0.04,
                    discountCurve: futureCurve,
                    snapshotMetadata: {
                        snapshotId,
                        underlyingSnapshotId: snapshotId,
                        coherent: true,
                        quoteComplete: true,
                        quoteAsOf: asOf,
                        underlyingQuoteAsOf: asOf,
                    },
                });
                assert.equal(futureResult.discounting.curveUsable, false);
                assert.equal(futureResult.discounting.curveFallbackReason, 'curve_from_future');
                assert.equal(futureResult.discounting.curveAgeDays, -1);
            },
        },
        {
            name: 'uses per-expiry parity forwards and rejects disagreement with the underlying',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;
                const pctx = require('./helpers/load-browser-scripts').loadPricingContext();
                const lambdaTrue = 0.2;
                const dailyVar = 8e-5;
                const referenceFuture = 7530;
                const strike = 7530;
                const rate = 0.04;
                const snapshotId = 'parity-forward-surface';
                const asOf = '2026-07-17T20:00:00Z';
                const schedule = [
                    ['20260720', 3, 1], ['20260721', 4, 2], ['20260722', 5, 3],
                    ['20260723', 6, 4], ['20260724', 7, 5], ['20260727', 10, 6],
                    ['20260728', 11, 7],
                ];
                const buildRows = (badIndex = -1) => schedule.map(([expiry, dte, trad], index) => {
                    const parityForward = index === badIndex ? 7600 : referenceFuture + index * 2;
                    const totalVar = dailyVar * (trad + lambdaTrue * (dte - trad));
                    const sigma = Math.sqrt(totalVar / (dte / 365));
                    const callMark = pctx.calculateBlack76Price(
                        'call', parityForward, strike, dte / 365, rate, sigma
                    );
                    const putMark = pctx.calculateBlack76Price(
                        'put', parityForward, strike, dte / 365, rate, sigma
                    );
                    return {
                        expiry,
                        dte,
                        atmStrike: strike,
                        callMark,
                        putMark,
                        callBid: callMark * 0.995,
                        callAsk: callMark * 1.005,
                        putBid: putMark * 0.995,
                        putAsk: putMark * 1.005,
                        callMarkSource: 'bid_ask_mid',
                        putMarkSource: 'bid_ask_mid',
                        callQuoteAsOf: asOf,
                        putQuoteAsOf: asOf,
                        callSnapshotId: snapshotId,
                        putSnapshotId: snapshotId,
                    };
                });
                const opts = {
                    underlyingPrice: referenceFuture,
                    pricingModel: 'black76',
                    interestRate: rate,
                    snapshotMetadata: {
                        snapshotId,
                        underlyingSnapshotId: snapshotId,
                        coherent: true,
                        quoteComplete: true,
                        quoteAsOf: asOf,
                        underlyingQuoteAsOf: asOf,
                    },
                };
                const result = core.computeImpliedWeekendLambdas(buildRows(), '2026-07-17', opts);
                const weekend = result.intervals.find((row) => row.endExpiry === '20260727');
                assert.equal(weekend.status, 'ok');
                assert.ok(Math.abs(weekend.lambda - lambdaTrue) < 1e-3);
                const diagnostic = result.rowDiagnostics.find((row) => row.expiry === '20260724');
                assert.ok(Math.abs(diagnostic.parityForward - 7538) < 1e-6);

                const mismatch = core.computeImpliedWeekendLambdas(buildRows(2), '2026-07-17', opts);
                assert.equal(
                    mismatch.rowDiagnostics.find((row) => row.expiry === '20260722').status,
                    'forward_mismatch'
                );
            },
        },
        {
            name: 'straddle route enforces mid-market marks, coherent snapshots, and complete inputs',
            run() {
                const ctx = loadBrowserScripts(['js/iv_term_structure_core.js']);
                const core = ctx.OptionComboIvTermStructureCore;
                const pctx = require('./helpers/load-browser-scripts').loadPricingContext();
                const lambdaTrue = 0.2;
                const dailyVar = 8e-5;
                const future = 7530;
                const snapshotId = 'coherent-surface-1';
                const snapshotMetadata = {
                    snapshotId,
                    underlyingSnapshotId: snapshotId,
                    coherent: true,
                    quoteComplete: true,
                    quoteAsOf: '2026-07-17T20:00:00Z',
                    underlyingQuoteAsOf: '2026-07-17T20:00:00Z',
                };
                const makeRow = (expiry, dte, trad, overrides = {}) => {
                    const totalVar = dailyVar * (trad + lambdaTrue * (dte - trad));
                    const sigma = Math.sqrt(totalVar / (dte / 365));
                    const callMark = pctx.calculateBlack76Price('call', future, 7527.5, dte / 365, 0.04, sigma);
                    const putMark = pctx.calculateBlack76Price('put', future, 7527.5, dte / 365, 0.04, sigma);
                    return {
                        expiry,
                        dte,
                        atmStrike: 7527.5,
                        callMark,
                        putMark,
                        callBid: callMark * 0.995,
                        callAsk: callMark * 1.005,
                        putBid: putMark * 0.995,
                        putAsk: putMark * 1.005,
                        callMarkSource: 'bid_ask_mid',
                        putMarkSource: 'bid_ask_mid',
                        callQuoteAsOf: '2026-07-17T20:00:00Z',
                        putQuoteAsOf: '2026-07-17T20:00:00Z',
                        callSnapshotId: snapshotId,
                        putSnapshotId: snapshotId,
                        ...overrides,
                    };
                };
                const baseRows = () => [
                    makeRow('20260720', 3, 1),
                    makeRow('20260721', 4, 2),
                    makeRow('20260722', 5, 3),
                    makeRow('20260723', 6, 4),
                    makeRow('20260724', 7, 5),
                    makeRow('20260727', 10, 6),
                    makeRow('20260728', 11, 7),
                ];
                const opts = {
                    underlyingPrice: future,
                    pricingModel: 'black76',
                    interestRate: 0.04,
                    snapshotMetadata,
                    frontIntervalVerified: true,
                };

                // TWS model-price fallback must be rejected: poison the front
                // row and the front interval shifts to the next expiry.
                const modelRows = baseRows();
                modelRows[0].putMarkSource = 'model';
                const modelResult = core.computeImpliedWeekendLambdas(modelRows, '2026-07-17', opts);
                const modelFront = modelResult.intervals.find((interval) => interval.isFront);
                assert.equal(modelFront.endExpiry, '20260721');
                // Missing markSource (older backend) is equally ineligible.
                const unsourcedRows = baseRows().map((row) => ({
                    ...row, callMarkSource: '', putMarkSource: '',
                }));
                assert.equal(
                    core.computeImpliedWeekendLambdas(unsourcedRows, '2026-07-17', opts).intervals.length,
                    0
                );

                // Call and put quoted minutes apart is not one snapshot.
                const skewRows = baseRows();
                skewRows[0].putQuoteAsOf = '2026-07-17T20:06:00Z';
                const skewResult = core.computeImpliedWeekendLambdas(skewRows, '2026-07-17', opts);
                assert.equal(
                    skewResult.intervals.find((interval) => interval.isFront).endExpiry,
                    '20260721'
                );

                // An expiry quoted 10 minutes after its neighbors poisons the
                // intervals that straddle it: the weekend one is flagged.
                const staleRows = baseRows().map((row) => (
                    row.expiry === '20260727'
                        ? { ...row, callQuoteAsOf: '2026-07-17T20:10:00Z', putQuoteAsOf: '2026-07-17T20:10:00Z' }
                        : row
                ));
                const staleResult = core.computeImpliedWeekendLambdas(staleRows, '2026-07-17', opts);
                assert.equal(
                    staleResult.rowDiagnostics.find((row) => row.expiry === '20260727').status,
                    'underlying_stale_mix'
                );
                assert.equal(staleResult.quality.status, 'underlying_stale_mix');
                assert.equal(staleResult.quality.coherent, false);
                assert.ok(!('2026-07-25' in staleResult.byDate));
                // Uniformly-timed off-hours snapshots stay fully usable.
                const okResult = core.computeImpliedWeekendLambdas(baseRows(), '2026-07-17', opts);
                assert.equal(okResult.intervals.find((interval) => interval.endExpiry === '20260727').status, 'ok');

                // Structural requirements: strike and underlying price.
                const noStrikeRows = baseRows().map((row) => ({ ...row, atmStrike: null }));
                assert.equal(
                    core.computeImpliedWeekendLambdas(noStrikeRows, '2026-07-17', opts).intervals.length,
                    0
                );
                assert.equal(
                    core.computeImpliedWeekendLambdas(baseRows(), '2026-07-17', { pricingModel: 'black76' }).intervals.length,
                    0
                );

                // Coherence is server evidence, not a timestamp heuristic.
                const noMetadata = core.computeImpliedWeekendLambdas(baseRows(), '2026-07-17', {
                    underlyingPrice: future,
                    pricingModel: 'black76',
                    interestRate: 0.04,
                });
                assert.equal(noMetadata.quality.status, 'missing_snapshot_metadata');
                assert.equal(noMetadata.intervals.length, 0);

                const mixedRows = baseRows();
                mixedRows[2].putSnapshotId = 'another-snapshot';
                const mixed = core.computeImpliedWeekendLambdas(mixedRows, '2026-07-17', opts);
                assert.equal(
                    mixed.rowDiagnostics.find((row) => row.expiry === '20260722').status,
                    'mixed_snapshot'
                );
                assert.equal(mixed.quality.status, 'mixed_snapshot');
                assert.equal(Object.keys(mixed.byDate).length, 0);

                const wideRows = baseRows();
                wideRows[1].callBid = wideRows[1].callMark * 0.5;
                wideRows[1].callAsk = wideRows[1].callMark * 1.5;
                const wide = core.computeImpliedWeekendLambdas(wideRows, '2026-07-17', opts);
                assert.equal(
                    wide.rowDiagnostics.find((row) => row.expiry === '20260721').status,
                    'wide_market'
                );

                const crossedRows = baseRows();
                crossedRows[1].putBid = crossedRows[1].putMark * 1.01;
                crossedRows[1].putAsk = crossedRows[1].putMark * 0.99;
                const crossed = core.computeImpliedWeekendLambdas(crossedRows, '2026-07-17', opts);
                assert.equal(
                    crossed.rowDiagnostics.find((row) => row.expiry === '20260721').status,
                    'crossed_market'
                );

                const badUnderlyingSnapshot = core.computeImpliedWeekendLambdas(
                    baseRows(),
                    '2026-07-17',
                    {
                        ...opts,
                        snapshotMetadata: { ...snapshotMetadata, underlyingSnapshotId: 'old-underlying' },
                    }
                );
                assert.equal(badUnderlyingSnapshot.quality.status, 'underlying_snapshot_mismatch');
            },
        },
    ],
};
