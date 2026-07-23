const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadPageContext(activeElement, overrides = {}) {
    const listeners = {};
    return loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/market_curves.js',
        'js/implied_lambda_handoff.js',
        'js/iv_term_structure_core.js',
        'js/iv_term_structure.js',
    ], {
        ...overrides,
        document: {
            readyState: 'loading',
            activeElement,
            getElementById() {
                return null;
            },
            addEventListener(type, handler) {
                listeners[type] = handler;
            },
        },
    });
}

function fixedDateClass(isoTimestamp) {
    const fixedMs = Date.parse(isoTimestamp);
    return class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [fixedMs]));
        }

        static now() {
            return fixedMs;
        }
    };
}

function createWebSocketHarness() {
    const sockets = [];
    class MockWebSocket {
        static OPEN = 1;
        static CONNECTING = 0;

        constructor() {
            this.readyState = MockWebSocket.CONNECTING;
            this.listeners = {};
            this.sent = [];
            this.closeCalls = [];
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
            if (type === 'close') this.readyState = 3;
            (this.listeners[type] || []).forEach(listener => listener(event));
        }

        close(code, reason) {
            this.closeCalls.push({ code, reason });
            this.readyState = 3;
        }
    }
    return { MockWebSocket, sockets };
}

function createCoherentPublicationFixture(options = {}) {
    const focusedStreamSelect = {
        matches(selector) {
            return selector === 'select[data-action="option-stream-limit"][data-symbol]';
        },
    };
    const FixedDate = fixedDateClass('2026-07-20T14:32:42.876Z');
    const ctx = loadPageContext(focusedStreamSelect, { Date: FixedDate });
    const testApi = ctx.OptionComboIvTermStructurePage._test;
    const card = testApi.createCardState({
        symbol: 'SPY',
        historyPath: 'iv_term_structure/data/SPY.json',
    }, { isExpanded: true });
    const anchorDate = '2026-07-20';
    const quoteAsOf = '2026-07-20T14:32:42.876Z';
    card.catalog = {
        anchorDate,
        expiryRows: [{
            expiry: '20260727', dte: 7, atmStrike: 750,
            atmCallSubId: '__ivts__spy_call',
            atmPutSubId: '__ivts__spy_put',
            subscriptionSelected: true,
        }],
    };

    const originalCompute = ctx.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas;
    ctx.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas = () => ({
        anchorDate,
        calendarKey: 'NYSE',
        varianceSource: 'straddle',
        snapshotId: 'focused-whole-1',
        quoteAsOf,
        methodology: { pricingModel: 'bsm-spot' },
        coverageStart: '2026-07-25',
        coverageEnd: '2026-07-26',
        byDate: { '2026-07-25': 0.2, '2026-07-26': 0.2 },
        medianLambda: 0.2,
        okIntervalCount: 1,
        intervals: [{
            startDate: '2026-07-24',
            endExpiry: '20260727',
            status: 'ok',
            rawLambda: 0.2,
            nonTradingDates: ['2026-07-25', '2026-07-26'],
            snapshotId: 'focused-whole-1',
            quoteAsOf,
        }],
        quality: {
            status: 'ok', coherent: true, quoteComplete: true,
            snapshotId: 'focused-whole-1',
            underlyingSnapshotId: 'focused-whole-1',
        },
    });
    const savedEntries = [];
    ctx.OptionComboImpliedLambdaHandoff.saveSymbolEntry = (entry) => {
        savedEntries.push(entry);
        return options.saveResult !== false;
    };
    ctx.OptionComboImpliedLambdaHandoff.peekSymbolEntry = () => null;

    const handlers = {};
    const ws = {
        addEventListener(type, handler) {
            handlers[type] = handler;
        },
    };
    card.ws = ws;
    testApi.attachSocketHandlers(card, ws);

    return {
        card,
        ctx,
        savedEntries,
        dispatch() {
            handlers.message({
                data: JSON.stringify({
                    action: 'iv_term_structure_quote_snapshot',
                    symbol: 'SPY',
                    anchorDate,
                    payloadAsOf: quoteAsOf,
                    batchId: 'focused-whole-1',
                    snapshotId: 'focused-whole-1',
                    coherent: true,
                    quoteComplete: true,
                    maxQuoteAgeSeconds: 120,
                    underlyingPrice: 750,
                    underlyingQuote: {
                        mark: 750,
                        quoteAsOf,
                        snapshotId: 'focused-whole-1',
                    },
                    options: {
                        __ivts__spy_call: {
                            bid: 4.9, ask: 5.1, mark: 5,
                            markSource: 'bid_ask_mid', quoteAsOf,
                            snapshotId: 'focused-whole-1',
                        },
                        __ivts__spy_put: {
                            bid: 4.8, ask: 5, mark: 4.9,
                            markSource: 'bid_ask_mid', quoteAsOf,
                            snapshotId: 'focused-whole-1',
                        },
                    },
                }),
            });
        },
        dispatchSyncComplete() {
            handlers.message({
                data: JSON.stringify({
                    action: 'iv_term_structure_sync_complete',
                    symbol: 'SPY',
                    expectedOptionCount: 2,
                    subscribedOptionCount: 2,
                    failedOptionCount: 0,
                }),
            });
        },
        restore() {
            ctx.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas = originalCompute;
        },
    };
}

function createFakeCardForViewState() {
    const samplingDetails = { open: true };
    const calendarDetails = { open: true };
    const bucketDetails = { open: true };
    const calendarShell = { scrollLeft: 31, scrollTop: 17 };
    const bucketShell = { scrollLeft: 47, scrollTop: 0 };
    const detailsShell = { scrollLeft: 59, scrollTop: 0 };
    const cardNode = {
        getAttribute(name) {
            return name === 'data-symbol' ? 'SPY' : '';
        },
        querySelector(selector) {
            return {
                '.ivts-sampling-details': samplingDetails,
                '.ivts-details': calendarDetails,
                '.ivts-calendar-finder': calendarDetails,
                '.ivts-bucket-summary': bucketDetails,
                '.ivts-calendar-table-shell': calendarShell,
                '.ivts-bucket-table-shell': bucketShell,
                '.ivts-details-table-shell': detailsShell,
            }[selector] || null;
        },
        querySelectorAll(selector) {
            return selector === '.ivts-details'
                ? [calendarDetails, bucketDetails]
                : [];
        },
    };
    const container = {
        querySelectorAll(selector) {
            return selector === '.ivts-card[data-symbol]' ? [cardNode] : [];
        },
    };

    return {
        bucketDetails,
        bucketShell,
        calendarDetails,
        calendarShell,
        container,
        detailsShell,
        samplingDetails,
    };
}

module.exports = {
    name: 'iv_term_structure.js',
    tests: [
        {
            name: 'allows remote IB catalog discovery up to ninety seconds',
            run() {
                const ctx = loadPageContext(null);
                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.IV_TERM_STRUCTURE_SNAPSHOT_TIMEOUT_MS,
                    90 * 1000
                );
                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.IV_TERM_STRUCTURE_ACK_TIMEOUT_MS,
                    8 * 1000
                );
                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.IV_TERM_STRUCTURE_PROTOCOL_VERSION,
                    '20260719.5'
                );
            },
        },
        {
            name: 'requires a fresh coherent quote snapshot when calculating lambda',
            run() {
                const ctx = loadPageContext(null);
                const evaluate = ctx.OptionComboIvTermStructurePage._test.evaluateLambdaSnapshotFreshness;
                const snapshot = {
                    expectedOptionCount: 2,
                    maxQuoteAgeSeconds: 120,
                    underlyingQuote: { quoteAsOf: '2026-07-17T20:00:30Z' },
                    quotesBySubId: {
                        call: { quoteAsOf: '2026-07-17T20:00:00Z' },
                        put: { quoteAsOf: '2026-07-17T20:00:45Z' },
                    },
                };

                assert.equal(evaluate(snapshot, Date.parse('2026-07-17T20:01:59Z')).fresh, true);
                const stale = evaluate(snapshot, Date.parse('2026-07-17T20:02:01Z'));
                assert.equal(stale.fresh, false);
                assert.equal(stale.status, 'stale_quote_set');
                assert.equal(evaluate({ ...snapshot, quotesBySubId: {} }, Date.now()).status, 'incomplete_quote_set');
            },
        },
        {
            name: 'archives implied-lambda exports by symbol, futures month, and UTC quote time',
            run() {
                const ctx = loadPageContext(null);
                const filename = ctx.OptionComboIvTermStructurePage._test
                    .buildImpliedLambdaExportFilename({
                        symbol: 'es',
                        underlyingContractMonth: '202609',
                        anchorDate: '2026-07-17',
                        quoteAsOf: '2026-07-17T15:01:02-05:00',
                    });
                assert.equal(
                    filename,
                    'implied_lambda_ES_202609_20260717T200102Z.json'
                );
            },
        },
        {
            name: 'detects focused baseline select inside a card before body rerenders',
            run() {
                const baselineSelect = {
                    matches(selector) {
                        return selector === 'select[data-action="baseline"][data-symbol]';
                    },
                };
                const ctx = loadPageContext(baselineSelect);
                const cardNode = {
                    contains(node) {
                        return node === baselineSelect;
                    },
                };

                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.isFocusedBaselineSelectInCard(cardNode),
                    true
                );
            },
        },
        {
            name: 'does not preserve card body when focus is outside the baseline select',
            run() {
                const focusedButton = {
                    matches() {
                        return false;
                    },
                };
                const ctx = loadPageContext(focusedButton);
                const cardNode = {
                    contains(node) {
                        return node === focusedButton;
                    },
                };

                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.isFocusedBaselineSelectInCard(cardNode),
                    false
                );
            },
        },
        {
            name: 'normalizes editable websocket endpoint inputs',
            run() {
                const ctx = loadPageContext(null);

                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.normalizeWsHost('ws://example.tailnet.ts.net:80/path'),
                    'example.tailnet.ts.net'
                );
                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.normalizeWsHost(''),
                    '127.0.0.1'
                );
                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.normalizeWsPort('443'),
                    443
                );
                assert.equal(
                    ctx.OptionComboIvTermStructurePage._test.normalizeWsPort('bad'),
                    8765
                );
            },
        },
        {
            name: 'uses the futures trade date after the Globex rollover',
            run() {
                const ctx = loadPageContext(null);
                const currentExchangeDate = ctx.OptionComboIvTermStructurePage._test.currentExchangeDate;

                assert.equal(
                    currentExchangeDate('CME:ES', new Date('2026-07-19T23:30:00Z')),
                    '2026-07-20'
                );
                assert.equal(
                    currentExchangeDate('NYSE', new Date('2026-07-18T00:15:00Z')),
                    '2026-07-17'
                );
            },
        },
        {
            name: 'requests and applies the shared unified discount curve on the control socket',
            run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const handlers = {};
                const sent = [];
                const ws = {
                    addEventListener(type, handler) {
                        handlers[type] = handler;
                    },
                    send(message) {
                        sent.push(JSON.parse(message));
                    },
                };
                testApi.setControlSocketForTest(ws);
                testApi.attachControlSocketHandlers(ws);
                handlers.open();
                assert.deepEqual(
                    sent.map((payload) => payload.action),
                    ['request_ib_connection_status', 'request_discount_curve']
                );

                handlers.message({
                    data: JSON.stringify({
                        action: 'discount_curve_snapshot',
                        status: 'refreshed',
                        fallbackUsed: false,
                        error: '',
                        curve: {
                            schemaVersion: 2,
                            kind: 'hybrid_discount_curve',
                            snapshotId: 'usd-reference:test',
                            curveAsOf: '2026-07-19',
                            effectiveDate: '2026-07-16',
                            quoteAsOf: '2026-07-19T12:00:00Z',
                            source: 'nyfed:sofr+treasury:daily_treasury_yield_curve',
                            sources: {
                                sofr: { effectiveDate: '2026-07-16', rate: 0.0362 },
                                treasury: { effectiveDate: '2026-07-17' },
                            },
                            curveSemantics: {
                                discountingIsApproximate: true,
                                discountRateSemantics: 'sofr_short_end_treasury_cmt_forward_slope_proxy',
                            },
                            quality: { status: 'degraded', flags: ['reference_curve_is_proxy'] },
                            points: [
                                {
                                    tenorDays: 30,
                                    zeroRate: 0.0367,
                                    discountFactor: Math.exp(-0.0367 * 30 / 365),
                                    source: 'nyfed:sofr',
                                    sourceEffectiveDate: '2026-07-16',
                                    proxy: true,
                                },
                                {
                                    tenorDays: 90,
                                    zeroRate: 0.039,
                                    discountFactor: Math.exp(-0.039 * 90 / 365),
                                    source: 'treasury:daily_treasury_yield_curve',
                                    sourceEffectiveDate: '2026-07-17',
                                    proxy: true,
                                },
                            ],
                        },
                    }),
                });
                const state = testApi.getDiscountCurveState();
                assert.equal(state.curve.kind, 'discount');
                assert.equal(state.curve.isProxy, true);
                assert.equal(state.curve.effectiveDate, '2026-07-16');
                assert.equal(state.curve.snapshotId, 'usd-reference:test');
                assert.equal(state.error, '');
                assert.equal(
                    testApi.formatDiscountCurveStatus(),
                    'SOFR/CMT reference curve 2026-07-19'
                );
                assert.match(testApi.discountCurveStatusTitle(), /SOFR 2026-07-16; Treasury 2026-07-17/i);
                assert.match(testApi.discountCurveStatusTitle(), /SOFR averages are diagnostics only/i);

                handlers.message({
                    data: JSON.stringify({
                        action: 'discount_curve_snapshot',
                        status: 'unavailable',
                        fallbackUsed: true,
                        error: 'feed unavailable',
                        curve: null,
                    }),
                });
                assert.equal(testApi.getDiscountCurveState().curve, state.curve);
                assert.match(testApi.formatDiscountCurveStatus(), /cached/);
                assert.equal(testApi.getDiscountCurveState().error, 'feed unavailable');
            },
        },
        {
            name: 'keeps subscription timeout errors visible during progress and completion',
            run() {
                const ctx = loadPageContext(null);
                const buildStatus = ctx.OptionComboIvTermStructurePage._test.buildSubscriptionStatus;
                const timeoutPayload = {
                    resolvedExpiryCount: 5,
                    totalExpiryCount: 8,
                    expectedOptionCount: 10,
                    attemptedOptionCount: 4,
                    subscribedOptionCount: 2,
                    failedOptionCount: 2,
                    timedOutOptionCount: 2,
                    subscriptionErrorMessage: 'Option subscription timed out after 8.0s while resolving SPY 20260717 750C.',
                };

                const progress = buildStatus(timeoutPayload);
                assert.equal(progress.kind, 'error');
                assert.match(progress.message, /timed out after 8\.0s/);
                assert.match(progress.message, /still running/);
                assert.match(progress.message, /timed out 2/);

                const complete = buildStatus(timeoutPayload, { complete: true });
                assert.equal(complete.kind, 'error');
                assert.match(complete.message, /Sync finished/);
                assert.match(complete.message, /2 failed, 2 timed out/);

                const healthyProgress = buildStatus({
                    resolvedExpiryCount: 5,
                    totalExpiryCount: 8,
                    expectedOptionCount: 10,
                    attemptedOptionCount: 2,
                    subscribedOptionCount: 2,
                    failedOptionCount: 0,
                });
                assert.equal(healthyProgress.kind, 'success');
                assert.doesNotMatch(healthyProgress.message, /failed 8/);
            },
        },
        {
            name: 'preserves the real IB connection state when a global stream reset fails',
            run() {
                const ctx = loadPageContext(null);
                const buildStatus = ctx.OptionComboIvTermStructurePage._test.buildIbStatusAfterApiMarketDataReset;
                const previous = {
                    connected: true,
                    connecting: false,
                    host: '127.0.0.1',
                };

                assert.deepEqual(
                    JSON.parse(JSON.stringify(buildStatus(previous, { success: false }, 'Reset failed.'))),
                    {
                        connected: true,
                        connecting: false,
                        host: '127.0.0.1',
                        message: 'Reset failed.',
                    }
                );
                assert.deepEqual(
                    JSON.parse(JSON.stringify(buildStatus(previous, { success: true, reconnecting: true }, 'Reconnecting.'))),
                    {
                        connected: false,
                        connecting: true,
                        message: 'Reconnecting.',
                    }
                );
            },
        },
        {
            name: 'lays out cards as expandable rows with SPY expanded by default',
            run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;

                assert.equal(
                    testApi.resolveDefaultExpandedSymbol([
                        { symbol: 'QQQ' },
                        { symbol: 'SPY' },
                        { symbol: 'GLD' },
                    ]),
                    'SPY'
                );
                assert.equal(
                    testApi.resolveDefaultExpandedSymbol([
                        { symbol: 'QQQ' },
                        { symbol: 'GLD' },
                    ]),
                    'QQQ'
                );

                const expandedCard = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                }, { isExpanded: true });
                const collapsedCard = testApi.createCardState({
                    symbol: 'QQQ',
                    historyPath: 'iv_term_structure/data/QQQ.json',
                }, { isExpanded: false });
                const expandedHtml = testApi.buildCardMarkup(expandedCard);
                const collapsedHtml = testApi.buildCardMarkup(collapsedCard);

                assert.match(expandedHtml, /class="ivts-card is-expanded"/);
                assert.match(expandedHtml, /data-action="toggle-card"/);
                assert.match(expandedHtml, /aria-expanded="true"/);
                assert.doesNotMatch(expandedHtml, /class="ivts-card-body" hidden/);
                assert.match(collapsedHtml, /class="ivts-card is-collapsed"/);
                assert.match(collapsedHtml, /aria-expanded="false"/);
                assert.match(collapsedHtml, /class="ivts-card-body" hidden/);
            },
        },
        {
            name: 'renders the frozen structured lambda result with separate calculate sync and export actions',
            run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                }, { isExpanded: true });
                card.lambdaSnapshot = {
                    snapshotId: 'manual-2',
                    payloadAsOf: '2026-07-20T14:45:30Z',
                    maxQuoteAgeSeconds: 120,
                };
                card.impliedLambdaComputedAt = '2026-07-20T14:45:35Z';
                card.impliedLambdaComputedEntry = {
                    snapshotId: 'manual-1',
                    quoteAsOf: '2026-07-20T14:45:00Z',
                    medianLambda: 0.18,
                    coverageStart: '2026-07-25',
                    coverageEnd: '2026-07-26',
                    byDate: {
                        '2026-07-25': 0.18,
                        '2026-07-26': 0.18,
                    },
                };
                card.impliedLambdaNeedsRecalculation = true;

                const html = testApi.buildImpliedLambdaPanel(
                    card,
                    Date.parse('2026-07-20T14:45:40Z')
                );
                assert.match(html, /Structured implied λ/);
                assert.match(html, /Calculated · newer quotes available/);
                assert.match(html, /Median λ/);
                assert.match(html, />0\.1800</);
                assert.match(html, /2026-07-25/);
                assert.match(html, /data-action="implied-lambda-calculate"/);
                assert.match(html, /data-action="implied-lambda-sync"/);
                assert.match(html, /data-action="implied-lambda-export"/);
            },
        },
        {
            name: 'renders futures month controls and binds FOP sync payloads to the selected future',
            run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'CL',
                    historyPath: 'iv_term_structure/data/CL.json',
                    futuresContractMonth: '202608',
                }, { isExpanded: true });
                const html = testApi.buildCardMarkup(card);
                const payload = testApi.buildSubscribePayload(card);

                assert.match(html, /Underlying FUT Month/);
                assert.match(html, /Live Option Streams/);
                assert.match(html, /20 streams \(10 expiries\)/);
                assert.match(html, /data-action="futures-contract-month"/);
                assert.match(html, /value="202608"/);
                assert.doesNotMatch(html, /ivts-futures-control/);
                assert.match(html, /ivts-subscription-control[\s\S]*Underlying FUT Month[\s\S]*<\/div>/);
                assert.match(html, /<details class="ivts-details ivts-sampling-details">/);
                assert.doesNotMatch(html, /ivts-sampling-details" open/);
                assert.equal(payload.underlying.secType, 'FUT');
                assert.equal(payload.underlying.symbol, 'CL');
                assert.equal(payload.underlying.contractMonth, '202608');
                assert.equal(payload.underlying.multiplier, '1000');
                assert.equal(payload.optionTemplate.secType, 'FOP');
                assert.equal(payload.optionTemplate.underlyingContractMonth, '202608');
                assert.equal(payload.optionTemplate.underlyingMultiplier, '1000');
                assert.equal(payload.maxOptionStreams, 20);
                assert.equal(payload.clientProtocolVersion, '20260719.5');

                const siCard = testApi.createCardState({
                    symbol: 'SI',
                    historyPath: 'iv_term_structure/data/SI.json',
                    futuresContractMonth: '202608',
                }, { isExpanded: true });
                const siPayload = testApi.buildSubscribePayload(siCard);
                assert.equal(siPayload.underlying.symbol, 'SI');
                assert.equal(siPayload.underlying.contractMonth, '202608');
                assert.equal(siPayload.underlying.multiplier, '5000');
                assert.equal(siPayload.optionTemplate.underlyingMultiplier, '5000');

                const esCard = testApi.createCardState({
                    symbol: 'ES',
                    historyPath: 'iv_term_structure/data/ES.json',
                    futuresContractMonth: '202609',
                }, { isExpanded: true });
                const esPayload = testApi.buildSubscribePayload(esCard);
                assert.equal(esPayload.underlying.secType, 'FUT');
                assert.equal(esPayload.underlying.symbol, 'ES');
                assert.equal(esPayload.underlying.exchange, 'CME');
                assert.equal(esPayload.underlying.contractMonth, '202609');
                assert.equal(esPayload.underlying.multiplier, '50');
                assert.equal(esPayload.optionTemplate.secType, 'FOP');
                assert.equal(esPayload.optionTemplate.exchange, 'CME');
                assert.equal(esPayload.optionTemplate.underlyingContractMonth, '202609');
                assert.equal(esPayload.optionTemplate.underlyingMultiplier, '50');

                const allStreamsCard = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                    maxOptionStreams: 0,
                }, { isExpanded: true });
                const allStreamsPayload = testApi.buildSubscribePayload(allStreamsCard);
                const allStreamsHtml = testApi.buildOptionStreamLimitControl(allStreamsCard);
                assert.equal(allStreamsPayload.maxOptionStreams, 0);
                assert.match(allStreamsHtml, /value="0" selected>All streams/);
            },
        },
        {
            name: 'accepts only a complete same-batch quote snapshot for implied lambda',
            run() {
                const stored = {};
                const ctx = loadPageContext(null, {
                    localStorage: {
                        getItem(key) {
                            return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null;
                        },
                        setItem(key, value) {
                            stored[key] = String(value);
                        },
                        removeItem(key) {
                            delete stored[key];
                        },
                    },
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                }, { isExpanded: true });
                card.catalog = {
                    anchorDate: '2026-07-17',
                    expiryRows: [{
                        expiry: '20260720', dte: 3, atmStrike: 660,
                        atmCallSubId: '__ivts__spy_call',
                        atmPutSubId: '__ivts__spy_put',
                        subscriptionSelected: true,
                    }],
                };
                const payload = {
                    action: 'iv_term_structure_quote_snapshot',
                    symbol: 'SPY',
                    anchorDate: '2026-07-17',
                    payloadAsOf: '2026-07-17T20:01:00Z',
                    batchId: 'whole-1',
                    snapshotId: 'whole-1',
                    coherent: true,
                    quoteComplete: true,
                    underlyingPrice: 660,
                    underlyingQuote: {
                        mark: 660, quoteAsOf: '2026-07-17T20:00:59Z', snapshotId: 'whole-1',
                    },
                    options: {
                        __ivts__spy_call: {
                            bid: 4.9, ask: 5.1, mark: 5,
                            markSource: 'bid_ask_mid', quoteAsOf: '2026-07-17T20:00:58Z', snapshotId: 'whole-1',
                        },
                        __ivts__spy_put: {
                            bid: 4.8, ask: 5, mark: 4.9,
                            markSource: 'bid_ask_mid', quoteAsOf: '2026-07-17T20:00:57Z', snapshotId: 'whole-1',
                        },
                    },
                };

                const accepted = testApi.applyCoherentQuoteSnapshot(
                    card, payload, new Date('2026-07-17T20:01:00Z')
                );
                assert.equal(accepted.ok, true);
                assert.equal(card.lambdaSnapshot.snapshotId, 'whole-1');
                assert.equal(card.lambdaSnapshot.underlyingPrice, 660);
                assert.equal(card.lambdaSnapshot.quotesBySubId.__ivts__spy_call.markSource, 'bid_ask_mid');
                assert.equal(card.lambdaSnapshot.expiryRows.length, 1);

                // Later incremental table ticks must not mutate the frozen
                // evidence set used for lambda publication.
                card.quotesBySubId.__ivts__spy_call.mark = 99;
                assert.equal(card.lambdaSnapshot.quotesBySubId.__ivts__spy_call.mark, 5);

                const entry = testApi.buildImpliedLambdaEntry(card, {
                    impliedLambda: {
                        anchorDate: '2026-07-17',
                        calendarKey: 'NYSE',
                        varianceSource: 'straddle',
                        snapshotId: 'whole-1',
                        quoteAsOf: '2026-07-17T20:00:58.000Z',
                        coverageStart: '2026-07-18',
                        coverageEnd: '2026-07-19',
                        byDate: { '2026-07-18': 0.2, '2026-07-19': 0.2 },
                        medianLambda: 0.2,
                        okIntervalCount: 1,
                        intervals: [{
                            startDate: '2026-07-17',
                            endExpiry: '2026-07-20',
                            status: 'ok',
                            rawLambda: 0.2,
                            nonTradingDates: ['2026-07-18', '2026-07-19'],
                            snapshotId: 'whole-1',
                            quoteAsOf: '2026-07-17T20:00:58.000Z',
                        }],
                        quality: {
                            status: 'ok', coherent: true, quoteComplete: true,
                            snapshotId: 'whole-1', underlyingSnapshotId: 'whole-1',
                        },
                    },
                });
                assert.equal(entry.snapshotId, 'whole-1');
                assert.equal(entry.varianceSource, 'straddle');
                assert.equal(entry.quality.coherent, true);
                assert.equal(entry.intervals[0].rawLambda, 0.2);
                const normalizedEntry = ctx.OptionComboImpliedLambdaHandoff.buildSymbolEntry(
                    entry,
                    Date.parse('2026-07-17T20:01:00Z')
                );
                assert.ok(normalizedEntry);
                assert.deepEqual(
                    Object.keys(normalizedEntry.byDate),
                    ['2026-07-18', '2026-07-19']
                );
                assert.equal(
                    ctx.OptionComboImpliedLambdaHandoff.saveSymbolEntry(
                        entry, undefined, Date.parse('2026-07-17T20:01:00Z')
                    ),
                    true
                );
                // This card owns the stored snapshot; only its exact snapshot
                // id may be withdrawn by later invalidation.
                card.impliedLambdaPublishedSnapshotId = 'whole-1';

                const missingLeg = testApi.applyCoherentQuoteSnapshot(
                    card,
                    { ...payload, options: { __ivts__spy_call: payload.options.__ivts__spy_call } },
                    new Date('2026-07-17T20:01:00Z')
                );
                assert.equal(missingLeg.ok, false);
                assert.equal(missingLeg.reason, 'missing_option_leg');
                assert.equal(card.lambdaSnapshot, null);
                assert.equal(
                    ctx.OptionComboImpliedLambdaHandoff.peekSymbolEntry(
                        'SPY', undefined, Date.parse('2026-07-17T20:01:01Z')
                    ).snapshotId,
                    'whole-1'
                );

                card.futuresContractMonth = '202609';
                const wrongMonth = testApi.applyCoherentQuoteSnapshot(
                    card,
                    { ...payload, underlyingContractMonth: '202612' },
                    new Date('2026-07-17T20:01:00Z')
                );
                assert.equal(wrongMonth.ok, false);
                assert.equal(wrongMonth.reason, 'underlying_contract_month_mismatch');
                card.futuresContractMonth = '';

                const staleAnchor = testApi.applyCoherentQuoteSnapshot(
                    card, payload, new Date('2026-07-20T15:00:00Z')
                );
                assert.equal(staleAnchor.ok, false);
                assert.equal(staleAnchor.reason, 'stale_anchor');
            },
        },
        {
            name: 'keeps coherent quote ticks calculation-free until the manual lambda actions run',
            run() {
                const fixture = createCoherentPublicationFixture();
                try {
                    fixture.dispatch();
                    assert.equal(fixture.savedEntries.length, 0);
                    assert.equal(fixture.card.impliedLambdaComputedEntry, null);

                    const calculated = fixture.ctx.OptionComboIvTermStructurePage._test
                        .calculateImpliedLambda(fixture.card);
                    assert.equal(calculated.ok, true);
                    assert.equal(calculated.status, 'calculated');
                    assert.equal(fixture.savedEntries.length, 0);
                    assert.equal(fixture.card.impliedLambdaComputedEntry.snapshotId, 'focused-whole-1');

                    const synced = fixture.ctx.OptionComboIvTermStructurePage._test
                        .syncCalculatedImpliedLambda(fixture.card);
                    assert.equal(synced.ok, true);
                    assert.equal(fixture.savedEntries.length, 1);
                    assert.equal(fixture.savedEntries[0].snapshotId, 'focused-whole-1');
                    assert.deepEqual(
                        Object.keys(fixture.savedEntries[0].byDate),
                        ['2026-07-25', '2026-07-26']
                    );
                    assert.equal(
                        fixture.card.impliedLambdaPublishedSnapshotId,
                        'focused-whole-1'
                    );
                    assert.equal(fixture.card.statusKind, 'success');
                    assert.match(fixture.card.statusMessage, /Synced implied λ to same-origin simulators/);
                    fixture.dispatchSyncComplete();
                    assert.equal(fixture.card.statusKind, 'success');
                    assert.match(fixture.card.statusMessage, /Synced implied λ to same-origin simulators/);
                } finally {
                    fixture.restore();
                }
            },
        },
        {
            name: 'replaces a partial strict curve when best-effort recovers later weekends',
            run() {
                const fixture = createCoherentPublicationFixture();
                try {
                    fixture.dispatch();
                    fixture.card.catalog.expiryRows.push({
                        expiry: '20260724', dte: 4, atmStrike: 750,
                        atmCallSubId: 'extra-call', atmPutSubId: 'extra-put',
                        subscriptionSelected: true,
                    });
                    fixture.card.quotesBySubId['extra-call'] = {
                        bid: 8.9, ask: 9.1, quoteAsOf: '2026-07-20T14:32:42.876Z',
                    };
                    fixture.card.quotesBySubId['extra-put'] = {
                        bid: 8.8, ask: 9.0, quoteAsOf: '2026-07-20T14:32:42.876Z',
                    };

                    fixture.ctx.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas = (
                        _rows, anchorDate, options
                    ) => {
                        const snapshotId = options.snapshotMetadata.snapshotId;
                        const quoteAsOf = options.snapshotMetadata.quoteAsOf;
                        const bestEffort = options.requireExactExpiryTimestamps === false;
                        const intervalSpecs = bestEffort ? [
                            ['2026-07-24', '20260727', ['2026-07-25', '2026-07-26'], 0.12],
                            ['2026-07-31', '20260803', ['2026-08-01', '2026-08-02'], -0.08],
                            ['2026-08-07', '20260810', ['2026-08-08', '2026-08-09'], 0.18],
                        ] : [
                            ['2026-07-24', '20260727', ['2026-07-25', '2026-07-26'], 0.12],
                        ];
                        const intervals = intervalSpecs.map(([
                            startDate, endExpiry, nonTradingDates, rawLambda,
                        ]) => ({
                            startDate, endExpiry, nonTradingDates, rawLambda,
                            lambda: rawLambda, status: 'ok', snapshotId, quoteAsOf,
                        }));
                        const byDate = {};
                        intervals.forEach((interval) => interval.nonTradingDates.forEach((date) => {
                            byDate[date] = interval.rawLambda;
                        }));
                        const dates = Object.keys(byDate).sort();
                        return {
                            anchorDate,
                            calendarKey: 'NYSE',
                            varianceSource: 'straddle',
                            snapshotId,
                            quoteAsOf,
                            methodology: {
                                pricingModel: 'bsm-spot',
                                requireExactExpiryTimestamps: false,
                            },
                            coverageStart: dates[0],
                            coverageEnd: dates[dates.length - 1],
                            byDate,
                            medianLambda: 0.12,
                            okIntervalCount: intervals.length,
                            intervals,
                            rowDiagnostics: bestEffort ? [] : [{
                                expiry: '20260810',
                                status: 'exact_expiry_timestamp_unavailable',
                            }],
                            quality: {
                                status: 'ok', coherent: true, quoteComplete: true,
                                snapshotId, underlyingSnapshotId: snapshotId,
                            },
                        };
                    };

                    const calculated = fixture.ctx.OptionComboIvTermStructurePage._test
                        .calculateImpliedLambda(fixture.card);
                    assert.equal(calculated.ok, true);
                    assert.equal(calculated.status, 'estimated');
                    assert.equal(calculated.calculationMode, 'best_effort');
                    assert.deepEqual(Object.keys(calculated.entry.byDate), [
                        '2026-07-25', '2026-07-26',
                        '2026-08-01', '2026-08-02',
                        '2026-08-08', '2026-08-09',
                    ]);
                    assert.equal(calculated.entry.byDate['2026-08-01'], -0.08);
                } finally {
                    fixture.restore();
                }
            },
        },
        {
            name: 'estimates lambda from usable current BBO pairs when strict TWS evidence is incomplete',
            run() {
                const FixedDate = fixedDateClass('2026-07-20T14:32:42.876Z');
                const ctx = loadPageContext(null, { Date: FixedDate });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                }, { isExpanded: true });
                card.underlyingPrice = 750;
                card.catalog = {
                    anchorDate: '2026-07-20',
                    expiryRows: [
                        {
                            expiry: '20260721', dte: 1, atmStrike: 750,
                            atmCallSubId: 'call-1', atmPutSubId: 'put-1',
                            subscriptionSelected: true,
                        },
                        {
                            expiry: '20260724', dte: 4, atmStrike: 750,
                            atmCallSubId: 'call-2', atmPutSubId: 'put-2',
                            subscriptionSelected: true,
                        },
                        {
                            expiry: '20260727', dte: 7, atmStrike: 750,
                            atmCallSubId: 'call-bad', atmPutSubId: 'put-bad',
                            subscriptionSelected: true,
                        },
                    ],
                };
                const quoteAsOf = '2026-07-20T14:32:42.876Z';
                card.quotesBySubId = {
                    'call-1': { bid: 4.9, ask: 5.1, quoteAsOf },
                    'put-1': { bid: 4.8, ask: 5.0, quoteAsOf },
                    'call-2': { bid: 8.9, ask: 9.2, quoteAsOf },
                    'put-2': { bid: 8.7, ask: 9.0, quoteAsOf },
                    // A crossed row is a hard quality failure for that row,
                    // but must not poison the usable surface.
                    'call-bad': { bid: 12.0, ask: 11.5, quoteAsOf },
                    'put-bad': { bid: 11.0, ask: 11.4, quoteAsOf },
                };

                let receivedRows = null;
                let receivedOptions = null;
                const originalCompute = ctx.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas;
                ctx.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas = (rows, anchorDate, options) => {
                    receivedRows = rows;
                    receivedOptions = options;
                    const snapshotId = options.snapshotMetadata.snapshotId;
                    const quoteAsOf = options.snapshotMetadata.quoteAsOf;
                    return {
                        anchorDate,
                        calendarKey: 'NYSE',
                        varianceSource: 'straddle',
                        snapshotId,
                        quoteAsOf,
                        methodology: { pricingModel: 'bsm-spot' },
                        coverageStart: '2026-07-25',
                        coverageEnd: '2026-07-26',
                        byDate: { '2026-07-25': 0.12, '2026-07-26': 0.12 },
                        medianLambda: 0.12,
                        okIntervalCount: 1,
                        intervals: [{
                            startDate: '2026-07-24',
                            endExpiry: '20260727',
                            status: 'ok',
                            rawLambda: 0.12,
                            nonTradingDates: ['2026-07-25', '2026-07-26'],
                            snapshotId,
                            quoteAsOf,
                        }],
                        quality: {
                            status: 'ok', coherent: true, quoteComplete: true,
                            snapshotId, underlyingSnapshotId: snapshotId,
                        },
                    };
                };

                try {
                    const source = testApi.buildBestEffortLambdaSnapshot(card, FixedDate.now());
                    assert.equal(source.ok, true);
                    assert.equal(source.usableExpiryCount, 2);
                    assert.equal(source.skippedExpiryCount, 1);
                    assert.equal(source.skippedRows[0].callReason, 'crossed_market');
                    assert.equal(
                        source.snapshot.quotesBySubId['call-1'].expiryTimeSource,
                        'product-profile'
                    );
                    assert.match(
                        source.snapshot.quotesBySubId['call-1'].expiryAsOf,
                        /^2026-07-21T20:00:00\.000Z$/
                    );

                    const calculated = testApi.calculateImpliedLambda(card, FixedDate.now());
                    assert.equal(calculated.ok, true);
                    assert.equal(calculated.status, 'estimated');
                    assert.equal(calculated.calculationMode, 'best_effort');
                    assert.equal(receivedRows.length, 2);
                    assert.equal(receivedOptions.requireExactExpiryTimestamps, false);
                    assert.equal(receivedOptions.maxQuoteSkewMs, null);
                    assert.equal(calculated.entry.quality.estimationMode, 'best_effort');
                    assert.equal(calculated.entry.quality.usableExpiryCount, 2);
                    assert.equal(calculated.entry.quality.skippedExpiryCount, 1);
                    assert.match(card.statusMessage, /2 usable BBO expiries \(1 skipped\)/);

                    const panel = testApi.buildImpliedLambdaPanel(card, FixedDate.now());
                    assert.match(panel, /Best-effort estimate/);
                    assert.match(panel, /best-effort estimate is frozen/i);
                    assert.doesNotMatch(panel, /Calculate λ<\/button>[^]*disabled/);
                } finally {
                    ctx.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas = originalCompute;
                }
            },
        },
        {
            name: 'enables Calculate and publishes a signed vendor-IV fallback when BBO is missing',
            run() {
                const FixedDate = fixedDateClass('2026-07-20T14:32:42.876Z');
                const ctx = loadPageContext(null, { Date: FixedDate });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                }, { isExpanded: true });
                const dailyVar = 8e-5;
                let totalVar = 0;
                const specs = [
                    ['20260721', 1, 1],
                    ['20260722', 2, 1],
                    ['20260723', 3, 1],
                    ['20260724', 4, 1],
                    ['20260727', 7, 0.6],
                ];
                card.catalog = {
                    anchorDate: '2026-07-20',
                    expiryRows: specs.map(([expiry, dte], index) => ({
                        expiry, dte, atmStrike: 750,
                        atmCallSubId: `iv-call-${index}`,
                        atmPutSubId: `iv-put-${index}`,
                        subscriptionSelected: true,
                    })),
                };
                card.quotesBySubId = {};
                specs.forEach(([expiry, dte, units], index) => {
                    totalVar += dailyVar * units;
                    const iv = Math.sqrt(totalVar * 365 / dte);
                    card.quotesBySubId[`iv-call-${index}`] = {
                        iv, quoteAsOf: '2026-07-20T14:32:42.876Z',
                    };
                    card.quotesBySubId[`iv-put-${index}`] = {
                        iv, quoteAsOf: '2026-07-20T14:32:42.876Z',
                    };
                });

                const vendorSource = testApi.buildVendorIvLambdaSource(
                    card, FixedDate.now()
                );
                assert.equal(vendorSource.ok, true);
                assert.equal(vendorSource.usableExpiryCount, 5);
                assert.equal(testApi.buildBestEffortLambdaSnapshot(card, FixedDate.now()).ok, false);

                const beforePanel = testApi.buildImpliedLambdaPanel(card, FixedDate.now());
                assert.match(beforePanel, /ATM-IV fallback ready · 5 expiries usable/);
                assert.doesNotMatch(
                    beforePanel,
                    /data-action="implied-lambda-calculate"[^>]*disabled/
                );

                const calculated = testApi.calculateImpliedLambda(card, FixedDate.now());
                assert.equal(calculated.ok, true);
                assert.equal(calculated.status, 'estimated');
                assert.equal(calculated.calculationMode, 'vendor_iv_fallback');
                assert.equal(calculated.entry.varianceSource, 'vendor_iv');
                assert.equal(
                    calculated.entry.quality.sourceQuoteEvidence,
                    'vendor_atm_iv_fallback'
                );
                assert.ok(calculated.entry.byDate['2026-07-25'] < 0);
                assert.match(card.statusMessage, /ATM Call\/Put IV pairs/);

                const afterPanel = testApi.buildImpliedLambdaPanel(card, FixedDate.now());
                assert.match(afterPanel, /Vendor-IV fallback/);
                assert.match(afterPanel, /vendor fallback/);
            },
        },
        {
            name: 'dates a vendor-IV surface from its legs instead of the Calculate click',
            run() {
                // TWS delivered model IV for the front expiries in the morning
                // and for the back expiries after an afternoon selloff. Forward
                // variance across that interval mixes two vol regimes, so the
                // legs must never be stamped with one synthetic timestamp and
                // published as a single coherent observation.
                const FixedDate = fixedDateClass('2026-07-20T15:51:00.000Z');
                const ctx = loadPageContext(null, { Date: FixedDate });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const MORNING = '2026-07-20T09:35:00.000Z';
                const AFTERNOON = '2026-07-20T15:50:30.000Z';
                const buildCard = (stamps) => {
                    const card = testApi.createCardState({
                        symbol: 'SPY',
                        historyPath: 'iv_term_structure/data/SPY.json',
                    }, { isExpanded: true });
                    const specs = [
                        ['20260721', 1, 1], ['20260722', 2, 1], ['20260723', 3, 1],
                        ['20260724', 4, 1], ['20260727', 7, 0.6],
                    ];
                    card.catalog = {
                        anchorDate: '2026-07-20',
                        expiryRows: specs.map(([expiry, dte], index) => ({
                            expiry, dte, atmStrike: 750,
                            atmCallSubId: `iv-call-${index}`,
                            atmPutSubId: `iv-put-${index}`,
                            subscriptionSelected: true,
                        })),
                    };
                    card.quotesBySubId = {};
                    let totalVar = 0;
                    specs.forEach(([, dte, units], index) => {
                        totalVar += 8e-5 * units;
                        const iv = Math.sqrt(totalVar * 365 / dte);
                        const quoteAsOf = stamps[index];
                        card.quotesBySubId[`iv-call-${index}`] = { iv, quoteAsOf };
                        card.quotesBySubId[`iv-put-${index}`] = { iv, quoteAsOf };
                    });
                    return card;
                };

                const mixed = testApi.buildVendorIvLambdaSource(
                    buildCard([MORNING, MORNING, MORNING, AFTERNOON, AFTERNOON]),
                    FixedDate.now()
                );
                assert.equal(mixed.ok, true);
                assert.equal(mixed.usableExpiryCount, 2);
                assert.equal(mixed.skippedRows.length, 3);
                assert.equal(mixed.skippedRows[0].callReason, 'stale_quote');
                assert.equal(mixed.skippedRows[0].putReason, 'stale_quote');
                // The published quote time is the oldest leg actually used,
                // never the moment Calculate was pressed.
                assert.equal(mixed.snapshot.quoteAsOf, AFTERNOON);
                assert.equal(mixed.snapshot.payloadAsOf, '2026-07-20T15:51:00.000Z');
                assert.notEqual(mixed.snapshot.quoteAsOf, mixed.snapshot.payloadAsOf);
                assert.equal(mixed.snapshot.observedAt, '2026-07-20T15:51:00.000Z');

                // With every leg stale the route reports unavailable rather
                // than certifying a surface it cannot honestly date.
                const staleCard = buildCard(new Array(5).fill(MORNING));
                const stale = testApi.buildVendorIvLambdaSource(staleCard, FixedDate.now());
                assert.equal(stale.ok, false);
                assert.equal(stale.reason, 'insufficient_fresh_vendor_iv_pairs');
                assert.equal(stale.snapshot, null);
                assert.equal(stale.usableExpiryCount, 0);

                const calculated = testApi.calculateImpliedLambda(staleCard, FixedDate.now());
                assert.equal(calculated.ok, false);
                assert.equal(calculated.status, 'not_estimable');
                assert.equal(calculated.entry, null);

                // A leg with no timestamp at all cannot be dated either.
                const undatedCard = buildCard(new Array(5).fill(undefined));
                const undated = testApi.buildVendorIvLambdaSource(undatedCard, FixedDate.now());
                assert.equal(undated.ok, false);
                assert.equal(undated.skippedRows[0].callReason, 'missing_quote_timestamp');
            },
        },
        {
            name: 'keeps a straddle curve rather than a wider vendor-IV surface',
            run() {
                const fixture = createCoherentPublicationFixture();
                try {
                    fixture.dispatch();
                    const quoteAsOf = '2026-07-20T14:32:42.876Z';
                    const testApi = fixture.ctx.OptionComboIvTermStructurePage._test;
                    // Vendor IV needs only IV > 0, so it reaches expiries the
                    // two-sided BBO straddle route cannot. Wider coverage must
                    // not evict a curve derived from real market prices.
                    fixture.card.quotesBySubId.__ivts__spy_call.iv = 0.18;
                    fixture.card.quotesBySubId.__ivts__spy_put.iv = 0.18;
                    [['20260731', 11], ['20260807', 18], ['20260814', 25]]
                        .forEach(([expiry, dte], index) => {
                            fixture.card.catalog.expiryRows.push({
                                expiry, dte, atmStrike: 750,
                                atmCallSubId: `iv-call-${index}`,
                                atmPutSubId: `iv-put-${index}`,
                                subscriptionSelected: true,
                            });
                            const iv = 0.18 + dte * 0.001;
                            fixture.card.quotesBySubId[`iv-call-${index}`] = { iv, quoteAsOf };
                            fixture.card.quotesBySubId[`iv-put-${index}`] = { iv, quoteAsOf };
                        });
                    // The vendor route is genuinely available here: what stops
                    // it is the hierarchy, not missing evidence.
                    assert.equal(
                        testApi.buildVendorIvLambdaSource(fixture.card, Date.parse(quoteAsOf)).ok,
                        true
                    );

                    fixture.ctx.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas = (
                        _rows, anchorDate, options
                    ) => {
                        const snapshotId = options.snapshotMetadata.snapshotId;
                        const stamp = options.snapshotMetadata.quoteAsOf;
                        const vendor = options.varianceSource === 'vendor_iv';
                        const specs = vendor ? [
                            ['2026-07-24', '20260727', ['2026-07-25', '2026-07-26'], 0.9],
                            ['2026-07-31', '20260803', ['2026-08-01', '2026-08-02'], 0.9],
                        ] : [
                            ['2026-07-24', '20260727', ['2026-07-25', '2026-07-26'], 0.2],
                        ];
                        const intervals = specs.map(([
                            startDate, endExpiry, nonTradingDates, rawLambda,
                        ]) => ({
                            startDate, endExpiry, nonTradingDates, rawLambda,
                            lambda: rawLambda, status: 'ok',
                            snapshotId, quoteAsOf: stamp,
                        }));
                        const byDate = {};
                        intervals.forEach((interval) => interval.nonTradingDates
                            .forEach((date) => { byDate[date] = interval.rawLambda; }));
                        const dates = Object.keys(byDate).sort();
                        return {
                            anchorDate,
                            calendarKey: 'NYSE',
                            varianceSource: vendor ? 'vendor_iv' : 'straddle',
                            snapshotId,
                            quoteAsOf: stamp,
                            methodology: { pricingModel: 'bsm-spot' },
                            coverageStart: dates[0],
                            coverageEnd: dates[dates.length - 1],
                            byDate,
                            medianLambda: vendor ? 0.9 : 0.2,
                            okIntervalCount: intervals.length,
                            intervals,
                            quality: {
                                status: 'ok', coherent: true, quoteComplete: true,
                                snapshotId, underlyingSnapshotId: snapshotId,
                            },
                        };
                    };

                    const calculated = testApi.calculateImpliedLambda(fixture.card);
                    assert.equal(calculated.ok, true);
                    // Vendor IV covers four dates against the straddle route's
                    // two, but covered-date count does not outrank evidence.
                    assert.equal(calculated.calculationMode, 'strict');
                    assert.equal(calculated.status, 'calculated');
                    assert.equal(calculated.entry.varianceSource, 'straddle');
                    assert.deepEqual(
                        Object.keys(calculated.entry.byDate),
                        ['2026-07-25', '2026-07-26']
                    );
                } finally {
                    fixture.restore();
                }
            },
        },
        {
            name: 'refuses stale BBO pairs and keeps true quote times in best-effort mode',
            run() {
                // The IB socket dropped at 11:00. card.quotesBySubId survives a
                // close, so those BBOs are still sitting in the map when the
                // user presses Calculate at 15:30.
                const FixedDate = fixedDateClass('2026-07-20T15:30:00.000Z');
                const ctx = loadPageContext(null, { Date: FixedDate });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                }, { isExpanded: true });
                card.underlyingPrice = 750;
                card.catalog = {
                    anchorDate: '2026-07-20',
                    expiryRows: [
                        {
                            expiry: '20260721', dte: 1, atmStrike: 750,
                            atmCallSubId: 'call-1', atmPutSubId: 'put-1',
                            subscriptionSelected: true,
                        },
                        {
                            expiry: '20260724', dte: 4, atmStrike: 750,
                            atmCallSubId: 'call-2', atmPutSubId: 'put-2',
                            subscriptionSelected: true,
                        },
                    ],
                };
                const setStamp = (quoteAsOf) => {
                    card.quotesBySubId = {
                        'call-1': { bid: 4.9, ask: 5.1, quoteAsOf },
                        'put-1': { bid: 4.8, ask: 5.0, quoteAsOf },
                        'call-2': { bid: 8.9, ask: 9.2, quoteAsOf },
                        'put-2': { bid: 8.7, ask: 9.0, quoteAsOf },
                    };
                };

                setStamp('2026-07-20T11:00:00.000Z');
                const stale = testApi.buildBestEffortLambdaSnapshot(card, FixedDate.now());
                assert.equal(stale.ok, false);
                assert.equal(stale.reason, 'insufficient_complete_expiry_pairs');
                assert.equal(stale.usableExpiryCount, 0);
                assert.equal(stale.skippedRows[0].callReason, 'stale_quote');
                assert.equal(stale.skippedRows[0].putReason, 'stale_quote');

                setStamp(undefined);
                assert.equal(
                    testApi.buildBestEffortLambdaSnapshot(card, FixedDate.now())
                        .skippedRows[0].callReason,
                    'missing_quote_timestamp'
                );

                // A fresh set publishes, but carries the venue's own quote
                // time so freshness checks and cross-tab ownership
                // arbitration still see when the market was actually read.
                const FRESH = '2026-07-20T15:29:30.000Z';
                setStamp(FRESH);
                const fresh = testApi.buildBestEffortLambdaSnapshot(card, FixedDate.now());
                assert.equal(fresh.ok, true);
                assert.equal(fresh.usableExpiryCount, 2);
                assert.equal(fresh.snapshot.quotesBySubId['call-1'].quoteAsOf, FRESH);
                assert.equal(
                    fresh.snapshot.quotesBySubId['call-1'].observedAt,
                    '2026-07-20T15:30:00.000Z'
                );
                assert.equal(fresh.snapshot.quoteAsOf, FRESH);
                assert.equal(fresh.snapshot.underlyingQuote.quoteAsOf, FRESH);
                assert.equal(fresh.snapshot.payloadAsOf, '2026-07-20T15:30:00.000Z');
                assert.equal(fresh.snapshot.coherent, true);
                assert.equal(fresh.snapshot.quoteComplete, true);

                const inspect = testApi.inspectBestEffortOptionQuote;
                const nowMs = FixedDate.now();
                assert.equal(inspect({ bid: 1, ask: 2, quoteAsOf: FRESH }, '', nowMs).usable, true);
                assert.equal(
                    inspect({ bid: 1, ask: 2, quoteAsOf: '2026-07-20T11:00:00.000Z' }, '', nowMs).reason,
                    'stale_quote'
                );
                assert.equal(
                    inspect({ bid: 1, ask: 2, quoteAsOf: '2026-07-20T16:30:00.000Z' }, '', nowMs).reason,
                    'future_quote_timestamp'
                );
                assert.equal(inspect({ bid: 1, ask: 2 }, '', nowMs).reason, 'missing_quote_timestamp');
            },
        },
        {
            name: 'reports strict V2 sync failure only after an explicit calculation and sync',
            run() {
                const fixture = createCoherentPublicationFixture({ saveResult: false });
                try {
                    fixture.dispatch();
                    assert.equal(fixture.savedEntries.length, 0);
                    const calculated = fixture.ctx.OptionComboIvTermStructurePage._test
                        .calculateImpliedLambda(fixture.card);
                    assert.equal(calculated.ok, true);
                    const synced = fixture.ctx.OptionComboIvTermStructurePage._test
                        .syncCalculatedImpliedLambda(fixture.card);
                    assert.equal(synced.ok, false);
                    assert.equal(fixture.savedEntries.length, 1);
                    assert.equal(fixture.card.impliedLambdaPublishedSnapshotId, '');
                    assert.equal(fixture.card.impliedLambdaPublicationResult.ok, false);
                    assert.equal(fixture.card.impliedLambdaPublicationResult.status, 'save_failed');
                    assert.equal(fixture.card.statusKind, 'error');
                    assert.match(
                        fixture.card.statusMessage,
                        /browser storage or V2 identity\/calendar validation rejected the curve/
                    );
                    assert.doesNotMatch(fixture.card.statusMessage, /ready for implied λ/);
                    fixture.dispatchSyncComplete();
                    assert.equal(fixture.card.statusKind, 'error');
                    assert.match(
                        fixture.card.statusMessage,
                        /browser storage or V2 identity\/calendar validation rejected the curve/
                    );
                } finally {
                    fixture.restore();
                }
            },
        },
        {
            name: 'restores monitors, control socket, and active cards after a bfcache page show',
            async run() {
                const intervalDelays = [];
                let nextTimerId = 1;
                const ctx = loadPageContext(null, {
                    Date: fixedDateClass('2026-07-20T14:32:42.876Z'),
                    setInterval(_handler, delay) {
                        intervalDelays.push(delay);
                        return nextTimerId++;
                    },
                    clearInterval() {},
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Lifecycle test',
                    symbols: [{
                        symbol: 'SPY',
                        historyPath: 'iv_term_structure/data/SPY.json',
                    }],
                }, 'test');
                const card = testApi.getCard('SPY');
                let cardCloseCount = 0;
                let controlCloseCount = 0;
                card.ws = {
                    close() {
                        cardCloseCount += 1;
                    },
                };
                card.lambdaSnapshot = { snapshotId: 'before-hide' };
                card.impliedLambdaPublishedSnapshotId = 'before-hide';
                card.impliedLambdaPublicationResult = {
                    ok: true,
                    status: 'published',
                    snapshotId: 'before-hide',
                    message: 'Published implied λ: 2 dates.',
                };
                testApi.setControlSocketForTest({
                    close() {
                        controlCloseCount += 1;
                    },
                });

                testApi.closeAllSocketsForPageExit();
                // beforeunload may follow pagehide; it must not erase the
                // remembered active-card intent or close old sockets twice.
                testApi.closeAllSocketsForPageExit();
                assert.equal(cardCloseCount, 1);
                assert.equal(controlCloseCount, 1);
                assert.equal(card.ws, null);
                assert.equal(card.lambdaSnapshot, null);
                assert.equal(card.impliedLambdaPublicationResult.status, 'published');
                assert.equal(card.resumeAfterPageShow, true);
                assert.equal(card.statusKind, '');
                assert.match(card.statusMessage, /paused while this page is hidden/);

                let controlRestoreCount = 0;
                let controlRestoreOptions = null;
                const syncCalls = [];
                const restored = await testApi.resumePageAfterCache(
                    { persisted: true },
                    {
                        async ensureControlSocket(options) {
                            controlRestoreCount += 1;
                            controlRestoreOptions = options;
                            return {};
                        },
                        async syncCard(resumeCard, syncOptions) {
                            syncCalls.push({ symbol: resumeCard.symbol, syncOptions });
                        },
                    }
                );

                assert.equal(restored.resumed, true);
                assert.equal(restored.controlRestored, true);
                assert.deepEqual(Array.from(restored.resyncedSymbols), ['SPY']);
                assert.equal(controlRestoreCount, 1);
                assert.equal(
                    controlRestoreOptions.requireAutomaticMarketDataPermission,
                    true
                );
                assert.equal(syncCalls.length, 1);
                assert.equal(syncCalls[0].symbol, 'SPY');
                assert.equal(syncCalls[0].syncOptions.waitForQuotes, false);
                assert.equal(syncCalls[0].syncOptions.automatic, true);
                assert.equal(card.resumeAfterPageShow, false);
                assert.match(card.statusMessage, /Resyncing live IVTS/);
                assert.deepEqual(
                    intervalDelays.slice().sort((a, b) => a - b),
                    [60000, 6 * 60 * 60 * 1000]
                );
            },
        },
        {
            name: 'blocks bfcache automatic resync until replacement control status permits it',
            async run() {
                const sockets = [];
                class MockWebSocket {
                    static OPEN = 1;
                    static CONNECTING = 0;

                    constructor() {
                        this.readyState = MockWebSocket.CONNECTING;
                        this.listeners = {};
                        this.sent = [];
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

                    close() {
                        this.readyState = 3;
                    }
                }

                const ctx = loadPageContext(null, {
                    WebSocket: MockWebSocket,
                    setInterval() { return 1; },
                    clearInterval() {},
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'bfcache handshake test',
                    symbols: [{
                        symbol: 'SPY',
                        historyPath: 'iv_term_structure/data/SPY.json',
                    }],
                }, 'test');
                const card = testApi.getCard('SPY');
                card.resumeAfterPageShow = true;
                const syncCalls = [];

                const resumePromise = testApi.resumePageAfterCache(
                    { persisted: true },
                    {
                        async syncCard(resumeCard, options) {
                            syncCalls.push({ symbol: resumeCard.symbol, options });
                        },
                    }
                );
                await Promise.resolve();
                const controlSocket = sockets[0];
                assert.ok(controlSocket);
                assert.deepEqual(syncCalls, []);

                controlSocket.emit('open');
                await Promise.resolve();
                assert.deepEqual(
                    controlSocket.sent.map(payload => payload.action),
                    ['request_ib_connection_status', 'request_discount_curve']
                );
                assert.deepEqual(syncCalls, []);

                controlSocket.emit('message', {
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 9,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                const restored = await resumePromise;
                assert.equal(restored.resumed, true);
                assert.equal(restored.controlRestored, false);
                assert.deepEqual(Array.from(restored.resyncedSymbols), []);
                assert.deepEqual(syncCalls, []);
            },
        },
        {
            name: 'renders per-symbol hourly auto sampling controls and combines auto history for strategy use',
            run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                }, { isExpanded: true });
                card.bundledHistoryDocument = { symbol: 'SPY', version: 1, samples: [{ sampledAt: '2026-07-10T14:00:00Z' }] };
                card.autoHistoryDocument = testApi.normalizeAutoHistoryDocument({
                    samples: [{ sampledAt: '2026-07-11T14:00:00Z' }],
                }, 'SPY');
                card.autoFileName = 'SPY.ivts-auto.json';
                card.autoSamplingEnabled = true;

                const combined = testApi.strategyHistoryDocument(card);
                const html = testApi.buildCardMarkup(card);

                assert.equal(combined.samples.length, 2);
                assert.match(html, /data-action="auto-load"/);
                assert.match(html, /Load\/Resume Auto JSON/);
                assert.match(html, /data-action="auto-new"/);
                assert.match(html, /New Auto JSON/);
                assert.match(html, /data-action="auto-sample"/);
                assert.match(html, /Stop Auto Sample/);
                assert.match(html, /Auto Samples/);
                assert.match(html, /Append Target/);
                assert.match(html, /SPY\.ivts-auto\.json/);
            },
        },
        {
            name: 'runs auto sampling on elapsed time alone, not on the UTC date',
            run() {
                const ctx = loadPageContext(null);
                const { shouldRunAutoSample } = ctx.OptionComboIvTermStructurePage._test;
                const history = {
                    samples: [{ sampledAt: '2026-07-13T10:00:00.000Z' }],
                };

                assert.equal(shouldRunAutoSample({ samples: [] }, new Date('2026-07-13T10:10:00.000Z')), true);
                assert.equal(shouldRunAutoSample(history, new Date('2026-07-13T10:59:59.000Z')), false);
                assert.equal(shouldRunAutoSample(history, new Date('2026-07-13T11:00:00.000Z')), true);

                // A long lapse (page closed for days) is already covered by the
                // elapsed check — no separate date trigger needed.
                assert.equal(shouldRunAutoSample(history, new Date('2026-07-16T09:00:00.000Z')), true);

                // Rolling past 00:00 UTC must not force an off-cadence sample:
                // it is ~20:00 ET, minutes after the 23:30 UTC sample here.
                const lateSample = { samples: [{ sampledAt: '2026-07-13T23:30:00.000Z' }] };
                assert.equal(shouldRunAutoSample(lateSample, new Date('2026-07-14T00:01:00.000Z')), false);
                assert.equal(shouldRunAutoSample(lateSample, new Date('2026-07-14T00:30:00.000Z')), true);
            },
        },
        {
            name: 'requires a usable near-seven-day straddle before saving an auto sample',
            run() {
                const ctx = loadPageContext(null);
                const { hasUsableWatermarkSeed } = ctx.OptionComboIvTermStructurePage._test;

                assert.equal(hasUsableWatermarkSeed({
                    underlyingPrice: 600,
                    details: [{ dte: 7, atmStraddleMark: 8.25 }],
                }), true);
                assert.equal(hasUsableWatermarkSeed({
                    underlyingPrice: 600,
                    details: [{ dte: 14, atmStraddleMark: 12 }],
                }), false);
                assert.equal(hasUsableWatermarkSeed({
                    underlyingPrice: 600,
                    details: [{ dte: 7, atmStraddleMark: null }],
                }), false);
            },
        },
        {
            name: 'loads an existing automatic JSON as the current append target',
            async run() {
                const fileHandle = {
                    name: 'SPY.ivts-auto.json',
                    async getFile() {
                        return {
                            async text() {
                                return JSON.stringify({
                                    symbol: 'SPY',
                                    purpose: 'iv-term-structure-auto-samples',
                                    samples: [{ sampledAt: '2026-07-13T15:00:00.000Z' }],
                                });
                            },
                        };
                    },
                    async createWritable() {
                        return { async write() {}, async close() {} };
                    },
                };
                const ctx = loadPageContext(null, {
                    async showOpenFilePicker() {
                        return [fileHandle];
                    },
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                });

                await testApi.loadAutoHistoryFile(card);

                assert.equal(card.autoFileHandle, fileHandle);
                assert.equal(card.autoHistoryDocument.samples.length, 1);
                assert.equal(card.lastAutoSampleLabel, '2026-07-13T15:00:00.000Z');
                assert.equal(testApi.autoAppendTargetLabel(card), 'SPY.ivts-auto.json');
            },
        },
        {
            name: 'initializes an automatic sample file as valid JSON before the first live sample',
            async run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                let written = '';
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                });
                card.autoHistoryDocument = testApi.normalizeAutoHistoryDocument(null, 'SPY');
                card.autoFileHandle = {
                    async createWritable() {
                        return {
                            async write(value) {
                                written = value;
                            },
                            async close() {},
                        };
                    },
                };

                await testApi.writeAutoHistoryDocument(card);
                const parsed = JSON.parse(written);

                assert.equal(parsed.symbol, 'SPY');
                assert.equal(parsed.purpose, 'iv-term-structure-auto-samples');
                assert.equal(parsed.cadenceMinutes, 60);
                assert.equal(parsed.samples.length, 0);
            },
        },
        {
            name: 'reuses the selected automatic sample file when sampling resumes in the same page session',
            async run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const card = testApi.createCardState({
                    symbol: 'SPY',
                    historyPath: 'iv_term_structure/data/SPY.json',
                });
                card.autoFileHandle = {
                    name: 'SPY.ivts-auto.json',
                    async getFile() {
                        return {
                            async text() {
                                return JSON.stringify({
                                    symbol: 'SPY',
                                    purpose: 'iv-term-structure-auto-samples',
                                    samples: [{ sampledAt: '2026-07-14T01:00:00.000Z' }],
                                });
                            },
                        };
                    },
                };

                const result = await testApi.prepareAutoHistoryFile(card);

                assert.equal(result, 'reused');
                assert.equal(card.autoHistoryDocument.samples.length, 1);
                assert.equal(card.lastAutoSampleLabel, '2026-07-14T01:00:00.000Z');
                assert.equal(testApi.autoSampleButtonLabel(card), 'Resume Auto Sample');
            },
        },
        {
            name: 'uses all expiry detail rows as the primary visible table',
            run() {
                const ctx = loadPageContext(null);
                const comparedRows = {
                    bucketRows: [{ label: '1D' }, { label: '1W' }],
                    detailRows: [
                        { expiry: '20260610' },
                        { expiry: '20260611' },
                        { expiry: '20260612' },
                    ],
                };

                const primaryRows = ctx.OptionComboIvTermStructurePage._test.getPrimaryExpiryRows(comparedRows);

                assert.equal(primaryRows.length, 3);
                assert.equal(primaryRows[0].expiry, '20260610');
                assert.equal(primaryRows[2].expiry, '20260612');
            },
        },
        {
            name: 'formats call and put IV as one compact pair',
            run() {
                const ctx = loadPageContext(null);
                const { formatIvPair } = ctx.OptionComboIvTermStructurePage._test;

                assert.equal(formatIvPair(0.12, 0.13), '12%/13%');
                assert.equal(formatIvPair(0.1234, 0.1356), '12.34%/13.56%');
                assert.equal(formatIvPair(null, 0.13), '--/13%');
            },
        },
        {
            name: 'renders primary expiry table without separate ATM IV columns',
            run() {
                const ctx = loadPageContext(null);
                const html = ctx.OptionComboIvTermStructurePage._test.buildPrimaryExpiryTable({
                    baselineExpiry: '',
                    detailRows: [{
                        expiry: '20260610',
                        dte: 0,
                        atmStrike: 500,
                        callIv: 0.12,
                        putIv: 0.13,
                        atmIv: 0.125,
                        atmStraddleMark: 5.79,
                    }],
                });

                assert.match(html, /<th>Call\/Put IV<\/th>/);
                assert.doesNotMatch(html, /<th>Call IV<\/th>/);
                assert.doesNotMatch(html, /<th>Put IV<\/th>/);
                assert.doesNotMatch(html, /<th>ATM IV<\/th>/);
                assert.doesNotMatch(html, /<th>ATM Strike<\/th>/);
                assert.equal((html.match(/<th>ATM Straddle<\/th>/g) || []).length, 1);
                assert.equal((html.match(/<th[^>]*>Total Var<\/th>/g) || []).length, 1);
                assert.equal((html.match(/<th[^>]*>Fwd Var<\/th>/g) || []).length, 1);
                assert.match(html, /\$5\.79/);
                assert.match(html, />TD IV<\/th>/);
                assert.match(html, />Impl λ<\/th>/);
                assert.match(html, /12%\/13%/);
                assert.equal((html.match(/<th[\s>]/g) || []).length, 10);
            },
        },
        {
            name: 'derives both variance columns from real straddle BBO and marks a negative interval',
            run() {
                const ctx = loadPageContext(null);
                const core = ctx.OptionComboIvTermStructureCore;
                const {
                    resolveTotalVarianceObservation,
                    resolveForwardVarianceObservation,
                    buildTotalVarianceCell,
                    buildForwardVarianceCell,
                } = ctx.OptionComboIvTermStructurePage._test;
                const buildRow = (dte, totalVariance) => {
                    const timeYears = dte / 365;
                    const straddle = core.priceStraddleFromTotalVol(
                        'black76', 100, 100, timeYears, 0.04, Math.sqrt(totalVariance)
                    );
                    const half = straddle / 2;
                    return {
                        dte,
                        timeYears,
                        atmStrike: 100,
                        atmStraddleMark: straddle,
                        callBid: half * 0.999,
                        callAsk: half * 1.001,
                        putBid: half * 0.999,
                        putAsk: half * 1.001,
                        callMarkSource: 'bid_ask_mid',
                        putMarkSource: 'bid_ask_mid',
                        // Deliberately absurd vendor IV proves the display
                        // observation does not consult it.
                        callIv: 9.99,
                        putIv: 9.99,
                    };
                };
                const front = buildRow(7, 0.0016);
                const back = buildRow(14, 0.0012);
                const observed = resolveTotalVarianceObservation(front);
                assert.ok(Math.abs(observed.totalVariance - 0.0016) < 1e-12);
                assert.equal(observed.varianceSource, 'straddle_bbo_inversion');
                const frontForward = resolveForwardVarianceObservation(front);
                assert.ok(Math.abs(frontForward.annualizedForwardVariance - (0.0016 / (7 / 365))) < 1e-12);
                const inverted = resolveForwardVarianceObservation(back, front);
                assert.ok(inverted.annualizedForwardVariance < 0);
                assert.match(buildTotalVarianceCell(front), />16\.0<\/span>/);
                assert.match(buildTotalVarianceCell(front), /real Call\+Put BBO midpoint straddle/);
                assert.match(buildTotalVarianceCell(back, front), /is-inverted/);
                assert.match(buildTotalVarianceCell(back, front), /hard inversion candidate/);
                assert.match(buildForwardVarianceCell(front), /no vendor IV, fitted λ, or TD IV/);
                assert.match(buildForwardVarianceCell(back, front), /is-negative/);
                assert.match(buildForwardVarianceCell(back, front), /hard cumulative-variance inversion candidate/);

                const vendorOnly = {
                    dte: 7,
                    timeYears: 7 / 365,
                    atmStrike: 100,
                    callIv: 0.3,
                    putIv: 0.3,
                    callMark: 2.1,
                    putMark: 1.9,
                    atmStraddleMark: 4,
                    callMarkSource: 'model',
                    putMarkSource: 'last_close',
                };
                assert.equal(resolveTotalVarianceObservation(vendorOnly), null);
                const bestEffort = resolveTotalVarianceObservation(vendorOnly, { bestEffort: true });
                assert.ok(bestEffort);
                assert.equal(bestEffort.varianceSource, 'straddle_display_mark_inversion');
                assert.equal(bestEffort.isBestEffort, true);
                assert.match(buildTotalVarianceCell(vendorOnly, null, { bestEffort: true }), /is-estimated/);
                assert.match(buildTotalVarianceCell(vendorOnly, null, { bestEffort: true }), /≈/);
                assert.match(buildTotalVarianceCell(vendorOnly, null, { bestEffort: true }), /Call model, Put last_close/);

                const missingMiddle = {
                    dte: 10,
                    timeYears: 10 / 365,
                    atmStrike: 100,
                };
                const later = buildRow(14, 0.0024);
                assert.equal(resolveForwardVarianceObservation(later, missingMiddle), null);
                assert.match(buildForwardVarianceCell(later, missingMiddle), /ivts-missing/);
            },
        },
        {
            name: 'renders the implied-lambda cell for the interval ending at an expiry',
            run() {
                const ctx = loadPageContext(null);
                const { buildImpliedLambdaCell } = ctx.OptionComboIvTermStructurePage._test;
                const impliedLambda = {
                    intervals: [
                        {
                            endExpiry: '20260720',
                            status: 'ok',
                            lambda: 0.132,
                            lambdaClamped: 0.132,
                            baselineCount: 4,
                            nonTradingDates: ['2026-07-18', '2026-07-19'],
                            isFront: true,
                        },
                        {
                            endExpiry: '20260727',
                            status: 'no_baseline',
                            lambda: null,
                            lambdaClamped: null,
                            baselineCount: 0,
                            nonTradingDates: ['2026-07-25', '2026-07-26'],
                            isFront: false,
                        },
                    ],
                };

                const okCell = buildImpliedLambdaCell({ expiry: '20260720' }, impliedLambda);
                assert.match(okCell, /0\.132/);
                assert.match(okCell, /2026-07-18, 2026-07-19/);
                assert.match(okCell, /front interval/);

                const flaggedCell = buildImpliedLambdaCell({ expiry: '20260727' }, impliedLambda);
                assert.match(flaggedCell, /ivts-missing/);
                assert.match(flaggedCell, /no pure trading-day interval/);

                assert.equal(buildImpliedLambdaCell({ expiry: '20260721' }, impliedLambda), '');
                assert.equal(buildImpliedLambdaCell({ expiry: '20260720' }, null), '');

                const rejectedRowCell = buildImpliedLambdaCell(
                    { expiry: '20260721' },
                    {
                        intervals: [],
                        rowDiagnostics: [{ expiry: '20260721', status: 'forward_mismatch' }],
                    }
                );
                assert.match(rejectedRowCell, /ivts-missing/);
                assert.match(rejectedRowCell, /call-put parity forward/);

                const invertedCell = buildImpliedLambdaCell(
                    { expiry: '20260727' },
                    { intervals: [{
                        endExpiry: '20260727', status: 'ok', rawLambda: -0.1287,
                        baselineCount: 3, baselineMode: 'nearest_extrapolated',
                        profileClockFallback: true,
                        nonTradingDates: ['2026-07-25', '2026-07-26'],
                    }] }
                );
                assert.match(invertedCell, /-0\.129/);
                assert.match(invertedCell, /ivts-lambda-inverted/);
                assert.match(invertedCell, /signed λ is preserved/);
                assert.match(invertedCell, /product-profile expiry clock fallback/);
            },
        },
        {
            name: 'renders the trading-day IV cell from converted pair values',
            run() {
                const ctx = loadPageContext(null);
                const { buildIvPairTdCell } = ctx.OptionComboIvTermStructurePage._test;

                assert.match(
                    buildIvPairTdCell({ callIvTd: 0.2410, putIvTd: 0.2395, tradDte: 3 }),
                    /24\.1%\/23\.95%/
                );
                assert.match(
                    buildIvPairTdCell({ callIvTd: 0.2410, putIvTd: 0.2395, tradDte: 3 }),
                    /Trading DTE: 3/
                );
                assert.match(
                    buildIvPairTdCell({ callIvTd: 0.2410, putIvTd: 0.2395, tradDte: 3, tdIvWeekendWeight: 0.3 }),
                    /λ=0\.30/
                );
                assert.match(
                    buildIvPairTdCell({
                        callIvTd: 0.2410,
                        putIvTd: 0.2395,
                        tradDte: 3,
                        tdIvEffectiveDte: 3.4,
                        tdIvWeekendWeight: 0.2,
                        tdIvSource: 'implied_lambda',
                        tdIvAppliedWeights: {
                            '2026-07-25': 0.2,
                            '2026-07-26': 0.2,
                        },
                    }),
                    /Structured implied λ clock/
                );
                assert.match(
                    buildIvPairTdCell({
                        callIvTd: 0.13,
                        putIvTd: 0.13,
                        tdIvWeekendWeight: 0.2,
                        tdIvSource: 'implied_lambda',
                        tdIvAppliedWeights: {
                            '2026-08-01': 0.2,
                            '2026-08-02': 0.2,
                        },
                        tdIvStatus: 'ok_extrapolated',
                        tdIvExtrapolatedWeightDates: ['2026-08-01', '2026-08-02'],
                    }),
                    /Median λ extrapolated to: 2026-08-01, 2026-08-02/
                );
                assert.match(
                    buildIvPairTdCell({ callIvTd: null, putIvTd: null }),
                    /ivts-missing/
                );
                assert.match(
                    buildIvPairTdCell({ subscriptionSelected: false, callIvTd: 0.2, putIvTd: 0.2 }),
                    /Not subscribed/
                );
            },
        },
        {
            name: 'defaults the straddle baseline to the nearest-7-DTE expiry and renders the TD Slope column',
            run() {
                const ctx = loadPageContext(null);
                const { resolveSelectedStraddleBaselineExpiry, buildPrimaryExpiryTable } = ctx.OptionComboIvTermStructurePage._test;
                const rows = [
                    { expiry: '20260714', dte: 1, atmIv: 0.01, atmIvTd: 0.1523, hasCompletePair: true },
                    { expiry: '20260715', dte: 2, atmIv: 0.99, atmIvTd: 0.1375, hasCompletePair: true },
                    { expiry: '20260720', dte: 7, atmIv: 0.01, atmIvTd: 0.1150, hasCompletePair: true },
                    { expiry: '20260724', dte: 11, atmIv: 0.99, atmIvTd: 0.1100, hasCompletePair: true },
                ];

                // No explicit selection -> nearest 7 DTE; explicit selection wins;
                // stale selection falls back to the default.
                assert.equal(resolveSelectedStraddleBaselineExpiry({}, rows), '20260720');
                assert.equal(resolveSelectedStraddleBaselineExpiry({ straddleBaselineExpiry: '20260715' }, rows), '20260715');
                assert.equal(resolveSelectedStraddleBaselineExpiry({ straddleBaselineExpiry: '20991231' }, rows), '20260720');

                const core = ctx.OptionComboIvTermStructureCore;
                const annotated = core.annotateTdSlopeVsBaseline(
                    core.buildStraddleComparisonRows(rows, '20260715'), '20260715');
                const table = buildPrimaryExpiryTable({ detailRows: annotated, baselineExpiry: '20260715' });
                assert.match(table, /TD Slope/);
                assert.match(table, />base</);
                // 1d IV over 2d IV -> backwardation coloring on that pair.
                assert.match(table, /is-slope-backwardation/);

                // Wide pairs (DTE ratio far from the calibrated ~2x) show the
                // number without zone coloring: a normal upward term structure
                // sits below 0.95 there, and painting it purple would read as
                // a reverse-fly signal.
                const wideRows = [
                    { expiry: '20260720', dte: 7, atmIvTd: 0.1150, hasCompletePair: true },
                    { expiry: '20261009', dte: 88, atmIvTd: 0.1600, hasCompletePair: true },
                ];
                const wideAnnotated = core.annotateTdSlopeVsBaseline(
                    core.buildStraddleComparisonRows(wideRows, '20260720'), '20260720');
                assert.ok(wideAnnotated[1].tdSlopeVsBaseline < 0.95);
                const wideTable = buildPrimaryExpiryTable({ detailRows: wideAnnotated, baselineExpiry: '20260720' });
                assert.doesNotMatch(wideTable, /is-slope-contango/);
                assert.doesNotMatch(wideTable, /is-slope-backwardation/);
            },
        },
        {
            name: 'renders the strategy signal panel with zone, slope, watermark, and suggestion',
            run() {
                const ctx = loadPageContext(null);
                const { buildStrategySignalPanel } = ctx.OptionComboIvTermStructurePage._test;
                const row = (expiry, dte, tradDte, atmIv) => ({
                    expiry, dte, tradDte, atmIv, hasCompletePair: true, subscriptionSelected: true,
                    callSnapshotId: 'weekly-close-1', putSnapshotId: 'weekly-close-1',
                    callQuoteAsOf: '2026-07-17T20:20:00Z', putQuoteAsOf: '2026-07-17T20:20:00Z',
                });
                const now = new Date('2026-07-17T20:21:00Z');
                const actionableCard = {
                    symbol: 'SPY',
                    catalog: {
                        anchorDate: '2026-07-17', payloadAsOf: '2026-07-17T20:20:00Z',
                        snapshotId: 'weekly-close-1', coherent: true, quoteComplete: true,
                    },
                };

                const html = buildStrategySignalPanel(
                    actionableCard,
                    { detailRows: [row('20260717', 7, 5, 0.30), row('20260724', 14, 10, 0.22)] },
                    { samples: [] },
                    now
                );
                assert.match(html, /PREVIEW \/ NO ACTION/);
                assert.match(html, /is-preview/);
                assert.match(html, /TD slope/);
                assert.match(html, /Signal as of/);
                assert.match(html, /official signal complete; no next-session execution protocol/);
                assert.match(html, /collecting 0\/8/);
                assert.doesNotMatch(html, /Calendar: sell front ATM straddle/);
                assert.match(html, /no backtested next-session execution protocol exists/);
                assert.match(html, /suggestion only/);

                // Studied symbols carry the per-family MRR research reference
                // eras; instruments outside the study show no borrowed number.
                assert.match(html, /MRR research ref/);
                assert.match(html, /2020-26 1\.10/);
                assert.match(html, /S&amp;P 500 complex/);

                // The zone map spells out the frozen thresholds and lights up
                // the active zone (here: backwardation -> calendar).
                assert.match(html, /Zones/);
                assert.match(html, /&lt;0\.95 reverse fly/);
                assert.match(html, /0\.95–1\.05 stand down/);
                assert.match(html, /&gt;1\.05 calendar/);
                assert.match(html, /is-active">&gt;1\.05 calendar/);
                assert.doesNotMatch(html, /is-active">&lt;0\.95 reverse fly/);
                const unstudied = buildStrategySignalPanel(
                    { ...actionableCard, symbol: 'TLT' },
                    { detailRows: [row('20260717', 7, 5, 0.30), row('20260724', 14, 10, 0.22)] },
                    { samples: [] },
                    now
                );
                assert.doesNotMatch(unstudied, /MRR research ref/);

                // With no accumulated samples the watermark cannot prove the
                // era, so the deep-contango zone shows but withholds the
                // reverse-fly structure (fail closed).
                const contango = buildStrategySignalPanel(
                    actionableCard,
                    { detailRows: [row('20260717', 7, 5, 0.15), row('20260724', 14, 10, 0.21)] },
                    { samples: [] },
                    now
                );
                assert.match(contango, /PREVIEW \/ NO ACTION/);
                assert.doesNotMatch(contango, /Reverse iron fly: buy/);
                assert.match(contango, /no backtested next-session execution protocol exists/);
                assert.match(contango, /is-active">&lt;0\.95 reverse fly/);

                // Signal timestamp authenticates the curve but must not rewind
                // the MRR staleness clock away from wall-clock now.
                const originalWatermark = ctx.OptionComboIvTermStructureCore.computeDisplacementWatermark;
                let watermarkAsOf = null;
                ctx.OptionComboIvTermStructureCore.computeDisplacementWatermark = (samples, options) => {
                    watermarkAsOf = options.asOf;
                    return originalWatermark(samples, options);
                };
                buildStrategySignalPanel(actionableCard, {
                    detailRows: [row('20260717', 7, 5, 0.30), row('20260724', 14, 10, 0.22)],
                }, { samples: [] }, now);
                assert.equal(watermarkAsOf, now);
                ctx.OptionComboIvTermStructureCore.computeDisplacementWatermark = originalWatermark;

                const empty = buildStrategySignalPanel(actionableCard, { detailRows: [] }, { samples: [] }, now);
                assert.match(empty, /NO SIGNAL/);
                assert.match(empty, /subscribe\/sync/);

                // A missing or legacy CME snapshot fails closed: the proxy
                // slope remains visible, but no strategy is presented.
                ctx.OptionComboOfficialExchangeCalendars.calendars['CME:ES'].derivationVersion = 'legacy';
                const es = buildStrategySignalPanel(
                    { symbol: 'ES', profile: { calendarId: 'CME:ES' } },
                    { detailRows: [row('20260717', 7, 5, 0.30), row('20260724', 14, 10, 0.22)] },
                    { samples: [] }
                );
                assert.match(es, /calendar unavailable \(CME:ES official snapshot missing\/stale\)/);
                // FOP families disclose which ETF chain the reference eras
                // were measured on.
                assert.match(es, /MRR research ref/);
                assert.match(es, /via SPY/);
                assert.match(es, /CALENDAR UNAVAILABLE/);
                assert.match(es, /is-calendar_unavailable/);
                assert.match(es, /official trading calendar is unavailable — no strategy suggestion/);
                assert.doesNotMatch(es, /SELL CALENDAR/);
                assert.doesNotMatch(es, /Calendar: sell front ATM straddle/);
            },
        },
        {
            name: 'keeps weekly strategy signals non-actionable until a timestamped official close',
            run() {
                const ctx = loadPageContext(null);
                const { evaluateWeeklySignalReadiness, buildStrategySignalPanel } = ctx.OptionComboIvTermStructurePage._test;
                const partialCard = {
                    symbol: 'SPY',
                    catalog: { anchorDate: '2026-07-13', payloadAsOf: '2026-07-13T21:00:00Z' },
                };
                const preCloseCard = {
                    symbol: 'SPY',
                    catalog: { anchorDate: '2026-07-17', payloadAsOf: '2026-07-17T20:14:00Z' },
                };
                const closedCard = {
                    symbol: 'SPY',
                    catalog: {
                        anchorDate: '2026-07-17', payloadAsOf: '2026-07-17T20:15:00Z',
                        batchId: 'close-batch', coherent: true, quoteComplete: true,
                    },
                };
                const coherentRows = (asOf, snapshotId = 'close-batch') => [
                    {
                        expiry: '20260717', dte: 7, tradDte: 5, atmIv: 0.30,
                        hasCompletePair: true, subscriptionSelected: true,
                        callSnapshotId: snapshotId, putSnapshotId: snapshotId,
                        callQuoteAsOf: asOf, putQuoteAsOf: asOf,
                    },
                    {
                        expiry: '20260724', dte: 14, tradDte: 10, atmIv: 0.22,
                        hasCompletePair: true, subscriptionSelected: true,
                        callSnapshotId: snapshotId, putSnapshotId: snapshotId,
                        callQuoteAsOf: asOf, putQuoteAsOf: asOf,
                    },
                ];
                const contextFor = (asOf, snapshotId) => {
                    const detailRows = coherentRows(asOf, snapshotId);
                    return { detailRows, signal: ctx.OptionComboIvTermStructureCore.computeRegimeSignal(detailRows) };
                };

                assert.equal(
                    evaluateWeeklySignalReadiness(partialCard, new Date('2026-07-13T21:01:00Z')).status,
                    'partial_week'
                );
                assert.equal(
                    evaluateWeeklySignalReadiness(preCloseCard, new Date('2026-07-17T20:16:00Z')).status,
                    'pre_close'
                );
                const completed = evaluateWeeklySignalReadiness(
                        closedCard,
                        new Date('2026-07-17T20:16:00Z'),
                        contextFor('2026-07-17T20:15:00Z', 'close-batch')
                    );
                assert.equal(completed.status, 'execution_protocol_unavailable');
                assert.equal(completed.signalComplete, true);
                assert.equal(completed.actionable, false);
                assert.equal(
                    evaluateWeeklySignalReadiness(closedCard, new Date('2026-07-17T20:14:00Z')).status,
                    'future'
                );

                // Independence Day is observed Friday 3 July, so Thursday is
                // the official final session. A coherent close observation is
                // complete but still non-executable without a tested entry rule.
                const holidayComplete = evaluateWeeklySignalReadiness({
                    symbol: 'SPY',
                    catalog: {
                        anchorDate: '2026-07-02', payloadAsOf: '2026-07-02T20:15:00Z',
                        snapshotId: 'holiday-close', coherent: true, quoteComplete: true,
                    },
                }, new Date('2026-07-02T20:16:00Z'), {
                    detailRows: coherentRows('2026-07-02T20:15:00Z', 'holiday-close'),
                    signal: ctx.OptionComboIvTermStructureCore.computeRegimeSignal(
                        coherentRows('2026-07-02T20:15:00Z', 'holiday-close')
                    ),
                });
                assert.equal(holidayComplete.status, 'execution_protocol_unavailable');
                assert.equal(holidayComplete.signalComplete, true);
                assert.equal(holidayComplete.actionable, false);

                // An older, internally valid Friday cannot be paired with a
                // newer week's quotes once the newer official close exists.
                const staleAnchor = {
                    symbol: 'SPY',
                    catalog: {
                        anchorDate: '2026-07-10', payloadAsOf: '2026-07-10T20:15:00Z',
                        snapshotId: 'old-close', coherent: true, quoteComplete: true,
                    },
                };
                assert.equal(evaluateWeeklySignalReadiness(
                    staleAnchor,
                    new Date('2026-07-17T20:16:00Z'),
                    contextFor('2026-07-10T20:15:00Z', 'old-close')
                ).status, 'stale_anchor');

                // Client receipt time is presentation-only, and an
                // incremental changed-ticker batch cannot certify the curve.
                assert.equal(evaluateWeeklySignalReadiness({
                    symbol: 'SPY',
                    catalog: { anchorDate: '2026-07-17' },
                    lastSyncLabel: '2026-07-17T20:15:00Z',
                }, new Date('2026-07-17T20:16:00Z')).status, 'missing_snapshot');
                assert.equal(evaluateWeeklySignalReadiness({
                    symbol: 'SPY',
                    catalog: {
                        anchorDate: '2026-07-17', payloadAsOf: '2026-07-17T20:15:00Z',
                        batchId: 'incremental', coherent: false, quoteComplete: false,
                    },
                }, new Date('2026-07-17T20:16:00Z'), contextFor(
                    '2026-07-17T20:15:00Z', 'incremental'
                )).status, 'incoherent_snapshot');

                const row = (expiry, dte, tradDte, atmIv) => ({
                    expiry, dte, tradDte, atmIv, hasCompletePair: true, subscriptionSelected: true,
                });
                const preview = buildStrategySignalPanel(
                    preCloseCard,
                    { detailRows: [row('20260717', 7, 5, 0.30), row('20260724', 14, 10, 0.22)] },
                    { samples: [] },
                    new Date('2026-07-17T20:16:00Z')
                );
                assert.match(preview, /PREVIEW \/ NO ACTION/);
                assert.match(preview, /preview before official option close/);
                assert.doesNotMatch(preview, /Calendar: sell front ATM straddle/);
            },
        },
        {
            name: 'normalizes and persists the global TD IV lambda with a 0.3 default',
            run() {
                const stored = {};
                const ctx = loadPageContext(null);
                ctx.localStorage = {
                    getItem(key) {
                        return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null;
                    },
                    setItem(key, value) {
                        stored[key] = String(value);
                    },
                };
                const testApi = ctx.OptionComboIvTermStructurePage._test;

                assert.equal(testApi.normalizeTdIvLambda(undefined), 0.3);
                assert.equal(testApi.normalizeTdIvLambda('junk'), 0.3);
                assert.equal(testApi.normalizeTdIvLambda(-1), 0);
                assert.equal(testApi.normalizeTdIvLambda(2), 1);
                assert.equal(testApi.normalizeTdIvLambda('0.35'), 0.35);

                // Nothing stored yet: caller falls back to the 0.3 default.
                assert.equal(testApi.loadSavedTdIvLambda(), null);
                testApi.saveTdIvLambda(0.45);
                assert.equal(testApi.loadSavedTdIvLambda(), 0.45);
                // Junk in storage is ignored rather than trusted.
                stored.optionComboIvtsTdIvLambdaGlobal = 'garbage';
                assert.equal(testApi.loadSavedTdIvLambda(), null);
            },
        },
        {
            name: 'renders calendar finder summary and top candidates',
            run() {
                const ctx = loadPageContext(null);
                const html = ctx.OptionComboIvTermStructurePage._test.buildCalendarFinderSection({
                    symbol: 'SPY',
                    calendarFinder: {
                        targetRatio: 2,
                        targetPreset: '2',
                        tolerancePct: 25,
                        shortMinDte: 3,
                        shortMaxDte: 60,
                        sortBy: 'best_iv_ratio',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260620', dte: 10, atmIv: 0.5, atmStraddleMark: 10, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260623', dte: 13, atmIv: 0.3, atmStraddleMark: 12, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260630', dte: 20, atmIv: 0.4, atmStraddleMark: 16, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260710', dte: 30, atmIv: 0.55, atmStraddleMark: 18, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260720', dte: 40, atmIv: 0.6, atmStraddleMark: 21, hasCompletePair: true, hasCompleteStraddle: true },
                    ],
                });

                assert.match(html, /Calendar Finder/);
                assert.match(html, /Best 1\.67X IV/);
                assert.match(html, /Sell Expiry/);
                assert.match(html, /Buy Expiry/);
                assert.match(html, /IV Ratio/);
                assert.match(html, /ATM IV/);
                assert.match(html, /20260620/);
                assert.match(html, /20260623/);
                assert.equal((html.match(/ivts-calendar-row/g) || []).length, 5);
            },
        },
        {
            name: 'renders a secondary calendar recommendation with a later short leg',
            run() {
                const ctx = loadPageContext(null);
                const html = ctx.OptionComboIvTermStructurePage._test.buildCalendarFinderSection({
                    symbol: 'SPY',
                    calendarFinder: {
                        targetRatio: 2,
                        targetPreset: '2',
                        tolerancePct: 50,
                        shortMinDte: 3,
                        shortMaxDte: 60,
                        sortBy: 'best_iv_ratio',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260617', dte: 5, atmIv: 0.8, atmStraddleMark: 10, atmStrike: 600, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260622', dte: 10, atmIv: 0.5, atmStraddleMark: 12, atmStrike: 601, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260627', dte: 15, atmIv: 0.6, atmStraddleMark: 13, atmStrike: 602, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260702', dte: 20, atmIv: 0.9, atmStraddleMark: 17, atmStrike: 603, hasCompletePair: true, hasCompleteStraddle: true },
                    ],
                });

                assert.match(html, /Best/);
                assert.match(html, /Next/);
                assert.match(html, /Later short leg/);
                assert.match(html, /20260617.*20260622/s);
                assert.match(html, /20260622.*20260627/s);
                assert.match(html, /is-calendar-best/);
                assert.match(html, /is-calendar-secondary/);
            },
        },
        {
            name: 'keeps the secondary calendar recommendation visible outside the top five',
            run() {
                const ctx = loadPageContext(null);
                const html = ctx.OptionComboIvTermStructurePage._test.buildCalendarFinderSection({
                    symbol: 'SPY',
                    calendarFinder: {
                        targetRatio: 2,
                        targetPreset: '2',
                        tolerancePct: 40,
                        shortMinDte: 3,
                        shortMaxDte: 60,
                        sortBy: 'best_iv_ratio',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260617', dte: 5, atmIv: 0.9, atmStraddleMark: 10, atmStrike: 600, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260620', dte: 8, atmIv: 0.1, atmStraddleMark: 11, atmStrike: 601, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260621', dte: 9, atmIv: 0.11, atmStraddleMark: 12, atmStrike: 602, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260622', dte: 10, atmIv: 0.12, atmStraddleMark: 13, atmStrike: 603, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260623', dte: 11, atmIv: 0.13, atmStraddleMark: 14, atmStrike: 604, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260624', dte: 12, atmIv: 0.14, atmStraddleMark: 15, atmStrike: 605, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260702', dte: 20, atmIv: 0.5, atmStraddleMark: 20, atmStrike: 606, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260722', dte: 40, atmIv: 0.25, atmStraddleMark: 29, atmStrike: 607, hasCompletePair: true, hasCompleteStraddle: true },
                    ],
                });

                assert.equal((html.match(/ivts-calendar-row/g) || []).length, 6);
                assert.match(html, /20260702.*20260722/s);
                assert.match(html, /is-calendar-secondary/);
            },
        },
        {
            name: 'normalizes calendar finder options for the page controls',
            run() {
                const ctx = loadPageContext(null);
                const config = ctx.OptionComboIvTermStructurePage._test.normalizeCalendarFinderConfig({
                    targetRatio: 'bad',
                    targetPreset: 'custom',
                    tolerancePct: '40',
                    shortMinDte: '5',
                    shortMaxDte: '3',
                    sortBy: 'best_iv_ratio',
                    showAll: true,
                });

                assert.equal(config.targetRatio, 2);
                assert.equal(config.targetPreset, 'custom');
                assert.equal(config.tolerancePct, 40);
                assert.equal(config.shortMinDte, 5);
                assert.equal(config.shortMaxDte, 60);
                assert.equal(config.sortBy, 'best_iv_ratio');
                assert.equal(config.showAll, true);
            },
        },
        {
            name: 'keeps each details section and table scroll state across card rerenders',
            run() {
                const ctx = loadPageContext(null);
                const {
                    bucketDetails,
                    bucketShell,
                    calendarDetails,
                    calendarShell,
                    container,
                    detailsShell,
                    samplingDetails,
                } = createFakeCardForViewState();

                const snapshot = ctx.OptionComboIvTermStructurePage._test.captureCardViewState(container);
                calendarDetails.open = false;
                bucketDetails.open = false;
                samplingDetails.open = false;
                calendarShell.scrollLeft = 0;
                calendarShell.scrollTop = 0;
                bucketShell.scrollLeft = 0;
                detailsShell.scrollLeft = 0;

                ctx.OptionComboIvTermStructurePage._test.restoreCardViewState(container, snapshot);

                assert.equal(calendarDetails.open, true);
                assert.equal(bucketDetails.open, true);
                assert.equal(samplingDetails.open, true);
                assert.equal(calendarShell.scrollLeft, 31);
                assert.equal(calendarShell.scrollTop, 17);
                assert.equal(bucketShell.scrollLeft, 47);
                assert.equal(detailsShell.scrollLeft, 59);
            },
        },
        {
            name: 'normalizes short DTE bounds without rendering a DTE filter',
            run() {
                const ctx = loadPageContext(null);
                const config = ctx.OptionComboIvTermStructurePage._test.normalizeCalendarFinderConfig({
                    targetRatio: '100',
                    targetPreset: 'custom',
                    tolerancePct: '25',
                    shortMinDte: '100',
                    shortMaxDte: '3',
                });
                const html = ctx.OptionComboIvTermStructurePage._test.buildCalendarFinderSection({
                    symbol: 'SPY',
                    calendarFinder: {
                        targetRatio: 2,
                        targetPreset: '2',
                        tolerancePct: 25,
                        shortMinDte: 0,
                        shortMaxDte: 60,
                        sortBy: 'best_iv_ratio',
                        showAll: false,
                    },
                }, { detailRows: [] });

                assert.equal(config.targetRatio, 8);
                assert.equal(config.shortMinDte, 100);
                assert.equal(config.shortMaxDte, 100);
                assert.doesNotMatch(html, /data-action="calendar-short-min"/);
                assert.doesNotMatch(html, /Short DTE/);
            },
        },
        {
            name: 'explains why the calendar finder has no candidates',
            run() {
                const ctx = loadPageContext(null);
                const describe = ctx.OptionComboIvTermStructurePage._test.describeCalendarFinderEmptyState;
                const config = ctx.OptionComboIvTermStructurePage._test.normalizeCalendarFinderConfig({});

                assert.match(
                    describe(config, { totalExpiries: 0, usableExpiries: 0, shortCandidates: 0, pairCount: 0 }),
                    /Sync\/Update/
                );
                assert.match(
                    describe(config, { totalExpiries: 6, usableExpiries: 1, shortCandidates: 0, pairCount: 0 }),
                    /1\/6 expiries usable/
                );
                assert.match(
                    describe(config, { totalExpiries: 6, usableExpiries: 4, shortCandidates: 0, pairCount: 0 }),
                    /No sell\/buy expiry pairs/
                );
                assert.match(
                    describe(config, { totalExpiries: 6, usableExpiries: 4, shortCandidates: 2, pairCount: 0 }),
                    /No long-leg expiry/
                );
            },
        },
        {
            name: 'renders the empty-state reason inside the calendar table',
            run() {
                const ctx = loadPageContext(null);
                const html = ctx.OptionComboIvTermStructurePage._test.buildCalendarFinderSection({
                    symbol: 'SPY',
                    calendarFinder: {
                        targetRatio: 2,
                        targetPreset: '2',
                        tolerancePct: 25,
                        shortMinDte: 3,
                        shortMaxDte: 60,
                        sortBy: 'best_iv_ratio',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260620', dte: 10, atmIv: 0.5, atmStraddleMark: 10, hasCompletePair: true, hasCompleteStraddle: true },
                    ],
                });

                assert.match(html, /Waiting for complete ATM IV quotes \(1\/1 expiries usable\)\./);
            },
        },
        {
            name: 'renders a load button per calendar candidate with expiry pair metadata',
            run() {
                const ctx = loadPageContext(null);
                const html = ctx.OptionComboIvTermStructurePage._test.buildCalendarFinderSection({
                    symbol: 'SPY',
                    calendarFinder: {
                        targetRatio: 2,
                        targetPreset: '2',
                        tolerancePct: 25,
                        shortMinDte: 3,
                        shortMaxDte: 60,
                        sortBy: 'best_iv_ratio',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260630', dte: 20, atmIv: 0.5, atmStraddleMark: 16, atmStrike: 600, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260720', dte: 40, atmIv: 0.4, atmStraddleMark: 21, atmStrike: 602, hasCompletePair: true, hasCompleteStraddle: true },
                    ],
                });

                assert.match(html, /data-action="calendar-load"/);
                assert.match(html, /data-short-expiry="20260630"/);
                assert.match(html, /data-long-expiry="20260720"/);
                assert.doesNotMatch(html, /data-action="calendar-load"[^>]*disabled/);
            },
        },
        {
            name: 'disables the load button when ATM strikes are unresolved',
            run() {
                const ctx = loadPageContext(null);
                const html = ctx.OptionComboIvTermStructurePage._test.buildCalendarFinderSection({
                    symbol: 'SPY',
                    calendarFinder: {
                        targetRatio: 2,
                        targetPreset: '2',
                        tolerancePct: 25,
                        shortMinDte: 3,
                        shortMaxDte: 60,
                        sortBy: 'best_iv_ratio',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260630', dte: 20, atmIv: 0.5, atmStraddleMark: 16, hasCompletePair: true, hasCompleteStraddle: true },
                        { expiry: '20260720', dte: 40, atmIv: 0.4, atmStraddleMark: 21, hasCompletePair: true, hasCompleteStraddle: true },
                    ],
                });

                assert.match(html, /data-action="calendar-load"[^>]*disabled/);
            },
        },
        {
            name: 'persists calendar finder config per symbol through localStorage',
            run() {
                const store = {};
                const fakeLocalStorage = {
                    getItem(key) {
                        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
                    },
                    setItem(key, value) {
                        store[key] = String(value);
                    },
                };
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/iv_term_structure_core.js',
                    'js/iv_term_structure.js',
                ], {
                    localStorage: fakeLocalStorage,
                    document: {
                        readyState: 'loading',
                        activeElement: null,
                        addEventListener() {},
                    },
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;

                testApi.saveCalendarFinderConfig('spy', {
                    targetRatio: 2.5,
                    targetPreset: '2.5',
                    tolerancePct: 40,
                    shortMinDte: 5,
                    shortMaxDte: 45,
                    sortBy: 'closest_ratio',
                    showAll: true,
                });

                const restored = testApi.loadSavedCalendarFinderConfig('SPY');
                assert.equal(restored.targetRatio, 2.5);
                assert.equal(restored.tolerancePct, 40);
                assert.equal(restored.shortMinDte, 5);
                assert.equal(restored.shortMaxDte, 45);
                assert.equal(restored.sortBy, 'best_iv_ratio');
                assert.equal(restored.showAll, true);
                assert.equal(testApi.loadSavedCalendarFinderConfig('QQQ'), null);

                assert.equal(testApi.loadSavedOptionStreamLimit('SPY'), null);
                testApi.saveOptionStreamLimit('spy', 20);
                assert.equal(testApi.loadSavedOptionStreamLimit('SPY'), 20);
                testApi.saveOptionStreamLimit('spy', 'all');
                assert.equal(testApi.loadSavedOptionStreamLimit('SPY'), 0);
                assert.equal(testApi.loadSavedOptionStreamLimit('QQQ'), null);

                store.optionComboIvtsCalendarFinder = '{broken json';
                assert.equal(testApi.loadSavedCalendarFinderConfig('SPY'), null);
            },
        },
        {
            name: 'invalidates every card and resyncs only previously active cards once per unexpected recovery epoch',
            async run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Recovery test',
                    symbols: [
                        { symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' },
                        { symbol: 'QQQ', historyPath: 'iv_term_structure/data/QQQ.json' },
                    ],
                }, 'test');
                const spy = testApi.getCard('SPY');
                const qqq = testApi.getCard('QQQ');
                spy.ws = { readyState: 1 };
                spy.catalog = { anchorDate: '2026-07-20', expiryRows: [] };
                spy.quotesBySubId = { call: { mark: 5 } };
                spy.lambdaSnapshot = { snapshotId: 'strict-before-recovery' };
                spy.underlyingPrice = 600;
                spy.impliedLambdaComputedEntry = { snapshotId: 'frozen-calculation' };
                qqq.catalog = { anchorDate: '2026-07-20', expiryRows: [] };
                qqq.quotesBySubId = { put: { mark: 4 } };
                qqq.lambdaSnapshot = { snapshotId: 'inactive-stale-snapshot' };
                qqq.underlyingPrice = 500;

                const syncCalls = [];
                let releaseReplay = null;
                const replayGate = new Promise((resolve) => {
                    releaseReplay = resolve;
                });
                let deferReplay = true;
                const dependencies = {
                    async syncCard(card, options) {
                        syncCalls.push({ symbol: card.symbol, options });
                        // Reproduce the closed-socket race: sync immediately
                        // creates a replacement socket before awaiting open.
                        card.ws = { readyState: 0, replacement: true };
                        if (deferReplay) {
                            await replayGate;
                        }
                    },
                };
                const invalidated = {
                    action: 'ib_connection_status',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 11,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                };
                await testApi.handleIbConnectionStatus(invalidated, dependencies);

                assert.equal(spy.catalog, null);
                assert.equal(Object.keys(spy.quotesBySubId).length, 0);
                assert.equal(spy.lambdaSnapshot, null);
                assert.equal(spy.underlyingPrice, null);
                assert.equal(spy.impliedLambdaComputedEntry.snapshotId, 'frozen-calculation');
                assert.equal(spy.impliedLambdaNeedsRecalculation, true);
                assert.equal(qqq.catalog, null);
                assert.equal(Object.keys(qqq.quotesBySubId).length, 0);
                assert.equal(qqq.lambdaSnapshot, null);
                assert.equal(qqq.underlyingPrice, null);

                // A duplicate invalidated frame arriving after the old card
                // socket closes must union with, rather than replace, the
                // active intent captured by the first frame.
                spy.ws = null;
                await testApi.handleIbConnectionStatus(invalidated, dependencies);
                assert.deepEqual(
                    Array.from(testApi.getRecoveryState().activeSymbols),
                    ['SPY']
                );

                const ready = {
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 11,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                };
                const firstReady = testApi.handleIbConnectionStatus(ready, dependencies);
                const duplicateReady = testApi.handleIbConnectionStatus(ready, dependencies);
                assert.deepEqual(syncCalls.map(call => call.symbol), ['SPY']);
                releaseReplay();
                await Promise.all([firstReady, duplicateReady]);
                assert.equal(syncCalls[0].options.waitForQuotes, false);
                assert.equal(syncCalls[0].options.automatic, true);
                assert.deepEqual(
                    JSON.parse(JSON.stringify(testApi.getRecoveryState().replayClaims)),
                    [{ symbol: 'SPY', generation: 11, state: 'complete' }]
                );

                spy.underlyingPrice = 615;
                spy.catalog = { anchorDate: '2026-07-21', expiryRows: [] };
                await testApi.handleIbConnectionStatus({
                    ...invalidated,
                    marketDataGeneration: 10,
                }, dependencies);
                await testApi.handleIbConnectionStatus({
                    ...invalidated,
                    marketDataGeneration: 11,
                }, dependencies);
                assert.equal(spy.underlyingPrice, 615);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');

                syncCalls.length = 0;
                spy.catalog = { anchorDate: '2026-07-20', expiryRows: [] };
                await testApi.handleIbConnectionStatus({
                    ...ready,
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 12,
                    recoveryReason: 'explicit_stream_reset',
                    automaticReplayAllowed: false,
                }, dependencies);
                await testApi.handleIbConnectionStatus({
                    ...ready,
                    marketDataGeneration: 12,
                    recoveryReason: 'explicit_stream_reset',
                    automaticReplayAllowed: false,
                }, dependencies);
                assert.deepEqual(syncCalls, []);

                // Startup may initially say replay=false, then become
                // authoritative-ready in the same generation once a waiting
                // subscription is known. Preserve and replay that intent.
                deferReplay = false;
                spy.ws = { readyState: 1 };
                const startupUnavailable = {
                    ...ready,
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 13,
                    recoveryReason: 'startup_subscription_wait',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                };
                await testApi.handleIbConnectionStatus(startupUnavailable, dependencies);
                await testApi.handleIbConnectionStatus(startupUnavailable, dependencies);
                assert.deepEqual(syncCalls.map(call => call.symbol), ['SPY']);
                assert.equal(syncCalls[0].options.automatic, true);
                spy.ws = null;
                await testApi.handleIbConnectionStatus({
                    ...ready,
                    marketDataGeneration: 13,
                    recoveryReason: 'startup_subscription_wait',
                    automaticReplayAllowed: true,
                }, dependencies);
                assert.deepEqual(syncCalls.map(call => call.symbol), ['SPY']);
                assert.equal(
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    null
                );
            },
        },
        {
            name: 'rejects unstamped or stale IVTS payloads after a recovery epoch is known',
            async run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Generation gate test',
                    symbols: [
                        { symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' },
                    ],
                }, 'test');
                const card = testApi.getCard('SPY');
                const handlers = {};
                const ws = {
                    readyState: 1,
                    addEventListener(type, handler) {
                        handlers[type] = handler;
                    },
                };
                card.ws = ws;
                testApi.attachSocketHandlers(card, ws);
                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 7,
                    recoveryReason: 'connected',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                });

                handlers.message({
                    data: JSON.stringify({ underlyingPrice: 700 }),
                });
                handlers.message({
                    data: JSON.stringify({
                        marketDataGeneration: 6,
                        underlyingPrice: 701,
                    }),
                });
                assert.equal(card.underlyingPrice, null);

                handlers.message({
                    data: JSON.stringify({
                        marketDataGeneration: 7,
                        underlyingPrice: 702,
                    }),
                });
                assert.equal(card.underlyingPrice, 702);
            },
        },
        {
            name: 'keeps clean ready unblocked and applies reset acknowledgements monotonically',
            async run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Reset acknowledgement race test',
                    symbols: [
                        { symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' },
                    ],
                }, 'test');
                const card = testApi.getCard('SPY');
                const syncCalls = [];
                const dependencies = {
                    async syncCard(candidate) {
                        syncCalls.push(candidate.symbol);
                    },
                };

                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                }, dependencies);
                assert.equal(
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    null
                );
                card.underlyingPrice = 610;

                // No INVALIDATED status was observed for generation 1.
                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 1,
                    recoveryReason: 'explicit_stream_reset',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: false,
                }, dependencies);
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 1);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
                assert.equal(
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    1
                );
                assert.equal(testApi.getRecoveryState().explicitResetEpoch, 1);
                assert.deepEqual(syncCalls, []);

                testApi.handleApiMarketDataReset({
                    action: 'api_market_data_subscriptions_reset',
                    success: true,
                    marketDataGeneration: 0,
                    message: 'Stale reset acknowledgement.',
                });
                assert.equal(card.underlyingPrice, 610);
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 1);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
                assert.equal(testApi.getRecoveryState().explicitResetEpoch, 1);

                testApi.handleApiMarketDataReset({
                    action: 'api_market_data_subscriptions_reset',
                    success: true,
                    marketDataGeneration: 1,
                    message: 'Current reset acknowledgement.',
                });
                assert.equal(card.underlyingPrice, null);
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 1);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
                assert.equal(
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    1
                );
                assert.equal(
                    testApi.getRecoveryState().explicitResetEpoch,
                    1,
                    'status and acknowledgement for one reset share one boundary'
                );

                // A higher-generation reset acknowledgement may already
                // report READY after a fast reconnect. Adopt that state while
                // retaining the explicit manual boundary.
                testApi.handleApiMarketDataReset({
                    action: 'api_market_data_subscriptions_reset',
                    success: true,
                    marketDataGeneration: 2,
                    marketDataState: 'ready',
                    recoveryReason: 'explicit_stream_reset',
                    message: 'Fast reconnect completed.',
                });
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 2);
                assert.equal(testApi.getRecoveryState().marketDataState, 'ready');
                assert.equal(
                    testApi.getRecoveryState().automaticReplayBlockedGeneration,
                    2
                );
                assert.equal(testApi.getRecoveryState().explicitResetEpoch, 2);
                assert.deepEqual(syncCalls, []);
            },
        },
        {
            name: 'aborts manual and automatic sample writes when live evidence is invalidated in flight',
            async run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Sampling invalidation test',
                    symbols: [
                        { symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' },
                    ],
                }, 'test');
                const card = testApi.getCard('SPY');

                let resolveWritable = null;
                let writableWriteCount = 0;
                let writableCloseCount = 0;
                let writableAbortCount = 0;
                card.autoHistoryDocument = {
                    purpose: 'iv_term_structure_auto_samples',
                    symbol: 'SPY',
                    samples: [],
                };
                card.autoFileHandle = {
                    createWritable() {
                        return new Promise((resolve) => {
                            resolveWritable = resolve;
                        });
                    },
                };
                const guardedWrite = testApi.writeAutoHistoryDocument(card, {
                    expectedMarketEvidenceEpoch: card.marketEvidenceEpoch,
                });
                await Promise.resolve();
                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 20,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });
                resolveWritable({
                    async write() {
                        writableWriteCount += 1;
                    },
                    async close() {
                        writableCloseCount += 1;
                    },
                    async abort() {
                        writableAbortCount += 1;
                    },
                });
                await assert.rejects(guardedWrite, /invalidated before the sample/i);
                assert.equal(writableWriteCount, 0);
                assert.equal(writableCloseCount, 0);
                assert.equal(writableAbortCount, 1);

                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 20,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: true,
                });

                const sampleRecord = {
                    symbol: 'SPY',
                    sampledAt: '2026-07-23T12:00:00.000Z',
                    underlyingPrice: 600,
                    details: [{ dte: 7, atmStraddleMark: 10 }],
                };
                card.autoSamplingEnabled = true;
                let releaseAutoRead = null;
                let signalAutoRead = null;
                const autoReadStarted = new Promise((resolve) => {
                    signalAutoRead = resolve;
                });
                const autoReadGate = new Promise((resolve) => {
                    releaseAutoRead = resolve;
                });
                let autoWriteCount = 0;
                const autoSample = testApi.runAutoSample(card, 'test', {
                    async syncCard() {},
                    buildSampleRecord() {
                        return sampleRecord;
                    },
                    async readAutoHistoryFile() {
                        signalAutoRead();
                        await autoReadGate;
                        return {
                            purpose: 'iv_term_structure_auto_samples',
                            symbol: 'SPY',
                            samples: [],
                        };
                    },
                    async writeAutoHistoryDocument() {
                        autoWriteCount += 1;
                    },
                });
                await autoReadStarted;
                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 21,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });
                releaseAutoRead();
                assert.equal(await autoSample, false);
                assert.equal(autoWriteCount, 0);

                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: true,
                    connecting: false,
                    marketDataState: 'ready',
                    marketDataGeneration: 21,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: true,
                });
                card.currentFileHandle = {
                    async createWritable() {
                        throw new Error('injected writer should be used');
                    },
                };
                card.historyDocument = { symbol: 'SPY', samples: [] };
                let releaseManualSync = null;
                let signalManualSync = null;
                const manualSyncStarted = new Promise((resolve) => {
                    signalManualSync = resolve;
                });
                const manualSyncGate = new Promise((resolve) => {
                    releaseManualSync = resolve;
                });
                let manualWriteCount = 0;
                const manualSample = testApi.sampleCard(card, {
                    async syncCard() {
                        signalManualSync();
                        await manualSyncGate;
                    },
                    buildSampleRecord() {
                        return sampleRecord;
                    },
                    async writeHistoryDocument() {
                        manualWriteCount += 1;
                    },
                });
                await manualSyncStarted;
                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 22,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });
                releaseManualSync();
                await manualSample;
                assert.equal(manualWriteCount, 0);
                assert.equal(card.historyDocument.samples.length, 0);
            },
        },
        {
            name: 'revokes automatic sync permission until authoritative status allows it again',
            async run() {
                const handlers = {};
                const sent = [];
                const ws = {
                    readyState: 1,
                    addEventListener(type, handler) {
                        handlers[type] = handler;
                    },
                    send(message) {
                        sent.push(JSON.parse(message));
                    },
                };
                const ctx = loadPageContext(null, {
                    WebSocket: { OPEN: 1, CONNECTING: 0 },
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.setControlSocketForTest(ws);
                testApi.attachControlSocketHandlers(ws);
                handlers.open();

                const startupPermission = testApi.ensureControlSocket({
                    requireAutomaticMarketDataPermission: true,
                });
                let startupSettled = false;
                startupPermission.then(
                    () => { startupSettled = true; },
                    () => { startupSettled = true; }
                );
                await Promise.resolve();
                assert.equal(startupSettled, false);

                handlers.message({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'ivts-server-a',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 1,
                        recoveryReason: 'connected',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                assert.equal(await startupPermission, ws);

                handlers.message({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'ivts-server-a',
                        connected: false,
                        connecting: true,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 2,
                        recoveryReason: 'unexpected_disconnect',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                const revokedPermission = testApi.ensureControlSocket({
                    requireAutomaticMarketDataPermission: true,
                });
                let revokedSettled = false;
                revokedPermission.then(
                    () => { revokedSettled = true; },
                    () => { revokedSettled = true; }
                );
                await Promise.resolve();
                assert.equal(revokedSettled, false);

                const denied = assert.rejects(
                    revokedPermission,
                    /blocked after the explicit API stream reset/i
                );
                handlers.message({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'ivts-server-a',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 3,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                await denied;
                assert.equal(
                    await testApi.ensureControlSocket({
                        requireAuthoritativeMarketDataStatus: true,
                    }),
                    ws,
                    'manual sync may cross an explicit reset after status is authoritative'
                );

                handlers.message({
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'ivts-server-a',
                        connected: true,
                        connecting: false,
                        marketDataState: 'ready',
                        marketDataGeneration: 3,
                        recoveryReason: 'unexpected_disconnect',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                assert.equal(
                    await testApi.ensureControlSocket({
                        requireAutomaticMarketDataPermission: true,
                    }),
                    ws
                );
                assert.deepEqual(
                    sent.map(payload => payload.action),
                    ['request_ib_connection_status', 'request_discount_curve']
                );
            },
        },
        {
            name: 'detaches old card sockets before replaying a restarted backend namespace',
            async run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Backend restart socket test',
                    symbols: [
                        { symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' },
                    ],
                }, 'test');
                const card = testApi.getCard('SPY');
                const cardHandlers = {};
                let oldSocketCloseCount = 0;
                const oldCardSocket = {
                    readyState: 1,
                    addEventListener(type, handler) {
                        cardHandlers[type] = handler;
                    },
                    close() {
                        oldSocketCloseCount += 1;
                    },
                };
                card.ws = oldCardSocket;
                testApi.attachSocketHandlers(card, oldCardSocket);

                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'ivts-server-a',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 7,
                    recoveryReason: 'connected',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });

                const syncCalls = [];
                const replacementResult = await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'ivts-server-b',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                }, {
                    async syncCard(candidate, options) {
                        syncCalls.push({ symbol: candidate.symbol, options });
                    },
                });

                assert.equal(oldSocketCloseCount, 1);
                assert.equal(card.ws, null);
                assert.equal(testApi.getRecoveryState().serverSessionId, 'ivts-server-b');
                assert.equal(testApi.getRecoveryState().marketDataGeneration, 0);
                assert.deepEqual(Array.from(replacementResult.resyncedSymbols), ['SPY']);
                assert.equal(syncCalls.length, 1);
                assert.equal(syncCalls[0].symbol, 'SPY');
                assert.equal(syncCalls[0].options.automatic, true);

                cardHandlers.message({
                    data: JSON.stringify({
                        action: 'iv_term_structure_quote_snapshot',
                        serverSessionId: 'ivts-server-a',
                        marketDataGeneration: 7,
                        symbol: 'SPY',
                        underlyingPrice: 999,
                        options: {},
                    }),
                });
                assert.equal(card.underlyingPrice, null);
            },
        },
        {
            name: 'rechecks automatic permission after the card socket opens',
            async run() {
                const { MockWebSocket, sockets } = createWebSocketHarness();
                const ctx = loadPageContext(null, {
                    WebSocket: MockWebSocket,
                    setTimeout() { return 1; },
                    clearTimeout() {},
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Permission race',
                    symbols: [{ symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' }],
                }, 'test');
                const card = testApi.getCard('SPY');
                const permission = testApi.ensureControlSocket({
                    requireAutomaticMarketDataPermission: true,
                });
                const control = sockets[0];
                control.emit('open');
                control.emit('message', {
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'ivts-race',
                        connected: true,
                        marketDataState: 'ready',
                        marketDataGeneration: 1,
                        recoveryReason: 'connected',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                await permission;

                const syncing = testApi.syncCard(card, { automatic: true });
                for (let index = 0; index < 5 && sockets.length < 2; index += 1) {
                    await Promise.resolve();
                }
                const cardSocket = sockets[1];
                assert.ok(cardSocket);
                control.emit('message', {
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'ivts-race',
                        connected: true,
                        marketDataState: 'ready',
                        marketDataGeneration: 2,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                cardSocket.emit('open');
                await assert.rejects(
                    syncing,
                    /explicit API stream reset|API market-data streams were reset/i
                );
                assert.equal(
                    cardSocket.sent.some(
                        payload => payload.action === 'subscribe_iv_term_structure'
                    ),
                    false
                );
            },
        },
        {
            name: 'cancels a pre-reset manual sync while its card socket is opening',
            async run() {
                const { MockWebSocket, sockets } = createWebSocketHarness();
                const ctx = loadPageContext(null, {
                    WebSocket: MockWebSocket,
                    setTimeout() { return 1; },
                    clearTimeout() {},
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Manual reset race',
                    symbols: [{ symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' }],
                }, 'test');
                const card = testApi.getCard('SPY');

                const authority = testApi.ensureControlSocket({
                    requireAuthoritativeMarketDataStatus: true,
                });
                const control = sockets[0];
                control.emit('open');
                control.emit('message', {
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'ivts-manual-race',
                        connected: true,
                        marketDataState: 'ready',
                        marketDataGeneration: 1,
                        recoveryReason: 'connected',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: true,
                    }),
                });
                await authority;

                const syncing = testApi.syncCard(card);
                for (let index = 0; index < 5 && sockets.length < 2; index += 1) {
                    await Promise.resolve();
                }
                const cardSocket = sockets[1];
                assert.ok(cardSocket);

                control.emit('message', {
                    data: JSON.stringify({
                        action: 'ib_connection_status',
                        serverSessionId: 'ivts-manual-race',
                        connected: true,
                        marketDataState: 'invalidated',
                        marketDataGeneration: 2,
                        recoveryReason: 'explicit_stream_reset',
                        subscriptionsRequired: true,
                        automaticReplayAllowed: false,
                    }),
                });
                cardSocket.emit('open');

                await assert.rejects(syncing, /API market-data streams were reset/i);
                assert.equal(
                    cardSocket.sent.some(
                        payload => payload.action === 'subscribe_iv_term_structure'
                    ),
                    false
                );
            },
        },
        {
            name: 'preserves restart intent and retries a failed offline startup replay',
            async run() {
                const ctx = loadPageContext(null, {
                    WebSocket: { OPEN: 1, CONNECTING: 0 },
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Offline restart',
                    symbols: [{ symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' }],
                }, 'test');
                const card = testApi.getCard('SPY');
                const oldSocket = {
                    readyState: 1,
                    closeCount: 0,
                    close() { this.closeCount += 1; },
                };
                card.ws = oldSocket;
                card.catalog = { expiryRows: [{ expiry: '20260724' }] };
                card.quotesBySubId = { call: { mark: 1 } };
                card.underlyingPrice = 600;
                card.lastSyncLabel = 'old';
                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'offline-a',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 7,
                    recoveryReason: 'connected',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });

                let attempts = 0;
                const dependencies = {
                    async syncCard() {
                        attempts += 1;
                        if (attempts === 1) throw new Error('IB is not connected');
                    },
                };
                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'offline-b',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup_subscription_wait',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                }, dependencies);
                assert.equal(oldSocket.closeCount, 1);
                assert.equal(card.catalog, null);
                assert.deepEqual(Object.keys(card.quotesBySubId), []);
                assert.equal(card.underlyingPrice, null);
                assert.equal(card.lastSyncLabel, '');
                assert.deepEqual(
                    Array.from(testApi.getRecoveryState().activeSymbols),
                    ['SPY']
                );
                assert.equal(attempts, 1);

                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'offline-b',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup_subscription_wait',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                }, dependencies);
                assert.equal(
                    attempts,
                    1,
                    'duplicate offline status must not hammer a failed startup sync'
                );

                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'offline-b',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup_subscription_wait',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                }, dependencies);
                assert.equal(
                    attempts,
                    1,
                    'duplicate offline status polls must not hammer a failed replay'
                );

                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'offline-b',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 0,
                    recoveryReason: 'startup_subscription_wait',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                }, dependencies);
                assert.equal(attempts, 2);
                assert.equal(testApi.getRecoveryState().replayClaims[0].state, 'complete');
            },
        },
        {
            name: 'settles a connecting control waiter when the endpoint changes',
            async run() {
                const { MockWebSocket, sockets } = createWebSocketHarness();
                const ctx = loadPageContext(null, {
                    WebSocket: MockWebSocket,
                    setTimeout() { return 1; },
                    clearTimeout() {},
                });
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                const waiting = testApi.ensureControlSocket({
                    requireAutomaticMarketDataPermission: true,
                });
                const connecting = sockets[0];
                testApi.closeSocketsForEndpointChange();
                connecting.emit('close');
                await assert.rejects(waiting, /closed before it connected/);
            },
        },
        {
            name: 'does not let an old recovery task overwrite a replacement replay claim',
            async run() {
                const ctx = loadPageContext(null);
                const testApi = ctx.OptionComboIvTermStructurePage._test;
                testApi.applyRuntimeConfig({
                    title: 'Recovery claim ownership test',
                    symbols: [
                        { symbol: 'SPY', historyPath: 'iv_term_structure/data/SPY.json' },
                    ],
                }, 'test');
                const card = testApi.getCard('SPY');
                card.ws = {
                    readyState: 1,
                    close() {},
                };

                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'claim-server-a',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 0,
                    recoveryReason: 'connected',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });
                await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'claim-server-a',
                    connected: false,
                    connecting: true,
                    marketDataState: 'invalidated',
                    marketDataGeneration: 1,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                });

                let rejectOldReplay = null;
                const oldReplay = testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'claim-server-a',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 1,
                    recoveryReason: 'unexpected_disconnect',
                    subscriptionsRequired: true,
                    automaticReplayAllowed: true,
                }, {
                    async syncCard() {
                        await new Promise((_resolve, reject) => {
                            rejectOldReplay = reject;
                        });
                    },
                });
                await Promise.resolve();
                assert.equal(
                    testApi.getRecoveryState().replayClaims[0].state,
                    'in_flight'
                );

                const replacement = await testApi.handleIbConnectionStatus({
                    action: 'ib_connection_status',
                    serverSessionId: 'claim-server-b',
                    connected: true,
                    marketDataState: 'ready',
                    marketDataGeneration: 1,
                    recoveryReason: 'startup',
                    subscriptionsRequired: false,
                    automaticReplayAllowed: false,
                }, {
                    async syncCard() {},
                });
                assert.deepEqual(Array.from(replacement.resyncedSymbols), ['SPY']);
                assert.equal(
                    testApi.getRecoveryState().replayClaims[0].state,
                    'complete'
                );

                rejectOldReplay(new Error('old recovery failed after replacement'));
                await oldReplay;
                assert.equal(
                    testApi.getRecoveryState().replayClaims[0].state,
                    'complete'
                );
                assert.doesNotMatch(card.statusMessage, /old recovery failed/i);
            },
        },
    ],
};
