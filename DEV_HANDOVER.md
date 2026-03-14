# Option Combo Simulator - Developer Handover

**Audience:** future maintainers and coding agents  
**Updated:** 2026-03-14

## 1. What This App Actually Is

This is a local, browser-run analysis tool for multi-leg option portfolios with optional IBKR live data.

The current product surface is broader than a simple option payoff graph:

- combo groups can contain options and stock legs
- each group supports `trial`, `active`, and `settlement` modes
- the app tracks both simulated P&L and live market P&L
- the probability module estimates price distribution and expected P&L using a Student-t return model
- separate hedge rows track stock or ETF live P&L outside the simulated option engine

## 2. Frontend Architecture

The frontend is intentionally framework-free.

Everything is loaded through global script tags in `index.html` in this order:

1. `t_params_db.js`
2. `market_holidays.js`
3. `bsm.js`
4. `chart.js`
5. `prob_charts.js`
6. `chart_controls.js`
7. `app.js`
8. `ws_client.js`

That order matters. There is no module loader protecting against missing globals.

## 3. Single Source of Truth for Pricing

`bsm.js` is the math authority.

Important functions:

- `processLegData(...)`
- `computeLegPrice(...)`
- `computeSimulatedPrice(...)`

The rest of the app should not re-implement cost-basis or valuation math.

Current rules implemented there:

- option pricing uses calendar-day time to expiry: `T = calDTE / 365`
- trading-day counts are display-only
- `stock` legs bypass BSM and price directly from the underlying
- `closePrice` overrides simulated valuation when present
- trial mode can use live current price as the effective "entered" price when evaluating the current date with zero IV offset

## 4. State Model

`app.js` owns global state.

High-level structure:

- global scenario inputs: symbol, underlying price, base date, simulated date, interest rate, IV offset
- `groups[]`: combo groups
- `hedges[]`: standalone stock or ETF live-P&L rows

Group shape:

- `id`
- `name`
- `viewMode`
- `liveData`
- `settleUnderlyingPrice`
- `legs[]`

Leg shape:

- `id`
- `type`
- `pos`
- `strike`
- `expDate`
- `iv`
- `currentPrice`
- `cost`
- `closePrice`

## 5. Rendering Flow

`renderGroups()` and `renderHedges()` build the DOM from state.

`updateDerivedValues()` is the main recalculation loop. It:

- normalizes every leg through `processLegData(...)`
- computes simulated value and simulated P&L
- computes live P&L where live prices exist
- updates summary cards
- redraws any visible charts

When debugging valuation bugs, this function is usually the fastest place to trace the end-to-end effect.

## 6. View Modes

Each group has three modes:

### `trial`

Use this for idea evaluation or currently open trades tracked off live quotes.

Behavior:

- if `currentPrice` exists, it can become the effective base-date cost
- if `currentPrice` does not exist, the app falls back to a base-date theoretical price
- at "right now" with zero IV offset, simulated pricing may bypass BSM and use `currentPrice` directly

### `active`

Use this for entered positions with fixed historical cost.

Behavior:

- `cost` remains the reference basis
- simulated value changes, but the stored entry basis does not

### `settlement`

Use this to evaluate closed or expired outcomes.

Behavior:

- a group-level settlement underlying price can override the global underlying
- expired ITM options can translate into assigned or delivered stock
- the UI shows an amortized effective basis banner and a settlement simulation chart when applicable

## 7. Chart System

### Standard P&L

`chart.js` contains:

- `PnLChart`
- `AmortizationChart`

The standard chart:

- samples across a configurable price range
- injects exact strike prices and tiny strike offsets into the evaluation grid to catch sharp 0DTE structures
- annotates break-even points
- supports tooltip hover without re-running the full chart draw

### Global Chart

The global chart is not a separate data model.

`chart_controls.js` flattens all group legs into one virtual group and preserves per-group `viewMode` by injecting `_viewMode` onto each copied leg before drawing.

### Probability Charts

`prob_charts.js` contains:

- an inline Monte Carlo worker blob
- `ProbabilityChart`
- `ExpectedPnLDensityChart`

Current probability engine behavior:

- looks up parameters in `t_params_db.js`
- uses calendar days from `baseDate` to `simulatedDate`
- rescales volatility so daily std matches `portfolio mean IV / sqrt(365)`
- simulates 1,000,000 paths
- computes exact expected P&L from path-level pricing in the worker
- only reruns when the user clicks `Recalculate` or toggles the probability panel and explicitly triggers it

## 8. Live Data Path

### Browser

`ws_client.js`:

- opens `ws://localhost:8765`
- sends one subscription payload containing the current underlying, option legs, and hedge stocks
- resends subscriptions on reconnect
- writes mark and IV updates back into state and visible inputs

### Backend

`ib_server.py`:

- uses `ib_async`
- keeps exactly one IB connection for the server process
- retries with a random client id if it hits IB error 326
- maintains per-websocket subscription ownership
- cancels IB market data only when no remaining browser client needs a contract

Important implementation details:

- option mark prefers bid/ask midpoint
- deep OTM fallback prefers `modelGreeks.optPrice` before `marketPrice()`
- manual underlying sync is exposed as `sync_underlying`

## 9. File Roles

| File | Purpose |
| --- | --- |
| `index.html` | Shell, controls, templates, canvases |
| `style.css` | Layout and visual design |
| `bsm.js` | Pricing SSOT and date helpers |
| `app.js` | App state, DOM events, rendering, import/export |
| `chart.js` | Canvas renderers |
| `chart_controls.js` | Chart orchestration and range controls |
| `prob_charts.js` | Monte Carlo orchestration and probability charts |
| `ws_client.js` | Browser WebSocket client |
| `ib_server.py` | IBKR bridge server |
| `t_params_db.js` | Fitted Student-t parameters by symbol |
| `market_holidays.js` | Rule-based NYSE holiday logic |
| `scripts/fit_underlying.py` | Current parameter-generation script |

## 10. Import and Persistence Notes

Import is append-based, not replace-based.

That means:

- importing a JSON file adds groups and hedges into the current session
- imported ids are regenerated
- legacy date formats and fields are migrated where possible

This behavior is useful for combining saved structures, but it can surprise someone expecting a full session replacement.

## 11. Current Developer Guidance

If you need to change:

- pricing logic: edit `bsm.js`
- session state or UI behavior: edit `app.js`
- standard or settlement charts: edit `chart.js`
- chart controls or global chart behavior: edit `chart_controls.js`
- probability behavior: edit `prob_charts.js`
- live data behavior: edit `ws_client.js` and `ib_server.py`

If a document conflicts with the code, trust the code.
