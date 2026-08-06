const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function currencyFormatter() {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
}

function makeClassListEl(extra = {}) {
    const classes = new Set();
    return {
        textContent: '',
        classList: {
            toggle: (name, force) => {
                if (force) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
            },
            has: name => classes.has(name),
        },
        ...extra,
    };
}

function makeGreeksDom() {
    const elements = {
        portfolioGreeksCard: { style: {} },
        portfolioGreeksScope: { textContent: '' },
        portfolioDeltaTile: makeClassListEl(),
        portfolioThetaTile: makeClassListEl(),
        portfolioNetDeltaValue: makeClassListEl(),
        portfolioNetThetaValue: makeClassListEl(),
        portfolioDeltaUnit: { textContent: '' },
        portfolioGreeksNote: { textContent: '' },
    };
    const ctx = loadBrowserScripts(['js/global_ui.js'], {
        document: {
            getElementById(id) {
                return elements[id] || null;
            },
        },
    });
    return { ctx, elements };
}

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
        {
            name: 'renders portfolio delta and theta tiles with sign colouring on theta',
            run() {
                const dom = makeGreeksDom();

                dom.ctx.OptionComboGlobalUI.applyPortfolioGreeks({
                    portfolioGreeksDisplayable: true,
                    portfolioGreeksIncludedGroupCount: 3,
                    portfolioDeltaAvailable: true,
                    portfolioNetDelta: 55.5,
                    portfolioHedgeDelta: -25,
                    portfolioDeltaMissingGroupCount: 0,
                    portfolioThetaAvailable: true,
                    portfolioNetTheta: -122.75,
                    portfolioThetaMissingGroupCount: 0,
                }, currencyFormatter());

                assert.equal(dom.elements.portfolioGreeksCard.style.display, '');
                assert.equal(dom.elements.portfolioGreeksScope.textContent, '3 groups');
                assert.equal(dom.elements.portfolioNetDeltaValue.textContent, '+55.50');
                // Cents are dropped above $100/day so the tile never wraps.
                assert.equal(dom.elements.portfolioNetThetaValue.textContent, '-$123');
                assert.equal(
                    dom.elements.portfolioNetThetaValue.classList.has('greeks-tile-value-negative'),
                    true
                );
                // Delta is directional, not profitable or unprofitable, so it
                // must never pick up the red/green treatment.
                assert.equal(
                    dom.elements.portfolioNetDeltaValue.classList.has('greeks-tile-value-negative'),
                    false
                );
                assert.equal(
                    dom.elements.portfolioNetDeltaValue.classList.has('greeks-tile-value-positive'),
                    false
                );
                assert.equal(dom.elements.portfolioDeltaUnit.textContent, 'share equivalents, incl. hedge');
                assert.match(dom.elements.portfolioGreeksNote.textContent, /one-calendar-day/);
            },
        },
        {
            name: 'names the greek still waiting on TWS instead of showing a bare N/A',
            run() {
                const dom = makeGreeksDom();

                dom.ctx.OptionComboGlobalUI.applyPortfolioGreeks({
                    portfolioGreeksDisplayable: true,
                    portfolioGreeksIncludedGroupCount: 2,
                    portfolioDeltaAvailable: true,
                    portfolioNetDelta: 12,
                    portfolioHedgeDelta: 0,
                    portfolioDeltaMissingGroupCount: 0,
                    portfolioThetaAvailable: false,
                    portfolioNetTheta: null,
                    portfolioThetaMissingGroupCount: 1,
                }, currencyFormatter());

                assert.equal(dom.elements.portfolioNetDeltaValue.textContent, '+12.00');
                assert.equal(dom.elements.portfolioNetThetaValue.textContent, 'N/A');
                assert.equal(
                    dom.elements.portfolioNetThetaValue.classList.has('greeks-tile-value-negative'),
                    false
                );
                assert.equal(dom.elements.portfolioThetaTile.classList.has('is-unavailable'), true);
                assert.equal(dom.elements.portfolioDeltaTile.classList.has('is-unavailable'), false);
                assert.equal(dom.elements.portfolioDeltaUnit.textContent, 'share equivalents');
                assert.match(dom.elements.portfolioGreeksNote.textContent, /Θ in 1 group/);

                dom.ctx.OptionComboGlobalUI.applyPortfolioGreeks({
                    portfolioGreeksDisplayable: true,
                    portfolioGreeksIncludedGroupCount: 2,
                    portfolioDeltaAvailable: false,
                    portfolioNetDelta: null,
                    portfolioHedgeDelta: 0,
                    portfolioDeltaMissingGroupCount: 1,
                    portfolioDeltaStaleGroupCount: 1,
                    portfolioThetaAvailable: false,
                    portfolioNetTheta: null,
                    portfolioThetaMissingGroupCount: 1,
                    portfolioThetaStaleGroupCount: 1,
                }, currencyFormatter());
                assert.match(dom.elements.portfolioGreeksNote.textContent, /stale/i);
                assert.match(dom.elements.portfolioGreeksNote.textContent, /stale values are hidden/i);
            },
        },
        {
            name: 'takes theta locale and currency from the caller, not the ambient locale',
            run() {
                const dom = makeGreeksDom();

                dom.ctx.OptionComboGlobalUI.applyPortfolioGreeks({
                    portfolioGreeksDisplayable: true,
                    portfolioGreeksIncludedGroupCount: 1,
                    portfolioDeltaAvailable: true,
                    portfolioNetDelta: 1,
                    portfolioHedgeDelta: 0,
                    portfolioThetaAvailable: true,
                    portfolioNetTheta: -98765.43,
                }, new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }));

                // Not "-US$98,765": the panel must follow the workspace's own
                // formatter rather than whatever locale the browser runs in.
                assert.match(dom.elements.portfolioNetThetaValue.textContent, /^-/);
                assert.match(dom.elements.portfolioNetThetaValue.textContent, /€/);
                assert.doesNotMatch(dom.elements.portfolioNetThetaValue.textContent, /US\$/);
                assert.doesNotMatch(dom.elements.portfolioNetThetaValue.textContent, /,\d{2}$/);
            },
        },
        {
            name: 'hides the portfolio greeks card when greeks are not displayable',
            run() {
                const dom = makeGreeksDom();
                dom.elements.portfolioGreeksCard.style.display = '';

                dom.ctx.OptionComboGlobalUI.applyPortfolioGreeks({
                    portfolioGreeksDisplayable: false,
                }, currencyFormatter());

                assert.equal(dom.elements.portfolioGreeksCard.style.display, 'none');
            },
        },
    ],
};
