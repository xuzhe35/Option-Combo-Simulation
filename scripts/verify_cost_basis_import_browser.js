/* Offline browser regression. Usage: node scripts/verify_cost_basis_import_browser.js <masked CSV>
 * Requires Playwright and an installed Chrome. All HTTP and backend requests are
 * intercepted; no real book or broker is contacted. The share baseline is test data.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const csv = process.argv[2];
if (!csv) throw new Error('Provide the local masked daily CSV to verify.');

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.accept());
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname !== 'costbasis.test') return route.abort();
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const target = path.resolve(root, relative);
            if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) return route.fulfill({ status: 404 });
            let body = fs.readFileSync(target);
            if (relative === 'js/cost_basis.js') {
                body = body.toString().replace('\n        connect();\n', '\n        // Offline test: no websocket connection.\n');
                body = body.replace('globalScope.OptionComboCostBasisPage = {', `
                    globalScope.__importAudit={state,render:_renderAll,showView:_showView,writes:[],
                      configure(){
                        _loadBooks=async()=>{};
                        request=async(action,payload)=>{
                          if(action==='request_cost_basis_reset_plan')return {phrase:'test reset',eventCount:state.allEvents.length,
                            firstTradeDate:'2026-09-10',lastTradeDate:'2026-09-10',ledgerVersion:state.ledgerVersion};
                          if(action==='import_cost_basis_events'){
                            globalScope.__importAudit.writes.push({action,payload});
                            return {inserted:payload.events.length,skipped:0};
                          }
                          throw new Error('Unexpected offline request: '+action);
                        };
                      }};
                    globalScope.OptionComboCostBasisPage = {`);
            }
            const contentType = target.endsWith('.js') ? 'text/javascript'
                : (target.endsWith('.css') ? 'text/css' : (target.endsWith('.html') ? 'text/html' : 'application/octet-stream'));
            return route.fulfill({ body, contentType });
        });
        await page.goto('http://costbasis.test/cost_basis.html');
        await page.evaluate(() => {
            const h = window.__importAudit;
            h.configure();
            const account = 'U100022426';
            const book = { bookId: 'test', account, symbol: 'TQQQ', secType: 'STK', currency: 'USD',
                defaultSharesPerContract: 100, startDate: '2026-09-10' };
            const baseline = { eventId: 'baseline', seq: 1, kind: 'opening_balance', account,
                tradeDate: '2026-09-10', shares: 1500, price: 70, cashAmount: -105000, source: 'manual' };
            Object.assign(h.state, { connection: 'connected', status: { available: true }, books: [book],
                bookId: 'test', allEvents: [baseline], ledger: window.OptionComboCostBasisCore.computeLedger([baseline]),
                ledgerVersion: { digest: 'test' } });
            h.render();
            h.showView('ledger');
        });
        await page.locator('#import-file').setInputFiles(csv);
        await page.waitForFunction(() => window.__importAudit.state.importResult?.accountMatch?.status === 'confirmation_required');
        assert.ok(await page.locator('#btn-import-commit').isDisabled());
        assert.ok(await page.locator('#import-account-confirm-wrap').isVisible(), JSON.stringify({ errors,
            ancestors: await page.locator('#import-account-confirm-wrap').evaluate(el => {
                const result=[];for(let node=el;node;node=node.parentElement)result.push({tag:node.tagName,id:node.id,hidden:node.hidden,display:getComputedStyle(node).display});return result;
            }) }));
        assert.match(await page.locator('#import-account-note').innerText(), /U\*\*\*22426/);
        assert.match(await page.locator('#import-summary').innerText(), /读取 28 行/);
        await page.locator('#import-account-confirm').check();
        await page.waitForFunction(() => window.__importAudit.state.importResult?.accountMatch?.status === 'confirmed');
        assert.equal(await page.locator('#btn-import-commit').isDisabled(), false);
        assert.equal(await page.locator('#import-table tbody tr').count(), 27);
        assert.ok(await page.locator('#import-ledger-warnings').isHidden());
        await page.locator('#import-replace').check();
        await page.waitForFunction(() => window.__importAudit.state.importResult?.binding?.mode === 'rebuild');
        assert.ok(await page.locator('#btn-import-commit').isDisabled());
        assert.match(await page.locator('#import-openings').innerText(), /1,500|1500/);
        await page.locator('#import-replace').uncheck();
        await page.waitForFunction(() => !document.getElementById('btn-import-commit').disabled);
        await page.locator('#import-account-confirm').uncheck();
        assert.ok(await page.locator('#btn-import-commit').isDisabled());
        await page.locator('#import-account-confirm').check();
        await page.waitForFunction(() => !document.getElementById('btn-import-commit').disabled);
        if (process.env.COST_BASIS_BROWSER_SCREENSHOT) {
            await page.locator('#import-workspace').screenshot({ path: process.env.COST_BASIS_BROWSER_SCREENSHOT });
        }
        await page.locator('#btn-import-commit').click();
        await page.waitForFunction(() => window.__importAudit.writes.length === 1);
        const payload = await page.evaluate(() => window.__importAudit.writes[0].payload);
        assert.equal(payload.events.length, 27);
        assert.ok(payload.events.every(event => event.account === 'U100022426'));
        assert.equal(payload.statement.checks.accountMaskedConfirmed, true);
        await page.locator('#import-file').setInputFiles(csv);
        await page.waitForFunction(() => window.__importAudit.state.importResult?.accountMatch?.status === 'confirmation_required');
        assert.ok(await page.locator('#btn-import-commit').isDisabled());
        assert.equal(await page.locator('#import-account-confirm').isChecked(), false);
        assert.deepEqual(errors, []);
        console.log('Offline Chrome UI: file selection, account consent, daily append, incomplete rebuild block, consent revocation, submit payload and consent reset passed.');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
