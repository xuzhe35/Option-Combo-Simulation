/* Browser regression for file entry and OCR service recovery; uses a synthetic image. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:8798';
async function dropImage(page) {
    await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
        canvas.getContext('2d').fillRect(0, 0, 40, 40);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const data = new DataTransfer(); data.items.add(new File([blob], 'synthetic.png', { type: 'image/png' }));
        document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await page.waitForFunction(() => window.__portfolioSnapshot.getSnapshot().sources.length === 1);
}
(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    try {
        const page = await browser.newPage();
        const errors = [], capabilities = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (r.url().endsWith('/api/capabilities')) capabilities.push(r.url()); });
        await page.goto(pathToFileURL(path.join(root, 'portfolio_snapshot.html')).href);
        await page.waitForFunction(() => window.__portfolioSnapshot);
        assert.equal(await page.locator('#file-mode-notice').isVisible(), true);
        assert.equal(await page.locator('#recognize').isVisible(), false);
        assert.equal(await page.locator('#open-ocr-page').isVisible(), true);
        await dropImage(page);
        assert.match(await page.locator('#message').innerText(), /打开识别页面/);
        await page.locator('#add-position').click();
        const before = await page.evaluate(() => window.__portfolioSnapshot.getSnapshot());
        const popupPromise = page.waitForEvent('popup');
        await page.locator('#open-ocr-page').click();
        const popup = await popupPromise;
        await popup.waitForURL(origin + '/portfolio_snapshot.html');
        await popup.waitForFunction(() => document.querySelector('#service-status').textContent.includes('已就绪'));
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), before);
        assert.equal(capabilities.length, 0, 'File page must not send opaque-origin OCR requests');
        await popup.close();
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

        const http = await browser.newPage(); http.on('pageerror', e => errors.push(e.message));
        let ready = false, checks = 0;
        await http.route('**/api/capabilities', route => {
            checks++;
            return route.fulfill({ status: ready ? 200 : 503, json: { ocrAvailable: ready, localOnly: true } });
        });
        await http.goto(origin + '/portfolio_snapshot.html');
        await http.waitForFunction(() => document.querySelector('#service-status').textContent.includes('未连接'));
        assert.equal(await http.locator('#retry-service').isEnabled(), true);
        await dropImage(http);
        await http.waitForFunction(() => !document.querySelector('#retry-service').disabled);
        assert.ok(checks >= 2, 'Dropping an image rechecks a previously unavailable service');
        assert.equal(await http.locator('#recognize').isDisabled(), true);
        assert.match(await http.locator('#recognize-note').innerText(), /重新连接/);
        await http.locator('#add-position').click();
        const saved = await http.evaluate(() => window.__portfolioSnapshot.getSnapshot());
        ready = true;
        await http.locator('#retry-service').click();
        await http.waitForFunction(() => !document.querySelector('#recognize').disabled);
        assert.deepEqual(await http.evaluate(() => window.__portfolioSnapshot.getSnapshot()), saved);
        assert.equal(await http.locator('#retry-service').isVisible(), false);
        assert.deepEqual(errors, []);
        console.log('Connection acceptance passed: file entry explains and opens HTTP, preserves source/draft, mobile layout; service retry and image-triggered recheck preserve memory.');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
