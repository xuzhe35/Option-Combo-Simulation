// No live browser or server. Invoke real asynchronous page handlers with controlled responses.
const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
const {loadBrowserScripts}=require(path.join(ROOT,'tests/helpers/load-browser-scripts'));
const c=loadBrowserScripts(['js/cost_basis_core.js','js/cost_basis_import.js','js/cost_basis.js']);
vm.runInContext(fs.readFileSync(path.join(ROOT,'js/cost_basis.js'),'utf8').replace('globalScope.OptionComboCostBasisPage = {',`
globalScope.auditHarness={state,fetch:_fetchTwsExecutions,commit:_commitImport,readFile:_handleImportFile,load:_loadEvents,
configure(fn){request=fn;_refreshControls=()=>{};_renderReconciliation=()=>{};_renderImportPreview=()=>{};_refreshResetPlan=async()=>{};_loadBooks=async()=>{};_syncBookMode=()=>{};_renderBookMeta=()=>{};_recompute=()=>{};}};
globalScope.OptionComboCostBasisPage = {`),c);
const nodes=new Map();
c.document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:false,textContent:'',hidden:false});return nodes.get(id);}};
c.confirm=()=>true;c.alert=()=>{};
const h=c.auditHarness;
const a={bookId:'A',account:'U1111111',symbol:'TQQQ',secType:'STK'},b={bookId:'B',account:'U1111111',symbol:'QQQ',secType:'STK'};
Object.assign(h.state,{bookId:'A',books:[a,b],allEvents:[],ledger:c.OptionComboCostBasisCore.computeLedger([])});
async function verify(){
 let resolveRequest;const writes=[];
 h.configure((action,payload)=>{
  if(action==='request_cost_basis_executions')return new Promise(r=>resolveRequest=r);
  writes.push({action,payload});return Promise.resolve({inserted:0,skipped:0});
 });
 const pending=h.fetch();
 Object.assign(h.state,{bookId:'B',allEvents:[],ledger:c.OptionComboCostBasisCore.computeLedger([]),importResult:null,importText:''});
 resolveRequest({executions:[{execId:'source-A',account:'U1111111',symbol:'TQQQ',secType:'STK',side:'BOT',quantity:10,price:50,brokerTimestamp:'2026-09-01T10:00:00',commission:1,commissionCurrency:'USD',currency:'USD',commissionAvailable:true}],fetchedAt:'2026-09-01T12:00:00'});
 await pending;await h.commit();
 assert.equal(h.state.importResult,null);assert.equal(writes.length,0);
 h.state.bookId='A';h.state.importResult={format:'activity',events:[{externalRef:'old-file'}],problems:[]};
 c.FileReader=class{readAsText(){}};
 h.readFile({target:{files:[{name:'new-file.csv'}]}});
 assert.equal(h.state.importResult,null);
 await h.commit();assert.equal(writes.length,0);
 Object.assign(h.state,{bookId:'A',importText:'',importReading:false});
 const row=(eventId)=>({eventId,account:'U1111111',kind:'share_trade',tradeDate:'2026-09-01',shares:1,price:1,cashAmount:-1});
 let calls=0;
 h.configure(async(action,payload)=>{
  assert.equal(action,'list_cost_basis_events');calls++;
  if(calls===1)return {events:Array.from({length:1000},(_,i)=>row('old-'+i)),total:1001,ledgerVersion:{digest:'before-rebuild'}};
  return {events:[row('new-1000')],total:1001,ledgerVersion:{digest:'after-rebuild'}};
 });
 await assert.rejects(h.load(),/分页读取/);
 assert.equal(h.state.allEvents.length,0);
 assert.equal(h.state.ledgerVersion,null);
 const checks={period:true,account:true,openPositions:true,revision:true,twsCoverage:true};
 const batches=[{periodFrom:'2026-08-01',periodThrough:'2026-08-31',checks:{}},
                {periodFrom:'2026-09-01',periodThrough:'2026-09-30',checks}];
 const coverage=c.OptionComboCostBasisPage.describeStatementCoverage(batches);
 assert.equal(coverage.covered.length,1);
 assert.equal(coverage.covered[0].from,'2026-09-01');
 assert.equal(coverage.covered[0].through,'2026-09-30');
}
module.exports={name:'cost_basis_import_async_integrity',tests:[{name:'stale broker/files and mixed-version pages never arm imports; unchecked months are not coverage',run:verify}]};
if(require.main===module)verify().catch(error=>{console.error(error);process.exitCode=1;});
