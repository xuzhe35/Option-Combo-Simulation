# Option Combo Simulator (with IBKR Live Integration)

## 📌 Project Overview
The Option Combo Simulator is a web-based, entirely client-side (HTML/JS/CSS) tool designed to construct, visualize, and analyze complex options trading strategies (like Iron Condors, Straddles, Vertical Spreads) before executing them.

It replicates and enhances the experience of using an Excel spreadsheet to track costs, calculate breakevens, and visualize the theoretical P&L curves across different underlying prices and simulated dates.

The project has two optional Python components:
- **`ib_server.py`** — a WebSocket bridge to Interactive Brokers (TWS/Gateway) for live market data.
- **`spx_fit.py`** — a one-time statistical fitting script that calibrates the Monte Carlo simulator to real SPX tail behaviour.

---

## 🏗️ Technical Architecture

### 1. Frontend: Visualization & Pricing Engine
Files: `index.html`, `app.js`, `chart.js`, `bsm.js`, `style.css`, `prob_charts.js`, `t_params.js`

- **No Build Step Required**: Runs directly in any modern browser without Webpack, React, or Node.js. Open `index.html` directly.
- **State Management (`app.js`)**: Holds global simulation variables — Underlying Symbol/Price, Simulated Date, IV Offset, Interest Rate — and an array of `groups` (Option Combos), each with multiple `legs` (Calls/Puts, Long/Short, Strike, Expiry, IV, Cost).
- **Pricing Model (`bsm.js`)**: Black-Scholes-Merton (BSM) formula for European-style option pricing. Inputs: S, K, T (years), r, σ.
- **Time Convention**: All DTE calculations use **trading days / 252** (not calendar days / 365). `calendarToTradingDays(n)` in `app.js` converts using `round(n × 252/365)`. All DTE displays show both units, e.g. `Sim DTE: 8 td / 12 cd`.
- **P&L Chart Engine (`chart.js`)**: Custom HTML5 `<canvas>` renderer. Draws the aggregated portfolio P&L curve, zero-axis, break-even annotations, hover tooltips at 60 fps. The global chart combines all groups via a virtual group.
- **Probability Analysis (`prob_charts.js` + `t_params.js`)**: Monte Carlo simulation and two additional charts — see Section 3 below.
- **Data Persistence**: JSON export/import for saving and loading portfolios locally. Sample files in `Portfolio/`.

### 2. Backend: Live Data Gateway
Files: `ib_server.py`, `config.ini`

- **Python Asyncio Daemon**: `asyncio` + `websockets` WebSocket server (default port `8765`).
- **TWS Integration (`ib_insync`)**: Connects to IB TWS or Gateway (default port `7496`).
- **Smart Subscription Management**: Frontend subscribes only to legs with "Live Market Data" toggled on. Server dynamically manages `reqMktData` / cancels stale subscriptions to respect IB API rate limits.
- **Ambiguity Resolution**: Strict `Option(exchange='SMART', multiplier='100', currency='USD')` definitions prevent Error 321 on liquid assets like SPY.

### 3. Probability Analysis Module
Files: `spx_fit.py` → writes `t_params.js`, then `prob_charts.js` uses it.

#### Statistical Model
SPX daily log-returns follow a **Student-t distribution** with degrees of freedom df ≈ 2.53 (as of the last fit), which captures the fat tails that the normal distribution (BSM baseline) misses. The fitted parameters are stored in `t_params.js`.

**Scale calibration**: The historical df (tail shape) and loc (drift) are preserved, but the scale is recalibrated at runtime so that the distribution's daily standard deviation equals `portfolio_mean_IV / sqrt(252)`. This means the simulation assumes the options market's implied volatility is the correct predictor of future realised volatility.

#### Monte Carlo Process
1. **Trading days to simulation date** = `calendarToTradingDays(diffDays(baseDate, simulatedDate))`.
2. For each of **1,000,000 paths**: draw `n_trading_days` independent t-distributed daily log-returns, sum them, compute `S_T = S_current × exp(sum)`.
3. Bin the 1M terminal prices into a 500-bin histogram over `[minS, maxS]` (the global chart's price range) → **probability density**.
4. The computation runs in a **Web Worker** (inline blob, works under `file://` protocol) so the UI never freezes. A 400 ms debounce prevents re-simulation on every slider tick.

#### Charts Produced
| Chart | Description |
|---|---|
| **Chart 2 — Price Density** | Indigo filled curve = t-distribution (fat-tail, IV-scaled). Orange dashed line = lognormal/normal baseline (BSM assumption). Difference = tail risk invisible to BSM. |
| **Chart 3 — Expected P&L Density** | `P&L(s) × f_t(s)` for each price s. Green fill = profit contribution, red fill = loss contribution. |
| **Expected P&L badge** | `∫ P&L(s) × f_t(s) ds` (trapezoidal integration over the chart range) = single-number risk-adjusted expected outcome. |

All three charts share the same x-axis price range as the Global Portfolio P&L chart and update automatically whenever any slider or input changes.

---

## 🚀 How to Run

### Frontend Only (Offline Simulation)
```
Open index.html in your browser.
```
No server needed. The Probability Analysis module works fully offline.

### Refresh the SPX t-Distribution Fit (Recommended on first run)
```bash
pip install yfinance scipy numpy pandas
python spx_fit.py
```
This downloads the last 10 years of SPX (`^GSPC`) daily data, fits a Student-t distribution via MLE, and overwrites `t_params.js` with the updated `df`, `loc`, `scale` parameters. Reload `index.html` afterward.

### Backend (Live IBKR Integration)
1. Ensure IB TWS or Gateway is running. Enable API: *Settings → API → Settings → "Enable ActiveX and Socket Clients"*.
2. Install dependencies: `pip install ib_async websockets`
3. Start: `python ib_server.py`
4. Refresh `index.html`. Toggle **"Live Market Data"** on any Combo Group to stream live quotes into the Cost fields. Use the **Sync** button next to Underlying Price for a snapshot when the market is closed.

---

## 📁 File Reference

| File | Role |
|---|---|
| `index.html` | App shell, HTML structure, `<canvas>` elements, script tags |
| `style.css` | All styling (bright SaaS theme, responsive layout) |
| `bsm.js` | Black-Scholes-Merton pricing: `calculateOptionPrice(type, S, K, T, r, v)` |
| `chart.js` | `PnLChart` class — canvas P&L curve renderer with tooltips |
| `app.js` | State, event binding, BSM orchestration, chart triggers, prob-chart helpers |
| `prob_charts.js` | Web Worker (MC sampler), `ProbabilityChart`, `ExpectedPnLDensityChart`, `updateProbCharts()` |
| `t_params.js` | Student-t fitted params `{ df, loc, scale }` — auto-generated by `spx_fit.py` |
| `spx_fit.py` | One-time fitting script: downloads SPX data, fits t-dist, writes `t_params.js` |
| `ib_server.py` | Python WebSocket server bridging IB TWS → browser |
| `config.ini` | IB TWS connection settings (host, port, clientId) |
| `Portfolio/` | Sample JSON portfolio files (SPY, AAPL combos) |
| `Week1_fitting.ipynb` | Original Colab notebook that informed the t-distribution fitting approach |

---

## 🤖 Development History (For LLM Continuity)

This project was built iteratively through LLM pairing. Key milestones:

### Phase 1: Core Excel Replacement & UI
- Replicate Excel options cost/P&L spreadsheet in browser. Qty × 100 multiplier.
- Bright SaaS-style UI (no dark theme). Responsive layout, collapsible sidebar, scrollable table.

### Phase 2: Date Calculation & Chart Engine
- Refactored `diffDays` / `addDays` to strict UTC to eliminate DST/timezone bugs.
- Moved all expensive Date/BSM pre-computations out of the inner render loop in `chart.js`.
- Added break-even annotations (zero-crossings) with price % labels to the P&L chart.

### Phase 3: Interactive Brokers Integration
- Added global Underlying Symbol field (combos can't share x-axis across different underlyings).
- Python `ib_server.py` using `ib_insync`; WebSocket broadcasts live quotes to Cost cells.
- Fixed asyncio blocking by using `await ib.qualifyContractsAsync`. Fixed Error 321 with SMART exchange.
- Added manual "Sync Latest Price" button for snapshot quotes when market is closed.

### Phase 4: Probability Analysis & Trading-Day DTE
- **DTE convention updated**: all BSM T calculations now use `trading_days / 252` (was `calendar_days / 365`). DTE displays show both, e.g. `8 td / 12 cd`.
- **`spx_fit.py`**: fits Student-t to last 10 years of SPX log-returns. Writes `t_params.js`.
- **`prob_charts.js`**: inline Web Worker Monte Carlo (1M paths, t-dist with IV-scaled volatility). Produces Chart 2 (price density vs lognormal baseline) and Chart 3 (P&L × density), plus the Expected P&L scalar. Range stays in sync with the global P&L chart. Re-runs on any state change (400 ms debounce).

---

## 🔑 Key Design Decisions

- **Separation of concerns**: `bsm.js` (math) → `chart.js` (rendering) → `app.js` (orchestration) → `prob_charts.js` (probability). Each layer has no knowledge of layers above it.
- **No framework dependencies**: Vanilla JS + Canvas API. Works from `file://` with no local server.
- **Trading days / 252**: All time-to-maturity inputs to BSM use trading days, not calendar days. The `calendarToTradingDays()` helper in `app.js` does `round(calDays × 252/365)`.
- **IV as future vol**: The Monte Carlo does not use the historical SPX vol. It recalibrates the t-distribution scale to `portfolio_mean_IV / sqrt(252)`, treating implied vol as the market's forecast.
- **Web Worker for Monte Carlo**: 1M × n_days draws run off the main thread. The Worker is created from an inline blob (avoids CORS issues under `file://`). Terminated and restarted on each new simulation.
- **Extending the model**: To add new greeks or strategy templates, start in `bsm.js` (math), then `app.js` state, then UI bindings in `index.html`. Do not touch `chart.js` unless changing the rendering pipeline.
