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
let _wsReconnectDelay = WS_BASE_DELAY;
let _wsReconnectTimer = null;
let _legacyLiveDataWarningShown = false;
let _historicalReplayOrderCounter = 900000;
const _liveQuoteRuntime = {
    underlyingQuote: null,
    optionQuotesById: new Map(),
    futureQuotesById: new Map(),
    stockQuotesBySymbol: new Map(),
    // Subscription pool: canonical subscription id -> other request ids that
    // resolve to the same option contract and share its market data line.
    optionQuoteAliasesByCanonicalId: new Map(),
};
const _liveQuotePricingSnapshotFields = ['bid', 'ask', 'mark', 'iv'];
const _liveQuoteSnapshotFields = ['bid', 'ask', 'mark', 'iv', 'delta'];

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

function _getPricingCoreApi() {
    return window.OptionComboPricingCore && typeof window.OptionComboPricingCore === 'object'
        ? window.OptionComboPricingCore
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
    ['bid', 'ask', 'mark', 'iv'].forEach((field) => {
        const parsed = parseFloat(rawQuote[field]);
        if (Number.isFinite(parsed) && parsed > 0) {
            snapshot[field] = parsed;
        }
    });
    const delta = parseFloat(rawQuote.delta);
    if (_areGreeksEnabled() && Number.isFinite(delta)) {
        snapshot.delta = delta;
    }

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
    _liveQuoteRuntime.optionQuoteAliasesByCanonicalId.clear();
}

function _buildOptionContractSignature(request) {
    return [
        request.secType || '',
        request.symbol || '',
        request.right || '',
        parseFloat(request.strike),
        request.expDate || '',
        request.contractMonth || '',
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
    (Array.isArray(optionRequests) ? optionRequests : []).forEach((request) => {
        if (!request || !request.id) {
            return;
        }
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
        // FOP qualification hint lives on leg requests only; keep it on the
        // canonical request even when a template request claimed the slot first.
        if (!canonical.underlyingContractMonth && request.underlyingContractMonth) {
            canonical.underlyingContractMonth = request.underlyingContractMonth;
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

function _setUnderlyingQuoteSnapshot(rawQuote) {
    const nextSnapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (_areLiveQuoteSnapshotsEqual(_liveQuoteRuntime.underlyingQuote, nextSnapshot)) {
        return false;
    }
    _liveQuoteRuntime.underlyingQuote = nextSnapshot;
    return true;
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
    if (!pricingChanged && !deltaChanged) {
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
    if (_areLiveQuoteSnapshotsEqual(previousSnapshot, snapshot)) {
        return false;
    }
    _liveQuoteRuntime.futureQuotesById.set(subId, snapshot);
    return true;
}

function _setStockQuoteSnapshot(symbol, rawQuote) {
    if (!symbol) return false;
    const snapshot = _cloneLiveQuoteSnapshot(rawQuote);
    if (!snapshot) return false;
    const previousSnapshot = _liveQuoteRuntime.stockQuotesBySymbol.get(symbol) || null;
    if (_areLiveQuoteSnapshotsEqual(previousSnapshot, snapshot)) {
        return false;
    }
    _liveQuoteRuntime.stockQuotesBySymbol.set(symbol, snapshot);
    return true;
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
    requestAnimationFrame(() => {
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
    });
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

window.OptionComboWsLiveQuotes = {
    getOptionQuote: getLiveOptionQuote,
    getFutureQuote: getLiveFutureQuote,
    getStockQuote: getLiveStockQuote,
    getUnderlyingQuote,
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
        : (state.baseDate || state.simulatedDate || '');
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

function connectWebSocket() {
    _clearWsReconnectTimer();

    const wsUrl = _getWsUrl();
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        isWsConnected = true;
        _wsReconnectDelay = WS_BASE_DELAY;
        console.log(`WebSocket Connected to IB Gateway Backend at ${wsUrl}`);
        updateWsStatusUI('connected');
        handleLiveSubscriptions();
        requestActiveHedgeOrdersSnapshot();
        requestActiveComboOrdersSnapshot();
    };

    ws.onclose = () => {
        isWsConnected = false;
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

    ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        state.liveComboOrderAccountsConnected = false;
        const controlPanelUi = _getControlPanelUiApi();
        if (controlPanelUi && typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
            _runUiRefreshSafely('boundDynamicControls', () => {
                controlPanelUi.refreshBoundDynamicControls();
            });
        }
        updateWsStatusUI('error');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (_handleManagedAccountsMessage(data)) {
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
            if (_handleHistoricalReplayMessage(data)) {
                return;
            }
            processLiveMarketData(data);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    };
}

function reconnectWebSocket() {
    _clearWsReconnectTimer();
    isWsConnected = false;

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
window.requestDeltaHedgeBrokerPreview = requestDeltaHedgeBrokerPreview;
window.requestDeltaHedgeSubmit = requestDeltaHedgeSubmit;
window.requestDeltaHedgeCancel = requestDeltaHedgeCancel;
window.requestContinueManagedComboOrder = requestContinueManagedComboOrder;
window.requestConcedeManagedComboOrder = requestConcedeManagedComboOrder;
window.requestCancelManagedComboOrder = requestCancelManagedComboOrder;
window.requestCloseGroupComboOrder = requestCloseGroupComboOrder;
window.requestCloseLegComboOrder = requestCloseLegComboOrder;
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

function handleLiveSubscriptions() {
    if (!isWsConnected || !ws) return;
    _resetLiveQuoteRuntime();
    const registry = _getProductRegistryApi();
    const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
        ? registry.resolveUnderlyingProfile(state.underlyingSymbol)
        : null;
    if (!_isHistoricalMode()
        && registry
        && typeof registry.supportsLegacyLiveData === 'function'
        && !registry.supportsLegacyLiveData(state.underlyingSymbol)) {
        if (!_legacyLiveDataWarningShown) {
            console.warn(`Legacy live-data subscriptions are not implemented for ${state.underlyingSymbol}. Use manual prices for now.`);
            _legacyLiveDataWarningShown = true;
        }
        return;
    }

    const optionRequests = [];
    const futuresRequests = _buildFuturesPoolRequests(profile || {});
    const payload = {
        action: 'subscribe',
        greeksEnabled: _areGreeksEnabled(),
        underlying: null,
        options: optionRequests,
        futures: futuresRequests,
        stocks: []
    };

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
                    tradingClass: optionContractSpec?.tradingClass
                        || (profile?.tradingClass || undefined),
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
            tradingClass: optionContractSpec?.tradingClass
                || (profile?.tradingClass || undefined),
            right: String(request.type || '').toLowerCase() === 'put' ? 'P' : 'C',
            strike: parseFloat(request.strike),
            expDate: _toContractDateCode(request.expDate),
            contractMonth: _toContractMonth(request.expDate),
        });
    });

    // Collect all legs from groups that have Live Data == true
    state.groups.forEach(group => {
        if (group.liveData) {
            group.legs.forEach(leg => {
                if (!_isUnderlyingLeg(leg)) {
                    const selectedFuture = _resolveFuturesPoolEntryById(leg.underlyingFutureId);
                    const optionContractSpec = registry
                        && typeof registry.resolveOptionContractSpec === 'function'
                        ? registry.resolveOptionContractSpec(state.underlyingSymbol, leg.expDate)
                        : null;
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
                        tradingClass: optionContractSpec?.tradingClass
                            || (profile?.tradingClass || undefined),
                        right: leg.type.charAt(0).toUpperCase(), // 'C' or 'P'
                        strike: leg.strike,
                        expDate: _toContractDateCode(leg.expDate),
                        contractMonth: _toContractMonth(leg.expDate),
                        underlyingContractMonth: selectedFuture?.contractMonth
                            || state.underlyingContractMonth
                            || (registry
                                && typeof registry.resolveDefaultUnderlyingContractMonth === 'function'
                                ? registry.resolveDefaultUnderlyingContractMonth(
                                    state.underlyingSymbol,
                                    _getQuoteReferenceDate()
                                )
                                : ''),
                    });
                }
            });
        }
    });

    const dedupedOptionRequests = _dedupeOptionRequestsForSubscription(optionRequests);
    payload.options = dedupedOptionRequests;

    payload.underlying = _buildUnderlyingRequest(profile || {
        family: 'DEFAULT_EQUITY',
        underlyingSecType: 'STK',
        underlyingSymbol: state.underlyingSymbol,
        underlyingExchange: 'SMART',
        currency: 'USD',
    }, dedupedOptionRequests, futuresRequests);

    // Collect all hedge stocks that have Live Data == true
    state.hedges.forEach(hedge => {
        if (hedge.liveData && hedge.symbol) {
            payload.stocks.push(hedge.symbol);
        }
    });

    if (_isHistoricalMode()) {
        ws.send(JSON.stringify(_buildHistoricalSnapshotPayload(payload.underlying, dedupedOptionRequests, futuresRequests)));
        return;
    }

    ws.send(JSON.stringify(payload));
    requestPortfolioAvgCostSnapshot();
    if (state.allowLiveComboOrders === true
        || !Array.isArray(state.liveComboOrderAccounts)
        || state.liveComboOrderAccounts.length === 0
        || state.liveComboOrderAccountsConnected !== true) {
        requestManagedAccountsSnapshot();
    }
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
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function _parsePortfolioPnlValue(rawValue) {
    const parsed = parseFloat(rawValue);
    return Number.isFinite(parsed) ? parsed : null;
}

function _applyPortfolioValuationToLeg(leg, item) {
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

            stateChanged = _applyPortfolioValuationToLeg(leg, match) || stateChanged;

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
    runtime.pendingRequest = false;
    runtime.status = 'previewed';
    runtime.lastError = '';
    runtime.lastPreview = preview;
    runtime.lastPreviewAt = new Date().toISOString();
    runtime.pendingPreviewPayload = null;
    _refreshDeltaHedgeBrokerPreviewUi();
    if (typeof window !== 'undefined' && typeof window.runDeltaHedgeAutoSupervisor === 'function') {
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
            handleLiveSubscriptions();
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

function _applyHistoricalReplayMetadata(data) {
    if (!data || !data.historicalReplay || typeof data.historicalReplay !== 'object') {
        return false;
    }

    let stateChanged = false;
    const availableStartDate = String(data.historicalReplay.availableStartDate || '').trim();
    const availableEndDate = String(data.historicalReplay.availableEndDate || '').trim();
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
    _expandOptionQuoteAliases(data && data.options);
    let stateChanged = _applyHistoricalReplayMetadata(data);
    stateChanged = _applyHistoricalExpiryUnderlyingAnchors(data) || stateChanged;
    const quoteSourceKind = _getQuoteSourceKind(data);
    const nextUnderlyingPrice = parseFloat(data && data.underlyingPrice);
    const hasUnderlyingPrice = Number.isFinite(nextUnderlyingPrice);
    const incrementalGroupIds = new Set();
    const deltaOnlyGroupIds = new Set();
    const incrementalHedgeIds = new Set();
    const changedOptionQuoteIds = [];
    const changedOptionDeltaQuoteIds = [];
    const liveMode = !_isHistoricalMode();
    let optionQuotesChanged = false;
    let optionDeltaChanged = false;
    let futureQuotesChanged = false;
    let underlyingQuoteChanged = false;

    if (data.underlyingQuote && typeof data.underlyingQuote === 'object') {
        underlyingQuoteChanged = _setUnderlyingQuoteSnapshot(data.underlyingQuote);
    } else if (hasUnderlyingPrice) {
        underlyingQuoteChanged = _setUnderlyingQuoteSnapshot({ mark: nextUnderlyingPrice });
    }

    if (data.options) {
        Object.entries(data.options).forEach(([subId, quote]) => {
            const quoteChange = _setOptionQuoteSnapshot(subId, quote);
            optionQuotesChanged = quoteChange.pricingChanged || optionQuotesChanged;
            optionDeltaChanged = quoteChange.deltaChanged || optionDeltaChanged;
            if (quoteChange.pricingChanged) {
                changedOptionQuoteIds.push(subId);
            }
            if (quoteChange.deltaChanged) {
                changedOptionDeltaQuoteIds.push(subId);
            }
        });

        if (optionQuotesChanged && (state.forwardRateSamples || []).length > 0) {
            _refreshForwardRatePanelUi();
        }
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
            const quoteChanged = nextBid !== entry.bid
                || nextAsk !== entry.ask
                || nextMark !== entry.mark;
            if (!quoteChanged) {
                return;
            }

            entry.bid = nextBid;
            entry.ask = nextAsk;
            entry.mark = nextMark;
            entry.lastQuotedAt = new Date().toISOString();
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

        if (futureQuotesChanged && (state.futuresPool || []).length > 0) {
            _refreshFuturesPoolPanelUi();
        }
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

                if (replayQuote.missing === true) {
                    const legChanged = _markOptionQuoteMissing(leg);
                    stateChanged = legChanged || stateChanged;
                    if (legChanged && liveMode && group && group.id) {
                        incrementalGroupIds.add(group.id);
                    }
                    return;
                }

                if (liveMark > 0) {
                    const markChanged = Math.abs(liveMark - leg.currentPrice) > 0.001;
                    const sourceChanged = leg.currentPriceSource !== quoteSourceKind;
                    if (markChanged || sourceChanged) {
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
        }, liveMode && (hasIncrementalTargets || hasDeltaOnlyTargets));
    }
}

// Connect immediately on load
initWsPortControls();
connectWebSocket();
