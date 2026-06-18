const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadPageContext(activeElement) {
    const listeners = {};
    return loadBrowserScripts([
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
                assert.match(html, /12%\/13%/);
                assert.equal((html.match(/<th>/g) || []).length, 6);
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
                        sortBy: 'best_value',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260620', dte: 10, atmStraddleMark: 10, hasCompleteStraddle: true },
                        { expiry: '20260630', dte: 20, atmStraddleMark: 16, hasCompleteStraddle: true },
                        { expiry: '20260710', dte: 30, atmStraddleMark: 18, hasCompleteStraddle: true },
                        { expiry: '20260720', dte: 40, atmStraddleMark: 21, hasCompleteStraddle: true },
                        { expiry: '20260810', dte: 61, atmStraddleMark: 34, hasCompleteStraddle: true },
                    ],
                });

                assert.match(html, /Calendar Finder/);
                assert.match(html, /Best 0\.92X/);
                assert.match(html, /Sell Expiry/);
                assert.match(html, /Buy Expiry/);
                assert.match(html, /20260630/);
                assert.match(html, /20260710/);
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
                        sortBy: 'best_value',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260617', dte: 5, atmStraddleMark: 10, atmStrike: 600, hasCompleteStraddle: true },
                        { expiry: '20260622', dte: 10, atmStraddleMark: 12, atmStrike: 601, hasCompleteStraddle: true },
                        { expiry: '20260627', dte: 15, atmStraddleMark: 13, atmStrike: 602, hasCompleteStraddle: true },
                        { expiry: '20260702', dte: 20, atmStraddleMark: 17, atmStrike: 603, hasCompleteStraddle: true },
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
                        sortBy: 'best_value',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260617', dte: 5, atmStraddleMark: 10, atmStrike: 600, hasCompleteStraddle: true },
                        { expiry: '20260620', dte: 8, atmStraddleMark: 11, atmStrike: 601, hasCompleteStraddle: true },
                        { expiry: '20260621', dte: 9, atmStraddleMark: 12, atmStrike: 602, hasCompleteStraddle: true },
                        { expiry: '20260622', dte: 10, atmStraddleMark: 13, atmStrike: 603, hasCompleteStraddle: true },
                        { expiry: '20260623', dte: 11, atmStraddleMark: 14, atmStrike: 604, hasCompleteStraddle: true },
                        { expiry: '20260624', dte: 12, atmStraddleMark: 15, atmStrike: 605, hasCompleteStraddle: true },
                        { expiry: '20260702', dte: 20, atmStraddleMark: 20, atmStrike: 606, hasCompleteStraddle: true },
                        { expiry: '20260722', dte: 40, atmStraddleMark: 29, atmStrike: 607, hasCompleteStraddle: true },
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
                    sortBy: 'closest_ratio',
                    showAll: true,
                });

                assert.equal(config.targetRatio, 2);
                assert.equal(config.targetPreset, 'custom');
                assert.equal(config.tolerancePct, 40);
                assert.equal(config.shortMinDte, 5);
                assert.equal(config.shortMaxDte, 60);
                assert.equal(config.sortBy, 'closest_ratio');
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
            name: 'renders zero short DTE and clamps calendar finder numeric bounds',
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
                        sortBy: 'best_value',
                        showAll: false,
                    },
                }, { detailRows: [] });

                assert.equal(config.targetRatio, 8);
                assert.equal(config.shortMinDte, 100);
                assert.equal(config.shortMaxDte, 100);
                assert.match(html, /data-action="calendar-short-min"[^>]*value="0"/);
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
                    /3-60 DTE/
                );
                assert.match(
                    describe(config, { totalExpiries: 6, usableExpiries: 4, shortCandidates: 2, pairCount: 0 }),
                    /\+\/-25% of the 2X DTE ratio/
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
                        sortBy: 'best_value',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260620', dte: 10, atmStraddleMark: 10, hasCompleteStraddle: true },
                    ],
                });

                assert.match(html, /Waiting for complete straddle quotes \(1\/1 expiries usable\)\./);
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
                        sortBy: 'best_value',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260630', dte: 20, atmStraddleMark: 16, atmStrike: 600, hasCompleteStraddle: true },
                        { expiry: '20260720', dte: 40, atmStraddleMark: 21, atmStrike: 602, hasCompleteStraddle: true },
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
                        sortBy: 'best_value',
                        showAll: false,
                    },
                }, {
                    detailRows: [
                        { expiry: '20260630', dte: 20, atmStraddleMark: 16, hasCompleteStraddle: true },
                        { expiry: '20260720', dte: 40, atmStraddleMark: 21, hasCompleteStraddle: true },
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
                assert.equal(restored.sortBy, 'closest_ratio');
                assert.equal(restored.showAll, true);
                assert.equal(testApi.loadSavedCalendarFinderConfig('QQQ'), null);

                store.optionComboIvtsCalendarFinder = '{broken json';
                assert.equal(testApi.loadSavedCalendarFinderConfig('SPY'), null);
            },
        },
    ],
};
