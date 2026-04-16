/**
 * Hedge DOM writers.
 */

(function attachHedgeUi(globalScope) {
    function formatSignedCurrencyValue(currencyFormatter, value, positiveClass, negativeClass) {
        return `<span class="${value >= 0 ? positiveClass : negativeClass}">${value >= 0 ? '+' : ''}${currencyFormatter.format(value)}</span>`;
    }

    function applyHedgeRowDerivedData(row, hedgeResult, currencyFormatter) {
        if (!row || !hedgeResult) {
            return;
        }

        const pnlCell = row.querySelector('.pnl-cell');
        if (pnlCell) {
            pnlCell.innerHTML = formatSignedCurrencyValue(currencyFormatter, hedgeResult.pnl, 'success-text', 'danger-text');
        }
    }

    function applyHedgeDerivedData(derivedData, currencyFormatter) {
        document.querySelectorAll('.hedge-row').forEach(tr => {
            const hedgeResult = derivedData.hedgeResultsById.get(tr.dataset.id);
            if (!hedgeResult) return;

            applyHedgeRowDerivedData(tr, hedgeResult, currencyFormatter);
        });
    }

    globalScope.OptionComboHedgeUI = {
        applyHedgeRowDerivedData,
        applyHedgeDerivedData,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
