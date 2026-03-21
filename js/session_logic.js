/**
 * Pure session import/export and mode-selection helpers.
 */

(function attachSessionLogic(globalScope) {
    function _getValidRepriceThresholds() {
        if (typeof globalScope.OptionComboTradeTriggerLogic !== 'undefined'
            && Array.isArray(globalScope.OptionComboTradeTriggerLogic.VALID_REPRICE_THRESHOLDS)) {
            return globalScope.OptionComboTradeTriggerLogic.VALID_REPRICE_THRESHOLDS;
        }

        return [0.01, 0.02, 0.05];
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

    function groupHasDeterministicCost(group) {
        return (group.legs || []).some(leg => Math.abs(parseFloat(leg.cost) || 0) > 0);
    }

    function groupHasOpenPosition(group) {
        return (group.legs || []).some((leg) => {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            const hasClosePrice = leg && leg.closePrice !== null && leg.closePrice !== '';
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
        snapshot.groups = (snapshot.groups || []).map(group => ({
            ...group,
            tradeTrigger: _buildArchivableTradeTrigger(group.tradeTrigger),
            closeExecution: _buildArchivableCloseExecution(group.closeExecution),
        }));
        return snapshot;
    }

    function normalizeImportedState(currentState, importedState, initialDateStr, generateId, addDays) {
        const nextState = {
            underlyingSymbol: importedState.underlyingSymbol || 'SPY',
            underlyingContractMonth: importedState.underlyingContractMonth || '',
            underlyingPrice: importedState.underlyingPrice || 100,
            baseDate: importedState.baseDate || initialDateStr,
            simulatedDate: importedState.baseDate || initialDateStr,
            interestRate: importedState.interestRate !== undefined ? importedState.interestRate : 0.03,
            ivOffset: importedState.ivOffset || 0,
            allowLiveComboOrders: importedState.allowLiveComboOrders === true,
            groups: currentState.groups.slice(),
            hedges: currentState.hedges.slice(),
        };

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
                settleUnderlyingPrice: null,
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
                settleUnderlyingPrice: g.settleUnderlyingPrice !== undefined ? g.settleUnderlyingPrice : null,
                tradeTrigger: _buildArchivableTradeTrigger(g.tradeTrigger),
                closeExecution: _buildArchivableCloseExecution(g.closeExecution),
                legs: migrateLegs(Array.isArray(g.legs) ? g.legs : [])
            }));
        }

        importedGroups = importedGroups.map(group => ({
            ...group,
            syncAvgCostFromPortfolio: normalizePortfolioAvgCostSync(group),
        }));

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
