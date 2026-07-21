/**
 * Helpers for INDEX forward-rate samples.
 *
 * Derive an expiry-specific forward and carry from one coherent call/put pair
 * at the same strike + expiry using discount-aware European parity:
 *
 *   F = K + (Call_mid - Put_mid) / D(T)
 *   carry = ln(F / spot) / T = r-q
 *
 * Discount r(T) and carry r-q are deliberately separate.  The compatibility
 * fields dailyCarry/impliedRate remain readable by older saved sessions.
 */

(function attachIndexForwardRate(globalScope) {
    const marketCurves = globalScope.OptionComboMarketCurves;
    const MAX_QUOTE_SKEW_MS = 30 * 1000;
    const MAX_FORWARD_SAMPLE_AGE_MS = 2 * 60 * 1000;
    const MAX_LIVE_DISCOUNT_CURVE_AGE_DAYS = 10;
    const MILLISECONDS_PER_DAY = 86400000;
    function _toFiniteNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _getRealBboMid(quote, requireQualityEvidence = false) {
        if (!quote || typeof quote !== 'object') {
            return null;
        }

        const bid = _toFiniteNumber(quote.bid);
        const ask = _toFiniteNumber(quote.ask);
        if (bid === null || bid < 0 || ask === null || ask < 0 || ask < bid) {
            return null;
        }

        if (requireQualityEvidence) {
            return quote.bidAskValid === true
                && quote.bidPresent === true
                && quote.askPresent === true
                ? (bid + ask) / 2
                : null;
        }

        const markSource = String(quote.markSource || '').trim();
        const hasValidityFlag = typeof quote.bidAskValid === 'boolean';
        const hasPresenceFlags = Object.prototype.hasOwnProperty.call(quote, 'bidPresent')
            || Object.prototype.hasOwnProperty.call(quote, 'askPresent');
        let isRealBbo;
        if (hasValidityFlag) {
            isRealBbo = quote.bidAskValid === true;
        } else if (hasPresenceFlags || markSource) {
            isRealBbo = markSource === 'bid_ask_mid';
        } else {
            // Compatibility for pre-quality-field snapshots: raw uncrossed
            // bid/ask values were the only available BBO evidence.
            isRealBbo = true;
        }

        return isRealBbo && quote.bidPresent !== false && quote.askPresent !== false
            ? (bid + ask) / 2
            : null;
    }

    function _getReferenceQuotePrice(quote) {
        return _getRealBboMid(quote, true);
    }

    function buildSampleSubscriptionId(sample, right) {
        const suffix = String(right || '').trim().toLowerCase() === 'put' ? 'put' : 'call';
        return `__forward_rate_${sample && sample.id ? sample.id : 'sample'}_${suffix}`;
    }

    function _normalizeExpiryDate(value) {
        return String(value || '').trim().slice(0, 10);
    }

    function _sampleIsFreshForTarget(sample, target) {
        if (!sample || sample.isStale === true) return false;
        const referenceMs = Date.parse(String(target && target.quoteAsOf || '').trim());
        const sampleMs = Date.parse(String(sample.quoteAsOf || sample.lastComputedAt || '').trim());
        if (!Number.isFinite(referenceMs) || !Number.isFinite(sampleMs)) {
            // Legacy samples have no timestamp evidence. They remain readable
            // only when the caller also has no live timestamp to validate.
            return !Number.isFinite(referenceMs);
        }
        const ageMs = referenceMs - sampleMs;
        return ageMs >= -MAX_QUOTE_SKEW_MS && ageMs <= MAX_FORWARD_SAMPLE_AGE_MS;
    }

    function _getCarryCandidates(samples, target) {
        return (Array.isArray(samples) ? samples : [])
            .filter(sample => _sampleIsFreshForTarget(sample, target)
                && Number.isFinite(_toFiniteNumber(sample.carryRate)
                    ?? _toFiniteNumber(sample.impliedRate)
                    ?? (_toFiniteNumber(sample.dailyCarry) !== null
                        ? _toFiniteNumber(sample.dailyCarry) * 365
                        : null)));
    }

    function _sampleCarryRate(sample) {
        return _toFiniteNumber(sample && sample.carryRate)
            ?? _toFiniteNumber(sample && sample.impliedRate)
            ?? (_toFiniteNumber(sample && sample.dailyCarry) !== null
                ? _toFiniteNumber(sample.dailyCarry) * 365
                : null);
    }

    function _sampleTenorDays(sample) {
        const exactTenor = _toFiniteNumber(sample && sample.tenorDays);
        if (exactTenor !== null && exactTenor >= 0) return exactTenor;
        const configuredTenor = _toFiniteNumber(sample && sample.daysToExpiry);
        return configuredTenor !== null && configuredTenor >= 0 ? configuredTenor : 0;
    }

    function _sampleCarryObservation(sample, resolutionMethod) {
        const carryRate = _sampleCarryRate(sample);
        if (!Number.isFinite(carryRate)) return null;
        return {
            kind: 'carry',
            carryRate,
            source: 'option_put_call_parity',
            pricingUse: 'derive_index_forward_from_spot',
            expDate: _normalizeExpiryDate(sample && sample.expDate),
            expiryAsOf: String(sample && sample.expiryAsOf || '').trim(),
            tenorSeconds: _toFiniteNumber(sample && sample.tenorSeconds),
            tenorDays: _sampleTenorDays(sample),
            timeYears: _toFiniteNumber(sample && sample.timeYears)
                ?? (_sampleTenorDays(sample) / 365),
            forwardPrice: _toFiniteNumber(sample && sample.forwardPrice),
            spotPrice: _toFiniteNumber(sample && sample.spotPrice),
            discountRate: _toFiniteNumber(sample && sample.discountRate),
            discountFactor: _toFiniteNumber(sample && sample.discountFactor),
            discountSource: String(sample && sample.discountSource || '').trim(),
            quoteAsOf: String(sample && (sample.quoteAsOf || sample.lastComputedAt) || '').trim(),
            sampleId: String(sample && sample.id || '').trim(),
            quality: sample && sample.quality && typeof sample.quality === 'object'
                ? { ...sample.quality }
                : { status: 'unknown', flags: ['legacy_sample_quality_unknown'] },
            resolution: { method: resolutionMethod },
            usable: sample && sample.isStale !== true,
        };
    }

    function resolveCarryObservationForTarget(samples, target) {
        const targetTenor = _toFiniteNumber(target && target.daysToExpiry);
        const normalizedTarget = Math.max(0, targetTenor === null ? 0 : targetTenor);
        const normalizedExpiry = _normalizeExpiryDate(target && target.expDate);
        const candidates = _getCarryCandidates(samples, target);
        if (candidates.length === 0) return null;

        if (normalizedExpiry) {
            const exactExpiryMatch = candidates.find(sample =>
                _normalizeExpiryDate(sample && sample.expDate) === normalizedExpiry
            );
            if (exactExpiryMatch) return _sampleCarryObservation(exactExpiryMatch, 'exact_expiry');
        }

        if (marketCurves && typeof marketCurves.createCarryCurve === 'function'
            && typeof marketCurves.resolveCarry === 'function') {
            try {
                const asOf = _normalizeExpiryDate(target && target.asOf)
                    || _normalizeExpiryDate(candidates[0] && candidates[0].daysToExpiryAsOf)
                    || '1970-01-01';
                const curve = marketCurves.createCarryCurve({
                    asOf,
                    maxInterpolationGapDays: 370,
                    maxExtrapolationDays: 370,
                    source: 'option_put_call_parity',
                    points: candidates
                        .map(sample => ({
                            tenorDays: _sampleTenorDays(sample),
                            carryRate: _sampleCarryRate(sample),
                            quoteAsOf: sample.quoteAsOf || sample.lastComputedAt || '',
                            stale: sample.isStale === true,
                            quality: sample.quality || { status: 'good' },
                        }))
                        .filter((point, index, points) => points.findIndex(candidate =>
                            candidate.tenorDays === point.tenorDays
                        ) === index),
                });
                const resolved = marketCurves.resolveCarry(curve, normalizedTarget, {
                    maxExtrapolationDays: 370,
                });
                if (resolved && resolved.usable !== false && Number.isFinite(resolved.carryRate)) {
                    return {
                        ...resolved,
                        source: 'option_put_call_parity',
                        pricingUse: 'derive_index_forward_from_spot',
                        expDate: normalizedExpiry || resolved.expiry || '',
                        forwardPrice: null,
                        spotPrice: null,
                        sampleId: '',
                    };
                }
            } catch (_error) {
                // Fall through to exact-tenor / nearest compatibility logic.
            }
        }

        const exactDayMatch = candidates.find(sample =>
            Math.abs(_sampleTenorDays(sample) - normalizedTarget) <= 1e-9
        );
        if (exactDayMatch) return _sampleCarryObservation(exactDayMatch, 'exact_tenor');

        let best = candidates[0];
        let bestDistance = Math.abs(_sampleTenorDays(best) - normalizedTarget);
        for (let i = 1; i < candidates.length; i += 1) {
            const distance = Math.abs(_sampleTenorDays(candidates[i]) - normalizedTarget);
            if (distance < bestDistance) {
                best = candidates[i];
                bestDistance = distance;
            }
        }
        return _sampleCarryObservation(best, 'nearest_legacy');
    }

    function resolveCarryRateForTarget(samples, target) {
        const observation = resolveCarryObservationForTarget(samples, target);
        return observation && Number.isFinite(observation.carryRate)
            ? observation.carryRate
            : null;
    }

    function buildCarrySnapshot(samples, context) {
        const input = context && typeof context === 'object' ? context : {};
        const asOf = _normalizeExpiryDate(input.asOf)
            || _normalizeExpiryDate((Array.isArray(samples) ? samples : []).find(Boolean)?.daysToExpiryAsOf)
            || '';
        const points = _getCarryCandidates(samples, input)
            .map(sample => _sampleCarryObservation(sample, 'observed'))
            .filter(Boolean)
            .sort((left, right) => left.tenorDays - right.tenorDays);
        return {
            schemaVersion: 1,
            kind: 'carry',
            asOf,
            source: 'option_put_call_parity',
            carrySemantics: 'equity_index_net_carry',
            discountCurveIndependent: true,
            points,
            quality: {
                status: points.length > 0 ? 'good' : 'unavailable',
                flags: points.length > 0 ? [] : ['no_fresh_parity_samples'],
            },
        };
    }

    function resolveDailyCarryForTarget(samples, target) {
        const carryRate = resolveCarryRateForTarget(samples, target);
        return Number.isFinite(carryRate) ? carryRate / 365 : null;
    }

    function resolveDailyCarryForDays(samples, targetDays) {
        return resolveDailyCarryForTarget(samples, { daysToExpiry: targetDays });
    }

    function resolveForwardPriceFromSpot(spotPrice, dailyCarry, daysToExpiry) {
        const spot = _toFiniteNumber(spotPrice);
        const carry = _toFiniteNumber(dailyCarry);
        const rawDays = _toFiniteNumber(daysToExpiry);
        const days = Math.max(0, rawDays === null ? 0 : rawDays);

        if (spot === null || spot <= 0 || carry === null) {
            return spot;
        }

        return spot * Math.exp(carry * days);
    }

    function _quoteAsOfMs(quote) {
        const parsed = Date.parse(String(quote && quote.quoteAsOf || '').trim());
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _expiryAsOfMs(quote) {
        const parsed = Date.parse(String(quote && quote.expiryAsOf || '').trim());
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _contractTimingIsExact(quote) {
        return !!(quote
            && String(quote.expiryTimingSource || '').trim() === 'ib_contract_details'
            && _expiryAsOfMs(quote) !== null);
    }

    function _normalizeContractDate(value) {
        const digits = String(value || '').replace(/\D/g, '');
        return digits.length >= 8 ? digits.slice(0, 8) : '';
    }

    function _signedCalendarDayDifference(startDate, endDate) {
        const start = String(startDate || '').trim().slice(0, 10);
        const end = String(endDate || '').trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
            return null;
        }
        const difference = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
        return Number.isFinite(difference) ? Math.round(difference / 86400000) : null;
    }

    function _resolveDiscount(state, daysToExpiry) {
        const fallbackRate = _toFiniteNumber(state && state.interestRate) ?? 0;
        const timeYears = daysToExpiry / 365;
        if (state && state.useMarketDiscountCurve !== false
            && marketCurves && typeof marketCurves.resolveDiscount === 'function'
            && state.discountCurve && state.discountCurve.kind === 'discount'
            && String(state.discountCurve.currency || '').trim().toUpperCase() === 'USD') {
            try {
                const quoteDate = state.marketDataMode === 'historical'
                    ? (state.historicalQuoteDate || state.baseDate || '')
                    : (state.liveQuoteDate || state.baseDate || '');
                // Compare the economic data date: a weekend updater run stamps
                // asOf after the Friday session the data belongs to.
                const curveDataDate = state.discountCurve.effectiveDate
                    || state.discountCurve.asOf;
                const ageDays = quoteDate && curveDataDate
                    ? _signedCalendarDayDifference(curveDataDate, quoteDate)
                    : null;
                if (Number.isFinite(ageDays)
                    && (ageDays < 0 || (state.marketDataMode !== 'historical'
                        && ageDays > MAX_LIVE_DISCOUNT_CURVE_AGE_DAYS))) {
                    throw new RangeError('discount curve is not valid for the quote date');
                }
                const resolved = marketCurves.resolveDiscount(state.discountCurve, daysToExpiry, {
                    maxExtrapolationDays: Math.max(31, Number(state.discountCurve.maxExtrapolationDays) || 0),
                });
                if (resolved && resolved.usable !== false) return resolved;
            } catch (_error) {
                // Visible manual fallback below.
            }
        }
        return {
            kind: 'discount',
            zeroRate: fallbackRate,
            discountFactor: Math.exp(-fallbackRate * timeYears),
            source: 'manual_fallback',
            metadata: { source: 'manual_fallback' },
        };
    }

    function _computeSampleSnapshotResult(sample, state, quotes) {
        const strike = _toFiniteNumber(sample && sample.strike);
        const underlyingQuote = quotes && quotes.underlyingQuote;
        const spot = _getReferenceQuotePrice(underlyingQuote);
        // Put/call parity is an observed-market carry measurement.  A TWS
        // model/last mark may be a useful valuation fallback, but it is not a
        // tradable BBO and must not enter this estimator.
        const callQuote = quotes && quotes.callQuote;
        const putQuote = quotes && quotes.putQuote;
        const callMid = _getRealBboMid(callQuote, true);
        const putMid = _getRealBboMid(putQuote, true);

        if (strike === null) return { snapshot: null, reason: 'sample_strike_unavailable' };
        if (spot === null || spot <= 0) return { snapshot: null, reason: 'underlying_bbo_unavailable' };
        if (callMid === null) return { snapshot: null, reason: 'call_bbo_unavailable' };
        if (putMid === null) return { snapshot: null, reason: 'put_bbo_unavailable' };

        const evidenceTimes = [
            _quoteAsOfMs(callQuote),
            _quoteAsOfMs(putQuote),
            _quoteAsOfMs(underlyingQuote),
        ];
        const availableTimes = evidenceTimes.filter(Number.isFinite);
        if (availableTimes.length !== evidenceTimes.length) {
            return { snapshot: null, reason: 'quote_timestamp_evidence_missing' };
        }
        const quoteSkewMs = availableTimes.length > 1
            ? Math.max(...availableTimes) - Math.min(...availableTimes)
            : 0;
        if (quoteSkewMs > MAX_QUOTE_SKEW_MS) {
            return { snapshot: null, reason: 'quote_timestamp_skew_exceeded' };
        }

        if (!_contractTimingIsExact(callQuote) || !_contractTimingIsExact(putQuote)) {
            return { snapshot: null, reason: 'contract_expiry_timing_missing' };
        }
        const callExpiryMs = _expiryAsOfMs(callQuote);
        const putExpiryMs = _expiryAsOfMs(putQuote);
        if (callExpiryMs !== putExpiryMs) {
            return { snapshot: null, reason: 'call_put_expiry_timing_mismatch' };
        }
        const sampleExpiry = _normalizeContractDate(sample && sample.expDate);
        const callLastTradeDate = _normalizeContractDate(callQuote && callQuote.lastTradeDate);
        const putLastTradeDate = _normalizeContractDate(putQuote && putQuote.lastTradeDate);
        if (sampleExpiry && (callLastTradeDate !== sampleExpiry || putLastTradeDate !== sampleExpiry)) {
            return { snapshot: null, reason: 'contract_expiry_identity_mismatch' };
        }

        // The three prices are asynchronous but tightly gated above. Use the
        // latest evidence instant as the common parity anchor so neither the
        // discount factor nor annualized carry receives time that had already
        // elapsed when the last consumed quote arrived.
        const quoteAsOfMs = Math.max(...availableTimes);
        const tenorMilliseconds = callExpiryMs - quoteAsOfMs;
        if (!(tenorMilliseconds > 0)) {
            return { snapshot: null, reason: 'contract_already_expired' };
        }
        const tenorSeconds = tenorMilliseconds / 1000;
        const tenorDays = tenorMilliseconds / MILLISECONDS_PER_DAY;
        const timeYears = tenorDays / 365;

        const referenceMs = Date.parse(String(state && state.liveQuoteAsOf || '').trim());
        if (Number.isFinite(referenceMs)) {
            const ageMs = referenceMs - quoteAsOfMs;
            if (ageMs < -MAX_QUOTE_SKEW_MS || ageMs > MAX_FORWARD_SAMPLE_AGE_MS) {
                return { snapshot: null, reason: 'quote_evidence_stale' };
            }
        }

        const discount = _resolveDiscount(state, tenorDays);
        const discountFactor = _toFiniteNumber(discount && discount.discountFactor);
        if (!(discountFactor > 0)) {
            return { snapshot: null, reason: 'discount_factor_unavailable' };
        }
        let syntheticForward = null;
        try {
            syntheticForward = marketCurves && typeof marketCurves.forwardFromPutCallParity === 'function'
                ? marketCurves.forwardFromPutCallParity({
                    strike,
                    callPrice: callMid,
                    putPrice: putMid,
                    discountFactor,
                })
                : strike + (callMid - putMid) / discountFactor;
        } catch (_error) {
            syntheticForward = null;
        }
        if (!Number.isFinite(syntheticForward) || syntheticForward <= 0) {
            return { snapshot: null, reason: 'put_call_parity_invalid' };
        }

        const carryRate = Math.log(syntheticForward / spot) / timeYears;
        const dailyCarry = carryRate / 365;
        const quoteAsOf = new Date(quoteAsOfMs).toISOString();
        const expiryAsOf = new Date(callExpiryMs).toISOString();

        return { snapshot: {
            callMid,
            putMid,
            spot,
            syntheticForward,
            forwardPrice: syntheticForward,
            dailyCarry,
            carryRate,
            impliedRate: carryRate,
            discountRate: discount.zeroRate,
            discountFactor,
            discountSource: discount.metadata && discount.metadata.source || discount.source || 'unknown',
            quoteAsOf,
            expiryAsOf,
            quoteSkewMs,
            tenorSeconds,
            tenorDays,
            timeYears,
            quality: { status: 'good', flags: [] },
        }, reason: '' };
    }

    function computeSampleSnapshot(sample, state, quotes) {
        return _computeSampleSnapshotResult(sample, state, quotes).snapshot;
    }

    const SAMPLE_VALUE_FIELDS = [
        'dailyCarry', 'carryRate', 'impliedRate', 'forwardPrice', 'spotPrice',
        'discountRate', 'discountFactor', 'tenorSeconds', 'tenorDays', 'timeYears',
    ];

    function _setSampleField(sample, key, value) {
        if (sample[key] === value) return false;
        sample[key] = value;
        return true;
    }

    function invalidateForwardRateSample(sample, reason = 'parity_evidence_unavailable') {
        if (!sample || typeof sample !== 'object') return false;
        let changed = false;
        SAMPLE_VALUE_FIELDS.forEach((key) => {
            changed = _setSampleField(sample, key, null) || changed;
        });
        changed = _setSampleField(sample, 'discountSource', '') || changed;
        changed = _setSampleField(sample, 'quoteAsOf', '') || changed;
        changed = _setSampleField(sample, 'expiryAsOf', '') || changed;
        changed = _setSampleField(sample, 'quoteSkewMs', null) || changed;
        changed = _setSampleField(sample, 'isStale', true) || changed;
        changed = _setSampleField(sample, 'unavailableReason', String(reason || 'parity_evidence_unavailable')) || changed;
        const nextQuality = JSON.stringify({
            status: 'unavailable',
            flags: [String(reason || 'parity_evidence_unavailable')],
        });
        if (JSON.stringify(sample.quality || null) !== nextQuality) {
            sample.quality = JSON.parse(nextQuality);
            changed = true;
        }
        return changed;
    }

    function refreshForwardRateSample(sample, state, quoteSource) {
        if (!sample || typeof sample !== 'object') {
            return null;
        }

        const callQuote = quoteSource && typeof quoteSource.getOptionQuote === 'function'
            ? quoteSource.getOptionQuote(buildSampleSubscriptionId(sample, 'call'))
            : null;
        const putQuote = quoteSource && typeof quoteSource.getOptionQuote === 'function'
            ? quoteSource.getOptionQuote(buildSampleSubscriptionId(sample, 'put'))
            : null;
        const underlyingQuote = quoteSource && typeof quoteSource.getUnderlyingQuote === 'function'
            ? quoteSource.getUnderlyingQuote()
            : null;
        const result = _computeSampleSnapshotResult(sample, state, { callQuote, putQuote, underlyingQuote });
        const snapshot = result.snapshot;

        if (!snapshot) {
            const changed = invalidateForwardRateSample(sample, result.reason);
            return {
                callQuote,
                putQuote,
                snapshot: null,
                reason: result.reason,
                changed,
            };
        }

        let changed = false;
        const nextFields = {
            dailyCarry: snapshot.dailyCarry,
            carryRate: snapshot.carryRate,
            impliedRate: snapshot.impliedRate,
            forwardPrice: snapshot.forwardPrice,
            spotPrice: snapshot.spot,
            discountRate: snapshot.discountRate,
            discountFactor: snapshot.discountFactor,
            discountSource: snapshot.discountSource,
            quoteAsOf: snapshot.quoteAsOf,
            expiryAsOf: snapshot.expiryAsOf,
            quoteSkewMs: snapshot.quoteSkewMs,
            tenorSeconds: snapshot.tenorSeconds,
            tenorDays: snapshot.tenorDays,
            timeYears: snapshot.timeYears,
            lastComputedAt: snapshot.quoteAsOf,
            isStale: false,
            unavailableReason: '',
        };
        Object.entries(nextFields).forEach(([key, value]) => {
            changed = _setSampleField(sample, key, value) || changed;
        });
        if (JSON.stringify(sample.quality || null) !== JSON.stringify(snapshot.quality)) {
            sample.quality = { ...snapshot.quality, flags: [...snapshot.quality.flags] };
            changed = true;
        }

        return {
            callQuote,
            putQuote,
            snapshot,
            reason: '',
            changed,
        };
    }

    globalScope.OptionComboIndexForwardRate = {
        buildSampleSubscriptionId,
        computeSampleSnapshot,
        refreshForwardRateSample,
        invalidateForwardRateSample,
        resolveCarryObservationForTarget,
        resolveCarryRateForTarget,
        resolveDailyCarryForTarget,
        resolveDailyCarryForDays,
        resolveForwardPriceFromSpot,
        buildCarrySnapshot,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
