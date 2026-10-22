/* Audit A1 coordinate perturbation: never uses screenshot identity or production-derived expected numbers. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {loadBrowserScripts}=require('../tests/helpers/load-browser-scripts');
const arg=key=>process.argv[process.argv.indexOf(key)+1];
assert.ok(process.argv.includes('--raw')&&process.argv.includes('--output'),'--raw and --output required');
const c=loadBrowserScripts(['js/portfolio_snapshot_schema.js','js/portfolio_snapshot_core.js','js/portfolio_snapshot_ocr.js']);
const O=c.OptionComboPortfolioSnapshotOcr,S=c.OptionComboPortfolioSnapshotSchema;
const raw=JSON.parse(fs.readFileSync(arg('--raw'))),base=O.normalize(raw,'x'),reports=[];
for(const delta of [.015,.025,.04]){
    const moved=JSON.parse(JSON.stringify(raw));
    function walk(value){if(!value||typeof value!=='object')return;for(const [key,v] of Object.entries(value)){
        if(['bbox','cropBbox','inkBbox','originalBbox','observationBbox','ruleBbox'].includes(key)&&Array.isArray(v)){v[0]=(v[0]+(v[0]>.4?delta:0))/(1+delta);v[2]/=1+delta;}
        else if(typeof v==='object')walk(v);
    }}walk(moved);
    try{
        const layout=O.detectLayout(moved.words,moved.headerRereads||[]);
        // A fresh cell request would use the new interval; the glyph observations move with the row.
        for(const crop of moved.quantityRereads||[]){crop.cropBbox[0]=layout.edges[4];crop.cropBbox[2]=layout.edges[5]-layout.edges[4];}
        const after=O.normalize(moved,'x'),differences=[];
        if(after.positions.length!==base.positions.length)differences.push({field:'positionCount'});
        for(let i=0;i<base.positions.length;i++)for(const f of S.FIELDS)if(S.get(base.positions[i],f.path)!==S.get(after.positions[i],f.path))differences.push({row:i+1,field:f.path});
        reports.push({delta,accepted:true,differences});
    }catch(e){if(!/^(?:表头无法确认|识别结果不是有效)/.test(e.message))throw e;reports.push({delta,accepted:false,reason:e.message,differences:[]});}
}
const output=path.resolve(arg('--output'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({scope:'OCR-coordinate perturbation, not rerendered pixels',reports},null,2));
for(const r of reports)console.log(`delta=${r.delta}: ${r.accepted?'accepted':'rejected'}; field differences=${r.differences.length}`);
process.exitCode=reports.some(r=>r.differences.length)?1:0;
