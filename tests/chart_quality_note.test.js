const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function makeCanvas() {
    const ctx2d = {
        clearRect() {}, scale() {}, fillText() {}, beginPath() {}, moveTo() {},
        lineTo() {}, stroke() {}, fill() {}, closePath() {}, arc() {}, rect() {},
        clip() {}, drawImage() {}, fillRect() {}, roundRect() {}, strokeRect() {},
        save() {}, restore() {}, setLineDash() {}, measureText: () => ({ width: 10 }),
        createLinearGradient: () => ({ addColorStop() {} }),
    };
    return {
        getContext: () => ctx2d,
        style: {},
        addEventListener() {},
        parentElement: { getBoundingClientRect: () => ({ width: 600, height: 300 }) },
    };
}

function makeNote() {
    const classes = new Set();
    return {
        textContent: '',
        style: {},
        classList: {
            add: (...names) => names.forEach(n => classes.add(n)),
            remove: (...names) => names.forEach(n => classes.delete(n)),
            has: name => classes.has(name),
        },
    };
}

function makeCard(chartInstance) {
    const note = makeNote();
    return {
        note,
        card: {
            bestEffortProjectionEnabled: true,
            chartInstance,
            querySelector: selector => (
                selector === '.payoff-chart-quality-note' ? note : null
            ),
        },
    };
}

function loadChartScripts() {
    return loadBrowserScripts(['js/chart.js', 'js/chart_controls.js'], {
        document: { getElementById: () => null, querySelectorAll: () => [] },
        devicePixelRatio: 1,
        addEventListener() {},
    });
}

// `class PnLChart` is a lexical declaration, so it never lands on the vm
// context object the way a function declaration does.
function newPnLChart(ctx) {
    const PnLChart = new vm.Script('PnLChart').runInContext(ctx);
    return new PnLChart(makeCanvas());
}

module.exports = {
    name: 'chart_quality_note.js',
    tests: [
        {
            name: 'draw() records WHY the curve is empty for structural bail-outs',
            run() {
                const ctx = loadChartScripts();
                const chart = newPnLChart(ctx);

                chart.draw({ legs: [] }, {}, 90, 110);
                assert.equal(chart.lastRenderData, null);
                assert.equal(chart.lastEmptyReason, 'no-legs');

                chart.draw(null, {}, 90, 110);
                assert.equal(chart.lastEmptyReason, 'no-legs');

                // An inverted / empty custom price range is also structural.
                chart.draw({ legs: [{ type: 'call' }] }, {}, 110, 90);
                assert.equal(chart.lastRenderData, null);
                assert.equal(chart.lastEmptyReason, 'invalid-range');
            },
        },
        {
            name: 'an empty Global chart with zero included legs is not reported as degraded evidence',
            run() {
                const ctx = loadChartScripts();
                const chart = newPnLChart(ctx);
                // Exactly what drawGlobalChart builds when no group is ticked
                // "Include in Global": a virtual group with legs: [].
                chart.draw({ name: 'Global Portfolio (0 groups)', legs: [] }, {}, 90, 110);

                const { card, note } = makeCard(chart);
                ctx._renderPayoffChartQuality(card);

                assert.equal(
                    note.classList.has('is-error'),
                    false,
                    'nothing is wrong: there are zero legs, so no leg can be missing IV / λ / a quote'
                );
                assert.ok(
                    !/lacks usable IV/.test(note.textContent),
                    `must not blame leg evidence, got: ${note.textContent}`
                );
                assert.ok(/No legs are included/.test(note.textContent));
            },
        },
        {
            name: 'an inverted custom price range is not reported as degraded evidence',
            run() {
                const ctx = loadChartScripts();
                const chart = newPnLChart(ctx);
                chart.draw({ legs: [{ type: 'call' }] }, {}, 110, 90);

                const { card, note } = makeCard(chart);
                ctx._renderPayoffChartQuality(card);

                assert.equal(note.classList.has('is-error'), false);
                assert.ok(/price range is empty/.test(note.textContent));
            },
        },
        {
            name: 'a genuine evidence failure still raises the actionable degraded-evidence error',
            run() {
                const ctx = loadChartScripts();
                // draw() bailed AFTER clearing the structural reason, i.e. one
                // of the IV / timing / bound-quote gates rejected the curve.
                const chart = {
                    lastRenderData: null,
                    lastEmptyReason: null,
                    lastProjectionQuality: null,
                };
                const { card, note } = makeCard(chart);
                ctx._renderPayoffChartQuality(card);

                assert.equal(note.classList.has('is-error'), true);
                assert.ok(/lacks usable IV/.test(note.textContent));
            },
        },
        {
            name: 'uses a reduced point budget only when an interactive redraw requests it',
            run() {
                let priceCalls = 0;
                const ctx = loadBrowserScripts(['js/chart.js'], {
                    document: { createElement: () => makeCanvas() },
                    devicePixelRatio: 1,
                    processLegData(leg) {
                        return {
                            type: leg.type,
                            strike: leg.strike,
                            isUnderlyingLeg: false,
                            isExpired: false,
                            simIV: 0.2,
                            costBasis: 0,
                            posMultiplier: 1,
                            anchorUnderlyingPrice: 100,
                        };
                    },
                    computeSimulatedPrice() {
                        priceCalls += 1;
                        return 1;
                    },
                });
                const chart = newPnLChart(ctx);
                const group = {
                    viewMode: 'active',
                    legs: [{
                        id: 'call_100',
                        type: 'call',
                        strike: 100,
                        expDate: '2026-08-28',
                        closePrice: null,
                    }],
                };
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 100,
                    simulatedDate: '2026-07-29',
                    baseDate: '2026-07-29',
                    interestRate: 0.03,
                    ivOffset: 0,
                    marketDataMode: 'live',
                };

                chart.draw(group, state, 90, 110, { pointsCount: 40 });
                const interactiveCalls = priceCalls;
                assert.ok(interactiveCalls >= 40 && interactiveCalls <= 44);

                chart.draw(group, state, 90, 110);
                const fullCalls = priceCalls - interactiveCalls;
                assert.ok(fullCalls >= 500 && fullCalls <= 504);
            },
        },
    ],
};
