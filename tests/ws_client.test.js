const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'ws_client.js',
    tests: [
        {
            name: 'applies portfolio avg cost updates only to opted-in matching legs',
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
                                { id: 'leg_put', type: 'put', pos: 1, strike: 662, expDate: '2026-04-02', cost: 0 },
                            ],
                        },
                    ],
                };

                let renderCalls = 0;
                let updateCalls = 0;
                const ctx = loadBrowserScripts(
                    [
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
                        },
                    ],
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].legs[0].cost, 10.31);
                assert.equal(state.groups[1].legs[0].cost, 0);
                assert.equal(renderCalls, 1);
                assert.equal(updateCalls, 0);
            },
        },
        {
            name: 'builds CL live subscriptions with FUT underlying and FOP option payloads',
            run() {
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingContractMonth: '202605',
                    underlyingPrice: 72.5,
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
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
                assert.equal(firstMessage.underlying.secType, 'FUT');
                assert.equal(firstMessage.underlying.symbol, 'CL');
                assert.equal(firstMessage.underlying.exchange, 'NYMEX');
                assert.equal(firstMessage.underlying.contractMonth, '202605');
                assert.equal(firstMessage.underlying.multiplier, '1000');
                assert.equal(firstMessage.options.length, 1);
                assert.equal(firstMessage.options[0].secType, 'FOP');
                assert.equal(firstMessage.options[0].symbol, 'CL');
                assert.equal(firstMessage.options[0].exchange, 'NYMEX');
                assert.equal(firstMessage.options[0].tradingClass, 'ML3');
                assert.equal(firstMessage.options[0].underlyingContractMonth, '202605');
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
                        },
                    ],
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].legs[0].cost, 7.967);
                assert.equal(state.groups[0].legs[0].costSource, 'execution_report');
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
                        status: 'Submitted',
                        orderId: 930,
                        permId: 12345,
                        filled: 0,
                        remaining: 1,
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.lastPreview.status, 'Submitted');
                assert.equal(state.groups[0].tradeTrigger.lastPreview.permId, 12345);
                assert.equal(state.groups[0].tradeTrigger.status, 'test_submitted');
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
                    ['js/ws_client.js'],
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
                    ['js/ws_client.js'],
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
                    ['js/ws_client.js'],
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
                    ['js/ws_client.js'],
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
                    ['js/session_logic.js', 'js/group_order_builder.js', 'js/ws_client.js'],
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
                    ['js/session_logic.js', 'js/ws_client.js'],
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
                    ['js/session_logic.js', 'js/ws_client.js'],
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
                    ['js/session_logic.js', 'js/ws_client.js'],
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
                    ['js/session_logic.js', 'js/ws_client.js'],
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
                    ['js/session_logic.js', 'js/ws_client.js'],
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
