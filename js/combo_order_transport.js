/**
 * Combo-order transport helpers.
 *
 * This module owns combo trigger / close-group websocket payload construction,
 * request-response runtime state transitions, and combo order message
 * reductions. Historical preview builders and date/price helpers can stay in
 * ws_client.js and are injected here as dependencies.
 */

(function attachComboOrderTransport(globalScope) {
    function _getSessionLogicApi() {
        return globalScope.OptionComboSessionLogic && typeof globalScope.OptionComboSessionLogic === 'object'
            ? globalScope.OptionComboSessionLogic
            : null;
    }

    function _getTradeTriggerLogicApi() {
        return globalScope.OptionComboTradeTriggerLogic && typeof globalScope.OptionComboTradeTriggerLogic === 'object'
            ? globalScope.OptionComboTradeTriggerLogic
            : null;
    }

    function _getGroupOrderBuilderApi() {
        return globalScope.OptionComboGroupOrderBuilder && typeof globalScope.OptionComboGroupOrderBuilder === 'object'
            ? globalScope.OptionComboGroupOrderBuilder
            : null;
    }

    function createApi(dependencies) {
        const deps = dependencies && typeof dependencies === 'object' ? dependencies : {};

        function _getState() {
            return deps.state && typeof deps.state === 'object' ? deps.state : {};
        }

        function _isHistoricalMode() {
            return typeof deps.isHistoricalMode === 'function' && deps.isHistoricalMode() === true;
        }

        function _isWsConnected() {
            return typeof deps.isWsConnected === 'function' && deps.isWsConnected() === true;
        }

        function _sendPayload(payload) {
            if (typeof deps.sendPayload !== 'function') {
                throw new Error('WebSocket send is unavailable.');
            }
            deps.sendPayload(payload);
        }

        function _renderGroups() {
            if (typeof deps.renderGroups === 'function') {
                deps.renderGroups();
            }
        }

        function _updateDerivedValues() {
            if (typeof deps.updateDerivedValues === 'function') {
                deps.updateDerivedValues();
            }
        }

        function _requestManagedAccountsSnapshot() {
            if (typeof deps.requestManagedAccountsSnapshot === 'function') {
                deps.requestManagedAccountsSnapshot();
            }
        }

        function _getHistoricalReplayDate() {
            return typeof deps.getHistoricalReplayDate === 'function'
                ? deps.getHistoricalReplayDate()
                : '';
        }

        function _findGroupById(groupId) {
            if (typeof deps.findGroupById === 'function') {
                return deps.findGroupById(groupId);
            }
            return null;
        }

        function _groupHasCostForAllPositionedLegs(group) {
            return typeof deps.groupHasCostForAllPositionedLegs === 'function'
                ? deps.groupHasCostForAllPositionedLegs(group)
                : false;
        }

        function _resolveHistoricalReplayClosePrice(leg, allowIntrinsicFallback) {
            return typeof deps.resolveHistoricalReplayClosePrice === 'function'
                ? deps.resolveHistoricalReplayClosePrice(leg, allowIntrinsicFallback)
                : null;
        }

        function _buildHistoricalTriggerOrderPreview(group, executionMode) {
            return typeof deps.buildHistoricalTriggerOrderPreview === 'function'
                ? deps.buildHistoricalTriggerOrderPreview(group, executionMode)
                : null;
        }

        function _applyHistoricalComboFill(group, runtimeKind, preview) {
            if (typeof deps.applyHistoricalComboFill === 'function') {
                deps.applyHistoricalComboFill(group, runtimeKind, preview);
            }
        }

        function _formatSymbolPriceInputValue(symbol, value) {
            if (typeof deps.formatSymbolPriceInputValue === 'function') {
                return deps.formatSymbolPriceInputValue(symbol, value);
            }
            return String(value ?? '');
        }

        function _flashElement(element) {
            if (typeof deps.flashElement === 'function') {
                deps.flashElement(element);
            }
        }

        function _hasSelectedLiveComboOrderAccount() {
            if (typeof deps.hasSelectedLiveComboOrderAccount === 'function') {
                return deps.hasSelectedLiveComboOrderAccount() === true;
            }
            return !!String(_getState().selectedLiveComboOrderAccount || '').trim();
        }

        function _getLiveComboOrderAccountRequirementMessage() {
            if (typeof deps.getLiveComboOrderAccountRequirementMessage === 'function') {
                return deps.getLiveComboOrderAccountRequirementMessage();
            }
            return 'Select a TWS account before sending combo orders.';
        }

        function _getTradeTrigger(group) {
            const tradeTriggerLogic = _getTradeTriggerLogicApi();
            if (!group) return null;
            if (tradeTriggerLogic && typeof tradeTriggerLogic.ensureGroupTradeTrigger === 'function') {
                return tradeTriggerLogic.ensureGroupTradeTrigger(group);
            }
            group.tradeTrigger = group.tradeTrigger && typeof group.tradeTrigger === 'object'
                ? group.tradeTrigger
                : {};
            return group.tradeTrigger;
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
            const descriptor = payload && typeof payload === 'object' ? payload : {};
            const requestSource = String(descriptor.requestSource || descriptor.source || '').trim().toLowerCase();
            const executionIntent = String(descriptor.executionIntent || descriptor.intent || '').trim().toLowerCase();
            const tradeTrigger = _getTradeTrigger(group);
            const closeExecution = _getCloseExecution(group);
            const descriptorOrderId = descriptor.orderId;
            const descriptorPermId = descriptor.permId;

            let runtimeKind = null;
            if (requestSource === 'close_group' || executionIntent === 'close') {
                runtimeKind = 'closeExecution';
            } else if (requestSource === 'trial_trigger' || executionIntent === 'open') {
                runtimeKind = 'tradeTrigger';
            } else {
                const closePreview = closeExecution && closeExecution.lastPreview && typeof closeExecution.lastPreview === 'object'
                    ? closeExecution.lastPreview
                    : null;
                const triggerPreview = tradeTrigger && tradeTrigger.lastPreview && typeof tradeTrigger.lastPreview === 'object'
                    ? tradeTrigger.lastPreview
                    : null;
                const closeMatchesOrder = !!(
                    closePreview
                    && (
                        (descriptorOrderId != null && closePreview.orderId === descriptorOrderId)
                        || (descriptorPermId != null && closePreview.permId === descriptorPermId)
                    )
                );
                const triggerMatchesOrder = !!(
                    triggerPreview
                    && (
                        (descriptorOrderId != null && triggerPreview.orderId === descriptorOrderId)
                        || (descriptorPermId != null && triggerPreview.permId === descriptorPermId)
                    )
                );

                if (closeMatchesOrder && !triggerMatchesOrder) {
                    runtimeKind = 'closeExecution';
                } else if (triggerMatchesOrder && !closeMatchesOrder) {
                    runtimeKind = 'tradeTrigger';
                } else if (closeExecution && closeExecution.pendingRequest === true && !(tradeTrigger && tradeTrigger.pendingRequest === true)) {
                    runtimeKind = 'closeExecution';
                } else if (tradeTrigger && tradeTrigger.pendingRequest === true && !(closeExecution && closeExecution.pendingRequest === true)) {
                    runtimeKind = 'tradeTrigger';
                } else {
                    runtimeKind = 'tradeTrigger';
                }
            }

            return {
                runtime: runtimeKind === 'closeExecution' ? closeExecution : tradeTrigger,
                runtimeKind,
            };
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

        function _buildCloseGroupComboOrderPayload(group, closeExecution, executionMode = 'submit') {
            if (!closeExecution) {
                return null;
            }

            const groupOrderBuilder = _getGroupOrderBuilderApi();
            if (!groupOrderBuilder || typeof groupOrderBuilder.buildGroupOrderRequestPayload !== 'function') {
                return null;
            }

            return groupOrderBuilder.buildGroupOrderRequestPayload(group, _getState(), {
                action: executionMode === 'preview' ? 'preview_combo_order' : 'submit_combo_order',
                executionMode,
                intent: 'close',
                source: 'close_group',
                managedRepriceThreshold: closeExecution.repriceThreshold,
                managedConcessionRatio: closeExecution.concessionRatio,
                timeInForce: closeExecution.timeInForce,
            });
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

            if (!_isWsConnected()) {
                return false;
            }

            const tradeTriggerLogic = _getTradeTriggerLogicApi();
            const payload = tradeTriggerLogic
                && typeof tradeTriggerLogic.buildComboOrderRequestPayload === 'function'
                ? tradeTriggerLogic.buildComboOrderRequestPayload(group, _getState(), executionMode)
                : null;

            if (!payload) {
                _markTradeTriggerError(group, 'Unable to build combo submit payload.');
                _renderGroups();
                return false;
            }

            const trigger = _getTradeTrigger(group);
            if (!trigger) {
                return false;
            }

            trigger.pendingRequest = true;
            trigger.lastError = '';
            trigger.status = executionMode === 'test_submit' ? 'pending_test_submit' : 'pending_submit';
            _sendPayload(payload);
            _renderGroups();
            return true;
        }

        function _applyHistoricalTriggerOrderPreview(group, executionMode) {
            const trigger = _getTradeTrigger(group);
            if (!trigger) {
                return false;
            }

            const result = _buildHistoricalTriggerOrderPreview(group, executionMode);
            if (!result || !result.preview) {
                _markTradeTriggerError(group, result && result.error
                    ? result.error
                    : 'Unable to build a historical replay combo order preview.');
                _renderGroups();
                return false;
            }

            const applyResult = _applyComboOrderResult({
                action: executionMode === 'preview' ? 'combo_order_preview_result' : 'combo_order_submit_result',
                groupId: group.id,
                preview: executionMode === 'preview' ? result.preview : undefined,
                order: executionMode === 'preview' ? undefined : result.preview,
            });
            if (executionMode === 'submit') {
                _applyHistoricalComboFill(group, 'tradeTrigger', result.preview);
            }
            return applyResult;
        }

        function _settleHistoricalReplayGroup(group) {
            const closeExecution = _getCloseExecution(group);
            if (!closeExecution) {
                return false;
            }

            if (!_groupHasOpenPositions(group)) {
                _markCloseExecutionError(group, 'This group has no open position to close.');
                return false;
            }

            if (!_groupHasCostForAllPositionedLegs(group)) {
                _markCloseExecutionError(group, 'Historical settlement needs a locked entry cost for every open leg. Use Enter @ Replay Day or let base-day quotes seed the costs first.');
                return false;
            }

            const missingLegs = [];
            const settledLegs = [];

            (group.legs || []).forEach((leg) => {
                const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
                if (pos < 0.0001 || (leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined)) {
                    return;
                }

                const closePrice = _resolveHistoricalReplayClosePrice(leg, true);
                if (!Number.isFinite(closePrice) || closePrice < 0) {
                    missingLegs.push(leg);
                    return;
                }

                leg.closePrice = closePrice;
                settledLegs.push(leg);
            });

            if (missingLegs.length > 0) {
                _markCloseExecutionError(group, `Historical close price is unavailable for ${missingLegs.length} leg(s) on ${_getHistoricalReplayDate() || 'the selected day'}.`);
                return false;
            }

            const state = _getState();
            group.settleUnderlyingPrice = Number.isFinite(state.underlyingPrice) ? state.underlyingPrice : group.settleUnderlyingPrice;
            group.viewMode = 'settlement';

            closeExecution.pendingRequest = false;
            closeExecution.lastError = '';
            closeExecution.status = 'submitted';
            closeExecution.lastPreview = {
                ...(closeExecution.lastPreview || {}),
                executionMode: 'submit',
                executionIntent: 'close',
                requestSource: 'close_group',
                status: 'Filled',
                statusMessage: `Historical replay simulated close filled on ${_getHistoricalReplayDate() || 'the selected day'}.`,
                orderId: closeExecution.lastPreview && closeExecution.lastPreview.orderId,
                permId: closeExecution.lastPreview && closeExecution.lastPreview.permId,
                closePriceSource: 'historical_replay',
                legs: settledLegs.map((leg) => ({
                    id: leg.id,
                    closePrice: leg.closePrice,
                })),
            };

            _renderGroups();
            _updateDerivedValues();
            return true;
        }

        function requestContinueManagedComboOrder(group, runtimeKind = 'tradeTrigger') {
            if (!group || !_isWsConnected()) {
                return false;
            }

            const executionRuntime = _getExecutionRuntimeByKind(group, runtimeKind);
            const preview = executionRuntime && executionRuntime.lastPreview;
            if (!executionRuntime || !preview || !preview.orderId) {
                _markExecutionError(group, 'No resumable managed combo order was found.', runtimeKind);
                _renderGroups();
                return false;
            }

            if (executionRuntime.pendingRequest) {
                return false;
            }

            executionRuntime.pendingRequest = true;
            executionRuntime.lastError = '';
            executionRuntime.status = 'pending_resume';
            _sendPayload({
                action: 'resume_managed_combo_order',
                groupId: group.id,
                orderId: preview.orderId,
                permId: preview.permId || null,
                executionIntent: runtimeKind === 'closeExecution' ? 'close' : 'open',
                requestSource: runtimeKind === 'closeExecution' ? 'close_group' : 'trial_trigger',
            });
            _renderGroups();
            return true;
        }

        function requestConcedeManagedComboOrder(group, concessionRatio, runtimeKind = 'tradeTrigger') {
            if (!group || !_isWsConnected()) {
                return false;
            }

            const executionRuntime = _getExecutionRuntimeByKind(group, runtimeKind);
            const preview = executionRuntime && executionRuntime.lastPreview;
            if (!executionRuntime || !preview || !preview.orderId) {
                _markExecutionError(group, 'No live combo order is available for concession repricing.', runtimeKind);
                _renderGroups();
                return false;
            }

            if (executionRuntime.pendingRequest) {
                return false;
            }

            const parsedRatio = parseFloat(concessionRatio);
            if (!Number.isFinite(parsedRatio)) {
                _markExecutionError(group, 'Invalid concession ratio.', runtimeKind);
                _renderGroups();
                return false;
            }

            executionRuntime.pendingRequest = true;
            executionRuntime.lastError = '';
            executionRuntime.status = 'pending_concede';
            _sendPayload({
                action: 'concede_managed_combo_order',
                groupId: group.id,
                orderId: preview.orderId,
                permId: preview.permId || null,
                concessionRatio: parsedRatio,
                executionIntent: runtimeKind === 'closeExecution' ? 'close' : 'open',
                requestSource: runtimeKind === 'closeExecution' ? 'close_group' : 'trial_trigger',
            });
            _renderGroups();
            return true;
        }

        function requestCancelManagedComboOrder(group, reason = 'manual_cancel', runtimeKind = 'tradeTrigger') {
            if (!group) {
                return false;
            }

            const executionRuntime = _getExecutionRuntimeByKind(group, runtimeKind);
            const preview = executionRuntime && executionRuntime.lastPreview;
            if (!executionRuntime || !preview || !preview.orderId) {
                _markExecutionError(group, 'No cancellable combo order was found.', runtimeKind);
                _renderGroups();
                return false;
            }

            if (executionRuntime.pendingRequest) {
                return false;
            }

            if (_isHistoricalMode()) {
                const brokerStatus = String(preview.status || '').trim();
                if (['Filled', 'Cancelled', 'ApiCancelled', 'Inactive'].includes(brokerStatus)) {
                    _markExecutionError(group, 'This historical replay order is already closed.', runtimeKind);
                    _renderGroups();
                    return false;
                }

                executionRuntime.pendingRequest = false;
                executionRuntime.lastError = '';
                executionRuntime.lastPreview = {
                    ...preview,
                    status: 'Cancelled',
                    remaining: 0,
                    filled: Number.isFinite(preview.filled) ? preview.filled : 0,
                    managedMode: false,
                    managedState: 'cancelled',
                    statusMessage: `Historical replay simulated order cancelled on ${_getHistoricalReplayDate() || 'the selected day'} (${reason}).`,
                };
                executionRuntime.status = preview.executionMode === 'test_submit'
                    ? 'test_submitted'
                    : (preview.executionMode === 'preview' ? 'previewed' : 'submitted');
                _renderGroups();
                _updateDerivedValues();
                return true;
            }

            if (!_isWsConnected()) {
                return false;
            }

            executionRuntime.pendingRequest = true;
            executionRuntime.lastError = '';
            executionRuntime.status = 'pending_cancel';
            _sendPayload({
                action: 'cancel_managed_combo_order',
                groupId: group.id,
                orderId: preview.orderId,
                permId: preview.permId || null,
                reason,
                executionIntent: runtimeKind === 'closeExecution' ? 'close' : 'open',
                requestSource: runtimeKind === 'closeExecution' ? 'close_group' : 'trial_trigger',
            });
            _renderGroups();
            return true;
        }

        function requestCloseGroupComboOrder(group) {
            if (!group) return false;
            const state = _getState();
            if (_isHistoricalMode()) {
                const didSettle = _settleHistoricalReplayGroup(group);
                if (!didSettle) {
                    _renderGroups();
                }
                return didSettle;
            }
            if (!_isWsConnected()) {
                _markCloseExecutionError(group, 'WebSocket is not connected.');
                _renderGroups();
                return false;
            }
            if (!_groupHasOpenPositions(group)) {
                _markCloseExecutionError(group, 'This group has no open position to close.');
                _renderGroups();
                return false;
            }
            const sessionLogic = _getSessionLogicApi();
            if (sessionLogic
                && typeof sessionLogic.getRenderableGroupViewMode === 'function'
                && sessionLogic.getRenderableGroupViewMode(group) !== 'active') {
                _markCloseExecutionError(group, 'Close Group is only available when this group is in Active mode.');
                _renderGroups();
                return false;
            }

            const closeExecution = _getCloseExecution(group);
            if (!closeExecution || closeExecution.pendingRequest) {
                return false;
            }

            const executionMode = closeExecution.executionMode === 'submit' || closeExecution.executionMode === 'test_submit'
                ? closeExecution.executionMode
                : 'preview';

            if ((executionMode === 'submit' || executionMode === 'test_submit') && state.allowLiveComboOrders !== true) {
                _markCloseExecutionError(group, 'Global live combo order switch is OFF.');
                _renderGroups();
                return false;
            }
            if ((executionMode === 'submit' || executionMode === 'test_submit') && !_hasSelectedLiveComboOrderAccount()) {
                _markCloseExecutionError(group, _getLiveComboOrderAccountRequirementMessage());
                if (state.allowLiveComboOrders === true) {
                    _requestManagedAccountsSnapshot();
                }
                _renderGroups();
                return false;
            }

            const payload = _buildCloseGroupComboOrderPayload(group, closeExecution, executionMode);
            if (!payload) {
                _markCloseExecutionError(group, 'Unable to build close-group combo order payload.');
                _renderGroups();
                return false;
            }

            closeExecution.pendingRequest = true;
            closeExecution.lastError = '';
            if (executionMode === 'preview') {
                closeExecution.status = 'pending_preview';
            } else {
                payload.action = 'validate_combo_order';
                closeExecution.status = 'pending_validation';
            }
            _sendPayload(payload);
            _renderGroups();
            return true;
        }

        function requestTrialGroupComboOrder(group) {
            if (!group) return;
            const state = _getState();
            const trigger = _getTradeTrigger(group);
            if (!trigger) return;

            const executionMode = trigger.executionMode === 'submit' || trigger.executionMode === 'test_submit'
                ? trigger.executionMode
                : 'preview';

            if (_isHistoricalMode()) {
                trigger.pendingRequest = true;
                trigger.status = executionMode === 'submit'
                    ? 'pending_submit'
                    : (executionMode === 'test_submit' ? 'pending_test_submit' : 'pending_preview');
                trigger.lastError = '';
                trigger.lastTriggeredAt = new Date().toISOString();
                trigger.lastTriggerPrice = state.underlyingPrice;
                _applyHistoricalTriggerOrderPreview(group, executionMode);
                return;
            }

            if (!_isWsConnected()) {
                _markTradeTriggerError(group, 'WebSocket is not connected.');
                _renderGroups();
                return;
            }

            if ((executionMode === 'submit' || executionMode === 'test_submit') && state.allowLiveComboOrders !== true) {
                _markTradeTriggerError(group, 'Global live combo order switch is OFF.');
                _renderGroups();
                return;
            }
            if ((executionMode === 'submit' || executionMode === 'test_submit') && !_hasSelectedLiveComboOrderAccount()) {
                _markTradeTriggerError(group, _getLiveComboOrderAccountRequirementMessage());
                if (state.allowLiveComboOrders === true) {
                    _requestManagedAccountsSnapshot();
                }
                _renderGroups();
                return;
            }

            const tradeTriggerLogic = _getTradeTriggerLogicApi();
            const payload = tradeTriggerLogic
                && typeof tradeTriggerLogic.buildComboOrderRequestPayload === 'function'
                ? tradeTriggerLogic.buildComboOrderRequestPayload(group, state, executionMode)
                : null;

            if (!payload) {
                _markTradeTriggerError(group, 'Unable to build combo order payload.');
                _renderGroups();
                return;
            }

            trigger.pendingRequest = true;
            if (executionMode === 'submit' || executionMode === 'test_submit') {
                payload.action = 'validate_combo_order';
                trigger.status = 'pending_validation';
            } else {
                trigger.status = 'pending_preview';
            }
            trigger.lastError = '';
            trigger.lastTriggeredAt = new Date().toISOString();
            trigger.lastTriggerPrice = state.underlyingPrice;

            _sendPayload(payload);
            _renderGroups();
        }

        function _applyComboOrderValidationResult(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const validation = data.validation || {};
            const { runtime, runtimeKind } = _resolveExecutionRuntime(group, validation);
            if (!runtime) return true;

            if (validation.valid !== true) {
                _markExecutionError(group, 'Combo validation failed.', runtimeKind);
                _renderGroups();
                return true;
            }

            if (!_isWsConnected()) {
                _markExecutionError(group, 'WebSocket is not connected.', runtimeKind);
                _renderGroups();
                return true;
            }

            const nextMode = validation.executionMode === 'test_submit' ? 'test_submit' : 'submit';
            const state = _getState();
            if (_isHistoricalMode()) {
                if (runtimeKind === 'closeExecution') {
                    requestCloseGroupComboOrder(group);
                    return true;
                }
                runtime.pendingRequest = false;
                _sendValidatedComboSubmit(group, nextMode);
                return true;
            }
            if (state.allowLiveComboOrders !== true) {
                _markExecutionError(group, 'Global live combo order switch is OFF.', runtimeKind);
                _renderGroups();
                return true;
            }
            if (!_hasSelectedLiveComboOrderAccount()) {
                _markExecutionError(group, _getLiveComboOrderAccountRequirementMessage(), runtimeKind);
                _requestManagedAccountsSnapshot();
                _renderGroups();
                return true;
            }

            runtime.pendingRequest = false;
            if (runtimeKind === 'closeExecution') {
                const payload = _buildCloseGroupComboOrderPayload(group, runtime, nextMode);
                if (!payload) {
                    _markCloseExecutionError(group, 'Unable to build close-group combo submit payload.');
                    _renderGroups();
                    return true;
                }

                runtime.pendingRequest = true;
                runtime.lastError = '';
                runtime.status = 'pending_submit';
                _sendPayload(payload);
                _renderGroups();
                return true;
            }

            return _sendValidatedComboSubmit(group, nextMode);
        }

        function _applyComboOrderResult(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const payload = data.preview || data.order || {};
            const { runtime, runtimeKind } = _resolveExecutionRuntime(group, payload);
            if (!runtime) return true;

            runtime.pendingRequest = false;
            if (runtimeKind === 'tradeTrigger') {
                runtime.enabled = false;
            }
            runtime.lastPreview = payload || null;
            const orderStatus = String((runtime.lastPreview && runtime.lastPreview.status) || '').trim();
            const statusMessage = String((runtime.lastPreview && runtime.lastPreview.statusMessage) || '').trim();
            if (data.action === 'combo_order_submit_result'
                && _isSoftTerminalBrokerStatus(orderStatus)
                && !_isManagedTerminalConfirmation(runtime.lastPreview)) {
                runtime.lastError = statusMessage || `TWS returned ${orderStatus}.`;
                runtime.status = 'error';
            } else if (data.action === 'combo_order_submit_result') {
                const executionMode = String((runtime.lastPreview && runtime.lastPreview.executionMode) || '').trim();
                runtime.lastError = '';
                runtime.status = executionMode === 'test_submit' ? 'test_submitted' : 'submitted';
            } else {
                runtime.lastError = '';
                runtime.status = 'previewed';
            }

            if (data.action === 'combo_order_submit_result'
                && String(runtime.lastPreview && runtime.lastPreview.status || '').trim() === 'Filled'
                && String(runtime.lastPreview && runtime.lastPreview.executionMode || '').trim() === 'submit') {
                if (runtimeKind !== 'closeExecution') {
                    _maybePromoteFilledTrialGroupToActive(group, runtime);
                }
            }

            _renderGroups();
            _updateDerivedValues();
            return true;
        }

        function _applyComboOrderStatusUpdate(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const update = data.orderStatus || {};
            const { runtime, runtimeKind } = _resolveExecutionRuntime(group, update);
            if (!runtime) return true;

            if (!runtime.lastPreview || typeof runtime.lastPreview !== 'object') {
                runtime.lastPreview = {};
            }

            if (update.managedMode === false) {
                const {
                    managedMode,
                    managedState,
                    workingLimitPrice,
                    latestComboMid,
                    bestComboPrice,
                    worstComboPrice,
                    managedRepriceThreshold,
                    managedConcessionRatio,
                    repricingCount,
                    maxRepriceCount,
                    lastRepriceAt,
                    managedMessage,
                    canContinueRepricing,
                    canConcedePricing,
                    continueActionLabel,
                    ...nonManagedPreview
                } = runtime.lastPreview;
                runtime.lastPreview = nonManagedPreview;
            }

            runtime.lastPreview = {
                ...runtime.lastPreview,
                ...update,
            };

            const brokerStatus = String(runtime.lastPreview.status || '').trim();
            const statusMessage = String(runtime.lastPreview.statusMessage || '').trim();
            const executionMode = String(runtime.lastPreview.executionMode || '').trim();

            if (_isSoftTerminalBrokerStatus(brokerStatus)
                && !_isManagedTerminalConfirmation(runtime.lastPreview)) {
                runtime.lastError = statusMessage || `TWS returned ${brokerStatus}.`;
                runtime.status = 'error';
            } else {
                runtime.lastError = '';
                if (executionMode === 'test_submit') {
                    runtime.status = 'test_submitted';
                } else if (executionMode === 'submit') {
                    runtime.status = 'submitted';
                }
            }

            if (String(runtime.lastPreview.status || '').trim() === 'Filled'
                && String(runtime.lastPreview.executionMode || '').trim() === 'submit') {
                if (runtimeKind !== 'closeExecution') {
                    _maybePromoteFilledTrialGroupToActive(group, runtime);
                }
            }

            _renderGroups();
            _updateDerivedValues();
            return true;
        }

        function _applyComboOrderResumeResult(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const orderStatus = data.orderStatus || {};
            const { runtime } = _resolveExecutionRuntime(group, orderStatus);
            if (!runtime) return true;

            runtime.pendingRequest = false;
            runtime.lastError = '';
            if (!runtime.lastPreview || typeof runtime.lastPreview !== 'object') {
                runtime.lastPreview = {};
            }
            runtime.lastPreview = {
                ...runtime.lastPreview,
                ...orderStatus,
            };
            runtime.status = 'submitted';
            _renderGroups();
            _updateDerivedValues();
            return true;
        }

        function _applyComboOrderConcedeResult(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const orderStatus = data.orderStatus || {};
            const { runtime } = _resolveExecutionRuntime(group, orderStatus);
            if (!runtime) return true;

            runtime.pendingRequest = false;
            runtime.lastError = '';
            if (!runtime.lastPreview || typeof runtime.lastPreview !== 'object') {
                runtime.lastPreview = {};
            }
            runtime.lastPreview = {
                ...runtime.lastPreview,
                ...orderStatus,
            };
            runtime.status = 'submitted';
            _renderGroups();
            _updateDerivedValues();
            return true;
        }

        function _applyComboOrderCancelResult(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const orderStatus = data.orderStatus || {};
            const { runtime } = _resolveExecutionRuntime(group, orderStatus);
            if (!runtime) return true;

            runtime.pendingRequest = false;
            runtime.lastError = '';
            if (!runtime.lastPreview || typeof runtime.lastPreview !== 'object') {
                runtime.lastPreview = {};
            }
            runtime.lastPreview = {
                ...runtime.lastPreview,
                ...orderStatus,
            };
            runtime.status = 'pending_cancel';
            _renderGroups();
            _updateDerivedValues();
            return true;
        }

        function _applyComboOrderFillCostUpdate(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const state = _getState();
            const orderFill = data.orderFill || {};
            const { runtime, runtimeKind } = _resolveExecutionRuntime(group, orderFill);
            const legs = Array.isArray(orderFill.legs) ? orderFill.legs : [];
            if (legs.length === 0) {
                return true;
            }

            let stateChanged = false;
            legs.forEach(fillLeg => {
                const leg = (group.legs || []).find(item => item.id === fillLeg.id);
                if (!leg) {
                    return;
                }

                const nextCost = Math.abs(parseFloat(fillLeg.avgFillPrice));
                if (!Number.isFinite(nextCost) || nextCost <= 0) {
                    return;
                }

                if (runtimeKind === 'closeExecution') {
                    if (Math.abs((parseFloat(leg.closePrice) || 0) - nextCost) <= 0.0001
                        && leg.closePriceSource === 'execution_report') {
                        return;
                    }

                    leg.closePrice = nextCost;
                    leg.closePriceSource = 'execution_report';
                    leg.closeExecutionOrderId = orderFill.orderId || null;
                    leg.closeExecutionPermId = orderFill.permId || null;
                } else {
                    if (Math.abs((parseFloat(leg.cost) || 0) - nextCost) <= 0.0001
                        && leg.costSource === 'execution_report') {
                        return;
                    }

                    leg.cost = nextCost;
                    leg.costSource = 'execution_report';
                    leg.executionReportedCost = true;
                    leg.executionReportOrderId = orderFill.orderId || null;
                    leg.executionReportPermId = orderFill.permId || null;
                }
                stateChanged = true;

                const row = globalScope.document && typeof globalScope.document.querySelector === 'function'
                    ? globalScope.document.querySelector(`tr[data-id="${leg.id}"]`)
                    : null;
                if (row) {
                    const targetInput = runtimeKind === 'closeExecution'
                        ? row.querySelector('.close-price-input')
                        : row.querySelector('.cost-input');
                    if (targetInput) {
                        targetInput.value = _formatSymbolPriceInputValue(state.underlyingSymbol, nextCost);
                        _flashElement(targetInput);
                    }
                }
            });

            if (!stateChanged) {
                return true;
            }

            if (runtime && (!runtime.lastPreview || typeof runtime.lastPreview !== 'object')) {
                runtime.lastPreview = {};
            }
            if (runtime && runtime.lastPreview) {
                if (runtimeKind === 'closeExecution') {
                    runtime.lastPreview.closePriceSource = 'execution_report';
                } else {
                    runtime.lastPreview.costSource = 'execution_report';
                }
            }

            if (runtimeKind !== 'closeExecution') {
                _maybePromoteFilledTrialGroupToActive(group, runtime);
            }

            _renderGroups();
            return true;
        }

        function _applyComboOrderError(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const { runtimeKind } = _resolveExecutionRuntime(group, data);
            _markExecutionError(group, data.message || 'Combo order request failed.', runtimeKind);
            _renderGroups();
            return true;
        }

        function _applyActiveComboOrdersSnapshot(data) {
            const orders = Array.isArray(data && data.orders) ? data.orders : [];
            orders.forEach((order) => {
                if (!order || typeof order !== 'object' || !order.groupId) {
                    return;
                }
                _applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: order.groupId,
                    orderStatus: order,
                });
            });
            return true;
        }

        function handleMessage(data) {
            if (!data || typeof data !== 'object' || !data.action) {
                return false;
            }

            if (data.action === 'combo_order_validation_result') {
                return _applyComboOrderValidationResult(data);
            }
            if (data.action === 'active_combo_orders_snapshot') {
                return _applyActiveComboOrdersSnapshot(data);
            }
            if (data.action === 'combo_order_preview_result' || data.action === 'combo_order_submit_result') {
                return _applyComboOrderResult(data);
            }
            if (data.action === 'combo_order_status_update') {
                return _applyComboOrderStatusUpdate(data);
            }
            if (data.action === 'combo_order_resume_result') {
                return _applyComboOrderResumeResult(data);
            }
            if (data.action === 'combo_order_concede_result') {
                return _applyComboOrderConcedeResult(data);
            }
            if (data.action === 'combo_order_cancel_result') {
                return _applyComboOrderCancelResult(data);
            }
            if (data.action === 'combo_order_fill_cost_update') {
                return _applyComboOrderFillCostUpdate(data);
            }
            if (data.action === 'combo_order_error') {
                return _applyComboOrderError(data);
            }
            return false;
        }

        return {
            requestTrialGroupComboOrder,
            requestCloseGroupComboOrder,
            requestContinueManagedComboOrder,
            requestConcedeManagedComboOrder,
            requestCancelManagedComboOrder,
            handleMessage,
            _test: {
                resolveExecutionRuntime: _resolveExecutionRuntime,
                applyHistoricalTriggerOrderPreview: _applyHistoricalTriggerOrderPreview,
                settleHistoricalReplayGroup: _settleHistoricalReplayGroup,
                applyComboOrderValidationResult: _applyComboOrderValidationResult,
                applyComboOrderResult: _applyComboOrderResult,
                applyComboOrderStatusUpdate: _applyComboOrderStatusUpdate,
                applyActiveComboOrdersSnapshot: _applyActiveComboOrdersSnapshot,
                applyComboOrderResumeResult: _applyComboOrderResumeResult,
                applyComboOrderConcedeResult: _applyComboOrderConcedeResult,
                applyComboOrderCancelResult: _applyComboOrderCancelResult,
                applyComboOrderFillCostUpdate: _applyComboOrderFillCostUpdate,
                applyComboOrderError: _applyComboOrderError,
                markExecutionError: _markExecutionError,
                isSoftTerminalBrokerStatus: _isSoftTerminalBrokerStatus,
                buildCloseGroupComboOrderPayload: _buildCloseGroupComboOrderPayload,
            },
        };
    }

    globalScope.OptionComboComboOrderTransport = {
        createApi,
    };
})(typeof window !== 'undefined' ? window : globalThis);
