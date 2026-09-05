#!/usr/bin/env node
// Native JS benchmark: distinct contracts, not contract quantity. No broker/DB I/O.
for (const script of ['cost_basis_core', 'american_binomial', 'market_curves',
    'cost_basis_stress_models', 'cost_basis_stress_core', 'cost_basis_stress_band']) require(`../js/${script}.js`);
const K = globalThis.OptionComboCostBasisStressCore;
const M = globalThis.OptionComboCostBasisStressModels;
const L = globalThis.OptionComboCostBasisCore;
const B = globalThis.OptionComboCostBasisStressBand;
const asOf = '2026-09-08T16:00:00Z';
function book(offset) {
    return Array.from({ length: 27 }, (_, i) => ({ seq: i + 1, kind: 'option_trade', account: 'U1',
        tradeDate: '2026-01-01', expiry: i % 2 ? '20270309' : '20270909',
        conId: offset + i, right: i % 3 ? 'P' : 'C', strike: 80 + i * 1.5,
        sharesPerContract: 100, contracts: 1, price: 5, cashAmount: -500 }));
}
function inputs(events) {
    return { throughExpiry: '20260928', fetchedAt: asOf, currency: 'USD', underlyingPrice: 100,
        options: events.map(p => ({ ...p, multiplier: 100, impliedVolatility: 0.3,
            mark: M.priceScenarioOption(p.right, 100, p.strike,
                (K.exchangeTime(p.expiry) - Date.parse(asOf)) / (365 * 86400000), 0.04, 0.3,
                {pricingModel: 'american', dividendYield: 0.01}) })),
        ratesByExpiry: ['20270309', '20270909'].map(expiry => ({expiry, zeroRate: 0.04})) };
}
const own = book(1), linked = book(101);
const options = { centerPrice: 100, throughExpiry: '20260928', horizonDays: 20,
    asOfInstant: asOf, pointCount: 61, includeDeferredLongOptions: true,
    pricingModel: 'american', dividendYield: 0.01, longOptionInputs: inputs(own),
    linkedHedge: { symbol: 'QQQ', currency: 'USD', ratio: 3, basePrice: 100,
        openOptions: L.computeLedger(linked).openOptions, marketInputs: inputs(linked),
        ivMode: 'beta', ivBetaAuto: true, ivTenorDamping: true, ivTenorDays: 30,
        ivTenorExponent: 0.65, ivOtmDiscount: true, sigma: 0.3, dividendYield: 0.01 } };
const start = performance.now();
const compiled = K.compile(own, options);
const compiledAt = performance.now();
const center = K.sweep(compiled);
const centerAt = performance.now();
const band = B.calculate(compiled, {}, center);
const end = performance.now();
console.log(JSON.stringify({distinctContracts: 54, scanPoints: 61,
    compileMs: compiledAt - start, centerMs: centerAt - compiledAt, bandMs: end - centerAt,
    members: band.members && band.members.length, available: band.available,
    reason: band.reason || compiled.reason || center.reason || ''}, null, 2));
if (!band.available) process.exitCode = 1;
