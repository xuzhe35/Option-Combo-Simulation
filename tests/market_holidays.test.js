const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'market_holidays.js',
    tests: [
        {
            name: 'computes Easter Sunday and Good Friday for 2026 correctly',
            run() {
                const ctx = loadBrowserScripts(['market_holidays.js']);

                assert.equal(ctx._fmtDate(ctx._easterSunday(2026)), '2026-04-05');
                assert.equal(ctx.isMarketHoliday('2026-04-03'), true);
                assert.equal(ctx.isMarketHoliday('2026-04-02'), false);
            },
        },
        {
            name: 'applies NYSE weekend observance rules for fixed-date holidays',
            run() {
                const ctx = loadBrowserScripts(['market_holidays.js']);

                assert.equal(
                    ctx._fmtDate(ctx._observe(new Date(Date.UTC(2021, 11, 25)))),
                    '2021-12-24'
                );
                assert.equal(
                    ctx._fmtDate(ctx._observe(new Date(Date.UTC(2023, 0, 1)))),
                    '2023-01-02'
                );
            },
        },
        {
            name: 'computes nth and last weekday helpers in UTC',
            run() {
                const ctx = loadBrowserScripts(['market_holidays.js']);

                assert.equal(
                    ctx._fmtDate(ctx._nthWeekday(2026, 0, 1, 3)),
                    '2026-01-19'
                );
                assert.equal(
                    ctx._fmtDate(ctx._lastWeekday(2026, 4, 1)),
                    '2026-05-25'
                );
            },
        },
        {
            name: 'marks known NYSE holidays and excludes nearby trading days',
            run() {
                const ctx = loadBrowserScripts(['market_holidays.js']);
                const holidays2026 = ctx._computeHolidaysForYear(2026);

                assert.equal(holidays2026.length, 10);
                assert.ok(holidays2026.includes('2026-07-03'));
                assert.ok(holidays2026.includes('2026-11-26'));
                assert.equal(ctx.isMarketHoliday('2026-11-26'), true);
                assert.equal(ctx.isMarketHoliday('2026-11-27'), false);
            },
        },
        {
            name: 'caches holiday sets by year',
            run() {
                const ctx = loadBrowserScripts(['market_holidays.js']);
                const first = ctx._getHolidaysForYear(2026);
                const second = ctx._getHolidaysForYear(2026);

                assert.equal(first, second);
            },
        },
    ],
};
