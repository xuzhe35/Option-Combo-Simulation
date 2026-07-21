const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const TEST_NOW = Date.parse('2027-01-15T21:00:00Z');

function loadHandoffApi() {
    return loadBrowserScripts(['js/implied_lambda_handoff.js']).OptionComboImpliedLambdaHandoff;
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

function sampleEntry(overrides = {}) {
    return {
        symbol: 'es',
        underlyingContractMonth: '202703',
        calendarKey: 'CME:ES',
        anchorDate: '2027-01-15',
        quoteAsOf: '2027-01-15T20:59:00Z',
        snapshotId: 'snapshot-17',
        varianceSource: 'straddle',
        methodology: {
            pricingModel: 'black76',
            underlyingQuoteIsForward: true,
            interestRate: 0.04,
            discounting: {
                convention: 'continuous_annualized',
                fallbackRate: 0.04,
                curveConfigured: true,
                curveId: 'usd-treasury-discount',
                curveAsOf: '2027-01-15',
                curveQuoteAsOf: '2027-01-15T20:30:00Z',
                source: 'treasury:daily_treasury_yield_curve',
                isProxy: true,
                curveRowCount: 8,
                fallbackRowCount: 1,
                fallbackUsed: true,
            },
            baselineWindowDays: 7,
            minBaselines: 2,
            maxIntervalCalendarDays: 7,
            minDte: 0,
            maxQuoteSkewMs: 120000,
            maxForwardDeviationPct: 0.005,
            maxBidAskSpreadPct: 0.35,
        },
        quality: {
            status: 'ok',
            coherent: true,
            quoteComplete: true,
            snapshotId: 'snapshot-17',
            underlyingSnapshotId: 'snapshot-17',
        },
        intervals: [
            {
                startExpiry: '20270115',
                endExpiry: '20270118',
                status: 'ok',
                rawLambda: 0.13,
                lambda: 0.13,
                lambdaClamped: 0.13,
                nonTradingDates: ['2027-01-16', '2027-01-17'],
                tradingDays: 1,
                nonTradingDays: 2,
                baselineVariance: 0.0002,
                baselineCount: 3,
                snapshotId: 'snapshot-17',
                quoteAsOf: '2027-01-15T20:59:00Z',
            },
            {
                startExpiry: '2027-01-22',
                endExpiry: '2027-01-25',
                status: 'ok',
                rawLambda: 0.16,
                lambda: 0.16,
                lambdaClamped: 0.16,
                nonTradingDates: ['2027-01-23', '2027-01-24'],
                tradingDays: 1,
                nonTradingDays: 2,
                baselineVariance: 0.00021,
                baselineCount: 4,
                snapshotId: 'snapshot-17',
                quoteAsOf: '2027-01-15T20:59:00Z',
            },
        ],
        ...overrides,
    };
}

module.exports = {
    name: 'implied_lambda_handoff.js',
    tests: [
        {
            name: 'publishes a strict V2 straddle entry and reads it non-destructively',
            run() {
                const api = loadHandoffApi();
                const storage = createFakeStorage();
                assert.equal(api.SCHEMA_VERSION, 2);
                assert.match(api.STORAGE_KEY, /V2$/);
                assert.equal(api.saveSymbolEntry(sampleEntry(), storage, TEST_NOW), true);

                const entry = api.peekSymbolEntry('ES', storage, TEST_NOW + 1000, '202703');
                assert.ok(entry);
                assert.equal(entry.symbol, 'ES');
                assert.equal(
                    entry.curveId,
                    'ES#202703@2027-01-15T20:59:00.000Z'
                );
                assert.equal(entry.varianceSource, 'straddle');
                assert.equal(entry.methodology.pricingModel, 'black76');
                assert.equal(entry.methodology.interestRate, 0.04);
                assert.equal(entry.methodology.underlyingQuoteIsForward, true);
                assert.equal(entry.methodology.discounting.curveId, 'usd-treasury-discount');
                assert.equal(entry.methodology.discounting.curveAsOf, '2027-01-15');
                assert.equal(entry.methodology.discounting.isProxy, true);
                assert.equal(entry.methodology.discounting.fallbackRowCount, 1);
                assert.equal(entry.methodology.minBaselines, 2);
                assert.equal(entry.quality.status, 'ok');
                assert.equal(entry.quality.coherent, true);
                assert.equal(entry.byDate['2027-01-23'], 0.16);
                assert.equal(entry.coverageStart, '2027-01-16');
                assert.equal(entry.coverageEnd, '2027-01-24');
                assert.equal(entry.medianLambda, 0.145);
                assert.equal(entry.intervals[0].startExpiry, '2027-01-15');
                assert.equal(entry.intervals[0].endExpiry, '2027-01-18');
                assert.deepEqual(
                    Array.from(entry.intervals[0].weekendDates),
                    ['2027-01-16', '2027-01-17']
                );
                assert.deepEqual(Array.from(entry.intervals[0].holidayDates), []);
                assert.equal(
                    entry.intervals[0].nonTradingDateKinds['2027-01-16'],
                    'weekend'
                );
                assert.equal(entry.calendarEvidence.verified, true);
                assert.equal(entry.calendarEvidence.calendarKey, 'CME:ES');
                assert.equal(entry.calendarEvidence.sourceKind, 'cme_reference_data_api');
                assert.ok(api.peekSymbolEntry('es', storage, TEST_NOW + 2000, '202703'));
                assert.deepEqual([...api.listSymbols(storage, TEST_NOW + 1000)], ['ES#202703']);
                assert.equal(api.removeSymbolEntry('ES', storage, '202703', 'older-tab'), false);
                assert.ok(api.peekSymbolEntry('ES', storage, TEST_NOW + 2000, '202703'));
                assert.equal(api.removeSymbolEntry('ES', storage, '202703', 'snapshot-17'), true);
                assert.equal(api.peekSymbolEntry('ES', storage, TEST_NOW + 2000, '202703'), null);
            },
        },
        {
            name: 'preserves and verifies exact fractional interval-clock evidence',
            run() {
                const api = loadHandoffApi();
                const base = sampleEntry();
                const exactSurface = {
                    ...base,
                    methodology: {
                        ...base.methodology,
                        requireExactExpiryTimestamps: true,
                        intervalClock: 'contract-expiry-fractional-seconds',
                        intervalTimeZone: 'America/Chicago',
                        intervalTradeDateRolloverHour: 17,
                    },
                    intervals: base.intervals.map((interval, index) => ({
                        ...interval,
                        startAsOf: index === 0
                            ? '2027-01-15T21:00:00Z'
                            : '2027-01-22T21:00:00Z',
                        endAsOf: index === 0
                            ? '2027-01-18T21:00:00Z'
                            : '2027-01-25T21:00:00Z',
                        exactTimestampClock: true,
                        clockStatus: 'ok',
                        calendarDays: 3,
                        varianceCalendarDays: 3,
                        varianceTradingDays: 1,
                        varianceNonTradingDays: 2,
                    })),
                };
                const entry = api.buildSymbolEntry(exactSurface, TEST_NOW);
                assert.ok(entry);
                assert.equal(entry.methodology.requireExactExpiryTimestamps, true);
                assert.equal(
                    entry.methodology.intervalClock,
                    'contract-expiry-fractional-seconds'
                );
                assert.equal(entry.intervals[0].exactTimestampClock, true);
                assert.equal(entry.intervals[0].varianceTradingDays, 1);
                assert.equal(entry.intervals[0].varianceNonTradingDays, 2);

                const corrupt = {
                    ...exactSurface,
                    intervals: exactSurface.intervals.map((interval, index) => (
                        index === 0
                            ? { ...interval, varianceTradingDays: 0.9 }
                            : interval
                    )),
                };
                assert.equal(api.buildSymbolEntry(corrupt, TEST_NOW), null);
            },
        },
        {
            name: 'preserves audited best-effort quote provenance and skipped-expiry counts',
            run() {
                const api = loadHandoffApi();
                const base = sampleEntry();
                const entry = api.buildSymbolEntry({
                    ...base,
                    methodology: {
                        ...base.methodology,
                        estimationMode: 'best_effort',
                        sourceQuoteEvidence: 'manual_atomic_current_bbo',
                        requireExactExpiryTimestamps: false,
                    },
                    quality: {
                        ...base.quality,
                        estimationMode: 'best_effort',
                        strictSnapshot: false,
                        sourceQuoteEvidence: 'manual_atomic_current_bbo',
                        sourceExpectedExpiryCount: 10,
                        usableExpiryCount: 7,
                        skippedExpiryCount: 3,
                    },
                }, TEST_NOW);

                assert.ok(entry);
                assert.equal(entry.methodology.estimationMode, 'best_effort');
                assert.equal(entry.methodology.sourceQuoteEvidence, 'manual_atomic_current_bbo');
                assert.equal(entry.quality.estimationMode, 'best_effort');
                assert.equal(entry.quality.strictSnapshot, false);
                assert.equal(entry.quality.usableExpiryCount, 7);
                assert.equal(entry.quality.skippedExpiryCount, 3);
            },
        },
        {
            name: 'accepts only an explicitly audited manual vendor-ATM-IV fallback',
            run() {
                const api = loadHandoffApi();
                const source = sampleEntry();
                const vendorFallback = sampleEntry({
                    varianceSource: 'vendor_iv',
                    methodology: {
                        ...source.methodology,
                        estimationMode: 'best_effort',
                        sourceQuoteEvidence: 'vendor_atm_iv_fallback',
                    },
                    quality: {
                        ...source.quality,
                        estimationMode: 'best_effort',
                        strictSnapshot: false,
                        sourceQuoteEvidence: 'vendor_atm_iv_fallback',
                        usableExpiryCount: 12,
                        skippedExpiryCount: 2,
                    },
                });
                const entry = api.buildSymbolEntry(vendorFallback, TEST_NOW);
                assert.ok(entry);
                assert.equal(entry.varianceSource, 'vendor_iv');
                assert.equal(entry.quality.estimationMode, 'best_effort');
                assert.equal(
                    entry.quality.sourceQuoteEvidence,
                    'vendor_atm_iv_fallback'
                );
                assert.equal(entry.quality.usableExpiryCount, 12);

                assert.equal(api.buildSymbolEntry(sampleEntry({
                    varianceSource: 'vendor_iv',
                }), TEST_NOW), null);
            },
        },
        {
            name: 'verifies holidays against the official calendar and exports their kind',
            run() {
                const api = loadHandoffApi();
                const now = Date.parse('2026-09-03T20:01:00Z');
                const holidaySurface = {
                    symbol: 'SPY',
                    calendarKey: 'NYSE',
                    anchorDate: '2026-09-03',
                    quoteAsOf: '2026-09-03T20:00:00Z',
                    snapshotId: 'labor-day-surface',
                    varianceSource: 'straddle',
                    quality: {
                        status: 'ok', coherent: true, quoteComplete: true,
                        snapshotId: 'labor-day-surface',
                        underlyingSnapshotId: 'labor-day-surface',
                    },
                    intervals: [{
                        startExpiry: '2026-09-04',
                        endExpiry: '2026-09-08',
                        status: 'ok',
                        rawLambda: 0.15,
                        lambda: 0.15,
                        nonTradingDates: [
                            '2026-09-05', '2026-09-06', '2026-09-07',
                        ],
                        snapshotId: 'labor-day-surface',
                        quoteAsOf: '2026-09-03T20:00:00Z',
                    }],
                };
                const entry = api.buildSymbolEntry(holidaySurface, now);
                assert.ok(entry);
                assert.deepEqual(
                    Array.from(entry.intervals[0].weekendDates),
                    ['2026-09-05', '2026-09-06']
                );
                assert.deepEqual(
                    Array.from(entry.intervals[0].holidayDates),
                    ['2026-09-07']
                );
                assert.equal(
                    entry.intervals[0].nonTradingDateKinds['2026-09-07'],
                    'exchange_holiday'
                );
                assert.equal(entry.byDate['2026-09-07'], 0.15);

                const doc = api.buildExportDocument(holidaySurface, now);
                assert.ok(doc);
                assert.equal(doc.curveId, 'SPY@2026-09-03T20:00:00.000Z');
                assert.equal(doc.calendarEvidence.calendarKey, 'NYSE');
                assert.deepEqual(
                    Array.from(doc.intervals[0].holidayDates),
                    ['2026-09-07']
                );

                const missingHoliday = {
                    ...holidaySurface,
                    intervals: [{
                        ...holidaySurface.intervals[0],
                        nonTradingDates: ['2026-09-05', '2026-09-06'],
                    }],
                };
                const rejected = api.buildSymbolEntry(missingHoliday, now);
                assert.equal(rejected, null);

                const unavailable = api.buildSymbolEntry({
                    ...holidaySurface,
                    calendarKey: 'UNKNOWN:PRODUCT',
                }, now);
                assert.equal(unavailable, null);
            },
        },
        {
            name: 'preserves legacy rejections and publishes signed OK intervals without clipping',
            run() {
                const api = loadHandoffApi();
                const input = sampleEntry({
                    byDate: { '2099-01-01': 0.99 },
                    medianLambda: 0.99,
                    intervals: sampleEntry().intervals.map((interval, index) => (
                        index === 1 ? {
                            ...interval,
                            rawLambda: -0.16,
                            lambda: -0.16,
                            lambdaClamped: 0,
                            conventionalRange: 'inverted',
                            isInverted: true,
                        } : interval
                    )),
                });
                const entry = api.buildSymbolEntry(input, TEST_NOW);
                assert.ok(entry);
                assert.deepEqual(Object.keys(entry.byDate), [
                    '2027-01-16', '2027-01-17', '2027-01-23', '2027-01-24',
                ]);
                assert.equal(entry.byDate['2027-01-23'], -0.16);
                assert.equal(entry.medianLambda, -0.015);
                assert.equal(entry.quality.validIntervalCount, 2);
                assert.equal(entry.quality.rejectedIntervalCount, 0);
                assert.equal(entry.quality.invertedIntervalCount, 1);
                assert.equal(entry.intervals[1].status, 'ok');
            },
        },
        {
            name: 'rejects vendor/V1, unqualified, incoherent, and clipped-only surfaces',
            run() {
                const api = loadHandoffApi();
                const storage = createFakeStorage();

                assert.equal(api.saveSymbolEntry(sampleEntry({ varianceSource: 'vendor_iv' }), storage, TEST_NOW), false);
                assert.equal(api.saveSymbolEntry(sampleEntry({ underlyingContractMonth: null }), storage, TEST_NOW), false);
                assert.equal(api.saveSymbolEntry(sampleEntry({ quality: { status: 'ok', coherent: false, quoteComplete: true } }), storage, TEST_NOW), false);
                assert.equal(api.saveSymbolEntry(sampleEntry({ quality: { status: 'ok', coherent: true, quoteComplete: false } }), storage, TEST_NOW), false);
                assert.equal(api.saveSymbolEntry(sampleEntry({ snapshotId: '' }), storage, TEST_NOW), false);
                assert.equal(api.saveSymbolEntry(sampleEntry({
                    intervals: sampleEntry().intervals.map((interval, index) => (
                        index === 0 ? { ...interval, snapshotId: 'other-snapshot' } : interval
                    )),
                }), storage, TEST_NOW), false);
                assert.equal(api.saveSymbolEntry(sampleEntry({
                    intervals: sampleEntry().intervals.map((interval, index) => (
                        index === 0 ? { ...interval, quoteAsOf: '2027-01-15T20:55:00Z' } : interval
                    )),
                }), storage, TEST_NOW), false);
                const frozenQuoteAsOf = new Date(TEST_NOW - 30 * 86400000).toISOString();
                assert.equal(api.saveSymbolEntry(sampleEntry({
                    quoteAsOf: frozenQuoteAsOf,
                    intervals: sampleEntry().intervals.map((interval) => ({
                        ...interval,
                        quoteAsOf: frozenQuoteAsOf,
                    })),
                }), storage, TEST_NOW), true);
                assert.equal(api.saveSymbolEntry(sampleEntry({
                    intervals: [{
                        status: 'ok', rawLambda: 7, lambdaClamped: 1,
                        nonTradingDates: ['2027-01-16'],
                    }],
                }), storage, TEST_NOW), false);
                assert.equal(
                    api.removeSymbolEntry('ES', storage, '202703', 'snapshot-17'),
                    true
                );

                // A legacy key/store cannot leak into the V2 reader.
                storage.setItem('optionComboImpliedLambdaV1', JSON.stringify({
                    version: 1,
                    bySymbol: { ES: { symbol: 'ES', varianceSource: 'vendor_iv' } },
                }));
                assert.equal(api.peekSymbolEntry('ES', storage, TEST_NOW, '202703'), null);
            },
        },
        {
            name: 'keeps futures months separate and enforces the live anchor date',
            run() {
                const api = loadHandoffApi();
                const storage = createFakeStorage();
                assert.equal(api.saveSymbolEntry(sampleEntry(), storage, TEST_NOW), true);
                assert.equal(api.saveSymbolEntry(sampleEntry({
                    underlyingContractMonth: '202706',
                    snapshotId: 'snapshot-jun',
                    quality: {
                        status: 'ok', coherent: true, quoteComplete: true,
                        snapshotId: 'snapshot-jun', underlyingSnapshotId: 'snapshot-jun',
                    },
                    intervals: [{
                        startExpiry: '2027-01-15',
                        endExpiry: '2027-01-18',
                        status: 'ok', rawLambda: 0.3,
                        nonTradingDates: ['2027-01-16', '2027-01-17'],
                        snapshotId: 'snapshot-jun', quoteAsOf: '2027-01-15T20:59:00Z',
                    }],
                }), storage, TEST_NOW + 1000), true);

                assert.equal(api.peekSymbolEntry('ES', storage, TEST_NOW + 2000, '202703').medianLambda, 0.145);
                assert.equal(api.peekSymbolEntry('ES', storage, TEST_NOW + 2000, '202706').medianLambda, 0.3);
                assert.equal(api.peekSymbolEntry('ES', storage, TEST_NOW + 2000), null);
                assert.equal(api.peekSymbolEntry('ES', storage, TEST_NOW + 2000, '202703', '2027-01-15').anchorDate, '2027-01-15');
                assert.equal(api.peekSymbolEntry('ES', storage, TEST_NOW + 2000, '202703', '2027-01-16'), null);
            },
        },
        {
            name: 'does not let an older IVTS tab overwrite a newer snapshot',
            run() {
                const api = loadHandoffApi();
                const storage = createFakeStorage();
                assert.equal(api.saveSymbolEntry(sampleEntry(), storage, TEST_NOW), true);
                const older = sampleEntry({
                    quoteAsOf: '2027-01-15T20:58:00Z',
                    snapshotId: 'snapshot-older',
                    quality: {
                        status: 'ok', coherent: true, quoteComplete: true,
                        snapshotId: 'snapshot-older', underlyingSnapshotId: 'snapshot-older',
                    },
                    intervals: sampleEntry().intervals.map((interval) => ({
                        ...interval,
                        snapshotId: 'snapshot-older',
                        quoteAsOf: '2027-01-15T20:58:00Z',
                    })),
                });
                assert.equal(api.saveSymbolEntry(older, storage, TEST_NOW + 1000), false);
                assert.equal(
                    api.peekSymbolEntry('ES', storage, TEST_NOW + 2000, '202703').snapshotId,
                    'snapshot-17'
                );
                assert.equal(
                    api.saveSymbolEntry(
                        older, storage, TEST_NOW + 1000, { allowOlder: true }
                    ),
                    true
                );
                assert.equal(
                    api.peekSymbolEntry('ES', storage, TEST_NOW + 2000, '202703').snapshotId,
                    'snapshot-older'
                );
            },
        },
        {
            name: 'round-trips V2 and lets the user import a frozen older curve',
            run() {
                const api = loadHandoffApi();
                const doc = api.buildExportDocument(sampleEntry(), TEST_NOW);
                assert.equal(doc.format, api.EXPORT_FORMAT);
                assert.equal(doc.version, 2);
                assert.equal(doc.exportedAt, TEST_NOW);
                assert.equal(doc.varianceSource, 'straddle');
                assert.equal(doc.curveId, 'ES#202703@2027-01-15T20:59:00.000Z');
                assert.equal(doc.calendarEvidence.verified, true);
                assert.equal(doc.quality.status, 'ok');
                assert.equal(doc.intervals[0].rawLambda, 0.13);
                assert.equal(doc.methodology.pricingModel, 'black76');

                const loadedAt = TEST_NOW + 30 * 1000;
                const entry = api.parseImportDocument(JSON.stringify(doc), loadedAt);
                assert.ok(entry);
                assert.equal(entry.updatedAt, TEST_NOW);
                assert.equal(entry.quoteAsOf, '2027-01-15T20:59:00Z');

                const muchLaterLoad = TEST_NOW + 30 * 86400000;
                const accepted = api.parseImportDocumentDetailed(JSON.stringify(doc), muchLaterLoad);
                assert.ok(accepted.entry);
                assert.equal(accepted.entry.quoteAsOf, '2027-01-15T20:59:00Z');
                assert.equal(accepted.entry.updatedAt, TEST_NOW);

                assert.equal(api.parseImportDocument('{bad', loadedAt), null);
                assert.equal(api.parseImportDocument(JSON.stringify({ ...doc, version: 1 }), loadedAt), null);
                assert.equal(api.parseImportDocument(JSON.stringify({ ...doc, varianceSource: 'vendor_iv' }), loadedAt), null);
            },
        },
    ],
};
