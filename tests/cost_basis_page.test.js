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
            renderSummary: _renderSummary,
            handleImportFile: _handleImportFile, commitImport: _commitImport,
            parseImport: _parseImportText, bindingProblem: _importBindingProblem,
            beginBook: _beginBookSelection,
            message: _handleMessage, renderWhatIf: _renderWhatIf,
            editPrice: _editWhatIfPrice, followPrice: _setWhatIfFollowReference,
            refreshPrice: _refreshWhatIfMarketPrice, invalidate: _invalidatePositions,
            selectPriceBook: _beginBookSelection, loadEvents: _loadEvents,
            configureEventLoad() { _syncBookMode = () => {}; },
            renderStress: _renderStressTest,
            stressSeries: _stressSeries, stressJob, cancelStressJob: _cancelStressJob,
            silenceStressRender() { _renderStressTest = () => {}; },
            refreshStressInputs: _refreshStressMarketInputs,
            refreshStressPair: _refreshStressScenarioInputs, stressRefreshJob,
            invalidateScenario: _invalidateStressScenarioInputs,
            scenarioDate: _stressScenarioDate,
            setHorizon: _setStressHorizon, applyHorizon: _applyStressHorizon,
            syncHorizon: _syncStressHorizonControls, frozenBatch: _stressFrozenSnapshotBatch,
            renderStressCards: _renderStressCards,
            navText: _stressNavText,
            restoreLinked: _restoreStressLinkedChoice,
            reviewIv: _reviewStressIvSettings, renderIvProfile: _renderStressIvProfile,
            writeLinked: _writeStressLinkedMemory, renderSlice: _renderStressSlice,
            bandMemberLabel: _stressBandMemberLabel,
            loadLinked: _loadStressLinkedEvents,
            ensureLinked: _ensureStressLinkedData,
            linkedRequest: _stressLinkedHedgeRequest,
            renderAccounts: _renderManagedAccounts,
            accountHint: _renderNewBookAccountHint,
            showView: _showView, openStress: _openStressTest, closeStress: _closeStressTest,
            teardownStress: _teardownStressTest, setStressGroup: _setStressGroupOpen,
            noteStressGroupToggle: _noteStressGroupToggle,
            configurePrice() {
                _renderAll = _renderWhatIf;
                _renderPositionsStatus = () => {};
                _renderReconciliation = () => {};
            },
            configure(handlers) {
                if (handlers.adopt) _adoptTwsPosition = handlers.adopt;
                if (handlers.request) request = async (action, payload) => {
                    const response = await handlers.request(action, payload);
                    return action === 'list_cost_basis_events' && response && !response.ledgerVersion
                        ? { ...response, ledgerVersion: { digest: 'test-reviewed-history' } } : response;
                };
                if (handlers.today) {
                    _todayIso = handlers.today;
                    globalScope.OptionComboCostBasisStressCore = {
                        ...globalScope.OptionComboCostBasisStressCore,
                        exchangeDate: () => handlers.today().replace(/-/g, ''),
                    };
                }
                _refreshControls = () => {};
                _renderReconciliation = _renderReconciliationTable;
                _renderImportPreview = () => {};
            },
        };
        globalScope.OptionComboCostBasisPage = {`), context);
    function node() {
        const classes = new Set();
        return {
            children: [], handlers: {}, textContent: '', dataset: {},
            classList: {
                add(...names) { names.forEach((name) => classes.add(name)); },
                remove(...names) { names.forEach((name) => classes.delete(name)); },
                contains(name) { return classes.has(name); },
                toggle(name, force) {
                    const on = force === undefined ? !classes.has(name) : Boolean(force);
                    if (on) classes.add(name); else classes.delete(name);
                    return on;
                },
            },
            appendChild(child) { this.children.push(child); return child; },
            removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
            get firstChild() { return this.children[0]; },
            addEventListener(name, callback) { this.handlers[name] = callback; },
            setAttribute(name, value) { this[name] = String(value); },
            focus(options) { this.focusOptions = options; context.document.activeElement = this; },
            scrollIntoView(options) { this.scrollOptions = options; },
            querySelector() { return this.body || (this.body = node()); },
            querySelectorAll() { return []; },
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
        body: node(),
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
    // Existing ledger/fallback cases explicitly exercise the historical lens.
    // Portfolio workflow tests opt into the change lens below.
    h.state.stressPnlBasis = 'cost';
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

function loadStressPairHarness() {
    const h = loadPriceHarness();
    const pending = [];
    h.state.books.push({ bookId: 'book-qqq', account: 'U1', symbol: 'QQQ', secType: 'STK' });
    h.restoreLinked(h.state.books[0]);
    Object.assign(h.state, { stressIncludeLinkedHedge: true, stressExpiry: '20260904',
        stressPnlBasis: 'cost',
        stressIncludeLongOptions: false, stressBasePrice: 70, stressLinkedMapping: 'linear',
        status: { features: { optionScenarioInputs: true } } });
    const events = [{ kind: 'option_trade', tradeDate: '2026-08-01', account: 'U1',
        right: 'P', strike: 480, expiry: '20270115', contracts: 1,
        sharesPerContract: 100, price: 25, cashAmount: -2500 }];
    h.state.stressLinkedLedger = h.context.OptionComboCostBasisCore.computeLedger(events);
    h.configure({ today: () => '2026-09-03', request: (action, fields) => new Promise((resolve, reject) => {
        pending.push({ action, fields, resolve, reject });
    }) });
    const quote = (bookId, fetchedAt = '2026-09-03T14:00:00Z') => ({
        underlyingPrice: bookId === 'book-qqq' ? 500 : 70, currency: 'USD', snapshotVersion: 2,
        fetchedAt, underlyingObservedAt: fetchedAt, throughExpiry: '20260904',
        discountCurve: { schemaVersion: 2, currency: 'USD', effectiveDate: '2026-09-03',
            points: [{ tenorDays: 1, zeroRate: 0.035 }, { tenorDays: 365, zeroRate: 0.035 }] },
        options: bookId === 'book-qqq' ? [{ right: 'P', strike: 480, expiry: '20270115',
            mark: 21.5, impliedVolatility: 0.22, marketDataType: 1, observedAt: fetchedAt }] : [],
    });
    const compile = () => h.context.OptionComboCostBasisStressCore.compile(h.state.allEvents, {
        centerPrice: 70, throughExpiry: '20260904', pricingModel: 'european',
        includeDeferredLongOptions: false, longOptionInputs: h.state.stressLongOptionInputs,
        linkedHedge: h.linkedRequest(), requireSnapshotVersion: 2,
    });
    return { h, pending, quote, compile, events };
}

function enableStressChartDom(h) {
    const doc = h.context.document;
    doc.createElementNS = () => ({ children: [], attributes: {}, style: {},
        appendChild(child) { this.children.push(child); return child; },
        setAttribute(name, value) { this.attributes[name] = value; },
    });
    const byId = doc.getElementById;
    doc.getElementById = (id) => {
        const node = byId(id);
        node.style ||= {};
        node.setAttribute ||= function set(name, value) { this[name] = value; };
        return node;
    };
}

module.exports = {
    name: 'cost_basis page',
    tests: [
        {
            name: 'portfolio workflow migrates old mixed-basis settings and leaves hypothetical future income out',
            run() {
                const h = loadPriceHarness();
                h.context.localStorage = { getItem: () => JSON.stringify({ weeklyPremium: 3500,
                    kernel: { pnlBasis: 'cost' } }) };
                h.restoreLinked(h.state.books[0]);
                assert.equal(h.state.stressPnlBasis, 'change');
                assert.equal(h.state.stressIncludeIncome, false);
                assert.equal(h.state.stressWeeklyPremium, 3500, 'retained as an explicit optional assumption');
                assert.equal(h.state.stressIvRangePct, 20);
            },
        },
        {
            name: 'quantity editing compares against current holdings, keeps quotes and clears stale drafts on ledger change',
            run() {
                const h = loadPriceHarness(); enableStressChartDom(h);
                h.configure({ today: () => '2026-09-03' });
                h.context.setTimeout = () => 1; h.context.clearTimeout = () => {};
                const snapshot = { snapshotVersion: 2, fetchedAt: '2026-09-03T14:00:00Z',
                    underlyingObservedAt: '2026-09-03T14:00:00Z', underlyingPrice: 70,
                    throughExpiry: '20260904', currency: 'USD',
                    discountCurve: { schemaVersion: 2, effectiveDate: '2026-09-03', currency: 'USD',
                        points: [{tenorDays:1,zeroRate:0.03},{tenorDays:365,zeroRate:0.03}] },
                    options: [{right:'P', strike:71, expiry:'20260904', multiplier:100, mark:2,
                        marketDataType:1, observedAt:'2026-09-03T14:00:00Z'}] };
                Object.assign(h.state, { stressOpen:true, stressExpiry:'20260904', stressBasePrice:70,
                    stressPnlBasis:'change', stressIncludeLongOptions:true, stressLongOptionInputs:snapshot,
                    stressBandEnabled:false, stressWeeklyPremium:3500, stressIncludeIncome:false });
                h.renderStress();
                const original = h.stressJob.series;
                assert.equal(original.available, true);
                assert.equal(original.premiumIncome, 0);
                const input = h.node('stress-quantity-rows').children[1].children[1];
                input.value = '1'; h.context.document.activeElement = input; input.handlers.input();
                h.renderStress();
                const draft = h.stressJob.series;
                assert.equal(draft.quantitiesChanged, true);
                assert.equal(draft.points[0].currentHoldingsPnl, original.points[0].headlinePnl);
                assert.ok(draft.points[0].quantityEffect > 0);
                assert.equal(h.state.stressLongOptionInputs, snapshot);
                assert.equal(h.state.ledger.openOptions[0].contracts, -2);
                assert.equal(h.node('stress-legend-cost').hidden, true);
                h.state.stressNavBase = 100000;
                const text = h.navText(draft, draft.points[0], {lower:-10000,upper:-5000});
                assert.match(text, /90,000.*95,000/);
                assert.match(text, /-10.0%.*-5.0%/);
                h.state.stressNavBase = -1; assert.equal(h.navText(draft, draft.points[0], null), '');
                h.context.document.activeElement = null;
                h.state.allEvents = h.state.allEvents.concat({ kind:'share_trade', account:'U1', tradeDate:'2026-09-02', shares:100, price:70, cashAmount:-7000 });
                h.state.ledger = h.context.OptionComboCostBasisCore.computeLedger(h.state.allEvents);
                h.renderStress();
                assert.equal(Object.keys(h.state.stressQuantityDraft.own).length, 0);
                assert.equal(h.state.stressNavBase, null);
            },
        },
        {
            name: 'conservative short-put delivery defaults on, reaches valuation and remembers explicit opt-out per book',
            run() {
                const h = loadPriceHarness(); enableStressChartDom(h);
                h.configure({ today: () => '2026-09-03' });
                const memory = {};
                h.context.localStorage = { getItem: key => memory[key] || null,
                    setItem: (key, value) => { memory[key] = value; } };
                h.restoreLinked(h.state.books[0]);
                assert.equal(h.state.stressConservativeShortPutAssignment, true);
                Object.assign(h.state, { stressOpen: true, stressExpiry: '20260904',
                    stressBasePrice: 70, stressIncludeLongOptions: false, stressBandEnabled: false, stressPnlBasis: 'cost' });
                h.renderStress();
                assert.equal(h.node('stress-conservative-short-put').checked, true);
                assert.equal(h.stressJob.series.conservativeShortPutAssignment, true);
                const oldSeries = h.stressJob.series;
                h.state.stressConservativeShortPutAssignment = false;
                h.writeLinked(); h.restoreLinked(h.state.books[0]); h.renderStress();
                assert.equal(h.node('stress-conservative-short-put').checked, false);
                assert.equal(h.stressJob.series.conservativeShortPutAssignment, false);
                assert.notEqual(h.stressJob.series, oldSeries);
                h.restoreLinked({ ...h.state.books[0], bookId: 'another-book' });
                assert.equal(h.state.stressConservativeShortPutAssignment, true);
            },
        },
        {
            name: 'legacy IV settings are retained until explicitly kept or restored, without touching threefold assumptions',
            run() {
                const h = loadPriceHarness(); h.silenceStressRender();
                h.state.books.push({bookId:'book-qqq',account:'U1',symbol:'QQQ',secType:'STK'});
                const key = 'optionComboStressLinkedHedge:book-test';
                const old = {linkedBookId:'book-qqq',ivMode:'beta',ivTenorDays:40,ivTenorExponent:0.25,
                    ivBetaAuto:true,ivOtmDiscount:true,ivTenorDamping:true,ratio:3,mapping:'linear',sigma:0.3,
                    dividendYield:0.007,sigmaCrashScale:false};
                const memory = {[key]:JSON.stringify(old)};
                h.context.localStorage = {getItem:k=>memory[k] || null,setItem:(k,v)=>{memory[k]=v;}};
                h.restoreLinked(h.state.books[0]); h.renderIvProfile();
                assert.equal(h.state.stressLinkedIvTenorExponent,0.25);
                assert.equal(h.node('stress-iv-profile-label').textContent,'自定义 IV 参数');
                assert.equal(h.node('btn-stress-iv-keep').hidden,false);
                // An unrelated setting save must not silently acknowledge old research.
                h.state.stressWeeklyPremium=10; h.writeLinked(); h.restoreLinked(h.state.books[0]); h.renderIvProfile();
                assert.equal(h.node('btn-stress-iv-keep').hidden,false);
                h.reviewIv(false); h.restoreLinked(h.state.books[0]); h.renderIvProfile();
                assert.equal(h.state.stressLinkedIvTenorExponent,0.25);
                assert.equal(h.node('btn-stress-iv-keep').hidden,true);
                h.reviewIv(true); h.restoreLinked(h.state.books[0]); h.renderIvProfile();
                assert.equal(h.state.stressLinkedIvTenorDays,30);
                assert.equal(h.state.stressLinkedIvTenorExponent,0.65);
                assert.equal(h.node('stress-iv-profile-label').textContent,'QQQ IV 研究基准');
                for (const [stateKey,key] of [['stressLinkedRatio','ratio'],['stressLinkedMapping','mapping'],
                    ['stressLinkedSigma','sigma'],['stressLinkedDividendYield','dividendYield'],['stressLinkedSigmaCrashScale','sigmaCrashScale']]) {
                    assert.equal(h.state[stateKey],old[key]);
                }
                assert.equal(h.state.stressWeeklyPremium,10);
                h.restoreLinked({...h.state.books[0],bookId:'another-book'}); h.renderIvProfile();
                assert.equal(h.node('btn-stress-iv-keep').hidden,true,'fresh books do not inherit old-profile warning');
            },
        },
        {
            name: 'slice panel shows both lenses, IV contribution, gross delivery cash and the actual bound members',
            run() {
                const h = loadPriceHarness();
                const p = {price:43.218,changePct:-40,cashflowPnl:-10321.59,snapshotChangePnl:-12648.23,
                    flatIvPnl:-32084.80,ivContribution:21763.21,settlementCashPaid:135600,
                    settlementCashReceived:9000,settlementCashNet:-126600,shares:2700};
                const series = {available:true,points:[p],costComplete:true,linkedHedgeEnabled:true,pnlBasis:'cost',
                    ivAssumptions:{ivMode:'beta',ivBetaAuto:true,ivTenorDamping:true,ivTenorDays:40,ivTenorExponent:0.25,ivOtmDiscount:true},
                    band:{available:true,members:[{}, {flatIv:true}, {betaScale:1.25,tenorExponent:0.5,otmFloor:0.65}],
                        points:[{lower:-32084.8,upper:-9961.13,lowerMember:1,upperMember:2}]}};
                h.renderSlice(series,0,h.state.books[0]);
                assert.equal(h.node('stress-slice').hidden,false);
                assert.match(h.node('stress-slice-change-pnl').textContent,/12,648.23/);
                assert.match(h.node('stress-slice-iv-contribution').textContent,/21,763.21/);
                assert.match(h.node('stress-slice-cash-gross').textContent,/135,600.00.*9,000.00/);
                assert.match(h.node('stress-slice-band-lower').textContent,/IV 保持不变/);
                assert.match(h.node('stress-slice-band-upper').textContent,/× 1.25.*指数 0.5.*0.65/);
                assert.match(h.node('stress-slice-scope').textContent,/不是完整账户/);
                assert.equal(h.stressJob.sliceIndex,0);
                series.referenceChangeReason='missing_reference_quotes'; p.snapshotChangePnl=null;
                series.band=null; h.stressJob.status='区间已关闭'; h.renderSlice(series,0,h.state.books[0]);
                assert.equal(h.node('stress-slice-change-pnl').textContent,'不可用');
                assert.match(h.node('stress-slice-reference-note').textContent,/未按零补齐/);
                assert.match(h.node('stress-slice-flat-pnl').textContent,/32,084.80/);
                assert.equal(h.node('stress-slice-band-upper').textContent,'区间已关闭');
                h.renderSlice({available:false},0,h.state.books[0]);
                assert.equal(h.node('stress-slice').hidden,true);
            },
        },
        {
            name: 'band parameter descriptions honor disabled factors and fixed-IV mode',
            run() {
                const h=loadPriceHarness();
                const label=h.bandMemberLabel({ivAssumptions:{ivMode:'beta',ivBeta:1.2}}, {betaScale:0.8});
                assert.match(label,/手填 β 1.20 × 0.80/);
                assert.match(label,/期限衰减关闭.*价外 Put 折扣关闭/);
                assert.equal(h.bandMemberLabel({ivAssumptions:{ivMode:'fixed',ivShockPoints:8}},{}),'固定 IV 冲击 8.00 点');
                assert.equal(h.bandMemberLabel({ivAssumptions:{ivMode:'none'}},{}),'IV 保持不变');
            },
        },
        {
            name: 'slice controls are accessible and do not add broker or ledger write actions',
            run() {
                const html=readPage(), source=readScript();
                for(const id of ['stress-slice-index','stress-slice-band-lower','stress-slice-band-upper',
                    'btn-stress-iv-baseline','btn-stress-iv-keep','stress-iv-profile-note']) assert.ok(html.includes(`id="${id}"`));
                assert.match(source, /_renderStressSlice\(series, pointIndex, book\)/);
                assert.match(source, /_renderStressSlice\(series, stressJob.sliceIndex \?\? series.centerIndex, book\)/);
                assert.match(html, /多日期收付款合计不代表峰值资金需求/);
                assert.match(html, /只恢复这些 IV 控件，不改价格映射或三倍联动/);
            },
        },
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
            name: 'batch lookup fetches once, isolates incomplete contracts and commits once after confirmation',
            async run() {
                const h = loadReconciliationHarness();
                h.state.ledgerVersion = {digest:'batch-v1'};
                const core = h.context.OptionComboCostBasisCore;
                const openings = [70,71,72].map(strike => ({account:'U1',kind:'option_trade',
                    right:'C',strike,expiry:'20260904',sharesPerContract:100,contracts:-2,
                    price:1,cashAmount:200,fees:0,tradeDate:'2026-09-01'}));
                h.state.allEvents = openings;
                h.state.ledger = core.computeLedger(openings);
                h.state.reconciliation = {rows:openings.map(e => ({...e,kind:'option',
                    key:core.contractKey(e),status:'ledger_only',label:`C${e.strike}`,
                    ledger:-2,tws:0,difference:2}))};
                const calls=[];
                h.configure({request: async (action,payload) => {
                    calls.push({action,payload});
                    if(action==='request_cost_basis_executions') return {
                        fetchedAt:'2026-09-03T11:00:00', executions:openings.map(e => ({
                            account:'U1',symbol:'TQQQ',secType:'OPT',execId:`batch-${e.strike}`,
                            right:'C',strike:e.strike,expiry:e.expiry,multiplier:100,side:'BOT',
                            quantity:2,price:0.2,commission:1,commissionAvailable:e.strike!==72,
                            brokerTimestamp:'2026-09-03T10:00:00'}))};
                    if(action==='import_cost_basis_events') return {inserted:2,skipped:0};
                    if(action==='list_cost_basis_books') return {books:[]};
                    return {};
                }});
                await h.fetch({batch:true});
                assert.equal(calls.length,1,'lookup never writes');
                const result=h.state.importResult;
                assert.equal(result.batchReconciliation.matches.length,2);
                assert.equal(result.batchReconciliation.skipped.length,1);
                assert.match(result.batchReconciliation.skipped[0].reason,/佣金/);
                assert.equal(result.twsReconciliation.length,2);
                assert.equal(result.events.length,2);
                assert.equal(result.events.reduce((n,e)=>n+e.cashAmount,0),-82);
                h.context.confirm=()=>false;
                await h.commitImport();
                assert.equal(calls.length,1,'cancel does not write');
                h.context.confirm=()=>true;
                await h.commitImport();
                const writes=calls.filter(c=>c.action==='import_cost_basis_events');
                assert.equal(writes.length,1);
                assert.equal(writes[0].payload.events.length,2);
                assert.equal(writes[0].payload.twsReconciliation.length,2);
                assert.equal(writes[0].payload.expectedLedgerVersion.digest,'batch-v1');
            },
        },
        {
            name: 'structural replay errors block commit but informational ledger warnings do not',
            async run() {
                const h=loadReconciliationHarness(), p=h.context.OptionComboCostBasisPage;
                const result={binding:{bookId:'book-test',generation:h.state.importGeneration,
                    mode:'append',ledgerVersion:'v'},events:[],problems:[],
                    ledgerPreview:{warnings:['net_short_shares','ibkr_close_open_invalid:contract']}};
                h.state.ledgerVersion={digest:'v'};
                h.state.importResult=result;
                let writes=0,confirmations=0;
                h.configure({request:async()=>{writes++;return {};}});
                h.context.confirm=()=>{confirmations++;return true;};
                await h.commitImport();
                assert.equal(writes,0);
                assert.equal(confirmations,0);
                assert.match(h.alerts[0],/历史回放未通过/);
                assert.equal(p.importReplayBlockingWarnings({ledgerPreview:{warnings:['net_short_shares']}}).length,0);
                for(const warning of ['closes_more_than_open:x','ibkr_open_opposes_existing:x',
                    'contract_identity_ambiguous:x','roll_closes_more_than_open:x']) {
                    assert.equal(p.importReplayBlockingWarnings({ledgerPreview:{warnings:[warning]}}).length,1);
                    // The same error already carried by stored history is only reported.
                    const carried={ledgerPreview:{warnings:[warning],newWarnings:[]}};
                    assert.equal(p.importReplayBlockingWarnings(carried).length,0,warning);
                    assert.deepEqual(Array.from(p.importReplayNotices(carried)),[warning]);
                }
                // Advisory notes never block, even when this batch introduces them.
                for(const warning of ['split_crosses_open_option:x','contract_identity_conflict:x',
                    'future_identity_or_multiplier_missing:x']) {
                    const added={ledgerPreview:{warnings:[warning],newWarnings:[warning]}};
                    assert.equal(p.importReplayBlockingWarnings(added).length,0,warning);
                    assert.deepEqual(Array.from(p.importReplayNotices(added)),[warning]);
                }
            },
        },
        {
            name: 'dividends are shown after withholding tax and the tax leaves the fee card',
            run() {
                const h = loadPriceHarness();
                h.silenceStressRender();
                h.context.document.querySelector = () => h.context.document.createElement('div');
                h.context.document.querySelectorAll = () => [];
                h.state.allEvents = [
                    {kind:'share_trade',account:'U1',tradeDate:'2026-06-01',shares:100,
                        price:50,fees:1,cashAmount:-5001,seq:1},
                    {kind:'dividend',account:'U1',tradeDate:'2026-06-20',cashAmount:50,fees:0,seq:2},
                    {kind:'fee',account:'U1',tradeDate:'2026-06-20',cashAmount:-5,fees:5,
                        tag:'withholding_tax',seq:3},
                ];
                h.state.ledger = h.context.OptionComboCostBasisCore.computeLedger(h.state.allEvents);
                h.renderSummary();
                assert.match(h.node('cash-realized-label').textContent, /^税后股息/);
                assert.match(h.node('cash-dividends').textContent, /45\.00/);
                assert.match(h.node('cash-dividends-caption').textContent, /税前 \+?50\.00/);
                assert.match(h.node('cash-dividends-caption').textContent, /预扣税 -5\.00/);
                assert.match(h.node('cash-fees').textContent, /-1\.00/, 'withholding is not subtracted twice');
                const rows = h.node('summary-table').body.children.map(
                    (row) => row.children.map((cell) => cell.textContent));
                const find = (label) => rows.find((cells) => cells[0] === label);
                assert.match(find('税后股息')[1], /45\.00/);
                assert.match(find('　其中：股息预扣税')[1], /-5\.00/);
                assert.match(find('费用合计（不含股息预扣税）')[1], /-1\.00/);
            },
        },
        {
            name: 'replay warnings carried by stored history are shown before commit but never block',
            async run() {
                const h=loadReconciliationHarness(), p=h.context.OptionComboCostBasisPage;
                const core=h.context.OptionComboCostBasisCore;
                // The store accepts a split while a put is open; replay flags it for review.
                const history=[
                    {eventId:'put',seq:1,kind:'option_trade',account:'U1',tradeDate:'2026-08-01',
                        right:'P',strike:50,expiry:'20261016',sharesPerContract:100,contracts:-1,
                        price:2,fees:0,cashAmount:200},
                    {eventId:'split',seq:2,kind:'split',account:'U1',tradeDate:'2026-08-15',
                        splitRatio:2,cashAmount:0}];
                Object.assign(h.state,{allEvents:history,ledger:core.computeLedger(history),
                    ledgerVersion:{digest:'v'}});
                const text=['Account Information,Header,Field Name,Field Value',
                    'Account Information,Data,Account,U1',
                    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee,Code',
                    'Trades,Data,Order,Stocks,USD,TQQQ,"2026-09-01, 10:00:00",10,50,-500,-1,O'].join('\n');
                h.parseImport(text,{fileName:'unrelated.csv',fileDigest:'unrelated'});
                const result=h.state.importResult;
                assert.equal(result.problems.length,0);
                assert.ok(result.ledgerPreview.warnings.some((w)=>w.startsWith('split_crosses_open_option:')));
                assert.deepEqual(Array.from(result.ledgerPreview.newWarnings),[]);
                assert.equal(p.importReplayBlockingWarnings(result).length,0);
                const writes=[];let prompt='';
                h.configure({request:async(action)=>{
                    writes.push(action);
                    if(action==='import_cost_basis_events') return {inserted:1,skipped:0};
                    if(action==='list_cost_basis_books') return {books:[]};
                    return {};
                }});
                h.context.confirm=(message)=>{prompt=message;return true;};
                await h.commitImport();
                assert.match(prompt,/不阻断提交/);
                assert.match(prompt,/拆股跨越未平仓期权/);
                assert.ok(writes.includes('import_cost_basis_events'),'unrelated import still commits');
            },
        },
        {
            name: 'unchanged position broadcasts preserve pending and completed batch previews',
            async run() {
                const h=loadReconciliationHarness();
                h.state.ledgerVersion={digest:'v'};
                h.state.reconciliation={rows:[]};
                h.configure({request:async()=>{
                    h.state.positionsTimestamp='2026-09-03T10:01:00';
                    return {executions:[]};
                }});
                await h.fetch({batch:true});
                assert.ok(h.state.importResult,'timestamp-only broadcast must not discard the reply');
                h.state.positionsTimestamp='2026-09-03T10:02:00';
                assert.equal(h.bindingProblem(),'','timestamp-only broadcast must not invalidate preview');
                h.state.reconciliation.rows.push({kind:'option',ledger:0,tws:1});
                assert.match(h.bindingProblem(),/快照已变化/);
            },
        },
        {
            name: 'batch preview reports roundtrip cash even when contract is absent from position rows',
            run() {
                const c=loadPage(), p=c.OptionComboCostBasisPage;
                const fill={kind:'option_trade',source:'execution_report',tag:'ibkr_exec',
                    account:'U1',right:'C',strike:72,expiry:'20261016',sharesPerContract:100,
                    contracts:5,cashAmount:-501,externalRef:'ibkr-exec-round-open'};
                const result={events:[fill,{...fill,contracts:-5,cashAmount:249,
                    externalRef:'ibkr-exec-round-close'}],problems:[]};
                for(const targets of [[],[{...fill,kind:'option',ledger:0,tws:0,difference:0}]]) {
                    const plan=p.planBatchExecutionReconciliation(targets,result,[],[]);
                    assert.equal(plan.events.length,0);
                    assert.equal(plan.skipped.length,1);
                    assert.match(plan.skipped[0].reason,/拉取 TWS 成交/);
                    assert.match(plan.skipped[0].reason,/-252/);
                }
            },
        },
        {
            name: 'batch preview lists stock round trips and unreadable executions instead of dropping them',
            run() {
                const c=loadPage(), p=c.OptionComboCostBasisPage;
                const share={kind:'share_trade',source:'execution_report',tag:'ibkr_exec',account:'U1',
                    shares:100,cashAmount:-5001,externalRef:'ibkr-exec-share-buy'};
                const plan=p.planBatchExecutionReconciliation([],{events:[share,{...share,shares:-100,
                    cashAmount:4899,externalRef:'ibkr-exec-share-sell'}],problems:[]},[],[]);
                assert.equal(plan.events.length,0,'the batch never writes stock fills');
                assert.equal(plan.skipped.length,1);
                assert.equal(plan.skipped[0].label,'股票');
                assert.match(plan.skipped[0].reason,/净现金 -102\.00/);
                // A flat option round trip whose commission is still pending never
                // became an event; it must still be named in the preview.
                const executions=[
                    {account:'U1',symbol:'TQQQ',secType:'OPT',execId:'rt-buy'},
                    {account:'U1',symbol:'TQQQ',secType:'OPT',execId:'rt-sell'},
                    {account:'U1',symbol:'QQQ',secType:'OPT',execId:'other-book'}];
                const problems=executions.map((row,i)=>({lineNumber:i+1,
                    reason:`成交 ${row.execId} 的佣金回报尚未到齐`,raw:row.execId}));
                const pending=p.planBatchExecutionReconciliation([],{events:[],problems},[],executions,
                    {account:'U1',symbol:'TQQQ'});
                assert.deepEqual(Array.from(pending.skipped,(item)=>item.label),['rt-buy','rt-sell'],
                    'another underlying stays out of this book');
                assert.ok(pending.skipped.every((item)=>/本次未写入/.test(item.reason)));
                // Problems a skipped target already names are not listed twice.
                const target={kind:'option',key:'k',label:'C72',account:'U1',right:'C',strike:72,
                    expiry:'20261016',sharesPerContract:100,ledger:0,tws:5,difference:5};
                const once=p.planBatchExecutionReconciliation([target],{events:[],problems:[
                    {lineNumber:0,reason:'unknown identity'}]},[],[],{account:'U1',symbol:'TQQQ'});
                assert.equal(once.skipped.length,1);
                assert.match(once.skipped[0].reason,/unknown identity/);
            },
        },
        {
            name: 'batch lookup discards replies after book, ledger, or snapshot changes',
            async run() {
                for(const mutation of [h=>{h.state.bookId='other';},
                    h=>{h.state.ledgerVersion={digest:'changed'};},
                    h=>{h.state.positionsConnected=false;},
                    h=>{h.state.reconciliation.rows.push({kind:'option',ledger:1,tws:2});}]) {
                    const h=loadReconciliationHarness();
                    h.state.ledgerVersion={digest:'before'};
                    h.state.reconciliation={rows:[]};
                    h.configure({request:async()=>{mutation(h);return {executions:[]};}});
                    await h.fetch({batch:true});
                    assert.equal(h.state.importResult,null);
                    assert.equal(h.state.executionFetchPending,false);
                }
                const h=loadReconciliationHarness();
                h.state.ledgerVersion={digest:'v'};
                h.state.importResult={binding:{bookId:'book-test',generation:h.state.importGeneration,
                    mode:'append',ledgerVersion:'v'},batchReconciliation:{snapshotTimestamp:h.state.positionsTimestamp}};
                assert.equal(h.bindingProblem(),'');
                h.state.positionsTimestamp='new';
                assert.equal(h.bindingProblem(),'');
                h.state.positionsConnected=false;
                assert.match(h.bindingProblem(),/快照已变化/);
            },
        },
        {
            name: 'batch planner keeps rebates and complete sequences, rejects ambiguous or unbacked histories',
            run() {
                const c=loadPage(), p=c.OptionComboCostBasisPage, core=c.OptionComboCostBasisCore;
                const fill={account:'U1',kind:'option_trade',right:'P',strike:70,
                    expiry:'20261016',sharesPerContract:100,contracts:-2,price:1,cashAmount:200,
                    tradeDate:'2026-09-03',brokerTimestamp:'2026-09-03T10:00:00',
                    source:'execution_report',tag:'ibkr_exec',externalRef:'ibkr-exec-one'};
                const target={...fill,kind:'option',key:core.contractKey(fill),label:'P70',
                    ledger:0,tws:-2,difference:-2};
                const rebate={...fill,kind:'fee',tag:'ibkr_rebate',
                    externalRef:'ibkr-exec-one-rebate',cashAmount:0.25};
                const result={events:[fill,rebate],problems:[]};
                let plan=p.planBatchExecutionReconciliation([target],result,[],[]);
                assert.equal(plan.events.length,2);
                assert.equal(plan.events.reduce((s,e)=>s+e.cashAmount,0),200.25);
                plan=p.planBatchExecutionReconciliation([target,{...target,key:'alias'}],result,[],[]);
                assert.equal(plan.events.length,0);
                assert.equal(plan.skipped.length,2);
                plan=p.planBatchExecutionReconciliation([target],{...result,
                    problems:[{lineNumber:0,reason:'unknown identity'}]},[],[]);
                assert.equal(plan.events.length,0);
                const extra={...fill,externalRef:'ibkr-exec-extra',contracts:1};
                plan=p.planBatchExecutionReconciliation([target],{events:[fill,extra],problems:[]},[],[]);
                assert.equal(plan.events.length,0,'no cherry picking a matching subset');
                plan=p.planBatchExecutionReconciliation([{...target,identityConflict:true}],result,[],[]);
                assert.equal(plan.events.length,0);
                const close={...fill,contracts:2};
                plan=p.planBatchExecutionReconciliation([{...target,ledger:-2,tws:0,difference:2}],
                    {events:[close],problems:[]},[],[]);
                assert.equal(plan.events.length,0,'a claimed ledger amount cannot replace missing opening history');
            },
        },
        {
            name: 'seeded multi-contract batch histories preserve exact cash, baseline replacement and isolation',
            run() {
                const c=loadPage(), p=c.OptionComboCostBasisPage, core=c.OptionComboCostBasisCore;
                let seed=22092026;
                const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
                for(let trial=0;trial<300;trial++) {
                    const events=[],history=[],targets=[];
                    const count=2+Math.floor(random()*12);
                    for(let i=0;i<count;i++) {
                        const quantity=2+Math.floor(random()*5), sign=random()<0.5?-1:1;
                        const base={account:'U1',right:i%2?'C':'P',strike:40+i,
                            expiry:'20261016',sharesPerContract:i%3?100:10,kind:'option_trade',
                            tradeDate:'2026-09-03',price:1.25,fees:0.75};
                        const useBaseline=random()<0.5;
                        if(useBaseline) {const id=`base-${i}`;history.push({...base,
                            eventId:id,contracts:sign,source:'reconcile',tag:'tws_snapshot',cashAmount:999});}
                        const bad=random()<0.25;
                        targets.push({...base,kind:'option',key:core.contractKey(base),label:`leg ${i}`,
                            ledger:useBaseline?sign:0,tws:sign*(quantity+(bad?1:0)),
                            difference:sign*(quantity+(bad?1:0)-(useBaseline?1:0))});
                        for(let j=0;j<quantity;j++) {
                            const event={...base,contracts:sign,source:'execution_report',tag:'ibkr_exec',
                                brokerTimestamp:`2026-09-03T10:${String(j).padStart(2,'0')}:00`,
                                cashAmount:-sign*1.25*base.sharesPerContract-0.75,
                                externalRef:`ibkr-exec-${trial}-${i}-${j}`};
                            events.push(event);
                        }
                    }
                    // A batch must be insensitive to the source response order.
                    events.reverse();
                    const plan=p.planBatchExecutionReconciliation(targets,{events,problems:[]},history,[]);
                    // A partial baseline can legitimately explain one extra unit;
                    // calculate the independent endpoint rule for each full contract.
                    const accepted=targets.filter(t=>{
                        const fills=events.filter(e=>e.strike===t.strike);
                        const net=fills.reduce((n,e)=>n+e.contracts,0);
                        return t.ledger+net===t.tws || (t.ledger!==0 && net===t.tws);
                    });
                    const expectedEvents=events.filter(e=>accepted.some(t=>t.strike===e.strike));
                    assert.equal(plan.matches.length,accepted.length,`seed trial ${trial}`);
                    assert.equal(plan.events.length,expectedEvents.length);
                    assert.equal(plan.events.reduce((n,e)=>n+e.cashAmount,0),
                        expectedEvents.reduce((n,e)=>n+e.cashAmount,0));
                    assert.equal(new Set(plan.events.map(e=>e.externalRef)).size,plan.events.length);
                }
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
                    'js/market_curves.js',
                    'js/cost_basis_stress_models.js',
                    'js/cost_basis_stress_core.js',
                    'js/cost_basis_stress_band.js',
                    'js/cost_basis_stress_worker.js',
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
                assert.match(source, /newBookAccountNotice\(account, state\.managedAccounts\)/);
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
            name: 'the account dropdown offers manual entry while TWS is connected',
            run() {
                const h = loadReconciliationHarness();
                const node = (id) => h.context.document.getElementById(id);
                h.state.connection = 'connected';
                h.state.status = { available: true };
                h.state.managedAccounts = ['U17775528'];
                h.state.managedAccountsConnected = true;
                h.renderAccounts('');
                const select = node('new-book-account');
                const values = select.children.map((option) => option.value);
                // The single live account is still chosen for the common case.
                assert.equal(select.value, 'U17775528');
                assert.ok(values.includes('U17775528'));
                assert.ok(values.includes('__manual_account__'));
                assert.equal(node('new-book-account-manual').hidden, true);

                // Choosing manual entry opens the field even while connected.
                h.renderAccounts('__manual_account__');
                const manual = node('new-book-account-manual');
                assert.equal(manual.hidden, false);
                assert.equal(manual.disabled, false);
                const hint = node('new-book-account-hint');
                assert.equal(hint.classList.contains('warn'), false);

                // A remote account is allowed, and says what it gives up.
                manual.value = 'u9999999';
                h.accountHint();
                assert.match(hint.textContent, /U9999999/);
                assert.equal(hint.classList.contains('warn'), true);

                // Typing a live account back is not a mismatch.
                manual.value = 'U17775528';
                h.accountHint();
                assert.equal(hint.classList.contains('warn'), false);
            },
        },
        {
            name: 'a book can be kept for an account this TWS does not report',
            run() {
                const context = loadPage();
                const page = context.OptionComboCostBasisPage;
                const source = readScript();
                const live = ['U1777552'];
                // Accounts traded on another machine are booked here anyway;
                // only the local position matching is given up.
                const notice = page.newBookAccountNotice('u9999999', live);
                assert.match(notice, /U9999999/);
                assert.match(notice, /行情/);
                assert.equal(page.newBookAccountNotice('u1777552', live), '');
                assert.equal(page.newBookAccountNotice('', live), '');
                // Nothing to check against is not a mismatch.
                assert.equal(page.newBookAccountNotice('U9999999', []), '');
                // The manual option is offered whether or not TWS answered,
                // and a mismatch only asks for a confirmation.
                assert.doesNotMatch(source,
                    /if \(!hasLiveAccounts\) \{\s*const manualOption/);
                assert.match(source, /accountNotice && !globalScope\.confirm/);
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
                assert.match(source, /'确认导入成交'/);
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
            name: 'a CSV order row aliases the run of TWS partial fills it aggregates',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const base = {
                    kind: 'option_trade', tradeDate: '2026-09-08', account: 'U1',
                    right: 'P', strike: 72, expiry: '20260918', sharesPerContract: 100,
                    conId: 123, source: 'execution_report', tag: 'ibkr_exec',
                };
                const fills = [
                    Object.assign({}, base, { eventId: 'f1', externalRef: 'ibkr-exec-E1',
                        brokerTimestamp: '2026-09-08T10:00:00', contracts: -3,
                        price: 1.01, fees: 1.95, cashAmount: 301.05 }),
                    Object.assign({}, base, { eventId: 'f2', externalRef: 'ibkr-exec-E2',
                        brokerTimestamp: '2026-09-08T10:00:07', contracts: -5,
                        price: 1.02, fees: 3.25, cashAmount: 506.75 }),
                    Object.assign({}, base, { eventId: 'f3', externalRef: 'ibkr-exec-E3',
                        brokerTimestamp: '2026-09-08T10:01:30', contracts: -2,
                        price: 1.03, fees: 1.30, cashAmount: 204.70 }),
                ];
                // The statement prints one Order line: 10 contracts at the
                // size-weighted average (1.021) rounded to its display
                // precision, with the summed commission, at the first fill's second.
                const orderRow = Object.assign({}, base, {
                    source: 'csv_import', tag: 'ibkr_open', externalRef: 'stmt-order',
                    brokerTimestamp: '2026-09-08T10:00:00', contracts: -10,
                    price: 1.02, fees: 6.5, cashAmount: 1012.5, lineNumber: 9,
                });
                const plan = page.planExecutionReportAliases({
                    format: 'activity', events: [orderRow],
                }, fills);
                assert.equal(plan.problems.length, 0);
                assert.equal(plan.matched.length, 1);
                assert.equal(plan.matched[0].executions.length, 3);
                assert.equal(plan.aliases['U1\u0000stmt-order'], 'ibkr-exec-E1');

                // The Order line may also print the last fill's second.
                const lastSecond = page.planExecutionReportAliases({
                    format: 'activity', events: [Object.assign({}, orderRow, {
                        brokerTimestamp: '2026-09-08T10:01:30',
                    })],
                }, fills);
                assert.equal(lastSecond.problems.length, 0);
                assert.equal(lastSecond.matched[0].executions.length, 3);

                // Same quantity but the summed cash disagrees: blocked, not guessed.
                const cashOff = page.planExecutionReportAliases({
                    format: 'activity', events: [Object.assign({}, orderRow, {
                        cashAmount: 1012.0,
                    })],
                }, fills);
                assert.equal(cashOff.matched.length, 0);
                assert.equal(cashOff.problems.length, 1);
                assert.match(cashOff.problems[0].reason, /spans 3 stored TWS fills/);

                // A quantity no run of fills reaches keeps the old exact-second blocker.
                const noRun = page.planExecutionReportAliases({
                    format: 'activity', events: [Object.assign({}, orderRow, {
                        contracts: -9, cashAmount: 911.25,
                    })],
                }, fills);
                assert.equal(noRun.matched.length, 0);
                assert.match(noRun.problems[0].reason, /quantity, price, or net cash differs/);
            },
        },
        {
            name: 'two orders on one contract each claim their own fills in time order',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const base = {
                    kind: 'share_trade', tradeDate: '2026-09-08', account: 'U1',
                    source: 'execution_report', tag: 'ibkr_exec',
                };
                const fills = [
                    Object.assign({}, base, { eventId: 'a1', externalRef: 'ibkr-exec-A1',
                        brokerTimestamp: '2026-09-08T09:35:00', shares: 100,
                        price: 45, fees: 0.5, cashAmount: -4500.5 }),
                    Object.assign({}, base, { eventId: 'a2', externalRef: 'ibkr-exec-A2',
                        brokerTimestamp: '2026-09-08T09:35:02', shares: 200,
                        price: 45, fees: 0.5, cashAmount: -9000.5 }),
                    Object.assign({}, base, { eventId: 'b1', externalRef: 'ibkr-exec-B1',
                        brokerTimestamp: '2026-09-08T14:10:00', shares: 300,
                        price: 44, fees: 1, cashAmount: -13201 }),
                ];
                const orderA = Object.assign({}, base, {
                    source: 'csv_import', tag: 'ibkr_open', externalRef: 'stmt-a',
                    brokerTimestamp: '2026-09-08T09:35:00', shares: 300,
                    price: 45, fees: 1, cashAmount: -13501, lineNumber: 3,
                });
                const orderB = Object.assign({}, base, {
                    source: 'csv_import', tag: 'ibkr_open', externalRef: 'stmt-b',
                    brokerTimestamp: '2026-09-08T14:10:00', shares: 300,
                    price: 44, fees: 1, cashAmount: -13201, lineNumber: 4,
                });
                // Later order listed first in the file: time order still wins.
                const plan = page.planExecutionReportAliases({
                    format: 'activity', events: [orderB, orderA],
                }, fills);
                assert.equal(plan.problems.length, 0);
                assert.equal(plan.aliases['U1\u0000stmt-a'], 'ibkr-exec-A1');
                assert.equal(plan.aliases['U1\u0000stmt-b'], 'ibkr-exec-B1');
                assert.equal(plan.matched.map(
                    (item) => item.executions.length).sort().join(','), '1,2');

                // Two different runs of equal size that both touch the order's
                // second are ambiguous and block instead of picking one.
                const twin = fills.concat([
                    Object.assign({}, base, { eventId: 'a0', externalRef: 'ibkr-exec-A0',
                        brokerTimestamp: '2026-09-08T09:34:58', shares: 200,
                        price: 45, fees: 0.5, cashAmount: -9000.5 }),
                ]);
                const ambiguous = page.planExecutionReportAliases({
                    format: 'activity', events: [orderA],
                }, twin);
                assert.equal(ambiguous.matched.length, 0);
                assert.match(ambiguous.problems[0].reason, /more than one group/);
            },
        },
        {
            name: 'a TWS fill dated one day away from the CSV row blocks with a timezone hint',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const stored = {
                    eventId: 'api-fill-1', kind: 'option_trade',
                    tradeDate: '2026-09-09', brokerTimestamp: '2026-09-09T03:30:00',
                    account: 'U1', right: 'P', strike: 72, expiry: '20260918',
                    contracts: -1, sharesPerContract: 100, conId: 123,
                    price: 1.01, cashAmount: 100.44, fees: 0.56,
                    source: 'execution_report', tag: 'ibkr_exec',
                    externalRef: 'ibkr-exec-E1',
                };
                // The statement prints the same fill in New York time, on the
                // previous calendar day.
                const csvEvent = Object.assign({}, stored, {
                    eventId: undefined, source: 'csv_import', tag: 'ibkr_open',
                    tradeDate: '2026-09-08', brokerTimestamp: '2026-09-08T15:30:00',
                    externalRef: 'stmt-shifted', lineNumber: 4,
                });
                const plan = page.planExecutionReportAliases({
                    format: 'activity', events: [csvEvent],
                }, [stored]);
                assert.equal(plan.matched.length, 0);
                assert.equal(plan.problems.length, 1);
                assert.match(plan.problems[0].reason, /one day away/);
                assert.match(plan.problems[0].reason, /\[tws\] timezone/);

                // Two days apart is a different trade, not a clock skew.
                const farApart = page.planExecutionReportAliases({
                    format: 'activity', events: [Object.assign({}, csvEvent, {
                        tradeDate: '2026-09-07', brokerTimestamp: '2026-09-07T15:30:00',
                    })],
                }, [stored]);
                assert.equal(farApart.problems.length, 0);

                // A different contract on the adjacent day is not a candidate either.
                const otherContract = page.planExecutionReportAliases({
                    format: 'activity', events: [Object.assign({}, csvEvent, { strike: 70 })],
                }, [stored]);
                assert.equal(otherContract.problems.length, 0);
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
            name: 'stress valuation is delegated to the independent canonical kernel',
            run() {
                const source = readScript();
                assert.match(source, /OptionComboCostBasisStressCore.buildStressTestSeries/);
                assert.doesNotMatch(source, /function _estimateDeferredOptions|function calculateBsmOptionPrice/);
                const models = fs.readFileSync(path.join(PROJECT_ROOT, 'js/cost_basis_stress_models.js'), 'utf8');
                assert.doesNotMatch(models, /computeOptionSettlementScenario|estimateDeferredLongOptions|estimateLinkedLongOptions/);
            },
        },
        {
            name: 'stress range and basis controls are distinct from the ledger cost selector',
            run() {
                const html = readPage();
                for (const id of ['stress-pnl-basis', 'stress-path', 'stress-band-enabled', 'stress-band-flat-iv',
                    'stress-own-iv-beta', 'stress-band-status', 'stress-tooltip-band']) assert.ok(html.includes('id="' + id + '"'));
                assert.match(readScript(), /generation !== stressJob.generation/);
                assert.match(readScript(), /worker.terminate/);
                assert.match(readScript(), /_setConnection\('disconnected'\);\s*_invalidateStressScenarioInputs\(\);\s*_renderStressTest\(\)/);
                assert.match(readScript(), /if \(data.ibConnected === false\) _invalidateStressScenarioInputs\(\)/);
            },
        },
        {
            name: 'stress cost axis, cards and tooltip describe scenario settlement, not a constant reference',
            run() {
                const html = readPage();
                const source = readScript();
                assert.match(html, /class="legend-cost">情景结算后成本 \/ 股（右轴）/);
                assert.match(html, /<dt>情景结算后成本 \/ 股<\/dt><dd id="stress-tooltip-cost">/);
                assert.match(source, /情景结算后每股成本 \$\{point.cost/);
                assert.match(source, /d: pathFor\('cost', yCost\)/);
                assert.doesNotMatch(source, /当前账本每股成本|当前成本线仅作账本参考/);
            },
        },
        {
            name: 'worker generations discard superseded and closed jobs and reuse only identical inputs',
            run() {
                const h = loadReconciliationHarness();
                h.silenceStressRender();
                const workers = [];
                h.context.Worker = class {
                    constructor() { workers.push(this); }
                    postMessage(message) { this.message = message; }
                    terminate() { this.terminated = true; }
                };
                h.context.document.querySelectorAll = () => [
                    { src: 'http://localhost/js/cost_basis_stress_worker.js?v=hash' },
                ];
                h.state.stressOpen = true;
                const events = [{ kind: 'opening_balance', account: 'U1', tradeDate: '2026-01-01',
                    shares: 100, cashAmount: -10000, price: 100 }];
                const options = { centerPrice: 100, asOfInstant: '2026-09-08T16:00:00Z',
                    targetInstant: '2026-09-08T16:00:00Z', throughExpiry: '20260908' };
                const first = h.stressSeries(events, options);
                assert.equal(h.stressSeries(events, options), first);
                assert.equal(workers.length, 1);
                const second = h.stressSeries(events, {...options, rangePct: 50});
                assert.equal(workers[0].terminated, true);
                workers[0].onmessage({data: {generation: workers[0].message.generation,
                    band: {available: true, members: [], points: []}}});
                assert.equal(second.band, undefined);
                workers[1].onmessage({data: {generation: workers[1].message.generation,
                    band: {available: true, members: [], points: []}}});
                assert.equal(second.band.available, true);
                h.cancelStressJob();
                assert.equal(h.stressJob.series, null);
                workers[1].onmessage({data: {generation: workers[1].message.generation, band: {available: true}}});
                assert.equal(h.stressJob.series, null);
            },
        },
        {
            name: 'American pricing and quote side diagnostics remain public pure helpers',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                assert.ok(Math.abs(page.calculateBsmPutPrice(100, 100, 1, 0.05, 0.2) - 5.5735) < 0.001);
                assert.equal(page.priceScenarioOption('P', 0, 100, 1, 0.05, 0.2, {pricingModel: 'american'}), 100);
                assert.equal(page.liquidationHaircut({mark: 10, bid: 9, ask: 11}, 'long', 'bidask'), 0.9);
                assert.equal(page.liquidationHaircut({mark: 10, bid: 9, ask: 11}, 'short', 'bidask'), 1.1);
                assert.equal(page.bidAskProblem({bid: 12, ask: 11}), 'crossed');
            },
        },
        {
            name: 'horizon slider and exact input share frozen paired quotes and cancel stale estimates',
            run() {
                const { h, quote } = loadStressPairHarness();
                h.state.stressOpen = true;
                h.state.stressLongOptionInputs = { ...quote('book-test'), snapshotId: 'own-frozen' };
                h.state.stressLinkedInputs = { ...quote('book-qqq'), snapshotId: 'linked-frozen' };
                const original = JSON.stringify([h.state.stressLongOptionInputs, h.state.stressLinkedInputs]);
                const jobs = new Map(); let next = 0, requests = 0, terminated = 0;
                h.context.setTimeout = (fn, delay) => { jobs.set(++next, { fn, delay }); return next; };
                h.context.clearTimeout = id => jobs.delete(id);
                h.configure({ request: () => { requests++; return Promise.resolve({}); } });
                h.silenceStressRender();
                h.stressJob.worker = { terminate() { terminated++; } };
                h.node('stress-chart').appendChild(h.context.document.createElement('path'));
                h.node('stress-slice').hidden = false;
                h.setHorizon('2', true);
                h.setHorizon('20', true);
                assert.equal(jobs.size, 1);
                assert.equal([...jobs.values()][0].delay, 100);
                assert.equal(terminated, 1);
                assert.equal(h.node('stress-horizon-days').value, '20');
                assert.equal(h.node('stress-horizon-slider').value, '20');
                assert.equal(h.node('stress-horizon-value').textContent, '20 天后');
                assert.equal(h.node('stress-chart').children.length, 0);
                assert.equal(h.node('stress-slice').hidden, true);
                h.applyHorizon();
                assert.equal(requests, 0);
                assert.equal(jobs.size, 0);
                assert.equal(JSON.stringify([h.state.stressLongOptionInputs, h.state.stressLinkedInputs]), original);
                assert.equal(h.frozenBatch().throughExpiry, '20260904');
                h.setHorizon('730');
                assert.equal(h.node('stress-horizon-slider').max, '730');
                h.setHorizon('0', true);
                assert.equal(h.node('stress-horizon-value').textContent, '现在 · 0 天');
                h.setHorizon('1.5');
                assert.equal(h.node('stress-horizon-value').textContent, '天数无效');
                assert.equal(h.scenarioDate().error, 'invalid_horizon');
                h.setHorizon('');
                assert.equal(h.state.stressHorizonDays, null);
                assert.match(h.node('stress-horizon-value').textContent, /同到期范围/);
                h.teardownStress();
                assert.equal(jobs.size, 0);
            },
        },
        {
            name: 'incomplete or mismatched quote batches cannot be reused by the horizon slider',
            run() {
                const { h, quote } = loadStressPairHarness();
                h.context.setTimeout = () => 1; h.context.clearTimeout = () => {};
                h.state.stressLongOptionInputs = { ...quote('book-test'), snapshotId: 'own' };
                h.state.stressLinkedInputs = { ...quote('book-qqq'), snapshotId: 'linked' };
                h.state.stressLinkedInputs.throughExpiry = '20260905';
                assert.equal(h.frozenBatch(), null);
                h.state.stressLinkedInputs.throughExpiry = '20260904';
                h.state.stressLinkedInputs.discountCurve = null;
                assert.equal(h.frozenBatch(), null);
                h.setHorizon('10', true);
                assert.equal(h.state.stressLongOptionInputs, null);
                assert.equal(h.state.stressLinkedInputs, null);
                assert.equal(h.node('stress-tooltip').hidden, true);
            },
        },
        {
            name: 'range cards put the full portfolio envelope ahead of the reference number',
            run() {
                const h = loadPriceHarness();
                const p = { price: 100, changePct: 0, headlinePnl: 100, cost: null, shares: 200 };
                const series = { symbol: 'TQQQ', centerPrice: 100, points: [p],
                    band: { available: true, points: [{ price: 100, lower: -200, upper: 300 }] } };
                h.renderStressCards(series, 'USD');
                let card = h.node('stress-key-points').children[0];
                assert.match(card.children[1].textContent, /估值范围 -\$200\.00 ～ \+\$300\.00/);
                assert.equal(card.children[1].className, undefined, 'a range spanning zero is not styled as a gain');
                assert.match(card.children[2].textContent, /参考情景合计 \+\$100\.00/);
                series.band.points[0] = { price: 100, lower: 100, upper: 100 };
                h.renderStressCards(series, 'USD');
                card = h.node('stress-key-points').children[0];
                assert.ok(card.children.some(n => /不代表实际估值没有不确定性/.test(n.textContent)));
                delete series.band;
                h.renderStressCards(series, 'USD');
                assert.match(h.node('stress-key-points').children[0].children[1].textContent, /参考情景/);
                const html = readPage();
                assert.match(html, /id="stress-horizon-slider" type="range"/);
                assert.match(html, /不保证覆盖所有 Skew/);
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
            name: 'enabling or re-enabling cached protection replaces the old main snapshot with a concurrent pair',
            async run() {
                const { h, pending, quote, compile } = loadStressPairHarness();
                h.state.stressLongOptionInputs = quote('book-test', '2026-09-03T12:00:00Z');
                h.state.stressLinkedInputs = quote('book-qqq');
                assert.equal(compile().reason, 'snapshot_time_mismatch');
                const refresh = h.ensureLinked(false);
                assert.deepEqual(pending.map(p => p.fields.bookId), ['book-test', 'book-qqq']);
                assert.equal(h.state.stressLongOptionInputs, null);
                assert.equal(h.state.stressLinkedInputs, null);
                assert.equal(h.stressRefreshJob.pending, true);
                pending[0].resolve(quote('book-test'));
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(h.stressRefreshJob.pending, true, 'do not publish a half-pair');
                pending[1].resolve(quote('book-qqq', '2026-09-03T14:00:01Z'));
                await refresh;
                assert.equal(h.stressRefreshJob.pending, false);
                assert.equal(compile().available, true, compile().reason);
                const again = h.ensureLinked(false); // Both cached; still refresh both.
                assert.equal(pending.length, 4);
                pending[2].resolve(quote('book-test')); pending[3].resolve(quote('book-qqq'));
                await again;
            },
        },
        {
            name: 'paired refresh resolves linked history before starting either quote and rejects superseded loads',
            async run() {
                const { h, pending, quote, events } = loadStressPairHarness();
                h.state.stressLinkedLedger = null;
                const first = h.refreshStressPair(false);
                assert.equal(pending.length, 1);
                assert.equal(pending[0].action, 'list_cost_basis_events');
                const second = h.refreshStressPair(false);
                pending[0].resolve({ events, total: events.length }); await first;
                assert.equal(pending.length, 2, 'obsolete load must not launch old quotes');
                assert.equal(h.stressRefreshJob.pending, true);
                pending[1].resolve({ events, total: events.length });
                await new Promise(resolve => setImmediate(resolve));
                assert.deepEqual(pending.slice(2).map(p => p.fields.bookId), ['book-test', 'book-qqq']);
                pending[2].resolve(quote('book-test')); pending[3].resolve(quote('book-qqq'));
                await second;
                assert.equal(h.stressRefreshJob.pending, false);
            },
        },
        {
            name: 'superseded, disabled and disconnected paired quotes cannot revive an old overlay',
            async run() {
                const { h, pending, quote } = loadStressPairHarness();
                const first = h.refreshStressPair(false);
                const second = h.refreshStressPair(false);
                pending[0].resolve(quote('book-test', '2026-09-03T12:00:00Z'));
                pending[1].reject(new Error('old request failed')); await first;
                assert.equal(h.stressRefreshJob.pending, true);
                assert.equal(h.state.stressLongOptionInputs, null);
                assert.equal(h.state.stressLinkedInputsError, '');
                h.state.stressIncludeLinkedHedge = false;
                h.invalidateScenario();
                pending[2].resolve(quote('book-test')); pending[3].resolve(quote('book-qqq')); await second;
                assert.equal(h.stressRefreshJob.pending, false);
                assert.equal(h.state.stressLinkedInputs, null);
                h.state.stressIncludeLinkedHedge = true;
                const third = h.refreshStressPair(false);
                h.state.ws = {}; h.invalidateScenario();
                pending[4].resolve(quote('book-test')); pending[5].resolve(quote('book-qqq')); await third;
                assert.equal(h.state.stressLongOptionInputs, null);
                assert.equal(h.state.stressLinkedInputs, null);
            },
        },
        {
            name: 'a failed half of a refresh never reuses old quotes or relaxes the time-skew gate',
            async run() {
                const { h, pending, quote, compile } = loadStressPairHarness();
                h.state.stressLinkedInputs = quote('book-qqq');
                const refresh = h.refreshStressPair(false);
                pending[0].resolve(quote('book-test')); pending[1].reject(new Error('missing linked feed'));
                await refresh;
                assert.equal(h.state.stressLinkedInputs, null);
                assert.equal(h.stressRefreshJob.pending, false);
                assert.equal(compile().available, false);
                assert.match(h.state.stressLinkedInputsError, /missing linked feed/);
                const retry = h.refreshStressPair(false);
                pending[2].resolve(quote('book-test'));
                pending[3].resolve(quote('book-qqq', '2026-09-03T14:02:00Z'));
                await retry;
                assert.equal(compile().reason, 'snapshot_time_mismatch');
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
                    ivTenorExponent: 0.4, ivBetaAuto: false, ivOtmDiscount: false,
                });
                assert.equal(remembered.ivTenorExponent, 0.4);
                assert.equal(remembered.ivBetaAuto, false);
                assert.equal(remembered.ivOtmDiscount, false);
                assert.equal(remembered.sigmaCrashScale, true);
                assert.equal(seeded.ivBetaAuto, true);
                assert.equal(seeded.ivOtmDiscount, true);
                assert.equal(seeded.sigmaCrashScale, true);
                assert.equal(seeded.ivTenorExponent, 0.65);
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
                h.state.ledger = core.computeLedger(h.state.allEvents, { referencePrice: 70, secType: 'STK' });
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
                h.state.stressPnlBasis = 'cost';
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
                    'request_cost_basis_option_scenario_inputs',
                ]);
                assert.equal(calls[0].fields.bookId, 'book-qqq');
                assert.equal(calls[1].fields.bookId, 'book-test');
                assert.equal(calls[2].fields.bookId, 'book-qqq');
                assert.equal(calls[2].fields.throughExpiry, '20260904');
                // Every long contract alive today is quoted: its mark is the
                // reference the scenario value is measured against.
                assert.equal(calls[2].fields.contracts.map((item) => (
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
                assert.match(h.node('stress-status').textContent, /快照版本过旧/);
                assert.equal(h.node('stress-chart').children.length, 0);
                // New snapshot metadata is required; old fixtures must not quietly
                // reuse a future-tenor rate as the current calibration rate.
                Object.assign(h.state.stressLinkedInputs, {
                    snapshotVersion: 2,
                    discountCurve: { schemaVersion: 2, currency: 'USD', effectiveDate: '2026-09-02',
                        curveAsOf: '2026-09-02', points: [{tenorDays: 1, zeroRate: 0.035},
                            {tenorDays: 180, zeroRate: 0.035}, {tenorDays: 365, zeroRate: 0.035}] },
                });
                Object.assign(h.state.stressLongOptionInputs, {
                    snapshotVersion: 2, discountCurve: h.state.stressLinkedInputs.discountCurve,
                });
                h.state.stressIncludeLongOptions = false;
                h.renderStress();
                assert.match(h.node('stress-status').textContent, /混合口径/);
                assert.equal(h.node('stress-key-points').children.length, 3);
                assert.match(h.node('stress-own-note').textContent, /反解逐合约本地 IV/);
                h.state.stressLinkedIvMode = 'fixed'; h.renderStress();
                assert.equal(h.node('stress-linked-iv-otm-field').hidden, true);
                h.state.stressLinkedIvMode = 'beta'; h.renderStress();
                assert.equal(h.node('stress-linked-iv-otm-field').hidden, false);
                assert.equal(JSON.stringify(h.state.allEvents), mainEventsBefore);
                assert.equal(JSON.stringify(h.state.ledger), mainLedgerBefore);
                calls.length = 0;
                h.state.stressExpiry = '20270115'; h.state.stressLinkedInputs = null;
                await h.ensureLinked(false);
                assert.deepEqual(calls.map(call => call.action), ['request_cost_basis_option_scenario_inputs',
                    'request_cost_basis_option_scenario_inputs']);
                assert.equal(calls[0].fields.throughExpiry, '20270115');
                assert.equal(h.state.bookId, 'book-test');
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
            name: 'the cash card combines after-tax dividends with realized stock P&L',
            run() {
                const html = readPage();
                const source = readScript();
                assert.match(html, /税后股息 \+ 股票已实现盈亏/);
                assert.match(source,
                    /netDividends \+ Number\(summary\.stockRealizedPnl \|\| 0\)/);
                assert.match(source, /税后股息 \$\{_signedMoney\(netDividends\)\}/);
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
                assert.match(html, /显示已冲销记录/);
                assert.match(source, /button\.textContent = '冲销'/);
                assert.match(source, /request\('void_cost_basis_event'/);
                assert.match(source, /原行保留为可审计记录/);
                // The wording must say what a void does NOT do: re-importing
                // the same statement row will not bring it back.
                assert.match(source, /重新导入同一份报表不会把它加回来/);
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
                    /function _invalidatePositions\(\)[\s\S]{0,700}_renderReconciliation\(\)/);
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
        {
            name: 'the stress test is a page view: showView switches the three views and the topbar',
            run() {
                const h = loadPriceHarness(); h.silenceStressRender();
                const doc = h.context.document;
                h.showView('stress');
                assert.equal(h.state.activeView, 'stress');
                assert.equal(doc.getElementById('stress-view').hidden, false);
                assert.equal(doc.getElementById('ledger-view').hidden, true);
                assert.equal(doc.getElementById('settings-view').hidden, true);
                assert.equal(doc.getElementById('page-eyebrow').textContent, 'What If · 多价格情景');
                assert.equal(doc.getElementById('page-title').textContent, 'U1 / TQQQ · 到期压力测试');
                assert.equal(doc.getElementById('btn-open-stress-view').classList.contains('active'), true);
                h.showView('ledger');
                assert.equal(h.state.activeView, 'ledger');
                assert.equal(doc.getElementById('stress-view').hidden, true);
                assert.equal(doc.getElementById('ledger-view').hidden, false);
                assert.equal(doc.getElementById('page-title').textContent, 'U1 / TQQQ');
                assert.equal(doc.getElementById('btn-open-stress-view').classList.contains('active'), false);
                h.showView('settings');
                assert.equal(doc.getElementById('settings-view').hidden, false);
                assert.equal(doc.getElementById('stress-view').hidden, true);
            },
        },
        {
            name: 'opening the stress test enters the view; closing returns to the ledger and drops late worker results',
            run() {
                const h = loadPriceHarness(); h.silenceStressRender();
                const doc = h.context.document;
                const workers = [];
                h.context.Worker = class {
                    constructor() { workers.push(this); }
                    postMessage(message) { this.message = message; }
                    terminate() { this.terminated = true; }
                };
                doc.querySelectorAll = () => [{ src: 'http://localhost/js/cost_basis_stress_worker.js?v=hash' }];
                h.configure({ request: () => new Promise(() => {}) });
                doc.body.classList.add('sidebar-open');
                h.state.ledger = null;
                h.openStress();
                assert.equal(h.state.stressOpen, false, 'no ledger: nothing opens');
                assert.equal(h.state.activeView, 'ledger');
                h.state.ledger = h.context.OptionComboCostBasisCore.computeLedger(h.state.allEvents);
                h.openStress();
                assert.equal(h.state.stressOpen, true);
                assert.equal(h.state.activeView, 'stress');
                assert.equal(doc.body.classList.contains('sidebar-open'), false);
                assert.equal(doc.activeElement, doc.getElementById('stress-title'));
                assert.equal(doc.activeElement.focusOptions.preventScroll, true);
                assert.equal(doc.getElementById('stress-view').scrollOptions.block, 'start');
                assert.match(readPage(), /id="stress-title" tabindex="-1"/);
                const css = fs.readFileSync(path.join(PROJECT_ROOT, 'cost_basis.css'), 'utf8');
                assert.match(css, /\.stress-view \{\s*scroll-margin-top: calc\(78px \+ 1rem\)/);
                assert.equal(h.state.stressHorizonDays, 45);
                const events = [{ kind: 'opening_balance', account: 'U1', tradeDate: '2026-01-01',
                    shares: 100, cashAmount: -10000, price: 100 }];
                const options = { centerPrice: 100, asOfInstant: '2026-09-08T16:00:00Z',
                    targetInstant: '2026-09-08T16:00:00Z', throughExpiry: '20260908' };
                h.stressSeries(events, options);
                assert.equal(workers.length, 1);
                h.closeStress();
                assert.equal(h.state.stressOpen, false);
                assert.equal(h.state.activeView, 'ledger');
                assert.equal(doc.getElementById('stress-view').hidden, true);
                assert.equal(workers[0].terminated, true);
                assert.equal(h.stressJob.series, null);
                assert.equal(doc.activeElement, doc.getElementById('btn-open-stress-test'));
                workers[0].onmessage({ data: { generation: workers[0].message.generation,
                    band: { available: true, members: [], points: [] } } });
                assert.equal(h.stressJob.series, null, 'late band result is dropped');
                h.closeStress();
                assert.equal(h.state.activeView, 'ledger', 'closing twice is harmless');
            },
        },
        {
            name: 'repeated stress navigation preserves the scenario, worker, snapshots and pending refresh',
            run() {
                const h = loadPriceHarness(); h.silenceStressRender();
                h.configure({ request: () => { throw new Error('navigation must not request quotes'); } });
                Object.assign(h.state, { stressOpen: true, activeView: 'stress', stressBasePrice: 65,
                    stressHorizonDays: 10, stressExpiry: '20270319', stressLinkedIvTenorExponent: 0.25 });
                const snapshot = { underlyingPrice: 72 };
                h.state.stressLongOptionInputs = snapshot;
                const worker = { terminate() { throw new Error('navigation must not cancel work'); } };
                h.stressJob.worker = worker;
                h.stressRefreshJob.pending = true;
                const generation = h.stressRefreshJob.generation;
                h.node('stress-linked-group').dataset.manual = '1';
                h.context.document.body.classList.add('sidebar-open');
                h.openStress();
                assert.equal(h.state.stressBasePrice, 65);
                assert.equal(h.state.stressHorizonDays, 10);
                assert.equal(h.state.stressExpiry, '20270319');
                assert.equal(h.state.stressLinkedIvTenorExponent, 0.25);
                assert.equal(h.state.stressLongOptionInputs, snapshot);
                assert.equal(h.stressJob.worker, worker);
                assert.equal(h.stressRefreshJob.pending, true);
                assert.equal(h.stressRefreshJob.generation, generation);
                assert.equal(h.node('stress-linked-group').dataset.manual, '1');
                assert.equal(h.context.document.body.classList.contains('sidebar-open'), false);
                assert.equal(h.node('stress-view').scrollOptions, undefined, 'no unexpected scrolling');
            },
        },
        {
            name: 'same-book event reload redraws settlement results and invalidates old quotes and workers',
            async run() {
                const h = loadPriceHarness(); h.configureEventLoad(); enableStressChartDom(h);
                const events = h.state.allEvents.concat({ kind: 'share_trade', account: 'U1',
                    tradeDate: '2026-09-02', shares: 100, price: 70, cashAmount: -7000 });
                h.configure({ today: () => '2026-09-03', request: async action => {
                    assert.equal(action, 'list_cost_basis_events');
                    return { events, total: events.length };
                } });
                Object.assign(h.state, { stressOpen: true, activeView: 'stress', stressExpiry: '20260904',
                    stressBasePrice: 70, stressIncludeLongOptions: false, stressBandEnabled: false });
                h.renderStress();
                assert.equal(h.stressJob.series.points.at(-1).shares, 200);
                assert.equal(h.stressJob.series.points.at(-1).headlinePnl, 4400);
                const old = h.stressJob.series;
                const worker = { terminate() { this.terminated = true; } };
                h.stressJob.worker = worker;
                h.state.stressLongOptionInputs = { stale: true };
                h.state.stressLinkedInputs = { stale: true };
                await h.loadEvents();
                assert.equal(worker.terminated, true);
                assert.equal(h.state.stressLongOptionInputs, null);
                assert.equal(h.state.stressLinkedInputs, null);
                assert.notEqual(h.stressJob.series, old);
                assert.equal(h.stressJob.series.points.at(-1).shares, 300);
                assert.equal(h.stressJob.series.points.at(-1).headlinePnl, 6500);
                assert.equal(h.state.activeView, 'stress');
                assert.equal(h.state.stressBasePrice, 70);
                assert.equal(h.node('stress-chart').children.length > 0, true);
            },
        },
        {
            name: 'same-book reload refreshes the linked ledger and quotes the newly loaded contracts together',
            async run() {
                const { h, pending, quote, events } = loadStressPairHarness(); h.configureEventLoad(); enableStressChartDom(h);
                h.state.stressOpen = true;
                h.state.stressLongOptionInputs = { stale: true };
                h.state.stressLinkedInputs = { stale: true };
                const updated = h.state.allEvents.concat({ kind: 'option_trade', account: 'U1',
                    tradeDate: '2026-09-02', right: 'P', strike: 60, expiry: '20270319',
                    sharesPerContract: 100, contracts: 1, price: 3, cashAmount: -300 });
                const reload = h.loadEvents();
                pending[0].resolve({ events: updated, total: updated.length }); await reload;
                assert.equal(h.state.stressLongOptionInputs, null);
                assert.equal(h.state.stressLinkedInputs, null);
                assert.equal(h.stressRefreshJob.pending, true);
                assert.equal(pending[1].action, 'list_cost_basis_events');
                assert.equal(pending[1].fields.bookId, 'book-qqq');
                pending[1].resolve({ events, total: events.length });
                await new Promise(resolve => setImmediate(resolve));
                assert.deepEqual(pending.slice(2).map(p => p.fields.bookId), ['book-test', 'book-qqq']);
                assert.ok(pending[2].fields.contracts.some(p => p.strike === 60 && p.expiry === '20270319'));
                assert.ok(pending[3].fields.contracts.some(p => p.strike === 480));
                pending[2].resolve(quote('book-test')); pending[3].resolve(quote('book-qqq'));
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(h.stressRefreshJob.pending, false);
                assert.equal(h.state.stressLinkedMapping, 'linear');
                assert.equal(h.state.stressLinkedRatio, 3);
            },
        },
        {
            name: 'obsolete event reloads cannot invalidate the latest stress results or restart quotes',
            async run() {
                const h = loadPriceHarness(); h.configureEventLoad(); enableStressChartDom(h);
                const pending = [];
                h.configure({ today: () => '2026-09-03', request: (action) => {
                    assert.equal(action, 'list_cost_basis_events');
                    return new Promise(resolve => pending.push(resolve));
                } });
                Object.assign(h.state, { stressOpen: true, stressExpiry: '20260904', stressBasePrice: 70,
                    stressIncludeLongOptions: false, stressBandEnabled: false });
                const events = h.state.allEvents;
                const first = h.loadEvents(), second = h.loadEvents();
                pending[1]({ events, total: events.length }); await second;
                const latest = h.stressJob.series, generation = h.stressJob.generation;
                pending[0]({ events: [], total: 0 });
                assert.equal(await first, false);
                assert.equal(h.stressJob.series, latest);
                assert.equal(h.stressJob.generation, generation);
                assert.equal(h.state.allEvents.length, 2);
            },
        },
        {
            name: 'event reload with no remaining options clears the stress chart without requesting quotes',
            async run() {
                const h = loadPriceHarness(); h.configureEventLoad(); enableStressChartDom(h);
                h.configure({ today: () => '2026-09-03', request: async action => {
                    assert.equal(action, 'list_cost_basis_events');
                    return { events: [], total: 0 };
                } });
                Object.assign(h.state, { stressOpen: true, stressExpiry: '20260904', stressBasePrice: 70,
                    stressIncludeLongOptions: false, stressBandEnabled: false });
                h.renderStress();
                h.state.stressIncludeLongOptions = true;
                await h.loadEvents();
                assert.equal(h.stressJob.series, null);
                assert.equal(h.node('stress-chart').children.length, 0);
                assert.equal(h.node('stress-key-points').children.length, 0);
                assert.equal(h.node('stress-slice').hidden, true);
                assert.match(h.node('stress-status').textContent, /没有可用于压力测试/);
            },
        },
        {
            name: 'leaving the stress view by the settings entry or a book switch tears the job down',
            run() {
                const h = loadPriceHarness(); h.silenceStressRender();
                const doc = h.context.document;
                const workers = [];
                h.context.Worker = class {
                    constructor() { workers.push(this); }
                    postMessage(message) { this.message = message; }
                    terminate() { this.terminated = true; }
                };
                doc.querySelectorAll = () => [{ src: 'http://localhost/js/cost_basis_stress_worker.js?v=hash' }];
                h.configure({ request: () => new Promise(() => {}) });
                const events = [{ kind: 'opening_balance', account: 'U1', tradeDate: '2026-01-01',
                    shares: 100, cashAmount: -10000, price: 100 }];
                const options = { centerPrice: 100, asOfInstant: '2026-09-08T16:00:00Z',
                    targetInstant: '2026-09-08T16:00:00Z', throughExpiry: '20260908' };
                h.openStress();
                h.stressSeries(events, options);
                h.showView('settings');
                assert.equal(h.state.stressOpen, false);
                assert.equal(workers[0].terminated, true);
                assert.equal(h.stressJob.series, null);
                assert.equal(h.state.activeView, 'settings');
                h.showView('ledger');
                h.openStress();
                h.stressSeries(events, options);
                assert.equal(workers.length, 2);
                assert.equal(workers[1].terminated, undefined);
                h.state.books.push({ bookId: 'book-qqq', account: 'U1', symbol: 'QQQ', secType: 'STK' });
                h.selectPriceBook('book-qqq');
                assert.equal(h.state.stressOpen, false);
                assert.equal(h.state.activeView, 'ledger');
                assert.equal(doc.getElementById('stress-view').hidden, true);
                assert.equal(workers[1].terminated, true);
                assert.equal(h.stressJob.series, null);
                workers[1].onmessage({ data: { generation: workers[1].message.generation,
                    band: { available: true, members: [], points: [] } } });
                assert.equal(h.stressJob.series, null);
            },
        },
        {
            name: 'parameter groups follow their master checkbox unless the user toggled them by hand',
            run() {
                const h = loadPriceHarness(); h.silenceStressRender();
                const doc = h.context.document;
                h.configure({ request: () => new Promise(() => {}) });
                const own = doc.getElementById('stress-own-group');
                const linked = doc.getElementById('stress-linked-group');
                h.state.stressIncludeLongOptions = true;
                h.state.stressIncludeLinkedHedge = false;
                h.openStress();
                assert.equal(own.open, true);
                assert.equal(linked.open, false);
                h.setStressGroup('stress-linked-group', true);
                assert.equal(linked.open, true);
                h.setStressGroup('stress-linked-group', false);
                assert.equal(linked.open, false);
                // The user opens the group by hand: unticking no longer closes it.
                linked.open = true;
                h.noteStressGroupToggle({ target: linked });
                assert.equal(linked.dataset.manual, '1');
                h.setStressGroup('stress-linked-group', false);
                assert.equal(linked.open, true);
                // A programmatic change is not a manual toggle.
                h.setStressGroup('stress-own-group', false);
                h.noteStressGroupToggle({ target: own });
                assert.equal(own.dataset.manual, undefined);
                // Re-entering the view resets the manual flags to the checkboxes.
                h.closeStress();
                h.openStress();
                assert.equal(linked.open, false);
                assert.equal(linked.dataset.manual, undefined);
                assert.equal(own.open, true);
            },
        },
        {
            name: 'the sidebar stress entry mirrors the What If button',
            run() {
                const h = loadPriceHarness(); h.silenceStressRender();
                const doc = h.context.document;
                h.renderWhatIf();
                assert.equal(doc.getElementById('btn-open-stress-test').disabled, false);
                assert.equal(doc.getElementById('btn-open-stress-view').disabled, false);
                h.state.ledger = null;
                h.renderWhatIf();
                assert.equal(doc.getElementById('btn-open-stress-test').disabled, true);
                assert.equal(doc.getElementById('btn-open-stress-view').disabled, true);
                const html = readPage();
                assert.match(html, /<button id="btn-open-stress-view" class="nav-item nav-item-stress" type="button" disabled>/);
                assert.match(html, /<p class="nav-label nav-label-system">情景<\/p>\s*<button id="btn-open-stress-view"/);
            },
        },
        {
            name: 'every stress element the page script addresses exists exactly once in the view markup',
            run() {
                const html = readPage();
                const source = readScript();
                const ids = new Set(Array.from(source.matchAll(/\$\('((?:stress-|btn-[a-z-]*stress)[a-z0-9-]*)'\)/g), (m) => m[1]));
                assert.ok(ids.size > 60, `expected many stress ids, got ${ids.size}`);
                const missing = [];
                for (const id of ids) {
                    const count = html.split(`id="${id}"`).length - 1;
                    if (count !== 1) missing.push(`${id}×${count}`);
                }
                assert.deepEqual(missing, []);
                assert.match(html, /<div id="stress-view" class="page-view stress-view" aria-labelledby="stress-title" hidden>/);
                assert.match(html, /<aside class="stress-params"[\s\S]*?<\/aside>\s*<section class="stress-results"/);
                const view = html.slice(html.indexOf('id="stress-view"'), html.indexOf('</main>'));
                for (const id of ['stress-status', 'stress-chart', 'stress-key-points', 'stress-slice']) {
                    assert.ok(view.indexOf(`id="${id}"`) > view.indexOf('class="stress-results"'), `${id} lives in the results column`);
                }
                assert.ok(view.indexOf('id="stress-linked-group"') < view.indexOf('</aside>'));
                assert.doesNotMatch(html, /stress-modal|stress-dialog|stress-close|aria-modal/);
                assert.doesNotMatch(source, /stress-modal/);
            },
        },
        {
            name: 'stress view styles: two sticky columns, stacked below 1360px, no modal shell left',
            run() {
                const css = fs.readFileSync(path.join(PROJECT_ROOT, 'cost_basis.css'), 'utf8');
                assert.doesNotMatch(css, /\.stress-modal|\.stress-dialog|stress-modal-open|\.stress-header|\.stress-close/);
                assert.match(css, /\.stress-view\s*\{[^}]*grid-template-columns:\s*minmax\(300px, 330px\) minmax\(0, 1fr\)/);
                assert.match(css, /\.stress-params\s*\{[^}]*position:\s*sticky/);
                assert.match(css, /\.stress-view-header\s*\{[^}]*grid-column:\s*1 \/ -1/);
                const stacked = css.match(/@media \(max-width: 1360px\)\s*\{([\s\S]*?)\n\}/);
                assert.ok(stacked, 'stacked breakpoint exists');
                assert.match(stacked[1], /\.stress-view \{ grid-template-columns: 1fr; \}/);
                assert.match(stacked[1], /\.stress-results \{ order: 1; \}/);
                assert.match(stacked[1], /\.stress-params \{[^}]*position: static/);
                assert.match(css, /\.stress-chart-wrap \{ position: relative; margin: 0; overflow-x: auto;/);
                assert.match(css, /#stress-chart \{ display: block; width: 100%; min-width: 760px; min-height: 390px;/);
                assert.match(css, /\.nav-item-settings\.active, \.nav-item-stress\.active/);
                // A half-width cell is ~135px: the refresh label must fit or wrap,
                // never push a horizontal scrollbar onto the parameter column.
                assert.match(css, /\.stress-controls button \{[^}]*white-space: normal/);
                assert.match(css, /\.stress-params\s*\{[^}]*overflow: hidden auto/);
                const labels = Array.from(readScript().matchAll(/'拉取中…' : '([^']+)'/g), (m) => m[1]);
                assert.deepEqual(labels, ['刷新 TWS 行情']);
                assert.match(readPage(), /<button id="btn-stress-refresh-price" class="half" type="button" title="[^"]+">刷新 TWS 行情<\/button>/);
            },
        },
        {
            name: 'missing TWS quotes degrade to a labelled settlement-only curve instead of a blank chart',
            run() {
                const h = loadPriceHarness();
                const core = h.context.OptionComboCostBasisCore;
                const doc = h.context.document;
                h.state.status = { features: { optionScenarioInputs: true } };
                h.state.allEvents.push({
                    kind: 'option_trade', account: 'U1', tradeDate: '2026-09-01',
                    right: 'P', strike: 46, expiry: '20270319', sharesPerContract: 100,
                    contracts: 5, price: 3, cashAmount: -1500,
                });
                h.state.ledger = core.computeLedger(h.state.allEvents, { referencePrice: 70, secType: 'STK' });
                Object.assign(h.state, { stressOpen: true, stressExpiry: '20260904', stressBasePrice: 70,
                    stressIncludeLongOptions: true, stressLongOptionInputs: null, stressInputsPending: false,
                    stressInputsError: '拉取失败：TWS 返回的标的现价无效', stressPnlBasis: 'cost' });
                const svgNode = () => ({
                    children: [], textContent: '', style: {}, attributes: {},
                    appendChild(child) { this.children.push(child); return child; },
                    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
                    get firstChild() { return this.children[0]; },
                    setAttribute(name, value) { this.attributes[name] = value; },
                });
                doc.createElementNS = svgNode;
                const byId = doc.getElementById;
                doc.getElementById = (id) => {
                    const found = byId(id);
                    if (!found.setAttribute) {
                        found.attributes = {};
                        found.style = {};
                        found.setAttribute = function set(name, value) { this.attributes[name] = value; };
                    }
                    return found;
                };
                h.configure({ today: () => '2026-09-03', request: () => new Promise(() => {}) });
                h.renderStress();
                const status = doc.getElementById('stress-status').textContent;
                assert.ok(status.startsWith('⚠ 仅显示到期结算曲线'), status);
                assert.match(status, /标的现价无效/);
                assert.match(status, /\[missing_(long|short)_option_market_inputs\]/);
                assert.match(status, /TQQQ · 本账本现金流成本盈亏/);
                assert.ok(doc.getElementById('stress-chart').children.length > 0, 'chart is drawn');
                assert.equal(doc.getElementById('stress-key-points').children.length, 3);
                assert.equal(doc.getElementById('stress-band-status').textContent, '中线降级为到期结算曲线，区间不生成。');
                assert.equal(doc.getElementById('stress-legend-base-pnl').textContent, '到期结算盈亏（未到期期权未计入，左轴）');
                assert.equal(doc.getElementById('stress-legend-protected-pnl').hidden, true);
                assert.ok(h.stressJob.series.warnings.includes('partial_portfolio_excludes_deferred'));
                assert.match(status, /已排除更晚到期的期权/);
                // The unavailable primary verdict is memoised; a second render
                // does not rebuild it or disturb the fallback on screen.
                const shown = h.stressJob.series;
                h.renderStress();
                assert.equal(h.stressJob.series, shown);
                assert.ok(h.stressJob.unavailable.size >= 1);
                // While a fetch is in flight the chart waits rather than flickering.
                h.state.stressInputsPending = true;
                h.renderStress();
                assert.ok(doc.getElementById('stress-status').textContent.startsWith('正在从 TWS 拉取'));
                assert.equal(doc.getElementById('stress-chart').children.length, 0);
                // Change-since-snapshot has no valid baseline without quotes: no fallback.
                h.state.stressInputsPending = false;
                h.state.stressPnlBasis = 'change';
                h.renderStress();
                assert.doesNotMatch(doc.getElementById('stress-status').textContent, /⚠/);
                assert.equal(doc.getElementById('stress-chart').children.length, 0);
                // With deferred options unticked there is nothing to degrade from.
                h.state.stressPnlBasis = 'cost';
                h.state.stressIncludeLongOptions = false;
                h.renderStress();
                assert.doesNotMatch(doc.getElementById('stress-status').textContent, /⚠/);
                assert.ok(doc.getElementById('stress-chart').children.length > 0);
            },
        },
        {
            name: 'an off-hours snapshot without an underlying price is retried once before failing',
            async run() {
                const h = loadPriceHarness(); h.silenceStressRender();
                h.state.status = { features: { optionScenarioInputs: true } };
                Object.assign(h.state, { stressOpen: true, stressExpiry: '20260904',
                    stressIncludeLongOptions: true, stressBasePrice: 70 });
                const calls = [];
                const replies = [];
                h.configure({ today: () => '2026-09-03', request: async (action, fields) => {
                    calls.push({ action, fields });
                    return replies.shift();
                } });
                const waits = [];
                h.context.setTimeout = (fn, ms) => { waits.push(ms); fn(); return 1; };
                const snapshot = (price) => ({ underlyingPrice: price, throughExpiry: '20260904',
                    fetchedAt: 's', options: [], ratesByExpiry: [] });
                replies.push(snapshot(null), snapshot(72));
                await h.refreshStressInputs(false);
                assert.equal(calls.length, 2);
                assert.deepEqual(waits, [1500]);
                assert.equal(h.state.marketPrice, 72);
                assert.equal(h.state.stressInputsError, '');
                assert.equal(h.state.stressInputsPending, false);
                // Two misses in a row: give up with the explicit message, no third request.
                replies.push(snapshot(-1), snapshot(undefined));
                await h.refreshStressInputs(false);
                assert.equal(calls.length, 4);
                assert.equal(h.state.stressInputsError, '拉取失败：TWS 返回的标的现价无效');
                assert.equal(h.state.stressLongOptionInputs, null);
                // A scenario change during the wait abandons the retry.
                replies.push(snapshot(null), snapshot(73));
                h.context.setTimeout = (fn) => { h.state.stressHorizonDays = 5; h.invalidateScenario(); fn(); return 1; };
                await h.refreshStressInputs(false);
                assert.equal(calls.length, 5);
                assert.equal(h.state.marketPrice, 72);
            },
        },
        {
            name: 'a linked snapshot failure drops only the overlay; own quotes missing too falls back to settlement',
            run() {
                const { h, quote } = loadStressPairHarness(); enableStressChartDom(h);
                const doc = h.context.document;
                const core = h.context.OptionComboCostBasisCore;
                Object.assign(h.state, { stressOpen: true, stressLongOptionInputs: quote('book-test'),
                    stressLinkedInputs: null, stressLinkedInputsPending: false,
                    stressLinkedInputsError: '拉取失败：请求超时', stressInputsPending: false });
                h.renderStress();
                let status = doc.getElementById('stress-status').textContent;
                assert.ok(status.startsWith('⚠ QQQ 联动账本未计入，本账本期权仍按快照估值'), status);
                assert.match(status, /请求超时 \[missing_linked_market_inputs\]/);
                assert.ok(doc.getElementById('stress-chart').children.length > 0);
                assert.equal(h.stressJob.series.linkedHedgeEnabled, false);
                assert.equal(doc.getElementById('stress-legend-linked-pnl').hidden, true);
                assert.equal(doc.getElementById('stress-band-status').textContent, '中线降级为本账本曲线（联动未计入），区间不生成。');
                // The linked fetch still running: wait, do not draw a half result.
                h.state.stressLinkedInputsPending = true;
                h.renderStress();
                assert.doesNotMatch(doc.getElementById('stress-status').textContent, /⚠/);
                assert.equal(doc.getElementById('stress-chart').children.length, 0);
                h.state.stressLinkedInputsPending = false;
                // Own quotes gone as well, with a deferred long: two-step degrade.
                h.state.allEvents.push({ kind: 'option_trade', account: 'U1', tradeDate: '2026-09-01',
                    right: 'P', strike: 46, expiry: '20270319', sharesPerContract: 100,
                    contracts: 5, price: 3, cashAmount: -1500 });
                h.state.ledger = core.computeLedger(h.state.allEvents, { referencePrice: 70, secType: 'STK' });
                Object.assign(h.state, { stressLongOptionInputs: null, stressIncludeLongOptions: true,
                    stressInputsError: '拉取失败：TWS 返回的标的现价无效' });
                h.renderStress();
                status = doc.getElementById('stress-status').textContent;
                assert.ok(status.startsWith('⚠ 仅显示到期结算曲线'), status);
                assert.match(status, /\[missing_linked_market_inputs\]/);
                assert.ok(doc.getElementById('stress-chart').children.length > 0);
                assert.equal(doc.getElementById('stress-legend-base-pnl').textContent, '到期结算盈亏（未到期期权未计入，左轴）');
            },
        },
        {
            name: 'partial linked quotes preserve the validated own-book options instead of blanking the chart',
            run() {
                for (const missing of ['rows', 'mark', 'sides']) {
                    const { h, quote } = loadStressPairHarness(); enableStressChartDom(h);
                    const own = quote('book-test'), linked = quote('book-qqq');
                    const extra = { kind: 'option_trade', account: 'U1', tradeDate: '2026-09-01',
                        right: 'P', strike: 60, expiry: '20270319', sharesPerContract: 100,
                        contracts: 1, price: 2, cashAmount: -200 };
                    h.state.allEvents.push(extra);
                    h.state.ledger = h.context.OptionComboCostBasisCore.computeLedger(h.state.allEvents);
                    own.options.push({right:'P',strike:60,expiry:'20270319',mark:2,bid:1.9,ask:2.1,
                        marketDataType:1,observedAt:own.fetchedAt});
                    if (missing === 'rows') linked.options = [];
                    if (missing === 'mark') linked.options[0].mark = null;
                    Object.assign(h.state, {stressOpen:true,stressIncludeLongOptions:true,
                        stressLongOptionInputs:own,stressLinkedInputs:linked,
                        stressLiquidation:missing === 'sides' ? 'bidask' : 'mid'});
                    h.renderStress();
                    assert.match(h.node('stress-status').textContent, /^⚠ QQQ 联动账本未计入/);
                    assert.ok(h.node('stress-chart').children.length > 0, missing);
                    assert.equal(h.stressJob.series.linkedHedgeEnabled, false);
                    assert.equal(h.stressJob.series.includeDeferredLongOptions, true);
                    assert.equal(h.stressJob.series.longOptionCount, 1, 'valid own long is retained');
                    assert.equal(h.node('stress-legend-protected-pnl').hidden, false);
                    assert.equal(h.node('stress-legend-linked-pnl').hidden, true);
                    assert.equal(h.stressJob.worker, null);
                    assert.equal(h.stressJob.series.band, undefined);
                }
            },
        },
        {
            name: 'missing own option mark can degrade to settlement but never values the missing leg at zero',
            run() {
                const h = loadPriceHarness(); enableStressChartDom(h);
                h.configure({today:()=> '2026-09-03'});
                h.state.allEvents.push({kind:'option_trade',account:'U1',tradeDate:'2026-09-01',
                    right:'P',strike:60,expiry:'20270319',contracts:1,sharesPerContract:100,price:2,cashAmount:-200});
                h.state.ledger = h.context.OptionComboCostBasisCore.computeLedger(h.state.allEvents);
                const {quote} = loadStressPairHarness();
                const own = quote('book-test');
                own.options.push({right:'P',strike:60,expiry:'20270319',mark:null,observedAt:own.fetchedAt});
                Object.assign(h.state,{stressOpen:true,stressExpiry:'20260904',stressBasePrice:70,
                    stressIncludeLongOptions:true,stressLongOptionInputs:own});
                h.renderStress();
                assert.match(h.node('stress-status').textContent, /^⚠ 仅显示到期结算曲线/);
                assert.equal(h.stressJob.series.longOptionCount, 0);
                assert.ok(h.stressJob.series.warnings.includes('partial_portfolio_excludes_deferred'));
                // At the upper end only the 200 shares and settled short premium
                // remain. The missing long's -$200 premium is excluded too.
                assert.equal(h.stressJob.series.points.at(-1).headlinePnl, 4400);
            },
        },
        {
            name: 'partial quote fallback remains disabled while pending or using the change lens',
            run() {
                for (const mode of ['own_pending','linked_pending','change']) {
                    const {h,quote} = loadStressPairHarness(); enableStressChartDom(h);
                    const linked=quote('book-qqq'); linked.options=[];
                    Object.assign(h.state,{stressOpen:true,stressLongOptionInputs:quote('book-test'),
                        stressLinkedInputs:linked,stressInputsPending:mode==='own_pending',
                        stressLinkedInputsPending:mode==='linked_pending',stressPnlBasis:mode==='change'?'change':'cost'});
                    h.renderStress();
                    assert.equal(h.node('stress-chart').children.length,0,mode);
                    assert.doesNotMatch(h.node('stress-status').textContent,/^⚠/,mode);
                }
            },
        },
        {
            name: 'linked identity conflicts, crossed quotes and impossible marks are not masked by fallback',
            run() {
                for (const invalid of ['identity','crossed','arbitrage']) {
                    const {h,quote} = loadStressPairHarness(); enableStressChartDom(h);
                    const linked=quote('book-qqq');
                    if(invalid==='identity') {
                        h.state.stressLinkedLedger.openOptions[0].conId=123;
                        Object.assign(linked.options[0],{conId:123,multiplier:10});
                    }
                    if(invalid==='crossed') Object.assign(linked.options[0],{bid:30,ask:20});
                    if(invalid==='arbitrage') linked.options[0].mark=1000;
                    Object.assign(h.state,{stressOpen:true,stressLongOptionInputs:quote('book-test'),stressLinkedInputs:linked});
                    h.renderStress();
                    assert.equal(h.node('stress-chart').children.length,0,invalid);
                    assert.doesNotMatch(h.node('stress-status').textContent,/^⚠/,invalid);
                }
            },
        },
        {
            name: 'busy paired snapshot requests finish pending state and allow a later successful retry',
            async run() {
                const {h,pending,quote} = loadStressPairHarness();
                const first=h.refreshStressPair(false);
                for(const p of pending) p.reject(Object.assign(new Error('busy'),{code:'broker_option_scenario_inputs_busy'}));
                await first;
                assert.equal(h.stressRefreshJob.pending,false);
                assert.equal(h.state.stressInputsPending,false);
                assert.equal(h.state.stressLinkedInputsPending,false);
                assert.match(h.state.stressInputsError,/繁忙.*重试/);
                assert.match(h.state.stressLinkedInputsError,/繁忙.*重试/);
                const retry=h.refreshStressPair(false);
                pending[2].resolve(quote('book-test')); pending[3].resolve(quote('book-qqq'));
                await retry;
                assert.equal(h.stressRefreshJob.pending,false);
                assert.equal(h.state.stressInputsError,'');
                assert.equal(h.state.stressLinkedInputsError,'');
            },
        },
        {
            name: 'an emptied chart drops its pointer handlers so no stale tooltip can reappear',
            run() {
                const h = loadPriceHarness(); enableStressChartDom(h);
                const doc = h.context.document;
                h.configure({ today: () => '2026-09-03', request: () => new Promise(() => {}) });
                Object.assign(h.state, { stressOpen: true, stressExpiry: '20260904', stressBasePrice: 70,
                    stressIncludeLongOptions: false, stressBandEnabled: false });
                h.renderStress();
                const svg = doc.getElementById('stress-chart');
                assert.equal(typeof svg.onpointermove, 'function');
                assert.equal(typeof svg.onpointerleave, 'function');
                doc.getElementById('stress-tooltip').hidden = false;
                h.stressRefreshJob.pending = true;
                h.renderStress();
                assert.equal(svg.children.length, 0);
                assert.equal(svg.onpointermove, null);
                assert.equal(svg.onpointerleave, null);
                assert.equal(doc.getElementById('stress-tooltip').hidden, true);
                assert.equal(doc.getElementById('stress-slice').hidden, true);
            },
        },
        // ------------------------------------------------------------------
        // 2026-09-10 import integrity review
        // ------------------------------------------------------------------
        {
            name: 'rows already stored under their own reference are a replay, not a match',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const stored = {
                    eventId: 'csv-1', kind: 'option_trade', tradeDate: '2026-09-01',
                    brokerTimestamp: '2026-09-01T10:00:00', account: 'U1', right: 'P',
                    strike: 72, expiry: '20260918', contracts: -1, sharesPerContract: 100,
                    price: 1.01, cashAmount: 100.44, fees: 0.56, source: 'csv_import',
                    tag: 'ibkr_open', externalRef: 'stmt-known',
                };
                const twsNextDay = Object.assign({}, stored, {
                    eventId: 'api-1', tradeDate: '2026-09-02',
                    brokerTimestamp: '2026-09-02T10:00:00', source: 'execution_report',
                    tag: 'ibkr_exec', externalRef: 'ibkr-exec-E2',
                });
                const csvRow = Object.assign({}, stored, {
                    eventId: undefined, sourceRef: 'stmt-known', lineNumber: 3,
                });
                const plan = page.planExecutionReportAliases({
                    format: 'activity', events: [csvRow],
                }, [stored, twsNextDay]);
                assert.equal(plan.problems.length, 0);
                assert.equal(Object.keys(plan.aliases).length, 0);
                assert.equal(plan.unmatchedExecutions.length, 1);
            },
        },
        {
            name: 'fill rows split an order that TWS delivered only partly',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const base = {
                    kind: 'option_trade', tradeDate: '2026-09-08', account: 'U1',
                    right: 'P', strike: 72, expiry: '20260918', sharesPerContract: 100,
                    conId: 123,
                };
                const storedFill = Object.assign({}, base, {
                    eventId: 'f1', source: 'execution_report', tag: 'ibkr_exec',
                    externalRef: 'ibkr-exec-E1', brokerTimestamp: '2026-09-08T10:00:00',
                    contracts: -3, price: 1.01, fees: 1.95, cashAmount: 301.05,
                });
                const orderRow = Object.assign({}, base, {
                    source: 'csv_import', tag: 'ibkr_open', externalRef: 'stmt-order',
                    sourceRef: 'stmt-order', brokerTimestamp: '2026-09-08T10:00:00',
                    contracts: -10, price: 1.02, priceText: '1.02', fees: 6.5,
                    cashAmount: 1013.5, lineNumber: 9,
                    fills: [
                        { brokerTimestamp: '2026-09-08T10:00:00', tradeDate: '2026-09-08',
                          quantity: -3, price: 1.01, priceText: '1.01', cashAmount: 301.05,
                          fees: 1.95, lineNumber: 10 },
                        { brokerTimestamp: '2026-09-08T10:00:07', tradeDate: '2026-09-08',
                          quantity: -7, price: 1.02, priceText: '1.02', cashAmount: 712.45,
                          fees: 4.55, lineNumber: 11 },
                    ],
                });
                const plan = page.planExecutionReportAliases({
                    format: 'activity', events: [orderRow],
                }, [storedFill]);
                assert.equal(plan.problems.length, 0);
                assert.equal(Object.keys(plan.aliases).length, 0);
                const split = plan.fillSplits['U1\u0000stmt-order'];
                assert.deepEqual(Array.from(split.keep), [1]);
                assert.deepEqual(JSON.parse(JSON.stringify(split.matched)),
                    [{ index: 0, externalRef: 'ibkr-exec-E1' }]);
                assert.equal(plan.matched[0].partial, true);
                // A fill row that disagrees with the stored fill is not
                // claimed, and the whole order is imported as usual.
                const disagree = page.planExecutionReportAliases({
                    format: 'activity', events: [Object.assign({}, orderRow, {
                        fills: [Object.assign({}, orderRow.fills[0], { cashAmount: 300 }),
                            orderRow.fills[1]],
                    })],
                }, [storedFill]);
                assert.equal(Object.keys(disagree.fillSplits).length, 0);
                assert.equal(disagree.problems.length, 1);
            },
        },
        {
            name: 'stored fills carrying an order id group by order, not by adjacency',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const base = {
                    kind: 'share_trade', tradeDate: '2026-09-08', account: 'U1',
                    source: 'execution_report', tag: 'ibkr_exec',
                };
                const fill = (id, time, shares, permId) => Object.assign({}, base, {
                    eventId: id, externalRef: `ibkr-exec-${id}`, brokerTimestamp: time,
                    shares, price: 45, fees: 0.5, cashAmount: -(shares * 45) - 0.5,
                    note: `Imported from TWS API execution ${id}; permId ${permId}`,
                });
                const fills = [
                    fill('A0', '2026-09-08T09:34:58', 200, 7001),
                    fill('A1', '2026-09-08T09:35:00', 100, 7002),
                    fill('A2', '2026-09-08T09:35:02', 200, 7002),
                ];
                const orderA = Object.assign({}, base, {
                    source: 'csv_import', tag: 'ibkr_open', externalRef: 'stmt-a', sourceRef: 'stmt-a',
                    brokerTimestamp: '2026-09-08T09:35:00', shares: 300,
                    price: 45, priceText: '45', fees: 1, cashAmount: -13501, lineNumber: 3,
                });
                // Without order ids two runs of 300 touch 09:35:00; with them
                // only order 7002 does.
                const plan = page.planExecutionReportAliases({
                    format: 'activity', events: [orderA],
                }, fills);
                assert.equal(plan.problems.length, 0);
                assert.equal(plan.aliases['U1\u0000stmt-a'], 'ibkr-exec-A1');
                assert.deepEqual(Array.from(plan.matched[0].executions.map((item) => item.eventId)), ['A1', 'A2']);
            },
        },
        {
            name: 'a revised statement row and a hand-entered twin block instead of doubling',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const stored = {
                    eventId: 'csv-1', kind: 'share_trade', tradeDate: '2026-09-01',
                    brokerTimestamp: '2026-09-01T10:00:00', account: 'U1', shares: 10,
                    price: 50, fees: 0, cashAmount: -500, source: 'csv_import',
                    externalRef: 'stmt-old',
                };
                const revised = Object.assign({}, stored, {
                    eventId: undefined, fees: 1, cashAmount: -501,
                    externalRef: 'stmt-new', sourceRef: 'stmt-new', lineNumber: 2,
                });
                const plan = page.planStatementRevisionConflicts({
                    events: [revised],
                }, [stored], {});
                assert.equal(plan.problems.length, 1);
                assert.match(plan.problems[0].reason, /different identity/);
                assert.match(plan.problems[0].reason, /fees 0; this file .* fees 1/);
                const manual = Object.assign({}, stored, {
                    eventId: 'man-1', source: 'manual', externalRef: null,
                    brokerTimestamp: null,
                });
                const csv = Object.assign({}, stored, {
                    eventId: undefined, externalRef: 'stmt-x', sourceRef: 'stmt-x', lineNumber: 4,
                });
                const twin = page.planStatementRevisionConflicts({ events: [csv] }, [manual], {});
                assert.match(twin.problems[0].reason, /hand-entered ledger row/);
                const dividend = { kind: 'dividend', tradeDate: '2026-06-30', account: 'U1',
                    cashAmount: 25, externalRef: 'stmt-div', sourceRef: 'stmt-div', lineNumber: 8 };
                const manualDividend = Object.assign({}, dividend, {
                    eventId: 'man-2', source: 'manual', externalRef: null });
                const cash = page.planStatementRevisionConflicts(
                    { events: [dividend] }, [manualDividend], {});
                assert.match(cash.problems[0].reason, /hand-entered dividend/);
                // An aliased or already-known row is not a revision.
                const known = page.planStatementRevisionConflicts(
                    { events: [Object.assign({}, csv, { sourceRef: 'stmt-old' })] }, [stored], {});
                assert.equal(known.problems.length, 0);
            },
        },
        {
            name: 'TWS fills inside the statement period with no statement row block the batch',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const fill = {
                    eventId: 'api-1', kind: 'option_trade', tradeDate: '2026-09-15',
                    account: 'U1', right: 'P', strike: 72, expiry: '20260918',
                    contracts: -1, price: 1, externalRef: 'ibkr-exec-E9',
                    source: 'execution_report', tag: 'ibkr_exec',
                };
                const inside = page.planStatementCoverageGaps({
                    format: 'activity', account: 'U1', checks: { trades: true },
                    statementPeriod: { from: '2026-09-01', through: '2026-09-30', source: 'period' },
                }, [fill]);
                assert.equal(inside.checked, true);
                assert.equal(inside.problems.length, 1);
                assert.match(inside.problems[0].reason, /ibkr-exec-E9/);
                const outside = page.planStatementCoverageGaps({
                    format: 'activity', account: 'U1', checks: { trades: true },
                    statementPeriod: { from: '2026-08-01', through: '2026-08-31', source: 'period' },
                }, [fill]);
                assert.equal(outside.problems.length, 0);
                const noPeriod = page.planStatementCoverageGaps({
                    format: 'activity', account: 'U1', checks: { trades: true },
                    statementPeriod: { from: '2026-09-01', through: '2026-09-30', source: 'events' },
                }, [fill]);
                assert.equal(noPeriod.checked, false);
            },
        },
        {
            name: 'real openings supersede an opening stub only when they sum exactly',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const stub = {
                    eventId: 'stub-1', kind: 'option_trade', tradeDate: '2026-08-31',
                    account: 'U1', right: 'P', strike: 45, expiry: '20260717',
                    sharesPerContract: 100, contracts: -2, price: 0, cashAmount: 0,
                    source: 'csv_import', tag: 'prior_open', externalRef: 'prior-x',
                };
                const opening = (date, contracts, ref) => ({
                    kind: 'option_trade', tradeDate: date, account: 'U1', right: 'P',
                    strike: 45, expiry: '20260717', sharesPerContract: 100, contracts,
                    price: 1, cashAmount: -contracts * 100, source: 'csv_import',
                    tag: 'ibkr_open', externalRef: ref, sourceRef: ref, lineNumber: 2,
                });
                const exact = page.planPriorStubSupersession({
                    format: 'activity', account: 'U1',
                    events: [opening('2026-08-20', -1, 'a'), opening('2026-08-21', -1, 'b')],
                }, [stub]);
                assert.deepEqual(Array.from(exact.eventIds), ['stub-1']);
                assert.equal(exact.problems.length, 0);
                const partial = page.planPriorStubSupersession({
                    format: 'activity', account: 'U1', events: [opening('2026-08-20', -1, 'a')],
                }, [stub]);
                assert.deepEqual(Array.from(partial.eventIds), []);
                assert.match(partial.problems[0].reason, /does not exactly replace the stub/);
                const unrelated = page.planPriorStubSupersession({
                    format: 'activity', account: 'U1',
                    events: [Object.assign(opening('2026-08-20', -2, 'c'), { strike: 50 })],
                }, [stub]);
                assert.deepEqual(Array.from(unrelated.eventIds), []);
                assert.equal(unrelated.problems.length, 0);
            },
        },
        {
            name: 'a TWS reply that lands after a book switch is dropped',
            async run() {
                const h = loadReconciliationHarness();
                h.state.allEvents = [];
                h.configure({ request: async () => {
                    // The operator switches books while the query is out.
                    h.state.bookId = 'other-book';
                    return { fetchedAt: '2026-09-03T11:00:00', executions: [{
                        account: 'U1', symbol: 'TQQQ', secType: 'STK', execId: 'source-A',
                        side: 'BOT', quantity: 10, price: 50, commission: 1,
                        commissionAvailable: true, brokerTimestamp: '2026-09-01T10:00:00',
                    }] };
                } });
                await h.fetch();
                assert.equal(h.state.importResult, null);
                assert.equal(h.alerts.length, 0);
            },
        },
        {
            name: 'a preview bound to an older ledger version, generation or mode cannot be committed',
            run() {
                const h = loadReconciliationHarness();
                h.state.ledgerVersion = { digest: 'v1' };
                h.state.importGeneration = 4;
                h.state.importResult = { binding: {
                    bookId: 'book-test', generation: 4, mode: 'append', ledgerVersion: 'v1',
                } };
                assert.equal(h.bindingProblem(), '');
                h.state.ledgerVersion = { digest: 'v2' };
                assert.match(h.bindingProblem(), /账本在预览后发生了变化/);
                h.state.ledgerVersion = { digest: 'v1' };
                h.state.importGeneration = 5;
                assert.match(h.bindingProblem(), /预览已过期/);
                h.state.importGeneration = 4;
                h.state.importResult.binding.bookId = 'another';
                assert.match(h.bindingProblem(), /另一本账本/);
            },
        },
        {
            name: 'reading a new file invalidates the old preview and a late read is dropped',
            run() {
                const h = loadReconciliationHarness();
                const readers = [];
                h.context.FileReader = function FakeReader() {
                    readers.push(this);
                    this.readAsText = () => {};
                };
                h.state.importResult = { binding: {}, problems: [], events: [] };
                h.state.importText = 'old file';
                h.handleImportFile({ target: { files: [{ name: 'new.csv' }] } });
                assert.equal(h.state.importResult, null);
                assert.equal(h.state.importText, '');
                assert.equal(h.state.importReading, 'new.csv');
                const first = readers[0];
                // A second selection supersedes the first before it finished.
                h.handleImportFile({ target: { files: [{ name: 'newer.csv' }] } });
                first.result = 'stale bytes';
                first.onload();
                assert.equal(h.state.importText, '');
                assert.equal(h.state.importReading, 'newer.csv');
                const second = readers[1];
                second.error = { message: 'disk' };
                second.onerror();
                assert.equal(h.state.importReading, false);
                assert.match(h.state.importResult.problems[0].reason, /文件读取失败/);
            },
        },
        {
            name: 'statement coverage lists contiguous spans and the gaps between them',
            run() {
                const page = loadPage().OptionComboCostBasisPage;
                const coverage = page.describeStatementCoverage([
                    { checks: { period: true, account: true, openPositions: true, revision: true, twsCoverage: true }, periodFrom: '2026-08-01', periodThrough: '2026-08-31' },
                    { checks: { period: true, account: true, openPositions: true, revision: true, twsCoverage: true }, periodFrom: '2026-09-01', periodThrough: '2026-09-30' },
                    { checks: { period: true, account: true, openPositions: true, revision: true, twsCoverage: true }, periodFrom: '2026-11-01', periodThrough: '2026-11-30' },
                    { checks: { period: true, account: true, openPositions: true, revision: true, twsCoverage: true }, periodFrom: '', periodThrough: '' },
                ]);
                assert.deepEqual(JSON.parse(JSON.stringify(coverage.covered)), [
                    { from: '2026-08-01', through: '2026-09-30' },
                    { from: '2026-11-01', through: '2026-11-30' },
                ]);
                assert.deepEqual(JSON.parse(JSON.stringify(coverage.gaps)),
                    [{ from: '2026-10-01', through: '2026-10-31' }]);
                assert.match(coverage.text, /缺口 2026-10-01 至 2026-10-31/);
                assert.equal(page.describeStatementCoverage([]).text, '');
            },
        },
    ],
};
