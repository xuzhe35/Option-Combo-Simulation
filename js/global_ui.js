/**
 * Global DOM writers.
 */

(function attachGlobalUi(globalScope) {
    function formatSignedCurrencyValue(currencyFormatter, value, positiveClass, negativeClass) {
        return `<span class="${value >= 0 ? positiveClass : negativeClass}">${value >= 0 ? '+' : ''}${currencyFormatter.format(value)}</span>`;
    }

    function applyGlobalDerivedData(derivedData, currencyFormatter, chartApi) {
        document.getElementById('totalCost').textContent = currencyFormatter.format(derivedData.globalTotalCost);
        document.getElementById('simulatedValue').textContent = currencyFormatter.format(derivedData.globalSimulatedValue);
        document.getElementById('unrealizedPnL').innerHTML = formatSignedCurrencyValue(currencyFormatter, derivedData.globalPnL, 'profit', 'loss');

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
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
