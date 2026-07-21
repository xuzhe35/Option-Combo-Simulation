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
        assessProjectionConvergence,
        formatProjectionConvergenceFailure,
        formatProjectionTimingFailure,
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
        const simulationTiming = pricingContext
            && typeof pricingContext.resolveSimulationTiming === 'function'
            ? pricingContext.resolveSimulationTiming(globalState)
            : (globalState && globalState.simulationTiming || null);
        if (simulationTiming && simulationTiming.available === false) {
            return buildUnsupportedResult(
                profile,
                `Amortized projection timing unavailable (${simulationTiming.status}).`
            );
        }
        const timingForLeg = (leg) => {
            const observable = pricingContext
                && typeof pricingContext.resolveObservableLegPrice === 'function'
                ? pricingContext.resolveObservableLegPrice(globalState, group, leg)
                : null;
            const quotePricingInputs = pricingContext
                && typeof pricingContext.resolveLegQuotePricingInputs === 'function'
                ? pricingContext.resolveLegQuotePricingInputs(globalState, leg, {
                    underlyingPrice: globalState.underlyingPrice,
                    interestRate: globalState.interestRate,
                })
                : null;
            return {
                quoteAsOf: globalState.liveQuoteAsOf,
                allowLegacyQuoteCutoff: !globalState.marketDataMode,
                targetAsOf: simulationTiming && simulationTiming.available
                    ? simulationTiming.targetAsOf
                    : null,
                targetSource: simulationTiming && simulationTiming.source || null,
                timingStatus: simulationTiming && simulationTiming.status || null,
                observablePrice: observable && observable.available ? observable.price : null,
                observablePriceSource: observable && observable.source || null,
                observablePriceAsOf: observable && observable.quoteAsOf || null,
                observablePriceFresh: observable && observable.fresh === true,
                quotePricingInputsAvailable: quotePricingInputs && quotePricingInputs.available === true,
                quotePricingInputStatus: quotePricingInputs && quotePricingInputs.status || null,
                quoteUnderlyingPrice: quotePricingInputs && quotePricingInputs.underlyingPrice,
                quoteUnderlyingAsOf: quotePricingInputs && quotePricingInputs.underlyingAsOf,
                quoteInterestRate: quotePricingInputs && quotePricingInputs.interestRate,
            };
        };

        group.legs.forEach(leg => {
            const legInterestRate = pricingContext && typeof pricingContext.resolveLegInterestRate === 'function'
                ? pricingContext.resolveLegInterestRate(globalState, leg, globalState.interestRate)
                : globalState.interestRate;
            const legTiming = timingForLeg(leg);
            const pLeg = processLegData(
                leg,
                simulationDate,
                globalState.ivOffset,
                quoteDate,
                evalUnderlyingPrice,
                legInterestRate,
                group.viewMode || 'active',
                profile,
                globalState.marketDataMode,
                legTiming
            );
            initialCashOutflow += pLeg.costBasis;
            if (isUnderlyingLeg(leg)) {
                netShares += leg.pos;
            }
        });

        let currentCash = -initialCashOutflow;
        currentCash += group.legs.reduce((sum, leg) => {
            const realized = parseFloat(leg && leg.partialCloseRealizedPnl);
            return sum + (Number.isFinite(realized) ? realized : 0);
        }, 0);

        for (const leg of group.legs) {
            if (isUnderlyingLeg(leg)) continue;

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

            const legTiming = timingForLeg(leg);
            const pLeg = processLegData(
                leg,
                simulationDate,
                globalState.ivOffset,
                quoteDate,
                legUnderlyingPrice,
                legInterestRate,
                activeViewMode,
                profile,
                globalState.marketDataMode,
                legTiming
            );
            const contractMultiplier = pLeg.contractMultiplier || 100;
            const settlementUnitsPerContract = pLeg.settlementUnitsPerContract || 100;

            if (leg.closePrice !== null && leg.closePrice !== '') {
                currentCash += parseFloat(leg.closePrice) * pos * contractMultiplier;
                continue;
            }

            if (pLeg.timingStatus === 'implied_lambda_incomplete') {
                return buildUnsupportedResult(
                    profile,
                    typeof formatProjectionTimingFailure === 'function'
                        ? formatProjectionTimingFailure(
                            pLeg.timingStatus,
                            'Amortized projection',
                            pLeg
                        )
                        : 'Amortized projection unavailable: required weekend/holiday implied λ data is missing.'
                );
            }
            const convergence = typeof assessProjectionConvergence === 'function'
                ? assessProjectionConvergence(globalState, [leg], [pLeg])
                : { ready: true };
            if (convergence.ready === false) {
                return buildUnsupportedResult(
                    profile,
                    typeof formatProjectionConvergenceFailure === 'function'
                        ? formatProjectionConvergenceFailure(
                            convergence,
                            'Amortized projection'
                        )
                        : 'Amortized projection unavailable: strict live BBO convergence inputs are missing.'
                );
            }

            if (!Number.isFinite(legUnderlyingPrice) || legUnderlyingPrice <= 0) {
                return buildUnsupportedResult(
                    profile,
                    'Amortized projection unavailable because the pricing underlying quote is missing.'
                );
            }

            const simPricePerShare = computeSimulatedPrice(
                pLeg,
                leg,
                legUnderlyingPrice,
                legInterestRate,
                activeViewMode,
                simulationDate,
                quoteDate,
                globalState.ivOffset,
                legTiming
            );
            if (!Number.isFinite(simPricePerShare)) {
                return buildUnsupportedResult(
                    profile,
                    'Amortized projection unavailable because a pricing input is missing.'
                );
            }

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
        }

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

        for (const group of groups) {
            const liveAnchorUnderlyingPrice = pricingContext
                ? pricingContext.resolveAnchorUnderlyingPrice(globalState, globalState.underlyingPrice)
                : globalState.underlyingPrice;
            const evalUnderlyingPrice = (group.settleUnderlyingPrice !== null && group.settleUnderlyingPrice !== undefined)
                ? group.settleUnderlyingPrice
                : liveAnchorUnderlyingPrice;
            const result = calculateAmortizedCost(group, evalUnderlyingPrice, globalState);
            if (!result.isSupported) return result;
            netShares += result.netShares;
            totalCash += result.totalCash;
            residualValue += result.residualValue;
            assignmentCash += result.assignmentCash;
            initialCost += result.initialCost;
        }

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
