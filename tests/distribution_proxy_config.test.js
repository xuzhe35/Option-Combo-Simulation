const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'distribution_proxy_config.js',
    tests: [
        {
            name: 'maps futures and index families to configured probability proxies',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/distribution_proxy_config.js',
                ]);

                const profileEs = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('ES');
                const profileNq = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('NQ');
                const profileGc = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('GC');

                assert.equal(
                    ctx.OptionComboDistributionProxyConfig.resolveDistributionSymbol('ES', profileEs),
                    'SPY'
                );
                assert.equal(
                    ctx.OptionComboDistributionProxyConfig.resolveDistributionSymbol('NQ', profileNq),
                    'QQQ'
                );
                assert.equal(
                    ctx.OptionComboDistributionProxyConfig.resolveDistributionSymbol('GC', profileGc),
                    'GLD'
                );
            },
        },
        {
            name: 'falls back to the entered symbol when no proxy is configured',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/distribution_proxy_config.js',
                ]);

                const profile = ctx.OptionComboProductRegistry.resolveUnderlyingProfile('AAPL');
                assert.equal(
                    ctx.OptionComboDistributionProxyConfig.resolveDistributionSymbol('AAPL', profile),
                    'AAPL'
                );
            },
        },
    ],
};
