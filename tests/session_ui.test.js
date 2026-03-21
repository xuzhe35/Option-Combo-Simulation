const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'session_ui.js',
    tests: [
        {
            name: 'synchronizes control panel values from imported session state',
            run() {
                const elements = {
                    underlyingSymbol: { value: '' },
                    underlyingContractMonth: { value: '', placeholder: '', disabled: false },
                    underlyingContractMonthHint: { textContent: '' },
                    underlyingPrice: { value: '' },
                    underlyingPriceSlider: { value: '' },
                    underlyingPriceDisplay: { textContent: '' },
                    simulatedDate: { value: '', min: '' },
                    daysPassedSlider: { value: '' },
                    daysPassedDisplay: { textContent: '' },
                    interestRate: { value: '' },
                    interestRateDisplay: { textContent: '' },
                    ivOffset: { value: '' },
                    ivOffsetSlider: { value: '' },
                    ivOffsetDisplay: { textContent: '' },
                    allowLiveComboOrders: { checked: false },
                };

                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/session_ui.js',
                ], {
                    document: {
                        getElementById(id) {
                            return elements[id];
                        },
                    },
                });

                const currencyFormatter = new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                });

                ctx.OptionComboSessionUI.syncControlPanel(
                    {
                        underlyingSymbol: 'QQQ',
                        underlyingContractMonth: '',
                        underlyingPrice: 512.34,
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-06',
                        interestRate: 0.0375,
                        ivOffset: 0.0125,
                        allowLiveComboOrders: true,
                    },
                    currencyFormatter,
                    {
                        diffDays() {
                            return 5;
                        },
                        calendarToTradingDays() {
                            return 4;
                        },
                    }
                );

                assert.equal(elements.underlyingSymbol.value, 'QQQ');
                assert.equal(elements.underlyingContractMonth.value, '');
                assert.equal(elements.underlyingContractMonth.disabled, true);
                assert.equal(elements.underlyingPrice.value, 512.34);
                assert.equal(elements.underlyingPriceSlider.value, 512.34);
                assert.equal(elements.underlyingPriceDisplay.textContent, '$512.34');
                assert.equal(elements.simulatedDate.min, '2026-03-01');
                assert.equal(elements.simulatedDate.value, '2026-03-06');
                assert.equal(elements.daysPassedSlider.value, 5);
                assert.equal(elements.daysPassedDisplay.textContent, '+4 td / +5 cd');
                assert.equal(elements.interestRate.value, '3.75');
                assert.equal(elements.interestRateDisplay.textContent, '3.75%');
                assert.equal(elements.ivOffset.value, '1.25');
                assert.equal(elements.ivOffsetSlider.value, 1.25);
                assert.equal(elements.ivOffsetDisplay.textContent, '+1.25%');
                assert.equal(elements.allowLiveComboOrders.checked, true);
            },
        },
    ],
};
