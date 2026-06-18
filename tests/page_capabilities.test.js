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
        {
            name: 'iv term header keeps IB status inside the socket chip',
            run() {
                const html = fs.readFileSync(path.join(PROJECT_ROOT, 'iv_term_structure.html'), 'utf8');
                const socketStart = html.indexOf('ivts-header-chip ivts-header-chip-socket');
                const socketEnd = html.indexOf('<main>');
                const socketRegion = socketStart >= 0 && socketEnd > socketStart
                    ? html.slice(socketStart, socketEnd)
                    : '';

                assert.ok(socketRegion, 'socket chip should exist');
                assert.match(socketRegion, /id="ivtsIbStatus"/);
                assert.match(socketRegion, /id="ivtsIbConnectButton"/);
                assert.doesNotMatch(html, /ivts-header-chip-action/);
                assert.match(html, /ivts-header-chip-config/);
            },
        },
    ],
};
