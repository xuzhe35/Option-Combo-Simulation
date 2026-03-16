const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'product_registry.js',
    tests: [
        {
            name: 'resolves default equity symbols to stock-style option settings',
            run() {
                const ctx = loadBrowserScripts(['js/product_registry.js']);
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('SPY');

                assert.equal(profile.optionSecType, 'OPT');
                assert.equal(profile.underlyingSecType, 'STK');
                assert.equal(profile.optionMultiplier, 100);
                assert.equal(profile.supportsAmortizedMode, true);
                assert.equal(profile.supportsLegacyLiveData, true);
                assert.equal(profile.supportsUnderlyingLegs, true);
            },
        },
        {
            name: 'resolves ES as a futures-option family with non-equity settings',
            run() {
                const ctx = loadBrowserScripts(['js/product_registry.js']);
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');

                assert.equal(profile.optionSecType, 'FOP');
                assert.equal(profile.underlyingSecType, 'FUT');
                assert.equal(profile.optionMultiplier, 50);
                assert.equal(profile.settlementUnitsPerContract, 1);
                assert.equal(profile.supportsAmortizedMode, false);
                assert.equal(profile.supportsLegacyLiveData, true);
                assert.equal(profile.supportsUnderlyingLegs, false);
            },
        },
        {
            name: 'resolves ES and NQ weekly FOP trading classes from expiry weekday',
            run() {
                const ctx = loadBrowserScripts(['js/product_registry.js']);
                const registry = ctx.OptionComboProductRegistry;

                assert.equal(registry.resolveTradingClass('ES', '2026-03-16'), 'E3A');
                assert.equal(registry.resolveTradingClass('ES', '2026-03-18'), 'E3C');
                assert.equal(registry.resolveTradingClass('NQ', '2026-03-17'), 'Q3B');
                assert.equal(registry.resolveTradingClass('NQ', '2026-03-19'), 'Q3D');
            },
        },
        {
            name: 'resolves default underlying futures month for ES and NQ families',
            run() {
                const ctx = loadBrowserScripts(['js/product_registry.js']);
                const registry = ctx.OptionComboProductRegistry;

                assert.equal(registry.resolveDefaultUnderlyingContractMonth('ES', '2026-03-15'), '202603');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('ES', '2026-03-21'), '202606');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('NQ', '2026-09-10'), '202609');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('SPY', '2026-03-15'), '');
            },
        },
        {
            name: 'resolves SPX aliases to the same index-option family',
            run() {
                const ctx = loadBrowserScripts(['js/product_registry.js']);
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('SPXW');

                assert.equal(profile.family, 'SPX');
                assert.equal(profile.optionSymbol, 'SPXW');
                assert.equal(profile.underlyingSymbol, 'SPX');
                assert.equal(profile.underlyingSecType, 'IND');
                assert.equal(profile.settlementKind, 'cash-settled');
                assert.equal(profile.supportsLegacyLiveData, true);
            },
        },
    ],
};
