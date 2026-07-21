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
        // Product-specific official exchange holiday calendar.  The generated
        // snapshot currently covers NYSE plus the configured CME/NYMEX/COMEX
        // product families; unknown, stale, or out-of-range calendars fail
        // closed rather than borrowing the NYSE clock or guessing rules.
        calendarId: 'NYSE',
        // Intraday fallback used only when a live quote is already on the
        // option's expiration trade date. A contract-specific expiryAsOf on
        // the leg overrides this profile cutoff.
        optionExpiryTimeZone: 'America/New_York',
        optionExpiryHour: 16,
        optionExpiryMinute: 0,
        // Near-the-money strike spacing for the front months. Product families
        // below pin their real listed grid when it is coarser or fractional,
        // and callers treat those as authoritative. This generic $1 value is
        // only a price-blind placeholder for the liquid ETF range — callers
        // that know the underlying price (see group_editor_ui's
        // _getStrikeIncrement) prefer their own heuristic for DEFAULT_EQUITY,
        // since $1 is wrong for both 1000+ and penny-ish names.
        strikeIncrement: 1,
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
        // Discounting, outright Forward and carry are different market
        // quantities.  Every USD product resolves discounting from the shared
        // USD curve; these fields describe only where the pricing input and
        // optional carry diagnostics come from.
        discountCurveCurrency: 'USD',
        discountCurvePolicy: 'usd-reference-curve',
        forwardSource: 'spot-bsm',
        carrySource: 'discount-rate-q-zero-model-fallback',
        carrySemantics: 'bsm-q-zero-model-fallback',
        carryReference: null,
        requiresPerLegForwardBinding: false,
        rateMaySubstituteForCarry: true,
        priceDisplayDecimals: 2,
        comboPriceIncrement: 0.01,
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
            strikeIncrement: 5,
            calendarId: 'CME:ES',
            optionExpiryTimeZone: 'America/Chicago',
            optionExpiryHour: 15,
            optionExpiryMinute: 0,
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
            forwardSource: 'bound-futures-quote',
            carrySource: 'exchange-futures-curve',
            carrySemantics: 'equity-index-net-carry',
            carryReference: Object.freeze({
                id: 'spot',
                secType: 'IND',
                symbol: 'SPX',
                exchange: 'CBOE',
                currency: 'USD',
            }),
            requiresPerLegForwardBinding: true,
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        NQ: {
            family: 'NQ',
            strikeIncrement: 10,
            calendarId: 'CME:NQ',
            optionExpiryTimeZone: 'America/Chicago',
            optionExpiryHour: 15,
            optionExpiryMinute: 0,
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
            forwardSource: 'bound-futures-quote',
            carrySource: 'exchange-futures-curve',
            carrySemantics: 'equity-index-net-carry',
            carryReference: Object.freeze({
                id: 'spot',
                secType: 'IND',
                symbol: 'NDX',
                exchange: 'NASDAQ',
                currency: 'USD',
            }),
            requiresPerLegForwardBinding: true,
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        MES: {
            family: 'MES',
            strikeIncrement: 5,
            calendarId: 'CME:MES',
            optionExpiryTimeZone: 'America/Chicago',
            optionExpiryHour: 15,
            optionExpiryMinute: 0,
            displayName: 'Micro E-mini S&P 500 futures option',
            optionSecType: 'FOP',
            underlyingSecType: 'FUT',
            optionExchange: 'CME',
            underlyingExchange: 'CME',
            optionMultiplier: 5,
            underlyingLegMultiplier: 5,
            settlementUnitsPerContract: 1,
            settlementKind: 'futures-deliverable',
            pricingModel: 'black76',
            forwardSource: 'bound-futures-quote',
            carrySource: 'exchange-futures-curve',
            carrySemantics: 'equity-index-net-carry',
            carryReference: Object.freeze({
                id: 'spot',
                secType: 'IND',
                symbol: 'SPX',
                exchange: 'CBOE',
                currency: 'USD',
            }),
            requiresPerLegForwardBinding: true,
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        MNQ: {
            family: 'MNQ',
            strikeIncrement: 10,
            calendarId: 'CME:MNQ',
            optionExpiryTimeZone: 'America/Chicago',
            optionExpiryHour: 15,
            optionExpiryMinute: 0,
            displayName: 'Micro E-mini Nasdaq-100 futures option',
            optionSecType: 'FOP',
            underlyingSecType: 'FUT',
            optionExchange: 'CME',
            underlyingExchange: 'CME',
            optionMultiplier: 2,
            underlyingLegMultiplier: 2,
            settlementUnitsPerContract: 1,
            settlementKind: 'futures-deliverable',
            pricingModel: 'black76',
            forwardSource: 'bound-futures-quote',
            carrySource: 'exchange-futures-curve',
            carrySemantics: 'equity-index-net-carry',
            carryReference: Object.freeze({
                id: 'spot',
                secType: 'IND',
                symbol: 'NDX',
                exchange: 'NASDAQ',
                currency: 'USD',
            }),
            requiresPerLegForwardBinding: true,
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        CL: {
            family: 'CL',
            strikeIncrement: 0.5,
            calendarId: 'NYMEX:CL',
            optionExpiryTimeZone: 'America/Chicago',
            optionExpiryHour: 13,
            optionExpiryMinute: 30,
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
            forwardSource: 'bound-futures-quote',
            carrySource: 'exchange-futures-curve',
            carrySemantics: 'commodity-futures-curve',
            requiresPerLegForwardBinding: true,
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        GC: {
            family: 'GC',
            strikeIncrement: 5,
            calendarId: 'COMEX:GC',
            optionExpiryTimeZone: 'America/Chicago',
            optionExpiryHour: 12,
            optionExpiryMinute: 30,
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
            forwardSource: 'bound-futures-quote',
            carrySource: 'exchange-futures-curve',
            carrySemantics: 'metal-futures-curve',
            requiresPerLegForwardBinding: true,
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        SI: {
            family: 'SI',
            strikeIncrement: 0.25,
            calendarId: 'COMEX:SI',
            optionExpiryTimeZone: 'America/Chicago',
            optionExpiryHour: 12,
            optionExpiryMinute: 30,
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
            forwardSource: 'bound-futures-quote',
            carrySource: 'exchange-futures-curve',
            carrySemantics: 'metal-futures-curve',
            requiresPerLegForwardBinding: true,
            priceDisplayDecimals: 3,
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        HG: {
            family: 'HG',
            strikeIncrement: 0.05,
            calendarId: 'COMEX:HG',
            optionExpiryTimeZone: 'America/Chicago',
            optionExpiryHour: 12,
            optionExpiryMinute: 30,
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
            forwardSource: 'bound-futures-quote',
            carrySource: 'exchange-futures-curve',
            carrySemantics: 'commodity-futures-curve',
            requiresPerLegForwardBinding: true,
            priceDisplayDecimals: 5,
            comboPriceIncrement: 0.0005,
            supportsAmortizedMode: false,
            supportsLegacyLiveData: true,
            supportsUnderlyingLegs: true,
            deliverableUnitSingular: 'futures contract',
            deliverableUnitPlural: 'futures contracts',
        },
        SPX: {
            family: 'SPX',
            strikeIncrement: 5,
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
            forwardSource: 'option-put-call-parity',
            carrySource: 'option-put-call-parity-vs-spot',
            carrySemantics: 'equity-index-net-carry',
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
            strikeIncrement: 25,
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
            forwardSource: 'option-put-call-parity',
            carrySource: 'option-put-call-parity-vs-spot',
            carrySemantics: 'equity-index-net-carry',
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

    function _isTradingDate(dateText, calendarKey = 'NYSE') {
        if (typeof globalScope.OptionComboDateUtils !== 'undefined'
            && typeof globalScope.OptionComboDateUtils.isTradingDay === 'function') {
            return globalScope.OptionComboDateUtils.isTradingDay(dateText, calendarKey);
        }

        if (typeof globalScope.isTradingDay === 'function') {
            return globalScope.isTradingDay(dateText, calendarKey);
        }
        return null;
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

    function _nextListedContractMonth(year, month, candidateMonths) {
        const sortedMonths = (candidateMonths || []).slice().sort((a, b) => a - b);
        for (const candidateMonth of sortedMonths) {
            if (candidateMonth >= month) {
                return _toContractMonthValue(year, candidateMonth);
            }
        }
        return _toContractMonthValue(year + 1, sortedMonths[0] || month);
    }

    function _getThirdFridayUtc(year, month) {
        const firstDay = new Date(Date.UTC(year, month - 1, 1));
        const firstWeekday = firstDay.getUTCDay();
        const daysUntilFriday = (5 - firstWeekday + 7) % 7;
        const thirdFridayDay = 1 + daysUntilFriday + 14;
        return new Date(Date.UTC(year, month - 1, thirdFridayDay));
    }

    function _getPreviousTradingDayUtc(date, calendarKey = 'NYSE') {
        let cursor = _addUtcDays(date, -1);
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const tradingDate = _isTradingDate(_formatUtcDate(cursor), calendarKey);
            if (tradingDate === true) return cursor;
            if (tradingDate === null) return null;
            cursor = _addUtcDays(cursor, -1);
        }
        return null;
    }

    function _getSpxStandardMonthlyLastTradingDate(year, month, calendarKey = 'NYSE') {
        let settlementDate = _getThirdFridayUtc(year, month);
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const tradingDate = _isTradingDate(_formatUtcDate(settlementDate), calendarKey);
            if (tradingDate === true) break;
            if (tradingDate === null) return '';
            settlementDate = _addUtcDays(settlementDate, -1);
        }
        const previous = _getPreviousTradingDayUtc(settlementDate, calendarKey);
        return previous ? _formatUtcDate(previous) : '';
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

        if (profile.family === 'ES' || profile.family === 'NQ' || profile.family === 'MES' || profile.family === 'MNQ') {
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

        if (profile.family === 'SI') {
            const targetMonth = _shiftContractMonth(parts.year, parts.month, parts.day > 20 ? 2 : 1);
            const targetParts = {
                year: parseInt(targetMonth.slice(0, 4), 10),
                month: parseInt(targetMonth.slice(4, 6), 10),
            };
            return _nextListedContractMonth(targetParts.year, targetParts.month, [3, 5, 7, 9, 12]);
        }

        return _shiftContractMonth(parts.year, parts.month, 1);
    }

    function resolveTradingClass(symbol, expDate) {
        const profile = resolveUnderlyingProfile(symbol);
        const defaultTradingClass = profile.tradingClass;

        if (!expDate || !defaultTradingClass) {
            return defaultTradingClass;
        }

        if (profile.optionSecType === 'FOP') {
            // Every exchange's weekly futures-option trading classes are
            // listing-specific, not a stable weekday suffix.  The per-family
            // defaults here (E3A, Q3A, ML3, G3T, S3T, H3T) each name one
            // particular weekday-and-week listing, so they are wrong for most
            // expiries: ML3 is a Monday week-3 crude class and rejects a Tuesday
            // 2026-08-04 CL option that IB qualified perfectly well.  Omit the
            // hint and let the qualified IB contract be authoritative.  Index
            // options (SPXW/NDXP) keep theirs — those are real, stable classes.
            return null;
        }

        if (profile.family === 'SPX') {
            const parts = _parseIsoDateParts(expDate);
            if (parts) {
                const standardMonthlyLastTradingDate = _getSpxStandardMonthlyLastTradingDate(
                    parts.year, parts.month, profile.calendarId
                );
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
            tradingClass: resolveTradingClass(symbol, expDate),
        };
    }

    /**
     * AM-settled index contracts can stop trading before their special
     * opening quotation is known. Their payoff is therefore not a
     * deterministic function of the screen underlier at the last-trade
     * cutoff. Keep this contract-family fact separate from the generic expiry
     * clock so projection callers can fail closed instead of drawing a false
     * intrinsic-value line.
     *
     * Qualified tradingClass is required for the futures-option cases:
     * weekly/EOM/quarterly-PM classes intentionally remain eligible.
     */
    function isDeferredSettlementOption(symbol, expDate, contract = null) {
        const profile = resolveUnderlyingProfile(symbol);
        const explicitTradingClass = String(contract && (
            contract.qualifiedOptionTradingClass || contract.tradingClass
        ) || '').trim().toUpperCase();
        const tradingClass = explicitTradingClass || String(resolveTradingClass(symbol, expDate) || '').toUpperCase();
        if (profile.family === 'SPX') return tradingClass === 'SPX';
        return {
            ES: 'ES',
            NQ: 'NQ',
            MES: 'MES',
            MNQ: 'MNQ',
        }[profile.family] === tradingClass;
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

    function resolveForwardCarryPolicy(symbol) {
        const profile = resolveUnderlyingProfile(symbol);
        const reference = profile.carryReference && typeof profile.carryReference === 'object'
            ? { ...profile.carryReference }
            : null;
        return {
            family: profile.family,
            currency: profile.currency,
            pricingInputMode: resolvePricingInputMode(symbol),
            pricingModel: profile.pricingModel,
            discountCurveCurrency: profile.discountCurveCurrency || profile.currency,
            discountCurvePolicy: profile.discountCurvePolicy || 'usd-reference-curve',
            forwardSource: profile.forwardSource || 'spot-bsm',
            carrySource: profile.carrySource || 'not-observed',
            carrySemantics: profile.carrySemantics || 'unknown',
            carryReference: reference,
            requiresPerLegForwardBinding: profile.requiresPerLegForwardBinding === true,
            // Generic stock/ETF BSM retains its explicit q=0 compatibility
            // fallback until an equity parity curve is supplied. INDEX and
            // every FOP family always return false here: their observed
            // Forward/carry must never be replaced by the USD discount rate.
            rateMaySubstituteForCarry: resolvePricingInputMode(symbol) === 'STK'
                && profile.rateMaySubstituteForCarry === true,
        };
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

    function getPriceDisplayDecimals(symbol) {
        const profile = resolveUnderlyingProfile(symbol);
        const parsed = parseInt(profile.priceDisplayDecimals, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
    }

    function getPriceInputStep(symbol) {
        const decimals = getPriceDisplayDecimals(symbol);
        if (decimals <= 0) {
            return '1';
        }
        return `0.${'0'.repeat(Math.max(0, decimals - 1))}1`;
    }

    function getComboPriceIncrement(symbol) {
        const profile = resolveUnderlyingProfile(symbol);
        const parsed = parseFloat(profile.comboPriceIncrement);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.01;
    }

    function formatPriceInputValue(symbol, value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return '';
        }
        return parsed.toFixed(getPriceDisplayDecimals(symbol));
    }

    function formatPriceDisplay(symbol, value, options = {}) {
        const parsed = parseFloat(value);
        const fallback = Object.prototype.hasOwnProperty.call(options, 'fallback')
            ? options.fallback
            : '--';
        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        const decimals = Number.isFinite(parseInt(options.decimals, 10))
            ? parseInt(options.decimals, 10)
            : getPriceDisplayDecimals(symbol);
        const prefix = Object.prototype.hasOwnProperty.call(options, 'prefix')
            ? String(options.prefix ?? '')
            : '$';
        const absFormatted = new Intl.NumberFormat('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        }).format(Math.abs(parsed));
        const sign = parsed < 0 ? '-' : '';
        return `${sign}${prefix}${absFormatted}`;
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
        isDeferredSettlementOption,
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
        resolveForwardCarryPolicy,
        getUnderlyingLegLabel,
        getUnderlyingLegPriceTitle,
        getPriceDisplayDecimals,
        getPriceInputStep,
        getComboPriceIncrement,
        formatPriceInputValue,
        formatPriceDisplay,
        getDeliverableLabel,
    };

    globalScope.OptionComboProductRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
