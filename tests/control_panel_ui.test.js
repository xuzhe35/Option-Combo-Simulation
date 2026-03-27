const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function createElement(initial = {}) {
    return {
        value: '',
        textContent: '',
        min: '',
        hidden: false,
        disabled: false,
        title: '',
        checked: false,
        style: {},
        blurCalls: 0,
        children: [],
        listeners: {},
        addEventListener(type, handler) {
            this.listeners[type] = handler;
        },
        appendChild(child) {
            if (child && typeof child === 'object') {
                child.parentElement = this;
            }
            this.children.push(child);
            return child;
        },
        replaceChildren(...children) {
            children.forEach((child) => {
                if (child && typeof child === 'object') {
                    child.parentElement = this;
                }
            });
            this.children = children;
        },
        closest() {
            return null;
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
                    marketDataMode: createElement({ value: 'live' }),
                    marketDataModeHint: createElement({ textContent: '' }),
                    historicalQuoteDateGroup: createElement({ hidden: true, style: {} }),
                    historicalQuoteDateLabel: createElement({ textContent: '' }),
                    historicalQuoteDate: createElement({ value: '' }),
                    historicalQuoteDateHint: createElement({ textContent: '' }),
                    historicalReplayDateGroup: createElement({ hidden: true, style: {} }),
                    historicalReplayDateLabel: createElement({ textContent: '' }),
                    historicalReplayDate: createElement({ value: '' }),
                    historicalReplayStartLabel: createElement({ textContent: '' }),
                    historicalReplayDaysDisplay: createElement({ textContent: '' }),
                    historicalReplaySlider: createElement({ value: '0', min: '0', max: '0' }),
                    historicalTimelineControls: createElement({ hidden: true, style: {} }),
                    historicalTimelineHint: createElement({ textContent: '' }),
                    historicalNextDayBtn: createElement({ disabled: true }),
                    historicalSettleAllBtn: createElement({ disabled: true }),
                    underlyingSymbol: createElement({ value: 'SPY' }),
                    underlyingContractMonth: createElement({ value: '' }),
                    underlyingContractMonthHint: createElement({ textContent: '' }),
                    underlyingPrice: createElement({ value: '100' }),
                    underlyingPriceSlider: createElement({ value: '100' }),
                    underlyingPriceDisplay: createElement({ textContent: '$100.00' }),
                    simulatedDateLabel: createElement({ textContent: 'Simulated Date' }),
                    simulatedDateStartLabel: createElement({ textContent: 'Today' }),
                    simulatedDateHint: createElement({ textContent: '', hidden: true }),
                    simulatedDateOffsetGroup: createElement({ hidden: false, style: {} }),
                    simulatedDate: createElement({ value: '2026-03-16', min: '2026-03-16' }),
                    daysPassedSlider: createElement({ value: '0' }),
                    daysPassedDisplay: createElement({ textContent: '+0 td / +0 cd' }),
                    interestRate: createElement({ value: '3.00' }),
                    interestRateDisplay: createElement({ textContent: '3.00%' }),
                    forwardRatePanel: createElement({ hidden: true, style: {} }),
                    addForwardRateSampleBtn: createElement(),
                    toggleForwardRatePanelBtn: createElement(),
                    forwardRateStatus: createElement({ textContent: '' }),
                    forwardRateSamplesHeader: createElement({ hidden: false, style: {} }),
                    forwardRateSamplesList: createElement(),
                    futuresPoolPanel: createElement({ hidden: true, style: {} }),
                    addFutureContractBtn: createElement(),
                    futuresPoolStatus: createElement({ textContent: '' }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                };

                let updateCalls = 0;
                let throttledCalls = 0;
                let subscriptionCalls = 0;
                let settleAllCalls = 0;

                const ctx = loadBrowserScripts(['js/date_utils.js', 'js/product_registry.js', 'js/control_panel_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id];
                        },
                        querySelector() {
                            return null;
                        },
                        createElement() {
                            return createElement();
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
                    baseDate: '2026-03-16',
                    simulatedDate: '2026-03-16',
                    marketDataMode: 'live',
                    workspaceVariant: '',
                    marketDataModeLocked: false,
                    historicalQuoteDate: '',
                    historicalAvailableStartDate: '',
                    historicalAvailableEndDate: '',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    forwardRateSamples: [],
                    futuresPool: [],
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
                    settleHistoricalReplayGroups() {
                        settleAllCalls += 1;
                    },
                    addDays(_baseDate, days) {
                        return `2026-03-${String(16 + days).padStart(2, '0')}`;
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
                assert.equal(elements.interestRate.disabled, false);
                assert.equal(elements.forwardRatePanel.hidden, true);
                assert.equal(elements.futuresPoolPanel.hidden, true);

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
                assert.equal(elements.interestRate.disabled, true);
                assert.equal(elements.forwardRatePanel.hidden, true);
                assert.equal(elements.futuresPoolPanel.hidden, false);

                elements.underlyingContractMonth.listeners.change({ target: { value: '202606' } });
                assert.equal(state.underlyingContractMonth, '202606');

                elements.marketDataMode.listeners.change({ target: { value: 'historical' } });
                assert.equal(state.marketDataMode, 'historical');
                assert.equal(elements.historicalQuoteDateGroup.hidden, false);
                assert.equal(elements.historicalReplayDateGroup.hidden, false);
                assert.equal(elements.historicalReplayDate.value, '2026-03-16');
                assert.equal(elements.allowLiveComboOrders.disabled, true);
                assert.equal(state.allowLiveComboOrders, false);
                assert.equal(subscriptionCalls, 6);
                assert.equal(elements.simulatedDateLabel.textContent, 'Simulation Date');
                assert.equal(elements.simulatedDateStartLabel.textContent, 'Start');
                assert.equal(elements.simulatedDateHint.hidden, false);
                assert.equal(elements.simulatedDateOffsetGroup.hidden, true);
                assert.match(elements.marketDataModeHint.textContent, /Historical mode replays quotes from SQLite/i);

                elements.historicalQuoteDate.listeners.change({ target: { value: '2025-04-07' } });
                assert.equal(state.baseDate, '2025-04-07');
                assert.equal(state.historicalQuoteDate, '2026-03-16');
                assert.equal(state.simulatedDate, '2026-03-16');
                assert.equal(subscriptionCalls, 7);

                elements.historicalReplayDate.listeners.change({ target: { value: '2025-04-08' } });
                assert.equal(state.historicalQuoteDate, '2025-04-08');
                assert.equal(state.simulatedDate, '2026-03-16');
                assert.equal(subscriptionCalls, 8);

                elements.simulatedDate.listeners.change({ target: { value: '2026-03-20' } });
                assert.equal(state.historicalQuoteDate, '2025-04-08');
                assert.equal(state.simulatedDate, '2026-03-20');
                assert.equal(subscriptionCalls, 8);

                state.historicalAvailableStartDate = '2025-04-07';
                state.historicalAvailableEndDate = '2025-04-10';
                state.baseDate = '2025-04-07';
                state.simulatedDate = '2025-04-07';
                state.historicalQuoteDate = '2025-04-07';
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                elements.historicalNextDayBtn.listeners.click();
                assert.equal(state.simulatedDate, '2025-04-08');
                assert.equal(state.historicalQuoteDate, '2025-04-08');
                assert.equal(subscriptionCalls, 9);

                elements.historicalSettleAllBtn.listeners.click();
                assert.equal(settleAllCalls, 1);

                state.marketDataMode = 'live';
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();

                elements.addFutureContractBtn.listeners.click();
                assert.equal(state.futuresPool.length, 1);
                assert.match(elements.futuresPoolStatus.textContent, /enter yyyymm contract months/i);

                state.futuresPool[0].contractMonth = '202603';
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.futuresPoolStatus.textContent, /1\/1 futures contract configured; 0\/1 quoted/i);

                state.futuresPool[0].mark = 6123.5;
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.futuresPoolStatus.textContent, /1\/1 futures contract configured; 1\/1 quoted/i);

                ctx.adjustUnderlying(0.01);
                assert.equal(state.underlyingPrice, 101);
                assert.equal(elements.underlyingPriceDisplay.textContent, '$101.00');

                elements.daysPassedSlider.listeners.input({ target: { value: '5' } });
                assert.equal(state.simulatedDate, '2026-03-21');
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

                elements.underlyingSymbol.listeners.change({ target: { value: 'spx' } });
                assert.equal(state.underlyingSymbol, 'SPX');
                assert.equal(elements.interestRate.disabled, true);
                assert.equal(elements.forwardRatePanel.hidden, false);
                assert.equal(elements.futuresPoolPanel.hidden, true);
                assert.match(elements.forwardRateStatus.textContent, /add one or more reference samples/i);

                elements.addForwardRateSampleBtn.listeners.click();
                assert.equal(state.forwardRateSamples.length, 1);
                assert.equal(state.forwardRateSamples[0].daysToExpiry, 30);
                assert.match(elements.forwardRateStatus.textContent, /waiting for live call\/put quotes/i);
                assert.equal(subscriptionCalls, 12);

                state.forwardRateSamples[0].dailyCarry = 0.00021;
                state.forwardRateSamples[0].impliedRate = 0.07665;
                state.forwardRateSamples[0].isStale = false;
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.forwardRateStatus.textContent, /ready for 1\/1 sample/i);
                assert.ok(updateCalls >= 3);
            },
        },
        {
            name: 'locks market data mode for dedicated workspace entries',
            run() {
                const elements = {
                    marketDataMode: createElement({ value: 'historical' }),
                    marketDataModeHint: createElement({ textContent: '' }),
                    historicalQuoteDateGroup: createElement({ hidden: false, style: {} }),
                    historicalQuoteDateLabel: createElement({ textContent: '' }),
                    historicalQuoteDate: createElement({ value: '2025-04-07' }),
                    historicalQuoteDateHint: createElement({ textContent: '' }),
                    historicalReplayDateGroup: createElement({ hidden: false, style: {} }),
                    historicalReplayDateLabel: createElement({ textContent: '' }),
                    historicalReplayDate: createElement({ value: '2025-04-07' }),
                    historicalReplayStartLabel: createElement({ textContent: '' }),
                    historicalReplayDaysDisplay: createElement({ textContent: '' }),
                    historicalReplaySlider: createElement({ value: '0', min: '0', max: '0' }),
                    historicalTimelineControls: createElement({ hidden: false, style: {} }),
                    historicalTimelineHint: createElement({ textContent: '' }),
                    historicalNextDayBtn: createElement({ disabled: false }),
                    historicalSettleAllBtn: createElement({ disabled: true }),
                    underlyingSymbol: createElement({ value: 'SPY' }),
                    underlyingContractMonth: createElement({ value: '' }),
                    underlyingContractMonthHint: createElement({ textContent: '' }),
                    underlyingPrice: createElement({ value: '100' }),
                    underlyingPriceSlider: createElement({ value: '100' }),
                    underlyingPriceDisplay: createElement({ textContent: '$100.00' }),
                    simulatedDateLabel: createElement({ textContent: 'Simulation Date' }),
                    simulatedDateStartLabel: createElement({ textContent: 'Start' }),
                    simulatedDateHint: createElement({ textContent: '', hidden: false }),
                    simulatedDateOffsetGroup: createElement({ hidden: true, style: {} }),
                    simulatedDate: createElement({ value: '2025-04-07', min: '2025-04-07' }),
                    daysPassedSlider: createElement({ value: '0' }),
                    daysPassedDisplay: createElement({ textContent: '+0 td / +0 cd' }),
                    interestRate: createElement({ value: '3.00' }),
                    interestRateDisplay: createElement({ textContent: '3.00%' }),
                    forwardRatePanel: createElement({ hidden: true, style: {} }),
                    addForwardRateSampleBtn: createElement(),
                    toggleForwardRatePanelBtn: createElement(),
                    forwardRateStatus: createElement({ textContent: '' }),
                    forwardRateSamplesHeader: createElement({ hidden: false, style: {} }),
                    forwardRateSamplesList: createElement(),
                    futuresPoolPanel: createElement({ hidden: true, style: {} }),
                    addFutureContractBtn: createElement(),
                    futuresPoolStatus: createElement({ textContent: '' }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                };

                let subscriptionCalls = 0;

                const ctx = loadBrowserScripts(['js/date_utils.js', 'js/product_registry.js', 'js/control_panel_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id];
                        },
                        querySelector() {
                            return null;
                        },
                        createElement() {
                            return createElement();
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
                    baseDate: '2025-04-07',
                    simulatedDate: '2025-04-07',
                    marketDataMode: 'historical',
                    workspaceVariant: 'historical',
                    marketDataModeLocked: true,
                    historicalQuoteDate: '2025-04-07',
                    historicalAvailableStartDate: '2025-04-07',
                    historicalAvailableEndDate: '2025-04-10',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    forwardRateSamples: [],
                    futuresPool: [],
                    groups: [],
                };

                ctx.OptionComboControlPanelUI.bindControlPanelEvents(state, currencyFormatter, {
                    updateDerivedValues() {},
                    throttledUpdate() {},
                    handleLiveSubscriptions() {
                        subscriptionCalls += 1;
                    },
                    settleHistoricalReplayGroups() {},
                    addDays(_baseDate, days) {
                        return `2025-04-${String(7 + days).padStart(2, '0')}`;
                    },
                    diffDays() {
                        return 0;
                    },
                    calendarToTradingDays() {
                        return 0;
                    },
                });

                assert.equal(elements.marketDataMode.disabled, true);
                assert.match(elements.marketDataModeHint.textContent, /locked to SQLite replay only/i);

                elements.marketDataMode.listeners.change({ target: { value: 'live' } });
                assert.equal(state.marketDataMode, 'historical');
                assert.equal(elements.marketDataMode.value, 'historical');
                assert.equal(subscriptionCalls, 0);
            },
        },
        {
            name: 'does not rebuild forward-rate rows while a sample input is focused',
            run() {
                const elements = {
                    marketDataMode: createElement({ value: 'live' }),
                    marketDataModeHint: createElement({ textContent: '' }),
                    historicalQuoteDateGroup: createElement({ hidden: true, style: {} }),
                    historicalQuoteDateLabel: createElement({ textContent: '' }),
                    historicalQuoteDate: createElement({ value: '' }),
                    historicalQuoteDateHint: createElement({ textContent: '' }),
                    historicalReplayDateGroup: createElement({ hidden: true, style: {} }),
                    historicalReplayDateLabel: createElement({ textContent: '' }),
                    historicalReplayDate: createElement({ value: '' }),
                    historicalReplayStartLabel: createElement({ textContent: '' }),
                    historicalReplayDaysDisplay: createElement({ textContent: '' }),
                    historicalReplaySlider: createElement({ value: '0', min: '0', max: '0' }),
                    historicalTimelineControls: createElement({ hidden: true, style: {} }),
                    historicalTimelineHint: createElement({ textContent: '' }),
                    historicalNextDayBtn: createElement({ disabled: true }),
                    historicalSettleAllBtn: createElement({ disabled: true }),
                    underlyingSymbol: createElement({ value: 'SPX' }),
                    underlyingContractMonth: createElement({ value: '' }),
                    underlyingContractMonthHint: createElement({ textContent: '' }),
                    underlyingPrice: createElement({ value: '6581' }),
                    underlyingPriceSlider: createElement({ value: '6581' }),
                    underlyingPriceDisplay: createElement({ textContent: '$6,581.00' }),
                    simulatedDateLabel: createElement({ textContent: 'Simulated Date' }),
                    simulatedDateStartLabel: createElement({ textContent: 'Today' }),
                    simulatedDateHint: createElement({ textContent: '', hidden: true }),
                    simulatedDateOffsetGroup: createElement({ hidden: false, style: {} }),
                    simulatedDate: createElement({ value: '2026-03-23', min: '2026-03-23' }),
                    daysPassedSlider: createElement({ value: '0' }),
                    daysPassedDisplay: createElement({ textContent: '+0 td / +0 cd' }),
                    interestRate: createElement({ value: '3.00' }),
                    interestRateDisplay: createElement({ textContent: '3.00%' }),
                    forwardRatePanel: createElement({ hidden: false, style: {} }),
                    addForwardRateSampleBtn: createElement(),
                    toggleForwardRatePanelBtn: createElement(),
                    forwardRateStatus: createElement({ textContent: '' }),
                    forwardRateSamplesHeader: createElement({ hidden: false, style: {} }),
                    forwardRateSamplesList: createElement(),
                    futuresPoolPanel: createElement({ hidden: true, style: {} }),
                    addFutureContractBtn: createElement(),
                    futuresPoolStatus: createElement({ textContent: '' }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                };

                elements.forwardRatePanel.appendChild(elements.forwardRateSamplesList);

                let activeElement = null;

                const ctx = loadBrowserScripts(['js/date_utils.js', 'js/product_registry.js', 'js/control_panel_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id];
                        },
                        querySelector() {
                            return null;
                        },
                        createElement() {
                            return createElement();
                        },
                        get activeElement() {
                            return activeElement;
                        },
                    },
                });

                const state = {
                    underlyingSymbol: 'SPX',
                    underlyingContractMonth: '',
                    underlyingPrice: 6581,
                    baseDate: '2026-03-23',
                    simulatedDate: '2026-03-23',
                    marketDataMode: 'live',
                    workspaceVariant: '',
                    marketDataModeLocked: false,
                    historicalQuoteDate: '',
                    historicalAvailableStartDate: '',
                    historicalAvailableEndDate: '',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    forwardRateSamples: [{
                        id: 'sample_1',
                        daysToExpiry: 30,
                        expDate: '2026-04-22',
                        strike: 6581,
                        dailyCarry: null,
                        impliedRate: null,
                        lastComputedAt: null,
                        isStale: false,
                    }],
                    futuresPool: [],
                    groups: [],
                };

                ctx.OptionComboControlPanelUI.bindControlPanelEvents(state, new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                }), {
                    updateDerivedValues() {},
                    throttledUpdate() {},
                    handleLiveSubscriptions() {},
                    settleHistoricalReplayGroups() {},
                    renderGroups() {},
                    addDays() { return '2026-04-22'; },
                    diffDays() { return 30; },
                    calendarToTradingDays() { return 21; },
                });

                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                const originalRow = elements.forwardRateSamplesList.children[0];
                assert.ok(originalRow);

                activeElement = originalRow.children[1];
                activeElement.tagName = 'INPUT';
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();

                assert.equal(elements.forwardRateSamplesList.children[0], originalRow);
            },
        },
        {
            name: 'does not overwrite underlying contract month while its input is focused',
            run() {
                const elements = {
                    marketDataMode: createElement({ value: 'live' }),
                    marketDataModeHint: createElement({ textContent: '' }),
                    historicalQuoteDateGroup: createElement({ hidden: true, style: {} }),
                    historicalQuoteDateLabel: createElement({ textContent: '' }),
                    historicalQuoteDate: createElement({ value: '' }),
                    historicalQuoteDateHint: createElement({ textContent: '' }),
                    historicalReplayDateGroup: createElement({ hidden: true, style: {} }),
                    historicalReplayDateLabel: createElement({ textContent: '' }),
                    historicalReplayDate: createElement({ value: '' }),
                    historicalReplayStartLabel: createElement({ textContent: '' }),
                    historicalReplayDaysDisplay: createElement({ textContent: '' }),
                    historicalReplaySlider: createElement({ value: '0', min: '0', max: '0' }),
                    historicalTimelineControls: createElement({ hidden: true, style: {} }),
                    historicalTimelineHint: createElement({ textContent: '' }),
                    historicalNextDayBtn: createElement({ disabled: true }),
                    historicalSettleAllBtn: createElement({ disabled: true }),
                    underlyingSymbol: createElement({ value: 'CL' }),
                    underlyingContractMonth: createElement({ value: '' }),
                    underlyingContractMonthHint: createElement({ textContent: '' }),
                    underlyingPrice: createElement({ value: '65.00' }),
                    underlyingPriceSlider: createElement({ value: '65.00' }),
                    underlyingPriceDisplay: createElement({ textContent: '$65.00' }),
                    simulatedDateLabel: createElement({ textContent: 'Simulated Date' }),
                    simulatedDateStartLabel: createElement({ textContent: 'Today' }),
                    simulatedDateHint: createElement({ textContent: '', hidden: true }),
                    simulatedDateOffsetGroup: createElement({ hidden: false, style: {} }),
                    simulatedDate: createElement({ value: '2026-03-23', min: '2026-03-23' }),
                    daysPassedSlider: createElement({ value: '0' }),
                    daysPassedDisplay: createElement({ textContent: '+0 td / +0 cd' }),
                    interestRate: createElement({ value: '3.00' }),
                    interestRateDisplay: createElement({ textContent: '3.00%' }),
                    forwardRatePanel: createElement({ hidden: true, style: {} }),
                    addForwardRateSampleBtn: createElement(),
                    toggleForwardRatePanelBtn: createElement(),
                    forwardRateStatus: createElement({ textContent: '' }),
                    forwardRateSamplesHeader: createElement({ hidden: false, style: {} }),
                    forwardRateSamplesList: createElement(),
                    futuresPoolPanel: createElement({ hidden: false, style: {} }),
                    addFutureContractBtn: createElement(),
                    futuresPoolStatus: createElement({ textContent: '' }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                };

                let activeElement = null;

                const ctx = loadBrowserScripts(['js/date_utils.js', 'js/product_registry.js', 'js/control_panel_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id];
                        },
                        querySelector() {
                            return null;
                        },
                        createElement() {
                            return createElement();
                        },
                        get activeElement() {
                            return activeElement;
                        },
                    },
                });

                const state = {
                    underlyingSymbol: 'CL',
                    underlyingContractMonth: '',
                    underlyingPrice: 65,
                    baseDate: '2026-03-23',
                    simulatedDate: '2026-03-23',
                    marketDataMode: 'live',
                    workspaceVariant: '',
                    marketDataModeLocked: false,
                    historicalQuoteDate: '',
                    historicalAvailableStartDate: '',
                    historicalAvailableEndDate: '',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    forwardRateSamples: [],
                    futuresPool: [],
                    groups: [],
                };

                ctx.OptionComboControlPanelUI.bindControlPanelEvents(state, new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                }), {
                    updateDerivedValues() {},
                    throttledUpdate() {},
                    handleLiveSubscriptions() {},
                    settleHistoricalReplayGroups() {},
                    renderGroups() {},
                    addDays() { return '2026-04-22'; },
                    diffDays() { return 30; },
                    calendarToTradingDays() { return 21; },
                });

                assert.equal(elements.underlyingContractMonth.value, '202605');

                activeElement = elements.underlyingContractMonth;
                activeElement.tagName = 'INPUT';
                elements.underlyingContractMonth.listeners.input({ target: { value: '202606' } });
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();

                assert.equal(state.underlyingContractMonth, '202606');
                assert.equal(elements.underlyingContractMonth.value, '202606');
            },
        },
        {
            name: 'formats forward-carry timestamps compactly and supports collapsing the sample list',
            run() {
                const elements = {
                    marketDataMode: createElement({ value: 'live' }),
                    marketDataModeHint: createElement({ textContent: '' }),
                    historicalQuoteDateGroup: createElement({ hidden: true, style: {} }),
                    historicalQuoteDateLabel: createElement({ textContent: '' }),
                    historicalQuoteDate: createElement({ value: '' }),
                    historicalQuoteDateHint: createElement({ textContent: '' }),
                    historicalReplayDateGroup: createElement({ hidden: true, style: {} }),
                    historicalReplayDateLabel: createElement({ textContent: '' }),
                    historicalReplayDate: createElement({ value: '' }),
                    historicalReplayStartLabel: createElement({ textContent: '' }),
                    historicalReplayDaysDisplay: createElement({ textContent: '' }),
                    historicalReplaySlider: createElement({ value: '0', min: '0', max: '0' }),
                    historicalTimelineControls: createElement({ hidden: true, style: {} }),
                    historicalTimelineHint: createElement({ textContent: '' }),
                    historicalNextDayBtn: createElement({ disabled: true }),
                    historicalSettleAllBtn: createElement({ disabled: true }),
                    underlyingSymbol: createElement({ value: 'SPX' }),
                    underlyingContractMonth: createElement({ value: '' }),
                    underlyingContractMonthHint: createElement({ textContent: '' }),
                    underlyingPrice: createElement({ value: '6581.00' }),
                    underlyingPriceSlider: createElement({ value: '6581.00' }),
                    underlyingPriceDisplay: createElement({ textContent: '$6,581.00' }),
                    simulatedDateLabel: createElement({ textContent: 'Simulated Date' }),
                    simulatedDateStartLabel: createElement({ textContent: 'Today' }),
                    simulatedDateHint: createElement({ textContent: '', hidden: true }),
                    simulatedDateOffsetGroup: createElement({ hidden: false, style: {} }),
                    simulatedDate: createElement({ value: '2026-03-26', min: '2026-03-26' }),
                    daysPassedSlider: createElement({ value: '0' }),
                    daysPassedDisplay: createElement({ textContent: '+0 td / +0 cd' }),
                    interestRate: createElement({ value: '3.00' }),
                    interestRateDisplay: createElement({ textContent: '3.00%' }),
                    forwardRatePanel: createElement({ hidden: false, style: {} }),
                    addForwardRateSampleBtn: createElement(),
                    toggleForwardRatePanelBtn: createElement(),
                    forwardRateStatus: createElement({ textContent: '' }),
                    forwardRateSamplesHeader: createElement({ hidden: false, style: {} }),
                    forwardRateSamplesList: createElement({ hidden: false, style: {} }),
                    futuresPoolPanel: createElement({ hidden: true, style: {} }),
                    addFutureContractBtn: createElement(),
                    futuresPoolStatus: createElement({ textContent: '' }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                };

                const ctx = loadBrowserScripts(['js/date_utils.js', 'js/product_registry.js', 'js/control_panel_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id];
                        },
                        querySelector() {
                            return null;
                        },
                        createElement() {
                            return createElement();
                        },
                        activeElement: null,
                    },
                });

                const state = {
                    underlyingSymbol: 'SPX',
                    underlyingContractMonth: '',
                    underlyingPrice: 6581,
                    baseDate: '2026-03-26',
                    simulatedDate: '2026-03-26',
                    marketDataMode: 'live',
                    workspaceVariant: '',
                    marketDataModeLocked: false,
                    historicalQuoteDate: '',
                    historicalAvailableStartDate: '',
                    historicalAvailableEndDate: '',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    forwardRatePanelCollapsed: false,
                    forwardRateSamples: [{
                        id: 'sample_compact',
                        daysToExpiry: 32,
                        expDate: '2026-04-27',
                        strike: 6580,
                        dailyCarry: 0.000092,
                        impliedRate: 0.0336,
                        lastComputedAt: '2026-03-26T15:59:52.023Z',
                        isStale: false,
                    }],
                    futuresPool: [],
                    groups: [],
                };

                ctx.OptionComboControlPanelUI.bindControlPanelEvents(state, new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                }), {
                    updateDerivedValues() {},
                    throttledUpdate() {},
                    handleLiveSubscriptions() {},
                    settleHistoricalReplayGroups() {},
                    renderGroups() {},
                    addDays() { return '2026-04-27'; },
                    diffDays() { return 32; },
                    calendarToTradingDays() { return 23; },
                });

                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();

                const sampleRow = elements.forwardRateSamplesList.children[0];
                const meta = sampleRow.children[3];
                assert.match(meta.textContent, /@ 03-26 15:59/);
                assert.doesNotMatch(meta.textContent, /T15:59:52|\.023Z/);
                assert.equal(elements.toggleForwardRatePanelBtn.textContent, 'Hide');
                assert.equal(elements.forwardRateSamplesHeader.hidden, false);
                assert.equal(elements.forwardRateSamplesList.hidden, false);

                elements.toggleForwardRatePanelBtn.listeners.click();

                assert.equal(state.forwardRatePanelCollapsed, true);
                assert.equal(elements.toggleForwardRatePanelBtn.textContent, 'Show');
                assert.equal(elements.forwardRateSamplesHeader.hidden, true);
                assert.equal(elements.forwardRateSamplesList.hidden, true);
                assert.equal(elements.forwardRateStatus.style.marginBottom, '0');
            },
        },
        {
            name: 'does not rebuild futures-pool rows when only quotes change',
            run() {
                const elements = {
                    marketDataMode: createElement({ value: 'live' }),
                    marketDataModeHint: createElement({ textContent: '' }),
                    historicalQuoteDateGroup: createElement({ hidden: true, style: {} }),
                    historicalQuoteDateLabel: createElement({ textContent: '' }),
                    historicalQuoteDate: createElement({ value: '' }),
                    historicalQuoteDateHint: createElement({ textContent: '' }),
                    historicalReplayDateGroup: createElement({ hidden: true, style: {} }),
                    historicalReplayDateLabel: createElement({ textContent: '' }),
                    historicalReplayDate: createElement({ value: '' }),
                    historicalReplayStartLabel: createElement({ textContent: '' }),
                    historicalReplayDaysDisplay: createElement({ textContent: '' }),
                    historicalReplaySlider: createElement({ value: '0', min: '0', max: '0' }),
                    historicalTimelineControls: createElement({ hidden: true, style: {} }),
                    historicalTimelineHint: createElement({ textContent: '' }),
                    historicalNextDayBtn: createElement({ disabled: true }),
                    historicalSettleAllBtn: createElement({ disabled: true }),
                    underlyingSymbol: createElement({ value: 'CL' }),
                    underlyingContractMonth: createElement({ value: '202605' }),
                    underlyingContractMonthHint: createElement({ textContent: '' }),
                    underlyingPrice: createElement({ value: '65.00' }),
                    underlyingPriceSlider: createElement({ value: '65.00' }),
                    underlyingPriceDisplay: createElement({ textContent: '$65.00' }),
                    simulatedDateLabel: createElement({ textContent: 'Simulated Date' }),
                    simulatedDateStartLabel: createElement({ textContent: 'Today' }),
                    simulatedDateHint: createElement({ textContent: '', hidden: true }),
                    simulatedDateOffsetGroup: createElement({ hidden: false, style: {} }),
                    simulatedDate: createElement({ value: '2026-03-23', min: '2026-03-23' }),
                    daysPassedSlider: createElement({ value: '0' }),
                    daysPassedDisplay: createElement({ textContent: '+0 td / +0 cd' }),
                    interestRate: createElement({ value: '3.00' }),
                    interestRateDisplay: createElement({ textContent: '3.00%' }),
                    forwardRatePanel: createElement({ hidden: true, style: {} }),
                    addForwardRateSampleBtn: createElement(),
                    toggleForwardRatePanelBtn: createElement(),
                    forwardRateStatus: createElement({ textContent: '' }),
                    forwardRateSamplesHeader: createElement({ hidden: false, style: {} }),
                    forwardRateSamplesList: createElement(),
                    futuresPoolPanel: createElement({ hidden: false, style: {} }),
                    addFutureContractBtn: createElement(),
                    futuresPoolStatus: createElement({ textContent: '' }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                };

                const ctx = loadBrowserScripts(['js/date_utils.js', 'js/product_registry.js', 'js/control_panel_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id];
                        },
                        querySelector() {
                            return null;
                        },
                        createElement() {
                            return createElement();
                        },
                        activeElement: null,
                    },
                });

                const state = {
                    underlyingSymbol: 'CL',
                    underlyingContractMonth: '202605',
                    underlyingPrice: 65,
                    baseDate: '2026-03-23',
                    simulatedDate: '2026-03-23',
                    marketDataMode: 'live',
                    workspaceVariant: '',
                    marketDataModeLocked: false,
                    historicalQuoteDate: '',
                    historicalAvailableStartDate: '',
                    historicalAvailableEndDate: '',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    forwardRateSamples: [],
                    futuresPool: [{
                        id: 'future_1',
                        contractMonth: '202605',
                        bid: 88.95,
                        ask: 88.97,
                        mark: 88.95,
                    }],
                    groups: [],
                };

                ctx.OptionComboControlPanelUI.bindControlPanelEvents(state, new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                }), {
                    updateDerivedValues() {},
                    throttledUpdate() {},
                    handleLiveSubscriptions() {},
                    settleHistoricalReplayGroups() {},
                    renderGroups() {},
                    addDays() { return '2026-04-22'; },
                    diffDays() { return 30; },
                    calendarToTradingDays() { return 21; },
                });

                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                const originalRow = elements.futuresPoolList.children[0];
                const originalRemoveButton = originalRow.children[2];
                assert.ok(originalRow);
                assert.ok(originalRemoveButton);

                state.futuresPool[0].bid = 89.10;
                state.futuresPool[0].ask = 89.12;
                state.futuresPool[0].mark = 89.11;
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();

                assert.equal(elements.futuresPoolList.children[0], originalRow);
                assert.equal(elements.futuresPoolList.children[0].children[2], originalRemoveButton);
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
