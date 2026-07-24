/**
 * Probability Analysis Charts
 * ============================
 * Provides Monte Carlo simulation (Student-t distribution) and two additional
 * canvas charts:
 *
 *   Chart 2 — Price Probability Density at the simulation date
 *             (t-distribution fill vs. lognormal dashed line)
 *   Chart 3 — Expected P&L Density  =  P&L(s) × f_t(s)
 *
 * Plus a single-number Expected P&L badge = ∫ P&L(s) × f_t(s) ds
 *
 * Depends on globals from:
 *   bsm.js      → calculateOptionPrice()
 *   app.js      → state, diffDays(), calendarToTradingDays(),
 *                 computePortfolioMeanSimIV(), getGlobalChartRange(),
 *                 currencyFormatter
 *   t_params_db.js → T_DIST_PARAMS_DB
 */

'use strict';

function _isGroupIncludedInGlobal(group) {
    return group.includedInGlobal !== false;
}

function _getProbabilityPricingContextApi() {
    return typeof OptionComboPricingContext !== 'undefined' && OptionComboPricingContext
        ? OptionComboPricingContext
        : null;
}

function _getProbabilityProductRegistryApi() {
    return typeof OptionComboProductRegistry !== 'undefined' && OptionComboProductRegistry
        ? OptionComboProductRegistry
        : null;
}

function _getProbabilityPricingCoreApi() {
    return typeof OptionComboPricingCore !== 'undefined' && OptionComboPricingCore
        ? OptionComboPricingCore
        : null;
}

function _getDistributionProxyConfigApi() {
    return typeof OptionComboDistributionProxyConfig !== 'undefined' && OptionComboDistributionProxyConfig
        ? OptionComboDistributionProxyConfig
        : null;
}

// -----------------------------------------------------------------------
// 1.  Monte Carlo Web Worker  (inline blob — works under file:// protocol)
// -----------------------------------------------------------------------
const _MC_WORKER_CODE = `
/**
 * Box-Muller transform: generates one standard Normal sample.
 * Avoids u1 == 0 to prevent log(0).
 */
function boxMuller() {
    let u1;
    do { u1 = Math.random(); } while (u1 <= 1e-15);
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * Math.random());
}

/**
 * Marsaglia-Tsang fast Gamma sampler for Gamma(alpha, 1), alpha >= 1.
 * Reference: Marsaglia & Tsang (2000), "A Simple Method for Generating
 * Gamma Variables", ACM TOMS 26(3).
 *
 * For df/2 = 1.247 (df ≈ 2.494) the acceptance rate is ~98%, so the
 * rejection loop almost never iterates more than once.
 */
function gammaMS(alpha) {
    const d = alpha - 1.0 / 3.0;
    const c = 1.0 / Math.sqrt(9.0 * d);
    for (;;) {
        let x, v;
        do {
            x = boxMuller();
            v = 1.0 + c * x;
        } while (v <= 0.0);
        v = v * v * v;
        const u  = Math.random();
        const x2 = x * x;
        // Fast squeeze test (avoids log most of the time)
        if (u < 1.0 - 0.0331 * x2 * x2) return d * v;
        // Slower but exact log test
        if (Math.log(u) < 0.5 * x2 + d * (1.0 - v + Math.log(v))) return d * v;
    }
}

/**
 * Draw one sample from Student-t(df) scaled to (loc, scale).
 *   t_standard = Normal(0,1) / sqrt( chi2(df) / df )
 *   chi2(df) = 2 * Gamma(df/2, 1)
 */
function tSample(df, loc, scale) {
    const z    = boxMuller();
    const chi2 = 2.0 * gammaMS(df / 2.0);
    return loc + scale * z / Math.sqrt(chi2 / df);
}

/**
 * Fast Normal CDF using A&S polynomial
 */
function normalCDF(x) {
    let sign = (x < 0) ? -1 : 1;
    x = Math.abs(x) / 1.4142135623730951; // Math.sqrt(2.0)
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
}

/**
 * Cox-Ross-Rubinstein American option pricer, inlined from
 * js/american_binomial.js so the price-vs-spot lookup grid is built inside
 * this worker instead of on the main thread. These helpers must stay
 * numerically identical to OptionComboAmericanBinomial.calculateAmericanOptionPrice.
 */
function americanIntrinsic(type, spot, strike) {
    return type === 'call'
        ? Math.max(0, spot - strike)
        : Math.max(0, strike - spot);
}

function americanDeterministicValue(type, spot, strike, rate, dividendYield, rateTime, steps) {
    let best = americanIntrinsic(type, spot, strike);
    for (let index = 1; index <= steps; index += 1) {
        const fraction = index / steps;
        const nodeSpot = spot * Math.exp((rate - dividendYield) * rateTime * fraction);
        const discountedExercise = Math.exp(-rate * rateTime * fraction)
            * americanIntrinsic(type, nodeSpot, strike);
        best = Math.max(best, discountedExercise);
    }
    return best;
}

function americanTreeValue(type, spot, strike, up, down, probabilityUp, discount, steps, values) {
    const nodeRatio = up / down;
    let nodeSpot = spot * Math.pow(down, steps);
    for (let upMoves = 0; upMoves <= steps; upMoves += 1) {
        values[upMoves] = americanIntrinsic(type, nodeSpot, strike);
        nodeSpot *= nodeRatio;
    }
    for (let level = steps - 1; level >= 0; level -= 1) {
        nodeSpot = spot * Math.pow(down, level);
        for (let upMoves = 0; upMoves <= level; upMoves += 1) {
            const continuation = discount * (
                probabilityUp * values[upMoves + 1]
                + (1 - probabilityUp) * values[upMoves]
            );
            const exercise = americanIntrinsic(type, nodeSpot, strike);
            values[upMoves] = Math.max(exercise, continuation);
            nodeSpot *= nodeRatio;
        }
    }
    return Math.max(americanIntrinsic(type, spot, strike), values[0]);
}

/**
 * Build the American price-vs-spot lookup grid in a single pass. The lattice
 * constants (up/down factors, risk-neutral probability, per-step discount)
 * depend only on volatility/rate/dividend/time/steps -- never on spot -- so
 * they are computed once and reused across every grid point, and the scratch
 * value buffer is shared. The fallback conditions (near-zero variance,
 * degenerate probability) likewise depend only on shared inputs, so the branch
 * is decided once rather than per point. Returns a Float64Array; entries are
 * NaN only if the shared inputs are non-finite.
 */
function buildAmericanPriceGrid(params) {
    const type = params.type;
    const gridMin = params.gridMin;
    const gridMax = params.gridMax;
    const points = params.points;
    const strike = params.strike;
    const varianceTime = params.varianceTime;
    const rateTime = params.rateTime;
    const rate = params.rate;
    const volatility = params.volatility;
    const dividendYield = Number.isFinite(params.dividendYield) ? params.dividendYield : 0;
    const steps = Math.min(1001, Math.max(25, Math.round(params.steps)));
    const grid = new Float64Array(points);
    const step = (gridMax - gridMin) / (points - 1);

    if (!(varianceTime > 0)) {
        for (let k = 0; k < points; k += 1) {
            grid[k] = americanIntrinsic(type, gridMin + k * step, strike);
        }
        return grid;
    }

    const varianceStep = varianceTime / steps;
    const rateStep = rateTime / steps;
    const volatilityStep = volatility * Math.sqrt(varianceStep);
    const carryGrowth = Math.exp((rate - dividendYield) * rateStep);

    let useTree = false;
    let up = 0;
    let down = 0;
    let probabilityUp = 0;
    let discount = 0;
    if (Number.isFinite(volatilityStep) && volatilityStep >= 1e-7) {
        up = Math.exp(volatilityStep);
        down = 1 / up;
        probabilityUp = (carryGrowth - down) / (up - down);
        discount = Math.exp(-rate * rateStep);
        useTree = Number.isFinite(probabilityUp)
            && probabilityUp >= 0
            && probabilityUp <= 1;
    }

    const scratch = useTree ? new Float64Array(steps + 1) : null;
    for (let k = 0; k < points; k += 1) {
        const spot = gridMin + k * step;
        grid[k] = useTree
            ? americanTreeValue(type, spot, strike, up, down, probabilityUp, discount, steps, scratch)
            : americanDeterministicValue(type, spot, strike, rate, dividendYield, rateTime, steps);
    }
    return grid;
}

/**
 * Main Worker message handler.
 *
 * Receives:
 *   { df, loc, newScale, stepWeights, nPaths, currentPrice,
 *     minS, maxS, bins, legs }
 *
 * Posts back (with transferable buffers):
 *   { tDensity, binCenters, binWidth, exactExpectedPnL }
 */
self.onmessage = function(e) {
    const { df, loc, newScale, stepWeights, nPaths, currentPrice,
            minS, maxS, bins, legs } = e.data;
    const postError = (code, legId = '', field = '') => {
        self.postMessage({ error: { code, legId, field } });
    };

    if (!Array.isArray(stepWeights) || stepWeights.length === 0
        || stepWeights.some(weight => !Number.isFinite(weight) || weight < 0)) {
        postError('simulation_clock_invalid', '', 'stepWeights');
        return;
    }
    if (!Number.isFinite(df) || df <= 2
        || !Number.isFinite(loc)
        || !Number.isFinite(newScale) || newScale < 0
        || !Number.isFinite(currentPrice) || currentPrice <= 0
        || !Number.isFinite(minS) || !Number.isFinite(maxS) || maxS <= minS
        || !Number.isInteger(bins) || bins <= 0
        || !Number.isInteger(nPaths) || nPaths <= 0
        || (legs !== undefined && !Array.isArray(legs))) {
        postError('simulation_input_invalid');
        return;
    }

    const binWidth = (maxS - minS) / bins;
    if (!Number.isFinite(binWidth) || binWidth <= 0) {
        postError('simulation_input_invalid', '', 'priceRange');
        return;
    }
    const counts   = new Float64Array(bins);   // raw path counts per bin

    // --- Precompute Leg Constants for speed ---
    if (legs) {
        for (let l = 0; l < legs.length; l++) {
            const leg = legs[l];
            if (!leg || typeof leg !== 'object' || Array.isArray(leg)) {
                postError('pricing_input_invalid', '', 'leg');
                return;
            }
            const legId = String(leg.id || '');
            const hasFixedPrice = Object.prototype.hasOwnProperty.call(leg, 'fixedPrice');
            leg.hasFixedPrice = hasFixedPrice;
            if (hasFixedPrice) {
                if (!Number.isFinite(leg.fixedPrice) || leg.fixedPrice < 0) {
                    postError('pricing_input_invalid', legId, 'fixedPrice');
                    return;
                }
            }
            if (!Number.isFinite(leg.posMultiplier) || !Number.isFinite(leg.costBasis)) {
                postError('pricing_input_invalid', legId, 'position');
                return;
            }
            if (leg.hasFixedPrice) continue;

            const hasExpiryUnderlying = Object.prototype.hasOwnProperty.call(
                leg, 'expiryUnderlyingPrice'
            );
            if (hasExpiryUnderlying
                && (!Number.isFinite(leg.expiryUnderlyingPrice)
                    || leg.expiryUnderlyingPrice <= 0)) {
                postError('pricing_input_invalid', legId, 'expiryUnderlyingPrice');
                return;
            }
            const hasFrozenExpiryUnderlying = leg.isExpired === true
                && hasExpiryUnderlying;
            leg.hasFrozenExpiryUnderlying = hasFrozenExpiryUnderlying;
            if (!hasFrozenExpiryUnderlying
                && (!Number.isFinite(leg.underlyingScale) || leg.underlyingScale <= 0)) {
                postError('pricing_underlying_unavailable', legId, 'underlyingScale');
                return;
            }
            if (leg.isUnderlyingLeg) {
                continue;  // No BSM constants needed for delta-one underlying legs
            }
            if (typeof leg.isExpired !== 'boolean') {
                postError('pricing_input_invalid', legId, 'isExpired');
                return;
            }
            if (!['call', 'put'].includes(leg.type)) {
                postError('pricing_input_invalid', legId, 'type');
                return;
            }
            if (!Number.isFinite(leg.strike) || leg.strike <= 0) {
                postError('pricing_input_invalid', legId, 'strike');
                return;
            }
            if (leg.isExpired) continue;

            if (!['bsm-spot', 'black76', 'american-binomial'].includes(leg.pricingModel)) {
                postError('pricing_model_unavailable', legId, 'pricingModel');
                return;
            }
            if (leg.pricingModel === 'american-binomial') {
                let grid = leg.americanPriceGrid;
                if (!Array.isArray(grid) && !ArrayBuffer.isView(grid)) {
                    // Production path: build the price-vs-spot grid here in the
                    // worker so its O(points * steps^2) cost never blocks the
                    // main thread. A prebuilt grid (tests) skips straight to the
                    // shared validation below.
                    if (!['call', 'put'].includes(leg.type)
                        || !Number.isFinite(leg.strike) || leg.strike <= 0
                        || !Number.isFinite(leg.americanGridMin) || leg.americanGridMin <= 0
                        || !Number.isFinite(leg.americanGridMax)
                        || leg.americanGridMax <= leg.americanGridMin
                        || !Number.isInteger(leg.americanGridPoints) || leg.americanGridPoints < 2
                        || !Number.isFinite(leg.varianceT) || leg.varianceT < 0
                        || !Number.isFinite(leg.discountT) || leg.discountT < 0
                        || !Number.isFinite(leg.rate)
                        || !Number.isFinite(leg.volatility) || leg.volatility < 0
                        || !Number.isFinite(leg.binomialSteps) || leg.binomialSteps < 1) {
                        postError('pricing_input_invalid', legId, 'americanGridParams');
                        return;
                    }
                    grid = buildAmericanPriceGrid({
                        type: leg.type,
                        gridMin: leg.americanGridMin,
                        gridMax: leg.americanGridMax,
                        points: leg.americanGridPoints,
                        strike: leg.strike,
                        varianceTime: leg.varianceT,
                        rateTime: leg.discountT,
                        rate: leg.rate,
                        volatility: leg.volatility,
                        dividendYield: leg.dividendYield,
                        steps: leg.binomialSteps,
                    });
                    for (let gridIndex = 0; gridIndex < grid.length; gridIndex += 1) {
                        if (!Number.isFinite(grid[gridIndex])) {
                            postError('american_binomial_grid_unavailable', legId, 'americanPriceGrid');
                            return;
                        }
                    }
                    leg.americanPriceGrid = grid;
                }
                if ((!Array.isArray(grid) && !ArrayBuffer.isView(grid))
                    || grid.length < 2
                    || !Number.isFinite(leg.americanGridMin)
                    || !Number.isFinite(leg.americanGridMax)
                    || leg.americanGridMin <= 0
                    || leg.americanGridMax <= leg.americanGridMin) {
                    postError('pricing_input_invalid', legId, 'americanPriceGrid');
                    return;
                }
                leg.americanGridStep = (
                    leg.americanGridMax - leg.americanGridMin
                ) / (grid.length - 1);
                continue;
            }
            if (!Number.isFinite(leg.rate)
                || !Number.isFinite(leg.varianceT) || leg.varianceT <= 0
                || !Number.isFinite(leg.discountT) || leg.discountT < 0
                || !Number.isFinite(leg.volatility) || leg.volatility <= 0) {
                postError('pricing_input_invalid', legId, 'modelInputs');
                return;
            }

            const sqrtVarianceT = Math.sqrt(leg.varianceT);
            leg.v_sqrt_T = leg.volatility * sqrtVarianceT;
            leg.inv_v_sqrt_T = 1.0 / leg.v_sqrt_T;
            const discount = Math.exp(-leg.rate * leg.discountT);
            const carryTerm = leg.pricingModel === 'black76'
                ? 0
                : leg.rate * leg.discountT;
            leg.d1_const = (
                -Math.log(leg.strike)
                + carryTerm
                + 0.5 * leg.volatility * leg.volatility * leg.varianceT
            ) / leg.v_sqrt_T;
            leg.underlyingDiscount = leg.pricingModel === 'black76' ? discount : 1;
            leg.discountedStrike = leg.strike * discount;
            if (!Number.isFinite(leg.v_sqrt_T) || leg.v_sqrt_T <= 0
                || !Number.isFinite(leg.inv_v_sqrt_T)
                || !Number.isFinite(discount)
                || !Number.isFinite(leg.d1_const)
                || !Number.isFinite(leg.discountedStrike)) {
                postError('simulation_numeric_overflow', legId, 'modelConstants');
                return;
            }
        }
    }

    let exactPnLSum = 0.0;
    let pathsInRange = 0;

    for (let i = 0; i < nPaths; i++) {
        // Each calendar interval carries its own variance weight. Trading
        // dates use 1; weekends/full holidays use the scalar fallback or that
        // exact date's implied lambda. Zero-weight steps consume no RNG draw.
        let logRet = 0.0;
        for (let d = 0; d < stepWeights.length; d++) {
            const weight = stepWeights[d];
            if (weight <= 0) continue;
            logRet += tSample(df, loc * weight, newScale * Math.sqrt(weight));
        }
        if (!Number.isFinite(logRet)) {
            postError('simulation_numeric_overflow', '', 'logReturn');
            return;
        }
        // Final price
        const finalPrice = currentPrice * Math.exp(logRet);
        if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
            postError('simulation_numeric_overflow', '', 'terminalPrice');
            return;
        }
        const binIdx = Math.floor((finalPrice - minS) / binWidth);
        const inRange = (binIdx >= 0 && binIdx < bins);

        if (inRange) {
            counts[binIdx]++;
        }

        // Exact BSM path pricing if legs provided (calculate for ALL paths for true Expectation)
        if (legs && legs.length > 0) {
            let pathPnL = 0.0;

            for (let l = 0; l < legs.length; l++) {
                const leg = legs[l];
                if (leg.hasFixedPrice) {
                    pathPnL += leg.posMultiplier * leg.fixedPrice - leg.costBasis;
                    continue;
                }
                const legPrice = leg.hasFrozenExpiryUnderlying
                    ? leg.expiryUnderlyingPrice
                    : finalPrice * leg.underlyingScale;
                const safeLegPrice = legPrice > 0 ? legPrice : 0.0001;
                const log_S = Math.log(safeLegPrice);
                let v_opt = 0;
                if (leg.isUnderlyingLeg) {
                    // Underlying leg: price IS the simulated underlying price, no BSM
                    v_opt = legPrice;
                } else if (leg.isExpired) {
                    if (leg.type === 'call') v_opt = Math.max(0, legPrice - leg.strike);
                    else                     v_opt = Math.max(0, leg.strike - legPrice);
                } else if (leg.pricingModel === 'american-binomial') {
                    if (legPrice <= leg.americanGridMin
                        || legPrice >= leg.americanGridMax) {
                        // Far outside the deliberately wide lookup range, the
                        // immediate-exercise value is the stable American tail.
                        v_opt = leg.type === 'call'
                            ? Math.max(0, legPrice - leg.strike)
                            : Math.max(0, leg.strike - legPrice);
                    } else {
                        const gridPosition = (
                            legPrice - leg.americanGridMin
                        ) / leg.americanGridStep;
                        const lowerIndex = Math.floor(gridPosition);
                        const fraction = gridPosition - lowerIndex;
                        const lowerValue = leg.americanPriceGrid[lowerIndex];
                        const upperValue = leg.americanPriceGrid[lowerIndex + 1];
                        v_opt = lowerValue + fraction * (upperValue - lowerValue);
                    }
                } else {
                    const d1 = log_S * leg.inv_v_sqrt_T + leg.d1_const;
                    const d2 = d1 - leg.v_sqrt_T;
                    if (leg.type === 'call') {
                        v_opt = leg.underlyingDiscount * legPrice * normalCDF(d1)
                            - leg.discountedStrike * normalCDF(d2);
                    } else {
                        v_opt = leg.discountedStrike * normalCDF(-d2)
                            - leg.underlyingDiscount * legPrice * normalCDF(-d1);
                    }
                }
                if (!Number.isFinite(v_opt)) {
                    postError('simulation_numeric_overflow', String(leg.id || ''), 'legValue');
                    return;
                }
                pathPnL += leg.posMultiplier * v_opt - leg.costBasis;
                if (!Number.isFinite(pathPnL)) {
                    postError('simulation_numeric_overflow', String(leg.id || ''), 'pathPnL');
                    return;
                }
            }
            exactPnLSum += pathPnL;
            if (!Number.isFinite(exactPnLSum)) {
                postError('simulation_numeric_overflow', '', 'expectedPnL');
                return;
            }
        }
    }

    const exactExpectedPnL = nPaths > 0 ? (exactPnLSum / nPaths) : 0;

    // Normalise to probability density
    const normFactor = nPaths * binWidth;
    const tDensity   = new Float64Array(bins);
    for (let i = 0; i < bins; i++) tDensity[i] = counts[i] / normFactor;

    // Bin centres
    const binCenters = new Float64Array(bins);
    for (let i = 0; i < bins; i++) binCenters[i] = minS + (i + 0.5) * binWidth;

    // Transfer typed-array ownership back to the main thread
    self.postMessage(
        { tDensity, binCenters, binWidth, exactExpectedPnL },
        [tDensity.buffer, binCenters.buffer]
    );
};
`;

const _MC_WORKER_URL = URL.createObjectURL(
    new Blob([_MC_WORKER_CODE], { type: 'application/javascript' })
);

let _activeWorker = null;   // currently running Worker (or null)

// -----------------------------------------------------------------------
// 2.  Math helpers
// -----------------------------------------------------------------------

/**
 * Recalibrate the t-distribution scale so that its std equals the supplied
 * weighted-clock IV divided by sqrt(daysPerYear). We keep df (tail shape)
 * and loc (drift) from the historical fit.
 *
 *   t-dist daily std = scale * sqrt(df / (df - 2))  for df > 2
 *   → new_scale = (IV / sqrt(daysPerYear)) / sqrt(df / (df - 2))
 */
function _calibrateScale(df, portfolioIV, daysPerYear = 365) {
    const targetDailyVol = portfolioIV / Math.sqrt(daysPerYear);
    if (df <= 2) return targetDailyVol;  // Worker rejects undefined-variance fits.
    return targetDailyVol / Math.sqrt(df / (df - 2));
}

/**
 * Lognormal (normal-model) probability density for the price S at the
 * simulation date, using the same drift as the t-model (historical loc).
 *
 *   log(S_T / S0) ~ Normal(mu_total, sigma_total^2)
 *   mu_total    = loc * effectiveDays
 *   sigma_total = (portfolioIV / sqrt(daysPerYear)) * sqrt(effectiveDays)
 */
function _lognormalDensity(s, S0, portfolioIV, loc, effectiveDays, daysPerYear = 365) {
    if (s <= 0 || S0 <= 0 || effectiveDays <= 0) return 0;
    const sigma = (portfolioIV / Math.sqrt(daysPerYear)) * Math.sqrt(effectiveDays);
    const mu = loc * effectiveDays;
    if (sigma <= 0) return 0;
    const z = (Math.log(s / S0) - mu) / sigma;
    return (1.0 / (s * sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * z * z);
}

function _getProbabilityAnchorPrice() {
    const pricingContext = _getProbabilityPricingContextApi();
    if (pricingContext && typeof pricingContext.resolveAnchorUnderlyingPrice === 'function') {
        return pricingContext.resolveAnchorUnderlyingPrice(state, state.underlyingPrice);
    }
    return state.underlyingPrice;
}

function _getProbabilityAnchorInfo() {
    const pricingContext = _getProbabilityPricingContextApi();
    if (pricingContext && typeof pricingContext.resolveAnchorDisplayInfo === 'function') {
        return pricingContext.resolveAnchorDisplayInfo(state, state.underlyingPrice);
    }

    const price = _getProbabilityAnchorPrice();
    return {
        pricingMode: 'STK',
        isFutureAnchor: false,
        price,
        title: 'Current Underlying',
        shortLabel: state?.underlyingSymbol || 'Underlying',
        lineLabel: 'Current',
        displayText: `Current Underlying: ${state?.underlyingSymbol || 'Underlying'} @ $${price.toFixed(2)}`,
        detailText: 'Percent labels are measured from the current underlying price.',
    };
}

function _hasFixedProjectionPrice(leg) {
    if (!leg || leg.closePrice === null || leg.closePrice === '' || leg.closePrice === undefined) {
        return false;
    }
    const price = parseFloat(leg.closePrice);
    return Number.isFinite(price) && price >= 0;
}

function _resolvePortfolioProjectionAvailability(portfolioState, groups, anchorPrice) {
    const pricingContext = _getProbabilityPricingContextApi();
    if (!pricingContext) return { available: true };

    for (const group of (Array.isArray(groups) ? groups : [])) {
        for (const leg of (Array.isArray(group && group.legs) ? group.legs : [])) {
            if (_hasFixedProjectionPrice(leg)) continue;
            const currentUnderlying = typeof pricingContext.resolveLegCurrentUnderlyingPrice === 'function'
                ? pricingContext.resolveLegCurrentUnderlyingPrice(portfolioState, leg, anchorPrice)
                : anchorPrice;
            const scenarioUnderlying = typeof pricingContext.resolveLegScenarioUnderlyingPrice === 'function'
                ? pricingContext.resolveLegScenarioUnderlyingPrice(portfolioState, leg, anchorPrice, anchorPrice)
                : anchorPrice;
            if (!Number.isFinite(currentUnderlying) || currentUnderlying <= 0
                || !Number.isFinite(scenarioUnderlying) || scenarioUnderlying <= 0) {
                return {
                    available: false,
                    legId: String(leg && leg.id || ''),
                    reason: 'bound_futures_quote_unavailable',
                };
            }
        }
    }
    return { available: true };
}

/**
 * Compute the portfolio's P&L at a given underlying price using the
 * BSM model with the current simulation date and IV settings.
 * Replicates the logic in chart.js / app.js updateDerivedValues().
 */
// The probability visualization prices American legs across dense spot grids:
// the 801-point worker lookup grid and the 500-point payoff/P&L curve. Neither
// benefits from the higher binomial step count a user may pick for a single
// authoritative quote -- the difference is far below Monte Carlo noise -- while
// the O(steps^2) tree cost per point would dominate runtime. Cap curve/grid
// pricing at the pricer's DEFAULT_STEPS; single-quote valuation is untouched.
function _americanCurveStepCap(requestedSteps) {
    const api = (typeof globalThis !== 'undefined' ? globalThis : self)
        .OptionComboAmericanBinomial;
    const cap = api && Number.isFinite(api.DEFAULT_STEPS) ? api.DEFAULT_STEPS : 201;
    const minSteps = api && Number.isFinite(api.MIN_STEPS) ? api.MIN_STEPS : 25;
    const requested = Number.isFinite(requestedSteps)
        ? Math.round(requestedSteps)
        : cap;
    return Math.max(minSteps, Math.min(cap, requested));
}

function _computePortfolioPnLAtPrice(price) {
    if (!state || !state.groups) return 0;

    let totalValue = 0;
    let totalCost = 0;
    const anchorPrice = _getProbabilityAnchorPrice();
    const pricingContext = _getProbabilityPricingContextApi();
    const simulationDate = pricingContext && typeof pricingContext.resolveSimulationDate === 'function'
        ? pricingContext.resolveSimulationDate(state)
        : state.simulatedDate;
    const quoteDate = pricingContext && typeof pricingContext.resolveQuoteDate === 'function'
        ? pricingContext.resolveQuoteDate(state)
        : state.baseDate;
    const simulationTiming = pricingContext && typeof pricingContext.resolveSimulationTiming === 'function'
        ? pricingContext.resolveSimulationTiming(state)
        : null;
    if (simulationTiming && simulationTiming.available === false) return null;
    const productRegistry = _getProbabilityProductRegistryApi();
    const underlyingProfile = productRegistry && typeof productRegistry.resolveUnderlyingProfile === 'function'
        ? productRegistry.resolveUnderlyingProfile(state.underlyingSymbol)
        : null;

    for (const group of state.groups.filter(_isGroupIncludedInGlobal)) {
        const activeViewMode = group.viewMode || 'active';
        for (const leg of group.legs) {
            const legCurrentUnderlying = pricingContext
                && typeof pricingContext.resolveLegCurrentUnderlyingPrice === 'function'
                ? pricingContext.resolveLegCurrentUnderlyingPrice(state, leg, anchorPrice)
                : state.underlyingPrice;
            const legInterestRate = pricingContext
                && typeof pricingContext.resolveLegInterestRate === 'function'
                ? pricingContext.resolveLegInterestRate(state, leg, state.interestRate)
                : state.interestRate;
            const observable = pricingContext
                && typeof pricingContext.resolveObservableLegPrice === 'function'
                ? pricingContext.resolveObservableLegPrice(state, group, leg)
                : null;
            const quotePricingInputs = pricingContext
                && typeof pricingContext.resolveLegQuotePricingInputs === 'function'
                ? pricingContext.resolveLegQuotePricingInputs(state, leg, {
                    underlyingPrice: anchorPrice,
                    interestRate: state.interestRate,
                })
                : null;
            const timingContext = {
                quoteAsOf: state.liveQuoteAsOf,
                allowLegacyQuoteCutoff: !state.marketDataMode,
                targetAsOf: simulationTiming && simulationTiming.available
                    ? simulationTiming.targetAsOf
                    : null,
                targetSource: simulationTiming && simulationTiming.source || null,
                timingStatus: simulationTiming && simulationTiming.status || null,
                observablePrice: observable && observable.available ? observable.price : null,
                observablePriceSource: observable && observable.source || null,
                observablePriceAsOf: observable && observable.quoteAsOf || null,
                observablePriceFresh: observable && observable.fresh === true,
                quotePricingInputsAvailable: quotePricingInputs && quotePricingInputs.available === true,
                quotePricingInputStatus: quotePricingInputs && quotePricingInputs.status || null,
                quoteUnderlyingPrice: quotePricingInputs && quotePricingInputs.underlyingPrice,
                quoteUnderlyingAsOf: quotePricingInputs && quotePricingInputs.underlyingAsOf,
                quoteInterestRate: quotePricingInputs && quotePricingInputs.interestRate,
            };
            // Use processLegData to handle unified BSM formatting (Exp, Implied Vol offset, T)
            const pLeg = processLegData(leg, simulationDate, state.ivOffset, quoteDate, legCurrentUnderlying, legInterestRate, activeViewMode, underlyingProfile, state.marketDataMode, timingContext);
            const pricingCore = _getProbabilityPricingCoreApi();
            const convergence = pricingCore
                && typeof pricingCore.assessProjectionConvergence === 'function'
                ? pricingCore.assessProjectionConvergence(state, [leg], [pLeg])
                : { ready: true };
            if (convergence.ready === false) return null;
            const legScenarioUnderlying = pricingContext
                && typeof pricingContext.resolveLegScenarioUnderlyingPrice === 'function'
                ? pricingContext.resolveLegScenarioUnderlyingPrice(state, leg, price, anchorPrice)
                : price;
            if (!_hasFixedProjectionPrice(leg)
                && (!Number.isFinite(legCurrentUnderlying) || legCurrentUnderlying <= 0
                    || !Number.isFinite(legScenarioUnderlying) || legScenarioUnderlying <= 0)) {
                return null;
            }
            // The payoff/P&L curve is evaluated at 500 price points; an American
            // leg would otherwise solve a full binomial tree per point at the
            // user's single-quote step count (up to 1001). Cap this curve pricing
            // at the pricer's default resolution -- the sub-cent difference is far
            // below Monte Carlo noise and keeps the curve off the slow path.
            if (pLeg && pLeg.pricingModel === 'american-binomial'
                && Number.isFinite(pLeg.binomialSteps)) {
                pLeg.binomialSteps = _americanCurveStepCap(pLeg.binomialSteps);
            }
            // Use unified simulation price (includes Zero-Delta bypass at current price)
            const pps = computeSimulatedPrice(
                pLeg, leg, legScenarioUnderlying, legInterestRate,
                activeViewMode, simulationDate, quoteDate, state.ivOffset,
                timingContext
            );

            if (!Number.isFinite(pps)) return null;

            totalValue += pLeg.posMultiplier * pps;
            totalCost += pLeg.costBasis;
        }
    }

    return totalValue - totalCost;
}

/**
 * Simple moving-average smoother to make the MC histogram look continuous.
 * Window of 7 gives a gentle blur without distorting the shape.
 */
// -----------------------------------------------------------------------
// Regime-conditioned overlay (VRP_RESEARCH_MEMO.md E13/E17): historical
// weekly terminal displacements (z, in EM units) for the selected TD-slope
// zone, replayed at today's anchor/EM scale. Pure function for testability.
// -----------------------------------------------------------------------

const REGIME_CONDITION_LABELS = {
    dc: 'Deep contango (<0.95)',
    n: 'Neutral (0.95-1.05)',
    bw: 'Backwardation (>1.05)',
};

function _getRegimeConditionSelection() {
    const select = document.getElementById('regimeConditionSelect');
    const value = select ? String(select.value || 'off') : 'off';
    return REGIME_CONDITION_LABELS[value] ? value : 'off';
}

function _getRegimeConditionalZs(distributionSymbol, zoneKey) {
    const db = typeof REGIME_CONDITIONAL_SAMPLES !== 'undefined' ? REGIME_CONDITIONAL_SAMPLES : null;
    const entry = db && db.symbols ? db.symbols[distributionSymbol] : null;
    const zs = entry ? entry[zoneKey] : null;
    return Array.isArray(zs) && zs.length >= 30 ? zs : null;
}

/**
 * Build the conditional overlay: KDE density on the bin grid plus the exact
 * conditional expected P&L (sample mean of the portfolio P&L at each
 * replayed terminal price).
 *
 * @param {number[]} zSamples  weekly (settle-center)/EM outcomes
 * @param {number} anchorPrice today's anchor price (density center)
 * @param {number} em          today's expected move in dollars for the
 *                             simulation horizon (0.7979*S*sigma*sqrt(T));
 *                             the sqrt(T) inside EM is what adapts the
 *                             weekly z shape to other horizons.
 * @param {ArrayLike<number>} binCenters
 * @param {(price: number) => number} pnlAt
 */
function _buildConditionalOverlay(zSamples, anchorPrice, em, binCenters, pnlAt) {
    if (!zSamples || !(anchorPrice > 0) || !(em > 0)) return null;
    const n = zSamples.length;
    const prices = new Float64Array(n);
    let evSum = 0;
    let mean = 0;
    for (let i = 0; i < n; i++) {
        prices[i] = anchorPrice + zSamples[i] * em;
        mean += prices[i];
        const pnl = pnlAt(prices[i]);
        if (!Number.isFinite(pnl)) return null;
        evSum += pnl;
    }
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (prices[i] - mean) ** 2;
    const sd = Math.sqrt(variance / n);
    if (!(sd > 0)) return null;
    const bandwidth = 1.06 * sd * Math.pow(n, -0.2);
    const density = new Float64Array(binCenters.length);
    const norm = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI));
    for (let b = 0; b < binCenters.length; b++) {
        let acc = 0;
        for (let i = 0; i < n; i++) {
            const u = (binCenters[b] - prices[i]) / bandwidth;
            acc += Math.exp(-0.5 * u * u);
        }
        density[b] = acc * norm;
    }
    return { density, expectedPnL: evSum / n, n };
}

function _smooth(arr, window = 7) {
    const result = new Float64Array(arr.length);
    const half = Math.floor(window / 2);
    for (let i = 0; i < arr.length; i++) {
        let sum = 0, count = 0;
        for (let j = i - half; j <= i + half; j++) {
            if (j >= 0 && j < arr.length) { sum += arr[j]; count++; }
        }
        result[i] = sum / count;
    }
    return result;
}

// -----------------------------------------------------------------------
// 3.  Shared canvas helpers
// -----------------------------------------------------------------------

/** Standard DPR-aware canvas resize. */
function _resizeCanvas(canvas, minH) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width;
    const h = Math.max(minH, rect.height);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    return { ctx, w, h };
}

function _drawPlaceholder(canvas, message, minH = 220) {
    const { ctx, w, h } = _resizeCanvas(canvas, minH);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '13px Inter, sans-serif';
    ctx.fillStyle = '#9CA3AF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, w / 2, h / 2);
}

// -----------------------------------------------------------------------
// 4.  ProbabilityChart  (Chart 2 — price probability density)
// -----------------------------------------------------------------------

class ProbabilityChart {
    constructor(canvas) {
        this.canvas = canvas;
        this.padding = { top: 30, right: 30, bottom: 46, left: 18 };
        this._cache = null;   // last draw arguments for resize redraws
    }

    drawLoading() {
        _drawPlaceholder(this.canvas, 'Computing Monte Carlo simulation…', 220);
    }

    drawEmpty(msg) {
        _drawPlaceholder(this.canvas, msg || 'No data', 220);
        this._cache = null;
    }

    draw(binCenters, tDensity, normalDensity, minS, maxS, currentPrice, anchorInfo, condOverlay) {
        // Save args so we can redraw on resize without re-simulating
        this._cache = { binCenters, tDensity, normalDensity, minS, maxS, currentPrice, anchorInfo, condOverlay };

        const { ctx, w, h } = _resizeCanvas(this.canvas, 220);
        ctx.clearRect(0, 0, w, h);

        const pad = this.padding;
        const drawW = w - pad.left - pad.right;
        const drawH = h - pad.top - pad.bottom;
        const bins = binCenters.length;

        // Apply visual smoothing (does NOT affect E[P&L] calculation)
        const tSmooth = _smooth(tDensity, 7);
        const nSmooth = _smooth(normalDensity, 5);
        const cSmooth = condOverlay && condOverlay.density ? _smooth(condOverlay.density, 3) : null;

        // Y scale: max density + 10% headroom
        let maxD = 0;
        for (let i = 0; i < bins; i++) {
            if (tSmooth[i] > maxD) maxD = tSmooth[i];
            if (nSmooth[i] > maxD) maxD = nSmooth[i];
            if (cSmooth && cSmooth[i] > maxD) maxD = cSmooth[i];
        }
        if (maxD === 0) { _drawPlaceholder(this.canvas, 'No paths landed in range', 220); return; }
        maxD *= 1.1;

        const mapX = v => pad.left + ((v - minS) / (maxS - minS)) * drawW;
        const mapY = v => pad.top + drawH - (v / maxD) * drawH;

        // --- Grid & axes ---
        ctx.save();
        ctx.strokeStyle = '#E5E7EB';
        ctx.lineWidth = 1;
        ctx.strokeRect(pad.left, pad.top, drawW, drawH);

        // X-axis ticks + labels
        const ticksX = 10;
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i <= ticksX; i++) {
            const sTick = minS + (maxS - minS) * (i / ticksX);
            const x = mapX(sTick);
            ctx.beginPath();
            ctx.moveTo(x, pad.top);
            ctx.lineTo(x, pad.top + drawH);
            ctx.strokeStyle = '#E5E7EB';
            ctx.stroke();
            ctx.fillStyle = '#6B7280';
            ctx.fillText(`$${sTick.toFixed(1)}`, x, pad.top + drawH + 4);
            if (currentPrice > 0) {
                const pct = ((sTick - currentPrice) / currentPrice) * 100;
                const label = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
                ctx.fillStyle = '#9CA3AF';
                ctx.fillText(label, x, pad.top + drawH + 17);
            }
        }

        // Y-axis label (rotated)
        ctx.save();
        ctx.translate(13, pad.top + drawH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = '#9CA3AF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Probability Density', 0, 0);
        ctx.restore();
        ctx.restore();

        // --- Clip to draw area ---
        ctx.save();
        ctx.beginPath();
        ctx.rect(pad.left, pad.top, drawW, drawH);
        ctx.clip();

        // t-distribution: filled area
        ctx.beginPath();
        ctx.moveTo(mapX(binCenters[0]), mapY(0));
        for (let i = 0; i < bins; i++) ctx.lineTo(mapX(binCenters[i]), mapY(tSmooth[i]));
        ctx.lineTo(mapX(binCenters[bins - 1]), mapY(0));
        ctx.closePath();
        ctx.fillStyle = 'rgba(99, 102, 241, 0.18)';
        ctx.fill();

        // t-distribution: outline
        ctx.beginPath();
        ctx.moveTo(mapX(binCenters[0]), mapY(tSmooth[0]));
        for (let i = 1; i < bins; i++) ctx.lineTo(mapX(binCenters[i]), mapY(tSmooth[i]));
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.9)';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Normal / lognormal: dashed line
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.moveTo(mapX(binCenters[0]), mapY(nSmooth[0]));
        for (let i = 1; i < bins; i++) ctx.lineTo(mapX(binCenters[i]), mapY(nSmooth[i]));
        ctx.strokeStyle = 'rgba(249, 115, 22, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);

        // Regime-conditioned density: solid teal line
        if (cSmooth) {
            ctx.beginPath();
            ctx.moveTo(mapX(binCenters[0]), mapY(cSmooth[0]));
            for (let i = 1; i < bins; i++) ctx.lineTo(mapX(binCenters[i]), mapY(cSmooth[i]));
            ctx.strokeStyle = 'rgba(13, 148, 136, 0.95)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Current price vertical reference
        if (currentPrice >= minS && currentPrice <= maxS) {
            const px = mapX(currentPrice);
            ctx.beginPath();
            ctx.setLineDash([5, 5]);
            ctx.moveTo(px, pad.top);
            ctx.lineTo(px, pad.top + drawH);
            ctx.strokeStyle = '#6366F1';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#6366F1';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(
                `${anchorInfo && anchorInfo.lineLabel ? anchorInfo.lineLabel : 'Current'}: $${currentPrice.toFixed(2)}`,
                px,
                pad.top - 4
            );
        }

        ctx.restore();

        // --- Legend (top-left, inside chart) ---
        ctx.font = '11px Inter, sans-serif';
        ctx.textBaseline = 'middle';
        const lx = pad.left + 10;
        const ly = pad.top + 10;

        // t-dist swatch
        ctx.fillStyle = 'rgba(99, 102, 241, 0.18)';
        ctx.fillRect(lx, ly, 16, 12);
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(lx, ly, 16, 12);
        ctx.fillStyle = '#374151';
        ctx.textAlign = 'left';
        ctx.fillText('Student-t (fat-tail, IV-scaled)', lx + 22, ly + 6);

        // Normal swatch
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.moveTo(lx, ly + 24);
        ctx.lineTo(lx + 16, ly + 24);
        ctx.strokeStyle = 'rgba(249, 115, 22, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#374151';
        ctx.fillText('Normal / Lognormal (BSM baseline)', lx + 22, ly + 24);

        // Conditioned swatch
        if (cSmooth && condOverlay) {
            ctx.beginPath();
            ctx.moveTo(lx, ly + 38);
            ctx.lineTo(lx + 16, ly + 38);
            ctx.strokeStyle = 'rgba(13, 148, 136, 0.95)';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = '#374151';
            ctx.fillText(
                `Conditioned: ${condOverlay.label} (n=${condOverlay.n} weeks)`,
                lx + 22, ly + 38
            );
        }
    }

    redraw() {
        if (this._cache) {
            const c = this._cache;
            this.draw(c.binCenters, c.tDensity, c.normalDensity, c.minS, c.maxS, c.currentPrice, c.anchorInfo, c.condOverlay);
        }
    }
}

// -----------------------------------------------------------------------
// 5.  ExpectedPnLDensityChart  (Chart 3 — P&L × probability density)
// -----------------------------------------------------------------------

class ExpectedPnLDensityChart {
    constructor(canvas) {
        this.canvas = canvas;
        this.padding = { top: 20, right: 30, bottom: 46, left: 68 };
        this._cache = null;
    }

    drawLoading() {
        _drawPlaceholder(this.canvas, 'Computing expected P&L distribution…', 220);
    }

    drawEmpty(msg) {
        _drawPlaceholder(this.canvas, msg || 'No data', 220);
        this._cache = null;
    }

    draw(binCenters, pnlValues, tDensity, minS, maxS, currentPrice, anchorInfo) {
        this._cache = { binCenters, pnlValues, tDensity, minS, maxS, currentPrice, anchorInfo };

        const { ctx, w, h } = _resizeCanvas(this.canvas, 220);
        ctx.clearRect(0, 0, w, h);

        const pad = this.padding;
        const drawW = w - pad.left - pad.right;
        const drawH = h - pad.top - pad.bottom;
        const bins = binCenters.length;

        // Compute E[P&L] density: f_ev[i] = pnl[i] * density[i]
        const fev = new Float64Array(bins);
        for (let i = 0; i < bins; i++) fev[i] = pnlValues[i] * tDensity[i];
        const fevSmooth = _smooth(fev, 7);

        // Y range with 10% padding
        let minEV = 0, maxEV = 0;
        for (let i = 0; i < bins; i++) {
            if (fevSmooth[i] < minEV) minEV = fevSmooth[i];
            if (fevSmooth[i] > maxEV) maxEV = fevSmooth[i];
        }
        const evRange = maxEV - minEV;
        if (evRange === 0) { _drawPlaceholder(this.canvas, 'P&L has no variation in this range', 220); return; }
        maxEV += evRange * 0.1;
        minEV -= evRange * 0.1;

        const mapX = v => pad.left + ((v - minS) / (maxS - minS)) * drawW;
        const mapY = v => pad.top + drawH - ((v - minEV) / (maxEV - minEV)) * drawH;
        const yZero = Math.max(pad.top, Math.min(pad.top + drawH, mapY(0)));

        // --- Axes ---
        ctx.font = '11px Inter, sans-serif';
        ctx.textBaseline = 'top';

        // Y-axis ticks + grid
        const ticksY = 5;
        ctx.textAlign = 'right';
        for (let i = 0; i <= ticksY; i++) {
            const val = minEV + (maxEV - minEV) * (i / ticksY);
            const y = mapY(val);
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(pad.left + drawW, y);
            ctx.strokeStyle = '#E5E7EB';
            ctx.lineWidth = 1;
            ctx.stroke();
            const absV = Math.abs(val);
            let label;
            if (absV >= 1) {
                label = (val >= 0 ? '+' : '-') + '$' + absV.toFixed(2);
            } else {
                label = (val >= 0 ? '+' : '-') + absV.toFixed(4);
            }
            ctx.fillStyle = '#6B7280';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, pad.left - 6, y);
        }

        // X-axis ticks + labels
        const ticksX = 10;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i <= ticksX; i++) {
            const sTick = minS + (maxS - minS) * (i / ticksX);
            const x = mapX(sTick);
            ctx.beginPath();
            ctx.moveTo(x, pad.top);
            ctx.lineTo(x, pad.top + drawH);
            ctx.strokeStyle = '#E5E7EB';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = '#6B7280';
            ctx.fillText(`$${sTick.toFixed(1)}`, x, pad.top + drawH + 4);
            if (currentPrice > 0) {
                const pct = ((sTick - currentPrice) / currentPrice) * 100;
                const label = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
                ctx.fillStyle = '#9CA3AF';
                ctx.fillText(label, x, pad.top + drawH + 17);
            }
        }

        // Y-axis label
        ctx.save();
        ctx.translate(13, pad.top + drawH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = '#9CA3AF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('P&L × Probability Density', 0, 0);
        ctx.restore();

        // Bounding box
        ctx.strokeStyle = '#E5E7EB';
        ctx.lineWidth = 1;
        ctx.strokeRect(pad.left, pad.top, drawW, drawH);

        // --- Clip ---
        ctx.save();
        ctx.beginPath();
        ctx.rect(pad.left, pad.top, drawW, drawH);
        ctx.clip();

        // Zero baseline
        ctx.beginPath();
        ctx.moveTo(pad.left, yZero);
        ctx.lineTo(pad.left + drawW, yZero);
        ctx.strokeStyle = '#9CA3AF';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Build the curve path once, then fill positive/negative regions separately
        // Positive region (profit contribution) — green fill
        ctx.beginPath();
        ctx.moveTo(mapX(binCenters[0]), yZero);
        for (let i = 0; i < bins; i++) {
            ctx.lineTo(mapX(binCenters[i]), mapY(Math.max(0, fevSmooth[i])));
        }
        ctx.lineTo(mapX(binCenters[bins - 1]), yZero);
        ctx.closePath();
        ctx.fillStyle = 'rgba(5, 150, 105, 0.20)';
        ctx.fill();

        // Negative region (loss contribution) — red fill
        ctx.beginPath();
        ctx.moveTo(mapX(binCenters[0]), yZero);
        for (let i = 0; i < bins; i++) {
            ctx.lineTo(mapX(binCenters[i]), mapY(Math.min(0, fevSmooth[i])));
        }
        ctx.lineTo(mapX(binCenters[bins - 1]), yZero);
        ctx.closePath();
        ctx.fillStyle = 'rgba(220, 38, 38, 0.20)';
        ctx.fill();

        // Curve outline — gradient from green (above 0) to red (below 0)
        const zeroRatio = Math.max(0, Math.min(1, (yZero - pad.top) / drawH));
        const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + drawH);
        if (zeroRatio > 0 && zeroRatio < 1) {
            grad.addColorStop(0, 'rgba(5, 150, 105, 0.9)');
            grad.addColorStop(zeroRatio - 0.001, 'rgba(5, 150, 105, 0.9)');
            grad.addColorStop(zeroRatio + 0.001, 'rgba(220, 38, 38, 0.9)');
            grad.addColorStop(1, 'rgba(220, 38, 38, 0.9)');
        } else if (zeroRatio >= 1) {
            grad.addColorStop(0, 'rgba(5, 150, 105, 0.9)');
            grad.addColorStop(1, 'rgba(5, 150, 105, 0.9)');
        } else {
            grad.addColorStop(0, 'rgba(220, 38, 38, 0.9)');
            grad.addColorStop(1, 'rgba(220, 38, 38, 0.9)');
        }

        ctx.beginPath();
        ctx.moveTo(mapX(binCenters[0]), mapY(fevSmooth[0]));
        for (let i = 1; i < bins; i++) ctx.lineTo(mapX(binCenters[i]), mapY(fevSmooth[i]));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Current price reference line
        if (currentPrice >= minS && currentPrice <= maxS) {
            const px = mapX(currentPrice);
            ctx.beginPath();
            ctx.setLineDash([5, 5]);
            ctx.moveTo(px, pad.top);
            ctx.lineTo(px, pad.top + drawH);
            ctx.strokeStyle = '#6366F1';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#6366F1';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(
                `${anchorInfo && anchorInfo.lineLabel ? anchorInfo.lineLabel : 'Current'}: $${currentPrice.toFixed(2)}`,
                px,
                pad.top - 2
            );
        }

        ctx.restore();

        // Chart title in top-left corner
        ctx.font = '11px Inter, sans-serif';
        ctx.fillStyle = '#6B7280';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('P&L(price) × Probability Density  —  area = E[P&L]', pad.left + 6, pad.top + 4);
    }

    redraw() {
        if (this._cache) {
            const c = this._cache;
            this.draw(c.binCenters, c.pnlValues, c.tDensity, c.minS, c.maxS, c.currentPrice, c.anchorInfo);
        }
    }
}

// -----------------------------------------------------------------------
// 6.  Chart instances (created lazily)
// -----------------------------------------------------------------------

let _probChart = null;
let _epnlChart = null;

function _ensureCharts() {
    const c2 = document.getElementById('priceDensityCanvas');
    const c3 = document.getElementById('expectedPnLDensityCanvas');
    if (c2 && !_probChart) _probChart = new ProbabilityChart(c2);
    if (c3 && !_epnlChart) _epnlChart = new ExpectedPnLDensityChart(c3);
}

// A signed IVTS lambda is an interval residual, not an independently
// simulatable negative-variance day. Preserve its effect on the total horizon
// while folding negative closure weights into the nearest positive trading
// segments before the Monte Carlo worker takes square roots. This keeps the
// fitted cross-week variance clock intact without clipping the inversion
// signal or asking the diffusion to consume negative variance.
function _coalesceSignedVarianceWeights(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return { available: false, status: 'simulation_clock_invalid' };
    }
    const rawStepWeights = values.map(value => Number(value));
    if (rawStepWeights.some(value => !Number.isFinite(value))) {
        return { available: false, status: 'simulation_clock_invalid' };
    }
    const totalWeight = rawStepWeights.reduce((sum, value) => sum + value, 0);
    if (!(totalWeight > 0)) {
        return {
            available: false,
            status: 'simulation_clock_nonpositive',
            totalWeight,
            rawStepWeights,
        };
    }

    const stepWeights = rawStepWeights.map(value => Math.max(0, value));
    const negativeIndices = [];
    for (let index = 0; index < rawStepWeights.length; index += 1) {
        if (rawStepWeights[index] < 0) negativeIndices.push(index);
    }

    for (const index of negativeIndices) {
        let debt = -rawStepWeights[index];
        // Prefer the immediately preceding trading variance because an IVTS
        // closure residual is identified against its surrounding interval.
        for (let left = index - 1; left >= 0 && debt > 1e-12; left -= 1) {
            const absorbed = Math.min(stepWeights[left], debt);
            stepWeights[left] -= absorbed;
            debt -= absorbed;
        }
        // A quote/target boundary can start inside the closure. In that case
        // carry any remaining residual into the following positive segment.
        for (let right = index + 1; right < stepWeights.length && debt > 1e-12; right += 1) {
            const absorbed = Math.min(stepWeights[right], debt);
            stepWeights[right] -= absorbed;
            debt -= absorbed;
        }
        if (debt > 1e-9) {
            return {
                available: false,
                status: 'simulation_clock_nonpositive',
                totalWeight,
                rawStepWeights,
            };
        }
    }

    const coalescedTotal = stepWeights.reduce((sum, value) => sum + value, 0);
    const drift = totalWeight - coalescedTotal;
    if (Math.abs(drift) > 1e-12) {
        const targetIndex = stepWeights.findIndex(value => value > 0);
        if (targetIndex < 0 || stepWeights[targetIndex] + drift < 0) {
            return { available: false, status: 'simulation_clock_nonpositive' };
        }
        stepWeights[targetIndex] += drift;
    }

    return {
        available: true,
        status: 'ok',
        totalWeight,
        rawStepWeights,
        stepWeights,
        negativeStepCount: negativeIndices.length,
        signedWeightsCoalesced: negativeIndices.length > 0,
    };
}

function _prepareProbabilityClock(clock) {
    if (!clock || clock.available !== true) return clock;
    const prepared = _coalesceSignedVarianceWeights(clock.stepWeights);
    if (!prepared.available) {
        return {
            ...clock,
            available: false,
            status: prepared.status,
            rawStepWeights: prepared.rawStepWeights || clock.stepWeights,
        };
    }
    return {
        ...clock,
        effDays: prepared.totalWeight,
        rawStepWeights: prepared.rawStepWeights,
        stepWeights: prepared.stepWeights,
        negativeStepCount: prepared.negativeStepCount,
        signedWeightsCoalesced: prepared.signedWeightsCoalesced,
    };
}

function _resolveProbabilityHorizonClock(
    pricingContext,
    underlyingProfile,
    quoteDate,
    simulationDate,
    simulationTiming
) {
    const dateUtils = typeof OptionComboDateUtils !== 'undefined'
        ? OptionComboDateUtils
        : null;
    const pricingCore = typeof OptionComboPricingCore !== 'undefined'
        ? OptionComboPricingCore
        : null;
    const calendarKey = String(
        underlyingProfile && underlyingProfile.calendarId || 'NYSE'
    ).trim().toUpperCase();
    const quoteAsOf = String(state && state.liveQuoteAsOf || '').trim();
    const targetAsOf = String(simulationTiming && simulationTiming.targetAsOf || '').trim();
    const quoteMs = Date.parse(quoteAsOf);
    const targetMs = Date.parse(targetAsOf);

    if (state.marketDataMode !== 'historical'
        && Number.isFinite(quoteMs)
        && Number.isFinite(targetMs)
        && dateUtils
        && typeof dateUtils.resolveWeightedTime === 'function') {
        const weekendWeight = pricingCore
            && typeof pricingCore.getSimTimeBasisWeekendWeight === 'function'
            ? pricingCore.getSimTimeBasisWeekendWeight()
            : state.simWeekendWeight;
        const timeZone = String(
            underlyingProfile && underlyingProfile.optionExpiryTimeZone
            || (calendarKey.startsWith('CME:') || calendarKey.startsWith('NYMEX:')
                || calendarKey.startsWith('COMEX:')
                ? 'America/Chicago'
                : 'America/New_York')
        );
        const futuresCalendar = calendarKey.startsWith('CME:')
            || calendarKey.startsWith('NYMEX:')
            || calendarKey.startsWith('COMEX:');
        const exact = dateUtils.resolveWeightedTime(
            quoteAsOf,
            targetAsOf,
            weekendWeight,
            calendarKey,
            null,
            timeZone,
            futuresCalendar ? 17 : null
        );
        if (!exact.available) {
            return {
                available: false,
                status: exact.status,
                missingWeightDates: exact.missingWeightDates || [],
                calendarKey,
            };
        }
        const weightSpec = dateUtils.normalizeWeekendWeightSpec(weekendWeight);
        const defaultWeight = weightSpec.default;
        const effYear = typeof weightedDaysPerYear === 'function'
            ? weightedDaysPerYear(weekendWeight)
            : 252 + 113 * defaultWeight;
        return _prepareProbabilityClock({
            available: true,
            status: 'ok',
            precision: 'instant',
            calendarKey,
            calDays: exact.calendarDays,
            tradingDays: exact.tradingDays,
            nonTradingDays: exact.nonTradingDays,
            effDays: exact.effectiveDays,
            effYear,
            steps: exact.segments,
            stepWeights: exact.segments.map(segment => segment.effectiveDays),
            isCalendarClock: !weightSpec.differsFromCalendar,
            usedPerDateWeight: !!weightSpec.byDate,
            defaultNonTradingWeight: defaultWeight,
        });
    }

    return typeof resolveSimHorizonClock === 'function'
        ? _prepareProbabilityClock(resolveSimHorizonClock(
            quoteDate,
            simulationDate,
            calendarKey,
            state.marketDataMode
        ))
        : { available: false, status: 'simulation_clock_unavailable', calendarKey };
}

// -----------------------------------------------------------------------
// 7.  updateProbCharts()  — main orchestrator called from app.js
// -----------------------------------------------------------------------

function _resolveProbabilityProjectionFailure(globalState, includedGroups) {
    const valuation = typeof OptionComboValuation !== 'undefined' && OptionComboValuation
        ? OptionComboValuation
        : null;
    if (!valuation || typeof valuation.computeGroupDerivedData !== 'function') {
        return '';
    }

    const pricingCore = _getProbabilityPricingCoreApi();
    for (const group of (includedGroups || [])) {
        const groupResult = valuation.computeGroupDerivedData(group, globalState);
        for (const legResult of (groupResult && groupResult.legResults || [])) {
            const processedLeg = legResult && legResult.processedLeg;
            if (processedLeg && processedLeg.timingStatus === 'implied_lambda_incomplete') {
                return pricingCore && typeof pricingCore.formatProjectionTimingFailure === 'function'
                    ? pricingCore.formatProjectionTimingFailure(
                        processedLeg.timingStatus,
                        'Probability simulation',
                        processedLeg
                    )
                    : 'Probability simulation unavailable: required weekend/holiday implied λ data is missing.';
            }

            const convergence = legResult && legResult.projectionConvergence;
            if (convergence && convergence.ready === false) {
                return pricingCore && typeof pricingCore.formatProjectionConvergenceFailure === 'function'
                    ? pricingCore.formatProjectionConvergenceFailure(
                        convergence,
                        'Probability simulation'
                    )
                    : 'Probability simulation unavailable: strict live BBO convergence inputs are missing.';
            }
        }
    }
    return '';
}

function updateProbCharts() {
    const container = document.getElementById('probAnalysisContainer');
    if (!container || container.style.display === 'none') return;

    _ensureCharts();

    // Guard: need at least one leg
    const includedGroups = state.groups.filter(_isGroupIncludedInGlobal);
    const allLegs = includedGroups.flatMap(g => g.legs);
    if (allLegs.length === 0) {
        _probChart && _probChart.drawEmpty('Select at least one included group to see probability analysis.');
        _epnlChart && _epnlChart.drawEmpty('Select at least one included group to see expected P&L density.');
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setAnchorInfoText(null);
        _setInfoText('No globally included legs in portfolio.');
        return;
    }

    // Resolve one portfolio-global target instant. A same-date target can
    // still have a positive intraday horizon; date equality alone is not zero.
    const pricingContext = _getProbabilityPricingContextApi();
    const simulationDate = pricingContext && typeof pricingContext.resolveSimulationDate === 'function'
        ? pricingContext.resolveSimulationDate(state)
        : state.simulatedDate;
    const quoteDate = pricingContext && typeof pricingContext.resolveQuoteDate === 'function'
        ? pricingContext.resolveQuoteDate(state)
        : state.baseDate;
    const simulationTiming = pricingContext && typeof pricingContext.resolveSimulationTiming === 'function'
        ? pricingContext.resolveSimulationTiming(state)
        : null;
    if (simulationTiming && simulationTiming.available === false) {
        if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }
        const message = `Probability simulation unavailable because target timing is ${simulationTiming.status}.`;
        _probChart && _probChart.drawEmpty(message);
        _epnlChart && _epnlChart.drawEmpty(message);
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setAnchorInfoText(null);
        _setInfoText(message);
        return;
    }
    const quoteMs = Date.parse(String(state.liveQuoteAsOf || '').trim());
    const targetMs = Date.parse(String(simulationTiming && simulationTiming.targetAsOf || '').trim());
    const dateOnlyDays = diffDays(quoteDate, simulationDate);
    const zeroHorizon = Number.isFinite(quoteMs) && Number.isFinite(targetMs)
        ? targetMs <= quoteMs
        : dateOnlyDays === 0;
    if (zeroHorizon) {
        if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }
        _probChart && _probChart.drawEmpty('Advance the simulation date to see probabilities.');
        _epnlChart && _epnlChart.drawEmpty('No future time remains before the simulation target.');
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setAnchorInfoText(null);
        _setInfoText('Simulation target equals the current quote time (0 hours).');
        return;
    }

    const productRegistry = _getProbabilityProductRegistryApi();
    const underlyingProfile = productRegistry && typeof productRegistry.resolveUnderlyingProfile === 'function'
        ? productRegistry.resolveUnderlyingProfile(state.underlyingSymbol)
        : null;
    const horizonClock = _resolveProbabilityHorizonClock(
        pricingContext,
        underlyingProfile,
        quoteDate,
        simulationDate,
        simulationTiming
    );
    if (!horizonClock || horizonClock.available !== true) {
        if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }
        const missingDates = horizonClock && Array.isArray(horizonClock.missingWeightDates)
            ? horizonClock.missingWeightDates
            : [];
        const reason = horizonClock && horizonClock.status === 'calendar_unavailable'
            ? 'the official exchange calendar does not cover the simulation horizon'
            : (horizonClock && horizonClock.status === 'implied_lambda_incomplete'
                ? `the structured implied λ curve is missing ${missingDates.join(', ') || 'one or more required weekend/holiday dates'}; export a fresh curve from IV Term Structure or load the matching λ file`
                : 'the simulation clock is unavailable');
        const message = `Probability simulation unavailable because ${reason}.`;
        _probChart && _probChart.drawEmpty(message);
        _epnlChart && _epnlChart.drawEmpty(message);
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setAnchorInfoText(null);
        _setInfoText(message);
        return;
    }
    const lambdaLabel = horizonClock.usedPerDateWeight
        ? 'λ curve'
        : `λ=${Number(horizonClock.defaultNonTradingWeight).toFixed(2)}`;
    const nCalDays = horizonClock.calDays;
    const calendarHorizonLabel = nCalDays < 1
        ? `${(nCalDays * 24).toFixed(2)} h`
        : `${nCalDays.toFixed(nCalDays % 1 === 0 ? 0 : 2)} cd`;
    const horizonLabel = horizonClock.isCalendarClock
        ? calendarHorizonLabel
        : `${calendarHorizonLabel} (eff ${horizonClock.effDays.toFixed(3)}d, ${lambdaLabel})`;

    // Run the same per-leg gate as valuation before asking for a portfolio
    // mean IV.  Otherwise a failed strict BBO inversion can be misreported as
    // the generic "No usable option IV" condition and hide the actionable
    // feed/BBO or implied-λ reason from the user.
    const projectionFailure = _resolveProbabilityProjectionFailure(state, includedGroups);
    if (projectionFailure) {
        if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }
        _probChart && _probChart.drawEmpty(projectionFailure);
        _epnlChart && _epnlChart.drawEmpty(projectionFailure);
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setAnchorInfoText(null);
        _setInfoText(projectionFailure);
        return;
    }

    // Portfolio mean IV is already converted to this weighted clock at the
    // quote anchor by computePortfolioMeanSimIV().
    const portfolioIV = computePortfolioMeanSimIV();
    if (!portfolioIV || portfolioIV <= 0) {
        if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }
        _probChart && _probChart.drawEmpty('No usable option IV found to scale the distribution.');
        _epnlChart && _epnlChart.drawEmpty('');
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setAnchorInfoText(null);
        _setInfoText('Probability analysis needs at least one usable option IV input.');
        return;
    }

    // Price range from global P&L chart
    const { minS, maxS } = getGlobalChartRange();
    if (minS >= maxS) {
        if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }
        return;
    }
    const anchorPrice = _getProbabilityAnchorPrice();
    const anchorInfo = _getProbabilityAnchorInfo();

    const projectionAvailability = _resolvePortfolioProjectionAvailability(
        state,
        includedGroups,
        anchorPrice
    );
    if (!projectionAvailability.available) {
        if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }
        const message = 'Probability simulation unavailable because a bound futures quote is missing.';
        _probChart && _probChart.drawEmpty(message);
        _epnlChart && _epnlChart.drawEmpty(message);
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setAnchorInfoText(anchorInfo);
        _setInfoText(message);
        return;
    }

    // t-distribution parameters lookup
    const underlying = state.underlyingSymbol || 'SPY';
    const distributionProxyConfig = _getDistributionProxyConfigApi();
    const distributionSymbol = distributionProxyConfig
        && typeof distributionProxyConfig.resolveDistributionSymbol === 'function'
        ? distributionProxyConfig.resolveDistributionSymbol(underlying, underlyingProfile)
        : underlying;
    const params = T_DIST_PARAMS_DB[distributionSymbol];

    if (!params) {
        if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }
        const distributionLabel = distributionSymbol === underlying
            ? distributionSymbol
            : `${distributionSymbol} (proxy for ${underlying})`;
        _probChart && _probChart.drawEmpty(`No distribution parameters for ${distributionLabel}. Please run backend script.`);
        _epnlChart && _epnlChart.drawEmpty(`Run: python scripts/fit_underlying.py ${distributionSymbol}`);
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setAnchorInfoText(anchorInfo);
        _setInfoText(`Missing distribution parameters for ${distributionLabel}.`);
        return;
    }

    const { df, loc: rawLoc } = params;
    const useRandomWalk = document.getElementById('randomWalkToggle')?.checked || false;
    const loc = useRandomWalk ? 0 : rawLoc;
    const newScale = _calibrateScale(df, portfolioIV, horizonClock.effYear);
    const nPaths = 1_000_000;
    const bins = 500;

    // Show loading state
    _probChart && _probChart.drawLoading();
    _epnlChart && _epnlChart.drawLoading();
    _setAnchorInfoText(anchorInfo);
    const driftLabel = useRandomWalk ? ', Random Walk' : '';
    const proxyInfoText = distributionSymbol === underlying ? '' : ` | Dist Proxy: ${distributionSymbol}`;
    _setInfoText(`Simulating 1M paths × ${horizonLabel}  (IV ${(portfolioIV * 100).toFixed(1)}%${driftLabel})${proxyInfoText}…`);
    _setExpectedPnLBadge(null);
    _setCondExpectedPnLBadge('off', null);

    // Terminate any previous in-flight simulation
    if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }

    // Assemble legs for exact MC Pricing
    const workerLegs = [];
    let workerPricingFailure = null;
    const pricingCore = _getProbabilityPricingCoreApi();
    includedGroups.forEach(group => {
        group.legs.forEach(leg => {
            if (workerPricingFailure) return;
            const activeViewMode = group.viewMode || 'active';
            const legCurrentUnderlying = pricingContext
                && typeof pricingContext.resolveLegCurrentUnderlyingPrice === 'function'
                ? pricingContext.resolveLegCurrentUnderlyingPrice(state, leg, anchorPrice)
                : state.underlyingPrice;
            const legInterestRate = pricingContext
                && typeof pricingContext.resolveLegInterestRate === 'function'
                ? pricingContext.resolveLegInterestRate(state, leg, state.interestRate)
                : state.interestRate;
            const observable = pricingContext
                && typeof pricingContext.resolveObservableLegPrice === 'function'
                ? pricingContext.resolveObservableLegPrice(state, group, leg)
                : null;
            const quotePricingInputs = pricingContext
                && typeof pricingContext.resolveLegQuotePricingInputs === 'function'
                ? pricingContext.resolveLegQuotePricingInputs(state, leg, {
                    underlyingPrice: anchorPrice,
                    interestRate: state.interestRate,
                })
                : null;
            const timingContext = {
                quoteAsOf: state.liveQuoteAsOf,
                allowLegacyQuoteCutoff: !state.marketDataMode,
                targetAsOf: simulationTiming && simulationTiming.available
                    ? simulationTiming.targetAsOf
                    : null,
                targetSource: simulationTiming && simulationTiming.source || null,
                timingStatus: simulationTiming && simulationTiming.status || null,
                observablePrice: observable && observable.available ? observable.price : null,
                observablePriceSource: observable && observable.source || null,
                observablePriceAsOf: observable && observable.quoteAsOf || null,
                observablePriceFresh: observable && observable.fresh === true,
                quotePricingInputsAvailable: quotePricingInputs && quotePricingInputs.available === true,
                quotePricingInputStatus: quotePricingInputs && quotePricingInputs.status || null,
                quoteUnderlyingPrice: quotePricingInputs && quotePricingInputs.underlyingPrice,
                quoteUnderlyingAsOf: quotePricingInputs && quotePricingInputs.underlyingAsOf,
                quoteInterestRate: quotePricingInputs && quotePricingInputs.interestRate,
            };
            const pLeg = processLegData(
                leg,
                simulationDate,
                state.ivOffset,
                quoteDate,
                legCurrentUnderlying,
                legInterestRate,
                activeViewMode,
                underlyingProfile,
                state.marketDataMode,
                timingContext
            );
            if (pLeg.timingStatus === 'implied_lambda_incomplete') {
                workerPricingFailure = pricingCore
                    && typeof pricingCore.formatProjectionTimingFailure === 'function'
                    ? pricingCore.formatProjectionTimingFailure(
                        pLeg.timingStatus,
                        'Probability simulation',
                        pLeg
                    )
                    : 'Probability simulation unavailable: required weekend/holiday implied λ data is missing.';
                return;
            }
            const convergence = pricingCore
                && typeof pricingCore.assessProjectionConvergence === 'function'
                ? pricingCore.assessProjectionConvergence(state, [leg], [pLeg])
                : { ready: true };
            if (convergence.ready === false) {
                workerPricingFailure = pricingCore
                    && typeof pricingCore.formatProjectionConvergenceFailure === 'function'
                    ? pricingCore.formatProjectionConvergenceFailure(
                        convergence,
                        'Probability simulation'
                    )
                    : 'Probability simulation unavailable: strict live BBO convergence inputs are missing.';
                return;
            }
            if (!pLeg.isUnderlyingLeg && !pLeg.isExpired
                && (!Number.isFinite(pLeg.T) || pLeg.T <= 0
                    || !Number.isFinite(pLeg.rateT) || pLeg.rateT < 0
                    || !Number.isFinite(pLeg.simIV) || pLeg.simIV <= 0)) {
                workerPricingFailure = pLeg.timeStatus
                    || pLeg.timingStatus
                    || 'pricing_input_unavailable';
                return;
            }

            let fixedPrice = undefined;
            if (leg.closePrice !== null && leg.closePrice !== '') {
                const parsedClose = parseFloat(leg.closePrice);
                if (!isNaN(parsedClose) && parsedClose >= 0) {
                    fixedPrice = parsedClose;
                }
            }

            const underlyingScale = Number.isFinite(anchorPrice) && anchorPrice > 0
                && Number.isFinite(legCurrentUnderlying) && legCurrentUnderlying > 0
                ? legCurrentUnderlying / anchorPrice
                : null;
            const workerLeg = {
                id: String(leg.id || ''),
                type: pLeg.type,
                isUnderlyingLeg: !!pLeg.isUnderlyingLeg,
                isExpired: !!pLeg.isExpired,
                pricingModel: pLeg.pricingModel,
                strike: pLeg.strike,
                rate: legInterestRate,
                varianceT: pLeg.T,
                discountT: pLeg.rateT,
                volatility: pLeg.simIV,
                posMultiplier: pLeg.posMultiplier,
                costBasis: pLeg.costBasis,
                underlyingScale,
            };
            if (pLeg.pricingModel === 'american-binomial'
                && !pLeg.isUnderlyingLeg
                && !pLeg.isExpired
                && fixedPrice === undefined) {
                const americanGridPoints = 801;
                const scaledMin = minS * underlyingScale;
                const scaledMax = maxS * underlyingScale;
                const americanGridMin = Math.max(
                    0.0001,
                    Math.min(scaledMin, pLeg.strike) * 0.5
                );
                const americanGridMax = Math.max(
                    scaledMax,
                    pLeg.strike
                ) * 1.5;
                // The 801-point price-vs-spot grid is built inside the MC worker
                // (buildAmericanPriceGrid) so its O(points * steps^2) cost never
                // blocks the main thread. Only the parameters travel across; the
                // worker already receives type/strike/rate/varianceT/discountT/
                // volatility above. The grid step count is capped at the pricer's
                // DEFAULT_STEPS: this dense visualization grid gains nothing from
                // the higher single-quote precision a user may have selected.
                workerLeg.americanGridMin = americanGridMin;
                workerLeg.americanGridMax = americanGridMax;
                workerLeg.americanGridPoints = americanGridPoints;
                workerLeg.dividendYield = Number.isFinite(pLeg.dividendYield)
                    ? pLeg.dividendYield
                    : 0;
                workerLeg.binomialSteps = _americanCurveStepCap(pLeg.binomialSteps);
            }
            if (Number.isFinite(pLeg.expiryUnderlyingPrice)) {
                workerLeg.expiryUnderlyingPrice = pLeg.expiryUnderlyingPrice;
            }
            if (fixedPrice !== undefined) {
                workerLeg.fixedPrice = fixedPrice;
            }
            workerLegs.push(workerLeg);
        });
    });

    if (workerPricingFailure) {
        const message = String(workerPricingFailure).startsWith('Probability simulation unavailable')
            ? String(workerPricingFailure)
            : `Probability simulation unavailable (${workerPricingFailure}).`;
        _probChart && _probChart.drawEmpty(message);
        _epnlChart && _epnlChart.drawEmpty(message);
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setInfoText(message);
        return;
    }

    // Launch Worker
    _activeWorker = new Worker(_MC_WORKER_URL);
    _activeWorker.postMessage({
        df, loc, newScale,
        stepWeights: horizonClock.stepWeights,
        nPaths,
        currentPrice: anchorPrice,
        minS, maxS, bins,
        legs: workerLegs
    });

    // Capture closure values for the callback
    const _horizonEffDays = horizonClock.effDays;
    const _horizonEffYear = horizonClock.effYear;
    const _horizonLabel = horizonLabel;
    const _portfolioIV = portfolioIV;
    const _currentPrice = anchorPrice;
    const _loc = loc;
    const _useRandomWalk = useRandomWalk;
    const _underlying = underlying;
    const _distributionSymbol = distributionSymbol;
    const _regimeZone = _getRegimeConditionSelection();

    _activeWorker.onmessage = (e) => {
        _activeWorker = null;
        if (e.data && e.data.error) {
            const message = 'Probability simulation unavailable because a pricing input is missing.';
            _probChart && _probChart.drawEmpty(message);
            _epnlChart && _epnlChart.drawEmpty(message);
            _setExpectedPnLBadge(null);
            _setCondExpectedPnLBadge('off', null);
            _setInfoText(message);
            return;
        }
        const { tDensity, binCenters, binWidth, exactExpectedPnL } = e.data;

        // --- Normal / lognormal comparison (analytical, no sampling) ---
        const normalDensity = new Float64Array(bins);
        for (let i = 0; i < bins; i++) {
            normalDensity[i] = _lognormalDensity(
                binCenters[i], _currentPrice, _portfolioIV, _loc,
                _horizonEffDays, _horizonEffYear
            );
        }

        // --- P&L curve at each bin centre ---
        const pnlValues = new Float64Array(bins);
        let pnlUnavailable = false;
        for (let i = 0; i < bins; i++) {
            const pnl = _computePortfolioPnLAtPrice(binCenters[i]);
            if (!Number.isFinite(pnl)) {
                pnlUnavailable = true;
                break;
            }
            pnlValues[i] = pnl;
        }
        if (pnlUnavailable) {
            const message = 'Probability simulation unavailable because a pricing input is missing.';
            _probChart && _probChart.drawEmpty(message);
            _epnlChart && _epnlChart.drawEmpty(message);
            _setExpectedPnLBadge(null);
            _setCondExpectedPnLBadge('off', null);
            _setInfoText(message);
            return;
        }

        // --- Regime-conditioned overlay (historical zone outcomes replayed
        //     at today's anchor/EM scale) ---
        let condOverlay = null;
        if (_regimeZone !== 'off') {
            const zs = _getRegimeConditionalZs(_distributionSymbol, _regimeZone);
            const em = 0.7979 * _currentPrice * _portfolioIV
                * Math.sqrt(_horizonEffDays / _horizonEffYear);
            const built = zs
                ? _buildConditionalOverlay(zs, _currentPrice, em, binCenters, _computePortfolioPnLAtPrice)
                : null;
            condOverlay = built
                ? { ...built, label: REGIME_CONDITION_LABELS[_regimeZone], zone: _regimeZone }
                : null;
        }
        _setCondExpectedPnLBadge(_regimeZone, condOverlay);

        // --- Render Chart 2 ---
        if (_probChart) {
            _probChart.draw(binCenters, tDensity, normalDensity, minS, maxS, _currentPrice, anchorInfo, condOverlay);
        }

        // --- Render Chart 3 ---
        if (_epnlChart) {
            _epnlChart.draw(binCenters, pnlValues, tDensity, minS, maxS, _currentPrice, anchorInfo);
        }

        // --- Update badges ---
        _setExpectedPnLBadge(exactExpectedPnL);
        _setInfoText(
            `1M paths | ${_horizonLabel} | ` +
            `Mean IV: ${(_portfolioIV * 100).toFixed(1)}%` +
            (_useRandomWalk ? ' | Random Walk' : '') +
            (_distributionSymbol !== _underlying ? ` | Dist Proxy: ${_distributionSymbol}` : '')
        );
    };

    _activeWorker.onerror = (err) => {
        console.error('Monte Carlo Worker error:', err);
        _probChart && _probChart.drawEmpty('Simulation error — see console.');
        _epnlChart && _epnlChart.drawEmpty('');
        _setExpectedPnLBadge(null);
        _setCondExpectedPnLBadge('off', null);
        _setInfoText('Error during Monte Carlo simulation.');
        _activeWorker = null;
    };
}

// -----------------------------------------------------------------------
// 8.  Resize helper — redraw from cached data, no re-simulation
// -----------------------------------------------------------------------

function redrawProbChartsFromCache() {
    if (_probChart) _probChart.redraw();
    if (_epnlChart) _epnlChart.redraw();
}

// -----------------------------------------------------------------------
// 9.  UI badge helpers
// -----------------------------------------------------------------------

function _setExpectedPnLBadge(value) {
    const el = document.getElementById('expectedPnLBadge');
    if (!el) return;
    if (value === null || value === undefined || isNaN(value)) {
        el.textContent = '';
        return;
    }
    const sign = value >= 0 ? '+' : '';
    el.textContent = `Expected P&L: ${sign}${currencyFormatter.format(value)}`;
    el.style.color = value >= 0 ? '#059669' : '#DC2626';
}

function _setCondExpectedPnLBadge(zone, overlay) {
    const el = document.getElementById('condExpectedPnLBadge');
    if (!el) return;
    if (!zone || zone === 'off') {
        el.textContent = '';
        return;
    }
    if (!overlay) {
        el.textContent = `Conditioned: no ${REGIME_CONDITION_LABELS[zone] || zone} samples for this underlying`;
        el.style.color = '#9CA3AF';
        return;
    }
    const sign = overlay.expectedPnL >= 0 ? '+' : '';
    el.textContent = `Conditioned (${overlay.label}, n=${overlay.n}): ${sign}${currencyFormatter.format(overlay.expectedPnL)}`;
    el.style.color = overlay.expectedPnL >= 0 ? '#0D9488' : '#DC2626';
}

function _setInfoText(text) {
    const el = document.getElementById('probSimInfoText');
    if (el) el.textContent = text;
}

function _setAnchorInfoText(anchorInfo) {
    const el = document.getElementById('probAnchorInfoText');
    if (!el) return;

    if (!anchorInfo || anchorInfo.isFutureAnchor !== true) {
        el.textContent = '';
        el.style.display = 'none';
        return;
    }

    el.textContent = `${anchorInfo.displayText}. ${anchorInfo.detailText}`;
    el.style.display = 'block';
}
