const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadHandoffApi(withRegistry = false) {
    const ctx = loadBrowserScripts(withRegistry
        ? ['js/product_registry.js', 'js/calendar_handoff.js']
        : ['js/calendar_handoff.js']);
    return ctx.OptionComboCalendarHandoff;
}

function createFakeStorage(initial = {}) {
    const data = { ...initial };
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

function sampleRow() {
    return {
        shortExpiry: '20260630',
        longExpiry: '20260720',
        shortAtmStrike: 600,
        longAtmStrike: 605,
        shortCallMark: 5.1,
        shortPutMark: 4.9,
        longCallMark: 7.4,
        longPutMark: 7.1,
        shortCallIv: 0.18,
        shortPutIv: 0.19,
        longCallIv: 0.17,
        longPutIv: 0.175,
    };
}

module.exports = {
    name: 'calendar_handoff.js',
    tests: [
        {
            name: 'builds a handoff payload from a calendar finder row',
            run() {
                const api = loadHandoffApi();
                const payload = api.buildHandoffPayload({
                    symbol: 'spy',
                    underlyingPrice: 602.5,
                    row: sampleRow(),
                });

                assert.equal(payload.version, 2);
                assert.equal(payload.symbol, 'SPY');
                assert.equal(payload.underlyingPrice, 602.5);
                assert.equal(payload.shortExpiry, '20260630');
                assert.equal(payload.longExpiry, '20260720');
                assert.equal(payload.shortStrike, 600);
                assert.equal(payload.longStrike, 605);
                assert.equal(payload.shortCallMark, 5.1);
                assert.equal(payload.longPutIv, 0.175);
                assert.ok(Number.isFinite(payload.createdAt));
            },
        },
        {
            name: 'rejects handoff payloads without strikes or expiries',
            run() {
                const api = loadHandoffApi();
                const missingStrike = { ...sampleRow(), shortAtmStrike: null };
                const badExpiry = { ...sampleRow(), longExpiry: 'not-a-date' };

                assert.equal(api.buildHandoffPayload({ symbol: 'SPY', row: missingStrike }), null);
                assert.equal(api.buildHandoffPayload({ symbol: 'SPY', row: badExpiry }), null);
                assert.equal(api.buildHandoffPayload({ symbol: '', row: sampleRow() }), null);
            },
        },
        {
            name: 'requires and preserves the exact FOP futures month',
            run() {
                const api = loadHandoffApi(true);
                assert.equal(api.buildHandoffPayload({
                    symbol: 'ES',
                    underlyingPrice: 6010.25,
                    row: sampleRow(),
                }), null);

                const payload = api.buildHandoffPayload({
                    symbol: 'ES',
                    underlyingPrice: 6010.25,
                    underlyingContractMonth: '202609',
                    underlyingQuote: {
                        contractMonth: '202609',
                        conId: 12345,
                        localSymbol: 'ESU6',
                        exchange: 'CME',
                        quoteAsOf: '2026-07-20T15:00:00Z',
                        mark: 6010.25,
                    },
                    row: sampleRow(),
                });
                assert.equal(payload.version, 2);
                assert.equal(payload.underlyingContractMonth, '202609');
                assert.equal(payload.underlyingFuture.conId, 12345);
                assert.equal(payload.underlyingFuture.localSymbol, 'ESU6');

                const legs = api.buildCalendarLegs(payload, () => 'leg', 'future_202609');
                assert.deepEqual(
                    Array.from(legs, leg => leg.underlyingFutureId),
                    ['future_202609', 'future_202609', 'future_202609', 'future_202609']
                );
            },
        },
        {
            name: 'round-trips a payload through storage and consumes it once',
            run() {
                const api = loadHandoffApi();
                const storage = createFakeStorage();
                const payload = api.buildHandoffPayload({
                    symbol: 'SPY',
                    underlyingPrice: 602.5,
                    row: sampleRow(),
                });

                assert.equal(api.saveHandoffPayload(payload, storage), true);
                const taken = api.takeHandoffPayload(storage, payload.createdAt + 1000);
                assert.equal(taken.symbol, 'SPY');
                assert.equal(taken.shortStrike, 600);
                assert.equal(storage.getItem(api.STORAGE_KEY), null);
                assert.equal(api.takeHandoffPayload(storage, payload.createdAt + 1000), null);
            },
        },
        {
            name: 'drops stale or corrupted handoff payloads',
            run() {
                const api = loadHandoffApi();
                const payload = api.buildHandoffPayload({ symbol: 'SPY', row: sampleRow() });

                const staleStorage = createFakeStorage({
                    [api.STORAGE_KEY]: JSON.stringify({ ...payload, createdAt: payload.createdAt - api.MAX_AGE_MS - 1000 }),
                });
                assert.equal(api.takeHandoffPayload(staleStorage, payload.createdAt), null);
                assert.equal(staleStorage.getItem(api.STORAGE_KEY), null);

                const corruptStorage = createFakeStorage({ [api.STORAGE_KEY]: '{not json' });
                assert.equal(api.takeHandoffPayload(corruptStorage), null);
            },
        },
        {
            name: 'builds four calendar legs with simulator leg shape',
            run() {
                const api = loadHandoffApi();
                const payload = api.buildHandoffPayload({ symbol: 'SPY', row: sampleRow() });
                let counter = 0;
                const legs = api.buildCalendarLegs(payload, () => `leg_${counter += 1}`);

                assert.equal(legs.length, 4);
                assert.deepEqual(Array.from(legs, (leg) => leg.pos), [-1, -1, 1, 1]);
                assert.deepEqual(Array.from(legs, (leg) => leg.type), ['call', 'put', 'call', 'put']);
                assert.equal(legs[0].expDate, '2026-06-30');
                assert.equal(legs[2].expDate, '2026-07-20');
                assert.equal(legs[0].strike, 600);
                assert.equal(legs[3].strike, 605);
                assert.equal(legs[0].cost, 5.1);
                assert.equal(legs[0].currentPrice, 5.1);
                assert.equal(legs[1].iv, 0.19);
                assert.equal(legs[0].ivSource, 'manual');
                assert.equal(legs[0].closePrice, null);
                assert.equal(legs[0].underlyingFutureId, '');
                assert.equal(new Set(legs.map((leg) => leg.id)).size, 4);
            },
        },
        {
            name: 'falls back to defaults when marks or ivs are missing',
            run() {
                const api = loadHandoffApi();
                const row = { ...sampleRow(), shortCallMark: null, shortCallIv: null };
                const payload = api.buildHandoffPayload({ symbol: 'SPY', row });
                const legs = api.buildCalendarLegs(payload, () => 'x');

                assert.equal(legs[0].cost, 0);
                assert.equal(legs[0].currentPrice, 0);
                assert.equal(legs[0].iv, 0.2);
            },
        },
        {
            name: 'names the group after symbol and expiry pair',
            run() {
                const api = loadHandoffApi();
                const payload = api.buildHandoffPayload({ symbol: 'SPY', row: sampleRow() });

                assert.equal(api.buildGroupName(payload), 'SPY Calendar 20260630/20260720');
            },
        },
    ],
};
