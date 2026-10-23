const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const plain = x => JSON.parse(JSON.stringify(x));
const PROTOCOLS = { 'apple-vision': 1, rapidocr: 2 };

// Exercise the actual asynchronous controller, including its nested catch and
// replacement/commit path. Only the test-loaded copy exposes private state;
// rendering and pixel recognition are stand-ins, not the reply checks under test.
function harness(engine, replies, { existing = true, review = true, onRequest, capabilities } = {}) {
    const elements = new Map(), requests = [], normalized = [];
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false,
            textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {} });
        return elements.get(id);
    };
    element('ocr-engine').value = engine;
    const context = loadBrowserScripts(['js/portfolio_snapshot_schema.js', 'js/portfolio_snapshot_core.js', 'js/portfolio_snapshot_codex.js'], {
        document: { getElementById: element, addEventListener() {}, querySelector() { return null; } },
        location: { protocol: 'http:', origin: 'http://127.0.0.1:8799' },
        crypto: { randomUUID: () => 'controller-test' }, AbortController,
        addEventListener() {}, btoa: text => Buffer.from(text, 'binary').toString('base64'),
        fetch: async (_url, options) => {
            if (!options?.body && capabilities) return {ok:true,json:async()=>plain(capabilities)};
            const request = JSON.parse(options.body), i = requests.length;
            requests.push(request); onRequest?.(i, element);
            assert.ok(i < replies.length, 'unexpected extra request');
            return { ok: true, json: async () => plain(replies[i]) };
        },
    });
    context.OptionComboPortfolioSnapshotOcr = { normalize(raw) {
        normalized.push(plain(raw));
        return { sourceRows: [{ rowId: 'new', sourceId: 'image-1', rowType: 'decoration',
            parentRowId: null, bbox: null, rawText: 'new recognition', rawCells: {} }],
        positions: [], cash: [], accountSummary: {}, recognition: { runId: 'new-run',
            quantityCrops: [], reviewCrops: review && normalized.length === 1
                ? [{ field: 'descriptionRow', cropBbox: [.1, .2, .2, .03] }] : [], warnings: [] } };
    } };
    const source = fs.readFileSync(path.join(__dirname, '../js/portfolio_snapshot.js'), 'utf8');
    const marker = '    g.__portfolioSnapshot = Object.freeze({ getSnapshot: () => S.clone(portfolioSnapshotState) });';
    assert.ok(source.includes(marker), 'controller test hook must match one real export');
    const instrumented = source.replace(marker, `
    renderBulkConfirmation = renderRecognitionControls = renderTable = renderEvidence = select = () => {};
    replacementPreview = async () => { g.__replacementCalls++; return true; };
    g.__replacementCalls = 0;
    g.__replyHarness = {
        setup(snapshot) { portfolioSnapshotState = snapshot; available = true; engines = {[$('ocr-engine').value]:true};
            sourceFile = { arrayBuffer: async () => new Uint8Array([1,2,3]).buffer }; },
        recognize, checkService, getSnapshot: () => S.clone(portfolioSnapshotState), isBusy: () => busy, localIssueLabel
    };
    return;
${marker}`);
    vm.runInContext(instrumented, context, { filename: 'js/portfolio_snapshot.js' });
    const S = context.OptionComboPortfolioSnapshotSchema, C = context.OptionComboPortfolioSnapshotCore;
    let initial = S.empty('saved', 't');
    initial.sources = [{ sourceId: 'image-1', sha256: 'source-hash', width: 1200, height: 900 }];
    initial.account.value = 'U123456'; initial.account.confirmed = true;
    initial.asOf.date = '2030-01-02'; initial.asOf.source = 'manual';
    if (existing) {
        initial = C.add(initial, 't');
        initial = C.edit(initial, initial.positions[0].positionId, 'quantity', '77', 't2');
        initial = C.confirm(initial, initial.positions[0].positionId, 't3');
    }
    initial = plain(initial); context.__replyHarness.setup(initial);
    return { context, element, requests, normalized, initial,
        run: () => context.__replyHarness.recognize(), snapshot: () => plain(context.__replyHarness.getSnapshot()) };
}
function reply(engine, patch = {}) {
    return { engine, reviewProtocol: PROTOCOLS[engine], sourceHash: 'source-hash',
        width: 1200, height: 900, quantityRereads: [], reviewRereads: [], ...patch };
}
function badReplies(engine) {
    const other = engine === 'rapidocr' ? 'apple-vision' : 'rapidocr';
    const missingEngine = reply(engine); delete missingEngine.engine;
    const missingProtocol = reply(engine); delete missingProtocol.reviewProtocol;
    return [reply(other), reply(engine, { reviewProtocol: PROTOCOLS[other] }),
        missingEngine, missingProtocol, reply(engine, { engine: 'unknown' }),
        ...[null, 0, engine === 'local-codex' ? 4 : 3, String(PROTOCOLS[engine]), true].map(reviewProtocol => reply(engine, { reviewProtocol })),
        reply(engine, { sourceHash: 'another-image' }), reply(engine, { width: 1199 }),
        reply(engine, { height: 899 }), null, [], 'not-an-object'];
}
function rejected(h, stage) {
    assert.deepEqual(h.snapshot(), h.initial, 'manual fields, confirmation and previous evidence must remain unchanged');
    assert.equal(h.context.__replacementCalls, 0, 'an invalid reply must not even open the replacement preview');
    assert.match(h.element('message').textContent, new RegExp(stage + '回复校验失败'));
    assert.equal(h.context.__replyHarness.isBusy(), false);
    assert.equal(h.element('cancel-ocr').hidden, true);
}

module.exports = { name: 'portfolio screenshot controller reply binding', tests: [
    { name: 'both supported engines require their own protocol on both requests before committing', async run() {
        for (const engine of Object.keys(PROTOCOLS)) {
            const h = harness(engine, [reply(engine), reply(engine)]);
            await h.run();
            assert.deepEqual(h.requests.map(r => r.engine), [engine, engine]);
            assert.equal(h.normalized.length, 2); assert.equal(h.context.__replacementCalls, 1);
            assert.equal(h.snapshot().recognition.runId, 'new-run');
            assert.equal(h.snapshot().account.value, h.initial.account.value);
            assert.equal(h.snapshot().asOf.date, h.initial.asOf.date);
        }
    } },
    { name: 'first replies with wrong or missing engine/protocol/image never reach normalization or replace a draft', async run() {
        for (const engine of Object.keys(PROTOCOLS)) for (const bad of badReplies(engine)) {
            const h = harness(engine, [bad]); await h.run(); rejected(h, '首轮');
            assert.equal(h.normalized.length, 0); assert.equal(h.requests.length, 1);
        }
    } },
    { name: 'invalid review replies abort the whole run instead of adopting a first-pass fallback', async run() {
        for (const engine of Object.keys(PROTOCOLS)) for (const bad of badReplies(engine)) {
            const h = harness(engine, [reply(engine), bad]); await h.run(); rejected(h, '复核');
            assert.equal(h.normalized.length, 1, 'review payload must be checked before merging or normalization');
            assert.equal(h.requests.length, 2);
        }
    } },
    { name: 'an invalid review cannot create a partial Portfolio on a newly loaded image either', async run() {
        for (const engine of Object.keys(PROTOCOLS)) {
            const h = harness(engine, [reply(engine), reply(engine, { reviewProtocol: null })], { existing: false });
            await h.run(); rejected(h, '复核'); assert.equal(h.snapshot().sourceRows.length, 0);
        }
    } },
    { name: 'a valid first reply without requested crops still requires its selected engine and protocol', async run() {
        for (const engine of Object.keys(PROTOCOLS)) {
            const good = harness(engine, [reply(engine)], { review: false, existing: false });
            await good.run(); assert.equal(good.requests.length, 1); assert.equal(good.normalized.length, 1);
            assert.equal(good.snapshot().recognition.runId, 'new-run');
            const bad = harness(engine, [reply(engine, { reviewProtocol: null })], { review: false });
            await bad.run(); rejected(bad, '首轮');
        }
    } },
    { name: 'Codex uses two bound independent requests and refuses mismatched identities on either reply before adopting', async run() {
        const fields=require('./helpers/load-browser-scripts').loadBrowserScripts(['js/portfolio_snapshot_schema.js']).OptionComboPortfolioSnapshotSchema.FIELDS;
        const values=Object.fromEntries(fields.map(f=>[f.path,null]));Object.assign(values,{'instrument.symbol':'XYZ','instrument.secType':'STK',quantity:'2','displayValues.mark':'3'});
        const good=reply('local-codex',{reviewProtocol:3,reasoningEffort:'high',transport:'app-server-stdio-v2',imageInput:{detail:'original',width:1200,height:900,sha256:'source-hash',byteLength:3,encoding:'source-data-url',verifiedBy:'app-server-user-message'},model:'test',promptVersion:'test',processing:'cloud-via-local-cli',semantic:{tableFound:true,headers:['Instrument','Qty'],notes:[],rows:[{rowId:'r1',rowType:'position',parentRowId:null,description:'XYZ',partial:false,values,cashCurrency:null,cashAmount:null,issues:[]}]}});
        good.runId='first';
        const header={cropId:'c1',rowType:'header',description:'Instrument Qty',values:Object.fromEntries(fields.map(f=>[f.path,null])),cashCurrency:null,cashAmount:null,issues:[]};
        const second={...plain(good),phase:'local-review',firstRunId:'first',runId:'second',promptVersion:'portfolio-local-review-v1',cropMethod:'neutral-text-bands-v1',
            crops:[1,2].map(i=>({cropId:'c'+i,rect:[0,i*50,1200,30],width:1200,height:30,sha256:String(i).repeat(64),byteLength:30,detail:'original'})),
            semantic:{tableFound:true,headers:['Instrument','Qty'],notes:[],rows:[header,{cropId:'c2',rowType:'position',description:'XYZ',values:plain(values),cashCurrency:null,cashAmount:null,issues:[]}]}};
        second.cropInputs=second.crops.map(({sha256,byteLength,detail})=>({sha256,byteLength,detail}));
        const h=harness('local-codex',[good,second]);await h.run();assert.equal(h.requests.length,2);assert.equal(h.requests[1].codexReview.firstRunId,'first');assert.equal(h.snapshot().positions[0].quantity,'2');assert.equal(h.snapshot().recognition.provider,'local-codex');
        assert.equal(h.snapshot().recognition.localReview.status,'compared');
        assert.equal(h.context.__replyHarness.localIssueLabel({rowId:'r1'}),'第 1 条持仓 · XYZ');
        assert.equal(h.snapshot().account.value,h.initial.account.value);assert.equal(h.context.__replacementCalls,1);
        for(const bad of [...badReplies('local-codex'),{...good,reviewProtocol:2}]){const b=harness('local-codex',[bad]);await b.run();rejected(b,'首轮');}
        for(const bad of badReplies('local-codex')){const b=harness('local-codex',[good,bad]);await b.run();rejected(b,'复核');}
        for(const bad of [{...good,reasoningEffort:'low'},{...good,imageInput:{...good.imageInput,detail:'high'}},{...good,imageInput:{...good.imageInput,width:1632}}]){
            const b=harness('local-codex',[bad]);await b.run();assert.deepEqual(b.snapshot(),b.initial);assert.equal(b.context.__replacementCalls,0);assert.match(b.element('message').textContent,/原图发送证明/);assert.equal(b.context.__replyHarness.isBusy(),false);
        }
        for(const bad of [{...second,firstRunId:'stale'},{...second,model:'other'},{...second,reasoningEffort:'low'},{...second,cropInputs:[]}]){
            const b=harness('local-codex',[good,bad]);await b.run();assert.deepEqual(b.snapshot(),b.initial);assert.equal(b.context.__replacementCalls,0);
        }
    } },
    { name: 'a service offering only Codex never automatically changes an offline selection or sends a cloud request', async run() {
        const h=harness('rapidocr',[],{capabilities:{ocrAvailable:true,localOnly:false,loopbackOnly:true,engines:{rapidocr:false,'apple-vision':false,'local-codex':true},engine:null}});
        await h.context.__replyHarness.checkService();assert.equal(h.element('ocr-engine').value,'rapidocr');await h.run();assert.equal(h.requests.length,0);assert.deepEqual(h.snapshot(),h.initial);
    } },
    { name: 'in-flight replies bind to the captured selection, not a changed dropdown or the other engine pair', async run() {
        const h = harness('rapidocr', [reply('rapidocr'), reply('rapidocr')], {
            onRequest(i, element) { if (i === 0) element('ocr-engine').value = 'apple-vision'; } });
        await h.run(); assert.deepEqual(h.requests.map(r => r.engine), ['rapidocr', 'rapidocr']);
        assert.equal(h.snapshot().recognition.runId, 'new-run');
        const bad = harness('rapidocr', [reply('rapidocr'), reply('apple-vision')], {
            onRequest(i, element) { if (i === 0) element('ocr-engine').value = 'apple-vision'; } });
        await bad.run(); rejected(bad, '复核');
    } },
] };
