# Option Combo Simulator

## Overview

Option Combo Simulator is a local browser app for building, analyzing, and recording multi-leg option combinations.

It is designed for direct use from `index.html` and supports:

- option and stock legs inside combo groups
- live idea evaluation and entered-cost tracking
- amortized-basis analysis before final settlement
- settlement-style scenario evaluation
- global portfolio P&L and global amortized aggregation
- optional IBKR live quotes and IV
- JSON import, export, and direct save-back when supported by the browser

## Runtime Model

The frontend is plain HTML/CSS/JavaScript with ordered global scripts:

1. `t_params_db.js`
2. `market_holidays.js`
3. `bsm.js`
4. `chart.js`
5. `prob_charts.js`
6. `chart_controls.js`
7. `app.js`
8. `ws_client.js`

There is no build step or module system.

## Core Files

| File | Responsibility |
| --- | --- |
| `index.html` | App shell, templates, global cards, canvases, controls |
| `style.css` | Layout and styling |
| `bsm.js` | Pricing helpers, date helpers, leg normalization, simulated pricing |
| `chart.js` | P&L chart and amortized-basis chart rendering |
| `chart_controls.js` | Group chart controls, global chart controls, global amortized chart controls |
| `app.js` | State, rendering, valuation loop, import/export, amortized calculations |
| `prob_charts.js` | Probability analysis worker and charts |
| `ws_client.js` | Browser WebSocket client for IBKR live data |
| `ib_server.py` | Python WebSocket bridge to IBKR |
| `config.ini` | TWS and WebSocket server configuration |

## Pricing Rules

`bsm.js` is the pricing single source of truth.

Important helpers:

- `processLegData(...)`
- `computeLegPrice(...)`
- `computeSimulatedPrice(...)`

Current time convention:

- option pricing uses `calendar days / 365`
- trading days are display-only context

## The Four Group Modes

Each combo group now supports four modes.

### `trial`

Use this for live idea evaluation.

- can use current live price as the effective starting cost
- can fall back to a theoretical base-date price when live data is absent

### `active`

Use this for positions with a known deterministic entry cost.

- stored `cost` remains the reference basis
- focuses on expected P&L from the current cost structure

### `amortized`

Use this before final settlement when you want an equivalent buy or sell basis.

- requires deterministic costs
- uses `Scenario Underlying Price` when provided
- owns the yellow amortized banner
- owns the group-level amortized chart

### `settlement`

Use this for a clean settlement-style scenario.

- shares the same `Scenario Underlying Price` input concept
- shows settlement-oriented valuation and expiry state
- does not show the amortized banner or amortized chart

## Amortized Calculations

### Group-level amortized result

`app.js` uses:

- `calculateAmortizedCost(group, evalUnderlyingPrice, globalState)`

This powers:

- the yellow amortized banner inside each amortized group
- the group-level amortized chart

The calculation accounts for:

- initial option and stock cash outflow
- closed option cash flows
- residual value of unexpired options
- assignment or delivery cash flows
- resulting net shares and effective basis

### Global amortized result

The app also provides a global amortized section below the global portfolio P&L card.

It has two outputs with different semantics:

#### Global amortized banner

The banner combines all groups currently in `amortized` mode.

It uses:

- `calculateCombinedAmortizedCost(groups, globalState)`
- each amortized group's own `Scenario Underlying Price` override when set

This is the best summary for the combined effective assigned or delivered basis across multiple amortized groups.

#### Global amortized chart

The global amortized card also includes a reference chart.

It:

- combines all groups currently in `amortized` mode into one virtual portfolio
- reuses the same `AmortizationChart` class as the group-level amortized chart
- uses a shared global scenario-price x-axis for comparison and reference

So the global banner and global chart are intentionally related but not identical:

- banner: aggregate effective basis using each group's override
- chart: combined portfolio behavior across one shared scenario-price axis

## Charts

The current chart set includes:

- per-group P&L chart
- global portfolio P&L chart
- per-group amortized-basis chart
- global amortized-basis chart
- probability analysis charts

## Probability Analysis

`prob_charts.js` provides:

- price probability density
- expected P&L density

Current behavior:

- Student-t parameters come from `t_params_db.js`
- volatility is scaled from portfolio mean IV using `IV / sqrt(365)`
- the horizon uses calendar days from `baseDate` to `simulatedDate`
- simulation runs in a Web Worker

## Live Market Data

Live data is optional and intended for local use.

### Browser side

`ws_client.js`:

- connects to `ws://localhost:<port>`
- supports a hidden local WebSocket port override in the sidebar
- stores the chosen port in browser local storage
- reconnects with exponential backoff
- resends subscriptions after reconnect

### Python side

`ib_server.py`:

- reads TWS and WebSocket settings from `config.ini`
- connects to IBKR using `ib_async`
- streams option marks, stock prices, and IV

## JSON Persistence

The app supports:

- JSON import
- JSON export
- direct save-back to the imported file when browser file handles are available

Imported groups are appended into the current in-memory session.

## Running the Project

### Frontend only

Open `index.html` in a modern browser.

### Refresh probability parameters

```bash
pip install yfinance scipy numpy pandas
python scripts/fit_underlying.py SPY QQQ AAPL
```

This updates:

- `t_params_db.json`
- `t_params_db.js`

### Live IBKR bridge

1. Start TWS or Gateway with API access enabled.
2. Install Python dependencies:

```bash
pip install ib_async websockets
```

3. Start the bridge:

```bash
python ib_server.py
```

4. If needed, match the frontend's local WS port override to the port in `config.ini`.

## Current Notes

- `amortized` is now a first-class mode, separate from `settlement`
- only groups in `amortized` mode contribute to the global amortized result
- group-level and global amortized charts share the same chart implementation for consistency
