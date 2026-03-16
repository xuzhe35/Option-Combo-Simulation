/**
 * Group DOM writers.
 */

(function attachGroupUi(globalScope) {
    function formatSignedCurrencyValue(currencyFormatter, value, positiveClass, negativeClass) {
        return `<span class="${value >= 0 ? positiveClass : negativeClass}">${value >= 0 ? '+' : ''}${currencyFormatter.format(value)}</span>`;
    }

    function formatRealizedPnLValue(currencyFormatter, value) {
        return `<span class="badge ${value >= 0 ? 'bg-success' : 'bg-danger'}" style="font-size: 0.85rem; padding: 4px 6px;">Realized: <br/>${value >= 0 ? '+' : ''}${currencyFormatter.format(value)}</span>`;
    }

    function buildSimulatedPriceHtml(currencyFormatter, leg, processedLeg, simPricePerShare, usesScenarioUnderlying) {
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

            if (legResult.leg.type !== 'stock') {
                const dteDisplay = tr.querySelector('.simulated-dte-display');
                const ivDisplay = tr.querySelector('.simulated-iv-display');
                if (dteDisplay) dteDisplay.textContent = legResult.dteText;
                if (ivDisplay) ivDisplay.textContent = legResult.ivText;
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

        card.querySelector('.group-cost').textContent = currencyFormatter.format(groupResult.groupCost);
        card.querySelector('.group-sim-value').textContent = currencyFormatter.format(groupResult.groupSimValue);
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
                pnlLabel.textContent = 'P&L:';
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
                simPnlHeader.textContent = 'Sim P&L';
                if (groupResult.groupHasLiveData) livePnlHeader.style.display = 'inline';
                if (showChartBtn) showChartBtn.style.display = 'inline-block';
            }
        }

        const livePnlItem = card.querySelector('.group-live-pnl-item');
        if (livePnlItem) {
            if (groupResult.groupHasLiveData) {
                livePnlItem.style.display = '';
                const livePnlSpan = card.querySelector('.group-live-pnl');
                livePnlSpan.innerHTML = formatSignedCurrencyValue(currencyFormatter, groupResult.groupLivePnL, 'success-text', 'danger-text');
            } else {
                livePnlItem.style.display = 'none';
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
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
