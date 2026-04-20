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
            repriceThreshold: 0.01,
            timeInForce: 'DAY',
            isExpanded: false,
            status: 'idle',
            pendingRequest: false,
            lastPreview: null,
            lastError: '',
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

    function _createDefaultForwardRateSample() {
        return {
            id: '',
            daysToExpiry: 30,
            expDate: '',
            strike: null,
            dailyCarry: null,
            impliedRate: null,
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
        next.impliedRate = _toFiniteNumberOrNull(next.impliedRate);
        next.lastComputedAt = typeof next.lastComputedAt === 'string' && next.lastComputedAt
            ? next.lastComputedAt
            : null;

        const hasComputedValue = next.dailyCarry !== null || next.impliedRate !== null;
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
            impliedRate: _toFiniteNumberOrNull(normalized.impliedRate),
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
        return String(value || '').trim().toLowerCase() === 'midpoint'
            ? 'midpoint'
            : 'mark';
    }

    function normalizeHistoricalAutoCloseAtExpiry(value) {
        return value !== false;
    }

    function normalizeGreeksEnabled(value) {
        return value === true;
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
        snapshot.liveComboOrderAccounts = [];
        snapshot.liveComboOrderAccountsConnected = false;
        snapshot.groups = (snapshot.groups || []).map(group => ({
            ...group,
            tradeTrigger: _buildArchivableTradeTrigger(group.tradeTrigger),
            closeExecution: _buildArchivableCloseExecution(group.closeExecution),
        }));
        snapshot.forwardRateSamples = (snapshot.forwardRateSamples || [])
            .map(sample => _buildArchivableForwardRateSample(sample));
        snapshot.futuresPool = (snapshot.futuresPool || [])
            .map(entry => _buildArchivableFuturesPoolEntry(entry));
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
            interestRate: importedState.interestRate !== undefined ? importedState.interestRate : 0.03,
            ivOffset: importedState.ivOffset || 0,
            greeksEnabled: normalizeGreeksEnabled(importedState.greeksEnabled),
            primaryControlPanelCollapsed: importedState.primaryControlPanelCollapsed === true,
            allowLiveComboOrders: importedState.allowLiveComboOrders === true,
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
                if (!Number.isFinite(parseFloat(newLeg.portfolioMarketPrice)) || parseFloat(newLeg.portfolioMarketPrice) <= 0) {
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
                livePriceMode: 'mark',
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
                livePriceMode: normalizeGroupLivePriceMode(g.livePriceMode),
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
        groupHasDeterministicCost,
        resolveGroupViewModeChange,
        getRenderableGroupViewMode,
        buildExportState,
        normalizeImportedState,
        buildArchivableTradeTrigger: _buildArchivableTradeTrigger,
        createDefaultCloseExecution: _createDefaultCloseExecution,
        normalizeCloseExecution: _normalizeCloseExecution,
        buildArchivableCloseExecution: _buildArchivableCloseExecution,
        groupHasOpenPosition,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
