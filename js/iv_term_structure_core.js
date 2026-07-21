/**
 * IV term structure aggregation helpers used by the standalone monitoring page.
 * Keep this file DOM-free so it can stay easy to test and reuse.
 */

(function attachIvTermStructureCore(globalScope) {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
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
        // Implied-lambda identification must use the project's official
        // exchange-calendar snapshot.  A caller-provided holiday hook (or a
        // weekday-only fallback) is not sufficient evidence: without official
        // coverage we fail closed instead of guessing that every weekday was
        // a trading session.
        if (start < end) {
            if (typeof globalScope.isOfficialExchangeCalendarAvailable !== 'function'
                || typeof globalScope.isMarketHoliday !== 'function') {
                return null;
            }
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
            const isHoliday = globalScope.isMarketHoliday(
                current.toISOString().slice(0, 10), calendarKey
            );
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

    function _convertCalendarIvToWeightedClock(iv, calDte, effectiveDte, annualizationWeight) {
        if (!Number.isFinite(iv) || iv <= 0
            || !Number.isFinite(calDte) || calDte <= 0
            || !Number.isFinite(effectiveDte) || effectiveDte <= 0) {
            return null;
        }
        const lambda = parseFloat(annualizationWeight);
        if (!Number.isFinite(lambda)) {
            return null;
        }
        const effYear = 252 + lambda * (365 - 252);
        if (!(effYear > 0)) {
            return null;
        }
        return _roundNumber(iv * Math.sqrt((calDte / 365) / (effectiveDte / effYear)), 6);
    }

    // Once the coherent straddle surface has identified per-date implied
    // lambdas, feed that curve back into the displayed TD IV. Call/Put IV
    // remains the vendor/TWS observation; only its annualization clock is
    // changed. The curve median defines one common annualization unit across
    // all expiries, while each directly covered closure contributes its own
    // lambda to that expiry's effective horizon. For the display-only TD-IV
    // lens, later uncovered closures use the current curve median and are
    // explicitly stamped as extrapolated. The simulator's published byDate
    // curve remains strict and does not receive these display extrapolations.
    function applyImpliedLambdaClockToRows(detailRows, anchorDate, impliedLambda, calendarKey = 'NYSE') {
        const sourceRows = Array.isArray(detailRows) ? detailRows : [];
        const quality = impliedLambda && impliedLambda.quality;
        const byDate = impliedLambda && impliedLambda.byDate
            && typeof impliedLambda.byDate === 'object'
            ? impliedLambda.byDate
            : null;
        const annualizationWeight = parseFloat(impliedLambda && impliedLambda.medianLambda);
        const vendorIvFallback = !!(impliedLambda
            && impliedLambda.varianceSource === 'vendor_iv'
            && quality && quality.estimationMode === 'best_effort'
            && quality.sourceQuoteEvidence === 'vendor_atm_iv_fallback');
        const qualified = !!(impliedLambda
            && (impliedLambda.varianceSource === 'straddle' || vendorIvFallback)
            && quality && quality.status === 'ok'
            && quality.coherent === true
            && quality.quoteComplete === true
            && byDate && Object.keys(byDate).length
            && Number.isFinite(annualizationWeight));

        if (!qualified) {
            return sourceRows.map((row) => ({
                ...(row && typeof row === 'object' ? row : {}),
                tdIvSource: 'fallback_scalar',
                tdIvStatus: row && (row.callIvTd != null || row.putIvTd != null)
                    ? 'ok'
                    : 'unavailable',
            }));
        }

        return sourceRows.map((row) => {
            const expiry = _getRowExpiry(row);
            const calendar = _classifyNonTradingDates(anchorDate, expiry, calendarKey);
            const tradDte = Number.isFinite(row && row.tradDte)
                ? row.tradDte
                : countTradingDays(anchorDate, expiry, calendarKey);
            const calDte = Number.isFinite(row && row.dte) ? row.dte : null;
            const base = {
                ...(row && typeof row === 'object' ? row : {}),
                tdIvSource: 'implied_lambda',
                tdIvWeekendWeight: annualizationWeight,
                tdIvAnnualizationWeight: annualizationWeight,
                tdIvEffectiveDte: null,
                tdIvAppliedWeights: {},
                tdIvMissingWeightDates: [],
                tdIvExtrapolatedWeightDates: [],
            };
            if (!calendar || !Number.isFinite(tradDte) || !Number.isFinite(calDte)
                || calDte <= 0 || tradDte <= 0) {
                return {
                    ...base,
                    callIvTd: null,
                    putIvTd: null,
                    atmIvTd: null,
                    tdIvStatus: calendar ? 'unavailable' : 'calendar_unavailable',
                };
            }

            const appliedWeights = {};
            const extrapolatedWeightDates = [];
            let nonTradingWeight = 0;
            for (const iso of calendar.dates) {
                const directWeight = Object.prototype.hasOwnProperty.call(byDate, iso)
                    ? parseFloat(byDate[iso])
                    : null;
                const hasDirectWeight = Number.isFinite(directWeight);
                const weight = hasDirectWeight ? directWeight : annualizationWeight;
                if (!hasDirectWeight) {
                    extrapolatedWeightDates.push(iso);
                }
                appliedWeights[iso] = weight;
                nonTradingWeight += weight;
            }

            const effectiveDte = tradDte + nonTradingWeight;
            const callIvTd = _convertCalendarIvToWeightedClock(
                row && row.callIv, calDte, effectiveDte, annualizationWeight
            );
            const putIvTd = _convertCalendarIvToWeightedClock(
                row && row.putIv, calDte, effectiveDte, annualizationWeight
            );
            return {
                ...base,
                callIvTd,
                putIvTd,
                atmIvTd: _computeAverageIv(callIvTd, putIvTd),
                tdIvStatus: callIvTd != null || putIvTd != null
                    ? (extrapolatedWeightDates.length ? 'ok_extrapolated' : 'ok')
                    : 'unavailable',
                tdIvEffectiveDte: _roundNumber(effectiveDte, 6),
                tdIvAppliedWeights: appliedWeights,
                tdIvExtrapolatedWeightDates: extrapolatedWeightDates,
            };
        });
    }

    function _normalizeExpiryKey(value) {
        const normalized = String(value || '').trim().replace(/-/g, '');
        return /^\d{8}$/.test(normalized) ? normalized : '';
    }

    function _getRowExpiry(row) {
        return _normalizeExpiryKey(row && (row.expiry || row.matchedExpiry));
    }

    function _quotePairTimeYears(callQuote, putQuote) {
        const callExpiryAsOf = String(callQuote && callQuote.expiryAsOf || '').trim();
        const putExpiryAsOf = String(putQuote && putQuote.expiryAsOf || '').trim();
        if (!callExpiryAsOf || callExpiryAsOf !== putExpiryAsOf) {
            return null;
        }
        const expiryMs = Date.parse(callExpiryAsOf);
        const callQuoteMs = Date.parse(String(callQuote && callQuote.quoteAsOf || '').trim());
        const putQuoteMs = Date.parse(String(putQuote && putQuote.quoteAsOf || '').trim());
        const quoteMs = Math.max(callQuoteMs, putQuoteMs);
        if (!Number.isFinite(expiryMs) || !Number.isFinite(callQuoteMs)
            || !Number.isFinite(putQuoteMs) || expiryMs <= quoteMs) {
            return null;
        }
        return (expiryMs - quoteMs) / (365 * 24 * 60 * 60 * 1000);
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
                const callBid = _coercePositiveNumber(callQuote && callQuote.bid);
                const callAsk = _coercePositiveNumber(callQuote && callQuote.ask);
                const putBid = _coercePositiveNumber(putQuote && putQuote.bid);
                const putAsk = _coercePositiveNumber(putQuote && putQuote.ask);
                const atmStraddleMark = _computeStraddleMark(callMark, putMark);
                const dte = Math.max(0, parseInt(entry && entry.dte, 10) || 0);
                const timeYears = _quotePairTimeYears(callQuote, putQuote)
                    || _coercePositiveNumber(entry && entry.timeYears);
                const tradDte = countTradingDays(anchorDate, entry && entry.expiry, calendarKey);
                const callIvTd = computeTradingDayAnnualizedIv(callIv, dte, tradDte, lambda);
                const putIvTd = computeTradingDayAnnualizedIv(putIv, dte, tradDte, lambda);

                return {
                    expiry: String(entry && entry.expiry || '').trim(),
                    dte,
                    timeYears,
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
                    callBid,
                    callAsk,
                    putBid,
                    putAsk,
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
                    callExpiryAsOf: String(callQuote && callQuote.expiryAsOf || '').trim(),
                    putExpiryAsOf: String(putQuote && putQuote.expiryAsOf || '').trim(),
                    callExpiryTimeSource: String(callQuote && callQuote.expiryTimeSource || '').trim(),
                    putExpiryTimeSource: String(putQuote && putQuote.expiryTimeSource || '').trim(),
                    callMarkSource: String(callQuote && callQuote.markSource || '').trim(),
                    putMarkSource: String(putQuote && putQuote.markSource || '').trim(),
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
                tdIvAnnualizationWeight: match && Number.isFinite(match.tdIvAnnualizationWeight)
                    ? match.tdIvAnnualizationWeight : null,
                tdIvEffectiveDte: match && Number.isFinite(match.tdIvEffectiveDte)
                    ? match.tdIvEffectiveDte : null,
                tdIvSource: match && match.tdIvSource || null,
                tdIvStatus: match && match.tdIvStatus || null,
                tdIvAppliedWeights: match && match.tdIvAppliedWeights
                    && typeof match.tdIvAppliedWeights === 'object'
                    ? { ...match.tdIvAppliedWeights }
                    : {},
                tdIvMissingWeightDates: match && Array.isArray(match.tdIvMissingWeightDates)
                    ? match.tdIvMissingWeightDates.slice()
                    : [],
                tdIvExtrapolatedWeightDates: match && Array.isArray(match.tdIvExtrapolatedWeightDates)
                    ? match.tdIvExtrapolatedWeightDates.slice()
                    : [],
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

    const IMPLIED_LAMBDA_DEFAULTS = Object.freeze({
        maxIntervalCalendarDays: 7,
        // Keep the per-day variance baseline local to the weekend being
        // solved: a wide window lets scheduled-event days (FOMC, CPI, month
        // end) a week away inflate the "normal day" and crush the lambda.
        baselineWindowDays: 7,
        minBaselines: 2,
        // A live 0DTE straddle is valuable: subtracting its observed total
        // variance from the next expiry removes the remaining Friday session
        // instead of pretending the session has already ended.
        minDte: 0,
        // Discounting/forward rate for the straddle price inversion.
        interestRate: 0.04,
        // A retained live discount curve must be reasonably close to the
        // option-surface trade date. Future-dated curves are always rejected.
        maxDiscountCurveAgeDays: 10,
        // Rows and adjacent-expiry pairs whose quote timestamps disagree by
        // more than this are rejected: the surface must be one coherent
        // snapshot, not an asynchronous patchwork. Null disables the check.
        maxQuoteSkewMs: 120000,
        // A date-only anchor cannot say how much variance remains in today's
        // session.  The synthetic anchor -> first-expiry interval is therefore
        // diagnostic-only unless the caller explicitly certifies that the
        // anchor is an official completed-session snapshot.
        frontIntervalVerified: false,
        // Live straddle inversion must be based on one complete server
        // snapshot, including the underlying used for the parity check.
        // Research callers can explicitly disable this gate; production code
        // should not.
        requireCoherentSnapshot: true,
        // The production exporter also requires ContractDetails expiry
        // instants for every row.  Direct research callers retain the old
        // date-only compatibility path unless they opt into this gate.
        requireExactExpiryTimestamps: false,
        // Maximum relative distance between the forward inferred from
        // call-put parity and the contemporaneous underlying-derived forward.
        maxForwardDeviationPct: 0.005,
        // Relative BBO width (ask-bid)/mid. A midpoint from a crossed or very
        // wide market is not a trustworthy executable price observation.
        maxBidAskSpreadPct: 0.35,
    });

    function _normalCdf(x) {
        const sign = x < 0 ? -1 : 1;
        const absX = Math.abs(x) / Math.sqrt(2.0);
        const t = 1.0 / (1.0 + 0.3275911 * absX);
        const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-absX * absX);
        return 0.5 * (1.0 + sign * y);
    }

    // European straddle price with total volatility s = sigma*sqrt(T) as the
    // free variable. Black-76 (futures options) takes the futures price as
    // the forward directly; the legacy standalone BSM helper builds the
    // no-dividend forward S*e^{rT}. Production straddle inversion below does
    // not use that q=0 shortcut: it first obtains F from call-put parity. Both
    // collapse to discount * [F*(2N(d1)-1) - K*(2N(d2)-1)], which decays to
    // discount*|F-K| as s -> 0 and is strictly increasing in s.
    // American early-exercise premium and discrete dividends are not modeled;
    // at the 1-60 DTE tenors this estimator targets, both are small next to
    // quote noise, but they are assumptions - not TWS's, ours.
    function priceStraddleFromTotalVol(pricingModel, underlyingPrice, strike, timeYears, rate, totalVol) {
        if (!(underlyingPrice > 0) || !(strike > 0) || !(timeYears > 0) || !(totalVol >= 0)) {
            return null;
        }
        const discount = Math.exp(-(Number.isFinite(rate) ? rate : 0) * timeYears);
        const forward = pricingModel === 'black76'
            ? underlyingPrice
            : underlyingPrice * Math.exp((Number.isFinite(rate) ? rate : 0) * timeYears);
        if (totalVol === 0) {
            return discount * Math.abs(forward - strike);
        }
        const d1 = Math.log(forward / strike) / totalVol + totalVol / 2;
        const d2 = d1 - totalVol;
        return discount * (
            forward * (2 * _normalCdf(d1) - 1)
            - strike * (2 * _normalCdf(d2) - 1)
        );
    }

    // Numerically invert the straddle price for the total implied variance
    // sigma^2*T. Uses only the observed price plus (F/S, K, T, r) and the
    // product's pricing model - no vendor IV. Returns null when the price
    // sits at or below the deterministic floor discount*|F-K| or beyond the
    // search bracket.
    function invertStraddleTotalVariance(pricingModel, underlyingPrice, strike, timeYears, rate, straddlePrice) {
        if (!(straddlePrice > 0)) {
            return null;
        }
        const floor = priceStraddleFromTotalVol(pricingModel, underlyingPrice, strike, timeYears, rate, 0);
        if (floor === null || straddlePrice <= floor * (1 + 1e-12) + 1e-12) {
            return null;
        }
        let lo = 0;
        let hi = 6; // 600% * sqrt(1y): far above any 1-60 DTE straddle
        if (priceStraddleFromTotalVol(pricingModel, underlyingPrice, strike, timeYears, rate, hi) < straddlePrice) {
            return null;
        }
        for (let i = 0; i < 80; i += 1) {
            const mid = (lo + hi) / 2;
            const price = priceStraddleFromTotalVol(pricingModel, underlyingPrice, strike, timeYears, rate, mid);
            if (price < straddlePrice) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        const totalVol = (lo + hi) / 2;
        return totalVol * totalVol;
    }

    // Resolve one visible expiry's cumulative total variance from the actual
    // two-sided ATM Call+Put market. This is deliberately independent of TWS
    // vendor IV and of the fitted lambda clock. Call-put parity supplies the
    // expiry-specific forward before the observed straddle midpoint is
    // inverted, so a displayed BBO price and displayed variance cannot come
    // from two different sources.
    function resolveStraddleTotalVarianceObservation(row, options) {
        const opts = options && typeof options === 'object' ? options : {};
        if (!row || row.subscriptionSelected === false) return null;
        const allowBestEffort = opts.allowBestEffort === true;
        const callBid = Number(row.callBid);
        const callAsk = Number(row.callAsk);
        const putBid = Number(row.putBid);
        const putAsk = Number(row.putAsk);
        const hasStrictBbo = row.callMarkSource === 'bid_ask_mid'
            && row.putMarkSource === 'bid_ask_mid'
            && [callBid, callAsk, putBid, putAsk].every(Number.isFinite)
            && callBid >= 0 && putBid >= 0 && callAsk > 0 && putAsk > 0
            && callAsk >= callBid && putAsk >= putBid;
        if (!hasStrictBbo && !allowBestEffort) {
            return null;
        }
        const fallbackCallMark = row.callMark === null || row.callMark === undefined || row.callMark === ''
            ? NaN
            : Number(row.callMark);
        const fallbackPutMark = row.putMark === null || row.putMark === undefined || row.putMark === ''
            ? NaN
            : Number(row.putMark);
        const callMark = hasStrictBbo ? (callBid + callAsk) / 2 : fallbackCallMark;
        const putMark = hasStrictBbo ? (putBid + putAsk) / 2 : fallbackPutMark;
        if (![callMark, putMark].every(Number.isFinite)
            || callMark < 0 || putMark < 0 || !(callMark + putMark > 0)) {
            return null;
        }
        const straddlePrice = callMark + putMark;
        const strike = _coercePositiveNumber(row.atmStrike);
        if (!(straddlePrice > 0) || strike === null) return null;

        const callAsOfMs = _quoteAsOfMs(row.callQuoteAsOf);
        const putAsOfMs = _quoteAsOfMs(row.putQuoteAsOf);
        const maxQuoteSkewMs = opts.maxQuoteSkewMs === null
            ? null
            : (Number.isFinite(Number(opts.maxQuoteSkewMs))
                ? Math.max(0, Number(opts.maxQuoteSkewMs))
                : 30 * 1000);
        const quoteSkewMs = callAsOfMs !== null && putAsOfMs !== null
            ? Math.abs(callAsOfMs - putAsOfMs)
            : null;
        const quoteSkewExceeded = maxQuoteSkewMs !== null && quoteSkewMs !== null
            && quoteSkewMs > maxQuoteSkewMs;
        if (quoteSkewExceeded && !allowBestEffort) {
            return null;
        }
        const isBestEffort = !hasStrictBbo || quoteSkewExceeded;

        const expiryAsOfMs = _rowExpiryAsOfMs(row);
        const rowQuoteAsOfMs = callAsOfMs !== null && putAsOfMs !== null
            ? Math.max(callAsOfMs, putAsOfMs)
            : null;
        const exactTimeYears = expiryAsOfMs !== null && rowQuoteAsOfMs !== null
            && expiryAsOfMs > rowQuoteAsOfMs
            ? (expiryAsOfMs - rowQuoteAsOfMs) / (365 * MS_PER_DAY)
            : null;
        const suppliedTimeYears = Number(row.timeYears);
        const dte = Number(row.dte);
        const timeYears = exactTimeYears !== null
            ? exactTimeYears
            : (Number.isFinite(suppliedTimeYears) && suppliedTimeYears > 0
                ? suppliedTimeYears
                : (Number.isFinite(dte) && dte > 0 ? dte / 365 : null));
        if (!(timeYears > 0)) return null;

        const interestRate = Number.isFinite(Number(opts.interestRate))
            ? Number(opts.interestRate)
            : 0;
        const discountObservation = _resolveDiscountObservation(
            opts.discountCurve && typeof opts.discountCurve === 'object'
                ? opts.discountCurve
                : null,
            timeYears,
            interestRate,
            'curve_unavailable'
        );
        const parityForward = strike
            + (callMark - putMark) / discountObservation.discountFactor;
        if (!(parityForward > 0)) return null;
        const totalVariance = invertStraddleTotalVariance(
            'black76',
            parityForward,
            strike,
            timeYears,
            discountObservation.zeroRate,
            straddlePrice
        );
        if (!(totalVariance >= 0)) return null;
        return {
            totalVariance,
            variancePoints: totalVariance * 10000,
            timeYears,
            timeSource: exactTimeYears !== null
                ? 'exact quote-to-expiry time'
                : (Number.isFinite(suppliedTimeYears) && suppliedTimeYears > 0
                    ? 'quote-pair time horizon'
                    : 'calendar DTE / 365'),
            straddlePrice,
            callMark,
            putMark,
            strike,
            parityForward,
            quoteAsOfMs: rowQuoteAsOfMs,
            expiryAsOfMs,
            discountObservation,
            varianceSource: isBestEffort
                ? 'straddle_display_mark_inversion'
                : 'straddle_bbo_inversion',
            isBestEffort,
            quoteSkewMs,
            quoteSkewExceeded,
            callMarkSource: String(row.callMarkSource || 'display_mark').trim() || 'display_mark',
            putMarkSource: String(row.putMarkSource || 'display_mark').trim() || 'display_mark',
        };
    }

    function _quoteAsOfMs(value) {
        const parsed = Date.parse(String(value || '').trim());
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _rowExpiryAsOfMs(row) {
        const callExpiryAsOf = String(row && row.callExpiryAsOf || '').trim();
        const putExpiryAsOf = String(row && row.putExpiryAsOf || '').trim();
        if (!callExpiryAsOf || callExpiryAsOf !== putExpiryAsOf) return null;
        return _quoteAsOfMs(callExpiryAsOf);
    }

    function _marketCurvesApi() {
        const api = globalScope.OptionComboMarketCurves;
        return api && typeof api.resolveDiscount === 'function' ? api : null;
    }

    function _manualDiscountObservation(timeYears, interestRate, reason = '') {
        return {
            zeroRate: interestRate,
            discountFactor: Math.exp(-interestRate * timeYears),
            source: 'manual_discount_rate_fallback',
            curveAsOf: null,
            curveId: null,
            isProxy: false,
            fallbackUsed: true,
            fallbackReason: String(reason || '').trim() || null,
            resolutionMethod: 'manual_fallback',
        };
    }

    // Resolve discounting independently for every expiry. Hybrid SOFR/CMT and
    // legacy Treasury inputs remain explicitly labelled as proxies;
    // degraded/proxy quality is usable, while stale or invalid observations
    // fall back to the visible manual continuous rate.
    function _resolveDiscountObservation(
        discountCurve,
        timeYears,
        interestRate,
        unavailableReason = 'curve_unavailable'
    ) {
        const api = _marketCurvesApi();
        if (!discountCurve) {
            return _manualDiscountObservation(timeYears, interestRate, unavailableReason);
        }
        if (!api) {
            return _manualDiscountObservation(timeYears, interestRate, 'curve_api_unavailable');
        }
        try {
            const resolved = api.resolveDiscount(
                discountCurve,
                { tenorDays: timeYears * 365 },
                { maxExtrapolationDays: 31 }
            );
            if (!resolved || resolved.usable === false
                || !(resolved.discountFactor > 0) || !Number.isFinite(resolved.zeroRate)) {
                return _manualDiscountObservation(timeYears, interestRate, 'curve_unusable_at_expiry');
            }
            const metadata = resolved.metadata && typeof resolved.metadata === 'object'
                ? resolved.metadata
                : {};
            return {
                zeroRate: resolved.zeroRate,
                discountFactor: resolved.discountFactor,
                source: String(metadata.source || discountCurve.metadata
                    && discountCurve.metadata.source || 'discount_curve'),
                curveAsOf: String(resolved.asOf || discountCurve.asOf || '').trim() || null,
                curveId: String(resolved.curveId || discountCurve.id || '').trim() || null,
                isProxy: discountCurve.isProxy === true
                    || discountCurve.discountSemantics === 'continuous_zero_proxy_from_cmt_par_yield'
                    || !!(metadata.quality && Array.isArray(metadata.quality.flags)
                        && (metadata.quality.flags.includes('cmt_par_yield_proxy')
                            || metadata.quality.flags.includes('reference_curve_is_proxy'))),
                fallbackUsed: false,
                fallbackReason: null,
                resolutionMethod: String(resolved.resolution
                    && resolved.resolution.method || '').trim() || null,
            };
        } catch (error) {
            return _manualDiscountObservation(
                timeYears,
                interestRate,
                error && error.message ? error.message : 'curve_resolution_failed'
            );
        }
    }

    function _discountCurveEligibility(discountCurve, anchorIso, maxAgeDays) {
        if (!discountCurve) {
            return { curve: null, usable: false, reason: 'curve_unavailable', ageDays: null };
        }
        const anchor = _parseUtcDate(anchorIso);
        const curveAsOf = _parseUtcDate(
            discountCurve.effectiveDate || discountCurve.asOf
        );
        if (!anchor) {
            return { curve: null, usable: false, reason: 'anchor_date_unavailable', ageDays: null };
        }
        if (!curveAsOf) {
            return { curve: null, usable: false, reason: 'curve_asof_unavailable', ageDays: null };
        }
        const ageDays = (anchor.getTime() - curveAsOf.getTime()) / MS_PER_DAY;
        if (ageDays < 0) {
            return { curve: null, usable: false, reason: 'curve_from_future', ageDays };
        }
        if (Number.isFinite(maxAgeDays) && ageDays > maxAgeDays) {
            return { curve: null, usable: false, reason: 'curve_stale', ageDays };
        }
        return { curve: discountCurve, usable: true, reason: null, ageDays };
    }

    function _resolveIndependentReferenceForward(
        opts,
        pricingModel,
        underlyingQuoteIsForward,
        spot,
        timeYears
    ) {
        const api = _marketCurvesApi();
        const tenorTarget = { tenorDays: timeYears * 365 };
        if (api && opts.forwardCurve && typeof api.resolveForward === 'function') {
            try {
                const resolved = api.resolveForward(opts.forwardCurve, tenorTarget, {
                    maxExtrapolationDays: 31,
                });
                if (resolved && resolved.usable !== false && resolved.forward > 0) {
                    return { forward: resolved.forward, source: 'forward_curve' };
                }
            } catch (_) {
                // Continue to the next independent source.
            }
        }
        if (api && opts.carryCurve && spot !== null
            && typeof api.resolveCarry === 'function'
            && typeof api.forwardFromSpotCarry === 'function') {
            try {
                const resolved = api.resolveCarry(opts.carryCurve, tenorTarget, {
                    maxExtrapolationDays: 31,
                });
                if (resolved && resolved.usable !== false && Number.isFinite(resolved.carryRate)) {
                    return {
                        forward: api.forwardFromSpotCarry({
                            spot,
                            carry: resolved,
                            timeYears,
                        }),
                        source: 'carry_curve',
                    };
                }
            } catch (_) {
                // Continue to the product-specific observation below.
            }
        }
        // A futures quote is already a forward observation. For spot/BSM
        // products there is no independent forward unless a Forward/Carry
        // curve was supplied; S*exp(rT) would silently assume q=0 and is not
        // a valid carry check for dividend-paying ETFs or cash indexes.
        if (underlyingQuoteIsForward && spot !== null) {
            return { forward: spot, source: 'underlying_future' };
        }
        return { forward: null, source: null };
    }

    function _median(values) {
        const ordered = values.slice().sort((left, right) => left - right);
        if (!ordered.length) {
            return null;
        }
        const mid = Math.floor(ordered.length / 2);
        return ordered.length % 2
            ? ordered[mid]
            : (ordered[mid - 1] + ordered[mid]) / 2;
    }

    function _madFilter(values, scale = 5) {
        if (values.length < 5) {
            return values;
        }
        const center = _median(values);
        const mad = _median(values.map((value) => Math.abs(value - center)));
        if (!(mad > 0)) {
            return values;
        }
        const limit = scale * 1.4826 * mad;
        return values.filter((value) => Math.abs(value - center) <= limit);
    }

    // Classify non-trading dates in [start, end).  Weekends and official
    // exchange closures receive the same lambda in the variance equation, but
    // keeping their kinds separate makes the exported evidence auditable.
    // Null means the official calendar is missing, stale, or out of coverage.
    function _classifyNonTradingDates(startDateStr, endDateStr, calendarKey) {
        const start = _parseUtcDate(startDateStr);
        const end = _parseUtcDate(endDateStr);
        if (!start || !end || start > end) {
            return null;
        }
        if (start < end) {
            if (typeof globalScope.isOfficialExchangeCalendarAvailable !== 'function'
                || typeof globalScope.isMarketHoliday !== 'function') {
                return null;
            }
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
        const dates = [];
        const weekendDates = [];
        const holidayDates = [];
        const kinds = {};
        const current = new Date(start);
        while (current < end) {
            const iso = current.toISOString().slice(0, 10);
            const dayOfWeek = current.getUTCDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const isHoliday = globalScope.isMarketHoliday(iso, calendarKey);
            if (!isWeekend && isHoliday === null) {
                return null;
            }
            if (isWeekend || isHoliday) {
                dates.push(iso);
                if (isHoliday) {
                    holidayDates.push(iso);
                    kinds[iso] = 'exchange_holiday';
                } else {
                    weekendDates.push(iso);
                    kinds[iso] = 'weekend';
                }
            }
            current.setUTCDate(current.getUTCDate() + 1);
        }
        return { dates, weekendDates, holidayDates, kinds };
    }

    // Solve the option-implied weight of a non-trading day (implied lambda)
    // from the sampled term structure itself. Adjacent-expiry forward variance
    // over pure trading-day intervals gives a local per-trading-day variance
    // baseline; an interval containing non-trading days then satisfies
    //   forwardVariance = baseline
    //     * (varianceTradingDays + lambda * varianceNonTradingDays).
    // Public integer day-count fields remain for export compatibility; the
    // variance* fields use the exact expiry-to-expiry timestamp segments.
    //
    // The production route exactly inverts each observed call+put midpoint.
    // Its per-expiry forward is inferred from call-put parity rather than
    // borrowing one global future/spot for every tenor. A futures quote (or an
    // explicitly supplied Forward/Carry curve) remains an independent quality
    // control observation. Cash spot alone is not: turning it into a forward
    // with S*exp(rT) would silently assert q=0. Vendor IV is retained only as
    // an explicit research cross-check.
    //
    // Identification still depends on a locally stable per-trading-day
    // baseline. Robust medians limit (but cannot eliminate) contamination by
    // scheduled event variance such as CPI or FOMC.
    function computeImpliedWeekendLambdas(detailRows, anchorDate, options) {
        const opts = {
            ...IMPLIED_LAMBDA_DEFAULTS,
            ...(options && typeof options === 'object' ? options : {}),
        };
        const calendarKey = String(opts.calendarKey || 'NYSE');
        const varianceSource = opts.varianceSource === 'vendor_iv' ? 'vendor_iv' : 'straddle';
        const pricingModel = opts.pricingModel === 'black76' ? 'black76' : 'bsm-spot';
        // Legacy direct callers inferred this from Black-76. Production pages
        // pass it explicitly because cash index options may use discounted-
        // forward pricing even though the subscribed underlying is spot.
        const underlyingQuoteIsForward = opts.underlyingQuoteIsForward === true
            || (opts.underlyingQuoteIsForward === undefined && pricingModel === 'black76');
        const interestRate = Number.isFinite(parseFloat(opts.interestRate))
            ? parseFloat(opts.interestRate)
            : IMPLIED_LAMBDA_DEFAULTS.interestRate;
        const discountCurve = opts.discountCurve && typeof opts.discountCurve === 'object'
            ? opts.discountCurve
            : null;
        const maxQuoteSkewMs = opts.maxQuoteSkewMs === null
            ? null
            : (Number.isFinite(parseFloat(opts.maxQuoteSkewMs))
                ? parseFloat(opts.maxQuoteSkewMs)
                : IMPLIED_LAMBDA_DEFAULTS.maxQuoteSkewMs);
        const maxForwardDeviationPct = opts.maxForwardDeviationPct === null
            ? null
            : (Number.isFinite(parseFloat(opts.maxForwardDeviationPct))
                && parseFloat(opts.maxForwardDeviationPct) >= 0
                ? parseFloat(opts.maxForwardDeviationPct)
                : IMPLIED_LAMBDA_DEFAULTS.maxForwardDeviationPct);
        const maxBidAskSpreadPct = opts.maxBidAskSpreadPct === null
            ? null
            : (Number.isFinite(parseFloat(opts.maxBidAskSpreadPct))
                && parseFloat(opts.maxBidAskSpreadPct) >= 0
                ? parseFloat(opts.maxBidAskSpreadPct)
                : IMPLIED_LAMBDA_DEFAULTS.maxBidAskSpreadPct);
        const frontIntervalVerified = opts.frontIntervalVerified === true;
        const requireExactExpiryTimestamps = varianceSource === 'straddle'
            && opts.requireExactExpiryTimestamps === true;
        const normalizedCalendarKey = calendarKey.trim().toUpperCase() || 'NYSE';
        const isFuturesCalendar = /^(?:CME|NYMEX|COMEX):/.test(normalizedCalendarKey);
        const intervalTimeZone = String(opts.timeZone || (
            isFuturesCalendar ? 'America/Chicago' : 'America/New_York'
        )).trim();
        const parsedRolloverHour = parseInt(opts.tradeDateRolloverHour, 10);
        const intervalTradeDateRolloverHour = Number.isFinite(parsedRolloverHour)
            ? Math.min(23, Math.max(0, parsedRolloverHour))
            : (isFuturesCalendar ? 17 : null);
        const requireCoherentSnapshot = varianceSource === 'straddle'
            && opts.requireCoherentSnapshot !== false;
        const spot = _coercePositiveNumber(opts.underlyingPrice);
        const anchorIso = (() => {
            const parsed = _parseUtcDate(anchorDate);
            return parsed ? parsed.toISOString().slice(0, 10) : null;
        })();
        const maxDiscountCurveAgeDays = opts.maxDiscountCurveAgeDays === null
            ? Number.POSITIVE_INFINITY
            : (Number.isFinite(parseFloat(opts.maxDiscountCurveAgeDays))
                && parseFloat(opts.maxDiscountCurveAgeDays) >= 0
                ? parseFloat(opts.maxDiscountCurveAgeDays)
                : IMPLIED_LAMBDA_DEFAULTS.maxDiscountCurveAgeDays);
        const discountCurveEligibility = _discountCurveEligibility(
            discountCurve,
            anchorIso,
            maxDiscountCurveAgeDays
        );
        const activeDiscountCurve = discountCurveEligibility.curve;

        const snapshotMetadata = opts.snapshotMetadata && typeof opts.snapshotMetadata === 'object'
            ? opts.snapshotMetadata
            : null;
        const snapshotId = String(snapshotMetadata
            && (snapshotMetadata.snapshotId || snapshotMetadata.batchId) || '').trim();
        const underlyingSnapshotId = String(snapshotMetadata
            && snapshotMetadata.underlyingSnapshotId || '').trim();
        const snapshotAsOfMs = _quoteAsOfMs(snapshotMetadata
            && (snapshotMetadata.quoteAsOf || snapshotMetadata.payloadAsOf));
        const underlyingAsOfMs = _quoteAsOfMs(snapshotMetadata
            && (snapshotMetadata.underlyingQuoteAsOf || snapshotMetadata.quoteAsOf || snapshotMetadata.payloadAsOf));
        const snapshotGate = (() => {
            if (!requireCoherentSnapshot) {
                return { ok: true, status: 'ok' };
            }
            if (!snapshotMetadata) {
                return { ok: false, status: 'missing_snapshot_metadata' };
            }
            if (snapshotMetadata.coherent !== true) {
                return { ok: false, status: 'incoherent_snapshot' };
            }
            if (snapshotMetadata.quoteComplete !== true) {
                return { ok: false, status: 'incomplete_snapshot' };
            }
            if (!snapshotId) {
                return { ok: false, status: 'missing_snapshot_id' };
            }
            if (!underlyingSnapshotId) {
                return { ok: false, status: 'missing_underlying_snapshot' };
            }
            if (underlyingSnapshotId !== snapshotId) {
                return { ok: false, status: 'underlying_snapshot_mismatch' };
            }
            if (maxQuoteSkewMs !== null) {
                if (snapshotAsOfMs === null || underlyingAsOfMs === null) {
                    return { ok: false, status: 'missing_snapshot_timestamp' };
                }
                if (Math.abs(snapshotAsOfMs - underlyingAsOfMs) > maxQuoteSkewMs) {
                    return { ok: false, status: 'underlying_stale_mix' };
                }
            }
            return { ok: true, status: 'ok' };
        })();

        // Straddle route eligibility is strict by design: both mids must come
        // from real two-sided markets (the backend falls back to TWS model
        // prices when bid/ask are missing - exactly what this route must not
        // consume), and the call, put and underlying must belong to one
        // complete server snapshot.
        const rowStraddlePoint = (row) => {
            if (!snapshotGate.ok) {
                return { status: snapshotGate.status };
            }
            if (row.callMarkSource !== 'bid_ask_mid' || row.putMarkSource !== 'bid_ask_mid') {
                return { status: 'non_market_mark' };
            }
            const callBid = _coercePositiveNumber(row.callBid);
            const callAsk = _coercePositiveNumber(row.callAsk);
            const putBid = _coercePositiveNumber(row.putBid);
            const putAsk = _coercePositiveNumber(row.putAsk);
            const strike = _coercePositiveNumber(row.atmStrike);
            if (callBid === null || callAsk === null || putBid === null || putAsk === null) {
                return { status: 'missing_bbo' };
            }
            if (callAsk < callBid || putAsk < putBid) {
                return { status: 'crossed_market' };
            }
            const callMark = (callBid + callAsk) / 2;
            const putMark = (putBid + putAsk) / 2;
            const callSpreadPct = (callAsk - callBid) / callMark;
            const putSpreadPct = (putAsk - putBid) / putMark;
            if (maxBidAskSpreadPct !== null
                && (callSpreadPct > maxBidAskSpreadPct || putSpreadPct > maxBidAskSpreadPct)) {
                return { status: 'wide_market', callSpreadPct, putSpreadPct };
            }
            if (strike === null || (underlyingQuoteIsForward && spot === null)) {
                return { status: 'incomplete_price_inputs' };
            }
            const rowCallSnapshotId = String(row.callSnapshotId || '').trim();
            const rowPutSnapshotId = String(row.putSnapshotId || '').trim();
            if (requireCoherentSnapshot) {
                if (!rowCallSnapshotId || !rowPutSnapshotId) {
                    return { status: 'missing_row_snapshot' };
                }
                if (rowCallSnapshotId !== snapshotId || rowPutSnapshotId !== snapshotId) {
                    return { status: 'mixed_snapshot' };
                }
            }
            const callAsOfMs = _quoteAsOfMs(row.callQuoteAsOf);
            const putAsOfMs = _quoteAsOfMs(row.putQuoteAsOf);
            const expiryAsOfMs = _rowExpiryAsOfMs(row);
            const rowQuoteAsOfMs = callAsOfMs !== null && putAsOfMs !== null
                ? Math.max(callAsOfMs, putAsOfMs)
                : null;
            if (requireExactExpiryTimestamps
                && (expiryAsOfMs === null || rowQuoteAsOfMs === null
                    || expiryAsOfMs <= rowQuoteAsOfMs)) {
                return { status: 'exact_expiry_timestamp_unavailable' };
            }
            if (maxQuoteSkewMs !== null) {
                if (callAsOfMs === null || putAsOfMs === null
                    || Math.abs(callAsOfMs - putAsOfMs) > maxQuoteSkewMs) {
                    return { status: 'stale_mix' };
                }
                if (requireCoherentSnapshot && (
                    Math.abs(callAsOfMs - underlyingAsOfMs) > maxQuoteSkewMs
                    || Math.abs(putAsOfMs - underlyingAsOfMs) > maxQuoteSkewMs
                )) {
                    return { status: 'underlying_stale_mix' };
                }
            }
            const suppliedTimeYears = parseFloat(row.timeYears);
            const oneMinuteYears = 1 / (365 * 24 * 60);
            const exactTimeYears = expiryAsOfMs !== null && rowQuoteAsOfMs !== null
                && expiryAsOfMs > rowQuoteAsOfMs
                ? (expiryAsOfMs - rowQuoteAsOfMs) / (365 * MS_PER_DAY)
                : null;
            const timeYears = exactTimeYears !== null
                ? exactTimeYears
                : (Number.isFinite(suppliedTimeYears) && suppliedTimeYears > 0
                    ? suppliedTimeYears
                    : Math.max(row.dte / 365, oneMinuteYears));
            const discountObservation = _resolveDiscountObservation(
                activeDiscountCurve,
                timeYears,
                interestRate,
                discountCurveEligibility.reason || 'curve_unavailable'
            );
            const parityForward = strike
                + (callMark - putMark) / discountObservation.discountFactor;
            if (!(parityForward > 0)) {
                return {
                    status: 'invalid_parity_forward',
                    discountObservation,
                };
            }
            const referenceObservation = _resolveIndependentReferenceForward(
                opts,
                pricingModel,
                underlyingQuoteIsForward,
                spot,
                timeYears
            );
            const referenceForward = referenceObservation.forward;
            const forwardDeviationPct = referenceForward > 0
                ? Math.abs(parityForward - referenceForward) / referenceForward
                : null;
            if (maxForwardDeviationPct !== null && Number.isFinite(forwardDeviationPct)
                && forwardDeviationPct > maxForwardDeviationPct) {
                return {
                    status: 'forward_mismatch',
                    parityForward,
                    referenceForward,
                    referenceForwardSource: referenceObservation.source,
                    forwardDeviationPct,
                    discountObservation,
                };
            }

            // Once parity has supplied F, the discounted-forward form is the
            // exact European inversion for both Black-76 and BSM. This also
            // avoids applying one global ES futures price to every expiry.
            const totalVariance = invertStraddleTotalVariance(
                'black76', parityForward, strike, timeYears,
                discountObservation.zeroRate, callMark + putMark
            );
            if (totalVariance === null) {
                return {
                    status: 'straddle_inversion_failed',
                    parityForward,
                    referenceForward,
                    referenceForwardSource: referenceObservation.source,
                    forwardDeviationPct,
                    discountObservation,
                };
            }
            return {
                status: 'ok',
                totalVariance,
                asOfMs: rowQuoteAsOfMs,
                expiryAsOfMs,
                expiryAsOf: expiryAsOfMs === null
                    ? null
                    : new Date(expiryAsOfMs).toISOString(),
                expiryTimeSource: row.callExpiryTimeSource
                    && row.callExpiryTimeSource === row.putExpiryTimeSource
                    ? row.callExpiryTimeSource
                    : 'contract',
                timeYears,
                snapshotId: rowCallSnapshotId || rowPutSnapshotId || null,
                parityForward,
                referenceForward,
                referenceForwardSource: referenceObservation.source,
                forwardDeviationPct,
                callSpreadPct,
                putSpreadPct,
                discountObservation,
            };
        };

        const rowPoint = (row) => {
            if (varianceSource === 'vendor_iv') {
                return Number.isFinite(row.atmIv) && row.atmIv > 0
                    ? {
                        status: 'ok',
                        totalVariance: row.atmIv * row.atmIv * (row.dte / 365),
                        asOfMs: snapshotAsOfMs,
                        snapshotId: snapshotId || null,
                    }
                    : { status: 'missing_vendor_iv' };
            }
            return rowStraddlePoint(row);
        };

        const eligibleRows = (Array.isArray(detailRows) ? detailRows : [])
            .filter((row) => row
                && Number.isFinite(row.dte) && row.dte >= opts.minDte
                && _getRowExpiry(row))
            .sort((left, right) => left.dte - right.dte);
        const rowDiagnostics = [];
        const points = [];
        for (const row of eligibleRows) {
            const evaluated = rowPoint(row);
            const status = evaluated && evaluated.status || 'unusable_row';
            rowDiagnostics.push({
                expiry: _getRowExpiry(row),
                dte: row.dte,
                status,
                expiryAsOf: evaluated && evaluated.expiryAsOf || null,
                expiryTimeSource: evaluated && evaluated.expiryTimeSource || null,
                timeYears: _roundNumber(evaluated && evaluated.timeYears, 12),
                snapshotId: evaluated && evaluated.snapshotId || null,
                parityForward: _roundNumber(evaluated && evaluated.parityForward, 6),
                referenceForward: _roundNumber(evaluated && evaluated.referenceForward, 6),
                referenceForwardSource: evaluated && evaluated.referenceForwardSource || null,
                forwardDeviationPct: _roundNumber(evaluated && evaluated.forwardDeviationPct, 8),
                callSpreadPct: _roundNumber(evaluated && evaluated.callSpreadPct, 8),
                putSpreadPct: _roundNumber(evaluated && evaluated.putSpreadPct, 8),
                discountRate: _roundNumber(evaluated && evaluated.discountObservation
                    && evaluated.discountObservation.zeroRate, 10),
                discountFactor: _roundNumber(evaluated && evaluated.discountObservation
                    && evaluated.discountObservation.discountFactor, 12),
                discountSource: evaluated && evaluated.discountObservation
                    && evaluated.discountObservation.source || null,
                discountCurveAsOf: evaluated && evaluated.discountObservation
                    && evaluated.discountObservation.curveAsOf || null,
                discountIsProxy: evaluated && evaluated.discountObservation
                    && evaluated.discountObservation.isProxy === true,
                discountFallbackUsed: evaluated && evaluated.discountObservation
                    && evaluated.discountObservation.fallbackUsed === true,
                discountFallbackReason: evaluated && evaluated.discountObservation
                    && evaluated.discountObservation.fallbackReason || null,
            });
            if (status !== 'ok' || !Number.isFinite(evaluated.totalVariance)
                || !(evaluated.totalVariance > 0)) {
                continue;
            }
            points.push({
                expiry: _getRowExpiry(row),
                dte: row.dte,
                totalVariance: evaluated.totalVariance,
                asOfMs: evaluated.asOfMs,
                expiryAsOfMs: evaluated.expiryAsOfMs,
                expiryAsOf: evaluated.expiryAsOf || null,
                expiryTimeSource: evaluated.expiryTimeSource || null,
                timeYears: evaluated.timeYears,
                horizonCalendarDays: Number.isFinite(evaluated.timeYears)
                    ? evaluated.timeYears * 365
                    : row.dte,
                snapshotId: evaluated.snapshotId || null,
                parityForward: evaluated.parityForward,
                referenceForward: evaluated.referenceForward,
                referenceForwardSource: evaluated.referenceForwardSource || null,
                forwardDeviationPct: evaluated.forwardDeviationPct,
                discountRate: evaluated.discountObservation
                    ? evaluated.discountObservation.zeroRate : null,
                discountFactor: evaluated.discountObservation
                    ? evaluated.discountObservation.discountFactor : null,
                discountSource: evaluated.discountObservation
                    ? evaluated.discountObservation.source : null,
                discountCurveAsOf: evaluated.discountObservation
                    ? evaluated.discountObservation.curveAsOf : null,
                discountIsProxy: evaluated.discountObservation
                    ? evaluated.discountObservation.isProxy === true : false,
                discountFallbackUsed: evaluated.discountObservation
                    ? evaluated.discountObservation.fallbackUsed === true : false,
            });
        }

        const intervals = [];
        const pushInterval = (startDateStr, endDateStr, front, back, isFront) => {
            const exactStartMs = isFront
                ? back.asOfMs
                : front.expiryAsOfMs;
            const exactEndMs = back.expiryAsOfMs;
            const exactTimestampInterval = Number.isFinite(exactStartMs)
                && Number.isFinite(exactEndMs)
                && exactEndMs > exactStartMs;
            const varianceCalendarDays = exactTimestampInterval
                ? (exactEndMs - exactStartMs) / MS_PER_DAY
                : back.dte - front.dte;
            const calendarDays = back.dte - front.dte;
            if (varianceCalendarDays <= 0
                || varianceCalendarDays > opts.maxIntervalCalendarDays) {
                return;
            }
            const dateUtils = globalScope.OptionComboDateUtils;
            const exactClock = exactTimestampInterval
                && dateUtils && typeof dateUtils.resolveWeightedTime === 'function'
                ? dateUtils.resolveWeightedTime(
                    exactStartMs,
                    exactEndMs,
                    0,
                    normalizedCalendarKey,
                    null,
                    intervalTimeZone,
                    intervalTradeDateRolloverHour
                )
                : null;
            const exactClockAvailable = !!(exactClock && exactClock.available === true);
            const fallbackAllowed = !requireExactExpiryTimestamps;
            // Preserve the original date-count evidence in the public fields
            // for existing exports/UI.  The variance* fields below are the
            // exact fractional clock used by the lambda equation.
            const dateTradingDays = countTradingDays(
                startDateStr, endDateStr, calendarKey
            );
            const fallbackNonTradingCalendar = _classifyNonTradingDates(
                startDateStr, endDateStr, calendarKey
            );
            const nonTradingDates = exactClockAvailable
                ? exactClock.nonTradingDates.slice()
                : (fallbackNonTradingCalendar ? fallbackNonTradingCalendar.dates : null);
            const nonTradingDateKinds = {};
            if (exactClockAvailable) {
                exactClock.segments.forEach((segment) => {
                    if (segment.kind !== 'trading') {
                        nonTradingDateKinds[segment.date] = segment.kind;
                    }
                });
            } else if (fallbackNonTradingCalendar) {
                Object.assign(nonTradingDateKinds, fallbackNonTradingCalendar.kinds);
            }
            const weekendDates = nonTradingDates === null
                ? null
                : nonTradingDates.filter(date => nonTradingDateKinds[date] === 'weekend');
            const holidayDates = nonTradingDates === null
                ? null
                : nonTradingDates.filter(date => nonTradingDateKinds[date] === 'exchange_holiday');
            const varianceTradingDays = exactClockAvailable
                ? exactClock.tradingDays
                : (fallbackAllowed ? dateTradingDays : null);
            const varianceNonTradingDays = exactClockAvailable
                ? exactClock.nonTradingDays
                : (fallbackAllowed && dateTradingDays !== null
                    ? calendarDays - dateTradingDays
                    : null);
            const intervalQuoteAsOfMs = [front.asOfMs, back.asOfMs]
                .filter(Number.isFinite)
                .reduce((latest, value) => latest === null || value > latest ? value : latest, null);
            intervals.push({
                startDate: startDateStr,
                startExpiry: isFront ? null : front.expiry,
                endExpiry: back.expiry,
                startAsOf: exactTimestampInterval
                    ? new Date(exactStartMs).toISOString()
                    : null,
                endAsOf: exactTimestampInterval
                    ? new Date(exactEndMs).toISOString()
                    : null,
                exactTimestampClock: exactClockAvailable,
                profileClockFallback: exactClockAvailable && (
                    back.expiryTimeSource === 'product-profile'
                    || (!isFront && front.expiryTimeSource === 'product-profile')
                ),
                clockStatus: exactClockAvailable
                    ? 'ok'
                    : (exactClock && exactClock.status || (
                        exactTimestampInterval ? 'exact_clock_unavailable' : 'date_only_compatibility'
                    )),
                calendarDays,
                tradingDays: dateTradingDays,
                nonTradingDays: dateTradingDays === null
                    ? null
                    : calendarDays - dateTradingDays,
                varianceCalendarDays,
                varianceTradingDays,
                varianceNonTradingDays,
                nonTradingDates,
                weekendDates,
                holidayDates,
                nonTradingDateKinds: nonTradingDates === null ? null : nonTradingDateKinds,
                forwardVariance: back.totalVariance - front.totalVariance,
                midDte: (
                    (Number.isFinite(front.horizonCalendarDays)
                        ? front.horizonCalendarDays : front.dte)
                    + (Number.isFinite(back.horizonCalendarDays)
                        ? back.horizonCalendarDays : back.dte)
                ) / 2,
                quoteSkewMs: Number.isFinite(front.asOfMs) && Number.isFinite(back.asOfMs)
                    ? Math.abs(back.asOfMs - front.asOfMs)
                    : null,
                quoteAsOf: Number.isFinite(intervalQuoteAsOfMs)
                    ? new Date(intervalQuoteAsOfMs).toISOString()
                    : null,
                snapshotId: back.snapshotId || front.snapshotId || snapshotId || null,
                isFront,
                frontIntervalVerified: !isFront || frontIntervalVerified,
            });
        };

        if (anchorIso && points.length) {
            pushInterval(
                anchorIso, points[0].expiry,
                { dte: 0, totalVariance: 0, asOfMs: null }, points[0], true
            );
        }
        for (let i = 0; i + 1 < points.length; i += 1) {
            pushInterval(points[i].expiry, points[i + 1].expiry, points[i], points[i + 1], false);
        }

        const intervalIsCoherent = (interval) => maxQuoteSkewMs === null
            || interval.quoteSkewMs === null
            || interval.quoteSkewMs <= maxQuoteSkewMs;

        const pure = intervals.filter((interval) => interval.varianceTradingDays !== null
            && interval.varianceNonTradingDays === 0
            && interval.varianceTradingDays > 0
            && interval.forwardVariance > 0
            && (!interval.isFront || frontIntervalVerified)
            && intervalIsCoherent(interval));

        const weekendIntervals = intervals
            .filter((interval) => interval.varianceNonTradingDays === null
                || interval.varianceNonTradingDays > 0)
            .map((interval) => {
                const result = {
                    ...interval,
                    baselineVariance: null,
                    baselineCount: 0,
                    baselineMode: null,
                    rawLambda: null,
                    lambda: null,
                    lambdaClamped: null,
                    status: 'ok',
                };
                if (interval.isFront && !frontIntervalVerified) {
                    result.status = 'unverified_front';
                    return result;
                }
                if (interval.varianceTradingDays === null
                    || interval.varianceNonTradingDays === null
                    || interval.nonTradingDates === null) {
                    result.status = 'calendar_unavailable';
                    return result;
                }
                if (!intervalIsCoherent(interval)) {
                    result.status = 'stale_mix';
                    return result;
                }
                if (!(interval.forwardVariance > 0)) {
                    result.status = 'nonpositive_forward_variance';
                    return result;
                }
                let candidates = _madFilter(pure
                    .filter((candidate) => Math.abs(candidate.midDte - interval.midDte) <= opts.baselineWindowDays)
                    .map((candidate) => (
                        candidate.forwardVariance / candidate.varianceTradingDays
                    )));
                let baselineMode = 'local';
                if (candidates.length < opts.minBaselines) {
                    // Once the listed chain switches from daily to weekly
                    // expiries there may be no pure-trading interval near a
                    // later weekend. Use the nearest observed pure intervals
                    // as an explicitly flagged extrapolated baseline instead
                    // of deleting every later weekend from the curve.
                    candidates = _madFilter(pure
                        .slice()
                        .sort((left, right) => (
                            Math.abs(left.midDte - interval.midDte)
                            - Math.abs(right.midDte - interval.midDte)
                        ))
                        .slice(0, Math.max(opts.minBaselines, 3))
                        .map((candidate) => (
                            candidate.forwardVariance / candidate.varianceTradingDays
                        )));
                    baselineMode = 'nearest_extrapolated';
                    if (!candidates.length) {
                        result.status = 'no_baseline';
                        return result;
                    }
                }
                const baseline = _median(candidates);
                if (!(baseline > 0)) {
                    result.status = 'no_baseline';
                    return result;
                }
                const lambda = (
                    interval.forwardVariance / baseline - interval.varianceTradingDays
                ) / interval.varianceNonTradingDays;
                result.baselineVariance = baseline;
                result.baselineCount = candidates.length;
                result.baselineMode = baselineMode;
                result.rawLambda = _roundNumber(lambda, 6);
                result.lambda = _roundNumber(lambda, 4);
                result.lambdaClamped = _roundNumber(Math.min(1, Math.max(0, lambda)), 4);
                result.conventionalRange = lambda < -1e-8
                    ? 'inverted'
                    : (lambda > 1 + 1e-8 ? 'above_calendar' : 'inside');
                result.isInverted = lambda < -1e-8;
                return result;
            });

        const coherenceFailureStatuses = new Set([
            'missing_row_snapshot',
            'mixed_snapshot',
            'stale_mix',
            'underlying_stale_mix',
        ]);
        const rowCoherenceFailure = varianceSource === 'straddle'
            ? rowDiagnostics.find((row) => coherenceFailureStatuses.has(row.status)) || null
            : null;
        const exactExpiryEvidenceFailure = requireExactExpiryTimestamps && !points.length
            ? rowDiagnostics.find(
                row => row.status === 'exact_expiry_timestamp_unavailable'
            ) || null
            : null;
        const byDate = {};
        if (!rowCoherenceFailure) {
            for (const interval of weekendIntervals) {
                if (interval.status !== 'ok' || !Array.isArray(interval.nonTradingDates)) {
                    continue;
                }
                for (const iso of interval.nonTradingDates) {
                    byDate[iso] = interval.lambda;
                }
            }
        }
        const okLambdas = rowCoherenceFailure
            ? []
            : weekendIntervals
                .filter((interval) => interval.status === 'ok')
                .map((interval) => interval.lambda);
        const coveredDates = Object.keys(byDate).sort();
        const quoteAsOfMs = points
            .map((point) => point.asOfMs)
            .filter(Number.isFinite)
            .reduce((latest, value) => latest === null || value > latest ? value : latest, null);
        let qualityStatus = 'ok';
        if (varianceSource === 'straddle' && !snapshotGate.ok) {
            qualityStatus = snapshotGate.status;
        } else if (rowCoherenceFailure) {
            qualityStatus = rowCoherenceFailure.status;
        } else if (exactExpiryEvidenceFailure) {
            qualityStatus = exactExpiryEvidenceFailure.status;
        } else if (!points.length) {
            qualityStatus = 'no_usable_rows';
        } else if (!okLambdas.length) {
            qualityStatus = 'no_usable_intervals';
        }

        const discountedRows = rowDiagnostics.filter((row) => Number.isFinite(row.discountRate));
        const fallbackDiscountRows = discountedRows.filter((row) => row.discountFallbackUsed === true);
        const curveDiscountRows = discountedRows.filter((row) => row.discountFallbackUsed !== true);
        const discountSources = [...new Set(
            curveDiscountRows.map((row) => row.discountSource).filter(Boolean)
        )];
        const curveMetadata = discountCurve && discountCurve.metadata
            && typeof discountCurve.metadata === 'object'
            ? discountCurve.metadata
            : {};
        const discounting = {
            convention: 'continuous_annualized',
            fallbackRate: interestRate,
            curveConfigured: !!discountCurve,
            curveUsable: discountCurveEligibility.usable,
            curveFallbackReason: discountCurveEligibility.reason,
            curveAgeDays: Number.isFinite(discountCurveEligibility.ageDays)
                ? discountCurveEligibility.ageDays
                : null,
            maxCurveAgeDays: Number.isFinite(maxDiscountCurveAgeDays)
                ? maxDiscountCurveAgeDays
                : null,
            curveId: discountCurve ? String(discountCurve.id || '').trim() || null : null,
            curveAsOf: discountCurve
                ? String(discountCurve.effectiveDate || discountCurve.asOf || '').trim() || null
                : null,
            curveQuoteAsOf: discountCurve
                ? String(curveMetadata.quoteAsOf || '').trim() || null
                : null,
            source: discountSources.length === 1
                ? discountSources[0]
                : (discountSources.length > 1 ? 'mixed' : 'manual_discount_rate_fallback'),
            isProxy: curveDiscountRows.some((row) => row.discountIsProxy === true),
            curveRowCount: curveDiscountRows.length,
            fallbackRowCount: fallbackDiscountRows.length,
            fallbackUsed: fallbackDiscountRows.length > 0,
        };

        return {
            anchorDate: anchorIso,
            calendarKey,
            varianceSource,
            pricingModel,
            interestRate,
            discounting,
            methodology: {
                pricingModel,
                estimationMode: opts.estimationMode === 'best_effort'
                    ? 'best_effort'
                    : 'strict',
                sourceQuoteEvidence: String(opts.sourceQuoteEvidence || '').trim() || null,
                underlyingQuoteIsForward,
                // Compatibility scalar: this is the manual fallback, not an
                // assertion that one rate discounted every expiry.
                interestRate,
                discounting,
                baselineWindowDays: opts.baselineWindowDays,
                minBaselines: opts.minBaselines,
                maxIntervalCalendarDays: opts.maxIntervalCalendarDays,
                minDte: opts.minDte,
                maxDiscountCurveAgeDays: Number.isFinite(maxDiscountCurveAgeDays)
                    ? maxDiscountCurveAgeDays
                    : null,
                maxQuoteSkewMs,
                maxForwardDeviationPct,
                maxBidAskSpreadPct,
                requireExactExpiryTimestamps,
                intervalClock: requireExactExpiryTimestamps
                    ? 'contract-expiry-fractional-seconds'
                    : 'exact-when-available-date-compatibility',
                intervalTimeZone,
                intervalTradeDateRolloverHour,
            },
            snapshotId: snapshotId || null,
            underlyingSnapshotId: underlyingSnapshotId || null,
            quoteAsOf: Number.isFinite(quoteAsOfMs)
                ? new Date(quoteAsOfMs).toISOString()
                : (Number.isFinite(snapshotAsOfMs) ? new Date(snapshotAsOfMs).toISOString() : null),
            intervals: weekendIntervals,
            rowDiagnostics,
            pureIntervalCount: pure.length,
            okIntervalCount: okLambdas.length,
            byDate,
            medianLambda: okLambdas.length ? _roundNumber(_median(okLambdas), 4) : null,
            coverageStart: coveredDates.length ? coveredDates[0] : null,
            coverageEnd: coveredDates.length ? coveredDates[coveredDates.length - 1] : null,
            quality: {
                status: qualityStatus,
                coherent: varianceSource === 'straddle'
                    ? snapshotGate.ok && !rowCoherenceFailure
                    : !!(snapshotMetadata && snapshotMetadata.coherent === true
                        && snapshotId && underlyingSnapshotId === snapshotId),
                quoteComplete: !!(snapshotMetadata
                    && snapshotMetadata.quoteComplete === true),
                estimationMode: opts.estimationMode === 'best_effort'
                    ? 'best_effort'
                    : 'strict',
                strictSnapshot: varianceSource === 'straddle'
                    && opts.estimationMode !== 'best_effort',
                sourceQuoteEvidence: String(opts.sourceQuoteEvidence || '').trim() || null,
                snapshotId: snapshotId || null,
                underlyingSnapshotId: underlyingSnapshotId || null,
                usablePointCount: points.length,
                rejectedRowCount: rowDiagnostics.filter((row) => row.status !== 'ok').length,
            },
        };
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

    // Pairwise slope of the DISPLAYED ATM TD IV against a baseline expiry.
    // The shorter-DTE leg stays on top, so >1 reads as backwardation no matter
    // which side is selected as the baseline. This column intentionally uses
    // row.atmIvTd after straddle-implied-lambda correction. The separately
    // backtested regime signal below remains frozen at lambda=0.3.
    function annotateTdSlopeVsBaseline(rows, baselineExpiry) {
        const sourceRows = Array.isArray(rows) ? rows : [];
        const normalizedBaseline = _normalizeExpiryKey(baselineExpiry);
        const baselineRow = normalizedBaseline
            ? sourceRows.find((row) => row && row.hasCompletePair !== false
                && _getRowExpiry(row) === normalizedBaseline) || null
            : null;
        const baselineTd = baselineRow && Number.isFinite(baselineRow.atmIvTd)
            && baselineRow.atmIvTd > 0
            ? baselineRow.atmIvTd
            : null;

        return sourceRows.map((row) => {
            let slope = null;
            let pairRatio = null;
            if (baselineTd != null && row && row.hasCompletePair !== false
                && _getRowExpiry(row) !== normalizedBaseline) {
                const rowTd = Number.isFinite(row.atmIvTd) && row.atmIvTd > 0
                    ? row.atmIvTd
                    : null;
                if (rowTd != null) {
                    slope = row.dte >= baselineRow.dte ? baselineTd / rowTd : rowTd / baselineTd;
                    pairRatio = Math.max(row.dte, baselineRow.dte) / Math.min(row.dte, baselineRow.dte);
                }
            }
            return {
                ...(row && typeof row === 'object' ? row : {}),
                tdSlopeVsBaseline: slope != null ? _roundNumber(slope, 4) : null,
                tdSlopeSource: 'display_atm_td_iv',
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
        applyImpliedLambdaClockToRows,
        buildExpiryDetailRows,
        buildBucketRows,
        buildStraddleComparisonRows,
        priceStraddleFromTotalVol,
        invertStraddleTotalVariance,
        resolveStraddleTotalVarianceObservation,
        computeImpliedWeekendLambdas,
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
