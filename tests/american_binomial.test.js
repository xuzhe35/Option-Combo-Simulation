const assert = require('node:assert/strict');

const { loadPricingContext } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'american_binomial.js',
    tests: [
        {
            name: 'enforces intrinsic value and early exercise for American options',
            run() {
                const ctx = loadPricingContext();
                const american = ctx.OptionComboAmericanBinomial;

                assert.equal(
                    american.calculateAmericanOptionPrice({
                        type: 'put',
                        spot: 80,
                        strike: 100,
                        varianceTime: 0,
                        rateTime: 0,
                        riskFreeRate: 0.05,
                        volatility: 0.2,
                    }),
                    20
                );

                const deepPut = american.calculateAmericanOptionPrice({
                    type: 'put',
                    spot: 50,
                    strike: 100,
                    varianceTime: 1,
                    rateTime: 1,
                    riskFreeRate: 0.08,
                    volatility: 0.15,
                    dividendYield: 0,
                    steps: 201,
                });
                assert.ok(deepPut >= 50, `expected intrinsic floor, got ${deepPut}`);
            },
        },
        {
            name: 'matches a non-dividend European call within binomial tolerance',
            run() {
                const ctx = loadPricingContext();
                const americanCall = ctx.calculatePrice(
                    'american-binomial',
                    'call',
                    100,
                    100,
                    1,
                    0.05,
                    0.2,
                    1,
                    0,
                    401
                );
                const europeanCall = ctx.calculateOptionPrice(
                    'call',
                    100,
                    100,
                    1,
                    0.05,
                    0.2,
                    1
                );
                assert.ok(
                    Math.abs(americanCall - europeanCall) < 0.03,
                    `${americanCall} should converge to ${europeanCall}`
                );
            },
        },
        {
            name: 'keeps a same-strike one-day calendar straddle loss above its debit',
            run() {
                const ctx = loadPricingContext();
                const debit = 78;
                const strike = 750;
                const oneDay = 1 / 365;
                const rate = 0.0361940387;
                const volatility = 0.135;

                for (const spot of [600, 700, 740, 750, 760, 800, 900]) {
                    const expiringCall = Math.max(0, spot - strike);
                    const expiringPut = Math.max(0, strike - spot);
                    const longCall = ctx.calculatePrice(
                        'american-binomial',
                        'call',
                        spot,
                        strike,
                        oneDay,
                        rate,
                        volatility,
                        oneDay,
                        0,
                        201
                    );
                    const longPut = ctx.calculatePrice(
                        'american-binomial',
                        'put',
                        spot,
                        strike,
                        oneDay,
                        rate,
                        volatility,
                        oneDay,
                        0,
                        201
                    );
                    const pnl = (
                        longCall + longPut - expiringCall - expiringPut
                    ) * 100 - debit;
                    assert.ok(
                        pnl >= -debit - 1e-7,
                        `spot ${spot}: P&L ${pnl} breached -${debit}`
                    );
                }
            },
        },
        {
            name: 'runtime switch affects only bsm-spot profiles',
            run() {
                const ctx = loadPricingContext();
                ctx.OptionComboPricingCore.configureEquityOptionPricing({
                    model: 'american-binomial',
                    dividendYield: 0.0125,
                    steps: 151,
                });

                const equityLeg = ctx.processLegData(
                    {
                        type: 'put',
                        pos: 1,
                        strike: 100,
                        expDate: '2026-08-01',
                        iv: 0.2,
                        ivSource: 'manual',
                        cost: 1,
                        currentPrice: 1,
                        currentPriceSource: 'manual',
                    },
                    '2026-07-23',
                    0,
                    '2026-07-23',
                    100,
                    0.03,
                    'active',
                    { pricingModel: 'bsm-spot', optionMultiplier: 100 }
                );
                const futureOptionLeg = ctx.processLegData(
                    {
                        type: 'put',
                        pos: 1,
                        strike: 100,
                        expDate: '2026-08-01',
                        iv: 0.2,
                        ivSource: 'manual',
                        cost: 1,
                        currentPrice: 1,
                        currentPriceSource: 'manual',
                    },
                    '2026-07-23',
                    0,
                    '2026-07-23',
                    100,
                    0.03,
                    'active',
                    { pricingModel: 'black76', optionMultiplier: 50 }
                );

                assert.equal(equityLeg.pricingModel, 'american-binomial');
                assert.equal(equityLeg.dividendYield, 0.0125);
                assert.equal(equityLeg.binomialSteps, 151);
                assert.equal(futureOptionLeg.pricingModel, 'black76');
                assert.equal(futureOptionLeg.dividendYield, 0);
            },
        },
    ],
};
