/* DOM-free stress pricing and scenario assumptions. No ledger writes or transport. */
(function (globalScope) {
    'use strict';
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
    // less, like (reference tenor / remaining days)^p capped at 1; p defaults
    // to the historical fit below (sqrt would be p = 0.5).
    const LINKED_IV_DEFAULT_TENOR_DAYS = 30;
    // Damping exponent for (reference / remaining days)^p. Across seven QQQ
    // crashes in 2015-2025, per-contract implied p has median 0.64 while the
    // log least-squares fit is 0.76 (scripts/skew_regime_study.py); 0.65 keeps
    // the robust median-side estimate. OTM put IV at ~1 year moved only
    // ~0.15-0.2 of the front shift. ATM-only shifts decay closer to the
    // square-root rule (p = 0.5), kept as an option.
    // (An earlier 0.25 default came from a numerator mix-up in the study and
    // was withdrawn - Review 19.3.)
    const LINKED_IV_DEFAULT_TENOR_EXPONENT = 0.65;
    // Version only the research-backed IV controls, never the price mapping,
    // leverage ratio, path sigma, dividend yield or the user's saved choices.
    const IV_RESEARCH_PROFILE = Object.freeze({
        version: 'qqq-iv-2026-09-05',
        settings: Object.freeze({ ivMode: 'beta', ivBetaAuto: true,
            ivTenorDamping: true, ivTenorDays: LINKED_IV_DEFAULT_TENOR_DAYS,
            ivTenorExponent: LINKED_IV_DEFAULT_TENOR_EXPONENT, ivOtmDiscount: true }),
    });
    function ivResearchProfileStatus(settings, reviewedVersion) {
        const s = settings || {};
        const baseline = Object.entries(IV_RESEARCH_PROFILE.settings).every(([key, value]) => s[key] === value);
        return { baseline, kind: s.ivMode === 'none' ? 'none' : (baseline ? 'research' : 'custom'),
            needsReview: reviewedVersion !== IV_RESEARCH_PROFILE.version,
            version: IV_RESEARCH_PROFILE.version };
    }
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
     * binomial approximation (not a claim to reproduce the TWS model),
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
        if (Number(spot) < 0 || Number(timeYears) < 0) return null;
        if (Number(spot) === 0 && Number(timeYears) > 0) {
            return optionRight === 'C' ? 0
                : Number(strike) * Math.max(1, Math.exp(-Number(rate) * Number(timeYears)));
        }
        if (Number(timeYears) <= 0) {
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
    function stressComponentNumbers(showConvexity, showShorts, showLinked, showPremium) {
        const circled = ['①', '②', '③', '④', '⑤'];
        let next = 1;
        const own = showConvexity ? circled[next++] : '';
        const shorts = showShorts ? circled[next++] : '';
        const linked = showLinked ? circled[next++] : '';
        const premium = showPremium ? circled[next++] : '';
        const parts = ['①'];
        if (own) parts.push(own);
        if (shorts) parts.push(shorts);
        if (linked) parts.push(linked);
        if (premium) parts.push(premium);
        return { own, shorts, linked, premium, total: parts.join('+') };
    }

    /** Assumed premium income per week; blank means none, negative is invalid. */
    function normalizeWeeklyPremium(value) {
        if (value === null || value === undefined || value === '') return 0;
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0) return null;
        return amount;
    }

    /** Flat weekly income scaled by days / 7: an assumption, never a forecast. */
    function premiumIncomeOver(weeklyPremium, scenarioDays) {
        const weekly = Number(weeklyPremium) || 0;
        const days = Number(scenarioDays);
        if (weekly <= 0 || !Number.isFinite(days) || days <= 0) return 0;
        return weekly * days / 7;
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

    /**
     * (reference / remaining days)^exponent, never above 1, never below a
     * day. Exponent 0.5 is the textbook square-root rule; the historical QQQ
     * crash sample gives a per-contract median near 0.64 and log least-squares
     * fit near 0.76 for the OTM-put IV level shift by tenor.
     */
    function tenorDampingFactor(remainingDays, referenceDays, exponent) {
        const remaining = Math.max(1, Number(remainingDays));
        const reference = Number(referenceDays);
        const power = normalizeLinkedTenorExponent(exponent);
        if (!Number.isFinite(remaining) || !Number.isFinite(reference) || reference <= 0
            || power === null) return 1;
        return Math.min(1, Math.pow(reference / remaining, power));
    }

    function normalizeLinkedTenorExponent(value) {
        if (value === null || value === undefined || value === '') return LINKED_IV_DEFAULT_TENOR_EXPONENT;
        const power = Number(value);
        if (!Number.isFinite(power) || power < 0.05 || power > 1) return null;
        return power;
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
    // Spot-vol beta by size of the index drop, from the QQQ daily series
    // 2012-2026 pooled over 5-40 day holding periods (part A1b of
    // scripts/stress_model_validation.py, rounded to 0.05): 0.90 for 2-5%
    // drops (n=1563), 0.95 for 5-10% (n=809), 1.00 for 10-20% (n=274),
    // 1.65 above 20% (n=22, thin). Keyed on bucket midpoints.
    const AUTO_BETA_TABLE = Object.freeze([[0, 0.9], [3.5, 0.9], [7.5, 0.95], [15, 1.0], [25, 1.65]]);
    // OTM puts rose less than ATM in every crash: 10-20% OTM got a median
    // 0.50 of the ATM shift where ATM rose >= 2 points (part B1, n=33).
    // Full shock inside 5% of the money, linear down to the floor at 10%
    // away, flat beyond. Measured on puts only - see otmShockFactor.
    const OTM_SHOCK_FLOOR = 0.5;
    // Realised vol ran 1.43x the starting ATM IV in 20-day windows that fell
    // 8% or more (part A2); the compounding drag uses sigma^2, so the proxy
    // is scaled up as the index drop approaches that size.
    const CRASH_SIGMA_SCALE = 1.4;
    const CRASH_SIGMA_FULL_DROP_PCT = 8;

    function autoBetaForDrop(dropPct) {
        const drop = Math.abs(Number(dropPct));
        if (!Number.isFinite(drop)) return AUTO_BETA_TABLE[0][1];
        const table = AUTO_BETA_TABLE;
        if (drop <= table[0][0]) return table[0][1];
        if (drop >= table[table.length - 1][0]) return table[table.length - 1][1];
        for (let index = 1; index < table.length; index += 1) {
            const [x0, y0] = table[index - 1];
            const [x1, y1] = table[index];
            if (drop <= x1) return y0 + (y1 - y0) * (drop - x0) / (x1 - x0);
        }
        return table[table.length - 1][1];
    }

    /**
     * Discount on the IV shock for OUT-OF-THE-MONEY PUTS only: that is the
     * population the crash study measured (part B1). ITM puts and calls of
     * either side keep the full shock; nothing is extrapolated to them.
     */
    function otmShockFactor(strike, spot, right) {
        const k = Number(strike);
        const s = Number(spot);
        if (!Number.isFinite(k) || !Number.isFinite(s) || k <= 0 || s <= 0) return 1;
        if (String(right || '').toUpperCase().slice(0, 1) !== 'P' || k >= s) return 1;
        const moneyness = Math.abs(Math.log(k / s));
        if (moneyness <= 0.05) return 1;
        if (moneyness >= 0.10) return OTM_SHOCK_FLOOR;
        return 1 - (1 - OTM_SHOCK_FLOOR) * (moneyness - 0.05) / 0.05;
    }

    function crashSigmaScale(indexDropPct) {
        const drop = Math.max(0, -Number(indexDropPct));
        if (!Number.isFinite(drop)) return 1;
        return 1 + (CRASH_SIGMA_SCALE - 1) * Math.min(1, drop / CRASH_SIGMA_FULL_DROP_PCT);
    }

    function linkedIvShockPointsAt(mode, linkedChangePct, fixedPoints, beta, betaAuto) {
        if (mode === 'fixed') return Number(fixedPoints) || 0;
        if (mode === 'beta') {
            const drop = Number(linkedChangePct);
            if (!Number.isFinite(drop) || drop >= 0) return 0;
            const applied = betaAuto === true ? autoBetaForDrop(drop) : (Number(beta) || 0);
            return applied * (-drop);
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
     * For a single ideal daily reset, simple returns apply: −30% / 3 = −10%.
     * The power/variance formula is only a multi-day continuous-rebalancing
     * approximation; an endpoint cannot determine the actual daily path.
     * The ratio is signed so an
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
        // A single daily reset targets simple returns. The diffusion formula
        // below is only a MULTI-DAY approximation conditional on variance.
        if (mapping === 'linear' || !(Number(opts.timeYears) > 1 / 365)) {
            return Math.max(0, base * (1 + change / 100 / normalizedRatio));
        }
        const gross = 1 + change / 100;
        if (gross < 0 || (gross === 0 && normalizedRatio < 0)) return null;
        if (gross === 0) return 0;
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
            const ivTenorExponent = normalizeLinkedTenorExponent(remembered.ivTenorExponent);
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
                ivTenorExponent: ivTenorExponent === null
                    ? LINKED_IV_DEFAULT_TENOR_EXPONENT : ivTenorExponent,
                ivBetaAuto: remembered.ivBetaAuto !== false,
                ivOtmDiscount: remembered.ivOtmDiscount !== false,
                sigmaCrashScale: remembered.sigmaCrashScale !== false,
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
            ivTenorExponent: LINKED_IV_DEFAULT_TENOR_EXPONENT,
            ivBetaAuto: true,
            ivOtmDiscount: true,
            sigmaCrashScale: true,
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
        const ivTenorExponent = ivTenorDamping
            ? normalizeLinkedTenorExponent(linkedHedge.ivTenorExponent)
            : LINKED_IV_DEFAULT_TENOR_EXPONENT;
        if (ivTenorExponent === null) return { reason: 'invalid_linked_tenor_exponent' };
        return {
            reason: '',
            ratio,
            basePrice,
            ivMode,
            ivShockPoints,
            ivBeta,
            ivBetaAuto: ivMode === 'beta' && linkedHedge.ivBetaAuto === true,
            // 'fixed' means the same points on every contract, so the OTM
            // discount belongs to the beta mode only (Review 21.3).
            ivOtmDiscount: ivMode === 'beta' && linkedHedge.ivOtmDiscount === true,
            sigmaCrashScale: linkedHedge.sigmaCrashScale === true,
            ivTenorDamping,
            ivTenorDays,
            ivTenorExponent,
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

    globalScope.OptionComboCostBasisStressModels = Object.freeze({
        LINKED_HEDGE_DEFAULTS,
        LINKED_HEDGE_DEFAULT_RATIO,
        LINKED_HEDGE_MIN_ABS_RATIO,
        LINKED_IV_MODES,
        LINKED_IV_DEFAULT_BETA,
        LINKED_IV_MAX_BETA,
        LINKED_IV_DEFAULT_TENOR_DAYS,
        LINKED_IV_DEFAULT_TENOR_EXPONENT,
        IV_RESEARCH_PROFILE,
        ivResearchProfileStatus,
        LINKED_MAX_HORIZON_DAYS,
        DAY_MS,
        STRESS_HORIZON_DEBOUNCE_MS,
        STRESS_LIQUIDATIONS,
        STRESS_PRICING_MODELS,
        AMERICAN_BINOMIAL_STEPS,
        DIVIDEND_YIELD_DEFAULTS,
        _normalCdf,
        calculateBsmOptionPrice,
        normalizePricingModel,
        normalizeLiquidation,
        normalizeDividendYield,
        priceScenarioOption,
        bidAskProblem,
        liquidationHaircut,
        calculateBsmPutPrice,
        _dateUtcFromDigits,
        _quoteMatchesTerms,
        _findOptionQuote,
        _optionQuoteIdentityConflict,
        normalizeIvShockPoints,
        stressComponentNumbers,
        normalizeWeeklyPremium,
        premiumIncomeOver,
        normalizeStressHorizonDays,
        normalizeLinkedTenorDays,
        addDaysToDigits,
        tenorDampingFactor,
        normalizeLinkedTenorExponent,
        normalizeLinkedIvMode,
        normalizeLinkedIvBeta,
        AUTO_BETA_TABLE,
        OTM_SHOCK_FLOOR,
        CRASH_SIGMA_SCALE,
        CRASH_SIGMA_FULL_DROP_PCT,
        autoBetaForDrop,
        otmShockFactor,
        crashSigmaScale,
        linkedIvShockPointsAt,
        normalizeLinkedRatio,
        LINKED_MAPPINGS,
        normalizeLinkedMapping,
        normalizeLinkedSigma,
        leveragedDragLog,
        mapLinkedUnderlyingPrice,
        PATH_SIGMA_PROXY_FAR_PCT,
        marketDataTypeLabel,
        _proxyPathSigma,
        chooseLinkedBook,
        _prepareLinkedHedge
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
