const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'ws_client.js',
    tests: [
        {
            name: 'applies portfolio price updates to matching legs and limits avg cost syncing to opted-in groups',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    simulatedDate: '2026-03-16',
                    baseDate: '2026-03-16',
                    groups: [
                        {
                            id: 'group_trial',
                            viewMode: 'trial',
                            syncAvgCostFromPortfolio: true,
                            legs: [
                                { id: 'leg_call', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 0 },
                            ],
                        },
                        {
                            id: 'group_off',
                            viewMode: 'trial',
                            syncAvgCostFromPortfolio: false,
                            legs: [
                                { id: 'leg_call_off', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 0 },
                            ],
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyPortfolioAvgCostUpdate({
                    action: 'portfolio_avg_cost_update',
                    items: [
                        {
                            secType: 'OPT',
                            symbol: 'SPY',
                            expDate: '20260402',
                            right: 'C',
                            strike: 670,
                            position: 1,
                            avgCostPerUnit: 10.31,
                            marketPrice: 10.62,
                            unrealizedPNL: 31,
                        },
                    ],
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].legs[0].cost, 10.31);
                assert.equal(state.groups[1].legs[0].cost, 0);
                assert.equal(state.groups[0].legs[0].portfolioMarketPrice, 10.62);
                assert.equal(state.groups[0].legs[0].portfolioMarketPriceSource, 'tws_portfolio');
                assert.equal(state.groups[1].legs[0].portfolioMarketPrice, 10.62);
                assert.equal(state.groups[1].legs[0].portfolioMarketPriceSource, 'tws_portfolio');
                assert.equal(state.groups[0].legs[0].portfolioUnrealizedPnl, 31);
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 0);
            },
        },
        {
            name: 'preserves signed live option delta in quote snapshots',
            run() {
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    groups: [],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    options: {
                        leg_put: {
                            bid: 2.1,
                            ask: 2.3,
                            mark: 2.2,
                            delta: -0.382145,
                        },
                    },
                });

                const snapshot = ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_put');
                assert.equal(snapshot.bid, 2.1);
                assert.equal(snapshot.ask, 2.3);
                assert.equal(snapshot.mark, 2.2);
                assert.equal(snapshot.delta, -0.382145);
            },
        },
        {
            name: 'routes delta-only option updates through lightweight group delta refresh',
            run() {
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 610,
                    simulatedDate: '2026-03-16',
                    baseDate: '2026-03-16',
                    groups: [
                        {
                            id: 'group_delta_only',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_put',
                                    type: 'put',
                                    pos: 1,
                                    strike: 600,
                                    expDate: '2026-04-17',
                                    iv: 0.2,
                                    ivSource: 'live',
                                    currentPrice: 2.2,
                                    currentPriceSource: 'live',
                                    cost: 2.2,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const derivedRefreshes = [];
                const deltaRefreshes = [];
                let fullRefreshCalls = 0;

                const ctx = loadBrowserScripts(
                    [
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {
                            fullRefreshCalls += 1;
                        },
                        updateLiveQuoteDerivedValues(changeSet) {
                            derivedRefreshes.push(changeSet);
                        },
                        updateLiveQuoteGroupDeltaValues(changeSet) {
                            deltaRefreshes.push(changeSet);
                        },
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    options: {
                        leg_put: {
                            bid: 2.1,
                            ask: 2.3,
                            mark: 2.2,
                            iv: 0.2,
                            delta: -0.35,
                        },
                    },
                });

                assert.equal(fullRefreshCalls, 0);
                assert.equal(derivedRefreshes.length, 1);
                assert.deepEqual(Array.from(derivedRefreshes[0].groupIds), ['group_delta_only']);
                assert.deepEqual(Array.from(derivedRefreshes[0].hedgeIds), []);
                assert.equal(deltaRefreshes.length, 0);

                ctx.processLiveMarketData({
                    options: {
                        leg_put: {
                            bid: 2.1,
                            ask: 2.3,
                            mark: 2.2,
                            iv: 0.2,
                            delta: -0.37,
                        },
                    },
                });

                assert.equal(fullRefreshCalls, 0);
                assert.equal(derivedRefreshes.length, 1);
                assert.equal(deltaRefreshes.length, 1);
                assert.deepEqual(Array.from(deltaRefreshes[0].groupIds), ['group_delta_only']);

                const snapshot = ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_put');
                assert.equal(snapshot.delta, -0.37);
            },
        },
        {
            name: 'ignores option delta when greeks are disabled',
            run() {
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: false,
                    groups: [],
                    hedges: [],
                };

                let fullRefreshCalls = 0;
                let deltaRefreshCalls = 0;

                const ctx = loadBrowserScripts(
                    [
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {
                            fullRefreshCalls += 1;
                        },
                        updateLiveQuoteDerivedValues() {
                            throw new Error('delta-disabled path should not trigger pricing refreshes');
                        },
                        updateLiveQuoteGroupDeltaValues() {
                            deltaRefreshCalls += 1;
                        },
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    options: {
                        leg_put: {
                            bid: 2.1,
                            ask: 2.3,
                            mark: 2.2,
                            delta: -0.382145,
                        },
                    },
                });

                const snapshot = ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_put');
                assert.equal(snapshot.bid, 2.1);
                assert.equal(snapshot.ask, 2.3);
                assert.equal(snapshot.mark, 2.2);
                assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'delta'), false);
                assert.equal(fullRefreshCalls, 0);
                assert.equal(deltaRefreshCalls, 0);
            },
        },
        {
            name: 'builds CL live subscriptions with FUT underlying and FOP option payloads',
            run() {
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingContractMonth: '',
                    underlyingPrice: 72.5,
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    greeksEnabled: false,
                    futuresPool: [
                        { id: 'future_jul', contractMonth: '202607' },
                    ],
                    groups: [
                        {
                            id: 'group_cl',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_cl_call',
                                    type: 'call',
                                    pos: 1,
                                    strike: 75,
                                    expDate: '2026-04-20',
                                    underlyingFutureId: 'future_jul',
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) {
                        this.sent.push(message);
                    }

                    close() {}
                }

                const ctx = loadBrowserScripts(
                    [
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        location: {
                            protocol: 'file:',
                            hostname: '',
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();

                const firstMessage = JSON.parse(MockWebSocket.instance.sent[0]);
                assert.equal(firstMessage.action, 'subscribe');
                assert.equal(firstMessage.greeksEnabled, false);
                assert.equal(firstMessage.underlying.secType, 'FUT');
                assert.equal(firstMessage.underlying.symbol, 'CL');
                assert.equal(firstMessage.underlying.exchange, 'NYMEX');
                assert.equal(firstMessage.underlying.contractMonth, '202607');
                assert.equal(firstMessage.underlying.multiplier, '1000');
                assert.equal(firstMessage.options.length, 1);
                assert.equal(firstMessage.futures.length, 1);
                assert.equal(firstMessage.futures[0].contractMonth, '202607');
                assert.equal(firstMessage.options[0].secType, 'FOP');
                assert.equal(firstMessage.options[0].symbol, 'CL');
                assert.equal(firstMessage.options[0].exchange, 'NYMEX');
                assert.equal(firstMessage.options[0].tradingClass, 'ML3');
                assert.equal(firstMessage.options[0].underlyingContractMonth, '202607');
                const secondMessage = JSON.parse(MockWebSocket.instance.sent[1]);
                assert.equal(secondMessage.action, 'request_portfolio_avg_cost_snapshot');
                const thirdMessage = JSON.parse(MockWebSocket.instance.sent[2]);
                assert.equal(thirdMessage.action, 'request_managed_accounts_snapshot');
            },
        },
        {
            name: 'applies managed account snapshots and auto-selects the only available account',
            run() {
                const state = {
                    marketDataMode: 'live',
                    liveComboOrderAccounts: [],
                    liveComboOrderAccountsConnected: false,
                    selectedLiveComboOrderAccount: '',
                    groups: [],
                    hedges: [],
                };

                let refreshCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        OptionComboControlPanelUI: {
                            refreshBoundDynamicControls() {
                                refreshCalls += 1;
                            },
                        },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._handleManagedAccountsMessage({
                    action: 'managed_accounts_update',
                    ibConnected: true,
                    accounts: ['F1234567'],
                });

                assert.equal(handled, true);
                assert.deepEqual(state.liveComboOrderAccounts, ['F1234567']);
                assert.equal(state.liveComboOrderAccountsConnected, true);
                assert.equal(state.selectedLiveComboOrderAccount, 'F1234567');
                assert.equal(refreshCalls, 1);
            },
        },
        {
            name: 'builds historical replay snapshot requests for selected SPY option legs',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-07',
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    underlyingPrice: 510,
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    groups: [
                        {
                            id: 'group_spy',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_spy_call',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025/04/17',
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) {
                        this.sent.push(message);
                    }

                    close() {}
                }

                const ctx = loadBrowserScripts(
                    [
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        location: {
                            protocol: 'file:',
                            hostname: '',
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();

                const firstMessage = JSON.parse(MockWebSocket.instance.sent[0]);
                assert.equal(firstMessage.action, 'request_historical_snapshot');
                assert.equal(firstMessage.replayDate, '2025-04-07');
                assert.equal(firstMessage.underlying.symbol, 'SPY');
                assert.equal(firstMessage.options.length, 1);
                assert.equal(firstMessage.options[0].symbol, 'SPY');
                assert.equal(firstMessage.options[0].expDate, '20250417');
                assert.equal(firstMessage.stocks.length, 0);
                assert.equal(MockWebSocket.instance.sent.length, 1);
            },
        },
        {
            name: 'blocks live submit requests until a TWS order account is selected',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 512.25,
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    allowLiveComboOrders: true,
                    liveComboOrderAccounts: ['DU111111', 'F222222'],
                    liveComboOrderAccountsConnected: true,
                    selectedLiveComboOrderAccount: '',
                    groups: [
                        {
                            id: 'group_live_submit',
                            liveData: true,
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                condition: 'gte',
                                price: 512,
                                executionMode: 'submit',
                                pendingRequest: false,
                                status: 'armed',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                {
                                    id: 'leg_live_submit',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2026-04-17',
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) {
                        this.sent.push(message);
                    }

                    close() {}
                }

                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/group_order_builder.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        location: {
                            protocol: 'file:',
                            hostname: '',
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();
                MockWebSocket.instance.sent.length = 0;

                ctx._requestTrialGroupComboOrder(state.groups[0]);

                assert.equal(MockWebSocket.instance.sent.length, 1);
                assert.equal(JSON.parse(MockWebSocket.instance.sent[0]).action, 'request_managed_accounts_snapshot');
                assert.match(state.groups[0].tradeTrigger.lastError, /select a tws account/i);
                assert.equal(state.groups[0].tradeTrigger.pendingRequest, false);
            },
        },
        {
            name: 'promotes a filled trial group into active mode after avg cost sync completes',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    groups: [
                        {
                            id: 'group_live_fill',
                            viewMode: 'trial',
                            syncAvgCostFromPortfolio: true,
                            tradeTrigger: {
                                lastPreview: {
                                    status: 'Filled',
                                    executionMode: 'submit',
                                },
                            },
                            legs: [
                                { id: 'leg_call', type: 'call', pos: 1, strike: 673, expDate: '2026-04-02', cost: 0 },
                                { id: 'leg_call_short', type: 'call', pos: -1, strike: 677, expDate: '2026-04-02', cost: 0 },
                            ],
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx._applyPortfolioAvgCostUpdate({
                    action: 'portfolio_avg_cost_update',
                    items: [
                        { secType: 'OPT', symbol: 'SPY', expDate: '20260402', right: 'C', strike: 673, position: 1, avgCostPerUnit: 9.68 },
                        { secType: 'OPT', symbol: 'SPY', expDate: '20260402', right: 'C', strike: 677, position: -1, avgCostPerUnit: 7.41 },
                    ],
                });

                assert.equal(state.groups[0].viewMode, 'active');
                assert.equal(state.groups[0].legs[0].cost, 9.68);
                assert.equal(state.groups[0].legs[1].cost, 7.41);
            },
        },
        {
            name: 'marks missing historical option quotes explicitly instead of keeping them usable',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-07',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 510,
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    groups: [
                        {
                            id: 'group_hist',
                            liveData: true,
                            viewMode: 'trial',
                            legs: [
                                {
                                    id: 'leg_missing',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025-04-17',
                                    currentPrice: 6.5,
                                    currentPriceSource: 'historical',
                                    iv: 0.24,
                                    ivSource: 'historical',
                                    ivManualOverride: false,
                                    cost: 0,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let updateCalls = 0;
                let refreshCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        currencyFormatter: new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                        }),
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        OptionComboControlPanelUI: {
                            refreshBoundDynamicControls() {
                                refreshCalls += 1;
                            },
                        },
                        document: {
                            getElementById(id) {
                                if (id === 'underlyingPrice') return { value: '' };
                                if (id === 'underlyingPriceSlider') return { value: '' };
                                if (id === 'underlyingPriceDisplay') return { textContent: '' };
                                return null;
                            },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 512.25,
                    underlyingQuote: { mark: 512.25, bid: 512.25, ask: 512.25 },
                    riskFreeRate: 0.0542,
                    options: {
                        leg_missing: { missing: true },
                    },
                    historicalReplay: {
                        requestedDate: '2025-04-07',
                        effectiveDate: '2025-04-07',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-07',
                    },
                });

                assert.equal(state.groups[0].legs[0].currentPriceSource, 'missing');
                assert.equal(state.groups[0].legs[0].ivSource, 'missing');
                assert.equal(state.historicalQuoteDate, '2025-04-07');
                assert.equal(state.simulatedDate, '2026-03-17');
                assert.equal(state.baseDate, '2025-04-07');
                assert.equal(state.interestRate, 0.0542);
                assert.equal(refreshCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'attaches expiry-day underlying anchors to expired historical option legs',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2023-02-07',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 415.19,
                    simulatedDate: '2023-02-07',
                    baseDate: '2023-01-03',
                    groups: [
                        {
                            id: 'group_hist_expired_anchor',
                            liveData: true,
                            viewMode: 'trial',
                            legs: [
                                {
                                    id: 'leg_hist_expired_anchor',
                                    type: 'call',
                                    pos: 1,
                                    strike: 381,
                                    expDate: '2023/01/27',
                                    currentPrice: 0,
                                    currentPriceSource: '',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        currencyFormatter: new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                        }),
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        OptionComboControlPanelUI: {
                            refreshBoundDynamicControls() {},
                        },
                        document: {
                            getElementById(id) {
                                if (id === 'underlyingPrice') return { value: '' };
                                if (id === 'underlyingPriceSlider') return { value: '' };
                                if (id === 'underlyingPriceDisplay') return { textContent: '' };
                                return null;
                            },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 415.19,
                    underlyingQuote: { mark: 415.19, bid: 415.19, ask: 415.19 },
                    options: {
                        leg_hist_expired_anchor: { missing: true },
                    },
                    historicalReplay: {
                        requestedDate: '2023-02-07',
                        effectiveDate: '2023-02-07',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-07',
                        expiryUnderlyingQuotes: {
                            '2023-01-27': {
                                requestedDate: '2023-01-27',
                                effectiveDate: '2023-01-27',
                                price: 402.13,
                                quote: { mark: 402.13 },
                            },
                        },
                    },
                });

                assert.equal(state.groups[0].legs[0].historicalExpiryUnderlyingPrice, 402.13);
                assert.equal(state.groups[0].legs[0].historicalExpiryUnderlyingDate, '2023-01-27');
            },
        },
        {
            name: 'captures base-day historical quotes as entry costs and promotes trial groups to active',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-07',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 510,
                    simulatedDate: '2025-04-07',
                    baseDate: '2025-04-07',
                    groups: [
                        {
                            id: 'group_hist_entry',
                            liveData: true,
                            viewMode: 'trial',
                            legs: [
                                {
                                    id: 'leg_entry',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025-04-17',
                                    currentPrice: 0,
                                    currentPriceSource: '',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                            closeExecution: {},
                        },
                    ],
                    hedges: [],
                };

                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        currencyFormatter: new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                        }),
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        document: {
                            getElementById(id) {
                                if (id === 'underlyingPrice') return { value: '' };
                                if (id === 'underlyingPriceSlider') return { value: '' };
                                if (id === 'underlyingPriceDisplay') return { textContent: '' };
                                return null;
                            },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 512.25,
                    underlyingQuote: { mark: 512.25, bid: 512.25, ask: 512.25 },
                    options: {
                        leg_entry: { mark: 6.5, bid: 6.4, ask: 6.6, iv: 0.24 },
                    },
                    historicalReplay: {
                        requestedDate: '2025-04-07',
                        effectiveDate: '2025-04-07',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-07',
                    },
                });

                assert.equal(state.groups[0].legs[0].currentPrice, 6.5);
                assert.equal(state.groups[0].legs[0].currentPriceSource, 'historical');
                assert.equal(state.groups[0].legs[0].cost, 6.5);
                assert.equal(state.groups[0].legs[0].costSource, 'historical_base');
                assert.equal(state.groups[0].viewMode, 'active');
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'skips historical base-day cost seeding for trigger-armed trial groups',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-07',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 510,
                    simulatedDate: '2025-04-07',
                    baseDate: '2025-04-07',
                    groups: [
                        {
                            id: 'group_hist_trigger_entry',
                            liveData: true,
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                condition: 'gte',
                                price: 600,
                                executionMode: 'preview',
                            },
                            legs: [
                                {
                                    id: 'leg_trigger_entry',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025-04-17',
                                    currentPrice: 0,
                                    currentPriceSource: '',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        currencyFormatter: new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                        }),
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        document: {
                            getElementById(id) {
                                if (id === 'underlyingPrice') return { value: '' };
                                if (id === 'underlyingPriceSlider') return { value: '' };
                                if (id === 'underlyingPriceDisplay') return { textContent: '' };
                                return null;
                            },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 512.25,
                    underlyingQuote: { mark: 512.25, bid: 512.25, ask: 512.25 },
                    options: {
                        leg_trigger_entry: { mark: 6.5, bid: 6.4, ask: 6.6, iv: 0.24 },
                    },
                    historicalReplay: {
                        requestedDate: '2025-04-07',
                        effectiveDate: '2025-04-07',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-07',
                    },
                });

                assert.equal(state.groups[0].legs[0].currentPrice, 6.5);
                assert.equal(state.groups[0].legs[0].cost, 0);
                assert.equal(state.groups[0].legs[0].costSource, undefined);
                assert.equal(state.groups[0].viewMode, 'trial');
                assert.equal(state.groups[0].tradeTrigger.enabled, true);
            },
        },
        {
            name: 'simulates historical trigger previews using the replay-day option quote',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-10',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 500,
                    simulatedDate: '2025-04-10',
                    baseDate: '2025-04-07',
                    groups: [
                        {
                            id: 'group_hist_preview',
                            liveData: true,
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                condition: 'gte',
                                price: 512,
                                executionMode: 'preview',
                            },
                            legs: [
                                {
                                    id: 'leg_hist_preview',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025-04-17',
                                    currentPrice: 1.25,
                                    currentPriceSource: 'historical',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        currencyFormatter: new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                        }),
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        document: {
                            getElementById(id) {
                                if (id === 'underlyingPrice') return { value: '' };
                                if (id === 'underlyingPriceSlider') return { value: '' };
                                if (id === 'underlyingPriceDisplay') return { textContent: '' };
                                return null;
                            },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 512.25,
                    underlyingQuote: { mark: 512.25, bid: 512.25, ask: 512.25 },
                    options: {
                        leg_hist_preview: { mark: 6.5, bid: 6.4, ask: 6.6, iv: 0.24 },
                    },
                    historicalReplay: {
                        requestedDate: '2025-04-10',
                        effectiveDate: '2025-04-10',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-10',
                    },
                });

                assert.equal(state.groups[0].tradeTrigger.enabled, false);
                assert.equal(state.groups[0].tradeTrigger.status, 'previewed');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.pricingSource, 'historical_replay');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.limitPrice, 6.5);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.orderAction, 'BUY');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.legs[0].mark, 6.5);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.orderId, undefined);
            },
        },
        {
            name: 'simulates historical test submits locally and cancels them from exit conditions',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-10',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 500,
                    simulatedDate: '2025-04-10',
                    baseDate: '2025-04-07',
                    allowLiveComboOrders: false,
                    groups: [
                        {
                            id: 'group_hist_submit',
                            liveData: true,
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                condition: 'gte',
                                price: 512,
                                executionMode: 'test_submit',
                                exitEnabled: true,
                                exitCondition: 'lte',
                                exitPrice: 510,
                            },
                            legs: [
                                {
                                    id: 'leg_hist_submit',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025-04-17',
                                    currentPrice: 0,
                                    currentPriceSource: '',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        currencyFormatter: new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                        }),
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        document: {
                            getElementById(id) {
                                if (id === 'underlyingPrice') return { value: '' };
                                if (id === 'underlyingPriceSlider') return { value: '' };
                                if (id === 'underlyingPriceDisplay') return { textContent: '' };
                                return null;
                            },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 512.25,
                    underlyingQuote: { mark: 512.25, bid: 512.25, ask: 512.25 },
                    options: {
                        leg_hist_submit: { mark: 6.5, bid: 6.4, ask: 6.6, iv: 0.24 },
                    },
                    historicalReplay: {
                        requestedDate: '2025-04-10',
                        effectiveDate: '2025-04-10',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-10',
                    },
                });

                assert.equal(state.groups[0].tradeTrigger.status, 'test_submitted');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.status, 'Submitted');
                assert.ok(Number.isInteger(state.groups[0].tradeTrigger.lastPreview.orderId));
                assert.equal(state.groups[0].tradeTrigger.lastPreview.limitPrice, 6.5);
                assert.equal(state.groups[0].legs[0].cost, 0);

                state.historicalQuoteDate = '2025-04-11';
                state.simulatedDate = '2025-04-11';

                ctx.processLiveMarketData({
                    underlyingPrice: 509,
                    underlyingQuote: { mark: 509, bid: 509, ask: 509 },
                    options: {
                        leg_hist_submit: { mark: 5.1, bid: 5.0, ask: 5.2, iv: 0.23 },
                    },
                    historicalReplay: {
                        requestedDate: '2025-04-11',
                        effectiveDate: '2025-04-11',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-11',
                    },
                });

                assert.equal(state.groups[0].tradeTrigger.lastPreview.status, 'Cancelled');
                assert.match(state.groups[0].tradeTrigger.lastPreview.statusMessage, /simulated order cancelled/i);
                assert.equal(state.groups[0].tradeTrigger.status, 'test_submitted');
            },
        },
        {
            name: 'fills historical trigger submits immediately and promotes the group to active',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-10',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 500,
                    simulatedDate: '2025-04-10',
                    baseDate: '2025-04-07',
                    allowLiveComboOrders: false,
                    groups: [
                        {
                            id: 'group_hist_submit_fill',
                            liveData: true,
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                condition: 'gte',
                                price: 512,
                                executionMode: 'submit',
                            },
                            legs: [
                                {
                                    id: 'leg_hist_submit_fill',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025-04-17',
                                    currentPrice: 0,
                                    currentPriceSource: '',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        currencyFormatter: new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                        }),
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        document: {
                            getElementById(id) {
                                if (id === 'underlyingPrice') return { value: '' };
                                if (id === 'underlyingPriceSlider') return { value: '' };
                                if (id === 'underlyingPriceDisplay') return { textContent: '' };
                                return null;
                            },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 512.25,
                    underlyingQuote: { mark: 512.25, bid: 512.25, ask: 512.25 },
                    options: {
                        leg_hist_submit_fill: { mark: 6.5, bid: 6.4, ask: 6.6, iv: 0.24 },
                    },
                    historicalReplay: {
                        requestedDate: '2025-04-10',
                        effectiveDate: '2025-04-10',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-10',
                    },
                });

                assert.equal(state.groups[0].tradeTrigger.status, 'submitted');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.status, 'Filled');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.remaining, 0);
                assert.equal(state.groups[0].legs[0].cost, 6.5);
                assert.equal(state.groups[0].legs[0].costSource, 'execution_report');
                assert.equal(state.groups[0].viewMode, 'active');
            },
        },
        {
            name: 'locks historical replay entry costs on demand from the current replay prices',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-10',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 512.25,
                    simulatedDate: '2025-04-10',
                    baseDate: '2025-04-07',
                    groups: [
                        {
                            id: 'group_hist_manual_entry',
                            liveData: true,
                            viewMode: 'trial',
                            tradeTrigger: {
                                enabled: true,
                                condition: 'gte',
                                price: 600,
                                executionMode: 'preview',
                            },
                            legs: [
                                {
                                    id: 'leg_hist_manual_entry',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025-04-17',
                                    currentPrice: 6.5,
                                    currentPriceSource: 'historical',
                                    iv: 0.24,
                                    ivSource: 'historical',
                                    ivManualOverride: false,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const didEnter = ctx.requestHistoricalReplayEntryGroup(state.groups[0]);

                assert.equal(didEnter, true);
                assert.equal(state.groups[0].legs[0].cost, 6.5);
                assert.equal(state.groups[0].legs[0].costSource, 'historical_replay_entry');
                assert.equal(state.groups[0].legs[0].entryReplayDate, '2025-04-10');
                assert.equal(state.groups[0].tradeTrigger.enabled, false);
                assert.equal(state.groups[0].viewMode, 'active');
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'settles historical close-group requests with replay prices instead of sending orders',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2025-04-10',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 512.25,
                    simulatedDate: '2025-04-10',
                    baseDate: '2025-04-07',
                    groups: [
                        {
                            id: 'group_hist_close',
                            name: 'Replay Close',
                            liveData: true,
                            viewMode: 'active',
                            closeExecution: {
                                executionMode: 'preview',
                            },
                            legs: [
                                {
                                    id: 'leg_close',
                                    type: 'call',
                                    pos: 1,
                                    strike: 510,
                                    expDate: '2025-04-17',
                                    currentPrice: 7.25,
                                    currentPriceSource: 'historical',
                                    iv: 0.24,
                                    ivSource: 'historical',
                                    ivManualOverride: false,
                                    cost: 5.1,
                                    costSource: 'historical_base',
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let updateCalls = 0;
                let renderCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const didSettle = ctx.requestCloseGroupComboOrder(state.groups[0]);

                assert.equal(didSettle, true);
                assert.equal(state.groups[0].legs[0].closePrice, 7.25);
                assert.equal(state.groups[0].viewMode, 'settlement');
                assert.equal(state.groups[0].closeExecution.status, 'submitted');
                assert.equal(state.groups[0].closeExecution.lastPreview.status, 'Filled');
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'auto-settles expired historical legs with locked costs once replay moves past expiry',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2024-08-01',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 543.01,
                    simulatedDate: '2024-08-01',
                    baseDate: '2024-06-03',
                    groups: [
                        {
                            id: 'group_hist_auto_expiry',
                            liveData: true,
                            viewMode: 'trial',
                            legs: [
                                {
                                    id: 'leg_hist_auto_expiry',
                                    type: 'call',
                                    pos: 1,
                                    strike: 527,
                                    expDate: '2024/07/31',
                                    currentPrice: 27.8112,
                                    currentPriceSource: 'historical',
                                    iv: 0.2,
                                    ivSource: 'historical',
                                    ivManualOverride: false,
                                    cost: 27.8112,
                                    costSource: 'historical_base',
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        currencyFormatter: new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                        }),
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        document: {
                            getElementById(id) {
                                if (id === 'underlyingPrice') return { value: '' };
                                if (id === 'underlyingPriceSlider') return { value: '' };
                                if (id === 'underlyingPriceDisplay') return { textContent: '' };
                                return null;
                            },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 543.01,
                    underlyingQuote: { mark: 543.01, bid: 543.01, ask: 543.01 },
                    options: {
                        leg_hist_auto_expiry: { missing: true },
                    },
                    historicalReplay: {
                        requestedDate: '2024-08-01',
                        effectiveDate: '2024-08-01',
                        availableStartDate: '2008-01-02',
                        availableEndDate: '2025-04-07',
                        expiryUnderlyingQuotes: {
                            '2024-07-31': {
                                requestedDate: '2024-07-31',
                                effectiveDate: '2024-07-31',
                                price: 551.23,
                                quote: { mark: 551.23 },
                            },
                        },
                    },
                });

                assert.equal(state.groups[0].legs[0].closePrice, 24.23);
                assert.equal(state.groups[0].legs[0].closePriceSource, 'historical_expiry_auto');
                assert.equal(state.groups[0].viewMode, 'settlement');
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'removes auto-settled expiry closes when historical auto-close is disabled',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2024-08-01',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 543.01,
                    simulatedDate: '2024-08-01',
                    baseDate: '2024-06-03',
                    groups: [
                        {
                            id: 'group_hist_manual_expiry',
                            liveData: true,
                            viewMode: 'amortized',
                            historicalAutoCloseAtExpiry: false,
                            legs: [
                                {
                                    id: 'leg_hist_manual_expiry',
                                    type: 'call',
                                    pos: 1,
                                    strike: 527,
                                    expDate: '2024/07/31',
                                    currentPrice: 27.8112,
                                    currentPriceSource: 'historical',
                                    iv: 0.2,
                                    ivSource: 'historical',
                                    ivManualOverride: false,
                                    cost: 7.35,
                                    costSource: 'historical_replay_entry',
                                    closePrice: 24.23,
                                    closePriceSource: 'historical_expiry_auto',
                                    autoSettledAtReplayDate: '2024-08-01',
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const didSync = ctx.requestHistoricalReplayExpirySettlementSync(state.groups[0]);

                assert.equal(didSync, true);
                assert.equal(state.groups[0].legs[0].closePrice, null);
                assert.equal(state.groups[0].legs[0].closePriceSource, '');
                assert.equal(state.groups[0].legs[0].autoSettledAtReplayDate, null);
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'settles expired historical close-group legs from expiry anchor when replay date is later',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    historicalQuoteDate: '2023-02-07',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 415.19,
                    simulatedDate: '2023-02-07',
                    baseDate: '2023-01-03',
                    groups: [
                        {
                            id: 'group_hist_close_expired',
                            name: 'Replay Close Expired',
                            liveData: true,
                            viewMode: 'active',
                            closeExecution: {
                                executionMode: 'preview',
                            },
                            legs: [
                                {
                                    id: 'leg_close_expired',
                                    type: 'call',
                                    pos: 1,
                                    strike: 381,
                                    expDate: '2023/01/27',
                                    currentPrice: 0,
                                    currentPriceSource: 'missing',
                                    iv: 0.24,
                                    ivSource: 'historical',
                                    ivManualOverride: false,
                                    cost: 35.3007,
                                    costSource: 'historical_base',
                                    closePrice: null,
                                    historicalExpiryUnderlyingPrice: 402.13,
                                    historicalExpiryUnderlyingDate: '2023-01-27',
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let updateCalls = 0;
                let renderCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const didSettle = ctx.requestCloseGroupComboOrder(state.groups[0]);

                assert.equal(didSettle, true);
                assert.equal(state.groups[0].legs[0].closePrice, 21.13);
                assert.equal(state.groups[0].viewMode, 'settlement');
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'subscribes INDEX forward-rate samples as synthetic call-put pairs',
            run() {
                const state = {
                    underlyingSymbol: 'SPX',
                    underlyingContractMonth: '',
                    underlyingPrice: 5800,
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    greeksEnabled: true,
                    forwardRateSamples: [
                        {
                            id: 'sample_30d',
                            daysToExpiry: 30,
                            expDate: '2026-04-16',
                            strike: 5800,
                        },
                    ],
                    groups: [],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) {
                        this.sent.push(message);
                    }

                    close() {}
                }

                const ctx = loadBrowserScripts(
                    [
                        'js/product_registry.js',
                        'js/index_forward_rate.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        location: {
                            protocol: 'file:',
                            hostname: '',
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();

                const firstMessage = JSON.parse(MockWebSocket.instance.sent[0]);
                assert.equal(firstMessage.action, 'subscribe');
                assert.equal(firstMessage.greeksEnabled, true);
                assert.equal(firstMessage.underlying.secType, 'IND');
                assert.equal(firstMessage.options.length, 2);
                assert.equal(firstMessage.options[0].id, '__forward_rate_sample_30d_call');
                assert.equal(firstMessage.options[1].id, '__forward_rate_sample_30d_put');
                assert.equal(firstMessage.options[0].right, 'C');
                assert.equal(firstMessage.options[1].right, 'P');
                assert.equal(firstMessage.options[0].strike, 5800);
                assert.equal(firstMessage.options[0].expDate, '20260416');
            },
        },
        {
            name: 'caches live bid ask snapshots for browser-side quote consumers',
            run() {
                const state = {
                    underlyingSymbol: 'SLV',
                    underlyingPrice: 28,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    groups: [
                        {
                            id: 'group_slv_quotes',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_slv_call',
                                    type: 'call',
                                    pos: 1,
                                    strike: 61,
                                    expDate: '2026-04-17',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    currentPrice: 0,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [
                        {
                            id: 'hedge_gld',
                            symbol: 'GLD',
                            liveData: true,
                            currentPrice: 0,
                            pos: 1,
                            cost: 0,
                        },
                    ],
                };

                const elements = {
                    underlyingPrice: { value: '' },
                    underlyingPriceSlider: { value: '' },
                    underlyingPriceDisplay: { textContent: '' },
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/pricing_core.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        currencyFormatter: { format(value) { return `$${value.toFixed(2)}`; } },
                        requestAnimationFrame(callback) { callback(); return 1; },
                        document: {
                            activeElement: null,
                            getElementById(id) { return elements[id] || null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingPrice: 28.5,
                    underlyingQuote: { mark: 28.5, bid: 28.49, ask: 28.51 },
                    options: {
                        leg_slv_call: {
                            mark: 1.23,
                            bid: 1.20,
                            ask: 1.26,
                            iv: 0.31,
                        },
                        __forward_sample: {
                            mark: 0.91,
                            bid: 0.89,
                            ask: 0.93,
                        },
                    },
                    stocks: {
                        GLD: {
                            mark: 284.1,
                            bid: 284.0,
                            ask: 284.2,
                        },
                    },
                });

                const underlyingQuote = ctx.OptionComboWsLiveQuotes.getUnderlyingQuote();
                assert.equal(underlyingQuote.mark, 28.5);
                assert.equal(underlyingQuote.bid, 28.49);
                assert.equal(underlyingQuote.ask, 28.51);

                const legQuote = ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_slv_call');
                assert.equal(legQuote.mark, 1.23);
                assert.equal(legQuote.bid, 1.2);
                assert.equal(legQuote.ask, 1.26);
                assert.equal(legQuote.iv, 0.31);

                const syntheticQuote = ctx.OptionComboWsLiveQuotes.getOptionQuote('__forward_sample');
                assert.equal(syntheticQuote.mark, 0.91);
                assert.equal(syntheticQuote.bid, 0.89);
                assert.equal(syntheticQuote.ask, 0.93);

                const stockQuote = ctx.OptionComboWsLiveQuotes.getStockQuote('GLD');
                assert.equal(stockQuote.mark, 284.1);
                assert.equal(stockQuote.bid, 284);
                assert.equal(stockQuote.ask, 284.2);
                assert.equal(state.groups[0].legs[0].currentPrice, 1.23);
                assert.equal(state.hedges[0].currentPrice, 284.1);
            },
        },
        {
            name: 'updates futures pool quotes and bound future legs from live futures payloads',
            run() {
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingPrice: 72.5,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    futuresPool: [
                        { id: 'future_apr', contractMonth: '202604', bid: null, ask: null, mark: null, lastQuotedAt: null },
                    ],
                    groups: [
                        {
                            id: 'group_cl_future',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_future',
                                    type: 'stock',
                                    pos: 1,
                                    currentPrice: 0,
                                    cost: 0,
                                    underlyingFutureId: 'future_apr',
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let refreshCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        requestAnimationFrame(callback) { callback(); return 1; },
                        OptionComboControlPanelUI: {
                            refreshBoundDynamicControls() {
                                refreshCalls += 1;
                            },
                        },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    futures: {
                        future_apr: {
                            bid: 70.00,
                            ask: 70.20,
                            mark: 70.10,
                        },
                    },
                });

                assert.equal(state.futuresPool[0].mark, 70.10);
                assert.equal(state.groups[0].legs[0].currentPrice, 70.10);
                assert.equal(ctx.OptionComboWsLiveQuotes.getFutureQuote('future_apr').mark, 70.10);
                assert.equal(refreshCalls, 1);
            },
        },
        {
            name: 'uses targeted control-panel refresh hooks for live forward-rate and futures-pool quotes',
            run() {
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingPrice: 72.5,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    forwardRateSamples: [
                        { id: 'sample_1' },
                    ],
                    futuresPool: [
                        { id: 'future_apr', contractMonth: '202604', bid: null, ask: null, mark: null, lastQuotedAt: null },
                    ],
                    groups: [],
                    hedges: [],
                };

                let forwardRateRefreshCalls = 0;
                let futuresPoolRefreshCalls = 0;
                let fullRefreshCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        requestAnimationFrame(callback) { callback(); return 1; },
                        OptionComboControlPanelUI: {
                            refreshForwardRatePanel() {
                                forwardRateRefreshCalls += 1;
                            },
                            refreshFuturesPoolPanel() {
                                futuresPoolRefreshCalls += 1;
                            },
                            refreshBoundDynamicControls() {
                                fullRefreshCalls += 1;
                            },
                        },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    options: {
                        __forward_sample: {
                            bid: 0.89,
                            ask: 0.93,
                            mark: 0.91,
                        },
                    },
                    futures: {
                        future_apr: {
                            bid: 70.00,
                            ask: 70.20,
                            mark: 70.10,
                        },
                    },
                });

                assert.equal(forwardRateRefreshCalls, 1);
                assert.equal(futuresPoolRefreshCalls, 1);
                assert.equal(fullRefreshCalls, 0);
            },
        },
        {
            name: 'skips redundant derived updates and panel refreshes for unchanged live payloads',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 500,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    forwardRateSamples: [
                        { id: 'sample_1' },
                    ],
                    groups: [
                        {
                            id: 'group_live',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_live_call',
                                    type: 'call',
                                    pos: 1,
                                    strike: 500,
                                    expDate: '2026-04-17',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    currentPrice: 0,
                                    currentPriceSource: '',
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let updateCalls = 0;
                let forwardRateRefreshCalls = 0;
                const elements = {
                    underlyingPrice: { value: '' },
                    underlyingPriceSlider: { value: '' },
                    underlyingPriceDisplay: { textContent: '' },
                };
                const ctx = loadBrowserScripts(
                    [
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/pricing_core.js',
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() { updateCalls += 1; },
                        flashElement() {},
                        currencyFormatter: { format(value) { return `$${value.toFixed(2)}`; } },
                        requestAnimationFrame(callback) { callback(); return 1; },
                        OptionComboControlPanelUI: {
                            refreshForwardRatePanel() {
                                forwardRateRefreshCalls += 1;
                            },
                        },
                        document: {
                            activeElement: null,
                            getElementById(id) { return elements[id] || null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const livePayload = {
                    underlyingPrice: 512.25,
                    underlyingQuote: { mark: 512.25, bid: 512.24, ask: 512.26 },
                    options: {
                        leg_live_call: {
                            mark: 12.34,
                            bid: 12.30,
                            ask: 12.38,
                            iv: 0.31,
                        },
                        __forward_sample: {
                            mark: 1.01,
                            bid: 1.00,
                            ask: 1.02,
                        },
                    },
                };

                ctx.processLiveMarketData(livePayload);
                ctx.processLiveMarketData(livePayload);

                assert.equal(state.underlyingPrice, 512.25);
                assert.equal(state.groups[0].legs[0].currentPrice, 12.34);
                assert.equal(state.groups[0].legs[0].iv, 0.31);
                assert.equal(updateCalls, 1);
                assert.equal(forwardRateRefreshCalls, 1);
            },
        },
        {
            name: 'uses incremental derived updates for live option quote changes',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 500,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    groups: [
                        {
                            id: 'group_live_option',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_live_option',
                                    type: 'call',
                                    pos: 1,
                                    strike: 500,
                                    expDate: '2026-04-17',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    currentPrice: 0,
                                    currentPriceSource: '',
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let fullUpdateCalls = 0;
                let incrementalCalls = 0;
                let lastChangeSet = null;
                const ctx = loadBrowserScripts(
                    [
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/pricing_core.js',
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() { fullUpdateCalls += 1; },
                        updateLiveQuoteDerivedValues(changeSet) {
                            incrementalCalls += 1;
                            lastChangeSet = changeSet;
                        },
                        flashElement() {},
                        currencyFormatter: { format(value) { return `$${value.toFixed(2)}`; } },
                        requestAnimationFrame(callback) { callback(); return 1; },
                        document: {
                            activeElement: null,
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    options: {
                        leg_live_option: {
                            mark: 12.34,
                            bid: 12.30,
                            ask: 12.38,
                            iv: 0.31,
                        },
                    },
                });

                assert.equal(fullUpdateCalls, 0);
                assert.equal(incrementalCalls, 1);
                assert.deepEqual(Array.from(lastChangeSet.groupIds), ['group_live_option']);
                assert.deepEqual(Array.from(lastChangeSet.hedgeIds), []);
            },
        },
        {
            name: 'uses incremental updates when midpoint-only underlying quotes change',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 500,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    groups: [
                        {
                            id: 'group_midpoint_underlying',
                            liveData: true,
                            livePriceMode: 'midpoint',
                            legs: [
                                {
                                    id: 'leg_underlying_midpoint',
                                    type: 'stock',
                                    pos: 1,
                                    currentPrice: 500,
                                    currentPriceSource: 'live',
                                    cost: 495,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let fullUpdateCalls = 0;
                let incrementalCalls = 0;
                let lastChangeSet = null;
                const ctx = loadBrowserScripts(
                    [
                        'js/product_registry.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() { fullUpdateCalls += 1; },
                        updateLiveQuoteDerivedValues(changeSet) {
                            incrementalCalls += 1;
                            lastChangeSet = changeSet;
                        },
                        flashElement() {},
                        requestAnimationFrame(callback) { callback(); return 1; },
                        document: {
                            activeElement: null,
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    underlyingQuote: {
                        mark: 500,
                        bid: 499.5,
                        ask: 500.5,
                    },
                });

                ctx.processLiveMarketData({
                    underlyingQuote: {
                        mark: 500,
                        bid: 499.8,
                        ask: 500.8,
                    },
                });

                assert.equal(fullUpdateCalls, 0);
                assert.equal(incrementalCalls, 2);
                assert.deepEqual(Array.from(lastChangeSet.groupIds), ['group_midpoint_underlying']);
                assert.deepEqual(Array.from(lastChangeSet.hedgeIds), []);
            },
        },
        {
            name: 'marks option IV as missing when live quotes arrive without a usable IV',
            run() {
                const state = {
                    underlyingSymbol: 'SLV',
                    underlyingPrice: 28,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    groups: [
                        {
                            id: 'group_slv',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_slv_call',
                                    type: 'call',
                                    pos: 1,
                                    strike: 61,
                                    expDate: '2026-04-17',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    currentPrice: 0,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/pricing_core.js',
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() { updateCalls += 1; },
                        flashElement() {},
                        currencyFormatter: { format(value) { return `$${value.toFixed(2)}`; } },
                        requestAnimationFrame(callback) { callback(); return 1; },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    options: {
                        leg_slv_call: {
                            mark: 1.23,
                            iv: null,
                        },
                    },
                });

                assert.equal(state.groups[0].legs[0].iv, 0.2);
                assert.equal(state.groups[0].legs[0].ivSource, 'missing');
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'estimates missing option IV from the nearest live strikes above and below',
            run() {
                const state = {
                    underlyingSymbol: 'SLV',
                    underlyingPrice: 28,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    groups: [
                        {
                            id: 'group_slv_curve',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_call_60',
                                    type: 'call',
                                    pos: 1,
                                    strike: 60,
                                    expDate: '2026-04-17',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    currentPrice: 0,
                                    cost: 0,
                                    closePrice: null,
                                },
                                {
                                    id: 'leg_call_61',
                                    type: 'call',
                                    pos: 1,
                                    strike: 61,
                                    expDate: '2026-04-17',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    currentPrice: 0,
                                    cost: 0,
                                    closePrice: null,
                                },
                                {
                                    id: 'leg_call_62',
                                    type: 'call',
                                    pos: 1,
                                    strike: 62,
                                    expDate: '2026-04-17',
                                    iv: 0.2,
                                    ivSource: 'manual',
                                    ivManualOverride: false,
                                    currentPrice: 0,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/pricing_core.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        currencyFormatter: { format(value) { return `$${value.toFixed(2)}`; } },
                        requestAnimationFrame(callback) { callback(); return 1; },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    options: {
                        leg_call_60: { mark: 1.0, iv: 0.40 },
                        leg_call_61: { mark: 0.8, iv: null },
                        leg_call_62: { mark: 0.6, iv: 0.60 },
                    },
                });

                assert.equal(state.groups[0].legs[0].ivSource, 'live');
                assert.equal(state.groups[0].legs[2].ivSource, 'live');
                assert.equal(state.groups[0].legs[1].ivSource, 'estimated');
                assert.equal(state.groups[0].legs[1].iv, 0.50);
            },
        },
        {
            name: 'preserves manual IV overrides when live IV remains unavailable',
            run() {
                const state = {
                    underlyingSymbol: 'SLV',
                    underlyingPrice: 28,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    groups: [
                        {
                            id: 'group_slv_manual',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_slv_manual',
                                    type: 'put',
                                    pos: 1,
                                    strike: 61,
                                    expDate: '2026-04-17',
                                    iv: 0.33,
                                    ivSource: 'manual',
                                    ivManualOverride: true,
                                    currentPrice: 0,
                                    cost: 0,
                                    closePrice: null,
                                },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/pricing_core.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        currencyFormatter: { format(value) { return `$${value.toFixed(2)}`; } },
                        requestAnimationFrame(callback) { callback(); return 1; },
                        document: {
                            activeElement: null,
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx.processLiveMarketData({
                    options: {
                        leg_slv_manual: {
                            mark: 1.11,
                            iv: null,
                        },
                    },
                });

                assert.equal(state.groups[0].legs[0].ivSource, 'manual');
                assert.equal(state.groups[0].legs[0].ivManualOverride, true);
                assert.equal(state.groups[0].legs[0].iv, 0.33);
            },
        },
        {
            name: 'applies execution-report fill costs only to the triggered group and promotes it to active',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    groups: [
                        {
                            id: 'group_triggered',
                            viewMode: 'trial',
                            syncAvgCostFromPortfolio: true,
                            tradeTrigger: {
                                lastPreview: {
                                    status: 'Filled',
                                    executionMode: 'submit',
                                    orderId: 2360,
                                    permId: 1678156565,
                                },
                            },
                            legs: [
                                { id: 'leg_call_670', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 0 },
                                { id: 'leg_put_662', type: 'put', pos: 1, strike: 662, expDate: '2026-04-02', cost: 0 },
                                { id: 'leg_call_677', type: 'call', pos: -1, strike: 677, expDate: '2026-04-02', cost: 0 },
                                { id: 'leg_put_656', type: 'put', pos: -1, strike: 656, expDate: '2026-04-02', cost: 0 },
                            ],
                        },
                        {
                            id: 'group_other',
                            viewMode: 'active',
                            syncAvgCostFromPortfolio: true,
                            legs: [
                                { id: 'other_leg_call_670', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 99.99 },
                            ],
                        },
                    ],
                };

                let renderCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() { renderCalls += 1; },
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._handleComboOrderMessage({
                    action: 'combo_order_fill_cost_update',
                    groupId: 'group_triggered',
                    orderFill: {
                        orderId: 2360,
                        permId: 1678156565,
                        costSource: 'execution_report',
                        legs: [
                            { id: 'leg_call_670', avgFillPrice: 11.22 },
                            { id: 'leg_put_662', avgFillPrice: 7.967 },
                            { id: 'leg_call_677', avgFillPrice: 7.13 },
                            { id: 'leg_put_656', avgFillPrice: 6.42 },
                        ],
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].viewMode, 'active');
                assert.equal(state.groups[0].legs[0].cost, 11.22);
                assert.equal(state.groups[0].legs[1].cost, 7.967);
                assert.equal(state.groups[0].legs[1].costSource, 'execution_report');
                assert.equal(state.groups[1].legs[0].cost, 99.99);
                assert.equal(renderCalls, 1);
            },
        },
        {
            name: 'does not let portfolio avg cost overwrite execution-report fill costs',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    groups: [
                        {
                            id: 'group_triggered',
                            viewMode: 'active',
                            syncAvgCostFromPortfolio: true,
                            tradeTrigger: {
                                lastPreview: {
                                    status: 'Filled',
                                    executionMode: 'submit',
                                },
                            },
                            legs: [
                                {
                                    id: 'leg_put_662',
                                    type: 'put',
                                    pos: 1,
                                    strike: 662,
                                    expDate: '2026-04-02',
                                    cost: 7.967,
                                    costSource: 'execution_report',
                                    executionReportedCost: true,
                                },
                            ],
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/product_registry.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyPortfolioAvgCostUpdate({
                    action: 'portfolio_avg_cost_update',
                    items: [
                        {
                            secType: 'OPT',
                            symbol: 'SPY',
                            expDate: '20260402',
                            right: 'P',
                            strike: 662,
                            position: 1,
                            avgCostPerUnit: 10.006,
                            marketPrice: 10.12,
                            unrealizedPNL: 215.5,
                        },
                    ],
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].legs[0].cost, 7.967);
                assert.equal(state.groups[0].legs[0].costSource, 'execution_report');
                assert.equal(state.groups[0].legs[0].portfolioMarketPrice, 10.12);
                assert.equal(state.groups[0].legs[0].portfolioUnrealizedPnl, 215.5);
            },
        },
        {
            name: 'marks immediately cancelled combo submits as trigger errors',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: true,
                                pendingRequest: true,
                                status: 'pending_test_submit',
                                lastPreview: null,
                                lastError: '',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderResult({
                    action: 'combo_order_submit_result',
                    groupId: 'group_1',
                    order: {
                        executionMode: 'test_submit',
                        status: 'Cancelled',
                        statusMessage: 'The price does not conform to the minimum price variation for this contract.',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.status, 'error');
                assert.match(
                    state.groups[0].tradeTrigger.lastError,
                    /minimum price variation/i
                );
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'applies combo order status updates onto the last preview payload',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'test_submitted',
                                lastPreview: {
                                    executionMode: 'test_submit',
                                    status: 'PreSubmitted',
                                    orderId: 930,
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'test_submit',
                        account: 'F1234567',
                        status: 'Submitted',
                        orderId: 930,
                        permId: 12345,
                        filled: 0,
                        remaining: 1,
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.status, 'Submitted');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.account, 'F1234567');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.permId, 12345);
                assert.equal(state.groups[0].tradeTrigger.status, 'test_submitted');
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'promotes terminal combo order status updates into explicit trigger errors',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'PendingSubmit',
                                    orderId: 42567,
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'submit',
                        orderId: 42567,
                        permId: 429367627,
                        status: 'Inactive',
                        filled: 0,
                        remaining: 1,
                        statusMessage: 'IB 201: Order rejected - reason: Available Funds are insufficient.',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.status, 'error');
                assert.match(
                    state.groups[0].tradeTrigger.lastError,
                    /available funds are insufficient/i
                );
                assert.equal(state.groups[0].tradeTrigger.lastPreview.permId, 429367627);
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'does not mark managed terminal confirmation updates as trigger errors',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    orderId: 42567,
                                    managedMode: true,
                                    managedState: 'watching',
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'submit',
                        orderId: 42567,
                        status: 'Inactive',
                        managedMode: true,
                        managedState: 'confirming_terminal',
                        managedMessage: 'Observed broker status Inactive; pausing briefly to confirm.',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.status, 'submitted');
                assert.equal(state.groups[0].tradeTrigger.lastError, '');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedState, 'confirming_terminal');
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'restores submitted trigger status after managed updates recover from a transient error state',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'error',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Inactive',
                                    orderId: 42567,
                                    managedMode: true,
                                    managedState: 'confirming_terminal',
                                },
                                lastError: 'IB 201: transient inactive during modify/replace',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_1',
                    orderStatus: {
                        orderId: 42567,
                        status: 'Filled',
                        managedMode: true,
                        managedState: 'filled',
                        managedMessage: 'Order fully filled; auto-repricing is complete.',
                        filled: 8,
                        remaining: 0,
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.status, 'submitted');
                assert.equal(state.groups[0].tradeTrigger.lastError, '');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.status, 'Filled');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedState, 'filled');
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'merges managed execution drift updates into the live order preview',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    orderId: 1337,
                                    workingLimitPrice: 2.18,
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/trade_trigger_logic.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {
                            renderCalls += 1;
                        },
                        updateDerivedValues() {
                            updateCalls += 1;
                        },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'submit',
                        orderId: 1337,
                        managedMode: true,
                        managedState: 'watching',
                        workingLimitPrice: 2.25,
                        latestComboMid: 2.31,
                        repricingCount: 1,
                        lastRepriceAt: '2026-03-17T15:30:00Z',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.workingLimitPrice, 2.25);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.latestComboMid, 2.31);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.repricingCount, 1);
                assert.equal(state.groups[0].tradeTrigger.status, 'submitted');
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'preserves terminal managed execution state from broker updates',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    managedMode: true,
                                    managedState: 'watching',
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx._applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'submit',
                        status: 'Filled',
                        managedMode: true,
                        managedState: 'filled',
                        managedMessage: 'Order fully filled; auto-repricing is complete.',
                        filled: 1,
                        remaining: 0,
                    },
                });

                assert.equal(state.groups[0].tradeTrigger.lastPreview.status, 'Filled');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedState, 'filled');
                assert.match(state.groups[0].tradeTrigger.lastPreview.managedMessage, /fully filled/i);
            },
        },
        {
            name: 'clears stale managed execution fields when broker updates fall back to plain order status',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    orderId: 393,
                                    permId: 1991671892,
                                    managedMode: true,
                                    managedState: 'done',
                                    managedMessage: 'Broker order reached terminal status Cancelled.',
                                    workingLimitPrice: 154.53,
                                    latestComboMid: 154.53,
                                    repricingCount: 1,
                                    maxRepriceCount: 12,
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                ctx._applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'submit',
                        orderId: 393,
                        permId: 1991671892,
                        status: 'Submitted',
                        filled: 0,
                        remaining: 1,
                        managedMode: false,
                    },
                });

                assert.equal(state.groups[0].tradeTrigger.lastPreview.status, 'Submitted');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedMode, false);
                assert.equal('managedState' in state.groups[0].tradeTrigger.lastPreview, false);
                assert.equal('managedMessage' in state.groups[0].tradeTrigger.lastPreview, false);
                assert.equal('workingLimitPrice' in state.groups[0].tradeTrigger.lastPreview, false);
            },
        },
        {
            name: 'applies managed-repricing resume results onto the live order preview',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: true,
                                status: 'pending_resume',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    managedMode: true,
                                    managedState: 'stopped_max_reprices',
                                    repricingCount: 12,
                                    maxRepriceCount: 12,
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() { renderCalls += 1; },
                        updateDerivedValues() { updateCalls += 1; },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._handleComboOrderMessage({
                    action: 'combo_order_resume_result',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'submit',
                        managedMode: true,
                        managedState: 'watching',
                        repricingCount: 12,
                        maxRepriceCount: 24,
                        managedMessage: 'Extended auto-repricing budget by 12 more attempts. New cap: 24.',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.pendingRequest, false);
                assert.equal(state.groups[0].tradeTrigger.status, 'submitted');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.maxRepriceCount, 24);
                assert.match(state.groups[0].tradeTrigger.lastPreview.managedMessage, /12 more attempts/i);
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'applies managed concession results onto the live order preview',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: true,
                                status: 'pending_concede',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    managedMode: true,
                                    managedState: 'stopped_max_reprices',
                                    repricingCount: 12,
                                    maxRepriceCount: 12,
                                    workingLimitPrice: 5.61,
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() { renderCalls += 1; },
                        updateDerivedValues() { updateCalls += 1; },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._handleComboOrderMessage({
                    action: 'combo_order_concede_result',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'submit',
                        managedMode: true,
                        managedState: 'watching',
                        workingLimitPrice: 5.7,
                        latestComboMid: 5.61,
                        bestComboPrice: 5.3,
                        worstComboPrice: 6.5,
                        managedConcessionRatio: 0.2,
                        repricingCount: 13,
                        maxRepriceCount: 24,
                        managedMessage: 'Conceded 20% from middle toward the quoted worst price and resumed supervision. New retry cap: 24.',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.pendingRequest, false);
                assert.equal(state.groups[0].tradeTrigger.status, 'submitted');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.workingLimitPrice, 5.7);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedConcessionRatio, 0.2);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.maxRepriceCount, 24);
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'applies combo order cancel results onto the live order preview',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_1',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: true,
                                status: 'pending_cancel',
                                lastPreview: {
                                    executionMode: 'submit',
                                    status: 'Submitted',
                                    orderId: 2187,
                                },
                                lastError: '',
                            },
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() { renderCalls += 1; },
                        updateDerivedValues() { updateCalls += 1; },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._handleComboOrderMessage({
                    action: 'combo_order_cancel_result',
                    groupId: 'group_1',
                    orderStatus: {
                        executionMode: 'submit',
                        managedMode: true,
                        managedState: 'cancelling',
                        managedMessage: 'Cancelling the live combo order in TWS.',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.pendingRequest, false);
                assert.equal(state.groups[0].tradeTrigger.status, 'pending_cancel');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.managedState, 'cancelling');
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'requests close-group previews before any real TWS submission by default',
            run() {
                const state = {
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 671.1,
                    simulatedDate: '2026-03-19',
                    baseDate: '2026-03-19',
                    allowLiveComboOrders: true,
                    groups: [
                        {
                            id: 'group_close_preview',
                            viewMode: 'active',
                            closeExecution: {
                                executionMode: 'preview',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_2', type: 'call', pos: -1, strike: 677, expDate: '2026-04-02', cost: 7.13, closePrice: null },
                            ],
                        },
                    ],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) {
                        this.sent.push(message);
                    }

                    close() {}
                }

                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/product_registry.js', 'js/group_order_builder.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        location: {
                            protocol: 'file:',
                            hostname: '',
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();
                MockWebSocket.instance.sent.length = 0;

                const result = ctx.requestCloseGroupComboOrder(state.groups[0]);
                const payload = JSON.parse(MockWebSocket.instance.sent[0]);

                assert.equal(result, true);
                assert.equal(payload.action, 'preview_combo_order');
                assert.equal(payload.executionMode, 'preview');
                assert.equal(payload.executionIntent, 'close');
                assert.equal(payload.requestSource, 'close_group');
                assert.equal(state.groups[0].closeExecution.status, 'pending_preview');
            },
        },
        {
            name: 'routes close-group submit results into close execution state',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_close',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            closeExecution: {
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: true,
                                status: 'pending_validation',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_2', type: 'call', pos: -1, strike: 677, expDate: '2026-04-02', cost: 7.13, closePrice: null },
                            ],
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {} ,
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderResult({
                    action: 'combo_order_submit_result',
                    groupId: 'group_close',
                    order: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        status: 'Submitted',
                        orderId: 501,
                        permId: 601,
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].closeExecution.pendingRequest, false);
                assert.equal(state.groups[0].closeExecution.status, 'submitted');
                assert.equal(state.groups[0].closeExecution.lastPreview.orderId, 501);
                assert.equal(state.groups[0].tradeTrigger.status, 'idle');
            },
        },
        {
            name: 'routes close-group preview results into close execution state',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_close_preview',
                            tradeTrigger: {
                                enabled: false,
                                pendingRequest: false,
                                status: 'idle',
                                lastPreview: null,
                                lastError: '',
                            },
                            closeExecution: {
                                executionMode: 'preview',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: true,
                                status: 'pending_preview',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_2', type: 'put', pos: -1, strike: 662, expDate: '2026-04-02', cost: 7.96, closePrice: null },
                            ],
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderResult({
                    action: 'combo_order_preview_result',
                    groupId: 'group_close_preview',
                    preview: {
                        executionMode: 'preview',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        limitPrice: 5.03,
                        orderAction: 'SELL',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].closeExecution.pendingRequest, false);
                assert.equal(state.groups[0].closeExecution.status, 'previewed');
                assert.equal(state.groups[0].closeExecution.lastPreview.limitPrice, 5.03);
                assert.equal(state.groups[0].tradeTrigger.lastPreview, null);
            },
        },
        {
            name: 'falls back to pending close execution when close preview metadata is missing',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_close_pending',
                            tradeTrigger: {
                                enabled: true,
                                pendingRequest: false,
                                status: 'armed',
                                lastPreview: null,
                                lastError: '',
                            },
                            closeExecution: {
                                executionMode: 'preview',
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: true,
                                status: 'pending_preview',
                                lastPreview: null,
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_1', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_2', type: 'put', pos: -1, strike: 662, expDate: '2026-04-02', cost: 7.96, closePrice: null },
                            ],
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderResult({
                    action: 'combo_order_preview_result',
                    groupId: 'group_close_pending',
                    preview: {
                        executionMode: 'preview',
                        limitPrice: 5.03,
                        orderAction: 'SELL',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].closeExecution.pendingRequest, false);
                assert.equal(state.groups[0].closeExecution.status, 'previewed');
                assert.equal(state.groups[0].closeExecution.lastPreview.limitPrice, 5.03);
                assert.equal(state.groups[0].tradeTrigger.lastPreview, null);
                assert.equal(state.groups[0].tradeTrigger.status, 'armed');
            },
        },
        {
            name: 'writes close-group execution fills into closePrice without overwriting entry cost',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_close_fill',
                            closeExecution: {
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    executionIntent: 'close',
                                    requestSource: 'close_group',
                                    status: 'Submitted',
                                    orderId: 700,
                                },
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_call', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_put', type: 'put', pos: -1, strike: 662, expDate: '2026-04-02', cost: 7.96, closePrice: null },
                            ],
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderFillCostUpdate({
                    action: 'combo_order_fill_cost_update',
                    groupId: 'group_close_fill',
                    orderFill: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        orderId: 700,
                        permId: 1700,
                        legs: [
                            { id: 'leg_call', avgFillPrice: 10.85 },
                            { id: 'leg_put', avgFillPrice: 6.74 },
                        ],
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].legs[0].cost, 11.22);
                assert.equal(state.groups[0].legs[1].cost, 7.96);
                assert.equal(state.groups[0].legs[0].closePrice, 10.85);
                assert.equal(state.groups[0].legs[1].closePrice, 6.74);
            },
        },
        {
            name: 'preserves group positions once a close-group order reaches filled status',
            run() {
                const state = {
                    groups: [
                        {
                            id: 'group_close_done',
                            closeExecution: {
                                repriceThreshold: 0.01,
                                timeInForce: 'DAY',
                                pendingRequest: false,
                                status: 'submitted',
                                lastPreview: {
                                    executionMode: 'submit',
                                    executionIntent: 'close',
                                    requestSource: 'close_group',
                                    status: 'Submitted',
                                    orderId: 801,
                                },
                                lastError: '',
                            },
                            legs: [
                                { id: 'leg_call', type: 'call', pos: 1, strike: 670, expDate: '2026-04-02', cost: 11.22, closePrice: null },
                                { id: 'leg_put', type: 'put', pos: -2, strike: 662, expDate: '2026-04-02', cost: 7.96, closePrice: null },
                            ],
                        },
                    ],
                };

                const ctx = loadBrowserScripts(
                    ['js/trade_trigger_logic.js', 'js/session_logic.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const handled = ctx._applyComboOrderStatusUpdate({
                    action: 'combo_order_status_update',
                    groupId: 'group_close_done',
                    orderStatus: {
                        executionMode: 'submit',
                        executionIntent: 'close',
                        requestSource: 'close_group',
                        status: 'Filled',
                        filled: 1,
                        remaining: 0,
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].closeExecution.lastPreview.status, 'Filled');
                assert.equal(state.groups[0].legs[0].pos, 1);
                assert.equal(state.groups[0].legs[1].pos, -2);
            },
        },
    ],
};
