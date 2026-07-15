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
                        spy_call_1d: { iv: 0.21, mark: 5.1 },
                        spy_put_1d: { iv: 0.25, mark: 4.8 },
                        spy_call_3w: { iv: 0.24, mark: 7.2 },
                        spy_put_3w: { iv: 0.28, mark: 6.9 },
                    }
                );

                assert.equal(rows.length, 2);
                assert.equal(rows[0].expiry, '20260424');
                assert.equal(rows[0].dte, 1);
                assert.equal(rows[0].atmStrike, 500);
                assert.equal(rows[0].callIv, 0.21);
                assert.equal(rows[0].putIv, 0.25);
                assert.equal(rows[0].atmIv, 0.23);
                assert.equal(rows[0].callMark, 5.1);
                assert.equal(rows[0].putMark, 4.8);
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
            name: 'counts trading days on a weekday clock with an optional holiday hook',
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
            name: 'computes the displacement watermark from history samples with scaling and a minimum count',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);
                const core = ctx.OptionComboIvTermStructureCore;

                const sample = (quoteDate, price, em) => ({
                    quoteDate, underlyingPrice: price,
                    details: [{ dte: 7, atmStraddleMark: em }],
                });

                // 9 weekly samples, each week the underlying moves exactly one
                // scaled EM -> every ratio = 1.0.
                const samples = [];
                let price = 500;
                const dates = ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23', '2026-01-30',
                               '2026-02-06', '2026-02-13', '2026-02-20', '2026-02-27'];
                for (const d of dates) {
                    samples.push(sample(d, price, 5));
                    price += 5 * Math.sqrt(7 / 7); // gap 7d, frontDte 7 -> scale 1
                }
                const wm = core.computeDisplacementWatermark(samples);
                assert.equal(wm.status, 'ok');
                assert.equal(wm.count, 8);
                assert.ok(Math.abs(wm.mean - 1) < 1e-9);

                // Fewer than 8 usable pairs -> collecting.
                const collecting = core.computeDisplacementWatermark(samples.slice(0, 5));
                assert.equal(collecting.status, 'collecting');
                assert.equal(collecting.count, 4);

                // Same-day duplicate samples dedupe (last wins); >12d gaps skipped.
                const noisy = [
                    sample('2026-03-02', 500, 5),
                    sample('2026-03-02', 501, 5),
                    sample('2026-03-30', 520, 5), // 28d gap -> skipped
                ];
                const skipped = core.computeDisplacementWatermark(noisy);
                assert.equal(skipped.count, 0);

                // Time scaling: 3-day gap against a 7-DTE EM shrinks the
                // expected move by sqrt(3/7).
                const scaled = core.computeDisplacementWatermark([
                    sample('2026-04-06', 500, 7),
                    sample('2026-04-09', 500 + 7 * Math.sqrt(3 / 7), 7),
                ]);
                assert.equal(scaled.status, 'collecting');
                assert.ok(Math.abs(scaled.latest - 1) < 1e-4);
            },
        },
        {
            name: 'resolves the daily watermark sample on sampledAt, not on array position',
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

                // How a merged history actually arrives: the manual file
                // concatenated ahead of the hourly automatic file, so source
                // order and chronological order disagree. The 15:55 manual
                // close sample must beat the 13:00 automatic one on both days.
                const manual = [
                    stamped('2026-05-04', '2026-05-04T19:55:00Z', 500),
                    stamped('2026-05-11', '2026-05-11T19:55:00Z', 505),
                ];
                const automatic = [
                    stamped('2026-05-04', '2026-05-04T17:00:00Z', 400),
                    stamped('2026-05-11', '2026-05-11T17:00:00Z', 400),
                ];
                const merged = core.computeDisplacementWatermark(manual.concat(automatic));
                // |505 - 500| / 5 = 1.0. Had the trailing automatic samples
                // won, both days would read 400 and the ratio would be 0.
                assert.equal(merged.count, 1);
                assert.ok(Math.abs(merged.latest - 1) < 1e-9);

                // Sorted input must agree with concatenated input.
                const sorted = core.computeDisplacementWatermark(
                    manual.concat(automatic).sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt))
                );
                assert.deepEqual(sorted, merged);

                // Without timestamps there is nothing better than array order,
                // so the historical last-wins behaviour stays.
                const untimestamped = core.computeDisplacementWatermark([
                    { quoteDate: '2026-05-04', underlyingPrice: 500, details: [{ dte: 7, atmStraddleMark: 5 }] },
                    { quoteDate: '2026-05-11', underlyingPrice: 400, details: [{ dte: 7, atmStraddleMark: 5 }] },
                    { quoteDate: '2026-05-11', underlyingPrice: 505, details: [{ dte: 7, atmStraddleMark: 5 }] },
                ]);
                assert.ok(Math.abs(untimestamped.latest - 1) < 1e-9);
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
                    { expiry: '20260713', dte: 0, tradDte: 0, atmIv: 0.1721, hasCompletePair: true },
                    { expiry: '20260715', dte: 2, tradDte: 2, atmIv: 0.1375, hasCompletePair: true },
                    { expiry: '20260717', dte: 4, tradDte: 4, atmIv: 0.1337, hasCompletePair: true },
                    { expiry: '20260720', dte: 7, tradDte: 5, atmIv: 0.1150, hasCompletePair: true },
                    { expiry: '20260724', dte: 11, tradDte: 9, atmIv: 0.1100, hasCompletePair: false },
                ];

                const vs2d = core.annotateTdSlopeVsBaseline(rows, '20260715');
                const byExpiry = (annotated, expiry) => annotated.find((r) => r.expiry === expiry);
                // Baseline row itself carries no slope; 0 DTE cannot convert;
                // incomplete pairs are excluded.
                assert.equal(byExpiry(vs2d, '20260715').tdSlopeVsBaseline, null);
                assert.equal(byExpiry(vs2d, '20260713').tdSlopeVsBaseline, null);
                assert.equal(byExpiry(vs2d, '20260724').tdSlopeVsBaseline, null);
                // 2d IV above 4d IV -> that pair reads backwardation (>1).
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

                // The ~7d/~11d pair must agree with the regime signal's slope.
                const signal = core.computeRegimeSignal(rows.map((r) => ({
                    ...r, hasCompletePair: r.expiry !== '20260724' ? r.hasCompletePair : true,
                })));
                const vs7d = core.annotateTdSlopeVsBaseline(rows.map((r) => ({
                    ...r, hasCompletePair: r.expiry !== '20260724' ? r.hasCompletePair : true,
                })), '20260720');
                assert.equal(signal.status, 'ok');
                assert.equal(byExpiry(vs7d, '20260724').tdSlopeVsBaseline, signal.slope);

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
    ],
};
