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
                assert.equal(profile.calendarId, 'NYSE');
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
                assert.equal(profile.calendarId, 'CME:ES');
                assert.equal(profile.underlyingLegMultiplier, 50);
                assert.equal(profile.settlementUnitsPerContract, 1);
                assert.equal(profile.supportsAmortizedMode, false);
                assert.equal(profile.supportsLegacyLiveData, true);
                assert.equal(profile.supportsUnderlyingLegs, true);
            },
        },
        {
            name: 'resolves CL and SI as live-enabled futures-option families',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;
                const profile = registry.resolveUnderlyingProfile('CL');

                assert.equal(profile.optionSecType, 'FOP');
                assert.equal(profile.underlyingSecType, 'FUT');
                assert.equal(profile.optionExchange, 'NYMEX');
                assert.equal(profile.underlyingExchange, 'NYMEX');
                assert.equal(profile.optionMultiplier, 1000);
                assert.equal(profile.calendarId, 'NYMEX:CL');
                assert.equal(profile.tradingClass, 'ML3');
                assert.equal(profile.supportsLegacyLiveData, true);
                assert.equal(profile.supportsUnderlyingLegs, true);

                const siProfile = registry.resolveUnderlyingProfile('SI');
                assert.equal(siProfile.optionSecType, 'FOP');
                assert.equal(siProfile.underlyingSecType, 'FUT');
                assert.equal(siProfile.optionExchange, 'COMEX');
                assert.equal(siProfile.underlyingExchange, 'COMEX');
                assert.equal(siProfile.optionMultiplier, 5000);
                assert.equal(siProfile.calendarId, 'COMEX:SI');
                assert.equal(siProfile.tradingClass, 'S3T');
            },
        },
        {
            name: 'resolves MES and MNQ as micro futures-option families',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;

                const profileMes = registry.resolveUnderlyingProfile('MES');
                assert.equal(profileMes.optionSecType, 'FOP');
                assert.equal(profileMes.underlyingSecType, 'FUT');
                assert.equal(profileMes.optionExchange, 'CME');
                assert.equal(profileMes.underlyingExchange, 'CME');
                assert.equal(profileMes.optionMultiplier, 5);
                assert.equal(profileMes.underlyingLegMultiplier, 5);
                assert.equal(profileMes.settlementUnitsPerContract, 1);
                assert.equal(profileMes.supportsAmortizedMode, false);
                assert.equal(profileMes.supportsLegacyLiveData, true);
                assert.equal(profileMes.supportsUnderlyingLegs, true);

                const profileMnq = registry.resolveUnderlyingProfile('MNQ');
                assert.equal(profileMnq.optionSecType, 'FOP');
                assert.equal(profileMnq.underlyingSecType, 'FUT');
                assert.equal(profileMnq.optionExchange, 'CME');
                assert.equal(profileMnq.underlyingExchange, 'CME');
                assert.equal(profileMnq.optionMultiplier, 2);
                assert.equal(profileMnq.underlyingLegMultiplier, 2);
                assert.equal(profileMnq.settlementUnitsPerContract, 1);
                assert.equal(profileMnq.supportsAmortizedMode, false);
                assert.equal(profileMnq.supportsLegacyLiveData, true);
                assert.equal(profileMnq.supportsUnderlyingLegs, true);
            },
        },
        {
            name: 'leaves ES and NQ FOP trading classes to IB qualification',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;

                assert.equal(registry.resolveTradingClass('ES', '2026-03-16'), null);
                assert.equal(registry.resolveTradingClass('ES', '2026-03-18'), null);
                assert.equal(registry.resolveTradingClass('NQ', '2026-03-17'), null);
                assert.equal(registry.resolveTradingClass('NQ', '2026-03-19'), null);
                assert.equal(registry.resolveTradingClass('ES', '2026-07-17'), null);
                assert.equal(registry.resolveOptionContractSpec('ES', '2026-07-17').tradingClass, null);
                assert.equal(registry.resolveOptionContractSpec('ES', '2026-07-22').tradingClass, null);
            },
        },
        {
            name: 'does not synthesize unverified MES and MNQ weekly trading classes',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;

                assert.equal(registry.resolveTradingClass('MES', '2026-03-16'), null);
                assert.equal(registry.resolveTradingClass('MNQ', '2026-03-19'), null);
                assert.equal(registry.resolveOptionContractSpec('MES', '2026-03-16').tradingClass, null);
                assert.equal(registry.resolveOptionContractSpec('MNQ', '2026-03-19').tradingClass, null);
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
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('MES', '2026-03-15'), '202603');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('MES', '2026-03-21'), '202606');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('MNQ', '2026-09-10'), '202609');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('CL', '2026-03-15'), '202604');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('CL', '2026-03-23'), '202605');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('SI', '2026-06-01'), '202607');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('SI', '2026-06-27'), '202609');
                assert.equal(registry.resolveDefaultUnderlyingContractMonth('SI', '2026-11-25'), '202703');
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
                assert.equal(registry.getComboPriceIncrement('ES'), 0.01);
                assert.equal(registry.getComboPriceIncrement('MES'), 0.01);
                assert.equal(registry.getComboPriceIncrement('MNQ'), 0.01);
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
                assert.equal(registry.resolvePricingInputMode('MES'), 'FOP');
                assert.equal(registry.resolvePricingInputMode('MNQ'), 'FOP');
                assert.equal(registry.usesForwardRateSamples('NDX'), true);
                assert.equal(registry.usesFuturesPool('HG'), true);
                assert.equal(registry.usesFuturesPool('MES'), true);
                assert.equal(registry.usesFuturesPool('MNQ'), true);
            },
        },
        {
            name: 'routes discount, Forward and carry independently by product family',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;

                const es = registry.resolveForwardCarryPolicy('ES');
                assert.equal(es.currency, 'USD');
                assert.equal(es.discountCurveCurrency, 'USD');
                assert.equal(es.forwardSource, 'bound-futures-quote');
                assert.equal(es.carrySource, 'exchange-futures-curve');
                assert.equal(es.carrySemantics, 'equity-index-net-carry');
                assert.equal(es.carryReference.symbol, 'SPX');
                assert.equal(es.requiresPerLegForwardBinding, true);
                assert.equal(es.rateMaySubstituteForCarry, false);

                const nq = registry.resolveForwardCarryPolicy('MNQ');
                assert.equal(nq.carryReference.symbol, 'NDX');

                const spx = registry.resolveForwardCarryPolicy('SPX');
                assert.equal(spx.forwardSource, 'option-put-call-parity');
                assert.equal(spx.carrySource, 'option-put-call-parity-vs-spot');
                assert.equal(spx.rateMaySubstituteForCarry, false);

                ['CL', 'HG'].forEach((symbol) => {
                    const policy = registry.resolveForwardCarryPolicy(symbol);
                    assert.equal(policy.carrySemantics, 'commodity-futures-curve');
                    assert.equal(policy.carryReference, null);
                    assert.equal(policy.rateMaySubstituteForCarry, false);
                });
                ['GC', 'SI'].forEach((symbol) => {
                    const policy = registry.resolveForwardCarryPolicy(symbol);
                    assert.equal(policy.carrySemantics, 'metal-futures-curve');
                    assert.equal(policy.carryReference, null);
                    assert.equal(policy.rateMaySubstituteForCarry, false);
                });

                const spy = registry.resolveForwardCarryPolicy('SPY');
                assert.equal(spy.carrySemantics, 'bsm-q-zero-model-fallback');
                assert.equal(spy.rateMaySubstituteForCarry, true);
            },
        },
        {
            name: 'exposes per-family near-ATM strike increments with $1 generic equities',
            run() {
                const ctx = loadBrowserScripts(PRODUCT_REGISTRY_CONTEXT_FILES);
                const registry = ctx.OptionComboProductRegistry;
                assert.equal(registry.resolveUnderlyingProfile('ES').strikeIncrement, 5);
                assert.equal(registry.resolveUnderlyingProfile('NQ').strikeIncrement, 10);
                assert.equal(registry.resolveUnderlyingProfile('CL').strikeIncrement, 0.5);
                assert.equal(registry.resolveUnderlyingProfile('SI').strikeIncrement, 0.25);
                assert.equal(registry.resolveUnderlyingProfile('SPX').strikeIncrement, 5);
                assert.equal(registry.resolveUnderlyingProfile('QQQ').strikeIncrement, 1);
                assert.equal(registry.resolveUnderlyingProfile('SPY').strikeIncrement, 1);
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
                assert.equal(registry.isDeferredSettlementOption('SPX', '2026-06-17'), true);

                spec = registry.resolveOptionContractSpec('SPX', '2026-06-18');
                assert.equal(spec.symbol, 'SPXW');
                assert.equal(spec.tradingClass, 'SPXW');
                assert.equal(registry.isDeferredSettlementOption('SPX', '2026-06-18'), false);

                spec = registry.resolveOptionContractSpec('SPX', '2026-04-16');
                assert.equal(spec.symbol, 'SPX');
                assert.equal(spec.tradingClass, 'SPX');
                // Qualified identity is authoritative when it is present.
                assert.equal(registry.isDeferredSettlementOption(
                    'SPX', '2026-04-16', { tradingClass: 'SPXW' }
                ), false);
                assert.equal(registry.isDeferredSettlementOption(
                    'ES', '2026-09-18', { tradingClass: 'ES' }
                ), true);
                assert.equal(registry.isDeferredSettlementOption(
                    'ES', '2026-09-18', { tradingClass: 'EW3' }
                ), false);
                assert.equal(registry.isDeferredSettlementOption(
                    'MES', '2026-09-18', { tradingClass: 'MES' }
                ), true);
            },
        },
    ],
};
