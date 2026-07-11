/**
 * Pure Delta hedge recommendation helpers.
 *
 * This module intentionally does not touch DOM, websocket transport, or broker
 * order state. It only turns a Delta summary plus user config into a manual
 * hedge recommendation.
 */

(function attachDeltaHedgeLogic(globalScope) {
    const SUPPORTED_SEC_TYPES = ['STK', 'FUT'];
    const VALID_ORDER_TYPES = ['LMT', 'MKT'];
    const ACTIVE_HEDGE_ORDER_STATES = ['placing', 'resting_locked', 'stale_needs_review'];
    const TERMINAL_BROKER_STATUSES = ['filled', 'cancelled', 'canceled', 'rejected', 'inactive', 'api_cancelled'];

    function parseFiniteNumber(value, fallback) {
        if (value === null || value === undefined || value === '') {
            return fallback;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function parsePositiveNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function parseNonNegativeNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    }

    function parsePositiveInteger(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    }

    function parseQuotePrice(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function normalizeUpper(value, fallback) {
        const normalized = String(value || '').trim().toUpperCase();
        return normalized || fallback || '';
    }

    function countTickDecimals(tickSize) {
        const text = String(tickSize || '');
        if (!text || text.indexOf('e-') >= 0) {
            const parsed = Number(tickSize);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return 2;
            }
            const parts = parsed.toExponential().split('e-');
            return parts.length === 2 ? Math.min(Math.max(parseInt(parts[1], 10), 0), 8) : 2;
        }
        const decimalIndex = text.indexOf('.');
        return decimalIndex >= 0 ? Math.min(text.length - decimalIndex - 1, 8) : 0;
    }

    function createDefaultDeltaHedgeConfig() {
        return {
            enabled: false,
            targetDelta: 0,
            tolerance: 50,
            proactiveBuffer: 0,
            hedgeInstrument: {
                secType: 'STK',
                symbol: '',
                exchange: 'SMART',
                currency: 'USD',
                contractMonth: '',
                multiplier: 1,
                deltaPerUnit: 1,
                conversionRatio: 1,
            },
            orderType: 'LMT',
            limitPrice: null,
            limitOffset: 0,
            maxOrderQuantity: null,
            autoMaxNotional: null,
            cooldownSeconds: 60,
            limitPriceManualOverride: false,
            limitPriceSource: '',
            limitPriceReferencePrice: null,
            limitPriceTickSize: null,
            limitPriceOffsetRate: 0.001,
            autoSubmitEnabled: false,
            autoCancelStaleOrders: true,
            autoMaxOrdersPerDay: 3,
            autoPreviewMaxAgeSeconds: 30,
            lastAutoOrderAt: '',
            lastOrderEventAt: '',
            autoOrderCountDate: '',
            autoOrderCount: 0,
            autoStatus: '',
            autoLastDecision: null,
        };
    }

    function normalizeHedgeInstrument(instrument) {
        const raw = instrument && typeof instrument === 'object' ? instrument : {};
        const secType = normalizeUpper(raw.secType || raw.sec_type, 'STK');
        return {
            secType: SUPPORTED_SEC_TYPES.includes(secType) ? secType : '',
            symbol: normalizeUpper(raw.symbol, ''),
            exchange: String(raw.exchange || 'SMART').trim().toUpperCase() || 'SMART',
            currency: normalizeUpper(raw.currency, 'USD'),
            contractMonth: String(raw.contractMonth || raw.contract_month || '').trim(),
            multiplier: parsePositiveNumber(raw.multiplier, 1),
            deltaPerUnit: parsePositiveNumber(raw.deltaPerUnit || raw.delta_per_unit, 1),
            conversionRatio: parsePositiveNumber(raw.conversionRatio || raw.conversion_ratio, 1),
        };
    }

    function normalizeDeltaHedgeConfig(config) {
        const defaults = createDefaultDeltaHedgeConfig();
        const raw = config && typeof config === 'object' ? config : {};
        const orderType = normalizeUpper(raw.orderType || raw.order_type, defaults.orderType);

        return {
            ...defaults,
            ...raw,
            enabled: raw.enabled === true,
            targetDelta: parseFiniteNumber(raw.targetDelta || raw.target_delta, defaults.targetDelta),
            tolerance: parseNonNegativeNumber(raw.tolerance, defaults.tolerance),
            proactiveBuffer: Math.max(0, parseFiniteNumber(
                raw.proactiveBuffer || raw.proactive_buffer,
                defaults.proactiveBuffer
            )),
            hedgeInstrument: normalizeHedgeInstrument(raw.hedgeInstrument || raw.hedge_instrument),
            orderType: VALID_ORDER_TYPES.includes(orderType) ? orderType : defaults.orderType,
            limitPrice: parseFiniteNumber(raw.limitPrice || raw.limit_price, defaults.limitPrice),
            limitOffset: parseFiniteNumber(raw.limitOffset || raw.limit_offset, defaults.limitOffset),
            maxOrderQuantity: parsePositiveInteger(raw.maxOrderQuantity || raw.max_order_quantity, defaults.maxOrderQuantity),
            autoMaxNotional: parsePositiveNumber(raw.autoMaxNotional || raw.auto_max_notional, defaults.autoMaxNotional),
            cooldownSeconds: parsePositiveInteger(raw.cooldownSeconds || raw.cooldown_seconds, defaults.cooldownSeconds),
            limitPriceManualOverride: raw.limitPriceManualOverride === true || raw.limit_price_manual_override === true,
            limitPriceSource: String(raw.limitPriceSource || raw.limit_price_source || '').trim(),
            limitPriceReferencePrice: parseFiniteNumber(
                raw.limitPriceReferencePrice || raw.limit_price_reference_price,
                defaults.limitPriceReferencePrice
            ),
            limitPriceTickSize: parsePositiveNumber(
                raw.limitPriceTickSize || raw.limit_price_tick_size,
                defaults.limitPriceTickSize
            ),
            limitPriceOffsetRate: parsePositiveNumber(
                raw.limitPriceOffsetRate || raw.limit_price_offset_rate,
                defaults.limitPriceOffsetRate
            ),
            autoSubmitEnabled: raw.autoSubmitEnabled === true || raw.auto_submit_enabled === true,
            autoCancelStaleOrders: raw.autoCancelStaleOrders !== false && raw.auto_cancel_stale_orders !== false,
            autoMaxOrdersPerDay: parsePositiveInteger(
                raw.autoMaxOrdersPerDay || raw.auto_max_orders_per_day,
                defaults.autoMaxOrdersPerDay
            ),
            autoPreviewMaxAgeSeconds: parsePositiveInteger(
                raw.autoPreviewMaxAgeSeconds || raw.auto_preview_max_age_seconds,
                defaults.autoPreviewMaxAgeSeconds
            ),
            lastAutoOrderAt: String(raw.lastAutoOrderAt || raw.last_auto_order_at || '').trim(),
            lastOrderEventAt: String(raw.lastOrderEventAt || raw.last_order_event_at || '').trim(),
            autoOrderCountDate: String(raw.autoOrderCountDate || raw.auto_order_count_date || '').trim(),
            autoOrderCount: Math.max(0, Math.floor(parseFiniteNumber(
                raw.autoOrderCount ?? raw.auto_order_count,
                defaults.autoOrderCount
            ))),
            autoStatus: String(raw.autoStatus || raw.auto_status || '').trim(),
            autoLastDecision: raw.autoLastDecision && typeof raw.autoLastDecision === 'object'
                ? raw.autoLastDecision
                : null,
        };
    }

    function buildBlockedRecommendation(reason, details) {
        return {
            actionable: false,
            reason,
            side: '',
            quantity: 0,
            projectedNetDelta: null,
            currentNetDelta: null,
            targetDelta: null,
            targetLower: null,
            targetUpper: null,
            hedgeDeltaPerUnit: null,
            ...(details || {}),
        };
    }

    function extractNetDelta(summary, directValue) {
        if (directValue !== null && directValue !== undefined && directValue !== ''
            && Number.isFinite(Number(directValue))) {
            return Number(directValue);
        }
        if (summary
            && summary.portfolioNetDelta !== null
            && summary.portfolioNetDelta !== undefined
            && summary.portfolioNetDelta !== ''
            && Number.isFinite(Number(summary.portfolioNetDelta))) {
            return Number(summary.portfolioNetDelta);
        }
        return null;
    }

    function isPortfolioDeltaAvailable(summary, currentNetDelta) {
        if (!Number.isFinite(currentNetDelta)) {
            return false;
        }
        if (!summary || typeof summary !== 'object') {
            return true;
        }
        if (summary.portfolioDeltaAvailable === false || summary.portfolioDeltaDisplayable === false) {
            return false;
        }
        if (Number(summary.portfolioDeltaMissingGroupCount || 0) > 0) {
            return false;
        }
        return true;
    }

    function roundHedgeQuantity(rawQuantity) {
        return Math.max(Math.round(Math.abs(rawQuantity)), 0);
    }

    function selectHedgeReferencePrice(quote) {
        const rawQuote = quote && typeof quote === 'object' ? quote : {};
        const bid = parseQuotePrice(rawQuote.bid);
        const ask = parseQuotePrice(rawQuote.ask);
        if (bid !== null && ask !== null && ask >= bid) {
            return {
                price: (bid + ask) / 2,
                source: 'midpoint',
            };
        }

        const fallbackFields = ['mark', 'last', 'price', 'close'];
        for (const field of fallbackFields) {
            const price = parseQuotePrice(rawQuote[field]);
            if (price !== null) {
                return {
                    price,
                    source: field,
                };
            }
        }

        return null;
    }

    function roundPriceToTick(value, tickSize, direction) {
        const parsedValue = Number(value);
        const parsedTick = Number(tickSize);
        if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
            return null;
        }

        const normalizedTick = Number.isFinite(parsedTick) && parsedTick > 0 ? parsedTick : 0.01;
        const units = parsedValue / normalizedTick;
        const epsilon = 1e-9;
        let roundedUnits;
        if (direction === 'down') {
            roundedUnits = Math.floor(units + epsilon);
        } else if (direction === 'up') {
            roundedUnits = Math.ceil(units - epsilon);
        } else {
            roundedUnits = Math.round(units);
        }

        const decimals = countTickDecimals(normalizedTick);
        const rounded = roundedUnits * normalizedTick;
        return Number(rounded.toFixed(Math.max(decimals, 0)));
    }

    function calculateDefaultHedgeLimitPrice(options) {
        const input = options && typeof options === 'object' ? options : {};
        const side = normalizeUpper(input.side, '');
        if (side !== 'BUY' && side !== 'SELL') {
            return null;
        }

        const reference = Number.isFinite(Number(input.referencePrice)) && Number(input.referencePrice) > 0
            ? { price: Number(input.referencePrice), source: 'reference' }
            : selectHedgeReferencePrice(input.quote);
        if (!reference || !Number.isFinite(reference.price) || reference.price <= 0) {
            return null;
        }

        const offsetRate = parsePositiveNumber(input.offsetRate, 0.001);
        const tickSize = parsePositiveNumber(input.tickSize, 0.01);
        const rawLimitPrice = side === 'BUY'
            ? reference.price * (1 - offsetRate)
            : reference.price * (1 + offsetRate);
        const limitPrice = roundPriceToTick(
            rawLimitPrice,
            tickSize,
            side === 'BUY' ? 'down' : 'up'
        );
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
            return null;
        }

        return {
            limitPrice,
            referencePrice: reference.price,
            source: reference.source,
            offsetRate,
            tickSize,
            rawLimitPrice,
        };
    }

    function normalizeOrderState(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'cancelled') {
            return 'canceled';
        }
        return normalized || 'idle';
    }

    function normalizeBrokerStatus(value) {
        return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    }

    function isTerminalBrokerStatus(status) {
        return TERMINAL_BROKER_STATUSES.includes(normalizeBrokerStatus(status));
    }

    function hasActiveRestingHedgeOrder(deltaHedge) {
        const raw = deltaHedge && typeof deltaHedge === 'object' ? deltaHedge : {};
        const orderState = normalizeOrderState(raw.orderState || raw.status);
        const order = raw.restingOrder && typeof raw.restingOrder === 'object'
            ? raw.restingOrder
            : null;
        if (order && isTerminalBrokerStatus(order.status || raw.status)) {
            return false;
        }
        if (orderState === 'placing') {
            return true;
        }
        if (!order) {
            return false;
        }
        if (ACTIVE_HEDGE_ORDER_STATES.includes(orderState)) {
            return Boolean(order.orderId || order.permId || order.clientOrderId);
        }
        return Boolean(order.orderId || order.permId || order.clientOrderId);
    }

    function getRestingOrderRemainingQuantity(order) {
        const remaining = Number(order && order.remainingQuantity);
        if (Number.isFinite(remaining) && remaining >= 0) {
            return remaining;
        }
        const quantity = Number(order && order.quantity);
        const filledQuantity = Number(order && order.filledQuantity);
        if (Number.isFinite(quantity) && quantity >= 0) {
            return Number.isFinite(filledQuantity) && filledQuantity > 0
                ? Math.max(quantity - filledQuantity, 0)
                : quantity;
        }
        return null;
    }

    function buildRestingOrderApplicabilityResult(orderState, reason, details) {
        const stale = orderState === 'stale_needs_review';
        return {
            orderState,
            stale,
            reason: reason || '',
            ...(details || {}),
        };
    }

    function evaluateRestingHedgeOrderApplicability(options) {
        const input = options && typeof options === 'object' ? options : {};
        const restingOrder = input.restingOrder && typeof input.restingOrder === 'object'
            ? input.restingOrder
            : {};
        const recommendation = input.recommendation && typeof input.recommendation === 'object'
            ? input.recommendation
            : null;
        const quantityTolerance = Math.max(0, Number.isFinite(Number(input.quantityTolerance))
            ? Number(input.quantityTolerance)
            : 0);

        if (!restingOrder || Object.keys(restingOrder).length === 0) {
            return buildRestingOrderApplicabilityResult('idle', 'no_resting_order');
        }
        if (isTerminalBrokerStatus(restingOrder.status)) {
            return buildRestingOrderApplicabilityResult(normalizeBrokerStatus(restingOrder.status), 'terminal_status');
        }
        if (!recommendation) {
            return buildRestingOrderApplicabilityResult('stale_needs_review', 'recommendation_unavailable');
        }
        if (recommendation.reason === 'delta_unavailable') {
            return buildRestingOrderApplicabilityResult('stale_needs_review', 'delta_unavailable');
        }
        if (recommendation.reason === 'inside_tolerance') {
            return buildRestingOrderApplicabilityResult('stale_needs_review', 'delta_inside_tolerance');
        }
        if (recommendation.reason === 'projected_outside_tolerance') {
            return buildRestingOrderApplicabilityResult('stale_needs_review', 'projected_outside_tolerance');
        }
        if (recommendation.actionable !== true) {
            return buildRestingOrderApplicabilityResult(
                'stale_needs_review',
                recommendation.reason || 'recommendation_not_actionable'
            );
        }

        const restingSide = normalizeUpper(restingOrder.side || restingOrder.orderAction, '');
        const recommendedSide = normalizeUpper(recommendation.side, '');
        if (restingSide && recommendedSide && restingSide !== recommendedSide) {
            return buildRestingOrderApplicabilityResult('stale_needs_review', 'opposite_side_required', {
                restingSide,
                recommendedSide,
            });
        }

        const remainingQuantity = getRestingOrderRemainingQuantity(restingOrder);
        const recommendedQuantity = Number(recommendation.quantity);
        if (Number.isFinite(remainingQuantity)
            && Number.isFinite(recommendedQuantity)
            && Math.abs(remainingQuantity - recommendedQuantity) > quantityTolerance) {
            return buildRestingOrderApplicabilityResult('stale_needs_review', 'quantity_changed', {
                remainingQuantity,
                recommendedQuantity,
            });
        }

        const projected = Number(recommendation.projectedNetDelta);
        const targetLower = Number(recommendation.targetLower);
        const targetUpper = Number(recommendation.targetUpper);
        if (Number.isFinite(projected)
            && Number.isFinite(targetLower)
            && Number.isFinite(targetUpper)
            && (projected < targetLower || projected > targetUpper)) {
            return buildRestingOrderApplicabilityResult('stale_needs_review', 'projected_outside_tolerance', {
                projectedNetDelta: projected,
                targetLower,
                targetUpper,
            });
        }

        return buildRestingOrderApplicabilityResult('resting_locked', '', {
            remainingQuantity,
            recommendedQuantity: Number.isFinite(recommendedQuantity) ? recommendedQuantity : null,
        });
    }

    function evaluateDeltaHedgeRecommendation(options) {
        const input = options && typeof options === 'object' ? options : {};
        const config = normalizeDeltaHedgeConfig(input.config || input.deltaHedge);
        const summary = input.portfolioDeltaSummary || input.deltaSummary || {};
        const currentNetDelta = extractNetDelta(summary, input.currentNetDelta);
        const targetDelta = config.targetDelta;
        const targetLower = targetDelta - config.tolerance;
        const targetUpper = targetDelta + config.tolerance;
        const proactiveBuffer = Math.min(config.proactiveBuffer, config.tolerance);
        const triggerLower = targetLower + proactiveBuffer;
        const triggerUpper = targetUpper - proactiveBuffer;
        const instrument = config.hedgeInstrument;
        const hedgeDeltaPerUnit = instrument.multiplier * instrument.deltaPerUnit * instrument.conversionRatio;
        const baseDetails = {
            currentNetDelta,
            targetDelta,
            targetLower,
            targetUpper,
            triggerLower,
            triggerUpper,
            proactiveBuffer,
            hedgeDeltaPerUnit,
            orderType: config.orderType,
            hedgeInstrument: instrument,
        };

        if (!config.enabled) {
            return buildBlockedRecommendation('disabled', baseDetails);
        }
        if (input.greeksEnabled === false) {
            return buildBlockedRecommendation('greeks_disabled', baseDetails);
        }
        if (input.liveMode === false || input.isHistoricalMode === true) {
            return buildBlockedRecommendation('not_live_mode', baseDetails);
        }
        if (!isPortfolioDeltaAvailable(summary, currentNetDelta)) {
            return buildBlockedRecommendation('delta_unavailable', baseDetails);
        }
        if (!instrument.secType || !instrument.symbol) {
            return buildBlockedRecommendation('missing_hedge_instrument', baseDetails);
        }
        if (!Number.isFinite(hedgeDeltaPerUnit) || hedgeDeltaPerUnit <= 0) {
            return buildBlockedRecommendation('invalid_hedge_delta_unit', baseDetails);
        }
        if (input.pendingHedgeOrder === true) {
            return buildBlockedRecommendation('pending_hedge_order', baseDetails);
        }

        if (currentNetDelta >= triggerLower && currentNetDelta <= triggerUpper) {
            return buildBlockedRecommendation('inside_tolerance', baseDetails);
        }

        const deltaToHedge = targetDelta - currentNetDelta;
        const rawHedgeQuantity = deltaToHedge / hedgeDeltaPerUnit;
        const quantity = roundHedgeQuantity(rawHedgeQuantity);
        const side = rawHedgeQuantity > 0 ? 'BUY' : 'SELL';
        const signedQuantity = side === 'BUY' ? quantity : -quantity;
        const projectedNetDelta = currentNetDelta + signedQuantity * hedgeDeltaPerUnit;
        const recommendationDetails = {
            ...baseDetails,
            side,
            quantity,
            rawHedgeQuantity,
            projectedNetDelta,
        };

        if (quantity <= 0) {
            return buildBlockedRecommendation('quantity_rounds_to_zero', recommendationDetails);
        }
        if (config.maxOrderQuantity !== null && quantity > config.maxOrderQuantity) {
            return buildBlockedRecommendation('exceeds_max_order_quantity', recommendationDetails);
        }
        if (projectedNetDelta < targetLower || projectedNetDelta > targetUpper) {
            return buildBlockedRecommendation('projected_outside_tolerance', recommendationDetails);
        }

        return {
            actionable: true,
            reason: '',
            ...recommendationDetails,
        };
    }

    function parseTimestampMs(value) {
        if (value instanceof Date) {
            const ms = value.getTime();
            return Number.isFinite(ms) ? ms : null;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        const text = String(value || '').trim();
        if (!text) {
            return null;
        }
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function buildDateKey(value) {
        const ms = parseTimestampMs(value);
        const date = ms !== null ? new Date(ms) : new Date();
        if (!Number.isFinite(date.getTime())) {
            return '';
        }
        return date.toISOString().slice(0, 10);
    }

    function normalizeExecutionNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Number(parsed.toFixed(8)) : null;
    }

    function buildHedgeRecommendationExecutionKey(recommendation, config) {
        const rec = recommendation && typeof recommendation === 'object' ? recommendation : {};
        const instrument = rec.hedgeInstrument || (config && config.hedgeInstrument) || {};
        const orderType = normalizeUpper(rec.orderType || (config && config.orderType), 'LMT');
        const limitPrice = normalizeExecutionNumber(
            rec.limitPrice ?? (config && config.limitPrice)
        );
        return [
            normalizeUpper(instrument.secType, ''),
            normalizeUpper(instrument.symbol, ''),
            String(instrument.contractMonth || '').trim(),
            normalizeUpper(rec.side, ''),
            normalizeExecutionNumber(rec.quantity),
            orderType,
            orderType === 'LMT' ? limitPrice : '',
        ].join('|');
    }

    function previewMatchesRecommendation(preview, recommendation, config) {
        const rawPreview = preview && typeof preview === 'object' ? preview : null;
        const rec = recommendation && typeof recommendation === 'object' ? recommendation : null;
        if (!rawPreview || !rec) {
            return false;
        }
        const instrument = rec.hedgeInstrument || (config && config.hedgeInstrument) || {};
        const orderType = normalizeUpper(rec.orderType || (config && config.orderType), 'LMT');
        const previewOrderType = normalizeUpper(rawPreview.orderType, '');
        const previewAction = normalizeUpper(rawPreview.orderAction || rawPreview.side, '');
        const previewSymbol = normalizeUpper(rawPreview.symbol || rawPreview.localSymbol, '');
        const recSymbol = normalizeUpper(instrument.symbol, '');
        if (previewAction !== normalizeUpper(rec.side, '')) {
            return false;
        }
        if (normalizeExecutionNumber(rawPreview.quantity) !== normalizeExecutionNumber(rec.quantity)) {
            return false;
        }
        if (previewOrderType !== orderType) {
            return false;
        }
        if (recSymbol && previewSymbol && previewSymbol !== recSymbol) {
            return false;
        }
        if (orderType === 'LMT') {
            const recLimit = normalizeExecutionNumber(rec.limitPrice ?? (config && config.limitPrice));
            const previewLimit = normalizeExecutionNumber(rawPreview.limitPrice);
            if (recLimit === null || previewLimit === null || recLimit !== previewLimit) {
                return false;
            }
        }
        return true;
    }

    function buildAutomationDecision(action, reason, details) {
        return {
            action,
            reason: reason || '',
            ...(details || {}),
        };
    }

    function evaluateDeltaHedgeAutomation(options) {
        const input = options && typeof options === 'object' ? options : {};
        const rawConfig = input.deltaHedge || input.config || {};
        const config = normalizeDeltaHedgeConfig(rawConfig);
        const recommendation = input.recommendation && typeof input.recommendation === 'object'
            ? input.recommendation
            : null;
        const nowMs = parseTimestampMs(input.now) ?? Date.now();
        const dateKey = input.dateKey || buildDateKey(nowMs);
        const orderCount = String(rawConfig.autoOrderCountDate || '') === dateKey
            ? Math.max(0, Math.floor(Number(rawConfig.autoOrderCount) || 0))
            : 0;
        const maxOrdersPerDay = config.autoMaxOrdersPerDay;
        const executionKey = buildHedgeRecommendationExecutionKey(recommendation, config);
        const baseDetails = {
            executionKey,
            dateKey,
            orderCount,
            maxOrdersPerDay,
        };

        if (config.autoSubmitEnabled !== true) {
            return buildAutomationDecision('blocked', 'auto_disabled', baseDetails);
        }
        if (config.enabled !== true) {
            return buildAutomationDecision('blocked', 'ddh_disabled', baseDetails);
        }
        if (input.liveMode === false || input.isHistoricalMode === true) {
            return buildAutomationDecision('blocked', 'not_live_mode', baseDetails);
        }
        if (input.greeksEnabled === false) {
            return buildAutomationDecision('blocked', 'greeks_disabled', baseDetails);
        }
        if (input.allowLiveHedgeOrders !== true) {
            return buildAutomationDecision('blocked', 'live_hedge_gate_off', baseDetails);
        }
        if (!String(input.selectedAccount || input.account || '').trim()) {
            return buildAutomationDecision('blocked', 'missing_account', baseDetails);
        }
        if (input.pendingRequest === true || rawConfig.pendingRequest === true) {
            return buildAutomationDecision('blocked', 'pending_request', baseDetails);
        }
        const activeRestingOrder = input.hasActiveRestingOrder === true || hasActiveRestingHedgeOrder(rawConfig);
        const currentOrderState = normalizeOrderState(rawConfig.orderState || rawConfig.status);
        if (activeRestingOrder && currentOrderState === 'stale_needs_review' && config.autoCancelStaleOrders === true) {
            return buildAutomationDecision('cancel_stale_order', 'stale_resting_order', baseDetails);
        }
        if (activeRestingOrder) {
            return buildAutomationDecision('blocked', 'active_resting_order', baseDetails);
        }
        if (!recommendation || recommendation.actionable !== true) {
            return buildAutomationDecision(
                'blocked',
                recommendation && recommendation.reason ? recommendation.reason : 'no_actionable_recommendation',
                baseDetails
            );
        }

        const orderType = normalizeUpper(recommendation.orderType || config.orderType, 'LMT');
        if (orderType !== 'LMT') {
            return buildAutomationDecision('blocked', 'auto_requires_lmt', baseDetails);
        }
        const limitPrice = Number(recommendation.limitPrice ?? config.limitPrice);
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
            return buildAutomationDecision('blocked', 'missing_limit_price', baseDetails);
        }
        if (config.maxOrderQuantity !== null && Number(recommendation.quantity) > config.maxOrderQuantity) {
            return buildAutomationDecision('blocked', 'exceeds_max_order_quantity', baseDetails);
        }
        const instrumentMultiplier = parsePositiveNumber(
            recommendation.hedgeInstrument && recommendation.hedgeInstrument.multiplier,
            config.hedgeInstrument.multiplier || 1
        );
        const estimatedNotional = Math.abs(Number(recommendation.quantity) || 0) * limitPrice * instrumentMultiplier;
        if (config.autoMaxNotional !== null && estimatedNotional > config.autoMaxNotional) {
            return buildAutomationDecision('blocked', 'exceeds_max_notional', {
                ...baseDetails,
                estimatedNotional,
                maxNotional: config.autoMaxNotional,
            });
        }
        if (orderCount >= maxOrdersPerDay) {
            return buildAutomationDecision('blocked', 'max_daily_orders_reached', baseDetails);
        }

        const cooldownMs = Math.max(0, Number(config.cooldownSeconds || 0)) * 1000;
        const lastEventMs = parseTimestampMs(rawConfig.lastOrderEventAt)
            ?? parseTimestampMs(rawConfig.lastAutoOrderAt);
        if (cooldownMs > 0 && lastEventMs !== null && nowMs - lastEventMs < cooldownMs) {
            return buildAutomationDecision('blocked', 'cooldown_active', {
                ...baseDetails,
                cooldownRemainingSeconds: Math.ceil((cooldownMs - (nowMs - lastEventMs)) / 1000),
            });
        }

        const preview = input.lastPreview || rawConfig.lastPreview || null;
        const previewMatches = previewMatchesRecommendation(preview, recommendation, config);
        const previewAtMs = parseTimestampMs(input.lastPreviewAt || rawConfig.lastPreviewAt);
        const maxPreviewAgeMs = Math.max(1, Number(config.autoPreviewMaxAgeSeconds || 30)) * 1000;
        if (!previewMatches) {
            return buildAutomationDecision('request_preview', preview ? 'preview_mismatch' : 'broker_preview_required', baseDetails);
        }
        if (previewAtMs === null || nowMs - previewAtMs > maxPreviewAgeMs) {
            return buildAutomationDecision('request_preview', 'preview_stale', {
                ...baseDetails,
                previewAgeSeconds: previewAtMs === null ? null : Math.floor((nowMs - previewAtMs) / 1000),
            });
        }

        return buildAutomationDecision('submit', '', baseDetails);
    }

    globalScope.OptionComboDeltaHedgeLogic = {
        createDefaultDeltaHedgeConfig,
        normalizeDeltaHedgeConfig,
        evaluateDeltaHedgeRecommendation,
        evaluateDeltaHedgeAutomation,
        selectHedgeReferencePrice,
        roundPriceToTick,
        calculateDefaultHedgeLimitPrice,
        buildHedgeRecommendationExecutionKey,
        hasActiveRestingHedgeOrder,
        evaluateRestingHedgeOrderApplicability,
    };
})(typeof window !== 'undefined' ? window : globalThis);
