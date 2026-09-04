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
 * - Market-data reads are one-shot TWS snapshots triggered by What If;
 *   underlying price and per-contract IV never create a live subscription.
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
    // Cross-book protection seeds (see the linked-hedge section below).
    const LINKED_HEDGE_DEFAULTS = Object.freeze({
        TQQQ: Object.freeze({ symbol: 'QQQ', ratio: 3 }),
    });
    const LINKED_HEDGE_DEFAULT_RATIO = 3;
    const LINKED_HEDGE_MIN_ABS_RATIO = 0.01;
    // IV response modes for the linked overlay. 'beta' is the spot-vol beta:
    // vol points of IV lift per 1% drop of the linked underlying, applied on
    // the downside only. 1.5 is the order of magnitude NDX/VXN regressions
    // give (steeper inside real crashes); it is a starting value, not a fit.
    const LINKED_IV_MODES = Object.freeze(['none', 'fixed', 'beta']);
    const LINKED_IV_DEFAULT_BETA = 1.5;
    const LINKED_IV_MAX_BETA = 20;
    // Tenor damping: beta values describe ~30-day IV; longer-dated IV moves
    // less, roughly like sqrt(reference tenor / remaining days), capped at 1.
    const LINKED_IV_DEFAULT_TENOR_DAYS = 30;
    const LINKED_MAX_HORIZON_DAYS = 3650;
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Typing "20" must not fire a TWS snapshot for "2" and then "20".
    const STRESS_HORIZON_DEBOUNCE_MS = 400;
    const STRESS_LIQUIDATIONS = Object.freeze(['mid', 'bidask']);
    const STRESS_PRICING_MODELS = Object.freeze(['american', 'european']);
    const AMERICAN_BINOMIAL_STEPS = 121;
    // Continuous dividend yields used by the pricers, by symbol. Unknown
    // symbols carry none; the user can override either book in the modal.
    const DIVIDEND_YIELD_DEFAULTS = Object.freeze({ QQQ: 0.006, TQQQ: 0.01 });
    const STRESS_LINKED_STORAGE_PREFIX = 'optionComboStressLinkedHedge:';

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

    function _eventKindLabel(event) {
        if (event && event.kind === 'option_trade' && event.tag === 'ibkr_close') {
            return '期权 Close（平仓）';
        }
        return KIND_LABELS[(event || {}).kind] || (event || {}).kind || '';
    }

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
        net_cash: '净现金口径：按股票净投入扣除已到期 / 已结算的卖方净权利金，再除以持股数。'
            + '累计净现金始终按账户视角显示：收到为正、付出为负。'
            + '尚未到期的卖方权利金同样已经收取；保守口径只是在履约义务结束前暂不用它降低头条成本。'
            + 'Long Call / Put 的全周期支出、回款和盈亏都不混入标的综合成本，只在压力测试中按理论市值与浮盈亏单列。成本可以为负，'
            + '多头为负表示成本已全部收回；空头则显示可回补的'
            + '盈亏平衡水位，已到期 / 已结算权利金会把这条水位抬高。',
        stock_only: '纯股票均价：只按股票成交滚动平均，权利金完全独立列示。'
            + '这是唯一应该和 TWS 均价对得上的数——对不上就是账本漏记了。',
        tax_adjusted: '税务调整口径：被指派合约的权利金滚进股票成本'
            + '（短 Put 成本 = K − 每股权利金，短 Call 卖价 = K + 每股权利金），'
            + '其余权利金独立列示。用于解释纯股票均价与券商成本基准视图的残余差异。',
        futures: 'FOP / FUT 口径：当前 FUT 开仓基础，加换月已实现价差和费用，'
            + '再减已到期 / 已结算 FOP 卖方权利金。尚未到期的卖方权利金已收取，'
            + '但只在「若全部归零」一行中抵扣成本。',
    };

    const state = {
        ws: null,
        connection: 'disconnected',
        status: null,
        books: [],
        bookId: '',
        eventLoadGeneration: 0,
        eventSubmitPending: false,
        eventSubmitToken: '',
        eventSubmitFingerprint: '',
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
        whatIfPrice: null,
        whatIfPriceSource: '',
        whatIfEditGeneration: 0,
        whatIfExpiry: '',
        stressOpen: false,
        stressExpiry: '',
        // Scenario horizon in days (null = the selected expiry itself). It is
        // the one date the settlement, this book's overlay and the linked
        // overlay all use; never remembered across opens.
        stressHorizonDays: null,
        stressLiquidation: 'mid',
        stressPricingModel: 'american',
        stressDividendYield: null,
        stressRangePct: 30,
        stressBasePrice: null,
        stressIncludeLongOptions: false,
        stressLongOptionInputs: null,
        stressInputsPending: false,
        stressInputsError: '',
        // Bumped whenever the book or the scenario date changes so a late
        // snapshot for the previous one is dropped, never applied.
        stressInputsGeneration: 0,
        stressHorizonTimer: null,
        stressIncludeLinkedHedge: false,
        stressLinkedBookId: '',
        stressLinkedRatio: LINKED_HEDGE_DEFAULT_RATIO,
        stressLinkedIvMode: 'none',
        stressLinkedIvShockPoints: 0,
        stressLinkedIvBeta: LINKED_IV_DEFAULT_BETA,
        stressLinkedIvTenorDamping: true,
        stressLinkedIvTenorDays: LINKED_IV_DEFAULT_TENOR_DAYS,
        stressLinkedMapping: 'compound',
        stressLinkedSigma: null,
        stressLinkedDividendYield: null,
        stressLinkedEvents: [],
        stressLinkedLedger: null,
        stressLinkedEventsPending: false,
        stressLinkedEventsError: '',
        stressLinkedLoadGeneration: 0,
        stressLinkedInputs: null,
        stressLinkedInputsPending: false,
        stressLinkedInputsError: '',
        stressLinkedInputsGeneration: 0,
        marketPriceRefreshPending: false,
        marketPriceFetchedAt: '',
        importResult: null,
        importText: '',
        executionFetchPending: false,
        resetPlan: null,
        reconcileOpenSignature: '',
        referencePriceByBook: {},
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

    function _currencySymbol(currencyCode) {
        const code = String(currencyCode || 'USD').trim().toUpperCase();
        return {
            USD: '$', CAD: 'C$', AUD: 'A$', HKD: 'HK$', SGD: 'S$',
            EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', CHF: 'CHF ',
        }[code] || `${code} `;
    }

    function _currencyAmount(currencyCode, value, places, signed) {
        const formatted = signed ? _signedMoney(value, places) : _money(value, places);
        if (formatted === '—') return formatted;
        const symbol = _currencySymbol(currencyCode);
        if (formatted.startsWith('+') || formatted.startsWith('-')) {
            return `${formatted.slice(0, 1)}${symbol}${formatted.slice(1)}`;
        }
        return `${symbol}${formatted}`;
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

    function _whatIfContractLabel(outcome) {
        const digits = String(outcome.expiry || '').replace(/\D/g, '').slice(0, 8);
        const expiry = digits.length === 8
            ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
            : '未知到期日';
        const right = String(outcome.right || '?').toUpperCase().slice(0, 1);
        return `${expiry} ${_money(outcome.strike, 2)}${right} × ${_quantity(outcome.contracts)}`;
    }

    function _renderWhatIfExpiryOptions(openOptions, disabled) {
        const select = $('what-if-expiry');
        const counts = new Map();
        (openOptions || []).forEach((option) => {
            const expiry = String(option.expiry || '').replace(/\D/g, '').slice(0, 8);
            if (expiry.length !== 8) return;
            counts.set(expiry, (counts.get(expiry) || 0)
                + Math.abs(Number(option.contracts) || 0));
        });
        const expiries = Array.from(counts.keys()).sort();
        if (!expiries.includes(state.whatIfExpiry)) {
            state.whatIfExpiry = expiries[0] || '';
        }
        _clear(select);
        if (!expiries.length) {
            const option = globalScope.document.createElement('option');
            option.value = '';
            option.textContent = '无可用到期日';
            select.appendChild(option);
        } else {
            expiries.forEach((expiry) => {
                const option = globalScope.document.createElement('option');
                option.value = expiry;
                option.textContent = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}`
                    + `-${expiry.slice(6, 8)}（${_quantity(counts.get(expiry))} 张当日到期）`;
                select.appendChild(option);
            });
        }
        select.value = state.whatIfExpiry;
        select.disabled = Boolean(disabled || !expiries.length);
        return expiries;
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

    function _normalCdf(value) {
        const x = Number(value);
        if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
        const absolute = Math.abs(x);
        const t = 1 / (1 + 0.2316419 * absolute);
        const density = Math.exp(-0.5 * absolute * absolute) / Math.sqrt(2 * Math.PI);
        const tail = density * t * (0.319381530
            + t * (-0.356563782
                + t * (1.781477937
                    + t * (-1.821255978 + t * 1.330274429))));
        const cdf = 1 - tail;
        return x >= 0 ? cdf : 1 - cdf;
    }

    /**
     * European BSM value with a continuous dividend yield (default 0), used
     * by the read-only option overlays.
     */
    function calculateBsmOptionPrice(right, spot, strike, timeYears, rate, volatility, dividendYield) {
        const optionRight = String(right || '').toUpperCase().slice(0, 1);
        const s = Number(spot);
        const k = Number(strike);
        const t = Number(timeYears);
        const r = Number(rate);
        const sigma = Number(volatility);
        const q = dividendYield === undefined || dividendYield === null ? 0 : Number(dividendYield);
        if ((optionRight !== 'C' && optionRight !== 'P')
            || ![s, k, t, r, sigma, q].every(Number.isFinite) || s < 0 || k <= 0 || t < 0) {
            return null;
        }
        if (t <= 0) return optionRight === 'C'
            ? Math.max(s - k, 0) : Math.max(k - s, 0);
        const forwardSpot = s * Math.exp(-q * t);
        if (s <= 0) return optionRight === 'C' ? 0 : k * Math.exp(-r * t);
        if (sigma <= 0) return optionRight === 'C'
            ? Math.max(forwardSpot - k * Math.exp(-r * t), 0)
            : Math.max(k * Math.exp(-r * t) - forwardSpot, 0);
        const rootT = Math.sqrt(t);
        const d1 = (Math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t)
            / (sigma * rootT);
        const d2 = d1 - sigma * rootT;
        if (optionRight === 'C') {
            return forwardSpot * _normalCdf(d1) - k * Math.exp(-r * t) * _normalCdf(d2);
        }
        return k * Math.exp(-r * t) * _normalCdf(-d2) - forwardSpot * _normalCdf(-d1);
    }

    function normalizePricingModel(value) {
        const model = String(value || 'european').trim().toLowerCase();
        return STRESS_PRICING_MODELS.includes(model) ? model : null;
    }

    function normalizeLiquidation(value) {
        const lens = String(value || 'mid').trim().toLowerCase();
        return STRESS_LIQUIDATIONS.includes(lens) ? lens : null;
    }

    function normalizeDividendYield(value) {
        if (value === null || value === undefined || value === '') return 0;
        const yieldValue = Number(value);
        if (!Number.isFinite(yieldValue) || yieldValue < 0 || yieldValue > 0.5) return null;
        return yieldValue;
    }

    /**
     * Price one option under the selected model. 'american' uses the CRR
     * binomial pricer (the model TWS itself quotes US equity options with),
     * 'european' the closed form; both honour the dividend yield. Returns
     * null when the American pricer is not loaded rather than quietly
     * falling back, so the caption never claims a model that was not used.
     */
    function priceScenarioOption(right, spot, strike, timeYears, rate, volatility, options) {
        const opts = options || {};
        const model = normalizePricingModel(opts.pricingModel) || 'european';
        const dividendYield = Number(opts.dividendYield) || 0;
        if (model === 'european') {
            return calculateBsmOptionPrice(right, spot, strike, timeYears, rate, volatility, dividendYield);
        }
        const pricer = globalScope.OptionComboAmericanBinomial;
        if (!pricer || typeof pricer.calculateAmericanOptionPrice !== 'function') return null;
        const optionRight = String(right || '').toUpperCase().slice(0, 1);
        if (optionRight !== 'C' && optionRight !== 'P') return null;
        if (Number(timeYears) <= 0 || Number(spot) <= 0) {
            return calculateBsmOptionPrice(right, spot, strike, timeYears, rate, volatility, dividendYield);
        }
        const value = pricer.calculateAmericanOptionPrice({
            type: optionRight === 'C' ? 'call' : 'put',
            spot, strike, varianceTime: timeYears, rateTime: timeYears,
            riskFreeRate: rate, volatility, dividendYield,
            steps: AMERICAN_BINOMIAL_STEPS,
        });
        return Number.isFinite(value) ? value : null;
    }

    /**
     * Liquidation haircut from today's quote: a long is sold at the bid, a
     * short is bought back at the ask, so the scenario mark is scaled by
     * bid/mark or ask/mark. Returns null when the quote has no usable side.
     */
    /**
     * '' when the quote is a real two-sided BBO, 'missing' when a side is
     * absent, 'crossed' when bid > ask or the backend flagged it invalid. A
     * crossed pair from two tick instants must never become a price: it
     * would lift the long's bid and cut the short's ask at the same time.
     */
    function bidAskProblem(quote) {
        const present = (value) => !(value === null || value === undefined || value === '')
            && Number.isFinite(Number(value)) && Number(value) >= 0;
        if (!quote || !present(quote.bid) || !present(quote.ask)) return 'missing';
        if (quote.bidAskValid === false || Number(quote.ask) < Number(quote.bid)) return 'crossed';
        return '';
    }

    function liquidationHaircut(quote, side, lens) {
        if (lens !== 'bidask') return 1;
        if (bidAskProblem(quote)) return null;
        const mark = Number(quote.mark);
        if (!Number.isFinite(mark) || mark <= 0) return null;
        const sideValue = Number(side === 'short' ? quote.ask : quote.bid);
        return Math.max(0, sideValue / mark);
    }

    function calculateBsmPutPrice(spot, strike, timeYears, rate, volatility) {
        return calculateBsmOptionPrice('P', spot, strike, timeYears, rate, volatility);
    }

    function _dateUtcFromDigits(value) {
        const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
        if (digits.length !== 8) return null;
        const year = Number(digits.slice(0, 4));
        const month = Number(digits.slice(4, 6));
        const day = Number(digits.slice(6, 8));
        const milliseconds = Date.UTC(year, month - 1, day);
        const date = new Date(milliseconds);
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
            || date.getUTCDate() !== day) return null;
        return milliseconds;
    }

    function _quoteMatchesTerms(quote, position) {
        const right = String(position.right || '').toUpperCase().slice(0, 1);
        const strike = Number(position.strike);
        const expiry = String(position.expiry || '').replace(/\D/g, '').slice(0, 8);
        if (String(quote && quote.right || '').toUpperCase().slice(0, 1) !== right
            || String(quote && quote.expiry || '').replace(/\D/g, '').slice(0, 8) !== expiry
            || !(Math.abs(Number(quote && quote.strike) - strike) <= 1e-8)) return false;
        // Same visible terms can still be a different deliverable (adjusted
        // contracts): when both sides know the multiplier it must agree.
        const quoteMultiplier = Number(quote && quote.multiplier);
        const positionMultiplier = Math.abs(Number(position.sharesPerContract));
        if (Number.isFinite(quoteMultiplier) && quoteMultiplier > 0
            && Number.isFinite(positionMultiplier) && positionMultiplier > 0
            && Math.abs(quoteMultiplier - positionMultiplier) > 1e-8) return false;
        return true;
    }

    /**
     * Match a TWS snapshot row to a ledger position. Identity is strict and
     * layered: a position that carries a conId is matched by conId only, one
     * that carries only a localSymbol by localSymbol only, and terms (right,
     * expiry, strike, multiplier) are used solely when the ledger has neither.
     * A strong identity that is absent from the snapshot never falls back to
     * "a contract that looks the same".
     */
    function _findOptionQuote(optionInputs, position) {
        const quotes = Array.isArray(optionInputs) ? optionInputs : [];
        const positionConId = Number(position.conId);
        if (Number.isFinite(positionConId) && positionConId > 0) {
            return quotes.find((candidate) => (
                Number(candidate && candidate.conId) === positionConId)) || null;
        }
        const positionLocalSymbol = String(position.localSymbol || '').trim();
        if (positionLocalSymbol) {
            return quotes.find((candidate) => (
                String(candidate && candidate.localSymbol || '').trim()
                    === positionLocalSymbol)) || null;
        }
        return quotes.find((candidate) => _quoteMatchesTerms(candidate, position)) || null;
    }

    /** True when the strict lookup failed although a same-terms quote exists. */
    function _optionQuoteIdentityConflict(optionInputs, position) {
        const quotes = Array.isArray(optionInputs) ? optionInputs : [];
        const positionConId = Number(position.conId);
        const positionLocalSymbol = String(position.localSymbol || '').trim();
        const hasStrongIdentity = (Number.isFinite(positionConId) && positionConId > 0)
            || Boolean(positionLocalSymbol);
        if (!hasStrongIdentity || _findOptionQuote(quotes, position)) return false;
        return quotes.some((candidate) => _quoteMatchesTerms(candidate, position));
    }

    /**
     * Shift every quoted IV by `ivShock` (a fraction, 0.10 = +10 vol points),
     * optionally damped by remaining tenor. Returns the shocked inputs and
     * whether any quote would be pushed to or below zero.
     */
    function _applyIvShock(marketInputs, ivShock, tenorDays, scenarioAt) {
        const shock = Number(ivShock) || 0;
        if (!marketInputs || shock === 0) return { inputs: marketInputs, breaksIv: false };
        const reference = tenorDays === null || tenorDays === undefined
            ? null : Number(tenorDays);
        let breaksIv = false;
        const options = (Array.isArray(marketInputs.options) ? marketInputs.options : [])
            .map((quote) => {
                const iv = Number(quote && quote.impliedVolatility);
                if (!Number.isFinite(iv) || iv <= 0) return quote;
                let applied = shock;
                if (reference !== null) {
                    const quoteExpiryAt = _dateUtcFromDigits(quote && quote.expiry);
                    if (quoteExpiryAt !== null && scenarioAt !== null) {
                        applied = shock * tenorDampingFactor(
                            (quoteExpiryAt - scenarioAt) / DAY_MS, reference);
                    }
                }
                if (iv + applied <= 0) breaksIv = true;
                return Object.assign({}, quote, {
                    impliedVolatility: iv + applied, ivShockPoints: applied * 100,
                });
            });
        return { inputs: Object.assign({}, marketInputs, { options }), breaksIv };
    }

    const DEFERRED_REASONS = Object.freeze({
        long: Object.freeze({
            inputs: 'missing_long_option_market_inputs',
            incomplete: 'incomplete_long_option',
            identity: 'long_option_identity_mismatch',
            iv: 'missing_long_option_iv',
            rate: 'missing_discount_rate',
            shock: 'invalid_long_option_iv_shock',
            sides: 'missing_long_option_quote_sides',
            crossed: 'invalid_long_option_bid_ask',
            pricer: 'missing_american_pricer',
        }),
        short: Object.freeze({
            inputs: 'missing_short_option_market_inputs',
            incomplete: 'incomplete_short_option',
            identity: 'short_option_identity_mismatch',
            iv: 'missing_short_option_iv',
            rate: 'missing_discount_rate',
            shock: 'invalid_short_option_iv_shock',
            sides: 'missing_short_option_quote_sides',
            crossed: 'invalid_short_option_bid_ask',
            pricer: 'missing_american_pricer',
        }),
    });

    function _emptyDeferredEstimate(available, reason, count) {
        return {
            available, reason: reason || '', count: count || 0, contracts: 0,
            callContracts: 0, putContracts: 0,
            marketValue: available ? 0 : null,
            liability: available ? 0 : null,
            pnl: available ? 0 : null,
            ivMin: null, ivMax: null, rateMin: null, rateMax: null, details: [],
        };
    }

    /**
     * Mark the options that remain open after the stress date, one side at
     * a time. `marketValue` is signed (a short is a liability, negative) and
     * `pnl = marketValue + openPremium` works for both sides because the
     * ledger's `openPremium` is signed cash: paid for a long, received for a
     * short. Under every cost lens the premium of a still-open short is NOT
     * inside the settlement figure ① (the conservative blended cost adds the
     * open short premium back), so a short's full premium-minus-liability
     * belongs here, exactly as a long's mark-minus-premium does.
     */
    function _estimateDeferredOptions(deferredOptions, scenarioPrice, options, side) {
        const opts = options || {};
        const reasons = DEFERRED_REASONS[side] || DEFERRED_REASONS.long;
        const wantLong = side !== 'short';
        const throughExpiry = String(opts.throughExpiry || '').replace(/\D/g, '').slice(0, 8);
        const scenarioAt = _dateUtcFromDigits(throughExpiry);
        const rawInputs = opts.marketInputs && typeof opts.marketInputs === 'object'
            ? opts.marketInputs : null;
        const eligible = (Array.isArray(deferredOptions) ? deferredOptions : []).filter(
            (position) => (wantLong
                ? Number(position.contracts) > 0 : Number(position.contracts) < 0)
                && ['C', 'P'].includes(
                    String(position.right || '').toUpperCase().slice(0, 1)));
        if (!eligible.length) return _emptyDeferredEstimate(true, '', 0);
        if (scenarioAt === null || !rawInputs
            || String(rawInputs.throughExpiry || '') !== throughExpiry) {
            return _emptyDeferredEstimate(false, reasons.inputs, eligible.length);
        }
        const shocked = _applyIvShock(rawInputs, opts.ivShock, opts.ivShockTenorDays, scenarioAt);
        if (shocked.breaksIv) return _emptyDeferredEstimate(false, reasons.shock, eligible.length);
        const marketInputs = shocked.inputs;
        const liquidation = normalizeLiquidation(opts.liquidation) || 'mid';
        const pricing = {
            pricingModel: normalizePricingModel(opts.pricingModel) || 'european',
            dividendYield: Number(opts.dividendYield) || 0,
        };
        const optionInputs = Array.isArray(marketInputs.options) ? marketInputs.options : [];
        const ratesByExpiry = Array.isArray(marketInputs.ratesByExpiry)
            ? marketInputs.ratesByExpiry : [];
        const details = [];
        for (const position of eligible) {
            const expiryAt = _dateUtcFromDigits(position.expiry);
            const right = String(position.right || '').toUpperCase().slice(0, 1);
            const strike = Number(position.strike);
            const contracts = Number(position.contracts);
            const multiplier = Math.abs(Number(position.sharesPerContract));
            const openPremium = Number(position.openPremium);
            if (expiryAt === null || expiryAt <= scenarioAt || !Number.isFinite(strike)
                || strike <= 0 || !Number.isFinite(contracts) || contracts === 0
                || !Number.isFinite(multiplier) || multiplier <= 0
                || !Number.isFinite(openPremium) || position.identityConflict) {
                return _emptyDeferredEstimate(false, reasons.incomplete, eligible.length);
            }
            const quote = _findOptionQuote(optionInputs, position);
            if (!quote && _optionQuoteIdentityConflict(optionInputs, position)) {
                return _emptyDeferredEstimate(false, reasons.identity, eligible.length);
            }
            const impliedVolatility = Number(quote && quote.impliedVolatility);
            if (!quote || !Number.isFinite(impliedVolatility) || impliedVolatility <= 0) {
                return _emptyDeferredEstimate(false, reasons.iv, eligible.length);
            }
            const rateInput = ratesByExpiry.find((candidate) => (
                String(candidate && candidate.expiry || '').replace(/\D/g, '').slice(0, 8)
                    === String(position.expiry || '').replace(/\D/g, '').slice(0, 8)));
            const zeroRate = Number(rateInput && rateInput.zeroRate);
            if (!rateInput || !Number.isFinite(zeroRate)) {
                return _emptyDeferredEstimate(false, reasons.rate, eligible.length);
            }
            const timeYears = (expiryAt - scenarioAt) / (365 * 24 * 60 * 60 * 1000);
            const modelPerShare = priceScenarioOption(
                right, scenarioPrice, strike, timeYears,
                zeroRate, impliedVolatility, pricing);
            if (modelPerShare === null && pricing.pricingModel === 'american') {
                return _emptyDeferredEstimate(false, reasons.pricer, eligible.length);
            }
            if (!Number.isFinite(modelPerShare)) {
                return _emptyDeferredEstimate(false, reasons.incomplete, eligible.length);
            }
            const haircut = liquidationHaircut(quote, wantLong ? 'long' : 'short', liquidation);
            if (haircut === null) {
                return _emptyDeferredEstimate(false, bidAskProblem(quote) === 'crossed'
                    ? reasons.crossed : reasons.sides, eligible.length);
            }
            const markPerShare = modelPerShare * haircut;
            const marketValue = markPerShare * contracts * multiplier;
            details.push({
                expiry: String(position.expiry), right, strike, contracts, multiplier,
                timeYears, markPerShare, modelPerShare, haircut, marketValue,
                pricingModel: pricing.pricingModel, dividendYield: pricing.dividendYield,
                liability: marketValue < 0 ? -marketValue : 0,
                impliedVolatility, ivSource: String(quote.ivSource || ''),
                ivShockPoints: Number(quote.ivShockPoints) || 0,
                zeroRate, rateSource: String(rateInput.source || ''),
                openPremium, pnl: marketValue + openPremium,
            });
        }
        const result = details.reduce((total, detail) => ({
            available: true,
            reason: '',
            count: total.count + 1,
            contracts: total.contracts + Math.abs(detail.contracts),
            callContracts: total.callContracts
                + (detail.right === 'C' ? Math.abs(detail.contracts) : 0),
            putContracts: total.putContracts
                + (detail.right === 'P' ? Math.abs(detail.contracts) : 0),
            marketValue: total.marketValue + detail.marketValue,
            liability: total.liability + detail.liability,
            pnl: total.pnl + detail.pnl,
            details: total.details.concat([detail]),
        }), {
            available: true, reason: '', count: 0, contracts: 0,
            callContracts: 0, putContracts: 0,
            marketValue: 0, liability: 0, pnl: 0, details: [],
        });
        result.ivMin = Math.min(...details.map((detail) => detail.impliedVolatility));
        result.ivMax = Math.max(...details.map((detail) => detail.impliedVolatility));
        result.rateMin = Math.min(...details.map((detail) => detail.zeroRate));
        result.rateMax = Math.max(...details.map((detail) => detail.zeroRate));
        // The shock each contract actually received (tenor damping makes it
        // differ by expiry), so captions never quote the undamped figure.
        result.ivShockPointsMin = Math.min(...details.map((detail) => detail.ivShockPoints));
        result.ivShockPointsMax = Math.max(...details.map((detail) => detail.ivShockPoints));
        return result;
    }

    /** Long Calls / Puts still open after the stress date: mark + premium paid. */
    function estimateDeferredLongOptions(deferredOptions, scenarioPrice, options) {
        return _estimateDeferredOptions(deferredOptions, scenarioPrice, options, 'long');
    }

    /** Short Calls / Puts still open after the stress date: premium received − liability. */
    function estimateDeferredShortOptions(deferredOptions, scenarioPrice, options) {
        return _estimateDeferredOptions(deferredOptions, scenarioPrice, options, 'short');
    }

    // ------------------------------------------------------------------
    // Cross-book protection (TQQQ-first)
    // ------------------------------------------------------------------
    //
    // A leveraged ETF book can borrow protection from the same account's
    // unleveraged book: every TQQQ stress point is mapped onto a QQQ price
    // and the QQQ book's Long Calls / Puts are valued there. The index is the
    // driver: the default mapping inverts daily-rebalanced compounding with a
    // volatility-drag term (see mapLinkedUnderlyingPrice), and the plain
    // linear ratio is kept only for comparison. The mapping lives in exactly
    // one function so a better model replaces it without touching the sweep.
    // Only TQQQ has a seeded default today; any other leveraged fund works
    // the same way once the user picks a linked book and a ratio.
    const LINKED_REASON_BY_DEFERRED_REASON = Object.freeze({
        missing_long_option_market_inputs: 'missing_linked_market_inputs',
        missing_long_option_iv: 'missing_linked_option_iv',
        missing_discount_rate: 'missing_linked_discount_rate',
        incomplete_long_option: 'incomplete_linked_option',
        long_option_identity_mismatch: 'linked_option_identity_mismatch',
        missing_long_option_quote_sides: 'missing_linked_quote_sides',
        invalid_long_option_bid_ask: 'invalid_linked_bid_ask',
        invalid_long_option_iv_shock: 'invalid_linked_iv_shock',
        missing_american_pricer: 'missing_american_pricer',
    });

    /** IV shock in vol points (10 = +10 percentage points); blank/0 means none. */
    function normalizeIvShockPoints(value) {
        if (value === null || value === undefined || value === '') return 0;
        const points = Number(value);
        if (!Number.isFinite(points) || Math.abs(points) > 500) return null;
        return points;
    }

    /** Days the drop takes; blank means "use the selected expiry as the day". */
    /**
     * Component numbers shared by legend, status, cards, SVG titles and the
     * tooltip: ① is always this book's settlement; this book's live long
     * options are ② when shown; the linked book takes the next free number.
     */
    function stressComponentNumbers(showConvexity, showShorts, showLinked) {
        const circled = ['①', '②', '③', '④'];
        let next = 1;
        const own = showConvexity ? circled[next++] : '';
        const shorts = showShorts ? circled[next++] : '';
        const linked = showLinked ? circled[next++] : '';
        const parts = ['①'];
        if (own) parts.push(own);
        if (shorts) parts.push(shorts);
        if (linked) parts.push(linked);
        return { own, shorts, linked, total: parts.join('+') };
    }

    function normalizeStressHorizonDays(value) {
        if (value === null || value === undefined || value === '') return null;
        const days = Number(value);
        if (!Number.isInteger(days) || days < 0 || days > LINKED_MAX_HORIZON_DAYS) return undefined;
        return days;
    }

    function normalizeLinkedTenorDays(value) {
        if (value === null || value === undefined || value === '') return LINKED_IV_DEFAULT_TENOR_DAYS;
        const days = Number(value);
        if (!Number.isFinite(days) || days < 1 || days > LINKED_MAX_HORIZON_DAYS) return null;
        return days;
    }

    function addDaysToDigits(digits, days) {
        const at = _dateUtcFromDigits(digits);
        if (at === null || !Number.isFinite(Number(days))) return '';
        const shifted = new Date(at + Number(days) * DAY_MS);
        return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
            + `${String(shifted.getUTCDate()).padStart(2, '0')}`;
    }

    /** sqrt(reference / remaining days), never above 1, never below a day. */
    function tenorDampingFactor(remainingDays, referenceDays) {
        const remaining = Math.max(1, Number(remainingDays));
        const reference = Number(referenceDays);
        if (!Number.isFinite(remaining) || !Number.isFinite(reference) || reference <= 0) return 1;
        return Math.min(1, Math.sqrt(reference / remaining));
    }

    function normalizeLinkedIvMode(value) {
        const mode = String(value || 'none').trim().toLowerCase();
        return LINKED_IV_MODES.includes(mode) ? mode : null;
    }

    function normalizeLinkedIvBeta(value) {
        if (value === null || value === undefined || value === '') return LINKED_IV_DEFAULT_BETA;
        const beta = Number(value);
        if (!Number.isFinite(beta) || beta < 0 || beta > LINKED_IV_MAX_BETA) return null;
        return beta;
    }

    /**
     * Vol points to add to the linked contracts' IV at one scan point.
     * 'beta' lifts IV only while the mapped price is below today's: the
     * basis point and every rally get zero, so nothing on the upside is
     * invented.
     */
    function linkedIvShockPointsAt(mode, linkedChangePct, fixedPoints, beta) {
        if (mode === 'fixed') return Number(fixedPoints) || 0;
        if (mode === 'beta') {
            const drop = Number(linkedChangePct);
            if (!Number.isFinite(drop) || drop >= 0) return 0;
            return (Number(beta) || 0) * (-drop);
        }
        return 0;
    }

    function normalizeLinkedRatio(value) {
        const ratio = Number(value);
        if (!Number.isFinite(ratio) || Math.abs(ratio) < LINKED_HEDGE_MIN_ABS_RATIO) {
            return null;
        }
        return ratio;
    }

    const LINKED_MAPPINGS = Object.freeze(['compound', 'linear']);

    function normalizeLinkedMapping(value) {
        const mapping = String(value || 'compound').trim().toLowerCase();
        return LINKED_MAPPINGS.includes(mapping) ? mapping : null;
    }

    function normalizeLinkedSigma(value) {
        if (value === null || value === undefined || value === '') return null;
        const sigma = Number(value);
        if (!Number.isFinite(sigma) || sigma < 0 || sigma > 5) return undefined;
        return sigma;
    }

    /**
     * Volatility drag of a daily-rebalanced leveraged fund over `timeYears`,
     * as a log-return: (ratio² − ratio) / 2 × σ² × T. Zero for an instant
     * move, for an unlevered ratio, or without a path volatility.
     */
    function leveragedDragLog(ratio, sigma, timeYears) {
        const beta = Number(ratio);
        const vol = Number(sigma);
        const years = Number(timeYears);
        if (![beta, vol, years].every(Number.isFinite) || vol <= 0 || years <= 0) return 0;
        return ((beta * beta) - beta) / 2 * vol * vol * years;
    }

    /**
     * Map a scan point of the leveraged book onto the price of the index it
     * tracks. The index is the driver, so the book's move is inverted:
     *
     *   compound (default): (1 + ΔT) = (1 + R)^ratio × exp(−drag)
     *                       ⇒ 1 + R = ((1 + ΔT) × exp(drag))^(1 / ratio)
     *   linear:             R = ΔT / ratio
     *
     * A daily-rebalanced 3× fund really does compound, so at −30% the index
     * is down 11.2%, not 10%; the drag term is the multi-day volatility cost
     * and is zero for an instantaneous move. The ratio is signed so an
     * inverse fund (SQQQ = −3) maps a rally onto a decline. A price can never
     * go below zero.
     */
    function mapLinkedUnderlyingPrice(basePrice, changePct, ratio, options) {
        const opts = options || {};
        const base = Number(basePrice);
        const change = Number(changePct);
        const normalizedRatio = normalizeLinkedRatio(ratio);
        if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(change)
            || normalizedRatio === null) return null;
        const mapping = normalizeLinkedMapping(opts.mapping) || 'compound';
        if (mapping === 'linear') {
            return Math.max(0, base * (1 + change / 100 / normalizedRatio));
        }
        const gross = 1 + change / 100;
        if (gross <= 0) return 0;
        const drag = leveragedDragLog(normalizedRatio, opts.sigma, opts.timeYears);
        const indexGross = Math.pow(gross * Math.exp(drag), 1 / normalizedRatio);
        if (!Number.isFinite(indexGross)) return null;
        return Math.max(0, base * indexGross);
    }

    // A proxy further than this from the spot is still used, but flagged:
    // a deep wing's IV is a poor stand-in for realised index volatility.
    const PATH_SIGMA_PROXY_FAR_PCT = 10;

    /**
     * Market proxy for the path volatility of the drag term: the IV of the
     * quoted contract nearest the money among those alive after the stress
     * date. Never the lowest IV (that is whichever wing the ledger happens to
     * hold). Returns null when nothing qualifies; the caller decides whether
     * that is fatal (it is whenever a positive horizon needs a drag).
     */
    /** TWS marketDataType per quote row → one honest word for the chip. */
    function marketDataTypeLabel(rows) {
        const names = { 1: '实时', 2: '冻结', 3: '延时', 4: '延时冻结' };
        const kinds = Array.from(new Set((Array.isArray(rows) ? rows : [])
            .map((row) => Number(row && row.marketDataType))
            .filter((kind) => Number.isFinite(kind) && names[kind])));
        if (!kinds.length) return '';
        return kinds.length === 1 ? names[kinds[0]] : `混合：${kinds.map((k) => names[k]).join('/')}`;
    }

    function _proxyPathSigma(marketInputs, throughExpiry) {
        const quotes = marketInputs && Array.isArray(marketInputs.options) ? marketInputs.options : [];
        const spot = Number(marketInputs && marketInputs.underlyingPrice);
        const alive = quotes.filter((quote) => (
            String(quote && quote.expiry || '').replace(/\D/g, '').slice(0, 8) > throughExpiry
            && Number(quote && quote.impliedVolatility) > 0
            && Number(quote && quote.strike) > 0));
        if (!alive.length) return null;
        const distance = (quote) => (Number.isFinite(spot) && spot > 0
            ? Math.abs(Number(quote.strike) - spot) / spot * 100 : Infinity);
        const nearest = alive.reduce((best, quote) => (
            distance(quote) < distance(best) ? quote : best), alive[0]);
        const distancePct = distance(nearest);
        return {
            sigma: Number(nearest.impliedVolatility),
            strike: Number(nearest.strike),
            expiry: String(nearest.expiry || '').replace(/\D/g, '').slice(0, 8),
            distancePct: Number.isFinite(distancePct) ? distancePct : null,
            far: !Number.isFinite(distancePct) || distancePct > PATH_SIGMA_PROXY_FAR_PCT,
        };
    }

    function _emptyLinkedEstimate(available, reason, count) {
        return {
            available, reason: reason || '', count: count || 0, contracts: 0,
            callContracts: 0, putContracts: 0,
            settledContracts: 0, deferredContracts: 0, expiredContracts: 0,
            marketValue: available ? 0 : null,
            referenceValue: available ? 0 : null,
            pnl: available ? 0 : null,
            premiumPnl: available ? 0 : null,
            ivMin: null, ivMax: null, rateMin: null, rateMax: null, details: [],
        };
    }

    /**
     * Value the linked book's Long Calls / Puts at the mapped price on the
     * stress date and report the CHANGE against what they are worth today.
     *
     * The premium already paid is sunk: it does not move with the scenario,
     * so subtracting it would push the whole protection curve down by a
     * constant and hide the very effect this overlay exists to show. Today's
     * value is the TWS mark from the same one-shot snapshot that supplied the
     * IV; the scenario value is BSM at that IV for contracts still alive after
     * the stress date and intrinsic value for contracts that expire on or
     * before it. `premiumPnl` (mark + openPremium) is kept for reference
     * only. Short legs and shares of the linked book are ignored: this
     * answers "how much more are those long options worth", not "merge two
     * books". Contracts already expired on the valuation date protect
     * nothing and are counted, not valued.
     */
    function estimateLinkedLongOptions(openOptions, linkedPrice, options) {
        const opts = options || {};
        const throughExpiry = String(opts.throughExpiry || '').replace(/\D/g, '').slice(0, 8);
        // One scenario date for the whole modal: the linked book is valued
        // on the same day this book settles, so the stacked total is one
        // portfolio at one moment and every rate is resolved from that day.
        const scenarioAt = _dateUtcFromDigits(throughExpiry);
        const asOfAt = _dateUtcFromDigits(opts.asOf);
        const marketInputs = opts.marketInputs && typeof opts.marketInputs === 'object'
            ? opts.marketInputs : null;
        const optionInputs = marketInputs && Array.isArray(marketInputs.options)
            ? marketInputs.options : [];
        const price = Number(linkedPrice);
        const eligible = (Array.isArray(openOptions) ? openOptions : []).filter(
            (position) => Number(position.contracts) > 0
                && ['C', 'P'].includes(
                    String(position.right || '').toUpperCase().slice(0, 1)));
        if (!eligible.length) return _emptyLinkedEstimate(true, '', 0);
        if (scenarioAt === null) {
            return _emptyLinkedEstimate(false, 'missing_linked_market_inputs', eligible.length);
        }
        if (!Number.isFinite(price) || price < 0) {
            return _emptyLinkedEstimate(false, 'invalid_linked_underlying_price', eligible.length);
        }
        const alive = [];
        let expiredContracts = 0;
        for (const position of eligible) {
            const expiryAt = _dateUtcFromDigits(position.expiry);
            if (expiryAt === null) {
                return _emptyLinkedEstimate(false, 'incomplete_linked_option', eligible.length);
            }
            if (asOfAt !== null && expiryAt <= asOfAt) {
                expiredContracts += Number(position.contracts);
                continue;
            }
            alive.push({ position, expiryAt });
        }
        if (!alive.length) {
            return Object.assign(_emptyLinkedEstimate(true, '', 0), { expiredContracts });
        }
        if (!marketInputs || String(marketInputs.throughExpiry || '') !== throughExpiry) {
            return _emptyLinkedEstimate(false, 'missing_linked_market_inputs', eligible.length);
        }
        const deferred = alive.filter((entry) => entry.expiryAt > scenarioAt)
            .map((entry) => entry.position);
        // An IV shock is a scenario assumption: it moves the scenario value
        // of contracts still alive after the stress date and nothing else.
        // Today's marks stay what TWS says they are. Tenor damping shrinks a
        // quote's lift with its remaining life.
        const ivShock = Number(opts.ivShock || 0);
        if (!Number.isFinite(ivShock)) {
            return _emptyLinkedEstimate(false, 'invalid_linked_iv_shock', eligible.length);
        }
        const shocked = _applyIvShock(marketInputs, ivShock, opts.ivShockTenorDays, scenarioAt);
        if (shocked.breaksIv && deferred.length) {
            return _emptyLinkedEstimate(false, 'invalid_linked_iv_shock', eligible.length);
        }
        const scenarioInputs = shocked.inputs;
        const liquidation = normalizeLiquidation(opts.liquidation) || 'mid';
        let deferredResult = null;
        if (deferred.length) {
            deferredResult = estimateDeferredLongOptions(deferred, price, {
                throughExpiry, marketInputs: scenarioInputs, liquidation,
                pricingModel: opts.pricingModel, dividendYield: opts.dividendYield,
            });
            if (!deferredResult.available) {
                return _emptyLinkedEstimate(false,
                    LINKED_REASON_BY_DEFERRED_REASON[deferredResult.reason]
                        || 'incomplete_linked_option', eligible.length);
            }
        }
        const details = [];
        let deferredIndex = 0;
        for (const { position, expiryAt } of alive) {
            const right = String(position.right || '').toUpperCase().slice(0, 1);
            const strike = Number(position.strike);
            const contracts = Number(position.contracts);
            const multiplier = Math.abs(Number(position.sharesPerContract));
            const openPremium = Number(position.openPremium);
            if (!Number.isFinite(strike) || strike <= 0 || !Number.isFinite(contracts)
                || contracts <= 0 || !Number.isFinite(multiplier) || multiplier <= 0
                || !Number.isFinite(openPremium) || position.identityConflict) {
                return _emptyLinkedEstimate(false, 'incomplete_linked_option', eligible.length);
            }
            const quote = _findOptionQuote(optionInputs, position);
            if (!quote && _optionQuoteIdentityConflict(optionInputs, position)) {
                return _emptyLinkedEstimate(false, 'linked_option_identity_mismatch', eligible.length);
            }
            // A null mark is "no quote", never a free option worth zero.
            const rawMark = quote ? quote.mark : null;
            const midMarkPerShare = Number(rawMark);
            if (!quote || rawMark === null || rawMark === undefined || rawMark === ''
                || !Number.isFinite(midMarkPerShare) || midMarkPerShare < 0) {
                return _emptyLinkedEstimate(false, 'missing_linked_mark', eligible.length);
            }
            // Under the bid/ask lens today's value is what the bid pays and
            // the scenario mark is scaled by the same bid/mark ratio.
            const haircut = liquidationHaircut(quote, 'long', liquidation);
            if (haircut === null) {
                return _emptyLinkedEstimate(false, bidAskProblem(quote) === 'crossed'
                    ? 'invalid_linked_bid_ask' : 'missing_linked_quote_sides', eligible.length);
            }
            const referenceMarkPerShare = liquidation === 'bidask'
                ? Number(quote.bid) : midMarkPerShare;
            const referenceValue = referenceMarkPerShare * contracts * multiplier;
            let scenario;
            if (expiryAt > scenarioAt) {
                const deferredDetail = deferredResult.details[deferredIndex];
                deferredIndex += 1;
                const shockedQuote = ivShock === 0 ? null
                    : _findOptionQuote(scenarioInputs.options, position);
                scenario = {
                    timeYears: deferredDetail.timeYears,
                    markPerShare: deferredDetail.markPerShare,
                    modelPerShare: deferredDetail.modelPerShare,
                    pricingModel: deferredDetail.pricingModel,
                    dividendYield: deferredDetail.dividendYield,
                    marketValue: deferredDetail.marketValue,
                    impliedVolatility: deferredDetail.impliedVolatility,
                    ivShockPoints: shockedQuote ? Number(shockedQuote.ivShockPoints) || 0 : 0,
                    ivSource: deferredDetail.ivSource,
                    zeroRate: deferredDetail.zeroRate,
                    rateSource: deferredDetail.rateSource,
                    settled: false,
                };
            } else {
                // Settlement value needs no haircut: it is exercised, not sold.
                const intrinsic = right === 'C'
                    ? Math.max(price - strike, 0) : Math.max(strike - price, 0);
                scenario = {
                    timeYears: 0, markPerShare: intrinsic,
                    marketValue: intrinsic * contracts * multiplier,
                    impliedVolatility: null, ivShockPoints: 0, ivSource: 'intrinsic',
                    zeroRate: null, rateSource: '', settled: true,
                };
            }
            details.push(Object.assign({
                expiry: String(position.expiry), right, strike, contracts, multiplier,
            }, scenario, {
                referenceMarkPerShare, referenceValue, haircut,
                markSource: String(quote.markSource || ''),
                openPremium,
                pnl: scenario.marketValue - referenceValue,
                premiumPnl: scenario.marketValue + openPremium,
            }));
        }
        const result = details.reduce((total, detail) => ({
            available: true,
            reason: '',
            count: total.count + 1,
            contracts: total.contracts + detail.contracts,
            callContracts: total.callContracts
                + (detail.right === 'C' ? detail.contracts : 0),
            putContracts: total.putContracts
                + (detail.right === 'P' ? detail.contracts : 0),
            settledContracts: total.settledContracts
                + (detail.settled ? detail.contracts : 0),
            deferredContracts: total.deferredContracts
                + (detail.settled ? 0 : detail.contracts),
            expiredContracts,
            marketValue: total.marketValue + detail.marketValue,
            referenceValue: total.referenceValue + detail.referenceValue,
            pnl: total.pnl + detail.pnl,
            premiumPnl: total.premiumPnl + detail.premiumPnl,
            details: total.details.concat([detail]),
        }), {
            available: true, reason: '', count: 0, contracts: 0,
            callContracts: 0, putContracts: 0,
            settledContracts: 0, deferredContracts: 0, expiredContracts,
            marketValue: 0, referenceValue: 0, pnl: 0, premiumPnl: 0, details: [],
        });
        result.ivShockPointsMin = details.reduce((best, detail) => (
            detail.settled ? best : Math.min(best, detail.ivShockPoints)), Infinity);
        result.ivShockPointsMax = details.reduce((best, detail) => (
            detail.settled ? best : Math.max(best, detail.ivShockPoints)), -Infinity);
        if (!Number.isFinite(result.ivShockPointsMin)) result.ivShockPointsMin = null;
        if (!Number.isFinite(result.ivShockPointsMax)) result.ivShockPointsMax = null;
        result.ivMin = deferredResult && Number.isFinite(deferredResult.ivMin)
            ? deferredResult.ivMin : null;
        result.ivMax = deferredResult && Number.isFinite(deferredResult.ivMax)
            ? deferredResult.ivMax : null;
        result.rateMin = deferredResult && Number.isFinite(deferredResult.rateMin)
            ? deferredResult.rateMin : null;
        result.rateMax = deferredResult && Number.isFinite(deferredResult.rateMax)
            ? deferredResult.rateMax : null;
        return result;
    }

    /**
     * Decide which sibling book the stress test should borrow protection
     * from. A remembered choice wins when that book still exists; otherwise
     * the seeded default (TQQQ -> QQQ) is preselected but left switched off,
     * so nothing is ever overlaid without the user opting in.
     */
    function chooseLinkedBook(book, candidates, remembered) {
        const pool = Array.isArray(candidates) ? candidates : [];
        const hasCandidate = (bookId) => pool.some(
            (candidate) => String(candidate.bookId) === String(bookId));
        const rememberedBookId = remembered && remembered.linkedBookId
            ? String(remembered.linkedBookId) : '';
        if (rememberedBookId && hasCandidate(rememberedBookId)) {
            const ratio = normalizeLinkedRatio(remembered.ratio);
            const ivMode = normalizeLinkedIvMode(remembered.ivMode);
            const ivShockPoints = normalizeIvShockPoints(remembered.ivShockPoints);
            const ivBeta = normalizeLinkedIvBeta(remembered.ivBeta);
            const ivTenorDays = normalizeLinkedTenorDays(remembered.ivTenorDays);
            const mapping = normalizeLinkedMapping(remembered.mapping);
            const sigma = normalizeLinkedSigma(remembered.sigma);
            const rememberedYield = remembered.dividendYield === null
                || remembered.dividendYield === undefined
                ? null : normalizeDividendYield(remembered.dividendYield);
            return {
                mapping: mapping === null ? 'compound' : mapping,
                sigma: sigma === undefined ? null : sigma,
                dividendYield: rememberedYield,
                bookId: rememberedBookId,
                ratio: ratio === null ? LINKED_HEDGE_DEFAULT_RATIO : ratio,
                ivMode: ivMode === null ? 'none' : ivMode,
                ivShockPoints: ivShockPoints === null ? 0 : ivShockPoints,
                ivBeta: ivBeta === null ? LINKED_IV_DEFAULT_BETA : ivBeta,
                ivTenorDamping: remembered.ivTenorDamping !== false,
                ivTenorDays: ivTenorDays === null ? LINKED_IV_DEFAULT_TENOR_DAYS : ivTenorDays,
                // The overlay is never on when the modal opens: the fourth
                // curve appears only after a deliberate tick this session.
                enabled: false,
            };
        }
        const seed = book && LINKED_HEDGE_DEFAULTS[
            String(book.symbol || '').toUpperCase()];
        const seeded = seed ? pool.find((candidate) => (
            String(candidate.symbol || '').toUpperCase() === seed.symbol)) : null;
        return {
            bookId: seeded ? String(seeded.bookId) : '',
            ratio: seed ? seed.ratio : LINKED_HEDGE_DEFAULT_RATIO,
            ivMode: 'none',
            ivShockPoints: 0,
            ivBeta: LINKED_IV_DEFAULT_BETA,
            ivTenorDamping: true,
            ivTenorDays: LINKED_IV_DEFAULT_TENOR_DAYS,
            mapping: 'compound',
            sigma: null,
            dividendYield: null,
            enabled: false,
        };
    }

    /**
     * Validate the linked-hedge request once per sweep. Returns either the
     * inputs the per-point valuation needs or the reason nothing can be
     * valued; a null request means the overlay is simply off.
     */
    function _prepareLinkedHedge(linkedHedge, bookCurrency) {
        if (!linkedHedge || typeof linkedHedge !== 'object') return null;
        // Two books add up only in one currency; there is no FX here.
        const ownCurrency = String(bookCurrency || '').trim().toUpperCase();
        const linkedCurrency = String(linkedHedge.currency || '').trim().toUpperCase();
        if (ownCurrency && linkedCurrency && ownCurrency !== linkedCurrency) {
            return { reason: 'linked_currency_mismatch' };
        }
        const ratio = normalizeLinkedRatio(linkedHedge.ratio);
        if (ratio === null) return { reason: 'invalid_linked_ratio' };
        if (!Array.isArray(linkedHedge.openOptions)) return { reason: 'missing_linked_book' };
        const marketInputs = linkedHedge.marketInputs
            && typeof linkedHedge.marketInputs === 'object' ? linkedHedge.marketInputs : null;
        if (!marketInputs) return { reason: 'missing_linked_market_inputs' };
        const basePrice = Number(linkedHedge.basePrice);
        if (!Number.isFinite(basePrice) || basePrice <= 0) {
            return { reason: 'invalid_linked_underlying_price' };
        }
        const ivMode = normalizeLinkedIvMode(linkedHedge.ivMode);
        if (ivMode === null) return { reason: 'invalid_linked_iv_mode' };
        const ivShockPoints = ivMode === 'fixed'
            ? normalizeIvShockPoints(linkedHedge.ivShockPoints) : 0;
        if (ivShockPoints === null) return { reason: 'invalid_linked_iv_shock' };
        const ivBeta = ivMode === 'beta'
            ? normalizeLinkedIvBeta(linkedHedge.ivBeta) : LINKED_IV_DEFAULT_BETA;
        if (ivBeta === null) return { reason: 'invalid_linked_iv_beta' };
        const mapping = normalizeLinkedMapping(linkedHedge.mapping);
        if (mapping === null) return { reason: 'invalid_linked_mapping' };
        const dividendYield = normalizeDividendYield(linkedHedge.dividendYield);
        if (dividendYield === null) return { reason: 'invalid_linked_dividend_yield' };
        const sigma = normalizeLinkedSigma(linkedHedge.sigma);
        if (sigma === undefined) return { reason: 'invalid_linked_sigma' };
        const ivTenorDamping = ivMode === 'beta' && linkedHedge.ivTenorDamping === true;
        const ivTenorDays = ivTenorDamping
            ? normalizeLinkedTenorDays(linkedHedge.ivTenorDays) : LINKED_IV_DEFAULT_TENOR_DAYS;
        if (ivTenorDays === null) return { reason: 'invalid_linked_tenor_days' };
        return {
            reason: '',
            ratio,
            basePrice,
            ivMode,
            ivShockPoints,
            ivBeta,
            ivTenorDamping,
            ivTenorDays,
            mapping,
            sigma,
            dividendYield,
            symbol: String(linkedHedge.symbol || ''),
            bookId: String(linkedHedge.bookId || ''),
            openOptions: linkedHedge.openOptions,
            marketInputs,
            asOf: String(linkedHedge.asOf || '').replace(/\D/g, '').slice(0, 8),
        };
    }

    /**
     * Sweep one expiry-settlement scenario across a symmetric underlying
     * range. This is deliberately pure and read-only: every point is a fresh
     * replay with synthetic settlement rows that are never persisted.
     */
    function buildStressTestSeries(events, options) {
        const opts = options || {};
        const centerPrice = Number(opts.centerPrice);
        const rawRange = Number(opts.rangePct);
        const rangePct = Number.isFinite(rawRange)
            ? Math.min(90, Math.max(1, Math.abs(rawRange))) : 30;
        const rawPointCount = Number(opts.pointCount);
        const pointCount = Number.isInteger(rawPointCount)
            ? Math.min(121, Math.max(11, rawPointCount)) : 61;
        const throughExpiry = String(opts.throughExpiry || '').replace(/\D/g, '').slice(0, 8);
        const basisMode = core.BASIS_MODES.includes(opts.basisMode)
            ? opts.basisMode : 'net_cash';
        const includeDeferredLongOptions = opts.includeDeferredLongOptions === true;
        const longOptionInputs = opts.longOptionInputs || null;
        const liquidation = normalizeLiquidation(opts.liquidation);
        const pricingModel = normalizePricingModel(opts.pricingModel);
        const dividendYield = normalizeDividendYield(opts.dividendYield);
        const linkedHedge = _prepareLinkedHedge(opts.linkedHedge, opts.currency);
        // Path volatility for the leveraged drag: an explicit assumption, else
        // the IV of the linked book's quoted contract nearest the money among
        // those alive after the stress date, else none (fatal for a positive
        // horizon, see below). Time is today → scenario date.
        const linkedScenarioAt = _dateUtcFromDigits(throughExpiry);
        const linkedAsOfAt = linkedHedge && !linkedHedge.reason
            ? _dateUtcFromDigits(linkedHedge.asOf) : null;
        const linkedTimeYears = linkedScenarioAt !== null && linkedAsOfAt !== null
            ? Math.max(0, (linkedScenarioAt - linkedAsOfAt) / (365 * DAY_MS)) : 0;
        const linkedProxy = linkedHedge && !linkedHedge.reason && linkedHedge.sigma === null
            ? _proxyPathSigma(linkedHedge.marketInputs, throughExpiry) : null;
        const linkedSigma = linkedHedge && !linkedHedge.reason
            ? (linkedHedge.sigma !== null ? linkedHedge.sigma
                : (linkedProxy ? linkedProxy.sigma : null)) : null;
        let linkedSigmaSource = '';
        if (linkedHedge && !linkedHedge.reason) {
            if (linkedTimeYears <= 0) linkedSigmaSource = 'instant';
            else if (linkedHedge.sigma !== null) linkedSigmaSource = 'assumption';
            else if (linkedProxy) linkedSigmaSource = linkedProxy.far ? 'proxy_far' : 'proxy';
            else linkedSigmaSource = 'none';
            // A positive horizon under the compound mapping needs a path
            // volatility; a missing one must not quietly become "no drag".
            // When the book still holds contracts alive after the date, the
            // per-contract valuation names their missing IV or mark itself;
            // only a book whose contracts all settle has nothing to proxy with.
            const aliveOptions = (Array.isArray(linkedHedge.openOptions)
                ? linkedHedge.openOptions : []).filter((position) => (
                Number(position && position.contracts) > 0
                && String(position && position.expiry || '').replace(/\D/g, '').slice(0, 8)
                    > throughExpiry));
            if (linkedHedge.mapping !== 'linear' && linkedSigmaSource === 'none'
                && !aliveOptions.length) {
                linkedHedge.reason = 'missing_linked_sigma';
            }
        }
        if (!Number.isFinite(centerPrice) || centerPrice <= 0 || !throughExpiry
            || liquidation === null || pricingModel === null || dividendYield === null) {
            return {
                available: false,
                reason: !throughExpiry ? 'missing_expiry'
                    : (liquidation === null ? 'invalid_liquidation'
                        : (pricingModel === null ? 'invalid_pricing_model'
                            : (dividendYield === null ? 'invalid_dividend_yield'
                                : 'invalid_center_price'))),
                centerPrice: Number.isFinite(centerPrice) ? centerPrice : null,
                rangePct,
                throughExpiry,
                basisMode,
                includeDeferredLongOptions,
                points: [],
            };
        }

        const low = Math.max(0, centerPrice * (1 - rangePct / 100));
        const high = centerPrice * (1 + rangePct / 100);
        const points = [];
        for (let index = 0; index < pointCount; index += 1) {
            const ratio = pointCount === 1 ? 0 : index / (pointCount - 1);
            const price = low + (high - low) * ratio;
            const scenario = core.computeOptionSettlementScenario(events, price, {
                secType: opts.secType || 'STK',
                throughExpiry,
            });
            const summary = scenario.ledger && scenario.ledger.combined;
            const rendered = summary ? core.summarizeCost(summary, basisMode) : null;
            const cost = rendered && rendered.available ? Number(rendered.value) : null;
            const shares = summary ? Number(summary.shares) : null;
            let basePnl = cost !== null && Number.isFinite(shares)
                ? (price - cost) * shares : null;
            // If the selected expiry closes the entire position, cumulative
            // net cash is the locked-in result. Do not use that shortcut while
            // a later option remains open because its mark is intentionally
            // absent from this expiry-only model.
            if (basePnl === null && rendered && rendered.state === 'no_shares'
                && scenario.ledger && !(scenario.ledger.openOptions || []).length) {
                basePnl = Number(summary.lifetimeNetCash);
            }
            const changePct = ((price / centerPrice) - 1) * 100;
            // Steps 2-3: the linked index price and the IV shock are derived
            // first, because this book's own open options follow them - its IV
            // moves |ratio| times as much as the index's.
            const linkedPrice = linkedHedge && !linkedHedge.reason
                ? mapLinkedUnderlyingPrice(linkedHedge.basePrice, changePct, linkedHedge.ratio, {
                    mapping: linkedHedge.mapping, sigma: linkedSigma, timeYears: linkedTimeYears,
                }) : null;
            const linkedChangePct = Number.isFinite(linkedPrice) && linkedHedge && linkedHedge.basePrice
                ? ((linkedPrice / linkedHedge.basePrice) - 1) * 100 : null;
            const linkedIvShockPoints = linkedHedge && !linkedHedge.reason ? linkedIvShockPointsAt(
                linkedHedge.ivMode, linkedChangePct,
                linkedHedge.ivShockPoints, linkedHedge.ivBeta) : 0;
            const ownIvShockPoints = linkedHedge && !linkedHedge.reason
                ? Math.abs(linkedHedge.ratio) * linkedIvShockPoints : 0;
            const ownShockOptions = {
                throughExpiry, marketInputs: longOptionInputs,
                liquidation, pricingModel, dividendYield,
                ivShock: ownIvShockPoints / 100,
                ivShockTenorDays: linkedHedge && !linkedHedge.reason && linkedHedge.ivTenorDamping
                    ? linkedHedge.ivTenorDays : null,
            };
            const convexity = includeDeferredLongOptions
                ? estimateDeferredLongOptions(scenario.deferredOptions, price, ownShockOptions)
                : _emptyDeferredEstimate(true, '', 0);
            const shorts = includeDeferredLongOptions
                ? estimateDeferredShortOptions(scenario.deferredOptions, price, ownShockOptions)
                : _emptyDeferredEstimate(true, '', 0);
            const pnl = basePnl !== null && convexity.available && shorts.available
                ? basePnl + convexity.pnl + shorts.pnl : basePnl;
            const point = {
                price,
                changePct,
                ownIvShockPoints,
                cost: Number.isFinite(cost) ? cost : null,
                basePnl: Number.isFinite(basePnl) ? basePnl : null,
                pnl: Number.isFinite(pnl) ? pnl : null,
                longOptionMarketValue: Number.isFinite(convexity.marketValue)
                    ? convexity.marketValue : null,
                longOptionPnl: Number.isFinite(convexity.pnl) ? convexity.pnl : null,
                longOptionCount: Number(convexity.count || 0),
                longOptionContracts: Number(convexity.contracts || 0),
                longCallContracts: Number(convexity.callContracts || 0),
                longPutContracts: Number(convexity.putContracts || 0),
                longOptionIvMin: Number.isFinite(convexity.ivMin)
                    ? convexity.ivMin : null,
                longOptionIvMax: Number.isFinite(convexity.ivMax)
                    ? convexity.ivMax : null,
                longOptionRateMin: Number.isFinite(convexity.rateMin)
                    ? convexity.rateMin : null,
                longOptionRateMax: Number.isFinite(convexity.rateMax)
                    ? convexity.rateMax : null,
                longOptionIvShockMin: Number.isFinite(convexity.ivShockPointsMin)
                    ? convexity.ivShockPointsMin : null,
                longOptionIvShockMax: Number.isFinite(convexity.ivShockPointsMax)
                    ? convexity.ivShockPointsMax : null,
                shortOptionIvShockMin: Number.isFinite(shorts.ivShockPointsMin)
                    ? shorts.ivShockPointsMin : null,
                shortOptionIvShockMax: Number.isFinite(shorts.ivShockPointsMax)
                    ? shorts.ivShockPointsMax : null,
                convexityReason: String(convexity.reason || ''),
                convexityAvailable: convexity.available,
                shortOptionLiability: Number.isFinite(shorts.liability) ? shorts.liability : null,
                shortOptionPnl: Number.isFinite(shorts.pnl) ? shorts.pnl : null,
                shortOptionCount: Number(shorts.count || 0),
                shortOptionContracts: Number(shorts.contracts || 0),
                shortCallContracts: Number(shorts.callContracts || 0),
                shortPutContracts: Number(shorts.putContracts || 0),
                shortOptionIvMin: Number.isFinite(shorts.ivMin) ? shorts.ivMin : null,
                shortOptionIvMax: Number.isFinite(shorts.ivMax) ? shorts.ivMax : null,
                shortOptionRateMin: Number.isFinite(shorts.rateMin) ? shorts.rateMin : null,
                shortOptionRateMax: Number.isFinite(shorts.rateMax) ? shorts.rateMax : null,
                shortReason: String(shorts.reason || ''),
                shortAvailable: shorts.available,
                shares: Number.isFinite(shares) ? shares : null,
                assignedContracts: Number(scenario.assignedContracts || 0),
                exercisedContracts: Number(scenario.exercisedContracts || 0),
                expiredContracts: Number(scenario.expiredContracts || 0),
                unresolvedCount: (scenario.unresolvedOptions || []).length,
            };
            if (linkedHedge) {
                // Same stress date, other underlying: the linked book's long
                // options are marked at the mapped price and added on top of
                // this book's own result. `pnl` keeps its meaning above.
                const ivShockPoints = linkedIvShockPoints;
                const linked = linkedHedge.reason
                    ? _emptyLinkedEstimate(false, linkedHedge.reason, 0)
                    : estimateLinkedLongOptions(linkedHedge.openOptions, linkedPrice, {
                        throughExpiry, marketInputs: linkedHedge.marketInputs,
                        asOf: linkedHedge.asOf,
                        liquidation, pricingModel, dividendYield: linkedHedge.dividendYield,
                        ivShock: ivShockPoints / 100,
                        ivShockTenorDays: linkedHedge.ivTenorDamping ? linkedHedge.ivTenorDays : null,
                    });
                Object.assign(point, {
                    linkedPrice: Number.isFinite(linkedPrice) ? linkedPrice : null,
                    linkedChangePct,
                    linkedIvShockPoints: ivShockPoints,
                    linkedIvShockPointsMin: Number.isFinite(linked.ivShockPointsMin)
                        ? linked.ivShockPointsMin : null,
                    linkedIvShockPointsMax: Number.isFinite(linked.ivShockPointsMax)
                        ? linked.ivShockPointsMax : null,
                    linkedMarketValue: Number.isFinite(linked.marketValue)
                        ? linked.marketValue : null,
                    linkedReferenceValue: Number.isFinite(linked.referenceValue)
                        ? linked.referenceValue : null,
                    linkedPnl: Number.isFinite(linked.pnl) ? linked.pnl : null,
                    linkedPremiumPnl: Number.isFinite(linked.premiumPnl)
                        ? linked.premiumPnl : null,
                    linkedExpiredContracts: Number(linked.expiredContracts || 0),
                    linkedCount: Number(linked.count || 0),
                    linkedContracts: Number(linked.contracts || 0),
                    linkedCallContracts: Number(linked.callContracts || 0),
                    linkedPutContracts: Number(linked.putContracts || 0),
                    linkedSettledContracts: Number(linked.settledContracts || 0),
                    linkedDeferredContracts: Number(linked.deferredContracts || 0),
                    linkedIvMin: Number.isFinite(linked.ivMin) ? linked.ivMin : null,
                    linkedIvMax: Number.isFinite(linked.ivMax) ? linked.ivMax : null,
                    linkedRateMin: Number.isFinite(linked.rateMin) ? linked.rateMin : null,
                    linkedRateMax: Number.isFinite(linked.rateMax) ? linked.rateMax : null,
                    linkedAvailable: linked.available === true,
                    linkedReason: String(linked.reason || ''),
                    totalPnl: pnl !== null && linked.available && Number.isFinite(linked.pnl)
                        ? pnl + linked.pnl : null,
                });
            }
            points.push(point);
        }
        const hasUnresolved = points.some((point) => point.unresolvedCount);
        const hasInvalidConvexity = includeDeferredLongOptions
            && points.some((point) => !point.convexityAvailable);
        const convexityFailure = points.find((point) => !point.convexityAvailable);
        const hasInvalidShorts = includeDeferredLongOptions
            && points.some((point) => !point.shortAvailable);
        const shortFailure = points.find((point) => !point.shortAvailable);
        const hasInvalidLinked = Boolean(linkedHedge)
            && points.some((point) => !point.linkedAvailable);
        const linkedFailure = points.find((point) => !point.linkedAvailable);
        const series = {
            symbol: String(opts.symbol || ''),
            liquidation,
            pricingModel,
            dividendYield,
            available: !hasUnresolved && !hasInvalidConvexity && !hasInvalidShorts
                && !hasInvalidLinked
                && points.some((point) => point.pnl !== null || point.cost !== null),
            reason: hasUnresolved ? 'unresolved_options'
                : (hasInvalidConvexity
                    ? convexityFailure.convexityReason || 'invalid_long_option_inputs'
                    : (hasInvalidShorts
                        ? shortFailure.shortReason || 'invalid_short_option_inputs'
                        : (hasInvalidLinked
                            ? linkedFailure.linkedReason || 'missing_linked_book' : ''))),
            centerPrice,
            rangePct,
            throughExpiry,
            basisMode,
            includeDeferredLongOptions,
            longOptionCount: points.length ? points[0].longOptionCount : 0,
            longOptionContracts: points.length ? points[0].longOptionContracts : 0,
            longCallContracts: points.length ? points[0].longCallContracts : 0,
            longPutContracts: points.length ? points[0].longPutContracts : 0,
            longOptionIvMin: points.length ? points[0].longOptionIvMin : null,
            longOptionIvMax: points.length ? points[0].longOptionIvMax : null,
            longOptionRateMin: points.length ? points[0].longOptionRateMin : null,
            longOptionRateMax: points.length ? points[0].longOptionRateMax : null,
            shortOptionCount: points.length ? points[0].shortOptionCount : 0,
            shortOptionContracts: points.length ? points[0].shortOptionContracts : 0,
            shortCallContracts: points.length ? points[0].shortCallContracts : 0,
            shortPutContracts: points.length ? points[0].shortPutContracts : 0,
            shortOptionIvMin: points.length ? points[0].shortOptionIvMin : null,
            shortOptionIvMax: points.length ? points[0].shortOptionIvMax : null,
            shortOptionRateMin: points.length ? points[0].shortOptionRateMin : null,
            shortOptionRateMax: points.length ? points[0].shortOptionRateMax : null,
            inputsFetchedAt: String(longOptionInputs && longOptionInputs.fetchedAt || ''),
            curveAsOf: String(longOptionInputs && (
                longOptionInputs.curveEffectiveDate || longOptionInputs.curveAsOf) || ''),
            low,
            high,
            points,
        };
        if (linkedHedge) {
            const first = points.length ? points[0] : null;
            // IV ranges are quoted at the basis point: with a beta shock the
            // extremes of the scan carry their own, larger, lift.
            const centerIndex = points.reduce((best, point, index) => (
                Math.abs(point.changePct) < Math.abs(points[best].changePct) ? index : best
            ), 0);
            const center = points.length ? points[centerIndex] : null;
            Object.assign(series, {
                linkedHedgeEnabled: true,
                linkedSymbol: linkedHedge.symbol || '',
                linkedBookId: linkedHedge.bookId || '',
                linkedRatio: linkedHedge.ratio === undefined ? null : linkedHedge.ratio,
                linkedIvMode: linkedHedge.ivMode || 'none',
                linkedIvShockPoints: linkedHedge.ivShockPoints === undefined
                    ? null : linkedHedge.ivShockPoints,
                linkedIvBeta: linkedHedge.ivBeta === undefined ? null : linkedHedge.ivBeta,
                linkedIvTenorDamping: linkedHedge.ivTenorDamping === true,
                linkedIvTenorDays: linkedHedge.ivTenorDays === undefined
                    ? null : linkedHedge.ivTenorDays,
                linkedMapping: linkedHedge.mapping || 'compound',
                linkedDividendYield: linkedHedge.dividendYield === undefined
                    ? null : linkedHedge.dividendYield,
                linkedSigma: linkedSigma === undefined ? null : linkedSigma,
                linkedSigmaSource,
                linkedSigmaProxyStrike: linkedProxy ? linkedProxy.strike : null,
                linkedSigmaProxyExpiry: linkedProxy ? linkedProxy.expiry : null,
                linkedSigmaProxyDistancePct: linkedProxy ? linkedProxy.distancePct : null,
                linkedTimeYears,
                linkedDragLog: linkedHedge.reason ? 0
                    : leveragedDragLog(linkedHedge.ratio, linkedSigma, linkedTimeYears),
                centerIndex,
                linkedBasePrice: linkedHedge.basePrice === undefined ? null : linkedHedge.basePrice,
                linkedCount: first ? first.linkedCount : 0,
                linkedContracts: first ? first.linkedContracts : 0,
                linkedCallContracts: first ? first.linkedCallContracts : 0,
                linkedPutContracts: first ? first.linkedPutContracts : 0,
                linkedSettledContracts: first ? first.linkedSettledContracts : 0,
                linkedDeferredContracts: first ? first.linkedDeferredContracts : 0,
                linkedExpiredContracts: first ? first.linkedExpiredContracts : 0,
                linkedReferenceValue: first ? first.linkedReferenceValue : null,
                linkedIvMin: center ? center.linkedIvMin : null,
                linkedIvMax: center ? center.linkedIvMax : null,
                linkedRateMin: first ? first.linkedRateMin : null,
                linkedRateMax: first ? first.linkedRateMax : null,
                linkedInputsFetchedAt: String(linkedHedge.marketInputs
                    && linkedHedge.marketInputs.fetchedAt || ''),
            });
        }
        return series;
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
            void _bootstrap(socket);
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
            try {
                socket.send(JSON.stringify(Object.assign(
                    { action, requestId }, fields || {})));
            } catch (error) {
                globalScope.clearTimeout(timer);
                state.pending.delete(requestId);
                reject(error instanceof Error ? error : new Error('发送请求失败'));
            }
        });
    }

    function _sendOneWay(action, fields) {
        if (core.ALLOWED_CLIENT_ACTIONS.indexOf(action) < 0) return false;
        const socket = state.ws;
        if (!socket || socket.readyState !== 1) return false;
        try {
            socket.send(JSON.stringify(Object.assign({ action }, fields || {})));
            return true;
        } catch (_) {
            return false;
        }
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
            // The server stamps this in TWS's configured timezone. Browser
            // local time must never be compared with broker-local CSV rows.
            state.positionsTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
                .test(String(data.brokerTimestamp || ''))
                ? String(data.brokerTimestamp) : '';
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
                    state.marketPriceFetchedAt = '';
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
                state.marketPriceFetchedAt = '';
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

    async function _bootstrap(socket) {
        _sendOneWay('request_managed_accounts_snapshot');
        try {
            const status = await request('request_cost_basis_status');
            if (state.ws !== socket || state.connection !== 'connected') return;
            state.status = status;
            if (!status.available) {
                _setConnection('unavailable');
                _text($('store-status'), `不可用（${status.reason || '未知原因'}）`);
                return;
            }
            _text($('store-status'), `就绪 · schema v${status.storeSchemaVersion}`);
            await _loadBooks();
        } catch (error) {
            if (state.ws !== socket || state.connection !== 'connected') return;
            _text($('store-status'), `不可用（${error.message}）`);
            _setConnection('unavailable');
        }
    }

    async function _loadBooks() {
        const response = await request('list_cost_basis_books');
        state.books = Array.isArray(response.books) ? response.books : [];
        // A deleted book must not leave its price behind: book ids are not
        // reused today, but a stale entry would silently prime whatever
        // took its place.
        state.referencePriceByBook = pruneReferencePrices(
            state.referencePriceByBook, state.books);
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
            // The selected book is gone (deleted, or renamed out from under
            // us) and we are landing on a different underlying. That is a
            // book switch, so it has to clear book-scoped state the same way
            // an explicit one does - otherwise the vanished book's reference
            // price is still on screen, now labelled as this book's.
            _beginBookSelection(state.books[0].bookId);
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
                            await _selectBook(book.bookId);
                        }
                        _showView('ledger');
                    });
                    const row = globalScope.document.createElement('div');
                    row.className = 'book-nav-row';
                    const deleteButton = globalScope.document.createElement('button');
                    deleteButton.type = 'button';
                    deleteButton.className = 'book-nav-delete';
                    deleteButton.dataset.deleteBookId = book.bookId;
                    deleteButton.textContent = '删除';
                    deleteButton.title = `永久删除 ${account} / ${book.symbol} 整本账本`;
                    deleteButton.setAttribute('aria-label', deleteButton.title);
                    deleteButton.addEventListener('click', () => (
                        _deleteBook(book.bookId, deleteButton)));
                    row.appendChild(button);
                    row.appendChild(deleteButton);
                    group.appendChild(row);
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
    function isCurrentEventLoad(activeBookId, requestedBookId,
                                activeGeneration, requestedGeneration) {
        return Boolean(requestedBookId)
            && activeBookId === requestedBookId
            && activeGeneration === requestedGeneration;
    }

    /**
     * A DOM event handler must never leak a rejected ledger request to the
     * browser's unhandled-rejection hook. Returning false also keeps stale
     * generations from running their post-load render work.
     */
    async function loadSelectedBookSafely(loadEvents, afterLoad, onFailure) {
        try {
            const loaded = await loadEvents();
            if (loaded === false) return false;
            await afterLoad();
            return true;
        } catch (error) {
            try {
                onFailure(error && typeof error === 'object'
                    ? error : new Error(String(error)));
            } catch (_) {
                // Error rendering must not turn a handled socket failure back
                // into an unhandled promise rejection.
            }
            return false;
        }
    }

    /**
     * Every piece of state that means something only for the current book.
     *
     * A price, an average cost or a parsed CSV belongs to one underlying;
     * carried into the next book it does not read as missing, it reads as
     * that book's number. The reference price used to be left behind here,
     * so switching TQQQ -> TSM valued TSM's shares at TQQQ's price in the
     * hero, the What If panel and the stress test at once.
     *
     * Keep this list as the single definition, and add to it whenever a new
     * per-book field appears - the danger is silence, not a visible error.
     */
    function pruneReferencePrices(byBook, books) {
        const live = new Set((books || []).map((book) => String(book.bookId)));
        const kept = {};
        Object.keys(byBook || {}).forEach((bookId) => {
            if (live.has(bookId)) kept[bookId] = byBook[bookId];
        });
        return kept;
    }

    function bookScopedStateReset(nextBookId, referencePriceByBook) {
        // The typed reference price belongs to ONE underlying, so it can
        // neither carry across (it would value TSM at TQQQ's price) nor be
        // dropped (you lose it every time you glance at another book). It is
        // remembered per book and restored on the way back in.
        const remembered = referencePriceByBook
            ? referencePriceByBook[String(nextBookId || '')] : undefined;
        return {
            flowPage: 1,
            avgCostByAccount: {},
            referencePrice: remembered === undefined ? null : remembered,
            marketPrice: null,
            whatIfPrice: null,
            whatIfPriceSource: '',
            marketPriceFetchedAt: '',
            whatIfExpiry: '',
            stressLongOptionInputs: null,
            stressInputsError: '',
            stressInputsPending: false,
            stressIncludeLinkedHedge: false,
            stressLinkedBookId: '',
            stressLinkedRatio: LINKED_HEDGE_DEFAULT_RATIO,
            stressLinkedIvMode: 'none',
            stressLinkedIvShockPoints: 0,
            stressLinkedIvBeta: LINKED_IV_DEFAULT_BETA,
            stressHorizonDays: null,
            stressLiquidation: 'mid',
            stressDividendYield: null,
            stressLinkedIvTenorDamping: true,
            stressLinkedIvTenorDays: LINKED_IV_DEFAULT_TENOR_DAYS,
            stressLinkedMapping: 'compound',
            stressLinkedSigma: null,
            stressLinkedDividendYield: null,
            stressLinkedEvents: [],
            stressLinkedLedger: null,
            stressLinkedEventsPending: false,
            stressLinkedEventsError: '',
            stressLinkedInputs: null,
            stressLinkedInputsPending: false,
            stressLinkedInputsError: '',
            importResult: null,
            importText: '',
            resetPlan: null,
            allEvents: [],
            eventsTotal: 0,
            ledger: null,
            reconciliation: null,
        };
    }

    function _beginBookSelection(bookId) {
        state.whatIfEditGeneration += 1;
        // Snapshots and linked-book loads in flight belong to the previous book.
        state.stressInputsGeneration += 1;
        state.stressLinkedLoadGeneration += 1;
        state.stressLinkedInputsGeneration += 1;
        state.bookId = String(bookId || '');
        $('book-select').value = state.bookId;
        Object.assign(state,
            bookScopedStateReset(state.bookId, state.referencePriceByBook));
        // These inputs hold book-scoped values too, so clearing only the
        // state behind them would leave a stale figure on screen that no
        // longer feeds anything.
        $('import-file').value = '';
        $('import-replace').checked = false;
        $('reference-price').value = state.referencePrice === null
            ? '' : String(state.referencePrice);
        // Clear the previous book immediately. If the socket drops during
        // this request, the new title can never be paired with old rows.
        _renderImportPreview();
        _renderAll();
        // The initial account push can arrive before books load. Prime this
        // selection from the existing cache once, then rely on normal pushes.
        _sendOneWay('request_portfolio_avg_cost_snapshot');
    }

    async function _selectBook(bookId) {
        const requestedBookId = String(bookId || '');
        _beginBookSelection(requestedBookId);
        return loadSelectedBookSafely(
            () => _loadEvents(),
            async () => {
                if (state.bookId !== requestedBookId) return;
                await _refreshResetPlan();
                _renderImportPreview();
                _renderSidebarBooks();
            },
            (error) => {
                if (state.bookId !== requestedBookId) return;
                state.eventLoadGeneration += 1;
                state.allEvents = [];
                state.eventsTotal = 0;
                state.ledger = null;
                state.reconciliation = null;
                state.resetPlan = null;
                _renderImportPreview();
                _renderAll();
                _text($('store-status'), state.connection === 'connected'
                    ? `读取失败（${error.message}）`
                    : '未连接（当前账本尚未载入）');
            },
        );
    }

    async function _loadEvents() {
        if (!state.bookId) return;
        const bookId = state.bookId;
        state.eventLoadGeneration += 1;
        const generation = state.eventLoadGeneration;
        const collected = [];
        let offset = 0;
        let total = 0;
        for (;;) {
            const response = await request('list_cost_basis_events', {
                bookId,
                limit: LEDGER_FETCH_SIZE,
                offset,
                includeVoided: true,
            });
            if (!isCurrentEventLoad(
                state.bookId, bookId, state.eventLoadGeneration, generation)) {
                return false;
            }
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
        if (!isCurrentEventLoad(
            state.bookId, bookId, state.eventLoadGeneration, generation)) {
            return false;
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
        return true;
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
        _invalidatePositions();
        state.requestCounter += 1;
        state.positionsRequestId = `cb-pos-${state.requestCounter}-${Date.now()}`;
        if (!_sendOneWay('request_portfolio_positions_snapshot', {
            requestId: state.positionsRequestId,
        })) {
            state.positionsRequestId = '';
            _text($('positions-status'), '未连接到后端');
            return;
        }
        _sendOneWay('request_portfolio_avg_cost_snapshot');
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

    async function _refreshWhatIfMarketPrice() {
        const book = _currentBook();
        if (!book || !state.bookId || state.marketPriceRefreshPending) return;
        const bookId = state.bookId;
        const loadGeneration = state.eventLoadGeneration;
        const editGeneration = state.whatIfEditGeneration;
        const socket = state.ws;
        state.marketPriceRefreshPending = true;
        _renderWhatIf();
        try {
            const response = await request('request_cost_basis_market_price', {
                bookId,
            });
            if (state.bookId !== bookId || state.ws !== socket
                || state.eventLoadGeneration !== loadGeneration) return;
            const price = Number(response.marketPrice);
            if (!Number.isFinite(price) || price <= 0) {
                throw new Error('TWS 返回的最新价格无效');
            }
            state.marketPrice = price;
            state.marketPriceFetchedAt = String(response.fetchedAt || '');
            // A successful explicit refresh resumes following the reference.
            // Never overwrite an edit made while the quote was in flight.
            if (state.whatIfEditGeneration === editGeneration) {
                state.referencePrice = null;
                delete state.referencePriceByBook[bookId];
                $('reference-price').value = '';
                state.whatIfPrice = null;
                state.whatIfPriceSource = '';
            }
            _recompute();
        } catch (error) {
            if (state.bookId !== bookId || state.ws !== socket
                || state.eventLoadGeneration !== loadGeneration) return;
            const unavailable = error.code === 'broker_market_price_unavailable';
            globalScope.alert(unavailable
                ? '当前后端不支持主动刷新 TWS 价格，请连接实时 IB 后端。'
                : `刷新 TWS 当前价失败：${error.message}`);
        } finally {
            state.marketPriceRefreshPending = false;
            _renderWhatIf();
        }
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
        _renderReconciliation();
        _renderWhatIf();
    }

    function _renderPositionsStatus() {
        const node = $('positions-status');
        const book = _currentBook();
        const inferred = buildLedgerPositionPreview(
            state.ledger, book && book.symbol, book && book.secType);
        if (!state.positionsAt) {
            const label = inferred.length
                ? `TWS 未获取 · ${inferred.length} 项 CSV 推测`
                : 'TWS 未获取';
            _text(node, label);
            _text($('settings-positions-status'), label);
            return;
        }
        const label = state.positionsConnected
            ? `${state.positionsAt} · ${state.positions.length} 条持仓`
            : (inferred.length
                ? `${state.positionsAt} · TWS 未连接 · ${inferred.length} 项 CSV 推测`
                : `${state.positionsAt} · TWS 未连接`);
        _text(node, label);
        _text($('settings-positions-status'), label);
    }

    function canReconcilePositions(positionsAt, positionsConnected) {
        return Boolean(positionsAt && positionsConnected);
    }

    /**
     * Present the positions reconstructed by replaying the persisted ledger.
     *
     * These rows are deliberately not a reconciliation result: without a
     * completed TWS snapshot there is no broker-side zero, no difference,
     * and no safe reconciliation suggestion. They keep the CSV-derived position visible
     * while making the missing live verification explicit.
     */
    function buildLedgerPositionPreview(ledger, symbol, bookSecType) {
        if (!ledger) return [];
        const rows = [];
        const normalizedSymbol = String(symbol || '').trim().toUpperCase();
        const futures = String(bookSecType || 'STK').toUpperCase() === 'FUT';

        if (futures) {
            (ledger.openFutures || []).forEach((position) => {
                const quantity = Number(position.contracts);
                if (!Number.isFinite(quantity) || Math.abs(quantity) < 1e-6) return;
                rows.push({
                    kind: 'future',
                    account: String(position.account || ''),
                    label: `${normalizedSymbol} ${position.expiry || ''} FUT`.trim(),
                    ledger: quantity,
                    identityConflict: Boolean(position.identityConflict),
                });
            });
        } else {
            Object.keys(ledger.perAccount || {}).sort().forEach((account) => {
                const quantity = Number((ledger.perAccount[account] || {}).shares);
                if (!Number.isFinite(quantity) || Math.abs(quantity) < 1e-6) return;
                rows.push({
                    kind: 'shares', account, label: '股票', ledger: quantity,
                    identityConflict: false,
                });
            });
        }

        (ledger.openOptions || []).forEach((position) => {
            const quantity = Number(position.contracts);
            if (!Number.isFinite(quantity) || Math.abs(quantity) < 1e-6) return;
            const strike = position.strike === null || position.strike === undefined
                ? '' : position.strike;
            rows.push({
                kind: 'option',
                account: String(position.account || ''),
                label: `${normalizedSymbol} ${position.expiry || ''} `
                    + `${position.right || ''}${strike}`.trim(),
                ledger: quantity,
                identityConflict: Boolean(position.identityConflict),
            });
        });

        return core.sortPositionRows(rows);
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
        _renderPositionsStatus();
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
        _summaryRow(body, '若未平仓卖方期权全部归零', columns,
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
        _summaryRow(body, '已到期 / 已结算卖方权利金', columns,
            (summary) => _money(summary.realizedShortPremium));
        _summaryRow(body, '尚未到期卖方权利金', columns,
            (summary) => _money(summary.openShortPremium));
        _summaryRow(body, futures ? 'FUT 换月 / 平仓已实现盈亏' : '股票已实现盈亏', columns,
            (summary) => _money(futures
                ? summary.futuresRealizedPnl : summary.stockRealizedPnl));
        if (!futures) {
            _summaryRow(body, '股息', columns, (summary) => _money(summary.dividends));
        }
        // Account view, same as the cash card above: fees are money paid
        // out, so both places show them negative. The table used to print
        // the same figure positive under the same label.
        _summaryRow(body, '费用合计', columns,
            (summary) => _signedMoney(-Math.abs(Number(summary.fees) || 0)));

        _sectionRow(body, '按参考价', columns.length);
        _summaryRow(body, '盈亏平衡价', columns,
            (summary) => (summary.breakEvenPrice === null
                ? '—' : _money(summary.breakEvenPrice, 4)));
        _summaryRow(body, '标的按参考价清算后净收益（不含 Long Option）', columns,
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

    function _effectiveWhatIfPrice() {
        if (state.whatIfPriceSource === 'custom') return state.whatIfPrice;
        return state.referencePrice !== null ? state.referencePrice : state.marketPrice;
    }

    function _setWhatIfFollowReference(follow) {
        const price = _effectiveWhatIfPrice();
        state.whatIfEditGeneration += 1;
        state.whatIfPrice = follow ? null : price;
        state.whatIfPriceSource = follow ? '' : 'custom';
        _renderWhatIf();
    }

    function _editWhatIfPrice(inputEvent) {
        state.whatIfEditGeneration += 1;
        state.whatIfPrice = _numberOrNull(inputEvent.target.value);
        // An empty field during editing is not permission to resume following.
        state.whatIfPriceSource = 'custom';
        _renderWhatIf();
    }

    function _renderWhatIf() {
        const book = _currentBook();
        const input = $('what-if-price');
        const currentButton = $('btn-what-if-current');
        const followInput = $('what-if-follow-reference');
        followInput.checked = state.whatIfPriceSource !== 'custom';
        const stressButton = $('btn-open-stress-test');
        const resultNode = $('what-if-result');
        const totalCostNode = $('what-if-total-cost');
        const finalSharesNode = $('what-if-final-shares');
        const putSharesNode = $('what-if-put-shares');
        [resultNode, totalCostNode, finalSharesNode, putSharesNode].forEach((node) => {
            node.className = '';
            _text(node, '—');
        });
        _text($('what-if-share-caption'), '现有股票不会被卖出');
        _text($('what-if-put-caption'), '—');
        _text($('what-if-total-caption'), '情景综合成本 × 结算后总股数');
        _text($('what-if-outcomes'), '输入假设到期结算价后，这里会列出被指派和归零的 Short Put。');
        if (!state.ledger || !book) {
            _renderWhatIfExpiryOptions([], true);
            input.value = '';
            input.disabled = true;
            currentButton.disabled = true;
            followInput.disabled = true;
            stressButton.disabled = true;
            _text($('what-if-price-label'), '假设标的到期结算价');
            _text($('what-if-context'), '选择账本后，可模拟所有未平期权结算后的持股与综合成本。');
            _text($('what-if-result-caption'), '按上方选中的成本口径');
            return;
        }
        const futures = String(book.secType || 'STK').toUpperCase() === 'FUT';
        const expiries = _renderWhatIfExpiryOptions(
            state.ledger.openOptions || [], futures);
        input.disabled = futures || !expiries.length;
        followInput.disabled = input.disabled;
        currentButton.textContent = state.marketPriceRefreshPending
            ? '刷新中…' : '使用当前价';
        currentButton.disabled = futures || !expiries.length
            || state.marketPriceRefreshPending || state.connection !== 'connected';
        stressButton.disabled = futures || !expiries.length;
        _text($('what-if-price-label'), `${book.symbol} 假设到期结算价`);
        if (futures) {
            input.value = '';
            _text($('what-if-context'), 'What If 期权结算情景目前仅适用于股票 / ETF 账本。');
            _text($('what-if-result-caption'), '期货请使用 FUT 成本口径');
            return;
        }
        if (!expiries.length) {
            input.value = '';
            _text($('what-if-context'), `${book.symbol} 当前没有可用于情景测算的未平期权。`);
            _text($('what-if-result-caption'), '无未平期权到期日');
            return;
        }
        const currentSummary = state.ledger.combined;
        const price = _effectiveWhatIfPrice();
        if (followInput.checked || globalScope.document.activeElement !== input) {
            input.value = price === null ? '' : String(price);
        }
        const refreshedClock = state.marketPriceFetchedAt.length >= 19
            ? state.marketPriceFetchedAt.slice(11, 19) : '';
        const priceSource = !followInput.checked ? '自定义到期价 · 自动跟随已暂停'
            : (state.referencePrice !== null ? '自动跟随手工参考价'
                : (price === null ? '自动跟随 · 等待 TWS 参考价'
                    : (refreshedClock ? `自动跟随 TWS 最新价（${refreshedClock} 刷新）`
                        : '自动跟随 TWS 持仓快照价')));
        const openCount = (state.ledger.openOptions || []).reduce(
            (total, option) => total + Math.abs(Number(option.contracts) || 0), 0);
        _text($('what-if-context'), `${book.symbol} · 现有 ${_quantity(currentSummary.shares)} 股`
            + ` · ${_quantity(openCount)} 张未平期权 · ${priceSource}`
            + ` · 计算至 ${state.whatIfExpiry.slice(0, 4)}-${state.whatIfExpiry.slice(4, 6)}`
            + `-${state.whatIfExpiry.slice(6, 8)}`
            + ` · ${BASIS_LABELS[state.basisMode] || state.basisMode}口径`);
        if (price === null) {
            _text($('what-if-result-caption'), '请先拉取 TWS 当前价，或输入假设到期结算价');
            return;
        }
        const scenario = core.computeOptionSettlementScenario(state.allEvents, price, {
            secType: book.secType || 'STK',
            throughExpiry: state.whatIfExpiry,
        });
        if (!scenario.available) {
            const missing = (scenario.unresolvedOptions || []).length;
            _text($('what-if-result-caption'), missing
                ? `${missing} 个未平期权缺少行权价、乘数或唯一标识，无法完整测算`
                : '无法计算当前情景');
            return;
        }
        const summary = scenario.ledger.combined;
        const rendered = core.summarizeCost(summary, state.basisMode);
        if (!rendered.available) {
            _text($('what-if-result-caption'), '期权结算后没有股票净持仓，因此不存在每股综合成本');
            _text(finalSharesNode, `${_quantity(summary.shares)} 股`);
            return;
        }
        const currency = book.currency || 'USD';
        const totalCost = rendered.value * summary.shares;
        _text(resultNode, _currencyAmount(currency, rendered.value, 4));
        resultNode.className = rendered.value < 0 ? 'metric-positive' : '';
        _text(totalCostNode, _currencyAmount(currency, totalCost));
        if (state.basisMode === 'net_cash') {
            _text($('what-if-total-caption'), `结算后标的成本净投入 ${_currencyAmount(currency, summary.costNetCashOut)}`
                + ` · 尚未到期卖方权利金 ${_currencyAmount(currency, summary.openShortPremium)}`
                + ' 已收取，但履约义务尚存；Long Call / Put 全周期现金均排除');
        } else {
            _text($('what-if-total-caption'), `${BASIS_LABELS[state.basisMode] || state.basisMode}`
                + '口径每股成本 × 结算后总股数');
        }
        _text(finalSharesNode, `${_quantity(summary.shares)} 股`);
        const shareChange = summary.shares - currentSummary.shares;
        _text($('what-if-share-caption'), `现有 ${_quantity(currentSummary.shares)} 股`
            + ` · 期权结算 ${shareChange > 0 ? '+' : ''}${_quantity(shareChange)} 股`);
        const putShares = scenario.shortPutAssignedShares;
        _text(putSharesNode, `${putShares > 0 ? '+' : ''}${_quantity(putShares)} 股`);
        const assignmentSpend = Math.abs(Number(scenario.shortPutAssignmentCash) || 0);
        _text($('what-if-put-caption'), scenario.shortPutContracts
                ? `${_quantity(scenario.shortPutAssignedContracts)} 张被指派 · `
                + `${_quantity(scenario.shortPutExpiredContracts)} 张归零 · `
                + `买股支出 ${_currencyAmount(currency, assignmentSpend)}`
            : '当前没有未平 Short Put');
        const byExpiryThenStrike = (left, right) => {
            const leftExpiry = String(left.expiry || '');
            const rightExpiry = String(right.expiry || '');
            if (leftExpiry !== rightExpiry) return leftExpiry < rightExpiry ? -1 : 1;
            return Number(left.strike || 0) - Number(right.strike || 0);
        };
        const shortPuts = scenario.outcomes.filter(
            (outcome) => outcome.side === 'short' && outcome.right === 'P')
            .sort(byExpiryThenStrike);
        const assignedPuts = shortPuts.filter(
            (outcome) => outcome.outcome === 'option_assignment');
        const expiredPuts = shortPuts.filter(
            (outcome) => outcome.outcome === 'option_expiry');
        const assignedText = assignedPuts.length
            ? assignedPuts.map(_whatIfContractLabel).join('、') : '无';
        const expiredText = expiredPuts.length
            ? expiredPuts.map(_whatIfContractLabel).join('、') : '无';
        const deferredPuts = (scenario.deferredOptions || []).filter((option) => (
            Number(option.contracts) < 0
            && String(option.right || '').toUpperCase().slice(0, 1) === 'P'))
            .sort(byExpiryThenStrike);
        const deferredText = deferredPuts.length
            ? deferredPuts.map((option) => _whatIfContractLabel({
                expiry: option.expiry,
                strike: option.strike,
                right: option.right,
                contracts: Math.abs(Number(option.contracts) || 0),
            })).join('、') : '无';
        _text($('what-if-outcomes'), `截至所选日被指派：${assignedText}；`
            + `截至所选日归零：${expiredText}；`
            + `所选日后继续保留：${deferredText}`);
        _text($('what-if-result-caption'), `计算至 ${state.whatIfExpiry.slice(0, 4)}`
            + `-${state.whatIfExpiry.slice(4, 6)}-${state.whatIfExpiry.slice(6, 8)}`
            + ` · ${_money(price, 4)} 结算情景 · `
            + `${BASIS_LABELS[state.basisMode] || state.basisMode}口径`);
    }

    function _stressDateLabel(expiry) {
        const digits = String(expiry || '').replace(/\D/g, '').slice(0, 8);
        return digits.length === 8
            ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
            : '未选择';
    }

    function _stressReferencePrice() {
        if (state.marketPrice !== null) return Number(state.marketPrice);
        if (state.referencePrice !== null) return Number(state.referencePrice);
        if (state.whatIfPrice !== null) return Number(state.whatIfPrice);
        return null;
    }

    /**
     * The one date every stress component is valued on. A horizon overrides
     * the selected expiry: today + N days, with N days of theta for every
     * open option and every contract inside the window settled.
     */
    function _stressScenarioDate() {
        const horizon = state.stressHorizonDays;
        if (horizon === null || horizon === undefined) {
            return { date: state.stressExpiry, horizonDays: null, error: '' };
        }
        const days = normalizeStressHorizonDays(horizon);
        if (days === undefined || days === null) {
            return { date: '', horizonDays: horizon, error: 'invalid_horizon' };
        }
        const date = addDaysToDigits(_todayDigits(), days);
        return { date, horizonDays: days, error: date ? '' : 'invalid_horizon' };
    }

    function _stressLongOptionRequests() {
        // This book marks BOTH sides after the scenario date, so every open
        // contract alive on it is quoted; the linked book stays long-only.
        return _deferredLongOptionRequests(
            state.ledger && state.ledger.openOptions, _stressScenarioDate().date,
            { includeShorts: true });
    }

    function _deferredLongOptionRequests(openOptions, throughExpiry, options) {
        const includeShorts = Boolean(options && options.includeShorts);
        return (openOptions || []).filter((option) => (
            (includeShorts ? Number(option.contracts) !== 0 : Number(option.contracts) > 0)
            && ['C', 'P'].includes(String(option.right || '').toUpperCase().slice(0, 1))
            && String(option.expiry || '').replace(/\D/g, '').slice(0, 8)
                > throughExpiry
        )).map((option) => ({
            conId: option.conId || null,
            localSymbol: option.localSymbol || '',
            right: String(option.right || '').toUpperCase().slice(0, 1),
            strike: Number(option.strike),
            expiry: String(option.expiry || '').replace(/\D/g, '').slice(0, 8),
            multiplier: Math.abs(Number(option.sharesPerContract)) || null,
        }));
    }

    function _stressPercentRange(minimum, maximum) {
        const min = Number(minimum);
        const max = Number(maximum);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return '—';
        if (Math.abs(max - min) < 1e-9) return `${_money(min * 100, 2)}%`;
        return `${_money(min * 100, 2)}%–${_money(max * 100, 2)}%`;
    }

    function _renderStressExpiryOptions() {
        const select = $('stress-expiry');
        const expiries = Array.from(new Set(((state.ledger && state.ledger.openOptions) || [])
            .map((option) => String(option.expiry || '').replace(/\D/g, '').slice(0, 8))
            .filter((expiry) => expiry.length === 8))).sort();
        if (!expiries.includes(state.stressExpiry)) {
            state.stressExpiry = expiries.includes(state.whatIfExpiry)
                ? state.whatIfExpiry : (expiries[0] || '');
        }
        _clear(select);
        if (!expiries.length) {
            const option = globalScope.document.createElement('option');
            option.value = '';
            option.textContent = '没有未平期权到期日';
            select.appendChild(option);
        } else {
            expiries.forEach((expiry) => {
                const option = globalScope.document.createElement('option');
                option.value = expiry;
                option.textContent = `计算至 ${_stressDateLabel(expiry)}`;
                select.appendChild(option);
            });
        }
        select.value = state.stressExpiry;
        select.disabled = !expiries.length;
        return expiries;
    }

    function _svgNode(tag, attributes, label) {
        const node = globalScope.document.createElementNS(
            'http://www.w3.org/2000/svg', tag);
        Object.keys(attributes || {}).forEach((name) => (
            node.setAttribute(name, String(attributes[name]))));
        if (label !== undefined) node.textContent = label;
        return node;
    }

    function _stressExtent(values, includeZero) {
        const finite = (values || []).filter((value) => Number.isFinite(value));
        if (includeZero) finite.push(0);
        if (!finite.length) return { min: -1, max: 1 };
        let min = Math.min(...finite);
        let max = Math.max(...finite);
        if (Math.abs(max - min) < 1e-9) {
            const pad = Math.max(1, Math.abs(max) * 0.1);
            min -= pad;
            max += pad;
        } else {
            const pad = (max - min) * 0.1;
            min -= pad;
            max += pad;
        }
        return { min, max };
    }

    function _compactAxisNumber(value) {
        const magnitude = Math.abs(Number(value));
        if (magnitude >= 1000000) return `${_money(value / 1000000, 1)}m`;
        if (magnitude >= 1000) return `${_money(value / 1000, 1)}k`;
        return _money(value, magnitude >= 100 ? 0 : 2);
    }

    function _renderStressCards(series, currency) {
        const wrap = $('stress-key-points');
        _clear(wrap);
        if (!series.points.length) return;
        const middle = series.points.reduce((best, point) => (
            Math.abs(point.price - series.centerPrice)
                < Math.abs(best.price - series.centerPrice) ? point : best
        ), series.points[0]);
        const choices = [
            ['下行情景', series.points[0]],
            ['基准现价', middle],
            ['上行情景', series.points[series.points.length - 1]],
        ];
        const showConvexity = Boolean(series.includeDeferredLongOptions
            && series.longOptionCount);
        const showShorts = Boolean(series.includeDeferredLongOptions
            && series.shortOptionCount);
        const showLinked = series.linkedHedgeEnabled === true && series.linkedCount > 0;
        const numbers = stressComponentNumbers(showConvexity, showShorts, showLinked);
        const symbol = String(series.symbol || '');
        const linkedSymbol = String(series.linkedSymbol || '');
        const amount = (value) => (value === null || value === undefined
            ? '—' : _currencyAmount(currency, value, 2, true));
        const line = (card, text, className) => {
            const node = globalScope.document.createElement('small');
            node.textContent = text;
            if (className) node.className = className;
            card.appendChild(node);
        };
        choices.forEach(([label, point]) => {
            const card = globalScope.document.createElement('article');
            const heading = globalScope.document.createElement('span');
            heading.textContent = `${label} · ${_money(point.price, 2)}`
                + `（${point.changePct > 0 ? '+' : ''}${_money(point.changePct, 1)}%）`
                + (showLinked && point.linkedPrice !== null
                    ? ` · ${linkedSymbol} ${_money(point.linkedPrice, 2)}`
                        + `（${point.linkedChangePct > 0 ? '+' : ''}`
                        + `${_money(point.linkedChangePct, 1)}%）`
                    : '');
            card.appendChild(heading);
            // The headline is the sum of every component switched on.
            const headline = showLinked ? point.totalPnl : point.pnl;
            const total = globalScope.document.createElement('strong');
            const anyPart = showConvexity || showShorts || showLinked;
            total.textContent = `${anyPart ? '合计' : '到期结算盈亏'}`
                + ` ${amount(headline)}`;
            if (headline > 0) total.className = 'metric-positive';
            else if (headline < 0) total.className = 'metric-negative';
            card.appendChild(total);
            if (anyPart) {
                line(card, `① ${symbol} 到期结算 ${amount(point.basePnl)}`, 'stress-card-part');
            }
            if (showConvexity) {
                line(card, `${numbers.own} ${symbol} 未到期多头期权 ${amount(point.longOptionPnl)}`,
                    'stress-card-part');
            }
            if (showShorts) {
                line(card, `${numbers.shorts} ${symbol} 未到期空头期权 ${amount(point.shortOptionPnl)}`,
                    'stress-card-part');
            }
            if (showLinked) {
                line(card, `${numbers.linked} ${linkedSymbol} 多头期权较今日 ${amount(point.linkedPnl)}`,
                    'stress-card-part');
            }
            line(card, `综合成本 ${point.cost === null ? '—' : _money(point.cost, 4)}`
                + ` · ${point.shares === null ? '—' : _quantity(point.shares)} 股`);
            wrap.appendChild(card);
        });
    }

    function _renderStressChart(series, book) {
        const svg = $('stress-chart');
        const tooltip = $('stress-tooltip');
        _clear(svg);
        tooltip.hidden = true;
        const width = 960;
        const height = 470;
        const showLinkedAxis = series.linkedHedgeEnabled === true && series.linkedCount > 0;
        const margin = { top: 34, right: 92, bottom: showLinkedAxis ? 76 : 62, left: 92 };
        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const showConvexity = series.includeDeferredLongOptions && series.longOptionCount > 0;
        const showShorts = series.includeDeferredLongOptions && series.shortOptionCount > 0;
        const showLinked = series.linkedHedgeEnabled === true && series.linkedCount > 0;
        const linkedSymbol = series.linkedSymbol || '联动账本';
        const numbers = stressComponentNumbers(showConvexity, showShorts, showLinked);
        // The headline curve is the outermost overlay that is switched on.
        const headlineKey = showLinked ? 'totalPnl' : 'pnl';
        const pnlValues = series.points.map((point) => point.pnl);
        if (showConvexity || showShorts) {
            series.points.forEach((point) => pnlValues.push(point.basePnl));
        }
        if (showLinked) {
            series.points.forEach((point) => pnlValues.push(point.totalPnl));
        }
        const pnlExtent = _stressExtent(pnlValues, true);
        const costExtent = _stressExtent(series.points.map((point) => point.cost), false);
        const x = (price) => margin.left
            + ((price - series.low) / (series.high - series.low)) * plotWidth;
        const yPnl = (value) => margin.top
            + ((pnlExtent.max - value) / (pnlExtent.max - pnlExtent.min)) * plotHeight;
        const yCost = (value) => margin.top
            + ((costExtent.max - value) / (costExtent.max - costExtent.min)) * plotHeight;

        const grid = _svgNode('g', { class: 'stress-grid' });
        for (let index = 0; index <= 5; index += 1) {
            const ratio = index / 5;
            const y = margin.top + ratio * plotHeight;
            const pnlValue = pnlExtent.max - ratio * (pnlExtent.max - pnlExtent.min);
            const costValue = costExtent.max - ratio * (costExtent.max - costExtent.min);
            grid.appendChild(_svgNode('line', {
                x1: margin.left, y1: y, x2: width - margin.right, y2: y,
            }));
            grid.appendChild(_svgNode('text', {
                x: margin.left - 12, y: y + 4, 'text-anchor': 'end', class: 'axis-pnl',
            }, _compactAxisNumber(pnlValue)));
            grid.appendChild(_svgNode('text', {
                x: width - margin.right + 12, y: y + 4,
                'text-anchor': 'start', class: 'axis-cost',
            }, _money(costValue, 2)));
        }
        for (let index = 0; index <= 6; index += 1) {
            const ratio = index / 6;
            const price = series.low + ratio * (series.high - series.low);
            const xPos = x(price);
            grid.appendChild(_svgNode('line', {
                x1: xPos, y1: margin.top, x2: xPos, y2: height - margin.bottom,
            }));
            grid.appendChild(_svgNode('text', {
                x: xPos, y: height - margin.bottom + 22,
                'text-anchor': 'middle', class: 'axis-x',
            }, _money(price, 2)));
            grid.appendChild(_svgNode('text', {
                x: xPos, y: height - margin.bottom + 39,
                'text-anchor': 'middle', class: 'axis-change',
            }, `${((price / series.centerPrice) - 1) * 100 >= 0 ? '+' : ''}`
                + `${_money(((price / series.centerPrice) - 1) * 100, 0)}%`));
            if (showLinked) {
                // The index that drives the scan, read off the nearest point.
                const nearest = series.points.reduce((best, point) => (
                    Math.abs(point.price - price) < Math.abs(best.price - price) ? point : best
                ), series.points[0]);
                if (nearest && nearest.linkedPrice !== null) {
                    grid.appendChild(_svgNode('text', {
                        x: xPos, y: height - margin.bottom + 54,
                        'text-anchor': 'middle', class: 'axis-linked',
                    }, `${linkedSymbol} ${_money(nearest.linkedPrice, 0)}`
                        + ` (${nearest.linkedChangePct >= 0 ? '+' : ''}`
                        + `${_money(nearest.linkedChangePct, 1)}%)`));
                }
            }
        }
        svg.appendChild(grid);

        if (pnlExtent.min <= 0 && pnlExtent.max >= 0) {
            svg.appendChild(_svgNode('line', {
                x1: margin.left, y1: yPnl(0), x2: width - margin.right, y2: yPnl(0),
                class: 'stress-zero-line',
            }));
        }
        svg.appendChild(_svgNode('line', {
            x1: x(series.centerPrice), y1: margin.top,
            x2: x(series.centerPrice), y2: height - margin.bottom,
            class: 'stress-current-line',
        }));

        const strikes = Array.from(new Set(((state.ledger && state.ledger.openOptions) || [])
            .filter((option) => String(option.expiry || '').replace(/\D/g, '').slice(0, 8)
                <= series.throughExpiry)
            .map((option) => Number(option.strike))
            .filter((strike) => Number.isFinite(strike)
                && strike >= series.low && strike <= series.high))).sort((a, b) => a - b);
        strikes.slice(0, 14).forEach((strike, index) => {
            const xPos = x(strike);
            svg.appendChild(_svgNode('line', {
                x1: xPos, y1: margin.top, x2: xPos, y2: height - margin.bottom,
                class: 'stress-strike-line',
            }));
            svg.appendChild(_svgNode('text', {
                x: xPos + 3, y: margin.top + 11 + (index % 2) * 13,
                class: 'stress-strike-label',
            }, `K${_quantity(strike)}`));
        });

        function pathFor(key, scale) {
            let drawing = false;
            return series.points.map((point) => {
                const value = point[key];
                if (!Number.isFinite(value)) {
                    drawing = false;
                    return '';
                }
                const command = drawing ? 'L' : 'M';
                drawing = true;
                return `${command}${x(point.price).toFixed(2)},${scale(value).toFixed(2)}`;
            }).filter(Boolean).join(' ');
        }
        svg.appendChild(_svgNode('path', {
            d: pathFor(showConvexity || showShorts ? 'basePnl' : 'pnl', yPnl),
            class: `stress-pnl-line${showConvexity || showShorts || showLinked ? ' with-protection' : ''}`,
        }));
        if (showConvexity || showShorts) {
            svg.appendChild(_svgNode('path', {
                d: pathFor('pnl', yPnl),
                class: `stress-protected-pnl-line${showLinked ? ' with-linked' : ''}`,
            }));
        }
        if (showLinked) {
            svg.appendChild(_svgNode('path', {
                d: pathFor('totalPnl', yPnl), class: 'stress-linked-pnl-line',
            }));
        }
        svg.appendChild(_svgNode('path', {
            d: pathFor('cost', yCost), class: 'stress-cost-line',
        }));

        const hoverLayer = _svgNode('g', { class: 'stress-hover-points' });
        series.points.forEach((point) => {
            if (point.pnl === null && point.cost === null) return;
            const headline = point[headlineKey];
            const markerY = headline !== null && headline !== undefined
                ? yPnl(headline) : (point.pnl !== null ? yPnl(point.pnl) : yCost(point.cost));
            const circle = _svgNode('circle', {
                cx: x(point.price), cy: markerY, r: 7,
            });
            circle.appendChild(_svgNode('title', {},
                `${book.symbol} ${_money(point.price, 2)} `
                + `(${point.changePct > 0 ? '+' : ''}${_money(point.changePct, 1)}%)`
                + `${showLinked ? ` · ${linkedSymbol} ${_money(point.linkedPrice, 2)}`
                    + ` (${point.linkedChangePct > 0 ? '+' : ''}`
                    + `${_money(point.linkedChangePct, 1)}%)` : ''}\n`
                + (showConvexity || showShorts || showLinked
                    ? `① ${book.symbol} 到期结算 ${_signedMoney(point.basePnl)}\n`
                        + (showConvexity
                            ? `${numbers.own} ${book.symbol} 未到期多头期权 ${_signedMoney(point.longOptionPnl)}\n`
                            : '')
                        + (showShorts
                            ? `${numbers.shorts} ${book.symbol} 未到期空头期权 ${_signedMoney(point.shortOptionPnl)}\n`
                            : '')
                        + (showLinked
                            ? `${numbers.linked} ${linkedSymbol} 多头期权较今日 ${_signedMoney(point.linkedPnl)}\n`
                            : '')
                        + `合计 ${headline === null || headline === undefined
                            ? '—' : _signedMoney(headline)}\n`
                    : `到期结算盈亏 ${point.pnl === null ? '—' : _signedMoney(point.pnl)}\n`)
                + `综合成本/股 ${point.cost === null ? '—' : _money(point.cost, 4)}\n`                + `结算后 ${point.shares === null ? '—' : _quantity(point.shares)} 股`));
            hoverLayer.appendChild(circle);
        });
        svg.appendChild(hoverLayer);

        const guide = _svgNode('g', { class: 'stress-hover-guide' });
        guide.style.display = 'none';
        const guideLine = _svgNode('line', {
            y1: margin.top, y2: height - margin.bottom,
        });
        const pnlMarker = _svgNode('circle', {
            r: 5, class: showLinked ? 'guide-pnl guide-linked-pnl'
                : (showConvexity ? 'guide-pnl guide-protected-pnl' : 'guide-pnl'),
        });
        const basePnlMarker = _svgNode('circle', { r: 4, class: 'guide-base-pnl' });
        const ownPnlMarker = _svgNode('circle', {
            r: 4, class: showConvexity ? 'guide-own-pnl guide-protected-pnl' : 'guide-own-pnl',
        });
        const costMarker = _svgNode('circle', { r: 5, class: 'guide-cost' });
        guide.appendChild(guideLine);
        guide.appendChild(pnlMarker);
        if (showConvexity || showShorts) guide.appendChild(basePnlMarker);
        if (showLinked) guide.appendChild(ownPnlMarker);
        guide.appendChild(costMarker);
        svg.appendChild(guide);

        function hideTooltip() {
            tooltip.hidden = true;
            guide.style.display = 'none';
        }

        svg.onpointermove = (pointerEvent) => {
            const rect = svg.getBoundingClientRect();
            const svgX = ((pointerEvent.clientX - rect.left) / rect.width) * width;
            if (svgX < margin.left || svgX > width - margin.right) {
                hideTooltip();
                return;
            }
            const ratio = (svgX - margin.left) / plotWidth;
            const pointIndex = Math.max(0, Math.min(series.points.length - 1,
                Math.round(ratio * (series.points.length - 1))));
            const point = series.points[pointIndex];
            const pointX = x(point.price);
            guide.style.display = '';
            guideLine.setAttribute('x1', pointX);
            guideLine.setAttribute('x2', pointX);
            const headline = showLinked ? point.totalPnl : point.pnl;
            if (headline === null || headline === undefined) {
                pnlMarker.style.display = 'none';
            } else {
                pnlMarker.style.display = '';
                pnlMarker.setAttribute('cx', pointX);
                pnlMarker.setAttribute('cy', yPnl(headline));
            }
            if (showLinked) {
                if (point.pnl === null) {
                    ownPnlMarker.style.display = 'none';
                } else {
                    ownPnlMarker.style.display = '';
                    ownPnlMarker.setAttribute('cx', pointX);
                    ownPnlMarker.setAttribute('cy', yPnl(point.pnl));
                }
            }
            if (showConvexity || showShorts) {
                if (point.basePnl === null) {
                    basePnlMarker.style.display = 'none';
                } else {
                    basePnlMarker.style.display = '';
                    basePnlMarker.setAttribute('cx', pointX);
                    basePnlMarker.setAttribute('cy', yPnl(point.basePnl));
                }
            }
            if (point.cost === null) {
                costMarker.style.display = 'none';
            } else {
                costMarker.style.display = '';
                costMarker.setAttribute('cx', pointX);
                costMarker.setAttribute('cy', yCost(point.cost));
            }

            _text($('stress-tooltip-price'), `${book.symbol} `
                + `${_currencyAmount(book.currency, point.price, 2)}`
                + `（${point.changePct > 0 ? '+' : ''}${_money(point.changePct, 1)}%）`);
            const horizonRow = $('stress-tooltip-horizon-row');
            horizonRow.hidden = !(series.horizonDays !== null && series.horizonDays !== undefined);
            if (!horizonRow.hidden) {
                _text($('stress-tooltip-horizon'), `${_stressDateLabel(series.throughExpiry)}`
                    + `（今天 +${_money(series.horizonDays, 0)} 天，三项同日）`);
            }
            const mappedRow = $('stress-tooltip-linked-price-row');
            mappedRow.hidden = !showLinked;
            if (showLinked) {
                _text($('stress-tooltip-linked-price-label'), `${linkedSymbol} 映射价`);
                _text($('stress-tooltip-linked-price'), point.linkedPrice === null ? '—'
                    : `${_money(point.linkedPrice, 2)}（${point.linkedChangePct > 0 ? '+' : ''}`
                        + `${_money(point.linkedChangePct, 1)}%）`);
            }
            const signClass = (value) => (value > 0
                ? 'metric-positive' : (value < 0 ? 'metric-negative' : ''));
            const fill = (id, value, digits) => {
                const node = $(id);
                node.className = signClass(value);
                _text(node, value === null || value === undefined
                    ? '—' : _currencyAmount(book.currency, value, digits === undefined
                        ? 2 : digits, true));
            };
            const anyOverlay = showConvexity || showShorts || showLinked;
            // ① is always there; ② and ③ appear with their overlays; the
            // total row exists only when there is something to add up.
            _text($('stress-tooltip-base-label'), anyOverlay
                ? `① ${book.symbol} 到期结算盈亏` : '到期结算盈亏');
            fill('stress-tooltip-base-pnl', point.basePnl);
            $('stress-tooltip-long-option-pnl-row').hidden = !showConvexity;
            $('stress-tooltip-long-option-value-row').hidden = !showConvexity;
            $('stress-tooltip-long-option-iv-row').hidden = !showConvexity;
            $('stress-tooltip-long-option-rate-row').hidden = !showConvexity;
            $('stress-tooltip-short-option-pnl-row').hidden = !showShorts;
            $('stress-tooltip-short-option-liability-row').hidden = !showShorts;
            $('stress-tooltip-short-option-iv-row').hidden = !showShorts;
            // Quote the shock each side's contracts actually got: with tenor
            // damping a far-dated put takes far less than the headline number.
            const shockRange = (min, max) => {
                if (!point.ownIvShockPoints || min === null || max === null) return '';
                const sign = max > 0 ? '+' : '';
                return Math.abs(max - min) > 0.05
                    ? ` · IV ${sign}${_money(min, 1)}–${_money(max, 1)} 点（按期限）`
                    : ` · IV ${sign}${_money(max, 1)} 点`;
            };
            const ownShock = shockRange(point.longOptionIvShockMin, point.longOptionIvShockMax);
            const ownShortShock = shockRange(point.shortOptionIvShockMin, point.shortOptionIvShockMax);
            if (showConvexity) {
                _text($('stress-tooltip-long-option-pnl-label'),
                    `${numbers.own} ${book.symbol} 未到期多头期权浮动盈亏`);
                fill('stress-tooltip-long-option-pnl', point.longOptionPnl);
                _text($('stress-tooltip-long-option-value'), _currencyAmount(
                    book.currency, point.longOptionMarketValue, 2));
                _text($('stress-tooltip-long-option-iv-label'),
                    `${numbers.own} TWS IV${point.ownIvShockPoints ? '（本点含冲击）' : '（保持不变）'}`);
                _text($('stress-tooltip-long-option-iv'), _stressPercentRange(
                    point.longOptionIvMin, point.longOptionIvMax) + ownShock);
                _text($('stress-tooltip-long-option-rate'), _stressPercentRange(
                    point.longOptionRateMin, point.longOptionRateMax));
            }
            if (showShorts) {
                _text($('stress-tooltip-short-option-pnl-label'),
                    `${numbers.shorts} ${book.symbol} 未到期空头期权（已收权利金 − 负债）`);
                fill('stress-tooltip-short-option-pnl', point.shortOptionPnl);
                _text($('stress-tooltip-short-option-liability-label'),
                    `${numbers.shorts} 负债市值`);
                _text($('stress-tooltip-short-option-liability'), _currencyAmount(
                    book.currency, point.shortOptionLiability, 2));
                _text($('stress-tooltip-short-option-iv-label'),
                    `${numbers.shorts} TWS IV`);
                _text($('stress-tooltip-short-option-iv'), _stressPercentRange(
                    point.shortOptionIvMin, point.shortOptionIvMax) + ownShortShock);
            }
            $('stress-tooltip-linked-pnl-row').hidden = !showLinked;
            $('stress-tooltip-linked-value-row').hidden = !showLinked;
            $('stress-tooltip-linked-iv-row').hidden = !showLinked;
            $('stress-tooltip-linked-premium-row').hidden = !showLinked;

            if (showLinked) {
                _text($('stress-tooltip-linked-pnl-label'),
                    `${numbers.linked} ${linkedSymbol} 多头期权较今日变动`);
                fill('stress-tooltip-linked-pnl', point.linkedPnl);
                _text($('stress-tooltip-linked-value-label'),
                    `${linkedSymbol} 多头期权 情景市值 / 今日市值`);
                _text($('stress-tooltip-linked-value'), `${_currencyAmount(
                    book.currency, point.linkedMarketValue, 0)} / ${_currencyAmount(
                    book.currency, point.linkedReferenceValue, 0)}`);
                _text($('stress-tooltip-linked-iv-label'), `${linkedSymbol} 多头期权 IV`
                    + (series.linkedIvMode === 'none' ? '（保持不变）' : '（本点含冲击）'));
                _text($('stress-tooltip-linked-iv'), point.linkedDeferredContracts
                    ? _stressPercentRange(point.linkedIvMin, point.linkedIvMax)
                        + (series.linkedIvMode !== 'none'
                            ? (series.linkedIvTenorDamping
                                && point.linkedIvShockPointsMin !== null
                                && Math.abs(point.linkedIvShockPointsMax
                                    - point.linkedIvShockPointsMin) > 0.05
                                ? ` · +${_money(point.linkedIvShockPointsMin, 1)}`
                                    + `–${_money(point.linkedIvShockPointsMax, 1)} 点（按期限）`
                                : ` · ${point.linkedIvShockPoints > 0 ? '+' : ''}`
                                    + `${_money(point.linkedIvShockPoints, 1)} 点`)
                            : '')
                    : '全部按内在价值');

                _text($('stress-tooltip-linked-premium-label'),
                    `${linkedSymbol} 多头期权较买入权利金（参考，不计入合计）`);
                fill('stress-tooltip-linked-premium', point.linkedPremiumPnl);
            }
            $('stress-tooltip-total-row').hidden = !anyOverlay;
            if (anyOverlay) {
                _text($('stress-tooltip-pnl-label'), `合计 ${numbers.total}`);
                fill('stress-tooltip-pnl', headline === undefined ? null : headline);
            }
            _text($('stress-tooltip-cost'), point.cost === null
                ? '—' : _currencyAmount(book.currency, point.cost, 4));
            _text($('stress-tooltip-shares'), point.shares === null
                ? '—' : `${_quantity(point.shares)} 股`);
            _text($('stress-tooltip-outcome'),
                `${_quantity(point.assignedContracts)} 张指派 · `
                + `${_quantity(point.exercisedContracts)} 张行权 · `
                + `${_quantity(point.expiredContracts)} 张归零`);

            tooltip.hidden = false;
            const wrap = tooltip.parentElement;
            const wrapRect = wrap.getBoundingClientRect();
            const pointerLeft = pointerEvent.clientX - wrapRect.left + wrap.scrollLeft;
            const visibleLeft = wrap.scrollLeft;
            let left = pointerLeft + 16;
            if (left + 318 > visibleLeft + wrap.clientWidth) left = pointerLeft - 326;
            left = Math.max(visibleLeft + 8,
                Math.min(left, visibleLeft + wrap.clientWidth - 318));
            const pointerTop = pointerEvent.clientY - wrapRect.top + wrap.scrollTop;
            const visibleTop = wrap.scrollTop;
            const top = Math.max(visibleTop + 8,
                Math.min(pointerTop - 72,
                    visibleTop + wrap.clientHeight - tooltip.offsetHeight - 8));
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        };
        svg.onpointerleave = hideTooltip;
        svg.appendChild(_svgNode('text', {
            x: 18, y: margin.top + plotHeight / 2,
            transform: `rotate(-90 18 ${margin.top + plotHeight / 2})`,
            'text-anchor': 'middle', class: 'stress-axis-title axis-pnl',
        }, `到期后盈亏（${_currencySymbol(book.currency)}）`));
        svg.appendChild(_svgNode('text', {
            x: width - 18, y: margin.top + plotHeight / 2,
            transform: `rotate(90 ${width - 18} ${margin.top + plotHeight / 2})`,
            'text-anchor': 'middle', class: 'stress-axis-title axis-cost',
        }, `综合成本 / 股（${_currencySymbol(book.currency)}）`));
    }

    function _renderStressTest() {
        if (!state.stressOpen) return;
        const book = _currentBook();
        const expiries = _renderStressExpiryOptions();
        const baseInput = $('stress-base-price');
        const refreshButton = $('btn-stress-refresh-price');
        refreshButton.disabled = state.stressInputsPending
            || state.connection !== 'connected';
        refreshButton.textContent = state.stressInputsPending
            ? '拉取中…' : '刷新 TWS 现价与期权参数';
        if (!book || !state.ledger || !expiries.length) {
            _text($('stress-status'), '当前账本没有可用于压力测试的未平股票期权。');
            _clear($('stress-chart'));
            _clear($('stress-key-points'));
            return;
        }
        if (globalScope.document.activeElement !== baseInput) {
            baseInput.value = state.stressBasePrice === null
                ? '' : String(state.stressBasePrice);
        }
        $('stress-range').value = String(state.stressRangePct);
        const protectionToggle = $('stress-include-long-options');
        const protectionInputs = $('stress-protection-inputs');
        protectionToggle.checked = state.stressIncludeLongOptions;
        protectionInputs.hidden = !state.stressIncludeLongOptions;
        const liveInputs = state.stressLongOptionInputs;
        _text($('stress-option-iv-source'), state.stressInputsPending
            ? '逐合约 TWS IV：正在拉取…'
            : (liveInputs
                ? `逐合约 TWS IV：${_quantity((liveInputs.options || []).filter(
                    (item) => Number(item.impliedVolatility) > 0).length)} 张已取得`
                    + (marketDataTypeLabel(liveInputs.options)
                        ? `（${marketDataTypeLabel(liveInputs.options)}）` : '')
                : `逐合约 TWS IV：${state.stressInputsError || '尚未拉取'}`));
        const liveRates = liveInputs && Array.isArray(liveInputs.ratesByExpiry)
            ? liveInputs.ratesByExpiry : [];
        _text($('stress-option-rate-source'), state.stressInputsPending
            ? '期限无风险利率：正在读取最近共享曲线…'
            : (liveRates.length
                ? `期限无风险利率：共享曲线 ${liveInputs.curveEffectiveDate
                    || liveInputs.curveAsOf || '日期未知'}`
                : (liveInputs
                    ? `期限无风险利率：不可用·${liveInputs.curveError
                        || liveInputs.curveStatus || '最近曲线无法覆盖该期限'}`
                    : `期限无风险利率：${state.stressInputsError
                        || '尚未读取'}`)));
        _text($('stress-title'), `${book.symbol} · 到期压力测试`);
        const horizonInput = $('stress-horizon-days');
        if (globalScope.document.activeElement !== horizonInput) {
            horizonInput.value = state.stressHorizonDays === null
                || state.stressHorizonDays === undefined
                ? '' : String(state.stressHorizonDays);
        }
        const scenario = _stressScenarioDate();
        $('stress-liquidation').value = state.stressLiquidation;
        $('stress-pricing-model').value = state.stressPricingModel;
        const yieldInput = $('stress-dividend-yield');
        if (globalScope.document.activeElement !== yieldInput) {
            yieldInput.value = state.stressDividendYield === null
                || state.stressDividendYield === undefined
                ? '' : String(Math.round(state.stressDividendYield * 10000) / 100);
        }
        yieldInput.placeholder = `${_money(_effectiveDividendYield(null, book.symbol) * 100, 2)}`;
        _text($('stress-own-note'), _ownValuationNote(book));
        _renderStressLinkedControls(book);
        const linkedBook = _stressLinkedBook();
        const linkedSymbol = linkedBook ? linkedBook.symbol : '联动账本';
        if (scenario.error) {
            _text($('stress-status'), '跌到位天数无效：请留空（在所选到期日结算）'
                + `或输入 0 到 ${LINKED_MAX_HORIZON_DAYS} 的整数天。`);
            _clear($('stress-chart'));
            _clear($('stress-key-points'));
            return;
        }
        const series = buildStressTestSeries(state.allEvents, {
            symbol: book.symbol,
            currency: book.currency || 'USD',
            centerPrice: state.stressBasePrice,
            rangePct: state.stressRangePct,
            pointCount: 61,
            throughExpiry: scenario.date,
            basisMode: state.basisMode,
            secType: book.secType || 'STK',
            includeDeferredLongOptions: state.stressIncludeLongOptions,
            longOptionInputs: state.stressLongOptionInputs,
            linkedHedge: _stressLinkedHedgeRequest(),
            liquidation: state.stressLiquidation,
            pricingModel: state.stressPricingModel,
            dividendYield: _effectiveDividendYield(state.stressDividendYield, book.symbol),
        });
        series.horizonDays = scenario.horizonDays;
        if (!series.available) {
            let failure = '当前期权资料不完整，无法生成压力测试。';
            if (series.reason === 'invalid_center_price') {
                failure = '请输入大于 0 的基准现价，或连接 TWS 后刷新现价。';
            } else if (series.reason === 'missing_long_option_market_inputs') {
                failure = state.stressInputsPending
                    ? '正在从 TWS 拉取逐合约 IV 和共享利率曲线…'
                    : `尚无可用的实时期权参数。${state.stressInputsError || '请点击刷新。'}`;
            } else if (series.reason === 'missing_long_option_iv') {
                failure = '至少一张未到期 Long Call / Put 没有取得 TWS 当前 IV，已停止叠加，不使用统一假设值。';
            } else if (series.reason === 'missing_discount_rate') {
                failure = '共享 USD 折现曲线无法覆盖至少一个剩余期限，已停止叠加。';
            } else if (series.reason === 'missing_short_option_market_inputs') {
                failure = state.stressInputsPending
                    ? '正在从 TWS 拉取逐合约 IV 和共享利率曲线…'
                    : `尚无可用的实时期权参数，无法盯市情景日后仍未到期的空头期权。${state.stressInputsError || '请点击刷新。'}`;
            } else if (series.reason === 'missing_short_option_iv') {
                failure = '至少一张情景日仍未到期的 Short Call / Put 没有取得 TWS 当前 IV，无法盯市其负债，已停止叠加。'
                    + '若后端是旧版本（只回传多头持仓），请真正重启 ib_server.py。';
            } else if (series.reason === 'incomplete_short_option') {
                failure = '至少一张情景日仍未到期的空头期权资料不完整（行权价、张数、乘数或开仓权利金缺失，或身份冲突），已停止叠加。';
            } else if (series.reason === 'short_option_identity_mismatch') {
                failure = '至少一张本账本空头期权的账本 conId / localSymbol 与 TWS 快照不一致'
                    + '（快照里只有同条款的另一张合约），已停止叠加，请核对账本合约身份。';
            } else if (series.reason === 'invalid_long_option_iv_shock'
                || series.reason === 'invalid_short_option_iv_shock') {
                failure = '按联动 β 放大后本账本至少一张合约的 IV 不大于 0，请调低 β 或 IV 冲击。';
            } else if (series.reason === 'invalid_linked_mapping') {
                failure = '映射方式无效，请重新选择。';
            } else if (series.reason === 'missing_linked_sigma') {
                failure = `复利映射在情景日晚于今天时需要路径波动率，但 ${linkedSymbol} 快照里没有`
                    + '情景日之后仍存续、可作代理的合约。请在「路径 σ」填入年化波动率，或改用线性映射。';
            } else if (series.reason === 'missing_long_option_quote_sides'
                || series.reason === 'missing_short_option_quote_sides') {
                failure = '买卖价口径需要每张本账本合约都有 TWS 买价与卖价，至少一张缺失，已停止叠加。改回中间价或刷新。';
            } else if (series.reason === 'invalid_long_option_bid_ask'
                || series.reason === 'invalid_short_option_bid_ask') {
                failure = '本账本至少一张合约的 TWS 买价高于卖价（交叉报价，通常是两侧 tick 不同步），'
                    + '点差折算口径拒绝使用，已停止叠加。请刷新或改回中间价。';
            } else if (series.reason === 'invalid_linked_bid_ask') {
                failure = `${linkedSymbol} 账本至少一张合约的 TWS 买价高于卖价（交叉报价），`
                    + '点差折算口径拒绝使用，已停止叠加。请刷新或改回中间价。';
            } else if (series.reason === 'missing_linked_quote_sides') {
                failure = `买卖价口径需要 ${linkedSymbol} 账本每张合约都有 TWS 买价，至少一张缺失，已停止叠加。改回中间价或刷新。`;
            } else if (series.reason === 'missing_american_pricer') {
                failure = '美式二叉树定价模块未加载（js/american_binomial.js），请刷新页面或改用欧式。';
            } else if (series.reason === 'invalid_dividend_yield'
                || series.reason === 'invalid_linked_dividend_yield') {
                failure = '股息率无效：请留空（用标的默认值）或输入 0 到 50 之间的年化百分比。';
            } else if (series.reason === 'invalid_liquidation'
                || series.reason === 'invalid_pricing_model') {
                failure = '变现口径或定价模型无效，请重新选择。';
            } else if (series.reason === 'invalid_linked_sigma') {
                failure = '路径波动率无效：请留空（用快照代理）或输入 0 到 500 之间的年化百分比。';
            } else if (series.reason === 'missing_linked_book') {
                failure = !state.stressLinkedBookId
                    ? '请选择要叠加的联动账本，或取消勾选跨账本叠加。'
                    : (state.stressLinkedEventsPending
                        ? `正在读取 ${linkedSymbol} 账本事件…`
                        : `${linkedSymbol} 账本尚未载入。${state.stressLinkedEventsError
                            || '请点击刷新。'}`);
            } else if (series.reason === 'invalid_linked_ratio') {
                failure = '映射比率无效：请输入绝对值不小于 0.01 的数字（TQQQ ↔ QQQ 通常为 3）。';
            } else if (series.reason === 'missing_linked_market_inputs') {
                failure = state.stressLinkedInputsPending
                    ? `正在从 TWS 拉取 ${linkedSymbol} 逐合约 IV 和共享利率曲线…`
                    : `${linkedSymbol} 账本尚无可用的实时期权参数。${state.stressLinkedInputsError
                        || '请点击刷新。'}`;
            } else if (series.reason === 'missing_linked_option_iv') {
                failure = `${linkedSymbol} 账本至少一张未到期 Long Call / Put 没有取得 TWS 当前 IV，`
                    + '已停止叠加，不使用统一假设值。';
            } else if (series.reason === 'missing_linked_discount_rate') {
                failure = `共享 USD 折现曲线无法覆盖 ${linkedSymbol} 账本至少一个剩余期限，已停止叠加。`;
            } else if (series.reason === 'incomplete_linked_option') {
                failure = `${linkedSymbol} 账本至少一张多头期权资料不完整`
                    + '（行权价、张数、乘数或开仓权利金缺失，或存在身份冲突），已停止叠加。';
            } else if (series.reason === 'invalid_linked_underlying_price') {
                failure = `${linkedSymbol} 现价无效，无法映射价格。请点击刷新。`;
            } else if (series.reason === 'invalid_linked_iv_beta') {
                failure = `IV 跌幅联动系数无效：请输入 0 到 ${LINKED_IV_MAX_BETA} 之间的数字`
                    + '（每跌 1% 抬升多少个 IV 百分点，NDX 历史量级约 1 到 1.5）。';
            } else if (series.reason === 'invalid_linked_iv_mode') {
                failure = 'IV 模式无效，请重新选择。';
            } else if (series.reason === 'linked_currency_mismatch') {
                failure = `${linkedSymbol} 账本币种与本账本不同，两本账本的盈亏不能直接相加，已停止叠加。`;
            } else if (series.reason === 'long_option_identity_mismatch') {
                failure = '至少一张本账本多头期权的账本 conId / localSymbol 与 TWS 快照不一致'
                    + '（快照里只有同条款的另一张合约），已停止叠加，请核对账本合约身份。';
            } else if (series.reason === 'linked_option_identity_mismatch') {
                failure = `${linkedSymbol} 账本至少一张多头期权的 conId / localSymbol 与 TWS 快照不一致`
                    + '（快照里只有同条款的另一张合约），已停止叠加，请核对账本合约身份。';
            } else if (series.reason === 'invalid_linked_tenor_days') {
                failure = `参考期限无效：请输入 1 到 ${LINKED_MAX_HORIZON_DAYS} 天（β 所描述的 IV 期限，通常 30）。`;
            } else if (series.reason === 'invalid_linked_iv_shock') {
                failure = 'IV 冲击无效：请输入 −500 到 +500 之间的点数（10 表示 IV 抬升 10 个百分点），'
                    + '且冲击后每张合约的 IV 必须大于 0。';
            } else if (series.reason === 'missing_linked_mark') {
                failure = `${linkedSymbol} 账本至少一张多头期权没有取得 TWS 当前标记价，`
                    + '无法计算相对今日的变动，已停止叠加。';
            }
            _text($('stress-status'), failure);
            _clear($('stress-chart'));
            _clear($('stress-key-points'));
            return;
        }
        const currency = book.currency || 'USD';
        const showConvexity = Boolean(series.includeDeferredLongOptions
            && series.longOptionCount);
        const showShorts = Boolean(series.includeDeferredLongOptions
            && series.shortOptionCount);
        const showOwn = showConvexity || showShorts;
        const showLinked = series.linkedHedgeEnabled === true && series.linkedCount > 0;
        // Every curve is named by the numbered components it adds up, and
        // every surface takes its numbers from the same mapping.
        const numbers = stressComponentNumbers(showConvexity, showShorts, showLinked);
        const ownParts = [numbers.own, numbers.shorts].filter(Boolean).join('+');
        $('stress-legend-base-pnl').textContent = showOwn || showLinked
            ? `① ${book.symbol} 到期结算盈亏（左轴）` : '到期结算盈亏（左轴）';
        $('stress-legend-protected-pnl').hidden = !showOwn;
        _text($('stress-legend-protected-pnl'),
            `①+${ownParts} 计入 ${book.symbol} 未到期期权（左轴）`);
        $('stress-legend-linked-pnl').hidden = !showLinked;
        _text($('stress-legend-linked-pnl'),
            `${numbers.total} 计入 ${series.linkedSymbol || linkedSymbol}`
            + ' 多头期权较今日变动（左轴）');
        const ownShockNote = showLinked && series.linkedIvMode !== 'none' && showOwn
            ? `，IV 冲击随 ${series.linkedSymbol} β 按 ${_money(Math.abs(series.linkedRatio), 2)}× 放大`
            : '';
        const sigmaNote = (() => {
            if (series.linkedSigmaSource === 'instant') return '，情景日为今日，无路径损耗';
            if (series.linkedSigmaSource === 'none') return '';
            const origin = series.linkedSigmaSource === 'assumption' ? '（假设）'
                : `（快照代理：最近 ATM 合约 K${_quantity(series.linkedSigmaProxyStrike)}`
                    + `，距现价 ${_money(series.linkedSigmaProxyDistancePct, 1)}%`
                    + `${series.linkedSigmaSource === 'proxy_far' ? '，⚠ 离 ATM 较远' : ''}）`;
            return `，路径 σ ${_money((series.linkedSigma || 0) * 100, 1)}%${origin}`
                + `，${_money(series.linkedTimeYears * 365, 0)} 天损耗 ${_money(
                    series.linkedDragLog * 100, 2)}%`;
        })();
        const mappingNote = series.linkedMapping === 'linear' ? '线性' : `复利${sigmaNote}`;
        const linkedParts = [];
        if (showLinked && series.linkedCallContracts) {
            linkedParts.push(`${_quantity(series.linkedCallContracts)} 张 Long Call`);
        }
        if (showLinked && series.linkedPutContracts) {
            linkedParts.push(`${_quantity(series.linkedPutContracts)} 张 Long Put`);
        }
        const linkedSummary = !series.linkedHedgeEnabled ? ''
            : (showLinked
                ? ` · ${numbers.linked} 已叠加 ${series.linkedSymbol} 账本 ${linkedParts.join(' + ')}`
                    + `（映射 1 : ${_money(series.linkedRatio, 2)} ${mappingNote}`
                    + ` · ${series.linkedSymbol} 基准 ${_currencyAmount(
                        linkedBook && linkedBook.currency || 'USD', series.linkedBasePrice, 2)}`
                    + ` · 今日标记市值 ${_currencyAmount(
                        linkedBook && linkedBook.currency || 'USD', series.linkedReferenceValue, 0)}`
                    + (series.linkedDeferredContracts
                        ? ` · TWS IV ${_stressPercentRange(series.linkedIvMin, series.linkedIvMax)}`
                            + (series.linkedIvMode === 'fixed' && series.linkedIvShockPoints
                                ? `（已含固定 IV 冲击 ${series.linkedIvShockPoints > 0 ? '+' : ''}`
                                    + `${_money(series.linkedIvShockPoints, 0)} 点）`
                                : (series.linkedIvMode === 'beta'
                                    ? `（基准点；每跌 1% IV +${_money(series.linkedIvBeta, 2)} 点`
                                        + (series.linkedIvTenorDamping
                                            ? `，按期限衰减 √(${_money(series.linkedIvTenorDays, 0)}/剩余天)`
                                            : '')
                                        + '，上涨侧不变）'
                                    : ''))
                        : ' · 全部按内在价值结算')
                    + '）'
                : ` · ${series.linkedSymbol || linkedSymbol} 账本没有未平多头期权可叠加`);
        const longOptionParts = [];
        if (series.longCallContracts) {
            longOptionParts.push(`${_quantity(series.longCallContracts)} 张 Long Call`);
        }
        if (series.longPutContracts) {
            longOptionParts.push(`${_quantity(series.longPutContracts)} 张 Long Put`);
        }
        const shortOptionParts = [];
        if (series.shortCallContracts) {
            shortOptionParts.push(`${_quantity(series.shortCallContracts)} 张 Short Call`);
        }
        if (series.shortPutContracts) {
            shortOptionParts.push(`${_quantity(series.shortPutContracts)} 张 Short Put`);
        }
        const dateLead = scenario.horizonDays === null
            ? `${_stressDateLabel(series.throughExpiry)} 到期后`
            : `${_stressDateLabel(series.throughExpiry)} 情景日`
                + `（今天 +${_money(scenario.horizonDays, 0)} 天，含 Theta，覆盖到期范围；`
                + '三项同日估值）';
        _text($('stress-status'), dateLead
            + ` · 基准 ${_currencyAmount(currency, series.centerPrice, 4)}`
            + ` · 扫描 ±${_money(series.rangePct, 0)}%`
            + ` · ${BASIS_LABELS[series.basisMode] || series.basisMode}口径`
            + ` · ${series.pricingModel === 'american' ? '美式二叉树' : '欧式 BSM'}`
            + `（${book.symbol} 股息率 ${_money((series.dividendYield || 0) * 100, 2)}%`
            + (series.linkedHedgeEnabled && series.linkedDividendYield !== null
                ? `，${series.linkedSymbol} ${_money((series.linkedDividendYield || 0) * 100, 2)}%` : '')
            + '）'
            + (series.liquidation === 'bidask' ? ' · 变现口径：买卖价（多头按买价、空头按卖价折算）' : '')
            + (showOwn || showLinked ? ` · ① ${book.symbol} 到期结算` : '')
            + (series.includeDeferredLongOptions
                ? (series.longOptionCount
                    ? ` · ${numbers.own} 已计入 ${longOptionParts.join(' + ')}`
                        + `（逐合约 TWS IV ${_stressPercentRange(
                            series.longOptionIvMin, series.longOptionIvMax)}`
                        + `，曲线 r(T) ${_stressPercentRange(
                            series.longOptionRateMin, series.longOptionRateMax)}${ownShockNote}）`
                    : '')
                    + (series.shortOptionCount
                        ? ` · ${numbers.shorts} 已盯市 ${shortOptionParts.join(' + ')} 的负债`
                            + `（逐合约 TWS IV ${_stressPercentRange(
                                series.shortOptionIvMin, series.shortOptionIvMax)}`
                            + `，已收权利金已计入${ownShockNote}）`
                        : '')
                    + (!series.longOptionCount && !series.shortOptionCount
                        ? ' · 情景日之后没有仍未到期的期权' : '')
                : '')
            + linkedSummary);
        _renderStressChart(series, book);
        _renderStressCards(series, currency);
    }

    function _openStressTest() {
        const book = _currentBook();
        if (!book || !state.ledger) return;
        state.stressOpen = true;
        state.stressExpiry = state.whatIfExpiry;
        state.stressHorizonDays = null;
        state.stressBasePrice = _stressReferencePrice();
        _restoreStressLinkedChoice(book);
        $('stress-modal').hidden = false;
        globalScope.document.body.classList.add('stress-modal-open');
        _renderStressTest();
        $('stress-expiry').focus();
        if (state.stressIncludeLongOptions) {
            _refreshStressMarketInputs(false);
        }
        _ensureStressLinkedData(false);
    }

    function _closeStressTest() {
        if (!state.stressOpen) return;
        state.stressOpen = false;
        globalScope.clearTimeout(state.stressHorizonTimer);
        state.stressHorizonTimer = null;
        $('stress-modal').hidden = true;
        globalScope.document.body.classList.remove('stress-modal-open');
        $('btn-open-stress-test').focus();
    }

    /**
     * One-shot TWS snapshot for this book. The request is pinned to the book,
     * the scenario date and a generation captured up front; a newer request
     * simply supersedes it, and a response that arrives after any of those
     * moved on is dropped rather than written into the wrong scenario.
     */
    async function _refreshStressMarketInputs(showAlert) {
        const scenario = _stressScenarioDate();
        const bookId = state.bookId;
        const throughExpiry = scenario.date;
        if (!bookId || !throughExpiry) return;
        if (!state.status || !state.status.features
            || state.status.features.optionScenarioInputs !== true) {
            state.stressLongOptionInputs = null;
            state.stressInputsError = '当前运行的后端未加载期权情景接口。'
                + '请真正重启 ib_server.py（仅刷新页面无效）后再试。';
            _renderStressTest();
            if (showAlert) globalScope.alert(state.stressInputsError);
            return;
        }
        state.stressInputsGeneration += 1;
        const generation = state.stressInputsGeneration;
        const socket = state.ws;
        const contracts = _stressLongOptionRequests();
        state.stressInputsPending = true;
        state.stressInputsError = '';
        state.stressLongOptionInputs = null;
        _renderStressTest();
        const isCurrent = () => state.bookId === bookId
            && state.ws === socket
            && state.stressInputsGeneration === generation
            && _stressScenarioDate().date === throughExpiry;
        try {
            const response = await request('request_cost_basis_option_scenario_inputs', {
                bookId,
                throughExpiry,
                contracts,
            });
            if (!isCurrent()) return;
            const price = Number(response.underlyingPrice);
            if (!Number.isFinite(price) || price <= 0) {
                throw new Error('TWS 返回的标的现价无效');
            }
            state.stressLongOptionInputs = response;
            state.marketPrice = price;
            state.marketPriceFetchedAt = String(response.fetchedAt || '');
            state.stressBasePrice = price;
            _recompute();
        } catch (error) {
            if (!isCurrent()) return;
            state.stressLongOptionInputs = null;
            if (error.code === 'broker_option_scenario_inputs_unavailable') {
                state.stressInputsError = '当前后端不支持 TWS 期权参数快照。';
            } else if (error.code === 'broker_option_scenario_inputs_timeout') {
                state.stressInputsError = 'TWS 期权参数在 15 秒内未完成，'
                    + '服务器已终止请求，没有继续后台等待。';
            } else {
                state.stressInputsError = `拉取失败：${error.message}`;
            }
            if (showAlert) {
                globalScope.alert(state.stressInputsError);
            }
        } finally {
            // A superseded request must not clear the newer one's pending flag.
            if (isCurrent()) {
                state.stressInputsPending = false;
                _renderStressTest();
            }
        }
    }

    async function _refreshStressPrice() {
        await _refreshStressMarketInputs(true);
        if (state.stressIncludeLinkedHedge && state.stressLinkedBookId) {
            await _loadStressLinkedEvents(true);
        }
    }

    // ------------------------------------------------------------------
    // Linked book (cross-book protection) data
    // ------------------------------------------------------------------

    /** The own-book valuation note, generated from the controls in force. */
    function _ownValuationNote(book) {
        const model = state.stressPricingModel === 'european'
            ? '欧式 BSM' : `美式 CRR 二叉树（${AMERICAN_BINOMIAL_STEPS} 步）`;
        const dividend = state.stressDividendYield === null || state.stressDividendYield === undefined
            ? `标的默认股息率${book ? `（${book.symbol} ${_money(
                _effectiveDividendYield(null, book.symbol) * 100, 2)}%）` : ''}`
            : `股息率 ${_money(Number(state.stressDividendYield) * 100, 2)}%`;
        const lens = state.stressLiquidation === 'bidask'
            ? '按今日点差折算：多头理论价 × 今日买价/中间价，空头理论价 × 今日卖价/中间价；交叉或单边报价拒绝'
            : '中间价：理论价按 TWS 中间价口径计';
        return `${model} · 每张合约用它当前的 TWS IV · 无风险利率按情景日到到期日的期限从共享 USD 折现曲线解析`
            + ` · ACT/365 · ${dividend} · ${lens}。这是情景估值，不是对情景日报价的预测。`;
    }

    function _stressLinkedBookCandidates(book) {
        if (!book) return [];
        const account = String(book.account || '');
        const currency = String(book.currency || 'USD').toUpperCase();
        return state.books.filter((candidate) => (
            candidate.bookId !== book.bookId
            && String(candidate.account || '') === account
            && String(candidate.secType || 'STK').toUpperCase() === 'STK'
            && String(candidate.currency || 'USD').toUpperCase() === currency
        )).sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)));
    }

    function _stressLinkedBook() {
        return state.books.find((book) => book.bookId === state.stressLinkedBookId) || null;
    }

    function _readStressLinkedMemory(bookId) {
        const raw = _readStorage(STRESS_LINKED_STORAGE_PREFIX + String(bookId || ''), '');
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    function _writeStressLinkedMemory() {
        if (!state.bookId) return;
        try {
            globalScope.localStorage.setItem(
                STRESS_LINKED_STORAGE_PREFIX + state.bookId, JSON.stringify({
                    enabled: state.stressIncludeLinkedHedge,
                    linkedBookId: state.stressLinkedBookId,
                    ratio: state.stressLinkedRatio,
                    ivMode: state.stressLinkedIvMode,
                    ivShockPoints: state.stressLinkedIvShockPoints,
                    ivBeta: state.stressLinkedIvBeta,
                    ivTenorDamping: state.stressLinkedIvTenorDamping,
                    ivTenorDays: state.stressLinkedIvTenorDays,
                    mapping: state.stressLinkedMapping,
                    sigma: state.stressLinkedSigma,
                    dividendYield: state.stressLinkedDividendYield,
                }));
        } catch (_) {
            // Remembering the choice is a convenience, never a requirement.
        }
    }

    /** Drop every snapshot that was keyed to the previous scenario date. */
    function _invalidateStressScenarioInputs() {
        state.stressInputsGeneration += 1;
        state.stressLongOptionInputs = null;
        state.stressInputsPending = false;
        state.stressInputsError = '';
        // The linked ledger survives; its IV snapshot is tied to the date.
        state.stressLinkedInputsGeneration += 1;
        state.stressLinkedInputs = null;
        state.stressLinkedInputsPending = false;
        state.stressLinkedInputsError = '';
    }

    function _clearStressLinkedData() {
        state.stressLinkedLoadGeneration += 1;
        state.stressLinkedInputsGeneration += 1;
        state.stressLinkedEvents = [];
        state.stressLinkedLedger = null;
        state.stressLinkedEventsPending = false;
        state.stressLinkedEventsError = '';
        state.stressLinkedInputs = null;
        state.stressLinkedInputsPending = false;
        state.stressLinkedInputsError = '';
    }

    function _restoreStressLinkedChoice(book) {
        const choice = chooseLinkedBook(book, _stressLinkedBookCandidates(book),
            _readStressLinkedMemory(book.bookId));
        if (choice.bookId !== state.stressLinkedBookId) _clearStressLinkedData();
        state.stressLinkedBookId = choice.bookId;
        state.stressLinkedRatio = choice.ratio;
        state.stressLinkedIvMode = choice.ivMode;
        state.stressLinkedIvShockPoints = choice.ivShockPoints;
        state.stressLinkedIvBeta = choice.ivBeta;
        state.stressLinkedIvTenorDamping = choice.ivTenorDamping;
        state.stressLinkedIvTenorDays = choice.ivTenorDays;
        state.stressLinkedMapping = choice.mapping;
        state.stressLinkedSigma = choice.sigma;
        state.stressLinkedDividendYield = choice.dividendYield;
        state.stressIncludeLinkedHedge = choice.enabled && Boolean(choice.bookId);
    }

    /**
     * Pull the linked book's events in the background and build its ledger
     * on the side. Nothing here touches state.allEvents or state.ledger; the
     * current book keeps its own view while the sibling is read.
     */
    async function _loadStressLinkedEvents(showAlert) {
        const linkedBookId = state.stressLinkedBookId;
        const mainBookId = state.bookId;
        if (!linkedBookId || !mainBookId) return;
        state.stressLinkedLoadGeneration += 1;
        state.stressLinkedInputsGeneration += 1;
        const generation = state.stressLinkedLoadGeneration;
        state.stressLinkedEventsPending = true;
        state.stressLinkedEventsError = '';
        state.stressLinkedEvents = [];
        state.stressLinkedLedger = null;
        state.stressLinkedInputs = null;
        state.stressLinkedInputsPending = false;
        state.stressLinkedInputsError = '';
        _renderStressTest();
        const isCurrent = () => state.bookId === mainBookId
            && state.stressLinkedBookId === linkedBookId
            && state.stressLinkedLoadGeneration === generation;
        try {
            const collected = [];
            let offset = 0;
            let total = 0;
            for (;;) {
                const response = await request('list_cost_basis_events', {
                    bookId: linkedBookId,
                    limit: LEDGER_FETCH_SIZE,
                    offset,
                    includeVoided: true,
                });
                if (!isCurrent()) return;
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
                    throw new Error(`联动账本超过 ${MAX_LEDGER_EVENTS} 条，已放弃叠加`);
                }
            }
            state.stressLinkedEvents = collected;
            state.stressLinkedLedger = core.computeLedger(collected, { secType: 'STK' });
        } catch (error) {
            if (!isCurrent()) return;
            state.stressLinkedEventsError = `读取失败：${error.message}`;
            if (showAlert) globalScope.alert(`联动账本${state.stressLinkedEventsError}`);
        } finally {
            if (isCurrent()) {
                state.stressLinkedEventsPending = false;
                _renderStressTest();
            }
        }
        if (isCurrent() && state.stressLinkedLedger && state.stressIncludeLinkedHedge) {
            await _refreshStressLinkedInputs(showAlert);
        }
    }

    /**
     * Second call of the same one-shot TWS snapshot endpoint, scoped to the
     * linked book. The server resolves account and symbol from that book and
     * only quotes identities that are real long positions there, so QQQ
     * contracts are never valued under the TQQQ book by accident.
     */
    async function _refreshStressLinkedInputs(showAlert) {
        const linkedBookId = state.stressLinkedBookId;
        const mainBookId = state.bookId;
        const throughExpiry = _stressScenarioDate().date;
        if (!mainBookId || !linkedBookId || !throughExpiry || !state.stressLinkedLedger) return;
        if (!state.status || !state.status.features
            || state.status.features.optionScenarioInputs !== true) {
            state.stressLinkedInputs = null;
            state.stressLinkedInputsError = '当前运行的后端未加载期权情景接口。'
                + '请真正重启 ib_server.py（仅刷新页面无效）后再试。';
            _renderStressTest();
            if (showAlert) globalScope.alert(state.stressLinkedInputsError);
            return;
        }
        state.stressLinkedInputsGeneration += 1;
        const generation = state.stressLinkedInputsGeneration;
        // Every long contract still alive today needs a quote: the mark is
        // the reference value, and contracts that expire between today and
        // the stress date still settle at intrinsic against it. Resolve the
        // list now, before any render can normalise the selected expiry.
        const contracts = _deferredLongOptionRequests(
            state.stressLinkedLedger.openOptions, _todayDigits());
        state.stressLinkedInputsPending = true;
        state.stressLinkedInputsError = '';
        state.stressLinkedInputs = null;
        _renderStressTest();
        const isCurrent = () => state.bookId === mainBookId
            && state.stressLinkedBookId === linkedBookId
            && _stressScenarioDate().date === throughExpiry
            && state.stressLinkedInputsGeneration === generation;
        try {
            const response = await request('request_cost_basis_option_scenario_inputs', {
                bookId: linkedBookId,
                throughExpiry,
                contracts,
            });
            if (!isCurrent()) return;
            const price = Number(response.underlyingPrice);
            if (!Number.isFinite(price) || price <= 0) {
                throw new Error('TWS 返回的联动标的现价无效');
            }
            state.stressLinkedInputs = response;
        } catch (error) {
            if (!isCurrent()) return;
            state.stressLinkedInputs = null;
            if (error.code === 'broker_option_scenario_inputs_unavailable') {
                state.stressLinkedInputsError = '当前后端不支持 TWS 期权参数快照。';
            } else if (error.code === 'broker_option_scenario_inputs_timeout') {
                state.stressLinkedInputsError = 'TWS 期权参数在 15 秒内未完成，'
                    + '服务器已终止请求，没有继续后台等待。';
            } else {
                state.stressLinkedInputsError = `拉取失败：${error.message}`;
            }
            if (showAlert) globalScope.alert(`联动账本：${state.stressLinkedInputsError}`);
        } finally {
            if (isCurrent()) {
                state.stressLinkedInputsPending = false;
                _renderStressTest();
            }
        }
    }

    /** Load whatever the linked overlay still lacks, in order, once. */
    function _ensureStressLinkedData(showAlert) {
        if (!state.stressIncludeLinkedHedge || !state.stressLinkedBookId) return;
        if (!state.stressLinkedLedger) {
            if (!state.stressLinkedEventsPending) void _loadStressLinkedEvents(showAlert);
            return;
        }
        if (!state.stressLinkedInputs && !state.stressLinkedInputsPending) {
            void _refreshStressLinkedInputs(showAlert);
        }
    }

    function _countLongOptions(openOptions) {
        return (openOptions || []).reduce((total, option) => {
            const contracts = Number(option.contracts);
            const right = String(option.right || '').toUpperCase().slice(0, 1);
            if (!(contracts > 0) || (right !== 'C' && right !== 'P')) return total;
            return {
                calls: total.calls + (right === 'C' ? contracts : 0),
                puts: total.puts + (right === 'P' ? contracts : 0),
            };
        }, { calls: 0, puts: 0 });
    }

    function _stressLinkedHedgeRequest() {
        if (!state.stressIncludeLinkedHedge) return null;
        const linkedBook = _stressLinkedBook();
        return {
            symbol: linkedBook ? linkedBook.symbol : '',
            bookId: state.stressLinkedBookId,
            openOptions: state.stressLinkedLedger
                ? (state.stressLinkedLedger.openOptions || []) : null,
            ratio: state.stressLinkedRatio,
            ivMode: state.stressLinkedIvMode,
            ivShockPoints: state.stressLinkedIvShockPoints,
            ivBeta: state.stressLinkedIvBeta,
            ivTenorDamping: state.stressLinkedIvTenorDamping,
            ivTenorDays: state.stressLinkedIvTenorDays,
            mapping: state.stressLinkedMapping,
            sigma: state.stressLinkedSigma,
            dividendYield: _effectiveDividendYield(
                state.stressLinkedDividendYield, linkedBook ? linkedBook.symbol : ''),
            currency: linkedBook ? (linkedBook.currency || 'USD') : '',
            basePrice: state.stressLinkedInputs
                ? state.stressLinkedInputs.underlyingPrice : null,
            marketInputs: state.stressLinkedInputs,
            asOf: _todayDigits(),
        };
    }

    /** Blank = the symbol's default yield (0 for unknown symbols). */
    function _effectiveDividendYield(value, symbol) {
        if (value === null || value === undefined || value === '') {
            return DIVIDEND_YIELD_DEFAULTS[String(symbol || '').toUpperCase()] || 0;
        }
        return value;
    }

    function _todayDigits() {
        return _todayIso().replace(/\D/g, '').slice(0, 8);
    }

    function _renderStressLinkedControls(book) {
        const toggle = $('stress-include-linked-hedge');
        const wrap = $('stress-linked-inputs');
        const select = $('stress-linked-book');
        const ratioInput = $('stress-linked-ratio');
        const candidates = _stressLinkedBookCandidates(book);
        toggle.checked = state.stressIncludeLinkedHedge;
        toggle.disabled = !candidates.length;
        wrap.hidden = !state.stressIncludeLinkedHedge;
        _text($('stress-linked-toggle-hint'), candidates.length
            ? '可选；把同账户联动账本里全部未平 Long Call / Put 按映射后的联动标的价估值，叠加为第四条曲线'
            : '同账户没有其它同币种 STK 账本，无法叠加。请先为联动标的（如 QQQ）建立账本并导入。');
        _clear(select);
        const placeholder = globalScope.document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = candidates.length ? '请选择联动账本' : '同账户没有其它同币种 STK 账本';
        select.appendChild(placeholder);
        candidates.forEach((candidate) => {
            const option = globalScope.document.createElement('option');
            option.value = candidate.bookId;
            option.textContent = candidate.symbol;
            select.appendChild(option);
        });
        select.value = state.stressLinkedBookId;
        select.disabled = !candidates.length;
        if (globalScope.document.activeElement !== ratioInput) {
            ratioInput.value = state.stressLinkedRatio === null
                ? '' : String(state.stressLinkedRatio);
        }
        const modeSelect = $('stress-linked-iv-mode');
        modeSelect.value = state.stressLinkedIvMode;
        const shockInput = $('stress-linked-iv-shock');
        const shockField = $('stress-linked-iv-shock-field');
        const betaInput = $('stress-linked-iv-beta');
        const betaField = $('stress-linked-iv-beta-field');
        shockField.hidden = state.stressLinkedIvMode !== 'fixed';
        betaField.hidden = state.stressLinkedIvMode !== 'beta';
        if (globalScope.document.activeElement !== shockInput) {
            shockInput.value = state.stressLinkedIvShockPoints === null
                ? '' : (state.stressLinkedIvShockPoints === 0
                    ? '' : String(state.stressLinkedIvShockPoints));
        }
        if (globalScope.document.activeElement !== betaInput) {
            betaInput.value = state.stressLinkedIvBeta === null
                ? '' : String(state.stressLinkedIvBeta);
        }
        const mappingSelect = $('stress-linked-mapping');
        mappingSelect.value = state.stressLinkedMapping;
        const sigmaInput = $('stress-linked-sigma');
        if (globalScope.document.activeElement !== sigmaInput) {
            sigmaInput.value = state.stressLinkedSigma === null
                || state.stressLinkedSigma === undefined
                ? '' : String(Math.round(state.stressLinkedSigma * 10000) / 100);
        }
        $('stress-linked-sigma-field').hidden = state.stressLinkedMapping !== 'compound';
        const linkedYieldInput = $('stress-linked-dividend-yield');
        if (globalScope.document.activeElement !== linkedYieldInput) {
            linkedYieldInput.value = state.stressLinkedDividendYield === null
                || state.stressLinkedDividendYield === undefined
                ? '' : String(Math.round(state.stressLinkedDividendYield * 10000) / 100);
        }
        const yieldBook = _stressLinkedBook();
        linkedYieldInput.placeholder = `${_money(_effectiveDividendYield(
            null, yieldBook ? yieldBook.symbol : '') * 100, 2)}`;
        const tenorToggle = $('stress-linked-iv-tenor');
        const tenorField = $('stress-linked-iv-tenor-field');
        const tenorDaysInput = $('stress-linked-iv-tenor-days');
        tenorField.hidden = state.stressLinkedIvMode !== 'beta';
        tenorToggle.checked = state.stressLinkedIvTenorDamping;
        tenorDaysInput.disabled = !state.stressLinkedIvTenorDamping;
        if (globalScope.document.activeElement !== tenorDaysInput) {
            tenorDaysInput.value = state.stressLinkedIvTenorDays === null
                ? '' : String(state.stressLinkedIvTenorDays);
        }
        const linkedBook = _stressLinkedBook();
        const symbol = linkedBook ? linkedBook.symbol : '联动账本';
        let bookStatus = '联动账本：尚未选择';
        if (linkedBook) {
            if (state.stressLinkedEventsPending) {
                bookStatus = `${symbol} 账本：正在读取事件…`;
            } else if (state.stressLinkedEventsError) {
                bookStatus = `${symbol} 账本：${state.stressLinkedEventsError}`;
            } else if (state.stressLinkedLedger) {
                const counts = _countLongOptions(state.stressLinkedLedger.openOptions);
                bookStatus = `${symbol} 账本：${_quantity(counts.calls)} 张 Long Call`
                    + ` + ${_quantity(counts.puts)} 张 Long Put`
                    + ` · 事件 ${_quantity(state.stressLinkedEvents.length)} 条`;
            } else {
                bookStatus = `${symbol} 账本：尚未载入`;
            }
        }
        _text($('stress-linked-book-status'), bookStatus);
        let inputsStatus = `逐合约 TWS IV：${state.stressLinkedInputsError || '尚未拉取'}`;
        if (state.stressLinkedInputsPending) {
            inputsStatus = `逐合约 TWS IV：正在拉取 ${symbol}…`;
        } else if (state.stressLinkedInputs) {
            const quoted = (state.stressLinkedInputs.options || []).filter(
                (item) => Number(item.impliedVolatility) > 0).length;
            const price = Number(state.stressLinkedInputs.underlyingPrice);
            inputsStatus = `逐合约 TWS IV：${_quantity(quoted)} 张已取得`
                + (marketDataTypeLabel(state.stressLinkedInputs.options)
                    ? `（${marketDataTypeLabel(state.stressLinkedInputs.options)}）` : '')
                + ` · ${symbol} 基准 ${_currencyAmount(
                    linkedBook && linkedBook.currency || 'USD', price, 2)}`;
        }
        _text($('stress-linked-inputs-status'), inputsStatus);
    }

    function _renderPremiumExpiry() {
        const book = _currentBook();
        const modal = $('premium-expiry-modal');
        const available = Boolean(book && state.ledger);
        $('btn-open-premium-expiry').disabled = !available;
        const body = $('premium-expiry-table').querySelector('tbody');
        _clear(body);
        if (!available) {
            if (modal.open) modal.close();
            _text($('premium-expiry-context'), '选择账本后显示');
            _text($('premium-expiry-total'), '—');
            $('premium-expiry-warning').hidden = true;
            return;
        }
        const distribution = core.openShortPremiumByExpiry(state.ledger);
        _text($('premium-expiry-context'), `${book.account || '全部账户'} / ${book.symbol}`
            + ` · ${distribution.rows.length} 个到期日`
            + ` · ${_quantity(distribution.totalContracts)} 张未平空头期权`);
        _text($('premium-expiry-total'), _currencyAmount(
            book.currency, state.ledger.combined.openShortPremium, 2, true));
        $('premium-expiry-warning').hidden = !state.ledger.combined.costIncomplete;
        distribution.rows.forEach((entry) => {
            const row = globalScope.document.createElement('tr');
            _cell(row, entry.expiry
                ? entry.expiry.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
                : '未标明到期日');
            ['put', 'call'].forEach((side) => {
                const quantity = entry[`${side}Contracts`];
                const cell = _cell(row, quantity
                    ? _currencyAmount(book.currency, entry[`${side}Premium`], 4, true) : '—');
                if (quantity) {
                    const count = globalScope.document.createElement('small');
                    count.textContent = `${_quantity(quantity)} 张`;
                    cell.appendChild(count);
                }
            });
            _cell(row, _currencyAmount(book.currency, entry.totalPremium, 4, true));
            _cell(row, _currencyAmount(book.currency, entry.cumulativePremium, 4, true));
            body.appendChild(row);
        });
        if (!distribution.rows.length) {
            const row = globalScope.document.createElement('tr');
            _cell(row, '当前没有未平仓的 Short Call / Put。', 'empty').colSpan = 5;
            body.appendChild(row);
        }
    }

    function _openPremiumExpiry() {
        _renderPremiumExpiry();
        if (state.ledger && _currentBook()) $('premium-expiry-modal').showModal();
    }

    function _renderDashboardSummary() {
        _renderPremiumExpiry();
        const ids = ['headline-cost', 'headline-position', 'headline-expired-cost',
            'headline-market-value',
            'headline-diluted-pnl', 'headline-stock-cost', 'headline-tws-cost',
            'headline-break-even', 'cash-net', 'cash-realized-premium',
            'cash-open-premium', 'cash-dividends', 'cash-fees'];
        if (!state.ledger || !_currentBook()) {
            ids.forEach((id) => _text($(id), '—'));
            _text($('headline-cost-caption'), '选择账本后显示');
            $('headline-cost').className = 'hero-value';
            $('headline-diluted-pnl').className = '';
            _renderWhatIf();
            _renderStressTest();
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
            _text(headline, _currencyAmount(book.currency, rendered.value, 4));
        }
        hero.marks.forEach((mark) => headline.classList.add(mark));
        _text($('headline-cost-caption'), hero.caption);
        _text($('headline-position'), _quantity(futures
            ? summary.futuresContracts : summary.shares));
        _text($('headline-expired-cost'), summary.blendedCostIfExpired === null
            ? '—' : _money(summary.blendedCostIfExpired, 4));
        const reference = state.referencePrice !== null
            ? state.referencePrice : state.marketPrice;
        const exposure = futures ? summary.futureExposure : summary.shares;
        const currency = book.currency || 'USD';
        const marketMetrics = computeMarketMetrics(
            reference, exposure, rendered.available ? rendered.value : null);
        const marketValue = marketMetrics.marketValue;
        _text($('headline-market-value'), marketValue === null
            ? '—' : _currencyAmount(currency, marketValue));
        const dilutedPnl = marketMetrics.dilutedPnl;
        const pnlNode = $('headline-diluted-pnl');
        pnlNode.className = dilutedPnl > 0
            ? 'metric-positive' : (dilutedPnl < 0 ? 'metric-negative' : '');
        _text(pnlNode, dilutedPnl === null
            ? '—' : _currencyAmount(currency, dilutedPnl, 2, true));
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
        _text($('cash-realized-premium'), _signedMoney(summary.realizedShortPremium));
        _text($('cash-open-premium'), _signedMoney(summary.openShortPremium));
        const realizedTotal = futures
            ? summary.futuresRealizedPnl
            : Number(summary.dividends || 0) + Number(summary.stockRealizedPnl || 0);
        _text($('cash-dividends'), _signedMoney(realizedTotal));
        _text($('cash-realized-label'), futures
            ? 'FUT 换月 / 平仓已实现盈亏'
            : '股息 + 股票已实现盈亏');
        _text($('cash-dividends-caption'), futures
            ? '已实现 FUT 损益'
            : `股息 ${_signedMoney(summary.dividends)} · `
                + `股票已实现 ${_signedMoney(summary.stockRealizedPnl)}`);
        _text($('cash-fees'), _signedMoney(-Math.abs(Number(summary.fees) || 0)));
        _renderWhatIf();
        _renderStressTest();
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

    /**
     * The reference price sits in the hero because market value and the
     * diluted P&L beside it are blank until it has one. The input carries
     * the effective figure itself - typed value, or the TWS price as its
     * placeholder - so the number and the control that sets it are the same
     * object rather than two cells that have to be matched up by eye.
     *
     * Nothing here ever writes .value: a re-render lands mid-typing.
     */
    function _renderReferenceSource() {
        const node = $('reference-source');
        const input = $('reference-price');
        const missing = state.referencePrice === null && state.marketPrice === null;
        const foot = globalScope.document.querySelector('.hero-foot');
        if (foot) foot.classList.toggle('needs-reference', missing);
        if (input) {
            input.placeholder = state.marketPrice === null
                ? '输入' : _money(state.marketPrice, 4);
        }
        if (state.referencePrice !== null) {
            _text(node, '手工输入');
            return;
        }
        if (state.marketPrice !== null) {
            _text(node, '来自 TWS 持仓快照');
            return;
        }
        _text(node, '填入后可算市值与浮盈亏');
    }

    async function _adoptTwsPosition(entry, event, button) {
        if (!state.bookId || !state.positionsConnected || !event
            || state.executionFetchPending || state.importResult) return;
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

    /**
     * The table is collapsed by default, so the summary line - and the
     * auto-open below - are the only things standing between a real
     * position mismatch and a page that looks settled. A difference the
     * user never sees is worse than no reconciliation at all.
     */
    function planReconcileDisclosure(rows, lastSignature) {
        const mismatches = (rows || []).filter((entry) => (
            entry.status !== 'match' && entry.status !== 'explained'));
        // Keyed on the outstanding set, not on a render count: a deliberate
        // collapse survives an unrelated re-render, but a difference that
        // appears or changes shape re-opens the table every time.
        const signature = mismatches
            .map((entry) => `${entry.account}|${entry.label}|${entry.status}`)
            .sort().join(';');
        return { signature, open: Boolean(signature) && signature !== lastSignature };
    }

    function _renderReconciliation() {
        _renderReconciliationTable();
        const badge = $('position-match-badge');
        _text($('reconcile-summary-label'), `持仓对账 · ${badge.textContent}`);
        const details = $('reconcile-details');
        if (!details) return;
        const plan = planReconcileDisclosure(
            state.reconciliation ? state.reconciliation.rows : [],
            state.reconcileOpenSignature);
        if (plan.open) details.open = true;
        state.reconcileOpenSignature = plan.signature;
    }

    function _renderReconciliationTable() {
        const body = $('reconcile-table').querySelector('tbody');
        const badge = $('position-match-badge');
        _clear(body);
        if (!state.reconciliation) {
            const book = _currentBook();
            const previewRows = buildLedgerPositionPreview(
                state.ledger, book && book.symbol, book && book.secType);
            badge.className = previewRows.length ? 'soft-badge warn' : 'soft-badge';
            _text(badge, previewRows.length ? '仅 CSV / 账本推测' : '尚无推测持仓');
            if (!previewRows.length) {
                const row = globalScope.document.createElement('tr');
                const cell = globalScope.document.createElement('td');
                cell.colSpan = 8;
                cell.className = 'empty';
                cell.textContent = 'CSV / 账本流水尚未推导出当前持仓；TWS 尚未核对';
                row.appendChild(cell);
                body.appendChild(row);
                return;
            }
            previewRows.forEach((entry) => {
                const row = globalScope.document.createElement('tr');
                _cell(row, entry.account || '（未标账户）');
                _cell(row, entry.label);
                _cell(row, _quantity(entry.ledger), 'numeric');
                _cell(row, '—', 'numeric');
                _cell(row, '—', 'numeric');
                _cell(row, entry.identityConflict
                    ? '仅 CSV 推测 · 合约身份待复核' : '仅 CSV 推测',
                entry.identityConflict ? 'status-missing' : 'status-explained');
                _cell(row, '尚未与 TWS 当前持仓对账', 'confidence-low');
                _cell(row, '');
                body.appendChild(row);
            });
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
            const targetedPending = state.importResult
                && state.importResult.format === 'tws_api'
                && state.importResult.reconciliationExecution
                && state.importResult.reconciliationExecution.key === entry.key
                ? state.importResult.reconciliationExecution : null;
            const pendingExecution = targetedPending || (state.importResult
                && state.importResult.format === 'tws_api'
                ? core.matchReconciliationExecution(entry, state.importResult.events)
                : null);
            const executionProbe = core.matchReconciliationExecution(entry, []);
            const canFetchExecution = state.positionsConnected
                && executionProbe.eligible === true;
            const adoption = state.positionsConnected
                ? core.buildTwsAdoptionEvent(entry, {
                    today: _todayIso(), snapshotTimestamp: state.positionsTimestamp,
                    secType: (_currentBook() || {}).secType || 'STK',
                })
                : null;
            const avgCostDraft = state.positionsConnected && !adoption
                ? core.buildTwsAvgCostGapDraft(entry, {
                    today: _todayIso(),
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
            _cell(row, pendingExecution && pendingExecution.complete
                ? (pendingExecution.movement === 'close'
                    ? '已找到 Close · 待确认' : '已找到成交 · 待确认')
                : ({
                match: '一致',
                explained: '已由期权解释',
                quantity_mismatch: '数量不符',
                ledger_only: '账本有 TWS 无',
                tws_only: 'TWS 有账本无',
                // Equal quantities here would be a coincidence, not a match.
                identity_conflict: '合约身份歧义，需人工确认',
            }[entry.status] || entry.status), pendingExecution && pendingExecution.complete
                ? 'status-explained' : statusClass);

            if (!entry.suggestion && !adoption && !avgCostDraft
                && !canFetchExecution && !(pendingExecution && pendingExecution.complete)) {
                _cell(row, entry.advice || '', entry.advice ? 'confidence-low' : '');
                _cell(row, '');
            } else {
                const label = pendingExecution && pendingExecution.complete
                    ? `TWS 真实${pendingExecution.movement === 'close' ? ' Close' : '成交'}`
                        + ` · 净变动 ${_quantity(pendingExecution.matchedContracts)} 张；确认导入后计入流水`
                        + (pendingExecution.replacedBaselines
                            ? ` · 同时取代 ${pendingExecution.replacedBaselines} 条 AvgCost 临时基线`
                            : '')
                    : (canFetchExecution
                        ? '优先查找能完整解释差额的 TWS 真实成交；AvgCost 仅作后备'
                        : (adoption
                            ? `TWS 持仓基线 · 均价 ${_money(adoption.price, 4)}`
                            : (avgCostDraft
                                ? `AvgCost ${_money(avgCostDraft.price, 4)} 只生成差额草稿`
                                : `${KIND_LABELS[entry.suggestion.kind] || entry.suggestion.kind}`
                                    + (entry.suggestion.shares
                                        ? ` · ${_quantity(entry.suggestion.shares)} 股` : '')
                                    + (entry.status === 'tws_only' && !entry.twsAvgCost
                                        ? ' · TWS 均价不可用'
                                        : (entry.confidence === 'high'
                                            ? '' : ' · 需核实')))));
                _cell(row, label,
                    (pendingExecution && pendingExecution.complete) || adoption
                        || entry.confidence === 'high'
                        ? 'confidence-high' : 'confidence-low');
                const actionCell = globalScope.document.createElement('td');
                actionCell.className = 'reconcile-actions';
                const button = globalScope.document.createElement('button');
                button.type = 'button';
                button.className = 'draft';
                if (pendingExecution && pendingExecution.complete) {
                    button.textContent = '确认导入成交';
                    button.title = '再次确认后把上方预览的真实 TWS 成交写入账本';
                    button.addEventListener('click', _commitImport);
                } else if (canFetchExecution) {
                    button.textContent = '查找 TWS 成交';
                    button.title = '拉取真实 TWS 成交，以价格和费用建立可审计流水';
                    button.disabled = state.executionFetchPending || Boolean(state.importResult);
                    button.addEventListener('click', () => _fetchTwsExecutions(entry));
                } else if (adoption) {
                    button.textContent = '采信 TWS';
                    button.addEventListener('click', () => (
                        _adoptTwsPosition(entry, adoption, button)));
                } else if (avgCostDraft) {
                    button.textContent = '按 AvgCost 填草稿';
                    button.title = '只填入手工表单，不会直接写账；AvgCost 可能混合开平仓';
                    button.addEventListener('click', () => _fillForm(avgCostDraft));
                } else {
                    button.textContent = '手工补录…';
                    button.addEventListener('click', () => _fillForm(entry.suggestion));
                }
                actionCell.appendChild(button);
                if (adoption && canFetchExecution
                    && !(pendingExecution && pendingExecution.complete)) {
                    const fallback = globalScope.document.createElement('button');
                    fallback.type = 'button';
                    fallback.className = 'draft';
                    fallback.textContent = '采信 TWS';
                    fallback.title = '历史成交窗口不足时的后备：确认后按 TWS AvgCost 建立临时基线，不是历史成交';
                    fallback.disabled = state.executionFetchPending || Boolean(state.importResult);
                    fallback.addEventListener('click', () => (
                        _adoptTwsPosition(entry, adoption, fallback)));
                    actionCell.appendChild(fallback);
                }
                if (avgCostDraft && (canFetchExecution
                    || (pendingExecution && pendingExecution.complete))) {
                    const fallback = globalScope.document.createElement('button');
                    fallback.type = 'button';
                    fallback.className = 'draft';
                    fallback.textContent = 'AvgCost 后备';
                    fallback.title = '仅在近期真实成交无法取得时使用；只填草稿，不直接写账';
                    fallback.addEventListener('click', () => _fillForm(avgCostDraft));
                    actionCell.appendChild(fallback);
                }
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
            // Settlement dates, not receipt dates: both buckets are already
            // received cash. This window measures when the associated
            // contract obligation ended, not whether premium income exists.
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
            ? '按近 365 天已到期 / 已结算 FOP 卖方权利金 / 当前 FUT 名义金额（非保证金收益率）'
            : '按近 365 天已到期 / 已结算卖方权利金 / 当前持仓成本');
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
                _cell(row, _eventKindLabel(event));
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
                    button.className = 'draft delete-event';
                    button.textContent = '删除';
                    button.title = '从有效流水和成本计算中移除，同时保留可审计的冲销记录';
                    button.addEventListener('click', () => _voidEvent(event));
                    actionCell.appendChild(button);
                } else {
                    const deleted = globalScope.document.createElement('span');
                    deleted.className = 'deleted-label';
                    deleted.textContent = '已删除';
                    actionCell.appendChild(deleted);
                }
                row.appendChild(actionCell);
                body.appendChild(row);
            });
        }
        _text($('flow-page-label'), `最新优先 · 第 ${state.flowPage} / ${pageCount} 页 · 筛选出 `
            + `${filtered.length} 条 · 账本共 ${state.eventsTotal} 条`);
        // The table is collapsed by default, so its summary has to carry
        // enough for the daily glance: how much is in the book and how
        // recent it is. Anything less and folding it away hides the answer.
        const book = _currentBook();
        _text($('flow-summary-label'), book
            ? `事件流水 · ${state.eventsTotal} 条`
                + (book.lastEventDate ? ` · 最近 ${book.lastEventDate}` : '')
                + (filtered.length !== state.eventsTotal
                    ? ` · 当前筛选 ${filtered.length} 条` : '')
            : '事件流水 · 未选择账本');
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
        Array.from($('book-sidebar-list').querySelectorAll('[data-delete-book-id]'))
            .forEach((button) => { button.disabled = !connected; });
        $('btn-refresh').disabled = !connected;
        $('btn-refresh-positions').disabled = !connected;
        $('btn-submit-event').disabled = !hasBook || state.eventSubmitPending;
        $('btn-export-csv').disabled = !hasBook;
        $('btn-save-snapshot').disabled = !hasBook;
        $('btn-fetch-executions').disabled = !hasBook || !state.positionsConnected
            || state.executionFetchPending || Boolean(state.importResult);
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
        // Replacement still needs the server-issued, count-bearing reset
        // plan, but the operator confirms it with one explicit dialog rather
        // than retyping an implementation phrase.
        const resetPlanReady = !replacing || Boolean(state.resetPlan);
        // A batch carrying unresolved rows must not be committed piecemeal.
        // Writing the readable half of a statement produces a ledger that
        // looks imported but is missing a delivery - the worst outcome
        // available, because nothing on the page would say so afterwards.
        const blocked = Boolean(state.importResult
            && state.importResult.problems.length);
        const apiImport = Boolean(state.importResult
            && state.importResult.format === 'tws_api');
        $('import-replace').disabled = !hasBook || apiImport;
        $('btn-import-commit').disabled = !hasBook || !state.importResult
            || !_importRows(state.importResult).length || !resetPlanReady || blocked;
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

    function chooseManualSubmitToken(existingToken, existingFingerprint,
                                     nextFingerprint, tokenFactory) {
        if (existingToken && existingFingerprint === nextFingerprint) {
            return existingToken;
        }
        return tokenFactory();
    }

    async function _submitEvent(submitEvent) {
        submitEvent.preventDefault();
        if (!state.bookId || state.eventSubmitPending) return;
        const bookId = state.bookId;
        const event = _formEvent();
        if (event.cashAmount === null || event.cashAmount === undefined) {
            _message('无法推导现金金额，请手工填写。', 'error');
            return;
        }
        const fingerprint = JSON.stringify([bookId, event]);
        const clientToken = chooseManualSubmitToken(
            state.eventSubmitToken, state.eventSubmitFingerprint,
            fingerprint, () => _token('cbe-'));
        state.eventSubmitToken = clientToken;
        state.eventSubmitFingerprint = fingerprint;
        state.eventSubmitPending = true;
        $('btn-submit-event').textContent = '写入中…';
        _refreshControls();
        let writeAcknowledged = false;
        try {
            const response = await request('append_cost_basis_event', {
                bookId,
                event,
                clientToken,
            });
            writeAcknowledged = true;
            state.eventSubmitToken = '';
            state.eventSubmitFingerprint = '';
            const warnings = Array.isArray(response.warnings) ? response.warnings : [];
            _message(warnings.length
                ? `已写入（告警：${warnings.map(_describeWarning).join('；')}）`
                : '已写入账本。', 'ok');
            _resetForm();
            await _loadBooks();
        } catch (error) {
            if (writeAcknowledged) {
                _message(`已写入账本，但刷新失败：${error.message || '未知错误'}`, 'error');
                return;
            }
            // A typed server rejection proves that nothing committed and a
            // corrected draft is a new logical operation. A timeout/socket
            // loss is ambiguous: retain the token so retry is idempotent if
            // the first write committed but its acknowledgement was lost.
            if (error.code) {
                state.eventSubmitToken = '';
                state.eventSubmitFingerprint = '';
            }
            const retryNote = error.code
                ? '' : '；可直接重试，不会重复写入';
            _message(`${_explainWriteError(error)}${retryNote}`, 'error');
        } finally {
            state.eventSubmitPending = false;
            $('btn-submit-event').textContent = '写入账本';
            _refreshControls();
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
            `删除这条账本记录（${event.tradeDate} ${KIND_LABELS[event.kind] || event.kind}）？\n\n`
            + '删除后它会立即从有效流水和成本计算中移除，'
            + '但会保留一条可审计的冲销记录。\n\n请填写删除原因：');
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
            globalScope.alert(`删除失败：${error.message}`);
        }
    }

    // ------------------------------------------------------------------
    // Import
    // ------------------------------------------------------------------

    function _recordedBrokerTimestamp(event) {
        const explicit = String((event && event.brokerTimestamp) || '');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(explicit)) {
            return explicit;
        }
        const note = String((event && event.note) || '');
        const source = String((event && event.source) || '');
        const trustedNote = source === 'csv_import' || source === 'execution_report'
            || (source === 'reconcile' && event && event.tag === 'tws_snapshot');
        if (trustedNote) {
            const match = /(\d{4}-\d{2}-\d{2})[,\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(note);
            if (match) {
                return `${match[1]}T${match[2].padStart(2, '0')}:${match[3]}:${match[4] || '00'}`;
            }
        }
        return '';
    }

    function _exactBrokerTimestamp(event) {
        return _recordedBrokerTimestamp(event);
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

    /**
     * Reconcile one live option-position gap with the broker's ordered fills.
     *
     * The broker executions are the evidence. We never choose one fill
     * because it happens to resemble AvgCost. Instead, every visible fill
     * for the exact contract is replayed in broker-time order. The replay is
     * accepted only when its final quantity equals the current TWS position.
     * A provisional AvgCost row may be removed as one atomic part of that
     * proof when keeping it would double-count the same position history.
     */
    function planTargetExecutionReconciliation(targetEntry, executionEvents,
                                               allEvents) {
        const target = targetEntry || {};
        const probe = core.matchReconciliationExecution(target, executionEvents);
        if (!probe.eligible) {
            return { complete: false, events: [], supersedeEventIds: [],
                expectedContracts: 0, matchedContracts: 0, movement: '',
                reason: '该持仓差异不能用期权成交回放。' };
        }

        const ordered = probe.events.slice().sort((left, right) => {
            const byTime = String(left.brokerTimestamp || '').localeCompare(
                String(right.brokerTimestamp || ''));
            return byTime || String(left.externalRef || '').localeCompare(
                String(right.externalRef || ''));
        });
        if (!ordered.length) {
            return { complete: false, events: [], supersedeEventIds: [],
                expectedContracts: probe.expectedContracts, matchedContracts: 0,
                movement: probe.movement, reason: 'TWS 未返回该合约的新成交。' };
        }

        const wantedKey = core.contractKey(target);
        const wantedConId = target.conId === null || target.conId === undefined
            || target.conId === '' ? '' : String(target.conId);
        const provisional = (allEvents || []).filter((event) => {
            if (!(event && event.eventId && !event.voidedAtUtc
                && event.includeInCost !== false && event.kind === 'option_trade'
                && event.source === 'reconcile' && event.tag === 'tws_snapshot'
                && core.contractKey(event) === wantedKey)) return false;
            const eventConId = event.conId === null || event.conId === undefined
                || event.conId === '' ? '' : String(event.conId);
            return !wantedConId || !eventConId || wantedConId === eventConId;
        });
        const ledger = Number(target.ledger || 0);
        const tws = Number(target.tws || 0);
        const executionDelta = ordered.reduce(
            (total, event) => total + Number(event.contracts || 0), 0);
        const fitsKeepingBaseline = Math.abs(
            ledger + executionDelta - tws) <= 1e-6;
        const fitsReplacingBaseline = provisional.length === 1 && Math.abs(
            ledger - Number(provisional[0].contracts || 0)
                + executionDelta - tws) <= 1e-6;

        let startingContracts = ledger;
        let supersedeEventIds = [];
        if (fitsReplacingBaseline && !fitsKeepingBaseline) {
            startingContracts -= Number(provisional[0].contracts || 0);
            supersedeEventIds = [provisional[0].eventId];
        } else if (!fitsKeepingBaseline) {
            return {
                complete: false,
                events: ordered,
                supersedeEventIds: [],
                expectedContracts: tws - ledger,
                matchedContracts: executionDelta,
                movement: probe.movement,
                reason: provisional.length > 1
                    ? '该合约有多条 TWS 临时基线，无法唯一确定应冲销哪一条。'
                    : `按时间回放后持仓为 ${ledger + executionDelta}，`
                        + `与 TWS 当前持仓 ${tws} 不一致。`,
            };
        }

        // Re-label each fill from the position that actually precedes it.
        // Signed broker quantity and cash remain untouched.
        let running = startingContracts;
        const replayed = ordered.map((sourceEvent) => {
            const event = Object.assign({}, sourceEvent);
            const delta = Number(event.contracts || 0);
            const isPureClose = Math.abs(running) > 1e-6
                && Math.sign(delta) === -Math.sign(running)
                && Math.abs(delta) <= Math.abs(running) + 1e-6;
            event.tag = isPureClose ? 'ibkr_close' : 'ibkr_exec';
            running += delta;
            return event;
        });
        if (Math.abs(running - tws) > 1e-6) {
            return { complete: false, events: replayed, supersedeEventIds,
                expectedContracts: tws - ledger,
                matchedContracts: executionDelta, movement: probe.movement,
                reason: `按时间回放后持仓为 ${running}，与 TWS 当前持仓 ${tws} 不一致。` };
        }
        return {
            complete: true,
            events: replayed,
            supersedeEventIds,
            expectedContracts: tws - ledger,
            matchedContracts: tws - ledger,
            executionContracts: executionDelta,
            movement: probe.movement,
            startingContracts,
            finalContracts: running,
            reason: '',
        };
    }

    function _tradeQuantity(event) {
        if (!event) return null;
        if (event.kind === 'option_trade') return Number(event.contracts);
        if (event.kind === 'share_trade') return Number(event.shares);
        if (event.kind === 'futures_trade') return Number(event.futureContracts);
        return null;
    }

    function _sameExecutionContract(left, right) {
        if (!left || !right || left.kind !== right.kind
            || left.account !== right.account) return false;
        if (left.kind === 'option_trade') {
            if (core.contractKey(left) !== core.contractKey(right)) return false;
            return !(left.conId && right.conId
                && String(left.conId) !== String(right.conId));
        }
        if (left.kind === 'futures_trade') {
            if (core.futureKey(left) !== core.futureKey(right)) return false;
            return !(left.futureConId && right.futureConId
                && String(left.futureConId) !== String(right.futureConId));
        }
        return left.kind === 'share_trade';
    }

    function _sameExecutionIdentity(left, right) {
        return _sameExecutionContract(left, right)
            && _exactBrokerTimestamp(left) === _exactBrokerTimestamp(right);
    }

    /**
     * Map authoritative next-day CSV rows onto already-imported TWS fills.
     * A match needs the exact account/contract/second plus signed quantity,
     * price, and net cash. Ambiguous economic overlap blocks the batch.
     */
    function planExecutionReportAliases(importResult, allEvents) {
        const result = importResult || {};
        if (result.format !== 'activity' && result.format !== 'flex') {
            return { aliases: {}, matched: [], problems: [] };
        }
        const active = (allEvents || []).filter((event) => (
            event.eventId && !event.voidedAtUtc && event.includeInCost !== false
            && event.source === 'execution_report'
            && (event.tag === 'ibkr_exec' || event.tag === 'ibkr_close')
            && ['option_trade', 'share_trade', 'futures_trade'].includes(event.kind)));
        const rebates = new Map();
        (allEvents || []).forEach((event) => {
            if (!event.voidedAtUtc && event.includeInCost !== false
                && event.source === 'execution_report' && event.tag === 'ibkr_rebate') {
                rebates.set(event.externalRef, Number(event.cashAmount || 0));
            }
        });
        const remaining = new Set(active);
        const aliases = {};
        const matched = [];
        const problems = [];
        (result.events || []).filter((event) => (
            event.source === 'csv_import'
            && ['option_trade', 'share_trade', 'futures_trade'].includes(event.kind)
            && Boolean(_exactBrokerTimestamp(event)))).forEach((csvEvent) => {
            const directRef = String(csvEvent.externalRef || '').startsWith('ibkr-exec-')
                ? String(csvEvent.externalRef)
                : `ibkr-exec-${String(csvEvent.externalRef || '')}`;
            const sameDayContract = active.filter((event) => (
                remaining.has(event) && _sameExecutionContract(csvEvent, event)
                && event.tradeDate === csvEvent.tradeDate));
            const direct = sameDayContract.filter((event) => (
                event.externalRef === directRef));
            const related = direct.length ? direct : active.filter((event) => (
                remaining.has(event) && _sameExecutionIdentity(csvEvent, event)));
            if (!related.length) {
                if (sameDayContract.length) {
                    problems.push({
                        lineNumber: csvEvent.lineNumber || 0,
                        reason: 'CSV row may overlap a stored TWS execution for the same '
                            + 'contract and day, but the broker timestamp differs; import is blocked for review',
                        raw: `${csvEvent.account} ${_describeContract(csvEvent)}`,
                    });
                }
                return;
            }
            const csvQuantity = _tradeQuantity(csvEvent);
            const csvPrice = Number(csvEvent.price);
            const csvCash = Number(csvEvent.cashAmount);
            const exact = related.filter((event) => {
                const apiCash = Number(event.cashAmount || 0)
                    + Number(rebates.get(`${event.externalRef}-rebate`) || 0);
                return Math.abs(_tradeQuantity(event) - csvQuantity) < 1e-6
                    && Math.abs(Number(event.price) - csvPrice) < 1e-8
                    && Math.abs(apiCash - csvCash) < 0.011;
            }).sort((left, right) => String(left.externalRef).localeCompare(
                String(right.externalRef)));
            if (!exact.length) {
                problems.push({
                    lineNumber: csvEvent.lineNumber || 0,
                    reason: 'CSV row overlaps a stored TWS execution at the same second, '
                        + 'but quantity, price, or net cash differs; import is blocked to avoid double counting',
                    raw: `${csvEvent.account} ${_describeContract(csvEvent)}`,
                });
                return;
            }
            const execution = exact[0];
            remaining.delete(execution);
            aliases[`${csvEvent.account}\u0000${csvEvent.externalRef}`]
                = execution.externalRef;
            matched.push({ csvEvent, execution });
        });
        return { aliases, matched, problems };
    }

    /**
     * Cross-source matching protects append imports from double-counting.
     * A replacement rebuild archives and removes every stored row first, so
     * comparing the new CSV against those soon-to-be-removed TWS fills would
     * create false blockers and can never prevent a duplicate.
     */
    function planImportExecutionAliases(replacing, importResult, allEvents) {
        return replacing
            ? { aliases: {}, matched: [], problems: [] }
            : planExecutionReportAliases(importResult, allEvents);
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
     * Find provisional TWS baselines for which reviewed broker history now
     * supplies the real executions. CSV and TWS API rows must independently
     * rebuild the exact snapshot quantity; partial overlap stays blocked.
     */
    function planTwsBaselineSupersession(importResult, allEvents, targetEntry) {
        const result = importResult || {};
        const openings = result.openings;
        const account = String(result.account || '');
        const cutoff = String(result.statementThrough || '');
        const historySource = result.format === 'activity' ? 'csv_import'
            : (result.format === 'tws_api' ? 'execution_report' : '');
        if (!historySource || !openings
            || (result.problems || []).length || !account || !cutoff) {
            return { eventIds: [], events: [], problems: [],
                replacementExecutionRefs: [] };
        }

        const historyEvents = (result.events || []).filter(
            (event) => event.source === historySource && event.tag !== 'prior_open');
        const openingKeys = new Set((openings.drafts || []).map(
            (event) => core.contractKey(event)));
        const targetKey = targetEntry && targetEntry.kind === 'option'
            ? core.contractKey(targetEntry) : '';
        const targetConId = targetEntry && targetEntry.conId !== null
            && targetEntry.conId !== undefined && targetEntry.conId !== ''
            ? String(targetEntry.conId) : '';
        const candidates = (allEvents || []).filter((event) => {
            if (!(event.eventId && !event.voidedAtUtc && event.includeInCost !== false
                && event.source === 'reconcile' && event.tag === 'tws_snapshot'
                && event.account === account
                && (!targetKey || (event.kind === 'option_trade'
                    && core.contractKey(event) === targetKey))
                && (!targetConId || !event.conId
                    || String(event.conId) === targetConId))) return false;
            if (_recordedBrokerTimestamp(event)) {
                return _eventTimestamp(event) <= cutoff;
            }
            // Database insertion time is not the broker snapshot clock.
            // Admit the date-level API candidate so it gets an explicit
            // conflict and guidance to the targeted quantity-proof workflow.
            if (result.format === 'tws_api' && event.kind === 'option_trade') {
                return String(event.tradeDate || '') <= cutoff.slice(0, 10);
            }
            return _eventTimestamp(event) <= cutoff;
        });
        const selected = [];
        const problems = [];
        const replacementExecutionRefs = [];

        function conflict(baseline) {
            const needsTargetedReplay = result.format === 'tws_api'
                && baseline.kind === 'option_trade' && !_recordedBrokerTimestamp(baseline);
            const label = baseline.kind === 'opening_balance' ? 'shares'
                : (baseline.kind === 'futures_trade'
                    ? `${baseline.futureExpiry || ''} FUT`
                    : `${baseline.expiry || ''} ${baseline.right || ''}${baseline.strike || ''}`);
            problems.push({
                lineNumber: 0,
                reason: needsTargetedReplay
                    ? '旧 AvgCost 临时基线没有券商快照时钟，批量拉取无法证明成交先后，已阻止导入。'
                        + '请先取消本次预览，再到「持仓对账」该合约行点击「查找 TWS 成交」，'
                        + '按全部成交回放后的数量核对；若没有该入口或仍无法贴合，请用完整 CSV 覆盖式重建。'
                    : 'Broker execution history partially or ambiguously overlaps an adopted TWS '
                        + 'baseline; import a complete covering statement or use reviewed rebuild',
                raw: `${account} ${label}`,
            });
        }

        candidates.forEach((baseline) => {
            if (baseline.kind === 'futures_trade') {
                const key = core.futureKey(baseline);
                const sameFuture = historyEvents.filter(
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
                const hasRecordedBrokerClock = Boolean(
                    _recordedBrokerTimestamp(baseline));
                const sameContract = historyEvents.filter((event) => (
                    event.contracts !== null && event.contracts !== undefined
                    && core.contractKey(event) === key
                    && (!(baseline.conId && event.conId)
                        || String(baseline.conId) === String(event.conId))));
                const ambiguous = hasRecordedBrokerClock
                    ? sameContract.filter((event) => (
                        _eventVsAdoptedSnapshot(event, baseline) === 'ambiguous'))
                    : sameContract;
                const matching = hasRecordedBrokerClock
                    ? sameContract.filter((event) => (
                        _eventVsAdoptedSnapshot(event, baseline) === 'before'))
                    : [];
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
            const sameAccount = historyEvents.filter((event) => (
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
            replacementExecutionRefs,
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
            _text($('import-preview-title'), '导入预览');
            _text($('import-source-note'), '支持 TWS API 近期成交、Flex Query 与 Activity Statement。'
                + '导入前逐行预览，execId 或报表成交号会自动去重。');
            wrap.hidden = true;
            problemWrap.hidden = true;
            $('import-blocked').hidden = true;
            $('import-workspace').hidden = !state.importText;
            _refreshControls();
            return;
        }

        $('import-workspace').hidden = false;

        const result = state.importResult;
        const apiImport = result.format === 'tws_api';
        _text($('import-preview-title'), apiImport ? 'TWS 成交预览' : 'CSV 导入预览');
        _text($('import-source-note'), apiImport
            ? (result.coverageNote || 'TWS API 只是近期成交窗口，不能代替完整历史报表。')
            : '支持 Flex Query 与 Activity Statement。导入前逐行预览，'
                + '重叠时间段会自动去重。');
        const kinds = Object.keys(result.summary.byKind)
            .map((kind) => `${KIND_LABELS[kind] || kind} ${result.summary.byKind[kind]}`)
            .join(' · ');
        _text(summaryNode, `${apiImport ? 'TWS API' : `格式 ${result.format}`} · 读取 ${result.summary.total} 行`
            + (result.account ? ` · 账户 ${result.account}` : '')
            + ` · 生成草稿 ${result.summary.drafted} 条`
            + ` · ${result.reconciliationExecution ? '非本次差额' : '其他标的'}跳过 ${result.summary.skipped} 行`
            + ` · 待人工处理 ${result.summary.problems} 行`
            + (result.supersedeTwsEventIds && result.supersedeTwsEventIds.length
                ? ` · ${apiImport ? '真实成交' : 'CSV'}将取代 TWS 临时基线 ${result.supersedeTwsEventIds.length} 条`
                : '')
            + (result.confirmedExecutionCount
                ? ` · 已核对并跳过 TWS 重复成交 ${result.confirmedExecutionCount} 条`
                : '')
            + (kinds ? ` · ${kinds}` : ''));
        _renderOpenings(result);

        const rows = _importRows(result);
        wrap.hidden = !rows.length;
        rows.forEach((event) => {
            const row = globalScope.document.createElement('tr');
            _cell(row, event.tradeDate);
            _cell(row, event.account || '—');
            _cell(row, _eventKindLabel(event));
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
            const replacing = $('import-replace').checked === true;
            const executionAliases = planImportExecutionAliases(
                replacing, discovery, state.allEvents);
            const supersession = replacing
                ? { eventIds: [], events: [], problems: [] }
                : planTwsBaselineSupersession(discovery, state.allEvents);
            const baseline = buildImportBaseline(
                replacing, state.ledger, state.allEvents,
                discovery.statementThrough, supersession.eventIds);
            const first = importer.parse(text, Object.assign({}, parseOptions, baseline, {
                externalRefAliases: executionAliases.aliases,
            }));
            // Opening stubs must sort before every real row, so they are
            // dated the day before the earliest trade in the file.
            const earliest = first.events.reduce(
                (found, event) => (!found || event.tradeDate < found
                    ? event.tradeDate : found), '');
            state.importResult = earliest
                ? importer.parse(text, Object.assign({}, parseOptions, {
                    openingDate: _shiftDays(earliest, -1),
                }, baseline, { externalRefAliases: executionAliases.aliases }))
                : first;
            state.importResult.supersedeTwsEventIds = supersession.eventIds;
            state.importResult.confirmedExecutionCount = executionAliases.matched.length;
            if (supersession.problems.length) {
                state.importResult.problems.push(...supersession.problems);
                state.importResult.summary.problems += supersession.problems.length;
            }
            if (executionAliases.problems.length) {
                state.importResult.problems.push(...executionAliases.problems);
                state.importResult.summary.problems += executionAliases.problems.length;
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
     * Ask the server what wiping this book would destroy. The returned reset
     * token carries the live event count and is rechecked transactionally;
     * the UI presents that count in a normal confirmation dialog.
     */
    async function _refreshResetPlan() {
        const note = $('import-replace-note');
        const wanted = $('import-replace').checked === true;
        if (!wanted || !state.bookId) {
            state.resetPlan = null;
            note.hidden = true;
            _refreshControls();
            return;
        }
        note.hidden = false;
        try {
            state.resetPlan = await request('request_cost_basis_reset_plan',
                { bookId: state.bookId });
            _text(note, `将存档并替换当前 ${state.resetPlan.eventCount} 条事件。`
                + '点击「确认导入」后会再弹窗确认；账本若在此期间发生变化，后台会自动取消。');
        } catch (error) {
            state.resetPlan = null;
            note.hidden = true;
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
        const apiImport = state.importResult.format === 'tws_api';
        const supersedeTwsEventIds = replacing ? []
            : (state.importResult.supersedeTwsEventIds || []);
        const confirmed = globalScope.confirm(replacing
            ? `危险操作：将存档并清空 ${_currentBook().symbol} 账本当前 ${state.resetPlan
                ? state.resetPlan.eventCount : '?'} 条事件，`
                + `再用本文件的 ${events.length} 条事件完整重建。\n\n`
                + '旧数据会保留在重建存档中。确定继续吗？'
            : `将向 ${_currentBook().symbol} 账本写入 ${events.length} 条${apiImport ? ' TWS 成交' : '事件'}。`
                + (supersedeTwsEventIds.length
                    ? `${apiImport ? 'TWS 真实成交' : 'CSV'}已完整重建对应历史，将同时冲销 ${supersedeTwsEventIds.length} 条 TWS 临时基线。`
                    : '')
                + `已存在的${apiImport ? ' execId' : ' CSV 成交'}会自动跳过。确认导入？`);
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
                    // The server still rechecks this count-bearing value in
                    // the write transaction. No typing is required, and a
                    // stale plan cannot wipe a ledger that changed meanwhile.
                    confirmation: state.resetPlan.phrase,
                    clientToken: _token('cbr-'),
                    importBatchId: _token('cbb-'),
                    reason: '覆盖式重建：按新导入的报表重建账本',
                })
                : await request('import_cost_basis_events', {
                    bookId: state.bookId,
                    events,
                    supersedeTwsEventIds,
                    twsReconciliation: apiImport
                        ? state.importResult.twsReconciliation : undefined,
                    importBatchId: _token('cbb-'),
                    clientTokenPrefix: _token('cbi-'),
                });
            globalScope.alert(replacing
                ? `重建完成：归档并清空 ${response.removedEvents} 条，写入 ${response.inserted} 条。`
                : `${apiImport ? 'TWS 成交' : ''}导入完成：新增 ${response.inserted} 条，跳过 ${response.skipped} 条`
                    + (response.supersededTwsBaselines
                        ? `，已用${apiImport ? '真实成交' : ' CSV'}取代 ${response.supersededTwsBaselines} 条 TWS 临时基线`
                        : '') + '。');
            state.importResult = null;
            state.importText = '';
            $('import-file').value = '';
            $('import-replace').checked = false;
            await _refreshResetPlan();
            _renderImportPreview();
            await _loadBooks();
        } catch (error) {
            if (error.code === 'reset_confirmation_mismatch') {
                globalScope.alert('账本在预览确认后发生了变化，已自动取消重建。'
                    + '账本未被清空，也没有写入任何数据；请重新确认预览。');
                await _refreshResetPlan();
                return;
            }
            globalScope.alert(`导入失败：${_explainWriteError(error)}`);
        }
    }

    function _latestCsvCutoff() {
        const candidates = state.allEvents.filter((event) => (
            !event.voidedAtUtc && event.source === 'csv_import')).map((event) => {
            const exact = _exactBrokerTimestamp(event);
            if (exact) return exact;
            const date = String(event.tradeDate || '');
            return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00` : '';
        }).filter(Boolean).sort();
        // With no broker-local CSV evidence, the backend chooses midnight in
        // TWS's timezone. Browser-local midnight is not the broker clock.
        return candidates.length ? candidates[candidates.length - 1] : '';
    }

    /** Keep errors whose source fill might belong to the targeted contract.
     * Missing identity is not evidence of being unrelated. Also retain a
     * duplicate execId error if another occurrence belongs to the target.
     */
    function targetExecutionProblems(problems, executions, target) {
        const rows = Array.isArray(executions) ? executions : [];
        const upper = (value) => String(value || '').trim().toUpperCase();
        const date = (value) => String(value || '').replace(/\D/g, '').slice(0, 8);
        function mightMatch(row) {
            if (!row) return true;
            if (row.account && target.account
                && upper(row.account) !== upper(target.account)) return false;
            if (row.conId && target.conId && String(row.conId) === String(target.conId)) return true;
            if (row.symbol && target.symbol && upper(row.symbol) !== upper(target.symbol)) return false;
            if (['STK', 'FUT', 'BAG'].includes(upper(row.secType))) return false;
            if (['C', 'P'].includes(upper(row.right)) && target.right
                && upper(row.right) !== upper(target.right)) return false;
            if (date(row.expiry).length === 8 && date(target.expiry).length === 8
                && date(row.expiry) !== date(target.expiry)) return false;
            for (const [rawKey, targetKey] of [['strike', 'strike'], ['multiplier', 'sharesPerContract']]) {
                const value = _numberOrNull(row[rawKey]);
                const expected = _numberOrNull(target[targetKey]);
                if (value > 0 && expected > 0 && Math.abs(value - expected) > 1e-6) return false;
            }
            return true;
        }
        return (problems || []).filter((problem) => {
            const line = Number(problem.lineNumber);
            const row = Number.isInteger(line) && line > 0 ? rows[line - 1] : null;
            if (mightMatch(row)) return true;
            return Boolean(row.execId && rows.some((other) => other
                && String(other.execId || '').trim() === String(row.execId).trim()
                && upper(other.account) === upper(row.account) && mightMatch(other)));
        });
    }

    async function _fetchTwsExecutions(targetEntry) {
        if (!state.bookId || state.executionFetchPending) return;
        const executionTarget = targetEntry && targetEntry.kind === 'option'
            ? targetEntry : null;
        if (executionTarget && state.importResult) {
            globalScope.alert('请先确认或取消当前导入预览，再查找这笔成交。');
            return;
        }
        const book = _currentBook();
        const sinceTimestamp = _latestCsvCutoff();
        state.executionFetchPending = true;
        $('btn-fetch-executions').textContent = '正在拉取…';
        _refreshControls();
        _renderReconciliation();
        try {
            const response = await request('request_cost_basis_executions', {
                bookId: state.bookId,
                sinceTimestamp,
            });
            const existingExternalRefs = state.allEvents
                .filter((event) => Boolean(event.externalRef))
                .map((event) => ({
                    account: event.account,
                    externalRef: event.externalRef,
                }));
            const result = core.buildExecutionImport(response.executions, {
                account: book.account,
                symbol: book.symbol,
                secType: book.secType,
                defaultSharesPerContract: book.defaultSharesPerContract,
                existingOpen: state.ledger ? state.ledger.openOptions : [],
                existingExternalRefs,
            });
            const querySince = String(response.querySince || '');
            const todayStart = /^\d{8}-/.test(querySince)
                ? `${querySince.slice(0, 4)}-${querySince.slice(4, 6)}`
                    + `-${querySince.slice(6, 8)}T00:00:00`
                : '';
            const olderCutoff = Boolean(sinceTimestamp && todayStart
                && sinceTimestamp < todayStart);
            result.requestedSince = sinceTimestamp;
            result.fetchedAt = response.fetchedAt || '';
            result.statementThrough = response.fetchedAt || '';
            result.ignored = response.ignored || {};
            const requestedLabel = sinceTimestamp
                ? sinceTimestamp.replace('T', ' ')
                : querySince.replace(
                    /^(\d{4})(\d{2})(\d{2})-(.*)$/, '$1-$2-$3 $4');
            result.coverageNote = `已请求 ${requestedLabel || 'TWS 当日起点'} 之后的可见成交。`
                + (olderCutoff
                    ? ' 最后一份 CSV 早于今天；TWS API 只返回近期可见窗口，因此不能证明中间没有缺口，请继续用 Activity Statement 补齐长期历史。'
                    : ' 这些是真实成交回报，但 TWS API 仍不是长期历史报表。');
            const supersession = executionTarget
                ? { eventIds: [], events: [], problems: [] }
                : planTwsBaselineSupersession(result, state.allEvents);
            result.supersedeTwsEventIds = supersession.eventIds;
            if (executionTarget) {
                const relevantProblems = targetExecutionProblems(result.problems,
                    response.executions, { ...executionTarget, symbol: book.symbol });
                const executionMatch = planTargetExecutionReconciliation(
                    executionTarget, result.events, state.allEvents);
                if (!executionMatch.complete || relevantProblems.length) {
                    const allProblems = relevantProblems;
                    const detail = allProblems.length
                        ? `\n${allProblems.map((item) => item.reason).join('\n')}`
                        : (executionMatch.reason ? `\n${executionMatch.reason}` : '');
                    globalScope.alert('TWS 成交按时间回放后无法精确贴合当前持仓。'
                        + '不会用 AvgCost 代替真实交易；请稍后重拉、使用次日 CSV，'
                        + '或明确选择 AvgCost 后备草稿。'
                        + detail);
                    return;
                }
                result.supersedeTwsEventIds = executionMatch.supersedeEventIds;
                const matchedRefs = new Set(executionMatch.events.map(
                    (event) => String(event.externalRef || '')));
                const rebatesByExecution = new Map();
                result.events.filter((event) => event.tag === 'ibkr_rebate')
                    .forEach((event) => {
                        const ref = String(event.externalRef || '').replace(/-rebate$/, '');
                        if (!rebatesByExecution.has(ref)) rebatesByExecution.set(ref, []);
                        rebatesByExecution.get(ref).push(event);
                    });
                result.events = [];
                executionMatch.events.forEach((event) => {
                    result.events.push(event);
                    (rebatesByExecution.get(String(event.externalRef || '')) || [])
                        .forEach((rebate) => result.events.push(rebate));
                });
                result.problems = [];
                const byKind = {};
                result.events.forEach((event) => {
                    byKind[event.kind] = (byKind[event.kind] || 0) + 1;
                });
                result.summary = {
                    total: Array.isArray(response.executions) ? response.executions.length : 0,
                    drafted: result.events.length,
                    problems: 0,
                    skipped: Math.max(0, (Array.isArray(response.executions)
                        ? response.executions.length : 0) - matchedRefs.size),
                    byKind,
                };
                result.reconciliationExecution = {
                    key: executionTarget.key,
                    complete: true,
                    movement: executionMatch.movement,
                    expectedContracts: executionMatch.expectedContracts,
                    matchedContracts: executionMatch.matchedContracts,
                    replacedBaselines: executionMatch.supersedeEventIds.length,
                    replayedExecutions: executionMatch.events.length,
                    startingContracts: executionMatch.startingContracts,
                    finalContracts: executionMatch.finalContracts,
                };
                result.twsReconciliation = {
                    kind: 'option',
                    account: executionTarget.account,
                    right: executionTarget.right,
                    strike: executionTarget.strike,
                    expiry: executionTarget.expiry,
                    sharesPerContract: executionTarget.sharesPerContract,
                    conId: executionTarget.conId,
                    ledgerContracts: Number(executionTarget.ledger || 0),
                    twsContracts: Number(executionTarget.tws || 0),
                };
            }
            if (supersession.problems.length) {
                result.problems.push(...supersession.problems);
                result.summary.problems += supersession.problems.length;
            }
            state.importResult = result;
            state.importText = '';
            $('import-replace').checked = false;
            _renderImportPreview();
            _renderReconciliation();
            if (executionTarget) {
                const workspace = $('import-workspace');
                if (workspace && typeof workspace.scrollIntoView === 'function') {
                    workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
            if (!result.events.length && !result.problems.length) {
                globalScope.alert('未找到新的 TWS 成交。可能是今天没有成交、'
                    + '这些 execId 已在账本中，或当前 API 客户端看不到该订单来源。');
            }
        } catch (error) {
            const unavailable = error.code === 'broker_execution_history_unavailable';
            globalScope.alert(unavailable
                ? '当前连接的后端不支持 TWS 成交查询。请连接实时 IB 后端，'
                    + '或在持仓对账中用 AvgCost 生成待核实草稿。'
                : `拉取 TWS 成交失败：${error.message}`);
        } finally {
            state.executionFetchPending = false;
            $('btn-fetch-executions').textContent = '↓ 拉取 TWS 成交';
            _refreshControls();
            _renderReconciliation();
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

    async function _deleteBook(targetBookId, triggerButton) {
        const requestedId = typeof targetBookId === 'string' ? targetBookId : state.bookId;
        const book = state.books.find((candidate) => candidate.bookId === requestedId) || null;
        if (!book) return;
        const bookId = book.bookId;
        const button = $('btn-delete-book');
        let deleteSubmitted = false;
        let deleteConfirmed = false;
        button.disabled = true;
        if (triggerButton) triggerButton.disabled = true;
        try {
            const plan = await request('request_cost_basis_delete_plan', { bookId });
            if (!state.books.some((candidate) => candidate.bookId === bookId)) {
                globalScope.alert('账本列表已经变化，未执行删除。');
                return;
            }
            const confirmed = globalScope.confirm(
                `确定永久删除 ${plan.account || '旧版未限定账户'} · ${plan.symbol}？\n\n`
                + `全部事件：${plan.eventCount}（有效 ${plan.liveEventCount}，已冲销 ${plan.voidedEventCount}）\n`
                + `对账快照：${plan.snapshotCount}\n`
                + `清空 / 重建存档：${plan.resetCount}\n\n`
                + '删除后不能恢复。');
            if (!confirmed) return;
            deleteSubmitted = true;
            const response = await request('delete_cost_basis_book', {
                bookId,
                // The user confirms once; the server-generated phrase stays
                // an internal stale-plan guard instead of a transcription test.
                confirmation: plan.phrase,
                clientToken: _token('cbd-'),
            });
            deleteConfirmed = true;
            if (state.bookId === bookId) {
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
            }
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
            if (triggerButton && triggerButton.isConnected) {
                triggerButton.disabled = state.connection !== 'connected';
            }
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
            await _selectBook(changeEvent.target.value);
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
        $('btn-delete-book').addEventListener('click', () => _deleteBook());
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
            state.whatIfEditGeneration += 1;
            state.referencePrice = _numberOrNull(changeEvent.target.value);
            // Remembered against the book it was typed for, so coming back
            // to this underlying restores it and no other one inherits it.
            if (state.bookId) {
                if (state.referencePrice === null) {
                    delete state.referencePriceByBook[state.bookId];
                } else {
                    state.referencePriceByBook[state.bookId] = state.referencePrice;
                }
            }
            _recompute();
        });
        $('what-if-price').addEventListener('input', _editWhatIfPrice);
        $('what-if-follow-reference').addEventListener('change', (changeEvent) => {
            _setWhatIfFollowReference(changeEvent.target.checked);
        });
        $('what-if-expiry').addEventListener('change', (changeEvent) => {
            state.whatIfExpiry = changeEvent.target.value;
            _renderWhatIf();
        });
        $('btn-what-if-current').addEventListener('click', _refreshWhatIfMarketPrice);
        $('btn-open-premium-expiry').addEventListener('click', _openPremiumExpiry);
        $('btn-close-premium-expiry').addEventListener('click', () => {
            $('premium-expiry-modal').close();
        });
        // Native dialog supplies Escape, focus trapping and focus restoration.
        // Only a true backdrop click closes it, not whitespace inside the card.
        $('premium-expiry-modal').addEventListener('click', (clickEvent) => {
            const modal = $('premium-expiry-modal');
            if (clickEvent.target !== modal) return;
            const bounds = modal.getBoundingClientRect();
            if (clickEvent.clientX < bounds.left || clickEvent.clientX > bounds.right
                || clickEvent.clientY < bounds.top || clickEvent.clientY > bounds.bottom) {
                modal.close();
            }
        });
        $('btn-open-stress-test').addEventListener('click', _openStressTest);
        $('btn-close-stress-test').addEventListener('click', _closeStressTest);
        $('stress-modal').addEventListener('click', (clickEvent) => {
            if (clickEvent.target === $('stress-modal')) _closeStressTest();
        });
        $('stress-expiry').addEventListener('change', (changeEvent) => {
            state.stressExpiry = changeEvent.target.value;
            // Picking an expiry is an explicit choice of the scenario date.
            state.stressHorizonDays = null;
            _invalidateStressScenarioInputs();
            _renderStressTest();
            if (state.stressIncludeLongOptions) {
                _refreshStressMarketInputs(false);
            }
            _ensureStressLinkedData(false);
        });
        $('stress-include-linked-hedge').addEventListener('change', (changeEvent) => {
            state.stressIncludeLinkedHedge = changeEvent.target.checked;
            _writeStressLinkedMemory();
            _renderStressTest();
            _ensureStressLinkedData(false);
        });
        $('stress-linked-book').addEventListener('change', (changeEvent) => {
            state.stressLinkedBookId = String(changeEvent.target.value || '');
            _clearStressLinkedData();
            _writeStressLinkedMemory();
            _renderStressTest();
            _ensureStressLinkedData(false);
        });
        $('stress-linked-ratio').addEventListener('input', (inputEvent) => {
            state.stressLinkedRatio = _numberOrNull(inputEvent.target.value);
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-horizon-days').addEventListener('input', (inputEvent) => {
            const raw = String(inputEvent.target.value || '').trim();
            // Blank = settle on the selected expiry. A bad entry is kept so
            // the modal can say so instead of silently using the expiry.
            state.stressHorizonDays = raw === '' ? null : (_numberOrNull(raw) === null
                ? NaN : _numberOrNull(raw));
            // The scenario date moved: every snapshot keyed to it is stale.
            _invalidateStressScenarioInputs();
            _renderStressTest();
            // Refetch only once the value has settled, not per keystroke.
            globalScope.clearTimeout(state.stressHorizonTimer);
            state.stressHorizonTimer = globalScope.setTimeout(() => {
                state.stressHorizonTimer = null;
                if (!state.stressOpen || _stressScenarioDate().error) return;
                if (state.stressIncludeLongOptions) _refreshStressMarketInputs(false);
                _ensureStressLinkedData(false);
            }, STRESS_HORIZON_DEBOUNCE_MS);
        });
        $('stress-linked-iv-tenor').addEventListener('change', (changeEvent) => {
            state.stressLinkedIvTenorDamping = changeEvent.target.checked;
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-linked-iv-tenor-days').addEventListener('input', (inputEvent) => {
            const raw = String(inputEvent.target.value || '').trim();
            state.stressLinkedIvTenorDays = raw === ''
                ? LINKED_IV_DEFAULT_TENOR_DAYS : _numberOrNull(raw);
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-liquidation').addEventListener('change', (changeEvent) => {
            state.stressLiquidation = normalizeLiquidation(changeEvent.target.value) || 'mid';
            _renderStressTest();
        });
        $('stress-pricing-model').addEventListener('change', (changeEvent) => {
            state.stressPricingModel = normalizePricingModel(changeEvent.target.value) || 'american';
            _renderStressTest();
        });
        $('stress-dividend-yield').addEventListener('input', (inputEvent) => {
            const raw = String(inputEvent.target.value || '').trim();
            const percent = _numberOrNull(raw);
            state.stressDividendYield = raw === '' ? null : (percent === null ? NaN : percent / 100);
            _renderStressTest();
        });
        $('stress-linked-dividend-yield').addEventListener('input', (inputEvent) => {
            const raw = String(inputEvent.target.value || '').trim();
            const percent = _numberOrNull(raw);
            state.stressLinkedDividendYield = raw === '' ? null
                : (percent === null ? NaN : percent / 100);
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-linked-mapping').addEventListener('change', (changeEvent) => {
            state.stressLinkedMapping = normalizeLinkedMapping(changeEvent.target.value) || 'compound';
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-linked-sigma').addEventListener('input', (inputEvent) => {
            const raw = String(inputEvent.target.value || '').trim();
            // Entered in percent; blank means "use the snapshot's proxy".
            const percent = _numberOrNull(raw);
            state.stressLinkedSigma = raw === '' ? null
                : (percent === null ? NaN : percent / 100);
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-linked-iv-mode').addEventListener('change', (changeEvent) => {
            state.stressLinkedIvMode = normalizeLinkedIvMode(changeEvent.target.value) || 'none';
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-linked-iv-beta').addEventListener('input', (inputEvent) => {
            const raw = String(inputEvent.target.value || '').trim();
            state.stressLinkedIvBeta = raw === '' ? LINKED_IV_DEFAULT_BETA : _numberOrNull(raw);
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-linked-iv-shock').addEventListener('input', (inputEvent) => {
            const raw = String(inputEvent.target.value || '').trim();
            // Blank means no shock; anything else must be a finite number,
            // and an unusable entry is kept as null so the sweep says why.
            state.stressLinkedIvShockPoints = raw === '' ? 0 : _numberOrNull(raw);
            _writeStressLinkedMemory();
            _renderStressTest();
        });
        $('stress-base-price').addEventListener('input', (inputEvent) => {
            state.stressBasePrice = _numberOrNull(inputEvent.target.value);
            _renderStressTest();
        });
        $('stress-range').addEventListener('change', (changeEvent) => {
            state.stressRangePct = Number(changeEvent.target.value) || 30;
            _renderStressTest();
        });
        $('stress-include-long-options').addEventListener('change', (changeEvent) => {
            state.stressIncludeLongOptions = changeEvent.target.checked;
            _renderStressTest();
            if (state.stressIncludeLongOptions && !state.stressLongOptionInputs) {
                _refreshStressMarketInputs(false);
            }
        });
        $('btn-stress-refresh-price').addEventListener('click', _refreshStressPrice);
        globalScope.document.addEventListener('keydown', (keyEvent) => {
            if (keyEvent.key === 'Escape' && state.stressOpen) _closeStressTest();
        });
        $('btn-open-summary-details').addEventListener('click', () => {
            const details = $('summary-details');
            details.open = true;
            details.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        $('btn-fetch-executions').addEventListener('click', _fetchTwsExecutions);

        if (importer) {
            $('import-replace').addEventListener('change', _handleImportReplaceChange);
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
        currencySymbol: _currencySymbol,
        formatCurrencyAmount: _currencyAmount,
        computeMarketMetrics,
        calculateBsmOptionPrice,
        calculateBsmPutPrice,
        estimateDeferredLongOptions,
        estimateDeferredShortOptions,
        priceScenarioOption,
        liquidationHaircut,
        bidAskProblem,
        marketDataTypeLabel,
        normalizePricingModel,
        normalizeLiquidation,
        normalizeDividendYield,
        DIVIDEND_YIELD_DEFAULTS,
        estimateLinkedLongOptions,
        leveragedDragLog,
        normalizeLinkedMapping,
        normalizeLinkedSigma,
        mapLinkedUnderlyingPrice,
        normalizeLinkedRatio,
        normalizeIvShockPoints,
        normalizeLinkedIvMode,
        normalizeLinkedIvBeta,
        normalizeStressHorizonDays,
        normalizeLinkedTenorDays,
        stressComponentNumbers,
        findOptionQuote: _findOptionQuote,
        optionQuoteIdentityConflict: _optionQuoteIdentityConflict,
        addDaysToDigits,
        tenorDampingFactor,
        linkedIvShockPointsAt,
        chooseLinkedBook,
        LINKED_HEDGE_DEFAULTS,
        buildStressTestSeries,
        describeHeadlineCost,
        planReconcileDisclosure,
        bookScopedStateReset,
        pruneReferencePrices,
        canReconcilePositions,
        buildLedgerPositionPreview,
        buildImportBaseline,
        planTargetExecutionReconciliation,
        targetExecutionProblems,
        planTwsBaselineSupersession,
        planExecutionReportAliases,
        planImportExecutionAliases,
        isCurrentEventLoad,
        loadSelectedBookSafely,
        chooseManualSubmitToken,
    };
})(typeof window !== 'undefined' ? window : globalThis);
