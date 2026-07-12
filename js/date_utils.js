/**
 * Pure date helpers shared across pricing and UI code.
 */

(function attachDateUtils(globalScope) {
    function normalizeDateInput(dateStr) {
        return String(dateStr).replace(/\//g, '-');
    }

    function _calendarKey(value) {
        return String(value || 'NYSE').trim().toUpperCase() || 'NYSE';
    }

    function _observedTradingDateSet(observedTradingDates) {
        if (observedTradingDates instanceof Set) {
            if (!observedTradingDates._coverageStart || !observedTradingDates._coverageEnd) {
                const ordered = Array.from(observedTradingDates).sort();
                observedTradingDates._coverageStart = ordered[0] || '';
                observedTradingDates._coverageEnd = ordered[ordered.length - 1] || '';
            }
            return observedTradingDates;
        }
        if (!Array.isArray(observedTradingDates)) return null;
        const ordered = observedTradingDates.map(normalizeDateInput).sort();
        const observed = new Set(ordered);
        observed._coverageStart = ordered[0] || '';
        observed._coverageEnd = ordered[ordered.length - 1] || '';
        return observed;
    }

    function _observedCovers(observed, startKey, endKey) {
        return !observed || (!!observed._coverageStart && !!observed._coverageEnd
            && startKey >= observed._coverageStart
            && endKey <= observed._coverageEnd);
    }

    function isTradingDay(dateStr, calendarKey = 'NYSE', observedTradingDates = null) {
        const date = new Date(normalizeDateInput(dateStr) + 'T00:00:00Z');
        if (Number.isNaN(date.getTime())) {
            return null;
        }

        const dayOfWeek = date.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return false;
        }

        const dateKey = date.toISOString().slice(0, 10);
        const observed = _observedTradingDateSet(observedTradingDates);
        if (observed) {
            return observed.has(dateKey);
        }
        if (typeof globalScope.isMarketHoliday !== 'function') {
            return null;
        }
        const holiday = globalScope.isMarketHoliday(dateKey, _calendarKey(calendarKey));
        return holiday === null ? null : !holiday;
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

    function calendarToTradingDays(startDateStr, endDateStr, calendarKey = 'NYSE', observedTradingDates = null) {
        let start = new Date(normalizeDateInput(startDateStr) + 'T00:00:00Z');
        let end = new Date(normalizeDateInput(endDateStr) + 'T00:00:00Z');
        if (start > end) return 0;

        let days = 0;
        let current = new Date(start);
        const observed = _observedTradingDateSet(observedTradingDates);
        if (current < end) {
            const lastIncluded = new Date(end);
            lastIncluded.setUTCDate(lastIncluded.getUTCDate() - 1);
            if (!_observedCovers(
                observed,
                current.toISOString().slice(0, 10),
                lastIncluded.toISOString().slice(0, 10)
            )) return null;
        }
        while (current < end) {
            const tradingDay = isTradingDay(
                current.toISOString().slice(0, 10), calendarKey, observed
            );
            if (tradingDay === null) return null;
            if (tradingDay) {
                days++;
            }
            current.setUTCDate(current.getUTCDate() + 1);
        }
        return days;
    }

    // Weighted day count for the simulation clock: trading days count as 1,
    // weekends/holidays count as weekendWeight (0 = pure trading clock,
    // 1 = pure calendar clock). Same [start, end) convention as
    // calendarToTradingDays so the two agree at the extremes.
    function countWeightedDays(startDateStr, endDateStr, weekendWeight, calendarKey = 'NYSE', observedTradingDates = null) {
        const start = new Date(normalizeDateInput(startDateStr) + 'T00:00:00Z');
        const end = new Date(normalizeDateInput(endDateStr) + 'T00:00:00Z');
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
            return 0;
        }
        const parsedWeight = parseFloat(weekendWeight);
        const nonTradingWeight = Number.isFinite(parsedWeight)
            ? Math.min(1, Math.max(0, parsedWeight))
            : 1;

        let weighted = 0;
        const current = new Date(start);
        const observed = _observedTradingDateSet(observedTradingDates);
        if (current < end) {
            const lastIncluded = new Date(end);
            lastIncluded.setUTCDate(lastIncluded.getUTCDate() - 1);
            if (!_observedCovers(
                observed,
                current.toISOString().slice(0, 10),
                lastIncluded.toISOString().slice(0, 10)
            )) return null;
        }
        while (current < end) {
            const tradingDay = isTradingDay(
                current.toISOString().slice(0, 10), calendarKey, observed
            );
            if (tradingDay === null) return null;
            weighted += tradingDay ? 1 : nonTradingWeight;
            current.setUTCDate(current.getUTCDate() + 1);
        }
        return weighted;
    }

    function listTradingDays(startDateStr, endDateStr, calendarKey = 'NYSE', observedTradingDates = null) {
        const start = new Date(normalizeDateInput(startDateStr) + 'T00:00:00Z');
        const end = new Date(normalizeDateInput(endDateStr) + 'T00:00:00Z');
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
            return [];
        }

        const dates = [];
        const current = new Date(start);
        const observed = _observedTradingDateSet(observedTradingDates);
        if (!_observedCovers(
            observed,
            current.toISOString().slice(0, 10),
            end.toISOString().slice(0, 10)
        )) return [];
        while (current <= end) {
            const dateKey = current.toISOString().slice(0, 10);
            const tradingDay = isTradingDay(dateKey, calendarKey, observed);
            if (tradingDay === null) return [];
            if (tradingDay) {
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
        countWeightedDays,
        listTradingDays,
    };

    globalScope.OptionComboDateUtils = api;
    Object.assign(globalScope, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
