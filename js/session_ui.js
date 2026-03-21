/**
 * Session-level DOM synchronization helpers.
 */

(function attachSessionUI(globalScope) {
    function syncControlPanel(state, currencyFormatter, dateHelpers) {
        const days = dateHelpers.diffDays(state.baseDate, state.simulatedDate);
        const tradingDays = dateHelpers.calendarToTradingDays(state.baseDate, state.simulatedDate);
        const interestRatePercent = state.interestRate * 100;
        const ivOffsetPercent = state.ivOffset * 100;
        const ivOffsetSign = ivOffsetPercent > 0 ? '+' : '';

        document.getElementById('underlyingSymbol').value = state.underlyingSymbol;
        const underlyingContractMonthInput = document.getElementById('underlyingContractMonth');
        const underlyingContractMonthHint = document.getElementById('underlyingContractMonthHint');
        document.getElementById('underlyingPrice').value = state.underlyingPrice;
        document.getElementById('underlyingPriceSlider').value = state.underlyingPrice;
        document.getElementById('underlyingPriceDisplay').textContent = currencyFormatter.format(state.underlyingPrice);

        if (underlyingContractMonthInput) {
            const profile = typeof OptionComboProductRegistry === 'undefined'
                ? null
                : OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol);
            const expectsFutureUnderlying = profile?.underlyingSecType === 'FUT';
            const defaultContractMonth = !expectsFutureUnderlying
                || typeof OptionComboProductRegistry === 'undefined'
                || typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth !== 'function'
                ? ''
                : OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
                    state.underlyingSymbol,
                    state.simulatedDate || state.baseDate
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
        simulatedDateInput.min = state.baseDate;
        simulatedDateInput.value = state.simulatedDate;

        document.getElementById('daysPassedSlider').value = days;
        document.getElementById('daysPassedDisplay').textContent = `+${tradingDays} td / +${days} cd`;

        document.getElementById('interestRate').value = interestRatePercent.toFixed(2);
        document.getElementById('interestRateDisplay').textContent = `${interestRatePercent.toFixed(2)}%`;

        document.getElementById('ivOffset').value = ivOffsetPercent.toFixed(2);
        document.getElementById('ivOffsetSlider').value = ivOffsetPercent;
        document.getElementById('ivOffsetDisplay').textContent = `${ivOffsetSign}${ivOffsetPercent.toFixed(2)}%`;

        const allowLiveComboOrdersInput = document.getElementById('allowLiveComboOrders');
        if (allowLiveComboOrdersInput) {
            allowLiveComboOrdersInput.checked = state.allowLiveComboOrders === true;
        }
    }

    globalScope.OptionComboSessionUI = {
        syncControlPanel,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
