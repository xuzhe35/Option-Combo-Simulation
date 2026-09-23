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
function inspect(name,text,existing=[],replacing=false){setup(existing);c.document.getElementById('import-replace').checked=replacing;h.parse(text,{fileName:name+'.csv',fileDigest:'test'});const r=h.state.importResult;const out={problems:r.problems.map(e=>e.reason),newRows:h.newRows(r),duplicates:r.confirmedDuplicates,stubs:r.supersedePriorStubEventIds,counts:h.counts(r),warnings:r.ledgerPreview?.warnings};fixture[name]={existing,incoming:out.newRows,supersedePriorStubEventIds:out.stubs,problems:out.problems,warnings:out.warnings};return r;}

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
const cashKnown=I.parse(divs,opt).events.map((e,i)=>({...e,eventId:'cash-old-'+i,seq:i+1}));
const cashCumulative=inspect('CASH_SAME_DAY_ADDITION',divs+'\nDividends,Data,USD,2026-09-01,TQQQ extra dividend,5',cashKnown);
assert.equal(cashCumulative.problems.length,0);
assert.equal(h.newRows(cashCumulative).length,1);

const rebuildText=activity([
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 11SEP26 71.5 C,"2026-09-10, 10:10:09",-3,0.35,105,-2.061933,O',
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 11SEP26 71.5 C,"2026-09-11, 16:20:00",3,0,0,0,C;Ep',oh]);
const rebuildRows=I.parse(rebuildText,opt).events.map((e,i)=>stored(e,'rebuild-old-'+i));
const rebuildPartial=inspect('REBUILD_KNOWN_OPEN',rebuildText,[rebuildRows[0]],true);
const rebuildAll=inspect('REBUILD_ALL_KNOWN',rebuildText,rebuildRows,true);
const rebuildInactive=inspect('REBUILD_INACTIVE_KNOWN',rebuildText,
 rebuildRows.map(e=>({...e,voidedAtUtc:'2026-09-12T00:00:00Z',includeInCost:false})),true);
const appendAll=inspect('APPEND_ALL_KNOWN',rebuildText,rebuildRows);
const sameTimeText=rebuildText.replace('2026-09-11, 16:20:00','2026-09-10, 10:10:09');
const sameTimeOpen=stored(I.parse(sameTimeText,opt).events[0],'same-time-open');
const sameTimeAppend=inspect('APPEND_SAME_TIME_CLOSE',sameTimeText,[sameTimeOpen]);
const sameSecondFills=activity([
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 11SEP26 71.5 C,"2026-09-10, 10:10:09",2,1,-200,0,O',
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 11SEP26 71.5 C,"2026-09-10, 10:10:09",-1,2,200,0,C']);
const knownSameSecond=stored(I.parse(sameSecondFills,opt).events[0],'known-same-second');
const sameSecondAppend=inspect('APPEND_DISTINCT_SAME_SECOND',sameSecondFills,[knownSameSecond]);
assert.equal(sameSecondAppend.problems.length,0,'the file preserves the old row and adds a distinct fill');
assert.equal(h.newRows(sameSecondAppend).length,1);
assert.equal(sameSecondAppend.ledgerPreview.warnings.length,0);

// Portable reproduction of a buy-two / sell-four C;O;P order. Keep the
// aggregate cash once; do not duplicate an order by splitting its source ref.
const reversalText=activity([
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 21SEP26 71 C,"2026-09-18, 14:23:30",2,1.18,-236,-1.3666,O',
 'Trades,Data,Order,Equity and Index Options,USD,TQQQ 21SEP26 71 C,"2026-09-18, 14:23:59",-4,1.16,464,-1.7999184,C;O;P',
 oh,'Open Positions,Data,Summary,Equity and Index Options,USD,TQQQ 21SEP26 71 C,-2,100,-230.6220408']);
const reversalParsed=I.parse(reversalText,opt);
const reversalExisting=reversalParsed.events.map((e,i)=>({...e,eventId:'reversal-'+i,seq:i+1}));
for(const [name,existing,rebuild] of [
 ['MIXED_REVERSAL_FRESH',[],false],
 ['MIXED_REVERSAL_APPEND',[reversalExisting[0]],false],
 ['MIXED_REVERSAL_REBUILD',reversalExisting,true],
 ['MIXED_REVERSAL_REPEAT',reversalExisting,false],
]) {
 const result=inspect(name,reversalText,existing,rebuild);
 assert.equal(result.problems.length,0,name);
 assert.equal(result.ledgerPreview.warnings.length,0,name);
 assert.ok(result.ledgerPreview.positions.every(p=>p.after===p.statement),name);
 if(name==='MIXED_REVERSAL_REPEAT') assert.equal(h.newRows(result).length,0);
 else assert.equal(h.newRows(result).filter(e=>e.tag==='ibkr_close_open').length,1);
}
// C/O parent aggregates multiple fills, some already recorded via TWS.
function mixedPartialCase(name, opening, quantities, recordedIndices, sameSecond=false) {
 const total=quantities.reduce((n,q)=>n+q,0), final=opening+total;
 const trade=(type,q,time,code)=>`Trades,Data,${type},Equity and Index Options,USD,TQQQ 16OCT26 71 C,"2026-09-18, ${time}",${q},1,${-q*100},-1,${code}`;
 const openText=trade('Order',opening,'09:00:00','O');
 const parent=trade('Order',total,'10:00:00','C;O;P').replace(',-1,C;O;P',`,${-quantities.length},C;O;P`);
 const fills=quantities.map((q,i)=>trade('Trade',q,`10:00:${String(sameSecond?0:i).padStart(2,'0')}`,'C;O;P'));
 const text=activity([openText,parent,...fills,oh,
  ...(final?[`Open Positions,Data,Summary,Equity and Index Options,USD,TQQQ 16OCT26 71 C,${final},100,${final*100}`]:[])]);
 const known=I.parse(activity([openText]),opt).events[0];
 const existing=[{...known,eventId:name+'-opening',seq:1}];
 recordedIndices.forEach((i,n)=>existing.push({...known,source:'execution_report',tag:'ibkr_exec',
  contracts:quantities[i],price:1,fees:1,cashAmount:-quantities[i]*100-1,
  tradeDate:'2026-09-18',brokerTimestamp:`2026-09-18T10:00:${String(sameSecond?0:i).padStart(2,'0')}`,
  externalRef:`ibkr-exec-${name}-${i}`,eventId:`${name}-stored-${i}`,seq:n+2}));
 const result=inspect(name,text,existing);
 fixture[name].expected={contracts:final,netCash:-final*100-1-quantities.length};
 return result;
}
const mixedPartial = mixedPartialCase('MIXED_PARTIAL_TWS',2,[-2,-2],[0]);
mixedPartialCase('MIXED_PARTIAL_CROSS',2,[-1,-2,-1],[0]);
mixedPartialCase('MIXED_PARTIAL_CLOSE',3,[-1,-1,-3],[1]);
mixedPartialCase('MIXED_PARTIAL_SHORT',-2,[1,2,1],[2]);
mixedPartialCase('MIXED_PARTIAL_SAME_SECOND',2,[-1,-2,-1],[1],true);

// Deterministic fuzzing of the previously absent combination: parent order,
// child fills and a nonempty proper subset already booked from TWS.
let partialSeed=23092026;
const partialRandom=()=>{partialSeed=(Math.imul(partialSeed,1664525)+1013904223)>>>0;return partialSeed/4294967296;};
for(let trial=0;trial<240;trial++) {
 const sizes=Array.from({length:2+Math.floor(partialRandom()*5)},()=>1+Math.floor(partialRandom()*4));
 const sign=partialRandom()<0.5?1:-1, sum=sizes.reduce((n,q)=>n+q,0);
 const opening=sign*(1+Math.floor(partialRandom()*(sum-1)));
 const recorded=sizes.map((q,i)=>i).filter(()=>partialRandom()<0.5);
 if(!recorded.length)recorded.push(0);
 if(recorded.length===sizes.length)recorded.pop();
 mixedPartialCase(`MIXED_PARTIAL_RANDOM_${trial}`,opening,sizes.map(q=>-sign*q),recorded,trial%3===0);
}

mixedPartialCase('INVALID_PARTIAL_NOT_REVERSING',4,[-2,-2],[0]);
mixedPartialCase('INVALID_PARTIAL_SAME_DIRECTION',2,[2,2],[0]);

// Opt-in local statement regression: no private report is required in CI or copied into fixtures.
if(process.env.COST_BASIS_FULL_STATEMENT_CSV) {
 const text=fs.readFileSync(process.env.COST_BASIS_FULL_STATEMENT_CSV,'utf8');
 const discovery=I.parse(text,{symbol:'TQQQ'});
 const sourceBook={bookId:'book',account:discovery.account,symbol:'TQQQ',currency:'USD',secType:'STK',defaultSharesPerContract:100};
 setup();h.state.books=[sourceBook];c.document.getElementById('import-replace').checked=true;
 h.parse(text,{fileName:'full-statement.csv',fileDigest:'local-regression'});
 const fresh=h.state.importResult,complete=h.newRows(fresh);
 assert.equal(fresh.problems.length,0);
 assert.equal(fresh.ledgerPreview.warnings.length,0);
 const existing=fresh.events.filter(e=>e.tradeDate<fresh.statementPeriod.through).map((e,i)=>({...e,eventId:'old-'+i,seq:i+1}));
 Object.assign(h.state,{allEvents:existing,ledger:C.computeLedger(existing)});
 h.parse(text,{fileName:'full-statement.csv',fileDigest:'local-regression'});
 const result=h.state.importResult, incoming=h.newRows(result);
 assert.equal(result.problems.length,0);assert.equal(result.ledgerPreview.warnings.length,0);
 assert.equal(h.counts(result).existing,0);assert.equal(incoming.length,complete.length);
 assert.ok(result.ledgerPreview.positions.every(p=>p.statement===null||Math.abs(p.after-p.statement)<1e-6));
 const ledger=C.computeLedger(incoming);
 fixture.FULL_STATEMENT_REBUILD={book:sourceBook,existing,incoming,expected:{shares:ledger.combined.shares,netCash:ledger.combined.netCash,closingOptions:result.openings.closingOptions}};
 // Re-importing the rebuilt statement in append mode must be an exact no-op.
 Object.assign(h.state,{allEvents:incoming.map((e,i)=>({...e,eventId:'rebuilt-'+i,seq:i+1})),ledger});
 c.document.getElementById('import-replace').checked=false;h.parse(text,{fileName:'full-statement.csv',fileDigest:'local-regression'});
 assert.equal(h.state.importResult.problems.length,0);
 assert.equal(h.newRows(h.state.importResult).length,0);
 assert.equal(h.state.importResult.ledgerPreview.warnings.length,0);
}
const statements = [...['SAME_REF_REVISION','DIRECT_EXEC_REVISION','REUSED_CROSS_FORMAT_TWIN',
 'QUANTITY_REVISION','DATE_ONLY_TWIN','ORDER_FILL_CASH_MISMATCH','BAD_POSITION_SYMBOL',
 'ZERO_TRADE_TWS_ROUNDTRIP','MANUAL_ASSIGNMENT_TWIN','MISSING_CURRENCY','CASH_REVISION']];
function verify() {
 for(const name of ['INVALID_PARTIAL_NOT_REVERSING','INVALID_PARTIAL_SAME_DIRECTION'])
  assert.ok(fixture[name].problems.some(p=>p.includes('C/O')),name);
 for(const name of Object.keys(fixture).filter(n=>n.startsWith('MIXED_PARTIAL_'))) {
  assert.equal(fixture[name].problems.length,0,name);
  const r=fixture[name];
  assert.deepEqual(Array.from(r.warnings),[],name);
  assert.deepEqual(Array.from(C.computeLedger(r.existing.concat(r.incoming.map((e,i)=>({...e,seq:r.existing.length+i+1})))).combined.warnings),[],name);
 }
 assert.equal(h.newRows(mixedPartial)[0].tag,'ibkr_open');
 for(const result of [rebuildPartial,rebuildAll,rebuildInactive]) {
  assert.equal(result.binding.mode,'rebuild');
  assert.equal(result.problems.length,0);
  assert.equal(h.counts(result).existing,0,'rebuild must retain rows that the old ledger will archive');
  assert.equal(h.newRows(result).length,2);
  assert.equal(result.ledgerPreview.warnings.length,0,'known opening must precede the new expiry');
  const ledger=C.computeLedger(h.newRows(result));
  assert.equal(ledger.openOptions.length,0);
  assert.equal(ledger.combined.netCash,102.938067);
 }
 assert.equal(h.counts(appendAll).existing,2,'append still skips existing statement rows');
 assert.equal(h.newRows(appendAll).length,0);
 assert.equal(sameTimeAppend.problems.length,0);
 assert.equal(h.newRows(sameTimeAppend).length,1);
 assert.equal(sameTimeAppend.ledgerPreview.warnings.length,0,
  'preview must use the same insertion sequence as the store for same-second trades');
 assert.ok(sameTimeAppend.ledgerPreview.positions.every(p=>p.after===p.statement));
 setup([]);
 h.state.books[0].secType='FUT';h.state.books[0].symbol='ES';h.state.books[0].defaultSharesPerContract=50;
 const future={kind:'futures_trade',account,tradeDate:'2026-09-01',futureExpiry:'202609',futureContracts:1,sharesPerContract:50,price:5100,cashAmount:-2,fees:2,source:'csv_import',externalRef:'future-1'};
 const preview=h.preview({events:[future],openings:{closingFutures:[{account,futureExpiry:'202609',sharesPerContract:50,quantity:1}]}},false,[]);
 const position=preview.positions.find(p=>p.key.startsWith('future-'));
 assert.equal(position.before,0);assert.equal(position.after,1);assert.equal(position.statement,1);

 // Stored history already strands one close (a legacy overdraw row the store
 // accepted). That is reported but cannot block an unrelated row; a second
 // stranded close is introduced by this batch and still blocks.
 const legacyClose={kind:'option_expiry',account,tradeDate:'2026-08-21',right:'P',strike:40,
  expiry:'20260821',sharesPerContract:100,contracts:1,price:0,fees:0,cashAmount:0,eventId:'legacy',seq:1};
 setup([legacyClose]);
 const unrelated=h.preview({events:[{kind:'share_trade',account,tradeDate:'2026-09-01',
  brokerTimestamp:'2026-09-01T10:00:00',shares:10,price:50,fees:1,cashAmount:-501,
  source:'csv_import',externalRef:'unrelated-share'}]},false,[]);
 assert.ok(unrelated.warnings.some(w=>w.startsWith('closes_more_than_open:')));
 assert.equal(P.importReplayBlockingWarnings({ledgerPreview:unrelated}).length,0);
 assert.equal(P.importReplayNotices({ledgerPreview:unrelated}).length,1);
 const stranded=h.preview({events:[{...legacyClose,kind:'option_trade',tag:'ibkr_close',
  tradeDate:'2026-08-20',brokerTimestamp:'2026-08-20T10:00:00',source:'csv_import',
  externalRef:'second-close',eventId:undefined,seq:undefined}]},false,[]);
 assert.equal(P.importReplayBlockingWarnings({ledgerPreview:stranded}).length,1);

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
