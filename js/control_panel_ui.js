/**
 * Control panel event binding and sidebar interactions.
 */

(function attachControlPanelUI(globalScope) {
    let _boundState = null;
    let _boundDeps = null;

    function _getRegistry() {
        return typeof globalScope.OptionComboProductRegistry === 'undefined'
            ? null
            : globalScope.OptionComboProductRegistry;
    }

    function _getPricingInputMode(symbol) {
        const registry = _getRegistry();
        if (!registry || typeof registry.resolvePricingInputMode !== 'function') {
            return 'STK';
        }
        return registry.resolvePricingInputMode(symbol);
    }

    function _getPriceInputStep(symbol) {
        const registry = _getRegistry();
        if (!registry || typeof registry.getPriceInputStep !== 'function') {
            return '0.01';
        }
        return registry.getPriceInputStep(symbol);
    }

    function _formatPriceInputValue(symbol, value) {
        const registry = _getRegistry();
        if (!registry || typeof registry.formatPriceInputValue !== 'function') {
            const parsed = parseFloat(value);
            return Number.isFinite(parsed) ? parsed.toFixed(2) : '';
        }
        return registry.formatPriceInputValue(symbol, value);
    }

    function _formatPriceDisplayValue(symbol, value, options = {}) {
        const registry = _getRegistry();
        if (!registry || typeof registry.formatPriceDisplay !== 'function') {
            const parsed = parseFloat(value);
            if (!Number.isFinite(parsed)) {
                return Object.prototype.hasOwnProperty.call(options, 'fallback')
                    ? options.fallback
                    : '--';
            }
            const prefix = Object.prototype.hasOwnProperty.call(options, 'prefix')
                ? String(options.prefix ?? '')
                : '$';
            return `${prefix}${parsed.toFixed(2)}`;
        }
        return registry.formatPriceDisplay(symbol, value, options);
    }

    function _createLocalId(prefix) {
        return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    }

    function _getElement(id) {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
            return null;
        }
        return document.getElementById(id);
    }

    function _setHidden(element, hidden) {
        if (!element) return;
        element.hidden = !!hidden;
        if (element.style) {
            element.style.display = hidden ? 'none' : '';
        }
    }

    function _getMarketDataMode(state) {
        return state && state.marketDataMode === 'historical' ? 'historical' : 'live';
    }

    function _getWorkspaceVariant(state) {
        return state && (state.workspaceVariant === 'historical' || state.workspaceVariant === 'live')
            ? state.workspaceVariant
            : '';
    }

    function _isMarketDataModeLocked(state) {
        return state && state.marketDataModeLocked === true;
    }

    function _isHistoricalMode(state) {
        return _getMarketDataMode(state) === 'historical';
    }

    function _syncWorkspaceChrome(state) {
        if (typeof globalScope.OptionComboSessionUI === 'undefined'
            || typeof globalScope.OptionComboSessionUI.syncWorkspaceChrome !== 'function') {
            return;
        }
        globalScope.OptionComboSessionUI.syncWorkspaceChrome(state);
    }

    function _normalizeDateStr(value) {
        return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim())
            ? String(value).trim()
            : '';
    }

    function _compareDates(left, right) {
        const normalizedLeft = _normalizeDateStr(left);
        const normalizedRight = _normalizeDateStr(right);
        if (!normalizedLeft || !normalizedRight) {
            return 0;
        }
        return normalizedLeft.localeCompare(normalizedRight);
    }

    function _resolveHistoricalAvailableRange(state) {
        const availableStart = _normalizeDateStr(state && state.historicalAvailableStartDate);
        const availableEnd = _normalizeDateStr(state && state.historicalAvailableEndDate);
        let startDate = _normalizeDateStr(state && state.baseDate) || availableStart;
        let endDate = availableEnd || _normalizeDateStr(state && state.historicalQuoteDate) || startDate;

        if (availableStart && (!startDate || _compareDates(startDate, availableStart) < 0)) {
            startDate = availableStart;
        }
        if (availableEnd && startDate && _compareDates(startDate, availableEnd) > 0) {
            startDate = availableEnd;
        }
        if (startDate && endDate && _compareDates(endDate, startDate) < 0) {
            endDate = startDate;
        }

        return {
            startDate,
            endDate,
        };
    }

    function _buildHistoricalTimelineDates(state) {
        const { startDate, endDate } = _resolveHistoricalAvailableRange(state);
        if (!startDate || !endDate) {
            return [];
        }

        if (typeof OptionComboDateUtils !== 'undefined'
            && typeof OptionComboDateUtils.listTradingDays === 'function') {
            return OptionComboDateUtils.listTradingDays(startDate, endDate);
        }

        if (startDate === endDate) {
            return [startDate];
        }

        return [startDate, endDate];
    }

    function _coerceHistoricalReplayDate(state, requestedDate) {
        const requested = _normalizeDateStr(requestedDate);
        const timelineDates = _buildHistoricalTimelineDates(state);
        if (timelineDates.length === 0) {
            return requested || _normalizeDateStr(state && state.baseDate) || '';
        }

        if (!requested) {
            return timelineDates[0];
        }
        if (timelineDates.includes(requested)) {
            return requested;
        }

        for (let index = 0; index < timelineDates.length; index += 1) {
            if (_compareDates(timelineDates[index], requested) >= 0) {
                return timelineDates[index];
            }
        }

        return timelineDates[timelineDates.length - 1];
    }

    function _resolveHistoricalReplayDate(state) {
        return _coerceHistoricalReplayDate(
            state,
            _normalizeDateStr(state && state.historicalQuoteDate)
                || _normalizeDateStr(state && state.baseDate)
        );
    }

    function _coerceHistoricalSimulationDate(state, requestedDate) {
        const replayDate = _resolveHistoricalReplayDate(state) || _normalizeDateStr(state && state.baseDate) || '';
        const requested = _normalizeDateStr(requestedDate);
        if (!requested) {
            return replayDate;
        }
        if (replayDate && _compareDates(requested, replayDate) < 0) {
            return replayDate;
        }
        return requested;
    }

    function _getQuoteReferenceDate(state) {
        if (_isHistoricalMode(state)) {
            return _resolveHistoricalReplayDate(state) || _normalizeDateStr(state && state.baseDate) || '';
        }
        return _normalizeDateStr(state && state.baseDate) || _normalizeDateStr(state && state.simulatedDate) || '';
    }

    function _clearContainer(element) {
        if (!element) return;
        if (typeof element.replaceChildren === 'function') {
            element.replaceChildren();
            return;
        }
        if ('innerHTML' in element) {
            element.innerHTML = '';
        }
    }

    function _elementContains(container, target) {
        let node = target || null;
        while (node) {
            if (node === container) {
                return true;
            }
            node = node.parentElement || node.parentNode || null;
        }
        return false;
    }

    function _shouldPauseDynamicControlRefresh(containerId) {
        if (typeof document === 'undefined') {
            return false;
        }

        const container = _getElement(containerId);
        const activeElement = document.activeElement;
        if (!container || !activeElement || !_elementContains(container, activeElement)) {
            return false;
        }

        const tagName = String(activeElement.tagName || '').toUpperCase();
        return tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA';
    }

    function _formatQuoteValue(value, symbol) {
        return _formatPriceDisplayValue(symbol, value, {
            prefix: '',
            fallback: '--',
        });
    }

    function _formatForwardRateTimestamp(value) {
        const raw = String(value || '').trim();
        if (!raw) {
            return '';
        }

        const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
        if (isoMatch) {
            return `${isoMatch[1].slice(5)} ${isoMatch[2]}`;
        }

        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
            return raw;
        }

        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        const hours = String(parsed.getHours()).padStart(2, '0');
        const minutes = String(parsed.getMinutes()).padStart(2, '0');
        return `${month}-${day} ${hours}:${minutes}`;
    }

    function _hasComputedForwardRate(sample) {
        return sample
            && sample.isStale !== true
            && sample.dailyCarry !== null
            && sample.dailyCarry !== undefined
            && Number.isFinite(parseFloat(sample.dailyCarry));
    }

    function _describeForwardRateSampleState(sample, sampleRuntime) {
        if (sample && sample.isStale === true) {
            return 'Stale';
        }

        if (_hasComputedForwardRate(sample)) {
            return 'Ready';
        }

        const callQuote = sampleRuntime && sampleRuntime.callQuote;
        const putQuote = sampleRuntime && sampleRuntime.putQuote;
        if (callQuote && putQuote) {
            return 'Waiting';
        }
        if (callQuote || putQuote) {
            return 'Partial';
        }
        return 'Waiting';
    }

    function _renderForwardRateStatus(state) {
        const status = _getElement('forwardRateStatus');
        if (!status) return;

        const samples = Array.isArray(state.forwardRateSamples) ? state.forwardRateSamples : [];
        if (samples.length === 0) {
            status.textContent = 'Add one or more reference samples to derive market-implied daily carry.';
            return;
        }

        const staleCount = samples.filter(sample => sample && sample.isStale === true).length;
        const readyCount = samples.filter(_hasComputedForwardRate).length;
        const pendingCount = Math.max(0, samples.length - readyCount - staleCount);

        if (readyCount === samples.length) {
            status.textContent = `Forward Carry ready for ${readyCount}/${samples.length} sample${samples.length === 1 ? '' : 's'}.`;
            return;
        }

        if (readyCount > 0 || staleCount > 0) {
            const fragments = [`Forward Carry ready for ${readyCount}/${samples.length} sample${samples.length === 1 ? '' : 's'}.`];
            if (pendingCount > 0) {
                fragments.push(`${pendingCount} waiting for live quotes.`);
            }
            if (staleCount > 0) {
                fragments.push(`${staleCount} stale.`);
            }
            status.textContent = fragments.join(' ');
            return;
        }

        status.textContent = `Waiting for live call/put quotes to compute Forward Carry for ${samples.length} sample${samples.length === 1 ? '' : 's'}.`;
    }

    function _syncForwardRatePanelCollapseUi(state, showPanel) {
        const toggleBtn = _getElement('toggleForwardRatePanelBtn');
        const header = _getElement('forwardRateSamplesHeader');
        const list = _getElement('forwardRateSamplesList');
        const status = _getElement('forwardRateStatus');
        const collapsed = !!(state && state.forwardRatePanelCollapsed === true);

        if (toggleBtn) {
            _setHidden(toggleBtn, !showPanel);
            toggleBtn.textContent = collapsed ? 'Show' : 'Hide';
            toggleBtn.title = collapsed
                ? 'Expand Forward Carry samples'
                : 'Collapse Forward Carry samples';
        }

        _setHidden(header, !showPanel || collapsed);
        _setHidden(list, !showPanel || collapsed);

        if (status && status.style) {
            status.style.marginBottom = collapsed ? '0' : '0.5rem';
        }
    }

    function _syncFuturesPoolPanelCollapseUi(state, showPanel) {
        const toggleBtn = _getElement('toggleFuturesPoolPanelBtn');
        const header = _getElement('futuresPoolHeader');
        const list = _getElement('futuresPoolList');
        const status = _getElement('futuresPoolStatus');
        const collapsed = !!(state && state.futuresPoolPanelCollapsed === true);

        if (toggleBtn) {
            _setHidden(toggleBtn, !showPanel);
            toggleBtn.textContent = collapsed ? 'Show' : 'Hide';
            toggleBtn.title = collapsed
                ? 'Expand Futures Pool contracts'
                : 'Collapse Futures Pool contracts';
        }

        _setHidden(header, !showPanel || collapsed);
        _setHidden(list, !showPanel || collapsed);

        if (status && status.style) {
            status.style.marginBottom = collapsed ? '0' : '0.5rem';
        }
    }

    function _renderFuturesPoolStatus(state) {
        const status = _getElement('futuresPoolStatus');
        if (!status) return;

        const entries = Array.isArray(state.futuresPool) ? state.futuresPool : [];
        if (entries.length === 0) {
            status.textContent = 'Add one or more futures contracts. Each FOP leg will be required to pick one.';
            return;
        }

        const configuredEntries = entries.filter(entry => /^\d{6}$/.test(String(entry && entry.contractMonth || ''))).length;
        const quotedEntries = entries.filter((entry) => {
            const bid = parseFloat(entry && entry.bid);
            const ask = parseFloat(entry && entry.ask);
            const mark = parseFloat(entry && entry.mark);
            return (Number.isFinite(bid) && bid > 0)
                || (Number.isFinite(ask) && ask > 0)
                || (Number.isFinite(mark) && mark > 0);
        }).length;

        const contractLabel = `futures contract${entries.length === 1 ? '' : 's'}`;
        if (configuredEntries === 0) {
            status.textContent = `Enter YYYYMM contract months to configure ${entries.length} ${contractLabel}.`;
            return;
        }

        status.textContent = `${configuredEntries}/${entries.length} ${contractLabel} configured; ${quotedEntries}/${configuredEntries} quoted.`;
    }

    function _renderForwardRateSamples(state, deps) {
        const panel = _getElement('forwardRatePanel');
        const list = _getElement('forwardRateSamplesList');
        const addBtn = _getElement('addForwardRateSampleBtn');
        const toggleBtn = _getElement('toggleForwardRatePanelBtn');
        const showPanel = _getPricingInputMode(state.underlyingSymbol) === 'INDEX';

        if (typeof state.forwardRatePanelCollapsed !== 'boolean') {
            state.forwardRatePanelCollapsed = false;
        }

        _setHidden(panel, !showPanel);
        _renderForwardRateStatus(state);
        _syncForwardRatePanelCollapseUi(state, showPanel);

        if (addBtn && typeof addBtn.addEventListener === 'function' && addBtn.__forwardRateBound !== true) {
            addBtn.__forwardRateBound = true;
            addBtn.addEventListener('click', () => {
                if (!Array.isArray(state.forwardRateSamples)) {
                    state.forwardRateSamples = [];
                }
                state.forwardRatePanelCollapsed = false;
                state.forwardRateSamples.push({
                    id: typeof deps.generateId === 'function' ? deps.generateId() : _createLocalId('forward'),
                    daysToExpiry: 30,
                    expDate: typeof deps.addDays === 'function' ? deps.addDays(state.baseDate, 30) : '',
                    strike: state.underlyingPrice,
                    dailyCarry: null,
                    impliedRate: null,
                    lastComputedAt: null,
                    isStale: false,
                });
                _renderForwardRateSamples(state, deps);
                if (typeof deps.updateDerivedValues === 'function') {
                    deps.updateDerivedValues();
                }
                if (typeof deps.handleLiveSubscriptions === 'function') {
                    deps.handleLiveSubscriptions();
                }
            });
        }

        if (toggleBtn && typeof toggleBtn.addEventListener === 'function' && toggleBtn.__forwardRateToggleBound !== true) {
            toggleBtn.__forwardRateToggleBound = true;
            toggleBtn.addEventListener('click', () => {
                state.forwardRatePanelCollapsed = !state.forwardRatePanelCollapsed;
                _renderForwardRateSamples(state, deps);
            });
        }

        if (!showPanel || !list || typeof document === 'undefined' || typeof document.createElement !== 'function' || typeof list.appendChild !== 'function') {
            return;
        }

        if (state.forwardRatePanelCollapsed === true) {
            return;
        }

        _clearContainer(list);

        (state.forwardRateSamples || []).forEach((sample, index) => {
            const row = document.createElement('div');
            row.className = 'dynamic-config-row';
            row.style.display = 'grid';
            row.style.gridTemplateColumns = '72px minmax(0, 1fr) minmax(0, 1fr)';
            row.style.gridTemplateAreas = '"days expiry strike" "meta meta action"';
            row.style.gap = '0.5rem';
            row.style.alignItems = 'center';
            row.style.marginTop = index === 0 ? '0' : '0.5rem';

            const daysInput = document.createElement('input');
            daysInput.type = 'number';
            daysInput.className = 'number-input';
            daysInput.style.gridArea = 'days';
            daysInput.style.minWidth = '0';
            daysInput.min = '0';
            daysInput.step = '1';
            daysInput.value = String(sample.daysToExpiry || 0);
            daysInput.title = 'Reference tenor in calendar days.';
            daysInput.addEventListener('change', (e) => {
                const parsed = Math.max(0, parseInt(e.target.value, 10) || 0);
                sample.daysToExpiry = parsed;
                if (typeof deps.addDays === 'function') {
                    sample.expDate = parsed > 0 ? deps.addDays(state.baseDate, parsed) : '';
                }
                sample.isStale = sample.dailyCarry !== null || sample.impliedRate !== null;
                _renderForwardRateSamples(state, deps);
                if (typeof deps.updateDerivedValues === 'function') {
                    deps.updateDerivedValues();
                }
                if (typeof deps.handleLiveSubscriptions === 'function') {
                    deps.handleLiveSubscriptions();
                }
            });

            const expiryInput = document.createElement('input');
            expiryInput.type = 'date';
            expiryInput.className = 'number-input';
            expiryInput.style.gridArea = 'expiry';
            expiryInput.style.minWidth = '0';
            expiryInput.value = sample.expDate || '';
            expiryInput.title = 'Reference option expiry used for the carry sample.';
            expiryInput.addEventListener('change', (e) => {
                sample.expDate = e.target.value;
                if (typeof deps.diffDays === 'function' && sample.expDate) {
                    sample.daysToExpiry = Math.max(0, deps.diffDays(state.baseDate, sample.expDate));
                }
                sample.isStale = sample.dailyCarry !== null || sample.impliedRate !== null;
                _renderForwardRateSamples(state, deps);
                if (typeof deps.updateDerivedValues === 'function') {
                    deps.updateDerivedValues();
                }
                if (typeof deps.handleLiveSubscriptions === 'function') {
                    deps.handleLiveSubscriptions();
                }
            });

            const strikeInput = document.createElement('input');
            strikeInput.type = 'number';
            strikeInput.className = 'number-input';
            strikeInput.style.gridArea = 'strike';
            strikeInput.style.minWidth = '0';
            strikeInput.step = '0.01';
            strikeInput.placeholder = 'Strike';
            strikeInput.value = sample.strike !== null && sample.strike !== undefined ? String(sample.strike) : '';
            strikeInput.title = 'ATM-nearby strike to subscribe for the parity sample.';
            strikeInput.addEventListener('change', (e) => {
                const parsed = parseFloat(e.target.value);
                sample.strike = Number.isFinite(parsed) ? parsed : null;
                sample.isStale = sample.dailyCarry !== null || sample.impliedRate !== null;
                _renderForwardRateSamples(state, deps);
                if (typeof deps.updateDerivedValues === 'function') {
                    deps.updateDerivedValues();
                }
                if (typeof deps.handleLiveSubscriptions === 'function') {
                    deps.handleLiveSubscriptions();
                }
            });

            const meta = document.createElement('div');
            meta.className = 'text-muted small';
            meta.style.gridArea = 'meta';
            meta.style.minWidth = '0';
            meta.style.lineHeight = '1.25';
            meta.style.wordBreak = 'break-word';
            const sampleRuntime = typeof OptionComboIndexForwardRate !== 'undefined'
                && typeof OptionComboIndexForwardRate.refreshForwardRateSample === 'function'
                && typeof OptionComboWsLiveQuotes !== 'undefined'
                ? OptionComboIndexForwardRate.refreshForwardRateSample(sample, state, OptionComboWsLiveQuotes)
                : null;
            const snapshot = sampleRuntime && sampleRuntime.snapshot;
            const statusLabel = _describeForwardRateSampleState(sample, sampleRuntime);
            const carryText = sample.dailyCarry !== null && sample.dailyCarry !== undefined
                ? `daily=${Number(sample.dailyCarry).toFixed(6)}`
                : 'daily=--';
            const impliedRateText = sample.impliedRate !== null && sample.impliedRate !== undefined
                ? `annual=${(Number(sample.impliedRate) * 100).toFixed(2)}%`
                : '';
            const timestampText = _formatForwardRateTimestamp(sample.lastComputedAt);
            const summarySegments = [carryText];
            if (impliedRateText) {
                summarySegments.push(impliedRateText);
            }
            if (timestampText) {
                summarySegments.push(`@ ${timestampText}`);
            }
            const metaSegments = [statusLabel];
            if (snapshot) {
                metaSegments.push(`C=${snapshot.callMid.toFixed(2)} P=${snapshot.putMid.toFixed(2)} F~${snapshot.syntheticForward.toFixed(2)}`);
            }
            metaSegments.push(summarySegments.join(' '));
            meta.textContent = metaSegments.join(' | ');
            meta.title = sample.lastComputedAt ? `Last computed ${sample.lastComputedAt}` : '';

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn btn-secondary btn-sm';
            removeBtn.style.gridArea = 'action';
            removeBtn.style.justifySelf = 'end';
            removeBtn.style.alignSelf = 'start';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => {
                state.forwardRateSamples = (state.forwardRateSamples || []).filter(entry => entry.id !== sample.id);
                _renderForwardRateSamples(state, deps);
                if (typeof deps.updateDerivedValues === 'function') {
                    deps.updateDerivedValues();
                }
                if (typeof deps.handleLiveSubscriptions === 'function') {
                    deps.handleLiveSubscriptions();
                }
            });

            row.appendChild(daysInput);
            row.appendChild(expiryInput);
            row.appendChild(strikeInput);
            row.appendChild(meta);
            row.appendChild(removeBtn);
            list.appendChild(row);
        });
    }

    function _renderFuturesPool(state, deps) {
        const panel = _getElement('futuresPoolPanel');
        const list = _getElement('futuresPoolList');
        const addBtn = _getElement('addFutureContractBtn');
        const toggleBtn = _getElement('toggleFuturesPoolPanelBtn');
        const showPanel = _getPricingInputMode(state.underlyingSymbol) === 'FOP';

        if (typeof state.futuresPoolPanelCollapsed !== 'boolean') {
            state.futuresPoolPanelCollapsed = false;
        }

        _setHidden(panel, !showPanel);
        _renderFuturesPoolStatus(state);
        _syncFuturesPoolPanelCollapseUi(state, showPanel);

        if (addBtn && typeof addBtn.addEventListener === 'function' && addBtn.__futuresPoolBound !== true) {
            addBtn.__futuresPoolBound = true;
            addBtn.addEventListener('click', () => {
                if (!Array.isArray(state.futuresPool)) {
                    state.futuresPool = [];
                }
                state.futuresPoolPanelCollapsed = false;
                state.futuresPool.push({
                    id: typeof deps.generateId === 'function' ? deps.generateId() : _createLocalId('future'),
                    contractMonth: '',
                    bid: null,
                    ask: null,
                    mark: null,
                    lastQuotedAt: null,
                });
                _renderFuturesPool(state, deps);
                if (typeof deps.handleLiveSubscriptions === 'function') {
                    deps.handleLiveSubscriptions();
                }
            });
        }

        if (toggleBtn && typeof toggleBtn.addEventListener === 'function' && toggleBtn.__futuresPoolToggleBound !== true) {
            toggleBtn.__futuresPoolToggleBound = true;
            toggleBtn.addEventListener('click', () => {
                state.futuresPoolPanelCollapsed = !state.futuresPoolPanelCollapsed;
                _renderFuturesPool(state, deps);
            });
        }

        if (!showPanel || !list || typeof document === 'undefined' || typeof document.createElement !== 'function' || typeof list.appendChild !== 'function') {
            return;
        }

        if (state.futuresPoolPanelCollapsed === true) {
            return;
        }

        const entries = Array.isArray(state.futuresPool) ? state.futuresPool : [];
        const structureKey = entries.map(entry => String(entry && entry.id || '')).join('|');
        const canPatchInPlace = list.__futuresPoolStructureKey === structureKey
            && Array.isArray(list.children)
            && list.children.length === entries.length;

        if (canPatchInPlace) {
            entries.forEach((entry, index) => {
                const row = list.children[index];
                if (!row || row.__futureEntryId !== entry.id) {
                    return;
                }

                const contractMonthInput = row.__contractMonthInput;
                const quoteDisplay = row.__quoteDisplay;
                if (contractMonthInput && document.activeElement !== contractMonthInput) {
                    contractMonthInput.value = entry.contractMonth || '';
                }
                if (quoteDisplay) {
                    quoteDisplay.textContent = `Bid ${_formatQuoteValue(entry.bid, state.underlyingSymbol)} / Ask ${_formatQuoteValue(entry.ask, state.underlyingSymbol)} / Mark ${_formatQuoteValue(entry.mark, state.underlyingSymbol)}`;
                }
            });
            return;
        }

        _clearContainer(list);
        list.__futuresPoolStructureKey = structureKey;

        entries.forEach((entry, index) => {
            const row = document.createElement('div');
            row.className = 'dynamic-config-row';
            row.style.display = 'grid';
            row.style.gridTemplateColumns = '120px minmax(0, 1fr) 28px';
            row.style.gap = '0.5rem';
            row.style.alignItems = 'center';
            row.style.marginTop = index === 0 ? '0' : '0.5rem';
            row.__futureEntryId = entry.id;

            const contractMonthInput = document.createElement('input');
            contractMonthInput.type = 'text';
            contractMonthInput.className = 'number-input';
            contractMonthInput.placeholder = 'YYYYMM';
            contractMonthInput.value = entry.contractMonth || '';
            contractMonthInput.title = 'Underlying futures contract month.';
            contractMonthInput.addEventListener('change', (e) => {
                entry.contractMonth = String(e.target.value || '').replace(/\D/g, '').slice(0, 6);
                contractMonthInput.value = entry.contractMonth;
                _renderFuturesPool(state, deps);
                if (typeof deps.handleLiveSubscriptions === 'function') {
                    deps.handleLiveSubscriptions();
                }
                if (typeof deps.renderGroups === 'function') {
                    deps.renderGroups();
                } else if (typeof deps.updateDerivedValues === 'function') {
                    deps.updateDerivedValues();
                }
            });

            const quoteDisplay = document.createElement('div');
            quoteDisplay.className = 'text-muted small';
            quoteDisplay.style.lineHeight = '1.25';
            quoteDisplay.textContent = `Bid ${_formatQuoteValue(entry.bid, state.underlyingSymbol)} / Ask ${_formatQuoteValue(entry.ask, state.underlyingSymbol)} / Mark ${_formatQuoteValue(entry.mark, state.underlyingSymbol)}`;
            row.__quoteDisplay = quoteDisplay;

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'icon-btn text-danger';
            removeBtn.title = 'Remove future contract';
            if (typeof removeBtn.setAttribute === 'function') {
                removeBtn.setAttribute('aria-label', 'Remove future contract');
            }
            removeBtn.style.width = '28px';
            removeBtn.style.height = '28px';
            removeBtn.style.display = 'inline-flex';
            removeBtn.style.alignItems = 'center';
            removeBtn.style.justifyContent = 'center';
            removeBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                    <path d="M10 11v6"></path>
                    <path d="M14 11v6"></path>
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
                </svg>
            `;
            removeBtn.addEventListener('click', () => {
                state.futuresPool = (state.futuresPool || []).filter(poolEntry => poolEntry.id !== entry.id);
                (state.groups || []).forEach(group => {
                    (group.legs || []).forEach(leg => {
                        if (leg.underlyingFutureId === entry.id) {
                            leg.underlyingFutureId = '';
                        }
                    });
                });
                _renderFuturesPool(state, deps);
                if (typeof deps.renderGroups === 'function') {
                    deps.renderGroups();
                } else if (typeof deps.updateDerivedValues === 'function') {
                    deps.updateDerivedValues();
                }
                if (typeof deps.handleLiveSubscriptions === 'function') {
                    deps.handleLiveSubscriptions();
                }
            });

            row.__contractMonthInput = contractMonthInput;
            row.appendChild(contractMonthInput);
            row.appendChild(quoteDisplay);
            row.appendChild(removeBtn);
            list.appendChild(row);
        });
    }

    function _resolveDefaultUnderlyingContractMonth(state) {
        const registry = _getRegistry();
        if (!registry || typeof registry.resolveDefaultUnderlyingContractMonth !== 'function') {
            return '';
        }
        return registry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            _getQuoteReferenceDate(state)
        );
    }

    function _syncUnderlyingContractMonthUI(state, forceReset) {
        const underlyingContractMonthInput = _getElement('underlyingContractMonth');
        const underlyingContractMonthHint = _getElement('underlyingContractMonthHint');
        if (!underlyingContractMonthInput) return;

        const registry = _getRegistry();
        const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
            ? registry.resolveUnderlyingProfile(state.underlyingSymbol)
            : null;
        const expectsFutureUnderlying = profile?.underlyingSecType === 'FUT';
        const defaultContractMonth = expectsFutureUnderlying ? _resolveDefaultUnderlyingContractMonth(state) : '';

        if (!expectsFutureUnderlying) {
            state.underlyingContractMonth = '';
            underlyingContractMonthInput.value = '';
            underlyingContractMonthInput.placeholder = 'N/A for STK / IND';
            underlyingContractMonthInput.disabled = true;
            if (underlyingContractMonthHint) {
                underlyingContractMonthHint.textContent = 'Not used for stocks or cash-settled index options.';
            }
            return;
        }

        if (forceReset || !state.underlyingContractMonth) {
            state.underlyingContractMonth = defaultContractMonth;
        }

        const isEditingThisInput = typeof document !== 'undefined'
            && document.activeElement === underlyingContractMonthInput;

        underlyingContractMonthInput.disabled = false;
        if (!isEditingThisInput) {
            underlyingContractMonthInput.placeholder = defaultContractMonth || 'YYYYMM';
            underlyingContractMonthInput.value = state.underlyingContractMonth || '';
        }

        if (underlyingContractMonthHint) {
            underlyingContractMonthHint.textContent = 'Legacy shared FOP underlying month. Futures Pool + per-leg future binding will replace this for multi-expiry setups.';
        }
    }

    function _syncInterestRateUI(state) {
        const irInput = _getElement('interestRate');
        const irDisplay = _getElement('interestRateDisplay');
        if (!irInput) return;

        const parsedRate = parseFloat(state && state.interestRate);
        const pct = Number.isFinite(parsedRate) ? parsedRate * 100 : 0;
        irInput.value = pct.toFixed(2);
        if (irDisplay) {
            irDisplay.textContent = `${pct.toFixed(2)}%`;
        }

        const mode = _getPricingInputMode(state.underlyingSymbol);
        const controlGroup = typeof irInput.closest === 'function' ? irInput.closest('.control-group') : null;

        irInput.disabled = mode !== 'STK';
        if (controlGroup && controlGroup.style) {
            controlGroup.style.opacity = mode === 'STK' ? '' : '0.45';
        }

        if (mode === 'INDEX') {
            irInput.title = 'INDEX pricing will come from Forward Carry samples. Manual rate entry is disabled for this family.';
        } else if (mode === 'FOP') {
            irInput.title = 'FOP pricing will come from the selected underlying futures. Manual rate entry is disabled for this family.';
        } else {
            irInput.title = '';
        }

        if (irDisplay) {
            irDisplay.title = irInput.title;
        }
    }

    function _syncMarketDataModeUI(state) {
        const mode = _getMarketDataMode(state);
        const workspaceVariant = _getWorkspaceVariant(state);
        const isLocked = _isMarketDataModeLocked(state);
        const modeInput = _getElement('marketDataMode');
        const modeHint = _getElement('marketDataModeHint');
        const historicalQuoteDateGroup = _getElement('historicalQuoteDateGroup');
        const historicalQuoteDateInput = _getElement('historicalQuoteDate');
        const historicalQuoteDateLabel = _getElement('historicalQuoteDateLabel');
        const historicalQuoteDateHint = _getElement('historicalQuoteDateHint');
        const historicalReplayDateGroup = _getElement('historicalReplayDateGroup');
        const historicalReplayDateInput = _getElement('historicalReplayDate');
        const historicalReplayDateLabel = _getElement('historicalReplayDateLabel');
        const historicalTimelineControls = _getElement('historicalTimelineControls');
        const historicalTimelineHint = _getElement('historicalTimelineHint');
        const simulatedDateLabel = _getElement('simulatedDateLabel');
        const simulatedDateStartLabel = _getElement('simulatedDateStartLabel');
        const simulatedDateHint = _getElement('simulatedDateHint');
        const simulatedDateOffsetGroup = _getElement('simulatedDateOffsetGroup');
        const allowLiveComboOrdersInput = _getElement('allowLiveComboOrders');

        if (modeInput) {
            modeInput.value = mode;
            modeInput.disabled = isLocked;
            modeInput.title = isLocked
                ? 'This workspace entry locks the market-data environment.'
                : '';
        }

        if (modeHint) {
            if (workspaceVariant === 'historical' && isLocked) {
                modeHint.textContent = 'Historical replay workspace is locked to SQLite replay only. Real IBKR execution is unavailable here.';
            } else if (workspaceVariant === 'live' && isLocked) {
                modeHint.textContent = 'Live trading workspace is locked to Production / Live IBKR. Treat this page as real-market context.';
            } else {
                modeHint.textContent = 'Live mode uses IBKR market data and can route real orders. Historical mode replays quotes from SQLite and blocks real execution.';
            }
        }

        _setHidden(historicalQuoteDateGroup, mode !== 'historical');
        if (historicalQuoteDateLabel) {
            historicalQuoteDateLabel.textContent = 'Historical Start Date';
        }
        if (historicalQuoteDateInput) {
            historicalQuoteDateInput.value = mode === 'historical' ? (state.baseDate || '') : '';
        }
        if (historicalQuoteDateHint) {
            historicalQuoteDateHint.textContent = mode === 'historical'
                ? 'Sets the historical entry day. Replay Date below moves forward from here.'
                : '';
        }
        _setHidden(historicalReplayDateGroup, mode !== 'historical');
        if (historicalReplayDateLabel) {
            historicalReplayDateLabel.textContent = 'Replay Date';
        }
        if (historicalReplayDateInput) {
            historicalReplayDateInput.value = mode === 'historical'
                ? (_resolveHistoricalReplayDate(state) || state.baseDate || '')
                : '';
        }
        _setHidden(historicalTimelineControls, mode !== 'historical');
        if (historicalTimelineHint) {
            const replayEndDate = _normalizeDateStr(state && state.historicalAvailableEndDate);
            historicalTimelineHint.textContent = mode === 'historical'
                ? (replayEndDate
                    ? `Replay Date advances one trading day at a time through ${replayEndDate}.`
                    : 'Replay Date steps through daily market closes.')
                : '';
        }
        if (simulatedDateLabel) {
            simulatedDateLabel.textContent = mode === 'historical' ? 'Simulation Date' : 'Simulated Date';
        }
        if (simulatedDateStartLabel) {
            simulatedDateStartLabel.textContent = mode === 'historical' ? 'Start' : 'Today';
        }
        if (simulatedDateHint) {
            simulatedDateHint.hidden = mode !== 'historical';
            simulatedDateHint.textContent = mode === 'historical'
                ? 'BSM target date for charts and theoretical P&L. It can be later than Replay Date.'
                : '';
        }
        _setHidden(simulatedDateOffsetGroup, mode === 'historical');

        if (allowLiveComboOrdersInput) {
            if (mode !== 'live') {
                state.allowLiveComboOrders = false;
                allowLiveComboOrdersInput.checked = false;
            } else {
                allowLiveComboOrdersInput.checked = state.allowLiveComboOrders === true;
            }
            allowLiveComboOrdersInput.disabled = mode !== 'live';
            allowLiveComboOrdersInput.title = mode !== 'live'
                ? 'Live combo orders are unavailable in historical replay.'
                : '';
        }

        _syncLiveComboOrderAccountUI(state);
        _syncWorkspaceChrome(state);
    }

    function _createSelectOption(value, label, selected = false, disabled = false) {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
            return null;
        }
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = selected;
        option.disabled = disabled;
        return option;
    }

    function _setSelectOptions(select, optionDescriptors) {
        if (!select) return;

        const options = (optionDescriptors || [])
            .map((descriptor) => _createSelectOption(
                descriptor.value,
                descriptor.label,
                descriptor.selected === true,
                descriptor.disabled === true
            ))
            .filter(Boolean);

        if (typeof select.replaceChildren === 'function') {
            select.replaceChildren(...options);
        } else {
            select.innerHTML = '';
            options.forEach((option) => {
                if (typeof select.appendChild === 'function') {
                    select.appendChild(option);
                }
            });
        }
    }

    function _serializeSelectOptions(optionDescriptors) {
        return JSON.stringify((optionDescriptors || []).map((descriptor) => ({
            value: String(descriptor && descriptor.value || ''),
            label: String(descriptor && descriptor.label || ''),
            selected: descriptor && descriptor.selected === true,
            disabled: descriptor && descriptor.disabled === true,
        })));
    }

    function _syncLiveComboOrderAccountUI(state) {
        const controls = _getElement('liveComboOrderAccountControls');
        const select = _getElement('liveComboOrderAccountSelect');
        const hint = _getElement('liveComboOrderAccountHint');
        const mode = _getMarketDataMode(state);
        const accounts = Array.isArray(state && state.liveComboOrderAccounts)
            ? state.liveComboOrderAccounts
                .map((account) => String(account || '').trim())
                .filter((account, index, list) => account && list.indexOf(account) === index)
            : [];
        const selectedAccount = typeof state?.selectedLiveComboOrderAccount === 'string'
            ? state.selectedLiveComboOrderAccount.trim()
            : '';
        const isVisible = mode === 'live' && state && state.allowLiveComboOrders === true;
        const hasValidSelection = selectedAccount && accounts.includes(selectedAccount);
        const placeholderLabel = accounts.length > 0
            ? 'Select TWS account'
            : (state && state.liveComboOrderAccountsConnected === true
                ? 'No TWS accounts available'
                : 'Waiting for TWS account list...');

        _setHidden(controls, !isVisible);

        if (select) {
            const optionDescriptors = [];
            if (!hasValidSelection) {
                optionDescriptors.push({
                    value: '',
                    label: placeholderLabel,
                    selected: true,
                    disabled: accounts.length === 0,
                });
            }
            accounts.forEach((account) => {
                optionDescriptors.push({
                    value: account,
                    label: account,
                    selected: account === selectedAccount,
                    disabled: false,
                });
            });
            const nextOptionsSignature = _serializeSelectOptions(optionDescriptors);
            if (select.__liveComboOrderOptionsSignature !== nextOptionsSignature) {
                _setSelectOptions(select, optionDescriptors);
                select.__liveComboOrderOptionsSignature = nextOptionsSignature;
            }

            const nextValue = hasValidSelection ? selectedAccount : '';
            if (select.value !== nextValue) {
                select.value = nextValue;
            }

            const nextDisabled = !isVisible || accounts.length === 0;
            if (select.disabled !== nextDisabled) {
                select.disabled = nextDisabled;
            }
        }

        if (hint) {
            if (!isVisible) {
                hint.textContent = '';
            } else if (state && state.liveComboOrderAccountsConnected !== true) {
                hint.textContent = 'Waiting for ib_server / TWS to report the available accounts.';
            } else if (accounts.length === 0) {
                hint.textContent = 'TWS did not report any accounts that can be selected for combo orders yet.';
            } else if (!hasValidSelection) {
                hint.textContent = 'Choose which TWS account real combo orders should use.';
            } else {
                hint.textContent = `Real combo orders will be routed to ${selectedAccount}.`;
            }
        }
    }

    function _syncHistoricalTimelineUi(state) {
        const replayDateInput = _getElement('historicalReplayDate');
        const replaySlider = _getElement('historicalReplaySlider');
        const replayDisplay = _getElement('historicalReplayDaysDisplay');
        const nextDayBtn = _getElement('historicalNextDayBtn');
        const settleAllBtn = _getElement('historicalSettleAllBtn');

        if (!replayDateInput || !replaySlider || !replayDisplay) {
            return;
        }

        if (!_isHistoricalMode(state)) {
            replayDateInput.min = '';
            replayDateInput.max = '';
            replayDateInput.value = '';
            replaySlider.min = '0';
            replaySlider.max = '0';
            replaySlider.value = '0';
            replayDisplay.textContent = '+0 td / +0 cd';
            if (nextDayBtn) nextDayBtn.disabled = true;
            if (settleAllBtn) settleAllBtn.disabled = true;
            return;
        }

        const timelineDates = _buildHistoricalTimelineDates(state);
        const effectiveReplayDate = _resolveHistoricalReplayDate(state);
        if (effectiveReplayDate) {
            state.historicalQuoteDate = effectiveReplayDate;
        }

        const replayIndex = timelineDates.indexOf(effectiveReplayDate);
        const tradingOffset = replayIndex >= 0 ? replayIndex : 0;
        const calendarOffset = effectiveReplayDate && state.baseDate
            && typeof OptionComboDateUtils !== 'undefined'
            && typeof OptionComboDateUtils.diffDays === 'function'
            ? OptionComboDateUtils.diffDays(state.baseDate, effectiveReplayDate)
            : 0;

        replayDateInput.min = state.baseDate || '';
        replayDateInput.max = timelineDates.length > 0
            ? timelineDates[timelineDates.length - 1]
            : (state.historicalAvailableEndDate || state.baseDate || '');
        replayDateInput.value = effectiveReplayDate || state.baseDate || '';

        replaySlider.min = '0';
        replaySlider.max = String(Math.max(0, timelineDates.length - 1));
        replaySlider.value = String(Math.max(0, tradingOffset));
        replayDisplay.textContent = `+${tradingOffset} td / +${calendarOffset} cd`;

        if (nextDayBtn) {
            nextDayBtn.disabled = replayIndex < 0 || replayIndex >= timelineDates.length - 1;
        }
        if (settleAllBtn) {
            settleAllBtn.disabled = !Array.isArray(state.groups) || state.groups.length === 0;
        }
    }

    function _syncSimulationDateUi(state) {
        const simDateInput = _getElement('simulatedDate');
        const dpSlider = _getElement('daysPassedSlider');
        const dpDisplay = _getElement('daysPassedDisplay');

        if (!simDateInput || !dpSlider || !dpDisplay) {
            return;
        }

        if (_isHistoricalMode(state)) {
            const effectiveReplayDate = _resolveHistoricalReplayDate(state) || _normalizeDateStr(state && state.baseDate) || '';
            const effectiveSimulationDate = _coerceHistoricalSimulationDate(
                state,
                _normalizeDateStr(state && state.simulatedDate) || effectiveReplayDate
            );
            if (effectiveSimulationDate && state.simulatedDate !== effectiveSimulationDate) {
                state.simulatedDate = effectiveSimulationDate;
            }

            simDateInput.min = effectiveReplayDate || state.baseDate || '';
            simDateInput.max = '';
            simDateInput.value = effectiveSimulationDate || effectiveReplayDate || '';
            dpDisplay.textContent = '';
            return;
        }

        simDateInput.min = state.baseDate || '';
        simDateInput.max = '';
        const days = typeof OptionComboDateUtils !== 'undefined'
            && typeof OptionComboDateUtils.diffDays === 'function'
            ? OptionComboDateUtils.diffDays(state.baseDate, state.simulatedDate)
            : 0;
        const tradDays = typeof OptionComboDateUtils !== 'undefined'
            && typeof OptionComboDateUtils.calendarToTradingDays === 'function'
            ? OptionComboDateUtils.calendarToTradingDays(state.baseDate, state.simulatedDate)
            : days;
        simDateInput.value = state.simulatedDate || state.baseDate || '';
        dpSlider.min = '0';
        if (!dpSlider.max || parseInt(dpSlider.max, 10) < days) {
            dpSlider.max = String(Math.max(days, 365));
        }
        dpSlider.value = String(days);
        dpDisplay.textContent = `+${tradDays} td / +${days} cd`;
    }

    function refreshBoundDynamicControls() {
        if (!_boundState) return;
        _syncMarketDataModeUI(_boundState);
        _syncHistoricalTimelineUi(_boundState);
        _syncSimulationDateUi(_boundState);
        _syncUnderlyingContractMonthUI(_boundState, false);
        const underlyingPriceInput = _getElement('underlyingPrice');
        const underlyingPriceSlider = _getElement('underlyingPriceSlider');
        const underlyingPriceDisplay = _getElement('underlyingPriceDisplay');
        if (underlyingPriceInput) {
            underlyingPriceInput.step = _getPriceInputStep(_boundState.underlyingSymbol);
            underlyingPriceInput.value = _formatPriceInputValue(_boundState.underlyingSymbol, _boundState.underlyingPrice);
        }
        if (underlyingPriceSlider) {
            underlyingPriceSlider.step = _getPriceInputStep(_boundState.underlyingSymbol);
            underlyingPriceSlider.value = _boundState.underlyingPrice;
        }
        if (underlyingPriceDisplay) {
            underlyingPriceDisplay.textContent = _formatPriceDisplayValue(_boundState.underlyingSymbol, _boundState.underlyingPrice);
        }
        _syncInterestRateUI(_boundState);
        _syncLiveComboOrderAccountUI(_boundState);
        if (_shouldPauseDynamicControlRefresh('forwardRatePanel')) {
            _renderForwardRateStatus(_boundState);
        } else {
            _renderForwardRateSamples(_boundState, _boundDeps || {});
        }
        if (_shouldPauseDynamicControlRefresh('futuresPoolPanel')) {
            _renderFuturesPoolStatus(_boundState);
        } else {
            _renderFuturesPool(_boundState, _boundDeps || {});
        }
    }

    function bindControlPanelEvents(state, currencyFormatter, deps) {
        const {
            updateDerivedValues,
            throttledUpdate,
            handleLiveSubscriptions,
            requestManagedAccountsSnapshot,
            settleHistoricalReplayGroups,
            renderGroups,
            generateId,
            addDays,
            diffDays,
            calendarToTradingDays,
        } = deps;

        _boundState = state;
        _boundDeps = {
            updateDerivedValues,
            handleLiveSubscriptions,
            requestManagedAccountsSnapshot,
            settleHistoricalReplayGroups,
            renderGroups,
            generateId,
            addDays,
            diffDays,
        };

        const symInput = _getElement('underlyingSymbol');
        const underlyingContractMonthInput = _getElement('underlyingContractMonth');
        const marketDataModeInput = _getElement('marketDataMode');
        const historicalQuoteDateInput = _getElement('historicalQuoteDate');
        const historicalReplayDateInput = _getElement('historicalReplayDate');

        refreshBoundDynamicControls();

        if (marketDataModeInput) {
            marketDataModeInput.addEventListener('change', (e) => {
                if (_isMarketDataModeLocked(state)) {
                    e.target.value = _getMarketDataMode(state);
                    _syncMarketDataModeUI(state);
                    return;
                }
                const nextMode = String(e.target.value || '').trim().toLowerCase() === 'historical'
                    ? 'historical'
                    : 'live';
                state.marketDataMode = nextMode;
                if (nextMode === 'historical') {
                    state.historicalQuoteDate = state.historicalQuoteDate || state.baseDate || state.simulatedDate || '';
                    state.simulatedDate = _coerceHistoricalSimulationDate(
                        state,
                        state.simulatedDate || state.historicalQuoteDate || state.baseDate || ''
                    );
                }
                _syncMarketDataModeUI(state);
                _syncHistoricalTimelineUi(state);
                _syncSimulationDateUi(state);
                if (typeof renderGroups === 'function') {
                    renderGroups();
                } else {
                    updateDerivedValues();
                }
                handleLiveSubscriptions();
            });
        }

        if (historicalQuoteDateInput) {
            historicalQuoteDateInput.addEventListener('change', (e) => {
                const requestedStartDate = _normalizeDateStr(e.target.value);
                if (!_isHistoricalMode(state)) {
                    state.historicalQuoteDate = requestedStartDate;
                    _syncMarketDataModeUI(state);
                    return;
                }

                const nextBaseDate = _coerceHistoricalReplayDate({
                    ...state,
                    baseDate: requestedStartDate || state.baseDate,
                }, requestedStartDate || state.baseDate);

                if (nextBaseDate) {
                    state.baseDate = nextBaseDate;
                }

                const nextReplayDate = _coerceHistoricalReplayDate(state, state.historicalQuoteDate || state.baseDate);
                state.historicalQuoteDate = nextReplayDate || state.baseDate;
                state.simulatedDate = _coerceHistoricalSimulationDate(state, state.simulatedDate || state.historicalQuoteDate);
                _syncMarketDataModeUI(state);
                _syncHistoricalTimelineUi(state);
                _syncSimulationDateUi(state);
                _syncUnderlyingContractMonthUI(state, false);
                _renderForwardRateSamples(state, _boundDeps);
                updateDerivedValues();
                if (_isHistoricalMode(state)) {
                    handleLiveSubscriptions();
                }
            });
        }

        if (historicalReplayDateInput) {
            historicalReplayDateInput.addEventListener('change', (e) => {
                if (!_isHistoricalMode(state)) {
                    return;
                }

                const nextReplayDate = _coerceHistoricalReplayDate(state, e.target.value);
                state.historicalQuoteDate = nextReplayDate || state.baseDate || '';
                state.simulatedDate = _coerceHistoricalSimulationDate(state, state.simulatedDate || state.historicalQuoteDate);
                _syncHistoricalTimelineUi(state);
                _syncSimulationDateUi(state);
                _syncUnderlyingContractMonthUI(state, false);
                _renderForwardRateSamples(state, _boundDeps);
                updateDerivedValues();
                handleLiveSubscriptions();
            });
        }

        function applyUnderlyingSymbol(rawValue, forceResubscribe) {
            const normalizedSymbol = String(rawValue || '').trim().toUpperCase();
            if (!normalizedSymbol) {
                symInput.value = state.underlyingSymbol;
                return;
            }

            const symbolChanged = normalizedSymbol !== state.underlyingSymbol;
            state.underlyingSymbol = normalizedSymbol;
            symInput.value = state.underlyingSymbol;
            _syncUnderlyingContractMonthUI(state, symbolChanged);
            _syncInterestRateUI(state);
            if (upInput) {
                upInput.step = _getPriceInputStep(state.underlyingSymbol);
                upInput.value = _formatPriceInputValue(state.underlyingSymbol, state.underlyingPrice);
            }
            if (upSlider) {
                upSlider.step = _getPriceInputStep(state.underlyingSymbol);
                upSlider.value = state.underlyingPrice;
            }
            if (upDisplay) {
                upDisplay.textContent = _formatPriceDisplayValue(state.underlyingSymbol, state.underlyingPrice);
            }
            _renderForwardRateSamples(state, _boundDeps);
            _renderFuturesPool(state, _boundDeps);

            if (typeof renderGroups === 'function') {
                renderGroups();
            } else {
                updateDerivedValues();
            }

            if (symbolChanged || forceResubscribe) {
                handleLiveSubscriptions();
            }
        }

        symInput.addEventListener('change', (e) => {
            applyUnderlyingSymbol(e.target.value, true);
        });
        symInput.addEventListener('blur', (e) => {
            applyUnderlyingSymbol(e.target.value, true);
        });
        symInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            if (typeof e.preventDefault === 'function') {
                e.preventDefault();
            }
            applyUnderlyingSymbol(e.target.value, true);
            if (typeof symInput.blur === 'function') {
                symInput.blur();
            }
        });

        if (underlyingContractMonthInput) {
            underlyingContractMonthInput.addEventListener('input', (e) => {
                const cleaned = String(e.target.value || '').replace(/\D/g, '').slice(0, 6);
                state.underlyingContractMonth = cleaned;
                underlyingContractMonthInput.value = cleaned;
            });
            underlyingContractMonthInput.addEventListener('change', (e) => {
                const cleaned = String(e.target.value || '').replace(/\D/g, '').slice(0, 6);
                state.underlyingContractMonth = cleaned;
                underlyingContractMonthInput.value = cleaned;
                updateDerivedValues();
                handleLiveSubscriptions();
            });
        }

        const upInput = _getElement('underlyingPrice');
        const upSlider = _getElement('underlyingPriceSlider');
        const upDisplay = _getElement('underlyingPriceDisplay');

        function updateUnderlyingPrice(val) {
            state.underlyingPrice = parseFloat(val);
            upInput.value = _formatPriceInputValue(state.underlyingSymbol, state.underlyingPrice);
            upSlider.value = state.underlyingPrice;
            upDisplay.textContent = _formatPriceDisplayValue(state.underlyingSymbol, state.underlyingPrice);
            updateDerivedValues();
        }

        upInput.addEventListener('input', (e) => updateUnderlyingPrice(e.target.value));
        upSlider.addEventListener('input', (e) => {
            state.underlyingPrice = parseFloat(e.target.value);
            upInput.value = _formatPriceInputValue(state.underlyingSymbol, state.underlyingPrice);
            upDisplay.textContent = _formatPriceDisplayValue(state.underlyingSymbol, state.underlyingPrice);
            throttledUpdate();
        });

        globalScope.adjustUnderlying = (percentChange) => {
            const newValue = state.underlyingPrice * (1 + percentChange);
            updateUnderlyingPrice(newValue);
        };

        const simDateInput = _getElement('simulatedDate');
        const dpSlider = _getElement('daysPassedSlider');
        const historicalReplaySlider = _getElement('historicalReplaySlider');
        const nextDayBtn = _getElement('historicalNextDayBtn');
        const settleAllBtn = _getElement('historicalSettleAllBtn');

        simDateInput.value = state.simulatedDate;
        simDateInput.min = state.baseDate;

        function updateReplayDate(newDateStr) {
            if (_isHistoricalMode(state)) {
                const coercedReplayDate = _coerceHistoricalReplayDate(state, newDateStr);
                state.historicalQuoteDate = coercedReplayDate || state.baseDate;
                state.simulatedDate = _coerceHistoricalSimulationDate(state, state.simulatedDate || state.historicalQuoteDate);
                _syncHistoricalTimelineUi(state);
                _syncSimulationDateUi(state);
                _syncUnderlyingContractMonthUI(state, false);
                _renderForwardRateSamples(state, _boundDeps);
                updateDerivedValues();
                handleLiveSubscriptions();
                return;
            }

            if (new Date(newDateStr) < new Date(state.baseDate)) {
                newDateStr = state.baseDate;
                simDateInput.value = state.baseDate;
            }
            state.simulatedDate = newDateStr;
            const days = diffDays(state.baseDate, state.simulatedDate);
            const tradDays = calendarToTradingDays(state.baseDate, state.simulatedDate);
            dpSlider.value = days;
            const dpDisplay = _getElement('daysPassedDisplay');
            if (dpDisplay) {
                dpDisplay.textContent = `+${tradDays} td / +${days} cd`;
            }
            _syncUnderlyingContractMonthUI(state, false);
            _renderForwardRateSamples(state, _boundDeps);
            updateDerivedValues();
        }

        function updateSimulationDate(newDateStr) {
            if (_isHistoricalMode(state)) {
                state.simulatedDate = _coerceHistoricalSimulationDate(state, newDateStr);
                _syncSimulationDateUi(state);
                _syncUnderlyingContractMonthUI(state, false);
                _renderForwardRateSamples(state, _boundDeps);
                updateDerivedValues();
                return;
            }

            updateReplayDate(newDateStr);
        }

        simDateInput.addEventListener('change', (e) => updateSimulationDate(e.target.value));
        dpSlider.addEventListener('input', (e) => {
            if (_isHistoricalMode(state)) {
                return;
            }

            const dNum = parseInt(e.target.value, 10);
            state.simulatedDate = addDays(state.baseDate, dNum);
            simDateInput.value = state.simulatedDate;
            const tradDays = calendarToTradingDays(state.baseDate, state.simulatedDate);
            const dpDisplay = _getElement('daysPassedDisplay');
            if (dpDisplay) {
                dpDisplay.textContent = `+${tradDays} td / +${dNum} cd`;
            }
            _syncUnderlyingContractMonthUI(state, false);
            _renderForwardRateSamples(state, _boundDeps);
            throttledUpdate();
        });

        if (historicalReplaySlider) {
            historicalReplaySlider.addEventListener('input', (e) => {
                if (!_isHistoricalMode(state)) {
                    return;
                }
                const timelineDates = _buildHistoricalTimelineDates(state);
                const index = Math.max(0, Math.min(timelineDates.length - 1, parseInt(e.target.value, 10) || 0));
                const nextReplayDate = timelineDates[index] || state.baseDate;
                updateReplayDate(nextReplayDate);
            });
        }

        if (nextDayBtn) {
            nextDayBtn.addEventListener('click', () => {
                if (!_isHistoricalMode(state)) {
                    return;
                }
                const timelineDates = _buildHistoricalTimelineDates(state);
                const currentIndex = timelineDates.indexOf(_resolveHistoricalReplayDate(state));
                if (currentIndex >= 0 && currentIndex < timelineDates.length - 1) {
                    updateReplayDate(timelineDates[currentIndex + 1]);
                }
            });
        }

        if (settleAllBtn) {
            settleAllBtn.addEventListener('click', () => {
                if (typeof settleHistoricalReplayGroups !== 'function') {
                    return;
                }
                settleHistoricalReplayGroups();
                _syncHistoricalTimelineUi(state);
            });
        }

        const irInput = _getElement('interestRate');
        const irDisplay = _getElement('interestRateDisplay');
        irInput.addEventListener('input', (e) => {
            const pct = parseFloat(e.target.value);
            state.interestRate = pct / 100.0;
            irDisplay.textContent = `${pct.toFixed(2)}%`;
            updateDerivedValues();
        });

        const ivInput = _getElement('ivOffset');
        const ivSlider = _getElement('ivOffsetSlider');
        const ivDisplay = _getElement('ivOffsetDisplay');
        const allowLiveComboOrdersInput = _getElement('allowLiveComboOrders');
        const liveComboOrderAccountSelect = _getElement('liveComboOrderAccountSelect');

        function updateIv(val) {
            const pct = parseFloat(val);
            state.ivOffset = pct / 100.0;
            ivInput.value = pct;
            ivSlider.value = pct;
            ivDisplay.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
            updateDerivedValues();
        }

        ivInput.addEventListener('input', (e) => updateIv(e.target.value));
        ivSlider.addEventListener('input', (e) => {
            const pct = parseFloat(e.target.value);
            state.ivOffset = pct / 100.0;
            ivInput.value = pct;
            ivDisplay.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
            throttledUpdate();
        });

        if (allowLiveComboOrdersInput) {
            allowLiveComboOrdersInput.checked = state.allowLiveComboOrders === true;
            allowLiveComboOrdersInput.addEventListener('change', (e) => {
                state.allowLiveComboOrders = _getMarketDataMode(state) === 'live' && e.target.checked === true;
                allowLiveComboOrdersInput.checked = state.allowLiveComboOrders === true;
                if (state.allowLiveComboOrders === true
                    && _boundDeps
                    && typeof _boundDeps.requestManagedAccountsSnapshot === 'function') {
                    _boundDeps.requestManagedAccountsSnapshot();
                }
                _syncLiveComboOrderAccountUI(state);
            });
        }

        if (liveComboOrderAccountSelect) {
            liveComboOrderAccountSelect.addEventListener('change', (e) => {
                state.selectedLiveComboOrderAccount = String(e.target.value || '').trim();
                _syncLiveComboOrderAccountUI(state);
            });
        }
    }

    function toggleSidebar() {
        const layoutGrid = document.querySelector('.layout-grid');
        if (layoutGrid) {
            layoutGrid.classList.toggle('sidebar-collapsed');
        }
    }

    globalScope.OptionComboControlPanelUI = {
        bindControlPanelEvents,
        refreshBoundDynamicControls,
        resolvePricingInputMode: _getPricingInputMode,
        toggleSidebar,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
