const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadPageContext(activeElement) {
    const listeners = {};
    return loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/product_registry.js',
        'js/iv_term_structure_core.js',
        'js/iv_term_structure.js',
    ], {
        document: {
            readyState: 'loading',
            activeElement,
            addEventListener(type, handler) {
                listeners[type] = handler;
            },
        },
    });
}

function createFakeCardForViewState() {
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
    };
}

module.exports = {
    name: 'iv_term_structure.js',
    tests: [
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
                assert.match(html, /10 streams \(5 expiries\)/);
                assert.match(html, /data-action="futures-contract-month"/);
                assert.match(html, /value="202608"/);
                assert.equal(payload.underlying.secType, 'FUT');
                assert.equal(payload.underlying.symbol, 'CL');
                assert.equal(payload.underlying.contractMonth, '202608');
                assert.equal(payload.underlying.multiplier, '1000');
                assert.equal(payload.optionTemplate.secType, 'FOP');
                assert.equal(payload.optionTemplate.underlyingContractMonth, '202608');
                assert.equal(payload.optionTemplate.underlyingMultiplier, '1000');
                assert.equal(payload.maxOptionStreams, 10);

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
                assert.match(html, />TD IV<\/th>/);
                assert.match(html, /12%\/13%/);
                assert.equal((html.match(/<th[\s>]/g) || []).length, 7);
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
            name: 'renders the strategy signal panel with zone, slope, watermark, and suggestion',
            run() {
                const ctx = loadPageContext(null);
                const { buildStrategySignalPanel } = ctx.OptionComboIvTermStructurePage._test;
                const row = (expiry, dte, tradDte, atmIv) => ({
                    expiry, dte, tradDte, atmIv, hasCompletePair: true, subscriptionSelected: true,
                });

                const html = buildStrategySignalPanel(
                    { symbol: 'SPY' },
                    { detailRows: [row('20260717', 7, 5, 0.30), row('20260724', 14, 10, 0.22)] },
                    { samples: [] }
                );
                assert.match(html, /SELL CALENDAR/);
                assert.match(html, /is-sell_calendar/);
                assert.match(html, /TD slope/);
                assert.match(html, /collecting 0\/8/);
                assert.match(html, /Calendar: sell front ATM straddle/);
                assert.match(html, /suggestion only/);

                // With no accumulated samples the watermark cannot prove the
                // era, so the deep-contango zone shows but withholds the
                // reverse-fly structure (fail closed).
                const contango = buildStrategySignalPanel(
                    { symbol: 'SPY' },
                    { detailRows: [row('20260717', 7, 5, 0.15), row('20260724', 14, 10, 0.21)] },
                    { samples: [] }
                );
                assert.match(contango, /LONG DISPLACEMENT/);
                assert.doesNotMatch(contango, /Reverse iron fly: buy/);
                assert.match(contango, /watermark must prove it first/);

                const empty = buildStrategySignalPanel({ symbol: 'SPY' }, { detailRows: [] }, { samples: [] });
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
                assert.match(es, /CALENDAR UNAVAILABLE/);
                assert.match(es, /is-calendar_unavailable/);
                assert.match(es, /official trading calendar is unavailable — no strategy suggestion/);
                assert.doesNotMatch(es, /SELL CALENDAR/);
                assert.doesNotMatch(es, /Calendar: sell front ATM straddle/);
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
                } = createFakeCardForViewState();

                const snapshot = ctx.OptionComboIvTermStructurePage._test.captureCardViewState(container);
                calendarDetails.open = false;
                bucketDetails.open = false;
                calendarShell.scrollLeft = 0;
                calendarShell.scrollTop = 0;
                bucketShell.scrollLeft = 0;
                detailsShell.scrollLeft = 0;

                ctx.OptionComboIvTermStructurePage._test.restoreCardViewState(container, snapshot);

                assert.equal(calendarDetails.open, true);
                assert.equal(bucketDetails.open, true);
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
    ],
};
