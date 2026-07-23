/**
 * Calendar Finder -> main simulator handoff.
 *
 * The IV term structure page writes a double-calendar payload into
 * localStorage and opens index.html; the simulator consumes it on startup
 * and materializes one combo group (sell short-expiry straddle, buy
 * long-expiry straddle).
 */
(function (globalScope) {
    'use strict';

    const STORAGE_KEY = 'optionComboCalendarHandoffV2';
    const MAX_AGE_MS = 10 * 60 * 1000;

    function _coercePositiveNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function _normalizeExpiryKey(value) {
        const normalized = String(value || '').trim().replace(/-/g, '');
        return /^\d{8}$/.test(normalized) ? normalized : '';
    }

    function _normalizeContractMonth(value) {
        const normalized = String(value || '').replace(/\D/g, '').slice(0, 6);
        return /^\d{6}$/.test(normalized) ? normalized : '';
    }

    function _requiresFuturesBinding(symbol) {
        const registry = globalScope.OptionComboProductRegistry;
        if (!registry || typeof registry.resolveUnderlyingProfile !== 'function') return false;
        const profile = registry.resolveUnderlyingProfile(symbol);
        return !!(profile && (
            profile.requiresPerLegForwardBinding === true
            || String(profile.optionSecType || '').trim().toUpperCase() === 'FOP'
        ));
    }

    function expiryKeyToDate(expiryKey) {
        const normalized = _normalizeExpiryKey(expiryKey);
        if (!normalized) {
            return '';
        }
        return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
    }

    function _defaultStorage() {
        try {
            return typeof localStorage !== 'undefined' ? localStorage : null;
        } catch (_) {
            return null;
        }
    }

    function buildHandoffPayload(input) {
        const data = input && typeof input === 'object' ? input : {};
        const row = data.row && typeof data.row === 'object' ? data.row : {};
        const symbol = String(data.symbol || '').trim().toUpperCase();
        const shortExpiry = _normalizeExpiryKey(row.shortExpiry);
        const longExpiry = _normalizeExpiryKey(row.longExpiry);
        const shortStrike = _coercePositiveNumber(row.shortAtmStrike);
        const longStrike = _coercePositiveNumber(row.longAtmStrike);
        const underlyingContractMonth = _normalizeContractMonth(data.underlyingContractMonth);
        if (!symbol || !shortExpiry || !longExpiry || shortStrike == null || longStrike == null) {
            return null;
        }
        if (_requiresFuturesBinding(symbol) && !underlyingContractMonth) {
            return null;
        }
        const underlyingQuote = data.underlyingQuote && typeof data.underlyingQuote === 'object'
            ? data.underlyingQuote
            : {};
        const quoteContractMonth = _normalizeContractMonth(underlyingQuote.contractMonth);
        if (underlyingContractMonth && quoteContractMonth
            && underlyingContractMonth !== quoteContractMonth) {
            return null;
        }

        return {
            version: 2,
            createdAt: Date.now(),
            symbol,
            underlyingPrice: _coercePositiveNumber(data.underlyingPrice),
            underlyingContractMonth: underlyingContractMonth || null,
            underlyingFuture: underlyingContractMonth ? {
                contractMonth: underlyingContractMonth,
                conId: Number.isFinite(parseInt(underlyingQuote.conId, 10))
                    ? parseInt(underlyingQuote.conId, 10)
                    : null,
                localSymbol: String(underlyingQuote.localSymbol || '').trim(),
                exchange: String(underlyingQuote.exchange || '').trim(),
                currency: String(underlyingQuote.currency || 'USD').trim().toUpperCase(),
                multiplier: String(underlyingQuote.multiplier || '').trim(),
                quoteAsOf: String(underlyingQuote.quoteAsOf || '').trim(),
                mark: _coercePositiveNumber(underlyingQuote.mark)
                    || _coercePositiveNumber(data.underlyingPrice),
            } : null,
            shortExpiry,
            longExpiry,
            shortStrike,
            longStrike,
            shortCallMark: _coercePositiveNumber(row.shortCallMark),
            shortPutMark: _coercePositiveNumber(row.shortPutMark),
            longCallMark: _coercePositiveNumber(row.longCallMark),
            longPutMark: _coercePositiveNumber(row.longPutMark),
            shortCallIv: _coercePositiveNumber(row.shortCallIv),
            shortPutIv: _coercePositiveNumber(row.shortPutIv),
            longCallIv: _coercePositiveNumber(row.longCallIv),
            longPutIv: _coercePositiveNumber(row.longPutIv),
        };
    }

    function normalizeHandoffPayload(raw, nowMs) {
        const data = raw && typeof raw === 'object' ? raw : null;
        if (!data || ![1, 2].includes(data.version)) {
            return null;
        }
        const createdAt = parseInt(data.createdAt, 10);
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt > MAX_AGE_MS) {
            return null;
        }
        return buildHandoffPayload({
            symbol: data.symbol,
            underlyingPrice: data.underlyingPrice,
            underlyingContractMonth: data.underlyingContractMonth,
            underlyingQuote: data.underlyingFuture,
            row: {
                shortExpiry: data.shortExpiry,
                longExpiry: data.longExpiry,
                shortAtmStrike: data.shortStrike,
                longAtmStrike: data.longStrike,
                shortCallMark: data.shortCallMark,
                shortPutMark: data.shortPutMark,
                longCallMark: data.longCallMark,
                longPutMark: data.longPutMark,
                shortCallIv: data.shortCallIv,
                shortPutIv: data.shortPutIv,
                longCallIv: data.longCallIv,
                longPutIv: data.longPutIv,
            },
        });
    }

    function saveHandoffPayload(payload, storage) {
        const target = storage || _defaultStorage();
        if (!target || !payload) {
            return false;
        }
        try {
            target.setItem(STORAGE_KEY, JSON.stringify(payload));
            return true;
        } catch (_) {
            return false;
        }
    }

    function takeHandoffPayload(storage, nowMs) {
        const target = storage || _defaultStorage();
        if (!target) {
            return null;
        }
        let rawText = null;
        try {
            rawText = target.getItem(STORAGE_KEY);
            if (rawText != null) {
                target.removeItem(STORAGE_KEY);
            }
        } catch (_) {
            return null;
        }
        if (!rawText) {
            return null;
        }
        try {
            return normalizeHandoffPayload(JSON.parse(rawText), nowMs);
        } catch (_) {
            return null;
        }
    }

    function buildGroupName(payload) {
        return `${payload.symbol} Calendar ${payload.shortExpiry}/${payload.longExpiry}`;
    }

    function buildCalendarLegs(payload, generateId, underlyingFutureId = '') {
        const makeLeg = (type, pos, strike, expiryKey, iv, mark) => ({
            id: generateId(),
            type,
            pos,
            strike,
            expDate: expiryKeyToDate(expiryKey),
            iv: iv != null ? iv : 0.2,
            ivSource: 'manual',
            ivManualOverride: false,
            currentPrice: mark != null ? mark : 0.00,
            currentPriceSource: '',
            portfolioMarketPrice: null,
            portfolioMarketPriceSource: '',
            portfolioUnrealizedPnl: null,
            cost: mark != null ? mark : 0.00,
            closePrice: null,
            underlyingFutureId: String(underlyingFutureId || ''),
        });

        return [
            makeLeg('call', -1, payload.shortStrike, payload.shortExpiry, payload.shortCallIv, payload.shortCallMark),
            makeLeg('put', -1, payload.shortStrike, payload.shortExpiry, payload.shortPutIv, payload.shortPutMark),
            makeLeg('call', 1, payload.longStrike, payload.longExpiry, payload.longCallIv, payload.longCallMark),
            makeLeg('put', 1, payload.longStrike, payload.longExpiry, payload.longPutIv, payload.longPutMark),
        ];
    }

    const api = {
        STORAGE_KEY,
        MAX_AGE_MS,
        expiryKeyToDate,
        buildHandoffPayload,
        normalizeHandoffPayload,
        saveHandoffPayload,
        takeHandoffPayload,
        buildGroupName,
        buildCalendarLegs,
    };

    globalScope.OptionComboCalendarHandoff = api;
})(typeof window !== 'undefined' ? window : globalThis);
