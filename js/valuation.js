/**
 * Pure portfolio valuation helpers.
 */

(function attachValuation(globalScope) {
    const pricingCore = globalScope.OptionComboPricingCore;
    const amortized = globalScope.OptionComboAmortized;
    const productRegistry = globalScope.OptionComboProductRegistry;

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
        return productRegistry && typeof productRegistry.isUnderlyingLeg === 'function'
            ? productRegistry.isUnderlyingLeg(leg)
            : String(leg && leg.type || '').toLowerCase() === 'stock';
    }

    function buildCurrentPriceDisplayState(leg, activeViewMode, evalUnderlyingPrice, processedLeg, underlyingProfile) {
        if (isUnderlyingLeg(leg)) {
            const titleLabel = productRegistry && typeof productRegistry.getUnderlyingLegPriceTitle === 'function'
                ? productRegistry.getUnderlyingLegPriceTitle(
                    (underlyingProfile && (underlyingProfile.enteredSymbol || underlyingProfile.underlyingSymbol)) || ''
                )
                : 'Current Underlying Leg Price';
            if (leg.currentPrice === 0) {
                return {
                    value: '',
                    placeholder: evalUnderlyingPrice.toFixed(2),
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

        return {
            value: leg.currentPrice.toFixed(2),
            placeholder: '0.00',
            title: 'Current Live Quote (or manually entered)'
        };
    }

    function computeHedgeDerivedData(hedge) {
        const hasLivePnl = hedge.currentPrice > 0;
        const pnl = hasLivePnl ? (hedge.currentPrice - hedge.cost) * hedge.pos : 0;

        return {
            id: hedge.id,
            pnl,
            hasLivePnl,
        };
    }

    function computeLegDerivedData(group, leg, globalState, activeViewMode, evalUnderlyingPrice, underlyingProfile) {
        const processedLeg = processLegData(
            leg,
            globalState.simulatedDate,
            globalState.ivOffset,
            globalState.baseDate,
            evalUnderlyingPrice,
            globalState.interestRate,
            activeViewMode,
            underlyingProfile
        );

        const simPricePerShare = computeSimulatedPrice(
            processedLeg,
            leg,
            evalUnderlyingPrice,
            globalState.interestRate,
            activeViewMode,
            globalState.simulatedDate,
            globalState.baseDate,
            globalState.ivOffset
        );
        const simulationAvailable = Number.isFinite(simPricePerShare);
        const simValue = simulationAvailable ? processedLeg.posMultiplier * simPricePerShare : null;
        const pnl = simulationAvailable ? (simValue - processedLeg.costBasis) : null;
        const isClosed = (leg.closePrice !== null && leg.closePrice !== '');
        const hasLivePnl = activeViewMode === 'active' && (leg.cost !== 0 || leg.currentPrice !== 0 || isClosed);
        const liveLegPnL = (leg.currentPrice - leg.cost) * processedLeg.posMultiplier;
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
            currentPriceDisplay: buildCurrentPriceDisplayState(leg, activeViewMode, evalUnderlyingPrice, processedLeg, underlyingProfile),
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
        const evalUnderlyingPrice = (usesScenarioUnderlying && group.settleUnderlyingPrice !== null)
            ? group.settleUnderlyingPrice
            : globalState.underlyingPrice;

        let groupCost = 0;
        let groupSimValue = 0;
        let groupLivePnL = 0;
        let groupHasLiveData = false;
        let groupSimulationAvailable = true;

        const legResults = group.legs.map((leg) => {
            const legResult = computeLegDerivedData(group, leg, globalState, activeViewMode, evalUnderlyingPrice, underlyingProfile);
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
