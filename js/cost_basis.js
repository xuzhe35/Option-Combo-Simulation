/**
 * Blended cost ledger page — transport and rendering.
 *
 * Dedicated minimal WebSocket client: this page never loads ws_client.js,
 * app.js, valuation.js, or any order/market script, and every outbound
 * message is routed through the core module's ALLOWED_CLIENT_ACTIONS list.
 *
 * Two rules shape the whole file:
 *
 * - The ledger is the source of truth; the TWS snapshot only ever *detects*
 *   a gap. Reconciliation fills the entry form with a draft and stops. A
 *   human presses the button that writes.
 * - Every write carries a client token, so a retry after a dropped socket
 *   cannot book the same trade twice.
 */

(function bootCostBasisPage(globalScope) {
    'use strict';

    const core = globalScope.OptionComboCostBasisCore;
    const importer = globalScope.OptionComboCostBasisImport;
    if (!core) {
        return;
    }

    const DEFAULT_WS_HOST = '127.0.0.1';
    const DEFAULT_WS_PORT = 8765;
    const WS_HOST_STORAGE_KEY = 'optionComboWsHost';
    const WS_PORT_STORAGE_KEY = 'optionComboWsPort';
    const RECONNECT_BASE_DELAY_MS = 5000;
    const RECONNECT_MAX_DELAY_MS = 60000;
    const REQUEST_TIMEOUT_MS = 20000;
    const POSITIONS_TIMEOUT_MS = 8000;
    const FLOW_PAGE_SIZE = 25;
    const MANUAL_ACCOUNT_VALUE = '__manual_account__';
    // One request per 2000 rows (the store's page cap), looped until the
    // whole book is in hand.
    const LEDGER_FETCH_SIZE = 2000;
    const MAX_LEDGER_EVENTS = 100000;

    const KIND_LABELS = {
        opening_balance: '期初余额',
        share_trade: '股票买卖',
        option_trade: '期权开平仓',
        option_assignment: '被指派',
        option_exercise: '自行行权',
        option_expiry: '到期作废',
        dividend: '股息',
        fee: '费用',
        split: '拆股',
        manual_adjust: '手工调整',
        futures_trade: '期货买卖',
        futures_roll: '期货换月',
    };

    // Which entry-form fields each kind actually uses. A field that is not
    // listed is hidden and cleared, so a leftover strike from the previous
    // entry cannot ride along into a dividend row.
    const KIND_FIELDS = {
        opening_balance: ['shares', 'price'],
        share_trade: ['shares', 'price'],
        option_trade: ['right', 'strike', 'expiry', 'contracts', 'sharesPerContract', 'price'],
        option_assignment: ['right', 'strike', 'expiry', 'contracts', 'sharesPerContract', 'shares'],
        option_exercise: ['right', 'strike', 'expiry', 'contracts', 'sharesPerContract', 'shares'],
        option_expiry: ['right', 'strike', 'expiry', 'contracts'],
        dividend: [],
        fee: [],
        split: ['splitRatio'],
        // Cash-only by design. Position corrections use typed events so a
        // quantity cannot be accepted by the form and ignored by the core.
        manual_adjust: [],
        futures_trade: ['futureExpiry', 'futureContracts', 'sharesPerContract', 'price'],
        futures_roll: ['futureExpiry', 'futureContracts', 'sharesPerContract', 'price',
            'rollToExpiry', 'rollToPrice', 'rollGroup'],
    };

    // Short names for the same lenses, matching the 口径 selector's options.
    const BASIS_LABELS = {
        net_cash: '净现金',
        stock_only: '纯股票均价',
        tax_adjusted: '税务调整',
    };

    const BASIS_EXPLAINERS = {
        net_cash: '净现金口径：按股票净投入扣除已实现权利金，再除以持股数。'
            + '累计净现金始终按账户视角显示：收到为正、付出为负。'
            + '只认已平仓合约的权利金，未平仓的钱还在风险里。成本可以为负，'
            + '多头为负表示成本已全部收回；空头则显示可回补的'
            + '盈亏平衡水位，已实现权利金会把这条水位抬高。',
        stock_only: '纯股票均价：只按股票成交滚动平均，权利金完全独立列示。'
            + '这是唯一应该和 TWS 均价对得上的数——对不上就是账本漏记了。',
        tax_adjusted: '税务调整口径：被指派合约的权利金滚进股票成本'
            + '（短 Put 成本 = K − 每股权利金，短 Call 卖价 = K + 每股权利金），'
            + '其余权利金独立列示。用于解释纯股票均价与券商成本基准视图的残余差异。',
        futures: 'FOP / FUT 口径：当前 FUT 开仓基础，加换月已实现价差和费用，'
            + '再减已实现 FOP 权利金。未平仓 FOP 只在「若全部归零」一行中反映。',
    };

    const state = {
        ws: null,
        connection: 'disconnected',
        status: null,
        books: [],
        bookId: '',
        allEvents: [],      // every row of the book; the ledger is computed from this
        eventsTotal: 0,
        flowPage: 1,
        ledger: null,
        reconciliation: null,
        positions: [],
        positionsAt: '',
        positionsTimestamp: '',
        positionsConnected: false,
        positionsRequestId: '',
        avgCostByAccount: {},
        marketPrice: null,
        managedAccounts: [],
        managedAccountsConnected: false,
        scope: 'split',
        basisMode: 'net_cash',
        referencePrice: null,
        importResult: null,
        importText: '',
        resetPlan: null,
        reconnectDelay: RECONNECT_BASE_DELAY_MS,
        reconnectTimer: null,
        positionsTimer: null,
        requestCounter: 0,
        pending: new Map(),
        activeView: 'ledger',
    };

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    function $(id) {
        return globalScope.document.getElementById(id);
    }

    function _readStorage(key, fallback) {
        try {
            const value = globalScope.localStorage.getItem(key);
            return value === null || value === undefined || value === ''
                ? fallback : value;
        } catch (_) {
            return fallback;
        }
    }

    function _token(prefix) {
        const source = globalScope.crypto && globalScope.crypto.randomUUID
            ? globalScope.crypto.randomUUID().replace(/-/g, '')
            : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        return `${prefix}${source.slice(0, 24)}`;
    }

    function _stableHash16(value) {
        const source = String(value || '');
        let low = 0x811c9dc5;
        let high = 0x01000193;
        for (let index = 0; index < source.length; index += 1) {
            const code = source.charCodeAt(index);
            low = Math.imul(low ^ code, 0x01000193) >>> 0;
            high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
        }
        return (`0000000${low.toString(16)}`).slice(-8)
            + (`0000000${high.toString(16)}`).slice(-8);
    }

    function _todayIso() {
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${now.getFullYear()}-${month}-${day}`;
    }

    function _localTimestampIso() {
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        return `${now.getFullYear()}-${month}-${day}T${hour}:${minute}:${second}`;
    }

    function _shiftDays(isoDate, days) {
        const parts = String(isoDate || '').split('-');
        const date = new Date(Date.UTC(
            Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
        date.setUTCDate(date.getUTCDate() + days);
        return date.toISOString().slice(0, 10);
    }

    function _money(value, places) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) {
            return '—';
        }
        const digits = places === undefined ? 2 : places;
        return Number(value).toLocaleString('en-US', {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        });
    }

    /** Account cash delta: receipts are visibly positive, payments negative. */
    function _signedMoney(value, places) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) {
            return '—';
        }
        const digits = places === undefined ? 2 : places;
        const numeric = Number(value);
        const displayValue = Math.abs(numeric) < (0.5 * (10 ** -digits)) ? 0 : numeric;
        const formatted = _money(displayValue, digits);
        return displayValue > 0 ? `+${formatted}` : formatted;
    }

    function _quantity(value) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) {
            return '—';
        }
        return Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 });
    }

    /** Current notional and P&L versus the cost lens visible in the hero. */
    function computeMarketMetrics(referencePrice, exposure, blendedCost) {
        const price = Number(referencePrice);
        const quantity = Number(exposure);
        if (referencePrice === null || referencePrice === undefined
            || !Number.isFinite(price) || !Number.isFinite(quantity)) {
            return { marketValue: null, dilutedPnl: null };
        }
        const marketValue = price * quantity;
        const cost = Number(blendedCost);
        const dilutedPnl = blendedCost === null || blendedCost === undefined
            || !Number.isFinite(cost)
            ? null : (price - cost) * quantity;
        return { marketValue, dilutedPnl };
    }

    function _text(node, value) {
        if (node) node.textContent = value;
    }

    function _clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function _cell(row, value, className) {
        const cell = globalScope.document.createElement('td');
        cell.textContent = value;
        if (className) cell.className = className;
        row.appendChild(cell);
        return cell;
    }

    function _describeContract(event) {
        if (event.kind === 'futures_roll') {
            return `${event.futureExpiry || ''} → ${event.rollToExpiry || ''}`.trim();
        }
        if (event.kind === 'futures_trade') {
            return `${event.futureExpiry || ''} FUT`.trim();
        }
        if ((event.kind === 'option_assignment' || event.kind === 'option_exercise')
            && event.optionSecType === 'FOP') {
            const strike = event.strike === null || event.strike === undefined
                ? '' : event.strike;
            return `${event.expiry || ''} ${event.right || ''}${strike}`.trim()
                + ` → ${event.futureExpiry || ''} FUT`;
        }
        if (!event.right) return '';
        const strike = event.strike === null || event.strike === undefined
            ? '' : event.strike;
        return `${event.expiry || ''} ${event.right}${strike}`.trim();
    }

    // ------------------------------------------------------------------
    // Transport
    // ------------------------------------------------------------------

    function _setConnection(nextState) {
        state.connection = nextState;
        const banner = $('connection-banner');
        const labels = {
            connected: '已连接',
            connecting: '连接中…',
            unavailable: '账本库不可用',
            disconnected: '未连接',
        };
        if (banner) {
            banner.dataset.state = nextState;
            banner.textContent = labels[nextState] || nextState;
        }
        const topbar = $('topbar-connection');
        if (topbar) {
            topbar.dataset.state = nextState;
            const label = topbar.querySelector('span');
            _text(label, nextState === 'connected'
                ? '后端已连接' : (labels[nextState] || nextState));
        }
        _text($('settings-connection-label'), labels[nextState] || nextState);
        const orb = globalScope.document.querySelector('.connection-orb');
        if (orb) orb.dataset.state = nextState;
        _refreshControls();
        if (!state.books.length
            && (nextState === 'disconnected' || nextState === 'unavailable')) {
            _renderSidebarBooks();
            _showView('settings');
        }
    }

    function connect() {
        const host = _readStorage(WS_HOST_STORAGE_KEY, DEFAULT_WS_HOST);
        const port = _readStorage(WS_PORT_STORAGE_KEY, String(DEFAULT_WS_PORT));
        if ($('server-host')) $('server-host').value = host;
        if ($('server-port')) $('server-port').value = port;
        _text($('sidebar-server-address'), `${host}:${port}`);
        _setConnection('connecting');
        let socket;
        try {
            socket = new globalScope.WebSocket(`ws://${host}:${port}`);
        } catch (_) {
            _scheduleReconnect();
            return;
        }
        state.ws = socket;

        socket.onopen = () => {
            state.reconnectDelay = RECONNECT_BASE_DELAY_MS;
            _setConnection('connected');
            _bootstrap();
        };
        socket.onclose = () => {
            if (state.ws !== socket) return;
            state.ws = null;
            _failPending('socket closed');
            _invalidatePositions();
            _invalidateManagedAccounts();
            _setConnection('disconnected');
            _scheduleReconnect();
        };
        socket.onerror = () => {
            try { socket.close(); } catch (_) { /* onclose handles it */ }
        };
        socket.onmessage = (message) => {
            if (state.ws !== socket) return;
            let data;
            try {
                data = JSON.parse(message.data);
            } catch (_) {
                return;
            }
            _handleMessage(data);
        };
    }

    function _scheduleReconnect() {
        if (state.reconnectTimer) return;
        const delay = state.reconnectDelay;
        state.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
        state.reconnectTimer = globalScope.setTimeout(() => {
            state.reconnectTimer = null;
            connect();
        }, delay);
    }

    /**
     * Send one request and resolve on its matching response.
     *
     * The action is checked against the core whitelist before it can reach
     * the socket, so this page cannot be turned into an order path by a
     * later edit that forgets the rule.
     */
    function request(action, fields) {
        return new Promise((resolve, reject) => {
            if (core.ALLOWED_CLIENT_ACTIONS.indexOf(action) < 0) {
                reject(new Error(`action ${action} is not allowed from this page`));
                return;
            }
            const socket = state.ws;
            if (!socket || socket.readyState !== 1) {
                reject(new Error('未连接到后端'));
                return;
            }
            state.requestCounter += 1;
            const requestId = `cb-${state.requestCounter}-${Date.now()}`;
            const timer = globalScope.setTimeout(() => {
                state.pending.delete(requestId);
                reject(new Error('请求超时'));
            }, REQUEST_TIMEOUT_MS);
            state.pending.set(requestId, { resolve, reject, timer });
            socket.send(JSON.stringify(Object.assign(
                { action, requestId }, fields || {})));
        });
    }

    function _sendOneWay(action, fields) {
        if (core.ALLOWED_CLIENT_ACTIONS.indexOf(action) < 0) return false;
        const socket = state.ws;
        if (!socket || socket.readyState !== 1) return false;
        socket.send(JSON.stringify(Object.assign({ action }, fields || {})));
        return true;
    }

    function _failPending(reason) {
        state.pending.forEach((entry) => {
            globalScope.clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        });
        state.pending.clear();
    }

    function _handleMessage(data) {
        if (!data || typeof data !== 'object') return;

        if (data.action === 'managed_accounts_update') {
            _applyManagedAccountsUpdate(data);
            return;
        }

        if (data.action === 'portfolio_positions_snapshot') {
            const incomingRequestId = typeof data.requestId === 'string'
                ? data.requestId : '';
            // A direct reply belongs only to the latest refresh. While such
            // a refresh is pending, an untagged coalesced broadcast cannot
            // repopulate the just-invalidated snapshot with an older state.
            if (state.positionsRequestId) {
                if (incomingRequestId !== state.positionsRequestId) return;
            } else if (incomingRequestId) {
                return;
            }
            state.positionsRequestId = '';
            state.positions = Array.isArray(data.items) ? data.items : [];
            // Both flags are affirmative evidence.  A response from an
            // older/partial backend that omits positionsReady must not turn
            // an empty array into a trusted zero-position snapshot.
            state.positionsConnected = data.ibConnected === true
                && data.positionsReady === true;
            state.positionsTimestamp = _localTimestampIso();
            state.positionsAt = new Date().toLocaleTimeString();
            if (state.positionsTimer) {
                globalScope.clearTimeout(state.positionsTimer);
                state.positionsTimer = null;
            }
            _renderPositionsStatus();
            _recompute();
            return;
        }
        if (data.action === 'portfolio_avg_cost_update') {
            _absorbAvgCost(Array.isArray(data.items) ? data.items : []);
            _recompute();
            return;
        }

        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        const entry = requestId ? state.pending.get(requestId) : null;
        if (!entry) return;
        state.pending.delete(requestId);
        globalScope.clearTimeout(entry.timer);
        if (data.success === false) {
            const error = new Error(data.message || data.code || '请求失败');
            error.code = data.code || '';
            entry.reject(error);
            return;
        }
        entry.resolve(data);
    }

    function _absorbAvgCost(items) {
        const book = _currentBook();
        if (!book) return;
        const symbol = String(book.symbol || '').toUpperCase();
        const secType = String(book.secType || 'STK').toUpperCase();
        const matched = items.filter((item) => (
            String(item.symbol || '').toUpperCase() === symbol
            && String(item.secType || '').toUpperCase() === secType
            && (!book.account
                || String(item.account || '').toUpperCase()
                    === String(book.account).toUpperCase())));
        if (secType === 'FUT') {
            const byAccount = new Map();
            matched.forEach((item) => {
                const account = String(item.account || '');
                const contracts = Number(item.position) || 0;
                const multiplier = Math.abs(Number(item.multiplier))
                    || Number(book.defaultSharesPerContract) || 1;
                const avgCost = Number(item.avgCostPerUnit);
                if (!Number.isFinite(avgCost) || !contracts) return;
                const current = byAccount.get(account) || { exposure: 0, basis: 0 };
                current.exposure += contracts * multiplier;
                current.basis += avgCost * contracts * multiplier;
                byAccount.set(account, current);
                const marketPrice = Number(item.marketPrice);
                if (Number.isFinite(marketPrice) && marketPrice > 0) {
                    state.marketPrice = marketPrice;
                }
            });
            byAccount.forEach((entry, account) => {
                if (Math.abs(entry.exposure) > 1e-6) {
                    state.avgCostByAccount[account] = {
                        avgCost: entry.basis / entry.exposure,
                        marketPrice: state.marketPrice,
                    };
                }
            });
            return;
        }
        matched.forEach((item) => {
            state.avgCostByAccount[String(item.account || '')] = {
                avgCost: Number(item.avgCostPerUnit),
                marketPrice: Number(item.marketPrice),
            };
            if (Number.isFinite(Number(item.marketPrice)) && Number(item.marketPrice) > 0) {
                // Price is the same in every account, so any account that
                // reports it gives the whole page a reference price.
                state.marketPrice = Number(item.marketPrice);
            }
        });
    }

    function _applyManagedAccountsUpdate(data) {
        const accounts = Array.isArray(data.accounts)
            ? data.accounts
                .map((account) => String(account || '').trim())
                .filter((account, index, list) => account
                    && list.indexOf(account) === index)
            : [];
        const select = $('new-book-account');
        const previous = select ? String(select.value || '').trim() : '';
        state.managedAccounts = accounts;
        state.managedAccountsConnected = data.ibConnected === true;
        _renderManagedAccounts(previous);
        _refreshControls();
    }

    function _invalidateManagedAccounts() {
        const select = $('new-book-account');
        const previous = select ? String(select.value || '').trim() : '';
        state.managedAccounts = [];
        state.managedAccountsConnected = false;
        _renderManagedAccounts(previous);
        _refreshControls();
    }

    function _renderManagedAccounts(preferredAccount) {
        const select = $('new-book-account');
        if (!select) return;
        const manualInput = $('new-book-account-manual');
        const liveAccounts = state.managedAccounts;
        const hasLiveAccounts = liveAccounts.length > 0;
        const knownBookAccounts = state.books
            .map((book) => String((book && book.account) || '').trim())
            .filter((account, index, list) => account
                && list.indexOf(account) === index);
        const preferred = String(preferredAccount || select.value || '').trim();
        const accounts = hasLiveAccounts ? liveAccounts : knownBookAccounts.slice();
        if (!hasLiveAccounts && preferred && preferred !== MANUAL_ACCOUNT_VALUE
            && !accounts.includes(preferred)) {
            // Keep an account that TWS reported earlier in this page session
            // available if IB disconnects while the creation form is open.
            accounts.push(preferred);
        }

        let selected = accounts.includes(preferred) ? preferred : '';
        if (!hasLiveAccounts && preferred === MANUAL_ACCOUNT_VALUE) {
            selected = MANUAL_ACCOUNT_VALUE;
        } else if (!selected && accounts.length === 1) {
            selected = accounts[0];
        } else if (!selected && !hasLiveAccounts && accounts.length === 0) {
            selected = MANUAL_ACCOUNT_VALUE;
        }

        _clear(select);
        if (!selected) {
            const placeholder = globalScope.document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = hasLiveAccounts
                ? '选择 TWS 账户' : '选择已有 IB 账户或手动输入';
            placeholder.selected = true;
            placeholder.disabled = true;
            select.appendChild(placeholder);
        }
        accounts.forEach((account) => {
            const option = globalScope.document.createElement('option');
            option.value = account;
            option.textContent = account;
            option.selected = account === selected;
            select.appendChild(option);
        });
        if (!hasLiveAccounts) {
            const manualOption = globalScope.document.createElement('option');
            manualOption.value = MANUAL_ACCOUNT_VALUE;
            manualOption.textContent = '手动输入其他 IB 账号…';
            manualOption.selected = selected === MANUAL_ACCOUNT_VALUE;
            select.appendChild(manualOption);
        }
        select.value = selected;
        select.disabled = state.connection !== 'connected'
            || !(state.status && state.status.available);

        const manualSelected = selected === MANUAL_ACCOUNT_VALUE;
        manualInput.hidden = !manualSelected;
        manualInput.required = manualSelected;
        manualInput.disabled = !manualSelected || select.disabled;

        if (hasLiveAccounts && !selected) {
            _text($('new-book-account-hint'), '请选择这个账本所属的 TWS 账户。');
        } else if (hasLiveAccounts) {
            _text($('new-book-account-hint'), `新账本将固定归属于 ${selected}。`);
        } else if (manualSelected) {
            _text($('new-book-account-hint'),
                'IB API 未连接：请手动输入准确的 IB 账号；连接后会改用 TWS 账户列表。');
        } else {
            _text($('new-book-account-hint'),
                'IB API 未连接：可选择已有账本账户，或选择“手动输入其他 IB 账号”。');
        }
    }

    function _selectedNewBookAccount() {
        const selected = String($('new-book-account').value || '').trim();
        if (selected === MANUAL_ACCOUNT_VALUE) {
            return String($('new-book-account-manual').value || '').trim();
        }
        return selected;
    }

    // ------------------------------------------------------------------
    // Data flow
    // ------------------------------------------------------------------

    async function _bootstrap() {
        _sendOneWay('request_managed_accounts_snapshot');
        try {
            const status = await request('request_cost_basis_status');
            state.status = status;
            if (!status.available) {
                _setConnection('unavailable');
                _text($('store-status'), `不可用（${status.reason || '未知原因'}）`);
                return;
            }
            _text($('store-status'), `就绪 · schema v${status.storeSchemaVersion}`);
            await _loadBooks();
        } catch (error) {
            _text($('store-status'), `不可用（${error.message}）`);
            _setConnection('unavailable');
        }
    }

    async function _loadBooks() {
        const response = await request('list_cost_basis_books');
        state.books = Array.isArray(response.books) ? response.books : [];
        _renderManagedAccounts($('new-book-account').value);
        const select = $('book-select');
        _clear(select);
        if (!state.books.length) {
            const option = globalScope.document.createElement('option');
            option.value = '';
            option.textContent = '— 无账本 —';
            select.appendChild(option);
            state.bookId = '';
            state.allEvents = [];
            state.eventsTotal = 0;
            state.ledger = null;
            state.reconciliation = null;
            state.resetPlan = null;
            state.importResult = null;
            state.importText = '';
            _renderSidebarBooks();
            _renderAll();
            _showView('settings');
            return;
        }
        state.books.forEach((book) => {
            const option = globalScope.document.createElement('option');
            option.value = book.bookId;
            option.textContent = `${book.account || '旧版未限定账户'} · ${book.symbol}`
                + ` · ${book.secType || 'STK'}`
                + `（${book.eventCount} 条）`;
            select.appendChild(option);
        });
        if (!state.books.some((book) => book.bookId === state.bookId)) {
            state.bookId = state.books[0].bookId;
        }
        select.value = state.bookId;
        _renderSidebarBooks();
        await _loadEvents();
    }

    function _currentBook() {
        return state.books.find((book) => book.bookId === state.bookId) || null;
    }

    function _showView(view) {
        const next = view === 'settings' ? 'settings' : 'ledger';
        state.activeView = next;
        $('ledger-view').hidden = next !== 'ledger';
        $('settings-view').hidden = next !== 'settings';
        $('btn-open-settings').classList.toggle('active', next === 'settings');
        Array.from($('book-sidebar-list').querySelectorAll('[data-book-id]'))
            .forEach((button) => button.classList.toggle(
                'active', next === 'ledger' && button.dataset.bookId === state.bookId));
        const book = _currentBook();
        _text($('page-eyebrow'), next === 'settings'
            ? '系统管理' : '综合成本账本');
        _text($('page-title'), next === 'settings'
            ? '设置与新建账本'
            : (book ? `${book.account || '旧版账户'} / ${book.symbol}` : '请选择账本'));
        globalScope.document.body.classList.remove('sidebar-open');
    }

    function _renderSidebarBooks() {
        const container = $('book-sidebar-list');
        if (!container) return;
        _clear(container);
        if (!state.books.length) {
            const empty = globalScope.document.createElement('p');
            empty.className = 'sidebar-empty';
            empty.textContent = state.status && state.status.available
                ? '还没有账本。请从下方设置页创建。'
                : '连接后显示已建立的账本。';
            container.appendChild(empty);
            return;
        }
        const groups = new Map();
        state.books.forEach((book) => {
            const account = book.account || '旧版未限定账户';
            if (!groups.has(account)) groups.set(account, []);
            groups.get(account).push(book);
        });
        groups.forEach((books, account) => {
            const group = globalScope.document.createElement('div');
            group.className = 'account-group';
            const heading = globalScope.document.createElement('div');
            heading.className = 'account-heading';
            heading.textContent = account;
            group.appendChild(heading);
            books.sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)))
                .forEach((book) => {
                    const button = globalScope.document.createElement('button');
                    button.type = 'button';
                    button.className = 'nav-item book-nav-item';
                    button.dataset.bookId = book.bookId;
                    const symbolMark = globalScope.document.createElement('span');
                    symbolMark.className = 'book-symbol';
                    symbolMark.textContent = String(book.symbol || '?').slice(0, 3);
                    const labels = globalScope.document.createElement('span');
                    const title = globalScope.document.createElement('strong');
                    title.textContent = book.symbol || '未知标的';
                    const meta = globalScope.document.createElement('small');
                    meta.textContent = `${book.secType || 'STK'} · ${book.eventCount || 0} 条事件`;
                    labels.appendChild(title);
                    labels.appendChild(meta);
                    button.appendChild(symbolMark);
                    button.appendChild(labels);
                    button.classList.toggle('active', state.activeView === 'ledger'
                        && book.bookId === state.bookId);
                    button.addEventListener('click', async () => {
                        if (state.bookId !== book.bookId) {
                            state.bookId = book.bookId;
                            $('book-select').value = book.bookId;
                            state.avgCostByAccount = {};
                            state.marketPrice = null;
                            state.importResult = null;
                            state.importText = '';
                            $('import-file').value = '';
                            $('import-replace').checked = false;
                            $('import-confirm').value = '';
                            await _loadEvents();
                            await _refreshResetPlan();
                            _renderImportPreview();
                        }
                        _showView('ledger');
                    });
                    group.appendChild(button);
                });
            container.appendChild(group);
        });
    }

    function _positionsForBook(book) {
        const account = String((book && book.account) || '').toUpperCase();
        if (!account) return state.positions.slice();
        return state.positions.filter((item) => (
            String(item.account || '').toUpperCase() === account));
    }

    function _bookIsFutures() {
        const book = _currentBook();
        return Boolean(book && String(book.secType || 'STK').toUpperCase() === 'FUT');
    }

    function _fieldsForKind(kind) {
        let visible = (KIND_FIELDS[kind] || []).slice();
        if (_bookIsFutures()
            && (kind === 'option_assignment' || kind === 'option_exercise')) {
            visible = visible.filter((field) => field !== 'shares');
            visible.push('futureExpiry', 'futureContracts');
        }
        return visible;
    }

    function _syncBookMode() {
        const book = _currentBook();
        const futures = _bookIsFutures();
        const allowed = futures
            ? new Set(['option_trade', 'option_assignment', 'option_exercise',
                'option_expiry', 'futures_trade', 'futures_roll', 'fee', 'manual_adjust'])
            : new Set(['option_trade', 'option_assignment', 'option_exercise',
                'option_expiry', 'share_trade', 'opening_balance', 'dividend',
                'fee', 'split', 'manual_adjust']);
        Array.from($('field-kind').options).forEach((option) => {
            option.disabled = !allowed.has(option.value);
        });
        if (!allowed.has($('field-kind').value)) {
            $('field-kind').value = futures ? 'option_trade' : 'share_trade';
        }
        if (futures) {
            state.basisMode = 'net_cash';
            $('basis-select').value = 'net_cash';
        }
        if (book && book.account) {
            state.scope = 'split';
            $('scope-select').value = 'split';
        }
        $('scope-select').disabled = Boolean(book && book.account);
        $('basis-select').disabled = futures;
        _text($('field-spc-label'), futures ? 'FUT 点值 / 期权乘数' : '每张股数');
        if (book && Number(book.defaultSharesPerContract) > 0) {
            $('field-spc').value = String(book.defaultSharesPerContract);
        }
        $('field-account').value = book ? (book.account || '') : '';
        $('field-account').readOnly = Boolean(book && book.account);
        $('field-account').title = book && book.account
            ? '事件账户由当前账本固定' : '旧版未限定账户的账本可手工选择事件账户';
        _text($('flow-position-heading'), futures ? '累计 FUT 净张数' : '累计股数');
        _applyKindVisibility();
    }

    /**
     * Load every row of the book, voided ones included.
     *
     * Cost, reconciliation, the premium windows, snapshots and the CSV
     * export are all whole-ledger facts: computing them from one page - or
     * worse, from a filtered page - silently answers a different question
     * than the operator asked. The flow table filters and pages this array
     * locally instead, so its running columns stay anchored to the real
     * timeline rather than restarting at whatever the page begins with.
     */
    async function _loadEvents() {
        if (!state.bookId) return;
        const collected = [];
        let offset = 0;
        let total = 0;
        for (;;) {
            const response = await request('list_cost_basis_events', {
                bookId: state.bookId,
                limit: LEDGER_FETCH_SIZE,
                offset,
                includeVoided: true,
            });
            const batch = Array.isArray(response.events) ? response.events : [];
            batch.forEach((event) => {
                const timestamp = _exactBrokerTimestamp(event);
                if (timestamp) event.brokerTimestamp = timestamp;
                collected.push(event);
            });
            total = Number(response.total) || 0;
            offset += batch.length;
            if (!batch.length || collected.length >= total) break;
            if (offset > MAX_LEDGER_EVENTS) {
                globalScope.alert(
                    `账本超过 ${MAX_LEDGER_EVENTS} 条，只载入了前 ${offset} 条；`
                    + '总览数字将不完整，请先归档或拆分账本。');
                break;
            }
        }
        state.allEvents = collected;
        state.eventsTotal = total;
        state.flowPage = 1;
        _syncBookMode();
        _renderBookMeta();
        _recompute();
        // A preview is a calculation over the ledger state at that moment.
        // Manual entries, voids, or a refresh can change the opening-position
        // arithmetic after the file was selected, so never leave an old
        // preview armed against newly loaded events.
        if (state.importText && importer) {
            _parseImportText(state.importText);
            _renderImportPreview();
        }
    }

    /** The rows the flow table should show, after local filtering. */
    function _flowRows() {
        if (!state.ledger) return [];
        const account = $('filter-account').value;
        const kind = $('filter-kind').value;
        const start = $('filter-start').value;
        const end = $('filter-end').value;
        const showVoided = $('filter-voided').checked === true;
        return state.ledger.rows.filter((row) => {
            const event = row.event;
            if (!showVoided && event.voidedAtUtc) return false;
            if (account && String(event.account || '') !== account) return false;
            if (kind && event.kind !== kind) return false;
            if (start && String(event.tradeDate || '') < start) return false;
            if (end && String(event.tradeDate || '') > end) return false;
            return true;
        }).reverse();
    }

    function requestPositions() {
        const socket = state.ws;
        if (!socket || socket.readyState !== 1) return;
        _invalidatePositions();
        state.requestCounter += 1;
        state.positionsRequestId = `cb-pos-${state.requestCounter}-${Date.now()}`;
        socket.send(JSON.stringify({
            action: 'request_portfolio_positions_snapshot',
            requestId: state.positionsRequestId,
        }));
        socket.send(JSON.stringify({ action: 'request_portfolio_avg_cost_snapshot' }));
        _text($('positions-status'), '拉取中…');
        if (state.positionsTimer) globalScope.clearTimeout(state.positionsTimer);
        // The avg-cost snapshot answers only when TWS has pushed portfolio
        // updates, so silence is a normal outcome and must not look like a
        // hang.
        state.positionsTimer = globalScope.setTimeout(() => {
            state.positionsTimer = null;
            if (!state.positionsAt) {
                state.positionsRequestId = '';
                _text($('positions-status'), '无响应（TWS 可能未连接）');
            }
        }, POSITIONS_TIMEOUT_MS);
    }

    function _invalidatePositions() {
        if (state.positionsTimer) {
            globalScope.clearTimeout(state.positionsTimer);
            state.positionsTimer = null;
        }
        state.positions = [];
        state.positionsAt = '';
        state.positionsTimestamp = '';
        state.positionsConnected = false;
        state.positionsRequestId = '';
        state.avgCostByAccount = {};
        state.marketPrice = null;
        state.reconciliation = null;
        _renderPositionsStatus();
    }

    function _renderPositionsStatus() {
        const node = $('positions-status');
        if (!state.positionsAt) {
            _text(node, '未获取');
            _text($('settings-positions-status'), '未获取');
            return;
        }
        const label = state.positionsConnected
            ? `${state.positionsAt} · ${state.positions.length} 条持仓`
            : `${state.positionsAt} · TWS 未连接，数量不可信`;
        _text(node, label);
        _text($('settings-positions-status'), label);
    }

    function canReconcilePositions(positionsAt, positionsConnected) {
        return Boolean(positionsAt && positionsConnected);
    }

    function _recompute() {
        const book = _currentBook();
        if (!book) {
            state.ledger = null;
            state.reconciliation = null;
            _renderAll();
            return;
        }
        const reference = state.referencePrice !== null
            ? state.referencePrice
            : state.marketPrice;
        const secType = String(book.secType || 'STK').toUpperCase();
        state.ledger = core.computeLedger(state.allEvents, {
            referencePrice: reference,
            secType,
        });
        // An empty snapshot is meaningful only after IB explicitly reports
        // that position synchronization completed. Treating a disconnect or
        // an unfinished snapshot as an authoritative all-zero portfolio
        // manufactures false assignments, expiries, and manual-entry advice.
        state.reconciliation = canReconcilePositions(
            state.positionsAt, state.positionsConnected)
            ? core.buildReconciliation({
                ledger: state.ledger,
                positions: _positionsForBook(book),
                symbol: book.symbol,
                secType,
                today: _todayIso(),
                defaultSharesPerContract: book.defaultSharesPerContract,
            })
            : null;
        _renderAll();
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function _renderAll() {
        _renderBookMeta();
        _renderSummary();
        _renderReconciliation();
        _renderPremium();
        _renderFlow();
        _renderAccountFilter();
        _refreshControls();
    }

    function _renderBookMeta() {
        const book = _currentBook();
        const node = $('book-meta');
        if (!book) {
            _text(node, '未选择账本。');
            if (state.activeView === 'ledger') _text($('page-title'), '请选择账本');
            return;
        }
        const futures = String(book.secType || 'STK').toUpperCase() === 'FUT';
        _text(node, `${book.account || '旧版未限定账户'} · ${book.symbol}`
            + ` · ${futures ? 'FOP / FUT' : '股票 / ETF'} · 起算日 ${book.startDate}`
            + ` · ${futures ? '点值' : '每张交割股数'} ${book.defaultSharesPerContract}`
            + ` · ${state.eventsTotal} 条事件`
            + (book.firstEventDate ? ` · ${book.firstEventDate} 至 ${book.lastEventDate}` : '')
            + (!book.account ? ' · 兼容模式：可包含多账户历史' : ''));
        if (state.activeView === 'ledger') {
            _text($('page-title'), `${book.account || '旧版账户'} / ${book.symbol}`);
        }
    }

    function _summaryColumns() {
        if (!state.ledger) return [];
        // With a single account the combined figures ARE that account's, but
        // labelling the column 合计 hides whose they are on a page whose
        // whole point is per-account reconciliation.
        if (state.scope !== 'combined' && state.ledger.accounts.length === 1) {
            const account = state.ledger.accounts[0];
            return [{
                key: account,
                label: account || '（未标账户）',
                summary: state.ledger.perAccount[account],
            }];
        }
        if (state.scope === 'combined' || state.ledger.accounts.length <= 1) {
            return [{ key: 'combined', label: '合计', summary: state.ledger.combined }];
        }
        const columns = state.ledger.accounts.map((account) => ({
            key: account,
            label: account || '（未标账户）',
            summary: state.ledger.perAccount[account],
        }));
        columns.push({ key: 'combined', label: '合计', summary: state.ledger.combined });
        return columns;
    }

    function _renderSummary() {
        _renderDashboardSummary();
        const table = $('summary-table');
        const head = table.querySelector('thead');
        const body = table.querySelector('tbody');
        _clear(head);
        _clear(body);
        const book = _currentBook();
        const futures = Boolean(book
            && String(book.secType || 'STK').toUpperCase() === 'FUT');
        _text($('basis-explainer'), futures
            ? BASIS_EXPLAINERS.futures : (BASIS_EXPLAINERS[state.basisMode] || ''));

        const columns = _summaryColumns();
        if (!columns.length) {
            const row = globalScope.document.createElement('tr');
            const cell = globalScope.document.createElement('td');
            cell.className = 'empty';
            cell.textContent = '未选择账本';
            row.appendChild(cell);
            body.appendChild(row);
            return;
        }

        const headRow = globalScope.document.createElement('tr');
        const corner = globalScope.document.createElement('th');
        corner.textContent = '指标';
        headRow.appendChild(corner);
        columns.forEach((column) => {
            const cell = globalScope.document.createElement('th');
            cell.textContent = column.label;
            headRow.appendChild(cell);
        });
        head.appendChild(headRow);

        _summaryRow(body, futures ? '当前 FUT 净张数' : '当前股票净头寸', columns,
            (summary) => _quantity(futures
                ? summary.futuresContracts : summary.shares));
        _headlineRow(body, columns);
        _summaryRow(body, '若未平仓期权全部归零', columns,
            (summary) => (summary.blendedCostIfExpired === null
                ? '—' : _money(summary.blendedCostIfExpired, 4)));
        _summaryRow(body, futures ? '当前 FUT 开仓均价' : '纯股票均价', columns,
            (summary) => ((futures ? summary.futuresAvgCost : summary.stockAvgCost) === null
                ? '—' : _money(futures
                    ? summary.futuresAvgCost : summary.stockAvgCost, 4)));
        _twsAvgCostRow(body, columns);

        _sectionRow(body, '现金分解', columns.length);
        _summaryRow(body, '累计净现金（收正付负）', columns,
            (summary) => _signedMoney(summary.netCash));
        _summaryRow(body, '已实现期权费', columns,
            (summary) => _money(summary.realizedPremium));
        _summaryRow(body, '未实现期权费', columns,
            (summary) => _money(summary.openPremium));
        _summaryRow(body, futures ? 'FUT 换月 / 平仓已实现盈亏' : '股票已实现盈亏', columns,
            (summary) => _money(futures
                ? summary.futuresRealizedPnl : summary.stockRealizedPnl));
        if (!futures) {
            _summaryRow(body, '股息', columns, (summary) => _money(summary.dividends));
        }
        _summaryRow(body, '费用合计', columns, (summary) => _money(summary.fees));

        _sectionRow(body, '按参考价', columns.length);
        _summaryRow(body, '盈亏平衡价', columns,
            (summary) => (summary.breakEvenPrice === null
                ? '—' : _money(summary.breakEvenPrice, 4)));
        _summaryRow(body, '全部清算后累计净收益', columns,
            (summary) => (summary.lifetimeNetIfLiquidated === null
                ? '—' : _signedMoney(summary.lifetimeNetIfLiquidated)));

        _renderWarnings();
        _renderReferenceSource();
    }

    /**
     * Decide what the hero figure says for one cost lens.
     *
     * `no_shares`/`no_futures` is the ONLY unavailable state with a lifetime
     * figure behind it. Every other one leaves an open position whose
     * selected lens simply has no number, and captioning that "no position"
     * asserts something the ledger does not support.
     *
     * The incompleteness marker rides on every path that puts a figure at
     * the top of the page, closed-out books included: a premium-less
     * prior_open stub taints a lifetime net-cash total exactly as much as a
     * per-share cost. The detail table already says so, and the hero must
     * not read as the more confident of the two.
     */
    function describeHeadlineCost(rendered, options) {
        const futures = Boolean(options && options.futures);
        const basisMode = (options && options.basisMode) || 'net_cash';
        const marks = [];
        let source;
        let caption;
        if (rendered.state === 'no_shares' || rendered.state === 'no_futures') {
            source = 'lifetime_net_cash';
            caption = futures
                ? '当前无 FUT 持仓：显示全周期累计净现金'
                : '当前无持股：显示全周期累计净现金';
        } else if (!rendered.available) {
            source = 'unavailable';
            caption = futures
                ? '当前口径无可用成本'
                : `当前口径（${BASIS_LABELS[basisMode] || basisMode}）无可用成本`;
        } else {
            source = 'cost';
            caption = futures ? '每 FUT 点综合成本' : '每股综合成本';
            if (rendered.state === 'recovered') {
                marks.push('recovered');
                caption += ' · 成本已全部收回';
            } else if (rendered.state === 'short') {
                marks.push('short');
                caption += basisMode === 'net_cash'
                    ? ' · 空头回补水位' : ' · 空头均价';
            }
        }
        if (rendered.costIncomplete) {
            marks.push('incomplete');
            caption += ' · 成本不完整';
        }
        return { source, caption, marks };
    }

    function _renderDashboardSummary() {
        const ids = ['headline-cost', 'headline-position', 'headline-expired-cost',
            'headline-reference-price', 'headline-market-value',
            'headline-diluted-pnl', 'headline-stock-cost', 'headline-tws-cost',
            'headline-break-even', 'cash-net', 'cash-realized-premium',
            'cash-open-premium', 'cash-dividends', 'cash-fees'];
        if (!state.ledger || !_currentBook()) {
            ids.forEach((id) => _text($(id), '—'));
            _text($('headline-cost-caption'), '选择账本后显示');
            $('headline-cost').className = 'hero-value';
            $('headline-diluted-pnl').className = '';
            return;
        }
        const book = _currentBook();
        const summary = state.ledger.combined;
        const futures = String(book.secType || 'STK').toUpperCase() === 'FUT';
        const rendered = core.summarizeCost(summary, state.basisMode);
        const headline = $('headline-cost');
        headline.className = 'hero-value';
        const hero = describeHeadlineCost(rendered,
            { futures, basisMode: state.basisMode });
        if (hero.source === 'lifetime_net_cash') {
            _text(headline, _signedMoney(rendered.lifetimeNetCash));
        } else if (hero.source === 'unavailable') {
            _text(headline, '—');
        } else {
            _text(headline, `${book.currency || 'USD'} ${_money(rendered.value, 4)}`);
        }
        hero.marks.forEach((mark) => headline.classList.add(mark));
        _text($('headline-cost-caption'), hero.caption);
        _text($('headline-position'), _quantity(futures
            ? summary.futuresContracts : summary.shares));
        _text($('headline-expired-cost'), summary.blendedCostIfExpired === null
            ? '—' : _money(summary.blendedCostIfExpired, 4));
        const reference = state.referencePrice !== null
            ? state.referencePrice : state.marketPrice;
        _text($('headline-reference-price'), reference === null
            ? '—' : _money(reference, 4));
        const exposure = futures ? summary.futureExposure : summary.shares;
        const currency = book.currency || 'USD';
        const marketMetrics = computeMarketMetrics(
            reference, exposure, rendered.available ? rendered.value : null);
        const marketValue = marketMetrics.marketValue;
        _text($('headline-market-value'), marketValue === null
            ? '—' : `${currency} ${_money(marketValue)}`);
        const dilutedPnl = marketMetrics.dilutedPnl;
        const pnlNode = $('headline-diluted-pnl');
        pnlNode.className = dilutedPnl > 0
            ? 'metric-positive' : (dilutedPnl < 0 ? 'metric-negative' : '');
        _text(pnlNode, dilutedPnl === null
            ? '—' : `${currency} ${_signedMoney(dilutedPnl)}`);
        _text($('headline-stock-cost'), (futures
            ? summary.futuresAvgCost : summary.stockAvgCost) === null
            ? '—' : _money(futures ? summary.futuresAvgCost : summary.stockAvgCost, 4));
        const accountKey = book.account || 'combined';
        const twsEntry = _twsAvgCostFor({ key: accountKey, summary });
        _text($('headline-tws-cost'), twsEntry && Number.isFinite(twsEntry.avgCost)
            ? _money(twsEntry.avgCost, 4) : '—');
        _text($('headline-break-even'), summary.breakEvenPrice === null
            ? '—' : _money(summary.breakEvenPrice, 4));
        _text($('cash-net'), _signedMoney(summary.netCash));
        _text($('cash-realized-premium'), _signedMoney(summary.realizedPremium));
        _text($('cash-open-premium'), _signedMoney(summary.openPremium));
        _text($('cash-dividends'), _signedMoney(futures
            ? summary.futuresRealizedPnl : summary.dividends));
        _text($('cash-dividends-caption'), futures
            ? 'FUT 换月 / 平仓已实现损益' : '股息');
        _text($('cash-fees'), _signedMoney(-Math.abs(Number(summary.fees) || 0)));
    }

    function _summaryRow(body, label, columns, render) {
        const row = globalScope.document.createElement('tr');
        _cell(row, label);
        columns.forEach((column) => _cell(row, render(column.summary)));
        body.appendChild(row);
    }

    function _sectionRow(body, label, span) {
        const row = globalScope.document.createElement('tr');
        row.className = 'section-row';
        const cell = globalScope.document.createElement('td');
        cell.textContent = label;
        cell.colSpan = span + 1;
        row.appendChild(cell);
        body.appendChild(row);
    }

    /**
     * The headline number, with the cases a bare figure would hide spelled
     * out: no shares means there is no per-share cost at all, a negative
     * cost means the money is already back, and a short position is not a
     * cost basis in the same sense.
     */
    function _headlineRow(body, columns) {
        const row = globalScope.document.createElement('tr');
        const book = _currentBook();
        const futures = Boolean(book
            && String(book.secType || 'STK').toUpperCase() === 'FUT');
        const modeLabel = futures ? '综合成本 / FUT 点'
            : ({
            net_cash: '综合成本 / 股（净现金）',
            stock_only: '综合成本 / 股（纯股票）',
            tax_adjusted: '综合成本 / 股（税务）',
        }[state.basisMode]);
        _cell(row, modeLabel);
        columns.forEach((column) => {
            const rendered = core.summarizeCost(column.summary, state.basisMode);
            if (!rendered.available) {
                const label = rendered.state === 'no_shares'
                    ? `无${futures ? ' FUT 持仓' : '持股'}（累计净现金 ${_signedMoney(rendered.lifetimeNetCash)}）`
                    : '—';
                // A closed-out book still shows a lifetime figure here, and
                // it is just as incomplete as a per-share cost would be.
                _cell(row, rendered.costIncomplete ? `${label}（成本不完整）` : label,
                    rendered.costIncomplete ? 'value-incomplete' : 'value-unavailable');
                return;
            }
            const classNames = ['value-headline'];
            let suffix = '';
            if (rendered.state === 'recovered') {
                classNames.push('value-recovered');
                suffix = '（已完全回本）';
            } else if (rendered.state === 'short') {
                classNames.push('value-short');
                suffix = state.basisMode === 'net_cash'
                    ? '（空头回补水位）' : '（空头均价）';
            }
            if (rendered.costIncomplete) {
                // A premium-less prior_open stub is still in this book. The
                // number is internally consistent but it is NOT the real
                // blended cost, and a bare figure at the top of the page
                // would read as a finished answer.
                classNames.push('value-incomplete');
                suffix += '（成本不完整）';
            }
            _cell(row, `${_money(rendered.value, 4)}${suffix}`, classNames.join(' '));
        });
        body.appendChild(row);
    }

    /**
     * The TWS average cost for one column.
     *
     * The combined column has no account of its own, so it is blended from
     * the per-account figures - and only when *every* account holding
     * shares reports one. A partial blend would silently compare our whole
     * book against part of the broker's, which is worse than saying nothing.
     */
    function _twsAvgCostFor(column) {
        if (column.key !== 'combined') {
            return state.avgCostByAccount[column.key] || null;
        }
        if (!state.ledger) return null;
        const book = _currentBook();
        const futures = Boolean(book
            && String(book.secType || 'STK').toUpperCase() === 'FUT');
        let shares = 0;
        let basis = 0;
        const accounts = state.ledger.accounts;
        for (let index = 0; index < accounts.length; index += 1) {
            const summary = state.ledger.perAccount[accounts[index]];
            const exposure = summary
                ? (futures ? summary.futureExposure : summary.shares) : 0;
            if (!summary || Math.abs(exposure) < 1e-6) continue;
            const entry = state.avgCostByAccount[accounts[index]];
            if (!entry || !Number.isFinite(entry.avgCost) || entry.avgCost <= 0) {
                return null;
            }
            shares += exposure;
            basis += entry.avgCost * exposure;
        }
        if (Math.abs(shares) < 1e-6) return null;
        return { avgCost: basis / shares, marketPrice: state.marketPrice };
    }

    function _twsAvgCostRow(body, columns) {
        const row = globalScope.document.createElement('tr');
        const book = _currentBook();
        const futures = Boolean(book
            && String(book.secType || 'STK').toUpperCase() === 'FUT');
        _cell(row, futures ? 'TWS FUT 均价（当前合约）'
            : 'TWS 均价（对账纯股票口径）');
        columns.forEach((column) => {
            const entry = _twsAvgCostFor(column);
            if (!entry || !Number.isFinite(entry.avgCost) || entry.avgCost <= 0) {
                // TWS pushes portfolio updates for the subscribed account
                // only, so an absent figure is expected, not an error.
                _cell(row, '不可用', 'value-unavailable');
                return;
            }
            const ours = futures
                ? column.summary.futuresAvgCost : column.summary.stockAvgCost;
            if (ours === null) {
                _cell(row, _money(entry.avgCost, 4));
                return;
            }
            const difference = Math.round((entry.avgCost - ours) * 10000) / 10000;
            const matched = Math.abs(difference) < 0.01;
            _cell(row,
                `${_money(entry.avgCost, 4)}（差 ${_money(difference, 4)}）`,
                matched ? 'status-match' : 'status-mismatch');
        });
        body.appendChild(row);
    }

    function _renderWarnings() {
        const node = $('summary-warnings');
        const warnings = state.ledger ? state.ledger.warnings : [];
        const unique = Array.from(new Set(warnings));
        if (!unique.length) {
            node.hidden = true;
            node.classList.remove('position-status');
            return;
        }
        const isShort = unique.indexOf('net_short_shares') >= 0;
        const ledgerWarnings = unique.filter((warning) => warning !== 'net_short_shares');
        node.hidden = false;
        node.classList.toggle('position-status', isShort && !ledgerWarnings.length);
        const messages = [];
        if (isShort) messages.push(`头寸状态：${_describeWarning('net_short_shares')}`);
        if (ledgerWarnings.length) {
            messages.push(`账本告警：${ledgerWarnings.map(_describeWarning).join('；')}`);
        }
        node.textContent = messages.join('；');
    }

    function _describeWarning(warning) {
        if (warning === 'net_short_shares') {
            return '当前为净空头股票；已按空头回补水位计算';
        }
        if (warning === 'mixed_future_directions') {
            return '同一视图同时有多头和空头 FUT，无法用一个综合成本表示';
        }
        if (warning === 'split_ratio_invalid') return '拆股比例无效';
        if (warning.startsWith('split_crosses_open_option:')) {
            return `拆股跨越未平仓期权，合约条款需人工复核（${warning.split(':')[1]}）`;
        }
        if (warning.startsWith('closes_more_than_open:')) {
            return `平仓量超过未平仓量（${warning.split(':')[1]}）`;
        }
        if (warning.startsWith('unknown_prior_open:')) {
            return '存在权利金未知的期初期权；当前数字不是完整的实际'
                + `综合成本（${warning.slice('unknown_prior_open:'.length)}）`;
        }
        if (warning.startsWith('ibkr_open_opposes_existing:')) {
            return 'IBKR O 开仓行与当时已有持仓反向，已停止将它当作平仓'
                + `（${warning.slice('ibkr_open_opposes_existing:'.length)}）`;
        }
        if (warning.startsWith('contract_identity_conflict:')) {
            return '同一个行权价/到期日/乘数下出现了两个不同的合约编号，'
                + `已停止合并、需人工确认（${warning.split(':')[1]}）`;
        }
        return warning;
    }

    function _renderReferenceSource() {
        const node = $('reference-source');
        if (state.referencePrice !== null) {
            _text(node, '手工输入');
            return;
        }
        if (state.marketPrice !== null) {
            _text(node, `来自 TWS 持仓快照 ${_money(state.marketPrice, 4)}`);
            return;
        }
        _text(node, '无参考价（可手工输入）');
    }

    async function _adoptTwsPosition(entry, event, button) {
        if (!state.bookId || !state.positionsConnected || !event) return;
        const book = _currentBook();
        const description = entry.kind === 'shares'
            ? `${book ? book.symbol : ''} 股票`
            : entry.label;
        const quantity = entry.kind === 'shares' ? event.shares
            : (entry.kind === 'future' ? event.futureContracts : event.contracts);
        const confirmed = globalScope.confirm(
            `采信 TWS 的 ${description} 持仓 ${_quantity(quantity)}，`
            + `按 TWS 均价 ${_money(event.price, 4)} 直接登记到账本？\n\n`
            + `TWS 不提供原始开仓日期，因此将以今天 ${event.tradeDate} 作为基线日期。`
            + '该操作会留下可审计的 TWS 快照基线记录。');
        if (!confirmed) return;

        const copy = Object.assign({}, event);
        copy.externalRef = `tws-position-${_stableHash16([
            state.bookId, copy.tradeDate, copy.account, copy.kind, copy.conId || '',
            copy.futureConId || '', copy.futureExpiry || '',
            copy.localSymbol || '', copy.right || '', copy.strike || '',
            copy.expiry || '', copy.contracts || '', copy.shares || '', copy.price,
            copy.brokerTimestamp || '',
        ].join('|'))}`;
        button.disabled = true;
        try {
            const response = await request('import_cost_basis_events', {
                bookId: state.bookId,
                events: [copy],
                importBatchId: _token('cba-'),
                clientTokenPrefix: _token('cbt-'),
            });
            globalScope.alert(response.inserted
                ? `已采信 TWS 持仓并写入 ${response.inserted} 条基线记录。`
                : '该 TWS 持仓已经采信过，账本未重复写入。');
            await _loadBooks();
        } catch (error) {
            button.disabled = false;
            globalScope.alert(`采信 TWS 持仓失败：${_explainWriteError(error)}`);
        }
    }

    function _renderReconciliation() {
        const body = $('reconcile-table').querySelector('tbody');
        const badge = $('position-match-badge');
        _clear(body);
        if (!state.reconciliation) {
            badge.className = 'soft-badge';
            _text(badge, !state.positionsAt ? '尚未拉取' : 'TWS 不可用');
            const row = globalScope.document.createElement('tr');
            const cell = globalScope.document.createElement('td');
            cell.colSpan = 8;
            cell.className = 'empty';
            cell.textContent = !state.positionsAt
                ? '尚未拉取 TWS 持仓'
                : (!state.positionsConnected
                    ? 'TWS 未连接或持仓快照未完成；不进行对账，也不生成补录建议'
                    : '无差异');
            row.appendChild(cell);
            body.appendChild(row);
            return;
        }
        if (!state.reconciliation.rows.length) {
            badge.className = 'soft-badge ok';
            _text(badge, '无持仓差异');
            const row = globalScope.document.createElement('tr');
            const cell = globalScope.document.createElement('td');
            cell.colSpan = 8;
            cell.className = 'empty';
            cell.textContent = '账本与 TWS 都没有该标的的持仓';
            row.appendChild(cell);
            body.appendChild(row);
            return;
        }

        const mismatches = state.reconciliation.rows.filter((entry) => (
            entry.status !== 'match' && entry.status !== 'explained'));
        badge.className = mismatches.length ? 'soft-badge warn' : 'soft-badge ok';
        _text(badge, mismatches.length
            ? `${mismatches.length} 项待核对` : '持仓数量一致');

        state.reconciliation.rows.forEach((entry) => {
            const adoption = state.positionsConnected
                ? core.buildTwsAdoptionEvent(entry, {
                    today: _todayIso(), snapshotTimestamp: state.positionsTimestamp,
                    secType: (_currentBook() || {}).secType || 'STK',
                })
                : null;
            const row = globalScope.document.createElement('tr');
            _cell(row, entry.account || '（未标账户）');
            _cell(row, entry.kind === 'shares' ? '股票' : entry.label);
            _cell(row, _quantity(entry.ledger), 'numeric');
            _cell(row, _quantity(entry.tws), 'numeric');
            _cell(row, _quantity(entry.difference), 'numeric');
            const statusClass = {
                match: 'status-match',
                explained: 'status-explained',
                quantity_mismatch: 'status-mismatch',
                ledger_only: 'status-missing',
                tws_only: 'status-missing',
                identity_conflict: 'status-missing',
            }[entry.status] || '';
            _cell(row, {
                match: '一致',
                explained: '已由期权解释',
                quantity_mismatch: '数量不符',
                ledger_only: '账本有 TWS 无',
                tws_only: 'TWS 有账本无',
                // Equal quantities here would be a coincidence, not a match.
                identity_conflict: '合约身份歧义，需人工确认',
            }[entry.status] || entry.status, statusClass);

            if (!entry.suggestion && !adoption) {
                _cell(row, entry.advice || '', entry.advice ? 'confidence-low' : '');
                _cell(row, '');
            } else {
                const label = adoption
                    ? `TWS 持仓基线 · 均价 ${_money(adoption.price, 4)}`
                    : `${KIND_LABELS[entry.suggestion.kind] || entry.suggestion.kind}`
                        + (entry.suggestion.shares
                            ? ` · ${_quantity(entry.suggestion.shares)} 股` : '')
                        + (entry.status === 'tws_only' && !entry.twsAvgCost
                            ? ' · TWS 均价不可用'
                            : (entry.confidence === 'high' ? '' : ' · 需核实'));
                _cell(row, label,
                    adoption || entry.confidence === 'high'
                        ? 'confidence-high' : 'confidence-low');
                const actionCell = globalScope.document.createElement('td');
                const button = globalScope.document.createElement('button');
                button.type = 'button';
                button.className = 'draft';
                if (adoption) {
                    button.textContent = '采信 TWS';
                    button.addEventListener('click', () => (
                        _adoptTwsPosition(entry, adoption, button)));
                } else {
                    button.textContent = '手工补录…';
                    button.addEventListener('click', () => _fillForm(entry.suggestion));
                }
                actionCell.appendChild(button);
                row.appendChild(actionCell);
            }
            body.appendChild(row);
        });
    }

    function _renderPremium() {
        if (!state.ledger) {
            ['premium-30', 'premium-90', 'premium-365', 'premium-annualized']
                .forEach((id) => _text($(id), '—'));
            return;
        }
        const today = _todayIso();
        const windows = [[30, 'premium-30'], [90, 'premium-90'], [365, 'premium-365']];
        let yearly = 0;
        windows.forEach(([days, id]) => {
            // Realization dates, not trade dates: premium on a contract that
            // is still open is money received but still at risk, and calling
            // it income would overstate every rate below.
            const total = core.realizedPremiumWindow(state.ledger, {
                since: _shiftDays(today, -days),
                until: today,
            });
            if (days === 365) yearly = total;
            _text($(id), _money(total));
        });

        const summary = state.ledger.combined;
        const futures = summary.secType === 'FUT';
        _text($('premium-annualized-label'), futures
            ? '相对 FUT 名义金额年化' : '相对占用资金年化');
        _text($('premium-annualized-detail'), futures
            ? '按近 365 天已实现 FOP 权利金 / 当前 FUT 名义金额（非保证金收益率）'
            : '按近 365 天权利金 / 当前持仓成本');
        const committed = futures
            ? (summary.hasFutures && summary.futuresAvgCost !== null
                ? Math.abs(summary.futureExposure * summary.futuresAvgCost) : 0)
            : (summary.hasShares && summary.stockAvgCost !== null
                ? Math.abs(summary.shares * summary.stockAvgCost) : 0);
        _text($('premium-annualized'), committed > 0
            ? `${_money((yearly / committed) * 100, 2)}%`
            : '—');
    }

    function _renderAccountFilter() {
        const select = $('filter-account');
        const previous = select.value;
        _clear(select);
        const all = globalScope.document.createElement('option');
        all.value = '';
        all.textContent = '全部';
        select.appendChild(all);
        const accounts = state.ledger ? state.ledger.accounts : [];
        accounts.forEach((account) => {
            const option = globalScope.document.createElement('option');
            option.value = account;
            option.textContent = account || '（未标账户）';
            select.appendChild(option);
        });
        select.value = previous;
    }

    function _renderFlow() {
        const body = $('flow-table').querySelector('tbody');
        _clear(body);
        const filtered = _flowRows();
        const pageCount = Math.max(1, Math.ceil(filtered.length / FLOW_PAGE_SIZE));
        if (state.flowPage > pageCount) state.flowPage = pageCount;
        const rows = filtered.slice(
            (state.flowPage - 1) * FLOW_PAGE_SIZE, state.flowPage * FLOW_PAGE_SIZE);
        if (!filtered.length) {
            const row = globalScope.document.createElement('tr');
            const cell = globalScope.document.createElement('td');
            cell.colSpan = 11;
            cell.className = 'empty';
            cell.textContent = state.bookId ? '无事件' : '未选择账本';
            row.appendChild(cell);
            body.appendChild(row);
        } else {
            rows.forEach((entry) => {
                const event = entry.event;
                const row = globalScope.document.createElement('tr');
                if (entry.voided) row.className = 'row-voided';
                else if (entry.excluded) row.className = 'row-excluded';
                _cell(row, event.tradeDate);
                _cell(row, event.account || '—');
                _cell(row, KIND_LABELS[event.kind] || event.kind);
                _cell(row, _describeContract(event));
                const quantity = event.futureContracts !== null
                    && event.futureContracts !== undefined
                    ? event.futureContracts
                    : (event.contracts !== null && event.contracts !== undefined
                        ? event.contracts : event.shares);
                _cell(row, _quantity(quantity), 'numeric');
                _cell(row, event.price === null || event.price === undefined
                    ? '—' : _money(event.price, 4), 'numeric');
                _cell(row, _money(event.cashAmount), 'numeric'
                    + (event.derivedMismatch ? ' mismatch-flag' : ''));
                _cell(row, _quantity(_bookIsFutures()
                    ? entry.runningFuturesContracts : entry.runningShares), 'numeric');
                const runningCost = _bookIsFutures()
                    ? entry.runningFuturesCost : entry.runningCostPerShare;
                _cell(row, runningCost === null
                    ? '—' : _money(runningCost, 4), 'numeric');
                _cell(row, event.source || '');
                const actionCell = globalScope.document.createElement('td');
                if (!event.voidedAtUtc) {
                    const button = globalScope.document.createElement('button');
                    button.type = 'button';
                    button.className = 'draft';
                    button.textContent = '冲销';
                    button.addEventListener('click', () => _voidEvent(event));
                    actionCell.appendChild(button);
                }
                row.appendChild(actionCell);
                body.appendChild(row);
            });
        }
        _text($('flow-page-label'), `最新优先 · 第 ${state.flowPage} / ${pageCount} 页 · 筛选出 `
            + `${filtered.length} 条 · 账本共 ${state.eventsTotal} 条`);
        $('flow-prev').disabled = state.flowPage <= 1;
        $('flow-next').disabled = state.flowPage >= pageCount;
    }

    function _refreshControls() {
        const connected = state.connection === 'connected';
        const hasBook = connected && Boolean(state.bookId);
        const canCreateBook = connected && Boolean(state.status && state.status.available);
        const selectedNewBookAccount = _selectedNewBookAccount();
        $('book-select').disabled = !connected || !state.books.length;
        $('btn-new-book').disabled = !canCreateBook;
        $('new-book-account').disabled = !canCreateBook;
        $('new-book-account-manual').disabled = !canCreateBook
            || $('new-book-account').value !== MANUAL_ACCOUNT_VALUE;
        $('btn-create-book').disabled = !canCreateBook || !selectedNewBookAccount;
        $('btn-delete-book').disabled = !hasBook;
        $('btn-refresh').disabled = !connected;
        $('btn-refresh-positions').disabled = !connected;
        $('btn-submit-event').disabled = !hasBook;
        $('btn-export-csv').disabled = !hasBook;
        $('btn-save-snapshot').disabled = !hasBook;
        // The input itself is visually hidden behind its label, and clicking
        // a label bound to a disabled input does nothing at all. Without
        // this the label stays a live-looking primary button that silently
        // swallows the click.
        const importDisabled = !hasBook || !importer;
        $('import-file').disabled = importDisabled;
        const importLabel = globalScope.document
            .querySelector('label[for="import-file"]');
        if (importLabel) {
            importLabel.classList.toggle('is-disabled', importDisabled);
            importLabel.setAttribute('aria-disabled', String(importDisabled));
            importLabel.title = importDisabled
                ? (hasBook ? 'CSV 导入模块未加载' : '请先选择账本') : '';
        }
        const replacing = $('import-replace').checked === true;
        const phraseOk = !replacing || Boolean(state.resetPlan
            && $('import-confirm').value.trim() === state.resetPlan.phrase);
        // A batch carrying unresolved rows must not be committed piecemeal.
        // Writing the readable half of a statement produces a ledger that
        // looks imported but is missing a delivery - the worst outcome
        // available, because nothing on the page would say so afterwards.
        const blocked = Boolean(state.importResult
            && state.importResult.problems.length);
        $('import-replace').disabled = !hasBook;
        $('btn-import-commit').disabled = !hasBook || !state.importResult
            || !_importRows(state.importResult).length || !phraseOk || blocked;
        $('btn-import-clear').disabled = !state.importResult;
    }

    // ------------------------------------------------------------------
    // Entry form
    // ------------------------------------------------------------------

    function _applyKindVisibility() {
        const kind = $('field-kind').value;
        const visible = _fieldsForKind(kind);
        const form = $('event-form');
        Array.from(form.querySelectorAll('[data-field]')).forEach((node) => {
            const field = node.getAttribute('data-field');
            const shown = visible.indexOf(field) >= 0;
            node.hidden = !shown;
            if (!shown) {
                const input = node.querySelector('input, select');
                if (input && input.type !== 'checkbox') input.value = '';
            }
        });
        _updateCashHint();
    }

    function _formEvent() {
        const kind = $('field-kind').value;
        const visible = _fieldsForKind(kind);
        const book = _currentBook();
        const event = {
            kind,
            tradeDate: $('field-date').value,
            account: (book && book.account) || $('field-account').value.trim(),
            fees: Number($('field-fees').value) || 0,
            tag: $('field-tag').value.trim(),
            note: $('field-note').value.trim(),
            includeInCost: $('field-include').checked,
            source: 'manual',
        };
        if (kind.indexOf('option_') === 0) {
            event.optionSecType = _bookIsFutures() ? 'FOP' : 'OPT';
        }
        if (visible.indexOf('right') >= 0) event.right = $('field-right').value;
        if (visible.indexOf('strike') >= 0) event.strike = _numberOrNull($('field-strike').value);
        if (visible.indexOf('expiry') >= 0) {
            event.expiry = String($('field-expiry').value || '').replace(/-/g, '');
        }
        if (visible.indexOf('contracts') >= 0) {
            event.contracts = _numberOrNull($('field-contracts').value);
        }
        if (visible.indexOf('sharesPerContract') >= 0) {
            event.sharesPerContract = _numberOrNull($('field-spc').value);
        }
        if (visible.indexOf('shares') >= 0) event.shares = _numberOrNull($('field-shares').value);
        if (visible.indexOf('futureExpiry') >= 0) {
            event.futureExpiry = String($('field-future-expiry').value || '')
                .replace(/-/g, '');
        }
        if (visible.indexOf('futureContracts') >= 0) {
            event.futureContracts = _numberOrNull($('field-future-contracts').value);
        }
        if (visible.indexOf('rollToExpiry') >= 0) {
            event.rollToExpiry = String($('field-roll-to-expiry').value || '')
                .replace(/-/g, '');
        }
        if (visible.indexOf('rollToPrice') >= 0) {
            event.rollToPrice = _numberOrNull($('field-roll-to-price').value);
        }
        if (visible.indexOf('rollGroup') >= 0) {
            event.rollGroup = $('field-roll-group').value.trim();
        }
        if (visible.indexOf('price') >= 0) event.price = _numberOrNull($('field-price').value);
        if (visible.indexOf('splitRatio') >= 0) {
            event.splitRatio = _numberOrNull($('field-ratio').value);
        }
        const cash = _numberOrNull($('field-cash').value);
        event.cashAmount = cash === null ? core.deriveCashAmount(event) : cash;
        return event;
    }

    function _numberOrNull(value) {
        if (value === '' || value === null || value === undefined) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    /** Show what the entry would settle for, so an override is deliberate. */
    function _updateCashHint() {
        const event = _formEvent();
        const derived = core.deriveCashAmount(event);
        const typed = _numberOrNull($('field-cash').value);
        if (derived === null) {
            _text($('cash-hint'), '此类型需手工填写现金');
            return;
        }
        if (typed === null) {
            _text($('cash-hint'), `留空则按 ${_money(derived)} 记账`);
            return;
        }
        const gap = Math.abs(typed - derived);
        _text($('cash-hint'), gap > 0.01
            ? `与推导值 ${_money(derived)} 相差 ${_money(typed - derived)}，将标记为手工覆盖`
            : `与推导值一致`);
    }

    function _fillForm(draft) {
        const book = _currentBook();
        _showView('ledger');
        $('manual-entry-details').open = true;
        $('field-kind').value = draft.kind;
        _applyKindVisibility();
        $('field-date').value = draft.tradeDate || _todayIso();
        $('field-account').value = (book && book.account) || draft.account || '';
        if (draft.right) $('field-right').value = draft.right;
        $('field-strike').value = draft.strike === null || draft.strike === undefined
            ? '' : draft.strike;
        $('field-expiry').value = draft.expiry
            ? `${draft.expiry.slice(0, 4)}-${draft.expiry.slice(4, 6)}-${draft.expiry.slice(6, 8)}`
            : '';
        $('field-contracts').value = draft.contracts === null || draft.contracts === undefined
            ? '' : draft.contracts;
        $('field-spc').value = draft.sharesPerContract
            || (book && book.defaultSharesPerContract) || 100;
        $('field-shares').value = draft.shares === null || draft.shares === undefined
            ? '' : draft.shares;
        $('field-future-expiry').value = draft.futureExpiry
            ? `${draft.futureExpiry.slice(0, 4)}-${draft.futureExpiry.slice(4, 6)}` : '';
        $('field-future-contracts').value = draft.futureContracts === null
            || draft.futureContracts === undefined ? '' : draft.futureContracts;
        $('field-roll-to-expiry').value = draft.rollToExpiry
            ? `${draft.rollToExpiry.slice(0, 4)}-${draft.rollToExpiry.slice(4, 6)}` : '';
        $('field-roll-to-price').value = draft.rollToPrice === null
            || draft.rollToPrice === undefined ? '' : draft.rollToPrice;
        $('field-roll-group').value = draft.rollGroup || '';
        $('field-price').value = draft.price === null || draft.price === undefined
            ? '' : draft.price;
        $('field-ratio').value = draft.splitRatio || '';
        $('field-fees').value = draft.fees || 0;
        $('field-cash').value = draft.cashAmount === null || draft.cashAmount === undefined
            ? '' : draft.cashAmount;
        $('field-note').value = draft.note || '';
        _updateCashHint();
        _message('草稿已填入表单，确认价格与日期后再写入。', '');
        $('event-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function _message(text, kind) {
        const node = $('entry-message');
        node.textContent = text;
        if (kind) node.dataset.state = kind;
        else delete node.dataset.state;
    }

    async function _submitEvent(submitEvent) {
        submitEvent.preventDefault();
        if (!state.bookId) return;
        const event = _formEvent();
        if (event.cashAmount === null || event.cashAmount === undefined) {
            _message('无法推导现金金额，请手工填写。', 'error');
            return;
        }
        try {
            const response = await request('append_cost_basis_event', {
                bookId: state.bookId,
                event,
                clientToken: _token('cbe-'),
            });
            const warnings = Array.isArray(response.warnings) ? response.warnings : [];
            _message(warnings.length
                ? `已写入（告警：${warnings.map(_describeWarning).join('；')}）`
                : '已写入账本。', 'ok');
            _resetForm();
            await _loadBooks();
        } catch (error) {
            _message(_explainWriteError(error), 'error');
        }
    }

    function _explainWriteError(error) {
        if (error.code === 'position_overdraw') {
            return `平仓量超过账本中该合约的未平仓量：${error.message}。`
                + '通常是开仓那一笔还没补录，或者日期填错了。';
        }
        if (error.code === 'invalid_request') return `字段有误：${error.message}`;
        return error.message || '写入失败';
    }

    function _resetForm() {
        const book = _currentBook();
        $('field-account').value = (book && book.account) || '';
        $('field-strike').value = '';
        $('field-contracts').value = '';
        $('field-shares').value = '';
        $('field-future-expiry').value = '';
        $('field-future-contracts').value = '';
        $('field-roll-to-expiry').value = '';
        $('field-roll-to-price').value = '';
        $('field-roll-group').value = '';
        $('field-price').value = '';
        $('field-ratio').value = '';
        $('field-cash').value = '';
        $('field-fees').value = '0';
        $('field-note').value = '';
        _updateCashHint();
    }

    async function _voidEvent(event) {
        const reason = globalScope.prompt(
            `冲销这条事件需要写明原因（${event.tradeDate} ${KIND_LABELS[event.kind] || event.kind}）：`);
        if (!reason || !reason.trim()) return;
        try {
            await request('void_cost_basis_event', {
                bookId: state.bookId,
                eventId: event.eventId,
                reason: reason.trim(),
                clientToken: _token('cbv-'),
            });
            await _loadBooks();
        } catch (error) {
            globalScope.alert(`冲销失败：${error.message}`);
        }
    }

    // ------------------------------------------------------------------
    // Import
    // ------------------------------------------------------------------

    function _exactBrokerTimestamp(event) {
        const explicit = String((event && event.brokerTimestamp) || '');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(explicit)) {
            return explicit;
        }
        const note = String((event && event.note) || '');
        const match = /(\d{4}-\d{2}-\d{2})[,\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(note);
        if (match) {
            return `${match[1]}T${match[2].padStart(2, '0')}:${match[3]}:${match[4] || '00'}`;
        }

        // Baselines written before snapshot timestamps were added to the
        // audit note still have an immutable UTC insertion timestamp. The
        // page and IBKR Activity Statement both use this machine's local
        // time, so converting createdAtUtc back to local time recovers the
        // ordering evidence instead of permanently stranding those rows.
        // The date must still agree with the adopted tradeDate; a baseline
        // created under a different timezone remains fail-closed.
        if (!event || event.source !== 'reconcile' || event.tag !== 'tws_snapshot') {
            return '';
        }
        const createdAtUtc = String(event.createdAtUtc || '');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(createdAtUtc)) {
            return '';
        }
        const created = new Date(createdAtUtc);
        if (!Number.isFinite(created.getTime())) return '';
        const month = String(created.getMonth() + 1).padStart(2, '0');
        const day = String(created.getDate()).padStart(2, '0');
        const date = `${created.getFullYear()}-${month}-${day}`;
        if (date !== String(event.tradeDate || '')) return '';
        const hour = String(created.getHours()).padStart(2, '0');
        const minute = String(created.getMinutes()).padStart(2, '0');
        const second = String(created.getSeconds()).padStart(2, '0');
        return `${date}T${hour}:${minute}:${second}`;
    }

    function _eventTimestamp(event) {
        const exact = _exactBrokerTimestamp(event);
        if (exact) return exact;
        const date = String((event && event.tradeDate) || '');
        return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59` : '';
    }

    /**
     * Describe the ledger state at the imported statement's cutoff.
     * Append replays only rows that had happened by that timestamp; using
     * the latest ledger tail would make an older, already-covered statement
     * look like it needs synthetic prior_open positions. De-duplication is
     * still global because SQLite retains broker references for all time.
     */
    function buildImportBaseline(replacing, ledger, allEvents, statementThrough,
                                 ignoredEventIds) {
        if (replacing) {
            return {
                existingOpen: [],
                existingOpenFutures: [],
                existingSharesByAccount: {},
                existingExternalRefs: [],
            };
        }
        const ignored = new Set(Array.isArray(ignoredEventIds) ? ignoredEventIds : []);
        const baselineEvents = (allEvents || []).filter(
            (event) => !ignored.has(event.eventId));
        const cutoff = String(statementThrough || '');
        const eventsThroughCutoff = cutoff
            ? baselineEvents.filter((event) => {
                const timestamp = _eventTimestamp(event);
                return timestamp && timestamp <= cutoff;
            })
            : null;
        const secType = ledger && ledger.combined && ledger.combined.secType === 'FUT'
            ? 'FUT' : 'STK';
        const baselineLedger = eventsThroughCutoff
            ? (secType === 'FUT'
                ? core.computeLedger(eventsThroughCutoff, { secType })
                : core.computeLedger(eventsThroughCutoff))
            : ledger;
        const sharesByAccount = {};
        if (baselineLedger) {
            baselineLedger.accounts.forEach((account) => {
                sharesByAccount[account] = baselineLedger.perAccount[account].shares;
            });
        }
        return {
            existingOpen: baselineLedger ? baselineLedger.openOptions : [],
            existingOpenFutures: baselineLedger ? (baselineLedger.openFutures || []) : [],
            existingSharesByAccount: sharesByAccount,
            existingExternalRefs: (allEvents || [])
                .filter((event) => Boolean(event.externalRef))
                .map((event) => ({
                    account: event.account || '',
                    externalRef: event.externalRef,
                    // Inactive rows no longer contribute cash/positions, but
                    // SQLite deliberately retains their unique reference.
                    voidedAtUtc: event.voidedAtUtc || null,
                    includeInCost: event.includeInCost !== false,
                })),
        };
    }

    function _eventVsAdoptedSnapshot(event, baseline) {
        const exactSnapshot = _exactBrokerTimestamp(baseline);
        const exactEvent = _exactBrokerTimestamp(event);
        if (exactSnapshot && exactEvent) {
            return exactEvent <= exactSnapshot ? 'before' : 'after';
        }
        const eventDate = String(event.tradeDate || '');
        const baselineDate = String(baseline.tradeDate || '');
        if (eventDate < baselineDate) return 'before';
        if (eventDate > baselineDate) return 'after';
        // A legacy baseline or a CSV row without a time cannot establish
        // same-day ordering. Importing it as either side would be a guess.
        return 'ambiguous';
    }

    function _supersessionIdentityIsSafe(baseline, events) {
        const baselineConId = baseline.conId === null || baseline.conId === undefined
            || baseline.conId === '' ? '' : String(baseline.conId);
        const conIds = new Set(events.map((event) => (
            event.conId === null || event.conId === undefined || event.conId === ''
                ? '' : String(event.conId))).filter(Boolean));
        if (conIds.size > 1) return false;
        return !baselineConId || !conIds.size || conIds.has(baselineConId);
    }

    function _futureDeltaForKey(event, key) {
        if (!event || !key) return 0;
        if (event.kind === 'futures_trade') {
            return core.futureKey(event) === key ? Number(event.futureContracts || 0) : 0;
        }
        if (event.kind === 'futures_roll') {
            if (core.futureKey(event) === key) return -Number(event.futureContracts || 0);
            if (core.futureKey(event, true) === key) return Number(event.futureContracts || 0);
            return 0;
        }
        if ((event.kind === 'option_assignment' || event.kind === 'option_exercise')
            && String(event.optionSecType || '').toUpperCase() === 'FOP') {
            return core.futureKey(event) === key ? Number(event.futureContracts || 0) : 0;
        }
        return 0;
    }

    function _futureSupersessionIdentityIsSafe(baseline, events, key) {
        const baselineId = baseline.futureConId === null
            || baseline.futureConId === undefined || baseline.futureConId === ''
            ? '' : String(baseline.futureConId);
        const ids = new Set();
        events.forEach((event) => {
            if (core.futureKey(event) === key && event.futureConId) {
                ids.add(String(event.futureConId));
            }
            if (event.kind === 'futures_roll' && core.futureKey(event, true) === key
                && event.rollToConId) ids.add(String(event.rollToConId));
        });
        return ids.size <= 1 && (!baselineId || !ids.size || ids.has(baselineId));
    }

    /**
     * Find provisional TWS baselines for which this Activity Statement now
     * supplies the complete broker history. The CSV rows alone must rebuild
     * the exact snapshot quantity and need no unknown prior-opening stub.
     */
    function planTwsBaselineSupersession(importResult, allEvents) {
        const result = importResult || {};
        const openings = result.openings;
        const account = String(result.account || '');
        const cutoff = String(result.statementThrough || '');
        if (result.format !== 'activity' || !openings
            || (result.problems || []).length || !account || !cutoff) {
            return { eventIds: [], events: [], problems: [] };
        }

        const csvEvents = (result.events || []).filter(
            (event) => event.source === 'csv_import' && event.tag !== 'prior_open');
        const openingKeys = new Set((openings.drafts || []).map(
            (event) => core.contractKey(event)));
        const candidates = (allEvents || []).filter((event) => (
            event.eventId && !event.voidedAtUtc && event.includeInCost !== false
            && event.source === 'reconcile' && event.tag === 'tws_snapshot'
            && event.account === account && _eventTimestamp(event) <= cutoff));
        const selected = [];
        const problems = [];

        function conflict(baseline) {
            const label = baseline.kind === 'opening_balance' ? 'shares'
                : (baseline.kind === 'futures_trade'
                    ? `${baseline.futureExpiry || ''} FUT`
                    : `${baseline.expiry || ''} ${baseline.right || ''}${baseline.strike || ''}`);
            problems.push({
                lineNumber: 0,
                reason: 'CSV history partially or ambiguously overlaps an adopted TWS '
                    + 'baseline; import a complete covering statement or use reviewed rebuild',
                raw: `${account} ${label}`,
            });
        }

        candidates.forEach((baseline) => {
            if (baseline.kind === 'futures_trade') {
                const key = core.futureKey(baseline);
                const sameFuture = csvEvents.filter(
                    (event) => Math.abs(_futureDeltaForKey(event, key)) > 1e-6);
                const ambiguous = sameFuture.filter(
                    (event) => _eventVsAdoptedSnapshot(event, baseline) === 'ambiguous');
                const matching = sameFuture.filter(
                    (event) => _eventVsAdoptedSnapshot(event, baseline) === 'before');
                if (!matching.length && !ambiguous.length) return;
                if (ambiguous.length
                    || !_futureSupersessionIdentityIsSafe(baseline, matching, key)) {
                    conflict(baseline);
                    return;
                }
                const reconstructed = matching.reduce(
                    (total, event) => total + _futureDeltaForKey(event, key), 0);
                if (Math.abs(reconstructed
                    - Number(baseline.futureContracts || 0)) < 1e-6) {
                    selected.push(baseline);
                } else {
                    conflict(baseline);
                }
                return;
            }
            if (baseline.kind === 'option_trade') {
                const key = core.contractKey(baseline);
                const sameContract = csvEvents.filter((event) => (
                    event.contracts !== null && event.contracts !== undefined
                    && core.contractKey(event) === key
                    && (!(baseline.conId && event.conId)
                        || String(baseline.conId) === String(event.conId))));
                const ambiguous = sameContract.filter(
                    (event) => _eventVsAdoptedSnapshot(event, baseline) === 'ambiguous');
                const matching = sameContract.filter(
                    (event) => _eventVsAdoptedSnapshot(event, baseline) === 'before');
                if (!matching.length && !ambiguous.length) return;
                if (ambiguous.length || openingKeys.has(key)
                    || !_supersessionIdentityIsSafe(baseline, matching)) {
                    conflict(baseline);
                    return;
                }
                const reconstructed = matching.reduce(
                    (total, event) => total + Number(event.contracts || 0), 0);
                if (Math.abs(reconstructed - Number(baseline.contracts || 0)) < 1e-6) {
                    selected.push(baseline);
                } else {
                    conflict(baseline);
                }
                return;
            }
            if (baseline.kind !== 'opening_balance') return;
            const sameAccount = csvEvents.filter((event) => (
                event.account === account && event.shares !== null
                && event.shares !== undefined));
            const ambiguous = sameAccount.filter(
                (event) => _eventVsAdoptedSnapshot(event, baseline) === 'ambiguous');
            const matching = sameAccount.filter(
                (event) => _eventVsAdoptedSnapshot(event, baseline) === 'before');
            if (!matching.length && !ambiguous.length) return;
            if (ambiguous.length || Math.abs(Number(openings.openingShares || 0)) >= 1e-6) {
                conflict(baseline);
                return;
            }
            const reconstructed = matching.reduce(
                (total, event) => total + Number(event.shares || 0), 0);
            if (Math.abs(reconstructed - Number(baseline.shares || 0)) < 1e-6) {
                selected.push(baseline);
            } else {
                conflict(baseline);
            }
        });
        return {
            eventIds: selected.map((event) => event.eventId),
            events: selected,
            problems,
        };
    }

    function _renderImportPreview() {
        const summaryNode = $('import-summary');
        const wrap = $('import-preview-wrap');
        const problemWrap = $('import-problem-wrap');
        const body = $('import-table').querySelector('tbody');
        const problemBody = $('import-problem-table').querySelector('tbody');
        _clear(body);
        _clear(problemBody);

        if (!state.importResult) {
            _text(summaryNode, '未选择文件。');
            wrap.hidden = true;
            problemWrap.hidden = true;
            $('import-blocked').hidden = true;
            $('import-workspace').hidden = !state.importText;
            _refreshControls();
            return;
        }

        $('import-workspace').hidden = false;

        const result = state.importResult;
        const kinds = Object.keys(result.summary.byKind)
            .map((kind) => `${KIND_LABELS[kind] || kind} ${result.summary.byKind[kind]}`)
            .join(' · ');
        _text(summaryNode, `格式 ${result.format} · 读取 ${result.summary.total} 行`
            + (result.account ? ` · 账户 ${result.account}` : '')
            + ` · 生成草稿 ${result.summary.drafted} 条`
            + ` · 其他标的跳过 ${result.summary.skipped} 行`
            + ` · 待人工处理 ${result.summary.problems} 行`
            + (result.supersedeTwsEventIds && result.supersedeTwsEventIds.length
                ? ` · CSV 将取代 TWS 临时基线 ${result.supersedeTwsEventIds.length} 条`
                : '')
            + (kinds ? ` · ${kinds}` : ''));
        _renderOpenings(result);

        const rows = _importRows(result);
        wrap.hidden = !rows.length;
        rows.forEach((event) => {
            const row = globalScope.document.createElement('tr');
            _cell(row, event.tradeDate);
            _cell(row, event.account || '—');
            _cell(row, KIND_LABELS[event.kind] || event.kind);
            _cell(row, _describeContract(event));
            const quantity = event.futureContracts !== undefined
                ? event.futureContracts
                : (event.contracts !== undefined ? event.contracts : event.shares);
            _cell(row, _quantity(quantity), 'numeric');
            _cell(row, event.price === null || event.price === undefined
                ? '—' : _money(event.price, 4), 'numeric');
            _cell(row, _money(event.cashAmount), 'numeric');
            _cell(row,
                event.tag === 'prior_open' ? '期初补录 · 权利金未知'
                    : (event.unpaired ? `第 ${event.lineNumber} 行 · 未配对`
                        : `第 ${event.lineNumber} 行`),
                (event.unpaired || event.tag === 'prior_open') ? 'mismatch-flag' : '');
            body.appendChild(row);
        });

        if (result.problems.length) {
            _text($('import-blocked'),
                `有 ${result.problems.length} 条阻断问题，导入已被禁用。`
                + '请查看下方逐条原因；可能是缺少配对腿、合约身份歧义、'
                + '期初信息不足或与 TWS 临时基线部分重叠。'
                + '程序不会在原因未解决时写入部分账本。');
            $('import-blocked').hidden = false;
        } else {
            $('import-blocked').hidden = true;
        }
        problemWrap.hidden = !result.problems.length;
        result.problems.forEach((problem) => {
            const row = globalScope.document.createElement('tr');
            _cell(row, String(problem.lineNumber));
            _cell(row, problem.reason);
            _cell(row, String(problem.raw || '').slice(0, 120));
            problemBody.appendChild(row);
        });
        _refreshControls();
    }

    /** Opening stubs first, then the statement's own rows. */
    function _importRows(result) {
        const openings = (result.openings && result.openings.drafts) || [];
        const shareOpenings = (result.openings && result.openings.shareDrafts) || [];
        return openings.concat(shareOpenings, result.events);
    }

    /**
     * What the account already held when the period opened.
     *
     * A partial-period statement says nothing about contracts that were open
     * the whole time, so importing it alone leaves the ledger short of real
     * positions. The opening is arithmetic - closing minus the batch's own
     * movement - so the contracts are exact even though their premium is
     * not in the file. The share opening is only reported: its cost basis is
     * genuinely unknown here and inventing one would corrupt the headline.
     */
    function _renderOpenings(result) {
        const node = $('import-openings');
        const openings = result.openings;
        const openingFutures = openings && Array.isArray(openings.openingFutures)
            ? openings.openingFutures : [];
        const shareDrafts = openings && Array.isArray(openings.shareDrafts)
            ? openings.shareDrafts : [];
        if (!openings || (!openings.drafts.length && !openings.openingShares
            && !openingFutures.length && !shareDrafts.length)) {
            node.hidden = true;
            return;
        }
        node.hidden = false;
        const parts = [];
        if (openings.drafts.length) {
            const reconstructed = openings.drafts.filter(
                (event) => event.tag === 'prior_basis').length;
            const unknown = openings.drafts.length - reconstructed;
            if (reconstructed) {
                parts.push(`期初 ${reconstructed} 个合约的现金已由 IBKR 完整平仓行的 Basis 还原。`);
            }
            if (unknown) {
                parts.push(`期初已持有 ${unknown} 个合约，报表期内没有它们的开仓成本。`
                    + '已按「期末持仓 − 本批净变动」补出张数，权利金记为 0 '
                    + '并打上 prior_open 标签——导入更早报表或手工补价之前，'
                    + '页面会持续标记“非完整实际综合成本”。');
            }
        }
        if (Math.abs(openings.openingShares) > 1e-6) {
            parts.push(`期初还持有 ${_quantity(openings.openingShares)} 股，`
                + '本页不会替你猜它的成本价。请在上方「录入事件」里手工添加一条'
                + '期初余额，否则综合成本不准。');
        }
        if (shareDrafts.length) {
            parts.push('期初股票持仓的现金已由 IBKR 完整卖出行的 Basis 还原。');
        }
        if (openingFutures.length) {
            parts.push(`报表期初已有 ${openingFutures.length} 个 FUT 月份持仓，`
                + '但本文件不含它们的建仓价。导入已阻断：请使用更早的累计报表，'
                + '或先人工确认 TWS / 手工 FUT 基线后再追加。');
        }
        node.textContent = parts.join(' ');
    }

    function _parseImportText(text) {
        const book = _currentBook();
        try {
            const parseOptions = {
                symbol: book ? book.symbol : '',
                defaultSharesPerContract: book ? book.defaultSharesPerContract : 100,
                secType: book ? (book.secType || 'STK') : 'STK',
                targetAccount: book ? (book.account || '') : '',
            };
            // First discover the statement's own cutoff without letting the
            // latest ledger state influence any opening-position arithmetic.
            const discovery = importer.parse(text, parseOptions);
            const supersession = $('import-replace').checked === true
                ? { eventIds: [], events: [], problems: [] }
                : planTwsBaselineSupersession(discovery, state.allEvents);
            const baseline = buildImportBaseline(
                $('import-replace').checked === true, state.ledger, state.allEvents,
                discovery.statementThrough, supersession.eventIds);
            const first = importer.parse(text, Object.assign({}, parseOptions, baseline));
            // Opening stubs must sort before every real row, so they are
            // dated the day before the earliest trade in the file.
            const earliest = first.events.reduce(
                (found, event) => (!found || event.tradeDate < found
                    ? event.tradeDate : found), '');
            state.importResult = earliest
                ? importer.parse(text, Object.assign({}, parseOptions, {
                    openingDate: _shiftDays(earliest, -1),
                }, baseline))
                : first;
            state.importResult.supersedeTwsEventIds = supersession.eventIds;
            if (supersession.problems.length) {
                state.importResult.problems.push(...supersession.problems);
                state.importResult.summary.problems += supersession.problems.length;
            }
        } catch (error) {
            state.importResult = {
                format: 'unknown',
                events: [],
                problems: [{ lineNumber: 0, reason: error.message, raw: '' }],
                summary: { total: 0, drafted: 0, problems: 1, skipped: 0, byKind: {} },
                unmappedColumns: [],
            };
        }
    }

    function _handleImportFile(changeEvent) {
        const file = changeEvent.target.files && changeEvent.target.files[0];
        if (!file || !importer) return;
        $('import-workspace').hidden = false;
        _text($('import-summary'), `正在读取 ${file.name}…`);
        const reader = new globalScope.FileReader();
        reader.onload = () => {
            state.importText = String(reader.result || '');
            _parseImportText(state.importText);
            _renderImportPreview();
        };
        reader.readAsText(file);
    }

    async function _handleImportReplaceChange() {
        // Switching mode changes which ledger will exist at commit time. The
        // retained file must be parsed again before the confirmation gate can
        // be satisfied; a preview produced for append is invalid for rebuild.
        if (state.importText) {
            _parseImportText(state.importText);
            _renderImportPreview();
        }
        await _refreshResetPlan();
    }

    /**
     * Ask the server what wiping this book would destroy.
     *
     * The phrase carries the live event count, so it goes stale the moment
     * the ledger changes - which is the point: an operator can only confirm
     * a deletion they actually looked at.
     */
    async function _refreshResetPlan() {
        const row = $('import-confirm-row');
        const note = $('import-replace-note');
        const wanted = $('import-replace').checked === true;
        if (!wanted || !state.bookId) {
            state.resetPlan = null;
            row.hidden = true;
            note.hidden = true;
            $('import-confirm').value = '';
            _refreshControls();
            return;
        }
        note.hidden = false;
        try {
            state.resetPlan = await request('request_cost_basis_reset_plan',
                { bookId: state.bookId });
            row.hidden = false;
            _text($('import-confirm-hint'),
                `将删除 ${state.resetPlan.eventCount} 条事件，请原样输入：`
                + `${state.resetPlan.phrase}`);
        } catch (error) {
            state.resetPlan = null;
            row.hidden = true;
            globalScope.alert(`无法读取清空计划：${error.message}`);
            $('import-replace').checked = false;
        }
        _refreshControls();
    }

    async function _commitImport() {
        if (!state.importResult || !state.bookId) return;
        const events = _importRows(state.importResult).map((event) => {
            const copy = Object.assign({}, event);
            delete copy.lineNumber;
            delete copy.unpaired;
            return copy;
        });
        const replacing = $('import-replace').checked === true;
        const supersedeTwsEventIds = replacing ? []
            : (state.importResult.supersedeTwsEventIds || []);
        const confirmed = globalScope.confirm(replacing
            ? `将先清空 ${_currentBook().symbol} 账本（${state.resetPlan
                ? state.resetPlan.eventCount : '?'} 条事件，存档后删除），`
                + `再写入 ${events.length} 条事件。确认重建？`
            : `将向 ${_currentBook().symbol} 账本写入 ${events.length} 条事件。`
                + (supersedeTwsEventIds.length
                    ? `CSV 已完整重建对应历史，将同时冲销 ${supersedeTwsEventIds.length} 条 TWS 临时基线。`
                    : '')
                + '已存在的 CSV 成交会自动跳过。确认导入？');
        if (!confirmed) return;
        try {
            // One request either way. The rebuild archives, wipes and
            // refills inside a single database transaction, so a failure
            // anywhere leaves the original ledger untouched instead of
            // stranding an empty book.
            const response = replacing
                ? await request('rebuild_cost_basis_book', {
                    bookId: state.bookId,
                    events,
                    confirmation: $('import-confirm').value.trim(),
                    clientToken: _token('cbr-'),
                    importBatchId: _token('cbb-'),
                    reason: '覆盖式重建：按新导入的报表重建账本',
                })
                : await request('import_cost_basis_events', {
                    bookId: state.bookId,
                    events,
                    supersedeTwsEventIds,
                    importBatchId: _token('cbb-'),
                    clientTokenPrefix: _token('cbi-'),
                });
            globalScope.alert(replacing
                ? `重建完成：归档并清空 ${response.removedEvents} 条，写入 ${response.inserted} 条。`
                : `导入完成：新增 ${response.inserted} 条，跳过 ${response.skipped} 条`
                    + (response.supersededTwsBaselines
                        ? `，已用 CSV 取代 ${response.supersededTwsBaselines} 条 TWS 临时基线`
                        : '') + '。');
            state.importResult = null;
            state.importText = '';
            $('import-file').value = '';
            $('import-replace').checked = false;
            $('import-confirm').value = '';
            await _refreshResetPlan();
            _renderImportPreview();
            await _loadBooks();
        } catch (error) {
            if (error.code === 'reset_confirmation_mismatch') {
                globalScope.alert('确认短语不匹配。账本未被清空，也没有写入任何数据。'
                    + `${error.message}（账本条数若刚变动过，请重新勾选以刷新短语）`);
                await _refreshResetPlan();
                return;
            }
            globalScope.alert(`导入失败：${_explainWriteError(error)}`);
        }
    }

    // ------------------------------------------------------------------
    // Export & snapshot
    // ------------------------------------------------------------------

    function _exportCsv() {
        if (!state.ledger) return;
        const header = ['tradeDate', 'account', 'kind', 'right', 'strike', 'expiry',
            'contracts', 'shares', 'futureExpiry', 'futureContracts', 'rollToExpiry',
            'rollToPrice', 'rollGroup', 'price', 'cashAmount', 'fees', 'runningShares',
            'runningFuturesContracts',
            'runningCostPerShare', 'source', 'externalRef', 'note', 'voidedAtUtc'];
        const lines = [header.join(',')];
        // The export is an audit artefact: it carries every row, not the
        // slice that happens to be on screen.
        state.ledger.rows.forEach((entry) => {
            const event = entry.event;
            lines.push([
                event.tradeDate, event.account, event.kind, event.right || '',
                event.strike === null ? '' : event.strike, event.expiry || '',
                event.contracts === null ? '' : event.contracts,
                event.shares === null ? '' : event.shares,
                event.futureExpiry || '',
                event.futureContracts === null ? '' : event.futureContracts,
                event.rollToExpiry || '',
                event.rollToPrice === null ? '' : event.rollToPrice,
                event.rollGroup || '',
                event.price === null ? '' : event.price,
                event.cashAmount, event.fees, entry.runningShares,
                entry.runningFuturesContracts === null
                    || entry.runningFuturesContracts === undefined
                    ? '' : entry.runningFuturesContracts,
                entry.runningCostPerShare === null ? '' : entry.runningCostPerShare,
                event.source || '', event.externalRef || '',
                `"${String(event.note || '').replace(/"/g, '""')}"`,
                event.voidedAtUtc || '',
            ].join(','));
        });
        const book = _currentBook();
        const blob = new globalScope.Blob([lines.join('\n')],
            { type: 'text/csv;charset=utf-8' });
        const url = globalScope.URL.createObjectURL(blob);
        const anchor = globalScope.document.createElement('a');
        anchor.href = url;
        const identity = book
            ? `${book.account ? `${book.account}-` : ''}${book.symbol}` : 'ledger';
        anchor.download = `${identity}-cost-basis-${_todayIso()}.csv`;
        anchor.click();
        globalScope.URL.revokeObjectURL(url);
    }

    async function _saveSnapshot() {
        if (!state.ledger || !state.bookId) return;
        try {
            const response = await request('save_cost_basis_snapshot', {
                bookId: state.bookId,
                asOfDate: _todayIso(),
                accountScope: state.scope,
                summary: state.ledger.combined,
                twsSnapshot: state.positionsAt && state.positionsConnected
                    ? { takenAt: state.positionsTimestamp,
                        items: _positionsForBook(_currentBook()) }
                    : null,
                reconciled: Boolean(state.reconciliation && state.reconciliation.balanced),
            });
            globalScope.alert(`已生成对账快照：覆盖 ${response.snapshot.eventCount} 条事件，`
                + `指纹 ${response.snapshot.eventsSha256.slice(0, 12)}…`);
        } catch (error) {
            globalScope.alert(`生成快照失败：${error.message}`);
        }
    }

    async function _deleteBook() {
        const book = _currentBook();
        if (!book) return;
        const bookId = book.bookId;
        const button = $('btn-delete-book');
        let deleteSubmitted = false;
        let deleteConfirmed = false;
        button.disabled = true;
        try {
            const plan = await request('request_cost_basis_delete_plan', { bookId });
            if (state.bookId !== bookId) {
                globalScope.alert('当前账本已经切换，未执行删除。');
                return;
            }
            const phrase = globalScope.prompt(
                `这会永久删除 ${plan.account || '旧版未限定账户'} · ${plan.symbol}，且不能恢复。\n\n`
                + `全部事件：${plan.eventCount}（有效 ${plan.liveEventCount}，已冲销 ${plan.voidedEventCount}）\n`
                + `对账快照：${plan.snapshotCount}\n`
                + `清空 / 重建存档：${plan.resetCount}\n\n`
                + `请原样输入以下短语：\n${plan.phrase}`,
                ''
            );
            if (phrase === null) return;
            if (phrase.trim() !== plan.phrase) {
                globalScope.alert('确认短语不匹配，账本未被删除。');
                return;
            }
            deleteSubmitted = true;
            const response = await request('delete_cost_basis_book', {
                bookId,
                confirmation: phrase.trim(),
                clientToken: _token('cbd-'),
            });
            deleteConfirmed = true;
            state.bookId = '';
            state.allEvents = [];
            state.eventsTotal = 0;
            state.ledger = null;
            state.reconciliation = null;
            state.resetPlan = null;
            state.importResult = null;
            state.importText = '';
            $('import-file').value = '';
            $('import-replace').checked = false;
            $('import-confirm').value = '';
            await _loadBooks();
            globalScope.alert(
                `已永久删除 ${response.account || '旧版未限定账户'} · ${response.symbol}：`
                + `${response.removedEvents} 条事件、${response.removedSnapshots} 个快照、`
                + `${response.removedResets} 份重建存档。`);
        } catch (error) {
            if (error.code === 'delete_confirmation_mismatch') {
                globalScope.alert('删除计划已变化或确认短语不匹配；账本未被删除，请重新操作。');
            } else if (deleteConfirmed) {
                globalScope.alert(
                    `账本已删除成功，但刷新账本列表失败：${error.message}。连接恢复后会自动刷新。`);
            } else if (error.code === 'book_not_found') {
                try {
                    await _loadBooks();
                    globalScope.alert('账本已不存在，可能上一次删除请求已经成功；账本列表已刷新。');
                } catch (refreshError) {
                    globalScope.alert(
                        `账本已不存在，可能上一次删除请求已经成功；但列表刷新失败：${refreshError.message}`);
                }
            } else if (deleteSubmitted && !error.code) {
                // A timeout or socket close after sending the destructive
                // request is not proof of failure: the commit may have
                // completed and only its response was lost. Re-read the
                // authoritative list whenever the socket is still usable.
                try {
                    await _loadBooks();
                    const stillExists = state.books.some(
                        (candidate) => candidate.bookId === bookId);
                    globalScope.alert(stillExists
                        ? '删除请求未得到确认；刷新后账本仍存在，因此没有删除。'
                        : '删除响应虽然丢失，但刷新后确认账本已不存在，删除已经成功。');
                } catch (_) {
                    globalScope.alert(
                        '删除请求已发出，但结果暂时无法确认。连接恢复后页面会自动刷新，请以账本列表为准。');
                }
            } else {
                globalScope.alert(`删除账本失败：${error.message}`);
            }
        } finally {
            _refreshControls();
        }
    }

    async function _createBook(submitEvent) {
        submitEvent.preventDefault();
        const account = _selectedNewBookAccount();
        if (!account) {
            globalScope.alert('请选择或输入 IB 账户。');
            return;
        }
        if (state.managedAccounts.length > 0
            && !state.managedAccounts.includes(account)) {
            globalScope.alert('请选择当前 TWS 返回的 IB 账户。');
            return;
        }
        const multiplier = Number($('new-book-spc').value);
        if (!Number.isInteger(multiplier) || multiplier <= 0) {
            globalScope.alert($('new-book-type').value === 'FUT'
                ? '请填写该 FUT 合约的真实点值 / 乘数。'
                : '请填写每张期权的真实交割股数。');
            return;
        }
        try {
            const response = await request('create_cost_basis_book', {
                account: account.toUpperCase(),
                symbol: $('new-book-symbol').value.trim().toUpperCase(),
                startDate: $('new-book-start').value,
                defaultSharesPerContract: multiplier,
                secType: $('new-book-type').value,
            });
            $('new-book-symbol').value = '';
            state.bookId = response.book ? response.book.bookId : state.bookId;
            await _loadBooks();
            _showView('ledger');
        } catch (error) {
            globalScope.alert(`创建账本失败：${error.message}`);
        }
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function _reconnectConfiguredServer() {
        const host = String($('server-host').value || '').trim();
        const port = Number($('server-port').value);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
            globalScope.alert('请填写有效的服务器地址和 1–65535 端口。');
            return;
        }
        try {
            globalScope.localStorage.setItem(WS_HOST_STORAGE_KEY, host);
            globalScope.localStorage.setItem(WS_PORT_STORAGE_KEY, String(port));
        } catch (_) {
            globalScope.alert('浏览器无法保存连接设置，请检查本地存储权限。');
            return;
        }
        if (state.reconnectTimer) {
            globalScope.clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
        }
        const previous = state.ws;
        state.ws = null;
        _failPending('服务器连接已重置');
        _invalidatePositions();
        _invalidateManagedAccounts();
        if (previous) {
            try { previous.close(); } catch (_) { /* a fresh connection follows */ }
        }
        state.reconnectDelay = RECONNECT_BASE_DELAY_MS;
        _text($('sidebar-server-address'), `${host}:${port}`);
        connect();
    }

    function _wire() {
        $('book-select').addEventListener('change', async (changeEvent) => {
            state.bookId = changeEvent.target.value;
            state.flowPage = 1;
            state.avgCostByAccount = {};
            state.marketPrice = null;
            state.importResult = null;
            state.importText = '';
            $('import-file').value = '';
            $('import-replace').checked = false;
            $('import-confirm').value = '';
            await _loadEvents();
            await _refreshResetPlan();
            _renderImportPreview();
            _renderSidebarBooks();
            _showView('ledger');
        });
        $('btn-new-book').addEventListener('click', () => {
            _showView('settings');
            $('new-book-start').value = _todayIso();
            $('new-book-symbol').focus();
        });
        $('btn-cancel-book').addEventListener('click', () => {
            _showView(state.bookId ? 'ledger' : 'settings');
        });
        $('btn-open-settings').addEventListener('click', () => _showView('settings'));
        $('btn-sidebar-toggle').addEventListener('click', () => {
            globalScope.document.body.classList.toggle('sidebar-open');
        });
        $('btn-reconnect-server').addEventListener('click', _reconnectConfiguredServer);
        $('new-book-account').addEventListener('change', () => {
            _renderManagedAccounts($('new-book-account').value);
            _refreshControls();
        });
        $('new-book-account-manual').addEventListener('input', _refreshControls);
        $('new-book-form').addEventListener('submit', _createBook);
        $('new-book-type').addEventListener('change', () => {
            const futures = $('new-book-type').value === 'FUT';
            _text($('new-book-spc-label'), futures ? 'FUT 点值 / 乘数' : '每张交割股数');
            $('new-book-spc').value = futures ? '' : '100';
            $('new-book-spc').placeholder = futures
                ? '必填，例如 ES=50' : '';
        });
        $('btn-delete-book').addEventListener('click', _deleteBook);
        $('btn-refresh').addEventListener('click', () => _loadBooks());
        $('btn-refresh-positions').addEventListener('click', requestPositions);

        $('scope-select').addEventListener('change', (changeEvent) => {
            state.scope = changeEvent.target.value;
            _renderSummary();
        });
        $('basis-select').addEventListener('change', (changeEvent) => {
            state.basisMode = changeEvent.target.value;
            _renderSummary();
        });
        $('reference-price').addEventListener('change', (changeEvent) => {
            state.referencePrice = _numberOrNull(changeEvent.target.value);
            _recompute();
        });

        $('field-kind').addEventListener('change', _applyKindVisibility);
        ['field-contracts', 'field-shares', 'field-price', 'field-spc', 'field-fees',
            'field-cash', 'field-strike', 'field-future-contracts',
            'field-roll-to-price'].forEach((id) => {
            $(id).addEventListener('input', _updateCashHint);
        });
        $('event-form').addEventListener('submit', _submitEvent);
        $('btn-reset-event').addEventListener('click', _resetForm);

        // Filtering and paging are display-only and never refetch: the
        // ledger totals must not move when the operator narrows the view.
        ['filter-account', 'filter-kind', 'filter-start', 'filter-end', 'filter-voided']
            .forEach((id) => {
                $(id).addEventListener('change', () => {
                    state.flowPage = 1;
                    _renderFlow();
                });
            });
        $('flow-prev').addEventListener('click', () => {
            if (state.flowPage > 1) {
                state.flowPage -= 1;
                _renderFlow();
            }
        });
        $('flow-next').addEventListener('click', () => {
            state.flowPage += 1;
            _renderFlow();
        });
        $('btn-export-csv').addEventListener('click', _exportCsv);
        $('btn-save-snapshot').addEventListener('click', _saveSnapshot);

        if (importer) {
            $('import-replace').addEventListener('change', _handleImportReplaceChange);
            $('import-confirm').addEventListener('input', _refreshControls);
            $('import-file').addEventListener('change', _handleImportFile);
            $('btn-import-commit').addEventListener('click', _commitImport);
            $('btn-import-clear').addEventListener('click', () => {
                state.importResult = null;
                state.importText = '';
                $('import-file').value = '';
                _renderImportPreview();
            });
        }

        const kindFilter = $('filter-kind');
        core.EVENT_KINDS.forEach((kind) => {
            const option = globalScope.document.createElement('option');
            option.value = kind;
            option.textContent = KIND_LABELS[kind] || kind;
            kindFilter.appendChild(option);
        });

        $('field-date').value = _todayIso();
        $('new-book-start').value = _todayIso();
        _applyKindVisibility();
    }

    function start() {
        _wire();
        _renderAll();
        connect();
    }

    if (globalScope.document
        && globalScope.document.readyState !== 'loading') {
        start();
    } else if (globalScope.document) {
        globalScope.document.addEventListener('DOMContentLoaded', start);
    }

    // Exposed for the page test; the page itself never calls these.
    globalScope.OptionComboCostBasisPage = {
        KIND_FIELDS,
        KIND_LABELS,
        BASIS_EXPLAINERS,
        formatSignedMoney: _signedMoney,
        computeMarketMetrics,
        describeHeadlineCost,
        canReconcilePositions,
        buildImportBaseline,
        planTwsBaselineSupersession,
    };
})(typeof window !== 'undefined' ? window : globalThis);
