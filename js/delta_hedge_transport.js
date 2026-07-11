/**
 * Delta hedge broker transport helpers.
 *
 * This module owns websocket payload construction plus broker preview/submit/
 * cancel request state transitions. Domain calculations stay in
 * delta_hedge_logic.js and UI rendering stays in delta_hedge_ui.js.
 */

(function attachDeltaHedgeTransport(globalScope) {
    /**
     * @typedef {Object} DeltaHedgeTransportRecommendation
     * @property {boolean} actionable
     * @property {string} side
     * @property {number} quantity
     * @property {number} [currentNetDelta]
     * @property {number} [projectedNetDelta]
     * @property {number} [targetLower]
     * @property {number} [targetUpper]
     */

    /**
     * @typedef {Object} DeltaHedgeTransportDependencies
     * @property {Object} state
     * @property {function(): boolean} isHistoricalMode
     * @property {function(): boolean} isWsConnected
     * @property {function(Object): void} sendPayload
     * @property {function(): string} getSelectedLiveComboOrderAccount
     * @property {function(): string} getLiveHedgeOrderAccountRequirementMessage
     * @property {function(): void} refreshBrokerPreviewUi
     * @property {function(): void} requestManagedAccountsSnapshot
     * @property {function(): (Date|string)} [now]
     */

    function _normalizeDeltaHedgeConfig(config) {
        if (globalScope.OptionComboDeltaHedgeLogic
            && typeof globalScope.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig === 'function') {
            return globalScope.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig(config);
        }
        return config && typeof config === 'object' ? config : {};
    }

    function _hasActiveDeltaHedgeRestingOrder(runtime) {
        if (globalScope.OptionComboDeltaHedgeLogic
            && typeof globalScope.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder === 'function') {
            return globalScope.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder(runtime);
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

    /**
     * @param {DeltaHedgeTransportDependencies} dependencies
     */
    function createApi(dependencies) {
        const deps = dependencies && typeof dependencies === 'object' ? dependencies : {};

        function _getState() {
            return deps.state && typeof deps.state === 'object' ? deps.state : {};
        }

        function _getRuntime() {
            const state = _getState();
            if (!state.deltaHedge || typeof state.deltaHedge !== 'object') {
                state.deltaHedge = {};
            }
            state.deltaHedge = _normalizeDeltaHedgeConfig(state.deltaHedge);
            if (!state.deltaHedge.status) {
                state.deltaHedge.status = 'idle';
            }
            return state.deltaHedge;
        }

        function _refreshBrokerPreviewUi() {
            if (typeof deps.refreshBrokerPreviewUi === 'function') {
                deps.refreshBrokerPreviewUi();
            }
        }

        function _markDeltaHedgeError(message) {
            const runtime = _getRuntime();
            runtime.pendingRequest = false;
            runtime.status = 'error';
            runtime.lastError = message || 'Delta hedge broker preview failed.';
            _refreshBrokerPreviewUi();
            return false;
        }

        function _nowIsoString() {
            if (typeof deps.now === 'function') {
                const value = deps.now();
                if (value instanceof Date) {
                    return value.toISOString();
                }
                if (typeof value === 'string' && value) {
                    return value;
                }
            }
            return new Date().toISOString();
        }

        function _sendPayload(payload) {
            if (typeof deps.sendPayload !== 'function') {
                throw new Error('WebSocket send is unavailable.');
            }
            deps.sendPayload(payload);
        }

        /**
         * @param {DeltaHedgeTransportRecommendation} recommendation
         * @param {string} [action]
         * @param {Object} [options]
         */
        function buildOrderPayload(recommendation, action = 'validate_hedge_order', options = {}) {
            const runtime = _getRuntime();
            const config = _normalizeDeltaHedgeConfig(runtime);
            const instrument = config.hedgeInstrument || {};
            const orderType = String(config.orderType || 'LMT').trim().toUpperCase() === 'MKT' ? 'MKT' : 'LMT';
            const quantity = Math.round(Math.abs(Number(recommendation && recommendation.quantity)));
            const side = String(recommendation && recommendation.side || '').trim().toUpperCase();
            const symbol = String(instrument.symbol || '').trim().toUpperCase();
            const secType = String(instrument.secType || '').trim().toUpperCase();
            const contractMonth = String(instrument.contractMonth || '').trim();
            const selectedAccount = typeof deps.getSelectedLiveComboOrderAccount === 'function'
                ? String(deps.getSelectedLiveComboOrderAccount() || '').trim()
                : '';

            if (!recommendation || recommendation.actionable !== true) {
                throw new Error('Delta hedge recommendation is not actionable.');
            }
            if (!['BUY', 'SELL'].includes(side)) {
                throw new Error('Delta hedge recommendation side is invalid.');
            }
            if (!Number.isFinite(quantity) || quantity <= 0) {
                throw new Error('Delta hedge recommendation quantity is invalid.');
            }
            if (!['STK', 'FUT'].includes(secType) || !symbol) {
                throw new Error('Delta hedge instrument is incomplete.');
            }
            if (!selectedAccount) {
                const requirementMessage = typeof deps.getLiveHedgeOrderAccountRequirementMessage === 'function'
                    ? deps.getLiveHedgeOrderAccountRequirementMessage()
                    : 'Select a TWS account before sending hedge broker preview.';
                throw new Error(requirementMessage);
            }

            let limitPrice = null;
            if (orderType === 'LMT') {
                limitPrice = Number(config.limitPrice);
                if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
                    throw new Error('LMT hedge broker preview requires a positive limit price.');
                }
            }

            const hedgeId = _buildDeltaHedgeRuntimeHedgeId(config);
            const isSubmit = action === 'submit_hedge_order';
            const payload = {
                action,
                hedgeId,
                hedgeName: `${symbol} Delta Hedge`,
                secType,
                symbol,
                exchange: String(instrument.exchange || 'SMART').trim().toUpperCase() || 'SMART',
                currency: String(instrument.currency || 'USD').trim().toUpperCase() || 'USD',
                contractMonth,
                multiplier: instrument.multiplier !== undefined && instrument.multiplier !== null
                    ? String(instrument.multiplier)
                    : '',
                deltaPerUnit: Number.isFinite(Number(instrument.deltaPerUnit)) ? Number(instrument.deltaPerUnit) : null,
                orderAction: side,
                quantity,
                orderType,
                timeInForce: 'DAY',
                executionMode: isSubmit ? 'submit' : 'preview',
                account: selectedAccount,
                requestSource: options.requestSource || (isSubmit ? 'delta_hedge_manual_submit' : 'delta_hedge_manual_preview'),
                currentNetDelta: Number.isFinite(Number(recommendation.currentNetDelta)) ? Number(recommendation.currentNetDelta) : null,
                projectedNetDelta: Number.isFinite(Number(recommendation.projectedNetDelta)) ? Number(recommendation.projectedNetDelta) : null,
                targetLower: Number.isFinite(Number(recommendation.targetLower)) ? Number(recommendation.targetLower) : null,
                targetUpper: Number.isFinite(Number(recommendation.targetUpper)) ? Number(recommendation.targetUpper) : null,
            };

            if (limitPrice !== null) {
                payload.limitPrice = limitPrice;
            }
            if (isSubmit) {
                payload.executionPlanToken = String(runtime.lastPreview && runtime.lastPreview.executionPlanToken || '').trim();
            }
            return payload;
        }

        /**
         * @param {DeltaHedgeTransportRecommendation} recommendation
         * @param {Object} [options]
         */
        function requestBrokerPreview(recommendation, options = {}) {
            const runtime = _getRuntime();

            if (typeof deps.isHistoricalMode === 'function' && deps.isHistoricalMode()) {
                return _markDeltaHedgeError('Delta hedge broker preview requires live mode.');
            }
            if (typeof deps.isWsConnected !== 'function' || deps.isWsConnected() !== true) {
                return _markDeltaHedgeError('WebSocket is not connected.');
            }
            if (runtime.pendingRequest === true) {
                return false;
            }

            let payload;
            try {
                payload = buildOrderPayload(
                    recommendation || runtime.lastRecommendation,
                    'validate_hedge_order',
                    options
                );
            } catch (error) {
                const message = error && error.message ? error.message : 'Unable to build hedge broker preview payload.';
                if (/account/i.test(message) && typeof deps.requestManagedAccountsSnapshot === 'function') {
                    deps.requestManagedAccountsSnapshot();
                }
                return _markDeltaHedgeError(message);
            }

            const nextRuntime = _getRuntime();
            nextRuntime.pendingRequest = true;
            nextRuntime.status = 'pending_validation';
            nextRuntime.lastError = '';
            nextRuntime.pendingPreviewPayload = payload;
            nextRuntime.lastValidation = null;
            _sendPayload(payload);
            _refreshBrokerPreviewUi();
            return true;
        }

        /**
         * @param {DeltaHedgeTransportRecommendation} recommendation
         * @param {Object} [options]
         */
        function requestSubmit(recommendation, options = {}) {
            const runtime = _getRuntime();
            const state = _getState();

            if (typeof deps.isHistoricalMode === 'function' && deps.isHistoricalMode()) {
                return _markDeltaHedgeError('Delta hedge submit requires live mode.');
            }
            if (typeof deps.isWsConnected !== 'function' || deps.isWsConnected() !== true) {
                return _markDeltaHedgeError('WebSocket is not connected.');
            }
            if (state && state.allowLiveHedgeOrders !== true) {
                return _markDeltaHedgeError('Live hedge order switch is OFF.');
            }
            if (runtime.pendingRequest === true) {
                return false;
            }
            if (_hasActiveDeltaHedgeRestingOrder(runtime)) {
                return _markDeltaHedgeError('A hedge order is already resting or needs review.');
            }
            if (runtime.status !== 'previewed' || !runtime.lastPreview) {
                return _markDeltaHedgeError('Broker preview is required before submitting a hedge order.');
            }
            const safety = globalScope.OptionComboOrderSafety;
            if (!safety || typeof safety.buildHedgeIntent !== 'function'
                || typeof safety.previewMatchesIntent !== 'function') {
                return _markDeltaHedgeError('Shared order safety layer is unavailable.');
            }
            const intent = safety.buildHedgeIntent(state, recommendation || runtime.lastRecommendation);
            if (!safety.previewMatchesIntent(runtime.lastPreview, intent)) {
                return _markDeltaHedgeError('The hedge configuration changed after Broker Preview. Preview again.');
            }
            if (typeof safety.analyzePositionImpact !== 'function') {
                return _markDeltaHedgeError('Shared position impact analysis is unavailable.');
            }
            const impact = safety.analyzePositionImpact(intent, state);
            if (impact.available !== true) {
                return _markDeltaHedgeError(impact.blockingReason || 'A fresh TWS position snapshot is required.');
            }
            if ((impact.warnings || []).length > 0 && options.safetyConfirmed !== true) {
                return _markDeltaHedgeError('This hedge reduces an existing allocated position and requires explicit confirmation.');
            }

            let payload;
            try {
                payload = buildOrderPayload(
                    recommendation || runtime.lastRecommendation,
                    'submit_hedge_order',
                    options
                );
            } catch (error) {
                const message = error && error.message ? error.message : 'Unable to build hedge submit payload.';
                if (/account/i.test(message) && typeof deps.requestManagedAccountsSnapshot === 'function') {
                    deps.requestManagedAccountsSnapshot();
                }
                return _markDeltaHedgeError(message);
            }

            const nextRuntime = _getRuntime();
            nextRuntime.pendingRequest = true;
            nextRuntime.status = 'placing';
            nextRuntime.orderState = 'placing';
            nextRuntime.lastError = '';
            nextRuntime.pendingSubmitPayload = payload;
            nextRuntime.lastOrderEventAt = _nowIsoString();
            _sendPayload(payload);
            _refreshBrokerPreviewUi();
            return true;
        }

        function requestCancel(options = {}) {
            const runtime = _getRuntime();

            if (typeof deps.isHistoricalMode === 'function' && deps.isHistoricalMode()) {
                return _markDeltaHedgeError('Delta hedge cancel requires live mode.');
            }
            if (typeof deps.isWsConnected !== 'function' || deps.isWsConnected() !== true) {
                return _markDeltaHedgeError('WebSocket is not connected.');
            }
            if (runtime.pendingRequest === true) {
                return false;
            }
            if (!_hasActiveDeltaHedgeRestingOrder(runtime)) {
                return _markDeltaHedgeError('No active hedge order is available to cancel.');
            }

            const restingOrder = runtime.restingOrder || {};
            const orderId = restingOrder.orderId ?? runtime.lastPreview?.orderId ?? null;
            const permId = restingOrder.permId ?? runtime.lastPreview?.permId ?? null;
            if (orderId === null && permId === null) {
                return _markDeltaHedgeError('Hedge order id is unavailable.');
            }

            const payload = {
                action: 'cancel_hedge_order',
                hedgeId: restingOrder.hedgeId || runtime.lastPreview?.hedgeId || runtime.pendingSubmitPayload?.hedgeId || null,
                orderId,
                permId,
                requestSource: options.requestSource || 'delta_hedge_manual_cancel',
                reason: options.reason || 'manual_cancel',
            };

            runtime.pendingRequest = true;
            runtime.status = 'cancel_pending';
            runtime.lastError = '';
            runtime.lastOrderEventAt = _nowIsoString();
            _sendPayload(payload);
            _refreshBrokerPreviewUi();
            return true;
        }

        return {
            buildOrderPayload,
            requestBrokerPreview,
            requestSubmit,
            requestCancel,
        };
    }

    globalScope.OptionComboDeltaHedgeTransport = {
        createApi,
    };
})(typeof window !== 'undefined' ? window : globalThis);
