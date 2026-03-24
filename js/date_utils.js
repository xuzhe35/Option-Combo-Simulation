/**
 * Pure date helpers shared across pricing and UI code.
 */

(function attachDateUtils(globalScope) {
    function normalizeDateInput(dateStr) {
        return String(dateStr).replace(/\//g, '-');
    }

    function isTradingDay(dateStr) {
        const date = new Date(normalizeDateInput(dateStr) + 'T00:00:00Z');
        if (Number.isNaN(date.getTime())) {
            return false;
        }

        const dayOfWeek = date.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return false;
        }

        const dateKey = date.toISOString().slice(0, 10);
        return typeof globalScope.isMarketHoliday !== 'function' || !globalScope.isMarketHoliday(dateKey);
    }

    function diffDays(d1Str, d2Str) {
        const d1 = new Date(normalizeDateInput(d1Str) + 'T00:00:00Z');
        const d2 = new Date(normalizeDateInput(d2Str) + 'T00:00:00Z');
        const rounded = Math.round((d2 - d1) / 86400000);
        return Math.max(0, rounded);
    }

    function addDays(dateStr, days) {
        const d = new Date(normalizeDateInput(dateStr) + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + parseInt(days, 10));
        return d.toISOString().slice(0, 10);
    }

    function calendarToTradingDays(startDateStr, endDateStr) {
        let start = new Date(normalizeDateInput(startDateStr) + 'T00:00:00Z');
        let end = new Date(normalizeDateInput(endDateStr) + 'T00:00:00Z');
        if (start > end) return 0;

        let days = 0;
        let current = new Date(start);
        while (current < end) {
            if (isTradingDay(current.toISOString().slice(0, 10))) {
                days++;
            }
            current.setUTCDate(current.getUTCDate() + 1);
        }
        return days;
    }

    function listTradingDays(startDateStr, endDateStr) {
        const start = new Date(normalizeDateInput(startDateStr) + 'T00:00:00Z');
        const end = new Date(normalizeDateInput(endDateStr) + 'T00:00:00Z');
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
            return [];
        }

        const dates = [];
        const current = new Date(start);
        while (current <= end) {
            const dateKey = current.toISOString().slice(0, 10);
            if (isTradingDay(dateKey)) {
                dates.push(dateKey);
            }
            current.setUTCDate(current.getUTCDate() + 1);
        }
        return dates;
    }

    const api = {
        normalizeDateInput,
        isTradingDay,
        diffDays,
        addDays,
        calendarToTradingDays,
        listTradingDays,
    };

    globalScope.OptionComboDateUtils = api;
    Object.assign(globalScope, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
