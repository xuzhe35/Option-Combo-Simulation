/**
 * Control panel event binding and sidebar interactions.
 */

(function attachControlPanelUI(globalScope) {
    let _boundState = null;
    let _boundDeps = null;
    let _primaryControlPanelDialogOpen = false;

    function _getRegistry() {
        return typeof globalScope.OptionComboProductRegistry === 'undefined'
            ? null
            : globalScope.OptionComboProductRegistry;
    }

    function _getSessionUi() {
        return globalScope.OptionComboSessionUI && typeof globalScope.OptionComboSessionUI === 'object'
            ? globalScope.OptionComboSessionUI
            : null;
    }

    function _getDateUtils() {
        return globalScope.OptionComboDateUtils && typeof globalScope.OptionComboDateUtils === 'object'
            ? globalScope.OptionComboDateUtils
            : null;
    }

    function _getPricingContext() {
        return globalScope.OptionComboPricingContext && typeof globalScope.OptionComboPricingContext === 'object'
            ? globalScope.OptionComboPricingContext
            : null;
    }

    function _getMarketCurves() {
        return globalScope.OptionComboMarketCurves && typeof globalScope.OptionComboMarketCurves === 'object'
            ? globalScope.OptionComboMarketCurves
            : null;
    }

    function _resolveCalendarContext(state) {
        const registry = _getRegistry();
        const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
            ? registry.resolveUnderlyingProfile(state && state.underlyingSymbol)
            : null;
        return {
            calendarKey: String(profile && profile.calendarId || 'NYSE').toUpperCase(),
            observedTradingDates: _isHistoricalMode(state)
                ? state && state.historicalTradingDates
                : null,
        };
    }

    function _getIndexForwardRateApi() {
        return globalScope.OptionComboIndexForwardRate && typeof globalScope.OptionComboIndexForwardRate === 'object'
            ? globalScope.OptionComboIndexForwardRate
            : null;
    }

    function _getWsLiveQuotesApi() {
        return globalScope.OptionComboWsLiveQuotes && typeof globalScope.OptionComboWsLiveQuotes === 'object'
            ? globalScope.OptionComboWsLiveQuotes
            : null;
    }

    function _runUiRefreshSafely(label, callback) {
        try {
            return callback();
        } catch (error) {
            console.error(`UI refresh failed (${label}):`, error);
            return undefined;
        }
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
        const sessionUi = _getSessionUi();
        if (!sessionUi || typeof sessionUi.syncWorkspaceChrome !== 'function') {
            return;
        }
        _runUiRefreshSafely('workspaceChrome', () => {
            sessionUi.syncWorkspaceChrome(state);
        });
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

        const dateUtils = _getDateUtils();
        if (dateUtils && typeof dateUtils.listTradingDays === 'function') {
            const calendarContext = _resolveCalendarContext(state);
            return dateUtils.listTradingDays(
                startDate, endDate,
                calendarContext.calendarKey, calendarContext.observedTradingDates
            );
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
        const pricingContext = _getPricingContext();
        const resolved = pricingContext && typeof pricingContext.resolveQuoteDate === 'function'
            ? _normalizeDateStr(pricingContext.resolveQuoteDate(state))
            : '';
        return resolved
            || _normalizeDateStr(state && state.liveQuoteDate)
            || _normalizeDateStr(state && state.baseDate)
            || _normalizeDateStr(state && state.simulatedDate)
            || '';
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
            && Number.isFinite(parseFloat(
                sample.carryRate !== null && sample.carryRate !== undefined
                    ? sample.carryRate
                    : sample.impliedRate
            ));
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
            status.textContent = 'Add one or more reference samples (expiry-matched call/put) to derive market-implied carry; index option projections remain unavailable without one.';
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

        status.textContent = `Waiting for live call/put quotes to compute Forward Carry for ${samples.length} sample${samples.length === 1 ? '' : 's'}; affected index option projections remain unavailable.`;
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

    function _syncPrimaryControlPanelDialogUi(state) {
        const card = _getElement('primaryControlPanelCard');
        const dialog = _getElement('simulationControlsDialog');
        const toggleBtn = _getElement('togglePrimaryControlPanelBtn');
        const toggleLabel = toggleBtn ? toggleBtn.querySelector('.control-panel-toggle-label') : null;
        const isOpen = !!(_primaryControlPanelDialogOpen && dialog);

        if (card && card.classList && typeof card.classList.toggle === 'function') {
            card.classList.toggle('is-dialog-open', isOpen);
        }

        _setHidden(dialog, !isOpen);

        if (toggleBtn) {
            toggleBtn.title = isOpen
                ? 'Simulation Controls are open'
                : 'Open Simulation Controls';
            if (typeof toggleBtn.setAttribute === 'function') {
                toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            }
        }

        if (toggleLabel) {
            toggleLabel.textContent = isOpen ? 'Controls Open' : 'Open Controls';
        }

        const doc = globalScope.document;
        if (doc && doc.body && doc.body.classList
            && typeof doc.body.classList.toggle === 'function') {
            doc.body.classList.toggle('simulation-controls-dialog-open', isOpen);
        }
    }

    function _resolveForwardCarrySnapshot() {
        const liveQuotes = _getWsLiveQuotesApi();
        if (!liveQuotes || typeof liveQuotes.getForwardCarrySnapshot !== 'function') {
            return null;
        }
        try {
            return liveQuotes.getForwardCarrySnapshot();
        } catch (_error) {
            return null;
        }
    }

    function _describeFuturesPoolPolicy(state, snapshot = null) {
        const registry = _getRegistry();
        const policy = registry && typeof registry.resolveForwardCarryPolicy === 'function'
            ? registry.resolveForwardCarryPolicy(state && state.underlyingSymbol)
            : null;
        if (!policy || policy.pricingInputMode !== 'FOP') return '';
        if (policy.carryReference) {
            const referenceSymbol = String(policy.carryReference.symbol || 'cash index').toUpperCase();
            const diagnosticReady = snapshot && snapshot.reference
                && Number(snapshot.reference.price) > 0
                && Array.isArray(snapshot.points)
                && snapshot.points.some(point => point && point.carryRate !== null
                    && point.carryRate !== undefined && Number.isFinite(Number(point.carryRate)));
            return `Each option leg prices from its bound future; ${referenceSymbol} is diagnostics only${diagnosticReady ? ' (net carry ready)' : ' (net carry unavailable)'}; USD r only discounts.`;
        }
        return 'Exchange futures quotes are the Forward/curve; USD r only discounts and never generates Carry.';
    }

    function _formatFuturesPoolQuoteLine(entry, state, snapshot = null) {
        const base = `Bid ${_formatQuoteValue(entry.bid, state.underlyingSymbol)} / Ask ${_formatQuoteValue(entry.ask, state.underlyingSymbol)} / Mark ${_formatQuoteValue(entry.mark, state.underlyingSymbol)}`;
        const annotations = [];
        const identityStatus = String(entry && entry.liveQuoteIdentityStatus || '').trim();
        const identityReason = String(entry && entry.liveQuoteIdentityReason || '').trim();
        if (identityStatus === 'pending') {
            annotations.push(`Live quote pending${identityReason ? `: ${identityReason}` : ''}`);
        } else if (identityStatus === 'rejected') {
            annotations.push(`Live quote rejected${identityReason ? `: ${identityReason}` : ''}`);
        } else if (identityStatus === 'unavailable') {
            annotations.push(`Live quote unavailable${identityReason ? `: ${identityReason}` : ''}`);
        }

        if (snapshot && Array.isArray(snapshot.points)) {
            const point = snapshot.points.find(candidate =>
                String(candidate && candidate.futuresPoolEntryId || '') === String(entry && entry.id || '')
            ) || snapshot.points.find(candidate =>
                String(candidate && candidate.contractMonth || '') === String(entry && entry.contractMonth || '')
            );
            if (point && point.carryRate !== null && point.carryRate !== undefined
                && Number.isFinite(Number(point.carryRate))) {
                const referenceSymbol = String(snapshot.reference && snapshot.reference.symbol || 'spot').toUpperCase();
                annotations.push(`Net carry vs ${referenceSymbol} ${(Number(point.carryRate) * 100).toFixed(2)}%`);
            } else if (point && point.carryQuality && point.carryQuality.usable === false) {
                annotations.push('Net carry unavailable');
            }
            if (point && point.annualizedRollSlope !== null && point.annualizedRollSlope !== undefined
                && Number.isFinite(Number(point.annualizedRollSlope))) {
                annotations.push(`Roll ann. ${(Number(point.annualizedRollSlope) * 100).toFixed(2)}%`);
            } else if (point && annotations.length === 0
                && point.relativeLogPriceToAnchor !== null && point.relativeLogPriceToAnchor !== undefined
                && Number.isFinite(Number(point.relativeLogPriceToAnchor))) {
                const relativeMove = Math.expm1(Number(point.relativeLogPriceToAnchor)) * 100;
                if (Math.abs(relativeMove) > 0.0001) {
                    annotations.push(`Curve vs anchor ${relativeMove >= 0 ? '+' : ''}${relativeMove.toFixed(2)}%`);
                }
            }
        }
        return annotations.length > 0 ? `${base} / ${annotations.join(' / ')}` : base;
    }

    function _renderFuturesPoolStatus(state) {
        const status = _getElement('futuresPoolStatus');
        if (!status) return;

        const snapshot = _resolveForwardCarrySnapshot();
        const policyText = _describeFuturesPoolPolicy(state, snapshot);
        const setStatus = (message) => {
            status.textContent = policyText ? `${message} ${policyText}` : message;
        };

        const entries = Array.isArray(state.futuresPool) ? state.futuresPool : [];
        if (entries.length === 0) {
            setStatus('Add one or more futures contracts. Each FOP leg will be required to pick one.');
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
            setStatus(`Enter YYYYMM contract months to configure ${entries.length} ${contractLabel}.`);
            return;
        }

        let identityText = '';
        if (state && state.marketDataMode === 'live') {
            const verifiedEntries = entries.filter(entry =>
                entry && entry.liveQuoteIdentityStatus === 'verified'
                && entry.requestIdentityVerified === true
            ).length;
            const rejectedEntries = entries.filter(entry =>
                entry && entry.liveQuoteIdentityStatus === 'rejected'
            );
            const pendingEntries = entries.filter(entry =>
                entry && entry.liveQuoteIdentityStatus === 'pending'
            ).length;
            identityText = `; ${verifiedEntries}/${configuredEntries} current-generation identities verified`;
            if (pendingEntries > 0) identityText += `; ${pendingEntries} pending`;
            if (rejectedEntries.length > 0) {
                const reasons = Array.from(new Set(
                    rejectedEntries.map(entry => String(entry.liveQuoteIdentityReason || '').trim())
                        .filter(Boolean)
                ));
                identityText += `; ${rejectedEntries.length} rejected${reasons.length ? ` (${reasons.join('; ')})` : ''}`;
            }
        }
        setStatus(`${configuredEntries}/${entries.length} ${contractLabel} configured; ${quotedEntries}/${configuredEntries} quoted${identityText}.`);
    }

    function _renderForwardRateSamples(state, deps) {
        const panel = _getElement('forwardRatePanel');
        const list = _getElement('forwardRateSamplesList');
        const addBtn = _getElement('addForwardRateSampleBtn');
        const toggleBtn = _getElement('toggleForwardRatePanelBtn');
        const showPanel = _getPricingInputMode(state.underlyingSymbol) === 'INDEX';
        const quoteReferenceDate = _getQuoteReferenceDate(state);

        (state.forwardRateSamples || []).forEach((sample) => {
            if (sample && sample.expDate && quoteReferenceDate
                && sample.daysToExpiryAsOf !== quoteReferenceDate
                && typeof deps.diffDays === 'function') {
                sample.daysToExpiry = Math.max(0, deps.diffDays(quoteReferenceDate, sample.expDate));
                sample.daysToExpiryAsOf = quoteReferenceDate;
            }
        });

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
                    expDate: typeof deps.addDays === 'function' ? deps.addDays(_getQuoteReferenceDate(state), 30) : '',
                    daysToExpiryAsOf: _getQuoteReferenceDate(state),
                    strike: state.underlyingPrice,
                    dailyCarry: null,
                    carryRate: null,
                    impliedRate: null,
                    forwardPrice: null,
                    discountRate: null,
                    discountFactor: null,
                    quoteAsOf: '',
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
                sample.daysToExpiryAsOf = _getQuoteReferenceDate(state);
                if (typeof deps.addDays === 'function') {
                    sample.expDate = parsed > 0 ? deps.addDays(_getQuoteReferenceDate(state), parsed) : '';
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
                sample.daysToExpiryAsOf = _getQuoteReferenceDate(state);
                if (typeof deps.diffDays === 'function' && sample.expDate) {
                    sample.daysToExpiry = Math.max(0, deps.diffDays(_getQuoteReferenceDate(state), sample.expDate));
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
            const indexForwardRateApi = _getIndexForwardRateApi();
            const wsLiveQuotesApi = _getWsLiveQuotesApi();
            const sampleRuntime = indexForwardRateApi
                && wsLiveQuotesApi
                && typeof indexForwardRateApi.refreshForwardRateSample === 'function'
                ? indexForwardRateApi.refreshForwardRateSample(sample, state, wsLiveQuotesApi)
                : null;
            const snapshot = sampleRuntime && sampleRuntime.snapshot;
            const statusLabel = _describeForwardRateSampleState(sample, sampleRuntime);
            const carryRate = Number.isFinite(Number(sample.carryRate))
                ? Number(sample.carryRate)
                : Number(sample.impliedRate);
            const carryText = Number.isFinite(carryRate)
                ? `r-q=${(carryRate * 100).toFixed(2)}%`
                : 'r-q=--';
            const discountText = Number.isFinite(Number(sample.discountRate))
                ? `r=${(Number(sample.discountRate) * 100).toFixed(2)}%`
                : '';
            const timestampText = _formatForwardRateTimestamp(sample.lastComputedAt);
            const summarySegments = [carryText];
            if (discountText) {
                summarySegments.push(discountText);
            }
            if (timestampText) {
                summarySegments.push(`@ ${timestampText}`);
            }
            const metaSegments = [statusLabel];
            if (snapshot) {
                metaSegments.push(`C=${snapshot.callMid.toFixed(2)} P=${snapshot.putMid.toFixed(2)} F=${snapshot.syntheticForward.toFixed(2)}`);
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
        const sessionLogic = globalScope.OptionComboSessionLogic;
        const autoBindSingleFuture = () => !!(sessionLogic
            && typeof sessionLogic.autoBindSingleFuturesPoolEntry === 'function'
            && sessionLogic.autoBindSingleFuturesPoolEntry(state));

        if (showPanel) {
            autoBindSingleFuture();
        }

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
                const bindingChanged = autoBindSingleFuture();
                _renderFuturesPool(state, deps);
                if (bindingChanged && typeof deps.renderGroups === 'function') {
                    deps.renderGroups();
                } else if (bindingChanged && typeof deps.updateDerivedValues === 'function') {
                    deps.updateDerivedValues();
                }
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
        const carrySnapshot = _resolveForwardCarrySnapshot();
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
                    quoteDisplay.textContent = _formatFuturesPoolQuoteLine(entry, state, carrySnapshot);
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
                autoBindSingleFuture();
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
            quoteDisplay.textContent = _formatFuturesPoolQuoteLine(entry, state, carrySnapshot);
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

        const sessionLogic = globalScope.OptionComboSessionLogic;
        if (sessionLogic
            && typeof sessionLogic.ensureInitialFuturesPoolEntry === 'function') {
            sessionLogic.ensureInitialFuturesPoolEntry(
                state,
                _boundDeps && _boundDeps.generateId,
                _getQuoteReferenceDate(state)
            );
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

    function _resolveDiscountFallbackSummary(state) {
        const pricingContext = _getPricingContext();
        if (!pricingContext || typeof pricingContext.summarizeDiscountFallback !== 'function') {
            return null;
        }
        return _runUiRefreshSafely('discountFallbackSummary', () =>
            pricingContext.summarizeDiscountFallback(state, state && state.interestRate)) || null;
    }

    function _resolveLoadedCurveReference(curve) {
        const marketCurves = _getMarketCurves();
        if (!curve || curve.kind !== 'discount' || !marketCurves
            || typeof marketCurves.resolveDiscount !== 'function') {
            return null;
        }
        try {
            const observation = marketCurves.resolveDiscount(curve, 1, {
                maxExtrapolationDays: Math.max(31, Number(curve.maxExtrapolationDays) || 0),
            });
            return observation && observation.usable !== false
                && Number.isFinite(Number(observation.zeroRate))
                ? observation
                : null;
        } catch (_error) {
            return null;
        }
    }

    function _syncInterestRateUI(state) {
        const irInput = _getElement('interestRate');
        const irDisplay = _getElement('interestRateDisplay');
        const irLabelText = _getElement('interestRateLabelText');
        const curveToggle = _getElement('useMarketDiscountCurve');
        const loadLatestCurveBtn = _getElement('loadLatestDiscountCurveBtn');
        const curveStatus = _getElement('discountCurveStatus');
        if (!irInput) return;

        const parsedRate = parseFloat(state && state.interestRate);
        const pct = Number.isFinite(parsedRate) ? parsedRate * 100 : 0;
        const useCurve = state && state.useMarketDiscountCurve !== false;
        const curve = state && state.discountCurve && typeof state.discountCurve === 'object'
            ? state.discountCurve
            : null;
        const curveReference = useCurve ? _resolveLoadedCurveReference(curve) : null;
        const curveReferenceRate = curveReference
            ? Number(curveReference.zeroRate)
            : Number.NaN;
        const curveReferenceReady = Number.isFinite(curveReferenceRate);
        const displayedPct = curveReferenceReady ? curveReferenceRate * 100 : pct;
        irInput.value = displayedPct.toFixed(2);
        irInput.disabled = curveReferenceReady;
        irInput.title = curveReferenceReady
            ? 'Read-only 1-day reference from the loaded curve. Pricing resolves maturity-specific r(T) independently for every option leg.'
            : (useCurve
                ? 'Continuously compounded fallback used only when the market discount curve is unavailable or unusable.'
                : 'Continuously compounded discount rate used for every option leg while the market curve is disabled.');
        if (irLabelText) {
            irLabelText.textContent = curveReferenceReady
                ? 'Loaded Curve Short Rate r(1d) (%)'
                : 'Discount Rate Fallback r (%)';
        }
        if (irDisplay) {
            irDisplay.textContent = `${displayedPct.toFixed(2)}%`;
        }
        if (curveToggle) {
            curveToggle.checked = useCurve;
        }
        const curveRequestPending = state && state.discountCurveRequestPending === true;
        const historicalMode = _isHistoricalMode(state);
        if (loadLatestCurveBtn) {
            loadLatestCurveBtn.disabled = historicalMode || curveRequestPending;
            loadLatestCurveBtn.textContent = curveRequestPending
                ? 'Loading Latest Yield Curve…'
                : 'Reload Latest Yield Curve';
            loadLatestCurveBtn.title = historicalMode
                ? 'Historical replay uses a strict as-of curve and cannot load the latest live curve.'
                : 'Reload the newest cached SOFR / Treasury curve from the WebSocket backend; refresh official sources if the backend considers it stale.';
        }
        if (curveStatus) {
            const source = String(curve && curve.metadata && curve.metadata.source || '').trim();
            const asOf = String(curve && curve.asOf || '').trim();
            const sofrDate = String(curve && curve.sources && curve.sources.sofr
                && curve.sources.sofr.effectiveDate || '').trim();
            const treasuryDate = String(curve && curve.sources && curve.sources.treasury
                && curve.sources.treasury.effectiveDate || '').trim();
            const approximate = !!(curve && (
                curve.isProxy === true
                || (curve.metadata && curve.metadata.approximate === true)
            ));
            const error = String(state && state.discountCurveLastError || '').trim();
            const responseStatus = String(state && state.discountCurveLastResponseStatus || '').trim();
            if (curveRequestPending) {
                curveStatus.textContent = 'Loading the latest yield curve from the WebSocket backend…';
                curveStatus.title = '';
            } else if (!useCurve) {
                curveStatus.textContent = `Manual continuous discount rate active: ${pct.toFixed(2)}%.`;
            } else if (curve && curve.kind === 'discount' && Array.isArray(curve.points) && curve.points.length > 0) {
                const sourceLabel = source.includes('nyfed:sofr') && source.includes('treasury')
                    ? 'SOFR <=30d / Treasury CMT long-end'
                    : (source.includes('treasury') ? 'U.S. Treasury CMT' : (source || 'market'));
                const fallbackSummary = _resolveDiscountFallbackSummary(state);
                const fallbackWarning = fallbackSummary && fallbackSummary.fallbackCount > 0
                    ? ` ⚠ ${fallbackSummary.fallbackCount} of ${fallbackSummary.legCount} open legs are discounting at the manual ${pct.toFixed(2)}% fallback (${fallbackSummary.reasons.map(entry => `${entry.reason}×${entry.count}`).join(', ')}).`
                    : '';
                const refreshWarning = error
                    ? ` Refresh failed (${error}); keeping this curve until it becomes unusable, then ${pct.toFixed(2)}% fallback applies.`
                    : (fallbackWarning ? '' : ' Manual value is fallback only.');
                const loadConfirmation = state && state.discountCurveLastLoadWasManual === true
                    ? `Latest yield curve loaded successfully${responseStatus ? ` (${responseStatus})` : ''}: `
                    : '';
                const referenceExplanation = curveReferenceReady
                    ? ` Displayed short rate r(1d)=${displayedPct.toFixed(2)}%; each option leg is discounted with its maturity-specific r(T).`
                    : '';
                curveStatus.textContent = `${loadConfirmation}${sourceLabel} curve ${asOf || '(date unavailable)'}${approximate ? ' · discount proxy' : ''}.${referenceExplanation}${fallbackWarning}${refreshWarning}`;
                curveStatus.title = sofrDate || treasuryDate
                    ? `Snapshot ${curve.snapshotId || curve.metadata && curve.metadata.snapshotId || '--'}; SOFR effective ${sofrDate || '--'}; Treasury effective ${treasuryDate || '--'}. SOFR Averages are backward-looking diagnostics only.`
                    : '';
            } else {
                curveStatus.textContent = `Unified discount curve unavailable${error ? `: ${error}` : ''}; using ${pct.toFixed(2)}% fallback.`;
                curveStatus.title = '';
            }
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

    function _syncGreeksUi(state) {
        const toggleBtn = _getElement('toggleGreeksBtn');
        const status = _getElement('greeksStatusText');
        const enabled = !!(state && state.greeksEnabled === true);

        if (toggleBtn) {
            toggleBtn.textContent = enabled ? 'Disable Greeks' : 'Enable Greeks';
            toggleBtn.className = enabled ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
            toggleBtn.title = enabled
                ? 'Turn off live Greeks and hide Group Delta to keep the UI lighter.'
                : 'Turn on live Greeks and show Group Delta in live groups.';
        }

        if (status) {
            status.textContent = enabled
                ? 'Greeks enabled. Group Delta will appear in live groups as live option delta arrives.'
                : 'Off by default to keep the live UI responsive. Enable only when you want Group Delta.';
        }
    }

    function _syncSimTimeBasisUi(state, options = {}) {
        const basisSelect = _getElement('simTimeBasis');
        const weightInput = _getElement('simWeekendWeight');
        const impliedReceived = _getElement('simImpliedLambdaReceived');
        const display = _getElement('simTimeBasisDisplay');
        if (!basisSelect) {
            return;
        }

        const sessionLogic = globalScope.OptionComboSessionLogic;
        const basis = sessionLogic.normalizeSimTimeBasis(state && state.simTimeBasis);
        const weight = sessionLogic.normalizeSimWeekendWeight(state && state.simWeekendWeight);
        const effectiveWeight = sessionLogic.resolveSimWeekendWeight(basis, weight);
        const useImplied = state && state.simUseImpliedLambda === true;
        const impliedEntry = state && state.simImpliedLambdaEntry ? state.simImpliedLambdaEntry : null;
        const impliedCoverage = state && state.simImpliedLambdaCoverage
            && typeof state.simImpliedLambdaCoverage === 'object'
            ? state.simImpliedLambdaCoverage
            : null;
        const coverageStatus = String(impliedCoverage && impliedCoverage.status || '').trim();
        const requiredDates = Array.isArray(impliedCoverage && impliedCoverage.requiredDates)
            ? impliedCoverage.requiredDates.filter(Boolean)
            : [];
        const missingDates = Array.isArray(impliedCoverage && impliedCoverage.missingDates)
            ? impliedCoverage.missingDates.filter(Boolean)
            : [];
        const affectedLegIds = Array.isArray(impliedCoverage && impliedCoverage.affectedLegIds)
            ? impliedCoverage.affectedLegIds.filter(Boolean)
            : [];
        const coverageComplete = impliedCoverage
            && (impliedCoverage.usable === true || impliedCoverage.ready === true)
            && (coverageStatus === 'complete' || coverageStatus === 'ok');
        const coverageNotRequired = coverageStatus === 'not_required';
        const contractTimingUnavailable = coverageStatus === 'exact_contract_timing_missing';
        const acceptedImpliedSource = impliedEntry && (
            impliedEntry.varianceSource === 'straddle'
            || (impliedEntry.varianceSource === 'vendor_iv'
                && impliedEntry.quality
                && impliedEntry.quality.estimationMode === 'best_effort'
                && impliedEntry.quality.sourceQuoteEvidence === 'vendor_atm_iv_fallback')
        );
        const impliedActive = basis === 'weighted' && useImplied && coverageComplete && impliedEntry
            && acceptedImpliedSource
            && impliedEntry.quality && impliedEntry.quality.status === 'ok'
            && impliedEntry.byDate && Object.keys(impliedEntry.byDate).length > 0;
        const hasAcceptedImpliedEntry = useImplied && impliedEntry
            && acceptedImpliedSource
            && impliedEntry.quality && impliedEntry.quality.status === 'ok'
            && impliedEntry.byDate && Object.keys(impliedEntry.byDate).length > 0;
        const showReceivedIndicator = basis === 'weighted' && hasAcceptedImpliedEntry;

        basisSelect.value = basis;
        if (weightInput) {
            // Scalar lambda remains available as a research/display lens, but
            // it is never an accuracy-gate substitute for required V2 dates.
            weightInput.style.display = basis === 'weighted' && !showReceivedIndicator ? '' : 'none';
            weightInput.disabled = basis === 'weighted' && useImplied;
            weightInput.title = useImplied
                ? 'IVTS implied λ is enabled. Uncheck only for scalar research; live projections across closures will remain blocked.'
                : 'Diagnostic weekend/holiday variance weight λ: 0 = trading-day clock, 1 = calendar clock. It cannot bypass required structured coverage.';
            if (options.keepWeightInputValue !== true) {
                weightInput.value = weight.toFixed(2);
            }
        }
        if (impliedReceived) {
            impliedReceived.style.display = showReceivedIndicator ? 'flex' : 'none';
            impliedReceived.textContent = '已经从IVTS接受到';
            impliedReceived.title = showReceivedIndicator
                ? '当前页面已经接收到并通过校验的 IVTS 结构化 implied λ；0.30 标量不参与当前计算。'
                : '';
        }
        if (display) {
            if (basis === 'weighted' && useImplied) {
                if (impliedActive) {
                    display.textContent = `λ=IVTS·${requiredDates.length}d covered`;
                } else if (coverageNotRequired) {
                    display.textContent = 'λ not required';
                } else if (contractTimingUnavailable) {
                    display.textContent = 'λ pending contract timing';
                } else {
                    display.textContent = 'λ=IVTS unavailable';
                }
            } else {
                display.textContent = impliedCoverage && impliedCoverage.required === true
                    && impliedCoverage.ready !== true
                    ? `λ=${effectiveWeight.toFixed(2)} diagnostic · projection blocked`
                    : `λ=${effectiveWeight.toFixed(2)}`;
            }
        }

        const impliedLabel = _getElement('simImpliedLambdaLabel');
        const impliedCheckbox = _getElement('simUseImpliedLambda');
        const impliedStatus = _getElement('simImpliedLambdaStatus');
        if (impliedLabel) {
            impliedLabel.style.display = basis === 'weighted' ? '' : 'none';
        }
        if (impliedCheckbox) {
            impliedCheckbox.checked = useImplied;
        }
        if (impliedStatus) {
            impliedStatus.style.color = '';
            impliedStatus.style.fontWeight = '';
            if (basis !== 'weighted') {
                impliedStatus.textContent = useImplied
                    ? `IVTS V2 is paused while ${basis} time is selected`
                    : '';
            } else if (!useImplied) {
                impliedStatus.textContent = `Scalar λ=${weight.toFixed(2)} is explicitly selected.`;
            } else if (coverageNotRequired) {
                impliedStatus.style.color = '#4b5563';
                impliedStatus.textContent = 'No implied λ is required: no open option leg crosses a weekend or full-day exchange closure from the quote date to expiry.';
            } else if (contractTimingUnavailable) {
                const identity = state && state.underlyingContractMonth
                    ? `${state.underlyingSymbol} ${state.underlyingContractMonth}`
                    : ((state && state.underlyingSymbol) || '--');
                const legsText = affectedLegIds.length
                    ? ` Affected open legs: ${affectedLegIds.join(', ')}.`
                    : '';
                impliedStatus.style.color = '#b45309';
                impliedStatus.style.fontWeight = '600';
                impliedStatus.textContent = `Exact IB contract timing is unavailable for ${identity}.${legsText} This timing gate is independent of weekend/holiday λ; closure coverage has not been evaluated yet.`;
            } else if (impliedActive) {
                const median = Number.isFinite(impliedEntry.medianLambda)
                    ? impliedEntry.medianLambda.toFixed(2)
                    : '--';
                const asOf = impliedEntry.quoteAsOf || impliedEntry.anchorDate || '';
                const identity = impliedEntry.underlyingContractMonth
                    ? `${impliedEntry.symbol} ${impliedEntry.underlyingContractMonth}`
                    : impliedEntry.symbol;
                const coverage = Number.isFinite(impliedEntry.weekendCount)
                    ? `${impliedEntry.weekendCount} weekend${impliedEntry.weekendCount === 1 ? '' : 's'} (${Object.keys(impliedEntry.byDate).length} dates)`
                    : `${Object.keys(impliedEntry.byDate).length} dates`;
                const range = impliedEntry.coverageStart && impliedEntry.coverageEnd
                    ? `${impliedEntry.coverageStart}→${impliedEntry.coverageEnd}`
                    : 'covered dates only';
                const methodology = impliedEntry.methodology && typeof impliedEntry.methodology === 'object'
                    ? impliedEntry.methodology
                    : {};
                const model = methodology.pricingModel === 'black76'
                    ? 'Black-76'
                    : (methodology.pricingModel === 'bsm-spot' ? 'BSM' : 'model unknown');
                const bestEffort = impliedEntry.quality
                    && impliedEntry.quality.estimationMode === 'best_effort';
                const estimateLabel = bestEffort
                    ? `best-effort current-BBO estimate${Number.isFinite(impliedEntry.quality.usableExpiryCount)
                        ? ` from ${impliedEntry.quality.usableExpiryCount} usable expiries`
                        : ''}${Number.isFinite(impliedEntry.quality.skippedExpiryCount)
                        ? ` (${impliedEntry.quality.skippedExpiryCount} skipped)`
                        : ''}`
                    : 'strict coherent snapshot';
                const discounting = methodology.discounting
                    && typeof methodology.discounting === 'object'
                    ? methodology.discounting
                    : {};
                let rate = Number.isFinite(methodology.interestRate)
                    ? `, fallback r=${(methodology.interestRate * 100).toFixed(2)}%`
                    : '';
                if (Number(discounting.curveRowCount) > 0) {
                    rate = `, ${discounting.isProxy ? 'reference discount proxy' : 'discount curve'} r(T)`
                        + `${discounting.curveAsOf ? ` ${discounting.curveAsOf}` : ''}`
                        + `${Number(discounting.fallbackRowCount) > 0
                            ? ` + ${discounting.fallbackRowCount} fallback row(s)`
                            : ''}`;
                }
                impliedStatus.style.color = '#15803d';
                impliedStatus.textContent = `${identity}: coverage complete for ${requiredDates.length} required non-trading date${requiredDates.length === 1 ? '' : 's'} · anchor ${impliedEntry.anchorDate || '--'}, ${coverage}, ${range}, median ${median}${asOf ? ` @ ${asOf}` : ''} · V2 straddle ${estimateLabel} (${model}${rate})`;
            } else {
                const identity = state && state.underlyingContractMonth
                    ? `${state.underlyingSymbol} ${state.underlyingContractMonth}`
                    : ((state && state.underlyingSymbol) || '--');
                const datesToList = missingDates.length ? missingDates : requiredDates;
                const datesText = datesToList.length
                    ? ` Missing non-trading dates: ${datesToList.join(', ')}.`
                    : '';
                const legsText = affectedLegIds.length
                    ? ` Affected open legs: ${affectedLegIds.join(', ')}.`
                    : '';
                const reasonByStatus = {
                    incomplete_coverage: 'coverage is incomplete',
                    incomplete: 'coverage is incomplete',
                    identity_mismatch: 'the symbol or quote-date identity does not match the portfolio',
                    calendar_mismatch: 'the curve uses a different exchange calendar',
                    pricing_model_mismatch: 'the curve uses a different pricing model',
                    futures_month_mismatch: 'the curve was solved on a different underlying futures month',
                    multiple_futures_months: 'open FOP legs span multiple futures months; one λ curve cannot cover them',
                    calendar_unavailable: 'the required exchange calendar cannot be verified',
                    weighted_basis_required: 'live closure-crossing projections require Weighted weekends (λ)',
                    implied_lambda_disabled: 'structured IVTS implied λ is disabled but is required across closures',
                    missing_entry: 'no fresh matching V2 curve is loaded',
                    missing: 'no fresh matching V2 curve is loaded',
                    quote_timing_unavailable: 'the live quote timestamp is unavailable',
                    simulation_timing_unavailable: 'the simulation target timestamp is unavailable',
                    ambiguous_near_leg_cutoff: 'near legs have different expiry cutoffs',
                    deferred_settlement_fixing_unsupported: 'the target leg settles from a later special fixing, not the last-trade spot value',
                    timing_runtime_unavailable: 'the exact-time pricing runtime is unavailable',
                };
                const reason = reasonByStatus[coverageStatus] || 'coverage has not been validated';
                const closureCoverageRequired = requiredDates.length > 0
                    || missingDates.length > 0
                    || (impliedCoverage && impliedCoverage.required === true);
                const closureTail = closureCoverageRequired
                    ? ` Live projections that cross a weekend or full holiday require complete structured coverage; scalar λ=${weight.toFixed(2)} is diagnostic only and cannot bypass this gate.`
                    : '';
                impliedStatus.style.color = '#dc2626';
                impliedStatus.style.fontWeight = '600';
                impliedStatus.textContent = `Implied λ unavailable for ${identity}: ${reason}.${datesText}${legsText}${closureTail}`;
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
            && _getDateUtils()
            && typeof _getDateUtils().diffDays === 'function'
            ? _getDateUtils().diffDays(state.baseDate, effectiveReplayDate)
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
        const simulatedDateHint = _getElement('simulatedDateHint');

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

        const quoteReferenceDate = _getQuoteReferenceDate(state);
        let effectiveSimulationDate = _normalizeDateStr(state && state.simulatedDate) || quoteReferenceDate;
        if (quoteReferenceDate && effectiveSimulationDate
            && _compareDates(effectiveSimulationDate, quoteReferenceDate) < 0) {
            effectiveSimulationDate = quoteReferenceDate;
            state.simulatedDate = effectiveSimulationDate;
        }

        simDateInput.min = quoteReferenceDate;
        simDateInput.max = '';
        const dateUtils = _getDateUtils();
        const days = dateUtils
            && typeof dateUtils.diffDays === 'function'
            ? dateUtils.diffDays(quoteReferenceDate, effectiveSimulationDate)
            : 0;
        const calendarContext = _resolveCalendarContext(state);
        const tradDays = dateUtils
            && typeof dateUtils.calendarToTradingDays === 'function'
            ? dateUtils.calendarToTradingDays(
                quoteReferenceDate, effectiveSimulationDate,
                calendarContext.calendarKey, calendarContext.observedTradingDates
            )
            : null;
        simDateInput.value = effectiveSimulationDate || quoteReferenceDate;
        dpSlider.min = '0';
        if (!dpSlider.max || parseInt(dpSlider.max, 10) < days) {
            dpSlider.max = String(Math.max(days, 365));
        }
        dpSlider.value = String(days);
        dpDisplay.textContent = tradDays === null
            ? `calendar unavailable / +${days} cd`
            : `+${tradDays} td / +${days} cd`;

        // A civil date is not a sufficiently precise valuation target for a
        // front-leg expiry. Surface the actual portfolio-global instant that
        // pricing uses so a product-profile fallback cannot look as precise as
        // an IB ContractDetails cutoff.
        if (simulatedDateHint) {
            const timing = state && state.simulationTiming;
            simulatedDateHint.style.color = '';
            simulatedDateHint.style.fontWeight = '';
            simulatedDateHint.title = '';
            if (!timing || typeof timing !== 'object') {
                simulatedDateHint.hidden = true;
                simulatedDateHint.textContent = '';
            } else if (timing.available !== true || !timing.targetAsOf) {
                const missingIds = Array.isArray(timing.missingContractTimingLegIds)
                    ? timing.missingContractTimingLegIds.filter(Boolean)
                    : [];
                const deferredIds = Array.isArray(timing.deferredSettlementLegIds)
                    ? timing.deferredSettlementLegIds.filter(Boolean)
                    : [];
                const missingText = missingIds.length
                    ? ` Missing contract timing for leg${missingIds.length === 1 ? '' : 's'}: ${missingIds.join(', ')}.`
                    : '';
                const settlementText = timing.status === 'deferred_settlement_fixing_unsupported'
                    ? ` The payoff${deferredIds.length ? ` for ${deferredIds.join(', ')}` : ''} is not known at the last-trade cutoff because settlement uses a later special fixing.`
                    : '';
                simulatedDateHint.hidden = false;
                simulatedDateHint.style.color = '#dc2626';
                simulatedDateHint.style.fontWeight = '600';
                simulatedDateHint.textContent = `Exact simulation instant unavailable (${timing.status || 'unknown'}); projection fails closed.${missingText}${settlementText}`;
                simulatedDateHint.title = missingIds.length
                    ? 'Keep TWS connected and resubscribe until qualified ContractDetails is returned for every listed leg.'
                    : 'The projection is intentionally unavailable rather than using an unsafe time or settlement fallback.';
            } else {
                const targetMs = Date.parse(timing.targetAsOf);
                const quoteMs = Date.parse(String(state && state.liveQuoteAsOf || ''));
                const hours = Number.isFinite(targetMs) && Number.isFinite(quoteMs)
                    ? Math.max(0, (targetMs - quoteMs) / 3600000)
                    : null;
                const hoursText = Number.isFinite(hours)
                    ? ` · ${hours.toFixed(hours < 10 ? 2 : 1)} calendar hours from quote`
                    : '';
                const source = String(timing.source || 'exact').trim();
                // Only a near-leg profile cutoff is a degraded stand-in: a leg
                // really does expire on the target date and IB simply has not
                // supplied its last-trade instant yet, so waiting helps.  A plain
                // product-profile cutoff means no open leg expires that day at
                // all, so there is no contract-level cutoff to wait for and the
                // product close *is* the definition of the instant.
                const profileFallback = source === 'near-leg-profile-cutoff';
                const sourceText = source === 'near-leg-contract-cutoff'
                    ? 'IB near-leg cutoff'
                    : (source === 'live-quote'
                        ? 'live quote instant'
                        : (source === 'explicit'
                            ? 'explicit instant'
                            : 'product-profile cutoff'));
                simulatedDateHint.hidden = false;
                simulatedDateHint.style.color = profileFallback ? '#b45309' : '#4b5563';
                simulatedDateHint.textContent = `Pricing target: ${timing.targetAsOf} (${sourceText})${hoursText}.`
                    + (profileFallback
                        ? ' Exact IB last-trade time is not yet available; the product fallback is in use.'
                        : '');
                simulatedDateHint.title = profileFallback
                    ? 'Keep TWS connected until ContractDetails supplies the contract-specific last-trade cutoff.'
                    : (source === 'product-profile-cutoff'
                        ? 'No open leg expires on this date, so the product close defines the instant. '
                            + 'All live legs are valued there.'
                        : 'All live legs are valued at this same instant.');
            }
        }
    }

    function refreshBoundDynamicControls() {
        if (!_boundState) return;
        _syncPrimaryControlPanelDialogUi(_boundState);
        _syncMarketDataModeUI(_boundState);
        _syncGreeksUi(_boundState);
        _syncSimTimeBasisUi(_boundState);
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
        refreshForwardRatePanel();
        refreshFuturesPoolPanel();
    }

    function refreshForwardRatePanel() {
        if (!_boundState) return;
        if (_shouldPauseDynamicControlRefresh('forwardRatePanel')) {
            _renderForwardRateStatus(_boundState);
            return;
        }
        _renderForwardRateSamples(_boundState, _boundDeps || {});
    }

    function refreshFuturesPoolPanel() {
        if (!_boundState) return;
        if (_shouldPauseDynamicControlRefresh('futuresPoolPanel')) {
            _renderFuturesPoolStatus(_boundState);
            return;
        }
        _renderFuturesPool(_boundState, _boundDeps || {});
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
            requestDiscountCurveSnapshot,
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
            requestDiscountCurveSnapshot,
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
                state.liveQuoteDate = '';
                state.liveQuoteAsOf = '';
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
            if (symbolChanged) {
                state.liveQuoteDate = '';
                state.liveQuoteAsOf = '';
                state.simImpliedLambdaEntry = null;
                state.simImpliedLambdaFileEntry = null;
            }
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
                if (cleaned !== state.underlyingContractMonth) {
                    state.simImpliedLambdaEntry = null;
                    state.simImpliedLambdaFileEntry = null;
                }
                state.underlyingContractMonth = cleaned;
                underlyingContractMonthInput.value = cleaned;
            });
            underlyingContractMonthInput.addEventListener('change', (e) => {
                const cleaned = String(e.target.value || '').replace(/\D/g, '').slice(0, 6);
                const contractMonthChanged = cleaned !== state.underlyingContractMonth;
                state.underlyingContractMonth = cleaned;
                underlyingContractMonthInput.value = cleaned;
                if (contractMonthChanged) {
                    state.simImpliedLambdaEntry = null;
                    state.simImpliedLambdaFileEntry = null;
                }
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
        simDateInput.min = _getQuoteReferenceDate(state);

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

            const quoteReferenceDate = _getQuoteReferenceDate(state);
            if (_compareDates(newDateStr, quoteReferenceDate) < 0) {
                newDateStr = quoteReferenceDate;
                simDateInput.value = quoteReferenceDate;
            }
            state.simulatedDate = newDateStr;
            const days = diffDays(quoteReferenceDate, state.simulatedDate);
            const calendarContext = _resolveCalendarContext(state);
            const tradDays = calendarToTradingDays(
                quoteReferenceDate, state.simulatedDate,
                calendarContext.calendarKey, calendarContext.observedTradingDates
            );
            dpSlider.value = days;
            const dpDisplay = _getElement('daysPassedDisplay');
            if (dpDisplay) {
                dpDisplay.textContent = tradDays === null
                    ? `calendar unavailable / +${days} cd`
                    : `+${tradDays} td / +${days} cd`;
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
            const quoteReferenceDate = _getQuoteReferenceDate(state);
            state.simulatedDate = addDays(quoteReferenceDate, dNum);
            simDateInput.value = state.simulatedDate;
            const calendarContext = _resolveCalendarContext(state);
            const tradDays = calendarToTradingDays(
                quoteReferenceDate, state.simulatedDate,
                calendarContext.calendarKey, calendarContext.observedTradingDates
            );
            const dpDisplay = _getElement('daysPassedDisplay');
            if (dpDisplay) {
                dpDisplay.textContent = tradDays === null
                    ? `calendar unavailable / +${dNum} cd`
                    : `+${tradDays} td / +${dNum} cd`;
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
        const useMarketDiscountCurveInput = _getElement('useMarketDiscountCurve');
        const loadLatestDiscountCurveBtn = _getElement('loadLatestDiscountCurveBtn');
        if (irInput) {
            irInput.addEventListener('input', (e) => {
                const pct = parseFloat(e.target.value);
                if (!Number.isFinite(pct)) return;
                state.interestRate = pct / 100.0;
                if (irDisplay) irDisplay.textContent = `${pct.toFixed(2)}%`;
                _syncInterestRateUI(state);
                updateDerivedValues();
            });
        }
        if (useMarketDiscountCurveInput) {
            useMarketDiscountCurveInput.addEventListener('change', (e) => {
                state.useMarketDiscountCurve = e.target.checked === true;
                _syncInterestRateUI(state);
                if (state.useMarketDiscountCurve
                    && _boundDeps
                    && typeof _boundDeps.requestDiscountCurveSnapshot === 'function') {
                    _boundDeps.requestDiscountCurveSnapshot();
                }
                updateDerivedValues();
            });
        }
        if (loadLatestDiscountCurveBtn) {
            loadLatestDiscountCurveBtn.addEventListener('click', () => {
                state.useMarketDiscountCurve = true;
                if (useMarketDiscountCurveInput) {
                    useMarketDiscountCurveInput.checked = true;
                }
                const requested = !!(_boundDeps
                    && typeof _boundDeps.requestDiscountCurveSnapshot === 'function'
                    && _boundDeps.requestDiscountCurveSnapshot({
                        manual: true,
                        refresh: true,
                    }));
                if (!requested && !String(state.discountCurveLastError || '').trim()) {
                    state.discountCurveLastError = 'The latest yield curve request could not be sent.';
                }
                _syncInterestRateUI(state);
                updateDerivedValues();
            });
        }

        const ivInput = _getElement('ivOffset');
        const ivSlider = _getElement('ivOffsetSlider');
        const ivDisplay = _getElement('ivOffsetDisplay');
        const toggleGreeksBtn = _getElement('toggleGreeksBtn');
        const togglePrimaryControlPanelBtn = _getElement('togglePrimaryControlPanelBtn');
        const simulationControlsDialog = _getElement('simulationControlsDialog');
        const allowLiveComboOrdersInput = _getElement('allowLiveComboOrders');
        const liveComboOrderAccountSelect = _getElement('liveComboOrderAccountSelect');

        const doc = globalScope.document;
        if (simulationControlsDialog && doc && doc.body
            && simulationControlsDialog.parentNode !== doc.body
            && typeof doc.body.appendChild === 'function') {
            doc.body.appendChild(simulationControlsDialog);
        }

        if (simulationControlsDialog) {
            // A persisted sidebar-collapse preference must never reopen a modal
            // during bootstrap or JSON import. The dialog always starts closed.
            state.primaryControlPanelCollapsed = true;
            _primaryControlPanelDialogOpen = false;
        } else if (typeof state.primaryControlPanelCollapsed !== 'boolean') {
            state.primaryControlPanelCollapsed = false;
        }
        _syncPrimaryControlPanelDialogUi(state);

        const closeSimulationControlsDialog = (restoreFocus = true) => {
            if (!simulationControlsDialog) return;
            state.primaryControlPanelCollapsed = true;
            _primaryControlPanelDialogOpen = false;
            _syncPrimaryControlPanelDialogUi(state);
            const returnFocus = simulationControlsDialog.__simulationControlsReturnFocus;
            simulationControlsDialog.__simulationControlsReturnFocus = null;
            if (restoreFocus && returnFocus && typeof returnFocus.focus === 'function') {
                returnFocus.focus();
            }
        };

        const openSimulationControlsDialog = () => {
            if (!simulationControlsDialog) return;
            simulationControlsDialog.__simulationControlsReturnFocus = doc && doc.activeElement
                ? doc.activeElement
                : togglePrimaryControlPanelBtn;
            state.primaryControlPanelCollapsed = true;
            _primaryControlPanelDialogOpen = true;
            _syncPrimaryControlPanelDialogUi(state);
            const panel = typeof simulationControlsDialog.querySelector === 'function'
                ? simulationControlsDialog.querySelector('.simulation-controls-dialog-panel')
                : null;
            if (panel && typeof panel.focus === 'function') {
                panel.focus();
            }
        };

        if (togglePrimaryControlPanelBtn
            && typeof togglePrimaryControlPanelBtn.addEventListener === 'function'
            && togglePrimaryControlPanelBtn.__primaryControlPanelBound !== true) {
            togglePrimaryControlPanelBtn.__primaryControlPanelBound = true;
            togglePrimaryControlPanelBtn.addEventListener('click', openSimulationControlsDialog);
        }

        if (simulationControlsDialog
            && simulationControlsDialog.__simulationControlsDialogBound !== true) {
            simulationControlsDialog.__simulationControlsDialogBound = true;
            if (typeof simulationControlsDialog.querySelectorAll === 'function') {
                simulationControlsDialog.querySelectorAll('.simulationControlsDialogCloseBtn').forEach((button) => {
                    button.addEventListener('click', () => closeSimulationControlsDialog(true));
                });
            }
            if (typeof simulationControlsDialog.addEventListener === 'function') {
                simulationControlsDialog.addEventListener('click', (event) => {
                    if (event && event.target === simulationControlsDialog) {
                        closeSimulationControlsDialog(true);
                    }
                });
            }
            if (doc && typeof doc.addEventListener === 'function'
                && doc.__simulationControlsEscapeBound !== true) {
                doc.__simulationControlsEscapeBound = true;
                doc.addEventListener('keydown', (event) => {
                    if (event && event.key === 'Escape'
                        && _primaryControlPanelDialogOpen) {
                        closeSimulationControlsDialog(true);
                    }
                });
            }
        }

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

        const timeBasisSelect = _getElement('simTimeBasis');
        const weekendWeightInput = _getElement('simWeekendWeight');
        if (timeBasisSelect) {
            const sessionLogic = globalScope.OptionComboSessionLogic;
            _syncSimTimeBasisUi(state);
            timeBasisSelect.addEventListener('change', (e) => {
                state.simTimeBasis = sessionLogic.normalizeSimTimeBasis(e.target.value);
                // Derive before syncing so the implied-lambda status reflects
                // the entry peeked under the new basis.
                updateDerivedValues();
                _syncSimTimeBasisUi(state);
            });
            if (weekendWeightInput) {
                weekendWeightInput.addEventListener('input', (e) => {
                    state.simWeekendWeight = sessionLogic.normalizeSimWeekendWeight(e.target.value);
                    _syncSimTimeBasisUi(state, { keepWeightInputValue: true });
                    updateDerivedValues();
                });
            }
            const useImpliedLambdaInput = _getElement('simUseImpliedLambda');
            if (useImpliedLambdaInput) {
                useImpliedLambdaInput.addEventListener('change', (e) => {
                    state.simUseImpliedLambda = e.target.checked === true;
                    // Derive first so state.simImpliedLambdaEntry reflects the
                    // freshly peeked handoff before the status line renders.
                    updateDerivedValues();
                    _syncSimTimeBasisUi(state);
                });
            }
            const impliedLambdaLoadBtn = _getElement('simImpliedLambdaLoadBtn');
            const impliedLambdaFileInput = _getElement('simImpliedLambdaFileInput');
            if (impliedLambdaLoadBtn && impliedLambdaFileInput) {
                impliedLambdaLoadBtn.addEventListener('click', () => {
                    impliedLambdaFileInput.click();
                });
                impliedLambdaFileInput.addEventListener('change', async (e) => {
                    const file = e.target.files && e.target.files[0];
                    e.target.value = '';
                    if (!file) {
                        return;
                    }
                    const handoff = globalScope.OptionComboImpliedLambdaHandoff;
                    let entry = null;
                    let importMessage = '';
                    try {
                        const fileText = await file.text();
                        if (handoff && typeof handoff.parseImportDocumentDetailed === 'function') {
                            const parsed = handoff.parseImportDocumentDetailed(fileText);
                            entry = parsed && parsed.entry;
                            importMessage = parsed && parsed.message || '';
                        } else {
                            entry = handoff && typeof handoff.parseImportDocument === 'function'
                                ? handoff.parseImportDocument(fileText)
                                : null;
                        }
                    } catch (_) {
                        entry = null;
                    }
                    const status = _getElement('simImpliedLambdaStatus');
                    if (!entry) {
                        if (status) {
                            status.textContent = `implied-λ file rejected${importMessage ? `: ${importMessage}` : ''}`;
                        }
                        return;
                    }
                    // File selection is an explicit user override. It may
                    // intentionally replace a newer automatically synchronized
                    // curve for the same product/date.
                    const savedToStorage = handoff.saveSymbolEntry(
                        entry, undefined, undefined, { allowOlder: true }
                    );
                    const expectedKey = handoff.entryStorageKey(
                        state.underlyingSymbol,
                        state.underlyingContractMonth
                    );
                    const loadedKey = handoff.entryStorageKey(
                        entry.symbol,
                        entry.underlyingContractMonth
                    );
                    const expectedAnchor = String(state.liveQuoteDate || '').trim();
                    const identityMatches = expectedKey === loadedKey;
                    // A live quote date is mandatory V2 identity, not an
                    // optional filter. A file selected before the first live
                    // quote may be saved, but cannot become active yet.
                    const anchorMatches = !!expectedAnchor && entry.anchorDate === expectedAnchor;
                    // Keep a matching in-tab copy so an explicit file load
                    // works when localStorage is blocked.  A mismatched file
                    // may be stored for its own product, but is never active.
                    state.simImpliedLambdaFileEntry = identityMatches && anchorMatches ? entry : null;
                    state.simImpliedLambdaEntry = state.simImpliedLambdaFileEntry;
                    if (identityMatches && anchorMatches) {
                        state.simUseImpliedLambda = true;
                    }
                    updateDerivedValues();
                    _syncSimTimeBasisUi(state);
                    if (status && identityMatches && anchorMatches && !savedToStorage) {
                        status.textContent += ' — loaded for this tab (browser storage unavailable)';
                    }
                    if (status && !identityMatches) {
                        status.textContent = `V2 file is for ${loadedKey}, current product is ${expectedKey}; saved but not activated`;
                    } else if (status && !anchorMatches) {
                        status.textContent = expectedAnchor
                            ? `V2 file is anchored to ${entry.anchorDate}, current live quote date is ${expectedAnchor}; saved but not activated`
                            : `V2 file saved but not activated; wait for the first live quote to establish the exchange trade date`;
                    }
                });
            }
        }

        if (toggleGreeksBtn) {
            _syncGreeksUi(state);
            toggleGreeksBtn.addEventListener('click', () => {
                state.greeksEnabled = !(state.greeksEnabled === true);
                _syncGreeksUi(state);
                if (_getMarketDataMode(state) === 'live'
                    && typeof handleLiveSubscriptions === 'function') {
                    handleLiveSubscriptions();
                }
                updateDerivedValues();
            });
        }

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

    // Lightweight public refresh for derived Time Basis state. The app calls
    // this after repricing so explicit cross-tab implied-λ syncs, initial
    // bootstrap, and freshness expiry cannot leave the status text one state
    // behind the pricing engine.
    function refreshSimTimeBasisUi(state = _boundState) {
        const targetState = state || _boundState;
        if (!targetState) return;
        _syncSimTimeBasisUi(targetState);
    }

    // Keep the visible valuation instant in the same derived-state
    // transaction as pricing. Date inputs and the date slider both update
    // state before the app recomputes simulationTiming; the app calls this
    // lightweight hook immediately after that recomputation completes.
    function refreshSimulationDateUi(state = _boundState) {
        const targetState = state || _boundState;
        if (!targetState) return;
        _syncSimulationDateUi(targetState);
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
        refreshSimTimeBasisUi,
        refreshSimulationDateUi,
        refreshForwardRatePanel,
        refreshFuturesPoolPanel,
        resolvePricingInputMode: _getPricingInputMode,
        toggleSidebar,
        // Retain the legacy public key for callers that refresh saved sidebar UI.
        syncPrimaryControlPanelCollapseUi: _syncPrimaryControlPanelDialogUi,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
