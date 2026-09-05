const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const context = loadBrowserScripts(['js/cost_basis_core.js', 'js/american_binomial.js',
    'js/cost_basis_stress_core.js', 'js/cost_basis_stress_band.js']);
const K = context.OptionComboCostBasisStressCore;
const M = context.OptionComboCostBasisStressModels;
const B = context.OptionComboCostBasisStressBand;
const L = context.OptionComboCostBasisCore;
const DAY = 86400000;
const asOf = '2026-09-08T16:00:00Z';
const expiry = '20270909';
function near(a, b, epsilon = 0.005) { assert.ok(Number.isFinite(a) && Math.abs(a - b) <= epsilon, `${a} != ${b}`); }
const stock = { seq: 1, kind: 'opening_balance', tradeDate: '2026-01-01', account: 'U1',
    shares: 200, price: 100, cashAmount: -20000, fees: 0, includeInCost: true };
function option(extra = {}) {
    const p = { seq: 2, kind: 'option_trade', tradeDate: '2026-01-02', account: 'U1',
        right: 'P', strike: 100, expiry, contracts: 1, sharesPerContract: 100,
        price: 5, fees: 0, includeInCost: true, ...extra };
    return { cashAmount: -p.contracts * p.sharesPerContract * p.price - p.fees, ...p };
}
function snapshot(events, settings = {}) {
    const pricingModel = settings.pricingModel || 'european';
    const at = settings.asOfInstant || asOf;
    const spot = settings.spot || 100;
    const rate = settings.rate ?? 0;
    const quotes = events.filter(p => p.kind === 'option_trade').map(p => {
        const time = Math.max(0, (K.exchangeTime(p.expiry) - Date.parse(at)) / (365 * DAY));
        const mark = M.priceScenarioOption(p.right, spot, p.strike, time, rate, settings.iv ?? 0.3,
            { pricingModel, dividendYield: settings.dividendYield || 0 });
        return { conId: p.conId, localSymbol: p.localSymbol, right: p.right, strike: p.strike,
            expiry: p.expiry, multiplier: p.sharesPerContract, mark, bid: mark * 0.9, ask: mark * 1.1,
            // Deliberately wrong broker IV: calibration must use the mark.
            impliedVolatility: 0.9, marketDataType: 1, currency: 'USD', observedAt: at };
    });
    return { underlyingPrice: spot, currency: 'USD', fetchedAt: at, underlyingObservedAt: at,
        throughExpiry: settings.throughExpiry || '20260908', options: quotes,
        ratesByExpiry: [...new Set(quotes.map(p => p.expiry))].map(expiry => ({ expiry, zeroRate: rate })) };
}
function setup(events = [stock, option()], extra = {}) {
    const options = { centerPrice: 100, rangePct: 20, pointCount: 11, currency: 'USD',
        asOfInstant: asOf, targetInstant: asOf, throughExpiry: '20260908',
        includeDeferredLongOptions: true, pricingModel: 'european', ...extra };
    if (!Object.hasOwn(extra, 'longOptionInputs')) options.longOptionInputs = snapshot(events, options);
    return { events, options };
}
function run(fixture) { return K.buildStressTestSeries(fixture.events, fixture.options); }
const middle = result => { assert.equal(result.available, true, result.reason); return result.points[5]; };

test('expiry cash oracle retains the long premium, including pure-option books', () => {
    const put = option({ expiry: '20260909' });
    for (const shares of [[], [stock]]) {
        const f = setup([...shares, put], { centerPrice: 80, throughExpiry: '20260909',
            targetInstant: '2026-09-09T20:00:00Z', longOptionInputs: null });
        const p = middle(run(f));
        near(p.headlinePnl, (shares.length ? -4000 : 0) + 2000 - 500);
        near(p.shares, (shares.length ? 200 : 0) - 100);
    }
});
test('cash decomposition is independent of all per-share cost lenses', () => {
    const events = [stock, option(), option({ seq: 3, right: 'C', strike: 110, contracts: -2, price: 3 })];
    for (const basisMode of L.BASIS_MODES) {
        const result = run(setup(events, { basisMode }));
        assert.equal(result.available, true, result.reason);
        const cash = events.reduce((s, e) => s + e.cashAmount, 0); // Fees are already inside stored cash.
        for (const p of result.points) {
            near(p.headlinePnl, cash + 200 * p.price + p.longOptionMarketValue - p.shortOptionLiability);
            near(p.headlinePnl, p.basePnl + p.longOptionPnl + p.shortOptionPnl);
        }
    }
});
test('closed long losses and fees remain in lifetime cash P&L', () => {
    const events = [stock, option(), option({ seq: 3, contracts: -1, price: 2, fees: 3 })];
    near(middle(run(setup(events))).headlinePnl, -303);
});
test('zero-share surviving options remain available with no per-share cost', () => {
    const f = setup([option()]);
    const p = middle(run(f));
    assert.equal(p.cost, null);
    near(p.headlinePnl, f.options.longOptionInputs.options[0].mark * 100 - 500);
});
test('short-put settlement changes cost across strike; deferred premium stays reserved', () => {
    const events = [stock, option({ expiry: '20260909', strike: 90, contracts: -1, price: 2, fees: 1 }),
        option({ seq: 3, strike: 75, contracts: -1, price: 3, fees: 2 })];
    const f = setup(events, { throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z' });
    const result = run(f); middle(result);
    for (const p of result.points) {
        const assigned = p.price < 90;
        near(p.shares, assigned ? 300 : 200);
        near(p.cost, assigned ? (20000 + 9000 - 199) / 300 : (20000 - 199) / 200);
    }
    assert.ok(new Set(result.points.map(p => p.cost)).size > 1, 'cost must not be the constant current ledger value');
    f.options.includeDeferredLongOptions = false;
    assert.deepEqual(run(f).points.map(p => p.cost), result.points.map(p => p.cost));
});
test('immediate delivery costs match the ledger What If in all three cost lenses', () => {
    const events = [stock,
        option({ expiry: '20260909', strike: 90, contracts: -1, price: 2, fees: 1 }),
        option({ seq: 3, expiry: '20260909', right: 'C', strike: 110, contracts: -1, price: 3 }),
        option({ seq: 4, strike: 80, price: 7 })];
    for (const basisMode of L.BASIS_MODES) {
        const result = run(setup(events, { basisMode, throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z' }));
        middle(result);
        for (const p of result.points) {
            const ledger = L.computeOptionSettlementScenario(events, p.price, { throughExpiry: '20260909' }).ledger;
            near(p.cost, L.summarizeCost(ledger.combined, basisMode).value);
            near(p.shares, ledger.combined.shares);
        }
    }
});
test('covered-call liquidation removes per-share cost, not total P&L', () => {
    const f = setup([stock, option({ expiry: '20260909', right: 'C', strike: 110, contracts: -2, price: 3 })],
        { throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z', longOptionInputs: null });
    const result = run(f); middle(result);
    for (const p of result.points) {
        if (p.price > 110) {
            near(p.shares, 0); assert.equal(p.cost, null); assert.equal(p.costState, 'no_shares');
            near(p.headlinePnl, 2600);
        } else near(p.cost, 97);
    }
});
test('cost settlement honors exact expiry time and exactly-at-strike expiration', () => {
    const f = setup([stock, option({ expiry: '20260909', contracts: -1, price: 5 })],
        { throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z' });
    f.options.longOptionInputs.options[0].expiryAsOf = '2026-09-09T20:15:00Z';
    near(middle(run(f)).cost, 100); // Still open: credit remains reserved.
    f.options.targetInstant = '2026-09-09T20:15:00Z';
    const p = middle(run(f)); near(p.cost, 97.5); near(p.shares, 200);
    assert.equal(p.expiredContracts, 1); assert.equal(p.assignedContracts, 0);
});
test('long exercise cost keeps long premium out of net-cash lens but inside tax basis', () => {
    const events = [option({ expiry: '20260909', strike: 100, price: 5, fees: 1 })];
    for (const basisMode of L.BASIS_MODES) {
        const result = run(setup(events, { basisMode, throughExpiry: '20260909',
            targetInstant: '2026-09-09T20:00:00Z', longOptionInputs: null }));
        middle(result);
        const shortStock = result.points[0]; near(shortStock.shares, -100);
        near(shortStock.cost, basisMode === 'tax_adjusted' ? 94.99 : 100);
        near(shortStock.headlinePnl, 1499); // Full P&L still includes the $501 premium.
        assert.equal(result.points[10].cost, null);
    }
});
test('cross-expiry cost replays early put acquisition before later call disposal', () => {
    // Ledger contract-key order puts C before P; settlement MUST use expiry time.
    const events = [stock, option({ expiry: '20260913', strike: 95, contracts: -1, price: 2 }),
        option({ seq: 3, expiry: '20260918', right: 'C', strike: 75, contracts: -1, price: 3 })];
    for (const basisMode of L.BASIS_MODES) {
        const p = middle(run(setup(events, { basisMode, centerPrice: 80, path: 'gradual',
            asOfInstant: '2026-09-08T20:00:00Z', targetInstant: '2026-09-18T20:00:00Z',
            throughExpiry: '20260918', longOptionInputs: null })));
        near(p.shares, 200);
        const expected = basisMode === 'net_cash' ? (20000 + 9500 - 7500 - 500) / 200
            : basisMode === 'stock_only' ? (20000 + 9500) / 300 : (20000 + 9500 - 200) / 300;
        near(p.cost, expected);
        near(p.headlinePnl, -5500);
    }
});
for (const pricingModel of ['european', 'american']) for (const liquidation of ['mid', 'bidask']) {
    test(`same-time zero-shock convergence: ${pricingModel}/${liquidation}`, () => {
        const f = setup([stock, option(), option({ seq: 3, right: 'C', strike: 110, contracts: -2 })],
            { pricingModel, liquidation, pnlBasis: 'change', dividendYield: 0.01 });
        const result = run(f);
        near(middle(result).headlinePnl, 0, 0.01);
        for (const fit of result.calibration) { near(fit.iv, 0.3, 1e-4); near(fit.residual, 0, 1e-4); }
    });
}
test('calibration does not drag a constant mark residual through expiry', () => {
    const f = setup([option()], { centerPrice: 80, throughExpiry: expiry,
        targetInstant: new Date(K.exchangeTime(expiry)).toISOString() });
    f.options.longOptionInputs.options[0].mark = 8;
    near(middle(run(f)).headlinePnl, 1500); // 2000 intrinsic minus 500 historical premium.
});
test('deep-ITM value and paid premium are continuous across the expiry boundary', () => {
    const events = [stock, option({ expiry: '20260909' })];
    const f = setup(events, { centerPrice: 80, throughExpiry: '20260909', pricingModel: 'american',
        targetInstant: '2026-09-09T19:59:00Z' });
    const before = middle(run(f));
    f.options.targetInstant = '2026-09-09T20:00:00Z';
    const after = middle(run(f));
    near(before.headlinePnl, -2500); near(after.headlinePnl, -2500);
});
test('American boundary honors exercise at spot zero including negative rates', () => {
    near(M.priceScenarioOption('P', 0, 100, 1, 0.05, 0.3, { pricingModel: 'american' }), 100);
    near(M.priceScenarioOption('P', 0, 100, 1, -0.05, 0.3, { pricingModel: 'american' }), 100 * Math.exp(0.05));
    assert.equal(M.priceScenarioOption('P', -1, 100, 1, 0.05, 0.3, { pricingModel: 'american' }), null);
});
test('expiry-day contract stays alive before an explicit 16:15 exchange cutoff', () => {
    const f = setup([option({ expiry: '20260909' })], { asOfInstant: '2026-09-09T20:05:00Z',
        targetInstant: '2026-09-09T20:05:00Z', throughExpiry: '20260909', pnlBasis: 'change' });
    const quote = f.options.longOptionInputs.options[0];
    quote.expiryAsOf = '2026-09-09T20:15:00Z';
    quote.mark = M.priceScenarioOption('P', 100, 100, 10 / (365 * 24 * 60), 0, 0.3, {});
    const p = middle(run(f));
    assert.equal(p.longOptionCount, 1);
    near(p.headlinePnl, 0);
});
test('stale expired holdings fail closed and require reconciliation', () => {
    const f = setup([option({ expiry: '20260901' })]);
    assert.equal(run(f).reason, 'expired_open_position_reconcile');
});
test('exchange clock does not change date with the browser locale and handles DST', () => {
    assert.equal(K.exchangeDate('2026-09-09T02:00:00Z'), '20260908');
    assert.equal(new Date(K.exchangeTime('20260909')).toISOString(), '2026-09-09T20:00:00.000Z');
    assert.equal(new Date(K.exchangeTime('20261209')).toISOString(), '2026-12-09T21:00:00.000Z');
    assert.throws(() => K.exchangeTime('20260230'));
});
test('horizon zero is precisely the snapshot instant, not the calendar close', () => {
    const f = setup([option()], { horizonDays: 0, targetInstant: undefined, pnlBasis: 'change' });
    const result = run(f);
    near(middle(result).headlinePnl, 0);
    assert.equal(result.asOfInstant, result.targetInstant);
});
test('cross-expiry physical delivery depends on the chosen path', () => {
    const f = setup([option({ expiry: '20260913', strike: 85 })], { centerPrice: 80,
        asOfInstant: '2026-09-08T20:00:00Z', targetInstant: '2026-09-18T20:00:00Z',
        throughExpiry: '20260918' });
    const immediate = middle(run(f));
    near(immediate.headlinePnl, 0); // immediately at 80: delivery value 500, premium -500.
    near(immediate.cost, 85); near(immediate.shares, -100);
    f.options.path = 'gradual';
    const gradual = middle(run(f));
    near(gradual.headlinePnl, -500); // expiry spot 90, OTM. Cannot revive the expired put.
    assert.equal(gradual.cost, null); near(gradual.shares, 0);
});
test('turning off surviving options excludes their cash as well as their value', () => {
    const f = setup([stock, option()], { includeDeferredLongOptions: false, longOptionInputs: null });
    const result = run(f);
    near(middle(result).headlinePnl, 0);
    assert.ok(result.warnings.includes('partial_portfolio_excludes_deferred'));
});
test('weekly income is a separate net-income assumption with fractional elapsed days', () => {
    const f = setup([stock], { weeklyPremium: 700, targetInstant: '2026-09-22T16:00:00Z', throughExpiry: '20260922' });
    const p = middle(run(f)); near(p.premiumIncome, 1400); near(p.headlinePnl - p.totalPnl, 1400);
    f.options.weeklyPremium = -1; assert.equal(run(f).reason, 'invalid_weekly_premium');
});
function linkedFixture(extra = {}) {
    const f = setup([stock, option()]);
    const events = [option({ conId: 2 })];
    f.options.linkedHedge = { symbol: 'QQQ', bookId: 'hedge', currency: 'USD', basePrice: 100,
        ratio: 3, asOf: '20260908', mapping: 'linear', ivMode: 'beta', ivBetaAuto: true,
        ivTenorDamping: true, ivTenorDays: 30, ivTenorExponent: 0.65, ivOtmDiscount: true,
        openOptions: L.computeLedger(events).openOptions, marketInputs: snapshot(events), ...extra };
    return f;
}
test('linked overlay and own positions share the same valuation baseline', () => {
    const f = linkedFixture(); f.options.pnlBasis = 'change';
    const result = run(f); near(middle(result).headlinePnl, 0);
    for (const p of result.points) near(p.headlinePnl, p.pnl + p.linkedPnl);
});
test('linked expiry monetizes payoff; does not carry linked delivery stock', () => {
    const events = [option({ expiry: '20260913', strike: 95 })];
    const f = linkedFixture({ ratio: 1, openOptions: L.computeLedger(events).openOptions,
        marketInputs: snapshot(events, { throughExpiry: '20260918', asOfInstant: '2026-09-08T20:00:00Z' }) });
    Object.assign(f.options, { centerPrice: 80, asOfInstant: '2026-09-08T20:00:00Z', targetInstant: '2026-09-18T20:00:00Z',
        path: 'gradual', throughExpiry: '20260918', longOptionInputs: snapshot(f.events, { throughExpiry: '20260918', asOfInstant: '2026-09-08T20:00:00Z' }) });
    const p = middle(run(f)); near(p.linkedMarketValue, 500); // expiry spot 90, strike 95.
});
test('single reset uses simple returns and multi-day approximation is conditional', () => {
    for (const timeYears of [0, 1 / 365]) {
        near(M.mapLinkedUnderlyingPrice(100, -30, 3, { timeYears, sigma: 0.3 }), 90);
        near(M.mapLinkedUnderlyingPrice(100, 30, -3, { timeYears, sigma: 0.3 }), 90);
    }
    const t = 20 / 365;
    near(M.mapLinkedUnderlyingPrice(100, -30, 3, { timeYears: t, sigma: 0.3 }), 100 * (0.7 * Math.exp(3 * 0.09 * t)) ** (1 / 3));
    assert.equal(M.normalizeLinkedRatio(0), null);
});
test('multi-day overlay uses locally calibrated IV when broker greeks are absent', () => {
    const f = linkedFixture({ mapping: 'compound' });
    Object.assign(f.options, { throughExpiry: '20261008', targetInstant: '2026-10-08T16:00:00Z' });
    for (const inputs of [f.options.longOptionInputs, f.options.linkedHedge.marketInputs]) {
        inputs.throughExpiry = '20261008';
        inputs.options.forEach(q => { q.impliedVolatility = null; });
    }
    const c = K.compile(f.events, f.options);
    assert.equal(c.available, true, c.reason); near(c.sigma, 0.3, 1e-4);
    const result = K.sweep(c); middle(result);
    assert.equal(result.linkedSigmaIvSource, 'local_calibration');
    assert.ok(result.warnings.includes('path_sigma_local_iv_proxy'));
    assert.equal(B.calculate(c).available, true);
    // Preserve the existing explicit broker-IV proxy when it IS present.
    f.options.linkedHedge.marketInputs.options[0].impliedVolatility = 0.24;
    const broker = K.compile(f.events, f.options); near(broker.sigma, 0.24);
    assert.equal(K.sweep(broker).linkedSigmaIvSource, 'broker');
});
test('an option expiring before target can still provide a current local-IV path proxy', () => {
    const events = [option({ expiry: '20260913' })];
    const f = linkedFixture({ mapping: 'compound', openOptions: L.computeLedger(events).openOptions,
        marketInputs: snapshot(events, { throughExpiry: '20260918' }) });
    Object.assign(f.options, { throughExpiry: '20260918', targetInstant: '2026-09-18T16:00:00Z' });
    f.options.longOptionInputs.throughExpiry = '20260918';
    f.options.linkedHedge.marketInputs.options[0].impliedVolatility = null;
    const c = K.compile(f.events, f.options);
    assert.equal(c.available, true, c.reason); near(c.sigma, 0.3, 1e-4);
    assert.equal(c.linkedPositions[0].iv, null, 'do not use proxy IV in settled payoff');
    assert.equal(middle(K.sweep(c)).linkedSettledContracts, 1);
    f.options.linkedHedge.marketInputs.ratesByExpiry[0].zeroRate = null;
    assert.equal(run(f).reason, 'missing_linked_sigma', 'missing calibration inputs are not a zero-variance proxy');
    f.options.linkedHedge.sigma = 0.25;
    assert.equal(run(f).available, true, 'explicit sigma needs no calibration for a settled leg');
});
for (const [name, mutate, reason] of [
    ['non-USD', f => { f.options.currency = 'CAD'; }, 'unsupported_stress_currency'],
    ['quote currency', f => { f.options.longOptionInputs.options[0].currency = 'CAD'; }, 'unsupported_stress_currency'],
    ['null rate is not zero', f => { f.options.longOptionInputs.ratesByExpiry[0].zeroRate = null; }, 'missing_discount_rate'],
    ['missing mark', f => { f.options.longOptionInputs.options[0].mark = null; }, 'missing_option_mark'],
    ['impossible mark', f => { f.options.longOptionInputs.options[0].mark = 200; }, 'quote_outside_model_bounds'],
    ['negative shock', f => { f.options.ivDriver = { ivMode: 'fixed', ivShockPoints: -50 }; }, 'invalid_option_iv_shock'],
    ['crossed BBO', f => { f.options.longOptionInputs.options[0].bid = 999; }, 'invalid_option_bid_ask'],
    ['single sided bidask', f => { f.options.liquidation = 'bidask'; f.options.longOptionInputs.options[0].bid = null; }, 'missing_option_quote_sides'],
    ['snapshot skew', f => { f.options.longOptionInputs.fetchedAt = '2026-09-08T16:02:00Z'; }, 'snapshot_time_mismatch'],
    ['old quote receipt', f => { f.options.longOptionInputs.options[0].observedAt = '2026-09-08T15:57:00Z'; }, 'snapshot_time_mismatch'],
    ['strong identity has no term fallback', f => { f.events[1].conId = 1; f.options.longOptionInputs.options[0].conId = 2; }, 'long_option_identity_mismatch'],
    ['strong identity cannot hide multiplier conflict', f => { f.events[1].conId = 1; Object.assign(f.options.longOptionInputs.options[0], { conId: 1, multiplier: 10 }); }, 'quote_identity_conflict'],
    ['old backend', f => { f.options.requireSnapshotVersion = 2; }, 'snapshot_upgrade_required'],
    ['ambiguous term-only identity', f => { f.options.longOptionInputs.options.push({...f.options.longOptionInputs.options[0], conId: 99}); }, 'quote_identity_conflict'],
    ['bad explicit instant', f => { f.options.asOfInstant = '2026-09-08T16:00:00'; }, 'invalid_stress_instant'],
]) test(`fail closed: ${name}`, () => { const f = setup(); mutate(f); const s = run(f); assert.equal(s.available, false); assert.equal(s.reason, reason); assert.equal(s.points.length, 0); });

test('frozen curve resolves separate fractional current and scenario tenors', () => {
    const f = setup();
    f.options.longOptionInputs.discountCurve = { schemaVersion: 2, currency: 'USD',
        effectiveDate: '2026-09-08', curveAsOf: '2026-09-08', points: [
            { tenorDays: 1, zeroRate: 0.02 }, { tenorDays: 365, zeroRate: 0.04 }, { tenorDays: 730, zeroRate: 0.06 }] };
    Object.assign(f.options, { targetInstant: '2027-03-09T16:00:00Z', throughExpiry: '20270309' });
    f.options.longOptionInputs.throughExpiry = '20270309';
    const c = K.compile(f.events, f.options);
    assert.equal(c.available, true, c.reason); assert.notEqual(c.own[0].rate, c.own[0].futureRate);
});
test('band includes every sampled whole portfolio, its center and flat IV on BOTH sides', () => {
    const events = [stock, option({ strike: 90, contracts: 3 }), option({ seq: 3, strike: 120, contracts: -4, price: 35 })];
    const f = setup(events, { ivDriver: { ivMode: 'beta', ivBeta: 1.5, ivTenorDamping: true,
        ivTenorDays: 30, ivTenorExponent: 0.9, ivOtmDiscount: true } });
    const c = K.compile(events, f.options); const band = B.calculate(c);
    assert.equal(band.available, true, band.reason);
    assert.equal(band.probabilistic, false); assert.equal(band.continuousExtremaGuaranteed, false);
    assert.ok(band.members.some(m => m.betaScale === 0.9));
    assert.ok(band.members.some(m => m.betaScale === 1.1));
    for (const member of band.members) K.sweep(c, member).points.forEach((p, i) => {
        assert.ok(p.headlinePnl >= band.points[i].lower - 1e-8 && p.headlinePnl <= band.points[i].upper + 1e-8);
    });
    const flat = K.sweep(c, { flatIv: true });
    assert.ok(band.points.some((p, i) => Math.abs(p.upper - flat.points[i].headlinePnl) < 1e-6));
});
test('band respects disabled dimensions, scales manual beta, and has zero width with no IV shock', () => {
    const f = linkedFixture({ ivTenorDamping: false, ivOtmDiscount: false, ivBetaAuto: false, ivBeta: 2 });
    let c = K.compile(f.events, f.options); const grid = B.members(c);
    assert.equal(grid.length, 7);
    assert.ok(grid.every(m => m.tenorExponent === undefined && m.otmFloor === undefined));
    near(K.sweep(c, { betaScale: 0.8 }).points[0].linkedIvBetaApplied, 1.6);
    f.options.linkedHedge.ivMode = 'none'; c = K.compile(f.events, f.options);
    const band = B.calculate(c); assert.equal(band.available, true);
    band.points.forEach(p => near(p.lower, p.upper));
});
test('inverse fund band follows actual index downside even on positive main-axis returns', () => {
    const f = linkedFixture({ ratio: -3 }); const c = K.compile(f.events, f.options);
    const band = B.calculate(c); assert.equal(band.available, true);
    assert.ok(band.points[10].upper > band.points[10].lower);
});
test('an invalid band member cannot leave a plausible partial envelope', () => {
    const f = setup(); const c = K.compile(f.events, f.options);
    const fake = { ...context.OptionComboCostBasisStressCore, sweep(compiled, member) {
        return member && member.betaScale ? { available: false, reason: 'member_rejected', points: [] } : K.sweep(compiled, member);
    } };
    context.OptionComboCostBasisStressCore = fake;
    try { const band = B.calculate(c); assert.equal(band.available, false); assert.equal(band.reason, 'member_rejected'); }
    finally { context.OptionComboCostBasisStressCore = K; }
});
test('stress compilation and band never mutate events, snapshots or ledger', () => {
    const f = linkedFixture(); const before = JSON.stringify(f);
    B.calculate(K.compile(f.events, f.options));
    assert.equal(JSON.stringify(f), before);
});
test('compiled snapshots are isolated from subsequent caller mutations', () => {
    const f = linkedFixture(); const c = K.compile(f.events, f.options);
    const before = JSON.stringify(K.sweep(c));
    f.options.linkedHedge.marketInputs.options[0].mark = 200;
    f.options.linkedHedge.ivBetaAuto = false;
    f.options.centerPrice = 200;
    assert.equal(JSON.stringify(K.sweep(c)), before);
});
test('scenario cost is independent of P&L basis, IV members, linked hedge and assumed income', () => {
    const f = linkedFixture();
    f.events.push(option({ seq: 3, expiry: '20260909', strike: 90, contracts: -1, price: 2 }));
    Object.assign(f.options, { targetInstant: '2026-09-09T20:00:00Z', throughExpiry: '20260909' });
    f.options.longOptionInputs = snapshot(f.events, f.options);
    f.options.linkedHedge.marketInputs.throughExpiry = '20260909';
    const base = run(f); middle(base);
    f.options.pnlBasis = 'change'; f.options.weeklyPremium = 700;
    const c = K.compile(f.events, f.options);
    for (const member of B.members(c)) {
        const result = K.sweep(c, member); middle(result);
        assert.deepEqual(result.points.map(p => p.cost), base.points.map(p => p.cost));
    }
    f.options.linkedHedge = null;
    assert.deepEqual(run(f).points.map(p => p.cost), base.points.map(p => p.cost));
});
test('cost replay is cached by delivery outcome, not repeated for IV-band members', () => {
    let replays = 0;
    const measured = loadBrowserScripts(['js/cost_basis_stress_core.js', 'js/cost_basis_stress_band.js'], {
        OptionComboCostBasisCore: { ...L, computeLedger(...args) { replays++; return L.computeLedger(...args); } },
    });
    const f = setup([stock, option({ expiry: '20260909', strike: 90, contracts: -1 })],
        { throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z', longOptionInputs: null,
            ivDriver: { ivMode: 'beta', ivBeta: 1.5, ivTenorDamping: true, ivTenorDays: 30,
                ivTenorExponent: 0.65, ivOtmDiscount: true } });
    const c = measured.OptionComboCostBasisStressCore.compile(f.events, f.options);
    const band = measured.OptionComboCostBasisStressBand.calculate(c);
    assert.equal(band.available, true, band.reason); assert.equal(band.members.length, 47);
    assert.equal(replays, 3); // One base replay, two possible delivery outcomes.
});
test('uncached cost projections use detached history and hide incomplete historical costs', () => {
    const f = setup([{ ...stock }, option({ expiry: '20260909', strike: 90, contracts: -1 })],
        { throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z', longOptionInputs: null });
    const c = K.compile(f.events, f.options);
    const expected = JSON.stringify(K.sweep(c));
    f.events[0].cashAmount = -1; f.events[1].contracts = -100;
    assert.equal(JSON.stringify(K.sweep(c)), expected);
    const incomplete = setup([stock, option({ tag: 'prior_open' })], { pnlBasis: 'change' });
    const result = run(incomplete); middle(result);
    result.points.forEach(p => {
        assert.equal(p.cost, null); assert.equal(p.costState, 'incomplete');
        assert.equal(p.cashflowPnl, null); assert.ok(Number.isFinite(p.snapshotChangePnl));
    });
});

test('side-by-side lenses match separate sweeps and exclude hypothetical income', () => {
    const f = linkedFixture();
    f.events.push(option({ seq: 3, expiry: '20260909', contracts: -2, price: 1 }));
    Object.assign(f.options, { throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z', weeklyPremium: 700 });
    f.options.longOptionInputs = snapshot(f.events, f.options);
    f.options.linkedHedge.marketInputs.throughExpiry = '20260909';
    const cost = run(f), change = run({ events: f.events, options: { ...f.options, pnlBasis: 'change' } });
    middle(cost); middle(change);
    cost.points.forEach((p, i) => {
        near(p.cashflowPnl, p.totalPnl);
        near(p.snapshotChangePnl, change.points[i].totalPnl);
        near(change.points[i].cashflowPnl, p.cashflowPnl);
        near(p.flatIvPnl + p.ivContribution + p.premiumIncome, p.headlinePnl);
        assert.ok(p.premiumIncome > 0);
    });
});
for (const lens of ['mid', 'bidask']) test(`settled quote reference uses signed quantity and ${lens} lens`, () => {
    const f = setup([stock, option({ expiry: '20260909', contracts: -2, price: 1 })],
        { throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z', liquidation: lens });
    const result = run(f), p = middle(result), quote = f.options.longOptionInputs.options[0];
    near(p.snapshotChangePnl, 200 * (lens === 'mid' ? quote.mark : quote.ask));
    const baseline = JSON.stringify(result.points.map(p => [p.headlinePnl, p.cost, p.settlementCashPaid]));
    f.options.longOptionInputs.options = [];
    const missing = run(f); middle(missing);
    assert.equal(missing.referenceChangeReason, 'missing_reference_quotes');
    assert.equal(middle(missing).snapshotChangePnl, null);
    assert.equal(JSON.stringify(missing.points.map(p => [p.headlinePnl, p.cost, p.settlementCashPaid])), baseline);
    f.options.pnlBasis = 'change';
    assert.equal(run(f).available, false, 'main change lens must still fail closed');
});
test('invalid optional quotes never fabricate snapshot changes or block cash-only expiry', () => {
    const f = setup([stock, option({ expiry: '20260909', contracts: -1 })],
        { throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z' });
    f.options.longOptionInputs.options[0].bid = 100;
    f.options.longOptionInputs.options[0].ask = 1;
    const result = run(f); middle(result);
    assert.equal(result.points[0].snapshotChangePnl, null);
    near(result.points[0].cashflowPnl, result.points[0].totalPnl);
});
test('IV repricing explanation is separate from the optional band and preserves tripled IV shock', () => {
    for (const ivMode of ['none', 'beta', 'fixed']) {
        const f = linkedFixture({ ivMode, ivShockPoints: 10 });
        const c = K.compile(f.events, f.options), result = run(f), flat = K.sweep(c, { flatIv: true });
        middle(result);
        result.points.forEach((p, i) => {
            near(p.flatIvPnl, flat.points[i].totalPnl);
            near(p.ivContribution, p.totalPnl - flat.points[i].totalPnl);
            near(p.ownIvShockPoints, p.linkedIvShockPoints * 3);
            near(p.linkedPrice, 100 * (1 + p.changePct / 300));
        });
        assert.equal(result.band, undefined);
        if (ivMode === 'none') result.points.forEach(p => near(p.ivContribution, 0));
        else assert.notEqual(result.points[0].ivContribution, 0);
        const band = B.calculate(c, { includeFlatIv: false });
        assert.equal(band.available, true);
        assert.ok(!band.members.some(m => m.flatIv));
    }
});
test('cash settlement signs cover long/short calls and puts, excluding premiums', () => {
    for (const [right, contracts, price, cash] of [['P', -1, 80, -10000], ['P', 1, 80, 10000],
        ['C', -1, 120, 10000], ['C', 1, 120, -10000]]) {
        const f = setup([stock, option({ right, contracts, expiry: '20260909' })],
            { centerPrice: price, throughExpiry: '20260909', targetInstant: '2026-09-09T20:00:00Z', longOptionInputs: null });
        const p = middle(run(f));
        near(p.settlementCashNet, cash);
        near(p.settlementCashPaid, Math.max(0, -cash));
        near(p.settlementCashReceived, Math.max(0, cash));
        near(p.shares, 200 - cash / 100);
        // Expiring exactly at strike produces no delivery cash.
        f.options.centerPrice = 100;
        near(middle(run(f)).settlementCashNet, 0);
    }
});
test('an unavailable flat-IV diagnostic does not erase a valid shocked center', () => {
    const f = linkedFixture();
    const altered = loadBrowserScripts([], {
        OptionComboCostBasisCore: L,
        OptionComboCostBasisStressModels: { ...M, priceScenarioOption(...args) {
            if (Math.abs(args[1] - 80) < 1e-8 && Math.abs(args[5] - 0.3) < 1e-5) return NaN;
            return M.priceScenarioOption(...args);
        } },
    });
    require('node:vm').runInContext(require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../js/cost_basis_stress_core.js'), 'utf8'), altered);
    const result = altered.OptionComboCostBasisStressCore.buildStressTestSeries(f.events, f.options);
    assert.equal(result.available, true, result.reason);
    assert.equal(result.ivExplanationReason, 'invalid_scenario_price');
    result.points.forEach(p => { assert.equal(p.flatIvPnl, null); assert.equal(p.ivContribution, null); });
});
test('cross-expiry cash shows gross outflows and inflows without netting timing or linked value', () => {
    const own = [stock, option({ expiry: '20260909', strike: 110, contracts: -1 }),
        option({ seq: 3, expiry: '20260910', right: 'C', strike: 90, contracts: -1 })];
    const hedgeEvents = [option({ expiry: '20260909', strike: 120 })];
    const f = linkedFixture({ ratio: 1, openOptions: L.computeLedger(hedgeEvents).openOptions,
        marketInputs: snapshot(hedgeEvents, { throughExpiry: '20260910' }) });
    f.events = own;
    Object.assign(f.options, { throughExpiry: '20260910', targetInstant: '2026-09-10T20:00:00Z',
        longOptionInputs: snapshot(own, { throughExpiry: '20260910' }) });
    const p = middle(run(f));
    near(p.settlementCashPaid, 11000); near(p.settlementCashReceived, 9000);
    near(p.settlementCashNet, -2000); near(p.shares, 200);
    near(p.linkedSettlementCash, 2000);
});
test('screen case: nineteen short puts require 135600 delivery cash and leave 2700 shares', () => {
    const own = [{ ...stock, shares: 800, cashAmount: -57600, price: 72 },
        ...[[70, -2], [71, -9], [72, -7], [73, -1]].map(([strike, contracts], i) =>
            option({ seq: i + 2, expiry: '20260909', strike, contracts, price: 1 }))];
    const f = setup(own, { centerPrice: 43.218, throughExpiry: '20260909',
        targetInstant: '2026-09-09T20:00:00Z', longOptionInputs: null });
    const p = middle(run(f));
    near(p.settlementCashPaid, 135600); near(p.settlementCashReceived, 0); near(p.shares, 2700);
    near(p.shortOptionLiability, 135600 - 1900 * 43.218);
    assert.equal(p.snapshotChangePnl, null);
});
test('research profile classification never treats old custom parameters as current defaults', () => {
    const profile = M.IV_RESEARCH_PROFILE;
    assert.equal(M.ivResearchProfileStatus(profile.settings, profile.version).kind, 'research');
    assert.equal(M.ivResearchProfileStatus(profile.settings, null).needsReview, true);
    const custom = { ...profile.settings, ivTenorDays: 40, ivTenorExponent: 0.25 };
    assert.equal(M.ivResearchProfileStatus(custom, profile.version).kind, 'custom');
    assert.equal(custom.ivTenorExponent, 0.25);
    assert.equal(M.ivResearchProfileStatus({ ...profile.settings, ivMode: 'none' }, profile.version).kind, 'none');
});

module.exports = { name: 'cost basis stress kernel v2', tests };
