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

    function getSettlementUnitsPerContract(profileOrSymbol) {
        const profile = resolveInstrumentProfile(profileOrSymbol);
        if (profile && Number.isFinite(profile.settlementUnitsPerContract)) {
            return profile.settlementUnitsPerContract;
        }
        return 100;
    }

    function processLegData(leg, globalSimulatedDateStr, globalIvOffset, globalBaseDateStr = null, globalUnderlyingPrice = null, globalInterestRate = null, viewMode = 'active', instrumentProfile = null) {
        const resolvedProfile = resolveInstrumentProfile(instrumentProfile);
        const lowerType = leg.type.toLowerCase();
        if (lowerType === 'stock') {
            const posMultiplier = leg.pos * 1;
            let effectiveCostPerShare = leg.cost;
            if (viewMode === 'trial' || leg.cost === 0) {
                effectiveCostPerShare = (leg.currentPrice && leg.currentPrice > 0)
                    ? leg.currentPrice
                    : (globalUnderlyingPrice || 0);
            }
            return {
                type: 'stock',
                strike: 0,
                pos: leg.pos,
                isExpired: false,
                calDTE: 0,
                tradDTE: 0,
                T: 0,
                simIV: 0,
                contractMultiplier: 1,
                settlementUnitsPerContract: 1,
                posMultiplier,
                costBasis: posMultiplier * effectiveCostPerShare,
                effectiveCostPerShare
            };
        }

        const simDateObj = new Date(normalizeDateInput(globalSimulatedDateStr) + 'T00:00:00Z');
        const expDateObj = new Date(normalizeDateInput(leg.expDate) + 'T00:00:00Z');

        const isExpired = expDateObj <= simDateObj;
        const calDTE = isExpired ? 0 : diffDays(globalSimulatedDateStr, leg.expDate);
        const tradDTE = isExpired ? 0 : calendarToTradingDays(globalSimulatedDateStr, leg.expDate);
        const T = calDTE / 365.0;
        const simIV = Math.max(0.001, leg.iv + globalIvOffset);
        const contractMultiplier = getMultiplier(resolvedProfile);
        const settlementUnitsPerContract = getSettlementUnitsPerContract(resolvedProfile);
        const posMultiplier = leg.pos * contractMultiplier;

        let effectiveCostPerShare = leg.cost;

        if (viewMode === 'trial' || leg.cost === 0 || leg.cost === 0.00) {
            if (leg.currentPrice && leg.currentPrice > 0) {
                effectiveCostPerShare = leg.currentPrice;
            } else if (globalBaseDateStr && globalUnderlyingPrice !== null && globalInterestRate !== null) {
                const baseCalDTE = diffDays(globalBaseDateStr, leg.expDate);
                const baseT = baseCalDTE / 365.0;

                if (baseT <= 0) {
                    if (leg.type === 'call') effectiveCostPerShare = Math.max(0, globalUnderlyingPrice - leg.strike);
                    else effectiveCostPerShare = Math.max(0, leg.strike - globalUnderlyingPrice);
                } else {
                    effectiveCostPerShare = calculateOptionPrice(
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
            isExpired,
            calDTE,
            tradDTE,
            T,
            simIV,
            contractMultiplier,
            settlementUnitsPerContract,
            posMultiplier,
            costBasis: posMultiplier * effectiveCostPerShare,
            effectiveCostPerShare
        };
    }

    function computeLegPrice(processedLeg, underlyingPrice, interestRate) {
        if (processedLeg.type === 'stock') {
            return underlyingPrice;
        }
        if (processedLeg.isExpired) {
            if (processedLeg.type === 'call') {
                return Math.max(0, underlyingPrice - processedLeg.strike);
            }
            return Math.max(0, processedLeg.strike - underlyingPrice);
        }
        return calculateOptionPrice(
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

        if (processedLeg.type === 'stock') {
            return underlyingPrice;
        }

        const isEvaluatingRightNow = (simulatedDate === baseDate) && (ivOffset === 0);
        if (viewMode === 'trial' && isEvaluatingRightNow && rawLeg.currentPrice > 0) {
            return rawLeg.currentPrice;
        }

        return computeLegPrice(processedLeg, underlyingPrice, interestRate);
    }

    const api = {
        normalCDF,
        calculateD1,
        calculateD2,
        calculateOptionPrice,
        resolveInstrumentProfile,
        getMultiplier,
        getSettlementUnitsPerContract,
        processLegData,
        computeLegPrice,
        computeSimulatedPrice,
    };

    globalScope.OptionComboPricingCore = api;
    Object.assign(globalScope, api);
})(typeof globalThis !== 'undefined' ? globalThis : window);
