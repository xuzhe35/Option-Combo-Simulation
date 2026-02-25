/**
 * Black-Scholes-Merton (BSM) Option Pricing Logic
 * Standard European Options Pricing
 */

// Normal Cumulative Distribution Function (CDF)
// Approximation using a polynomial method (Abramowitz & Stegun)
function normalCDF(x) {
    // Save the sign of x
    let sign = (x < 0) ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2.0);

    // A&S formula 7.1.26
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
}

// Calculate d1
function calculateD1(S, K, T, r, v) {
    return (Math.log(S / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
}

// Calculate d2
function calculateD2(d1, v, T) {
    return d1 - v * Math.sqrt(T);
}

/**
 * Calculates theoretical option price using BSM
 * @param {string} type - 'call' or 'put'
 * @param {number} S - Underlying Price
 * @param {number} K - Strike Price
 * @param {number} T - Time to Expiration (in years, e.g., days/365)
 * @param {number} r - Risk-free Interest Rate (decimal, e.g., 0.05)
 * @param {number} v - Volatility (decimal, e.g., 0.20)
 * @returns {number} Theoretical price
 */
function calculateOptionPrice(type, S, K, T, r, v) {
    // Handle edge cases
    if (T <= 0) {
        if (type === 'call') return Math.max(0, S - K);
        if (type === 'put') return Math.max(0, K - S);
        return 0;
    }

    if (v <= 0) v = 0.0001; // Avoid divide by zero
    if (S <= 0) S = 0.0001; // Avoid log(0)

    const d1 = calculateD1(S, K, T, r, v);
    const d2 = calculateD2(d1, v, T);

    if (type === 'call') {
        const nd1 = normalCDF(d1);
        const nd2 = normalCDF(d2);
        return S * nd1 - K * Math.exp(-r * T) * nd2;
    } else if (type === 'put') {
        const nMinusD1 = normalCDF(-d1);
        const nMinusD2 = normalCDF(-d2);
        return K * Math.exp(-r * T) * nMinusD2 - S * nMinusD1;
    }

    return 0;
}

// -------------------------------------------------------------
// Global Date & Trading System Utilities
// -------------------------------------------------------------

function getMultiplier() {
    return 100; // Standard US option multiplier
}

function diffDays(d1Str, d2Str) {
    const d1 = new Date(d1Str + 'T00:00:00Z');
    const d2 = new Date(d2Str + 'T00:00:00Z');
    const Math_round = Math.round((d2 - d1) / 86400000);
    return Math.max(0, Math_round);
}

function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + parseInt(days, 10));
    return d.toISOString().slice(0, 10);
}

function calendarToTradingDays(startDateStr, endDateStr) {
    let start = new Date(startDateStr + 'T00:00:00Z');
    let end = new Date(endDateStr + 'T00:00:00Z');
    if (start > end) return 0;

    let days = 0;
    let current = new Date(start);
    while (current < end) {
        const dayOfWeek = current.getUTCDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            days++;
        }
        current.setUTCDate(current.getUTCDate() + 1);
    }
    return days;
}

// -------------------------------------------------------------
// Single Source of Truth Wrapper For Parsing Raw Leg Data
// -------------------------------------------------------------

/**
 * Standardize leg input processing across all UI rendering and charting arrays.
 * Extracts the exact date strings & handles logic branching for expiration.
 */
function processLegData(leg, globalSimulatedDateStr, globalIvOffset, globalBaseDateStr = null, globalUnderlyingPrice = null, globalInterestRate = null, viewMode = 'active') {
    const simDateObj = new Date(globalSimulatedDateStr + 'T00:00:00Z');
    const expDateObj = new Date(leg.expDate + 'T00:00:00Z');

    // Check if relative to SIMULATION it has expired
    const isExpired = expDateObj <= simDateObj;

    // Trading / Calendar days until maturity relative to SIMULATION date
    const calDTE = isExpired ? 0 : diffDays(globalSimulatedDateStr, leg.expDate);
    const tradDTE = isExpired ? 0 : calendarToTradingDays(globalSimulatedDateStr, leg.expDate);

    // Target calculation values
    const T = tradDTE / 252.0;
    const simIV = Math.max(0.001, leg.iv + globalIvOffset);
    const posMultiplier = leg.pos * getMultiplier();

    // --------------------------------------------------------------------------
    // Trial vs Active Position Cost Logic
    // If viewMode === 'active' AND cost > 0, it's an executed position (Fixed).
    // If viewMode === 'trial' OR cost === 0, it's a Trial combo: price it dynamically at T=0.
    // --------------------------------------------------------------------------
    let effectiveCostPerShare = leg.cost;

    if (viewMode === 'trial' || leg.cost === 0 || leg.cost === 0.00) {
        if (leg.currentPrice && leg.currentPrice > 0) {
            // Live Data Stream Active - use exact current bid/ask/mark
            effectiveCostPerShare = leg.currentPrice;
        } else if (globalBaseDateStr && globalUnderlyingPrice !== null && globalInterestRate !== null) {
            // Offline - calculate the BSM theoretical value exactly at the physical BASE date (Today), ignoring simulation timeline/IV sliders
            const baseCalDTE = diffDays(globalBaseDateStr, leg.expDate);
            const baseTradDTE = calendarToTradingDays(globalBaseDateStr, leg.expDate);
            const baseT = baseTradDTE / 252.0;

            if (baseT <= 0) {
                if (leg.type === 'call') effectiveCostPerShare = Math.max(0, globalUnderlyingPrice - leg.strike);
                else effectiveCostPerShare = Math.max(0, leg.strike - globalUnderlyingPrice);
            } else {
                effectiveCostPerShare = calculateOptionPrice(
                    leg.type,
                    globalUnderlyingPrice,
                    leg.strike,
                    baseT,
                    globalInterestRate,
                    leg.iv // Theoretical cost strictly ignores the global IV offset for current base origin
                );
            }
        }
    }

    const costBasis = posMultiplier * effectiveCostPerShare;

    return {
        type: leg.type,
        strike: leg.strike,
        pos: leg.pos,
        isExpired,
        calDTE,
        tradDTE,
        T,
        simIV,
        posMultiplier,
        costBasis,
        effectiveCostPerShare
    };
}

/**
 * Given a set of pre-processed mathematical variables, branch between BSM or Intrinsic.
 * @returns {number} The absolute option price (Premium), unaffected by position size/sign.
 */
function computeLegPrice(processedLeg, underlyingPrice, interestRate) {
    if (processedLeg.isExpired) {
        if (processedLeg.type === 'call') {
            return Math.max(0, underlyingPrice - processedLeg.strike);
        } else {
            return Math.max(0, processedLeg.strike - underlyingPrice);
        }
    } else {
        return calculateOptionPrice(
            processedLeg.type,
            underlyingPrice,
            processedLeg.strike,
            processedLeg.T,
            interestRate,
            processedLeg.simIV
        );
    }
}

/**
 * Unified simulated price calculation with Zero-Delta bypass.
 * When in Trial mode, evaluating "right now" (simDate === baseDate, no IV offset),
 * AND a live quote exists, bypass BSM to avoid micro-drift fake P&L.
 *
 * @param {Object} processedLeg - Output from processLegData()
 * @param {Object} rawLeg - Original leg data (needs .currentPrice)
 * @param {number} underlyingPrice - Current underlying price
 * @param {number} interestRate - Risk-free rate
 * @param {string} viewMode - 'active' or 'trial'
 * @param {string} simulatedDate - YYYY-MM-DD simulated date
 * @param {string} baseDate - YYYY-MM-DD base date (today)
 * @param {number} ivOffset - Global IV offset (decimal)
 * @returns {number} Simulated price per share
 */
function computeSimulatedPrice(processedLeg, rawLeg, underlyingPrice, interestRate, viewMode, simulatedDate, baseDate, ivOffset) {
    const isEvaluatingRightNow = (simulatedDate === baseDate) && (ivOffset === 0);
    if (viewMode === 'trial' && isEvaluatingRightNow && rawLeg.currentPrice > 0) {
        return rawLeg.currentPrice;
    }
    return computeLegPrice(processedLeg, underlyingPrice, interestRate);
}
