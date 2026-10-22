/* Live browser regression for a supplied private screenshot's missing quantity. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const arg = key => process.argv[process.argv.indexOf(key) + 1];
for (const key of ['--image','--output','--symbol','--expiry','--quantity','--count']) assert.ok(process.argv.includes(key), key + ' required');
const origin = process.argv.includes('--url') ? arg('--url') : 'http://127.0.0.1:8798';
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const input = path.resolve(arg('--image')), output = path.resolve(arg('--output'));
fs.mkdirSync(output, { recursive: true });
(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1536, height: 1100 } });
        page.setDefaultTimeout(120000);
        const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin === origin || ['blob:','data:'].includes(url.protocol)) return route.continue();
            errors.push('Unexpected external request'); return route.abort();
        });
        await page.goto(origin + '/portfolio_snapshot.html');
        await page.waitForFunction(() => document.querySelector('#service-status').textContent.includes('已就绪'));
        await page.locator('#image-file').setInputFiles(input);
        await page.waitForFunction(() => !document.querySelector('#recognize').disabled);
        const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/recognize'));
        await page.locator('#recognize').click();
        const response = await responsePromise, raw = await response.json(); assert.equal(response.ok(), true);
        fs.writeFileSync(path.join(output, 'raw.json'), JSON.stringify(raw));
        await page.waitForFunction(count => window.__portfolioSnapshot.getSnapshot().positions.length === count, Number(arg('--count')));
        const snapshot = await page.evaluate(() => window.__portfolioSnapshot.getSnapshot());
        raw.quantityRereads = snapshot.recognition.originalQuantityRereads;
        raw.reviewRereads = snapshot.recognition.originalReviewRereads;
        fs.writeFileSync(path.join(output, 'raw.json'), JSON.stringify(raw));
        if (process.argv.includes('--golden')) {
            const golden = JSON.parse(fs.readFileSync(arg('--golden')));
            assert.equal(snapshot.positions.length, golden.positions.length);
            for (const [index, fields] of golden.positions.entries()) for (const [field, value] of Object.entries(fields)) {
                const actual = field.split('.').reduce((o, key) => o?.[key], snapshot.positions[index]) ?? null;
                assert.equal(actual, value, 'row ' + (index + 1) + ': ' + field);
            }
            assert.deepEqual(snapshot.recognition.structureIssues, []);
            for (const combo of golden.combos) {
                const parent = snapshot.sourceRows[combo.parentRowNumber - 1];
                const children = combo.legRowNumbers.map(n => snapshot.sourceRows[n - 1]);
                assert.equal(parent.combo.status, 'expanded_visible');
                assert.deepEqual(parent.combo.atomicLegRowIds, children.map(r => r.rowId));
                assert.ok(snapshot.positions.every(p => !p.sourceRowIds.includes(parent.rowId)));
                assert.ok(children.every(r => r.parentRowId === parent.rowId && r.hierarchyEvidence.indentMeasurement.passes.length === 2));
            }
            const classPosition = snapshot.positions.find(p => p.fieldEvidence['instrument.tradingClass'].corrections.length);
            assert.ok(classPosition);
            await page.locator('[data-position-id="' + classPosition.positionId + '"]').click();
            assert.equal(await page.locator('[data-field="instrument.secType"]').inputValue(), 'FOP');
            assert.equal(await page.locator('[data-field="instrument.tradingClass"]').inputValue(), classPosition.instrument.tradingClass);
            assert.match(await page.locator('[data-field="instrument.tradingClass"]').locator('..').innerText(), /两种放大重读一致/);
            await page.locator('#source-summary').click();
            const card = page.locator('.source-evidence').filter({ hasText: '组合父行 · 不计持仓' });
            assert.equal(await card.locator('.combo-leg').count(), 2);
            assert.match(await card.innerText(), /局部重读确认文字起点/);
            const parent = snapshot.sourceRows[golden.combos[0].parentRowNumber - 1];
            for (let i = 0; i < parent.combo.atomicLegRowIds.length; i++) {
                const leg = snapshot.positions.find(p => p.sourceRowIds.includes(parent.combo.atomicLegRowIds[i]));
                await card.locator('.combo-leg').nth(i).click();
                assert.equal(await page.locator('[data-field="instrument.strike"]').inputValue(), leg.instrument.strike);
                assert.equal(await page.locator('[data-field="quantity"]').inputValue(), leg.quantity);
                assert.match(await page.locator('[data-position-id="' + leg.positionId + '"]').innerText(), /组合缩进已复核/);
            }
            await page.screenshot({ path: path.join(output, 'combo-review.png'), fullPage: true });
        }
        const future = snapshot.positions.find(p => p.instrument.secType === 'FUT' && p.instrument.symbol === arg('--symbol') && p.instrument.expiryDate === arg('--expiry'));
        assert.ok(future); assert.equal(future.quantity, arg('--quantity'));
        assert.equal(future.fieldEvidence.quantity.originalValue, null);
        assert.equal(future.fieldEvidence.quantity.raw, null);
        const correction = future.fieldEvidence.quantity.corrections[0];
        assert.equal(correction.method, 'quantity_crop_consensus');
        assert.deepEqual(correction.passes.map(p => p.scale), [3,4]);
        assert.ok(correction.passes.every(p => p.value === arg('--quantity')));
        await page.locator('[data-position-id="' + future.positionId + '"]').click();
        assert.equal(await page.locator('[data-field="quantity"]').inputValue(), arg('--quantity'));
        assert.match(await page.locator('[data-field="quantity"]').locator('..').innerText(), /首次未读出.*3× \/ 4×/);
        assert.match(await page.locator('[data-position-id="' + future.positionId + '"]').innerText(), /数量局部重读/);
        await page.screenshot({ path: path.join(output, 'quantity-review.png'), fullPage: true });
        await page.locator('#confirm-all').click();
        await page.getByRole('button', { name: '确认以上字段并批量确认', exact: true }).click();
        await page.waitForFunction(()=>window.__portfolioSnapshot.getSnapshot().positions.every(p=>p.reviewStatus==='reviewed'));
        const confirmed = await page.evaluate(() => window.__portfolioSnapshot.getSnapshot());
        assert.ok([...confirmed.positions, ...confirmed.cash].every(p => p.reviewStatus === 'reviewed'));
        assert.deepEqual(confirmed.recognition.structureIssues, snapshot.recognition.structureIssues);
        assert.equal(confirmed.review.status, snapshot.recognition.structureIssues.length ? 'needs_review' : 'reviewed');
        const downloadPromise = page.waitForEvent('download'); await page.locator('#export-json').click();
        const download = await downloadPromise, target = path.join(output, 'export.json'); await download.saveAs(target);
        await page.locator('#json-file').setInputFiles(target);
        await page.waitForFunction(() => document.querySelector('#message').textContent.includes('JSON 已导入'));
        const imported = await page.evaluate(() => window.__portfolioSnapshot.getSnapshot());
        assert.deepEqual(imported.positions.find(p => p.positionId === future.positionId).fieldEvidence.quantity, future.fieldEvidence.quantity);
        assert.deepEqual(imported.sourceRows.map(r => r.hierarchyEvidence), snapshot.sourceRows.map(r => r.hierarchyEvidence));
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
        console.log('Quantity browser acceptance passed: live OCR, aligned scale consensus, value/evidence visible, bulk review, JSON round trip, mobile layout.');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
