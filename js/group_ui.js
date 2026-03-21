/**
 * Group DOM writers.
 */

(function attachGroupUi(globalScope) {
    const productRegistry = globalScope.OptionComboProductRegistry;

    function isOptionLeg(leg) {
        return productRegistry && typeof productRegistry.isOptionLeg === 'function'
            ? productRegistry.isOptionLeg(leg)
            : ['call', 'put'].includes(String(leg && leg.type || '').toLowerCase());
    }

    function formatTriggerStatus(trigger) {
        if (!trigger) return 'Idle';
        const brokerStatus = String(trigger.lastPreview && trigger.lastPreview.status || '').trim();

        switch (trigger.status) {
            case 'armed':
                return `Armed (${trigger.condition === 'lte' ? '≤' : '≥'} ${trigger.price ?? 'N/A'})`;
            case 'pending_validation':
                return 'Trigger hit, validating combo legs...';
            case 'pending_preview':
                return 'Trigger hit, previewing combo...';
            case 'pending_submit':
                return 'Trigger hit, sending combo to TWS...';
            case 'pending_test_submit':
                return 'Trigger hit, sending TEST order to TWS...';
            case 'pending_resume':
                return 'Requesting more middle-price retries...';
            case 'pending_concede':
                return 'Updating combo price with concession...';
            case 'pending_cancel':
                return 'Cancelling combo order in TWS...';
            case 'previewed':
                return 'Preview generated';
            case 'submitted':
                return brokerStatus ? `Combo order: ${brokerStatus}` : 'Combo sent to TWS';
            case 'test_submitted':
                return brokerStatus ? `Test order: ${brokerStatus}` : 'Test order sent to TWS';
            case 'error':
                return 'Trigger error';
            default:
                return trigger.enabled ? 'Armed' : 'Idle';
        }
    }

    function formatCloseExecutionStatus(closeExecution) {
        if (!closeExecution) return 'Idle';
        const brokerStatus = String(closeExecution.lastPreview && closeExecution.lastPreview.status || '').trim();

        switch (closeExecution.status) {
            case 'pending_preview':
                return 'Generating close preview...';
            case 'pending_validation':
                return 'Preparing close order, validating combo legs...';
            case 'pending_submit':
                return 'Sending close order to TWS...';
            case 'pending_resume':
                return 'Requesting more close-order retries...';
            case 'pending_concede':
                return 'Updating close order price with concession...';
            case 'pending_cancel':
                return 'Cancelling close order in TWS...';
            case 'previewed':
                return 'Close preview generated';
            case 'submitted':
                return brokerStatus ? `Close order: ${brokerStatus}` : 'Close order sent to TWS';
            case 'test_submitted':
                return brokerStatus ? `Close test order: ${brokerStatus}` : 'Close test order sent to TWS';
            case 'error':
                return 'Close order error';
            default:
                return brokerStatus ? `Close order: ${brokerStatus}` : 'Idle';
        }
    }

    function hasTradeTriggerRuntime(trigger) {
        return !!(trigger
            && (trigger.pendingRequest
                || trigger.lastError
                || trigger.lastPreview));
    }

    function resolveTradeTriggerUiState(activeViewMode, trigger) {
        const hasRuntime = hasTradeTriggerRuntime(trigger);
        const showToggle = activeViewMode === 'trial' || !!(trigger && trigger.enabled) || hasRuntime;
        return {
            showToggle,
            showPanel: hasRuntime || !!(trigger && trigger.enabled) || (showToggle && trigger && trigger.isExpanded === true),
            hasRuntime,
        };
    }

    function hasCloseGroupRuntime(closeExecution) {
        return !!(closeExecution
            && (closeExecution.pendingRequest
                || closeExecution.lastError
                || closeExecution.lastPreview));
    }

    function isCloseExecutionCompleted(closeExecution) {
        const brokerStatus = String(closeExecution && closeExecution.lastPreview && closeExecution.lastPreview.status || '').trim();
        return brokerStatus === 'Filled';
    }

    function resolveCloseGroupUiState(activeViewMode, hasOpenPosition, closeExecution) {
        const hasRuntime = hasCloseGroupRuntime(closeExecution);
        const isCompleted = isCloseExecutionCompleted(closeExecution);
        const showToggle = !isCompleted && ((activeViewMode === 'active' && hasOpenPosition) || hasRuntime);
        return {
            showToggle,
            showPanel: hasRuntime || (showToggle && closeExecution && closeExecution.isExpanded === true),
            hasRuntime,
        };
    }

    function buildTriggerPreviewHtml(trigger, currencyFormatter) {
        if (!trigger) return '';

        if (trigger.lastError) {
            return `<span class="danger-text">${trigger.lastError}</span>`;
        }

        const preview = trigger.lastPreview;
        if (!preview) return '';
        const isReasonableNumber = (value) => Number.isFinite(value) && Math.abs(value) < 1e100;
        const statusValue = String(preview.status || '').trim();
        const isTerminalOrderStatus = ['Cancelled', 'ApiCancelled', 'Inactive', 'Filled'].includes(statusValue);

        const legs = Array.isArray(preview.legs) ? preview.legs : [];
        const legsHtml = legs
            .map((leg, index) => {
                const markText = Number.isFinite(leg.mark)
                    ? ` @ ${currencyFormatter.format(leg.mark)}`
                    : '';
                return `<div>Leg ${index + 1}: ${leg.executionAction} ${leg.ratio} ${leg.localSymbol || leg.symbol}${markText}</div>`;
            })
            .join('');

        const limitText = Number.isFinite(preview.limitPrice)
            ? currencyFormatter.format(preview.limitPrice)
            : 'N/A';

        const orderTarget = preview.comboSymbol || 'BAG';
        const legCountLabel = legs.length === 1 ? '1 leg' : `${legs.length} legs`;
        const isTestOnly = preview.executionMode === 'test_submit';
        const isCloseIntent = String(preview.executionIntent || '').trim() === 'close';
        const summaryHeader = isCloseIntent
            ? 'CLOSE ORDER SUMMARY'
            : (isTestOnly ? 'TEST ORDER SUMMARY' : 'ORDER SUMMARY');
        const netLabel = isCloseIntent
            ? 'Net close order:'
            : (isTestOnly ? 'Net test order:' : 'Net order:');
        const pricingSourceLabel = preview.pricingSource === 'test_guardrail'
            ? 'test-only guardrail'
            : (preview.pricingSource || 'middle');
        const summaryText = [
            `<div class="small text-muted" style="font-weight: 600; letter-spacing: 0.02em;">${summaryHeader}</div>`,
            `<div><strong>${netLabel}</strong> ${(preview.orderAction || 'BUY')} ${(preview.totalQuantity || 0)} ${orderTarget} @ ${limitText} LMT${preview.timeInForce ? ` ${preview.timeInForce}` : ''}</div>`,
            `<div class="small text-muted">Structure: ${legCountLabel}, pricing source: ${pricingSourceLabel}</div>`,
        ].join('');
        const pricingNote = preview.pricingNote
            ? `<div class="text-muted" style="margin-top: 8px;">${preview.pricingNote}</div>`
            : '';
        const detailText = legsHtml
            ? [
                '<div class="small text-muted" style="margin-top: 10px; font-weight: 600; letter-spacing: 0.02em;">LEG DETAILS</div>',
                legsHtml,
            ].join('')
            : '';
        const brokerStatusText = preview.status
            ? `<div class="text-muted" style="margin-top: 8px;">Broker status: ${preview.status}${preview.orderId ? ` (Order ID ${preview.orderId})` : ''}${preview.permId ? `, Perm ID ${preview.permId}` : ''}</div>`
            : '';
        const managedStateText = preview.managedMode
            ? `<div class="text-muted" style="margin-top: 8px;">Managed execution: ${preview.managedState || 'watching'}${Number.isFinite(preview.workingLimitPrice) ? `, Working LMT ${currencyFormatter.format(preview.workingLimitPrice)}` : ''}${Number.isFinite(preview.latestComboMid) ? `, Latest combo mid ${currencyFormatter.format(preview.latestComboMid)}` : ''}${Number.isFinite(preview.managedRepriceThreshold) ? `, Drift threshold ${preview.managedRepriceThreshold.toFixed(2)}` : ''}${Number.isFinite(preview.managedConcessionRatio) && preview.managedConcessionRatio > 0 ? `, Concession ${Math.round(preview.managedConcessionRatio * 100)}%` : ''}</div>`
            : '';
        const quoteRangeText = preview.managedMode
            && Number.isFinite(preview.bestComboPrice)
            && Number.isFinite(preview.worstComboPrice)
            ? `<div class="text-muted" style="margin-top: 4px;">Quoted combo range: best ${currencyFormatter.format(preview.bestComboPrice)} to worst ${currencyFormatter.format(preview.worstComboPrice)}</div>`
            : '';
        const managedRepriceText = preview.managedMode && (Number.isFinite(preview.repricingCount) || preview.lastRepriceAt)
            ? `<div class="text-muted" style="margin-top: 4px;">Reprices: ${preview.repricingCount || 0}${Number.isFinite(preview.maxRepriceCount) ? ` / ${preview.maxRepriceCount}` : ''}${preview.lastRepriceAt ? `, Last repriced: ${preview.lastRepriceAt}` : ''}</div>`
            : '';
        const remainingDisplay = isTerminalOrderStatus
            ? 0
            : (preview.remaining || 0);
        const fillStatusText = Number.isFinite(preview.remaining) || Number.isFinite(preview.filled)
            ? `<div class="text-muted" style="margin-top: 4px;">Filled: ${preview.filled || 0}, Remaining: ${remainingDisplay}${Number.isFinite(preview.avgFillPrice) && preview.avgFillPrice > 0 ? `, Avg fill: ${currencyFormatter.format(preview.avgFillPrice)}` : ''}</div>`
            : '';
        const whatIfWarning = preview.whatIf && preview.whatIf.warningText
            ? `<div class="text-muted" style="margin-top: 8px;">${preview.whatIf.warningText}</div>`
            : '';
        const whatIfCommission = preview.whatIf && isReasonableNumber(preview.whatIf.commission)
            ? `<div class="text-muted" style="margin-top: 8px;">What-if commission: ${preview.whatIf.commission} ${preview.whatIf.commissionCurrency || ''}</div>`
            : '';
        const statusMessageText = preview.statusMessage
            ? `<div class="text-muted" style="margin-top: 8px;">${preview.statusMessage}</div>`
            : '';
        const managedMessageText = preview.managedMessage
            ? `<div class="text-muted" style="margin-top: 8px;">${preview.managedMessage}</div>`
            : '';

        return `${summaryText}${detailText}${pricingNote}${brokerStatusText}${managedStateText}${quoteRangeText}${managedRepriceText}${fillStatusText}${statusMessageText}${managedMessageText}${whatIfCommission}${whatIfWarning}`;
    }

    function resolveTriggerActionState(trigger) {
        if (!trigger || !trigger.lastPreview || typeof trigger.lastPreview !== 'object') {
            return null;
        }

        if (trigger.pendingRequest) {
            return null;
        }

        const preview = trigger.lastPreview;
        if (!preview.orderId) {
            return null;
        }

        const brokerStatus = String(preview.status || '').trim();
        const isTerminal = ['Filled', 'Cancelled', 'ApiCancelled', 'Inactive'].includes(brokerStatus);
        if (isTerminal) {
            return null;
        }
        if (preview.managedState === 'cancelling') {
            return null;
        }

        const actions = [];
        let label = preview.continueActionLabel || '';
        if (preview.canContinueRepricing && !label) {
            if (preview.managedState === 'stopped_max_reprices') {
                label = 'Continue Auto-Repricing';
            } else if (preview.managedState === 'stopped_timeout') {
                label = 'Continue Monitoring';
            } else {
                label = 'Continue Auto-Repricing';
            }
        }
        if (preview.canContinueRepricing) {
            actions.push({
                kind: 'continue',
                label,
                className: 'btn btn-secondary btn-sm trial-trigger-continue-repricing-btn',
            });
        }
        if (preview.canConcedePricing) {
            actions.push({
                kind: 'concede_select',
                className: 'trial-trigger-concede-group',
                options: [0.10, 0.20, 0.30, 0.50].map((ratio) => ({
                    value: ratio.toFixed(2),
                    label: `Concede ${Math.round(ratio * 100)}%`,
                })),
            });
        }
        actions.push({
            kind: 'cancel',
            label: 'Cancel Order',
            className: 'btn btn-secondary btn-sm trial-trigger-cancel-order-btn',
        });

        return {
            actions,
            signature: `${preview.orderId}:${preview.managedState || ''}:${preview.status || ''}:${preview.canContinueRepricing ? 'continue' : 'nocontinue'}:${preview.canConcedePricing ? 'concede' : 'noconcede'}`,
        };
    }

    function renderTriggerAction(action) {
        if (action.kind === 'concede_select') {
            const optionsHtml = (Array.isArray(action.options) ? action.options : [])
                .map((option, index) => `<option value="${option.value}"${index === 0 ? ' selected' : ''}>${option.label}</option>`)
                .join('');
            return `
                <div class="${action.className}" style="display: inline-flex; align-items: center; gap: 0.45rem; margin-right: 0.5rem;">
                    <select class="leg-input leg-input-sm trial-trigger-concede-select" style="width: 140px;">
                        ${optionsHtml}
                    </select>
                    <button type="button" class="btn btn-secondary btn-sm trial-trigger-concede-btn">Apply</button>
                </div>
            `;
        }

        return `<button type="button" class="${action.className}"${action.value ? ` data-value="${action.value}"` : ''} style="margin-right: 0.5rem;">${action.label}</button>`;
    }

    function formatSignedCurrencyValue(currencyFormatter, value, positiveClass, negativeClass) {
        if (!Number.isFinite(value)) {
            return `<span class="text-muted">N/A</span>`;
        }
        return `<span class="${value >= 0 ? positiveClass : negativeClass}">${value >= 0 ? '+' : ''}${currencyFormatter.format(value)}</span>`;
    }

    function formatRealizedPnLValue(currencyFormatter, value) {
        return `<span class="badge ${value >= 0 ? 'bg-success' : 'bg-danger'}" style="font-size: 0.85rem; padding: 4px 6px;">Realized: <br/>${value >= 0 ? '+' : ''}${currencyFormatter.format(value)}</span>`;
    }

    function buildGroupLivePnlHtml(currencyFormatter, value) {
        return formatSignedCurrencyValue(currencyFormatter, value, 'success-text', 'danger-text');
    }

    function resolveGroupHeaderSummaryState(groupResult) {
        if (groupResult.activeViewMode === 'settlement' && Number.isFinite(groupResult.groupPnL)) {
            return {
                type: 'settlement',
                label: 'Settlement P&L:',
                value: groupResult.groupPnL,
            };
        }

        if (groupResult.isAmortizedMode && Number.isFinite(groupResult.groupPnL)) {
            return {
                type: 'amortized',
                label: 'Amortized P&L:',
                value: groupResult.groupPnL,
            };
        }

        if (groupResult.groupHasLiveData) {
            return {
                type: 'live',
                label: 'Live P&L:',
                value: groupResult.groupLivePnL,
            };
        }

        return null;
    }

    function buildSimulatedPriceHtml(currencyFormatter, leg, processedLeg, simPricePerShare, usesScenarioUnderlying) {
        if (!Number.isFinite(simPricePerShare)) {
            return `<span class="text-muted">N/A</span> <span class="badge bg-secondary" style="font-size: 0.65rem; vertical-align: middle;">IV N/A</span>`;
        }

        let simPriceHtml = currencyFormatter.format(simPricePerShare);

        if (leg.closePrice !== null && leg.closePrice !== '') {
            simPriceHtml += ` <span class="badge" style="background: var(--primary-color); font-size: 0.65rem; vertical-align: middle;">Closed</span>`;
        } else if (usesScenarioUnderlying) {
            if (processedLeg.isExpired) {
                if (simPricePerShare > 0) {
                    simPriceHtml += ` <span class="badge" style="background: var(--success-color); font-size: 0.65rem; vertical-align: middle;">Exercised</span>`;
                } else {
                    simPriceHtml += ` <span class="badge bg-secondary" style="font-size: 0.65rem; vertical-align: middle;">Expired</span>`;
                }
            } else {
                simPriceHtml += ` <span class="badge" style="background: var(--warning-color); font-size: 0.65rem; vertical-align: middle;">Active</span>`;
            }
        }

        return simPriceHtml;
    }

    function applyLegDerivedData(card, groupResult, currencyFormatter) {
        card.querySelectorAll('.leg-row').forEach(tr => {
            const legResult = groupResult.legResultsById.get(tr.dataset.id);
            if (!legResult) return;

            if (isOptionLeg(legResult.leg)) {
                const dteDisplay = tr.querySelector('.simulated-dte-display');
                const ivDisplay = tr.querySelector('.simulated-iv-display');
                const ivInput = tr.querySelector('.iv-input');
                if (dteDisplay) dteDisplay.textContent = legResult.dteText;
                if (ivDisplay) ivDisplay.textContent = legResult.ivText;
                if (ivInput
                    && document.activeElement !== ivInput
                    && typeof OptionComboPricingCore !== 'undefined'
                    && typeof OptionComboPricingCore.describeLegIvInput === 'function') {
                    const ivInputDisplay = OptionComboPricingCore.describeLegIvInput(legResult.leg);
                    ivInput.value = ivInputDisplay.value;
                    ivInput.title = ivInputDisplay.title;
                }
            }

            const currentPriceInput = tr.querySelector('.current-price-input');
            if (currentPriceInput) {
                currentPriceInput.value = legResult.currentPriceDisplay.value;
                currentPriceInput.placeholder = legResult.currentPriceDisplay.placeholder;
                currentPriceInput.title = legResult.currentPriceDisplay.title;
            }

            const simulatedPriceCell = tr.querySelector('.simulated-price-cell');
            if (simulatedPriceCell) {
                simulatedPriceCell.innerHTML = buildSimulatedPriceHtml(
                    currencyFormatter,
                    legResult.leg,
                    legResult.processedLeg,
                    legResult.simPricePerShare,
                    groupResult.usesScenarioUnderlying
                );
            }

            const pnlCell = tr.querySelector('.pnl-cell');
            if (pnlCell) {
                pnlCell.innerHTML = legResult.isClosed
                    ? formatRealizedPnLValue(currencyFormatter, legResult.pnl)
                    : formatSignedCurrencyValue(currencyFormatter, legResult.pnl, 'profit', 'loss');
            }

            const livePnlCell = tr.querySelector('.live-pnl-cell');
            if (livePnlCell) {
                if (legResult.hasLivePnl) {
                    if (legResult.isClosed) {
                        livePnlCell.style.display = 'none';
                    } else {
                        livePnlCell.innerHTML = formatSignedCurrencyValue(currencyFormatter, legResult.liveLegPnL, 'success-text', 'danger-text');
                        livePnlCell.style.display = 'block';
                    }
                } else {
                    livePnlCell.style.display = 'none';
                }
            }
        });
    }

    function applyGroupDerivedData(card, groupResult, currencyFormatter, chartApi) {
        applyLegDerivedData(card, groupResult, currencyFormatter);

        const triggerContainer = card.querySelector('.trial-trigger-container');
        if (triggerContainer) {
            const triggerUiState = resolveTradeTriggerUiState(groupResult.activeViewMode, groupResult.group.tradeTrigger);
            triggerContainer.style.display = triggerUiState.showPanel ? 'block' : 'none';

            const triggerToggleBtn = card.querySelector('.trial-trigger-toggle-btn');
            if (triggerToggleBtn) {
                triggerToggleBtn.style.display = triggerUiState.showToggle ? 'inline-flex' : 'none';
                triggerToggleBtn.classList.toggle('active', triggerUiState.showPanel);
                triggerToggleBtn.setAttribute('aria-expanded', triggerUiState.showPanel ? 'true' : 'false');
                triggerToggleBtn.title = triggerUiState.showPanel
                    ? 'Hide trial-trigger controls'
                    : 'Show trial-trigger controls';
            }

            const triggerBody = triggerContainer.querySelector('.trial-trigger-body');
            const collapseBtn = triggerContainer.querySelector('.trial-trigger-collapse-btn');
            const chevron = triggerContainer.querySelector('.trial-trigger-chevron');

            if (triggerBody) {
                triggerBody.style.display = groupResult.group.tradeTrigger && groupResult.group.tradeTrigger.isCollapsed ? 'none' : 'block';
            }
            if (collapseBtn) {
                collapseBtn.title = groupResult.group.tradeTrigger && groupResult.group.tradeTrigger.isCollapsed
                    ? 'Expand Trial Trigger'
                    : 'Collapse Trial Trigger';
                collapseBtn.setAttribute('aria-expanded', groupResult.group.tradeTrigger && groupResult.group.tradeTrigger.isCollapsed ? 'false' : 'true');
            }
            if (chevron) {
                chevron.style.transform = groupResult.group.tradeTrigger && groupResult.group.tradeTrigger.isCollapsed
                    ? 'rotate(-90deg)'
                    : 'rotate(0deg)';
                chevron.style.transition = 'transform 0.18s ease';
            }

            const statusEl = triggerContainer.querySelector('.trial-trigger-status');
            if (statusEl) {
                statusEl.textContent = formatTriggerStatus(groupResult.group.tradeTrigger);
                statusEl.className = `trial-trigger-status small ${groupResult.group.tradeTrigger && groupResult.group.tradeTrigger.status === 'error'
                    ? 'danger-text'
                    : 'text-muted'}`;
            }

            const previewEl = triggerContainer.querySelector('.trial-trigger-preview');
            if (previewEl) {
                const previewHtml = buildTriggerPreviewHtml(groupResult.group.tradeTrigger, currencyFormatter);
                previewEl.innerHTML = previewHtml;
                previewEl.style.display = previewHtml ? 'block' : 'none';
            }

            const actionsEl = triggerContainer.querySelector('.trial-trigger-actions');
            if (actionsEl) {
                const actionState = resolveTriggerActionState(groupResult.group.tradeTrigger);
                if (!actionState) {
                    actionsEl.style.display = 'none';
                    actionsEl.innerHTML = '';
                    actionsEl.dataset.actionSignature = '';
                } else {
                    actionsEl.style.display = 'block';
                    if (actionsEl.dataset.actionSignature !== actionState.signature) {
                        actionsEl.innerHTML = actionState.actions
                            .map(renderTriggerAction)
                            .join('');
                        actionsEl.dataset.actionSignature = actionState.signature;
                    }
                }
            }
        }

        const closeContainer = card.querySelector('.close-group-container');
        if (closeContainer) {
            const closeExecution = groupResult.group.closeExecution || null;
            const hasOpenPosition = typeof OptionComboSessionLogic !== 'undefined'
                && typeof OptionComboSessionLogic.groupHasOpenPosition === 'function'
                ? OptionComboSessionLogic.groupHasOpenPosition(groupResult.group)
                : (groupResult.group.legs || []).some(leg => Math.abs(parseFloat(leg && leg.pos) || 0) > 0.0001);
            const closeUiState = resolveCloseGroupUiState(groupResult.activeViewMode, hasOpenPosition, closeExecution);
            closeContainer.style.display = closeUiState.showPanel ? 'block' : 'none';

            const closeToggleBtn = card.querySelector('.close-group-toggle-btn');
            if (closeToggleBtn) {
                closeToggleBtn.style.display = closeUiState.showToggle ? 'inline-flex' : 'none';
                closeToggleBtn.classList.toggle('active', closeUiState.showPanel);
                closeToggleBtn.setAttribute('aria-expanded', closeUiState.showPanel ? 'true' : 'false');
                closeToggleBtn.title = closeUiState.showPanel
                    ? 'Hide close-group controls'
                    : 'Show close-group controls';
            }

            const statusEl = closeContainer.querySelector('.close-group-status');
            if (statusEl) {
                statusEl.textContent = formatCloseExecutionStatus(closeExecution);
                statusEl.className = `close-group-status small ${closeExecution && closeExecution.status === 'error'
                    ? 'danger-text'
                    : 'text-muted'}`;
            }

            const previewEl = closeContainer.querySelector('.close-group-preview');
            if (previewEl) {
                const previewHtml = buildTriggerPreviewHtml(closeExecution, currencyFormatter);
                previewEl.innerHTML = previewHtml;
                previewEl.style.display = previewHtml ? 'block' : 'none';
            }

            const actionsEl = closeContainer.querySelector('.close-group-actions');
            if (actionsEl) {
                const actionState = resolveTriggerActionState(closeExecution);
                if (!actionState) {
                    actionsEl.style.display = 'none';
                    actionsEl.innerHTML = '';
                    actionsEl.dataset.actionSignature = '';
                } else {
                    actionsEl.style.display = 'block';
                    if (actionsEl.dataset.actionSignature !== actionState.signature) {
                        actionsEl.innerHTML = actionState.actions
                            .map(renderTriggerAction)
                            .join('');
                        actionsEl.dataset.actionSignature = actionState.signature;
                    }
                }
            }
        }

        card.querySelector('.group-cost').textContent = currencyFormatter.format(groupResult.groupCost);
        card.querySelector('.group-sim-value').textContent = Number.isFinite(groupResult.groupSimValue)
            ? currencyFormatter.format(groupResult.groupSimValue)
            : 'N/A';
        card.querySelector('.group-pnl').innerHTML = formatSignedCurrencyValue(currencyFormatter, groupResult.groupPnL, 'success-text', 'danger-text');

        const amContainer = card.querySelector('.amortization-container');
        const settleControls = card.querySelector('.settlement-controls');
        const simulateBtn = card.querySelector('.btn-simulate-amortized');

        if (groupResult.usesScenarioUnderlying) {
            if (settleControls) settleControls.style.display = 'flex';
            if (simulateBtn) simulateBtn.style.display = groupResult.isAmortizedMode ? 'inline-flex' : 'none';
        } else {
            if (settleControls) settleControls.style.display = 'none';
            if (simulateBtn) simulateBtn.style.display = 'none';
        }

        if (groupResult.isAmortizedMode) {
            if (amContainer) {
                const amText = card.querySelector('.amortization-text');
                if (groupResult.amortizedResult && groupResult.amortizedResult.isSupported === false && amText) {
                    amText.textContent = groupResult.amortizedResult.reason;
                    amContainer.style.display = 'block';
                } else if (groupResult.amortizedResult && groupResult.amortizedResult.netDeliverables !== 0 && amText) {
                    const action = groupResult.amortizedResult.netDeliverables > 0
                        ? groupResult.amortizedResult.positiveActionLabel
                        : groupResult.amortizedResult.negativeActionLabel;
                    const label = Math.abs(groupResult.amortizedResult.netDeliverables) === 1
                        ? groupResult.amortizedResult.deliverableUnitSingular
                        : groupResult.amortizedResult.deliverableUnitPlural;
                    amText.textContent = `${action} ${Math.abs(groupResult.amortizedResult.netDeliverables)} ${label} with effective basis of ${currencyFormatter.format(groupResult.amortizedResult.basis)}`;
                    amContainer.style.display = 'block';
                } else {
                    amContainer.style.display = 'none';
                }
            }
        } else {
            if (amContainer) amContainer.style.display = 'none';
            const amortChartContainer = card.querySelector('.amortization-chart-container');
            if (amortChartContainer) {
                amortChartContainer.style.display = 'none';
                if (simulateBtn) {
                    simulateBtn.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
                            <line x1="18" y1="20" x2="18" y2="10"></line>
                            <line x1="12" y1="20" x2="12" y2="4"></line>
                            <line x1="6" y1="20" x2="6" y2="14"></line>
                        </svg>
                        Simulate Amortized Price
                    `;
                }
            }
        }

        const pnlContainer = card.querySelector('.pnl-container');
        const pnlLabel = card.querySelector('.group-pnl-label');
        if (pnlContainer && pnlLabel) {
            if (groupResult.activeViewMode === 'settlement') {
                pnlLabel.textContent = 'Settlement P&L:';
                pnlContainer.classList.add('settlement-highlight');
            } else {
                pnlLabel.textContent = 'Theo P&L:';
                pnlContainer.classList.remove('settlement-highlight');
            }
        }

        const simPnlHeader = card.querySelector('.sim-pnl-header-text');
        const livePnlHeader = card.querySelector('.live-pnl-header-text');
        const showChartBtn = card.querySelector('.toggle-chart-btn');
        if (simPnlHeader && livePnlHeader) {
            if (groupResult.usesScenarioUnderlying) {
                simPnlHeader.textContent = groupResult.isAmortizedMode ? 'AMORTIZED P&L' : 'SETTLEMENT P&L';
                livePnlHeader.style.display = 'none';
                if (showChartBtn) showChartBtn.style.display = 'none';
            } else {
                simPnlHeader.textContent = 'Theo P&L';
                livePnlHeader.style.display = groupResult.groupHasLiveData ? 'inline' : 'none';
                if (showChartBtn) showChartBtn.style.display = 'inline-block';
            }
        }

        const livePnlItem = card.querySelector('.group-header-live-pnl-item');
        if (livePnlItem) {
            const headerSummaryState = resolveGroupHeaderSummaryState(groupResult);
            if (headerSummaryState) {
                livePnlItem.style.display = '';
                livePnlItem.dataset.summaryType = headerSummaryState.type;
                const livePnlLabel = card.querySelector('.group-header-live-pnl-label');
                const livePnlSpan = card.querySelector('.group-header-live-pnl');
                if (livePnlLabel) livePnlLabel.textContent = headerSummaryState.label;
                if (livePnlSpan) livePnlSpan.innerHTML = buildGroupLivePnlHtml(currencyFormatter, headerSummaryState.value);
            } else {
                livePnlItem.style.display = 'none';
                delete livePnlItem.dataset.summaryType;
            }
        }

        const chartContainer = card.querySelector('.chart-container');
        if (chartContainer && chartContainer.style.display !== 'none') {
            chartApi.drawGroupChart(card, groupResult.group);
        }

        const amortChartContainer = card.querySelector('.amortization-chart-container');
        if (amortChartContainer && amortChartContainer.style.display !== 'none') {
            const amortCanvas = amortChartContainer.querySelector('.amortization-canvas');
            const marginCanvas = amortChartContainer.querySelector('.margin-canvas');
            if (amortCanvas) chartApi.drawAmortizationChart(card, groupResult.group, amortCanvas, marginCanvas);
        }
    }

    globalScope.OptionComboGroupUI = {
        applyGroupDerivedData,
        buildTriggerPreviewHtml,
        buildGroupLivePnlHtml,
        resolveGroupHeaderSummaryState,
        resolveTriggerActionState,
        resolveTradeTriggerUiState,
        resolveCloseGroupUiState,
        renderTriggerAction,
        formatCloseExecutionStatus,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
