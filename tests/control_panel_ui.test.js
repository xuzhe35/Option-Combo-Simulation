const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function createElement(initial = {}) {
    return {
        value: '',
        textContent: '',
        min: '',
        blurCalls: 0,
        listeners: {},
        addEventListener(type, handler) {
            this.listeners[type] = handler;
        },
        blur() {
            this.blurCalls += 1;
        },
        ...initial,
    };
}

module.exports = {
    name: 'control_panel_ui.js',
    tests: [
        {
            name: 'binds control panel events and updates session state',
            run() {
                const elements = {
                    underlyingSymbol: createElement({ value: 'SPY' }),
                    underlyingContractMonth: createElement({ value: '' }),
                    underlyingContractMonthHint: createElement({ textContent: '' }),
                    underlyingPrice: createElement({ value: '100' }),
                    underlyingPriceSlider: createElement({ value: '100' }),
                    underlyingPriceDisplay: createElement({ textContent: '$100.00' }),
                    simulatedDate: createElement({ value: '2026-03-15', min: '2026-03-15' }),
                    daysPassedSlider: createElement({ value: '0' }),
                    daysPassedDisplay: createElement({ textContent: '+0 td / +0 cd' }),
                    interestRate: createElement({ value: '3.00' }),
                    interestRateDisplay: createElement({ textContent: '3.00%' }),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                };

                let updateCalls = 0;
                let throttledCalls = 0;
                let subscriptionCalls = 0;

                const ctx = loadBrowserScripts(['js/product_registry.js', 'js/control_panel_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id];
                        },
                        querySelector() {
                            return null;
                        },
                    },
                });

                const currencyFormatter = new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                });

                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    underlyingPrice: 100,
                    baseDate: '2026-03-15',
                    simulatedDate: '2026-03-15',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    groups: [],
                };

                ctx.OptionComboControlPanelUI.bindControlPanelEvents(state, currencyFormatter, {
                    updateDerivedValues() {
                        updateCalls += 1;
                    },
                    throttledUpdate() {
                        throttledCalls += 1;
                    },
                    handleLiveSubscriptions() {
                        subscriptionCalls += 1;
                    },
                    addDays(_baseDate, days) {
                        return `2026-03-${String(15 + days).padStart(2, '0')}`;
                    },
                    diffDays() {
                        return 0;
                    },
                    calendarToTradingDays() {
                        return 0;
                    },
                });

                elements.underlyingSymbol.listeners.change({ target: { value: 'qqq' } });
                assert.equal(state.underlyingSymbol, 'QQQ');
                assert.equal(state.underlyingContractMonth, '');
                assert.equal(subscriptionCalls, 1);

                let prevented = false;
                elements.underlyingSymbol.listeners.keydown({
                    key: 'Enter',
                    target: { value: 'slv' },
                    preventDefault() {
                        prevented = true;
                    },
                });
                assert.equal(prevented, true);
                assert.equal(state.underlyingSymbol, 'SLV');
                assert.equal(elements.underlyingSymbol.blurCalls, 1);
                assert.equal(subscriptionCalls, 2);

                elements.underlyingSymbol.listeners.blur({ target: { value: 'slv' } });
                assert.equal(state.underlyingSymbol, 'SLV');
                assert.equal(subscriptionCalls, 3);

                elements.underlyingSymbol.listeners.change({ target: { value: 'es' } });
                assert.equal(state.underlyingSymbol, 'ES');
                assert.equal(state.underlyingContractMonth, '202603');
                assert.equal(elements.underlyingContractMonth.value, '202603');

                elements.underlyingContractMonth.listeners.change({ target: { value: '202606' } });
                assert.equal(state.underlyingContractMonth, '202606');

                ctx.adjustUnderlying(0.01);
                assert.equal(state.underlyingPrice, 101);
                assert.equal(elements.underlyingPriceDisplay.textContent, '$101.00');

                elements.daysPassedSlider.listeners.input({ target: { value: '5' } });
                assert.equal(state.simulatedDate, '2026-03-20');
                assert.equal(elements.daysPassedDisplay.textContent, '+0 td / +5 cd');
                assert.equal(throttledCalls, 1);

                elements.interestRate.listeners.input({ target: { value: '4.50' } });
                assert.equal(state.interestRate, 0.045);
                assert.equal(elements.interestRateDisplay.textContent, '4.50%');

                elements.ivOffset.listeners.input({ target: { value: '2.50' } });
                assert.equal(state.ivOffset, 0.025);
                assert.equal(elements.ivOffsetDisplay.textContent, '+2.50%');

                elements.allowLiveComboOrders.listeners.change({ target: { checked: true } });
                assert.equal(state.allowLiveComboOrders, true);
                assert.ok(updateCalls >= 3);
            },
        },
        {
            name: 'toggles sidebar collapsed class',
            run() {
                let toggleCalls = 0;
                const ctx = loadBrowserScripts(['js/control_panel_ui.js'], {
                    document: {
                        querySelector() {
                            return {
                                classList: {
                                    toggle(className) {
                                        toggleCalls += 1;
                                        assert.equal(className, 'sidebar-collapsed');
                                    },
                                },
                            };
                        },
                    },
                });

                ctx.OptionComboControlPanelUI.toggleSidebar();
                assert.equal(toggleCalls, 1);
            },
        },
    ],
};
