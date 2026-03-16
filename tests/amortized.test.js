const assert = require('node:assert/strict');

const { loadAmortizedContext } = require('./helpers/load-browser-scripts');

function almostEqual(actual, expected, tolerance = 1e-6) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

module.exports = {
    name: 'amortized.js',
    tests: [
        {
            name: 'assigns short puts into long shares with premium-adjusted basis',
            run() {
                const ctx = loadAmortizedContext();
                const result = ctx.OptionComboAmortized.calculateAmortizedCost(
                    {
                        viewMode: 'amortized',
                        legs: [
                            {
                                type: 'put',
                                pos: -1,
                                strike: 100,
                                expDate: '2026-03-10',
                                iv: 0.2,
                                cost: 2.5,
                                currentPrice: 0,
                                closePrice: null,
                            },
                        ],
                    },
                    95,
                    {
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-14',
                        ivOffset: 0,
                        interestRate: 0.03,
                        underlyingPrice: 95,
                    }
                );

                assert.equal(result.netShares, 100);
                assert.equal(result.assignmentCash, -10000);
                assert.equal(result.initialCost, -250);
                almostEqual(result.basis, 97.5);
            },
        },
        {
            name: 'treats explicit close prices as realized cash flows instead of assignments',
            run() {
                const ctx = loadAmortizedContext();
                const result = ctx.OptionComboAmortized.calculateAmortizedCost(
                    {
                        viewMode: 'amortized',
                        legs: [
                            {
                                type: 'call',
                                pos: -1,
                                strike: 110,
                                expDate: '2026-03-20',
                                iv: 0.25,
                                cost: 1.2,
                                currentPrice: 0,
                                closePrice: 0.5,
                            },
                        ],
                    },
                    120,
                    {
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-14',
                        ivOffset: 0,
                        interestRate: 0.03,
                        underlyingPrice: 120,
                    }
                );

                assert.equal(result.netShares, 0);
                assert.equal(result.assignmentCash, 0);
                assert.equal(result.residualValue, 0);
                assert.equal(result.totalCash, 70);
            },
        },
        {
            name: 'uses each group scenario override in combined amortized calculations',
            run() {
                const ctx = loadAmortizedContext();
                const result = ctx.OptionComboAmortized.calculateCombinedAmortizedCost(
                    [
                        {
                            viewMode: 'amortized',
                            settleUnderlyingPrice: 95,
                            legs: [
                                {
                                    type: 'put',
                                    pos: -1,
                                    strike: 100,
                                    expDate: '2026-03-10',
                                    iv: 0.2,
                                    cost: 2.5,
                                    currentPrice: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                        {
                            viewMode: 'amortized',
                            settleUnderlyingPrice: 105,
                            legs: [
                                {
                                    type: 'put',
                                    pos: -1,
                                    strike: 100,
                                    expDate: '2026-03-10',
                                    iv: 0.2,
                                    cost: 1.0,
                                    currentPrice: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    {
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-14',
                        ivOffset: 0,
                        interestRate: 0.03,
                        underlyingPrice: 95,
                    }
                );

                assert.equal(result.netShares, 100);
                almostEqual(result.basis, 96.5);
                assert.equal(result.totalCash, -9650);
            },
        },
        {
            name: 'reports amortized mode as unsupported for futures-option families',
            run() {
                const ctx = loadAmortizedContext();
                const result = ctx.OptionComboAmortized.calculateAmortizedCost(
                    {
                        viewMode: 'amortized',
                        legs: [
                            {
                                type: 'put',
                                pos: -1,
                                strike: 6000,
                                expDate: '2026-03-10',
                                iv: 0.2,
                                cost: 12.5,
                                currentPrice: 0,
                                closePrice: null,
                            },
                        ],
                    },
                    5900,
                    {
                        underlyingSymbol: 'ES',
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-14',
                        ivOffset: 0,
                        interestRate: 0.03,
                        underlyingPrice: 5900,
                    }
                );

                assert.equal(result.isSupported, false);
                assert.match(result.reason, /Amortized mode/i);
            },
        },
    ],
};
