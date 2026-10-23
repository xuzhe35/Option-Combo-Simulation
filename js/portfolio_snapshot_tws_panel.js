/* "与 TWS 持仓比对" panel (CODE PLAN/PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md X4).
   Read-only: it reads the in-memory JSON through window.__portfolioSnapshot, sends only the
   client's three snapshot requests, and never changes the JSON, writes files or trades. The
   comparison result lives only in this page; the browser remembers only the backend host and
   port that last answered. */
(function (g) {
    'use strict';
    if (typeof document === 'undefined') return;
    const S = g.OptionComboPortfolioSnapshotSchema, M = g.OptionComboPortfolioSnapshotTwsModel;
    const T = g.OptionComboPortfolioSnapshotTwsClient, snapshots = g.__portfolioSnapshot, view = g.__portfolioSnapshotView;
    const $ = id => document.getElementById(id);
    if (!S || !M || !T || !snapshots || !view || !$('tws-panel')) return;
    const page = { getSnapshot: snapshots.getSnapshot, selectPosition: view.selectPosition, onChange: view.onChange };

    const MATCH_LABELS = { exact: '一致匹配', presumed: '推定匹配', ambiguous: '歧义', duplicate_in_json: '截图中重复',
        json_only: '仅截图有', tws_only: '仅 TWS 有' };
    const RESULT_LABELS = { different: '不一致', json_missing: '截图缺失', tws_only_value: 'TWS 可补充',
        within_display_precision: '符合 TWS 显示取整（多头向上、空头向下）', info_time_varying: '随时间变化，仅参考', unavailable: 'TWS 未提供', same: '一致' };
    const NOTE_LABELS = { month_level_expiry: '期货到期按月份匹配', matched_by_elimination: '截图缺交易类别，按排除法匹配',
        identity_unknown: '截图中合约身份字段未知', sign_opposite: '正负号相反' };
    const ERROR_LABELS = { connect_failed: '无法连接 TWS 后端，请确认 ib_server 已启动、主机和端口正确。',
        connect_timeout: '连接 TWS 后端超时。', accounts_timeout: 'TWS 后端未返回账户列表（可能是只回放的历史后端）。',
        positions_timeout: 'TWS 后端未在 10 秒内返回持仓（历史后端不提供 TWS 持仓）。', disconnected: 'TWS 后端连接已断开。',
        endpoint_invalid: 'TWS 后端主机或端口无效。' };
    const FIELD_LABELS = Object.fromEntries([...S.FIELDS.map(f => [f.path, f.label]), ['quantity', '持仓数量']]);
    // A hand-picked account applies to the JSON it was picked for; a newly loaded JSON starts from its own account.
    let report = null, busy = false, run = 0, picked = null;
    // Some browsers throw on any access to local storage (blocked site data); the page then just forgets.
    const storage = () => { try { return g.localStorage; } catch (_) { return null; } };

    function node(tag, text, cls) {
        const n = document.createElement(tag);
        if (text !== undefined && text !== null) n.textContent = text;
        if (cls) n.className = cls;
        return n;
    }
    function status(text, error = false) { $('tws-status').textContent = text; $('tws-status').classList.toggle('tws-error', error); }
    function jsonTitle(snapshot, id) {
        const p = snapshot.positions.find(x => x.positionId === id);
        if (!p) return id;
        const i = p.instrument;
        return [i.symbol || '未知标的', i.secType, i.expiryDate, i.strike, i.right === 'C' ? 'CALL' : i.right === 'P' ? 'PUT' : null,
            i.tradingClass ? '(' + i.tradingClass + ')' : null].filter(Boolean).join(' ') + ' · 数量 ' + (p.quantity ?? '未知');
    }
    function twsTitle(conId) {
        const t = report.tws.positions.find(x => x.conId === conId);
        if (!t) return 'conId ' + conId;
        return [t.symbol, t.secType, t.expiryDate || t.expiryMonth, t.strike, t.right === 'C' ? 'CALL' : t.right === 'P' ? 'PUT' : null,
            t.secType === 'STK' || !t.tradingClass ? null : '(' + t.tradingClass + ')'].filter(Boolean).join(' ') + ' · 数量 ' + t.quantity;
    }
    const VERDICT_LABELS = { supported: '截图中的持仓都能在 TWS 中找到依据', differences: '截图中的持仓与 TWS 有差异',
        no_positions: '截图 JSON 中没有可比对的持仓' };
    const counted = f => M.COUNTED.includes(f.result);
    // Positions only TWS holds are reference only: the screenshot need not show the whole account.
    const needsAttention = r => r.match !== 'tws_only' && (r.match !== 'exact' || r.fields.some(counted));
    function fieldText(f) {
        const extra = f.note ? '，' + NOTE_LABELS[f.note] : f.delta ? '，差额 ' + f.delta : '';
        return (FIELD_LABELS[f.path] || f.path) + '：截图 ' + (f.json ?? '—') + ' / TWS ' + (f.tws ?? '—') + '（' + RESULT_LABELS[f.result] + extra + '）'
            + (f.problem && counted(f) ? ' · 原疑点：' + f.problem : '');
    }

    function render() {
        const snapshot = page.getSnapshot(), has = !!report;
        for (const id of ['tws-summary', 'tws-toolbar', 'tws-table-wrap', 'tws-not-compared']) $(id).hidden = !has;
        $('tws-extra').hidden = !has || !report.summary.twsOnly;
        const stale = has && M.isStale(report, snapshot);
        $('tws-stale').hidden = !stale;
        $('tws-panel').classList.toggle('tws-is-stale', stale);
        if (!has) return;
        const s = report.summary, summary = $('tws-summary');
        summary.replaceChildren();
        summary.append(node('strong', VERDICT_LABELS[report.verdict], report.verdict === 'supported' ? 'tws-verdict ok' : 'tws-verdict'));
        for (const [label, value] of [['一致匹配', s.exact], ['推定', s.presumed], ['歧义', s.ambiguous], ['截图重复', s.duplicateInJson],
            ['仅截图有', s.jsonOnly], ['字段不一致', s.fieldDifferences]]) {
            summary.append(node('span', label + ' ' + value, value && label !== '一致匹配' ? 'tws-chip warn' : 'tws-chip'));
        }
        summary.append(node('span', 'TWS 另有 ' + s.twsOnly + '（参考）', 'tws-chip'));
        summary.append(node('small', 'TWS 账户 ' + report.tws.account + ' · 快照 ' + (report.tws.brokerTimestamp || '时间未知')
            + (report.tws.brokerTimezone ? ' ' + report.tws.brokerTimezone : '') + ' · 估值' + (report.tws.valuation === 'available' ? '可用' : '不可用')
            + '。请确认截图为最新的当前持仓。'));
        if (report.account.note === 'different') {
            summary.append(node('small', '截图 JSON 填写的账号与所选 TWS 账户不同，请确认比对的是同一账户。', 'tws-warning'));
        }
        const body = $('tws-body'), onlyIssues = $('tws-filter').value === 'issues';
        body.replaceChildren();
        const rows = report.rows.filter(r => r.match !== 'tws_only' && (!onlyIssues || needsAttention(r)));
        for (const r of rows) {
            const tr = node('tr', undefined, needsAttention(r) ? 'tws-row-attention' : '');
            const badge = node('span', MATCH_LABELS[r.match] + (r.match === 'exact' && r.fields.some(counted) ? ' · 有差异' : ''),
                'tws-badge tws-' + r.match.replace(/_/g, '-'));
            const diff = node('td', undefined, 'tws-diff');
            for (const f of r.fields.filter(f => f.result !== 'same' && (f.json !== null || f.tws !== null))) diff.append(node('div', fieldText(f), counted(f) ? 'tws-diff-hard' : 'tws-diff-info'));
            for (const n of r.notes) diff.append(node('div', NOTE_LABELS[n] || n, 'tws-diff-info'));
            if (r.candidates.length) diff.append(node('div', '候选 TWS 持仓：' + r.candidates.map(twsTitle).join('；'), 'tws-diff-hard'));
            if (r.match === 'json_only') diff.append(node('div', 'TWS 当前持仓中没有此合约。', 'tws-diff-hard'));
            if (!diff.childNodes.length) diff.textContent = '—';
            const result = node('td'); result.append(badge);
            tr.append(result, node('td', r.positionId ? jsonTitle(snapshot, r.positionId) : '—'),
                node('td', r.conId !== null ? twsTitle(r.conId) : '—'), diff);
            if (r.positionId && snapshot.positions.some(p => p.positionId === r.positionId)) {
                tr.tabIndex = 0; tr.title = '查看并核对此持仓';
                tr.onclick = () => page.selectPosition(r.positionId);
                tr.onkeydown = e => { if (e.key === 'Enter') page.selectPosition(r.positionId); };
            }
            body.append(tr);
        }
        if (!rows.length) { const tr = node('tr'), td = node('td', '没有需要处理的项目'); td.colSpan = 4; tr.append(td); body.append(tr); }
        const extra = report.rows.filter(r => r.match === 'tws_only');
        $('tws-extra-summary').textContent = 'TWS 另有、截图未包含的持仓 ' + extra.length + ' 条（参考，不影响结论）';
        $('tws-extra-body').replaceChildren(...extra.map(r => node('div', twsTitle(r.conId), 'tws-diff-info')));
        const n = report.notCompared, list = $('tws-not-compared-body');
        list.replaceChildren(node('p', '组合父行 ' + n.comboParents + ' · 现金 ' + n.cash + ' · 分组汇总 ' + n.groupSummaries
            + ' · 已排除 ' + n.excluded + ' · 未归类 ' + n.unclassified.length + '（组合父行与现金不参与；TWS 只给原子腿，不含现金）'));
        for (const u of n.unclassified) list.append(node('div', '未归类原文：' + u.rawText, 'tws-diff-info'));
        for (const u of n.twsUnsupported) list.append(node('div', 'TWS 另有截图格式不支持的持仓：' + u.secType + ' ' + u.symbol
            + (u.localSymbol ? ' (' + u.localSymbol + ')' : '') + ' · 数量 ' + (u.quantity ?? '未知'), 'tws-diff-info'));
    }

    function chooseAccount(accounts, defaultAccount, snapshot) {
        const select = $('tws-account'), jsonAccount = String(snapshot.account?.value ?? '').trim().toUpperCase();
        select.replaceChildren(...accounts.map(a => { const o = node('option', a); o.value = a; return o; }));
        select.disabled = accounts.length < 2;
        const kept = picked && picked.snapshotId === snapshot.snapshotId && accounts.includes(picked.account) ? picked.account : null;
        const chosen = kept || accounts.find(a => a.toUpperCase() === jsonAccount) || defaultAccount || accounts[0];
        select.value = chosen;
        return chosen;
    }
    async function compare() {
        if (busy) return;
        const host = $('tws-host').value, port = $('tws-port').value.trim();
        let url;
        try { url = T.endpoint(host, port); }
        catch (e) { status(ERROR_LABELS[e.code] || e.message, true); return; }
        const mine = ++run, client = T.create();
        // A new run replaces the old report; a failed run never leaves an earlier result on screen.
        report = null; busy = true; $('tws-compare').disabled = true; render();
        try {
            status('正在连接 ' + url + ' …');
            await client.connect(url);
            status('正在读取 TWS 账户…');
            const { accounts, defaultAccount } = await client.accounts();
            T.rememberEndpoint(storage(), host, port);   // this backend answered: offer it next time
            if (mine !== run) return;
            if (!accounts.length) { status('TWS 后端没有返回账户（TWS 可能未连接）。', true); return; }
            const account = chooseAccount(accounts, defaultAccount, page.getSnapshot());
            status('正在读取 ' + account + ' 的 TWS 持仓…');
            const { positionsReply, valuationReplies } = await client.positions();
            if (mine !== run) return;
            const tws = M.fromTwsReplies(positionsReply, valuationReplies, account);
            if (!tws.ok) { status(tws.message, true); return; }
            report = M.compareSnapshot(page.getSnapshot(), tws.value, { createdAtUtc: new Date().toISOString() });
            status('已比对 ' + account + ' 的 ' + tws.value.positions.length + ' 个 TWS 持仓。结果只读，未修改截图 JSON。');
        } catch (e) {
            if (mine === run) status(ERROR_LABELS[e.code] || ('比对失败：' + (e.message || e)), true);
        } finally {
            client.close();
            if (mine === run) { busy = false; $('tws-compare').disabled = false; render(); }
        }
    }
    $('tws-compare').onclick = compare;
    $('tws-filter').onchange = render;
    $('tws-account').onchange = () => { picked = { account: $('tws-account').value, snapshotId: page.getSnapshot().snapshotId }; };
    const remembered = T.rememberedEndpoint(storage());
    if (remembered) { $('tws-host').value = remembered.host; $('tws-port').value = remembered.port; }
    page.onChange(render);
    g.__portfolioSnapshotTws = Object.freeze({ getReport: () => (report ? S.clone(report) : null), isBusy: () => busy });
    render();
})(typeof globalThis !== 'undefined' ? globalThis : this);
