/**
 * Global DOM writers.
 */

(function attachGlobalUi(globalScope) {
    function formatSignedCurrencyValue(currencyFormatter, value, positiveClass, negativeClass) {
        if (!Number.isFinite(value)) {
            return '<span class="text-muted">N/A</span>';
        }
        return `<span class="${value >= 0 ? positiveClass : negativeClass}">${value >= 0 ? '+' : ''}${currencyFormatter.format(value)}</span>`;
    }

    function formatContractQuantity(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || Math.abs(parsed) < 0.000001) {
            return '0';
        }
        return parsed.toLocaleString(undefined, {
            maximumFractionDigits: 4,
        });
    }

    function formatOptionRedundancyBucket(label, bucket) {
        const summary = bucket && typeof bucket === 'object' ? bucket : {};
        const netContracts = Number(summary.netContracts);
        if (!Number.isFinite(netContracts) || Math.abs(netContracts) < 0.000001) {
            return `${label} 0`;
        }
        return `${label} ${netContracts > 0 ? '+' : ''}${formatContractQuantity(netContracts)}`;
    }

    function formatOptionLegRedundancyTitle(optionLegRedundancy) {
        const call = optionLegRedundancy && optionLegRedundancy.call ? optionLegRedundancy.call : {};
        const put = optionLegRedundancy && optionLegRedundancy.put ? optionLegRedundancy.put : {};
        return [
            'All groups, open option legs only.',
            `Call buy ${formatContractQuantity(call.buyContracts)} / sell ${formatContractQuantity(call.sellContracts)}.`,
            `Put buy ${formatContractQuantity(put.buyContracts)} / sell ${formatContractQuantity(put.sellContracts)}.`,
        ].join(' ');
    }

    function applyOptionLegRedundancy(derivedData) {
        const valueEl = document.getElementById('optionLegRedundancy');
        if (!valueEl) {
            return;
        }

        const summary = derivedData && derivedData.optionLegRedundancy ? derivedData.optionLegRedundancy : {};
        valueEl.textContent = [
            formatOptionRedundancyBucket('C', summary.call),
            formatOptionRedundancyBucket('P', summary.put),
        ].join(' / ');
        valueEl.title = formatOptionLegRedundancyTitle(summary);
    }

    function formatSignedQuantity(value, suffix = '') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return `--${suffix}`;
        }
        const formatted = Math.abs(parsed).toLocaleString(undefined, {
            maximumFractionDigits: 4,
        });
        return `${parsed > 0 ? '+' : (parsed < 0 ? '-' : '')}${formatted}${suffix}`;
    }

    function formatProjectedOptionDelivery(result) {
        const delivery = result && typeof result === 'object' ? result : {};
        if (delivery.status === 'cash_settled') {
            return {
                html: '<span class="text-muted">Cash settled</span>',
                title: 'This product is cash-settled, so option expiry does not create an underlying position.',
            };
        }
        if (delivery.status === 'non_equity_delivery') {
            return {
                html: '<span class="text-muted">Futures delivery</span>',
                title: 'This compact share projection is only shown for equity-deliverable options. Futures-option delivery remains contract-specific.',
            };
        }
        if (delivery.available !== true) {
            const reason = delivery.status === 'current_price_unavailable'
                ? 'Current underlying price is unavailable.'
                : 'Simulation date is unavailable.';
            return {
                html: '<span class="text-muted">Expiry: --</span>',
                title: `Projected expiry delivery is unavailable. ${reason}`,
            };
        }

        const callContracts = Number(delivery.callContracts) || 0;
        const putContracts = Number(delivery.putContracts) || 0;
        const netDeliverables = Number(delivery.netDeliverables) || 0;
        const contractParts = [];
        if (Math.abs(callContracts) > 0.000001) {
            contractParts.push(`${formatSignedQuantity(callContracts)} CALL`);
        }
        if (Math.abs(putContracts) > 0.000001) {
            contractParts.push(`${formatSignedQuantity(putContracts)} PUT`);
        }
        if (contractParts.length === 0) {
            contractParts.push('0 ITM');
        }
        const symbol = String(delivery.underlyingSymbol || 'Underlying').trim().toUpperCase();
        const valueClass = netDeliverables > 0
            ? 'success-text'
            : (netDeliverables < 0 ? 'danger-text' : 'text-muted');
        const priceText = Number.isFinite(delivery.referencePrice)
            ? ` at a fixed current ${symbol} price of ${delivery.referencePrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
            : '';
        const unitLabel = Math.abs(netDeliverables) === 1
            ? (delivery.deliverableUnitSingular || 'share')
            : (delivery.deliverableUnitPlural || 'shares');
        return {
            html: `<span class="${valueClass}">${contractParts.join(' / ')} &rarr; ${formatSignedQuantity(netDeliverables)} ${symbol}</span>`,
            title: `Assuming the current underlying price stays unchanged${priceText}, open in-the-money options expiring on or before ${delivery.simulationDate} in Groups included in global totals project to ${formatSignedQuantity(netDeliverables)} ${unitLabel}. Unchecked Groups, closed legs, and later expiries are excluded.`,
        };
    }

    function applyProjectedOptionDelivery(derivedData) {
        const valueEl = document.getElementById('projectedOptionDelivery');
        if (!valueEl) {
            return;
        }
        const formatted = formatProjectedOptionDelivery(derivedData && derivedData.projectedOptionDelivery);
        valueEl.innerHTML = formatted.html;
        valueEl.title = formatted.title;
    }

    function applyGlobalDerivedData(derivedData, currencyFormatter, chartApi) {
        document.getElementById('totalCost').textContent = currencyFormatter.format(derivedData.globalTotalCost);
        document.getElementById('simulatedValue').textContent = Number.isFinite(derivedData.globalSimulatedValue)
            ? currencyFormatter.format(derivedData.globalSimulatedValue)
            : 'N/A';
        document.getElementById('unrealizedPnL').innerHTML = formatSignedCurrencyValue(currencyFormatter, derivedData.globalPnL, 'profit', 'loss');
        const allGroupsNetCashFlowValue = document.getElementById('allGroupsNetCashFlowValue');
        if (allGroupsNetCashFlowValue) {
            allGroupsNetCashFlowValue.innerHTML = formatSignedCurrencyValue(
                currencyFormatter,
                derivedData.allGroupsNetCashFlow,
                'success-text',
                'danger-text'
            );
        }
        applyOptionLegRedundancy(derivedData);
        applyProjectedOptionDelivery(derivedData);

        const globalLivePnLRow = document.getElementById('globalLivePnLRow');
        if (globalLivePnLRow) {
            if (derivedData.hasAnyLiveData) {
                globalLivePnLRow.style.display = '';
                document.getElementById('globalLivePnL').innerHTML = formatSignedCurrencyValue(currencyFormatter, derivedData.globalLivePnL, 'success-text', 'danger-text');
            } else {
                globalLivePnLRow.style.display = 'none';
            }
        }

        const hedgeLivePnLRow = document.getElementById('hedgeLivePnLRow');
        if (hedgeLivePnLRow) {
            if (derivedData.hasAnyHedgeLivePnL) {
                hedgeLivePnLRow.style.display = '';
                document.getElementById('hedgeLivePnL').innerHTML = formatSignedCurrencyValue(currencyFormatter, derivedData.globalHedgePnL, 'success-text', 'danger-text');
            } else {
                hedgeLivePnLRow.style.display = 'none';
            }
        }

        const totalLivePnLRow = document.getElementById('totalLivePnLRow');
        if (totalLivePnLRow) {
            if (derivedData.hasAnyLiveData || derivedData.hasAnyHedgeLivePnL) {
                totalLivePnLRow.style.display = '';
                document.getElementById('totalLivePnL').innerHTML = formatSignedCurrencyValue(currencyFormatter, derivedData.combinedLivePnL, 'success-text', 'danger-text');
            } else {
                totalLivePnLRow.style.display = 'none';
            }
        }

        const globalAmortizedCard = document.getElementById('globalAmortizedCard');
        const globalAmortizedBanner = document.getElementById('globalAmortizedBanner');
        const globalAmortizedText = document.getElementById('globalAmortizedText');
        const globalAmortizedInfoText = document.getElementById('globalAmortizedInfoText');

        if (globalAmortizedCard && globalAmortizedBanner && globalAmortizedText && globalAmortizedInfoText) {
            if (derivedData.combinedAmortizedResult) {
                globalAmortizedCard.style.display = 'block';
                globalAmortizedBanner.style.display = 'block';
                globalAmortizedInfoText.textContent = `Banner uses each amortized group's scenario override when set. Chart uses a shared global scenario price axis.`;

                if (derivedData.combinedAmortizedResult.isSupported === false) {
                    globalAmortizedText.textContent = derivedData.combinedAmortizedResult.reason;
                } else if (derivedData.combinedAmortizedResult.netDeliverables > 0) {
                    const label = derivedData.combinedAmortizedResult.netDeliverables === 1
                        ? derivedData.combinedAmortizedResult.deliverableUnitSingular
                        : derivedData.combinedAmortizedResult.deliverableUnitPlural;
                    globalAmortizedText.textContent = `${derivedData.combinedAmortizedResult.positiveActionLabel} ${derivedData.combinedAmortizedResult.netDeliverables} ${label} with combined effective basis of ${currencyFormatter.format(derivedData.combinedAmortizedResult.basis)}`;
                } else if (derivedData.combinedAmortizedResult.netDeliverables < 0) {
                    const label = Math.abs(derivedData.combinedAmortizedResult.netDeliverables) === 1
                        ? derivedData.combinedAmortizedResult.deliverableUnitSingular
                        : derivedData.combinedAmortizedResult.deliverableUnitPlural;
                    globalAmortizedText.textContent = `${derivedData.combinedAmortizedResult.negativeActionLabel} ${Math.abs(derivedData.combinedAmortizedResult.netDeliverables)} ${label} with combined effective basis of ${currencyFormatter.format(derivedData.combinedAmortizedResult.basis)}`;
                } else {
                    const label = derivedData.combinedAmortizedResult.deliverableUnitPlural || 'deliverables';
                    globalAmortizedText.textContent = `No net assigned or delivered ${label} across the current amortized groups.`;
                }
            } else {
                globalAmortizedCard.style.display = 'none';
                globalAmortizedBanner.style.display = 'none';
                globalAmortizedText.textContent = '';
                globalAmortizedInfoText.textContent = '';
                const globalAmortizedChartContainer = document.getElementById('globalAmortizedChartContainer');
                if (globalAmortizedChartContainer) globalAmortizedChartContainer.style.display = 'none';
                const globalAmortizedToggleBtn = globalAmortizedCard.querySelector('.toggle-global-amortized-chart-btn');
                if (globalAmortizedToggleBtn) globalAmortizedToggleBtn.textContent = 'Show Chart';
            }

            const globalAmortizedChartContainer = document.getElementById('globalAmortizedChartContainer');
            if (globalAmortizedChartContainer && globalAmortizedChartContainer.style.display !== 'none'
                && globalAmortizedCard.style.display !== 'none') {
                chartApi.drawGlobalAmortizedChart(globalAmortizedCard);
            }
        }

        const globalCard = document.getElementById('globalChartCard');
        const gcContainer = document.getElementById('globalChartContainer');
        if (globalCard && gcContainer && gcContainer.style.display !== 'none') {
            chartApi.drawGlobalChart(globalCard);
        }
    }

    globalScope.OptionComboGlobalUI = {
        applyGlobalDerivedData,
        formatProjectedOptionDelivery,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
