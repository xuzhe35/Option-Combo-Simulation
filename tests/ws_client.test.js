const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function completeMainSocketHandshake(socket, overrides = {}) {
    socket.onmessage({
        data: JSON.stringify({
            action: 'ib_connection_status',
            connected: true,
            connecting: false,
            marketDataState: 'ready',
            marketDataGeneration: 0,
            recoveryReason: 'startup',
            subscriptionsRequired: false,
            automaticReplayAllowed: false,
            ...overrides,
        }),
    });
}

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
            name: 'applies contract-only timing metadata without treating it as market-price evidence',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 745.53,
                    baseDate: '2026-07-20',
                    simulatedDate: '2026-07-24',
                    liveQuoteDate: '2026-07-20',
                    liveQuoteAsOf: '2026-07-20T14:00:00.000Z',
                    liveProjectionFeedConnected: false,
                    liveProjectionFeedStale: true,
                    liveProjectionLastReceivedAt: '2026-07-20T13:59:00.000Z',
                    greeksEnabled: false,
                    groups: [{
                        id: 'spy_butterfly',
                        liveData: true,
                        legs: [{
                            id: 'spy_750_put',
                            type: 'put',
                            pos: -1,
                            strike: 750,
                            expDate: '2026-07-24',
                            currentPrice: 6.86,
                            currentPriceSource: 'live',
                            iv: 0.140127,
                            ivSource: 'live',
                            cost: 7.49,
                            closePrice: null,
                        }],
                    }],
                    hedges: [],
                    futuresPool: [],
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
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/pricing_context.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        document: {
                            activeElement: null,
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const marketClockBeforeMetadata = {
                    liveQuoteAsOf: state.liveQuoteAsOf,
                    liveQuoteDate: state.liveQuoteDate,
                    connected: state.liveProjectionFeedConnected,
                    stale: state.liveProjectionFeedStale,
                    receivedAt: state.liveProjectionLastReceivedAt,
                };

                MockWebSocket.instance.onmessage({
                    data: JSON.stringify({
                    action: 'option_contract_metadata',
                    marketDataGeneration: 0,
                    contractMetadataOnly: true,
                    // Even if a server receipt timestamp is present, contract
                    // metadata is not proof that any market price advanced.
                    payloadAsOf: '2026-07-20T14:05:00.000Z',
                    options: {
                        spy_750_put: {
                            conId: 701,
                            secType: 'OPT',
                            symbol: 'SPY',
                            localSymbol: 'SPY   260724P00750000',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: '100',
                            tradingClass: 'SPY',
                            right: 'P',
                            strike: 750,
                            optionExpiry: '20260724',
                            contractIdentitySource: 'ib_contract_details',
                            expiryAsOf: '2026-07-24T20:00:00.000Z',
                            expiryTimingSource: 'ib_contract_details',
                            lastTradeDate: '20260724',
                            lastTradeTime: '16:00:00',
                            timeZoneId: 'US/Eastern',
                            realExpirationDate: '20260724',
                        },
                    },
                    }),
                });

                const leg = state.groups[0].legs[0];
                assert.equal(leg.expiryAsOf, '2026-07-24T20:00:00.000Z');
                assert.equal(leg.qualifiedOptionConId, 701);
                assert.equal(leg.currentPrice, 6.86);
                assert.equal(leg.currentPriceSource, 'live');
                assert.equal(leg.iv, 0.140127);
                assert.equal(leg.ivSource, 'live');
                assert.equal(ctx.OptionComboWsLiveQuotes.getOptionQuote('spy_750_put'), null);
                assert.equal(state.liveQuoteAsOf, marketClockBeforeMetadata.liveQuoteAsOf);
                assert.equal(state.liveQuoteDate, marketClockBeforeMetadata.liveQuoteDate);
                assert.equal(
                    state.liveProjectionFeedConnected,
                    marketClockBeforeMetadata.connected
                );
                assert.equal(state.liveProjectionFeedStale, marketClockBeforeMetadata.stale);
                assert.equal(
                    state.liveProjectionLastReceivedAt,
                    marketClockBeforeMetadata.receivedAt
                );
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
                    // This case isolates the greeks-disabled delta path.  A
                    // separate test covers the first-payload feed transition.
                    liveProjectionFeedConnected: true,
                    liveProjectionFeedStale: false,
                    liveProjectionLastReceivedAt: new Date().toISOString(),
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
            name: 'rolls the live quote anchor from payload time without moving the entry date',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 600,
                    baseDate: '2026-07-01',
                    simulatedDate: '2026-07-15',
                    liveQuoteDate: '',
                    liveQuoteAsOf: '',
                    greeksEnabled: false,
                    forwardRateSamples: [],
                    futuresPool: [],
                    groups: [
                        {
                            id: 'group_updated_quote',
                            liveData: true,
                            legs: [{
                                id: 'leg_updated_quote',
                                type: 'call',
                                pos: 1,
                                strike: 600,
                                expDate: '2026-07-20',
                                iv: 0.2,
                                currentPrice: 3,
                                cost: 3,
                            }],
                        },
                        {
                            id: 'group_clock_only',
                            liveData: true,
                            legs: [{
                                id: 'leg_clock_only',
                                type: 'put',
                                pos: 1,
                                strike: 590,
                                expDate: '2026-07-20',
                                iv: 0.2,
                                currentPrice: 2,
                                cost: 2,
                            }],
                        },
                    ],
                    hedges: [],
                };
                let fullRefreshes = 0;
                let incrementalRefreshes = 0;
                let controlRefreshes = 0;

                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/session_logic.js',
                    'js/ws_client.js',
                ], {
                    state,
                    renderGroups() {},
                    updateDerivedValues() {
                        fullRefreshes += 1;
                    },
                    updateLiveQuoteDerivedValues() {
                        incrementalRefreshes += 1;
                    },
                    OptionComboControlPanelUI: {
                        refreshBoundDynamicControls() {
                            controlRefreshes += 1;
                        },
                    },
                    requestAnimationFrame(callback) {
                        callback();
                        return 1;
                    },
                    flashElement() {},
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
                });

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-10T20:00:00Z',
                    options: {
                        leg_updated_quote: { bid: 3.1, ask: 3.3, mark: 3.2, iv: 0.21 },
                    },
                });

                assert.equal(state.baseDate, '2026-07-01');
                assert.equal(state.liveQuoteDate, '2026-07-10');
                assert.equal(state.liveQuoteAsOf, '2026-07-10T20:00:00Z');
                assert.equal(state.simulatedDate, '2026-07-15');
                assert.equal(fullRefreshes, 1);
                assert.equal(incrementalRefreshes, 0);
                assert.equal(controlRefreshes, 1);

                // A market-date roll changes theta for every group, even if
                // this payload only contains one unchanged ticker.
                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-15T20:00:00Z',
                    options: {
                        leg_updated_quote: { bid: 3.1, ask: 3.3, mark: 3.2, iv: 0.21 },
                    },
                });
                assert.equal(state.liveQuoteDate, '2026-07-15');
                assert.equal(state.simulatedDate, '2026-07-15');
                assert.equal(fullRefreshes, 2);
                assert.equal(incrementalRefreshes, 0);

                // Delayed/out-of-order data may update a quote, but must not
                // move the valuation clock backwards.
                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-11T20:00:00Z',
                    options: {
                        leg_updated_quote: { bid: 3.2, ask: 3.4, mark: 3.3, iv: 0.22 },
                    },
                });
                assert.equal(state.liveQuoteDate, '2026-07-15');
                assert.equal(state.liveQuoteAsOf, '2026-07-15T20:00:00Z');
                assert.equal(state.baseDate, '2026-07-01');

                // A stale historical response cannot overwrite the live
                // clock even if the UI has already switched back to live.
                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-20T20:00:00Z',
                    historicalReplay: { effectiveDate: '2024-03-15' },
                    options: {
                        leg_updated_quote: { bid: 3.2, ask: 3.4, mark: 3.3, iv: 0.22 },
                    },
                });
                assert.equal(state.liveQuoteDate, '2026-07-15');
                assert.equal(state.liveQuoteAsOf, '2026-07-15T20:00:00Z');
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
                        { id: 'future_jul', contractMonth: '202607', conId: 60701 },
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
                completeMainSocketHandshake(MockWebSocket.instance);

                const sentMessages = MockWebSocket.instance.sent.map(message => JSON.parse(message));
                assert.equal(sentMessages[0].action, 'request_ib_connection_status');
                const subscribeMessage = sentMessages.find(message => message.action === 'subscribe');
                assert.ok(subscribeMessage);
                assert.equal(subscribeMessage.greeksEnabled, false);
                assert.equal(subscribeMessage.underlying.secType, 'FUT');
                assert.equal(subscribeMessage.underlying.symbol, 'CL');
                assert.equal(subscribeMessage.underlying.exchange, 'NYMEX');
                assert.equal(subscribeMessage.underlying.contractMonth, '202607');
                assert.equal(subscribeMessage.underlying.multiplier, '1000');
                assert.equal(subscribeMessage.options.length, 1);
                assert.equal(subscribeMessage.futures.length, 1);
                assert.equal(subscribeMessage.futures[0].contractMonth, '202607');
                assert.equal(subscribeMessage.options[0].secType, 'FOP');
                assert.equal(subscribeMessage.options[0].symbol, 'CL');
                assert.equal(subscribeMessage.options[0].exchange, 'NYMEX');
                // ML3 names one Monday week-3 crude listing, so it is wrong for
                // most CL expiries.  IB names the class from the exact contract.
                assert.equal(subscribeMessage.options[0].tradingClass, undefined);
                assert.equal(subscribeMessage.options[0].underlyingContractMonth, '202607');
                assert.deepEqual(Array.from(subscribeMessage.carryReferences), []);
                assert.ok(sentMessages.some(
                    message => message.action === 'request_portfolio_avg_cost_snapshot'
                ));
                assert.ok(sentMessages.some(
                    message => message.action === 'request_managed_accounts_snapshot'
                ));
            },
        },
        {
            name: 'qualifies ES daily FOPs without a guessed trading class and accepts the IB identity',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '202609',
                    underlyingPrice: 7516.25,
                    simulatedDate: '2026-07-20',
                    baseDate: '2026-07-20',
                    greeksEnabled: false,
                    futuresPool: [{
                        id: 'future_sep', contractMonth: '202609', conId: 60901,
                    }],
                    groups: [{
                        id: 'group_es_daily',
                        liveData: true,
                        legs: [{
                            id: 'leg_es_jul22_call',
                            type: 'call',
                            pos: 1,
                            strike: 7520,
                            expDate: '2026-07-22',
                            underlyingFutureId: '',
                            currentPrice: null,
                        }],
                    }],
                    hedges: [],
                };
                class MockWebSocket {
                    constructor() { this.sent = []; MockWebSocket.instance = this; }
                    send(message) { this.sent.push(message); }
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
                        renderGroups() {}, updateDerivedValues() {}, flashElement() {},
                        requestAnimationFrame(callback) { callback(); },
                        document: {
                            activeElement: null,
                            getElementById() { return null; },
                            querySelector() { return null; },
                            querySelectorAll() { return []; },
                        },
                        localStorage: { getItem() { return null; }, setItem() {} },
                        location: { protocol: 'file:', hostname: '' },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const subscribe = MockWebSocket.instance.sent
                    .map(message => JSON.parse(message))
                    .find(message => message.action === 'subscribe');
                assert.equal(state.groups[0].legs[0].underlyingFutureId, 'future_sep');
                assert.equal(subscribe.options.length, 1);
                assert.equal(subscribe.options[0].expDate, '20260722');
                assert.equal(subscribe.options[0].underlyingContractMonth, '202609');
                assert.equal(Object.prototype.hasOwnProperty.call(
                    subscribe.options[0], 'tradingClass'
                ), false);

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-20T17:00:00.000Z',
                    options: {
                        leg_es_jul22_call: {
                            bid: 22.5,
                            ask: 23,
                            mark: 22.75,
                            quoteAsOf: '2026-07-20T17:00:00.000Z',
                            conId: 7227520,
                            secType: 'FOP',
                            symbol: 'ES',
                            localSymbol: 'ES qualified daily call',
                            tradingClass: 'IB_ACTUAL_CLASS',
                            right: 'C',
                            strike: 7520,
                            optionExpiry: '20260722',
                            multiplier: '50',
                            underConId: 60901,
                            underlyingContractMonth: '202609',
                            underlyingBindingVerified: true,
                            expiryAsOf: '2026-07-22T20:00:00.000Z',
                            expiryTimingSource: 'ib_contract_details',
                            lastTradeDate: '20260722',
                            lastTradeTime: '15:00:00',
                            timeZoneId: 'US/Central',
                        },
                    },
                });

                const quote = ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_es_jul22_call');
                assert.equal(quote.mark, 22.75);
                assert.equal(quote.tradingClass, 'IB_ACTUAL_CLASS');
                assert.equal(state.groups[0].legs[0].currentPrice, 22.75);
                assert.equal(state.groups[0].legs[0].liveQuoteIdentityStatus, 'verified');
                assert.equal(state.groups[0].legs[0].qualifiedOptionTradingClass, 'IB_ACTUAL_CLASS');
                assert.equal(state.groups[0].legs[0].expiryAsOf, '2026-07-22T20:00:00.000Z');
            },
        },
        {
            name: 'qualifies a Tuesday CL FOP that the ML3 weekly class guess would have rejected',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'CL',
                    underlyingContractMonth: '202609',
                    underlyingPrice: 84.43,
                    simulatedDate: '2026-08-04',
                    baseDate: '2026-07-22',
                    greeksEnabled: false,
                    futuresPool: [{
                        id: 'future_sep', contractMonth: '202609', conId: 70102,
                    }],
                    groups: [{
                        id: 'group_cl_calendar',
                        liveData: true,
                        legs: [{
                            id: 'leg_cl_aug04_call',
                            type: 'call',
                            pos: 1,
                            strike: 85,
                            // A Tuesday.  ML3 is a Monday week-3 crude class.
                            expDate: '2026-08-04',
                            underlyingFutureId: '',
                            currentPrice: null,
                        }],
                    }],
                    hedges: [],
                };
                class MockWebSocket {
                    constructor() { this.sent = []; MockWebSocket.instance = this; }
                    send(message) { this.sent.push(message); }
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
                        renderGroups() {}, updateDerivedValues() {}, flashElement() {},
                        requestAnimationFrame(callback) { callback(); },
                        document: {
                            activeElement: null,
                            getElementById() { return null; },
                            querySelector() { return null; },
                            querySelectorAll() { return []; },
                        },
                        localStorage: { getItem() { return null; }, setItem() {} },
                        location: { protocol: 'file:', hostname: '' },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const subscribe = MockWebSocket.instance.sent
                    .map(message => JSON.parse(message))
                    .find(message => message.action === 'subscribe');
                assert.equal(subscribe.options.length, 1);
                assert.equal(subscribe.options[0].expDate, '20260804');
                assert.equal(Object.prototype.hasOwnProperty.call(
                    subscribe.options[0], 'tradingClass'
                ), false);

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-22T17:00:00.000Z',
                    options: {
                        leg_cl_aug04_call: {
                            bid: 1.2,
                            ask: 1.3,
                            mark: 1.25,
                            quoteAsOf: '2026-07-22T17:00:00.000Z',
                            conId: 812345,
                            secType: 'FOP',
                            symbol: 'CL',
                            localSymbol: 'LO4Q6 C8500',
                            tradingClass: 'LO4',
                            right: 'C',
                            strike: 85,
                            optionExpiry: '20260804',
                            multiplier: '1000',
                            underConId: 70102,
                            underlyingContractMonth: '202609',
                            underlyingBindingVerified: true,
                            expiryAsOf: '2026-08-04T18:30:00.000Z',
                            expiryTimingSource: 'ib_contract_details',
                            lastTradeDate: '20260804',
                            lastTradeTime: '13:30:00',
                            timeZoneId: 'US/Central',
                        },
                    },
                });

                const leg = state.groups[0].legs[0];
                assert.equal(leg.currentPrice, 1.25);
                assert.equal(leg.liveQuoteIdentityStatus, 'verified');
                assert.equal(leg.qualifiedOptionTradingClass, 'LO4');
                // Without this the leg has no expiryAsOf and the simulated-date
                // projection fails closed as exact_contract_timing_missing.
                assert.equal(leg.expiryAsOf, '2026-08-04T18:30:00.000Z');
            },
        },
        {
            name: 'dedupes identical option contracts into one subscription and fans quotes out to aliases',
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
                    comboTemplateQuoteRequests: [
                        { id: 'combo_template_CL_20260420_C_75', type: 'call', strike: 75, expDate: '2026-04-20' },
                    ],
                    groups: [
                        {
                            id: 'group_a',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_a',
                                    type: 'call',
                                    pos: 1,
                                    strike: 75,
                                    expDate: '2026-04-20',
                                    underlyingFutureId: 'future_jul',
                                },
                            ],
                        },
                        {
                            id: 'group_b',
                            liveData: true,
                            legs: [
                                {
                                    id: 'leg_b',
                                    type: 'call',
                                    pos: -1,
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
                        requestAnimationFrame(callback) {
                            callback();
                        },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                            querySelectorAll() { return []; },
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
                completeMainSocketHandshake(MockWebSocket.instance);

                const sentMessages = MockWebSocket.instance.sent.map(message => JSON.parse(message));
                assert.equal(sentMessages[0].action, 'request_ib_connection_status');
                const subscribeMessage = sentMessages.find(message => message.action === 'subscribe');
                assert.ok(subscribeMessage);
                // Template request + two legs on the same contract collapse into one line.
                assert.equal(subscribeMessage.options.length, 1);
                assert.equal(subscribeMessage.options[0].id, 'combo_template_CL_20260420_C_75');
                // The FOP qualification hint survives even though the template
                // request (which has none) claimed the canonical slot first.
                assert.equal(subscribeMessage.options[0].underlyingContractMonth, '202607');

                ctx.processLiveMarketData({
                    options: {
                        combo_template_CL_20260420_C_75: {
                            bid: 1.2,
                            ask: 1.4,
                            conId: 42075,
                            secType: 'FOP',
                            symbol: 'CL',
                            localSymbol: 'LOJ6 C7500',
                            tradingClass: 'ML3',
                            right: 'C',
                            strike: 75,
                            optionExpiry: '20260420',
                            multiplier: '1000',
                            underConId: 60701,
                            underlyingContractMonth: '202607',
                            underlyingBindingVerified: true,
                            expiryAsOf: '2026-04-20T18:30:00.000Z',
                            expiryTimingSource: 'ib_contract_details',
                            lastTradeDate: '20260420',
                            lastTradeTime: '13:30:00',
                            timeZoneId: 'US/Central',
                            realExpirationDate: '20260420',
                        },
                    },
                });

                const canonicalQuote = ctx.OptionComboWsLiveQuotes.getOptionQuote('combo_template_CL_20260420_C_75');
                const legAQuote = ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_a');
                const legBQuote = ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_b');
                assert.equal(canonicalQuote.bid, 1.2);
                assert.equal(legAQuote.bid, 1.2);
                assert.equal(legAQuote.ask, 1.4);
                assert.equal(legBQuote.bid, 1.2);
                assert.equal(legBQuote.ask, 1.4);
                assert.equal(state.groups[0].legs[0].expiryAsOf, '2026-04-20T18:30:00.000Z');
                assert.equal(state.groups[1].legs[0].expiryAsOf, '2026-04-20T18:30:00.000Z');
                assert.equal(state.groups[0].legs[0].expiryTimeZoneId, 'US/Central');
                assert.equal(state.groups[0].legs[0].qualifiedOptionConId, 42075);
                assert.equal(state.groups[0].legs[0].qualifiedOptionUnderConId, 60701);
                assert.equal(state.groups[0].legs[0].qualifiedOptionUnderlyingContractMonth, '202607');

                ctx.handleLiveSubscriptions({ force: true });
                assert.equal(state.groups[0].legs[0].expiryAsOf, undefined);
                assert.equal(state.groups[1].legs[0].expiryAsOf, undefined);
            },
        },
        {
            name: 'accepts FOP quotes after a futures roll instead of asserting the old month conId',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '202612',
                    underlyingPrice: 7516.25,
                    simulatedDate: '2026-07-22',
                    baseDate: '2026-07-22',
                    greeksEnabled: false,
                    // Rolled from 202609 to 202612: the entry still carries the
                    // conId and qualified month IB confirmed for September.
                    futuresPool: [{
                        id: 'future_front',
                        contractMonth: '202612',
                        conId: 495512563,
                        secType: 'FUT',
                        symbol: 'ES',
                        qualifiedContractMonth: '202609',
                        requestIdentityVerified: true,
                        liveQuoteIdentityStatus: 'verified',
                    }],
                    comboTemplateQuoteRequests: [],
                    groups: [{
                        id: 'group_es',
                        liveData: true,
                        legs: [{
                            id: 'leg_dec', type: 'call', pos: 1, currentPrice: 20,
                            strike: 7520, expDate: '2026-08-21',
                            underlyingFutureId: 'future_front',
                        }],
                    }],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() { this.sent = []; MockWebSocket.instance = this; }
                    send(message) { this.sent.push(message); }
                    close() {}
                }

                const ctx = loadBrowserScripts(
                    ['js/session_logic.js', 'js/product_registry.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {}, updateDerivedValues() {}, flashElement() {},
                        requestAnimationFrame(callback) { callback(); },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                            querySelectorAll() { return []; },
                        },
                        localStorage: { getItem() { return null; }, setItem() {} },
                        location: { protocol: 'file:', hostname: '' },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();

                // IB qualifies the December FOP and returns the December
                // underlying conId, which is the correct answer.
                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-22T17:00:00.000Z',
                    options: {
                        leg_dec: {
                            bid: 19.5, ask: 20.5, mark: 20,
                            quoteAsOf: '2026-07-22T17:00:00.000Z',
                            conId: 7227520,
                            secType: 'FOP', symbol: 'ES',
                            localSymbol: 'ES qualified dec call',
                            right: 'C', strike: 7520,
                            optionExpiry: '20260821', multiplier: '50',
                            underConId: 511223344,
                            underlyingContractMonth: '202612',
                            underlyingBindingVerified: true,
                            expiryAsOf: '2026-08-21T20:00:00.000Z',
                            expiryTimingSource: 'ib_contract_details',
                            lastTradeDate: '20260821',
                            lastTradeTime: '15:00:00',
                            timeZoneId: 'US/Central',
                        },
                    },
                });

                const leg = state.groups[0].legs[0];
                assert.equal(leg.liveQuoteIdentityStatus, 'verified');
                assert.equal(leg.currentPrice, 20);
                assert.equal(leg.expiryAsOf, '2026-08-21T20:00:00.000Z');
            },
        },
        {
            name: 'keeps otherwise identical FOPs on different futures months separate and rejects mismatched identity',
            run() {
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingContractMonth: '',
                    underlyingPrice: 72.5,
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    greeksEnabled: false,
                    futuresPool: [
                        { id: 'future_jul', contractMonth: '202607', conId: 60701 },
                        { id: 'future_sep', contractMonth: '202609', conId: 60901 },
                    ],
                    comboTemplateQuoteRequests: [],
                    groups: [
                        {
                            id: 'group_jul',
                            liveData: true,
                            legs: [{
                                id: 'leg_jul', type: 'call', pos: 1, currentPrice: 0.5,
                                strike: 75, expDate: '2026-04-20', underlyingFutureId: 'future_jul',
                            }],
                        },
                        {
                            id: 'group_sep',
                            liveData: true,
                            legs: [{
                                id: 'leg_sep', type: 'call', pos: -1, currentPrice: 0.6,
                                strike: 75, expDate: '2026-04-20', underlyingFutureId: 'future_sep',
                            }],
                        },
                    ],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() { this.sent = []; MockWebSocket.instance = this; }
                    send(message) { this.sent.push(message); }
                    close() {}
                }

                const ctx = loadBrowserScripts(
                    ['js/session_logic.js', 'js/product_registry.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        requestAnimationFrame(callback) { callback(); },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                            querySelectorAll() { return []; },
                        },
                        localStorage: { getItem() { return null; }, setItem() {} },
                        location: { protocol: 'file:', hostname: '' },
                        WebSocket: MockWebSocket,
                    }
                );

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const sentMessages = MockWebSocket.instance.sent.map(message => JSON.parse(message));
                assert.equal(sentMessages[0].action, 'request_ib_connection_status');
                const subscribeMessage = sentMessages.find(message => message.action === 'subscribe');
                assert.ok(subscribeMessage);
                assert.equal(subscribeMessage.options.length, 2);
                assert.deepEqual(
                    subscribeMessage.options
                        .map(request => [request.id, request.underlyingContractMonth])
                        .sort(),
                    [['leg_jul', '202607'], ['leg_sep', '202609']]
                );

                const identity = {
                    conId: 42075,
                    secType: 'FOP',
                    symbol: 'CL',
                    localSymbol: 'LOJ6 C7500',
                    tradingClass: 'ML3',
                    right: 'C',
                    strike: 75,
                    optionExpiry: '20260420',
                    multiplier: '1000',
                    underConId: 60901,
                    underlyingContractMonth: '202609',
                    underlyingBindingVerified: true,
                };
                ctx.processLiveMarketData({
                    options: {
                        leg_jul: {
                            ...identity,
                            mark: 1.25,
                            expiryAsOf: '2026-04-20T18:30:00.000Z',
                            lastTradeDate: '20260420',
                        },
                    },
                });
                assert.equal(ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_jul'), null);
                assert.equal(state.groups[0].legs[0].currentPrice, 0.5);
                assert.equal(state.groups[0].legs[0].expiryAsOf, undefined);

                ctx.processLiveMarketData({
                    options: {
                        leg_jul: {
                            ...identity,
                            underConId: 60701,
                            underlyingContractMonth: '202607',
                            mark: 1.25,
                            expiryAsOf: '2026-04-20T18:30:00.000Z',
                            expiryTimingSource: 'ib_contract_details',
                            lastTradeDate: '20260420',
                        },
                    },
                });
                assert.equal(ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_jul').mark, 1.25);
                assert.equal(state.groups[0].legs[0].currentPrice, 1.25);
                assert.equal(state.groups[0].legs[0].qualifiedOptionUnderConId, 60701);
                assert.equal(state.groups[0].legs[0].expiryAsOf, '2026-04-20T18:30:00.000Z');

                ctx.processLiveMarketData({
                    options: {
                        leg_jul: {
                            ...identity,
                            mark: 9.99,
                            expiryAsOf: '2026-04-20T18:30:00.000Z',
                            lastTradeDate: '20260420',
                        },
                    },
                });
                assert.equal(ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_jul'), null);
                assert.equal(state.groups[0].legs[0].currentPrice, null);
                assert.equal(state.groups[0].legs[0].currentPriceSource, 'missing');
                assert.equal(state.groups[0].legs[0].expiryAsOf, undefined);
                assert.equal(state.groups[0].legs[0].qualifiedOptionConId, undefined);
                assert.equal(state.groups[0].legs[0].liveQuoteIdentityStatus, 'rejected');
                assert.match(state.groups[0].legs[0].liveQuoteIdentityReason, /underlying futures/);
            },
        },
        {
            name: 'accepts IB canonical SPX symbol for an SPXW option request',
            run() {
                const state = {
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 6200,
                    simulatedDate: '2026-04-01',
                    baseDate: '2026-04-01',
                    greeksEnabled: false,
                    futuresPool: [],
                    comboTemplateQuoteRequests: [],
                    groups: [{
                        id: 'group_spxw',
                        liveData: true,
                        legs: [{
                            id: 'leg_spxw', type: 'put', pos: 1, currentPrice: 1,
                            strike: 6200, expDate: '2026-04-20',
                        }],
                    }],
                    hedges: [],
                };
                class MockWebSocket {
                    constructor() { this.sent = []; MockWebSocket.instance = this; }
                    send(message) { this.sent.push(message); }
                    close() {}
                }
                const ctx = loadBrowserScripts(
                    ['js/session_logic.js', 'js/product_registry.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {}, updateDerivedValues() {}, flashElement() {},
                        requestAnimationFrame(callback) { callback(); },
                        document: {
                            getElementById() { return null; }, querySelector() { return null; },
                            querySelectorAll() { return []; },
                        },
                        localStorage: { getItem() { return null; }, setItem() {} },
                        location: { protocol: 'file:', hostname: '' },
                        WebSocket: MockWebSocket,
                    }
                );
                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const sentMessages = MockWebSocket.instance.sent.map(message => JSON.parse(message));
                assert.equal(sentMessages[0].action, 'request_ib_connection_status');
                const subscribeMessage = sentMessages.find(message => message.action === 'subscribe');
                assert.ok(subscribeMessage);
                const request = subscribeMessage.options[0];
                assert.equal(request.symbol, 'SPXW');
                assert.equal(request.tradingClass, 'SPXW');

                ctx.processLiveMarketData({
                    options: {
                        leg_spxw: {
                            mark: 12.5,
                            conId: 998877,
                            secType: 'OPT',
                            symbol: 'SPX',
                            localSymbol: 'SPXW  260420P06200000',
                            tradingClass: 'SPXW',
                            right: 'P',
                            strike: 6200,
                            optionExpiry: '20260420',
                            multiplier: '100',
                        },
                    },
                });
                assert.equal(state.groups[0].legs[0].currentPrice, 12.5);
                assert.equal(state.groups[0].legs[0].qualifiedOptionTradingClass, 'SPXW');
                assert.equal(state.groups[0].legs[0].liveQuoteIdentityStatus, 'verified');
            },
        },
        {
            name: 'auto-subscribes the initial ES front-month future and ignores an identical repeat intent',
            run() {
                const state = {
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '',
                    underlyingPrice: 7493.5,
                    simulatedDate: '2026-07-20',
                    baseDate: '2026-07-20',
                    greeksEnabled: false,
                    futuresPool: [],
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
                completeMainSocketHandshake(MockWebSocket.instance);

                const subscribeMessages = MockWebSocket.instance.sent
                    .map(message => JSON.parse(message))
                    .filter(message => message.action === 'subscribe');
                assert.equal(subscribeMessages.length, 1);
                assert.equal(state.underlyingContractMonth, '202609');
                assert.equal(state.futuresPool.length, 1);
                assert.equal(state.futuresPool[0].contractMonth, '202609');
                assert.equal(subscribeMessages[0].underlying.contractMonth, '202609');
                assert.equal(subscribeMessages[0].futures.length, 1);
                assert.equal(subscribeMessages[0].futures[0].contractMonth, '202609');

                const sentBeforeRepeat = MockWebSocket.instance.sent.length;
                assert.equal(ctx.handleLiveSubscriptions(), false);
                assert.equal(MockWebSocket.instance.sent.length, sentBeforeRepeat);
                assert.equal(state.futuresPool.length, 1);
            },
        },
        {
            name: 'unsubscribes all option quotes while keeping underlying and futures subscriptions',
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
                    comboTemplateQuoteRequests: [
                        { id: 'combo_template_CL_20260420_C_75', type: 'call', strike: 75, expDate: '2026-04-20' },
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

                let renderCalls = 0;
                const feedbackEl = {
                    textContent: '',
                    style: {},
                };
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
                        updateDerivedValues() {},
                        flashElement() {},
                        setTimeout() { return 0; },
                        clearTimeout() {},
                        document: {
                            getElementById(id) {
                                return id === 'unsubscribeOptionsFeedback' ? feedbackEl : null;
                            },
                            querySelector() { return null; },
                            querySelectorAll() { return []; },
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
                completeMainSocketHandshake(MockWebSocket.instance);

                const initialMessages = MockWebSocket.instance.sent.map(message => JSON.parse(message));
                assert.equal(initialMessages[0].action, 'request_ib_connection_status');
                const initialSubscribe = initialMessages.find(message => message.action === 'subscribe');
                assert.ok(initialSubscribe);
                assert.ok(initialSubscribe.options.length > 0);

                const sentBefore = MockWebSocket.instance.sent.length;
                const result = ctx.unsubscribeAllOptionQuotes();

                assert.equal(result, true);
                const subscribeMessages = MockWebSocket.instance.sent
                    .slice(sentBefore)
                    .map((message) => JSON.parse(message))
                    .filter((message) => message.action === 'subscribe');
                assert.equal(subscribeMessages.length, 1);
                assert.equal(subscribeMessages[0].options.length, 0);
                assert.equal(subscribeMessages[0].futures.length, 1);
                assert.equal(subscribeMessages[0].underlying.secType, 'FUT');
                assert.equal(state.groups[0].liveData, false);
                assert.equal(state.comboTemplateQuoteRequests.length, 0);
                assert.equal(renderCalls, 1);
                assert.equal(feedbackEl.style.display, 'block');
                assert.ok(feedbackEl.textContent.includes('market data turned off for 1 group'));
                assert.ok(feedbackEl.textContent.includes('1 combo finder quote released'));
            },
        },
        {
            name: 'reports failure when unsubscribing option quotes while disconnected',
            run() {
                const state = {
                    underlyingSymbol: 'CL',
                    underlyingPrice: 72.5,
                    greeksEnabled: false,
                    futuresPool: [],
                    comboTemplateQuoteRequests: [],
                    groups: [
                        { id: 'group_cl', liveData: true, legs: [] },
                    ],
                    hedges: [],
                };
                const feedbackEl = {
                    textContent: '',
                    style: {},
                };

                // Never fires onopen, so the client stays disconnected.
                class MockWebSocket {
                    send() {}

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
                        renderGroups() {
                            throw new Error('should not re-render when nothing changed');
                        },
                        updateDerivedValues() {},
                        setTimeout() { return 0; },
                        clearTimeout() {},
                        WebSocket: MockWebSocket,
                        document: {
                            getElementById(id) {
                                return id === 'unsubscribeOptionsFeedback' ? feedbackEl : null;
                            },
                            querySelector() { return null; },
                            querySelectorAll() { return []; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        location: {
                            protocol: 'file:',
                            hostname: '',
                        },
                    }
                );

                const result = ctx.unsubscribeAllOptionQuotes();

                assert.equal(result, false);
                // State stays untouched so a later retry still knows what to release.
                assert.equal(state.groups[0].liveData, true);
                assert.equal(feedbackEl.style.display, 'block');
                assert.ok(feedbackEl.textContent.includes('not connected'));
            },
        },
        {
            name: 'builds MES and MNQ live subscriptions with micro FUT and FOP multipliers',
            run() {
                [
                    { symbol: 'MES', multiplier: '5', strike: 5400, referenceSymbol: 'SPX' },
                    { symbol: 'MNQ', multiplier: '2', strike: 19500, referenceSymbol: 'NDX' },
                ].forEach(({ symbol, multiplier, strike, referenceSymbol }) => {
                    const state = {
                        underlyingSymbol: symbol,
                        underlyingContractMonth: '',
                        underlyingPrice: strike,
                        simulatedDate: '2026-04-16',
                        baseDate: '2026-04-16',
                        greeksEnabled: false,
                        futuresPool: [
                            { id: 'future_jun', contractMonth: '202606' },
                        ],
                        groups: [
                            {
                                id: `group_${symbol.toLowerCase()}`,
                                liveData: true,
                                legs: [
                                    {
                                        id: `leg_${symbol.toLowerCase()}_call`,
                                        type: 'call',
                                        pos: 1,
                                        strike,
                                        expDate: '2026-06-19',
                                        underlyingFutureId: 'future_jun',
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
                    completeMainSocketHandshake(MockWebSocket.instance);

                    const sentMessages = MockWebSocket.instance.sent.map(message => JSON.parse(message));
                    assert.equal(sentMessages[0].action, 'request_ib_connection_status');
                    const subscribeMessage = sentMessages.find(message => message.action === 'subscribe');
                    assert.ok(subscribeMessage);
                    assert.equal(subscribeMessage.underlying.secType, 'FUT');
                    assert.equal(subscribeMessage.underlying.symbol, symbol);
                    assert.equal(subscribeMessage.underlying.exchange, 'CME');
                    assert.equal(subscribeMessage.underlying.contractMonth, '202606');
                    assert.equal(subscribeMessage.underlying.multiplier, multiplier);
                    assert.equal(subscribeMessage.futures.length, 1);
                    assert.equal(subscribeMessage.futures[0].secType, 'FUT');
                    assert.equal(subscribeMessage.futures[0].symbol, symbol);
                    assert.equal(subscribeMessage.futures[0].exchange, 'CME');
                    assert.equal(subscribeMessage.futures[0].contractMonth, '202606');
                    assert.equal(subscribeMessage.futures[0].multiplier, multiplier);
                    assert.equal(subscribeMessage.options.length, 1);
                    assert.equal(subscribeMessage.options[0].secType, 'FOP');
                    assert.equal(subscribeMessage.options[0].symbol, symbol);
                    assert.equal(subscribeMessage.options[0].exchange, 'CME');
                    assert.equal(subscribeMessage.options[0].multiplier, multiplier);
                    assert.equal(subscribeMessage.options[0].underlyingMultiplier, multiplier);
                    assert.equal(subscribeMessage.options[0].underlyingContractMonth, '202606');
                    assert.equal(Object.prototype.hasOwnProperty.call(subscribeMessage.options[0], 'tradingClass'), false);
                    assert.equal(subscribeMessage.carryReferences.length, 1);
                    assert.equal(subscribeMessage.carryReferences[0].id, 'spot');
                    assert.equal(subscribeMessage.carryReferences[0].secType, 'IND');
                    assert.equal(subscribeMessage.carryReferences[0].symbol, referenceSymbol);
                    assert.equal(subscribeMessage.carryReferences[0].currency, 'USD');
                    assert.equal(subscribeMessage.carryReferences[0].purpose, 'diagnostic_net_carry_reference');
                });
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
            name: 'tolerates managed-account panel refresh failures while keeping account state',
            run() {
                const state = {
                    marketDataMode: 'live',
                    liveComboOrderAccounts: [],
                    liveComboOrderAccountsConnected: false,
                    selectedLiveComboOrderAccount: '',
                    groups: [],
                    hedges: [],
                };

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
                                throw new Error('account refresh exploded');
                            },
                        },
                        OptionComboDeltaHedgeUI: {
                            refreshDeltaHedgePanel() {
                                throw new Error('delta hedge panel exploded');
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

                assert.doesNotThrow(() => {
                    ctx._handleManagedAccountsMessage({
                        action: 'managed_accounts_update',
                        ibConnected: true,
                        accounts: ['DU12345'],
                    });
                });

                assert.deepEqual(state.liveComboOrderAccounts, ['DU12345']);
                assert.equal(state.liveComboOrderAccountsConnected, true);
                assert.equal(state.selectedLiveComboOrderAccount, 'DU12345');
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
            name: 'requests delta hedge broker preview through validate then preview only',
            run() {
                const state = {
                    marketDataMode: 'live',
                    greeksEnabled: true,
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 480,
                    simulatedDate: '2026-03-17',
                    baseDate: '2026-03-17',
                    selectedLiveComboOrderAccount: 'DU12345',
                    liveComboOrderAccounts: ['DU12345'],
                    liveComboOrderAccountsConnected: true,
                    deltaHedge: {
                        enabled: true,
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
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

                const uiUpdates = [];
                let autoSupervisorCalls = 0;
                const ctx = loadBrowserScripts(
                    [
                        'js/delta_hedge_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        OptionComboDeltaHedgeUI: {
                            applyBrokerPreviewState(appState) {
                                uiUpdates.push(appState.deltaHedge.status);
                            },
                            applyRecommendationPreview() {},
                        },
                        runDeltaHedgeAutoSupervisor() {
                            autoSupervisorCalls += 1;
                        },
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

                const requested = ctx.requestDeltaHedgeBrokerPreview({
                    actionable: true,
                    side: 'SELL',
                    quantity: 55,
                    currentNetDelta: 55,
                    projectedNetDelta: 0,
                    targetLower: -25,
                    targetUpper: 25,
                });

                assert.equal(requested, true);
                assert.equal(state.deltaHedge.status, 'pending_validation');
                assert.equal(MockWebSocket.instance.sent.length, 1);
                const validatePayload = JSON.parse(MockWebSocket.instance.sent[0]);
                assert.equal(validatePayload.action, 'validate_hedge_order');
                assert.equal(validatePayload.executionMode, 'preview');
                assert.equal(validatePayload.orderAction, 'SELL');
                assert.equal(validatePayload.quantity, 55);
                assert.equal(validatePayload.orderType, 'LMT');
                assert.equal(validatePayload.limitPrice, 481.25);
                assert.equal(validatePayload.account, 'DU12345');
                assert.notEqual(validatePayload.action, 'submit_hedge_order');

                MockWebSocket.instance.onmessage({
                    data: JSON.stringify({
                        action: 'hedge_order_validation_result',
                        hedgeId: validatePayload.hedgeId,
                        validation: {
                            valid: true,
                            hedgeId: validatePayload.hedgeId,
                            executionMode: 'preview',
                            secType: 'STK',
                            symbol: 'SPY',
                            localSymbol: 'SPY',
                            conId: 756733,
                        },
                    }),
                });

                assert.equal(state.deltaHedge.status, 'pending_preview');
                assert.equal(MockWebSocket.instance.sent.length, 2);
                const previewPayload = JSON.parse(MockWebSocket.instance.sent[1]);
                assert.equal(previewPayload.action, 'preview_hedge_order');
                assert.equal(previewPayload.executionMode, 'preview');
                assert.notEqual(previewPayload.action, 'submit_hedge_order');

                MockWebSocket.instance.onmessage({
                    data: JSON.stringify({
                        action: 'hedge_order_preview_result',
                        hedgeId: validatePayload.hedgeId,
                        preview: {
                            hedgeId: validatePayload.hedgeId,
                            executionMode: 'preview',
                            secType: 'STK',
                            symbol: 'SPY',
                            localSymbol: 'SPY',
                            orderAction: 'SELL',
                            quantity: 55,
                            orderType: 'LMT',
                            limitPrice: 481.3,
                            priceIncrement: 0.05,
                            projectedNetDelta: 0,
                            conId: 756733,
                        },
                    }),
                });

                assert.equal(state.deltaHedge.status, 'previewed');
                assert.equal(state.deltaHedge.pendingRequest, false);
                assert.equal(state.deltaHedge.lastPreview.symbol, 'SPY');
                assert.equal(state.deltaHedge.limitPrice, 481.3);
                assert.equal(state.deltaHedge.limitPriceTickSize, 0.05);
                assert.match(state.deltaHedge.lastPreview.priceAdjustmentMessage, /adjusted limit 481\.25 to 481\.3.*tick 0\.05/i);
                assert.equal(typeof state.deltaHedge.lastPreviewAt, 'string');
                assert.match(state.deltaHedge.lastPreviewAt, /^\d{4}-\d{2}-\d{2}T/);
                assert.equal(autoSupervisorCalls, 1);
                assert.equal(uiUpdates.includes('previewed'), true);
            },
        },
        {
            name: 'blocks delta hedge broker preview until a TWS account is selected',
            run() {
                const state = {
                    marketDataMode: 'live',
                    selectedLiveComboOrderAccount: '',
                    liveComboOrderAccounts: ['DU111111', 'F222222'],
                    liveComboOrderAccountsConnected: true,
                    deltaHedge: {
                        enabled: true,
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                        },
                    },
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
                        'js/delta_hedge_logic.js',
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

                const requested = ctx.requestDeltaHedgeBrokerPreview({
                    actionable: true,
                    side: 'SELL',
                    quantity: 55,
                    currentNetDelta: 55,
                    projectedNetDelta: 0,
                    targetLower: -25,
                    targetUpper: 25,
                });

                assert.equal(requested, false);
                assert.equal(state.deltaHedge.status, 'error');
                assert.match(state.deltaHedge.lastError, /select a tws account/i);
                assert.equal(MockWebSocket.instance.sent.length, 1);
                assert.equal(JSON.parse(MockWebSocket.instance.sent[0]).action, 'request_managed_accounts_snapshot');
            },
        },
        {
            name: 'blocks delta hedge submit until live hedge gate is enabled',
            run() {
                const state = {
                    marketDataMode: 'live',
                    allowLiveHedgeOrders: false,
                    selectedLiveComboOrderAccount: 'DU12345',
                    liveComboOrderAccounts: ['DU12345'],
                    liveComboOrderAccountsConnected: true,
                    deltaHedge: {
                        enabled: true,
                        status: 'previewed',
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        lastPreview: {
                            executionMode: 'preview',
                            orderAction: 'SELL',
                            quantity: 55,
                            orderType: 'LMT',
                            limitPrice: 481.25,
                        },
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
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
                        'js/delta_hedge_logic.js',
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

                const requested = ctx.requestDeltaHedgeSubmit({
                    actionable: true,
                    side: 'SELL',
                    quantity: 55,
                    currentNetDelta: 55,
                    projectedNetDelta: 0,
                    targetLower: -25,
                    targetUpper: 25,
                });

                assert.equal(requested, false);
                assert.equal(MockWebSocket.instance.sent.length, 0);
                assert.equal(state.deltaHedge.status, 'error');
                assert.match(state.deltaHedge.lastError, /live hedge order switch is off/i);
            },
        },
        {
            name: 'submits delta hedge after broker preview and locks resting order',
            run() {
                const state = {
                    marketDataMode: 'live',
                    allowLiveHedgeOrders: true,
                    portfolioPositionsConnected: true,
                    portfolioPositions: [],
                    selectedLiveComboOrderAccount: 'DU12345',
                    liveComboOrderAccounts: ['DU12345'],
                    liveComboOrderAccountsConnected: true,
                    deltaHedge: {
                        enabled: true,
                        status: 'previewed',
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        lastPreview: {
                            hedgeId: 'delta_hedge_stk_spy_spot',
                            executionMode: 'preview',
                            secType: 'STK',
                            symbol: 'SPY',
                            account: 'DU12345',
                            orderAction: 'SELL',
                            quantity: 55,
                            orderType: 'LMT',
                            limitPrice: 481.25,
                            conId: 756733,
                            projectedNetDelta: 0,
                            executionPlanToken: 'plan-ws-hedge-submit',
                        },
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
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
                        'js/delta_hedge_logic.js',
                        'js/leg_position_check.js',
                        'js/order_safety.js',
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

                const requested = ctx.requestDeltaHedgeSubmit({
                    actionable: true,
                    side: 'SELL',
                    quantity: 55,
                    currentNetDelta: 55,
                    projectedNetDelta: 0,
                    targetLower: -25,
                    targetUpper: 25,
                });

                assert.equal(requested, true);
                assert.equal(state.deltaHedge.status, 'placing');
                assert.equal(MockWebSocket.instance.sent.length, 1);
                const submitPayload = JSON.parse(MockWebSocket.instance.sent[0]);
                assert.equal(submitPayload.action, 'submit_hedge_order');
                assert.equal(submitPayload.executionMode, 'submit');
                assert.equal(submitPayload.requestSource, 'delta_hedge_manual_submit');
                assert.equal(submitPayload.orderAction, 'SELL');
                assert.equal(submitPayload.quantity, 55);
                assert.equal(submitPayload.limitPrice, 481.25);

                MockWebSocket.instance.onmessage({
                    data: JSON.stringify({
                        action: 'hedge_order_submit_result',
                        order: {
                            hedgeId: submitPayload.hedgeId,
                            executionMode: 'submit',
                            secType: 'STK',
                            symbol: 'SPY',
                            localSymbol: 'SPY',
                            orderAction: 'SELL',
                            quantity: 55,
                            orderType: 'LMT',
                            limitPrice: 481.25,
                            projectedNetDelta: 0,
                            conId: 756733,
                            orderId: 3101,
                            permId: 90001,
                            status: 'Submitted',
                        },
                    }),
                });

                assert.equal(state.deltaHedge.status, 'submitted');
                assert.equal(state.deltaHedge.orderState, 'resting_locked');
                assert.equal(state.deltaHedge.restingOrder.orderId, 3101);
                assert.equal(state.deltaHedge.restingOrder.permId, 90001);
                assert.equal(state.deltaHedge.restingOrder.side, 'SELL');
                assert.equal(state.deltaHedge.restingOrder.quantity, 55);
                assert.equal(state.deltaHedge.restingOrder.remainingQuantity, 55);
            },
        },
        {
            name: 'applies hedge fill updates to resting order and hedge rows once',
            run() {
                const state = {
                    marketDataMode: 'live',
                    allowLiveHedgeOrders: true,
                    deltaHedge: {
                        status: 'submitted',
                        orderState: 'resting_locked',
                        restingOrder: {
                            orderId: 3101,
                            permId: 90001,
                            side: 'SELL',
                            quantity: 55,
                            filledQuantity: 0,
                            remainingQuantity: 55,
                            status: 'Submitted',
                        },
                    },
                    groups: [],
                    hedges: [],
                };
                let renderHedgeCalls = 0;
                let derivedCalls = 0;

                const ctx = loadBrowserScripts(
                    [
                        'js/delta_hedge_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        renderHedges() {
                            renderHedgeCalls += 1;
                            derivedCalls += 1;
                        },
                        updateDerivedValues() { derivedCalls += 1; },
                        handleLiveSubscriptions() {},
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
                        WebSocket: function MockWebSocket() {},
                    }
                );

                const fillMessage = {
                    action: 'hedge_order_fill_update',
                    orderFill: {
                        hedgeId: 'delta_hedge_stk_spy_spot',
                        orderId: 3101,
                        permId: 90001,
                        secType: 'STK',
                        symbol: 'SPY',
                        orderAction: 'SELL',
                        quantity: 55,
                        executionId: 'exec-1',
                        lastFillQuantity: 20,
                        lastFillPrice: 481.2,
                        filledQuantity: 20,
                        avgFillPrice: 481.2,
                        costSource: 'execution_report',
                    },
                };

                assert.equal(ctx._handleHedgeOrderMessage(fillMessage), true);
                assert.equal(state.deltaHedge.restingOrder.filledQuantity, 20);
                assert.equal(state.deltaHedge.restingOrder.remainingQuantity, 35);
                assert.equal(state.deltaHedge.status, 'partial_fill_needs_review');
                assert.equal(state.deltaHedge.orderState, 'stale_needs_review');
                assert.equal(state.deltaHedge.restingOrder.staleReason, 'partial_fill_needs_review');
                assert.equal(state.hedges.length, 1);
                assert.equal(state.hedges[0].id, 'delta_hedge_stk_spy_spot');
                assert.equal(state.hedges[0].symbol, 'SPY');
                assert.equal(state.hedges[0].pos, -20);
                assert.equal(state.hedges[0].cost, 481.2);
                assert.equal(state.hedges[0].currentPrice, 481.2);

                assert.equal(ctx._handleHedgeOrderMessage(fillMessage), true);
                assert.equal(state.hedges[0].pos, -20);
                assert.equal(renderHedgeCalls, 1);
                assert.equal(derivedCalls, 1);
            },
        },
        {
            name: 'marks partial hedge status updates as needing manual review',
            run() {
                const state = {
                    marketDataMode: 'live',
                    deltaHedge: {
                        status: 'submitted',
                        orderState: 'resting_locked',
                        restingOrder: {
                            orderId: 3101,
                            permId: 90001,
                            side: 'SELL',
                            quantity: 55,
                            filledQuantity: 0,
                            remainingQuantity: 55,
                            status: 'Submitted',
                        },
                    },
                    groups: [],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/delta_hedge_logic.js',
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
                        WebSocket: function MockWebSocket() {},
                    }
                );

                assert.equal(ctx._handleHedgeOrderMessage({
                    action: 'hedge_order_status_update',
                    orderStatus: {
                        orderId: 3101,
                        permId: 90001,
                        status: 'Submitted',
                        filled: 20,
                        remaining: 35,
                        avgFillPrice: 481.2,
                    },
                }), true);

                assert.equal(state.deltaHedge.status, 'partial_fill_needs_review');
                assert.equal(state.deltaHedge.orderState, 'stale_needs_review');
                assert.equal(state.deltaHedge.restingOrder.staleReason, 'partial_fill_needs_review');
                assert.equal(ctx.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder(state.deltaHedge), true);
            },
        },
        {
            name: 'recovers active hedge order snapshot into resting lock',
            run() {
                const state = {
                    marketDataMode: 'live',
                    deltaHedge: {
                        enabled: true,
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        hedgeInstrument: {
                            secType: 'STK',
                            symbol: 'SPY',
                            exchange: 'SMART',
                            currency: 'USD',
                            multiplier: 1,
                            deltaPerUnit: 1,
                        },
                    },
                    groups: [],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/delta_hedge_logic.js',
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
                        WebSocket: function MockWebSocket() {},
                    }
                );

                assert.equal(ctx._handleHedgeOrderMessage({
                    action: 'active_hedge_orders_snapshot',
                    orders: [{
                        hedgeId: 'delta_hedge_stk_spy_spot',
                        secType: 'STK',
                        symbol: 'SPY',
                        localSymbol: 'SPY',
                        orderAction: 'BUY',
                        quantity: 12,
                        orderType: 'LMT',
                        limitPrice: 481.25,
                        orderId: 3101,
                        permId: 90001,
                        status: 'Submitted',
                        remaining: 12,
                    }],
                }), true);

                assert.equal(state.deltaHedge.status, 'submitted');
                assert.equal(state.deltaHedge.orderState, 'resting_locked');
                assert.equal(state.deltaHedge.restingOrder.orderId, 3101);
                assert.equal(state.deltaHedge.restingOrder.side, 'BUY');
                assert.equal(ctx.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder(state.deltaHedge), true);
            },
        },
        {
            name: 'terminal hedge status releases resting order lock',
            run() {
                const state = {
                    marketDataMode: 'live',
                    deltaHedge: {
                        status: 'submitted',
                        orderState: 'resting_locked',
                        restingOrder: {
                            orderId: 3101,
                            permId: 90001,
                            side: 'SELL',
                            quantity: 55,
                            filledQuantity: 20,
                            remainingQuantity: 35,
                            status: 'Submitted',
                        },
                    },
                    groups: [],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/delta_hedge_logic.js',
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
                        WebSocket: function MockWebSocket() {},
                    }
                );

                assert.equal(ctx._handleHedgeOrderMessage({
                    action: 'hedge_order_status_update',
                    orderStatus: {
                        orderId: 3101,
                        permId: 90001,
                        status: 'Filled',
                        filled: 55,
                        remaining: 0,
                        avgFillPrice: 481.2,
                    },
                }), true);

                assert.equal(state.deltaHedge.status, 'filled');
                assert.equal(state.deltaHedge.orderState, 'filled');
                assert.equal(state.deltaHedge.restingOrder.status, 'Filled');
                assert.equal(state.deltaHedge.restingOrder.remainingQuantity, 0);
                assert.equal(ctx.OptionComboDeltaHedgeLogic.hasActiveRestingHedgeOrder(state.deltaHedge), false);
            },
        },
        {
            name: 'requests hedge order cancel without live submit gate',
            run() {
                const state = {
                    marketDataMode: 'live',
                    allowLiveHedgeOrders: false,
                    deltaHedge: {
                        status: 'submitted',
                        orderState: 'resting_locked',
                        restingOrder: {
                            hedgeId: 'delta_hedge_stk_spy_spot',
                            orderId: 3101,
                            permId: 90001,
                            side: 'SELL',
                            quantity: 55,
                            remainingQuantity: 35,
                            status: 'Submitted',
                        },
                    },
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
                        'js/delta_hedge_logic.js',
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

                assert.equal(ctx.requestDeltaHedgeCancel(), true);
                assert.equal(state.deltaHedge.status, 'cancel_pending');
                assert.equal(MockWebSocket.instance.sent.length, 1);
                const payload = JSON.parse(MockWebSocket.instance.sent[0]);
                assert.equal(payload.action, 'cancel_hedge_order');
                assert.equal(payload.orderId, 3101);
                assert.equal(payload.permId, 90001);
            },
        },
        {
            name: 'applies hedge order cancel result as cancel pending until terminal status',
            run() {
                const state = {
                    marketDataMode: 'live',
                    deltaHedge: {
                        status: 'cancel_pending',
                        orderState: 'resting_locked',
                        restingOrder: {
                            orderId: 3101,
                            permId: 90001,
                            side: 'SELL',
                            quantity: 55,
                            remainingQuantity: 35,
                            status: 'Submitted',
                        },
                    },
                    groups: [],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    [
                        'js/delta_hedge_logic.js',
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
                        WebSocket: function MockWebSocket() {},
                    }
                );

                assert.equal(ctx._handleHedgeOrderMessage({
                    action: 'hedge_order_cancel_result',
                    orderStatus: {
                        orderId: 3101,
                        permId: 90001,
                        status: 'PendingCancel',
                        remaining: 35,
                        cancelRequested: true,
                    },
                }), true);

                assert.equal(state.deltaHedge.status, 'cancel_pending');
                assert.equal(state.deltaHedge.orderState, 'resting_locked');
                assert.equal(state.deltaHedge.restingOrder.status, 'PendingCancel');
                assert.equal(state.deltaHedge.restingOrder.cancelRequested, true);
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
                completeMainSocketHandshake(MockWebSocket.instance);

                const sentMessages = MockWebSocket.instance.sent.map(message => JSON.parse(message));
                assert.equal(sentMessages[0].action, 'request_ib_connection_status');
                const subscribeMessage = sentMessages.find(message => message.action === 'subscribe');
                assert.ok(subscribeMessage);
                assert.equal(subscribeMessage.greeksEnabled, true);
                assert.equal(subscribeMessage.underlying.secType, 'IND');
                assert.equal(subscribeMessage.options.length, 2);
                assert.equal(subscribeMessage.options[0].id, '__forward_rate_sample_30d_call');
                assert.equal(subscribeMessage.options[1].id, '__forward_rate_sample_30d_put');
                assert.equal(subscribeMessage.options[0].right, 'C');
                assert.equal(subscribeMessage.options[1].right, 'P');
                assert.equal(subscribeMessage.options[0].strike, 5800);
                assert.equal(subscribeMessage.options[0].expDate, '20260416');
            },
        },
        {
            name: 'refreshes and invalidates collapsed INDEX parity carry from the live data path',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPX',
                    underlyingPrice: 6300,
                    liveQuoteDate: '2026-07-17',
                    liveQuoteAsOf: '2026-07-17T20:00:00Z',
                    simulatedDate: '2026-07-17',
                    baseDate: '2026-07-17',
                    interestRate: 0,
                    useMarketDiscountCurve: true,
                    forwardRatePanelCollapsed: true,
                    forwardRateSamples: [{
                        id: 'sample_jul20',
                        expDate: '2026-07-20',
                        daysToExpiry: 3,
                        strike: 6300,
                        carryRate: 9,
                        forwardPrice: 9999,
                        isStale: false,
                    }],
                    groups: [],
                    hedges: [],
                    futuresPool: [],
                };
                let derivedRefreshes = 0;

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) {
                        this.sent.push(message);
                    }
                }

                const ctx = loadBrowserScripts(
                    [
                        'js/market_curves.js',
                        'js/product_registry.js',
                        'js/index_forward_rate.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() { derivedRefreshes += 1; },
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
                        WebSocket: MockWebSocket,
                    }
                );

                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const subscribe = MockWebSocket.instance.sent
                    .map(message => JSON.parse(message))
                    .find(message => message.action === 'subscribe');
                const requests = Object.fromEntries(subscribe.options.map(request => [request.id, request]));
                const callId = '__forward_rate_sample_jul20_call';
                const putId = '__forward_rate_sample_jul20_put';
                const expiryAsOf = '2026-07-20T13:30:00.000Z';
                const quoteAsOf = '2026-07-17T20:00:00.000Z';
                const optionQuote = (request, bid, ask, extra = {}) => ({
                    bid,
                    ask,
                    mark: (bid + ask) / 2,
                    markSource: 'bid_ask_mid',
                    bidPresent: true,
                    askPresent: true,
                    bidAskValid: ask >= bid,
                    bidAskStatus: ask >= bid ? 'two_sided' : 'crossed',
                    quoteAsOf,
                    expiryAsOf,
                    expiryTimingSource: 'ib_contract_details',
                    contractIdentitySource: 'ib_contract_details',
                    lastTradeDate: '20260720',
                    lastTradeTime: '09:30:00',
                    timeZoneId: 'US/Eastern',
                    conId: request.right === 'C' ? 101 : 102,
                    localSymbol: request.right === 'C' ? 'SPXW C' : 'SPXW P',
                    secType: request.secType,
                    symbol: request.symbol,
                    right: request.right,
                    strike: request.strike,
                    optionExpiry: request.expDate,
                    tradingClass: request.tradingClass,
                    multiplier: request.multiplier,
                    ...extra,
                });
                const underlyingQuote = {
                    bid: 6299.5,
                    ask: 6300.5,
                    mark: 6300,
                    markSource: 'market_price',
                    bidPresent: true,
                    askPresent: true,
                    bidAskValid: true,
                    bidAskStatus: 'two_sided',
                    quoteAsOf,
                };

                ctx.processLiveMarketData({
                    payloadAsOf: quoteAsOf,
                    underlyingPrice: 6300,
                    underlyingQuote,
                    options: {
                        [callId]: optionQuote(requests[callId], 5.1, 5.3),
                        [putId]: optionQuote(requests[putId], 4.9, 5.1),
                    },
                });

                const sample = state.forwardRateSamples[0];
                const expectedSeconds = (Date.parse(expiryAsOf) - Date.parse(quoteAsOf)) / 1000;
                assert.equal(sample.isStale, false);
                assert.equal(sample.tenorSeconds, expectedSeconds);
                assert.equal(sample.tenorDays, expectedSeconds / 86400);
                assert.ok(Number.isFinite(sample.carryRate));
                assert.notEqual(sample.forwardPrice, 9999);

                const beforeCurveForward = sample.forwardPrice;
                MockWebSocket.instance.onmessage({
                    data: JSON.stringify({
                        action: 'discount_curve_snapshot',
                        curve: {
                            schemaVersion: 2,
                            kind: 'hybrid_discount_curve',
                            snapshotId: 'usd:test-index-parity',
                            curveAsOf: '2026-07-17',
                            effectiveDate: '2026-07-17',
                            availableAsOf: quoteAsOf,
                            source: 'test',
                            curveSemantics: { discountingIsApproximate: true },
                            points: [
                                { tenorDays: 1, zeroRate: 0.10, discountFactor: Math.exp(-0.10 / 365), proxy: true },
                                { tenorDays: 365, zeroRate: 0.10, discountFactor: Math.exp(-0.10), proxy: true },
                            ],
                        },
                    }),
                });
                assert.ok(Math.abs(sample.discountRate - 0.10) < 1e-12);
                assert.notEqual(sample.forwardPrice, beforeCurveForward);

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:10.000Z',
                    options: {
                        [callId]: optionQuote(requests[callId], 5.4, 5.2, {
                            quoteAsOf: '2026-07-17T20:00:10.000Z',
                        }),
                    },
                });
                assert.equal(sample.carryRate, null);
                assert.equal(sample.forwardPrice, null);
                assert.equal(sample.isStale, true);
                assert.equal(sample.unavailableReason, 'call_bbo_unavailable');

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:20.000Z',
                    options: {
                        [callId]: optionQuote(requests[callId], 5.1, 5.3, {
                            quoteAsOf: '2026-07-17T20:00:20.000Z',
                            strike: 6305,
                        }),
                    },
                });
                assert.equal(sample.carryRate, null);
                assert.equal(sample.isStale, true);
                assert.match(sample.unavailableReason, /bbo_unavailable/);
                assert.ok(derivedRefreshes > 0);
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

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-03-19T14:00:00Z',
                    options: {
                        leg_slv_call: {
                            mark: 0.10,
                            bid: 0,
                            ask: 0.20,
                            iv: 0.31,
                            markSource: 'bid_ask_mid',
                            bidPresent: true,
                            askPresent: true,
                            bidAskValid: true,
                            bidAskStatus: 'two_sided',
                            quoteAsOf: '2026-03-19T14:00:00Z',
                        },
                    },
                });
                const zeroBidQuote = ctx.OptionComboWsLiveQuotes.getOptionQuote('leg_slv_call');
                assert.equal(zeroBidQuote.bid, 0);
                assert.equal(zeroBidQuote.ask, 0.20);
                assert.equal(zeroBidQuote.bidPresent, true);
                assert.equal(zeroBidQuote.bidAskValid, true);
                assert.equal(zeroBidQuote.bidAskStatus, 'two_sided');
                assert.equal(state.groups[0].legs[0].currentPrice, 0.10);
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
                            quoteAsOf: '2026-03-19T14:00:00Z',
                            lastTradeDate: '20260420',
                            localSymbol: 'CLJ6',
                            conId: 12345,
                        },
                    },
                });

                assert.equal(state.futuresPool[0].mark, 70.10);
                assert.equal(state.futuresPool[0].quoteAsOf, '2026-03-19T14:00:00Z');
                assert.equal(state.futuresPool[0].lastTradeDate, '20260420');
                assert.equal(state.futuresPool[0].localSymbol, 'CLJ6');
                assert.equal(state.futuresPool[0].conId, 12345);
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
                assert.equal(renderCalls, 0);
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
                assert.equal(renderCalls, 0);
                assert.equal(updateCalls, 1);
            },
        },
        {
            name: 'preserves readable reject reason when final submit result arrives after status update',
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
                                    orderId: 42567,
                                    permId: 429367627,
                                    status: 'Inactive',
                                    statusMessage: 'IB 201: Order rejected - reason: Available Funds are insufficient.',
                                },
                                lastError: 'IB 201: Order rejected - reason: Available Funds are insufficient.',
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
                        executionMode: 'submit',
                        orderId: 42567,
                        permId: 429367627,
                        status: 'Inactive',
                    },
                });

                assert.equal(handled, true);
                assert.equal(state.groups[0].tradeTrigger.status, 'error');
                assert.match(
                    state.groups[0].tradeTrigger.lastError,
                    /available funds are insufficient/i
                );
                assert.match(
                    state.groups[0].tradeTrigger.lastPreview.statusMessage,
                    /available funds are insufficient/i
                );
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
                assert.equal(renderCalls, 0);
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
                assert.equal(renderCalls, 0);
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
        {
            name: 'exposes an ES versus SPX diagnostic carry snapshot without changing the FOP pricing forward',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '202609',
                    underlyingPrice: 6298,
                    simulatedDate: '2026-07-17',
                    baseDate: '2026-07-17',
                    liveQuoteDate: '2026-07-17',
                    liveFuturesRequestGeneration: 1,
                    futuresPool: [{
                        id: 'future_sep', contractMonth: '202609',
                        bid: null, ask: null, mark: null, lastQuotedAt: null,
                    }],
                    groups: [],
                    hedges: [],
                };
                const ctx = loadBrowserScripts(
                    [
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/market_curves.js',
                        'js/index_forward_rate.js',
                        'js/pricing_context.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
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
                    payloadAsOf: '2026-07-17T20:00:00Z',
                    futures: {
                        future_sep: {
                            secType: 'FUT', symbol: 'ES', currency: 'USD',
                            exchange: 'CME', multiplier: '50',
                            localSymbol: 'ESU6', conId: 60901,
                            bid: 6299, ask: 6301, mark: 6300,
                            quoteAsOf: '2026-07-17T20:00:00Z',
                            contractMonth: '202609',
                            contractMonthSource: 'ib_contract_details',
                            lastTradeDate: '20260918',
                            requestIdentityVerified: true,
                            requestGeneration: 1,
                            requestId: 'isolated_test_generation_1',
                            requestedSecType: 'FUT',
                            requestedSymbol: 'ES',
                            requestedExchange: 'CME',
                            requestedCurrency: 'USD',
                            requestedMultiplier: '50',
                            requestedContractMonth: '202609',
                        },
                    },
                    carryReferences: {
                        spot: {
                            secType: 'IND', symbol: 'SPX', currency: 'USD',
                            bid: 6279, ask: 6281, mark: 6280,
                            quoteAsOf: '2026-07-17T20:00:00Z',
                        },
                    },
                });

                const reference = ctx.OptionComboWsLiveQuotes.getCarryReferenceQuote('spot');
                assert.equal(reference.symbol, 'SPX');
                assert.equal(reference.mark, 6280);
                const snapshot = ctx.OptionComboWsLiveQuotes.getForwardCarrySnapshot();
                assert.equal(snapshot.family, 'ES');
                assert.equal(snapshot.reference.symbol, 'SPX');
                assert.equal(snapshot.points[0].forwardPrice, 6300);
                assert.ok(Number.isFinite(snapshot.points[0].carryRate));
                const legForward = ctx.OptionComboPricingContext.resolveLegForwardObservation(
                    state,
                    { type: 'call', underlyingFutureId: 'future_sep' }
                );
                assert.equal(legForward.source, 'bound_futures_quote');
                assert.equal(legForward.forwardPrice, 6300);
            },
        },
        {
            name: 'automatically loads and refreshes the live discount curve by default',
            run() {
                const state = {
                    marketDataMode: 'live',
                    useMarketDiscountCurve: true,
                    discountCurve: null,
                    discountCurveLastError: '',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 600,
                    simulatedDate: '2026-07-19',
                    baseDate: '2026-07-19',
                    groups: [],
                    hedges: [],
                    futuresPool: [],
                    forwardRateSamples: [],
                };
                const refreshIntervals = [];
                let derivedRefreshes = 0;
                let controlRefreshes = 0;

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
                    ['js/session_logic.js', 'js/product_registry.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {
                            derivedRefreshes += 1;
                        },
                        requestAnimationFrame(callback) {
                            callback();
                            return 1;
                        },
                        setInterval(handler, delay) {
                            refreshIntervals.push({ handler, delay });
                            return refreshIntervals.length;
                        },
                        OptionComboControlPanelUI: {
                            refreshBoundDynamicControls() {
                                controlRefreshes += 1;
                            },
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
                        WebSocket: MockWebSocket,
                    }
                );

                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const initialActions = MockWebSocket.instance.sent.map(message => JSON.parse(message).action);
                assert.equal(initialActions.includes('request_discount_curve'), true);
                assert.equal(
                    initialActions[0],
                    'request_ib_connection_status',
                    'IB recovery status must be requested before any market-data work'
                );
                const discountRequestIndex = initialActions.indexOf('request_discount_curve');
                const subscriptionIndex = initialActions.indexOf('subscribe');
                assert.ok(discountRequestIndex > 0);
                assert.ok(
                    subscriptionIndex > discountRequestIndex,
                    'discount curve must be requested before market-data subscription work'
                );
                assert.equal(refreshIntervals.length, 2);
                assert.ok(refreshIntervals.some(entry => entry.delay === 5 * 1000));
                assert.ok(refreshIntervals.some(entry => entry.delay === 6 * 60 * 60 * 1000));

                assert.equal(ctx.requestDiscountCurveSnapshot({ manual: true, refresh: true }), true);
                assert.equal(state.discountCurveRequestPending, true);
                assert.deepEqual(
                    JSON.parse(MockWebSocket.instance.sent[MockWebSocket.instance.sent.length - 1]),
                    {
                        action: 'request_discount_curve',
                        refresh: true,
                        requestedBy: 'manual_control',
                    }
                );

                MockWebSocket.instance.onmessage({
                    data: JSON.stringify({
                        action: 'discount_curve_snapshot',
                        status: 'refreshed',
                        error: '',
                        curve: {
                            schemaVersion: 1,
                            kind: 'treasury_discount_curve',
                            effectiveDate: '2026-07-17',
                            quoteAsOf: '2026-07-17T19:30:00Z',
                            source: 'us_treasury_nominal_cmt',
                            points: [
                                { tenorCode: '1M', tenorDays: 31, parYield: 0.043 },
                                { tenorCode: '1Y', tenorDays: 365, parYield: 0.041 },
                            ],
                            curveSemantics: 'cmt_par_yield',
                        },
                    }),
                });

                const cachedCurve = state.discountCurve;
                assert.equal(cachedCurve.kind, 'discount');
                assert.equal(cachedCurve.asOf, '2026-07-17');
                assert.equal(cachedCurve.isProxy, true);
                assert.equal(state.discountCurveLastError, '');
                assert.equal(state.discountCurveRequestPending, false);
                assert.equal(state.discountCurveLastLoadWasManual, true);
                assert.equal(state.discountCurveLastResponseStatus, 'refreshed');
                assert.equal(derivedRefreshes, 1);
                assert.equal(controlRefreshes, 2);

                MockWebSocket.instance.onmessage({
                    data: JSON.stringify({
                        action: 'discount_curve_snapshot',
                        status: 'unavailable',
                        error: 'Treasury feed is temporarily unavailable.',
                        curve: null,
                    }),
                });
                assert.equal(state.discountCurve, cachedCurve);
                assert.equal(state.discountCurveLastError, 'Treasury feed is temporarily unavailable.');
                assert.equal(derivedRefreshes, 1);
                assert.equal(controlRefreshes, 3);

                MockWebSocket.instance.sent.length = 0;
                refreshIntervals.find(entry => entry.delay === 6 * 60 * 60 * 1000).handler();
                assert.deepEqual(
                    MockWebSocket.instance.sent.map(message => JSON.parse(message).action),
                    ['request_discount_curve']
                );
            },
        },
        {
            name: 'marks strict projection quotes stale on feed timeout and websocket close',
            run() {
                const state = {
                    marketDataMode: 'live',
                    useMarketDiscountCurve: false,
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 600,
                    simulatedDate: '2026-07-20',
                    baseDate: '2026-07-20',
                    groups: [],
                    hedges: [],
                    futuresPool: [],
                    forwardRateSamples: [],
                };
                const intervals = [];
                let derivedRefreshes = 0;

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) { this.sent.push(message); }
                    close() {}
                }

                const ctx = loadBrowserScripts(
                    [
                        'js/official_exchange_calendars.generated.js',
                        'js/market_holidays.js',
                        'js/date_utils.js',
                        'js/product_registry.js',
                        'js/market_curves.js',
                        'js/index_forward_rate.js',
                        'js/pricing_context.js',
                        'js/session_logic.js',
                        'js/ws_client.js',
                    ],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() { derivedRefreshes += 1; },
                        requestAnimationFrame(callback) { callback(); return 1; },
                        setTimeout() { return 1; },
                        clearTimeout() {},
                        setInterval(handler, delay) {
                            intervals.push({ handler, delay });
                            return intervals.length;
                        },
                        flashElement() {},
                        OptionComboControlPanelUI: {
                            refreshBoundDynamicControls() {},
                        },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                MockWebSocket.instance.onopen();
                assert.equal(ctx.OptionComboWsLiveQuotes.isConnected(), true);
                assert.equal(state.liveProjectionFeedConnected, true);
                assert.equal(state.liveProjectionFeedStale, true);

                const quoteAsOf = new Date().toISOString();
                MockWebSocket.instance.onmessage({
                    data: JSON.stringify({
                        underlyingPrice: 600,
                        underlyingQuote: { mark: 600, quoteAsOf },
                    }),
                });
                assert.equal(state.liveProjectionFeedStale, false);
                assert.ok(Number.isFinite(Date.parse(state.liveProjectionLastReceivedAt)));

                state.liveProjectionLastReceivedAt = new Date(Date.now() - 120001).toISOString();
                const watchdog = intervals.find(entry => entry.delay === 5000);
                assert.ok(watchdog);
                const beforeTimeoutRefresh = derivedRefreshes;
                watchdog.handler();
                assert.equal(state.liveProjectionFeedStale, true);
                assert.ok(derivedRefreshes > beforeTimeoutRefresh);

                state.liveProjectionFeedStale = false;
                const beforeCloseRefresh = derivedRefreshes;
                MockWebSocket.instance.onclose();
                assert.equal(ctx.OptionComboWsLiveQuotes.isConnected(), false);
                assert.equal(state.liveProjectionFeedConnected, false);
                assert.equal(state.liveProjectionFeedStale, true);
                assert.ok(derivedRefreshes > beforeCloseRefresh);
            },
        },
        {
            name: 'hydrates historical discount curves strictly as-of and rejects future replay data',
            run() {
                const state = {
                    marketDataMode: 'historical',
                    useMarketDiscountCurve: true,
                    discountCurve: null,
                    discountCurveLastError: '',
                    interestRate: 0.03,
                    baseDate: '2022-01-03',
                    historicalQuoteDate: '2022-01-03',
                    simulatedDate: '2022-01-03',
                    groups: [],
                    hedges: [],
                };

                const ctx = loadBrowserScripts(
                    ['js/session_logic.js', 'js/product_registry.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        flashElement() {},
                        OptionComboControlPanelUI: {
                            refreshBoundDynamicControls() {},
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

                const changed = ctx._applyHistoricalReplayMetadata({
                    riskFreeRate: 0.04,
                    historicalReplay: {
                        effectiveDate: '2022-01-04',
                        discountCurve: {
                            schemaVersion: 2,
                            kind: 'hybrid_discount_curve',
                            snapshotId: 'usd-reference:historical-test',
                            curveAsOf: '2022-01-04',
                            effectiveDate: '2022-01-03',
                            availableAsOf: '2022-01-04T23:00:00Z',
                            source: 'nyfed:sofr+treasury:test',
                            curveSemantics: { discountingIsApproximate: true },
                            points: [
                                {
                                    tenorDays: 30,
                                    zeroRate: 0.001,
                                    discountFactor: Math.exp(-0.001 * 30 / 365),
                                    proxy: true,
                                },
                                {
                                    tenorDays: 365,
                                    zeroRate: 0.004,
                                    discountFactor: Math.exp(-0.004),
                                    proxy: true,
                                },
                            ],
                        },
                    },
                });

                assert.equal(changed, true);
                assert.equal(state.interestRate, 0.04);
                assert.equal(state.discountCurve.kind, 'discount');
                assert.equal(state.discountCurve.asOf, '2022-01-04');
                assert.equal(state.discountCurve.effectiveDate, '2022-01-03');
                assert.equal(state.discountCurve.isProxy, true);
                assert.equal(state.discountCurve.snapshotId, 'usd-reference:historical-test');
                assert.equal(state.discountCurveLastError, '');

                const rejected = ctx._applyHistoricalReplayMetadata({
                    riskFreeRate: 0.035,
                    historicalReplay: {
                        effectiveDate: '2021-12-31',
                        discountCurve: {
                            schemaVersion: 2,
                            kind: 'sofr_discount_curve',
                            snapshotId: 'usd-reference:future-test',
                            curveAsOf: '2022-01-03',
                            effectiveDate: '2021-12-31',
                            availableAsOf: '2022-01-03T12:00:00Z',
                            source: 'nyfed:sofr',
                            points: [{
                                tenorDays: 30,
                                zeroRate: 0.001,
                                discountFactor: Math.exp(-0.001 * 30 / 365),
                                proxy: true,
                            }],
                        },
                    },
                });

                assert.equal(rejected, true);
                assert.equal(state.discountCurve, null);
                assert.match(state.discountCurveLastError, /Rejected future yield curve 2022-01-03/);
                assert.equal(state.interestRate, 0.035);
            },
        },
        {
            name: 'generation-scopes Futures Pool requests and clears wrong-contract or stale live quotes',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '202609',
                    underlyingPrice: 6300,
                    simulatedDate: '2026-07-17',
                    baseDate: '2026-07-17',
                    liveQuoteDate: '2026-07-17',
                    liveQuoteAsOf: '2026-07-17T19:59:00Z',
                    greeksEnabled: false,
                    futuresPool: [{
                        id: 'future_sep', contractMonth: '202609',
                        bid: 6299, ask: 6301, mark: 6300,
                        conId: 60901,
                        qualifiedContractMonth: '202609',
                        requestIdentityVerified: true,
                        liveQuoteIdentityStatus: 'verified',
                        secType: 'FUT', symbol: 'ES', multiplier: '50',
                    }],
                    comboTemplateQuoteRequests: [],
                    forwardRateSamples: [],
                    groups: [{
                        id: 'es_calendar',
                        liveData: true,
                        legs: [{
                            id: 'es_far_call', type: 'call', pos: 1,
                            strike: 6300, expDate: '2026-07-20',
                            underlyingFutureId: 'future_sep',
                        }],
                    }],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }
                    send(message) { this.sent.push(message); }
                    close() {}
                }

                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/session_logic.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/ws_client.js',
                ], {
                    state,
                    renderGroups() {},
                    updateDerivedValues() {},
                    flashElement() {},
                    requestAnimationFrame(callback) { callback(); return 1; },
                    document: {
                        getElementById() { return null; },
                        querySelector() { return null; },
                        querySelectorAll() { return []; },
                    },
                    localStorage: { getItem() { return null; }, setItem() {} },
                    location: { protocol: 'file:', hostname: '' },
                    WebSocket: MockWebSocket,
                });

                const futureQuote = (overrides = {}) => ({
                    bid: 6299,
                    ask: 6301,
                    mark: 6300,
                    quoteAsOf: '2026-07-17T20:00:00Z',
                    conId: 60901,
                    secType: 'FUT',
                    symbol: 'ES',
                    localSymbol: 'ESU6',
                    exchange: 'CME',
                    currency: 'USD',
                    multiplier: '50.0',
                    contractMonth: '202609',
                    contractMonthSource: 'ib_contract_details',
                    lastTradeDate: '20260918',
                    ...overrides,
                });

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const subscribeMessages = () => MockWebSocket.instance.sent
                    .map(message => JSON.parse(message))
                    .filter(message => message.action === 'subscribe');
                const firstSubscribe = subscribeMessages()[0];
                const firstWireId = firstSubscribe.futures[0].id;
                assert.equal(firstSubscribe.futuresRequestGeneration, 1);
                assert.match(firstWireId, /^frqg1x/);
                assert.equal(state.futuresPool[0].mark, null);
                assert.equal(state.futuresPool[0].liveQuoteIdentityStatus, 'pending');

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:00Z',
                    futures: { [firstWireId]: futureQuote() },
                });
                assert.equal(state.futuresPool[0].mark, 6300);
                assert.equal(state.futuresPool[0].qualifiedContractMonth, '202609');
                assert.equal(state.futuresPool[0].liveQuoteIdentityStatus, 'verified');
                assert.equal(state.futuresPool[0].liveQuoteRequestGeneration, 1);
                assert.equal(ctx.OptionComboWsLiveQuotes.getFutureQuote('future_sep').mark, 6300);

                const subscribeCountBeforeDuplicate = subscribeMessages().length;
                assert.equal(ctx.handleLiveSubscriptions(), false);
                assert.equal(subscribeMessages().length, subscribeCountBeforeDuplicate);
                assert.equal(state.futuresPool[0].mark, 6300);

                ctx.handleLiveSubscriptions({ force: true });
                const secondSubscribe = subscribeMessages().at(-1);
                const secondWireId = secondSubscribe.futures[0].id;
                assert.equal(secondSubscribe.futuresRequestGeneration, 2);
                assert.notEqual(secondWireId, firstWireId);
                assert.equal(state.futuresPool[0].mark, null);

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:10Z',
                    futures: { [firstWireId]: futureQuote({ quoteAsOf: '2026-07-17T20:00:10Z' }) },
                });
                assert.equal(state.futuresPool[0].mark, null);
                assert.equal(state.futuresPool[0].liveQuoteIdentityStatus, 'pending');

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:20Z',
                    futures: {
                        [secondWireId]: futureQuote({
                            quoteAsOf: '2026-07-17T20:00:20Z',
                            contractMonth: '202612',
                            lastTradeDate: '20261218',
                        }),
                    },
                });
                assert.equal(state.futuresPool[0].mark, null);
                assert.equal(state.futuresPool[0].bid, null);
                assert.equal(state.futuresPool[0].ask, null);
                assert.equal(state.futuresPool[0].liveQuoteIdentityStatus, 'rejected');
                assert.match(state.futuresPool[0].liveQuoteIdentityReason, /contract month mismatch/);

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:30Z',
                    futures: {
                        [secondWireId]: futureQuote({
                            quoteAsOf: '2026-07-17T20:00:30Z',
                            conId: 99999,
                        }),
                    },
                });
                assert.equal(state.futuresPool[0].mark, null);
                assert.match(state.futuresPool[0].liveQuoteIdentityReason, /conId mismatch/);

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:40Z',
                    futures: {
                        [secondWireId]: futureQuote({ quoteAsOf: '2026-07-17T20:00:40Z' }),
                    },
                });
                assert.equal(state.futuresPool[0].mark, 6300);
                assert.equal(state.futuresPool[0].liveQuoteRequestGeneration, 2);

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:02:41Z',
                    underlyingPrice: 6302,
                    underlyingQuote: {
                        mark: 6302,
                        quoteAsOf: '2026-07-17T20:02:41Z',
                    },
                });
                assert.equal(state.futuresPool[0].mark, null);
                assert.equal(state.futuresPool[0].bid, null);
                assert.equal(state.futuresPool[0].ask, null);
                assert.match(state.futuresPool[0].liveQuoteIdentityReason, /stale/);
                const unavailable = ctx.OptionComboPricingContext.resolveLegForwardObservation(
                    state,
                    state.groups[0].legs[0]
                );
                assert.equal(unavailable.usable, false);
            },
        },
        {
            name: 'accepts an energy future whose last trade date precedes its delivery month',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'CL',
                    underlyingContractMonth: '202609',
                    underlyingPrice: 64.5,
                    simulatedDate: '2026-07-17',
                    baseDate: '2026-07-17',
                    liveQuoteDate: '2026-07-17',
                    liveQuoteAsOf: '2026-07-17T19:59:00Z',
                    greeksEnabled: false,
                    futuresPool: [{
                        id: 'future_sep', contractMonth: '202609',
                        conId: null,
                        secType: 'FUT', symbol: 'CL',
                        exchange: 'NYMEX', currency: 'USD', multiplier: '1000',
                    }],
                    comboTemplateQuoteRequests: [],
                    forwardRateSamples: [],
                    groups: [{
                        id: 'cl_calendar',
                        liveData: true,
                        legs: [{
                            id: 'cl_call', type: 'call', pos: 1,
                            strike: 65, expDate: '2026-08-17',
                            underlyingFutureId: 'future_sep',
                        }],
                    }],
                    hedges: [],
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }
                    send(message) { this.sent.push(message); }
                    close() {}
                }

                const ctx = loadBrowserScripts([
                    'js/market_holidays.js',
                    'js/date_utils.js',
                    'js/session_logic.js',
                    'js/product_registry.js',
                    'js/index_forward_rate.js',
                    'js/pricing_context.js',
                    'js/ws_client.js',
                ], {
                    state,
                    renderGroups() {},
                    updateDerivedValues() {},
                    flashElement() {},
                    requestAnimationFrame(callback) { callback(); return 1; },
                    document: {
                        getElementById() { return null; },
                        querySelector() { return null; },
                        querySelectorAll() { return []; },
                    },
                    localStorage: { getItem() { return null; }, setItem() {} },
                    location: { protocol: 'file:', hostname: '' },
                    WebSocket: MockWebSocket,
                });

                ctx.connectWebSocket();
                MockWebSocket.instance.onopen();
                completeMainSocketHandshake(MockWebSocket.instance);
                const subscribe = MockWebSocket.instance.sent
                    .map(message => JSON.parse(message))
                    .find(message => message.action === 'subscribe');
                const wireId = subscribe.futures[0].id;

                // CLU6 delivers in Sep 2026 but stops trading 2026-08-20.  The
                // delivery month is only knowable from ContractDetails.
                const clQuote = (overrides = {}) => ({
                    bid: 64.4, ask: 64.6, mark: 64.5,
                    quoteAsOf: '2026-07-17T20:00:00Z',
                    conId: 70102,
                    secType: 'FUT', symbol: 'CL', localSymbol: 'CLU6',
                    exchange: 'NYMEX', currency: 'USD', multiplier: '1000',
                    contractMonth: '202609',
                    contractMonthSource: 'ib_contract_details',
                    lastTradeDate: '20260820',
                    ...overrides,
                });

                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:00Z',
                    futures: { [wireId]: clQuote() },
                });
                assert.equal(state.futuresPool[0].mark, 64.5);
                assert.equal(state.futuresPool[0].liveQuoteIdentityStatus, 'verified');
                assert.equal(state.futuresPool[0].qualifiedContractMonth, '202609');

                // Without ContractDetails evidence the month is only a guess,
                // so it must be reported unverified rather than silently trusted.
                ctx.processLiveMarketData({
                    payloadAsOf: '2026-07-17T20:00:10Z',
                    futures: {
                        [wireId]: clQuote({
                            quoteAsOf: '2026-07-17T20:00:10Z',
                            contractMonth: '202608',
                            contractMonthSource: 'last_trade_date',
                        }),
                    },
                });
                assert.equal(state.futuresPool[0].mark, null);
                assert.equal(state.futuresPool[0].liveQuoteIdentityStatus, 'rejected');
                assert.match(
                    state.futuresPool[0].liveQuoteIdentityReason,
                    /contract month unverified/
                );
                assert.equal(state.futuresPool[0].qualifiedContractMonth, '');
            },
        },
        {
            name: 'flags option legs the backend could not qualify instead of leaving them silently unquoted',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'QQQ',
                    groups: [
                        {
                            id: 'group_live',
                            liveData: true,
                            legs: [
                                { id: 'leg_missing', type: 'call', strike: 585, expDate: '2026-08-21', currentPrice: 4.2 },
                                { id: 'leg_ok', type: 'put', strike: 570, expDate: '2026-08-21', currentPrice: 3.1 },
                            ],
                        },
                    ],
                    hedges: [],
                };

                const warningCalls = [];
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
                        OptionComboGroupEditorUI: {
                            applyLiveSubscriptionWarnings(passedState) {
                                warningCalls.push(passedState);
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

                const handled = ctx._handleOptionSubscriptionStatusMessage({
                    action: 'option_subscription_status',
                    unresolved: [
                        {
                            id: 'leg_missing',
                            reason: 'contract_not_found',
                            symbol: 'QQQ',
                            right: 'C',
                            strike: 585,
                            expDate: '20260821',
                        },
                    ],
                });

                assert.equal(handled, true);

                const flagged = state.groups[0].legs[0];
                assert.equal(flagged.liveQuoteIdentityStatus, 'not_found');
                assert.equal(flagged.currentPrice, null);
                assert.equal(flagged.currentPriceSource, 'missing');
                assert.match(flagged.liveQuoteIdentityReason, /QQQ 2026-08-21 C 585/);
                assert.match(flagged.liveQuoteIdentityReason, /no matching contract/i);

                // A leg that did qualify must keep its quote untouched.
                const untouched = state.groups[0].legs[1];
                assert.equal(untouched.currentPrice, 3.1);
                assert.equal(untouched.liveQuoteIdentityStatus, undefined);

                assert.equal(state.liveSubscriptionUnresolvedById.leg_missing.reason, 'contract_not_found');
                assert.equal(warningCalls.length, 1);

                // An all-clear report clears the map so a re-resolved strike stops warning.
                ctx._handleOptionSubscriptionStatusMessage({
                    action: 'option_subscription_status',
                    unresolved: [],
                });
                assert.equal(Object.keys(state.liveSubscriptionUnresolvedById).length, 0);
                assert.equal(warningCalls.length, 2);
            },
        },
        {
            name: 'propagates an unresolved contract to duplicate legs that shared one deduped subscription',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'QQQ',
                    groups: [
                        {
                            id: 'group_a',
                            liveData: true,
                            legs: [{ id: 'leg_canonical', type: 'call', pos: 1, strike: 585, expDate: '2026-08-21' }],
                        },
                        {
                            // Same contract in a second group: deduped away, so the
                            // backend only ever names leg_canonical.
                            id: 'group_b',
                            liveData: true,
                            legs: [{ id: 'leg_duplicate', type: 'call', pos: -1, strike: 585, expDate: '2026-08-21' }],
                        },
                    ],
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

                const optionRequest = (id) => ({
                    id,
                    secType: 'OPT',
                    symbol: 'QQQ',
                    expDate: '20260821',
                    strike: 585,
                    right: 'C',
                    exchange: 'SMART',
                    currency: 'USD',
                    multiplier: '100',
                    tradingClass: 'QQQ',
                });

                const deduped = ctx._dedupeOptionRequestsForSubscription([
                    optionRequest('leg_canonical'),
                    optionRequest('leg_duplicate'),
                ]);
                assert.equal(deduped.length, 1);
                assert.equal(deduped[0].id, 'leg_canonical');

                ctx._handleOptionSubscriptionStatusMessage({
                    action: 'option_subscription_status',
                    unresolved: [{
                        id: 'leg_canonical',
                        reason: 'contract_not_found',
                        symbol: 'QQQ',
                        right: 'C',
                        strike: 585,
                        expDate: '20260821',
                    }],
                });

                // Both legs must warn, not just the one the backend named.
                assert.equal(state.groups[0].legs[0].liveQuoteIdentityStatus, 'not_found');
                assert.equal(state.groups[1].legs[0].liveQuoteIdentityStatus, 'not_found');
                assert.equal(state.groups[1].legs[0].currentPriceSource, 'missing');
                assert.equal(
                    state.liveSubscriptionUnresolvedById.leg_duplicate.label,
                    'QQQ 2026-08-21 C 585'
                );
            },
        },
        {
            name: 'invalidates live evidence and replays subscriptions once per unexpected IB recovery epoch',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    underlyingPrice: 600,
                    baseDate: '2026-07-20',
                    simulatedDate: '2026-07-20',
                    useMarketDiscountCurve: false,
                    liveProjectionFeedConnected: true,
                    liveProjectionFeedStale: false,
                    liveQuoteAsOf: '2026-07-20T14:00:00Z',
                    groups: [{
                        id: 'group_live',
                        liveData: true,
                        legs: [
                            {
                                id: 'leg_live',
                                type: 'call',
                                pos: 1,
                                strike: 600,
                                expDate: '2026-08-21',
                                currentPrice: 12.5,
                                currentPriceSource: 'live',
                                iv: 0.22,
                                ivSource: 'live',
                                portfolioMarketPrice: 12.6,
                                portfolioMarketPriceSource: 'tws_portfolio',
                                portfolioMarketPriceAsOf: '2026-07-20T14:00:00Z',
                                portfolioUnrealizedPnl: 125,
                            },
                            {
                                id: 'leg_manual',
                                type: 'put',
                                pos: 1,
                                strike: 590,
                                expDate: '2026-08-21',
                                currentPrice: 8.25,
                                currentPriceSource: 'manual',
                                iv: 0.24,
                                ivSource: 'manual',
                                ivManualOverride: true,
                            },
                        ],
                    }, {
                        id: 'group_disabled',
                        liveData: false,
                        legs: [{
                            id: 'leg_disabled_live',
                            type: 'call',
                            pos: 1,
                            strike: 610,
                            expDate: '2026-08-21',
                            currentPrice: 9.5,
                            currentPriceSource: 'live',
                            iv: 0.21,
                            ivSource: 'estimated',
                        }],
                    }],
                    hedges: [{
                        id: 'hedge_spy',
                        liveData: true,
                        secType: 'STK',
                        symbol: 'SPY',
                        currentPrice: 600,
                        currentPriceSource: 'live',
                    }, {
                        id: 'hedge_disabled',
                        liveData: false,
                        secType: 'STK',
                        symbol: 'QQQ',
                        currentPrice: 500,
                        currentPriceSource: 'live',
                    }],
                    futuresPool: [{
                        id: 'future_1',
                        contractMonth: '202609',
                        mark: 602,
                        bid: 601.75,
                        ask: 602.25,
                        quoteAsOf: '2026-07-20T14:00:00Z',
                        liveQuoteIdentityStatus: 'verified',
                    }],
                    forwardRateSamples: [],
                    liveComboOrderAccounts: [],
                    liveComboOrderAccountsConnected: false,
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) {
                        this.sent.push(JSON.parse(message));
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
                        requestAnimationFrame(callback) { callback(); return 1; },
                        setTimeout() { return 1; },
                        clearTimeout() {},
                        setInterval() { return 1; },
                        flashElement() {},
                        OptionComboControlPanelUI: {
                            refreshBoundDynamicControls() {},
                        },
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                const socket = MockWebSocket.instance;
                socket.onopen();
                assert.equal(
                    socket.sent[0].action,
                    'request_ib_connection_status'
                );
                assert.equal(
                    socket.sent.filter(payload => payload.action === 'subscribe').length,
                    0
                );
                assert.equal(
                    socket.sent.some(payload => payload.action === 'request_ib_connection_status'),
                    true
                );

                // Automatic subscription work stays behind the authoritative
                // status response for this specific browser socket.
                socket.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 3,
                        recoveryReason: 'startup',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                assert.equal(
                    socket.sent.filter(payload => payload.action === 'subscribe').length,
                    1
                );
                ctx.requestUnderlyingPriceSync();
                const manualUnderlyingSync = socket.sent.find(
                    payload => payload.action === 'sync_underlying'
                );
                assert.equal(manualUnderlyingSync.marketDataGeneration, 3);
                socket.sent.length = 0;

                socket.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 2,
                        recoveryReason: 'unexpected_disconnect',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                assert.equal(state.groups[0].legs[0].currentPrice, 12.5);

                socket.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 4,
                        recoveryReason: 'unexpected_disconnect',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });

                assert.equal(state.groups[0].legs[0].currentPrice, null);
                assert.equal(state.groups[0].legs[0].currentPriceSource, 'missing');
                assert.equal(state.groups[0].legs[0].ivSource, 'missing');
                assert.equal(state.groups[0].legs[0].portfolioMarketPrice, null);
                assert.equal(state.groups[0].legs[0].portfolioMarketPriceSource, '');
                assert.equal(state.groups[0].legs[0].portfolioMarketPriceAsOf, '');
                assert.equal(state.groups[0].legs[0].portfolioUnrealizedPnl, null);
                assert.equal(state.groups[0].legs[1].currentPrice, 8.25);
                assert.equal(state.groups[0].legs[1].currentPriceSource, 'manual');
                assert.equal(state.groups[0].legs[1].ivSource, 'manual');
                assert.equal(state.groups[1].legs[0].currentPrice, null);
                assert.equal(state.groups[1].legs[0].currentPriceSource, 'missing');
                assert.equal(state.groups[1].legs[0].ivSource, 'missing');
                assert.equal(state.hedges[0].currentPrice, null);
                assert.equal(state.hedges[1].currentPrice, null);
                assert.equal(state.hedges[1].currentPriceSource, 'missing');
                assert.equal(state.futuresPool[0].mark, null);
                assert.equal(state.liveProjectionFeedConnected, false);
                assert.equal(state.liveProjectionFeedStale, true);
                assert.deepEqual(socket.sent, []);

                // If the browser transport is down for the complete IB
                // recovery broadcast, its replacement asks for the current
                // epoch and remains unsubscribed until the ready reply.
                socket.onclose();
                ctx.connectWebSocket();
                const replacementSocket = MockWebSocket.instance;
                replacementSocket.onopen();
                assert.equal(
                    replacementSocket.sent.some(
                        payload => payload.action === 'request_ib_connection_status'
                    ),
                    true
                );
                assert.equal(
                    replacementSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        stocks: { SPY: { mark: 605 } },
                    }),
                });
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        marketDataGeneration: 3,
                        stocks: { SPY: { mark: 606 } },
                    }),
                });
                assert.equal(state.hedges[0].currentPrice, null);

                const ready = {
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 4,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                };
                replacementSocket.onmessage({ data: JSON.stringify(ready) });
                replacementSocket.onmessage({ data: JSON.stringify(ready) });

                const subscribePayloads = replacementSocket.sent.filter(
                    payload => payload.action === 'subscribe'
                );
                assert.equal(subscribePayloads.length, 1);
                assert.equal(subscribePayloads[0].marketDataGeneration, 4);
                assert.equal(
                    replacementSocket.sent.some(payload => [
                        'resume_managed_combo_order',
                        'concede_managed_combo_order',
                        'submit_combo_order',
                        'submit_hedge_order',
                        'cancel_managed_combo_order',
                    ].includes(payload.action)),
                    false
                );

                replacementSocket.onmessage({
                    data: JSON.stringify({
                        marketDataGeneration: 4,
                        stocks: { SPY: { mark: 610 } },
                    }),
                });
                assert.equal(state.hedges[0].currentPrice, 610);
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        ...ready,
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                    }),
                });
                assert.equal(
                    state.hedges[0].currentPrice,
                    610,
                    'same-generation ready to invalidated regression must be ignored'
                );

                replacementSocket.sent.length = 0;
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        ...ready,
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 5,
                        recoveryReason: 'explicit_stream_reset',
                        automaticReplayAllowed: false,
                    }),
                });
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        ...ready,
                        marketDataGeneration: 5,
                        recoveryReason: 'explicit_stream_reset',
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(
                    replacementSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );

                // Startup can initially report replay=false and learn that
                // subscriptions are required only when IB becomes ready. A
                // later authoritative ready=true status in the same epoch
                // must release that startup block.
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        ...ready,
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 6,
                        recoveryReason: 'startup',
                        automaticReplayAllowed: false,
                    }),
                });
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        ...ready,
                        marketDataGeneration: 6,
                        recoveryReason: 'startup',
                        automaticReplayAllowed: true,
                    }),
                });
                assert.equal(
                    replacementSocket.sent.filter(payload => payload.action === 'subscribe').length,
                    1
                );

                // The browser can miss the INVALIDATED broadcast and first
                // observe an explicit reset after IB is READY again. The
                // authoritative READY status must still persist the manual
                // replay boundary for later socket opens.
                replacementSocket.sent.length = 0;
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        ...ready,
                        marketDataGeneration: 7,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(vm.runInContext('_ibMarketDataGeneration', ctx), 7);
                assert.equal(vm.runInContext('_ibMarketDataState', ctx), 'ready');
                assert.equal(
                    vm.runInContext('_automaticReplayBlockedGeneration', ctx),
                    7
                );
                assert.deepEqual(replacementSocket.sent, []);

                replacementSocket.onmessage({
                    data: JSON.stringify({
                        action: 'market_data',
                        marketDataGeneration: 7,
                        stocks: { SPY: { mark: 612 } },
                    }),
                });
                assert.equal(state.hedges[0].currentPrice, 612);

                // An acknowledgement from an older reset is inert.
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        action: 'api_market_data_subscriptions_reset',
                        success: true,
                        marketDataGeneration: 6,
                        recoveryReason: 'explicit_stream_reset',
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(vm.runInContext('_ibMarketDataGeneration', ctx), 7);
                assert.equal(vm.runInContext('_ibMarketDataState', ctx), 'ready');
                assert.equal(state.hedges[0].currentPrice, 612);

                // A same-generation acknowledgement still invalidates stale
                // evidence and asserts the block, but cannot roll READY back
                // to INVALIDATED.
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        action: 'api_market_data_subscriptions_reset',
                        success: true,
                        marketDataGeneration: 7,
                        recoveryReason: 'explicit_stream_reset',
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(vm.runInContext('_ibMarketDataGeneration', ctx), 7);
                assert.equal(vm.runInContext('_ibMarketDataState', ctx), 'ready');
                assert.equal(
                    vm.runInContext('_automaticReplayBlockedGeneration', ctx),
                    7
                );
                assert.equal(state.hedges[0].currentPrice, null);

                // A fast reconnect can make the reset acknowledgement itself
                // the first observation of a higher generation's READY state.
                // Adopt it without losing the manual boundary.
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        action: 'api_market_data_subscriptions_reset',
                        success: true,
                        marketDataGeneration: 8,
                        marketDataState: 'ready',
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(vm.runInContext('_ibMarketDataGeneration', ctx), 8);
                assert.equal(vm.runInContext('_ibMarketDataState', ctx), 'ready');
                assert.equal(
                    vm.runInContext('_automaticReplayBlockedGeneration', ctx),
                    8
                );

                replacementSocket.onclose();
                ctx.connectWebSocket();
                const manuallyBlockedSocket = MockWebSocket.instance;
                manuallyBlockedSocket.onopen();
                assert.equal(
                    manuallyBlockedSocket.sent.some(
                        payload => payload.action === 'request_ib_connection_status'
                    ),
                    true
                );
                assert.equal(
                    manuallyBlockedSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );
            },
        },
        {
            name: 'does not block replacement-socket subscriptions for a clean ready epoch',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    useMarketDiscountCurve: false,
                    groups: [],
                    hedges: [],
                    futuresPool: [],
                    forwardRateSamples: [],
                    liveComboOrderAccounts: [],
                    liveComboOrderAccountsConnected: false,
                };

                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        MockWebSocket.instance = this;
                    }

                    send(message) {
                        this.sent.push(JSON.parse(message));
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
                        requestAnimationFrame(callback) { callback(); return 1; },
                        setTimeout() { return 1; },
                        clearTimeout() {},
                        setInterval() { return 1; },
                        flashElement() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                const firstSocket = MockWebSocket.instance;
                firstSocket.onopen();
                assert.equal(
                    firstSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );
                firstSocket.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 0,
                        recoveryReason: 'startup',
                        subscriptionsRequired: false,
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(
                    vm.runInContext('_automaticReplayBlockedGeneration', ctx),
                    null
                );
                assert.equal(
                    firstSocket.sent.filter(payload => payload.action === 'subscribe').length,
                    1
                );

                firstSocket.onclose();
                ctx.connectWebSocket();
                const replacementSocket = MockWebSocket.instance;
                replacementSocket.onopen();
                assert.equal(
                    replacementSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 0,
                        recoveryReason: 'startup',
                        subscriptionsRequired: false,
                        automaticReplayAllowed: false,
                    }),
                });
                replacementSocket.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 0,
                        recoveryReason: 'startup',
                        subscriptionsRequired: false,
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(
                    replacementSocket.sent.filter(
                        payload => payload.action === 'subscribe'
                    ).length,
                    1
                );

                // A later replacement starts from stale local READY state, but
                // still queues no automatic subscription before its own
                // authoritative explicit-reset response.
                replacementSocket.onclose();
                ctx.connectWebSocket();
                const resetBlockedSocket = MockWebSocket.instance;
                resetBlockedSocket.onopen();
                assert.equal(
                    resetBlockedSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );
                resetBlockedSocket.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 1,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(
                    resetBlockedSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );

                const startupUnavailable = {
                    action: 'ib_connection_status',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 2,
                    recoveryReason: 'startup_subscription_wait',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                };
                resetBlockedSocket.onmessage({
                    data: JSON.stringify(startupUnavailable),
                });
                resetBlockedSocket.onmessage({
                    data: JSON.stringify(startupUnavailable),
                });
                assert.equal(
                    resetBlockedSocket.sent.filter(
                        payload => payload.action === 'subscribe'
                    ).length,
                    1,
                    'startup-unavailable status should register intent exactly once'
                );
                resetBlockedSocket.onmessage({
                    data: JSON.stringify({
                        ...startupUnavailable,
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 3,
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                assert.equal(
                    resetBlockedSocket.sent.filter(
                        payload => payload.action === 'subscribe'
                    ).length,
                    2,
                    'the registered startup intent should replay after first connection'
                );
            },
        },
        {
            name: 'gates automatic subscriptions per socket and adopts a replacement backend generation namespace',
            run() {
                const state = {
                    marketDataMode: 'live',
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    useMarketDiscountCurve: false,
                    groups: [],
                    hedges: [],
                    futuresPool: [],
                    forwardRateSamples: [],
                    liveComboOrderAccounts: [],
                    liveComboOrderAccountsConnected: false,
                };
                const sockets = [];
                class MockWebSocket {
                    constructor() {
                        this.sent = [];
                        sockets.push(this);
                    }

                    send(message) {
                        this.sent.push(JSON.parse(message));
                    }

                    close() {}
                }
                const ctx = loadBrowserScripts(
                    ['js/session_logic.js', 'js/product_registry.js', 'js/ws_client.js'],
                    {
                        state,
                        renderGroups() {},
                        updateDerivedValues() {},
                        requestAnimationFrame(callback) { callback(); return 1; },
                        setTimeout() { return 1; },
                        clearTimeout() {},
                        setInterval() { return 1; },
                        flashElement() {},
                        alert() {},
                        document: {
                            getElementById() { return null; },
                            querySelector() { return null; },
                        },
                        localStorage: {
                            getItem() { return null; },
                            setItem() {},
                        },
                        WebSocket: MockWebSocket,
                    }
                );

                const first = sockets[0];
                first.onopen();
                assert.equal(ctx.handleLiveSubscriptions({ automatic: true }), false);
                assert.equal(
                    first.sent.some(payload => payload.action === 'subscribe'),
                    false
                );
                assert.equal(ctx.handleLiveSubscriptions(), true);
                assert.equal(
                    first.sent.filter(payload => payload.action === 'subscribe').length,
                    1,
                    'a direct user/manual subscription remains available before status'
                );

                first.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'server-a',
                        connected: true,
                        marketDataState: 'ready',
                        marketDataGeneration: 7,
                        recoveryReason: 'startup',
                        subscriptionsRequired: false,
                        automaticReplayAllowed: false,
                    }),
                });
                first.onmessage({
                    data: JSON.stringify({
                        action: 'api_market_data_subscriptions_reset',
                        success: true,
                        marketDataGeneration: 8,
                        marketDataState: 'invalidated',
                        recoveryReason: 'explicit_stream_reset',
                    }),
                });
                first.sent.length = 0;
                assert.equal(ctx.handleLiveSubscriptions({ automatic: true }), false);
                assert.equal(ctx.handleLiveSubscriptions(), true);
                assert.equal(
                    first.sent.filter(payload => payload.action === 'subscribe').length,
                    1,
                    'an explicit reset revokes automatic permission without disabling manual retry'
                );

                first.onclose();
                ctx.connectWebSocket();
                const replacement = sockets[1];
                replacement.onopen();
                replacement.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'server-b',
                        connected: true,
                        marketDataState: 'ready',
                        marketDataGeneration: 0,
                        recoveryReason: 'startup',
                        subscriptionsRequired: false,
                        automaticReplayAllowed: false,
                    }),
                });
                let subscriptions = replacement.sent.filter(
                    payload => payload.action === 'subscribe'
                );
                assert.equal(subscriptions.length, 1);
                assert.equal(subscriptions[0].marketDataGeneration, 0);

                replacement.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'server-b',
                        connected: true,
                        marketDataState: 'ready',
                        marketDataGeneration: 2,
                        recoveryReason: 'connected',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                replacement.sent.length = 0;
                replacement.onmessage({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'server-b',
                        connected: false,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 1,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(vm.runInContext('_ibMarketDataGeneration', ctx), 2);
                assert.deepEqual(replacement.sent, []);
            },
        },
    ],
};
