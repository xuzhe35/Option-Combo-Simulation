/**
 * Official exchange-calendar runtime.
 *
 * This module intentionally contains no holiday rules. Forward/current dates
 * come only from js/official_exchange_calendars.generated.js. Historical
 * replay can supply an explicit list of observed exchange sessions through
 * OptionComboDateUtils; missing official coverage is never guessed here.
 */

'use strict';

const OFFICIAL_CALENDAR_MAX_AGE_DAYS = 14;
const CME_CALENDAR_DERIVATION_VERSION = 'business-trade-date-gaps-v2';

function _officialCalendar(calendarKey) {
    const snapshot = typeof globalThis.OptionComboOfficialExchangeCalendars === 'object'
        ? globalThis.OptionComboOfficialExchangeCalendars
        : null;
    const calendars = snapshot && snapshot.calendars && typeof snapshot.calendars === 'object'
        ? snapshot.calendars
        : {};
    return calendars[String(calendarKey || 'NYSE').toUpperCase()] || null;
}

function _officialDateKey(value) {
    const compact = String(value || '').slice(0, 10).replace(/[-/]/g, '');
    return /^\d{8}$/.test(compact)
        ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
        : '';
}

function _officialCalendarIsFresh(calendar) {
    const fetchedAt = new Date(calendar && calendar.fetchedAt || '');
    return !Number.isNaN(fetchedAt.getTime())
        && Date.now() - fetchedAt.getTime() <= OFFICIAL_CALENDAR_MAX_AGE_DAYS * 86400000;
}

function isOfficialExchangeCalendarAvailable(calendarKey, startDate, endDate) {
    const calendar = _officialCalendar(calendarKey);
    if (!calendar || !calendar.coverageStart || !calendar.coverageEnd
        || !_officialCalendarIsFresh(calendar)) {
        return false;
    }
    if (calendar.sourceKind === 'cme_reference_data_api'
        && calendar.derivationVersion !== CME_CALENDAR_DERIVATION_VERSION) {
        return false;
    }
    const start = _officialDateKey(startDate);
    const end = _officialDateKey(endDate || startDate);
    return !!start && !!end
        && start >= calendar.coverageStart
        && end <= calendar.coverageEnd;
}

function getOfficialExchangeCalendarDay(calendarKey, dateStr) {
    const calendar = _officialCalendar(calendarKey);
    const key = _officialDateKey(dateStr);
    if (!calendar || !key || !isOfficialExchangeCalendarAvailable(calendarKey, key, key)) {
        return {
            available: false,
            status: 'unavailable',
            calendarKey: String(calendarKey || 'NYSE').toUpperCase(),
        };
    }
    const closure = (calendar.closures || []).find((item) => item && item.date === key);
    const earlyClose = (calendar.earlyCloses || []).find((item) => item && item.date === key);
    return {
        available: true,
        status: closure ? 'closed' : (earlyClose ? 'early_close' : 'open'),
        calendarKey: calendar.calendarKey || String(calendarKey || 'NYSE').toUpperCase(),
        detail: closure || earlyClose || null,
        sourceUrl: calendar.sourceUrl || '',
        fetchedAt: calendar.fetchedAt || '',
    };
}

/**
 * Return true/false only when the official snapshot covers the date.
 * Return null when unavailable so callers cannot silently treat an unknown
 * weekday as open.
 */
function isMarketHoliday(dateStr, calendarKey = 'NYSE') {
    const official = getOfficialExchangeCalendarDay(calendarKey, dateStr);
    return official.available ? official.status === 'closed' : null;
}
