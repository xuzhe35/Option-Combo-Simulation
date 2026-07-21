/**
 * Pure pricing helpers shared by the browser app and tests.
 */

(function attachPricingCore(globalScope) {
    const dateUtils = globalScope.OptionComboDateUtils;
    const productRegistry = globalScope.OptionComboProductRegistry;
    if (!dateUtils) {
        throw new Error('OptionComboDateUtils must be loaded before pricing_core.js');
    }

    const {
        diffDays, calendarToTradingDays, countWeightedDays, normalizeDateInput,
        normalizeWeekendWeightSpec, isTradingDay,
        resolveExpiryCutoffAsOf, resolveWeightedTime,
    } = dateUtils;

    // Simulation time basis: weight of a non-trading day (weekend/holiday)
    // relative to a trading day. 1 = pure calendar clock (TWS convention,
    // historical behavior), 0 = pure trading-day clock, in between = weighted.
    // Configured from app state via configureSimTimeBasis(); defaults to the
    // legacy calendar clock so nothing changes until the user opts in.
    let simTimeBasisWeekendWeight = 1;
    let simObservedTradingDates = null;

    function normalizeWeekendWeight(value) {
        if (value !== null && typeof value === 'object') {
            // Per-date weights ({default, byDate}) are kept in spec form so
            // countWeightedDays can weigh each non-trading date on its own.
            return normalizeWeekendWeightSpec(value);
        }
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return 1;
        }
        return Math.min(1, Math.max(0, parsed));
    }

    // Scalar lambda that anchors the effective-year length for a weight
    // setting. Per-date overrides deliberately do not move the year length:
    // the effYear cancels between convertIvToWeightedClock and T, so only
    // the ratio of weighted day counts prices — the default keeps both on
    // the same clock.
    function weekendWeightDefault(weekendWeight) {
        if (weekendWeight !== null && typeof weekendWeight === 'object') {
            const parsed = parseFloat(weekendWeight.default);
            return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
        }
        const parsed = parseFloat(weekendWeight);
        return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
    }

    // True when the configured weight differs from the pure calendar clock
    // for at least one day, i.e. the weighted-clock path must run.
    function weekendWeightActive(weekendWeight) {
        if (weekendWeight !== null && typeof weekendWeight === 'object') {
            const spec = normalizeWeekendWeightSpec(weekendWeight);
            return spec.minWeight < 1;
        }
        return weekendWeightDefault(weekendWeight) < 1;
    }

    function configureSimTimeBasis(options) {
        simTimeBasisWeekendWeight = normalizeWeekendWeight(options && options.weekendWeight);
        simObservedTradingDates = options && Array.isArray(options.observedTradingDates)
            ? options.observedTradingDates.slice()
            : null;
        return simTimeBasisWeekendWeight;
    }

    function getSimTimeBasisWeekendWeight() {
        return simTimeBasisWeekendWeight;
    }

    // Effective days per year on the weighted clock: 252 trading days plus
    // the non-trading remainder at its configured weight. At weight 1 this is
    // exactly 365, reproducing the calendar clock.
    function weightedDaysPerYear(weekendWeight) {
        return 252 + (365 - 252) * weekendWeightDefault(weekendWeight);
    }

    // Convert a calendar-annualized IV (TWS convention) onto the weighted
    // clock, preserving the option's total variance as of the anchor date:
    // iv^2 * (anchorCalDte/365) === converted^2 * (anchorEffDte/effYear).
    function convertIvToWeightedClock(iv, anchorCalDte, anchorEffDte, weekendWeight) {
        if (!Number.isFinite(iv) || iv <= 0
            || !Number.isFinite(anchorCalDte) || anchorCalDte <= 0
            || !Number.isFinite(anchorEffDte) || anchorEffDte <= 0) {
            return iv;
        }
        const effYear = weightedDaysPerYear(weekendWeight);
        return iv * Math.sqrt((anchorCalDte / 365.0) / (anchorEffDte / effYear));
    }

    // Resolve the terminal-distribution horizon on exactly the same variance
    // clock used by option repricing.  Unlike the old scalar split, `steps`
    // preserves every non-trading date so an IVTS {default, byDate} curve can
    // assign different lambdas to different weekends and full holidays.
    // Missing official/observed calendar coverage is a hard unavailable state;
    // silently changing back to a calendar clock would mix two time bases.
    function resolveSimHorizonClock(
        startDateStr,
        endDateStr,
        calendarKey = 'NYSE',
        marketDataMode = 'live'
    ) {
        const startKey = _normalizeIsoDate(startDateStr);
        const endKey = _normalizeIsoDate(endDateStr);
        const start = _parseIsoUtcDate(startKey);
        const end = _parseIsoUtcDate(endKey);
        const normalizedCalendarKey = String(calendarKey || 'NYSE').trim().toUpperCase() || 'NYSE';
        const unavailable = (status) => ({
            available: false,
            status,
            calendarKey: normalizedCalendarKey,
            calDays: 0,
            tradingDays: 0,
            nonTradingDays: 0,
            effDays: null,
            effYear: null,
            steps: [],
            stepWeights: [],
            isCalendarClock: false,
        });

        if (!start || !end || start > end) {
            return unavailable('invalid_horizon');
        }

        const calDays = Math.round((end.getTime() - start.getTime()) / 86400000);
        const weightSpec = normalizeWeekendWeightSpec(simTimeBasisWeekendWeight);
        const historicalMode = marketDataMode === 'historical';
        const observedTradingDates = historicalMode ? simObservedTradingDates : null;
        if (historicalMode
            && (!Array.isArray(observedTradingDates) || observedTradingDates.length === 0)) {
            return {
                ...unavailable('calendar_unavailable'),
                calDays,
            };
        }
        // `isTradingDay()` can classify a weekend without consulting the
        // official snapshot. Prove live coverage for the whole non-empty
        // interval up front so an all-weekend horizon cannot slip beyond a
        // stale or out-of-range exchange calendar.
        if (!historicalMode && calDays > 0) {
            const lastIncluded = new Date(end);
            lastIncluded.setUTCDate(lastIncluded.getUTCDate() - 1);
            const lastIncludedKey = lastIncluded.toISOString().slice(0, 10);
            if (typeof globalScope.isOfficialExchangeCalendarAvailable !== 'function'
                || !globalScope.isOfficialExchangeCalendarAvailable(
                    normalizedCalendarKey,
                    startKey,
                    lastIncludedKey
                )) {
                return {
                    ...unavailable('calendar_unavailable'),
                    calDays,
                };
            }
        }
        const verifiedTradingDays = calendarToTradingDays(
            startKey,
            endKey,
            normalizedCalendarKey,
            observedTradingDates
        );
        if (verifiedTradingDays === null) {
            return {
                ...unavailable('calendar_unavailable'),
                calDays,
            };
        }

        const steps = [];
        let tradingDays = 0;
        let nonTradingDays = 0;
        let effDays = 0;
        let usedPerDateWeight = false;
        const current = new Date(start);
        while (current < end) {
            const date = current.toISOString().slice(0, 10);
            const tradingDay = isTradingDay(
                date,
                normalizedCalendarKey,
                observedTradingDates
            );
            if (tradingDay === null) {
                return {
                    ...unavailable('calendar_unavailable'),
                    calDays,
                };
            }

            let kind = 'trading';
            let weight = 1;
            if (tradingDay) {
                tradingDays += 1;
            } else {
                nonTradingDays += 1;
                const hasDateOverride = !!(
                    weightSpec.byDate
                    && Object.prototype.hasOwnProperty.call(weightSpec.byDate, date)
                );
                weight = hasDateOverride ? weightSpec.byDate[date] : weightSpec.default;
                usedPerDateWeight = usedPerDateWeight || hasDateOverride;
                const weekday = current.getUTCDay();
                kind = weekday === 0 || weekday === 6 ? 'weekend' : 'exchange_holiday';
            }
            if (!Number.isFinite(weight)) {
                return {
                    ...unavailable('invalid_weight'),
                    calDays,
                };
            }
            effDays += weight;
            steps.push({ date, kind, weight });
            current.setUTCDate(current.getUTCDate() + 1);
        }

        // Defensive agreement check: the detailed enumeration and the shared
        // official-calendar counter must never describe different horizons.
        if (tradingDays !== verifiedTradingDays || steps.length !== calDays) {
            return {
                ...unavailable('calendar_inconsistent'),
                calDays,
            };
        }

        const effYear = weightedDaysPerYear(weightSpec);
        return {
            available: true,
            status: 'ok',
            calendarKey: normalizedCalendarKey,
            calDays,
            tradingDays,
            nonTradingDays,
            effDays,
            effYear,
            defaultNonTradingWeight: weightSpec.default,
            usedPerDateWeight,
            steps,
            stepWeights: steps.map(step => step.weight),
            isCalendarClock: steps.every(step => step.weight === 1),
        };
    }

    function floorWeightedDteBeforeExpiry(calendarDte, effectiveDte) {
        if (Number.isFinite(effectiveDte) && calendarDte > 0 && effectiveDte <= 0) {
            // A zero or inverted aggregate clock can otherwise mark a
            // still-live option to intrinsic before its final trading session
            // has happened. Keep a small live horizon as the safety floor;
            // individual signed weekend weights remain visible and auditable.
            return 0.5;
        }
        return effectiveDte;
    }

    function _normalizeIsoDate(value) {
        const normalized = String(value || '').trim().replace(/\//g, '-');
        return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
    }

    function _parseIsoUtcDate(value) {
        const normalized = _normalizeIsoDate(value);
        if (!normalized) return null;
        const parsed = new Date(`${normalized}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime())
            || parsed.toISOString().slice(0, 10) !== normalized) {
            return null;
        }
        return parsed;
    }

    const MILLISECONDS_PER_DAY = 86400000;
    // General quote freshness may remain 120 seconds, but a short-dated local
    // IV inversion is a multi-instrument atomic calibration.  Keep option,
    // Forward/spot and portfolio clock evidence within 30 seconds so a leg
    // with only minutes left cannot absorb a material asynchronous move.
    const MAX_LOCAL_IV_QUOTE_SKEW_MS = 30000;

    function _parseTimestamp(value) {
        const parsed = Date.parse(String(value || '').trim());
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _tradeDateRolloverHour(calendarKey) {
        return /^(?:CME|NYMEX|COMEX):/.test(String(calendarKey || '').toUpperCase())
            ? 17
            : null;
    }

    function _resolveExpiryCutoffMs(leg, expiryDate, profile) {
        if (typeof resolveExpiryCutoffAsOf !== 'function') return null;
        return resolveExpiryCutoffAsOf(leg, profile, expiryDate || null);
    }

    function resolveSameDayLiveTiming(leg, simulatedDate, quoteDate, quoteAsOf, profile) {
        const expiryDate = _normalizeIsoDate(leg && leg.expDate);
        if (!expiryDate || _normalizeIsoDate(simulatedDate) !== expiryDate
            || _normalizeIsoDate(quoteDate) !== expiryDate) {
            return null;
        }
        const quoteMs = _parseTimestamp(quoteAsOf);
        const cutoff = _resolveExpiryCutoffMs(leg, null, profile);
        if (!Number.isFinite(quoteMs) || !cutoff
            || !Number.isFinite(cutoff.cutoffMs) || quoteMs >= cutoff.cutoffMs) return null;
        const cutoffTimeYears = (cutoff.cutoffMs - quoteMs) / (365 * MILLISECONDS_PER_DAY);
        return {
            timeYears: cutoffTimeYears,
            calendarDte: cutoffTimeYears * 365,
            cutoffAsOf: cutoff.cutoffAsOf || new Date(cutoff.cutoffMs).toISOString(),
            timeSource: cutoff.source,
        };
    }

    function _resolveExactLegTiming(
        leg,
        simulatedDate,
        quoteDate,
        profile,
        marketDataMode,
        timingContext,
        calendarKey,
        weekendWeight
    ) {
        const context = timingContext && typeof timingContext === 'object'
            ? timingContext
            : {};
        const rawTargetAsOf = String(context.targetAsOf || '').trim();
        const referenceQuoteAsOf = String(context.quoteAsOf || '').trim();
        const referenceQuoteMs = _parseTimestamp(referenceQuoteAsOf);
        const observablePriceSource = String(context.observablePriceSource || '').trim();
        const observablePriceAsOf = String(context.observablePriceAsOf || '').trim();
        const observablePriceMs = _parseTimestamp(observablePriceAsOf);
        const bboTimestampFresh = observablePriceSource === 'live_midpoint'
            && context.observablePriceFresh === true
            && observablePriceMs !== null
            && referenceQuoteMs !== null
            && Math.abs(observablePriceMs - referenceQuoteMs) <= MAX_LOCAL_IV_QUOTE_SKEW_MS;
        // A locally inverted IV belongs to the option BBO timestamp, not to a
        // portfolio-wide "last update" stamp that can be a few seconds later.
        const rawQuoteAsOf = bboTimestampFresh ? observablePriceAsOf : referenceQuoteAsOf;
        const requestedTarget = rawTargetAsOf !== '';
        const requestedQuote = rawQuoteAsOf !== '';
        let quoteMs = _parseTimestamp(rawQuoteAsOf);
        let quoteSource = quoteMs === null
            ? null
            : (bboTimestampFresh ? 'observable-bbo' : 'market-quote');
        let targetMs = _parseTimestamp(rawTargetAsOf);
        let targetSource = String(context.targetSource || '').trim() || null;

        if (requestedTarget && targetMs === null) {
            return {
                requested: true,
                active: false,
                available: false,
                status: 'target_timestamp_invalid',
                quoteMs,
                targetMs: null,
                quoteAsOf: quoteMs === null ? null : new Date(quoteMs).toISOString(),
                quoteSource,
                targetAsOf: null,
                targetSource,
                expiry: _resolveExpiryCutoffMs(leg, null, profile),
                observablePrice: null,
                bboTimestampFresh,
            };
        }

        const expiry = _resolveExpiryCutoffMs(leg, null, profile);
        // The portfolio current point is observable at each leg's own BBO
        // timestamp. Align that one boundary point to the BBO; future scenario
        // targets keep their explicit common portfolio instant.  A same-day
        // near leg remains intrinsic after its cutoff even when its last BBO
        // was stamped just before expiry, so never move a target across the
        // option's own cutoff while making this per-leg alignment.
        const isCurrentQuoteTarget = targetSource === 'live-quote'
            || targetSource === 'live-quote-after-near-leg-cutoff';
        const preservesExpiryState = !expiry || !Number.isFinite(expiry.cutoffMs)
            || !Number.isFinite(targetMs) || !Number.isFinite(quoteMs)
            || (targetMs >= expiry.cutoffMs) === (quoteMs >= expiry.cutoffMs);
        if (bboTimestampFresh && isCurrentQuoteTarget && preservesExpiryState) {
            targetMs = quoteMs;
        }

        // Backward-compatible current-quote behavior: legacy callers already
        // pass quoteAsOf but have no separate targetAsOf. On the quote date the
        // observable quote instant is the valuation target. Future date-only
        // callers retain their old integer-date clock until they pass a target.
        if (targetMs === null
            && quoteMs !== null
            && _normalizeIsoDate(simulatedDate) === _normalizeIsoDate(quoteDate)) {
            targetMs = quoteMs;
            targetSource = targetSource || 'quote';
        }

        // Historical replay and explicitly opted-in legacy callers can have a
        // date but no intraday quote stamp. They may synthesize the quote-date
        // product cutoff so equal-cutoff intervals reproduce the old clock.
        // Live mode never does this: a synthetic quote time would manufacture
        // false hour-level precision. A malformed non-empty timestamp is also
        // evidence corruption and cannot take the compatibility path.
        if (targetMs !== null && quoteMs === null && !requestedQuote
            && (marketDataMode === 'historical' || context.allowLegacyQuoteCutoff === true)
            && _normalizeIsoDate(quoteDate)) {
            const quoteCutoff = typeof resolveExpiryCutoffAsOf === 'function'
                ? resolveExpiryCutoffAsOf(
                    { expDate: _normalizeIsoDate(quoteDate) },
                    profile,
                    _normalizeIsoDate(quoteDate)
                )
                : null;
            if (quoteCutoff && Number.isFinite(quoteCutoff.cutoffMs)) {
                quoteMs = quoteCutoff.cutoffMs;
                quoteSource = 'legacy-profile-cutoff';
            }
        }

        if (targetMs === null) {
            return {
                requested: requestedTarget,
                active: false,
                available: true,
                status: 'legacy_date_clock',
                quoteMs,
                targetMs: null,
                quoteAsOf: quoteMs === null ? null : new Date(quoteMs).toISOString(),
                quoteSource,
                targetAsOf: null,
                targetSource,
                expiry,
                observablePrice: null,
                bboTimestampFresh,
            };
        }

        const parsedObservablePrice = parseFloat(context.observablePrice);
        const observablePrice = Number.isFinite(parsedObservablePrice) && parsedObservablePrice >= 0
            ? parsedObservablePrice
            : null;
        const common = {
            requested: true,
            active: true,
            quoteMs,
            targetMs,
            quoteAsOf: quoteMs === null ? null : new Date(quoteMs).toISOString(),
            quoteSource,
            targetAsOf: new Date(targetMs).toISOString(),
            targetSource: targetSource || 'explicit',
            expiry,
            observablePrice,
            observablePriceSource,
            observablePriceAsOf: observablePriceMs === null
                ? null
                : new Date(observablePriceMs).toISOString(),
            bboTimestampFresh,
        };
        if (!expiry || !Number.isFinite(expiry.cutoffMs)) {
            return { ...common, available: false, status: 'expiry_cutoff_unavailable' };
        }
        if (quoteMs === null) {
            return {
                ...common,
                available: false,
                status: requestedQuote ? 'quote_timestamp_invalid' : 'quote_timestamp_unavailable',
            };
        }
        if (targetMs < quoteMs) {
            return { ...common, available: false, status: 'target_before_quote' };
        }

        const observedTradingDates = marketDataMode === 'historical'
            ? simObservedTradingDates
            : null;
        const timeZone = expiry.timeZone
            || profile && profile.optionExpiryTimeZone
            || 'America/New_York';
        const rolloverHour = _tradeDateRolloverHour(calendarKey);
        const resolveInterval = (startMs, endMs) => resolveWeightedTime(
            startMs,
            endMs,
            weekendWeight,
            calendarKey,
            observedTradingDates,
            timeZone,
            rolloverHour
        );
        const isExpired = targetMs >= expiry.cutoffMs;
        const remainingClock = isExpired
            ? resolveInterval(expiry.cutoffMs, expiry.cutoffMs)
            : resolveInterval(targetMs, expiry.cutoffMs);
        const anchorClock = quoteMs >= expiry.cutoffMs
            ? resolveInterval(expiry.cutoffMs, expiry.cutoffMs)
            : resolveInterval(quoteMs, expiry.cutoffMs);
        const failedClock = !remainingClock || remainingClock.available !== true
            ? remainingClock
            // At/after expiry the option value is intrinsic and no IV clock,
            // λ, Carry or discount input is needed.  Do not let an unrelated
            // historical anchor-coverage hole disable the deterministic leg.
            : (!isExpired && (!anchorClock || anchorClock.available !== true)
                ? anchorClock
                : null);
        const nonpositiveClock = !isExpired && !failedClock && (
            !Number.isFinite(remainingClock.effectiveDays)
            || remainingClock.effectiveDays <= 0
            || !Number.isFinite(anchorClock.effectiveDays)
            || anchorClock.effectiveDays <= 0
        );
        if (failedClock || nonpositiveClock) {
            return {
                ...common,
                available: false,
                status: nonpositiveClock
                    ? 'nonpositive_effective_time'
                    : (failedClock && failedClock.status || 'weighted_clock_unavailable'),
                isExpired,
                remainingClock,
                anchorClock,
            };
        }

        return {
            ...common,
            available: true,
            status: 'ok',
            isExpired,
            remainingClock,
            anchorClock,
            isObservableQuoteInstant: targetMs === quoteMs
                && (quoteSource === 'market-quote' || quoteSource === 'observable-bbo'),
        };
    }

    function normalCDF(x) {
        let sign = (x < 0) ? -1 : 1;
        x = Math.abs(x) / Math.sqrt(2.0);

        let t = 1.0 / (1.0 + 0.3275911 * x);
        let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);

        return 0.5 * (1.0 + sign * y);
    }

    function calculateD1(S, K, T, r, v, rateT = T) {
        const resolvedRateT = Number.isFinite(rateT) && rateT >= 0 ? rateT : T;
        return (Math.log(S / K) + r * resolvedRateT + (v * v / 2) * T) / (v * Math.sqrt(T));
    }

    function calculateD2(d1, v, T) {
        return d1 - v * Math.sqrt(T);
    }

    function calculateOptionPrice(type, S, K, T, r, v, rateT = T) {
        if (T <= 0) {
            if (type === 'call') return Math.max(0, S - K);
            if (type === 'put') return Math.max(0, K - S);
            return 0;
        }

        if (v <= 0) v = 0.0001;
        if (S <= 0) S = 0.0001;

        const resolvedRateT = Number.isFinite(rateT) && rateT >= 0 ? rateT : T;
        const d1 = calculateD1(S, K, T, r, v, resolvedRateT);
        const d2 = calculateD2(d1, v, T);
        const discountedStrike = K * Math.exp(-r * resolvedRateT);

        if (type === 'call') {
            return S * normalCDF(d1) - discountedStrike * normalCDF(d2);
        }
        if (type === 'put') {
            return discountedStrike * normalCDF(-d2) - S * normalCDF(-d1);
        }

        return 0;
    }

    /**
     * Black-76 model for pricing options on forwards/futures.
     * F = forward/futures price (used directly; no cost-of-carry drift).
     * T is variance time; optional rateT is calendar discount time.
     * d1 = [ln(F/K) + (σ²/2)T] / σ√T
     * Call = e^(-rT) [F·N(d1) − K·N(d2)]
     * Put  = e^(-rT) [K·N(−d2) − F·N(−d1)]
     */
    function calculateBlack76Price(type, F, K, T, r, v, rateT = T) {
        if (T <= 0) {
            if (type === 'call') return Math.max(0, F - K);
            if (type === 'put') return Math.max(0, K - F);
            return 0;
        }

        if (v <= 0) v = 0.0001;
        if (F <= 0) F = 0.0001;

        const sqrtT = Math.sqrt(T);
        const d1 = (Math.log(F / K) + (v * v / 2) * T) / (v * sqrtT);
        const d2 = d1 - v * sqrtT;
        const resolvedRateT = Number.isFinite(rateT) && rateT >= 0 ? rateT : T;
        const discount = Math.exp(-r * resolvedRateT);

        if (type === 'call') {
            return discount * (F * normalCDF(d1) - K * normalCDF(d2));
        }
        if (type === 'put') {
            return discount * (K * normalCDF(-d2) - F * normalCDF(-d1));
        }

        return 0;
    }

    /**
     * Dispatch to the appropriate pricing model.
     * @param {string} pricingModel - 'bsm-spot' or 'black76'
     */
    function calculatePrice(pricingModel, type, S, K, T, r, v, rateT = T) {
        if (pricingModel === 'black76') {
            return calculateBlack76Price(type, S, K, T, r, v, rateT);
        }
        return calculateOptionPrice(type, S, K, T, r, v, rateT);
    }

    function _optionPriceBounds(pricingModel, type, underlyingPrice, strike, rate, rateT) {
        const discount = Math.exp(-rate * rateT);
        if (pricingModel === 'black76') {
            return type === 'call'
                ? {
                    lower: discount * Math.max(0, underlyingPrice - strike),
                    upper: discount * underlyingPrice,
                }
                : {
                    lower: discount * Math.max(0, strike - underlyingPrice),
                    upper: discount * strike,
                };
        }
        const discountedStrike = strike * discount;
        return type === 'call'
            ? {
                lower: Math.max(0, underlyingPrice - discountedStrike),
                upper: underlyingPrice,
            }
            : {
                lower: Math.max(0, discountedStrike - underlyingPrice),
                upper: discountedStrike,
            };
    }

    /**
     * Invert this runtime's own BSM/Black-76 implementation.  The returned IV
     * lives on the supplied variance clock T; rateT remains the independent
     * ACT/365 discount clock.  Bounds are checked before bisection so crossed
     * or asynchronous quotes fail closed instead of producing an extreme IV.
     */
    function solveImpliedVolatility(
        pricingModel,
        type,
        underlyingPrice,
        strike,
        T,
        rate,
        optionPrice,
        rateT = T
    ) {
        const normalizedModel = pricingModel === 'black76' ? 'black76' : 'bsm-spot';
        const normalizedType = String(type || '').trim().toLowerCase();
        const inputs = [underlyingPrice, strike, T, rate, optionPrice, rateT];
        if (!['call', 'put'].includes(normalizedType)
            || !inputs.every(Number.isFinite)
            || underlyingPrice <= 0
            || strike <= 0
            || T <= 0
            || rateT < 0
            || optionPrice < 0) {
            return {
                available: false,
                status: 'invalid_input',
                impliedVolatility: null,
                totalVariance: null,
            };
        }

        const bounds = _optionPriceBounds(
            normalizedModel,
            normalizedType,
            underlyingPrice,
            strike,
            rate,
            rateT
        );
        const tolerance = Math.max(1e-10, Math.abs(bounds.upper) * 1e-10);
        if (optionPrice < bounds.lower - tolerance) {
            return {
                available: false,
                status: 'price_below_no_arbitrage_bound',
                impliedVolatility: null,
                totalVariance: null,
                ...bounds,
            };
        }
        if (optionPrice >= bounds.upper - tolerance) {
            return {
                available: false,
                status: 'price_at_or_above_upper_bound',
                impliedVolatility: null,
                totalVariance: null,
                ...bounds,
            };
        }

        const minimumVolatility = 1e-8;
        const priceAtMinimum = calculatePrice(
            normalizedModel,
            normalizedType,
            underlyingPrice,
            strike,
            T,
            rate,
            minimumVolatility,
            rateT
        );
        if (optionPrice <= priceAtMinimum + tolerance) {
            return {
                available: true,
                status: 'at_lower_bound',
                impliedVolatility: minimumVolatility,
                totalVariance: minimumVolatility * minimumVolatility * T,
                modelPrice: priceAtMinimum,
                ...bounds,
            };
        }

        let low = minimumVolatility;
        let high = 0.5;
        let highPrice = calculatePrice(
            normalizedModel,
            normalizedType,
            underlyingPrice,
            strike,
            T,
            rate,
            high,
            rateT
        );
        while (highPrice < optionPrice - tolerance && high < 64) {
            high *= 2;
            highPrice = calculatePrice(
                normalizedModel,
                normalizedType,
                underlyingPrice,
                strike,
                T,
                rate,
                high,
                rateT
            );
        }
        if (!Number.isFinite(highPrice) || highPrice < optionPrice - tolerance) {
            return {
                available: false,
                status: 'implied_volatility_unbounded',
                impliedVolatility: null,
                totalVariance: null,
                ...bounds,
            };
        }

        for (let iteration = 0; iteration < 100; iteration += 1) {
            const mid = (low + high) / 2;
            const midPrice = calculatePrice(
                normalizedModel,
                normalizedType,
                underlyingPrice,
                strike,
                T,
                rate,
                mid,
                rateT
            );
            if (!Number.isFinite(midPrice)) {
                return {
                    available: false,
                    status: 'solver_numeric_failure',
                    impliedVolatility: null,
                    totalVariance: null,
                    ...bounds,
                };
            }
            if (midPrice < optionPrice) low = mid;
            else high = mid;
        }
        const impliedVolatility = (low + high) / 2;
        const modelPrice = calculatePrice(
            normalizedModel,
            normalizedType,
            underlyingPrice,
            strike,
            T,
            rate,
            impliedVolatility,
            rateT
        );
        return {
            available: true,
            status: 'ok',
            impliedVolatility,
            totalVariance: impliedVolatility * impliedVolatility * T,
            modelPrice,
            ...bounds,
        };
    }

    function _resolveLocalBboIvAnchor(
        leg,
        pricingModel,
        exactTiming,
        timingContext,
        weekendWeight
    ) {
        const context = timingContext && typeof timingContext === 'object'
            ? timingContext
            : {};
        const source = String(context.observablePriceSource || '').trim();
        const base = {
            attempted: source === 'live_midpoint',
            available: false,
            status: source === 'live_midpoint' ? 'unavailable' : 'not_two_sided_bbo',
            source,
            impliedVolatility: null,
            totalVariance: null,
        };
        if (!base.attempted) return base;
        if (!exactTiming || exactTiming.active !== true) {
            return { ...base, status: 'exact_quote_clock_unavailable' };
        }
        if (exactTiming.bboTimestampFresh !== true) {
            return { ...base, status: 'option_bbo_stale_or_timestamp_invalid' };
        }
        if (context.quotePricingInputsAvailable !== true) {
            return {
                ...base,
                status: String(context.quotePricingInputStatus || 'quote_pricing_inputs_unavailable'),
            };
        }

        const optionPrice = parseFloat(context.observablePrice);
        const quoteUnderlyingPrice = parseFloat(context.quoteUnderlyingPrice);
        const quoteInterestRate = parseFloat(context.quoteInterestRate);
        const quoteUnderlyingMs = _parseTimestamp(context.quoteUnderlyingAsOf);
        if (!Number.isFinite(optionPrice) || optionPrice < 0
            || !Number.isFinite(quoteUnderlyingPrice) || quoteUnderlyingPrice <= 0
            || !Number.isFinite(quoteInterestRate)) {
            return { ...base, status: 'quote_pricing_inputs_invalid' };
        }
        if (quoteUnderlyingMs === null
            || !Number.isFinite(exactTiming.quoteMs)
            || Math.abs(quoteUnderlyingMs - exactTiming.quoteMs) > MAX_LOCAL_IV_QUOTE_SKEW_MS) {
            return { ...base, status: 'underlying_quote_stale_or_timestamp_invalid' };
        }

        const anchorClock = exactTiming.anchorClock;
        if (!anchorClock
            || anchorClock.available !== true
            || !Number.isFinite(anchorClock.calendarDays)
            || anchorClock.calendarDays <= 0
            || !Number.isFinite(anchorClock.effectiveDays)
            || anchorClock.effectiveDays <= 0) {
            return { ...base, status: 'quote_expiry_clock_unavailable' };
        }
        const anchorT = anchorClock.effectiveDays / weightedDaysPerYear(weekendWeight);
        const anchorRateT = anchorClock.calendarDays / 365;
        const solved = solveImpliedVolatility(
            pricingModel,
            String(leg && leg.type || '').toLowerCase(),
            quoteUnderlyingPrice,
            parseFloat(leg && leg.strike),
            anchorT,
            quoteInterestRate,
            optionPrice,
            anchorRateT
        );
        if (!solved.available) {
            return {
                ...base,
                status: solved.status,
                anchorT,
                anchorRateT,
                optionPrice,
                quoteUnderlyingPrice,
                quoteInterestRate,
            };
        }
        return {
            attempted: true,
            available: true,
            status: 'ok',
            source: 'local-bbo-implied',
            impliedVolatility: solved.impliedVolatility,
            totalVariance: solved.totalVariance,
            modelPrice: solved.modelPrice,
            anchorT,
            anchorRateT,
            optionPrice,
            quoteUnderlyingPrice,
            quoteInterestRate,
            quoteAsOf: exactTiming.quoteAsOf,
        };
    }

    function resolveInstrumentProfile(profileOrSymbol) {
        if (!profileOrSymbol) return null;

        if (typeof profileOrSymbol === 'object' && profileOrSymbol.optionMultiplier !== undefined) {
            return profileOrSymbol;
        }

        if (productRegistry && typeof productRegistry.resolveUnderlyingProfile === 'function') {
            return productRegistry.resolveUnderlyingProfile(profileOrSymbol);
        }

        return null;
    }

    function getMultiplier(profileOrSymbol) {
        const profile = resolveInstrumentProfile(profileOrSymbol);
        if (profile && Number.isFinite(profile.optionMultiplier)) {
            return profile.optionMultiplier;
        }
        return 100;
    }

    function getUnderlyingLegMultiplier(profileOrSymbol) {
        const profile = resolveInstrumentProfile(profileOrSymbol);
        if (profile && Number.isFinite(profile.underlyingLegMultiplier)) {
            return profile.underlyingLegMultiplier;
        }
        return 1;
    }

    function getSettlementUnitsPerContract(profileOrSymbol) {
        const profile = resolveInstrumentProfile(profileOrSymbol);
        if (profile && Number.isFinite(profile.settlementUnitsPerContract)) {
            return profile.settlementUnitsPerContract;
        }
        return 100;
    }

    function isUnderlyingLeg(legOrType) {
        return productRegistry.isUnderlyingLeg(legOrType);
    }

    function isLiveIvMissing(leg) {
        return !!(leg && leg.ivSource === 'missing');
    }

    function hasUsableLegIv(leg) {
        return !isLiveIvMissing(leg) && Number.isFinite(leg && leg.iv) && leg.iv > 0;
    }

    function hasUsableCurrentQuote(leg) {
        const source = String(leg && leg.currentPriceSource || '').trim();
        return !!(
            leg
            && source !== 'missing'
            && Number.isFinite(leg.currentPrice)
            && leg.currentPrice >= 0
            // Positive legacy session prices predate source tagging. A true
            // zero needs explicit evidence so the default empty input is not
            // mistaken for a market quote.
            && (leg.currentPrice > 0 || !!source)
        );
    }

    function formatLegIvInputValue(leg) {
        if (isLiveIvMissing(leg)) {
            return 'N/A';
        }

        const iv = Number.isFinite(leg && leg.iv) ? leg.iv : 0;
        return `${(iv * 100).toFixed(4)}%`;
    }

    function describeLegIvInput(leg) {
        if (isUnderlyingLeg(leg)) {
            return {
                value: '',
                title: '',
            };
        }

        if (isLiveIvMissing(leg)) {
            return {
                value: 'N/A',
                title: 'Live IV is unavailable from TWS for this contract. Future simulations are disabled until a live or manual IV is available.',
            };
        }

        if (leg && leg.ivSource === 'live') {
            return {
                value: formatLegIvInputValue(leg),
                title: 'Live IV from TWS',
            };
        }

        if (leg && leg.ivSource === 'historical') {
            return {
                value: formatLegIvInputValue(leg),
                title: 'Historical IV from SQLite replay data',
            };
        }

        if (leg && leg.ivSource === 'estimated') {
            return {
                value: formatLegIvInputValue(leg),
                title: 'Estimated IV (not from TWS)',
            };
        }

        return {
            value: formatLegIvInputValue(leg),
            title: 'Manual IV',
        };
    }

    function processLegData(leg, globalSimulatedDateStr, globalIvOffset, globalQuoteDateStr = null, globalUnderlyingPrice = null, globalInterestRate = null, viewMode = 'active', instrumentProfile = null, marketDataMode = 'live', timingContext = null) {
        const resolvedProfile = resolveInstrumentProfile(instrumentProfile);
        const pricingModel = (resolvedProfile && resolvedProfile.pricingModel) || 'bsm-spot';
        const lowerType = leg.type.toLowerCase();
        if (isUnderlyingLeg(leg)) {
            const contractMultiplier = getUnderlyingLegMultiplier(resolvedProfile);
            const posMultiplier = leg.pos * contractMultiplier;
            let effectiveCostPerUnit = leg.cost;
            if (viewMode === 'trial' || leg.cost === 0) {
                effectiveCostPerUnit = hasUsableCurrentQuote(leg)
                    ? leg.currentPrice
                    : (globalUnderlyingPrice || 0);
            }
            return {
                type: 'underlying',
                strike: 0,
                pos: leg.pos,
                isExpired: false,
                calDTE: 0,
                tradDTE: 0,
                T: 0,
                rateT: 0,
                simIV: 0,
                isUnderlyingLeg: true,
                pricingModel,
                contractMultiplier,
                settlementUnitsPerContract: 1,
                posMultiplier,
                costBasis: posMultiplier * effectiveCostPerUnit,
                effectiveCostPerShare: effectiveCostPerUnit,
                effectiveCostPerUnit
            };
        }

        const simDateObj = new Date(normalizeDateInput(globalSimulatedDateStr) + 'T00:00:00Z');
        const expDateObj = new Date(normalizeDateInput(leg.expDate) + 'T00:00:00Z');
        const baseIv = hasUsableLegIv(leg) ? leg.iv : null;
        const adjustedCalendarIv = baseIv !== null
            ? Math.max(0.001, baseIv + globalIvOffset)
            : null;
        const calendarKey = String(resolvedProfile && resolvedProfile.calendarId || 'NYSE').toUpperCase();
        const observedTradingDates = marketDataMode === 'historical' ? simObservedTradingDates : null;
        const weekendWeight = simTimeBasisWeekendWeight;
        const exactTiming = _resolveExactLegTiming(
            leg,
            globalSimulatedDateStr,
            globalQuoteDateStr,
            resolvedProfile,
            marketDataMode,
            timingContext,
            calendarKey,
            weekendWeight
        );
        const localIvAnchor = _resolveLocalBboIvAnchor(
            leg,
            pricingModel,
            exactTiming,
            timingContext,
            weekendWeight
        );
        // This flag is intentionally supplied only by an isolated chart-state
        // copy.  Portfolio valuation, probability calculations, saved state,
        // and order/execution paths remain strict even while a user elects to
        // inspect a best-effort payoff curve.
        const allowProjectionIvFallback = !!(
            timingContext && timingContext.allowProjectionIvFallback === true
        );

        let isExpired;
        let calDTE;
        let tradDTE;
        let calendarAvailable;
        let rateT;
        let T;
        let effectiveBaseIv = adjustedCalendarIv;
        if (exactTiming.active) {
            isExpired = exactTiming.isExpired === true
                || (!!exactTiming.expiry && Number.isFinite(exactTiming.expiry.cutoffMs)
                    && Number.isFinite(exactTiming.targetMs)
                    && exactTiming.targetMs >= exactTiming.expiry.cutoffMs);
            const remainingCalendarDays = !isExpired
                && exactTiming.expiry && Number.isFinite(exactTiming.expiry.cutoffMs)
                && Number.isFinite(exactTiming.targetMs)
                ? Math.max(0, (exactTiming.expiry.cutoffMs - exactTiming.targetMs) / MILLISECONDS_PER_DAY)
                : 0;
            calDTE = exactTiming.remainingClock
                && Number.isFinite(exactTiming.remainingClock.calendarDays)
                ? exactTiming.remainingClock.calendarDays
                : remainingCalendarDays;
            tradDTE = isExpired
                ? 0
                : (exactTiming.remainingClock
                    && Number.isFinite(exactTiming.remainingClock.tradingDays)
                    ? exactTiming.remainingClock.tradingDays
                    : null);
            rateT = calDTE / 365.0;
            calendarAvailable = isExpired || exactTiming.available === true;

            if (isExpired) {
                T = 0;
            } else if (exactTiming.available !== true
                || !exactTiming.remainingClock
                || !Number.isFinite(exactTiming.remainingClock.effectiveDays)) {
                T = null;
                effectiveBaseIv = null;
            } else {
                const effYear = weightedDaysPerYear(weekendWeight);
                T = exactTiming.remainingClock.effectiveDays / effYear;
                if (localIvAnchor.attempted) {
                    // This IV is already annualized on the exact weighted
                    // quote clock solved above; keep it fixed for the target
                    // clock and apply only the user's explicit scenario bump.
                    if (localIvAnchor.available) {
                        effectiveBaseIv = Math.max(
                            1e-8,
                            localIvAnchor.impliedVolatility + globalIvOffset
                        );
                    } else if (allowProjectionIvFallback) {
                        // A live BBO can exist yet fail inversion because one
                        // side, timestamp, forward, or solver input is rough.
                        // For an explicitly requested chart preview, retain
                        // the same weighted-clock conversion used by normal
                        // input IVs instead of opening a hole in the curve.
                        const anchorClock = exactTiming.anchorClock;
                        effectiveBaseIv = adjustedCalendarIv === null
                            ? null
                            : (!anchorClock
                                || !Number.isFinite(anchorClock.calendarDays)
                                || anchorClock.calendarDays <= 0
                                || !Number.isFinite(anchorClock.effectiveDays)
                                || anchorClock.effectiveDays <= 0
                                ? null
                                : convertIvToWeightedClock(
                                    adjustedCalendarIv,
                                    anchorClock.calendarDays,
                                    anchorClock.effectiveDays,
                                    weekendWeight
                                ));
                    } else {
                        effectiveBaseIv = null;
                    }
                } else {
                    const anchorClock = exactTiming.anchorClock;
                    effectiveBaseIv = adjustedCalendarIv === null
                        ? null
                        : (!anchorClock
                            || !Number.isFinite(anchorClock.calendarDays)
                            || anchorClock.calendarDays <= 0
                            || !Number.isFinite(anchorClock.effectiveDays)
                            || anchorClock.effectiveDays <= 0
                            ? null
                            : convertIvToWeightedClock(
                                adjustedCalendarIv,
                                anchorClock.calendarDays,
                                anchorClock.effectiveDays,
                                weekendWeight
                            ));
                }
            }
        } else if (exactTiming.requested && exactTiming.available !== true) {
            // An explicitly requested timestamp clock must never fall back to
            // plausible-looking integer dates.
            isExpired = false;
            calDTE = null;
            tradDTE = null;
            calendarAvailable = false;
            rateT = null;
            T = null;
            effectiveBaseIv = null;
        } else {
            // Legacy compatibility for callers that have not yet supplied a
            // target timestamp. This retains the historical [date, date)
            // semantics while the main application migrates call sites.
            isExpired = expDateObj <= simDateObj;
            calDTE = isExpired ? 0 : diffDays(globalSimulatedDateStr, leg.expDate);
            tradDTE = isExpired ? 0 : calendarToTradingDays(
                globalSimulatedDateStr, leg.expDate, calendarKey, observedTradingDates
            );
            calendarAvailable = isExpired || tradDTE !== null;
            rateT = calDTE / 365.0;
            T = rateT;

            if (!isExpired && weekendWeightActive(weekendWeight)) {
                const effYear = weightedDaysPerYear(weekendWeight);
                let effDTE = countWeightedDays(
                    globalSimulatedDateStr, leg.expDate, weekendWeight,
                    calendarKey, observedTradingDates
                );
                if (effDTE === null) {
                    T = null;
                    effectiveBaseIv = null;
                }
                effDTE = floorWeightedDteBeforeExpiry(calDTE, effDTE);
                if (effDTE !== null) {
                    T = effDTE / effYear;
                }

                if (adjustedCalendarIv !== null && effDTE !== null) {
                    const anchorDate = globalQuoteDateStr || globalSimulatedDateStr;
                    const anchorCalDte = diffDays(anchorDate, leg.expDate);
                    const anchorEffDte = floorWeightedDteBeforeExpiry(
                        anchorCalDte,
                        countWeightedDays(
                            anchorDate, leg.expDate, weekendWeight,
                            calendarKey, observedTradingDates
                        )
                    );
                    effectiveBaseIv = anchorEffDte === null
                        ? null
                        : convertIvToWeightedClock(
                            adjustedCalendarIv, anchorCalDte, anchorEffDte, weekendWeight
                        );
                }
            }
        }

        const simIV = isExpired
            ? 0
            : (effectiveBaseIv !== null ? Math.max(0.001, effectiveBaseIv) : null);
        const bestEffortIvFallbackUsed = allowProjectionIvFallback
            && !isExpired
            && localIvAnchor.available !== true
            && Number.isFinite(simIV)
            && simIV > 0;
        const contractMultiplier = getMultiplier(resolvedProfile);
        const settlementUnitsPerContract = getSettlementUnitsPerContract(resolvedProfile);
        const posMultiplier = leg.pos * contractMultiplier;
        const expiryUnderlyingPrice = marketDataMode === 'historical' && isExpired
            ? (Number.isFinite(parseFloat(leg.historicalExpiryUnderlyingPrice))
                ? parseFloat(leg.historicalExpiryUnderlyingPrice)
                : null)
            : null;

        let effectiveCostPerShare = leg.cost;

        if (viewMode === 'trial' || leg.cost === 0 || leg.cost === 0.00) {
            if (hasUsableCurrentQuote(leg)) {
                effectiveCostPerShare = leg.currentPrice;
            } else if (globalQuoteDateStr && globalUnderlyingPrice !== null && globalInterestRate !== null) {
                // Priced as of the quote date, where the weighted clock gives
                // the identical price by construction (the IV conversion
                // preserves total variance at its anchor), so the calendar
                // form is kept for simplicity on every time basis.
                const quoteCalDTE = exactTiming
                    && exactTiming.expiry && Number.isFinite(exactTiming.expiry.cutoffMs)
                    && Number.isFinite(exactTiming.quoteMs)
                    ? Math.max(
                        0,
                        (exactTiming.expiry.cutoffMs - exactTiming.quoteMs) / MILLISECONDS_PER_DAY
                    )
                    : diffDays(globalQuoteDateStr, leg.expDate);
                const quoteT = quoteCalDTE / 365.0;

                if (quoteT <= 0) {
                    if (leg.type === 'call') effectiveCostPerShare = Math.max(0, globalUnderlyingPrice - leg.strike);
                    else effectiveCostPerShare = Math.max(0, leg.strike - globalUnderlyingPrice);
                } else if (baseIv !== null) {
                    effectiveCostPerShare = calculatePrice(
                        pricingModel,
                        leg.type,
                        globalUnderlyingPrice,
                        leg.strike,
                        quoteT,
                        globalInterestRate,
                        leg.iv
                    );
                }
            }
        }

        return {
            type: lowerType,
            strike: leg.strike,
            pos: leg.pos,
            isUnderlyingLeg: false,
            isExpired,
            calDTE,
            tradDTE,
            calendarKey,
            calendarAvailable,
            T,
            rateT,
            simIV,
            simIVAvailable: isExpired || simIV !== null,
            simIVSource: bestEffortIvFallbackUsed
                ? 'best-effort-input-iv'
                : (localIvAnchor.available
                ? 'local-bbo-implied'
                : (localIvAnchor.attempted
                    ? 'local-bbo-unavailable'
                    : (isLiveIvMissing(leg) ? 'missing' : (leg.ivSource || 'manual')))),
            simIVFallbackSource: bestEffortIvFallbackUsed
                ? String(leg && leg.ivSource || 'manual')
                : null,
            pricingModel,
            contractMultiplier,
            settlementUnitsPerContract,
            posMultiplier,
            costBasis: posMultiplier * effectiveCostPerShare,
            effectiveCostPerShare,
            expiryUnderlyingPrice,
            anchorUnderlyingPrice: Number.isFinite(globalUnderlyingPrice) ? globalUnderlyingPrice : null,
            exactTimingActive: exactTiming.active === true,
            timingAvailable: exactTiming.active === true
                ? exactTiming.available === true
                : calendarAvailable,
            timingStatus: exactTiming.status || null,
            missingWeightDates: Array.from(new Set([
                ...(exactTiming.remainingClock
                    && Array.isArray(exactTiming.remainingClock.missingWeightDates)
                    ? exactTiming.remainingClock.missingWeightDates
                    : []),
                ...(exactTiming.anchorClock
                    && Array.isArray(exactTiming.anchorClock.missingWeightDates)
                    ? exactTiming.anchorClock.missingWeightDates
                    : []),
            ])).sort(),
            quoteAsOf: exactTiming.quoteAsOf || null,
            targetAsOf: exactTiming.targetAsOf || null,
            targetSource: exactTiming.targetSource || null,
            isObservableQuoteInstant: exactTiming.isObservableQuoteInstant === true,
            observablePrice: exactTiming.observablePrice,
            localIvAnchorAttempted: localIvAnchor.attempted,
            localIvAnchorAvailable: localIvAnchor.available,
            localIvAnchorStatus: localIvAnchor.status,
            localImpliedIv: localIvAnchor.impliedVolatility,
            localAnchorTotalVariance: localIvAnchor.totalVariance,
            localAnchorPrice: localIvAnchor.optionPrice,
            localAnchorUnderlyingPrice: localIvAnchor.quoteUnderlyingPrice,
            localAnchorInterestRate: localIvAnchor.quoteInterestRate,
            intradayActive: exactTiming.active === true
                && !isExpired
                && _normalizeIsoDate(globalSimulatedDateStr) === _normalizeIsoDate(leg.expDate),
            intradayTimeSource: exactTiming.active && exactTiming.expiry
                ? exactTiming.expiry.source
                : null,
            expiryCutoffAsOf: exactTiming.expiry && exactTiming.expiry.cutoffAsOf || null
        };
    }

    function computeLegPrice(processedLeg, underlyingPrice, interestRate) {
        if (processedLeg.isUnderlyingLeg || isUnderlyingLeg(processedLeg.type)) {
            return Number.isFinite(underlyingPrice) && underlyingPrice > 0
                ? underlyingPrice
                : null;
        }
        if (processedLeg.isExpired) {
            const settlementUnderlyingPrice = Number.isFinite(processedLeg.expiryUnderlyingPrice)
                ? processedLeg.expiryUnderlyingPrice
                : underlyingPrice;
            if (!Number.isFinite(settlementUnderlyingPrice) || settlementUnderlyingPrice <= 0) {
                return null;
            }
            if (processedLeg.type === 'call') {
                return Math.max(0, settlementUnderlyingPrice - processedLeg.strike);
            }
            return Math.max(0, processedLeg.strike - settlementUnderlyingPrice);
        }
        if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) {
            return null;
        }
        if (!Number.isFinite(processedLeg.simIV) || processedLeg.simIV <= 0) {
            return null;
        }
        return calculatePrice(
            processedLeg.pricingModel || 'bsm-spot',
            processedLeg.type,
            underlyingPrice,
            processedLeg.strike,
            processedLeg.T,
            interestRate,
            processedLeg.simIV,
            Number.isFinite(processedLeg.rateT) ? processedLeg.rateT : processedLeg.T
        );
    }

    function computeSimulatedPrice(processedLeg, rawLeg, underlyingPrice, interestRate, viewMode, simulatedDate, baseDate, ivOffset) {
        if (rawLeg.closePrice !== null && rawLeg.closePrice !== '') {
            const parsedClose = parseFloat(rawLeg.closePrice);
            if (!isNaN(parsedClose) && parsedClose >= 0) {
                return parsedClose;
            }
        }

        // Pricing an option without its actual spot/forward is not a numeric
        // approximation: for FOPs it can silently substitute the anchor
        // future and produce a plausible-looking curve for the wrong
        // contract.  Keep this guard at the shared pricing boundary so every
        // projection caller fails closed even if it misses its own preflight.
        const hasFrozenExpiryUnderlying = processedLeg.isExpired === true
            && Number.isFinite(processedLeg.expiryUnderlyingPrice)
            && processedLeg.expiryUnderlyingPrice >= 0;
        if ((!Number.isFinite(underlyingPrice) || underlyingPrice <= 0)
            && !hasFrozenExpiryUnderlying) {
            return null;
        }

        if (processedLeg.isUnderlyingLeg || isUnderlyingLeg(processedLeg.type)) {
            return underlyingPrice;
        }

        // Once the contract cutoff has been reached, an old non-zero mark is
        // no longer an observable option value. Expired legs are settlement
        // intrinsic only, including when targetAsOf equals quoteAsOf exactly.
        if (processedLeg.isExpired) {
            return computeLegPrice(processedLeg, underlyingPrice, interestRate);
        }

        const isEvaluatingRightNow = ivOffset === 0 && (
            processedLeg.exactTimingActive === true
                ? processedLeg.isObservableQuoteInstant === true
                : simulatedDate === baseDate
        );
        const anchorUnderlying = processedLeg.anchorUnderlyingPrice;
        const isAtCurrentUnderlying = Number.isFinite(anchorUnderlying)
            && Math.abs(underlyingPrice - anchorUnderlying)
                <= Math.max(1e-8, Math.abs(anchorUnderlying) * 1e-10);
        const explicitObservablePrice = Number.isFinite(processedLeg.observablePrice)
            && processedLeg.observablePrice >= 0
            ? processedLeg.observablePrice
            : null;
        const hasObservablePrice = explicitObservablePrice !== null
            || hasUsableCurrentQuote(rawLeg);
        const observablePrice = explicitObservablePrice !== null
            ? explicitObservablePrice
            : rawLeg.currentPrice;
        // The live mark is the observable boundary condition. At the exact
        // quote timestamp/current underlier, both active and trial views
        // reproduce it; a later target on the same civil date must use the
        // model rather than accidentally reusing the stale quote.
        if (isEvaluatingRightNow && isAtCurrentUnderlying && hasObservablePrice) {
            return observablePrice;
        }

        return computeLegPrice(processedLeg, underlyingPrice, interestRate);
    }

    /**
     * Live future projections are useful only when every option that survives
     * the portfolio target is calibrated to an observable, executable book.
     * The default therefore requires the local BSM/Black-76 inversion of a
     * fresh valid two-sided BBO.  Expired target-date legs are deterministic
     * intrinsic and deliberately do not need a quote/IV anchor.
     *
     * Historical replay remains on its recorded-IV path.  The old live input-
     * IV behavior is retained solely as an explicit session compatibility
     * value (`legacy-input-iv`); an absent or malformed live value is strict.
     */
    function normalizeProjectionConvergenceMode(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'legacy-input-iv') return 'legacy-input-iv';
        if (normalized === 'best-effort-input-iv') return 'best-effort-input-iv';
        return 'strict-bbo';
    }

    function _hasFixedProjectionPrice(leg) {
        if (!leg || leg.closePrice === null || leg.closePrice === ''
            || leg.closePrice === undefined) return false;
        const value = parseFloat(leg.closePrice);
        return Number.isFinite(value) && value >= 0;
    }

    function assessProjectionConvergence(globalState, rawLegs, processedLegs) {
        const state = globalState && typeof globalState === 'object' ? globalState : {};
        const mode = normalizeProjectionConvergenceMode(state.projectionConvergenceMode);
        const historical = state.marketDataMode === 'historical';
        // Real application state always declares live/historical.  Treat an
        // omitted mode as a legacy library caller so pure pricing integrations
        // are not silently reinterpreted as a live market observation.
        const live = state.marketDataMode === 'live';
        const strictBboRequired = live && !historical && mode === 'strict-bbo';
        const lambdaCoverage = state.simImpliedLambdaCoverage
            && typeof state.simImpliedLambdaCoverage === 'object'
            ? state.simImpliedLambdaCoverage
            : null;
        // Accuracy-first live projections may not opt out of a required
        // structured clock by selecting Calendar/Trading or unchecking the
        // IVTS curve.  Scalar λ remains a display/research lens, but when any
        // target-surviving leg crosses a closure the shared coverage audit is
        // a hard prerequisite. `not_required` is the sole exemption.
        const structuredLambdaRequired = live && !historical
            && lambdaCoverage && lambdaCoverage.required === true;
        const base = {
            required: strictBboRequired || structuredLambdaRequired,
            ready: true,
            available: true,
            status: historical
                ? 'historical_replay'
                : (mode === 'legacy-input-iv'
                    ? 'legacy_input_iv'
                    : (mode === 'best-effort-input-iv'
                        ? 'best_effort_input_iv'
                        : 'not_live')),
            mode,
            affectedLegIds: [],
            failures: [],
        };
        if (structuredLambdaRequired && lambdaCoverage.ready !== true) {
            const affectedLegIds = Array.isArray(lambdaCoverage.affectedLegIds)
                ? lambdaCoverage.affectedLegIds.filter(Boolean)
                : [];
            const requiredDates = Array.isArray(lambdaCoverage.requiredDates)
                ? lambdaCoverage.requiredDates.filter(Boolean)
                : [];
            const missingDates = Array.isArray(lambdaCoverage.missingDates)
                && lambdaCoverage.missingDates.length > 0
                ? lambdaCoverage.missingDates.filter(Boolean)
                : requiredDates;
            return {
                ...base,
                ready: false,
                available: false,
                status: 'structured_implied_lambda_required',
                affectedLegIds: Array.from(new Set(affectedLegIds)),
                requiredDates: Array.from(new Set(requiredDates)).sort(),
                missingDates: Array.from(new Set(missingDates)).sort(),
                lambdaCoverageStatus: String(lambdaCoverage.status || 'unavailable'),
                failures: [{
                    reason: 'structured_implied_lambda_required',
                    detail: String(lambdaCoverage.status || 'unavailable'),
                    missingDates: Array.from(new Set(missingDates)).sort(),
                }],
            };
        }
        if (!strictBboRequired) return base;

        const legs = Array.isArray(rawLegs) ? rawLegs : [];
        const processed = Array.isArray(processedLegs) ? processedLegs : [];
        const failures = [];
        legs.forEach((leg, index) => {
            const pLeg = processed[index];
            const position = parseFloat(leg && leg.pos);
            const optionLeg = pLeg
                ? pLeg.isUnderlyingLeg !== true
                : !!(leg && ['call', 'put'].includes(String(leg.type || '').toLowerCase()));
            if (!optionLeg || !Number.isFinite(position) || Math.abs(position) <= 0
                || _hasFixedProjectionPrice(leg)
                || (pLeg && pLeg.isExpired === true)) {
                return;
            }
            // A missing structured λ date is a clock/coverage prerequisite,
            // not a BBO-quality failure.  Let each surface report that more
            // actionable cause (and its missing dates) before this gate.
            if (pLeg && pLeg.timingStatus === 'implied_lambda_incomplete') return;

            let reason = null;
            let detail = null;
            if (state.liveProjectionFeedConnected === false) {
                reason = 'live_quote_feed_disconnected';
            } else if (state.liveProjectionFeedStale === true) {
                reason = 'live_quote_feed_stale';
                detail = String(state.liveProjectionLastReceivedAt || '') || null;
            } else if (!pLeg) {
                reason = 'processed_leg_unavailable';
            } else if (pLeg.localIvAnchorAttempted !== true) {
                reason = 'fresh_two_sided_bbo_required';
                detail = pLeg.localIvAnchorStatus || 'not_two_sided_bbo';
            } else if (pLeg.localIvAnchorAvailable !== true
                || pLeg.simIVSource !== 'local-bbo-implied') {
                reason = 'local_bbo_iv_inversion_failed';
                detail = pLeg.localIvAnchorStatus || 'local_iv_unavailable';
            }
            if (reason) {
                failures.push({
                    legId: String(leg && leg.id || `leg-${index + 1}`),
                    expDate: String(leg && leg.expDate || ''),
                    reason,
                    detail,
                });
            }
        });

        if (failures.length === 0) {
            return {
                ...base,
                status: 'strict_bbo_ready',
            };
        }
        const feedDisconnected = failures.some(item =>
            item.reason === 'live_quote_feed_disconnected'
        );
        const feedStale = failures.some(item => item.reason === 'live_quote_feed_stale');
        return {
            ...base,
            ready: false,
            available: false,
            status: feedDisconnected
                ? 'strict_convergence_feed_disconnected'
                : (feedStale
                    ? 'strict_convergence_feed_stale'
                    : 'strict_convergence_bbo_unavailable'),
            affectedLegIds: Array.from(new Set(failures.map(item => item.legId))),
            failures,
        };
    }

    function formatProjectionConvergenceFailure(assessment, subject = 'Simulation') {
        if (!assessment || assessment.ready !== false) return '';
        const legIds = Array.isArray(assessment.affectedLegIds)
            ? assessment.affectedLegIds.filter(Boolean)
            : [];
        const suffix = legIds.length ? ` (legs: ${legIds.join(', ')})` : '';
        const failures = Array.isArray(assessment.failures) ? assessment.failures : [];
        const lambdaFailure = failures.find(item =>
            item && item.reason === 'structured_implied_lambda_required'
        );
        if (lambdaFailure) {
            const dates = Array.isArray(lambdaFailure.missingDates)
                ? lambdaFailure.missingDates.filter(Boolean)
                : [];
            const dateText = dates.length ? ` Missing dates: ${dates.join(', ')}.` : '';
            return `${subject} unavailable: a fresh matching structured implied λ curve is mandatory whenever a target-surviving option crosses a weekend or full exchange holiday${suffix}.${dateText} Select Weighted weekends (λ), enable IVTS implied λ, and export/load complete coverage.`;
        }
        if (failures.some(item => item && item.reason === 'live_quote_feed_disconnected')) {
            return `${subject} unavailable: the live market-data feed is disconnected, so stored option BBOs are stale${suffix}. Reconnect and wait for fresh two-sided quotes.`;
        }
        if (failures.some(item => item && item.reason === 'live_quote_feed_stale')) {
            return `${subject} unavailable: the live market-data feed has not delivered a market quote within 120 seconds, so stored option BBOs are stale${suffix}. Wait for a fresh two-sided quote.`;
        }
        return `${subject} unavailable: strict live convergence requires a fresh valid two-sided BBO and successful local IV inversion for every option leg still alive at the simulation target${suffix}.`;
    }

    function formatProjectionTimingFailure(status, subject = 'Simulation', details = null) {
        if (status === 'implied_lambda_incomplete') {
            const missingDates = details && Array.isArray(details.missingWeightDates)
                ? details.missingWeightDates.filter(Boolean)
                : [];
            const dateText = missingDates.length
                ? ` (${missingDates.join(', ')})`
                : '';
            return `${subject} unavailable: the structured implied λ curve is missing one or more required weekend/holiday dates${dateText}. Export a fresh λ curve from IV Term Structure or load the matching λ file.`;
        }
        return `${subject} timing unavailable (${status || 'unknown'}).`;
    }

    const api = {
        normalCDF,
        calculateD1,
        calculateD2,
        calculateOptionPrice,
        calculateBlack76Price,
        calculatePrice,
        solveImpliedVolatility,
        configureSimTimeBasis,
        getSimTimeBasisWeekendWeight,
        weekendWeightDefault,
        weekendWeightActive,
        weightedDaysPerYear,
        convertIvToWeightedClock,
        resolveSimHorizonClock,
        resolveSameDayLiveTiming,
        resolveInstrumentProfile,
        isUnderlyingLeg,
        getMultiplier,
        getUnderlyingLegMultiplier,
        getSettlementUnitsPerContract,
        processLegData,
        computeLegPrice,
        computeSimulatedPrice,
        normalizeProjectionConvergenceMode,
        assessProjectionConvergence,
        formatProjectionConvergenceFailure,
        formatProjectionTimingFailure,
        isLiveIvMissing,
        hasUsableLegIv,
        hasUsableCurrentQuote,
        formatLegIvInputValue,
        describeLegIvInput,
    };

    globalScope.OptionComboPricingCore = api;
    Object.assign(globalScope, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
