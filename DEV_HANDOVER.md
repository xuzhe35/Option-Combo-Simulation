# Option Combo Simulator - Developer Handover

**Updated:** 2026-04-19

## 1. Current Product State

This repo is a shared browser workspace with two backend flavors, not just a single-page option sandbox.

Current surfaces:

- `index.html` for the main portfolio workspace
- `chart_lab.html` for the shared workspace plus the experimental Chart Lab tab
- `ib_server.py` for live IBKR data, combo execution, and shared historical-bar fallback
- `historical_server.py` for SQLite replay snapshots only

## 2. What Is Actually Implemented

### Shared frontend shell

- live and historical market-data environments in the same runtime
- query-param-based locked workspaces:
  - `entry=live`
  - `entry=historical`
- workspace banner / title / subtitle changes driven by `workspaceVariant` and `marketDataModeLocked`
- JSON import / export
- direct save-back when the browser File System Access API is available

### Control panel

- underlying symbol plus optional underlying futures month
- historical start date, replay date, and separate simulation date
- forward-carry sample panel for index products
- futures-pool panel for FOP products
- live-order enable switch
- live TWS account selector once accounts are discovered
- configurable browser WS endpoint in `index.html`

### Group surface

- add / remove groups and legs
- group collapse / expand
- group reorder: top / up / down
- per-group include / exclude from global totals
- per-group live-price display mode:
  - `mark`
  - `midpoint`
- group modes:
  - `trial`
  - `active`
  - `amortized`
  - `settlement`
- per-group portfolio average-cost sync toggle
- assignment / exercise conversion into deliverable underlying legs

### Execution workflows

- trigger conditions in trial mode
- trigger execution modes:
  - `preview`
  - `test_submit`
  - `submit`
- close-group execution using the same combo-order pipeline
- managed repricing controls:
  - continue
  - concede
  - cancel
- execution-report cost attribution back into the group
- separate close-price attribution for close-group fills

### Historical replay

- SQLite replay snapshots
- historical date-range metadata
- replay-date stepping
- historical risk-free rate hydration
- historical yield-curve hydration
- `Enter @ Replay Day`
- auto-close-at-expiry support
- `Settle All Groups`
- replay simulations for trigger and close-group flows instead of real broker routing

### Chart Lab

- daily candle rendering
- live/latest price overlay
- one-group or included-global projection
- same simulated-date concept as the shared portfolio runtime

## 3. Important Entry Points

### Frontend

- `index.html`
- `chart_lab.html`

### Backends

- `ib_server.py`
- `historical_server.py`
- `historical_replay_service.py`
- `historical_data.py`

### Startup scripts

Windows wrappers:

- `start_option_combo.bat`
- `start_historical_replay.bat`
- `install_ib_bridge_deps.bat`

Underlying PowerShell scripts:

- `powershell_scripts/start_option_combo.ps1`
- `powershell_scripts/start_historical_replay.ps1`
- `powershell_scripts/start_option_combo_codex.ps1`
- `powershell_scripts/launch_ib_server_codex.ps1`
- `powershell_scripts/restart_option_combo_codex.ps1`
- `powershell_scripts/restart_ib_server_codex.ps1`
- `powershell_scripts/start_ib_server_server_template.ps1`
- `powershell_scripts/resolve_python.ps1`
- `powershell_scripts/python_launcher_common.ps1`

POSIX / macOS:

- `start_option_combo.sh`
- `start_option_combo_mac.command`
- `install_ib_bridge_deps_mac.command`

## 4. Where To Look First

If docs drift from behavior, trust code in roughly this order:

1. `js/product_registry.js`
2. `js/pricing_context.js`
3. `js/pricing_core.js`
4. `js/valuation.js`
5. `js/session_logic.js`
6. `js/group_order_builder.js`
7. `js/group_editor_ui.js`
8. `js/group_ui.js`
9. `js/ws_client.js`
10. `ib_server.py`
11. `historical_replay_service.py`
12. `trade_execution/adapters/ibkr.py`

## 5. Architectural Hotspots

### `js/product_registry.js`

Runtime product source of truth for:

- family metadata
- secType / exchanges / trading class
- multipliers
- settlement kind
- amortized-mode support
- price precision and combo increment
  - `HG` currently uses a `0.0005` combo price increment
- default futures-month logic

Important current nuance:

- browser product coverage includes `GC`, `SI`, and `HG`
- `ib_server.py`'s `SUPPORTED_LIVE_FAMILIES` is narrower and currently hard-codes live-family defaults for `ES`, `NQ`, and `CL`

### `js/pricing_context.js`

This is where quote-date, simulation-date, anchor-price, futures-pool, and forward-carry semantics are resolved.

Historical-mode date behavior now depends on:

- `baseDate`
- `historicalQuoteDate`
- `simulatedDate`

Do not collapse those concepts together when debugging replay behavior.

### `js/session_logic.js`

State normalization source of truth for:

- imported sessions
- trade trigger defaults
- close-execution defaults
- forward-rate sample archiving
- futures-pool archiving
- historical auto-close-at-expiry defaults
- per-group live-price mode and avg-cost sync flags

### `js/group_order_builder.js`

Generic combo-request builder shared by:

- trigger open flow
- manual close-group flow

This is the right place to check when request payloads drift from frontend state.

### `js/group_editor_ui.js`

This file now owns more than simple form rendering.

It also handles:

- group ordering
- live-price-mode UI
- avg-cost sync UI
- trigger / close-group configuration UI
- assignment / exercise conversion
- futures-pool leg selection for FOP products

### `js/group_ui.js`

This is the main renderer for:

- trigger runtime state
- close-group runtime state
- preview / submit / fill summaries
- live P&L and delta badges
- settlement / amortized banners

### `js/ws_client.js`

This remains the main frontend transport layer.

Current responsibilities include:

- live subscribe payload assembly
- historical snapshot requests
- portfolio average-cost syncing
- managed-account syncing
- trigger preview / submit flow
- close-group preview / submit flow
- managed resume / concede / cancel requests
- historical auto-settlement and replay-cost seeding
- incremental live-quote derived-value refreshes

### `ib_server.py`

Current server responsibilities:

- IB connection lifecycle
- live quote subscriptions
- managed-account snapshot fan-out
- portfolio average-cost snapshot fan-out
- combo preview / validation / submit dispatch through `trade_execution/`
- managed order-status updates
- execution-fill cost attribution
- historical replay snapshots through `HistoricalReplayService`
- historical daily bars for Chart Lab
- SQLite fallback bars when IB historical bars are unavailable

Important operational detail:

- the IB connection is started in the background so replay and fallback paths can still work if TWS is down

### `historical_server.py`

This is intentionally much smaller than `ib_server.py`.

Current responsibilities:

- historical quote snapshots
- empty portfolio avg-cost payloads for historical mode

Not implemented there today:

- live execution
- managed accounts
- Chart Lab bar endpoint

## 6. Current Known Boundaries

- `chart_lab.html` is still experimental.
- Chart Lab always opens `ws://127.0.0.1:<port>`; it does not expose a host override like `index.html`.
- Chart Lab daily bars come from `request_historical_bars`, which currently exists in `ib_server.py`, not `historical_server.py`.
- The SQLite daily-bar fallback for Chart Lab is therefore only reachable through `ib_server.py`.
- `historical_server.py` normalizes its bind host to localhost and is replay-only by design.
- Reloading the page does not reconstruct an old managed-order supervision session.
- `contract_specs/*.xml` remain reference material; runtime truth lives in `js/product_registry.js`.
- If multiple unmanaged `ib_server.py` processes are running, broker-status debugging becomes unreliable because the browser may be talking to a different process than the logs you are inspecting.

## 7. Practical Maintenance Notes

- On Windows, use `powershell_scripts/resolve_python.ps1`; do not assume bare `python`.
- `index.html` and `chart_lab.html` are still ordered-script apps. Load order matters.
- Historical mode is not just a flag flip. The app distinguishes:
  - historical start date / entry date
  - replay date
  - simulation date
- Live combo submit and test-submit are intentionally gated by:
  - `allowLiveComboOrders === true`
  - a selected managed TWS account
- `historicalAutoCloseAtExpiry` defaults to `true` per group.
- `syncAvgCostFromPortfolio` defaults to enabled for newly created trial groups.
- `livePriceMode` affects displayed price and live P&L, but combo-order pricing still uses the existing midpoint-based order-preview/submit flow.

## 8. Tests

The default local runner is:

```powershell
node .\tests\run.js
```

That runner currently includes the main suites wired in `tests/run.js`, such as:

- product registry
- group order builder
- trade trigger logic
- valuation
- session logic / UI
- control panel UI
- group UI / editor UI
- hedge editor UI
- WebSocket client

Important nuance:

- there are additional test files under `tests/`
- not every file in that folder is currently included in `tests/run.js`

## 9. Suggested Read Orders

### Product / pricing changes

- `js/product_registry.js`
- `js/pricing_context.js`
- `js/pricing_core.js`
- `js/valuation.js`

### Historical replay changes

- `historical_server.py`
- `historical_replay_service.py`
- `historical_data.py`
- `js/ws_client.js`
- `js/control_panel_ui.js`

### Chart Lab changes

- `chart_lab.html`
- `chart_lab.css`
- `js/chart_lab.js`
- `ib_server.py`

### Execution changes

- `js/group_order_builder.js`
- `js/trade_trigger_logic.js`
- `js/group_editor_ui.js`
- `js/group_ui.js`
- `js/ws_client.js`
- `ib_server.py`
- `trade_execution/engine.py`
- `trade_execution/adapters/ibkr.py`
