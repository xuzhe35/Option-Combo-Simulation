/* Offline browser regression. Usage: node scripts/verify_cost_basis_import_browser.js <CSV> [--full]
 * Requires Playwright and an installed Chrome. All HTTP and backend requests are
 * intercepted; no real book or broker is contacted. The share baseline is test data.
 * Without --full the CSV must be a masked-account daily report. The book account is
 * synthesized from its visible account digits and every expected figure is derived
 * from the report itself, so this file holds nothing from a real statement.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const csv = process.argv[2];
if (!csv) throw new Error('Provide the local CSV to verify.');
const fullStatement = process.argv.includes('--full');

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
                          if(action==='import_cost_basis_events'||action==='rebuild_cost_basis_book'){
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
        if (fullStatement) {
            await page.evaluate(text => {
                const h = window.__importAudit;
                h.configure();
                const parsed = window.OptionComboCostBasisImport.parse(text, { symbol: 'TQQQ' });
                const book = { bookId: 'test', account: parsed.account, symbol: 'TQQQ', secType: 'STK',
                    currency: 'USD', defaultSharesPerContract: 100, startDate: '2026-01-01' };
                const existing = parsed.events.filter(e => e.tradeDate < parsed.statementPeriod.through)
                    .map((e, i) => ({ ...e, seq: i + 1, eventId: 'old-' + i }));
                Object.assign(h.state, { connection: 'connected', status: { available: true }, books: [book],
                    bookId: 'test', allEvents: existing, ledger: window.OptionComboCostBasisCore.computeLedger(existing),
                    ledgerVersion: { digest: 'test' } });
                h.render();
                h.showView('ledger');
            }, fs.readFileSync(csv, 'utf8'));
            await page.locator('#import-file').setInputFiles(csv);
            await page.waitForFunction(() => !!window.__importAudit.state.importResult);
            await page.locator('#import-replace').check();
            await page.waitForFunction(() => window.__importAudit.state.importResult?.binding?.mode === 'rebuild'
                && !document.getElementById('btn-import-commit').disabled);
            const preview = await page.evaluate(() => window.__importAudit.state.importResult);
            assert.deepEqual(preview.problems, []);
            assert.deepEqual(preview.ledgerPreview.warnings, []);
            assert.ok(preview.ledgerPreview.positions.every(p => p.statement === null || Math.abs(p.after - p.statement) < 1e-6));
            assert.ok(await page.locator('#import-ledger-warnings').isHidden());
            assert.match(await page.locator('#import-table').innerText(), /期权平仓并反向开仓/);
            if (process.env.COST_BASIS_BROWSER_SCREENSHOT) {
                await page.locator('#import-workspace').screenshot({ path: process.env.COST_BASIS_BROWSER_SCREENSHOT });
            }
            await page.locator('#btn-import-commit').click();
            await page.waitForFunction(() => window.__importAudit.writes.length === 1);
            const write = await page.evaluate(() => window.__importAudit.writes[0]);
            assert.equal(write.action, 'rebuild_cost_basis_book');
            assert.equal(write.payload.events.length, preview.events.length);
            assert.equal(write.payload.events.filter(e => e.tag === 'ibkr_close_open').length, 1);
            assert.deepEqual(errors, []);
            console.log(`Offline Chrome full rebuild: ${write.payload.events.length} events, mixed reversal preserved, all reported positions match, zero preview warnings or page errors.`);
            return;
        }
        const expected = await page.evaluate(text => {
            const I = window.OptionComboCostBasisImport;
            const source = String(I.extractAccount(I.parseCsv(text)) || '');
            const account = source.replace(/\*+/, '1000');
            const probe = I.parse(text, { symbol: 'TQQQ', targetAccount: account, accountFallback: account,
                currency: 'USD', confirmedAccountMapping: { sourceAccount: source, targetAccount: account } });
            return { source, account, rows: probe.summary.total, openingShares: probe.openings.openingShares };
        }, fs.readFileSync(csv, 'utf8'));
        assert.match(expected.source, /^[A-Z]+\d*\*+\d{4,}$/, 'the CSV must carry a masked account');
        assert.ok(expected.openingShares > 0, 'the daily report must start with shares already held');
        await page.evaluate(expected => {
            const h = window.__importAudit;
            h.configure();
            const account = expected.account;
            const book = { bookId: 'test', account, symbol: 'TQQQ', secType: 'STK', currency: 'USD',
                defaultSharesPerContract: 100, startDate: '2026-09-10' };
            const baseline = { eventId: 'baseline', seq: 1, kind: 'opening_balance', account,
                tradeDate: '2026-09-10', shares: expected.openingShares, price: 70,
                cashAmount: -expected.openingShares * 70, source: 'manual' };
            Object.assign(h.state, { connection: 'connected', status: { available: true }, books: [book],
                bookId: 'test', allEvents: [baseline], ledger: window.OptionComboCostBasisCore.computeLedger([baseline]),
                ledgerVersion: { digest: 'test' } });
            h.render();
            h.showView('ledger');
        }, expected);
        await page.locator('#import-file').setInputFiles(csv);
        await page.waitForFunction(() => window.__importAudit.state.importResult?.accountMatch?.status === 'confirmation_required');
        assert.ok(await page.locator('#btn-import-commit').isDisabled());
        assert.ok(await page.locator('#import-account-confirm-wrap').isVisible(), JSON.stringify({ errors,
            ancestors: await page.locator('#import-account-confirm-wrap').evaluate(el => {
                const result=[];for(let node=el;node;node=node.parentElement)result.push({tag:node.tagName,id:node.id,hidden:node.hidden,display:getComputedStyle(node).display});return result;
            }) }));
        assert.ok((await page.locator('#import-account-note').innerText()).includes(expected.source));
        assert.ok((await page.locator('#import-summary').innerText()).includes(`读取 ${expected.rows} 行`));
        await page.locator('#import-account-confirm').check();
        await page.waitForFunction(() => window.__importAudit.state.importResult?.accountMatch?.status === 'confirmed');
        assert.equal(await page.locator('#btn-import-commit').isDisabled(), false);
        const shownRows = await page.locator('#import-table tbody tr').count();
        assert.ok(shownRows > 0);
        assert.ok(await page.locator('#import-ledger-warnings').isHidden());
        await page.locator('#import-replace').check();
        await page.waitForFunction(() => window.__importAudit.state.importResult?.binding?.mode === 'rebuild');
        assert.ok(await page.locator('#btn-import-commit').isDisabled());
        const openingsText = await page.locator('#import-openings').innerText();
        assert.ok(openingsText.includes(expected.openingShares.toLocaleString('en-US'))
            || openingsText.includes(String(expected.openingShares)));
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
        assert.equal(payload.events.length, shownRows, 'every previewed row, and only those, is submitted');
        assert.ok(payload.events.every(event => event.account === expected.account));
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
