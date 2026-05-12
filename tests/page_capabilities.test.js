const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const PROJECT_ROOT = path.resolve(__dirname, '..');

module.exports = {
    name: 'page_capabilities.js',
    tests: [
        {
            name: 'resolves default portfolio capabilities from body dataset',
            run() {
                const ctx = loadBrowserScripts(
                    ['js/page_capabilities.js'],
                    {
                        document: {
                            body: {
                                dataset: {
                                    optionComboPage: 'portfolio',
                                },
                            },
                        },
                    }
                );

                const capabilities = ctx.OptionComboPageCapabilities.resolveCapabilities();
                assert.equal(capabilities.pageKind, 'portfolio');
                assert.equal(capabilities.deltaHedgePanel, true);
                assert.equal(capabilities.chartLabTabs, false);
            },
        },
        {
            name: 'resolves chart lab capabilities from page kind override',
            run() {
                const ctx = loadBrowserScripts(
                    ['js/page_capabilities.js'],
                    {
                        OPTION_COMBO_PAGE_KIND: 'chart-lab',
                        document: {
                            body: {
                                dataset: {},
                            },
                        },
                    }
                );

                assert.equal(ctx.OptionComboPageCapabilities.getPageKind(), 'chart-lab');
                assert.equal(ctx.OptionComboPageCapabilities.hasFeature('deltaHedgePanel'), false);
                assert.equal(ctx.OptionComboPageCapabilities.hasFeature('chartLabProjection'), true);
            },
        },
        {
            name: 'html entry points declare explicit page kind and shared capability script',
            run() {
                const indexHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'index.html'), 'utf8');
                const chartLabHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'chart_lab.html'), 'utf8');

                assert.match(indexHtml, /<body[^>]*data-option-combo-page="portfolio"/i);
                assert.match(chartLabHtml, /<body[^>]*data-option-combo-page="chart-lab"/i);
                assert.match(indexHtml, /<script src="js\/page_capabilities\.js"><\/script>/i);
                assert.match(chartLabHtml, /<script src="js\/page_capabilities\.js"><\/script>/i);
            },
        },
    ],
};
