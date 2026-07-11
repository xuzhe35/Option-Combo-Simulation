/**
 * Delta Hedge configuration, global status, confirmation, and execution UI.
 * Domain decisions and broker transport remain in their dedicated modules.
 */

(function attachDeltaHedgeUi(globalScope) {
    const REASON_LABELS = {
        disabled: 'Disabled',
        greeks_disabled: 'Greeks disabled',
        not_live_mode: 'Live mode required',
        delta_unavailable: 'Delta unavailable',
        missing_hedge_instrument: 'Hedge symbol missing',
        invalid_hedge_delta_unit: 'Invalid hedge Delta unit',
        pending_hedge_order: 'Pending hedge order',
        inside_tolerance: 'Inside tolerance',
        quantity_rounds_to_zero: 'Quantity rounds to zero',
        exceeds_max_order_quantity: 'Max quantity exceeded',
        projected_outside_tolerance: 'Manual review required',
    };

    const AUTO_REASON_LABELS = {
        auto_disabled: 'Auto submit off',
        ddh_disabled: 'DDH disabled',
        not_live_mode: 'Live mode required',
        greeks_disabled: 'Greeks disabled',
        live_hedge_gate_off: 'Live hedge gate off',
        missing_account: 'Account missing',
        pending_request: 'Pending request',
        active_resting_order: 'Resting order locked',
        no_actionable_recommendation: 'No auto action',
        inside_tolerance: 'Inside tolerance',
        delta_unavailable: 'Delta unavailable',
        broker_preview_required: 'Auto preview required',
        preview_mismatch: 'Auto preview refreshing',
        preview_stale: 'Auto preview stale',
        stale_resting_order: 'Auto canceling stale order',
        auto_requires_lmt: 'Auto requires LMT',
        missing_limit_price: 'Limit price missing',
        exceeds_max_order_quantity: 'Max quantity exceeded',
        exceeds_max_notional: 'Max notional exceeded',
        max_daily_orders_reached: 'Daily limit reached',
        cooldown_active: 'Cooldown active',
        order_safety_unavailable: 'Order safety unavailable',
        position_snapshot_unavailable: 'Position snapshot unavailable',
        position_conflict_requires_confirmation: 'Position conflict requires manual confirmation',
    };

    const CONTROL_IDS = [
        'deltaHedgeEnabled',
        'deltaHedgeTargetDelta',
        'deltaHedgeTolerance',
        'deltaHedgeProactiveBuffer',
        'deltaHedgeSecType',
        'deltaHedgeSymbol',
        'deltaHedgeExchange',
        'deltaHedgeContractMonth',
        'deltaHedgeMultiplier',
        'deltaHedgeDeltaPerUnit',
        'deltaHedgeLimitPrice',
        'deltaHedgeOrderType',
        'deltaHedgeAccountDisplay',
        'deltaHedgeAllowLiveOrders',
        'deltaHedgeAutoSubmitEnabled',
        'deltaHedgeAutoCancelStaleOrders',
        'deltaHedgeMaxOrderQuantity',
        'deltaHedgeAutoMaxNotional',
        'deltaHedgeAutoMaxOrdersPerDay',
        'deltaHedgeCooldownSeconds',
        'deltaHedgeAutoPreviewMaxAgeSeconds',
        'deltaHedgeAutoStatus',
        'deltaHedgeRecommendationPreviewBtn',
        'deltaHedgeBrokerPreviewBtn',
        'deltaHedgeSubmitBtn',
        'deltaHedgeCancelBtn',
        'deltaHedgeClearBtn',
    ];

    function _getElement(id) {
        if (!globalScope.document || typeof globalScope.document.getElementById !== 'function') {
            return null;
        }
        return globalScope.document.getElementById(id);
    }

    function _setText(id, text) {
        const el = _getElement(id);
        if (el) {
            el.textContent = text;
        }
    }

    function _setHidden(id, hidden) {
        const el = _getElement(id);
        if (!el) return;
        el.hidden = hidden === true;
        if (el.style) {
            el.style.display = hidden === true ? 'none' : '';
        }
    }

    function _openDeltaHedgeDialog(trigger) {
        const dialog = _getElement('deltaHedgeDialog');
        if (!dialog || !dialog.style) {
            return;
        }
        dialog.__deltaHedgeReturnFocus = trigger || null;
        dialog.style.display = 'flex';
        if (typeof dialog.setAttribute === 'function') {
            dialog.setAttribute('aria-hidden', 'false');
        }
        const firstControl = _getElement('deltaHedgeEnabled');
        if (firstControl && typeof firstControl.focus === 'function') {
            firstControl.focus();
        }
    }

    function _closeDeltaHedgeDialog() {
        const dialog = _getElement('deltaHedgeDialog');
        if (!dialog || !dialog.style) {
            return;
        }
        dialog.style.display = 'none';
        if (typeof dialog.setAttribute === 'function') {
            dialog.setAttribute('aria-hidden', 'true');
        }
        const returnFocus = dialog.__deltaHedgeReturnFocus;
        dialog.__deltaHedgeReturnFocus = null;
        if (returnFocus && typeof returnFocus.focus === 'function') {
            returnFocus.focus();
        }
    }

    function _bindDialogControls() {
        const dialog = _getElement('deltaHedgeDialog');
        if (dialog && globalScope.document && globalScope.document.body
            && dialog.parentNode !== globalScope.document.body
            && typeof globalScope.document.body.appendChild === 'function') {
            globalScope.document.body.appendChild(dialog);
        }
        const openButtons = [
            _getElement('openDeltaHedgeDialogBtn'),
            _getElement('openDeltaHedgeDialogGlobalBtn'),
        ].filter(Boolean);
        const bindingTarget = dialog || openButtons[0];
        if (!bindingTarget || bindingTarget.__deltaHedgeDialogBound) {
            return;
        }
        bindingTarget.__deltaHedgeDialogBound = true;

        openButtons.forEach((button) => {
            if (typeof button.addEventListener === 'function') {
                button.addEventListener('click', () => _openDeltaHedgeDialog(button));
            }
        });
        if (dialog && typeof dialog.querySelectorAll === 'function') {
            dialog.querySelectorAll('.deltaHedgeDialogCloseBtn').forEach((button) => {
                button.addEventListener('click', _closeDeltaHedgeDialog);
            });
        }
        if (dialog && typeof dialog.addEventListener === 'function') {
            dialog.addEventListener('click', (event) => {
                if (event && event.target === dialog) {
                    _closeDeltaHedgeDialog();
                }
            });
        }
        if (globalScope.document && typeof globalScope.document.addEventListener === 'function') {
            globalScope.document.addEventListener('keydown', (event) => {
                if (event && event.key === 'Escape' && dialog && dialog.style && dialog.style.display !== 'none') {
                    _closeDeltaHedgeDialog();
                }
            });
        }
    }

    function _parseNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function _normalizeConfig(config) {
        if (globalScope.OptionComboDeltaHedgeLogic
            && typeof globalScope.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig === 'function') {
            return globalScope.OptionComboDeltaHedgeLogic.normalizeDeltaHedgeConfig(config);
        }
        return {
            enabled: false,
            targetDelta: 0,
            tolerance: 50,
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
            cooldownSeconds: 60,
        };
    }

    function _resolveDefaultHedgeSymbol(state) {
        const rawSymbol = state && state.underlyingSymbol !== undefined
            ? String(state.underlyingSymbol || '').trim().toUpperCase()
            : '';
        return rawSymbol;
    }

    function _ensureConfig(state) {
        if (!state || typeof state !== 'object') {
            return _normalizeConfig(null);
        }
        state.deltaHedge = _normalizeConfig(state.deltaHedge);
        const instrument = state.deltaHedge.hedgeInstrument || {};
        if (!instrument.symbol) {
            const defaultSymbol = _resolveDefaultHedgeSymbol(state);
            if (defaultSymbol) {
                state.deltaHedge = _normalizeConfig({
                    ...state.deltaHedge,
                    hedgeInstrument: {
                        ...instrument,
                        symbol: defaultSymbol,
                    },
                });
            }
        }
        return state.deltaHedge;
    }

    function _formatInputNumber(value) {
        if (value === null || value === undefined || value === '') {
            return '';
        }
        if (!Number.isFinite(Number(value))) {
            return '';
        }
        return String(Number(value));
    }

    function _normalizeSymbol(value) {
        return String(value || '').trim().toUpperCase();
    }

    function _getQuoteApi() {
        return globalScope.OptionComboWsLiveQuotes && typeof globalScope.OptionComboWsLiveQuotes === 'object'
            ? globalScope.OptionComboWsLiveQuotes
            : null;
    }

    function _getProductRegistry() {
        return globalScope.OptionComboProductRegistry && typeof globalScope.OptionComboProductRegistry === 'object'
            ? globalScope.OptionComboProductRegistry
            : null;
    }

    function _buildQuoteFromPrice(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? { mark: parsed } : null;
    }

    function _isSameUnderlyingSymbol(state, symbol) {
        const normalizedSymbol = _normalizeSymbol(symbol);
        const stateSymbol = _normalizeSymbol(state && state.underlyingSymbol);
        if (!normalizedSymbol || !stateSymbol) {
            return false;
        }
        if (normalizedSymbol === stateSymbol) {
            return true;
        }

        const registry = _getProductRegistry();
        if (registry && typeof registry.resolveUnderlyingProfile === 'function') {
            const profile = registry.resolveUnderlyingProfile(stateSymbol);
            const profileUnderlying = _normalizeSymbol(profile && profile.underlyingSymbol);
            if (profileUnderlying && normalizedSymbol === profileUnderlying) {
                return true;
            }
        }
        return false;
    }

    function _findMatchingFuturesPoolEntry(state, instrument) {
        const entries = Array.isArray(state && state.futuresPool) ? state.futuresPool : [];
        if (entries.length === 0) {
            return null;
        }
        const contractMonth = String(instrument && instrument.contractMonth || '').trim();
        if (contractMonth) {
            const exact = entries.find(entry => String(entry && entry.contractMonth || '').trim() === contractMonth);
            if (exact) {
                return exact;
            }
        }
        return entries[0] || null;
    }

    function _resolveHedgeReferenceQuote(state, instrument) {
        const quoteApi = _getQuoteApi();
        const secType = _normalizeSymbol(instrument && instrument.secType);
        const symbol = _normalizeSymbol(instrument && instrument.symbol);

        if (secType === 'STK') {
            if (quoteApi && typeof quoteApi.getStockQuote === 'function') {
                const stockQuote = quoteApi.getStockQuote(symbol);
                if (stockQuote) {
                    return stockQuote;
                }
            }
            if (_isSameUnderlyingSymbol(state, symbol)) {
                if (quoteApi && typeof quoteApi.getUnderlyingQuote === 'function') {
                    const underlyingQuote = quoteApi.getUnderlyingQuote();
                    if (underlyingQuote) {
                        return underlyingQuote;
                    }
                }
                return _buildQuoteFromPrice(state && state.underlyingPrice);
            }
        }

        if (secType === 'FUT') {
            const entry = _findMatchingFuturesPoolEntry(state, instrument);
            if (entry) {
                if (quoteApi && typeof quoteApi.getFutureQuote === 'function') {
                    const futureQuote = quoteApi.getFutureQuote(entry.id);
                    if (futureQuote) {
                        return futureQuote;
                    }
                }
                const entryQuote = {
                    bid: entry.bid,
                    ask: entry.ask,
                    mark: entry.mark,
                };
                if (globalScope.OptionComboDeltaHedgeLogic
                    && typeof globalScope.OptionComboDeltaHedgeLogic.selectHedgeReferencePrice === 'function'
                    && globalScope.OptionComboDeltaHedgeLogic.selectHedgeReferencePrice(entryQuote)) {
                    return entryQuote;
                }
            }
            if (_isSameUnderlyingSymbol(state, symbol)) {
                if (quoteApi && typeof quoteApi.getUnderlyingQuote === 'function') {
                    const underlyingQuote = quoteApi.getUnderlyingQuote();
                    if (underlyingQuote) {
                        return underlyingQuote;
                    }
                }
                return _buildQuoteFromPrice(state && state.underlyingPrice);
            }
        }

        return null;
    }

    function _resolveBrokerConfirmedTickSize(state, instrument, symbol) {
        // The server resolves the real price increment from the broker's market rule
        // and returns it on the hedge preview. Reuse it so the client auto-limit uses
        // the same tick the order will actually be submitted at — one source of truth.
        const runtime = state && state.deltaHedge;
        const preview = runtime && runtime.lastPreview;
        if (!preview || typeof preview !== 'object') {
            return null;
        }
        const increment = Number(preview.priceIncrement);
        if (!Number.isFinite(increment) || increment <= 0) {
            return null;
        }
        // Only reuse it when the preview describes the same contract still in view.
        const previewSymbol = _normalizeSymbol(preview.symbol);
        if (previewSymbol && symbol && previewSymbol !== symbol) {
            return null;
        }
        const previewSecType = _normalizeSymbol(preview.secType);
        const instrumentSecType = _normalizeSymbol(instrument && instrument.secType);
        if (previewSecType && instrumentSecType && previewSecType !== instrumentSecType) {
            return null;
        }
        return increment;
    }

    function _resolveLimitPriceTickSize(state, instrument) {
        const symbol = _normalizeSymbol(instrument && instrument.symbol) || _normalizeSymbol(state && state.underlyingSymbol);
        const brokerIncrement = _resolveBrokerConfirmedTickSize(state, instrument, symbol);
        if (brokerIncrement) {
            return brokerIncrement;
        }
        const registry = _getProductRegistry();
        if (registry && typeof registry.getComboPriceIncrement === 'function') {
            const tickSize = Number(registry.getComboPriceIncrement(symbol));
            if (Number.isFinite(tickSize) && tickSize > 0) {
                return tickSize;
            }
        }
        return _normalizeSymbol(instrument && instrument.secType) === 'FUT' ? 0.25 : 0.01;
    }

    function _formatLimitPriceValue(state, config) {
        const price = config && config.limitPrice;
        if (price === null || price === undefined || price === '' || !Number.isFinite(Number(price))) {
            return '';
        }
        const instrument = config && config.hedgeInstrument || {};
        const symbol = instrument.symbol || (state && state.underlyingSymbol) || '';
        const registry = _getProductRegistry();
        if (registry && typeof registry.formatPriceInputValue === 'function') {
            return registry.formatPriceInputValue(symbol, price);
        }
        return String(Number(price));
    }

    function _syncLimitPriceControl(state, config) {
        const limitPrice = _getElement('deltaHedgeLimitPrice');
        if (!limitPrice) {
            return;
        }
        limitPrice.value = _formatLimitPriceValue(state, config);
        if (config && config.limitPriceManualOverride === true) {
            limitPrice.title = 'Manually edited limit price.';
            return;
        }
        const source = String(config && config.limitPriceSource || '').replace(/^auto_/, '') || '';
        const referencePrice = Number(config && config.limitPriceReferencePrice);
        if (source && Number.isFinite(referencePrice) && referencePrice > 0) {
            limitPrice.title = `Auto-filled from ${source} reference ${referencePrice}.`;
            return;
        }
        limitPrice.title = 'Limit price is required for LMT hedge broker preview.';
    }

    function _applyAutomaticLimitPrice(state, recommendation) {
        if (!state || !state.deltaHedge || !recommendation || recommendation.actionable !== true) {
            return;
        }
        const config = _ensureConfig(state);
        if (config.orderType !== 'LMT' || config.limitPriceManualOverride === true) {
            _syncLimitPriceControl(state, config);
            return;
        }
        if (!globalScope.OptionComboDeltaHedgeLogic
            || typeof globalScope.OptionComboDeltaHedgeLogic.calculateDefaultHedgeLimitPrice !== 'function') {
            _syncLimitPriceControl(state, config);
            return;
        }

        const instrument = config.hedgeInstrument || {};
        const quote = _resolveHedgeReferenceQuote(state, instrument);
        const tickSize = _resolveLimitPriceTickSize(state, instrument);
        const result = globalScope.OptionComboDeltaHedgeLogic.calculateDefaultHedgeLimitPrice({
            side: recommendation.side,
            quote,
            tickSize,
            offsetRate: config.limitPriceOffsetRate,
        });
        if (!result) {
            _syncLimitPriceControl(state, config);
            return;
        }

        state.deltaHedge = _normalizeConfig({
            ...config,
            limitPrice: result.limitPrice,
            limitPriceManualOverride: false,
            limitPriceSource: `auto_${result.source}`,
            limitPriceReferencePrice: result.referencePrice,
            limitPriceTickSize: result.tickSize,
            limitPriceOffsetRate: result.offsetRate,
        });
        _syncLimitPriceControl(state, state.deltaHedge);
    }

    function formatDelta(value) {
        if (value === null || value === undefined || value === '') {
            return '--';
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return '--';
        }
        if (Object.is(parsed, -0) || parsed === 0) {
            return '0.00';
        }
        return `${parsed > 0 ? '+' : ''}${parsed.toFixed(2)}`;
    }

    function _formatQuantity(quantity) {
        const parsed = Number(quantity);
        if (!Number.isFinite(parsed)) {
            return '0';
        }
        return String(Math.abs(Math.round(parsed)));
    }

    function _recommendationLabel(recommendation) {
        if (!recommendation) {
            return 'No recommendation';
        }
        if (recommendation.actionable) {
            const instrument = recommendation.hedgeInstrument || {};
            return `${recommendation.side} ${_formatQuantity(recommendation.quantity)} ${instrument.symbol || ''}`.trim();
        }
        return REASON_LABELS[recommendation.reason] || 'No recommendation';
    }

    function _recommendationSummary(recommendation) {
        if (!recommendation) {
            return '';
        }
        if (recommendation.actionable) {
            const instrument = recommendation.hedgeInstrument || {};
            const orderType = recommendation.orderType || 'LMT';
            return `${orderType} ${recommendation.side} ${_formatQuantity(recommendation.quantity)} ${instrument.symbol || ''}; projected net Delta ${formatDelta(recommendation.projectedNetDelta)}`.trim();
        }
        if (recommendation.reason === 'inside_tolerance') {
            return `Target band ${formatDelta(recommendation.targetLower)} to ${formatDelta(recommendation.targetUpper)}`;
        }
        if (recommendation.reason === 'delta_unavailable') {
            const missingCount = Number(recommendation.missingGroupCount || 0);
            return missingCount > 0
                ? `${missingCount} included group Delta missing`
                : 'Included group Delta is incomplete';
        }
        if (recommendation.reason === 'missing_hedge_instrument') {
            return 'Enter the hedge symbol to trade.';
        }
        return REASON_LABELS[recommendation.reason] || '';
    }

    function _getSelectedAccount(state) {
        return String(state && state.selectedLiveComboOrderAccount || '').trim();
    }

    function _syncAccountDisplay(state) {
        const display = _getElement('deltaHedgeAccountDisplay');
        if (!display) {
            return;
        }

        const accounts = Array.isArray(state && state.liveComboOrderAccounts)
            ? state.liveComboOrderAccounts
                .map(account => String(account || '').trim())
                .filter((account, index, list) => account && list.indexOf(account) === index)
            : [];
        const selectedAccount = _getSelectedAccount(state);
        const accountText = selectedAccount
            || (state && state.liveComboOrderAccountsConnected === true && accounts.length > 0
                ? 'No account selected'
                : 'Waiting for account');
        display.textContent = accountText;
        display.title = selectedAccount
            ? 'Using the global TWS Order Account selected above.'
            : 'Select the global TWS Order Account in Enable Live Combo Orders.';
    }

    function _hasActiveRestingOrder(runtime) {
        if (globalScope.OptionComboDeltaHedgeLogic
            && typeof globalScope.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder === 'function') {
            return globalScope.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder(runtime);
        }
        return Boolean(runtime && runtime.restingOrder && runtime.restingOrder.orderId);
    }

    function _syncSubmitControls(state) {
        const gate = _getElement('deltaHedgeAllowLiveOrders');
        const submitBtn = _getElement('deltaHedgeSubmitBtn');
        const cancelBtn = _getElement('deltaHedgeCancelBtn');
        const clearBtn = _getElement('deltaHedgeClearBtn');
        const liveMode = state && state.marketDataMode !== 'historical';
        const runtime = state && state.deltaHedge && typeof state.deltaHedge === 'object'
            ? state.deltaHedge
            : {};
        const activeRestingOrder = _hasActiveRestingOrder(runtime);
        const orderState = String(runtime.orderState || runtime.status || '').trim().toLowerCase();
        const terminalOrderState = ['filled', 'canceled', 'cancelled', 'rejected', 'inactive'].includes(orderState);
        const canClear = terminalOrderState || (orderState === 'stale_needs_review' && activeRestingOrder !== true);

        if (gate) {
            gate.checked = state && state.allowLiveHedgeOrders === true;
            gate.disabled = !liveMode;
            gate.title = liveMode
                ? 'Separate live-order switch for manual Delta Hedge submit.'
                : 'Delta Hedge live orders require live mode.';
        }

        if (!submitBtn) {
            if (cancelBtn) {
                cancelBtn.disabled = !(liveMode && activeRestingOrder && runtime.status !== 'cancel_pending' && runtime.pendingRequest !== true);
            }
            if (clearBtn) {
                clearBtn.disabled = !canClear;
            }
            return;
        }
        const recommendation = runtime.lastRecommendation || null;
        const hasPreview = runtime.status === 'previewed' && runtime.lastPreview && typeof runtime.lastPreview === 'object';
        const ready = liveMode
            && state.allowLiveHedgeOrders === true
            && Boolean(_getSelectedAccount(state))
            && recommendation
            && recommendation.actionable === true
            && hasPreview
            && activeRestingOrder !== true
            && runtime.pendingRequest !== true;
        submitBtn.disabled = !ready;
        if (!liveMode) {
            submitBtn.title = 'Live mode is required.';
        } else if (state.allowLiveHedgeOrders !== true) {
            submitBtn.title = 'Enable Live Hedge Orders first.';
        } else if (!_getSelectedAccount(state)) {
            submitBtn.title = 'Select the global TWS Order Account first.';
        } else if (!hasPreview) {
            submitBtn.title = 'Run Broker Preview / What-If first.';
        } else if (activeRestingOrder) {
            submitBtn.title = 'A hedge order is already resting or needs review.';
        } else {
            submitBtn.title = 'Submit the previewed Delta Hedge order.';
        }

        if (cancelBtn) {
            const canCancel = liveMode && activeRestingOrder && runtime.status !== 'cancel_pending' && runtime.pendingRequest !== true;
            cancelBtn.disabled = !canCancel;
            cancelBtn.title = canCancel
                ? 'Cancel the active resting Delta Hedge order.'
                : 'No active cancellable hedge order.';
        }
        if (clearBtn) {
            clearBtn.disabled = !canClear;
            clearBtn.title = canClear
                ? 'Clear this terminal or stale hedge order state and re-arm DDH.'
                : (orderState === 'stale_needs_review' && activeRestingOrder
                    ? 'Cancel the active stale hedge order before clearing.'
                    : 'Clear is available only after terminal hedge order states.');
        }
    }

    function _clearDeltaHedgeOrderState(state) {
        if (!state || !state.deltaHedge || typeof state.deltaHedge !== 'object') {
            return;
        }
        state.deltaHedge.status = 'idle';
        state.deltaHedge.orderState = 'idle';
        state.deltaHedge.pendingRequest = false;
        state.deltaHedge.lastError = '';
        state.deltaHedge.lastPreview = null;
        state.deltaHedge.lastValidation = null;
        state.deltaHedge.pendingPreviewPayload = null;
        state.deltaHedge.pendingSubmitPayload = null;
        state.deltaHedge.restingOrder = null;
        _syncSubmitControls(state);
        applyBrokerPreviewState(state);
    }

    function _formatBrokerPreviewDetails(preview) {
        if (!preview || typeof preview !== 'object') {
            return '';
        }
        const action = preview.orderAction || '';
        const quantity = _formatQuantity(preview.quantity);
        const symbol = preview.localSymbol || preview.symbol || '';
        const orderType = preview.orderType || 'LMT';
        const limitText = orderType === 'LMT' && Number.isFinite(Number(preview.limitPrice))
            ? ` @ ${Number(preview.limitPrice)}`
            : '';
        const conIdText = preview.conId ? `, conId ${preview.conId}` : '';
        const projectedText = preview.projectedNetDelta !== null && preview.projectedNetDelta !== undefined
            ? `, Projected ${formatDelta(preview.projectedNetDelta)}`
            : '';
        const whatIf = preview.whatIf && typeof preview.whatIf === 'object' ? preview.whatIf : null;
        const commissionText = whatIf && Number.isFinite(Number(whatIf.commission))
            ? `, commission ${whatIf.commission} ${whatIf.commissionCurrency || ''}`.trimEnd()
            : '';
        const warningText = whatIf && whatIf.warningText
            ? `, ${whatIf.warningText}`
            : '';
        const adjustmentText = preview.priceAdjustmentMessage
            ? `, ${preview.priceAdjustmentMessage}`
            : '';
        return `${orderType} ${action} ${quantity} ${symbol}${limitText}${conIdText}${projectedText}${commissionText}${warningText}${adjustmentText}`.trim();
    }

    function _evaluateRecommendation(state, derivedData) {
        const rawDeltaHedge = state && state.deltaHedge && typeof state.deltaHedge === 'object'
            ? state.deltaHedge
            : {};
        const config = _ensureConfig(state);
        if (!globalScope.OptionComboDeltaHedgeLogic
            || typeof globalScope.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation !== 'function') {
            return null;
        }
        const summary = derivedData && typeof derivedData === 'object' ? derivedData : {};
        const hasActiveRestingOrder = typeof globalScope.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder === 'function'
            && globalScope.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder(rawDeltaHedge);
        const legacyPendingOrder = rawDeltaHedge.pendingOrder === true
            || Boolean(rawDeltaHedge.pendingOrderId || rawDeltaHedge.previewOrderId);
        const baseRecommendation = globalScope.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
            config,
            portfolioDeltaSummary: summary,
            greeksEnabled: state ? state.greeksEnabled === true : false,
            liveMode: state ? state.marketDataMode !== 'historical' : false,
            pendingHedgeOrder: false,
        });

        if (hasActiveRestingOrder
            && rawDeltaHedge.restingOrder
            && typeof globalScope.OptionComboDeltaHedgeLogic.evaluateRestingHedgeOrderApplicability === 'function') {
            const applicability = globalScope.OptionComboDeltaHedgeLogic.evaluateRestingHedgeOrderApplicability({
                restingOrder: rawDeltaHedge.restingOrder,
                recommendation: baseRecommendation,
            });
            state.deltaHedge.orderState = applicability.orderState;
            state.deltaHedge.restingOrder = {
                ...rawDeltaHedge.restingOrder,
                staleReason: applicability.stale ? applicability.reason : '',
            };
        }

        const recommendation = (hasActiveRestingOrder || legacyPendingOrder)
            ? globalScope.OptionComboDeltaHedgeLogic.evaluateDeltaHedgeRecommendation({
                config,
                portfolioDeltaSummary: summary,
                greeksEnabled: state ? state.greeksEnabled === true : false,
                liveMode: state ? state.marketDataMode !== 'historical' : false,
                pendingHedgeOrder: true,
            })
            : baseRecommendation;
        if (recommendation && recommendation.reason === 'delta_unavailable') {
            recommendation.missingGroupCount = Number(summary.portfolioDeltaMissingGroupCount || 0);
        }
        return recommendation;
    }

    function _formatAutomationDecision(decision) {
        if (!decision || typeof decision !== 'object') {
            return '';
        }
        if (decision.action === 'submit') {
            return 'Auto submit ready';
        }
        if (decision.action === 'submitted') {
            return 'Auto submit sent';
        }
        if (decision.action === 'request_preview') {
            return AUTO_REASON_LABELS[decision.reason] || 'Auto preview pending';
        }
        if (decision.action === 'cancel_stale_order') {
            return AUTO_REASON_LABELS[decision.reason] || 'Auto canceling stale order';
        }
        if (decision.action === 'cancel_requested') {
            return 'Auto cancel sent';
        }
        const label = AUTO_REASON_LABELS[decision.reason] || AUTO_REASON_LABELS[decision.action] || '';
        if (decision.reason === 'cooldown_active' && Number.isFinite(Number(decision.cooldownRemainingSeconds))) {
            return `${label}: ${Math.max(0, Math.ceil(Number(decision.cooldownRemainingSeconds)))}s`;
        }
        return label;
    }

    function _globalBrokerStatus(runtime) {
        const status = String(runtime && runtime.status || '').trim().toLowerCase();
        const orderState = String(runtime && runtime.orderState || '').trim().toLowerCase();
        if (runtime && runtime.lastError) return String(runtime.lastError);
        if (orderState === 'stale_needs_review' || status === 'partial_fill_needs_review') return 'Hedge order needs review';
        if (status === 'pending_validation') return 'Validating hedge contract';
        if (status === 'pending_preview') return 'Requesting broker preview';
        if (status === 'previewed') return 'Broker preview ready';
        if (status === 'placing') return 'Submitting hedge order';
        if (status === 'cancel_pending') return 'Cancel request pending';
        if (status === 'submitted' || orderState === 'resting_locked') return 'Hedge order resting';
        if (['filled', 'canceled', 'cancelled', 'rejected', 'inactive'].includes(status)) {
            return `Last order ${status.replace('cancelled', 'canceled')}`;
        }
        return '';
    }

    function applyGlobalStatus(state) {
        const container = _getElement('deltaHedgeGlobalStatus');
        if (!container) {
            return;
        }
        const runtime = state && state.deltaHedge && typeof state.deltaHedge === 'object'
            ? state.deltaHedge
            : {};
        const config = _normalizeConfig(runtime);
        const recommendation = runtime.lastRecommendation || null;
        const error = String(runtime.lastError || '').trim();
        const activeOrder = _hasActiveRestingOrder(runtime);
        const configured = config.enabled === true;
        const shouldShow = configured || activeOrder || Boolean(error) || runtime.pendingRequest === true;
        container.hidden = !shouldShow;
        if (container.style) {
            container.style.display = shouldShow ? '' : 'none';
        }
        if (!shouldShow) {
            return;
        }

        const brokerStatus = _globalBrokerStatus(runtime);
        const autoStatus = config.autoSubmitEnabled === true
            ? (_formatAutomationDecision(runtime.autoLastDecision) || 'Auto submit waiting')
            : 'Auto submit off';
        const target = formatDelta(config.targetDelta);
        const tolerance = formatDelta(config.tolerance);
        const netDelta = recommendation ? formatDelta(recommendation.currentNetDelta) : '--';
        const actionLabel = _recommendationLabel(recommendation);
        const orderState = String(runtime.orderState || '').trim().toLowerCase();

        let tone = 'healthy';
        let badge = 'Monitoring';
        let title = 'Delta Hedge monitoring';
        if (error || orderState === 'stale_needs_review') {
            tone = 'danger';
            badge = 'Review';
            title = error ? 'Delta Hedge error' : 'Hedge order needs review';
        } else if (activeOrder || ['pending_validation', 'pending_preview', 'placing', 'cancel_pending', 'submitted'].includes(String(runtime.status || '').toLowerCase())) {
            tone = 'working';
            badge = 'Working';
            title = brokerStatus || 'Delta Hedge order active';
        } else if (recommendation && recommendation.actionable) {
            tone = 'attention';
            badge = 'Action';
            title = actionLabel;
        } else if (recommendation && recommendation.reason && recommendation.reason !== 'inside_tolerance') {
            tone = 'attention';
            badge = 'Waiting';
            title = actionLabel;
        } else if (recommendation && recommendation.reason === 'inside_tolerance') {
            title = 'Net Delta is inside the target band';
        }

        if (container.dataset) {
            container.dataset.tone = tone;
        } else if (typeof container.setAttribute === 'function') {
            container.setAttribute('data-tone', tone);
        }
        _setText('deltaHedgeGlobalStatusBadge', badge);
        _setText('deltaHedgeGlobalStatusTitle', title);
        _setText(
            'deltaHedgeGlobalStatusSummary',
            `Net Δ ${netDelta} · Target ${target} ± ${tolerance} · ${actionLabel}`
        );
        _setText(
            'deltaHedgeGlobalStatusDetail',
            [brokerStatus, autoStatus].filter(Boolean).join(' · ')
        );
    }

    function applyAutomationState(state) {
        const runtime = state && state.deltaHedge && typeof state.deltaHedge === 'object'
            ? state.deltaHedge
            : {};
        const config = _normalizeConfig(runtime);
        if (config.autoSubmitEnabled !== true) {
            _setText('deltaHedgeAutoStatus', '');
            applyGlobalStatus(state);
            return;
        }
        const decisionText = _formatAutomationDecision(runtime.autoLastDecision);
        _setText('deltaHedgeAutoStatus', decisionText || 'Auto submit waiting');
        applyGlobalStatus(state);
    }

    function _syncControls(state) {
        const config = _ensureConfig(state);
        const instrument = config.hedgeInstrument || {};
        const enabled = _getElement('deltaHedgeEnabled');
        const targetDelta = _getElement('deltaHedgeTargetDelta');
        const tolerance = _getElement('deltaHedgeTolerance');
        const proactiveBuffer = _getElement('deltaHedgeProactiveBuffer');
        const secType = _getElement('deltaHedgeSecType');
        const symbol = _getElement('deltaHedgeSymbol');
        const exchange = _getElement('deltaHedgeExchange');
        const contractMonth = _getElement('deltaHedgeContractMonth');
        const multiplier = _getElement('deltaHedgeMultiplier');
        const deltaPerUnit = _getElement('deltaHedgeDeltaPerUnit');
        const orderType = _getElement('deltaHedgeOrderType');
        const autoSubmitEnabled = _getElement('deltaHedgeAutoSubmitEnabled');
        const autoCancelStaleOrders = _getElement('deltaHedgeAutoCancelStaleOrders');
        const maxOrderQuantity = _getElement('deltaHedgeMaxOrderQuantity');
        const autoMaxNotional = _getElement('deltaHedgeAutoMaxNotional');
        const autoMaxOrdersPerDay = _getElement('deltaHedgeAutoMaxOrdersPerDay');
        const cooldownSeconds = _getElement('deltaHedgeCooldownSeconds');
        const autoPreviewMaxAgeSeconds = _getElement('deltaHedgeAutoPreviewMaxAgeSeconds');

        if (enabled) enabled.checked = config.enabled === true;
        if (targetDelta) targetDelta.value = _formatInputNumber(config.targetDelta);
        if (tolerance) tolerance.value = _formatInputNumber(config.tolerance);
        if (proactiveBuffer) proactiveBuffer.value = _formatInputNumber(config.proactiveBuffer);
        if (secType) secType.value = instrument.secType || 'STK';
        if (symbol) symbol.value = instrument.symbol || '';
        if (exchange) exchange.value = instrument.exchange || 'SMART';
        if (contractMonth) contractMonth.value = instrument.contractMonth || '';
        if (multiplier) multiplier.value = _formatInputNumber(instrument.multiplier);
        if (deltaPerUnit) deltaPerUnit.value = _formatInputNumber(instrument.deltaPerUnit);
        _syncLimitPriceControl(state, config);
        if (orderType) orderType.value = config.orderType || 'LMT';
        if (autoSubmitEnabled) {
            autoSubmitEnabled.checked = config.autoSubmitEnabled === true;
            autoSubmitEnabled.disabled = state && state.marketDataMode === 'historical';
            autoSubmitEnabled.title = autoSubmitEnabled.disabled
                ? 'Auto submit requires live mode.'
                : 'Requires Enable Live Hedge Orders and a fresh Broker Preview.';
        }
        if (autoCancelStaleOrders) {
            autoCancelStaleOrders.checked = config.autoCancelStaleOrders !== false;
            autoCancelStaleOrders.disabled = state && state.marketDataMode === 'historical';
            autoCancelStaleOrders.title = autoCancelStaleOrders.disabled
                ? 'Auto cancel requires live mode.'
                : 'Cancel active stale hedge orders while auto submit is enabled.';
        }
        if (maxOrderQuantity) maxOrderQuantity.value = _formatInputNumber(config.maxOrderQuantity);
        if (autoMaxNotional) autoMaxNotional.value = _formatInputNumber(config.autoMaxNotional);
        if (autoMaxOrdersPerDay) autoMaxOrdersPerDay.value = _formatInputNumber(config.autoMaxOrdersPerDay);
        if (cooldownSeconds) cooldownSeconds.value = _formatInputNumber(config.cooldownSeconds);
        if (autoPreviewMaxAgeSeconds) autoPreviewMaxAgeSeconds.value = _formatInputNumber(config.autoPreviewMaxAgeSeconds);

        _setHidden('deltaHedgeContractMonthGroup', instrument.secType !== 'FUT');
        _setHidden('deltaHedgeLimitPriceGroup', config.orderType === 'MKT');
        _syncAccountDisplay(state);
        _syncSubmitControls(state);
        applyAutomationState(state);
        applyGlobalStatus(state);
    }

    function applyRecommendationPreview(state, derivedData) {
        const recommendation = _evaluateRecommendation(state, derivedData);
        const summary = derivedData && typeof derivedData === 'object' ? derivedData : {};
        if (state && state.deltaHedge && typeof state.deltaHedge === 'object') {
            state.deltaHedge.lastRecommendation = recommendation;
        }
        _applyAutomaticLimitPrice(state, recommendation);

        _setText('deltaHedgeOptionDelta', formatDelta(summary.portfolioOptionDelta));
        _setText('deltaHedgeExistingHedgeDelta', formatDelta(summary.portfolioHedgeDelta));
        _setText('deltaHedgeNetDelta', formatDelta(recommendation ? recommendation.currentNetDelta : summary.portfolioNetDelta));
        _setText('deltaHedgeProjectedDelta', formatDelta(recommendation ? recommendation.projectedNetDelta : null));
        _setText('deltaHedgeRecommendationStatus', _recommendationLabel(recommendation));
        _setText('deltaHedgeRecommendationSummary', _recommendationSummary(recommendation));
        _syncSubmitControls(state);
        applyAutomationState(state);

        return recommendation;
    }

    function applyBrokerPreviewState(state) {
        const runtime = state && state.deltaHedge && typeof state.deltaHedge === 'object'
            ? state.deltaHedge
            : {};
        const status = String(runtime.status || '').trim();
        const error = String(runtime.lastError || '').trim();
        const preview = runtime.lastPreview || null;

        if (error) {
            _setText('deltaHedgeBrokerPreviewStatus', error);
            _setText('deltaHedgeBrokerPreviewDetails', '');
            applyAutomationState(state);
            return;
        }
        if (status === 'pending_validation') {
            _setText('deltaHedgeBrokerPreviewStatus', 'Validating hedge contract');
            _setText('deltaHedgeBrokerPreviewDetails', '');
            applyAutomationState(state);
            return;
        }
        if (status === 'pending_preview') {
            _setText('deltaHedgeBrokerPreviewStatus', 'Requesting broker preview');
            _setText('deltaHedgeBrokerPreviewDetails', '');
            _syncSubmitControls(state);
            applyAutomationState(state);
            return;
        }
        if (status === 'previewed' && preview) {
            _setText('deltaHedgeBrokerPreviewStatus', 'Broker preview ready');
            _setText('deltaHedgeBrokerPreviewDetails', _formatBrokerPreviewDetails(preview));
            _syncSubmitControls(state);
            applyAutomationState(state);
            return;
        }
        if (status === 'placing') {
            _setText('deltaHedgeBrokerPreviewStatus', 'Submitting hedge order');
            _setText('deltaHedgeBrokerPreviewDetails', _formatBrokerPreviewDetails(preview));
            _syncSubmitControls(state);
            applyAutomationState(state);
            return;
        }
        if (runtime.orderState === 'stale_needs_review') {
            const staleReason = runtime.restingOrder && runtime.restingOrder.staleReason
                ? `: ${runtime.restingOrder.staleReason}`
                : '';
            _setText('deltaHedgeBrokerPreviewStatus', `Hedge order needs review${staleReason}`);
            _setText('deltaHedgeBrokerPreviewDetails', _formatBrokerPreviewDetails(preview));
            _syncSubmitControls(state);
            applyAutomationState(state);
            return;
        }
        if (status === 'submitted' || runtime.orderState === 'resting_locked') {
            _setText('deltaHedgeBrokerPreviewStatus', 'Hedge order resting');
            _setText('deltaHedgeBrokerPreviewDetails', _formatBrokerPreviewDetails(preview));
            _syncSubmitControls(state);
            applyAutomationState(state);
            return;
        }
        _setText('deltaHedgeBrokerPreviewStatus', '');
        _setText('deltaHedgeBrokerPreviewDetails', '');
        _syncSubmitControls(state);
        applyAutomationState(state);
    }

    function refreshDeltaHedgePanel(state) {
        if (!state || typeof state !== 'object') {
            return;
        }
        _syncControls(state);
        applyBrokerPreviewState(state);
    }

    function _updateConfig(state, updater) {
        const current = _ensureConfig(state);
        const nextDraft = updater({
            ...current,
            hedgeInstrument: {
                ...current.hedgeInstrument,
            },
        });
        state.deltaHedge = _normalizeConfig(nextDraft);
        _syncControls(state);
    }

    function _refreshAfterChange(state, deps) {
        if (deps && typeof deps.updateDerivedValues === 'function') {
            const derivedData = deps.updateDerivedValues();
            if (derivedData) {
                applyRecommendationPreview(state, derivedData);
            }
        }
    }

    function _bindChange(id, handler) {
        const el = _getElement(id);
        if (!el || typeof el.addEventListener !== 'function') {
            return;
        }
        el.addEventListener('change', handler);
    }

    function bindDeltaHedgePanel(state, deps = {}) {
        if (!state || typeof state !== 'object') {
            return;
        }

        _ensureConfig(state);
        _syncControls(state);
        _bindDialogControls();

        const previewBtn = _getElement('deltaHedgeRecommendationPreviewBtn');
        const firstControl = CONTROL_IDS.map(_getElement).find(Boolean);
        if (firstControl && firstControl.__deltaHedgePanelBound) {
            return;
        }
        if (firstControl) {
            firstControl.__deltaHedgePanelBound = true;
        }

        _bindChange('deltaHedgeEnabled', (event) => {
            _updateConfig(state, config => ({
                ...config,
                enabled: event && event.target ? event.target.checked === true : false,
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeTargetDelta', (event) => {
            _updateConfig(state, config => ({
                ...config,
                targetDelta: _parseNumber(event && event.target ? event.target.value : '', config.targetDelta),
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeTolerance', (event) => {
            _updateConfig(state, config => ({
                ...config,
                tolerance: _parseNumber(event && event.target ? event.target.value : '', config.tolerance),
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeProactiveBuffer', (event) => {
            _updateConfig(state, config => ({
                ...config,
                proactiveBuffer: Math.max(0, _parseNumber(event && event.target ? event.target.value : '', config.proactiveBuffer || 0)),
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeSecType', (event) => {
            _updateConfig(state, config => ({
                ...config,
                hedgeInstrument: {
                    ...config.hedgeInstrument,
                    secType: String(event && event.target ? event.target.value : '').trim().toUpperCase(),
                },
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeSymbol', (event) => {
            _updateConfig(state, config => ({
                ...config,
                hedgeInstrument: {
                    ...config.hedgeInstrument,
                    symbol: String(event && event.target ? event.target.value : '').trim().toUpperCase(),
                },
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeExchange', (event) => {
            _updateConfig(state, config => ({
                ...config,
                hedgeInstrument: {
                    ...config.hedgeInstrument,
                    exchange: String(event && event.target ? event.target.value : '').trim().toUpperCase(),
                },
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeContractMonth', (event) => {
            _updateConfig(state, config => ({
                ...config,
                hedgeInstrument: {
                    ...config.hedgeInstrument,
                    contractMonth: String(event && event.target ? event.target.value : '').trim(),
                },
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeMultiplier', (event) => {
            _updateConfig(state, config => ({
                ...config,
                hedgeInstrument: {
                    ...config.hedgeInstrument,
                    multiplier: _parseNumber(event && event.target ? event.target.value : '', config.hedgeInstrument.multiplier),
                },
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeDeltaPerUnit', (event) => {
            _updateConfig(state, config => ({
                ...config,
                hedgeInstrument: {
                    ...config.hedgeInstrument,
                    deltaPerUnit: _parseNumber(event && event.target ? event.target.value : '', config.hedgeInstrument.deltaPerUnit),
                },
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeLimitPrice', (event) => {
            _updateConfig(state, config => ({
                ...config,
                limitPrice: _parseNumber(event && event.target ? event.target.value : '', config.limitPrice),
                limitPriceManualOverride: true,
                limitPriceSource: 'manual',
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeOrderType', (event) => {
            _updateConfig(state, config => ({
                ...config,
                orderType: String(event && event.target ? event.target.value : '').trim().toUpperCase(),
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeAllowLiveOrders', (event) => {
            state.allowLiveHedgeOrders = state.marketDataMode !== 'historical'
                && event
                && event.target
                && event.target.checked === true;
            _syncSubmitControls(state);
            applyAutomationState(state);
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeAutoSubmitEnabled', (event) => {
            _updateConfig(state, config => ({
                ...config,
                autoSubmitEnabled: state.marketDataMode !== 'historical'
                    && event
                    && event.target
                    && event.target.checked === true,
                autoLastDecision: null,
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeAutoCancelStaleOrders', (event) => {
            _updateConfig(state, config => ({
                ...config,
                autoCancelStaleOrders: event
                    && event.target
                    && event.target.checked === true,
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeMaxOrderQuantity', (event) => {
            const rawValue = String(event && event.target ? event.target.value : '').trim();
            _updateConfig(state, config => ({
                ...config,
                maxOrderQuantity: rawValue ? Math.max(1, Math.floor(_parseNumber(rawValue, 1))) : null,
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeAutoMaxNotional', (event) => {
            const rawValue = String(event && event.target ? event.target.value : '').trim();
            _updateConfig(state, config => ({
                ...config,
                autoMaxNotional: rawValue ? Math.max(1, _parseNumber(rawValue, 1)) : null,
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeAutoMaxOrdersPerDay', (event) => {
            _updateConfig(state, config => ({
                ...config,
                autoMaxOrdersPerDay: Math.max(1, Math.floor(_parseNumber(
                    event && event.target ? event.target.value : '',
                    config.autoMaxOrdersPerDay || 3
                ))),
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeCooldownSeconds', (event) => {
            _updateConfig(state, config => ({
                ...config,
                cooldownSeconds: Math.max(1, Math.floor(_parseNumber(
                    event && event.target ? event.target.value : '',
                    config.cooldownSeconds || 60
                ))),
            }));
            _refreshAfterChange(state, deps);
        });
        _bindChange('deltaHedgeAutoPreviewMaxAgeSeconds', (event) => {
            _updateConfig(state, config => ({
                ...config,
                autoPreviewMaxAgeSeconds: Math.max(1, Math.floor(_parseNumber(
                    event && event.target ? event.target.value : '',
                    config.autoPreviewMaxAgeSeconds || 30
                ))),
            }));
            _refreshAfterChange(state, deps);
        });
        if (previewBtn && typeof previewBtn.addEventListener === 'function') {
            previewBtn.addEventListener('click', () => {
                _refreshAfterChange(state, deps);
            });
        }

        const brokerPreviewBtn = _getElement('deltaHedgeBrokerPreviewBtn');
        if (brokerPreviewBtn && typeof brokerPreviewBtn.addEventListener === 'function') {
            brokerPreviewBtn.addEventListener('click', () => {
                const derivedData = deps && typeof deps.updateDerivedValues === 'function'
                    ? deps.updateDerivedValues()
                    : null;
                const recommendation = applyRecommendationPreview(state, derivedData || {});
                if (recommendation && recommendation.actionable
                    && deps && typeof deps.requestBrokerPreview === 'function') {
                    deps.requestBrokerPreview(recommendation);
                }
                applyBrokerPreviewState(state);
            });
        }

        const submitBtn = _getElement('deltaHedgeSubmitBtn');
        if (submitBtn && typeof submitBtn.addEventListener === 'function') {
            submitBtn.addEventListener('click', () => {
                _syncSubmitControls(state);
                if (submitBtn.disabled) {
                    return;
                }
                const derivedData = deps && typeof deps.updateDerivedValues === 'function'
                    ? deps.updateDerivedValues()
                    : null;
                const recommendation = applyRecommendationPreview(state, derivedData || {});
                const safety = globalScope.OptionComboOrderSafety;
                const confirmation = globalScope.OptionComboOrderConfirmationUI;
                if (!recommendation || recommendation.actionable !== true
                    || !safety || typeof safety.buildHedgeIntent !== 'function'
                    || typeof safety.analyzePositionImpact !== 'function'
                    || !confirmation || typeof confirmation.open !== 'function') {
                    state.deltaHedge.status = 'error';
                    state.deltaHedge.lastError = 'Shared order safety confirmation is unavailable. No hedge order was sent.';
                    applyBrokerPreviewState(state);
                    return;
                }
                const intent = safety.buildHedgeIntent(state, recommendation);
                const positionImpact = safety.analyzePositionImpact(intent, state);
                confirmation.open({
                    title: 'Confirm Delta Hedge Order',
                    intent,
                    positionImpact,
                    expiresAt: state.deltaHedge.lastPreview && state.deltaHedge.lastPreview.executionPlanExpiresAt,
                    onConfirm: () => deps && typeof deps.requestSubmit === 'function'
                        ? deps.requestSubmit(recommendation, { safetyConfirmed: true })
                        : false,
                });
                applyBrokerPreviewState(state);
            });
        }

        const cancelBtn = _getElement('deltaHedgeCancelBtn');
        if (cancelBtn && typeof cancelBtn.addEventListener === 'function') {
            cancelBtn.addEventListener('click', () => {
                _syncSubmitControls(state);
                if (cancelBtn.disabled) {
                    return;
                }
                if (deps && typeof deps.requestCancel === 'function') {
                    deps.requestCancel();
                }
                applyBrokerPreviewState(state);
            });
        }

        const clearBtn = _getElement('deltaHedgeClearBtn');
        if (clearBtn && typeof clearBtn.addEventListener === 'function') {
            clearBtn.addEventListener('click', () => {
                _syncSubmitControls(state);
                if (clearBtn.disabled) {
                    return;
                }
                _clearDeltaHedgeOrderState(state);
                if (deps && typeof deps.updateDerivedValues === 'function') {
                    const derivedData = deps.updateDerivedValues();
                    if (derivedData) {
                        applyRecommendationPreview(state, derivedData);
                    }
                }
            });
        }
    }

    globalScope.OptionComboDeltaHedgeUI = {
        bindDeltaHedgePanel,
        applyRecommendationPreview,
        applyBrokerPreviewState,
        applyAutomationState,
        applyGlobalStatus,
        refreshDeltaHedgePanel,
        formatDelta,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
