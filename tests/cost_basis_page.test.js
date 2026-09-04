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
        'js/american_binomial.js',
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
            message: _handleMessage, renderWhatIf: _renderWhatIf,
            editPrice: _editWhatIfPrice, followPrice: _setWhatIfFollowReference,
            refreshPrice: _refreshWhatIfMarketPrice, invalidate: _invalidatePositions,
            selectPriceBook: _beginBookSelection,
            renderStress: _renderStressTest,
            refreshStressInputs: _refreshStressMarketInputs,
            invalidateScenario: _invalidateStressScenarioInputs,
            scenarioDate: _stressScenarioDate,
            restoreLinked: _restoreStressLinkedChoice,
            loadLinked: _loadStressLinkedEvents,
            ensureLinked: _ensureStressLinkedData,
            linkedRequest: _stressLinkedHedgeRequest,
            configurePrice() {
                _renderAll = _renderWhatIf;
                _renderPositionsStatus = () => {};
                _renderReconciliation = () => {};
            },
            configure(handlers) {
                if (handlers.adopt) _adoptTwsPosition = handlers.adopt;
                if (handlers.request) request = handlers.request;
                if (handlers.today) _todayIso = handlers.today;
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

function loadPriceHarness() {
    const h = loadReconciliationHarness();
    h.configurePrice();
    h.state.connection = 'connected';
    h.state.allEvents = [
        {kind:'share_trade',account:'U1',tradeDate:'2026-09-01',shares:200,
            price:70,cashAmount:-14000},
        {kind:'option_trade',account:'U1',tradeDate:'2026-09-01',right:'P',
            strike:71,expiry:'20260904',sharesPerContract:100,contracts:-2,
            price:1,cashAmount:200},
    ];
    h.state.ledger = h.context.OptionComboCostBasisCore.computeLedger(h.state.allEvents);
    h.node = (id) => h.context.document.getElementById(id);
    h.update = (price, overrides = {}) => h.message({action:'portfolio_avg_cost_update',
        items:[{symbol:'TQQQ',secType:'STK',account:'U1',position:200,
            avgCostPerUnit:70,marketPrice:price,...overrides}]});
    h.edit = (value) => {
        const input = h.node('what-if-price');
        input.value = value;
        h.context.document.activeElement = input;
        h.editPrice({target:input});
    };
    return h;
}

module.exports = {
    name: 'cost_basis page',
    tests: [
        {
            name: 'selecting a book primes its reference from the existing portfolio cache once',
            run() {
                const h = loadPriceHarness();
                const sent = [];
                h.state.ws = {readyState:1,send: (message) => sent.push(JSON.parse(message))};
                h.selectPriceBook('book-test');
                assert.equal(sent.length, 1);
                assert.equal(sent[0].action, 'request_portfolio_avg_cost_snapshot');
                h.update(70.7263);
                assert.equal(h.state.marketPrice, 70.7263);
                assert.equal(sent.length, 1);
            },
        },
        {
            name: 'What If follows portfolio prices and recalculates without any request or ledger write',
            run() {
                const h = loadPriceHarness();
                const originalEvents = JSON.stringify(h.state.allEvents);
                h.configure({request: () => { throw new Error('unexpected network request'); }});
                h.configurePrice();
                h.update(70.7263);
                assert.equal(h.node('what-if-price').value, '70.7263');
                assert.equal(h.node('what-if-follow-reference').checked, true);
                assert.equal(h.node('what-if-final-shares').textContent, '400 股');
                const firstCost = h.node('what-if-result').textContent;
                h.update(72);
                assert.equal(h.node('what-if-price').value, '72');
                assert.equal(h.node('what-if-final-shares').textContent, '200 股');
                assert.notEqual(h.node('what-if-result').textContent, firstCost);
                assert.match(h.node('what-if-context').textContent, /自动跟随 TWS 持仓快照价/);
                h.update(300, {symbol:'TSM'});
                h.update(500, {account:'U2'});
                h.update(2, {secType:'OPT'});
                h.update(null);
                h.update(NaN);
                assert.equal(h.node('what-if-price').value, '72');
                assert.equal(JSON.stringify(h.state.allEvents), originalEvents);
            },
        },
        {
            name: 'manual What If prices including zero and blank pause following; checkbox resumes without a quote',
            run() {
                const h = loadPriceHarness();
                h.update(70);
                h.edit('75');
                h.update(69);
                assert.equal(h.node('what-if-price').value, '75');
                assert.equal(h.node('what-if-follow-reference').checked, false);
                assert.equal(h.node('what-if-final-shares').textContent, '200 股');
                assert.match(h.node('what-if-context').textContent, /自动跟随已暂停/);
                h.edit('0');
                h.update(68);
                assert.equal(h.node('what-if-price').value, '0');
                assert.equal(h.node('what-if-final-shares').textContent, '400 股');
                h.edit('');
                h.update(67);
                assert.equal(h.node('what-if-price').value, '');
                assert.equal(h.node('what-if-result').textContent, '—');
                h.followPrice(true);
                assert.equal(h.node('what-if-price').value, '67');
                h.followPrice(false);
                h.update(66);
                assert.equal(h.node('what-if-price').value, '67');
                h.state.referencePrice = 73;
                h.followPrice(true);
                assert.equal(h.node('what-if-price').value, '73');
                assert.match(h.node('what-if-context').textContent, /自动跟随手工参考价/);
            },
        },
        {
            name: 'explicit current-price refresh resumes following and later portfolio pushes are not frozen',
            async run() {
                const h = loadPriceHarness();
                let calls = 0;
                h.configure({request: async (action, fields) => {
                    calls += 1;
                    assert.equal(action, 'request_cost_basis_market_price');
                    assert.equal(fields.bookId, 'book-test');
                    return {marketPrice:71.25,fetchedAt:'2026-09-03T10:15:00'};
                }});
                h.configurePrice();
                h.edit('60');
                h.state.referencePrice = 65;
                h.state.referencePriceByBook['book-test'] = 65;
                await h.refreshPrice();
                assert.equal(calls, 1);
                assert.equal(h.node('what-if-price').value, '71.25');
                assert.equal(h.node('what-if-follow-reference').checked, true);
                assert.equal(h.state.referencePrice, null);
                assert.equal(h.state.referencePriceByBook['book-test'], undefined);
                assert.match(h.node('what-if-context').textContent, /10:15:00/);
                h.update(72.1234);
                assert.equal(h.node('what-if-price').value, '72.1234');
                assert.doesNotMatch(h.node('what-if-context').textContent, /10:15:00/);
                assert.equal(calls, 1);
            },
        },
        {
            name: 'late quote responses cannot clobber new edits or a different book, and failures preserve the scenario',
            async run() {
                const h = loadPriceHarness();
                let resolve;
                h.configure({request: () => new Promise((done) => { resolve = done; })});
                h.configurePrice();
                const pending = h.refreshPrice();
                h.edit('60');
                resolve({marketPrice:72});
                await pending;
                assert.equal(h.node('what-if-price').value, '60');
                assert.equal(h.node('what-if-follow-reference').checked, false);
                const otherBook = h.refreshPrice();
                h.state.bookId = 'other';
                h.state.marketPrice = null;
                resolve({marketPrice:500});
                await otherBook;
                assert.equal(h.state.marketPrice, null);
                h.state.bookId = 'book-test';
                h.edit('60');
                h.configure({request: async () => { throw new Error('quote unavailable'); }});
                h.configurePrice();
                await h.refreshPrice();
                assert.equal(h.node('what-if-price').value, '60');
                assert.equal(h.state.marketPriceRefreshPending, false);
                assert.equal(h.alerts.length, 1);
            },
        },
        {
            name: 'unavailable portfolio prices clear automatic scenarios but preserve explicit assumptions',
            run() {
                const h = loadPriceHarness();
                h.update(72);
                h.invalidate();
                assert.equal(h.node('what-if-price').value, '');
                assert.equal(h.node('what-if-result').textContent, '—');
                assert.match(h.node('what-if-context').textContent, /等待 TWS 参考价/);
                h.edit('68');
                h.invalidate();
                assert.equal(h.node('what-if-price').value, '68');
                assert.equal(h.node('what-if-final-shares').textContent, '400 股');
                const reset = h.context.OptionComboCostBasisPage.bookScopedStateReset('book-test');
                Object.assign(h.state, reset);
                h.renderWhatIf();
                assert.equal(h.node('what-if-follow-reference').checked, true);
                assert.equal(h.node('what-if-follow-reference').disabled, true);
            },
        },
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
                // The American pricer is a standalone, side-effect-free
                // module (no sockets, no orders); it is the only addition.
                assert.deepEqual(scripts, [
                    'js/cost_basis_core.js',
                    'js/american_binomial.js',
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
                        // The short put that is still open on 2026-08-31.
                        { right: 'P', strike: 70, expiry: '20260902',
                            impliedVolatility: 0.50, ivSource: 'modelGreeks' },
                    ],
                    ratesByExpiry: [{
                        expiry: '20270115', zeroRate: 0.03,
                        source: 'usd_reference_discount_curve',
                    }, {
                        expiry: '20260902', zeroRate: 0.03,
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
                // The still-open short put is a liability marked with its own
                // IV; its premium (received, and excluded from the blended
                // cost until it settles) is credited here in full.
                assert.equal(protectedSeries.shortOptionCount, 1);
                assert.equal(protectedSeries.shortPutContracts, 1);
                assert.equal(protectedSeries.shortCallContracts, 0);
                assert.equal(protectedSeries.shortOptionIvMin, 0.5);
                protectedSeries.points.forEach((point) => {
                    assert.ok(Math.abs(point.pnl - point.basePnl
                        - point.longOptionPnl - point.shortOptionPnl) < 1e-7);
                    assert.ok(point.shortOptionLiability > 0);
                    assert.ok(Math.abs(point.shortOptionPnl
                        - (100 - point.shortOptionLiability)) < 1e-7);
                });
                assert.ok(protectedSeries.points[0].shortOptionPnl < -500);
                assert.ok(protectedSeries.points[10].shortOptionPnl > 0);
                const shortMarks = page.estimateDeferredShortOptions([
                    { right: 'P', strike: 70, expiry: '20260902', contracts: -1,
                        sharesPerContract: 100, openPremium: 100 },
                    { right: 'P', strike: 65, expiry: '20270115', contracts: 2,
                        sharesPerContract: 100, openPremium: -1000 },
                ], 63, { throughExpiry: '20260831', marketInputs: liveInputs });
                assert.equal(shortMarks.count, 1);
                assert.equal(shortMarks.contracts, 1);
                assert.ok(shortMarks.marketValue < 0);
                assert.ok(Math.abs(shortMarks.liability + shortMarks.marketValue) < 1e-9);
                assert.ok(Math.abs(shortMarks.pnl - (shortMarks.marketValue + 100)) < 1e-9);
                // A deep-ITM European put sits a hair under intrinsic (discounted strike).
                assert.ok(shortMarks.details[0].markPerShare > 6.9);
                // Without a quote for the short, nothing is guessed.
                const noShortQuote = page.buildStressTestSeries(events, {
                    centerPrice: 70, rangePct: 10, pointCount: 11,
                    throughExpiry: '20260831', basisMode: 'net_cash', secType: 'STK',
                    includeDeferredLongOptions: true,
                    longOptionInputs: Object.assign({}, liveInputs, {
                        options: liveInputs.options.slice(0, 2),
                    }),
                });
                assert.equal(noShortQuote.available, false);
                assert.equal(noShortQuote.reason, 'missing_short_option_iv');
                assert.equal(page.estimateDeferredShortOptions([
                    { conId: 5, right: 'P', strike: 70, expiry: '20260902', contracts: -1,
                        sharesPerContract: 100, openPremium: 100 },
                ], 63, { throughExpiry: '20260831', marketInputs: Object.assign({}, liveInputs, {
                    options: [{ conId: 6, right: 'P', strike: 70, expiry: '20260902',
                        impliedVolatility: 0.5 }],
                }) }).reason, 'short_option_identity_mismatch');
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
                assert.ok(html.includes('id="stress-own-note"'));
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
            name: 'the stress test overlays a linked book\'s long options through a mapped price',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const source = readScript();
                // The index drives a daily-rebalanced 3x fund by compounding:
                // a TQQQ -30% is a QQQ -11.2%, not -10%. Linear stays as a
                // reference mode; the sign flips for an inverse fund; nothing
                // ever maps below zero.
                const cube = Math.pow(0.7, 1 / 3);
                assert.ok(Math.abs(page.mapLinkedUnderlyingPrice(500, -30, 3) - 500 * cube) < 1e-9);
                assert.ok(Math.abs(page.mapLinkedUnderlyingPrice(500, -30, -3) - 500 / cube) < 1e-9);
                assert.ok(Math.abs(page.mapLinkedUnderlyingPrice(500, -30, 3, { mapping: 'linear' })
                    - 450) < 1e-9);
                assert.ok(Math.abs(page.mapLinkedUnderlyingPrice(500, -30, -3, { mapping: 'linear' })
                    - 550) < 1e-9);
                assert.equal(page.mapLinkedUnderlyingPrice(500, 0, 3), 500);
                assert.equal(page.mapLinkedUnderlyingPrice(500, -100, 3), 0);
                assert.equal(page.mapLinkedUnderlyingPrice(500, -30, 0), null);
                assert.equal(page.mapLinkedUnderlyingPrice(500, -30, NaN), null);
                assert.equal(page.mapLinkedUnderlyingPrice(500, -30, 0.001), null);
                assert.equal(page.mapLinkedUnderlyingPrice(0, -30, 3), null);
                assert.equal(page.mapLinkedUnderlyingPrice(500, -90, 0.5, { mapping: 'linear' }), 0);
                // Multi-day volatility drag: (ratio² − ratio)/2 · σ² · T of
                // log-return, zero for an instant move or an unlevered fund.
                assert.ok(Math.abs(page.leveragedDragLog(3, 0.2, 20 / 365) - 3 * 0.04 * 20 / 365) < 1e-12);
                assert.ok(Math.abs(page.leveragedDragLog(-3, 0.2, 1) - 6 * 0.04) < 1e-12);
                assert.equal(page.leveragedDragLog(1, 0.2, 1), 0);
                assert.equal(page.leveragedDragLog(3, 0, 1), 0);
                assert.equal(page.leveragedDragLog(3, 0.2, 0), 0);
                const dragged = page.mapLinkedUnderlyingPrice(500, -30, 3, { sigma: 0.2, timeYears: 20 / 365 });
                assert.ok(dragged > 500 * cube);
                assert.ok(Math.abs(dragged - 500 * Math.pow(0.7 * Math.exp(3 * 0.04 * 20 / 365), 1 / 3)) < 1e-9);
                assert.equal(page.normalizeLinkedMapping(''), 'compound');
                assert.equal(page.normalizeLinkedMapping('Linear'), 'linear');
                assert.equal(page.normalizeLinkedMapping('x'), null);
                assert.equal(page.normalizeLinkedSigma(''), null);
                assert.equal(page.normalizeLinkedSigma(0.25), 0.25);
                assert.equal(page.normalizeLinkedSigma(-1), undefined);
                assert.equal(page.normalizeLinkedRatio('3'), 3);
                assert.equal(page.normalizeLinkedRatio(-3), -3);
                assert.equal(page.normalizeLinkedRatio(0.001), null);
                assert.equal(page.LINKED_HEDGE_DEFAULTS.TQQQ.symbol, 'QQQ');
                assert.equal(page.LINKED_HEDGE_DEFAULTS.TQQQ.ratio, 3);

                const events = [{
                    seq: 1, kind: 'opening_balance', tradeDate: '2026-06-01',
                    account: 'U1', shares: 200, price: 73, cashAmount: -14600,
                    fees: 0, includeInCost: true,
                }, {
                    seq: 2, kind: 'option_trade', tradeDate: '2026-08-01',
                    account: 'U1', right: 'P', strike: 72, expiry: '20260831',
                    contracts: -2, sharesPerContract: 100, price: 1,
                    cashAmount: 200, fees: 0, includeInCost: true,
                }];
                const baseOptions = {
                    centerPrice: 70, rangePct: 30, pointCount: 11,
                    throughExpiry: '20260831', basisMode: 'net_cash', secType: 'STK',
                };
                const baseline = page.buildStressTestSeries(events, baseOptions);
                assert.equal(baseline.available, true);
                // Off means off: no linked keys leak into the plain series.
                assert.deepEqual(page.buildStressTestSeries(events,
                    Object.assign({}, baseOptions, { linkedHedge: null })), baseline);
                assert.equal('linkedHedgeEnabled' in baseline, false);
                assert.equal('totalPnl' in baseline.points[0], false);

                const linkedOptions = [
                    { right: 'P', strike: 480, expiry: '20270115', contracts: 10,
                        sharesPerContract: 100, openPremium: -25000 },
                    { right: 'C', strike: 560, expiry: '20270115', contracts: 2,
                        sharesPerContract: 100, openPremium: -3000 },
                    // Expires on the stress date itself: intrinsic, no IV needed.
                    { right: 'P', strike: 470, expiry: '20260831', contracts: 4,
                        sharesPerContract: 100, openPremium: -2000 },
                    // Already expired on the valuation date: protects nothing.
                    { right: 'P', strike: 460, expiry: '20260801', contracts: 7,
                        sharesPerContract: 100, openPremium: -700 },
                ];
                const linkedInputs = {
                    throughExpiry: '20260831',
                    fetchedAt: '2026-08-30T12:00:00Z',
                    curveEffectiveDate: '2026-08-28',
                    underlyingPrice: 500,
                    options: [
                        { right: 'P', strike: 480, expiry: '20270115',
                            impliedVolatility: 0.22, ivSource: 'modelGreeks',
                            mark: 20, markSource: 'mid' },
                        { right: 'C', strike: 560, expiry: '20270115',
                            impliedVolatility: 0.18, ivSource: 'modelGreeks',
                            mark: 8, markSource: 'mid' },
                        { right: 'P', strike: 470, expiry: '20260831',
                            impliedVolatility: null, ivSource: '',
                            mark: 6, markSource: 'mid' },
                    ],
                    ratesByExpiry: [{
                        expiry: '20270115', zeroRate: 0.035,
                        source: 'usd_reference_discount_curve',
                    }],
                };
                const hedge = {
                    symbol: 'QQQ', bookId: 'qqq', openOptions: linkedOptions,
                    ratio: 3, basePrice: 500, marketInputs: linkedInputs,
                    asOf: '20260830',
                };
                const withHedge = (overrides) => page.buildStressTestSeries(events,
                    Object.assign({}, baseOptions, {
                        linkedHedge: Object.assign({}, hedge, overrides || {}),
                    }));
                const linked = withHedge();
                assert.equal(linked.available, true);
                assert.equal(linked.linkedHedgeEnabled, true);
                assert.equal(linked.linkedSymbol, 'QQQ');
                assert.equal(linked.linkedBookId, 'qqq');
                assert.equal(linked.linkedRatio, 3);
                assert.equal(linked.linkedBasePrice, 500);
                assert.equal(linked.linkedCount, 3);
                assert.equal(linked.linkedContracts, 16);
                assert.equal(linked.linkedCallContracts, 2);
                assert.equal(linked.linkedPutContracts, 14);
                assert.equal(linked.linkedSettledContracts, 4);
                assert.equal(linked.linkedDeferredContracts, 12);
                assert.equal(linked.linkedExpiredContracts, 7);
                // Today's value is the TWS mark: 20*10*100 + 8*2*100 + 6*4*100.
                assert.equal(linked.linkedReferenceValue, 24000);
                assert.equal(linked.linkedIvMin, 0.18);
                assert.equal(linked.linkedIvMax, 0.22);
                assert.equal(linked.linkedRateMin, 0.035);
                assert.equal(linked.linkedInputsFetchedAt, '2026-08-30T12:00:00Z');
                const down = linked.points[0];
                const middle = linked.points[5];
                const up = linked.points[10];
                assert.ok(Math.abs(down.price - 49) < 1e-9);
                // Compound mapping, one day of drag at the proxy sigma: the
                // quote nearest the money alive after the date (P480 at spot
                // 500, 4% away), not the lowest IV in the book.
                assert.equal(linked.linkedMapping, 'compound');
                assert.equal(linked.linkedSigmaSource, 'proxy');
                assert.ok(Math.abs(linked.linkedSigma - 0.22) < 1e-12);
                assert.equal(linked.linkedSigmaProxyStrike, 480);
                assert.equal(linked.linkedSigmaProxyExpiry, '20270115');
                assert.ok(Math.abs(linked.linkedSigmaProxyDistancePct - 4) < 1e-9);
                assert.ok(Math.abs(linked.linkedTimeYears - 1 / 365) < 1e-12);
                const oneDayDrag = page.leveragedDragLog(3, 0.22, 1 / 365);
                assert.ok(Math.abs(linked.linkedDragLog - oneDayDrag) < 1e-12);
                assert.ok(Math.abs(down.linkedPrice
                    - 500 * Math.pow(0.7 * Math.exp(oneDayDrag), 1 / 3)) < 1e-9);
                assert.ok(down.linkedChangePct < -11 && down.linkedChangePct > -11.3);
                assert.ok(Math.abs(middle.linkedPrice - 500 * Math.pow(Math.exp(oneDayDrag), 1 / 3)) < 1e-9);
                assert.ok(Math.abs(up.linkedPrice
                    - 500 * Math.pow(1.3 * Math.exp(oneDayDrag), 1 / 3)) < 1e-9);
                const linearSeries = withHedge({ mapping: 'linear' });
                assert.ok(Math.abs(linearSeries.points[0].linkedPrice - 450) < 1e-9);
                assert.equal(linearSeries.linkedMapping, 'linear');
                const assumed = withHedge({ sigma: 0.3 });
                assert.equal(assumed.linkedSigmaSource, 'assumption');
                assert.ok(assumed.points[0].linkedPrice > down.linkedPrice);
                assert.equal(withHedge({ sigma: -1 }).reason, 'invalid_linked_sigma');
                assert.equal(withHedge({ mapping: 'nope' }).reason, 'invalid_linked_mapping');
                // No proxy and a positive horizon: refuse, never "zero drag".
                const settledOnly = [linkedOptions[2]];
                const settledInputs = Object.assign({}, linkedInputs, {
                    options: linkedInputs.options.filter((row) => row.expiry === '20260831'),
                });
                const noSigma = withHedge({ openOptions: settledOnly, marketInputs: settledInputs });
                assert.equal(noSigma.available, false);
                assert.equal(noSigma.reason, 'missing_linked_sigma');
                assert.equal(withHedge({ openOptions: settledOnly, marketInputs: settledInputs,
                    sigma: 0.25 }).available, true);
                assert.equal(withHedge({ openOptions: settledOnly, marketInputs: settledInputs,
                    mapping: 'linear' }).available, true);
                // Same day: no path, no drag, and no sigma required.
                const instantSeries = withHedge({ openOptions: settledOnly,
                    marketInputs: settledInputs, asOf: '20260831' });
                assert.equal(instantSeries.available, true);
                assert.equal(instantSeries.linkedSigmaSource, 'instant');
                assert.equal(instantSeries.linkedDragLog, 0);
                assert.ok(Math.abs(instantSeries.points[0].linkedPrice - 500 * Math.pow(0.7, 1 / 3)) < 1e-9);
                // A proxy far from the money is used but flagged.
                const farInputs = Object.assign({}, linkedInputs, {
                    options: linkedInputs.options.filter((row) => row.strike === 560),
                });
                const far = withHedge({ openOptions: [linkedOptions[1]], marketInputs: farInputs });
                assert.equal(far.available, true);
                assert.equal(far.linkedSigmaSource, 'proxy_far');
                assert.ok(Math.abs(far.linkedSigma - 0.18) < 1e-12);
                assert.ok(down.linkedMarketValue > middle.linkedMarketValue);
                assert.ok(middle.linkedMarketValue > up.linkedMarketValue);
                // Protection is the change against today, so a crash makes
                // the overlay POSITIVE even though every premium was paid.
                assert.ok(down.linkedPnl > 0);
                assert.ok(down.linkedPnl > middle.linkedPnl);
                assert.ok(middle.linkedPnl > up.linkedPnl);
                assert.ok(down.totalPnl > down.pnl);
                assert.ok(Math.abs(down.linkedPnl
                    - (down.linkedMarketValue - down.linkedReferenceValue)) < 1e-7);
                assert.ok(Math.abs(down.linkedPremiumPnl
                    - (down.linkedMarketValue - 30000)) < 1e-7);
                linked.points.forEach((point, index) => {
                    assert.equal(point.linkedAvailable, true);
                    assert.equal(point.linkedReason, '');
                    assert.equal(point.linkedReferenceValue, 24000);
                    assert.ok(Math.abs(point.totalPnl - point.pnl - point.linkedPnl) < 1e-7);
                    // This book's own curve is untouched by the overlay.
                    assert.equal(point.pnl, baseline.points[index].pnl);
                    assert.equal(point.cost, baseline.points[index].cost);
                    assert.equal(point.shares, baseline.points[index].shares);
                });

                const downMarks = page.estimateLinkedLongOptions(linkedOptions, 450, {
                    throughExpiry: '20260831', marketInputs: linkedInputs, asOf: '20260830',
                });
                const upMarks = page.estimateLinkedLongOptions(linkedOptions, 550, {
                    throughExpiry: '20260831', marketInputs: linkedInputs, asOf: '20260830',
                });
                assert.equal(downMarks.count, 3);
                assert.equal(downMarks.expiredContracts, 7);
                const settledDown = downMarks.details.find((detail) => detail.settled);
                assert.equal(settledDown.ivSource, 'intrinsic');
                assert.equal(settledDown.marketValue, 8000);
                assert.equal(settledDown.referenceValue, 2400);
                assert.equal(settledDown.markSource, 'mid');
                assert.equal(settledDown.pnl, 5600);
                assert.equal(settledDown.premiumPnl, 6000);
                // Without a valuation date nothing is treated as expired and
                // an expired contract's missing quote is a named failure.
                assert.equal(page.estimateLinkedLongOptions(linkedOptions, 450, {
                    throughExpiry: '20260831', marketInputs: linkedInputs,
                }).reason, 'missing_linked_mark');
                assert.equal(upMarks.details.find((detail) => detail.settled).marketValue, 0);
                const deferredPut = (marks) => marks.details.find(
                    (detail) => detail.right === 'P' && !detail.settled);
                const deferredCall = (marks) => marks.details.find(
                    (detail) => detail.right === 'C');
                assert.ok(deferredPut(downMarks).markPerShare > deferredPut(upMarks).markPerShare);
                assert.ok(deferredCall(upMarks).markPerShare > deferredCall(downMarks).markPerShare);
                assert.equal(deferredCall(upMarks).impliedVolatility, 0.18);
                assert.ok(Math.abs(downMarks.marketValue - downMarks.details.reduce(
                    (total, detail) => total + detail.marketValue, 0)) < 1e-9);

                // Every failure is named; nothing falls back to a guess.
                const failures = [
                    [{ ratio: 0 }, 'invalid_linked_ratio'],
                    [{ openOptions: null }, 'missing_linked_book'],
                    [{ marketInputs: null }, 'missing_linked_market_inputs'],
                    [{ marketInputs: Object.assign({}, linkedInputs,
                        { throughExpiry: '20260902' }) }, 'missing_linked_market_inputs'],
                    [{ basePrice: 0 }, 'invalid_linked_underlying_price'],
                    [{ marketInputs: Object.assign({}, linkedInputs,
                        { options: linkedInputs.options.slice(1) }) }, 'missing_linked_option_iv'],
                    [{ marketInputs: Object.assign({}, linkedInputs,
                        { ratesByExpiry: [] }) }, 'missing_linked_discount_rate'],
                    [{ marketInputs: Object.assign({}, linkedInputs, {
                        options: linkedInputs.options.map((row, index) => (
                            index === 2 ? Object.assign({}, row, { mark: null }) : row)),
                    }) }, 'missing_linked_mark'],
                    [{ openOptions: [Object.assign({}, linkedOptions[0],
                        { identityConflict: true })] }, 'incomplete_linked_option'],
                    [{ openOptions: [Object.assign({}, linkedOptions[2],
                        { strike: 0 })] }, 'incomplete_linked_option'],
                ];
                failures.forEach(([overrides, reason]) => {
                    const failed = withHedge(overrides);
                    assert.equal(failed.available, false, reason);
                    assert.equal(failed.reason, reason);
                    assert.equal(failed.points[0].linkedAvailable, false);
                    assert.equal(failed.points[0].totalPnl, null);
                });
                // An empty linked book is a valid no-op, and short legs are
                // not protection.
                const empty = withHedge({ openOptions: [] });
                assert.equal(empty.available, true);
                assert.equal(empty.linkedCount, 0);
                assert.equal(empty.points[0].totalPnl, empty.points[0].pnl);
                const shortsOnly = withHedge({
                    openOptions: [Object.assign({}, linkedOptions[0], { contracts: -10 })],
                });
                assert.equal(shortsOnly.available, true);
                assert.equal(shortsOnly.linkedCount, 0);
                // An IV shock lifts only the scenario value of contracts still
                // alive after the stress date; today's marks are untouched.
                assert.equal(page.normalizeIvShockPoints(''), 0);
                assert.equal(page.normalizeIvShockPoints(null), 0);
                assert.equal(page.normalizeIvShockPoints('10'), 10);
                assert.equal(page.normalizeIvShockPoints(-5), -5);
                assert.equal(page.normalizeIvShockPoints('abc'), null);
                assert.equal(page.normalizeIvShockPoints(600), null);
                assert.equal(linked.linkedIvMode, 'none');
                linked.points.forEach((point) => assert.equal(point.linkedIvShockPoints, 0));
                // Points given without the 'fixed' mode are ignored, not applied.
                assert.equal(withHedge({ ivShockPoints: 10 }).linkedIvShockPoints, 0);
                const shocked = withHedge({ ivMode: 'fixed', ivShockPoints: 10 });
                assert.equal(shocked.available, true);
                assert.equal(shocked.linkedIvMode, 'fixed');
                assert.equal(shocked.linkedIvShockPoints, 10);
                assert.ok(Math.abs(shocked.linkedIvMin - 0.28) < 1e-9);
                assert.ok(Math.abs(shocked.linkedIvMax - 0.32) < 1e-9);
                assert.equal(shocked.linkedReferenceValue, 24000);
                shocked.points.forEach((point, index) => {
                    const plain = linked.points[index];
                    assert.equal(point.linkedIvShockPoints, 10);
                    assert.ok(point.linkedMarketValue > plain.linkedMarketValue);
                    assert.ok(point.linkedPnl > plain.linkedPnl);
                    assert.equal(point.linkedReferenceValue, plain.linkedReferenceValue);
                    assert.ok(Math.abs(point.totalPnl - point.pnl - point.linkedPnl) < 1e-7);
                });
                // Spot-vol beta: IV lifts only while the mapped price is
                // below today's, by beta points per 1% of drop.
                assert.equal(page.linkedIvShockPointsAt('beta', -10, 0, 1.5), 15);
                assert.equal(page.linkedIvShockPointsAt('beta', 0, 0, 1.5), 0);
                assert.equal(page.linkedIvShockPointsAt('beta', 8, 0, 1.5), 0);
                assert.equal(page.linkedIvShockPointsAt('fixed', -10, 7, 1.5), 7);
                assert.equal(page.linkedIvShockPointsAt('none', -10, 7, 1.5), 0);
                assert.equal(page.normalizeLinkedIvMode(''), 'none');
                assert.equal(page.normalizeLinkedIvMode('BETA'), 'beta');
                assert.equal(page.normalizeLinkedIvMode('wild'), null);
                assert.equal(page.normalizeLinkedIvBeta(''), 1.5);
                assert.equal(page.normalizeLinkedIvBeta('2'), 2);
                assert.equal(page.normalizeLinkedIvBeta(-1), null);
                assert.equal(page.normalizeLinkedIvBeta(50), null);
                const betaSeries = withHedge({ ivMode: 'beta', ivBeta: 2 });
                assert.equal(betaSeries.available, true);
                assert.equal(betaSeries.linkedIvMode, 'beta');
                assert.equal(betaSeries.linkedIvBeta, 2);
                // Quoted IV range is the basis point's: unshocked.
                assert.ok(Math.abs(betaSeries.linkedIvMin - 0.18) < 1e-9);
                assert.ok(Math.abs(betaSeries.linkedIvMax - 0.22) < 1e-9);
                betaSeries.points.forEach((point, index) => {
                    const plain = linked.points[index];
                    const expectedShock = Math.max(0, -point.linkedChangePct) * 2;
                    assert.ok(Math.abs(point.linkedIvShockPoints - expectedShock) < 1e-9);
                    if (point.linkedChangePct < -1e-9) {
                        assert.ok(point.linkedPnl > plain.linkedPnl);
                        assert.ok(point.linkedIvMin > plain.linkedIvMin);
                    } else {
                        // Basis point and rallies: byte-for-byte the unshocked value.
                        assert.equal(point.linkedPnl, plain.linkedPnl);
                        assert.equal(point.linkedIvMin, plain.linkedIvMin);
                    }
                });
                // -30% on the fund is -11.2% on the index under compounding: 2 pts per 1%.
                assert.ok(betaSeries.points[0].linkedIvShockPoints > 22
                    && betaSeries.points[0].linkedIvShockPoints < 22.6);
                // One scenario date for everything: the linked estimator has
                // no private valuation date, and the series passes the same
                // throughExpiry to the settlement, this book's overlay and ③.
                assert.equal(page.normalizeStressHorizonDays(''), null);
                assert.equal(page.normalizeStressHorizonDays(0), 0);
                assert.equal(page.normalizeStressHorizonDays('20'), 20);
                assert.equal(page.normalizeStressHorizonDays(2.5), undefined);
                assert.equal(page.normalizeStressHorizonDays(-1), undefined);
                assert.equal(page.addDaysToDigits('20260830', 20), '20260919');
                assert.equal(page.addDaysToDigits('20261231', 1), '20270101');
                assert.equal(page.addDaysToDigits('bad', 1), '');
                assert.equal(withHedge({ horizonDays: 60, valuationDate: '20261029' })
                    .points[5].linkedPnl, middle.linkedPnl);
                assert.doesNotMatch(source, /valuationDate/);
                // Currency: two books add up only in one currency.
                assert.equal(withHedge({ currency: 'USD' }).available, true);
                const foreign = page.buildStressTestSeries(events, Object.assign({}, baseOptions, {
                    currency: 'USD',
                    linkedHedge: Object.assign({}, hedge, { currency: 'HKD' }),
                }));
                assert.equal(foreign.available, false);
                assert.equal(foreign.reason, 'linked_currency_mismatch');
                assert.equal(page.buildStressTestSeries(events, Object.assign({}, baseOptions, {
                    currency: 'usd', linkedHedge: Object.assign({}, hedge, { currency: 'USD ' }),
                })).available, true);
                // Identity: a ledger conId is matched by conId only; a quote
                // that merely looks the same is a named conflict.
                const byConId = [{ conId: 111, right: 'P', strike: 480, expiry: '20270115',
                    contracts: 10, sharesPerContract: 100, openPremium: -1 }];
                const sameTermsOtherConId = [{ conId: 222, right: 'P', strike: 480,
                    expiry: '20270115', impliedVolatility: 0.2, mark: 5, multiplier: 100 }];
                assert.equal(page.findOptionQuote(sameTermsOtherConId, byConId[0]), null);
                assert.equal(page.optionQuoteIdentityConflict(sameTermsOtherConId, byConId[0]), true);
                assert.equal(page.findOptionQuote([{ conId: 111, right: 'C', strike: 1,
                    expiry: '20300101', mark: 9 }], byConId[0]).mark, 9);
                assert.equal(page.findOptionQuote([{ conId: 111, mark: 9 }],
                    { conId: 111, localSymbol: 'X', right: 'P', strike: 480, expiry: '20270115' }).mark, 9);
                // localSymbol only: matched by localSymbol only.
                const byLocal = { localSymbol: 'QQQ   270115P00480000', right: 'P', strike: 480,
                    expiry: '20270115', sharesPerContract: 100 };
                assert.equal(page.findOptionQuote(sameTermsOtherConId, byLocal), null);
                assert.equal(page.optionQuoteIdentityConflict(sameTermsOtherConId, byLocal), true);
                assert.equal(page.findOptionQuote([{ localSymbol: 'QQQ   270115P00480000 ',
                    mark: 7 }], byLocal).mark, 7);
                // No identity at all: terms, and the multiplier must agree
                // when both sides know it.
                const bare = { right: 'P', strike: 480, expiry: '20270115', sharesPerContract: 100 };
                assert.equal(page.findOptionQuote(sameTermsOtherConId, bare).mark, 5);
                assert.equal(page.findOptionQuote([Object.assign({}, sameTermsOtherConId[0],
                    { multiplier: 10 })], bare), null);
                assert.equal(page.optionQuoteIdentityConflict(sameTermsOtherConId, bare), false);
                assert.equal(page.estimateDeferredLongOptions(byConId, 450, {
                    throughExpiry: '20260831',
                    marketInputs: Object.assign({}, linkedInputs, { options: sameTermsOtherConId }),
                }).reason, 'long_option_identity_mismatch');
                const conflictLinked = withHedge({
                    openOptions: [Object.assign({}, linkedOptions[0], { conId: 111 })],
                    marketInputs: Object.assign({}, linkedInputs, {
                        options: linkedInputs.options.map((row, index) => (
                            index === 0 ? Object.assign({}, row, { conId: 222 }) : row)),
                    }),
                });
                assert.equal(conflictLinked.available, false);
                assert.equal(conflictLinked.reason, 'linked_option_identity_mismatch');
                // Missing entirely (no lookalike) stays the plain missing reason.
                assert.equal(withHedge({
                    openOptions: [Object.assign({}, linkedOptions[0], { conId: 111 })],
                    marketInputs: Object.assign({}, linkedInputs, { options: [] }),
                }).reason, 'missing_linked_option_iv');
                                // Tenor damping: a beta describes short-dated IV, so a long
                // contract's lift shrinks by sqrt(reference / remaining days).
                assert.equal(page.tenorDampingFactor(30, 30), 1);
                assert.equal(page.tenorDampingFactor(10, 30), 1);
                assert.ok(Math.abs(page.tenorDampingFactor(120, 30) - 0.5) < 1e-9);
                assert.equal(page.tenorDampingFactor(0, 30), 1);
                assert.equal(page.normalizeLinkedTenorDays(''), 30);
                assert.equal(page.normalizeLinkedTenorDays('60'), 60);
                assert.equal(page.normalizeLinkedTenorDays(0), null);
                const damped = withHedge({ ivMode: 'beta', ivBeta: 2, ivTenorDamping: true,
                    ivTenorDays: 30 });
                assert.equal(damped.available, true);
                assert.equal(damped.linkedIvTenorDamping, true);
                assert.equal(damped.linkedIvTenorDays, 30);
                const dampedDown = damped.points[0];
                const flatDown = betaSeries.points[0];
                // 2027-01-15 is 137 days past the stress date: factor sqrt(30/137).
                const factor = Math.sqrt(30 / 137);
                assert.ok(Math.abs(dampedDown.linkedIvShockPointsMax - flatDown.linkedIvShockPoints * factor) < 1e-9);
                assert.ok(Math.abs(dampedDown.linkedIvShockPointsMin - flatDown.linkedIvShockPoints * factor) < 1e-9);
                assert.ok(dampedDown.linkedPnl < flatDown.linkedPnl);
                assert.ok(dampedDown.linkedPnl > linked.points[0].linkedPnl);
                assert.equal(damped.points[5].linkedPnl, linked.points[5].linkedPnl);
                // Damping is a beta-mode option only; fixed points stay flat.
                assert.equal(withHedge({ ivMode: 'fixed', ivShockPoints: 10, ivTenorDamping: true })
                    .linkedIvTenorDamping, false);
                assert.equal(withHedge({ ivMode: 'beta', ivTenorDamping: true, ivTenorDays: 0 })
                    .reason, 'invalid_linked_tenor_days');
                assert.equal(withHedge({ ivMode: 'beta', ivBeta: 'x' }).reason,
                    'invalid_linked_iv_beta');
                assert.equal(withHedge({ ivMode: 'beta', ivBeta: 99 }).reason,
                    'invalid_linked_iv_beta');
                assert.equal(withHedge({ ivMode: 'nope' }).reason, 'invalid_linked_iv_mode');
                // The settled contract is intrinsic either way.
                const shockedMarks = page.estimateLinkedLongOptions(linkedOptions, 450, {
                    throughExpiry: '20260831', marketInputs: linkedInputs, asOf: '20260830',
                    ivShock: 0.10,
                });
                assert.equal(shockedMarks.details.find((detail) => detail.settled).marketValue, 8000);
                assert.ok(Math.abs(deferredPut(shockedMarks).impliedVolatility - 0.32) < 1e-9);
                assert.equal(withHedge({ ivMode: 'fixed', ivShockPoints: 0 }).linkedIvShockPoints, 0);
                assert.equal(withHedge({ ivMode: 'fixed', ivShockPoints: 'x' }).reason,
                    'invalid_linked_iv_shock');
                assert.equal(withHedge({ ivMode: 'fixed', ivShockPoints: -30 }).reason,
                    'invalid_linked_iv_shock');
                assert.equal(withHedge({ ivMode: 'fixed', ivShockPoints: -10 }).available, true);
                assert.match(source, /function mapLinkedUnderlyingPrice/);
                assert.match(source, /function estimateLinkedLongOptions/);
                assert.match(source, /function _findOptionQuote/);
                assert.match(source, /premium already paid is sunk/);
                assert.match(source, /TQQQ-first/);
            },
        },
        {
            name: 'scenario options price American with dividends and can be marked at the bid or ask',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const html = readPage();
                const source = readScript();
                // Dividend yield lowers a call and raises a put in the closed form.
                const callNoDiv = page.calculateBsmOptionPrice('C', 100, 100, 1, 0.05, 0.2);
                const callDiv = page.calculateBsmOptionPrice('C', 100, 100, 1, 0.05, 0.2, 0.03);
                const putNoDiv = page.calculateBsmPutPrice(100, 100, 1, 0.05, 0.2);
                const putDiv = page.calculateBsmOptionPrice('P', 100, 100, 1, 0.05, 0.2, 0.03);
                assert.ok(Math.abs(callNoDiv - 10.4506) < 0.001);
                assert.ok(callDiv < callNoDiv);
                assert.ok(putDiv > putNoDiv);
                // American ≥ European; a deep-ITM put with a positive rate
                // carries early-exercise value; at expiry both are intrinsic.
                const euro = (right, s) => page.priceScenarioOption(right, s, 100, 1, 0.05, 0.2,
                    { pricingModel: 'european' });
                const amer = (right, s) => page.priceScenarioOption(right, s, 100, 1, 0.05, 0.2,
                    { pricingModel: 'american' });
                assert.ok(amer('P', 100) >= euro('P', 100) - 1e-9);
                assert.ok(amer('P', 60) > euro('P', 60) + 0.5);
                assert.ok(amer('P', 60) >= 40);
                // No dividend: an American call is a European call, up to
                // the lattice's discretisation error.
                assert.ok(Math.abs(amer('C', 100) - euro('C', 100)) < 0.1);
                assert.equal(page.priceScenarioOption('P', 60, 100, 0, 0.05, 0.2,
                    { pricingModel: 'american' }), 40);
                // With a dividend the American call may be exercised early: it
                // is worth at least the dividend-adjusted European call and
                // less than the no-dividend call.
                const amerDivCall = page.priceScenarioOption('C', 100, 100, 1, 0.05, 0.2,
                    { pricingModel: 'american', dividendYield: 0.05 });
                const euroDivCall = page.priceScenarioOption('C', 100, 100, 1, 0.05, 0.2,
                    { pricingModel: 'european', dividendYield: 0.05 });
                assert.ok(amerDivCall >= euroDivCall - 0.1);
                assert.ok(amerDivCall < callNoDiv);
                assert.equal(page.priceScenarioOption('X', 100, 100, 1, 0.05, 0.2,
                    { pricingModel: 'american' }), null);
                assert.equal(page.normalizePricingModel(''), 'european');
                assert.equal(page.normalizePricingModel('American'), 'american');
                assert.equal(page.normalizePricingModel('x'), null);
                assert.equal(page.normalizeLiquidation(''), 'mid');
                assert.equal(page.normalizeLiquidation('bidask'), 'bidask');
                assert.equal(page.normalizeLiquidation('x'), null);
                assert.equal(page.normalizeDividendYield(''), 0);
                assert.equal(page.normalizeDividendYield(0.006), 0.006);
                assert.equal(page.normalizeDividendYield(-0.1), null);
                assert.equal(page.normalizeDividendYield(0.9), null);
                assert.equal(page.DIVIDEND_YIELD_DEFAULTS.QQQ, 0.006);
                // Liquidation haircut: a long sells at the bid, a short buys
                // back at the ask; a missing side is a refusal, not 1.
                const quote = { mark: 10, bid: 9, ask: 11.5 };
                assert.equal(page.liquidationHaircut(quote, 'long', 'mid'), 1);
                assert.ok(Math.abs(page.liquidationHaircut(quote, 'long', 'bidask') - 0.9) < 1e-12);
                assert.ok(Math.abs(page.liquidationHaircut(quote, 'short', 'bidask') - 1.15) < 1e-12);
                assert.equal(page.liquidationHaircut({ mark: 10, bid: null, ask: 11 }, 'long', 'bidask'), null);
                assert.equal(page.liquidationHaircut({ mark: 10, bid: 9 }, 'short', 'bidask'), null);
                assert.equal(page.liquidationHaircut({ mark: 0, bid: 0, ask: 0.05 }, 'long', 'bidask'), null);
                assert.equal(page.liquidationHaircut({ mark: 10, bid: 0, ask: 11 }, 'long', 'bidask'), 0);
                // A crossed pair is not a price: it would flatter both sides.
                const crossed = { mark: 1.08, bid: 1.20, ask: 1.00 };
                assert.equal(page.bidAskProblem(crossed), 'crossed');
                assert.equal(page.liquidationHaircut(crossed, 'long', 'bidask'), null);
                assert.equal(page.liquidationHaircut(crossed, 'short', 'bidask'), null);
                assert.equal(page.bidAskProblem({ mark: 1, bid: 0.9, ask: 1.1, bidAskValid: false }), 'crossed');
                assert.equal(page.liquidationHaircut({ mark: 1, bid: 0.9, ask: 1.1, bidAskValid: false },
                    'long', 'bidask'), null);
                assert.equal(page.bidAskProblem({ mark: 1, bid: 0.9, ask: 1.1 }), '');
                assert.equal(page.bidAskProblem({ mark: 1, bid: 0.9 }), 'missing');
                assert.equal(page.bidAskProblem({ mark: 1, ask: 1.1 }), 'missing');
                assert.equal(page.bidAskProblem({ mark: 1, bid: 0, ask: 0.05 }), '');
                assert.equal(page.bidAskProblem(null), 'missing');
                assert.equal(page.marketDataTypeLabel([{ marketDataType: 1 }, { marketDataType: 1 }]), '实时');
                assert.equal(page.marketDataTypeLabel([{ marketDataType: 3 }]), '延时');
                assert.equal(page.marketDataTypeLabel([{ marketDataType: 1 }, { marketDataType: 2 }]), '混合：实时/冻结');
                assert.equal(page.marketDataTypeLabel([]), '');

                // The series: American by request, dividends per book, and
                // bid/ask haircuts flowing through ②, ③ and the linked ④.
                const events = [{
                    seq: 1, kind: 'opening_balance', tradeDate: '2026-06-01',
                    account: 'U1', shares: 200, price: 73, cashAmount: -14600,
                    fees: 0, includeInCost: true,
                }, {
                    seq: 2, kind: 'option_trade', tradeDate: '2026-08-01',
                    account: 'U1', right: 'P', strike: 65, expiry: '20270115',
                    contracts: 2, sharesPerContract: 100, price: 5,
                    cashAmount: -1000, fees: 0, includeInCost: true,
                }, {
                    seq: 3, kind: 'option_trade', tradeDate: '2026-08-01',
                    account: 'U1', right: 'C', strike: 80, expiry: '20270115',
                    contracts: -1, sharesPerContract: 100, price: 2,
                    cashAmount: 200, fees: 0, includeInCost: true,
                }];
                const inputs = {
                    throughExpiry: '20260904', fetchedAt: 'x', curveEffectiveDate: '2026-09-03',
                    options: [
                        { right: 'P', strike: 65, expiry: '20270115', impliedVolatility: 0.6,
                            mark: 4, bid: 3.6, ask: 4.4 },
                        { right: 'C', strike: 80, expiry: '20270115', impliedVolatility: 0.6,
                            mark: 3, bid: 2.7, ask: 3.6 },
                    ],
                    ratesByExpiry: [{ expiry: '20270115', zeroRate: 0.04 }],
                };
                const run = (extra) => page.buildStressTestSeries(events, Object.assign({
                    centerPrice: 70, rangePct: 30, pointCount: 11, throughExpiry: '20260904',
                    basisMode: 'net_cash', secType: 'STK', includeDeferredLongOptions: true,
                    longOptionInputs: inputs,
                }, extra || {}));
                const european = run({ pricingModel: 'european' });
                const american = run({ pricingModel: 'american' });
                const defaults = run();
                assert.equal(defaults.pricingModel, 'european');
                assert.equal(defaults.liquidation, 'mid');
                assert.equal(defaults.dividendYield, 0);
                assert.equal(european.available, true);
                assert.equal(american.available, true);
                assert.equal(american.pricingModel, 'american');
                // The long put is worth at least as much American; the short
                // call liability too, so ③ is no better than European.
                assert.ok(american.points[0].longOptionPnl >= european.points[0].longOptionPnl - 1e-9);
                assert.ok(american.points[0].longOptionPnl > european.points[0].longOptionPnl);
                assert.ok(american.points[10].shortOptionPnl <= european.points[10].shortOptionPnl + 10);
                const withYield = run({ pricingModel: 'american', dividendYield: 0.02 });
                assert.equal(withYield.dividendYield, 0.02);
                assert.ok(withYield.points[5].longOptionPnl > american.points[5].longOptionPnl);
                assert.ok(withYield.points[10].shortOptionPnl > american.points[10].shortOptionPnl);
                assert.equal(run({ dividendYield: 2 }).reason, 'invalid_dividend_yield');
                assert.equal(run({ pricingModel: 'x' }).reason, 'invalid_pricing_model');
                assert.equal(run({ liquidation: 'x' }).reason, 'invalid_liquidation');
                // Bid/ask: the long is haircut to 90%, the short liability
                // scaled to 120%; both move ② and ③ against the holder.
                const bidAsk = run({ liquidation: 'bidask' });
                assert.equal(bidAsk.available, true);
                assert.equal(bidAsk.liquidation, 'bidask');
                bidAsk.points.forEach((point, index) => {
                    const mid = defaults.points[index];
                    assert.ok(Math.abs(point.longOptionMarketValue
                        - mid.longOptionMarketValue * 0.9) < 1e-6);
                    assert.ok(Math.abs(point.shortOptionLiability
                        - mid.shortOptionLiability * 1.2) < 1e-6);
                    assert.ok(point.longOptionPnl < mid.longOptionPnl);
                    assert.ok(point.shortOptionPnl < mid.shortOptionPnl);
                });
                const noSides = run({ liquidation: 'bidask', longOptionInputs: Object.assign({}, inputs, {
                    options: inputs.options.map((row) => Object.assign({}, row, { bid: null })),
                }) });
                assert.equal(noSides.available, false);
                assert.equal(noSides.reason, 'missing_long_option_quote_sides');
                const crossedOwn = run({ liquidation: 'bidask', longOptionInputs: Object.assign({}, inputs, {
                    options: inputs.options.map((row) => Object.assign({}, row, { bid: row.ask + 0.5 })),
                }) });
                assert.equal(crossedOwn.available, false);
                assert.equal(crossedOwn.reason, 'invalid_long_option_bid_ask');
                const noAsk = run({ liquidation: 'bidask', longOptionInputs: Object.assign({}, inputs, {
                    options: inputs.options.map((row) => (row.right === 'C'
                        ? Object.assign({}, row, { ask: undefined }) : row)),
                }) });
                assert.equal(noAsk.reason, 'missing_short_option_quote_sides');
                // Linked book under bid/ask: today's value is the bid, the
                // scenario mark scaled by bid/mark, intrinsic untouched.
                const linkedOptions = [
                    { right: 'P', strike: 480, expiry: '20270115', contracts: 10,
                        sharesPerContract: 100, openPremium: -25000 },
                    { right: 'P', strike: 470, expiry: '20260904', contracts: 4,
                        sharesPerContract: 100, openPremium: -2000 },
                ];
                const linkedInputs = {
                    throughExpiry: '20260904', fetchedAt: 'y', curveEffectiveDate: '2026-09-03',
                    underlyingPrice: 500,
                    options: [
                        { right: 'P', strike: 480, expiry: '20270115', impliedVolatility: 0.22,
                            mark: 20, bid: 18, ask: 22 },
                        { right: 'P', strike: 470, expiry: '20260904', impliedVolatility: null,
                            mark: 6, bid: 5, ask: 7 },
                    ],
                    ratesByExpiry: [{ expiry: '20270115', zeroRate: 0.035 }],
                };
                const linkedMid = page.estimateLinkedLongOptions(linkedOptions, 450, {
                    throughExpiry: '20260904', marketInputs: linkedInputs, asOf: '20260903',
                });
                const linkedBid = page.estimateLinkedLongOptions(linkedOptions, 450, {
                    throughExpiry: '20260904', marketInputs: linkedInputs, asOf: '20260903',
                    liquidation: 'bidask',
                });
                assert.equal(linkedMid.referenceValue, 20 * 1000 + 6 * 400);
                assert.equal(linkedBid.referenceValue, 18 * 1000 + 5 * 400);
                const deferredMid = linkedMid.details.find((d) => !d.settled);
                const deferredBid = linkedBid.details.find((d) => !d.settled);
                assert.ok(Math.abs(deferredBid.markPerShare - deferredMid.markPerShare * 0.9) < 1e-9);
                assert.equal(linkedBid.details.find((d) => d.settled).marketValue, 8000);
                assert.equal(page.estimateLinkedLongOptions(linkedOptions, 450, {
                    throughExpiry: '20260904', asOf: '20260903', liquidation: 'bidask',
                    marketInputs: Object.assign({}, linkedInputs, {
                        options: linkedInputs.options.map((row) => Object.assign({}, row, { bid: null })),
                    }),
                }).reason, 'missing_linked_quote_sides');
                // American pricing reaches the linked book with its own yield.
                const linkedAmerican = page.estimateLinkedLongOptions(linkedOptions, 450, {
                    throughExpiry: '20260904', marketInputs: linkedInputs, asOf: '20260903',
                    pricingModel: 'american', dividendYield: 0.006,
                });
                assert.ok(linkedAmerican.details.find((d) => !d.settled).markPerShare
                    > deferredMid.markPerShare);
                assert.equal(linkedAmerican.details.find((d) => !d.settled).pricingModel, 'american');
                // This book's IV shock follows the linked beta, |ratio|-scaled,
                // and with tenor damping a 2027 put gets far less than the
                // headline: the per-side applied range is what the point carries.
                const shockedOwn = run({
                    pricingModel: 'european', linkedHedge: {
                        symbol: 'QQQ', bookId: 'qqq', ratio: 3, basePrice: 500,
                        openOptions: linkedOptions, marketInputs: linkedInputs, asOf: '20260903',
                        ivMode: 'beta', ivBeta: 2, ivTenorDamping: true, ivTenorDays: 30,
                    },
                });
                assert.equal(shockedOwn.available, true);
                const downOwn = shockedOwn.points[0];
                assert.ok(downOwn.ownIvShockPoints > 0);
                assert.ok(Math.abs(downOwn.ownIvShockPoints - 3 * downOwn.linkedIvShockPoints) < 1e-9);
                assert.ok(downOwn.longOptionIvShockMax > 0);
                assert.ok(downOwn.longOptionIvShockMax < downOwn.ownIvShockPoints);
                assert.ok(Math.abs(downOwn.longOptionIvShockMax
                    - downOwn.ownIvShockPoints * Math.sqrt(30 / 133)) < 1e-9);
                assert.ok(Math.abs(downOwn.shortOptionIvShockMax - downOwn.longOptionIvShockMax) < 1e-9);
                assert.ok(downOwn.longOptionPnl > european.points[0].longOptionPnl);
                assert.equal(shockedOwn.points[5].ownIvShockPoints, 0);
                assert.equal(shockedOwn.points[5].longOptionIvShockMax, 0);
                assert.ok(html.includes('id="stress-pricing-model"'));
                assert.ok(html.includes('id="stress-dividend-yield"'));
                assert.ok(html.includes('id="stress-own-note"'));
                assert.equal(html.includes('股息率 0% · 不考虑提前行权'), false);
                assert.equal(html.includes('按 BSM 与其自身'), false);
                assert.match(html, /按今日点差折算（买价\/卖价）/);
                assert.match(html, /没有可用代理时整体停止/);
                assert.ok(html.includes('id="stress-liquidation"'));
                assert.ok(html.includes('id="stress-linked-dividend-yield"'));
                assert.match(html, /js\/american_binomial\.js\?v=/);
                assert.match(html, /<option value="american" selected>/);
                assert.match(source, /function priceScenarioOption/);
                assert.match(source, /function liquidationHaircut/);
                assert.match(source, /never claims a model that was not used/);
            },
        },
        {
            name: 'a late main-book snapshot never lands on a newer scenario or another book',
            async run() {
                const h = loadPriceHarness();
                const source = readScript();
                const page = h.context.OptionComboCostBasisPage;
                assert.equal(page.bookScopedStateReset('x').stressInputsPending, false);
                assert.match(source, /STRESS_HORIZON_DEBOUNCE_MS/);
                assert.match(source, /clearTimeout\(state\.stressHorizonTimer\)/);
                h.state.status = { features: { optionScenarioInputs: true } };
                h.state.stressOpen = false;
                h.state.stressExpiry = '20260904';
                h.state.stressIncludeLongOptions = true;
                h.state.stressBasePrice = 70;
                const inflight = [];
                h.configure({
                    today: () => '2026-09-03',
                    request: (action, fields) => new Promise((resolve, reject) => {
                        inflight.push({ action, fields, resolve, reject });
                    }),
                });
                // Typing "2" then "20": the first request must be superseded,
                // not allowed to block the second or to write back later.
                h.state.stressHorizonDays = 2;
                const first = h.refreshStressInputs(false);
                h.state.stressHorizonDays = 20;
                h.invalidateScenario();
                const second = h.refreshStressInputs(false);
                assert.equal(inflight.length, 2);
                assert.equal(inflight[0].fields.throughExpiry, '20260905');
                assert.equal(inflight[1].fields.throughExpiry, '20260923');
                assert.equal(h.state.stressInputsPending, true);
                inflight[0].resolve({ underlyingPrice: 65, throughExpiry: '20260905',
                    fetchedAt: 'old', options: [], ratesByExpiry: [] });
                await first;
                assert.equal(h.state.stressLongOptionInputs, null);
                assert.equal(h.state.marketPrice, null);
                assert.equal(h.state.stressBasePrice, 70);
                assert.equal(h.state.stressInputsPending, true);
                inflight[1].resolve({ underlyingPrice: 72, throughExpiry: '20260923',
                    fetchedAt: 'new', options: [], ratesByExpiry: [] });
                await second;
                assert.equal(h.state.stressLongOptionInputs.throughExpiry, '20260923');
                assert.equal(h.state.marketPrice, 72);
                assert.equal(h.state.stressBasePrice, 72);
                assert.equal(h.state.stressInputsPending, false);
                // A late failure of a superseded request is equally silent.
                h.state.stressHorizonDays = 3;
                h.invalidateScenario();
                const third = h.refreshStressInputs(false);
                h.state.stressHorizonDays = 30;
                h.invalidateScenario();
                const fourth = h.refreshStressInputs(false);
                inflight[2].reject(Object.assign(new Error('boom'), { code: 'x' }));
                await third;
                assert.equal(h.state.stressInputsError, '');
                assert.equal(h.state.stressInputsPending, true);
                inflight[3].resolve({ underlyingPrice: 71, throughExpiry: '20261003',
                    fetchedAt: 'n', options: [], ratesByExpiry: [] });
                await fourth;
                assert.equal(h.state.marketPrice, 71);

                // A book switch while a request is out: the response for the
                // old book cannot touch the new one, and pending is not stuck.
                h.state.books.push({ bookId: 'book-b', account: 'U1', symbol: 'TSM',
                    secType: 'STK' });
                h.state.stressHorizonDays = null;
                h.invalidateScenario();
                const stale = h.refreshStressInputs(false);
                assert.equal(inflight[4].fields.bookId, 'book-test');
                assert.equal(h.state.stressInputsPending, true);
                h.selectPriceBook('book-b');
                assert.equal(h.state.stressInputsPending, false);
                assert.equal(h.state.marketPrice, null);
                inflight[4].resolve({ underlyingPrice: 99, throughExpiry: '20260904',
                    fetchedAt: 'stale', options: [], ratesByExpiry: [] });
                await stale;
                assert.equal(h.state.bookId, 'book-b');
                assert.equal(h.state.stressLongOptionInputs, null);
                assert.equal(h.state.marketPrice, null);
                // The modal's base price is reset on the next open, not here;
                // what matters is that the stale 99 never landed.
                assert.equal(h.state.stressBasePrice, 71);
                assert.equal(h.state.stressInputsPending, false);
            },
        },
        {
            name: 'a linked book is chosen from memory, then the TQQQ seed, and never switched on by itself',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const tqqq = { bookId: 'b-tqqq', account: 'U1', symbol: 'TQQQ', secType: 'STK' };
                const candidates = [
                    { bookId: 'b-qqq', account: 'U1', symbol: 'QQQ', secType: 'STK' },
                    { bookId: 'b-tsm', account: 'U1', symbol: 'TSM', secType: 'STK' },
                ];
                const seeded = page.chooseLinkedBook(tqqq, candidates, null);
                assert.equal(seeded.bookId, 'b-qqq');
                assert.equal(seeded.ratio, 3);
                assert.equal(seeded.enabled, false);
                const remembered = page.chooseLinkedBook(tqqq, candidates, {
                    linkedBookId: 'b-tsm', ratio: 1.5, enabled: true,
                    ivMode: 'beta', ivShockPoints: 15, ivBeta: 2.5,
                    horizonDays: 20, ivTenorDamping: false, ivTenorDays: 45,
                });
                // A horizon is never remembered: it is a scenario, not a setting.
                assert.equal('horizonDays' in remembered, false);
                assert.equal(remembered.ivTenorDamping, false);
                assert.equal(remembered.ivTenorDays, 45);
                assert.equal(seeded.ivTenorDamping, true);
                assert.equal(seeded.ivTenorDays, 30);
                assert.equal(remembered.bookId, 'b-tsm');
                assert.equal(remembered.ratio, 1.5);
                assert.equal(remembered.ivMode, 'beta');
                assert.equal(remembered.ivShockPoints, 15);
                assert.equal(remembered.ivBeta, 2.5);
                // A remembered "on" never survives: the purple curve is opt-in
                // every time the modal opens.
                assert.equal(remembered.enabled, false);
                assert.equal(seeded.ivMode, 'none');
                assert.equal(seeded.ivShockPoints, 0);
                assert.equal(seeded.ivBeta, 1.5);
                assert.equal(page.chooseLinkedBook(tqqq, candidates,
                    { linkedBookId: 'b-qqq', ivMode: 'wild', ivBeta: -3 }).ivMode, 'none');
                assert.equal(page.chooseLinkedBook(tqqq, candidates,
                    { linkedBookId: 'b-qqq', ivMode: 'wild', ivBeta: -3 }).ivBeta, 1.5);
                assert.equal(page.chooseLinkedBook(tqqq, candidates,
                    { linkedBookId: 'b-qqq', ratio: 3, ivShockPoints: 'bad' }).ivShockPoints, 0);
                // A remembered book that no longer exists falls back to the seed.
                const stale = page.chooseLinkedBook(tqqq, candidates,
                    { linkedBookId: 'b-gone', ratio: 2, enabled: true });
                assert.equal(stale.bookId, 'b-qqq');
                assert.equal(stale.enabled, false);
                assert.equal(stale.ivMode, 'none');
                // A remembered but unusable ratio falls back to the default one.
                assert.equal(page.chooseLinkedBook(tqqq, candidates,
                    { linkedBookId: 'b-qqq', ratio: 0, enabled: true }).ratio, 3);
                // No seed for other symbols: nothing is preselected.
                const tsm = page.chooseLinkedBook(
                    { bookId: 'b-tsm', symbol: 'TSM' }, candidates, null);
                assert.equal(tsm.bookId, '');
                assert.equal(tsm.ratio, 3);
                assert.equal(tsm.enabled, false);
                assert.equal(page.chooseLinkedBook(tqqq, [], null).bookId, '');
                // Switching books clears every linked field.
                const reset = page.bookScopedStateReset('b-tsm');
                assert.equal(reset.stressIncludeLinkedHedge, false);
                assert.equal(reset.stressLinkedBookId, '');
                assert.equal(reset.stressLinkedRatio, 3);
                assert.equal(reset.stressLinkedIvShockPoints, 0);
                assert.equal(reset.stressLinkedIvMode, 'none');
                assert.equal(reset.stressLinkedIvBeta, 1.5);
                assert.equal(reset.stressHorizonDays, null);
                assert.equal(reset.stressLiquidation, 'mid');
                assert.equal(reset.stressDividendYield, null);
                assert.equal(reset.stressLinkedDividendYield, null);
                assert.equal(reset.stressLinkedIvTenorDamping, true);
                assert.equal(reset.stressLinkedIvTenorDays, 30);
                assert.equal(reset.stressLinkedLedger, null);
                assert.equal(reset.stressLinkedInputs, null);
                assert.equal(reset.stressLinkedEvents.length, 0);
            },
        },
        {
            name: 'the stress modal reads a linked book on the side and never touches the current ledger',
            async run() {
                const h = loadPriceHarness();
                const html = readPage();
                const source = readScript();
                const core = h.context.OptionComboCostBasisCore;
                // Every outbound action this page can send must already be on
                // the whitelist; the linked overlay adds no new message type.
                const actions = Array.from(source.matchAll(/request\('([a-z_]+)'/g))
                    .map((match) => match[1]);
                assert.ok(actions.includes('list_cost_basis_events'));
                actions.forEach((action) => assert.ok(
                    core.ALLOWED_CLIENT_ACTIONS.includes(action), action));

                h.state.books.push(
                    { bookId: 'book-qqq', account: 'U1', symbol: 'QQQ', secType: 'STK' },
                    { bookId: 'book-other', account: 'U2', symbol: 'QQQ', secType: 'STK' },
                    { bookId: 'book-hkd', account: 'U1', symbol: '2800', secType: 'STK',
                        currency: 'HKD' },
                    { bookId: 'book-fut', account: 'U1', symbol: 'MNQ', secType: 'FUT' });
                h.state.status = { features: { optionScenarioInputs: true } };
                // A later expiry in this book keeps 20270115 selectable.
                h.state.allEvents.push({
                    kind: 'option_trade', account: 'U1', tradeDate: '2026-09-01',
                    right: 'C', strike: 80, expiry: '20270115', sharesPerContract: 100,
                    contracts: -1, price: 2, cashAmount: 200,
                });
                h.state.ledger = core.computeLedger(h.state.allEvents);
                h.state.stressOpen = true;
                h.state.stressExpiry = '20260904';
                h.state.stressBasePrice = 70;
                const document = h.context.document;
                const svgNode = () => ({
                    children: [], textContent: '', style: {}, attributes: {},
                    appendChild(child) { this.children.push(child); return child; },
                    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
                    get firstChild() { return this.children[0]; },
                    setAttribute(name, value) { this.attributes[name] = value; },
                });
                document.createElementNS = svgNode;
                const byId = document.getElementById;
                document.getElementById = (id) => {
                    const found = byId(id);
                    if (!found.setAttribute) {
                        found.attributes = {};
                        found.style = {};
                        found.setAttribute = function set(name, value) {
                            this.attributes[name] = value;
                        };
                    }
                    return found;
                };
                const store = {};
                h.context.localStorage = {
                    getItem(key) { return key in store ? store[key] : null; },
                    setItem(key, value) { store[key] = String(value); },
                };
                const qqqEvents = [{
                    seq: 1, kind: 'option_trade', tradeDate: '2026-08-01', account: 'U1',
                    right: 'P', strike: 480, expiry: '20270115', contracts: 10,
                    sharesPerContract: 100, price: 25, cashAmount: -25000, fees: 0,
                    includeInCost: true,
                }, {
                    seq: 2, kind: 'option_trade', tradeDate: '2026-08-01', account: 'U1',
                    right: 'C', strike: 560, expiry: '20270115', contracts: 1,
                    sharesPerContract: 100, price: 15, cashAmount: -1500, fees: 0,
                    includeInCost: true,
                }, {
                    seq: 3, kind: 'option_trade', tradeDate: '2026-08-02', account: 'U1',
                    right: 'P', strike: 470, expiry: '20260904', contracts: 4,
                    sharesPerContract: 100, price: 5, cashAmount: -2000, fees: 0,
                    includeInCost: true,
                }, {
                    // A short leg in the linked book is not protection.
                    seq: 4, kind: 'option_trade', tradeDate: '2026-08-02', account: 'U1',
                    right: 'P', strike: 450, expiry: '20270115', contracts: -5,
                    sharesPerContract: 100, price: 10, cashAmount: 5000, fees: 0,
                    includeInCost: true,
                }];
                const calls = [];
                h.configure({
                    today: () => '2026-09-03',
                    request: async (action, fields) => {
                        calls.push({ action, fields });
                        if (action === 'list_cost_basis_events') {
                            return { events: qqqEvents.map((event) => ({ ...event })),
                                total: qqqEvents.length };
                        }
                        if (action === 'request_cost_basis_option_scenario_inputs') {
                            return {
                                underlyingPrice: fields.bookId === 'book-qqq' ? 500 : 70,
                                throughExpiry: fields.throughExpiry,
                                fetchedAt: '2026-09-03T14:00:00Z',
                                curveEffectiveDate: '2026-09-02',
                                options: [
                                    { right: 'P', strike: 480, expiry: '20270115',
                                        impliedVolatility: 0.22, ivSource: 'modelGreeks',
                                        mark: 21.5, markSource: 'mid' },
                                    { right: 'C', strike: 560, expiry: '20270115',
                                        impliedVolatility: 0.18, ivSource: 'modelGreeks',
                                        mark: 9.25, markSource: 'mid' },
                                    { right: 'P', strike: 470, expiry: '20260904',
                                        impliedVolatility: 0.3, ivSource: 'modelGreeks',
                                        mark: 1.1, markSource: 'mid' },
                                ],
                                ratesByExpiry: [{ expiry: '20270115', zeroRate: 0.035,
                                    source: 'usd_reference_discount_curve' }],
                            };
                        }
                        throw new Error(`unexpected ${action}`);
                    },
                });
                const mainEventsBefore = JSON.stringify(h.state.allEvents);
                const mainLedgerBefore = JSON.stringify(h.state.ledger);

                const book = h.state.books[0];
                h.restoreLinked(book);
                assert.equal(h.state.stressLinkedBookId, 'book-qqq');
                assert.equal(h.state.stressLinkedRatio, 3);
                assert.equal(h.state.stressIncludeLinkedHedge, false);
                h.renderStress();
                const select = h.node('stress-linked-book');
                // Same account, STK and same currency only: the HKD book and
                // the other account's QQQ book are not offered.
                assert.equal(select.children.map((option) => option.value).join(','),
                    ',book-qqq');
                assert.equal(h.node('stress-include-linked-hedge').disabled, false);
                assert.equal(h.node('stress-linked-inputs').hidden, true);
                assert.equal(h.node('stress-legend-linked-pnl').hidden, true);
                assert.equal(calls.length, 0);
                assert.equal(h.linkedRequest(), null);

                h.state.stressIncludeLinkedHedge = true;
                h.renderStress();
                assert.match(h.node('stress-status').textContent, /QQQ 账本尚未载入/);
                await h.loadLinked(false);
                assert.deepEqual(calls.map((call) => call.action), [
                    'list_cost_basis_events',
                    'request_cost_basis_option_scenario_inputs',
                ]);
                assert.equal(calls[0].fields.bookId, 'book-qqq');
                assert.equal(calls[1].fields.bookId, 'book-qqq');
                assert.equal(calls[1].fields.throughExpiry, '20260904');
                // Every long contract alive today is quoted: its mark is the
                // reference the scenario value is measured against.
                assert.equal(calls[1].fields.contracts.map((item) => (
                    `${item.right}${item.strike}@${item.expiry}`)).sort().join(','),
                'C560@20270115,P470@20260904,P480@20270115');
                assert.equal(h.state.stressLinkedEvents.length, 4);
                assert.ok(h.state.stressLinkedLedger);
                assert.equal(h.state.stressLinkedInputs.underlyingPrice, 500);
                assert.equal(h.state.stressLinkedEventsPending, false);
                assert.equal(h.state.stressLinkedInputsPending, false);
                assert.equal(JSON.stringify(h.state.allEvents), mainEventsBefore);
                assert.equal(JSON.stringify(h.state.ledger), mainLedgerBefore);
                assert.equal(h.state.bookId, 'book-test');
                const request = h.linkedRequest();
                assert.equal(request.symbol, 'QQQ');
                assert.equal(request.basePrice, 500);
                assert.equal(request.asOf, '20260903');
                assert.equal(request.openOptions.length, 4);

                h.renderStress();
                const status = h.node('stress-status').textContent;
                // Without this book's own overlay the linked book is ②, and
                // every surface says so.
                assert.match(status, /② 已叠加 QQQ 账本 1 张 Long Call \+ 14 张 Long Put/);
                assert.match(status, /① TQQQ 到期结算/);
                assert.doesNotMatch(status, /③/);
                assert.match(status, /映射 1 : 3\.00/);
                assert.match(status, /QQQ 基准/);
                // 21.5*10*100 + 9.25*1*100 + 1.1*4*100 = 22,865
                assert.match(status, /今日标记市值 \$22,865/);
                assert.match(status, /TWS IV 18\.00%–22\.00%/);
                assert.equal(h.node('stress-legend-linked-pnl').hidden, false);
                assert.match(h.node('stress-legend-linked-pnl').textContent,
                    /①\+② 计入 QQQ 多头期权较今日变动/);
                assert.match(h.node('stress-legend-base-pnl').textContent, /① TQQQ 到期结算盈亏/);
                assert.match(h.node('stress-linked-book-status').textContent,
                    /QQQ 账本：1 张 Long Call \+ 14 张 Long Put · 事件 4 条/);
                assert.match(h.node('stress-linked-inputs-status').textContent,
                    /3 张已取得 · QQQ 基准/);
                const cards = h.node('stress-key-points').children;
                assert.equal(cards.length, 3);
                const cardLines = cards[0].children.map((child) => child.textContent);
                assert.match(cardLines[0], /下行情景 · 49\.00（-30\.0%） · QQQ 44[34]\.\d\d（-11\.2%）/);
                assert.match(cardLines[1], /^合计 /);
                assert.match(cardLines[2], /^① TQQQ 到期结算 /);
                assert.match(cardLines[3], /^② QQQ 多头期权较今日 \+/);
                assert.match(cardLines[1], /^合计 /);
                const numbering = h.context.OptionComboCostBasisPage.stressComponentNumbers;
                assert.equal(numbering(false, false, true).total, '①+②');
                assert.equal(numbering(true, false, true).total, '①+②+③');
                assert.equal(numbering(true, true, true).total, '①+②+③+④');
                assert.equal(numbering(true, false, false).total, '①+②');
                assert.equal(numbering(false, true, false).total, '①+②');
                assert.equal(numbering(false, false, false).total, '①');
                assert.equal(numbering(false, false, true).linked, '②');
                assert.equal(numbering(true, false, true).linked, '③');
                assert.equal(numbering(true, true, true).shorts, '③');
                assert.equal(numbering(true, true, true).linked, '④');
                assert.match(cardLines[4], /^综合成本 /);
                const chart = h.node('stress-chart');
                assert.ok(chart.children.some((child) => (
                    child.attributes && child.attributes.class === 'stress-linked-pnl-line')));

                // A different expiry invalidates only the IV snapshot; the
                // ledger read is reused.
                calls.length = 0;
                h.state.stressExpiry = '20270115';
                h.state.stressLinkedInputs = null;
                h.ensureLinked(false);
                await new Promise((resolve) => setImmediate(resolve));
                assert.deepEqual(calls.map((call) => call.action),
                    ['request_cost_basis_option_scenario_inputs']);
                assert.equal(calls[0].fields.throughExpiry, '20270115');
                assert.equal(calls[0].fields.contracts.length, 3);
                h.renderStress();
                // Every linked contract settles on this date, so nothing can
                // stand in for the path volatility: refused, not "zero drag".
                assert.match(h.node('stress-status').textContent, /需要路径波动率/);
                assert.equal(h.node('stress-chart').children.length, 0);
                h.state.stressLinkedSigma = 0.3;
                h.renderStress();
                assert.match(h.node('stress-status').textContent, /全部按内在价值结算/);
                assert.match(h.node('stress-status').textContent, /路径 σ 30\.0%（假设）/);

                // IV shock flows from state into the sweep and the caption.
                h.state.stressExpiry = '20260904';
                h.state.stressLinkedInputs = null;
                h.ensureLinked(false);
                await new Promise((resolve) => setImmediate(resolve));
                h.renderStress();
                const calmTotal = h.node('stress-key-points').children[0].children[1].textContent;
                // The own-book note is generated from the controls in force,
                // step count included, so it can never contradict them.
                assert.match(h.node('stress-own-note').textContent,
                    /美式 CRR 二叉树（121 步）.*TQQQ 1\.00%.*中间价/);
                h.state.stressPricingModel = 'european';
                h.state.stressLiquidation = 'bidask';
                h.state.stressDividendYield = 0.0125;
                h.renderStress();
                assert.match(h.node('stress-own-note').textContent,
                    /欧式 BSM.*股息率 1\.25%.*按今日点差折算.*交叉或单边报价拒绝/);
                h.state.stressPricingModel = 'american';
                h.state.stressLiquidation = 'mid';
                h.state.stressDividendYield = null;
                h.renderStress();
                assert.equal(h.node('stress-linked-iv-mode').value, 'none');
                assert.equal(h.node('stress-linked-iv-shock-field').hidden, true);
                assert.equal(h.node('stress-linked-iv-beta-field').hidden, true);
                h.state.stressLinkedIvMode = 'fixed';
                h.state.stressLinkedIvShockPoints = 20;
                h.renderStress();
                assert.equal(h.node('stress-linked-iv-shock').value, '20');
                assert.equal(h.node('stress-linked-iv-shock-field').hidden, false);
                assert.match(h.node('stress-status').textContent,
                    /TWS IV 38\.00%–42\.00%（已含固定 IV 冲击 \+20 点）/);
                const shockedTotal = h.node('stress-key-points').children[0].children[1].textContent;
                assert.notEqual(shockedTotal, calmTotal);
                h.state.stressLinkedIvMode = 'beta';
                h.state.stressLinkedIvBeta = 1.5;
                h.renderStress();
                assert.equal(h.node('stress-linked-iv-beta-field').hidden, false);
                assert.equal(h.node('stress-linked-iv-shock-field').hidden, true);
                assert.match(h.node('stress-status').textContent,
                    /TWS IV 18\.00%–22\.00%（基准点；每跌 1% IV \+1\.50 点，按期限衰减 √\(30\/剩余天\)，上涨侧不变）/);
                assert.equal(h.node('stress-linked-iv-tenor-field').hidden, false);
                assert.equal(h.node('stress-linked-iv-tenor').checked, true);
                h.state.stressLinkedIvTenorDamping = false;
                h.renderStress();
                assert.match(h.node('stress-status').textContent,
                    /每跌 1% IV \+1\.50 点，上涨侧不变）/);
                h.state.stressLinkedIvTenorDamping = true;
                h.state.stressLinkedIvMode = 'none';
                // A horizon is ONE scenario date for everything: the settlement,
                // this book's snapshot and the linked snapshot all move to it.
                h.state.stressHorizonDays = 20;
                assert.equal(h.scenarioDate().date, '20260923');
                calls.length = 0;
                h.state.stressLongOptionInputs = null;
                h.state.stressLinkedInputs = null;
                h.state.stressIncludeLongOptions = true;
                await h.refreshStressInputs(false);
                h.ensureLinked(false);
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(calls.length, 2);
                calls.forEach((call) => {
                    assert.equal(call.action, 'request_cost_basis_option_scenario_inputs');
                    assert.equal(call.fields.throughExpiry, '20260923');
                });
                // This book's short call is still open on the horizon and is
                // quoted too (shorts are marked); every row carries a multiplier.
                assert.equal(calls[0].fields.bookId, 'book-test');
                assert.equal(calls[0].fields.contracts.length, 1);
                assert.equal(calls[0].fields.contracts[0].right, 'C');
                assert.equal(calls[0].fields.contracts[0].multiplier, 100);
                assert.equal(calls[1].fields.bookId, 'book-qqq');
                assert.ok(calls[1].fields.contracts.length > 0);
                calls[1].fields.contracts.forEach((item) => assert.equal(item.multiplier, 100));
                h.state.stressIncludeLongOptions = false;
                h.renderStress();
                assert.equal(h.node('stress-horizon-days').value, '20');
                assert.match(h.node('stress-status').textContent,
                    /2026-09-23 情景日（今天 \+20 天，含 Theta，覆盖到期范围；三项同日估值）/);
                // The P71@20260904 short put is settled on the horizon date.
                const horizonCards = h.node('stress-key-points').children;
                assert.match(horizonCards[0].children[4].textContent, /400 股/);
                assert.doesNotMatch(h.node('stress-status').textContent, /估值日 20/);
                // An unusable horizon is refused, never silently the expiry.
                h.state.stressHorizonDays = NaN;
                h.renderStress();
                assert.match(h.node('stress-status').textContent, /跌到位天数无效/);
                assert.equal(h.node('stress-chart').children.length, 0);
                h.state.stressHorizonDays = null;
                // Back to the beta-mode scenario the next assertions expect;
                // the snapshot keyed to the horizon date is stale by design.
                h.state.stressLinkedIvMode = 'beta';
                h.state.stressLinkedInputs = null;
                h.ensureLinked(false);
                await new Promise((resolve) => setImmediate(resolve));
                h.renderStress();
                assert.match(h.node('stress-status').textContent, /2026-09-04 到期后/);
                const betaCards = h.node('stress-key-points').children;
                // Downside card moved, basis card did not.
                assert.notEqual(betaCards[0].children[1].textContent, calmTotal);
                const calmMiddle = (() => {
                    h.state.stressLinkedIvMode = 'none';
                    h.renderStress();
                    return h.node('stress-key-points').children[1].children[1].textContent;
                })();
                h.state.stressLinkedIvMode = 'beta';
                h.renderStress();
                assert.equal(h.node('stress-key-points').children[1].children[1].textContent,
                    calmMiddle);
                h.state.stressLinkedIvMode = 'none';
                h.state.stressLinkedIvShockPoints = 0;

                // A load that finishes after the user moved to another book
                // is dropped on the floor.
                let release;
                h.configure({
                    request: () => new Promise((resolve) => { release = resolve; }),
                });
                h.state.stressLinkedLedger = null;
                const pending = h.loadLinked(false);
                h.state.bookId = 'book-elsewhere';
                release({ events: qqqEvents, total: qqqEvents.length });
                await pending;
                assert.equal(h.state.stressLinkedLedger, null);

                assert.ok(html.includes('id="stress-include-linked-hedge"'));
                assert.ok(html.includes('id="stress-linked-book"'));
                assert.ok(html.includes('id="stress-linked-ratio"'));
                assert.ok(html.includes('id="stress-linked-iv-shock"'));
                assert.ok(html.includes('id="stress-linked-iv-mode"'));
                assert.ok(html.includes('id="stress-linked-iv-beta"'));
                assert.ok(html.includes('id="stress-linked-iv-tenor"'));
                assert.ok(html.includes('id="stress-linked-iv-tenor-days"'));
                assert.ok(html.includes('id="stress-horizon-days"'));
                assert.ok(html.includes('id="stress-tooltip-horizon"'));
                assert.equal(html.includes('stress-linked-horizon-days'), false);
                assert.match(html, /三项永远在同一个情景日估值/);
                assert.match(html, /<option value="none" selected>/);
                assert.ok(html.includes('id="stress-tooltip-linked-iv"'));
                assert.ok(html.includes('id="stress-linked-book-status"'));
                assert.ok(html.includes('id="stress-linked-inputs-status"'));
                assert.ok(html.includes('id="stress-legend-linked-pnl"'));
                assert.ok(html.includes('id="stress-tooltip-linked-price"'));
                assert.ok(html.includes('id="stress-tooltip-linked-value"'));
                assert.ok(html.includes('id="stress-tooltip-linked-pnl"'));
                assert.ok(html.includes('id="stress-tooltip-total-row"'));
                assert.ok(html.includes('id="stress-tooltip-base-label"'));
                assert.ok(html.includes('id="stress-tooltip-linked-premium"'));
                assert.equal(html.includes('stress-tooltip-own-pnl'), false);
                assert.match(html, /盈亏按编号分项再加总/);
                assert.match(html, /已付权利金是沉没成本/);
                assert.match(html, /TQQQ ↔ QQQ 跨标的保护/);
                assert.match(html, /映射以指数为驱动变量/);
                assert.match(html, /空头按已收权利金减去理论负债/);
                assert.match(html, /不读取 TWS 持仓作为兜底/);
                assert.match(source, /function chooseLinkedBook/);
                assert.match(source, /function _loadStressLinkedEvents/);
                assert.match(source, /function _refreshStressLinkedInputs/);
                assert.doesNotMatch(source, /_stressLinkedOptionRequests/);
                assert.match(source, /optionComboStressLinkedHedge:/);
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
