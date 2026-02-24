# Option Combo Simulator - Development Handover Log & Architecture Notes 

**Date:** 2026-02-23 (Late Session)
**Target Audience:** Future Developers & AI Assistants (e.g., Claude Code)

This log documents a major architectural refactoring (DRY enforcement) and the resolution of several critical mathematical and UI bugs in the Option Combo Simulation project. Please read this before modifying the core option pricing logic or Monte Carlo engine arrays.

---

## 1. Single Source of Truth (SSOT): The `bsm.js` Refactoring
**Problem:** Previously, the project suffered from severe "Magic Calculation" redundancy. The mathematical formulas evaluating calendar Days to Expiration (DTE), Implied Volatility (IV), Option Multipliers (`* 100`), and the core branching between "Expired Option" (Intrinsic Value) and "Active Option" (Black-Scholes-Merton) were duplicated manually across `app.js` (Holdings P&L), `chart.js` (P&L Chart rendering), and `prob_charts.js` (Monte Carlo simulations). This caused severe synchronization and math stability issues.

**Solution:**
We stripped all repetitive math from the UI layers and transformed `bsm.js` into strictly the one centralized **Global Option Engine**.
- **`processLegData(leg, globalSimDateStr, globalIvOffset)`**: Takes a raw leg object array from the state and strictly formats/enforces synchronized `T` (Years to exp), `calDTE`, `tradDTE`, `posMultiplier` (via `getMultiplier()`), and `simIV`.
- **`computeLegPrice(processedLeg, underlyingPrice, interestRate)`**: Strictly computes theoretical price per share. If the option is expired, it returns Intrinsic Value natively. If it is active, it routes to `calculateOptionPrice` (BSM). 
**Impact:** `app.js`, `chart.js`, and `prob_charts.js` now strictly rely on calling these two functions in their rendering/simulation loops. Do not manually write `pos * 100 * pps` anywhere else in the project.

---

## 2. Core Monte Carlo Mathematics Fix (Expected P&L Bug)
**Problem:** The application displayed a massive mathematically impossible `Expected P&L` (e.g. +$786) for short straddle/strangle positions which inherently have catastrophic asymmetric tail risk and should yield a negative expectation.
**Root Cause:**
Inside the `_MC_WORKER_CODE` in `prob_charts.js`, the code was visually clipping random walk simulation prices (`finalPrice`) using bounding arrays (`minS` to `maxS`). The mathematical Expectation was calculated by summing the total paths, but mistakenly dividing by **`pathsInRange`** (paths visible on the screen). 
By dividing by an artificially bounded array and excluding the literal massive loss tails at the end of the un-bounded student-t distribution, we were technically calculating the average *peak* of the profitability bell curve, completely ignoring the probability density of the left/right extreme wings (Max Loss).
**Solution:**
- The Monte Carlo iteration (`pathPnL`) now executes across the entirety of the probability spectrum, including out-of-bounds prices.
- The `exactExpectedPnL` is strictly normalized by `nPaths` (the absolute total 1,000,000 samples executed), returning the mathematically factual full-spectrum Riemann sum.

---

## 3. UI/UX Enhancements
- **±5% Chart Range View:** Added a `±5%` mode to both Global and Group-level charts. Very critical for 0-DTE strategies to evaluate the probability of hitting single-day S&P 500 circuit breakers. Our JavaScript `mode / 100.0` logic ingests numerical string IDs dynamically native.
- **Table Stability:** 
  - `white-space: nowrap` injected onto `.simulated-text` inside `style.css` to prevent `Sim IV` labels from word-wrapping on smaller screens and causing ugly asymmetrical row height bloat.
  - Stripped redundant `max-height: 400px` and `overflow-y: auto` from the internal `.table-responsive` Group Cards templates, eliminating the notorious dual-scrollbar scrolling conflicts.

---

## 4. Work Directory Hygiene
All disposable and manual simulation scripts used to isolate the Expected P&L Riemann bug have been purged from the core directory structure.
The `scripts/` folder now formally maintains the essential `spx_fit.py` (which fetches Yahoo Finance data and regenerates the Student-t MLE static parameters over to `t_params.js`). 

***
*End of Protocol. The project is presently completely mathematically synchronized and highly legible for continued expansion.*
