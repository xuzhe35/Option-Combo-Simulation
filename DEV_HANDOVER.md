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

## 5. Multi-Underlying Probability Distribution Expansion
**Problem:** The Monte Carlo simulations previously hardcoded the probability distribution statistics (degrees of freedom, drift) based on purely a static `spx_fit.py` calculation of the S&P 500 index. Simulating a volatile stock like AAPL or an ETF like QQQ using the parameters of the SPY resulted in inaccurate tail probability shapes.
**Solution:**
- Created `scripts/fit_underlying.py` which takes an arbitrary number of ticker arguments (e.g. `python scripts/fit_underlying.py AAPL QQQ SPY`). The script will fit Student-t parameters (df, loc, scale) independently using 10 years of historical data for each ticker via Yahoo Finance.
- Replaced the hardcoded Javascript inclusion with a dynamic dictionary database file: `t_params_db.js`. This creates a global `T_DIST_PARAMS_DB` JSON object.
- Modified `prob_charts.js` to look up `T_DIST_PARAMS_DB` dynamically matching the `state.underlyingSymbol`.
- If an unknown underlying is entered, the interface will automatically decline to calculate the probability and display a command-line prompt hinting the developer to execute the fit script for that specific ticker.

## 6. Monte Carlo Optimization & Live Data Sync
**Problem 1:** The Monte Carlo simulations previously triggered a million-path recalculation every time the UI sliders (underlying price, DTE) were dragged, consuming massive CPU cycles and causing UI lag.
**Solution 1:** Decoupled `scheduleProbChartUpdate()` from standard UI updates. Added a dedicated `🔄 Recalculate` button to the Probability Analysis panel, ensuring the expensive simulation is explicitly user-triggered.

**Problem 2:** Importing a JSON combo template updated the frontend Symbol correctly, but failed to re-subscribe the backend WebSocket stream (it continued feeding original tickers like SPY instead of AAPL).
**Solution 2:** Injected `handleLiveSubscriptions()` at the end of `importFromJSON(event)` inside `app.js` to dispatch the correct ticker downstream post-import.

## 7. Multi-Channel IB WebSocket Server
**Problem:** The original `ib_server.py` used a single global `current_subscriptions` dictionary. Opening a second browser tab for a different underlying symbol (e.g., AAPL) would overwrite the global subscriptions and broadcast the new AAPL data to the original SPY tab.
**Solution:** 
- Refactored `ib_server.py` to use a `client_subscriptions` dictionary that maps each active `websocket` connection to its specific `Ticker` objects.
- `on_pending_tickers` now iterates over connected clients, independently packaging customized JSON payloads containing only the data that specific browser tab requested.
- Added `unsubscribe_client_safely(ws)` to securely manage IB `cancelMktData` calls using reference counting across all active clients, ensuring we don't sever data feeds that other tabs are still relying on.

## 8. Dual-Track Cost Basis Charting (Trial vs Active)
**Problem:** A trader with an active/filled option (which possesses a historical, locked `Cost`) may still want to visually evaluate the Expected P&L derived from the `Current Live Price` (to decide whether to add or close a position right now). Previously, `Live Market Data` incorrectly overwrote the history `Cost`, ruining the tracking of open positions.
**Solution:**
- The DOM was vertically compressed to stack `DTE / Vol` and `Price / Cost` inputs, reclaiming significant horizontal space for laptop screens.
- `state.groups[i].viewMode` (`'active'` or `'trial'`) was introduced into `app.js` governed by a toggle button inside the UI.
- `bsm.js -> processLegData()` now dynamically branches the output `costBasis`:
  - If `viewMode === 'active'` and a non-zero Cost exists, it binds the mathematical expected P&L charts strictly to this historical locked floor.
  - If `viewMode === 'trial'` (or `Cost === 0`), it automatically falls back to utilizing the current leg Price (or calculates the BSM fair value for exactly *Today* if offline), granting an exact real-time snapshot of the Expected Value curve strictly for un-filled combinations.

## 9. Live Market Data IV & Zero-Delta Math Drift
**Problem:** A strict Black-Scholes-Merton model calculates theoretical option values that will always deviate slightly (by fractions of a percent) from real-world real-time bid/ask prices due to market inefficiencies. In Trial Mode at $T=Now$, bridging real-world `Cost` against BSM `Simulated Value` created instantaneous fake P&L drift. Furthermore, `ib_insync`'s default `reqMktData` stream suppresses `impliedVolatility`, blinding the simulation engine to real-time Greek crushes.
**Solution:**
- **Zero-Delta BSM Isolation:** `app.js` now strictly intercepts the evaluation cycle. If `viewMode === 'trial'` AND the user is simulating exactly Today ($T=0$) with no IV offsets, it bypasses BSM entirely and pins `Simulated Value` strictly to the exact ingested Live Quote `mark`, guaranteeing a secure \$0.00 P&L baseline.
- **IBKR Generic Tick 106:** `ib_server.py` was patched to inject `genericTickList='106'` into the `reqMktData` payload, forcing Interactive Brokers to compute and stream Option Model Greeks seamlessly.
- **Micro-Float DOM Integration:** IV parsing in frontend `app.js` was untethered from standard `0.001` dollar-value float thresholds down to `0.000001` to capture microscopic decimal shifts, formatted via `(liveIV * 100).toFixed(4) + '%'` to reveal native breathing movements directly inside the DOM.

---

## 10. Technical Debt Audit & SSOT Enforcement (2026-02-25)
A full-codebase audit uncovered several residual synchronization defects — the exact same category of bug that motivated the original `bsm.js` SSOT refactoring in Section 1. All items below have been resolved.

### 10.1 P0 Bug: `importFromJSON` calendarToTradingDays Misuse
**Problem:** Inside `importFromJSON()`, the trading-day display after loading a JSON file called `calendarToTradingDays(days)` — passing a single integer (calendar day count) instead of the required two date-string arguments `(startDateStr, endDateStr)`. This caused the imported state to display an incorrect trading-day count in the UI.
**Root Cause:** When `bindControlPanelEvents()` was updated to the correct dual-argument signature, the parallel call inside `importFromJSON()` was missed — a textbook "fixed one place, forgot the other" synchronization failure.
**Fix:** `calendarToTradingDays(days)` → `calendarToTradingDays(state.baseDate, state.simulatedDate)`.

### 10.2 P1: Zero-Delta Bypass Centralized into `bsm.js`
**Problem:** The Zero-Delta bypass logic (Section 9) only existed inside `app.js` `updateDerivedValues()`. The P&L chart (`chart.js`) and probability analysis (`prob_charts.js → _computePortfolioPnLAtPrice()`) evaluated the same Trial-mode / $T=Now$ scenario through raw `computeLegPrice()`, causing micro-deviations between the table's displayed P&L and the chart's plotted curve at the current underlying price.
**Fix:** Introduced `computeSimulatedPrice()` in `bsm.js` — a wrapper around `computeLegPrice()` that applies the Zero-Delta bypass when conditions are met. All three consumers (`app.js`, `chart.js`, `prob_charts.js`) now call this single function. The fragile DOM-text price comparison (`parseFloat(document.getElementById(...).textContent.replace(...))`) was eliminated entirely.

### 10.3 P1: Global Portfolio Chart viewMode Loss
**Problem:** `drawGlobalChart()` flattened all groups' legs via `state.groups.flatMap(g => g.legs)` into a single virtual group object that had no `viewMode` property. `chart.js` defaulted to `group.viewMode || 'active'`, meaning the Global chart always rendered in Active mode regardless of each group's actual Trial/Active toggle.
**Fix:** The flatMap now injects `_viewMode` per-leg: `g.legs.map(leg => ({ ...leg, _viewMode: g.viewMode || 'active' }))`. `chart.js` reads `leg._viewMode` when processing each leg, falling back to the group-level mode.

### 10.4 P2: IV Calculation Duplication
**Problem:** `computePortfolioMeanSimIV()` manually computed `Math.max(0.001, leg.iv + state.ivOffset)` — duplicating the identical logic inside `processLegData()` at `bsm.js:L126`. If IV computation rules (e.g., per-leg IV overrides, smile models) were ever modified in `processLegData`, this function would silently desynchronize.
**Fix:** Refactored to call `processLegData()` for each leg and read `.simIV` from the returned object.

### 10.5 Minor: Utility Extraction
- Duplicated DOM flash animation code (green highlight on live data updates) extracted into reusable `flashElement(el)` in `app.js`.

***
*End of Protocol. The project is presently completely mathematically synchronized and highly legible for continued expansion.*
