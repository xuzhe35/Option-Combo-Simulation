const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function createElement(initial = {}) {
    return {
        value: '',
        textContent: '',
        hidden: false,
        disabled: false,
        title: '',
        checked: false,
        style: {},
        className: '',
        listeners: {},
        addEventListener(type, handler) {
            this.listeners[type] = handler;
        },
        ...initial,
    };
}

function buildElements() {
    return {
        deltaHedgeEnabled: createElement({ checked: false }),
        deltaHedgeTargetDelta: createElement({ value: '' }),
        deltaHedgeTolerance: createElement({ value: '' }),
        deltaHedgeProactiveBuffer: createElement({ value: '' }),
        deltaHedgeSecType: createElement({ value: 'STK' }),
        deltaHedgeSymbol: createElement({ value: '' }),
        deltaHedgeExchange: createElement({ value: '' }),
        deltaHedgeContractMonthGroup: createElement({ hidden: true, style: {} }),
        deltaHedgeContractMonth: createElement({ value: '' }),
        deltaHedgeMultiplier: createElement({ value: '' }),
        deltaHedgeDeltaPerUnit: createElement({ value: '' }),
        deltaHedgeLimitPrice: createElement({ value: '' }),
        deltaHedgeOrderType: createElement({ value: 'LMT' }),
        deltaHedgeAccountDisplay: createElement({ textContent: '' }),
        deltaHedgeAllowLiveOrders: createElement({ checked: false }),
        deltaHedgeAutoSubmitEnabled: createElement({ checked: false }),
        deltaHedgeAutoCancelStaleOrders: createElement({ checked: true }),
        deltaHedgeMaxOrderQuantity: createElement({ value: '' }),
        deltaHedgeAutoMaxNotional: createElement({ value: '' }),
        deltaHedgeAutoMaxOrdersPerDay: createElement({ value: '' }),
        deltaHedgeCooldownSeconds: createElement({ value: '' }),
        deltaHedgeAutoPreviewMaxAgeSeconds: createElement({ value: '' }),
        deltaHedgeAutoStatus: createElement({ textContent: '' }),
        deltaHedgeRecommendationPreviewBtn: createElement({ disabled: false }),
        deltaHedgeBrokerPreviewBtn: createElement({ disabled: false }),
        deltaHedgeSubmitBtn: createElement({ disabled: false }),
        deltaHedgeCancelBtn: createElement({ disabled: false }),
        deltaHedgeClearBtn: createElement({ disabled: false }),
        deltaHedgeOptionDelta: createElement({ textContent: '' }),
        deltaHedgeExistingHedgeDelta: createElement({ textContent: '' }),
        deltaHedgeNetDelta: createElement({ textContent: '' }),
        deltaHedgeRecommendationStatus: createElement({ textContent: '' }),
        deltaHedgeRecommendationSummary: createElement({ textContent: '' }),
        deltaHedgeProjectedDelta: createElement({ textContent: '' }),
        deltaHedgeBrokerPreviewStatus: createElement({ textContent: '' }),
        deltaHedgeBrokerPreviewDetails: createElement({ textContent: '' }),
    };
}

function loadContext(elements, overrides = {}) {
    return loadBrowserScripts([
        'js/delta_hedge_logic.js',
        'js/delta_hedge_ui.js',
    ], {
        document: {
            getElementById(id) {
                return elements[id] || null;
            },
        },
        ...overrides,
    });
}

module.exports = {
    name: 'delta_hedge_ui.js',
    tests: [
        {
            name: 'renders calculation-only recommendation preview without broker transport',
            run() {
                const elements = buildElements();
                let updateCalls = 0;
                let brokerPayloadCalls = 0;
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                        orderType: 'LMT',
                        limitPrice: 481.25,
                    },
                };
                const derivedData = {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: 80,
                    portfolioHedgeDelta: -25,
                    portfolioNetDelta: 55,
                    portfolioDeltaMissingGroupCount: 0,
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {
                    updateDerivedValues() {
                        updateCalls += 1;
                        return derivedData;
                    },
                    buildHedgeOrderPayload() {
                        brokerPayloadCalls += 1;
                    },
                });
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData);

                assert.equal(elements.deltaHedgeEnabled.checked, true);
                assert.equal(elements.deltaHedgeTargetDelta.value, '0');
                assert.equal(elements.deltaHedgeTolerance.value, '25');
                assert.equal(elements.deltaHedgeProactiveBuffer.value, '0');
                assert.equal(elements.deltaHedgeSecType.value, 'STK');
                assert.equal(elements.deltaHedgeSymbol.value, 'SPY');
                assert.equal(elements.deltaHedgeNetDelta.textContent, '+55.00');
                assert.equal(elements.deltaHedgeOptionDelta.textContent, '+80.00');
                assert.equal(elements.deltaHedgeExistingHedgeDelta.textContent, '-25.00');
                assert.match(elements.deltaHedgeRecommendationStatus.textContent, /SELL 55 SPY/);
                assert.equal(elements.deltaHedgeProjectedDelta.textContent, '0.00');
                assert.equal(brokerPayloadCalls, 0);

                elements.deltaHedgeRecommendationPreviewBtn.listeners.click();
                assert.equal(updateCalls, 1);
                assert.equal(brokerPayloadCalls, 0);
            },
        },
        {
            name: 'broker preview button calls manual preview dependency with actionable recommendation',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const requests = [];
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    selectedLiveComboOrderAccount: 'DU12345',
                    liveComboOrderAccounts: ['DU12345'],
                    liveComboOrderAccountsConnected: true,
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                        orderType: 'LMT',
                        limitPrice: 481.25,
                    },
                };
                const derivedData = {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: 80,
                    portfolioHedgeDelta: -25,
                    portfolioNetDelta: 55,
                    portfolioDeltaMissingGroupCount: 0,
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {
                    updateDerivedValues() {
                        return derivedData;
                    },
                    requestBrokerPreview(recommendation) {
                        requests.push(recommendation);
                        return true;
                    },
                });
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData);

                elements.deltaHedgeBrokerPreviewBtn.listeners.click();

                assert.equal(requests.length, 1);
                assert.equal(requests[0].actionable, true);
                assert.equal(requests[0].side, 'SELL');
                assert.equal(requests[0].quantity, 55);
                assert.equal(elements.deltaHedgeAccountDisplay.textContent, 'DU12345');
            },
        },
        {
            name: 'renders broker preview result without enabling submit',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        status: 'previewed',
                        lastPreview: {
                            orderAction: 'SELL',
                            quantity: 55,
                            symbol: 'SPY',
                            orderType: 'LMT',
                            limitPrice: 481.25,
                            projectedNetDelta: 0,
                            conId: 756733,
                            whatIf: {
                                commission: 1.23,
                                commissionCurrency: 'USD',
                                warningText: 'margin preview ok',
                            },
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyBrokerPreviewState(state);

                assert.match(elements.deltaHedgeBrokerPreviewStatus.textContent, /Broker preview ready/);
                assert.match(elements.deltaHedgeBrokerPreviewDetails.textContent, /SELL 55 SPY/);
                assert.match(elements.deltaHedgeBrokerPreviewDetails.textContent, /481.25/);
                assert.match(elements.deltaHedgeBrokerPreviewDetails.textContent, /Projected 0.00/);
                assert.match(elements.deltaHedgeBrokerPreviewDetails.textContent, /commission 1.23 USD/);
            },
        },
        {
            name: 'shows unavailable status when included group delta is missing',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, {
                    portfolioDeltaAvailable: false,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: null,
                    portfolioHedgeDelta: -25,
                    portfolioNetDelta: null,
                    portfolioDeltaMissingGroupCount: 1,
                });

                assert.equal(elements.deltaHedgeNetDelta.textContent, '--');
                assert.match(elements.deltaHedgeRecommendationStatus.textContent, /Delta unavailable/);
                assert.equal(elements.deltaHedgeProjectedDelta.textContent, '--');
            },
        },
        {
            name: 'shows specific missing symbol status when hedge symbol is empty',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: '',
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: -66.81,
                    portfolioHedgeDelta: 0,
                    portfolioNetDelta: -66.81,
                    portfolioDeltaMissingGroupCount: 0,
                });

                assert.match(elements.deltaHedgeRecommendationStatus.textContent, /Hedge symbol missing/);
                assert.match(elements.deltaHedgeRecommendationSummary.textContent, /Enter the hedge symbol/);
            },
        },
        {
            name: 'defaults empty hedge symbol from workspace underlying symbol',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'spy',
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: '',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: -66.81,
                    portfolioHedgeDelta: 0,
                    portfolioNetDelta: -66.81,
                    portfolioDeltaMissingGroupCount: 0,
                });

                assert.equal(state.deltaHedge.hedgeInstrument.symbol, 'SPY');
                assert.equal(elements.deltaHedgeSymbol.value, 'SPY');
                assert.match(elements.deltaHedgeRecommendationStatus.textContent, /BUY 67 SPY/);
            },
        },
        {
            name: 'updates delta hedge state from panel controls',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                let updateCalls = 0;
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {},
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {
                    updateDerivedValues() {
                        updateCalls += 1;
                    },
                });

                elements.deltaHedgeEnabled.listeners.change({ target: { checked: true } });
                elements.deltaHedgeTargetDelta.listeners.change({ target: { value: '10' } });
                elements.deltaHedgeTolerance.listeners.change({ target: { value: '30' } });
                elements.deltaHedgeProactiveBuffer.listeners.change({ target: { value: '5' } });
                elements.deltaHedgeSecType.listeners.change({ target: { value: 'FUT' } });
                elements.deltaHedgeSymbol.listeners.change({ target: { value: 'es' } });
                elements.deltaHedgeExchange.listeners.change({ target: { value: 'cme' } });
                elements.deltaHedgeContractMonth.listeners.change({ target: { value: '202606' } });
                elements.deltaHedgeMultiplier.listeners.change({ target: { value: '50' } });
                elements.deltaHedgeDeltaPerUnit.listeners.change({ target: { value: '1' } });
                elements.deltaHedgeLimitPrice.listeners.change({ target: { value: '5125.25' } });
                elements.deltaHedgeOrderType.listeners.change({ target: { value: 'MKT' } });
                elements.deltaHedgeAutoSubmitEnabled.listeners.change({ target: { checked: true } });
                elements.deltaHedgeAutoCancelStaleOrders.listeners.change({ target: { checked: false } });
                elements.deltaHedgeMaxOrderQuantity.listeners.change({ target: { value: '12' } });
                elements.deltaHedgeAutoMaxNotional.listeners.change({ target: { value: '25000' } });
                elements.deltaHedgeAutoMaxOrdersPerDay.listeners.change({ target: { value: '4' } });
                elements.deltaHedgeCooldownSeconds.listeners.change({ target: { value: '90' } });
                elements.deltaHedgeAutoPreviewMaxAgeSeconds.listeners.change({ target: { value: '15' } });

                assert.equal(state.deltaHedge.enabled, true);
                assert.equal(state.deltaHedge.targetDelta, 10);
                assert.equal(state.deltaHedge.tolerance, 30);
                assert.equal(state.deltaHedge.proactiveBuffer, 5);
                assert.equal(state.deltaHedge.hedgeInstrument.secType, 'FUT');
                assert.equal(state.deltaHedge.hedgeInstrument.symbol, 'ES');
                assert.equal(state.deltaHedge.hedgeInstrument.exchange, 'CME');
                assert.equal(state.deltaHedge.hedgeInstrument.contractMonth, '202606');
                assert.equal(state.deltaHedge.hedgeInstrument.multiplier, 50);
                assert.equal(state.deltaHedge.hedgeInstrument.deltaPerUnit, 1);
                assert.equal(state.deltaHedge.limitPrice, 5125.25);
                assert.equal(state.deltaHedge.orderType, 'MKT');
                assert.equal(state.deltaHedge.autoSubmitEnabled, true);
                assert.equal(state.deltaHedge.autoCancelStaleOrders, false);
                assert.equal(state.deltaHedge.maxOrderQuantity, 12);
                assert.equal(state.deltaHedge.autoMaxNotional, 25000);
                assert.equal(state.deltaHedge.autoMaxOrdersPerDay, 4);
                assert.equal(state.deltaHedge.cooldownSeconds, 90);
                assert.equal(state.deltaHedge.autoPreviewMaxAgeSeconds, 15);
                assert.equal(elements.deltaHedgeContractMonthGroup.hidden, false);
                assert.equal(updateCalls, 19);
            },
        },
        {
            name: 'auto-fills LMT price from hedge reference quote',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements, {
                    OptionComboWsLiveQuotes: {
                        getStockQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return { bid: 99.99, ask: 100.01, mark: 100 };
                        },
                    },
                    OptionComboProductRegistry: {
                        getComboPriceIncrement() {
                            return 0.01;
                        },
                        formatPriceInputValue(_symbol, value) {
                            return String(Number(value));
                        },
                    },
                });
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'SPY',
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                        orderType: 'LMT',
                        limitPrice: null,
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: -60,
                    portfolioHedgeDelta: 0,
                    portfolioNetDelta: -60,
                    portfolioDeltaMissingGroupCount: 0,
                });

                assert.equal(state.deltaHedge.limitPrice, 99.9);
                assert.equal(state.deltaHedge.limitPriceManualOverride, false);
                assert.equal(state.deltaHedge.limitPriceSource, 'auto_midpoint');
                assert.equal(state.deltaHedge.limitPriceReferencePrice, 100);
                assert.equal(elements.deltaHedgeLimitPrice.value, '99.9');
                assert.match(elements.deltaHedgeLimitPrice.title, /Auto-filled/);
            },
        },
        {
            name: 'preserves manually edited LMT price across quote refresh',
            run() {
                const elements = buildElements();
                let quote = { bid: 99.99, ask: 100.01, mark: 100 };
                const ctx = loadContext(elements, {
                    OptionComboWsLiveQuotes: {
                        getStockQuote() {
                            return null;
                        },
                        getUnderlyingQuote() {
                            return quote;
                        },
                    },
                    OptionComboProductRegistry: {
                        getComboPriceIncrement() {
                            return 0.01;
                        },
                        formatPriceInputValue(_symbol, value) {
                            return String(Number(value));
                        },
                    },
                });
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'SPY',
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                        orderType: 'LMT',
                        limitPrice: null,
                    },
                };
                const derivedData = {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: -60,
                    portfolioHedgeDelta: 0,
                    portfolioNetDelta: -60,
                    portfolioDeltaMissingGroupCount: 0,
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData);
                elements.deltaHedgeLimitPrice.listeners.change({ target: { value: '98.5' } });
                quote = { bid: 109.99, ask: 110.01, mark: 110 };
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData);

                assert.equal(state.deltaHedge.limitPrice, 98.5);
                assert.equal(state.deltaHedge.limitPriceManualOverride, true);
                assert.equal(state.deltaHedge.limitPriceSource, 'manual');
                assert.equal(elements.deltaHedgeLimitPrice.value, '98.5');
                assert.match(elements.deltaHedgeLimitPrice.title, /Manually edited/);
            },
        },
        {
            name: 'active resting hedge order blocks new actionable recommendation',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                        orderType: 'LMT',
                        limitPrice: 99.9,
                        orderState: 'resting_locked',
                        restingOrder: {
                            orderId: 1001,
                            status: 'Submitted',
                            side: 'BUY',
                            quantity: 60,
                            remainingQuantity: 60,
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: -60,
                    portfolioHedgeDelta: 0,
                    portfolioNetDelta: -60,
                    portfolioDeltaMissingGroupCount: 0,
                });

                assert.equal(state.deltaHedge.lastRecommendation.actionable, false);
                assert.equal(state.deltaHedge.lastRecommendation.reason, 'pending_hedge_order');
                assert.equal(state.deltaHedge.orderState, 'resting_locked');
                assert.match(elements.deltaHedgeRecommendationStatus.textContent, /Pending hedge order/);
            },
        },
        {
            name: 'marks active resting hedge order stale when delta returns inside band',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        enabled: true,
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                        orderType: 'LMT',
                        limitPrice: 99.9,
                        orderState: 'resting_locked',
                        restingOrder: {
                            orderId: 1001,
                            status: 'Submitted',
                            side: 'BUY',
                            quantity: 60,
                            remainingQuantity: 60,
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: -10,
                    portfolioHedgeDelta: 0,
                    portfolioNetDelta: -10,
                    portfolioDeltaMissingGroupCount: 0,
                });

                assert.equal(state.deltaHedge.orderState, 'stale_needs_review');
                assert.equal(state.deltaHedge.restingOrder.staleReason, 'delta_inside_tolerance');
                assert.equal(state.deltaHedge.lastRecommendation.actionable, false);
                assert.match(elements.deltaHedgeRecommendationStatus.textContent, /Pending hedge order/);
            },
        },
        {
            name: 'submit button remains disabled until live hedge gate and preview are ready',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    allowLiveHedgeOrders: false,
                    selectedLiveComboOrderAccount: 'DU12345',
                    liveComboOrderAccounts: ['DU12345'],
                    liveComboOrderAccountsConnected: true,
                    deltaHedge: {
                        enabled: true,
                        status: 'previewed',
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                        orderType: 'LMT',
                        limitPrice: 99.9,
                        lastPreview: {
                            symbol: 'SPY',
                            orderAction: 'BUY',
                            quantity: 60,
                            orderType: 'LMT',
                            limitPrice: 99.9,
                        },
                    },
                };
                const derivedData = {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: -60,
                    portfolioHedgeDelta: 0,
                    portfolioNetDelta: -60,
                    portfolioDeltaMissingGroupCount: 0,
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {
                    updateDerivedValues() {
                        return derivedData;
                    },
                });
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData);

                assert.equal(elements.deltaHedgeAllowLiveOrders.checked, false);
                assert.equal(elements.deltaHedgeSubmitBtn.disabled, true);

                elements.deltaHedgeAllowLiveOrders.listeners.change({ target: { checked: true } });

                assert.equal(state.allowLiveHedgeOrders, true);
                assert.equal(elements.deltaHedgeAllowLiveOrders.checked, true);
                assert.equal(elements.deltaHedgeSubmitBtn.disabled, false);
            },
        },
        {
            name: 'submit button calls manual submit dependency with current recommendation',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const requests = [];
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    selectedLiveComboOrderAccount: 'DU12345',
                    liveComboOrderAccounts: ['DU12345'],
                    liveComboOrderAccountsConnected: true,
                    deltaHedge: {
                        enabled: true,
                        status: 'previewed',
                        targetDelta: 0,
                        tolerance: 25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                        orderType: 'LMT',
                        limitPrice: 99.9,
                        lastPreview: {
                            symbol: 'SPY',
                            orderAction: 'BUY',
                            quantity: 60,
                            orderType: 'LMT',
                            limitPrice: 99.9,
                        },
                    },
                };
                const derivedData = {
                    portfolioDeltaAvailable: true,
                    portfolioDeltaDisplayable: true,
                    portfolioOptionDelta: -60,
                    portfolioHedgeDelta: 0,
                    portfolioNetDelta: -60,
                    portfolioDeltaMissingGroupCount: 0,
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {
                    updateDerivedValues() {
                        return derivedData;
                    },
                    requestSubmit(recommendation) {
                        requests.push(recommendation);
                        return true;
                    },
                });
                ctx.OptionComboDeltaHedgeUI.applyRecommendationPreview(state, derivedData);
                elements.deltaHedgeSubmitBtn.listeners.click();

                assert.equal(requests.length, 1);
                assert.equal(requests[0].actionable, true);
                assert.equal(requests[0].side, 'BUY');
                assert.equal(requests[0].quantity, 60);
            },
        },
        {
            name: 'cancel button calls manual cancel dependency for active resting order',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                let cancelCalls = 0;
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        status: 'submitted',
                        orderState: 'resting_locked',
                        restingOrder: {
                            orderId: 3101,
                            permId: 90001,
                            status: 'Submitted',
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {
                    requestCancel() {
                        cancelCalls += 1;
                        return true;
                    },
                });
                ctx.OptionComboDeltaHedgeUI.applyBrokerPreviewState(state);

                assert.equal(elements.deltaHedgeCancelBtn.disabled, false);
                elements.deltaHedgeCancelBtn.listeners.click();
                assert.equal(cancelCalls, 1);
            },
        },
        {
            name: 'clear button does not re-arm stale active hedge order state',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        status: 'submitted',
                        orderState: 'stale_needs_review',
                        pendingRequest: false,
                        restingOrder: {
                            orderId: 3101,
                            permId: 90001,
                            status: 'Submitted',
                            staleReason: 'delta_inside_tolerance',
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyBrokerPreviewState(state);

                assert.equal(elements.deltaHedgeClearBtn.disabled, true);
                assert.match(elements.deltaHedgeBrokerPreviewStatus.textContent, /needs review/);
                assert.match(elements.deltaHedgeBrokerPreviewStatus.textContent, /delta_inside_tolerance/);
                assert.equal(state.deltaHedge.status, 'submitted');
                assert.equal(state.deltaHedge.orderState, 'stale_needs_review');
                assert.notEqual(state.deltaHedge.restingOrder, null);
            },
        },
        {
            name: 'clear button re-arms terminal hedge order state',
            run() {
                const elements = buildElements();
                const ctx = loadContext(elements);
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    deltaHedge: {
                        status: 'canceled',
                        orderState: 'canceled',
                        pendingRequest: false,
                        restingOrder: {
                            orderId: 3101,
                            permId: 90001,
                            status: 'Cancelled',
                            remainingQuantity: 35,
                        },
                    },
                };

                ctx.OptionComboDeltaHedgeUI.bindDeltaHedgePanel(state, {});
                ctx.OptionComboDeltaHedgeUI.applyBrokerPreviewState(state);

                assert.equal(elements.deltaHedgeClearBtn.disabled, false);
                elements.deltaHedgeClearBtn.listeners.click();
                assert.equal(state.deltaHedge.status, 'idle');
                assert.equal(state.deltaHedge.orderState, 'idle');
                assert.equal(state.deltaHedge.restingOrder, null);
            },
        },
    ],
};
