/**
 * Pure pricing helpers shared by the browser app and tests.
 */

(function attachPricingCore(globalScope) {
    const dateUtils = globalScope.OptionComboDateUtils;
    const productRegistry = globalScope.OptionComboProductRegistry;
    if (!dateUtils) {
        throw new Error('OptionComboDateUtils must be loaded before pricing_core.js');
    }

    const { diffDays, calendarToTradingDays, normalizeDateInput } = dateUtils;

    function normalCDF(x) {
        let sign = (x < 0) ? -1 : 1;
        x = Math.abs(x) / Math.sqrt(2.0);

        let t = 1.0 / (1.0 + 0.3275911 * x);
        let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);

        return 0.5 * (1.0 + sign * y);
    }

    function calculateD1(S, K, T, r, v) {
        return (Math.log(S / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
    }

    function calculateD2(d1, v, T) {
        return d1 - v * Math.sqrt(T);
    }

    function calculateOptionPrice(type, S, K, T, r, v) {
        if (T <= 0) {
            if (type === 'call') return Math.max(0, S - K);
            if (type === 'put') return Math.max(0, K - S);
            return 0;
        }

        if (v <= 0) v = 0.0001;
        if (S <= 0) S = 0.0001;

        const d1 = calculateD1(S, K, T, r, v);
        const d2 = calculateD2(d1, v, T);

        if (type === 'call') {
            return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
        }
        if (type === 'put') {
            return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
        }

        return 0;
    }

    /**
     * Black-76 model for pricing options on forwards/futures.
     * F = forward/futures price (used directly; no cost-of-carry drift).
     * d1 = [ln(F/K) + (σ²/2)T] / σ√T
     * Call = e^(-rT) [F·N(d1) − K·N(d2)]
     * Put  = e^(-rT) [K·N(−d2) − F·N(−d1)]
     */
    function calculateBlack76Price(type, F, K, T, r, v) {
        if (T <= 0) {
            if (type === 'call') return Math.max(0, F - K);
            if (type === 'put') return Math.max(0, K - F);
            return 0;
        }

        if (v <= 0) v = 0.0001;
        if (F <= 0) F = 0.0001;

        const sqrtT = Math.sqrt(T);
        const d1 = (Math.log(F / K) + (v * v / 2) * T) / (v * sqrtT);
        const d2 = d1 - v * sqrtT;
        const discount = Math.exp(-r * T);

        if (type === 'call') {
            return discount * (F * normalCDF(d1) - K * normalCDF(d2));
        }
        if (type === 'put') {
            return discount * (K * normalCDF(-d2) - F * normalCDF(-d1));
        }

        return 0;
    }

    /**
     * Dispatch to the appropriate pricing model.
     * @param {string} pricingModel - 'bsm-spot' or 'black76'
     */
    function calculatePrice(pricingModel, type, S, K, T, r, v) {
        if (pricingModel === 'black76') {
            return calculateBlack76Price(type, S, K, T, r, v);
        }
        return calculateOptionPrice(type, S, K, T, r, v);
    }

    function resolveInstrumentProfile(profileOrSymbol) {
        if (!profileOrSymbol) return null;

        if (typeof profileOrSymbol === 'object' && profileOrSymbol.optionMultiplier !== undefined) {
            return profileOrSymbol;
        }

        if (productRegistry && typeof productRegistry.resolveUnderlyingProfile === 'function') {
            return productRegistry.resolveUnderlyingProfile(profileOrSymbol);
        }

        return null;
    }

    function getMultiplier(profileOrSymbol) {
        const profile = resolveInstrumentProfile(profileOrSymbol);
        if (profile && Number.isFinite(profile.optionMultiplier)) {
            return profile.optionMultiplier;
        }
        return 100;
    }

    function getUnderlyingLegMultiplier(profileOrSymbol) {
        const profile = resolveInstrumentProfile(profileOrSymbol);
        if (profile && Number.isFinite(profile.underlyingLegMultiplier)) {
            return profile.underlyingLegMultiplier;
        }
        return 1;
    }

    function getSettlementUnitsPerContract(profileOrSymbol) {
        const profile = resolveInstrumentProfile(profileOrSymbol);
        if (profile && Number.isFinite(profile.settlementUnitsPerContract)) {
            return profile.settlementUnitsPerContract;
        }
        return 100;
    }

    function isUnderlyingLeg(legOrType) {
        return productRegistry.isUnderlyingLeg(legOrType);
    }

    function isLiveIvMissing(leg) {
        return !!(leg && leg.ivSource === 'missing');
    }

    function hasUsableLegIv(leg) {
        return !isLiveIvMissing(leg) && Number.isFinite(leg && leg.iv) && leg.iv > 0;
    }

    function hasUsableCurrentQuote(leg) {
        return !!(
            leg
            && leg.currentPriceSource !== 'missing'
            && Number.isFinite(leg.currentPrice)
            && leg.currentPrice > 0
        );
    }

    function formatLegIvInputValue(leg) {
        if (isLiveIvMissing(leg)) {
            return 'N/A';
        }

        const iv = Number.isFinite(leg && leg.iv) ? leg.iv : 0;
        return `${(iv * 100).toFixed(4)}%`;
    }

    function describeLegIvInput(leg) {
        if (isUnderlyingLeg(leg)) {
            return {
                value: '',
                title: '',
            };
        }

        if (isLiveIvMissing(leg)) {
            return {
                value: 'N/A',
                title: 'Live IV is unavailable from TWS for this contract. Future simulations are disabled until a live or manual IV is available.',
            };
        }

        if (leg && leg.ivSource === 'live') {
            return {
                value: formatLegIvInputValue(leg),
                title: 'Live IV from TWS',
            };
        }

        if (leg && leg.ivSource === 'historical') {
            return {
                value: formatLegIvInputValue(leg),
                title: 'Historical IV from SQLite replay data',
            };
        }

        if (leg && leg.ivSource === 'estimated') {
            return {
                value: formatLegIvInputValue(leg),
                title: 'Estimated IV (not from TWS)',
            };
        }

        return {
            value: formatLegIvInputValue(leg),
            title: 'Manual IV',
        };
    }

    function processLegData(leg, globalSimulatedDateStr, globalIvOffset, globalBaseDateStr = null, globalUnderlyingPrice = null, globalInterestRate = null, viewMode = 'active', instrumentProfile = null, marketDataMode = 'live') {
        const resolvedProfile = resolveInstrumentProfile(instrumentProfile);
        const pricingModel = (resolvedProfile && resolvedProfile.pricingModel) || 'bsm-spot';
        const lowerType = leg.type.toLowerCase();
        if (isUnderlyingLeg(leg)) {
            const contractMultiplier = getUnderlyingLegMultiplier(resolvedProfile);
            const posMultiplier = leg.pos * contractMultiplier;
            let effectiveCostPerUnit = leg.cost;
            if (viewMode === 'trial' || leg.cost === 0) {
                effectiveCostPerUnit = hasUsableCurrentQuote(leg)
                    ? leg.currentPrice
                    : (globalUnderlyingPrice || 0);
            }
            return {
                type: 'underlying',
                strike: 0,
                pos: leg.pos,
                isExpired: false,
                calDTE: 0,
                tradDTE: 0,
                T: 0,
                simIV: 0,
                isUnderlyingLeg: true,
                pricingModel,
                contractMultiplier,
                settlementUnitsPerContract: 1,
                posMultiplier,
                costBasis: posMultiplier * effectiveCostPerUnit,
                effectiveCostPerShare: effectiveCostPerUnit,
                effectiveCostPerUnit
            };
        }

        const simDateObj = new Date(normalizeDateInput(globalSimulatedDateStr) + 'T00:00:00Z');
        const expDateObj = new Date(normalizeDateInput(leg.expDate) + 'T00:00:00Z');

        const isExpired = expDateObj <= simDateObj;
        const calDTE = isExpired ? 0 : diffDays(globalSimulatedDateStr, leg.expDate);
        const tradDTE = isExpired ? 0 : calendarToTradingDays(globalSimulatedDateStr, leg.expDate);
        const T = calDTE / 365.0;
        const baseIv = hasUsableLegIv(leg) ? leg.iv : null;
        const simIV = isExpired
            ? 0
            : (baseIv !== null ? Math.max(0.001, baseIv + globalIvOffset) : null);
        const contractMultiplier = getMultiplier(resolvedProfile);
        const settlementUnitsPerContract = getSettlementUnitsPerContract(resolvedProfile);
        const posMultiplier = leg.pos * contractMultiplier;
        const expiryUnderlyingPrice = marketDataMode === 'historical' && isExpired
            ? (Number.isFinite(parseFloat(leg.historicalExpiryUnderlyingPrice))
                ? parseFloat(leg.historicalExpiryUnderlyingPrice)
                : null)
            : null;

        let effectiveCostPerShare = leg.cost;

        if (viewMode === 'trial' || leg.cost === 0 || leg.cost === 0.00) {
            if (hasUsableCurrentQuote(leg)) {
                effectiveCostPerShare = leg.currentPrice;
            } else if (globalBaseDateStr && globalUnderlyingPrice !== null && globalInterestRate !== null) {
                const baseCalDTE = diffDays(globalBaseDateStr, leg.expDate);
                const baseT = baseCalDTE / 365.0;

                if (baseT <= 0) {
                    if (leg.type === 'call') effectiveCostPerShare = Math.max(0, globalUnderlyingPrice - leg.strike);
                    else effectiveCostPerShare = Math.max(0, leg.strike - globalUnderlyingPrice);
                } else if (baseIv !== null) {
                    effectiveCostPerShare = calculatePrice(
                        pricingModel,
                        leg.type,
                        globalUnderlyingPrice,
                        leg.strike,
                        baseT,
                        globalInterestRate,
                        leg.iv
                    );
                }
            }
        }

        return {
            type: lowerType,
            strike: leg.strike,
            pos: leg.pos,
            isUnderlyingLeg: false,
            isExpired,
            calDTE,
            tradDTE,
            T,
            simIV,
            simIVAvailable: isExpired || simIV !== null,
            simIVSource: isLiveIvMissing(leg) ? 'missing' : (leg.ivSource || 'manual'),
            pricingModel,
            contractMultiplier,
            settlementUnitsPerContract,
            posMultiplier,
            costBasis: posMultiplier * effectiveCostPerShare,
            effectiveCostPerShare,
            expiryUnderlyingPrice
        };
    }

    function computeLegPrice(processedLeg, underlyingPrice, interestRate) {
        if (processedLeg.isUnderlyingLeg || isUnderlyingLeg(processedLeg.type)) {
            return underlyingPrice;
        }
        if (processedLeg.isExpired) {
            const settlementUnderlyingPrice = Number.isFinite(processedLeg.expiryUnderlyingPrice)
                ? processedLeg.expiryUnderlyingPrice
                : underlyingPrice;
            if (processedLeg.type === 'call') {
                return Math.max(0, settlementUnderlyingPrice - processedLeg.strike);
            }
            return Math.max(0, processedLeg.strike - settlementUnderlyingPrice);
        }
        if (!Number.isFinite(processedLeg.simIV) || processedLeg.simIV <= 0) {
            return null;
        }
        return calculatePrice(
            processedLeg.pricingModel || 'bsm-spot',
            processedLeg.type,
            underlyingPrice,
            processedLeg.strike,
            processedLeg.T,
            interestRate,
            processedLeg.simIV
        );
    }

    function computeSimulatedPrice(processedLeg, rawLeg, underlyingPrice, interestRate, viewMode, simulatedDate, baseDate, ivOffset) {
        if (rawLeg.closePrice !== null && rawLeg.closePrice !== '') {
            const parsedClose = parseFloat(rawLeg.closePrice);
            if (!isNaN(parsedClose) && parsedClose >= 0) {
                return parsedClose;
            }
        }

        if (processedLeg.isUnderlyingLeg || isUnderlyingLeg(processedLeg.type)) {
            return underlyingPrice;
        }

        const isEvaluatingRightNow = (simulatedDate === baseDate) && (ivOffset === 0);
        if (viewMode === 'trial' && isEvaluatingRightNow && hasUsableCurrentQuote(rawLeg)) {
            return rawLeg.currentPrice;
        }

        return computeLegPrice(processedLeg, underlyingPrice, interestRate);
    }

    const api = {
        normalCDF,
        calculateD1,
        calculateD2,
        calculateOptionPrice,
        calculateBlack76Price,
        calculatePrice,
        resolveInstrumentProfile,
        isUnderlyingLeg,
        getMultiplier,
        getUnderlyingLegMultiplier,
        getSettlementUnitsPerContract,
        processLegData,
        computeLegPrice,
        computeSimulatedPrice,
        isLiveIvMissing,
        hasUsableLegIv,
        hasUsableCurrentQuote,
        formatLegIvInputValue,
        describeLegIvInput,
    };

    globalScope.OptionComboPricingCore = api;
    Object.assign(globalScope, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
