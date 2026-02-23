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
