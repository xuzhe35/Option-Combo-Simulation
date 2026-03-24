/**
 * Pure portfolio valuation helpers.
 */

(function attachValuation(globalScope) {
    const pricingCore = globalScope.OptionComboPricingCore;
    const amortized = globalScope.OptionComboAmortized;
    const productRegistry = globalScope.OptionComboProductRegistry;
    const pricingContext = globalScope.OptionComboPricingContext;

    if (!pricingCore || !amortized) {
        throw new Error('pricing_core.js and amortized.js must be loaded before valuation.js');
    }

    const { processLegData, computeSimulatedPrice } = pricingCore;
    const { calculateAmortizedCost, calculateCombinedAmortizedCost } = amortized;

    function isSettlementScenarioMode(viewMode) {
        return viewMode === 'amortized' || viewMode === 'settlement';
    }

    function isGroupIncludedInGlobal(group) {
        return group.includedInGlobal !== false;
    }

    function isUnderlyingLeg(leg) {
        return productRegistry.isUnderlyingLeg(leg);
    }

    function resolveLegEvaluationUnderlyingPrice(group, leg, globalState, usesScenarioUnderlying, anchorUnderlyingPrice) {
        if (!pricingContext) {
            return usesScenarioUnderlying ? anchorUnderlyingPrice : globalState.underlyingPrice;
        }

        if (usesScenarioUnderlying) {
            return pricingContext.resolveLegScenarioUnderlyingPrice(
                globalState,
                leg,
                anchorUnderlyingPrice,
                globalState.underlyingPrice
            );
        }

        return pricingContext.resolveLegCurrentUnderlyingPrice(
            globalState,
            leg,
            anchorUnderlyingPrice
        );
    }

    function buildCurrentPriceDisplayState(leg, activeViewMode, displayUnderlyingPrice, processedLeg, underlyingProfile) {
        if (leg && leg.currentPriceSource === 'missing') {
            return {
                value: '',
                placeholder: 'N/A',
                title: 'Historical quote unavailable for the selected replay date',
            };
        }

        if (isUnderlyingLeg(leg)) {
            const titleLabel = productRegistry && typeof productRegistry.getUnderlyingLegPriceTitle === 'function'
                ? productRegistry.getUnderlyingLegPriceTitle(
                    (underlyingProfile && (underlyingProfile.enteredSymbol || underlyingProfile.underlyingSymbol)) || ''
                )
                : 'Current Underlying Leg Price';
            if (leg.currentPrice === 0) {
                return {
                    value: '',
                    placeholder: displayUnderlyingPrice.toFixed(2),
                    title: `${titleLabel} (defaults to underlying)`
                };
            }
            return {
                value: leg.currentPrice.toFixed(2),
                placeholder: '0.00',
                title: titleLabel
            };
        }

        if (activeViewMode === 'trial' && leg.currentPrice === 0) {
            return {
                value: '',
                placeholder: processedLeg.effectiveCostPerShare.toFixed(2),
                title: 'Theoretical model price for today'
            };
        }

        if (leg && leg.currentPriceSource === 'historical') {
            return {
                value: leg.currentPrice.toFixed(2),
                placeholder: '0.00',
                title: 'Historical replay quote from the selected day',
            };
        }

        if (leg && leg.currentPriceSource === 'manual') {
            return {
                value: leg.currentPrice.toFixed(2),
                placeholder: '0.00',
                title: 'Manual current-price override',
            };
        }

        return {
            value: leg.currentPrice.toFixed(2),
            placeholder: '0.00',
            title: 'Current Live Quote (or manually entered)'
        };
    }

    function computeHedgeDerivedData(hedge) {
        const hasLivePnl = hedge.currentPriceSource !== 'missing' && hedge.currentPrice > 0;
        const pnl = hasLivePnl ? (hedge.currentPrice - hedge.cost) * hedge.pos : 0;

        return {
            id: hedge.id,
            pnl,
            hasLivePnl,
        };
    }

    function computeLegDerivedData(group, leg, globalState, activeViewMode, anchorUnderlyingPrice, usesScenarioUnderlying, underlyingProfile) {
        const simulationDate = pricingContext && typeof pricingContext.resolveSimulationDate === 'function'
            ? pricingContext.resolveSimulationDate(globalState)
            : globalState.simulatedDate;
        const quoteDate = pricingContext && typeof pricingContext.resolveQuoteDate === 'function'
            ? pricingContext.resolveQuoteDate(globalState)
            : globalState.baseDate;
        const legUnderlyingPrice = resolveLegEvaluationUnderlyingPrice(
            group,
            leg,
            globalState,
            usesScenarioUnderlying,
            anchorUnderlyingPrice
        );
        const legInterestRate = pricingContext && typeof pricingContext.resolveLegInterestRate === 'function'
            ? pricingContext.resolveLegInterestRate(globalState, leg, globalState.interestRate)
            : globalState.interestRate;
        const processedLeg = processLegData(
            leg,
            simulationDate,
            globalState.ivOffset,
            quoteDate,
            legUnderlyingPrice,
            legInterestRate,
            activeViewMode,
            underlyingProfile,
            globalState.marketDataMode
        );

        const simPricePerShare = computeSimulatedPrice(
            processedLeg,
            leg,
            legUnderlyingPrice,
            legInterestRate,
            activeViewMode,
            simulationDate,
            quoteDate,
            globalState.ivOffset
        );
        const simulationAvailable = Number.isFinite(simPricePerShare);
        const simValue = simulationAvailable ? processedLeg.posMultiplier * simPricePerShare : null;
        const pnl = simulationAvailable ? (simValue - processedLeg.costBasis) : null;
        const isClosed = (leg.closePrice !== null && leg.closePrice !== '');
        const quoteAvailable = leg.currentPriceSource !== 'missing';
        const hasLivePnl = activeViewMode === 'active'
            && quoteAvailable
            && (leg.cost !== 0 || leg.currentPrice !== 0 || isClosed);
        const liveLegPnL = quoteAvailable
            ? (leg.currentPrice - leg.cost) * processedLeg.posMultiplier
            : 0;
        const effectiveLivePnL = isClosed ? pnl : liveLegPnL;
        const ivText = processedLeg.isUnderlyingLeg
            ? ''
            : (processedLeg.simIVAvailable
                ? `Sim IV: ${(processedLeg.simIV * 100).toFixed(2)}%${processedLeg.simIVSource === 'estimated' ? ' (Estimated)' : ''}`
                : 'Sim IV: N/A (TWS unavailable)');

        return {
            id: leg.id,
            leg,
            processedLeg,
            simPricePerShare,
            simValue,
            pnl,
            simulationAvailable,
            isClosed,
            hasLivePnl,
            liveLegPnL,
            effectiveLivePnL,
            dteText: `Sim DTE: ${processedLeg.tradDTE} td / ${processedLeg.calDTE} cd`,
            ivText,
            currentPriceDisplay: buildCurrentPriceDisplayState(leg, activeViewMode, legUnderlyingPrice, processedLeg, underlyingProfile),
        };
    }

    function computeGroupDerivedData(group, globalState) {
        const underlyingProfile = productRegistry
            ? productRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol)
            : null;
        const activeViewMode = group.viewMode || 'active';
        const usesScenarioUnderlying = isSettlementScenarioMode(activeViewMode);
        const supportsAmortizedMode = !underlyingProfile || underlyingProfile.supportsAmortizedMode !== false;
        const isAmortizedMode = activeViewMode === 'amortized' && supportsAmortizedMode;
        const liveAnchorUnderlyingPrice = pricingContext
            ? pricingContext.resolveAnchorUnderlyingPrice(globalState, globalState.underlyingPrice)
            : globalState.underlyingPrice;
        const evalUnderlyingPrice = (usesScenarioUnderlying && group.settleUnderlyingPrice !== null)
            ? group.settleUnderlyingPrice
            : liveAnchorUnderlyingPrice;

        let groupCost = 0;
        let groupSimValue = 0;
        let groupLivePnL = 0;
        let groupHasLiveData = false;
        let groupSimulationAvailable = true;

        const legResults = group.legs.map((leg) => {
            const legResult = computeLegDerivedData(
                group,
                leg,
                globalState,
                activeViewMode,
                evalUnderlyingPrice,
                usesScenarioUnderlying,
                underlyingProfile
            );
            groupCost += legResult.processedLeg.costBasis;
            if (legResult.simulationAvailable) {
                groupSimValue += legResult.simValue;
            } else {
                groupSimulationAvailable = false;
            }

            if (legResult.hasLivePnl) {
                groupLivePnL += legResult.effectiveLivePnL;
                groupHasLiveData = true;
            }

            return legResult;
        });

        return {
            id: group.id,
            group,
            isHistoricalMode: globalState.marketDataMode === 'historical',
            isIncludedInGlobal: isGroupIncludedInGlobal(group),
            underlyingProfile,
            activeViewMode,
            usesScenarioUnderlying,
            isAmortizedMode,
            evalUnderlyingPrice,
            legResults,
            legResultsById: new Map(legResults.map(result => [result.id, result])),
            groupCost,
            groupSimulationAvailable,
            groupSimValue: groupSimulationAvailable ? groupSimValue : null,
            groupPnL: groupSimulationAvailable ? (groupSimValue - groupCost) : null,
            groupLivePnL,
            groupHasLiveData,
            amortizedResult: isAmortizedMode ? calculateAmortizedCost(group, evalUnderlyingPrice, globalState) : null,
        };
    }

    function computePortfolioDerivedData(globalState) {
        const underlyingProfile = productRegistry
            ? productRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol)
            : null;
        const hedgeResults = globalState.hedges.map(computeHedgeDerivedData);
        const groupResults = globalState.groups.map(group => computeGroupDerivedData(group, globalState));
        const includedGroupResults = groupResults.filter(result => result.isIncludedInGlobal);

        const globalTotalCost = includedGroupResults.reduce((sum, result) => sum + result.groupCost, 0);
        const globalSimulationAvailable = includedGroupResults.every(result => result.groupSimulationAvailable !== false);
        const globalSimulatedValue = globalSimulationAvailable
            ? includedGroupResults.reduce((sum, result) => sum + result.groupSimValue, 0)
            : null;
        const globalLivePnL = includedGroupResults.reduce((sum, result) => sum + (result.groupHasLiveData ? result.groupLivePnL : 0), 0);
        const hasAnyLiveData = includedGroupResults.some(result => result.groupHasLiveData);

        const globalHedgePnL = hedgeResults.reduce((sum, result) => sum + result.pnl, 0);
        const hasAnyHedgeLivePnL = hedgeResults.some(result => result.hasLivePnl);

        const supportsAmortizedMode = !underlyingProfile || underlyingProfile.supportsAmortizedMode !== false;
        const amortizedGroups = supportsAmortizedMode
            ? includedGroupResults
                .filter(result => result.isAmortizedMode)
                .map(result => result.group)
            : [];

        return {
            underlyingProfile,
            hedgeResults,
            hedgeResultsById: new Map(hedgeResults.map(result => [result.id, result])),
            groupResults,
            groupResultsById: new Map(groupResults.map(result => [result.id, result])),
            globalTotalCost,
            globalSimulationAvailable,
            globalSimulatedValue,
            globalPnL: globalSimulationAvailable ? (globalSimulatedValue - globalTotalCost) : null,
            globalLivePnL,
            hasAnyLiveData,
            globalHedgePnL,
            hasAnyHedgeLivePnL,
            combinedLivePnL: globalLivePnL + globalHedgePnL,
            amortizedGroups,
            combinedAmortizedResult: amortizedGroups.length > 0
                ? calculateCombinedAmortizedCost(amortizedGroups, globalState)
                : null,
        };
    }

    globalScope.OptionComboValuation = {
        isSettlementScenarioMode,
        buildCurrentPriceDisplayState,
        computeHedgeDerivedData,
        computeLegDerivedData,
        computeGroupDerivedData,
        computePortfolioDerivedData,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
