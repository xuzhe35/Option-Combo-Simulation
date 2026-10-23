/* Package chat readings with the actual page schema. No OCR, model calls or native transport proofs. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto');
const [repo, output] = process.argv.slice(2);
function check(ok, message) { if (!ok) throw Error(message); }
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const context = vm.createContext({});
for (const file of ['portfolio_snapshot_schema.js', 'portfolio_snapshot_core.js'])
    vm.runInContext(fs.readFileSync(path.join(repo, 'js', file), 'utf8'), context, {filename: file});
const S = context.OptionComboPortfolioSnapshotSchema, C = context.OptionComboPortfolioSnapshotCore;
const draft = JSON.parse(fs.readFileSync(input.draftPath, 'utf8'));
function object(value, allowed, label) {
    check(value && typeof value === 'object' && !Array.isArray(value), label + ': object required');
    check(Object.keys(value).every(k => allowed.includes(k)), label + ': unknown fields');
}
function strings(value) { check(Array.isArray(value) && value.every(s => typeof s === 'string'), 'String array required'); }
object(draft, ['headers', 'notes', 'rows'], 'draft'); strings(draft.headers); strings(draft.notes);
check(draft.headers.length && Array.isArray(draft.rows) && draft.rows.length && draft.rows.length <= S.LIMITS.rows, 'Missing headers/rows or too many rows');
const now = new Date().toISOString(), runId = crypto.randomUUID();
const snapshot = S.empty(crypto.randomUUID(), now);
snapshot.sources = [input.source]; snapshot.sources[0].recognitionRunId = runId;
if (input.account) snapshot.account.value = input.account;
if (input.asof) { S.date(input.asof); snapshot.asOf.date = input.asof; snapshot.asOf.precision = 'date'; snapshot.asOf.source = 'manual'; }
const fieldPaths = S.FIELDS.map(f => f.path), ids = new Set(), active = [], structureIssues = [];
const normalized = (raw, f) => {
    if (raw === null || !raw.trim()) return null;
    let value = raw.trim();
    if (f.kind === 'number' || f.kind === 'percent') {
        if (f.kind === 'percent') check(value.endsWith('%'), 'Missing IV percent unit');
        value = S.decimal(value, f.kind === 'percent');
    } else if (f.kind === 'date') value = S.date(value);
    else if (f.kind === 'type') check(['STK','OPT','FUT','FOP','UNKNOWN'].includes(value), 'Invalid security type');
    else if (f.kind === 'right') check(['C','P'].includes(value), 'Invalid option right');
    if (f.path === 'instrument.symbol') check(/^[A-Z][A-Z0-9./-]{0,30}$/.test(value), 'Unclear symbol characters');
    return value;
};
function read(raw, f) {
    try { return {value: normalized(raw, f), problem: raw === null || !raw.trim() ? f.label + ' 原图未提供或未读出' : null}; }
    catch (error) { return {value: null, problem: f.label + '：' + error.message + '；保留原始读数，待核验'}; }
}
for (const r of draft.rows) {
    object(r, ['rowId','rowType','parentRowId','description','values','partial','issues','cashCurrency','cashAmount','interpretations','rereads'], 'row');
    check(typeof r.rowId === 'string' && /^[\w-]{1,64}$/.test(r.rowId) && !ids.has(r.rowId), 'Duplicate/invalid row ID');
    check(['position','cash','group_summary','combo_summary','unclassified'].includes(r.rowType), 'Invalid row type');
    check(typeof r.description === 'string' && r.description.length <= 16000, 'Description required');
    check(r.partial === undefined || typeof r.partial === 'boolean', 'Invalid partial flag');
    strings(r.issues || []); object(r.values, fieldPaths, 'values');
    const values = Object.fromEntries(fieldPaths.map(k => [k, r.values[k] ?? null]));
    check(Object.values(values).every(v => v === null || typeof v === 'string' && v.length <= 16000), 'Readings must be strings or null');
    const parent = r.parentRowId ?? null;
    if (parent !== null) {
        check(typeof parent === 'string' && active.includes(parent), 'Parent is missing or outside combo scope');
        active.splice(active.indexOf(parent) + 1);
    } else active.length = 0;
    check(!['cash','group_summary'].includes(r.rowType) || parent === null, 'Cash/group cannot be a combo leg');
    if (r.rowType === 'combo_summary') active.push(r.rowId);
    ids.add(r.rowId);
    const row = {rowId:r.rowId, sourceId:'image-1', rowType:r.rowType, parentRowId:parent, bbox:null,
        rawText:r.description, rawCells:{description:r.description, ...values},
        aiEvidence:{method:'codex_chat_visual', localization:'unavailable', partial:r.partial || false, issues:r.issues || []}};
    snapshot.sourceRows.push(row);
    object(r.interpretations || {}, fieldPaths, 'interpretations'); object(r.rereads || {}, fieldPaths, 'rereads');
    if (r.rowType !== 'position') check(!Object.keys(r.interpretations || {}).length && !Object.keys(r.rereads || {}).length, 'Field review belongs to position rows');
    if (r.rowType !== 'cash') check(r.cashCurrency == null && r.cashAmount == null, 'Cash on non-cash row');
    if (r.rowType === 'position') {
        check(!/^\s*(TOTAL\b|[A-Z]{3}\s+CASH\b)/i.test(r.description), 'Summary/cash misclassified as a position');
        const p = C.position('chat-' + r.rowId, r.rowId); p.issues = [...(r.issues || [])];
        for (const f of S.FIELDS) {
            const raw = values[f.path], first = read(raw, f), interpretation = r.interpretations?.[f.path];
            let value = first.value;
            const evidence = {source:'ai', method:'codex_chat_visual', raw, originalValue:first.value,
                recognizedValue:first.value, problem:first.problem, bbox:null, reviewStatus:'unreviewed'};
            if (interpretation) {
                object(interpretation, ['value','reason'], 'interpretation');
                check(['number','percent'].includes(f.kind) && raw !== null && raw.trim() && typeof interpretation.value === 'string'
                    && typeof interpretation.reason === 'string' && interpretation.reason.trim().length >= 2, 'Invalid explicit interpretation');
                check(!(f.path === 'displayValues.lastPrice' && /[a-z]/i.test(raw)), 'LAST qualifiers cannot be stripped');
                value = normalized(interpretation.value, f); check(value !== null, 'Interpretation must have a value');
                evidence.interpretation = {method:'chat_visual_typography', token:raw, value, reason:interpretation.reason};
                evidence.problem = '视觉排版解读，原始文字保留；待人工核验';
            }
            const rereads = r.rereads?.[f.path] || [];
            check(Array.isArray(rereads) && rereads.length <= 8, 'Invalid rereads');
            evidence.visualChecks = rereads.map(v => {
                object(v, ['raw','reason'], 'reread');
                check((v.raw === null || typeof v.raw === 'string') && typeof v.reason === 'string' && v.reason.trim(), 'Invalid reread');
                const second = read(v.raw, f), conflict = second.value !== value || second.value === null && v.raw !== raw;
                if (conflict) p.issues.push(f.label + ' 首读 / 复看不一致：' + (raw ?? '未知') + ' / ' + (v.raw ?? '未知') + '；未覆盖首读');
                return {...v, value:second.value, problem:second.problem, conflict};
            });
            S.set(p, f.path, f.kind === 'type' && value === null ? 'UNKNOWN' : value);
            p.fieldEvidence[f.path] = evidence;
        }
        if (!p.instrument.symbol || p.instrument.secType === 'UNKNOWN') {
            row.rowType = 'unclassified';
            structureIssues.push({rowId:r.rowId, code:'chat_identity_unknown', message:'合约身份未确定，源行保留，未计仓。'});
        } else snapshot.positions.push(p);
    } else if (r.rowType === 'cash') {
        check(r.cashCurrency == null || typeof r.cashCurrency === 'string' && /^[A-Z]{3}$/.test(r.cashCurrency), 'Invalid cash currency');
        check(r.cashAmount == null || typeof r.cashAmount === 'string', 'Cash must be a string/null');
        const amount = read(r.cashAmount ?? null, {kind:'number', label:'现金金额'});
        snapshot.cash.push({sourceRowId:r.rowId, currency:r.cashCurrency ?? null, amount:amount.value, originalAmount:amount.value,
            raw:r.cashAmount ?? null, problem:amount.problem, corrections:[], reviewStatus:'unreviewed', source:'ai'});
    } else if (r.rowType === 'unclassified') structureIssues.push({rowId:r.rowId, code:'chat_unclassified', message:'未确定的源行保留，待人工核验。'});
}
for (const row of snapshot.sourceRows.filter(r => r.rowType === 'combo_summary').reverse()) {
    const children = snapshot.sourceRows.filter(r => r.parentRowId === row.rowId);
    const leaves = snapshot.sourceRows.filter(r => {
        if (r.rowType !== 'position') return false;
        let id = r.parentRowId;
        while (id) { if (id === row.rowId) return true; id = snapshot.sourceRows.find(x => x.rowId === id)?.parentRowId; }
        return false;
    });
    const incomplete = row.aiEvidence.partial || leaves.length < 2 || children.some(r => r.rowType === 'unclassified'
        || r.aiEvidence.partial || r.combo && r.combo.status !== 'expanded_visible');
    row.combo = {childRowIds:children.map(r => r.rowId), atomicLegRowIds:leaves.map(r => r.rowId),
        status:!children.length ? 'collapsed' : incomplete ? 'incomplete' : 'expanded_visible'};
    if (incomplete) structureIssues.push({rowId:row.rowId, code:'chat_partial_combo', message:'组合折叠或可见腿可能不完整，未补造持仓。'});
}
snapshot.recognition = {provider:'codex-chat-skill', model:null, reasoningEffort:null, promptVersion:'tws-screenshot-json-v1',
    status:'needs_review', runId, headers:draft.headers, originalSemantic:draft, structureIssues,
    warnings:['Codex 对话视觉解读；结构校验不证明识别正确；待人工核验。', ...draft.notes],
    imageInput:{sourceSha256:input.source.sha256, sourceWidth:input.source.width, sourceHeight:input.source.height,
        delivery:'chat-attachment', originalDetailVerified:false},
    originalLines:draft.rows.map(r => ({text:r.description})), refinements:[], quantityCrops:[], reviewCrops:[],
    unmatchedRows:snapshot.sourceRows.filter(r => r.rowType === 'unclassified')};
const serialized = S.serialize(snapshot), checked = S.validate(JSON.parse(serialized));
const readable = JSON.stringify(checked, null, 2) + '\n';
check(Buffer.byteLength(readable, 'utf8') <= S.LIMITS.jsonBytes, 'Readable JSON exceeds the existing 32 MiB import limit');
fs.mkdirSync(path.dirname(output), {recursive:true});
fs.writeFileSync(output, readable, {flag:'wx', mode:0o600});
console.log(JSON.stringify({output, ...C.stats(checked), unclassified:checked.sourceRows.filter(r => r.rowType === 'unclassified').length,
    pendingStructure:C.pendingIssues(checked).length, formatValidated:true, visualAccuracyVerified:false}));
