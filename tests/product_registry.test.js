const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const PRODUCT_REGISTRY_CONTEXT_FILES = [
    'js/market_holidays.js',
    'js/date_utils.js',
    'js/product_registry.js',
];

module.exports = {
    name: 'product_registry.js',
    tests: [
        {
            name: 'resolves default equity symbols to stock-style option settings',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
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
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');

                assert.equal(profile.optionSecType, 'FOP');
                assert.equal(profile.underlyingSecType, 'FUT');
                assert.equal(profile.optionMultiplier, 50);
                assert.equal(profile.underlyingLegMultiplier, 50);
                assert.equal(profile.settlementUnitsPerContract, 1);
                assert.equal(profile.supportsAmortizedMode, false);
                assert.equal(profile.supportsLegacyLiveData, true);
                assert.equal(profile.supportsUnderlyingLegs, true);
            },
        },
        {
            name: 'resolves CL as a live-enabled futures-option family',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('CL');

                assert.equal(profile.optionSecType, 'FOP');
                assert.equal(profile.underlyingSecType, 'FUT');
                assert.equal(profile.optionExchange, 'NYMEX');
                assert.equal(profile.underlyingExchange, 'NYMEX');
                assert.equal(profile.optionMultiplier, 1000);
                assert.equal(profile.tradingClass, 'ML3');
                assert.equal(profile.supportsLegacyLiveData, true);
                assert.equal(profile.supportsUnderlyingLegs, true);
            },
        },
        {
            name: 'resolves ES and NQ weekly FOP trading classes from expiry weekday',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
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
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;

                assert.equal(registry.resolveDefaultUnderlyingContractMonth('ES', '2026-03-15'), '202603');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('ES', '2026-03-21'), '202606');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('NQ', '2026-09-10'), '202609');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('CL', '2026-03-15'), '202604');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('CL', '2026-03-23'), '202605');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('SPY', '2026-03-15'), '');
            },
        },
        {
            name: 'resolves SPX aliases to the same index-option family',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('SPXW');

                assert.equal(profile.family, 'SPX');
                assert.equal(profile.optionSymbol, 'SPXW');
                assert.equal(profile.underlyingSymbol, 'SPX');
                assert.equal(profile.underlyingSecType, 'IND');
                assert.equal(profile.underlyingExchange, 'CBOE');
                assert.equal(profile.settlementKind, 'cash-settled');
                assert.equal(profile.supportsLegacyLiveData, true);
            },
        },
        {
            name: 'returns product-aware underlying leg labels and multipliers',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;

                assert.equal(registry.getUnderlyingLegLabel('SPY'), 'Underlying (Equity)');
                assert.equal(registry.getUnderlyingLegLabel('ES'), 'Underlying (Future)');
                assert.equal(registry.getUnderlyingLegMultiplier('SPY'), 1);
                assert.equal(registry.getUnderlyingLegMultiplier('NQ'), 20);
                assert.equal(registry.isUnderlyingLeg({ type: 'stock' }), true);
                assert.equal(registry.isOptionLeg({ type: 'put' }), true);
            },
        },
        {
            name: 'returns product-aware price precision helpers for small-price futures families',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;

                assert.equal(registry.getPriceDisplayDecimals('SPY'), 2);
                assert.equal(registry.getPriceDisplayDecimals('HG'), 5);
                assert.equal(registry.getPriceInputStep('HG'), '0.00001');
                assert.equal(registry.getComboPriceIncrement('SPY'), 0.01);
                assert.equal(registry.getComboPriceIncrement('HG'), 0.0005);
                assert.equal(registry.formatPriceInputValue('HG', 4.35789), '4.35789');
                assert.equal(registry.formatPriceDisplay('HG', 4.35789), '$4.35789');
            },
        },
        {
            name: 'classifies pricing-input modes for stock, index, and futures-option families',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;

                assert.equal(registry.resolvePricingInputMode('SPY'), 'STK');
                assert.equal(registry.resolvePricingInputMode('SPX'), 'INDEX');
                assert.equal(registry.resolvePricingInputMode('CL'), 'FOP');
                assert.equal(registry.usesForwardRateSamples('NDX'), true);
                assert.equal(registry.usesFuturesPool('HG'), true);
            },
        },
        {
            name: 'resolves SPX monthly and weekly contract identity from last trading date',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;
                let spec = registry.resolveOptionContractSpec('SPX', '2026-06-17');
                assert.equal(spec.symbol, 'SPX');
                assert.equal(spec.tradingClass, 'SPX');

                spec = registry.resolveOptionContractSpec('SPX', '2026-06-18');
                assert.equal(spec.symbol, 'SPXW');
                assert.equal(spec.tradingClass, 'SPXW');

                spec = registry.resolveOptionContractSpec('SPX', '2026-04-16');
                assert.equal(spec.symbol, 'SPX');
                assert.equal(spec.tradingClass, 'SPX');
            },
        },
    ],
};
