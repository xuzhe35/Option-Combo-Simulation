const fs = require('fs');

function normalCDF(x) {
    let sign = (x < 0) ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2.0);
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
}

function calculateD1(S, K, T, r, v) {
    return (Math.log(S / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
}

function calculateD2(d1, v, T) {
    return d1 - v * Math.sqrt(T);
}

function calculateOptionPrice(type, S, K, T, r, v) {
    if (T <= 0) {
        if (type === 'call') return Math.max(0, S - K);
        if (type === 'put') return Math.max(0, K - S);
        return 0;
    }
    if (v <= 0) v = 0.0001;
    if (S <= 0) S = 0.0001;
    const d1 = calculateD1(S, K, T, r, v);
    const d2 = calculateD2(d1, v, T);
    if (type === 'call') {
        return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
    } else if (type === 'put') {
        return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
    }
    return 0;
}

console.log("3 Days (3/252):", calculateOptionPrice('call', 100, 100, 3 / 252, 0.045, 0.2));
console.log("2 Days (2/252):", calculateOptionPrice('call', 100, 100, 2 / 252, 0.045, 0.2));
console.log("1 Days (1/252):", calculateOptionPrice('call', 100, 100, 1 / 252, 0.045, 0.2));

console.log("---");
console.log("If using 365 days base for T:");
console.log("3 Days (3/365):", calculateOptionPrice('call', 100, 100, 3 / 365, 0.045, 0.2));
console.log("2 Days (2/365):", calculateOptionPrice('call', 100, 100, 2 / 365, 0.045, 0.2));
console.log("1 Days (1/365):", calculateOptionPrice('call', 100, 100, 1 / 365, 0.045, 0.2));
