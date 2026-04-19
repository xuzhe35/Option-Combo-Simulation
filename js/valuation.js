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

    function formatPriceInputValue(symbol, value) {
        if (productRegistry && typeof productRegistry.formatPriceInputValue === 'function') {
            return productRegistry.formatPriceInputValue(symbol, value);
        }
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed.toFixed(2) : '';
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

    function resolveGroupLivePriceMode(group) {
        if (globalScope.OptionComboSessionLogic
            && typeof globalScope.OptionComboSessionLogic.normalizeGroupLivePriceMode === 'function') {
            return globalScope.OptionComboSessionLogic.normalizeGroupLivePriceMode(group && group.livePriceMode);
        }
        return String(group && group.livePriceMode || '').trim().toLowerCase() === 'midpoint'
            ? 'midpoint'
            : 'mark';
    }

    function resolveLiveQuoteSnapshotForLeg(leg) {
        const liveQuotes = globalScope.OptionComboWsLiveQuotes;
        if (!liveQuotes || !leg) {
            return null;
        }

        if (isUnderlyingLeg(leg)) {
            if (leg.underlyingFutureId
                && typeof liveQuotes.getFutureQuote === 'function') {
                return liveQuotes.getFutureQuote(leg.underlyingFutureId);
            }
            if (typeof liveQuotes.getUnderlyingQuote === 'function') {
                return liveQuotes.getUnderlyingQuote();
            }
            return null;
        }

        if (typeof liveQuotes.getOptionQuote === 'function') {
            return liveQuotes.getOptionQuote(leg.id);
        }
        return null;
    }

    function resolveSnapshotMidpoint(snapshot) {
        const bid = parseFloat(snapshot && snapshot.bid);
        const ask = parseFloat(snapshot && snapshot.ask);
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
            return null;
        }
        return (bid + ask) / 2;
    }

    function isClosedLeg(leg) {
        return !!(leg && leg.closePrice !== null && leg.closePrice !== '');
    }

    function resolveLegLiveDelta(processedLeg, leg) {
        if (!processedLeg || !leg) {
            return {
                available: false,
                value: 0,
                source: '',
            };
        }

        if (processedLeg.isUnderlyingLeg) {
            return {
                available: true,
                value: processedLeg.posMultiplier,
                source: 'underlying_position',
            };
        }

        const snapshot = resolveLiveQuoteSnapshotForLeg(leg);
        const rawDelta = parseFloat(snapshot && snapshot.delta);
        if (Number.isFinite(rawDelta)) {
            return {
                available: true,
                value: rawDelta * processedLeg.posMultiplier,
                source: 'live_option_delta',
            };
        }

        return {
            available: false,
            value: 0,
            source: '',
        };
    }

    function resolveLegSelectedLivePrice(group, leg) {
        const currentPrice = parseFloat(leg && leg.currentPrice);
        const currentPriceSource = String(leg && leg.currentPriceSource || '').trim();
        if (currentPriceSource === 'manual' && Number.isFinite(currentPrice) && currentPrice > 0) {
            return {
                available: true,
                price: currentPrice,
                source: 'manual',
            };
        }

        const livePriceMode = resolveGroupLivePriceMode(group);
        if (livePriceMode === 'mark') {
            const portfolioMarketPrice = parseFloat(leg && leg.portfolioMarketPrice);
            if (Number.isFinite(portfolioMarketPrice) && portfolioMarketPrice > 0) {
                return {
                    available: true,
                    price: portfolioMarketPrice,
                    source: 'tws_portfolio',
                };
            }
        }

        if (livePriceMode === 'midpoint') {
            const midpointPrice = resolveSnapshotMidpoint(resolveLiveQuoteSnapshotForLeg(leg));
            if (Number.isFinite(midpointPrice) && midpointPrice > 0) {
                return {
                    available: true,
                    price: midpointPrice,
                    source: 'live_midpoint',
                };
            }
        }

        if (leg && currentPriceSource !== 'missing' && Number.isFinite(currentPrice) && currentPrice > 0) {
            return {
                available: true,
                price: currentPrice,
                source: currentPriceSource || 'live_quote',
            };
        }

        return {
            available: false,
            price: 0,
            source: '',
        };
    }

    function buildCurrentPriceDisplayState(leg, activeViewMode, displayUnderlyingPrice, processedLeg, underlyingProfile, selectedLivePrice) {
        const displaySymbol = (underlyingProfile && (underlyingProfile.enteredSymbol || underlyingProfile.underlyingSymbol)) || '';
        const zeroText = formatPriceInputValue(displaySymbol, 0);

        if ((!selectedLivePrice || !selectedLivePrice.available) && leg && leg.currentPriceSource === 'missing') {
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
            if (!selectedLivePrice || !selectedLivePrice.available) {
                return {
                    value: '',
                    placeholder: formatPriceInputValue(displaySymbol, displayUnderlyingPrice),
                    title: `${titleLabel} (defaults to underlying)`
                };
            }
            return {
                value: formatPriceInputValue(displaySymbol, selectedLivePrice.price),
                placeholder: zeroText,
                title: selectedLivePrice.source === 'live_midpoint'
                    ? `${titleLabel} (bid/ask midpoint)`
                    : (selectedLivePrice.source === 'tws_portfolio'
                        ? `${titleLabel} (TWS Portfolio Mark)`
                        : titleLabel)
            };
        }

        if ((!selectedLivePrice || !selectedLivePrice.available)
            && activeViewMode === 'trial'
            && leg.currentPrice === 0) {
            return {
                value: '',
                placeholder: formatPriceInputValue(displaySymbol, processedLeg.effectiveCostPerShare),
                title: 'Theoretical model price for today'
            };
        }

        if (selectedLivePrice && selectedLivePrice.source === 'tws_portfolio') {
            return {
                value: formatPriceInputValue(displaySymbol, selectedLivePrice.price),
                placeholder: zeroText,
                title: 'TWS Portfolio Mark (display-only; order pricing still uses the existing midpoint execution flow).',
            };
        }

        if (selectedLivePrice && selectedLivePrice.source === 'live_midpoint') {
            return {
                value: formatPriceInputValue(displaySymbol, selectedLivePrice.price),
                placeholder: zeroText,
                title: 'Live bid/ask midpoint (display-only; order pricing still uses the existing midpoint execution flow).',
            };
        }

        if ((selectedLivePrice && selectedLivePrice.source === 'historical')
            || (leg && leg.currentPriceSource === 'historical')) {
            return {
                value: formatPriceInputValue(
                    displaySymbol,
                    selectedLivePrice && selectedLivePrice.available
                        ? selectedLivePrice.price
                        : leg.currentPrice
                ),
                placeholder: zeroText,
                title: 'Historical replay quote from the selected day',
            };
        }

        if ((selectedLivePrice && selectedLivePrice.source === 'manual')
            || (leg && leg.currentPriceSource === 'manual')) {
            return {
                value: formatPriceInputValue(
                    displaySymbol,
                    selectedLivePrice && selectedLivePrice.available
                        ? selectedLivePrice.price
                        : leg.currentPrice
                ),
                placeholder: zeroText,
                title: 'Manual current-price override',
            };
        }

        return {
            value: formatPriceInputValue(
                displaySymbol,
                selectedLivePrice && selectedLivePrice.available
                    ? selectedLivePrice.price
                    : leg.currentPrice
            ),
            placeholder: zeroText,
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
        const isClosed = isClosedLeg(leg);
        const livePnlQuote = resolveLegSelectedLivePrice(group, leg);
        const liveDelta = resolveLegLiveDelta(processedLeg, leg);
        const hasLivePnl = activeViewMode === 'active'
            && livePnlQuote.available
            && (leg.cost !== 0 || livePnlQuote.price !== 0 || isClosed);
        const liveLegPnL = livePnlQuote.available
            ? (livePnlQuote.price - leg.cost) * processedLeg.posMultiplier
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
            livePnlSource: livePnlQuote.source,
            deltaEligible: !isClosed,
            liveDelta: liveDelta.value,
            liveDeltaAvailable: liveDelta.available,
            liveDeltaSource: liveDelta.source,
            dteText: `Sim DTE: ${processedLeg.tradDTE} td / ${processedLeg.calDTE} cd`,
            ivText,
            currentPriceDisplay: buildCurrentPriceDisplayState(
                leg,
                activeViewMode,
                legUnderlyingPrice,
                processedLeg,
                underlyingProfile,
                livePnlQuote
            ),
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
        let groupUsesPortfolioLivePnl = false;
        let groupDelta = 0;
        let groupDeltaLegCount = 0;
        let groupDeltaMissingLegCount = 0;
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
                groupUsesPortfolioLivePnl = groupUsesPortfolioLivePnl || legResult.livePnlSource === 'tws_portfolio';
            }

            if (legResult.deltaEligible) {
                groupDeltaLegCount += 1;
                if (legResult.liveDeltaAvailable) {
                    groupDelta += legResult.liveDelta;
                } else {
                    groupDeltaMissingLegCount += 1;
                }
            }

            return legResult;
        });

        const groupDeltaDisplayable = globalState.marketDataMode === 'live'
            && group.liveData === true
            && groupDeltaLegCount > 0;
        const groupDeltaAvailable = groupDeltaDisplayable && groupDeltaMissingLegCount === 0;

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
            groupUsesPortfolioLivePnl,
            groupDeltaDisplayable,
            groupDeltaAvailable,
            groupDelta: groupDeltaAvailable ? groupDelta : null,
            groupDeltaLegCount,
            groupDeltaMissingLegCount,
            amortizedResult: isAmortizedMode ? calculateAmortizedCost(group, evalUnderlyingPrice, globalState) : null,
        };
    }

    function buildPortfolioDerivedDataFromResults(globalState, groupResults, hedgeResults) {
        const underlyingProfile = productRegistry
            ? productRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol)
            : null;
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

    function computePortfolioDerivedData(globalState) {
        const hedgeResults = globalState.hedges.map(computeHedgeDerivedData);
        const groupResults = globalState.groups.map(group => computeGroupDerivedData(group, globalState));
        return buildPortfolioDerivedDataFromResults(globalState, groupResults, hedgeResults);
    }

    globalScope.OptionComboValuation = {
        isSettlementScenarioMode,
        buildCurrentPriceDisplayState,
        computeHedgeDerivedData,
        computeLegDerivedData,
        computeGroupDerivedData,
        buildPortfolioDerivedDataFromResults,
        computePortfolioDerivedData,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
