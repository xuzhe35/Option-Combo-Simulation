const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'chart_lab recovery',
    tests: [
        {
            name: 'invalidates the live overlay and replays once per socket and unexpected recovery epoch',
            run() {
                const appState = {
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    groups: [],
                };
                const ctx = loadBrowserScripts(['js/chart_lab.js'], {
                    __optionComboApp: {
                        getState() {
                            return appState;
                        },
                    },
                    document: {
                        readyState: 'loading',
                        addEventListener() {},
                        getElementById() { return null; },
                    },
                    localStorage: {
                        getItem() { return null; },
                    },
                    WebSocket: {
                        OPEN: 1,
                        CONNECTING: 0,
                    },
                });
                const testApi = ctx.OptionComboChartLab._test;
                const firstSocket = {
                    readyState: 1,
                    sent: [],
                    send(message) {
                        this.sent.push(JSON.parse(message));
                    },
                };
                testApi.setSocketForTest(firstSocket);
                testApi.setCurrentPriceForTest(602.5);

                testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 21,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });
                assert.equal(Number.isFinite(testApi.getRecoveryState().currentPrice), false);
                assert.deepEqual(firstSocket.sent, []);

                const ready = {
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 21,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                };
                testApi.handleIbConnectionStatus(ready);
                testApi.handleIbConnectionStatus(ready);
                assert.deepEqual(
                    firstSocket.sent.map(payload => payload.action),
                    ['subscribe', 'request_historical_bars']
                );
                assert.equal(firstSocket.sent[0].marketDataGeneration, 21);
                assert.equal(firstSocket.sent[1].marketDataGeneration, 21);

                const replacementSocket = {
                    readyState: 1,
                    sent: [],
                    send(message) {
                        this.sent.push(JSON.parse(message));
                    },
                };
                testApi.setSocketForTest(replacementSocket);
                testApi.handleIbConnectionStatus(ready);
                testApi.handleIbConnectionStatus(ready);
                assert.deepEqual(
                    replacementSocket.sent.map(payload => payload.action),
                    ['subscribe', 'request_historical_bars']
                );

                replacementSocket.sent.length = 0;
                testApi.handleIbConnectionStatus({
                    ...ready,
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 22,
                    recoveryReason: 'explicit_stream_reset',
                    automaticReplayAllowed: false,
                });
                testApi.handleIbConnectionStatus({
                    ...ready,
                    marketDataGeneration: 22,
                    recoveryReason: 'explicit_stream_reset',
                    automaticReplayAllowed: false,
                });
                assert.deepEqual(replacementSocket.sent, []);
            },
        },
        {
            name: 'queries status on every socket and avoids duplicating an already-ready open subscription',
            run() {
                const appState = {
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    groups: [],
                };
                const sockets = [];
                class MockWebSocket {
                    static OPEN = 1;
                    static CONNECTING = 0;

                    constructor() {
                        this.readyState = MockWebSocket.CONNECTING;
                        this.sent = [];
                        this.listeners = {};
                        sockets.push(this);
                    }

                    addEventListener(type, listener) {
                        if (!this.listeners[type]) this.listeners[type] = [];
                        this.listeners[type].push(listener);
                    }

                    send(message) {
                        this.sent.push(JSON.parse(message));
                    }

                    emit(type, event = {}) {
                        if (type === 'open') this.readyState = MockWebSocket.OPEN;
                        (this.listeners[type] || []).forEach(listener => listener(event));
                    }
                }

                const ctx = loadBrowserScripts(['js/chart_lab.js'], {
                    __optionComboApp: {
                        getState() {
                            return appState;
                        },
                    },
                    document: {
                        readyState: 'loading',
                        addEventListener() {},
                        getElementById() { return null; },
                    },
                    localStorage: {
                        getItem() { return null; },
                    },
                    setTimeout() { return 1; },
                    setInterval() { return 1; },
                    WebSocket: MockWebSocket,
                });
                const testApi = ctx.OptionComboChartLab._test;

                testApi.openSocket();
                const firstSocket = sockets[0];
                firstSocket.emit('open');
                assert.deepEqual(
                    firstSocket.sent.map(payload => payload.action),
                    ['request_ib_connection_status']
                );

                const alreadyReady = {
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 5,
                    recoveryReason: 'startup',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                };
                firstSocket.emit('message', { data: JSON.stringify(alreadyReady) });
                firstSocket.emit('message', {
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: true,
                    }),
                });
                assert.equal(
                    firstSocket.sent.filter(payload => payload.action === 'subscribe').length,
                    1
                );
                assert.equal(
                    firstSocket.sent.filter(
                        payload => payload.action === 'request_historical_bars'
                    ).length,
                    1
                );
                firstSocket.emit('message', {
                    data: JSON.stringify({ underlyingPrice: 699 }),
                });
                assert.equal(
                    Number.isFinite(testApi.getRecoveryState().currentPrice),
                    false,
                    'unstamped live payload must be rejected after an epoch is known'
                );
                firstSocket.emit('message', {
                    data: JSON.stringify({
                        marketDataGeneration: 5,
                        underlyingPrice: 601,
                    }),
                });
                assert.equal(testApi.getRecoveryState().currentPrice, 601);
                firstSocket.emit('message', {
                    data: JSON.stringify({
                        ...alreadyReady,
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 4,
                        recoveryReason: 'unexpected_disconnect',
                    }),
                });
                assert.equal(
                    testApi.getRecoveryState().currentPrice,
                    601,
                    'older invalidation status must be ignored'
                );

                firstSocket.emit('message', {
                    data: JSON.stringify({
                        ...alreadyReady,
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 6,
                        recoveryReason: 'unexpected_disconnect',
                    }),
                });
                firstSocket.emit('close');

                testApi.openSocket();
                const replacementSocket = sockets[1];
                replacementSocket.emit('open');
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
                replacementSocket.emit('message', {
                    data: JSON.stringify({ underlyingPrice: 700 }),
                });
                replacementSocket.emit('message', {
                    data: JSON.stringify({
                        marketDataGeneration: 5,
                        underlyingPrice: 701,
                    }),
                });
                assert.equal(
                    Number.isFinite(testApi.getRecoveryState().currentPrice),
                    false
                );

                const recovered = {
                    ...alreadyReady,
                    marketDataGeneration: 6,
                    recoveryReason: 'unexpected_disconnect',
                };
                replacementSocket.emit('message', { data: JSON.stringify(recovered) });
                replacementSocket.emit('message', { data: JSON.stringify(recovered) });
                assert.equal(
                    replacementSocket.sent.filter(payload => payload.action === 'subscribe').length,
                    1
                );
                replacementSocket.emit('message', {
                    data: JSON.stringify({
                        marketDataGeneration: 6,
                        underlyingPrice: 602,
                    }),
                });
                assert.equal(testApi.getRecoveryState().currentPrice, 602);
                replacementSocket.emit('message', {
                    data: JSON.stringify({
                        ...recovered,
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                    }),
                });
                assert.equal(
                    testApi.getRecoveryState().currentPrice,
                    602,
                    'same-generation ready to invalidated regression must be ignored'
                );

                replacementSocket.sent.length = 0;
                replacementSocket.emit('message', {
                    data: JSON.stringify({
                        ...recovered,
                        marketDataGeneration: 7,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 7);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
                assert.equal(
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    7
                );
                assert.deepEqual(replacementSocket.sent, []);

                replacementSocket.emit('message', {
                    data: JSON.stringify({
                        marketDataGeneration: 7,
                        underlyingPrice: 603,
                    }),
                });
                assert.equal(testApi.getRecoveryState().currentPrice, 603);
                replacementSocket.emit('message', {
                    data: JSON.stringify({
                        action: 'api_market_data_subscriptions_reset',
                        success: true,
                        marketDataGeneration: 6,
                    }),
                });
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 7);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
                assert.equal(testApi.getRecoveryState().currentPrice, 603);

                replacementSocket.emit('message', {
                    data: JSON.stringify({
                        action: 'api_market_data_subscriptions_reset',
                        success: true,
                        marketDataGeneration: 7,
                    }),
                });
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 7);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
                assert.equal(
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    7
                );
                assert.equal(
                    Number.isFinite(testApi.getRecoveryState().currentPrice),
                    false
                );

                replacementSocket.emit('message', {
                    data: JSON.stringify({
                        action: 'api_market_data_subscriptions_reset',
                        success: true,
                        marketDataGeneration: 8,
                        marketDataState: 'ready',
                    }),
                });
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 8);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
                assert.equal(
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    8
                );

                replacementSocket.readyState = 3;
                replacementSocket.emit('close');
                testApi.openSocket();
                const manuallyBlockedSocket = sockets[2];
                manuallyBlockedSocket.emit('open');
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
            name: 'releases a startup replay block when the same epoch becomes authoritative-ready',
            run() {
                const appState = {
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    groups: [],
                };
                const ctx = loadBrowserScripts(['js/chart_lab.js'], {
                    __optionComboApp: {
                        getState() {
                            return appState;
                        },
                    },
                    document: {
                        readyState: 'loading',
                        addEventListener() {},
                        getElementById() { return null; },
                    },
                    localStorage: {
                        getItem() { return null; },
                    },
                    WebSocket: {
                        OPEN: 1,
                        CONNECTING: 0,
                    },
                });
                const testApi = ctx.OptionComboChartLab._test;
                const socket = {
                    readyState: 1,
                    sent: [],
                    send(message) {
                        this.sent.push(JSON.parse(message));
                    },
                };
                testApi.setSocketForTest(socket);

                testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                });
                testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });

                assert.deepEqual(
                    socket.sent.map(payload => payload.action),
                    ['subscribe', 'request_historical_bars']
                );
            },
        },
        {
            name: 'keeps clean ready startup unblocked on a replacement socket',
            run() {
                const appState = {
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    groups: [],
                };
                const sockets = [];
                class MockWebSocket {
                    static OPEN = 1;
                    static CONNECTING = 0;

                    constructor() {
                        this.readyState = MockWebSocket.CONNECTING;
                        this.sent = [];
                        this.listeners = {};
                        sockets.push(this);
                    }

                    addEventListener(type, listener) {
                        if (!this.listeners[type]) this.listeners[type] = [];
                        this.listeners[type].push(listener);
                    }

                    send(message) {
                        this.sent.push(JSON.parse(message));
                    }

                    emit(type, event = {}) {
                        if (type === 'open') this.readyState = MockWebSocket.OPEN;
                        (this.listeners[type] || []).forEach(listener => listener(event));
                    }
                }

                const ctx = loadBrowserScripts(['js/chart_lab.js'], {
                    __optionComboApp: {
                        getState() {
                            return appState;
                        },
                    },
                    document: {
                        readyState: 'loading',
                        addEventListener() {},
                        getElementById() { return null; },
                    },
                    localStorage: {
                        getItem() { return null; },
                    },
                    setTimeout() { return 1; },
                    setInterval() { return 1; },
                    WebSocket: MockWebSocket,
                });
                const testApi = ctx.OptionComboChartLab._test;

                testApi.openSocket();
                const firstSocket = sockets[0];
                firstSocket.emit('open');
                assert.equal(
                    firstSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );
                firstSocket.emit('message', {
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
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    null
                );
                assert.equal(
                    firstSocket.sent.filter(payload => payload.action === 'subscribe').length,
                    1
                );

                firstSocket.readyState = 3;
                firstSocket.emit('close');
                testApi.openSocket();
                const replacementSocket = sockets[1];
                replacementSocket.emit('open');
                assert.equal(
                    replacementSocket.sent.some(payload => payload.action === 'subscribe'),
                    false
                );
                const cleanReady = {
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                };
                replacementSocket.emit('message', {
                    data: JSON.stringify(cleanReady),
                });
                replacementSocket.emit('message', {
                    data: JSON.stringify(cleanReady),
                });
                assert.equal(
                    replacementSocket.sent.filter(
                        payload => payload.action === 'subscribe'
                    ).length,
                    1
                );
                assert.equal(
                    replacementSocket.sent.filter(
                        payload => payload.action === 'request_historical_bars'
                    ).length,
                    1
                );

                replacementSocket.readyState = 3;
                replacementSocket.emit('close');
                testApi.openSocket();
                const resetBlockedSocket = sockets[2];
                resetBlockedSocket.emit('open');
                assert.deepEqual(
                    resetBlockedSocket.sent.map(payload => payload.action),
                    ['request_ib_connection_status']
                );
                resetBlockedSocket.emit('message', {
                    data: JSON.stringify({
                        ...cleanReady,
                        marketDataGeneration: 1,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                assert.deepEqual(
                    resetBlockedSocket.sent.map(payload => payload.action),
                    ['request_ib_connection_status']
                );

                const startupUnavailable = {
                    ...cleanReady,
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 2,
                    recoveryReason: 'startup_subscription_wait',
                };
                resetBlockedSocket.emit('message', {
                    data: JSON.stringify(startupUnavailable),
                });
                resetBlockedSocket.emit('message', {
                    data: JSON.stringify(startupUnavailable),
                });
                assert.equal(
                    resetBlockedSocket.sent.filter(
                        payload => payload.action === 'subscribe'
                    ).length,
                    1
                );
                assert.equal(
                    resetBlockedSocket.sent.filter(
                        payload => payload.action === 'request_historical_bars'
                    ).length,
                    1
                );
                resetBlockedSocket.emit('message', {
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
                    2
                );
            },
        },
        {
            name: 'adopts a restarted backend namespace and never restores an invalidated shared price',
            run() {
                const appState = {
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    underlyingPrice: 603.5,
                    groups: [],
                };
                const ctx = loadBrowserScripts(['js/chart_lab.js'], {
                    __optionComboApp: {
                        getState() {
                            return appState;
                        },
                    },
                    document: {
                        readyState: 'loading',
                        addEventListener() {},
                        getElementById() { return null; },
                    },
                    localStorage: {
                        getItem() { return null; },
                    },
                    WebSocket: { OPEN: 1, CONNECTING: 0 },
                });
                const testApi = ctx.OptionComboChartLab._test;
                const first = {
                    readyState: 1,
                    sent: [],
                    send(message) { this.sent.push(JSON.parse(message)); },
                };
                testApi.setSocketForTest(first);
                assert.equal(testApi.seedCurrentPriceFromSharedState(), true);

                testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'chart-server-a',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 7,
                    recoveryReason: 'connected',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });
                testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'chart-server-a',
                    connected: false,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 8,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });
                assert.equal(testApi.seedCurrentPriceFromSharedState(), false);
                assert.equal(
                    Number.isFinite(testApi.getRecoveryState().currentPrice),
                    false
                );

                const replacement = {
                    readyState: 1,
                    sent: [],
                    send(message) { this.sent.push(JSON.parse(message)); },
                };
                testApi.setSocketForTest(replacement);
                testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'chart-server-b',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                });
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 0);
                assert.equal(
                    replacement.sent.find(payload => payload.action === 'subscribe')
                        .marketDataGeneration,
                    0
                );

                testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'chart-server-b',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 2,
                    recoveryReason: 'connected',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });
                testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'chart-server-b',
                    connected: false,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 1,
                    recoveryReason: 'explicit_stream_reset',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: false,
                });
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 2);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
            },
        },
        {
            name: 'does not restore a shared price after the socket closes before status arrives',
            run() {
                const appState = {
                    underlyingSymbol: 'SPY',
                    underlyingContractMonth: '',
                    underlyingPrice: 603.5,
                    groups: [],
                };
                const sockets = [];
                class MockWebSocket {
                    static OPEN = 1;
                    static CONNECTING = 0;

                    constructor() {
                        this.readyState = MockWebSocket.CONNECTING;
                        this.sent = [];
                        this.listeners = {};
                        sockets.push(this);
                    }

                    addEventListener(type, listener) {
                        if (!this.listeners[type]) this.listeners[type] = [];
                        this.listeners[type].push(listener);
                    }

                    send(message) {
                        this.sent.push(JSON.parse(message));
                    }

                    emit(type, event = {}) {
                        if (type === 'open') this.readyState = MockWebSocket.OPEN;
                        (this.listeners[type] || []).forEach(listener => listener(event));
                    }
                }

                const ctx = loadBrowserScripts(['js/chart_lab.js'], {
                    __optionComboApp: {
                        getState() {
                            return appState;
                        },
                    },
                    document: {
                        readyState: 'loading',
                        addEventListener() {},
                        getElementById() { return null; },
                    },
                    localStorage: {
                        getItem() { return null; },
                    },
                    setTimeout() { return 1; },
                    setInterval() { return 1; },
                    WebSocket: MockWebSocket,
                });
                const testApi = ctx.OptionComboChartLab._test;

                assert.equal(testApi.seedCurrentPriceFromSharedState(), true);
                testApi.openSocket();
                sockets[0].emit('open');
                sockets[0].emit('close');

                assert.equal(testApi.seedCurrentPriceFromSharedState(), false);
                assert.equal(
                    Number.isFinite(testApi.getRecoveryState().currentPrice),
                    false
                );
                assert.equal(testApi.getRecoveryState().allowSharedPriceSeed, false);
            },
        },
    ],
};
