const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const load = () => loadBrowserScripts(['js/portfolio_snapshot_schema.js', 'js/portfolio_snapshot_core.js', 'js/portfolio_snapshot_ocr.js']);
const plain = x => JSON.parse(JSON.stringify(x));
// Independent synthetic words/boxes, not production-derived recognition answers.
function image(rows) {
    const words = require('./helpers/portfolio-snapshot-header')();
    rows.forEach((row, i) => {
        let x = row.indent ?? .10;
        const y = .10 + i * .035;
        for (const text of row.desc.split(' ')) {
            const width = text.length * .0026;
            words.push({ text, bbox: [x, y, width, .012], lineId: i + 1 }); x += width + .003;
        }
        if (row.qty != null) words.push({text:row.qty,bbox:[.44,y,.02,.012],lineId:1000+i});
    });
    return { words, lines: [], engine:'synthetic', model:'unrelated-fixture' };
}
function normalize(rows) {
    const c = load(), r = c.OptionComboPortfolioSnapshotOcr.normalize(image(rows), 'a');
    c.OptionComboPortfolioSnapshotCore.applyRecognition(c.OptionComboPortfolioSnapshotSchema.empty('a','t'), r);
    return plain(r);
}
const call = (strike, expiry="Oct21'30") => `XYZ ${expiry} ${strike} CALL`;
const put = (strike, expiry="Oct21'30") => `XYZ ${expiry} ${strike} PUT`;
function family(name, legs) {
    const rows = [{desc:'XYZ '+name,qty:'99'}, ...legs.map(([desc,qty])=>({desc,qty,indent:.112})), {desc:'PEER',qty:'7'}];
    const r = normalize(rows), parent = r.sourceRows[0];
    assert.equal(parent.rowType,'combo_summary');
    assert.equal(parent.combo.status,'expanded_visible');
    assert.equal(parent.combo.expectedLegCount,null);
    assert.equal(parent.combo.atomicLegRowIds.length, legs.length);
    assert.equal(r.positions.length,legs.length+1);
    assert.deepEqual(r.positions.slice(0,-1).map(p=>p.quantity),legs.map(l=>l[1]));
    assert.equal(r.sourceRows.at(-1).parentRowId,null, 'ordinary peer must close the preceding combo');
    assert.ok(r.positions.every(p=>!p.sourceRowIds.includes(parent.rowId)), 'parent never becomes an extra position');
    return r;
}
module.exports = { name:'portfolio OCR crop consensus and general hierarchy', tests:[
    {name:'crop geometry repairs a noisy child origin and FOP bracket from pixels without ticker or strategy rules',run(){
        for(const base of [.10,.13]){
            const c=load(),raw=image([{desc:'ALPHA AuroraPack',qty:'90',indent:base},
                {desc:"ALPHA FOP (Z7] Oct21'30 40 PUT",qty:'5',indent:base+.0068},
                {desc:"ALPHA FOP (Z7) Oct21'30 45 PUT",qty:'-5',indent:base+.0035},
                {desc:"ALPHA FOP (Z7) Oct21'30 50 PUT",qty:'5',indent:base}]);
            raw.rereads=[2,3].map(lineId=>({lineId,passes:[2,3].map(scale=>({scale,words:raw.words.filter(w=>w.lineId===lineId).map(w=>{
                const next=plain(w); if(next.text==='(Z7]')next.text='(Z7)';
                if(lineId===3&&next.text==='ALPHA')next.bbox[0]=base+(scale===2?.0066:.0069);
                next.inkBbox=plain(next.bbox);
                return next;
            })}))}));
            const r=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a');
            assert.deepEqual(plain(r.sourceRows[0].combo.atomicLegRowIds),['row-2','row-3']);
            assert.equal(r.sourceRows[2].parentRowId,'row-1');assert.equal(r.sourceRows[3].parentRowId,null);
            assert.equal(r.positions.length,3);assert.deepEqual(plain(r.recognition.structureIssues),[]);
            assert.equal(r.positions[0].instrument.secType,'FOP');assert.equal(r.positions[0].instrument.tradingClass,'Z7');
            assert.match(r.sourceRows[1].rawCells.description,/\(Z7\]/);
            assert.match(r.sourceRows[1].normalizedCells.description,/\(Z7\)/);
            assert.equal(r.positions[0].fieldEvidence['instrument.tradingClass'].originalValue,null);
            assert.equal(r.positions[0].fieldEvidence['instrument.tradingClass'].corrections[0].passes.length,2);
            const geometry=r.sourceRows[2].hierarchyEvidence.indentMeasurement;
            assert.equal(geometry.method,'aligned_crop_ink_geometry');assert.equal(geometry.originalBbox[0],base+.0035);
            assert.equal(geometry.passes.length,2);assert.equal(raw.words.find(w=>w.lineId===3).bbox[0],base+.0035);
            const s=c.OptionComboPortfolioSnapshotCore.applyRecognition(c.OptionComboPortfolioSnapshotSchema.empty('a','t'),r);
            assert.equal(c.OptionComboPortfolioSnapshotSchema.validate(s).sourceRows[2].parentRowId,'row-1');
        }
    }},
    {name:'uncertain, dispersed, single-scale, mismatched and displaced crop origins cannot adopt a neighboring peer',run(){
        for(const mode of ['boundary','dispersion','one-pass','duplicate-scale','different-text','far-shift','wrong-row','no-ink']){
            const c=load(),raw=image([{desc:'ALPHA AuroraPack',qty:'90'},
                {desc:put(40),qty:'5',indent:.1068},{desc:'ALPHA',qty:'-5',indent:.1035}]);
            const word=raw.words.find(w=>w.lineId===3), crop={lineId:3,passes:[2,3].map(scale=>({scale,words:[{...plain(word),bbox:[scale===2?.1066:.1069,.17,.013,.012]}]}))};
            raw.rereads=[crop];
            if(mode==='boundary'){crop.passes[0].words[0].bbox[0]=.1038;crop.passes[1].words[0].bbox[0]=.1042;}
            if(mode==='dispersion'){crop.passes[0].words[0].bbox[0]=.1063;crop.passes[1].words[0].bbox[0]=.1077;}
            if(mode==='one-pass')crop.passes.pop();
            if(mode==='duplicate-scale')crop.passes[1].scale=2;
            if(mode==='different-text')crop.passes[1].words[0].text='ALPHB';
            if(mode==='far-shift')for(const p of crop.passes)p.words[0].bbox[0]=.110;
            if(mode==='wrong-row')for(const p of crop.passes)p.words[0].bbox[1]=.135;
            if(mode!=='no-ink')for(const p of crop.passes)p.words[0].inkBbox=plain(p.words[0].bbox);
            const r=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a');
            assert.equal(r.sourceRows[2].parentRowId,null,mode);
            assert.equal(r.sourceRows[0].combo.atomicLegRowIds.length,1,mode);
            if(mode==='boundary')assert.ok(r.recognition.structureIssues.some(s=>s.code==='indentation_uncertain'));
        }
    }},
    {name:'expanded OCR rectangles cannot erase an indentation confirmed by actual glyph edges',run(){
        const c=load(),raw=image([{desc:'ALPHA AuroraPack',qty:'90'},
            {desc:'ALPHA',qty:'5',indent:.1068},{desc:'OMEGA',qty:'-5',indent:.1068}]);
        raw.rereads=[2,3].map(lineId=>({lineId,passes:[2,3].map(scale=>({scale,words:raw.words.filter(w=>w.lineId===lineId).map(w=>({...plain(w),
            bbox:[.1028,w.bbox[1],.017,w.bbox[3]],inkBbox:[.1068,w.bbox[1],.013,w.bbox[3]]}))}))}));
        const r=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a');
        assert.equal(r.sourceRows[0].combo.atomicLegRowIds.length,2);
        assert.ok(r.sourceRows.slice(1).every(row=>row.parentRowId==='row-1'));
    }},
    {name:'FOP marker stays known but malformed class remains unresolved without agreeing contextual pixel reads',run(){
        for(const mode of ['no-reads','disagree','wrong-context','unclosed','strategy-class']){
            const c=load(),raw=image([{desc:mode==='wrong-context'?"ALPHA (Z7] Oct21'30 40 PUT":mode==='unclosed'?"ALPHA FOP (Z7 Oct21'30 40 PUT":mode==='strategy-class'?"ALPHA FOP (RATIO] Oct21'30 40 PUT":"ALPHA FOP (Z7] Oct21'30 40 PUT",qty:'1'}]);
            if(['disagree','wrong-context'].includes(mode))raw.rereads=[{lineId:1,passes:[2,3].map(scale=>({scale,words:raw.words.filter(w=>w.lineId===1).map(w=>({...plain(w),text:w.text==='(Z7]'?(mode==='disagree'&&scale===3?'(Z8)':'(Z7)'):w.text}))}))}];
            const r=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a'), p=r.positions[0];
            assert.equal(r.positions.length,1,mode);assert.equal(p.instrument.tradingClass,null,mode);
            assert.equal(p.instrument.secType,mode==='wrong-context'?'OPT':'FOP',mode);
            if(mode!=='wrong-context')assert.ok(p.issues.some(s=>s.includes('FOP')));
        }
        assert.deepEqual(normalize([{desc:'FOP',qty:'1'}]).positions[0].issues,[]);
        assert.equal(normalize([{desc:"ALPHA FOP (6E) Oct21'30 40 PUT",qty:'1'}]).positions[0].instrument.tradingClass,'6E');
        assert.equal(normalize([{desc:"ALPHA NOTE FOP (Z7) Oct21'30 40 PUT",qty:'1'}]).positions[0].instrument.tradingClass,null);
        const c=load(),raw=image([{desc:"ALPHA FOP (6E] Oct21'30 40 PUT",qty:'1'}]);
        raw.rereads=[{lineId:1,passes:[2,3].map(scale=>({scale,words:raw.words.filter(w=>w.lineId===1).map(w=>({...plain(w),text:w.text==='(6E]'?'(6E)':w.text}))}))}];
        assert.equal(c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a').positions[0].instrument.tradingClass,'6E');
    }},
    {name:'empty quantity cells accept aligned independent-scale pixel reads, retaining missing first-pass evidence',run(){
        for (const quantity of ['1','-1','2','-12','0','0.25']) {
            const c=load(), raw=image([{desc:"XYZ Dec18'30 @CME",qty:null}]);
            raw.quantityRereads=[{field:'quantity',cropBbox:[.415,.097,.052,.019],passes:[3,4].map(scale=>({scale,words:[{text:quantity,bbox:[.445,.1,.018,.01]}]}))}];
            const r=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a'), p=r.positions[0];
            assert.equal(p.quantity,quantity);assert.equal(p.instrument.secType,'FUT');
            assert.equal(p.fieldEvidence.quantity.originalValue,null);assert.equal(p.fieldEvidence.quantity.raw,null);
            assert.equal(p.fieldEvidence.quantity.corrections[0].method,'quantity_crop_consensus');
            assert.equal(p.fieldEvidence.quantity.corrections[0].passes.length,2);
            assert.equal(r.sourceRows[0].rawCells.quantity,undefined);
            assert.equal(p.reviewStatus,'unreviewed');
            const s=c.OptionComboPortfolioSnapshotCore.applyRecognition(c.OptionComboPortfolioSnapshotSchema.empty('a','t'),r);
            assert.equal(c.OptionComboPortfolioSnapshotSchema.validate(s).positions[0].quantity,quantity);
        }
    }},
    {name:'quantity reread disagreement, neighboring totals, wrong cells, duplicates and invalid signs do not fill missing numbers',run(){
        for (const mode of ['disagree','one-pass','same-scale','bad-text','blank','wrong-column','wrong-row','wrong-crop','neighbor-total','duplicate-crop','invalid-original','existing-original']) {
            const c=load(), raw=image([{desc:"XYZ Dec18'30 @CME",qty:mode==='invalid-original'?'l':mode==='existing-original'?'-2':null}]);
            const crop={field:'quantity',cropBbox:[.415,.097,.052,.019],passes:[3,4].map(scale=>({scale,words:[{text:'1',bbox:[.445,.1,.018,.01]}]}))};
            raw.quantityRereads=[crop];
            if(mode==='disagree')crop.passes[1].words[0].text='-1';
            if(mode==='one-pass')crop.passes.pop();
            if(mode==='same-scale')crop.passes[1].scale=3;
            if(mode==='bad-text')for(const p of crop.passes)p.words[0].text='l';
            if(mode==='blank')for(const p of crop.passes)p.words=[];
            if(mode==='wrong-column')for(const p of crop.passes)p.words[0].bbox[0]=.49;
            if(mode==='wrong-row')for(const p of crop.passes)p.words[0].bbox[1]=.06;
            if(mode==='wrong-crop')crop.cropBbox[0]=.49;
            if(mode==='neighbor-total'){crop.cropBbox[1]=.06;for(const p of crop.passes)p.words[0].bbox[1]=.061;}
            if(mode==='duplicate-crop')raw.quantityRereads.push(plain(crop));
            const p=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a').positions[0];
            assert.equal(p.quantity,mode==='existing-original'?'-2':null,mode);
            assert.equal(p.fieldEvidence.quantity.corrections.length,0,mode);
        }
    }},
    {name:'two, three, four and six leg families preserve signed quantities without parent double-counting',run(){
        family('Vertical',[[call(50),'2'],[call(55),'-2']]);
        family('Straddle',[[call(50),'3'],[put(50),'3']]);
        family('Strangle',[[put(45),'-4'],[call(55),'-4']]);
        family('Butterfly',[[call(45),'1'],[call(50),'-2'],[call(55),'1']]);
        family('IronCondor',[[put(40),'1'],[put(45),'-1'],[call(55),'-1'],[call(60),'1']]);
        family('Calendar',[[call(50),'-2'],[call(50,"Nov21'30"),'2']]);
        family('CoveredCall',[['XYZ','100'],[call(55),'-1']]);
        family('Ratio',[[call(50),'1'],[call(55),'-3']]);
        family('NebulaPack',[[put(35),'1'],[put(40),'-2'],[call(50),'3'],[call(55),'-4'],[call(60),'5'],[put(65),'-6']]);
    }},
    {name:'unknown strategy labels are inferred from hierarchy, not a Bear/Spread name dictionary',run(){
        const r=family('UnseenRecipe',[ [put(40),'1'],[put(45),'-2'],[call(60),'1'] ]);
        assert.equal(r.sourceRows[0].hierarchyEvidence.reason,'indented_children');
        assert.deepEqual(r.recognition.structureIssues,[]);
        const wordsOnly=family('Unseen CALL Package',[[put(40),'1'],[put(45),'-2'],[call(60),'1']]);
        assert.equal(wordsOnly.sourceRows[0].hierarchyEvidence.reason,'indented_children');
    }},
    {name:'nested combos keep each atomic leg once and end at the next peer',run(){
        const r=normalize([{desc:'XYZ Package',qty:'99'},
            {desc:'XYZ FirstPack',qty:'88',indent:.112},
            {desc:put(40),qty:'1',indent:.124},{desc:put(45),qty:'-1',indent:.124},
            {desc:'XYZ SecondPack',qty:'77',indent:.112},
            {desc:call(55),qty:'-2',indent:.124},{desc:call(60),qty:'2',indent:.124},
            {desc:'PEER',qty:'9'}]);
        assert.equal(r.positions.length,5);
        assert.equal(r.sourceRows[0].combo.atomicLegRowIds.length,4);
        assert.equal(r.sourceRows[4].parentRowId,r.sourceRows[0].rowId);
        assert.equal(r.sourceRows.at(-1).parentRowId,null);
        assert.equal(new Set(r.positions.flatMap(p=>p.sourceRowIds)).size,5);
    }},
    {name:'collapsed and one-visible-leg combos are explicit partial coverage, never fabricated positions',run(){
        const collapsed=normalize([{desc:'XYZ Iron Condor',qty:'99'}]);
        assert.equal(collapsed.positions.length,0);
        assert.equal(collapsed.sourceRows[0].combo.status,'collapsed');
        assert.equal(collapsed.recognition.structureIssues[0].code,'combo_collapsed');
        const one=normalize([{desc:'XYZ Calendar',qty:'99'},{desc:call(50),qty:'-2',indent:.112}]);
        assert.equal(one.positions.length,1); assert.equal(one.sourceRows[0].combo.status,'incomplete');
    }},
    {name:'unindented neighbors are not silently linked to a collapsed combo',run(){
        const r=normalize([{desc:'XYZ Straddle',qty:'99'},{desc:call(50),qty:'1'},{desc:put(50),qty:'1'}]);
        assert.equal(r.positions.length,2);
        assert.ok(r.sourceRows.slice(1).every(r=>r.parentRowId===null));
        assert.equal(r.sourceRows[0].combo.status,'collapsed');
    }},
    {name:'a slash date is not a multi-strike strategy and ambiguous stock parents stay unresolved',run(){
        const r=normalize([{desc:'XYZ 10/21/2030 50 CALL',qty:'2'}]);
        assert.equal(r.sourceRows[0].rowType,'position');
        const ambiguous=normalize([{desc:'XYZ',qty:'100'},{desc:call(50),qty:'-1',indent:.112}]);
        assert.equal(ambiguous.sourceRows[0].rowType,'unclassified');
        assert.equal(ambiguous.recognition.structureIssues[0].code,'row_role_ambiguous');
    }},
    {name:'strategy-like ticker names and trading classes are not treated as strategy instructions',run(){
        const r=normalize([{desc:'BAG',qty:'3'},{desc:'CALL',qty:'4'},{desc:'RATIO',qty:'5'},
            {desc:"CALL Oct21'30 55 PUT",qty:'-2'}, {desc:"XYZ FOP (RATIO) Oct21'30 55 PUT",qty:'1'}]);
        assert.equal(r.positions.length,5);assert.equal(r.positions[1].instrument.secType,'STK');
        assert.equal(r.positions[3].instrument.secType,'OPT');
        assert.ok(r.sourceRows.every(r=>r.rowType==='position'));
    }},
    {name:'cash and TOTAL close combo scope instead of inheriting the prior parent',run(){
        const r=normalize([{desc:'XYZ Pack',qty:'99'}, {desc:call(50),qty:'1',indent:.112},
            {desc:put(50),qty:'-1',indent:.112},{desc:'TOTAL Other'}, {desc:'PEER',qty:'3',indent:.112}]);
        assert.equal(r.sourceRows.at(-1).parentRowId,null);
    }},
    {name:'JSON rejects combo cycles and forged leg lists; unresolved structure cannot become reviewed',run(){
        const c=load(), r=family('NebulaPack',[[call(50),'1'],[put(50),'-1']]);
        const s=c.OptionComboPortfolioSnapshotCore.applyRecognition(c.OptionComboPortfolioSnapshotSchema.empty('a','t'),r);
        const bad=plain(s);bad.sourceRows[0].parentRowId=bad.sourceRows[0].rowId;
        assert.throws(()=>c.OptionComboPortfolioSnapshotSchema.validate(bad),/循环/);
        const bad2=plain(s);bad2.sourceRows[0].combo.atomicLegRowIds=[];
        assert.throws(()=>c.OptionComboPortfolioSnapshotSchema.validate(bad2),/不一致/);
        let legacy=plain(s);delete legacy.sourceRows[0].combo;
        for(const p of legacy.positions)legacy=c.OptionComboPortfolioSnapshotCore.confirm(legacy,p.positionId,'t');
        assert.equal(legacy.review.status,'needs_review');
        const one=c.OptionComboPortfolioSnapshotOcr.normalize(image([{desc:'XYZ Calendar',qty:'99'},{desc:call(50),qty:'1',indent:.112}]),'a');
        const partial=c.OptionComboPortfolioSnapshotCore.applyRecognition(c.OptionComboPortfolioSnapshotSchema.empty('a','t'),one);
        assert.equal(c.OptionComboPortfolioSnapshotCore.confirm(partial,partial.positions[0].positionId,'t').review.status,'needs_review');
    }},
    {name:'crop consensus corrects unrelated short codes using boxes, preserving first-pass evidence',run(){
        for(const [original,selected] of [['NO','NQ'],['ABO','ABQ'],['NO','NO']]){
            const c=load(), raw=image([{desc:original+" Oct21'30 55 PUT",qty:'-3'}]);
            const word=raw.words.find(w=>w.text===original);
            raw.rereads=[{lineId:word.lineId,passes:[2,3].map(scale=>({scale,words:[{...word,text:selected}]}))}];
            const p=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a').positions[0];
            assert.equal(p.instrument.symbol,selected);
            assert.equal(p.fieldEvidence['instrument.symbol'].originalValue,original);
            assert.equal(p.quantity,'-3');
        }
    }},
    {name:'disagreement, one pass, duplicate scale or wrong crop location do not guess a replacement',run(){
        for(const mode of ['disagreed','one','duplicate','mislocated']){
            const c=load(), raw=image([{desc:"ABO Oct21'30 55 PUT",qty:'-3'}]), word=raw.words.find(w=>w.text==='ABO');
            const passes=[{scale:2,words:[{...word,text:'ABQ'}]},{scale:3,words:[{...word,text:mode==='disagreed'?'ABO':'ABQ'}]}];
            if(mode==='one')passes.pop();
            if(mode==='duplicate')passes[1].scale=2;
            if(mode==='mislocated')passes.forEach(p=>p.words[0].bbox=[.2,.1,.01,.012]);
            raw.rereads=[{lineId:word.lineId,passes}];
            const p=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a').positions[0];
            assert.equal(p.instrument.symbol,'ABO');
            if(mode==='disagreed')assert.match(p.issues.join(' '),/不一致/);
        }
    }},
    {name:'crop rereading leaves quantity and truncated source intact while option prefix identifies Call',run(){
        const c=load(), raw=image([{desc:"XYZ Oct21'30 55 CA...",qty:'-3'}]);
        const ca=raw.words.find(w=>w.text==='CA...'), q=raw.words.find(w=>w.text==='-3');
        raw.rereads=[{lineId:ca.lineId,passes:[2,3].map(scale=>({scale,words:[{...ca,text:'CALL'}]}))},
            {lineId:q.lineId,passes:[2,3].map(scale=>({scale,words:[{...q,text:'300'}]}))}];
        const p=c.OptionComboPortfolioSnapshotOcr.normalize(raw,'a').positions[0];
        assert.equal(p.instrument.right,'C');assert.equal(p.quantity,'-3');
        assert.equal(p.fieldEvidence['instrument.right'].interpretation.token,'CA...');
    }},
]};
module.exports.image = image;
