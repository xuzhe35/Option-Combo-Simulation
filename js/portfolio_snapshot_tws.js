/* DOM-free read-only client for the TWS position snapshots the backend already serves
   (CODE PLAN/PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md §7). The backend hands any action it
   does not recognise to its order dispatcher, so this client can send exactly three read
   actions and nothing else. */
(function (g) {
    'use strict';
    const ALLOWED_ACTIONS = Object.freeze([
        'request_managed_accounts_snapshot',
        'request_portfolio_positions_snapshot',
        'request_portfolio_avg_cost_snapshot',
    ]);
    const DEFAULTS = Object.freeze({ connectTimeoutMs: 5000, accountsTimeoutMs: 5000, positionsTimeoutMs: 10000, valuationWaitMs: 1500 });
    // The page remembers only the last backend host and port that answered, in this browser.
    const ENDPOINT_STORAGE_KEY = 'optionCombo.portfolioSnapshot.twsEndpoint';

    function failure(code, message) { const e = new Error(message); e.code = code; return e; }
    /** ws:// URL for a host name, IPv4 or bracketed IPv6 address and a port; anything else is refused. */
    function endpoint(host, port) {
        const h = String(host ?? '').trim(), p = Number(port);
        if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])$/.test(h)) {
            throw failure('endpoint_invalid', 'TWS 后端主机无效');
        }
        if (!Number.isInteger(p) || p < 1 || p > 65535 || String(port).trim() !== String(p)) throw failure('endpoint_invalid', 'TWS 后端端口无效');
        return `ws://${h}:${p}`;
    }

    /** The remembered host and port from a Storage-like object, or null; anything invalid is ignored. */
    function rememberedEndpoint(storage) {
        try {
            const saved = JSON.parse(storage?.getItem(ENDPOINT_STORAGE_KEY) ?? 'null');
            if (!saved || typeof saved !== 'object' || Object.keys(saved).sort().join() !== 'host,port') return null;
            endpoint(saved.host, saved.port);
            return { host: String(saved.host).trim(), port: String(saved.port).trim() };
        } catch (_) { return null; }
    }
    /** Stores only {host, port}; a valid endpoint is required and missing or refusing storage is ignored. */
    function rememberEndpoint(storage, host, port) {
        try {
            endpoint(host, port);
            storage?.setItem(ENDPOINT_STORAGE_KEY, JSON.stringify({ host: String(host).trim(), port: String(Number(port)) }));
            return !!storage;
        } catch (_) { return false; }
    }

    /**
     * One connection. Positions replies are matched by requestId, so the snapshot the backend
     * pushes on connect is ignored. Managed-account and valuation messages carry no request id;
     * every copy is the backend's current cache, so the latest ones received are used, and a
     * missing valuation only marks valuation unavailable.
     */
    function create(options) {
        const opts = { ...DEFAULTS, ...(options || {}) };
        const setTimer = opts.setTimeout || g.setTimeout.bind(g), clearTimer = opts.clearTimeout || g.clearTimeout.bind(g);
        const now = opts.now || (() => Date.now());
        let socket = null, sequence = 0, closedByUs = false, ended = null;
        const waiters = new Set(), valuations = [];

        function settleAll(error) { for (const w of [...waiters]) w.reject(error); }
        function ensureOpen() { if (!socket || socket.readyState !== 1) throw failure('not_connected', '尚未连接 TWS 后端'); }
        function send(action, payload) {
            if (!ALLOWED_ACTIONS.includes(action)) throw failure('action_not_allowed', '只读 TWS 客户端不发送此动作：' + action);
            ensureOpen();
            socket.send(JSON.stringify({ ...(payload || {}), action }));
        }
        function waitFor(accept, timeoutMs, code, message) {
            let waiter;
            const promise = new Promise((resolve, reject) => {
                const timer = setTimer(() => { waiters.delete(waiter); reject(failure(code, message)); }, timeoutMs);
                waiter = {
                    accept,
                    resolve: value => { clearTimer(timer); waiters.delete(waiter); resolve(value); },
                    reject: error => { clearTimer(timer); waiters.delete(waiter); reject(error); },
                };
                waiters.add(waiter);
            });
            return promise;
        }
        function receive(event) {
            let message;
            try { message = JSON.parse(typeof event?.data === 'string' ? event.data : ''); } catch (_) { return; }
            if (!message || typeof message !== 'object' || Array.isArray(message)) return;
            if (message.action === 'portfolio_avg_cost_update' && Array.isArray(message.items)) valuations.push(message);
            for (const w of [...waiters]) if (w.accept(message)) w.resolve(message);
        }
        function connect(url) {
            if (socket) return Promise.reject(failure('already_connected', '已连接'));
            const Impl = opts.WebSocket || g.WebSocket;
            closedByUs = false; ended = null; valuations.length = 0;
            return new Promise((resolve, reject) => {
                let opened = false, ws;
                try { ws = new Impl(url); } catch (e) { reject(failure('connect_failed', '无法连接 TWS 后端：' + (e?.message || e))); return; }
                socket = ws;
                const timer = setTimer(() => {
                    if (opened) return;
                    detach(ws); socket = null; try { ws.close(); } catch (_) { /* already closing */ }
                    reject(failure('connect_timeout', '连接 TWS 后端超时'));
                }, opts.connectTimeoutMs);
                ws.onopen = () => { opened = true; clearTimer(timer); resolve(); };
                ws.onmessage = receive;
                ws.onerror = () => { if (!opened) { clearTimer(timer); detach(ws); socket = null; reject(failure('connect_failed', '无法连接 TWS 后端')); } };
                ws.onclose = () => {
                    clearTimer(timer); detach(ws);
                    if (socket === ws) socket = null;
                    if (!opened) reject(failure('connect_failed', '无法连接 TWS 后端'));
                    ended = failure(closedByUs ? 'closed' : 'disconnected', closedByUs ? '已断开 TWS 后端' : 'TWS 后端连接已断开');
                    settleAll(ended);
                };
            });
        }
        function detach(ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; }
        async function accounts() {
            ensureOpen();
            const reply = waitFor(m => m.action === 'managed_accounts_update' && Array.isArray(m.accounts),
                opts.accountsTimeoutMs, 'accounts_timeout', 'TWS 后端未返回账户列表');
            send('request_managed_accounts_snapshot');
            const m = await reply;
            const list = [...new Set(m.accounts.map(a => String(a ?? '').trim()).filter(Boolean))];
            return { accounts: list, defaultAccount: list.includes(m.defaultAccount) ? m.defaultAccount : list[0] ?? null, ibConnected: m.ibConnected === true };
        }
        async function positions() {
            ensureOpen();
            const requestId = `portfolio-snapshot-tws-${++sequence}-${now()}`, started = now();
            const reply = waitFor(m => m.action === 'portfolio_positions_snapshot' && m.requestId === requestId,
                opts.positionsTimeoutMs, 'positions_timeout', 'TWS 后端未在时限内返回持仓');
            send('request_portfolio_positions_snapshot', { requestId });
            send('request_portfolio_avg_cost_snapshot');
            const positionsReply = await reply;
            const wait = opts.valuationWaitMs - (now() - started);
            if (wait > 0) await new Promise(resolve => setTimer(resolve, wait));
            if (!socket) throw ended || failure('closed', '已断开 TWS 后端');
            return { positionsReply, valuationReplies: valuations.slice() };
        }
        function close() {
            closedByUs = true;
            const ws = socket; socket = null;
            ended = failure('closed', '已断开 TWS 后端');
            settleAll(ended);
            if (ws) { detach(ws); try { ws.close(); } catch (_) { /* already closed */ } }
        }
        return Object.freeze({ connect, accounts, positions, close, send, get connected() { return !!socket && socket.readyState === 1; } });
    }

    g.OptionComboPortfolioSnapshotTwsClient = Object.freeze({ ALLOWED_ACTIONS, DEFAULTS, ENDPOINT_STORAGE_KEY, endpoint,
        rememberedEndpoint, rememberEndpoint, create });
})(typeof globalThis !== 'undefined' ? globalThis : this);
