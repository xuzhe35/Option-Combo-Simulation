const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
function setup() {
    const c = loadBrowserScripts(['js/portfolio_snapshot_schema.js','js/portfolio_snapshot_core.js','js/portfolio_snapshot_codex.js']);
    const S=c.OptionComboPortfolioSnapshotSchema, A=c.OptionComboPortfolioSnapshotCodex, C=c.OptionComboPortfolioSnapshotCore;
    const row=(id,type='position',parent=null)=>({rowId:id,rowType:type,parentRowId:parent,description:type==='position'?'XYZ synthetic contract':type,partial:false,values:Object.fromEntries(S.FIELDS.map(f=>[f.path,null])),cashCurrency:null,cashAmount:null,issues:[]});
    const pos=(id,parent=null)=>{const r=row(id,'position',parent);Object.assign(r.values,{'instrument.symbol':'XYZ','instrument.secType':'OPT','instrument.expiryDate':'2030-01-18','instrument.right':'P','instrument.strike':'100','quantity':'-2','displayValues.mark':'0','displayValues.avgPrice':'1.230','displayValues.displayIv':'25%','displayValues.lastPrice':'c3.20'});return r;};
    const raw=rows=>({engine:'local-codex',reviewProtocol:3,model:'test-model',promptVersion:'test',processing:'cloud-via-local-cli',runId:'r1',reasoningEffort:'high',transport:'app-server-stdio-v2',sourceHash:'synthetic-hash',width:1200,height:900,imageInput:{detail:'original',width:1200,height:900,sha256:'synthetic-hash',byteLength:120,encoding:'source-data-url',verifiedBy:'app-server-user-message'},semantic:{tableFound:true,headers:['Instrument','Position','Mark'],notes:[],rows}});
    return {S,A,C,row,pos,raw};
}
module.exports={name:'independent Codex multimodal extraction',tests:[
    {name:'AI maps raw decimals, explicit zero, IV and LAST qualifiers without fabricated pixel evidence',run(){
        const {A,C,S,pos,raw}=setup(),r=A.normalize(raw([pos('a')]),'image-1'),p=r.positions[0];
        assert.equal(p.quantity,'-2');assert.equal(p.displayValues.mark,'0');assert.equal(p.displayValues.avgPrice,'1.23');assert.equal(p.displayValues.displayIv,'0.25');assert.equal(p.displayValues.lastPrice,null);
        assert.equal(p.fieldEvidence['displayValues.lastPrice'].raw,'c3.20');assert.ok(p.fieldEvidence['displayValues.lastPrice'].problem);
        assert.equal(p.fieldEvidence.quantity.source,'ai');assert.equal(r.sourceRows[0].bbox,null);assert.equal(p.fieldEvidence.quantity.bbox,null);
        assert.equal(r.recognition.reviewCrops.length,0);assert.equal(r.recognition.quantityCrops.length,0);assert.equal(C.applyRecognition(S.empty('s','t'),r).positions.length,1);
        assert.equal(p.reviewStatus,'unreviewed');assert.equal(p.instrument.multiplier,null);
    }},
    {name:'AI refuses missing or downgraded effort and original-image evidence before adoption',run(){
        const {A,pos,raw}=setup();
        for(const patch of [{reasoningEffort:undefined},{reasoningEffort:'low'},{transport:'exec'},{imageInput:undefined}])assert.throws(()=>A.normalize({...raw([pos('a')]),...patch},'i'),/发送证明/);
        for(const patch of [{detail:'high'},{width:1632},{sha256:'other'},{verifiedBy:null},{byteLength:0},{byteLength:4194305},{encoding:'resized'}]){
            const r=raw([pos('a')]);Object.assign(r.imageInput,patch);assert.throws(()=>A.normalize(r,'i'),/发送证明/);
        }
        const good=A.normalize(raw([pos('a')]),'i');assert.equal(good.recognition.reasoningEffort,'high');assert.equal(good.recognition.imageInput.detail,'original');
    }},
    {name:'AI stock cross-check uses displayed precision rather than the shortened canonical number',run(){
        const {A,C,pos,raw}=setup(),r=pos('s');Object.assign(r.values,{'instrument.secType':'STK','instrument.expiryDate':null,'instrument.right':null,'instrument.strike':null,quantity:'100','displayValues.mark':'3.2500','displayValues.marketValue':'325.1'});
        const p=A.normalize(raw([r]),'i').positions[0];assert.ok(C.issues(p).some(x=>x.includes('舍入范围')));assert.equal(p.displayValues.mark,'3.25');
    }},
    {name:'AI arbitrary nested combinations derive atomic legs once and do not depend on a strategy dictionary',run(){
        const {A,row,pos,raw,C,S}=setup(),parent=row('p','combo_summary'),nested=row('q','combo_summary','p');parent.description='Unseen strategy label';
        const result=A.normalize(raw([parent,pos('a','p'),nested,pos('b','q'),pos('c','q'),pos('d')]),'image-1');
        assert.deepEqual(Array.from(result.sourceRows[0].combo.atomicLegRowIds),['a','b','c']);assert.deepEqual(Array.from(result.sourceRows[2].combo.atomicLegRowIds),['b','c']);
        assert.equal(result.positions.length,4);assert.equal(C.applyRecognition(S.empty('s','t'),result).sourceRows.length,6);
    }},
    {name:'AI collapsed or partial combinations preserve uncertainty without inventing legs',run(){
        const {A,row,pos,raw}=setup(),p=row('p','combo_summary');p.partial=true;
        const empty=A.normalize(raw([p]),'image-1');assert.equal(empty.positions.length,0);assert.equal(empty.sourceRows[0].combo.status,'collapsed');assert.equal(empty.recognition.structureIssues.length,1);
        const partial=A.normalize(raw([p,pos('a','p')]),'image-1');assert.equal(partial.positions.length,1);assert.equal(partial.sourceRows[0].combo.status,'incomplete');
    }},
    {name:'AI rejects duplicate, cyclic, future, stale and cash-crossing parents and summary positions',run(){
        const {A,row,pos,raw}=setup();
        const cases=[[pos('a'),pos('a')],[pos('a','p'),row('p','combo_summary')],[row('p','combo_summary','p')],
            [row('p','combo_summary'),pos('a'),pos('b','p')],[row('p','combo_summary'),row('c','cash'),pos('b','p')]];
        for(const rows of cases)assert.throws(()=>A.normalize(raw(rows),'i'),/无法采用/);
        const total=pos('t');total.description='TOTAL synthetic';assert.throws(()=>A.normalize(raw([total]),'i'),/误计/);
    }},
    {name:'AI missing identities and unreadable fields remain visible; account-like text is masked',run(){
        const {A,pos,raw}=setup(),a=pos('a');a.values['instrument.symbol']=null;a.description='U999999 synthetic';
        const r=A.normalize(raw([a]),'i');assert.equal(r.positions.length,0);assert.equal(r.sourceRows[0].rowType,'unclassified');assert.ok(r.recognition.structureIssues.length);assert.doesNotMatch(JSON.stringify(r),/U999999/);
        const b=pos('b');b.values.quantity='?';b.values['displayValues.displayIv']='25';const q=A.normalize(raw([b]),'i').positions[0];assert.equal(q.quantity,null);assert.equal(q.displayValues.displayIv,null);
    }},
    {name:'AI schema, protocol and empty-table failures cannot produce a candidate',run(){
        const {A,pos,raw}=setup();for(const patch of[{engine:'rapidocr'},{reviewProtocol:2},{processing:'offline'}])assert.throws(()=>A.normalize({...raw([pos('a')]),...patch},'i'));
        const r=raw([pos('a')]);r.semantic.rows[0].values.quantity=2;assert.throws(()=>A.normalize(r,'i'));
        const e=raw([]);assert.throws(()=>A.normalize(e,'i'));const f=raw([pos('a')]);f.semantic.tableFound=false;assert.throws(()=>A.normalize(f,'i'));
    }},
    {name:'AI cash is separate, manual account/date survive adoption and correction stays editable',run(){
        const {A,C,S,row,pos,raw}=setup(),cash=row('cash','cash');cash.cashCurrency='USD';cash.cashAmount='1,234.00';
        const r=A.normalize(raw([pos('a'),cash]),'i'),old=S.empty('s','t');old.account.value='U123456';old.asOf.date='2030-01-02';old.asOf.source='manual';
        const next=C.applyRecognition(old,r);assert.equal(next.account.value,'U123456');assert.equal(next.asOf.date,'2030-01-02');assert.equal(next.cash[0].amount,'1234');
        const edit=C.edit(next,next.positions[0].positionId,'quantity','-3','t');assert.equal(edit.positions[0].quantity,'-3');assert.equal(edit.positions[0].fieldEvidence.quantity.raw,'-2');assert.equal(edit.positions[0].fieldEvidence.quantity.source,'manual');
    }},
]};
