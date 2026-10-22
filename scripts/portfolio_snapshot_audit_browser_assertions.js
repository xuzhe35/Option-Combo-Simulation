/* Audit UX regression. Static portal has no OCR; API fixtures below are explicitly synthetic. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const { image } = require('../tests/portfolio_snapshot_structure.test');
const origin = 'http://127.0.0.1:8801';
(async () => {
    const browser = await chromium.launch({ channel:'chrome', headless:true });
    try {
        const page = await browser.newPage({acceptDownloads:true}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
        let available=false;
        await page.route('**/api/capabilities',route=>route.fulfill({status:available?200:503,json:{ocrAvailable:available,localOnly:true}}));
        await page.goto(origin+'/cost_basis.html');
        const link=page.locator('a[href="portfolio_snapshot.html"]');assert.equal(await link.count(),1);
        const popup=page.waitForEvent('popup');await link.click();const app=await popup;app.on('pageerror',e=>errors.push(e.message));
        await app.route('**/api/capabilities',route=>route.fulfill({status:available?200:503,json:{ocrAvailable:available,localOnly:true}}));
        await app.waitForURL(origin+'/portfolio_snapshot.html');
        await app.waitForFunction(()=>window.__portfolioSnapshot);
        await app.locator('#service-status').click();
        await app.waitForFunction(()=>document.querySelector('#service-status').textContent.includes('未连接'));
        await app.evaluate(async()=>{
            const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;
            const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
            const dt=new DataTransfer();dt.items.add(new File([blob],'synthetic.png',{type:'image/png'}));
            document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
        });
        await app.waitForFunction(()=>window.__portfolioSnapshot.getSnapshot().sources.length===1);
        assert.equal(await app.locator('#recognize').isDisabled(),true);
        await app.locator('#add-position').click();await app.locator('[data-field="instrument.symbol"]').fill('ABC');await app.locator('[data-field="instrument.symbol"]').press('Tab');
        await app.locator('[data-field="quantity"]').fill('4');await app.locator('[data-field="quantity"]').press('Tab');
        await app.locator('[data-field="instrument.secType"]').selectOption('STK');
        const d=app.waitForEvent('download');await app.locator('#export-json').click();const download=await d;
        const target=path.join('/tmp','portfolio-snapshot-audit-roundtrip.json');await download.saveAs(target);
        assert.equal(JSON.parse(fs.readFileSync(target)).positions[0].quantity,'4');
        app.once('dialog',dialog=>dialog.accept('人工确认是装饰文字'));await app.locator('#exclude-position').click();
        assert.equal(await app.evaluate(()=>window.__portfolioSnapshot.getSnapshot().positions.length),0);
        app.once('dialog',dialog=>dialog.accept());await app.locator('#json-file').setInputFiles(target);
        // Native replacement confirmation may have opened immediately after input change.
        await app.waitForFunction(()=>window.__portfolioSnapshot.getSnapshot().positions.length===1);
        available=true;await app.locator('#retry-service').click();await app.waitForFunction(()=>!document.querySelector('#recognize').disabled);
        const snapshot=await app.evaluate(()=>window.__portfolioSnapshot.getSnapshot());
        let raw=image([{desc:'ABC Calendar',qty:'9'},{desc:"ABC Oct21'30 50 PUT",qty:'1',indent:.112}]);
        raw={...raw,sourceHash:snapshot.sources[0].sha256,width:40,height:40};
        let failQuantity=false;
        await app.route('**/api/recognize',route=>route.fulfill(failQuantity && route.request().postDataJSON().quantityCrops
            ? {status:503,json:{message:'Synthetic crop failure'}} : {json:raw}));
        await app.locator('#recognize').click();await app.getByRole('button',{name:'采用新结果',exact:true}).click();
        await app.waitForFunction(()=>window.__portfolioSnapshot.getSnapshot().sourceRows[0]?.combo?.status==='incomplete');
        await app.locator('#confirm-all').click();assert.equal(await app.evaluate(()=>window.__portfolioSnapshot.getSnapshot().review.status),'needs_review');
        await app.locator('#structure-actions input').fill('已对照图片，接受仅显示一腿');
        await app.getByRole('button',{name:'已核对，接受此疑点',exact:true}).click();
        assert.equal(await app.evaluate(()=>window.__portfolioSnapshot.getSnapshot().review.status),'reviewed');
        raw=image([{desc:'ABC',qty:'1'}]);
        raw.words.push({text:'CA...',bbox:[.24,.1,.03,.012]});
        // A separate prefix case exercises one batch list, cancellation and persistent warnings.
        raw=image([{desc:"ABC Oct21'30 55 CA...",qty:'1'}]);raw={...raw,sourceHash:snapshot.sources[0].sha256,width:40,height:40};
        await app.locator('#recognize').click();await app.getByRole('button',{name:'采用新结果',exact:true}).click();
        await app.waitForFunction(()=>window.__portfolioSnapshot.getSnapshot().positions[0]?.instrument.right==='C');
        await app.locator('#confirm-all').click();assert.match(await app.locator('dialog').innerText(),/Call \/ Put.*CA\.\.\..*C/);
        await app.getByRole('button',{name:'返回检查',exact:true}).click();
        assert.equal(await app.evaluate(()=>window.__portfolioSnapshot.getSnapshot().positions[0].reviewStatus),'unreviewed');
        await app.locator('#confirm-all').click();await app.getByRole('button',{name:'确认以上字段并批量确认',exact:true}).click();
        await app.waitForFunction(()=>window.__portfolioSnapshot.getSnapshot().positions.every(p=>p.reviewStatus==='reviewed'));
        assert.equal(await app.evaluate(()=>window.__portfolioSnapshot.getSnapshot().positions[0].reviewStatus),'reviewed');
        await app.locator('#row-filter').selectOption('problems');assert.equal(await app.locator('#positions-body tr[data-position-id]').count(),1);
        assert.ok(await app.evaluate(()=>window.__portfolioSnapshot.getSnapshot().review.machineAcknowledgement.fields.length));
        // Second-request failures preserve the first image and valid first-pass
        // fields. Unknown quantity must remain unknown, with a persistent flag.
        failQuantity=true;raw={...image([{desc:"ABC Dec18'30 @CME",qty:null}]),sourceHash:snapshot.sources[0].sha256,width:40,height:40};
        await app.locator('#row-filter').selectOption('all');await app.locator('#recognize').click();
        await app.getByRole('button',{name:'采用新结果',exact:true}).click();
        await app.waitForFunction(()=>window.__portfolioSnapshot.getSnapshot().recognition.quantityRereadStatus==='unavailable');
        const partial=await app.evaluate(()=>window.__portfolioSnapshot.getSnapshot());
        assert.equal(partial.positions.length,1);assert.equal(partial.positions[0].quantity,null);assert.equal(partial.positions[0].instrument.secType,'FUT');
        assert.ok(partial.positions[0].issues.some(s=>s.includes('局部复核未完成')&&s.includes('首轮原文')));assert.equal(partial.sources[0].sha256,snapshot.sources[0].sha256);
        await app.setViewportSize({width:390,height:844});assert.equal(await app.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        assert.deepEqual(errors,[]);
        console.log('Audit UI passed: relative ledger entry without OCR, image/manual JSON round trip, exclusion and structure acceptance, cancellable batch machine-change list, persistent flags, quantity-failure fallback, mobile.');
    } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
