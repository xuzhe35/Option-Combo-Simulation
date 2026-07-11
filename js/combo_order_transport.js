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

        function _clonePayload(payload) {
            return payload && typeof payload === 'object'
                ? JSON.parse(JSON.stringify(payload))
                : null;
        }

        function _requestClosePlanRevocation(group, runtime, reason) {
            const preview = runtime && runtime.lastPreview && typeof runtime.lastPreview === 'object'
                ? runtime.lastPreview
                : null;
            const token = String(preview && preview.closePlanToken || '').trim();
            const targetMode = String(runtime && runtime.pendingConfirmationMode || '').trim();
            const basePayload = runtime && runtime.pendingClosePlanPayload;
            if (!group || !token || !['submit', 'test_submit'].includes(targetMode) || !_isWsConnected()) {
                return false;
            }

            try {
                _sendPayload({
                    action: 'cancel_close_plan',
                    groupId: String(group.id || ''),
                    account: String(
                        basePayload && basePayload.account
                        || preview && preview.account
                        || _getState().selectedLiveComboOrderAccount
                        || ''
                    ).trim(),
                    executionMode: targetMode,
                    confirmationTargetMode: targetMode,
                    executionIntent: 'close',
                    requestSource: 'close_group',
                    closePlanToken: token,
                    cancelReason: String(reason || 'user_cancelled'),
                });
                return true;
            } catch (_error) {
                return false;
            }
        }

        function _clearClosePlanConfirmation(runtime, status) {
            if (!runtime) {
                return;
            }
            if (runtime.lastPreview && typeof runtime.lastPreview === 'object') {
                delete runtime.lastPreview.closePlanToken;
                runtime.lastPreview.closePlanConfirmationStatus = String(status || 'cancelled');
                runtime.lastPreview.closePlanConfirmationClosedAt = new Date().toISOString();
            }
            runtime.pendingRequest = false;
            runtime.pendingConfirmationMode = '';
            runtime.pendingClosePlanPayload = null;
            runtime.confirmedClosePlanPayload = null;
        }

        function _showCloseConfirmationDialog(group, runtime, preview) {
            const ui = globalScope.OptionComboGroupEditorUI;
            const showDialog = typeof deps.showCloseConfirmationDialog === 'function'
                ? deps.showCloseConfirmationDialog
                : (ui && typeof ui.openCloseConfirmationDialog === 'function'
                    ? ui.openCloseConfirmationDialog
                    : null);
            if (!showDialog) {
                _requestClosePlanRevocation(group, runtime, 'confirmation_ui_unavailable');
                _clearClosePlanConfirmation(runtime, 'cancelled');
                _markCloseExecutionError(
                    group,
                    'Close Plan was previewed, but the confirmation dialog is unavailable. No TWS order was sent.'
                );
                _renderGroups();
                return false;
            }
            const checker = globalScope.OptionComboLegPositionCheck;
            const state = _getState();
            const pendingPayload = runtime && runtime.pendingClosePlanPayload;
            const detectedPositionWarnings = checker && typeof checker.findOrderReductions === 'function'
                ? checker.findOrderReductions(
                    pendingPayload && pendingPayload.legs,
                    state,
                    state.portfolioPositions || [],
                    state.selectedLiveComboOrderAccount,
                    state.groups || [],
                    group.id
                )
                : [];
            const positionWarnings = detectedPositionWarnings.filter((warning) => (
                Array.isArray(warning.otherGroupNames) && warning.otherGroupNames.length > 0
            ));
            const opened = showDialog({
                group,
                preview,
                targetMode: runtime.pendingConfirmationMode,
                positionWarnings,
                crossGroupWarningsOnly: true,
                closeQuantity: parseInt(pendingPayload && pendingPayload.closeQuantity, 10) || null,
                closeMaxQuantity: parseInt(pendingPayload && pendingPayload.closeMaxQuantity, 10) || null,
                positionSnapshotAvailable: state.portfolioPositionsConnected === true,
                onConfirm: () => confirmClosePlan(group),
                onCancel: () => cancelClosePlan(group),
            }) !== false;
            if (!opened) {
                _requestClosePlanRevocation(group, runtime, 'confirmation_ui_rejected');
                _clearClosePlanConfirmation(runtime, 'cancelled');
                _markCloseExecutionError(
                    group,
                    'Close Plan confirmation dialog could not be opened. No TWS order was sent.'
                );
                _renderGroups();
            }
            return opened;
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

        function _isSameBrokerOrder(left, right) {
            const leftOrderId = left && left.orderId != null ? String(left.orderId) : '';
            const rightOrderId = right && right.orderId != null ? String(right.orderId) : '';
            if (leftOrderId && rightOrderId) {
                return leftOrderId === rightOrderId;
            }

            const leftPermId = left && left.permId != null ? String(left.permId) : '';
            const rightPermId = right && right.permId != null ? String(right.permId) : '';
            return !!(leftPermId && rightPermId && leftPermId === rightPermId);
        }

        function _toFiniteNumberOrNull(value) {
            const parsed = parseFloat(value);
            return Number.isFinite(parsed) ? parsed : null;
        }

        function _hasResolvedClosePrice(leg) {
            return !!(leg
                && leg.closePrice !== null
                && leg.closePrice !== ''
                && leg.closePrice !== undefined);
        }

        function _normalizeLegIds(legIds) {
            if (!Array.isArray(legIds)) {
                return [];
            }
            return legIds
                .map((id) => String(id || '').trim())
                .filter(Boolean);
        }

        function _getScopedLegs(group, legIds) {
            const legs = Array.isArray(group && group.legs) ? group.legs : [];
            const normalizedLegIds = _normalizeLegIds(legIds);
            if (normalizedLegIds.length === 0) {
                return legs;
            }
            const legIdSet = new Set(normalizedLegIds);
            return legs.filter((leg) => legIdSet.has(String(leg && leg.id || '').trim()));
        }

        function _isOpenPositionLeg(leg) {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            return pos > 0.0001 && !_hasResolvedClosePrice(leg);
        }

        function _hasOpenPositionsInScope(group, legIds) {
            return _getScopedLegs(group, legIds).some(_isOpenPositionLeg);
        }

        function _hasCostForAllPositionedLegsInScope(group, legIds) {
            return _getScopedLegs(group, legIds).every((leg) => {
                const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
                if (pos < 0.0001 || _hasResolvedClosePrice(leg)) {
                    return true;
                }
                return Math.abs(parseFloat(leg && leg.cost) || 0) > 0;
            });
        }

        function _setCloseExecutionTarget(closeExecution, legIds) {
            if (!closeExecution) {
                return [];
            }
            const normalizedLegIds = _normalizeLegIds(legIds);
            closeExecution.pendingCloseLegIds = normalizedLegIds;
            closeExecution.pendingCloseScope = normalizedLegIds.length > 0 ? 'leg' : 'group';
            return normalizedLegIds;
        }

        function _buildSyntheticAssignmentId(prefix, sourceId) {
            const normalizedSource = String(sourceId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'leg';
            return `_${prefix}_${normalizedSource}_${Math.random().toString(36).slice(2, 8)}`;
        }

        function _applyEquivalentExpiryAdjustment(group, adjustment) {
            const optionLegId = String(adjustment && adjustment.optionLegId || '').trim();
            const optionLeg = (group && group.legs || []).find((leg) => (
                leg && String(leg.id || '') === optionLegId
            ));
            if (!optionLeg) {
                return false;
            }

            const classification = String(adjustment.classification || '').trim().toLowerCase();
            if (!['otm_ignored', 'itm_hedged'].includes(classification)) {
                return false;
            }

            const adjustmentId = String(
                adjustment.adjustmentId || `equivalent-expiry:${optionLegId}`
            ).trim();
            const requiredUnderlyingQuantity = _toFiniteNumberOrNull(adjustment.requiredUnderlyingQuantity);
            let changed = false;

            const closePriceSource = classification === 'otm_ignored'
                ? 'equivalent_expiry_otm_ignored'
                : 'equivalent_expiry_hedged';
            if (!_hasResolvedClosePrice(optionLeg)
                || Number(optionLeg.closePrice) !== 0
                || optionLeg.closePriceSource !== closePriceSource) {
                optionLeg.closePrice = 0;
                optionLeg.closePriceSource = closePriceSource;
                changed = true;
            }

            const metadata = {
                equivalentCloseAdjustmentId: adjustmentId,
                equivalentCloseClassification: classification,
                equivalentCloseExpiry: adjustment.expiry || optionLeg.expDate || '',
                equivalentCloseUnderlyingSymbol: adjustment.underlyingSymbol || '',
                equivalentCloseRequiredUnderlyingQuantity: requiredUnderlyingQuantity,
                equivalentCloseExecutedUnderlyingQuantity: _toFiniteNumberOrNull(adjustment.executedUnderlyingQuantity) || 0,
                equivalentCloseNettedUnderlyingQuantity: _toFiniteNumberOrNull(adjustment.internallyNettedUnderlyingQuantity) || 0,
                equivalentCloseFillPrice: _toFiniteNumberOrNull(adjustment.underlyingAvgFillPrice),
                equivalentCloseReferencePrice: _toFiniteNumberOrNull(adjustment.observedUnderlyingPrice),
                equivalentCloseOrderId: adjustment.underlyingOrderId || null,
                equivalentClosePermId: adjustment.underlyingPermId || null,
                pendingExpirySettlement: true,
            };
            Object.entries(metadata).forEach(([key, value]) => {
                if (optionLeg[key] !== value) {
                    optionLeg[key] = value;
                    changed = true;
                }
            });

            if (classification === 'itm_hedged'
                && Number.isFinite(requiredUnderlyingQuantity)
                && Math.abs(requiredUnderlyingQuantity) > 0.0001) {
                const underlyingLegId = String(adjustment.underlyingLegId || '').trim()
                    || _buildSyntheticAssignmentId('expiry_hedge', optionLegId);
                let underlyingLeg = (group.legs || []).find((leg) => (
                    leg && String(leg.id || '') === underlyingLegId
                ));
                const strike = Math.abs(_toFiniteNumberOrNull(adjustment.assignmentStrike)
                    || _toFiniteNumberOrNull(optionLeg.strike)
                    || 0);
                const hedgeBasisPrice = Math.abs(
                    _toFiniteNumberOrNull(adjustment.hedgeBasisPrice)
                    || _toFiniteNumberOrNull(adjustment.underlyingAvgFillPrice)
                    || _toFiniteNumberOrNull(adjustment.observedUnderlyingPrice)
                    || 0
                );
                if (!underlyingLeg) {
                    underlyingLeg = {
                        id: underlyingLegId,
                        type: 'stock',
                        pos: requiredUnderlyingQuantity,
                        strike: 0,
                        expDate: '',
                        iv: 0,
                        ivSource: 'manual',
                        ivManualOverride: false,
                        currentPrice: strike,
                        currentPriceSource: 'equivalent_expiry_offset',
                        portfolioMarketPrice: null,
                        portfolioMarketPriceSource: '',
                        portfolioUnrealizedPnl: null,
                        cost: hedgeBasisPrice,
                        costSource: Math.abs(metadata.equivalentCloseExecutedUnderlyingQuantity) > 0.0001
                            ? 'equivalent_expiry_execution'
                            : 'equivalent_expiry_internal_net',
                        closePrice: strike,
                        closePriceSource: 'equivalent_expiry_offset',
                        underlyingFutureId: optionLeg.underlyingFutureId || '',
                        equivalentCloseAdjustmentId: adjustmentId,
                        equivalentCloseSourceLegId: optionLegId,
                        equivalentCloseExpiry: adjustment.expiry || optionLeg.expDate || '',
                        pendingExpirySettlement: true,
                    };
                    group.legs.push(underlyingLeg);
                    changed = true;
                }
            }

            group.equivalentCloseState = {
                status: 'pending_expiry_settlement',
                updatedAt: new Date().toISOString(),
            };
            return changed;
        }

        function _applyAssignmentAdjustment(group, adjustment) {
            if (!group || !adjustment || typeof adjustment !== 'object') {
                return false;
            }

            if (String(adjustment.kind || '').trim().toLowerCase() === 'equivalent_expiry') {
                return _applyEquivalentExpiryAdjustment(group, adjustment);
            }

            const optionLegId = String(adjustment.optionLegId || '').trim();
            const optionLeg = (group.legs || []).find((leg) => leg && String(leg.id || '') === optionLegId);
            if (!optionLeg) {
                return false;
            }

            const assignedOptionPosition = _toFiniteNumberOrNull(adjustment.assignedOptionPosition);
            const remainingOptionPosition = _toFiniteNumberOrNull(adjustment.remainingOptionPosition);
            // The deliverable underlying position (cost basis = strike) is what the assignment/exercise
            // produces; it is invariant. The close-order quantity can net to 0 when the deliverable
            // offsets an existing TWS position, so booking the conversion must not depend on it.
            // Fall back to the legacy underlyingQuantity field for older server payloads.
            const deliverableUnderlyingPosition = _toFiniteNumberOrNull(adjustment.deliverableUnderlyingPosition);
            const underlyingQuantity = Number.isFinite(deliverableUnderlyingPosition)
                ? deliverableUnderlyingPosition
                : _toFiniteNumberOrNull(adjustment.underlyingQuantity);
            if (!Number.isFinite(assignedOptionPosition)
                || Math.abs(assignedOptionPosition) < 0.0001
                || !Number.isFinite(underlyingQuantity)
                || Math.abs(underlyingQuantity) < 0.0001) {
                return false;
            }

            const adjustmentId = String(adjustment.adjustmentId || `${optionLegId}:${assignedOptionPosition}`).trim();
            const underlyingLegId = String(adjustment.underlyingLegId || '').trim()
                || _buildSyntheticAssignmentId('assigned_underlying', optionLegId);
            const isPartialAssignment = Number.isFinite(remainingOptionPosition)
                && Math.abs(remainingOptionPosition) > 0.0001;
            let changed = false;
            let assignmentSourceLeg = optionLeg;

            if (isPartialAssignment) {
                const currentPos = _toFiniteNumberOrNull(optionLeg.pos);
                if (!Number.isFinite(currentPos) || Math.abs(currentPos - remainingOptionPosition) > 0.0001) {
                    optionLeg.pos = remainingOptionPosition;
                    changed = true;
                }

                let assignedOptionLeg = (group.legs || []).find((leg) => (
                    leg
                    && leg.assignmentAdjustmentId === adjustmentId
                    && leg.assignmentSourceLegId === optionLegId
                ));
                if (!assignedOptionLeg) {
                    assignedOptionLeg = {
                        ...optionLeg,
                        id: _buildSyntheticAssignmentId('assigned_option', optionLegId),
                        pos: assignedOptionPosition,
                        closePrice: 0,
                        closePriceSource: 'assignment_conversion',
                        assignmentAdjustmentId: adjustmentId,
                        assignmentSourceLegId: optionLegId,
                        assignmentUnderlyingLegId: underlyingLegId,
                        assignmentUnderlyingQuantity: underlyingQuantity,
                        executionReportOrderId: null,
                        executionReportPermId: null,
                        closeExecutionOrderId: null,
                        closeExecutionPermId: null,
                    };
                    const optionIndex = (group.legs || []).indexOf(optionLeg);
                    group.legs.splice(optionIndex + 1, 0, assignedOptionLeg);
                    changed = true;
                }
                assignmentSourceLeg = assignedOptionLeg;
            } else {
                if (!_hasResolvedClosePrice(optionLeg) || optionLeg.closePriceSource !== 'assignment_conversion') {
                    optionLeg.closePrice = 0;
                    optionLeg.closePriceSource = 'assignment_conversion';
                    changed = true;
                }
                optionLeg.assignmentAdjustmentId = adjustmentId;
                optionLeg.assignmentUnderlyingLegId = underlyingLegId;
                optionLeg.assignmentUnderlyingQuantity = underlyingQuantity;
            }

            let underlyingLeg = (group.legs || []).find((leg) => leg && String(leg.id || '') === underlyingLegId);
            if (!underlyingLeg) {
                underlyingLeg = {
                    id: underlyingLegId,
                    type: 'stock',
                    pos: underlyingQuantity,
                    strike: 0,
                    expDate: '',
                    iv: 0,
                    ivSource: 'manual',
                    ivManualOverride: false,
                    currentPrice: 0,
                    currentPriceSource: '',
                    portfolioMarketPrice: null,
                    portfolioMarketPriceSource: '',
                    portfolioUnrealizedPnl: null,
                    cost: Math.abs(_toFiniteNumberOrNull(adjustment.assignmentStrike) || _toFiniteNumberOrNull(optionLeg.strike) || 0),
                    costSource: 'assignment_conversion',
                    closePrice: null,
                    closePriceSource: '',
                    underlyingFutureId: optionLeg.underlyingFutureId || '',
                    assignmentAdjustmentId: adjustmentId,
                    assignmentSourceLegId: assignmentSourceLeg.id,
                };
                group.legs.push(underlyingLeg);
                changed = true;
            }

            const avgFillPrice = _toFiniteNumberOrNull(adjustment.underlyingAvgFillPrice);
            if (Number.isFinite(avgFillPrice) && avgFillPrice > 0) {
                if (Math.abs((_toFiniteNumberOrNull(underlyingLeg.closePrice) || 0) - avgFillPrice) > 0.0001
                    || underlyingLeg.closePriceSource !== 'execution_report') {
                    underlyingLeg.closePrice = avgFillPrice;
                    underlyingLeg.closePriceSource = 'execution_report';
                    underlyingLeg.closeExecutionOrderId = adjustment.underlyingOrderId || null;
                    underlyingLeg.closeExecutionPermId = adjustment.underlyingPermId || null;
                    changed = true;
                }
            }

            return changed;
        }

        function _applyAssignmentAdjustments(group, adjustments) {
            if (!Array.isArray(adjustments) || adjustments.length === 0) {
                return false;
            }
            let changed = adjustments.reduce((didChange, adjustment) => (
                _applyAssignmentAdjustment(group, adjustment) || didChange
            ), false);
            changed = _maybePromoteEquivalentGroupToSettlement(group) || changed;
            return changed;
        }

        function _isStagedUnderlyingCloseUpdate(update, runtime) {
            const requestSource = String(update && update.requestSource || '').trim();
            if (requestSource !== 'close_group_underlying') {
                return false;
            }
            const currentPreview = runtime && runtime.lastPreview;
            if (!currentPreview || String(currentPreview.requestSource || '').trim() === 'close_group_underlying') {
                return false;
            }
            const currentHasBrokerRef = currentPreview.orderId != null || currentPreview.permId != null;
            const updateHasBrokerRef = update && (update.orderId != null || update.permId != null);
            if (!currentHasBrokerRef || !updateHasBrokerRef) {
                return false;
            }
            return !_isSameBrokerOrder(currentPreview, update);
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

        function _maybePromoteEquivalentGroupToSettlement(group) {
            if (!group || !group.equivalentCloseState || _groupHasOpenPositions(group)) {
                return false;
            }
            if (group.viewMode === 'settlement') {
                return false;
            }
            group.viewMode = 'settlement';
            return true;
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

        function _buildCloseGroupComboOrderPayload(group, closeExecution, executionMode = 'submit', options = {}) {
            if (!closeExecution) {
                return null;
            }

            const groupOrderBuilder = _getGroupOrderBuilderApi();
            if (!groupOrderBuilder || typeof groupOrderBuilder.buildGroupOrderRequestPayload !== 'function') {
                return null;
            }

            const requestOptions = options && typeof options === 'object' ? options : {};
            const hasExplicitLegIds = Object.prototype.hasOwnProperty.call(requestOptions, 'legIds');
            const legIds = hasExplicitLegIds
                ? _normalizeLegIds(requestOptions.legIds)
                : _normalizeLegIds(closeExecution.pendingCloseLegIds);
            const payload = groupOrderBuilder.buildGroupOrderRequestPayload(group, _getState(), {
                action: executionMode === 'preview' ? 'preview_combo_order' : 'submit_combo_order',
                executionMode,
                intent: 'close',
                source: 'close_group',
                managedRepriceThreshold: closeExecution.repriceThreshold,
                managedConcessionRatio: closeExecution.concessionRatio,
                timeInForce: closeExecution.timeInForce,
                closeStrategy: String(
                    requestOptions.closeStrategy
                    || closeExecution.pendingCloseStrategy
                    || closeExecution.strategy
                    || 'auto'
                ).trim().toLowerCase(),
                legIds,
                closeQuantity: requestOptions.closeQuantity,
            });

            if (legIds.length > 0) {
                payload.closeTargetLegIds = legIds;
                payload.closeTargetScope = 'leg';
            } else {
                payload.closeTargetScope = 'group';
            }

            return payload;
        }

        function _sendValidatedComboSubmit(group, executionMode, frozenPayload = null) {
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
            const payload = frozenPayload && typeof frozenPayload === 'object'
                ? _clonePayload(frozenPayload)
                : (tradeTriggerLogic
                    && typeof tradeTriggerLogic.buildComboOrderRequestPayload === 'function'
                    ? tradeTriggerLogic.buildComboOrderRequestPayload(group, _getState(), executionMode)
                    : null);

            if (!payload) {
                _markTradeTriggerError(group, 'Unable to build combo submit payload.');
                _renderGroups();
                return false;
            }

            payload.action = 'submit_combo_order';
            payload.executionMode = executionMode;

            const trigger = _getTradeTrigger(group);
            if (!trigger) {
                return false;
            }
            payload.executionPlanToken = String(trigger.executionPlanToken || '').trim();
            if (!payload.executionPlanToken) {
                _markTradeTriggerError(group, 'Execution authorization is missing or expired. Validate again.');
                _renderGroups();
                return false;
            }

            trigger.pendingRequest = true;
            trigger.lastError = '';
            trigger.status = executionMode === 'test_submit' ? 'pending_test_submit' : 'pending_submit';
            _sendPayload(payload);
            trigger.executionPlanToken = '';
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

        function _settleHistoricalReplayGroup(group, options = {}) {
            const closeExecution = _getCloseExecution(group);
            if (!closeExecution) {
                return false;
            }
            const legIds = _normalizeLegIds(options && options.legIds);
            const scopedClose = legIds.length > 0;

            if (!_hasOpenPositionsInScope(group, legIds)) {
                _markCloseExecutionError(group, scopedClose
                    ? 'This leg has no open position to close.'
                    : 'This group has no open position to close.');
                return false;
            }

            const hasLockedEntryCosts = scopedClose
                ? _hasCostForAllPositionedLegsInScope(group, legIds)
                : _groupHasCostForAllPositionedLegs(group);
            if (!hasLockedEntryCosts) {
                _markCloseExecutionError(group, scopedClose
                    ? 'Historical single-leg close needs a locked entry cost for that leg. Use Enter @ Replay Day or let base-day quotes seed the cost first.'
                    : 'Historical settlement needs a locked entry cost for every open leg. Use Enter @ Replay Day or let base-day quotes seed the costs first.');
                return false;
            }

            const missingLegs = [];
            const settledLegs = [];

            _getScopedLegs(group, legIds).forEach((leg) => {
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
            if (!scopedClose || !_groupHasOpenPositions(group)) {
                group.viewMode = 'settlement';
            }

            closeExecution.pendingRequest = false;
            _setCloseExecutionTarget(closeExecution, legIds);
            closeExecution.lastError = '';
            closeExecution.status = 'submitted';
            closeExecution.lastPreview = {
                ...(closeExecution.lastPreview || {}),
                executionMode: 'submit',
                executionIntent: 'close',
                requestSource: 'close_group',
                closeTargetScope: scopedClose ? 'leg' : 'group',
                closeTargetLegIds: scopedClose ? legIds : [],
                status: 'Filled',
                statusMessage: scopedClose
                    ? `Historical replay simulated single-leg close filled on ${_getHistoricalReplayDate() || 'the selected day'}.`
                    : `Historical replay simulated close filled on ${_getHistoricalReplayDate() || 'the selected day'}.`,
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

        function requestManualConcedeManagedComboOrder(group, concessionStep, runtimeKind = 'tradeTrigger') {
            if (!group || !_isWsConnected()) {
                return false;
            }

            const executionRuntime = _getExecutionRuntimeByKind(group, runtimeKind);
            const preview = executionRuntime && executionRuntime.lastPreview;
            if (!executionRuntime || !preview || !preview.orderId) {
                _markExecutionError(group, 'No live combo order is available for manual chase repricing.', runtimeKind);
                _renderGroups();
                return false;
            }

            if (executionRuntime.pendingRequest) {
                return false;
            }

            const parsedStep = Number(concessionStep);
            if (!Number.isFinite(parsedStep) || parsedStep <= 0 || parsedStep > 1000000) {
                _markExecutionError(group, 'Enter a positive manual chase price step.', runtimeKind);
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
                concessionMode: 'step',
                concessionStep: parsedStep,
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

        function _requestCloseComboOrder(group, options = {}) {
            if (!group) return false;
            const state = _getState();
            const legIds = _normalizeLegIds(options && options.legIds);
            const scopedClose = legIds.length > 0;
            const closeExecution = _getCloseExecution(group);
            if (!closeExecution || closeExecution.pendingRequest) {
                return false;
            }
            _setCloseExecutionTarget(closeExecution, legIds);
            if (_isHistoricalMode()) {
                const didSettle = _settleHistoricalReplayGroup(group, { legIds });
                if (!didSettle) {
                    _renderGroups();
                }
                return didSettle;
            }
            const groupOrderBuilder = _getGroupOrderBuilderApi();
            const maxCloseQuantity = !scopedClose && groupOrderBuilder
                && typeof groupOrderBuilder.resolveGroupCloseQuantity === 'function'
                ? groupOrderBuilder.resolveGroupCloseQuantity(group)
                : null;
            const requestedCloseQuantity = parseInt(
                options.closeQuantity != null ? options.closeQuantity : closeExecution.quantity,
                10
            );
            const closeQuantity = !scopedClose
                ? (Number.isInteger(requestedCloseQuantity) ? requestedCloseQuantity : maxCloseQuantity)
                : null;
            if (!scopedClose && (!Number.isInteger(closeQuantity) || closeQuantity < 1
                || !Number.isInteger(maxCloseQuantity) || closeQuantity > maxCloseQuantity)) {
                _markCloseExecutionError(group, `Close Qty must be between 1 and ${maxCloseQuantity || 0}.`);
                _renderGroups();
                return false;
            }
            if (!scopedClose && closeQuantity < maxCloseQuantity
                && String(options.closeStrategy || '').trim().toLowerCase() === 'equivalent_expiry') {
                _markCloseExecutionError(group, 'Expiry Equivalent is only available when closing the full group quantity.');
                _renderGroups();
                return false;
            }
            closeExecution.quantity = closeQuantity;
            closeExecution.pendingCloseQuantity = closeQuantity;
            closeExecution.pendingCloseMaxQuantity = maxCloseQuantity;
            const requestedStrategy = String(
                options.closeStrategy || closeExecution.strategy || 'auto'
            ).trim().toLowerCase();
            closeExecution.pendingCloseStrategy = !scopedClose
                && closeQuantity < maxCloseQuantity
                ? 'combo'
                : requestedStrategy;

            if (!_isWsConnected()) {
                _markCloseExecutionError(group, 'WebSocket is not connected.');
                _renderGroups();
                return false;
            }
            if (!_hasOpenPositionsInScope(group, legIds)) {
                _markCloseExecutionError(group, scopedClose
                    ? 'This leg has no open position to close.'
                    : 'This group has no open position to close.');
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

            const executionMode = closeExecution.executionMode === 'submit' || closeExecution.executionMode === 'test_submit'
                ? closeExecution.executionMode
                : 'preview';
            const requiresConfirmation = executionMode === 'submit' || executionMode === 'test_submit';

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

            const payload = _buildCloseGroupComboOrderPayload(
                group,
                closeExecution,
                requiresConfirmation ? 'preview' : executionMode,
                {
                legIds,
                closeStrategy: closeExecution.pendingCloseStrategy,
                closeQuantity,
                }
            );
            if (!payload) {
                _markCloseExecutionError(group, scopedClose
                    ? 'Unable to build single-leg close order payload.'
                    : 'Unable to build close-group combo order payload.');
                _renderGroups();
                return false;
            }
            if (!Array.isArray(payload.legs) || payload.legs.length === 0) {
                _markCloseExecutionError(group, scopedClose
                    ? 'This leg is already closed or has no non-zero position.'
                    : 'This group has no open position to close.');
                _renderGroups();
                return false;
            }

            closeExecution.pendingRequest = true;
            closeExecution.lastError = '';
            closeExecution.status = 'pending_preview';
            if (requiresConfirmation) {
                payload.action = 'preview_combo_order';
                payload.confirmationTargetMode = executionMode;
                closeExecution.pendingConfirmationMode = executionMode;
                closeExecution.pendingClosePlanPayload = _clonePayload(payload);
                closeExecution.confirmedClosePlanPayload = null;
            } else {
                closeExecution.pendingConfirmationMode = '';
                closeExecution.pendingClosePlanPayload = null;
                closeExecution.confirmedClosePlanPayload = null;
            }
            _sendPayload(payload);
            _renderGroups();
            return true;
        }

        function requestCloseGroupComboOrder(group) {
            const closeExecution = _getCloseExecution(group);
            return _requestCloseComboOrder(group, {
                legIds: [],
                closeStrategy: closeExecution && closeExecution.strategy || 'auto',
                closeQuantity: closeExecution && closeExecution.quantity,
            });
        }

        function requestEquivalentCloseGroupComboOrder(group) {
            return _requestCloseComboOrder(group, {
                legIds: [],
                closeStrategy: 'equivalent_expiry',
            });
        }

        function requestCloseLegComboOrder(group, leg) {
            const legId = String(leg && leg.id || '').trim();
            if (!group || !legId) {
                return false;
            }

            const belongsToGroup = (group.legs || []).some((entry) => String(entry && entry.id || '').trim() === legId);
            if (!belongsToGroup) {
                _markCloseExecutionError(group, 'Unable to find that leg in this group.');
                _renderGroups();
                return false;
            }

            return _requestCloseComboOrder(group, { legIds: [legId] });
        }

        function confirmClosePlan(group) {
            const closeExecution = _getCloseExecution(group);
            const preview = closeExecution && closeExecution.lastPreview;
            const targetMode = String(closeExecution && closeExecution.pendingConfirmationMode || '').trim();
            const basePayload = closeExecution && closeExecution.pendingClosePlanPayload;
            if (!closeExecution || !preview || !basePayload
                || !['submit', 'test_submit'].includes(targetMode)) {
                return false;
            }
            const token = String(preview.closePlanToken || '').trim();
            if (!token) {
                _clearClosePlanConfirmation(closeExecution, 'invalid');
                _markCloseExecutionError(group, 'Close Plan confirmation token is missing. Preview again.');
                _renderGroups();
                return false;
            }
            const expiresAt = Date.parse(String(preview.closePlanExpiresAt || ''));
            if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
                _clearClosePlanConfirmation(closeExecution, 'expired');
                _markCloseExecutionError(group, 'Close Plan expired. No TWS order was sent; preview again.');
                _renderGroups();
                return false;
            }

            const payload = _clonePayload(basePayload);
            payload.action = 'validate_combo_order';
            payload.executionMode = targetMode;
            payload.confirmationTargetMode = targetMode;
            payload.closePlanToken = token;
            closeExecution.confirmedClosePlanPayload = _clonePayload(payload);
            closeExecution.pendingRequest = true;
            closeExecution.lastError = '';
            closeExecution.status = 'pending_validation';
            _sendPayload(payload);
            _renderGroups();
            return true;
        }

        function cancelClosePlan(group) {
            const closeExecution = _getCloseExecution(group);
            if (!closeExecution) {
                return false;
            }
            _requestClosePlanRevocation(group, closeExecution, 'user_cancelled');
            _clearClosePlanConfirmation(closeExecution, 'cancelled');
            closeExecution.status = closeExecution.lastPreview ? 'plan_cancelled' : 'idle';
            closeExecution.lastError = '';
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
                trigger.pendingValidationPayload = _clonePayload(payload);
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
                const payload = _clonePayload(runtime.confirmedClosePlanPayload);
                if (!payload) {
                    _markCloseExecutionError(
                        group,
                        'Confirmed Close Plan payload is unavailable. No TWS order was sent; preview again.'
                    );
                    _renderGroups();
                    return true;
                }

                payload.action = 'submit_combo_order';
                payload.executionMode = nextMode;
                runtime.pendingRequest = true;
                runtime.lastError = '';
                runtime.status = 'pending_submit';
                _sendPayload(payload);
                _renderGroups();
                return true;
            }

            const ui = globalScope.OptionComboGroupEditorUI;
            const sharedConfirmation = globalScope.OptionComboOrderConfirmationUI;
            const showDialog = ui && typeof ui.openComboSubmissionConfirmationDialog === 'function'
                ? ui.openComboSubmissionConfirmationDialog
                : null;
            const pendingPayload = runtime.pendingValidationPayload;
            if (!pendingPayload) {
                _markTradeTriggerError(group, 'Validated order payload is unavailable. Preview again.', runtimeKind);
                _renderGroups();
                return true;
            }
            pendingPayload.executionPlanToken = String(validation.executionPlanToken || '').trim();
            if (!pendingPayload.executionPlanToken) {
                _markTradeTriggerError(group, 'Validated execution authorization is missing. Validate again.', runtimeKind);
                _renderGroups();
                return true;
            }
            runtime.executionPlanToken = pendingPayload.executionPlanToken;
            const checker = globalScope.OptionComboLegPositionCheck;
            const positionWarnings = checker && typeof checker.findOrderReductions === 'function'
                ? checker.findOrderReductions(
                    pendingPayload.legs,
                    state,
                    state.portfolioPositions || [],
                    state.selectedLiveComboOrderAccount,
                    state.groups || [],
                    group.id
                )
                : [];
            runtime.pendingRequest = true;
            runtime.status = 'awaiting_confirmation';
            const confirmationContext = {
                group,
                validation,
                payload: pendingPayload,
                targetMode: nextMode,
                positionWarnings,
                positionSnapshotAvailable: state.portfolioPositionsConnected === true,
                onConfirm: () => {
                    runtime.pendingRequest = false;
                    runtime.pendingValidationPayload = null;
                    return _sendValidatedComboSubmit(group, nextMode, pendingPayload);
                },
                onCancel: () => {
                    runtime.pendingRequest = false;
                    runtime.pendingValidationPayload = null;
                    runtime.status = 'cancelled';
                    runtime.lastError = '';
                    _renderGroups();
                },
            };
            let opened = false;
            if (sharedConfirmation && typeof sharedConfirmation.open === 'function') {
                opened = sharedConfirmation.open({
                    title: 'Confirm Combo Order',
                    expiresAt: Number(validation.executionPlanExpiresAtEpochMs) > 0
                        ? new Date(Number(validation.executionPlanExpiresAtEpochMs)).toLocaleTimeString()
                        : '',
                    intent: {
                        kind: 'combo',
                        source: pendingPayload.requestSource || 'combo_order',
                        ownerType: 'group',
                        ownerId: group.id,
                        account: pendingPayload.account,
                        orderType: 'MANAGED',
                        orderDescription: 'Managed · server dynamic pricing',
                        timeInForce: pendingPayload.timeInForce || 'DAY',
                        managedRepriceThreshold: pendingPayload.managedRepriceThreshold,
                        managedConcessionRatio: pendingPayload.managedConcessionRatio,
                        legs: pendingPayload.legs || [],
                    },
                    positionImpact: {
                        available: state.portfolioPositionsConnected === true,
                        warnings: positionWarnings,
                        blockingReason: 'The latest TWS position snapshot is unavailable.',
                    },
                    onConfirm: confirmationContext.onConfirm,
                    onCancel: confirmationContext.onCancel,
                });
            } else if (showDialog) {
                opened = showDialog(confirmationContext);
            }
            if (opened === false) {
                runtime.pendingRequest = false;
                runtime.pendingValidationPayload = null;
                _markTradeTriggerError(group, 'Order was validated, but the confirmation dialog could not be opened. No TWS order was sent.');
            }
            _renderGroups();
            return true;
        }

        function _applyComboOrderResult(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const payload = data.preview || data.order || {};
            const { runtime, runtimeKind } = _resolveExecutionRuntime(group, payload);
            if (!runtime) return true;
            const assignmentChanged = _applyAssignmentAdjustments(group, payload.assignmentAdjustments);
            if (_isStagedUnderlyingCloseUpdate(payload, runtime)) {
                runtime.pendingRequest = false;
                if (assignmentChanged) {
                    _renderGroups();
                    _updateDerivedValues();
                }
                return true;
            }

            const previousPreview = runtime.lastPreview && typeof runtime.lastPreview === 'object'
                ? runtime.lastPreview
                : {};
            runtime.pendingRequest = false;
            if (runtimeKind === 'tradeTrigger') {
                runtime.enabled = false;
            }
            runtime.lastPreview = payload || null;
            if (data.action === 'combo_order_submit_result'
                && runtime.lastPreview
                && !String(runtime.lastPreview.statusMessage || '').trim()
                && _isSameBrokerOrder(previousPreview, runtime.lastPreview)) {
                const previousStatusMessage = String(previousPreview.statusMessage || '').trim();
                if (previousStatusMessage) {
                    runtime.lastPreview.statusMessage = previousStatusMessage;
                }
            }
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

            if (data.action === 'combo_order_preview_result'
                && runtimeKind === 'closeExecution'
                && ['submit', 'test_submit'].includes(String(runtime.pendingConfirmationMode || '').trim())) {
                if (!String(runtime.lastPreview && runtime.lastPreview.closePlanToken || '').trim()) {
                    _markCloseExecutionError(
                        group,
                        'Backend did not return a confirmable Close Plan. No TWS order was sent.'
                    );
                } else {
                    runtime.pendingRequest = true;
                    runtime.status = 'awaiting_confirmation';
                    _showCloseConfirmationDialog(group, runtime, runtime.lastPreview);
                }
            }

            if (data.action === 'combo_order_submit_result'
                && String(runtime.lastPreview && runtime.lastPreview.status || '').trim() === 'Filled'
                && String(runtime.lastPreview && runtime.lastPreview.executionMode || '').trim() === 'submit') {
                if (runtimeKind !== 'closeExecution') {
                    _maybePromoteFilledTrialGroupToActive(group, runtime);
                }
            }
            if (data.action === 'combo_order_submit_result' && runtimeKind === 'closeExecution') {
                runtime.pendingConfirmationMode = '';
                runtime.pendingClosePlanPayload = null;
                runtime.confirmedClosePlanPayload = null;
            }

            _renderGroups();
            _updateDerivedValues();
            return true;
        }

        function _applyComboOrderStatusUpdate(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const previousViewMode = group.viewMode;
            const update = data.orderStatus || {};
            const { runtime, runtimeKind } = _resolveExecutionRuntime(group, update);
            if (!runtime) return true;
            const assignmentChanged = _applyAssignmentAdjustments(group, update.assignmentAdjustments);
            if (_isStagedUnderlyingCloseUpdate(update, runtime)) {
                if (assignmentChanged) {
                    _renderGroups();
                    _updateDerivedValues();
                }
                return true;
            }

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
                    managedManualConcessionCount,
                    managedManualConcessionStep,
                    managedManualConcessionOffset,
                    priceIncrement,
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

            // Managed supervision sends routine state snapshots every reprice
            // interval. Rebuilding all group cards here destroys an open
            // concession select or a manually entered chase step. A full render
            // remains necessary only when the update changed card structure or
            // the group's render mode.
            if (assignmentChanged || group.viewMode !== previousViewMode) {
                _renderGroups();
            }
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
                    const sourcePosition = parseFloat(fillLeg.sourcePosition);
                    const targetPosition = parseFloat(fillLeg.targetPosition);
                    const cumulativeFilled = Math.abs(parseFloat(fillLeg.filledQuantity) || 0);
                    const canApplyPartialPosition = Number.isFinite(sourcePosition)
                        && sourcePosition !== 0
                        && Number.isFinite(targetPosition)
                        && targetPosition !== 0;
                    if (canApplyPartialPosition) {
                        const appliedFilled = Math.min(cumulativeFilled, Math.abs(targetPosition));
                        const remainingAbs = Math.max(Math.abs(sourcePosition) - appliedFilled, 0);
                        const sourceRealizedPnl = parseFloat(fillLeg.sourceRealizedPnl) || 0;
                        const sourceCost = Math.abs(parseFloat(fillLeg.sourceCost));
                        const multiplier = Math.abs(parseFloat(fillLeg.multiplier)) || 1;
                        if (remainingAbs > 0.0001) {
                            leg.pos = Math.sign(sourcePosition) * remainingAbs;
                            leg.closePrice = null;
                            leg.closePriceSource = '';
                            leg.partialCloseRealizedPnl = Number.isFinite(sourceCost)
                                ? sourceRealizedPnl
                                    + (nextCost - sourceCost) * Math.sign(sourcePosition) * appliedFilled * multiplier
                                : sourceRealizedPnl;
                            leg.partialCloseLastPrice = nextCost;
                            leg.partialCloseLastQuantity = appliedFilled;
                        } else {
                            // Preserve the final batch position so the existing closed-leg
                            // valuation path books it at closePrice; earlier batches remain
                            // in partialCloseRealizedPnl.
                            leg.pos = sourcePosition;
                            leg.partialCloseRealizedPnl = sourceRealizedPnl;
                            leg.closePrice = nextCost;
                            leg.closePriceSource = 'execution_report';
                        }
                    } else {
                        leg.closePrice = nextCost;
                        leg.closePriceSource = 'execution_report';
                    }
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
            } else {
                _maybePromoteEquivalentGroupToSettlement(group);
            }

            _renderGroups();
            return true;
        }

        function _applyComboOrderError(data) {
            const group = _findGroupById(data.groupId);
            if (!group) return true;

            const { runtime, runtimeKind } = _resolveExecutionRuntime(group, data);
            if (runtimeKind === 'closeExecution' && runtime) {
                _requestClosePlanRevocation(group, runtime, 'request_failed');
                _clearClosePlanConfirmation(runtime, 'invalid');
            }
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
            if (data.action === 'combo_order_close_plan_cancel_result') {
                return true;
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
            requestEquivalentCloseGroupComboOrder,
            requestCloseLegComboOrder,
            confirmClosePlan,
            cancelClosePlan,
            requestContinueManagedComboOrder,
            requestConcedeManagedComboOrder,
            requestManualConcedeManagedComboOrder,
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
                requestCloseComboOrder: _requestCloseComboOrder,
                confirmClosePlan,
                cancelClosePlan,
            },
        };
    }

    globalScope.OptionComboComboOrderTransport = {
        createApi,
    };
})(typeof window !== 'undefined' ? window : globalThis);
