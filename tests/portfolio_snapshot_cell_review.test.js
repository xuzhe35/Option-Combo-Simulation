const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const { image } = require('./portfolio_snapshot_structure.test');
const load = () => loadBrowserScripts(['js/portfolio_snapshot_schema.js', 'js/portfolio_snapshot_core.js', 'js/portfolio_snapshot_ocr.js']);
const plain = x => JSON.parse(JSON.stringify(x));
const NUMERIC = ['dailyPnl', 'mark', 'costBasis', 'quantity', 'unrealizedPnl', 'deltaDollars', 'marketValue', 'avgPrice', 'theta', 'lastPrice', 'displayIv'];
// Synthetic protocol-2 (RapidOCR cell review) response: one measured band per synthetic
// row. Review answers are supplied per requested crop by each test, never by production code.
function cellRaw(rows, bands) {
    const raw = image(rows);
    raw.width = 2000; raw.height = 2000; raw.reviewProtocol = 2; raw.engine = 'rapidocr';
    raw.rowBands = bands || [[.045, .065], ...rows.map((_, i) => [.098 + i * .035, .114 + i * .035])];
    return raw;
}
// answer(field, rowIndex) -> texts per scale (2/3/4 for descriptionRow, 3/4 otherwise),
// null for a blank cell, or undefined to leave the crop unanswered. Numeric cells carry the
// engine's pixel dash evidence; by default it matches the text, `dash` overrides it.
// Every word reports the pixels the engine read (readBbox); `read` may move them.
function answer(raw, crops, reply, dash = () => undefined, read = (_field, _row, box) => box) {
    raw.reviewRereads = crops.flatMap(c => {
        const b = c.cropBbox, row = Math.round((b[1] + b[3] / 2 - .106) / .035), texts = reply(c.field, row);
        if (texts === undefined) return [];
        const scales = c.field === 'descriptionRow' ? [2, 3, 4] : [3, 4], inner = [b[0] + b[2] * .1, b[1] + b[3] * .25, b[2] * .8, b[3] * .5];
        const evidence = { field: c.field, cropBbox: [...b], blank: texts === null,
            passes: scales.map((scale, k) => ({ scale, words: texts === null ? [] : [{ text: texts[k], bbox: [...inner], inkBbox: [...inner], readBbox: read(c.field, row, [...b]) }] })) };
        if (c.field !== 'descriptionRow') evidence.leadingDash = dash(c.field, row) ?? (texts !== null && texts[0].trim().startsWith('-'));
        return [evidence];
    });
    return raw;
}
function twoStep(rows, reply, bands) {
    const c = load(), O = c.OptionComboPortfolioSnapshotOcr, raw = cellRaw(rows, bands);
    const first = O.normalize(raw, 'x');
    const second = O.normalize(answer(raw, first.recognition.reviewCrops, reply), 'x');
    return { c, first: plain(first), second: plain(second) };
}
const stock = (values = {}) => (field, row) => field === 'descriptionRow' ? Array(3).fill(['ABC', 'XYZ'][row])
    : field in values ? values[field] : null;

module.exports = { name: 'portfolio OCR cell review (RapidOCR protocol 2)', tests: [
    { name: 'cell mode adopts every numeric cell only from agreeing 3x/4x crops, never from the first pass', run() {
        const { c, first, second } = twoStep([{ desc: 'ABC', qty: '21' }], stock({ quantity: ['-1', '-1'], mark: ['10.5', '10.5'], marketValue: ['-10.5', '-10.5'] }));
        assert.deepEqual(first.recognition.quantityCrops, []);
        const requested = new Set(first.recognition.reviewCrops.map(r => r.field));
        for (const field of ['descriptionRow', ...NUMERIC]) assert.ok(requested.has(field), field);
        const p = second.positions[0];
        assert.equal(p.quantity, '-1'); assert.equal(p.displayValues.mark, '10.5'); assert.equal(p.displayValues.marketValue, '-10.5');
        assert.equal(p.fieldEvidence.quantity.originalValue, '21');
        assert.equal(p.fieldEvidence.quantity.corrections.length, 1);
        assert.equal(p.displayValues.displayIv, null); assert.equal(p.fieldEvidence['displayValues.displayIv'].problem, null);
        assert.ok(c.OptionComboPortfolioSnapshotCore.issues(p).some(t => t.includes('持仓数量')));
    } },
    { name: 'cell mode keeps disagreeing or unanswered cells unknown and visible', run() {
        const reply = (field, row) => field === 'avgPrice' ? undefined : stock({ quantity: ['3', '3'], mark: ['10.5', '10.6'] })(field, row);
        const { c, second } = twoStep([{ desc: 'ABC', qty: '3' }], reply);
        const p = second.positions[0], issues = c.OptionComboPortfolioSnapshotCore.issues(p);
        assert.equal(p.displayValues.mark, null); assert.equal(p.displayValues.avgPrice, null);
        assert.ok(issues.some(t => t.startsWith('MARK') && t.includes('两次放大')));
        assert.ok(issues.some(t => t.startsWith('AVG PRICE') && t.includes('未收到局部复核答复')));
        assert.equal(p.quantity, '3');
    } },
    { name: 'agreeing reads whose sign contradicts the pixel dash evidence stay unknown', run() {
        const c = load(), O = c.OptionComboPortfolioSnapshotOcr, raw = cellRaw([{ desc: 'ABC', qty: '1' }]);
        const crops = O.normalize(raw, 'x').recognition.reviewCrops;
        const reply = stock({ quantity: ['110', '110'], mark: ['-2', '-2'], costBasis: ['5', '5'] });
        const second = plain(O.normalize(answer(raw, crops, reply, f => f === 'quantity' ? true : f === 'mark' ? false : undefined), 'x'));
        const p = second.positions[0], issues = c.OptionComboPortfolioSnapshotCore.issues(p);
        assert.equal(p.quantity, null); assert.equal(p.displayValues.mark, null); assert.equal(p.displayValues.costBasis, '5');
        assert.ok(issues.some(t => t.startsWith('持仓数量') && t.includes('正负号')));
        const missing = plain(O.normalize(answer(raw, crops, reply, f => f === 'costBasis' ? 'unknown' : undefined), 'x'));
        assert.equal(missing.positions[0].displayValues.costBasis, null);
    } },
    { name: 'measured bands keep rows apart when detector boxes reach into the next row', run() {
        const rows = [{ desc: 'ABC', qty: '1' }, { desc: 'XYZ', qty: '2' }];
        const c = load(), raw = cellRaw(rows);
        // Detector boxes about three times the glyph height overlap the neighbouring band.
        for (const w of raw.words.filter(w => w.bbox[1] >= .09)) { w.bbox[1] -= .019; w.bbox[3] = .05; }
        const first = c.OptionComboPortfolioSnapshotOcr.normalize(raw, 'x');
        const second = plain(c.OptionComboPortfolioSnapshotOcr.normalize(answer(raw, first.recognition.reviewCrops,
            stock({ quantity: undefined })), 'x'));
        assert.equal(second.sourceRows.length, 2);
        assert.deepEqual(second.positions.map(p => p.instrument.symbol), ['ABC', 'XYZ']);
    } },
    { name: 'a measured band the first pass missed entirely is reviewed, not dropped', run() {
        const rows = [{ desc: 'ABC', qty: '1' }, { desc: 'XYZ', qty: '2' }];
        const c = load(), O = c.OptionComboPortfolioSnapshotOcr, raw = cellRaw(rows);
        raw.words = raw.words.filter(w => !(w.bbox[1] > .13 && w.bbox[1] < .15));
        const first = O.normalize(raw, 'x');
        assert.ok(first.recognition.reviewCrops.some(r => r.field === 'descriptionRow' && Math.abs(r.cropBbox[1] + r.cropBbox[3] / 2 - .141) < .01));
        const second = plain(O.normalize(answer(raw, first.recognition.reviewCrops, stock({ quantity: ['2', '2'] })), 'x'));
        assert.deepEqual(second.positions.map(p => [p.instrument.symbol, p.quantity]), [['ABC', '2'], ['XYZ', '2']]);
    } },
    { name: 'invalid or overlapping row bands fail closed', run() {
        const O = load().OptionComboPortfolioSnapshotOcr;
        for (const bands of [[[.1, .2], [.15, .3]], [[.2, .1]], [[.1, 1.2]], 'x'])
            assert.throws(() => O.normalize(cellRaw([{ desc: 'ABC', qty: '1' }], bands), 'x'), /行带证据无效/);
    } },
    { name: 'the +/- row control left of DAILY P&L is not a column; lettered or misplaced tokens still reject', run() {
        const O = load().OptionComboPortfolioSnapshotOcr;
        const with_ = token => { const raw = image([{ desc: 'ABC', qty: '1' }]); raw.words.push({ text: token.text, bbox: token.bbox }); return raw; };
        assert.equal(O.normalize(with_({ text: '+1-', bbox: [.004, .05, .015, .01] }), 'x').positions.length, 1);
        assert.throws(() => O.normalize(with_({ text: 'ACCT', bbox: [.004, .05, .02, .01] }), 'x'), /发现不支持的额外列或文字：ACCT/);
        assert.throws(() => O.normalize(with_({ text: '+1-', bbox: [.87, .05, .015, .01] }), 'x'), /发现不支持的额外列或文字：\+1-/);
    } },
    { name: 'the Vision protocol ignores row bands and keeps its targeted reviews', run() {
        const O = load().OptionComboPortfolioSnapshotOcr, raw = image([{ desc: 'ABC', qty: '1' }]);
        raw.reviewProtocol = 1; raw.rowBands = 'not used';
        const r = O.normalize(raw, 'x');
        assert.ok(!r.recognition.reviewCrops.some(c => c.field === 'quantity'));
    } },
    { name: 'a cell read whose pixels leave the requested crop (a neighbouring row) is not evidence', run() {
        const rows = [{ desc: 'ABC', qty: '1' }, { desc: 'XYZ', qty: '2' }];
        const c = load(), O = c.OptionComboPortfolioSnapshotOcr, raw = cellRaw(rows);
        const first = O.normalize(raw, 'x');
        const reply = stock({ quantity: ['1', '1'], mark: ['10.5', '10.5'] });
        // The engine reports reading 30% of a row above the requested crop for row 1's MARK.
        const read = (field, row, b) => field === 'mark' && row === 1 ? [b[0], b[1] - b[3] * .3, b[2], b[3] * 1.3] : b;
        const second = plain(O.normalize(answer(raw, first.recognition.reviewCrops, reply, undefined, read), 'x'));
        assert.equal(second.positions[0].displayValues.mark, '10.5');
        assert.equal(second.positions[1].displayValues.mark, null);
        assert.ok(c.OptionComboPortfolioSnapshotCore.issues(second.positions[1]).some(t => t.startsWith('MARK')));
        const missing = plain(O.normalize(answer(raw, first.recognition.reviewCrops, reply, undefined, () => undefined), 'x'));
        assert.ok(missing.positions.every(p => p.displayValues.mark === null), 'a protocol-2 read without readBbox is refused');
    } },
    { name: 'cash keeps its first reading, the reason it is unknown, and joins the batch confirmation', run() {
        const run = cashReply => {
            const c = load(), O = c.OptionComboPortfolioSnapshotOcr, C = c.OptionComboPortfolioSnapshotCore, S = c.OptionComboPortfolioSnapshotSchema;
            const raw = cellRaw([{ desc: 'ABC', qty: '1' }, { desc: 'USD CASH' }]);
            raw.words.push({ text: '100', bbox: [.65, .135, .02, .012] });
            const first = O.normalize(raw, 'x');
            assert.ok(first.recognition.reviewCrops.some(r => r.field === 'marketValue' && Math.abs(r.cropBbox[1] + r.cropBbox[3] / 2 - .141) < .01));
            const reply = (field, row) => row === 1 ? (field === 'marketValue' ? cashReply : null) : stock({ quantity: ['1', '1'] })(field, row);
            const result = O.normalize(answer(raw, first.recognition.reviewCrops, reply), 'x');
            const state = C.applyRecognition(S.empty('x', 't'), result);
            return { C, S, state: plain(state), positionProblems: state.positions.filter(p => C.issues(p).length).length };
        };
        const conflict = run(['100', '101']), cash = conflict.state.cash[0];
        assert.equal(cash.amount, null); assert.equal(cash.originalAmount, '100');
        assert.ok(cash.problem.startsWith('现金金额') && cash.problem.includes('不一致'));
        assert.equal(conflict.C.stats(conflict.state).problems, conflict.positionProblems + 1);
        assert.ok(conflict.C.cashIssues(cash).includes(cash.problem));
        const reviewed = conflict.C.confirmAll(conflict.state, 'now', JSON.stringify(conflict.C.machineChanges(conflict.state)));
        assert.equal(reviewed.cash[0].problem, cash.problem, 'confirming keeps the reason the amount is unknown');
        const silent = run(undefined).state.cash[0];
        assert.ok(silent.amount === null && silent.problem.includes('未收到局部复核答复'));
        const corrected = run(['101', '101']), changes = corrected.C.machineChanges(corrected.state);
        assert.equal(corrected.state.cash[0].amount, '101');
        assert.deepEqual(plain(changes.filter(f => f.field === 'cash.amount').map(f => [f.label, f.before, f.after])), [['USD 现金', '100', '101']]);
        assert.throws(() => corrected.C.confirmAll(corrected.state, 'now', JSON.stringify(changes.filter(f => f.field !== 'cash.amount'))), /机器更改/);
        assert.ok(corrected.C.cashIssues(corrected.state.cash[0]).some(t => t.includes('100 → 101')));
        const back = JSON.parse(corrected.S.serialize(corrected.state));
        assert.deepEqual([back.cash[0].originalAmount, back.cash[0].corrections.length], ['100', 1]);
        const legacy = plain(corrected.state); for (const k of ['originalAmount', 'problem', 'corrections']) delete legacy.cash[0][k];
        assert.equal(corrected.S.validate(legacy).cash[0].amount, '101', 'snapshots exported before cash evidence still import');
        assert.equal(corrected.C.machineChanges(legacy).filter(f => f.field === 'cash.amount').length, 0);
    } },
] };
