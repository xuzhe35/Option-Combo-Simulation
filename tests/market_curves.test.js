const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const NOW = Date.parse('2026-07-10T16:00:00Z');

function loadApi() {
    return loadBrowserScripts(['js/market_curves.js']).OptionComboMarketCurves;
}

function close(actual, expected, tolerance = 1e-12) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

const suite = {
    name: 'market_curves.js',
    tests: [
        {
            name: 'resolves discount points by exact expiry and exact tenor',
            run() {
                const api = loadApi();
                const curve = api.createDiscountCurve({
                    id: 'usd-treasury',
                    asOf: '2026-07-10',
                    source: 'US_TREASURY',
                    quoteAsOf: '2026-07-10T15:00:00Z',
                    quality: { status: 'good' },
                    points: [
                        { expiry: '2026-08-09', zeroRate: 0.04 },
                        { expiry: '2026-09-08', zeroRate: 0.042 },
                    ],
                });

                const byExpiry = api.resolveDiscount(curve, '2026-08-09', { now: NOW });
                const byTenor = api.resolveDiscount(curve, 60, { now: NOW });

                assert.equal(byExpiry.kind, 'discount');
                assert.equal(byExpiry.resolution.method, 'exact_expiry');
                assert.equal(byExpiry.zeroRate, 0.04);
                close(byExpiry.discountFactor, Math.exp(-0.04 * 30 / 365));
                assert.equal(byExpiry.metadata.source, 'US_TREASURY');
                assert.equal(byExpiry.metadata.quality.status, 'good');
                assert.equal(byTenor.resolution.method, 'exact_tenor');
                assert.equal(byTenor.zeroRate, 0.042);
            },
        },
        {
            name: 'builds a discount zero rate from a supplied discount factor',
            run() {
                const api = loadApi();
                const factor = Math.exp(-0.035 * 90 / 365);
                const curve = api.createDiscountCurve({
                    asOf: '2026-07-10',
                    points: [{ tenorDays: 90, discountFactor: factor }],
                });
                const point = api.resolveDiscount(curve, { tenorDays: 90 }, { now: NOW });
                close(point.zeroRate, 0.035);
                close(point.discountFactor, factor);
            },
        },
        {
            name: 'uses bounded rate interpolation and refuses oversized gaps',
            run() {
                const api = loadApi();
                const curve = api.createDiscountCurve({
                    asOf: '2026-07-10',
                    maxInterpolationGapDays: 100,
                    points: [
                        { tenorDays: 30, zeroRate: 0.03 },
                        { tenorDays: 90, zeroRate: 0.05 },
                    ],
                });

                const middle = api.resolveDiscount(curve, 60, { now: NOW });
                assert.equal(middle.resolution.method, 'interpolated');
                const expectedDiscount = Math.sqrt(
                    Math.exp(-0.03 * 30 / 365) * Math.exp(-0.05 * 90 / 365)
                );
                close(middle.discountFactor, expectedDiscount);
                close(middle.zeroRate, -Math.log(expectedDiscount) / (60 / 365));
                assert.equal(curve.interpolation, 'log_discount_factor');
                assert.ok(middle.metadata.quality.flags.includes('interpolated'));
                assert.equal(api.resolveDiscount(curve, 60, {
                    now: NOW,
                    maxInterpolationGapDays: 40,
                }), null);
                assert.equal(api.resolveDiscount(curve, 10, { now: NOW }), null);
            },
        },
        {
            name: 'adapts native continuous Treasury zero rates without changing semantics',
            run() {
                const api = loadApi();
                const curve = api.createDiscountCurveFromTreasurySnapshot({
                    effectiveDate: '2026-07-10',
                    source: 'treasury:test',
                    quoteAsOf: '2026-07-10T15:00:00Z',
                    curveSemantics: 'continuous_zero',
                    points: [
                        { tenorCode: '1M', tenorDays: 30, continuousRate: 0.04 },
                        { tenorCode: '3M', tenorDays: 90, rate: 0.042 },
                    ],
                });

                assert.equal(curve.isProxy, false);
                assert.equal(curve.discountSemantics, 'continuous_zero');
                assert.equal(curve.points[0].tenorCode, '1M');
                assert.equal(curve.points[0].proxy, false);
                assert.equal(api.resolveDiscount(curve, 30, { now: NOW }).zeroRate, 0.04);
                assert.equal(api.resolveDiscount(curve, 90, { now: NOW }).zeroRate, 0.042);
                [0, 7, 14].forEach((dte) => {
                    const shortEnd = api.resolveDiscount(curve, dte, { now: NOW });
                    assert.ok(shortEnd, `expected a Treasury short-end proxy at ${dte} DTE`);
                    assert.equal(shortEnd.resolution.method, 'extrapolated_flat');
                    assert.equal(shortEnd.zeroRate, 0.04);
                    close(shortEnd.discountFactor, Math.exp(-0.04 * dte / 365));
                });
                assert.equal(curve.maxExtrapolationDays, 31);
                assert.equal(api.resolveDiscount(curve, 122, { now: NOW }), null);
            },
        },
        {
            name: 'marks Treasury CMT par-yield conversion as a degraded discount proxy',
            run() {
                const api = loadApi();
                const parYield = 0.05;
                const curve = api.createDiscountCurveFromTreasurySnapshot({
                    effectiveDate: '2026-07-10',
                    source: 'treasury:daily_treasury_par_yield_curve',
                    curveSemantics: 'cmt_par_yield',
                    quality: { status: 'good' },
                    points: [{ tenorCode: '3M', tenorDays: 90, rate: parYield }],
                });
                const resolved = api.resolveDiscount(curve, 90, { now: NOW });
                const proxyRate = 2 * Math.log(1 + parYield / 2);

                assert.equal(curve.isProxy, true);
                assert.equal(curve.discountSemantics, 'continuous_zero_proxy_from_cmt_par_yield');
                assert.equal(curve.points[0].proxy, true);
                assert.equal(curve.metadata.quality.status, 'degraded');
                close(resolved.zeroRate, proxyRate);
                assert.equal(resolved.metadata.quality.status, 'degraded');
                assert.ok(resolved.metadata.quality.flags.includes('cmt_par_yield_proxy'));
                assert.ok(resolved.metadata.quality.flags.includes('not_bootstrapped_zero_curve'));
                assert.throws(() => api.createDiscountCurveFromTreasurySnapshot({
                    effectiveDate: '2026-07-10',
                    points: [{ tenorDays: 30, rate: 0.04 }],
                }), /requires explicit curveSemantics/);
            },
        },
        {
            name: 'preserves proxy semantics from the real Treasury provider snapshot shape',
            run() {
                const api = loadApi();
                const parYield = 0.04;
                const converted = 2 * Math.log(1 + parYield / 2);
                const curve = api.createDiscountCurveFromTreasurySnapshot({
                    schemaVersion: 1,
                    kind: 'treasury_discount_curve',
                    snapshotId: 'treasury:2026-07-17:test',
                    requestedDate: '2026-07-19',
                    effectiveDate: '2026-07-17',
                    quoteAsOf: '2026-07-17T19:30:00Z',
                    source: 'treasury:daily_treasury_yield_curve',
                    curveSemantics: {
                        curveType: 'us_treasury_nominal_par_yield_curve',
                        officialCurve: true,
                        officialZeroCouponCurve: false,
                        inputQuoteConvention: 'bond_equivalent_yield_semiannual',
                        discountingMethod: 'par_yield_as_zero_proxy',
                        discountRateSemantics: 'continuous_zero_proxy_from_cmt_par_yield',
                        discountingIsApproximate: true,
                    },
                    inputSemantics: 'cmt_par_yield',
                    discountRateSemantics: 'continuous_zero_proxy_from_cmt_par_yield',
                    quality: {
                        status: 'degraded',
                        flags: ['cmt_par_yield_proxy', 'not_bootstrapped_zero_curve'],
                    },
                    points: [{
                        tenorCode: '1m',
                        tenorDays: 30,
                        parYield,
                        rate: parYield,
                        continuousRate: converted,
                        continuousRateIsProxy: true,
                        inputSemantics: 'cmt_par_yield',
                    }],
                }, { asOf: '2026-07-19' });
                const resolved = api.resolveDiscount(curve, 30, {
                    now: Date.parse('2026-07-19T16:00:00Z'),
                });

                assert.equal(curve.isProxy, true);
                assert.equal(curve.sourceSemantics, 'cmt_par_yield');
                assert.equal(curve.discountSemantics, 'continuous_zero_proxy_from_cmt_par_yield');
                assert.equal(curve.metadata.quality.status, 'degraded');
                assert.equal(curve.points[0].continuousRateIsProxy, true);
                assert.equal(curve.points[0].inputSemantics, 'cmt_par_yield');
                assert.equal(curve.points[0].inputParYield, parYield);
                // The backend already converted this value. It must not be
                // converted a second time or relabelled as a native zero.
                close(curve.points[0].zeroRate, converted);
                close(resolved.zeroRate, converted);
                assert.ok(resolved.metadata.quality.flags.includes('cmt_par_yield_proxy'));
            },
        },
        {
            name: 'adapts the canonical hybrid discount snapshot without losing D(T) or provenance',
            run() {
                const api = loadApi();
                const rate = 0.04;
                const d30 = Math.exp(-rate * 30 / 365);
                const d31 = Math.exp(-0.0401 * 31 / 365);
                const curve = api.createDiscountCurveFromSnapshot({
                    schemaVersion: 2,
                    kind: 'hybrid_discount_curve',
                    curveId: 'usd-reference-discount',
                    snapshotId: 'usd-reference:test',
                    curveAsOf: '2026-07-19',
                    effectiveDate: '2026-07-16',
                    availableAsOf: '2026-07-19T12:00:00Z',
                    source: 'nyfed:sofr+treasury:daily_treasury_yield_curve',
                    curveSemantics: {
                        canonicalValue: 'discount_factor',
                        discountingIsApproximate: true,
                        discountRateSemantics: 'sofr_short_end_treasury_cmt_forward_slope_proxy',
                    },
                    policy: { shortEndMaxDays: 30 },
                    sources: {
                        sofr: { effectiveDate: '2026-07-16', rate: 0.04 },
                        treasury: { effectiveDate: '2026-07-17' },
                    },
                    quality: { status: 'degraded', flags: ['reference_curve_is_proxy'] },
                    points: [
                        {
                            tenorDays: 30,
                            discountFactor: d30,
                            zeroRate: rate,
                            source: 'nyfed:sofr',
                            sourceEffectiveDate: '2026-07-16',
                            proxy: true,
                        },
                        {
                            tenorDays: 31,
                            discountFactor: d31,
                            zeroRate: 0.0401,
                            source: 'hybrid:nyfed_sofr+treasury_cmt',
                            sourceEffectiveDate: '2026-07-16',
                            proxy: true,
                        },
                    ],
                });

                assert.equal(curve.asOf, '2026-07-19');
                assert.equal(curve.effectiveDate, '2026-07-16');
                assert.equal(curve.isProxy, true);
                assert.equal(curve.policy.shortEndMaxDays, 30);
                assert.equal(curve.sources.treasury.effectiveDate, '2026-07-17');
                const exact = api.resolveDiscount(curve, 30, { now: NOW });
                close(exact.discountFactor, d30);
                assert.equal(exact.metadata.source, 'nyfed:sofr');
                assert.equal(exact.metadata.sourceEffectiveDate, '2026-07-16');
                assert.equal(exact.metadata.snapshotId, 'usd-reference:test');
            },
        },
        {
            name: 'supports explicit bounded flat extrapolation without enabling it by default',
            run() {
                const api = loadApi();
                const curve = api.createDiscountCurve({
                    asOf: '2026-07-10',
                    maxExtrapolationDays: 10,
                    points: [{ tenorDays: 30, zeroRate: 0.04 }],
                });
                const shortEnd = api.resolveDiscount(curve, 20, { now: NOW });
                assert.equal(shortEnd.resolution.method, 'extrapolated_flat');
                close(shortEnd.discountFactor, Math.exp(-0.04 * 20 / 365));
                assert.ok(shortEnd.metadata.quality.flags.includes('extrapolated'));
                assert.equal(api.resolveDiscount(curve, 19, { now: NOW }), null);
            },
        },
        {
            name: 'interpolates positive forwards in log space and carry rates linearly',
            run() {
                const api = loadApi();
                const forwardCurve = api.createForwardCurve({
                    asOf: '2026-07-10',
                    points: [
                        { tenorDays: 30, forward: 100 },
                        { tenorDays: 90, forward: 121 },
                    ],
                });
                const carryCurve = api.createCarryCurve({
                    asOf: '2026-07-10',
                    points: [
                        { tenorDays: 30, carryRate: 0.01 },
                        { tenorDays: 90, carryRate: 0.03 },
                    ],
                });
                const forward = api.resolveForward(forwardCurve, 60, { now: NOW });
                const carry = api.resolveCarry(carryCurve, 60, { now: NOW });
                close(forward.forward, 110);
                close(carry.carryRate, 0.02);
            },
        },
        {
            name: 'propagates conservative source freshness and quality metadata',
            run() {
                const api = loadApi();
                const curve = api.createCarryCurve({
                    asOf: '2026-07-10',
                    points: [
                        {
                            tenorDays: 30,
                            carryRate: 0.01,
                            source: 'option_parity',
                            quoteAsOf: '2026-07-10T15:58:00Z',
                            snapshotId: 'one',
                            quality: { status: 'good', score: 0.95 },
                        },
                        {
                            tenorDays: 90,
                            carryRate: 0.03,
                            source: 'futures_basis',
                            quoteAsOf: '2026-07-10T15:59:00Z',
                            snapshotId: 'two',
                            quality: { status: 'degraded', flags: ['wide_spread'], score: 0.7 },
                        },
                    ],
                });
                const result = api.resolveCarry(curve, 60, {
                    now: NOW,
                    staleAfterMs: 90 * 1000,
                });

                assert.equal(result.metadata.source, 'mixed');
                assert.deepEqual([...result.metadata.sources], ['option_parity', 'futures_basis']);
                assert.equal(result.metadata.quoteAsOf, '2026-07-10T15:58:00.000Z');
                assert.equal(result.metadata.quoteAsOfLatest, '2026-07-10T15:59:00.000Z');
                assert.equal(result.metadata.quoteSkewMs, 60 * 1000);
                assert.equal(result.metadata.stale, true);
                assert.equal(result.metadata.quality.status, 'degraded');
                assert.equal(result.metadata.quality.score, 0.7);
                assert.ok(result.metadata.quality.flags.includes('mixed_sources'));
                assert.ok(result.metadata.quality.flags.includes('mixed_snapshots'));
                assert.ok(result.metadata.quality.flags.includes('stale_quote'));
                assert.equal(result.usable, false);
            },
        },
        {
            name: 'converts spot/carry/forward consistently with continuous compounding',
            run() {
                const api = loadApi();
                const forward = api.forwardFromSpotCarry({
                    spot: 6000,
                    carryRate: 0.025,
                    tenorDays: 180,
                });
                const carry = api.carryFromSpotForward({
                    spot: 6000,
                    forward,
                    tenorDays: 180,
                });
                close(carry, 0.025);
            },
        },
        {
            name: 'derives a parity forward only from a discount factor or discount observation',
            run() {
                const api = loadApi();
                const discountCurve = api.createDiscountCurve({
                    asOf: '2026-07-10',
                    points: [{ tenorDays: 30, zeroRate: 0.04 }],
                });
                const discount = api.resolveDiscount(discountCurve, 30, { now: NOW });
                const expected = 6000 + (125 - 120) / discount.discountFactor;
                close(api.forwardFromPutCallParity({
                    strike: 6000,
                    callPrice: 125,
                    putPrice: 120,
                    discount,
                }), expected);
                close(api.forwardFromPutCallParity({
                    strike: 6000,
                    callPrice: 125,
                    putPrice: 120,
                    discountFactor: discount.discountFactor,
                }), expected);
            },
        },
        {
            name: 'rejects carry as discount and all other curve kind substitutions',
            run() {
                const api = loadApi();
                const carryCurve = api.createCarryCurve({
                    asOf: '2026-07-10',
                    points: [{ tenorDays: 30, carryRate: 0.02 }],
                });
                const carry = api.resolveCarry(carryCurve, 30, { now: NOW });

                assert.throws(
                    () => api.resolveDiscount(carryCurve, 30),
                    /curve kind mismatch: expected discount, received carry/
                );
                assert.throws(
                    () => api.forwardFromPutCallParity({
                        strike: 6000,
                        callPrice: 125,
                        putPrice: 120,
                        discount: carry,
                    }),
                    /discount kind mismatch: expected discount, received carry/
                );
                assert.throws(
                    () => api.forwardFromSpotCarry({ spot: 6000, carry: {
                        kind: 'discount', discountFactor: 0.99,
                    }, tenorDays: 30 }),
                    /carry kind mismatch/
                );
            },
        },
        {
            name: 'resolves a curve set and derives the missing carry without confusing discount r',
            run() {
                const api = loadApi();
                const discountCurve = api.createDiscountCurve({
                    asOf: '2026-07-10',
                    points: [{ tenorDays: 30, zeroRate: 0.05 }],
                });
                const forwardCurve = api.createForwardCurve({
                    asOf: '2026-07-10',
                    points: [{ tenorDays: 30, forward: 6010 }],
                });
                const curveSet = api.createCurveSet({
                    asOf: '2026-07-10',
                    marketKey: 'SPX',
                    spot: 6000,
                    discountCurve,
                    forwardCurve,
                });
                const resolved = api.resolveCurveSet(curveSet, 30, { now: NOW });

                assert.equal(resolved.discount.zeroRate, 0.05);
                close(resolved.carry.carryRate, Math.log(6010 / 6000) / (30 / 365));
                assert.notEqual(resolved.discount.zeroRate, resolved.carry.carryRate);
                assert.equal(resolved.carry.resolution.method, 'derived_from_spot_forward');
            },
        },
    ],
};

module.exports = suite;

if (require.main === module) {
    let passed = 0;
    (async () => {
        for (const testCase of suite.tests) {
            await testCase.run();
            passed += 1;
            console.log(`ok - ${testCase.name}`);
        }
        console.log(`${passed} passed`);
    })().catch((error) => {
        console.error(error.stack || error);
        process.exitCode = 1;
    });
}
