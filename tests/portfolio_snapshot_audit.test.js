const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const { image } = require('./portfolio_snapshot_structure.test');
const load = () => loadBrowserScripts(['js/portfolio_snapshot_schema.js','js/portfolio_snapshot_core.js','js/portfolio_snapshot_ocr.js']);
const plain = x => JSON.parse(JSON.stringify(x));
function fullRow() {
    const r = image([{desc:'ABC',qty:'3'}]);
    for (const [text,x] of [['11',.04],['12.34',.30],['13',.37],['14',.50],['15',.58],['37.02',.66],['17',.74],['18',.82],['19',.89],['29.3%',.96]]) r.words.push({text,bbox:[x,.1,.03,.012]});
    return r;
}
function state(c, raw = fullRow()) { return c.OptionComboPortfolioSnapshotCore.applyRecognition(c.OptionComboPortfolioSnapshotSchema.empty('audit','t'), c.OptionComboPortfolioSnapshotOcr.normalize(raw,'image-1')); }
// Pixel-read stand-ins are separate source inputs, not the normalizer's answers.
function withReviews(raw, pixels=raw) {
    raw.reviewProtocol=1;raw.width=2000;raw.height=1600;
    const requests=load().OptionComboPortfolioSnapshotOcr.normalize(raw,'x').recognition.reviewCrops;
    raw.reviewRereads=requests.map(request=>({...plain(request),passes:(request.field==='descriptionRow'?[2,3,4]:[3,4]).map(scale=>({scale,
        words:plain(pixels.words.filter(w=>{const b=request.cropBbox,x=w.bbox[0]+w.bbox[2]/2,y=w.bbox[1]+w.bbox[3]/2;return x>=b[0]&&x<b[0]+b[2]&&y>=b[1]&&y<b[1]+b[3];}))}))}));
    return raw;
}
module.exports = {name:'portfolio OCR audit regressions',tests:[
    {name:'R12 expanded TWS headers explicitly support LAST as the final column without inventing IV',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,raw=fullRow();
        raw.words.find(w=>w.text==='FIN').text='FINANCIAL';raw.words.find(w=>w.text==='PTF').text='PORTF';
        raw.words=raw.words.filter(w=>!['IMPLD','VL...','29.3%'].includes(w.text));
        const n=O.normalize(raw,'x');assert.equal(n.recognition.tableLayout.headers.length,11);assert.equal(n.recognition.tableLayout.edges.length,12);
        assert.equal(n.positions[0].displayValues.lastPrice,'19');assert.equal(n.positions[0].displayValues.displayIv,null);
        assert.equal(n.positions[0].fieldEvidence['displayValues.displayIv'].availability,'column_not_present');
        const copy=plain(raw);copy.words.push({text:'29.3%',bbox:[.96,.1,.03,.012]});
        const p=O.normalize(copy,'x').positions[0];assert.equal(p.displayValues.lastPrice,null);assert.ok(p.fieldEvidence['displayValues.lastPrice'].problem);assert.equal(p.displayValues.displayIv,null);
        for(const text of ['BID','EXTRA']){const r=plain(raw);r.words.push({text,bbox:[.87,.05,.025,.01]});assert.throws(()=>O.normalize(r,'x'),/额外列/);}
    }},
    {name:'R12 expanded aliases do not turn a missing IV in the existing presentation into an accepted layout',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        for(const change of ['none','FIN','PTF']){
            const r=fullRow();r.words=r.words.filter(w=>!['IMPLD','VL...','29.3%'].includes(w.text));
            if(change==='FIN')r.words.find(w=>w.text==='FIN').text='FINANCIAL';
            if(change==='PTF')r.words.find(w=>w.text==='PTF').text='PORTF';
            assert.throws(()=>O.normalize(r,'x'),/IMPLD|IV/);
        }
        const r=fullRow();r.words.find(w=>w.text==='FIN').text='FINANCIAL';r.words.find(w=>w.text==='PTF').text='PORTF';
        assert.equal(O.normalize(r,'x').recognition.tableLayout.headers.length,12);
    }},
    {name:'R12 negative OCR coordinates remain invalid, including unproven edge symbols',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,r=fullRow(),header=r.words.filter(w=>w.bbox[1]===.05);
        r.headerRereads=[2,3].map(scale=>({scale,words:plain(header)}));
        r.headerRereads[0].words.push({text:'|',bbox:[-.001,.05,.005,.01]});
        assert.throws(()=>O.normalize(r,'x'),e=>/坐标无效/.test(e.message)&&e.message.includes('本机 OCR')&&!e.message.includes('请保留完整表头'));
    }},
    {name:'R14 repeated source glyph proof requires complete identical copies, own geometry and both scales',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        const make=()=>{
            const pixels=fullRow(),raw=plain(pixels);pixels.words.find(w=>w.text==='18').text='7';raw.words=raw.words.filter(w=>w.text!=='18');withReviews(raw,pixels);
            const r=raw.reviewRereads.find(r=>r.field==='theta');
            for(const p of r.passes){const w=p.words[0],scale=p.scale,margin=20*scale,tileWidth=12*scale;
                w.glyphRepeatEvidence={method:'identical_source_patch',scale,copies:['7','7','7'],recognizedText:'777',sourceBbox:plain(w.bbox),
                    canvasSize:[margin*2+tileWidth*3,margin*3],canvasBox:[margin/(margin*2+tileWidth*3),1/3,tileWidth*3/(margin*2+tileWidth*3),1/3],margin,tileWidth};}
            return raw;
        };
        assert.equal(O.normalize(make(),'x').positions[0].displayValues.theta,'7');
        for(const mode of ['copies','text','source','scale','coverage','single','conflict']){
            const raw=make(),r=raw.reviewRereads.find(r=>r.field==='theta'),e=r.passes[0].words[0].glyphRepeatEvidence;
            if(mode==='copies')e.copies[2]='1';if(mode==='text')e.recognizedText='77';if(mode==='source')e.sourceBbox[0]=.74;
            if(mode==='scale')e.scale=4;if(mode==='coverage')e.canvasBox[2]/=3;if(mode==='single')r.passes.pop();
            if(mode==='conflict'){r.passes[1].words[0].text='8';Object.assign(r.passes[1].words[0].glyphRepeatEvidence,{copies:['8','8','8'],recognizedText:'888'});}
            assert.equal(O.normalize(raw,'x').positions[0].displayValues.theta,null,mode);
        }
    }},
    {name:'R14 LAST rereads repair punctuation only from two bounded numbers; qualifiers, disagreement and neighbours stay unknown',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        for(const mode of ['good','single','conflict','neighbour','qualifier']){
            const pixels=fullRow(),raw=plain(pixels);pixels.words.find(w=>w.text==='19').text='42.25';
            raw.words.find(w=>w.text==='19').text=mode==='qualifier'?'c42.25':': 42.25';withReviews(raw,pixels);
            const r=raw.reviewRereads.find(r=>r.field==='lastPrice');
            if(mode==='single')r.passes.pop();if(mode==='conflict')r.passes[0].words[0].text='42.75';
            if(mode==='neighbour')r.passes[0].words[0].bbox[0]=.82;
            const p=O.normalize(raw,'x').positions[0];assert.equal(p.displayValues.lastPrice,mode==='good'?'42.25':null,mode);
            if(mode==='good'){assert.equal(p.fieldEvidence['displayValues.lastPrice'].raw,': 42.25');assert.equal(p.fieldEvidence['displayValues.lastPrice'].corrections[0].passes.length,2);}
            if(mode==='qualifier')assert.equal(r,undefined);
        }
    }},
    {name:'R13 missing or unreadable numeric cells recover zero only from their own two-scale pixels, retaining the original',run(){
        const c=load(),O=c.OptionComboPortfolioSnapshotOcr;
        for(const missing of [true,false]){
            const pixels=fullRow(),raw=plain(pixels);pixels.words.find(w=>w.text==='18').text='0';
            if(missing)raw.words=raw.words.filter(w=>w.text!=='18');else raw.words.find(w=>w.text==='18').text='O';
            const n=O.normalize(withReviews(raw,pixels),'x'),p=n.positions[0],e=p.fieldEvidence['displayValues.theta'];
            assert.equal(p.displayValues.theta,'0');assert.equal(e.originalValue,null);assert.equal(e.raw,missing?null:'O');assert.equal(e.problem,null);
            assert.deepEqual(plain(e.corrections[0].passes.map(p=>p.scale)),[3,4]);assert.ok(c.OptionComboPortfolioSnapshotCore.machineChanges(n).some(f=>f.field==='displayValues.theta'&&f.after==='0'));
        }
    }},
    {name:'R13 numeric cell fallback refuses a neighbour, single read, conflict and existing legal values; prefixed LAST stays unknown',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        for(const mode of ['neighbour','single','conflict']){
            const pixels=fullRow(),raw=plain(pixels);raw.words=raw.words.filter(w=>w.text!=='18');withReviews(raw,pixels);
            const r=raw.reviewRereads.find(r=>r.field==='theta');
            if(mode==='neighbour')r.passes[0].words[0].bbox[0]=.74;
            if(mode==='single')r.passes.pop();if(mode==='conflict')r.passes[0].words[0].text='0';
            assert.equal(O.normalize(raw,'x').positions[0].displayValues.theta,null,mode);
        }
        // A legal first value is still reread in its own cell (Q3) and confirmed by agreement.
        const r=withReviews(fullRow()),checked=O.normalize(r,'x').positions[0];assert.ok(r.reviewRereads.some(r=>r.field==='theta'));
        assert.equal(checked.displayValues.theta,'18');assert.equal(checked.fieldEvidence['displayValues.theta'].cellCheck,'confirmed');
        const prefixed=fullRow();prefixed.words.find(w=>w.text==='19').text='c19';withReviews(prefixed);
        assert.ok(!prefixed.reviewRereads.some(r=>r.field==='lastPrice'));assert.equal(O.normalize(prefixed,'x').positions[0].displayValues.lastPrice,null);
    }},
    {name:'R13 a complete row consumes its exchange suffix; incomplete tails never compete as complete contracts',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        for(const desc of ["ZZZ Dec18'30 @EXCH","ZZZ FOP (Z7) Dec18'30 40 PUT @EXCH"]){
            const pixels=image([{desc,qty:'2'}]),raw=withReviews(plain(pixels),pixels),r=raw.reviewRereads.find(r=>r.field==='descriptionRow');
            r.passes[0].words.at(-1).text='OXCH';
            const n=O.normalize(raw,'x');assert.equal(n.positions.length,1);assert.equal(n.positions[0].instrument.exchange,'EXCH');assert.equal(n.sourceRows[0].rowRefinement.allPasses.length,3);
            r.passes[0].words.at(-1).text='@OTHER';assert.equal(O.normalize(raw,'x').positions.length,0,'a different complete exchange must block the row');
        }
    }},
    {name:'R13 visible but unread numeric ink stays unknown with an explicit field problem, never an inferred zero',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,pixels=fullRow(),raw=plain(pixels);raw.words=raw.words.filter(w=>w.text!=='18');withReviews(raw,pixels);
        const r=raw.reviewRereads.find(r=>r.field==='theta');
        for(const p of r.passes){p.numericInkBbox=plain(p.words[0].bbox);p.words=[];}
        const n=O.normalize(raw,'x'),e=n.positions[0].fieldEvidence['displayValues.theta'];
        assert.equal(n.positions[0].displayValues.theta,null);assert.match(e.problem,/检测到字形/);assert.equal(e.corrections.length,0);
        assert.equal(n.sourceRows[0].unreadNumericCells.theta.status,'unresolved');
    }},
    {name:'R10 legal but wrong average needs two bounded higher-scale cell reads, exposes changes and preserves raw evidence',run(){
        const c=load(),pixels=fullRow(),raw=plain(pixels);
        pixels.words.find(w=>w.text==='17').text='7.273';raw.words.find(w=>w.text==='17').text='7.275';
        const n=c.OptionComboPortfolioSnapshotOcr.normalize(withReviews(raw,pixels),'x'),p=n.positions[0],e=p.fieldEvidence['displayValues.avgPrice'];
        assert.equal(p.displayValues.avgPrice,'7.273');assert.equal(e.raw,'7.275');assert.equal(e.originalValue,'7.275');
        assert.deepEqual(plain(e.corrections[0].passes.map(p=>p.scale)),[3,4]);
        assert.ok(c.OptionComboPortfolioSnapshotCore.machineChanges(n).some(f=>f.field==='displayValues.avgPrice'&&f.before==='7.275'&&f.after==='7.273'));
        assert.deepEqual(plain(n.recognition.originalReviewRereads.map(r=>r.field)).sort(),
            ['avgPrice','costBasis','dailyPnl','deltaDollars','descriptionRow','displayIv','lastPrice','mark','marketValue','theta','unrealizedPnl']);
    }},
    {name:'R10 missing, conflicting, duplicated, sign-changing or neighbouring cell reads never fall back to a plausible first average',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        for(const mode of ['missing','one','scale','disagree','duplicate','sign','column','row','ink']){
            const raw=withReviews(fullRow()),r=raw.reviewRereads.find(r=>r.field==='avgPrice');
            if(mode==='missing')raw.reviewRereads=raw.reviewRereads.filter(r=>r!==raw.reviewRereads.find(r=>r.field==='avgPrice'));
            if(mode==='one')r.passes.pop();if(mode==='scale')r.passes[1].scale=3;
            if(mode==='disagree')r.passes[1].words[0].text='17.1';
            if(mode==='duplicate')raw.reviewRereads.push(plain(r));
            if(mode==='sign')r.passes.forEach(p=>p.words[0].text='-17');
            if(mode==='column')r.passes[1].words[0].bbox[0]=.80;
            if(mode==='row')r.passes[1].words[0].bbox[1]=.16;
            if(mode==='ink')r.passes[1].words[0].inkBbox=[.1,.1,.01,.01];
            const n=O.normalize(raw,'x');assert.equal(n.positions.length,1,mode);assert.equal(n.positions[0].displayValues.avgPrice,null,mode);
            assert.match(n.positions[0].fieldEvidence['displayValues.avgPrice'].problem,/局部重读/,mode);
        }
    }},
    {name:'R11 crop identities repair shifted names and recover numeric-only rows while every quantity stays on its own row',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        const pixels=image([{desc:"AAA Oct21'30 40 PUT",qty:'-3'},{desc:"BBB Nov20'30 45 CALL",qty:'8'},{desc:"CCC Dec19'30 50 PUT",qty:'-7'}]),raw=plain(pixels);
        const descriptions=[1,2,3].map(id=>pixels.words.filter(w=>w.lineId===id));
        for(let i=0;i<2;i++)raw.words.filter(w=>w.lineId===i+1).forEach((w,j)=>w.text=descriptions[i+1][j].text);
        raw.words=raw.words.filter(w=>w.lineId!==3);
        const n=O.normalize(withReviews(raw,pixels),'x');
        assert.deepEqual(plain(n.positions.map(p=>[p.instrument.symbol,p.instrument.strike,p.quantity])),[['AAA','40','-3'],['BBB','45','8'],['CCC','50','-7']]);
        assert.equal(n.sourceRows.length,3);assert.equal(n.recognition.structureIssues.length,0);
        assert.equal(n.positions[0].fieldEvidence['instrument.symbol'].originalValue,'BBB');
        assert.equal(n.positions[2].fieldEvidence['instrument.symbol'].originalValue,null);
        assert.equal(n.sourceRows[2].rawCells.description,undefined);assert.match(n.sourceRows[2].normalizedCells.description,/CCC/);
    }},
    {name:'R11 a missing, conflicting or displaced row proof preserves a visible unclassified row instead of assigning its numbers',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        for(const mode of ['missing','disagree','column','row']){
            const raw=withReviews(fullRow()),r=raw.reviewRereads.find(r=>r.field==='descriptionRow');
            if(mode==='missing')raw.reviewRereads=raw.reviewRereads.filter(p=>p!==r);
            if(mode==='disagree')r.passes[1].words[0].text='XYZ';
            if(mode==='column')r.passes[1].words[0].bbox[0]=.01;
            if(mode==='row')r.passes[1].words[0].bbox[1]=.16;
            const n=O.normalize(raw,'x');assert.equal(n.positions.length,0,mode);assert.equal(n.sourceRows[0].rowType,'unclassified',mode);
            assert.ok(n.recognition.structureIssues.length);assert.ok(n.sourceRows[0].rawText.includes('ABC'));
        }
    }},
    {name:'R11 changing the row identity requires a separate daily-PnL cell proof; unchanged identities do not adopt an unrelated reread',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,pixels=fullRow(),raw=plain(pixels);
        raw.words.find(w=>w.text==='ABC').text='XYZ';raw.words.find(w=>w.text==='11').text='-11';pixels.words.find(w=>w.text==='11').text='13';
        let proof=withReviews(raw,pixels),n=O.normalize(proof,'x');
        // A legal first reading that the agreed cell proof contradicts proves neither value.
        assert.equal(n.positions[0].displayValues.dailyPnl,null);assert.equal(n.positions[0].fieldEvidence['displayValues.dailyPnl'].originalValue,'-11');
        assert.match(n.positions[0].fieldEvidence['displayValues.dailyPnl'].problem,/首读 -11 与两次同格放大读数 13 不一致（正负号也不同）/);
        assert.deepEqual(plain(n.positions[0].fieldEvidence['displayValues.dailyPnl'].conflictingReadings),{first:'-11',reread:'13'});
        proof.reviewRereads=proof.reviewRereads.filter(r=>r.field!=='dailyPnl');n=O.normalize(proof,'x');
        assert.equal(n.positions[0].displayValues.dailyPnl,null);assert.match(n.positions[0].fieldEvidence['displayValues.dailyPnl'].problem,/局部重读/);
        proof=withReviews(fullRow());proof.reviewRereads.find(r=>r.field==='dailyPnl').passes.forEach(p=>p.words[0].text='13');
        assert.equal(O.normalize(proof,'x').positions[0].displayValues.dailyPnl,'11');
    }},
    {name:'R11 two complete agreeing reads may use a third resolution, but any competing complete identity or bad geometry still rejects',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,pixels=image([{desc:"XYZ Oct21'30 40 CALL",qty:'2'}]);
        let raw=withReviews(plain(pixels),pixels),r=raw.reviewRereads.find(r=>r.field==='descriptionRow');
        r.passes[1].words.find(w=>w.text==="Oct21'30").text="0ct21'30";
        let n=O.normalize(raw,'x');assert.equal(n.positions.length,1);assert.deepEqual(plain(n.sourceRows[0].rowRefinement.passes.map(p=>p.scale)),[2,4]);assert.equal(n.sourceRows[0].rowRefinement.allPasses.length,3);
        raw=withReviews(plain(pixels),pixels);r=raw.reviewRereads.find(r=>r.field==='descriptionRow');r.passes[2].words.find(w=>w.text==='40').text='45';
        assert.equal(O.normalize(raw,'x').positions.length,0,'two votes cannot override a different complete contract');
        raw=withReviews(plain(pixels),pixels);r=raw.reviewRereads.find(r=>r.field==='descriptionRow');r.passes[1].words[0].bbox[0]=.01;
        assert.equal(O.normalize(raw,'x').positions.length,0,'all read geometry must stay inside the requested row/column');
    }},
    {name:'R11 same-pixel duplicate words do not duplicate a parent label or lose its generic legs; all original observations remain',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,pixels=image([{desc:'ZZZ NebulaPack',qty:'90'},
            {desc:"ZZZ Oct21'30 40 PUT",qty:'5',indent:.112},{desc:"ZZZ Oct21'30 45 PUT",qty:'-5',indent:.112}]);
        const raw=withReviews(plain(pixels),pixels),r=raw.reviewRereads.find(r=>r.field==='descriptionRow');
        r.passes[0].words.push(plain(r.passes[0].words.at(-1)));
        const n=O.normalize(raw,'x'),parent=n.sourceRows[0];assert.equal(parent.rowType,'combo_summary');assert.equal(parent.combo.atomicLegRowIds.length,2);assert.equal(n.positions.length,2);
        assert.equal(parent.rowRefinement.allPasses[0].words.length,3);assert.equal(parent.rowRefinement.passes[0].words.length,2);
    }},
    {name:'R11 short-code context proof is reused only at its own original word box, without choosing between complete contracts',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,pixels=image([{desc:"ZZZ Dec18'30 @EXCH",qty:'1'}]),raw=withReviews(plain(pixels),pixels);
        const r=raw.reviewRereads.find(r=>r.field==='descriptionRow');r.passes[0].words[0].text='YYY';
        raw.rereads=[{lineId:1,passes:[2,3].map(scale=>({scale,words:plain(pixels.words.filter(w=>w.lineId===1))}))}];
        assert.equal(O.normalize(raw,'x').positions[0].instrument.symbol,'ZZZ');
        for(const p of raw.rereads[0].passes)p.words.forEach(w=>w.bbox[1]+=.1);
        assert.equal(O.normalize(raw,'x').positions.length,0,'a neighbouring crop cannot override a competing identity');
    }},
    {name:'R11 an unknown dated strategy remains a generic parent under the production row-review protocol',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,pixels=image([{desc:"ZZZ Oct21'30 NebulaPack",qty:'90'},
            {desc:"ZZZ Oct21'30 40 PUT",qty:'5',indent:.112},{desc:"ZZZ Oct21'30 45 PUT",qty:'-5',indent:.112},{desc:'PEER',qty:'2'}]);
        const n=O.normalize(withReviews(plain(pixels),pixels),'x');assert.equal(n.sourceRows[0].rowType,'combo_summary');
        assert.equal(n.sourceRows[0].combo.atomicLegRowIds.length,2);assert.equal(n.positions.length,3);assert.equal(n.positions[2].instrument.symbol,'PEER');
        assert.equal(n.positions[2].sourceRowIds[0],'row-4');assert.equal(n.sourceRows[3].parentRowId,null);
    }},
    {name:'R3 two header crops must each reject unknown labels, missing labels, reordered or inconsistent coordinates',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,raw=fullRow(),header=raw.words.filter(w=>w.bbox[1]===.05);
        const withPasses=()=>({...plain(raw),headerRereads:[2,3].map(scale=>({scale,words:plain(header)}))});
        assert.equal(O.normalize(withPasses(),'x').positions.length,1);
        for(const mode of ['extra','missing','duplicate-scale','displaced']){
            const r=withPasses(),p=r.headerRereads[1];
            if(mode==='extra')p.words.push({text:'BID',bbox:[.87,.05,.02,.01]});
            if(mode==='missing')p.words=p.words.filter(w=>w.text!=='LAST');
            if(mode==='duplicate-scale')p.scale=2;
            if(mode==='displaced')p.words.find(w=>w.text==='LAST').bbox[0]+=.004;
            assert.throws(()=>O.normalize(r,'x'),/表头无法确认/,mode);
        }
    }},
    {name:'R3 generic fused header candidates reconstruct words exactly and require one supported semantic split',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,r=fullRow(),last=r.words.find(w=>w.text==='LAST'),iv=r.words.find(w=>w.text==='IMPLD');
        r.words=r.words.filter(w=>w!==last&&w!==iv);
        const fused={text:'LASTIMPLD',bbox:[.901,.05,.072,.01],headerPartCandidates:[
            [{text:'LAS',bbox:[.901,.05,.02,.01]},{text:'TIMPLD',bbox:[.922,.05,.051,.01]}],plain([last,iv])]};r.words.push(fused);
        assert.equal(O.normalize(r,'x').positions[0].displayValues.lastPrice,'19');
        fused.text='LASTBIDIMPLD';assert.throws(()=>O.normalize(r,'x'),/定位证据/);
    }},
    {name:'R3 a pixel-proven remote status square cannot become a negative sign; genuine signs are preserved',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,r=fullRow();
        const dash={text:'-',bbox:[.866,.1,.004,.012],decorationEvidence:{method:'compact_colored_square',fill:.95,inkBbox:[.866,.103,.003,.003]}};r.words.push(dash);
        let parsed=O.normalize(r,'x');assert.equal(parsed.positions[0].displayValues.lastPrice,'19');assert.equal(parsed.sourceRows[0].excludedDecorations.length,1);assert.match(parsed.sourceRows[0].rawText,/-/);
        delete dash.decorationEvidence;assert.equal(O.normalize(r,'x').positions[0].displayValues.lastPrice,'-19');
        r.words=r.words.filter(w=>w!==dash);r.words.find(w=>w.text==='19').text='-19';assert.equal(O.normalize(r,'x').positions[0].displayValues.lastPrice,'-19');
    }},
    {name:'R3 numeric border recovery needs two agreeing bounded pixel reads and retains the invalid original token',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,r=fullRow();r.words.find(w=>w.text==='29.3%').text='42.7%|';
        const word=r.words.find(w=>w.text==='42.7%|'),b=word.bbox;
        r.numericRereads=[{method:'vertical_border_crop_consensus',originalText:word.text,originalBbox:plain(b),cropBbox:[b[0],b[1]-.002,b[2]-.002,b[3]+.004],ruleBbox:[b[0]+b[2]-.002,b[1]-.012,.002,.036],passes:[2,3].map(scale=>({scale,words:[{text:'42.7%',bbox:[b[0],b[1],b[2]-.003,b[3]]}]}))}];
        const p=O.normalize(r,'x').positions[0];assert.equal(p.displayValues.displayIv,'0.427');assert.equal(p.fieldEvidence['displayValues.displayIv'].raw,'42.7%|');assert.equal(p.fieldEvidence['displayValues.displayIv'].originalValue,null);
        for(const mode of ['one','disagrees','neighbor','neighbor-row','sign']){
            const copy=plain(r),passes=copy.numericRereads[0].passes;
            if(mode==='one')passes.pop();if(mode==='disagrees')passes[1].words[0].text='43.7%';if(mode==='neighbor')passes[1].words[0].bbox[0]=.89;if(mode==='neighbor-row')passes[1].words[0].bbox[1]=.2;if(mode==='sign')passes[1].words[0].text='-42.7%';
            assert.equal(O.normalize(copy,'x').positions[0].displayValues.displayIv,null,mode);
        }
    }},
    {name:'R1 unknown middle or trailing headers reject even when the neighboring LAST cell is empty',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        for(const [text,x] of [['BID',.87],['EXTRA',.998],['A',.87],['%',.998]]){
            const r=fullRow();r.words=r.words.filter(w=>w.text!=='19');
            r.words.push({text,bbox:[x,.05,Math.min(.02,1-x),.01]});
            assert.throws(()=>O.normalize(r,'x'),/额外列或文字/);
        }
        const r=fullRow();r.words.push({text:'BID',bbox:[.87,.05,.02,.01]});r.words.push({text:'9.95',bbox:[.87,.1,.02,.012]});
        assert.throws(()=>O.normalize(r,'x'),/BID/);
    }},
    {name:'R2 indented decorations neither demote a stock nor break option legs or nested parents',run(){
        const O=load().OptionComboPortfolioSnapshotOcr;
        for(const indent of [.105,.12]){
            const r=O.normalize(image([{desc:'ABC',qty:'2'},{desc:'OK',qty:null,indent}]),'x');
            assert.equal(r.positions.length,1);assert.equal(r.sourceRows[0].rowType,'position');
        }
        const r=O.normalize(image([{desc:'ABC Package',qty:'9'},
            {desc:"ABC Oct21'30 50 PUT",qty:'2',indent:.112},
            {desc:'Order filled',qty:null,indent:.14},
            {desc:"ABC Oct21'30 55 PUT",qty:'-2',indent:.112}]),'x');
        assert.deepEqual(plain(r.sourceRows.map(r=>r.rowType)),['combo_summary','position','decoration','position']);
        assert.deepEqual(plain(r.sourceRows[0].combo.atomicLegRowIds),['row-2','row-4']);
        assert.equal(r.sourceRows[2].parentRowId,null);assert.equal(r.sourceRows[3].parentRowId,'row-1');
        assert.equal(r.recognition.structureIssues.length,0);
    }},
    {name:'R8 measured label overlap stays strict at every image aspect ratio',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,raw=fullRow(),header=raw.words.filter(w=>w.bbox[1]===.05);
        const shifted=left=>({...plain(raw),headerRereads:[2,3].map(scale=>({scale,words:plain(header).map(w=>w.text==='MKT'?{...w,bbox:[left,w.bbox[1],.669-left,w.bbox[3]]}:w)}))});
        // DLLRS ends at .630; header text height .01, so up to .003 of contact is box noise.
        assert.throws(()=>O.normalize(shifted(.628),'x'),/列顺序或标签重叠/);
        assert.equal(O.normalize(shifted(.641),'x').positions[0].displayValues.marketValue,'37.02');
        assert.throws(()=>O.normalize(shifted(.62),'x'),/列顺序或标签重叠/);
        // The same normalized contact on a much wider image is fewer pixels of text height.
        assert.throws(()=>O.normalize({...shifted(.628),width:4000,height:1000},'x'),/列顺序或标签重叠/);
        assert.throws(()=>O.normalize({...shifted(.628),width:1000,height:1000},'x'),/列顺序或标签重叠/);
    }},
    {name:'R8 only a pixel-proven neighbour sliver may be ignored in a header; letters and unproven symbols reject',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,raw=fullRow(),header=raw.words.filter(w=>w.bbox[1]===.05);
        const withToken=token=>({...plain(raw),headerRereads:[2,3].map(scale=>({scale,words:[...plain(header),...(scale===3?[token]:[])]}))});
        const sliver={text:'•',bbox:[.630,.05,.009,.01],inkEvidence:'edge_fragment_only'};
        assert.equal(O.normalize(withToken(sliver),'x').positions.length,1);
        assert.throws(()=>O.normalize(withToken({...sliver,inkEvidence:undefined}),'x'),/发现不支持的额外列或文字：•/);
        assert.throws(()=>O.normalize(withToken({...sliver,text:'X'}),'x'),/发现不支持的额外列或文字：X/);
    }},
    {name:'R9 a frame line read as | beside +/- is dropped only on the side pixels prove a full-height rule',run(){
        const O=load().OptionComboPortfolioSnapshotOcr,raw=fullRow(),header=raw.words.filter(w=>w.bbox[1]===.05);
        const withPlus=token=>({...plain(raw),headerRereads:[2,3].map(scale=>({scale,words:[token,...plain(header)]}))});
        const rule=(side,x)=>({side,bbox:[x,.03,.001,.04]});
        const token={text:'|+/-',bbox:[.004,.05,.022,.01]};
        assert.equal(O.normalize(withPlus({...token,frameRule:rule('left',.004)}),'x').positions.length,1);
        assert.equal(O.normalize(withPlus({text:'|',bbox:[.004,.05,.003,.01],frameRule:rule('left',.004)}),'x').positions.length,1);
        assert.throws(()=>O.normalize(withPlus(token),'x'),/发现不支持的额外列或文字：\|\+\/-/);
        assert.throws(()=>O.normalize(withPlus({...token,frameRule:rule('right',.025)}),'x'),/发现不支持的额外列或文字/);
        assert.throws(()=>O.normalize(withPlus({...token,frameRule:{side:'left',bbox:[.004,.05,.001,.012]}}),'x'),/发现不支持的额外列或文字/);
        assert.throws(()=>O.normalize(withPlus({...token,frameRule:rule('left',.2)}),'x'),/发现不支持的额外列或文字/);
        assert.throws(()=>O.normalize(withPlus({text:'|%',bbox:[.004,.05,.022,.01],frameRule:rule('left',.004)}),'x'),/发现不支持的额外列或文字：\|%/);
    }},
    {name:'A1 column expansion derives each numeric interval from all actual header labels',run(){
        const c=load(),O=c.OptionComboPortfolioSnapshotOcr,expected=O.normalize(fullRow(),'x').positions[0];
        for(const delta of [.015,.025,.04,.08]){
            const r=fullRow();for(const w of r.words){w.bbox[0]=(w.bbox[0]+(w.bbox[0]>.4?delta:0))/(1+delta);w.bbox[2]/=1+delta;}
            const actual=O.normalize(r,'x').positions[0];
            for(const f of c.OptionComboPortfolioSnapshotSchema.FIELDS)assert.equal(c.OptionComboPortfolioSnapshotSchema.get(actual,f.path),c.OptionComboPortfolioSnapshotSchema.get(expected,f.path),f.path+' delta '+delta);
        }
    }},
    {name:'A1 A6 reordered, deleted, repeated or missing headers reject in Chinese; sorting arrows are accepted',run(){
        const c=load(),O=c.OptionComboPortfolioSnapshotOcr;
        for(const mode of ['swap','delete','duplicate','missing-mark']){
            const r=fullRow();
            if(mode==='swap'){r.words.find(w=>w.text==='POS').bbox[0]=.64;r.words.find(w=>w.text==='MKT').bbox[0]=.443;r.words.find(w=>w.text==='VALUE').bbox[0]=.475;}
            if(mode==='delete')r.words=r.words.filter(w=>w.text!=='PRICE');
            if(mode==='duplicate')r.words.push({...r.words.find(w=>w.text==='POS'),bbox:[.4,.05,.02,.01]});
            if(mode==='missing-mark')r.words=r.words.filter(w=>w.text!=='MARK');
            assert.throws(()=>O.normalize(r,'x'),/表头无法确认/,mode);
        }
        const r=fullRow();r.words.find(w=>w.text==='MARK').text='MARK▼';assert.equal(O.normalize(r,'x').positions[0].quantity,'3');
    }},
    {name:'A1 stock value cross-check uses original display precision and never changes numbers',run(){
        const c=load(),C=c.OptionComboPortfolioSnapshotCore,p=state(c).positions[0];
        assert.equal(C.issues(p).some(s=>s.includes('舍入')),false);
        p.displayValues.marketValue='-37.02';assert.ok(C.issues(p).some(s=>s.includes('舍入')));assert.equal(p.displayValues.marketValue,'-37.02');
        p.quantity='1';p.displayValues.mark='10';p.displayValues.marketValue='10.1';p.fieldEvidence['displayValues.mark'].raw='10.00';p.fieldEvidence['displayValues.marketValue'].raw='10.10';
        assert.ok(C.issues(p).some(s=>s.includes('舍入')));
    }},
    {name:'A1 fused LAST/IV labels require actual character or glyph coordinates, not proportional guesses',run(){
        const c=load(),r=fullRow(),last=r.words.find(w=>w.text==='LAST'),iv=r.words.find(w=>w.text==='IMPLD');
        r.words=r.words.filter(w=>w!==last&&w!==iv);const joined={text:'LASTIMPLD',bbox:[last.bbox[0],.05,iv.bbox[0]+iv.bbox[2]-last.bbox[0],.01]};r.words.push(joined);
        assert.throws(()=>c.OptionComboPortfolioSnapshotOcr.normalize(r,'x'),/字符定位证据/);
        joined.headerParts=[last,iv];assert.equal(c.OptionComboPortfolioSnapshotOcr.normalize(r,'x').positions[0].displayValues.lastPrice,'19');
    }},
    {stage:'P0',name:'A2 machine changes remain visible after explicit batch acknowledgement; stale lists fail',run(){
        const c=load(),C=c.OptionComboPortfolioSnapshotCore,s=state(c),p=s.positions[0];
        p.fieldEvidence.quantity={source:'ocr',originalValue:null,recognizedValue:'3',corrections:[{method:'quantity_crop_consensus'}]};
        assert.throws(()=>C.confirmAll(s,'t'),/关键字段清单/);
        const list=C.machineChanges(s),next=C.confirmAll(s,'t',JSON.stringify(list));
        assert.equal(next.positions[0].reviewStatus,'reviewed');assert.ok(C.issues(next.positions[0]).some(s=>s.includes('机器重读')));
        assert.equal(next.review.machineAcknowledgement.fields[0].after,'3');
        const edited=C.edit(next,p.positionId,'quantity','-3','later');assert.throws(()=>C.confirmAll(edited,'t',JSON.stringify(list)),/关键字段清单/);
    }},
    {name:'A3 decoration is geometric, uppercase toolbar text cannot become a zero-evidence stock',run(){
        const c=load(),r=image([{desc:'OK',qty:null},{desc:'NOTE',qty:null},{desc:'ABC',qty:'2'}]);
        const result=c.OptionComboPortfolioSnapshotOcr.normalize(r,'x');
        assert.equal(result.positions.length,1);assert.equal(result.positions[0].instrument.symbol,'ABC');
        assert.deepEqual(plain(result.sourceRows.map(r=>r.rowType)),['unclassified','unclassified','position']);
        const footer=image([{desc:'USD CASH',qty:null},{desc:'OK',qty:'1'}]);footer.words.push({text:'123',bbox:[.66,.1,.03,.012]});
        const parsed=c.OptionComboPortfolioSnapshotOcr.normalize(footer,'x');assert.equal(parsed.positions.length,0);assert.equal(parsed.sourceRows[1].classificationEvidence.reason,'below_cash_footer');
    }},
    {stage:'P0',name:'A3 accepting an incomplete structure records a reason without inventing legs or coverage',run(){
        const c=load(),C=c.OptionComboPortfolioSnapshotCore,s=state(c,image([{desc:'ABC Calendar',qty:'9'},{desc:"ABC Oct21'30 50 PUT",qty:'1',indent:.112}]));
        assert.throws(()=>C.acceptIssue(s,C.pendingIssues(s)[0],'','t'),/原因/);
        let next=C.acceptIssue(s,C.pendingIssues(s)[0],'已核对，只保留可见一腿','t');next=C.confirmAll(next,'t');
        assert.equal(next.review.status,'reviewed');assert.equal(next.positions.length,1);assert.equal(next.coverage.userConfirmedComplete,false);
        next.sourceRows[0].combo.expectedLegCount=3;assert.equal(C.pendingIssues(next).length,1);
        const collapsed=state(c,image([{desc:'ABC Calendar',qty:'9'}]));
        const accepted=C.acceptIssue(collapsed,C.pendingIssues(collapsed)[0],'已核对，接受折叠内容不完整','t');
        assert.equal(accepted.review.status,'reviewed');assert.equal(accepted.positions.length,0);assert.equal(accepted.coverage.userConfirmedComplete,false);
    }},
    {stage:'P0',name:'A3 exclusion preserves source and reason, removes only its economic row and rebuilds graph',run(){
        const c=load(),C=c.OptionComboPortfolioSnapshotCore,s=state(c),id=s.sourceRows[0].rowId;
        const next=C.excludeRow(s,id,'人工判定为弹窗文字','t');assert.equal(next.positions.length,0);assert.equal(next.sourceRows[0].rowType,'decoration');
        assert.equal(next.sourceRows[0].rawText,s.sourceRows[0].rawText);assert.equal(next.sourceRows[0].exclusion.previousType,'position');
        c.OptionComboPortfolioSnapshotSchema.validate(next);
        const collapsed=state(c,image([{desc:'ABC Calendar',qty:'9'}]));assert.equal(C.excludeRow(collapsed,collapsed.sourceRows[0].rowId,'非持仓装饰','t').sourceRows[0].rowType,'decoration');
    }},
    {stage:'P0',name:'A4 account-like OCR strings are masked throughout evidence but explicit manual account survives',run(){
        const c=load(),S=c.OptionComboPortfolioSnapshotSchema,s=state(c);s.account.value='U7654321';
        s.sourceRows[0].rawText='notice U1234567 DU123456';s.recognition.originalLines=[{text:'U1234567 DU123456'}];s.recognition.originalRereads=[{passes:[{words:[{text:'DU123456'}]}]}];
        const text=S.serialize(s),round=S.validate(JSON.parse(text));assert.equal(round.account.value,'U7654321');
        assert.equal(/U1234567|DU123456/.test(text),false);assert.match(text,/账号已遮蔽/);assert.equal(round.recognition.redaction.applied,true);
    }},
    {stage:'P0',name:'A4 near-row-limit JSON exports compactly and round trips above the old import limit',run(){
        const c=load(),S=c.OptionComboPortfolioSnapshotSchema,C=c.OptionComboPortfolioSnapshotCore,s=S.empty('large','t');
        for(let i=0;i<S.LIMITS.rows;i++){const id='m'+i;s.sourceRows.push({rowId:id,sourceId:null,rowType:'position',parentRowId:null,bbox:null,rawText:'证据'.repeat(500),rawCells:{}});s.positions.push(C.position(id,id));}
        const text=S.serialize(s);assert.ok(Buffer.byteLength(text)>1024*1024);assert.ok(Buffer.byteLength(text)<=S.LIMITS.jsonBytes);
        assert.equal(S.validate(JSON.parse(text)).positions.length,S.LIMITS.rows);
        const tooBig=S.empty('huge','t');tooBig.recognition.extra='x'.repeat(S.LIMITS.jsonBytes);assert.throws(()=>S.serialize(tooBig),/32 MiB/);
    }},
    {name:'A7 exchange suffix does not turn an option into a future',run(){
        const c=load(),p=c.OptionComboPortfolioSnapshotOcr.normalize(image([{desc:"ABC Oct21'30 55 PUT @CBOE",qty:'1'}]),'x').positions[0];
        assert.equal(p.instrument.secType,'OPT');assert.equal(p.instrument.right,'P');assert.equal(p.instrument.strike,'55');
        p.displayValues.lastPrice='-9.5';assert.ok(c.OptionComboPortfolioSnapshotCore.issues(p).some(s=>s.includes('期权价格为负')));assert.equal(p.displayValues.lastPrice,'-9.5');
    }},
    {stage:'P0',name:'A8 manual security type contradictions stay visible and fields are not cleared',run(){
        const c=load(),s=state(c,image([{desc:"ABC Oct21'30 55 PUT",qty:'1'}])),p=s.positions[0];
        const next=c.OptionComboPortfolioSnapshotCore.edit(s,p.positionId,'instrument.secType','STK','t');
        assert.equal(next.positions[0].instrument.strike,'55');assert.ok(c.OptionComboPortfolioSnapshotCore.issues(next.positions[0]).some(s=>s.includes('矛盾')));
    }},
    {name:'A9 short normalized row spacing on long screenshots keeps separate position rows',run(){
        const c=load(),r=image(Array.from({length:4},()=>({desc:'ABC',qty:'1'})));
        for(const w of r.words)if(w.lineId){const i=w.lineId>=1000?w.lineId-1000:w.lineId-1;w.bbox[1]=.2+i*.0025;w.bbox[3]=.0012;}
        assert.equal(c.OptionComboPortfolioSnapshotOcr.normalize(r,'x').positions.length,4);
    }},
    {stage:'P0',name:'A10 percentage display uses decimal string shifts without binary tails',run(){
        const S=load().OptionComboPortfolioSnapshotSchema;
        assert.equal(S.percentDisplay('0.293'),'29.3');assert.equal(S.percentDisplay('1.214'),'121.4');assert.equal(S.percentDisplay('-0.001'),'-0.1');
    }},
    {name:'Q3 Vision rereads every legal numeric value in its own cell: confirm, keep a contradicted value unknown, flag the unchecked',run(){
        const c=load(),O=c.OptionComboPortfolioSnapshotOcr,C=c.OptionComboPortfolioSnapshotCore;
        // MARK first read 12.37 while both cell rereads see 12.3 (an extra trailing digit).
        let pixels=fullRow(),raw=plain(pixels);raw.words.find(w=>w.text==='12.34').text='12.37';pixels.words.find(w=>w.text==='12.34').text='12.3';
        // Neither reading is adopted: two agreeing rereads can drop the same digit.
        let n=O.normalize(withReviews(raw,pixels),'x'),e=n.positions[0].fieldEvidence['displayValues.mark'];
        assert.equal(n.positions[0].displayValues.mark,null);assert.equal(e.originalValue,'12.37');assert.equal(e.cellCheck,'reread_conflict');
        assert.equal(e.problem,'MARK 首读 12.37 与两次同格放大读数 12.3 不一致；保留未知，请核对原图。');
        assert.ok(!C.machineChanges(n).some(f=>f.field==='displayValues.mark'));
        // A sign that differs between the first reading and the cell rereads stays unknown.
        pixels=fullRow();raw=plain(pixels);pixels.words.find(w=>w.text==='14').text='-14';
        n=O.normalize(withReviews(raw,pixels),'x');e=n.positions[0].fieldEvidence['displayValues.unrealizedPnl'];
        assert.equal(n.positions[0].displayValues.unrealizedPnl,null);assert.match(e.problem,/首读 14 与两次同格放大读数 -14 不一致（正负号也不同）/);
        // No agreeing reread: the first value is kept but stays visibly unchecked until edited.
        raw=withReviews(fullRow());raw.reviewRereads.find(r=>r.field==='mark').passes[1].words[0].text='12.39';
        n=O.normalize(raw,'x');e=n.positions[0].fieldEvidence['displayValues.mark'];
        assert.equal(n.positions[0].displayValues.mark,'12.34');assert.equal(e.cellCheck,'unchecked');
        const s=C.applyRecognition(c.OptionComboPortfolioSnapshotSchema.empty('audit','t'),n);
        assert.ok(C.issues(s.positions[0]).some(t=>t.startsWith('MARK')&&t.includes('未经同格复核')));
        const edited=C.edit(s,s.positions[0].positionId,'displayValues.mark','12.35','t2');
        assert.ok(!C.issues(edited.positions[0]).some(t=>t.includes('未经同格复核')),'a manual value is no longer an unchecked reading');
    }},
] };
