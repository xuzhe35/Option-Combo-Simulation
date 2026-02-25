/**
 * NYSE Market Holidays
 * 
 * Regenerate annually:
 *   python scripts/gen_holidays.py <year> [year2 ...]
 * 
 * Sources:
 *   https://www.nyse.com/markets/hours-calendars
 */
const MARKET_HOLIDAYS = new Set([
    // 2026
    '2026-01-01', // New Year's Day (Thu)
    '2026-01-19', // Martin Luther King Jr. Day (Mon)
    '2026-02-16', // Presidents' Day (Mon)
    '2026-04-03', // Good Friday (Fri)
    '2026-05-25', // Memorial Day (Mon)
    '2026-06-19', // Juneteenth (Fri)
    '2026-07-03', // Independence Day (Fri)
    '2026-09-07', // Labor Day (Mon)
    '2026-11-26', // Thanksgiving Day (Thu)
    '2026-12-25', // Christmas Day (Fri)
    // 2027
    '2027-01-01', // New Year's Day (Fri)
    '2027-01-18', // Martin Luther King Jr. Day (Mon)
    '2027-02-15', // Presidents' Day (Mon)
    '2027-03-26', // Good Friday (Fri)
    '2027-05-31', // Memorial Day (Mon)
    '2027-06-18', // Juneteenth (Fri)
    '2027-07-05', // Independence Day (Mon)
    '2027-09-06', // Labor Day (Mon)
    '2027-11-25', // Thanksgiving Day (Thu)
    '2027-12-24', // Christmas Day (Fri)
]);
