const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'session_ui.js',
    tests: [
        {
            name: 'synchronizes control panel values from imported session state',
            run() {
                const elements = {
                    workspaceBanner: { hidden: true, style: {}, className: '' },
                    workspaceBannerBadge: { textContent: '' },
                    workspaceBannerTitle: { textContent: '' },
                    workspaceBannerBody: { textContent: '' },
                    appTitle: { textContent: '' },
                    appSubtitle: { textContent: '' },
                    marketDataMode: { value: '' },
                    marketDataModeHint: { textContent: '' },
                    historicalQuoteDateGroup: { hidden: true, style: {} },
                    historicalQuoteDateLabel: { textContent: '' },
                    historicalQuoteDate: { value: '' },
                    historicalQuoteDateHint: { textContent: '' },
                    historicalReplayDateGroup: { hidden: true, style: {} },
                    historicalReplayDateLabel: { textContent: '' },
                    historicalReplayDate: { value: '' },
                    historicalReplayStartLabel: { textContent: '' },
                    historicalReplayDaysDisplay: { textContent: '' },
                    historicalReplaySlider: { value: '' },
                    historicalTimelineControls: { hidden: true, style: {} },
                    historicalTimelineHint: { textContent: '' },
                    simulatedDateLabel: { textContent: '' },
                    simulatedDateStartLabel: { textContent: '' },
                    simulatedDateHint: { textContent: '', hidden: true },
                    simulatedDateOffsetGroup: { style: {} },
                    underlyingSymbol: { value: '' },
                    underlyingContractMonth: { value: '', placeholder: '', disabled: false },
                    underlyingContractMonthHint: { textContent: '' },
                    underlyingPrice: { value: '', step: '' },
                    underlyingPriceSlider: { value: '', step: '' },
                    underlyingPriceDisplay: { textContent: '' },
                    simulatedDate: { value: '', min: '', max: '' },
                    daysPassedSlider: { value: '' },
                    daysPassedDisplay: { textContent: '' },
                    interestRate: { value: '' },
                    interestRateDisplay: { textContent: '' },
                    ivOffset: { value: '' },
                    ivOffsetSlider: { value: '' },
                    ivOffsetDisplay: { textContent: '' },
                    allowLiveComboOrders: { checked: false },
                };

                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/session_ui.js',
                ], {
                    document: {
                        title: '',
                        getElementById(id) {
                            return elements[id];
                        },
                    },
                });

                const currencyFormatter = new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                });

                ctx.OptionComboSessionUI.syncControlPanel(
                    {
                        underlyingSymbol: 'QQQ',
                        underlyingContractMonth: '',
                        underlyingPrice: 512.34,
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-20',
                        marketDataMode: 'historical',
                        workspaceVariant: 'historical',
                        marketDataModeLocked: true,
                        historicalQuoteDate: '2026-03-07',
                        historicalAvailableEndDate: '2026-03-31',
                        interestRate: 0.0375,
                        ivOffset: 0.0125,
                        allowLiveComboOrders: true,
                    },
                    currencyFormatter,
                    {
                        diffDays(fromDate, toDate) {
                            if (fromDate === '2026-03-01' && toDate === '2026-03-07') {
                                return 6;
                            }
                            if (fromDate === '2026-03-01' && toDate === '2026-03-20') {
                                return 19;
                            }
                            return 0;
                        },
                        calendarToTradingDays(fromDate, toDate) {
                            if (fromDate === '2026-03-01' && toDate === '2026-03-07') {
                                return 4;
                            }
                            if (fromDate === '2026-03-01' && toDate === '2026-03-20') {
                                return 14;
                            }
                            return 0;
                        },
                    }
                );

                assert.equal(elements.marketDataMode.value, 'historical');
                assert.equal(elements.marketDataMode.disabled, true);
                assert.match(elements.marketDataModeHint.textContent, /locked to SQLite replay only/i);
                assert.equal(elements.historicalQuoteDateGroup.hidden, false);
                assert.equal(elements.historicalQuoteDate.value, '2026-03-01');
                assert.equal(elements.historicalReplayDateGroup.hidden, false);
                assert.equal(elements.historicalReplayDate.value, '2026-03-07');
                assert.equal(elements.historicalTimelineControls.hidden, false);
                assert.equal(elements.historicalReplayDaysDisplay.textContent, '+4 td / +6 cd');
                assert.equal(elements.simulatedDateLabel.textContent, 'Simulation Date');
                assert.equal(elements.simulatedDateStartLabel.textContent, 'Start');
                assert.equal(elements.simulatedDateHint.hidden, false);
                assert.equal(elements.simulatedDateOffsetGroup.style.display, 'none');
                assert.equal(elements.appTitle.textContent, 'Historical Replay Workspace');
                assert.match(elements.appSubtitle.textContent, /SQLite-backed historical replay/i);
                assert.equal(elements.workspaceBanner.hidden, false);
                assert.match(elements.workspaceBanner.className, /workspace-banner-historical/);
                assert.equal(elements.workspaceBannerBadge.textContent, 'Historical Only');
                assert.equal(elements.workspaceBannerTitle.textContent, 'Historical Replay Workspace');
                assert.match(elements.workspaceBannerBody.textContent, /does not route orders to IBKR\/TWS/i);
                assert.equal(elements.underlyingSymbol.value, 'QQQ');
                assert.equal(elements.underlyingContractMonth.value, '');
                assert.equal(elements.underlyingContractMonth.disabled, true);
                assert.equal(elements.underlyingPrice.value, '512.34');
                assert.equal(elements.underlyingPrice.step, '0.01');
                assert.equal(elements.underlyingPriceSlider.value, 512.34);
                assert.equal(elements.underlyingPriceSlider.step, '0.01');
                assert.equal(elements.underlyingPriceDisplay.textContent, '$512.34');
                assert.equal(elements.simulatedDate.min, '2026-03-07');
                assert.equal(elements.simulatedDate.max, '');
                assert.equal(elements.simulatedDate.value, '2026-03-20');
                assert.equal(elements.daysPassedSlider.value, 19);
                assert.equal(elements.daysPassedDisplay.textContent, '+14 td / +19 cd');
                assert.equal(elements.interestRate.value, '3.75');
                assert.equal(elements.interestRateDisplay.textContent, '3.75%');
                assert.equal(elements.ivOffset.value, '1.25');
                assert.equal(elements.ivOffsetSlider.value, 1.25);
                assert.equal(elements.ivOffsetDisplay.textContent, '+1.25%');
                assert.equal(elements.allowLiveComboOrders.checked, false);
                assert.equal(elements.allowLiveComboOrders.disabled, true);
                assert.equal(ctx.document.title, 'QQQ Mar20');
            },
        },
        {
            name: 'prefers imported json filename for document title and strips extension',
            run() {
                const ctx = loadBrowserScripts([
                    'js/session_ui.js',
                ]);

                assert.equal(
                    ctx.OptionComboSessionUI.resolveDocumentTitle({
                        importedSessionTitle: 'SPY Mar27.json',
                        underlyingSymbol: 'QQQ',
                        simulatedDate: '2026-03-20',
                    }),
                    'SPY Mar27'
                );

                assert.equal(
                    ctx.OptionComboSessionUI.resolveDocumentTitle({
                        importedSessionTitle: 'Iron Condor Setup',
                        underlyingSymbol: 'QQQ',
                        simulatedDate: '2026-03-20',
                    }),
                    'Iron Condor Setup'
                );
            },
        },
        {
            name: 'uses product-aware underlying price precision for copper futures sessions',
            run() {
                const elements = {
                    workspaceBanner: { hidden: true, style: {}, className: '' },
                    workspaceBannerBadge: { textContent: '' },
                    workspaceBannerTitle: { textContent: '' },
                    workspaceBannerBody: { textContent: '' },
                    appTitle: { textContent: '' },
                    appSubtitle: { textContent: '' },
                    marketDataMode: { value: '' },
                    marketDataModeHint: { textContent: '' },
                    historicalQuoteDateGroup: { hidden: true, style: {} },
                    historicalQuoteDateLabel: { textContent: '' },
                    historicalQuoteDate: { value: '' },
                    historicalQuoteDateHint: { textContent: '' },
                    historicalReplayDateGroup: { hidden: true, style: {} },
                    historicalReplayDateLabel: { textContent: '' },
                    historicalReplayDate: { value: '' },
                    historicalReplayStartLabel: { textContent: '' },
                    historicalReplayDaysDisplay: { textContent: '' },
                    historicalReplaySlider: { value: '' },
                    historicalTimelineControls: { hidden: true, style: {} },
                    historicalTimelineHint: { textContent: '' },
                    simulatedDateLabel: { textContent: '' },
                    simulatedDateStartLabel: { textContent: '' },
                    simulatedDateHint: { textContent: '', hidden: true },
                    simulatedDateOffsetGroup: { style: {} },
                    underlyingSymbol: { value: '' },
                    underlyingContractMonth: { value: '', placeholder: '', disabled: false },
                    underlyingContractMonthHint: { textContent: '' },
                    underlyingPrice: { value: '', step: '' },
                    underlyingPriceSlider: { value: '', step: '' },
                    underlyingPriceDisplay: { textContent: '' },
                    simulatedDate: { value: '', min: '', max: '' },
                    daysPassedSlider: { value: '' },
                    daysPassedDisplay: { textContent: '' },
                    interestRate: { value: '' },
                    interestRateDisplay: { textContent: '' },
                    ivOffset: { value: '' },
                    ivOffsetSlider: { value: '' },
                    ivOffsetDisplay: { textContent: '' },
                    allowLiveComboOrders: { checked: false },
                };

                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/session_ui.js',
                ], {
                    document: {
                        title: '',
                        getElementById(id) {
                            return elements[id];
                        },
                    },
                });

                const currencyFormatter = new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                });

                ctx.OptionComboSessionUI.syncControlPanel(
                    {
                        underlyingSymbol: 'HG',
                        underlyingContractMonth: '202605',
                        underlyingPrice: 4.35789,
                        baseDate: '2026-04-02',
                        simulatedDate: '2026-04-02',
                        marketDataMode: 'live',
                        workspaceVariant: 'live',
                        marketDataModeLocked: false,
                        historicalQuoteDate: '',
                        historicalAvailableEndDate: '',
                        interestRate: 0.03,
                        ivOffset: 0,
                        allowLiveComboOrders: false,
                    },
                    currencyFormatter,
                    {
                        diffDays() { return 0; },
                        calendarToTradingDays() { return 0; },
                    }
                );

                assert.equal(elements.underlyingPrice.value, '4.35789');
                assert.equal(elements.underlyingPrice.step, '0.00001');
                assert.equal(elements.underlyingPriceSlider.step, '0.00001');
                assert.equal(elements.underlyingPriceDisplay.textContent, '$4.35789');
            },
        },
    ],
};
