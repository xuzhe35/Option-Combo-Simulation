/**
 * Trial-mode trigger helpers and combo-order request builders.
 */

(function attachTradeTriggerLogic(globalScope) {
    const VALID_CONDITIONS = ['gte', 'lte'];
    const VALID_EXECUTION_MODES = ['preview', 'submit', 'test_submit'];
    const VALID_REPRICE_THRESHOLDS = [0.01, 0.02, 0.05];
    const VALID_TIME_IN_FORCE = ['DAY', 'GTC'];
    const VALID_STATUSES = [
        'idle',
        'armed',
        'pending_validation',
        'pending_preview',
        'pending_submit',
        'pending_test_submit',
        'pending_resume',
        'pending_concede',
        'previewed',
        'submitted',
        'test_submitted',
        'error',
    ];

    function createDefaultTradeTrigger() {
        return {
            enabled: false,
            condition: 'gte',
            price: null,
            executionMode: 'preview',
            repriceThreshold: 0.01,
            timeInForce: 'DAY',
            exitEnabled: false,
            exitCondition: 'lte',
            exitPrice: null,
            isExpanded: false,
            isCollapsed: false,
            status: 'idle',
            pendingRequest: false,
            lastTriggeredAt: null,
            lastTriggerPrice: null,
            lastPreview: null,
            lastError: '',
        };
    }

    function normalizeTradeTrigger(trigger) {
        const next = {
            ...createDefaultTradeTrigger(),
            ...(trigger && typeof trigger === 'object' ? trigger : {}),
        };

        next.enabled = next.enabled === true;
        next.pendingRequest = next.pendingRequest === true;
        next.isExpanded = next.isExpanded === true;
        next.isCollapsed = next.isCollapsed === true;

        if (!VALID_CONDITIONS.includes(next.condition)) {
            next.condition = 'gte';
        }

        if (!VALID_EXECUTION_MODES.includes(next.executionMode)) {
            next.executionMode = 'preview';
        }

        const parsedThreshold = parseFloat(next.repriceThreshold);
        next.repriceThreshold = VALID_REPRICE_THRESHOLDS.some(value => Math.abs(value - parsedThreshold) < 0.0001)
            ? parsedThreshold
            : 0.01;

        const normalizedTif = String(next.timeInForce || '').trim().toUpperCase();
        next.timeInForce = VALID_TIME_IN_FORCE.includes(normalizedTif) ? normalizedTif : 'DAY';

        next.exitEnabled = next.exitEnabled === true;
        if (!VALID_CONDITIONS.includes(next.exitCondition)) {
            next.exitCondition = 'lte';
        }
        const parsedExitPrice = parseFloat(next.exitPrice);
        next.exitPrice = Number.isFinite(parsedExitPrice) ? parsedExitPrice : null;

        const parsedPrice = parseFloat(next.price);
        next.price = Number.isFinite(parsedPrice) ? parsedPrice : null;

        if (!VALID_STATUSES.includes(next.status)) {
            next.status = next.enabled ? 'armed' : 'idle';
        }

        if (!next.enabled && next.status === 'armed') {
            next.status = 'idle';
        }

        return next;
    }

    function ensureGroupTradeTrigger(group) {
        if (!group || typeof group !== 'object') {
            return createDefaultTradeTrigger();
        }

        group.tradeTrigger = normalizeTradeTrigger(group.tradeTrigger);
        return group.tradeTrigger;
    }

    function getRenderableGroupViewMode(group) {
        if (typeof OptionComboSessionLogic !== 'undefined'
            && typeof OptionComboSessionLogic.getRenderableGroupViewMode === 'function') {
            return OptionComboSessionLogic.getRenderableGroupViewMode(group);
        }

        return (group && group.viewMode) || 'active';
    }

    function isTradeTriggerEligible(group, renderMode) {
        const trigger = normalizeTradeTrigger(group && group.tradeTrigger);
        const resolvedMode = renderMode || getRenderableGroupViewMode(group);

        return resolvedMode === 'trial'
            && !!group
            && group.liveData === true
            && trigger.enabled
            && trigger.price !== null;
    }

    function shouldFireTradeTrigger(group, underlyingPrice, renderMode) {
        const trigger = normalizeTradeTrigger(group && group.tradeTrigger);
        if (!isTradeTriggerEligible(group, renderMode)) {
            return false;
        }

        if (!Number.isFinite(underlyingPrice)) {
            return false;
        }

        if (trigger.pendingRequest) {
            return false;
        }

        if (trigger.status === 'pending_preview'
            || trigger.status === 'pending_validation'
            || trigger.status === 'pending_submit'
            || trigger.status === 'pending_test_submit'
            || trigger.status === 'previewed'
            || trigger.status === 'submitted'
            || trigger.status === 'test_submitted') {
            return false;
        }

        return trigger.condition === 'lte'
            ? underlyingPrice <= trigger.price
            : underlyingPrice >= trigger.price;
    }

    function shouldCancelTriggeredOrder(group, underlyingPrice) {
        const trigger = normalizeTradeTrigger(group && group.tradeTrigger);
        if (!trigger.exitEnabled || trigger.exitPrice === null) {
            return false;
        }
        if (!Number.isFinite(underlyingPrice)) {
            return false;
        }
        if (trigger.pendingRequest) {
            return false;
        }

        const preview = trigger.lastPreview;
        if (!preview || !preview.orderId) {
            return false;
        }

        const brokerStatus = String(preview.status || '').trim();
        if (['Filled', 'Cancelled', 'ApiCancelled', 'Inactive'].includes(brokerStatus)) {
            return false;
        }

        const executionMode = String(preview.executionMode || '').trim();
        if (executionMode !== 'submit' && executionMode !== 'test_submit') {
            return false;
        }

        return trigger.exitCondition === 'lte'
            ? underlyingPrice <= trigger.exitPrice
            : underlyingPrice >= trigger.exitPrice;
    }

    function buildComboOrderLegRequests(group, globalState) {
        if (typeof OptionComboGroupOrderBuilder !== 'undefined'
            && typeof OptionComboGroupOrderBuilder.buildGroupOrderLegRequests === 'function') {
            return OptionComboGroupOrderBuilder.buildGroupOrderLegRequests(group, globalState, { intent: 'open' });
        }

        return [];
    }

    function buildComboOrderRequestPayload(group, globalState, executionModeOverride) {
        const trigger = normalizeTradeTrigger(group && group.tradeTrigger);
        const executionMode = executionModeOverride || trigger.executionMode || 'preview';
        if (typeof OptionComboGroupOrderBuilder !== 'undefined'
            && typeof OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload === 'function') {
            return OptionComboGroupOrderBuilder.buildGroupOrderRequestPayload(group, globalState, {
                action: executionMode === 'preview' ? 'preview_combo_order' : 'submit_combo_order',
                executionMode,
                intent: 'open',
                source: 'trial_trigger',
                managedRepriceThreshold: trigger.repriceThreshold,
                managedConcessionRatio: trigger.concessionRatio,
                timeInForce: trigger.timeInForce,
            });
        }

        return null;
    }

    globalScope.OptionComboTradeTriggerLogic = {
        createDefaultTradeTrigger,
        normalizeTradeTrigger,
        ensureGroupTradeTrigger,
        getRenderableGroupViewMode,
        isTradeTriggerEligible,
        shouldFireTradeTrigger,
        shouldCancelTriggeredOrder,
        buildComboOrderLegRequests,
        buildComboOrderRequestPayload,
        VALID_REPRICE_THRESHOLDS,
        VALID_TIME_IN_FORCE,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
