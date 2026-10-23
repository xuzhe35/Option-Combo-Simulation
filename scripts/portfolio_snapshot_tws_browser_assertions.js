/**
 * In-page checks for the "与 TWS 持仓比对" panel (CODE PLAN/PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md X4).
 * Runs inside portfolio_snapshot.html against scripts/portfolio_snapshot_tws_synthetic_backend.py
 * (127.0.0.1, synthetic replies, never TWS). It first replaces WebSocket with a guard that refuses
 * port 8765, then drives the page only through files, inputs and clicks, and reads what it shows.
 *
 * Usage in the page, with the synthetic backend freshly started and nothing clicked yet:
 *   await window.OptionComboPortfolioSnapshotTwsBrowserAssertions.run({site: 'http://127.0.0.1:8812', wsPort: 8811, phase: 'main'})
 *   await window.OptionComboPortfolioSnapshotTwsBrowserAssertions.run({site: ..., wsPort: ..., phase: 'timeout'})
 *   (reload the page)
 *   await window.OptionComboPortfolioSnapshotTwsBrowserAssertions.run({site: ..., wsPort: ..., phase: 'remembered'})
 * Each resolves to {phase, results: [{name, pass, actual, expected}], failures}.
 */
(function (g) {
    'use strict';
    const doc = g.document, FIXTURES = '/tests/fixtures/portfolio_snapshot/tws/';
    const READ = ['request_managed_accounts_snapshot', 'request_portfolio_positions_snapshot', 'request_portfolio_avg_cost_snapshot'];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const urls = [];
    async function waitFor(test, timeoutMs = 20000) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) { if (test()) return true; await sleep(40); }
        return false;
    }
    function guard() {
        if (g.WebSocket.__twsGuard) return;
        const Native = g.WebSocket;
        class Guarded extends Native {
            constructor(url, protocols) {
                const text = String(url);
                if (/:8765(?:[/?#]|$)/.test(text)) throw new Error('browser checks refuse the live backend port 8765');
                urls.push(text);
                super(url, protocols);
            }
        }
        Guarded.__twsGuard = true;
        g.WebSocket = Guarded;
    }

    async function run(options) {
        const site = options.site.replace(/\/$/, ''), wsPort = Number(options.wsPort), phase = options.phase || 'main';
        if (wsPort === 8765) throw new Error('refusing the live backend port');
        guard();
        g.confirm = () => true;
        const results = [];
        const record = (name, pass, actual, expected) => results.push({ name, pass: !!pass, actual, expected });
        const getJson = p => fetch(site + p, { cache: 'no-store' }).then(r => r.json());
        const post = (p, body) => fetch(site + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
        const panel = () => g.__portfolioSnapshotTws, snapshot = () => g.__portfolioSnapshot.getSnapshot();
        const KEY = g.OptionComboPortfolioSnapshotTwsClient.ENDPOINT_STORAGE_KEY;
        const remembered = () => g.localStorage.getItem(KEY), storedKeys = () => Object.keys(g.localStorage).sort();
        const $ = id => doc.getElementById(id);
        const statusText = () => $('tws-status').textContent;

        if (phase === 'remembered') {
            const saved = JSON.parse(remembered() || 'null');
            record('after a reload the last answering host and port are filled in', saved && $('tws-host').value === saved.host
                && $('tws-port').value === saved.port && saved.port === String(wsPort), [$('tws-host').value, $('tws-port').value], saved);
            return { phase, results, failures: results.filter(r => !r.pass).length };
        }
        if (phase === 'main') {
            const before = await getJson('/__synthetic/actions');
            record('no backend connection before the button is clicked', before.connections === 0 && before.actions.length === 0, before, { connections: 0 });
        }
        await post('/__synthetic/reset', {});
        const replies = await getJson(FIXTURES + 'tws_replies.json'), expected = await getJson(FIXTURES + 'expected_reports.json');
        $('tws-host').value = '127.0.0.1'; $('tws-port').value = String(wsPort);
        // The connect-time push carries no request id and no items: a client that used it would see every JSON row as json_only.
        const base = { accounts: replies.accounts, positions: replies.positions, valuations: replies.valuations,
            connectPush: [replies.accounts, { ...replies.positions, requestId: undefined, items: [] }, replies.valuations[0]] };
        const scenario = body => post('/__synthetic/scenario', body);
        async function load(name) {
            const text = await fetch(site + FIXTURES + 'snapshots/' + name + '.json', { cache: 'no-store' }).then(r => r.text());
            const id = JSON.parse(text).snapshotId, data = new DataTransfer();
            data.items.add(new File([text], name + '.json', { type: 'application/json' }));
            $('drop-zone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
            return waitFor(() => snapshot().snapshotId === id, 5000);
        }
        async function compare() {
            $('tws-compare').click();
            await sleep(30);
            await waitFor(() => !panel().isBusy(), 20000);
            return panel().getReport();
        }
        const shape = report => report && { verdict: report.verdict, summary: report.summary, rows: report.rows.map(r => [r.positionId, r.conId, r.match]) };
        const want = name => ({ verdict: expected[name].verdict, summary: expected[name].summary,
            rows: expected[name].rows.map(r => [r.positionId, r.conId, r.match]) });
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

        if (phase === 'main') {
            await scenario(base);
            g.localStorage.removeItem(KEY);
            const keysBefore = storedKeys();
            record('consistent JSON imports', await load('consistent'), snapshot().positions.length, 7);
            let json = JSON.stringify(snapshot()), report = await compare();
            const wanted = JSON.stringify({ host: '127.0.0.1', port: String(wsPort) });
            record('a backend that answered is remembered: host and port only, one key', remembered() === wanted
                && JSON.stringify(storedKeys()) === JSON.stringify([...keysBefore, KEY].sort()), [remembered(), storedKeys()], wanted);
            record('consistent: report equals the hand-worked expectation', same(shape(report), want('consistent')), shape(report), want('consistent'));
            record('consistent: the JSON is unchanged by the comparison', JSON.stringify(snapshot()) === json, null, null);
            record('consistent: one account by default', $('tws-account').value === 'U0000001', $('tws-account').value, 'U0000001');
            const SUPPORTED = '截图中的持仓都能在 TWS 中找到依据';
            record('consistent: the verdict is shown', $('tws-summary').textContent.includes(SUPPORTED), $('tws-summary').textContent, SUPPORTED);
            record('consistent: the issues filter shows nothing to handle', $('tws-body').textContent.includes('没有需要处理的项目'), $('tws-body').textContent, '没有需要处理的项目');
            $('tws-filter').value = 'all'; $('tws-filter').dispatchEvent(new Event('change'));
            const jsonRows = r => r.rows.filter(x => x.match !== 'tws_only').length;
            record('all filter lists every screenshot row', $('tws-body').querySelectorAll('tr').length === jsonRows(report), $('tws-body').querySelectorAll('tr').length, jsonRows(report));
            $('tws-filter').value = 'issues'; $('tws-filter').dispatchEvent(new Event('change'));
            record('the result stays in the page: no export control or download link', !$('tws-export') && !doc.querySelector('#tws-panel [download]'), null, null);

            record('differences JSON imports', await load('differences'), snapshot().positions.length, 7);
            record('a new JSON makes the old report stale', !$('tws-stale').hidden, $('tws-stale').hidden, false);
            report = await compare();
            record('the JSON account preselects its TWS account', report?.tws.account === 'U0000002' && $('tws-account').value === 'U0000002', report?.tws.account, 'U0000002');
            $('tws-account').value = 'U0000001'; $('tws-account').dispatchEvent(new Event('change'));
            json = JSON.stringify(snapshot()); report = await compare();
            record('differences: a chosen account is kept and the report equals the expectation', same(shape(report), want('differences')), shape(report), want('differences'));
            record('differences: the JSON is unchanged', JSON.stringify(snapshot()) === json, null, null);
            record('differences: the account mismatch is shown', $('tws-summary').textContent.includes('账号与所选 TWS 账户不同'), $('tws-summary').textContent, '账号与所选 TWS 账户不同');
            const attention = report.rows.filter(r => r.match !== 'tws_only' && (r.match !== 'exact' || r.fields.some(f => ['different', 'json_missing'].includes(f.result)))).length;
            record('differences: the issues filter lists each row needing attention', $('tws-body').querySelectorAll('tr').length === attention, $('tws-body').querySelectorAll('tr').length, attention);
            record('differences: the hard difference is spelled out', $('tws-body').textContent.includes('持仓数量：截图 30 / TWS 300（不一致）'), null, '持仓数量：截图 30 / TWS 300（不一致）');
            const row = [...$('tws-body').querySelectorAll('tr[tabindex]')].find(tr => tr.textContent.includes('数量 30'));
            row?.click(); await sleep(100);
            record('clicking a row opens that position for review', !$('editor').hidden && $('editor-title').textContent.startsWith('ABC'), $('editor-title').textContent, 'ABC …');
            $('confirm-row').click(); await sleep(50);
            record('confirming a row does not make the report stale', $('tws-stale').hidden, $('tws-stale').hidden, true);

            await load('partial'); report = await compare();
            record('partial: a screenshot of part of the account is supported', same(shape(report), want('partial')), shape(report), want('partial'));
            $('tws-filter').value = 'all'; $('tws-filter').dispatchEvent(new Event('change'));
            const extraChip = [...$('tws-summary').querySelectorAll('.tws-chip')].find(c => c.textContent.startsWith('TWS 另有'));
            record('partial: TWS-only positions are a separate reference list, not table rows or warnings',
                $('tws-summary').textContent.includes(SUPPORTED) && $('tws-body').querySelectorAll('tr').length === 4 && !$('tws-extra').hidden
                && $('tws-extra-body').children.length === 3 && $('tws-extra-summary').textContent.includes('3 条') && extraChip && !extraChip.classList.contains('warn'),
                [$('tws-body').querySelectorAll('tr').length, $('tws-extra-body').children.length, extraChip?.className], [4, 3, 'tws-chip']);
            $('tws-filter').value = 'issues'; $('tws-filter').dispatchEvent(new Event('change'));
            record('partial: nothing needs attention', $('tws-body').textContent.includes('没有需要处理的项目'), $('tws-body').textContent, '没有需要处理的项目');

            await load('presumed'); report = await compare();
            record('presumed: report equals the expectation', same(shape(report), want('presumed')), shape(report), want('presumed'));
            record('a hand-picked account does not carry over to another JSON', report?.tws.account === 'U0000001' && $('tws-account').value === 'U0000001',
                report?.tws.account, 'U0000001 (TWS default; this JSON has no account)');

            await load('consistent'); await scenario({ ...base, valuations: null, connectPush: [replies.accounts] });
            report = await compare();
            record('no valuation reply: still supported, valuation unavailable', report?.verdict === 'supported' && report.tws.valuation === 'unavailable'
                && $('tws-summary').textContent.includes('估值不可用'), report && [report.verdict, report.tws.valuation], ['supported', 'unavailable']);

            await scenario({ ...base, positions: replies.variants.notReady }); report = await compare();
            record('positions not ready: refused with a reason and no report', report === null && statusText().includes('尚未同步完成') && $('tws-table-wrap').hidden, statusText(), '尚未同步完成');
            await scenario({ ...base, dropOnPositions: true }); report = await compare();
            record('backend drops the connection: reported, no report', report === null && statusText().includes('连接已断开'), statusText(), '连接已断开');
            const connections = (await getJson('/__synthetic/actions')).connections;
            $('tws-port').value = '87x65'; report = await compare();
            record('an invalid port is refused before connecting', report === null && statusText().includes('无效')
                && (await getJson('/__synthetic/actions')).connections === connections, statusText(), '无效');
            $('tws-port').value = String(wsPort + 3); report = await compare();
            record('an invalid port or a refused connection does not replace the remembered backend',
                report === null && statusText().includes('无法连接') && remembered() === wanted, [statusText(), remembered()], wanted);
            $('tws-port').value = String(wsPort);
        } else if (phase === 'timeout') {
            await load('consistent'); await scenario({ ...base, positions: null });
            const started = Date.now(), report = await compare();
            record('a silent backend times out after 10 seconds', report === null && statusText().includes('10 秒') && Date.now() - started >= 9500, [statusText(), Date.now() - started], '10 秒');
        }
        const log = await getJson('/__synthetic/actions');
        record('every action sent was one of the three read snapshots', log.actions.length > 0 && log.actions.every(a => READ.includes(a)), [...new Set(log.actions)], READ);
        // The main phase also tries one unused port on purpose (a refused connection); nothing else is allowed.
        const allowedUrls = [`ws://127.0.0.1:${wsPort}`, `ws://127.0.0.1:${wsPort + 3}`];
        record('every connection went to the synthetic port (or the deliberately refused probe), none to 8765',
            urls.length > 0 && urls.every(u => allowedUrls.includes(u)), [...new Set(urls)], allowedUrls);
        return { phase, results, failures: results.filter(r => !r.pass).length };
    }
    g.OptionComboPortfolioSnapshotTwsBrowserAssertions = Object.freeze({ run });
})(window);
