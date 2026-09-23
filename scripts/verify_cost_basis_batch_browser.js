/* Offline batch-reconciliation UI regression. Run with Node + Playwright and Chrome.
 * Every network request is intercepted; no real ledger or broker is contacted.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname !== 'costbasis.test') return route.abort();
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const target = path.resolve(root, relative);
            if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) {
                return route.fulfill({ status: 404 });
            }
            let body = fs.readFileSync(target);
            if (relative === 'js/cost_basis.js') {
                body = body.toString().replace('\n        connect();\n', '\n        // Offline regression.\n');
                body = body.replace('globalScope.OptionComboCostBasisPage = {', `
                    globalScope.__batchAudit = {state, render: _renderAll, renderImport: _renderImportPreview, showView: _showView,
                        calls: [], setup() {
                            _loadBooks = async () => {};
                            request = async (action, payload) => {
                                this.calls.push({action, payload});
                                if (action === 'request_cost_basis_executions') return {
                                    fetchedAt: '2026-09-22T11:00:00', executions: [70,71,72].map(strike => ({
                                        account:'U1', symbol:'TQQQ', secType:'OPT', execId:'batch-'+strike,
                                        right:'C', strike, expiry:'20261016', multiplier:100,
                                        side:'BOT', quantity:2, price:0.2, commission:1,
                                        commissionAvailable:strike !== 72,
                                        brokerTimestamp:'2026-09-22T10:00:00'})).concat([
                                        {account:'U1',symbol:'TQQQ',secType:'OPT',execId:'round-open',right:'C',
                                         strike:74,expiry:'20261016',multiplier:100,side:'BOT',quantity:5,
                                         price:1,commission:1,commissionAvailable:true,brokerTimestamp:'2026-09-22T10:01:00'},
                                        {account:'U1',symbol:'TQQQ',secType:'OPT',execId:'round-close',right:'C',
                                         strike:74,expiry:'20261016',multiplier:100,side:'SLD',quantity:5,
                                         price:0.5,commission:1,commissionAvailable:true,brokerTimestamp:'2026-09-22T10:02:00'}])};
                                if (action === 'import_cost_basis_events') return {inserted:payload.events.length, skipped:0};
                                throw new Error('Unexpected offline request: '+action);
                            };
                        }};
                    globalScope.OptionComboCostBasisPage = {`);
            }
            const contentType = target.endsWith('.js') ? 'text/javascript'
                : target.endsWith('.css') ? 'text/css' : target.endsWith('.html') ? 'text/html' : 'application/octet-stream';
            return route.fulfill({ body, contentType });
        });
        await page.goto('http://costbasis.test/cost_basis.html');
        await page.evaluate(() => {
            const h = window.__batchAudit, core = window.OptionComboCostBasisCore;
            h.setup();
            const events = [70,71,72].map((strike, i) => ({account:'U1',kind:'option_trade',
                right:'C',strike,expiry:'20261016',sharesPerContract:100,contracts:-2,
                price:1,cashAmount:200,fees:0,tradeDate:'2026-09-21',seq:i+1,eventId:'old-'+i}));
            const book = {bookId:'test',account:'U1',symbol:'TQQQ',secType:'STK',
                currency:'USD',defaultSharesPerContract:100,startDate:'2026-01-01'};
            Object.assign(h.state, {connection:'connected',status:{available:true},books:[book],bookId:'test',
                allEvents:events,ledger:core.computeLedger(events),ledgerVersion:{digest:'batch-ui'},
                positionsConnected:true,positionsAt:'11:00:00',positionsTimestamp:'2026-09-22T11:00:00',
                reconciliation:{rows:events.map(e=>({...e,kind:'option',key:core.contractKey(e),
                    status:'ledger_only',label:'TQQQ C'+e.strike,ledger:-2,tws:0,difference:2}))}});
            h.render(); h.showView('ledger');
        });
        await page.locator('#btn-batch-executions').click();
        await page.waitForFunction(() => !!window.__batchAudit.state.importResult?.batchReconciliation);
        assert.match(await page.locator('#import-batch-summary').innerText(), /2 个合约可归账，2 项保留待处理/);
        assert.match(await page.locator('#import-batch-summary').innerText(), /C72.*佣金/);
        assert.equal(await page.locator('#btn-import-commit').innerText(), '确认批量归账');
        assert.equal(await page.locator('#btn-import-commit').isEnabled(), true);
        assert.equal(await page.locator('#btn-batch-executions').isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__batchAudit.calls.length), 1);
        assert.match(await page.locator('#import-batch-summary').innerText(), /C74.*-252/);
        await page.evaluate(() => {
            const h=window.__batchAudit;
            h.state.positionsTimestamp='2026-09-22T11:05:00';
            h.render();
        });
        assert.equal(await page.locator('#btn-import-commit').isEnabled(), true, 'time-only refresh preserves preview');
        await page.evaluate(() => {
            const h=window.__batchAudit;
            // Simulate an error introduced by this batch (not carried history).
            h.state.importResult.ledgerPreview.warnings.push('ibkr_close_open_invalid:test');
            h.state.importResult.ledgerPreview.newWarnings = ['ibkr_close_open_invalid:test'];
            h.renderImport();
        });
        assert.equal(await page.locator('#btn-import-commit').isDisabled(), true);
        assert.match(await page.locator('#import-blocked').innerText(), /历史回放.*导入已被禁用/);
        await page.evaluate(() => {
            const h=window.__batchAudit;
            h.state.importResult.ledgerPreview.warnings=[];
            h.state.importResult.ledgerPreview.newWarnings=[];
            h.state.reconciliation.rows[0].tws=1;
            h.render();
        });
        assert.equal(await page.locator('#btn-import-commit').isDisabled(), true, 'quantity change invalidates preview');
        await page.evaluate(() => {
            const h=window.__batchAudit;
            h.state.reconciliation.rows[0].tws=0;
            h.renderImport();
        });
        // Cancel the native confirmation: the complete preview remains reviewable.
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('#btn-import-commit').click();
        assert.equal(await page.evaluate(() => window.__batchAudit.calls.length), 1);
        page.on('dialog', dialog => dialog.accept());
        await page.locator('#btn-import-commit').click();
        await page.waitForFunction(() => window.__batchAudit.calls.some(c => c.action === 'import_cost_basis_events'));
        const writes = await page.evaluate(() => window.__batchAudit.calls.filter(c => c.action === 'import_cost_basis_events'));
        assert.equal(writes.length, 1);
        assert.equal(writes[0].payload.events.length, 2);
        assert.equal(writes[0].payload.twsReconciliation.length, 2);
        assert.equal(writes[0].payload.expectedLedgerVersion.digest, 'batch-ui');
        assert.deepEqual(errors, []);
        console.log('PASS: batch preview reports roundtrip cash, accepts time-only broadcasts, blocks quantity changes and replay errors, cancels safely, then writes once; no page errors.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
