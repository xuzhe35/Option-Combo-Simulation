/* Snapshot data only: no ledger, pricing, network, or browser persistence. */
(function (g) {
    'use strict';
    const LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, pixels: 20000000, edge: 8192, rows: 2000, jsonBytes: 32 * 1024 * 1024 });
    const FIELDS = Object.freeze([
        ['instrument.symbol', '标的', 'text'], ['instrument.secType', '类型', 'type'],
        ['quantity', '持仓数量（含正负号）', 'number'], ['instrument.expiryDate', '到期日', 'date'],
        ['instrument.right', 'Call / Put', 'right'], ['instrument.strike', '行权价', 'number'],
        ['instrument.tradingClass', '交易类别', 'text'], ['instrument.currency', '币种', 'text'],
        ['instrument.exchange', '交易所', 'text'], ['instrument.multiplier', '乘数 / 点值', 'number'],
        ['displayValues.mark', 'MARK', 'number'], ['displayValues.displayIv', '展示 IV（%）', 'percent'],
        ['displayValues.costBasis', 'COST BASIS', 'number'], ['displayValues.marketValue', 'MKT VALUE', 'number'],
        ['displayValues.avgPrice', 'AVG PRICE', 'number'], ['displayValues.dailyPnl', 'DAILY P&L', 'number'],
        ['displayValues.unrealizedPnl', 'UNRLZD P&L', 'number'], ['displayValues.deltaDollars', 'DELTA DLLRS', 'number'],
        ['displayValues.theta', 'PTF THETA', 'number'], ['displayValues.lastPrice', 'LAST（含原始前缀）', 'number'],
    ].map(([path, label, kind]) => Object.freeze({ path, label, kind })));
    const clone = value => JSON.parse(JSON.stringify(value));
    function redactRecognition(value) {
        let count = 0;
        const walk = v => {
            if (typeof v === 'string') return v.replace(/\b(?:DU\d+|U\d{5,})\b/gi, () => { count++; return '[账号已遮蔽]'; });
            if (Array.isArray(v)) return v.map(walk);
            if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
            return v;
        };
        const result = walk(value);
        if (result.recognition && count) result.recognition.redaction = { applied: true, occurrences: count, policy: 'account-like-text-v1' };
        return result;
    }
    function sanitizeSnapshot(value) {
        const account = clone(value.account);
        const candidate = clone(value); candidate.account = { ...account, value: null };
        const result = redactRecognition(candidate); result.account = account; return result;
    }
    function serialize(snapshot) {
        const text = JSON.stringify(validate(snapshot));
        const size = unescape(encodeURIComponent(text)).length;
        if (size > LIMITS.jsonBytes) throw new Error('JSON 超过可重新导入的 32 MiB 上限，尚未导出；请缩小快照范围。');
        return text;
    }
    function percentDisplay(value) {
        if (value === null || value === undefined) return '';
        const s = decimal(value), negative = s.startsWith('-'), [whole, fraction = ''] = (negative ? s.slice(1) : s).split('.');
        const digits = whole + fraction.padEnd(2, '0');
        return decimal((negative ? '-' : '') + digits.slice(0, whole.length + 2) + '.' + digits.slice(whole.length + 2).padEnd(1, '0'));
    }
    function decimal(value, percent = false) {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        let s = String(value).trim().replace(/[−–]/g, '-');
        // OCR may separate a leading sign or attach a broker status dot. No digits are guessed.
        s = s.replace(/^[•·]\s*/, '').replace(/^([+-])\s+(?=\d)/, '$1').replace(/\s*[•·]$/, '');
        if (/^\([\d,.]+\)$/.test(s)) s = '-' + s.slice(1, -1);
        if (percent) s = s.replace(/%$/, '');
        if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) throw new Error('数字无法确认，请对照原图（不要猜测缺失字符）');
        s = s.replace(/,/g, '').replace(/^\+/, '');
        if (!Number.isFinite(Number(s)) || Math.abs(Number(s)) > 1e16) throw new Error('数字超出支持范围');
        let [whole, fraction] = s.split('.');
        whole = whole.replace(/^(-?)0+(?=\d)/, '$1');
        fraction = (fraction || '').replace(/0+$/, '');
        s = whole + (fraction ? '.' + fraction : '');
        if (Number(s) === 0) s = '0';
        if (!percent) return s;
        // Percent values are normalized as decimals; e.g. 30.5% -> "0.305".
        const negative = s.startsWith('-'), unsigned = negative ? s.slice(1) : s;
        const [integer, fractionDigits = ''] = unsigned.split('.');
        const digits = integer + fractionDigits, cut = integer.length - 2;
        const shifted = cut > 0 ? digits.slice(0, cut) + '.' + digits.slice(cut)
            : '0.' + '0'.repeat(-cut) + digits;
        return decimal((negative ? '-' : '') + shifted);
    }
    function date(value) {
        if (!value) return null;
        const s = String(value);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) !== s) throw new Error('日期无效');
        return s;
    }
    function get(object, path) { return path.split('.').reduce((o, k) => o == null ? null : o[k], object) ?? null; }
    function set(object, path, value) {
        if (!FIELDS.some(f => f.path === path)) throw new Error('未知字段');
        const keys = path.split('.');
        if (keys.length === 2) object[keys[0]][keys[1]] = value; else object[keys[0]] = value;
    }
    function instrument() {
        return { secType: 'UNKNOWN', symbol: null, currency: null, conId: null, localSymbol: null,
            tradingClass: null, exchange: null, expiryDate: null, expiryInstant: null, right: null,
            strike: null, multiplier: null, underlyingFutureRef: null };
    }
    function empty(id, now) {
        return { schemaVersion: 1, snapshotId: id, revision: 0, account: { value: null, source: 'manual', confirmed: false },
            asOf: { date: null, instant: null, timeZone: null, precision: 'unknown', source: 'unknown', confirmed: false },
            createdAtUtc: now, coverage: { kind: 'visible_only', userConfirmedComplete: false }, sources: [], sourceRows: [],
            positions: [], cash: [], accountSummary: {}, review: { status: 'needs_review', changes: [] },
            recognition: { provider: null, model: null, promptVersion: null, status: 'not_run' } };
    }
    function validate(snapshot) {
        if (!snapshot || snapshot.schemaVersion !== 1) throw new Error('不支持的 Portfolio JSON 版本');
        if (!snapshot.account || !snapshot.asOf || !snapshot.review || !Array.isArray(snapshot.review.changes)
            || !snapshot.recognition || !Array.isArray(snapshot.sources) || !Array.isArray(snapshot.sourceRows)
            || !Array.isArray(snapshot.positions) || !Array.isArray(snapshot.cash)) throw new Error('Portfolio JSON 缺少必要结构');
        if (snapshot.sourceRows.length > LIMITS.rows || snapshot.sources.length > 1) throw new Error('本阶段只支持单图和有限行数');
        if (snapshot.account.value !== null && !/^U\d+$/i.test(snapshot.account.value)) throw new Error('账号应为 U 开头的数字账号');
        if (snapshot.account.value && snapshot.account.source !== 'manual') throw new Error('账号必须由用户手动填写，不能接受图片推断的账号');
        date(snapshot.asOf.date);
        const ids = new Set();
        for (const row of snapshot.sourceRows) {
            if (!row.rowId || ids.has(row.rowId)) throw new Error('源行编号重复或缺失');
            ids.add(row.rowId);
            if (!['position', 'cash', 'group_summary', 'combo_summary', 'unclassified', 'decoration'].includes(row.rowType)) throw new Error('未知行类型');
            if (row.bbox !== null && (!Array.isArray(row.bbox) || row.bbox.length !== 4
                || row.bbox.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
                || row.bbox[0] + row.bbox[2] > 1.001 || row.bbox[1] + row.bbox[3] > 1.001)) throw new Error('图片定位区域无效');
        }
        for (const row of snapshot.sourceRows) {
            if (row.parentRowId && !snapshot.sourceRows.some(r => r.rowId === row.parentRowId && r.rowType === 'combo_summary')) throw new Error('组合父子关系无效');
            const visited = new Set([row.rowId]);
            let parent = row.parentRowId;
            while (parent) {
                if (visited.has(parent)) throw new Error('组合父子关系存在循环');
                visited.add(parent); parent = snapshot.sourceRows.find(r => r.rowId === parent)?.parentRowId;
            }
        }
        for (const row of snapshot.sourceRows.filter(r => r.combo)) {
            if (row.rowType !== 'combo_summary' || !Array.isArray(row.combo.childRowIds) || !Array.isArray(row.combo.atomicLegRowIds)
                || !['collapsed', 'incomplete', 'expanded_visible'].includes(row.combo.status)) throw new Error('组合结构记录无效');
            const children = snapshot.sourceRows.filter(r => r.parentRowId === row.rowId).map(r => r.rowId);
            const leaves = snapshot.sourceRows.filter(r => {
                if (r.rowType !== 'position') return false;
                let parent = r.parentRowId;
                while (parent) { if (parent === row.rowId) return true; parent = snapshot.sourceRows.find(r => r.rowId === parent)?.parentRowId; }
                return false;
            }).map(r => r.rowId);
            if (JSON.stringify(row.combo.childRowIds) !== JSON.stringify(children)
                || JSON.stringify(row.combo.atomicLegRowIds) !== JSON.stringify(leaves)
                || (row.combo.status === 'collapsed' && children.length)
                || (row.combo.status === 'expanded_visible' && leaves.length < 2)) throw new Error('组合结构与源行不一致，可能重复或遗漏子腿');
        }
        const used = new Set(), positions = new Set();
        for (const p of snapshot.positions) {
            if (!p.positionId || positions.has(p.positionId) || !p.instrument || !p.displayValues || !p.fieldEvidence
                || !Array.isArray(p.sourceRowIds) || !p.sourceRowIds.length) throw new Error('持仓结构无效');
            positions.add(p.positionId);
            for (const id of p.sourceRowIds) {
                if (used.has(id) || !snapshot.sourceRows.some(r => r.rowId === id && r.rowType === 'position')) throw new Error('持仓重复或误计了组合/分组行');
                used.add(id);
            }
            for (const f of FIELDS) {
                const v = get(p, f.path);
                if (v === null) continue;
                if (typeof v !== 'string') throw new Error('字段必须为字符串或 null');
                if (f.kind === 'number' || f.kind === 'percent') decimal(v);
                if (f.kind === 'date') date(v);
                if (f.kind === 'type' && !['STK', 'OPT', 'FUT', 'FOP', 'UNKNOWN'].includes(v)) throw new Error('合约类型无效');
                if (f.kind === 'right' && !['C', 'P'].includes(v)) throw new Error('Call / Put 无效');
            }
        }
        if (snapshot.sourceRows.some(r => r.rowType === 'position' && !used.has(r.rowId))) throw new Error('有持仓源行未映射，不能静默遗漏');
        const cashSources = new Set();
        for (const cash of snapshot.cash) {
            if (cashSources.has(cash.sourceRowId) || !snapshot.sourceRows.some(r => r.rowId === cash.sourceRowId && r.rowType === 'cash')) throw new Error('现金来源无效或重复');
            cashSources.add(cash.sourceRowId);
            if (cash.amount !== null && typeof cash.amount !== 'string') throw new Error('现金金额必须为字符串或 null');
            decimal(cash.amount);
            // Evidence fields are optional so snapshots exported before they existed still import.
            if (cash.originalAmount !== undefined && cash.originalAmount !== null && typeof cash.originalAmount !== 'string') throw new Error('现金首读金额必须为字符串或 null');
            if (cash.originalAmount !== undefined) decimal(cash.originalAmount);
            if (cash.problem !== undefined && cash.problem !== null && typeof cash.problem !== 'string') throw new Error('现金疑点必须为字符串或 null');
            if (cash.corrections !== undefined && (!Array.isArray(cash.corrections) || cash.corrections.length > 4)) throw new Error('现金更正记录无效');
        }
        if (snapshot.sourceRows.some(r => r.rowType === 'cash' && !cashSources.has(r.rowId))) throw new Error('有现金源行未映射');
        return sanitizeSnapshot(snapshot);
    }
    g.OptionComboPortfolioSnapshotSchema = Object.freeze({ LIMITS, FIELDS, clone, decimal, date, get, set, instrument, empty, validate, redactRecognition, sanitizeSnapshot, serialize, percentDisplay });
})(typeof globalThis !== 'undefined' ? globalThis : this);
