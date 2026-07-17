/**
 * IV term structure aggregation helpers used by the standalone monitoring page.
 * Keep this file DOM-free so it can stay easy to test and reuse.
 */

(function attachIvTermStructureCore(globalScope) {
    const DEFAULT_BUCKET_DEFINITIONS = Object.freeze([
        { label: '1D', targetDays: 1 },
        { label: '3D', targetDays: 3 },
        { label: '1W', targetDays: 7 },
        { label: '3W', targetDays: 21 },
        { label: '1M', targetDays: 30 },
        { label: '3M', targetDays: 90 },
        { label: '6M', targetDays: 180 },
    ]);

    function cloneBucketDefinitions(definitions) {
        return (Array.isArray(definitions) ? definitions : DEFAULT_BUCKET_DEFINITIONS).map((entry) => ({
            label: String(entry && entry.label || '').trim() || 'Bucket',
            targetDays: Math.max(0, parseInt(entry && entry.targetDays, 10) || 0),
        }));
    }

    function _coercePositiveNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function _roundNumber(value, decimals) {
        if (!Number.isFinite(value)) {
            return null;
        }
        const factor = 10 ** Math.max(0, decimals || 0);
        return Math.round(value * factor) / factor;
    }

    function _computeAverageIv(callIv, putIv) {
        if (!Number.isFinite(callIv) || !Number.isFinite(putIv)) {
            return null;
        }
        return _roundNumber((callIv + putIv) / 2, 6);
    }

    function _computeStraddleMark(callMark, putMark) {
        if (!Number.isFinite(callMark) || !Number.isFinite(putMark)) {
            return null;
        }
        return _roundNumber(callMark + putMark, 4);
    }

    function _parseUtcDate(value) {
        const compact = String(value || '').trim().replace(/[-/]/g, '');
        if (!/^\d{8}$/.test(compact)) {
            return null;
        }
        const date = new Date(`${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00Z`);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function countTradingDays(startDateStr, endDateStr, calendarKey = 'NYSE') {
        const start = _parseUtcDate(startDateStr);
        const end = _parseUtcDate(endDateStr);
        if (!start || !end || start > end) {
            return null;
        }
        if (start < end && typeof globalScope.isOfficialExchangeCalendarAvailable === 'function') {
            const lastIncluded = new Date(end);
            lastIncluded.setUTCDate(lastIncluded.getUTCDate() - 1);
            if (!globalScope.isOfficialExchangeCalendarAvailable(
                calendarKey,
                start.toISOString().slice(0, 10),
                lastIncluded.toISOString().slice(0, 10)
            )) {
                return null;
            }
        }

        let days = 0;
        const current = new Date(start);
        while (current < end) {
            const dayOfWeek = current.getUTCDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const isHoliday = typeof globalScope.isMarketHoliday === 'function'
                ? globalScope.isMarketHoliday(current.toISOString().slice(0, 10), calendarKey)
                : null;
            if (!isWeekend && isHoliday === null) {
                return null;
            }
            if (!isWeekend && !isHoliday) {
                days += 1;
            }
            current.setUTCDate(current.getUTCDate() + 1);
        }
        return days;
    }

    function _normalizeWeekendWeight(value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return 0;
        }
        return Math.min(1, Math.max(0, parsed));
    }

    // Re-annualize a calendar-day IV onto a weighted-day clock so expiries on
    // both sides of a weekend become comparable: the option's total variance
    // iv^2 * (calDte/365) is preserved and divided by effDte/effYear instead,
    // where non-trading days count as weekendWeight (λ) of a trading day.
    // λ = 0 is the pure trading-day clock; λ = 1 reproduces the calendar
    // clock (and the TWS quote) exactly.
    function computeTradingDayAnnualizedIv(iv, calDte, tradDte, weekendWeight = 0) {
        if (!Number.isFinite(iv) || iv <= 0
            || !Number.isFinite(calDte) || calDte <= 0
            || !Number.isFinite(tradDte) || tradDte <= 0
            || tradDte > calDte) {
            return null;
        }
        const lambda = _normalizeWeekendWeight(weekendWeight);
        const effDte = tradDte + lambda * (calDte - tradDte);
        const effYear = 252 + lambda * (365 - 252);
        return _roundNumber(iv * Math.sqrt((calDte / 365) / (effDte / effYear)), 6);
    }

    function _normalizeExpiryKey(value) {
        const normalized = String(value || '').trim().replace(/-/g, '');
        return /^\d{8}$/.test(normalized) ? normalized : '';
    }

    function _getRowExpiry(row) {
        return _normalizeExpiryKey(row && (row.expiry || row.matchedExpiry));
    }

    function _findBaselineRow(rows, baselineExpiry) {
        const expiry = _normalizeExpiryKey(baselineExpiry);
        if (!expiry) {
            return null;
        }
        return (Array.isArray(rows) ? rows : []).find((row) => _getRowExpiry(row) === expiry) || null;
    }

    function buildExpiryDetailRows(expiryRows, quotesBySubId, anchorDate, weekendWeight = 0, calendarKey = 'NYSE') {
        const quotes = quotesBySubId && typeof quotesBySubId === 'object'
            ? quotesBySubId
            : {};
        const lambda = _normalizeWeekendWeight(weekendWeight);

        return (Array.isArray(expiryRows) ? expiryRows : [])
            .map((entry) => {
                const callQuote = entry && entry.atmCallSubId ? quotes[entry.atmCallSubId] : null;
                const putQuote = entry && entry.atmPutSubId ? quotes[entry.atmPutSubId] : null;
                const callIv = _coercePositiveNumber(callQuote && callQuote.iv);
                const putIv = _coercePositiveNumber(putQuote && putQuote.iv);
                const atmIv = _computeAverageIv(callIv, putIv);
                const callMark = _coercePositiveNumber(callQuote && callQuote.mark);
                const putMark = _coercePositiveNumber(putQuote && putQuote.mark);
                const atmStraddleMark = _computeStraddleMark(callMark, putMark);
                const dte = Math.max(0, parseInt(entry && entry.dte, 10) || 0);
                const tradDte = countTradingDays(anchorDate, entry && entry.expiry, calendarKey);
                const callIvTd = computeTradingDayAnnualizedIv(callIv, dte, tradDte, lambda);
                const putIvTd = computeTradingDayAnnualizedIv(putIv, dte, tradDte, lambda);

                return {
                    expiry: String(entry && entry.expiry || '').trim(),
                    dte,
                    tradDte,
                    atmStrike: _coercePositiveNumber(entry && entry.atmStrike),
                    callIv,
                    putIv,
                    atmIv,
                    callIvTd,
                    putIvTd,
                    atmIvTd: _computeAverageIv(callIvTd, putIvTd),
                    tdIvWeekendWeight: lambda,
                    calendarKey,
                    callMark,
                    putMark,
                    atmStraddleMark,
                    subscriptionSelected: !(entry && entry.subscriptionSelected === false),
                    hasCompletePair: Number.isFinite(callIv) && Number.isFinite(putIv),
                    hasCompleteStraddle: Number.isFinite(atmStraddleMark),
                    atmCallSubId: String(entry && entry.atmCallSubId || '').trim(),
                    atmPutSubId: String(entry && entry.atmPutSubId || '').trim(),
                    callSnapshotId: String(callQuote && (callQuote.snapshotId || callQuote.batchId) || '').trim(),
                    putSnapshotId: String(putQuote && (putQuote.snapshotId || putQuote.batchId) || '').trim(),
                    callQuoteAsOf: String(callQuote && (callQuote.quoteAsOf || callQuote.payloadAsOf) || '').trim(),
                    putQuoteAsOf: String(putQuote && (putQuote.quoteAsOf || putQuote.payloadAsOf) || '').trim(),
                };
            })
            .filter((entry) => entry.expiry)
            .sort((left, right) => (
                left.dte - right.dte
                || String(left.expiry).localeCompare(String(right.expiry))
            ));
    }

    function _pickNearestDetailRow(detailRows, targetDays) {
        let match = null;
        let matchDistance = Number.POSITIVE_INFINITY;

        for (const row of (Array.isArray(detailRows) ? detailRows : [])) {
            if (!row || !Number.isFinite(row.dte)) {
                continue;
            }

            const distance = Math.abs(row.dte - targetDays);
            if (
                match === null
                || distance < matchDistance
                || (distance === matchDistance && row.dte < match.dte)
                || (distance === matchDistance && row.dte === match.dte && String(row.expiry) < String(match.expiry))
            ) {
                match = row;
                matchDistance = distance;
            }
        }

        return match;
    }

    function buildBucketRows(detailRows, bucketDefinitions) {
        const buckets = cloneBucketDefinitions(bucketDefinitions);
        const normalizedRows = Array.isArray(detailRows) ? detailRows.slice() : [];

        return buckets.map((bucket) => {
            const match = _pickNearestDetailRow(normalizedRows, bucket.targetDays);
            return {
                label: bucket.label,
                targetDays: bucket.targetDays,
                matchedExpiry: match ? String(match.expiry || '') : null,
                matchedDte: match && Number.isFinite(match.dte) ? match.dte : null,
                tradDte: match && Number.isFinite(match.tradDte) ? match.tradDte : null,
                atmStrike: match && Number.isFinite(match.atmStrike) ? match.atmStrike : null,
                callIv: match && Number.isFinite(match.callIv) ? match.callIv : null,
                putIv: match && Number.isFinite(match.putIv) ? match.putIv : null,
                atmIv: match && Number.isFinite(match.atmIv) ? match.atmIv : null,
                callIvTd: match && Number.isFinite(match.callIvTd) ? match.callIvTd : null,
                putIvTd: match && Number.isFinite(match.putIvTd) ? match.putIvTd : null,
                atmIvTd: match && Number.isFinite(match.atmIvTd) ? match.atmIvTd : null,
                tdIvWeekendWeight: match && Number.isFinite(match.tdIvWeekendWeight) ? match.tdIvWeekendWeight : 0,
                callMark: match && Number.isFinite(match.callMark) ? match.callMark : null,
                putMark: match && Number.isFinite(match.putMark) ? match.putMark : null,
                atmStraddleMark: match && Number.isFinite(match.atmStraddleMark) ? match.atmStraddleMark : null,
                subscriptionSelected: !match || match.subscriptionSelected !== false,
                hasCompletePair: !!(match && match.hasCompletePair === true),
                hasCompleteStraddle: !!(match && match.hasCompleteStraddle === true),
            };
        });
    }

    function buildStraddleComparisonRows(rows, baselineExpiry) {
        const sourceRows = Array.isArray(rows) ? rows : [];
        const normalizedBaselineExpiry = _normalizeExpiryKey(baselineExpiry);
        const baselineRow = _findBaselineRow(sourceRows, normalizedBaselineExpiry);
        const baselineMark = baselineRow && Number.isFinite(baselineRow.atmStraddleMark)
            ? baselineRow.atmStraddleMark
            : null;

        return sourceRows.map((row) => {
            const rowExpiry = _getRowExpiry(row);
            const rowMark = row && Number.isFinite(row.atmStraddleMark) ? row.atmStraddleMark : null;
            const canCompare = Number.isFinite(rowMark) && Number.isFinite(baselineMark) && baselineMark > 0;
            return {
                ...(row && typeof row === 'object' ? row : {}),
                straddleBaselineExpiry: normalizedBaselineExpiry || null,
                straddleBaselineMark: Number.isFinite(baselineMark) ? baselineMark : null,
                straddleBaselineRatio: canCompare ? _roundNumber(rowMark / baselineMark, 6) : null,
                isStraddleBaseline: !!(normalizedBaselineExpiry && rowExpiry === normalizedBaselineExpiry),
            };
        });
    }

    function _normalizeCalendarFinderOptions(options) {
        const data = options && typeof options === 'object' ? options : {};
        const parsedTargetRatio = _coercePositiveNumber(data.targetRatio);
        const targetRatio = parsedTargetRatio == null
            ? 2
            : Math.min(8, Math.max(1.05, parsedTargetRatio));
        const tolerancePctRaw = parseFloat(data.tolerancePct);
        const tolerancePct = Number.isFinite(tolerancePctRaw) && tolerancePctRaw >= 0 ? tolerancePctRaw : 25;
        const shortMinDteRaw = parseInt(data.shortMinDte, 10);
        const shortMaxDteRaw = parseInt(data.shortMaxDte, 10);
        const shortMinDte = Number.isFinite(shortMinDteRaw) && shortMinDteRaw >= 0 ? shortMinDteRaw : 3;
        const shortMaxDte = Number.isFinite(shortMaxDteRaw) && shortMaxDteRaw >= shortMinDte
            ? shortMaxDteRaw
            : Math.max(60, shortMinDte);
        return {
            targetRatio,
            tolerancePct,
            shortMinDte,
            shortMaxDte,
            sortBy: 'best_iv_ratio',
        };
    }

    function _hasUsableCalendarIv(row) {
        return !!(
            row
            && Number.isFinite(row.dte)
            && row.dte > 0
            && Number.isFinite(row.atmIv)
            && row.atmIv > 0
            && (row.hasCompletePair !== false)
        );
    }

    function _compareCalendarCandidates(left, right) {
        return right.ivRatio - left.ivRatio
            || left.longDte - right.longDte
            || left.dteRatio - right.dteRatio
            || left.priceMultiple - right.priceMultiple
            || left.shortDte - right.shortDte
            || String(left.shortExpiry).localeCompare(String(right.shortExpiry))
            || String(left.longExpiry).localeCompare(String(right.longExpiry));
    }

    function _collectCalendarCandidates(detailRows, finderOptions) {
        const totalExpiries = Array.isArray(detailRows) ? detailRows.length : 0;
        const sourceRows = (Array.isArray(detailRows) ? detailRows : [])
            .filter(_hasUsableCalendarIv)
            .slice()
            .sort((left, right) => (
                left.dte - right.dte
                || String(left.expiry || '').localeCompare(String(right.expiry || ''))
            ));
        const candidates = [];
        let shortCandidates = 0;

        for (let shortIndex = 0; shortIndex < sourceRows.length; shortIndex += 1) {
            const shortRow = sourceRows[shortIndex];
            let hasLaterExpiry = false;

            for (let longIndex = 0; longIndex < sourceRows.length; longIndex += 1) {
                const longRow = sourceRows[longIndex];
                if (longRow.dte <= shortRow.dte) {
                    continue;
                }
                hasLaterExpiry = true;

                const dteRatio = longRow.dte / shortRow.dte;
                const priceMultiple = Number.isFinite(shortRow.atmStraddleMark)
                    && shortRow.atmStraddleMark > 0
                    && Number.isFinite(longRow.atmStraddleMark)
                    && longRow.atmStraddleMark > 0
                    ? longRow.atmStraddleMark / shortRow.atmStraddleMark
                    : null;
                const timeFairMultiple = Math.sqrt(dteRatio);
                const valueScore = Number.isFinite(priceMultiple) ? priceMultiple / timeFairMultiple : null;
                const ivRatio = shortRow.atmIv / longRow.atmIv;

                candidates.push({
                    shortExpiry: String(shortRow.expiry || '').trim(),
                    longExpiry: String(longRow.expiry || '').trim(),
                    shortDte: shortRow.dte,
                    longDte: longRow.dte,
                    dteRatio: _roundNumber(dteRatio, 6),
                    targetRatio: _roundNumber(finderOptions.targetRatio, 6),
                    ratioDistance: _roundNumber(Math.abs(dteRatio - finderOptions.targetRatio), 6),
                    shortStraddleMark: _roundNumber(shortRow.atmStraddleMark, 4),
                    longStraddleMark: _roundNumber(longRow.atmStraddleMark, 4),
                    priceMultiple: _roundNumber(priceMultiple, 6),
                    timeFairMultiple: _roundNumber(timeFairMultiple, 6),
                    valueScore: _roundNumber(valueScore, 6),
                    shortAtmIv: _roundNumber(shortRow.atmIv, 6),
                    longAtmIv: _roundNumber(longRow.atmIv, 6),
                    ivRatio: _roundNumber(ivRatio, 6),
                    shortAtmStrike: Number.isFinite(shortRow.atmStrike) ? shortRow.atmStrike : null,
                    longAtmStrike: Number.isFinite(longRow.atmStrike) ? longRow.atmStrike : null,
                    shortCallMark: Number.isFinite(shortRow.callMark) ? shortRow.callMark : null,
                    shortPutMark: Number.isFinite(shortRow.putMark) ? shortRow.putMark : null,
                    longCallMark: Number.isFinite(longRow.callMark) ? longRow.callMark : null,
                    longPutMark: Number.isFinite(longRow.putMark) ? longRow.putMark : null,
                    shortCallIv: Number.isFinite(shortRow.callIv) ? shortRow.callIv : null,
                    shortPutIv: Number.isFinite(shortRow.putIv) ? shortRow.putIv : null,
                    longCallIv: Number.isFinite(longRow.callIv) ? longRow.callIv : null,
                    longPutIv: Number.isFinite(longRow.putIv) ? longRow.putIv : null,
                });
            }

            if (hasLaterExpiry) {
                shortCandidates += 1;
            }
        }

        return {
            candidates,
            stats: {
                totalExpiries,
                usableExpiries: sourceRows.length,
                shortCandidates,
                pairCount: candidates.length,
            },
        };
    }

    function buildCalendarFinderRows(detailRows, options) {
        const finderOptions = _normalizeCalendarFinderOptions(options);
        const { candidates } = _collectCalendarCandidates(detailRows, finderOptions);
        return candidates.sort(_compareCalendarCandidates);
    }

    function pickCalendarFinderSecondaryCandidate(calendarRows) {
        const rows = Array.isArray(calendarRows)
            ? calendarRows.filter((row) => row && typeof row === 'object')
            : [];
        if (rows.length < 2) {
            return null;
        }

        const best = rows[0];
        const bestShortDte = parseFloat(best.shortDte);
        if (Number.isFinite(bestShortDte)) {
            const laterShortLeg = rows.slice(1).find((row) => {
                const shortDte = parseFloat(row.shortDte);
                return Number.isFinite(shortDte) && shortDte > bestShortDte;
            });
            if (laterShortLeg) {
                return laterShortLeg;
            }
        }

        return rows[1];
    }

    function buildCalendarFinderStats(detailRows, options) {
        const finderOptions = _normalizeCalendarFinderOptions(options);
        return _collectCalendarCandidates(detailRows, finderOptions).stats;
    }

    // ------------------------------------------------------------------
    // Strategy dashboard signals (see VRP_RESEARCH_MEMO.md and
    // IVTS_DASHBOARD_PLAN.md). All parameters are FROZEN at the values the
    // 2010-2026 SPY/QQQ backtests were validated under — deliberately not
    // user-tunable: coarse-and-correct beats fine-and-fitted.
    // ------------------------------------------------------------------
    const STRATEGY_SIGNAL_DEFAULTS = Object.freeze({
        signalLambda: 0.3,
        frontTargetDte: 7,
        frontDteTolerance: 2,
        backMult: 2,
        zoneLow: 0.95,
        zoneHigh: 1.05,
        watermarkFloor: 0.95,
        watermarkWindow: 26,
        watermarkMinCount: 8,
        watermarkGapDaysMin: 3,
        watermarkGapDaysMax: 12,
        // Databento/FMP history uses values such as 0.01488 as a vendor
        // floor/sentinel. A weekly ATM IV below 3% is not admissible signal
        // evidence; fail closed instead of manufacturing an extreme slope.
        signalIvFloor: 0.03,
        signalPriceIvRatioMin: 0.75,
        signalPriceIvRatioMax: 1.25,
        signalSnapshotMaxQuoteAgeMs: 30000,
        // A live watermark older than two calendar weeks is not evidence for
        // the current displacement regime. Fail closed until a new official
        // weekly-close observation arrives.
        watermarkMaxStalenessDays: 14,
        watermarkCalendarKey: null,
    });

    function _signalOptions(options) {
        return { ...STRATEGY_SIGNAL_DEFAULTS, ...(options && typeof options === 'object' ? options : {}) };
    }

    function _signalUsableRow(row, opts) {
        const floor = Number.isFinite(opts && opts.signalIvFloor)
            ? Math.max(0, opts.signalIvFloor)
            : STRATEGY_SIGNAL_DEFAULTS.signalIvFloor;
        const hasAnyLegIv = !!(row
            && (Number.isFinite(row.callIv) || Number.isFinite(row.putIv)));
        const legsClearFloor = !hasAnyLegIv || (
            Number.isFinite(row.callIv) && row.callIv > floor
            && Number.isFinite(row.putIv) && row.putIv > floor
        );
        // Pure ATM-IV research fixtures do not carry live leg fields and stay
        // supported. Once a row exposes live leg IVs, however, every price/IV
        // consistency input is mandatory; missing marks or strike must not
        // silently bypass the sentinel/mismatch gate.
        const hasPriceIvInputs = !!(row
            && Number.isFinite(row.atmStraddleMark) && row.atmStraddleMark > 0
            && Number.isFinite(row.atmStrike) && row.atmStrike > 0
            && Number.isFinite(row.dte) && row.dte > 0
            && Number.isFinite(row.atmIv) && row.atmIv > 0);
        let priceIvConsistent = !hasAnyLegIv && !hasPriceIvInputs;
        if (hasPriceIvInputs) {
            const priceIv = row.atmStraddleMark
                / (Math.sqrt(2 / Math.PI) * row.atmStrike * Math.sqrt(row.dte / 365));
            const ratio = row.atmIv / priceIv;
            const ratioMin = Number.isFinite(opts && opts.signalPriceIvRatioMin)
                ? opts.signalPriceIvRatioMin
                : STRATEGY_SIGNAL_DEFAULTS.signalPriceIvRatioMin;
            const ratioMax = Number.isFinite(opts && opts.signalPriceIvRatioMax)
                ? opts.signalPriceIvRatioMax
                : STRATEGY_SIGNAL_DEFAULTS.signalPriceIvRatioMax;
            priceIvConsistent = Number.isFinite(ratio) && ratio >= ratioMin && ratio <= ratioMax;
        }
        return !!(row
            && Number.isFinite(row.dte) && row.dte > 0
            && Number.isFinite(row.tradDte) && row.tradDte > 0
            && Number.isFinite(row.atmIv) && row.atmIv > floor
            && legsClearFloor
            && priceIvConsistent
            && row.hasCompletePair !== false
            && row.subscriptionSelected !== false);
    }

    function _pickSignalRow(rows, targetDte, lo, hi) {
        let best = null;
        for (const row of rows) {
            if (row.dte < lo || row.dte > hi) {
                continue;
            }
            if (best === null || Math.abs(row.dte - targetDte) < Math.abs(best.dte - targetDte)) {
                best = row;
            }
        }
        return best;
    }

    // Unrounded trading-day IV on the FROZEN signal lambda clock. Null when
    // the inputs cannot produce a positive finite value.
    function _signalTdIvRaw(iv, calDte, tradDte, lambda) {
        if (!Number.isFinite(iv) || iv <= 0
            || !Number.isFinite(calDte) || calDte <= 0
            || !Number.isFinite(tradDte) || tradDte <= 0) {
            return null;
        }
        const effDte = tradDte + lambda * (calDte - tradDte);
        const effYear = 252 + lambda * (365 - 252);
        const value = iv * Math.sqrt((calDte / 365) / (effDte / effYear));
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    // Pairwise TD slope of every row against a baseline expiry, playbook
    // convention: shorter-DTE leg on top, so >1 reads as backwardation for
    // that pair no matter which side of the baseline the row sits. Uses the
    // FROZEN signal lambda — exploration data; the regime signal itself
    // stays pinned to ~7d front / ~2x back.
    function annotateTdSlopeVsBaseline(rows, baselineExpiry, options) {
        const opts = _signalOptions(options);
        const sourceRows = Array.isArray(rows) ? rows : [];
        const normalizedBaseline = _normalizeExpiryKey(baselineExpiry);
        const baselineRow = normalizedBaseline
            ? sourceRows.find((row) => row && row.hasCompletePair !== false
                && _getRowExpiry(row) === normalizedBaseline) || null
            : null;
        const baselineTd = baselineRow
            ? _signalTdIvRaw(baselineRow.atmIv, baselineRow.dte, baselineRow.tradDte, opts.signalLambda)
            : null;

        return sourceRows.map((row) => {
            let slope = null;
            let pairRatio = null;
            if (baselineTd != null && row && row.hasCompletePair !== false
                && _getRowExpiry(row) !== normalizedBaseline) {
                const rowTd = _signalTdIvRaw(row.atmIv, row.dte, row.tradDte, opts.signalLambda);
                if (rowTd != null) {
                    slope = row.dte >= baselineRow.dte ? baselineTd / rowTd : rowTd / baselineTd;
                    pairRatio = Math.max(row.dte, baselineRow.dte) / Math.min(row.dte, baselineRow.dte);
                }
            }
            return {
                ...(row && typeof row === 'object' ? row : {}),
                tdSlopeVsBaseline: slope != null ? _roundNumber(slope, 4) : null,
                // DTE ratio of the pair. The 0.95/1.05 thresholds are only
                // meaningful near the calibrated ~2x geometry: wider pairs sit
                // naturally lower (SPY 14/90 median ~0.91, <0.95 is the
                // MAJORITY state there — normal upward term structure, not
                // deep contango).
                tdSlopePairRatio: pairRatio != null ? _roundNumber(pairRatio, 4) : null,
            };
        });
    }

    // Front(~7 DTE)/back(~2x) ATM IV ratio on the trading-day clock with the
    // FROZEN signal lambda — independent of whatever display lambda the TD IV
    // column is currently using.
    function computeRegimeSignal(detailRows, options) {
        const opts = _signalOptions(options);
        const rows = (Array.isArray(detailRows) ? detailRows : [])
            .filter((row) => _signalUsableRow(row, opts));

        const front = _pickSignalRow(
            rows, opts.frontTargetDte,
            opts.frontTargetDte - opts.frontDteTolerance,
            opts.frontTargetDte + opts.frontDteTolerance
        );
        if (!front) {
            return { status: 'insufficient', reason: 'no usable front expiry (~7 DTE)' };
        }
        const backTarget = Math.round(front.dte * opts.backMult);
        const back = _pickSignalRow(rows, backTarget, front.dte + 4, backTarget + 5);
        if (!back) {
            return { status: 'insufficient', reason: 'no usable back expiry (~2x front DTE)' };
        }

        // Classify on the UNROUNDED ratio; rounding is display-only. A slope
        // of 0.94996 must land in long_displacement, not get rounded onto the
        // 0.95 boundary first.
        const frontIvTd = _signalTdIvRaw(front.atmIv, front.dte, front.tradDte, opts.signalLambda);
        const backIvTd = _signalTdIvRaw(back.atmIv, back.dte, back.tradDte, opts.signalLambda);
        if (frontIvTd == null || backIvTd == null) {
            return { status: 'insufficient', reason: 'trading-day IV conversion failed' };
        }

        const rawSlope = frontIvTd / backIvTd;
        const zone = rawSlope < opts.zoneLow
            ? 'long_displacement'
            : (rawSlope > opts.zoneHigh ? 'sell_calendar' : 'stand_down');
        return {
            status: 'ok',
            slope: _roundNumber(rawSlope, 4),
            zone,
            front: { expiry: front.expiry, dte: front.dte, ivTd: _roundNumber(frontIvTd, 6) },
            back: { expiry: back.expiry, dte: back.dte, ivTd: _roundNumber(backIvTd, 6) },
        };
    }

    // Prove that the four live option legs used by the ~7d/~14d signal came
    // from one complete server-declared snapshot. A timestamp alone is not a
    // snapshot boundary: every required quote must carry the same snapshot id
    // and a server quote time no older than the bounded collection window.
    function evaluateSignalSnapshotCoherence(detailRows, signal, evidence, options) {
        const opts = _signalOptions(options);
        const snapshot = evidence && typeof evidence === 'object' ? evidence : {};
        const payloadAsOf = String(snapshot.payloadAsOf || '').trim();
        const payloadTimestamp = Date.parse(payloadAsOf);
        const snapshotId = String(snapshot.snapshotId || snapshot.batchId || '').trim();
        if (!Number.isFinite(payloadTimestamp)) {
            return { status: 'missing_snapshot_timestamp', coherent: false, payloadAsOf, snapshotId };
        }
        if (!snapshotId) {
            return { status: 'missing_snapshot_id', coherent: false, payloadAsOf, snapshotId };
        }
        if (snapshot.coherent !== true || snapshot.quoteComplete !== true) {
            return { status: 'incoherent_snapshot', coherent: false, payloadAsOf, snapshotId };
        }
        if (!signal || signal.status !== 'ok') {
            return { status: 'insufficient_signal', coherent: false, payloadAsOf, snapshotId };
        }

        const rows = Array.isArray(detailRows) ? detailRows : [];
        const requiredExpiries = [signal.front && signal.front.expiry, signal.back && signal.back.expiry]
            .map(_normalizeExpiryKey);
        const maxQuoteAgeMs = Number.isFinite(opts.signalSnapshotMaxQuoteAgeMs)
            ? Math.max(0, opts.signalSnapshotMaxQuoteAgeMs)
            : STRATEGY_SIGNAL_DEFAULTS.signalSnapshotMaxQuoteAgeMs;
        const requiredLegs = [];
        for (const expiry of requiredExpiries) {
            const row = rows.find((entry) => _getRowExpiry(entry) === expiry);
            if (!row) {
                return {
                    status: 'missing_snapshot_leg', coherent: false, payloadAsOf, snapshotId,
                    missingExpiry: expiry,
                };
            }
            requiredLegs.push(
                { expiry, right: 'C', snapshotId: row.callSnapshotId, quoteAsOf: row.callQuoteAsOf },
                { expiry, right: 'P', snapshotId: row.putSnapshotId, quoteAsOf: row.putQuoteAsOf }
            );
        }
        for (const leg of requiredLegs) {
            if (String(leg.snapshotId || '').trim() !== snapshotId) {
                return {
                    status: 'mixed_snapshot_legs', coherent: false, payloadAsOf, snapshotId,
                    missingExpiry: leg.expiry, missingRight: leg.right,
                };
            }
            const quoteTimestamp = Date.parse(String(leg.quoteAsOf || '').trim());
            const ageMs = payloadTimestamp - quoteTimestamp;
            if (!Number.isFinite(quoteTimestamp) || ageMs < 0 || ageMs > maxQuoteAgeMs) {
                return {
                    status: 'stale_snapshot_leg', coherent: false, payloadAsOf, snapshotId,
                    missingExpiry: leg.expiry, missingRight: leg.right,
                };
            }
        }
        return {
            status: 'ok', coherent: true, payloadAsOf, snapshotId,
            requiredLegCount: requiredLegs.length,
        };
    }

    function _sampleDateKey(sample) {
        const raw = String(sample && (sample.quoteDate || sample.sampledAt) || '').trim();
        const compact = raw.slice(0, 10).replace(/[-/]/g, '');
        return /^\d{8}$/.test(compact) ? compact : '';
    }

    function _dateKeyToIso(key) {
        return /^\d{8}$/.test(String(key || ''))
            ? `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`
            : '';
    }

    function _dateKeyAddDays(key, days) {
        const parsed = _parseUtcDate(key);
        if (!parsed || !Number.isFinite(days)) {
            return '';
        }
        parsed.setUTCDate(parsed.getUTCDate() + days);
        return parsed.toISOString().slice(0, 10).replace(/-/g, '');
    }

    // Monday key for the exchange trading week containing `key`.
    function _weekStartDateKey(key) {
        const parsed = _parseUtcDate(key);
        if (!parsed) {
            return '';
        }
        const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
        parsed.setUTCDate(parsed.getUTCDate() - daysSinceMonday);
        return parsed.toISOString().slice(0, 10).replace(/-/g, '');
    }

    function _watermarkAsOfDateKey(opts) {
        const supplied = opts.watermarkAsOf != null ? opts.watermarkAsOf : opts.asOf;
        const parsed = supplied instanceof Date
            ? new Date(supplied.getTime())
            : new Date(supplied == null ? Date.now() : supplied);
        return Number.isNaN(parsed.getTime())
            ? ''
            : parsed.toISOString().slice(0, 10).replace(/-/g, '');
    }

    function _watermarkAsOfTimestamp(opts) {
        const supplied = opts.watermarkAsOf != null ? opts.watermarkAsOf : opts.asOf;
        const parsed = supplied instanceof Date
            ? new Date(supplied.getTime())
            : new Date(supplied == null ? Date.now() : supplied);
        return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
    }

    function _watermarkCalendarKey(samples, opts) {
        const explicit = String(opts.watermarkCalendarKey || opts.calendarKey || '').trim();
        if (explicit) {
            return explicit.toUpperCase();
        }
        const firstSymbol = (Array.isArray(samples) ? samples : [])
            .map((sample) => String(sample && sample.symbol || '').trim())
            .find(Boolean);
        const registry = globalScope.OptionComboProductRegistry;
        if (firstSymbol && registry && typeof registry.resolveUnderlyingProfile === 'function') {
            const profile = registry.resolveUnderlyingProfile(firstSymbol);
            if (profile && profile.calendarId) {
                return String(profile.calendarId).toUpperCase();
            }
        }
        return 'NYSE';
    }

    // Resolve the official final exchange session in a Monday-Friday trading
    // week. No weekday-rule fallback is allowed: a missing/stale official
    // calendar must not silently turn a random daily/hourly sample into the
    // research weekly-close observation.
    function _officialWeekCloseDateKey(weekStartKey, calendarKey) {
        const startIso = _dateKeyToIso(weekStartKey);
        const fridayKey = _dateKeyAddDays(weekStartKey, 4);
        const fridayIso = _dateKeyToIso(fridayKey);
        if (!startIso || !fridayIso) {
            return { available: false, key: '' };
        }

        if (typeof globalScope.isOfficialExchangeCalendarAvailable === 'function'
            && !globalScope.isOfficialExchangeCalendarAvailable(calendarKey, startIso, fridayIso)) {
            return { available: false, key: '' };
        }

        let lastOpenKey = '';
        let lastOpenDay = null;
        for (let offset = 0; offset < 5; offset += 1) {
            const key = _dateKeyAddDays(weekStartKey, offset);
            const iso = _dateKeyToIso(key);
            let isClosed = null;
            let officialDay = null;
            if (typeof globalScope.getOfficialExchangeCalendarDay === 'function') {
                officialDay = globalScope.getOfficialExchangeCalendarDay(calendarKey, iso);
                if (!officialDay || officialDay.available !== true) {
                    return { available: false, key: '' };
                }
                isClosed = officialDay.status === 'closed';
            } else if (typeof globalScope.isMarketHoliday === 'function') {
                isClosed = globalScope.isMarketHoliday(iso, calendarKey);
                if (isClosed === null) {
                    return { available: false, key: '' };
                }
            } else {
                return { available: false, key: '' };
            }
            if (!isClosed) {
                lastOpenKey = key;
                lastOpenDay = officialDay;
            }
        }
        return { available: !!lastOpenKey, key: lastOpenKey, day: lastOpenDay };
    }

    function _timestampInTimeZone(timestamp, timeZone) {
        if (!Number.isFinite(timestamp) || typeof Intl !== 'object'
            || typeof Intl.DateTimeFormat !== 'function') {
            return null;
        }
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
            }).formatToParts(new Date(timestamp));
            const value = (type) => String(parts.find((part) => part.type === type)?.value || '');
            const dateKey = `${value('year')}${value('month')}${value('day')}`;
            const hour = parseInt(value('hour'), 10);
            const minute = parseInt(value('minute'), 10);
            return /^\d{8}$/.test(dateKey) && Number.isFinite(hour) && Number.isFinite(minute)
                ? { dateKey, minuteOfDay: hour * 60 + minute }
                : null;
        } catch (_error) {
            return null;
        }
    }

    const OFFICIAL_CLOSE_SAMPLE_TOLERANCE_MINUTES = 15;

    function _sampleOfficialCloseDistanceMinutes(sample, dateKey, calendarKey, officialDay) {
        // Backfilled records are sourced from an EOD database; their sampledAt
        // field is a synthetic storage timestamp (historically fixed at 20:00Z
        // even in winter), so the explicit provenance is the close guarantee.
        if (sample && (sample.backfilled === true || sample.officialClose === true)) {
            return 0;
        }

        // For live NYSE snapshots, require the sample timestamp to reach the
        // official option close in exchange local time. A final-session midday
        // sample is still incomplete, while a late-night hourly mark is no
        // longer the official close. Only the narrow [close, close+15m] window
        // is admissible.
        if (calendarKey !== 'NYSE') {
            return null;
        }
        const detail = officialDay && officialDay.detail && typeof officialDay.detail === 'object'
            ? officialDay.detail
            : {};
        const closeText = String(detail.optionCloseTime || detail.closeTime || '16:15');
        const match = /^(\d{1,2}):(\d{2})$/.exec(closeText);
        if (!match) {
            return null;
        }
        const local = _timestampInTimeZone(
            _sampleTimestamp(sample),
            String(detail.timezone || 'America/New_York')
        );
        const closeMinute = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
        const distance = local && local.dateKey === dateKey
            ? local.minuteOfDay - closeMinute
            : null;
        return Number.isFinite(distance)
            && distance >= 0 && distance <= OFFICIAL_CLOSE_SAMPLE_TOLERANCE_MINUTES
            ? distance
            : null;
    }

    function _selectOfficialCloseSample(candidates, dateKey, calendarKey, officialDay, asOfTimestamp) {
        let selected = null;
        let selectedDistance = Number.POSITIVE_INFINITY;
        let selectedTimestamp = -Infinity;
        for (const sample of (Array.isArray(candidates) ? candidates : [])) {
            const sampleTimestamp = _sampleTimestamp(sample);
            if (Number.isFinite(sampleTimestamp) && Number.isFinite(asOfTimestamp)
                && sampleTimestamp > asOfTimestamp) {
                continue;
            }
            const distance = _sampleOfficialCloseDistanceMinutes(
                sample, dateKey, calendarKey, officialDay
            );
            if (distance == null) {
                continue;
            }
            // Nearest to the official close wins. Timestamp only breaks ties,
            // making source concatenation order irrelevant without allowing a
            // 23:00 hourly mark to overwrite the 16:20 close observation.
            if (distance < selectedDistance
                || (distance === selectedDistance && sampleTimestamp >= selectedTimestamp)) {
                selected = sample;
                selectedDistance = distance;
                selectedTimestamp = sampleTimestamp;
            }
        }
        return selected;
    }

    function _sampleFrontRow(sample, opts) {
        const rows = (Array.isArray(sample && sample.details) ? sample.details : []).filter((row) => (
            row
            && Number.isFinite(row.dte)
            && row.dte >= opts.frontTargetDte - 3 && row.dte <= opts.frontTargetDte + 3
            && Number.isFinite(row.atmStraddleMark) && row.atmStraddleMark > 0
        ));
        return _pickSignalRow(rows, opts.frontTargetDte, opts.frontTargetDte - 3, opts.frontTargetDte + 3);
    }

    function _dateKeyDiffDays(fromKey, toKey) {
        const parse = (key) => Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8));
        return Math.round((parse(toKey) - parse(fromKey)) / 86400000);
    }

    // Wall-clock instant a sample was taken. Samples merged from several
    // sources (manual history + hourly automatic file) arrive concatenated,
    // not interleaved. Unparseable timestamps sort oldest; official-close
    // selection itself is based on distance from the exchange close.
    function _sampleTimestamp(sample) {
        const parsed = Date.parse(String(sample && sample.sampledAt || '').trim());
        return Number.isFinite(parsed) ? parsed : -Infinity;
    }

    // Realized displacement over implied expected move, from the symbol's
    // accumulated history samples. First collapse dense daily/hourly input to
    // exactly one observation per COMPLETED exchange week: the snapshot nearest
    // the official option close inside a strict 15-minute tolerance window on
    // that week's final trading session. The current week remains
    // excluded until both the official final session and its option close have
    // passed; after that close it is usable without waiting for Monday. For each adjacent weekly-close
    // pair 3-12 calendar days apart, ratio =
    // |dS| / (EM0 * sqrt(gap/frontDte0)). Rolling mean of the latest
    // `watermarkWindow` observations; reports collecting, stale, or
    // calendar_unavailable rather than opening the strategy gate on ambiguity.
    function computeDisplacementWatermark(samples, options) {
        const opts = _signalOptions(options);
        const asOfKey = _watermarkAsOfDateKey(opts);
        const asOfTimestamp = _watermarkAsOfTimestamp(opts);
        const currentWeekStartKey = _weekStartDateKey(asOfKey);
        const calendarKey = _watermarkCalendarKey(samples, opts);
        const maxStalenessDays = Number.isFinite(opts.watermarkMaxStalenessDays)
            ? Math.max(0, opts.watermarkMaxStalenessDays)
            : STRATEGY_SIGNAL_DEFAULTS.watermarkMaxStalenessDays;
        const samplesByDate = new Map();
        for (const sample of (Array.isArray(samples) ? samples : [])) {
            const key = _sampleDateKey(sample);
            if (key && Number.isFinite(sample.underlyingPrice) && sample.underlyingPrice > 0) {
                if (!samplesByDate.has(key)) {
                    samplesByDate.set(key, []);
                }
                samplesByDate.get(key).push(sample);
            }
        }

        const byWeek = new Map();
        let excludedCurrentWeekSamples = 0;
        for (const key of [...samplesByDate.keys()].sort()) {
            const weekStartKey = _weekStartDateKey(key);
            if (!weekStartKey || !currentWeekStartKey || weekStartKey > currentWeekStartKey) {
                excludedCurrentWeekSamples += 1;
                continue;
            }
            if (!byWeek.has(weekStartKey)) {
                byWeek.set(weekStartKey, []);
            }
            byWeek.get(weekStartKey).push(key);
        }

        const ordered = [];
        let calendarUnavailableWeeks = 0;
        let missingOfficialCloseWeeks = 0;
        let incompleteOfficialCloseWeeks = 0;
        for (const weekStartKey of [...byWeek.keys()].sort()) {
            let close = _officialWeekCloseDateKey(weekStartKey, calendarKey);
            if (!close.available) {
                // Before the downloaded official snapshot begins, the
                // backfill tool validates the last observed session against
                // the chain-service calendar plus its missing-date audit. Its
                // explicit provenance is acceptable historical authority;
                // unvalidated manual/hourly data still fail closed.
                const validatedKeys = byWeek.get(weekStartKey).filter((key) => {
                    return (samplesByDate.get(key) || []).some((sample) => (
                        sample && sample.backfilled === true
                        && sample.weeklySessionValidated === true
                    ));
                });
                if (validatedKeys.length === 1) {
                    close = { available: true, key: validatedKeys[0], day: null };
                } else {
                    calendarUnavailableWeeks += 1;
                    continue;
                }
            }
            if (close.key > asOfKey) {
                excludedCurrentWeekSamples += byWeek.get(weekStartKey).length;
                continue;
            }
            if (!samplesByDate.has(close.key)) {
                missingOfficialCloseWeeks += 1;
                continue;
            }
            const sample = _selectOfficialCloseSample(
                samplesByDate.get(close.key), close.key, calendarKey, close.day, asOfTimestamp
            );
            if (!sample) {
                incompleteOfficialCloseWeeks += 1;
                continue;
            }
            ordered.push({ key: close.key, sample });
        }

        const ratios = [];
        for (let index = 1; index < ordered.length; index += 1) {
            const prev = ordered[index - 1];
            const curr = ordered[index];
            const gap = _dateKeyDiffDays(prev.key, curr.key);
            if (gap < opts.watermarkGapDaysMin || gap > opts.watermarkGapDaysMax) {
                continue;
            }
            const frontRow = _sampleFrontRow(prev.sample, opts);
            if (!frontRow) {
                continue;
            }
            const expected = frontRow.atmStraddleMark * Math.sqrt(gap / frontRow.dte);
            if (!(expected > 0)) {
                continue;
            }
            const move = Math.abs(curr.sample.underlyingPrice - prev.sample.underlyingPrice);
            ratios.push({ value: _roundNumber(move / expected, 4), dateKey: curr.key });
        }

        const window = ratios.slice(-opts.watermarkWindow);
        const latestObservation = window.length ? window[window.length - 1] : null;
        const latestObservationDate = latestObservation ? _dateKeyToIso(latestObservation.dateKey) : null;
        const latestOfficialSampleDate = ordered.length
            ? _dateKeyToIso(ordered[ordered.length - 1].key)
            : null;
        const ageDays = latestObservation && asOfKey
            ? _dateKeyDiffDays(latestObservation.dateKey, asOfKey)
            : null;
        const metadata = {
            asOf: _dateKeyToIso(asOfKey) || null,
            calendarKey,
            weeklySampleCount: ordered.length,
            latestOfficialSampleDate,
            latestObservationDate,
            ageDays,
            staleAfterDays: maxStalenessDays,
            excludedCurrentWeekSamples,
            missingOfficialCloseWeeks,
            incompleteOfficialCloseWeeks,
            calendarUnavailableWeeks,
        };

        if (!ordered.length && calendarUnavailableWeeks > 0) {
            return {
                status: 'calendar_unavailable',
                reason: `official ${calendarKey} calendar unavailable or stale`,
                count: 0,
                required: opts.watermarkMinCount,
                mean: null,
                latest: null,
                ...metadata,
            };
        }
        if (ageDays != null && ageDays > maxStalenessDays) {
            return {
                status: 'stale',
                reason: `latest official weekly MRR observation is ${ageDays} days old`,
                count: window.length,
                required: opts.watermarkMinCount,
                mean: null,
                latest: latestObservation.value,
                ...metadata,
            };
        }
        if (window.length < opts.watermarkMinCount) {
            return {
                status: 'collecting',
                count: window.length,
                required: opts.watermarkMinCount,
                mean: null,
                latest: latestObservation ? latestObservation.value : null,
                ...metadata,
            };
        }
        return {
            status: 'ok',
            count: window.length,
            required: opts.watermarkMinCount,
            mean: _roundNumber(window.reduce((sum, entry) => sum + entry.value, 0) / window.length, 4),
            latest: latestObservation.value,
            ...metadata,
        };
    }

    // Historical MRR (Move Realization Ratio) era means measured in the
    // deep-contango zone — the regime the watermark actually gates. All
    // values come from the E10/E11 backtests in VRP_RESEARCH_MEMO.md and are
    // reference context only; the live per-symbol watermark decides. Values
    // for futures families are proxied from the ETF chains they were
    // measured on (`measuredOn`).
    const MRR_RESEARCH_BENCHMARKS = Object.freeze({
        SP500: Object.freeze({
            label: 'S&P 500 complex',
            measuredOn: 'SPY',
            eras: Object.freeze([
                Object.freeze({ span: '2010-14', value: 0.88 }),
                Object.freeze({ span: '2015-19', value: 0.92 }),
                Object.freeze({ span: '2020-26', value: 1.10 }),
            ]),
            note: 'Equity drift keeps the 2020s above the 0.95 floor; the gate has been open in the current era.',
        }),
        NDX100: Object.freeze({
            label: 'Nasdaq-100 complex',
            measuredOn: 'QQQ',
            eras: Object.freeze([
                Object.freeze({ span: '2010-14', value: 1.11 }),
                Object.freeze({ span: '2015-19', value: 1.09 }),
                Object.freeze({ span: '2020-26', value: 1.05 }),
            ]),
            note: 'Above water in all three eras — the most trend-taxed underlying in the study.',
        }),
        GOLD: Object.freeze({
            label: 'Gold',
            measuredOn: 'GLD',
            eras: Object.freeze([
                Object.freeze({ span: '2010-14', value: 1.09 }),
                Object.freeze({ span: '2015-19', value: 0.99 }),
                Object.freeze({ span: '2020-24', value: 0.78 }),
                Object.freeze({ span: '2025-26', value: 1.37 }),
            ]),
            note: 'Regime-driven: gate correctly shut 2020-24 (reverse fly bled) and wide open in the 2025-26 trend. Trust the live reading.',
        }),
        SILVER: Object.freeze({
            label: 'Silver',
            measuredOn: 'SLV',
            eras: Object.freeze([
                Object.freeze({ span: '2010-14', value: 0.84 }),
                Object.freeze({ span: '2015-19', value: 1.04 }),
                Object.freeze({ span: '2020-24', value: 1.03 }),
                Object.freeze({ span: '2025-26', value: 1.35 }),
            ]),
            note: 'Hovers near the floor; on SLV the per-lot premium was too thin to survive costs (E11) — SI futures scale helps.',
        }),
        OIL: Object.freeze({
            label: 'Crude oil',
            measuredOn: 'USO',
            eras: Object.freeze([
                Object.freeze({ span: '2010-14', value: 1.07 }),
                Object.freeze({ span: '2015-19', value: 0.94 }),
                Object.freeze({ span: '2020-24', value: 1.05 }),
                Object.freeze({ span: '2025-26', value: 0.90 }),
            ]),
            note: 'Oscillates around the floor with no persistent drift; the reverse-fly leg never earned outside 2022 (E11). Calendar leg only.',
        }),
    });

    const MRR_BENCHMARK_BY_FAMILY = Object.freeze({
        SPY: 'SP500', SPX: 'SP500', ES: 'SP500', MES: 'SP500',
        QQQ: 'NDX100', NDX: 'NDX100', NQ: 'NDX100', MNQ: 'NDX100',
        GLD: 'GOLD', GC: 'GOLD',
        SLV: 'SILVER', SI: 'SILVER',
        USO: 'OIL', CL: 'OIL',
    });

    // Research-era MRR context for a symbol/family, or null when the
    // instrument was never part of the study (no number is better than a
    // borrowed one).
    function getMrrResearchBenchmark(symbolOrFamily) {
        const key = MRR_BENCHMARK_BY_FAMILY[String(symbolOrFamily || '').trim().toUpperCase()];
        return key ? MRR_RESEARCH_BENCHMARKS[key] : null;
    }

    // The frozen playbook: zone x watermark -> what to do this week.
    function buildStrategySuggestion(signal, watermark, options) {
        const opts = _signalOptions(options);
        const reasons = [];
        if (!signal || signal.status !== 'ok') {
            return {
                stance: 'no_signal',
                structure: null,
                exitRule: null,
                reasons: [(signal && signal.reason) || 'regime signal unavailable'],
            };
        }
        reasons.push(`TD slope ${signal.slope} (front ${signal.front.dte}d / back ${signal.back.dte}d, λ=0.3)`);

        if (signal.zone === 'sell_calendar') {
            return {
                stance: 'sell_calendar',
                structure: 'Calendar: sell front ATM straddle, buy ~2x DTE back straddle',
                exitRule: 'Take profit at +50% of debit, else ride to front expiry. No mid-week recenter.',
                reasons,
            };
        }
        if (signal.zone === 'long_displacement') {
            // Fail closed: the reverse fly is only suggested once the
            // watermark PROVES displacement is underpriced in the current
            // era. Insufficient history cannot prove that.
            if (!watermark || watermark.status !== 'ok' || watermark.mean === null) {
                const count = watermark && Number.isFinite(watermark.count) ? watermark.count : 0;
                const required = watermark && Number.isFinite(watermark.required) ? watermark.required : opts.watermarkMinCount;
                const unavailableReason = watermark && watermark.reason
                    ? `; ${watermark.reason}`
                    : '';
                reasons.push(`zone favors reverse fly, but the displacement watermark is unavailable (${count}/${required}${unavailableReason}) — keep official weekly-close samples, no structure yet`);
                return { stance: 'awaiting_watermark', structure: null, exitRule: null, reasons };
            }
            if (watermark.mean < opts.watermarkFloor) {
                reasons.push(`displacement watermark ${watermark.mean} < ${opts.watermarkFloor} (sellers-era pricing) — veto`);
                return { stance: 'stand_down', structure: null, exitRule: null, reasons };
            }
            reasons.push(`displacement watermark ${watermark.mean} (n=${watermark.count})`);
            return {
                stance: 'long_displacement',
                structure: 'Reverse iron fly: buy front ATM straddle, sell wings one EM away',
                exitRule: 'Hold to expiry — no early profit-taking (winners need the full week).',
                reasons,
            };
        }
        reasons.push('neutral zone 0.95-1.05: both engines historically thin');
        return { stance: 'stand_down', structure: null, exitRule: null, reasons };
    }

    function buildSampleRecord(symbol, underlyingPrice, bucketRows, detailRows, sampledAt, quoteDate, straddleBaselineExpiry) {
        const normalizedBaselineExpiry = _normalizeExpiryKey(straddleBaselineExpiry);
        const baselineRow = _findBaselineRow(detailRows, normalizedBaselineExpiry);
        const baselineMark = baselineRow && Number.isFinite(baselineRow.atmStraddleMark)
            ? baselineRow.atmStraddleMark
            : null;

        return {
            symbol: String(symbol || '').trim().toUpperCase(),
            sampledAt: String(sampledAt || '').trim(),
            quoteDate: String(quoteDate || '').trim(),
            underlyingPrice: _coercePositiveNumber(underlyingPrice),
            straddleBaselineExpiry: normalizedBaselineExpiry || null,
            straddleBaselineMark: Number.isFinite(baselineMark) ? baselineMark : null,
            buckets: Array.isArray(bucketRows) ? bucketRows.map((row) => ({ ...row })) : [],
            details: Array.isArray(detailRows) ? detailRows.map((row) => ({ ...row })) : [],
        };
    }

    globalScope.OptionComboIvTermStructureCore = {
        DEFAULT_BUCKET_DEFINITIONS: cloneBucketDefinitions(DEFAULT_BUCKET_DEFINITIONS),
        cloneBucketDefinitions,
        countTradingDays,
        computeTradingDayAnnualizedIv,
        buildExpiryDetailRows,
        buildBucketRows,
        buildStraddleComparisonRows,
        buildCalendarFinderRows,
        pickCalendarFinderSecondaryCandidate,
        buildCalendarFinderStats,
        STRATEGY_SIGNAL_DEFAULTS,
        computeRegimeSignal,
        evaluateSignalSnapshotCoherence,
        computeDisplacementWatermark,
        annotateTdSlopeVsBaseline,
        getMrrResearchBenchmark,
        buildStrategySuggestion,
        buildSampleRecord,
    };
})(typeof window !== 'undefined' ? window : globalThis);
