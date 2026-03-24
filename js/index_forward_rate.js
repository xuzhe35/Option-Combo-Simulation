/**
 * Helpers for INDEX forward-rate samples.
 *
 * First implementation: derive a daily carry estimate from one call/put pair
 * at the same strike + expiry using a synthetic-forward approximation:
 *
 *   F ~= K + (Call_mid - Put_mid)
 *   dailyCarry = ln(F / spot) / DTE
 *
 * This keeps the UI and subscription pipeline moving before a fuller
 * discount-factor-aware implementation is wired in.
 */

(function attachIndexForwardRate(globalScope) {
    function _toFiniteNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _getQuoteMid(quote) {
        if (!quote || typeof quote !== 'object') {
            return null;
        }

        const bid = _toFiniteNumber(quote.bid);
        const ask = _toFiniteNumber(quote.ask);
        if (bid !== null && ask !== null && bid > 0 && ask > 0) {
            return (bid + ask) / 2;
        }

        return _toFiniteNumber(quote.mark);
    }

    function buildSampleSubscriptionId(sample, right) {
        const suffix = String(right || '').trim().toLowerCase() === 'put' ? 'put' : 'call';
        return `__forward_rate_${sample && sample.id ? sample.id : 'sample'}_${suffix}`;
    }

    function _normalizeExpiryDate(value) {
        return String(value || '').trim().slice(0, 10);
    }

    function _getCarryCandidates(samples) {
        return (Array.isArray(samples) ? samples : [])
            .filter(sample => sample && Number.isFinite(_toFiniteNumber(sample.dailyCarry)));
    }

    function resolveDailyCarryForTarget(samples, target) {
        const normalizedTarget = Math.max(0, parseInt(target && target.daysToExpiry, 10) || 0);
        const normalizedExpiry = _normalizeExpiryDate(target && target.expDate);
        const candidates = _getCarryCandidates(samples);

        if (candidates.length === 0) {
            return null;
        }

        if (normalizedExpiry) {
            const exactExpiryMatch = candidates.find(sample =>
                _normalizeExpiryDate(sample && sample.expDate) === normalizedExpiry
            );
            if (exactExpiryMatch) {
                return _toFiniteNumber(exactExpiryMatch.dailyCarry);
            }
        }

        const exactDayMatch = candidates.find(sample =>
            Math.max(0, parseInt(sample && sample.daysToExpiry, 10) || 0) === normalizedTarget
        );
        if (exactDayMatch) {
            return _toFiniteNumber(exactDayMatch.dailyCarry);
        }

        let best = candidates[0];
        let bestDistance = Math.abs((parseInt(best.daysToExpiry, 10) || 0) - normalizedTarget);

        for (let i = 1; i < candidates.length; i += 1) {
            const sample = candidates[i];
            const distance = Math.abs((parseInt(sample.daysToExpiry, 10) || 0) - normalizedTarget);
            if (distance < bestDistance) {
                best = sample;
                bestDistance = distance;
            }
        }

        return _toFiniteNumber(best.dailyCarry);
    }

    function resolveDailyCarryForDays(samples, targetDays) {
        return resolveDailyCarryForTarget(samples, { daysToExpiry: targetDays });
    }

    function resolveForwardPriceFromSpot(spotPrice, dailyCarry, daysToExpiry) {
        const spot = _toFiniteNumber(spotPrice);
        const carry = _toFiniteNumber(dailyCarry);
        const days = Math.max(0, parseInt(daysToExpiry, 10) || 0);

        if (spot === null || spot <= 0 || carry === null) {
            return spot;
        }

        return spot * Math.exp(carry * days);
    }

    function computeSampleSnapshot(sample, state, quotes) {
        const strike = _toFiniteNumber(sample && sample.strike);
        const daysToExpiry = Math.max(0, parseInt(sample && sample.daysToExpiry, 10) || 0);
        const spot = _toFiniteNumber(state && state.underlyingPrice);
        const callMid = _getQuoteMid(quotes && quotes.callQuote);
        const putMid = _getQuoteMid(quotes && quotes.putQuote);

        if (strike === null || daysToExpiry <= 0 || spot === null || spot <= 0 || callMid === null || putMid === null) {
            return null;
        }

        const syntheticForward = strike + (callMid - putMid);
        if (!Number.isFinite(syntheticForward) || syntheticForward <= 0) {
            return null;
        }

        const dailyCarry = Math.log(syntheticForward / spot) / daysToExpiry;
        const impliedRate = dailyCarry * 365;

        return {
            callMid,
            putMid,
            syntheticForward,
            dailyCarry,
            impliedRate,
        };
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
        const snapshot = computeSampleSnapshot(sample, state, { callQuote, putQuote });

        if (!snapshot) {
            return {
                callQuote,
                putQuote,
                snapshot: null,
            };
        }

        sample.dailyCarry = snapshot.dailyCarry;
        sample.impliedRate = snapshot.impliedRate;
        sample.lastComputedAt = new Date().toISOString();
        sample.isStale = false;

        return {
            callQuote,
            putQuote,
            snapshot,
        };
    }

    globalScope.OptionComboIndexForwardRate = {
        buildSampleSubscriptionId,
        computeSampleSnapshot,
        refreshForwardRateSample,
        resolveDailyCarryForTarget,
        resolveDailyCarryForDays,
        resolveForwardPriceFromSpot,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
