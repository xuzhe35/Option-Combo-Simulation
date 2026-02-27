# Option Combo Simulator — Technical Debt & Risk Analysis
**Date:** 2026-02-27
**Target Audience:** Future Developers & AI Assistants

This document outlines the hidden risks and technical debts identified in the current state of the Option Combo Simulator project, along with recommendations for addressing them.

---

## 1. Architectural Tech Debt: Global Scope & Script Dependencies

### 🚨 Risk: Global Variable Pollution and Brittle Script Loading Chain
- **Description:** The `index.html` file currently loads 8 JavaScript scripts (e.g., `bsm.js` → `app.js` → `ws_client.js`) without using ES6 Modules (`<script type="module">`). Critical state variables and functions (like `state`, `processLegData`, `T_DIST_PARAMS_DB`) are directly exposed and mounted on the `window` global scope.
- **Impact:** This creates invisible coupling between files. As the codebase grows, it is highly susceptible to naming collisions and accidental state mutations. Furthermore, it prevents the use of modern build tools (like Vite or Webpack) for tree-shaking and minification.
- **Recommendation:** Refactor all `.js` files into ES6 Modules. Use `<script type="module" src="app.js"></script>` as the sole entry point in `index.html`, and use explicit imports (e.g., `import { processLegData } from './bsm.js'`) across the filesystem to fundamentally isolate scopes.

## 2. Pricing & Time Convention Risks

### ⚠️ Risk: Smoothness Discontinuity at Zero-Delta (T=0 Edge Case)
- **Description:** The "Zero-Delta bypass" feature replaces theoretical BSM prices with live market quotes when in Trial mode and $T=0$, eliminating theoretical P&L drift at expiry. However, in the hours right before expiration (e.g., $T=0.005$ days), the actual bid/ask midpoints often deviate significantly from pure BSM theoretical prices due to liquidity issues or extreme volatility smiles.
- **Impact:** When a user slowly drags the "Days Passed" slider from $T=0.01$ down to $T=0$, the pricing model experiences an abrupt, discontinuous switch. The P&L chart may exhibit severe, unnatural "cliff jumps" at the very end of the curve.
- **Recommendation:** Implement a smoothing interpolation for times extremely close to expiration ($T < 1$ day). Alternatively, when the slider approaches $T=0$, gradually phase the calculation from pure Greeks-based pricing to the live Mark quote proportionally based on remaining time, eliminating visual and mathematical jumps.

### 💸 Risk: Variance Overestimation Due to Constant Weekend Volatility
- **Description:** To align with TWS pricing behavior, the simulator recently switched from trading days (`tradDTE/252`) to calendar days (`calDTE/365`). While this fixes the "cross-weekend price plunge" bug, the reality is that options lose time value much slower over the weekend when markets are closed.
- **Impact:** The current model implies that time value decays at the exact same intensity on Saturday and Sunday as it does on a Tuesday.
- **Recommendation:** For maximum precision, introduce **"Weekend Variance Weighting"** within the time conversion or BSM calculation. For example, calibrate the engine so that "one weekend day’s decay equals 0.2 of a trading day’s decay," better simulating real-world overnight premium erosion.

## 3. Live Market Data Integration Risks

### ⚠️ Risk: Midpoint (Bid/Ask) Distortion During Liquidity Crunches
- **Description:** Around line 74 in `ib_server.py`, the option price is determined using the midpoint `(bid+ask)/2` if both `bid > 0` and `ask > 0`. If these are absent, it falls back to `ticker.marketPrice()`. This is generally good practice.
- **Impact:** For deep out-of-the-money (OTM) options, it's common to see a bid of `0` and an ask of, say, `5.0`. When this triggers the fallback to `marketPrice()`, Interactive Brokers often returns the price of **the last trade that occurred days or weeks ago (a stale quote)**, which may be entirely disconnected from the current underlying price.
- **Recommendation:** Before falling back to the potentially stale `marketPrice()`, attempt to extract `ticker.modelGreeks.optPrice` (the official Model Price calculated by IB based on the underlying). This provides a mathematically coherent valuation during liquidity absences, rather than a "zombie" last-trade price.

### 🔌 Tech Debt: WebSocket State Desync and Reconnection Recovery
- **Description:** Both the Python backend and the JavaScript client employ exponential backoff for reconnections. However, if the browser tab goes to sleep or experiences a brief network drop and then reconnects, the frontend does not explicitly resend the complete list of currently active option legs to the backend.
- **Impact:** The UI might show a green `🟢 Connected` badge, but the specific option legs in the user's groups will stop receiving live quotes because the backend's subscription state was cleared upon the disconnect.
- **Recommendation:** In `ws_client.js`, explicitly handle the WebSocket `onopen` event. Upon successful reconnection, iterate over `app.js`'s `state.groups` and automatically dispatch a fresh `subscribe` payload for all legs that have Live Data enabled.

## 4. Maintenance & Performance Risks

### 💣 Maintenance Timebomb: Hardcoded Market Holidays (`market_holidays.js`)
- **Description:** The `market_holidays.js` file contains a static, hardcoded array of dates generated by a Python script, currently only covering through the end of 2027 (`2027-12-24`).
- **Impact:** On January 1, 2028, the simulator will silently stop accounting for market holidays entirely unless a future maintainer remembers to run `scripts/gen_holidays.py` and commit the updated file. This will lead to systemic errors in the UI's trading day (`tradDTE`) calculations.
- **Recommendation:** This is a classic maintenance trap. Since US market holidays follow highly regular rules (e.g., "the fourth Thursday of November"), replace the static file with a pure JavaScript rule-based holiday calculation engine, or integrate a lightweight external API to fetch holidays dynamically on initialization.

### 🐌 Performance Risk: Main Thread Strain During Slider Drags
- **Description:** The recent refactor brilliantly moved the heavy 1-million-path Monte Carlo simulation off the main thread using an inline Web Worker (`_MC_WORKER_URL` in `prob_charts.js`). However, rapid dragging of the Underlying Price or Days Passed sliders still triggers synchronous BSM engine recalculations and Canvas array plotting on the main thread via `requestAnimationFrame`.
- **Impact:** If a user constructs a massive portfolio with dozens of complex, multi-leg combo groups, the constant recompilation of option math across hundreds of chart vertices during every slider pixel movement will cause frame drops and browser stuttering on lower-end devices.
- **Recommendation:** While currently acceptable, future expansions (like backtesting massive strategy matrices or rendering 3D volatility surfaces) should migrate the core BSM array generation and P&L curve calculation into a dedicated WebSocket connection or a persistent Web Worker, leaving the main thread responsible solely for pure UI rendering and Canvas drawing.
