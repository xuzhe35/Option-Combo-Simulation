# Option Combo Simulator - Developer Handover

**Updated:** 2026-03-27

## 1. Current Product State

This repo is no longer just a single-page option sandbox.

Current shipped surface area:

- live portfolio workspace in `index.html`
- historical replay / backtest workspace in `index.html`
- experimental projection surface in `chart_lab.html`
- optional IBKR live quotes and combo execution through `ib_server.py`

## 2. What Is Actually Implemented

### Portfolio / charting

- per-group P&L chart
- global portfolio P&L chart
- per-group amortized chart
- global amortized chart
- probability analysis

### Mode system

- `trial`
- `active`
- `amortized`
- `settlement`

### Product families

- equity / ETF default flow
- index options: `SPX`, `NDX`
- futures options: `ES`, `NQ`, `CL`, `GC`, `SI`, `HG`
- futures underlying legs for supported futures-option families

### Historical replay

- historical quote loading from SQLite
- replay-day stepping
- historical trigger preview / submit simulation
- replay-day entry locking
- historical close simulation
- expiry auto-settlement controls

### Live execution

- combo preview
- test submit
- real submit
- managed repricing
- close-group execution using the same managed repricing path
- concession pricing from middle toward worst quoted price
- assignment / exercise conversion into realized premium plus underlying legs
- execution-report cost attribution preferred over account-level avg cost for triggered orders

### Chart Lab

- custom daily candle chart
- live latest-price overlay
- single-group projection
- included-global-portfolio projection
- same simulated date as the main portfolio page
- IB historical daily bars with SQLite fallback

## 3. Important Entry Points

### Main frontend pages

- `index.html`
- `chart_lab.html`

### Python backends

- `ib_server.py`
- `historical_server.py`

### Startup scripts

Windows:

- `start_option_combo.bat`
- `start_historical_replay.bat`
- `install_ib_bridge_deps.bat`
- `powershell_scripts/start_option_combo_codex.ps1`
- `powershell_scripts/start_ib_server_server_template.ps1`

macOS:

- `start_option_combo_mac.command`
- `install_ib_bridge_deps_mac.command`

## 4. Where To Look First

If you need the current architecture:

- `ARCHITECTURE.md`

If you need user-facing startup and feature notes:

- `README.md`

If you need repo-specific agent / automation guidance:

- `AGENTS.md`

If docs drift from behavior, trust:

1. `js/product_registry.js`
2. `js/pricing_context.js`
3. `js/pricing_core.js`
4. `js/valuation.js`
5. `js/session_logic.js`
6. `js/ws_client.js`
7. `ib_server.py`
8. `historical_replay_service.py`
9. `trade_execution/adapters/ibkr.py`

## 5. Architectural Hotspots

### `js/product_registry.js`

Runtime source of truth for:

- family metadata
- secType
- multipliers
- trading classes
- underlying-leg support
- amortized support

### `js/pricing_context.js`

This is where the modern anchor logic lives:

- futures-pool mapping
- forward-rate sample handling
- anchor display text
- scenario price mapping

### `js/pricing_core.js`

Pricing SSOT:

- BSM
- Black-76
- underlying-leg normalization
- simulated price dispatch

### `js/valuation.js`

Portfolio aggregation and group derived values.

### `js/ws_client.js`

This file is large, but it is the real frontend transport layer for:

- live subscriptions
- historical replay requests
- Trigger execution messages
- close-group execution messages
- broker sync messages
- execution-report fill attribution
- live IV fallback handling (`TWS live` / `estimated` / `manual` / `N/A`)

### `ib_server.py`

Not just a quote streamer anymore.

It now also owns:

- product-aware IB contract qualification
- historical daily-bar responses for Chart Lab
- execution routing bridge into `trade_execution/`
- combo order status fan-out back to the browser
- explicit server-side PID/log friendly startup templates via `powershell_scripts/`
- TWS/Gateway connection timeout is set to 20 seconds (up from the default) to accommodate slower environments such as Docker containers

## 6. Current Known Rough Edges

- `chart_lab.html` is still experimental.
- The daily K projection aligns the price axis only; projection width is still normalized P&L, not time.
- Mixed-expiry projection semantics in Chart Lab still need a more explicit path assumption for later-expiry overlays.
- `contract_specs/*.xml` are still reference metadata, not runtime truth.
- Reloading the page does not restore old live managed-order supervision state.
- A remote/server deployment should run exactly one observable `ib_server.py` instance; if multiple unmanaged Python processes are left alive, broker-status debugging becomes unreliable.

## 7. Practical Maintenance Notes

- On Windows, do not assume bare `python` will work; use `powershell_scripts/resolve_python.ps1`.
- Script order in `index.html` still matters.
- The main app and Chart Lab now share frontend state, but Chart Lab keeps its own canvas rendering and WebSocket lifecycle.
- If a tab switch causes missing visuals, check redraw timing before assuming data loss.

## 8. Suggested Next-Trust Areas

If you are changing these features, read these files together:

### Product / pricing changes

- `js/product_registry.js`
- `js/pricing_context.js`
- `js/pricing_core.js`
- `js/valuation.js`

### Historical replay changes

- `historical_server.py`
- `historical_data.py`
- `historical_replay_service.py`
- `js/ws_client.js`

### Chart Lab changes

- `chart_lab.html`
- `chart_lab.css`
- `js/chart_lab.js`

### Execution changes

- `js/group_order_builder.js`
- `js/trade_trigger_logic.js`
- `js/ws_client.js`
- `ib_server.py`
- `trade_execution/adapters/ibkr.py`
- `powershell_scripts/start_ib_server_server_template.ps1`
