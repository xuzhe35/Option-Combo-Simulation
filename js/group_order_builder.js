/**
 * Generic group-order request builders shared by trigger/open/close flows.
 */

(function attachGroupOrderBuilder(globalScope) {
    const VALID_EXECUTION_INTENTS = ['open', 'close'];

    function _resolveUnderlyingProfile(globalState) {
        if (typeof OptionComboProductRegistry === 'undefined'
            || typeof OptionComboProductRegistry.resolveUnderlyingProfile !== 'function') {
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

        return OptionComboProductRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol);
    }

    function _isUnderlyingLeg(leg) {
        return OptionComboProductRegistry.isUnderlyingLeg(leg);
    }

    function _resolveDefaultUnderlyingContractMonth(globalState) {
        if (globalState.underlyingContractMonth) {
            return globalState.underlyingContractMonth;
        }

        if (typeof OptionComboProductRegistry === 'undefined'
            || typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth !== 'function') {
            return '';
        }

        return OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
            globalState.underlyingSymbol,
            globalState.simulatedDate || globalState.baseDate
        );
    }

    function _resolveExecutionIntent(intent) {
        const normalized = String(intent || 'open').trim().toLowerCase();
        return VALID_EXECUTION_INTENTS.includes(normalized) ? normalized : 'open';
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

    function _shouldIncludeLegForIntent(leg, intent) {
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

        return (group.legs || [])
            .filter((leg) => _shouldIncludeLegForIntent(leg, intent))
            .map((leg) => {
                const targetPos = _resolveTargetPosition(leg.pos, intent);
                const optionContractSpec = typeof OptionComboProductRegistry !== 'undefined'
                    && typeof OptionComboProductRegistry.resolveOptionContractSpec === 'function'
                    ? OptionComboProductRegistry.resolveOptionContractSpec(globalState.underlyingSymbol, leg.expDate)
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

                    return request;
                }

                return {
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
                    underlyingContractMonth: defaultUnderlyingContractMonth,
                };
            });
    }

    function buildGroupOrderRequestPayload(group, globalState, options) {
        const requestOptions = options && typeof options === 'object' ? options : {};
        const intent = _resolveExecutionIntent(requestOptions.intent);
        const executionMode = String(requestOptions.executionMode || 'preview').trim();
        const requestAction = String(
            requestOptions.action || (executionMode === 'preview' ? 'preview_combo_order' : 'submit_combo_order')
        ).trim();
        const profile = _resolveUnderlyingProfile(globalState);

        return {
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
            profile: {
                family: profile.family,
                optionSymbol: profile.optionSymbol,
                underlyingSymbol: profile.underlyingSymbol,
                optionExchange: profile.optionExchange,
                underlyingExchange: profile.underlyingExchange,
                currency: profile.currency,
            },
            legs: buildGroupOrderLegRequests(group, globalState, { intent }),
        };
    }

    globalScope.OptionComboGroupOrderBuilder = {
        VALID_EXECUTION_INTENTS,
        buildGroupOrderLegRequests,
        buildGroupOrderRequestPayload,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
