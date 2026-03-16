/**
 * Hedge DOM writers.
 */

(function attachHedgeUi(globalScope) {
    function formatSignedCurrencyValue(currencyFormatter, value, positiveClass, negativeClass) {
        return `<span class="${value >= 0 ? positiveClass : negativeClass}">${value >= 0 ? '+' : ''}${currencyFormatter.format(value)}</span>`;
    }

    function applyHedgeDerivedData(derivedData, currencyFormatter) {
        document.querySelectorAll('.hedge-row').forEach(tr => {
            const hedgeResult = derivedData.hedgeResultsById.get(tr.dataset.id);
            if (!hedgeResult) return;

            const pnlCell = tr.querySelector('.pnl-cell');
            if (pnlCell) {
                pnlCell.innerHTML = formatSignedCurrencyValue(currencyFormatter, hedgeResult.pnl, 'success-text', 'danger-text');
            }
        });
    }

    globalScope.OptionComboHedgeUI = {
        applyHedgeDerivedData,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
