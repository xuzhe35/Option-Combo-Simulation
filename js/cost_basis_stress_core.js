/* Canonical, read-only stress valuation. Cost-only virtual deliveries never persist. */
(function (g) {
    'use strict';
    const M = g.OptionComboCostBasisStressModels;
    const L = g.OptionComboCostBasisCore;
    const DAY = 86400000;
    const YEAR = 365 * DAY;
    const VERSION = 'stress-v2';
    // Private, detached ledger inputs and cost cache. IV-band members share the
    // same delivery outcomes, so they must not replay history for every member.
    const costProjections = new WeakMap();
    const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    const fail = reason => { throw new Error(reason); };
    const number = (v, reason) => finite(v) ? Number(v) : fail(reason);
    const digits = v => String(v || '').replace(/\D/g, '').slice(0, 8);
    function immutable(value) {
        if (!value || typeof value !== 'object') return value;
        return Object.freeze(Array.isArray(value) ? value.map(immutable)
            : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
    }

    function exchangeDate(instant = Date.now()) {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
            year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
        const value = type => parts.find(p => p.type === type).value;
        return value('year') + value('month') + value('day');
    }

    // Date-only inputs are explicit exchange-local assumptions, never UTC midnight.
    function exchangeTime(date, hour = 16, minute = 0) {
        const d = digits(date);
        const utc = M._dateUtcFromDigits(d);
        if (utc === null) fail('invalid_stress_date');
        let at = utc + hour * 3600000 + minute * 60000;
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
            minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        for (let i = 0; i < 2; i++) {
            const parts = formatter.formatToParts(new Date(at));
            const v = key => Number(parts.find(p => p.type === key).value);
            const wall = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
            at += utc + hour * 3600000 + minute * 60000 - wall;
        }
        return at;
    }

    function instant(value) {
        if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
        const at = Date.parse(value);
        return Number.isFinite(at) ? at : null;
    }

    function cutoff(position, quote, warnings) {
        const exact = instant(quote && quote.expiryAsOf);
        if (exact !== null) return exact;
        warnings.add('expiry_close_assumption');
        // Conservative explicit fallback; exchange-specific / half-day metadata
        // must come from ContractDetails, not a guessed product-wide promise.
        return exchangeTime(position.expiry);
    }

    function resolveRate(inputs, expiry, remainingDays) {
        // Static tenor-curve roll assumption, not a forecast of future rates
        // and not a forward-discount ratio between two absolute dates.
        if (remainingDays <= 0) return 0;
        if (inputs && inputs.discountCurve && g.OptionComboMarketCurves) {
            try {
                const curves = g.OptionComboMarketCurves;
                const curve = curves.createDiscountCurveFromSnapshot(inputs.discountCurve);
                if (curve.currency !== 'USD') fail('unsupported_stress_currency');
                const resolved = curves.resolveDiscount(curve, { tenorDays: remainingDays });
                if (!resolved || resolved.usable === false) fail('missing_discount_rate');
                return number(resolved.zeroRate, 'missing_discount_rate');
            } catch (_) { fail('missing_discount_rate'); }
        }
        // Explicit legacy/test fixture rate assumption. Production v2 snapshots
        // include the curve so both current and future fractional tenors resolve.
        const row = ((inputs && inputs.ratesByExpiry) || []).find(r => r.expiry === expiry);
        return number(row && row.zeroRate, 'missing_discount_rate');
    }

    function calibrate(position, spot, time, rate, mark, settings) {
        const price = iv => M.priceScenarioOption(position.right, spot, position.strike,
            time, rate, iv, settings);
        const tolerance = Math.max(1e-5, mark * 1e-7);
        let lo = 0, hi = 8;
        const lowPrice = price(lo), highPrice = price(hi);
        if (!finite(lowPrice) || !finite(highPrice)) fail('missing_american_pricer');
        if (mark < lowPrice - tolerance || mark > highPrice + tolerance) fail('quote_outside_model_bounds');
        if (Math.abs(lowPrice - mark) <= tolerance) return { iv: 0, residual: lowPrice - mark };
        let best = { iv: hi, residual: highPrice - mark };
        for (let i = 0; i < 48; i++) {
            const iv = (lo + hi) / 2;
            const value = price(iv);
            if (!finite(value)) fail('calibration_failed');
            const residual = value - mark;
            if (Math.abs(residual) < Math.abs(best.residual)) best = { iv, residual };
            if (Math.abs(residual) <= tolerance) return best;
            if (residual < 0) lo = iv; else hi = iv;
        }
        if (Math.abs(best.residual) > tolerance) fail('calibration_failed');
        return best;
    }

    function compilePositions(positions, inputs, settings, asOf, target, warnings, linked) {
        return positions.map(position => {
            try {
                const side = linked ? 'linked' : (Number(position.contracts) > 0 ? 'long_option' : 'short_option');
                const error = linked ? 'incomplete_linked_option' : `incomplete_${side}`;
                const contracts = number(position.contracts, error);
                const multiplier = number(position.sharesPerContract, error);
                const strike = number(position.strike, error);
                if (!contracts || multiplier <= 0 || strike <= 0 || position.identityConflict
                    || !['C', 'P'].includes(position.right)) fail(error);
                const quote = M._findOptionQuote(inputs && inputs.options, position);
                const expiryAt = cutoff(position, quote, warnings);
                if (expiryAt < asOf) fail('expired_open_position_reconcile');
                const openPremium = number(position.openPremium, error);
                // A cost-only expiry calculation needs no current quote. ΔNAV and
                // any surviving option do. Same compiler/valuator handles both.
                const needsQuote = settings.pnlBasis === 'change' || linked || expiryAt > target;
                let mark = null, haircut = 1, iv = null, residual = null, rate = 0, referenceReason = '';
                const spot = inputs && finite(inputs.underlyingPrice) ? Number(inputs.underlyingPrice) : null;
                // Even a cost-only settled leg may have a usable TODAY quote
                // for the side-by-side change lens. Optional evidence must
                // never block an otherwise quote-free expiry payoff.
                try {
                    if (!inputs) fail(linked ? 'missing_linked_market_inputs' : `missing_${side}_market_inputs`);
                    if (!quote) fail(M._optionQuoteIdentityConflict(inputs.options, position)
                        ? (linked ? 'linked_option_identity_mismatch' : `${side}_identity_mismatch`)
                        : (linked ? 'missing_linked_mark' : `missing_${side}_iv`));
                    if (!(Number(position.conId) > 0) && !String(position.localSymbol || '').trim()
                        && (inputs.options || []).filter(q => M._quoteMatchesTerms(q, position)).length !== 1) fail('quote_identity_conflict');
                    if (quote.currency && quote.currency !== 'USD') fail('unsupported_stress_currency');
                    // Strong IDs must not silently hide contradictory deliverables.
                    if ((finite(quote.strike) && Math.abs(Number(quote.strike) - strike) > 1e-8)
                        || (quote.right && quote.right !== position.right)
                        || (quote.expiry && digits(quote.expiry) !== digits(position.expiry))
                        || (finite(quote.multiplier) && Number(quote.multiplier) !== multiplier)) {
                        fail('quote_identity_conflict');
                    }
                    if (!(spot > 0)) fail('invalid_snapshot_underlying_price');
                    mark = number(quote.mark, linked ? 'missing_linked_mark' : 'missing_option_mark');
                    if (mark < 0) fail('missing_option_mark');
                    const problem = M.bidAskProblem(quote);
                    if (problem === 'crossed') fail('invalid_option_bid_ask');
                    if (settings.liquidation === 'bidask') {
                        if (problem) fail('missing_option_quote_sides');
                        const sidePrice = Number(contracts > 0 ? quote.bid : quote.ask);
                        if (mark === 0 && sidePrice !== 0) fail('invalid_option_bid_ask');
                        haircut = mark === 0 ? 1 : sidePrice / mark;
                    }
                    if (quote.marketDataType !== 1) warnings.add('non_live_or_unknown_quotes');
                    if (expiryAt > target) {
                        rate = resolveRate(inputs, position.expiry, (expiryAt - asOf) / DAY);
                        const fit = calibrate(position, spot, (expiryAt - asOf) / YEAR, rate, mark, settings);
                        iv = fit.iv; residual = fit.residual;
                    }
                } catch (error) {
                    if (needsQuote) throw error;
                    referenceReason = error.message;
                    mark = null; haircut = 1;
                }
                const futureRate = expiryAt > target ? resolveRate(inputs, position.expiry, (expiryAt - target) / DAY) : 0;
                return { ...position, contracts, multiplier, strike, openPremium, expiryAt, iv, residual,
                    quoteSpot: spot, mark, haircut, rate, futureRate, referenceReason, dividendYield: settings.dividendYield,
                    referenceValue: mark === null ? null : contracts * multiplier * mark * haircut };
            } catch (error) {
                error.contract = { conId: position.conId || null, localSymbol: position.localSymbol || '',
                    expiry: position.expiry, right: position.right, strike: position.strike, linked };
                throw error;
            }
        });
    }

    function compile(events, options = {}) {
        try {
            const opts = immutable(options);
            if ((opts.currency || 'USD') !== 'USD' || (opts.secType || 'STK') !== 'STK') fail('unsupported_stress_currency');
            const centerPrice = number(opts.centerPrice, 'invalid_center_price');
            if (centerPrice <= 0) fail('invalid_center_price');
            const warnings = new Set();
            const inputs = opts.longOptionInputs;
            const linked = M._prepareLinkedHedge(opts.linkedHedge, 'USD');
            if (linked && linked.reason) fail(linked.reason);
            const asOf = instant(opts.asOfInstant) ?? instant(inputs && inputs.fetchedAt)
                ?? instant(linked && linked.marketInputs.fetchedAt)
                ?? exchangeTime(opts.asOf || exchangeDate(), 12);
            if (!instant(opts.asOfInstant) && !instant(inputs && inputs.fetchedAt)
                && !instant(linked && linked.marketInputs.fetchedAt)) warnings.add('reference_time_assumption');
            if (opts.asOfInstant && instant(opts.asOfInstant) === null) fail('invalid_stress_instant');
            if (opts.targetInstant && instant(opts.targetInstant) === null) fail('invalid_stress_instant');
            const horizon = opts.horizonDays === null || opts.horizonDays === undefined ? null
                : M.normalizeStressHorizonDays(opts.horizonDays);
            if (horizon === undefined) fail('invalid_horizon');
            const target = instant(opts.targetInstant) ?? (horizon !== null ? asOf + horizon * DAY : exchangeTime(opts.throughExpiry));
            if (target < asOf) fail('scenario_before_snapshot');
            const settings = { pricingModel: M.normalizePricingModel(opts.pricingModel),
                liquidation: M.normalizeLiquidation(opts.liquidation),
                dividendYield: M.normalizeDividendYield(opts.dividendYield),
                pnlBasis: opts.pnlBasis === 'change' ? 'change' : 'cost' };
            if (!settings.pricingModel) fail('invalid_pricing_model');
            if (!settings.liquidation) fail('invalid_liquidation');
            if (settings.dividendYield === null) fail('invalid_dividend_yield');
            const path = opts.path || 'immediate';
            if (!['immediate', 'gradual'].includes(path)) fail('invalid_stress_path');
            if (opts.ivDriver) {
                const driver = opts.ivDriver;
                if (M.normalizeLinkedIvMode(driver.ivMode) === null
                    || (driver.ivMode === 'beta' && M.normalizeLinkedIvBeta(driver.ivBeta ?? 1.5) === null)
                    || (driver.ivMode === 'fixed' && M.normalizeIvShockPoints(driver.ivShockPoints) === null)
                    || (driver.ivMode === 'beta' && driver.ivTenorDamping
                        && (M.normalizeLinkedTenorDays(driver.ivTenorDays) === null
                            || M.normalizeLinkedTenorExponent(driver.ivTenorExponent) === null))) fail('invalid_iv_driver');
            }
            const ledgerEvents = immutable(Array.isArray(events) ? events : []);
            const ledger = L.computeLedger(ledgerEvents, { secType: opts.secType || 'STK' });
            if (ledger.combined.costIncomplete && settings.pnlBasis === 'cost') fail('incomplete_cost_basis');
            const all = ledger.openOptions || [];
            const included = all.filter(p => opts.includeDeferredLongOptions === true
                || cutoff(p, M._findOptionQuote(inputs && inputs.options, p), warnings) <= target);
            if (included.length !== all.length) warnings.add('partial_portfolio_excludes_deferred');
            const snapshots = [inputs, linked && linked.marketInputs].filter(Boolean);
            if (linked && (!finite(linked.marketInputs.underlyingPrice)
                || Math.abs(linked.basePrice - Number(linked.marketInputs.underlyingPrice)) > 1e-8)) fail('invalid_linked_underlying_price');
            for (const snapshot of snapshots) {
                if (opts.requireSnapshotVersion && !(snapshot.snapshotVersion >= opts.requireSnapshotVersion)) fail('snapshot_upgrade_required');
                if (snapshot.currency && snapshot.currency !== 'USD') fail('unsupported_stress_currency');
                if (snapshot.throughExpiry && snapshot.throughExpiry !== opts.throughExpiry) fail('stale_scenario_snapshot');
                if (snapshot.snapshotVersion >= 2 && !snapshot.discountCurve && included.some(p => digits(p.expiry) > opts.throughExpiry)) fail('missing_discount_rate');
                const at = instant(snapshot.fetchedAt);
                if (snapshot.snapshotVersion >= 2 && at === null) fail('invalid_snapshot_time');
                if (at !== null && Math.abs(at - asOf) > 60000) fail('snapshot_time_mismatch');
                if (instant(snapshot.underlyingObservedAt) === null
                    || (snapshot.options || []).some(q => instant(q.observedAt) === null)) warnings.add('quote_receipt_time_missing');
                const quoteTimes = [snapshot.underlyingObservedAt, ...(snapshot.options || []).map(q => q.observedAt)]
                    .map(instant).filter(t => t !== null);
                if (quoteTimes.some(t => Math.abs(t - asOf) > 60000)) fail('snapshot_time_mismatch');
            }
            const own = compilePositions(included, inputs, settings, asOf, target, warnings, false);
            const linkedPositions = linked ? compilePositions(linked.openOptions.filter(p => Number(p.contracts) > 0),
                linked.marketInputs, { ...settings, dividendYield: linked.dividendYield }, asOf, target, warnings, true) : [];
            const referenceSpot = inputs && finite(inputs.underlyingPrice) ? Number(inputs.underlyingPrice) : centerPrice;
            const baseCash = number(ledger.combined.lifetimeNetCash, 'incomplete_cost_basis')
                - all.reduce((sum, p) => sum + number(p.openPremium, 'incomplete_cost_basis'), 0);
            let proxy = linked && linked.sigma === null ? M._proxyPathSigma(linked.marketInputs, exchangeDate(asOf)) : null;
            if (proxy) proxy.ivSource = 'broker';
            if (linked && linked.sigma === null && !proxy && linked.mapping === 'compound' && target - asOf > DAY) {
                // TWS may deliver usable marks without greeks. The local IV
                // already calibrated for valuation is equally usable as an
                // explicitly labelled path-sigma proxy, not a realized-vol forecast.
                const quotes = linkedPositions.filter(p => p.expiryAt > asOf).map(p => {
                    let iv = p.iv;
                    if (iv === null) {
                        // Even a leg expiring before the target can supply a
                        // TODAY proxy. Its scenario payoff still uses no IV.
                        try {
                            const rate = resolveRate(linked.marketInputs, p.expiry, (p.expiryAt - asOf) / DAY);
                            iv = calibrate(p, linked.basePrice, (p.expiryAt - asOf) / YEAR, rate, p.mark,
                                { ...settings, dividendYield: linked.dividendYield }).iv;
                        } catch (_) { iv = null; }
                    }
                    return { expiry: p.expiry, strike: p.strike, impliedVolatility: iv };
                });
                proxy = M._proxyPathSigma({ underlyingPrice: linked.basePrice, options: quotes }, exchangeDate(asOf));
                if (proxy) {
                    proxy.ivSource = 'local_calibration';
                    warnings.add('path_sigma_local_iv_proxy');
                }
            }
            const sigma = linked ? (linked.sigma ?? (proxy && proxy.sigma)) : null;
            if (linked && linked.mapping === 'compound' && target - asOf > DAY && sigma === null) fail('missing_linked_sigma');
            const weekly = M.normalizeWeeklyPremium(opts.weeklyPremium);
            if (weekly === null) fail('invalid_weekly_premium');
            const days = (target - asOf) / DAY;
            const compiled = { available: true, version: VERSION, opts, settings, path, warnings: [...warnings], asOf, target,
                centerPrice, referenceSpot, own, linkedPositions, linked, sigma, proxy, baseCash,
                shares: Number(ledger.combined.shares), costComplete: !ledger.combined.costIncomplete,
                referenceChangeReason: own.some(p => p.referenceValue === null)
                    ? 'missing_reference_quotes' : (Number(ledger.combined.shares) !== 0
                        && !(inputs && finite(inputs.underlyingPrice) && Number(inputs.underlyingPrice) > 0)
                        ? 'missing_reference_spot' : ''),
                currentCost: L.summarizeCost(ledger.combined, opts.basisMode),
                premiumIncome: M.premiumIncomeOver(weekly, days), weeklyPremium: weekly, scenarioDays: days };
            costProjections.set(compiled, { events: ledgerEvents, cache: new Map(),
                // Average/tax basis is path dependent: chronological delivery
                // order matters when shares are reduced or cross through zero.
                settled: own.filter(p => p.expiryAt <= target).slice().sort((a, b) =>
                    a.expiryAt - b.expiryAt || String(a.account).localeCompare(String(b.account))
                    || a.right.localeCompare(b.right) || a.strike - b.strike
                    || String(a.conId || a.localSymbol || '').localeCompare(String(b.conId || b.localSymbol || ''))) });
            return compiled;
        } catch (error) { return { available: false, reason: error.message, contract: error.contract || null, points: [], version: VERSION }; }
    }

    function pathSpot(start, end, at, compiled) {
        if (compiled.path === 'immediate' || compiled.target === compiled.asOf) return end;
        const fraction = Math.max(0, Math.min(1, (at - compiled.asOf) / (compiled.target - compiled.asOf)));
        return start + (end - start) * fraction;
    }

    // Shared instrument valuation. For own options, exercise delivers stock
    // carried to target. Linked options are monetized at expiry, cash held flat.
    function valuePosition(p, end, start, c, shockPoints, driver, member, linked) {
        if (p.expiryAt <= c.target) {
            const spot = pathSpot(start, end, p.expiryAt, c);
            const itm = p.right === 'C' ? spot > p.strike : spot < p.strike;
            const delivered = itm ? p.contracts * p.multiplier * (p.right === 'C' ? 1 : -1) : 0;
            const payoff = p.contracts * p.multiplier * Math.max(p.right === 'C' ? spot - p.strike : p.strike - spot, 0);
            const value = linked ? payoff : delivered * (end - p.strike);
            return { value, delivered: linked ? 0 : delivered,
                settlementCash: linked ? payoff : -delivered * p.strike,
                settled: true, itm, iv: null, shock: 0 };
        }
        let shock = shockPoints / 100;
        if (driver && driver.ivMode === 'beta') {
            if (driver.ivTenorDamping) shock *= M.tenorDampingFactor((p.expiryAt - c.target) / DAY,
                driver.ivTenorDays, member.tenorExponent ?? driver.ivTenorExponent);
            if (driver.ivOtmDiscount && p.right === 'P') {
                const distance = Math.max(0, 1 - p.strike / start);
                const floor = member.otmFloor ?? 0.5;
                shock *= 1 - Math.min(1, Math.max(0, (distance - 0.05) / 0.05)) * (1 - floor);
            }
        }
        const iv = p.iv + shock;
        if (!Number.isFinite(iv) || iv < 0) fail('invalid_option_iv_shock');
        const price = M.priceScenarioOption(p.right, end, p.strike, (p.expiryAt - c.target) / YEAR,
            p.futureRate, iv, { pricingModel: c.settings.pricingModel, dividendYield: p.dividendYield });
        if (!finite(price)) fail('invalid_scenario_price');
        return { value: price * p.contracts * p.multiplier * p.haircut, delivered: 0,
            settled: false, itm: false, iv, shock: shock * 100 };
    }

    function scenarioCost(c, price) {
        const projection = costProjections.get(c);
        if (!projection) fail('missing_cost_projection');
        const outcomes = projection.settled.map(p => valuePosition(p, price, c.referenceSpot,
            c, 0, null, {}, false));
        const key = outcomes.map(v => v.itm ? '1' : '0').join('');
        if (!projection.cache.has(key)) {
            const rows = projection.settled.map((p, i) => {
                const outcome = outcomes[i];
                return { seq: 900000000 + i,
                    // Always append after recorded history, with an identical
                    // clock so seq preserves the sorted expiry order (>60 legs too).
                    tradeDate: '9999-12-31', brokerTimestamp: '9999-12-31T23:59:59',
                    kind: outcome.itm ? (p.contracts < 0 ? 'option_assignment' : 'option_exercise') : 'option_expiry',
                    account: p.account, right: p.right, strike: p.strike, expiry: p.expiry,
                    contracts: -p.contracts, sharesPerContract: p.multiplier,
                    shares: outcome.delivered, price: p.strike, fees: 0,
                    // Delivery only: opening premium is already in history.
                    cashAmount: -outcome.delivered * p.strike,
                    includeInCost: true, source: 'what_if', tag: 'what_if_settlement',
                    conId: p.conId, localSymbol: p.localSymbol || '' };
            });
            const summary = rows.length ? L.computeLedger(projection.events.concat(rows), { secType: 'STK' }).combined : null;
            const cost = summary ? L.summarizeCost(summary, c.opts.basisMode) : c.currentCost;
            projection.cache.set(key, { cost: cost.available && !cost.costIncomplete ? cost.value : null,
                costState: cost.costIncomplete ? 'incomplete' : cost.state,
                shares: summary ? summary.shares : c.shares });
        }
        return projection.cache.get(key);
    }

    function sweep(c, member = {}) {
        if (!c.available) return c;
        try {
            const o = c.opts;
            const rangePct = Math.min(90, Math.max(1, Math.abs(finite(o.rangePct) ? Number(o.rangePct) : 30)));
            const count = Number.isInteger(o.pointCount) ? Math.max(11, Math.min(121, o.pointCount)) : 61;
            const low = c.centerPrice * (1 - rangePct / 100), high = c.centerPrice * (1 + rangePct / 100);
            const linked = c.linked;
            // A local driver makes own-book sensitivity usable without another
            // book. QQQ calibrations are not silently claimed for every symbol.
            const driver = linked || o.ivDriver || { ivMode: 'none' };
            const points = [];
            for (let i = 0; i < count; i++) {
                const price = low + (high - low) * i / (count - 1);
                const actualChange = (price / c.referenceSpot - 1) * 100;
                const sigmaScale = linked && linked.sigmaCrashScale ? M.crashSigmaScale(actualChange / linked.ratio) : 1;
                const mapped = linked ? M.mapLinkedUnderlyingPrice(linked.basePrice, actualChange, linked.ratio,
                    { mapping: linked.mapping, sigma: c.sigma === null ? null : c.sigma * sigmaScale,
                        timeYears: (c.target - c.asOf) / YEAR }) : null;
                if (linked && !finite(mapped)) fail('invalid_linked_underlying_price');
                const driverChange = linked ? (mapped / linked.basePrice - 1) * 100 : actualChange;
                const beta = driver.ivBetaAuto ? M.autoBetaForDrop(driverChange) : (driver.ivBeta ?? 1.5);
                let shock = M.linkedIvShockPointsAt(driver.ivMode, driverChange, driver.ivShockPoints || 0, beta, false);
                if (driver.ivMode === 'beta') shock *= member.betaScale ?? 1;
                if (member.flatIv) shock = 0;
                const ownShock = shock * (linked ? Math.abs(linked.ratio) : 1);
                const point = { price, changePct: (price / c.centerPrice - 1) * 100,
                    basePnl: c.settings.pnlBasis === 'change' ? c.shares * (price - c.referenceSpot) : c.baseCash + c.shares * price,
                    shares: c.shares, assignedContracts: 0, exercisedContracts: 0, expiredContracts: 0, unresolvedCount: 0,
                    ownIvShockPoints: ownShock, linkedPrice: mapped, linkedChangePct: linked ? driverChange : null,
                    linkedIvShockPoints: shock, linkedIvBetaApplied: driverChange < 0 ? beta * (member.betaScale ?? 1) : null,
                    linkedSigmaScale: sigmaScale, linkedSigmaApplied: c.sigma === null ? null : c.sigma * sigmaScale,
                    convexityAvailable: true, shortAvailable: true, linkedAvailable: true,
                    convexityReason: '', shortReason: '', linkedReason: '',
                    longOptionPnl: 0, shortOptionPnl: 0, linkedPnl: 0, linkedPremiumPnl: 0,
                    longOptionCount: 0, longOptionContracts: 0, shortOptionCount: 0, shortOptionContracts: 0,
                    longCallContracts: 0, longPutContracts: 0, shortCallContracts: 0, shortPutContracts: 0,
                    linkedCount: 0, linkedContracts: 0, linkedCallContracts: 0, linkedPutContracts: 0,
                    longOptionMarketValue: 0, shortOptionLiability: 0, linkedMarketValue: 0, linkedReferenceValue: 0,
                    settlementCashPaid: 0, settlementCashReceived: 0, settlementCashNet: 0,
                    linkedSettlementCash: 0,
                    cashflowPnl: c.costComplete ? c.baseCash + c.shares * price : null,
                    snapshotChangePnl: c.referenceChangeReason ? null : c.shares * (price - c.referenceSpot),
                    linkedSettledContracts: 0, linkedDeferredContracts: 0, linkedExpiredContracts: 0 };
                const details = [];
                for (const [positions, isLinked] of [[c.own, false], [c.linkedPositions, true]]) {
                    for (const p of positions) {
                        const value = valuePosition(p, isLinked ? mapped : price, isLinked ? linked.basePrice : c.referenceSpot,
                            c, isLinked ? shock : ownShock, driver, member, isLinked);
                        const pnl = value.value + (isLinked || c.settings.pnlBasis === 'change' ? -p.referenceValue : p.openPremium);
                        if (!finite(pnl)) fail('missing_reference_value');
                        const prefix = isLinked ? 'linked' : (p.contracts > 0 ? 'longOption' : 'shortOption');
                        point[`${prefix}Pnl`] += pnl;
                        point[`${prefix}Count`] = (point[`${prefix}Count`] || 0) + 1;
                        point[`${prefix}Contracts`] = (point[`${prefix}Contracts`] || 0) + Math.abs(p.contracts);
                        const typeKey = `${isLinked ? 'linked' : (p.contracts > 0 ? 'long' : 'short')}${p.right === 'C' ? 'Call' : 'Put'}Contracts`;
                        point[typeKey] = (point[typeKey] || 0) + Math.abs(p.contracts);
                        point[isLinked ? 'linkedMarketValue' : (p.contracts > 0 ? 'longOptionMarketValue' : 'shortOptionLiability')]
                            += p.contracts < 0 ? -value.value : value.value;
                        if (isLinked) {
                            if (point.cashflowPnl !== null) point.cashflowPnl += pnl;
                            if (point.snapshotChangePnl !== null) point.snapshotChangePnl += pnl;
                            if (value.settled) point.linkedSettlementCash += value.settlementCash;
                            point.linkedReferenceValue += p.referenceValue;
                            point.linkedPremiumPnl += value.value + p.openPremium;
                            point[value.settled ? 'linkedSettledContracts' : 'linkedDeferredContracts'] += Math.abs(p.contracts);
                        } else {
                            if (point.cashflowPnl !== null) point.cashflowPnl += value.value + p.openPremium;
                            if (point.snapshotChangePnl !== null) point.snapshotChangePnl += value.value - p.referenceValue;
                            point.shares += value.delivered;
                            if (value.settled) {
                                point[value.itm ? (p.contracts > 0 ? 'exercisedContracts' : 'assignedContracts') : 'expiredContracts'] += Math.abs(p.contracts);
                                point.settlementCashPaid += Math.max(0, -value.settlementCash);
                                point.settlementCashReceived += Math.max(0, value.settlementCash);
                                point.settlementCashNet += value.settlementCash;
                            }
                        }
                        for (const [metric, v] of [['Iv', value.iv], ['Rate', p.futureRate], ['IvShock', value.shock]]) {
                            if (v === null) continue;
                            const min = `${prefix}${metric}${isLinked && metric === 'IvShock' ? 'Points' : ''}Min`;
                            const max = `${prefix}${metric}${isLinked && metric === 'IvShock' ? 'Points' : ''}Max`;
                            point[min] = point[min] === undefined ? v : Math.min(point[min], v);
                            point[max] = point[max] === undefined ? v : Math.max(point[max], v);
                        }
                        details.push({ identity: p.conId || p.localSymbol || `${p.expiry}:${p.right}:${p.strike}`,
                            linked: isLinked, ...value, pnl });
                    }
                }
                const projected = scenarioCost(c, price);
                if (Math.abs(projected.shares - point.shares) > 1e-5) fail('inconsistent_settlement_shares');
                point.cost = projected.cost;
                point.costState = projected.costState;
                point.pnl = point.basePnl + point.longOptionPnl + point.shortOptionPnl;
                point.totalPnl = point.pnl + point.linkedPnl;
                point.premiumIncome = c.premiumIncome;
                point.headlinePnl = point.totalPnl + point.premiumIncome;
                point.details = details;
                if (!Number.isFinite(point.headlinePnl)) fail('invalid_scenario_value');
                points.push(point);
            }
            const first = points[0];
            const series = { available: true, reason: '', version: VERSION, warnings: c.warnings,
                symbol: o.symbol || '', ...c.settings, asOfInstant: new Date(c.asOf).toISOString(),
                referenceChangeReason: c.referenceChangeReason, costComplete: c.costComplete,
                ivAssumptions: Object.fromEntries(['ivMode', 'ivBeta', 'ivBetaAuto', 'ivShockPoints',
                    'ivTenorDamping', 'ivTenorDays', 'ivTenorExponent', 'ivOtmDiscount'].map(key => [key, driver[key]])),
                targetInstant: new Date(c.target).toISOString(), path: c.path,
                throughExpiry: o.throughExpiry, basisMode: o.basisMode || 'net_cash',
                centerPrice: c.centerPrice, referenceSpot: c.referenceSpot, rangePct, low, high, points,
                includeDeferredLongOptions: c.own.length > 0, linkedHedgeEnabled: Boolean(linked),
                inputsFetchedAt: String(o.longOptionInputs && o.longOptionInputs.fetchedAt || ''),
                curveAsOf: String(o.longOptionInputs && (o.longOptionInputs.curveEffectiveDate || o.longOptionInputs.curveAsOf) || ''),
                weeklyPremium: c.weeklyPremium, scenarioDays: c.scenarioDays, premiumIncome: c.premiumIncome,
                premiumIncomeEnabled: c.premiumIncome > 0, centerIndex: Math.floor(count / 2),
                calibration: [...c.own, ...c.linkedPositions].map(p => ({ conId: p.conId, expiry: p.expiry,
                    right: p.right, strike: p.strike, iv: p.iv, residual: p.residual })) };
            for (const [key, value] of Object.entries(first)) {
                if (/^(long|short|linked)/.test(key) && !/(Pnl|Price|Value)$/.test(key)) series[key] = value;
            }
            if (linked) Object.assign(series, {
                linkedSymbol: linked.symbol, linkedBookId: linked.bookId, linkedRatio: linked.ratio,
                linkedBasePrice: linked.basePrice, linkedIvMode: linked.ivMode, linkedIvBeta: linked.ivBeta,
                linkedIvShockPoints: linked.ivShockPoints, linkedIvBetaAuto: linked.ivBetaAuto,
                linkedIvOtmDiscount: linked.ivOtmDiscount, linkedIvTenorDamping: linked.ivTenorDamping,
                linkedIvTenorDays: linked.ivTenorDays, linkedIvTenorExponent: linked.ivTenorExponent,
                linkedSigmaCrashScale: linked.sigmaCrashScale, linkedMapping: linked.mapping,
                linkedDividendYield: linked.dividendYield, linkedSigma: c.sigma,
                linkedSigmaSource: c.scenarioDays <= 1 ? 'instant' : (linked.sigma !== null ? 'assumption' : (c.proxy && c.proxy.far ? 'proxy_far' : 'proxy')),
                linkedSigmaIvSource: c.proxy && c.proxy.ivSource,
                linkedSigmaProxyStrike: c.proxy && c.proxy.strike, linkedSigmaProxyExpiry: c.proxy && c.proxy.expiry,
                linkedSigmaProxyDistancePct: c.proxy && c.proxy.distancePct,
                linkedTimeYears: c.scenarioDays / 365,
                linkedDragLog: c.scenarioDays <= 1 ? 0 : M.leveragedDragLog(linked.ratio, c.sigma, c.scenarioDays / 365),
                linkedReferenceValue: first.linkedReferenceValue,
                linkedInputsFetchedAt: linked.marketInputs.fetchedAt || '' });
            return series;
        } catch (error) { return { available: false, reason: error.message, points: [], version: VERSION }; }
    }

    function buildStressTestSeries(events, options) {
        const c = compile(events, options), series = sweep(c);
        if (!series.available) return series;
        // Same portfolio, spot mapping, date, pricer and quotes; only the
        // assumed IV shock is removed. This is a finite repricing difference,
        // not a delta/vega approximation and not an extra P&L component.
        const driver = c.linked || c.opts.ivDriver || { ivMode: 'none' };
        const flat = driver.ivMode === 'none' ? series : sweep(c, { flatIv: true });
        series.ivExplanationReason = flat.available ? '' : flat.reason;
        series.points.forEach((p, i) => {
            p.flatIvPnl = flat.available ? flat.points[i].totalPnl : null;
            p.ivContribution = flat.available ? p.totalPnl - flat.points[i].totalPnl : null;
        });
        return series;
    }
    g.OptionComboCostBasisStressCore = Object.freeze({ VERSION, compile, sweep, buildStressTestSeries,
        calibrate, exchangeDate, exchangeTime, instant, resolveRate, pathSpot, valuePosition });
})(typeof globalThis !== 'undefined' ? globalThis : this);
