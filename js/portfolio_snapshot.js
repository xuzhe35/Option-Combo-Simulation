(function (g) {
    'use strict';
    if (typeof document === 'undefined') return;
    const S = g.OptionComboPortfolioSnapshotSchema, C = g.OptionComboPortfolioSnapshotCore, O = g.OptionComboPortfolioSnapshotOcr;
    const $ = id => document.getElementById(id), now = () => new Date().toISOString();
    const uid = () => g.crypto?.randomUUID?.() || 'snapshot-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    let portfolioSnapshotState = S.empty(uid(), now());
    let sourceFile = null, sourceUrl = null, selectedId = null, selectedSourceId = null, generation = 0, controller = null;
    let dirty = false, busy = false, available = false, metadataInvalid = false, imageLoadGeneration = 0;
    const fileMode = location.protocol === 'file:';
    let serviceCheck = null, checkingService = false, engines = {};
    const endpoints = [...new Set([...(location.protocol.startsWith('http') ? [location.origin] : []), 'http://127.0.0.1:8798'])];
    let endpoint = endpoints[0];
    function node(tag, text, cls) {
        const n = document.createElement(tag);
        if (text !== undefined) n.textContent = text;
        if (cls) n.className = cls;
        return n;
    }
    function message(text, error = false) {
        $('message').textContent = text;
        $('message').classList.toggle('error', error);
        $('message').hidden = !text;
    }
    function format(value, percent = false) {
        if (value === null || value === undefined) return '—';
        return percent ? (Number(value) * 100).toLocaleString('en-US', { maximumFractionDigits: 6 }) + '%'
            : Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 });
    }
    function sourceRow(p) { return portfolioSnapshotState.sourceRows.find(r => p.sourceRowIds.includes(r.rowId)); }
    function displayTitle(p) {
        const i = p.instrument;
        return [i.symbol || '未知标的', i.secType, i.expiryDate,
            i.strike, i.right === 'C' ? 'CALL' : i.right === 'P' ? 'PUT' : null].filter(Boolean).join(' ');
    }
    function renderJson() {
        if ($('json-details').open) { try { $('json-preview').textContent = S.serialize(portfolioSnapshotState); } catch (e) { $('json-preview').textContent = e.message; } }
        $('export-json').disabled = metadataInvalid || !!document.querySelector('[aria-invalid="true"]') || (!portfolioSnapshotState.sources.length && !portfolioSnapshotState.positions.length);
    }
    function renderTable() {
        const stats = C.stats(portfolioSnapshotState), filter = $('row-filter').value;
        renderBulkConfirmation();
        $('stat-positions').textContent = stats.positions;
        $('stat-pending').textContent = stats.positions - stats.reviewed;
        $('stat-problems').textContent = stats.problems;
        $('stat-cash').textContent = stats.cash;
        $('position-count').textContent = stats.positions;
        $('review-progress').textContent = stats.reviewed + ' / ' + stats.positions + ' 已核对';
        const structures = C.pendingIssues(portfolioSnapshotState);
        $('structure-warning').hidden = !structures.length;
        $('structure-warning').textContent = structures.map(s => s.message).join(' ');
        const body = $('positions-body'); body.replaceChildren();
        const extra = $('table-columns').value === 'all' ? S.FIELDS.filter(f => f.path.startsWith('displayValues.') && !['displayValues.mark', 'displayValues.displayIv'].includes(f.path)) : [];
        const head = $('positions-table').querySelector('thead tr');
        head.replaceChildren(...['状态', '合约 / 原图描述', '数量', 'MARK', '展示 IV', ...extra.map(f => f.label), '疑点'].map(t => node('th', t)));
        const visible = portfolioSnapshotState.positions.filter(p => filter === 'all'
            || (filter === 'pending' && p.reviewStatus !== 'reviewed')
            || (filter === 'problems' && C.issues(p).length)
            || (filter === 'edited' && portfolioSnapshotState.review.changes.some(c => c.positionId === p.positionId)));
        for (const p of visible) {
            const tr = node('tr'); tr.dataset.positionId = p.positionId;
            tr.tabIndex = 0; tr.classList.toggle('selected', selectedId === p.positionId);
            tr.setAttribute('aria-selected', String(selectedId === p.positionId));
            tr.addEventListener('click', () => select(p.positionId, true));
            tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.positionId, true); } });
            const state = node('td'), reviewed = p.reviewStatus === 'reviewed';
            state.append(node('span', reviewed ? '✓ 已核对' : '待核对', 'row-state' + (reviewed ? ' reviewed' : '')));
            const contract = node('td', undefined, 'contract-cell');
            contract.append(node('strong', displayTitle(p)), node('small', sourceRow(p)?.rawCells?.description || '手工添加'));
            if (sourceRow(p)?.ocrRefinements?.some(r => r.status === 'agreed')) contract.append(node('span', '2× / 3× 局部重读', 'reread-badge'));
            if (sourceRow(p)?.quantityRefinement) contract.append(node('span', '数量局部重读', 'reread-badge'));
            if (sourceRow(p)?.rowRefinement) contract.append(node('span', '合约行已局部复核', 'reread-badge'));
            if (sourceRow(p)?.averageRefinement) contract.append(node('span', '均价已局部复核', 'reread-badge'));
            if (sourceRow(p)?.excludedDecorations?.length) contract.append(node('span', '状态方块已按像素核对', 'reread-badge'));
            if (sourceRow(p)?.parentRowId && ['aligned_crop_ink_geometry','aligned_row_crop_ink_geometry'].includes(sourceRow(p)?.hierarchyEvidence?.indentMeasurement?.method)) {
                const badge = node('span', '组合缩进已复核', 'reread-badge');
                badge.title = '按 2× / 3× 局部重读共同确认的文字起点识别归属，保留首轮位置及两份重读证据。'; contract.append(badge);
            }
            const quantity = node('td', format(p.quantity), 'numeric ' + (Number(p.quantity) < 0 ? 'quantity-negative' : 'quantity-positive'));
            const problems = C.issues(p), last = node('td');
            if (problems.length) { last.append(node('span', problems.length + ' 项', 'problem-count')); last.title = problems.join('\n'); }
            else last.textContent = '—';
            tr.append(state, contract, quantity, node('td', format(p.displayValues.mark), 'numeric'),
                node('td', format(p.displayValues.displayIv, true), 'numeric'),
                ...extra.map(f => node('td', format(S.get(p, f.path)), 'numeric')), last);
            body.append(tr);
        }
        $('positions-empty').hidden = stats.positions > 0;
        $('positions-empty').querySelector('strong').textContent = portfolioSnapshotState.sourceRows.length ? '尚未形成可确认的原子持仓' : '识别结果会出现在这里';
        $('positions-empty').querySelector('p').textContent = portfolioSnapshotState.sourceRows.length
            ? '已保留组合或未分类原文。请展开组合重新截图，或核对下方结构疑点；没有将未知组合当作单独持仓。'
            : '载入图片后点击「识别持仓」。对照原图检查后，可批量确认全部持仓与现金。';
        $('positions-table').hidden = stats.positions === 0;
        if (!visible.length && stats.positions) {
            const tr = node('tr'), td = node('td', '当前筛选没有持仓'); td.colSpan = 6 + extra.length; tr.append(td); body.append(tr);
        }
        renderJson();
    }
    function renderEvidence() {
        renderStructureActions();
        const summaries = portfolioSnapshotState.sourceRows.filter(r => !['position', 'cash'].includes(r.rowType));
        $('source-summary').textContent = '分组、组合与排除行（' + summaries.length + '，均不计入持仓）';
        $('source-rows').replaceChildren(...summaries.map(r => {
            const el = node('div', undefined, 'source-evidence');
            el.append(node('b', r.rowType === 'combo_summary' ? '组合父行 · 不计持仓' : r.rowType === 'unclassified' ? '未分类 · 待核对' : r.rowType === 'decoration' ? '装饰 / 排除行 · 不计持仓' : '分组汇总'), node('span', r.rawText));
            if (r.exclusion) el.append(node('small', '排除原因：' + r.exclusion.reason));
            if (r.rowType === 'unclassified') { const exclude = node('button', '排除此行'); exclude.onclick = () => excludeSource(r.rowId); el.append(exclude); }
            const locate = node('button', '查看原图'); locate.onclick = () => selectSource(r.rowId); el.append(locate);
            if (r.combo) {
                const count = r.combo.atomicLegRowIds.length;
                el.append(node('p', r.combo.status === 'expanded_visible' ? '按缩进识别到 ' + count + ' 条可见原子腿；不推定组合的总腿数。'
                    : r.combo.status === 'collapsed' ? '没有可见子腿；请展开组合再识别，不猜测腿数或数量。' : '仅见部分腿或有未分类子行，请核对完整性。', 'combo-status'));
                if (portfolioSnapshotState.sourceRows.some(child => child.parentRowId === r.rowId
                    && ['aligned_crop_ink_geometry','aligned_row_crop_ink_geometry'].includes(child.hierarchyEvidence?.indentMeasurement?.method))) {
                    el.append(node('small', '归属依据：两种放大局部重读确认文字起点；原始缩进位置和重读证据保留在 JSON。'));
                }
                for (const id of r.combo.atomicLegRowIds) {
                    const p = portfolioSnapshotState.positions.find(p => p.sourceRowIds.includes(id));
                    if (!p) continue;
                    const leg = node('button', displayTitle(p) + ' · 数量 ' + format(p.quantity), 'combo-leg');
                    leg.onclick = () => { $('tab-review').click(); select(p.positionId, true); }; el.append(leg);
                }
            }
            return el;
        }));
        const cashEl = $('cash-rows'); cashEl.replaceChildren();
        for (const cash of portfolioSnapshotState.cash) {
            const line = node('div', undefined, 'cash-row'), label = node('label', (cash.currency || '未知币种') + ' 现金 ');
            const input = node('input'); input.type = 'text'; input.value = cash.amount || ''; input.setAttribute('aria-label', '现金金额');
            input.addEventListener('change', () => {
                try {
                    const current = portfolioSnapshotState.cash.find(c => c.sourceRowId === cash.sourceRowId);
                    const value = S.decimal(input.value), before = current.amount;
                    current.amount = value; current.reviewStatus = 'unreviewed'; dirty = true;
                    portfolioSnapshotState.review.status = C.reviewStatus(portfolioSnapshotState);
                    portfolioSnapshotState.review.changes.push({ sourceRowId: cash.sourceRowId, field: 'cash.amount', before, after: value, atUtc: now() });
                    input.setAttribute('aria-invalid', 'false'); renderEvidence(); renderBulkConfirmation(); renderJson();
                } catch (e) { input.setAttribute('aria-invalid', 'true'); message(e.message, true); renderJson(); }
            });
            const review = node('label'), check = node('input'); check.type = 'checkbox'; check.checked = cash.reviewStatus === 'reviewed';
            check.addEventListener('change', () => {
                if (input.getAttribute('aria-invalid') === 'true') { check.checked = false; message('请先更正现金金额。', true); return; }
                portfolioSnapshotState.cash.find(c => c.sourceRowId === cash.sourceRowId).reviewStatus = check.checked ? 'reviewed' : 'unreviewed';
                portfolioSnapshotState.review.status = C.reviewStatus(portfolioSnapshotState);
                dirty = true; renderBulkConfirmation(); renderJson();
            });
            label.append(input); review.append(check, document.createTextNode(' 已核对现金'));
            line.append(label, node('small', '原文：' + (cash.raw ?? '未读出')), review);
            for (const text of C.cashIssues(cash)) line.append(node('span', text, 'cash-problem'));
            cashEl.append(line);
        }
        const rec = portfolioSnapshotState.recognition;
        $('ocr-raw').textContent = rec.originalLines ? rec.originalLines.map(l => l.text).join('\n')
            + '\n\n局部重读：\n' + JSON.stringify(rec.refinements || [], null, 2)
            + '\n\n未归类行：\n' + (rec.unmatchedRows || []).map(r => r.rawText).join('\n') : '尚未识别';
    }
    function renderEditor() {
        const p = portfolioSnapshotState.positions.find(p => p.positionId === selectedId);
        $('editor').hidden = !p;
        if (!p) return;
        $('editor-title').textContent = displayTitle(p);
        $('selected-raw').textContent = sourceRow(p)?.rawText || '手工添加';
        $('selected-issues').replaceChildren(...C.issues(p).map(t => node('span', t)));
        $('confirm-row').textContent = p.reviewStatus === 'reviewed' ? '✓ 已核对' : '✓ 已核对这一行';
        const editor = $('field-editor'); editor.replaceChildren();
        for (const f of S.FIELDS) {
            const evidence = p.fieldEvidence[f.path], value = S.get(p, f.path);
            const label = node('label', f.label, evidence?.source === 'manual' ? 'edited' : '');
            let input;
            if (f.kind === 'type' || f.kind === 'right') {
                input = node('select');
                const values = f.kind === 'type' ? ['UNKNOWN', 'STK', 'OPT', 'FUT', 'FOP'] : ['', 'C', 'P'];
                values.forEach(v => { const option = node('option', v || '未知 / 不适用'); option.value = v; input.append(option); });
            } else {
                input = node('input'); input.type = f.kind === 'date' ? 'date' : 'text';
                if (['number', 'percent'].includes(f.kind)) input.inputMode = 'decimal';
                input.placeholder = '未知 / 原图不可读';
            }
            input.value = f.kind === 'percent' && value !== null ? S.percentDisplay(value) : value ?? '';
            input.dataset.field = f.path;
            input.setAttribute('aria-label', f.label);
            input.addEventListener('focus', () => {
                const layout=portfolioSnapshotState.recognition.tableLayout;
                const key=f.path.startsWith('displayValues.')?f.path.split('.')[1]:f.path.startsWith('instrument.')?'description':f.path;
                const column=layout?.headers?.find(h=>h.key===key);
                if(!column)return;
                const scroller = document.querySelector('.crop-scroll');
                scroller.scrollLeft = Math.max(0, (column.left+column.right)/2 * $('row-crop').clientWidth - scroller.clientWidth / 2);
            });
            input.addEventListener('change', () => {
                try {
                    portfolioSnapshotState = C.edit(portfolioSnapshotState, p.positionId, f.path, input.value, now());
                    dirty = true; input.setAttribute('aria-invalid', 'false'); message('已修改 ' + f.label + '；请重新核对本行。');
                    renderTable(); renderEditor();
                } catch (e) { input.setAttribute('aria-invalid', 'true'); message(e.message, true); renderJson(); }
            });
            label.append(input, node('small', 'OCR 原文：' + (evidence?.raw ?? '未读出 / 未提供')));
            if(evidence?.availability==='column_not_present')label.append(node('small','原图没有此列，保留未知；不会从其他列补值。'));
            if (evidence?.corrections?.length) label.append(node('small', (evidence.corrections[0].method === 'quantity_crop_consensus'
                ? '首次未读出 → 数量单元格 3× / 4× 重读一致：' : '首次值 ' + (evidence.originalValue ?? '未确认') + ' → 两种放大重读一致：')
                + evidence.recognizedValue + '（仍需人工核对）', 'reread-note'));
            if (evidence?.interpretation?.method === 'option_right_prefix') label.append(node('small',
                '按类型前缀 ' + evidence.interpretation.token + ' 判定为 ' + (evidence.interpretation.value === 'C' ? 'CALL' : 'PUT'), 'reread-note'));
            editor.append(label);
        }
    }
    function highlight(scroll = false) {
        const p = portfolioSnapshotState.positions.find(p => p.positionId === selectedId);
        const row = portfolioSnapshotState.sourceRows.find(r => r.rowId === selectedSourceId) || (p && sourceRow(p)), image = $('source-image');
        const box = row?.bbox;
        $('row-highlight').hidden = !box || !sourceUrl;
        $('crop-panel').hidden = !box || !sourceUrl;
        if (!box || !sourceUrl || !image.naturalWidth) return;
        const high = $('row-highlight'); high.style.top = (box[1] * 100) + '%'; high.style.height = (box[3] * 100) + '%';
        if (scroll) $('image-scroll').scrollTop = Math.max(0, high.offsetTop - $('image-scroll').clientHeight / 2);
        const canvas = $('row-crop'), width = image.naturalWidth, height = image.naturalHeight;
        const y = Math.max(0, box[1] * height - 7), h = Math.min(height - y, box[3] * height + 14);
        canvas.width = width; canvas.height = Math.ceil(h);
        canvas.style.width = Math.max(width * .8, 1250) + 'px';
        canvas.style.height = 'auto';
        canvas.getContext('2d').drawImage(image, 0, y, width, h, 0, 0, width, h);
    }
    function select(id, reveal = false) {
        if (document.querySelector('#field-editor [aria-invalid="true"]')) { message('请先更正当前无效字段，或清空为未知，再切换持仓。', true); return; }
        selectedId = id;
        selectedSourceId = portfolioSnapshotState.positions.find(p => p.positionId === id)?.sourceRowIds[0] || null;
        renderTable(); renderEditor();
        $('crop-title').textContent = '选中持仓行 · 放大核对'; highlight(true);
        if (reveal) $('editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function selectSource(id) {
        if (document.querySelector('#field-editor [aria-invalid="true"]')) { message('请先更正当前无效字段。', true); return; }
        selectedId = null; selectedSourceId = id; renderTable(); renderEditor(); $('tab-review').click();
        $('crop-title').textContent = '组合 / 结构原文 · 放大核对'; highlight(true);
        document.querySelector('.source-panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function stopRecognition() {
        generation++; controller?.abort(); controller = null; busy = false;
        $('cancel-ocr').hidden = true; $('recognize').textContent = '识别持仓 ↗';
        renderRecognitionControls();
    }
    function releaseImage() {
        if (sourceUrl) URL.revokeObjectURL(sourceUrl);
        sourceUrl = null; sourceFile = null;
        $('source-image').removeAttribute('src'); $('source-image').hidden = true;
        $('image-empty').hidden = false; $('row-highlight').hidden = true; $('crop-panel').hidden = true;
        $('image-info').textContent = '尚未载入图片';
        renderRecognitionControls();
    }
    async function loadImage(file) {
        if (!file) return;
        const loadGeneration = ++imageLoadGeneration;
        if (file.size > S.LIMITS.bytes) throw new Error('图片超过 4 MiB，请另存缩小副本后再拖入。');
        const bytes = await file.arrayBuffer(), head = new Uint8Array(bytes);
        const jpeg = head[0] === 255 && head[1] === 216 && head[2] === 255;
        const png = head.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10';
        if (!jpeg && !png) throw new Error('请选择实际的 PNG / JPEG 图片，仅修改文件后缀无效。');
        let bitmap;
        try { bitmap = await createImageBitmap(file); } catch (_) { throw new Error('图片无法解码，请重新导出为 PNG / JPEG。'); }
        const width = bitmap.width, height = bitmap.height; bitmap.close();
        if (width > S.LIMITS.edge || height > S.LIMITS.edge || width * height > S.LIMITS.pixels) throw new Error('图片超过 8192 像素或 2000 万像素限制。');
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(x => x.toString(16).padStart(2, '0')).join('');
        if (loadGeneration !== imageLoadGeneration) return;
        const same = portfolioSnapshotState.sources[0]?.sha256 === hash;
        if (!same && dirty && (portfolioSnapshotState.sourceRows.length || portfolioSnapshotState.asOf.date) && !confirm('换成不同图片会清空当前快照和截图日期。请先导出需要保留的 JSON，继续替换吗？')) return;
        stopRecognition(); releaseImage();
        if (!same) {
            const account = S.clone(portfolioSnapshotState.account);
            portfolioSnapshotState = S.empty(uid(), now()); portfolioSnapshotState.account = account;
            selectedId = null; selectedSourceId = null; $('asof').value = '';
        }
        sourceFile = file; sourceUrl = URL.createObjectURL(file);
        portfolioSnapshotState.sources = [{ sourceId: 'image-1', sha256: hash, mimeType: jpeg ? 'image/jpeg' : 'image/png', width, height,
            fileName: file.name, recognitionRunId: portfolioSnapshotState.recognition.runId || null }];
        $('source-image').src = sourceUrl; $('source-image').hidden = false; $('image-empty').hidden = true;
        $('source-image').onload = () => highlight(false);
        $('upload-title').textContent = file.name;
        $('upload-caption').textContent = width + ' × ' + height + ' px · ' + (file.size / 1024 / 1024).toFixed(2) + ' MiB · 可拖入替换';
        $('image-info').textContent = width + ' × ' + height + ' px';
        renderRecognitionControls();
        dirty = true; renderTable(); renderEditor(); renderEvidence();
        message(same ? '已关联相同原图，保留当前校对表。' : fileMode
            ? '图片已载入。请点击「打开识别页面」，在新页面重新拖入图片。'
            : available ? '图片已载入。点击「识别持仓」生成待核对的表格。' : '图片已载入，正在检查识别服务；图片会保留，无需重新拖入。');
        if (!available) checkService();
    }
    function replacementPreview(candidate) {
        const old = portfolioSnapshotState.positions;
        const changes = candidate.positions.map((p, i) => {
            const before = old[i];
            if (!before) return '+ ' + displayTitle(p) + ' / 数量 ' + (p.quantity ?? '未知');
            const differences = S.FIELDS.filter(f => S.get(before, f.path) !== S.get(p, f.path));
            return differences.length ? (i + 1) + '. ' + differences.map(f => f.label + ': ' + (S.get(before, f.path) ?? '空') + ' → ' + (S.get(p, f.path) ?? '空')).join('；') : null;
        }).filter(Boolean);
        changes.push(...old.slice(candidate.positions.length).map(p => '- 移除：' + displayTitle(p) + ' / 数量 ' + (p.quantity ?? '未知')));
        const dialog = node('dialog'), title = node('h3', '重新识别结果对比');
        dialog.style.cssText = 'max-width:800px;width:90%;border:1px solid #d4dde4;border-radius:12px;padding:22px';
        dialog.append(title, node('p', '当前 ' + old.length + ' 行，新结果 ' + candidate.positions.length + ' 行。采用新结果会替换当前表和人工修改；请先导出需要保留的版本。'),
            node('pre', changes.join('\n') || '字段没有差异（人工核对状态仍会重置）。'));
        const adopt = node('button', '采用新结果', 'primary'), cancel = node('button', '保留当前表');
        dialog.append(cancel, document.createTextNode(' '), adopt); document.body.append(dialog);
        return new Promise(resolve => {
            dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'adopt'); dialog.remove(); }, { once: true });
            cancel.onclick = () => dialog.close('cancel'); adopt.onclick = () => dialog.close('adopt'); dialog.showModal();
        });
    }
    async function recognize() {
        if (!sourceFile || busy || !available || fileMode) return;
        stopRecognition(); busy = true; const current = generation, hash = portfolioSnapshotState.sources[0].sha256;
        renderBulkConfirmation();
        controller = new AbortController(); const requestController = controller;
        $('recognize').disabled = true; $('recognize').textContent = '正在读取图片…'; $('cancel-ocr').hidden = false;
        $('recognize-note').textContent = '本机离线处理中；首次启动可能需要约一分钟'; message('正在识别文字、持仓行和数字，请稍候。');
        const timeout = setTimeout(() => requestController.abort(), 115000);
        const engine = $('ocr-engine').value;
        try {
            const bytes = new Uint8Array(await sourceFile.arrayBuffer());
            if (current !== generation) return;
            let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
            const response = await fetch(endpoint + '/api/recognize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Portfolio-Preview': '1' },
                body: JSON.stringify({ image: btoa(binary), engine }), signal: requestController.signal });
            const result = await response.json();
            if (current !== generation) return;
            if (!response.ok) throw new Error(result.message || '本机识别失败');
            if (result.sourceHash !== hash) throw new Error('识别回复与当前图片不一致，已丢弃。');
            if (result.width !== portfolioSnapshotState.sources[0].width || result.height !== portfolioSnapshotState.sources[0].height) throw new Error('图片方向或尺寸不一致，请重新导出图片后识别。');
            let candidate = O.normalize(result, 'image-1');
            if (candidate.recognition.quantityCrops.length || candidate.recognition.reviewCrops.length) {
                try {
                    const payload={image:btoa(binary),engine};
                    if(candidate.recognition.quantityCrops.length)payload.quantityCrops=candidate.recognition.quantityCrops;
                    if(candidate.recognition.reviewCrops.length)payload.reviewCrops=candidate.recognition.reviewCrops;
                    const rereadResponse = await fetch(endpoint + '/api/recognize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Portfolio-Preview': '1' },
                        body: JSON.stringify(payload), signal: requestController.signal });
                    const reread = await rereadResponse.json();
                    if (current !== generation) return;
                    if (!rereadResponse.ok) throw new Error('数量局部重读失败');
                    if (reread.sourceHash !== hash || reread.width !== result.width || reread.height !== result.height || reread.engine !== result.engine) throw new Error('局部重读回复与当前图片或识别引擎不一致');
                    result.quantityRereads = reread.quantityRereads; result.reviewRereads=reread.reviewRereads; candidate = O.normalize(result, 'image-1');
                } catch (e) {
                    if (e.name === 'AbortError' || current !== generation) throw e;
                    const warning = '局部复核未完成，已保留首轮原文；未通过的行不计仓，缺失数值仍为未知，请重试或人工核对。';
                    candidate.recognition.warnings.push(warning); candidate.recognition.quantityRereadStatus = 'unavailable';
                    candidate.positions.filter(p=>p.quantity===null).forEach(p=>p.issues.push(warning));
                }
            }
            if (portfolioSnapshotState.sourceRows.length && !await replacementPreview(candidate)) return;
            if (current !== generation) return;
            portfolioSnapshotState = C.applyRecognition(portfolioSnapshotState, candidate);
            dirty = true; renderTable(); renderEvidence(); select(portfolioSnapshotState.positions[0]?.positionId);
            const s = C.stats(portfolioSnapshotState);
            message('已读取 ' + s.positions + ' 条原子持仓、' + s.cash + ' 条现金；' + s.summaries + ' 条分组 / 组合父行单独保留。全部待人工核对，识别完成不代表完全正确。'
                + (candidate.recognition.quantityRereadStatus === 'unavailable' ? ' 局部复核未完成，请查看待判定行和缺失数值。' : ''));
        } catch (e) {
            if (current === generation) message(e.name === 'AbortError' ? '识别已超时或取消，请重试。' : e.message, true);
        } finally {
            clearTimeout(timeout);
            if (current === generation) stopRecognition();
        }
    }
    function renderRecognitionControls() {
        renderBulkConfirmation();
        $('file-mode-notice').hidden = !fileMode;
        $('open-ocr-page').hidden = !fileMode;
        $('recognize').hidden = fileMode;
        $('recognize').disabled = !sourceFile || !available || busy || fileMode;
        $('retry-service').hidden = fileMode || available || busy;
        $('retry-service').disabled = checkingService;
        $('retry-service').textContent = checkingService ? '正在连接…' : '重新连接识别服务';
        $('service-status').textContent = fileMode ? '本地文件页 · 请打开识别页面' : checkingService
            ? '正在检查本机识别' : available ? '● 本机 OCR 已就绪' : '本机 OCR 未连接 · 查看启动说明';
        $('service-status').classList.toggle('unavailable', !available);
        for (const option of $('ocr-engine').options) option.disabled = !engines[option.value];
        $('ocr-engine').disabled = fileMode || busy || !available;
        if (!busy) $('recognize-note').textContent = fileMode ? '在新页面识别，当前内容会保留' : checkingService
            ? '正在检查本机 OCR，已载入图片会保留' : !available
                ? '识别服务尚未连接。启动后点击「重新连接识别服务」；已载入图片会保留'
                : !sourceFile ? '请先拖入或选择一张持仓截图' : '点击识别后，仅交给本机 OCR 处理';
    }
    async function checkService() {
        if (fileMode || busy) { renderRecognitionControls(); return; }
        if (serviceCheck) return serviceCheck;
        available = false; checkingService = true; renderRecognitionControls();
        serviceCheck = (async () => {
            for (const candidate of endpoints) {
                try {
                    const response = await fetch(candidate + '/api/capabilities', { signal: AbortSignal.timeout(4000) });
                    if (!response.ok) continue;
                    const result = await response.json();
                    if (result.ocrAvailable === true && result.localOnly === true) {
                        available = true; endpoint = candidate;
                        // Older services report one engine only: Apple Vision.
                        engines = result.engines && typeof result.engines === 'object' ? { ...result.engines } : { 'apple-vision': true };
                        if (!engines[$('ocr-engine').value]) $('ocr-engine').value = engines[result.engine] ? result.engine : Object.keys(engines).find(k => engines[k]);
                        break;
                    }
                } catch (_) { /* Try the standalone local preview service. */ }
            }
        })();
        try { await serviceCheck; }
        finally { serviceCheck = null; checkingService = false; renderRecognitionControls(); }
    }
    $('drop-zone').onclick = () => $('image-file').click();
    $('drop-zone').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('image-file').click(); } };
    $('image-file').onchange = e => { loadImage(e.target.files[0]).catch(e => message(e.message, true)); e.target.value = ''; };
    document.addEventListener('dragover', e => { e.preventDefault(); $('drop-zone').classList.add('dragover'); });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) $('drop-zone').classList.remove('dragover'); });
    document.addEventListener('drop', e => {
        e.preventDefault(); $('drop-zone').classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length !== 1) return message('本阶段一次只识别一张图，请拖入单张图片。', true);
        loadImage(files[0]).catch(e => message(e.message, true));
    });
    $('recognize').onclick = recognize;
    $('retry-service').onclick = checkService;
    $('cancel-ocr').onclick = () => { stopRecognition(); message('已取消本次识别，当前表格保留。'); };
    $('service-status').onclick = () => { document.querySelector('.service-help').open = true; checkService(); };
    $('row-filter').onchange = renderTable;
    $('table-columns').onchange = renderTable;
    $('zoom').onchange = () => { $('image-stage').style.width = Number($('zoom').value) * 100 + '%'; highlight(true); };
    $('confirm-row').onclick = () => {
        if (document.querySelector('[aria-invalid="true"]')) { message('请先更正无效输入，再确认本行。', true); return; }
        portfolioSnapshotState = C.confirm(portfolioSnapshotState, selectedId, now()); dirty = true;
        renderTable(); renderEditor();
        const p = portfolioSnapshotState.positions.find(p => p.positionId === selectedId);
        message(C.issues(p).length ? '本行已标记为人工核对；仍有疑点或机器更改记录，已保留提示。' : '本行已标记为人工核对。');
    };
    function renderBulkConfirmation() {
        const rows = [...portfolioSnapshotState.positions, ...portfolioSnapshotState.cash];
        $('confirm-all').disabled = busy || !rows.some(r => r.reviewStatus !== 'reviewed');
    }
    $('confirm-all').onclick = async () => {
        if (busy) return;
        if (document.querySelector('[aria-invalid="true"]')) { message('请先更正无效输入，再批量确认。', true); return; }
        const fields = C.machineChanges(portfolioSnapshotState), acknowledgement = JSON.stringify(fields);
        if (fields.length && !await confirmMachineChanges(fields)) return;
        try { portfolioSnapshotState = C.confirmAll(portfolioSnapshotState, now(), acknowledgement); }
        catch (e) { message(e.message, true); return; }
        dirty = true;
        renderTable(); renderEvidence(); renderEditor();
        message('已批量确认全部 ' + portfolioSnapshotState.positions.length + ' 条持仓、' + portfolioSnapshotState.cash.length
            + ' 条现金（包含筛选隐藏行）。缺项和结构疑点仍保留；后续修改的行会重新变为待核对。');
    };
    function confirmMachineChanges(fields) {
        const dialog = node('dialog'), title = node('h3', '批量确认前，请留意机器改写或推断的关键字段');
        dialog.style.cssText = 'max-width:800px;width:90%;max-height:85vh;overflow:auto;border:1px solid #d4dde4;border-radius:12px;padding:22px';
        dialog.append(title, node('p', '下列内容来自同一图片和同一识别引擎的重读或类型前缀推断。请特别核对数量正负号；一次确认即可，无需逐行点击。'));
        for (const f of fields) dialog.append(node('p', (f.row ? '第 ' + f.row + ' 行 · ' : '') + f.label + '：' + (f.before ?? '首次未读出') + ' → ' + (f.after ?? '未知')));
        const cancel = node('button', '返回检查'), accept = node('button', '确认以上字段并批量确认', 'primary');
        dialog.append(cancel, accept); document.body.append(dialog);
        return new Promise(resolve => { dialog.onclose = () => { resolve(dialog.returnValue === 'accept'); dialog.remove(); };
            cancel.onclick = () => dialog.close('cancel'); accept.onclick = () => dialog.close('accept'); dialog.showModal(); });
    }
    function excludeSource(id) {
        const reason = prompt('请填写排除原因（例如：弹窗文字、工具栏或重复行）。原文和原因将保留。');
        if (reason === null) return;
        try { portfolioSnapshotState = C.excludeRow(portfolioSnapshotState, id, reason, now()); dirty = true; selectedId = null; renderTable(); renderEvidence(); renderEditor(); }
        catch (e) { message(e.message, true); }
    }
    function renderStructureActions() {
        const target = $('structure-actions'); target.replaceChildren();
        for (const issue of C.pendingIssues(portfolioSnapshotState)) {
            const card = node('div', undefined, 'source-evidence'), reason = node('input'); reason.placeholder = '填写核对结论或接受不完整的原因'; reason.setAttribute('aria-label', '结构疑点核对结论');
            const accept = node('button', '已核对，接受此疑点');
            accept.onclick = () => { try { portfolioSnapshotState = C.acceptIssue(portfolioSnapshotState, issue, reason.value, now()); dirty = true; renderTable(); renderEvidence(); renderJson(); }
                catch (e) { message(e.message, true); } };
            card.append(node('p', issue.message), reason, accept); target.append(card);
        }
    }
    $('exclude-position').onclick = () => { const p = portfolioSnapshotState.positions.find(p => p.positionId === selectedId); if (p) excludeSource(p.sourceRowIds[0]); };
    $('add-position').onclick = () => { portfolioSnapshotState = C.add(portfolioSnapshotState, now()); dirty = true; renderTable(); select(portfolioSnapshotState.positions.at(-1).positionId); };
    $('account').onchange = () => {
        const v = $('account').value.trim().toUpperCase();
        metadataInvalid = !!v && !/^U\d+$/.test(v);
        $('account').setAttribute('aria-invalid', String(metadataInvalid));
        if (metadataInvalid) { message('请输入 U 开头的数字账号，或暂时留空。', true); renderJson(); return; }
        portfolioSnapshotState.account = { value: v || null, source: 'manual', confirmed: !!v }; dirty = true; renderJson();
    };
    $('asof').onchange = () => {
        try {
            const v = S.date($('asof').value);
            portfolioSnapshotState.asOf = { date: v, instant: null, timeZone: null, precision: v ? 'date' : 'unknown', source: v ? 'manual' : 'unknown', confirmed: !!v };
            dirty = true; renderJson();
        } catch (e) { message(e.message, true); }
    };
    for (const view of ['review', 'portfolio']) $('tab-' + view).onclick = () => {
        $('review-grid').classList.toggle('portfolio-view', view === 'portfolio');
        for (const k of ['review', 'portfolio']) { $('tab-' + k).classList.toggle('active', k === view); $('tab-' + k).setAttribute('aria-selected', String(k === view)); }
    };
    $('json-details').ontoggle = renderJson;
    $('export-json').onclick = () => {
        try {
            if (document.querySelector('[aria-invalid="true"]')) throw new Error('请先更正无效输入，再导出。');
            const snapshot = S.validate(portfolioSnapshotState);
            const url = URL.createObjectURL(new Blob([S.serialize(snapshot)], { type: 'application/json' }));
            const a = node('a'); a.href = url; a.download = 'portfolio-' + (snapshot.account.value || 'unassigned') + '-' + (snapshot.asOf.date || 'undated') + '.json';
            a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); dirty = false;
            message('已导出内存 Portfolio JSON（不含原图文件）。账号或日期留空会按未完整快照保留。');
        } catch (e) { message(e.message, true); }
    };
    $('copy-json').onclick = async () => {
        try { await navigator.clipboard.writeText(S.serialize(portfolioSnapshotState)); message('JSON 已复制。'); }
        catch (_) { $('json-details').open = true; renderJson(); message('无法自动复制，请从展开的 JSON 中选择复制。'); }
    };
    $('import-json').onclick = () => $('json-file').click();
    $('json-file').onchange = async e => {
        const file = e.target.files[0]; e.target.value = ''; if (!file) return;
        try {
            if (file.size > S.LIMITS.jsonBytes) throw new Error('JSON 超过 32 MiB 可导入上限');
            const snapshot = S.validate(JSON.parse(await file.text()));
            if (dirty && !confirm('导入会替换当前内存表。请先导出要保留的版本，继续吗？')) return;
            const same = portfolioSnapshotState.sources[0]?.sha256 && portfolioSnapshotState.sources[0].sha256 === snapshot.sources[0]?.sha256;
            stopRecognition(); if (!same) releaseImage();
            portfolioSnapshotState = snapshot; metadataInvalid = false; selectedId = null;
            $('account').value = snapshot.account.value || ''; $('account').setAttribute('aria-invalid', 'false'); $('asof').value = snapshot.asOf.date || '';
            renderTable(); renderEvidence(); select(snapshot.positions[0]?.positionId); dirty = true;
            message(same ? 'JSON 已导入，已关联相同原图。' : 'JSON 已导入；不包含图片，请载入相同原图继续对照。');
        } catch (error) { message('导入失败：' + error.message, true); }
    };
    window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    g.__portfolioSnapshot = Object.freeze({ getSnapshot: () => S.clone(portfolioSnapshotState) });
    renderTable(); renderEvidence(); checkService();
})(typeof globalThis !== 'undefined' ? globalThis : this);
