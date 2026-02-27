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
 * Main Worker message handler.
 *
 * Receives:
 *   { df, loc, newScale, nDays, nPaths, currentPrice, minS, maxS, bins, legs }
 *
 * Posts back (with transferable buffers):
 *   { tDensity, binCenters, binWidth, exactExpectedPnL }
 */
self.onmessage = function(e) {
    const { df, loc, newScale, nDays, nPaths, currentPrice, minS, maxS, bins, legs } = e.data;

    const binWidth = (maxS - minS) / bins;
    const counts   = new Float64Array(bins);   // raw path counts per bin

    // --- Precompute Leg Constants for speed ---
    if (legs) {
        for (let l = 0; l < legs.length; l++) {
            const leg = legs[l];
            leg.isExpired = (leg.T <= 0);
            if (!leg.isExpired) {
                let v = leg.v <= 0 ? 0.0001 : leg.v;
                leg.v_sqrt_T = v * Math.sqrt(leg.T);
                leg.inv_v_sqrt_T = 1.0 / leg.v_sqrt_T;
                // Pre-log standard component log(1/K)
                leg.d1_const = (-Math.log(leg.K) + (leg.r + 0.5 * v * v) * leg.T) / leg.v_sqrt_T;
                leg.K_exp_rT = leg.K * Math.exp(-leg.r * leg.T);
            }
        }
    }

    let exactPnLSum = 0.0;
    let pathsInRange = 0;

    for (let i = 0; i < nPaths; i++) {
        // Accumulate nDays daily log-returns
        let logRet = 0.0;
        for (let d = 0; d < nDays; d++) {
            logRet += tSample(df, loc, newScale);
        }
        // Final price
        const finalPrice = currentPrice * Math.exp(logRet);
        const binIdx = Math.floor((finalPrice - minS) / binWidth);
        const inRange = (binIdx >= 0 && binIdx < bins);
        
        if (inRange) {
            counts[binIdx]++;
        }

        // Exact BSM path pricing if legs provided (calculate for ALL paths for true Expectation)
        if (legs && legs.length > 0) {
            let pathPnL = 0.0;
            const s_safe = finalPrice > 0 ? finalPrice : 0.0001;
            const log_S = Math.log(s_safe);
            
            for (let l = 0; l < legs.length; l++) {
                const leg = legs[l];
                let v_opt = 0;
                if (leg.isExpired) {
                    if (leg.type === 'call') v_opt = Math.max(0, finalPrice - leg.K);
                    else                     v_opt = Math.max(0, leg.K - finalPrice);
                } else {
                    const d1 = log_S * leg.inv_v_sqrt_T + leg.d1_const;
                    const d2 = d1 - leg.v_sqrt_T;
                    if (leg.type === 'call') {
                        v_opt = finalPrice * normalCDF(d1) - leg.K_exp_rT * normalCDF(d2);
                    } else {
                        v_opt = leg.K_exp_rT * normalCDF(-d2) - finalPrice * normalCDF(-d1);
                    }
                }
                pathPnL += leg.posMultiplier * v_opt - leg.costBasis;
            }
            exactPnLSum += pathPnL;
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
 * Recalibrate the t-distribution scale so that its std equals IV/sqrt(365).
 * We keep df (tail shape) and loc (drift) from the historical SPX fit.
 *
 *   t-dist daily std = scale * sqrt(df / (df - 2))  for df > 2
 *   → new_scale = (IV / sqrt(365)) / sqrt(df / (df - 2))
 */
function _calibrateScale(df, portfolioIV) {
    const targetDailyVol = portfolioIV / Math.sqrt(365);
    if (df <= 2.001) return targetDailyVol;  // variance undefined; safe fallback
    return targetDailyVol / Math.sqrt(df / (df - 2));
}

/**
 * Lognormal (normal-model) probability density for the price S at the
 * simulation date, using the same drift as the t-model (historical loc).
 *
 *   log(S_T / S0) ~ Normal(mu_total, sigma_total^2)
 *   mu_total    = loc * nDays
 *   sigma_total = (portfolioIV / sqrt(365)) * sqrt(nDays)
 */
function _lognormalDensity(s, S0, portfolioIV, loc, nDays) {
    if (s <= 0 || S0 <= 0 || nDays <= 0) return 0;
    const sigma = (portfolioIV / Math.sqrt(365)) * Math.sqrt(nDays);
    const mu = loc * nDays;
    if (sigma <= 0) return 0;
    const z = (Math.log(s / S0) - mu) / sigma;
    return (1.0 / (s * sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * z * z);
}

/**
 * Compute the portfolio's P&L at a given underlying price using the
 * BSM model with the current simulation date and IV settings.
 * Replicates the logic in chart.js / app.js updateDerivedValues().
 */
function _computePortfolioPnLAtPrice(price) {
    if (!state || !state.groups) return 0;

    let totalValue = 0;
    let totalCost = 0;

    state.groups.forEach(group => {
        const activeViewMode = group.viewMode || 'active';
        group.legs.forEach(leg => {
            // Use processLegData to handle unified BSM formatting (Exp, Implied Vol offset, T)
            const pLeg = processLegData(leg, state.simulatedDate, state.ivOffset, state.baseDate, state.underlyingPrice, state.interestRate, activeViewMode);
            // Use unified simulation price (includes Zero-Delta bypass at current price)
            const pps = computeSimulatedPrice(
                pLeg, leg, price, state.interestRate,
                activeViewMode, state.simulatedDate, state.baseDate, state.ivOffset
            );

            totalValue += pLeg.posMultiplier * pps;
            totalCost += pLeg.costBasis;
        });
    });

    return totalValue - totalCost;
}

/**
 * Simple moving-average smoother to make the MC histogram look continuous.
 * Window of 7 gives a gentle blur without distorting the shape.
 */
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

    draw(binCenters, tDensity, normalDensity, minS, maxS, currentPrice) {
        // Save args so we can redraw on resize without re-simulating
        this._cache = { binCenters, tDensity, normalDensity, minS, maxS, currentPrice };

        const { ctx, w, h } = _resizeCanvas(this.canvas, 220);
        ctx.clearRect(0, 0, w, h);

        const pad = this.padding;
        const drawW = w - pad.left - pad.right;
        const drawH = h - pad.top - pad.bottom;
        const bins = binCenters.length;

        // Apply visual smoothing (does NOT affect E[P&L] calculation)
        const tSmooth = _smooth(tDensity, 7);
        const nSmooth = _smooth(normalDensity, 5);

        // Y scale: max density + 10% headroom
        let maxD = 0;
        for (let i = 0; i < bins; i++) {
            if (tSmooth[i] > maxD) maxD = tSmooth[i];
            if (nSmooth[i] > maxD) maxD = nSmooth[i];
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
    }

    redraw() {
        if (this._cache) {
            const c = this._cache;
            this.draw(c.binCenters, c.tDensity, c.normalDensity, c.minS, c.maxS, c.currentPrice);
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

    draw(binCenters, pnlValues, tDensity, minS, maxS, currentPrice) {
        this._cache = { binCenters, pnlValues, tDensity, minS, maxS, currentPrice };

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
            this.draw(c.binCenters, c.pnlValues, c.tDensity, c.minS, c.maxS, c.currentPrice);
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

// -----------------------------------------------------------------------
// 7.  updateProbCharts()  — main orchestrator called from app.js
// -----------------------------------------------------------------------

function updateProbCharts() {
    const container = document.getElementById('probAnalysisContainer');
    if (!container || container.style.display === 'none') return;

    _ensureCharts();

    // Guard: need at least one leg
    const allLegs = state.groups.flatMap(g => g.legs);
    if (allLegs.length === 0) {
        _probChart && _probChart.drawEmpty('Add option legs to see probability analysis.');
        _epnlChart && _epnlChart.drawEmpty('Add option legs to see expected P&L density.');
        _setExpectedPnLBadge(null);
        _setInfoText('No legs in portfolio.');
        return;
    }

    // Guard: need at least 1 calendar day of horizon
    const nCalDays = diffDays(state.baseDate, state.simulatedDate);
    if (nCalDays === 0) {
        _probChart && _probChart.drawEmpty('Advance the simulation date to see probabilities.');
        _epnlChart && _epnlChart.drawEmpty('No future days to simulate (simulation date = today).');
        _setExpectedPnLBadge(null);
        _setInfoText('Simulation date = today  (0 days).');
        return;
    }

    // Portfolio mean simulated IV
    const portfolioIV = computePortfolioMeanSimIV();
    if (!portfolioIV || portfolioIV <= 0) {
        _probChart && _probChart.drawEmpty('No valid IV found in portfolio legs.');
        _epnlChart && _epnlChart.drawEmpty('');
        _setExpectedPnLBadge(null);
        return;
    }

    // Price range from global P&L chart
    const { minS, maxS } = getGlobalChartRange();
    if (minS >= maxS) return;

    // t-distribution parameters lookup
    const underlying = state.underlyingSymbol || 'SPY';
    const params = T_DIST_PARAMS_DB[underlying];

    if (!params) {
        _probChart && _probChart.drawEmpty(`No distribution parameters for ${underlying}. Please run backend script.`);
        _epnlChart && _epnlChart.drawEmpty(`Run: python scripts/fit_underlying.py ${underlying}`);
        _setExpectedPnLBadge(null);
        _setInfoText(`Missing parameters for ${underlying}.`);
        return;
    }

    const { df, loc: rawLoc } = params;
    const useRandomWalk = document.getElementById('randomWalkToggle')?.checked || false;
    const loc = useRandomWalk ? 0 : rawLoc;
    const newScale = _calibrateScale(df, portfolioIV);
    const nPaths = 1_000_000;
    const bins = 500;

    // Show loading state
    _probChart && _probChart.drawLoading();
    _epnlChart && _epnlChart.drawLoading();
    const driftLabel = useRandomWalk ? ', Random Walk' : '';
    _setInfoText(`Simulating 1M paths × ${nCalDays} cd  (IV ${(portfolioIV * 100).toFixed(1)}%${driftLabel})…`);
    _setExpectedPnLBadge(null);

    // Terminate any previous in-flight simulation
    if (_activeWorker) { _activeWorker.terminate(); _activeWorker = null; }

    // Assemble legs for exact MC Pricing
    const simDateObj = new Date(state.simulatedDate + 'T00:00:00Z');
    const workerLegs = [];
    state.groups.forEach(group => {
        group.legs.forEach(leg => {
            const activeViewMode = group.viewMode || 'active';
            const pLeg = processLegData(leg, state.simulatedDate, state.ivOffset, state.baseDate, state.underlyingPrice, state.interestRate, activeViewMode);

            workerLegs.push({
                type: pLeg.type,
                K: pLeg.strike,
                r: state.interestRate,
                T: pLeg.T,
                v: pLeg.simIV,
                posMultiplier: pLeg.posMultiplier,
                costBasis: pLeg.costBasis
            });
        });
    });

    // Launch Worker
    _activeWorker = new Worker(_MC_WORKER_URL);
    _activeWorker.postMessage({
        df, loc, newScale,
        nDays: nCalDays,
        nPaths,
        currentPrice: state.underlyingPrice,
        minS, maxS, bins,
        legs: workerLegs
    });

    // Capture closure values for the callback
    const _nCalDays = nCalDays;
    const _portfolioIV = portfolioIV;
    const _currentPrice = state.underlyingPrice;
    const _loc = loc;
    const _useRandomWalk = useRandomWalk;

    _activeWorker.onmessage = (e) => {
        _activeWorker = null;
        const { tDensity, binCenters, binWidth, exactExpectedPnL } = e.data;

        // --- Normal / lognormal comparison (analytical, no sampling) ---
        const normalDensity = new Float64Array(bins);
        for (let i = 0; i < bins; i++) {
            normalDensity[i] = _lognormalDensity(
                binCenters[i], _currentPrice, _portfolioIV, _loc, _nCalDays
            );
        }

        // --- P&L curve at each bin centre ---
        const pnlValues = new Float64Array(bins);
        for (let i = 0; i < bins; i++) {
            pnlValues[i] = _computePortfolioPnLAtPrice(binCenters[i]);
        }

        // --- Render Chart 2 ---
        if (_probChart) {
            _probChart.draw(binCenters, tDensity, normalDensity, minS, maxS, _currentPrice);
        }

        // --- Render Chart 3 ---
        if (_epnlChart) {
            _epnlChart.draw(binCenters, pnlValues, tDensity, minS, maxS, _currentPrice);
        }

        // --- Update badges ---
        _setExpectedPnLBadge(exactExpectedPnL);
        _setInfoText(
            `1M paths | ${_nCalDays} cd | ` +
            `Mean IV: ${(_portfolioIV * 100).toFixed(1)}%` +
            (_useRandomWalk ? ' | Random Walk' : '')
        );
    };

    _activeWorker.onerror = (err) => {
        console.error('Monte Carlo Worker error:', err);
        _probChart && _probChart.drawEmpty('Simulation error — see console.');
        _epnlChart && _epnlChart.drawEmpty('');
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

function _setInfoText(text) {
    const el = document.getElementById('probSimInfoText');
    if (el) el.textContent = text;
}
