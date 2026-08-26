const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadImport() {
    const context = loadBrowserScripts(['js/cost_basis_import.js']);
    return context.OptionComboCostBasisImport;
}

const ACTIVITY_HEADER = 'Trades,Header,DataDiscriminator,Asset Category,Currency,'
    + 'Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code';

function activity(...lines) {
    return [ACTIVITY_HEADER].concat(lines).join('\n');
}

const FLEX_HEADER = 'ClientAccountID,UnderlyingSymbol,Symbol,AssetClass,TradeDate,'
    + 'Quantity,TradePrice,Proceeds,IBCommission,PutCall,Strike,Expiry,Multiplier,'
    + 'TradeID,Notes/Codes';

function flex(...lines) {
    return [FLEX_HEADER].concat(lines).join('\n');
}

// A Chinese export, mirroring the quirks a real one carries: a BOM, the
// contract column and the notes column BOTH named 代码, Chinese section and
// asset-class names, English DataDiscriminator and code letters, the account
// living in its own section, and the multiplier only in the instrument
// table.
const CN_TRADES_HEADER = '交易,Header,DataDiscriminator,资产分类,货币,代码,日期/时间,'
    + '数量,交易价格,收盘价格,收益,佣金/税,基础,已实现的损益,按市值计算的损益,代码';

function chinese(options) {
    const opts = options || {};
    const lines = [
        '\ufeffStatement,Header,域名称,域值',
        'Statement,Data,标题,活动报表',
        `Statement,Data,Period,"${opts.period || '八月 3, 2026 - 八月 24, 2026'}"`,
        '账户信息,Header,域名称,域值',
        '账户信息,Data,账户,U1111111',
        '金融产品信息,Header,资产分类,代码,描述,合约编号,底层,上市交易所,乘数,到期,'
            + '发送月份,类型,执行,代码',
        '金融产品信息,Data,股票和指数期权,GLD   260819C00399000,GLD 19AUG26 399 C,'
            + '908200664,GLD,CBOE,100,2026-08-19,2026-08,C,399,',
        CN_TRADES_HEADER,
    ];
    (opts.trades || []).forEach((line) => lines.push(line));
    (opts.extra || []).forEach((line) => lines.push(line));
    return lines.join('\n');
}

function cnTrade(assetClass, symbol, dateTime, qty, price, proceeds, comm, codes,
    basis, realizedPnl) {
    return `交易,Data,Order,${assetClass},USD,${symbol},"${dateTime}",${qty},${price},`
        + `0,${proceeds},${comm},${basis === undefined ? '' : basis},`
        + `${realizedPnl === undefined ? '' : realizedPnl},0,${codes}`;
}

module.exports = {
    name: 'cost_basis_import.js',
    tests: [
        {
            name: 'the CSV reader handles quoted commas, doubled quotes, and CRLF',
            run() {
                const parser = loadImport();
                const rows = parser.parseCsv(
                    'a,b,c\r\n"1, 2",three,"say ""hi"""\r\n\r\nx,y,z\n');
                assert.equal(rows.length, 3);
                assert.deepEqual(Array.from(rows[1]), ['1, 2', 'three', 'say "hi"']);
                assert.deepEqual(Array.from(rows[2]), ['x', 'y', 'z']);
            },
        },
        {
            name: 'format detection separates the two export shapes',
            run() {
                const parser = loadImport();
                assert.equal(
                    parser.detectFormat(parser.parseCsv(activity())), 'activity');
                assert.equal(parser.detectFormat(parser.parseCsv(flex())), 'flex');
                assert.equal(
                    parser.detectFormat(parser.parseCsv('hello,world\n1,2')), 'unknown');
                assert.equal(parser.detectFormat([]), 'unknown');
            },
        },
        {
            name: 'a local option symbol yields the whole contract',
            run() {
                const parser = loadImport();
                const spaced = parser.parseOptionSymbol('TQQQ 17JUL26 45 P');
                assert.equal(spaced.underlying, 'TQQQ');
                assert.equal(spaced.expiry, '20260717');
                assert.equal(spaced.strike, 45);
                assert.equal(spaced.right, 'P');
                const osi = parser.parseOptionSymbol('TQQQ  260717P00045000');
                assert.equal(osi.expiry, '20260717');
                assert.equal(osi.strike, 45);
                assert.equal(osi.right, 'P');
                assert.equal(parser.parseOptionSymbol('TQQQ'), null);
                assert.equal(parser.parseOptionSymbol('TQQQ 17XXX26 45 P'), null);
                assert.equal(parser.parseOptionSymbol(''), null);
            },
        },
        {
            name: 'an activity statement option trade keeps the statement cash',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 17JUL26 45 P,'
                    + '"2026-06-01, 09:35:00",-5,1.20,600,-3.25,O',
                ), { symbol: 'TQQQ' });
                assert.equal(result.format, 'activity');
                assert.equal(result.events.length, 1);
                const event = result.events[0];
                assert.equal(event.kind, 'option_trade');
                assert.equal(event.tradeDate, '2026-06-01');
                assert.equal(event.contracts, -5);
                assert.equal(event.strike, 45);
                assert.equal(event.expiry, '20260717');
                // Proceeds already carries IBKR's sign; commission is already
                // negative, so the cash is a sum, never a re-derivation.
                assert.equal(event.cashAmount, 596.75);
                assert.equal(event.fees, 3.25);
                assert.equal(event.brokerTimestamp, '2026-06-01T09:35:00');
                assert.equal(result.statementThrough, '2026-06-01T09:35:00');
            },
        },
        {
            name: 'the localized Activity period is the authoritative statement cutoff',
            run() {
                const parser = loadImport();
                const result = parser.parse(chinese({
                    period: '八月 3, 2026 - 八月 21, 2026',
                    trades: [cnTrade(
                        '股票和指数期权', 'GLD 20NOV26 535 C',
                        '2026-08-20, 11:12:13', -1, 2.5, 250, -1, 'O')],
                }), { symbol: 'GLD' });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events[0].brokerTimestamp, '2026-08-20T11:12:13');
                assert.equal(result.statementThrough, '2026-08-21T23:59:59');
            },
        },
        {
            name: 'an assignment becomes one event, not two rows',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 17JUL26 45 P,'
                    + '"2026-07-17, 16:20:00",5,0,0,0,A',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-07-17, 16:20:00",'
                    + '500,45,-22500,-1.05,A',
                ), { symbol: 'TQQQ' });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 1);
                const event = result.events[0];
                assert.equal(event.kind, 'option_assignment');
                assert.equal(event.contracts, 5);
                assert.equal(event.shares, 500);
                assert.equal(event.price, 45);
                assert.equal(event.brokerTimestamp, '2026-07-17T16:20:00');
                assert.match(event.note, /2026-07-17, 16:20:00/);
                // The share leg's settlement cash wins over the theoretical
                // strike x shares figure.
                assert.equal(event.cashAmount, -22501.05);
            },
        },
        {
            name: 'same-day drafts are ordered by broker time before CSV row order',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-08-24, 15:00:00",'
                        + '10,70,-700,0,O',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-08-24, 10:00:00",'
                        + '5,69,-345,0,O',
                ), { symbol: 'TQQQ' });
                assert.deepEqual(Array.from(result.events, (event) => event.brokerTimestamp), [
                    '2026-08-24T10:00:00',
                    '2026-08-24T15:00:00',
                ]);
                assert.equal(result.statementThrough, '2026-08-24T15:00:00');
            },
        },
        {
            name: 'a called-away short call pairs to a negative delivery',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 21AUG26 60 C,'
                    + '"2026-08-21, 16:20:00",3,0,0,0,A',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-08-21, 16:20:00",'
                    + '-300,60,18000,-1,A',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events.length, 1);
                assert.equal(result.events[0].shares, -300);
                assert.equal(result.events[0].cashAmount, 17999);
            },
        },
        {
            name: 'a long call exercise pairs to a share purchase',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 21AUG26 60 C,'
                    + '"2026-08-21, 16:20:00",-2,0,0,0,Ex',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-08-21, 16:20:00",'
                    + '200,60,-12000,0,Ex',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events.length, 1);
                assert.equal(result.events[0].kind, 'option_exercise');
                assert.equal(result.events[0].contracts, -2);
                assert.equal(result.events[0].shares, 200);
            },
        },
        {
            name: 'a share delivery leg with no option leg is a problem, never a trade',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-07-17, 16:20:00",'
                    + '500,45,-22500,0,A',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events.length, 0);
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /no matching option leg/);
            },
        },
        {
            name: 'an option leg with no share leg blocks instead of guessing a delivery',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 17JUL26 45 P,'
                    + '"2026-07-17, 16:20:00",5,0,0,0,A',
                ), { symbol: 'TQQQ' });
                // Nothing in the file says shares actually moved. Deriving
                // 500 shares and 22500 of cash from the strike would change
                // the position and the cost on an assumption.
                assert.equal(result.events.length, 0);
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /no matching share delivery leg/);
            },
        },
        {
            name: 'an expired contract becomes an expiry event',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 17JUL26 45 P,'
                    + '"2026-07-17, 20:15:00",5,0,0,0,Ep',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events[0].kind, 'option_expiry');
                assert.equal(result.events[0].contracts, 5);
                assert.equal(result.events[0].cashAmount, 0);
            },
        },
        {
            name: 'Order rows win over Trade rows so fills are not double counted',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '300,45,-13500,-1,O',
                    'Trades,Data,Trade,Stocks,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '100,45,-4500,-0.33,O',
                    'Trades,Data,Trade,Stocks,USD,TQQQ,"2026-06-01, 09:35:01",'
                    + '200,45,-9000,-0.67,O',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events.length, 1);
                assert.equal(result.events[0].shares, 300);
            },
        },
        {
            name: 'Trade rows are used when the statement has no Order rows',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Trade,Stocks,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '100,45,-4500,-0.33,O',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events.length, 1);
                assert.equal(result.events[0].shares, 100);
            },
        },
        {
            name: 'a dividend row for the underlying is imported',
            run() {
                const parser = loadImport();
                const text = activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '100,45,-4500,-1,O',
                ) + '\nDividends,Header,Currency,Date,Description,Amount'
                  + '\nDividends,Data,USD,2026-06-30,TQQQ(US88160R1014) Cash Dividend,25.00'
                  + '\nDividends,Data,USD,2026-06-30,SQQQ(US88160R9999) Cash Dividend,9.00';
                const result = parser.parse(text, { symbol: 'TQQQ' });
                const dividends = result.events.filter(
                    (event) => event.kind === 'dividend');
                assert.equal(dividends.length, 1);
                assert.equal(dividends[0].cashAmount, 25);
                assert.equal(dividends[0].tradeDate, '2026-06-30');
            },
        },
        {
            name: 'other underlyings are skipped, not turned into problems',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,SQQQ,"2026-06-01, 09:35:00",'
                    + '100,20,-2000,-1,O',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '100,45,-4500,-1,O',
                ), { symbol: 'TQQQ' });
                assert.equal(result.summary.skipped, 1);
                assert.equal(result.summary.problems, 0);
                assert.equal(result.events.length, 1);
            },
        },
        {
            name: 'a flex export uses its explicit columns and its trade id',
            run() {
                const parser = loadImport();
                const result = parser.parse(flex(
                    'U1111111,TQQQ,TQQQ 17JUL26 45 P,OPT,2026-06-01,-5,1.20,600,'
                    + '-3.25,P,45,2026-07-17,100,987654321,O',
                ), { symbol: 'TQQQ' });
                assert.equal(result.format, 'flex');
                const event = result.events[0];
                assert.equal(event.account, 'U1111111');
                assert.equal(event.kind, 'option_trade');
                assert.equal(event.strike, 45);
                assert.equal(event.expiry, '20260717');
                assert.equal(event.sharesPerContract, 100);
                assert.equal(event.externalRef, '987654321');
                assert.equal(event.cashAmount, 596.75);
            },
        },
        {
            name: 'an adjusted multiplier from the statement is preserved',
            run() {
                const parser = loadImport();
                const result = parser.parse(flex(
                    'U1111111,TQQQ,TQQQ 17JUL26 45 P,OPT,2026-06-01,-1,1.00,130,'
                    + '0,P,45,2026-07-17,130,111,O',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events[0].sharesPerContract, 130);
            },
        },
        {
            name: 'a multi-account Flex file imports only the selected book account',
            run() {
                const parser = loadImport();
                const result = parser.parse(flex(
                    'U1111111,TQQQ,TQQQ,STK,2026-06-01,100,45,-4500,-1,,,,,111,O',
                    'U2222222,TQQQ,TQQQ,STK,2026-06-02,200,46,-9200,-1,,,,,222,O',
                ), { symbol: 'TQQQ', targetAccount: 'U2222222' });
                assert.equal(result.problems.length, 0);
                assert.equal(result.summary.skipped, 1);
                assert.equal(result.events.length, 1);
                assert.equal(result.events[0].account, 'U2222222');
                assert.equal(result.events[0].shares, 200);
            },
        },
        {
            name: 'thousands separators and parenthesised negatives are read',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '"1,000",45,"(45,000)",-1,O',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events[0].shares, 1000);
                assert.equal(result.events[0].cashAmount, -45001);
            },
        },
        {
            name: 'a file missing a required column is refused whole',
            run() {
                const parser = loadImport();
                const result = parser.parse(
                    'ClientAccountID,Symbol,TradePrice,Proceeds\nU1,TQQQ,45,-4500',
                    { symbol: 'TQQQ' });
                assert.equal(result.events.length, 0);
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /required columns/);
            },
        },
        {
            name: 'an unrecognized asset class is reported, never guessed',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Forex,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '100,45,-4500,-1,O',
                ), { symbol: '' });
                assert.equal(result.events.length, 0);
                assert.match(result.problems[0].reason, /unrecognized asset class/);
            },
        },
        {
            name: 'a row with no readable date is reported, never dated today',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,,100,45,-4500,-1,O',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events.length, 0);
                assert.match(result.problems[0].reason, /trade date/);
            },
        },
        {
            name: 'unmapped columns are reported so a mapping UI can offer them',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '100,45,-4500,-1,O',
                ), { symbol: 'TQQQ' });
                assert.ok(result.unmappedColumns.includes('currency'));
            },
        },
        {
            name: 'a summary counts drafts by kind',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 17JUL26 45 P,'
                    + '"2026-06-01, 09:35:00",-5,1.20,600,-3.25,O',
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 17JUL26 45 P,'
                    + '"2026-07-17, 16:20:00",5,0,0,0,A',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-07-17, 16:20:00",'
                    + '500,45,-22500,0,A',
                ), { symbol: 'TQQQ' });
                assert.equal(result.summary.drafted, 2);
                assert.equal(result.summary.byKind.option_trade, 1);
                assert.equal(result.summary.byKind.option_assignment, 1);
            },
        },
        {
            name: 'drafts come out in trade-date order',
            run() {
                const parser = loadImport();
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-08-01, 09:35:00",'
                    + '100,45,-4500,-1,O',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-06-01, 09:35:00",'
                    + '100,44,-4400,-1,O',
                ), { symbol: 'TQQQ' });
                assert.deepEqual(
                    Array.from(result.events).map((event) => event.tradeDate),
                    ['2026-06-01', '2026-08-01']);
            },
        },
        {
            name: 'a Chinese statement is recognised as an activity export',
            run() {
                const parser = loadImport();
                const text = chinese({ trades: [
                    cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-07, 15:38:15', -1, 6.57, 657, -0.7062942, 'O'),
                ] });
                const result = parser.parse(text, {
                    symbol: 'GLD', targetAccount: 'U1111111',
                });
                assert.equal(result.format, 'activity');
                assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
                assert.equal(result.events.length, 1);
            },
        },
        {
            name: 'a leading BOM does not blind the first column',
            run() {
                const parser = loadImport();
                const rows = parser.parseCsv('\ufeffa,b\n1,2');
                assert.equal(rows[0][0], 'a');
            },
        },
        {
            name: 'the duplicated 代码 column keeps contract and notes apart',
            run() {
                const parser = loadImport();
                const headers = CN_TRADES_HEADER.split(',').slice(2);
                const built = parser.buildMapping(headers);
                // 代码 appears at index 3 (the contract) and index 13 (the
                // notes). Collapsing them would read every assignment as an
                // ordinary trade.
                assert.equal(built.mapping.symbol, 3);
                assert.equal(built.mapping.codes, 13);
                assert.notEqual(built.mapping.symbol, built.mapping.codes);
            },
        },
        {
            name: 'a Chinese assignment still pairs into one event',
            run() {
                const parser = loadImport();
                const text = chinese({ trades: [
                    cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-19, 16:20:00', 1, 0, 0, 0, 'A;C'),
                    cnTrade('股票', 'GLD', '2026-08-19, 16:20:00',
                        -100, 399, 39900, -0.84144, 'A;O'),
                ] });
                const result = parser.parse(text, { symbol: 'GLD' });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 1);
                const event = result.events[0];
                assert.equal(event.kind, 'option_assignment');
                assert.equal(event.contracts, 1);
                assert.equal(event.shares, -100);
                assert.equal(event.cashAmount, 39899.15856);
            },
        },
        {
            name: 'the account is taken from its own section',
            run() {
                const parser = loadImport();
                const text = chinese({ trades: [
                    cnTrade('股票', 'GLD', '2026-08-20, 09:34:54',
                        100, 410.44, -41044, -1.0003, 'C'),
                ] });
                const result = parser.parse(text, { symbol: 'GLD' });
                assert.equal(result.account, 'U1111111');
                assert.equal(result.events[0].account, 'U1111111');
            },
        },
        {
            name: 'an Activity statement for another account is refused',
            run() {
                const parser = loadImport();
                const text = chinese({ trades: [
                    cnTrade('股票', 'GLD', '2026-08-20, 09:34:54',
                        100, 410.44, -41044, -1.0003, 'C'),
                ] });
                const result = parser.parse(text, {
                    symbol: 'GLD', targetAccount: 'U99999999',
                });
                assert.equal(result.events.length, 0);
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /does not match ledger account/);
            },
        },
        {
            name: 'the multiplier comes from the instrument table, not an assumption',
            run() {
                const parser = loadImport();
                const rows = parser.parseCsv(chinese({}));
                const instruments = parser.extractInstruments(rows);
                assert.ok(instruments.size > 0);
                const text = chinese({ trades: [
                    cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-07, 15:38:15', -1, 6.57, 657, -0.7, 'O'),
                ] });
                const result = parser.parse(text, { symbol: 'GLD' });
                assert.equal(result.events[0].sharesPerContract, 100);
            },
        },
        {
            name: 'one section with several header layouts maps each group on its own',
            run() {
                const parser = loadImport();
                const rows = parser.parseCsv(chinese({}));
                const section = parser.extractSection(rows, 'instruments');
                assert.equal(section.groups.length, 1);
                // The fixture's instrument header differs from the trades
                // header; mapping a section through one header would shift
                // every row of the other by a column.
                const trades = parser.extractSection(rows, 'trades');
                assert.notDeepEqual(
                    Array.from(section.groups[0].headers),
                    Array.from(trades.groups[0].headers));
            },
        },
        {
            name: 'an unknown DataDiscriminator keeps rows instead of silently dropping them',
            run() {
                const parser = loadImport();
                // Open Positions discriminates by "Summary"; a locale could
                // translate Order/Trade too. Wiping the section would surface
                // as "0 drafts" with nothing to explain it.
                const rows = parser.parseCsv([
                    '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                    '未平仓持仓,Data,Summary,股票,USD,SPY,1100,1',
                ].join('\n'));
                const section = parser.extractSection(rows, 'openPositions');
                assert.equal(section.groups[0].records.length, 1);
            },
        },
        {
            name: 'an unknown section key fails closed instead of throwing',
            run() {
                const parser = loadImport();
                const rows = parser.parseCsv(chinese({}));
                assert.equal(parser.extractSection(rows, 'not_a_section'), null);
            },
        },
        {
            name: 'a corporate action for the selected underlying blocks import',
            run() {
                const parser = loadImport();
                const result = parser.parse(chinese({ extra: [
                    '公司行动,Header,资产分类,代码,描述,数量',
                    '公司行动,Data,股票,GLD,GLD 2 FOR 1 SPLIT,2',
                ] }), { symbol: 'GLD' });
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /corporate action/);
                assert.match(result.problems[0].reason, /adjusted option\/FOP/);
            },
        },
        {
            name: 'an unrelated corporate action does not block another book',
            run() {
                const parser = loadImport();
                const result = parser.parse(chinese({ extra: [
                    '公司行动,Header,资产分类,代码,描述,数量',
                    '公司行动,Data,股票,SLV,SLV 2 FOR 1 SPLIT,2',
                ] }), { symbol: 'GLD' });
                assert.equal(result.problems.length, 0);
            },
        },
        {
            name: 'the opening position is derived, not guessed',
            run() {
                const parser = loadImport();
                // Closing 6 contracts, and the statement still shows 2 open:
                // the period must have opened holding 8.
                const text = chinese({
                    trades: [
                        cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                            '2026-08-10, 10:00:00', -6, 1, 600, 0, 'C'),
                    ],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票和指数期权,USD,GLD 19AUG26 399 C,2,100',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-02' });
                assert.equal(result.openings.drafts.length, 1);
                const stub = result.openings.drafts[0];
                assert.equal(stub.contracts, 8);
                assert.equal(stub.tradeDate, '2026-08-02');
                assert.equal(stub.tag, 'prior_open');
                // The premium is not in the file; it must not be invented.
                assert.equal(stub.price, 0);
                assert.equal(stub.cashAmount, 0);
                assert.match(stub.note, /premium is not in this file/);
            },
        },
        {
            name: 'a fully-explained period derives no opening stub',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [
                        cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                            '2026-08-10, 10:00:00', -2, 1, 200, 0, 'O'),
                    ],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票和指数期权,USD,GLD 19AUG26 399 C,-2,100',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-02' });
                assert.equal(result.openings.drafts.length, 0);
                assert.equal(result.openings.openingShares, 0);
            },
        },
        {
            name: 'Open Positions Cost Basis reconstructs a still-open prior contract',
            run() {
                const parser = loadImport();
                const text = chinese({ extra: [
                    '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数,'
                        + '成本价格,成本基础',
                    '未平仓持仓,Data,Summary,股票和指数期权,USD,'
                        + 'GLD 19AUG26 399 C,5,100,15.7579075,7878.95375',
                ] });
                const result = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-02',
                });
                assert.equal(result.problems.length, 0);
                assert.equal(result.openings.drafts.length, 1);
                const opening = result.openings.drafts[0];
                assert.equal(opening.contracts, 5);
                assert.equal(opening.cashAmount, -7878.95375);
                assert.equal(opening.price, 15.7579075);
                assert.equal(opening.tag, 'prior_basis');
            },
        },
        {
            name: 'a complete close reconstructs its pre-period opening from IBKR Basis',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [
                        cnTrade('股票和指数期权', 'SLV 31DEC26 95 C',
                            '2026-08-19, 13:09:08', -3, 1.15, 345,
                            -1.268877, 'C', -2122.34385, -1778.612727),
                    ],
                    // The section is a complete inventory even though it
                    // contains no SLV row: SLV ended the period at zero.
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,TQQQ,200,1',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'SLV', openingDate: '2026-08-02',
                });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 1);
                assert.equal(result.events[0].tag, 'ibkr_close');
                assert.equal(result.events[0].brokerBasis, -2122.34385);
                assert.equal(result.openings.drafts.length, 1);
                const opening = result.openings.drafts[0];
                assert.equal(opening.contracts, 3);
                assert.equal(opening.cashAmount, -2122.34385);
                assert.equal(opening.tag, 'prior_basis');
                assert.equal(opening.price, 7.0744795);
                assert.equal(Math.round((opening.cashAmount
                    + result.events[0].cashAmount) * 1e6) / 1e6, -1778.612727);
            },
        },
        {
            name: 'assignment Basis reconstructs premium even when IBKR transfers realized PnL',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [
                        cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                            '2026-08-19, 16:20:00', 1, 0, 0, 0,
                            'A;C', 650, 0),
                        cnTrade('股票', 'GLD', '2026-08-19, 16:20:00',
                            -100, 399, 39900, -1, 'A;O'),
                    ],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,TQQQ,200,1',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-02',
                });
                assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
                assert.equal(result.events[0].kind, 'option_assignment');
                assert.equal(result.openings.drafts.length, 1);
                const opening = result.openings.drafts[0];
                assert.equal(opening.contracts, -1);
                assert.equal(opening.cashAmount, 650);
                assert.equal(opening.price, 6.5);
                assert.equal(opening.tag, 'prior_basis');
            },
        },
        {
            name: 'IBKR Basis is not used when the statement also opened the contract',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [
                        cnTrade('股票和指数期权', 'SLV 31DEC26 95 C',
                            '2026-08-10, 10:00:00', 1, 8, -800, 0, 'O', 0, 0),
                        cnTrade('股票和指数期权', 'SLV 31DEC26 95 C',
                            '2026-08-19, 13:09:08', -3, 1.15, 345,
                            -1.268877, 'C', -2122.34385, -1778.612727),
                    ],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,TQQQ,200,1',
                    ],
                });
                const opening = parser.parse(text, {
                    symbol: 'SLV', openingDate: '2026-08-02',
                });
                assert.equal(opening.problems.length, 1);
                assert.match(opening.problems[0].reason, /cannot be attributed safely/);
                const draft = opening.openings.drafts[0];
                assert.equal(draft.contracts, 2);
                assert.equal(draft.tag, 'prior_open');
                assert.equal(draft.cashAmount, 0);
            },
        },
        {
            name: 'Basis reconstruction blocks a failed realized-PnL conservation check',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [cnTrade('股票和指数期权', 'SLV 31DEC26 95 C',
                        '2026-08-19, 13:09:08', -3, 1.15, 345,
                        -1.268877, 'C;W', -2122.34385, -100)],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,TQQQ,200,1',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'SLV', openingDate: '2026-08-02',
                });
                assert.equal(result.openings.drafts[0].tag, 'prior_open');
                assert.equal(result.openings.drafts[0].cashAmount, 0);
                assert.ok(result.problems.some(
                    (problem) => /Basis.*cannot be attributed safely/.test(problem.reason)));
            },
        },
        {
            name: 'an opening share balance is reported, never drafted with a made-up cost',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [
                        cnTrade('股票', 'GLD', '2026-08-10, 10:00:00',
                            100, 400, -40000, 0, 'O'),
                    ],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,GLD,300,1',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-02' });
                assert.equal(result.openings.openingShares, 200);
                // No share stub: its cost basis is unknown, and guessing it
                // would corrupt the blended cost.
                assert.equal(result.openings.drafts.length, 0);
            },
        },
        {
            name: 'a fully sold opening share lot is reconstructed from IBKR Basis',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [cnTrade('股票', 'GLD', '2026-08-10, 10:00:00',
                        -100, 120, 12000, -1, 'C', -10000, 1999)],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,TQQQ,200,1',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-02',
                });
                assert.equal(result.problems.length, 0);
                assert.equal(result.openings.openingShares, 0);
                assert.equal(result.openings.shareDrafts.length, 1);
                const opening = result.openings.shareDrafts[0];
                assert.equal(opening.kind, 'opening_balance');
                assert.equal(opening.shares, 100);
                assert.equal(opening.price, 100);
                assert.equal(opening.cashAmount, -10000);
                assert.equal(opening.tag, 'prior_basis');
                assert.equal(opening.cashAmount + result.events[0].cashAmount, 1999);
            },
        },
        {
            name: 'Lot rows never double the reported position',
            run() {
                const parser = loadImport();
                const rows = parser.parseCsv([
                    '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                    '未平仓持仓,Data,Summary,股票,USD,SPY,1100,1',
                    '未平仓持仓,Data,Lot,股票,USD,SPY,600,1',
                    '未平仓持仓,Data,Lot,股票,USD,SPY,500,1',
                ].join('\n'));
                const end = parser.extractEndPositions(rows, { symbol: 'SPY' });
                assert.equal(end.shares, 1100);
            },
        },
        {
            name: 'two same-day deliveries of the same size keep their own settlement cash',
            run() {
                const parser = loadImport();
                // A wheel with several puts assigned at once: same account,
                // same date, 100 shares each, differing only in strike. The
                // share legs are listed in the OPPOSITE order to the option
                // legs, which is what IBKR does - stock rows are grouped
                // apart from option rows.
                const text = chinese({ trades: [
                    cnTrade('股票和指数期权', 'TQQQ 24AUG26 70 P',
                        '2026-08-24, 16:20:00', 1, 0, 0, 0, 'A;C'),
                    cnTrade('股票和指数期权', 'TQQQ 24AUG26 71 P',
                        '2026-08-24, 16:20:00', 1, 0, 0, 0, 'A;C'),
                    cnTrade('股票', 'TQQQ', '2026-08-24, 16:20:00',
                        100, 71, -7100, 0, 'A;O'),
                    cnTrade('股票', 'TQQQ', '2026-08-24, 16:20:00',
                        100, 70, -7000, 0, 'A;O'),
                ] });
                const result = parser.parse(text, { symbol: 'TQQQ' });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 2);
                result.events.forEach((event) => {
                    assert.equal(event.cashAmount, -(event.shares * event.strike),
                        `strike ${event.strike} took the other delivery's cash`);
                });
            },
        },
        {
            name: 'every row carries a dedup key even though the statement has no trade id',
            run() {
                const parser = loadImport();
                const text = chinese({ trades: [
                    cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-07, 15:38:15', -1, 6.57, 657, -0.7, 'O'),
                ] });
                const result = parser.parse(text, { symbol: 'GLD' });
                // An Activity Statement has no TradeID column at all, so
                // without a content-derived key every overlapping re-import
                // would book the same trade again.
                assert.ok(result.events[0].externalRef);
                assert.match(result.events[0].externalRef, /^stmt-[0-9a-f]{16}$/);
            },
        },
        {
            name: 'the same trade in a later statement keeps the same key',
            run() {
                const parser = loadImport();
                const row = cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                    '2026-08-07, 15:38:15', -1, 6.57, 657, -0.7, 'O');
                const later = cnTrade('股票和指数期权', 'GLD 21AUG26 399 P',
                    '2026-08-20, 10:00:00', -2, 1.5, 300, -1, 'O');
                const first = parser.parse(chinese({ trades: [row] }), { symbol: 'GLD' });
                const second = parser.parse(
                    chinese({ trades: [row, later] }), { symbol: 'GLD' });
                const overlap = second.events.filter(
                    (event) => event.externalRef === first.events[0].externalRef);
                assert.equal(overlap.length, 1);
                assert.equal(second.events.length, 2);
                // Keys must be unique inside one batch too.
                const keys = new Set(second.events.map((event) => event.externalRef));
                assert.equal(keys.size, 2);
            },
        },
        {
            name: 'byte-equivalent Activity rows remain distinct and overlap stably',
            run() {
                const parser = loadImport();
                const row = cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                    '2026-08-07, 15:38:15', -1, 6.57, 657, -0.7, 'O');
                const later = cnTrade('股票和指数期权', 'GLD 21AUG26 399 P',
                    '2026-08-20, 10:00:00', -2, 1.5, 300, -1, 'O');
                const first = parser.parse(chinese({ trades: [row, row] }), {
                    symbol: 'GLD',
                });
                const cumulative = parser.parse(
                    chinese({ trades: [row, row, later] }), { symbol: 'GLD' });

                assert.equal(first.problems.length, 0);
                assert.equal(first.events.length, 2);
                assert.notEqual(first.events[0].externalRef, first.events[1].externalRef);
                assert.match(first.events[0].externalRef, /^stmt-[0-9a-f]{16}$/);
                assert.equal(first.events[1].externalRef,
                    `${first.events[0].externalRef}-2`);
                assert.deepEqual(
                    Array.from(cumulative.events.slice(0, 2), (event) => event.externalRef),
                    Array.from(first.events, (event) => event.externalRef));
                assert.equal(new Set(cumulative.events.map(
                    (event) => event.externalRef)).size, 3);
            },
        },
        {
            name: 'trades differing only in price get different keys',
            run() {
                const parser = loadImport();
                const build = (price, proceeds) => parser.parse(chinese({ trades: [
                    cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-07, 15:38:15', -1, price, proceeds, -0.7, 'O'),
                ] }), { symbol: 'GLD' }).events[0].externalRef;
                assert.notEqual(build(6.57, 657), build(6.58, 658));
            },
        },
        {
            name: 'an assignment key does not depend on which share row it paired with',
            run() {
                const parser = loadImport();
                const option = cnTrade('股票和指数期权', 'TQQQ 24AUG26 70 P',
                    '2026-08-24, 16:20:00', 1, 0, 0, 0, 'A;C');
                const shares = cnTrade('股票', 'TQQQ', '2026-08-24, 16:20:00',
                    100, 70, -7000, 0, 'A;O');
                const other = cnTrade('股票', 'TQQQ', '2026-08-24, 16:20:00',
                    100, 70, -7000, 0, 'A;O');
                const one = parser.parse(
                    chinese({ trades: [option, shares] }), { symbol: 'TQQQ' });
                const two = parser.parse(
                    chinese({ trades: [option, other, shares] }), { symbol: 'TQQQ' });
                const assignments = two.events.filter(
                    (event) => event.kind === 'option_assignment');
                assert.equal(assignments[0].externalRef, one.events[0].externalRef);
            },
        },
        {
            name: 'an opening stub is keyed per contract, never per derived quantity',
            run() {
                const parser = loadImport();
                const build = (endQty) => parser.parse(chinese({
                    trades: [cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-10, 10:00:00', -6, 1, 600, 0, 'C')],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        `未平仓持仓,Data,Summary,股票和指数期权,USD,GLD 19AUG26 399 C,${endQty},100`,
                    ],
                }), { symbol: 'GLD', openingDate: '2026-08-02' }).openings.drafts[0];
                // Two statements could land on different opening quantities;
                // the key must still collapse them to one stub per contract.
                assert.equal(build(2).externalRef, build(3).externalRef);
                assert.match(build(2).externalRef, /^prior-[0-9a-f]{16}$/);
            },
        },
        {
            name: 'a later statement does not re-open what the ledger already holds',
            run() {
                const parser = loadImport();
                // Next week's statement shows the CLOSE of a contract this
                // ledger already opened with real premium, but not its
                // opening. Deriving an opening from it blindly would add a
                // second, premium-less copy and leave the ledger holding a
                // position that is already gone.
                const text = chinese({
                    trades: [cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-19, 16:20:00', 2, 0, 0, 0, 'C;Ep')],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,GLD,0,1',
                    ],
                });
                const blind = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-18' });
                assert.equal(blind.openings.drafts.length, 1,
                    'a fresh ledger still needs the opening');
                const aware = parser.parse(text, {
                    symbol: 'GLD',
                    openingDate: '2026-08-18',
                    existingOpen: [{
                        account: 'U1111111', right: 'C', strike: 399,
                        expiry: '20260819', contracts: -2, sharesPerContract: 100,
                    }],
                });
                assert.equal(aware.openings.drafts.length, 0);
            },
        },
        {
            name: 're-importing the same statement cannot synthesize inverse openings',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-19, 16:20:00', 2, 0, 0, 0, 'C;Ep')],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,GLD,0,1',
                    ],
                });
                const first = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-18' });
                assert.equal(first.openings.drafts.length, 1);
                const repeat = parser.parse(text, {
                    symbol: 'GLD',
                    openingDate: '2026-08-18',
                    existingOpen: [],
                    existingExternalRefs: first.events.map((event) => ({
                        account: event.account,
                        externalRef: event.externalRef,
                    })),
                });
                // The closing row will be skipped by the store, so it must
                // also be excluded from the opening-position arithmetic.
                assert.equal(repeat.openings.drafts.length, 0);
                assert.equal(repeat.openings.openingShares, 0);
            },
        },
        {
            name: 'shares the ledger already holds are not reported as an opening again',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [cnTrade('股票', 'GLD', '2026-08-10, 10:00:00',
                        100, 400, -40000, 0, 'O')],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票,USD,GLD,300,1',
                    ],
                });
                assert.equal(parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-02',
                }).openings.openingShares, 200);
                // The ledger already carries those 200; telling the operator
                // to add them again would double the position.
                assert.equal(parser.parse(text, {
                    symbol: 'GLD',
                    openingDate: '2026-08-02',
                    existingSharesByAccount: { U1111111: 200 },
                }).openings.openingShares, 0);
            },
        },
        {
            name: 'a partly-held position still gets a stub for the missing part',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-10, 10:00:00', -6, 1, 600, 0, 'C')],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票和指数期权,USD,GLD 19AUG26 399 C,2,100',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'GLD',
                    openingDate: '2026-08-02',
                    existingOpen: [{
                        account: 'U1111111', right: 'C', strike: 399,
                        expiry: '20260819', contracts: 3, sharesPerContract: 100,
                    }],
                });
                // Statement implies an opening of 8; the ledger holds 3.
                assert.equal(result.openings.drafts.length, 1);
                assert.equal(result.openings.drafts[0].contracts, 5);
            },
        },
        {
            name: 'an early close keeps the statement cash and the closing sign',
            run() {
                const parser = loadImport();
                // Code C is a closing trade - buying a short back before
                // expiry, which is what every roll does.
                const text = chinese({ trades: [
                    cnTrade('股票和指数期权', 'TQQQ 26AUG26 68 P',
                        '2026-08-20, 10:00:00', -2, 1.18, 236, -0.42, 'O'),
                    cnTrade('股票和指数期权', 'TQQQ 26AUG26 68 P',
                        '2026-08-25, 10:00:00', 2, 2.10, -420, -1.12, 'C'),
                ] });
                const result = parser.parse(text, { symbol: 'TQQQ' });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 2);
                const close = result.events[1];
                assert.equal(close.kind, 'option_trade');
                assert.equal(close.contracts, 2);
                // Debit: proceeds are negative and the commission is on top.
                assert.equal(close.cashAmount, -421.12);
                assert.equal(close.fees, 1.12);
            },
        },
        {
            name: 'a roll is two ordinary trades, never a delivery',
            run() {
                const parser = loadImport();
                const text = chinese({ trades: [
                    cnTrade('股票和指数期权', 'TQQQ 26AUG26 68 P',
                        '2026-08-25, 10:00:00', 2, 2.10, -420, -1.12, 'C'),
                    cnTrade('股票和指数期权', 'TQQQ 02SEP26 67 P',
                        '2026-08-25, 10:00:01', -2, 2.55, 510, -1.12, 'O'),
                ] });
                const result = parser.parse(text, { symbol: 'TQQQ' });
                assert.deepEqual(
                    Array.from(result.events).map((event) => event.kind),
                    ['option_trade', 'option_trade']);
                // No share leg is involved, so nothing may be paired away.
                assert.equal(result.problems.length, 0);
            },
        },
        {
            name: 'a mixed batch reports the block alongside the readable rows',
            run() {
                const parser = loadImport();
                // The dangerous shape: a statement whose good rows parse but
                // whose delivery cannot be resolved. Committing the readable
                // half writes a ledger that looks imported and is missing a
                // delivery, with nothing on the page saying so afterwards.
                const result = parser.parse(activity(
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-08-24, 10:00:00",'
                    + '100,70,-7000,0,O',
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 24AUG26 71 P,'
                    + '"2026-08-24, 16:20:00",1,0,0,0,A',
                ), { symbol: 'TQQQ' });
                assert.equal(result.events.length, 1);
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /no matching share delivery leg/);
            },
        },
        {
            name: 'imported option events carry the broker contract number',
            run() {
                const parser = loadImport();
                const result = parser.parse(chinese({ trades: [
                    cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-07, 15:38:15', -1, 6.57, 657, -0.7, 'O'),
                ] }), { symbol: 'GLD' });
                // The statement's instrument section carries it; without it
                // the ledger cannot tell two real contracts apart when their
                // structure is identical.
                assert.equal(result.events[0].conId, 908200664);
                assert.equal(result.events[0].localSymbol, 'GLD 19AUG26 399 C');
            },
        },
        {
            name: 'an expiry draft carries the contract identity too',
            run() {
                const parser = loadImport();
                const result = parser.parse(chinese({ trades: [
                    cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-19, 20:15:00', 1, 0, 0, 0, 'Ep'),
                ] }), { symbol: 'GLD' });
                assert.equal(result.events[0].kind, 'option_expiry');
                assert.equal(result.events[0].sharesPerContract, 100);
                assert.equal(result.events[0].conId, 908200664);
            },
        },
        {
            name: 're-dropping a statement onto the ledger it created changes nothing',
            run() {
                const parser = loadImport();
                // The realistic shape the earlier test misses: after the first
                // import the ledger holds BOTH the rows and the position, so
                // the derivation must net them out on both axes at once.
                const text = chinese({
                    trades: [cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-07, 15:38:15', -2, 6.57, 1314, -1.4, 'O')],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票和指数期权,USD,GLD 19AUG26 399 C,-2,100',
                    ],
                });
                const first = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-06' });
                assert.equal(first.openings.drafts.length, 0);
                assert.equal(first.events.length, 1);

                const again = parser.parse(text, {
                    symbol: 'GLD',
                    openingDate: '2026-08-06',
                    existingOpen: [{
                        account: 'U1111111', right: 'C', strike: 399,
                        expiry: '20260819', contracts: -2, sharesPerContract: 100,
                    }],
                    existingSharesByAccount: { U1111111: 0 },
                    existingExternalRefs: first.events.map((event) => ({
                        account: event.account, externalRef: event.externalRef,
                    })),
                });
                // Without netting the already-imported row out of the batch,
                // the arithmetic would invent a +2 stub that cancels the very
                // position the ledger holds.
                assert.equal(again.openings.drafts.length, 0);
                assert.equal(again.openings.openingShares, 0);
                assert.equal(again.problems.length, 0);
            },
        },
        {
            name: 'an opening that cannot be attributed is reported, not drafted',
            run() {
                const parser = loadImport();
                // The statement's position section has no contract number, so
                // when the ledger holds two contracts under one structural key
                // there is no way to say which one the position belongs to.
                const rows = parser.parseCsv([
                    '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                    '未平仓持仓,Data,Summary,股票和指数期权,USD,GLD 19AUG26 399 C,-2,100',
                ].join('\n'));
                const result = parser.deriveOpeningPositions(rows, [], {
                    symbol: 'GLD',
                    defaultSharesPerContract: 100,
                    accountFallback: 'U1',
                    openingDate: '2026-08-01',
                    existingOpen: [
                        { account: 'U1', right: 'C', strike: 399, expiry: '20260819',
                          contracts: -1, sharesPerContract: 100, conId: 111 },
                        { account: 'U1', right: 'C', strike: 399, expiry: '20260819',
                          contracts: -1, sharesPerContract: 100, conId: 222 },
                    ],
                });
                assert.equal(result.drafts.length, 0);
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /cannot be attributed/);
            },
        },
        {
            name: 'a row blocked by a voided ledger event blocks the whole import',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [cnTrade('股票和指数期权', 'GLD 19AUG26 399 C',
                        '2026-08-07, 15:38:15', -2, 6.57, 1314, -1.4, 'O')],
                    extra: [
                        '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                        '未平仓持仓,Data,Summary,股票和指数期权,USD,GLD 19AUG26 399 C,-2,100',
                    ],
                });
                const first = parser.parse(text, {
                    symbol: 'GLD', openingDate: '2026-08-06' });
                // The row was imported and then voided: the ledger no longer
                // holds the position, but the reference still blocks re-import.
                const again = parser.parse(text, {
                    symbol: 'GLD',
                    openingDate: '2026-08-06',
                    existingOpen: [],
                    existingSharesByAccount: { U1111111: 0 },
                    existingExternalRefs: first.events.map((event) => ({
                        account: event.account,
                        externalRef: event.externalRef,
                        voidedAtUtc: '2026-08-25T00:00:00Z',
                    })),
                });
                // The store's unique reference will skip this row, while the
                // void means its position and premium are absent from the
                // active ledger. A zero-premium stub would conceal that loss.
                assert.equal(again.problems.length, 1);
                assert.match(again.problems[0].reason, /voided ledger event/);
                assert.equal(again.openings.drafts.length, 0);
            },
        },
        {
            name: 'an unmapped local symbol never falls into the sole conId',
            run() {
                const parser = loadImport();
                const rows = parser.parseCsv([
                    '未平仓持仓,Header,DataDiscriminator,资产分类,货币,代码,数量,合约乘数',
                    '未平仓持仓,Data,Summary,股票和指数期权,USD,GLD 19AUG26 399 C,-1,100',
                ].join('\n'));
                const result = parser.deriveOpeningPositions(rows, [], {
                    symbol: 'GLD',
                    defaultSharesPerContract: 100,
                    accountFallback: 'U1',
                    openingDate: '2026-08-01',
                    existingOpen: [{
                        account: 'U1', right: 'C', strike: 399,
                        expiry: '20260819', contracts: -1,
                        sharesPerContract: 100, conId: 111,
                        localSymbol: 'A-DIFFERENT-CONTRACT',
                    }],
                });
                assert.equal(result.drafts.length, 0);
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /cannot be attributed/);
            },
        },
        {
            name: 'a proven FUT close and open pair becomes one roll event',
            run() {
                const parser = loadImport();
                const result = parser.parse(flex(
                    'U1,ES,ESU6,FUT,"2026-08-24, 10:00:00",-1,5100,0,-2,,,202609,50,old-fill,C',
                    'U1,ES,ESZ6,FUT,"2026-08-24, 10:00:00",1,5120,0,-2,,,202612,50,new-fill,O',
                ), { symbol: 'ES', secType: 'FUT', defaultSharesPerContract: 50 });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 1);
                const roll = result.events[0];
                assert.equal(roll.kind, 'futures_roll');
                assert.equal(roll.futureExpiry, '202609');
                assert.equal(roll.rollToExpiry, '202612');
                assert.equal(roll.futureContracts, 1);
                assert.equal(roll.rollToPrice - roll.price, 20);
                assert.equal(roll.cashAmount, -4);
                assert.match(roll.rollGroup, /^roll-/);
            },
        },
        {
            name: 'a negative FUT trade price keeps its statement sign',
            run() {
                const parser = loadImport();
                const result = parser.parse(flex(
                    'U1,CL,CLK20,FUT,"2020-04-20, 14:00:00",1,-37.63,0,-2,,,'
                        + '202005,1000,negative-fill,O',
                ), { symbol: 'CL', secType: 'FUT', defaultSharesPerContract: 1000 });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events[0].kind, 'futures_trade');
                assert.equal(result.events[0].price, -37.63);
            },
        },
        {
            name: 'a partial FUT roll preserves the unmatched outright quantity',
            run() {
                const parser = loadImport();
                const result = parser.parse(flex(
                    'U1,ES,ESU6,FUT,"2026-08-24, 10:00:00",-2,5100,0,-4,,,202609,50,old-partial,C',
                    'U1,ES,ESZ6,FUT,"2026-08-24, 10:00:00",1,5120,0,-2,,,202612,50,new-partial,O',
                ), { symbol: 'ES', secType: 'FUT', defaultSharesPerContract: 50 });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 2);
                const roll = result.events.find((event) => event.kind === 'futures_roll');
                const residual = result.events.find(
                    (event) => event.kind === 'futures_trade');
                assert.equal(roll.futureContracts, 1);
                assert.equal(roll.fees, 4);
                assert.equal(residual.futureExpiry, '202609');
                assert.equal(residual.futureContracts, -1);
                assert.equal(residual.fees, 2);
                assert.match(residual.externalRef, /^fut-residual-/);
            },
        },
        {
            name: 'an FOP assignment consumes its actual FUT delivery leg',
            run() {
                const parser = loadImport();
                const result = parser.parse(flex(
                    'U1,ES,"ES 21AUG26 5000 P",FOP,"2026-08-21, 16:00:00",1,0,0,-1,P,5000,20260821,50,fop-a,A;C',
                    'U1,ES,ESU6,FUT,"2026-08-21, 16:00:00",1,5000,0,-2,,,202609,50,fut-a,A;O',
                ), { symbol: 'ES', secType: 'FUT', defaultSharesPerContract: 50 });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 1);
                const delivery = result.events[0];
                assert.equal(delivery.kind, 'option_assignment');
                assert.equal(delivery.optionSecType, 'FOP');
                assert.equal(delivery.futureExpiry, '202609');
                assert.equal(delivery.futureContracts, 1);
                assert.equal(delivery.shares, undefined);
                // Only the two commissions move cash; FUT notional does not.
                assert.equal(delivery.fees, 3);
                assert.equal(delivery.cashAmount, -3);
            },
        },
        {
            name: 'a Chinese Activity Statement resolves FOP and FUT identities',
            run() {
                const parser = loadImport();
                const text = chinese({
                    trades: [
                        cnTrade('期货期权', 'ES 21AUG26 5000 P',
                            '2026-08-21, 16:00:00', 1, 0, 0, -1, 'A;C'),
                        cnTrade('期货', 'ESU6', '2026-08-21, 16:00:00',
                            1, 5000, 0, -2, 'A;O'),
                    ],
                    extra: [
                        '金融产品信息,Header,资产分类,代码,描述,合约编号,底层,上市交易所,乘数,到期,'
                            + '发送月份,类型,执行,代码',
                        '金融产品信息,Data,期货期权,ES 21AUG26 5000 P,'
                            + 'ES 21AUG26 5000 P,2001,ES,CME,50,2026-08-21,'
                            + '2026-08,P,5000,',
                        '金融产品信息,Data,期货,ESU6,ES Sep26,1001,ES,CME,'
                            + '50,2026-09-18,2026-09,,,,',
                    ],
                });
                const result = parser.parse(text, {
                    symbol: 'ES', secType: 'FUT', defaultSharesPerContract: 50,
                });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 1);
                assert.equal(result.events[0].futureExpiry, '20260918');
                assert.equal(result.events[0].futureConId, 1001);
                assert.equal(result.events[0].conId, 2001);
                assert.equal(result.events[0].cashAmount, -3);
            },
        },
        {
            name: 'FUT rows never leak into an STK ledger or vice versa',
            run() {
                const parser = loadImport();
                const future = flex(
                    'U1,ES,ESU6,FUT,"2026-08-20, 10:00:00",1,5000,0,-2,,,202609,50,fut-1,O');
                const stock = flex(
                    'U1,ES,ES,STK,"2026-08-20, 10:00:00",100,50,-5000,-1,,,,1,stk-1,O');
                const wrongStock = parser.parse(future, { symbol: 'ES', secType: 'STK' });
                const wrongFuture = parser.parse(stock, { symbol: 'ES', secType: 'FUT' });
                assert.equal(wrongStock.events.length, 0);
                assert.equal(wrongFuture.events.length, 0);
                assert.match(wrongStock.problems[0].reason, /unrecognized asset class/);
                assert.match(wrongFuture.problems[0].reason, /unrecognized asset class/);
            },
        },
        {
            name: 'an unexplained opening FUT blocks a partial-period Activity import',
            run() {
                const parser = loadImport();
                const text = [
                    'Statement,Header,Field Name,Field Value',
                    'Statement,Data,Period,"August 20, 2026 - August 24, 2026"',
                    'Account Information,Header,Field Name,Field Value',
                    'Account Information,Data,Account,U1',
                    'Financial Instrument Information,Header,Asset Category,Symbol,'
                        + 'Description,Conid,Underlying Symbol,Multiplier,Expiry',
                    'Financial Instrument Information,Data,Futures,ESU6,ES Sep26,'
                        + '1001,ES,50,2026-09-18',
                    ACTIVITY_HEADER,
                    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,'
                        + 'Symbol,Quantity,Multiplier',
                    'Open Positions,Data,Summary,Futures,USD,ESU6,1,50',
                ].join('\n');
                const options = {
                    symbol: 'ES', secType: 'FUT', defaultSharesPerContract: 50,
                };
                const missing = parser.parse(text, options);
                assert.equal(missing.events.length, 0);
                assert.equal(missing.openings.openingFutures.length, 1);
                assert.match(missing.problems[0].reason, /existing FUT position/);

                const covered = parser.parse(text, Object.assign({}, options, {
                    existingOpenFutures: [{
                        account: 'U1', expiry: '20260918', contracts: 1,
                        multiplier: 50, conId: 1001, localSymbol: 'ESU6',
                    }],
                }));
                assert.equal(covered.openings.openingFutures.length, 0);
                assert.equal(covered.problems.length, 0);
            },
        },
        {
            name: 'a pre-period FOP position is retained as an explicit unknown-premium stub',
            run() {
                const parser = loadImport();
                const text = [
                    'Statement,Header,Field Name,Field Value',
                    'Statement,Data,Period,"August 20, 2026 - August 24, 2026"',
                    'Account Information,Header,Field Name,Field Value',
                    'Account Information,Data,Account,U1',
                    ACTIVITY_HEADER,
                    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,'
                        + 'Symbol,Quantity,Multiplier',
                    'Open Positions,Data,Summary,Futures Options,USD,'
                        + 'ES 18SEP26 4900 P,-1,50',
                ].join('\n');
                const result = parser.parse(text, {
                    symbol: 'ES', secType: 'FUT', defaultSharesPerContract: 50,
                    openingDate: '2026-08-19',
                });
                assert.equal(result.problems.length, 0);
                assert.equal(result.openings.drafts.length, 1);
                const opening = result.openings.drafts[0];
                assert.equal(opening.optionSecType, 'FOP');
                assert.equal(opening.contracts, -1);
                assert.equal(opening.price, 0);
                assert.equal(opening.tag, 'prior_open');
            },
        },
        {
            name: 'garbage input is refused without throwing',
            run() {
                const parser = loadImport();
                for (const input of ['', null, undefined, 'not a csv at all', '\n\n\n']) {
                    const result = parser.parse(input, { symbol: 'TQQQ' });
                    assert.equal(result.events.length, 0);
                    assert.ok(result.problems.length >= 1);
                }
            },
        },
    ],
};
