/**
 * Shared pricing-context helpers.
 *
 * Centralizes how the app chooses:
 * - the anchor underlying price for charts / probability paths
 * - the per-leg underlying price for FOP legs bound to a futures pool entry
 * - the scenario shock mapping from anchor price -> per-leg future price
 */

(function attachPricingContext(globalScope) {
    const productRegistry = globalScope.OptionComboProductRegistry;
    const dateUtils = globalScope.OptionComboDateUtils;
    const indexForwardRate = globalScope.OptionComboIndexForwardRate;
    const marketCurves = globalScope.OptionComboMarketCurves;
    const MAX_LIVE_DISCOUNT_CURVE_AGE_DAYS = 10;
    const MAX_LIVE_CARRY_QUOTE_AGE_SECONDS = 120;
    const MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS = 120;

    function _toFiniteNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _normalizeContractMonth(value) {
        return String(value || '').replace(/\D/g, '').slice(0, 6);
    }

    function _normalizeDateValue(value) {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return '';
        }
        const safe = dateUtils && typeof dateUtils.normalizeDateInput === 'function'
            ? dateUtils.normalizeDateInput(normalized)
            : normalized.replace(/\//g, '-');
        return /^\d{4}-\d{2}-\d{2}$/.test(safe) ? safe : '';
    }

    function _signedCalendarDayDifference(startDate, endDate) {
        const start = _normalizeDateValue(startDate);
        const end = _normalizeDateValue(endDate);
        if (!start || !end) return null;
        const startMs = Date.parse(`${start}T00:00:00Z`);
        const endMs = Date.parse(`${end}T00:00:00Z`);
        return Number.isFinite(startMs) && Number.isFinite(endMs)
            ? Math.round((endMs - startMs) / 86400000)
            : null;
    }

    function _resolveMarketClock(globalState) {
        const profile = productRegistry
            && typeof productRegistry.resolveUnderlyingProfile === 'function'
            ? productRegistry.resolveUnderlyingProfile(globalState && globalState.underlyingSymbol)
            : null;
        const calendarId = String(profile && profile.calendarId || 'NYSE').trim().toUpperCase() || 'NYSE';
        const isFuturesCalendar = calendarId.startsWith('CME:')
            || calendarId.startsWith('NYMEX:')
            || calendarId.startsWith('COMEX:');

        return {
            calendarId,
            timeZone: isFuturesCalendar ? 'America/Chicago' : 'America/New_York',
            // CME/NYMEX/COMEX sessions opened at 17:00 CT belong to the next
            // trade date. Equity/index quotes keep their New York civil date.
            tradeDateRolloverHour: isFuturesCalendar ? 17 : null,
        };
    }

    function _formatZonedTimestampParts(timestamp, timeZone) {
        const instant = new Date(timestamp || '');
        if (Number.isNaN(instant.getTime()) || typeof Intl === 'undefined'
            || typeof Intl.DateTimeFormat !== 'function') {
            return null;
        }

        try {
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                hourCycle: 'h23',
            }).formatToParts(instant);
            const values = {};
            parts.forEach((part) => {
                if (part && part.type !== 'literal') {
                    values[part.type] = part.value;
                }
            });
            const date = _normalizeDateValue(`${values.year}-${values.month}-${values.day}`);
            const hour = parseInt(values.hour, 10);
            return date && Number.isFinite(hour) ? { date, hour } : null;
        } catch (_error) {
            return null;
        }
    }

    function _addCalendarDays(dateValue, days) {
        if (dateUtils && typeof dateUtils.addDays === 'function') {
            return dateUtils.addDays(dateValue, days);
        }
        const date = new Date(`${dateValue}T00:00:00Z`);
        if (Number.isNaN(date.getTime())) {
            return '';
        }
        date.setUTCDate(date.getUTCDate() + days);
        return date.toISOString().slice(0, 10);
    }

    /**
     * Convert a server UTC quote timestamp into the instrument's exchange
     * trade date. This intentionally does not use the browser's local date:
     * an Asia browser is already on Saturday while Friday's US session is
     * still trading.
     */
    function resolveLiveQuoteDate(globalState, quoteTimestamp) {
        if (!globalState || typeof globalState !== 'object'
            || globalState.marketDataMode === 'historical') {
            return '';
        }

        const marketClock = _resolveMarketClock(globalState);
        const zoned = _formatZonedTimestampParts(quoteTimestamp, marketClock.timeZone);
        if (!zoned) {
            return '';
        }

        let candidate = zoned.date;
        if (marketClock.tradeDateRolloverHour !== null
            && zoned.hour >= marketClock.tradeDateRolloverHour) {
            candidate = _addCalendarDays(candidate, 1);
        }

        if (!dateUtils || typeof dateUtils.isTradingDay !== 'function') {
            return candidate;
        }

        // A live quote received outside the session retains the last valid
        // exchange trade date. When official calendar coverage is unavailable,
        // keep the exchange-local candidate instead of inventing a closure.
        for (let offset = 0; offset <= 7; offset += 1) {
            const dateValue = offset === 0 ? candidate : _addCalendarDays(candidate, -offset);
            const tradingDay = dateUtils.isTradingDay(dateValue, marketClock.calendarId);
            if (tradingDay === true) {
                return dateValue;
            }
            if (tradingDay === null) {
                // We can still skip dates already proven closed (notably the
                // weekend) even when weekday holiday coverage is unavailable.
                return dateValue;
            }
        }

        return candidate;
    }

    function _formatContractMonth(value) {
        const normalized = _normalizeContractMonth(value);
        if (normalized.length !== 6) {
            return String(value || '').trim();
        }
        return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}`;
    }

    function _resolvePricingInputMode(globalStateOrSymbol) {
        if (!productRegistry || typeof productRegistry.resolvePricingInputMode !== 'function') {
            return 'STK';
        }

        if (globalStateOrSymbol && typeof globalStateOrSymbol === 'object') {
            return productRegistry.resolvePricingInputMode(globalStateOrSymbol.underlyingSymbol);
        }

        return productRegistry.resolvePricingInputMode(globalStateOrSymbol);
    }

    function _isUnderlyingLeg(leg) {
        return productRegistry
            && typeof productRegistry.isUnderlyingLeg === 'function'
            && productRegistry.isUnderlyingLeg(leg);
    }

    function resolveQuoteDate(globalState) {
        if (!globalState || typeof globalState !== 'object') {
            return '';
        }

        if (globalState.marketDataMode === 'historical') {
            return _normalizeDateValue(globalState.historicalQuoteDate)
                || _normalizeDateValue(globalState.baseDate)
                || _normalizeDateValue(globalState.simulatedDate);
        }

        return _normalizeDateValue(globalState.liveQuoteDate)
            || _normalizeDateValue(globalState.baseDate)
            || _normalizeDateValue(globalState.simulatedDate);
    }

    function resolveSimulationDate(globalState) {
        if (!globalState || typeof globalState !== 'object') {
            return '';
        }

        const quoteDate = resolveQuoteDate(globalState);
        const requestedDate = _normalizeDateValue(globalState.simulatedDate) || quoteDate;
        if (quoteDate && requestedDate && requestedDate < quoteDate) {
            return quoteDate;
        }
        return requestedDate || quoteDate;
    }

    function _resolveUnderlyingProfile(globalState) {
        return productRegistry
            && typeof productRegistry.resolveUnderlyingProfile === 'function'
            ? productRegistry.resolveUnderlyingProfile(globalState && globalState.underlyingSymbol)
            : null;
    }

    function resolveLegExpiryTiming(globalState, leg) {
        const profile = _resolveUnderlyingProfile(globalState);
        if (!dateUtils || typeof dateUtils.resolveExpiryCutoffAsOf !== 'function') {
            return { available: false, status: 'timing_runtime_unavailable' };
        }
        const cutoff = dateUtils.resolveExpiryCutoffAsOf(leg, profile);
        return cutoff && Number.isFinite(cutoff.cutoffMs)
            ? {
                available: true,
                status: 'ok',
                targetAsOf: cutoff.cutoffAsOf,
                targetMs: cutoff.cutoffMs,
                source: cutoff.source,
                timeZone: cutoff.timeZone,
            }
            : { available: false, status: 'expiry_cutoff_unavailable' };
    }

    function _openOptionLegs(globalState) {
        const groups = globalState && Array.isArray(globalState.groups) ? globalState.groups : [];
        const legs = [];
        groups.filter(Boolean).forEach((group) => {
            (Array.isArray(group.legs) ? group.legs : []).forEach((leg) => {
                const isOption = productRegistry
                    && typeof productRegistry.isOptionLeg === 'function'
                    ? productRegistry.isOptionLeg(leg)
                    : ['call', 'put'].includes(String(leg && leg.type || '').toLowerCase());
                const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== ''
                    && leg.closePrice !== undefined;
                if (isOption && !hasClosePrice
                    && Math.abs(_toFiniteNumber(leg && leg.pos) || 0) > 0) {
                    legs.push(leg);
                }
            });
        });
        return legs;
    }

    function _assessExactContractTiming(globalState, timing, simulationDate, profile) {
        const enabled = !!(globalState
            && globalState.marketDataMode !== 'historical'
            && globalState.requireExactContractTiming === true);
        const base = {
            required: enabled,
            ready: true,
            status: enabled ? 'complete' : 'not_required',
            missingContractTimingLegIds: [],
            missingContractTimingLegs: [],
        };
        if (!enabled) return base;

        const targetMs = Number.isFinite(timing && timing.targetMs)
            ? timing.targetMs
            : Date.parse(String(timing && timing.targetAsOf || '').trim());
        const pricingMode = _resolvePricingInputMode(globalState);
        const requiresEverySurvivingLeg = pricingMode === 'FOP' || pricingMode === 'INDEX';
        const missing = [];
        _openOptionLegs(globalState).forEach((leg) => {
            const expiryDate = _normalizeDateValue(leg && leg.expDate);
            const expiry = dateUtils && typeof dateUtils.resolveExpiryCutoffAsOf === 'function'
                ? dateUtils.resolveExpiryCutoffAsOf(leg, profile)
                : null;
            const hasContractTiming = !!(expiry
                && expiry.source === 'contract'
                && Number.isFinite(expiry.cutoffMs));
            const reasons = [];
            if (expiryDate && expiryDate === simulationDate && !hasContractTiming) {
                reasons.push('target_expiry_contract_timing_missing');
            }

            const expiryMs = expiry && Number.isFinite(expiry.cutoffMs) ? expiry.cutoffMs : null;
            const survivesTarget = Number.isFinite(targetMs)
                && Number.isFinite(expiryMs)
                && expiryMs > targetMs;
            const remainingDays = survivesTarget
                ? (expiryMs - targetMs) / 86400000
                : null;
            if (survivesTarget && !hasContractTiming && requiresEverySurvivingLeg) {
                reasons.push('product_surviving_leg_contract_timing_missing');
            }
            if (survivesTarget && !hasContractTiming
                && Number.isFinite(remainingDays) && remainingDays <= 7 + 1e-12) {
                reasons.push('short_dated_surviving_leg_contract_timing_missing');
            }
            if (reasons.length > 0) {
                missing.push({
                    legId: String(leg && leg.id || ''),
                    expDate: expiryDate,
                    remainingDays,
                    reasons: Array.from(new Set(reasons)),
                });
            }
        });
        if (missing.length === 0) return base;
        return {
            required: true,
            ready: false,
            status: 'exact_contract_timing_missing',
            missingContractTimingLegIds: Array.from(new Set(missing.map(item => item.legId))),
            missingContractTimingLegs: missing,
        };
    }

    function _assessDeferredSettlement(globalState, timing, profile) {
        const detector = productRegistry
            && typeof productRegistry.isDeferredSettlementOption === 'function'
            ? productRegistry.isDeferredSettlementOption
            : null;
        if (!detector) return { ready: true, status: 'not_required' };
        const targetMs = Number.isFinite(timing && timing.targetMs)
            ? timing.targetMs
            : Date.parse(String(timing && timing.targetAsOf || '').trim());
        if (!Number.isFinite(targetMs)) return { ready: true, status: 'not_required' };

        const symbol = String(globalState && globalState.underlyingSymbol || '').trim();
        const affected = [];
        _openOptionLegs(globalState).forEach((leg) => {
            const expiry = dateUtils && typeof dateUtils.resolveExpiryCutoffAsOf === 'function'
                ? dateUtils.resolveExpiryCutoffAsOf(leg, profile)
                : null;
            if (!expiry || !Number.isFinite(expiry.cutoffMs)
                || targetMs < expiry.cutoffMs) {
                return;
            }
            if (detector(symbol, _normalizeDateValue(leg && leg.expDate), leg)) {
                affected.push({
                    legId: String(leg && leg.id || ''),
                    expDate: _normalizeDateValue(leg && leg.expDate),
                    tradingClass: String(leg && leg.tradingClass || 'SPX').trim(),
                    lastTradeAsOf: expiry.cutoffAsOf,
                    reason: 'settlement_fixing_occurs_after_last_trade',
                });
            }
        });
        return affected.length === 0 ? { ready: true, status: 'not_required' } : {
            ready: false,
            status: 'deferred_settlement_fixing_unsupported',
            deferredSettlementLegIds: Array.from(new Set(affected.map(item => item.legId))),
            deferredSettlementLegs: affected,
        };
    }

    /**
     * Resolve one portfolio-global valuation instant. A future simulation date
     * that contains expiring option legs uses their actual IB cutoff; every far
     * leg is then valued at that same instant. On the current live trade date,
     * the observable quote timestamp remains the target. Distinct near-leg
     * cutoffs are ambiguous and fail closed instead of being averaged.
     */
    function resolveSimulationTiming(globalState) {
        const simulationDate = resolveSimulationDate(globalState);
        const quoteDate = resolveQuoteDate(globalState);
        const profile = _resolveUnderlyingProfile(globalState);
        const unavailable = (status, extra = {}) => ({
            available: false,
            status,
            simulationDate,
            targetAsOf: null,
            targetMs: null,
            source: null,
            precision: null,
            ...extra,
        });
        const finalize = (timing) => {
            const assessment = _assessExactContractTiming(
                globalState,
                timing,
                simulationDate,
                profile
            );
            if (!assessment.ready) {
                return {
                    ...timing,
                    available: false,
                    status: assessment.status,
                    contractTimingStatus: assessment.status,
                    missingContractTimingLegIds: assessment.missingContractTimingLegIds,
                    missingContractTimingLegs: assessment.missingContractTimingLegs,
                };
            }
            const settlementAssessment = _assessDeferredSettlement(
                globalState,
                timing,
                profile
            );
            if (!settlementAssessment.ready) {
                return {
                    ...timing,
                    available: false,
                    status: settlementAssessment.status,
                    contractTimingStatus: assessment.status,
                    missingContractTimingLegIds: [],
                    missingContractTimingLegs: [],
                    deferredSettlementLegIds: settlementAssessment.deferredSettlementLegIds,
                    deferredSettlementLegs: settlementAssessment.deferredSettlementLegs,
                };
            }
            return {
                ...timing,
                contractTimingStatus: assessment.status,
                missingContractTimingLegIds: [],
                missingContractTimingLegs: [],
                deferredSettlementLegIds: [],
                deferredSettlementLegs: [],
            };
        };
        if (!simulationDate || !dateUtils
            || typeof dateUtils.resolveExpiryCutoffAsOf !== 'function') {
            return unavailable('timing_runtime_unavailable');
        }

        const explicit = String(globalState && globalState.simulationTargetAsOf || '').trim();
        const explicitMs = Date.parse(explicit);
        if (explicit && Number.isFinite(explicitMs)) {
            return finalize({
                available: true,
                status: 'ok',
                simulationDate,
                targetAsOf: new Date(explicitMs).toISOString(),
                targetMs: explicitMs,
                source: 'explicit',
                precision: 'instant',
            });
        }

        const liveQuoteAsOf = String(globalState && globalState.liveQuoteAsOf || '').trim();
        const liveQuoteMs = Date.parse(liveQuoteAsOf);
        const hasOpenTargetDateOption = _openOptionLegs(globalState).some(
            leg => _normalizeDateValue(leg && leg.expDate) === simulationDate
        );
        if (globalState && globalState.marketDataMode !== 'historical'
            && simulationDate === quoteDate && Number.isFinite(liveQuoteMs)
            && !hasOpenTargetDateOption) {
            return finalize({
                available: true,
                status: 'ok',
                simulationDate,
                targetAsOf: new Date(liveQuoteMs).toISOString(),
                targetMs: liveQuoteMs,
                source: 'live-quote',
                precision: 'instant',
            });
        }

        const candidates = [];
        _openOptionLegs(globalState).forEach((leg) => {
                if (_normalizeDateValue(leg && leg.expDate) !== simulationDate) {
                    return;
                }
                const cutoff = dateUtils.resolveExpiryCutoffAsOf(leg, profile);
                if (cutoff && Number.isFinite(cutoff.cutoffMs)) {
                    candidates.push({
                        legId: String(leg.id || ''),
                        cutoffMs: cutoff.cutoffMs,
                        cutoffAsOf: cutoff.cutoffAsOf,
                        source: cutoff.source,
                    });
                }
        });
        // Missing contract evidence on a target-date leg is more actionable
        // than the ambiguity created by mixing that profile fallback with a
        // different leg's real cutoff, so report the evidence gap first.
        const targetDayAssessment = _assessExactContractTiming(
            globalState,
            null,
            simulationDate,
            profile
        );
        const targetDayMissing = targetDayAssessment.missingContractTimingLegs
            .filter(item => item.reasons.includes('target_expiry_contract_timing_missing'));
        if (targetDayMissing.length > 0) {
            return unavailable('exact_contract_timing_missing', {
                contractTimingStatus: 'exact_contract_timing_missing',
                missingContractTimingLegIds: Array.from(new Set(
                    targetDayMissing.map(item => item.legId)
                )),
                missingContractTimingLegs: targetDayMissing,
            });
        }
        const uniqueCutoffs = Array.from(new Set(candidates.map(item => item.cutoffMs))).sort();
        if (uniqueCutoffs.length > 1) {
            return unavailable('ambiguous_near_leg_cutoff', {
                candidateLegIds: candidates.map(item => item.legId),
                candidateCutoffs: uniqueCutoffs.map(value => new Date(value).toISOString()),
            });
        }
        if (uniqueCutoffs.length === 1) {
            const selected = candidates.find(item => item.cutoffMs === uniqueCutoffs[0]);
            // A date-only target that is also today's near-leg expiry still
            // means "value the calendar when the near leg finishes", not
            // "show me the portfolio at this quote tick".  Before cutoff use
            // the exact future cutoff so the near straddle is deterministic;
            // once the cutoff has passed, use the observable quote instant to
            // avoid back-casting the surviving far leg.
            if (simulationDate === quoteDate && Number.isFinite(liveQuoteMs)
                && liveQuoteMs >= selected.cutoffMs) {
                return finalize({
                    available: true,
                    status: 'ok',
                    simulationDate,
                    targetAsOf: new Date(liveQuoteMs).toISOString(),
                    targetMs: liveQuoteMs,
                    source: 'live-quote-after-near-leg-cutoff',
                    precision: 'instant',
                    candidateLegIds: candidates.map(item => item.legId),
                    nearLegCutoffAsOf: selected.cutoffAsOf,
                });
            }
            return finalize({
                available: true,
                status: 'ok',
                simulationDate,
                targetAsOf: selected.cutoffAsOf,
                targetMs: selected.cutoffMs,
                source: selected.source === 'contract' ? 'near-leg-contract-cutoff' : 'near-leg-profile-cutoff',
                precision: selected.source === 'contract' ? 'contract' : 'profile',
                candidateLegIds: candidates.map(item => item.legId),
            });
        }

        const fallback = dateUtils.resolveExpiryCutoffAsOf(
            { expDate: simulationDate },
            profile,
            simulationDate
        );
        if (!fallback || !Number.isFinite(fallback.cutoffMs)) {
            return unavailable('simulation_cutoff_unavailable');
        }
        return finalize({
            available: true,
            status: 'ok',
            simulationDate,
            targetAsOf: fallback.cutoffAsOf,
            targetMs: fallback.cutoffMs,
            source: 'product-profile-cutoff',
            precision: 'profile',
        });
    }

    function resolveLegTimeToExpiryDays(globalState, leg) {
        if (_isUnderlyingLeg(leg)) return 0;
        const target = resolveSimulationTiming(globalState);
        const expiry = resolveLegExpiryTiming(globalState, leg);
        if (!target.available || !expiry.available) return null;
        return Math.max(0, (expiry.targetMs - target.targetMs) / 86400000);
    }

    function _resolveGroupLivePriceMode(group) {
        const sessionLogic = globalScope.OptionComboSessionLogic;
        if (sessionLogic && typeof sessionLogic.normalizeGroupLivePriceMode === 'function') {
            return sessionLogic.normalizeGroupLivePriceMode(group && group.livePriceMode);
        }
        return String(group && group.livePriceMode || '').trim().toLowerCase() === 'mark'
            ? 'mark'
            : 'midpoint';
    }

    function _resolveLiveQuoteSnapshotForLeg(leg) {
        const liveQuotes = globalScope.OptionComboWsLiveQuotes;
        if (!liveQuotes || !leg) return null;
        if (_isUnderlyingLeg(leg)) {
            if (leg.underlyingFutureId && typeof liveQuotes.getFutureQuote === 'function') {
                return liveQuotes.getFutureQuote(leg.underlyingFutureId);
            }
            return typeof liveQuotes.getUnderlyingQuote === 'function'
                ? liveQuotes.getUnderlyingQuote()
                : null;
        }
        return typeof liveQuotes.getOptionQuote === 'function'
            ? liveQuotes.getOptionQuote(leg.id)
            : null;
    }

    function _nonNegativeFinite(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }

    function _quoteFreshness(globalState, quoteAsOf) {
        const quoteMs = Date.parse(String(quoteAsOf || '').trim());
        const referenceMs = Date.parse(String(globalState && globalState.liveQuoteAsOf || '').trim());
        if (globalState && globalState.liveProjectionFeedConnected === false) {
            return {
                fresh: false,
                ageSeconds: null,
                status: 'feed_disconnected',
            };
        }
        if (globalState && globalState.liveProjectionFeedStale === true) {
            return {
                fresh: false,
                ageSeconds: null,
                status: 'feed_stale',
            };
        }
        if (!Number.isFinite(quoteMs) || !Number.isFinite(referenceMs)) {
            return {
                fresh: false,
                ageSeconds: null,
                status: 'timestamp_unavailable',
            };
        }
        const ageSeconds = Math.abs(referenceMs - quoteMs) / 1000;
        return {
            fresh: ageSeconds <= MAX_LIVE_CARRY_QUOTE_AGE_SECONDS,
            ageSeconds,
            status: ageSeconds <= MAX_LIVE_CARRY_QUOTE_AGE_SECONDS ? 'fresh' : 'stale',
        };
    }

    /**
     * One observable-price policy for both the Live P&L and the exact current
     * point on projection charts.  A midpoint is only constructed from a real
     * two-sided book; model/last marks never fabricate the missing BBO side.
     * Zero is a valid option quote when the transport supplies quote evidence.
     */
    function resolveObservableLegPrice(globalState, group, leg) {
        const unavailable = (status = 'unavailable') => ({
            available: false,
            price: null,
            source: '',
            quoteAsOf: null,
            fresh: false,
            ageSeconds: null,
            quality: status,
        });
        if (!leg) return unavailable();

        const currentPrice = _nonNegativeFinite(leg.currentPrice);
        const currentPriceSource = String(leg.currentPriceSource || '').trim();
        if (currentPriceSource === 'manual' && currentPrice !== null) {
            return {
                available: true,
                price: currentPrice,
                source: 'manual',
                quoteAsOf: null,
                fresh: true,
                ageSeconds: 0,
                quality: 'manual',
            };
        }

        const snapshot = _resolveLiveQuoteSnapshotForLeg(leg);
        const quoteAsOf = String(snapshot && snapshot.quoteAsOf || '').trim() || null;
        const freshness = _quoteFreshness(globalState, quoteAsOf);
        const bid = _nonNegativeFinite(snapshot && snapshot.bid);
        const ask = _nonNegativeFinite(snapshot && snapshot.ask);
        const markSource = String(snapshot && snapshot.markSource || '').trim();
        // bidAskValid is authoritative on the new transport. markSource keeps
        // compatibility with older snapshots that already proved a BBO mid.
        const hasExplicitBboEvidence = !!(snapshot
            && (typeof snapshot.bidAskValid === 'boolean'
                || Object.prototype.hasOwnProperty.call(snapshot, 'bidPresent')
                || Object.prototype.hasOwnProperty.call(snapshot, 'askPresent')));
        const legacyTwoSided = snapshot && !hasExplicitBboEvidence && !markSource
            && bid !== null && bid > 0 && ask !== null && ask > 0 && ask >= bid;
        const hasAuthoritativeBboValidity = snapshot
            && typeof snapshot.bidAskValid === 'boolean';
        const realTwoSided = snapshot && (
            hasAuthoritativeBboValidity
                ? snapshot.bidAskValid === true
                : (markSource === 'bid_ask_mid' || legacyTwoSided)
        ) && snapshot.bidPresent !== false && snapshot.askPresent !== false
            && bid !== null && ask !== null && ask >= bid;
        const midpoint = realTwoSided ? (bid + ask) / 2 : null;
        const portfolioMarketPrice = _nonNegativeFinite(leg.portfolioMarketPrice);
        const portfolioQuoteAsOf = String(leg.portfolioMarketPriceAsOf || '').trim() || null;
        const portfolioFreshness = _quoteFreshness(globalState, portfolioQuoteAsOf);
        const mode = _resolveGroupLivePriceMode(group);

        const quoteResult = (price, source, timestamp, quality) => {
            const selectedFreshness = source === 'tws_portfolio'
                ? portfolioFreshness
                : freshness;
            return {
                available: true,
                price,
                source,
                quoteAsOf: timestamp,
                fresh: selectedFreshness.fresh,
                ageSeconds: selectedFreshness.ageSeconds,
                quality: selectedFreshness.fresh
                    ? quality
                    : `${quality}_${selectedFreshness.status}`,
            };
        };

        if (mode === 'mark' && portfolioMarketPrice !== null) {
            return quoteResult(
                portfolioMarketPrice,
                'tws_portfolio',
                portfolioQuoteAsOf,
                'portfolio_mark'
            );
        }
        if (midpoint !== null) {
            return quoteResult(midpoint, 'live_midpoint', quoteAsOf, 'two_sided_bbo');
        }
        if (portfolioMarketPrice !== null) {
            return quoteResult(
                portfolioMarketPrice,
                'tws_portfolio',
                portfolioQuoteAsOf,
                'portfolio_mark_fallback'
            );
        }

        const snapshotMark = _nonNegativeFinite(snapshot && snapshot.mark);
        if (snapshotMark !== null && markSource
            && (markSource !== 'bid_ask_mid' || realTwoSided)) {
            return quoteResult(
                snapshotMark,
                markSource === 'model' ? 'tws_model' : `live_${markSource}`,
                quoteAsOf,
                markSource
            );
        }
        if (currentPrice !== null && currentPriceSource !== 'missing'
            && (currentPrice > 0 || !!currentPriceSource)) {
            const historical = currentPriceSource === 'historical';
            return {
                available: true,
                price: currentPrice,
                source: currentPriceSource || 'current_price',
                quoteAsOf: historical ? resolveQuoteDate(globalState) : quoteAsOf,
                fresh: historical || freshness.fresh,
                ageSeconds: historical ? 0 : freshness.ageSeconds,
                quality: historical ? 'historical' : `current_price_${freshness.status}`,
            };
        }
        return unavailable(realTwoSided ? 'mark_unavailable' : 'two_sided_book_unavailable');
    }

    function _getReferenceContractMonth(globalState) {
        const dateText = resolveQuoteDate(globalState);
        return _normalizeContractMonth(dateText);
    }

    function _sortFuturesEntries(entries) {
        return entries.slice().sort((left, right) =>
            String(left.contractMonth || '').localeCompare(String(right.contractMonth || ''))
        );
    }

    function _getValidFuturesPoolEntries(globalState) {
        return _sortFuturesEntries(
            (globalState && Array.isArray(globalState.futuresPool) ? globalState.futuresPool : [])
                .filter(entry => /^\d{6}$/.test(_normalizeContractMonth(entry && entry.contractMonth)))
        );
    }

    function _resolveFutureEntryPrice(entry) {
        if (!entry || typeof entry !== 'object') {
            return null;
        }
        const mark = _toFiniteNumber(entry.mark);
        const bid = _toFiniteNumber(entry.bid);
        const ask = _toFiniteNumber(entry.ask);
        if (mark !== null && mark > 0) return mark;
        if (bid !== null && bid > 0 && ask !== null && ask > 0 && ask >= bid) {
            return (bid + ask) / 2;
        }
        if (ask !== null && ask > 0) return ask;
        return bid !== null && bid > 0 ? bid : null;
    }

    function _normalizeContractDate(value) {
        const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
        if (digits.length === 8) {
            return _normalizeDateValue(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`);
        }
        return _normalizeDateValue(value);
    }

    function _timestampMilliseconds(value) {
        const parsed = Date.parse(String(value || '').trim());
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _multipliersMatch(left, right) {
        const leftText = String(left || '').trim();
        const rightText = String(right || '').trim();
        if (!leftText || !rightText) return false;
        const leftNumber = Number(leftText);
        const rightNumber = Number(rightText);
        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
            return Math.abs(leftNumber - rightNumber) <= 1e-9;
        }
        return leftText === rightText;
    }

    /**
     * A Futures Pool mark is a Black-76 input, not a cosmetic quote.  In live
     * mode it is usable only when ws_client proved that it belongs to the
     * current generation and the qualified IB contract matches the request.
     * Historical replay has its own atomic snapshot boundary and is exempt.
     */
    function _resolveBoundFutureEntryQuality(globalState, entry) {
        if (globalState && globalState.marketDataMode === 'historical') {
            return { status: 'historical', flags: [], usable: true };
        }

        const flags = [];
        const profile = productRegistry
            && typeof productRegistry.resolveUnderlyingProfile === 'function'
            ? productRegistry.resolveUnderlyingProfile(globalState && globalState.underlyingSymbol)
            : null;
        const expectedSecType = 'FUT';
        const expectedSymbol = String(
            profile && profile.underlyingSymbol
            || globalState && globalState.underlyingSymbol
            || ''
        ).trim().toUpperCase();
        const expectedExchange = String(profile && profile.underlyingExchange || '').trim().toUpperCase();
        const expectedCurrency = String(profile && profile.currency || 'USD').trim().toUpperCase();
        const expectedMultiplier = String(
            profile && (profile.underlyingLegMultiplier || profile.optionMultiplier) || ''
        ).trim();
        const expectedMonth = _normalizeContractMonth(entry && entry.contractMonth);

        if (!entry || entry.liveQuoteIdentityStatus !== 'verified'
            || entry.requestIdentityVerified !== true) {
            flags.push('future_request_identity_unverified');
        }

        const activeGeneration = parseInt(globalState && globalState.liveFuturesRequestGeneration, 10);
        const quoteGeneration = parseInt(entry && entry.liveQuoteRequestGeneration, 10);
        if (!(activeGeneration > 0)) {
            flags.push('future_request_generation_unavailable');
        } else if (!(quoteGeneration > 0) || quoteGeneration !== activeGeneration) {
            flags.push('future_request_generation_mismatch');
        }
        if (!String(entry && entry.liveQuoteRequestId || '').trim()) {
            flags.push('future_request_id_unavailable');
        }

        const conId = parseInt(entry && entry.conId, 10);
        if (!(conId > 0)) flags.push('future_con_id_unavailable');
        if (String(entry && entry.secType || '').trim().toUpperCase() !== expectedSecType) {
            flags.push('future_sec_type_mismatch');
        }
        if (!expectedSymbol
            || String(entry && entry.symbol || '').trim().toUpperCase() !== expectedSymbol) {
            flags.push('future_symbol_mismatch');
        }
        if (!expectedMonth
            || _normalizeContractMonth(entry && entry.qualifiedContractMonth) !== expectedMonth) {
            flags.push('future_contract_month_mismatch');
        }
        if (expectedExchange
            && String(entry && entry.exchange || '').trim().toUpperCase() !== expectedExchange) {
            flags.push('future_exchange_mismatch');
        }
        if (String(entry && entry.currency || '').trim().toUpperCase() !== expectedCurrency) {
            flags.push('future_currency_mismatch');
        }
        if (expectedMultiplier && !_multipliersMatch(entry && entry.multiplier, expectedMultiplier)) {
            flags.push('future_multiplier_mismatch');
        }

        if (_normalizeContractMonth(entry && entry.requestedContractMonth) !== expectedMonth) {
            flags.push('future_requested_contract_month_mismatch');
        }
        if (String(entry && entry.requestedSecType || '').trim().toUpperCase() !== expectedSecType) {
            flags.push('future_requested_sec_type_mismatch');
        }
        if (String(entry && entry.requestedSymbol || '').trim().toUpperCase() !== expectedSymbol) {
            flags.push('future_requested_symbol_mismatch');
        }
        if (expectedMultiplier
            && !_multipliersMatch(entry && entry.requestedMultiplier, expectedMultiplier)) {
            flags.push('future_requested_multiplier_mismatch');
        }

        const quoteMs = _timestampMilliseconds(entry && (entry.quoteAsOf || entry.lastQuotedAt));
        const snapshotMs = _timestampMilliseconds(globalState && globalState.liveQuoteAsOf);
        if (quoteMs === null) flags.push('future_quote_timestamp_unavailable');
        if (snapshotMs === null) flags.push('snapshot_quote_timestamp_unavailable');
        const ageSeconds = quoteMs !== null && snapshotMs !== null
            ? (snapshotMs - quoteMs) / 1000
            : null;
        if (ageSeconds !== null && ageSeconds > MAX_LIVE_CARRY_QUOTE_AGE_SECONDS) {
            flags.push('future_quote_stale');
        }
        if (ageSeconds !== null && ageSeconds < -MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS) {
            flags.push('future_quote_after_snapshot');
        }

        return {
            status: flags.length === 0 ? 'good' : 'invalid',
            flags,
            usable: flags.length === 0,
            requestGeneration: quoteGeneration > 0 ? quoteGeneration : null,
            activeRequestGeneration: activeGeneration > 0 ? activeGeneration : null,
            quoteAsOf: String(entry && (entry.quoteAsOf || entry.lastQuotedAt) || '').trim(),
            ageSeconds,
            maxQuoteAgeSeconds: MAX_LIVE_CARRY_QUOTE_AGE_SECONDS,
            maxQuoteSkewSeconds: MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS,
        };
    }

    function _resolveFopCarryQuoteQuality(globalState, futureQuoteAsOf, referenceQuoteAsOf, options = {}) {
        const flags = [];
        const futureMs = _timestampMilliseconds(futureQuoteAsOf);
        const referenceMs = _timestampMilliseconds(referenceQuoteAsOf);
        const snapshotQuoteAsOf = String(globalState && globalState.liveQuoteAsOf || '').trim();
        const snapshotMs = _timestampMilliseconds(snapshotQuoteAsOf);
        const isLive = !globalState || globalState.marketDataMode !== 'historical';

        if (!options.hasExactExpiry) flags.push('exact_futures_expiry_unavailable');
        if (!options.hasFuturePrice) flags.push('future_quote_unavailable');
        if (!options.hasReferencePrice) flags.push('carry_reference_quote_unavailable');
        if (!options.currencyMatches) flags.push('carry_reference_currency_mismatch');
        if (futureMs === null) flags.push('future_quote_timestamp_unavailable');
        if (referenceMs === null) flags.push('carry_reference_timestamp_unavailable');
        if (isLive && snapshotMs === null) flags.push('snapshot_quote_timestamp_unavailable');

        const quoteSkewSeconds = futureMs !== null && referenceMs !== null
            ? Math.abs(futureMs - referenceMs) / 1000
            : null;
        if (quoteSkewSeconds !== null && quoteSkewSeconds > MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS) {
            flags.push('future_reference_quote_skew_exceeded');
        }

        let futureAgeSeconds = null;
        let referenceAgeSeconds = null;
        if (isLive && snapshotMs !== null) {
            if (futureMs !== null) futureAgeSeconds = (snapshotMs - futureMs) / 1000;
            if (referenceMs !== null) referenceAgeSeconds = (snapshotMs - referenceMs) / 1000;
            if (futureAgeSeconds !== null && futureAgeSeconds > MAX_LIVE_CARRY_QUOTE_AGE_SECONDS) {
                flags.push('future_quote_stale');
            }
            if (referenceAgeSeconds !== null && referenceAgeSeconds > MAX_LIVE_CARRY_QUOTE_AGE_SECONDS) {
                flags.push('carry_reference_quote_stale');
            }
            if (futureAgeSeconds !== null && futureAgeSeconds < -MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS) {
                flags.push('future_quote_after_snapshot');
            }
            if (referenceAgeSeconds !== null && referenceAgeSeconds < -MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS) {
                flags.push('carry_reference_quote_after_snapshot');
            }
        }

        return {
            status: flags.length === 0 ? 'good' : 'unavailable',
            flags,
            usable: flags.length === 0,
            snapshotQuoteAsOf,
            futureQuoteAsOf: String(futureQuoteAsOf || '').trim(),
            referenceQuoteAsOf: String(referenceQuoteAsOf || '').trim(),
            quoteSkewSeconds,
            futureAgeSeconds,
            referenceAgeSeconds,
            maxQuoteAgeSeconds: MAX_LIVE_CARRY_QUOTE_AGE_SECONDS,
            maxQuoteSkewSeconds: MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS,
        };
    }

    function _resolveFuturesIntervalQuality(globalState, previousPoint, point, intervalDays) {
        const flags = [];
        const previousMs = _timestampMilliseconds(previousPoint && previousPoint.quoteAsOf);
        const pointMs = _timestampMilliseconds(point && point.quoteAsOf);
        const snapshotQuoteAsOf = String(globalState && globalState.liveQuoteAsOf || '').trim();
        const snapshotMs = _timestampMilliseconds(snapshotQuoteAsOf);
        const isLive = !globalState || globalState.marketDataMode !== 'historical';
        const hasExactInterval = !!(previousPoint && previousPoint.expiry && point && point.expiry
            && intervalDays > 0);
        const hasPrices = !!(previousPoint && previousPoint.forwardPrice > 0
            && point && point.forwardPrice > 0);

        if (!hasExactInterval) flags.push('exact_interval_expiries_unavailable');
        if (!hasPrices) flags.push('interval_future_quote_unavailable');
        if (previousMs === null) flags.push('interval_start_quote_timestamp_unavailable');
        if (pointMs === null) flags.push('interval_end_quote_timestamp_unavailable');
        if (isLive && snapshotMs === null) flags.push('snapshot_quote_timestamp_unavailable');

        const quoteSkewSeconds = previousMs !== null && pointMs !== null
            ? Math.abs(previousMs - pointMs) / 1000
            : null;
        if (quoteSkewSeconds !== null && quoteSkewSeconds > MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS) {
            flags.push('futures_interval_quote_skew_exceeded');
        }

        let startAgeSeconds = null;
        let endAgeSeconds = null;
        if (isLive && snapshotMs !== null) {
            if (previousMs !== null) startAgeSeconds = (snapshotMs - previousMs) / 1000;
            if (pointMs !== null) endAgeSeconds = (snapshotMs - pointMs) / 1000;
            if (startAgeSeconds !== null && startAgeSeconds > MAX_LIVE_CARRY_QUOTE_AGE_SECONDS) {
                flags.push('interval_start_quote_stale');
            }
            if (endAgeSeconds !== null && endAgeSeconds > MAX_LIVE_CARRY_QUOTE_AGE_SECONDS) {
                flags.push('interval_end_quote_stale');
            }
            if (startAgeSeconds !== null && startAgeSeconds < -MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS) {
                flags.push('interval_start_quote_after_snapshot');
            }
            if (endAgeSeconds !== null && endAgeSeconds < -MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS) {
                flags.push('interval_end_quote_after_snapshot');
            }
        }

        return {
            status: flags.length === 0 ? 'good' : 'unavailable',
            flags,
            usable: flags.length === 0,
            snapshotQuoteAsOf,
            startQuoteAsOf: String(previousPoint && previousPoint.quoteAsOf || '').trim(),
            endQuoteAsOf: String(point && point.quoteAsOf || '').trim(),
            quoteSkewSeconds,
            startAgeSeconds,
            endAgeSeconds,
            maxQuoteAgeSeconds: MAX_LIVE_CARRY_QUOTE_AGE_SECONDS,
            maxQuoteSkewSeconds: MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS,
        };
    }

    function _resolveForwardCarryPolicy(globalState) {
        if (productRegistry && typeof productRegistry.resolveForwardCarryPolicy === 'function') {
            return productRegistry.resolveForwardCarryPolicy(globalState && globalState.underlyingSymbol);
        }
        return {
            family: String(globalState && globalState.underlyingSymbol || '').trim().toUpperCase(),
            currency: 'USD',
            pricingInputMode: _resolvePricingInputMode(globalState),
            forwardSource: _resolvePricingInputMode(globalState) === 'FOP'
                ? 'bound-futures-quote'
                : 'spot-bsm',
            carrySource: 'unknown',
            carrySemantics: 'unknown',
            carryReference: null,
            requiresPerLegForwardBinding: _resolvePricingInputMode(globalState) === 'FOP',
            rateMaySubstituteForCarry: false,
        };
    }

    function resolveAnchorFutureEntry(globalState) {
        const entries = _getValidFuturesPoolEntries(globalState);
        if (entries.length === 0) {
            return null;
        }

        const referenceMonth = _getReferenceContractMonth(globalState);
        if (!referenceMonth) {
            return entries[0];
        }

        return entries.find(entry => String(entry.contractMonth || '') >= referenceMonth) || entries[0];
    }

    function resolveAnchorDisplayInfo(globalState, fallbackPrice) {
        const pricingMode = _resolvePricingInputMode(globalState);
        const symbol = String(globalState && globalState.underlyingSymbol || 'Underlying').trim().toUpperCase() || 'Underlying';
        const anchorPrice = resolveAnchorUnderlyingPrice(globalState, fallbackPrice);

        if (pricingMode !== 'FOP') {
            const title = pricingMode === 'INDEX' ? 'Index Anchor' : 'Current Underlying';
            const shortLabel = pricingMode === 'INDEX' ? `${symbol} spot` : symbol;

            return {
                pricingMode,
                isFutureAnchor: false,
                price: anchorPrice,
                title,
                shortLabel,
                lineLabel: 'Current',
                displayText: `${title}: ${shortLabel} @ $${anchorPrice.toFixed(2)}`,
                detailText: pricingMode === 'INDEX'
                    ? 'Percent labels are measured from the current index spot.'
                    : 'Percent labels are measured from the current underlying price.',
            };
        }

        const anchorEntry = resolveAnchorFutureEntry(globalState);
        const futurePrice = _resolveFutureEntryPrice(anchorEntry);
        const contractMonth = _normalizeContractMonth(anchorEntry && anchorEntry.contractMonth);
        const formattedMonth = _formatContractMonth(contractMonth);
        const shortLabel = contractMonth ? `${symbol} ${formattedMonth}` : `${symbol} future`;
        const usingFallbackPrice = !Number.isFinite(futurePrice);
        const priceText = `$${anchorPrice.toFixed(2)}`;

        return {
            pricingMode,
            isFutureAnchor: true,
            symbol,
            contractMonth,
            price: anchorPrice,
            title: 'Anchor Future',
            shortLabel,
            lineLabel: 'Anchor',
            displayText: usingFallbackPrice
                ? `Anchor Future: ${shortLabel} (using fallback price ${priceText})`
                : `Anchor Future: ${shortLabel} @ ${priceText}`,
            detailText: 'X-axis and percent moves use this future; other futures are repriced on the same % move.',
        };
    }

    function resolveAnchorUnderlyingPrice(globalState, fallbackPrice) {
        const fallback = _toFiniteNumber(fallbackPrice)
            ?? _toFiniteNumber(globalState && globalState.underlyingPrice)
            ?? 0;

        if (_resolvePricingInputMode(globalState) !== 'FOP') {
            return fallback;
        }

        const anchorEntry = resolveAnchorFutureEntry(globalState);
        return _resolveFutureEntryPrice(anchorEntry) ?? fallback;
    }

    function _resolveIndexLegDaysToExpiry(globalState, leg) {
        return resolveLegTimeToExpiryDays(globalState, leg);
    }

    function _resolveIndexLegForwardObservation(globalState, leg, spotPrice) {
        if (_isUnderlyingLeg(leg)) {
            return {
                kind: 'forward',
                forwardPrice: spotPrice,
                source: 'index_spot_underlying_leg',
                carryObservation: null,
                usable: Number.isFinite(spotPrice) && spotPrice > 0,
            };
        }

        if (!indexForwardRate
            || typeof indexForwardRate.resolveForwardPriceFromSpot !== 'function') {
            return {
                kind: 'forward',
                forwardPrice: null,
                source: 'index_parity_runtime_unavailable',
                carryObservation: null,
                quality: { status: 'invalid', flags: ['index_parity_runtime_unavailable'] },
                usable: false,
            };
        }

        const daysToExpiry = _resolveIndexLegDaysToExpiry(globalState, leg);
        if (!Number.isFinite(daysToExpiry)) {
            return {
                kind: 'forward',
                forwardPrice: null,
                source: 'simulation_timing_unavailable',
                carryObservation: null,
                quality: { status: 'invalid', flags: ['simulation_timing_unavailable'] },
                usable: false,
            };
        }
        if (daysToExpiry <= 1e-12) {
            return {
                kind: 'forward',
                forwardPrice: spotPrice,
                source: 'index_expired_intrinsic_spot',
                carryObservation: null,
                quality: { status: 'good', flags: [] },
                usable: Number.isFinite(spotPrice) && spotPrice > 0,
            };
        }
        const target = {
            expDate: leg && leg.expDate,
            daysToExpiry,
            asOf: resolveSimulationDate(globalState),
            quoteAsOf: globalState && globalState.marketDataMode !== 'historical'
                ? globalState.liveQuoteAsOf
                : '',
        };
        const carryObservation = typeof indexForwardRate.resolveCarryObservationForTarget === 'function'
            ? indexForwardRate.resolveCarryObservationForTarget(
                globalState && globalState.forwardRateSamples,
                target
            )
            : null;
        const dailyCarry = carryObservation && Number.isFinite(carryObservation.carryRate)
            ? carryObservation.carryRate / 365
            : (typeof indexForwardRate.resolveDailyCarryForTarget === 'function'
                ? indexForwardRate.resolveDailyCarryForTarget(
                    globalState && globalState.forwardRateSamples,
                    target
                )
                : null);

        if (!Number.isFinite(dailyCarry)) {
            return {
                kind: 'forward',
                forwardPrice: null,
                source: 'index_parity_carry_unavailable',
                carryObservation: null,
                quality: { status: 'invalid', flags: ['missing_parity_carry_sample'] },
                usable: false,
            };
        }

        return {
            kind: 'forward',
            forwardPrice: indexForwardRate.resolveForwardPriceFromSpot(
                spotPrice,
                dailyCarry,
                daysToExpiry
            ),
            source: 'option_put_call_parity_carry',
            carryObservation,
            quoteAsOf: String(carryObservation && carryObservation.quoteAsOf || '').trim(),
            quality: carryObservation && carryObservation.quality || { status: 'unknown', flags: [] },
            usable: Number.isFinite(spotPrice) && spotPrice > 0,
        };
    }

    function _resolveIndexLegForwardPrice(globalState, leg, spotPrice) {
        return _resolveIndexLegForwardObservation(globalState, leg, spotPrice).forwardPrice;
    }

    function _manualDiscountObservation(rate, daysToExpiry, reason) {
        const zeroRate = _toFiniteNumber(rate) ?? 0;
        const tenorDays = Math.max(0, _toFiniteNumber(daysToExpiry) ?? 0);
        const timeYears = tenorDays / 365;
        return {
            kind: 'discount',
            zeroRate,
            discountFactor: Math.exp(-zeroRate * timeYears),
            tenorDays,
            timeYears,
            source: 'manual_fallback',
            fallbackUsed: true,
            reason: String(reason || 'manual_selected'),
            usable: true,
        };
    }

    function resolveLegDiscountObservation(globalState, leg, fallbackRate) {
        const fallback = _toFiniteNumber(fallbackRate)
            ?? _toFiniteNumber(globalState && globalState.interestRate)
            ?? 0;
        const daysToExpiry = _isUnderlyingLeg(leg)
            ? 0
            : _resolveIndexLegDaysToExpiry(globalState, leg);
        if (!Number.isFinite(daysToExpiry)) {
            return {
                kind: 'discount',
                zeroRate: null,
                discountFactor: null,
                tenorDays: null,
                timeYears: null,
                source: 'simulation_timing_unavailable',
                fallbackUsed: false,
                reason: 'simulation_timing_unavailable',
                usable: false,
            };
        }
        if (!globalState || globalState.useMarketDiscountCurve === false) {
            return _manualDiscountObservation(fallback, daysToExpiry, 'market_curve_disabled');
        }
        const curve = globalState.discountCurve;
        if (!marketCurves || typeof marketCurves.resolveDiscount !== 'function'
            || !curve || curve.kind !== 'discount') {
            return _manualDiscountObservation(fallback, daysToExpiry, 'market_curve_unavailable');
        }
        const policy = _resolveForwardCarryPolicy(globalState);
        const productCurrency = String(policy.currency || '').trim().toUpperCase();
        const curveCurrency = String(curve.currency || '').trim().toUpperCase();
        if (!productCurrency || !curveCurrency || productCurrency !== curveCurrency) {
            return _manualDiscountObservation(fallback, daysToExpiry, 'discount_curve_currency_mismatch');
        }

        const quoteDate = resolveQuoteDate(globalState);
        // Weekend/holiday updater runs stamp curveAsOf after the last session
        // while the economic data (effectiveDate) still belongs to it, so both
        // the look-ahead and staleness checks compare the data date instead of
        // the stamp date.
        const curveDataDate = _normalizeDateValue(curve.effectiveDate)
            || _normalizeDateValue(curve.asOf);
        if (quoteDate && curveDataDate) {
            const ageDays = _signedCalendarDayDifference(curveDataDate, quoteDate);
            if (!Number.isFinite(ageDays) || ageDays < 0
                || (globalState.marketDataMode !== 'historical'
                    && ageDays > MAX_LIVE_DISCOUNT_CURVE_AGE_DAYS)) {
                return _manualDiscountObservation(fallback, daysToExpiry, 'market_curve_stale');
            }
        }

        try {
            const resolved = marketCurves.resolveDiscount(curve, daysToExpiry, {
                // Canonical snapshots begin at the overnight point. Legacy
                // Treasury-only curves may still start near one month, so the
                // same explicit 31-day extrapolation bound remains compatible.
                maxExtrapolationDays: Math.max(31, Number(curve.maxExtrapolationDays) || 0),
            });
            if (resolved && resolved.usable !== false
                && Number.isFinite(resolved.zeroRate)
                && Number.isFinite(resolved.discountFactor)) {
                return {
                    ...resolved,
                    source: resolved.metadata && resolved.metadata.source || 'market_curve',
                    fallbackUsed: false,
                };
            }
        } catch (_error) {
            // Fail closed to the explicit, visible manual fallback.
        }
        return _manualDiscountObservation(fallback, daysToExpiry, 'market_curve_unusable');
    }

    function resolveLegInterestRate(globalState, leg, fallbackRate) {
        return resolveLegDiscountObservation(globalState, leg, fallbackRate).zeroRate;
    }

    /**
     * Resolve the inputs used to invert a live option BBO at its quote anchor.
     * This is deliberately separate from target repricing: INDEX forwards and
     * discount tenors must be rebuilt at quoteAsOf -> expiry, not borrowed
     * from the shorter future simulation target -> expiry interval.
     */
    function resolveLegQuotePricingInputs(globalState, leg, fallback = {}) {
        const unavailable = (status, extra = {}) => ({
            available: false,
            status,
            quoteAsOf: null,
            underlyingPrice: null,
            underlyingAsOf: null,
            interestRate: null,
            ...extra,
        });
        if (!globalState || typeof globalState !== 'object' || !leg) {
            return unavailable('quote_state_unavailable');
        }
        if (globalState.marketDataMode === 'historical') {
            return unavailable('live_bbo_anchor_not_applicable');
        }

        const rawQuoteAsOf = String(globalState.liveQuoteAsOf || '').trim();
        const quoteMs = Date.parse(rawQuoteAsOf);
        const quoteDate = resolveQuoteDate(globalState);
        if (!quoteDate || !Number.isFinite(quoteMs)) {
            return unavailable('quote_timestamp_unavailable');
        }
        const quoteAsOf = new Date(quoteMs).toISOString();
        const quoteState = {
            ...globalState,
            simulatedDate: quoteDate,
            simulationTargetAsOf: quoteAsOf,
            simulationTiming: null,
        };
        const pricingMode = _resolvePricingInputMode(globalState);
        const fallbackPrice = _toFiniteNumber(
            fallback && typeof fallback === 'object' ? fallback.underlyingPrice : fallback
        );
        const fallbackRate = _toFiniteNumber(
            fallback && typeof fallback === 'object' ? fallback.interestRate : null
        ) ?? _toFiniteNumber(globalState.interestRate) ?? 0;
        const quoteAnchorPrice = pricingMode === 'FOP'
            ? resolveAnchorUnderlyingPrice(globalState, fallbackPrice)
            : (_toFiniteNumber(globalState.underlyingPrice) ?? fallbackPrice);
        const underlyingObservation = resolveLegForwardObservation(
            quoteState,
            leg,
            quoteAnchorPrice
        );
        const underlyingPrice = underlyingObservation && underlyingObservation.kind === 'spot'
            ? _toFiniteNumber(underlyingObservation.spotPrice)
            : _toFiniteNumber(underlyingObservation && underlyingObservation.forwardPrice);
        if (!underlyingObservation || underlyingObservation.usable === false
            || !Number.isFinite(underlyingPrice) || underlyingPrice <= 0) {
            return unavailable('quote_underlying_unavailable', { underlyingObservation });
        }

        const rawUnderlyingAsOf = String(underlyingObservation.quoteAsOf || '').trim();
        const underlyingMs = Date.parse(rawUnderlyingAsOf);
        if (!Number.isFinite(underlyingMs)) {
            return unavailable('quote_underlying_timestamp_unavailable', { underlyingObservation });
        }
        if (Math.abs(underlyingMs - quoteMs) > MAX_LIVE_CARRY_QUOTE_SKEW_SECONDS * 1000) {
            return unavailable('quote_underlying_stale', {
                underlyingObservation,
                underlyingAsOf: new Date(underlyingMs).toISOString(),
            });
        }

        const discountObservation = resolveLegDiscountObservation(
            quoteState,
            leg,
            fallbackRate
        );
        const interestRate = _toFiniteNumber(discountObservation && discountObservation.zeroRate);
        if (!discountObservation || discountObservation.usable === false
            || !Number.isFinite(interestRate)) {
            return unavailable('quote_discount_unavailable', {
                underlyingObservation,
                discountObservation,
            });
        }

        return {
            available: true,
            status: 'ok',
            quoteAsOf,
            underlyingPrice,
            underlyingAsOf: new Date(underlyingMs).toISOString(),
            underlyingSource: String(underlyingObservation.source || '').trim(),
            interestRate,
            interestRateSource: String(discountObservation.source || '').trim(),
            underlyingObservation,
            discountObservation,
        };
    }

    function _isClosedLeg(leg) {
        return !!(leg
            && leg.closePrice !== null
            && leg.closePrice !== ''
            && leg.closePrice !== undefined);
    }

    /**
     * Aggregate per-open-leg discount fallback usage so the UI can surface
     * why legs silently stopped using the market curve ('market_curve_stale',
     * 'discount_curve_currency_mismatch', ...) instead of reporting the curve
     * as active while every leg discounts at the manual rate.
     */
    function summarizeDiscountFallback(globalState, fallbackRate) {
        const groups = globalState && Array.isArray(globalState.groups) ? globalState.groups : [];
        let legCount = 0;
        let fallbackCount = 0;
        const reasonCounts = new Map();
        groups.forEach((group) => {
            (Array.isArray(group && group.legs) ? group.legs : []).forEach((leg) => {
                if (!leg || _isClosedLeg(leg)) {
                    return;
                }
                legCount += 1;
                let observation = null;
                try {
                    observation = resolveLegDiscountObservation(globalState, leg, fallbackRate);
                } catch (_error) {
                    observation = null;
                }
                if (!observation || observation.fallbackUsed !== true) {
                    return;
                }
                fallbackCount += 1;
                const reason = String(observation.reason || 'unknown');
                reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
            });
        });
        return {
            legCount,
            fallbackCount,
            reasons: Array.from(reasonCounts.entries())
                .map(([reason, count]) => ({ reason, count }))
                .sort((left, right) =>
                    right.count - left.count || left.reason.localeCompare(right.reason)),
        };
    }

    function resolveLegFutureEntry(globalState, leg) {
        if (!leg || !leg.underlyingFutureId) {
            return null;
        }

        return (globalState && Array.isArray(globalState.futuresPool) ? globalState.futuresPool : [])
            .find(entry => entry && entry.id === leg.underlyingFutureId) || null;
    }

    function resolveLegForwardObservation(globalState, leg, fallbackPrice) {
        const fallback = _toFiniteNumber(fallbackPrice)
            ?? resolveAnchorUnderlyingPrice(globalState, fallbackPrice);
        const pricingMode = _resolvePricingInputMode(globalState);
        const policy = _resolveForwardCarryPolicy(globalState);

        if (pricingMode === 'INDEX') {
            return {
                ..._resolveIndexLegForwardObservation(globalState, leg, fallback),
                pricingMode,
                policy,
            };
        }

        if (pricingMode !== 'FOP') {
            // `liveQuoteAsOf` is the newest timestamp across every payload,
            // not necessarily the timestamp of the cash underlier.  Preserve
            // the actual underlier quote evidence so the strict local-IV gate
            // cannot pair an old spot with a newer option BBO.
            const underlyingSnapshot = globalState
                && globalState.marketDataMode !== 'historical'
                ? _resolveLiveQuoteSnapshotForLeg({ type: 'underlying' })
                : null;
            const observedSpot = _toFiniteNumber(underlyingSnapshot && underlyingSnapshot.mark);
            const spotPrice = observedSpot !== null ? observedSpot : fallback;
            return {
                kind: 'spot',
                spotPrice,
                pricingInput: spotPrice,
                source: 'cash_spot_quote',
                quoteAsOf: observedSpot !== null
                    ? String(underlyingSnapshot && underlyingSnapshot.quoteAsOf || '').trim()
                    : '',
                pricingMode,
                policy,
                usable: Number.isFinite(spotPrice) && spotPrice > 0,
            };
        }

        const requestedEntryId = String(leg && leg.underlyingFutureId || '').trim();
        const entry = resolveLegFutureEntry(globalState, leg);
        const entryPrice = _resolveFutureEntryPrice(entry);
        const entryQuality = entry
            ? _resolveBoundFutureEntryQuality(globalState, entry)
            : null;
        if (entry && Number.isFinite(entryPrice) && entryPrice > 0
            && entryQuality && entryQuality.usable === true) {
            return {
                kind: 'forward',
                forwardPrice: entryPrice,
                pricingInput: entryPrice,
                source: 'bound_futures_quote',
                pricingMode,
                policy,
                futuresPoolEntryId: entry.id,
                contractMonth: _normalizeContractMonth(entry.contractMonth),
                expiry: _normalizeContractDate(entry.lastTradeDate),
                quoteAsOf: String(entry.quoteAsOf || entry.lastQuotedAt || '').trim(),
                quality: entryQuality,
                usable: true,
            };
        }

        const configuredEntries = _getValidFuturesPoolEntries(globalState);
        if (!requestedEntryId && configuredEntries.length === 1) {
            const onlyEntry = configuredEntries[0];
            const onlyPrice = _resolveFutureEntryPrice(onlyEntry);
            const onlyEntryQuality = _resolveBoundFutureEntryQuality(globalState, onlyEntry);
            if (onlyPrice !== null && onlyPrice > 0 && onlyEntryQuality.usable === true) {
                return {
                    kind: 'forward',
                    forwardPrice: onlyPrice,
                    pricingInput: onlyPrice,
                    source: 'single_pool_legacy_fallback',
                    pricingMode,
                    policy,
                    futuresPoolEntryId: onlyEntry.id,
                    contractMonth: _normalizeContractMonth(onlyEntry.contractMonth),
                    expiry: _normalizeContractDate(onlyEntry.lastTradeDate),
                    quoteAsOf: String(onlyEntry.quoteAsOf || onlyEntry.lastQuotedAt || '').trim(),
                    quality: {
                        status: 'degraded',
                        flags: [
                            'legacy_leg_missing_binding_single_pool_entry_used',
                            ...(onlyEntryQuality.flags || []),
                        ],
                        requestGeneration: onlyEntryQuality.requestGeneration,
                        activeRequestGeneration: onlyEntryQuality.activeRequestGeneration,
                        quoteAsOf: onlyEntryQuality.quoteAsOf,
                        ageSeconds: onlyEntryQuality.ageSeconds,
                    },
                    usable: true,
                };
            }
        }

        const legacyContractMonth = _normalizeContractMonth(
            globalState && globalState.underlyingContractMonth
        );
        const legacyPrice = _toFiniteNumber(globalState && globalState.underlyingPrice);
        const selectedContractMonth = _normalizeContractMonth(entry && entry.contractMonth);
        const canUseLegacyQuote = legacyPrice !== null && legacyPrice > 0
            && globalState && globalState.marketDataMode === 'historical'
            && !requestedEntryId && configuredEntries.length === 0;
        if (canUseLegacyQuote) {
            return {
                kind: 'forward',
                forwardPrice: legacyPrice,
                pricingInput: legacyPrice,
                source: 'legacy_shared_futures_quote',
                pricingMode,
                policy,
                futuresPoolEntryId: '',
                contractMonth: legacyContractMonth,
                quoteAsOf: String(globalState && globalState.liveQuoteAsOf || '').trim(),
                quality: {
                    status: 'degraded',
                    flags: ['legacy_shared_future_without_pool_binding'],
                },
                usable: true,
            };
        }

        return {
            kind: 'forward',
            forwardPrice: null,
            pricingInput: null,
            source: requestedEntryId ? 'bound_futures_quote_unavailable' : 'futures_binding_missing',
            pricingMode,
            policy,
            futuresPoolEntryId: requestedEntryId,
            contractMonth: selectedContractMonth || legacyContractMonth,
            quality: {
                status: 'invalid',
                flags: Array.from(new Set([
                    requestedEntryId ? 'bound_future_quote_unavailable' : 'missing_per_leg_future_binding',
                    ...(entryQuality && Array.isArray(entryQuality.flags) ? entryQuality.flags : []),
                ])),
                requestGeneration: entryQuality && entryQuality.requestGeneration || null,
                activeRequestGeneration: entryQuality && entryQuality.activeRequestGeneration || null,
                quoteAsOf: entryQuality && entryQuality.quoteAsOf || '',
                ageSeconds: entryQuality && entryQuality.ageSeconds !== undefined
                    ? entryQuality.ageSeconds
                    : null,
            },
            usable: false,
        };
    }

    function resolveLegCurrentUnderlyingPrice(globalState, leg, fallbackPrice) {
        const observation = resolveLegForwardObservation(globalState, leg, fallbackPrice);
        if (!observation || observation.usable === false) return null;
        return observation.kind === 'spot'
            ? observation.spotPrice
            : observation.forwardPrice;
    }

    function resolveScenarioShockRatio(globalState, anchorScenarioPrice, fallbackAnchorPrice) {
        const currentAnchorPrice = resolveAnchorUnderlyingPrice(globalState, fallbackAnchorPrice);
        const scenarioAnchor = _toFiniteNumber(anchorScenarioPrice) ?? currentAnchorPrice;

        if (!Number.isFinite(currentAnchorPrice) || currentAnchorPrice <= 0 || !Number.isFinite(scenarioAnchor)) {
            return 1;
        }

        return scenarioAnchor / currentAnchorPrice;
    }

    function resolveLegScenarioUnderlyingPrice(globalState, leg, anchorScenarioPrice, fallbackPrice) {
        const fallback = _toFiniteNumber(fallbackPrice)
            ?? resolveAnchorUnderlyingPrice(globalState, fallbackPrice);
        const scenarioAnchor = _toFiniteNumber(anchorScenarioPrice) ?? fallback;
        const pricingMode = _resolvePricingInputMode(globalState);

        if (pricingMode === 'INDEX') {
            return _resolveIndexLegForwardPrice(globalState, leg, scenarioAnchor);
        }

        if (pricingMode !== 'FOP') {
            return scenarioAnchor;
        }

        const observation = resolveLegForwardObservation(globalState, leg, fallback);
        const currentLegUnderlying = observation && observation.usable !== false
            ? observation.forwardPrice
            : null;
        const shockRatio = resolveScenarioShockRatio(globalState, scenarioAnchor, fallback);

        if (Number.isFinite(currentLegUnderlying) && Number.isFinite(shockRatio)) {
            return currentLegUnderlying * shockRatio;
        }

        // A wrong futures month is materially worse than no projection.  The
        // valuation layer treats this null as an unavailable scenario until
        // the bound contract has a real quote.
        return null;
    }

    function assessProjectionLambdaCoverage(globalState, impliedEntry = null) {
        const profile = _resolveUnderlyingProfile(globalState);
        const marketClock = _resolveMarketClock(globalState);
        const quoteDate = resolveQuoteDate(globalState);
        const target = resolveSimulationTiming(globalState);
        const base = {
            required: false,
            ready: false,
            usable: false,
            status: 'unknown',
            requiredDates: [],
            missingDates: [],
            affectedLegIds: [],
            expectedContractMonths: [],
            targetAsOf: target && target.targetAsOf || null,
        };
        if (globalState && globalState.marketDataMode === 'historical') {
            return { ...base, ready: true, usable: true, status: 'historical_not_applicable' };
        }
        if (!target || !target.available) {
            return { ...base, status: target && target.status || 'simulation_timing_unavailable' };
        }
        if (!dateUtils || typeof dateUtils.resolveWeightedTime !== 'function') {
            return { ...base, status: 'timing_runtime_unavailable' };
        }

        let quoteMs = Date.parse(String(globalState && globalState.liveQuoteAsOf || '').trim());
        if (!Number.isFinite(quoteMs)) {
            const quoteCutoff = dateUtils.resolveExpiryCutoffAsOf(
                { expDate: quoteDate }, profile, quoteDate
            );
            quoteMs = quoteCutoff && quoteCutoff.cutoffMs;
        }
        if (!Number.isFinite(quoteMs)) {
            return { ...base, status: 'quote_timing_unavailable' };
        }

        const requiredDates = new Set();
        const affectedLegIds = new Set();
        const expectedContractMonths = new Set();
        const groups = globalState && Array.isArray(globalState.groups) ? globalState.groups : [];
        for (const group of groups.filter(Boolean)) {
            for (const leg of (Array.isArray(group.legs) ? group.legs : [])) {
                const isOption = productRegistry
                    && typeof productRegistry.isOptionLeg === 'function'
                    ? productRegistry.isOptionLeg(leg)
                    : ['call', 'put'].includes(String(leg && leg.type || '').toLowerCase());
                const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== ''
                    && leg.closePrice !== undefined;
                if (!isOption || hasClosePrice || Math.abs(_toFiniteNumber(leg && leg.pos) || 0) <= 0) {
                    continue;
                }
                const expiry = resolveLegExpiryTiming(globalState, leg);
                if (!expiry.available || expiry.targetMs <= target.targetMs) continue;
                const interval = dateUtils.resolveWeightedTime(
                    quoteMs,
                    expiry.targetMs,
                    0,
                    marketClock.calendarId,
                    null,
                    marketClock.timeZone,
                    marketClock.tradeDateRolloverHour
                );
                if (!interval.available) {
                    return {
                        ...base,
                        status: interval.status || 'calendar_unavailable',
                        affectedLegIds: [String(leg.id || '')],
                    };
                }
                interval.nonTradingDates.forEach(date => requiredDates.add(date));
                if (interval.nonTradingDates.length) affectedLegIds.add(String(leg.id || ''));

                if (_resolvePricingInputMode(globalState) === 'FOP') {
                    const entry = resolveLegFutureEntry(globalState, leg);
                    const month = _normalizeContractMonth(entry && entry.contractMonth);
                    if (month) expectedContractMonths.add(month);
                }
            }
        }

        const required = requiredDates.size > 0;
        const resultBase = {
            ...base,
            required,
            requiredDates: Array.from(requiredDates).sort(),
            affectedLegIds: Array.from(affectedLegIds),
            expectedContractMonths: Array.from(expectedContractMonths).sort(),
        };
        if (!required) {
            return { ...resultBase, ready: true, usable: true, status: 'not_required' };
        }
        if (String(globalState && globalState.simTimeBasis || '').toLowerCase() !== 'weighted') {
            return { ...resultBase, status: 'weighted_basis_required' };
        }
        if (globalState && globalState.simUseImpliedLambda !== true) {
            return { ...resultBase, status: 'implied_lambda_disabled' };
        }
        const acceptedVarianceSource = impliedEntry && (
            impliedEntry.varianceSource === 'straddle'
            || (impliedEntry.varianceSource === 'vendor_iv'
                && impliedEntry.quality
                && impliedEntry.quality.estimationMode === 'best_effort'
                && impliedEntry.quality.sourceQuoteEvidence === 'vendor_atm_iv_fallback')
        );
        if (!impliedEntry || impliedEntry.schemaVersion !== 2
            || !acceptedVarianceSource
            || !impliedEntry.quality || impliedEntry.quality.status !== 'ok'
            || impliedEntry.quality.coherent !== true
            || impliedEntry.quality.quoteComplete !== true) {
            return { ...resultBase, status: 'missing_entry' };
        }

        const expectedSymbol = String(globalState && globalState.underlyingSymbol || '').trim().toUpperCase();
        const entrySymbol = String(impliedEntry.symbol || '').trim().toUpperCase();
        if (entrySymbol !== expectedSymbol || impliedEntry.anchorDate !== quoteDate) {
            return { ...resultBase, status: 'identity_mismatch' };
        }
        if (String(impliedEntry.calendarKey || '').trim().toUpperCase()
            !== marketClock.calendarId) {
            return { ...resultBase, status: 'calendar_mismatch' };
        }
        const entryModel = String(impliedEntry.methodology
            && impliedEntry.methodology.pricingModel || '').trim();
        if (entryModel && profile && entryModel !== profile.pricingModel) {
            return { ...resultBase, status: 'pricing_model_mismatch' };
        }
        if (_resolvePricingInputMode(globalState) === 'FOP') {
            const months = resultBase.expectedContractMonths;
            if (months.length !== 1) {
                return { ...resultBase, status: 'multiple_futures_months' };
            }
            if (_normalizeContractMonth(impliedEntry.underlyingContractMonth) !== months[0]) {
                return { ...resultBase, status: 'futures_month_mismatch' };
            }
        }

        const byDate = impliedEntry.byDate && typeof impliedEntry.byDate === 'object'
            ? impliedEntry.byDate
            : {};
        const missingDates = resultBase.requiredDates.filter(date =>
            !Object.prototype.hasOwnProperty.call(byDate, date)
            || !Number.isFinite(parseFloat(byDate[date]))
        );
        if (missingDates.length) {
            return {
                ...resultBase,
                status: 'incomplete_coverage',
                missingDates,
            };
        }
        return { ...resultBase, ready: true, usable: true, status: 'complete' };
    }

    function buildForwardCarrySnapshot(globalState, options = {}) {
        const policy = _resolveForwardCarryPolicy(globalState);
        const pricingMode = policy.pricingInputMode;
        const quoteDate = resolveQuoteDate(globalState);
        const symbol = String(globalState && globalState.underlyingSymbol || '').trim().toUpperCase();

        if (pricingMode === 'INDEX') {
            const carrySnapshot = indexForwardRate
                && typeof indexForwardRate.buildCarrySnapshot === 'function'
                ? indexForwardRate.buildCarrySnapshot(
                    globalState && globalState.forwardRateSamples,
                    {
                        asOf: quoteDate,
                        quoteAsOf: globalState && globalState.liveQuoteAsOf || '',
                    }
                )
                : null;
            return {
                schemaVersion: 1,
                kind: 'forward_carry_snapshot',
                symbol,
                family: policy.family,
                currency: policy.currency,
                asOf: quoteDate,
                pricingMode,
                pricingForwardSource: policy.forwardSource,
                carrySource: policy.carrySource,
                carrySemantics: policy.carrySemantics,
                discountCurveIndependent: true,
                referenceSpot: _toFiniteNumber(globalState && globalState.underlyingPrice),
                points: carrySnapshot ? carrySnapshot.points : [],
                quality: carrySnapshot
                    ? carrySnapshot.quality
                    : { status: 'unavailable', flags: ['carry_snapshot_api_unavailable'] },
            };
        }

        if (pricingMode !== 'FOP') {
            return {
                schemaVersion: 1,
                kind: 'forward_carry_snapshot',
                symbol,
                family: policy.family,
                currency: policy.currency,
                asOf: quoteDate,
                pricingMode,
                pricingForwardSource: policy.forwardSource,
                carrySource: policy.carrySource,
                carrySemantics: policy.carrySemantics,
                discountCurveIndependent: true,
                points: [],
                quality: { status: 'unavailable', flags: ['no_observed_equity_carry_curve'] },
            };
        }

        const referenceQuote = options && options.referenceQuote
            && typeof options.referenceQuote === 'object'
            ? options.referenceQuote
            : null;
        const referenceSpot = _resolveFutureEntryPrice(referenceQuote);
        const referenceQuoteAsOf = String(referenceQuote && referenceQuote.quoteAsOf || '').trim();
        const referenceCurrency = String(referenceQuote && referenceQuote.currency || '').trim().toUpperCase();
        const referenceSymbol = String(
            referenceQuote && referenceQuote.symbol
            || policy.carryReference && policy.carryReference.symbol
            || ''
        ).trim().toUpperCase();
        const anchorEntry = resolveAnchorFutureEntry(globalState);
        const anchorPrice = _resolveFutureEntryPrice(anchorEntry);
        const rawPoints = _getValidFuturesPoolEntries(globalState).map((entry) => {
            const forwardPrice = _resolveFutureEntryPrice(entry);
            const expiry = _normalizeContractDate(entry.lastTradeDate);
            const futureQuoteAsOf = String(entry.quoteAsOf || entry.lastQuotedAt || '').trim();
            const tenorDays = expiry && quoteDate && dateUtils && typeof dateUtils.diffDays === 'function'
                ? Math.max(0, dateUtils.diffDays(quoteDate, expiry))
                : null;
            const carryQuality = policy.carryReference
                ? _resolveFopCarryQuoteQuality(
                    globalState,
                    futureQuoteAsOf,
                    referenceQuoteAsOf,
                    {
                        hasExactExpiry: !!expiry && tenorDays > 0,
                        hasFuturePrice: forwardPrice > 0,
                        hasReferencePrice: referenceSpot > 0,
                        currencyMatches: !!referenceCurrency
                            && referenceCurrency === String(policy.currency || '').trim().toUpperCase(),
                    }
                )
                : null;
            const carryRate = carryQuality && carryQuality.usable
                && referenceSpot > 0 && forwardPrice > 0 && tenorDays > 0
                ? Math.log(forwardPrice / referenceSpot) / (tenorDays / 365)
                : null;
            return {
                futuresPoolEntryId: String(entry.id || '').trim(),
                family: policy.family,
                currency: String(entry.currency || policy.currency || '').trim().toUpperCase(),
                symbol: String(entry.symbol || symbol || '').trim().toUpperCase(),
                localSymbol: String(entry.localSymbol || '').trim(),
                exchange: String(entry.exchange || '').trim(),
                conId: Number.isFinite(parseInt(entry.conId, 10)) ? parseInt(entry.conId, 10) : null,
                contractMonth: _normalizeContractMonth(entry.contractMonth),
                expiry,
                tenorDays,
                forwardPrice,
                quoteAsOf: futureQuoteAsOf,
                source: 'exchange_futures_quote',
                relativeLogPriceToAnchor: anchorPrice > 0 && forwardPrice > 0
                    ? Math.log(forwardPrice / anchorPrice)
                    : null,
                intervalStartContractMonth: null,
                intervalDays: null,
                intervalLogForwardChange: null,
                intervalLogSlope: null,
                annualizedRollSlope: null,
                intervalQuality: null,
                carryRate,
                carryRateSource: Number.isFinite(carryRate)
                    ? `futures_quote_vs_${referenceSymbol || 'reference_spot'}`
                    : null,
                carryQuality,
                quality: {
                    status: forwardPrice > 0 ? 'good' : 'unavailable',
                    flags: forwardPrice > 0 ? [] : ['future_quote_unavailable'],
                },
            };
        });
        const points = rawPoints.map((point, index) => {
            if (index === 0) return point;
            const previous = rawPoints[index - 1];
            const intervalDays = previous.expiry && point.expiry
                && dateUtils && typeof dateUtils.diffDays === 'function'
                ? dateUtils.diffDays(previous.expiry, point.expiry)
                : null;
            const intervalQuality = _resolveFuturesIntervalQuality(
                globalState,
                previous,
                point,
                intervalDays
            );
            const intervalLogForwardChange = intervalQuality.usable
                ? Math.log(point.forwardPrice / previous.forwardPrice)
                : null;
            return {
                ...point,
                intervalStartContractMonth: previous.contractMonth || null,
                intervalDays: intervalDays > 0 ? intervalDays : null,
                intervalLogForwardChange,
                intervalLogSlope: Number.isFinite(intervalLogForwardChange) && intervalDays > 0
                    ? intervalLogForwardChange / intervalDays
                    : null,
                annualizedRollSlope: Number.isFinite(intervalLogForwardChange) && intervalDays > 0
                    ? intervalLogForwardChange / (intervalDays / 365)
                    : null,
                intervalQuality,
            };
        });
        return {
            schemaVersion: 1,
            kind: 'forward_carry_snapshot',
            symbol,
            family: policy.family,
            currency: policy.currency,
            asOf: quoteDate,
            quoteAsOf: String(globalState && globalState.liveQuoteAsOf || '').trim(),
            pricingMode,
            pricingForwardSource: policy.forwardSource,
            carrySource: policy.carrySource,
            carrySemantics: policy.carrySemantics,
            discountCurveIndependent: true,
            reference: policy.carryReference
                ? {
                    ...policy.carryReference,
                    price: referenceSpot,
                    quoteAsOf: referenceQuoteAsOf,
                    source: 'live_reference_quote',
                }
                : null,
            points,
            quality: {
                status: points.some(point => point.forwardPrice > 0)
                    ? (points.some(point =>
                        (point.carryQuality && point.carryQuality.usable === false)
                        || (point.intervalQuality && point.intervalQuality.usable === false)
                    )
                        ? 'degraded'
                        : 'good')
                    : 'unavailable',
                flags: Array.from(new Set(points.flatMap(point =>
                    (point.carryQuality && Array.isArray(point.carryQuality.flags)
                        ? point.carryQuality.flags
                        : []).concat(
                        point.intervalQuality && Array.isArray(point.intervalQuality.flags)
                            ? point.intervalQuality.flags
                            : []
                    )
                ).concat(
                    points.length === 0 ? ['futures_curve_unavailable'] : [],
                    policy.carryReference && !(referenceSpot > 0)
                        ? ['carry_reference_quote_unavailable']
                        : []
                ))),
            },
        };
    }

    globalScope.OptionComboPricingContext = {
        resolveAnchorDisplayInfo,
        resolveAnchorFutureEntry,
        resolveAnchorUnderlyingPrice,
        resolveLiveQuoteDate,
        resolveQuoteDate,
        resolveSimulationDate,
        resolveSimulationTiming,
        resolveLegExpiryTiming,
        resolveLegTimeToExpiryDays,
        resolveObservableLegPrice,
        resolveLegFutureEntry,
        resolveLegForwardObservation,
        resolveLegDiscountObservation,
        resolveLegInterestRate,
        resolveLegQuotePricingInputs,
        summarizeDiscountFallback,
        resolveLegCurrentUnderlyingPrice,
        resolveScenarioShockRatio,
        resolveLegScenarioUnderlyingPrice,
        assessProjectionLambdaCoverage,
        buildForwardCarrySnapshot,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
