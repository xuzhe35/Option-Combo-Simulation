const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBrowserScripts(relativePaths, overrides = {}) {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const context = vm.createContext({
        console,
        Math,
        Date,
        Intl,
        setTimeout,
        clearTimeout,
        ...overrides,
    });

    context.window = context;
    context.global = context;
    context.globalThis = context;

    for (const relativePath of relativePaths) {
        const fullPath = path.join(projectRoot, relativePath);
        const code = fs.readFileSync(fullPath, 'utf8');
        const script = new vm.Script(code, { filename: fullPath });
        script.runInContext(context);
    }

    return context;
}

function loadPricingContext() {
    return loadBrowserScripts([
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
        'js/pricing_core.js',
        'js/bsm.js',
    ]);
}

function loadAmortizedContext() {
    return loadBrowserScripts([
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
        'js/pricing_core.js',
        'js/amortized.js',
    ]);
}

function loadValuationContext() {
    return loadBrowserScripts([
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
        'js/pricing_core.js',
        'js/amortized.js',
        'js/valuation.js',
    ]);
}

function loadSessionLogicContext() {
    return loadBrowserScripts([
        'js/session_logic.js',
    ]);
}

function loadSessionUIContext(overrides = {}) {
    return loadBrowserScripts([
        'js/session_ui.js',
    ], overrides);
}

module.exports = {
    loadBrowserScripts,
    loadPricingContext,
    loadAmortizedContext,
    loadValuationContext,
    loadSessionLogicContext,
    loadSessionUIContext,
};
