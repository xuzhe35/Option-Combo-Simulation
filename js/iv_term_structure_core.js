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

    function buildExpiryDetailRows(expiryRows, quotesBySubId, anchorDate, weekendWeight = 0) {
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
                const tradDte = countTradingDays(anchorDate, entry && entry.expiry);
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
    });

    function _signalOptions(options) {
        return { ...STRATEGY_SIGNAL_DEFAULTS, ...(options && typeof options === 'object' ? options : {}) };
    }

    function _signalUsableRow(row) {
        return !!(row
            && Number.isFinite(row.dte) && row.dte > 0
            && Number.isFinite(row.tradDte) && row.tradDte > 0
            && Number.isFinite(row.atmIv) && row.atmIv > 0
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

    // Front(~7 DTE)/back(~2x) ATM IV ratio on the trading-day clock with the
    // FROZEN signal lambda — independent of whatever display lambda the TD IV
    // column is currently using.
    function computeRegimeSignal(detailRows, options) {
        const opts = _signalOptions(options);
        const rows = (Array.isArray(detailRows) ? detailRows : []).filter(_signalUsableRow);

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
        const tdRaw = (iv, calDte, tradDte) => {
            const effDte = tradDte + opts.signalLambda * (calDte - tradDte);
            const effYear = 252 + opts.signalLambda * (365 - 252);
            return iv * Math.sqrt((calDte / 365) / (effDte / effYear));
        };
        const frontIvTd = tdRaw(front.atmIv, front.dte, front.tradDte);
        const backIvTd = tdRaw(back.atmIv, back.dte, back.tradDte);
        if (!Number.isFinite(frontIvTd) || !Number.isFinite(backIvTd)
            || frontIvTd <= 0 || backIvTd <= 0) {
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

    function _sampleDateKey(sample) {
        const raw = String(sample && (sample.quoteDate || sample.sampledAt) || '').trim();
        const compact = raw.slice(0, 10).replace(/[-/]/g, '');
        return /^\d{8}$/.test(compact) ? compact : '';
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

    // Realized displacement over implied expected move, from the symbol's
    // accumulated history samples: for each adjacent pair of samples 3-12
    // calendar days apart, ratio = |dS| / (EM0 * sqrt(gap/frontDte0)).
    // Rolling mean of the latest `watermarkWindow` observations; reports
    // 'collecting' until `watermarkMinCount` observations exist.
    function computeDisplacementWatermark(samples, options) {
        const opts = _signalOptions(options);
        const byDate = new Map();
        for (const sample of (Array.isArray(samples) ? samples : [])) {
            const key = _sampleDateKey(sample);
            if (key && Number.isFinite(sample.underlyingPrice) && sample.underlyingPrice > 0) {
                byDate.set(key, sample); // last sample of a day wins
            }
        }
        const ordered = [...byDate.keys()].sort().map((key) => ({ key, sample: byDate.get(key) }));

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
            ratios.push(_roundNumber(move / expected, 4));
        }

        const window = ratios.slice(-opts.watermarkWindow);
        if (window.length < opts.watermarkMinCount) {
            return { status: 'collecting', count: window.length, required: opts.watermarkMinCount, mean: null, latest: window.length ? window[window.length - 1] : null };
        }
        return {
            status: 'ok',
            count: window.length,
            required: opts.watermarkMinCount,
            mean: _roundNumber(window.reduce((sum, v) => sum + v, 0) / window.length, 4),
            latest: window[window.length - 1],
        };
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
                reasons.push(`zone favors reverse fly, but the displacement watermark is still collecting (${count}/${required}) — keep weekly samples, no structure yet`);
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
        computeDisplacementWatermark,
        buildStrategySuggestion,
        buildSampleRecord,
    };
})(typeof window !== 'undefined' ? window : globalThis);
