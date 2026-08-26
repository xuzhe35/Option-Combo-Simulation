const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPORTS_ROOT = path.join(REPO_ROOT, 'Reports');
const REPORT_SUFFIXES = ['20260821.csv', '20260824.csv', '20260825.csv'];

function findReport(suffix) {
    if (!fs.existsSync(REPORTS_ROOT)) return '';
    const pending = [REPORTS_ROOT];
    while (pending.length) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(target);
            else if (entry.isFile() && entry.name.endsWith(suffix)) return target;
        }
    }
    return '';
}

function loadRuntime() {
    const context = loadBrowserScripts([
        'js/cost_basis_import.js', 'js/cost_basis_core.js',
    ]);
    return {
        importer: context.OptionComboCostBasisImport,
        core: context.OptionComboCostBasisCore,
    };
}

function eventTimestamp(event) {
    return event.brokerTimestamp || `${event.tradeDate}T23:59:59`;
}

function shiftBackOneDay(isoDate) {
    const value = new Date(`${isoDate}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().slice(0, 10);
}

function openingRows(result) {
    return [
        ...((result.openings && result.openings.drafts) || []),
        ...((result.openings && result.openings.shareDrafts) || []),
        ...result.events,
    ];
}

function parseAgainstLedger(runtime, reportPath, symbol, allEvents) {
    const text = fs.readFileSync(reportPath, 'utf8');
    const discovery = runtime.importer.parse(text, { symbol });
    const through = runtime.core.computeLedger(allEvents.filter(
        (event) => eventTimestamp(event) <= discovery.statementThrough));
    const sharesByAccount = {};
    through.accounts.forEach((account) => {
        sharesByAccount[account] = through.perAccount[account].shares;
    });
    const baseline = {
        existingOpen: through.openOptions,
        existingSharesByAccount: sharesByAccount,
        existingExternalRefs: allEvents.filter((event) => event.externalRef).map(
            (event) => ({ account: event.account, externalRef: event.externalRef })),
    };
    const first = runtime.importer.parse(text, { symbol, ...baseline });
    const earliest = first.events.reduce((found, event) => (
        !found || event.tradeDate < found ? event.tradeDate : found), '');
    return runtime.importer.parse(text, {
        symbol,
        ...baseline,
        openingDate: earliest ? shiftBackOneDay(earliest) : '',
    });
}

function appendUnique(allEvents, result) {
    const known = new Set(allEvents.map(
        (event) => `${event.account}\u0000${event.externalRef}`));
    openingRows(result).forEach((event) => {
        const key = `${event.account}\u0000${event.externalRef}`;
        if (event.externalRef && known.has(key)) return;
        allEvents.push(Object.assign({ seq: allEvents.length + 1 }, event));
        if (event.externalRef) known.add(key);
    });
}

function replay(runtime, reports, symbol) {
    const allEvents = [];
    reports.forEach((report) => {
        const parsed = parseAgainstLedger(runtime, report, symbol, allEvents);
        assert.equal(parsed.problems.length, 0,
            `${symbol} ${path.basename(report)} must import without a blocked row`);
        appendUnique(allEvents, parsed);
    });
    const direct = parseAgainstLedger(runtime, reports[reports.length - 1], symbol, []);
    assert.equal(direct.problems.length, 0);
    return {
        sequential: runtime.core.computeLedger(allEvents),
        direct: runtime.core.computeLedger(openingRows(direct)),
    };
}

function comparable(ledger) {
    return {
        shares: ledger.combined.shares,
        netCash: ledger.combined.netCash,
        realizedPremium: ledger.combined.realizedPremium,
        openPremium: ledger.combined.openPremium,
        openOptions: ledger.openOptions.length,
        warnings: Array.from(ledger.warnings),
    };
}

module.exports = {
    name: 'real IBKR cumulative cost-basis reports',
    tests: [
        {
            name: 'all report symbols remain identical after cumulative overlap import',
            run() {
                const reports = REPORT_SUFFIXES.map(findReport);
                if (reports.some((item) => !item)) return;
                const runtime = loadRuntime();
                ['GLD', 'QQQ', 'SLV', 'TQQQ', 'USO'].forEach((symbol) => {
                    const result = replay(runtime, reports, symbol);
                    assert.deepEqual(comparable(result.sequential), comparable(result.direct),
                        `${symbol} cumulative import must equal a clean latest-report rebuild`);
                });
            },
        },
        {
            name: 'SPY statements fail closed only for the one mixed prior lot',
            run() {
                const reports = REPORT_SUFFIXES.map(findReport);
                if (reports.some((item) => !item)) return;
                const runtime = loadRuntime();
                reports.forEach((report) => {
                    const result = runtime.importer.parse(
                        fs.readFileSync(report, 'utf8'),
                        { symbol: 'SPY', openingDate: '2026-08-02' });
                    assert.equal(result.problems.length, 1);
                    assert.match(result.problems[0].raw, /SPY 20270917 P605/);
                    assert.equal(result.openings.drafts.filter(
                        (event) => event.tag === 'prior_basis').length, 23);
                    assert.deepEqual(Array.from(result.openings.drafts.filter(
                        (event) => event.tag === 'prior_open'),
                    (event) => event.localSymbol), ['SPY 17SEP27 605 P']);
                });
            },
        },
        {
            name: '8/21 -> 8/24 -> 8/25 TQQQ equals a clean 8/25 rebuild',
            run() {
                const reports = REPORT_SUFFIXES.map(findReport);
                if (reports.some((item) => !item)) return;
                const result = replay(loadRuntime(), reports, 'TQQQ');
                assert.deepEqual(comparable(result.sequential), comparable(result.direct));
                assert.deepEqual(comparable(result.sequential), {
                    shares: 200,
                    netCash: -13009.650921,
                    realizedPremium: 457.542332,
                    openPremium: 632.806747,
                    openOptions: 6,
                    warnings: [],
                });
            },
        },
        {
            name: 'SLV closing Basis survives cumulative import and ends flat',
            run() {
                const reports = REPORT_SUFFIXES.map(findReport);
                if (reports.some((item) => !item)) return;
                const result = replay(loadRuntime(), reports, 'SLV');
                assert.deepEqual(comparable(result.sequential), comparable(result.direct));
                assert.deepEqual(comparable(result.sequential), {
                    shares: 0,
                    netCash: -27202.812788,
                    realizedPremium: -27202.812788,
                    openPremium: 0,
                    openOptions: 0,
                    warnings: [],
                });
            },
        },
    ],
};
