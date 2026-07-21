const assert = require('node:assert/strict');

const {
    loadAppContext,
    loadBrowserScripts,
    loadPricingContext,
} = require('./helpers/load-browser-scripts');

const TEST_NOW = Date.parse('2026-07-20T14:45:00Z');
const ANCHOR_DATE = '2026-07-20';
const SIMULATED_DATE = '2026-07-24';
const FAR_EXPIRY = '2026-07-27';
const SNAPSHOT_ID = 'pipeline-whole-1';

class FixedDate extends Date {
    constructor(...args) {
        super(...(args.length ? args : [TEST_NOW]));
    }

    static now() {
        return TEST_NOW;
    }
}

function createSharedStorage() {
    const data = Object.create(null);
    return {
        data,
        getItem(key) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
        },
        setItem(key, value) {
            data[key] = String(value);
        },
        removeItem(key) {
            delete data[key];
        },
    };
}

function loadIvtsPublisher(sharedStorage) {
    const focusedControl = {
        matches(selector) {
            return selector === 'select[data-action="option-stream-limit"][data-symbol]';
        },
    };
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
        Date: FixedDate,
        localStorage: sharedStorage,
        setTimeout() {
            // The quote handler schedules a DOM render. Keeping it pending
            // proves that publication is independent of that render.
            return 1;
        },
        clearTimeout() {},
        document: {
            readyState: 'loading',
            activeElement: focusedControl,
            getElementById() {
                return null;
            },
            addEventListener() {},
        },
    });
}

function coherentLambdaResult(quoteAsOf) {
    return {
        anchorDate: ANCHOR_DATE,
        calendarKey: 'NYSE',
        varianceSource: 'straddle',
        snapshotId: SNAPSHOT_ID,
        quoteAsOf,
        methodology: {
            pricingModel: 'bsm-spot',
            underlyingQuoteIsForward: false,
            requireExactExpiryTimestamps: false,
        },
        coverageStart: '2026-07-25',
        coverageEnd: '2026-07-26',
        byDate: {
            '2026-07-25': 0.12,
            '2026-07-26': 0.12,
        },
        medianLambda: 0.12,
        okIntervalCount: 1,
        intervals: [{
            startDate: SIMULATED_DATE,
            endExpiry: '20260727',
            status: 'ok',
            rawLambda: 0.12,
            lambda: 0.12,
            lambdaClamped: 0.12,
            nonTradingDates: ['2026-07-25', '2026-07-26'],
            snapshotId: SNAPSHOT_ID,
            quoteAsOf,
        }],
        quality: {
            status: 'ok',
            coherent: true,
            quoteComplete: true,
            snapshotId: SNAPSHOT_ID,
            underlyingSnapshotId: SNAPSHOT_ID,
        },
    };
}

function publishWithoutRedraw(publisher) {
    const page = publisher.OptionComboIvTermStructurePage._test;
    const card = page.createCardState({
        symbol: 'SPY',
        historyPath: 'iv_term_structure/data/SPY.json',
    }, { isExpanded: true });
    card.catalog = {
        anchorDate: ANCHOR_DATE,
        expiryRows: [{
            expiry: '20260727',
            dte: 7,
            atmStrike: 750,
            atmCallSubId: '__pipeline_call',
            atmPutSubId: '__pipeline_put',
            subscriptionSelected: true,
        }],
    };

    const quoteAsOf = new FixedDate().toISOString();
    publisher.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas = () => (
        coherentLambdaResult(quoteAsOf)
    );

    const handlers = {};
    const ws = {
        addEventListener(type, handler) {
            handlers[type] = handler;
        },
    };
    card.ws = ws;
    page.attachSocketHandlers(card, ws);
    handlers.message({
        data: JSON.stringify({
            action: 'iv_term_structure_quote_snapshot',
            symbol: 'SPY',
            anchorDate: ANCHOR_DATE,
            payloadAsOf: quoteAsOf,
            batchId: SNAPSHOT_ID,
            snapshotId: SNAPSHOT_ID,
            coherent: true,
            quoteComplete: true,
            maxQuoteAgeSeconds: 120,
            underlyingPrice: 750,
            underlyingQuote: {
                mark: 750,
                quoteAsOf,
                snapshotId: SNAPSHOT_ID,
            },
            options: {
                __pipeline_call: {
                    bid: 4.9,
                    ask: 5.1,
                    mark: 5,
                    markSource: 'bid_ask_mid',
                    quoteAsOf,
                    snapshotId: SNAPSHOT_ID,
                },
                __pipeline_put: {
                    bid: 4.8,
                    ask: 5,
                    mark: 4.9,
                    markSource: 'bid_ask_mid',
                    quoteAsOf,
                    snapshotId: SNAPSHOT_ID,
                },
            },
        }),
    });
    const calculated = page.calculateImpliedLambda(card);
    assert.equal(calculated.ok, true);
    const synchronized = page.syncCalculatedImpliedLambda(card);
    assert.equal(synchronized.ok, true);
    return card;
}

module.exports = {
    name: 'IVTS -> index implied-lambda pipeline',
    tests: [{
        name: 'manually calculates and syncs a coherent snapshot before index refreshes shared V2 coverage',
        run() {
            const sharedStorage = createSharedStorage();
            const storageListeners = {};
            const statusHistory = [];
            const consumer = loadBrowserScripts(['js/implied_lambda_handoff.js'], {
                Date: FixedDate,
                localStorage: sharedStorage,
            });
            const pricing = loadPricingContext().OptionComboPricingContext;
            const app = loadAppContext({
                overrides: {
                    Date: FixedDate,
                    localStorage: sharedStorage,
                    addEventListener(type, handler) {
                        storageListeners[type] = handler;
                    },
                    OptionComboImpliedLambdaHandoff: consumer.OptionComboImpliedLambdaHandoff,
                    OptionComboPricingContext: pricing,
                    OptionComboPricingCore: {
                        configureSimTimeBasis() {},
                    },
                    OptionComboSessionUI: {
                        syncControlPanel() {},
                        syncWorkspaceChrome(state) {
                            statusHistory.push({
                                coverage: state.simImpliedLambdaCoverage
                                    ? JSON.parse(JSON.stringify(state.simImpliedLambdaCoverage))
                                    : null,
                                snapshotId: String(
                                    state.simImpliedLambdaEntry
                                    && state.simImpliedLambdaEntry.snapshotId
                                    || ''
                                ),
                            });
                        },
                    },
                },
            });
            const state = app.context.__optionComboApp.getState();
            Object.assign(state, {
                underlyingSymbol: 'SPY',
                underlyingContractMonth: '',
                liveQuoteDate: ANCHOR_DATE,
                liveQuoteAsOf: new FixedDate().toISOString(),
                simulatedDate: SIMULATED_DATE,
                simTimeBasis: 'weighted',
                simUseImpliedLambda: true,
                requireExactContractTiming: false,
                groups: [{
                    id: 'calendar',
                    legs: [
                        { id: 'near', type: 'call', pos: -1, expDate: SIMULATED_DATE },
                        { id: 'far', type: 'call', pos: 1, expDate: FAR_EXPIRY },
                    ],
                }],
            });

            app.context.__optionComboApp.updateLiveQuoteDerivedValues();
            assert.equal(state.simImpliedLambdaEntry, null);
            assert.equal(state.simImpliedLambdaCoverage.status, 'missing_entry');
            assert.deepEqual(
                Array.from(state.simImpliedLambdaCoverage.requiredDates),
                ['2026-07-25', '2026-07-26']
            );

            const publisher = loadIvtsPublisher(sharedStorage);
            const card = publishWithoutRedraw(publisher);
            assert.equal(card.impliedLambdaPublishedSnapshotId, SNAPSHOT_ID);

            const rawStore = JSON.parse(
                sharedStorage.getItem(consumer.OptionComboImpliedLambdaHandoff.STORAGE_KEY)
            );
            assert.equal(rawStore.version, 2);
            assert.equal(rawStore.entries.SPY.schemaVersion, 2);
            assert.equal(rawStore.entries.SPY.snapshotId, SNAPSHOT_ID);

            const consumed = consumer.OptionComboImpliedLambdaHandoff.peekSymbolEntry(
                'SPY', sharedStorage, TEST_NOW, '', ANCHOR_DATE
            );
            assert.ok(consumed);
            assert.equal(consumed.schemaVersion, 2);
            assert.equal(consumed.snapshotId, rawStore.entries.SPY.snapshotId);
            assert.deepEqual(
                Object.keys(consumed.byDate),
                ['2026-07-25', '2026-07-26']
            );

            assert.equal(typeof storageListeners.storage, 'function');
            const refreshCountBeforePublishEvent = statusHistory.length;
            const timeBasisRefreshCountBeforePublishEvent =
                app.callLog.refreshSimTimeBasisUi.length;
            storageListeners.storage({
                key: consumer.OptionComboImpliedLambdaHandoff.STORAGE_KEY,
                newValue: sharedStorage.getItem(
                    consumer.OptionComboImpliedLambdaHandoff.STORAGE_KEY
                ),
            });

            assert.equal(statusHistory.length, refreshCountBeforePublishEvent + 1);
            assert.equal(
                app.callLog.refreshSimTimeBasisUi.length,
                timeBasisRefreshCountBeforePublishEvent + 1
            );
            assert.equal(state.simImpliedLambdaEntry.snapshotId, SNAPSHOT_ID);
            assert.equal(state.simImpliedLambdaCoverage.status, 'complete');
            assert.equal(state.simImpliedLambdaCoverage.ready, true);
            assert.deepEqual(Array.from(state.simImpliedLambdaCoverage.missingDates), []);
            assert.equal(statusHistory.at(-1).coverage.status, 'complete');
            assert.equal(statusHistory.at(-1).snapshotId, SNAPSHOT_ID);
        },
    }],
};
