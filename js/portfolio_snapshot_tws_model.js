/* DOM-free: TWS position replies -> twsPositions, and the read-only comparison with the
   in-memory Portfolio JSON (CODE PLAN/PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md §4-§5).
   No network and no writes: the snapshot passed in is never modified. */
(function (g) {
    'use strict';
    const S = g.OptionComboPortfolioSnapshotSchema;
    const SUPPORTED = Object.freeze(['STK', 'OPT', 'FUT', 'FOP']);
    const OPTIONS = Object.freeze(['OPT', 'FOP']);
    const MATCHES = Object.freeze(['exact', 'presumed', 'ambiguous', 'duplicate_in_json', 'json_only', 'tws_only']);
    const RESULTS = Object.freeze(['same', 'different', 'json_missing', 'tws_only_value', 'within_display_precision',
        'info_time_varying', 'unavailable']);
    // Only these make the JSON disagree with TWS; the others are gaps on one side or time-varying prices.
    const COUNTED = Object.freeze(['different', 'json_missing']);
    const POSITION_KEYS = Object.freeze(['conId', 'secType', 'symbol', 'localSymbol', 'tradingClass', 'expiryDate', 'expiryMonth',
        'right', 'strike', 'multiplier', 'quantity', 'avgPrice', 'marketPrice', 'unrealizedPnl']);
    const SUMMARY_KEYS = Object.freeze(['exact', 'presumed', 'ambiguous', 'duplicateInJson', 'jsonOnly', 'twsOnly', 'fieldDifferences']);
    // The screenshot need not show the whole account: only its own positions must be supported by
    // TWS. Positions only TWS holds are listed for reference and never affect the verdict.
    const VERDICTS = Object.freeze(['supported', 'differences', 'no_positions']);

    const fail = (reason, message) => ({ ok: false, reason, message });
    const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
    /** TWS floats are rounded to 8 places before the schema's own decimal rules apply. */
    function decimalOf(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error('非有限数值');
            return S.decimal(value.toFixed(8));
        }
        if (typeof value === 'string') return S.decimal(value);
        throw new Error('数值类型无效');
    }
    const quietDecimal = value => { try { return decimalOf(value); } catch (_) { return null; } };
    function expiryOf(raw) {
        const digits = String(raw ?? '').replace(/-/g, '').trim();
        if (!digits) return { expiryDate: null, expiryMonth: null };
        if (/^\d{8}$/.test(digits)) return { expiryDate: S.date(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`), expiryMonth: null };
        if (/^\d{6}$/.test(digits) && Number(digits.slice(4)) >= 1 && Number(digits.slice(4)) <= 12) {
            return { expiryDate: null, expiryMonth: `${digits.slice(0, 4)}-${digits.slice(4)}` };
        }
        throw new Error('到期日无效：' + raw);
    }
    function rightOf(raw) {
        const value = String(raw ?? '').trim().toUpperCase();
        if (!value) return null;
        if (value === 'C' || value === 'CALL') return 'C';
        if (value === 'P' || value === 'PUT') return 'P';
        throw new Error('Call / Put 无效：' + raw);
    }
    function positionOf(item) {
        if (!Number.isInteger(item.conId) || !text(item.secType) || !text(item.symbol)) throw new Error('缺少 conId / secType / symbol');
        if (typeof item.position !== 'number' || !Number.isFinite(item.position)) throw new Error('持仓数量无效');
        const secType = item.secType.trim().toUpperCase(), option = OPTIONS.includes(secType);
        return {
            conId: item.conId, secType, symbol: item.symbol.trim().toUpperCase(), localSymbol: text(item.localSymbol),
            tradingClass: text(item.tradingClass),
            ...(option || secType === 'FUT' ? expiryOf(item.expDate) : { expiryDate: null, expiryMonth: null }),
            right: option ? rightOf(item.right) : null, strike: option ? decimalOf(item.strike) : null,
            multiplier: decimalOf(item.multiplier), quantity: decimalOf(item.position), avgPrice: decimalOf(item.avgCostPerUnit),
            marketPrice: null, unrealizedPnl: null,
        };
    }

    /**
     * The selected account's positions from one portfolio_positions_snapshot reply (authoritative
     * quantities) and any portfolio_avg_cost_update replies (valuation, may be absent; later wins).
     * Returns {ok: true, value} or {ok: false, reason, message}; a malformed item refuses the whole reply.
     */
    function fromTwsReplies(positionsReply, valuationReplies, account) {
        if (!positionsReply || positionsReply.action !== 'portfolio_positions_snapshot' || !Array.isArray(positionsReply.items)) {
            return fail('reply_invalid', 'TWS 持仓回复格式无效。');
        }
        if (positionsReply.ibConnected !== true) return fail('not_connected', '后端未连接 TWS。');
        if (positionsReply.positionsReady !== true) return fail('positions_not_ready', 'TWS 持仓尚未同步完成，请稍后重试。');
        const wanted = String(account ?? '').trim().toUpperCase();
        if (!wanted) return fail('account_missing', '请选择 TWS 账户。');
        const own = item => item && typeof item === 'object' && String(item.account ?? '').trim().toUpperCase() === wanted;
        let parsed;
        try { parsed = positionsReply.items.filter(own).map(positionOf); }
        catch (e) { return fail('reply_invalid', 'TWS 持仓回复中有无法解析的条目：' + e.message); }
        const valuation = new Map();
        for (const reply of Array.isArray(valuationReplies) ? valuationReplies : []) {
            if (!reply || reply.action !== 'portfolio_avg_cost_update' || !Array.isArray(reply.items)) continue;
            for (const item of reply.items) if (own(item) && Number.isInteger(item.conId)) valuation.set(item.conId, item);
        }
        parsed.sort((a, b) => a.conId - b.conId);
        const positions = [], unsupported = [];
        let valued = false;
        for (const p of parsed) {
            if (!SUPPORTED.includes(p.secType)) {
                unsupported.push({ conId: p.conId, secType: p.secType, symbol: p.symbol, localSymbol: p.localSymbol, quantity: p.quantity });
                continue;
            }
            const v = valuation.get(p.conId);
            if (v) {
                p.marketPrice = quietDecimal(v.marketPrice); p.unrealizedPnl = quietDecimal(v.unrealizedPNL);
                valued = valued || p.marketPrice !== null || p.unrealizedPnl !== null;
            }
            positions.push(p);
        }
        return { ok: true, value: { schemaVersion: 1, account: wanted, brokerTimestamp: text(positionsReply.brokerTimestamp),
            brokerTimezone: text(positionsReply.brokerTimezone), valuation: valued ? 'available' : 'unavailable', positions, unsupported } };
    }

    function check(ok, message) { if (!ok) throw new Error(message); }
    const nullableText = v => v === null || (typeof v === 'string' && v.length > 0);
    function nullableDecimal(v) { if (v === null) return true; try { return S.decimal(v) === v; } catch (_) { return false; } }
    function validateTwsPositions(value) {
        check(value && typeof value === 'object' && value.schemaVersion === 1, 'TWS 持仓 JSON 版本无效');
        check(typeof value.account === 'string' && value.account.length > 0, 'TWS 账户缺失');
        check(nullableText(value.brokerTimestamp) && nullableText(value.brokerTimezone), 'TWS 时间字段无效');
        check(['available', 'unavailable'].includes(value.valuation), 'TWS 估值状态无效');
        check(Array.isArray(value.positions) && Array.isArray(value.unsupported), 'TWS 持仓列表缺失');
        const ids = new Set();
        for (const p of value.positions) {
            check(p && Object.keys(p).length === POSITION_KEYS.length && POSITION_KEYS.every(k => k in p), 'TWS 持仓字段不完整');
            check(Number.isInteger(p.conId) && !ids.has(p.conId), 'TWS conId 无效或重复'); ids.add(p.conId);
            check(SUPPORTED.includes(p.secType) && typeof p.symbol === 'string' && p.symbol.length > 0, 'TWS 合约类型或代码无效');
            check(['localSymbol', 'tradingClass', 'expiryMonth'].every(k => nullableText(p[k])), 'TWS 文本字段无效');
            check(p.expiryDate === null || S.date(p.expiryDate) === p.expiryDate, 'TWS 到期日无效');
            check(p.right === null || p.right === 'C' || p.right === 'P', 'TWS Call / Put 无效');
            check(p.quantity !== null && ['strike', 'multiplier', 'quantity', 'avgPrice', 'marketPrice', 'unrealizedPnl'].every(k => nullableDecimal(p[k])), 'TWS 数值字段无效');
        }
        for (const u of value.unsupported) check(u && Number.isInteger(u.conId) && typeof u.secType === 'string' && nullableDecimal(u.quantity), 'TWS 未支持持仓无效');
        return value;
    }

    // ----- comparison -----
    const IDENTITY = { STK: ['instrument.symbol'], FUT: ['instrument.symbol', 'instrument.expiryDate'],
        OPT: ['instrument.symbol', 'instrument.expiryDate', 'instrument.right', 'instrument.strike'],
        FOP: ['instrument.symbol', 'instrument.expiryDate', 'instrument.right', 'instrument.strike'] };
    function identityOf(p) {
        const i = p.instrument, secType = SUPPORTED.includes(i.secType) ? i.secType : null;
        return { secType, symbol: text(i.symbol)?.toUpperCase() ?? null, expiryDate: i.expiryDate ?? null, right: i.right ?? null,
            strike: i.strike ?? null, tradingClass: text(i.tradingClass)?.toUpperCase() ?? null };
    }
    const twsValue = (t, path) => path === 'instrument.symbol' ? t.symbol : path === 'instrument.right' ? t.right
        : path === 'instrument.strike' ? t.strike : t.expiryDate ?? t.expiryMonth;
    const jsonValue = (j, path) => path === 'instrument.symbol' ? j.symbol : path === 'instrument.right' ? j.right
        : path === 'instrument.strike' ? j.strike : j.expiryDate;
    function identityResult(j, t, path) {
        const jv = jsonValue(j, path), tv = twsValue(t, path);
        if (jv === null) return { result: 'json_missing' };
        if (tv === null) return { result: 'unavailable' };
        if (path === 'instrument.expiryDate' && t.expiryDate === null) {
            return jv.slice(0, 7) === t.expiryMonth ? { result: 'same', note: 'month_level_expiry' } : { result: 'different' };
        }
        return { result: jv === tv ? 'same' : 'different' };
    }
    const classChecked = (j, t) => t.secType !== 'STK' && j.tradingClass !== null && t.tradingClass !== null;
    function complete(j) {
        return j.secType !== null && IDENTITY[j.secType].every(path => jsonValue(j, path) !== null);
    }
    function exactCandidate(j, t) {
        return j.secType === t.secType && IDENTITY[t.secType].every(path => identityResult(j, t, path).result === 'same')
            && (!classChecked(j, t) || j.tradingClass === t.tradingClass.toUpperCase());
    }
    function presumedCandidate(j, t) {
        if (j.symbol === null || j.symbol !== t.symbol || (j.secType !== null && j.secType !== t.secType)) return false;
        const differences = IDENTITY[t.secType].filter(path => identityResult(j, t, path).result === 'different').length
            + (classChecked(j, t) && j.tradingClass !== t.tradingClass.toUpperCase() ? 1 : 0);
        return differences <= 1;
    }
    function identityKey(j) {
        return JSON.stringify([j.secType, j.symbol, j.secType === 'STK' ? null : j.expiryDate, OPTIONS.includes(j.secType) ? j.right : null,
            OPTIONS.includes(j.secType) ? j.strike : null, j.secType === 'STK' ? null : j.tradingClass]);
    }
    /**
     * Assigns a TWS position to a row only when the row has exactly one candidate and no other row
     * claims that same single candidate; assigned positions leave every other candidate set. Repeats
     * until stable, so the result does not depend on row order.
     */
    function resolve(entries) {
        const assigned = new Map();
        for (let changed = true; changed;) {
            changed = false;
            const claims = new Map();
            for (const e of entries) if (!assigned.has(e) && e.candidates.size === 1) {
                const conId = [...e.candidates][0];
                claims.set(conId, [...(claims.get(conId) || []), e]);
            }
            for (const [conId, claimers] of claims) {
                if (claimers.length !== 1) continue;
                assigned.set(claimers[0], conId); changed = true;
                for (const other of entries) if (other !== claimers[0]) other.candidates.delete(conId);
            }
        }
        return assigned;
    }
    function displayDecimals(p) {
        const e = p.fieldEvidence?.['displayValues.avgPrice'], value = p.displayValues.avgPrice;
        const shown = e?.interpretation?.value ?? (['ai', 'ocr'].includes(e?.source) && typeof e.raw === 'string'
            ? S.priceTypography(e.raw, 'displayValues.avgPrice') : null) ?? value;
        return (/\.(\d+)/.exec(String(shown).replace(/,/g, '')) || [null, ''])[1].length;
    }
    function field(p, path, json, tws, result, extra) {
        const e = p.fieldEvidence?.[path];
        return { path, json, tws, result, source: e?.source ?? null, problem: e?.problem ?? null, ...(extra || {}) };
    }
    function fieldsFor(p, j, t) {
        const out = [field(p, 'instrument.secType', j.secType, t.secType, j.secType === null ? 'json_missing' : j.secType === t.secType ? 'same' : 'different')];
        const notes = [];
        for (const path of IDENTITY[t.secType]) {
            const { result, note } = identityResult(j, t, path);
            if (note) notes.push(note);
            out.push(field(p, path, jsonValue(j, path), twsValue(t, path), result));
        }
        if (t.secType !== 'STK' && t.tradingClass !== null) {
            out.push(field(p, 'instrument.tradingClass', j.tradingClass, t.tradingClass,
                j.tradingClass === null ? 'tws_only_value' : j.tradingClass === t.tradingClass.toUpperCase() ? 'same' : 'different'));
        }
        const multiplier = p.instrument.multiplier ?? null;
        out.push(field(p, 'instrument.multiplier', multiplier, t.multiplier, multiplier === null
            ? (t.multiplier === null ? 'unavailable' : 'tws_only_value') : t.multiplier === null ? 'unavailable' : multiplier === t.multiplier ? 'same' : 'different'));
        const quantity = p.quantity ?? null;
        out.push(field(p, 'quantity', quantity, t.quantity, quantity === null ? 'json_missing' : quantity === t.quantity ? 'same' : 'different',
            quantity !== null && Number(quantity) * Number(t.quantity) < 0 ? { note: 'sign_opposite' } : null));
        const avg = p.displayValues.avgPrice ?? null;
        let avgResult = avg === null ? (t.avgPrice === null ? 'unavailable' : 'tws_only_value') : t.avgPrice === null ? 'unavailable' : 'same';
        if (avg !== null && t.avgPrice !== null && avg !== t.avgPrice) {
            // TWS shows the average rounded up for a long position and down for a short one
            // (real-account check, validation §9). The screenshot may sit up to one displayed unit
            // above (long) or below (short) TWS's 4-place figure, plus that figure's own rounding.
            const unit = 10 ** -displayDecimals(p), slack = 0.00005 + 1e-12, gap = Math.abs(Number(avg)) - Number(t.avgPrice);
            const fits = Number(t.quantity) > 0 ? gap >= -slack && gap <= unit + slack : gap <= slack && gap >= -unit - slack;
            avgResult = fits ? 'within_display_precision' : 'different';
        }
        out.push(field(p, 'displayValues.avgPrice', avg, t.avgPrice, avgResult));
        for (const [path, twsKey] of [['displayValues.mark', 'marketPrice'], ['displayValues.unrealizedPnl', 'unrealizedPnl']]) {
            const json = p.displayValues[path.split('.')[1]] ?? null, tws = t[twsKey];
            if (tws === null) out.push(field(p, path, json, tws, 'unavailable'));
            else if (json === null) out.push(field(p, path, json, tws, 'tws_only_value'));
            else if (json === tws) out.push(field(p, path, json, tws, 'same'));
            else {
                const delta = Number(tws) - Number(json);
                out.push(field(p, path, json, tws, 'info_time_varying', { delta: decimalOf(delta),
                    relative: Number(tws) === 0 ? null : Number((delta / Math.abs(Number(tws))).toFixed(6)) }));
            }
        }
        return { fields: out, notes };
    }
    function hash(value) {
        // cyrb53: a stable fingerprint to notice that the JSON changed, not a security digest.
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < value.length; i++) {
            const ch = value.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
    }
    function fingerprint(snapshot) {
        return hash(JSON.stringify([snapshot.account?.value ?? null,
            snapshot.positions.map(p => [p.positionId, p.instrument, p.quantity, p.displayValues]),
            snapshot.sourceRows.map(r => [r.rowId, r.rowType])]));
    }

    /** The comparison report (§4.2). createdAtUtc comes from the caller so equal inputs give equal output. */
    function compareSnapshot(snapshot, tws, options) {
        validateTwsPositions(tws);
        const createdAtUtc = options?.createdAtUtc;
        check(typeof createdAtUtc === 'string' && createdAtUtc.length > 0, '缺少比对时间');
        const entries = snapshot.positions.map(p => ({ p, j: identityOf(p) }));
        const byConId = new Map(tws.positions.map(t => [t.conId, t]));
        const reserved = new Set(), outcome = new Map();
        // JSON rows with the same complete identity are never added together or matched.
        const groups = new Map();
        for (const e of entries) if (complete(e.j)) groups.set(identityKey(e.j), [...(groups.get(identityKey(e.j)) || []), e]);
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            const candidates = tws.positions.filter(t => exactCandidate(group[0].j, t)).map(t => t.conId);
            candidates.forEach(c => reserved.add(c));
            for (const e of group) outcome.set(e, { match: 'duplicate_in_json', conId: null, candidates });
        }
        const pass = (rows, test, match) => {
            const pending = rows.map(e => ({ e, candidates: new Set(tws.positions.filter(t => !reserved.has(t.conId) && test(e.j, t)).map(t => t.conId)) }));
            pending.forEach(x => { x.initial = x.candidates.size; });
            const assigned = resolve(pending), fallThrough = [];
            for (const x of pending) {
                if (assigned.has(x)) {
                    reserved.add(assigned.get(x));
                    outcome.set(x.e, { match, conId: assigned.get(x), candidates: [], elimination: x.initial > 1 });
                } else if (x.candidates.size) {
                    const candidates = [...x.candidates].sort((a, b) => a - b);
                    candidates.forEach(c => reserved.add(c));
                    outcome.set(x.e, { match: 'ambiguous', conId: null, candidates });
                } else fallThrough.push(x.e);
            }
            return fallThrough;
        };
        const left = pass(entries.filter(e => !outcome.has(e) && complete(e.j)), exactCandidate, 'exact');
        const unmatched = pass([...entries.filter(e => !outcome.has(e) && !complete(e.j)), ...left]
            .sort((a, b) => entries.indexOf(a) - entries.indexOf(b)), presumedCandidate, 'presumed');
        for (const e of unmatched) outcome.set(e, { match: 'json_only', conId: null, candidates: [] });

        const rows = entries.map(e => {
            const o = outcome.get(e), row = { positionId: e.p.positionId, conId: o.conId, match: o.match, candidates: o.candidates,
                differingIdentity: [], notes: [], fields: [] };
            if (o.match === 'json_only' && e.j.symbol === null) row.notes.push('identity_unknown');
            if (o.conId !== null) {
                const { fields, notes } = fieldsFor(e.p, e.j, byConId.get(o.conId));
                row.fields = fields; row.notes.push(...notes);
                if (o.elimination) row.notes.push('matched_by_elimination');
                if (o.match === 'presumed') row.differingIdentity = fields.filter(f => (f.path.startsWith('instrument.') && f.path !== 'instrument.multiplier')
                    && COUNTED.includes(f.result)).map(f => f.path);
            }
            return row;
        });
        for (const t of tws.positions) if (!reserved.has(t.conId)) rows.push({ positionId: null, conId: t.conId, match: 'tws_only',
            candidates: [], differingIdentity: [], notes: [], fields: [] });

        const count = m => rows.filter(r => r.match === m).length;
        const fieldDifferences = rows.reduce((n, r) => n + r.fields.filter(f => COUNTED.includes(f.result)).length, 0);
        const summary = { exact: count('exact'), presumed: count('presumed'), ambiguous: count('ambiguous'),
            duplicateInJson: count('duplicate_in_json'), jsonOnly: count('json_only'), twsOnly: count('tws_only'), fieldDifferences };
        const jsonAccount = text(snapshot.account?.value)?.toUpperCase() ?? null;
        const sourceRows = snapshot.sourceRows;
        return {
            schemaVersion: 1, createdAtUtc,
            snapshotRef: { snapshotId: snapshot.snapshotId ?? null, revision: snapshot.revision ?? null, fingerprint: fingerprint(snapshot) },
            account: { json: jsonAccount, tws: tws.account, note: jsonAccount === null ? 'json_missing' : jsonAccount === tws.account ? 'same' : 'different' },
            tws: S.clone(tws),
            verdict: !entries.length ? 'no_positions'
                : rows.every(r => r.match === 'exact' || r.match === 'tws_only') && fieldDifferences === 0 ? 'supported' : 'differences',
            rows: S.clone(rows),
            notCompared: { comboParents: sourceRows.filter(r => r.rowType === 'combo_summary').length, cash: snapshot.cash.length,
                groupSummaries: sourceRows.filter(r => r.rowType === 'group_summary').length,
                unclassified: sourceRows.filter(r => r.rowType === 'unclassified').map(r => ({ rowId: r.rowId, rawText: r.rawText ?? '' })),
                excluded: sourceRows.filter(r => r.exclusion).length, twsUnsupported: S.clone(tws.unsupported) },
            summary,
        };
    }
    function validateComparison(report) {
        check(report && report.schemaVersion === 1 && typeof report.createdAtUtc === 'string', '比对报告版本无效');
        check(report.snapshotRef && typeof report.snapshotRef.fingerprint === 'string', '比对报告缺少快照引用');
        check(report.account && ['json_missing', 'same', 'different'].includes(report.account.note), '比对报告账户状态无效');
        validateTwsPositions(report.tws);
        check(VERDICTS.includes(report.verdict), '比对结论无效');
        check(Array.isArray(report.rows) && report.rows.every(r => MATCHES.includes(r.match) && Array.isArray(r.candidates)
            && Array.isArray(r.fields) && r.fields.every(f => RESULTS.includes(f.result) && typeof f.path === 'string')), '比对行无效');
        check(report.summary && SUMMARY_KEYS.every(k => Number.isInteger(report.summary[k]) && report.summary[k] >= 0), '比对汇总无效');
        check(report.notCompared && Array.isArray(report.notCompared.unclassified) && Array.isArray(report.notCompared.twsUnsupported), '未比较项无效');
        return report;
    }
    const isStale = (report, snapshot) => !report || report.snapshotRef.fingerprint !== fingerprint(snapshot);

    g.OptionComboPortfolioSnapshotTwsModel = Object.freeze({ SUPPORTED, MATCHES, RESULTS, COUNTED, VERDICTS, fromTwsReplies,
        validateTwsPositions, compareSnapshot, validateComparison, fingerprint, isStale });
})(typeof globalThis !== 'undefined' ? globalThis : this);
