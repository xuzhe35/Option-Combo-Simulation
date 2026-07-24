/**
 * Pure session import/export and mode-selection helpers.
 */

(function attachSessionLogic(globalScope) {
    function _getValidRepriceThresholds() {
        if (typeof globalScope.OptionComboTradeTriggerLogic !== 'undefined'
            && Array.isArray(globalScope.OptionComboTradeTriggerLogic.VALID_REPRICE_THRESHOLDS)) {
            return globalScope.OptionComboTradeTriggerLogic.VALID_REPRICE_THRESHOLDS;
        }

        return [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05];
    }

    function _getValidTimeInForceValues() {
        if (typeof globalScope.OptionComboTradeTriggerLogic !== 'undefined'
            && Array.isArray(globalScope.OptionComboTradeTriggerLogic.VALID_TIME_IN_FORCE)) {
            return globalScope.OptionComboTradeTriggerLogic.VALID_TIME_IN_FORCE;
        }

        return ['DAY', 'GTC'];
    }

    function _createDefaultTradeTrigger() {
        if (typeof globalScope.OptionComboTradeTriggerLogic !== 'undefined'
            && typeof globalScope.OptionComboTradeTriggerLogic.createDefaultTradeTrigger === 'function') {
            return globalScope.OptionComboTradeTriggerLogic.createDefaultTradeTrigger();
        }

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
            status: 'idle',
            pendingRequest: false,
            lastTriggeredAt: null,
            lastTriggerPrice: null,
            lastPreview: null,
            lastError: '',
        };
    }

    function _createDefaultCloseExecution() {
        return {
            executionMode: 'preview',
            strategy: 'auto',
            quantity: null,
            repriceThreshold: 0.01,
            timeInForce: 'DAY',
            isExpanded: false,
            status: 'idle',
            pendingRequest: false,
            lastPreview: null,
            lastError: '',
        };
    }

    function _createDefaultDeltaHedgeConfig() {
        if (typeof globalScope.OptionComboDeltaHedgeLogic !== 'undefined'
            && typeof globalScope.OptionComboDeltaHedgeLogic.createDefaultDeltaHedgeConfig === 'function') {
            return globalScope.OptionComboDeltaHedgeLogic.createDefaultDeltaHedgeConfig();
        }

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
            autoSubmitEnabled: false,
            autoCancelStaleOrders: true,
            autoMaxOrdersPerDay: 3,
            autoPreviewMaxAgeSeconds: 30,
        };
    }

    function _normalizeTradeTrigger(trigger) {
        if (typeof globalScope.OptionComboTradeTriggerLogic !== 'undefined'
            && typeof globalScope.OptionComboTradeTriggerLogic.normalizeTradeTrigger === 'function') {
            return globalScope.OptionComboTradeTriggerLogic.normalizeTradeTrigger(trigger);
        }

        return {
            ..._createDefaultTradeTrigger(),
            ...(trigger && typeof trigger === 'object' ? trigger : {}),
        };
    }

    function _normalizeCloseExecution(closeExecution) {
        const next = {
            ..._createDefaultCloseExecution(),
            ...(closeExecution && typeof closeExecution === 'object' ? closeExecution : {}),
        };

        const normalizedExecutionMode = String(next.executionMode || '').trim();
        next.executionMode = ['preview', 'test_submit', 'submit'].includes(normalizedExecutionMode)
            ? normalizedExecutionMode
            : 'preview';

        const normalizedStrategy = String(next.strategy || '').trim().toLowerCase();
        next.strategy = ['auto', 'combo'].includes(normalizedStrategy)
            ? normalizedStrategy
            : 'auto';

        const parsedQuantity = parseInt(next.quantity, 10);
        next.quantity = Number.isInteger(parsedQuantity) && parsedQuantity > 0
            ? parsedQuantity
            : null;

        const parsedThreshold = parseFloat(next.repriceThreshold);
        const validThresholds = _getValidRepriceThresholds();
        next.repriceThreshold = validThresholds.some(value => Math.abs(value - parsedThreshold) < 0.0001)
            ? parsedThreshold
            : 0.01;

        const normalizedTif = String(next.timeInForce || '').trim().toUpperCase();
        const validTifs = _getValidTimeInForceValues();
        next.timeInForce = validTifs.includes(normalizedTif) ? normalizedTif : 'DAY';

        next.isExpanded = next.isExpanded === true;
        next.pendingRequest = next.pendingRequest === true;
        if (typeof next.status !== 'string' || !next.status) {
            next.status = 'idle';
        }
        if (typeof next.lastError !== 'string') {
            next.lastError = '';
        }
        if (!next.lastPreview || typeof next.lastPreview !== 'object') {
            next.lastPreview = null;
        }

        return next;
    }

    function _toFiniteNumberOrNull(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _toFiniteNumberOrDefault(value, fallback) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function _toPositiveNumberOrDefault(value, fallback) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function _toPositiveIntegerOrDefault(value, fallback) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    }

    function _pickFirstDefined(primary, fallback) {
        return primary !== undefined ? primary : fallback;
    }

    function _normalizeDeltaHedgeInstrument(instrument) {
        const defaults = _createDefaultDeltaHedgeConfig().hedgeInstrument;
        const raw = instrument && typeof instrument === 'object' ? instrument : {};
        const secType = String(_pickFirstDefined(raw.secType, raw.sec_type) || defaults.secType).trim().toUpperCase();
        return {
            secType: ['STK', 'FUT'].includes(secType) ? secType : '',
            symbol: String(raw.symbol || defaults.symbol).trim().toUpperCase(),
            exchange: String(raw.exchange || defaults.exchange).trim().toUpperCase() || defaults.exchange,
            currency: String(raw.currency || defaults.currency).trim().toUpperCase() || defaults.currency,
            contractMonth: String(_pickFirstDefined(raw.contractMonth, raw.contract_month) || defaults.contractMonth).trim(),
            multiplier: _toPositiveNumberOrDefault(raw.multiplier, defaults.multiplier),
            deltaPerUnit: _toPositiveNumberOrDefault(
                _pickFirstDefined(raw.deltaPerUnit, raw.delta_per_unit),
                defaults.deltaPerUnit
            ),
            conversionRatio: _toPositiveNumberOrDefault(
                _pickFirstDefined(raw.conversionRatio, raw.conversion_ratio),
                defaults.conversionRatio
            ),
        };
    }

    function _normalizeDeltaHedgeConfig(deltaHedge) {
        if (typeof globalScope.OptionComboDeltaHedgeLogic !== 'undefined'
            && typeof globalScope.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig === 'function') {
            return globalScope.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig(deltaHedge);
        }

        const defaults = _createDefaultDeltaHedgeConfig();
        const raw = deltaHedge && typeof deltaHedge === 'object' ? deltaHedge : {};
        const orderType = String(_pickFirstDefined(raw.orderType, raw.order_type) || defaults.orderType).trim().toUpperCase();
        return {
            enabled: raw.enabled === true,
            targetDelta: _toFiniteNumberOrDefault(
                _pickFirstDefined(raw.targetDelta, raw.target_delta),
                defaults.targetDelta
            ),
            tolerance: _toPositiveNumberOrDefault(raw.tolerance, defaults.tolerance),
            proactiveBuffer: Math.max(0, _toFiniteNumberOrDefault(
                _pickFirstDefined(raw.proactiveBuffer, raw.proactive_buffer),
                defaults.proactiveBuffer
            )),
            hedgeInstrument: _normalizeDeltaHedgeInstrument(
                _pickFirstDefined(raw.hedgeInstrument, raw.hedge_instrument)
            ),
            orderType: ['LMT', 'MKT'].includes(orderType) ? orderType : defaults.orderType,
            limitPrice: _toFiniteNumberOrDefault(
                _pickFirstDefined(raw.limitPrice, raw.limit_price),
                defaults.limitPrice
            ),
            limitOffset: _toFiniteNumberOrDefault(
                _pickFirstDefined(raw.limitOffset, raw.limit_offset),
                defaults.limitOffset
            ),
            maxOrderQuantity: _toPositiveIntegerOrDefault(
                _pickFirstDefined(raw.maxOrderQuantity, raw.max_order_quantity),
                defaults.maxOrderQuantity
            ),
            autoMaxNotional: _toPositiveNumberOrDefault(
                _pickFirstDefined(raw.autoMaxNotional, raw.auto_max_notional),
                defaults.autoMaxNotional
            ),
            cooldownSeconds: _toPositiveIntegerOrDefault(
                _pickFirstDefined(raw.cooldownSeconds, raw.cooldown_seconds),
                defaults.cooldownSeconds
            ),
            autoSubmitEnabled: false,
            autoCancelStaleOrders: raw.autoCancelStaleOrders !== false && raw.auto_cancel_stale_orders !== false,
            autoMaxOrdersPerDay: _toPositiveIntegerOrDefault(
                _pickFirstDefined(raw.autoMaxOrdersPerDay, raw.auto_max_orders_per_day),
                defaults.autoMaxOrdersPerDay
            ),
            autoPreviewMaxAgeSeconds: _toPositiveIntegerOrDefault(
                _pickFirstDefined(raw.autoPreviewMaxAgeSeconds, raw.auto_preview_max_age_seconds),
                defaults.autoPreviewMaxAgeSeconds
            ),
        };
    }

    function _buildArchivableDeltaHedgeConfig(deltaHedge) {
        const normalized = _normalizeDeltaHedgeConfig(deltaHedge);
        return {
            enabled: normalized.enabled,
            targetDelta: normalized.targetDelta,
            tolerance: normalized.tolerance,
            proactiveBuffer: normalized.proactiveBuffer,
            hedgeInstrument: {
                secType: normalized.hedgeInstrument.secType,
                symbol: normalized.hedgeInstrument.symbol,
                exchange: normalized.hedgeInstrument.exchange,
                currency: normalized.hedgeInstrument.currency,
                contractMonth: normalized.hedgeInstrument.contractMonth,
                multiplier: normalized.hedgeInstrument.multiplier,
                deltaPerUnit: normalized.hedgeInstrument.deltaPerUnit,
                conversionRatio: normalized.hedgeInstrument.conversionRatio,
            },
            orderType: normalized.orderType,
            limitPrice: normalized.limitPrice,
            limitOffset: normalized.limitOffset,
            maxOrderQuantity: normalized.maxOrderQuantity,
            autoMaxNotional: normalized.autoMaxNotional,
            cooldownSeconds: normalized.cooldownSeconds,
            autoSubmitEnabled: false,
            autoCancelStaleOrders: normalized.autoCancelStaleOrders !== false,
            autoMaxOrdersPerDay: normalized.autoMaxOrdersPerDay,
            autoPreviewMaxAgeSeconds: normalized.autoPreviewMaxAgeSeconds,
        };
    }

    function _createDefaultForwardRateSample() {
        return {
            id: '',
            daysToExpiry: 30,
            expDate: '',
            strike: null,
            dailyCarry: null,
            carryRate: null,
            impliedRate: null,
            forwardPrice: null,
            spotPrice: null,
            discountRate: null,
            discountFactor: null,
            discountSource: '',
            quoteAsOf: '',
            expiryAsOf: '',
            quoteSkewMs: null,
            tenorSeconds: null,
            tenorDays: null,
            timeYears: null,
            unavailableReason: '',
            quality: null,
            lastComputedAt: null,
            isStale: false,
        };
    }

    function _normalizeForwardRateSample(sample, generateId, addDays, baseDate, markStale) {
        const next = {
            ..._createDefaultForwardRateSample(),
            ...(sample && typeof sample === 'object' ? sample : {}),
        };

        next.id = generateId();
        next.daysToExpiry = Math.max(0, parseInt(next.daysToExpiry, 10) || 0);

        if (typeof next.expDate !== 'string' || !next.expDate) {
            next.expDate = next.daysToExpiry > 0 ? addDays(baseDate, next.daysToExpiry) : '';
        }

        next.strike = _toFiniteNumberOrNull(next.strike);
        next.dailyCarry = _toFiniteNumberOrNull(next.dailyCarry);
        next.carryRate = _toFiniteNumberOrNull(next.carryRate)
            ?? _toFiniteNumberOrNull(next.impliedRate)
            ?? (next.dailyCarry !== null ? next.dailyCarry * 365 : null);
        next.impliedRate = _toFiniteNumberOrNull(next.impliedRate);
        next.forwardPrice = _toFiniteNumberOrNull(next.forwardPrice);
        next.spotPrice = _toFiniteNumberOrNull(next.spotPrice);
        next.discountRate = _toFiniteNumberOrNull(next.discountRate);
        next.discountFactor = _toFiniteNumberOrNull(next.discountFactor);
        next.discountSource = typeof next.discountSource === 'string' ? next.discountSource : '';
        next.quoteAsOf = typeof next.quoteAsOf === 'string' ? next.quoteAsOf : '';
        next.expiryAsOf = typeof next.expiryAsOf === 'string' ? next.expiryAsOf : '';
        next.quoteSkewMs = _toFiniteNumberOrNull(next.quoteSkewMs);
        next.tenorSeconds = _toFiniteNumberOrNull(next.tenorSeconds);
        next.tenorDays = _toFiniteNumberOrNull(next.tenorDays);
        next.timeYears = _toFiniteNumberOrNull(next.timeYears);
        next.unavailableReason = typeof next.unavailableReason === 'string'
            ? next.unavailableReason
            : '';
        next.quality = next.quality && typeof next.quality === 'object' ? { ...next.quality } : null;
        next.lastComputedAt = typeof next.lastComputedAt === 'string' && next.lastComputedAt
            ? next.lastComputedAt
            : null;

        const hasComputedValue = next.dailyCarry !== null || next.carryRate !== null || next.impliedRate !== null;
        next.isStale = markStale
            ? hasComputedValue
            : next.isStale === true;

        return next;
    }

    function _buildArchivableForwardRateSample(sample) {
        const normalized = {
            ..._createDefaultForwardRateSample(),
            ...(sample && typeof sample === 'object' ? sample : {}),
        };

        return {
            id: normalized.id || '',
            daysToExpiry: Math.max(0, parseInt(normalized.daysToExpiry, 10) || 0),
            expDate: typeof normalized.expDate === 'string' ? normalized.expDate : '',
            strike: _toFiniteNumberOrNull(normalized.strike),
            dailyCarry: _toFiniteNumberOrNull(normalized.dailyCarry),
            carryRate: _toFiniteNumberOrNull(normalized.carryRate),
            impliedRate: _toFiniteNumberOrNull(normalized.impliedRate),
            forwardPrice: _toFiniteNumberOrNull(normalized.forwardPrice),
            spotPrice: _toFiniteNumberOrNull(normalized.spotPrice),
            discountRate: _toFiniteNumberOrNull(normalized.discountRate),
            discountFactor: _toFiniteNumberOrNull(normalized.discountFactor),
            discountSource: typeof normalized.discountSource === 'string' ? normalized.discountSource : '',
            quoteAsOf: typeof normalized.quoteAsOf === 'string' ? normalized.quoteAsOf : '',
            expiryAsOf: typeof normalized.expiryAsOf === 'string' ? normalized.expiryAsOf : '',
            quoteSkewMs: _toFiniteNumberOrNull(normalized.quoteSkewMs),
            tenorSeconds: _toFiniteNumberOrNull(normalized.tenorSeconds),
            tenorDays: _toFiniteNumberOrNull(normalized.tenorDays),
            timeYears: _toFiniteNumberOrNull(normalized.timeYears),
            unavailableReason: typeof normalized.unavailableReason === 'string'
                ? normalized.unavailableReason
                : '',
            quality: normalized.quality && typeof normalized.quality === 'object'
                ? { ...normalized.quality }
                : null,
            lastComputedAt: typeof normalized.lastComputedAt === 'string' && normalized.lastComputedAt
                ? normalized.lastComputedAt
                : null,
            isStale: normalized.isStale === true,
        };
    }

    function _createDefaultFuturesPoolEntry() {
        return {
            id: '',
            contractMonth: '',
            bid: null,
            ask: null,
            mark: null,
            lastQuotedAt: null,
        };
    }

    function _normalizeFuturesPoolEntry(entry, generateId) {
        const next = {
            ..._createDefaultFuturesPoolEntry(),
            ...(entry && typeof entry === 'object' ? entry : {}),
        };

        next.id = typeof next.id === 'string' && next.id.trim()
            ? next.id.trim()
            : generateId();
        next.contractMonth = String(next.contractMonth || '').replace(/\D/g, '').slice(0, 6);
        next.bid = _toFiniteNumberOrNull(next.bid);
        next.ask = _toFiniteNumberOrNull(next.ask);
        next.mark = _toFiniteNumberOrNull(next.mark);
        next.lastQuotedAt = typeof next.lastQuotedAt === 'string' && next.lastQuotedAt
            ? next.lastQuotedAt
            : null;

        return next;
    }

    function _buildArchivableFuturesPoolEntry(entry) {
        const normalized = {
            ..._createDefaultFuturesPoolEntry(),
            ...(entry && typeof entry === 'object' ? entry : {}),
        };

        return {
            id: normalized.id || '',
            contractMonth: String(normalized.contractMonth || '').replace(/\D/g, '').slice(0, 6),
            bid: null,
            ask: null,
            mark: null,
            lastQuotedAt: null,
        };
    }

    function _buildArchivableTradeTrigger(trigger) {
        const normalized = _normalizeTradeTrigger(trigger);
        return {
            enabled: false,
            condition: normalized.condition,
            price: normalized.price,
            executionMode: normalized.executionMode,
            repriceThreshold: normalized.repriceThreshold,
            timeInForce: normalized.timeInForce,
            exitEnabled: normalized.exitEnabled,
            exitCondition: normalized.exitCondition,
            exitPrice: normalized.exitPrice,
            isExpanded: normalized.isExpanded,
            status: 'idle',
            pendingRequest: false,
            lastTriggeredAt: null,
            lastTriggerPrice: null,
            lastPreview: null,
            lastError: '',
        };
    }

    function _buildArchivableCloseExecution(closeExecution) {
        const normalized = _normalizeCloseExecution(closeExecution);
        return {
            executionMode: normalized.executionMode,
            strategy: normalized.strategy,
            quantity: normalized.quantity,
            repriceThreshold: normalized.repriceThreshold,
            timeInForce: normalized.timeInForce,
            isExpanded: normalized.isExpanded,
            status: 'idle',
            pendingRequest: false,
            lastPreview: null,
            lastError: '',
        };
    }

    function isGroupIncludedInGlobal(group) {
        return group.includedInGlobal !== false;
    }

    function getDefaultPortfolioAvgCostSync(group) {
        return getRenderableGroupViewMode(group) === 'trial';
    }

    function isPortfolioAvgCostSyncEnabled(group) {
        if (group && typeof group.syncAvgCostFromPortfolio === 'boolean') {
            return group.syncAvgCostFromPortfolio;
        }
        return getDefaultPortfolioAvgCostSync(group);
    }

    function normalizePortfolioAvgCostSync(group) {
        return isPortfolioAvgCostSyncEnabled(group);
    }

    function normalizeGroupLivePriceMode(value) {
        return String(value || '').trim().toLowerCase() === 'mark'
            ? 'mark'
            : 'midpoint';
    }

    function normalizeHistoricalAutoCloseAtExpiry(value) {
        return value !== false;
    }

    function normalizeGreeksEnabled(value) {
        return value === true;
    }

    function normalizeEquityOptionPricingModel(value) {
        return value === 'american-binomial' ? 'american-binomial' : 'bsm-spot';
    }

    function normalizeEquityDividendYield(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
    }

    function normalizeAmericanBinomialSteps(value) {
        const parsed = Math.round(Number(value));
        if (!Number.isFinite(parsed)) return 201;
        return Math.min(1001, Math.max(25, parsed));
    }

    function normalizeSimTimeBasis(value) {
        const normalized = String(value || '').trim().toLowerCase();
        return ['calendar', 'trading', 'weighted'].includes(normalized) ? normalized : 'weighted';
    }

    function normalizeSimWeekendWeight(value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return 0.3;
        }
        return Math.min(1, Math.max(0, parsed));
    }

    // The single weekend-variance weight (λ) the pricing clock runs on:
    // calendar = 1 (TWS/legacy behavior), trading = 0, weighted = the
    // user-configured value.
    function resolveSimWeekendWeight(simTimeBasis, simWeekendWeight) {
        const basis = normalizeSimTimeBasis(simTimeBasis);
        if (basis === 'calendar') {
            return 1;
        }
        if (basis === 'trading') {
            return 0;
        }
        return normalizeSimWeekendWeight(simWeekendWeight);
    }

    function normalizeSimUseImpliedLambda(value) {
        // Sessions written before structured implied-λ existed have no field.
        // Migrate those sessions into the safe mode: required non-trading
        // dates must be covered by IVTS data. A literal false may still select
        // the visible scalar for research/display, but the shared live
        // projection preflight will not let it bypass required closures.
        return value !== false;
    }

    function autoBindSingleFuturesPoolEntry(state) {
        const pool = state && Array.isArray(state.futuresPool) ? state.futuresPool : [];
        if (pool.length !== 1 || !pool[0] || !String(pool[0].id || '').trim()) {
            return false;
        }
        const registry = globalScope.OptionComboProductRegistry;
        if (registry && typeof registry.usesFuturesPool === 'function'
            && !registry.usesFuturesPool(state && state.underlyingSymbol)) {
            return false;
        }
        const onlyFutureId = String(pool[0].id).trim();
        const validIds = new Set(pool.map(entry => String(entry && entry.id || '').trim()).filter(Boolean));
        let changed = false;
        (state && Array.isArray(state.groups) ? state.groups : []).forEach((group) => {
            (group && Array.isArray(group.legs) ? group.legs : []).forEach((leg) => {
                const isOption = registry && typeof registry.isOptionLeg === 'function'
                    ? registry.isOptionLeg(leg)
                    : ['call', 'put'].includes(String(leg && leg.type || '').toLowerCase());
                if (!isOption) return;
                const selectedId = String(leg && leg.underlyingFutureId || '').trim();
                if (selectedId && validIds.has(selectedId)) return;
                leg.underlyingFutureId = onlyFutureId;
                changed = true;
            });
        });
        return changed;
    }

    function ensureInitialFuturesPoolEntry(state, generateId, referenceDate) {
        if (!state || typeof state !== 'object') {
            return null;
        }
        const registry = globalScope.OptionComboProductRegistry;
        if (!registry || typeof registry.usesFuturesPool !== 'function'
            || !registry.usesFuturesPool(state.underlyingSymbol)) {
            return null;
        }

        const normalizeMonth = value => String(value || '').replace(/\D/g, '').slice(0, 6);
        if (!Array.isArray(state.futuresPool)) {
            state.futuresPool = [];
        }
        let contractMonth = normalizeMonth(state.underlyingContractMonth);
        if (!/^\d{6}$/.test(contractMonth)) {
            const configuredMonths = Array.from(new Set(
                state.futuresPool
                    .map(entry => normalizeMonth(entry && entry.contractMonth))
                    .filter(month => /^\d{6}$/.test(month))
            ));
            if (configuredMonths.length === 1) {
                contractMonth = configuredMonths[0];
            }
        }
        if (!/^\d{6}$/.test(contractMonth)
            && typeof registry.resolveDefaultUnderlyingContractMonth === 'function') {
            contractMonth = normalizeMonth(registry.resolveDefaultUnderlyingContractMonth(
                state.underlyingSymbol,
                referenceDate || state.liveQuoteDate || state.historicalQuoteDate
                    || state.simulatedDate || state.baseDate
            ));
        }
        if (!/^\d{6}$/.test(contractMonth)) {
            return null;
        }
        state.underlyingContractMonth = contractMonth;

        const matchingEntry = state.futuresPool.find(entry => (
            normalizeMonth(entry && entry.contractMonth) === contractMonth
        ));
        if (matchingEntry) {
            return { entry: matchingEntry, created: false };
        }

        // Supply the implicit front month only while the pool is unconfigured.
        // Explicit pool months belong to the user's multi-expiry setup.
        const configuredEntries = state.futuresPool.filter(entry => (
            /^\d{6}$/.test(normalizeMonth(entry && entry.contractMonth))
        ));
        if (configuredEntries.length > 0 || state.futuresPool.length > 1) {
            return null;
        }

        let entry = state.futuresPool[0] || null;
        if (!entry) {
            let id = '';
            if (typeof generateId === 'function') {
                try {
                    id = String(generateId() || '').trim();
                } catch (_) {
                    id = '';
                }
            }
            if (!id) {
                const symbol = String(state.underlyingSymbol || 'FUT')
                    .trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'FUT';
                id = `auto_future_${symbol}_${contractMonth}`;
            }
            entry = {
                id,
                contractMonth,
                bid: null,
                ask: null,
                mark: null,
                lastQuotedAt: null,
            };
            state.futuresPool.push(entry);
        } else {
            entry.contractMonth = contractMonth;
            if (!String(entry.id || '').trim()) {
                entry.id = `auto_future_${String(state.underlyingSymbol || 'FUT')
                    .trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'FUT'}_${contractMonth}`;
            }
        }

        autoBindSingleFuturesPoolEntry(state);
        return { entry, created: true };
    }

    function normalizeProjectionConvergenceMode(value) {
        // Missing/unknown live-session fields migrate to the accuracy-first
        // policy.  The prior input-IV projection path survives only when a
        // session explicitly records this compatibility value.
        return String(value || '').trim().toLowerCase() === 'legacy-input-iv'
            ? 'legacy-input-iv'
            : 'strict-bbo';
    }

    // Weekend weight actually handed to the pricing clock. Once the user asks
    // for IVTS implied lambda, every non-trading date must have an explicit V2
    // observation. Missing/invalid entries remain strict with an empty byDate
    // map so pricing fails closed instead of silently substituting the scalar.
    // The scalar remains available when implied-lambda mode is disabled, but
    // live projections that cross closures are blocked by the shared coverage
    // preflight; only `not_required` intervals may continue without V2 data.
    function resolveSimWeekendWeightSpec(simTimeBasis, simWeekendWeight, useImpliedLambda, impliedEntry) {
        const scalar = resolveSimWeekendWeight(simTimeBasis, simWeekendWeight);
        if (normalizeSimTimeBasis(simTimeBasis) !== 'weighted'
            || normalizeSimUseImpliedLambda(useImpliedLambda) !== true) {
            return scalar;
        }
        const strictSpec = {
            default: scalar,
            byDate: null,
            strictByDate: true,
            coverageStart: null,
            coverageEnd: null,
            fallbackSource: null,
        };
        const quality = impliedEntry && impliedEntry.quality;
        const acceptedVarianceSource = impliedEntry && (
            impliedEntry.varianceSource === 'straddle'
            || (impliedEntry.varianceSource === 'vendor_iv'
                && quality && quality.estimationMode === 'best_effort'
                && quality.sourceQuoteEvidence === 'vendor_atm_iv_fallback')
        );
        const isQualifiedV2 = impliedEntry && impliedEntry.schemaVersion === 2
            && acceptedVarianceSource
            && quality && quality.status === 'ok'
            && quality.coherent === true
            && quality.quoteComplete === true;
        if (!isQualifiedV2) {
            return strictSpec;
        }
        const byDate = impliedEntry && impliedEntry.byDate && typeof impliedEntry.byDate === 'object'
            ? impliedEntry.byDate
            : null;
        if (!byDate || !Object.keys(byDate).length) {
            return strictSpec;
        }
        return {
            default: scalar,
            byDate,
            strictByDate: true,
            coverageStart: typeof impliedEntry.coverageStart === 'string'
                ? impliedEntry.coverageStart
                : null,
            coverageEnd: typeof impliedEntry.coverageEnd === 'string'
                ? impliedEntry.coverageEnd
                : null,
            fallbackSource: null,
        };
    }

    function groupHasDeterministicCost(group) {
        return (group.legs || []).some(leg => Math.abs(parseFloat(leg.cost) || 0) > 0);
    }

    function groupHasOpenPosition(group) {
        return (group.legs || []).some((leg) => {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== '' && leg.closePrice !== undefined;
            return pos > 0.0001 && !hasClosePrice;
        });
    }

    function resolveGroupViewModeChange(group, requestedMode) {
        if (requestedMode === 'amortized' && !groupHasDeterministicCost(group)) {
            return group.viewMode || 'active';
        }
        return requestedMode;
    }

    function getRenderableGroupViewMode(group) {
        const currentMode = group.viewMode || 'active';
        if (!groupHasDeterministicCost(group) && currentMode !== 'settlement') {
            return 'trial';
        }
        return currentMode;
    }

    function buildExportState(state) {
        const snapshot = JSON.parse(JSON.stringify(state));
        snapshot.projectionConvergenceMode = normalizeProjectionConvergenceMode(
            snapshot.projectionConvergenceMode
        );
        snapshot.liveComboOrderAccounts = [];
        snapshot.liveComboOrderAccountsConnected = false;
        snapshot.allowLiveHedgeOrders = false;
        snapshot.deltaHedge = _buildArchivableDeltaHedgeConfig(snapshot.deltaHedge);
        snapshot.groups = (snapshot.groups || []).map(group => ({
            ...group,
            tradeTrigger: _buildArchivableTradeTrigger(group.tradeTrigger),
            closeExecution: _buildArchivableCloseExecution(group.closeExecution),
            legs: (group.legs || []).map((leg) => {
                const archived = { ...leg };
                delete archived.expiryAsOf;
                delete archived.expiryTimingSource;
                delete archived.lastTradeDate;
                delete archived.lastTradeTime;
                delete archived.expiryTimeZoneId;
                delete archived.realExpirationDate;
                delete archived.qualifiedOptionConId;
                delete archived.qualifiedOptionLocalSymbol;
                delete archived.qualifiedOptionTradingClass;
                delete archived.qualifiedOptionUnderConId;
                delete archived.qualifiedOptionUnderlyingContractMonth;
                delete archived.liveQuoteIdentityStatus;
                delete archived.liveQuoteIdentityReason;
                return archived;
            }),
        }));
        snapshot.forwardRateSamples = (snapshot.forwardRateSamples || [])
            .map(sample => _buildArchivableForwardRateSample(sample));
        snapshot.futuresPool = (snapshot.futuresPool || [])
            .map(entry => _buildArchivableFuturesPoolEntry(entry));
        delete snapshot.comboTemplateQuoteRequests;
        // Belongs to one live subscription attempt, never to the saved book.
        delete snapshot.liveSubscriptionUnresolvedById;
        delete snapshot.liveQuoteDate;
        delete snapshot.liveQuoteAsOf;
        delete snapshot.discountCurveLastError;
        delete snapshot.simImpliedLambdaEntry;
        delete snapshot.simImpliedLambdaFileEntry;
        delete snapshot.simImpliedLambdaCoverage;
        delete snapshot.simulationTiming;
        delete snapshot.simulationTargetAsOf;
        delete snapshot.liveProjectionFeedConnected;
        delete snapshot.liveProjectionFeedStale;
        delete snapshot.liveProjectionLastReceivedAt;
        return snapshot;
    }

    function normalizeImportedState(currentState, importedState, initialDateStr, generateId, addDays) {
        const nextState = {
            underlyingSymbol: importedState.underlyingSymbol || 'SPY',
            underlyingContractMonth: importedState.underlyingContractMonth || '',
            underlyingPrice: importedState.underlyingPrice || 100,
            baseDate: importedState.baseDate || initialDateStr,
            simulatedDate: importedState.baseDate || initialDateStr,
            marketDataMode: importedState.marketDataMode === 'historical' ? 'historical' : 'live',
            historicalQuoteDate: importedState.marketDataMode === 'historical'
                ? (typeof importedState.historicalQuoteDate === 'string' && importedState.historicalQuoteDate
                    ? importedState.historicalQuoteDate
                    : (typeof importedState.simulatedDate === 'string' ? importedState.simulatedDate : (importedState.baseDate || '')))
                : (typeof importedState.historicalQuoteDate === 'string'
                    ? importedState.historicalQuoteDate
                    : ''),
            historicalAvailableStartDate: '',
            historicalAvailableEndDate: '',
            liveQuoteDate: '',
            liveQuoteAsOf: '',
            interestRate: importedState.interestRate !== undefined ? importedState.interestRate : 0.03,
            equityOptionPricingModel: normalizeEquityOptionPricingModel(
                importedState.equityOptionPricingModel
            ),
            equityDividendYield: normalizeEquityDividendYield(
                importedState.equityDividendYield
            ),
            americanBinomialSteps: normalizeAmericanBinomialSteps(
                importedState.americanBinomialSteps
            ),
            useMarketDiscountCurve: importedState.useMarketDiscountCurve !== false,
            discountCurve: importedState.discountCurve && typeof importedState.discountCurve === 'object'
                ? JSON.parse(JSON.stringify(importedState.discountCurve))
                : null,
            discountCurveLastError: '',
            ivOffset: importedState.ivOffset || 0,
            simTimeBasis: normalizeSimTimeBasis(importedState.simTimeBasis),
            simWeekendWeight: normalizeSimWeekendWeight(importedState.simWeekendWeight),
            simUseImpliedLambda: normalizeSimUseImpliedLambda(importedState.simUseImpliedLambda),
            simImpliedLambdaEntry: null,
            simImpliedLambdaFileEntry: null,
            projectionConvergenceMode: normalizeProjectionConvergenceMode(
                importedState.projectionConvergenceMode
            ),
            liveProjectionFeedConnected: false,
            liveProjectionFeedStale: true,
            liveProjectionLastReceivedAt: '',
            // Contract cutoffs are transient IB evidence, not a portable
            // session preference. Never let an older/imported false flag
            // disable the live hour-level safety gate.
            requireExactContractTiming: true,
            greeksEnabled: normalizeGreeksEnabled(importedState.greeksEnabled),
            deltaHedge: _normalizeDeltaHedgeConfig(importedState.deltaHedge),
            primaryControlPanelCollapsed: importedState.primaryControlPanelCollapsed === true,
            allowLiveComboOrders: importedState.allowLiveComboOrders === true,
            allowLiveHedgeOrders: false,
            liveComboOrderAccounts: [],
            liveComboOrderAccountsConnected: false,
            selectedLiveComboOrderAccount: typeof importedState.selectedLiveComboOrderAccount === 'string'
                ? importedState.selectedLiveComboOrderAccount.trim()
                : '',
            forwardRateSamples: [],
            futuresPool: [],
            groups: currentState.groups.slice(),
            hedges: currentState.hedges.slice(),
        };
        nextState.deltaHedge.autoSubmitEnabled = false;
        nextState.deltaHedge.autoLastDecision = null;
        const importedFutureIdMap = new Map();

        if (importedState.simulatedDate) {
            nextState.simulatedDate = importedState.simulatedDate;
        } else if (importedState.daysPassed !== undefined) {
            nextState.simulatedDate = addDays(nextState.baseDate, importedState.daysPassed);
        } else {
            nextState.simulatedDate = nextState.baseDate;
        }

        function migrateLegs(legsArr) {
            return legsArr.map(leg => {
                const newLeg = { ...leg, id: generateId() };
                delete newLeg.expiryAsOf;
                delete newLeg.expiryTimingSource;
                delete newLeg.lastTradeDate;
                delete newLeg.lastTradeTime;
                delete newLeg.expiryTimeZoneId;
                delete newLeg.realExpirationDate;
                delete newLeg.qualifiedOptionConId;
                delete newLeg.qualifiedOptionLocalSymbol;
                delete newLeg.qualifiedOptionTradingClass;
                delete newLeg.qualifiedOptionUnderConId;
                delete newLeg.qualifiedOptionUnderlyingContractMonth;
                delete newLeg.liveQuoteIdentityStatus;
                delete newLeg.liveQuoteIdentityReason;
                if (newLeg.dte !== undefined && newLeg.expDate === undefined) {
                    newLeg.expDate = addDays(nextState.baseDate, newLeg.dte);
                    delete newLeg.dte;
                }
                if (newLeg.currentPrice === undefined) {
                    newLeg.currentPrice = 0.00;
                }
                if (typeof newLeg.currentPriceSource !== 'string') {
                    newLeg.currentPriceSource = '';
                }
                if (!Number.isFinite(parseFloat(newLeg.portfolioMarketPrice)) || parseFloat(newLeg.portfolioMarketPrice) < 0) {
                    newLeg.portfolioMarketPrice = null;
                } else {
                    newLeg.portfolioMarketPrice = parseFloat(newLeg.portfolioMarketPrice);
                }
                if (typeof newLeg.portfolioMarketPriceSource !== 'string') {
                    newLeg.portfolioMarketPriceSource = '';
                }
                if (!Number.isFinite(parseFloat(newLeg.portfolioUnrealizedPnl))) {
                    newLeg.portfolioUnrealizedPnl = null;
                } else {
                    newLeg.portfolioUnrealizedPnl = parseFloat(newLeg.portfolioUnrealizedPnl);
                }
                if (typeof newLeg.underlyingFutureId !== 'string') {
                    newLeg.underlyingFutureId = '';
                }
                if (newLeg.closePrice === undefined) {
                    newLeg.closePrice = null;
                }
                if (String(newLeg.type || '').toLowerCase() !== 'stock') {
                    if (typeof newLeg.ivSource !== 'string' || !newLeg.ivSource) {
                        newLeg.ivSource = 'manual';
                    }
                    if (typeof newLeg.ivManualOverride !== 'boolean') {
                        newLeg.ivManualOverride = false;
                    }
                }
                return newLeg;
            });
        }

        let importedGroups = [];
        if (importedState.legs && Array.isArray(importedState.legs) && (!importedState.groups || importedState.groups.length === 0)) {
            importedGroups = [{
                id: generateId(),
                name: 'Legacy Combo',
                includedInGlobal: true,
                isCollapsed: false,
                livePriceMode: 'midpoint',
                settleUnderlyingPrice: null,
                historicalAutoCloseAtExpiry: true,
                tradeTrigger: _createDefaultTradeTrigger(),
                closeExecution: _createDefaultCloseExecution(),
                legs: migrateLegs(importedState.legs)
            }];
        } else {
            const parsedGroups = Array.isArray(importedState.groups) ? importedState.groups : [];
            importedGroups = parsedGroups.map(g => ({
                ...g,
                id: generateId(),
                includedInGlobal: isGroupIncludedInGlobal(g),
                isCollapsed: g.isCollapsed === true,
                livePriceMode: 'midpoint',
                settleUnderlyingPrice: g.settleUnderlyingPrice !== undefined ? g.settleUnderlyingPrice : null,
                historicalAutoCloseAtExpiry: normalizeHistoricalAutoCloseAtExpiry(g.historicalAutoCloseAtExpiry),
                tradeTrigger: _buildArchivableTradeTrigger(g.tradeTrigger),
                closeExecution: _buildArchivableCloseExecution(g.closeExecution),
                legs: migrateLegs(Array.isArray(g.legs) ? g.legs : [])
            }));
        }

        importedGroups = importedGroups.map(group => ({
            ...group,
            livePriceMode: normalizeGroupLivePriceMode(group.livePriceMode),
            historicalAutoCloseAtExpiry: normalizeHistoricalAutoCloseAtExpiry(group.historicalAutoCloseAtExpiry),
            syncAvgCostFromPortfolio: normalizePortfolioAvgCostSync(group),
        }));

        nextState.forwardRateSamples = Array.isArray(importedState.forwardRateSamples)
            ? importedState.forwardRateSamples.map(sample => _normalizeForwardRateSample(
                sample,
                generateId,
                addDays,
                nextState.baseDate,
                true
            ))
            : [];

        nextState.futuresPool = Array.isArray(importedState.futuresPool)
            ? importedState.futuresPool.map((entry) => {
                const normalizedEntry = _normalizeFuturesPoolEntry(entry, generateId);
                const legacyId = typeof entry?.id === 'string' ? entry.id.trim() : '';
                if (legacyId) {
                    importedFutureIdMap.set(legacyId, normalizedEntry.id);
                }
                return normalizedEntry;
            })
            : [];

        if (importedFutureIdMap.size > 0) {
            importedGroups = importedGroups.map(group => ({
                ...group,
                legs: (group.legs || []).map((leg) => {
                    const legacyFutureId = typeof leg?.underlyingFutureId === 'string'
                        ? leg.underlyingFutureId.trim()
                        : '';
                    return {
                        ...leg,
                        underlyingFutureId: legacyFutureId && importedFutureIdMap.has(legacyFutureId)
                            ? importedFutureIdMap.get(legacyFutureId)
                            : legacyFutureId,
                    };
                }),
            }));
        }

        nextState.groups.push(...importedGroups);

        autoBindSingleFuturesPoolEntry(nextState);

        if (importedState.hedges && Array.isArray(importedState.hedges)) {
            nextState.hedges.push(...importedState.hedges.map(h => ({
                ...h,
                id: generateId()
            })));
        }

        return nextState;
    }

    globalScope.OptionComboSessionLogic = {
        isGroupIncludedInGlobal,
        getDefaultPortfolioAvgCostSync,
        isPortfolioAvgCostSyncEnabled,
        normalizePortfolioAvgCostSync,
        normalizeGroupLivePriceMode,
        normalizeHistoricalAutoCloseAtExpiry,
        normalizeGreeksEnabled,
        normalizeEquityOptionPricingModel,
        normalizeEquityDividendYield,
        normalizeAmericanBinomialSteps,
        normalizeSimTimeBasis,
        normalizeSimWeekendWeight,
        resolveSimWeekendWeight,
        normalizeSimUseImpliedLambda,
        normalizeProjectionConvergenceMode,
        resolveSimWeekendWeightSpec,
        ensureInitialFuturesPoolEntry,
        autoBindSingleFuturesPoolEntry,
        groupHasDeterministicCost,
        resolveGroupViewModeChange,
        getRenderableGroupViewMode,
        buildExportState,
        normalizeImportedState,
        buildArchivableTradeTrigger: _buildArchivableTradeTrigger,
        createDefaultDeltaHedgeConfig: _createDefaultDeltaHedgeConfig,
        normalizeDeltaHedgeConfig: _normalizeDeltaHedgeConfig,
        buildArchivableDeltaHedgeConfig: _buildArchivableDeltaHedgeConfig,
        createDefaultCloseExecution: _createDefaultCloseExecution,
        normalizeCloseExecution: _normalizeCloseExecution,
        buildArchivableCloseExecution: _buildArchivableCloseExecution,
        groupHasOpenPosition,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
