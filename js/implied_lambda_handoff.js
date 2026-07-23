/**
 * IV term structure -> main simulator implied-lambda handoff.
 *
 * V2 remains strict about identity and exchange-calendar coverage. Quote
 * provenance is explicit: a curve may come from either a complete server
 * snapshot or a manual best-effort observation of the usable two-sided BBO
 * subset. A calculated curve is user-controlled; elapsed wall-clock time
 * alone does not invalidate it.
 */
(function (globalScope) {
    'use strict';

    const STORAGE_KEY = 'optionComboImpliedLambdaV2';
    // Kept as a public compatibility constant for older callers. Infinity
    // explicitly means that a calculated/imported curve has no time-based
    // expiry; its original quoteAsOf remains available for audit.
    const MAX_AGE_MS = Number.POSITIVE_INFINITY;
    const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
    const MAX_INTERVAL_QUOTE_SKEW_MS = 120 * 1000;
    const EXPORT_FORMAT = 'option-combo-implied-lambda';
    const SCHEMA_VERSION = 2;

    function _defaultStorage() {
        try {
            return typeof localStorage !== 'undefined' ? localStorage : null;
        } catch (_) {
            return null;
        }
    }

    function _finiteNumber(value) {
        const parsed = typeof value === 'number' ? value : parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _validLambda(value) {
        const parsed = _finiteNumber(value);
        // Structured price-derived lambda is intentionally signed. Values
        // outside the conventional [0, 1] clock expose inversion/overweight
        // in the observed term structure; clipping them destroys the signal.
        return parsed;
    }

    function _normalizeIsoDate(value) {
        const normalized = String(value || '').trim().replace(/\//g, '-');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
            return '';
        }
        const parsed = new Date(`${normalized}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
            ? normalized
            : '';
    }

    function _normalizeContractMonth(value) {
        const normalized = String(value || '').trim();
        return /^\d{6}$/.test(normalized) ? normalized : null;
    }

    function _normalizeDateList(value) {
        return Array.from(new Set(
            (Array.isArray(value) ? value : [])
                .map(_normalizeIsoDate)
                .filter(Boolean)
        )).sort();
    }

    function _normalizeMethodology(raw) {
        const data = raw && typeof raw === 'object' ? raw : {};
        const pricingModel = data.pricingModel === 'black76'
            ? 'black76'
            : (data.pricingModel === 'bsm-spot' ? 'bsm-spot' : null);
        const finiteOrNull = (value) => {
            const parsed = _finiteNumber(value);
            return parsed === null ? null : parsed;
        };
        const integerOrNull = (value) => {
            const parsed = parseInt(value, 10);
            return Number.isFinite(parsed) ? parsed : null;
        };
        const discountingInput = data.discounting && typeof data.discounting === 'object'
            ? data.discounting
            : {};
        const curveAsOf = _normalizeIsoDate(discountingInput.curveAsOf) || null;
        const curveQuoteStamp = _normalizeTimestamp(discountingInput.curveQuoteAsOf);
        const curveRowCount = integerOrNull(discountingInput.curveRowCount);
        const fallbackRowCount = integerOrNull(discountingInput.fallbackRowCount);
        return {
            pricingModel,
            estimationMode: data.estimationMode === 'best_effort'
                ? 'best_effort'
                : 'strict',
            sourceQuoteEvidence: String(data.sourceQuoteEvidence || '').trim() || null,
            underlyingQuoteIsForward: data.underlyingQuoteIsForward === true,
            interestRate: finiteOrNull(data.interestRate),
            discounting: {
                convention: String(discountingInput.convention || '').trim() || null,
                fallbackRate: finiteOrNull(discountingInput.fallbackRate),
                curveConfigured: discountingInput.curveConfigured === true,
                curveId: String(discountingInput.curveId || '').trim() || null,
                curveAsOf,
                curveQuoteAsOf: curveQuoteStamp ? curveQuoteStamp.text : null,
                source: String(discountingInput.source || '').trim() || null,
                isProxy: discountingInput.isProxy === true,
                curveRowCount: curveRowCount !== null && curveRowCount >= 0 ? curveRowCount : null,
                fallbackRowCount: fallbackRowCount !== null && fallbackRowCount >= 0
                    ? fallbackRowCount
                    : null,
                fallbackUsed: discountingInput.fallbackUsed === true,
            },
            baselineWindowDays: finiteOrNull(data.baselineWindowDays),
            minBaselines: integerOrNull(data.minBaselines),
            maxIntervalCalendarDays: finiteOrNull(data.maxIntervalCalendarDays),
            minDte: finiteOrNull(data.minDte),
            maxQuoteSkewMs: finiteOrNull(data.maxQuoteSkewMs),
            maxForwardDeviationPct: finiteOrNull(data.maxForwardDeviationPct),
            maxBidAskSpreadPct: finiteOrNull(data.maxBidAskSpreadPct),
            requireExactExpiryTimestamps: data.requireExactExpiryTimestamps === true,
            intervalClock: String(data.intervalClock || '').trim() || null,
            intervalTimeZone: String(data.intervalTimeZone || '').trim() || null,
            intervalTradeDateRolloverHour: integerOrNull(
                data.intervalTradeDateRolloverHour
            ),
        };
    }

    function _normalizeExpiryDate(value) {
        const compact = String(value || '').trim().replace(/-/g, '');
        return /^\d{8}$/.test(compact)
            ? _normalizeIsoDate(`${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`)
            : '';
    }

    function _normalizeTimestamp(value) {
        const text = String(value || '').trim();
        // Require a time and an explicit zone.  Date-only/local-time strings
        // are ambiguous between the IVTS and simulator machines.
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
            return null;
        }
        const epochMs = Date.parse(text);
        return Number.isFinite(epochMs) ? { text, epochMs } : null;
    }

    function _freshnessError(timestampMs, nowMs, label) {
        if (!Number.isFinite(timestampMs)) {
            return `missing_${label}`;
        }
        if (timestampMs > nowMs + FUTURE_TOLERANCE_MS) {
            return `future_${label}`;
        }
        return '';
    }

    // Futures entries are keyed by symbol and contract month.  A caller that
    // asks for ES#202609 can never receive ES#202612 or a bare ES entry.
    function entryStorageKey(symbol, contractMonth) {
        const normalizedSymbol = String(symbol || '').trim().toUpperCase();
        const month = _normalizeContractMonth(contractMonth);
        return normalizedSymbol ? (month ? `${normalizedSymbol}#${month}` : normalizedSymbol) : '';
    }

    function _normalizeInterval(raw) {
        const data = raw && typeof raw === 'object' ? raw : {};
        const rawLambda = _finiteNumber(
            data.rawLambda !== undefined && data.rawLambda !== null ? data.rawLambda : data.lambda
        );
        const nonTradingDates = _normalizeDateList(data.nonTradingDates);
        const weekendDates = _normalizeDateList(data.weekendDates);
        const holidayDates = _normalizeDateList(data.holidayDates);
        const inputKinds = data.nonTradingDateKinds
            && typeof data.nonTradingDateKinds === 'object'
            ? data.nonTradingDateKinds
            : {};
        const nonTradingDateKinds = {};
        for (const iso of nonTradingDates) {
            const kind = String(inputKinds[iso] || '').trim();
            if (kind === 'weekend' || kind === 'exchange_holiday') {
                nonTradingDateKinds[iso] = kind;
            }
        }
        const interval = {
            startDate: _normalizeIsoDate(data.startDate) || null,
            startExpiry: _normalizeExpiryDate(data.startExpiry) || null,
            endExpiry: _normalizeExpiryDate(data.endExpiry) || null,
            status: String(data.status || '').trim() || 'invalid',
            reason: String(data.reason || '').trim() || null,
            rawLambda,
            lambda: _finiteNumber(data.lambda),
            lambdaClamped: _finiteNumber(data.lambdaClamped),
            conventionalRange: String(data.conventionalRange || '').trim() || null,
            isInverted: data.isInverted === true || (rawLambda !== null && rawLambda < 0),
            baselineMode: String(data.baselineMode || '').trim() || null,
            profileClockFallback: data.profileClockFallback === true,
            nonTradingDates,
            weekendDates,
            holidayDates,
            nonTradingDateKinds,
            startAsOf: (_normalizeTimestamp(data.startAsOf) || {}).text || null,
            endAsOf: (_normalizeTimestamp(data.endAsOf) || {}).text || null,
            exactTimestampClock: data.exactTimestampClock === true,
            clockStatus: String(data.clockStatus || '').trim() || null,
            calendarDays: _finiteNumber(data.calendarDays),
            tradingDays: _finiteNumber(data.tradingDays),
            nonTradingDays: _finiteNumber(data.nonTradingDays),
            varianceCalendarDays: _finiteNumber(data.varianceCalendarDays),
            varianceTradingDays: _finiteNumber(data.varianceTradingDays),
            varianceNonTradingDays: _finiteNumber(data.varianceNonTradingDays),
            forwardVariance: _finiteNumber(data.forwardVariance),
            midDte: _finiteNumber(data.midDte),
            quoteSkewMs: _finiteNumber(data.quoteSkewMs),
            isFront: data.isFront === true,
            frontIntervalVerified: data.frontIntervalVerified === true,
            baselineVariance: _finiteNumber(data.baselineVariance),
            baselineCount: Number.isFinite(parseInt(data.baselineCount, 10))
                ? parseInt(data.baselineCount, 10)
                : null,
            quoteAsOf: String(data.quoteAsOf || '').trim() || null,
            snapshotId: String(data.snapshotId || '').trim() || null,
        };
        if (interval.status === 'ok'
            && (_validLambda(rawLambda) === null || !nonTradingDates.length)) {
            interval.status = _validLambda(rawLambda) === null ? 'out_of_range' : 'missing_dates';
        }
        return interval;
    }

    function _sameDateList(left, right) {
        return left.length === right.length
            && left.every((value, index) => value === right[index]);
    }

    function _previousIsoDate(value) {
        const date = new Date(`${value}T00:00:00Z`);
        if (!Number.isFinite(date.getTime())) {
            return '';
        }
        date.setUTCDate(date.getUTCDate() - 1);
        return date.toISOString().slice(0, 10);
    }

    // Rebuild the interval calendar from the official exchange snapshot.  The
    // exported nonTradingDates array is evidence, not authority: an imported
    // file must agree exactly with the locally verified calendar before it can
    // drive the simulator.
    function _verifyIntervalCalendar(interval, calendarKey) {
        const startDate = interval.startDate || interval.startExpiry;
        const endDate = interval.endExpiry;
        if (!startDate || !endDate || startDate >= endDate) {
            return {
                ok: false,
                errorCode: 'interval_calendar_bounds_missing',
                message: 'a usable interval is missing valid start/end dates',
            };
        }
        if (typeof globalScope.isOfficialExchangeCalendarAvailable !== 'function'
            || typeof globalScope.isMarketHoliday !== 'function') {
            return {
                ok: false,
                errorCode: 'calendar_unavailable',
                message: 'the official exchange-calendar runtime is unavailable',
            };
        }
        const lastIncluded = _previousIsoDate(endDate);
        if (!lastIncluded || !globalScope.isOfficialExchangeCalendarAvailable(
            calendarKey, startDate, lastIncluded
        )) {
            return {
                ok: false,
                errorCode: 'calendar_unavailable',
                message: `${calendarKey} official calendar is missing, stale, or out of coverage`,
            };
        }

        const start = new Date(`${startDate}T00:00:00Z`);
        const end = new Date(`${endDate}T00:00:00Z`);
        const calendarDays = Math.round((end.getTime() - start.getTime()) / 86400000);
        const nonTradingDates = [];
        const weekendDates = [];
        const holidayDates = [];
        const nonTradingDateKinds = {};
        let tradingDays = 0;
        for (const cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
            const iso = cursor.toISOString().slice(0, 10);
            const isWeekend = cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6;
            const isHoliday = globalScope.isMarketHoliday(iso, calendarKey);
            if (!isWeekend && isHoliday === null) {
                return {
                    ok: false,
                    errorCode: 'calendar_unavailable',
                    message: `${calendarKey} official calendar cannot classify ${iso}`,
                };
            }
            if (isWeekend || isHoliday) {
                nonTradingDates.push(iso);
                if (isHoliday) {
                    holidayDates.push(iso);
                    nonTradingDateKinds[iso] = 'exchange_holiday';
                } else {
                    weekendDates.push(iso);
                    nonTradingDateKinds[iso] = 'weekend';
                }
            } else {
                tradingDays += 1;
            }
        }
        if (!_sameDateList(interval.nonTradingDates, nonTradingDates)
            || (interval.calendarDays !== null && interval.calendarDays !== calendarDays)
            || (interval.tradingDays !== null && interval.tradingDays !== tradingDays)
            || (interval.nonTradingDays !== null
                && interval.nonTradingDays !== nonTradingDates.length)) {
            return {
                ok: false,
                errorCode: 'interval_calendar_mismatch',
                message: 'an interval does not match the official exchange calendar',
            };
        }
        Object.assign(interval, {
            startDate,
            calendarDays,
            tradingDays,
            nonTradingDays: nonTradingDates.length,
            nonTradingDates,
            weekendDates,
            holidayDates,
            nonTradingDateKinds,
        });
        return { ok: true, startDate, lastIncluded };
    }

    function _calendarEvidence(calendarKey, verifiedStart, verifiedEnd) {
        const snapshot = globalScope.OptionComboOfficialExchangeCalendars;
        const calendars = snapshot && snapshot.calendars && typeof snapshot.calendars === 'object'
            ? snapshot.calendars
            : {};
        const calendar = calendars[calendarKey] && typeof calendars[calendarKey] === 'object'
            ? calendars[calendarKey]
            : {};
        return {
            calendarKey,
            verified: true,
            verifiedStart,
            verifiedEnd,
            sourceKind: String(calendar.sourceKind || '').trim() || null,
            sourceUrl: String(calendar.sourceUrl || '').trim() || null,
            fetchedAt: String(calendar.fetchedAt || '').trim() || null,
            coverageStart: _normalizeIsoDate(calendar.coverageStart) || null,
            coverageEnd: _normalizeIsoDate(calendar.coverageEnd) || null,
            derivationVersion: String(calendar.derivationVersion || '').trim() || null,
        };
    }

    function _median(values) {
        const sorted = values.slice().sort((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);
        const value = sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
        return Math.round(value * 1000000) / 1000000;
    }

    function _validationResult(input, nowMs, options) {
        const data = input && typeof input === 'object' ? input : {};
        const opts = options && typeof options === 'object' ? options : {};
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        const symbol = String(data.symbol || '').trim().toUpperCase();
        if (!symbol) {
            return { entry: null, errorCode: 'missing_symbol', message: 'missing symbol' };
        }
        const anchorDate = _normalizeIsoDate(data.anchorDate);
        if (!anchorDate) {
            return { entry: null, errorCode: 'missing_anchor_date', message: 'missing market anchor date' };
        }
        const calendarKey = String(data.calendarKey || 'NYSE').trim().toUpperCase() || 'NYSE';
        const underlyingContractMonth = _normalizeContractMonth(data.underlyingContractMonth);
        const methodology = _normalizeMethodology(data.methodology || {
            pricingModel: data.pricingModel,
            interestRate: data.interestRate,
        });
        const varianceSource = String(data.varianceSource || '').trim();
        const vendorIvFallback = varianceSource === 'vendor_iv'
            && methodology.estimationMode === 'best_effort'
            && methodology.sourceQuoteEvidence === 'vendor_atm_iv_fallback';
        if (varianceSource !== 'straddle' && !vendorIvFallback) {
            return {
                entry: null,
                errorCode: 'unsupported_variance_source',
                message: 'V2 accepts straddle prices or an explicitly audited manual vendor-ATM-IV fallback',
            };
        }
        if (methodology.underlyingQuoteIsForward && !underlyingContractMonth) {
            return {
                entry: null,
                errorCode: 'missing_contract_month',
                message: 'a futures implied-lambda curve requires its underlying contract month',
            };
        }

        const quoteStamp = _normalizeTimestamp(data.quoteAsOf);
        const quoteError = _freshnessError(quoteStamp && quoteStamp.epochMs, now, 'quote');
        if (quoteError) {
            return {
                entry: null,
                errorCode: quoteError,
                message: 'quoteAsOf must be a timezone-qualified timestamp that is not in the future',
            };
        }

        const qualityInput = data.quality && typeof data.quality === 'object' ? data.quality : {};
        if (qualityInput.status !== 'ok'
            || qualityInput.coherent !== true
            || qualityInput.quoteComplete !== true) {
            return {
                entry: null,
                errorCode: 'unqualified_surface',
                message: 'surface quality is not OK/coherent/quote-complete',
            };
        }
        const snapshotId = String(data.snapshotId || '').trim();
        const qualitySnapshotId = String(qualityInput.snapshotId || snapshotId).trim();
        const underlyingSnapshotId = String(qualityInput.underlyingSnapshotId || '').trim();
        if (!snapshotId || qualitySnapshotId !== snapshotId
            || underlyingSnapshotId !== snapshotId) {
            return {
                entry: null,
                errorCode: 'missing_snapshot_identity',
                message: 'the surface/underlying snapshot identity is missing or inconsistent',
            };
        }

        const intervals = (Array.isArray(data.intervals) ? data.intervals : []).map(_normalizeInterval);
        const usableIntervals = intervals.filter((interval) => interval.status === 'ok');
        if (!usableIntervals.length) {
            return {
                entry: null,
                errorCode: 'no_usable_intervals',
                message: 'no finite, quality-approved implied-lambda interval is available',
            };
        }
        let calendarVerifiedStart = '';
        let calendarVerifiedEnd = '';
        for (const interval of usableIntervals) {
            if (interval.snapshotId !== snapshotId) {
                return {
                    entry: null,
                    errorCode: 'interval_snapshot_mismatch',
                    message: 'a usable interval does not belong to the declared coherent snapshot',
                };
            }
            const intervalStamp = _normalizeTimestamp(interval.quoteAsOf);
            if (!intervalStamp
                || Math.abs(intervalStamp.epochMs - quoteStamp.epochMs) > MAX_INTERVAL_QUOTE_SKEW_MS) {
                return {
                    entry: null,
                    errorCode: 'interval_quote_mismatch',
                    message: 'a usable interval is missing contemporaneous quote evidence',
                };
            }
            if (methodology.requireExactExpiryTimestamps === true) {
                const startStamp = _normalizeTimestamp(interval.startAsOf);
                const endStamp = _normalizeTimestamp(interval.endAsOf);
                const exactCalendarDays = startStamp && endStamp
                    ? (endStamp.epochMs - startStamp.epochMs) / 86400000
                    : null;
                const exactEvidenceValid = interval.exactTimestampClock === true
                    && startStamp && endStamp && exactCalendarDays > 0
                    && interval.varianceCalendarDays !== null
                    && interval.varianceTradingDays !== null
                    && interval.varianceNonTradingDays !== null
                    && interval.varianceTradingDays >= 0
                    && interval.varianceNonTradingDays > 0
                    && Math.abs(
                        interval.varianceCalendarDays - exactCalendarDays
                    ) <= 1e-9
                    && Math.abs(
                        interval.varianceTradingDays
                        + interval.varianceNonTradingDays
                        - interval.varianceCalendarDays
                    ) <= 1e-9;
                if (!exactEvidenceValid) {
                    return {
                        entry: null,
                        errorCode: 'exact_interval_clock_mismatch',
                        message: 'an exact-clock lambda interval is missing fractional expiry-time evidence',
                    };
                }
            }
            const calendarCheck = _verifyIntervalCalendar(interval, calendarKey);
            if (!calendarCheck.ok) {
                return {
                    entry: null,
                    errorCode: calendarCheck.errorCode,
                    message: calendarCheck.message,
                };
            }
            if (!calendarVerifiedStart || calendarCheck.startDate < calendarVerifiedStart) {
                calendarVerifiedStart = calendarCheck.startDate;
            }
            if (!calendarVerifiedEnd || calendarCheck.lastIncluded > calendarVerifiedEnd) {
                calendarVerifiedEnd = calendarCheck.lastIncluded;
            }
        }

        const byDate = {};
        for (const interval of usableIntervals) {
            const lambda = _validLambda(interval.rawLambda);
            for (const iso of interval.nonTradingDates) {
                if (Object.prototype.hasOwnProperty.call(byDate, iso)
                    && Math.abs(byDate[iso] - lambda) > 1e-9) {
                    return {
                        entry: null,
                        errorCode: 'conflicting_intervals',
                        message: `multiple intervals assign different lambdas to ${iso}`,
                    };
                }
                byDate[iso] = lambda;
            }
        }
        const dates = Object.keys(byDate).sort();
        if (!dates.length) {
            return { entry: null, errorCode: 'empty_coverage', message: 'no covered non-trading dates' };
        }
        if (dates.some((iso) => iso <= anchorDate)) {
            return {
                entry: null,
                errorCode: 'invalid_coverage_dates',
                message: 'covered non-trading dates must be after the market anchor date',
            };
        }

        const inputUpdatedAt = parseInt(data.updatedAt, 10);
        const requestedUpdatedAt = Number.isFinite(opts.updatedAt)
            ? opts.updatedAt
            : (Number.isFinite(inputUpdatedAt) ? inputUpdatedAt : now);
        const updatedError = _freshnessError(requestedUpdatedAt, now, 'publication');
        if (updatedError) {
            return {
                entry: null,
                errorCode: updatedError,
                message: 'the publication timestamp is invalid',
            };
        }

        const lambdas = usableIntervals.map((interval) => interval.rawLambda);
        const canonicalQuoteAsOf = new Date(quoteStamp.epochMs).toISOString();
        const storageKey = entryStorageKey(symbol, underlyingContractMonth);
        const curveId = `${storageKey}@${canonicalQuoteAsOf}`;
        const quality = {
            status: 'ok',
            coherent: true,
            quoteComplete: true,
            estimationMode: qualityInput.estimationMode === 'best_effort'
                ? 'best_effort'
                : 'strict',
            strictSnapshot: qualityInput.strictSnapshot !== false,
            sourceQuoteEvidence: String(qualityInput.sourceQuoteEvidence || '').trim() || null,
            snapshotId,
            validIntervalCount: usableIntervals.length,
            rejectedIntervalCount: intervals.length - usableIntervals.length,
            underlyingSnapshotId,
            usablePointCount: Number.isFinite(parseInt(qualityInput.usablePointCount, 10))
                ? parseInt(qualityInput.usablePointCount, 10)
                : null,
            rejectedRowCount: Number.isFinite(parseInt(qualityInput.rejectedRowCount, 10))
                ? parseInt(qualityInput.rejectedRowCount, 10)
                : null,
            sourceExpectedExpiryCount: Number.isFinite(parseInt(
                qualityInput.sourceExpectedExpiryCount, 10
            ))
                ? parseInt(qualityInput.sourceExpectedExpiryCount, 10)
                : null,
            usableExpiryCount: Number.isFinite(parseInt(qualityInput.usableExpiryCount, 10))
                ? parseInt(qualityInput.usableExpiryCount, 10)
                : null,
            skippedExpiryCount: Number.isFinite(parseInt(qualityInput.skippedExpiryCount, 10))
                ? parseInt(qualityInput.skippedExpiryCount, 10)
                : null,
            invertedIntervalCount: usableIntervals.filter(
                interval => interval.rawLambda < 0
            ).length,
            aboveCalendarIntervalCount: usableIntervals.filter(
                interval => interval.rawLambda > 1
            ).length,
            extrapolatedBaselineIntervalCount: usableIntervals.filter(
                interval => interval.baselineMode === 'nearest_extrapolated'
            ).length,
            profileClockFallbackIntervalCount: usableIntervals.filter(
                interval => interval.profileClockFallback === true
            ).length,
        };
        return {
            errorCode: '',
            message: '',
            entry: {
                schemaVersion: SCHEMA_VERSION,
                curveId,
                symbol,
                underlyingContractMonth,
                calendarKey,
                anchorDate,
                quoteAsOf: quoteStamp.text,
                snapshotId,
                varianceSource,
                methodology,
                calendarEvidence: _calendarEvidence(
                    calendarKey, calendarVerifiedStart, calendarVerifiedEnd
                ),
                quality,
                intervals,
                coverageStart: dates[0],
                coverageEnd: dates[dates.length - 1],
                medianLambda: _median(lambdas),
                byDate,
                weekendCount: usableIntervals.length,
                updatedAt: requestedUpdatedAt,
            },
        };
    }

    function buildSymbolEntry(input, nowMs) {
        return _validationResult(input, nowMs).entry;
    }

    function normalizeSymbolEntry(input, nowMs) {
        return _validationResult(input, nowMs).entry;
    }

    function _readStore(storage) {
        const target = storage || _defaultStorage();
        if (!target) {
            return null;
        }
        try {
            const rawText = target.getItem(STORAGE_KEY);
            if (!rawText) {
                return null;
            }
            const parsed = JSON.parse(rawText);
            return parsed && typeof parsed === 'object'
                && parsed.version === SCHEMA_VERSION
                && parsed.entries && typeof parsed.entries === 'object'
                ? parsed
                : null;
        } catch (_) {
            return null;
        }
    }

    function saveSymbolEntry(input, storage, nowMs, options) {
        const target = storage || _defaultStorage();
        const validation = _validationResult(input, nowMs);
        const entry = validation.entry;
        const opts = options && typeof options === 'object' ? options : {};
        if (!target || !entry) {
            return false;
        }
        const oldStore = _readStore(target) || { version: SCHEMA_VERSION, entries: {} };
        const newKey = entryStorageKey(entry.symbol, entry.underlyingContractMonth);
        const existingSameKey = oldStore.entries && oldStore.entries[newKey]
            ? _validationResult(oldStore.entries[newKey], nowMs).entry
            : null;
        if (opts.allowOlder !== true
            && existingSameKey && existingSameKey.snapshotId !== entry.snapshotId) {
            const existingQuoteMs = Date.parse(existingSameKey.quoteAsOf);
            const incomingQuoteMs = Date.parse(entry.quoteAsOf);
            if (Number.isFinite(existingQuoteMs) && Number.isFinite(incomingQuoteMs)
                && existingQuoteMs >= incomingQuoteMs) {
                // Cross-tab writes are monotone by real market evidence. A
                // delayed render from an older IVTS tab cannot roll the shared
                // simulator surface backward.
                return false;
            }
        }
        const entries = {};
        for (const key of Object.keys(oldStore.entries)) {
            const kept = _validationResult(oldStore.entries[key], nowMs).entry;
            if (kept) {
                entries[entryStorageKey(kept.symbol, kept.underlyingContractMonth)] = kept;
            }
        }
        entries[newKey] = entry;
        try {
            target.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, entries }));
            return true;
        } catch (_) {
            return false;
        }
    }

    function removeSymbolEntry(symbol, storage, contractMonth, expectedSnapshotId) {
        const target = storage || _defaultStorage();
        const key = entryStorageKey(symbol, contractMonth);
        const store = _readStore(target);
        if (!target || !key || !store || !Object.prototype.hasOwnProperty.call(store.entries, key)) {
            return false;
        }
        const expected = String(expectedSnapshotId || '').trim();
        if (expected && String(store.entries[key] && store.entries[key].snapshotId || '').trim() !== expected) {
            // A newer live IVTS publisher already replaced this card's entry.
            // Closing the older tab must not delete the newer surface.
            return false;
        }
        const entries = { ...store.entries };
        delete entries[key];
        try {
            target.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, entries }));
            return true;
        } catch (_) {
            return false;
        }
    }

    function peekSymbolEntry(symbol, storage, nowMs, contractMonth, expectedAnchorDate) {
        const key = entryStorageKey(symbol, contractMonth);
        const store = _readStore(storage);
        if (!key || !store || !Object.prototype.hasOwnProperty.call(store.entries, key)) {
            return null;
        }
        const entry = _validationResult(store.entries[key], nowMs).entry;
        if (!entry || entryStorageKey(entry.symbol, entry.underlyingContractMonth) !== key) {
            return null;
        }
        const expected = _normalizeIsoDate(
            expectedAnchorDate && typeof expectedAnchorDate === 'object'
                ? expectedAnchorDate.expectedAnchorDate
                : expectedAnchorDate
        );
        if (expected && entry.anchorDate !== expected) {
            return null;
        }
        return entry;
    }

    function buildExportDocument(input, nowMs) {
        const validation = _validationResult(input, nowMs);
        const entry = validation.entry;
        if (!entry) {
            return null;
        }
        return {
            format: EXPORT_FORMAT,
            version: SCHEMA_VERSION,
            exportedAt: Number.isFinite(nowMs) ? nowMs : Date.now(),
            curveId: entry.curveId,
            symbol: entry.symbol,
            underlyingContractMonth: entry.underlyingContractMonth,
            calendarKey: entry.calendarKey,
            anchorDate: entry.anchorDate,
            quoteAsOf: entry.quoteAsOf,
            snapshotId: entry.snapshotId,
            varianceSource: entry.varianceSource,
            methodology: entry.methodology,
            calendarEvidence: entry.calendarEvidence,
            quality: entry.quality,
            intervals: entry.intervals,
            coverageStart: entry.coverageStart,
            coverageEnd: entry.coverageEnd,
            medianLambda: entry.medianLambda,
            byDate: entry.byDate,
            weekendCount: entry.weekendCount,
        };
    }

    function parseImportDocumentDetailed(raw, nowMs) {
        let data = raw;
        if (typeof raw === 'string') {
            try {
                data = JSON.parse(raw);
            } catch (_) {
                return { entry: null, errorCode: 'invalid_json', message: 'file is not valid JSON' };
            }
        }
        if (!data || typeof data !== 'object' || data.format !== EXPORT_FORMAT) {
            return { entry: null, errorCode: 'invalid_format', message: 'not an implied-lambda export file' };
        }
        if (data.version !== SCHEMA_VERSION) {
            return {
                entry: null,
                errorCode: 'unsupported_version',
                message: 'only V2 straddle exports are accepted; regenerate this file in IV Term Structure',
            };
        }
        const exportedAt = parseInt(data.exportedAt, 10);
        if (!Number.isFinite(exportedAt)) {
            return { entry: null, errorCode: 'missing_exported_at', message: 'missing export timestamp' };
        }
        // Preserve both the original market quote and publication times for
        // audit. Selecting the file is the user's explicit decision to use
        // this frozen curve; import does not rewrite either timestamp.
        return _validationResult(data, nowMs, { updatedAt: exportedAt });
    }

    function parseImportDocument(raw, nowMs) {
        return parseImportDocumentDetailed(raw, nowMs).entry;
    }

    function listSymbols(storage, nowMs) {
        const store = _readStore(storage);
        if (!store) {
            return [];
        }
        return Object.keys(store.entries)
            .filter((key) => {
                const entry = _validationResult(store.entries[key], nowMs).entry;
                return !!entry && entryStorageKey(entry.symbol, entry.underlyingContractMonth) === key;
            })
            .sort();
    }

    const api = {
        STORAGE_KEY,
        MAX_AGE_MS,
        FUTURE_TOLERANCE_MS,
        MAX_INTERVAL_QUOTE_SKEW_MS,
        EXPORT_FORMAT,
        SCHEMA_VERSION,
        entryStorageKey,
        buildSymbolEntry,
        normalizeSymbolEntry,
        saveSymbolEntry,
        removeSymbolEntry,
        peekSymbolEntry,
        listSymbols,
        buildExportDocument,
        parseImportDocument,
        parseImportDocumentDetailed,
    };

    globalScope.OptionComboImpliedLambdaHandoff = api;
})(typeof window !== 'undefined' ? window : globalThis);
