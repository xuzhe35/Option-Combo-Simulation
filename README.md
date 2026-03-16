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

The frontend is plain HTML/CSS/JavaScript with ordered global scripts under `js/`:

1. `js/t_params_db.js`
2. `js/market_holidays.js`
3. `js/date_utils.js`
4. `js/pricing_core.js`
5. `js/bsm.js`
6. `js/chart.js`
7. `js/prob_charts.js`
8. `js/chart_controls.js`
9. `js/amortized.js`
10. `js/valuation.js`
11. `js/session_logic.js`
12. `js/session_ui.js`
13. `js/control_panel_ui.js`
14. `js/hedge_editor_ui.js`
15. `js/group_editor_ui.js`
16. `js/hedge_ui.js`
17. `js/group_ui.js`
18. `js/global_ui.js`
19. `js/app.js`
20. `js/ws_client.js`

There is no build step or module system.

## Core Files

| File | Responsibility |
| --- | --- |
| `index.html` | App shell, templates, global cards, canvases, controls |
| `style.css` | Layout and styling |
| `js/date_utils.js` | Pure date and trading-day helpers |
| `js/pricing_core.js` | Pure pricing helpers, leg normalization, simulated pricing |
| `js/bsm.js` | Backward-compatible browser bridge for pricing globals |
| `js/chart.js` | P&L chart and amortized-basis chart rendering |
| `js/chart_controls.js` | Group chart controls, global chart controls, global amortized chart controls |
| `js/amortized.js` | Pure amortized-cost calculations |
| `js/valuation.js` | Pure portfolio state-derivation and aggregation helpers |
| `js/session_logic.js` | Pure import/export and mode-selection helpers |
| `js/session_ui.js` | Control-panel DOM sync after session-level state changes |
| `js/control_panel_ui.js` | Control-panel event binding and sidebar interactions |
| `js/hedge_editor_ui.js` | Hedge editor rendering and event binding |
| `js/group_editor_ui.js` | Group and leg editor rendering and event binding |
| `js/hedge_ui.js` | Hedge DOM write layer |
| `js/group_ui.js` | Group DOM write layer |
| `js/global_ui.js` | Global summary DOM write layer |
| `js/app.js` | State container and top-level orchestration bridge |
| `js/prob_charts.js` | Probability analysis worker and charts |
| `js/ws_client.js` | Browser WebSocket client for IBKR live data |
| `ib_server.py` | Python WebSocket bridge to IBKR |
| `config.ini` | TWS and WebSocket server configuration |

## Pricing Rules

`pricing_core.js` is the pure pricing single source of truth, with `bsm.js` retained as a compatibility bridge.

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

- Student-t parameters come from `js/t_params_db.js`
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

### Recommended local startup

Using a local HTTP server is recommended over opening `index.html` via `file://`, because browsers apply stricter security rules to local file origins.

#### Frontend only

Start a static server from the project root:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/index.html
```

On macOS, `python3 -m http.server 8000` may be required instead.

#### Frontend + IBKR live bridge

1. Start TWS or Gateway with API access enabled.
2. Install Python dependencies:

```bash
pip install ib_async websockets
```

3. In one terminal, start the static frontend server:

```bash
python -m http.server 8000
```

4. In a second terminal, start the IB bridge:

```bash
python ib_server.py
```

5. Open:

```text
http://localhost:8000/index.html
```

6. If needed, match the frontend's local WS port override to the port in `config.ini`.

#### One-click startup scripts

The project root includes convenience launchers:

- Windows: `start_option_combo.bat`
- macOS: `start_option_combo_mac.command`

They start both:

- the static frontend server on `http://localhost:8000/index.html`
- the IB WebSocket bridge on `ws://localhost:8765`

### Refresh probability parameters

```bash
pip install yfinance scipy numpy pandas
python scripts/fit_underlying.py SPY QQQ AAPL
```

This updates:

- `t_params_db.json`
- `js/t_params_db.js`

## Current Notes

- `amortized` is now a first-class mode, separate from `settlement`
- only groups in `amortized` mode contribute to the global amortized result
- group-level and global amortized charts share the same chart implementation for consistency
