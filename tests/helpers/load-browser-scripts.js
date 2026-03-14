const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBrowserScripts(relativePaths) {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const context = vm.createContext({
        console,
        Math,
        Date,
        Intl,
        setTimeout,
        clearTimeout,
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
        'market_holidays.js',
        'bsm.js',
    ]);
}

module.exports = {
    loadBrowserScripts,
    loadPricingContext,
};
