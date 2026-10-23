const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
// Synthetic TWS replies and skill-built Portfolio JSON; every expectation is hand-worked
// (tests/fixtures/portfolio_snapshot/tws/expected_*.json), never produced by the module.
const FIXTURES = path.join(__dirname, 'fixtures', 'portfolio_snapshot', 'tws');
const read = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
function setup() {
    const c = loadBrowserScripts(['js/portfolio_snapshot_schema.js', 'js/portfolio_snapshot_core.js', 'js/portfolio_snapshot_tws_model.js']);
    return { S: c.OptionComboPortfolioSnapshotSchema, M: c.OptionComboPortfolioSnapshotTwsModel, C: c.OptionComboPortfolioSnapshotCore };
}
const replies = () => read('tws_replies.json');
function twsFor(M, account = 'U0000001') {
    const r = replies(), result = M.fromTwsReplies(r.positions, r.valuations, account);
    assert.equal(result.ok, true, result.message);
    return result.value;
}
const snapshot = name => read(path.join('snapshots', name + '.json'));
const NOW = '2026-10-22T14:05:00.000Z';

function checkScenario(name) {
    const { S, M } = setup(), expected = read('expected_reports.json')[name];
    const json = S.validate(snapshot(name)), before = JSON.stringify(json);
    const report = plain(M.compareSnapshot(json, twsFor(M), { createdAtUtc: NOW }));
    assert.equal(JSON.stringify(json), before, 'comparing must not modify the snapshot');
    M.validateComparison(report);
    assert.equal(report.verdict, expected.verdict, name + ' verdict');
    assert.equal(report.account.note, expected.accountNote, name + ' account note');
    assert.deepEqual(report.summary, expected.summary, name + ' summary');
    assert.deepEqual(report.rows.map(r => [r.positionId, r.conId, r.match]), expected.rows.map(r => [r.positionId, r.conId, r.match]), name + ' rows');
    for (const [i, want] of expected.rows.entries()) {
        const row = report.rows[i], label = name + ' ' + (want.positionId || want.conId);
        assert.deepEqual(row.candidates, want.candidates || [], label + ' candidates');
        assert.deepEqual(row.differingIdentity, want.differingIdentity || [], label + ' differing identity');
        assert.deepEqual(row.notes, want.notes || [], label + ' notes');
        if (!['exact', 'presumed'].includes(row.match)) { assert.deepEqual(row.fields, [], label + ' has no fields'); continue; }
        const nonSame = Object.fromEntries(row.fields.filter(f => f.result !== 'same').map(f => [f.path, f.result]));
        assert.deepEqual(nonSame, want.nonSame, label + ' field results');
        const quantity = row.fields.find(f => f.path === 'quantity');
        assert.equal(quantity.note === 'sign_opposite', !!want.signOpposite, label + ' sign note');
    }
    const n = report.notCompared, w = expected.notCompared;
    assert.deepEqual([n.comboParents, n.cash, n.groupSummaries, n.unclassified.map(u => u.rowId), n.twsUnsupported.map(u => u.conId)],
        [w.comboParents, w.cash, w.groupSummaries, w.unclassifiedRowIds, w.twsUnsupportedConIds], name + ' not compared');
    return { report, json, S, M };
}

module.exports = { name: 'portfolio snapshot vs TWS positions (read-only comparison)', tests: [
    { stage: 'X0', name: 'X0 the skill-built fixtures import as page JSON and the frozen TWS shape validates', run() {
        const { S, M } = setup(), expected = read('expected_tws_positions.json');
        for (const name of ['consistent', 'partial', 'differences', 'presumed']) {
            const json = S.validate(snapshot(name));
            assert.equal(json.recognition.provider, 'codex-chat-skill');
            assert.ok(json.positions.every(p => Object.values(p.fieldEvidence).every(e => e.source === 'ai')));
        }
        for (const account of ['U0000001', 'U0000002']) assert.equal(M.validateTwsPositions(plain(expected[account])).account, account);
        const good = plain(expected.U0000001);
        const broken = [
            v => { v.schemaVersion = 2; }, v => { v.valuation = 'partial'; }, v => { delete v.positions[0].avgPrice; },
            v => { v.positions[1].conId = 1001; }, v => { v.positions[0].secType = 'CASH'; }, v => { v.positions[1].strike = 40; },
            v => { v.positions[1].quantity = '-2.0'; }, v => { v.positions[1].right = 'PUT'; }, v => { v.positions[1].expiryDate = '20301018'; },
        ];
        for (const breakIt of broken) { const v = plain(good); breakIt(v); assert.throws(() => M.validateTwsPositions(v)); }
    } },
    { stage: 'X0', name: 'X0 a comparison report validates and rejects unknown verdicts, matches and field results', run() {
        const { report, M } = checkScenario('differences');
        for (const breakIt of [r => { r.verdict = 'ok'; }, r => { r.rows[0].match = 'close'; }, r => { r.rows[0].fields[0].result = 'fine'; },
            r => { delete r.summary.twsOnly; }, r => { r.account.note = 'unknown'; }, r => { r.tws.positions[0].quantity = 300; }]) {
            const copy = plain(report); breakIt(copy); assert.throws(() => M.validateComparison(copy));
        }
    } },
    { stage: 'X1', name: 'X1 TWS replies normalize to the hand-worked positions for each account', run() {
        const { M } = setup(), expected = read('expected_tws_positions.json');
        for (const account of ['U0000001', 'U0000002']) {
            const { _note, ...want } = { _note: null, ...expected[account] };
            assert.deepEqual(plain(twsFor(M, account)), want, account);
        }
        assert.deepEqual(plain(twsFor(M, ' u0000001 ')), plain(twsFor(M)), 'account codes are trimmed and case-insensitive');
        const empty = twsFor(M, 'U0000003');
        assert.deepEqual([empty.positions.length, empty.unsupported.length, empty.valuation], [0, 0, 'unavailable']);
    } },
    { stage: 'X1', name: 'X1 unavailable or malformed replies are refused with a reason, never partly used', run() {
        const { M } = setup(), r = replies();
        const reason = (positions, valuations = r.valuations, account = 'U0000001') => M.fromTwsReplies(positions, valuations, account).reason;
        assert.equal(reason(r.variants.notReady), 'positions_not_ready');
        assert.equal(reason(r.variants.disconnected), 'not_connected');
        assert.equal(reason(r.variants.malformedItem), 'reply_invalid');
        assert.equal(reason({ ...r.positions, action: 'portfolio_avg_cost_update' }), 'reply_invalid');
        assert.equal(reason(r.positions, r.valuations, ''), 'account_missing');
        const badExpiry = plain(r.positions); badExpiry.items.find(i => i.conId === 1002).expDate = '20301340';
        assert.equal(reason(badExpiry), 'reply_invalid');
        const badRight = plain(r.positions); badRight.items.find(i => i.conId === 1002).right = 'X';
        assert.equal(reason(badRight), 'reply_invalid');
    } },
    { stage: 'X1', name: 'X1 valuation is optional, merged by account and conId, and never changes quantities', run() {
        const { M } = setup(), r = replies();
        const without = M.fromTwsReplies(r.positions, [], 'U0000001').value, withValues = twsFor(M);
        assert.equal(without.valuation, 'unavailable');
        assert.ok(without.positions.every(p => p.marketPrice === null && p.unrealizedPnl === null));
        assert.deepEqual(without.positions.map(p => [p.conId, p.quantity, p.avgPrice]), withValues.positions.map(p => [p.conId, p.quantity, p.avgPrice]));
        const junk = [{ action: 'portfolio_avg_cost_update', items: [{ account: 'U0000001', conId: 1001, marketPrice: 'NaN?', unrealizedPNL: null }] }];
        assert.equal(M.fromTwsReplies(r.positions, junk, 'U0000001').value.positions[0].marketPrice, null, 'an unreadable price is unavailable, not a reply failure');
    } },
    { stage: 'X1', name: 'X1 normalization does not modify its inputs and is byte-for-byte repeatable', run() {
        const { M } = setup(), r = replies(), before = JSON.stringify(r);
        const first = JSON.stringify(M.fromTwsReplies(r.positions, r.valuations, 'U0000001'));
        assert.equal(JSON.stringify(r), before);
        const shuffled = plain(r); shuffled.positions.items.reverse();
        assert.equal(JSON.stringify(M.fromTwsReplies(shuffled.positions, r.valuations, 'U0000001')), first, 'item order does not matter');
    } },
    { stage: 'X2', name: 'X2 a JSON that agrees with TWS is supported; info prices and TWS-only values never count', run() {
        const { report } = checkScenario('consistent');
        const mark = report.rows[0].fields.find(f => f.path === 'displayValues.mark');
        assert.deepEqual([mark.json, mark.tws, mark.delta, mark.relative], ['42.1', '42.15', '0.05', 0.001186]);
        assert.equal(report.rows[0].fields.find(f => f.path === 'displayValues.avgPrice').source, 'ai');
    } },
    { stage: 'X2', name: 'X2 a partial screenshot is supported; positions only TWS holds are listed for reference only', run() {
        const { report } = checkScenario('partial');
        assert.deepEqual(plain(report.rows.filter(r => r.match === 'tws_only').map(r => r.conId)), [1003, 1006, 1007]);
        assert.ok(report.rows.filter(r => r.match === 'tws_only').every(r => r.fields.length === 0 && r.positionId === null));
    } },
    { stage: 'X2', name: 'X2 TWS-only positions never hide a screenshot difference, and an empty JSON proves nothing', run() {
        const { S, M, C } = setup(), tws = twsFor(M);
        const changed = C.edit(S.validate(snapshot('partial')), 'chat-r1', 'quantity', '30', NOW);
        const report = M.compareSnapshot(changed, tws, { createdAtUtc: NOW });
        assert.deepEqual(plain([report.verdict, report.summary.fieldDifferences, report.summary.twsOnly]), ['differences', 1, 3]);
        const empty = M.compareSnapshot(S.empty('empty', NOW), tws, { createdAtUtc: NOW });
        assert.deepEqual(plain([empty.verdict, empty.summary.twsOnly]), ['no_positions', 7]);
        assert.equal(M.validateComparison(plain(empty)).verdict, 'no_positions');
    } },
    { stage: 'X2', name: 'X2 quantity, sign, missing expiry, duplicates, extra and missing positions are reported', run() {
        const { report } = checkScenario('differences');
        const avg = report.rows.find(r => r.positionId === 'chat-r6').fields.find(f => f.path === 'displayValues.avgPrice');
        assert.deepEqual([avg.json, avg.tws, avg.result], ['0.0512', '0.0512', 'same'], 'an explicit typography reading is compared by its value');
        assert.equal(report.notCompared.unclassified[0].rawText, "QRS Dec'30 ?? 模糊行");
    } },
    { stage: 'X2', name: 'X2 presumed matches need the same symbol; contested candidates stay ambiguous; elimination is noted', run() {
        checkScenario('presumed');
    } },
    { stage: 'X2', name: 'X2 the report does not depend on JSON row order and is repeatable', run() {
        const { S, M } = setup(), tws = twsFor(M);
        for (const name of ['consistent', 'partial', 'differences', 'presumed']) {
            const json = S.validate(snapshot(name)), first = M.compareSnapshot(json, tws, { createdAtUtc: NOW });
            assert.equal(JSON.stringify(M.compareSnapshot(json, tws, { createdAtUtc: NOW })), JSON.stringify(first));
            const reversed = S.clone(json); reversed.positions.reverse();
            const byId = report => Object.fromEntries(report.rows.filter(r => r.positionId).map(r => [r.positionId, [r.conId, r.match, r.candidates]]));
            assert.deepEqual(plain(byId(M.compareSnapshot(reversed, tws, { createdAtUtc: NOW }))), plain(byId(first)), name);
        }
    } },
    { stage: 'X2', name: 'X2 an edit, a different JSON or an exclusion makes the report stale; reviewing does not', run() {
        const { S, M, C } = setup(), tws = twsFor(M);
        const json = S.validate(snapshot('differences')), report = M.compareSnapshot(json, tws, { createdAtUtc: NOW });
        assert.equal(M.isStale(report, json), false);
        assert.equal(M.isStale(report, C.confirm(json, 'chat-r1', NOW)), false, 'confirming a row changes no compared value');
        assert.equal(M.isStale(report, C.edit(json, 'chat-r1', 'quantity', '300', NOW)), true);
        assert.equal(M.isStale(report, S.validate(snapshot('presumed'))), true);
        assert.equal(M.isStale(report, C.excludeRow(json, 'r7', '合成排除', NOW)), true);
        assert.equal(M.isStale(null, json), true);
    } },
    { stage: 'X2', name: 'X2 AVG PRICE follows TWS display rounding: up for a long, down for a short, by at most one shown unit', run() {
        const { S, M, C } = setup(), base = twsFor(M), json = S.validate(snapshot('consistent'));
        // chat-r1 is long 300 (TWS 41.2345); chat-r2 is short 2 (TWS 1.2346). Results worked out by hand.
        const avgResult = (positionId, value, tws = base) => {
            const edited = C.edit(json, positionId, 'displayValues.avgPrice', value, NOW);
            return M.compareSnapshot(edited, tws, { createdAtUtc: NOW }).rows.find(r => r.positionId === positionId)
                .fields.find(f => f.path === 'displayValues.avgPrice').result;
        };
        const cases = [
            ['chat-r1', '41.24', 'within_display_precision'], ['chat-r1', '41.235', 'within_display_precision'],
            ['chat-r1', '41.2345', 'same'], ['chat-r1', '41.23', 'different'], ['chat-r1', '41.25', 'different'], ['chat-r1', '41.234', 'different'],
            ['chat-r2', '1.23', 'within_display_precision'], ['chat-r2', '1.234', 'within_display_precision'],
            ['chat-r2', '1.24', 'different'], ['chat-r2', '1.22', 'different'], ['chat-r2', '1.235', 'different'],
        ];
        for (const [id, value, want] of cases) assert.equal(avgResult(id, value), want, id + ' ' + value);
        // TWS's own 4-place rounding can hide the digit that was rounded up (a long shown 5.432 against TWS 5.431).
        const rounded = S.clone(base); rounded.positions.find(t => t.conId === 1001).avgPrice = '5.431';
        assert.equal(avgResult('chat-r1', '5.432', rounded), 'within_display_precision');
        assert.equal(avgResult('chat-r1', '5.433', rounded), 'different');
        assert.equal(avgResult('chat-r1', '5.430', rounded), 'different');
    } },
    { stage: 'X2', name: 'X2 an edited JSON compares its new values, and manual edits are labelled as manual', run() {
        const { S, M, C } = setup(), tws = twsFor(M);
        const edited = C.edit(S.validate(snapshot('differences')), 'chat-r1', 'quantity', '300', NOW);
        const row = M.compareSnapshot(edited, tws, { createdAtUtc: NOW }).rows[0], quantity = row.fields.find(f => f.path === 'quantity');
        assert.deepEqual([quantity.json, quantity.result, quantity.source], ['300', 'same', 'manual']);
        const blank = C.add(S.validate(snapshot('consistent')), NOW), added = M.compareSnapshot(blank, tws, { createdAtUtc: NOW }).rows.at(-1);
        assert.deepEqual(plain([added.match, added.notes]), ['json_only', ['identity_unknown']], 'a hand-added blank row is never matched');
    } },
] };
