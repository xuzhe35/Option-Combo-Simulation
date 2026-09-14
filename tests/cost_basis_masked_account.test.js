const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const account = 'U100022426';
const masked = 'U***22426';
const opts = { symbol: 'TQQQ', targetAccount: account, accountFallback: account, currency: 'USD' };
const mapping = { sourceAccount: masked, targetAccount: account };
const header = 'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Basis,Realized P/L,Code';
const csv = [
    'Statement,Data,Period,"September 11, 2026"',
    'Account Information,Header,Field Name,Field Value',
    `Account Information,Data,Account,${masked}`,
    header,
    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-09-11, 16:20:00",100,71, -7100,0,7100,0,A;O',
    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 11SEP26 71 P,"2026-09-11, 16:20:00",1,0,0,0,120,0,A;C',
    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Multiplier,Cost Basis',
    'Open Positions,Data,Summary,Stocks,USD,TQQQ,200,1,14100',
].join('\n');

function runtime() {
    const c = loadBrowserScripts(['js/cost_basis_core.js', 'js/cost_basis_import.js', 'js/cost_basis.js']);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/cost_basis.js'), 'utf8').replace(
        'globalScope.OptionComboCostBasisPage = {', `
        globalScope.h={state,parse:_parseImportText,rows:_importNewRows,confirmAccount:_handleImportAccountConfirmationChange,
            commit:_commitImport,readFile:_handleImportFile,changeMode:_handleImportReplaceChange,
            configure(fn){request=fn;_refreshControls=()=>{};_renderImportPreview=()=>{};_refreshResetPlan=async()=>{};_loadBooks=async()=>{};}};
        globalScope.OptionComboCostBasisPage = {`), c);
    const nodes = new Map();
    c.document = { getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { checked: false, value: '', hidden: false });
        return nodes.get(id);
    } };
    c.alert = () => {};
    c.confirm = () => true;
    const book = { bookId: 'test', account, symbol: 'TQQQ', currency: 'USD', secType: 'STK', defaultSharesPerContract: 100 };
    const baseline = { eventId: 'baseline', seq: 1, account, kind: 'opening_balance', tradeDate: '2026-09-10',
        shares: 100, price: 70, cashAmount: -7000, source: 'manual' };
    Object.assign(c.h.state, { books: [book], bookId: book.bookId, importGeneration: 1, importText: csv,
        importMeta: { fileName: 'daily.csv', fileDigest: 'test' }, allEvents: [baseline],
        ledgerVersion: { digest: 'test' }, ledger: c.OptionComboCostBasisCore.computeLedger([baseline]) });
    c.h.configure(async () => ({}));
    return c;
}

function verifyParser() {
    const c = runtime(), I = c.OptionComboCostBasisImport;
    const blocked = I.parse(csv, opts);
    assert.equal(blocked.accountMatch.status, 'confirmation_required');
    assert.equal(blocked.checks.account, false);
    assert.equal(blocked.summary.total, 2);
    assert.equal(blocked.events.length, 0);
    for (const source of ['U***99999', 'DU***22426', 'U999922426', 'U***26', '***', 'U.*22426']) {
        const result = I.parse(csv.replace(masked, source), { ...opts,
            confirmedAccountMapping: { sourceAccount: source, targetAccount: account } });
        assert.ok(result.problems.length, source);
        assert.equal(result.events.length, 0, source);
        assert.equal(result.accountMatch.canConfirm, false, source);
    }
    for (const confirmation of [true, {}, { ...mapping, targetAccount: 'U200022426' }, { ...mapping, sourceAccount: 'U***12426' }]) {
        assert.equal(I.parse(csv, { ...opts, confirmedAccountMapping: confirmation }).events.length, 0);
    }
    const missing = I.parse(csv.replace(`Account Information,Data,Account,${masked}`, ''), opts);
    assert.equal(missing.accountMatch.status, 'missing');
    assert.equal(missing.events.length, 0, 'a selected ledger is not evidence of the source account');
    const confirmedOpts = { ...opts, confirmedAccountMapping: mapping };
    const empty = I.parse(csv, confirmedOpts);
    assert.equal(empty.account, account);
    assert.equal(empty.openings.openingShares, 100);
    assert.ok(empty.problems.length, 'account confirmation cannot supply missing share cost');
    assert.equal(empty.openings.shareDrafts.length, 0);
    const complete = I.parse(csv, { ...confirmedOpts, existingSharesByAccount: { [account]: 100 } });
    assert.equal(complete.problems.length, 0);
    assert.equal(complete.events[0].shares, 100);
    assert.equal(complete.events[0].cashAmount, -7100, 'assignment cash is delivery only');
    assert.ok(complete.events.concat(complete.openings.drafts).every(e => e.account === account));
    const unmasked = I.parse(csv.replace(masked, account), { ...opts, existingSharesByAccount: { [account]: 100 } });
    assert.deepEqual(Array.from(complete.events, e => e.externalRef), Array.from(unmasked.events, e => e.externalRef),
        'masked and unmasked exports of the same trade must deduplicate');
}

async function verifyPage() {
    const c = runtime(), h = c.h, writes = [];
    h.configure(async (action, payload) => { writes.push({ action, payload }); return { inserted: payload.events.length, skipped: 0 }; });
    h.parse(csv, h.state.importMeta);
    await h.commit();
    assert.equal(writes.length, 0);
    c.document.getElementById('import-account-confirm').checked = true;
    await h.confirmAccount();
    assert.equal(h.state.importResult.problems.length, 0);
    assert.equal(h.state.importResult.ledgerPreview.warnings.length, 0);
    assert.ok(h.state.importResult.ledgerPreview.positions.every(p => p.statement === null || p.after === p.statement));
    c.document.getElementById('import-replace').checked = true;
    await h.changeMode();
    assert.equal(h.state.importResult.accountMatch.status, 'confirmed');
    assert.ok(h.state.importResult.problems.length, 'a one-day rebuild must not silently retain the old shares');
    c.document.getElementById('import-replace').checked = false;
    await h.changeMode();
    await h.commit();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].action, 'import_cost_basis_events');
    assert.equal(writes[0].payload.events.length, 2);
    assert.ok(writes[0].payload.events.every(e => e.account === account));
    assert.equal(h.state.importAccountConfirmation, null);
}

async function verifyConfirmationScope() {
    const c = runtime(), h = c.h;
    h.parse(csv, h.state.importMeta);
    c.document.getElementById('import-account-confirm').checked = true;
    await h.confirmAccount();
    const confirmation = h.state.importAccountConfirmation;
    for (const change of [
        () => { h.state.importGeneration += 1; },
        () => { h.state.bookId = 'different'; h.state.books.push({ ...h.state.books[0], bookId: 'different' }); },
        () => { h.state.importText = csv + '\n'; },
    ]) {
        Object.assign(h.state, { bookId: 'test', importGeneration: 1, importText: csv, importAccountConfirmation: confirmation });
        change();h.parse(h.state.importText, h.state.importMeta);
        assert.equal(h.state.importResult.accountMatch.status, 'confirmation_required');
        assert.ok(h.state.importResult.problems.length);
    }
    Object.assign(h.state, { bookId: 'test', importGeneration: 1, importText: csv, importAccountConfirmation: confirmation });
    h.parse(csv, h.state.importMeta);
    c.document.getElementById('import-account-confirm').checked = false;
    await h.confirmAccount();
    assert.equal(h.state.importAccountConfirmation, null);
    assert.equal(h.state.importResult.accountMatch.status, 'confirmation_required');
    h.state.importAccountConfirmation = confirmation;
    c.FileReader = class { readAsText() {} };
    h.readFile({ target: { files: [{ name: 'different.csv' }] } });
    assert.equal(h.state.importAccountConfirmation, null);
    assert.equal(h.state.importResult, null);
}

// Read-only opt-in using the exact user file. The starting share cost is an
// explicit test assumption, never a reconstruction or a write to a real book.
function verifyRealReport() {
    const file = process.env.COST_BASIS_MASKED_STATEMENT_CSV;
    if (!file) return null;
    const text = fs.readFileSync(file, 'utf8');
    const c = runtime(), h = c.h, I = c.OptionComboCostBasisImport, C = c.OptionComboCostBasisCore;
    const blocked = I.parse(text, opts);
    assert.equal(blocked.summary.total, 28);
    assert.equal(blocked.accountMatch.status, 'confirmation_required');
    const confirmedOpts = { ...opts, confirmedAccountMapping: mapping };
    const empty = I.parse(text, confirmedOpts);
    assert.equal(empty.summary.drafted, 20);
    assert.equal(empty.openings.openingShares, 1500);
    assert.equal(empty.openings.closingShares, 14000);
    assert.equal(empty.openings.shareDrafts.length, 0);
    assert.ok(empty.problems.length);
    const wrongBaseline = I.parse(text, { ...confirmedOpts, existingSharesByAccount: { [account]: 1499 } });
    assert.ok(wrongBaseline.problems.length, 'even a one-share gap cannot be silently filled');
    assert.equal(wrongBaseline.openings.shareDrafts.length, 0);
    const baseline = { ...h.state.allEvents[0], shares: 1500, cashAmount: -105000 };
    Object.assign(h.state, { importText: text, allEvents: [baseline], ledger: C.computeLedger([baseline]),
        importAccountConfirmation: { bookId: 'test', generation: 1, text, ...mapping } });
    h.parse(text, h.state.importMeta);
    const result = h.state.importResult, incoming = h.rows(result);
    assert.equal(result.problems.length, 0);
    assert.equal(result.ledgerPreview.warnings.length, 0);
    assert.equal(incoming.length, 27);
    assert.ok(result.ledgerPreview.positions.every(p => p.statement === null || Math.abs(p.after - p.statement) < 1e-6));
    // Independent raw-row controls: four stock deliveries are folded into
    // assignment events; option premium is not counted a second time there.
    const rows = I.parseCsv(text);
    const trades = rows.filter(r => r[0] === 'Trades' && r[1] === 'Data' && r[2] === 'Order' && /^TQQQ(?: |$)/.test(r[5]));
    const number = x => Number(String(x).replace(/,/g, ''));
    const rawCash = trades.reduce((sum, r) => sum + number(r[10]) + number(r[11]), 0);
    const deliveries = trades.filter(r => r[3] === 'Stocks').reduce((sum, r) => sum + number(r[7]), 0);
    assert.equal(deliveries, 12500);
    assert.ok(Math.abs(result.events.reduce((sum, e) => sum + e.cashAmount, 0) - rawCash) < 1e-6);
    assert.equal(result.events.reduce((sum, e) => sum + (e.shares || 0), 0), deliveries);
    const ledger = C.computeLedger([baseline, ...incoming]);
    Object.assign(h.state, { allEvents: [baseline, ...incoming].map((e, i) => ({ ...e, eventId: `stored-${i}`, seq: i + 1 })), ledger });
    h.parse(text, h.state.importMeta);
    assert.equal(h.state.importResult.problems.length, 0);
    assert.equal(h.rows(h.state.importResult).length, 0);
    assert.equal(h.state.importResult.ledgerPreview.warnings.length, 0);
    h.state.importText = text.replace(masked, account);
    h.parse(h.state.importText, h.state.importMeta);
    assert.equal(h.state.importResult.accountMatch.status, 'exact');
    assert.equal(h.state.importResult.problems.length, 0);
    assert.equal(h.rows(h.state.importResult).length, 0, 'an unmasked re-export cannot duplicate masked imports');
    return { baseline, incoming, expectedShares: 14000, expectedCash: ledger.combined.netCash };
}

module.exports = { name: 'cost_basis_masked_account', tests: [
    { name: 'masked identity requires exact explicit mapping and cannot invent missing opening costs', run: verifyParser },
    { name: 'confirmed daily import reaches the real submit handler and still blocks an incomplete rebuild', run: verifyPage },
    { name: 'account consent expires across files, books, and generations and can be revoked', run: verifyConfirmationScope },
    { name: 'optional actual masked statement reconciles raw cash, deliveries and repeated import', run: verifyRealReport },
] };
if (require.main === module) (async () => {
    for (const test of module.exports.tests.slice(0, 3)) await test.run();
    process.stdout.write(JSON.stringify(verifyRealReport()));
})().catch(error => { console.error(error); process.exitCode = 1; });
