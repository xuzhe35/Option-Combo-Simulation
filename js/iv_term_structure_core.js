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

    function countTradingDays(startDateStr, endDateStr) {
        const start = _parseUtcDate(startDateStr);
        const end = _parseUtcDate(endDateStr);
        if (!start || !end || start > end) {
            return null;
        }

        let days = 0;
        const current = new Date(start);
        while (current < end) {
            const dayOfWeek = current.getUTCDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const isHoliday = typeof globalScope.isMarketHoliday === 'function'
                && globalScope.isMarketHoliday(current.toISOString().slice(0, 10));
            if (!isWeekend && !isHoliday) {
                days += 1;
            }
            current.setUTCDate(current.getUTCDate() + 1);
        }
        return days;
    }

    // Re-annualize a calendar-day IV onto a trading-day clock so expiries on
    // both sides of a weekend become comparable: the option's total variance
    // iv^2 * (calDte/365) is preserved and divided by tradDte/252 instead,
    // which removes the dead weekend days from the denominator.
    function computeTradingDayAnnualizedIv(iv, calDte, tradDte) {
        if (!Number.isFinite(iv) || iv <= 0
            || !Number.isFinite(calDte) || calDte <= 0
            || !Number.isFinite(tradDte) || tradDte <= 0) {
            return null;
        }
        return _roundNumber(iv * Math.sqrt((calDte * 252) / (tradDte * 365)), 6);
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

    function buildExpiryDetailRows(expiryRows, quotesBySubId, anchorDate) {
        const quotes = quotesBySubId && typeof quotesBySubId === 'object'
            ? quotesBySubId
            : {};

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
                const tradDte = countTradingDays(anchorDate, entry && entry.expiry);
                const callIvTd = computeTradingDayAnnualizedIv(callIv, dte, tradDte);
                const putIvTd = computeTradingDayAnnualizedIv(putIv, dte, tradDte);

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
                    callMark,
                    putMark,
                    atmStraddleMark,
                    subscriptionSelected: !(entry && entry.subscriptionSelected === false),
                    hasCompletePair: Number.isFinite(callIv) && Number.isFinite(putIv),
                    hasCompleteStraddle: Number.isFinite(atmStraddleMark),
                    atmCallSubId: String(entry && entry.atmCallSubId || '').trim(),
                    atmPutSubId: String(entry && entry.atmPutSubId || '').trim(),
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
        buildSampleRecord,
    };
})(typeof window !== 'undefined' ? window : globalThis);
