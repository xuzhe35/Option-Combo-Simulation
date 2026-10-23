/* Independent multimodal protocol. No OCR header calibration or pixel-proof claims. */
(function (g) {
    'use strict';
    const S = g.OptionComboPortfolioSnapshotSchema, C = g.OptionComboPortfolioSnapshotCore;
    const ENGINE = 'local-codex', PROTOCOL = 3;
    const fail = text => { throw new Error('Codex 结果无法采用：' + text + '；当前表格已保留。'); };
    function keys(value, expected) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) fail('回复字段缺失或不受支持');
    }
    function texts(value) { if (!Array.isArray(value) || value.length > S.LIMITS.rows || value.some(x => typeof x !== 'string' || x.length > 16000)) fail('文字列表无效'); }
    function nativeProof(input) {
        if (!input || input.engine !== ENGINE || input.reviewProtocol !== PROTOCOL || input.processing !== 'cloud-via-local-cli'
            || typeof input.model !== 'string' || typeof input.promptVersion !== 'string') fail('引擎或协议无效');
        const image = input.imageInput;
        if (input.reasoningEffort !== 'high' || input.transport !== 'app-server-stdio-v2'
            || !image || image.detail !== 'original' || image.encoding !== 'source-data-url'
            || image.verifiedBy !== 'app-server-user-message' || image.sha256 !== input.sourceHash
            || image.width !== input.width || image.height !== input.height
            || !Number.isInteger(image.byteLength) || image.byteLength <= 0 || image.byteLength > 4194304)
            fail('推理强度或原图发送证明不匹配，请更新并重启识别服务');
    }
    function read(value, field) {
        if (C.blankReading(value)) return { value: null, problem: field.label + ' 未读出或原图未提供，请核对。' };
        try {
            let v = value.trim();
            if (field.kind === 'number' || field.kind === 'percent') {
                if (field.kind === 'percent' && !/%$/.test(v)) throw Error('展示 IV 缺少百分号单位');
                v = S.fieldDecimal(v, field);
            } else if (field.kind === 'date') v = S.date(v);
            else if (field.kind === 'type' && !['STK','OPT','FUT','FOP','UNKNOWN'].includes(v)) throw Error('合约类型无效');
            else if (field.kind === 'right' && !['C','P'].includes(v)) throw Error('Call / Put 无效');
            if (field.path === 'instrument.symbol' && !/^[A-Z][A-Z0-9./-]{0,30}$/.test(v)) throw Error('标的字符不明确');
            return { value: v, problem: null };
        } catch (e) { return { value: null, problem: field.label + '：' + e.message + '；AI 原始读数 ' + value + '，保留未知。' }; }
    }
    function normalize(input, sourceId) {
        nativeProof(input);
        const image = input.imageInput;
        if (!input.semantic || typeof input.semantic !== 'object' || Array.isArray(input.semantic)) fail('缺少多模态表格结果');
        const raw = S.redactRecognition(input.semantic);
        keys(raw, ['tableFound', 'headers', 'rows', 'notes']); texts(raw.headers); texts(raw.notes);
        if (typeof raw.tableFound !== 'boolean' || !raw.tableFound || !Array.isArray(raw.rows) || !raw.rows.length
            || raw.rows.length > S.LIMITS.rows || !raw.headers.length) fail('未读出持仓表或表头');
        const fields = S.FIELDS.map(f => f.path), ids = new Set(), issues = [], positions = [], cash = [];
        const sourceRows = raw.rows.map(r => {
            keys(r, ['rowId', 'rowType', 'parentRowId', 'description', 'partial', 'values', 'cashCurrency', 'cashAmount', 'issues']);
            keys(r.values, fields); texts(r.issues);
            if (typeof r.rowId !== 'string' || !/^[\w-]{1,64}$/.test(r.rowId) || ids.has(r.rowId)
                || !['position','cash','group_summary','combo_summary','unclassified'].includes(r.rowType)
                || typeof r.description !== 'string' || r.description.length > 16000 || typeof r.partial !== 'boolean'
                || !(r.parentRowId === null || typeof r.parentRowId === 'string' && /^[\w-]{1,64}$/.test(r.parentRowId))
                || ![r.cashCurrency, r.cashAmount, ...Object.values(r.values)].every(v => v === null || typeof v === 'string' && v.length <= 16000)) fail('行结构无效或重复');
            ids.add(r.rowId);
            if (r.rowType !== 'cash' && (r.cashCurrency !== null || r.cashAmount !== null)) fail('现金映射到非现金行');
            if (r.rowType === 'position' && /^\s*(?:TOTAL\b|[A-Z]{3}\s+CASH\b)/i.test(r.description)) fail('汇总或现金行被误计为持仓');
            return { rowId: r.rowId, sourceId, rowType: r.rowType, parentRowId: r.parentRowId, bbox: null,
                rawText: r.description, rawCells: { description: r.description, ...r.values },
                aiEvidence: { method: 'multimodal_semantic', localization: 'unavailable', partial: r.partial, issues: r.issues } };
        });
        // The model supplies parent references; code independently derives the leg graph.
        const active = [];
        sourceRows.forEach(row => {
            if (row.parentRowId) {
                const parent = sourceRows.find(r => r.rowId === row.parentRowId);
                if (!parent || parent.rowType !== 'combo_summary' || !active.includes(parent.rowId)) fail('组合归属越过相邻分组、尚未出现的父行或现金行');
                active.splice(active.indexOf(parent.rowId) + 1);
            } else active.length = 0;
            if (row.rowType === 'combo_summary') active.push(row.rowId);
            if (['cash','group_summary'].includes(row.rowType)) {
                if (row.parentRowId) fail('汇总或现金行归入组合');
                active.length = 0;
            }
        });
        raw.rows.forEach(r => {
            const row = sourceRows.find(x => x.rowId === r.rowId);
            if (r.rowType === 'position') {
                const p = C.position('ai-' + r.rowId, r.rowId); p.issues = [...r.issues];
                for (const f of S.FIELDS) {
                    const result = read(r.values[f.path], f, row);
                    S.set(p, f.path, f.kind === 'type' && result.value === null ? 'UNKNOWN' : result.value);
                    p.fieldEvidence[f.path] = { source: 'ai', raw: r.values[f.path], originalValue: result.value,
                        recognizedValue: result.value, problem: result.problem, method: 'multimodal_semantic',
                        reviewStatus: 'unreviewed', bbox: null };
                }
                if (!p.instrument.symbol || p.instrument.secType === 'UNKNOWN') {
                    row.rowType = 'unclassified'; issues.push({ rowId: row.rowId, code: 'ai_identity_unknown', message: 'AI 未能确定此行合约身份，原文保留，未计仓。' });
                } else positions.push(p);
            } else if (r.rowType === 'cash') {
                const amount = read(r.cashAmount, { kind: 'number', label: '现金金额' }, row);
                if (r.cashCurrency !== null && !/^[A-Z]{3}$/.test(r.cashCurrency)) fail('现金币种无效');
                cash.push({ sourceRowId: r.rowId, currency: r.cashCurrency, amount: amount.value, originalAmount: amount.value,
                    raw: r.cashAmount, problem: amount.problem, corrections: [], reviewStatus: 'unreviewed', source: 'ai' });
            } else if (r.rowType === 'unclassified') issues.push({ rowId: r.rowId, code: 'ai_unclassified', message: 'AI 无法确定此行用途，请核对原文；未计仓。' });
        });
        for (const row of sourceRows.filter(r => r.rowType === 'combo_summary').reverse()) {
            const children = sourceRows.filter(r => r.parentRowId === row.rowId), leaves = sourceRows.filter(r => {
                if (r.rowType !== 'position') return false;
                let parent = r.parentRowId;
                while (parent) { if (parent === row.rowId) return true; parent = sourceRows.find(x => x.rowId === parent)?.parentRowId; }
                return false;
            });
            const incomplete = row.aiEvidence.partial || leaves.length < 2 || children.some(r => r.rowType === 'unclassified' || r.aiEvidence.partial
                || r.combo && r.combo.status !== 'expanded_visible');
            row.combo = { childRowIds: children.map(r => r.rowId), atomicLegRowIds: leaves.map(r => r.rowId),
                status: !children.length ? 'collapsed' : incomplete ? 'incomplete' : 'expanded_visible' };
            if (incomplete) issues.push({ rowId: row.rowId, code: 'ai_partial_combo', message: '组合可见腿可能不完整，请确认截图覆盖范围；不会补造缺失腿。' });
        }
        return { sourceRows, positions, cash, accountSummary: {}, recognition: { status: 'needs_review', provider: ENGINE,
            model: input.model, promptVersion: input.promptVersion, reviewProtocol: PROTOCOL, runId: input.runId,
            reasoningEffort: input.reasoningEffort, imageInput: S.clone(image), transport: input.transport,
            elapsedMs: input.elapsedMs, processing: input.processing, warnings: ['AI 多模态候选，未经像素逐格复核；请人工核验。', ...raw.notes],
            structureIssues: issues, quantityCrops: [], reviewCrops: [], refinements: [], originalLines: raw.rows.map(r => ({ text: r.description })),
            originalSemantic: raw, unmatchedRows: sourceRows.filter(r => r.rowType === 'unclassified') } };
    }
    function combine(first, review, sourceId) {
        const candidate = normalize(first, sourceId);
        nativeProof(review);
        if (review.phase !== 'local-review' || review.promptVersion !== 'portfolio-local-review-v1'
            || typeof first.runId !== 'string' || review.firstRunId !== first.runId
            || review.model !== first.model || review.sourceHash !== first.sourceHash
            || review.width !== first.width || review.height !== first.height
            || review.imageInput.byteLength !== first.imageInput.byteLength
            || review.cropMethod !== 'neutral-text-bands-v1') fail('局部复核与首轮、模型或原图不匹配');
        if (!Array.isArray(review.crops) || !review.crops.length || review.crops.length > 64
            || !Array.isArray(review.cropInputs) || review.cropInputs.length !== review.crops.length) fail('裁剪清单无效');
        const ids = new Set(); let bottom = 0;
        review.crops.forEach((crop, i) => {
            keys(crop, ['cropId','rect','width','height','sha256','byteLength','detail']);
            const b = crop.rect, wire = review.cropInputs[i];
            if (typeof crop.cropId !== 'string' || !/^[\w-]{1,64}$/.test(crop.cropId) || ids.has(crop.cropId)
                || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isInteger)
                || b[0] !== 0 || b[1] < bottom || b[2] !== first.width || b[3] <= 0 || b[1] + b[3] > first.height
                || crop.width !== b[2] || crop.height !== b[3] || crop.detail !== 'original'
                || typeof crop.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(crop.sha256)
                || !Number.isInteger(crop.byteLength) || crop.byteLength <= 0 || crop.byteLength > 524288
                || !wire || wire.sha256 !== crop.sha256 || wire.byteLength !== crop.byteLength || wire.detail !== 'original') fail('裁剪像素范围、顺序或发送证明无效');
            ids.add(crop.cropId); bottom = b[1] + b[3];
        });
        const semantic = S.redactRecognition(review.semantic), fields = S.FIELDS.map(f => f.path);
        keys(semantic, ['tableFound','headers','notes','rows']); texts(semantic.headers); texts(semantic.notes);
        if (typeof semantic.tableFound !== 'boolean' || !Array.isArray(semantic.rows)
            || semantic.rows.length !== review.crops.length) fail('局部结果行数与裁剪清单不一致');
        semantic.rows.forEach((row, i) => {
            keys(row, ['cropId','rowType','description','values','cashCurrency','cashAmount','issues']);
            keys(row.values, fields); texts(row.issues);
            if (row.cropId !== review.crops[i].cropId
                || !['position','cash','group_summary','combo_summary','header','outside_table','unclassified'].includes(row.rowType)
                || typeof row.description !== 'string' || row.description.length > 16000
                || ![row.cashCurrency,row.cashAmount,...Object.values(row.values)].every(v => v === null || typeof v === 'string' && v.length <= 16000)
                || row.rowType !== 'cash' && (row.cashCurrency !== null || row.cashAmount !== null)
                || ['header','outside_table'].includes(row.rowType) && Object.values(row.values).some(v => v !== null)) fail('局部行结构、顺序或字段无效');
        });
        const rows = semantic.rows.filter(r => !['header','outside_table'].includes(r.rowType));
        const aligned = semantic.tableFound && semantic.headers.length > 0 && semantic.rows.some(r => r.rowType === 'header')
            && rows.length === candidate.sourceRows.length
            && rows.every((r, i) => r.rowType === candidate.sourceRows[i].rowType && r.rowType !== 'unclassified');
        const local = candidate.recognition.localReview = { status: aligned ? 'compared' : 'alignment_unavailable',
            firstRunId: first.runId, runId: review.runId, model: review.model, reasoningEffort: review.reasoningEffort,
            imageInput: S.clone(review.imageInput), cropMethod: review.cropMethod, crops: S.clone(review.crops),
            cropInputs: S.clone(review.cropInputs), semantic, agreed: 0, conflicts: 0, unavailable: 0, rowMapping: [] };
        candidate.recognition.localReviewIssues = [];
        function pending(rowId, field, status, before, after, message) {
            candidate.recognition.localReviewIssues.push({ rowId, code: 'ai_local_' + status, field,
                firstRaw: before, localRaw: after, message });
        }
        if (!aligned) {
            const warning = '局部文字行与整图行数、类型或顺序无法完整对应；未配对任何读数，请人工核验。';
            candidate.recognition.warnings.push(warning);
            candidate.sourceRows.filter(r => ['position','cash'].includes(r.rowType)).forEach(r => pending(r.rowId, null, 'unavailable', null, null, warning));
            return candidate;
        }
        // Match only the complete visual row sequence. Never match by a strike,
        // quantity, ticker or numerical value that the second read must verify.
        rows.forEach((r, i) => {
            const row = candidate.sourceRows[i], crop = review.crops.find(c => c.cropId === r.cropId);
            const bbox = [0, crop.rect[1] / first.height, 1, crop.rect[3] / first.height];
            row.bbox = bbox; row.aiEvidence.localization = 'measured_text_band_sequence';
            row.aiEvidence.localCropId = crop.cropId;
            local.rowMapping.push({ rowId: row.rowId, cropId: crop.cropId, rowType: row.rowType });
            const p = candidate.positions.find(p => p.sourceRowIds.includes(row.rowId));
            if (p) for (const f of S.FIELDS) {
                const e = p.fieldEvidence[f.path], second = read(r.values[f.path], f);
                const blank = C.blankReading;
                const bothBlank = blank(e.raw) && blank(r.values[f.path]);
                let status;
                if (bothBlank) status = 'agreed_unknown';
                else if (e.originalValue === second.value && !e.problem && !second.problem) status = 'agreed';
                else if (e.originalValue !== second.value || (e.raw ?? '').trim() !== (r.values[f.path] ?? '').trim()) status = 'conflict';
                else status = 'unavailable';
                e.localCheck = status;
                e.localReread = { raw: r.values[f.path], value: second.value, problem: second.problem,
                    cropId: crop.cropId, bbox: S.clone(bbox), runId: review.runId };
                if (status === 'conflict') {
                    local.conflicts++;
                    const message = f.label + ' 整图与局部读数冲突：' + (e.raw ?? '未读出') + ' / ' + (r.values[f.path] ?? '未读出') + '；保留表中首轮值，待人工核验。';
                    pending(row.rowId, f.path, status, e.raw, r.values[f.path], message);
                } else if (status === 'unavailable') local.unavailable++;
                else local.agreed++;
            }
            if (row.rowType === 'cash') {
                const cash = candidate.cash.find(c => c.sourceRowId === row.rowId);
                const amount = read(r.cashAmount, { kind: 'number', label: '现金金额' });
                const currency = r.cashCurrency;
                if (currency !== null && !/^[A-Z]{3}$/.test(currency)) fail('局部现金币种无效');
                cash.localReread = { raw: r.cashAmount, value: amount.value, currency, cropId: crop.cropId, bbox, runId: review.runId };
                const bothBlank = (cash.raw === null || !cash.raw.trim()) && (r.cashAmount === null || !r.cashAmount.trim());
                cash.localCheck = cash.amount === amount.value && cash.currency === currency
                    && (!amount.problem || bothBlank) ? 'agreed'
                    : cash.amount === amount.value && cash.currency === currency && cash.raw === r.cashAmount ? 'unavailable' : 'conflict';
                if (cash.localCheck === 'conflict') {
                    local.conflicts++;
                    pending(row.rowId, 'cash.amount', 'conflict', cash.raw, r.cashAmount, '现金整图与局部读数冲突，保留首轮值，待人工核验。');
                }
            }
        });
        return candidate;
    }
    g.OptionComboPortfolioSnapshotCodex = Object.freeze({ normalize, combine, ENGINE, PROTOCOL });
})(typeof globalThis !== 'undefined' ? globalThis : this);
