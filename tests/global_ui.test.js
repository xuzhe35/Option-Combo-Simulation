const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'global_ui.js',
    tests: [
        {
            name: 'renders the signed net cash flow for groups included in global totals',
            run() {
                const elements = {
                    totalCost: { textContent: '' },
                    simulatedValue: { textContent: '' },
                    unrealizedPnL: { innerHTML: '' },
                    allGroupsNetCashFlowValue: { innerHTML: '' },
                    optionLegRedundancy: { textContent: '', title: '' },
                    projectedOptionDelivery: { innerHTML: '', title: '' },
                };
                const ctx = loadBrowserScripts(['js/global_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id] || null;
                        },
                    },
                });
                const formatter = new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                });

                ctx.OptionComboGlobalUI.applyGlobalDerivedData({
                    globalTotalCost: 0,
                    globalSimulatedValue: 0,
                    globalPnL: 0,
                    globalNetCashFlow: -1191,
                    optionLegRedundancy: {
                        call: { buyContracts: 0, sellContracts: 20, netContracts: -20 },
                        put: { buyContracts: 0, sellContracts: 0, netContracts: 0 },
                    },
                    projectedOptionDelivery: {
                        available: true,
                        status: 'ok',
                        simulationDate: '2026-07-24',
                        underlyingSymbol: 'SPY',
                        callContracts: -20,
                        putContracts: 0,
                        netDeliverables: -2000,
                        referencePrice: 749.15,
                        deliverableUnitPlural: 'shares',
                    },
                    hasAnyLiveData: false,
                    hasAnyHedgeLivePnL: false,
                    combinedAmortizedResult: null,
                }, formatter, {});

                assert.match(elements.allGroupsNetCashFlowValue.innerHTML, /danger-text/);
                assert.match(elements.allGroupsNetCashFlowValue.innerHTML, /-\$1,191\.00/);
                assert.equal(elements.optionLegRedundancy.textContent, 'C -20 / P 0');
                assert.match(elements.projectedOptionDelivery.innerHTML, /-20 CALL/);
                assert.match(elements.projectedOptionDelivery.innerHTML, /-2,000 SPY/);
                assert.match(elements.projectedOptionDelivery.title, /2026-07-24/);
            },
        },
        {
            name: 'updates global numbers without redrawing visible charts when suppressed',
            run() {
                const globalChartContainer = { style: { display: 'block' } };
                const globalChartCard = { style: { display: 'block' } };
                const elements = {
                    totalCost: { textContent: '' },
                    simulatedValue: { textContent: '' },
                    unrealizedPnL: { innerHTML: '' },
                    allGroupsNetCashFlowValue: { innerHTML: '' },
                    optionLegRedundancy: { textContent: '', title: '' },
                    projectedOptionDelivery: { innerHTML: '', title: '' },
                    globalChartContainer,
                    globalChartCard,
                };
                const ctx = loadBrowserScripts(['js/global_ui.js'], {
                    document: {
                        getElementById(id) {
                            return elements[id] || null;
                        },
                    },
                });
                let chartDraws = 0;

                ctx.OptionComboGlobalUI.applyGlobalDerivedData({
                    globalTotalCost: 10,
                    globalSimulatedValue: 12,
                    globalPnL: 2,
                    globalNetCashFlow: -10,
                    optionLegRedundancy: null,
                    projectedOptionDelivery: null,
                    hasAnyLiveData: false,
                    hasAnyHedgeLivePnL: false,
                    combinedAmortizedResult: null,
                }, new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                }), {
                    drawCharts: false,
                    drawGlobalChart() {
                        chartDraws += 1;
                    },
                });

                assert.equal(elements.totalCost.textContent, '$10.00');
                assert.equal(elements.simulatedValue.textContent, '$12.00');
                assert.equal(chartDraws, 0);
            },
        },
    ],
};
