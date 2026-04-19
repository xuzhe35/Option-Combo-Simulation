# Option Combo Simulator

## What This Repo Is

Option Combo Simulator is a local browser workspace for building, pricing, replaying, and monitoring multi-leg option structures.

Today the repo has three related runtime surfaces:

1. `index.html`
2. `chart_lab.html`
3. optional Python backends:
   - `ib_server.py` for live IBKR market data, combo execution, and shared historical-bar fallback
   - `historical_server.py` for SQLite quote replay only

There is still no frontend build step. The UI is plain HTML/CSS/JavaScript loaded in ordered global-script form.

## Current Shipped Capabilities

- Live workspace and historical replay workspace in the same shared shell.
- Multi-group portfolio editing with:
  - collapsible groups
  - group reordering
  - per-group include/exclude from global totals
  - optional live-data toggle per group and hedge
- Group modes:
  - `trial`
  - `active`
  - `amortized`
  - `settlement`
- Group-level execution workflows:
  - trigger conditions in trial mode
  - preview / test-submit / submit combo requests
  - managed reprice / continue / concede / cancel controls
  - close-group execution using the same combo-order path
- Cost-tracking helpers:
  - per-group portfolio average-cost sync
  - assignment / exercise conversion into deliverable underlying legs
  - execution-report fill attribution back into entry cost or close price
- Product-aware pricing controls:
  - Forward Carry panel for cash-settled index options
  - Futures Pool panel for FOP underlyings
  - product-specific price precision and combo tick increments
- Portfolio visuals:
  - per-group and global P&L charts
  - per-group and global amortized analysis
  - probability analysis
  - group-level live P&L and delta summaries when available
- Historical replay:
  - historical entry date plus replay date timeline
  - separate simulation date in historical mode
  - replay-day trigger preview / simulated submit
  - `Enter @ Replay Day`
  - optional auto-close-at-expiry settlement
  - `Settle All Groups`
- Session persistence:
  - JSON import / export
  - direct save-back when the browser File System Access API is available

## Main Entry Points

### `index.html`

This is the main portfolio workspace.

It supports:

- live IBKR mode
- SQLite historical replay mode
- forward-carry samples for index products
- futures-pool management for FOP products
- live combo-order account selection
- configurable browser WebSocket host and port

Locked routes supported today:

- `index.html?entry=live&marketDataMode=live&lockMarketDataMode=1`
- `index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1`

### `chart_lab.html`

This is a separate page that embeds the shared portfolio shell plus an additional `Chart Lab` tab.

Current behavior:

- loads the same shared frontend runtime as `index.html`
- adds `js/chart_lab.js`
- opens its own socket for daily bars and latest underlying price
- projects one group or the included global portfolio onto a daily candle chart
- uses the same in-memory state and simulated date as the portfolio view on that page

Important current limitation:

- Chart Lab requests `request_historical_bars`, which is implemented in `ib_server.py`
- the SQLite daily-bar fallback is also currently served through `ib_server.py`
- `historical_server.py` does **not** implement the bar endpoint

So if you want Chart Lab bars today, run `ib_server.py`, even if you only need the SQLite fallback path.

## Backend Responsibilities

### `ib_server.py`

Current responsibilities include:

- live underlying / option / futures subscriptions
- managed account snapshots for live order routing
- portfolio average-cost snapshots
- combo validation / preview / submit
- managed repricing supervision
- close-group execution
- execution-status and execution-fill fan-out back to the browser
- historical replay snapshots through `HistoricalReplayService`
- historical daily bars for Chart Lab, with SQLite fallback when IB bars are unavailable

`ib_server.py` starts the IB connection in the background so the process can still serve replay and fallback paths even if TWS / Gateway is not available.

### `historical_server.py`

This is the lightweight SQLite replay server.

Current responsibilities:

- `request_historical_snapshot`
- empty `portfolio_avg_cost_update` responses for historical mode

Important boundaries:

- binds to `127.0.0.1` only
- ignores non-loopback `server.ws_host` values
- does not provide live execution
- does not provide Chart Lab daily bars

## Startup

### Windows

User-facing wrappers:

- `start_option_combo.bat`
- `start_historical_replay.bat`
- `install_ib_bridge_deps.bat`

These call the PowerShell implementations in `powershell_scripts/`.

Important PowerShell entry points:

- `powershell_scripts/start_option_combo.ps1`
- `powershell_scripts/start_historical_replay.ps1`
- `powershell_scripts/start_option_combo_codex.ps1`
- `powershell_scripts/launch_ib_server_codex.ps1`
- `powershell_scripts/restart_option_combo_codex.ps1`
- `powershell_scripts/restart_ib_server_codex.ps1`
- `powershell_scripts/start_ib_server_server_template.ps1`

### macOS / POSIX

- `start_option_combo_mac.command`
- `install_ib_bridge_deps_mac.command`
- `start_option_combo.sh`

`start_option_combo.sh` mirrors the repo's Python-resolution chain for shell sessions.

## Manual Local Run

### Frontend only

```powershell
$PYTHON = powershell -NoProfile -ExecutionPolicy Bypass -File .\powershell_scripts\resolve_python.ps1
& $PYTHON -m http.server 8000
```

Open one of:

- `http://localhost:8000/index.html`
- `http://localhost:8000/index.html?entry=live&marketDataMode=live&lockMarketDataMode=1`
- `http://localhost:8000/index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1`
- `http://localhost:8000/chart_lab.html`

### Frontend + live / shared backend

```powershell
$PYTHON = powershell -NoProfile -ExecutionPolicy Bypass -File .\powershell_scripts\resolve_python.ps1
& $PYTHON ib_server.py
```

Default WebSocket bind:

- `ws://127.0.0.1:8765`

This is the recommended backend when you need any of the following:

- live IBKR data
- combo execution
- managed repricing
- Chart Lab daily bars
- SQLite fallback bars for Chart Lab

### Frontend + historical replay-only backend

```powershell
$PYTHON = powershell -NoProfile -ExecutionPolicy Bypass -File .\powershell_scripts\resolve_python.ps1
& $PYTHON historical_server.py
```

Use this when you only need replay snapshots for the main workspace and do not need Chart Lab bars or live execution.

## Python Resolution

Do not assume bare `python` is reliable on Windows.

The repo resolves Python in this order:

1. `OPTION_COMBO_PYTHON`
2. `config.local.ini` -> `[python] executable`
3. `config.ini` -> `[python] executable`
4. `.venv\Scripts\python.exe`
5. `venv\Scripts\python.exe`
6. common Windows install locations
7. `python.exe` / `python` from `PATH`

Use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\powershell_scripts\resolve_python.ps1
```

Do not commit personal filesystem paths into tracked config files. Use `config.local.ini` for machine-local overrides.

## WebSocket and Config Notes

### Live backend

`ib_server.py` reads:

```ini
[tws]
host = 127.0.0.1
port = 7496
client_id = 999

[server]
ws_host = 127.0.0.1
ws_port = 8765
```

Important distinction:

- `tws.host` / `tws.port` tell `ib_server.py` how to reach TWS or IB Gateway
- `server.ws_host` / `server.ws_port` tell the browser how to reach `ib_server.py`

`server.ws_host` may be a comma-separated list in `ib_server.py`, so one backend can listen on loopback plus a LAN or Tailscale address at the same time.

### Historical backend

`historical_server.py` reuses `server.ws_port`, but normalizes the bind host to `127.0.0.1` regardless of non-loopback config.

### Browser-side endpoint controls

- `index.html` exposes both WebSocket host and port controls
- `chart_lab.html` currently exposes only the port control and always connects to `127.0.0.1`

## Product Support

### Browser pricing / valuation support

`js/product_registry.js` currently recognizes:

- equity / ETF default flow
- cash-settled index options:
  - `SPX`
  - `NDX`
- futures-option families:
  - `ES`
  - `NQ`
  - `CL`
  - `GC`
  - `SI`
  - `HG`

Current browser-side behavior:

- equity-style underlyings supported for stock / ETF products
- futures underlyings supported for FOP products
- product-specific price decimals and combo increments supported
  - `HG` uses 5 displayed decimals with a `0.0005` combo price increment
- Black-76 used for FOP and index-style paths
- amortized mode intentionally disabled for non-equity deliverables

### Live IBKR backend notes

Current live backend wiring includes:

- stock / ETF flow
- index exchange fallbacks for `SPX` and `NDX`
- explicit live-family defaults in `ib_server.py` for:
  - `ES`
  - `NQ`
  - `CL`

The frontend registry knows about `GC`, `SI`, and `HG`, but if you are touching live contract-qualification logic, note that `ib_server.py`'s hard-coded family defaults are narrower than the browser registry.

## Historical Replay

Main files:

- `historical_server.py`
- `historical_data.py`
- `historical_replay_service.py`

Current replay payloads include:

- underlying snapshot
- option snapshots
- historical effective date metadata
- available replay date bounds
- historical risk-free rate
- historical yield-curve points
- expiry-date underlying snapshots used for auto-settlement flows

Main workspace behavior in historical mode:

- `baseDate` acts as the historical start / entry date
- `historicalQuoteDate` acts as the replay date
- `simulatedDate` can move forward independently for pricing and charts
- real TWS order routing is blocked
- trigger and close-group flows become replay simulations instead of live broker actions

## Project Map

| File / Path | Responsibility |
| --- | --- |
| `index.html` | main portfolio workspace |
| `chart_lab.html` | shared workspace plus Chart Lab tab |
| `style.css` | shared styles |
| `chart_lab.css` | Chart Lab styling |
| `js/app.js` | state container and orchestration |
| `js/session_ui.js` | workspace chrome, locked-mode labels, document title |
| `js/control_panel_ui.js` | market-data mode, date controls, forward-carry panel, futures-pool panel |
| `js/product_registry.js` | product-family source of truth |
| `js/pricing_context.js` | quote-date / simulation-date / anchor resolution |
| `js/pricing_core.js` | pricing SSOT |
| `js/valuation.js` | group and portfolio derived data |
| `js/group_order_builder.js` | open/close combo request payload builders |
| `js/trade_trigger_logic.js` | trigger state and order-trigger rules |
| `js/group_editor_ui.js` | group editor, trial-trigger UI, close-group UI |
| `js/group_ui.js` | group DOM writers and execution-status rendering |
| `js/ws_client.js` | live subscriptions, replay requests, combo-order transport, fill/status updates |
| `js/chart_lab.js` | Chart Lab socket, daily bars, projection rendering |
| `trade_execution/` | execution engine and IBKR adapter |

## Tests

Tests live under `tests/`.

The default Node runner is:

```powershell
node .\tests\run.js
```

It currently runs the suites wired into `tests/run.js`, including:

- market holidays
- product registry
- distribution proxy config
- group order builder
- trade trigger logic
- BSM / amortized / valuation
- session logic / session UI / control panel UI
- group UI / group editor UI / hedge editor UI
- WebSocket client

Additional test files also exist in `tests/`, but not every file in that directory is currently included by the default runner.

## Related Docs

- `ARCHITECTURE.md` - runtime layout and module responsibilities
- `DEV_HANDOVER.md` - developer-facing operational notes
- `AGENTS.md` - repo-specific agent guidance
