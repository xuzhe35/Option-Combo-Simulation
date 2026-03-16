/**
 * NYSE Market Holidays — Rule-Based Engine
 * ==========================================
 * Dynamically computes US market holidays for any year using official NYSE rules.
 * No static data to maintain; works indefinitely without annual regeneration.
 *
 * Holiday rules (9 observed holidays):
 *   1. New Year's Day           — Jan 1
 *   2. Martin Luther King Day   — 3rd Monday of January
 *   3. Presidents' Day          — 3rd Monday of February
 *   4. Good Friday              — Friday before Easter Sunday (Anonymous Gregorian algorithm)
 *   5. Memorial Day             — Last Monday of May
 *   6. Juneteenth               — June 19
 *   7. Independence Day         — July 4
 *   8. Labor Day                — 1st Monday of September
 *   9. Thanksgiving Day         — 4th Thursday of November
 *  10. Christmas Day            — Dec 25
 *
 * Weekend observance rules:
 *   - If a fixed-date holiday falls on Saturday → observed on Friday
 *   - If a fixed-date holiday falls on Sunday  → observed on Monday
 *
 * References:
 *   https://www.nyse.com/markets/hours-calendars
 */

'use strict';

/**
 * Compute Easter Sunday for a given year using the Anonymous Gregorian algorithm.
 * Returns a Date object in UTC.
 */
function _easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Format a UTC Date to 'YYYY-MM-DD' string.
 */
function _fmtDate(d) {
    return d.toISOString().slice(0, 10);
}

/**
 * Get the Nth occurrence of a given weekday in a month.
 * @param {number} year
 * @param {number} month - 0-indexed (0 = January)
 * @param {number} dayOfWeek - 0 = Sunday, 1 = Monday, ..., 6 = Saturday
 * @param {number} n - 1-indexed (1 = first, 2 = second, etc.)
 * @returns {Date}
 */
function _nthWeekday(year, month, dayOfWeek, n) {
    const first = new Date(Date.UTC(year, month, 1));
    let diff = (dayOfWeek - first.getUTCDay() + 7) % 7;
    const day = 1 + diff + (n - 1) * 7;
    return new Date(Date.UTC(year, month, day));
}

/**
 * Get the last occurrence of a given weekday in a month.
 */
function _lastWeekday(year, month, dayOfWeek) {
    const last = new Date(Date.UTC(year, month + 1, 0)); // last day of month
    let diff = (last.getUTCDay() - dayOfWeek + 7) % 7;
    return new Date(Date.UTC(year, month, last.getUTCDate() - diff));
}

/**
 * Apply the NYSE weekend observance rule to a fixed-date holiday:
 *   Saturday → observed on Friday, Sunday → observed on Monday.
 */
function _observe(date) {
    const dow = date.getUTCDay();
    if (dow === 6) { // Saturday → Friday
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1));
    }
    if (dow === 0) { // Sunday → Monday
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
    }
    return date;
}

/**
 * Compute all NYSE market holidays for a given year.
 * @param {number} year
 * @returns {string[]} Array of 'YYYY-MM-DD' date strings
 */
function _computeHolidaysForYear(year) {
    const holidays = [];

    // 1. New Year's Day — Jan 1
    holidays.push(_observe(new Date(Date.UTC(year, 0, 1))));

    // 2. Martin Luther King Jr. Day — 3rd Monday of January
    holidays.push(_nthWeekday(year, 0, 1, 3));

    // 3. Presidents' Day — 3rd Monday of February
    holidays.push(_nthWeekday(year, 1, 1, 3));

    // 4. Good Friday — 2 days before Easter Sunday
    const easter = _easterSunday(year);
    holidays.push(new Date(Date.UTC(year, easter.getUTCMonth(), easter.getUTCDate() - 2)));

    // 5. Memorial Day — Last Monday of May
    holidays.push(_lastWeekday(year, 4, 1));

    // 6. Juneteenth — June 19
    holidays.push(_observe(new Date(Date.UTC(year, 5, 19))));

    // 7. Independence Day — July 4
    holidays.push(_observe(new Date(Date.UTC(year, 6, 4))));

    // 8. Labor Day — 1st Monday of September
    holidays.push(_nthWeekday(year, 8, 1, 1));

    // 9. Thanksgiving Day — 4th Thursday of November
    holidays.push(_nthWeekday(year, 10, 4, 4));

    // 10. Christmas Day — Dec 25
    holidays.push(_observe(new Date(Date.UTC(year, 11, 25))));

    return holidays.map(_fmtDate);
}

// Internal cache: year → Set of date strings
const _holidayCache = {};

/**
 * Get the Set of holiday date strings for a given year (cached).
 */
function _getHolidaysForYear(year) {
    if (!_holidayCache[year]) {
        _holidayCache[year] = new Set(_computeHolidaysForYear(year));
    }
    return _holidayCache[year];
}

/**
 * Check if a date string 'YYYY-MM-DD' is a NYSE market holiday.
 * This is the public API used by calendarToTradingDays() in bsm.js.
 */
function isMarketHoliday(dateStr) {
    const year = parseInt(dateStr.slice(0, 4), 10);
    return _getHolidaysForYear(year).has(dateStr);
}
