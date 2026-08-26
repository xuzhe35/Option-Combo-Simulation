const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readPage() {
    return fs.readFileSync(path.join(PROJECT_ROOT, 'cost_basis.html'), 'utf8');
}

function readScript() {
    return fs.readFileSync(path.join(PROJECT_ROOT, 'js/cost_basis.js'), 'utf8');
}

function loadPage() {
    // No document in the context, so the page script registers its exports
    // and stops before touching the DOM or opening a socket.
    const context = loadBrowserScripts([
        'js/cost_basis_core.js',
        'js/cost_basis_import.js',
        'js/cost_basis.js',
    ]);
    return context;
}

module.exports = {
    name: 'cost_basis page',
    tests: [
        {
            name: 'the page loads only its own scripts, never the trading shell',
            run() {
                const html = readPage();
                const scripts = Array.from(
                    html.matchAll(/<script src="([^"?]+)/g)).map((match) => match[1]);
                assert.deepEqual(scripts, [
                    'js/cost_basis_core.js',
                    'js/cost_basis_import.js',
                    'js/cost_basis.js',
                ]);
                ['js/ws_client.js', 'js/app.js', 'js/valuation.js', 'js/pricing_core.js',
                    'js/combo_order_transport.js', 'js/delta_hedge_transport.js',
                    'style.css'].forEach((forbidden) => {
                    assert.equal(html.includes(forbidden), false,
                        `${forbidden} must not load on the ledger page`);
                });
            },
        },
        {
            name: 'the page declares its own page kind',
            run() {
                assert.match(readPage(), /data-option-combo-page="cost-basis"/);
            },
        },
        {
            name: 'every element the script reaches for exists in the page',
            run() {
                const html = readPage();
                const ids = new Set(Array.from(
                    readScript().matchAll(/\$\('([a-z0-9-]+)'\)/g)).map((m) => m[1]));
                assert.ok(ids.size > 20, 'expected the script to address many elements');
                const missing = Array.from(ids).filter(
                    (id) => !html.includes(`id="${id}"`));
                assert.deepEqual(missing, [],
                    `page is missing elements: ${missing.join(', ')}`);
            },
        },
        {
            name: 'the entry form offers every event kind the store accepts',
            run() {
                const context = loadPage();
                const html = readPage();
                context.OptionComboCostBasisCore.EVENT_KINDS.forEach((kind) => {
                    assert.ok(html.includes(`<option value="${kind}">`),
                        `${kind} is missing from the entry form`);
                });
            },
        },
        {
            name: 'a ledger is created and scoped by IB account plus underlying',
            run() {
                const html = readPage();
                const source = readScript();
                assert.match(html, /<select id="new-book-account"[^>]*required[^>]*disabled/);
                assert.ok(html.includes('id="new-book-account-manual"'));
                assert.match(source, /data\.action === 'managed_accounts_update'/);
                assert.match(source, /_sendOneWay\('request_managed_accounts_snapshot'\)/);
                assert.match(source, /state\.managedAccounts\.includes\(account\)/);
                assert.match(source, /knownBookAccounts/);
                assert.match(source, /MANUAL_ACCOUNT_VALUE/);
                assert.match(source, /account:\s*account\.toUpperCase\(\)/);
                assert.match(source, /targetAccount:\s*book \? \(book\.account \|\| ''\)/);
                assert.match(source,
                    /function _positionsForBook\([\s\S]{0,300}item\.account/);
                assert.match(source,
                    /positions:\s*_positionsForBook\(book\)/);
                assert.match(source,
                    /field-account'\)\.readOnly = Boolean\(book && book\.account\)/);
            },
        },
        {
            name: 'every event kind has a field list and a label',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                context.OptionComboCostBasisCore.EVENT_KINDS.forEach((kind) => {
                    assert.ok(Object.prototype.hasOwnProperty.call(page.KIND_FIELDS, kind),
                        `${kind} has no field list`);
                    assert.ok(page.KIND_LABELS[kind], `${kind} has no label`);
                });
            },
        },
        {
            name: 'every field a kind declares has a control in the page',
            run() {
                const context = loadPage();
                const html = readPage();
                const page = context.OptionComboCostBasisPage;
                Object.keys(page.KIND_FIELDS).forEach((kind) => {
                    page.KIND_FIELDS[kind].forEach((field) => {
                        assert.ok(html.includes(`data-field="${field}"`),
                            `${kind} declares ${field} but the page has no such control`);
                    });
                });
            },
        },
        {
            name: 'delivery kinds do not offer a separate price field',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                // On an assignment the strike *is* the share price, and the
                // store overwrites price with strike. Offering both would
                // invite a contradiction the operator cannot see.
                ['option_assignment', 'option_exercise'].forEach((kind) => {
                    assert.equal(page.KIND_FIELDS[kind].includes('price'), false);
                    assert.ok(page.KIND_FIELDS[kind].includes('strike'));
                    assert.ok(page.KIND_FIELDS[kind].includes('shares'));
                });
            },
        },
        {
            name: 'an expiry never offers a shares field',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                assert.equal(page.KIND_FIELDS.option_expiry.includes('shares'), false);
            },
        },
        {
            name: 'every basis mode has an explainer',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                context.OptionComboCostBasisCore.BASIS_MODES.forEach((mode) => {
                    assert.ok(page.BASIS_EXPLAINERS[mode],
                        `${mode} has no explanation for the operator`);
                });
                assert.match(page.BASIS_EXPLAINERS.stock_only, /TWS/);
            },
        },
        {
            name: 'the page script never names an order or market-data action',
            run() {
                const source = readScript();
                ['place_combo_order', 'submit_combo_order', 'sync_underlying',
                    'place_hedge_order', 'subscribe_iv_term_structure',
                    'request_historical_bars'].forEach((action) => {
                    assert.equal(source.includes(action), false,
                        `${action} must not appear in the ledger page script`);
                });
            },
        },
        {
            name: 'every action the script sends is on the core whitelist',
            run() {
                const context = loadPage();
                const allowed = new Set(
                    Array.from(context.OptionComboCostBasisCore.ALLOWED_CLIENT_ACTIONS));
                const source = readScript();
                const sent = Array.from(source.matchAll(/request\('([a-z_]+)'/g))
                    .map((m) => m[1])
                    .concat(Array.from(source.matchAll(/_sendOneWay\('([a-z_]+)'/g))
                        .map((m) => m[1]))
                    .concat(Array.from(source.matchAll(/action: '([a-z_]+)'/g))
                        .map((m) => m[1]));
                assert.ok(sent.length >= 8, 'expected the page to send several actions');
                sent.forEach((action) => {
                    assert.ok(allowed.has(action),
                        `${action} is sent but not whitelisted`);
                });
            },
        },
        {
            name: 'permanent book deletion is count-gated and clears every related artifact',
            run() {
                const source = readScript();
                const html = readPage();
                assert.ok(html.includes('id="btn-delete-book"'));
                assert.match(source, /request\('request_cost_basis_delete_plan'/);
                assert.match(source, /request\('delete_cost_basis_book'/);
                assert.match(source, /plan\.eventCount/);
                assert.match(source, /plan\.snapshotCount/);
                assert.match(source, /plan\.resetCount/);
                assert.match(source, /phrase\.trim\(\) !== plan\.phrase/);
                assert.match(source, /delete_confirmation_mismatch/);
                assert.match(source, /error\.code === 'book_not_found'/);
                assert.match(source, /deleteConfirmed/);
                assert.match(source, /账本已删除成功，但刷新账本列表失败/);
                assert.match(source, /deleteSubmitted && !error\.code/);
                assert.match(source, /刷新后确认账本已不存在，删除已经成功/);
                assert.match(source, /await _loadBooks\(\)/);
            },
        },
        {
            name: 'the import replays the ledger through the statement cutoff',
            run() {
                const source = readScript();
                // Without this, importing an older statement after a newer
                // one compares the old ending positions to the latest book
                // and invents prior_open rows.
                assert.match(source, /computeLedger\(eventsThroughCutoff\)/);
                assert.match(source, /statementThrough/);
                // Per account: merging accounts would invent openings.
                assert.match(source, /existingSharesByAccount/);
                assert.match(source, /perAccount\[account\]\.shares/);
                assert.match(source, /existingExternalRefs:\s*\(allEvents \|\| \[\]\)/);
                assert.match(source, /discovery\.statementThrough/);
            },
        },
        {
            name: 'an untrusted empty TWS snapshot cannot produce reconciliation advice',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                assert.equal(page.canReconcilePositions('', false), false);
                assert.equal(page.canReconcilePositions('23:01:00', false), false);
                assert.equal(page.canReconcilePositions('23:01:00', true), true);
                const source = readScript();
                assert.match(source,
                    /canReconcilePositions\(\s*state\.positionsAt, state\.positionsConnected\)/);
                assert.match(source,
                    /data\.ibConnected === true[\s\S]{0,80}data\.positionsReady === true/);
                assert.match(source, /TWS 未连接或持仓快照未完成；不进行对账/);
            },
        },
        {
            name: 'replacement import is parsed against an empty ledger baseline',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const ledger = {
                    accounts: ['U1'],
                    perAccount: { U1: { shares: 100 } },
                    openOptions: [{ account: 'U1', contracts: -1 }],
                };
                const events = [{
                    account: 'U1', externalRef: 'trade-1',
                    voidedAtUtc: null, includeInCost: true,
                }];
                const append = page.buildImportBaseline(false, ledger, events);
                assert.equal(append.existingOpen.length, 1);
                assert.equal(append.existingSharesByAccount.U1, 100);
                assert.equal(append.existingExternalRefs.length, 1);

                const replace = page.buildImportBaseline(true, ledger, events);
                assert.deepEqual(Array.from(replace.existingOpen), []);
                assert.deepEqual(Object.assign({}, replace.existingSharesByAccount), {});
                assert.deepEqual(Array.from(replace.existingExternalRefs), []);

                const source = readScript();
                assert.match(source,
                    /function _handleImportReplaceChange\([\s\S]{0,360}_parseImportText/);
                assert.match(source,
                    /import-replace'\)\.addEventListener\('change', _handleImportReplaceChange/);
            },
        },
        {
            name: 'append baseline uses broker timestamps, while dedupe stays global',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const core = context.OptionComboCostBasisCore;
                const events = [
                    {
                        seq: 1, kind: 'option_trade', tradeDate: '2026-08-21',
                        account: 'U1', right: 'P', strike: 70, expiry: '20260821',
                        contracts: -1, sharesPerContract: 100, price: 1,
                        cashAmount: 100, fees: 0, source: 'csv_import',
                        externalRef: 'older-option', note: 'IBKR 2026-08-21, 10:00:00',
                    },
                    {
                        seq: 2, kind: 'share_trade', tradeDate: '2026-08-21',
                        account: 'U1', shares: 100, price: 69, cashAmount: -6900,
                        fees: 0, source: 'csv_import', externalRef: 'older-shares',
                        note: 'IBKR 2026-08-21, 11:00:00',
                    },
                    {
                        seq: 3, kind: 'option_expiry', tradeDate: '2026-08-21',
                        account: 'U1', right: 'P', strike: 70, expiry: '20260821',
                        contracts: 1, sharesPerContract: 100, cashAmount: 0,
                        fees: 0, source: 'csv_import', externalRef: 'later-option',
                        note: 'IBKR expired 2026-08-21, 15:00:00',
                    },
                    {
                        seq: 4, kind: 'share_trade', tradeDate: '2026-08-24',
                        account: 'U1', shares: -100, price: 71, cashAmount: 7100,
                        fees: 0, source: 'csv_import', externalRef: 'newer-shares',
                        note: 'IBKR 2026-08-24, 10:00:00',
                    },
                ];
                const latest = core.computeLedger(events);
                const baseline = page.buildImportBaseline(
                    false, latest, events, '2026-08-21T12:00:00');
                assert.equal(baseline.existingOpen.length, 1);
                assert.equal(baseline.existingOpen[0].contracts, -1);
                assert.equal(baseline.existingSharesByAccount.U1, 100);
                // References after the cutoff must still be supplied because
                // SQLite uniqueness spans the whole book, not an as-of view.
                assert.equal(baseline.existingExternalRefs.length, 4);
            },
        },
        {
            name: 'an older covered statement is a no-op after a newer statement',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const core = context.OptionComboCostBasisCore;
                const importer = context.OptionComboCostBasisImport;
                const prefix = [
                    'Statement,Header,Field Name,Field Value',
                    'Statement,Data,Period,"August 3, 2026 - August 24, 2026"',
                    'Account Information,Header,Field Name,Field Value',
                    'Account Information,Data,Account,U1',
                    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,'
                        + 'Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code',
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 24AUG26 70 P,'
                        + '"2026-08-20, 10:00:00",-1,1,100,0,O',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-08-21, 10:00:00",'
                        + '100,69,-6900,0,O',
                ];
                const older = prefix.slice();
                older[1] = 'Statement,Data,Period,"August 3, 2026 - August 21, 2026"';
                older.push(
                    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,'
                        + 'Symbol,Quantity,Multiplier',
                    'Open Positions,Data,Summary,Equity and Index Options,USD,'
                        + 'TQQQ 24AUG26 70 P,-1,100',
                    'Open Positions,Data,Summary,Stocks,USD,TQQQ,100,1',
                );
                const newer = prefix.concat([
                    'Trades,Data,Order,Equity and Index Options,USD,TQQQ 24AUG26 70 P,'
                        + '"2026-08-24, 16:20:00",1,0,0,0,Ep',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-08-24, 16:21:00",'
                        + '-100,71,7100,0,O',
                    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,'
                        + 'Symbol,Quantity,Multiplier',
                    'Open Positions,Data,Summary,Stocks,USD,TQQQ,0,1',
                ]);

                const options = { symbol: 'TQQQ', defaultSharesPerContract: 100 };
                const newerResult = importer.parse(newer.join('\n'), options);
                assert.equal(newerResult.problems.length, 0);
                const stored = newerResult.events.map(
                    (item, index) => Object.assign({ seq: index + 1 }, item));
                const latest = core.computeLedger(stored);
                assert.equal(latest.openOptions.length, 0);
                assert.equal(latest.combined.shares, 0);

                const olderDiscovery = importer.parse(older.join('\n'), options);
                const baseline = page.buildImportBaseline(
                    false, latest, stored, olderDiscovery.statementThrough);
                const olderResult = importer.parse(
                    older.join('\n'), Object.assign({}, options, baseline));
                assert.equal(olderResult.openings.drafts.length, 0);
                assert.equal(olderResult.openings.openingShares, 0);
                assert.equal(olderResult.problems.length, 0);
            },
        },
        {
            name: 'a retained import preview is refreshed after the ledger changes',
            run() {
                const source = readScript();
                const loadEvents = source.slice(
                    source.indexOf('async function _loadEvents'),
                    source.indexOf('/** The rows the flow table should show'));
                assert.match(loadEvents, /state\.importText/);
                assert.match(loadEvents, /_parseImportText\(state\.importText\)/);
                assert.match(loadEvents, /_renderImportPreview\(\)/);
            },
        },
        {
            name: 'the rebuild flow is gated on a typed confirmation phrase',
            run() {
                const source = readScript();
                const html = readPage();
                assert.ok(html.includes('id="import-replace"'));
                assert.ok(html.includes('id="import-confirm"'));
                // The commit button must stay disabled until the typed text
                // equals the server's phrase; nothing else may unlock it.
                assert.match(source, /state\.resetPlan\s*\n?\s*&&\s*\$\('import-confirm'\)\.value\.trim\(\) === state\.resetPlan\.phrase/);
                // One atomic backend call, never reset-then-import.
                assert.match(source, /rebuild_cost_basis_book/);
                assert.equal(/await request\('reset_cost_basis_book'/.test(source), false);
            },
        },
        {
            name: 'a failed confirmation is reported as having destroyed nothing',
            run() {
                const source = readScript();
                assert.match(source, /reset_confirmation_mismatch/);
                assert.match(source, /账本未被清空/);
            },
        },
        {
            name: 'ledger totals are computed from the whole book, never a page',
            run() {
                const source = readScript();
                // The single most damaging failure this page can have is
                // answering a whole-ledger question from one page of rows.
                assert.match(source, /computeLedger\(state\.allEvents/);
                assert.equal(/computeLedger\(state\.events\b/.test(source), false);
                assert.match(source, /buildReconciliation\(\{[\s\S]{0,120}ledger: state\.ledger/);
                // The fetch loops until the whole book is in hand.
                assert.match(source, /LEDGER_FETCH_SIZE/);
                assert.match(source, /collected\.length >= total/);
            },
        },
        {
            name: 'filtering and paging the flow never refetch or move the totals',
            run() {
                const source = readScript();
                const wiring = source.slice(source.indexOf('function _wire()'));
                // Filter and page handlers must re-render only. Calling
                // _loadEvents there is what made the headline move when the
                // operator narrowed the view.
                const filterBlock = wiring.slice(
                    wiring.indexOf("'filter-account'"), wiring.indexOf("$('btn-export-csv')"));
                assert.match(filterBlock, /_renderFlow\(\)/);
                assert.equal(/_loadEvents\(\)/.test(filterBlock), false);
            },
        },
        {
            name: 'the premium panel counts realized income, not open credit',
            run() {
                const source = readScript();
                assert.match(source, /realizedPremiumWindow\(state\.ledger/);
                assert.equal(/premiumWindow\(state\.events/.test(source), false);
            },
        },
        {
            name: 'a batch with unresolved rows cannot be committed at all',
            run() {
                const source = readScript();
                const html = readPage();
                // Committing the readable half of a statement produces a
                // ledger that looks imported and is missing a delivery.
                assert.match(source, /state\.importResult\.problems\.length/);
                assert.match(source, /\|\| blocked;/);
                assert.ok(html.includes('id="import-blocked"'));
            },
        },
        {
            name: 'the import is told which broker rows the ledger already holds',
            run() {
                const source = readScript();
                // Without this, re-dropping a statement subtracts movements
                // the store will skip, and the resulting stubs unwind the
                // very positions that statement created.
                assert.match(source, /existingExternalRefs:/);
                assert.match(source, /buildImportBaseline\([\s\S]{0,120}state\.allEvents/);
                assert.match(source, /voidedAtUtc:\s*event\.voidedAtUtc/);
            },
        },
        {
            name: 'a cumulative CSV atomically supersedes the TWS baseline it reconstructs',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const importer = context.OptionComboCostBasisImport;
                const core = context.OptionComboCostBasisCore;
                const adopted = {
                    eventId: 'adopted-event-1', seq: 1,
                    kind: 'option_trade', tradeDate: '2026-08-25',
                    account: 'U1', right: 'P', strike: 68.5, expiry: '20260828',
                    contracts: -1, sharesPerContract: 100,
                    localSymbol: 'TQQQ 28AUG26 68.5 P', price: 1.23,
                    cashAmount: 123, fees: 0, source: 'reconcile',
                    tag: 'tws_snapshot', externalRef: 'tws-position-1',
                    note: 'Snapshot timestamp 2026-08-25T12:00:00.',
                };
                const csv = [
                    'Statement,Header,Field Name,Field Value',
                    'Statement,Data,Period,"August 1, 2026 - August 26, 2026"',
                    'Account Information,Header,Field Name,Field Value',
                    'Account Information,Data,Account,U1',
                    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,'
                        + 'Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code',
                    'Trades,Data,Order,Equity and Index Options,USD,'
                        + 'TQQQ 28AUG26 68.5 P,"2026-08-25, 10:00:00",'
                        + '-1,1.5,150,0,O',
                    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,'
                        + 'Symbol,Quantity,Multiplier',
                    'Open Positions,Data,Summary,Equity and Index Options,USD,'
                        + 'TQQQ 28AUG26 68.5 P,-1,100',
                ].join('\n');
                const options = { symbol: 'TQQQ', defaultSharesPerContract: 100 };
                const discovery = importer.parse(csv, options);
                const plan = page.planTwsBaselineSupersession(discovery, [adopted]);
                assert.deepEqual(Array.from(plan.eventIds), ['adopted-event-1']);

                const baseline = page.buildImportBaseline(
                    false, core.computeLedger([adopted]), [adopted],
                    discovery.statementThrough, plan.eventIds);
                assert.equal(baseline.existingOpen.length, 0);
                const parsed = importer.parse(csv, Object.assign({}, options, baseline));
                assert.equal(parsed.openings.drafts.length, 0);
                const ledger = core.computeLedger(parsed.events.map(
                    (event, index) => Object.assign({ seq: index + 1 }, event)));
                assert.equal(ledger.openOptions[0].contracts, -1);
                assert.equal(ledger.combined.netCash, 150);
            },
        },
        {
            name: 'an incremental CSV after the TWS snapshot keeps the adopted baseline',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const importer = context.OptionComboCostBasisImport;
                const adopted = {
                    eventId: 'adopted-event-2', seq: 1,
                    kind: 'option_trade', tradeDate: '2026-08-25',
                    account: 'U1', right: 'P', strike: 68.5, expiry: '20260828',
                    contracts: -1, sharesPerContract: 100,
                    localSymbol: 'TQQQ 28AUG26 68.5 P', price: 1.23,
                    cashAmount: 123, fees: 0, source: 'reconcile',
                    tag: 'tws_snapshot', externalRef: 'tws-position-2',
                    note: 'Snapshot timestamp 2026-08-25T12:00:00.',
                };
                const csv = [
                    'Statement,Header,Field Name,Field Value',
                    'Statement,Data,Period,"August 25, 2026 - August 26, 2026"',
                    'Account Information,Header,Field Name,Field Value',
                    'Account Information,Data,Account,U1',
                    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,'
                        + 'Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code',
                    'Trades,Data,Order,Equity and Index Options,USD,'
                        + 'TQQQ 28AUG26 68.5 P,"2026-08-25, 13:00:00",'
                        + '-1,1.5,150,0,O',
                    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,'
                        + 'Symbol,Quantity,Multiplier',
                    'Open Positions,Data,Summary,Equity and Index Options,USD,'
                        + 'TQQQ 28AUG26 68.5 P,-2,100',
                ].join('\n');
                const result = importer.parse(csv, {
                    symbol: 'TQQQ', defaultSharesPerContract: 100,
                });
                assert.deepEqual(Array.from(
                    page.planTwsBaselineSupersession(result, [adopted]).eventIds), []);
            },
        },
        {
            name: 'a legacy TWS baseline recovers same-day ordering from its creation time',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const importer = context.OptionComboCostBasisImport;
                const localNoon = new Date(2026, 7, 25, 12, 0, 0);
                const adopted = {
                    eventId: 'legacy-adopted-event', seq: 1,
                    kind: 'option_trade', tradeDate: '2026-08-25',
                    account: 'U1', right: 'P', strike: 68.5, expiry: '20260828',
                    contracts: -1, sharesPerContract: 100,
                    localSymbol: 'TQQQ 28AUG26 68.5 P', price: 1.23,
                    cashAmount: 123, fees: 0, source: 'reconcile',
                    tag: 'tws_snapshot', externalRef: 'legacy-tws-position',
                    createdAtUtc: localNoon.toISOString(),
                    note: 'Adopted from an authoritative TWS position snapshot.',
                };
                const csv = [
                    'Statement,Header,Field Name,Field Value',
                    'Statement,Data,Period,"August 1, 2026 - August 25, 2026"',
                    'Account Information,Header,Field Name,Field Value',
                    'Account Information,Data,Account,U1',
                    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,'
                        + 'Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code',
                    'Trades,Data,Order,Equity and Index Options,USD,'
                        + 'TQQQ 28AUG26 68.5 P,"2026-08-25, 10:00:00",'
                        + '-1,1.5,150,0,O',
                    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,'
                        + 'Symbol,Quantity,Multiplier',
                    'Open Positions,Data,Summary,Equity and Index Options,USD,'
                        + 'TQQQ 28AUG26 68.5 P,-1,100',
                ].join('\n');
                const options = { symbol: 'TQQQ', defaultSharesPerContract: 100 };
                const covering = importer.parse(csv, options);
                assert.deepEqual(Array.from(
                    page.planTwsBaselineSupersession(covering, [adopted]).eventIds),
                ['legacy-adopted-event']);

                const later = importer.parse(csv.replace('10:00:00', '13:00:00'), options);
                assert.deepEqual(Array.from(
                    page.planTwsBaselineSupersession(later, [adopted]).eventIds), []);

                const noClock = Object.assign({}, adopted, { createdAtUtc: '' });
                const ambiguous = page.planTwsBaselineSupersession(covering, [noClock]);
                assert.deepEqual(Array.from(ambiguous.eventIds), []);
                assert.equal(ambiguous.problems.length, 1);
            },
        },
        {
            name: 'partial pre-snapshot CSV overlap is blocking instead of double-counted',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const importer = context.OptionComboCostBasisImport;
                const adopted = {
                    eventId: 'adopted-event-3', seq: 1,
                    kind: 'option_trade', tradeDate: '2026-08-25',
                    account: 'U1', right: 'P', strike: 68.5, expiry: '20260828',
                    contracts: -1, sharesPerContract: 100,
                    localSymbol: 'TQQQ 28AUG26 68.5 P', price: 1.23,
                    cashAmount: 123, fees: 0, source: 'reconcile',
                    tag: 'tws_snapshot', externalRef: 'tws-position-3',
                    note: 'Snapshot timestamp 2026-08-25T12:00:00.',
                };
                const csv = [
                    'Statement,Header,Field Name,Field Value',
                    'Statement,Data,Period,"August 20, 2026 - August 26, 2026"',
                    'Account Information,Header,Field Name,Field Value',
                    'Account Information,Data,Account,U1',
                    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,'
                        + 'Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code',
                    'Trades,Data,Order,Equity and Index Options,USD,'
                        + 'TQQQ 28AUG26 68.5 P,"2026-08-25, 10:00:00",'
                        + '-0.5,1.5,75,0,O',
                    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,'
                        + 'Symbol,Quantity,Multiplier',
                    'Open Positions,Data,Summary,Equity and Index Options,USD,'
                        + 'TQQQ 28AUG26 68.5 P,-1,100',
                ].join('\n');
                const result = importer.parse(csv, {
                    symbol: 'TQQQ', defaultSharesPerContract: 100,
                });
                const plan = page.planTwsBaselineSupersession(result, [adopted]);
                assert.deepEqual(Array.from(plan.eventIds), []);
                assert.equal(plan.problems.length, 1);
                assert.match(plan.problems[0].reason, /partially or ambiguously overlaps/);
            },
        },
        {
            name: 'an incomplete cost is labelled on the headline, not only below it',
            run() {
                const source = readScript();
                assert.match(source, /rendered\.costIncomplete/);
                assert.match(source, /成本不完整/);
                assert.match(source, /value-incomplete/);
            },
        },
        {
            name: 'the page states that it neither trades nor subscribes',
            run() {
                const html = readPage();
                assert.match(html, /不下单/);
                assert.match(html, /不订阅行情/);
            },
        },
        {
            name: 'an actionless reconciliation warning is rendered without a draft button',
            run() {
                const source = readScript();
                assert.match(source, /entry\.advice \|\| ''/);
                assert.match(source, /entry\.advice \? 'confidence-low' : ''/);
            },
        },
        {
            name: 'the page exposes a distinct FOP FUT book and its roll controls',
            run() {
                const html = readPage();
                const source = readScript();
                assert.match(html, /<option value="FUT">FOP \/ FUT<\/option>/);
                ['futureExpiry', 'futureContracts', 'rollToExpiry',
                    'rollToPrice', 'rollGroup'].forEach((field) => {
                    assert.ok(html.includes(`data-field="${field}"`));
                });
                assert.match(source, /secType:\s*\$\('new-book-type'\)\.value/);
                assert.match(source, /secType:\s*book \? \(book\.secType \|\| 'STK'\)/);
                assert.match(source, /core\.computeLedger\(state\.allEvents, \{/);
                assert.match(source, /core\.buildReconciliation\(\{[\s\S]{0,180}secType/);
            },
        },
        {
            name: 'complete CSV FUT history supersedes its temporary TWS baseline',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const adopted = {
                    eventId: 'adopted-fut-1', kind: 'futures_trade',
                    tradeDate: '2026-08-26', account: 'U1',
                    futureExpiry: '202609', futureConId: 1001,
                    futureContracts: 1, sharesPerContract: 50,
                    price: 5000, cashAmount: 0, fees: 0,
                    source: 'reconcile', tag: 'tws_snapshot',
                    note: 'Snapshot timestamp 2026-08-26T12:00:00.',
                };
                const covering = {
                    format: 'activity', account: 'U1',
                    statementThrough: '2026-08-26T23:59:59',
                    openings: { drafts: [], openingShares: 0 }, problems: [],
                    events: [{
                        kind: 'futures_trade', tradeDate: '2026-08-25',
                        brokerTimestamp: '2026-08-25T10:00:00', account: 'U1',
                        futureExpiry: '202609', futureConId: 1001,
                        futureContracts: 1, sharesPerContract: 50,
                        price: 4990, cashAmount: 0, fees: 0,
                        source: 'csv_import', tag: '',
                    }],
                };
                assert.deepEqual(Array.from(
                    page.planTwsBaselineSupersession(covering, [adopted]).eventIds),
                ['adopted-fut-1']);
                covering.events[0].brokerTimestamp = '2026-08-26T13:00:00';
                covering.events[0].tradeDate = '2026-08-26';
                assert.deepEqual(Array.from(
                    page.planTwsBaselineSupersession(covering, [adopted]).eventIds), []);
            },
        },
        {
            name: 'TWS snapshots are invalidated and generation-matched across refreshes',
            run() {
                const source = readScript();
                assert.match(source,
                    /socket\.onclose = \(\) => \{[\s\S]{0,220}_invalidatePositions\(\)/);
                assert.match(source,
                    /function requestPositions\(\) \{[\s\S]{0,220}_invalidatePositions\(\)/);
                assert.match(source,
                    /requestId:\s*state\.positionsRequestId/);
                assert.match(source,
                    /incomingRequestId !== state\.positionsRequestId/);
                assert.match(source,
                    /state\.positionsAt && state\.positionsConnected[\s\S]{0,80}\? \{ takenAt/);
            },
        },
        {
            name: 'a complete TWS-only position is adopted directly instead of filling the form',
            run() {
                const source = readScript();
                const html = readPage();
                assert.match(html, /采信 TWS/);
                assert.match(source, /buildTwsAdoptionEvent/);
                assert.match(source, /button\.textContent = '采信 TWS'/);
                assert.match(source,
                    /async function _adoptTwsPosition[\s\S]{0,1600}import_cost_basis_events/);
                assert.match(source, /events:\s*\[copy\]/);
                assert.match(source, /TWS 均价不可用/);
            },
        },
    ],
};
