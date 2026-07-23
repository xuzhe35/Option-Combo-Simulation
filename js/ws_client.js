/**
 * WebSocket & Live Data Integration
 * ====================================
 * Extracted from app.js for maintainability.
 *
 * Depends on (global):
 *   - state, currencyFormatter, flashElement   (app.js)
 *   - updateDerivedValues                       (app.js)
 */

// -------------------------------------------------------------
// WebSocket Connection (Exponential Backoff)
// -------------------------------------------------------------

let ws = null;
let isWsConnected = false;

const DEFAULT_WS_HOST = '127.0.0.1';
const DEFAULT_WS_PORT = 8765;
const WS_HOST_STORAGE_KEY = 'optionComboWsHost';
const WS_PORT_STORAGE_KEY = 'optionComboWsPort';

// Exponential backoff state
const WS_BASE_DELAY = 5000;   // 5s initial
const WS_MAX_DELAY = 60000;   // 60s cap
const DISCOUNT_CURVE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LIVE_PROJECTION_FEED_TIMEOUT_MS = 120 * 1000;
const LIVE_PROJECTION_FEED_WATCHDOG_INTERVAL_MS = 5 * 1000;
const MAX_LIVE_FUTURE_QUOTE_AGE_SECONDS = 120;
const MAX_LIVE_FUTURE_QUOTE_SKEW_SECONDS = 120;
let _wsReconnectDelay = WS_BASE_DELAY;
let _wsReconnectTimer = null;
let _discountCurveRefreshTimer = null;
let _liveProjectionFeedWatchdogTimer = null;
let _legacyLiveDataWarningShown = false;
let _historicalReplayOrderCounter = 900000;
let _futureSubscriptionGeneration = 0;
let _lastLiveSubscriptionSignature = '';
let _lastLiveSubscriptionSocket = null;
let _ibMarketDataGeneration = null;
let _ibMarketDataState = '';
let _lastIbRecoveryReplayGeneration = null;
let _lastIbRecoveryReplaySocket = null;
let _automaticReplayBlockedGeneration = null;
let _ibServerSessionId = '';
let _automaticLiveSubscriptionSocket = null;
let _automaticLiveSubscriptionAllowed = false;
const _liveQuoteRuntime = {
    underlyingQuote: null,
    optionQuotesById: new Map(),
    futureQuotesById: new Map(),
    stockQuotesBySymbol: new Map(),
    carryReferenceQuotesById: new Map(),
    // Subscription pool: canonical subscription id -> other request ids that
    // resolve to the same option contract and share its market data line.
    optionQuoteAliasesByCanonicalId: new Map(),
    // Exact request identity for every canonical/alias id. Live option quotes
    // must prove that IB qualified this contract before they may update a leg.
    optionRequestIdentityById: new Map(),
    rejectedOptionIdentityWarnings: new Set(),
    // Opaque futures subscription ids are generation-scoped.  Since the
    // backend returns the id unchanged, a delayed response from an older
    // subscribe cycle cannot update the current Futures Pool entry.
    futureRequestIdentityByWireId: new Map(),
    rejectedFutureIdentityWarnings: new Set(),
};
const _liveQuotePricingSnapshotFields = [
    'bid', 'ask', 'mark', 'iv', 'bidPresent', 'askPresent',
    'bidAskValid', 'bidAskStatus', 'markSource',
];
const _liveQuoteSnapshotFields = [
    'bid', 'ask', 'mark', 'iv', 'delta', 'quoteAsOf', 'snapshotId',
    'conId', 'secType', 'symbol', 'localSymbol', 'exchange', 'currency',
    'multiplier', 'contractMonth', 'contractMonthSource',
    'lastTradeDate', 'markSource',
    'tradingClass', 'right', 'strike', 'optionExpiry', 'underConId',
    'underlyingContractMonth', 'underlyingBindingVerified',
    'expiryAsOf', 'expiryTimingSource', 'lastTradeTime', 'timeZoneId',
    'realExpirationDate', 'contractIdentitySource',
    'requestIdentityVerified', 'requestGeneration', 'requestId',
    'requestedSecType', 'requestedSymbol', 'requestedExchange',
    'requestedCurrency', 'requestedMultiplier', 'requestedContractMonth',
    'bidPresent', 'askPresent', 'bidAskValid', 'bidAskStatus',
];
const _liveQuoteEvidenceFields = [
    'quoteAsOf', 'snapshotId', 'conId', 'localSymbol', 'tradingClass',
    'right', 'strike', 'optionExpiry', 'underConId',
    'underlyingContractMonth', 'underlyingBindingVerified',
    'expiryAsOf', 'expiryTimingSource', 'lastTradeDate', 'lastTradeTime',
    'timeZoneId', 'realExpirationDate', 'contractIdentitySource',
];

/**
 * @typedef {Object} OptionComboLiveQuoteSnapshot
 * @property {number=} bid
 * @property {number=} ask
 * @property {number=} mark
 * @property {number=} iv
 * @property {number=} delta
 */

/**
 * @typedef {Object} OptionComboLiveQuoteChangeSet
 * @property {string[]=} groupIds
 * @property {string[]=} hedgeIds
 * @property {string[]=} deltaGroupIds
 */

/**
 * @typedef {Object} OptionComboDeltaHedgeTransportApi
 * @property {(recommendation: object, options?: object) => boolean} requestBrokerPreview
 * @property {(recommendation: object, options?: object) => boolean} requestSubmit
 * @property {(options?: object) => boolean} requestCancel
 */

function _areGreeksEnabled() {
    return !!(state && state.greeksEnabled === true);
}

function _getProductRegistryApi() {
    return window.OptionComboProductRegistry && typeof window.OptionComboProductRegistry === 'object'
        ? window.OptionComboProductRegistry
        : null;
}

function _getControlPanelUiApi() {
    return window.OptionComboControlPanelUI && typeof window.OptionComboControlPanelUI === 'object'
        ? window.OptionComboControlPanelUI
        : null;
}

function _getSessionLogicApi() {
    return window.OptionComboSessionLogic && typeof window.OptionComboSessionLogic === 'object'
        ? window.OptionComboSessionLogic
        : null;
}

function _getDateUtilsApi() {
    return window.OptionComboDateUtils && typeof window.OptionComboDateUtils === 'object'
        ? window.OptionComboDateUtils
        : null;
}

function _getPricingContextApi() {
    return window.OptionComboPricingContext && typeof window.OptionComboPricingContext === 'object'
        ? window.OptionComboPricingContext
        : null;
}

function _getDeltaHedgeLogicApi() {
    return window.OptionComboDeltaHedgeLogic && typeof window.OptionComboDeltaHedgeLogic === 'object'
        ? window.OptionComboDeltaHedgeLogic
        : null;
}

function _getDeltaHedgeUiApi() {
    return window.OptionComboDeltaHedgeUI && typeof window.OptionComboDeltaHedgeUI === 'object'
        ? window.OptionComboDeltaHedgeUI
        : null;
}

function _getDeltaHedgeTransportFactory() {
    return window.OptionComboDeltaHedgeTransport && typeof window.OptionComboDeltaHedgeTransport === 'object'
        ? window.OptionComboDeltaHedgeTransport
        : null;
}

function _getComboOrderTransportFactory() {
    return window.OptionComboComboOrderTransport && typeof window.OptionComboComboOrderTransport === 'object'
        ? window.OptionComboComboOrderTransport
        : null;
}

function _getIndexForwardRateApi() {
    return window.OptionComboIndexForwardRate && typeof window.OptionComboIndexForwardRate === 'object'
        ? window.OptionComboIndexForwardRate
        : null;
}

function _getGroupOrderBuilderApi() {
    return window.OptionComboGroupOrderBuilder && typeof window.OptionComboGroupOrderBuilder === 'object'
        ? window.OptionComboGroupOrderBuilder
        : null;
}

function _getTradeTriggerLogicApi() {
    return window.OptionComboTradeTriggerLogic && typeof window.OptionComboTradeTriggerLogic === 'object'
        ? window.OptionComboTradeTriggerLogic
        : null;
}

function _getGroupEditorUiApi() {
    return window.OptionComboGroupEditorUI && typeof window.OptionComboGroupEditorUI === 'object'
        ? window.OptionComboGroupEditorUI
        : null;
}

function _getPricingCoreApi() {
    return window.OptionComboPricingCore && typeof window.OptionComboPricingCore === 'object'
        ? window.OptionComboPricingCore
        : null;
}

function _getMarketCurvesApi() {
    return window.OptionComboMarketCurves && typeof window.OptionComboMarketCurves === 'object'
        ? window.OptionComboMarketCurves
        : null;
}

function _runUiRefreshSafely(label, callback) {
    try {
        return callback();
    } catch (error) {
        console.error(`UI refresh failed (${label}):`, error);
        return undefined;
    }
}

/** @returns {OptionComboLiveQuoteSnapshot | null} */
function _cloneLiveQuoteSnapshot(rawQuote) {
    if (!rawQuote || typeof rawQuote !== 'object') {
        return null;
    }

    const snapshot = {};
    ['bid', 'ask', 'mark'].forEach((field) => {
        const parsed = parseFloat(rawQuote[field]);
        if (Number.isFinite(parsed) && parsed >= 0) {
            snapshot[field] = parsed;
        }
    });
    const iv = parseFloat(rawQuote.iv);
    if (Number.isFinite(iv) && iv > 0) snapshot.iv = iv;
    ['bidPresent', 'askPresent', 'bidAskValid'].forEach((field) => {
        if (typeof rawQuote[field] === 'boolean') snapshot[field] = rawQuote[field];
    });
    if (typeof rawQuote.underlyingBindingVerified === 'boolean') {
        snapshot.underlyingBindingVerified = rawQuote.underlyingBindingVerified;
    }
    if (typeof rawQuote.requestIdentityVerified === 'boolean') {
        snapshot.requestIdentityVerified = rawQuote.requestIdentityVerified;
    }
    const delta = parseFloat(rawQuote.delta);
    if (_areGreeksEnabled() && Number.isFinite(delta)) {
        snapshot.delta = delta;
    }
    const quoteAsOf = String(rawQuote.quoteAsOf || '').trim();
    if (quoteAsOf && Number.isFinite(Date.parse(quoteAsOf))) {
        snapshot.quoteAsOf = new Date(quoteAsOf).toISOString();
    }
    const expiryAsOf = String(rawQuote.expiryAsOf || '').trim();
    if (expiryAsOf && Number.isFinite(Date.parse(expiryAsOf))) {
        snapshot.expiryAsOf = new Date(expiryAsOf).toISOString();
    }
    const snapshotId = String(rawQuote.snapshotId || '').trim();
    if (snapshotId) snapshot.snapshotId = snapshotId;
    const conId = parseInt(rawQuote.conId, 10);
    if (Number.isFinite(conId) && conId > 0) snapshot.conId = conId;
    const underConId = parseInt(rawQuote.underConId, 10);
    if (Number.isFinite(underConId) && underConId > 0) snapshot.underConId = underConId;
    const requestGeneration = parseInt(rawQuote.requestGeneration, 10);
    if (Number.isFinite(requestGeneration) && requestGeneration > 0) {
        snapshot.requestGeneration = requestGeneration;
    }
    const strike = parseFloat(rawQuote.strike);
    if (Number.isFinite(strike) && strike >= 0) snapshot.strike = strike;
    [
        'secType', 'symbol', 'localSymbol', 'exchange', 'currency',
        'multiplier', 'contractMonth', 'contractMonthSource',
        'lastTradeDate', 'markSource', 'bidAskStatus',
        'tradingClass', 'right', 'optionExpiry', 'underlyingContractMonth',
        'expiryTimingSource', 'lastTradeTime', 'timeZoneId',
        'realExpirationDate', 'contractIdentitySource',
        'requestId', 'requestedSecType', 'requestedSymbol',
        'requestedExchange', 'requestedCurrency', 'requestedMultiplier',
        'requestedContractMonth',
    ].forEach((field) => {
        const value = String(rawQuote[field] || '').trim();
        if (value) snapshot[field] = value;
    });

    return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function _areLiveQuoteSnapshotsEqual(left, right) {
    if (left === right) {
        return true;
    }
    if (!left || !right) {
        return left === right;
    }
    return _liveQuoteSnapshotFields.every((field) => {
        const leftHasField = Object.prototype.hasOwnProperty.call(left, field);
        const rightHasField = Object.prototype.hasOwnProperty.call(right, field);
        return leftHasField === rightHasField
            && (!leftHasField || left[field] === right[field]);
    });
}

function _didLiveQuoteFieldChange(left, right, field) {
    const leftHasField = !!(left && Object.prototype.hasOwnProperty.call(left, field));
    const rightHasField = !!(right && Object.prototype.hasOwnProperty.call(right, field));
    return leftHasField !== rightHasField
        || (leftHasField && left[field] !== right[field]);
}

function _resetLiveQuoteRuntime() {
    _liveQuoteRuntime.underlyingQuote = null;
    _liveQuoteRuntime.optionQuotesById.clear();
    _liveQuoteRuntime.futureQuotesById.clear();
    _liveQuoteRuntime.stockQuotesBySymbol.clear();
    _liveQuoteRuntime.carryReferenceQuotesById.clear();
    _liveQuoteRuntime.optionQuoteAliasesByCanonicalId.clear();
    _liveQuoteRuntime.optionRequestIdentityById.clear();
    _liveQuoteRuntime.rejectedOptionIdentityWarnings.clear();
    _liveQuoteRuntime.futureRequestIdentityByWireId.clear();
    _liveQuoteRuntime.rejectedFutureIdentityWarnings.clear();
}

function _normalizeContractMonthIdentity(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 6 ? digits.slice(0, 6) : '';
}

function _normalizeOptionExpiryIdentity(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 8 ? digits.slice(0, 8) : '';
}

function _canonicalOptionIdentitySymbol(value) {
    const symbol = String(value || '').trim().toUpperCase();
    return ({ SPXW: 'SPX', NDXP: 'NDX' })[symbol] || symbol;
}

function _findExpectedUnderlyingConId(contractMonth) {
    const normalizedMonth = _normalizeContractMonthIdentity(contractMonth);
    if (!normalizedMonth) return null;
    // Matching on the requested contractMonth alone would assert a conId IB
    // never confirmed for that month.  Editing a pool entry's month leaves the
    // previous month's conId in place, so the old value would be handed to the
    // option gate as the expected underConId and reject every leg in the book.
    // Reuse the same evidence _buildFutureRequestIdentity requires; without it
    // return null so the gate simply does not assert a conId (the
    // underlyingContractMonth and underlyingBindingVerified checks still run).
    const entry = (state.futuresPool || []).find(candidate => (
        candidate
        && candidate.liveQuoteIdentityStatus === 'verified'
        && candidate.requestIdentityVerified === true
        && String(candidate.secType || '').trim().toUpperCase() === 'FUT'
        && _normalizeContractMonthIdentity(candidate.qualifiedContractMonth) === normalizedMonth
        && _normalizeContractMonthIdentity(candidate.contractMonth) === normalizedMonth
    ));
    const conId = parseInt(entry && entry.conId, 10);
    return Number.isFinite(conId) && conId > 0 ? conId : null;
}

function _buildOptionRequestIdentity(request) {
    const secType = String(request && request.secType || '').trim().toUpperCase();
    const underlyingContractMonth = _normalizeContractMonthIdentity(
        request && request.underlyingContractMonth
    );
    return {
        secType,
        symbol: String(request && request.symbol || '').trim().toUpperCase(),
        right: String(request && request.right || '').trim().toUpperCase(),
        strike: parseFloat(request && request.strike),
        expDate: _normalizeOptionExpiryIdentity(
            request && (request.expDate || request.contractMonth)
        ),
        tradingClass: String(request && request.tradingClass || '').trim().toUpperCase(),
        multiplier: String(request && request.multiplier || '').trim(),
        underlyingContractMonth,
        underConId: secType === 'FOP'
            ? _findExpectedUnderlyingConId(underlyingContractMonth)
            : null,
    };
}

function _buildOptionContractSignature(request) {
    return [
        request.secType || '',
        request.symbol || '',
        request.right || '',
        parseFloat(request.strike),
        request.expDate || '',
        request.contractMonth || '',
        _normalizeContractMonthIdentity(request.underlyingContractMonth),
        request.tradingClass || '',
        request.exchange || '',
        request.currency || '',
        String(request.multiplier || ''),
    ].join('|');
}

// One market data line per unique contract: the first request for a contract
// becomes the canonical subscription, later ids become aliases that are fed
// from the canonical quote when data arrives.
function _dedupeOptionRequestsForSubscription(optionRequests) {
    const canonicalBySignature = new Map();
    const deduped = [];
    _liveQuoteRuntime.optionQuoteAliasesByCanonicalId.clear();
    _liveQuoteRuntime.optionRequestIdentityById.clear();
    (Array.isArray(optionRequests) ? optionRequests : []).forEach((request) => {
        if (!request || !request.id) {
            return;
        }
        _liveQuoteRuntime.optionRequestIdentityById.set(
            request.id,
            _buildOptionRequestIdentity(request)
        );
        const signature = _buildOptionContractSignature(request);
        const canonical = canonicalBySignature.get(signature);
        if (!canonical) {
            canonicalBySignature.set(signature, request);
            deduped.push(request);
            return;
        }
        if (request.id === canonical.id) {
            return;
        }
        let aliasIds = _liveQuoteRuntime.optionQuoteAliasesByCanonicalId.get(canonical.id);
        if (!aliasIds) {
            aliasIds = [];
            _liveQuoteRuntime.optionQuoteAliasesByCanonicalId.set(canonical.id, aliasIds);
        }
        if (!aliasIds.includes(request.id)) {
            aliasIds.push(request.id);
        }
    });
    return deduped;
}

function _expandOptionQuoteAliases(options) {
    if (!options || typeof options !== 'object') {
        return;
    }
    _liveQuoteRuntime.optionQuoteAliasesByCanonicalId.forEach((aliasIds, canonicalId) => {
        const quote = options[canonicalId];
        if (quote === undefined) {
            return;
        }
        aliasIds.forEach((aliasId) => {
            if (options[aliasId] === undefined) {
                options[aliasId] = quote;
            }
        });
    });
}

function _optionQuoteIdentityMismatchReason(subId, rawQuote) {
    const expected = _liveQuoteRuntime.optionRequestIdentityById.get(subId);
    // Historical replay and isolated callers do not create live subscription
    // identities. Preserve those paths; live subscriptions below are strict.
    if (!expected) return '';

    const actual = _cloneLiveQuoteSnapshot(rawQuote);
    if (!actual) return 'missing qualified contract identity';
    if (!(actual.conId > 0)) return 'missing qualified option conId';
    if (!String(actual.localSymbol || '').trim()) return 'missing qualified option localSymbol';

    const actualSecType = String(actual.secType || '').trim().toUpperCase();
    const actualSymbol = String(actual.symbol || '').trim().toUpperCase();
    const actualRight = String(actual.right || '').trim().toUpperCase();
    const actualExpiry = _normalizeOptionExpiryIdentity(actual.optionExpiry);
    const actualTradingClass = String(actual.tradingClass || '').trim().toUpperCase();
    if (!actualSecType || actualSecType !== expected.secType) return 'secType mismatch';
    const symbolMatches = _canonicalOptionIdentitySymbol(actualSymbol)
        === _canonicalOptionIdentitySymbol(expected.symbol);
    if (!actualSymbol || !symbolMatches) return 'symbol mismatch';
    if (!actualRight || actualRight !== expected.right) return 'right mismatch';
    if (!Number.isFinite(actual.strike)
        || !Number.isFinite(expected.strike)
        || Math.abs(actual.strike - expected.strike) > 0.000001) {
        return 'strike mismatch';
    }
    if (!actualExpiry || actualExpiry !== expected.expDate) return 'expiry mismatch';
    if (expected.multiplier
        && String(actual.multiplier || '').trim() !== expected.multiplier) {
        return 'multiplier mismatch';
    }
    if (expected.tradingClass
        && (!actualTradingClass || actualTradingClass !== expected.tradingClass)) {
        return 'tradingClass mismatch';
    }

    if (expected.secType === 'FOP') {
        const actualMonth = _normalizeContractMonthIdentity(actual.underlyingContractMonth);
        if (!expected.underlyingContractMonth) return 'missing requested underlying futures month';
        if (actual.underlyingBindingVerified !== true
            || !(actual.underConId > 0)
            || !actualMonth) {
            return 'missing verified underlying futures binding';
        }
        if (actualMonth !== expected.underlyingContractMonth) {
            return 'underlying futures month mismatch';
        }
        if (expected.underConId && actual.underConId !== expected.underConId) {
            return 'underlying futures conId mismatch';
        }
    }
    return '';
}

function _filterLiveOptionQuotesByRequestIdentity(options) {
    if (!options || typeof options !== 'object') {
        return { accepted: options, rejected: new Map() };
    }
    const accepted = {};
    const rejected = new Map();
    Object.entries(options).forEach(([subId, quote]) => {
        const mismatchReason = _optionQuoteIdentityMismatchReason(subId, quote);
        if (!mismatchReason) {
            accepted[subId] = quote;
            return;
        }
        rejected.set(subId, mismatchReason);
        const warningKey = `${subId}|${mismatchReason}`;
        if (!_liveQuoteRuntime.rejectedOptionIdentityWarnings.has(warningKey)) {
            _liveQuoteRuntime.rejectedOptionIdentityWarnings.add(warningKey);
            console.warn(`Ignored live option quote for ${subId}: ${mismatchReason}.`);
        }
    });
    return { accepted, rejected };
}

function _invalidateRejectedLiveOptionQuote(subId, reason, changedGroupIds) {
    const hadCachedQuote = _liveQuoteRuntime.optionQuotesById.has(subId);
    _liveQuoteRuntime.optionQuotesById.delete(subId);
    let changed = hadCachedQuote;
    (state.groups || []).forEach((group) => {
        (group.legs || []).forEach((leg) => {
            if (!leg || leg.id !== subId) return;
            const hadAcceptedLiveQuote = hadCachedQuote
                || leg.currentPriceSource === 'live'
                || leg.liveQuoteIdentityStatus === 'verified';
            [
                'expiryAsOf', 'expiryTimingSource', 'lastTradeDate', 'lastTradeTime',
                'expiryTimeZoneId', 'realExpirationDate', 'qualifiedOptionConId',
                'qualifiedOptionLocalSymbol', 'qualifiedOptionTradingClass',
                'qualifiedOptionUnderConId', 'qualifiedOptionUnderlyingContractMonth',
            ].forEach((key) => {
                if (Object.prototype.hasOwnProperty.call(leg, key)) {
                    delete leg[key];
                    changed = true;
                }
            });
            if (hadAcceptedLiveQuote) {
                if (leg.currentPrice !== null) {
                    leg.currentPrice = null;
                    changed = true;
                }
                changed = _markOptionQuoteMissing(leg) || changed;
            }
            if (leg.liveQuoteIdentityStatus !== 'rejected') {
                leg.liveQuoteIdentityStatus = 'rejected';
                changed = true;
            }
            if (leg.liveQuoteIdentityReason !== reason) {
                leg.liveQuoteIdentityReason = reason;
                changed = true;
            }
            if (changed && changedGroupIds instanceof Set && group && group.id) {
                changedGroupIds.add(group.id);
            }
        });
    });
    return changed;
}

function _applyLiveOptionContractIdentity(leg, quote) {
    if (!leg || !quote || typeof quote !== 'object') return false;
    const identity = _cloneLiveQuoteSnapshot(quote);
    if (!identity) return false;
    const next = {
        qualifiedOptionConId: identity.conId || null,
        qualifiedOptionLocalSymbol: String(identity.localSymbol || ''),
        qualifiedOptionTradingClass: String(identity.tradingClass || ''),
        qualifiedOptionUnderConId: identity.underConId || null,
        qualifiedOptionUnderlyingContractMonth: _normalizeContractMonthIdentity(
            identity.underlyingContractMonth
        ),
        liveQuoteIdentityStatus: 'verified',
        liveQuoteIdentityReason: '',
    };
    let changed = false;
    Object.entries(next).forEach(([key, value]) => {
        if (leg[key] !== value) {
            leg[key] = value;
            changed = true;
        }
    });
    return changed;
}

function _setUnderlyingQuoteSnapshot(rawQuote) {
    const nextSnapshot = _cloneLiveQuoteSnapshot(rawQuote);
    const changed = !_areLiveQuoteSnapshotsEqual(_liveQuoteRuntime.underlyingQuote, nextSnapshot);
    _liveQuoteRuntime.underlyingQuote = nextSnapshot;
    return changed;
}

function _setOptionQuoteSnapshot(subId, rawQuote) {
    if (!subId) {
        return {
            changed: false,
            pricingChanged: false,
            deltaChanged: false,
        };
    }
    const snapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (!snapshot) {
        return {
            changed: false,
            pricingChanged: false,
            deltaChanged: false,
        };
    }
    const previousSnapshot = _liveQuoteRuntime.optionQuotesById.get(subId) || null;
    const pricingChanged = _liveQuotePricingSnapshotFields.some((field) => (
        _didLiveQuoteFieldChange(previousSnapshot, snapshot, field)
    ));
    const deltaChanged = _didLiveQuoteFieldChange(previousSnapshot, snapshot, 'delta');
    const evidenceChanged = _liveQuoteEvidenceFields.some((field) => (
        _didLiveQuoteFieldChange(previousSnapshot, snapshot, field)
    ));
    if (!pricingChanged && !deltaChanged && !evidenceChanged) {
        return {
            changed: false,
            pricingChanged: false,
            deltaChanged: false,
        };
    }
    _liveQuoteRuntime.optionQuotesById.set(subId, snapshot);
    return {
        changed: true,
        pricingChanged,
        deltaChanged,
    };
}

function _setFutureQuoteSnapshot(subId, rawQuote) {
    if (!subId) return false;
    const snapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (!snapshot) return false;
    const previousSnapshot = _liveQuoteRuntime.futureQuotesById.get(subId) || null;
    const changed = !_areLiveQuoteSnapshotsEqual(previousSnapshot, snapshot);
    _liveQuoteRuntime.futureQuotesById.set(subId, snapshot);
    return changed;
}

function _setStockQuoteSnapshot(symbol, rawQuote) {
    if (!symbol) return false;
    const snapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (!snapshot) return false;
    const previousSnapshot = _liveQuoteRuntime.stockQuotesBySymbol.get(symbol) || null;
    const changed = !_areLiveQuoteSnapshotsEqual(previousSnapshot, snapshot);
    _liveQuoteRuntime.stockQuotesBySymbol.set(symbol, snapshot);
    return changed;
}

function _setCarryReferenceQuoteSnapshot(referenceId, rawQuote) {
    if (!referenceId) return false;
    const snapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (!snapshot) return false;
    const previousSnapshot = _liveQuoteRuntime.carryReferenceQuotesById.get(referenceId) || null;
    const changed = !_areLiveQuoteSnapshotsEqual(previousSnapshot, snapshot);
    _liveQuoteRuntime.carryReferenceQuotesById.set(referenceId, snapshot);
    return changed;
}

function _formatSymbolPriceInputValue(symbol, value) {
    const registry = _getProductRegistryApi();
    if (registry && typeof registry.formatPriceInputValue === 'function') {
        return registry.formatPriceInputValue(symbol, value);
    }
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed.toFixed(2) : '';
}

function _formatSymbolPriceDisplay(symbol, value) {
    const registry = _getProductRegistryApi();
    if (registry && typeof registry.formatPriceDisplay === 'function') {
        return registry.formatPriceDisplay(symbol, value);
    }
    return currencyFormatter.format(value);
}

function _refreshForwardRatePanelUi() {
    const controlPanelUi = _getControlPanelUiApi();
    if (!controlPanelUi) {
        return;
    }
    if (typeof controlPanelUi.refreshForwardRatePanel === 'function') {
        _runUiRefreshSafely('forwardRatePanel', () => {
            controlPanelUi.refreshForwardRatePanel();
        });
        return;
    }
    if (typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
        _runUiRefreshSafely('boundDynamicControls', () => {
            controlPanelUi.refreshBoundDynamicControls();
        });
    }
}

function _refreshIndexForwardRateSamples() {
    const indexForwardRateApi = _getIndexForwardRateApi();
    if (!indexForwardRateApi
        || typeof indexForwardRateApi.refreshForwardRateSample !== 'function') {
        return false;
    }
    let changed = false;
    const quoteSource = {
        getOptionQuote: getLiveOptionQuote,
        getUnderlyingQuote,
    };
    (state.forwardRateSamples || []).forEach((sample) => {
        const result = indexForwardRateApi.refreshForwardRateSample(
            sample,
            state,
            quoteSource
        );
        changed = !!(result && result.changed) || changed;
    });
    return changed;
}

function _invalidateIndexForwardRateSamples(reason) {
    const indexForwardRateApi = _getIndexForwardRateApi();
    if (!indexForwardRateApi
        || typeof indexForwardRateApi.invalidateForwardRateSample !== 'function') {
        return false;
    }
    let changed = false;
    (state.forwardRateSamples || []).forEach((sample) => {
        changed = indexForwardRateApi.invalidateForwardRateSample(sample, reason) || changed;
    });
    return changed;
}

function _refreshFuturesPoolPanelUi() {
    const controlPanelUi = _getControlPanelUiApi();
    if (!controlPanelUi) {
        return;
    }
    if (typeof controlPanelUi.refreshFuturesPoolPanel === 'function') {
        _runUiRefreshSafely('futuresPoolPanel', () => {
            controlPanelUi.refreshFuturesPoolPanel();
        });
        return;
    }
    if (typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
        _runUiRefreshSafely('boundDynamicControls', () => {
            controlPanelUi.refreshBoundDynamicControls();
        });
    }
}

function _isUsableDiscountCurve(curve) {
    return !!(curve
        && typeof curve === 'object'
        && curve.kind === 'discount'
        && Array.isArray(curve.points)
        && curve.points.length > 0);
}

function _discountCurveFingerprint(curve) {
    if (!_isUsableDiscountCurve(curve)) return '';
    const pointFingerprint = curve.points.map((point) => [
        Number(point && point.tenorDays),
        Number(point && point.zeroRate),
        Number(point && point.discountFactor),
    ].join(':')).join('|');
    return [
        String(curve.id || ''),
        String(curve.asOf || ''),
        String(curve.effectiveDate || ''),
        String(curve.metadata && curve.metadata.source || ''),
        String(curve.metadata && curve.metadata.snapshotId || ''),
        pointFingerprint,
    ].join('::');
}

function _refreshDiscountCurveConsumers(scheduleDerivedRefresh = false) {
    const controlPanelUi = _getControlPanelUiApi();
    if (controlPanelUi && typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
        _runUiRefreshSafely('discountCurveControls', () => {
            controlPanelUi.refreshBoundDynamicControls();
        });
    } else {
        _refreshForwardRatePanelUi();
    }
    if (scheduleDerivedRefresh) {
        _scheduleDerivedValueRefresh({}, false);
    }
}

function _createDiscountCurveFromSnapshot(snapshot, options = {}) {
    const marketCurves = _getMarketCurvesApi();
    if (!marketCurves) {
        throw new Error('Market curve runtime is unavailable.');
    }
    const adapter = typeof marketCurves.createDiscountCurveFromSnapshot === 'function'
        ? marketCurves.createDiscountCurveFromSnapshot
        : marketCurves.createDiscountCurveFromTreasurySnapshot;
    if (typeof adapter !== 'function') {
        throw new Error('Discount-curve snapshot adapter is unavailable.');
    }
    return adapter(snapshot, {
        maxExtrapolationDays: 31,
        ...options,
    });
}

function _handleDiscountCurveMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'discount_curve_snapshot') {
        return false;
    }

    const requestWasManual = state.discountCurveRequestManual === true;
    state.discountCurveRequestPending = false;
    state.discountCurveRequestManual = false;
    state.discountCurveLastResponseStatus = String(data.status || '').trim();
    const previousCurve = _isUsableDiscountCurve(state.discountCurve)
        ? state.discountCurve
        : null;
    const previousFingerprint = _discountCurveFingerprint(previousCurve);
    let nextCurve = null;
    let errorMessage = String(data.error || '').trim();

    if (data.curve && typeof data.curve === 'object') {
        try {
            nextCurve = _createDiscountCurveFromSnapshot(data.curve);
        } catch (error) {
            errorMessage = error && error.message
                ? `Invalid discount curve: ${error.message}`
                : 'Invalid discount curve response.';
        }
    } else if (!errorMessage) {
        errorMessage = 'No unified discount curve is available; the manual-rate fallback remains active.';
    }

    if (_isUsableDiscountCurve(nextCurve)) {
        state.discountCurve = nextCurve;
        state.discountCurveLastLoadedAt = new Date().toISOString();
        state.discountCurveLastLoadWasManual = requestWasManual;
    } else if (!previousCurve) {
        state.discountCurve = null;
        state.discountCurveLastLoadWasManual = false;
    }
    state.discountCurveLastError = errorMessage;

    const nextFingerprint = _discountCurveFingerprint(state.discountCurve);
    const curveChanged = nextFingerprint !== previousFingerprint;
    const forwardRateChanged = curveChanged && (state.forwardRateSamples || []).length > 0
        ? _refreshIndexForwardRateSamples()
        : false;
    _refreshDiscountCurveConsumers(curveChanged || forwardRateChanged);
    return true;
}

function _normalizeLivePriceMode(group) {
    const sessionLogic = _getSessionLogicApi();
    if (sessionLogic && typeof sessionLogic.normalizeGroupLivePriceMode === 'function') {
        return sessionLogic.normalizeGroupLivePriceMode(group && group.livePriceMode);
    }
    return String(group && group.livePriceMode || '').trim().toLowerCase() === 'mark'
        ? 'mark'
        : 'midpoint';
}

function _addAllGroupIds(targetSet) {
    (state.groups || []).forEach((group) => {
        if (group && group.id) {
            targetSet.add(group.id);
        }
    });
}

function _addGroupsAffectedByOptionQuoteIds(targetSet, optionQuoteIds) {
    if (!(targetSet instanceof Set) || !Array.isArray(optionQuoteIds) || optionQuoteIds.length === 0) {
        return;
    }

    const quoteIdSet = new Set(optionQuoteIds.filter(Boolean));
    if (quoteIdSet.size === 0) {
        return;
    }

    (state.groups || []).forEach((group) => {
        if ((group && group.legs || []).some(leg => quoteIdSet.has(leg && leg.id))) {
            targetSet.add(group.id);
        }
    });
}

function _addGroupsAffectedByUnderlyingMidpoint(targetSet) {
    if (!(targetSet instanceof Set)) {
        return;
    }

    (state.groups || []).forEach((group) => {
        if (_normalizeLivePriceMode(group) !== 'midpoint') {
            return;
        }
        if ((group && group.legs || []).some(leg => _isUnderlyingLeg(leg))) {
            targetSet.add(group.id);
        }
    });
}

function _scheduleDerivedValueRefresh(changeSet, allowIncrementalUpdate) {
    if (renderScheduled) {
        return;
    }

    renderScheduled = true;
    const runRefresh = () => {
        try {
            const groupIds = Array.isArray(changeSet && changeSet.groupIds) ? changeSet.groupIds.filter(Boolean) : [];
            const hedgeIds = Array.isArray(changeSet && changeSet.hedgeIds) ? changeSet.hedgeIds.filter(Boolean) : [];
            const deltaGroupIds = Array.isArray(changeSet && changeSet.deltaGroupIds) ? changeSet.deltaGroupIds.filter(Boolean) : [];
            const hasIncrementalTargets = groupIds.length > 0 || hedgeIds.length > 0;
            const standaloneDeltaGroupIds = deltaGroupIds.filter((groupId) => !groupIds.includes(groupId));
            const appRuntime = typeof window !== 'undefined' && window.__optionComboApp && typeof window.__optionComboApp === 'object'
                ? window.__optionComboApp
                : null;
            const incrementalUpdater = typeof updateLiveQuoteDerivedValues === 'function'
                ? updateLiveQuoteDerivedValues
                : (appRuntime && typeof appRuntime.updateLiveQuoteDerivedValues === 'function'
                    ? appRuntime.updateLiveQuoteDerivedValues
                    : null);
            const deltaUpdater = typeof updateLiveQuoteGroupDeltaValues === 'function'
                ? updateLiveQuoteGroupDeltaValues
                : (appRuntime && typeof appRuntime.updateLiveQuoteGroupDeltaValues === 'function'
                    ? appRuntime.updateLiveQuoteGroupDeltaValues
                    : null);

            if (allowIncrementalUpdate && hasIncrementalTargets && typeof incrementalUpdater === 'function') {
                incrementalUpdater({
                    groupIds,
                    hedgeIds,
                });
                if (standaloneDeltaGroupIds.length > 0 && typeof deltaUpdater === 'function') {
                    deltaUpdater({
                        groupIds: standaloneDeltaGroupIds,
                    });
                }
                return;
            }

            if (allowIncrementalUpdate
                && !hasIncrementalTargets
                && standaloneDeltaGroupIds.length > 0
                && typeof deltaUpdater === 'function') {
                deltaUpdater({
                    groupIds: standaloneDeltaGroupIds,
                });
                return;
            }

            updateDerivedValues();
        } finally {
            renderScheduled = false;
        }
    };

    // requestAnimationFrame is present in the browser, but not in every
    // embedded/test runtime.  Feed-health transitions still have to fail
    // projections closed there, so perform the same refresh synchronously
    // instead of throwing and leaving renderScheduled stuck forever.
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(runRefresh);
    } else {
        runRefresh();
    }
}

function getLiveOptionQuote(subId) {
    const snapshot = _liveQuoteRuntime.optionQuotesById.get(subId);
    return snapshot ? { ...snapshot } : null;
}

function getLiveStockQuote(symbol) {
    const snapshot = _liveQuoteRuntime.stockQuotesBySymbol.get(symbol);
    return snapshot ? { ...snapshot } : null;
}

function getLiveFutureQuote(subId) {
    const snapshot = _liveQuoteRuntime.futureQuotesById.get(subId);
    return snapshot ? { ...snapshot } : null;
}

function getUnderlyingQuote() {
    return _liveQuoteRuntime.underlyingQuote
        ? { ..._liveQuoteRuntime.underlyingQuote }
        : null;
}

function getLiveCarryReferenceQuote(referenceId = 'spot') {
    const snapshot = _liveQuoteRuntime.carryReferenceQuotesById.get(referenceId);
    return snapshot ? { ...snapshot } : null;
}

function getLiveForwardCarrySnapshot() {
    const pricingContext = _getPricingContextApi();
    if (!pricingContext || typeof pricingContext.buildForwardCarrySnapshot !== 'function') {
        return null;
    }
    const registry = _getProductRegistryApi();
    const policy = registry && typeof registry.resolveForwardCarryPolicy === 'function'
        ? registry.resolveForwardCarryPolicy(state && state.underlyingSymbol)
        : null;
    const referenceId = String(policy && policy.carryReference
        && policy.carryReference.id || 'spot').trim() || 'spot';
    return pricingContext.buildForwardCarrySnapshot(state, {
        referenceQuote: getLiveCarryReferenceQuote(referenceId),
    });
}

window.OptionComboWsLiveQuotes = {
    getOptionQuote: getLiveOptionQuote,
    getFutureQuote: getLiveFutureQuote,
    getStockQuote: getLiveStockQuote,
    getCarryReferenceQuote: getLiveCarryReferenceQuote,
    getForwardCarrySnapshot: getLiveForwardCarrySnapshot,
    getUnderlyingQuote,
    isConnected: () => isWsConnected,
    getProjectionFeedHealth: () => ({
        connected: state && state.liveProjectionFeedConnected === true,
        stale: !state || state.liveProjectionFeedStale !== false,
        lastReceivedAt: String(state && state.liveProjectionLastReceivedAt || ''),
    }),
    clear: _resetLiveQuoteRuntime,
};

function _getMarketDataMode() {
    return state && state.marketDataMode === 'historical' ? 'historical' : 'live';
}

function _isHistoricalMode() {
    return _getMarketDataMode() === 'historical';
}

function _normalizeLiveComboOrderAccount(value) {
    return String(value || '').trim();
}

function _getSelectedLiveComboOrderAccount() {
    return _normalizeLiveComboOrderAccount(state && state.selectedLiveComboOrderAccount);
}

function _hasSelectedLiveComboOrderAccount() {
    return !!_getSelectedLiveComboOrderAccount();
}

function _getLiveComboOrderAccountRequirementMessage() {
    const accounts = Array.isArray(state && state.liveComboOrderAccounts)
        ? state.liveComboOrderAccounts.filter((account) => _normalizeLiveComboOrderAccount(account))
        : [];
    if (state && state.liveComboOrderAccountsConnected === true && accounts.length > 0) {
        return 'Select a TWS account before sending live combo orders.';
    }
    return 'Waiting for TWS account list before sending live combo orders.';
}

function _getLiveHedgeOrderAccountRequirementMessage() {
    const accounts = Array.isArray(state && state.liveComboOrderAccounts)
        ? state.liveComboOrderAccounts.filter((account) => _normalizeLiveComboOrderAccount(account))
        : [];
    if (state && state.liveComboOrderAccountsConnected === true && accounts.length > 0) {
        return 'Select a TWS account before sending hedge broker preview.';
    }
    return 'Waiting for TWS account list before sending hedge broker preview.';
}

function _normalizeDeltaHedgeConfig(config) {
    const deltaHedgeLogic = _getDeltaHedgeLogicApi();
    if (deltaHedgeLogic && typeof deltaHedgeLogic.normalizeDeltaHedgeConfig === 'function') {
        return deltaHedgeLogic.normalizeDeltaHedgeConfig(config);
    }
    return config && typeof config === 'object' ? config : {};
}

function _getDeltaHedgeRuntime() {
    if (!state.deltaHedge || typeof state.deltaHedge !== 'object') {
        state.deltaHedge = {};
    }
    state.deltaHedge = _normalizeDeltaHedgeConfig(state.deltaHedge);
    if (!state.deltaHedge.status) {
        state.deltaHedge.status = 'idle';
    }
    return state.deltaHedge;
}

function _refreshDeltaHedgeBrokerPreviewUi() {
    const deltaHedgeUi = _getDeltaHedgeUiApi();
    if (deltaHedgeUi && typeof deltaHedgeUi.applyBrokerPreviewState === 'function') {
        _runUiRefreshSafely('deltaHedgeBrokerPreviewState', () => {
            deltaHedgeUi.applyBrokerPreviewState(state);
        });
    }
}

function _markDeltaHedgeError(message) {
    const runtime = _getDeltaHedgeRuntime();
    runtime.pendingRequest = false;
    runtime.status = 'error';
    runtime.lastError = message || 'Delta hedge broker preview failed.';
    _refreshDeltaHedgeBrokerPreviewUi();
    return false;
}

function _hasActiveDeltaHedgeRestingOrder(runtime) {
    const deltaHedgeLogic = _getDeltaHedgeLogicApi();
    if (deltaHedgeLogic && typeof deltaHedgeLogic.hasActiveRestingHedgeOrder === 'function') {
        return deltaHedgeLogic.hasActiveRestingHedgeOrder(runtime);
    }
    return Boolean(runtime && runtime.restingOrder && runtime.restingOrder.orderId);
}

function _buildDeltaHedgeRuntimeHedgeId(config) {
    const instrument = config && config.hedgeInstrument || {};
    const secType = String(instrument.secType || '').trim().toUpperCase();
    const symbol = String(instrument.symbol || '').trim().toUpperCase();
    const contractMonth = String(instrument.contractMonth || '').trim();
    if (!secType || !symbol) {
        return '';
    }
    return String(config.hedgeId || [
        'delta_hedge',
        secType.toLowerCase(),
        symbol.toLowerCase(),
        contractMonth || 'spot',
    ].join('_'));
}

let _deltaHedgeTransportApi = null;
let _comboOrderTransportApi = null;

/** @returns {OptionComboDeltaHedgeTransportApi | null} */
function _buildDeltaHedgeTransportApi() {
    const transportFactory = _getDeltaHedgeTransportFactory();
    if (!transportFactory || typeof transportFactory.createApi !== 'function') {
        return null;
    }
    return transportFactory.createApi({
        state,
        isHistoricalMode: _isHistoricalMode,
        isWsConnected() {
            return Boolean(isWsConnected && ws);
        },
        sendPayload(payload) {
            ws.send(JSON.stringify(payload));
        },
        getSelectedLiveComboOrderAccount: _getSelectedLiveComboOrderAccount,
        getLiveHedgeOrderAccountRequirementMessage: _getLiveHedgeOrderAccountRequirementMessage,
        refreshBrokerPreviewUi: _refreshDeltaHedgeBrokerPreviewUi,
        requestManagedAccountsSnapshot,
    });
}

function _getDeltaHedgeTransportApi() {
    if (_deltaHedgeTransportApi === null) {
        _deltaHedgeTransportApi = _buildDeltaHedgeTransportApi();
    }
    return _deltaHedgeTransportApi;
}

function requestDeltaHedgeBrokerPreview(recommendation, options = {}) {
    const transportApi = _getDeltaHedgeTransportApi();
    if (!transportApi || typeof transportApi.requestBrokerPreview !== 'function') {
        return _markDeltaHedgeError('Delta hedge transport is unavailable.');
    }
    return transportApi.requestBrokerPreview(recommendation, options);
}

function requestDeltaHedgeSubmit(recommendation, options = {}) {
    const transportApi = _getDeltaHedgeTransportApi();
    if (!transportApi || typeof transportApi.requestSubmit !== 'function') {
        return _markDeltaHedgeError('Delta hedge transport is unavailable.');
    }
    return transportApi.requestSubmit(recommendation, options);
}

function requestDeltaHedgeCancel(options = {}) {
    const transportApi = _getDeltaHedgeTransportApi();
    if (!transportApi || typeof transportApi.requestCancel !== 'function') {
        return _markDeltaHedgeError('Delta hedge transport is unavailable.');
    }
    return transportApi.requestCancel(options);
}

function _buildComboOrderTransportApi() {
    const transportFactory = _getComboOrderTransportFactory();
    if (!transportFactory || typeof transportFactory.createApi !== 'function') {
        return null;
    }
    return transportFactory.createApi({
        state,
        isHistoricalMode: _isHistoricalMode,
        isWsConnected() {
            return Boolean(isWsConnected && ws);
        },
        sendPayload(payload) {
            ws.send(JSON.stringify(payload));
        },
        renderGroups,
        updateDerivedValues,
        requestManagedAccountsSnapshot,
        hasSelectedLiveComboOrderAccount: _hasSelectedLiveComboOrderAccount,
        getLiveComboOrderAccountRequirementMessage: _getLiveComboOrderAccountRequirementMessage,
        findGroupById: _findGroupById,
        groupHasCostForAllPositionedLegs: _groupHasCostForAllPositionedLegs,
        resolveHistoricalReplayClosePrice: _resolveHistoricalReplayClosePrice,
        getHistoricalReplayDate: _getHistoricalReplayDate,
        buildHistoricalTriggerOrderPreview: _buildHistoricalTriggerOrderPreview,
        applyHistoricalComboFill: _applyHistoricalComboFill,
        formatSymbolPriceInputValue: _formatSymbolPriceInputValue,
        flashElement,
    });
}

function _getComboOrderTransportApi() {
    if (_comboOrderTransportApi === null) {
        _comboOrderTransportApi = _buildComboOrderTransportApi();
    }
    return _comboOrderTransportApi;
}

function _getHistoricalReplayDate() {
    const rawValue = state && typeof state.historicalQuoteDate === 'string' && state.historicalQuoteDate
        ? state.historicalQuoteDate
        : (state && typeof state.baseDate === 'string'
            ? state.baseDate
            : '');
    return _normalizeHistoricalDateKey(rawValue);
}

function _getHistoricalEntryDate() {
    const rawValue = state && typeof state.baseDate === 'string'
        ? state.baseDate
        : '';
    return _normalizeHistoricalDateKey(rawValue);
}

function _getQuoteSourceKind(data) {
    return data && data.historicalReplay ? 'historical' : 'live';
}

function _getQuoteReferenceDate() {
    const pricingContext = _getPricingContextApi();
    if (pricingContext && typeof pricingContext.resolveQuoteDate === 'function') {
        return pricingContext.resolveQuoteDate(state);
    }
    return _isHistoricalMode()
        ? (_getHistoricalReplayDate() || state.baseDate || '')
        : (state.liveQuoteDate || state.baseDate || state.simulatedDate || '');
}

function _hasLiveQuotePayload(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    if (Number.isFinite(parseFloat(data.underlyingPrice))) {
        return true;
    }
    if (data.underlyingQuote && typeof data.underlyingQuote === 'object') {
        return true;
    }
    return ['options', 'futures', 'stocks', 'carryReferences'].some((key) =>
        data[key] && typeof data[key] === 'object' && Object.keys(data[key]).length > 0
    );
}

function _resolveLivePayloadAsOf(data) {
    const direct = String(data && data.payloadAsOf || '').trim();
    if (direct && Number.isFinite(new Date(direct).getTime())) {
        return direct;
    }

    const quoteCandidates = [];
    if (data && data.underlyingQuote && typeof data.underlyingQuote === 'object') {
        quoteCandidates.push(data.underlyingQuote);
    }
    ['options', 'futures', 'stocks', 'carryReferences'].forEach((key) => {
        Object.values(data && data[key] && typeof data[key] === 'object' ? data[key] : {})
            .forEach((quote) => quoteCandidates.push(quote));
    });

    let latest = '';
    let latestTime = -Infinity;
    quoteCandidates.forEach((quote) => {
        const timestamp = String(quote && quote.quoteAsOf || '').trim();
        const time = new Date(timestamp).getTime();
        if (Number.isFinite(time) && time > latestTime) {
            latest = timestamp;
            latestTime = time;
        }
    });
    return latest;
}

function _applyLiveQuoteClock(data) {
    if (_isHistoricalMode()
        || (data && data.historicalReplay && typeof data.historicalReplay === 'object')
        || !_hasLiveQuotePayload(data)) {
        return { changed: false, dateChanged: false };
    }

    const pricingContext = _getPricingContextApi();
    if (!pricingContext || typeof pricingContext.resolveLiveQuoteDate !== 'function') {
        return { changed: false, dateChanged: false };
    }

    const payloadAsOf = _resolveLivePayloadAsOf(data);
    const nextAsOfTime = new Date(payloadAsOf).getTime();
    if (!payloadAsOf || !Number.isFinite(nextAsOfTime)) {
        return { changed: false, dateChanged: false };
    }

    const currentAsOfTime = new Date(state.liveQuoteAsOf || '').getTime();
    if (Number.isFinite(currentAsOfTime) && nextAsOfTime <= currentAsOfTime) {
        return { changed: false, dateChanged: false };
    }

    const nextQuoteDate = pricingContext.resolveLiveQuoteDate(state, payloadAsOf);
    if (!nextQuoteDate || (state.liveQuoteDate && nextQuoteDate < state.liveQuoteDate)) {
        return { changed: false, dateChanged: false };
    }

    const dateChanged = nextQuoteDate !== state.liveQuoteDate;
    state.liveQuoteAsOf = payloadAsOf;
    state.liveQuoteDate = nextQuoteDate;

    let simulationDateChanged = false;
    if (!state.simulatedDate || state.simulatedDate < nextQuoteDate) {
        state.simulatedDate = nextQuoteDate;
        simulationDateChanged = true;
    }

    if (dateChanged || simulationDateChanged) {
        const controlPanelUi = _getControlPanelUiApi();
        if (controlPanelUi && typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
            _runUiRefreshSafely('live quote clock', () => controlPanelUi.refreshBoundDynamicControls());
        }
    }

    return {
        changed: dateChanged || simulationDateChanged,
        dateChanged,
    };
}

function _isUnderlyingLeg(legOrType) {
    const registry = _getProductRegistryApi();
    return registry && typeof registry.isUnderlyingLeg === 'function'
        ? registry.isUnderlyingLeg(legOrType)
        : false;
}

function _normalizeWsPort(rawValue) {
    const parsed = parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return DEFAULT_WS_PORT;
    }
    return parsed;
}

function _normalizeWsHost(rawValue) {
    const trimmed = String(rawValue || '').trim();
    if (!trimmed) {
        return DEFAULT_WS_HOST;
    }

    let candidate = trimmed
        .replace(/^[a-z]+:\/\//i, '')
        .replace(/[/?#].*$/, '');

    if (candidate.startsWith('[')) {
        const bracketedMatch = candidate.match(/^\[[^\]]+\]/);
        if (bracketedMatch) {
            candidate = bracketedMatch[0];
        }
    } else if ((candidate.match(/:/g) || []).length === 1) {
        candidate = candidate.replace(/:\d+$/, '');
    }

    return candidate || DEFAULT_WS_HOST;
}

function _getSavedWsHost() {
    try {
        return _normalizeWsHost(localStorage.getItem(WS_HOST_STORAGE_KEY));
    } catch (e) {
        return DEFAULT_WS_HOST;
    }
}

function _setSavedWsHost(host) {
    const safeHost = _normalizeWsHost(host);
    try {
        localStorage.setItem(WS_HOST_STORAGE_KEY, safeHost);
    } catch (e) {
        // Ignore localStorage failures and keep using the runtime value.
    }
    return safeHost;
}

function _getSavedWsPort() {
    try {
        return _normalizeWsPort(localStorage.getItem(WS_PORT_STORAGE_KEY));
    } catch (e) {
        return DEFAULT_WS_PORT;
    }
}

function _setSavedWsPort(port) {
    const safePort = _normalizeWsPort(port);
    try {
        localStorage.setItem(WS_PORT_STORAGE_KEY, String(safePort));
    } catch (e) {
        // Ignore localStorage failures and keep using the runtime value.
    }
    return safePort;
}

function _syncWsHostInput(host) {
    const input = document.getElementById('wsHostInput');
    if (input) input.value = _normalizeWsHost(host);
}

function _syncWsPortInput(port) {
    const input = document.getElementById('wsPortInput');
    if (input) input.value = String(_normalizeWsPort(port));
}

function _getCurrentWsHost() {
    const input = document.getElementById('wsHostInput');
    if (input && input.value) return _normalizeWsHost(input.value);
    return _getSavedWsHost();
}

function _getCurrentWsPort() {
    const input = document.getElementById('wsPortInput');
    if (input && input.value) return _normalizeWsPort(input.value);
    return _getSavedWsPort();
}

function _getWsUrl() {
    return `ws://${_getCurrentWsHost()}:${_getCurrentWsPort()}`;
}

function _clearWsReconnectTimer() {
    if (_wsReconnectTimer) {
        clearTimeout(_wsReconnectTimer);
        _wsReconnectTimer = null;
    }
}

function updateWsStatusUI(status, nextRetrySec) {
    const el = document.getElementById('wsStatus');
    if (!el) return;

    const host = _getCurrentWsHost();
    const port = _getCurrentWsPort();
    const endpoint = `${host}:${port}`;
    if (status === 'connected') {
        el.textContent = `Connected ${endpoint}`;
        el.className = 'ws-status ws-connected';
    } else if (status === 'error') {
        el.textContent = `Error ${endpoint}`;
        el.className = 'ws-status ws-error';
    } else {
        const suffix = nextRetrySec != null ? ` - Retry in ${nextRetrySec}s` : '';
        el.textContent = `Disconnected ${endpoint}${suffix}`;
        el.className = 'ws-status ws-disconnected';
    }
}

function _setLiveProjectionFeedHealth({ connected, stale, receivedAt } = {}, schedule = true) {
    if (!state || _isHistoricalMode()) return false;
    let changed = false;
    if (typeof connected === 'boolean'
        && state.liveProjectionFeedConnected !== connected) {
        state.liveProjectionFeedConnected = connected;
        changed = true;
    }
    if (typeof stale === 'boolean' && state.liveProjectionFeedStale !== stale) {
        state.liveProjectionFeedStale = stale;
        changed = true;
    }
    if (typeof receivedAt === 'string'
        && state.liveProjectionLastReceivedAt !== receivedAt) {
        state.liveProjectionLastReceivedAt = receivedAt;
        changed = true;
    }
    if (changed && schedule) {
        _scheduleDerivedValueRefresh({}, false);
    }
    return changed;
}

function _recordLiveProjectionMarketReceipt(data) {
    if (_isHistoricalMode() || !_hasLiveQuotePayload(data)) return false;
    const wasReady = state.liveProjectionFeedConnected === true
        && state.liveProjectionFeedStale === false;
    _setLiveProjectionFeedHealth({
        // Receiving a market payload is itself stronger evidence of a live
        // transport than a possibly lagging socket lifecycle flag.
        connected: true,
        stale: false,
        // Local receipt time cannot freeze merely because the server's market
        // clock or quote payload stopped advancing.
        receivedAt: new Date().toISOString(),
    }, false);
    const isReady = state.liveProjectionFeedConnected === true
        && state.liveProjectionFeedStale === false;
    // The local receipt timestamp advances on every payload, but that alone
    // must not force a full repricing.  Only a readiness transition does.
    return wasReady !== isReady;
}

function _runLiveProjectionFeedWatchdog(nowMs = Date.now()) {
    if (!state || _isHistoricalMode()) return false;
    const receiptMs = Date.parse(String(state.liveProjectionLastReceivedAt || '').trim());
    const stale = state.liveProjectionFeedConnected !== true
        || !Number.isFinite(receiptMs)
        || !Number.isFinite(nowMs)
        || nowMs - receiptMs > LIVE_PROJECTION_FEED_TIMEOUT_MS
        || receiptMs - nowMs > LIVE_PROJECTION_FEED_WATCHDOG_INTERVAL_MS;
    return _setLiveProjectionFeedHealth({ stale }, true);
}

function _normalizeIbMarketDataGeneration(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function _isExplicitIbStreamReset(payload) {
    return String(payload && payload.recoveryReason || '').trim().toLowerCase()
        === 'explicit_stream_reset';
}

function _ibStatusBlocksAutomaticReplay(payload) {
    return _isExplicitIbStreamReset(payload)
        || (payload
            && payload.subscriptionsRequired === true
            && payload.automaticReplayAllowed === false);
}

function _isRegressiveIbConnectionStatus(generation, marketDataState) {
    if (generation === null || _ibMarketDataGeneration === null) {
        return false;
    }
    if (generation < _ibMarketDataGeneration) {
        return true;
    }
    return generation === _ibMarketDataGeneration
        && _ibMarketDataState === 'ready'
        && marketDataState === 'invalidated';
}

function _adoptIbServerSession(payload) {
    const incomingSessionId = String(
        payload && payload.serverSessionId || ''
    ).trim();
    if (!incomingSessionId || incomingSessionId === _ibServerSessionId) {
        return false;
    }

    const replacesKnownGeneration = _ibMarketDataGeneration !== null;
    _ibServerSessionId = incomingSessionId;
    if (!replacesKnownGeneration) {
        return false;
    }

    // A backend process restart creates a new generation namespace beginning
    // at zero. Never compare that namespace with the previous process.
    _ibMarketDataGeneration = null;
    _ibMarketDataState = '';
    _lastIbRecoveryReplayGeneration = null;
    _lastIbRecoveryReplaySocket = null;
    _automaticReplayBlockedGeneration = null;
    _automaticLiveSubscriptionAllowed = false;
    return true;
}

function _isGenerationScopedLiveMarketPayload(data) {
    if (!data || typeof data !== 'object' || _isHistoricalMode()) {
        return false;
    }
    const action = String(data.action || '').trim();
    return action === 'market_data'
        || action === 'option_contract_metadata'
        || action === 'option_subscription_status'
        || action === 'underlying_sync'
        || _hasLiveQuotePayload(data);
}

function _rejectsCurrentLiveMarketGeneration(data) {
    if (_ibMarketDataGeneration === null || !_isGenerationScopedLiveMarketPayload(data)) {
        return false;
    }
    return _normalizeIbMarketDataGeneration(data.marketDataGeneration)
        !== _ibMarketDataGeneration;
}

function _invalidateLiveMarketEvidence(reason = 'IB market-data connection was invalidated.') {
    if (!state || _isHistoricalMode()) return false;

    _resetLiveQuoteRuntime();
    _lastLiveSubscriptionSignature = '';
    _lastLiveSubscriptionSocket = null;
    _invalidateIndexForwardRateSamples('ib_connection_invalidated');
    _clearSubscribedOptionContractMetadata();

    let changed = _setLiveProjectionFeedHealth({
        connected: false,
        stale: true,
        receivedAt: '',
    }, false);
    if (state.liveQuoteAsOf !== '') {
        state.liveQuoteAsOf = '';
        changed = true;
    }

    (state.groups || []).forEach((group) => {
        if (!group) return;
        (group.legs || []).forEach((leg) => {
            if (!leg) return;
            if (leg.currentPriceSource === 'live') {
                if (leg.currentPrice !== null) {
                    leg.currentPrice = null;
                    changed = true;
                }
                if (leg.currentPriceSource !== 'missing') {
                    leg.currentPriceSource = 'missing';
                    changed = true;
                }
            }
            if (leg.portfolioMarketPriceSource === 'tws_portfolio') {
                if (leg.portfolioMarketPrice !== null
                    && leg.portfolioMarketPrice !== undefined) {
                    leg.portfolioMarketPrice = null;
                    changed = true;
                }
                if (leg.portfolioMarketPriceSource !== '') {
                    leg.portfolioMarketPriceSource = '';
                    changed = true;
                }
                if (leg.portfolioMarketPriceAsOf) {
                    leg.portfolioMarketPriceAsOf = '';
                    changed = true;
                }
                if (leg.portfolioUnrealizedPnl !== null
                    && leg.portfolioUnrealizedPnl !== undefined) {
                    leg.portfolioUnrealizedPnl = null;
                    changed = true;
                }
            }
            if (!_isUnderlyingLeg(leg)
                && leg.ivManualOverride !== true
                && ['live', 'estimated'].includes(String(leg.ivSource || ''))) {
                if (leg.ivSource !== 'missing') {
                    leg.ivSource = 'missing';
                    changed = true;
                }
            }
        });
    });

    (state.hedges || []).forEach((hedge) => {
        if (!hedge || hedge.currentPriceSource !== 'live') return;
        if (hedge.currentPrice !== null) {
            hedge.currentPrice = null;
            changed = true;
        }
        if (hedge.currentPriceSource !== 'missing') {
            hedge.currentPriceSource = 'missing';
            changed = true;
        }
    });

    (state.futuresPool || []).forEach((entry) => {
        changed = _clearFuturesPoolEntryLiveQuote(
            entry,
            'invalidated',
            reason
        ) || changed;
    });

    _refreshFuturesPoolPanelUi();
    if (changed) {
        _scheduleDerivedValueRefresh({}, false);
    }
    return changed;
}

function _handleIbConnectionStatusMessage(data, sourceSocket = ws) {
    if (!data || typeof data !== 'object' || data.action !== 'ib_connection_status') {
        return false;
    }
    if (sourceSocket !== ws) {
        return true;
    }

    _adoptIbServerSession(data);
    const generation = _normalizeIbMarketDataGeneration(data.marketDataGeneration);
    const marketDataState = String(data.marketDataState || '').trim().toLowerCase();
    if (_isRegressiveIbConnectionStatus(generation, marketDataState)) {
        return true;
    }
    _automaticLiveSubscriptionSocket = sourceSocket;
    _automaticLiveSubscriptionAllowed = false;
    const previousGeneration = _ibMarketDataGeneration;
    const generationChanged = generation !== null && generation !== previousGeneration;
    if (generation !== null) {
        _ibMarketDataGeneration = generation;
    }
    if (marketDataState) {
        _ibMarketDataState = marketDataState;
    }
    const automaticReplayBlocked = _ibStatusBlocksAutomaticReplay(data);
    if (generation !== null && automaticReplayBlocked) {
        // This is authoritative even when the backend is already READY. A
        // browser can miss the reset-time INVALIDATED broadcast and learn
        // about the manual replay boundary only from its later status query.
        _automaticReplayBlockedGeneration = generation;
    } else if (generation !== null
        && data.automaticReplayAllowed === true
        && _automaticReplayBlockedGeneration === generation) {
        // The backend may learn that a startup/offline epoch does require
        // replay only when IB becomes ready. Treat the current status as
        // authoritative instead of carrying the earlier startup block
        // forward forever.
        _automaticReplayBlockedGeneration = null;
    }

    if (marketDataState === 'invalidated') {
        if (generationChanged) {
            _lastIbRecoveryReplayGeneration = null;
            _lastIbRecoveryReplaySocket = null;
        }
        if (automaticReplayBlocked) {
            _automaticReplayBlockedGeneration = generation;
        } else if (generationChanged || _automaticReplayBlockedGeneration !== generation) {
            _automaticReplayBlockedGeneration = null;
        }
        _invalidateLiveMarketEvidence(
            String(data.message || 'IB disconnected; live market evidence was invalidated.')
        );
        const recoveryReason = String(data.recoveryReason || '').trim().toLowerCase();
        const shouldRegisterStartupIntent = !automaticReplayBlocked
            && data.subscriptionsRequired !== true
            && recoveryReason.startsWith('startup')
            && !_isHistoricalMode();
        _automaticLiveSubscriptionAllowed = shouldRegisterStartupIntent;
        if (shouldRegisterStartupIntent
            && !(_lastIbRecoveryReplaySocket === sourceSocket
                && _lastIbRecoveryReplayGeneration === generation)) {
            // Startup has no subscriptions to replay yet. Submit the saved
            // browser intent once so the backend opens a recovery generation
            // and can replay it after the first successful IB connection.
            _lastIbRecoveryReplaySocket = sourceSocket;
            _lastIbRecoveryReplayGeneration = generation;
            handleLiveSubscriptions({ automatic: true });
        }
        return true;
    }

    const readyForAutomaticSubscription = marketDataState === 'ready'
        && data.connected === true
        && !automaticReplayBlocked
        && _automaticReplayBlockedGeneration !== generation
        && !_isHistoricalMode();
    if (!readyForAutomaticSubscription) {
        return true;
    }
    _automaticLiveSubscriptionAllowed = true;
    if (_lastIbRecoveryReplaySocket === sourceSocket
        && _lastIbRecoveryReplayGeneration === generation) {
        return true;
    }

    // Claim the socket/epoch before sending so the direct status response and
    // any adjacent broadcast cannot start a second qualification pass.
    _lastIbRecoveryReplaySocket = sourceSocket;
    _lastIbRecoveryReplayGeneration = generation;
    handleLiveSubscriptions({
        automatic: true,
        force: previousGeneration !== null && generationChanged,
    });
    requestActiveHedgeOrdersSnapshot();
    requestActiveComboOrdersSnapshot();
    return true;
}

function connectWebSocket() {
    _clearWsReconnectTimer();

    const wsUrl = _getWsUrl();
    ws = new WebSocket(wsUrl);
    const connectionSocket = ws;

    connectionSocket.onopen = () => {
        if (ws !== connectionSocket) return;
        isWsConnected = true;
        _lastLiveSubscriptionSignature = '';
        _lastLiveSubscriptionSocket = null;
        _automaticLiveSubscriptionSocket = connectionSocket;
        _automaticLiveSubscriptionAllowed = false;
        _setLiveProjectionFeedHealth({
            connected: true,
            stale: true,
            receivedAt: '',
        }, false);
        _wsReconnectDelay = WS_BASE_DELAY;
        console.log(`WebSocket Connected to IB Gateway Backend at ${wsUrl}`);
        updateWsStatusUI('connected');
        if (!_isHistoricalMode()) {
            // Do not enqueue subscription work behind this request in the
            // same callback. The status reply is the socket-specific safety
            // boundary that decides whether ordinary startup is allowed,
            // recovery must wait, or an explicit reset remains manual-only.
            connectionSocket.send(JSON.stringify({
                action: 'request_ib_connection_status',
            }));
        }
        // The backend handles messages from one websocket sequentially.
        // Request the lightweight shared discount snapshot before submitting
        // contract qualification/subscription work, otherwise a large saved
        // portfolio can leave the UI on the manual fallback for many seconds.
        if (!_isHistoricalMode() && state.useMarketDiscountCurve === true) {
            requestDiscountCurveSnapshot();
        }
        if (_isHistoricalMode()) {
            handleLiveSubscriptions({ automatic: true });
        }
        requestActiveHedgeOrdersSnapshot();
        requestActiveComboOrdersSnapshot();
    };

    connectionSocket.onclose = () => {
        if (ws !== connectionSocket) return;
        isWsConnected = false;
        _lastLiveSubscriptionSignature = '';
        _lastLiveSubscriptionSocket = null;
        if (_automaticLiveSubscriptionSocket === connectionSocket) {
            _automaticLiveSubscriptionSocket = null;
            _automaticLiveSubscriptionAllowed = false;
        }
        _invalidateLiveMarketEvidence('Browser WebSocket disconnected.');
        state.liveComboOrderAccountsConnected = false;
        const controlPanelUi = _getControlPanelUiApi();
        if (controlPanelUi && typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
            _runUiRefreshSafely('boundDynamicControls', () => {
                controlPanelUi.refreshBoundDynamicControls();
            });
        }
        const delaySec = Math.round(_wsReconnectDelay / 1000);
        console.log(`WebSocket Disconnected. Reconnecting in ${delaySec}s...`);
        updateWsStatusUI('disconnected', delaySec);
        _wsReconnectTimer = setTimeout(connectWebSocket, _wsReconnectDelay);
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, WS_MAX_DELAY);
    };

    connectionSocket.onerror = (error) => {
        if (ws !== connectionSocket) return;
        console.error("WebSocket Error:", error);
        _setLiveProjectionFeedHealth({ connected: false, stale: true });
        state.liveComboOrderAccountsConnected = false;
        const controlPanelUi = _getControlPanelUiApi();
        if (controlPanelUi && typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
            _runUiRefreshSafely('boundDynamicControls', () => {
                controlPanelUi.refreshBoundDynamicControls();
            });
        }
        updateWsStatusUI('error');
    };

    connectionSocket.onmessage = (event) => {
        if (ws !== connectionSocket) return;
        try {
            const data = JSON.parse(event.data);
            if (_handleManagedAccountsMessage(data)) {
                return;
            }
            if (_handlePortfolioPositionsMessage(data)) {
                return;
            }
            if (_handlePortfolioAvgCostMessage(data)) {
                return;
            }
            if (_handleHedgeOrderMessage(data)) {
                return;
            }
            if (_handleComboOrderMessage(data)) {
                return;
            }
            if (_handleDiscountCurveMessage(data)) {
                return;
            }
            if (_handleHistoricalReplayMessage(data)) {
                return;
            }
            if (_rejectsCurrentLiveMarketGeneration(data)) {
                return;
            }
            if (_handleOptionContractMetadataMessage(data)) {
                return;
            }
            if (_handleIbConnectionStatusMessage(data, connectionSocket)) {
                return;
            }
            if (_handleApiMarketDataSubscriptionsResetMessage(data)) {
                return;
            }
            if (_handleOptionSubscriptionStatusMessage(data)) {
                return;
            }
            processLiveMarketData(data);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    };
}

function _handleOptionContractMetadataMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'option_contract_metadata') {
        return false;
    }
    // ContractDetails is price-independent evidence.  Keep it out of
    // processLiveMarketData so it cannot refresh the feed/quote clock, replace
    // a cached BBO, or change IV/current-price state.
    if (data.contractMetadataOnly !== true || _isHistoricalMode()) {
        return true;
    }

    const expandedOptions = data.options && typeof data.options === 'object'
        ? { ...data.options }
        : {};
    _expandOptionQuoteAliases(expandedOptions);
    const filtered = _filterLiveOptionQuotesByRequestIdentity(expandedOptions);
    const changedGroupIds = new Set();
    let changed = false;

    Object.entries(filtered.accepted || {}).forEach(([subId, metadata]) => {
        // Unlike historical/isolated quote callers, this live-only metadata
        // channel never accepts an id outside the current subscription map.
        if (!_liveQuoteRuntime.optionRequestIdentityById.has(subId)) return;
        (state.groups || []).forEach((group) => {
            if (!group || group.liveData !== true) return;
            (group.legs || []).forEach((leg) => {
                if (!leg || leg.id !== subId) return;
                const identityChanged = _applyLiveOptionContractIdentity(leg, metadata);
                const timingChanged = _applyLiveOptionExpiryTiming(leg, metadata);
                if (!identityChanged && !timingChanged) return;
                changed = true;
                if (group.id) changedGroupIds.add(group.id);
            });
        });
    });

    if (changed) {
        _scheduleDerivedValueRefresh({
            groupIds: Array.from(changedGroupIds),
        }, false);
    }
    return true;
}

function _handleApiMarketDataSubscriptionsResetMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'api_market_data_subscriptions_reset') {
        return false;
    }

    const generation = data.success === true
        ? _normalizeIbMarketDataGeneration(data.marketDataGeneration)
        : null;
    if (data.success === true
        && generation !== null
        && _ibMarketDataGeneration !== null
        && generation < _ibMarketDataGeneration) {
        // A delayed acknowledgement from an older reset must not discard
        // evidence or move the browser back to its generation.
        return true;
    }

    const message = String(data.message || 'All API market-data subscriptions were cleared. Subscribe again to resume live data.');
    const statusElement = document.getElementById('wsStatus');
    if (statusElement) {
        statusElement.textContent = 'API streams cleared globally';
        statusElement.className = 'ws-status ws-error';
        statusElement.title = message;
    }
    if (data.success === true) {
        // The reset acknowledgement is itself an authoritative manual replay
        // boundary. Revoke permission immediately so automatic callers that
        // run before the next connection-status broadcast cannot resubscribe.
        _automaticLiveSubscriptionSocket = ws;
        _automaticLiveSubscriptionAllowed = false;
        const preserveCurrentReadyState = generation !== null
            && generation === _ibMarketDataGeneration
            && _ibMarketDataState === 'ready';
        const responseMarketDataState = String(data.marketDataState || '')
            .trim()
            .toLowerCase();
        const nextMarketDataState = preserveCurrentReadyState
            ? 'ready'
            : (['ready', 'invalidated'].includes(responseMarketDataState)
                ? responseMarketDataState
                : 'invalidated');
        if (generation !== null) {
            _ibMarketDataGeneration = generation;
        }
        _ibMarketDataState = nextMarketDataState;
        _automaticReplayBlockedGeneration = generation === null
            ? _ibMarketDataGeneration
            : generation;
        _automaticLiveSubscriptionSocket = ws;
        _automaticLiveSubscriptionAllowed = false;
        _lastIbRecoveryReplayGeneration = null;
        _lastIbRecoveryReplaySocket = null;
        _lastLiveSubscriptionSignature = '';
        _lastLiveSubscriptionSocket = null;
        _invalidateLiveMarketEvidence(message);
        if (typeof window.alert === 'function') {
            window.alert(message);
        }
    }
    return true;
}

function _describeUnresolvedOptionLeg(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const parts = [];
    const symbol = String(entry.symbol || '').trim();
    if (symbol) parts.push(symbol);
    const expDate = String(entry.expDate || '').replace(/\D/g, '').slice(0, 8);
    if (expDate.length === 8) {
        parts.push(`${expDate.slice(0, 4)}-${expDate.slice(4, 6)}-${expDate.slice(6, 8)}`);
    }
    const right = String(entry.right || '').trim().toUpperCase().slice(0, 1);
    if (right === 'C' || right === 'P') parts.push(right);
    const strike = Number(entry.strike);
    if (Number.isFinite(strike)) parts.push(String(strike));
    return parts.join(' ');
}

function _buildUnresolvedOptionReason(entry) {
    const label = _describeUnresolvedOptionLeg(entry);
    const subject = label ? `${label} ` : '';
    const detail = String((entry && entry.detail) || '').trim();
    if (entry && entry.reason === 'invalid_request') {
        return `${subject}was rejected as a malformed contract request${detail ? `: ${detail}` : ''}.`;
    }
    // IBKR lists strikes per expiry, so a strike that exists on one expiry can
    // be genuinely absent on another. Say so instead of implying a bug.
    return `${subject}has no matching contract at IBKR. This strike is not listed for that expiry — pick a neighbouring strike or expiry.`;
}

function _handleOptionSubscriptionStatusMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'option_subscription_status') {
        return false;
    }
    if (_isHistoricalMode()) {
        return true;
    }

    const entriesById = new Map();
    (Array.isArray(data.unresolved) ? data.unresolved : []).forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const subId = String(entry.id || '').trim();
        if (!subId) return;
        entriesById.set(subId, entry);
    });

    const unresolvedById = {};
    entriesById.forEach((entry, subId) => {
        unresolvedById[subId] = {
            reason: String(entry.reason || 'contract_not_found'),
            label: _describeUnresolvedOptionLeg(entry),
            message: _buildUnresolvedOptionReason(entry),
        };
    });
    // Identical contracts collapse to one canonical request before sending, so
    // the backend only names that id. Propagate the verdict to the alias legs
    // exactly as quotes are propagated, or a duplicated leg in another group
    // stays silently unquoted -- the failure this warning exists to end.
    _liveQuoteRuntime.optionQuoteAliasesByCanonicalId.forEach((aliasIds, canonicalId) => {
        const record = unresolvedById[canonicalId];
        if (!record) return;
        aliasIds.forEach((aliasId) => {
            if (unresolvedById[aliasId] === undefined) {
                unresolvedById[aliasId] = record;
            }
        });
    });
    state.liveSubscriptionUnresolvedById = unresolvedById;

    const changedGroupIds = new Set();
    let changed = false;
    (state.groups || []).forEach((group) => {
        if (!group || group.liveData !== true) return;
        (group.legs || []).forEach((leg) => {
            if (!leg) return;
            const record = unresolvedById[String(leg.id)];
            if (!record) return;
            let legChanged = false;
            if (leg.currentPrice !== null) {
                leg.currentPrice = null;
                legChanged = true;
            }
            legChanged = _markOptionQuoteMissing(leg) || legChanged;
            if (leg.liveQuoteIdentityStatus !== 'not_found') {
                leg.liveQuoteIdentityStatus = 'not_found';
                legChanged = true;
            }
            if (leg.liveQuoteIdentityReason !== record.message) {
                leg.liveQuoteIdentityReason = record.message;
                legChanged = true;
            }
            if (legChanged) {
                changed = true;
                if (group.id) changedGroupIds.add(group.id);
            }
        });
    });

    _refreshLiveSubscriptionWarnings();

    if (changed) {
        _scheduleDerivedValueRefresh({
            groupIds: Array.from(changedGroupIds),
        }, false);
    }
    return true;
}

function _refreshLiveSubscriptionWarnings() {
    const groupEditorUi = _getGroupEditorUiApi();
    if (!groupEditorUi || typeof groupEditorUi.applyLiveSubscriptionWarnings !== 'function') {
        return;
    }
    _runUiRefreshSafely('liveSubscriptionWarnings', () => {
        groupEditorUi.applyLiveSubscriptionWarnings(state);
    });
}

function reconnectWebSocket() {
    _clearWsReconnectTimer();
    isWsConnected = false;
    _setLiveProjectionFeedHealth({ connected: false, stale: true });

    if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try {
            ws.close();
        } catch (e) {
            // Ignore close errors and reconnect below.
        }
        ws = null;
    }

    updateWsStatusUI('disconnected');
    connectWebSocket();
}

function requestPortfolioAvgCostSnapshot() {
    if (!isWsConnected || !ws) {
        return false;
    }

    ws.send(JSON.stringify({
        action: 'request_portfolio_avg_cost_snapshot',
    }));
    return true;
}

function requestDiscountCurveSnapshot(options = {}) {
    const requestOptions = options && typeof options === 'object' ? options : {};
    const isManual = requestOptions.manual === true;
    if (_isHistoricalMode() || !isWsConnected || !ws) {
        if (isManual) {
            state.discountCurveRequestPending = false;
            state.discountCurveRequestManual = false;
            state.discountCurveLastResponseStatus = 'not_sent';
            state.discountCurveLastError = _isHistoricalMode()
                ? 'Latest-curve loading is disabled in historical replay to prevent rate look-ahead.'
                : 'Cannot load the latest yield curve because the WebSocket backend is disconnected.';
            _refreshDiscountCurveConsumers(false);
        }
        return false;
    }

    state.discountCurveRequestPending = isManual;
    state.discountCurveRequestManual = isManual;
    state.discountCurveLastResponseStatus = '';
    if (isManual) {
        state.discountCurveLastError = '';
    }
    if (isManual) {
        _refreshDiscountCurveConsumers(false);
    }

    const payload = {
        action: 'request_discount_curve',
    };
    if (isManual) {
        payload.refresh = true;
        payload.requestedBy = 'manual_control';
    }
    ws.send(JSON.stringify(payload));
    return true;
}

function _runPendingLegExistsCheck() {
    const scope = String(state.pendingLegExistsCheckGroupId || '');
    if (!scope) return false;
    state.pendingLegExistsCheckGroupId = '';
    const checker = typeof OptionComboLegPositionCheck !== 'undefined'
        ? OptionComboLegPositionCheck
        : null;
    if (!checker || typeof checker.compare !== 'function') return false;

    const groups = scope === '__all__'
        ? (state.groups || [])
        : (state.groups || []).filter((group) => String(group.id || '') === scope);
    const account = _getSelectedLiveComboOrderAccount();
    const result = checker.compare(groups, state, state.portfolioPositions || [], account);
    result.ibConnected = state.portfolioPositionsConnected === true;
    const ui = typeof OptionComboGroupEditorUI !== 'undefined' ? OptionComboGroupEditorUI : null;
    if (ui && typeof ui.openLegPositionCheckDialog === 'function') {
        ui.openLegPositionCheckDialog({
            result,
            title: scope === '__all__' ? 'All Groups (net by contract)' : (groups[0] && groups[0].name || 'Group'),
        });
    }
    return true;
}

function _handlePortfolioPositionsMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'portfolio_positions_snapshot') {
        return false;
    }
    state.portfolioPositions = Array.isArray(data.items) ? data.items : [];
    state.portfolioPositionsConnected = data.ibConnected === true && data.positionsReady !== false;
    _runPendingLegExistsCheck();
    return true;
}

function requestLegExistsCheck(groupId) {
    if (_isHistoricalMode()) {
        if (typeof window.alert === 'function') window.alert('Leg Exists Check is available only in the live TWS workspace.');
        return false;
    }
    const account = _getSelectedLiveComboOrderAccount();
    if (!account) {
        if (typeof window.alert === 'function') window.alert(_getLiveComboOrderAccountRequirementMessage());
        requestManagedAccountsSnapshot();
        return false;
    }
    state.pendingLegExistsCheckGroupId = groupId ? String(groupId) : '__all__';
    if (!isWsConnected || !ws) {
        state.pendingLegExistsCheckGroupId = '';
        if (typeof window.alert === 'function') window.alert('WebSocket is not connected; TWS positions cannot be checked.');
        return false;
    }
    ws.send(JSON.stringify({
        action: 'request_portfolio_positions_snapshot',
        account,
    }));
    return true;
}

function requestManagedAccountsSnapshot() {
    if (!isWsConnected || !ws || _isHistoricalMode()) {
        return false;
    }

    ws.send(JSON.stringify({
        action: 'request_managed_accounts_snapshot',
    }));
    return true;
}

function requestActiveHedgeOrdersSnapshot() {
    if (!isWsConnected || !ws || _isHistoricalMode()) {
        return false;
    }

    const runtime = _getDeltaHedgeRuntime();
    const account = _getSelectedLiveComboOrderAccount();
    const payload = {
        action: 'request_active_hedge_orders_snapshot',
    };
    const hedgeId = _buildDeltaHedgeRuntimeHedgeId(runtime);
    if (hedgeId) {
        payload.hedgeId = hedgeId;
    }
    if (account) {
        payload.account = account;
    }
    ws.send(JSON.stringify(payload));
    return true;
}

function requestActiveComboOrdersSnapshot() {
    if (!isWsConnected || !ws || _isHistoricalMode()) {
        return false;
    }

    const payload = {
        action: 'request_active_combo_orders_snapshot',
    };
    const account = _getSelectedLiveComboOrderAccount();
    if (account) {
        payload.account = account;
    }
    ws.send(JSON.stringify(payload));
    return true;
}

function requestContinueManagedComboOrder(group, runtimeKind = 'tradeTrigger') {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.requestContinueManagedComboOrder !== 'function') {
        return false;
    }
    return transportApi.requestContinueManagedComboOrder(group, runtimeKind);
}

function requestConcedeManagedComboOrder(group, concessionRatio, runtimeKind = 'tradeTrigger') {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.requestConcedeManagedComboOrder !== 'function') {
        return false;
    }
    return transportApi.requestConcedeManagedComboOrder(group, concessionRatio, runtimeKind);
}

function requestManualConcedeManagedComboOrder(group, concessionStep, runtimeKind = 'tradeTrigger') {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.requestManualConcedeManagedComboOrder !== 'function') {
        return false;
    }
    return transportApi.requestManualConcedeManagedComboOrder(group, concessionStep, runtimeKind);
}

function requestCancelManagedComboOrder(group, reason = 'manual_cancel', runtimeKind = 'tradeTrigger') {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.requestCancelManagedComboOrder !== 'function') {
        return false;
    }
    return transportApi.requestCancelManagedComboOrder(group, reason, runtimeKind);
}

function _buildCloseGroupComboOrderPayload(group, closeExecution, executionMode = 'submit') {
    if (!closeExecution) {
        return null;
    }

    const groupOrderBuilder = _getGroupOrderBuilderApi();
    if (!groupOrderBuilder || typeof groupOrderBuilder.buildGroupOrderRequestPayload !== 'function') {
        return null;
    }

    return groupOrderBuilder.buildGroupOrderRequestPayload(group, state, {
        action: executionMode === 'preview' ? 'preview_combo_order' : 'submit_combo_order',
        executionMode,
        intent: 'close',
        source: 'close_group',
        managedRepriceThreshold: closeExecution.repriceThreshold,
        managedConcessionRatio: closeExecution.concessionRatio,
        timeInForce: closeExecution.timeInForce,
    });
}

function _roundHistoricalReplayPrice(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 10000) / 10000 : null;
}

function _nextHistoricalReplayOrderIds() {
    _historicalReplayOrderCounter += 1;
    return {
        orderId: _historicalReplayOrderCounter,
        permId: 800000000 + _historicalReplayOrderCounter,
    };
}

function _buildHistoricalReplayLocalSymbol(leg) {
    if (_isUnderlyingLeg(leg)) {
        return state.underlyingSymbol || 'Underlying';
    }

    return `${state.underlyingSymbol} ${String(leg.expDate || '')} ${String(leg.type || '').toUpperCase()} ${leg.strike}`;
}

function _resolveHistoricalReplayClosePrice(leg, allowIntrinsicFallback = true) {
    if (!leg) {
        return null;
    }

    const replayDate = _normalizeHistoricalDateKey(_getHistoricalReplayDate());
    const expiryDate = _normalizeHistoricalDateKey(leg.expDate);
    const isExpiredOption = !_isUnderlyingLeg(leg)
        && !!replayDate
        && !!expiryDate
        && expiryDate <= replayDate;

    if (_isUnderlyingLeg(leg)) {
        return _roundHistoricalReplayPrice(state.underlyingPrice);
    }

    if (isExpiredOption) {
        if (!allowIntrinsicFallback || !Number.isFinite(state.underlyingPrice)) {
            return null;
        }

        const settlementUnderlyingPrice = Number.isFinite(parseFloat(leg.historicalExpiryUnderlyingPrice))
            ? parseFloat(leg.historicalExpiryUnderlyingPrice)
            : state.underlyingPrice;
        if (String(leg.type || '').toLowerCase() === 'call') {
            return _roundHistoricalReplayPrice(Math.max(0, settlementUnderlyingPrice - (parseFloat(leg.strike) || 0)));
        }
        if (String(leg.type || '').toLowerCase() === 'put') {
            return _roundHistoricalReplayPrice(Math.max(0, (parseFloat(leg.strike) || 0) - settlementUnderlyingPrice));
        }
        return null;
    }

    if (leg.currentPriceSource !== 'missing'
        && Number.isFinite(leg.currentPrice)
        && leg.currentPrice > 0) {
        return _roundHistoricalReplayPrice(leg.currentPrice);
    }

    if (!allowIntrinsicFallback || !replayDate || !expiryDate || expiryDate > replayDate || !Number.isFinite(state.underlyingPrice)) {
        return null;
    }

    return null;
}

function _resolveHistoricalReplayEntryPrice(leg) {
    if (!leg) {
        return null;
    }

    if (_isUnderlyingLeg(leg)) {
        if (leg.currentPriceSource !== 'missing'
            && Number.isFinite(leg.currentPrice)
            && leg.currentPrice > 0) {
            return _roundHistoricalReplayPrice(leg.currentPrice);
        }
        return Number.isFinite(state.underlyingPrice)
            ? _roundHistoricalReplayPrice(state.underlyingPrice)
            : null;
    }

    if (leg.currentPriceSource !== 'missing'
        && Number.isFinite(leg.currentPrice)
        && leg.currentPrice > 0) {
        return _roundHistoricalReplayPrice(leg.currentPrice);
    }

    return null;
}

function _buildHistoricalClosePreview(group, settledLegs) {
    const netMark = settledLegs.reduce((sum, leg) => sum + ((leg.closePrice || 0) * (parseFloat(leg.pos) || 0)), 0);

    return {
        executionIntent: 'close',
        executionMode: 'historical_replay',
        status: 'Filled',
        comboSymbol: group && group.name ? group.name : 'Historical Replay',
        orderAction: 'CLOSE',
        totalQuantity: 1,
        limitPrice: _roundHistoricalReplayPrice(netMark),
        pricingSource: 'historical_replay',
        statusMessage: `Settled using replay quotes from ${_getHistoricalReplayDate() || 'the selected day'}.`,
        legs: settledLegs.map((leg) => ({
            executionAction: (parseFloat(leg.pos) || 0) > 0 ? 'SELL' : 'BUY',
            ratio: Math.abs(parseInt(leg.pos, 10) || 0),
            localSymbol: _buildHistoricalReplayLocalSymbol(leg),
            mark: leg.closePrice,
        })),
    };
}

function _buildHistoricalOrderStatusUpdate(preview, status) {
    return {
        ...preview,
        status,
        filled: status === 'Filled' ? 1 : (preview.filled || 0),
        remaining: status === 'Filled' ? 0 : (preview.remaining || 1),
        avgFillPrice: Number.isFinite(preview.limitPrice) ? preview.limitPrice : null,
    };
}

function _buildHistoricalFillCostPayload(group, runtimeKind, preview) {
    if (!group || !preview || !Array.isArray(preview.legs)) {
        return null;
    }

    const legs = preview.legs
        .map((previewLeg) => {
            const groupLeg = (group.legs || []).find((leg) => leg.id === previewLeg.id);
            if (!groupLeg) {
                return null;
            }

            const avgFillPrice = runtimeKind === 'closeExecution'
                ? _resolveHistoricalReplayClosePrice(groupLeg, true)
                : _resolveHistoricalReplayEntryPrice(groupLeg);
            if (!Number.isFinite(avgFillPrice) || avgFillPrice < 0) {
                return null;
            }

            return {
                id: groupLeg.id,
                avgFillPrice,
            };
        })
        .filter(Boolean);

    if (legs.length === 0) {
        return null;
    }

    return {
        action: 'combo_order_fill_cost_update',
        groupId: group.id,
        orderFill: {
            orderId: preview.orderId || null,
            permId: preview.permId || null,
            requestSource: preview.requestSource || '',
            executionIntent: preview.executionIntent || '',
            executionMode: preview.executionMode || '',
            status: 'Filled',
            avgFillPrice: Number.isFinite(preview.limitPrice) ? preview.limitPrice : null,
            legs,
        },
    };
}

function _applyHistoricalComboFill(group, runtimeKind, preview) {
    if (!group || !preview || String(preview.executionMode || '').trim() !== 'submit') {
        return false;
    }

    _applyComboOrderStatusUpdate({
        action: 'combo_order_status_update',
        groupId: group.id,
        orderStatus: _buildHistoricalOrderStatusUpdate(preview, 'Filled'),
    });

    const fillPayload = _buildHistoricalFillCostPayload(group, runtimeKind, preview);
    if (fillPayload) {
        _applyComboOrderFillCostUpdate(fillPayload);
    }

    if (runtimeKind === 'closeExecution' && !_groupHasOpenPositions(group)) {
        group.viewMode = 'settlement';
        renderGroups();
        updateDerivedValues();
    }

    return true;
}

function _markHistoricalReplayEntryError(message) {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(message);
    } else {
        console.error(message);
    }
}

function _lockHistoricalReplayEntryCosts(group) {
    if (!group) {
        return false;
    }

    if (!_groupHasOpenPositions(group)) {
        _markHistoricalReplayEntryError('This group has no open legs to enter.');
        return false;
    }

    const missingLegs = [];
    (group.legs || []).forEach((leg) => {
        const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
        const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined;
        if (pos < 0.0001 || hasClosePrice) {
            return;
        }

        const entryPrice = _resolveHistoricalReplayEntryPrice(leg);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            missingLegs.push(leg);
            return;
        }

        leg.cost = entryPrice;
        leg.costSource = 'historical_replay_entry';
        leg.entryReplayDate = _getHistoricalReplayDate() || state.simulatedDate || '';
        leg.executionReportedCost = false;
        delete leg.executionReportOrderId;
        delete leg.executionReportPermId;
    });

    if (missingLegs.length > 0) {
        _markHistoricalReplayEntryError(`Historical entry price is unavailable for ${missingLegs.length} leg(s) on ${_getHistoricalReplayDate() || 'the selected day'}.`);
        return false;
    }

    const trigger = _getTradeTrigger(group);
    if (trigger) {
        trigger.enabled = false;
        trigger.pendingRequest = false;
        trigger.status = 'idle';
        trigger.lastError = '';
    }

    group.viewMode = 'active';
    renderGroups();
    updateDerivedValues();
    return true;
}

function _buildHistoricalTriggerOrderPreview(group, executionMode) {
    const trigger = _getTradeTrigger(group);
    const replayDate = _getHistoricalReplayDate() || 'the selected day';
    const missingLegs = [];
    const previewLegs = [];
    let netMark = 0;

    (group.legs || []).forEach((leg) => {
        const pos = parseFloat(leg && leg.pos) || 0;
        if (Math.abs(pos) < 0.0001) {
            return;
        }

        const mark = _resolveHistoricalReplayEntryPrice(leg);
        if (!Number.isFinite(mark) || mark < 0) {
            missingLegs.push(leg);
            return;
        }

        netMark += mark * pos;
        previewLegs.push({
            id: leg.id,
            executionAction: pos > 0 ? 'BUY' : 'SELL',
            ratio: Math.abs(parseInt(pos, 10) || 0),
            localSymbol: _buildHistoricalReplayLocalSymbol(leg),
            symbol: state.underlyingSymbol || '',
            mark,
        });
    });

    if (missingLegs.length > 0) {
        return {
            error: `Historical replay quote is unavailable for ${missingLegs.length} leg(s) on ${replayDate}.`,
        };
    }

    if (previewLegs.length === 0) {
        return {
            error: 'This group has no non-zero legs to simulate.',
        };
    }

    const limitPrice = _roundHistoricalReplayPrice(Math.abs(netMark));
    const preview = {
        executionIntent: 'open',
        executionMode,
        requestSource: 'trial_trigger',
        comboSymbol: group && group.name ? group.name : 'Historical Replay',
        orderAction: netMark >= 0 ? 'BUY' : 'SELL',
        totalQuantity: 1,
        limitPrice,
        timeInForce: trigger && trigger.timeInForce ? trigger.timeInForce : 'DAY',
        pricingSource: 'historical_replay',
        pricingNote: 'Built from replay-day leg quotes. No live TWS order was sent.',
        statusMessage: executionMode === 'preview'
            ? `Historical replay preview created from ${replayDate}.`
            : `Historical replay simulated ${executionMode === 'test_submit' ? 'test submit' : 'submit'} created from ${replayDate}. No live TWS order was sent.`,
        legs: previewLegs,
    };

    if (executionMode !== 'preview') {
        const orderIds = _nextHistoricalReplayOrderIds();
        preview.status = 'Submitted';
        preview.orderId = orderIds.orderId;
        preview.permId = orderIds.permId;
        preview.filled = 0;
        preview.remaining = 1;
        preview.managedMode = false;
        preview.managedState = 'simulated';
    }

    return { preview };
}

function _applyHistoricalTriggerOrderPreview(group, executionMode) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyHistoricalTriggerOrderPreview !== 'function') {
        return false;
    }
    return testApi.applyHistoricalTriggerOrderPreview(group, executionMode);
}

function _settleHistoricalReplayGroup(group) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.settleHistoricalReplayGroup !== 'function') {
        return false;
    }
    return testApi.settleHistoricalReplayGroup(group);
}

function requestCloseGroupComboOrder(group) {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.requestCloseGroupComboOrder !== 'function') {
        return false;
    }
    return transportApi.requestCloseGroupComboOrder(group);
}

function requestEquivalentCloseGroupComboOrder(group) {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.requestEquivalentCloseGroupComboOrder !== 'function') {
        return false;
    }
    return transportApi.requestEquivalentCloseGroupComboOrder(group);
}

function requestCloseLegComboOrder(group, leg) {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.requestCloseLegComboOrder !== 'function') {
        return false;
    }
    return transportApi.requestCloseLegComboOrder(group, leg);
}

function requestHistoricalReplayEntryGroup(group) {
    if (!_isHistoricalMode()) {
        return false;
    }

    const didLock = _lockHistoricalReplayEntryCosts(group);
    if (!didLock) {
        renderGroups();
    }
    return didLock;
}

function requestHistoricalReplayExpirySettlementSync(group) {
    if (!_isHistoricalMode()) {
        return false;
    }

    const didSync = _applyHistoricalAutoExpirySettlement(group);
    renderGroups();
    updateDerivedValues();
    return didSync;
}

function toggleWsPortControls() {
    const controls = document.getElementById('wsPortControls');
    if (!controls) return;
    controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
}

function applyWsPort() {
    applyWsEndpoint();
}

function applyWsEndpoint() {
    const hostInput = document.getElementById('wsHostInput');
    const portInput = document.getElementById('wsPortInput');
    if (!portInput) return;

    const safeHost = _normalizeWsHost(hostInput && hostInput.value);
    const safePort = _normalizeWsPort(portInput.value);
    if (hostInput) hostInput.value = safeHost;
    portInput.value = String(safePort);
    _setSavedWsHost(safeHost);
    _setSavedWsPort(safePort);
    reconnectWebSocket();
}

function resetWsPort() {
    resetWsEndpoint();
}

function resetWsEndpoint() {
    _setSavedWsHost(DEFAULT_WS_HOST);
    _setSavedWsPort(DEFAULT_WS_PORT);
    _syncWsHostInput(DEFAULT_WS_HOST);
    _syncWsPortInput(DEFAULT_WS_PORT);
    reconnectWebSocket();
}

function initWsPortControls() {
    const savedHost = _getSavedWsHost();
    const savedPort = _getSavedWsPort();
    _syncWsHostInput(savedHost);
    _syncWsPortInput(savedPort);
    updateWsStatusUI('disconnected');
}

window.toggleWsPortControls = toggleWsPortControls;
window.applyWsPort = applyWsPort;
window.resetWsPort = resetWsPort;
window.applyWsEndpoint = applyWsEndpoint;
window.resetWsEndpoint = resetWsEndpoint;
window.requestPortfolioAvgCostSnapshot = requestPortfolioAvgCostSnapshot;
window.requestDiscountCurveSnapshot = requestDiscountCurveSnapshot;
window.requestDeltaHedgeBrokerPreview = requestDeltaHedgeBrokerPreview;
window.requestDeltaHedgeSubmit = requestDeltaHedgeSubmit;
window.requestDeltaHedgeCancel = requestDeltaHedgeCancel;
window.requestContinueManagedComboOrder = requestContinueManagedComboOrder;
window.requestConcedeManagedComboOrder = requestConcedeManagedComboOrder;
window.requestManualConcedeManagedComboOrder = requestManualConcedeManagedComboOrder;
window.requestCancelManagedComboOrder = requestCancelManagedComboOrder;
window.requestCloseGroupComboOrder = requestCloseGroupComboOrder;
window.requestEquivalentCloseGroupComboOrder = requestEquivalentCloseGroupComboOrder;
window.requestCloseLegComboOrder = requestCloseLegComboOrder;
window.requestLegExistsCheck = requestLegExistsCheck;
window.requestHistoricalReplayEntryGroup = requestHistoricalReplayEntryGroup;
window.requestHistoricalReplayExpirySettlementSync = requestHistoricalReplayExpirySettlementSync;

// -------------------------------------------------------------
// Subscription Management
// -------------------------------------------------------------

function _toContractMonth(dateStr) {
    const normalizedDate = _normalizeHistoricalDateKey(dateStr);
    if (normalizedDate) return normalizedDate.replace(/-/g, '').slice(0, 6);
    return String(dateStr || '').replace(/\D/g, '').slice(0, 6);
}

function _normalizeHistoricalDateKey(value) {
    const rawValue = String(value || '').trim();
    if (!rawValue) return '';

    const dateUtils = _getDateUtilsApi();
    if (dateUtils && typeof dateUtils.normalizeDateInput === 'function') {
        const normalized = String(dateUtils.normalizeDateInput(rawValue) || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
            return normalized;
        }
    }

    const digitsOnly = rawValue.replace(/\D/g, '');
    if (digitsOnly.length === 8) {
        return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6, 8)}`;
    }

    return '';
}

function _toContractDateCode(dateStr) {
    const normalizedDate = _normalizeHistoricalDateKey(dateStr);
    if (normalizedDate) return normalizedDate.replace(/-/g, '');
    return String(dateStr || '').replace(/\D/g, '').slice(0, 8);
}

function _resolveFuturesPoolEntryById(entryId) {
    if (!entryId) return null;
    return (state.futuresPool || []).find(entry => entry.id === entryId) || null;
}

function _buildFuturesPoolRequests(profile) {
    if (!profile || profile.underlyingSecType !== 'FUT') {
        return [];
    }

    return (state.futuresPool || [])
        .filter(entry => /^\d{6}$/.test(String(entry && entry.contractMonth || '')))
        .map(entry => ({
            id: entry.id,
            secType: 'FUT',
            symbol: profile.underlyingSymbol,
            exchange: profile.underlyingExchange,
            currency: profile.currency || 'USD',
            multiplier: String(profile.optionMultiplier || ''),
            contractMonth: entry.contractMonth,
        }));
}

function _futureIdentityMultiplierMatches(left, right) {
    const leftText = String(left || '').trim();
    const rightText = String(right || '').trim();
    if (!leftText || !rightText) return false;
    const leftNumber = Number(leftText);
    const rightNumber = Number(rightText);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return Math.abs(leftNumber - rightNumber) <= 1e-9;
    }
    return leftText === rightText;
}

function _clearFuturesPoolEntryLiveQuote(entry, status, reason, expected = null) {
    if (!entry || typeof entry !== 'object') return false;
    let changed = false;
    [
        'bid', 'ask', 'mark', 'quoteAsOf', 'lastQuotedAt', 'lastTradeDate',
        'localSymbol', 'symbol', 'secType', 'exchange', 'currency',
        'multiplier', 'markSource', 'conId', 'qualifiedContractMonth',
        'requestIdentityVerified', 'liveQuoteRequestGeneration',
        'liveQuoteRequestId', 'requestedSecType', 'requestedSymbol',
        'requestedExchange', 'requestedCurrency', 'requestedMultiplier',
        'requestedContractMonth',
    ].forEach((field) => {
        const nextValue = ['bid', 'ask', 'mark', 'conId', 'liveQuoteRequestGeneration']
            .includes(field) ? null : '';
        if (entry[field] !== nextValue) {
            entry[field] = nextValue;
            changed = true;
        }
    });
    if (entry.liveQuoteIdentityStatus !== status) {
        entry.liveQuoteIdentityStatus = status;
        changed = true;
    }
    if (entry.liveQuoteIdentityReason !== reason) {
        entry.liveQuoteIdentityReason = reason;
        changed = true;
    }
    if (expected) {
        const pendingFields = {
            liveQuoteRequestGeneration: expected.generation,
            liveQuoteRequestId: expected.wireId,
            requestedSecType: expected.secType,
            requestedSymbol: expected.symbol,
            requestedExchange: expected.exchange,
            requestedCurrency: expected.currency,
            requestedMultiplier: expected.multiplier,
            requestedContractMonth: expected.contractMonth,
        };
        Object.entries(pendingFields).forEach(([field, value]) => {
            if (entry[field] !== value) {
                entry[field] = value;
                changed = true;
            }
        });
    }
    return changed;
}

function _buildFutureRequestIdentity(request, generation, wireId) {
    const logicalId = String(request && request.id || '').trim();
    const poolEntry = (state.futuresPool || []).find(entry => entry && entry.id === logicalId) || null;
    const contractMonth = _normalizeContractMonthIdentity(request && request.contractMonth);
    const storedIdentityMatches = !!(poolEntry
        && poolEntry.liveQuoteIdentityStatus === 'verified'
        && poolEntry.requestIdentityVerified === true
        && _normalizeContractMonthIdentity(poolEntry.qualifiedContractMonth) === contractMonth
        && String(poolEntry.secType || '').trim().toUpperCase() === 'FUT'
        && String(poolEntry.symbol || '').trim().toUpperCase()
            === String(request && request.symbol || '').trim().toUpperCase()
        && _futureIdentityMultiplierMatches(poolEntry.multiplier, request && request.multiplier));
    const storedConId = parseInt(poolEntry && poolEntry.conId, 10);
    return {
        logicalId,
        wireId,
        generation,
        secType: String(request && request.secType || '').trim().toUpperCase(),
        symbol: String(request && request.symbol || '').trim().toUpperCase(),
        exchange: String(request && request.exchange || '').trim().toUpperCase(),
        currency: String(request && request.currency || '').trim().toUpperCase(),
        multiplier: String(request && request.multiplier || '').trim(),
        contractMonth,
        conId: storedIdentityMatches && storedConId > 0 ? storedConId : null,
    };
}

function _prepareLiveFutureRequests(futuresRequests) {
    _futureSubscriptionGeneration += 1;
    if (!Number.isSafeInteger(_futureSubscriptionGeneration)
        || _futureSubscriptionGeneration <= 0) {
        _futureSubscriptionGeneration = 1;
    }
    const generation = _futureSubscriptionGeneration;
    state.liveFuturesRequestGeneration = generation;
    _liveQuoteRuntime.futureRequestIdentityByWireId.clear();
    _liveQuoteRuntime.rejectedFutureIdentityWarnings.clear();

    const expectedByLogicalId = new Map();
    const requests = (Array.isArray(futuresRequests) ? futuresRequests : []).map((request, index) => {
        // Avoid the literal "future_" in this opaque id because older backend
        // versions removed that substring globally when returning payload keys.
        const wireId = `frqg${generation}x${index + 1}`;
        const identity = _buildFutureRequestIdentity(request, generation, wireId);
        _liveQuoteRuntime.futureRequestIdentityByWireId.set(wireId, identity);
        expectedByLogicalId.set(identity.logicalId, identity);
        return { ...request, id: wireId };
    });

    (state.futuresPool || []).forEach((entry) => {
        const expected = expectedByLogicalId.get(String(entry && entry.id || '').trim()) || null;
        _clearFuturesPoolEntryLiveQuote(
            entry,
            expected ? 'pending' : 'unavailable',
            expected ? 'awaiting current futures request generation' : 'no valid futures request',
            expected
        );
    });
    return { generation, requests };
}

function _futureQuoteIdentityMismatchReason(expected, rawQuote, payloadAsOf) {
    const actual = _cloneLiveQuoteSnapshot(rawQuote);
    if (!actual) return 'missing qualified futures quote';
    if (!(actual.conId > 0)) return 'missing qualified futures conId';
    if (!String(actual.localSymbol || '').trim()) return 'missing qualified futures localSymbol';
    if (String(actual.secType || '').trim().toUpperCase() !== expected.secType) {
        return 'futures secType mismatch';
    }
    if (String(actual.symbol || '').trim().toUpperCase() !== expected.symbol) {
        return 'futures symbol mismatch';
    }
    // A qualified future's lastTradeDate cannot stand in for its delivery month:
    // CL Sep 2026 stops trading 2026-08-20, so deriving a month from that date
    // rejects every correctly qualified contract whose expiry leads delivery.
    // Only ContractDetails-sourced months are accepted as identity evidence.
    const monthSource = String(actual.contractMonthSource || '').trim();
    const actualMonth = _normalizeContractMonthIdentity(actual.contractMonth);
    if (!actualMonth || monthSource !== 'ib_contract_details') {
        return 'futures contract month unverified';
    }
    if (actualMonth !== expected.contractMonth) {
        return 'futures contract month mismatch';
    }
    if (expected.exchange
        && String(actual.exchange || '').trim().toUpperCase() !== expected.exchange) {
        return 'futures exchange mismatch';
    }
    if (String(actual.currency || '').trim().toUpperCase() !== expected.currency) {
        return 'futures currency mismatch';
    }
    if (expected.multiplier
        && !_futureIdentityMultiplierMatches(actual.multiplier, expected.multiplier)) {
        return 'futures multiplier mismatch';
    }
    if (expected.conId && actual.conId !== expected.conId) {
        return 'futures conId mismatch';
    }

    const quoteMs = Date.parse(String(actual.quoteAsOf || '').trim());
    const payloadMs = Date.parse(String(payloadAsOf || '').trim());
    if (!Number.isFinite(quoteMs)) return 'futures quoteAsOf unavailable';
    if (!Number.isFinite(payloadMs)) return 'futures payloadAsOf unavailable';
    const ageSeconds = (payloadMs - quoteMs) / 1000;
    if (ageSeconds > MAX_LIVE_FUTURE_QUOTE_AGE_SECONDS) return 'futures quote stale';
    if (ageSeconds < -MAX_LIVE_FUTURE_QUOTE_SKEW_SECONDS) return 'futures quote after payload';
    return '';
}

function _filterLiveFutureQuotesByRequestIdentity(futures, payloadAsOf) {
    if (!futures || typeof futures !== 'object') {
        return { accepted: futures, rejected: new Map() };
    }
    // Isolated unit callers and historical data do not register live request
    // identities.  They may populate the cache, but pricing_context will not
    // treat those unverified entries as live Black-76 inputs.
    if (_liveQuoteRuntime.futureRequestIdentityByWireId.size === 0) {
        return { accepted: futures, rejected: new Map() };
    }

    const accepted = {};
    const rejected = new Map();
    Object.entries(futures).forEach(([wireId, quote]) => {
        const expected = _liveQuoteRuntime.futureRequestIdentityByWireId.get(wireId);
        if (!expected) {
            const warningKey = `${wireId}|old_or_unknown_generation`;
            if (!_liveQuoteRuntime.rejectedFutureIdentityWarnings.has(warningKey)) {
                _liveQuoteRuntime.rejectedFutureIdentityWarnings.add(warningKey);
                console.warn(`Ignored live futures quote ${wireId}: old or unknown request generation.`);
            }
            return;
        }
        const reason = _futureQuoteIdentityMismatchReason(expected, quote, payloadAsOf);
        if (reason) {
            rejected.set(expected.logicalId, { reason, expected });
            const warningKey = `${wireId}|${reason}`;
            if (!_liveQuoteRuntime.rejectedFutureIdentityWarnings.has(warningKey)) {
                _liveQuoteRuntime.rejectedFutureIdentityWarnings.add(warningKey);
                console.warn(`Ignored live futures quote ${wireId}: ${reason}.`);
            }
            return;
        }
        accepted[expected.logicalId] = {
            ...quote,
            requestIdentityVerified: true,
            requestGeneration: expected.generation,
            requestId: expected.wireId,
            requestedSecType: expected.secType,
            requestedSymbol: expected.symbol,
            requestedExchange: expected.exchange,
            requestedCurrency: expected.currency,
            requestedMultiplier: expected.multiplier,
            requestedContractMonth: expected.contractMonth,
        };
    });
    return { accepted, rejected };
}

function _invalidateRejectedLiveFutureQuote(logicalId, rejection, changedGroupIds) {
    const entry = (state.futuresPool || []).find(candidate => candidate && candidate.id === logicalId);
    _liveQuoteRuntime.futureQuotesById.delete(logicalId);
    if (!entry) return false;
    const changed = _clearFuturesPoolEntryLiveQuote(
        entry,
        'rejected',
        String(rejection && rejection.reason || rejection || 'futures quote rejected'),
        rejection && rejection.expected || null
    );
    if (changed && changedGroupIds instanceof Set) {
        (state.groups || []).forEach((group) => {
            let groupAffected = false;
            (group.legs || []).forEach((leg) => {
                if (!leg || leg.underlyingFutureId !== logicalId) return;
                groupAffected = true;
                if (_isUnderlyingLeg(leg) && leg.currentPriceSource === 'live') {
                    leg.currentPrice = null;
                    leg.currentPriceSource = '';
                }
            });
            if (groupAffected && group.id) changedGroupIds.add(group.id);
        });
    }
    return changed;
}

function _invalidateStaleLiveFuturesPoolQuotes(changedGroupIds) {
    const snapshotMs = Date.parse(String(state && state.liveQuoteAsOf || '').trim());
    if (!Number.isFinite(snapshotMs)) return false;
    let changed = false;
    (state.futuresPool || []).forEach((entry) => {
        if (!entry || entry.liveQuoteIdentityStatus !== 'verified') return;
        const quoteMs = Date.parse(String(entry.quoteAsOf || entry.lastQuotedAt || '').trim());
        const ageSeconds = Number.isFinite(quoteMs) ? (snapshotMs - quoteMs) / 1000 : Infinity;
        if (ageSeconds <= MAX_LIVE_FUTURE_QUOTE_AGE_SECONDS
            && ageSeconds >= -MAX_LIVE_FUTURE_QUOTE_SKEW_SECONDS) return;
        changed = _invalidateRejectedLiveFutureQuote(
            entry.id,
            { reason: ageSeconds > MAX_LIVE_FUTURE_QUOTE_AGE_SECONDS
                ? 'futures quote stale'
                : 'futures quote after snapshot' },
            changedGroupIds
        ) || changed;
    });
    return changed;
}

function _resolveOptionUnderlyingContractMonth(request, profile, registry, futuresRequests) {
    if (String(profile && profile.optionSecType || '').toUpperCase() !== 'FOP') {
        return '';
    }
    const selectedFuture = _resolveFuturesPoolEntryById(request && request.underlyingFutureId);
    const explicitMonth = _normalizeContractMonthIdentity(
        request && request.underlyingContractMonth
        || selectedFuture && selectedFuture.contractMonth
        || state.underlyingContractMonth
    );
    if (explicitMonth) return explicitMonth;

    const availableMonths = Array.from(new Set(
        (Array.isArray(futuresRequests) ? futuresRequests : [])
            .map(candidate => _normalizeContractMonthIdentity(candidate && candidate.contractMonth))
            .filter(Boolean)
    ));
    if (availableMonths.length === 1) return availableMonths[0];

    return registry && typeof registry.resolveDefaultUnderlyingContractMonth === 'function'
        ? _normalizeContractMonthIdentity(registry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            _getQuoteReferenceDate()
        ))
        : '';
}

function _buildCarryReferenceRequests() {
    const registry = _getProductRegistryApi();
    if (!registry || typeof registry.resolveForwardCarryPolicy !== 'function') {
        return [];
    }
    const policy = registry.resolveForwardCarryPolicy(state && state.underlyingSymbol);
    const reference = policy && policy.carryReference;
    if (policy.pricingInputMode !== 'FOP' || !reference || typeof reference !== 'object') {
        return [];
    }
    const request = {
        id: String(reference.id || 'spot').trim() || 'spot',
        secType: String(reference.secType || '').trim().toUpperCase(),
        symbol: String(reference.symbol || '').trim().toUpperCase(),
        exchange: String(reference.exchange || '').trim(),
        currency: String(reference.currency || policy.currency || 'USD').trim().toUpperCase(),
        purpose: 'diagnostic_net_carry_reference',
    };
    return request.secType && request.symbol ? [request] : [];
}

function _buildUnderlyingRequest(profile, optionRequests, futuresRequests) {
    const registry = _getProductRegistryApi();
    const defaultUnderlyingContractMonth = profile?.underlyingSecType === 'FUT'
        && registry
        && typeof registry.resolveDefaultUnderlyingContractMonth === 'function'
        ? registry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            _getQuoteReferenceDate()
        )
        : '';
    const request = {
        enteredSymbol: state.underlyingSymbol,
        family: profile.family,
        secType: profile.underlyingSecType,
        symbol: profile.underlyingSymbol,
        exchange: profile.underlyingExchange,
        currency: profile.currency || 'USD',
    };

    if (profile.underlyingSecType === 'FUT') {
        const anchorFuture = Array.isArray(futuresRequests) && futuresRequests.length > 0
            ? futuresRequests.slice().sort((left, right) => String(left.contractMonth || '').localeCompare(String(right.contractMonth || '')))[0]
            : null;
        request.contractMonth = state.underlyingContractMonth
            || anchorFuture?.contractMonth
            || defaultUnderlyingContractMonth
            || optionRequests[0]?.underlyingContractMonth
            || optionRequests[0]?.contractMonth
            || _toContractMonth(_getQuoteReferenceDate())
            || _toContractMonth(state.baseDate);
        request.multiplier = String(profile.optionMultiplier || '');
    }

    return request;
}

function _buildHistoricalSnapshotPayload(underlyingRequest, optionRequests, futuresRequests) {
    return {
        action: 'request_historical_snapshot',
        replayDate: _getHistoricalReplayDate(),
        underlying: underlyingRequest,
        options: optionRequests,
        futures: futuresRequests,
        stocks: [],
    };
}

function _clearSubscribedOptionContractMetadata() {
    // A resolution verdict belongs to the subscription that produced it. Drop
    // it up front so an edited strike shows "waiting" rather than the previous
    // strike's "not found" until the backend answers.
    state.liveSubscriptionUnresolvedById = {};
    _refreshLiveSubscriptionWarnings();
    // Contract timing belongs to the exact live subscription. Never carry an
    // old conId's cutoff across an edited leg or reconnect.
    (state.groups || []).forEach((group) => {
        (group.legs || []).forEach((leg) => {
            delete leg.expiryAsOf;
            delete leg.expiryTimingSource;
            delete leg.lastTradeDate;
            delete leg.lastTradeTime;
            delete leg.expiryTimeZoneId;
            delete leg.realExpirationDate;
            delete leg.qualifiedOptionConId;
            delete leg.qualifiedOptionLocalSymbol;
            delete leg.qualifiedOptionTradingClass;
            delete leg.qualifiedOptionUnderConId;
            delete leg.qualifiedOptionUnderlyingContractMonth;
            delete leg.liveQuoteIdentityStatus;
            delete leg.liveQuoteIdentityReason;
        });
    });
}

function handleLiveSubscriptions(options = {}) {
    if (!isWsConnected || !ws) return false;
    if (options.automatic === true
        && !_isHistoricalMode()
        && (_automaticLiveSubscriptionSocket !== ws
            || _automaticLiveSubscriptionAllowed !== true)) {
        return false;
    }
    const registry = _getProductRegistryApi();
    const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
        ? registry.resolveUnderlyingProfile(state.underlyingSymbol)
        : null;
    const sessionLogic = globalThis.OptionComboSessionLogic;
    if (profile && profile.optionSecType === 'FOP'
        && sessionLogic && typeof sessionLogic.ensureInitialFuturesPoolEntry === 'function') {
        sessionLogic.ensureInitialFuturesPoolEntry(
            state,
            null,
            _getQuoteReferenceDate()
        );
    }
    if (profile && profile.optionSecType === 'FOP'
        && sessionLogic && typeof sessionLogic.autoBindSingleFuturesPoolEntry === 'function') {
        sessionLogic.autoBindSingleFuturesPoolEntry(state);
    }
    if (!_isHistoricalMode()
        && registry
        && typeof registry.supportsLegacyLiveData === 'function'
        && !registry.supportsLegacyLiveData(state.underlyingSymbol)) {
        if (!_legacyLiveDataWarningShown) {
            console.warn(`Legacy live-data subscriptions are not implemented for ${state.underlyingSymbol}. Use manual prices for now.`);
            _legacyLiveDataWarningShown = true;
        }
        return false;
    }

    const optionRequests = [];
    const futuresRequests = _buildFuturesPoolRequests(profile || {});
    (state.hedges || []).forEach((hedge) => {
        if (!hedge || hedge.liveData !== true || String(hedge.secType || '').toUpperCase() !== 'FUT'
            || !hedge.symbol || !/^\d{6}$/.test(String(hedge.contractMonth || '').slice(0, 6))) return;
        futuresRequests.push({
            id: hedge.id,
            secType: 'FUT',
            symbol: String(hedge.symbol).toUpperCase(),
            exchange: hedge.exchange || '',
            currency: hedge.currency || 'USD',
            multiplier: String(hedge.multiplier || ''),
            contractMonth: String(hedge.contractMonth).slice(0, 6),
        });
    });
    const payload = {
        action: 'subscribe',
        greeksEnabled: _areGreeksEnabled(),
        underlying: null,
        options: optionRequests,
        futures: futuresRequests,
        stocks: [],
        carryReferences: _buildCarryReferenceRequests(),
    };
    if (_ibMarketDataGeneration !== null) {
        payload.marketDataGeneration = _ibMarketDataGeneration;
    }

    if (profile?.underlyingSecType === 'IND'
        && _getIndexForwardRateApi()
        && typeof _getIndexForwardRateApi().buildSampleSubscriptionId === 'function') {
        const indexForwardRateApi = _getIndexForwardRateApi();
        (state.forwardRateSamples || []).forEach((sample) => {
            if (!sample || !sample.expDate || !Number.isFinite(parseFloat(sample.strike))) {
                return;
            }

            const optionContractSpec = registry
                && typeof registry.resolveOptionContractSpec === 'function'
                ? registry.resolveOptionContractSpec(state.underlyingSymbol, sample.expDate)
                : null;

            ['call', 'put'].forEach((rightLabel) => {
                optionRequests.push({
                    id: indexForwardRateApi.buildSampleSubscriptionId(sample, rightLabel),
                    secType: profile?.optionSecType || 'OPT',
                    symbol: optionContractSpec?.symbol || profile?.optionSymbol || state.underlyingSymbol,
                    underlyingSymbol: profile?.underlyingSymbol || state.underlyingSymbol,
                    exchange: profile?.optionExchange || 'SMART',
                    underlyingExchange: profile?.underlyingExchange || profile?.optionExchange || 'SMART',
                    currency: profile?.currency || 'USD',
                    multiplier: String(profile?.optionMultiplier || 100),
                    underlyingMultiplier: String(profile?.optionMultiplier || 100),
                    tradingClass: optionContractSpec
                        ? (optionContractSpec.tradingClass || undefined)
                        : (profile?.tradingClass || undefined),
                    right: rightLabel === 'put' ? 'P' : 'C',
                    strike: parseFloat(sample.strike),
                        expDate: _toContractDateCode(sample.expDate),
                    contractMonth: _toContractMonth(sample.expDate),
                });
            });
        });
    }

    (state.comboTemplateQuoteRequests || []).forEach((request) => {
        if (!request || !request.id || !request.expDate || !Number.isFinite(parseFloat(request.strike))) {
            return;
        }
        const optionContractSpec = registry
            && typeof registry.resolveOptionContractSpec === 'function'
            ? registry.resolveOptionContractSpec(state.underlyingSymbol, request.expDate)
            : null;
        const underlyingContractMonth = _resolveOptionUnderlyingContractMonth(
            request,
            profile,
            registry,
            futuresRequests
        );
        optionRequests.push({
            id: request.id,
            secType: profile?.optionSecType || 'OPT',
            symbol: optionContractSpec?.symbol || profile?.optionSymbol || state.underlyingSymbol,
            underlyingSymbol: profile?.underlyingSymbol || state.underlyingSymbol,
            exchange: profile?.optionExchange || 'SMART',
            underlyingExchange: profile?.underlyingExchange || profile?.optionExchange || 'SMART',
            currency: profile?.currency || 'USD',
            multiplier: String(profile?.optionMultiplier || 100),
            underlyingMultiplier: String(profile?.optionMultiplier || 100),
            tradingClass: optionContractSpec
                ? (optionContractSpec.tradingClass || undefined)
                : (profile?.tradingClass || undefined),
            right: String(request.type || '').toLowerCase() === 'put' ? 'P' : 'C',
            strike: parseFloat(request.strike),
            expDate: _toContractDateCode(request.expDate),
            contractMonth: _toContractMonth(request.expDate),
            underlyingContractMonth: underlyingContractMonth || undefined,
        });
    });

    // Collect all legs from groups that have Live Data == true
    state.groups.forEach(group => {
        if (group.liveData) {
            group.legs.forEach(leg => {
                if (!_isUnderlyingLeg(leg)) {
                    const optionContractSpec = registry
                        && typeof registry.resolveOptionContractSpec === 'function'
                        ? registry.resolveOptionContractSpec(state.underlyingSymbol, leg.expDate)
                        : null;
                    const underlyingContractMonth = _resolveOptionUnderlyingContractMonth(
                        leg,
                        profile,
                        registry,
                        futuresRequests
                    );
                    optionRequests.push({
                        id: leg.id,
                        secType: profile?.optionSecType || 'OPT',
                        symbol: optionContractSpec?.symbol || profile?.optionSymbol || state.underlyingSymbol,
                        underlyingSymbol: profile?.underlyingSymbol || state.underlyingSymbol,
                        exchange: profile?.optionExchange || 'SMART',
                        underlyingExchange: profile?.underlyingExchange || profile?.optionExchange || 'SMART',
                        currency: profile?.currency || 'USD',
                        multiplier: String(profile?.optionMultiplier || 100),
                        underlyingMultiplier: String(profile?.optionMultiplier || 100),
                        tradingClass: optionContractSpec
                            ? (optionContractSpec.tradingClass || undefined)
                            : (profile?.tradingClass || undefined),
                        right: leg.type.charAt(0).toUpperCase(), // 'C' or 'P'
                        strike: leg.strike,
                        expDate: _toContractDateCode(leg.expDate),
                        contractMonth: _toContractMonth(leg.expDate),
                        underlyingContractMonth,
                    });
                }
            });
        }
    });

    // Stock hedge rows use the stock path; FUT hedge rows are in futuresRequests.
    state.hedges.forEach(hedge => {
        if (hedge.liveData && hedge.symbol && String(hedge.secType || 'STK').toUpperCase() !== 'FUT') {
            payload.stocks.push(hedge.symbol);
        }
    });

    const fallbackProfile = profile || {
        family: 'DEFAULT_EQUITY',
        underlyingSecType: 'STK',
        underlyingSymbol: state.underlyingSymbol,
        underlyingExchange: 'SMART',
        currency: 'USD',
    };
    const underlyingIntent = _buildUnderlyingRequest(
        fallbackProfile,
        optionRequests,
        futuresRequests
    );
    const subscriptionSignature = JSON.stringify({
        greeksEnabled: payload.greeksEnabled,
        underlying: underlyingIntent,
        options: optionRequests,
        futures: futuresRequests,
        stocks: payload.stocks,
        carryReferences: payload.carryReferences,
    });
    const historicalMode = _isHistoricalMode();
    if (!historicalMode && options.force !== true
        && _lastLiveSubscriptionSocket === ws
        && _lastLiveSubscriptionSignature === subscriptionSignature) {
        return false;
    }

    _resetLiveQuoteRuntime();
    _invalidateIndexForwardRateSamples('live_subscription_reset');
    _clearSubscribedOptionContractMetadata();

    const dedupedOptionRequests = _dedupeOptionRequestsForSubscription(optionRequests);
    payload.options = dedupedOptionRequests;
    payload.underlying = _buildUnderlyingRequest(
        fallbackProfile,
        dedupedOptionRequests,
        futuresRequests
    );

    if (historicalMode) {
        ws.send(JSON.stringify(_buildHistoricalSnapshotPayload(payload.underlying, dedupedOptionRequests, futuresRequests)));
        return true;
    }

    const preparedFutureRequests = _prepareLiveFutureRequests(futuresRequests);
    payload.futures = preparedFutureRequests.requests;
    payload.futuresRequestGeneration = preparedFutureRequests.generation;
    ws.send(JSON.stringify(payload));
    _lastLiveSubscriptionSignature = subscriptionSignature;
    _lastLiveSubscriptionSocket = ws;
    requestPortfolioAvgCostSnapshot();
    if (state.allowLiveComboOrders === true
        || !Array.isArray(state.liveComboOrderAccounts)
        || state.liveComboOrderAccounts.length === 0
        || state.liveComboOrderAccountsConnected !== true) {
        requestManagedAccountsSnapshot();
    }
    return true;
}

let _unsubscribeOptionsFeedbackTimer = null;

function _setUnsubscribeOptionsFeedback(message, isError) {
    const el = document.getElementById('unsubscribeOptionsFeedback');
    if (!el) {
        return;
    }
    if (_unsubscribeOptionsFeedbackTimer !== null && typeof clearTimeout === 'function') {
        clearTimeout(_unsubscribeOptionsFeedbackTimer);
        _unsubscribeOptionsFeedbackTimer = null;
    }
    el.textContent = message || '';
    el.style.display = message ? 'block' : 'none';
    el.style.color = isError ? 'var(--danger-color, #DC2626)' : 'var(--success-color, #059669)';
    if (message && typeof setTimeout === 'function') {
        _unsubscribeOptionsFeedbackTimer = setTimeout(() => {
            _unsubscribeOptionsFeedbackTimer = null;
            el.textContent = '';
            el.style.display = 'none';
        }, 6000);
    }
}

function unsubscribeAllOptionQuotes() {
    if (!isWsConnected || !ws) {
        _setUnsubscribeOptionsFeedback('Failed: market data WebSocket is not connected.', true);
        return false;
    }

    let disabledGroupCount = 0;
    (state.groups || []).forEach((group) => {
        if (group && group.liveData) {
            group.liveData = false;
            disabledGroupCount += 1;
        }
    });
    const templateQuoteCount = Array.isArray(state.comboTemplateQuoteRequests)
        ? state.comboTemplateQuoteRequests.length
        : 0;
    if (templateQuoteCount > 0) {
        state.comboTemplateQuoteRequests = [];
    }
    // Re-issuing the subscribe action with no options drops every option
    // market data line server-side while keeping underlying/futures/stocks.
    handleLiveSubscriptions();
    if (disabledGroupCount > 0 && typeof renderGroups === 'function') {
        renderGroups();
    }

    if (disabledGroupCount === 0 && templateQuoteCount === 0) {
        _setUnsubscribeOptionsFeedback('No active option subscriptions to cancel.', false);
    } else {
        const parts = [];
        if (disabledGroupCount > 0) {
            parts.push(`market data turned off for ${disabledGroupCount} group${disabledGroupCount > 1 ? 's' : ''}`);
        }
        if (templateQuoteCount > 0) {
            parts.push(`${templateQuoteCount} combo finder quote${templateQuoteCount > 1 ? 's' : ''} released`);
        }
        _setUnsubscribeOptionsFeedback(`Option subscriptions cancelled: ${parts.join(', ')}.`, false);
    }
    return true;
}

function requestUnderlyingPriceSync() {
    if (!isWsConnected || !ws) {
        alert("Live Market Data WebSocket is not connected.");
        return;
    }

    if (_isHistoricalMode()) {
        handleLiveSubscriptions();
        return;
    }

    const registry = _getProductRegistryApi();
    if (registry
        && typeof registry.supportsLegacyLiveData === 'function'
        && !registry.supportsLegacyLiveData(state.underlyingSymbol)) {
        alert(`Live underlying sync is not implemented yet for ${state.underlyingSymbol}. Please enter the underlying price manually.`);
        return;
    }

    const fallbackProfile = {
        family: 'DEFAULT_EQUITY',
        underlyingSecType: 'STK',
        underlyingSymbol: state.underlyingSymbol,
        underlyingExchange: 'SMART',
        currency: 'USD',
    };
    const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
        ? registry.resolveUnderlyingProfile(state.underlyingSymbol)
        : fallbackProfile;
    const payload = {
        action: 'sync_underlying',
        underlying: _buildUnderlyingRequest(
            profile,
            [],
            _buildFuturesPoolRequests(profile)
        )
    };
    if (_ibMarketDataGeneration !== null) {
        payload.marketDataGeneration = _ibMarketDataGeneration;
    }

    ws.send(JSON.stringify(payload));
}

function _findGroupById(groupId) {
    return (state.groups || []).find(group => group.id === groupId);
}

function _isPortfolioAvgCostSyncEnabled(group) {
    const sessionLogic = _getSessionLogicApi();
    if (sessionLogic && typeof sessionLogic.isPortfolioAvgCostSyncEnabled === 'function') {
        return sessionLogic.isPortfolioAvgCostSyncEnabled(group);
    }
    return !!(group && group.syncAvgCostFromPortfolio);
}

function _normalizeContractDate(value) {
    return String(value || '').replace(/[^0-9]/g, '').slice(0, 8);
}

function _normalizeRightCode(value) {
    return String(value || '').trim().toUpperCase().slice(0, 1);
}

function _normalizeSecType(value) {
    return String(value || '').trim().toUpperCase();
}

function _resolveLegContractDescriptor(leg) {
    const registry = _getProductRegistryApi();
    const profile = registry
        && typeof registry.resolveUnderlyingProfile === 'function'
        ? registry.resolveUnderlyingProfile(state.underlyingSymbol)
        : {
            optionSecType: 'OPT',
            underlyingSecType: 'STK',
            optionSymbol: state.underlyingSymbol,
            underlyingSymbol: state.underlyingSymbol,
        };

    const optionContractSpec = registry
        && typeof registry.resolveOptionContractSpec === 'function'
        ? registry.resolveOptionContractSpec(state.underlyingSymbol, leg && leg.expDate)
        : null;

    if (_isUnderlyingLeg(leg)) {
        return {
            secType: _normalizeSecType(profile.underlyingSecType || 'STK'),
            symbol: String(profile.underlyingSymbol || state.underlyingSymbol || '').trim().toUpperCase(),
            right: '',
            expDate: '',
            strike: null,
        };
    }

    return {
        secType: _normalizeSecType(profile.optionSecType || 'OPT'),
        symbol: String(
            optionContractSpec?.symbol
            || profile.optionSymbol
            || state.underlyingSymbol
            || ''
        ).trim().toUpperCase(),
        right: _normalizeRightCode(leg.type),
        expDate: _normalizeContractDate(leg.expDate),
        strike: parseFloat(leg.strike),
    };
}

function _matchesPortfolioAvgCostItem(leg, item) {
    const descriptor = _resolveLegContractDescriptor(leg);
    if (descriptor.secType !== _normalizeSecType(item.secType)) {
        return false;
    }
    if (descriptor.symbol !== String(item.symbol || '').trim().toUpperCase()) {
        return false;
    }

    if (_isUnderlyingLeg(leg)) {
        return true;
    }

    if (descriptor.right !== _normalizeRightCode(item.right)) {
        return false;
    }
    if (_normalizeContractDate(descriptor.expDate) !== _normalizeContractDate(item.expDate)) {
        return false;
    }

    const itemStrike = parseFloat(item.strike);
    if (!Number.isFinite(descriptor.strike) || !Number.isFinite(itemStrike)) {
        return false;
    }

    return Math.abs(descriptor.strike - itemStrike) < 0.0001;
}

function _parsePositivePortfolioMarketPrice(rawValue) {
    const parsed = parseFloat(rawValue);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function _parsePortfolioPnlValue(rawValue) {
    const parsed = parseFloat(rawValue);
    return Number.isFinite(parsed) ? parsed : null;
}

function _applyPortfolioValuationToLeg(leg, item, receivedAsOf = '') {
    let changed = false;

    const nextPortfolioMarketPrice = _parsePositivePortfolioMarketPrice(item.marketPrice);
    if (nextPortfolioMarketPrice === null) {
        if (leg.portfolioMarketPrice !== null && leg.portfolioMarketPrice !== undefined) {
            leg.portfolioMarketPrice = null;
            changed = true;
        }
        if (leg.portfolioMarketPriceSource) {
            leg.portfolioMarketPriceSource = '';
            changed = true;
        }
    } else if (Math.abs((parseFloat(leg.portfolioMarketPrice) || 0) - nextPortfolioMarketPrice) > 0.0001
        || leg.portfolioMarketPriceSource !== 'tws_portfolio') {
        leg.portfolioMarketPrice = nextPortfolioMarketPrice;
        leg.portfolioMarketPriceSource = 'tws_portfolio';
        changed = true;
    }
    if (nextPortfolioMarketPrice !== null
        && receivedAsOf
        && leg.portfolioMarketPriceAsOf !== receivedAsOf) {
        leg.portfolioMarketPriceAsOf = receivedAsOf;
        changed = true;
    }

    const nextPortfolioUnrealizedPnl = _parsePortfolioPnlValue(item.unrealizedPNL);
    if (nextPortfolioUnrealizedPnl === null) {
        if (leg.portfolioUnrealizedPnl !== null && leg.portfolioUnrealizedPnl !== undefined) {
            leg.portfolioUnrealizedPnl = null;
            changed = true;
        }
    } else if (Math.abs((parseFloat(leg.portfolioUnrealizedPnl) || 0) - nextPortfolioUnrealizedPnl) > 0.0001) {
        leg.portfolioUnrealizedPnl = nextPortfolioUnrealizedPnl;
        changed = true;
    }

    return changed;
}

function _applyPortfolioAvgCostUpdate(data) {
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (items.length === 0) {
        return true;
    }

    let stateChanged = false;
    const payloadAsOf = String(data && data.payloadAsOf || '').trim();
    const receivedAsOf = Number.isFinite(Date.parse(payloadAsOf))
        ? new Date(payloadAsOf).toISOString()
        : new Date().toISOString();

    state.groups.forEach(group => {
        (group.legs || []).forEach(leg => {
            const match = items.find(item => {
                const position = parseFloat(item.position);
                if (!Number.isFinite(position) || position === 0) {
                    return false;
                }
                if (Math.sign(position) !== Math.sign(parseFloat(leg.pos) || 0)) {
                    return false;
                }
                return _matchesPortfolioAvgCostItem(leg, item);
            });

            if (!match) {
                return;
            }

            stateChanged = _applyPortfolioValuationToLeg(leg, match, receivedAsOf) || stateChanged;

            if (!_isPortfolioAvgCostSyncEnabled(group) || (leg && leg.costSource === 'execution_report')) {
                return;
            }

            const nextCost = Math.abs(parseFloat(match.avgCostPerUnit));
            if (!Number.isFinite(nextCost) || nextCost <= 0) {
                return;
            }

            if (Math.abs((parseFloat(leg.cost) || 0) - nextCost) <= 0.0001) {
                return;
            }

            leg.cost = nextCost;
            leg.costSource = 'portfolio_avg_cost';
            leg.executionReportedCost = false;
            stateChanged = true;

            const row = document.querySelector(`tr[data-id="${leg.id}"]`);
            if (row) {
                const costInput = row.querySelector('.cost-input');
                if (costInput) {
                    costInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, nextCost);
                    flashElement(costInput);
                }
            }
        });

        const sessionLogic = _getSessionLogicApi();
        if (sessionLogic
            && typeof sessionLogic.groupHasDeterministicCost === 'function'
            && typeof sessionLogic.getRenderableGroupViewMode === 'function') {
            const trigger = _getTradeTrigger(group);
            const brokerStatus = String(trigger && trigger.lastPreview && trigger.lastPreview.status || '').trim();
            const executionMode = String(trigger && trigger.lastPreview && trigger.lastPreview.executionMode || '').trim();
            const renderMode = sessionLogic.getRenderableGroupViewMode(group);

            if (renderMode === 'trial'
                && brokerStatus === 'Filled'
                && executionMode === 'submit'
                && sessionLogic.groupHasDeterministicCost(group)) {
                group.viewMode = 'active';
                stateChanged = true;
            }
        }
    });

    if (stateChanged) {
        if (typeof renderGroups === 'function') {
            renderGroups();
        } else {
            updateDerivedValues();
        }
    }

    return true;
}

function _groupHasCostForAllPositionedLegs(group) {
    return (group.legs || []).every(leg => {
        const pos = parseFloat(leg && leg.pos);
        if (!Number.isFinite(pos) || Math.abs(pos) < 0.0001) {
            return true;
        }
        return Math.abs(parseFloat(leg.cost) || 0) > 0;
    });
}

function _shouldHistoricalAutoCloseAtExpiry(group) {
    const sessionLogic = _getSessionLogicApi();
    if (group && typeof group === 'object'
        && sessionLogic
        && typeof sessionLogic.normalizeHistoricalAutoCloseAtExpiry === 'function') {
        group.historicalAutoCloseAtExpiry = sessionLogic.normalizeHistoricalAutoCloseAtExpiry(
            group.historicalAutoCloseAtExpiry
        );
        return group.historicalAutoCloseAtExpiry;
    }

    if (group && typeof group === 'object') {
        group.historicalAutoCloseAtExpiry = group.historicalAutoCloseAtExpiry !== false;
        return group.historicalAutoCloseAtExpiry;
    }

    return true;
}

function _getTradeTrigger(group) {
    if (!group) return null;
    const tradeTriggerLogic = _getTradeTriggerLogicApi();
    return tradeTriggerLogic && typeof tradeTriggerLogic.ensureGroupTradeTrigger === 'function'
        ? tradeTriggerLogic.ensureGroupTradeTrigger(group)
        : null;
}

function _getCloseExecution(group) {
    if (!group) return null;
    const sessionLogic = _getSessionLogicApi();
    if (!sessionLogic || typeof sessionLogic.normalizeCloseExecution !== 'function') {
        return group.closeExecution || null;
    }
    group.closeExecution = sessionLogic.normalizeCloseExecution(group.closeExecution);
    return group.closeExecution;
}

function _getExecutionRuntimeByKind(group, runtimeKind) {
    return runtimeKind === 'closeExecution'
        ? _getCloseExecution(group)
        : _getTradeTrigger(group);
}

function _resolveExecutionRuntime(group, payload) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.resolveExecutionRuntime !== 'function') {
        return {
            runtime: _getTradeTrigger(group),
            runtimeKind: 'tradeTrigger',
        };
    }
    return testApi.resolveExecutionRuntime(group, payload);
}

function _markTradeTriggerError(group, message) {
    const trigger = _getTradeTrigger(group);
    if (!trigger) return;

    trigger.enabled = false;
    trigger.pendingRequest = false;
    trigger.status = 'error';
    trigger.lastError = message;
}

function _markCloseExecutionError(group, message) {
    const closeExecution = _getCloseExecution(group);
    if (!closeExecution) return;

    closeExecution.pendingRequest = false;
    closeExecution.status = 'error';
    closeExecution.lastError = message;
}

function _markExecutionError(group, message, runtimeKind) {
    if (runtimeKind === 'closeExecution') {
        _markCloseExecutionError(group, message);
        return;
    }

    _markTradeTriggerError(group, message);
}

function _isSoftTerminalBrokerStatus(status) {
    return ['Cancelled', 'Inactive', 'ApiCancelled'].includes(String(status || '').trim());
}

function _isManagedTerminalConfirmation(preview) {
    return !!(preview
        && preview.managedMode === true
        && String(preview.managedState || '').trim() === 'confirming_terminal');
}

function _groupHasOpenPositions(group) {
    const sessionLogic = _getSessionLogicApi();
    if (sessionLogic && typeof sessionLogic.groupHasOpenPosition === 'function') {
        return sessionLogic.groupHasOpenPosition(group);
    }

    return (group.legs || []).some((leg) => {
        const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
        const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== '';
        return pos > 0.0001 && !hasClosePrice;
    });
}

function _maybePromoteFilledTrialGroupToActive(group, runtime) {
    const sessionLogic = _getSessionLogicApi();
    if (!sessionLogic || typeof sessionLogic.getRenderableGroupViewMode !== 'function') {
        return;
    }

    const brokerStatus = String(runtime && runtime.lastPreview && runtime.lastPreview.status || '').trim();
    const executionMode = String(runtime && runtime.lastPreview && runtime.lastPreview.executionMode || '').trim();
    const renderMode = sessionLogic.getRenderableGroupViewMode(group);

    if (renderMode === 'trial'
        && brokerStatus === 'Filled'
        && executionMode === 'submit'
        && _groupHasCostForAllPositionedLegs(group)) {
        group.viewMode = 'active';
    }
}

function _sendValidatedComboSubmit(group, executionMode) {
    if (!group) {
        return false;
    }

    if (_isHistoricalMode()) {
        const trigger = _getTradeTrigger(group);
        if (!trigger) {
            return false;
        }

        trigger.pendingRequest = true;
        trigger.lastError = '';
        trigger.status = executionMode === 'test_submit' ? 'pending_test_submit' : 'pending_submit';
        return _applyHistoricalTriggerOrderPreview(group, executionMode);
    }

    if (!isWsConnected || !ws) {
        return false;
    }

    const tradeTriggerLogic = _getTradeTriggerLogicApi();
    const payload = tradeTriggerLogic
        && typeof tradeTriggerLogic.buildComboOrderRequestPayload === 'function'
        ? tradeTriggerLogic.buildComboOrderRequestPayload(group, state, executionMode)
        : null;

    if (!payload) {
        _markTradeTriggerError(group, 'Unable to build combo submit payload.');
        renderGroups();
        return false;
    }

    const trigger = _getTradeTrigger(group);
    if (!trigger) {
        return false;
    }

    trigger.pendingRequest = true;
    trigger.lastError = '';
    trigger.status = executionMode === 'test_submit' ? 'pending_test_submit' : 'pending_submit';
    ws.send(JSON.stringify(payload));
    renderGroups();
    return true;
}

function _requestTrialGroupComboOrder(group) {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.requestTrialGroupComboOrder !== 'function') {
        return;
    }
    transportApi.requestTrialGroupComboOrder(group);
}

function _applyComboOrderValidationResult(data) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyComboOrderValidationResult !== 'function') {
        return false;
    }
    return testApi.applyComboOrderValidationResult(data);
}

function _applyComboOrderResult(data) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyComboOrderResult !== 'function') {
        return false;
    }
    return testApi.applyComboOrderResult(data);
}

function _applyComboOrderStatusUpdate(data) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyComboOrderStatusUpdate !== 'function') {
        return false;
    }
    return testApi.applyComboOrderStatusUpdate(data);
}

function _applyComboOrderResumeResult(data) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyComboOrderResumeResult !== 'function') {
        return false;
    }
    return testApi.applyComboOrderResumeResult(data);
}

function _applyComboOrderConcedeResult(data) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyComboOrderConcedeResult !== 'function') {
        return false;
    }
    return testApi.applyComboOrderConcedeResult(data);
}

function _applyComboOrderCancelResult(data) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyComboOrderCancelResult !== 'function') {
        return false;
    }
    return testApi.applyComboOrderCancelResult(data);
}

function _applyComboOrderFillCostUpdate(data) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyComboOrderFillCostUpdate !== 'function') {
        return false;
    }
    return testApi.applyComboOrderFillCostUpdate(data);
}

function _applyComboOrderError(data) {
    const transportApi = _getComboOrderTransportApi();
    const testApi = transportApi && transportApi._test;
    if (!testApi || typeof testApi.applyComboOrderError !== 'function') {
        return false;
    }
    return testApi.applyComboOrderError(data);
}

function _applyHedgeOrderValidationResult(data) {
    const runtime = _getDeltaHedgeRuntime();
    const validation = data.validation || {};

    runtime.pendingRequest = false;
    runtime.lastValidation = validation;
    if (validation.valid !== true) {
        runtime.status = 'error';
        runtime.lastError = data.message || 'Hedge validation failed.';
        _refreshDeltaHedgeBrokerPreviewUi();
        return true;
    }

    if (!isWsConnected || !ws) {
        runtime.status = 'error';
        runtime.lastError = 'WebSocket is not connected.';
        _refreshDeltaHedgeBrokerPreviewUi();
        return true;
    }

    const pendingPayload = runtime.pendingPreviewPayload;
    if (!pendingPayload || typeof pendingPayload !== 'object') {
        runtime.status = 'error';
        runtime.lastError = 'Missing pending hedge preview payload.';
        _refreshDeltaHedgeBrokerPreviewUi();
        return true;
    }

    const previewPayload = {
        ...pendingPayload,
        action: 'preview_hedge_order',
        executionMode: 'preview',
    };
    runtime.pendingRequest = true;
    runtime.status = 'pending_preview';
    runtime.lastError = '';
    runtime.pendingPreviewPayload = previewPayload;
    ws.send(JSON.stringify(previewPayload));
    _refreshDeltaHedgeBrokerPreviewUi();
    return true;
}

function _applyHedgeOrderPreviewResult(data) {
    const runtime = _getDeltaHedgeRuntime();
    const preview = data.preview || data.order || {};
    if (Number(preview.executionPlanExpiresAtEpochMs) > 0 && !preview.executionPlanExpiresAt) {
        preview.executionPlanExpiresAt = new Date(Number(preview.executionPlanExpiresAtEpochMs)).toLocaleTimeString();
    }
    const qualifiedMultiplier = Number(preview.multiplier);
    const configuredMultiplier = Number(runtime.hedgeInstrument && runtime.hedgeInstrument.multiplier);
    const multiplierChanged = String(preview.secType || '').toUpperCase() === 'FUT'
        && Number.isFinite(qualifiedMultiplier) && qualifiedMultiplier > 0
        && qualifiedMultiplier !== configuredMultiplier;
    if (multiplierChanged && runtime.hedgeInstrument) {
        runtime.hedgeInstrument.multiplier = qualifiedMultiplier;
    }
    const brokerLimitPrice = Number(preview.limitPrice);
    const configuredLimitPrice = Number(runtime.limitPrice);
    const brokerPriceIncrement = Number(preview.priceIncrement);
    const limitPriceChanged = String(preview.orderType || '').toUpperCase() === 'LMT'
        && Number.isFinite(brokerLimitPrice) && brokerLimitPrice > 0
        && (!Number.isFinite(configuredLimitPrice) || brokerLimitPrice !== configuredLimitPrice);
    if (limitPriceChanged) {
        runtime.limitPrice = brokerLimitPrice;
        if (Number.isFinite(brokerPriceIncrement) && brokerPriceIncrement > 0) {
            runtime.limitPriceTickSize = brokerPriceIncrement;
        }
        if (runtime.limitPriceManualOverride !== true) {
            runtime.limitPriceSource = 'broker_quantized';
            runtime.limitPriceReferencePrice = Number.isFinite(configuredLimitPrice)
                ? configuredLimitPrice
                : runtime.limitPriceReferencePrice;
        }
        preview.priceAdjustmentMessage = Number.isFinite(configuredLimitPrice)
            ? `Broker adjusted limit ${configuredLimitPrice} to ${brokerLimitPrice}${Number.isFinite(brokerPriceIncrement) && brokerPriceIncrement > 0 ? ` (tick ${brokerPriceIncrement})` : ''}.`
            : `Broker set limit ${brokerLimitPrice}${Number.isFinite(brokerPriceIncrement) && brokerPriceIncrement > 0 ? ` (tick ${brokerPriceIncrement})` : ''}.`;
    }
    runtime.pendingRequest = false;
    runtime.status = multiplierChanged ? 'error' : 'previewed';
    runtime.lastError = multiplierChanged
        ? `TWS qualified multiplier ${qualifiedMultiplier}; recommendation changed. Run Broker Preview again.`
        : '';
    runtime.lastPreview = preview;
    runtime.lastPreviewAt = new Date().toISOString();
    runtime.pendingPreviewPayload = null;
    _refreshDeltaHedgeBrokerPreviewUi();
    if (!multiplierChanged && typeof window !== 'undefined' && typeof window.runDeltaHedgeAutoSupervisor === 'function') {
        window.runDeltaHedgeAutoSupervisor();
    }
    return true;
}

function _toFiniteNumberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function _toPositiveIntegerOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function _normalizeHedgeBrokerStatus(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function _isTerminalHedgeBrokerStatus(value) {
    return ['filled', 'cancelled', 'canceled', 'rejected', 'inactive', 'api_cancelled']
        .includes(_normalizeHedgeBrokerStatus(value));
}

function _isCancelPendingHedgeBrokerStatus(value) {
    return ['pendingcancel', 'pending_cancel', 'cancel_pending', 'cancelling']
        .includes(_normalizeHedgeBrokerStatus(value));
}

function _mapTerminalHedgeOrderState(value) {
    const status = _normalizeHedgeBrokerStatus(value);
    if (status === 'cancelled' || status === 'api_cancelled') {
        return 'canceled';
    }
    if (status === 'filled' || status === 'rejected' || status === 'inactive' || status === 'canceled') {
        return status;
    }
    return '';
}

function _stampDeltaHedgeOrderEvent(runtime) {
    if (!runtime || typeof runtime !== 'object') {
        return;
    }
    runtime.lastOrderEventAt = new Date().toISOString();
}

function _isPartialRemainingHedgeOrder(order) {
    const filledQuantity = Number(order && order.filledQuantity);
    const remainingQuantity = Number(order && order.remainingQuantity);
    return Number.isFinite(filledQuantity)
        && filledQuantity > 0
        && Number.isFinite(remainingQuantity)
        && remainingQuantity > 0;
}

function _markDeltaHedgePartialFillNeedsReview(runtime) {
    if (!runtime || !runtime.restingOrder) {
        return;
    }
    runtime.status = 'partial_fill_needs_review';
    runtime.orderState = 'stale_needs_review';
    runtime.restingOrder = {
        ...runtime.restingOrder,
        staleReason: 'partial_fill_needs_review',
    };
}

function _buildDeltaHedgeRestingOrder(order, fallbackPayload) {
    const rawOrder = order && typeof order === 'object' ? order : {};
    const fallback = fallbackPayload && typeof fallbackPayload === 'object' ? fallbackPayload : {};
    const quantity = _toPositiveIntegerOrNull(rawOrder.quantity ?? fallback.quantity) || 0;
    const filledQuantity = _toPositiveIntegerOrNull(
        rawOrder.filledQuantity ?? rawOrder.filled ?? fallback.filledQuantity
    ) || 0;
    const remainingQuantity = _toPositiveIntegerOrNull(
        rawOrder.remainingQuantity ?? rawOrder.remaining
    );

    return {
        hedgeId: rawOrder.hedgeId || fallback.hedgeId || null,
        orderId: rawOrder.orderId ?? fallback.orderId ?? null,
        permId: rawOrder.permId ?? fallback.permId ?? null,
        conId: rawOrder.conId ?? fallback.conId ?? null,
        symbol: String(rawOrder.symbol || fallback.symbol || '').trim().toUpperCase(),
        localSymbol: rawOrder.localSymbol || fallback.localSymbol || '',
        secType: String(rawOrder.secType || fallback.secType || '').trim().toUpperCase(),
        contractMonth: String(rawOrder.contractMonth || fallback.contractMonth || '').trim().slice(0, 6),
        multiplier: _toFiniteNumberOrNull(rawOrder.multiplier ?? fallback.multiplier),
        deltaPerUnit: _toFiniteNumberOrNull(rawOrder.deltaPerUnit ?? fallback.deltaPerUnit),
        side: String(rawOrder.orderAction || fallback.orderAction || '').trim().toUpperCase(),
        quantity,
        filledQuantity,
        remainingQuantity: remainingQuantity !== null
            ? remainingQuantity
            : Math.max(quantity - filledQuantity, 0),
        orderType: String(rawOrder.orderType || fallback.orderType || 'LMT').trim().toUpperCase(),
        limitPrice: _toFiniteNumberOrNull(rawOrder.limitPrice ?? fallback.limitPrice),
        referencePrice: _toFiniteNumberOrNull(fallback.referencePrice),
        placedAtNetDelta: _toFiniteNumberOrNull(rawOrder.currentNetDelta ?? fallback.currentNetDelta),
        projectedNetDeltaAfterFullFill: _toFiniteNumberOrNull(
            rawOrder.projectedNetDelta ?? fallback.projectedNetDelta
        ),
        targetLower: _toFiniteNumberOrNull(rawOrder.targetLower ?? fallback.targetLower),
        targetUpper: _toFiniteNumberOrNull(rawOrder.targetUpper ?? fallback.targetUpper),
        placedAt: new Date().toISOString(),
        status: String(rawOrder.status || 'Submitted'),
        staleReason: '',
    };
}

function _getDeltaHedgeFillKey(fill) {
    const executionId = String(fill && fill.executionId || '').trim();
    if (executionId) {
        return `exec:${executionId}`;
    }
    return [
        'fill',
        fill && fill.orderId,
        fill && fill.permId,
        fill && fill.filledQuantity,
        fill && fill.avgFillPrice,
    ].join(':');
}

function _resolveHedgeFillSignedQuantity(fill) {
    const quantity = Number(fill && (fill.lastFillQuantity ?? fill.fillQuantity ?? fill.filledQuantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return 0;
    }
    const action = String(fill && (fill.orderAction || fill.executionSide) || '').trim().toUpperCase();
    if (action === 'SELL' || action === 'SLD') {
        return -quantity;
    }
    if (action === 'BUY' || action === 'BOT') {
        return quantity;
    }
    return 0;
}

function _mergeHedgeCost(existing, signedQuantity, fillPrice) {
    const oldPos = Number(existing && existing.pos);
    const oldCost = Number(existing && existing.cost);
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
        return Number.isFinite(oldCost) ? oldCost : 0;
    }
    if (!Number.isFinite(oldPos) || oldPos === 0 || Math.sign(oldPos) === Math.sign(signedQuantity)) {
        const oldAbs = Number.isFinite(oldPos) ? Math.abs(oldPos) : 0;
        const fillAbs = Math.abs(signedQuantity);
        const totalAbs = oldAbs + fillAbs;
        if (totalAbs <= 0) {
            return fillPrice;
        }
        return ((oldAbs * (Number.isFinite(oldCost) ? oldCost : fillPrice)) + (fillAbs * fillPrice)) / totalAbs;
    }

    const nextPos = oldPos + signedQuantity;
    if (nextPos === 0 || Math.sign(nextPos) === Math.sign(oldPos)) {
        return Number.isFinite(oldCost) ? oldCost : fillPrice;
    }
    return fillPrice;
}

function _buildDeltaHedgeFillRowId(fill) {
    const explicitId = String(fill && fill.hedgeId || '').trim();
    if (explicitId) {
        return explicitId;
    }
    const secType = String(fill && fill.secType || 'STK').trim().toLowerCase() || 'stk';
    const symbol = String(fill && fill.symbol || '').trim().toLowerCase() || 'unknown';
    const contractMonth = String(fill && fill.contractMonth || '').trim().toLowerCase() || 'spot';
    return ['delta_hedge', secType, symbol, contractMonth].join('_');
}

function _applyHedgeFillToRows(fill) {
    const signedQuantity = _resolveHedgeFillSignedQuantity(fill);
    const fillPrice = Number(fill && (fill.lastFillPrice ?? fill.avgFillPrice));
    if (!Number.isFinite(signedQuantity) || signedQuantity === 0) {
        return false;
    }

    if (!Array.isArray(state.hedges)) {
        state.hedges = [];
    }
    const hedgeId = _buildDeltaHedgeFillRowId(fill);
    let hedge = state.hedges.find(candidate => candidate && candidate.id === hedgeId);
    const nextCostSource = String(fill && fill.costSource || 'execution_report');
    if (!hedge) {
        hedge = {
            id: hedgeId,
            symbol: String(fill && fill.symbol || '').trim().toUpperCase(),
            localSymbol: String(fill && fill.localSymbol || '').trim(),
            secType: String(fill && fill.secType || 'STK').trim().toUpperCase(),
            contractMonth: String(fill && fill.contractMonth || '').trim().slice(0, 6),
            exchange: String(fill && fill.exchange || '').trim().toUpperCase(),
            currency: String(fill && fill.currency || 'USD').trim().toUpperCase(),
            conId: fill && fill.conId != null ? fill.conId : null,
            pos: 0,
            cost: Number.isFinite(fillPrice) ? fillPrice : 0,
            currentPrice: Number.isFinite(fillPrice) ? fillPrice : 0,
            currentPriceSource: nextCostSource,
            liveData: true,
            multiplier: Number.isFinite(Number(fill && fill.multiplier)) ? Number(fill.multiplier) : 1,
            deltaPerUnit: Number.isFinite(Number(fill && fill.deltaPerUnit)) ? Number(fill.deltaPerUnit) : 1,
        };
        state.hedges.push(hedge);
    }

    const oldPos = Number(hedge.pos) || 0;
    hedge.cost = _mergeHedgeCost(hedge, signedQuantity, fillPrice);
    hedge.pos = oldPos + signedQuantity;
    if (Number.isFinite(fillPrice) && fillPrice > 0) {
        hedge.currentPrice = fillPrice;
        hedge.currentPriceSource = nextCostSource;
    }
    if (fill && fill.symbol) {
        hedge.symbol = String(fill.symbol).trim().toUpperCase();
    }
    if (fill && fill.secType) hedge.secType = String(fill.secType).trim().toUpperCase();
    if (fill && fill.contractMonth) hedge.contractMonth = String(fill.contractMonth).trim().slice(0, 6);
    if (Number.isFinite(Number(fill && fill.multiplier)) && Number(fill.multiplier) > 0) hedge.multiplier = Number(fill.multiplier);
    if (Number.isFinite(Number(fill && fill.deltaPerUnit)) && Number(fill.deltaPerUnit) > 0) hedge.deltaPerUnit = Number(fill.deltaPerUnit);
    hedge.liveData = true;
    return true;
}

function _applyHedgeOrderSubmitResult(data) {
    const runtime = _getDeltaHedgeRuntime();
    const order = data.order || data.preview || {};
    runtime.pendingRequest = false;
    _stampDeltaHedgeOrderEvent(runtime);
    runtime.status = 'submitted';
    runtime.orderState = 'resting_locked';
    runtime.lastError = '';
    runtime.lastPreview = order;
    runtime.restingOrder = _buildDeltaHedgeRestingOrder(order, runtime.pendingSubmitPayload);
    runtime.pendingSubmitPayload = null;
    _refreshDeltaHedgeBrokerPreviewUi();
    return true;
}

function _applyHedgeOrderStatusUpdate(data) {
    const runtime = _getDeltaHedgeRuntime();
    const orderStatus = data.orderStatus || {};
    const status = String(orderStatus.status || '').trim();
    runtime.lastPreview = {
        ...(runtime.lastPreview || {}),
        ...orderStatus,
    };
    runtime.restingOrder = {
        ...(runtime.restingOrder || {}),
        orderId: orderStatus.orderId ?? (runtime.restingOrder && runtime.restingOrder.orderId) ?? null,
        permId: orderStatus.permId ?? (runtime.restingOrder && runtime.restingOrder.permId) ?? null,
        status: status || (runtime.restingOrder && runtime.restingOrder.status) || '',
        filledQuantity: _toPositiveIntegerOrNull(orderStatus.filled)
            ?? (runtime.restingOrder && runtime.restingOrder.filledQuantity)
            ?? 0,
        remainingQuantity: _toPositiveIntegerOrNull(orderStatus.remaining)
            ?? (runtime.restingOrder && runtime.restingOrder.remainingQuantity)
            ?? null,
        avgFillPrice: _toFiniteNumberOrNull(orderStatus.avgFillPrice)
            ?? (runtime.restingOrder && runtime.restingOrder.avgFillPrice)
            ?? null,
        lastFillPrice: _toFiniteNumberOrNull(orderStatus.lastFillPrice)
            ?? (runtime.restingOrder && runtime.restingOrder.lastFillPrice)
            ?? null,
        cancelRequested: orderStatus.cancelRequested === true
            || (runtime.restingOrder && runtime.restingOrder.cancelRequested === true),
    };
    runtime.pendingRequest = false;
    _stampDeltaHedgeOrderEvent(runtime);
    if (_isTerminalHedgeBrokerStatus(status)) {
        const terminalState = _mapTerminalHedgeOrderState(status);
        runtime.status = terminalState || _normalizeHedgeBrokerStatus(status);
        runtime.orderState = terminalState || runtime.status;
    } else if (_isCancelPendingHedgeBrokerStatus(status) || orderStatus.cancelRequested === true) {
        runtime.status = 'cancel_pending';
        runtime.orderState = 'resting_locked';
    } else if (_isPartialRemainingHedgeOrder(runtime.restingOrder)) {
        _markDeltaHedgePartialFillNeedsReview(runtime);
    } else {
        runtime.status = 'submitted';
        runtime.orderState = 'resting_locked';
    }
    runtime.lastError = '';
    _refreshDeltaHedgeBrokerPreviewUi();
    if (typeof window !== 'undefined' && typeof window.runDeltaHedgeAutoSupervisor === 'function') {
        window.runDeltaHedgeAutoSupervisor();
    }
    return true;
}

function _applyHedgeOrderCancelResult(data) {
    const result = {
        ...data,
        orderStatus: data.orderStatus || {},
    };
    if (!result.orderStatus.status) {
        result.orderStatus.status = 'PendingCancel';
    }
    result.orderStatus.cancelRequested = true;
    return _applyHedgeOrderStatusUpdate(result);
}

function _applyHedgeOrderFillUpdate(data) {
    const runtime = _getDeltaHedgeRuntime();
    const fill = data.orderFill || {};
    const fillKey = _getDeltaHedgeFillKey(fill);
    if (!runtime.seenHedgeFillKeys || typeof runtime.seenHedgeFillKeys !== 'object') {
        runtime.seenHedgeFillKeys = {};
    }
    if (runtime.seenHedgeFillKeys[fillKey]) {
        return true;
    }
    runtime.seenHedgeFillKeys[fillKey] = true;

    const changedHedgeRows = _applyHedgeFillToRows(fill);
    _stampDeltaHedgeOrderEvent(runtime);
    runtime.restingOrder = {
        ...(runtime.restingOrder || {}),
        orderId: fill.orderId ?? (runtime.restingOrder && runtime.restingOrder.orderId) ?? null,
        permId: fill.permId ?? (runtime.restingOrder && runtime.restingOrder.permId) ?? null,
        side: String(fill.orderAction || (runtime.restingOrder && runtime.restingOrder.side) || '').trim().toUpperCase(),
        quantity: _toPositiveIntegerOrNull(fill.quantity)
            ?? (runtime.restingOrder && runtime.restingOrder.quantity)
            ?? 0,
        filledQuantity: _toPositiveIntegerOrNull(fill.filledQuantity)
            ?? (runtime.restingOrder && runtime.restingOrder.filledQuantity)
            ?? 0,
        remainingQuantity: Math.max(
            (_toPositiveIntegerOrNull(fill.quantity) ?? (runtime.restingOrder && runtime.restingOrder.quantity) ?? 0)
            - (_toPositiveIntegerOrNull(fill.filledQuantity) ?? 0),
            0
        ),
        avgFillPrice: _toFiniteNumberOrNull(fill.avgFillPrice)
            ?? (runtime.restingOrder && runtime.restingOrder.avgFillPrice)
            ?? null,
        lastFillPrice: _toFiniteNumberOrNull(fill.lastFillPrice)
            ?? (runtime.restingOrder && runtime.restingOrder.lastFillPrice)
            ?? null,
        status: (runtime.restingOrder && runtime.restingOrder.status) || 'Submitted',
        staleReason: (runtime.restingOrder && runtime.restingOrder.staleReason) || '',
    };
    if (_isPartialRemainingHedgeOrder(runtime.restingOrder)) {
        _markDeltaHedgePartialFillNeedsReview(runtime);
    } else {
        runtime.status = 'submitted';
        runtime.orderState = 'resting_locked';
    }
    runtime.lastError = '';
    if (changedHedgeRows) {
        if (typeof renderHedges === 'function') {
            renderHedges();
        } else if (typeof updateDerivedValues === 'function') {
            updateDerivedValues();
        }
        if (typeof handleLiveSubscriptions === 'function') {
            handleLiveSubscriptions({ automatic: true });
        }
    }
    _refreshDeltaHedgeBrokerPreviewUi();
    if (typeof window !== 'undefined' && typeof window.runDeltaHedgeAutoSupervisor === 'function') {
        window.runDeltaHedgeAutoSupervisor();
    }
    return true;
}

function _selectRecoverableHedgeOrder(orders, runtime) {
    const list = Array.isArray(orders) ? orders : [];
    if (list.length === 0) {
        return null;
    }
    const config = _normalizeDeltaHedgeConfig(runtime);
    const expectedHedgeId = _buildDeltaHedgeRuntimeHedgeId(config);
    const instrument = config.hedgeInstrument || {};
    const expectedSecType = String(instrument.secType || '').trim().toUpperCase();
    const expectedSymbol = String(instrument.symbol || '').trim().toUpperCase();
    const expectedContractMonth = String(instrument.contractMonth || '').trim();

    return list.find((order) => {
        if (!order || typeof order !== 'object') {
            return false;
        }
        if (_isTerminalHedgeBrokerStatus(order.status)) {
            return false;
        }
        const hedgeId = String(order.hedgeId || '').trim();
        if (expectedHedgeId && hedgeId && hedgeId === expectedHedgeId) {
            return true;
        }
        const secType = String(order.secType || '').trim().toUpperCase();
        const symbol = String(order.symbol || '').trim().toUpperCase();
        const contractMonth = String(order.contractMonth || '').trim();
        return expectedSecType
            && expectedSymbol
            && secType === expectedSecType
            && symbol === expectedSymbol
            && contractMonth === expectedContractMonth;
    }) || null;
}

function _applyActiveHedgeOrdersSnapshot(data) {
    const runtime = _getDeltaHedgeRuntime();
    if (_hasActiveDeltaHedgeRestingOrder(runtime)) {
        return true;
    }
    const order = _selectRecoverableHedgeOrder(data && data.orders, runtime);
    if (!order) {
        return true;
    }

    runtime.pendingRequest = false;
    runtime.lastError = '';
    runtime.status = 'submitted';
    runtime.orderState = 'resting_locked';
    runtime.lastPreview = {
        ...(runtime.lastPreview || {}),
        ...order,
    };
    runtime.restingOrder = _buildDeltaHedgeRestingOrder(order, order);
    if (_isPartialRemainingHedgeOrder(runtime.restingOrder)) {
        _markDeltaHedgePartialFillNeedsReview(runtime);
    }
    _refreshDeltaHedgeBrokerPreviewUi();
    if (typeof window !== 'undefined' && typeof window.runDeltaHedgeAutoSupervisor === 'function') {
        window.runDeltaHedgeAutoSupervisor();
    }
    return true;
}

function _applyHedgeOrderError(data) {
    _markDeltaHedgeError(data.message || 'Hedge order request failed.');
    return true;
}

function _handleHedgeOrderMessage(data) {
    if (!data || typeof data !== 'object' || !data.action) {
        return false;
    }

    if (data.action === 'hedge_order_validation_result') {
        return _applyHedgeOrderValidationResult(data);
    }

    if (data.action === 'hedge_order_preview_result') {
        return _applyHedgeOrderPreviewResult(data);
    }

    if (data.action === 'hedge_order_submit_result') {
        return _applyHedgeOrderSubmitResult(data);
    }

    if (data.action === 'hedge_order_status_update') {
        return _applyHedgeOrderStatusUpdate(data);
    }

    if (data.action === 'hedge_order_cancel_result') {
        return _applyHedgeOrderCancelResult(data);
    }

    if (data.action === 'hedge_order_fill_update') {
        return _applyHedgeOrderFillUpdate(data);
    }

    if (data.action === 'active_hedge_orders_snapshot') {
        return _applyActiveHedgeOrdersSnapshot(data);
    }

    if (data.action === 'hedge_order_error') {
        return _applyHedgeOrderError(data);
    }

    return false;
}

function _handleComboOrderMessage(data) {
    const transportApi = _getComboOrderTransportApi();
    if (!transportApi || typeof transportApi.handleMessage !== 'function') {
        return false;
    }
    return transportApi.handleMessage(data);
}

function _handlePortfolioAvgCostMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'portfolio_avg_cost_update') {
        return false;
    }

    return _applyPortfolioAvgCostUpdate(data);
}

function _applyManagedAccountsUpdate(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }

    const nextAccounts = Array.isArray(data.accounts)
        ? data.accounts
            .map((account) => _normalizeLiveComboOrderAccount(account))
            .filter((account, index, list) => account && list.indexOf(account) === index)
        : [];
    const nextConnected = data.ibConnected === true;
    const previousAccounts = Array.isArray(state.liveComboOrderAccounts)
        ? state.liveComboOrderAccounts.map((account) => _normalizeLiveComboOrderAccount(account))
        : [];
    const previousSelection = _getSelectedLiveComboOrderAccount();
    let nextSelection = previousSelection;

    if (!nextSelection || !nextAccounts.includes(nextSelection)) {
        nextSelection = nextAccounts.length === 1 ? nextAccounts[0] : '';
    }

    const accountsChanged = JSON.stringify(previousAccounts) !== JSON.stringify(nextAccounts);
    const selectionChanged = previousSelection !== nextSelection;
    const connectedChanged = (state.liveComboOrderAccountsConnected === true) !== nextConnected;

    state.liveComboOrderAccounts = nextAccounts;
    state.liveComboOrderAccountsConnected = nextConnected;
    state.selectedLiveComboOrderAccount = nextSelection;

    if (accountsChanged || selectionChanged || connectedChanged) {
        const controlPanelUi = _getControlPanelUiApi();
        if (controlPanelUi && typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
            _runUiRefreshSafely('boundDynamicControls', () => {
                controlPanelUi.refreshBoundDynamicControls();
            });
        }
        const deltaHedgeUi = _getDeltaHedgeUiApi();
        if (deltaHedgeUi && typeof deltaHedgeUi.refreshDeltaHedgePanel === 'function') {
            _runUiRefreshSafely('deltaHedgePanel', () => {
                deltaHedgeUi.refreshDeltaHedgePanel(state);
            });
        }
    }

    return true;
}

function _handleManagedAccountsMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'managed_accounts_update') {
        return false;
    }

    return _applyManagedAccountsUpdate(data);
}

function evaluateTrialTradeTriggers() {
    const evaluator = _getTradeTriggerLogicApi();
    if (!evaluator || typeof evaluator.shouldFireTradeTrigger !== 'function') {
        return;
    }

    state.groups.forEach(group => {
        const renderMode = typeof evaluator.getRenderableGroupViewMode === 'function'
            ? evaluator.getRenderableGroupViewMode(group)
            : (group.viewMode || 'active');

        if (evaluator.shouldFireTradeTrigger(group, state.underlyingPrice, renderMode)) {
            _requestTrialGroupComboOrder(group);
        }
    });
}

function evaluateTriggeredOrderExitConditions() {
    const evaluator = _getTradeTriggerLogicApi();
    if (!evaluator || typeof evaluator.shouldCancelTriggeredOrder !== 'function') {
        return;
    }

    state.groups.forEach(group => {
        if (evaluator.shouldCancelTriggeredOrder(group, state.underlyingPrice)) {
            requestCancelManagedComboOrder(group, 'exit_condition');
        }
    });
}

function _collectLiveIvNeighbors(targetLeg) {
    const targetStrike = Number(targetLeg && targetLeg.strike);
    if (!Number.isFinite(targetStrike)) {
        return { lower: null, upper: null };
    }

    let lower = null;
    let upper = null;

    state.groups.forEach(group => {
        (group.legs || []).forEach(candidate => {
            if (candidate === targetLeg) return;
            if (String(candidate.type || '').toLowerCase() !== String(targetLeg.type || '').toLowerCase()) return;
            if (String(candidate.expDate || '') !== String(targetLeg.expDate || '')) return;
            if (candidate.ivSource !== 'live' || !Number.isFinite(candidate.iv) || candidate.iv <= 0) return;

            const candidateStrike = Number(candidate.strike);
            if (!Number.isFinite(candidateStrike)) return;

            if (candidateStrike < targetStrike) {
                if (!lower || candidateStrike > lower.strike) {
                    lower = { strike: candidateStrike, iv: candidate.iv };
                }
            } else if (candidateStrike > targetStrike) {
                if (!upper || candidateStrike < upper.strike) {
                    upper = { strike: candidateStrike, iv: candidate.iv };
                }
            }
        });
    });

    return { lower, upper };
}

function _applyEstimatedOptionIvFallback(changedGroupIds) {
    if (_isHistoricalMode()) {
        return false;
    }

    let changed = false;

    state.groups.forEach(group => {
        if (!group.liveData) {
            return;
        }

        (group.legs || []).forEach(leg => {
            if (_isUnderlyingLeg(leg)) {
                return;
            }
            if (String(leg.type || '').toLowerCase() !== 'call' && String(leg.type || '').toLowerCase() !== 'put') {
                return;
            }
            if (leg.ivManualOverride === true) {
                return;
            }
            if (leg.ivSource === 'live') {
                return;
            }

            const neighbors = _collectLiveIvNeighbors(leg);
            if (neighbors.lower && neighbors.upper) {
                const estimatedIv = (neighbors.lower.iv + neighbors.upper.iv) / 2;
                const needsUpdate = leg.ivSource !== 'estimated' || Math.abs((leg.iv || 0) - estimatedIv) > 0.000001;
                if (needsUpdate) {
                    leg.iv = estimatedIv;
                    leg.ivSource = 'estimated';
                    leg.ivManualOverride = false;
                    changed = true;
                    if (changedGroupIds instanceof Set && group && group.id) {
                        changedGroupIds.add(group.id);
                    }
                }
            } else if (leg.ivSource === 'estimated') {
                leg.ivSource = 'missing';
                changed = true;
                if (changedGroupIds instanceof Set && group && group.id) {
                    changedGroupIds.add(group.id);
                }
            }
        });
    });

    return changed;
}

// -------------------------------------------------------------
// Live Market Data Processing
// -------------------------------------------------------------

function _applyHistoricalDiscountCurveMetadata(replay, effectiveDate) {
    const previousFingerprint = _discountCurveFingerprint(state.discountCurve);
    const previousError = String(state.discountCurveLastError || '');
    const directSnapshot = replay && replay.discountCurve && typeof replay.discountCurve === 'object'
        ? replay.discountCurve
        : null;
    const curveEffectiveDate = _normalizeHistoricalDateKey(
        directSnapshot && (directSnapshot.curveAsOf || directSnapshot.asOf || directSnapshot.effectiveDate)
        || replay && replay.yieldCurveEffectiveDate
    );
    const replayEffectiveDate = _normalizeHistoricalDateKey(effectiveDate);
    const rawPoints = Array.isArray(directSnapshot && directSnapshot.points)
        ? directSnapshot.points
        : Array.isArray(replay && replay.yieldCurvePoints)
            ? replay.yieldCurvePoints
        : [];
    let nextCurve = null;
    let errorMessage = '';

    if (!curveEffectiveDate || rawPoints.length === 0) {
        errorMessage = `No yield curve is available on or before replay date ${replayEffectiveDate || '(unknown)'}.`;
    } else if (!replayEffectiveDate || curveEffectiveDate > replayEffectiveDate) {
        errorMessage = `Rejected future yield curve ${curveEffectiveDate} for replay date ${replayEffectiveDate || '(unknown)'}.`;
    } else {
        try {
            if (directSnapshot) {
                nextCurve = _createDiscountCurveFromSnapshot(directSnapshot, {
                    id: `historical-usd-reference-${curveEffectiveDate}`,
                });
            } else {
                const source = String(replay.yieldCurveSource || 'historical_yield_curve').trim()
                    || 'historical_yield_curve';
                const points = rawPoints.map((point) => {
                    const normalizedPoint = point && typeof point === 'object'
                        ? { ...point }
                        : {};
                    if (normalizedPoint.parYield === undefined
                        && normalizedPoint.continuousRate === undefined) {
                        normalizedPoint.parYield = normalizedPoint.rate;
                    }
                    return normalizedPoint;
                });
                nextCurve = _createDiscountCurveFromSnapshot({
                    schemaVersion: 1,
                    kind: 'treasury_discount_curve',
                    effectiveDate: curveEffectiveDate,
                    quoteAsOf: `${curveEffectiveDate}T00:00:00Z`,
                    source,
                    points,
                    curveSemantics: 'cmt_par_yield',
                    inputSemantics: 'cmt_par_yield',
                    discountRateSemantics: 'continuous_zero_proxy_from_cmt_par_yield',
                    quality: {
                        status: 'degraded',
                        flags: ['historical_snapshot', 'cmt_par_yield_proxy', 'not_bootstrapped_zero_curve'],
                    },
                }, {
                    id: `historical-usd-treasury-${curveEffectiveDate}`,
                });
            }
        } catch (error) {
            errorMessage = error && error.message
                ? `Invalid historical yield curve: ${error.message}`
                : 'Invalid historical yield curve.';
        }
    }

    // Historical replay must never retain a curve from a different (possibly
    // future) replay date. Missing/invalid as-of data therefore falls back to
    // the replay snapshot's scalar rate instead of preserving the old curve.
    state.discountCurve = _isUsableDiscountCurve(nextCurve) ? nextCurve : null;
    state.discountCurveLastError = errorMessage;
    return previousFingerprint !== _discountCurveFingerprint(state.discountCurve)
        || previousError !== errorMessage;
}

function _applyHistoricalReplayMetadata(data) {
    if (!data || !data.historicalReplay || typeof data.historicalReplay !== 'object') {
        return false;
    }

    let stateChanged = false;
    const availableStartDate = String(data.historicalReplay.availableStartDate || '').trim();
    const availableEndDate = String(data.historicalReplay.availableEndDate || '').trim();
    const observedTradingDates = Array.isArray(data.historicalReplay.observedTradingDates)
        ? data.historicalReplay.observedTradingDates
            .map((value) => String(value || '').trim())
            .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
        : [];
    const effectiveDate = String(data.historicalReplay.effectiveDate || '').trim();
    const riskFreeRate = parseFloat(data.riskFreeRate);
    if (_isHistoricalMode() && effectiveDate) {
        if (availableStartDate && state.historicalAvailableStartDate !== availableStartDate) {
            state.historicalAvailableStartDate = availableStartDate;
            stateChanged = true;
        }
        if (availableEndDate && state.historicalAvailableEndDate !== availableEndDate) {
            state.historicalAvailableEndDate = availableEndDate;
            stateChanged = true;
        }
        if (observedTradingDates.length > 0) {
            const currentDates = Array.isArray(state.historicalTradingDates)
                ? state.historicalTradingDates
                : [];
            if (currentDates.length !== observedTradingDates.length
                || currentDates[0] !== observedTradingDates[0]
                || currentDates[currentDates.length - 1] !== observedTradingDates[observedTradingDates.length - 1]) {
                state.historicalTradingDates = observedTradingDates;
                stateChanged = true;
            }
        }
        if ((!state.baseDate)
            || (availableStartDate && state.baseDate < availableStartDate)
            || (availableEndDate && state.baseDate > availableEndDate)) {
            state.baseDate = effectiveDate;
            stateChanged = true;
        }
        if (state.historicalQuoteDate !== effectiveDate) {
            state.historicalQuoteDate = effectiveDate;
            stateChanged = true;
        }
        if (!state.simulatedDate || state.simulatedDate < effectiveDate) {
            state.simulatedDate = effectiveDate;
            stateChanged = true;
        }
        if (Number.isFinite(riskFreeRate) && riskFreeRate >= 0) {
            const currentRate = parseFloat(state.interestRate);
            if (!Number.isFinite(currentRate) || Math.abs(currentRate - riskFreeRate) > 0.0000001) {
                state.interestRate = riskFreeRate;
                stateChanged = true;
            }
        }
        stateChanged = _applyHistoricalDiscountCurveMetadata(
            data.historicalReplay,
            effectiveDate
        ) || stateChanged;
        const controlPanelUi = _getControlPanelUiApi();
        if (controlPanelUi && typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
            _runUiRefreshSafely('boundDynamicControls', () => {
                controlPanelUi.refreshBoundDynamicControls();
            });
        }
    }

    return stateChanged;
}

function _clearHistoricalExpiryUnderlyingAnchor(leg) {
    let changed = false;

    if (leg.historicalExpiryUnderlyingPrice !== null && leg.historicalExpiryUnderlyingPrice !== undefined) {
        leg.historicalExpiryUnderlyingPrice = null;
        changed = true;
    }

    if (leg.historicalExpiryUnderlyingDate) {
        leg.historicalExpiryUnderlyingDate = '';
        changed = true;
    }

    return changed;
}

function _applyHistoricalExpiryUnderlyingAnchors(data) {
    if (!_isHistoricalMode() || !data || !data.historicalReplay || typeof data.historicalReplay !== 'object') {
        return false;
    }

    const effectiveDate = _normalizeHistoricalDateKey(data.historicalReplay.effectiveDate);
    const expiryUnderlyingQuotes = data.historicalReplay.expiryUnderlyingQuotes
        && typeof data.historicalReplay.expiryUnderlyingQuotes === 'object'
        ? data.historicalReplay.expiryUnderlyingQuotes
        : {};
    const normalizedExpiryUnderlyingQuotes = {};
    Object.entries(expiryUnderlyingQuotes).forEach(([dateKey, snapshot]) => {
        const normalizedDateKey = _normalizeHistoricalDateKey(dateKey)
            || _normalizeHistoricalDateKey(snapshot && (snapshot.requestedDate || snapshot.effectiveDate));
        if (!normalizedDateKey) {
            return;
        }
        normalizedExpiryUnderlyingQuotes[normalizedDateKey] = snapshot;
    });
    let stateChanged = false;

    (state.groups || []).forEach((group) => {
        (group.legs || []).forEach((leg) => {
            if (_isUnderlyingLeg(leg)) {
                return;
            }

            const expiryDate = _normalizeHistoricalDateKey(leg && leg.expDate);
            if (!expiryDate || !effectiveDate || expiryDate > effectiveDate) {
                stateChanged = _clearHistoricalExpiryUnderlyingAnchor(leg) || stateChanged;
                return;
            }

            const expirySnapshot = normalizedExpiryUnderlyingQuotes[expiryDate];
            const nextPrice = expirySnapshot ? parseFloat(expirySnapshot.price) : null;
            const nextEffectiveDate = expirySnapshot ? String(expirySnapshot.effectiveDate || '').trim() : '';
            if (!Number.isFinite(nextPrice)) {
                stateChanged = _clearHistoricalExpiryUnderlyingAnchor(leg) || stateChanged;
                return;
            }

            if (Math.abs((parseFloat(leg.historicalExpiryUnderlyingPrice) || 0) - nextPrice) > 0.000001
                || String(leg.historicalExpiryUnderlyingDate || '') !== nextEffectiveDate) {
                leg.historicalExpiryUnderlyingPrice = nextPrice;
                leg.historicalExpiryUnderlyingDate = nextEffectiveDate;
                stateChanged = true;
            }
        });
    });

    return stateChanged;
}

function _markOptionQuoteMissing(leg) {
    let stateChanged = false;

    if (leg.currentPriceSource !== 'missing') {
        leg.currentPriceSource = 'missing';
        stateChanged = true;
    }

    if (leg.ivManualOverride !== true && leg.ivSource !== 'missing') {
        leg.ivSource = 'missing';
        stateChanged = true;
    }

    return stateChanged;
}

function _applyLiveOptionExpiryTiming(leg, quote) {
    if (!leg || !quote || typeof quote !== 'object') {
        return false;
    }
    const legExpiry = String(leg.expDate || '').replace(/\D/g, '').slice(0, 8);
    const lastTradeDate = String(quote.lastTradeDate || '').replace(/\D/g, '').slice(0, 8);
    const expiryAsOf = String(quote.expiryAsOf || '').trim();
    if (!legExpiry || lastTradeDate !== legExpiry || !Number.isFinite(Date.parse(expiryAsOf))) {
        return false;
    }
    const next = {
        expiryAsOf,
        expiryTimingSource: String(quote.expiryTimingSource || 'ib_contract_details'),
        lastTradeDate,
        lastTradeTime: String(quote.lastTradeTime || ''),
        expiryTimeZoneId: String(quote.timeZoneId || ''),
        realExpirationDate: String(quote.realExpirationDate || ''),
    };
    let changed = false;
    Object.entries(next).forEach(([key, value]) => {
        if (leg[key] !== value) {
            leg[key] = value;
            changed = true;
        }
    });
    return changed;
}

function _applyHistoricalBaseDateCosts() {
    if (!_isHistoricalMode() || _getHistoricalReplayDate() !== _getHistoricalEntryDate()) {
        return false;
    }

    let stateChanged = false;

    (state.groups || []).forEach((group) => {
        if (!group || group.liveData !== true) {
            return;
        }

        const trigger = _getTradeTrigger(group);
        if ((group.viewMode || 'trial') === 'trial' && trigger && trigger.enabled === true) {
            return;
        }

        let capturedEveryOpenLeg = true;
        (group.legs || []).forEach((leg) => {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            if (pos < 0.0001 || (leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined)) {
                return;
            }

            const hasLockedManualCost = Number.isFinite(parseFloat(leg.cost))
                && parseFloat(leg.cost) > 0
                && leg.costSource
                && leg.costSource !== 'historical_base';
            if (hasLockedManualCost) {
                return;
            }

            const baseCost = _resolveHistoricalReplayClosePrice(leg, false);
            if (!Number.isFinite(baseCost) || baseCost <= 0) {
                capturedEveryOpenLeg = false;
                return;
            }

            if (Math.abs((parseFloat(leg.cost) || 0) - baseCost) > 0.000001 || leg.costSource !== 'historical_base') {
                leg.cost = baseCost;
                leg.costSource = 'historical_base';
                stateChanged = true;
            }
        });

        if (capturedEveryOpenLeg
            && _groupHasCostForAllPositionedLegs(group)
            && (group.viewMode || 'trial') === 'trial') {
            group.viewMode = 'active';
            stateChanged = true;
        }
    });

    return stateChanged;
}

function _applyHistoricalAutoExpirySettlement(targetGroup = null) {
    if (!_isHistoricalMode()) {
        return false;
    }

    const replayDate = _normalizeHistoricalDateKey(_getHistoricalReplayDate());
    if (!replayDate) {
        return false;
    }

    let stateChanged = false;

    const groupsToSync = targetGroup ? [targetGroup] : (state.groups || []);
    groupsToSync.forEach((group) => {
        if (!group || !_groupHasCostForAllPositionedLegs(group)) {
            return;
        }

        const autoCloseAtExpiry = _shouldHistoricalAutoCloseAtExpiry(group);
        let autoSettledAnyLeg = false;
        (group.legs || []).forEach((leg) => {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined;
            const isAutoSettledClose = leg && leg.closePriceSource === 'historical_expiry_auto';
            const expiryDate = _normalizeHistoricalDateKey(leg && leg.expDate);

            if (_isUnderlyingLeg(leg) || pos < 0.0001 || !expiryDate) {
                return;
            }

            if (isAutoSettledClose && (!autoCloseAtExpiry || expiryDate > replayDate)) {
                leg.closePrice = null;
                leg.closePriceSource = '';
                leg.autoSettledAtReplayDate = null;
                stateChanged = true;
                return;
            }

            if (!autoCloseAtExpiry || hasClosePrice || expiryDate > replayDate) {
                return;
            }

            const closePrice = _resolveHistoricalReplayClosePrice(leg, true);
            if (!Number.isFinite(closePrice) || closePrice < 0) {
                return;
            }

            if (Math.abs((parseFloat(leg.closePrice) || 0) - closePrice) > 0.000001
                || leg.closePriceSource !== 'historical_expiry_auto') {
                leg.closePrice = closePrice;
                leg.closePriceSource = 'historical_expiry_auto';
                leg.autoSettledAtReplayDate = replayDate;
                autoSettledAnyLeg = true;
                stateChanged = true;
            }
        });

        if (autoSettledAnyLeg && !_groupHasOpenPositions(group) && group.viewMode !== 'settlement') {
            group.viewMode = 'settlement';
            stateChanged = true;
        }
    });

    return stateChanged;
}

function _handleHistoricalReplayMessage(data) {
    if (!data || typeof data !== 'object' || data.action !== 'historical_replay_error') {
        return false;
    }

    console.error(data.message || 'Historical replay request failed.');
    return true;
}

let renderScheduled = false;

function processLiveMarketData(data) {
    const liveMode = !_isHistoricalMode();
    const feedHealthChanged = liveMode && _recordLiveProjectionMarketReceipt(data);
    let rejectedOptionIdentities = new Map();
    let rejectedFutureIdentities = new Map();
    if (data && data.options && typeof data.options === 'object') {
        const expandedOptions = { ...data.options };
        _expandOptionQuoteAliases(expandedOptions);
        const filteredOptions = liveMode
            ? _filterLiveOptionQuotesByRequestIdentity(expandedOptions)
            : { accepted: expandedOptions, rejected: new Map() };
        rejectedOptionIdentities = filteredOptions.rejected;
        data = {
            ...data,
            options: filteredOptions.accepted,
        };
    }
    if (data && data.futures && typeof data.futures === 'object') {
        const payloadAsOf = _resolveLivePayloadAsOf(data);
        const filteredFutures = liveMode
            ? _filterLiveFutureQuotesByRequestIdentity(data.futures, payloadAsOf)
            : { accepted: data.futures, rejected: new Map() };
        rejectedFutureIdentities = filteredFutures.rejected;
        data = {
            ...data,
            futures: filteredFutures.accepted,
        };
    }
    const liveClockUpdate = _applyLiveQuoteClock(data);
    let stateChanged = feedHealthChanged
        || liveClockUpdate.changed
        || _applyHistoricalReplayMetadata(data);
    stateChanged = _applyHistoricalExpiryUnderlyingAnchors(data) || stateChanged;
    const quoteSourceKind = _getQuoteSourceKind(data);
    const nextUnderlyingPrice = parseFloat(data && data.underlyingPrice);
    const hasUnderlyingPrice = Number.isFinite(nextUnderlyingPrice);
    const incrementalGroupIds = new Set();
    const deltaOnlyGroupIds = new Set();
    const incrementalHedgeIds = new Set();
    const changedOptionQuoteIds = [];
    const changedOptionDeltaQuoteIds = [];
    let optionQuotesChanged = false;
    let optionQuoteEvidenceChanged = false;
    let optionDeltaChanged = false;
    let futureQuotesChanged = false;
    let carryReferenceQuotesChanged = false;
    let underlyingQuoteChanged = false;

    if (liveMode && rejectedOptionIdentities.size > 0) {
        rejectedOptionIdentities.forEach((reason, subId) => {
            stateChanged = _invalidateRejectedLiveOptionQuote(
                subId,
                reason,
                incrementalGroupIds
            ) || stateChanged;
        });
    }
    if (liveMode && rejectedFutureIdentities.size > 0) {
        rejectedFutureIdentities.forEach((rejection, logicalId) => {
            const invalidated = _invalidateRejectedLiveFutureQuote(
                logicalId,
                rejection,
                incrementalGroupIds
            );
            futureQuotesChanged = invalidated || futureQuotesChanged;
            stateChanged = invalidated || stateChanged;
        });
    }
    if (liveMode) {
        const invalidatedStaleFuture = _invalidateStaleLiveFuturesPoolQuotes(
            incrementalGroupIds
        );
        futureQuotesChanged = invalidatedStaleFuture || futureQuotesChanged;
        stateChanged = invalidatedStaleFuture || stateChanged;
    }

    if (data.underlyingQuote && typeof data.underlyingQuote === 'object') {
        underlyingQuoteChanged = _setUnderlyingQuoteSnapshot(data.underlyingQuote);
    } else if (hasUnderlyingPrice) {
        underlyingQuoteChanged = _setUnderlyingQuoteSnapshot({ mark: nextUnderlyingPrice });
    }

    if (data.options) {
        Object.entries(data.options).forEach(([subId, quote]) => {
            const quoteChange = _setOptionQuoteSnapshot(subId, quote);
            optionQuotesChanged = quoteChange.pricingChanged || optionQuotesChanged;
            optionQuoteEvidenceChanged = quoteChange.changed || optionQuoteEvidenceChanged;
            optionDeltaChanged = quoteChange.deltaChanged || optionDeltaChanged;
            if (quoteChange.pricingChanged) {
                changedOptionQuoteIds.push(subId);
            }
            if (quoteChange.deltaChanged) {
                changedOptionDeltaQuoteIds.push(subId);
            }
        });

    }

    const forwardRateInputChanged = (state.forwardRateSamples || []).length > 0
        && (optionQuoteEvidenceChanged
            || underlyingQuoteChanged
            || rejectedOptionIdentities.size > 0
            || liveClockUpdate.changed);
    if (forwardRateInputChanged) {
        const forwardRateChanged = _refreshIndexForwardRateSamples();
        if (forwardRateChanged) {
            stateChanged = true;
            if (liveMode) _addAllGroupIds(incrementalGroupIds);
        }
        _refreshForwardRatePanelUi();
    } else if (optionQuotesChanged && (state.forwardRateSamples || []).length > 0) {
        _refreshForwardRatePanelUi();
    }

    if (data.futures) {
        Object.entries(data.futures).forEach(([subId, quote]) => {
            futureQuotesChanged = _setFutureQuoteSnapshot(subId, quote) || futureQuotesChanged;
        });
    }

    if (data.stocks) {
        Object.entries(data.stocks).forEach(([symbol, quote]) => {
            _setStockQuoteSnapshot(symbol, quote);
        });
    }

    if (data.carryReferences) {
        Object.entries(data.carryReferences).forEach(([referenceId, quote]) => {
            carryReferenceQuotesChanged = _setCarryReferenceQuoteSnapshot(referenceId, quote)
                || carryReferenceQuotesChanged;
        });
    }

    if (liveMode && underlyingQuoteChanged) {
        _addGroupsAffectedByUnderlyingMidpoint(incrementalGroupIds);
    }
    if (liveMode && optionQuotesChanged) {
        _addGroupsAffectedByOptionQuoteIds(incrementalGroupIds, changedOptionQuoteIds);
    }
    if (liveMode && _areGreeksEnabled() && optionDeltaChanged) {
        _addGroupsAffectedByOptionQuoteIds(deltaOnlyGroupIds, changedOptionDeltaQuoteIds);
    }
    if (liveMode && futureQuotesChanged) {
        _addAllGroupIds(incrementalGroupIds);
    }

    if (data.futures) {
        (state.futuresPool || []).forEach((entry) => {
            const quote = data.futures[entry.id];
            if (!quote) return;

            const nextBid = quote.bid !== undefined ? quote.bid : entry.bid;
            const nextAsk = quote.ask !== undefined ? quote.ask : entry.ask;
            const nextMark = quote.mark !== undefined ? quote.mark : entry.mark;
            const nextQuoteAsOf = String(quote.quoteAsOf || entry.quoteAsOf || entry.lastQuotedAt || '').trim();
            const nextLastTradeDate = String(quote.lastTradeDate || entry.lastTradeDate || '').trim();
            // Only a ContractDetails-sourced delivery month may be stored as the
            // qualified month; a month derived from lastTradeDate is off by one
            // for CL and every other product whose expiry leads delivery.
            const nextQualifiedContractMonth = String(quote.contractMonthSource || '').trim()
                === 'ib_contract_details'
                ? _normalizeContractMonthIdentity(quote.contractMonth)
                : '';
            const nextRequestGeneration = parseInt(quote.requestGeneration, 10);
            const nextRequestId = String(quote.requestId || '').trim();
            const quoteChanged = nextBid !== entry.bid
                || nextAsk !== entry.ask
                || nextMark !== entry.mark
                || nextQuoteAsOf !== String(entry.quoteAsOf || entry.lastQuotedAt || '').trim()
                || nextLastTradeDate !== String(entry.lastTradeDate || '').trim()
                || nextQualifiedContractMonth !== String(entry.qualifiedContractMonth || '').trim()
                || nextRequestGeneration !== parseInt(entry.liveQuoteRequestGeneration, 10)
                || nextRequestId !== String(entry.liveQuoteRequestId || '').trim()
                || entry.requestIdentityVerified !== true
                || entry.liveQuoteIdentityStatus !== 'verified';
            if (!quoteChanged) {
                return;
            }

            entry.bid = nextBid;
            entry.ask = nextAsk;
            entry.mark = nextMark;
            entry.quoteAsOf = nextQuoteAsOf;
            entry.lastQuotedAt = nextQuoteAsOf || null;
            entry.lastTradeDate = nextLastTradeDate;
            entry.localSymbol = String(quote.localSymbol || entry.localSymbol || '').trim();
            entry.symbol = String(quote.symbol || entry.symbol || state.underlyingSymbol || '').trim().toUpperCase();
            entry.secType = String(quote.secType || entry.secType || 'FUT').trim().toUpperCase();
            entry.exchange = String(quote.exchange || entry.exchange || '').trim();
            entry.currency = String(quote.currency || entry.currency || '').trim().toUpperCase();
            entry.multiplier = String(quote.multiplier || entry.multiplier || '').trim();
            entry.markSource = String(quote.markSource || entry.markSource || '').trim();
            entry.conId = Number.isFinite(parseInt(quote.conId, 10))
                ? parseInt(quote.conId, 10)
                : (entry.conId || null);
            entry.qualifiedContractMonth = nextQualifiedContractMonth;
            entry.requestIdentityVerified = quote.requestIdentityVerified === true;
            entry.liveQuoteRequestGeneration = Number.isFinite(nextRequestGeneration)
                ? nextRequestGeneration
                : null;
            entry.liveQuoteRequestId = nextRequestId;
            entry.requestedSecType = String(quote.requestedSecType || '').trim().toUpperCase();
            entry.requestedSymbol = String(quote.requestedSymbol || '').trim().toUpperCase();
            entry.requestedExchange = String(quote.requestedExchange || '').trim().toUpperCase();
            entry.requestedCurrency = String(quote.requestedCurrency || '').trim().toUpperCase();
            entry.requestedMultiplier = String(quote.requestedMultiplier || '').trim();
            entry.requestedContractMonth = _normalizeContractMonthIdentity(
                quote.requestedContractMonth
            );
            entry.liveQuoteIdentityStatus = entry.requestIdentityVerified ? 'verified' : 'unverified';
            entry.liveQuoteIdentityReason = entry.requestIdentityVerified
                ? ''
                : 'live futures request identity unavailable';
        });

        (state.hedges || []).forEach((hedge) => {
            if (!hedge || String(hedge.secType || '').toUpperCase() !== 'FUT') return;
            const quote = data.futures[hedge.id];
            const liveMark = Number(quote && quote.mark);
            if (!(liveMark > 0)) return;
            if (Math.abs(liveMark - Number(hedge.currentPrice || 0)) <= 0.001
                && hedge.currentPriceSource === quoteSourceKind) return;
            hedge.currentPrice = liveMark;
            hedge.currentPriceSource = quoteSourceKind;
            stateChanged = true;
            if (liveMode && hedge.id) incrementalHedgeIds.add(hedge.id);
        });

        state.groups.forEach(group => {
            if (!group.liveData) {
                return;
            }

            group.legs.forEach(leg => {
                if (!_isUnderlyingLeg(leg) || !leg.underlyingFutureId || data.futures[leg.underlyingFutureId] === undefined) {
                    return;
                }

                const liveMark = data.futures[leg.underlyingFutureId].mark;
                if (!(liveMark > 0)) {
                    return;
                }

                const markChanged = Math.abs(liveMark - leg.currentPrice) > 0.001;
                const sourceChanged = leg.currentPriceSource !== quoteSourceKind;
                if (!markChanged && !sourceChanged) {
                    return;
                }

                leg.currentPrice = liveMark;
                leg.currentPriceSource = quoteSourceKind;
                stateChanged = true;
                if (liveMode && group && group.id) {
                    incrementalGroupIds.add(group.id);
                }

                const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                if (row) {
                    const currentPriceInput = row.querySelector('.current-price-input');
                    if (currentPriceInput) {
                        currentPriceInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, liveMark);
                        flashElement(currentPriceInput);
                    }
                }
            });
        });

        if ((futureQuotesChanged || carryReferenceQuotesChanged
            || rejectedFutureIdentities.size > 0)
            && (state.futuresPool || []).length > 0) {
            _refreshFuturesPoolPanelUi();
        }
    }

    // A diagnostic SPX/NDX reference is delivered on its own ticker cadence.
    // Refresh the panel even when the payload contains no futures tick; this
    // must never trigger a portfolio revaluation because the reference is not
    // a Black-76 pricing input.
    if (!data.futures && carryReferenceQuotesChanged
        && (state.futuresPool || []).length > 0) {
        _refreshFuturesPoolPanelUi();
    }

    const currentUnderlyingPrice = parseFloat(state && state.underlyingPrice);
    const underlyingPriceChanged = hasUnderlyingPrice
        && (!Number.isFinite(currentUnderlyingPrice)
            || Math.abs(nextUnderlyingPrice - currentUnderlyingPrice) > 0.000001);
    if (hasUnderlyingPrice && underlyingPriceChanged) {
        state.underlyingPrice = nextUnderlyingPrice;
        const underlyingPriceInput = document.getElementById('underlyingPrice');
        const underlyingPriceSlider = document.getElementById('underlyingPriceSlider');
        const underlyingPriceDisplay = document.getElementById('underlyingPriceDisplay');
        const nextInputValue = _formatSymbolPriceInputValue(state.underlyingSymbol, state.underlyingPrice);
        const nextDisplayValue = _formatSymbolPriceDisplay(state.underlyingSymbol, state.underlyingPrice);
        if (underlyingPriceInput && underlyingPriceInput.value !== nextInputValue) {
            underlyingPriceInput.value = nextInputValue;
        }
        if (underlyingPriceSlider && String(underlyingPriceSlider.value) !== String(state.underlyingPrice)) {
            underlyingPriceSlider.value = state.underlyingPrice;
        }
        if (underlyingPriceDisplay && underlyingPriceDisplay.textContent !== nextDisplayValue) {
            underlyingPriceDisplay.textContent = nextDisplayValue;
        }
        if (!_isHistoricalMode()) {
            evaluateTrialTradeTriggers();
            evaluateTriggeredOrderExitConditions();
        }
        stateChanged = true;
        if (liveMode) {
            _addAllGroupIds(incrementalGroupIds);
        }
    }

    if (data.options) {
        state.groups.forEach(group => {
            if (!group.liveData) {
                return;
            }

            group.legs.forEach(leg => {
                if (data.options[leg.id] === undefined) {
                    return;
                }

                const replayQuote = data.options[leg.id] || {};
                const liveMark = replayQuote.mark;
                const liveIV = replayQuote.iv;
                if (liveMode && _applyLiveOptionContractIdentity(leg, replayQuote)) {
                    stateChanged = true;
                }
                if (liveMode && _applyLiveOptionExpiryTiming(leg, replayQuote)) {
                    stateChanged = true;
                    if (group && group.id) incrementalGroupIds.add(group.id);
                }

                if (replayQuote.missing === true) {
                    const legChanged = _markOptionQuoteMissing(leg);
                    stateChanged = legChanged || stateChanged;
                    if (legChanged && liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }
                    return;
                }

                if (Number.isFinite(Number(liveMark)) && Number(liveMark) >= 0) {
                    const normalizedLiveMark = Number(liveMark);
                    const markChanged = Math.abs(normalizedLiveMark - leg.currentPrice) > 0.001;
                    const sourceChanged = leg.currentPriceSource !== quoteSourceKind;
                    if (markChanged || sourceChanged) {
                        leg.currentPrice = normalizedLiveMark;
                        leg.currentPriceSource = quoteSourceKind;
                        stateChanged = true;
                        if (liveMode && group && group.id) {
                            incrementalGroupIds.add(group.id);
                        }

                        const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                        if (row) {
                            const currentPriceInput = row.querySelector('.current-price-input');
                            if (currentPriceInput) {
                            currentPriceInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, normalizedLiveMark);
                                flashElement(currentPriceInput);
                            }
                        }
                    }
                }

                const ivManuallyOverridden = leg.ivManualOverride === true;

                if (liveIV && liveIV > 0 && !ivManuallyOverridden) {
                    const nextIvSource = quoteSourceKind === 'historical' ? 'historical' : 'live';
                    const ivChanged = Math.abs(liveIV - leg.iv) > 0.000001 || leg.ivSource !== nextIvSource || leg.ivManualOverride === true;
                    leg.iv = liveIV;
                    leg.ivSource = nextIvSource;
                    leg.ivManualOverride = false;
                    stateChanged = stateChanged || ivChanged;
                    if (ivChanged && liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }

                    const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                    if (row && ivChanged) {
                        const ivInput = row.querySelector('.iv-input');
                        if (ivInput && document.activeElement !== ivInput) {
                            const pricingCore = _getPricingCoreApi();
                            const ivDisplay = pricingCore
                                && typeof pricingCore.describeLegIvInput === 'function'
                                ? pricingCore.describeLegIvInput(leg)
                                : {
                                    value: `${(liveIV * 100).toFixed(4)}%`,
                                    title: 'Live IV from TWS',
                                };
                            ivInput.value = ivDisplay.value;
                            ivInput.title = ivDisplay.title;
                            flashElement(ivInput);
                        }
                    }
                } else if (!(liveIV && liveIV > 0) && !ivManuallyOverridden && leg.ivSource !== 'missing') {
                    leg.ivSource = 'missing';
                    stateChanged = true;
                    if (liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }

                    const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                    if (row) {
                        const ivInput = row.querySelector('.iv-input');
                        if (ivInput && document.activeElement !== ivInput) {
                            const pricingCore = _getPricingCoreApi();
                            const ivDisplay = pricingCore
                                && typeof pricingCore.describeLegIvInput === 'function'
                                ? pricingCore.describeLegIvInput(leg)
                                : {
                                    value: 'N/A',
                                    title: 'Live IV is unavailable from TWS for this contract.',
                                };
                            ivInput.value = ivDisplay.value;
                            ivInput.title = ivDisplay.title;
                        }
                    }
                }
            });
        });

        if (_applyEstimatedOptionIvFallback(incrementalGroupIds)) {
            stateChanged = true;
        }
    }

    if (data.stocks) {
        state.hedges.forEach(hedge => {
            if (hedge.liveData && data.stocks[hedge.symbol] !== undefined) {
                const liveMark = data.stocks[hedge.symbol].mark;
                const markChanged = liveMark > 0 && Math.abs(liveMark - hedge.currentPrice) > 0.001;
                const sourceChanged = liveMark > 0 && hedge.currentPriceSource !== quoteSourceKind;
                if (liveMark > 0 && (markChanged || sourceChanged)) {
                    hedge.currentPrice = liveMark;
                    hedge.currentPriceSource = quoteSourceKind;
                    stateChanged = true;
                    if (liveMode && hedge && hedge.id) {
                        incrementalHedgeIds.add(hedge.id);
                    }

                    const row = document.querySelector(`tr.hedge-row[data-id="${hedge.id}"]`);
                    if (row) {
                        const currentPriceInput = row.querySelector('.current-price-input');
                        if (currentPriceInput) {
                            currentPriceInput.value = _formatSymbolPriceInputValue(hedge.symbol, liveMark);
                            flashElement(currentPriceInput);
                        }
                    }
                }
            }
        });
    }

    if (hasUnderlyingPrice) {
        const registry = _getProductRegistryApi();
        const usesFuturesPool = registry
            && typeof registry.usesFuturesPool === 'function'
            && registry.usesFuturesPool(state.underlyingSymbol);
        state.groups.forEach(group => {
            if (!group.liveData) {
                return;
            }

            group.legs.forEach(leg => {
                if (usesFuturesPool && leg.underlyingFutureId) {
                    return;
                }
                if (_isUnderlyingLeg(leg) && (
                    Math.abs(nextUnderlyingPrice - leg.currentPrice) > 0.001
                    || leg.currentPriceSource !== quoteSourceKind
                )) {
                    leg.currentPrice = nextUnderlyingPrice;
                    leg.currentPriceSource = quoteSourceKind;
                    stateChanged = true;
                    if (liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }

                    const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                    if (row) {
                        const currentPriceInput = row.querySelector('.current-price-input');
                        if (currentPriceInput) {
                            currentPriceInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, nextUnderlyingPrice);
                            flashElement(currentPriceInput);
                        }
                    }
                }
            });
        });

        if (_applyEstimatedOptionIvFallback(incrementalGroupIds)) {
            stateChanged = true;
        }
    }

    if (_applyHistoricalBaseDateCosts()) {
        stateChanged = true;
    }

    if (_applyHistoricalAutoExpirySettlement()) {
        stateChanged = true;
    }

    if (_isHistoricalMode() && hasUnderlyingPrice && underlyingPriceChanged) {
        evaluateTrialTradeTriggers();
        evaluateTriggeredOrderExitConditions();
    }

    const hasIncrementalTargets = incrementalGroupIds.size > 0 || incrementalHedgeIds.size > 0;
    const hasDeltaOnlyTargets = deltaOnlyGroupIds.size > 0;
    if (stateChanged || hasIncrementalTargets || hasDeltaOnlyTargets) {
        _scheduleDerivedValueRefresh({
            groupIds: Array.from(incrementalGroupIds),
            deltaGroupIds: Array.from(deltaOnlyGroupIds),
            hedgeIds: Array.from(incrementalHedgeIds),
        }, liveMode
            && !liveClockUpdate.changed
            && (hasIncrementalTargets || hasDeltaOnlyTargets));
    }
}

// Connect immediately on load
initWsPortControls();
connectWebSocket();
if (typeof window.setInterval === 'function') {
    _liveProjectionFeedWatchdogTimer = window.setInterval(() => {
        _runLiveProjectionFeedWatchdog();
    }, LIVE_PROJECTION_FEED_WATCHDOG_INTERVAL_MS);
    _discountCurveRefreshTimer = window.setInterval(() => {
        if (!_isHistoricalMode() && state.useMarketDiscountCurve === true) {
            requestDiscountCurveSnapshot();
        }
    }, DISCOUNT_CURVE_REFRESH_INTERVAL_MS);
}
