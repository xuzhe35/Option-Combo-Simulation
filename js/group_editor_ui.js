/**
 * Group and leg editor rendering and event binding.
 */

(function attachGroupEditorUI(globalScope) {
    const productRegistry = globalScope.OptionComboProductRegistry;
    const pricingCore = globalScope.OptionComboPricingCore;

    function parseIvPercentInput(rawValue) {
        const normalized = String(rawValue || '')
            .replace(/[^0-9.+-]/g, '');
        const parsed = parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function isUnderlyingLeg(leg) {
        return productRegistry.isUnderlyingLeg(leg);
    }

    function getUnderlyingLegLabel(symbol) {
        return productRegistry && typeof productRegistry.getUnderlyingLegLabel === 'function'
            ? productRegistry.getUnderlyingLegLabel(symbol)
            : 'Underlying';
    }

    function getPricingInputMode(symbol) {
        return productRegistry && typeof productRegistry.resolvePricingInputMode === 'function'
            ? productRegistry.resolvePricingInputMode(symbol)
            : 'STK';
    }

    function getPriceInputStep(symbol) {
        return productRegistry && typeof productRegistry.getPriceInputStep === 'function'
            ? productRegistry.getPriceInputStep(symbol)
            : '0.01';
    }

    function formatPriceInputValue(symbol, value) {
        if (productRegistry && typeof productRegistry.formatPriceInputValue === 'function') {
            return productRegistry.formatPriceInputValue(symbol, value);
        }
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed.toFixed(2) : '';
    }

    function formatRepriceThresholdValue(value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return '';
        }
        const raw = parsed >= 0.01 ? parsed.toFixed(2) : parsed.toFixed(4);
        return raw.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
    }

    function getLegAnchorDate(state) {
        if (state && state.marketDataMode === 'historical' && state.historicalQuoteDate) {
            return state.historicalQuoteDate;
        }
        return state.baseDate;
    }

    function applyMarketDataToggleUi(state, group, liveToggle) {
        if (!liveToggle) return;

        const statusSpan = liveToggle.parentElement && liveToggle.parentElement.previousElementSibling;
        const labelSpan = liveToggle.parentElement
            ? liveToggle.parentElement.querySelector('.market-data-toggle-label')
            : null;
        const isHistoricalMode = !!(state && state.marketDataMode === 'historical');

        if (statusSpan) {
            statusSpan.textContent = group.liveData
                ? (isHistoricalMode ? 'Replay' : 'Live')
                : 'Offline';
        }

        if (labelSpan) {
            labelSpan.textContent = isHistoricalMode
                ? 'Historical Replay'
                : 'Market Data Feed';
        }
    }

    function _ensureTradeTrigger(group) {
        return OptionComboTradeTriggerLogic.ensureGroupTradeTrigger(group);
    }

    function _ensurePortfolioAvgCostSync(group) {
        if (!group || typeof group !== 'object') {
            return false;
        }
        group.syncAvgCostFromPortfolio = OptionComboSessionLogic.normalizePortfolioAvgCostSync(group);
        return group.syncAvgCostFromPortfolio;
    }

    function _ensureLivePriceMode(group) {
        if (!group || typeof group !== 'object') {
            return 'mark';
        }
        if (typeof OptionComboSessionLogic !== 'undefined'
            && typeof OptionComboSessionLogic.normalizeGroupLivePriceMode === 'function') {
            group.livePriceMode = OptionComboSessionLogic.normalizeGroupLivePriceMode(group.livePriceMode);
        } else {
            group.livePriceMode = String(group.livePriceMode || '').trim().toLowerCase() === 'midpoint'
                ? 'midpoint'
                : 'mark';
        }
        return group.livePriceMode;
    }

    function _ensureCloseExecution(group) {
        if (!group || typeof group !== 'object') {
            return null;
        }
        group.closeExecution = OptionComboSessionLogic.normalizeCloseExecution(group.closeExecution);
        return group.closeExecution;
    }

    function _ensureHistoricalAutoCloseAtExpiry(group) {
        if (!group || typeof group !== 'object') {
            return true;
        }
        if (typeof OptionComboSessionLogic !== 'undefined'
            && typeof OptionComboSessionLogic.normalizeHistoricalAutoCloseAtExpiry === 'function') {
            group.historicalAutoCloseAtExpiry = OptionComboSessionLogic.normalizeHistoricalAutoCloseAtExpiry(
                group.historicalAutoCloseAtExpiry
            );
        } else {
            group.historicalAutoCloseAtExpiry = group.historicalAutoCloseAtExpiry !== false;
        }
        return group.historicalAutoCloseAtExpiry;
    }

    function _groupHasCostForAllPositionedLegs(group) {
        return (group && Array.isArray(group.legs) ? group.legs : []).every((leg) => {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            if (pos < 0.0001) {
                return true;
            }
            return Math.abs(parseFloat(leg && leg.cost) || 0) > 0;
        });
    }

    function _getSettlementUnitsPerContract(state, deps) {
        if (pricingCore && typeof pricingCore.getSettlementUnitsPerContract === 'function') {
            return pricingCore.getSettlementUnitsPerContract(
                deps && typeof deps.getUnderlyingProfile === 'function'
                    ? deps.getUnderlyingProfile()
                    : (state && state.underlyingSymbol)
            );
        }
        return 100;
    }

    function _getAssignmentShareDelta(leg, state, deps) {
        const pos = parseFloat(leg && leg.pos) || 0;
        if (Math.abs(pos) < 0.0001) {
            return 0;
        }

        const settlementUnitsPerContract = _getSettlementUnitsPerContract(state, deps);
        const lowerType = String(leg && leg.type || '').trim().toLowerCase();
        if (lowerType === 'call') {
            return pos * settlementUnitsPerContract;
        }
        if (lowerType === 'put') {
            return -pos * settlementUnitsPerContract;
        }
        return 0;
    }

    function _resolveAssignmentActionLabel(leg) {
        if (!leg || isUnderlyingLeg(leg)) {
            return '';
        }

        if (leg.closePriceSource === 'assignment_conversion') {
            return 'Undo';
        }

        return (parseFloat(leg.pos) || 0) < 0 ? 'Assign' : 'Exercise';
    }

    function _isAssignmentConvertible(group, leg, state, deps) {
        if (!group || !leg || isUnderlyingLeg(leg)) {
            return false;
        }

        const pos = Math.abs(parseFloat(leg.pos) || 0);
        if (pos < 0.0001) {
            return false;
        }

        const renderMode = deps && typeof deps.getRenderableGroupViewMode === 'function'
            ? deps.getRenderableGroupViewMode(group)
            : (group.viewMode || 'active');
        if (renderMode !== 'active' && renderMode !== 'settlement') {
            return false;
        }

        if (deps && typeof deps.supportsUnderlyingLegs === 'function' && !deps.supportsUnderlyingLegs(state.underlyingSymbol)) {
            return false;
        }

        return true;
    }

    function applyOptionAssignmentConversion(group, leg, state, deps) {
        if (!_isAssignmentConvertible(group, leg, state, deps)) {
            return false;
        }

        const linkedLegId = String(leg.assignmentUnderlyingLegId || '').trim();
        if (leg.closePriceSource === 'assignment_conversion' && linkedLegId) {
            group.legs = (group.legs || []).filter((entry) => entry.id !== linkedLegId);
            leg.closePrice = null;
            leg.closePriceSource = '';
            leg.assignmentUnderlyingLegId = '';
            leg.assignmentUnderlyingQuantity = 0;
            if (deps && typeof deps.handleLiveSubscriptions === 'function') {
                deps.handleLiveSubscriptions();
            }
            if (deps && typeof deps.renderGroups === 'function') {
                deps.renderGroups();
            }
            return true;
        }

        const shareDelta = _getAssignmentShareDelta(leg, state, deps);
        if (Math.abs(shareDelta) < 0.0001) {
            return false;
        }

        const strike = parseFloat(leg.strike) || 0;
        const nextId = deps && typeof deps.generateId === 'function'
            ? deps.generateId()
            : ('_assignment_' + Math.random().toString(36).slice(2, 11));

        group.legs.push({
            id: nextId,
            type: 'stock',
            pos: shareDelta,
            strike: 0,
            expDate: '',
            iv: 0,
            ivSource: 'manual',
            ivManualOverride: false,
            currentPrice: 0.00,
            currentPriceSource: '',
            portfolioMarketPrice: null,
            portfolioMarketPriceSource: '',
            portfolioUnrealizedPnl: null,
            cost: strike,
            costSource: 'assignment_conversion',
            closePrice: null,
            underlyingFutureId: leg.underlyingFutureId || '',
            assignmentSourceLegId: leg.id,
        });

        leg.closePrice = 0;
        leg.closePriceSource = 'assignment_conversion';
        leg.assignmentUnderlyingLegId = nextId;
        leg.assignmentUnderlyingQuantity = shareDelta;

        if (deps && typeof deps.handleLiveSubscriptions === 'function') {
            deps.handleLiveSubscriptions();
        }
        if (deps && typeof deps.renderGroups === 'function') {
            deps.renderGroups();
        }
        return true;
    }

    function toggleGroupCollapse(btn) {
        const appBridge = globalScope.__optionComboApp;
        const groupCard = btn.closest('.group-card');

        if (groupCard && appBridge && typeof appBridge.getState === 'function' && typeof appBridge.renderGroups === 'function') {
            const state = appBridge.getState();
            const group = state.groups.find(entry => entry.id === groupCard.dataset.groupId);
            if (group) {
                group.isCollapsed = !group.isCollapsed;
                appBridge.renderGroups();
                return;
            }
        }

        const card = btn.closest('.panel-card');
        if (!card) return;

        const isCollapsed = card.classList.toggle('collapsed');
        const body = card.querySelector('.group-body');
        if (body) {
            body.hidden = isCollapsed;
        }

        btn.title = isCollapsed ? 'Expand Group' : 'Collapse Group';
        btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    }

    function addGroup(state, generateId, deps) {
        const newGroup = {
            id: generateId(),
            name: `Combo Group ${state.groups.length + 1}`,
            includedInGlobal: true,
            isCollapsed: false,
            livePriceMode: 'mark',
            settleUnderlyingPrice: null,
            historicalAutoCloseAtExpiry: true,
            tradeTrigger: _ensureTradeTrigger({}),
            closeExecution: _ensureCloseExecution({}),
            syncAvgCostFromPortfolio: true,
            legs: []
        };

        state.groups.push(newGroup);
        addLegToGroupById(state, newGroup.id, generateId, deps);
    }

    function removeGroup(state, groupId, deps) {
        state.groups = state.groups.filter(group => group.id !== groupId);
        deps.handleLiveSubscriptions();
        deps.renderGroups();
    }

    function addLegToGroupById(state, groupId, generateId, deps) {
        const group = state.groups.find(entry => entry.id === groupId);
        if (!group) return;

        group.legs.push({
            id: generateId(),
            type: 'call',
            pos: 1,
            strike: state.underlyingPrice,
            expDate: deps.addDays(getLegAnchorDate(state), 30),
            iv: 0.2,
            ivSource: 'manual',
            ivManualOverride: false,
            currentPrice: 0.00,
            currentPriceSource: '',
            portfolioMarketPrice: null,
            portfolioMarketPriceSource: '',
            portfolioUnrealizedPnl: null,
            cost: 0.00,
            closePrice: null,
            underlyingFutureId: ''
        });

        deps.renderGroups();
    }

    function addLegToGroup(state, buttonEl, generateId, deps) {
        const card = buttonEl.closest('.group-card');
        if (!card) return;

        addLegToGroupById(state, card.dataset.groupId, generateId, deps);
    }

    function removeLeg(state, groupId, legId, deps) {
        const group = state.groups.find(entry => entry.id === groupId);
        if (!group) return;

        group.legs = group.legs.filter(leg => leg.id !== legId);
        deps.handleLiveSubscriptions();
        deps.renderGroups();
    }

    function renderGroups(state, deps) {
        const container = document.getElementById('groupsContainer');
        const globalEmptyState = document.getElementById('globalEmptyState');
        const groupTemplate = document.getElementById('groupCardTemplate');
        const legTemplate = document.getElementById('legRowTemplate');
        if (!container || !globalEmptyState || !groupTemplate || !legTemplate) return;

        container.innerHTML = '';

        if (state.groups.length === 0) {
            globalEmptyState.style.display = 'block';
            document.getElementById('globalChartCard').style.display = 'none';
            document.getElementById('globalAmortizedCard').style.display = 'none';
            document.getElementById('probAnalysisCard').style.display = 'none';
            deps.updateDerivedValues();
            return;
        }

        globalEmptyState.style.display = 'none';
        document.getElementById('globalChartCard').style.display = 'block';
        document.getElementById('globalAmortizedCard').style.display = 'block';
        document.getElementById('probAnalysisCard').style.display = 'block';

        state.groups.forEach(group => {
            _ensureTradeTrigger(group);
            _ensureCloseExecution(group);
            _ensurePortfolioAvgCostSync(group);
            _ensureLivePriceMode(group);
            const clone = groupTemplate.content.cloneNode(true);
        const card = clone.querySelector('.group-card');
        card.dataset.groupId = group.id;

            applyCollapsedState(card, group);
            bindGroupHeader(card, group, state, deps);
            bindGroupLegs(card, group, state, legTemplate, deps);
            bindTrialTriggerControls(card, group, state, deps);
            bindCloseGroupControls(card, group, state, deps);
            applyModeLockState(card, group, state, deps);

            container.appendChild(card);
        });

        deps.updateDerivedValues();
    }

    function bindGroupHeader(card, group, state, deps) {
        if (deps.supportsAmortizedMode
            && !deps.supportsAmortizedMode(state.underlyingSymbol)
            && group.viewMode === 'amortized') {
            group.viewMode = 'settlement';
        }

        const nameInput = card.querySelector('.group-name-input');
        nameInput.value = group.name;
        nameInput.addEventListener('change', (e) => {
            group.name = e.target.value;
        });

        const trialTriggerToggleBtn = card.querySelector('.trial-trigger-toggle-btn');
        if (trialTriggerToggleBtn) {
            trialTriggerToggleBtn.addEventListener('click', () => {
                const trigger = _ensureTradeTrigger(group);
                if (!trigger) return;
                trigger.isExpanded = !trigger.isExpanded;
                deps.renderGroups();
            });
        }

        const closeGroupToggleBtn = card.querySelector('.close-group-toggle-btn');
        if (closeGroupToggleBtn) {
            closeGroupToggleBtn.addEventListener('click', () => {
                const closeExecution = _ensureCloseExecution(group);
                if (!closeExecution) return;
                closeExecution.isExpanded = !closeExecution.isExpanded;
                deps.renderGroups();
            });
        }

        const collapseToggleBtn = card.querySelector('.collapse-toggle-btn');
        if (collapseToggleBtn) {
            collapseToggleBtn.title = group.isCollapsed ? 'Expand Group' : 'Collapse Group';
            collapseToggleBtn.setAttribute('aria-expanded', group.isCollapsed ? 'false' : 'true');
        }

        const globalToggle = card.querySelector('.group-global-toggle');
        if (globalToggle) {
            globalToggle.checked = deps.isGroupIncludedInGlobal(group);
            globalToggle.addEventListener('change', (e) => {
                group.includedInGlobal = e.target.checked;
                deps.updateDerivedValues();
                if (typeof deps.updateProbCharts === 'function') {
                    deps.updateProbCharts();
                }
            });
        }

        const liveToggle = card.querySelector('.live-data-toggle');
        const avgCostSyncToggle = card.querySelector('.avg-cost-sync-toggle');
        const livePriceModeSelect = card.querySelector('.group-live-price-mode-select');
        const historicalEntryBtn = card.querySelector('.historical-entry-btn');
        const historicalEntryHint = card.querySelector('.historical-entry-hint');
        const isHistoricalMode = !!(state && state.marketDataMode === 'historical');
        const autoCloseExpiredAtExpiry = _ensureHistoricalAutoCloseAtExpiry(group);
        const hasOpenPosition = typeof deps.groupHasOpenPosition === 'function'
            ? deps.groupHasOpenPosition(group)
            : (group.legs || []).some((leg) => Math.abs(parseFloat(leg && leg.pos) || 0) > 0.0001);
        const hasLockedEntryCosts = _groupHasCostForAllPositionedLegs(group);
        liveToggle.checked = !!group.liveData;
        applyMarketDataToggleUi(state, group, liveToggle);
        liveToggle.addEventListener('change', (e) => {
            group.liveData = e.target.checked;
            applyMarketDataToggleUi(state, group, liveToggle);
            deps.handleLiveSubscriptions();
        });

        if (avgCostSyncToggle) {
            avgCostSyncToggle.checked = _ensurePortfolioAvgCostSync(group);
            avgCostSyncToggle.addEventListener('change', (e) => {
                group.syncAvgCostFromPortfolio = e.target.checked === true;
                if (group.syncAvgCostFromPortfolio && typeof deps.requestPortfolioAvgCostSnapshot === 'function') {
                    deps.requestPortfolioAvgCostSnapshot();
                }
            });
        }

        if (livePriceModeSelect) {
            livePriceModeSelect.value = _ensureLivePriceMode(group);
            livePriceModeSelect.title = 'Controls the Price column and Live P&L display only. Order pricing still uses the existing midpoint-based execution flow.';
            livePriceModeSelect.addEventListener('change', (e) => {
                group.livePriceMode = String(e.target.value || '').trim().toLowerCase() === 'midpoint'
                    ? 'midpoint'
                    : 'mark';
                e.target.value = group.livePriceMode;
                deps.updateDerivedValues();
            });
        }

        if (historicalEntryBtn) {
            const showHistoricalEntry = isHistoricalMode && hasOpenPosition && !hasLockedEntryCosts;
            historicalEntryBtn.style.display = showHistoricalEntry ? 'inline-flex' : 'none';
            historicalEntryBtn.disabled = !showHistoricalEntry;
            historicalEntryBtn.title = showHistoricalEntry
                ? 'Lock the current replay-day prices into Cost and move this group into Active mode.'
                : '';
            historicalEntryBtn.addEventListener('click', () => {
                if (typeof deps.enterHistoricalReplayGroup === 'function') {
                    deps.enterHistoricalReplayGroup(group);
                }
            });
        }

        if (historicalEntryHint) {
            const showHistoricalEntryHint = isHistoricalMode && !hasLockedEntryCosts;
            historicalEntryHint.style.display = showHistoricalEntryHint ? 'block' : 'none';
            historicalEntryHint.textContent = hasOpenPosition
                ? 'Lock the replay-day prices into Cost when you want this historical position to be considered opened.'
                : 'Add a non-zero leg to enable historical entry locking.';
        }

        applyViewModeState(card, group, deps.getRenderableGroupViewMode(group));

        const settleInput = card.querySelector('.group-settle-underlying-input');
        const historicalExpiryAutoCloseLabel = card.querySelector('.historical-expiry-auto-close-toggle');
        const historicalExpiryAutoCloseInput = card.querySelector('.group-historical-expiry-auto-close');
        const scenarioModeNote = card.querySelector('.scenario-mode-note');
        if (settleInput) {
            settleInput.value = group.settleUnderlyingPrice !== null && group.settleUnderlyingPrice !== undefined
                ? group.settleUnderlyingPrice.toFixed(2)
                : '';
            settleInput.disabled = isHistoricalMode && autoCloseExpiredAtExpiry;
            settleInput.title = isHistoricalMode && autoCloseExpiredAtExpiry
                ? 'Disable auto-close at expiry to enter a scenario underlying price for deliverable settlement analysis.'
                : 'Price of the underlying at expiration (leave empty to use current global price)';
            settleInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                group.settleUnderlyingPrice = isNaN(val) ? null : val;
                deps.updateDerivedValues();
            });
        }

        if (historicalExpiryAutoCloseLabel) {
            historicalExpiryAutoCloseLabel.style.display = isHistoricalMode ? 'inline-flex' : 'none';
        }

        if (historicalExpiryAutoCloseInput) {
            historicalExpiryAutoCloseInput.checked = autoCloseExpiredAtExpiry;
            historicalExpiryAutoCloseInput.addEventListener('change', (e) => {
                group.historicalAutoCloseAtExpiry = e.target.checked;
                if (typeof deps.syncHistoricalReplayExpirySettlement === 'function') {
                    deps.syncHistoricalReplayExpirySettlement(group);
                    return;
                }
                deps.renderGroups();
                deps.updateDerivedValues();
            });
        }

        if (scenarioModeNote) {
            scenarioModeNote.textContent = isHistoricalMode && autoCloseExpiredAtExpiry
                ? 'Expired historical legs will default to Close at the expiry-day replay price. Uncheck to model deliverable exercise/assignment with Scenario Underlying Price.'
                : 'Used by Amortized and Settlement modes for expired options without early close.';
        }

        card.querySelector('.remove-group-btn').addEventListener('click', () => {
            removeGroup(state, group.id, deps);
        });
    }

    function bindGroupLegs(card, group, state, legTemplate, deps) {
        const tbody = card.querySelector('.legsTableBody');
        const table = card.querySelector('table');
        const emptyState = card.querySelector('.group-empty-state');

        if (group.legs.length === 0) {
            table.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }

        table.style.display = 'table';
        emptyState.style.display = 'none';

        group.legs.forEach(leg => {
            const legClone = legTemplate.content.cloneNode(true);
            const tr = legClone.querySelector('tr');
            tr.dataset.id = leg.id;

            bindLegRow(tr, leg, group, state, deps);
            tbody.appendChild(tr);
        });
    }

    function bindTrialTriggerControls(card, group, state, deps) {
        const trigger = _ensureTradeTrigger(group);
        const container = card.querySelector('.trial-trigger-container');
        if (!container) return;

        const enabledInput = container.querySelector('.trial-trigger-enabled');
        const collapseBtn = container.querySelector('.trial-trigger-collapse-btn');
        const conditionInput = container.querySelector('.trial-trigger-condition');
        const priceInput = container.querySelector('.trial-trigger-price');
        const executionModeInput = container.querySelector('.trial-trigger-execution-mode');
        const repriceThresholdInput = container.querySelector('.trial-trigger-reprice-threshold');
        const concessionInput = container.querySelector('.trial-trigger-concession');
        const timeInForceInput = container.querySelector('.trial-trigger-tif');
        const exitEnabledInput = container.querySelector('.trial-trigger-exit-enabled');
        const exitConditionInput = container.querySelector('.trial-trigger-exit-condition');
        const exitPriceInput = container.querySelector('.trial-trigger-exit-price');
        const resetBtn = container.querySelector('.trial-trigger-reset-btn');
        const body = container.querySelector('.trial-trigger-body');
        const helpText = container.querySelector('.trial-trigger-help');

        if (!enabledInput || !collapseBtn || !conditionInput || !priceInput || !executionModeInput || !repriceThresholdInput || !concessionInput || !timeInForceInput || !exitEnabledInput || !exitConditionInput || !exitPriceInput || !resetBtn || !body) {
            return;
        }

        const isHistoricalMode = !!(state && state.marketDataMode === 'historical');
        const executionOptions = Array.from(executionModeInput.options || []);
        const previewOption = executionOptions.find((option) => option.value === 'preview');
        const testSubmitOption = executionOptions.find((option) => option.value === 'test_submit');
        const submitOption = executionOptions.find((option) => option.value === 'submit');

        if (previewOption) {
            previewOption.textContent = 'Preview Only';
        }
        if (testSubmitOption) {
            testSubmitOption.textContent = isHistoricalMode
                ? 'Simulated Test Submit'
                : 'Send to TWS (Test Only)';
        }
        if (submitOption) {
            submitOption.textContent = isHistoricalMode
                ? 'Simulated Submit'
                : 'Send to TWS';
        }

        enabledInput.checked = trigger.enabled;
        conditionInput.value = trigger.condition;
        priceInput.value = trigger.price !== null && trigger.price !== undefined
            ? Number(trigger.price).toFixed(2)
            : '';
        priceInput.disabled = trigger.enabled === true;
        priceInput.title = trigger.enabled
            ? 'Disable Trial Trigger before editing the trigger price.'
            : '';
        executionModeInput.value = trigger.executionMode;
        repriceThresholdInput.value = formatRepriceThresholdValue(trigger.repriceThreshold || 0.01);
        concessionInput.value = Number(trigger.concessionRatio || 0.0).toFixed(2);
        timeInForceInput.value = String(trigger.timeInForce || 'DAY').toUpperCase();
        exitEnabledInput.checked = trigger.exitEnabled === true;
        exitEnabledInput.disabled = trigger.enabled === true;
        exitConditionInput.value = trigger.exitCondition || 'lte';
        exitConditionInput.disabled = trigger.enabled === true || trigger.exitEnabled !== true;
        exitPriceInput.value = trigger.exitPrice !== null && trigger.exitPrice !== undefined
            ? Number(trigger.exitPrice).toFixed(2)
            : '';
        exitPriceInput.disabled = trigger.enabled === true || trigger.exitEnabled !== true;
        exitPriceInput.title = trigger.enabled
            ? 'Disable Trial Trigger before editing the exit condition.'
            : '';
        executionModeInput.title = isHistoricalMode
            ? 'Historical replay never routes orders to TWS. Submit modes only create a simulated order runtime from replay-day quotes.'
            : (state.allowLiveComboOrders
                ? ''
                : 'Global live combo order switch is OFF. TWS submit modes will not send orders until enabled.');
        if (helpText) {
            helpText.textContent = isHistoricalMode
                ? 'Only works when this group is in Trial mode and Historical Replay is enabled. Preview mode stays local, and submit modes only create a simulated order runtime from replay-day quotes.'
                : 'Only works when this group is in Trial mode and Live Market Data is enabled. Preview mode never sends orders.';
        }
        body.style.display = trigger.isCollapsed ? 'none' : 'block';
        collapseBtn.title = trigger.isCollapsed ? 'Expand Trial Trigger' : 'Collapse Trial Trigger';
        collapseBtn.setAttribute('aria-expanded', trigger.isCollapsed ? 'false' : 'true');

        collapseBtn.addEventListener('click', () => {
            trigger.isCollapsed = !trigger.isCollapsed;
            deps.renderGroups();
        });

        enabledInput.addEventListener('change', (e) => {
            trigger.enabled = e.target.checked === true;
            trigger.pendingRequest = false;
            trigger.status = trigger.enabled ? 'armed' : 'idle';
            trigger.lastError = '';
            deps.renderGroups();
        });

        conditionInput.addEventListener('change', (e) => {
            trigger.condition = e.target.value === 'lte' ? 'lte' : 'gte';
        });

        priceInput.addEventListener('input', (e) => {
            const parsed = parseFloat(e.target.value);
            trigger.price = Number.isFinite(parsed) ? parsed : null;
        });

        executionModeInput.addEventListener('change', (e) => {
            if (e.target.value === 'submit' || e.target.value === 'test_submit') {
                trigger.executionMode = e.target.value;
            } else {
                trigger.executionMode = 'preview';
            }
        });

        repriceThresholdInput.addEventListener('change', (e) => {
            const parsed = parseFloat(e.target.value);
            const validThresholds = (typeof OptionComboTradeTriggerLogic !== 'undefined'
                && Array.isArray(OptionComboTradeTriggerLogic.VALID_REPRICE_THRESHOLDS))
                ? OptionComboTradeTriggerLogic.VALID_REPRICE_THRESHOLDS
                : [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05];
            trigger.repriceThreshold = validThresholds.some(value => Math.abs(value - parsed) < 0.0001)
                ? parsed
                : 0.01;
            e.target.value = formatRepriceThresholdValue(trigger.repriceThreshold);
        });

        concessionInput.addEventListener('change', (e) => {
            const parsed = parseFloat(e.target.value);
            const validRatios = [0.0, 0.10, 0.20, 0.30, 0.50, 0.75];
            trigger.concessionRatio = validRatios.some(value => Math.abs(value - parsed) < 0.0001)
                ? parsed
                : 0.0;
            e.target.value = Number(trigger.concessionRatio).toFixed(2);
        });

        timeInForceInput.addEventListener('change', (e) => {
            const nextTif = String(e.target.value || '').trim().toUpperCase();
            const validTifs = (typeof OptionComboTradeTriggerLogic !== 'undefined'
                && Array.isArray(OptionComboTradeTriggerLogic.VALID_TIME_IN_FORCE))
                ? OptionComboTradeTriggerLogic.VALID_TIME_IN_FORCE
                : ['DAY', 'GTC'];
            trigger.timeInForce = validTifs.includes(nextTif) ? nextTif : 'DAY';
            e.target.value = trigger.timeInForce;
        });

        exitEnabledInput.addEventListener('change', (e) => {
            trigger.exitEnabled = e.target.checked === true;
            deps.renderGroups();
        });

        exitConditionInput.addEventListener('change', (e) => {
            trigger.exitCondition = e.target.value === 'gte' ? 'gte' : 'lte';
        });

        exitPriceInput.addEventListener('input', (e) => {
            const parsed = parseFloat(e.target.value);
            trigger.exitPrice = Number.isFinite(parsed) ? parsed : null;
        });

        resetBtn.addEventListener('click', () => {
            trigger.pendingRequest = false;
            trigger.enabled = false;
            trigger.status = 'idle';
            trigger.lastTriggeredAt = null;
            trigger.lastTriggerPrice = null;
            trigger.lastPreview = null;
            trigger.lastError = '';
            deps.renderGroups();
        });

        const handleContinueRepricing = (e) => {
            const continueBtn = e.target.closest('.trial-trigger-continue-repricing-btn');
            const concedeBtn = e.target.closest('.trial-trigger-concede-btn');
            const cancelBtn = e.target.closest('.trial-trigger-cancel-order-btn');
            if (!continueBtn && !concedeBtn && !cancelBtn) {
                return;
            }
            if (typeof e.preventDefault === 'function') {
                e.preventDefault();
            }
            if (continueBtn && typeof deps.requestContinueManagedComboOrder === 'function') {
                deps.requestContinueManagedComboOrder(group);
            } else if (concedeBtn && typeof deps.requestConcedeManagedComboOrder === 'function') {
                const concedeContainer = concedeBtn.closest('.trial-trigger-concede-group');
                const concedeSelect = concedeContainer
                    ? concedeContainer.querySelector('.trial-trigger-concede-select')
                    : null;
                const concedeValue = concedeSelect ? concedeSelect.value : concedeBtn.dataset.value;
                deps.requestConcedeManagedComboOrder(group, concedeValue);
            } else if (cancelBtn && typeof deps.requestCancelManagedComboOrder === 'function') {
                deps.requestCancelManagedComboOrder(group, 'manual_cancel');
            }
        };

        container.addEventListener('pointerdown', handleContinueRepricing);
        container.addEventListener('click', handleContinueRepricing);
    }

    function bindCloseGroupControls(card, group, state, deps) {
        const closeExecution = _ensureCloseExecution(group);
        const container = card.querySelector('.close-group-container');
        if (!container || !closeExecution) return;

        const executionModeInput = container.querySelector('.close-group-execution-mode');
        const thresholdInput = container.querySelector('.close-group-reprice-threshold');
        const concessionInput = container.querySelector('.close-group-concession');
        const timeInForceInput = container.querySelector('.close-group-tif');
        const submitBtn = container.querySelector('.close-group-submit-btn');
        const helpText = container.querySelector('.close-group-help');
        if (!executionModeInput || !thresholdInput || !concessionInput || !timeInForceInput || !submitBtn) {
            return;
        }

        const isHistoricalMode = state && state.marketDataMode === 'historical';
        const renderMode = deps.getRenderableGroupViewMode(group);
        const hasOpenPosition = typeof deps.groupHasOpenPosition === 'function'
            ? deps.groupHasOpenPosition(group)
            : (group.legs || []).some(leg => Math.abs(parseFloat(leg && leg.pos) || 0) > 0.0001);
        const hasLockedEntryCosts = _groupHasCostForAllPositionedLegs(group);
        const brokerStatus = String(closeExecution.lastPreview && closeExecution.lastPreview.status || '').trim();
        const isCompleted = brokerStatus === 'Filled';

        if (isHistoricalMode) {
            closeExecution.executionMode = 'preview';
        }
        executionModeInput.value = String(closeExecution.executionMode || 'preview');
        thresholdInput.value = formatRepriceThresholdValue(closeExecution.repriceThreshold || 0.01);
        concessionInput.value = Number(closeExecution.concessionRatio || 0.0).toFixed(2);
        timeInForceInput.value = String(closeExecution.timeInForce || 'DAY').toUpperCase();

        executionModeInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        thresholdInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        concessionInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        timeInForceInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        if (helpText) {
            helpText.textContent = isHistoricalMode
                ? 'Snapshots every open leg at the current replay day, writes those prices into Close, and switches the group into Settlement mode.'
                : 'Sends the reverse combo for all non-zero legs and reuses the managed middle-price negotiation flow.';
        }

        if (isCompleted) {
            submitBtn.style.display = 'none';
            submitBtn.disabled = true;
            submitBtn.title = 'This group is already fully closed.';
        } else {
            submitBtn.style.display = '';
        }

        if (isCompleted) {
            // Keep the filled summary visible, but remove any further close action affordance.
        } else if (!isHistoricalMode && renderMode !== 'active') {
            submitBtn.disabled = true;
            submitBtn.title = 'Close Group is only available when this group is in Active mode.';
        } else if (isHistoricalMode && !hasLockedEntryCosts) {
            submitBtn.disabled = true;
            submitBtn.title = 'Lock entry costs first with Enter @ Replay Day before settling this group.';
        } else if (!hasOpenPosition) {
            submitBtn.disabled = true;
            submitBtn.title = 'This group has no open position to close.';
        } else if (closeExecution.pendingRequest === true) {
            submitBtn.disabled = true;
            submitBtn.title = 'A close-group order request is already in progress.';
        } else {
            submitBtn.disabled = false;
            submitBtn.title = isHistoricalMode
                ? 'Close every open leg at the current historical replay price.'
                : (closeExecution.executionMode === 'preview'
                    ? 'Preview the reverse combo for all non-zero legs in this group.'
                    : 'Submit a managed combo order that reverses all non-zero legs in this group.');
        }

        submitBtn.textContent = isHistoricalMode
            ? 'Settle @ Replay Day'
            : (closeExecution.executionMode === 'preview'
                ? 'Preview Close'
                : (closeExecution.executionMode === 'test_submit' ? 'Send Test Close' : 'Close Group'));

        executionModeInput.addEventListener('change', (e) => {
            const nextMode = String(e.target.value || '').trim();
            closeExecution.executionMode = ['preview', 'test_submit', 'submit'].includes(nextMode)
                ? nextMode
                : 'preview';
            e.target.value = closeExecution.executionMode;
            deps.renderGroups();
        });

        thresholdInput.addEventListener('change', (e) => {
            const parsed = parseFloat(e.target.value);
            const validThresholds = (typeof OptionComboTradeTriggerLogic !== 'undefined'
                && Array.isArray(OptionComboTradeTriggerLogic.VALID_REPRICE_THRESHOLDS))
                ? OptionComboTradeTriggerLogic.VALID_REPRICE_THRESHOLDS
                : [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05];
            closeExecution.repriceThreshold = validThresholds.some(value => Math.abs(value - parsed) < 0.0001)
                ? parsed
                : 0.01;
            e.target.value = formatRepriceThresholdValue(closeExecution.repriceThreshold);
        });

        concessionInput.addEventListener('change', (e) => {
            const parsed = parseFloat(e.target.value);
            const validRatios = [0.0, 0.10, 0.20, 0.30, 0.50, 0.75];
            closeExecution.concessionRatio = validRatios.some(value => Math.abs(value - parsed) < 0.0001)
                ? parsed
                : 0.0;
            e.target.value = Number(closeExecution.concessionRatio).toFixed(2);
        });

        timeInForceInput.addEventListener('change', (e) => {
            const nextTif = String(e.target.value || '').trim().toUpperCase();
            const validTifs = (typeof OptionComboTradeTriggerLogic !== 'undefined'
                && Array.isArray(OptionComboTradeTriggerLogic.VALID_TIME_IN_FORCE))
                ? OptionComboTradeTriggerLogic.VALID_TIME_IN_FORCE
                : ['DAY', 'GTC'];
            closeExecution.timeInForce = validTifs.includes(nextTif) ? nextTif : 'DAY';
            e.target.value = closeExecution.timeInForce;
        });

        submitBtn.addEventListener('click', () => {
            if (typeof deps.requestCloseGroupComboOrder === 'function') {
                deps.requestCloseGroupComboOrder(group);
            }
        });

        const handleCloseGroupAction = (e) => {
            const continueBtn = e.target.closest('.trial-trigger-continue-repricing-btn');
            const concedeBtn = e.target.closest('.trial-trigger-concede-btn');
            const cancelBtn = e.target.closest('.trial-trigger-cancel-order-btn');
            if (!continueBtn && !concedeBtn && !cancelBtn) {
                return;
            }

            if (typeof e.preventDefault === 'function') {
                e.preventDefault();
            }

            if (continueBtn && typeof deps.requestContinueManagedComboOrder === 'function') {
                deps.requestContinueManagedComboOrder(group, 'closeExecution');
            } else if (concedeBtn && typeof deps.requestConcedeManagedComboOrder === 'function') {
                const concedeContainer = concedeBtn.closest('.trial-trigger-concede-group');
                const concedeSelect = concedeContainer
                    ? concedeContainer.querySelector('.trial-trigger-concede-select')
                    : null;
                const concedeValue = concedeSelect ? concedeSelect.value : concedeBtn.dataset.value;
                deps.requestConcedeManagedComboOrder(group, concedeValue, 'closeExecution');
            } else if (cancelBtn && typeof deps.requestCancelManagedComboOrder === 'function') {
                deps.requestCancelManagedComboOrder(group, 'manual_cancel', 'closeExecution');
            }
        };

        container.addEventListener('pointerdown', handleCloseGroupAction);
        container.addEventListener('click', handleCloseGroupAction);
    }

    function bindLegRow(tr, leg, group, state, deps) {
        const isStock = isUnderlyingLeg(leg);
        const supportsUnderlyingLegs = !deps.supportsUnderlyingLegs || deps.supportsUnderlyingLegs(state.underlyingSymbol);
        const pricingInputMode = getPricingInputMode(state.underlyingSymbol);
        const requiresPerLegFuture = pricingInputMode === 'FOP';

        const typeInput = tr.querySelector('.type-input');
        typeInput.value = leg.type;
        const stockOption = Array.from(typeInput.options || []).find(option => option.value === 'stock');
        if (stockOption) {
            stockOption.textContent = getUnderlyingLegLabel(state.underlyingSymbol);
        }
        if (stockOption && !supportsUnderlyingLegs && leg.type !== 'stock') {
            stockOption.disabled = true;
            stockOption.hidden = true;
        }
        typeInput.addEventListener('change', (e) => {
            const wasStock = isUnderlyingLeg(leg);
            const nowStock = isUnderlyingLeg(e.target.value);
            leg.type = e.target.value;

            if (nowStock && !wasStock) {
                leg.strike = 0;
                leg.expDate = '';
                leg.iv = 0;
                leg.ivSource = 'manual';
                leg.ivManualOverride = false;
            } else if (!nowStock && wasStock) {
                leg.strike = state.underlyingPrice;
                leg.expDate = deps.addDays(getLegAnchorDate(state), 30);
                leg.iv = 0.2;
                leg.ivSource = 'manual';
                leg.ivManualOverride = false;
            }

            deps.handleLiveSubscriptions();
            deps.renderGroups();
        });

        const posInput = tr.querySelector('.pos-input');
        posInput.value = leg.pos;
        posInput.addEventListener('input', (e) => {
            leg.pos = parseInt(e.target.value, 10) || 0;
            deps.updateDerivedValues();
        });

        const strikeInput = tr.querySelector('.strike-input');
        const dteInput = tr.querySelector('.dte-input');
        const ivInput = tr.querySelector('.iv-input');
        const underlyingFutureField = tr.querySelector('.fop-underlying-field');
        const underlyingFutureSelect = tr.querySelector('.fop-underlying-select');
        const underlyingFutureHint = tr.querySelector('.fop-underlying-hint');

        if (underlyingFutureField && underlyingFutureSelect) {
            const availableFutures = Array.isArray(state.futuresPool) ? state.futuresPool : [];
            const shouldShowFutureSelector = requiresPerLegFuture;

            underlyingFutureField.style.display = shouldShowFutureSelector ? 'block' : 'none';

            if (shouldShowFutureSelector) {
                underlyingFutureSelect.innerHTML = '';

                const placeholderOption = document.createElement('option');
                placeholderOption.value = '';
                placeholderOption.textContent = availableFutures.length > 0
                    ? 'Select future'
                    : 'Add future in Futures Pool first';
                underlyingFutureSelect.appendChild(placeholderOption);

                availableFutures.forEach((entry) => {
                    const option = document.createElement('option');
                    option.value = entry.id;
                    option.textContent = entry.contractMonth
                        ? `${state.underlyingSymbol} ${entry.contractMonth}`
                        : `${state.underlyingSymbol} (pending month)`;
                    underlyingFutureSelect.appendChild(option);
                });

                underlyingFutureSelect.disabled = availableFutures.length === 0;
                underlyingFutureSelect.value = leg.underlyingFutureId || '';
                if (!availableFutures.some(entry => entry.id === leg.underlyingFutureId)) {
                    leg.underlyingFutureId = '';
                    underlyingFutureSelect.value = '';
                }

                if (underlyingFutureHint) {
                    underlyingFutureHint.textContent = availableFutures.length > 0
                        ? 'Required for FOP legs.'
                        : 'Required for FOP legs. Add futures above first.';
                }

                underlyingFutureSelect.addEventListener('change', (e) => {
                    leg.underlyingFutureId = e.target.value || '';
                    deps.updateDerivedValues();
                    deps.handleLiveSubscriptions();
                });
            }
        }

        if (isStock) {
            strikeInput.style.visibility = 'hidden';
            dteInput.closest('div').style.visibility = 'hidden';
        } else {
            strikeInput.style.visibility = 'visible';
            dteInput.closest('div').style.visibility = 'visible';

            strikeInput.step = getPriceInputStep(state.underlyingSymbol);
            strikeInput.value = leg.strike;
            strikeInput.addEventListener('input', (e) => {
                leg.strike = parseFloat(e.target.value) || 0;
                deps.updateDerivedValues();
            });

            dteInput.value = leg.expDate;
            dteInput.addEventListener('change', (e) => {
                leg.expDate = e.target.value;
                deps.updateDerivedValues();
            });

            const ivDisplay = pricingCore && typeof pricingCore.describeLegIvInput === 'function'
                ? pricingCore.describeLegIvInput(leg)
                : {
                    value: `${(leg.iv * 100).toFixed(4)}%`,
                    title: 'Manual IV',
                };
            ivInput.value = ivDisplay.value;
            ivInput.title = ivDisplay.title;
            ivInput.addEventListener('focus', (e) => {
                if (leg.ivSource === 'missing' && String(e.target.value || '').trim().toUpperCase() === 'N/A') {
                    e.target.value = '';
                }
            });
            ivInput.addEventListener('input', (e) => {
                const parsed = parseIvPercentInput(e.target.value);
                if (!Number.isFinite(parsed)) {
                    return;
                }

                leg.iv = Math.max(parsed / 100.0, 0.001);
                leg.ivSource = 'manual';
                leg.ivManualOverride = true;
                deps.updateDerivedValues();
            });
            ivInput.addEventListener('change', (e) => {
                const parsed = parseIvPercentInput(e.target.value);
                if (!Number.isFinite(parsed)) {
                    const resetDisplay = pricingCore && typeof pricingCore.describeLegIvInput === 'function'
                        ? pricingCore.describeLegIvInput(leg)
                        : { value: `${(leg.iv * 100).toFixed(4)}%`, title: 'Manual IV' };
                    e.target.value = resetDisplay.value;
                    e.target.title = resetDisplay.title;
                    return;
                }

                leg.iv = Math.max(parsed / 100.0, 0.001);
                leg.ivSource = 'manual';
                leg.ivManualOverride = true;
                const nextDisplay = pricingCore && typeof pricingCore.describeLegIvInput === 'function'
                    ? pricingCore.describeLegIvInput(leg)
                    : { value: `${(leg.iv * 100).toFixed(4)}%`, title: 'Manual IV' };
                e.target.value = nextDisplay.value;
                e.target.title = nextDisplay.title;
                deps.updateDerivedValues();
            });
        }

        const currentPriceInput = tr.querySelector('.current-price-input');
        currentPriceInput.step = getPriceInputStep(state.underlyingSymbol);
        currentPriceInput.value = leg.currentPrice > 0 ? formatPriceInputValue(state.underlyingSymbol, leg.currentPrice) : '';
        currentPriceInput.addEventListener('input', (e) => {
            leg.currentPrice = parseFloat(e.target.value) || 0;
            leg.currentPriceSource = leg.currentPrice > 0 ? 'manual' : '';
            deps.updateDerivedValues();
        });

        const costInput = tr.querySelector('.cost-input');
        costInput.step = getPriceInputStep(state.underlyingSymbol);
        costInput.value = leg.cost > 0 ? formatPriceInputValue(state.underlyingSymbol, leg.cost) : '';
        costInput.addEventListener('input', (e) => {
            leg.cost = parseFloat(e.target.value) || 0;
            leg.costSource = 'manual';
            leg.executionReportedCost = false;
            delete leg.executionReportOrderId;
            delete leg.executionReportPermId;
            deps.updateDerivedValues();
        });

        const closePriceInput = tr.querySelector('.close-price-input');
        const closeLabel = tr.querySelector('.close-label');
        const assignmentBtn = tr.querySelector('.assignment-convert-btn');
        if (closePriceInput && closeLabel) {
            closePriceInput.style.display = 'block';
            closeLabel.style.display = 'block';
            closePriceInput.step = getPriceInputStep(state.underlyingSymbol);
            closePriceInput.value = leg.closePrice !== null && leg.closePrice !== undefined
                ? formatPriceInputValue(state.underlyingSymbol, leg.closePrice)
                : '';
            closePriceInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                leg.closePrice = isNaN(val) ? null : val;
                deps.updateDerivedValues();
            });
        }

        if (assignmentBtn) {
            const canConvert = _isAssignmentConvertible(group, leg, state, deps);
            assignmentBtn.style.visibility = canConvert ? 'visible' : 'hidden';
            assignmentBtn.disabled = !canConvert;
            if (canConvert) {
                assignmentBtn.textContent = _resolveAssignmentActionLabel(leg);
                assignmentBtn.title = leg.closePriceSource === 'assignment_conversion'
                    ? 'Undo this manual assignment/exercise conversion.'
                    : 'Convert this option leg into a deliverable underlying position at the strike, while preserving the option premium as realized cash flow.';
                assignmentBtn.addEventListener('click', () => {
                    applyOptionAssignmentConversion(group, leg, state, deps);
                });
            } else {
                assignmentBtn.title = '';
            }
        }

        tr.querySelector('.delete-btn').addEventListener('click', () => {
            removeLeg(state, group.id, leg.id, deps);
        });
    }

    function applyViewModeState(card, group, currentMode) {
        const toggleActiveBtn = card.querySelector('.toggle-view-active');
        const toggleTrialBtn = card.querySelector('.toggle-view-trial');
        const toggleAmortizedBtn = card.querySelector('.toggle-view-amortized');
        const toggleSettlementBtn = card.querySelector('.toggle-view-settlement');
        const settlementControls = card.querySelector('.settlement-controls');

        group.viewMode = currentMode;

        [toggleActiveBtn, toggleTrialBtn, toggleAmortizedBtn, toggleSettlementBtn].forEach(btn => {
            if (!btn) return;
            btn.classList.remove('active', 'btn-primary');
            btn.classList.add('btn-secondary');
        });

        if (currentMode === 'active' && toggleActiveBtn) {
            toggleActiveBtn.classList.remove('btn-secondary');
            toggleActiveBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'none';
            return;
        }

        if (currentMode === 'amortized' && toggleAmortizedBtn) {
            toggleAmortizedBtn.classList.remove('btn-secondary');
            toggleAmortizedBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'flex';
            return;
        }

        if (currentMode === 'settlement' && toggleSettlementBtn) {
            toggleSettlementBtn.classList.remove('btn-secondary');
            toggleSettlementBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'flex';
            return;
        }

        if (toggleTrialBtn) {
            toggleTrialBtn.classList.remove('btn-secondary');
            toggleTrialBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'none';
        }
    }

    function applyCollapsedState(card, group) {
        card.classList.toggle('collapsed', !!group.isCollapsed);
        const body = card.querySelector('.group-body');
        if (body) {
            body.hidden = !!group.isCollapsed;
        }

        const collapseToggleBtn = card.querySelector('.collapse-toggle-btn');
        if (collapseToggleBtn) {
            collapseToggleBtn.title = group.isCollapsed ? 'Expand Group' : 'Collapse Group';
            collapseToggleBtn.setAttribute('aria-expanded', group.isCollapsed ? 'false' : 'true');
        }
    }

    function applyModeLockState(card, group, state, deps) {
        const currentMode = deps.getRenderableGroupViewMode(group);
        const supportsAmortizedMode = !deps.supportsAmortizedMode || deps.supportsAmortizedMode(state.underlyingSymbol);
        const toggleActiveBtn = card.querySelector('.toggle-view-active');
        const toggleTrialBtn = card.querySelector('.toggle-view-trial');
        const toggleAmortizedBtn = card.querySelector('.toggle-view-amortized');
        const toggleSettlementBtn = card.querySelector('.toggle-view-settlement');

        [toggleActiveBtn, toggleTrialBtn, toggleAmortizedBtn, toggleSettlementBtn].forEach(btn => {
            if (!btn) return;
            btn.disabled = false;
            btn.title = '';
            btn.classList.remove('text-muted');
            btn.style.opacity = '';
        });

        if (!supportsAmortizedMode && toggleAmortizedBtn) {
            toggleAmortizedBtn.disabled = true;
            toggleAmortizedBtn.title = 'Amortized mode currently supports only equity-style deliverable underlyings.';
            toggleAmortizedBtn.classList.add('text-muted');
            toggleAmortizedBtn.style.opacity = '0.5';
        }

        if (deps.groupHasDeterministicCost(group) || currentMode === 'settlement') {
            return;
        }

        group.viewMode = 'trial';

        if (!toggleTrialBtn || !toggleActiveBtn || !toggleAmortizedBtn) return;

        toggleActiveBtn.disabled = true;
        toggleActiveBtn.title = 'Add a Cost to unlock Active tracking.';
        toggleActiveBtn.classList.add('text-muted');
        toggleActiveBtn.style.opacity = '0.5';

        toggleAmortizedBtn.disabled = true;
        toggleAmortizedBtn.title = 'Add a Cost to unlock Amortized analysis.';
        toggleAmortizedBtn.classList.add('text-muted');
        toggleAmortizedBtn.style.opacity = '0.5';

        toggleTrialBtn.classList.add('active', 'btn-primary');
        toggleTrialBtn.classList.remove('btn-secondary');
        toggleActiveBtn.classList.remove('active', 'btn-primary');
        toggleActiveBtn.classList.add('btn-secondary');
        toggleAmortizedBtn.classList.remove('active', 'btn-primary');
        toggleAmortizedBtn.classList.add('btn-secondary');
    }

    globalScope.OptionComboGroupEditorUI = {
        toggleGroupCollapse,
        addGroup,
        removeGroup,
        addLegToGroupById,
        addLegToGroup,
        removeLeg,
        renderGroups,
        applyModeLockState,
        applyOptionAssignmentConversion,
        bindTrialTriggerControls,
        bindCloseGroupControls,
    };
    globalScope.toggleGroupCollapse = toggleGroupCollapse;
})(typeof globalThis !== 'undefined' ? globalThis : window);
