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

    const {
        processLegData,
        computeSimulatedPrice,
        getMultiplier,
        getUnderlyingLegMultiplier,
        assessProjectionConvergence,
        formatProjectionConvergenceFailure,
        formatProjectionTimingFailure,
    } = pricingCore;
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

    function isGreeksEnabled(globalState) {
        return !!(globalState && globalState.greeksEnabled === true);
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
        return String(group && group.livePriceMode || '').trim().toLowerCase() === 'mark'
            ? 'mark'
            : 'midpoint';
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
        if (!Number.isFinite(bid) || bid < 0
            || !Number.isFinite(ask) || ask < 0
            || ask < bid) {
            return null;
        }
        const markSource = String(snapshot && snapshot.markSource || '').trim();
        const hasValidityFlag = snapshot && typeof snapshot.bidAskValid === 'boolean';
        const hasPresenceFlags = snapshot
            && (Object.prototype.hasOwnProperty.call(snapshot, 'bidPresent')
                || Object.prototype.hasOwnProperty.call(snapshot, 'askPresent'));
        let realTwoSided = false;
        if (hasValidityFlag) {
            realTwoSided = snapshot.bidAskValid === true;
        } else if (hasPresenceFlags || markSource) {
            realTwoSided = markSource === 'bid_ask_mid';
        } else if (snapshot) {
            realTwoSided = bid > 0 && ask > 0;
        }
        realTwoSided = realTwoSided
            && snapshot.bidPresent !== false
            && snapshot.askPresent !== false;
        return realTwoSided ? (bid + ask) / 2 : null;
    }

    function isClosedLeg(leg) {
        return !!(leg
            && leg.closePrice !== null
            && leg.closePrice !== ''
            && leg.closePrice !== undefined);
    }

    function normalizeLegPosition(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function normalizeFiniteNumber(value, fallback = 0) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function buildLegDteDisplay(processedLeg) {
        if (!processedLeg || processedLeg.isUnderlyingLeg) {
            return { text: '', title: '' };
        }
        if (processedLeg.timingAvailable === false
            || !Number.isFinite(processedLeg.calDTE)
            || !Number.isFinite(processedLeg.tradDTE)) {
            return {
                text: `Sim DTE: N/A (${processedLeg.timingStatus || 'timing unavailable'})`,
                title: 'The exact quote, target, expiry, calendar or implied-λ clock is unavailable.',
            };
        }

        const calendarDays = Math.max(0, processedLeg.calDTE);
        const tradingDays = Math.max(0, processedLeg.tradDTE);
        const calendarText = calendarDays <= 7
            ? `${(calendarDays * 24).toFixed(calendarDays * 24 < 10 ? 2 : 1)} h`
            : `${calendarDays.toFixed(2)} cd`;
        const tradingText = tradingDays.toFixed(tradingDays < 10 ? 3 : 2)
            .replace(/\.0+$/, '')
            .replace(/(\.\d*?[1-9])0+$/, '$1');
        const source = processedLeg.intradayTimeSource === 'contract'
            ? 'IB ContractDetails'
            : 'product-profile fallback';
        return {
            text: `Sim DTE: ${tradingText} td / ${calendarText}`,
            title: processedLeg.expiryCutoffAsOf
                ? `Expiry cutoff ${processedLeg.expiryCutoffAsOf} (${source}). All legs use the same portfolio target instant.`
                : `Expiry cutoff source: ${source}.`,
        };
    }

    function createEmptyOptionLegRedundancyBucket() {
        return {
            buyContracts: 0,
            sellContracts: 0,
            netContracts: 0,
            redundantContracts: 0,
            direction: 'flat',
        };
    }

    function finalizeOptionLegRedundancyBucket(bucket) {
        const netContracts = bucket.buyContracts - bucket.sellContracts;
        return {
            buyContracts: bucket.buyContracts,
            sellContracts: bucket.sellContracts,
            netContracts,
            redundantContracts: Math.abs(netContracts),
            direction: netContracts > 0 ? 'long' : (netContracts < 0 ? 'short' : 'flat'),
        };
    }

    function computeOptionLegRedundancy(groups) {
        const buckets = {
            call: createEmptyOptionLegRedundancyBucket(),
            put: createEmptyOptionLegRedundancyBucket(),
        };

        (Array.isArray(groups) ? groups : []).forEach((group) => {
            (Array.isArray(group && group.legs) ? group.legs : []).forEach((leg) => {
                if (!leg || isClosedLeg(leg)) {
                    return;
                }

                const type = String(leg.type || '').trim().toLowerCase();
                if (type !== 'call' && type !== 'put') {
                    return;
                }

                const contracts = Math.abs(normalizeLegPosition(leg.pos));
                if (contracts <= 0) {
                    return;
                }

                if (normalizeLegPosition(leg.pos) > 0) {
                    buckets[type].buyContracts += contracts;
                } else {
                    buckets[type].sellContracts += contracts;
                }
            });
        });

        return {
            call: finalizeOptionLegRedundancyBucket(buckets.call),
            put: finalizeOptionLegRedundancyBucket(buckets.put),
        };
    }

    function computeHedgeDelta(hedge) {
        const position = normalizeFiniteNumber(hedge && hedge.pos, 0);
        const multiplier = normalizeFiniteNumber(hedge && hedge.multiplier, 1);
        const deltaPerUnit = normalizeFiniteNumber(hedge && hedge.deltaPerUnit, 1);
        return position * multiplier * deltaPerUnit;
    }

    function resolveLegLiveDeltaSummary(leg, underlyingProfile, greeksEnabled) {
        if (!leg) {
            return {
                available: false,
                value: 0,
                source: '',
            };
        }

        if (greeksEnabled !== true) {
            return {
                available: false,
                value: 0,
                source: '',
            };
        }

        if (isUnderlyingLeg(leg)) {
            return {
                available: true,
                value: normalizeLegPosition(leg.pos) * getUnderlyingLegMultiplier(underlyingProfile),
                source: 'underlying_position',
            };
        }

        const snapshot = resolveLiveQuoteSnapshotForLeg(leg);
        const rawDelta = parseFloat(snapshot && snapshot.delta);
        if (Number.isFinite(rawDelta)) {
            return {
                available: true,
                value: rawDelta * normalizeLegPosition(leg.pos) * getMultiplier(underlyingProfile),
                source: 'live_option_delta',
            };
        }

        return {
            available: false,
            value: 0,
            source: '',
        };
    }

    function resolveLegLiveDelta(leg, underlyingProfile, greeksEnabled) {
        return resolveLegLiveDeltaSummary(leg, underlyingProfile, greeksEnabled);
    }

    function buildGroupDeltaSummary(group, globalState, deltaLegResults) {
        if (!isGreeksEnabled(globalState)) {
            return {
                groupDeltaDisplayable: false,
                groupDeltaAvailable: false,
                groupDelta: null,
                groupDeltaLegCount: 0,
                groupDeltaMissingLegCount: 0,
            };
        }

        let groupDelta = 0;
        let groupDeltaLegCount = 0;
        let groupDeltaMissingLegCount = 0;

        (Array.isArray(deltaLegResults) ? deltaLegResults : []).forEach((legResult) => {
            if (!legResult || legResult.deltaEligible !== true) {
                return;
            }

            groupDeltaLegCount += 1;
            if (legResult.liveDeltaAvailable) {
                groupDelta += legResult.liveDelta;
            } else {
                groupDeltaMissingLegCount += 1;
            }
        });

        const groupDeltaDisplayable = globalState.marketDataMode === 'live'
            && group.liveData === true
            && groupDeltaLegCount > 0;
        const groupDeltaAvailable = groupDeltaDisplayable && groupDeltaMissingLegCount === 0;

        return {
            groupDeltaDisplayable,
            groupDeltaAvailable,
            groupDelta: groupDeltaAvailable ? groupDelta : null,
            groupDeltaLegCount,
            groupDeltaMissingLegCount,
        };
    }

    function computeGroupDeltaSummary(group, globalState, underlyingProfile = null) {
        const resolvedProfile = underlyingProfile || (productRegistry
            ? productRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol)
            : null);
        const greeksEnabled = isGreeksEnabled(globalState);
        const deltaLegResults = (Array.isArray(group && group.legs) ? group.legs : []).map((leg) => {
            const liveDelta = resolveLegLiveDeltaSummary(leg, resolvedProfile, greeksEnabled);
            return {
                deltaEligible: !isClosedLeg(leg),
                liveDelta: liveDelta.value,
                liveDeltaAvailable: liveDelta.available,
            };
        });
        return buildGroupDeltaSummary(group, globalState, deltaLegResults);
    }

    function resolveLegSelectedLivePrice(group, leg, globalState = null) {
        if (pricingContext && typeof pricingContext.resolveObservableLegPrice === 'function') {
            return pricingContext.resolveObservableLegPrice(globalState, group, leg);
        }
        const currentPrice = parseFloat(leg && leg.currentPrice);
        const currentPriceSource = String(leg && leg.currentPriceSource || '').trim();
        if (currentPriceSource === 'manual' && Number.isFinite(currentPrice) && currentPrice >= 0) {
            return {
                available: true,
                price: currentPrice,
                source: 'manual',
            };
        }

        const livePriceMode = resolveGroupLivePriceMode(group);
        const midpointPrice = resolveSnapshotMidpoint(resolveLiveQuoteSnapshotForLeg(leg));
        const portfolioMarketPrice = parseFloat(leg && leg.portfolioMarketPrice);

        if (livePriceMode === 'mark' && Number.isFinite(portfolioMarketPrice) && portfolioMarketPrice >= 0) {
            return {
                available: true,
                price: portfolioMarketPrice,
                source: 'tws_portfolio',
            };
        }

        if (Number.isFinite(midpointPrice) && midpointPrice >= 0) {
            return {
                available: true,
                price: midpointPrice,
                source: 'live_midpoint',
            };
        }

        if (Number.isFinite(portfolioMarketPrice) && portfolioMarketPrice >= 0) {
            return {
                available: true,
                price: portfolioMarketPrice,
                source: 'tws_portfolio',
            };
        }

        if (leg && currentPriceSource !== 'missing'
            && Number.isFinite(currentPrice)
            && currentPrice >= 0
            && (currentPrice > 0 || !!currentPriceSource)) {
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
            const identityStatus = leg.liveQuoteIdentityStatus;
            const identityReason = String(leg.liveQuoteIdentityReason || '').trim();
            if (identityStatus === 'not_found') {
                return {
                    value: '',
                    placeholder: 'No contract',
                    title: identityReason
                        || 'IBKR has no contract for this strike and expiry, so no quote can be subscribed.',
                };
            }
            return {
                value: '',
                placeholder: 'N/A',
                title: identityStatus === 'rejected'
                    ? `Live quote rejected because qualified contract identity did not match${identityReason ? `: ${identityReason}` : ''}. Resubscribe after checking the option and underlying futures month.`
                    : 'Quote unavailable for the selected market snapshot',
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
        const multiplier = normalizeFiniteNumber(hedge && hedge.multiplier, 1);
        const pnl = hasLivePnl ? (hedge.currentPrice - hedge.cost) * hedge.pos * multiplier : 0;
        const hedgeDelta = computeHedgeDelta(hedge);

        return {
            id: hedge.id,
            pnl,
            hasLivePnl,
            hedgeDelta,
            hedgeDeltaAvailable: Number.isFinite(hedgeDelta),
        };
    }

    function computeLegDerivedData(group, leg, globalState, activeViewMode, anchorUnderlyingPrice, usesScenarioUnderlying, underlyingProfile) {
        const greeksEnabled = isGreeksEnabled(globalState);
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
        const livePnlQuote = resolveLegSelectedLivePrice(group, leg, globalState);
        const quotePricingInputs = pricingContext
            && typeof pricingContext.resolveLegQuotePricingInputs === 'function'
            ? pricingContext.resolveLegQuotePricingInputs(globalState, leg, {
                underlyingPrice: anchorUnderlyingPrice,
                interestRate: globalState.interestRate,
            })
            : null;
        const simulationTiming = pricingContext
            && typeof pricingContext.resolveSimulationTiming === 'function'
            ? pricingContext.resolveSimulationTiming(globalState)
            : (globalState && globalState.simulationTiming || null);
        const timingContext = {
            quoteAsOf: globalState.liveQuoteAsOf,
            allowLegacyQuoteCutoff: !globalState.marketDataMode,
            targetAsOf: simulationTiming && simulationTiming.available
                ? simulationTiming.targetAsOf
                : null,
            targetSource: simulationTiming && simulationTiming.source || null,
            timingStatus: simulationTiming && simulationTiming.status || null,
            observablePrice: livePnlQuote && livePnlQuote.available
                ? livePnlQuote.price
                : null,
            observablePriceSource: livePnlQuote && livePnlQuote.source || null,
            observablePriceAsOf: livePnlQuote && livePnlQuote.quoteAsOf || null,
            observablePriceFresh: livePnlQuote && livePnlQuote.fresh === true,
            quotePricingInputsAvailable: quotePricingInputs && quotePricingInputs.available === true,
            quotePricingInputStatus: quotePricingInputs && quotePricingInputs.status || null,
            quoteUnderlyingPrice: quotePricingInputs && quotePricingInputs.underlyingPrice,
            quoteUnderlyingAsOf: quotePricingInputs && quotePricingInputs.underlyingAsOf,
            quoteInterestRate: quotePricingInputs && quotePricingInputs.interestRate,
        };
        const simulationTimingAvailable = !simulationTiming
            || simulationTiming.available !== false;
        const processedLeg = processLegData(
            leg,
            simulationDate,
            globalState.ivOffset,
            quoteDate,
            legUnderlyingPrice,
            legInterestRate,
            activeViewMode,
            underlyingProfile,
            globalState.marketDataMode,
            timingContext
        );

        const pricingInputAvailable = Number.isFinite(legUnderlyingPrice)
            && (processedLeg.isUnderlyingLeg || legUnderlyingPrice > 0);
        const convergence = typeof assessProjectionConvergence === 'function'
            ? assessProjectionConvergence(globalState, [leg], [processedLeg])
            : { ready: true };
        const convergenceAvailable = convergence.ready !== false;
        const simPricePerShare = simulationTimingAvailable && pricingInputAvailable
            && convergenceAvailable
            ? computeSimulatedPrice(
                processedLeg,
                leg,
                legUnderlyingPrice,
                legInterestRate,
                activeViewMode,
                simulationDate,
                quoteDate,
                globalState.ivOffset,
                timingContext
            )
            : null;
        const simulationAvailable = Number.isFinite(simPricePerShare);
        const simulationUnavailableReason = processedLeg.timingStatus === 'implied_lambda_incomplete'
            ? 'implied_lambda_incomplete'
            : (!simulationTimingAvailable
            ? (simulationTiming && simulationTiming.status || 'simulation_timing_unavailable')
            : (!convergenceAvailable
                ? convergence.status
                : (!pricingInputAvailable ? 'pricing_underlying_unavailable' : null)));
        const simValue = simulationAvailable ? processedLeg.posMultiplier * simPricePerShare : null;
        const partialCloseRealizedPnl = Number.isFinite(parseFloat(leg.partialCloseRealizedPnl))
            ? parseFloat(leg.partialCloseRealizedPnl)
            : 0;
        const pnl = simulationAvailable ? (simValue - processedLeg.costBasis + partialCloseRealizedPnl) : null;
        const isClosed = isClosedLeg(leg);
        const liveDelta = resolveLegLiveDelta(leg, underlyingProfile, greeksEnabled);
        const hasLivePnl = activeViewMode === 'active'
            && ((livePnlQuote.available && (leg.cost !== 0 || livePnlQuote.price !== 0 || isClosed))
                || Math.abs(partialCloseRealizedPnl) > 0.0001);
        const liveLegPnL = livePnlQuote.available
            ? (livePnlQuote.price - leg.cost) * processedLeg.posMultiplier + partialCloseRealizedPnl
            : partialCloseRealizedPnl;
        const effectiveLivePnL = isClosed ? pnl : liveLegPnL;
        const lambdaTimingFailure = processedLeg.timingStatus === 'implied_lambda_incomplete';
        let ivText = '';
        if (!processedLeg.isUnderlyingLeg) {
            if (lambdaTimingFailure) {
                ivText = 'Sim IV: N/A (implied λ coverage missing)';
            } else if (!convergenceAvailable) {
                ivText = 'Sim IV: N/A (strict live BBO required)';
            } else if (processedLeg.simIVAvailable) {
                const sourceSuffix = processedLeg.simIVSource === 'estimated'
                    ? ' (Estimated)'
                    : (processedLeg.simIVSource === 'local-bbo-implied' ? ' (Local BBO)' : '');
                ivText = `Sim IV: ${(processedLeg.simIV * 100).toFixed(2)}%${sourceSuffix}`;
            } else if (processedLeg.localIvAnchorAttempted) {
                ivText = `Sim IV: N/A (Local BBO: ${processedLeg.localIvAnchorStatus})`;
            } else {
                ivText = 'Sim IV: N/A (TWS unavailable)';
            }
        }
        const dteDisplay = buildLegDteDisplay(processedLeg);
        let ivTitle;
        if (lambdaTimingFailure && typeof formatProjectionTimingFailure === 'function') {
            ivTitle = formatProjectionTimingFailure(
                processedLeg.timingStatus,
                'Valuation',
                processedLeg
            );
        } else if (!convergenceAvailable && typeof formatProjectionConvergenceFailure === 'function') {
            ivTitle = formatProjectionConvergenceFailure(convergence, 'Valuation');
        } else if (processedLeg.localIvAnchorAvailable) {
            ivTitle = `Fresh two-sided BBO re-inverted with the local ${processedLeg.pricingModel === 'black76' ? 'Black-76' : 'BSM'} model at ${processedLeg.quoteAsOf || 'the quote instant'}; future repricing holds this local IV constant.`;
        } else if (processedLeg.localIvAnchorAttempted) {
            ivTitle = `Local BBO calibration failed closed: ${processedLeg.localIvAnchorStatus}.`;
        } else {
            ivTitle = 'No qualifying fresh two-sided BBO anchor; the displayed input IV path is used.';
        }

        return {
            id: leg.id,
            leg,
            processedLeg,
            simPricePerShare,
            simValue,
            pnl,
            simulationAvailable,
            simulationUnavailableReason,
            projectionConvergence: convergence,
            simulationTimingStatus: simulationTiming && simulationTiming.status || null,
            isClosed,
            hasLivePnl,
            liveLegPnL,
            partialCloseRealizedPnl,
            effectiveLivePnL,
            livePnlSource: livePnlQuote.source,
            deltaEligible: !isClosed,
            liveDelta: liveDelta.value,
            liveDeltaAvailable: liveDelta.available,
            liveDeltaSource: liveDelta.source,
            dteText: dteDisplay.text,
            dteTitle: dteDisplay.title,
            ivText,
            ivTitle,
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
        let groupPartialCloseRealizedPnl = 0;
        let groupHasLiveData = false;
        let groupUsesPortfolioLivePnl = false;
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
            groupPartialCloseRealizedPnl += legResult.partialCloseRealizedPnl || 0;
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

            return legResult;
        });
        const groupDeltaSummary = buildGroupDeltaSummary(group, globalState, legResults);

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
            groupPnL: groupSimulationAvailable
                ? (groupSimValue - groupCost + groupPartialCloseRealizedPnl)
                : null,
            groupPartialCloseRealizedPnl,
            groupLivePnL,
            groupHasLiveData,
            groupUsesPortfolioLivePnl,
            ...groupDeltaSummary,
            amortizedResult: isAmortizedMode ? calculateAmortizedCost(group, evalUnderlyingPrice, globalState) : null,
        };
    }

    function buildPortfolioDerivedDataFromResults(globalState, groupResults, hedgeResults) {
        const underlyingProfile = productRegistry
            ? productRegistry.resolveUnderlyingProfile(globalState.underlyingSymbol)
            : null;
        const includedGroupResults = groupResults.filter(result => result.isIncludedInGlobal);
        const optionLegRedundancy = computeOptionLegRedundancy(globalState && globalState.groups);

        const globalTotalCost = includedGroupResults.reduce((sum, result) => sum + result.groupCost, 0);
        const globalPartialCloseRealizedPnl = includedGroupResults.reduce(
            (sum, result) => sum + (result.groupPartialCloseRealizedPnl || 0),
            0
        );
        const globalSimulationAvailable = includedGroupResults.every(result => result.groupSimulationAvailable !== false);
        const globalSimulatedValue = globalSimulationAvailable
            ? includedGroupResults.reduce((sum, result) => sum + result.groupSimValue, 0)
            : null;
        const globalLivePnL = includedGroupResults.reduce((sum, result) => sum + (result.groupHasLiveData ? result.groupLivePnL : 0), 0);
        const hasAnyLiveData = includedGroupResults.some(result => result.groupHasLiveData);

        const globalHedgePnL = hedgeResults.reduce((sum, result) => sum + result.pnl, 0);
        const hasAnyHedgeLivePnL = hedgeResults.some(result => result.hasLivePnl);
        const portfolioDeltaSummary = buildPortfolioDeltaSummary(globalState, includedGroupResults, hedgeResults);

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
            optionLegRedundancy,
            globalTotalCost,
            globalSimulationAvailable,
            globalSimulatedValue,
            globalPnL: globalSimulationAvailable
                ? (globalSimulatedValue - globalTotalCost + globalPartialCloseRealizedPnl)
                : null,
            globalPartialCloseRealizedPnl,
            globalLivePnL,
            hasAnyLiveData,
            globalHedgePnL,
            hasAnyHedgeLivePnL,
            combinedLivePnL: globalLivePnL + globalHedgePnL,
            ...portfolioDeltaSummary,
            amortizedGroups,
            combinedAmortizedResult: amortizedGroups.length > 0
                ? calculateCombinedAmortizedCost(amortizedGroups, globalState)
                : null,
        };
    }

    function buildPortfolioDeltaSummary(globalState, includedGroupResults, hedgeResults) {
        const deltaGroupResults = (Array.isArray(includedGroupResults) ? includedGroupResults : [])
            .filter(result => Number(result && result.groupDeltaLegCount || 0) > 0);
        const portfolioDeltaIncludedGroupCount = deltaGroupResults.length;
        const portfolioDeltaMissingGroupCount = deltaGroupResults.filter(result => result.groupDeltaAvailable !== true).length;
        const portfolioDeltaDisplayable = isGreeksEnabled(globalState)
            && globalState.marketDataMode === 'live'
            && (portfolioDeltaIncludedGroupCount > 0 || (hedgeResults || []).length > 0);
        const portfolioDeltaAvailable = portfolioDeltaDisplayable && portfolioDeltaMissingGroupCount === 0;
        const portfolioHedgeDelta = (Array.isArray(hedgeResults) ? hedgeResults : [])
            .reduce((sum, result) => sum + normalizeFiniteNumber(result && result.hedgeDelta, 0), 0);
        const portfolioOptionDelta = portfolioDeltaAvailable
            ? deltaGroupResults.reduce((sum, result) => sum + normalizeFiniteNumber(result && result.groupDelta, 0), 0)
            : null;

        return {
            portfolioOptionDelta,
            portfolioHedgeDelta,
            portfolioNetDelta: portfolioDeltaAvailable ? portfolioOptionDelta + portfolioHedgeDelta : null,
            portfolioDeltaAvailable,
            portfolioDeltaMissingGroupCount,
            portfolioDeltaIncludedGroupCount,
            portfolioDeltaDisplayable,
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
        computeOptionLegRedundancy,
        resolveLegSelectedLivePrice,
        computeGroupDeltaSummary,
        computeGroupDerivedData,
        buildPortfolioDeltaSummary,
        buildPortfolioDerivedDataFromResults,
        computePortfolioDerivedData,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
