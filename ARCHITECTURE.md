# Option Combo Simulator Architecture

## 1. System Shape

This repo now contains three related surfaces:

1. `index.html`
   - the main portfolio workspace
   - supports live mode and historical replay mode

2. `chart_lab.html`
   - an experimental projection surface
   - overlays payoff shapes onto a daily candle chart

3. Python backends
   - `ib_server.py` for live IBKR market data and execution
   - `historical_server.py` for SQLite-based historical replay

The frontend is still a plain ordered-global-script app. There is no bundler and no module loader.

## 2. Frontend Entry Surfaces

### `index.html`

The main app shell owns:

- control panel
- combo-group editor
- hedge editor
- global cards
- group/global P&L charts
- global amortized chart
- probability analysis
- Trial Trigger and live execution controls

### `chart_lab.html`

The projection lab is intentionally separate from the main shell.

It currently:

- reuses the same frontend state bridge as `index.html`
- opens its own WebSocket connection for bars and live underlying price
- draws a custom daily candle canvas
- projects either a single group or the included global portfolio

The chart-lab overlay is currently a visualization layer, not a mathematically complete time-path model.

## 3. Ordered Script Runtime

Current `index.html` load order:

1. `js/t_params_db.js`
2. `js/market_holidays.js`
3. `js/date_utils.js`
4. `js/product_registry.js`
5. `js/index_forward_rate.js`
6. `js/pricing_context.js`
7. `js/group_order_builder.js`
8. `js/trade_trigger_logic.js`
9. `js/distribution_proxy_config.js`
10. `js/pricing_core.js`
11. `js/bsm.js`
12. `js/chart.js`
13. `js/prob_charts.js`
14. `js/chart_controls.js`
15. `js/amortized.js`
16. `js/valuation.js`
17. `js/session_logic.js`
18. `js/session_ui.js`
19. `js/control_panel_ui.js`
20. `js/hedge_editor_ui.js`
21. `js/group_editor_ui.js`
22. `js/hedge_ui.js`
23. `js/group_ui.js`
24. `js/global_ui.js`
25. `js/app.js`
26. `js/ws_client.js`

If browser runtime behavior suddenly becomes `undefined`, load order is still the first thing to check.

## 4. Layer Breakdown

### 4.1 Static shell and styles

- `index.html`
- `chart_lab.html`
- `style.css`
- `chart_lab.css`

Responsibilities:

- page layout
- templates
- containers for charts and summaries
- workspace-specific copy and affordances

### 4.2 Product and pricing metadata

- `js/product_registry.js`
- `js/index_forward_rate.js`
- `js/distribution_proxy_config.js`

Responsibilities:

- product-family metadata
- option and underlying security types
- multipliers
- trading classes
- default underlying futures month logic
- forward-rate usage rules
- probability-distribution proxy selection

This layer is the runtime source of truth for supported families today.

### 4.3 Pricing and scenario context

- `js/pricing_context.js`
- `js/pricing_core.js`
- `js/bsm.js`
- `js/amortized.js`

Responsibilities:

- anchor underlying interpretation
- futures-pool / forward-rate mapping
- BSM and Black-76 pricing
- underlying-leg handling
- amortized-cost math

Notes:

- `pricing_core.js` is the real pricing SSOT.
- `bsm.js` remains as a compatibility bridge for older global call sites.

### 4.4 Derived portfolio state

- `js/valuation.js`
- `js/session_logic.js`
- `js/trade_trigger_logic.js`
- `js/group_order_builder.js`

Responsibilities:

- group and portfolio derived values
- global aggregation
- session import/export normalization
- Trigger configuration and state rules
- combo order payload assembly
- close-group payload assembly

### 4.5 UI binding and DOM writes

- `js/session_ui.js`
- `js/control_panel_ui.js`
- `js/group_editor_ui.js`
- `js/hedge_editor_ui.js`
- `js/group_ui.js`
- `js/hedge_ui.js`
- `js/global_ui.js`

Responsibilities:

- control binding
- group and hedge editor rendering
- mode toggles
- live status rendering
- derived-value writes back into the DOM

### 4.6 Charts and analysis

- `js/chart.js`
- `js/chart_controls.js`
- `js/prob_charts.js`
- `js/chart_lab.js`

Responsibilities:

- per-group P&L charts
- global P&L chart
- per-group and global amortized charts
- probability charts
- daily K projection lab

Important distinction:

- `chart.js` / `chart_controls.js` own the core payoff charting already used by the main app
- `chart_lab.js` is an experimental consumer of the same underlying pricing pipeline, but renders onto a price chart instead of the standard P&L axes

### 4.7 State container and orchestration

- `js/app.js`

Responsibilities:

- owns the in-memory `state`
- initializes UI
- coordinates render passes
- exposes `window.__optionComboApp`

This file is now an orchestration bridge, not the main place for every piece of business logic.

### 4.8 Live backend stack

- `ib_server.py`
- `trade_execution/engine.py`
- `trade_execution/models.py`
- `trade_execution/adapters/base.py`
- `trade_execution/adapters/ibkr.py`

Responsibilities:

- live market data subscriptions
- product-aware IBKR contract qualification
- historical daily bars for Chart Lab
- combo preview / test submit / live submit
- managed repricing and order supervision
- close-group execution through the same managed order path
- managed concession pricing from middle toward worst quoted price
- soft-terminal broker-state confirmation for modify/replace flows
- execution-report attribution back into group legs

### 4.9 Historical replay stack

- `historical_server.py`
- `historical_data.py`
- `historical_replay_service.py`

Responsibilities:

- SQLite historical quote reads
- replay-day underlying snapshot and option snapshot payloads
- replay-date normalization
- historical mode WebSocket responses

## 5. Shared State Model

`js/app.js` owns a single in-memory state object. Important top-level fields include:

- `underlyingSymbol`
- `underlyingContractMonth`
- `underlyingPrice`
- `baseDate`
- `simulatedDate`
- `marketDataMode`
- `interestRate`
- `ivOffset`
- `forwardRateSamples`
- `futuresPool`
- `groups`
- `hedges`

### Group shape

Important group fields include:

- `id`
- `name`
- `viewMode`
- `includedInGlobal`
- `isCollapsed`
- `tradeTrigger`
- `closeExecution`
- `settleUnderlyingPrice`
- `syncAvgCostFromPortfolio`
- `legs`

### Leg shape

Important leg fields include:

- `id`
- `type`
- `pos`
- `strike`
- `expDate`
- `iv`
- `currentPrice`
- `cost`
- `closePrice`
- `ivSource`
- `ivManualOverride`
- `closePriceSource`

Runtime-only fields may also be attached during broker sync and historical replay.

## 6. Product Support Model

### Equity / ETF flow

- default profile
- equity-style underlying legs
- amortized mode supported

### Cash-settled index options

- `SPX`
- `NDX`

### Futures options

- `ES`
- `NQ`
- `CL`
- `GC`
- `SI`
- `HG`

Current architecture already includes:

- family-aware secType and exchange resolution
- Black-76 pricing support
- product-aware multipliers
- futures underlying-leg support
- IBKR live-data contract building for non-stock families

## 7. Historical Replay Architecture

Historical replay is implemented as a first-class runtime mode.

### Main flow

1. frontend sets `marketDataMode = historical`
2. `ws_client.js` requests historical snapshots
3. `historical_server.py` routes to `HistoricalReplayService`
4. `historical_replay_service.py` pulls data through `historical_data.py`
5. frontend writes replayed quotes into the same state fields used by live mode
6. existing valuation and charts update through the same render pipeline

### Historical execution behavior

Historical replay also supports:

- trigger preview
- simulated submit
- deterministic replay fills
- replay-day entry locking
- close simulation
- expiry auto-settlement

## 8. Chart Lab Architecture

`chart_lab.html` is intentionally isolated from `index.html`.

### Current data flow

1. read current frontend state through `window.__optionComboApp.getState()`
2. request daily bars from `ib_server.py`
3. fall back to SQLite daily bars when IB bars are unavailable
4. read selected projection source:
   - one group
   - included global portfolio
5. compute a `price -> pnl` curve through the same pricing helpers used by the main charting pipeline
6. project that curve onto a daily candle canvas

### Current boundaries

- price-axis alignment is real
- horizontal projection width is normalized P&L magnitude
- the overlay is a visual aid, not a full time-path model
- mixed-expiry projections still need more explicit later-date semantics if strict financial correctness is required

## 9. Startup and Process Model

### Live workspace

- frontend served by `python -m http.server 8000`
- backend served by `ib_server.py`
- locked route:
  - `index.html?entry=live&marketDataMode=live&lockMarketDataMode=1`
- for remote/server deployments, prefer a single observable backend instance using:
  - `powershell_scripts/start_ib_server_server_template.ps1`
  - dedicated PID file
  - dedicated stdout/stderr logs

### Historical replay workspace

- frontend served by `python -m http.server 8000`
- backend served by `historical_server.py`
- locked route:
  - `index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1`

### Experimental projection lab

- served by the same frontend HTTP server
- route:
  - `chart_lab.html`

## 10. Current Known Boundaries

- `contract_specs/*.xml` are still reference assets rather than runtime truth.
- Page reload does not reconstruct a previous managed execution session.
- Chart Lab is still experimental.
- The projection lab currently uses daily bars only.
- The projection lab aligns price, but not true future time.
- If multiple unmanaged `ib_server.py` processes are left running, broker-status debugging becomes unreliable because the browser may connect to a different backend than the logs you are reading.

## 11. If Notes and Code Drift

Trust in this order:

1. `js/product_registry.js`
2. `js/pricing_context.js`
3. `js/pricing_core.js`
4. `js/valuation.js`
5. `js/session_logic.js`
6. `js/ws_client.js`
7. `ib_server.py`
8. `historical_replay_service.py`
9. `trade_execution/adapters/ibkr.py`
