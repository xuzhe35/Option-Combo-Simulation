/**
 * Control panel event binding and sidebar interactions.
 */

(function attachControlPanelUI(globalScope) {
    function bindControlPanelEvents(state, currencyFormatter, deps) {
        const {
            updateDerivedValues,
            throttledUpdate,
            handleLiveSubscriptions,
            renderGroups,
            addDays,
            diffDays,
            calendarToTradingDays,
        } = deps;

        const symInput = document.getElementById('underlyingSymbol');
        const underlyingContractMonthInput = document.getElementById('underlyingContractMonth');
        const underlyingContractMonthHint = document.getElementById('underlyingContractMonthHint');

        function resolveDefaultUnderlyingContractMonth() {
            if (typeof OptionComboProductRegistry === 'undefined'
                || typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth !== 'function') {
                return '';
            }
            return OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
                state.underlyingSymbol,
                state.simulatedDate || state.baseDate
            );
        }

        function syncUnderlyingContractMonthUI(forceReset) {
            if (!underlyingContractMonthInput) return;

            const profile = typeof OptionComboProductRegistry === 'undefined'
                ? null
                : OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol);
            const expectsFutureUnderlying = profile?.underlyingSecType === 'FUT';
            const defaultContractMonth = expectsFutureUnderlying ? resolveDefaultUnderlyingContractMonth() : '';

            if (!expectsFutureUnderlying) {
                state.underlyingContractMonth = '';
                underlyingContractMonthInput.value = '';
                underlyingContractMonthInput.placeholder = 'N/A for STK / IND';
                underlyingContractMonthInput.disabled = true;
                if (underlyingContractMonthHint) {
                    underlyingContractMonthHint.textContent = 'Not used for stocks or cash-settled index options.';
                }
                return;
            }

            if (forceReset || !state.underlyingContractMonth) {
                state.underlyingContractMonth = defaultContractMonth;
            }

            underlyingContractMonthInput.disabled = false;
            underlyingContractMonthInput.placeholder = defaultContractMonth || 'YYYYMM';
            underlyingContractMonthInput.value = state.underlyingContractMonth || '';

            if (underlyingContractMonthHint) {
                underlyingContractMonthHint.textContent = `Used to lock the underlying futures month for live FOP data. Default: ${defaultContractMonth || 'manual entry'}.`;
            }
        }

        syncUnderlyingContractMonthUI(false);

        function syncInterestRateUI() {
            const irInput = document.getElementById('interestRate');
            const irDisplay = document.getElementById('interestRateDisplay');
            if (!irInput) return;

            const profile = typeof OptionComboProductRegistry === 'undefined'
                ? null
                : OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol);
            const usesBlack76 = profile && profile.pricingModel === 'black76';

            irInput.disabled = usesBlack76;
            const controlGroup = typeof irInput.closest === 'function' ? irInput.closest('.control-group') : null;
            if (controlGroup) {
                controlGroup.style.opacity = usesBlack76 ? '0.45' : '';
            }
            if (usesBlack76) {
                irInput.title = 'Interest rate has no effect on Black-76 forward pricing (futures / index options).';
                if (irDisplay) {
                    irDisplay.title = irInput.title;
                }
            } else {
                irInput.title = '';
                if (irDisplay) {
                    irDisplay.title = '';
                }
            }
        }

        syncInterestRateUI();

        function applyUnderlyingSymbol(rawValue, forceResubscribe) {
            const normalizedSymbol = String(rawValue || '').trim().toUpperCase();
            if (!normalizedSymbol) {
                symInput.value = state.underlyingSymbol;
                return;
            }

            const symbolChanged = normalizedSymbol !== state.underlyingSymbol;
            state.underlyingSymbol = normalizedSymbol;
            symInput.value = state.underlyingSymbol;
            syncUnderlyingContractMonthUI(symbolChanged);
            syncInterestRateUI();

            if (typeof renderGroups === 'function') {
                renderGroups();
            } else {
                updateDerivedValues();
            }

            if (symbolChanged || forceResubscribe) {
                handleLiveSubscriptions();
            }
        }

        symInput.addEventListener('change', (e) => {
            applyUnderlyingSymbol(e.target.value, true);
        });
        symInput.addEventListener('blur', (e) => {
            applyUnderlyingSymbol(e.target.value, true);
        });
        symInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            if (typeof e.preventDefault === 'function') {
                e.preventDefault();
            }
            applyUnderlyingSymbol(e.target.value, true);
            if (typeof symInput.blur === 'function') {
                symInput.blur();
            }
        });

        if (underlyingContractMonthInput) {
            underlyingContractMonthInput.addEventListener('change', (e) => {
                const cleaned = String(e.target.value || '').replace(/\D/g, '').slice(0, 6);
                state.underlyingContractMonth = cleaned;
                underlyingContractMonthInput.value = cleaned;
                updateDerivedValues();
                handleLiveSubscriptions();
            });
        }

        const upInput = document.getElementById('underlyingPrice');
        const upSlider = document.getElementById('underlyingPriceSlider');
        const upDisplay = document.getElementById('underlyingPriceDisplay');

        function updateUnderlyingPrice(val) {
            state.underlyingPrice = parseFloat(val);
            upInput.value = state.underlyingPrice;
            upSlider.value = state.underlyingPrice;
            upDisplay.textContent = currencyFormatter.format(state.underlyingPrice);
            updateDerivedValues();
        }

        upInput.addEventListener('input', (e) => updateUnderlyingPrice(e.target.value));
        upSlider.addEventListener('input', (e) => {
            state.underlyingPrice = parseFloat(e.target.value);
            upInput.value = state.underlyingPrice;
            upDisplay.textContent = currencyFormatter.format(state.underlyingPrice);
            throttledUpdate();
        });

        globalScope.adjustUnderlying = (percentChange) => {
            const newValue = state.underlyingPrice * (1 + percentChange);
            updateUnderlyingPrice(newValue);
        };

        const simDateInput = document.getElementById('simulatedDate');
        const dpSlider = document.getElementById('daysPassedSlider');
        const dpDisplay = document.getElementById('daysPassedDisplay');

        simDateInput.value = state.simulatedDate;
        simDateInput.min = state.baseDate;

        function updateSimDate(newDateStr) {
            if (new Date(newDateStr) < new Date(state.baseDate)) {
                newDateStr = state.baseDate;
                simDateInput.value = state.baseDate;
            }

            state.simulatedDate = newDateStr;
            const days = diffDays(state.baseDate, state.simulatedDate);
            const tradDays = calendarToTradingDays(state.baseDate, state.simulatedDate);
            dpSlider.value = days;
            dpDisplay.textContent = `+${tradDays} td / +${days} cd`;
            syncUnderlyingContractMonthUI(false);
            updateDerivedValues();
        }

        simDateInput.addEventListener('change', (e) => updateSimDate(e.target.value));
        dpSlider.addEventListener('input', (e) => {
            const dNum = parseInt(e.target.value, 10);
            state.simulatedDate = addDays(state.baseDate, dNum);
            simDateInput.value = state.simulatedDate;
            const tradDays = calendarToTradingDays(state.baseDate, state.simulatedDate);
            dpDisplay.textContent = `+${tradDays} td / +${dNum} cd`;
            syncUnderlyingContractMonthUI(false);
            throttledUpdate();
        });

        const irInput = document.getElementById('interestRate');
        const irDisplay = document.getElementById('interestRateDisplay');
        irInput.addEventListener('input', (e) => {
            const pct = parseFloat(e.target.value);
            state.interestRate = pct / 100.0;
            irDisplay.textContent = `${pct.toFixed(2)}%`;
            updateDerivedValues();
        });

        const ivInput = document.getElementById('ivOffset');
        const ivSlider = document.getElementById('ivOffsetSlider');
        const ivDisplay = document.getElementById('ivOffsetDisplay');
        const allowLiveComboOrdersInput = document.getElementById('allowLiveComboOrders');

        function updateIv(val) {
            const pct = parseFloat(val);
            state.ivOffset = pct / 100.0;
            ivInput.value = pct;
            ivSlider.value = pct;
            ivDisplay.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
            updateDerivedValues();
        }

        ivInput.addEventListener('input', (e) => updateIv(e.target.value));
        ivSlider.addEventListener('input', (e) => {
            const pct = parseFloat(e.target.value);
            state.ivOffset = pct / 100.0;
            ivInput.value = pct;
            ivDisplay.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
            throttledUpdate();
        });

        if (allowLiveComboOrdersInput) {
            allowLiveComboOrdersInput.checked = state.allowLiveComboOrders === true;
            allowLiveComboOrdersInput.addEventListener('change', (e) => {
                state.allowLiveComboOrders = e.target.checked === true;
            });
        }
    }

    function toggleSidebar() {
        const layoutGrid = document.querySelector('.layout-grid');
        if (layoutGrid) {
            layoutGrid.classList.toggle('sidebar-collapsed');
        }
    }

    globalScope.OptionComboControlPanelUI = {
        bindControlPanelEvents,
        toggleSidebar,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
