/**
 * Generic group-order request builders shared by trigger/open/close flows.
 */

(function attachGroupOrderBuilder(globalScope) {
    const VALID_EXECUTION_INTENTS = ['open', 'close'];

    /**
     * @typedef {Object} OptionComboGroupOrderLegRequest
     * @property {string} id
     * @property {string} type
     * @property {number} pos
     * @property {string} secType
     * @property {string} symbol
     */

    /**
     * @typedef {Object} OptionComboGroupOrderRequestPayload
     * @property {string} action
     * @property {string} groupId
     * @property {string} executionMode
     * @property {string} executionIntent
     * @property {string} requestSource
     * @property {OptionComboGroupOrderLegRequest[]} legs
     */

    function _getProductRegistryApi() {
        return globalScope.OptionComboProductRegistry && typeof globalScope.OptionComboProductRegistry === 'object'
            ? globalScope.OptionComboProductRegistry
            : null;
    }

    function _resolveUnderlyingProfile(globalState) {
        const productRegistry = _getProductRegistryApi();
        if (!productRegistry || typeof productRegistry.resolveUnderlyingProfile !== 'function') {
            return {
                family: 'DEFAULT_EQUITY',
                optionSecType: 'OPT',
                underlyingSecType: 'STK',
                optionSymbol: globalState.underlyingSymbol,
                underlyingSymbol: globalState.underlyingSymbol,
                optionExchange: 'SMART',
                underlyingExchange: 'SMART',
                currency: 'USD',
                optionMultiplier: 100,
            };
        }

        return productRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol);
    }

    function _isUnderlyingLeg(leg) {
        const productRegistry = _getProductRegistryApi();
        if (productRegistry && typeof productRegistry.isUnderlyingLeg === 'function') {
            return productRegistry.isUnderlyingLeg(leg);
        }
        const legType = String(leg && leg.type || '').trim().toLowerCase();
        return legType === 'stock' || legType === 'future';
    }

    function _resolveDefaultUnderlyingContractMonth(globalState) {
        if (globalState.underlyingContractMonth) {
            return globalState.underlyingContractMonth;
        }

        const productRegistry = _getProductRegistryApi();
        if (!productRegistry || typeof productRegistry.resolveDefaultUnderlyingContractMonth !== 'function') {
            return '';
        }

        return productRegistry.resolveDefaultUnderlyingContractMonth(
            globalState.underlyingSymbol,
            globalState.simulatedDate || globalState.baseDate
        );
    }

    function _resolveFuturesPoolEntry(globalState, entryId) {
        if (!entryId || !Array.isArray(globalState && globalState.futuresPool)) {
            return null;
        }

        return globalState.futuresPool.find((entry) => entry && entry.id === entryId) || null;
    }

    function _resolveLegUnderlyingContractMonth(leg, globalState, fallbackContractMonth) {
        const selectedFuture = _resolveFuturesPoolEntry(globalState, leg && leg.underlyingFutureId);
        return String(
            selectedFuture?.contractMonth
            || fallbackContractMonth
            || ''
        ).trim();
    }

    function _resolveExecutionIntent(intent) {
        const normalized = String(intent || 'open').trim().toLowerCase();
        return VALID_EXECUTION_INTENTS.includes(normalized) ? normalized : 'open';
    }

    function _resolveSelectedTradeAccount(globalState) {
        return String(globalState && globalState.selectedLiveComboOrderAccount || '').trim();
    }

    function _toPositiveFiniteNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function _resolveObservedQuoteForLeg(leg) {
        const liveQuotes = globalScope.OptionComboWsLiveQuotes;
        if (!liveQuotes || !leg) {
            return null;
        }
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

    function _appendObservedQuote(request, quote) {
        if (!request || !quote) {
            return request;
        }
        const bid = _toPositiveFiniteNumber(quote.bid);
        const ask = _toPositiveFiniteNumber(quote.ask);
        const mark = _toPositiveFiniteNumber(quote.mark);
        if (bid !== null) request.observedBid = bid;
        if (ask !== null) request.observedAsk = ask;
        if (mark !== null) request.observedMark = mark;
        return request;
    }

    function _resolveObservedUnderlyingPrice(globalState) {
        const liveQuotes = globalScope.OptionComboWsLiveQuotes;
        const quote = liveQuotes && typeof liveQuotes.getUnderlyingQuote === 'function'
            ? liveQuotes.getUnderlyingQuote()
            : null;
        const bid = _toPositiveFiniteNumber(quote && quote.bid);
        const ask = _toPositiveFiniteNumber(quote && quote.ask);
        const mark = _toPositiveFiniteNumber(quote && quote.mark);
        if (bid !== null && ask !== null) {
            return (bid + ask) / 2;
        }
        return mark !== null ? mark : _toPositiveFiniteNumber(globalState && globalState.underlyingPrice);
    }

    function _resolveTargetPosition(pos, intent) {
        const numericPos = parseInt(pos, 10) || 0;
        return intent === 'close' ? numericPos * -1 : numericPos;
    }

    function _hasResolvedClosePrice(leg) {
        return !!(leg
            && leg.closePrice !== null
            && leg.closePrice !== ''
            && leg.closePrice !== undefined);
    }

    function _normalizeLegIdFilter(options) {
        if (!options || !Array.isArray(options.legIds)) {
            return null;
        }

        const legIds = options.legIds
            .map((id) => String(id || '').trim())
            .filter(Boolean);
        return legIds.length > 0 ? new Set(legIds) : null;
    }

    function _shouldIncludeLegForIntent(leg, intent, legIdFilter) {
        if (legIdFilter && !legIdFilter.has(String(leg && leg.id || '').trim())) {
            return false;
        }

        const pos = parseInt(leg && leg.pos, 10) || 0;
        if (pos === 0) {
            return false;
        }

        if (intent === 'close' && _hasResolvedClosePrice(leg)) {
            return false;
        }

        return true;
    }

    function buildGroupOrderLegRequests(group, globalState, options) {
        const profile = _resolveUnderlyingProfile(globalState);
        const defaultUnderlyingContractMonth = _resolveDefaultUnderlyingContractMonth(globalState);
        const intent = _resolveExecutionIntent(options && options.intent);
        const legIdFilter = _normalizeLegIdFilter(options);
        const productRegistry = _getProductRegistryApi();

        return (group.legs || [])
            .filter((leg) => _shouldIncludeLegForIntent(leg, intent, legIdFilter))
            .map((leg) => {
                const targetPos = _resolveTargetPosition(leg.pos, intent);
                const optionContractSpec = productRegistry
                    && typeof productRegistry.resolveOptionContractSpec === 'function'
                    ? productRegistry.resolveOptionContractSpec(globalState.underlyingSymbol, leg.expDate)
                    : null;

                if (_isUnderlyingLeg(leg)) {
                    const request = {
                        id: leg.id,
                        type: leg.type,
                        pos: targetPos,
                        secType: profile.underlyingSecType || 'STK',
                        symbol: profile.underlyingSymbol || globalState.underlyingSymbol,
                        exchange: profile.underlyingExchange || 'SMART',
                        currency: profile.currency || 'USD',
                    };

                    if (request.secType === 'FUT') {
                        request.contractMonth = defaultUnderlyingContractMonth;
                        request.multiplier = String(profile.underlyingLegMultiplier || profile.optionMultiplier || '');
                    }

                    return _appendObservedQuote(request, _resolveObservedQuoteForLeg(leg));
                }

                const underlyingContractMonth = _resolveLegUnderlyingContractMonth(
                    leg,
                    globalState,
                    defaultUnderlyingContractMonth
                );

                const request = {
                    id: leg.id,
                    type: leg.type,
                    pos: targetPos,
                    secType: profile.optionSecType || 'OPT',
                    symbol: optionContractSpec?.symbol || profile.optionSymbol || globalState.underlyingSymbol,
                    underlyingSymbol: profile.underlyingSymbol || globalState.underlyingSymbol,
                    exchange: profile.optionExchange || 'SMART',
                    underlyingExchange: profile.underlyingExchange || profile.optionExchange || 'SMART',
                    currency: profile.currency || 'USD',
                    multiplier: String(profile.optionMultiplier || 100),
                    underlyingMultiplier: String(profile.optionMultiplier || 100),
                    tradingClass: optionContractSpec?.tradingClass
                        || (profile.tradingClass || undefined),
                    right: leg.type.charAt(0).toUpperCase(),
                    strike: leg.strike,
                    expDate: String(leg.expDate || '').replace(/-/g, ''),
                    contractMonth: String(leg.expDate || '').replace(/-/g, '').slice(0, 6),
                    underlyingContractMonth,
                };
                return _appendObservedQuote(request, _resolveObservedQuoteForLeg(leg));
            });
    }

    /** @returns {OptionComboGroupOrderRequestPayload} */
    function buildGroupOrderRequestPayload(group, globalState, options) {
        const requestOptions = options && typeof options === 'object' ? options : {};
        const intent = _resolveExecutionIntent(requestOptions.intent);
        const executionMode = String(requestOptions.executionMode || 'preview').trim();
        const requestAction = String(
            requestOptions.action || (executionMode === 'preview' ? 'preview_combo_order' : 'submit_combo_order')
        ).trim();
        const profile = _resolveUnderlyingProfile(globalState);

        const payload = {
            action: requestAction,
            groupId: group.id,
            groupName: group.name || 'Group Combo',
            underlyingSymbol: globalState.underlyingSymbol,
            underlyingContractMonth: _resolveDefaultUnderlyingContractMonth(globalState),
            executionMode,
            executionIntent: intent,
            requestSource: String(requestOptions.source || 'manual'),
            managedRepriceThreshold: requestOptions.managedRepriceThreshold,
            managedConcessionRatio: requestOptions.managedConcessionRatio,
            timeInForce: requestOptions.timeInForce || 'DAY',
            closeStrategy: String(requestOptions.closeStrategy || 'auto').trim().toLowerCase(),
            equivalentCloseMaxOtmAsk: 0.02,
            profile: {
                family: profile.family,
                optionSecType: profile.optionSecType,
                underlyingSecType: profile.underlyingSecType,
                optionSymbol: profile.optionSymbol,
                underlyingSymbol: profile.underlyingSymbol,
                optionExchange: profile.optionExchange,
                underlyingExchange: profile.underlyingExchange,
                currency: profile.currency,
                priceIncrement: profile.comboPriceIncrement,
            },
            legs: buildGroupOrderLegRequests(group, globalState, {
                intent,
                legIds: requestOptions.legIds,
            }),
        };

        const observedUnderlyingPrice = _resolveObservedUnderlyingPrice(globalState);
        if (observedUnderlyingPrice !== null) {
            payload.observedUnderlyingPrice = observedUnderlyingPrice;
        }

        const selectedAccount = _resolveSelectedTradeAccount(globalState);
        if (selectedAccount) {
            payload.account = selectedAccount;
        }

        return payload;
    }

    globalScope.OptionComboGroupOrderBuilder = {
        VALID_EXECUTION_INTENTS,
        buildGroupOrderLegRequests,
        buildGroupOrderRequestPayload,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
