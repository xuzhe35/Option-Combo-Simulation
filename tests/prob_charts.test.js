const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadProbCharts(extra = {}) {
    return loadBrowserScripts(['js/prob_charts.js'], {
        Blob: class Blob { constructor() {} },
        URL: { createObjectURL: () => 'blob:mock' },
        document: { getElementById: () => null },
        ...extra,
    });
}

module.exports = {
    name: 'prob_charts.js',
    tests: [
        {
            name: 'builds a conditional overlay whose density integrates to one and EV matches the sample mean',
            run() {
                const ctx = loadProbCharts();
                const zs = [-1.5, -1.0, -0.5, -0.2, 0.0, 0.1, 0.3, 0.6, 0.9, 1.4];
                const anchor = 700;
                const em = 20;
                const bins = 400;
                const binCenters = Array.from({ length: bins }, (_, i) => 560 + (i + 0.5) * (280 / bins));
                const pnlAt = (price) => price - anchor;

                const overlay = ctx._buildConditionalOverlay(zs, anchor, em, binCenters, pnlAt);
                assert.ok(overlay);
                assert.equal(overlay.n, zs.length);

                // EV = mean of pnl at replayed prices = mean(z) * em
                const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
                assert.ok(Math.abs(overlay.expectedPnL - meanZ * em) < 1e-9);

                // KDE density integrates to ~1 over a range wide enough to
                // hold every sample plus bandwidth tails.
                const binWidth = 280 / bins;
                let area = 0;
                for (let i = 0; i < bins; i++) area += overlay.density[i] * binWidth;
                assert.ok(Math.abs(area - 1) < 0.02, `density area ${area}`);

                // Density mass sits around the replayed prices, not the tails.
                const peakIdx = overlay.density.indexOf(Math.max(...overlay.density));
                assert.ok(Math.abs(binCenters[peakIdx] - anchor) < em * 1.5);
            },
        },
        {
            name: 'refuses degenerate inputs and thin sample sets',
            run() {
                const ctx = loadProbCharts({
                    REGIME_CONDITIONAL_SAMPLES: {
                        symbols: {
                            SPY: { dc: Array.from({ length: 40 }, (_, i) => (i % 5) / 5 - 0.4), bw: [0.1, 0.2] },
                        },
                    },
                });
                const grid = [90, 100, 110];
                assert.equal(ctx._buildConditionalOverlay(null, 100, 5, grid, () => 0), null);
                assert.equal(ctx._buildConditionalOverlay([0.1, 0.2], 0, 5, grid, () => 0), null);
                assert.equal(ctx._buildConditionalOverlay([0.1, 0.2], 100, 0, grid, () => 0), null);
                // identical samples -> zero sd -> refuse rather than emit spikes
                assert.equal(ctx._buildConditionalOverlay([0.3, 0.3, 0.3], 100, 5, grid, () => 0), null);

                // sample lookup: >=30 required, missing zones and symbols -> null
                assert.ok(ctx._getRegimeConditionalZs('SPY', 'dc'));
                assert.equal(ctx._getRegimeConditionalZs('SPY', 'bw'), null);
                assert.equal(ctx._getRegimeConditionalZs('TLT', 'dc'), null);
            },
        },
    ],
};
