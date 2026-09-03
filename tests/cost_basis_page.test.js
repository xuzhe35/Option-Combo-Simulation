const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

// Exercise the real page handlers without sockets, browser persistence, or
// writes. The private bindings are exposed only in this test-loaded copy.
function loadReconciliationHarness() {
    const context = loadPage();
    vm.runInContext(readScript().replace('globalScope.OptionComboCostBasisPage = {', `
        globalScope.pageHarness = {
            state, render: _renderReconciliationTable, fetch: _fetchTwsExecutions,
            configure(handlers) {
                if (handlers.adopt) _adoptTwsPosition = handlers.adopt;
                if (handlers.request) request = handlers.request;
                _refreshControls = () => {};
                _renderReconciliation = _renderReconciliationTable;
                _renderImportPreview = () => {};
            },
        };
        globalScope.OptionComboCostBasisPage = {`), context);
    function node() {
        return {
            children: [], handlers: {}, textContent: '',
            appendChild(child) { this.children.push(child); return child; },
            removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
            get firstChild() { return this.children[0]; },
            addEventListener(name, callback) { this.handlers[name] = callback; },
            querySelector() { return this.body || (this.body = node()); },
        };
    }
    const nodes = new Map();
    const alerts = [];
    context.document = {
        createElement: node,
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, node());
            return nodes.get(id);
        },
    };
    context.alert = (message) => alerts.push(message);
    const harness = context.pageHarness;
    Object.assign(harness.state, {
        bookId: 'book-test', books: [{bookId: 'book-test', account: 'U1', symbol: 'TQQQ', secType: 'STK'}],
        positionsConnected: true, positionsTimestamp: '2026-09-03T10:00:00',
        ledger: context.OptionComboCostBasisCore.computeLedger([]),
    });
    harness.configure({});
    return { ...harness, context, alerts,
        buttons() { return nodes.get('reconcile-table').body.children[0].children[7].children; },
    };
}

module.exports = {
    name: 'cost_basis page',
    tests: [
        {
            name: 'bulk API conflicts on clockless baselines direct users to targeted replay without relaxing the guard',
            run() {
                const context = loadPage();
                const baseline = {eventId:'baseline',kind:'option_trade',tradeDate:'2026-09-02',
                    source:'reconcile',tag:'tws_snapshot',account:'U1',right:'C',strike:71,
                    expiry:'20260904',sharesPerContract:100,contracts:-2,price:1,cashAmount:200,
                    createdAtUtc:'2026-09-02T00:00:00Z'};
                const fill = {...baseline,eventId:undefined,source:'execution_report',tag:'ibkr_exec',
                    brokerTimestamp:'2026-09-02T10:00:00',externalRef:'ibkr-exec-real'};
                const plan = context.OptionComboCostBasisPage.planTwsBaselineSupersession({
                    format:'tws_api',account:'U1',statementThrough:'2026-09-02T12:00:00',
                    events:[fill],problems:[],openings:{drafts:[]},
                },[baseline]);
                assert.equal(plan.eventIds.length, 0);
                assert.equal(plan.problems.length, 1);
                assert.match(plan.problems[0].reason, /先取消本次预览/);
                assert.match(plan.problems[0].reason, /持仓对账.*查找 TWS 成交/);
                assert.match(plan.problems[0].reason, /完整 CSV 覆盖式重建/);
            },
        },
        {
            name: 'targeted replay is not blocked by another contract awaiting commission',
            async run() {
                function setup() {
                    const h = loadReconciliationHarness();
                    const opening = {account:'U1',kind:'option_trade',right:'C',strike:71,
                        expiry:'20260904',sharesPerContract:100,contracts:-2,price:1,
                        cashAmount:200,fees:0,tradeDate:'2026-09-01'};
                    h.state.allEvents = [opening];
                    h.state.ledger = h.context.OptionComboCostBasisCore.computeLedger([opening]);
                    const entry = {...opening,kind:'option',status:'ledger_only',label:'TQQQ C71',
                        ledger:-2,tws:0,difference:2};
                    h.state.reconciliation = {rows:[entry]};
                    const fill = {account:'U1',symbol:'TQQQ',secType:'OPT',execId:'target',
                        right:'C',strike:71,expiry:'20260904',multiplier:100,side:'BOT',
                        quantity:2,price:0.2,commission:1,commissionAvailable:true,
                        brokerTimestamp:'2026-09-03T10:00:00'};
                    return {h,entry,fill};
                }
                const {h,entry,fill} = setup();
                h.configure({request: async () => ({fetchedAt:'2026-09-03T11:00:00',
                    executions:[{...fill,strike:72,execId:'other',commissionAvailable:false},fill]})});
                await h.fetch(entry);
                assert.equal(h.alerts.length, 0);
                assert.equal(h.state.importResult.events.length, 1);
                assert.equal(h.state.importResult.events[0].externalRef, 'ibkr-exec-target');
                assert.equal(h.state.importResult.events[0].cashAmount, -41);
                assert.equal(h.state.importResult.problems.length, 0);
                assert.equal(h.state.importResult.reconciliationExecution.complete, true);

                const blocked = setup();
                blocked.h.configure({request: async () => ({fetchedAt:'2026-09-03T11:00:00',
                    executions:[blocked.fill,{...blocked.fill,execId:'pending',commissionAvailable:false}]})});
                await blocked.h.fetch(blocked.entry);
                assert.equal(blocked.h.state.importResult, null);
                assert.match(blocked.h.alerts[0], /佣金回报尚未到齐/);
            },
        },
        {
            name: 'target problem filtering retains unknown identities and cross-contract duplicate execIds',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const target = {account:'U1',symbol:'TQQQ',right:'C',strike:71,
                    expiry:'20260904',sharesPerContract:100,conId:123};
                const fill = {...target,secType:'OPT',multiplier:100,execId:'shared'};
                const unrelated = {...fill,conId:456,strike:72};
                const problem = {lineNumber:2,reason:'duplicate'};
                assert.equal(page.targetExecutionProblems([problem], [fill,unrelated],target).length, 1);
                assert.equal(page.targetExecutionProblems([problem], [fill,
                    {...unrelated,execId:'different'}],target).length, 0);
                assert.equal(page.targetExecutionProblems([{lineNumber:0}], [],target).length, 1);
                assert.equal(page.targetExecutionProblems([{lineNumber:1}], [{account:'U1'}],target).length, 1);
                assert.equal(page.targetExecutionProblems([{lineNumber:1}],
                    [{account:'U1',right:'?',secType:'?',multiplier:0,strike:-1}],target).length, 1);
                assert.equal(page.targetExecutionProblems([{lineNumber:1}],
                    [{...unrelated,conId:123}],target).length, 1,
                    'same conId with conflicting descriptors must not be dropped');
            },
        },
        {
            name: 'TWS-only options retain explicit baseline adoption beside execution lookup, including after failure',
            async run() {
                const h = loadReconciliationHarness();
                const entry = {kind:'option', status:'tws_only', account:'U1', label:'TQQQ P70',
                    right:'P', strike:70, expiry:'20260904', sharesPerContract:100,
                    ledger:0, tws:-2, difference:-2, twsAvgCost:1.25};
                h.state.reconciliation = {rows:[entry]};
                let adopted = null;
                h.configure({adopt: (row, event) => { adopted = event; },
                    request: async () => { throw new Error('history unavailable'); }});
                h.render();
                assert.deepEqual(h.buttons().map(b => b.textContent), ['查找 TWS 成交', '采信 TWS']);
                h.buttons()[1].handlers.click();
                assert.equal(adopted.contracts, -2);
                assert.equal(adopted.tag, 'tws_snapshot');
                assert.equal(adopted.cashAmount, 250);
                await h.fetch(entry);
                assert.equal(h.alerts.length, 1);
                assert.equal(h.buttons()[1].textContent, '采信 TWS');
                assert.equal(h.buttons()[1].disabled, false);
                h.state.executionFetchPending = true;
                h.render();
                assert.equal(h.buttons()[1].disabled, true);
                h.state.executionFetchPending = false;
                entry.twsAvgCost = null;
                h.render();
                assert.deepEqual(h.buttons().map(b => b.textContent), ['查找 TWS 成交']);
            },
        },
        {
            name: 'cashflow heading opens a read-only expiry distribution without enlarging metric cards',
            run() {
                const html = readPage();
                const source = readScript();
                assert.match(html, /id="btn-open-premium-expiry"[^>]*aria-haspopup="dialog"/);
                const heading = html.slice(html.indexOf('class="panel-heading cashflow-heading"'),
                    html.indexOf('class="cash-grid"'));
                assert.match(heading, /id="btn-open-premium-expiry"/);
                const cards = Array.from(html.matchAll(/<article class="cash-card[^\"]*">([\s\S]*?)<\/article>/g));
                assert.equal(cards.length, 5);
                cards.forEach((card) => assert.doesNotMatch(card[1], /<button/));
                assert.equal((html.match(/id="btn-open-premium-expiry"/g) || []).length, 1);
                assert.match(html, /<dialog id="premium-expiry-modal"/);
                assert.match(html, /Short Put<\/th><th>Short Call<\/th><th>该日合计/);
                assert.match(html, /不是到期日再收款，也不是最终盈亏/);
                assert.match(source, /btn-open-premium-expiry'\)\.addEventListener\('click', _openPremiumExpiry\)/);
                const render = source.slice(source.indexOf('function _renderPremiumExpiry()'),
                    source.indexOf('function _renderDashboardSummary()'));
                assert.match(render, /core\.openShortPremiumByExpiry\(state\.ledger\)/);
                assert.match(render, /\.disabled = !available/);
                assert.match(render, /if \(modal\.open\) modal\.close\(\)/);
                assert.match(render, /state\.ledger\.combined\.costIncomplete/);
                assert.match(render, /当前没有未平仓的 Short Call \/ Put/);
                assert.match(render, /\.showModal\(\)/);
                assert.doesNotMatch(render, /request\(|state\.positions|AvgCost/);
                assert.match(source, /function _renderDashboardSummary\(\) \{\s*_renderPremiumExpiry\(\)/);
            },
        },
        {
            name: 'What If labels stay centered with their controls and wrap as pairs',
            run() {
                const html = readPage();
                const css = fs.readFileSync(path.join(PROJECT_ROOT, 'cost_basis.css'), 'utf8');
                assert.match(html, /class="what-if-field"><label for="what-if-expiry">计算至<\/label><select/);
                assert.match(html, /class="what-if-field"><label id="what-if-price-label"[^>]*>[\s\S]*?<\/label><input id="what-if-price"/);
                assert.match(css, /\.what-if-field\s*\{[^}]*align-items:\s*center/);
                assert.match(css, /\.what-if-controls\s*\{[^}]*flex-wrap:\s*wrap/);
                assert.match(css, /\.what-if-controls select, \.what-if-controls input, \.what-if-controls button\s*\{[^}]*height:\s*36px/);
                assert.doesNotMatch(css, /\.what-if-controls\s*\{[^}]*align-items:\s*flex-end/);
                assert.doesNotMatch(css, /premium-expiry-link/);
            },
        },
        {
            name: 'manual entry retries reuse one idempotency token',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                let generated = 0;
                const factory = () => `token-${++generated}`;
                const first = page.chooseManualSubmitToken('', '', 'book-a|row', factory);
                const retry = page.chooseManualSubmitToken(
                    first, 'book-a|row', 'book-a|row', factory);
                const changed = page.chooseManualSubmitToken(
                    retry, 'book-a|row', 'book-a|changed-row', factory);
                assert.equal(first, 'token-1');
                assert.equal(retry, first);
                assert.equal(changed, 'token-2');
                const source = readScript();
                assert.match(source, /state\.eventSubmitPending = true/);
                assert.match(source,
                    /btn-submit-event'\)\.disabled = !hasBook \|\| state\.eventSubmitPending/);
                assert.match(source, /clientToken,\s*\}\);/);
                assert.match(source, /if \(error\.code\)[\s\S]{0,180}eventSubmitToken = ''/);
            },
        },
        {
            name: 'stale ledger page loads cannot overwrite a newly selected book',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                assert.equal(page.isCurrentEventLoad('book-b', 'book-a', 2, 1), false);
                assert.equal(page.isCurrentEventLoad('book-a', 'book-a', 2, 1), false);
                assert.equal(page.isCurrentEventLoad('book-b', 'book-b', 2, 2), true);
                const source = readScript();
                const block = source.slice(
                    source.indexOf('async function _loadEvents'),
                    source.indexOf('/** The rows the flow table'));
                assert.match(block, /const bookId = state\.bookId/);
                assert.match(block, /bookId,\s*limit: LEDGER_FETCH_SIZE/);
                assert.doesNotMatch(block, /bookId: state\.bookId/);
                assert.match(block, /isCurrentEventLoad/);
            },
        },
        {
            name: 'book switching consumes disconnected load failures at both UI entries',
            async run() {
                const page = loadPage().OptionComboCostBasisPage;
                const failure = new Error('socket closed');
                let afterLoads = 0;
                let handled = null;
                const result = await page.loadSelectedBookSafely(
                    async () => { throw failure; },
                    async () => { afterLoads += 1; },
                    (error) => { handled = error; },
                );
                assert.equal(result, false);
                assert.equal(afterLoads, 0);
                assert.equal(handled, failure);

                // Even a defensive status-render failure must not recreate
                // the unhandled rejection that this boundary is meant to stop.
                const renderFailureResult = await page.loadSelectedBookSafely(
                    async () => { throw failure; },
                    async () => {},
                    () => { throw new Error('status render failed'); },
                );
                assert.equal(renderFailureResult, false);

                const source = readScript();
                const sidebarHandler = source.slice(
                    source.indexOf("button.addEventListener('click', async () =>"),
                    source.indexOf("const row = globalScope.document.createElement('div')"));
                const selectHandler = source.slice(
                    source.indexOf("$('book-select').addEventListener('change'"),
                    source.indexOf("$('btn-new-book').addEventListener('click'"));
                assert.match(sidebarHandler, /await _selectBook\(book\.bookId\)/);
                assert.doesNotMatch(sidebarHandler, /await _loadEvents\(\)/);
                assert.match(selectHandler, /await _selectBook\(changeEvent\.target\.value\)/);
                assert.doesNotMatch(selectHandler, /await _loadEvents\(\)/);
            },
        },
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
            name: 'recent TWS executions use a review gate and never auto-write',
            run() {
                const html = readPage();
                const source = readScript();
                assert.ok(html.includes('id="btn-fetch-executions"'));
                assert.match(source,
                    /request\('request_cost_basis_executions'[\s\S]{0,180}sinceTimestamp/);
                assert.match(source,
                    /core\.buildExecutionImport\(response\.executions/);
                assert.match(source,
                    /existingOpen: state\.ledger \? state\.ledger\.openOptions/);
                assert.match(source, /button\.textContent = '查找 TWS 成交'/);
                assert.match(source, /core\.matchReconciliationExecution/);
                assert.match(source, /期权 Close（平仓）/);
                assert.match(source, /button\.textContent = '确认导入成交'/);
                assert.match(source,
                    /button\.addEventListener\('click', _commitImport\)/);
                assert.match(source,
                    /twsReconciliation: apiImport[\s\S]{0,100}state\.importResult\.twsReconciliation/);
                assert.match(source, /fallback\.textContent = 'AvgCost 后备'/);
                assert.match(source,
                    /btn-fetch-executions'\)\.addEventListener\('click', _fetchTwsExecutions/);
                assert.match(source,
                    /state\.importResult = result;[\s\S]{0,180}_renderImportPreview\(\)/);
                assert.doesNotMatch(source,
                    /_fetchTwsExecutions[\s\S]{0,1800}import_cost_basis_events/);
            },
        },
        {
            name: 'AvgCost fallback fills a manual draft instead of writing directly',
            run() {
                const source = readScript();
                assert.match(source, /core\.buildTwsAvgCostGapDraft/);
                assert.match(source, /button\.textContent = '按 AvgCost 填草稿'/);
                assert.match(source,
                    /else if \(avgCostDraft\)[\s\S]{0,300}_fillForm\(avgCostDraft\)/);
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
                assert.match(source, /deleteButton\.dataset\.deleteBookId = book\.bookId/);
                assert.match(source, /_deleteBook\(book\.bookId, deleteButton\)/);
                assert.match(source,
                    /state\.books\.find\(\(candidate\) => candidate\.bookId === requestedId\)/);
                assert.match(source, /plan\.eventCount/);
                assert.match(source, /plan\.snapshotCount/);
                assert.match(source, /plan\.resetCount/);
                assert.match(source, /globalScope\.confirm\(/);
                assert.match(source, /confirmation:\s*plan\.phrase/);
                assert.doesNotMatch(source,
                    /请原样输入以下短语|phrase\.trim\(\) !== plan\.phrase/);
                assert.match(source, /delete_confirmation_mismatch/);
                assert.match(source, /error\.code === 'book_not_found'/);
                assert.match(source, /deleteConfirmed/);
                assert.match(source, /账本已删除成功，但刷新账本列表失败/);
                assert.match(source, /deleteSubmitted && !error\.code/);
                assert.match(source, /刷新后确认账本已不存在，删除已经成功/);
                assert.match(source, /if \(state\.bookId === bookId\)/);
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
            name: 'an untrusted empty TWS snapshot shows ledger positions without advice',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                assert.equal(page.canReconcilePositions('', false), false);
                assert.equal(page.canReconcilePositions('23:01:00', false), false);
                assert.equal(page.canReconcilePositions('23:01:00', true), true);
                const preview = page.buildLedgerPositionPreview({
                    perAccount: { U1: { shares: 200 }, U2: { shares: 0 } },
                    openOptions: [{
                        account: 'U1', expiry: '20280121', right: 'P',
                        strike: 60, contracts: 3,
                    }, {
                        account: 'U1', expiry: '20260902', right: 'P',
                        strike: 71, contracts: -2,
                    }, {
                        account: 'U1', expiry: '20260902', right: 'C',
                        strike: 72, contracts: -1,
                    }],
                }, 'TQQQ', 'STK');
                assert.deepEqual(JSON.parse(JSON.stringify(preview)), [{
                    kind: 'shares', account: 'U1', label: '股票', ledger: 200,
                    identityConflict: false,
                }, {
                    kind: 'option', account: 'U1', label: 'TQQQ 20260902 C72',
                    ledger: -1, identityConflict: false,
                }, {
                    kind: 'option', account: 'U1', label: 'TQQQ 20260902 P71',
                    ledger: -2, identityConflict: false,
                }, {
                    kind: 'option', account: 'U1', label: 'TQQQ 20280121 P60',
                    ledger: 3, identityConflict: false,
                }]);
                const source = readScript();
                assert.match(source,
                    /canReconcilePositions\(\s*state\.positionsAt, state\.positionsConnected\)/);
                assert.match(source,
                    /data\.ibConnected === true[\s\S]{0,80}data\.positionsReady === true/);
                assert.match(source, /buildLedgerPositionPreview\(\s*state\.ledger/);
                assert.match(source, /仅 CSV \/ 账本推测/);
                assert.match(source, /尚未与 TWS 当前持仓对账/);
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
            name: 'premium cards describe settlement status without denying received income',
            run() {
                const html = readPage();
                const source = readScript();
                assert.match(html, /已到期 \/ 已结算卖方权利金/);
                assert.match(html, /尚未到期卖方权利金/);
                assert.match(html, /Short Call \/ Put 净收入/);
                assert.match(html, /不含 Long Option 支出/);
                assert.equal(html.includes('未实现期权费'), false);
                assert.match(source, /同样已经收取/);
                assert.match(source, /summary\.openShortPremium/);
                assert.match(source, /summary\.realizedShortPremium/);
            },
        },
        {
            name: 'the rebuild flow uses one confirmation dialog and a server reset plan',
            run() {
                const source = readScript();
                const html = readPage();
                assert.ok(html.includes('id="import-replace"'));
                assert.equal(html.includes('id="import-confirm"'), false);
                assert.match(source, /const resetPlanReady = !replacing \|\| Boolean\(state\.resetPlan\)/);
                assert.match(source, /globalScope\.confirm\(replacing/);
                assert.match(source, /confirmation: state\.resetPlan\.phrase/);
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
            name: 'the flow shows newest events first in pages of twenty-five',
            run() {
                const source = readScript();
                const flowRows = source.slice(
                    source.indexOf('function _flowRows()'),
                    source.indexOf('function requestPositions()'));
                assert.match(source, /const FLOW_PAGE_SIZE = 25;/);
                assert.match(flowRows, /state\.ledger\.rows\.filter\([\s\S]*\)\.reverse\(\)/);
                assert.match(source, /最新优先 · 第/);
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
            name: 'untargeted TWS import supersedes only a fully reconstructed baseline',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const adopted = {
                    eventId: 'adopted-api-event', seq: 1,
                    kind: 'option_trade', tradeDate: '2026-08-31',
                    brokerTimestamp: '2026-08-31T12:00:00',
                    account: 'U1', right: 'P', strike: 72, expiry: '20260902',
                    contracts: -1, sharesPerContract: 100, conId: 123,
                    price: 1.5, cashAmount: 150, fees: 0,
                    source: 'reconcile', tag: 'tws_snapshot',
                    externalRef: 'tws-position-api',
                };
                const realExecution = {
                    kind: 'option_trade', tradeDate: '2026-08-31',
                    brokerTimestamp: '2026-08-31T10:00:00',
                    account: 'U1', right: 'P', strike: 72, expiry: '20260902',
                    contracts: -1, sharesPerContract: 100, conId: 123,
                    price: 1.5, cashAmount: 150, fees: 0,
                    source: 'execution_report', tag: 'ibkr_exec',
                    externalRef: 'ibkr-exec-api',
                };
                const result = {
                    format: 'tws_api', account: 'U1',
                    statementThrough: '2026-08-31T13:00:00+08:00',
                    events: [realExecution], problems: [],
                    openings: { drafts: [], shareDrafts: [], openingShares: 0 },
                };
                const plan = page.planTwsBaselineSupersession(result, [adopted]);
                assert.deepEqual(Array.from(plan.eventIds), ['adopted-api-event']);
                assert.deepEqual(Array.from(plan.replacementExecutionRefs), []);
                assert.equal(plan.problems.length, 0);

                const partial = Object.assign({}, result, {
                    events: [Object.assign({}, realExecution, { contracts: -0.5 })],
                });
                const blocked = page.planTwsBaselineSupersession(partial, [adopted]);
                assert.deepEqual(Array.from(blocked.eventIds), []);
                assert.equal(blocked.problems.length, 1);
            },
        },
        {
            name: 'same-day TWS fills replay in broker order and replace a provisional baseline',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const core = context.OptionComboCostBasisCore;
                const adopted = {
                    eventId: 'adopted-api-no-clock', seq: 1,
                    kind: 'option_trade', tradeDate: '2026-09-02',
                    account: 'U1', right: 'C', strike: 71, expiry: '20260904',
                    contracts: -1, sharesPerContract: 100, conId: 456,
                    // Cash deliberately matches neither fill. AvgCost is not
                    // evidence for choosing an execution.
                    price: 9.9999, cashAmount: 999.99, fees: 0,
                    source: 'reconcile', tag: 'tws_snapshot',
                    externalRef: 'tws-position-no-clock',
                    // Database insertion time is not broker time. In an Asia
                    // browser it is later than the TWS wall clock below.
                    createdAtUtc: '2026-09-02T14:09:42Z',
                };
                const first = {
                    kind: 'option_trade', tradeDate: '2026-09-02',
                    brokerTimestamp: '2026-09-02T10:01:00',
                    account: 'U1', right: 'C', strike: 71, expiry: '20260904',
                    contracts: -1, sharesPerContract: 100, conId: 456,
                    price: 0.41, cashAmount: 39.95, fees: 1.05,
                    source: 'execution_report', tag: 'ibkr_exec',
                    externalRef: 'ibkr-exec-first',
                };
                const second = Object.assign({}, first, {
                    brokerTimestamp: '2026-09-02T10:02:00',
                    price: 0.47, cashAmount: 45.96, fees: 1.04,
                    externalRef: 'ibkr-exec-second',
                });
                const target = {
                    kind: 'option', key: core.contractKey(first), account: 'U1',
                    right: 'C', strike: 71, expiry: '20260904', conId: 456,
                    sharesPerContract: 100, ledger: -1, tws: -2, difference: -1,
                };
                // Give the planner reversed input to prove it uses broker
                // timestamps rather than response/DOM order.
                const plan = page.planTargetExecutionReconciliation(
                    target, [second, first], [adopted]);
                assert.equal(plan.complete, true);
                assert.deepEqual(Array.from(plan.supersedeEventIds),
                    ['adopted-api-no-clock']);
                assert.deepEqual(Array.from(plan.events.map(
                    (event) => event.externalRef)), [
                    'ibkr-exec-first', 'ibkr-exec-second',
                ]);
                assert.deepEqual(Array.from(plan.events.map(
                    (event) => event.tag)), ['ibkr_exec', 'ibkr_exec']);
                assert.equal(plan.startingContracts, 0);
                assert.equal(plan.executionContracts, -2);
                assert.equal(plan.finalContracts, -2);
                assert.equal(plan.matchedContracts, -1);
            },
        },
        {
            name: 'TWS execution replay keeps a real ledger position and blocks contradictions',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const core = context.OptionComboCostBasisCore;
                const target = {
                    kind: 'option', account: 'U1', right: 'C', strike: 72,
                    expiry: '20260904', sharesPerContract: 100, conId: 789,
                    ledger: -2, tws: -1, difference: 1,
                };
                const close = {
                    kind: 'option_trade', tradeDate: '2026-09-02',
                    brokerTimestamp: '2026-09-02T10:10:00',
                    account: 'U1', right: 'C', strike: 72, expiry: '20260904',
                    sharesPerContract: 100, conId: 789, contracts: 1,
                    cashAmount: -50, price: 0.5, source: 'execution_report',
                    tag: 'ibkr_exec', externalRef: 'ibkr-exec-close',
                };
                const fit = page.planTargetExecutionReconciliation(
                    target, [close], []);
                assert.equal(fit.complete, true);
                assert.deepEqual(Array.from(fit.supersedeEventIds), []);
                assert.equal(fit.events[0].tag, 'ibkr_close');
                assert.equal(fit.finalContracts, -1);

                const contradiction = page.planTargetExecutionReconciliation(
                    target, [Object.assign({}, close, { contracts: 2 })], []);
                assert.equal(contradiction.complete, false);
                assert.match(contradiction.reason, /与 TWS 当前持仓 -1 不一致/);
            },
        },
        {
            name: 'a legacy TWS baseline never treats browser-local creation time as broker time',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const importer = context.OptionComboCostBasisImport;
                const adopted = {
                    eventId: 'legacy-adopted-event', seq: 1,
                    kind: 'option_trade', tradeDate: '2026-08-25',
                    account: 'U1', right: 'P', strike: 68.5, expiry: '20260828',
                    contracts: -1, sharesPerContract: 100,
                    localSymbol: 'TQQQ 28AUG26 68.5 P', price: 1.23,
                    cashAmount: 123, fees: 0, source: 'reconcile',
                    tag: 'tws_snapshot', externalRef: 'legacy-tws-position',
                    createdAtUtc: '2026-08-25T04:00:00Z',
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
                const ambiguous = page.planTwsBaselineSupersession(covering, [adopted]);
                assert.deepEqual(Array.from(ambiguous.eventIds), []);
                assert.equal(ambiguous.problems.length, 1);

                const later = importer.parse(csv.replace('10:00:00', '13:00:00'), options);
                const alsoAmbiguous = page.planTwsBaselineSupersession(later, [adopted]);
                assert.deepEqual(Array.from(alsoAmbiguous.eventIds), []);
                assert.equal(alsoAmbiguous.problems.length, 1);
            },
        },
        {
            name: 'next-day CSV aliases an exact stored TWS fill and blocks near misses',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const stored = {
                    eventId: 'api-fill-1', kind: 'option_trade',
                    tradeDate: '2026-08-31', brokerTimestamp: '2026-08-31T10:00:00',
                    account: 'U1', right: 'P', strike: 72, expiry: '20260902',
                    contracts: -1, sharesPerContract: 100, conId: 123,
                    price: 1.01, cashAmount: 100.44, fees: 0.56,
                    source: 'execution_report', tag: 'ibkr_exec',
                    externalRef: 'ibkr-exec-E1',
                };
                const csvEvent = Object.assign({}, stored, {
                    eventId: undefined, source: 'csv_import', tag: 'ibkr_open',
                    externalRef: 'stmt-deadbeef', lineNumber: 4,
                });
                const exact = page.planExecutionReportAliases({
                    format: 'activity', events: [csvEvent],
                }, [stored]);
                assert.equal(exact.matched.length, 1);
                assert.equal(exact.aliases['U1\u0000stmt-deadbeef'], 'ibkr-exec-E1');
                assert.equal(exact.problems.length, 0);

                const nearMiss = page.planExecutionReportAliases({
                    format: 'activity', events: [Object.assign({}, csvEvent, {
                        cashAmount: 100.40,
                    })],
                }, [stored]);
                assert.equal(nearMiss.matched.length, 0);
                assert.equal(nearMiss.problems.length, 1);
            },
        },
        {
            name: 'replacement rebuild ignores overlap checks against rows it will remove',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const stored = {
                    eventId: 'api-fill-1', kind: 'option_trade',
                    tradeDate: '2026-08-31', brokerTimestamp: '2026-08-31T10:00:00',
                    account: 'U1', right: 'P', strike: 72, expiry: '20260902',
                    contracts: -1, sharesPerContract: 100, conId: 123,
                    price: 1.01, cashAmount: 100.44, fees: 0.56,
                    source: 'execution_report', tag: 'ibkr_exec',
                    externalRef: 'ibkr-exec-E1',
                };
                const csvEvent = Object.assign({}, stored, {
                    eventId: undefined, source: 'csv_import', tag: 'ibkr_open',
                    brokerTimestamp: '2026-08-31T11:00:00',
                    externalRef: 'stmt-deadbeef', lineNumber: 4,
                });
                const append = page.planImportExecutionAliases(false, {
                    format: 'activity', events: [csvEvent],
                }, [stored]);
                assert.equal(append.problems.length, 1);

                const replace = page.planImportExecutionAliases(true, {
                    format: 'activity', events: [csvEvent],
                }, [stored]);
                assert.equal(Object.keys(replace.aliases).length, 0);
                assert.equal(replace.matched.length, 0);
                assert.equal(replace.problems.length, 0);
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
            name: 'cash balances use direct signed account-cash semantics',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const source = readScript();
                assert.equal(page.formatSignedMoney(1504.314648), '+1,504.31');
                assert.equal(page.formatSignedMoney(-0.32946), '-0.33');
                assert.equal(page.formatSignedMoney(-0.001), '0.00');
                assert.equal(page.currencySymbol('USD'), '$');
                assert.equal(page.formatCurrencyAmount('USD', 70.9888, 4), '$70.9888');
                assert.equal(page.formatCurrencyAmount('USD', -2055.7, 2, true), '-$2,055.70');
                assert.equal(page.formatCurrencyAmount('USD', 980.79, 2, true), '+$980.79');
                assert.match(source, /累计净现金（收正付负）/);
                assert.ok(source.includes('累计净现金 ${_signedMoney'));
                assert.doesNotMatch(source, /`\$\{book\.currency \|\| 'USD'\} /);
                assert.doesNotMatch(source, /净现金流出|累计已实现/);
            },
        },
        {
            name: 'market value and diluted P&L use the visible cost lens',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const gain = page.computeMarketMetrics(70, 200, 64.4206);
                assert.equal(gain.marketValue, 14000);
                assert.ok(Math.abs(gain.dilutedPnl - 1115.88) < 1e-9);
                const loss = page.computeMarketMetrics(60, 200, 64.4206);
                assert.equal(loss.marketValue, 12000);
                assert.ok(Math.abs(loss.dilutedPnl - (-884.12)) < 1e-9);
                // The same signed equation correctly values a short: a
                // price below its buy-back waterline is a positive result.
                const shortGain = page.computeMarketMetrics(60, -200, 64.4206);
                assert.equal(shortGain.marketValue, -12000);
                assert.ok(Math.abs(shortGain.dilutedPnl - 884.12) < 1e-9);
                const unavailable = page.computeMarketMetrics(null, 200, 64.4206);
                assert.equal(unavailable.marketValue, null);
                assert.equal(unavailable.dilutedPnl, null);
            },
        },
        {
            name: 'What If settles open options without selling current shares',
            run() {
                const html = readPage();
                const source = readScript();
                assert.ok(html.includes('id="what-if-price"'));
                assert.ok(html.includes('id="what-if-expiry"'));
                assert.ok(html.includes('id="btn-what-if-current"'));
                assert.ok(html.includes('id="what-if-total-cost"'));
                assert.ok(html.includes('id="what-if-total-caption"'));
                assert.ok(html.includes('id="what-if-final-shares"'));
                assert.ok(html.includes('id="what-if-put-shares"'));
                assert.ok(html.includes('id="what-if-outcomes"'));
                assert.match(html, /ITM Short Put 视为被指派/);
                assert.match(html, /现有股票不卖出/);
                assert.match(html, /不包含期权时间价值/);
                assert.match(html, /若未平仓卖方期权归零/);
                assert.match(source, /core\.computeOptionSettlementScenario\(/);
                assert.match(source, /request\('request_cost_basis_market_price'/);
                assert.match(source, /state\.marketPriceRefreshPending/);
                assert.match(source, /TWS 最新价/);
                assert.match(source, /throughExpiry: state\.whatIfExpiry/);
                assert.match(source, /继续保留：\$\{deferredText\}/);
                assert.match(source, /被指派：\$\{assignedText\}/);
                assert.match(source, /尚未到期卖方权利金 \$\{_currencyAmount\(currency/);
                assert.match(source, /已收取，但履约义务尚存/);
                assert.match(source, /Long Call \/ Put 全周期现金均排除/);
                assert.doesNotMatch(source, /computeLiquidationWhatIf/);
                assert.doesNotMatch(html, /预计清算现金|清算后剩余成本/);
            },
        },
        {
            name: 'the stress-test modal sweeps expiry outcomes across option strikes',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const html = readPage();
                const source = readScript();
                const events = [{
                    seq: 1, kind: 'opening_balance', tradeDate: '2026-06-01',
                    account: 'U1', shares: 200, price: 73, cashAmount: -14600,
                    fees: 0, includeInCost: true,
                }, {
                    seq: 2, kind: 'option_trade', tradeDate: '2026-08-01',
                    account: 'U1', right: 'P', strike: 72, expiry: '20260831',
                    contracts: -2, sharesPerContract: 100, price: 1,
                    cashAmount: 200, fees: 0, includeInCost: true,
                }, {
                    seq: 3, kind: 'option_trade', tradeDate: '2026-08-02',
                    account: 'U1', right: 'P', strike: 70, expiry: '20260902',
                    contracts: -1, sharesPerContract: 100, price: 1,
                    cashAmount: 100, fees: 0, includeInCost: true,
                }, {
                    seq: 4, kind: 'option_trade', tradeDate: '2026-08-03',
                    account: 'U1', right: 'P', strike: 65, expiry: '20270115',
                    contracts: 2, sharesPerContract: 100, price: 5,
                    cashAmount: -1000, fees: 0, includeInCost: true,
                }, {
                    seq: 5, kind: 'option_trade', tradeDate: '2026-08-03',
                    account: 'U1', right: 'C', strike: 80, expiry: '20270115',
                    contracts: 1, sharesPerContract: 100, price: 4,
                    cashAmount: -400, fees: 0, includeInCost: true,
                }];
                const series = page.buildStressTestSeries(events, {
                    centerPrice: 70, rangePct: 10, pointCount: 11,
                    throughExpiry: '20260831', basisMode: 'net_cash', secType: 'STK',
                });
                assert.equal(series.available, true);
                assert.equal(series.points.length, 11);
                assert.equal(series.points[0].price, 63);
                assert.equal(series.points[0].assignedContracts, 2);
                assert.equal(series.points[0].shares, 400);
                assert.equal(series.points[10].price, 77);
                assert.equal(series.points[10].assignedContracts, 0);
                assert.equal(series.points[10].expiredContracts, 2);
                assert.equal(series.points[10].shares, 200);
                series.points.filter((point) => point.cost !== null).forEach((point) => {
                    assert.ok(Math.abs(point.pnl
                        - ((point.price - point.cost) * point.shares)) < 1e-7);
                });
                const liveInputs = {
                    throughExpiry: '20260831',
                    fetchedAt: '2026-08-30T12:00:00Z',
                    curveEffectiveDate: '2026-08-28',
                    options: [
                        { right: 'C', strike: 80, expiry: '20270115',
                            impliedVolatility: 0.45, ivSource: 'modelGreeks' },
                        { right: 'P', strike: 65, expiry: '20270115',
                            impliedVolatility: 0.40, ivSource: 'modelGreeks' },
                    ],
                    ratesByExpiry: [{
                        expiry: '20270115', zeroRate: 0.03,
                        source: 'usd_reference_discount_curve',
                    }],
                };
                const protectedSeries = page.buildStressTestSeries(events, {
                    centerPrice: 70, rangePct: 10, pointCount: 11,
                    throughExpiry: '20260831', basisMode: 'net_cash', secType: 'STK',
                    includeDeferredLongOptions: true,
                    longOptionInputs: liveInputs,
                });
                assert.equal(protectedSeries.available, true);
                assert.equal(protectedSeries.longOptionCount, 2);
                assert.equal(protectedSeries.longOptionContracts, 3);
                assert.equal(protectedSeries.longCallContracts, 1);
                assert.equal(protectedSeries.longPutContracts, 2);
                assert.equal(protectedSeries.longOptionIvMin, 0.4);
                assert.equal(protectedSeries.longOptionIvMax, 0.45);
                assert.equal(protectedSeries.longOptionRateMin, 0.03);
                assert.ok(protectedSeries.points[0].longOptionMarketValue > 0);
                protectedSeries.points.forEach((point) => {
                    assert.ok(Math.abs(point.pnl
                        - point.basePnl - point.longOptionPnl) < 1e-7);
                });
                const referencePut = page.calculateBsmPutPrice(100, 100, 1, 0.05, 0.2);
                assert.ok(Math.abs(referencePut - 5.5735) < 0.001);
                const referenceCall = page.calculateBsmOptionPrice(
                    'C', 100, 100, 1, 0.05, 0.2);
                assert.ok(Math.abs(referenceCall - 10.4506) < 0.001);
                const lowMarks = page.estimateDeferredLongOptions([
                    { right: 'C', strike: 80, expiry: '20270115', contracts: 1,
                        sharesPerContract: 100, openPremium: -400 },
                    { right: 'P', strike: 65, expiry: '20270115', contracts: 2,
                        sharesPerContract: 100, openPremium: -1000 },
                ], 63, { throughExpiry: '20260831', marketInputs: liveInputs });
                const highMarks = page.estimateDeferredLongOptions([
                    { right: 'C', strike: 80, expiry: '20270115', contracts: 1,
                        sharesPerContract: 100, openPremium: -400 },
                    { right: 'P', strike: 65, expiry: '20270115', contracts: 2,
                        sharesPerContract: 100, openPremium: -1000 },
                ], 77, { throughExpiry: '20260831', marketInputs: liveInputs });
                assert.ok(highMarks.details.find((detail) => detail.right === 'C').markPerShare
                    > lowMarks.details.find((detail) => detail.right === 'C').markPerShare);
                assert.ok(lowMarks.details.find((detail) => detail.right === 'P').markPerShare
                    > highMarks.details.find((detail) => detail.right === 'P').markPerShare);
                const missingInputs = page.buildStressTestSeries(events, {
                    centerPrice: 70, rangePct: 10, pointCount: 11,
                    throughExpiry: '20260831', basisMode: 'net_cash', secType: 'STK',
                    includeDeferredLongOptions: true,
                });
                assert.equal(missingInputs.available, false);
                assert.equal(missingInputs.reason, 'missing_long_option_market_inputs');
                assert.ok(html.includes('id="btn-open-stress-test"'));
                assert.ok(html.includes('id="stress-modal"'));
                assert.match(html, /role="dialog" aria-modal="true"/);
                assert.ok(html.includes('id="stress-chart"'));
                assert.ok(html.includes('id="stress-tooltip"'));
                assert.ok(html.includes('id="stress-tooltip-pnl"'));
                assert.ok(html.includes('id="stress-tooltip-cost"'));
                assert.ok(html.includes('id="stress-include-long-options"'));
                assert.ok(html.includes('id="stress-option-iv-source"'));
                assert.ok(html.includes('id="stress-option-rate-source"'));
                assert.equal(html.includes('id="stress-long-option-iv"'), false);
                assert.ok(html.includes('id="stress-tooltip-long-option-value"'));
                assert.ok(html.includes('id="stress-tooltip-long-option-pnl"'));
                assert.ok(html.includes('id="stress-tooltip-long-option-iv"'));
                assert.ok(html.includes('id="stress-tooltip-long-option-rate"'));
                assert.match(html, /更晚到期的仓位继续保留/);
                assert.match(html, /不是 TWS 报价/);
                assert.match(source, /function buildStressTestSeries/);
                assert.match(source, /function estimateDeferredLongOptions/);
                assert.match(source, /\['C', 'P'\]\.includes/);
                assert.match(source,
                    /request\('request_cost_basis_option_scenario_inputs'/);
                assert.match(source, /missing_long_option_iv/);
                assert.match(source, /missing_discount_rate/);
                assert.match(source, /curveError/);
                assert.match(source, /optionScenarioInputs/);
                assert.match(source, /仅刷新页面无效/);
                assert.match(source, /mark \+ openPremium/);
                assert.match(source, /core\.computeOptionSettlementScenario\(events, price/);
                assert.match(source, /throughExpiry/);
                assert.match(source, /synthetic settlement rows that are never persisted/);
                assert.match(source, /svg\.onpointermove =/);
                assert.match(source, /svg\.onpointerleave = hideTooltip/);
                assert.match(source, /stress-tooltip-outcome/);
            },
        },
        {
            name: 'the hero never claims "no position" for a lens with no figure',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                // Shares are held; only the selected lens has no number.
                const noLens = page.describeHeadlineCost(
                    { available: false, state: 'no_data', costIncomplete: false },
                    { futures: false, basisMode: 'tax_adjusted' });
                assert.equal(noLens.source, 'unavailable');
                assert.doesNotMatch(noLens.caption, /无持股|无 FUT 持仓/);
                assert.match(noLens.caption, /税务调整/);
                // Only a genuinely flat book falls back to lifetime net cash.
                const flat = page.describeHeadlineCost(
                    { available: false, state: 'no_shares', costIncomplete: false },
                    { futures: false, basisMode: 'net_cash' });
                assert.equal(flat.source, 'lifetime_net_cash');
                assert.match(flat.caption, /当前无持股/);
            },
        },
        {
            name: 'the hero marks an incomplete cost on every path that shows a figure',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                // A closed-out book carrying a premium-less prior_open stub
                // still shows a lifetime figure, and it is exactly as
                // incomplete as a per-share cost would be.
                const closed = page.describeHeadlineCost(
                    { available: false, state: 'no_shares', costIncomplete: true },
                    { futures: false, basisMode: 'net_cash' });
                assert.equal(closed.source, 'lifetime_net_cash');
                assert.ok(closed.marks.includes('incomplete'));
                assert.match(closed.caption, /成本不完整/);
                const open = page.describeHeadlineCost(
                    { available: true, state: 'normal', value: 64.42, costIncomplete: true },
                    { futures: false, basisMode: 'net_cash' });
                assert.ok(open.marks.includes('incomplete'));
                const clean = page.describeHeadlineCost(
                    { available: true, state: 'short', value: 64.42, costIncomplete: false },
                    { futures: false, basisMode: 'net_cash' });
                // The sandbox has its own Array realm, so compare contents.
                assert.equal(Array.from(clean.marks).join(','), 'short');
                assert.match(clean.caption, /空头回补水位/);
            },
        },
        {
            name: 'a reference price follows its own book, and only that book',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const typed = { tqqq: 72.5 };
                // Going to another underlying must not inherit the price:
                // it would not read as missing, it would read as TSM's.
                assert.equal(
                    page.bookScopedStateReset('tsm', typed).referencePrice, null);
                // Coming back must not have thrown it away either.
                assert.equal(
                    page.bookScopedStateReset('tqqq', typed).referencePrice, 72.5);
                // A price of 0 is a real answer, not an absent one.
                assert.equal(
                    page.bookScopedStateReset('z', { z: 0 }).referencePrice, 0);
                // No store at all is still safe.
                assert.equal(page.bookScopedStateReset('tqqq').referencePrice, null);

                // Prices fetched for the old book stay cleared regardless -
                // TWS and the scenario refetch them for the new one.
                const refetched = ['marketPrice', 'whatIfPrice'];
                const reset = page.bookScopedStateReset('tsm', typed);
                refetched.forEach((key) => assert.equal(reset[key], null, key));

                const dirty = Object.assign({ basisMode: 'net_cash' }, {
                    marketPrice: 71.2,
                    avgCostByAccount: { U1: { avgCost: 64.4 } },
                    ledger: { combined: {} },
                    importText: 'old,csv',
                });
                Object.assign(dirty, page.bookScopedStateReset('tsm', typed));
                assert.equal(dirty.marketPrice, null);
                assert.deepEqual(Object.keys(dirty.avgCostByAccount), []);
                assert.equal(dirty.ledger, null);
                assert.equal(dirty.importText, '');
                // Things that are NOT book-scoped survive the switch.
                assert.equal(dirty.basisMode, 'net_cash');

                // A deleted book must not leave a price for its successor.
                const pruned = page.pruneReferencePrices(
                    { tqqq: 72.5, gone: 12 }, [{ bookId: 'tqqq' }]);
                assert.deepEqual(Object.keys(pruned), ['tqqq']);
                assert.equal(pruned.tqqq, 72.5);
                assert.deepEqual(Object.keys(page.pruneReferencePrices({ a: 1 }, [])), []);
                assert.deepEqual(Object.keys(page.pruneReferencePrices()), []);

                const source = readScript();
                // Both paths that land on a different book funnel through the
                // same reset - the implicit one after a delete used to
                // reassign state.bookId on its own.
                assert.equal(
                    source.split('_beginBookSelection(').length - 1 >= 3, true);
                // The store itself must never be inside the per-book reset.
                const resetBody = source.split('function bookScopedStateReset')[1]
                    .split('\n    }')[0];
                assert.doesNotMatch(resetBody, /referencePriceByBook:/);
            },
        },
        {
            name: 'a collapsed reconcile table still opens itself for a real difference',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const settled = [
                    { account: 'U1', label: 'TQQQ', status: 'match' },
                    { account: 'U1', label: 'TQQQ 2026-09-18 P70', status: 'explained' },
                ];
                // Nothing outstanding: the table stays folded away.
                const quiet = page.planReconcileDisclosure(settled, '');
                assert.equal(quiet.open, false);
                assert.equal(quiet.signature, '');
                // A difference appears - the user must not have to go looking.
                const rows = settled.concat(
                    [{ account: 'U1', label: 'TQQQ', status: 'mismatch' }]);
                const first = page.planReconcileDisclosure(rows, '');
                assert.equal(first.open, true);
                // Same difference on a later render: a deliberate collapse holds.
                const again = page.planReconcileDisclosure(rows, first.signature);
                assert.equal(again.open, false);
                // The difference changes shape - open it again.
                const grown = rows.concat(
                    [{ account: 'U1', label: 'TQQQ 2026-10-16 P65', status: 'missing' }]);
                assert.equal(
                    page.planReconcileDisclosure(grown, first.signature).open, true);
                // Row order must not by itself count as a change.
                const shuffled = rows.slice().reverse();
                assert.equal(
                    page.planReconcileDisclosure(shuffled, first.signature).open, false);
                // No reconciliation at all is not a silent all-clear either way.
                assert.equal(page.planReconcileDisclosure([], '').open, false);
            },
        },
        {
            name: 'the CSV import label carries its own disabled affordance',
            run() {
                const html = readPage();
                // The input is visually hidden, so clicking its label while
                // the input is disabled does nothing at all - the label has
                // to look dead on its own or it swallows the click silently.
                assert.match(html,
                    /<label for="import-file" class="file-button is-disabled"/);
                const source = readScript();
                assert.match(source, /label\[for="import-file"\]/);
                const css = fs.readFileSync(
                    path.join(PROJECT_ROOT, 'cost_basis.css'), 'utf8');
                assert.match(css, /\.file-button\.is-disabled[^}]*pointer-events:\s*none/);
                assert.doesNotMatch(css, /\.file-button:hover/);
            },
        },
        {
            name: 'the cash card combines dividends with realized stock P&L',
            run() {
                const html = readPage();
                const source = readScript();
                assert.match(html, /股息 \+ 股票已实现盈亏/);
                assert.match(source,
                    /Number\(summary\.dividends \|\| 0\) \+ Number\(summary\.stockRealizedPnl \|\| 0\)/);
                assert.match(source, /股息 \$\{_signedMoney\(summary\.dividends\)\}/);
                assert.match(source,
                    /股票已实现 \$\{_signedMoney\(summary\.stockRealizedPnl\)\}/);
                assert.ok(html.includes('id="summary-details"'));
                assert.ok(html.includes('id="btn-open-summary-details"'));
                assert.match(source, /details\.open = true/);
            },
        },
        {
            name: 'the summary presents negative shares as a supported short waterline',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const source = readScript();
                assert.match(page.BASIS_EXPLAINERS.net_cash, /空头/);
                assert.match(page.BASIS_EXPLAINERS.net_cash, /水位抬高/);
                assert.match(source, /当前股票净头寸/);
                assert.match(source, /空头回补水位/);
                assert.match(source, /头寸状态/);
                assert.match(source, /position-status/);
                assert.doesNotMatch(source, /出现净空头股票/);
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
            name: 'each live event exposes a safe delete action backed by voiding',
            run() {
                const html = readPage();
                const source = readScript();
                assert.match(html, /<th>操作<\/th>/);
                assert.match(html, /显示已删除记录/);
                assert.match(source, /button\.textContent = '删除'/);
                assert.match(source, /request\('void_cost_basis_event'/);
                assert.match(source, /保留一条可审计的冲销记录/);
                assert.doesNotMatch(source, /delete_cost_basis_event/);
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
            name: 'free-form manual notes cannot impersonate broker time',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const core = context.OptionComboCostBasisCore;
                const manual = {
                    kind: 'share_trade', tradeDate: '2026-08-25', account: 'U1',
                    shares: 100, price: 70, cashAmount: -7000, source: 'manual',
                    note: 'personal reminder 2026-08-25 10:00:00',
                };
                const manualBaseline = page.buildImportBaseline(
                    false, core.computeLedger([manual]), [manual],
                    '2026-08-25T12:00:00', []);
                assert.equal(
                    Object.keys(manualBaseline.existingSharesByAccount).length, 0);

                const csv = Object.assign({}, manual, { source: 'csv_import' });
                const trustedBaseline = page.buildImportBaseline(
                    false, core.computeLedger([csv]), [csv],
                    '2026-08-25T12:00:00', []);
                assert.equal(trustedBaseline.existingSharesByAccount.U1, 100);
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
                const requestBlock = source.slice(
                    source.indexOf('function requestPositions()'),
                    source.indexOf('async function _refreshWhatIfMarketPrice'));
                assert.doesNotMatch(requestBlock, /socket\.send/);
                assert.match(requestBlock, /_sendOneWay\('request_portfolio_positions_snapshot'/);
                assert.match(source,
                    /requestId:\s*state\.positionsRequestId/);
                assert.match(source,
                    /incomingRequestId !== state\.positionsRequestId/);
                assert.match(source,
                    /state\.positionsAt && state\.positionsConnected[\s\S]{0,80}\? \{ takenAt/);
                assert.match(source,
                    /function _invalidatePositions\(\)[\s\S]{0,500}_renderReconciliation\(\)/);
                assert.match(source,
                    /async function _bootstrap\(socket\)[\s\S]{0,500}state\.ws !== socket/);
                assert.doesNotMatch(source, /function _localTimestampIso/);
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
