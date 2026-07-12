const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function snapshot(fetchedAt = new Date().toISOString()) {
    return {
        calendars: {
            NYSE: {
                calendarKey: 'NYSE', fetchedAt,
                coverageStart: '2026-01-01', coverageEnd: '2028-12-31',
                closures: [{ date: '2026-07-03', status: 'closed' }],
                earlyCloses: [{ date: '2026-11-27', status: 'early_close' }],
            },
            'CME:ES': {
                calendarKey: 'CME:ES', fetchedAt,
                sourceKind: 'cme_reference_data_api',
                derivationVersion: 'business-trade-date-gaps-v2',
                coverageStart: '2025-07-09', coverageEnd: '2028-05-05',
                closures: [{ date: '2026-07-03', status: 'closed' }],
                earlyCloses: [],
            },
        },
    };
}

function loadCalendar(customSnapshot = snapshot(), withDateUtils = false) {
    return loadBrowserScripts([
        'js/market_holidays.js',
        ...(withDateUtils ? ['js/date_utils.js'] : []),
    ], { OptionComboOfficialExchangeCalendars: customSnapshot });
}

module.exports = {
    name: 'market_holidays.js',
    tests: [
        {
            name: 'uses official closure and early-close records only',
            run() {
                const ctx = loadCalendar();
                assert.equal(ctx.isMarketHoliday('2026-07-03', 'NYSE'), true);
                assert.equal(ctx.isMarketHoliday('2026-07-02', 'NYSE'), false);
                assert.equal(ctx.getOfficialExchangeCalendarDay('NYSE', '2026-11-27').status, 'early_close');
                assert.equal(ctx.isMarketHoliday('2026-07-03', 'CME:ES'), true);
            },
        },
        {
            name: 'returns unknown instead of applying rules outside official coverage',
            run() {
                const ctx = loadCalendar();
                assert.equal(ctx.isMarketHoliday('2025-01-09', 'NYSE'), null);
                assert.equal(ctx.isMarketHoliday('2029-01-01', 'NYSE'), null);
                assert.equal(ctx.getOfficialExchangeCalendarDay('NYSE', '2025-01-09').status, 'unavailable');
            },
        },
        {
            name: 'rejects stale snapshots and legacy CME derivations',
            run() {
                const stale = snapshot('2020-01-01T00:00:00Z');
                const staleCtx = loadCalendar(stale);
                assert.equal(staleCtx.isOfficialExchangeCalendarAvailable('NYSE', '2026-01-01'), false);

                const legacy = snapshot();
                legacy.calendars['CME:ES'].derivationVersion = 'legacy';
                const legacyCtx = loadCalendar(legacy);
                assert.equal(legacyCtx.isOfficialExchangeCalendarAvailable('CME:ES', '2026-07-01'), false);
            },
        },
        {
            name: 'date helpers carry product calendar keys and fail closed when unavailable',
            run() {
                const ctx = loadCalendar(snapshot(), true);
                assert.equal(ctx.OptionComboDateUtils.calendarToTradingDays(
                    '2026-07-02', '2026-07-07', 'NYSE'
                ), 2);
                assert.equal(ctx.OptionComboDateUtils.calendarToTradingDays(
                    '2026-07-02', '2026-07-07', 'CME:ES'
                ), 2);
                assert.equal(ctx.OptionComboDateUtils.calendarToTradingDays(
                    '2025-01-02', '2025-01-04', 'NYSE'
                ), null);
            },
        },
        {
            name: 'historical observed sessions override unavailable forward coverage without rules',
            run() {
                const ctx = loadCalendar(snapshot(), true);
                const observed = ['2018-12-03', '2018-12-04', '2018-12-06', '2018-12-07'];
                assert.equal(ctx.OptionComboDateUtils.calendarToTradingDays(
                    '2018-12-03', '2018-12-07', 'NYSE', observed
                ), 3);
                assert.deepEqual(
                    Array.from(ctx.OptionComboDateUtils.listTradingDays(
                        '2018-12-03', '2018-12-07', 'NYSE', observed
                    )),
                    observed
                );
                assert.equal(ctx.OptionComboDateUtils.calendarToTradingDays(
                    '2018-12-03', '2018-12-10', 'NYSE', observed
                ), null);
            },
        },
    ],
};
