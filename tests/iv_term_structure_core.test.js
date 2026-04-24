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
                assert.equal(rows[1].atmIv, 0.26);
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
            },
        },
        {
            name: 'maps detail rows into nearest bucket rows and leaves unmatched buckets empty',
            run() {
                const ctx = loadBrowserScripts([
                    'js/iv_term_structure_core.js',
                ]);

                const detailRows = [
                    { expiry: '20260424', dte: 1, atmStrike: 500, atmIv: 0.20 },
                    { expiry: '20260428', dte: 5, atmStrike: 501, atmIv: 0.205 },
                    { expiry: '20260502', dte: 9, atmStrike: 502, atmIv: 0.21 },
                    { expiry: '20260516', dte: 23, atmStrike: 503, atmIv: 0.215 },
                    { expiry: '20260526', dte: 33, atmStrike: 504, atmIv: 0.22 },
                    { expiry: '20260723', dte: 91, atmStrike: 510, atmIv: 0.24 },
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
            },
        },
    ],
};
