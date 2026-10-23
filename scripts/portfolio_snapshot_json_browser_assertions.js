/* JSON import/review acceptance; no OCR, cloud requests, broker or database. */
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const argument = key => process.argv[process.argv.indexOf(key) + 1];
assert.ok(['--json','--image','--output'].every(key => process.argv.includes(key)));
const jsonFile = path.resolve(argument('--json')), image = path.resolve(argument('--image'));
const output = path.resolve(argument('--output'));
const url = process.argv.includes('--url') ? argument('--url') : 'http://127.0.0.1:8801';
assert.ok(['127.0.0.1','localhost'].includes(new URL(url).hostname));
assert.notEqual(new URL(url).port, '8765');
const input = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
fs.mkdirSync(output, {recursive:true});
(async () => {
    const browser = await chromium.launch({headless:true, channel:'chrome'});
    try {
        const context = await browser.newContext({viewport:{width:1536,height:1000}, acceptDownloads:true});
        const page = await context.newPage(), errors = [], forbidden = [];
        let recognitionRequests = 0;
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', d => d.accept());
        await page.route('**/*', route => {
            const target = new URL(route.request().url());
            if (target.pathname === '/api/recognize') recognitionRequests++;
            if (target.pathname.startsWith('/api/')) return route.fulfill({status:404,contentType:'application/json',body:'{}'});
            if (target.origin === new URL(url).origin || ['blob:','data:'].includes(target.protocol)) return route.continue();
            forbidden.push(target.origin); return route.abort();
        });
        await page.goto(url + '/portfolio_snapshot.html');
        assert.ok(await page.locator('.top-actions #import-json').isVisible());
        assert.equal(await page.locator('#import-json').isEnabled(), true);
        const box = await page.locator('#import-json').boundingBox();
        assert.ok(box.y + box.height <= 1000, 'import must be visible before scrolling');
        await page.screenshot({path:path.join(output,'import-entry.png'),fullPage:false});
        const drop = async files => page.evaluate(files => {
            const data = new DataTransfer();
            for (const file of files) data.items.add(new File([new Uint8Array(file.bytes)], file.name, {type:file.type}));
            document.querySelector('#drop-zone').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:data}));
        }, files);
        const jsonDrop = {name:path.basename(jsonFile).replace(/\.json$/i,'.JSON'),type:'',bytes:[...fs.readFileSync(jsonFile)]};
        const imageDrop = {name:path.basename(image),type:input.sources[0].mimeType,bytes:[...fs.readFileSync(image)]};
        await drop([jsonDrop]);
        await page.waitForFunction(n => window.__portfolioSnapshot.getSnapshot().positions.length === n, input.positions.length);
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input, 'JSON drop works without OCR or image');
        assert.match(await page.locator('#upload-title').innerText(), /JSON/);
        await page.locator('#row-filter').selectOption('edited');
        const chooser = page.waitForEvent('filechooser');
        await page.locator('#import-json').click();
        await (await chooser).setFiles(jsonFile);
        await page.waitForFunction(n => window.__portfolioSnapshot.getSnapshot().positions.length === n, input.positions.length);
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input);
        assert.equal(await page.locator('#positions-body tr').count(), input.positions.length);
        assert.equal(await page.locator('#row-filter').inputValue(), 'all');
        await drop([imageDrop]);
        await page.waitForFunction(() => document.querySelector('#source-image').naturalWidth > 0);
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input, 'matching image must preserve imported fields and evidence');
        await drop([{name:'invalid.json',type:'application/json',bytes:[...Buffer.from('{broken')]}]);
        await page.waitForFunction(() => document.querySelector('#message').textContent.includes('导入失败'));
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input);
        assert.ok(await page.locator('#source-image').isVisible());
        await drop([{name:'unknown.json',type:'',bytes:[...Buffer.from(JSON.stringify({...input,schemaVersion:999}))]}]);
        await page.waitForFunction(() => document.querySelector('#message').textContent.includes('不支持'));
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input);
        await drop([jsonDrop,imageDrop]);
        assert.match(await page.locator('#message').innerText(), /一次拖入/);
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input);
        await page.locator('#image-file').setInputFiles(jsonFile);
        await page.waitForFunction(() => document.querySelector('#upload-caption').textContent.includes('已关联同一原图'));
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input, 'shared file picker also accepts JSON');
        assert.deepEqual(await page.locator('#ocr-engine option').evaluateAll(options=>options.map(o=>o.value)), ['rapidocr','apple-vision','local-codex']);
        for (const p of input.positions) {
            await page.locator('[data-position-id="' + p.positionId + '"]').click();
            for (const [field, evidence] of Object.entries(p.fieldEvidence)) {
                const expected = await page.evaluate(({p,field}) => {
                    const S=window.OptionComboPortfolioSnapshotSchema, f=S.FIELDS.find(f=>f.path===field), value=S.get(p,field);
                    return f.kind==='percent' && value!==null ? S.percentDisplay(value) : value ?? '';
                }, {p,field});
                assert.equal(await page.locator('[data-field="' + field + '"]').inputValue(), expected, field);
                if (evidence.source === 'ai') assert.match(await page.locator('[data-field="' + field + '"]').locator('..').innerText(), /AI 读取原文/);
                if (evidence.interpretation?.method === 'chat_visual_typography')
                    assert.match(await page.locator('[data-field="' + field + '"]').locator('..').innerText(), /视觉解读/);
            }
        }
        await page.locator('#json-file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{broken')});
        await page.waitForFunction(() => document.querySelector('#message').textContent.includes('导入失败'));
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input);
        await page.locator('#json-file').setInputFiles({name:'wrong-schema.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...input,schemaVersion:999}))});
        await page.waitForFunction(() => document.querySelector('#message').textContent.includes('不支持'));
        assert.deepEqual(await page.evaluate(() => window.__portfolioSnapshot.getSnapshot()), input);
        const first = input.positions[0];
        await page.locator('[data-position-id="' + first.positionId + '"]').click();
        const quantity=page.locator('[data-field="quantity"]');
        await quantity.fill(String(Number(first.quantity || '0') + 1)); await quantity.blur();
        const edited=await page.evaluate(() => window.__portfolioSnapshot.getSnapshot());
        assert.equal(edited.positions[0].fieldEvidence.quantity.raw, first.fieldEvidence.quantity.raw);
        assert.equal(edited.positions[0].fieldEvidence.quantity.source, 'manual');
        await page.locator('#json-details').evaluate(el => {el.open=true;el.dispatchEvent(new Event('toggle'));});
        const readable=await page.locator('#json-preview').innerText();
        assert.match(readable,/\n  "schemaVersion": 1,/);
        assert.deepEqual(JSON.parse(readable), edited);
        const downloadEvent=page.waitForEvent('download'); await page.locator('#export-json').click();
        const download=await downloadEvent;
        assert.equal(download.suggestedFilename(), path.basename(image).replace(/\.(?:jpe?g|png)$/i,'.json'));
        const exported=path.join(output,'browser-export.json'); await download.saveAs(exported);
        const text=fs.readFileSync(exported,'utf8'); assert.match(text,/\n  "schemaVersion": 1,/);
        assert.deepEqual(JSON.parse(text),edited);
        assert.deepEqual(errors,[]); assert.deepEqual(forbidden,[]);
        assert.equal(recognitionRequests,0,'JSON import/drop must never trigger recognition');
        await page.locator('#review-grid').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(output,'imported-review.png'),fullPage:false});
        const report={topImportVisible:true,importedPositions:input.positions.length,reviewedFields:input.positions.length*20,
            originalImageMatched:true,invalidImportsPreserveTable:true,manualEditRetainsRaw:true,readableRoundTrip:true,
            jsonDrop:true,imageDropPreservesTable:true,badDropsPreserveTable:true,multipleFilesRejected:true,
            sharedPickerAcceptsJson:true,recognitionRequests,allThreeEnginesRetained:true,
            exportName:download.suggestedFilename(),pageErrors:errors,unexpectedRequests:forbidden};
        fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
    } finally { await browser.close(); }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
