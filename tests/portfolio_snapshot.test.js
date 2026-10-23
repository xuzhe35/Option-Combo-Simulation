const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const root = path.resolve(__dirname, '..');
function load() {
    return loadBrowserScripts(['js/portfolio_snapshot_schema.js', 'js/portfolio_snapshot_core.js', 'js/portfolio_snapshot_ocr.js']);
}
const plain = x => JSON.parse(JSON.stringify(x));
function synthetic() {
    const words = [];
    function add(text, x, y, width = .03) { words.push({ text, bbox: [x, y, width, .01], confidence: .9 }); }
    words.push(...require('./helpers/portfolio-snapshot-header')(.1));
    [['TOTAL', .10], ['TEST', .15], ['2030', .20]].forEach(([t, x]) => add(t, x, .15));
    [['ABC', .10], ["Oct21'30", .15], ['55', .21], ['PUT', .24], ['1.25', .30], ['-3', .44], ['25%', .95]].forEach(([t, x]) => add(t, x, .20));
    [['ABC', .10], ['55/50', .17], ['BearP', .23], ['2', .44]].forEach(([t, x]) => add(t, x, .25));
    [['ABC', .11], ["Oct21'30", .15], ['50', .21], ['PUT', .24], ['2', .44]].forEach(([t, x]) => add(t, x, .30));
    [['USD', .10], ['CASH', .15], ['1234.50', .65]].forEach(([t, x]) => add(t, x, .4));
    return { words, lines: [], runId: 'synthetic', engine: 'test-only', model: 'fixed-fixture' };
}
module.exports = {
    name: 'portfolio screenshot snapshot',
    tests: [
        { stage: 'P0', name: 'P0 frozen field contract matches the independent fixture', run() {
            const contract = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/portfolio_snapshot/contract_v1.json')));
            assert.deepEqual(plain(load().OptionComboPortfolioSnapshotSchema.FIELDS.map(f => f.path)), contract.fieldPaths);
            assert.equal(contract.recognizedEqualsReviewed, false);
        } },
        { stage: 'P0', name: 'strict decimal parsing preserves signs, percentages and unknowns', run() {
            const S = load().OptionComboPortfolioSnapshotSchema;
            assert.equal(S.decimal('-12,500'), '-12500'); assert.equal(S.decimal('(1,234.50)'), '-1234.5');
            assert.equal(S.decimal('30.5%', true), '0.305'); assert.equal(S.decimal(''), null); assert.equal(S.decimal(null), null);
            assert.equal(S.decimal('64.4%', true), '0.644'); assert.equal(S.decimal('107.4%', true), '1.074');
            assert.equal(S.decimal('- 12,345'), '-12345'); assert.equal(S.decimal('123.456•'), '123.456');
            assert.equal(S.decimal('• 12345.25'), '12345.25');
            for (const bad of ['1,23', '1e3', '8.3M', '1.0abc', 'c9.50', '—']) assert.throws(() => S.decimal(bad));
        } },
        { stage: 'P0', name: 'date semantics reject invalid days and keep screenshot date unknown', run() {
            const S = load().OptionComboPortfolioSnapshotSchema;
            assert.throws(() => S.date('2030-02-30')); assert.equal(S.date('2032-02-29'), '2032-02-29');
            assert.equal(S.empty('a', '2030-01-01T00:00:00Z').asOf.date, null);
        } },
        { name: 'OCR candidates exclude summary and combo parents and retain cash separately', run() {
            const ctx = load(), r = ctx.OptionComboPortfolioSnapshotOcr.normalize(synthetic(), 'image-1');
            assert.equal(r.positions.length, 2); assert.equal(r.cash.length, 1); assert.equal(r.sourceRows.length, 5);
            assert.equal(r.positions[0].quantity, '-3'); assert.equal(r.positions[0].instrument.expiryDate, '2030-10-21');
            assert.equal(r.positions[0].displayValues.displayIv, '.25'.replace(/^\./, '0.'));
            assert.equal(r.sourceRows[3].parentRowId, r.sourceRows[2].rowId);
            assert.equal(r.cash[0].amount, '1234.5');
        } },
        { name: 'truncated option type uses the prefix while prefixed last prices stay unknown', run() {
            const ctx = load(), input = synthetic();
            input.words.find(w => w.text === 'PUT').text = 'CA...';
            input.words.push({ text: 'c5.5', bbox: [.89, .2, .035, .01], confidence: .95 });
            const p = ctx.OptionComboPortfolioSnapshotOcr.normalize(input, 'image-1').positions[0];
            assert.equal(p.instrument.right, 'C'); assert.equal(p.displayValues.lastPrice, null);
            assert.match(p.fieldEvidence['displayValues.lastPrice'].raw, /c5.5/);
            assert.equal(p.fieldEvidence['instrument.right'].interpretation.token, 'CA...');
            assert.match(p.fieldEvidence['instrument.right'].raw, /CA\.\.\./);
            assert.equal(ctx.OptionComboPortfolioSnapshotCore.issues(p).some(s => /截断或未确认/.test(s)), false);
        } },
        { name: 'option type prefixes are anchored after expiry and strike, not arbitrary words', run() {
            for (const [token, right] of [['CA','C'],['CAL…','C'],['ca...','C'],['CALL','C'],['PU','P'],['PU…','P'],['pu...','P'],['PUT','P'],['C',null],['P',null],['CASH',null],['CALENDAR',null],['PUTNAM',null]]) {
                const ctx = load(), input = synthetic();
                input.words.find(w => w.text === 'PUT').text = token;
                const row = ctx.OptionComboPortfolioSnapshotOcr.normalize(input, 'image-1').sourceRows.find(r => r.rawCells.description?.includes(token));
                const p = ctx.OptionComboPortfolioSnapshotOcr.normalize(input, 'image-1').positions.find(p => p.sourceRowIds.includes(row.rowId));
                assert.equal(p?.instrument.right ?? null, right, token);
            }
        } },
        { name: 'bulk review confirms all positions and cash, keeps evidence and flags, edits reopen only changed rows', run() {
            const ctx = load(), S = ctx.OptionComboPortfolioSnapshotSchema, C = ctx.OptionComboPortfolioSnapshotCore;
            const state = C.applyRecognition(S.empty('a', 't'), ctx.OptionComboPortfolioSnapshotOcr.normalize(synthetic(), 'image-1'));
            const next = C.confirmAll(state, 'bulk-time');
            assert.ok([...next.positions, ...next.cash].every(p => p.reviewStatus === 'reviewed' && p.reviewedAtUtc === 'bulk-time'));
            assert.equal(next.review.status, 'needs_review'); // Synthetic combo has only one visible leg.
            assert.equal(state.positions[0].reviewStatus, 'unreviewed');
            assert.deepEqual(plain(next.positions[0].fieldEvidence), plain(state.positions[0].fieldEvidence));
            assert.deepEqual(plain(next.coverage), plain(state.coverage));
            assert.ok(C.issues(next.positions[0]).length === C.issues(state.positions[0]).length);
            const edited = C.edit(next, next.positions[0].positionId, 'quantity', '-7', 'later');
            assert.equal(edited.positions[0].reviewStatus, 'unreviewed'); assert.equal(edited.positions[1].reviewStatus, 'reviewed');
            assert.equal(edited.cash[0].reviewStatus, 'reviewed');
            const complete = S.clone(next); complete.recognition.structureIssues = [];
            assert.equal(C.reviewStatus(complete), 'reviewed');
            complete.cash[0].reviewStatus = 'unreviewed'; assert.equal(C.reviewStatus(complete), 'needs_review');
            assert.equal(C.confirmAll(S.empty('a', 't'), 'now').review.status, 'needs_review');
            assert.deepEqual(plain(S.validate(next)), plain(next));
        } },
        { name: 'unsupported layout fails visibly instead of generating sample positions', run() {
            const ctx = load(); assert.throws(() => ctx.OptionComboPortfolioSnapshotOcr.normalize({ words: [] }, 'a'), /表头/);
        } },
        { stage: 'P0', name: 'manual correction retains original evidence and invalidates confirmation', run() {
            const ctx = load(), S = ctx.OptionComboPortfolioSnapshotSchema, C = ctx.OptionComboPortfolioSnapshotCore;
            const state = C.applyRecognition(S.empty('a', '2030-01-01T00:00:00Z'), ctx.OptionComboPortfolioSnapshotOcr.normalize(synthetic(), 'image-1'));
            const id = state.positions[0].positionId, confirmed = C.confirm(state, id, 't1');
            const edited = C.edit(confirmed, id, 'quantity', '-4', 't2');
            assert.equal(state.positions[0].quantity, '-3'); assert.equal(edited.positions[0].quantity, '-4');
            assert.equal(edited.positions[0].fieldEvidence.quantity.raw, '-3');
            assert.equal(edited.positions[0].reviewStatus, 'unreviewed'); assert.equal(edited.review.changes.length, 1);
            assert.equal(edited.account.value, null); assert.equal(edited.asOf.date, null);
        } },
        { stage: 'P0', name: 'JSON round trip is detached and rejects grouping as positions, duplicates and invalid boxes', run() {
            const ctx = load(), S = ctx.OptionComboPortfolioSnapshotSchema;
            const state = ctx.OptionComboPortfolioSnapshotCore.applyRecognition(S.empty('a', '2030-01-01T00:00:00Z'), ctx.OptionComboPortfolioSnapshotOcr.normalize(synthetic(), 'image-1'));
            assert.deepEqual(plain(S.validate(state)), plain(state));
            const bad = plain(state); bad.positions[0].sourceRowIds = [bad.sourceRows[0].rowId]; assert.throws(() => S.validate(bad), /误计/);
            const bad2 = plain(state); bad2.positions.push(bad2.positions[0]); assert.throws(() => S.validate(bad2));
            const bad3 = plain(state); bad3.sourceRows[0].bbox = [0, 2, 1, .1]; assert.throws(() => S.validate(bad3), /区域/);
            const bad4 = plain(state); bad4.positions.pop(); assert.throws(() => S.validate(bad4), /未映射/);
            const bad5 = plain(state); bad5.cash[0].amount = 123; assert.throws(() => S.validate(bad5), /现金金额/);
        } },
        { stage: 'P0', name: 'confirming a row never removes unresolved fields', run() {
            const ctx = load(), S = ctx.OptionComboPortfolioSnapshotSchema, C = ctx.OptionComboPortfolioSnapshotCore;
            const state = C.add(S.empty('a', 't'), 't');
            const confirmed = C.confirm(state, state.positions[0].positionId, 't');
            assert.equal(confirmed.positions[0].reviewStatus, 'reviewed'); assert.ok(C.issues(confirmed.positions[0]).length);
        } },
        { stage: 'P1', name: 'page is isolated from trading and persistence; entry opens a separate tab', run() {
            const html = fs.readFileSync(path.join(root, 'portfolio_snapshot.html'), 'utf8');
            const scripts = [...html.matchAll(/src="([^"]+\.js)(?:\?[^\"]*)?"/g)].map(m => m[1]);
            assert.deepEqual(scripts, ['js/portfolio_snapshot_schema.js', 'js/portfolio_snapshot_core.js', 'js/portfolio_snapshot_ocr.js', 'js/portfolio_snapshot_codex.js',
                'js/portfolio_snapshot_tws_model.js', 'js/portfolio_snapshot_tws.js', 'js/portfolio_snapshot.js', 'js/portfolio_snapshot_tws_panel.js']);
            const entry = fs.readFileSync(path.join(root, 'cost_basis.html'), 'utf8');
            assert.match(entry, /href="portfolio_snapshot.html" target="_blank" rel="noopener"/);
            const page = fs.readFileSync(path.join(root, 'js/portfolio_snapshot.js'), 'utf8');
            assert.doesNotMatch(page, /new WebSocket|localStorage|indexedDB|save_cost_basis|submit_order/);
        } },
    ],
};
module.exports.synthetic = synthetic;
