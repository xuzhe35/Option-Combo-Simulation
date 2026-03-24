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

        return _normalizeDateValue(globalState.baseDate)
            || _normalizeDateValue(globalState.simulatedDate);
    }

    function resolveSimulationDate(globalState) {
        if (!globalState || typeof globalState !== 'object') {
            return '';
        }

        const quoteDate = resolveQuoteDate(globalState);
        const requestedDate = _normalizeDateValue(globalState.simulatedDate) || quoteDate;
        if (globalState.marketDataMode === 'historical' && quoteDate && requestedDate && requestedDate < quoteDate) {
            return quoteDate;
        }
        return requestedDate || quoteDate;
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
        return _toFiniteNumber(entry.mark)
            ?? _toFiniteNumber(entry.ask)
            ?? _toFiniteNumber(entry.bid);
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
        if (!dateUtils || typeof dateUtils.diffDays !== 'function' || !leg || !leg.expDate) {
            return 0;
        }
        return Math.max(0, dateUtils.diffDays(
            resolveSimulationDate(globalState),
            leg.expDate
        ));
    }

    function _resolveIndexLegForwardPrice(globalState, leg, spotPrice) {
        if (!indexForwardRate
            || typeof indexForwardRate.resolveDailyCarryForTarget !== 'function'
            || typeof indexForwardRate.resolveForwardPriceFromSpot !== 'function'
            || _isUnderlyingLeg(leg)) {
            return spotPrice;
        }

        const daysToExpiry = _resolveIndexLegDaysToExpiry(globalState, leg);
        const dailyCarry = indexForwardRate.resolveDailyCarryForTarget(
            globalState && globalState.forwardRateSamples,
            {
                expDate: leg && leg.expDate,
                daysToExpiry,
            }
        );

        if (!Number.isFinite(dailyCarry)) {
            return spotPrice;
        }

        return indexForwardRate.resolveForwardPriceFromSpot(spotPrice, dailyCarry, daysToExpiry);
    }

    function resolveLegInterestRate(globalState, leg, fallbackRate) {
        const fallback = _toFiniteNumber(fallbackRate)
            ?? _toFiniteNumber(globalState && globalState.interestRate)
            ?? 0;
        const pricingMode = _resolvePricingInputMode(globalState);

        if (pricingMode !== 'INDEX' || _isUnderlyingLeg(leg)) {
            return fallback;
        }

        if (!indexForwardRate || typeof indexForwardRate.resolveDailyCarryForTarget !== 'function') {
            return fallback;
        }

        const daysToExpiry = _resolveIndexLegDaysToExpiry(globalState, leg);
        const dailyCarry = indexForwardRate.resolveDailyCarryForTarget(
            globalState && globalState.forwardRateSamples,
            {
                expDate: leg && leg.expDate,
                daysToExpiry,
            }
        );

        if (!Number.isFinite(dailyCarry)) {
            return fallback;
        }

        return dailyCarry * 365;
    }

    function resolveLegFutureEntry(globalState, leg) {
        if (!leg || !leg.underlyingFutureId) {
            return null;
        }

        return (globalState && Array.isArray(globalState.futuresPool) ? globalState.futuresPool : [])
            .find(entry => entry && entry.id === leg.underlyingFutureId) || null;
    }

    function resolveLegCurrentUnderlyingPrice(globalState, leg, fallbackPrice) {
        const fallback = _toFiniteNumber(fallbackPrice)
            ?? resolveAnchorUnderlyingPrice(globalState, fallbackPrice);
        const pricingMode = _resolvePricingInputMode(globalState);

        if (pricingMode === 'INDEX') {
            return _resolveIndexLegForwardPrice(globalState, leg, fallback);
        }

        if (pricingMode !== 'FOP') {
            return fallback;
        }

        return _resolveFutureEntryPrice(resolveLegFutureEntry(globalState, leg)) ?? fallback;
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

        const currentLegUnderlying = resolveLegCurrentUnderlyingPrice(globalState, leg, fallback);
        const shockRatio = resolveScenarioShockRatio(globalState, scenarioAnchor, fallback);

        if (Number.isFinite(currentLegUnderlying) && Number.isFinite(shockRatio)) {
            return currentLegUnderlying * shockRatio;
        }

        return scenarioAnchor;
    }

    globalScope.OptionComboPricingContext = {
        resolveAnchorDisplayInfo,
        resolveAnchorFutureEntry,
        resolveAnchorUnderlyingPrice,
        resolveQuoteDate,
        resolveSimulationDate,
        resolveLegFutureEntry,
        resolveLegInterestRate,
        resolveLegCurrentUnderlyingPrice,
        resolveScenarioShockRatio,
        resolveLegScenarioUnderlyingPrice,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
