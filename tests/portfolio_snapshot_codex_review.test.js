const assert = require('node:assert/strict');
const {loadBrowserScripts} = require('./helpers/load-browser-scripts');
const plain = x => JSON.parse(JSON.stringify(x));
function fixture() {
    const c = loadBrowserScripts(['js/portfolio_snapshot_schema.js','js/portfolio_snapshot_core.js','js/portfolio_snapshot_codex.js']);
    const S=c.OptionComboPortfolioSnapshotSchema,C=c.OptionComboPortfolioSnapshotCore,A=c.OptionComboPortfolioSnapshotCodex;
    const values=Object.fromEntries(S.FIELDS.map(f=>[f.path,null]));
    Object.assign(values,{'instrument.symbol':'XY','instrument.secType':'FOP','instrument.expiryDate':'2032-02-20','instrument.right':'C','instrument.strike':'145',quantity:'-3','displayValues.deltaDollars':'-12345','displayValues.mark':'0','displayValues.displayIv':'22%'});
    const original={rowId:'p1',rowType:'position',parentRowId:null,description:'XY derivative',partial:false,values,cashCurrency:null,cashAmount:null,issues:[]};
    const proof={engine:'local-codex',reviewProtocol:3,model:'test',reasoningEffort:'high',transport:'app-server-stdio-v2',processing:'cloud-via-local-cli',sourceHash:'source',width:1200,height:900,imageInput:{detail:'original',width:1200,height:900,sha256:'source',byteLength:120,encoding:'source-data-url',verifiedBy:'app-server-user-message'}};
    const first={...plain(proof),promptVersion:'portfolio-multimodal-v2',runId:'first',semantic:{tableFound:true,headers:['Instrument','Position'],notes:[],rows:[original]}};
    const crop=(i,y)=>({cropId:'c'+i,rect:[0,y,1200,30],width:1200,height:30,sha256:String(i).repeat(64),byteLength:30,detail:'original'});
    const header={cropId:'c1',rowType:'header',description:'Instrument Position',values:Object.fromEntries(S.FIELDS.map(f=>[f.path,null])),cashCurrency:null,cashAmount:null,issues:[]};
    const row={cropId:'c2',rowType:'position',description:'XY derivative',values:plain(values),cashCurrency:null,cashAmount:null,issues:[]};
    const review={...plain(proof),phase:'local-review',firstRunId:'first',runId:'second',promptVersion:'portfolio-local-review-v1',cropMethod:'neutral-text-bands-v1',crops:[crop(1,100),crop(2,150)],semantic:{tableFound:true,headers:['Instrument','Position'],notes:[],rows:[header,row]}};
    review.cropInputs=review.crops.map(({sha256,byteLength,detail})=>({sha256,byteLength,detail}));
    return {S,C,A,first,review,row};
}
module.exports={name:'Codex blind local crop comparison',tests:[
    {name:'stock and ETF blanks, optional metadata and unavailable display columns are routine, while required terms depend on type',run(){
        const {A,C,first,review,row}=fixture();
        const values=first.semantic.rows[0].values;
        for(const key of Object.keys(values))values[key]=null;
        Object.assign(values,{'instrument.symbol':'XYZ','instrument.secType':'STK',quantity:'100','displayValues.mark':'12.34⁴','displayValues.avgPrice':'23.45⁴'});
        row.values=plain(values);row.values['displayValues.mark']='12.344';
        let x=A.combine(first,review,'i'),p=x.positions[0];
        assert.equal(p.displayValues.mark,'12.344');assert.equal(p.displayValues.avgPrice,'23.454');
        assert.equal(p.fieldEvidence['displayValues.mark'].raw,'12.34⁴');assert.equal(x.recognition.localReview.conflicts,0);
        assert.deepEqual(Array.from(C.issues(p)),[]);
        assert.equal(C.fieldContext(p,'instrument.expiryDate').required,false);
        assert.equal(C.fieldContext(p,'instrument.currency').required,false);
        values['instrument.secType']='FUT';row.values=plain(values);x=A.combine(first,review,'i');
        assert.deepEqual(Array.from(C.issues(x.positions[0])),['期货到期日未确认']);
        values['instrument.expiryDate']='2032-02-20';row.values=plain(values);x=A.combine(first,review,'i');assert.equal(C.issues(x.positions[0]).length,0);
        for(const type of ['OPT','FOP']){
            values['instrument.secType']=type;values['instrument.expiryDate']=null;row.values=plain(values);p=A.combine(first,review,'i').positions[0];
            assert.deepEqual(Array.from(C.issues(p)),['到期日未确认','Call / Put 截断或未确认','行权价未确认']);
        }
    }},
    {name:'only explicit price-tail typography is accepted; exponents, qualifiers, missing decimals and non-price fields remain invalid',run(){
        const {S}=fixture();
        for(const path of ['displayValues.mark','displayValues.avgPrice','displayValues.lastPrice']){
            const field=S.FIELDS.find(f=>f.path===path);
            for(const [raw,value] of [['12.34⁴','12.344'],['23.45⁴','23.454'],['−1,234.50⁰','-1234.5'],['0.00¹²','0.0012']])assert.equal(S.fieldDecimal(raw,field),value);
            for(const raw of ['12³','12.3⁴','12.³⁴','12.34^4','12.34 ⁴','12.34⁻⁴','12.34⁴x','c12.34⁴','M12.34⁴'])assert.throws(()=>S.fieldDecimal(raw,field),raw);
        }
        for(const path of ['quantity','instrument.strike','instrument.multiplier','displayValues.marketValue','displayValues.displayIv'])
            assert.throws(()=>S.fieldDecimal('12.34⁴',S.FIELDS.find(f=>f.path===path)),path);
        assert.throws(()=>S.decimal('12.34⁴'),'the generic decimal contract remains strict');
    }},
    {name:'price typography equivalence removes historical JSON noise without mutating any value or evidence, but real disagreements remain',run(){
        const {A,C,S,first,review,row}=fixture();
        first.semantic.rows[0].values['displayValues.mark']='12.344';row.values['displayValues.mark']='12.34⁴';
        row.values['instrument.strike']='146';row.values.quantity='3';
        const x=A.combine(first,review,'i');assert.equal(x.recognition.localReview.conflicts,2);
        const snapshot=C.applyRecognition(S.empty('s','t'),x),p=snapshot.positions[0],e=p.fieldEvidence['displayValues.mark'];
        e.localCheck='conflict';e.localReread.value=null;e.localReread.problem='旧版本无法解析上标';
        snapshot.recognition.localReviewIssues.push({rowId:'p1',code:'ai_local_conflict',field:'displayValues.mark',firstRaw:e.raw,localRaw:e.localReread.raw,message:'旧版本冲突'});
        const before=JSON.stringify(snapshot);
        assert.equal(C.localCheck(p,'displayValues.mark'),'agreed');assert.equal(C.pendingIssues(snapshot).length,2);
        assert.equal(C.issues(p).some(t=>t.startsWith('MARK')),false);
        assert.equal(JSON.stringify(snapshot),before,'reading old evidence never rewrites it');
        e.interpretation={method:'chat_visual_typography',token:'12.34⁴',value:'12.344'};
        assert.equal(C.machineChanges(snapshot).length,0);
        p.displayValues.mark='12.345';assert.equal(C.machineChanges(snapshot).length,1);assert.equal(C.localCheck(p,'displayValues.mark'),'conflict');
        e.interpretation.token='-12.34⁴';p.displayValues.mark='12.344';assert.equal(C.machineChanges(snapshot).length,1);
    }},
    {name:'blank placeholders do not create local conflicts or zeros, but a missing first price with a real second value remains a conflict',run(){
        const {A,C,first,review,row}=fixture();row.values['instrument.currency']='—';row.values['displayValues.theta']='N/A';
        const x=A.combine(first,review,'i');assert.equal(x.recognition.localReview.conflicts,0);assert.equal(x.positions[0].displayValues.theta,null);
        first.semantic.rows[0].values['displayValues.mark']=null;row.values['displayValues.mark']='0';
        const y=A.combine(first,review,'i');assert.equal(y.positions[0].displayValues.mark,null);assert.equal(y.recognition.localReview.conflicts,1);
        assert.ok(C.issues(y.positions[0]).some(t=>t.startsWith('MARK')&&t.includes('冲突')));
    }},
    {name:'formatting equivalence keeps stock rounding checks at all visible digits and never hides invalid optional data',run(){
        const {A,C,first,review,row}=fixture(),v=first.semantic.rows[0].values;
        Object.assign(v,{'instrument.secType':'STK','instrument.expiryDate':null,'instrument.right':null,'instrument.strike':null,quantity:'100','displayValues.mark':'12.34⁴','displayValues.marketValue':'1234.40'});
        row.values=plain(v);let p=A.combine(first,review,'i').positions[0];assert.equal(C.issues(p).some(t=>t.includes('舍入')),false);
        p.displayValues.marketValue='1234.60';assert.ok(C.issues(p).some(t=>t.includes('舍入')));
        v['displayValues.lastPrice']='?';row.values=plain(v);p=A.combine(first,review,'i').positions[0];assert.ok(C.issues(p).some(t=>t.startsWith('LAST')));
        p.instrument.expiryDate='2032-02-20';assert.ok(C.issues(p).some(t=>t.includes('矛盾')));
    }},
    {name:'local identity and number conflicts retain both readings without changing any first value',run(){
        const {A,C,S,first,review,row}=fixture();row.values['instrument.strike']='146';row.values['displayValues.deltaDollars']='-12346';
        const before=JSON.stringify(first);const x=A.combine(first,review,'image-1');const p=x.positions[0];
        assert.equal(JSON.stringify(first),before);assert.equal(p.instrument.strike,'145');assert.equal(p.displayValues.deltaDollars,'-12345');
        assert.equal(p.fieldEvidence['instrument.strike'].raw,'145');assert.equal(p.fieldEvidence['instrument.strike'].localReread.raw,'146');
        assert.equal(p.fieldEvidence['instrument.strike'].localCheck,'conflict');assert.equal(x.recognition.localReview.conflicts,2);
        assert.equal(p.fieldEvidence.quantity.localCheck,'agreed');assert.equal(p.fieldEvidence['displayValues.mark'].localCheck,'agreed');
        assert.equal(x.recognition.originalSemantic.rows[0].values['instrument.strike'],'145');
        let snapshot=C.applyRecognition(S.empty('s','t'),x);assert.equal(C.pendingIssues(snapshot).length,2);
        snapshot=C.confirmAll(snapshot,'t');assert.equal(snapshot.review.status,'needs_review');
        assert.ok(C.issues(snapshot.positions[0]).some(x=>x.includes('冲突')));
        const copy=JSON.parse(S.serialize(snapshot));S.validate(copy);assert.equal(copy.positions[0].fieldEvidence['instrument.strike'].localReread.raw,'146');
        snapshot=C.edit(snapshot,p.positionId,'instrument.strike','146','t2');assert.equal(C.pendingIssues(snapshot).length,1);
        assert.equal(snapshot.positions[0].fieldEvidence['instrument.strike'].raw,'145');
        assert.equal(snapshot.positions[0].fieldEvidence['instrument.strike'].localReread.raw,'146');
        for(const issue of C.pendingIssues(snapshot)) snapshot=C.acceptIssue(snapshot,issue,'已看原图，保留当前值','t3');
        snapshot=C.confirmAll(snapshot,'t4');assert.equal(snapshot.review.status,'reviewed');
    }},
    {name:'blank, invalid LAST and lost signs never get silently replaced by a local value',run(){
        const {A,first,review,row}=fixture();first.semantic.rows[0].values.quantity=null;
        first.semantic.rows[0].values['displayValues.lastPrice']='c12.3';row.values['displayValues.lastPrice']='12.3';
        const x=A.combine(first,review,'i');assert.equal(x.positions[0].quantity,null);assert.equal(x.positions[0].displayValues.lastPrice,null);
        assert.equal(x.recognition.localReview.conflicts,2);assert.equal(x.positions[0].fieldEvidence['instrument.currency'].localCheck,'agreed_unknown');
        assert.equal(x.positions[0].fieldEvidence['displayValues.lastPrice'].localReread.value,'12.3');
    }},
    {name:'missing, extra or reclassified body rows leave all local readings unassociated',run(){
        for(const mutation of [r=>r.semantic.rows[1].rowType='outside_table',r=>r.semantic.rows[1].rowType='combo_summary',r=>r.semantic.rows[1].rowType='unclassified',r=>r.semantic.tableFound=false]){
            const {A,first,review}=fixture();mutation(review);
            // outside-table may not smuggle holding values into the row alignment.
            if(review.semantic.rows[1].rowType==='outside_table')Object.keys(review.semantic.rows[1].values).forEach(k=>review.semantic.rows[1].values[k]=null);
            const x=A.combine(first,review,'i');assert.equal(x.recognition.localReview.status,'alignment_unavailable');assert.equal(x.recognition.localReview.rowMapping.length,0);
            assert.equal(x.positions[0].instrument.strike,'145');assert.equal(x.positions[0].fieldEvidence.quantity.localReread,undefined);
            assert.ok(x.recognition.localReviewIssues.some(i=>i.code==='ai_local_unavailable'));
        }
    }},
    {name:'mismatched engine model protocol source first run and crop provenance are rejected',run(){
        for(const patch of [{engine:'rapidocr'},{reviewProtocol:2},{model:'other'},{sourceHash:'other'},{firstRunId:'stale'},{reasoningEffort:'low'},{phase:'other'},{promptVersion:'unknown'}]){
            const {A,first,review}=fixture();Object.assign(review,patch);assert.throws(()=>A.combine(first,review,'i'));
        }
        for(const mutate of [r=>r.crops[1].rect[1]=110,r=>r.crops[1].rect[2]=1199,r=>r.crops[1].rect[3]=900,
            r=>r.crops[1].sha256='x'.repeat(64),r=>r.cropInputs[1].sha256='a'.repeat(64),r=>r.semantic.rows.reverse(),
            r=>r.semantic.rows.pop(),r=>r.semantic.rows[1].values.quantity=3,r=>r.crops[1].cropId=r.crops[0].cropId]){
            const {A,first,review}=fixture();mutate(review);assert.throws(()=>A.combine(first,review,'i'));
        }
    }},
    {name:'local review keeps arbitrary combo legs and cash separate and never overwrites cash conflicts',run(){
        const {A,C,S,first,review}=fixture(),pos=first.semantic.rows[0];
        const parent={...plain(pos),rowId:'combo',rowType:'combo_summary',description:'Novel strategy',values:Object.fromEntries(S.FIELDS.map(f=>[f.path,null]))};
        pos.parentRowId='combo';const leg={...plain(pos),rowId:'p2'};leg.values.quantity='3';
        const cash={...plain(parent),rowId:'cash',rowType:'cash',description:'ZZZ CASH',cashCurrency:'ZZZ',cashAmount:'1000'};
        first.semantic.rows=[parent,pos,leg,cash];
        review.semantic.rows=[review.semantic.rows[0],...first.semantic.rows.map((r,i)=>({cropId:'c'+(i+2),rowType:r.rowType,description:r.description,values:plain(r.values),cashCurrency:r.cashCurrency,cashAmount:r.cashAmount,issues:[]}))];
        review.semantic.rows.at(-1).cashAmount='1001';
        review.crops=review.semantic.rows.map((r,i)=>({cropId:r.cropId,rect:[0,50+i*50,1200,30],width:1200,height:30,sha256:String(i+1).repeat(64),byteLength:30,detail:'original'}));
        review.cropInputs=review.crops.map(({sha256,byteLength,detail})=>({sha256,byteLength,detail}));
        const x=A.combine(first,review,'i');assert.equal(x.positions.length,2);assert.equal(x.cash[0].amount,'1000');assert.equal(x.cash[0].localReread.raw,'1001');
        assert.deepEqual(Array.from(x.sourceRows[0].combo.atomicLegRowIds),['p1','p2']);
        const snapshot=C.applyRecognition(S.empty('s','t'),x);assert.equal(C.pendingIssues(snapshot).length,1);assert.equal(snapshot.recognition.structureIssues.length,0);
    }},
    {name:'canonical agreement retains raw punctuation and an identical invalid qualifier never becomes numeric proof',run(){
        const {A,first,review,row}=fixture();row.values['instrument.strike']='145.00';row.values['displayValues.deltaDollars']='-12,345';
        first.semantic.rows[0].values['displayValues.lastPrice']='M12.3';row.values['displayValues.lastPrice']='M12.3';
        const x=A.combine(first,review,'i'),p=x.positions[0];assert.equal(p.fieldEvidence['instrument.strike'].localCheck,'agreed');
        assert.equal(p.fieldEvidence['instrument.strike'].localReread.raw,'145.00');assert.equal(p.fieldEvidence['displayValues.deltaDollars'].localCheck,'agreed');
        assert.equal(p.displayValues.lastPrice,null);assert.equal(p.fieldEvidence['displayValues.lastPrice'].localCheck,'unavailable');
        const original=A.normalize(first,'i').positions[0];assert.deepEqual(plain(p.instrument),plain(original.instrument));assert.deepEqual(plain(p.displayValues),plain(original.displayValues));
    }},
]};
