const fs=require('fs'),vm=require('vm'),path=require('path');
const ROOT=path.resolve(__dirname,'../../..');
const {loadBrowserScripts}=require(path.join(ROOT,'tests/helpers/load-browser-scripts'));
const c=loadBrowserScripts(['js/cost_basis_core.js','js/cost_basis_import.js','js/cost_basis.js']);
let resolveRequest;
const writes=[];
const request=(action,payload)=>{
 if(action==='request_cost_basis_executions')return new Promise(r=>resolveRequest=r);
 writes.push({action,payload});
 return Promise.resolve({inserted:payload.events?.length||0,skipped:0});
};
vm.runInContext(fs.readFileSync(path.join(ROOT,'js/cost_basis.js'),'utf8').replace('globalScope.OptionComboCostBasisPage = {',`
globalScope.auditHarness={state,fetch:_fetchTwsExecutions,commit:_commitImport,readFile:_handleImportFile,
configure(fn){request=fn;_refreshControls=()=>{};_renderReconciliation=()=>{};_renderImportPreview=()=>{};_refreshResetPlan=async()=>{};_loadBooks=async()=>{};}};
globalScope.OptionComboCostBasisPage = {`),c);
const nodes=new Map();
c.document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:false,textContent:'',hidden:false});return nodes.get(id);}};
c.confirm=()=>true;c.alert=()=>{};
const h=c.auditHarness;h.configure(request);
const a={bookId:'A',account:'U1111111',symbol:'TQQQ',secType:'STK'},b={bookId:'B',account:'U1111111',symbol:'QQQ',secType:'STK'};
Object.assign(h.state,{bookId:'A',books:[a,b],allEvents:[],ledger:c.OptionComboCostBasisCore.computeLedger([])});
(async()=>{
 const pending=h.fetch();
 // User selects another book while the read-only broker request is in flight.
 Object.assign(h.state,{bookId:'B',allEvents:[],ledger:c.OptionComboCostBasisCore.computeLedger([]),importResult:null,importText:''});
 resolveRequest({executions:[{execId:'source-A',account:'U1111111',symbol:'TQQQ',secType:'STK',side:'BOT',quantity:10,price:50,brokerTimestamp:'2026-09-01T10:00:00',commission:1,commissionCurrency:'USD',commissionAvailable:true}],fetchedAt:'2026-09-01T12:00:00'});
 await pending;
 await h.commit();
 console.log('TWS_RESULT_AFTER_BOOK_SWITCH',JSON.stringify(writes));
 // A new file load leaves the old, committable preview intact.
 h.state.bookId='A';h.state.importResult={format:'activity',events:[{kind:'share_trade',account:'U1111111',tradeDate:'2026-09-01',shares:10,price:50,cashAmount:-501,fees:1,source:'csv_import',externalRef:'old-file'}],problems:[]};
 c.FileReader=class{readAsText(){ /* emulate slow or failed read */ }};
 h.readFile({target:{files:[{name:'new-file.csv'}]}});
 console.log('OLD_PREVIEW_DURING_NEW_READ',JSON.stringify({summary:nodes.get('import-summary').textContent,oldRef:h.state.importResult.events[0].externalRef}));
 await h.commit();
 console.log('OLD_FILE_COMMITTED_WHILE_READING_NEW',JSON.stringify(writes.at(-1)));
})();
