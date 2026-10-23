(function (g) {
    'use strict';
    const S = g.OptionComboPortfolioSnapshotSchema;
    function position(id, rowId) {
        return { positionId: id, sourceRowIds: [rowId], instrument: S.instrument(), quantity: null,
            displayValues: {}, fieldEvidence: {}, issues: [], reviewStatus: 'unreviewed' };
    }
    const blankReading = value => value == null || /^(?:\s*|[-—–]|N\/A)$/i.test(String(value).trim());
    function fieldContext(p, path) {
        const type = p.instrument.secType, option = ['OPT', 'FOP'].includes(type);
        if ((type === 'STK' && ['instrument.expiryDate','instrument.right','instrument.strike','displayValues.displayIv','displayValues.theta'].includes(path))
            || (type === 'FUT' && ['instrument.right','instrument.strike','displayValues.displayIv','displayValues.theta'].includes(path)))
            return { required: false, note: type === 'STK' ? '股票 / ETF 不适用此字段' : '期货不适用此期权字段' };
        const required = ['instrument.symbol','instrument.secType','quantity'].includes(path)
            || (option && ['instrument.expiryDate','instrument.right','instrument.strike'].includes(path))
            || (type === 'FUT' && path === 'instrument.expiryDate');
        return { required, note: required ? '此持仓的必要字段，缺失时需核对' : '截图未提供时可留空，不作为可疑项' };
    }
    function equivalentReadings(path, first, second) {
        const f = S.FIELDS.find(f => f.path === path);
        if (!f || !['number','percent'].includes(f.kind)) return false;
        try {
            const a = S.fieldDecimal(first, f), b = S.fieldDecimal(second, f);
            return a !== null && a === b;
        } catch (_) { return false; }
    }
    function localCheck(p, path) {
        const e = p.fieldEvidence[path];
        // Old JSON keeps historical statuses and both raw readings. Re-evaluate
        // representation-only differences without changing any stored value.
        if (e?.localReread && equivalentReadings(path, e.raw, e.localReread.raw)
            && equivalentReadings(path, S.get(p, path), e.raw)) return 'agreed';
        return e?.localCheck;
    }
    function fieldProblem(p, path) {
        const e = p.fieldEvidence[path];
        if (!e?.problem || e.source === 'manual') return null;
        const value = S.get(p, path);
        if (value !== null && equivalentReadings(path, e.raw, value) && S.priceTypography(e.raw, path) !== e.raw
            && e.cellCheck !== 'unchecked') return null;
        if (value !== null && !(e.cellCheck === 'unchecked' && e.source === 'ocr')) return null;
        // Missing optional cells are routine. Actual unreadable ink, competing
        // readings and nonblank invalid strings remain reviewable.
        if (blankReading(e.raw) && !e.conflictingReadings && !['reread_conflict','unresolved'].includes(e.cellCheck)
            && !/字形|两次放大|未收到局部复核答复|像素/.test(e.problem)) return null;
        return e.problem;
    }
    function issues(p) {
        const out = [...(p.issues || [])];
        if (!p.instrument.symbol) out.push('标的未确认');
        if (p.instrument.secType === 'UNKNOWN') out.push('合约类型未确认');
        if (p.quantity === null) out.push('持仓数量缺失或无法读取');
        if (p.instrument.secType === 'STK' && (p.instrument.right || p.instrument.strike !== null || p.instrument.expiryDate)) out.push('股票类型与期权/到期字段矛盾，请人工确认');
        if (p.instrument.secType === 'FUT' && (p.instrument.right || p.instrument.strike !== null)) out.push('期货类型与期权字段矛盾，请人工确认');
        if (p.instrument.secType === 'FUT' && !p.instrument.expiryDate) out.push('期货到期日未确认');
        for (const change of machineChanges({ positions: [p] })) out.push('机器重读/推断：' + change.label + ' ' + (change.before ?? '未读出') + ' → ' + (change.after ?? '未知') + '（需留意，确认后保留）');
        if (p.instrument.secType === 'STK' && p.quantity !== null && p.displayValues.mark != null && p.displayValues.marketValue != null) {
            const places = (path, value) => {
                const e = p.fieldEvidence[path], raw = ['ocr','ai'].includes(e?.source) && typeof e.raw === 'string' ? e.raw.trim() : value;
                try {
                    const normalized = S.priceTypography(raw, path).replace(/[•·,%()\s]/g, '');
                    return normalized.split('.')[1]?.length || 0;
                } catch (_) { return value.split('.')[1]?.length || 0; }
            };
            const mark = p.displayValues.mark, decimals = places('displayValues.mark', mark);
            const expected = Number(p.quantity) * Number(mark), actual = Number(p.displayValues.marketValue);
            const marketDecimals = places('displayValues.marketValue', p.displayValues.marketValue);
            const tolerance = Math.abs(Number(p.quantity)) * .5 * 10 ** -decimals + .5 * 10 ** -marketDecimals + Math.abs(expected) * 1e-12;
            if (Math.abs(expected - actual) > tolerance) out.push('股票数量 × MARK 与市值超出显示舍入范围，请核对列归属和正负号');
        }
        if (['OPT', 'FOP'].includes(p.instrument.secType)) {
            if (['mark', 'lastPrice'].some(k => p.displayValues[k] !== null && Number(p.displayValues[k]) < 0)) out.push('期权价格为负，请核对状态符号、负号和列归属');
            if (!p.instrument.expiryDate) out.push('到期日未确认');
            if (!p.instrument.right) out.push('Call / Put 截断或未确认');
            if (p.instrument.strike === null) out.push('行权价未确认');
        }
        for (const [path, e] of Object.entries(p.fieldEvidence)) {
            if (e.source === 'ai' && localCheck(p, path) === 'conflict') out.push((S.FIELDS.find(f => f.path === path)?.label || path)
                + ' 整图 / 局部冲突：' + (e.raw ?? '未读出') + ' / ' + (e.localReread?.raw ?? '未读出') + '；未自动覆盖，请人工核验。');
            // An unchecked first reading keeps its value but stays flagged until edited by hand.
            const problem = fieldProblem(p, path);
            if (problem) out.push(problem);
        }
        return [...new Set(out)];
    }
    function machineChanges(snapshot) {
        const paths = S.FIELDS.map(f=>f.path);
        return [...snapshot.positions.flatMap((p, index) => paths.filter(path => {
            const e = p.fieldEvidence[path];
            if (!e || !((e.corrections || []).length || e.interpretation)) return false;
            const before = e.interpretation?.token ?? e.raw ?? e.originalValue;
            // Formatting is evidence, not a changed price requiring a separate
            // acknowledgement. Real corrections (including signs) stay here.
            if (S.priceTypography(before, path) !== before && equivalentReadings(path, before, S.get(p, path))) return false;
            return true;
        }).map(path => ({ positionId: p.positionId, row: index + 1, field: path, label: S.FIELDS.find(f => f.path === path).label,
            before: p.fieldEvidence[path].interpretation ? p.fieldEvidence[path].interpretation.token : p.fieldEvidence[path].originalValue,
            after: S.get(p, path), source: p.fieldEvidence[path].source }))),
        ...(snapshot.cash || []).filter(c => (c.corrections || []).length).map(c => ({ sourceRowId: c.sourceRowId, row: null, field: 'cash.amount',
            label: (c.currency || '未知币种') + ' 现金', before: c.originalAmount ?? null, after: c.amount, source: 'ocr' }))];
    }
    function cashIssues(c) {
        const out = [];
        if (c.amount === null) out.push(c.problem || '现金金额缺失或无法读取');
        for (const change of machineChanges({ positions: [], cash: [c] })) out.push('机器重读：' + change.label + ' ' + (change.before ?? '未读出') + ' → ' + (change.after ?? '未知') + '（需留意，确认后保留）');
        return out;
    }
    function issueEvidence(snapshot, issue) {
        const row = snapshot.sourceRows.find(r => r.rowId === issue.rowId);
        return JSON.stringify({ issue, runId: snapshot.recognition.runId || null, combo: row?.combo || null });
    }
    function pendingIssues(snapshot) {
        const all = [...(snapshot.recognition.structureIssues || []), ...(snapshot.recognition.localReviewIssues || []), ...snapshot.sourceRows.filter(r => r.rowType === 'combo_summary' && !r.combo)
            .map(r => ({ rowId: r.rowId, code: 'legacy_combo', message: '旧组合缺少层级证据，请重新识别或明确接受其不完整性。' }))];
        return all.filter(issue => {
            // Editing a conflicting field is an explicit human choice; retain
            // both machine readings, but do not keep its old decision pending.
            if (issue.code === 'ai_local_conflict' && issue.field) {
                const p = snapshot.positions.find(p => p.sourceRowIds.includes(issue.rowId));
                if (p?.fieldEvidence[issue.field]?.source === 'manual') return false;
                if (p && localCheck(p, issue.field) === 'agreed') return false;
                if (issue.field === 'cash.amount' && (snapshot.review.changes || []).some(c => c.sourceRowId === issue.rowId && c.field === 'cash.amount')) return false;
            }
            return !(snapshot.review.structureDecisions || []).some(d => d.evidence === issueEvidence(snapshot, issue));
        });
    }
    function acceptIssue(snapshot, issue, reason, now) {
        if (!reason || reason.trim().length < 2) throw new Error('请填写核对结论或接受不完整的原因');
        const next = S.clone(snapshot);
        if (!pendingIssues(next).some(i => issueEvidence(next, i) === issueEvidence(next, issue))) throw new Error('结构疑点已变化，请重新核对');
        (next.review.structureDecisions ||= []).push({ evidence: issueEvidence(next, issue), reason: reason.trim(), atUtc: now });
        next.review.status = reviewStatus(next); return next;
    }
    function excludeRow(snapshot, rowId, reason, now) {
        if (!reason || reason.trim().length < 2) throw new Error('请填写排除原因');
        const next = S.clone(snapshot), row = next.sourceRows.find(r => r.rowId === rowId);
        if (!row || next.sourceRows.some(r => r.parentRowId === rowId)) throw new Error('此行带子行，不能直接排除；请先核对其结构');
        row.exclusion = { previousType: row.rowType, reason: reason.trim(), atUtc: now }; row.rowType = 'decoration'; row.parentRowId = null;
        if (row.combo) { row.exclusion.previousCombo = S.clone(row.combo); delete row.combo; }
        next.positions = next.positions.filter(p => !p.sourceRowIds.includes(rowId)); next.cash = next.cash.filter(c => c.sourceRowId !== rowId);
        for (const parent of next.sourceRows.filter(r => r.combo)) {
            parent.combo.childRowIds = next.sourceRows.filter(r => r.parentRowId === parent.rowId).map(r => r.rowId);
            parent.combo.atomicLegRowIds = parent.combo.atomicLegRowIds.filter(id => next.sourceRows.some(r => r.rowId === id && r.rowType === 'position'));
            parent.combo.status = !parent.combo.childRowIds.length ? 'collapsed' : parent.combo.atomicLegRowIds.length < 2 ? 'incomplete' : parent.combo.status;
            if (parent.combo.status !== 'expanded_visible' && !(next.recognition.structureIssues || []).some(i => i.rowId === parent.rowId)) {
                (next.recognition.structureIssues ||= []).push({ rowId: parent.rowId, code: 'manual_exclusion_partial', message: '人工排除后组合可见腿不完整，请明确核对。' });
            }
        }
        for (const issue of pendingIssues(next).filter(i => i.rowId === rowId)) {
            (next.review.structureDecisions ||= []).push({ evidence: issueEvidence(next, issue), reason: '排除此行：' + reason.trim(), atUtc: now });
        }
        next.review.status = reviewStatus(next); return S.validate(next);
    }
    function edit(snapshot, id, path, input, now) {
        const next = S.clone(snapshot), p = next.positions.find(p => p.positionId === id);
        if (!p) throw new Error('未找到持仓');
        const f = S.FIELDS.find(f => f.path === path);
        if (!f) throw new Error('未知字段');
        let value = String(input).trim() || null;
        if (f.kind === 'number' || f.kind === 'percent') value = S.decimal(value, f.kind === 'percent');
        if (f.kind === 'date') value = S.date(value);
        if (f.kind === 'right' && value && !['C', 'P'].includes(value)) throw new Error('请选择 C 或 P');
        if (f.kind === 'type' && !['STK', 'OPT', 'FUT', 'FOP', 'UNKNOWN'].includes(value)) throw new Error('合约类型无效');
        if (path === 'instrument.symbol' && value) value = value.toUpperCase();
        const before = S.get(p, path);
        if (before === value) return snapshot;
        S.set(p, path, value);
        const previous = p.fieldEvidence[path] || { source: 'manual', raw: null, originalValue: before };
        p.fieldEvidence[path] = { ...previous, source: 'manual', reviewStatus: 'edited' };
        p.reviewStatus = 'unreviewed';
        next.review.status = 'needs_review';
        next.review.changes.push({ positionId: id, field: path, before, after: value, atUtc: now });
        return next;
    }
    function reviewStatus(snapshot) {
        return (snapshot.positions.length || snapshot.cash.length || snapshot.sourceRows.some(r => ['combo_summary', 'unclassified'].includes(r.rowType)))
            && snapshot.positions.every(p => p.reviewStatus === 'reviewed')
            && snapshot.cash.every(c => c.reviewStatus === 'reviewed')
            && !pendingIssues(snapshot).length ? 'reviewed' : 'needs_review';
    }
    function confirm(snapshot, id, now) {
        const next = S.clone(snapshot), p = next.positions.find(p => p.positionId === id);
        if (!p) throw new Error('未找到持仓');
        p.reviewStatus = 'reviewed';
        p.reviewedAtUtc = now;
        next.review.status = reviewStatus(next);
        return next;
    }
    function confirmAll(snapshot, now, acknowledgement) {
        const changes = machineChanges(snapshot);
        if (changes.length && acknowledgement !== JSON.stringify(changes)) throw new Error('请先确认机器更改的关键字段清单，再批量确认');
        const next = S.clone(snapshot);
        for (const row of [...next.positions, ...next.cash]) {
            if (row.reviewStatus === 'reviewed') continue;
            row.reviewStatus = 'reviewed'; row.reviewedAtUtc = now;
        }
        next.review.status = reviewStatus(next);
        if (changes.length) next.review.machineAcknowledgement = { fields: changes, atUtc: now };
        return next;
    }
    function applyRecognition(snapshot, result) {
        const next = S.clone(snapshot);
        next.sourceRows = S.clone(result.sourceRows);
        next.positions = S.clone(result.positions);
        next.cash = S.clone(result.cash);
        next.accountSummary = S.clone(result.accountSummary || {});
        next.review = { status: 'needs_review', changes: [] };
        next.recognition = S.clone(result.recognition);
        if (next.sources[0]) next.sources[0].recognitionRunId = result.recognition.runId;
        return S.validate(next);
    }
    function add(snapshot, now) {
        const next = S.clone(snapshot), id = 'manual-' + next.sourceRows.length + '-' + now;
        next.sourceRows.push({ rowId: id, sourceId: next.sources[0]?.sourceId || null, rowType: 'position', parentRowId: null,
            bbox: null, rawText: '手工添加', rawCells: {} });
        next.positions.push(position(id, id));
        next.review.status = 'needs_review';
        return next;
    }
    function stats(snapshot) {
        return { positions: snapshot.positions.length, reviewed: snapshot.positions.filter(p => p.reviewStatus === 'reviewed').length,
            problems: snapshot.positions.filter(p => issues(p).length).length + snapshot.cash.filter(c => cashIssues(c).length).length,
            cash: snapshot.cash.length,
            summaries: snapshot.sourceRows.filter(r => ['group_summary','combo_summary'].includes(r.rowType)).length,
            decorations: snapshot.sourceRows.filter(r => r.rowType === 'decoration').length };
    }
    g.OptionComboPortfolioSnapshotCore = Object.freeze({ position, blankReading, fieldContext, fieldProblem, localCheck, issues, cashIssues, edit, confirm, confirmAll, reviewStatus, applyRecognition, add, stats, machineChanges, pendingIssues, acceptIssue, excludeRow });
})(typeof globalThis !== 'undefined' ? globalThis : this);
