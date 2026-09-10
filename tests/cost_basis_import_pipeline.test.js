const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('node:assert/strict');
// Isolated VM only: invokes current page/parser logic; no browser, network or real ledger.
const ROOT=path.resolve(__dirname,'..');

const {loadBrowserScripts}=require(path.join(ROOT,'tests/helpers/load-browser-scripts'));
const c=loadBrowserScripts(['js/cost_basis_core.js','js/cost_basis_import.js','js/cost_basis.js']);
vm.runInContext(fs.readFileSync(path.join(ROOT,'js/cost_basis.js'),'utf8').replace('globalScope.OptionComboCostBasisPage = {',`
globalScope.h={state,preview:_computeLedgerPreview,parse:_parseImportText,newRows:_importNewRows,counts:_importCounts,commit:_commitImport,
configure(fn){request=fn;_refreshControls=()=>{};_refreshResetPlan=async()=>{};_renderImportPreview=()=>{};_loadBooks=async()=>{};}};
globalScope.OptionComboCostBasisPage = {`),c);
const nodes=new Map();c.document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false});return nodes.get(id);}};
c.alert=()=>{};c.confirm=()=>true;
const I=c.OptionComboCostBasisImport,C=c.OptionComboCostBasisCore,P=c.OptionComboCostBasisPage,h=c.h;
const account='U1111111',opt={symbol:'TQQQ',targetAccount:account,accountFallback:account,currency:'USD',defaultSharesPerContract:100};
const header='Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code';
const ah='Account Information,Header,Field Name,Field Value\nAccount Information,Data,Account,U1111111';
const oh='Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Multiplier,Cost Basis';
const line=(q=10,price=50,comm=-1)=>`Trades,Data,Order,Stocks,USD,TQQQ,"2026-09-01, 10:00:00",${q},${price},${-q*price},${comm},O`;
const activity=(rows,period=true)=>[ah,period?'Statement,Data,Period,"September 1, 2026 - September 30, 2026"':'',header,...rows].filter(Boolean).join('\n');
const flex=(q=10,price=50,id='F1',comm=-1)=>['ClientAccountID,UnderlyingSymbol,Symbol,AssetClass,TradeDate,Quantity,TradePrice,Proceeds,IBCommission,TradeID,Notes/Codes,Currency',`${account},TQQQ,TQQQ,STK,20260901;100000,${q},${price},${-q*price},${comm},${id},O,USD`].join('\n');
const stored=(e,id)=>({...e,eventId:id,seq:1});
const raw=I.parse(activity([line()],false),opt).events[0];
const fixture={};
function setup(events=[]){Object.assign(h.state,{bookId:'book',books:[{bookId:'book',account,symbol:'TQQQ',currency:'USD',secType:'STK',defaultSharesPerContract:100}],allEvents:events,ledger:C.computeLedger(events),ledgerVersion:{digest:'test'},importGeneration:1,importCommitTokens:null,importCommitPending:false});nodes.get('import-replace')&&(nodes.get('import-replace').checked=false);}
function inspect(name,text,existing=[]){setup(existing);h.parse(text,{fileName:name+'.csv',fileDigest:'test'});const r=h.state.importResult;const out={problems:r.problems.map(e=>e.reason),newRows:h.newRows(r),duplicates:r.confirmedDuplicates,stubs:r.supersedePriorStubEventIds,counts:h.counts(r),warnings:r.ledgerPreview?.warnings};fixture[name]={existing,incoming:out.newRows,supersedePriorStubEventIds:out.stubs,problems:out.problems};return r;}

// Fixed original R03: identical source rows claim two distinct TWS fills.
const tws=(base,id)=>stored({...base,source:'execution_report',tag:'ibkr_exec',externalRef:'ibkr-exec-'+id},id);
inspect('FIXED_IDENTICAL_TWS',activity([line(),line()]),[tws(raw,'A'),tws(raw,'B')]);
inspect('FIXED_SHARE_GAP',activity([line(-100,50,0),oh]));
const divs=activity(['Dividends,Header,Currency,Date,Description,Amount','Dividends,Data,USD,2026-09-01,TQQQ reversal,-10','Withholding Tax,Header,Currency,Date,Description,Amount','Withholding Tax,Data,USD,2026-09-01,TQQQ tax refund,3']);
inspect('FIXED_CASH_SIGNS',divs);
// Same-ID revisions disappear before the server's revision check.
const oldFlex=stored(I.parse(flex(),opt).events[0],'old');
inspect('SAME_REF_REVISION',flex(10,51),[oldFlex]);
// Direct exec ID bypasses economics too.
inspect('DIRECT_EXEC_REVISION',flex(20,51,'A'),[tws(raw,'A')]);
// One stored row gets re-used as the twin for two real identical rows.
inspect('REUSED_CROSS_FORMAT_TWIN',activity([line(),line()]),[oldFlex]);
// Quantity change not caught by same-quantity revision matcher.
inspect('QUANTITY_REVISION',activity([line(20)]),[stored(raw,'old')]);
// No precise timestamp: cross-format matching and revision protection skipped.
inspect('DATE_ONLY_TWIN',flex().replace('20260901;100000','20260901'),[stored(raw,'old')]);
// Filling a stub through Flex: accountFallback is absent in page options.
const stub={kind:'option_trade',account,right:'P',strike:50,expiry:'20261016',contracts:-1,sharesPerContract:100,price:0,fees:0,cashAmount:0,source:'csv_import',tag:'prior_open',externalRef:'prior-stub',eventId:'stub',tradeDate:'2026-09-01'};
const older=['ClientAccountID,UnderlyingSymbol,Symbol,AssetClass,TradeDate,Quantity,TradePrice,Proceeds,IBCommission,PutCall,Strike,Expiry,Multiplier,TradeID,Notes/Codes,Currency',`${account},TQQQ,TQQQ 16OCT26 50 P,OPT,20260801;100000,-1,2,200,0,P,50,20261016,100,real-opening,O,USD`].join('\n');
inspect('FLEX_PRIOR_STUB',older,[stub]);
// Price/cash of the child Trade rows do not reconcile with the parent Order.
const fill1=line().replace(',Order,',',Trade,');
const fill2=line(10,51).replace(',Order,',',Trade,').replace('10:00:00','10:01:00');
inspect('ORDER_FILL_CASH_MISMATCH',activity([line(20),fill1,fill2]),[tws(raw,'A')]);
// No trades + existing positions with known basis: openingDate remains blank.
inspect('NO_TRADE_INITIAL_HOLDING',[ah,'Statement,Data,Period,"September 1, 2026 - September 30, 2026"',oh,'Open Positions,Data,Summary,Stocks,USD,TQQQ,100,1,5000'].join('\n'));
// Header present but selected underlying's position name is unreadable.
inspect('BAD_POSITION_SYMBOL',activity([oh,'Open Positions,Data,Summary,Equity and Index Options,USD,TQQQ BAD OPTION,-1,100,-200']));
// Replay fixture for the repaired Activity stub supersession.
const realLine=`Trades,Data,Order,Equity and Index Options,USD,TQQQ 16OCT26 50 P,"2026-08-01, 10:00:00",-1,2,200,0,O`;
inspect('FIXED_ACTIVITY_STUB',activity([realLine],false),[stub]);

const noTrade=[ah,'Statement,Data,Period,"September 1, 2026 - September 30, 2026"',oh].join('\n');
inspect('ZERO_TRADE_TWS_ROUNDTRIP',noTrade,[tws(raw,'A'),tws({...raw,shares:-10,price:51,cashAmount:509,tradeDate:'2026-09-02',brokerTimestamp:'2026-09-02T10:00:00'},'B')]);

const assignmentText=activity([
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 16OCT26 50 P,"2026-09-01, 16:20:00",1,0,0,0,A',
 'Trades,Data,Order,Stocks,USD,TQQQ,"2026-09-01, 16:20:00",100,50,-5000,0,A']);
const assignment=I.parse(assignmentText,opt).events[0];
const manual=stored({...assignment,source:'manual',externalRef:null,brokerTimestamp:''},'manual-assignment');
const originalOpening=stored({...stub,contracts:-2,price:2,cashAmount:400,tag:'',externalRef:'original-opening',tradeDate:'2026-08-01'},'opening');
inspect('MANUAL_ASSIGNMENT_TWIN',assignmentText,[originalOpening,manual]);

assert.equal(fixture.MANUAL_ASSIGNMENT_TWIN.incoming[0].kind,'option_assignment');

inspect('UNCHANGED_SAME_REF',flex(),[oldFlex]);
inspect('UNCHANGED_DIRECT_EXEC',flex(10,50,'A'),[tws(raw,'A')]);
inspect('MISSING_CURRENCY',flex().replace(',Currency','').replace(',O,USD',',O'),[]);
inspect('VALID_PARTIAL_FILLS',activity([line(20,50,-2),fill1,fill1.replace('10:00:00','10:01:00')]),[tws(raw,'A')]);
const netHistory=activity([
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 16OCT26 50 P,"2026-08-01, 10:00:00",-2,2,400,0,O',
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 16OCT26 50 P,"2026-08-02, 10:00:00",1,1,-100,0,C'],false);
inspect('NET_PRIOR_HISTORY',netHistory,[stub]);
const cashOld=stored(I.parse(divs,opt).events[0],'dividend-old');
inspect('CASH_REVISION',divs.replace('reversal,-10','reversal,-12'),[cashOld]);
const statements = [...['SAME_REF_REVISION','DIRECT_EXEC_REVISION','REUSED_CROSS_FORMAT_TWIN',
 'QUANTITY_REVISION','DATE_ONLY_TWIN','ORDER_FILL_CASH_MISMATCH','BAD_POSITION_SYMBOL',
 'ZERO_TRADE_TWS_ROUNDTRIP','MANUAL_ASSIGNMENT_TWIN','MISSING_CURRENCY','CASH_REVISION']];
function verify() {
 setup([]);
 h.state.books[0].secType='FUT';h.state.books[0].symbol='ES';h.state.books[0].defaultSharesPerContract=50;
 const future={kind:'futures_trade',account,tradeDate:'2026-09-01',futureExpiry:'202609',futureContracts:1,sharesPerContract:50,price:5100,cashAmount:-2,fees:2,source:'csv_import',externalRef:'future-1'};
 const preview=h.preview({events:[future],openings:{closingFutures:[{account,futureExpiry:'202609',sharesPerContract:50,quantity:1}]}},false,[]);
 const position=preview.positions.find(p=>p.key.startsWith('future-'));
 assert.equal(position.before,0);assert.equal(position.after,1);assert.equal(position.statement,1);

 statements.forEach(name=>assert.ok(fixture[name].problems.length>0, name+' must block'));
 for(const name of ['FIXED_IDENTICAL_TWS','FIXED_CASH_SIGNS','FIXED_ACTIVITY_STUB',
  'FLEX_PRIOR_STUB','NO_TRADE_INITIAL_HOLDING','UNCHANGED_SAME_REF','UNCHANGED_DIRECT_EXEC',
  'VALID_PARTIAL_FILLS','NET_PRIOR_HISTORY']) assert.equal(fixture[name].problems.length,0,name);
 assert.equal(fixture.FIXED_IDENTICAL_TWS.incoming.length,0);
 assert.equal(fixture.UNCHANGED_SAME_REF.incoming.length,0);
 assert.equal(fixture.UNCHANGED_DIRECT_EXEC.incoming.length,0);
 assert.ok(fixture.FIXED_SHARE_GAP.problems.length>0);
 assert.equal(fixture.NO_TRADE_INITIAL_HOLDING.incoming[0].tradeDate,'2026-08-31');
 assert.deepEqual(Array.from(fixture.FLEX_PRIOR_STUB.supersedePriorStubEventIds),['stub']);
 assert.deepEqual(Array.from(fixture.NET_PRIOR_HISTORY.supersedePriorStubEventIds),['stub']);
 assert.equal(fixture.VALID_PARTIAL_FILLS.incoming.length,1);
 assert.equal(fixture.VALID_PARTIAL_FILLS.incoming[0].cashAmount,-501);
}
module.exports={name:'cost_basis_import_pipeline',tests:[{name:'full page import planning rejects every known incorrect write and permits repaired paths',run:verify}]};
if(require.main===module){verify();process.stdout.write(JSON.stringify(fixture));}
