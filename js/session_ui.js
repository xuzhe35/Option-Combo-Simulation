/**
 * Session-level DOM synchronization helpers.
 */

(function attachSessionUI(globalScope) {
    function getProductRegistry() {
        return globalScope.OptionComboProductRegistry && typeof globalScope.OptionComboProductRegistry === 'object'
            ? globalScope.OptionComboProductRegistry
            : null;
    }

    function getControlPanelUi() {
        return globalScope.OptionComboControlPanelUI && typeof globalScope.OptionComboControlPanelUI === 'object'
            ? globalScope.OptionComboControlPanelUI
            : null;
    }

    function formatUnderlyingPriceInputValue(symbol, value) {
        const registry = getProductRegistry();
        if (registry && typeof registry.formatPriceInputValue === 'function') {
            return registry.formatPriceInputValue(symbol, value);
        }
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed.toFixed(2) : '';
    }

    function formatUnderlyingPriceDisplay(symbol, value) {
        const registry = getProductRegistry();
        if (registry && typeof registry.formatPriceDisplay === 'function') {
            return registry.formatPriceDisplay(symbol, value);
        }
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : '$0.00';
    }

    function getUnderlyingPriceInputStep(symbol) {
        const registry = getProductRegistry();
        if (registry && typeof registry.getPriceInputStep === 'function') {
            return registry.getPriceInputStep(symbol);
        }
        return '0.01';
    }

    function resolveCalendarContext(state) {
        const registry = getProductRegistry();
        const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
            ? registry.resolveUnderlyingProfile(state && state.underlyingSymbol)
            : null;
        return {
            calendarKey: String(profile && profile.calendarId || 'NYSE').toUpperCase(),
            observedTradingDates: state && state.marketDataMode === 'historical'
                ? state.historicalTradingDates
                : null,
        };
    }

    function normalizeImportedSessionTitle(rawTitle) {
        const normalized = String(rawTitle || '').trim();
        if (!normalized) {
            return '';
        }

        return normalized.replace(/\.json$/i, '');
    }

    function formatDocumentTitleDate(dateStr) {
        const normalized = String(dateStr || '').trim();
        const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) {
            return '';
        }

        const monthIndex = parseInt(match[2], 10) - 1;
        const day = parseInt(match[3], 10);
        const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        if (monthIndex < 0 || monthIndex >= monthLabels.length || !Number.isFinite(day)) {
            return '';
        }

        return `${monthLabels[monthIndex]}${day}`;
    }

    function resolveWorkspaceDescriptor(state) {
        const locked = state && state.marketDataModeLocked === true;
        const variant = state && (state.workspaceVariant === 'historical' || state.workspaceVariant === 'live')
            ? state.workspaceVariant
            : '';
        const marketDataMode = state && state.marketDataMode === 'historical' ? 'historical' : 'live';

        if (variant === 'historical' || (locked && marketDataMode === 'historical')) {
            return {
                variant: 'historical',
                locked,
                title: 'Historical Replay Workspace',
                subtitle: 'SQLite-backed historical replay with no live execution path.',
                bannerClassName: 'workspace-banner workspace-banner-historical',
                badgeText: 'Historical Only',
                body: 'SQLite replay only. This workspace does not route orders to IBKR/TWS.',
            };
        }

        if (variant === 'live' || (locked && marketDataMode === 'live')) {
            return {
                variant: 'live',
                locked,
                title: 'Live Trading Workspace',
                subtitle: 'Real-market workspace for IBKR subscriptions and live combo execution.',
                bannerClassName: 'workspace-banner workspace-banner-live',
                badgeText: 'Live Trading',
                body: 'Production market context. Treat this workspace as real unless proven otherwise.',
            };
        }

        return {
            variant: marketDataMode === 'historical' ? 'historical' : 'live',
            locked: false,
            title: 'Option Combo Simulator',
            subtitle: 'Shared analysis workspace for live trading and historical replay.',
            bannerClassName: 'workspace-banner',
            badgeText: '',
            body: '',
        };
    }

    function resolveDocumentTitle(state) {
        const descriptor = resolveWorkspaceDescriptor(state);
        const importedSessionTitle = normalizeImportedSessionTitle(state && state.importedSessionTitle);
        if (importedSessionTitle) {
            return importedSessionTitle;
        }

        const symbol = String(state && state.underlyingSymbol || '').trim().toUpperCase();
        const dateLabel = formatDocumentTitleDate((state && state.simulatedDate) || (state && state.baseDate) || '');

        if (symbol && dateLabel) {
            return `${symbol} ${dateLabel}`;
        }
        if (symbol) {
            return symbol;
        }

        return descriptor.title;
    }

    function syncWorkspaceChrome(state) {
        const descriptor = resolveWorkspaceDescriptor(state);
        const banner = document.getElementById('workspaceBanner');
        const badge = document.getElementById('workspaceBannerBadge');
        const title = document.getElementById('workspaceBannerTitle');
        const body = document.getElementById('workspaceBannerBody');
        const appTitle = document.getElementById('appTitle');
        const appSubtitle = document.getElementById('appSubtitle');

        if (appTitle) {
            appTitle.textContent = descriptor.title;
        }
        if (appSubtitle) {
            appSubtitle.textContent = descriptor.subtitle;
        }
        if (typeof document !== 'undefined') {
            document.title = resolveDocumentTitle(state);
        }

        if (!banner) {
            return;
        }

        const showBanner = descriptor.locked === true;
        banner.hidden = !showBanner;
        if (banner.style) {
            banner.style.display = showBanner ? '' : 'none';
        }
        banner.className = descriptor.bannerClassName;

        if (badge) {
            badge.textContent = descriptor.badgeText;
        }
        if (title) {
            title.textContent = descriptor.title;
        }
        if (body) {
            body.textContent = descriptor.body;
        }
    }

    function syncControlPanel(state, currencyFormatter, dateHelpers) {
        const interestRatePercent = state.interestRate * 100;
        const ivOffsetPercent = state.ivOffset * 100;
        const ivOffsetSign = ivOffsetPercent > 0 ? '+' : '';
        const marketDataMode = state.marketDataMode === 'historical' ? 'historical' : 'live';
        const workspaceDescriptor = resolveWorkspaceDescriptor(state);
        const replayDate = marketDataMode === 'historical'
            ? (state.historicalQuoteDate || state.baseDate || '')
            : '';
        const simulationDate = marketDataMode === 'historical'
            ? (state.simulatedDate && (!replayDate || state.simulatedDate >= replayDate)
                ? state.simulatedDate
                : (replayDate || state.baseDate || ''))
            : state.simulatedDate;
        const days = dateHelpers.diffDays(state.baseDate, simulationDate);
        const calendarContext = resolveCalendarContext(state);
        const tradingDays = dateHelpers.calendarToTradingDays(
            state.baseDate, simulationDate,
            calendarContext.calendarKey, calendarContext.observedTradingDates
        );
        const replayDays = marketDataMode === 'historical'
            ? dateHelpers.diffDays(state.baseDate, replayDate || state.baseDate)
            : 0;
        const replayTradingDays = marketDataMode === 'historical'
            ? dateHelpers.calendarToTradingDays(
                state.baseDate, replayDate || state.baseDate,
                calendarContext.calendarKey, calendarContext.observedTradingDates
            )
            : 0;

        syncWorkspaceChrome(state);

        const marketDataModeInput = document.getElementById('marketDataMode');
        const marketDataModeHint = document.getElementById('marketDataModeHint');
        const historicalQuoteDateGroup = document.getElementById('historicalQuoteDateGroup');
        const historicalQuoteDateInput = document.getElementById('historicalQuoteDate');
        const historicalQuoteDateLabel = document.getElementById('historicalQuoteDateLabel');
        const historicalQuoteDateHint = document.getElementById('historicalQuoteDateHint');
        const historicalReplayDateGroup = document.getElementById('historicalReplayDateGroup');
        const historicalReplayDateInput = document.getElementById('historicalReplayDate');
        const historicalReplayDateLabel = document.getElementById('historicalReplayDateLabel');
        const historicalReplayStartLabel = document.getElementById('historicalReplayStartLabel');
        const historicalReplayDaysDisplay = document.getElementById('historicalReplayDaysDisplay');
        const historicalReplaySlider = document.getElementById('historicalReplaySlider');
        const historicalTimelineControls = document.getElementById('historicalTimelineControls');
        const historicalTimelineHint = document.getElementById('historicalTimelineHint');
        const simulatedDateLabel = document.getElementById('simulatedDateLabel');
        const simulatedDateStartLabel = document.getElementById('simulatedDateStartLabel');
        const simulatedDateHint = document.getElementById('simulatedDateHint');
        const simulatedDateOffsetGroup = document.getElementById('simulatedDateOffsetGroup');
        document.getElementById('underlyingSymbol').value = state.underlyingSymbol;
        const underlyingContractMonthInput = document.getElementById('underlyingContractMonth');
        const underlyingContractMonthHint = document.getElementById('underlyingContractMonthHint');
        document.getElementById('underlyingPrice').step = getUnderlyingPriceInputStep(state.underlyingSymbol);
        document.getElementById('underlyingPrice').value = formatUnderlyingPriceInputValue(state.underlyingSymbol, state.underlyingPrice);
        document.getElementById('underlyingPriceSlider').step = getUnderlyingPriceInputStep(state.underlyingSymbol);
        document.getElementById('underlyingPriceSlider').value = state.underlyingPrice;
        document.getElementById('underlyingPriceDisplay').textContent = formatUnderlyingPriceDisplay(state.underlyingSymbol, state.underlyingPrice);

        if (marketDataModeInput) {
            marketDataModeInput.value = marketDataMode;
            marketDataModeInput.disabled = state.marketDataModeLocked === true;
            marketDataModeInput.title = state.marketDataModeLocked === true
                ? 'This workspace entry locks the market-data environment.'
                : '';
        }
        if (marketDataModeHint) {
            if (workspaceDescriptor.variant === 'historical' && workspaceDescriptor.locked === true) {
                marketDataModeHint.textContent = 'Historical replay workspace is locked to SQLite replay only. Real IBKR execution is unavailable here.';
            } else if (workspaceDescriptor.variant === 'live' && workspaceDescriptor.locked === true) {
                marketDataModeHint.textContent = 'Live trading workspace is locked to Production / Live IBKR. Treat this page as real-market context.';
            } else {
                marketDataModeHint.textContent = 'Live mode uses IBKR market data and can route real orders. Historical mode replays quotes from SQLite and blocks real execution.';
            }
        }
        if (historicalQuoteDateGroup) {
            historicalQuoteDateGroup.hidden = marketDataMode !== 'historical';
            historicalQuoteDateGroup.style.display = marketDataMode === 'historical' ? '' : 'none';
        }
        if (historicalQuoteDateLabel) {
            historicalQuoteDateLabel.textContent = 'Historical Start Date';
        }
        if (historicalQuoteDateInput) {
            historicalQuoteDateInput.value = marketDataMode === 'historical' ? (state.baseDate || '') : '';
        }
        if (historicalQuoteDateHint) {
            historicalQuoteDateHint.textContent = marketDataMode === 'historical'
                ? 'Sets the entry day for historical replay. Replay Date below moves forward from here.'
                : '';
        }
        if (historicalTimelineControls) {
            historicalTimelineControls.hidden = marketDataMode !== 'historical';
            historicalTimelineControls.style.display = marketDataMode === 'historical' ? '' : 'none';
        }
        if (historicalReplayDateGroup) {
            historicalReplayDateGroup.hidden = marketDataMode !== 'historical';
            historicalReplayDateGroup.style.display = marketDataMode === 'historical' ? '' : 'none';
        }
        if (historicalReplayDateLabel) {
            historicalReplayDateLabel.textContent = 'Replay Date';
        }
        if (historicalReplayDateInput) {
            historicalReplayDateInput.value = marketDataMode === 'historical'
                ? (state.historicalQuoteDate || state.baseDate || '')
                : '';
        }
        if (historicalReplayStartLabel) {
            historicalReplayStartLabel.textContent = 'Start';
        }
        if (historicalTimelineHint) {
            historicalTimelineHint.textContent = marketDataMode === 'historical'
                ? 'Replay Date steps through daily market closes.'
                : '';
        }
        if (simulatedDateLabel) {
            simulatedDateLabel.textContent = marketDataMode === 'historical' ? 'Simulation Date' : 'Simulated Date';
        }
        if (simulatedDateStartLabel) {
            simulatedDateStartLabel.textContent = marketDataMode === 'historical' ? 'Start' : 'Today';
        }
        if (simulatedDateHint) {
            simulatedDateHint.hidden = marketDataMode !== 'historical';
            simulatedDateHint.textContent = marketDataMode === 'historical'
                ? 'BSM target date for charts and theoretical P&L. It can be later than Replay Date.'
                : '';
        }
        if (simulatedDateOffsetGroup && simulatedDateOffsetGroup.style) {
            simulatedDateOffsetGroup.style.display = marketDataMode === 'historical' ? 'none' : '';
        }

        if (underlyingContractMonthInput) {
            const registry = getProductRegistry();
            const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
                ? registry.resolveUnderlyingProfile(state.underlyingSymbol)
                : null;
            const expectsFutureUnderlying = profile?.underlyingSecType === 'FUT';
            const defaultContractMonth = !expectsFutureUnderlying
                || !registry
                || typeof registry.resolveDefaultUnderlyingContractMonth !== 'function'
                ? ''
                : registry.resolveDefaultUnderlyingContractMonth(
                    state.underlyingSymbol,
                    marketDataMode === 'historical'
                        ? (replayDate || state.baseDate)
                        : (simulationDate || state.baseDate)
                );

            underlyingContractMonthInput.disabled = !expectsFutureUnderlying;
            underlyingContractMonthInput.placeholder = expectsFutureUnderlying
                ? (defaultContractMonth || 'YYYYMM')
                : 'N/A for STK / IND';
            underlyingContractMonthInput.value = state.underlyingContractMonth || '';

            if (underlyingContractMonthHint) {
                underlyingContractMonthHint.textContent = expectsFutureUnderlying
                    ? `Used to lock the underlying futures month for live FOP data. Default: ${defaultContractMonth || 'manual entry'}.`
                    : 'Not used for stocks or cash-settled index options.';
            }
        }

        const simulatedDateInput = document.getElementById('simulatedDate');
        simulatedDateInput.min = marketDataMode === 'historical'
            ? (replayDate || state.baseDate)
            : state.baseDate;
        simulatedDateInput.max = '';
        simulatedDateInput.value = simulationDate;

        document.getElementById('daysPassedSlider').value = days;
        document.getElementById('daysPassedDisplay').textContent = tradingDays === null
            ? `calendar unavailable / +${days} cd`
            : `+${tradingDays} td / +${days} cd`;
        if (historicalReplaySlider) {
            historicalReplaySlider.value = String(replayTradingDays === null ? 0 : replayTradingDays);
        }
        if (historicalReplayDaysDisplay) {
            historicalReplayDaysDisplay.textContent = replayTradingDays === null
                ? `calendar unavailable / +${replayDays} cd`
                : `+${replayTradingDays} td / +${replayDays} cd`;
        }

        document.getElementById('interestRate').value = interestRatePercent.toFixed(2);
        document.getElementById('interestRateDisplay').textContent = `${interestRatePercent.toFixed(2)}%`;

        document.getElementById('ivOffset').value = ivOffsetPercent.toFixed(2);
        document.getElementById('ivOffsetSlider').value = ivOffsetPercent;
        document.getElementById('ivOffsetDisplay').textContent = `${ivOffsetSign}${ivOffsetPercent.toFixed(2)}%`;

        const allowLiveComboOrdersInput = document.getElementById('allowLiveComboOrders');
        if (allowLiveComboOrdersInput) {
            allowLiveComboOrdersInput.checked = marketDataMode === 'live' && state.allowLiveComboOrders === true;
            allowLiveComboOrdersInput.disabled = marketDataMode !== 'live';
        }

        const controlPanelUi = getControlPanelUi();
        if (controlPanelUi && typeof controlPanelUi.refreshBoundDynamicControls === 'function') {
            controlPanelUi.refreshBoundDynamicControls();
        }
    }

    globalScope.OptionComboSessionUI = {
        syncControlPanel,
        syncWorkspaceChrome,
        resolveDocumentTitle,
        resolveWorkspaceDescriptor,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
