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

    function _normalizeTimeZone(value) {
        const raw = String(value || '').trim();
        return {
            'US/Eastern': 'America/New_York',
            'US/Central': 'America/Chicago',
            EST: 'America/New_York',
            CST: 'America/Chicago',
        }[raw] || raw || 'America/New_York';
    }

    function _zonedTimestampParts(epochMs, timeZone) {
        if (!Number.isFinite(epochMs) || typeof Intl === 'undefined'
            || typeof Intl.DateTimeFormat !== 'function') {
            return null;
        }
        try {
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: _normalizeTimeZone(timeZone),
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hourCycle: 'h23',
            }).formatToParts(new Date(epochMs));
            const values = {};
            parts.forEach((part) => {
                if (part.type !== 'literal') values[part.type] = parseInt(part.value, 10);
            });
            if (![values.year, values.month, values.day, values.hour, values.minute, values.second]
                .every(Number.isFinite)) {
                return null;
            }
            return values;
        } catch (_) {
            return null;
        }
    }

    // Intl has no direct exchange-local timestamp constructor. Iteratively
    // correct a UTC guess until it formats as the requested local wall time.
    function zonedDateTimeToUtcMs(dateValue, hour, minute, timeZone) {
        const match = String(normalizeDateInput(dateValue) || '')
            .match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        const safeHour = Number.isFinite(parseInt(hour, 10))
            ? Math.min(23, Math.max(0, parseInt(hour, 10)))
            : 0;
        const safeMinute = Number.isFinite(parseInt(minute, 10))
            ? Math.min(59, Math.max(0, parseInt(minute, 10)))
            : 0;
        const desiredAsUtc = Date.UTC(
            parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10),
            safeHour, safeMinute, 0
        );
        let guess = desiredAsUtc;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const parts = _zonedTimestampParts(guess, timeZone);
            if (!parts) return null;
            const formattedAsUtc = Date.UTC(
                parts.year, parts.month - 1, parts.day,
                parts.hour, parts.minute, parts.second
            );
            const correction = desiredAsUtc - formattedAsUtc;
            guess += correction;
            if (Math.abs(correction) < 1000) break;
        }
        return Number.isFinite(guess) ? guess : null;
    }

    function resolveExpiryCutoffAsOf(contract, profile, dateOverride = null) {
        const source = contract && typeof contract === 'object' ? contract : {};
        const expiryDate = String(dateOverride || source.expDate || '').trim().replace(/\//g, '-');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return null;

        const explicit = String(source.expiryAsOf || '').trim();
        const explicitMs = Date.parse(explicit);
        if (!dateOverride && explicit && Number.isFinite(explicitMs)) {
            return {
                cutoffMs: explicitMs,
                cutoffAsOf: new Date(explicitMs).toISOString(),
                source: 'contract',
                timeZone: _normalizeTimeZone(
                    source.expiryTimeZone || profile && profile.optionExpiryTimeZone
                ),
            };
        }

        const timeZone = _normalizeTimeZone(
            source.expiryTimeZone || profile && profile.optionExpiryTimeZone
        );
        const rawHour = parseInt(
            source.expiryHour !== undefined ? source.expiryHour : profile && profile.optionExpiryHour,
            10
        );
        const rawMinute = parseInt(
            source.expiryMinute !== undefined ? source.expiryMinute : profile && profile.optionExpiryMinute,
            10
        );
        const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 16;
        const minute = Number.isFinite(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0;
        const cutoffMs = zonedDateTimeToUtcMs(expiryDate, hour, minute, timeZone);
        return Number.isFinite(cutoffMs) ? {
            cutoffMs,
            cutoffAsOf: new Date(cutoffMs).toISOString(),
            source: 'product-profile',
            timeZone,
        } : null;
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

    function _clampWeight(value, fallback) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
    }

    function _finiteStructuredWeight(value, fallback) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    // Canonical form of a weekend-weight setting. Accepts a scalar lambda or
    // {default, byDate: {'YYYY-MM-DD': lambda}} so individual weekends can
    // carry their own option-implied weight. The scalar/default remains a
    // user-entered conventional [0, 1] weight, while price-derived per-date
    // values stay signed: a negative value is the observable term-structure
    // inversion signal and must not be silently clipped away. minWeight
    // reports the smallest applicable weight; differsFromCalendar answers the
    // question callers actually ask — does the weighted clock differ from the
    // calendar clock. Because per-date weights are unclamped, divergence has
    // to be tracked in BOTH directions: an event-heavy weekend can carry a
    // price-derived weight above 1, which minWeight alone would never see.
    function normalizeWeekendWeightSpec(value) {
        if (value !== null && typeof value === 'object') {
            const defaultWeight = _clampWeight(value.default, 1);
            const byDate = {};
            let minWeight = defaultWeight;
            let differsFromCalendar = defaultWeight !== 1;
            const source = value.byDate && typeof value.byDate === 'object' ? value.byDate : {};
            for (const key of Object.keys(source)) {
                const iso = normalizeDateInput(key);
                const weight = _finiteStructuredWeight(source[key], null);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || weight === null) {
                    continue;
                }
                byDate[iso] = weight;
                if (weight < minWeight) {
                    minWeight = weight;
                }
                if (weight !== 1) {
                    differsFromCalendar = true;
                }
            }
            return {
                default: defaultWeight,
                byDate: Object.keys(byDate).length ? byDate : null,
                minWeight,
                differsFromCalendar,
                strictByDate: value.strictByDate === true,
                coverageStart: typeof value.coverageStart === 'string' ? value.coverageStart : null,
                coverageEnd: typeof value.coverageEnd === 'string' ? value.coverageEnd : null,
            };
        }
        const scalar = _clampWeight(value, 1);
        return {
            default: scalar,
            byDate: null,
            minWeight: scalar,
            differsFromCalendar: scalar !== 1,
            strictByDate: false,
            coverageStart: null,
            coverageEnd: null,
        };
    }

    function _zonedDateKey(epochMs, timeZone) {
        const parts = _zonedTimestampParts(epochMs, timeZone);
        return parts
            ? `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
            : '';
    }

    /**
     * Resolve an exact timestamp interval onto the same per-exchange-date
     * variance clock as countWeightedDays(). Each local civil date contributes
     * its covered UTC hours / 24, multiplied by 1 for a trading date or by the
     * scalar/byDate lambda for a weekend/full holiday. Dividing by a constant
     * 24 hours preserves ACT/365 exactly at lambda=1, including DST weekends.
     */
    function resolveWeightedTime(
        startAsOf,
        endAsOf,
        weekendWeight,
        calendarKey = 'NYSE',
        observedTradingDates = null,
        timeZone = 'America/New_York',
        tradeDateRolloverHour = null
    ) {
        const startMs = typeof startAsOf === 'number' ? startAsOf : Date.parse(String(startAsOf || ''));
        const endMs = typeof endAsOf === 'number' ? endAsOf : Date.parse(String(endAsOf || ''));
        const normalizedCalendarKey = _calendarKey(calendarKey);
        const normalizedTimeZone = _normalizeTimeZone(timeZone);
        const unavailable = (status) => ({
            available: false,
            status,
            calendarKey: normalizedCalendarKey,
            timeZone: normalizedTimeZone,
            calendarDays: null,
            effectiveDays: null,
            tradingDays: null,
            nonTradingDays: null,
            nonTradingDates: [],
            missingWeightDates: [],
            segments: [],
        });
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
            return unavailable('invalid_interval');
        }
        if (startMs === endMs) {
            return {
                ...unavailable('ok'),
                available: true,
                calendarDays: 0,
                effectiveDays: 0,
                tradingDays: 0,
                nonTradingDays: 0,
            };
        }

        const rolloverHour = Number.isFinite(parseInt(tradeDateRolloverHour, 10))
            ? Math.min(23, Math.max(0, parseInt(tradeDateRolloverHour, 10)))
            : null;
        const classificationDate = (epochMs) => {
            const civilDate = _zonedDateKey(epochMs, normalizedTimeZone);
            if (!civilDate || rolloverHour === null) return civilDate;
            const parts = _zonedTimestampParts(epochMs, normalizedTimeZone);
            return parts && parts.hour >= rolloverHour ? addDays(civilDate, 1) : civilDate;
        };
        const startDate = classificationDate(startMs);
        const lastDate = classificationDate(endMs - 1);
        if (!startDate || !lastDate) return unavailable('timezone_unavailable');
        const observed = _observedTradingDateSet(observedTradingDates);
        if (observed) {
            if (!_observedCovers(observed, startDate, lastDate)) {
                return unavailable('calendar_unavailable');
            }
        } else if (typeof globalScope.isOfficialExchangeCalendarAvailable !== 'function'
            || !globalScope.isOfficialExchangeCalendarAvailable(
                normalizedCalendarKey, startDate, lastDate
            )) {
            return unavailable('calendar_unavailable');
        }

        const weightSpec = normalizeWeekendWeightSpec(weekendWeight);
        const segments = [];
        const nonTradingDates = [];
        let effectiveDays = 0;
        let tradingDays = 0;
        let nonTradingDays = 0;
        let cursorMs = startMs;
        for (let guard = 0; cursorMs < endMs && guard < 4000; guard += 1) {
            const civilDate = _zonedDateKey(cursorMs, normalizedTimeZone);
            const date = classificationDate(cursorMs);
            if (!date || !civilDate) return unavailable('timezone_unavailable');
            let nextBoundaryMs;
            if (rolloverHour === null) {
                nextBoundaryMs = zonedDateTimeToUtcMs(
                    addDays(civilDate, 1), 0, 0, normalizedTimeZone
                );
            } else {
                const todayBoundaryMs = zonedDateTimeToUtcMs(
                    civilDate, rolloverHour, 0, normalizedTimeZone
                );
                nextBoundaryMs = Number.isFinite(todayBoundaryMs) && cursorMs < todayBoundaryMs
                    ? todayBoundaryMs
                    : zonedDateTimeToUtcMs(
                        addDays(civilDate, 1), rolloverHour, 0, normalizedTimeZone
                    );
            }
            if (!Number.isFinite(nextBoundaryMs) || nextBoundaryMs <= cursorMs) {
                return unavailable('timezone_unavailable');
            }
            const segmentEndMs = Math.min(endMs, nextBoundaryMs);
            const dayFraction = (segmentEndMs - cursorMs) / 86400000;
            const tradingDay = isTradingDay(date, normalizedCalendarKey, observed);
            if (tradingDay === null) return unavailable('calendar_unavailable');
            const hasDateWeight = !!(weightSpec.byDate
                && Object.prototype.hasOwnProperty.call(weightSpec.byDate, date));
            if (!tradingDay && weightSpec.strictByDate && !hasDateWeight) {
                return {
                    ...unavailable('implied_lambda_incomplete'),
                    missingWeightDates: [date],
                };
            }
            const weight = tradingDay
                ? 1
                : (hasDateWeight
                    ? weightSpec.byDate[date]
                    : weightSpec.default);
            if (!Number.isFinite(weight)) {
                return unavailable('invalid_weight');
            }
            const weightedFraction = dayFraction * weight;
            effectiveDays += weightedFraction;
            if (tradingDay) {
                tradingDays += dayFraction;
            } else {
                nonTradingDays += dayFraction;
                if (!nonTradingDates.includes(date)) nonTradingDates.push(date);
            }
            segments.push({
                date,
                kind: tradingDay
                    ? 'trading'
                    : ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())
                        ? 'weekend'
                        : 'exchange_holiday'),
                startAsOf: new Date(cursorMs).toISOString(),
                endAsOf: new Date(segmentEndMs).toISOString(),
                dayFraction,
                weight,
                effectiveDays: weightedFraction,
            });
            cursorMs = segmentEndMs;
        }
        if (cursorMs < endMs) return unavailable('interval_too_long');

        return {
            available: true,
            status: 'ok',
            calendarKey: normalizedCalendarKey,
            timeZone: normalizedTimeZone,
            calendarDays: (endMs - startMs) / 86400000,
            effectiveDays,
            tradingDays,
            nonTradingDays,
            nonTradingDates,
            segments,
        };
    }

    // Weighted day count for the simulation clock: trading days count as 1,
    // weekends/holidays count as weekendWeight (0 = pure trading clock,
    // 1 = pure calendar clock). Same [start, end) convention as
    // calendarToTradingDays so the two agree at the extremes. weekendWeight
    // may be a scalar or a normalizeWeekendWeightSpec-style object with
    // per-date overrides.
    function countWeightedDays(startDateStr, endDateStr, weekendWeight, calendarKey = 'NYSE', observedTradingDates = null) {
        const start = new Date(normalizeDateInput(startDateStr) + 'T00:00:00Z');
        const end = new Date(normalizeDateInput(endDateStr) + 'T00:00:00Z');
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
            return 0;
        }
        const weightSpec = normalizeWeekendWeightSpec(weekendWeight);

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
            const dateKey = current.toISOString().slice(0, 10);
            const tradingDay = isTradingDay(dateKey, calendarKey, observed);
            if (tradingDay === null) return null;
            if (tradingDay) {
                weighted += 1;
            } else {
                const hasDateWeight = !!(weightSpec.byDate
                    && Object.prototype.hasOwnProperty.call(weightSpec.byDate, dateKey));
                if (weightSpec.strictByDate && !hasDateWeight) return null;
                weighted += hasDateWeight ? weightSpec.byDate[dateKey] : weightSpec.default;
            }
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
        normalizeWeekendWeightSpec,
        zonedDateTimeToUtcMs,
        resolveExpiryCutoffAsOf,
        resolveWeightedTime,
        countWeightedDays,
        listTradingDays,
    };

    globalScope.OptionComboDateUtils = api;
    Object.assign(globalScope, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
