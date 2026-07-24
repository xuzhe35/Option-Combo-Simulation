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
            async run() {
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
                    equityOptionPricingControlGroup: createElement({ hidden: false, style: {} }),
                    toggleEquityOptionPricingModelBtn: createElement({ textContent: '' }),
                    equityOptionPricingModelStatus: createElement({ textContent: '' }),
                    equityDividendYield: createElement({ value: '0.00', disabled: true }),
                    equityDividendYieldDisplay: createElement({ textContent: '0.00%' }),
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
                    simTimeBasis: createElement({ value: 'weighted' }),
                    simWeekendWeight: createElement({ value: '0.30' }),
                    simImpliedLambdaReceived: createElement({ textContent: '', style: {} }),
                    simTimeBasisDisplay: createElement({ textContent: 'λ=0.30' }),
                    simImpliedLambdaLabel: createElement({ style: {} }),
                    simUseImpliedLambda: createElement({ checked: false }),
                    simImpliedLambdaStatus: createElement({ textContent: '' }),
                    simImpliedLambdaLoadBtn: createElement(),
                    simImpliedLambdaFileInput: createElement({ value: '' }),
                    toggleGreeksBtn: createElement({ textContent: '' }),
                    greeksStatusText: createElement({ textContent: '' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                    liveComboOrderAccountControls: createElement({ hidden: true, style: {} }),
                    liveComboOrderAccountSelect: createElement({ value: '', disabled: true }),
                    liveComboOrderAccountHint: createElement({ textContent: '' }),
                };

                let updateCalls = 0;
                let throttledCalls = 0;
                let subscriptionCalls = 0;
                let settleAllCalls = 0;
                let managedAccountSnapshotCalls = 0;

                const ctx = loadBrowserScripts([
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/implied_lambda_handoff.js',
                    'js/session_logic.js',
                    'js/control_panel_ui.js',
                ], {
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
                    liveQuoteDate: '',
                    liveQuoteAsOf: '',
                    marketDataMode: 'live',
                    workspaceVariant: '',
                    marketDataModeLocked: false,
                    historicalQuoteDate: '',
                    historicalAvailableStartDate: '',
                    historicalAvailableEndDate: '',
                    interestRate: 0.03,
                    equityOptionPricingModel: 'bsm-spot',
                    equityDividendYield: 0,
                    americanBinomialSteps: 201,
                    ivOffset: 0,
                    simTimeBasis: 'weighted',
                    simWeekendWeight: 0.3,
                    simUseImpliedLambda: false,
                    simImpliedLambdaEntry: null,
                    simImpliedLambdaCoverage: null,
                    greeksEnabled: false,
                    allowLiveComboOrders: false,
                    liveComboOrderAccounts: ['DU111111', 'F222222'],
                    liveComboOrderAccountsConnected: true,
                    selectedLiveComboOrderAccount: '',
                    forwardRateSamples: [],
                    futuresPool: [],
                    groups: [],
                };

                let lastAddDaysBase = '';
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
                    requestManagedAccountsSnapshot() {
                        managedAccountSnapshotCalls += 1;
                    },
                    settleHistoricalReplayGroups() {
                        settleAllCalls += 1;
                    },
                    addDays(baseDate, days) {
                        lastAddDaysBase = baseDate;
                        return `2026-03-${String(16 + days).padStart(2, '0')}`;
                    },
                    diffDays() {
                        return 0;
                    },
                    calendarToTradingDays() {
                        return 0;
                    },
                });

                assert.equal(elements.toggleGreeksBtn.textContent, 'Enable Greeks');
                assert.match(elements.greeksStatusText.textContent, /off by default/i);
                assert.equal(elements.toggleEquityOptionPricingModelBtn.textContent, 'Use American Binomial');
                assert.equal(elements.equityDividendYield.disabled, true);

                const updateCallsBeforePricingToggle = updateCalls;
                elements.toggleEquityOptionPricingModelBtn.listeners.click();
                assert.equal(state.equityOptionPricingModel, 'american-binomial');
                assert.equal(elements.toggleEquityOptionPricingModelBtn.textContent, 'Use European BSM');
                assert.equal(elements.equityDividendYield.disabled, false);
                assert.equal(updateCalls, updateCallsBeforePricingToggle + 1);

                elements.equityDividendYield.listeners.input({ target: { value: '1.25' } });
                assert.equal(state.equityDividendYield, 0.0125);
                assert.equal(elements.equityDividendYieldDisplay.textContent, '1.25%');

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
                assert.equal(state.futuresPool.length, 1);
                assert.equal(state.futuresPool[0].contractMonth, '202603');
                assert.equal(elements.interestRate.disabled, false);
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
                state.historicalTradingDates = [
                    '2025-04-07', '2025-04-08', '2025-04-09', '2025-04-10',
                ];
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
                state.baseDate = '2026-03-01';
                state.liveQuoteDate = '2026-03-16';
                state.simulatedDate = '2026-03-16';
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.equal(elements.simulatedDate.min, '2026-03-16');
                state.liveQuoteAsOf = '2026-03-16T19:00:00.000Z';
                state.simulationTiming = {
                    available: true,
                    status: 'ok',
                    targetAsOf: '2026-03-20T19:30:00.000Z',
                    source: 'near-leg-contract-cutoff',
                };
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.equal(elements.simulatedDateHint.hidden, false);
                assert.match(elements.simulatedDateHint.textContent, /IB near-leg cutoff/i);
                assert.match(elements.simulatedDateHint.textContent, /96\.5 calendar hours/i);

                state.simulationTiming = {
                    available: true,
                    status: 'ok',
                    targetAsOf: '2026-03-20T20:00:00.000Z',
                    source: 'near-leg-profile-cutoff',
                };
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.simulatedDateHint.textContent, /product fallback is in use/i);
                assert.equal(elements.simulatedDateHint.style.color, '#b45309');

                // No open leg expires on the target date, so the product close
                // *is* the instant, not a stand-in for a contract cutoff that
                // will never arrive.  Warning here trains the user to ignore the
                // near-leg case above, which is genuinely actionable.
                state.simulationTiming = {
                    available: true,
                    status: 'ok',
                    targetAsOf: '2026-03-20T20:00:00.000Z',
                    source: 'product-profile-cutoff',
                };
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.simulatedDateHint.textContent, /product-profile cutoff/i);
                assert.doesNotMatch(
                    elements.simulatedDateHint.textContent,
                    /product fallback is in use/i
                );
                assert.equal(elements.simulatedDateHint.style.color, '#4b5563');
                assert.match(elements.simulatedDateHint.title, /No open leg expires on this date/i);

                state.simulationTiming = {
                    available: false,
                    status: 'exact_contract_timing_missing',
                    missingContractTimingLegIds: ['near-call', 'far-call'],
                };
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.simulatedDateHint.textContent, /projection fails closed/i);
                assert.match(elements.simulatedDateHint.textContent, /near-call, far-call/i);
                assert.match(elements.simulatedDateHint.title, /ContractDetails/i);

                state.simulationTiming = {
                    available: false,
                    status: 'deferred_settlement_fixing_unsupported',
                    targetAsOf: '2026-03-20T21:00:00.000Z',
                    deferredSettlementLegIds: ['spx-am-call'],
                };
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.simulatedDateHint.textContent, /spx-am-call/i);
                assert.match(elements.simulatedDateHint.textContent, /later special fixing/i);
                elements.simulatedDate.listeners.change({ target: { value: '2026-03-10' } });
                assert.equal(state.simulatedDate, '2026-03-16');
                assert.equal(elements.simulatedDate.value, '2026-03-16');

                assert.equal(state.futuresPool.length, 1);
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.futuresPoolStatus.textContent, /1\/1 futures contract configured; 0\/1 quoted/i);

                state.futuresPool[0].mark = 6123.5;
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.futuresPoolStatus.textContent, /1\/1 futures contract configured; 1\/1 quoted/i);
                assert.match(elements.futuresPoolStatus.textContent, /0\/1 current-generation identities verified/i);

                state.futuresPool[0].mark = null;
                state.futuresPool[0].liveQuoteIdentityStatus = 'rejected';
                state.futuresPool[0].liveQuoteIdentityReason = 'futures contract month mismatch';
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.futuresPoolStatus.textContent, /1 rejected \(futures contract month mismatch\)/i);
                assert.match(
                    elements.futuresPoolList.children[0].__quoteDisplay.textContent,
                    /live quote rejected: futures contract month mismatch/i
                );

                ctx.adjustUnderlying(0.01);
                assert.equal(state.underlyingPrice, 101);
                assert.equal(elements.underlyingPriceDisplay.textContent, '$101.00');

                elements.daysPassedSlider.listeners.input({ target: { value: '5' } });
                assert.equal(state.simulatedDate, '2026-03-21');
                assert.equal(lastAddDaysBase, '2026-03-16');
                assert.equal(elements.daysPassedDisplay.textContent, '+0 td / +5 cd');
                assert.equal(throttledCalls, 1);

                elements.interestRate.listeners.input({ target: { value: '4.50' } });
                assert.equal(state.interestRate, 0.045);
                assert.equal(elements.interestRateDisplay.textContent, '4.50%');

                elements.ivOffset.listeners.input({ target: { value: '2.50' } });
                assert.equal(state.ivOffset, 0.025);
                assert.equal(elements.ivOffsetDisplay.textContent, '+2.50%');

                const updateCallsBeforeGreeksToggle = updateCalls;
                const subscriptionCallsBeforeGreeksToggle = subscriptionCalls;
                elements.toggleGreeksBtn.listeners.click();
                assert.equal(state.greeksEnabled, true);
                assert.equal(elements.toggleGreeksBtn.textContent, 'Disable Greeks');
                assert.match(elements.greeksStatusText.textContent, /greeks enabled/i);
                assert.equal(subscriptionCalls, subscriptionCallsBeforeGreeksToggle + 1);
                assert.equal(updateCalls, updateCallsBeforeGreeksToggle + 1);

                elements.allowLiveComboOrders.listeners.change({ target: { checked: true } });
                assert.equal(state.allowLiveComboOrders, true);
                assert.equal(managedAccountSnapshotCalls, 1);
                assert.equal(elements.liveComboOrderAccountControls.hidden, false);
                assert.equal(elements.liveComboOrderAccountSelect.disabled, false);
                assert.equal(elements.liveComboOrderAccountSelect.children.length, 3);
                assert.match(elements.liveComboOrderAccountHint.textContent, /choose which tws account/i);

                elements.liveComboOrderAccountSelect.listeners.change({ target: { value: 'F222222' } });
                assert.equal(state.selectedLiveComboOrderAccount, 'F222222');
                assert.equal(elements.liveComboOrderAccountSelect.value, 'F222222');
                assert.match(elements.liveComboOrderAccountHint.textContent, /F222222/);

                elements.underlyingSymbol.listeners.change({ target: { value: 'spx' } });
                assert.equal(state.underlyingSymbol, 'SPX');
                assert.equal(elements.interestRate.disabled, false);
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

                const quoteNow = Date.now();
                const frozenQuoteNow = quoteNow - 10 * 60_000;
                const currentAnchor = new Date(quoteNow).toISOString().slice(0, 10);
                const anchorUtc = new Date(`${currentAnchor}T00:00:00Z`);
                const daysUntilNextSaturday = ((6 - anchorUtc.getUTCDay() + 7) % 7) || 7;
                const intervalStart = new Date(anchorUtc);
                intervalStart.setUTCDate(intervalStart.getUTCDate() + daysUntilNextSaturday - 1);
                const saturday = new Date(intervalStart);
                saturday.setUTCDate(saturday.getUTCDate() + 1);
                const sunday = new Date(saturday);
                sunday.setUTCDate(sunday.getUTCDate() + 1);
                const intervalEnd = new Date(sunday);
                intervalEnd.setUTCDate(intervalEnd.getUTCDate() + 1);
                const coveredDate1 = saturday.toISOString().slice(0, 10);
                const coveredDate2 = sunday.toISOString().slice(0, 10);
                state.liveQuoteDate = currentAnchor;
                const lambdaFile = {
                    format: ctx.OptionComboImpliedLambdaHandoff.EXPORT_FORMAT,
                    version: 2,
                    exportedAt: frozenQuoteNow,
                    symbol: 'SPX',
                    calendarKey: 'NYSE',
                    anchorDate: currentAnchor,
                    quoteAsOf: new Date(frozenQuoteNow).toISOString(),
                    snapshotId: 'spx-snapshot',
                    varianceSource: 'straddle',
                    quality: {
                        status: 'ok', coherent: true, quoteComplete: true,
                        snapshotId: 'spx-snapshot', underlyingSnapshotId: 'spx-snapshot',
                    },
                    intervals: [{
                        startDate: intervalStart.toISOString().slice(0, 10),
                        endExpiry: intervalEnd.toISOString().slice(0, 10),
                        status: 'ok',
                        rawLambda: 0.11,
                        lambda: 0.11,
                        nonTradingDates: [coveredDate1, coveredDate2],
                        snapshotId: 'spx-snapshot',
                        quoteAsOf: new Date(frozenQuoteNow).toISOString(),
                    }],
                };
                await elements.simImpliedLambdaFileInput.listeners.change({
                    target: {
                        value: 'implied_lambda_SPX.json',
                        files: [{ text: async () => JSON.stringify(lambdaFile) }],
                    },
                });
                assert.equal(state.simUseImpliedLambda, true);
                assert.equal(state.simImpliedLambdaEntry.symbol, 'SPX');
                assert.equal(state.simImpliedLambdaEntry.byDate[coveredDate1], 0.11);
                assert.match(elements.simImpliedLambdaStatus.textContent, /loaded for this tab/i);
                assert.ok(updateCalls >= 3);
                const loadedLambdaEntry = state.simImpliedLambdaEntry;

                // Legacy files fail closed with an actionable explanation;
                // selecting one never restamps it into V2.
                await elements.simImpliedLambdaFileInput.listeners.change({
                    target: {
                        value: 'legacy_lambda.json',
                        files: [{ text: async () => JSON.stringify({ ...lambdaFile, version: 1 }) }],
                    },
                });
                assert.match(elements.simImpliedLambdaStatus.textContent, /only V2 straddle exports/i);

                // Strict coverage status is the UI source of truth. An entry
                // with a missing required date is not shown as active and does
                // not silently advertise the scalar as a fallback.
                state.simImpliedLambdaCoverage = {
                    status: 'incomplete_coverage',
                    usable: false,
                    requiredDates: [coveredDate1, coveredDate2],
                    missingDates: [coveredDate2],
                    affectedLegIds: ['near-leg', 'far-leg'],
                };
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.simImpliedLambdaStatus.textContent, /coverage is incomplete/i);
                assert.match(elements.simImpliedLambdaStatus.textContent, new RegExp(coveredDate2));
                assert.match(elements.simImpliedLambdaStatus.textContent, /near-leg, far-leg/i);
                assert.match(elements.simImpliedLambdaStatus.textContent, /scalar λ=.*diagnostic only/i);
                assert.match(elements.simImpliedLambdaStatus.textContent, /cannot bypass/i);
                assert.doesNotMatch(elements.simImpliedLambdaStatus.textContent, /automatic fallback/i);
                assert.equal(elements.simImpliedLambdaStatus.style.color, '#dc2626');
                assert.equal(elements.simImpliedLambdaStatus.style.fontWeight, '600');
                assert.equal(elements.simTimeBasisDisplay.textContent, 'λ=IVTS unavailable');
                assert.equal(elements.simWeekendWeight.disabled, true);
                assert.equal(elements.simWeekendWeight.style.display, 'none');
                assert.equal(elements.simImpliedLambdaReceived.style.display, 'flex');
                assert.equal(elements.simImpliedLambdaReceived.textContent, '已经从IVTS接受到');

                state.simImpliedLambdaEntry = null;
                state.simImpliedLambdaCoverage = {
                    status: 'missing_entry',
                    usable: false,
                    requiredDates: [coveredDate1],
                    missingDates: [coveredDate1],
                    affectedLegIds: ['far-leg'],
                };
                ctx.OptionComboControlPanelUI.refreshSimTimeBasisUi(state);
                assert.match(elements.simImpliedLambdaStatus.textContent, /no fresh matching V2 curve is loaded/i);
                assert.match(elements.simImpliedLambdaStatus.textContent, new RegExp(coveredDate1));
                assert.equal(elements.simImpliedLambdaStatus.style.color, '#dc2626');

                state.simImpliedLambdaCoverage = {
                    status: 'not_required',
                    usable: true,
                    requiredDates: [],
                    missingDates: [],
                    affectedLegIds: [],
                };
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.simImpliedLambdaStatus.textContent, /no implied λ is required/i);
                assert.match(elements.simImpliedLambdaStatus.textContent, /no open option leg crosses/i);
                assert.equal(elements.simImpliedLambdaStatus.style.color, '#4b5563');
                assert.equal(elements.simTimeBasisDisplay.textContent, 'λ not required');

                state.simImpliedLambdaCoverage = {
                    status: 'exact_contract_timing_missing',
                    usable: false,
                    requiredDates: [],
                    missingDates: [],
                    affectedLegIds: ['es-jul22-call'],
                };
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.simImpliedLambdaStatus.textContent, /exact IB contract timing/i);
                assert.match(elements.simImpliedLambdaStatus.textContent, /independent of weekend\/holiday λ/i);
                assert.match(elements.simImpliedLambdaStatus.textContent, /es-jul22-call/i);
                assert.doesNotMatch(elements.simImpliedLambdaStatus.textContent, /Implied λ unavailable/i);
                assert.doesNotMatch(elements.simImpliedLambdaStatus.textContent, /cross a weekend/i);
                assert.equal(elements.simImpliedLambdaStatus.style.color, '#b45309');
                assert.equal(elements.simTimeBasisDisplay.textContent, 'λ pending contract timing');

                state.simImpliedLambdaEntry = loadedLambdaEntry;
                state.simImpliedLambdaCoverage = {
                    status: 'complete',
                    usable: true,
                    requiredDates: [coveredDate1, coveredDate2],
                    missingDates: [],
                    affectedLegIds: [],
                };
                ctx.OptionComboControlPanelUI.refreshSimTimeBasisUi(state);
                assert.match(elements.simImpliedLambdaStatus.textContent, /coverage complete for 2 required non-trading dates/i);
                assert.equal(elements.simImpliedLambdaStatus.style.color, '#15803d');
                assert.equal(elements.simTimeBasisDisplay.textContent, 'λ=IVTS·2d covered');
                assert.doesNotMatch(elements.simImpliedLambdaStatus.textContent, /outside|unsampled|fallback/i);
                assert.equal(elements.simWeekendWeight.style.display, 'none');
                assert.equal(elements.simImpliedLambdaReceived.style.display, 'flex');
                assert.equal(elements.simImpliedLambdaReceived.textContent, '已经从IVTS接受到');

                state.simUseImpliedLambda = false;
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.simImpliedLambdaStatus.textContent, /scalar λ=0\.30 is explicitly selected/i);
                assert.equal(elements.simWeekendWeight.disabled, false);
                assert.equal(elements.simWeekendWeight.style.display, '');
                assert.equal(elements.simImpliedLambdaReceived.style.display, 'none');
                assert.equal(elements.simTimeBasisDisplay.textContent, 'λ=0.30');
            },
        },
        {
            name: 'does not rebuild live combo account options when refreshes do not change them',
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
                    futuresPoolHeader: createElement({ hidden: true, style: {} }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: true }),
                    liveComboOrderAccountControls: createElement({ hidden: false, style: {} }),
                    liveComboOrderAccountSelect: createElement({ value: '', disabled: false }),
                    liveComboOrderAccountHint: createElement({ textContent: '' }),
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
                    allowLiveComboOrders: true,
                    liveComboOrderAccounts: ['DU111111', 'F222222'],
                    liveComboOrderAccountsConnected: true,
                    selectedLiveComboOrderAccount: 'F222222',
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
                    requestManagedAccountsSnapshot() {},
                    settleHistoricalReplayGroups() {},
                    addDays() { return '2026-03-16'; },
                    diffDays() { return 0; },
                    calendarToTradingDays() { return 0; },
                });

                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                const initialOptions = elements.liveComboOrderAccountSelect.children.slice();

                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();

                assert.equal(elements.liveComboOrderAccountSelect.children.length, initialOptions.length);
                initialOptions.forEach((option, index) => {
                    assert.equal(elements.liveComboOrderAccountSelect.children[index], option);
                });
                assert.equal(elements.liveComboOrderAccountSelect.value, 'F222222');
            },
        },
        {
            name: 'surfaces per-leg discount fallback reasons on the curve status line',
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
                    simulatedDate: createElement({ value: '2026-07-17', min: '2026-07-17' }),
                    daysPassedSlider: createElement({ value: '0' }),
                    daysPassedDisplay: createElement({ textContent: '+0 td / +0 cd' }),
                    interestRate: createElement({ value: '3.00' }),
                    interestRateDisplay: createElement({ textContent: '3.00%' }),
                    interestRateLabelText: createElement({ textContent: 'Discount Rate Fallback r (%)' }),
                    useMarketDiscountCurve: createElement({ checked: true }),
                    loadLatestDiscountCurveBtn: createElement({ textContent: '' }),
                    discountCurveStatus: createElement({ textContent: '' }),
                    forwardRatePanel: createElement({ hidden: true, style: {} }),
                    addForwardRateSampleBtn: createElement(),
                    toggleForwardRatePanelBtn: createElement(),
                    forwardRateStatus: createElement({ textContent: '' }),
                    forwardRateSamplesHeader: createElement({ hidden: false, style: {} }),
                    forwardRateSamplesList: createElement(),
                    futuresPoolPanel: createElement({ hidden: true, style: {} }),
                    addFutureContractBtn: createElement(),
                    futuresPoolStatus: createElement({ textContent: '' }),
                    futuresPoolHeader: createElement({ hidden: true, style: {} }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                    liveComboOrderAccountControls: createElement({ hidden: true, style: {} }),
                    liveComboOrderAccountSelect: createElement({ value: '', disabled: true }),
                    liveComboOrderAccountHint: createElement({ textContent: '' }),
                };

                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/market_curves.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/control_panel_ui.js',
                ], {
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

                const rate = 0.04;
                // Weekend updater run: asOf is Sunday, data is Thursday's.
                const curve = ctx.OptionComboMarketCurves.createDiscountCurveFromSnapshot({
                    schemaVersion: 2,
                    kind: 'hybrid_discount_curve',
                    snapshotId: 'usd-reference:status-test',
                    curveAsOf: '2026-07-19',
                    effectiveDate: '2026-07-16',
                    availableAsOf: '2026-07-19T12:00:00Z',
                    source: 'nyfed:sofr+treasury:test',
                    curveSemantics: { discountingIsApproximate: true },
                    points: [
                        {
                            tenorDays: 1,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate / 365),
                            proxy: true,
                        },
                        {
                            tenorDays: 365,
                            zeroRate: rate,
                            discountFactor: Math.exp(-rate),
                            proxy: true,
                        },
                    ],
                });
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    underlyingPrice: 100,
                    baseDate: '2026-07-17',
                    simulatedDate: '2026-07-17',
                    liveQuoteDate: '2026-07-17',
                    marketDataMode: 'live',
                    workspaceVariant: '',
                    marketDataModeLocked: false,
                    historicalQuoteDate: '',
                    historicalAvailableStartDate: '',
                    historicalAvailableEndDate: '',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    liveComboOrderAccounts: [],
                    liveComboOrderAccountsConnected: false,
                    selectedLiveComboOrderAccount: '',
                    useMarketDiscountCurve: true,
                    discountCurve: curve,
                    discountCurveLastError: '',
                    forwardRateSamples: [],
                    futuresPool: [],
                    groups: [
                        {
                            legs: [
                                { type: 'call', expDate: '2026-09-18', pos: 1 },
                                { type: 'put', expDate: '2026-09-18', pos: -1 },
                            ],
                        },
                    ],
                };

                let manualCurveRequest = null;
                ctx.OptionComboControlPanelUI.bindControlPanelEvents(state, new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                }), {
                    updateDerivedValues() {},
                    throttledUpdate() {},
                    handleLiveSubscriptions() {},
                    requestManagedAccountsSnapshot() {},
                    settleHistoricalReplayGroups() {},
                    addDays() { return '2026-07-17'; },
                    diffDays() { return 0; },
                    calendarToTradingDays() { return 0; },
                    requestDiscountCurveSnapshot(options) {
                        manualCurveRequest = options;
                        return true;
                    },
                });

                elements.loadLatestDiscountCurveBtn.listeners.click();
                assert.equal(manualCurveRequest.manual, true);
                assert.equal(manualCurveRequest.refresh, true);
                assert.equal(state.useMarketDiscountCurve, true);

                // Weekend-stamped asOf with a Friday quote date stays active:
                // no silent fallback, no warning.
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(elements.discountCurveStatus.textContent, /curve 2026-07-19/);
                assert.match(elements.discountCurveStatus.textContent, /Displayed short rate r\(1d\)=4\.00%/);
                assert.doesNotMatch(elements.discountCurveStatus.textContent, /⚠/);
                assert.equal(elements.interestRate.value, '4.00');
                assert.equal(elements.interestRateDisplay.textContent, '4.00%');
                assert.equal(elements.interestRateLabelText.textContent, 'Loaded Curve Short Rate r(1d) (%)');
                assert.equal(elements.interestRate.disabled, true);

                // Once the quote date runs past the staleness bound the legs
                // silently discount at the manual rate: the status line now
                // names the reason instead of still reporting "active".
                state.liveQuoteDate = '2026-08-20';
                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();
                assert.match(
                    elements.discountCurveStatus.textContent,
                    /⚠ 2 of 2 open legs are discounting at the manual 3\.00% fallback/
                );
                assert.match(elements.discountCurveStatus.textContent, /market_curve_stale×2/);
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
            name: 'collapses futures-pool panel while keeping the status visible',
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
                    underlyingPrice: createElement({ value: '71.83' }),
                    underlyingPriceSlider: createElement({ value: '71.83' }),
                    underlyingPriceDisplay: createElement({ textContent: '$71.83' }),
                    simulatedDateLabel: createElement({ textContent: 'Simulated Date' }),
                    simulatedDateStartLabel: createElement({ textContent: 'Today' }),
                    simulatedDateHint: createElement({ textContent: '', hidden: true }),
                    simulatedDateOffsetGroup: createElement({ hidden: false, style: {} }),
                    simulatedDate: createElement({ value: '2026-04-02', min: '2026-04-02' }),
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
                    toggleFuturesPoolPanelBtn: createElement(),
                    futuresPoolStatus: createElement({ textContent: '', style: {} }),
                    futuresPoolHeader: createElement({ hidden: false, style: {} }),
                    futuresPoolList: createElement(),
                    ivOffset: createElement({ value: '0' }),
                    ivOffsetSlider: createElement({ value: '0' }),
                    ivOffsetDisplay: createElement({ textContent: '0.00%' }),
                    allowLiveComboOrders: createElement({ checked: false }),
                    liveComboOrderAccountControls: createElement({ hidden: true, style: {} }),
                    liveComboOrderAccountSelect: createElement({ value: '', disabled: true }),
                    liveComboOrderAccountHint: createElement({ textContent: '' }),
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
                    underlyingPrice: 71.83,
                    baseDate: '2026-04-02',
                    simulatedDate: '2026-04-02',
                    marketDataMode: 'live',
                    workspaceVariant: '',
                    marketDataModeLocked: false,
                    historicalQuoteDate: '',
                    historicalAvailableStartDate: '',
                    historicalAvailableEndDate: '',
                    interestRate: 0.03,
                    ivOffset: 0,
                    allowLiveComboOrders: false,
                    futuresPoolPanelCollapsed: false,
                    forwardRateSamples: [],
                    futuresPool: [{
                        id: 'future_a',
                        contractMonth: '202605',
                        bid: 71.81,
                        ask: 71.83,
                        mark: 71.82,
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
                    addDays() { return '2026-05-02'; },
                    diffDays() { return 30; },
                    calendarToTradingDays() { return 21; },
                });

                ctx.OptionComboControlPanelUI.refreshBoundDynamicControls();

                assert.equal(elements.toggleFuturesPoolPanelBtn.textContent, 'Hide');
                assert.equal(elements.futuresPoolHeader.hidden, false);
                assert.equal(elements.futuresPoolList.hidden, false);
                assert.match(elements.futuresPoolStatus.textContent, /exchange futures quotes are the forward\/curve/i);
                assert.match(elements.futuresPoolStatus.textContent, /usd r only discounts/i);

                elements.toggleFuturesPoolPanelBtn.listeners.click();

                assert.equal(state.futuresPoolPanelCollapsed, true);
                assert.equal(elements.toggleFuturesPoolPanelBtn.textContent, 'Show');
                assert.equal(elements.futuresPoolHeader.hidden, true);
                assert.equal(elements.futuresPoolList.hidden, true);
                assert.equal(elements.futuresPoolStatus.style.marginBottom, '0');
            },
        },
        {
            name: 'does not rebuild futures-pool rows and renders policy, net carry, and roll diagnostics',
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
                    underlyingSymbol: createElement({ value: 'ES' }),
                    underlyingContractMonth: createElement({ value: '202609' }),
                    underlyingContractMonthHint: createElement({ textContent: '' }),
                    underlyingPrice: createElement({ value: '6300.00' }),
                    underlyingPriceSlider: createElement({ value: '6300.00' }),
                    underlyingPriceDisplay: createElement({ textContent: '$6,300.00' }),
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
                    OptionComboWsLiveQuotes: {
                        getForwardCarrySnapshot() {
                            return {
                                family: 'ES',
                                reference: { symbol: 'SPX', price: 6280 },
                                points: [{
                                    futuresPoolEntryId: 'future_1',
                                    contractMonth: '202609',
                                    carryRate: 0.0123,
                                    annualizedRollSlope: 0.0456,
                                }],
                            };
                        },
                    },
                });

                const state = {
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '202609',
                    underlyingPrice: 6300,
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
                        contractMonth: '202609',
                        bid: 6299,
                        ask: 6301,
                        mark: 6300,
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
                assert.match(elements.futuresPoolStatus.textContent, /spx is diagnostics only \(net carry ready\)/i);
                assert.match(originalRow.children[1].textContent, /net carry vs spx 1\.23%/i);
                assert.match(originalRow.children[1].textContent, /roll ann\. 4\.56%/i);

                state.futuresPool[0].bid = 6309;
                state.futuresPool[0].ask = 6311;
                state.futuresPool[0].mark = 6310;
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
