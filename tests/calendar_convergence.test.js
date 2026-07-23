const assert = require('node:assert/strict');

const { loadPricingContext } = require('./helpers/load-browser-scripts');

const DAY_MS = 86400000;

function almostEqual(actual, expected, tolerance = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

// Keep the Black-76 composition independent from calculateBlack76Price().
// Sharing only the normal CDF lets this regression catch an extra carry drift
// or a second discount factor in the production pricing path.
function manualBlack76(ctx, type, forward, strike, varianceT, rate, iv, rateT) {
    if (varianceT <= 0) {
        return type === 'call'
            ? Math.max(0, forward - strike)
            : Math.max(0, strike - forward);
    }
    const rootT = Math.sqrt(varianceT);
    const d1 = (Math.log(forward / strike) + 0.5 * iv * iv * varianceT) / (iv * rootT);
    const d2 = d1 - iv * rootT;
    const discount = Math.exp(-rate * rateT);
    return type === 'call'
        ? discount * (forward * ctx.normalCDF(d1) - strike * ctx.normalCDF(d2))
        : discount * (strike * ctx.normalCDF(-d2) - forward * ctx.normalCDF(-d1));
}

function optionLeg(id, type, pos, expDate, expiryAsOf, strike, extra = {}) {
    return {
        id,
        type,
        pos,
        strike,
        expDate,
        expiryAsOf,
        iv: 0.91, // Deliberately wrong: the local BBO inversion must replace it.
        ivSource: 'live',
        cost: 0,
        currentPrice: 0,
        currentPriceSource: 'live',
        closePrice: null,
        ...extra,
    };
}

function makeLiveFuture(quoteAsOf, mark = 6300) {
    return {
        id: 'es_sep',
        contractMonth: '202609',
        bid: mark - 1,
        ask: mark + 1,
        mark,
        quoteAsOf,
        conId: 60901,
        secType: 'FUT',
        symbol: 'ES',
        localSymbol: 'ESU6',
        exchange: 'CME',
        currency: 'USD',
        multiplier: '50',
        qualifiedContractMonth: '202609',
        requestIdentityVerified: true,
        liveQuoteIdentityStatus: 'verified',
        liveQuoteRequestGeneration: 7,
        liveQuoteRequestId: 'frqg7x1',
        requestedSecType: 'FUT',
        requestedSymbol: 'ES',
        requestedExchange: 'CME',
        requestedCurrency: 'USD',
        requestedMultiplier: '50',
        requestedContractMonth: '202609',
    };
}

function makeBboAnchor(ctx, state, leg, profile, localIv) {
    const pricingContext = ctx.OptionComboPricingContext;
    const quoteInputs = pricingContext.resolveLegQuotePricingInputs(state, leg, {
        underlyingPrice: state.underlyingPrice,
        interestRate: state.interestRate,
    });
    assert.equal(quoteInputs.available, true, quoteInputs.status);

    const quoteClock = ctx.processLegData(
        leg,
        state.liveQuoteDate,
        0,
        state.liveQuoteDate,
        quoteInputs.underlyingPrice,
        quoteInputs.interestRate,
        'active',
        profile,
        'live',
        {
            quoteAsOf: state.liveQuoteAsOf,
            targetAsOf: state.liveQuoteAsOf,
            targetSource: 'live-quote',
        }
    );
    assert.equal(quoteClock.timingAvailable, true, quoteClock.timingStatus);
    assert.ok(quoteClock.T > 0);
    const midpoint = manualBlack76(
        ctx,
        leg.type,
        quoteInputs.underlyingPrice,
        leg.strike,
        quoteClock.T,
        quoteInputs.interestRate,
        localIv,
        quoteClock.rateT
    );
    return { midpoint, quoteInputs, quoteClock, localIv };
}

function processAtTarget(ctx, state, leg, profile, bbo, scenarioAnchor) {
    const pricingContext = ctx.OptionComboPricingContext;
    const anchorUnderlying = pricingContext.resolveLegCurrentUnderlyingPrice(
        state,
        leg,
        state.underlyingPrice
    );
    const rate = pricingContext.resolveLegInterestRate(state, leg, state.interestRate);
    const processed = ctx.processLegData(
        leg,
        state.simulatedDate,
        0,
        state.liveQuoteDate,
        anchorUnderlying,
        rate,
        'active',
        profile,
        'live',
        {
            quoteAsOf: state.liveQuoteAsOf,
            targetAsOf: state.simulationTargetAsOf,
            targetSource: 'near-leg-contract-cutoff',
            observablePrice: bbo.midpoint,
            observablePriceSource: 'live_midpoint',
            observablePriceAsOf: state.liveQuoteAsOf,
            observablePriceFresh: true,
            quotePricingInputsAvailable: true,
            quotePricingInputStatus: 'ok',
            quoteUnderlyingPrice: bbo.quoteInputs.underlyingPrice,
            quoteUnderlyingAsOf: bbo.quoteInputs.underlyingAsOf,
            quoteInterestRate: bbo.quoteInputs.interestRate,
        }
    );
    const scenarioUnderlying = pricingContext.resolveLegScenarioUnderlyingPrice(
        state,
        leg,
        scenarioAnchor,
        state.underlyingPrice
    );
    const price = ctx.computeSimulatedPrice(
        processed,
        leg,
        scenarioUnderlying,
        rate,
        'active',
        state.simulatedDate,
        state.liveQuoteDate,
        0
    );
    return { processed, scenarioUnderlying, rate, price };
}

function processAtQuoteInstant(ctx, state, leg, profile, bbo) {
    const quoteState = {
        ...state,
        simulatedDate: state.liveQuoteDate,
        simulationTargetAsOf: state.liveQuoteAsOf,
    };
    const pricingContext = ctx.OptionComboPricingContext;
    const underlying = pricingContext.resolveLegCurrentUnderlyingPrice(
        quoteState,
        leg,
        quoteState.underlyingPrice
    );
    const rate = pricingContext.resolveLegInterestRate(
        quoteState,
        leg,
        quoteState.interestRate
    );
    const processed = ctx.processLegData(
        leg,
        quoteState.simulatedDate,
        0,
        quoteState.liveQuoteDate,
        underlying,
        rate,
        'active',
        profile,
        'live',
        {
            quoteAsOf: quoteState.liveQuoteAsOf,
            targetAsOf: quoteState.liveQuoteAsOf,
            targetSource: 'live-quote',
            observablePrice: bbo.midpoint,
            observablePriceSource: 'live_midpoint',
            observablePriceAsOf: quoteState.liveQuoteAsOf,
            observablePriceFresh: true,
            quotePricingInputsAvailable: true,
            quotePricingInputStatus: 'ok',
            quoteUnderlyingPrice: bbo.quoteInputs.underlyingPrice,
            quoteUnderlyingAsOf: bbo.quoteInputs.underlyingAsOf,
            quoteInterestRate: bbo.quoteInputs.interestRate,
        }
    );
    const price = ctx.computeSimulatedPrice(
        processed,
        leg,
        underlying,
        rate,
        'active',
        quoteState.simulatedDate,
        quoteState.liveQuoteDate,
        0
    );
    return { processed, price };
}

function assertCalendarNumerics(ctx, state, legs, profile, localIv, scenarioAnchor, lambdaSpec) {
    const bboById = new Map(legs.map(leg => [
        leg.id,
        makeBboAnchor(ctx, state, leg, profile, localIv),
    ]));

    // At the observable boundary, a complete calendar must reproduce the
    // exact same marks (and therefore the same P&L after subtracting costs).
    let observableCombo = 0;
    let quoteInstantCombo = 0;
    legs.forEach((leg) => {
        const bbo = bboById.get(leg.id);
        const quoteResult = processAtQuoteInstant(ctx, state, leg, profile, bbo);
        observableCombo += leg.pos * profile.optionMultiplier * bbo.midpoint;
        quoteInstantCombo += leg.pos * profile.optionMultiplier * quoteResult.price;
        almostEqual(quoteResult.price, bbo.midpoint, 1e-12);
    });
    almostEqual(quoteInstantCombo, observableCombo, 1e-9);

    let actualCombo = 0;
    let independentCombo = 0;
    const targetResults = [];
    legs.forEach((leg) => {
        const result = processAtTarget(
            ctx,
            state,
            leg,
            profile,
            bboById.get(leg.id),
            scenarioAnchor
        );
        targetResults.push({ leg, ...result });
        actualCombo += result.processed.posMultiplier * result.price;

        let independentPrice;
        if (result.processed.isExpired) {
            independentPrice = leg.type === 'call'
                ? Math.max(0, result.scenarioUnderlying - leg.strike)
                : Math.max(0, leg.strike - result.scenarioUnderlying);
            assert.equal(result.processed.T, 0);
            assert.equal(result.processed.rateT, 0);
            // r cannot leak into deterministic settlement.
            almostEqual(
                ctx.computeLegPrice(result.processed, result.scenarioUnderlying, -9),
                independentPrice,
                1e-12
            );
        } else {
            assert.equal(result.processed.simIVSource, 'local-bbo-implied');
            almostEqual(result.processed.simIV, localIv, 1e-9);
            independentPrice = manualBlack76(
                ctx,
                leg.type,
                result.scenarioUnderlying,
                leg.strike,
                result.processed.T,
                result.rate,
                localIv,
                result.processed.rateT
            );
        }
        independentCombo += result.processed.posMultiplier * independentPrice;
        almostEqual(result.price, independentPrice, 1e-8);
    });
    almostEqual(actualCombo, independentCombo, 1e-6);

    const far = targetResults.find(item => item.leg.id === 'far-call');
    assert.ok(far && !far.processed.isExpired);
    const targetMs = Date.parse(state.simulationTargetAsOf);
    const expiryMs = Date.parse(far.leg.expiryAsOf);
    almostEqual(far.processed.rateT, (expiryMs - targetMs) / DAY_MS / 365, 1e-12);
    const rolloverHour = profile.optionSecType === 'FOP' ? 17 : null;
    const exactClock = ctx.OptionComboDateUtils.resolveWeightedTime(
        targetMs,
        expiryMs,
        lambdaSpec,
        profile.calendarId,
        null,
        profile.optionExpiryTimeZone,
        rolloverHour
    );
    assert.equal(exactClock.available, true, exactClock.status);
    almostEqual(
        far.processed.T,
        exactClock.effectiveDays / ctx.weightedDaysPerYear(lambdaSpec),
        1e-12
    );

    // Reprocessing an already expired near leg with a deliberately unusable
    // lambda curve and absurd r must still produce the same intrinsic value.
    const near = targetResults.find(item => item.leg.id === 'near-call');
    ctx.configureSimTimeBasis({
        weekendWeight: { default: 0.99, strictByDate: true, byDate: {} },
    });
    const invariantNear = ctx.processLegData(
        near.leg,
        state.simulatedDate,
        0.7,
        state.liveQuoteDate,
        near.scenarioUnderlying,
        8,
        'active',
        profile,
        'live',
        {
            quoteAsOf: state.liveQuoteAsOf,
            targetAsOf: state.simulationTargetAsOf,
            targetSource: 'near-leg-contract-cutoff',
        }
    );
    assert.equal(invariantNear.isExpired, true);
    assert.equal(invariantNear.timingAvailable, true);
    almostEqual(
        ctx.computeLegPrice(invariantNear, near.scenarioUnderlying, 8),
        near.price,
        1e-12
    );

    // Restore for callers that continue using this context.
    ctx.configureSimTimeBasis({ weekendWeight: lambdaSpec });
    return { actualCombo, targetResults };
}

function buildFopLimitCase(ctx, millisecondsBeforeCutoff) {
    const cutoff = '2026-07-17T19:30:00.000Z';
    const quoteAsOf = new Date(Date.parse(cutoff) - millisecondsBeforeCutoff).toISOString();
    const lambdaSpec = {
        default: 0.3,
        strictByDate: true,
        byDate: {
            '2026-07-18': 0.18,
            '2026-07-19': 0.18,
        },
    };
    ctx.configureSimTimeBasis({ weekendWeight: lambdaSpec });
    const state = {
        marketDataMode: 'live',
        underlyingSymbol: 'ES',
        underlyingPrice: 6300,
        liveQuoteDate: '2026-07-17',
        liveQuoteAsOf: quoteAsOf,
        simulatedDate: '2026-07-17',
        simulationTargetAsOf: cutoff,
        interestRate: 0.041,
        useMarketDiscountCurve: false,
        requireExactContractTiming: true,
        liveFuturesRequestGeneration: 7,
        futuresPool: [makeLiveFuture(quoteAsOf)],
    };
    const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
    const legs = [
        optionLeg('near-call', 'call', -1, '2026-07-17', cutoff, 6300, { underlyingFutureId: 'es_sep' }),
        optionLeg('near-put', 'put', -1, '2026-07-17', cutoff, 6300, { underlyingFutureId: 'es_sep' }),
        optionLeg('far-call', 'call', 1, '2026-07-20', '2026-07-20T20:00:00.000Z', 6300, { underlyingFutureId: 'es_sep' }),
        optionLeg('far-put', 'put', 1, '2026-07-20', '2026-07-20T20:00:00.000Z', 6300, { underlyingFutureId: 'es_sep' }),
    ];
    state.groups = [{ id: 'calendar-limit', legs }];
    const bboById = new Map(legs.map(leg => [
        leg.id,
        makeBboAnchor(ctx, state, leg, profile, leg.id.startsWith('near') ? 0.20 : 0.22),
    ]));
    let liveValue = 0;
    let projectedValue = 0;
    legs.forEach((leg) => {
        const bbo = bboById.get(leg.id);
        liveValue += leg.pos * profile.optionMultiplier * bbo.midpoint;
        const target = processAtTarget(ctx, state, leg, profile, bbo, 6300);
        projectedValue += target.processed.posMultiplier * target.price;
    });
    return Math.abs(projectedValue - liveValue);
}

module.exports = {
    name: 'calendar convergence numerics',
    tests: [
        {
            name: 'INDEX calendar uses intrinsic near legs and exactly one carry and discount on far legs',
            run() {
                const ctx = loadPricingContext();
                const quoteAsOf = '2026-07-10T19:00:00.000Z';
                const nearCutoff = '2026-07-17T20:00:00.000Z';
                const farCutoff = '2026-07-20T20:00:00.000Z';
                const carryRate = 0.067;
                const lambdaSpec = {
                    default: 0.3,
                    strictByDate: true,
                    byDate: {
                        '2026-07-11': 0.12,
                        '2026-07-12': 0.12,
                        '2026-07-18': 0.46,
                        '2026-07-19': 0.46,
                    },
                };
                ctx.configureSimTimeBasis({ weekendWeight: lambdaSpec });
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 6300,
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: quoteAsOf,
                    simulatedDate: '2026-07-17',
                    simulationTargetAsOf: nearCutoff,
                    interestRate: 0.041,
                    useMarketDiscountCurve: false,
                    requireExactContractTiming: true,
                    forwardRateSamples: [
                        {
                            id: 'spx-near',
                            expDate: '2026-07-17',
                            carryRate,
                            daysToExpiry: 7,
                            quoteAsOf,
                            quality: { status: 'good', flags: [] },
                        },
                        {
                            id: 'spx-far',
                            expDate: '2026-07-20',
                            carryRate,
                            daysToExpiry: 10,
                            quoteAsOf,
                            quality: { status: 'good', flags: [] },
                        },
                    ],
                };
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('SPX');
                const weekly = { tradingClass: 'SPXW' };
                const legs = [
                    optionLeg('near-call', 'call', -1, '2026-07-17', nearCutoff, 6300, weekly),
                    optionLeg('near-put', 'put', -1, '2026-07-17', nearCutoff, 6300, weekly),
                    optionLeg('far-call', 'call', 1, '2026-07-20', farCutoff, 6300, weekly),
                    optionLeg('far-put', 'put', 1, '2026-07-20', farCutoff, 6300, weekly),
                ];
                state.groups = [{ id: 'spx-calendar', legs }];
                const scenarioSpot = 6325;
                const result = assertCalendarNumerics(
                    ctx,
                    state,
                    legs,
                    profile,
                    0.215,
                    scenarioSpot,
                    lambdaSpec
                );
                const far = result.targetResults.find(item => item.leg.id === 'far-call');
                const remainingDays = (Date.parse(farCutoff) - Date.parse(nearCutoff)) / DAY_MS;
                const expectedForward = scenarioSpot * Math.exp(carryRate * remainingDays / 365);
                almostEqual(far.scenarioUnderlying, expectedForward, 1e-9);
                // If r had also been used as carry, this would be different.
                assert.ok(Math.abs(
                    far.scenarioUnderlying
                        - expectedForward * Math.exp(state.interestRate * far.processed.rateT)
                ) > 0.1);
            },
        },
        {
            name: 'FOP calendar uses the bound futures forward and discounts it only once',
            run() {
                const ctx = loadPricingContext();
                const quoteAsOf = '2026-07-10T19:00:00.000Z';
                const nearCutoff = '2026-07-17T19:30:00.000Z';
                const farCutoff = '2026-07-20T20:00:00.000Z';
                const lambdaSpec = {
                    default: 0.3,
                    strictByDate: true,
                    byDate: {
                        '2026-07-11': 0.09,
                        '2026-07-12': 0.09,
                        '2026-07-18': 0.37,
                        '2026-07-19': 0.37,
                    },
                };
                ctx.configureSimTimeBasis({ weekendWeight: lambdaSpec });
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    underlyingPrice: 6300,
                    liveQuoteDate: '2026-07-10',
                    liveQuoteAsOf: quoteAsOf,
                    simulatedDate: '2026-07-17',
                    simulationTargetAsOf: nearCutoff,
                    interestRate: 0.041,
                    useMarketDiscountCurve: false,
                    requireExactContractTiming: true,
                    // This intentionally absurd parity carry must be ignored
                    // for a futures option whose forward is already quoted.
                    forwardRateSamples: [{ carryRate: 1.5, expDate: '2026-07-20', quoteAsOf }],
                    liveFuturesRequestGeneration: 7,
                    futuresPool: [makeLiveFuture(quoteAsOf)],
                };
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const bound = { underlyingFutureId: 'es_sep' };
                const legs = [
                    optionLeg('near-call', 'call', -1, '2026-07-17', nearCutoff, 6300, bound),
                    optionLeg('near-put', 'put', -1, '2026-07-17', nearCutoff, 6300, bound),
                    optionLeg('far-call', 'call', 1, '2026-07-20', farCutoff, 6300, bound),
                    optionLeg('far-put', 'put', 1, '2026-07-20', farCutoff, 6300, bound),
                ];
                state.groups = [{ id: 'es-calendar', legs }];
                const scenarioAnchor = 6363; // +1% shock to the bound future.
                const result = assertCalendarNumerics(
                    ctx,
                    state,
                    legs,
                    profile,
                    0.22,
                    scenarioAnchor,
                    lambdaSpec
                );
                result.targetResults.forEach((item) => {
                    almostEqual(item.scenarioUnderlying, scenarioAnchor, 1e-9);
                });
                const far = result.targetResults.find(item => item.leg.id === 'far-call');
                const onceDiscounted = manualBlack76(
                    ctx,
                    far.leg.type,
                    far.scenarioUnderlying,
                    far.leg.strike,
                    far.processed.T,
                    far.rate,
                    far.processed.simIV,
                    far.processed.rateT
                );
                const twiceDiscounted = onceDiscounted
                    * Math.exp(-far.rate * far.processed.rateT);
                almostEqual(far.price, onceDiscounted, 1e-8);
                assert.ok(Math.abs(far.price - twiceDiscounted) > 1e-5);
            },
        },
        {
            name: 'calendar projection converges to observable live P&L as the near cutoff approaches',
            run() {
                const ctx = loadPricingContext();
                const oneMinuteGap = buildFopLimitCase(ctx, 60000);
                const oneMillisecondGap = buildFopLimitCase(ctx, 1);
                assert.ok(oneMillisecondGap < oneMinuteGap);
                // Same costs are subtracted from live and projected values, so
                // this combo-value bound is also the P&L convergence bound.
                assert.ok(oneMillisecondGap < 1, `remaining P&L gap was ${oneMillisecondGap}`);
            },
        },
    ],
};
