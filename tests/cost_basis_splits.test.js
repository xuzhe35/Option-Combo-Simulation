const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

// Foundations for recording standard forward splits as groups
// (CODE PLAN/COST_BASIS_CORPORATE_ACTIONS_PLAN.md §15, A1 phase 1). All data
// here is synthetic except the published OCC #57592 strike table.

const FIXTURES = path.resolve(__dirname, 'fixtures');
const OCC = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'occ_57592_tqqq_strikes.json'), 'utf8'));
const ORDER = JSON.parse(fs.readFileSync(
    path.join(FIXTURES, 'cost_basis_event_order_vectors.json'), 'utf8'));

const ACCOUNT = 'U1111111';

function loadCore() {
    return loadBrowserScripts(['js/cost_basis_core.js']).OptionComboCostBasisCore;
}

function loadImport() {
    return loadBrowserScripts(['js/cost_basis_import.js']).OptionComboCostBasisImport;
}

function loadPage() {
    return loadBrowserScripts([
        'js/cost_basis_core.js',
        'js/american_binomial.js',
        'js/cost_basis_import.js',
        'js/cost_basis.js',
    ]).OptionComboCostBasisPage;
}

function cents(text) {
    const [whole, fraction] = text.split('.');
    return Number(whole) * 100 + Number(fraction);
}

let sequence = 0;
function event(overrides) {
    sequence += 1;
    return Object.assign({ seq: sequence, account: ACCOUNT, includeInCost: true, fees: 0 }, overrides);
}

function put(overrides) {
    return event(Object.assign({
        kind: 'option_trade', right: 'P', expiry: '20251219', sharesPerContract: 100,
    }, overrides));
}

function splitHeader(overrides) {
    return event(Object.assign({
        kind: 'split', tradeDate: '2025-11-20', splitRatio: 2, cashAmount: 0,
        splitGroup: 'split-g1', splitRuleRef: 'OCC #57592', splitRounding: 'half_up_cent',
    }, overrides));
}

module.exports = {
    name: 'cost_basis splits (A1 phase 1)',
    tests: [
        {
            name: 'OCC #57592: every published strike is integer cents divided by 2, rounded half up',
            run() {
                const core = loadCore();
                assert.equal(OCC.pairs.length, 167);
                OCC.pairs.forEach(([from, to]) => {
                    const adjusted = core.splitStrike(Number(from), OCC.ratio);
                    assert.ok(adjusted, from);
                    assert.equal(adjusted.fromCents, cents(from), from);
                    assert.equal(adjusted.toCents, cents(to), `${from} -> ${to}`);
                    assert.equal(adjusted.toStrike, Number(to), from);
                    // The same answer from the decimal text.
                    assert.equal(core.splitStrikeCents(core.strikeToCents(from), 2), cents(to));
                });
                // Floating division then toFixed gets exactly the three
                // half-cent series wrong, which is why the rule is integer.
                const floatWrong = OCC.pairs.filter(([from, to]) => (
                    (Number(from) / 2).toFixed(2) !== to)).map(([from]) => from);
                assert.deepEqual(floatWrong, OCC.halfCentCases.map(([from]) => from));
            },
        },
        {
            name: 'strikes are read as exact cents and never rounded to a cent',
            run() {
                const core = loadCore();
                assert.equal(core.strikeToCents(49.99), 4999);
                assert.equal(core.strikeToCents('49.990'), 4999);
                assert.equal(core.strikeToCents('50'), 5000);
                assert.equal(core.strikeToCents(0.1 + 0.2), 30);
                assert.equal(core.strikeToCents('49.991'), null);
                assert.equal(core.strikeToCents('49.99000001'), null);
                assert.equal(core.strikeToCents(33.333), null);
                for (const bad of [0, -1, '0', '-5', '', null, undefined, 'abc', '1e3', NaN, Infinity]) {
                    assert.equal(core.strikeToCents(bad), null, String(bad));
                }
            },
        },
        {
            name: 'only integer forward ratios 2..100 adjust a strike',
            run() {
                const core = loadCore();
                assert.equal(core.splitStrikeCents(10000, 3), 3333);
                assert.equal(core.splitStrikeCents(10001, 3), 3334);
                assert.equal(core.splitStrikeCents(10000, 10), 1000);
                assert.equal(core.splitStrikeCents(1, 3), null, 'rounds to zero');
                for (const ratio of [1, 0, -2, 2.5, 1.5, 101, '2', null, NaN]) {
                    assert.equal(core.isStandardSplitRatio(ratio), false, String(ratio));
                    assert.equal(core.splitStrikeCents(10000, ratio), null, String(ratio));
                }
                assert.equal(core.splitStrikeCents(49.99, 2), null, 'cents must be an integer');
                assert.equal(core.splitStrike(33.333, 2), null);
            },
        },
        {
            name: 'an option root comes from OCC and IBKR symbols; an adjusted class keeps its own',
            run() {
                const core = loadCore();
                assert.equal(core.optionRoot('TQQQ  251219P00100000'), 'TQQQ');
                assert.equal(core.optionRoot('TQQQ251219P00100000'), 'TQQQ');
                assert.equal(core.optionRoot('2TQQQ 251219P00050000'), '2TQQQ');
                assert.equal(core.optionRoot('2TQQQ251219P00050000'), '2TQQQ');
                assert.equal(core.optionRoot('TQQQ 19DEC25 100 P'), 'TQQQ');
                assert.equal(core.optionRoot('2tqqq 19dec25 50 p'), '2TQQQ');
                assert.equal(core.optionRoot('BRK.B 19DEC25 500 C'), 'BRK.B');
                assert.equal(core.optionRoot(''), '');
                assert.equal(core.optionRoot(null), '');
            },
        },
        {
            name: 'an option_split row moves its series out and the adjusted series in',
            run() {
                const core = loadCore();
                const row = {
                    kind: 'option_split', tradeDate: '2025-11-20', seq: 9, account: ACCOUNT,
                    splitGroup: 'g1', right: 'P', strike: 100, expiry: '20251219',
                    sharesPerContract: 100, conId: 1001, localSymbol: 'TQQQ  251219P00100000',
                    contracts: 2, splitToContracts: -4, splitToStrike: 50, splitToConId: 3003,
                    splitToLocalSymbol: 'TQQQ  251219P00050000',
                };
                const [out, into] = core.optionMovements(row);
                assert.equal(out.side, 'split_out');
                assert.equal(out.contracts, 2);
                assert.equal(out.strike, 100);
                assert.equal(out.conId, 1001);
                assert.equal(into.side, 'split_in');
                assert.equal(into.contracts, -4);
                assert.equal(into.strike, 50);
                assert.equal(into.conId, 3003);
                assert.equal(into.localSymbol, 'TQQQ  251219P00050000');
                assert.equal(core.contractKey(out), `${ACCOUNT}|P|100.0000|20251219|100`);
                assert.equal(core.contractKey(into), `${ACCOUNT}|P|50.0000|20251219|100`);
                assert.equal(into.event, row);

                const trade = put({ tradeDate: '2025-11-03', strike: 50, contracts: -1, cashAmount: 300 });
                const moves = core.optionMovements(trade);
                assert.equal(moves.length, 1);
                assert.equal(moves[0].side, 'trade');
                assert.equal(moves[0].contracts, -1);
                assert.equal(core.optionMovements({ kind: 'share_trade', shares: 100 }).length, 0);
                assert.equal(core.optionMovements(null).length, 0);
            },
        },
        {
            name: 'core and importer order rows exactly as the shared vectors say',
            run() {
                const core = loadCore();
                const parser = loadImport();
                ORDER.cases.forEach((testCase) => {
                    const coreOrder = testCase.events.slice()
                        .sort(core.compareEventOrder).map((item) => item.id);
                    assert.deepEqual(coreOrder, testCase.expected, testCase.name);
                    const importOrder = testCase.events.slice()
                        .sort((left, right) => parser.compareEventOrder(left, right)
                            || left.seq - right.seq)
                        .map((item) => item.id);
                    assert.deepEqual(importOrder, testCase.expected, `importer: ${testCase.name}`);
                });
            },
        },
        {
            name: 'split epochs count applied groups per account; legacy, voided and excluded rows do not',
            run() {
                const core = loadCore();
                sequence = 0;
                const before = put({ tradeDate: '2025-11-19', strike: 100, contracts: -1, cashAmount: 400 });
                const header = splitHeader();
                const leg = event({ kind: 'option_split', tradeDate: '2025-11-20', splitGroup: 'split-g1' });
                const sameDay = put({ tradeDate: '2025-11-20', brokerTimestamp: '2025-11-20T09:31:00',
                    strike: 50, contracts: -1, cashAmount: 200 });
                const otherAccount = put({ account: 'U2222222', tradeDate: '2025-11-21', strike: 50,
                    contracts: -1, cashAmount: 200 });
                const legacy = event({ kind: 'split', tradeDate: '2025-12-01', splitRatio: 2, cashAmount: 0 });
                const voided = splitHeader({ tradeDate: '2025-12-02', splitGroup: 'split-g2',
                    voidedAtUtc: '2025-12-03T00:00:00Z' });
                const excluded = splitHeader({ tradeDate: '2025-12-03', splitGroup: 'split-g3',
                    includeInCost: false });
                const second = splitHeader({ tradeDate: '2025-12-10', splitGroup: 'split-g4' });
                const after = put({ tradeDate: '2025-12-11', strike: 12.5, contracts: -1, cashAmount: 50 });
                const all = [after, second, excluded, voided, legacy, otherAccount, sameDay, leg, header, before];
                const ordered = all.slice().sort(core.compareEventOrder);
                const epochs = core.splitEpochs(ordered);
                assert.equal(epochs.get(before), 0);
                assert.equal(epochs.get(header), 0, 'a group sits on its pre-split side');
                assert.equal(epochs.get(leg), 0, 'its option rows too');
                assert.equal(epochs.get(sameDay), 1, 'a fill on the ex-date is post-split');
                assert.equal(epochs.get(otherAccount), 0, 'epochs are per account');
                assert.equal(epochs.get(legacy), 1, 'a legacy split starts no epoch');
                assert.equal(epochs.get(voided), 1);
                assert.equal(epochs.get(excluded), 1);
                assert.equal(epochs.get(second), 1);
                assert.equal(epochs.get(after), 2);
            },
        },
        {
            name: 'S1: after a split group, a post-split contract at an old strike is not confused with the pre-split one',
            run() {
                const core = loadCore();
                sequence = 0;
                const occ50 = 'TQQQ  251219P00050000';
                const events = [
                    put({ tradeDate: '2025-11-03', strike: 50, contracts: -1, cashAmount: 300,
                        conId: 1001, localSymbol: occ50 }),
                    put({ tradeDate: '2025-11-10', strike: 50, contracts: 1, cashAmount: -100,
                        conId: 1001, localSymbol: occ50 }),
                    splitHeader(),
                    put({ tradeDate: '2025-11-24', strike: 50, contracts: -1, cashAmount: 250,
                        conId: 2002, localSymbol: occ50 }),
                    // Typed by hand: no conId, no local symbol.
                    put({ tradeDate: '2025-12-01', strike: 50, contracts: 1, cashAmount: -50 }),
                ];
                const ledger = core.computeLedger(events, {});
                assert.deepEqual(Array.from(ledger.perAccount[ACCOUNT].warnings), []);
                assert.equal(ledger.openOptions.length, 0);
                assert.equal(ledger.perAccount[ACCOUNT].realizedPremium, 400);

                // Only the epoch separates them: the same rows without the
                // group are still the fail-closed ambiguity of a legacy split.
                const legacy = events.map((item) => (item.kind === 'split'
                    ? Object.assign({}, item, { splitGroup: null }) : item));
                const legacyLedger = core.computeLedger(legacy, {});
                assert.ok(legacyLedger.perAccount[ACCOUNT].warnings
                    .some((warning) => warning.startsWith('contract_identity_ambiguous:')));
            },
        },
        {
            name: 'S2: a split group applies before the ex-date fills; a legacy split row still sorts at day end',
            run() {
                const core = loadCore();
                sequence = 0;
                const rows = (split) => [
                    event({ kind: 'share_trade', tradeDate: '2025-11-03', shares: 100, price: 80,
                        cashAmount: -8000 }),
                    split,
                    event({ kind: 'share_trade', tradeDate: '2025-11-20',
                        brokerTimestamp: '2025-11-20T10:00:00', shares: 100, price: 40,
                        cashAmount: -4000 }),
                ];
                const grouped = core.computeLedger(rows(splitHeader()), {});
                assert.equal(grouped.perAccount[ACCOUNT].shares, 300);
                const legacy = core.computeLedger(rows(event({
                    kind: 'split', tradeDate: '2025-11-20', splitRatio: 2, cashAmount: 0,
                })), {});
                // Unchanged legacy semantics (the row is re-scaled); phase 2
                // adds a notice for exactly this case.
                assert.equal(legacy.perAccount[ACCOUNT].shares, 400);
            },
        },
        {
            name: 'a ledger without split groups keeps its running-position keys',
            run() {
                const core = loadCore();
                sequence = 0;
                const ledger = core.computeLedger([
                    put({ tradeDate: '2025-11-03', strike: 100, contracts: -2, cashAmount: 800,
                        conId: 1001 }),
                    event({ kind: 'split', tradeDate: '2025-11-20', splitRatio: 2, cashAmount: 0 }),
                ], {});
                assert.equal(ledger.openOptions.length, 1);
                assert.equal(ledger.openOptions[0].key, `${ACCOUNT}|P|100.0000|20251219|100|#con:1001`);
            },
        },
        {
            name: 'a statement cutoff on the ex-date already includes that day\'s split group',
            run() {
                const core = loadCore();
                const page = loadPage();
                sequence = 0;
                const events = [
                    event({ eventId: 'e1', kind: 'share_trade', tradeDate: '2025-11-03', shares: 100,
                        price: 80, cashAmount: -8000 }),
                    Object.assign(splitHeader(), { eventId: 'e2' }),
                    event({ eventId: 'e3', kind: 'share_trade', tradeDate: '2025-11-20',
                        brokerTimestamp: '2025-11-20T15:00:00', shares: 100, price: 40,
                        cashAmount: -4000 }),
                ];
                const ledger = core.computeLedger(events, {});
                const baseline = page.buildImportBaseline(
                    false, ledger, events, '2025-11-20T10:00:00', []);
                assert.equal(baseline.existingSharesByAccount[ACCOUNT], 200);
            },
        },
        {
            name: 'C/O child fills after a split group resolve to the post-split contract',
            run() {
                const parser = loadImport();
                const csvSymbol = 'TQQQ 19DEC25 50 P';
                const header = 'Trades,Header,DataDiscriminator,Asset Category,Currency,'
                    + 'Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code';
                const text = [header,
                    `Trades,Data,Order,Equity and Index Options,USD,${csvSymbol},"2025-12-01, 10:45:00",3,0.5,-150,-1,C;O`,
                    `Trades,Data,Trade,Equity and Index Options,USD,${csvSymbol},"2025-12-01, 10:45:00",1,0.5,-50,-0.33,C;O`,
                    `Trades,Data,Trade,Equity and Index Options,USD,${csvSymbol},"2025-12-01, 10:45:05",2,0.5,-100,-0.67,C;O`,
                ].join('\n');
                const base = { symbol: 'TQQQ', accountFallback: ACCOUNT, defaultSharesPerContract: 100 };
                const sourceRef = parser.parse(text, base).events[0].sourceRef;

                const optionRow = (overrides) => Object.assign({
                    kind: 'option_trade', account: ACCOUNT, right: 'P', strike: 50,
                    expiry: '20251219', sharesPerContract: 100, localSymbol: csvSymbol,
                    includeInCost: true,
                }, overrides);
                const history = (split) => [
                    optionRow({ eventId: 'h1', seq: 1, tradeDate: '2025-11-03',
                        brokerTimestamp: '2025-11-03T10:00:00', contracts: -1, conId: 1001 }),
                    optionRow({ eventId: 'h2', seq: 2, tradeDate: '2025-11-10',
                        brokerTimestamp: '2025-11-10T10:00:00', contracts: 1, conId: 1001 }),
                    split,
                    optionRow({ eventId: 'h4', seq: 4, tradeDate: '2025-11-24',
                        brokerTimestamp: '2025-11-24T10:00:00', contracts: -1, conId: 2002 }),
                    // The first child fill, already booked from TWS.
                    optionRow({ eventId: 'h5', seq: 5, tradeDate: '2025-12-01',
                        brokerTimestamp: '2025-12-01T10:45:00', contracts: 1, conId: 2002,
                        externalRef: 'ibkr-exec-E1', source: 'execution_report' }),
                ];
                const parse = (split) => parser.parse(text, Object.assign({}, base, {
                    existingEvents: history(split),
                    existingExternalRefs: [{ account: ACCOUNT, externalRef: 'ibkr-exec-E1' }],
                    fillSplits: {
                        [`${ACCOUNT}\u0000${sourceRef}`]: {
                            keep: [1], matched: [{ index: 0, externalRef: 'ibkr-exec-E1' }],
                        },
                    },
                }));
                const splitRow = { eventId: 'h3', seq: 3, kind: 'split', account: ACCOUNT,
                    tradeDate: '2025-11-20', splitRatio: 2, cashAmount: 0, includeInCost: true };
                const coProblem = (result) => result.problems.some(
                    (problem) => /拆分 C\/O 订单/.test(problem.reason));

                const grouped = parse(Object.assign({}, splitRow, { splitGroup: 'split-g1' }));
                assert.equal(coProblem(grouped), false);
                const kept = grouped.events.find((item) => item.kind === 'option_trade');
                assert.equal(kept.contracts, 2);
                assert.equal(kept.tag, 'ibkr_open');
                // Without a group the pre- and post-split K50 still collide.
                assert.equal(coProblem(parse(splitRow)), true);
            },
        },
    ],
};
