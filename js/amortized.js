/**
 * Pure amortized-cost helpers.
 */

(function attachAmortized(globalScope) {
    const pricingCore = globalScope.OptionComboPricingCore;
    const productRegistry = globalScope.OptionComboProductRegistry;
    const pricingContext = globalScope.OptionComboPricingContext;
    if (!pricingCore) {
        throw new Error('OptionComboPricingCore must be loaded before amortized.js');
    }

    const {
        processLegData,
        computeSimulatedPrice,
        resolveInstrumentProfile,
        isUnderlyingLeg,
    } = pricingCore;

    function buildUnsupportedResult(profile, reason) {
        return {
            isSupported: false,
            reason,
            netShares: 0,
            netDeliverables: 0,
            basis: 0,
            nocf: 0,
            totalCash: 0,
            residualValue: 0,
            assignmentCash: 0,
            initialCost: 0,
            deliverableUnitSingular: profile?.deliverableUnitSingular || 'share',
            deliverableUnitPlural: profile?.deliverableUnitPlural || 'shares',
            positiveActionLabel: profile?.settlementActionPositive || 'Assigned',
            negativeActionLabel: profile?.settlementActionNegative || 'Delivered',
        };
    }

    function calculateAmortizedCost(group, evalUnderlyingPrice, globalState) {
        const profile = resolveInstrumentProfile(globalState.underlyingSymbol)
            || (productRegistry ? productRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol) : null);

        if (profile && profile.supportsAmortizedMode === false) {
            return buildUnsupportedResult(
                profile,
                'Amortized mode is only available for equity-style deliverable underlyings in the current framework.'
            );
        }

        let netShares = 0;
        let initialCashOutflow = 0;
        let residualValue = 0;
        let assignmentCash = 0;
        const simulationDate = pricingContext && typeof pricingContext.resolveSimulationDate === 'function'
            ? pricingContext.resolveSimulationDate(globalState)
            : globalState.simulatedDate;
        const quoteDate = pricingContext && typeof pricingContext.resolveQuoteDate === 'function'
            ? pricingContext.resolveQuoteDate(globalState)
            : globalState.baseDate;

        group.legs.forEach(leg => {
            const legInterestRate = pricingContext && typeof pricingContext.resolveLegInterestRate === 'function'
                ? pricingContext.resolveLegInterestRate(globalState, leg, globalState.interestRate)
                : globalState.interestRate;
            const pLeg = processLegData(
                leg,
                simulationDate,
                globalState.ivOffset,
                quoteDate,
                evalUnderlyingPrice,
                legInterestRate,
                group.viewMode || 'active',
                profile,
                globalState.marketDataMode
            );
            initialCashOutflow += pLeg.costBasis;
            if (isUnderlyingLeg(leg)) {
                netShares += leg.pos;
            }
        });

        let currentCash = -initialCashOutflow;

        group.legs.forEach(leg => {
            if (isUnderlyingLeg(leg)) return;

            const pos = leg.pos;
            const activeViewMode = leg._viewMode || group.viewMode || 'active';
            const legUnderlyingPrice = pricingContext
                ? pricingContext.resolveLegScenarioUnderlyingPrice(
                    globalState,
                    leg,
                    evalUnderlyingPrice,
                    globalState.underlyingPrice
                )
                : evalUnderlyingPrice;
            const legInterestRate = pricingContext && typeof pricingContext.resolveLegInterestRate === 'function'
                ? pricingContext.resolveLegInterestRate(globalState, leg, globalState.interestRate)
                : globalState.interestRate;

            const pLeg = processLegData(
                leg,
                simulationDate,
                globalState.ivOffset,
                quoteDate,
                legUnderlyingPrice,
                legInterestRate,
                activeViewMode,
                profile,
                globalState.marketDataMode
            );
            const contractMultiplier = pLeg.contractMultiplier || 100;
            const settlementUnitsPerContract = pLeg.settlementUnitsPerContract || 100;

            if (leg.closePrice !== null && leg.closePrice !== '') {
                currentCash += parseFloat(leg.closePrice) * pos * contractMultiplier;
                return;
            }

            const simPricePerShare = computeSimulatedPrice(
                pLeg,
                leg,
                legUnderlyingPrice,
                legInterestRate,
                activeViewMode,
                simulationDate,
                quoteDate,
                globalState.ivOffset
            );

            if (!pLeg.isExpired) {
                const value = simPricePerShare * pos * contractMultiplier;
                currentCash += value;
                residualValue += value;
            } else if (simPricePerShare > 0) {
                let assignmentShares = 0;
                if (leg.type.toLowerCase() === 'call') assignmentShares = pos * settlementUnitsPerContract;
                else if (leg.type.toLowerCase() === 'put') assignmentShares = -pos * settlementUnitsPerContract;

                netShares += assignmentShares;
                const flow = -assignmentShares * leg.strike;
                currentCash += flow;
                assignmentCash += flow;
            }
        });

        let basis = 0;
        if (netShares !== 0) {
            if (netShares > 0) {
                basis = (-currentCash) / netShares;
            } else {
                basis = currentCash / Math.abs(netShares);
            }
        }

        return {
            isSupported: true,
            netShares,
            netDeliverables: netShares,
            basis,
            nocf: currentCash,
            totalCash: currentCash,
            residualValue,
            assignmentCash,
            initialCost: initialCashOutflow,
            deliverableUnitSingular: profile?.deliverableUnitSingular || 'share',
            deliverableUnitPlural: profile?.deliverableUnitPlural || 'shares',
            positiveActionLabel: profile?.settlementActionPositive || 'Assigned',
            negativeActionLabel: profile?.settlementActionNegative || 'Delivered',
        };
    }

    function calculateCombinedAmortizedCost(groups, globalState) {
        const profile = resolveInstrumentProfile(globalState.underlyingSymbol)
            || (productRegistry ? productRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol) : null);

        if (profile && profile.supportsAmortizedMode === false) {
            return buildUnsupportedResult(
                profile,
                'Amortized mode is only available for equity-style deliverable underlyings in the current framework.'
            );
        }

        let netShares = 0;
        let totalCash = 0;
        let residualValue = 0;
        let assignmentCash = 0;
        let initialCost = 0;

        groups.forEach(group => {
            const liveAnchorUnderlyingPrice = pricingContext
                ? pricingContext.resolveAnchorUnderlyingPrice(globalState, globalState.underlyingPrice)
                : globalState.underlyingPrice;
            const evalUnderlyingPrice = (group.settleUnderlyingPrice !== null && group.settleUnderlyingPrice !== undefined)
                ? group.settleUnderlyingPrice
                : liveAnchorUnderlyingPrice;
            const result = calculateAmortizedCost(group, evalUnderlyingPrice, globalState);
            netShares += result.netShares;
            totalCash += result.totalCash;
            residualValue += result.residualValue;
            assignmentCash += result.assignmentCash;
            initialCost += result.initialCost;
        });

        let basis = 0;
        if (netShares > 0) {
            basis = (-totalCash) / netShares;
        } else if (netShares < 0) {
            basis = totalCash / Math.abs(netShares);
        }

        return {
            isSupported: true,
            netShares,
            netDeliverables: netShares,
            basis,
            totalCash,
            residualValue,
            assignmentCash,
            initialCost,
            deliverableUnitSingular: profile?.deliverableUnitSingular || 'share',
            deliverableUnitPlural: profile?.deliverableUnitPlural || 'shares',
            positiveActionLabel: profile?.settlementActionPositive || 'Assigned',
            negativeActionLabel: profile?.settlementActionNegative || 'Delivered',
        };
    }

    const api = {
        calculateAmortizedCost,
        calculateCombinedAmortizedCost,
    };

    globalScope.OptionComboAmortized = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
