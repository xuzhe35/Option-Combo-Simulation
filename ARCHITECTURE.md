# Option Combo Simulator Architecture

## 1. System Shape

This repo is a plain browser application plus optional Python WebSocket backends. There is no frontend build step, bundler, or module loader; each HTML page loads ordered global scripts.

Runtime surfaces:

1. `index.html`
   - main multi-group portfolio workspace
   - supports live IBKR mode and SQLite historical replay mode

2. `chart_lab.html`
   - shared portfolio workspace plus a separate Chart Lab tab
   - overlays portfolio payoff projections onto daily bars

3. `iv_term_structure.html`
   - standalone live ETF IV term-structure monitor
   - syncs ATM option pairs by expiry and appends samples to per-symbol JSON history files

4. Python backends
   - `ib_server.py` for live IBKR market data, live execution, Chart Lab bars, IV term-structure sync, and historical fallback paths
   - `historical_server.py` for SQLite historical replay snapshots only

## 2. Frontend Entry Surfaces

### `index.html`

The main app shell owns:

- workspace chrome and locked live/historical routes
- control panel
- combo-group editor
- hedge editor
- global cards and summaries
- group/global P&L charts
- amortized and probability analysis
- trial trigger controls
- close-group execution controls
- live account selection and WebSocket endpoint controls

Locked routes:

- `index.html?entry=live&marketDataMode=live&lockMarketDataMode=1`
- `index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1`

### `chart_lab.html`

Chart Lab is intentionally separate from the main shell, but it loads the same shared runtime before loading `js/chart_lab.js`.

It currently:

- reads state through `window.__optionComboApp`
- opens its own WebSocket connection
- requests `request_historical_bars` from `ib_server.py`
- falls back to SQLite daily bars through `ib_server.py` when IB bars are unavailable
- projects either one group or the included global portfolio onto a daily candle canvas

The overlay is a visualization aid, not a complete time-path model.

### `iv_term_structure.html`

The IV term-structure page is standalone and does not load the main portfolio runtime.

It currently:

- loads config from `iv_term_structure/iv_term_structure_config.json`, with embedded defaults if fetch fails
- loads bundled history from `iv_term_structure/data/*.json`
- opens one WebSocket per active symbol sync
- uses `subscribe_iv_term_structure` on `ib_server.py`
- uses `request_ib_connection_status` and `connect_ib` to show/connect IB state
- builds bucket rows in `js/iv_term_structure_core.js`
- can append samples to opened/imported per-symbol JSON history documents

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

`chart_lab.html` uses the same order, then adds:

27. `js/chart_lab.js`

`iv_term_structure.html` uses its own small runtime:

1. `js/product_registry.js`
2. `js/iv_term_structure_core.js`
3. `js/iv_term_structure.js`

If browser runtime behavior suddenly becomes `undefined`, load order is still the first thing to check.

## 4. Layer Breakdown

### 4.1 Static shell and styles

- `index.html`
- `chart_lab.html`
- `iv_term_structure.html`
- `style.css`
- `chart_lab.css`
- `iv_term_structure.css`

Responsibilities:

- page layout
- templates
- containers for charts and summaries
- workspace-specific copy and controls

### 4.2 Product and pricing metadata

- `js/product_registry.js`
- `js/index_forward_rate.js`
- `js/distribution_proxy_config.js`

Responsibilities:

- product-family metadata
- option and underlying security types
- multipliers
- trading classes
- default futures-month logic
- forward-rate usage rules
- probability-distribution proxy selection

`js/product_registry.js` is the browser-side source of truth for supported families.

### 4.3 Pricing and scenario context

- `js/pricing_context.js`
- `js/pricing_core.js`
- `js/bsm.js`
- `js/amortized.js`

Responsibilities:

- anchor underlying interpretation
- quote-date and simulation-date semantics
- futures-pool and forward-rate mapping
- BSM and Black-76 pricing
- underlying-leg handling
- amortized-cost math

Notes:

- `pricing_core.js` is the primary pricing implementation.
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
- trigger configuration and runtime state rules
- open-combo and close-combo payload assembly

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
- execution status rendering
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

- `chart.js` / `chart_controls.js` own the core payoff charting used by the main app.
- `chart_lab.js` consumes the same state and pricing helpers but renders onto a price chart instead of the standard P&L axes.

### 4.7 IV term-structure monitor

- `iv_term_structure.html`
- `iv_term_structure.css`
- `js/iv_term_structure.js`
- `js/iv_term_structure_core.js`
- `iv_term_structure_service.py`
- `iv_term_structure/iv_term_structure_config.json`
- `iv_term_structure/data/*.json`

Responsibilities:

- standalone per-symbol IV monitor UI
- bucket definitions and DTE matching
- ATM strike window selection
- live call/put IV aggregation
- per-symbol historical sample documents
- testable DOM-free JS and Python selection helpers

### 4.8 State container and orchestration

- `js/app.js`

Responsibilities:

- owns the in-memory `state`
- initializes UI
- coordinates render passes
- imports and exports JSON sessions
- exposes `window.__optionComboApp`

This file is an orchestration bridge, not the main place for business logic.

### 4.9 Live / shared backend stack

- `ib_server.py`
- `trade_execution/engine.py`
- `trade_execution/models.py`
- `trade_execution/adapters/base.py`
- `trade_execution/adapters/ibkr.py`
- `iv_term_structure_service.py`

Responsibilities:

- background IB connection lifecycle
- live underlying, option, futures, and stock-hedge subscriptions
- product-aware IBKR contract qualification
- portfolio average-cost snapshots
- managed account snapshots
- historical daily bars for Chart Lab
- SQLite daily-bar fallback for Chart Lab
- historical replay snapshots through `HistoricalReplayService`
- IV term-structure catalog selection and option subscriptions
- combo validation, preview, test submit, and live submit
- managed repricing and order supervision
- close-group execution through the same managed order path
- execution-report attribution back into group legs

### 4.10 Historical replay stack

- `historical_server.py`
- `historical_data.py`
- `historical_replay_service.py`

Responsibilities:

- SQLite historical quote reads
- replay-day underlying snapshot and option snapshot payloads
- replay-date normalization
- risk-free and yield-curve hydration
- expiry-date underlying snapshots for auto-settlement flows
- lightweight historical-mode WebSocket responses

`historical_server.py` is intentionally narrow: it does not provide live subscriptions, live execution, Chart Lab bars, or IV term-structure sync.

### 4.11 Startup and maintenance scripts

- `start_option_combo.bat`
- `start_historical_replay.bat`
- `install_ib_bridge_deps.bat`
- `cleanup_logs.bat`
- `start_option_combo_mac.command`
- `start_option_combo.sh`
- `install_ib_bridge_deps_mac.command`
- `cleanup_logs_mac.command`
- `scripts/cleanup_runtime_logs.py`
- `powershell_scripts/*.ps1`

Responsibilities:

- Python resolution
- local service launch
- Codex/background service launch and restart
- dependency installation
- local runtime log and stale pid cleanup

## 5. Shared State Model

`js/app.js` owns a single in-memory state object. Important top-level fields include:

- `underlyingSymbol`
- `underlyingContractMonth`
- `underlyingPrice`
- `baseDate`
- `historicalQuoteDate`
- `simulatedDate`
- `marketDataMode`
- `interestRate`
- `ivOffset`
- `forwardRateSamples`
- `futuresPool`
- `selectedLiveComboOrderAccount`
- `groups`
- `hedges`

Important group fields include:

- `id`
- `name`
- `viewMode`
- `includedInGlobal`
- `isCollapsed`
- `tradeTrigger`
- `closeExecution`
- `settleUnderlyingPrice`
- `historicalAutoCloseAtExpiry`
- `syncAvgCostFromPortfolio`
- `livePriceDisplayMode`
- `legs`

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

Browser-side support in `js/product_registry.js`:

- default equity / ETF option flow
- cash-settled index options:
  - `SPX`
  - `NDX`
- futures options:
  - `ES`
  - `NQ`
  - `CL`
  - `GC`
  - `SI`
  - `HG`

Current architecture includes:

- family-aware secType and exchange resolution
- Black-76 pricing support for index/FOP paths
- BSM spot pricing for default equity/ETF paths
- product-aware multipliers
- product-aware display precision and combo increments
- futures underlying-leg support
- cash-settled index option handling

Live backend nuance:

- `ib_server.py` has explicit `SUPPORTED_LIVE_FAMILIES` defaults for `ES`, `NQ`, and `CL`.
- `SPX` and `NDX` use index exchange fallbacks.
- The browser registry knows about `GC`, `SI`, and `HG`; live contract qualification may still require extra verification for those families.

## 7. Backend WebSocket Responsibilities

`ib_server.py` handles these high-level message families:

- `subscribe`
  - live underlying/options/futures/stocks
  - optional option Greeks via generic tick `106`
- `sync_underlying`
  - snapshot-like manual underlying refresh
- `request_historical_snapshot`
  - shared historical replay through SQLite
- `request_historical_bars`
  - Chart Lab bars via IB, with SQLite fallback for daily bars
- `request_portfolio_avg_cost_snapshot`
- `request_managed_accounts_snapshot`
- `request_ib_connection_status`
- `connect_ib`
- `subscribe_iv_term_structure`
- combo actions routed through `ExecutionEngine`
  - validate
  - preview
  - test submit
  - live submit
  - resume / concede / cancel managed orders

`historical_server.py` handles:

- `request_historical_snapshot`
- `request_portfolio_avg_cost_snapshot` with an empty item list

Any other message to `historical_server.py` returns a historical replay error.

## 8. Historical Replay Architecture

Historical replay is implemented as a first-class runtime mode in the main workspace.

Main flow:

1. frontend sets `marketDataMode = historical`
2. `js/ws_client.js` requests historical snapshots
3. `historical_server.py` or `ib_server.py` routes to `HistoricalReplayService`
4. `historical_replay_service.py` pulls data through `historical_data.py`
5. frontend writes replayed quotes into the same state fields used by live mode
6. existing valuation and charts update through the same render pipeline

Historical replay also supports:

- trigger preview
- simulated submit
- deterministic replay fills
- replay-day entry locking
- close simulation
- expiry auto-settlement
- historical risk-free and yield-curve hydration

## 9. Chart Lab Architecture

Current data flow:

1. read current frontend state through `window.__optionComboApp.getState()`
2. request daily bars from `ib_server.py`
3. fall back to SQLite daily bars when IB bars are unavailable
4. read selected projection source:
   - one group
   - included global portfolio
5. compute a `price -> pnl` curve through the same pricing helpers used by the main charting pipeline
6. project that curve onto a daily candle canvas

Current boundaries:

- price-axis alignment is real
- horizontal projection width is normalized P&L magnitude
- daily bars only
- mixed-expiry projections still need more explicit later-date semantics if strict financial correctness is required

## 10. Startup and Process Model

### Live workspace

- frontend served by `python -m http.server 8000`
- backend served by `ib_server.py`
- route: `index.html?entry=live&marketDataMode=live&lockMarketDataMode=1`

### Historical replay workspace

- frontend served by `python -m http.server 8000`
- backend served by `historical_server.py`
- route: `index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1`

### Chart Lab

- served by the same frontend HTTP server
- route: `chart_lab.html`
- use `ib_server.py` for bars

### IV term structure

- served by the same frontend HTTP server
- route: `iv_term_structure.html`
- use `ib_server.py` for IB connection status and live IV sync

### Background / Codex launchers

- `powershell_scripts/start_option_combo_codex.ps1` starts HTTP and IB services with redirected logs and pid files
- `powershell_scripts/launch_ib_server_codex.ps1` starts only `ib_server.py`
- matching restart scripts stop existing pid-tracked processes and relaunch
- generated `*.codex*.log`, `*.log`, and `*.pid` files are ignored by Git

Use `cleanup_logs.bat` or `cleanup_logs_mac.command` for periodic runtime log cleanup.

## 11. Current Known Boundaries

- `contract_specs/*.xml` are reference assets rather than runtime truth.
- Page reload does not reconstruct a previous managed execution session.
- Chart Lab is experimental and uses daily bars only.
- The projection lab aligns price, but not true future time.
- `historical_server.py` cannot serve Chart Lab bars or IV term-structure sync.
- `ib_server.py` supports more runtime paths than the lightweight historical server.
- If multiple unmanaged `ib_server.py` processes are left running, broker-status debugging becomes unreliable because the browser may connect to a different backend than the logs you are reading.

## 12. If Notes and Code Drift

Trust in this order:

1. HTML script order in `index.html`, `chart_lab.html`, and `iv_term_structure.html`
2. `js/product_registry.js`
3. `js/pricing_context.js`
4. `js/pricing_core.js`
5. `js/valuation.js`
6. `js/session_logic.js`
7. `js/ws_client.js`
8. `ib_server.py`
9. `historical_replay_service.py`
10. `trade_execution/adapters/ibkr.py`
11. `js/iv_term_structure.js` and `js/iv_term_structure_core.js`
