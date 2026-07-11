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

                ctx.isMarketHoliday = (dateKey) => dateKey === '2026-07-09';
                assert.equal(core.countTradingDays('2026-07-08', '20260710'), 1);
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
