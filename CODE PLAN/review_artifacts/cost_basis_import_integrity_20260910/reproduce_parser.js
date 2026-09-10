const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const {loadBrowserScripts} = require(path.join(ROOT, 'tests/helpers/load-browser-scripts'));
const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Pass a temporary fixture JSON output path');
const c = loadBrowserScripts(['js/cost_basis_core.js','js/cost_basis_import.js','js/cost_basis.js']);
const I=c.OptionComboCostBasisImport, P=c.OptionComboCostBasisPage;
const core=c.OptionComboCostBasisCore;
const opts={symbol:'TQQQ',targetAccount:'U1111111',accountFallback:'U1111111',defaultSharesPerContract:100,openingDate:'2026-08-31'};
const H='Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code';
const OH='Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Multiplier,Cost Basis';
const stock=(q=10,p=50,comm=-1,codes='O',currency='USD')=>`Trades,Data,Order,Stocks,${currency},TQQQ,"2026-09-01, 10:00:00",${q},${p},${-q*p},${comm},${codes}`;
const opt=(q=-1,date='2026-09-01, 10:00:00',price=2,codes='O')=>`Trades,Data,Order,Equity and Index Options,USD,TQQQ 16OCT26 50 P,"${date}",${q},${price},${-q*price*100},0,${codes}`;
const parse=(lines,extra={})=>I.parse([H,...lines].join('\n'),{...opts,...extra});
const summary=r=>({problems:r.problems,events:r.events.map(e=>({kind:e.kind,qty:e.shares??e.contracts,cash:e.cashAmount,ref:e.externalRef,tag:e.tag})),openings:r.openings});
const stored=(e,id)=>({...e,eventId:id,seq:1});
const fixtures={};
// Same two CSV rows match distinct TWS executions, then lose the second alias during final parsing.
const duplicate=parse([stock(),stock()]);
const fills=duplicate.events.map((e,i)=>stored({...e,source:'execution_report',tag:'ibkr_exec',externalRef:`ibkr-exec-fill${i+1}`},`e${i+1}`));
const alias=P.planExecutionReportAliases(duplicate,fills);
const reparsed=parse([stock(),stock()],{externalRefAliases:alias.aliases,existingExternalRefs:fills});
console.log('IDENTICAL_ROW_ALIAS',JSON.stringify({discovery:duplicate.events.map(e=>e.externalRef),aliases:alias.aliases,final:reparsed.events.map(e=>e.externalRef),problems:reparsed.problems}));
fixtures.alias={existing:fills,incoming:reparsed.events};
// Existing TWS trade that is absent from the report is never reconciled.
const absent=stored({...parse([opt()]).events[0],source:'execution_report',tag:'ibkr_exec',externalRef:'ibkr-exec-extra'},'extra');
const empty=parse([OH]);
const base=P.buildImportBaseline(false,core.computeLedger([absent]),[absent],'2026-09-30T23:59:59');
const extraResult=parse([OH],base);
console.log('UNMATCHED_EXISTING_OPTION',JSON.stringify({aliases:P.planExecutionReportAliases(empty,[absent]),result:summary(extraResult)}));
// Missing share basis produces only a warning, not a blocking problem.
const noBasis=parse([stock(-100,50,0,'C'),OH]);
console.log('MISSING_SHARE_BASIS',JSON.stringify(summary(noBasis)));
fixtures.shareGap={existing:[],incoming:noBasis.events};
// Tax refund sign and dividend reversal.
const cash=parse(['Withholding Tax,Header,Currency,Date,Description,Amount',
 'Withholding Tax,Data,USD,2026-09-01,TQQQ tax refund,3',
 'Dividends,Header,Currency,Date,Description,Amount',
 'Dividends,Data,USD,2026-09-01,TQQQ dividend reversal,-10']);
console.log('CASH_REVERSALS',JSON.stringify(summary(cash)));
// Currency is discarded; missing fees accepted.
console.log('CURRENCY_IGNORED',JSON.stringify(summary(parse([stock(10,50,-1,'O','EUR')]))));
console.log('MISSING_COMMISSION',JSON.stringify(summary(parse([stock(10,50,'')]))));
// A genuine earlier opening never replaces its synthetic opening.
const later=parse([opt(1,'2026-09-02, 10:00:00',1,'C'),OH]);
const previous=[...later.openings.drafts,...later.events].map((e,i)=>stored(e,`prior${i}`));
const before=parse([opt(-1,'2026-08-10, 10:00:00',2,'O')]);
const olderBase=P.buildImportBaseline(false,core.computeLedger(previous),previous,before.statementThrough);
const older=parse([opt(-1,'2026-08-10, 10:00:00',2,'O')],olderBase);
fixtures.prior={existing:previous,incoming:older.events};
console.log('PRIOR_THEN_OLDER',JSON.stringify({before:core.computeLedger(previous).openOptions,after:core.computeLedger([...previous,...older.events]).openOptions,problems:older.problems}));
// Missing commissions later corrected are a new identity.
const v1=parse([stock(10,50,'')]),v2=parse([stock(10,50,-1)]);
fixtures.revision={existing:v1.events,incoming:v2.events};
console.log('COMMISSION_REVISION',JSON.stringify({v1:v1.events[0].externalRef,v2:v2.events[0].externalRef}));
// Same-day/adjacent-day genuine unmatched order blocked despite already stored CSV.
const oldCsv=parse([stock()]).events[0];
const nextFill={...fills[0],brokerTimestamp:'2026-09-02T10:00:00',tradeDate:'2026-09-02',externalRef:'ibkr-exec-nextday'};
console.log('ADJACENT_GENUINE',JSON.stringify(P.planExecutionReportAliases({format:'activity',events:[oldCsv]},[stored(oldCsv,'csv'),nextFill])));

const rebate=core.buildExecutionImport([{execId:'rebate1',account:opts.targetAccount,symbol:'TQQQ',secType:'STK',side:'BOT',quantity:10,price:50,brokerTimestamp:'2026-09-01T10:00:00',commission:-0.1,commissionCurrency:'USD',commissionAvailable:true}],{account:opts.targetAccount,symbol:'TQQQ'});
fixtures.rebate={existing:[],incoming:rebate.events};
console.log('TWS_REBATE_PREVIEW',JSON.stringify(summary(rebate)));
// Equity option end positions fail to adopt instrument-table multipliers.
const adjusted=parse([
 'Financial Instrument Information,Header,Asset Category,Symbol,Description,Conid,UnderlyingSymbol,Multiplier',
 'Financial Instrument Information,Data,Equity and Index Options,TQQQ 16OCT26 50 P,TQQQ 16OCT26 50 P,99,TQQQ,10',
 opt(-1).replace(',2,200,0,O',',2,20,0,O'),OH,
 'Open Positions,Data,Summary,Equity and Index Options,USD,TQQQ 16OCT26 50 P,-1,,-20',
]);
console.log('ADJUSTED_POSITION_MULTIPLIER',JSON.stringify(summary(adjusted)));
// Non-USD commission still gets used directly as book cash.
console.log('TWS_FOREIGN_COMMISSION',JSON.stringify(core.buildExecutionImport([{execId:'fx',account:opts.targetAccount,symbol:'TQQQ',secType:'STK',side:'BOT',quantity:10,price:50,brokerTimestamp:'2026-09-01T10:00:00',commission:100,commissionCurrency:'JPY',commissionAvailable:true}],{account:opts.targetAccount,symbol:'TQQQ',currency:'USD'}).events));
// FUT roll is a merged event not included in CSV-vs-execution alias matching.
const fh='ClientAccountID,UnderlyingSymbol,Symbol,AssetClass,TradeDate,Quantity,TradePrice,Proceeds,IBCommission,Expiry,Multiplier,TradeID,Notes/Codes';
const fr=I.parse([fh,'U1111111,ES,ESU6,FUT,20260901;100000,-2,6000,0,-2,202609,50,r1,C','U1111111,ES,ESZ6,FUT,20260901;100000,2,6010,0,-2,202612,50,r2,O'].join('\n'),{...opts,symbol:'ES',secType:'FUT',defaultSharesPerContract:50});
const fut=(month,n,price,ref,date='2026-09-01')=>({kind:'futures_trade',account:opts.targetAccount,tradeDate:date,brokerTimestamp:`${date}T10:00:00`,futureExpiry:month,futureLocalSymbol:month==='202609'?'ESU6':'ESZ6',futureContracts:n,sharesPerContract:50,price,fees:2,cashAmount:-2,source:'execution_report',tag:'ibkr_exec',externalRef:ref,eventId:ref});
const futures=[fut('202609',5,5990,'ibkr-exec-initial','2026-08-01'),fut('202609',-2,6000,'ibkr-exec-old'),fut('202612',2,6010,'ibkr-exec-new')];
fixtures.futuresRoll={secType:'FUT',symbol:'ES',existing:futures,incoming:fr.events};
console.log('FUTURES_ROLL_MATCH',JSON.stringify({result:summary(fr),aliases:P.planExecutionReportAliases(fr,futures)}));
console.log('FUTURES_ROLL_POSITIONS',JSON.stringify({before:core.computeLedger(futures,{secType:'FUT'}).openFutures,after:core.computeLedger([...futures,...fr.events],{secType:'FUT'}).openFutures}));
const excluded={...parse([opt(-1)]).events[0],includeInCost:false};
const closing=parse([opt(1,'2026-09-02, 10:00:00',1,'C')]).events[0];
fixtures.excludedOpening={existing:[excluded],incoming:[closing]};
console.log('EXCLUDED_OPENING_CORE',JSON.stringify(core.computeLedger([excluded,closing]).combined));


fs.writeFileSync(fixturePath,JSON.stringify(fixtures));
