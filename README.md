# Option Combo Simulator

## Overview

Option Combo Simulator is a browser-first options strategy workstation for building and analyzing multi-leg positions without a build step.

The app is designed to replace spreadsheet-driven workflows with a single local tool that can:

- model multi-leg option and stock combinations
- compare entry-cost tracking vs current-market tracking
- project P&L across price and date scenarios
- simulate probability-weighted outcomes with a fat-tail return model
- optionally stream live quotes and IV from Interactive Brokers

The frontend runs directly from `index.html`. Python is only needed for optional live market data and for refreshing the probability parameter database.

## Current Architecture

### Frontend

The frontend is a plain HTML/CSS/JavaScript application loaded by ordered `<script>` tags in `index.html`.

Load order:

1. `t_params_db.js`
2. `market_holidays.js`
3. `bsm.js`
4. `chart.js`
5. `prob_charts.js`
6. `chart_controls.js`
7. `app.js`
8. `ws_client.js`

There is no bundler, module system, or framework. Files communicate through the global scope.

### Core Responsibilities

| File | Responsibility |
| --- | --- |
| `index.html` | App shell, templates, panels, canvases, script loading |
| `style.css` | App styling and responsive layout |
| `bsm.js` | Pricing math, date helpers, leg normalization, single-source-of-truth valuation helpers |
| `chart.js` | Canvas-based P&L chart and settlement/amortization chart |
| `chart_controls.js` | Chart visibility, chart range controls, global chart composition, probability helpers |
| `app.js` | Global app state, DOM binding, group/leg rendering, aggregate valuation, import/export |
| `prob_charts.js` | Monte Carlo worker, probability density chart, expected P&L density chart |
| `ws_client.js` | Browser WebSocket client, live data subscription payloads, live quote propagation |
| `ib_server.py` | Python WebSocket bridge between the browser and IBKR TWS/Gateway |
| `t_params_db.js` | Student-t fit parameters by underlying symbol |
| `market_holidays.js` | Rule-based NYSE holiday calculator used for informational trading-day display |

## Pricing Model

### Single Source of Truth

`bsm.js` is the pricing authority for the project.

Key functions:

- `processLegData(...)`: normalizes one leg into pricing-ready data
- `computeLegPrice(...)`: returns intrinsic value or BSM value
- `computeSimulatedPrice(...)`: applies close-price overrides and trial-mode live-price bypass rules

The rest of the app should consume these helpers instead of duplicating pricing logic.

### Time Convention

The current implementation prices options with:

- `T = calendar days to expiry / 365`

Trading days are still computed and displayed to the user as informational context:

- `Sim DTE: X td / Y cd`

Trading days are not the pricing clock in the current codebase.

### Supported Position Types

The app supports:

- option legs: `call`, `put`
- stock legs inside combo groups: `stock`
- separate stock or ETF hedge rows used for live P&L tracking

## View Modes

Each combo group has three operating modes:

- `trial`: treat the position like a live idea; current price or theoretical base-date price is used as the effective cost basis
- `active`: treat the position like an entered trade; stored entry cost is the cost basis
- `settlement`: evaluate expired or closed outcomes and show assigned or delivered stock basis when relevant

Notes:

- if every leg in a group has zero cost, the UI forces the group into `trial`
- closed legs can override simulated pricing with `closePrice`
- settlement mode can use a group-specific underlying settlement price override

## Charts

### Standard P&L Charts

`chart.js` renders:

- per-group P&L curves
- a global portfolio P&L curve that flattens all groups into one virtual portfolio
- break-even annotations
- hover tooltips
- settlement amortization and effective stock basis charts

### Probability Analysis

`prob_charts.js` provides two additional charts:

- price probability density at the simulation date
- expected P&L contribution by price

Current behavior:

- uses a Student-t return model with parameters from `t_params_db.js`
- recalibrates daily volatility to the portfolio's mean simulated IV using `IV / sqrt(365)`
- uses calendar-day horizon from `baseDate` to `simulatedDate`
- runs 1,000,000 Monte Carlo paths in an inline Web Worker
- is manually triggered from the UI via `Recalculate`

The probability panel also supports a `Random Walk` toggle that forces drift to zero.

## Live Market Data

Live market data is optional.

### Browser Side

`ws_client.js`:

- connects to `ws://localhost:8765`
- resubscribes on successful reconnect by sending the current active subscription set
- updates option mark, stock mark, and IV in place
- triggers a throttled UI revaluation after live updates

### Python Side

`ib_server.py`:

- connects to Interactive Brokers via `ib_async`
- exposes a WebSocket server for the browser
- qualifies underlying, option, and stock contracts
- keeps subscriptions isolated per browser client
- cancels IB subscriptions when the last interested client goes away

Current option quote preference:

1. bid/ask midpoint
2. `modelGreeks.optPrice`
3. `marketPrice()`

Current IV preference:

1. `modelGreeks.impliedVol`
2. `ticker.impliedVolatility`

## JSON Persistence

The app can import and export state as JSON.

Current import behavior:

- imported groups and hedges are appended to the existing session
- legacy `daysPassed` and `dte` fields are migrated when possible
- new ids are generated during import to avoid collisions

Sample saved portfolios live in `Portfolio/`.

## How To Run

### Offline Frontend

Open `index.html` in a modern browser.

No local server is required.

### Probability Parameter Refresh

Refresh or add fitted return parameters for one or more underlyings:

```bash
pip install yfinance scipy numpy pandas
python scripts/fit_underlying.py SPY QQQ AAPL
```

This updates:

- `t_params_db.json`
- `t_params_db.js`

Reload the page after regenerating the parameter database.

### Live IBKR Integration

1. Start IB TWS or Gateway with API access enabled.
2. Install Python dependencies:

```bash
pip install ib_async websockets
```

3. Start the bridge:

```bash
python ib_server.py
```

4. Open or reload `index.html`.
5. Enable `Live Market Data` on any combo group or hedge row.

`config.ini` controls the TWS host, TWS port, client id, and WebSocket bind address.

## Repository Notes

### Sample Data

`Portfolio/` contains saved SPY, AAPL, and TLT examples that show the expected JSON shape and common workflows.

## Recommended Developer Entry Points

If you are changing:

- pricing or cost basis behavior: start in `bsm.js`
- state flow or UI rendering: start in `app.js`
- chart rendering: start in `chart.js` and `chart_controls.js`
- probability analysis: start in `prob_charts.js`
- live data flow: start in `ws_client.js` and `ib_server.py`
