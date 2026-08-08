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

    function getPricingContext() {
        return globalScope.OptionComboPricingContext && typeof globalScope.OptionComboPricingContext === 'object'
            ? globalScope.OptionComboPricingContext
            : null;
    }

    function resolveLiveQuoteReferenceDate(state) {
        const pricingContext = getPricingContext();
        const resolved = pricingContext && typeof pricingContext.resolveQuoteDate === 'function'
            ? pricingContext.resolveQuoteDate(state)
            : '';
        return resolved || state.liveQuoteDate || state.baseDate || state.simulatedDate || '';
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
        const liveQuoteReferenceDate = marketDataMode === 'live'
            ? resolveLiveQuoteReferenceDate(state)
            : '';
        const pricingContext = getPricingContext();
        const simulationDate = marketDataMode === 'historical'
            ? (state.simulatedDate && (!replayDate || state.simulatedDate >= replayDate)
                ? state.simulatedDate
                : (replayDate || state.baseDate || ''))
            : (pricingContext && typeof pricingContext.resolveSimulationDate === 'function'
                ? pricingContext.resolveSimulationDate(state)
                : (state.simulatedDate && (!liveQuoteReferenceDate || state.simulatedDate >= liveQuoteReferenceDate)
                    ? state.simulatedDate
                    : liveQuoteReferenceDate));
        if (marketDataMode === 'live' && simulationDate && state.simulatedDate !== simulationDate) {
            state.simulatedDate = simulationDate;
        }
        const simulationStartDate = marketDataMode === 'historical'
            ? state.baseDate
            : liveQuoteReferenceDate;
        const days = dateHelpers.diffDays(simulationStartDate, simulationDate);
        const calendarContext = resolveCalendarContext(state);
        const tradingDays = dateHelpers.calendarToTradingDays(
            simulationStartDate, simulationDate,
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
                        : (liveQuoteReferenceDate || state.baseDate)
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
            : liveQuoteReferenceDate;
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

    // ------------------------------------------------------------------
    // Workspace store dialogs
    //
    // Interaction primitives (prompt/confirm) are injectable via `hooks`
    // so the decision logic stays testable without a DOM. Only the
    // workspace list is a real <dialog>; every three-way decision is a
    // two-step confirm chain, which keeps Save/Discard/Cancel and the
    // conflict resolution available in any browser.
    // ------------------------------------------------------------------

    function _hookPrompt(hooks) {
        if (hooks && typeof hooks.prompt === 'function') return hooks.prompt;
        return typeof globalScope.prompt === 'function'
            ? globalScope.prompt.bind(globalScope)
            : null;
    }

    function _hookConfirm(hooks) {
        if (hooks && typeof hooks.confirm === 'function') return hooks.confirm;
        return typeof globalScope.confirm === 'function'
            ? globalScope.confirm.bind(globalScope)
            : () => false;
    }

    function _hookAlert(hooks) {
        if (hooks && typeof hooks.alert === 'function') return hooks.alert;
        return typeof globalScope.alert === 'function'
            ? globalScope.alert.bind(globalScope)
            : () => {};
    }

    function promptWorkspaceTitle(defaultTitle, hooks) {
        const promptFn = _hookPrompt(hooks);
        if (!promptFn) return null;
        const raw = promptFn('Workspace name:', defaultTitle || '');
        if (raw === null || raw === undefined) return null;
        const trimmed = String(raw).trim().slice(0, 120);
        return trimmed || null;
    }

    function confirmUnsavedChanges(hooks) {
        const confirmFn = _hookConfirm(hooks);
        if (confirmFn('You have unsaved changes. Save them to the workspace database first?')) {
            return 'save';
        }
        if (confirmFn('Discard the unsaved changes?')) {
            return 'discard';
        }
        return 'cancel';
    }

    function chooseConflictResolution(details, hooks) {
        const confirmFn = _hookConfirm(hooks);
        const revision = details && Number.isInteger(details.currentRevision)
            ? ` (now at revision ${details.currentRevision})`
            : '';
        if (confirmFn(
            `This workspace was changed elsewhere${revision}. `
            + 'Open the latest version? Your local edits will be discarded.'
        )) {
            return 'open-latest';
        }
        if (confirmFn('Keep your edits by saving them as a new copy?')) {
            return 'save-copy';
        }
        return 'cancel';
    }

    function confirmWorkspaceDelete(title, hooks) {
        const confirmFn = _hookConfirm(hooks);
        return confirmFn(
            `Delete workspace "${title}"? It disappears from the list; `
            + 'its revision history stays recoverable in the database.'
        );
    }

    function showWorkspaceStoreUnavailable(reason, hooks) {
        const alertFn = _hookAlert(hooks);
        alertFn(
            'The workspace database is unavailable'
            + (reason ? ` (${reason})` : '')
            + '. Market data keeps working; use Export/Import JSON in the meantime.'
        );
    }

    function formatWorkspaceListRow(doc) {
        const title = String(doc && doc.title || 'Untitled');
        const symbol = String(doc && doc.symbol || '').toUpperCase();
        const mode = doc && doc.marketDataMode === 'historical' ? 'historical' : 'live';
        const revision = Number.isInteger(doc && doc.revision) ? `rev ${doc.revision}` : '';
        const updated = String(doc && doc.updatedAtUtc || '').replace('T', ' ').slice(0, 16);
        return [title, symbol, mode, revision, updated].filter(Boolean).join(' · ');
    }

    function showWorkspaceListDialog(documents, hooks) {
        const doc = (hooks && hooks.documentRef) || (typeof document !== 'undefined' ? document : null);
        const rows = Array.isArray(documents) ? documents : [];
        if (!doc || typeof doc.createElement !== 'function' || !doc.body
            || typeof doc.body.appendChild !== 'function') {
            return Promise.resolve(_promptFallbackSelection(rows, hooks));
        }
        return new Promise((resolve) => {
            const dialog = doc.createElement('dialog');
            dialog.style.cssText = 'min-width:420px;max-width:640px;max-height:70vh;'
                + 'overflow:auto;border:1px solid #888;border-radius:8px;padding:1rem;';
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                if (typeof dialog.close === 'function') {
                    try { dialog.close(); } catch (error) { /* already closed */ }
                }
                if (typeof dialog.remove === 'function') dialog.remove();
                resolve(result);
            };

            const heading = doc.createElement('h3');
            heading.textContent = 'Open workspace';
            heading.style.cssText = 'margin:0 0 .75rem 0;';
            dialog.appendChild(heading);

            if (rows.length === 0) {
                const empty = doc.createElement('p');
                empty.textContent = 'No saved workspaces yet. Save creates the first one.';
                dialog.appendChild(empty);
            }

            for (const row of rows) {
                const line = doc.createElement('div');
                line.style.cssText = 'display:flex;align-items:center;gap:.5rem;'
                    + 'padding:.3rem 0;border-bottom:1px solid rgba(128,128,128,.25);';
                const label = doc.createElement('span');
                label.textContent = formatWorkspaceListRow(row);
                label.style.cssText = 'flex:1;';
                const openBtn = doc.createElement('button');
                openBtn.textContent = 'Open';
                openBtn.className = 'btn btn-primary btn-sm';
                openBtn.addEventListener('click', () => finish({
                    action: 'open', documentId: row.documentId,
                }));
                const deleteBtn = doc.createElement('button');
                deleteBtn.textContent = 'Delete';
                deleteBtn.className = 'btn btn-secondary btn-sm';
                deleteBtn.addEventListener('click', () => finish({
                    action: 'delete', documentId: row.documentId,
                }));
                line.appendChild(label);
                line.appendChild(openBtn);
                line.appendChild(deleteBtn);
                dialog.appendChild(line);
            }

            const cancelBtn = doc.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.className = 'btn btn-secondary btn-sm';
            cancelBtn.style.cssText = 'margin-top:.75rem;';
            cancelBtn.addEventListener('click', () => finish(null));
            dialog.appendChild(cancelBtn);
            if (typeof dialog.addEventListener === 'function') {
                dialog.addEventListener('close', () => finish(null));
            }

            doc.body.appendChild(dialog);
            if (typeof dialog.showModal === 'function') {
                dialog.showModal();
            } else {
                // No <dialog> support: fall back to the numbered prompt.
                finish(_promptFallbackSelection(rows, hooks));
            }
        });
    }

    function _promptFallbackSelection(rows, hooks) {
        const promptFn = _hookPrompt(hooks);
        if (!promptFn || rows.length === 0) return null;
        const listing = rows
            .map((row, index) => `${index + 1}. ${formatWorkspaceListRow(row)}`)
            .join('\n');
        const answer = promptFn(`Open workspace — enter a number:\n${listing}`, '');
        const index = parseInt(answer, 10);
        if (!Number.isInteger(index) || index < 1 || index > rows.length) return null;
        return { action: 'open', documentId: rows[index - 1].documentId };
    }

    globalScope.OptionComboSessionUI = {
        syncControlPanel,
        syncWorkspaceChrome,
        resolveDocumentTitle,
        resolveWorkspaceDescriptor,
        promptWorkspaceTitle,
        confirmUnsavedChanges,
        chooseConflictResolution,
        confirmWorkspaceDelete,
        showWorkspaceStoreUnavailable,
        formatWorkspaceListRow,
        showWorkspaceListDialog,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
