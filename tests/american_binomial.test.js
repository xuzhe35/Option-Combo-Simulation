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
        {
            name: 'American put carries an early-exercise premium over the European put',
            run() {
                const ctx = loadPricingContext();
                const americanPut = ctx.calculatePrice(
                    'american-binomial', 'put', 80, 100, 1, 0.08, 0.2, 1, 0, 401
                );
                const europeanPut = ctx.calculateOptionPrice(
                    'put', 80, 100, 1, 0.08, 0.2, 1
                );
                // With a positive rate an in-the-money American put is worth
                // exercising early, so it must strictly exceed the European put
                // and never dip below its intrinsic value.
                assert.ok(
                    americanPut > europeanPut + 0.05,
                    `American put ${americanPut} should exceed European ${europeanPut}`
                );
                assert.ok(
                    americanPut >= 20 - 1e-9,
                    `American put ${americanPut} fell below intrinsic 20`
                );
            },
        },
        {
            name: 'American call binomial error shrinks as the step count grows',
            run() {
                const ctx = loadPricingContext();
                const european = ctx.calculateOptionPrice(
                    'call', 100, 100, 1, 0.05, 0.2, 1
                );
                const coarse = ctx.calculatePrice(
                    'american-binomial', 'call', 100, 100, 1, 0.05, 0.2, 1, 0, 25
                );
                const fine = ctx.calculatePrice(
                    'american-binomial', 'call', 100, 100, 1, 0.05, 0.2, 1, 0, 401
                );
                // A no-dividend American call never exercises early, so it
                // converges to the European value; the discretization error must
                // shrink with more steps.
                const coarseError = Math.abs(coarse - european);
                const fineError = Math.abs(fine - european);
                assert.ok(coarseError > 0.02, `coarse error ${coarseError} unexpectedly small`);
                assert.ok(fineError < 0.01, `fine error ${fineError} did not converge`);
                assert.ok(
                    fineError < coarseError,
                    `error ${fineError} should improve on ${coarseError}`
                );
            },
        },
        {
            name: 'zero-volatility American values collapse to the deterministic optimum',
            run() {
                const ctx = loadPricingContext();
                // Put: the stock drifts up at the risk-free rate, so immediate
                // exercise is optimal and the value is the current intrinsic.
                const zeroVolPut = ctx.calculatePrice(
                    'american-binomial', 'put', 80, 100, 1, 0.05, 1e-9, 1, 0, 201
                );
                assert.ok(
                    Math.abs(zeroVolPut - 20) < 1e-6,
                    `zero-vol put ${zeroVolPut} should equal intrinsic 20`
                );
                // Call (no dividend): exercise is deferred to expiry, so the
                // value is the discounted terminal intrinsic S - K e^{-rT}.
                const expectedCall = 120 - 100 * Math.exp(-0.05);
                const zeroVolCall = ctx.calculatePrice(
                    'american-binomial', 'call', 120, 100, 1, 0.05, 1e-9, 1, 0, 201
                );
                assert.ok(
                    Math.abs(zeroVolCall - expectedCall) < 1e-6,
                    `zero-vol call ${zeroVolCall} should equal ${expectedCall}`
                );
            },
        },
        {
            name: 'degenerate risk-neutral probability falls back to a finite deterministic value',
            run() {
                const ctx = loadPricingContext();
                // A large positive carry against tiny volatility pushes the CRR
                // probability above 1; the pricer must fall back to the
                // deterministic exercise-optimized value, not return NaN.
                const value = ctx.calculatePrice(
                    'american-binomial', 'call', 100, 100, 1, 2.0, 0.01, 1, 0, 25
                );
                const expected = 100 - 100 * Math.exp(-2.0);
                assert.ok(Number.isFinite(value), `fallback returned ${value}`);
                assert.ok(
                    Math.abs(value - expected) < 1e-6,
                    `fallback ${value} should equal deterministic ${expected}`
                );
            },
        },
        {
            name: 'dividend yield moves American call and put values in opposite directions',
            run() {
                const ctx = loadPricingContext();
                const callNoDiv = ctx.calculatePrice(
                    'american-binomial', 'call', 100, 100, 1, 0.05, 0.2, 1, 0, 201
                );
                const callDiv = ctx.calculatePrice(
                    'american-binomial', 'call', 100, 100, 1, 0.05, 0.2, 1, 0.06, 201
                );
                const putNoDiv = ctx.calculatePrice(
                    'american-binomial', 'put', 100, 100, 1, 0.05, 0.2, 1, 0, 201
                );
                const putDiv = ctx.calculatePrice(
                    'american-binomial', 'put', 100, 100, 1, 0.05, 0.2, 1, 0.06, 201
                );
                // A higher dividend yield lowers the forward: calls fall, puts rise.
                assert.ok(
                    callDiv < callNoDiv - 0.05,
                    `dividend should lower the call: ${callDiv} vs ${callNoDiv}`
                );
                assert.ok(
                    putDiv > putNoDiv + 0.05,
                    `dividend should raise the put: ${putDiv} vs ${putNoDiv}`
                );
            },
        },
    ],
};
