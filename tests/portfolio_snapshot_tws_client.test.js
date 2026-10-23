const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
// A fake WebSocket stands in for the backend; nothing here opens a network connection.
const plain = value => JSON.parse(JSON.stringify(value));
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) }); }
    drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
FakeSocket.instances = [];
function setup(options = {}) {
    FakeSocket.instances = [];
    const T = loadBrowserScripts(['js/portfolio_snapshot_tws.js']).OptionComboPortfolioSnapshotTwsClient;
    const client = T.create({ WebSocket: FakeSocket, setTimeout, clearTimeout, connectTimeoutMs: 50, accountsTimeoutMs: 50,
        positionsTimeoutMs: 60, valuationWaitMs: 15, ...options });
    return { T, client };
}
async function connected(options) {
    const ctx = setup(options), opening = ctx.client.connect('ws://127.0.0.1:8799');
    const socket = FakeSocket.instances[0]; socket.open(); await opening;
    return { ...ctx, socket };
}
const positionsReply = requestId => ({ action: 'portfolio_positions_snapshot', ibConnected: true, positionsReady: true, items: [], requestId });
const valuation = price => ({ action: 'portfolio_avg_cost_update', items: [{ account: 'U0000001', conId: 1, marketPrice: price }] });

module.exports = { name: 'portfolio snapshot TWS read-only client', tests: [
    { stage: 'X3', name: 'X3 only the three read snapshots can be sent; order and execution actions never reach the socket', async run() {
        const { T, client, socket } = await connected();
        assert.deepEqual(plain(T.ALLOWED_ACTIONS), ['request_managed_accounts_snapshot', 'request_portfolio_positions_snapshot', 'request_portfolio_avg_cost_snapshot']);
        for (const action of ['submit_combo_order', 'preview_combo_order', 'place_order', 'cancel_order', 'subscribe', 'request_cost_basis_executions',
            'subscribe_cost_basis_underlying_quote', '', undefined, 'request_portfolio_positions_snapshot ']) {
            assert.throws(() => client.send(action, {}), e => e.code === 'action_not_allowed', String(action));
        }
        client.send('request_portfolio_avg_cost_snapshot', { action: 'submit_combo_order' });
        assert.deepEqual(socket.sent, [{ action: 'request_portfolio_avg_cost_snapshot' }], 'a payload cannot override the action');
        client.close();
        assert.throws(() => client.send('request_managed_accounts_snapshot'), e => e.code === 'not_connected');
    } },
    { stage: 'X3', name: 'X3 the endpoint is a plain ws:// host and port; paths, schemes and bad ports are refused', run() {
        const { T } = setup();
        assert.equal(T.endpoint('127.0.0.1', 8765), 'ws://127.0.0.1:8765');
        assert.equal(T.endpoint(' localhost ', '8799'), 'ws://localhost:8799');
        assert.equal(T.endpoint('[::1]', 8799), 'ws://[::1]:8799');
        assert.equal(T.endpoint('tws-box.lan', 8765), 'ws://tws-box.lan:8765');
        for (const [host, port] of [['127.0.0.1/x', 8765], ['ws://127.0.0.1', 8765], ['', 8765], ['a b', 8765], ['127.0.0.1', 0],
            ['127.0.0.1', 70000], ['127.0.0.1', '8765abc'], ['127.0.0.1', 8765.5], ['127.0.0.1@evil', 8765]]) {
            assert.throws(() => T.endpoint(host, port), e => e.code === 'endpoint_invalid', host + ':' + port);
        }
    } },
    { stage: 'X3', name: 'X3 accounts come from the managed-accounts snapshot, deduplicated, with a valid default', async run() {
        const { client, socket } = await connected();
        const pending = client.accounts();
        assert.deepEqual(socket.sent, [{ action: 'request_managed_accounts_snapshot' }]);
        socket.receive('not json'); socket.receive([1, 2]); socket.receive({ action: 'iv_term_structure_update' });
        socket.receive({ action: 'managed_accounts_update', accounts: ['U0000002', ' U0000001 ', 'U0000002', ''], defaultAccount: 'U9', ibConnected: true });
        assert.deepEqual(plain(await pending), { accounts: ['U0000002', 'U0000001'], defaultAccount: 'U0000002', ibConnected: true });
    } },
    { stage: 'X3', name: 'X3 positions are matched by request id; the connect-time push and other ids are ignored', async run() {
        const { client, socket } = await connected();
        socket.receive(valuation(1));                                   // pushed on connect: current cache, kept
        socket.receive(positionsReply(undefined));                      // pushed on connect: no request id, ignored
        const pending = client.positions();
        const sent = socket.sent.map(m => m.action), requestId = socket.sent[0].requestId;
        assert.deepEqual(sent, ['request_portfolio_positions_snapshot', 'request_portfolio_avg_cost_snapshot']);
        assert.match(requestId, /^portfolio-snapshot-tws-1-\d+$/);
        socket.receive(positionsReply('someone-else'));
        socket.receive(valuation(2));
        socket.receive(positionsReply(requestId));
        const result = await pending;
        assert.equal(result.positionsReply.requestId, requestId);
        assert.deepEqual(plain(result.valuationReplies.map(v => v.items[0].marketPrice)), [1, 2]);
    } },
    { stage: 'X3', name: 'X3 a missing positions reply times out; a missing valuation is not a failure', async run() {
        const { client, socket } = await connected();
        await assert.rejects(client.positions(), e => e.code === 'positions_timeout');
        const again = client.positions();
        socket.receive(positionsReply(socket.sent.at(-2).requestId));
        assert.deepEqual(plain((await again).valuationReplies), []);
        const slowAccounts = client.accounts();
        await assert.rejects(slowAccounts, e => e.code === 'accounts_timeout');
    } },
    { stage: 'X3', name: 'X3 closing or losing the connection rejects pending reads and ignores later replies', async run() {
        let ctx = await connected();
        const pending = ctx.client.positions(), requestId = ctx.socket.sent[0].requestId;
        ctx.client.close();
        await assert.rejects(pending, e => e.code === 'closed');
        assert.equal(ctx.socket.onmessage, null, 'a closed socket has no handlers left');
        assert.equal(ctx.client.connected, false);
        void requestId;

        ctx = await connected();
        const lost = ctx.client.positions();
        ctx.socket.drop();
        await assert.rejects(lost, e => e.code === 'disconnected');
        await assert.rejects(ctx.client.accounts(), e => e.code === 'not_connected');

        ctx = await connected({ valuationWaitMs: 40 });
        const waiting = ctx.client.positions();
        ctx.socket.receive(positionsReply(ctx.socket.sent[0].requestId));
        await tick(5); ctx.socket.drop();
        await assert.rejects(waiting, e => e.code === 'disconnected', 'a drop during the valuation wait is a disconnect');
    } },
    { stage: 'X3', name: 'X3 connection failures and timeouts are reported; a later connection starts clean', async run() {
        let { client } = setup();
        const failing = client.connect('ws://127.0.0.1:8799'); FakeSocket.instances[0].onerror?.();
        await assert.rejects(failing, e => e.code === 'connect_failed');
        ({ client } = setup());
        await assert.rejects(client.connect('ws://127.0.0.1:8799'), e => e.code === 'connect_timeout');
        const T = loadBrowserScripts(['js/portfolio_snapshot_tws.js']).OptionComboPortfolioSnapshotTwsClient;
        const throwing = T.create({ WebSocket: class { constructor() { throw new Error('blocked'); } }, setTimeout, clearTimeout });
        await assert.rejects(throwing.connect('ws://127.0.0.1:8799'), e => e.code === 'connect_failed');

        const ctx = await connected();
        ctx.socket.receive(valuation(1));
        ctx.client.close();
        const reopening = ctx.client.connect('ws://127.0.0.1:8799'); FakeSocket.instances[1].open(); await reopening;
        const second = FakeSocket.instances[1], pending = ctx.client.positions();
        second.receive(positionsReply(second.sent[0].requestId));
        assert.deepEqual(plain((await pending).valuationReplies), [], 'valuation from an earlier connection is not reused');
    } },
    { stage: 'X4', name: 'X4 the new page scripts never store data and only the client opens a socket, for the three read actions', run() {
        const fs = require('node:fs'), path = require('node:path'), root = path.join(__dirname, '..');
        const read = file => fs.readFileSync(path.join(root, file), 'utf8');
        const files = ['js/portfolio_snapshot_tws_model.js', 'js/portfolio_snapshot_tws.js', 'js/portfolio_snapshot_tws_panel.js'];
        for (const file of files) assert.doesNotMatch(read(file), /sessionStorage|indexedDB|document\.cookie/, file);
        // Only the backend host and port are remembered: the model never touches storage, the client
        // writes one key through an injected Storage, and the panel only hands localStorage to it.
        assert.doesNotMatch(read('js/portfolio_snapshot_tws_model.js'), /localStorage|getItem|setItem/);
        assert.doesNotMatch(read('js/portfolio_snapshot_tws.js'), /localStorage/);
        assert.equal(read('js/portfolio_snapshot_tws.js').match(/setItem\(/g).length, 1);
        assert.equal(read('js/portfolio_snapshot_tws_panel.js').match(/localStorage/g).length, 1);
        assert.doesNotMatch(read('js/portfolio_snapshot_tws_panel.js'), /getItem|setItem|removeItem|clear\(\)/);
        for (const file of ['js/portfolio_snapshot_tws_model.js', 'js/portfolio_snapshot_tws_panel.js', 'js/portfolio_snapshot.js']) {
            assert.doesNotMatch(read(file), /WebSocket/, file + ' must not open a socket');
        }
        const allowed = ['request_managed_accounts_snapshot', 'request_portfolio_positions_snapshot', 'request_portfolio_avg_cost_snapshot'];
        for (const file of ['js/portfolio_snapshot_tws.js', 'js/portfolio_snapshot_tws_panel.js']) {
            const actions = [...read(file).matchAll(/'((?:request|submit|place|cancel|preview|subscribe|unsubscribe|modify|exercise|save|append|import)_[a-z_]+)'/g)].map(m => m[1]);
            assert.ok(actions.every(a => allowed.includes(a)), file + ': ' + actions.join(', '));
        }
        assert.doesNotMatch(read('js/portfolio_snapshot_tws_panel.js'), /\.send\(/, 'the panel sends nothing itself; only the client sends');
        for (const file of files) assert.doesNotMatch(read(file), /createObjectURL|\.download\b|showSaveFilePicker/, file + ' writes no file; results stay in the page');
        assert.doesNotMatch(read('portfolio_snapshot.html'), /id="tws-export"/);
    } },
    { stage: 'X4', name: 'X4 only a valid host and port are remembered, under one key; anything else stored there is ignored', run() {
        const { T } = setup();
        const store = (initial = {}) => {
            const data = { ...initial }, writes = [];
            return { data, writes, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { writes.push(k); data[k] = String(v); } };
        };
        const s = store();
        assert.equal(T.rememberEndpoint(s, ' tws-box.lan ', '80'), true);
        assert.deepEqual(s.writes, [T.ENDPOINT_STORAGE_KEY]);
        assert.equal(s.data[T.ENDPOINT_STORAGE_KEY], '{"host":"tws-box.lan","port":"80"}');
        assert.deepEqual(plain(T.rememberedEndpoint(s)), { host: 'tws-box.lan', port: '80' });
        for (const [host, port] of [['a/b', '80'], ['ws://h', '80'], ['127.0.0.1', '0'], ['127.0.0.1', '8x']]) {
            assert.equal(T.rememberEndpoint(s, host, port), false, host + ':' + port);
        }
        assert.equal(s.writes.length, 1, 'an invalid endpoint never overwrites the remembered one');
        for (const value of ['not json', 'null', '[]', '{"host":"h"}', '{"host":"h","port":"80","positions":[1]}',
            '{"host":"ws://h","port":"80"}', '{"host":"h","port":"8o"}', '{"host":"h","port":"70000"}']) {
            assert.equal(T.rememberedEndpoint(store({ [T.ENDPOINT_STORAGE_KEY]: value })), null, value);
        }
        const refusing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
        assert.equal(T.rememberedEndpoint(refusing), null);
        assert.equal(T.rememberEndpoint(refusing, '127.0.0.1', '8765'), false);
        assert.equal(T.rememberedEndpoint(null), null);
        assert.equal(T.rememberEndpoint(null, '127.0.0.1', '8765'), false);
    } },
] };
