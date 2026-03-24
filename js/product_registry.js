/**
 * Instrument-family metadata used to relax the stock/ETF-only assumptions
 * in the current UI and valuation pipeline.
 *
 * This is intentionally lightweight for now:
 * - browser calculations use the premium multiplier and mode-support flags
 * - live-data wiring still needs a fuller contract-resolution flow
 * - XML contract specs remain the long-term source of truth
 */

(function attachProductRegistry(globalScope) {
    const DEFAULT_PROFILE = Object.freeze({
        family: 'DEFAULT_EQUITY',
        displayName: 'Equity / ETF option',
        optionSecType: 'OPT',
        underlyingSecType: 'STK',
        optionSymbol: null,
        underlyingSymbol: null,
        optionExchange: 'SMART',
        underlyingExchange: 'SMART',
        currency: 'USD',
        tradingClass: null,
        optionMultiplier: 100,
        underlyingLegMultiplier: 1,
        settlementUnitsPerContract: 100,
        settlementKind: 'equity-deliverable',
        pricingModel: 'bsm-spot',
        supportsAmortizedMode: true,
        supportsLegacyLiveData: true,
        supportsUnderlyingLegs: true,
        deliverableUnitSingular: 'share',
        deliverableUnitPlural: 'shares',
        settlementActionPositive: 'Assigned',
        settlementActionNegative: 'Delivered',
    });

    const FAMILY_PROFILES = Object.freeze({
        ES: {
            family: 'ES',
            displayName: 'E-mini S&P 500 futures option',
            optionSecType: 'FOP',
            underlyingSecType: 'FUT',
            optionExchange: 'CME',
            underlyingExchange: 'CME',
            tradingClass: 'E3A',
            optionMultiplier: 50,
            underlyingLegMultiplier: 50,
            settlementUnitsPerContract: 1,
            settlementKind: 'futures-deliverable',
            pricingModel: 'black76',
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        NQ: {
            family: 'NQ',
            displayName: 'E-mini Nasdaq-100 futures option',
            optionSecType: 'FOP',
            underlyingSecType: 'FUT',
            optionExchange: 'CME',
            underlyingExchange: 'CME',
            tradingClass: 'Q3A',
            optionMultiplier: 20,
            underlyingLegMultiplier: 20,
            settlementUnitsPerContract: 1,
            settlementKind: 'futures-deliverable',
            pricingModel: 'black76',
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        CL: {
            family: 'CL',
            displayName: 'Light Sweet Crude Oil futures option',
            optionSecType: 'FOP',
            underlyingSecType: 'FUT',
            optionExchange: 'NYMEX',
            underlyingExchange: 'NYMEX',
            tradingClass: 'ML3',
            optionMultiplier: 1000,
            underlyingLegMultiplier: 1000,
            settlementUnitsPerContract: 1,
            settlementKind: 'futures-deliverable',
            pricingModel: 'black76',
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        GC: {
            family: 'GC',
            displayName: 'Gold futures option',
            optionSecType: 'FOP',
            underlyingSecType: 'FUT',
            optionExchange: 'COMEX',
            underlyingExchange: 'COMEX',
            tradingClass: 'G3T',
            optionMultiplier: 100,
            underlyingLegMultiplier: 100,
            settlementUnitsPerContract: 1,
            settlementKind: 'futures-deliverable',
            pricingModel: 'black76',
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        SI: {
            family: 'SI',
            displayName: 'Silver futures option',
            optionSecType: 'FOP',
            underlyingSecType: 'FUT',
            optionExchange: 'COMEX',
            underlyingExchange: 'COMEX',
            tradingClass: 'S3T',
            optionMultiplier: 5000,
            underlyingLegMultiplier: 5000,
            settlementUnitsPerContract: 1,
            settlementKind: 'futures-deliverable',
            pricingModel: 'black76',
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        HG: {
            family: 'HG',
            displayName: 'Copper futures option',
            optionSecType: 'FOP',
            underlyingSecType: 'FUT',
            optionExchange: 'COMEX',
            underlyingExchange: 'COMEX',
            tradingClass: 'H3T',
            optionMultiplier: 25000,
            underlyingLegMultiplier: 25000,
            settlementUnitsPerContract: 1,
            settlementKind: 'futures-deliverable',
            pricingModel: 'black76',
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        SPX: {
            family: 'SPX',
            displayName: 'S&P 500 index option',
            optionSecType: 'OPT',
            underlyingSecType: 'IND',
            optionSymbol: 'SPXW',
            underlyingSymbol: 'SPX',
            optionExchange: 'SMART',
            underlyingExchange: 'CBOE',
            tradingClass: 'SPXW',
            optionMultiplier: 100,
            settlementUnitsPerContract: 0,
            settlementKind: 'cash-settled',
            pricingModel: 'black76',
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: false,
            deliverableUnitSingular: 'cash settlement',
            deliverableUnitPlural: 'cash settlements',
            settlementActionPositive: 'Settled',
            settlementActionNegative: 'Settled',
        },
        NDX: {
            family: 'NDX',
            displayName: 'Nasdaq-100 index option',
            optionSecType: 'OPT',
            underlyingSecType: 'IND',
            optionSymbol: 'NDXP',
            underlyingSymbol: 'NDX',
            optionExchange: 'SMART',
            underlyingExchange: 'NASDAQ',
            tradingClass: 'NDXP',
            optionMultiplier: 100,
            settlementUnitsPerContract: 0,
            settlementKind: 'cash-settled',
            pricingModel: 'black76',
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: false,
            deliverableUnitSingular: 'cash settlement',
            deliverableUnitPlural: 'cash settlements',
            settlementActionPositive: 'Settled',
            settlementActionNegative: 'Settled',
        },
    });

    const ALIASES = Object.freeze({
        SPXW: 'SPX',
        NDXP: 'NDX',
    });

    const WEEKLY_FOP_TRADING_CLASS_SUFFIXES = Object.freeze({
        1: 'A',
        2: 'B',
        3: 'C',
        4: 'D',
    });

    function normalizeSymbol(symbol) {
        return String(symbol || '').trim().toUpperCase();
    }

    function resolveUnderlyingProfile(symbol) {
        const normalizedSymbol = normalizeSymbol(symbol);
        const familyKey = ALIASES[normalizedSymbol] || normalizedSymbol;
        const familyProfile = FAMILY_PROFILES[familyKey] || {};

        return {
            ...DEFAULT_PROFILE,
            ...familyProfile,
            enteredSymbol: normalizedSymbol,
            optionSymbol: familyProfile.optionSymbol || normalizedSymbol || DEFAULT_PROFILE.optionSymbol,
            underlyingSymbol: familyProfile.underlyingSymbol || normalizedSymbol || DEFAULT_PROFILE.underlyingSymbol,
        };
    }

    function getOptionMultiplier(symbol) {
        return resolveUnderlyingProfile(symbol).optionMultiplier;
    }

    function getUnderlyingLegMultiplier(symbol) {
        const profile = resolveUnderlyingProfile(symbol);
        return Number.isFinite(profile.underlyingLegMultiplier)
            ? profile.underlyingLegMultiplier
            : 1;
    }

    function getSettlementUnitsPerContract(symbol) {
        return resolveUnderlyingProfile(symbol).settlementUnitsPerContract;
    }

    function normalizeLegType(legOrType) {
        if (typeof legOrType === 'string') {
            return legOrType.trim().toLowerCase();
        }

        if (legOrType && typeof legOrType.type === 'string') {
            return legOrType.type.trim().toLowerCase();
        }

        return '';
    }

    function isUnderlyingLeg(legOrType) {
        const legType = normalizeLegType(legOrType);
        return legType === 'stock' || legType === 'underlying';
    }

    function isOptionLeg(legOrType) {
        const legType = normalizeLegType(legOrType);
        return legType === 'call' || legType === 'put';
    }

    function _parseIsoDateParts(dateText) {
        const normalized = String(dateText || '').trim().replace(/\//g, '-');
        const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        return {
            year: parseInt(match[1], 10),
            month: parseInt(match[2], 10),
            day: parseInt(match[3], 10),
        };
    }

    function _formatUtcDate(date) {
        return date.toISOString().slice(0, 10);
    }

    function _addUtcDays(date, days) {
        return new Date(Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate() + days
        ));
    }

    function _isTradingDate(dateText) {
        if (typeof globalScope.OptionComboDateUtils !== 'undefined'
            && typeof globalScope.OptionComboDateUtils.isTradingDay === 'function') {
            return globalScope.OptionComboDateUtils.isTradingDay(dateText);
        }

        if (typeof globalScope.isTradingDay === 'function') {
            return globalScope.isTradingDay(dateText);
        }

        const parts = _parseIsoDateParts(dateText);
        if (!parts) return false;
        const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
        const weekday = date.getUTCDay();
        return weekday !== 0 && weekday !== 6;
    }

    function _toContractMonthValue(year, month) {
        return `${year}${String(month).padStart(2, '0')}`;
    }

    function _shiftContractMonth(year, month, deltaMonths) {
        const zeroIndexed = (year * 12) + (month - 1) + deltaMonths;
        const nextYear = Math.floor(zeroIndexed / 12);
        const nextMonth = (zeroIndexed % 12) + 1;
        return _toContractMonthValue(nextYear, nextMonth);
    }

    function _getThirdFridayUtc(year, month) {
        const firstDay = new Date(Date.UTC(year, month - 1, 1));
        const firstWeekday = firstDay.getUTCDay();
        const daysUntilFriday = (5 - firstWeekday + 7) % 7;
        const thirdFridayDay = 1 + daysUntilFriday + 14;
        return new Date(Date.UTC(year, month - 1, thirdFridayDay));
    }

    function _getPreviousTradingDayUtc(date) {
        let cursor = _addUtcDays(date, -1);
        while (!_isTradingDate(_formatUtcDate(cursor))) {
            cursor = _addUtcDays(cursor, -1);
        }
        return cursor;
    }

    function _getSpxStandardMonthlyLastTradingDate(year, month) {
        let settlementDate = _getThirdFridayUtc(year, month);
        while (!_isTradingDate(_formatUtcDate(settlementDate))) {
            settlementDate = _addUtcDays(settlementDate, -1);
        }
        return _formatUtcDate(_getPreviousTradingDayUtc(settlementDate));
    }

    function resolveDefaultUnderlyingContractMonth(symbol, referenceDate) {
        const profile = resolveUnderlyingProfile(symbol);
        if (profile.underlyingSecType !== 'FUT') {
            return '';
        }

        const parts = _parseIsoDateParts(referenceDate);
        if (!parts) {
            return '';
        }

        if (profile.family === 'ES' || profile.family === 'NQ') {
            const candidateMonths = [3, 6, 9, 12];
            const referenceUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));

            for (const candidateMonth of candidateMonths) {
                const expiryUtc = _getThirdFridayUtc(parts.year, candidateMonth);
                if (referenceUtc <= expiryUtc) {
                    return _toContractMonthValue(parts.year, candidateMonth);
                }
            }

            return _toContractMonthValue(parts.year + 1, 3);
        }

        if (profile.family === 'CL') {
            return _shiftContractMonth(parts.year, parts.month, parts.day > 20 ? 2 : 1);
        }

        return _shiftContractMonth(parts.year, parts.month, 1);
    }

    function _getIsoWeekday(dateText) {
        const parts = _parseIsoDateParts(dateText);
        if (!parts) return null;
        return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    }

    function resolveTradingClass(symbol, expDate) {
        const profile = resolveUnderlyingProfile(symbol);
        const defaultTradingClass = profile.tradingClass;

        if (!expDate || !defaultTradingClass) {
            return defaultTradingClass;
        }

        if (profile.family === 'ES' || profile.family === 'NQ') {
            const weekday = _getIsoWeekday(expDate);
            const suffix = WEEKLY_FOP_TRADING_CLASS_SUFFIXES[weekday];
            if (suffix && defaultTradingClass.length >= 2) {
                return `${defaultTradingClass.slice(0, -1)}${suffix}`;
            }
        }

        if (profile.family === 'SPX') {
            const parts = _parseIsoDateParts(expDate);
            if (parts) {
                const standardMonthlyLastTradingDate = _getSpxStandardMonthlyLastTradingDate(parts.year, parts.month);
                if (standardMonthlyLastTradingDate === `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`) {
                    return 'SPX';
                }
            }
        }

        return defaultTradingClass;
    }

    function resolveOptionSymbol(symbol, expDate) {
        const profile = resolveUnderlyingProfile(symbol);
        if (profile.family === 'SPX') {
            return resolveTradingClass(symbol, expDate) === 'SPX' ? 'SPX' : 'SPXW';
        }
        return profile.optionSymbol || profile.enteredSymbol || null;
    }

    function resolveOptionContractSpec(symbol, expDate) {
        const profile = resolveUnderlyingProfile(symbol);
        return {
            symbol: resolveOptionSymbol(symbol, expDate) || profile.optionSymbol || profile.enteredSymbol || null,
            tradingClass: resolveTradingClass(symbol, expDate) || profile.tradingClass || null,
        };
    }

    function supportsAmortizedMode(symbol) {
        return resolveUnderlyingProfile(symbol).supportsAmortizedMode !== false;
    }

    function supportsLegacyLiveData(symbol) {
        return resolveUnderlyingProfile(symbol).supportsLegacyLiveData !== false;
    }

    function supportsUnderlyingLegs(symbol) {
        return resolveUnderlyingProfile(symbol).supportsUnderlyingLegs !== false;
    }

    function resolvePricingInputMode(symbol) {
        const profile = resolveUnderlyingProfile(symbol);
        if (profile.optionSecType === 'FOP') {
            return 'FOP';
        }
        if (profile.underlyingSecType === 'IND') {
            return 'INDEX';
        }
        return 'STK';
    }

    function usesForwardRateSamples(symbol) {
        return resolvePricingInputMode(symbol) === 'INDEX';
    }

    function usesFuturesPool(symbol) {
        return resolvePricingInputMode(symbol) === 'FOP';
    }

    function getUnderlyingLegLabel(symbol) {
        const profile = resolveUnderlyingProfile(symbol);
        if (profile.underlyingSecType === 'FUT') {
            return 'Underlying (Future)';
        }
        if (profile.underlyingSecType === 'STK') {
            return 'Underlying (Equity)';
        }
        return 'Underlying';
    }

    function getUnderlyingLegPriceTitle(symbol) {
        const profile = resolveUnderlyingProfile(symbol);
        if (profile.underlyingSecType === 'FUT') {
            return 'Current Underlying Future Price';
        }
        if (profile.underlyingSecType === 'STK') {
            return 'Current Underlying Equity Price';
        }
        return 'Current Underlying Leg Price';
    }

    function getDeliverableLabel(symbol, count) {
        const profile = resolveUnderlyingProfile(symbol);
        return Math.abs(count) === 1
            ? profile.deliverableUnitSingular
            : profile.deliverableUnitPlural;
    }

    const api = {
        normalizeSymbol,
        resolveUnderlyingProfile,
        resolveOptionSymbol,
        resolveOptionContractSpec,
        resolveTradingClass,
        resolveDefaultUnderlyingContractMonth,
        normalizeLegType,
        isUnderlyingLeg,
        isOptionLeg,
        getOptionMultiplier,
        getUnderlyingLegMultiplier,
        getSettlementUnitsPerContract,
        supportsAmortizedMode,
        supportsLegacyLiveData,
        supportsUnderlyingLegs,
        resolvePricingInputMode,
        usesForwardRateSamples,
        usesFuturesPool,
        getUnderlyingLegLabel,
        getUnderlyingLegPriceTitle,
        getDeliverableLabel,
    };

    globalScope.OptionComboProductRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
