// No live browser or server. Invoke real asynchronous page handlers with controlled responses.
const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
const {loadBrowserScripts}=require(path.join(ROOT,'tests/helpers/load-browser-scripts'));
const c=loadBrowserScripts(['js/cost_basis_core.js','js/cost_basis_import.js','js/cost_basis.js']);
vm.runInContext(fs.readFileSync(path.join(ROOT,'js/cost_basis.js'),'utf8').replace('globalScope.OptionComboCostBasisPage = {',`
globalScope.auditHarness={state,fetch:_fetchTwsExecutions,commit:_commitImport,readFile:_handleImportFile,load:_loadEvents,
plan:_refreshResetPlan,changeMode:_handleImportReplaceChange,parse:_parseImportText,newRows:_importNewRows,
configure(fn,realPlan=false){request=fn;_refreshControls=()=>{};_renderReconciliation=()=>{};_renderImportPreview=()=>{};_refreshResetPlan=realPlan?globalScope.auditHarness.plan:async()=>{};_loadBooks=async()=>{};_syncBookMode=()=>{};_renderBookMeta=()=>{};_recompute=()=>{};}};
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
const csv=[
 'Account Information,Header,Field Name,Field Value',
 'Account Information,Data,Account,U1111111',
 'Statement,Data,Period,"September 1, 2026 - September 11, 2026"',
 'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code',
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 11SEP26 71.5 C,"2026-09-10, 10:10:09",-3,0.35,105,-2.061933,O',
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 11SEP26 71.5 C,"2026-09-11, 16:20:00",3,0,0,0,C;Ep',
 'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Multiplier,Cost Basis',
].join('\n');
function importSetup() {
 Object.assign(a,{currency:'USD',defaultSharesPerContract:100});
 const rows=c.OptionComboCostBasisImport.parse(csv,{symbol:a.symbol,targetAccount:a.account,accountFallback:a.account,currency:'USD'}).events;
 const old={...rows[0],eventId:'old-open',seq:1};
 Object.assign(h.state,{bookId:'A',books:[a,b],allEvents:[old],ledger:c.OptionComboCostBasisCore.computeLedger([old]),
  ledgerVersion:{digest:'stable'},importText:csv,importMeta:{fileName:'complete.csv',fileDigest:'bytes'},importGeneration:10,
  importReading:false,importCommitPending:false,importCommitTokens:null,resetPlan:null});
 c.document.getElementById('import-replace').checked=true;
 h.parse(csv,h.state.importMeta);
 return {phrase:'reset test',eventCount:1,ledgerVersion:{digest:'stable'}};
}
async function verifyResetRaces() {
 const plan=importSetup();let rejectOld;
 h.configure(()=>new Promise((resolve,reject)=>{rejectOld=reject;}),true);
 const pending=h.plan();
 h.state.bookId='B';h.state.resetPlan={phrase:'new-book'};
 rejectOld(new Error('old request failed'));await pending;
 assert.equal(h.state.resetPlan.phrase,'new-book','old failure cannot clear another book plan');
 assert.equal(c.document.getElementById('import-replace').checked,true);

 importSetup();const requests=[];
 h.configure(()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),true);
 const first=h.plan();
 c.document.getElementById('import-replace').checked=false;await h.changeMode();
 c.document.getElementById('import-replace').checked=true;const second=h.changeMode();
 requests[1].resolve(plan);await second;
 requests[0].reject(new Error('obsolete request failed'));await first;
 assert.equal(h.state.resetPlan.phrase,plan.phrase);
 assert.equal(h.state.importResult.binding.mode,'rebuild');
 assert.equal(c.document.getElementById('import-replace').checked,true);

 importSetup();h.configure(async()=>{throw new Error('offline');},true);await h.plan();
 assert.equal(c.document.getElementById('import-replace').checked,false);
 assert.equal(h.state.importResult.binding.mode,'append','failure must reparse after returning to append');
 assert.equal(h.newRows(h.state.importResult).length,1);
}
async function verifyCommitAndRetry() {
 const plan=importSetup();const writes=[];let confirmations=0;
 c.confirm=()=>{confirmations++;return true;};
 h.configure(async(action,payload)=>{writes.push({action,payload});return {inserted:2,removedEvents:1};});
 await h.commit();
 assert.equal(writes.length,0);assert.equal(confirmations,0,'missing reset plan must block before confirmation');
 h.state.resetPlan=plan;
 h.configure(async(action,payload)=>{writes.push({action,payload});if(writes.length===1)throw new Error('超时');return {inserted:2,removedEvents:1};});
 await h.commit();
 assert.equal(writes.length,1);assert.ok(h.state.importCommitTokens);
 await h.commit();
 assert.equal(writes.length,2);
 assert.equal(writes[0].action,'rebuild_cost_basis_book');
 assert.equal(writes[0].payload.events.length,2,'actual submit retains the old opening plus new close');
 assert.deepEqual(writes[0].payload,writes[1].payload,'retry must send the identical replacement and tokens');
 assert.equal(h.state.importResult,null);
 c.confirm=()=>true;
}
module.exports={name:'cost_basis_import_async_integrity',tests:[
 {name:'stale broker/files and mixed-version pages never arm imports; unchecked months are not coverage',run:verify},
 {name:'obsolete reset requests cannot change a newer book or mode; failed reset returns a valid append preview',run:verifyResetRaces},
 {name:'actual rebuild commit retains known opening and retries the same complete payload',run:verifyCommitAndRetry},
]};
if(require.main===module)(async()=>{for(const t of module.exports.tests)await t.run();})().catch(error=>{console.error(error);process.exitCode=1;});
