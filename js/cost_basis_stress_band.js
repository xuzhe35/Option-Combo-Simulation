/* A sampled, whole-portfolio sensitivity envelope — never a confidence interval. */
(function (g) {
    'use strict';
    const VERSION = 'sensitivity-grid-v1';
    function members(compiled, options = {}) {
        const driver = compiled.linked || compiled.opts.ivDriver || { ivMode: 'none' };
        const beta = driver.ivMode === 'beta';
        const scales = beta ? [0.8, 0.9, 1, 1.1, 1.25] : [1];
        const exponents = beta && driver.ivTenorDamping ? [0.5, 0.65, 0.76] : [undefined];
        const floors = beta && driver.ivOtmDiscount ? [0.35, 0.5, 0.65] : [undefined];
        const result = [{}]; // Actual user center, even outside the suggested ranges.
        for (const betaScale of scales) for (const tenorExponent of exponents) for (const otmFloor of floors) {
            result.push({ betaScale, tenorExponent, otmFloor });
        }
        if (options.includeFlatIv !== false) result.push({ flatIv: true });
        // A separate level sensitivity also covers flat/rising price points.
        // This is an explicit user assumption, not a calibrated coverage band.
        const range = Number(options.ivRangePct ?? 0);
        if (!Number.isFinite(range) || range < 0 || range > 50) throw new Error('invalid_iv_range');
        if (range > 0) for (const ivScale of [1 - range / 100, 1 + range / 100]) {
            result.push({ ivScale });
            if (beta) result.push({ ivScale, betaScale: ivScale < 1 ? 0.8 : 1.25,
                tenorExponent: driver.ivTenorDamping ? (ivScale < 1 ? 0.76 : 0.5) : undefined,
                otmFloor: driver.ivOtmDiscount ? (ivScale < 1 ? 0.35 : 0.65) : undefined });
        }
        return result;
    }
    function calculate(compiled, options = {}, suppliedCenter) {
        const core = g.OptionComboCostBasisStressCore;
        const center = suppliedCenter || core.sweep(compiled);
        if (!center.available) return { available: false, reason: center.reason, version: VERSION };
        const grid = members(compiled, options);
        const points = center.points.map(p => ({ price: p.price, lower: p.headlinePnl, upper: p.headlinePnl,
            lowerMember: 0, upperMember: 0 }));
        for (let index = 1; index < grid.length; index++) {
            const member = core.sweep(compiled, grid[index]);
            if (!member.available || member.points.length !== points.length) {
                return { available: false, reason: member.reason || 'invalid_band_member', failedMember: grid[index], version: VERSION };
            }
            for (let j = 0; j < points.length; j++) {
                const value = member.points[j].headlinePnl;
                if (!Number.isFinite(value) || member.points[j].price !== points[j].price) {
                    return { available: false, reason: 'invalid_band_value', version: VERSION };
                }
                if (value < points[j].lower) Object.assign(points[j], { lower: value, lowerMember: index });
                if (value > points[j].upper) Object.assign(points[j], { upper: value, upperMember: index });
            }
        }
        return { available: true, version: VERSION, label: '采样情景范围（非置信区间）',
            continuousExtremaGuaranteed: false, probabilistic: false, members: grid, points };
    }
    g.OptionComboCostBasisStressBand = Object.freeze({ VERSION, members, calculate });
})(typeof globalThis !== 'undefined' ? globalThis : this);
