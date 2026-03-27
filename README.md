# Option Combo Simulator

## What This Repo Is

Option Combo Simulator is a local browser app for building, pricing, replaying, and tracking multi-leg option structures. Recent extensive refactoring has matured it into a comprehensive analysis and execution workspace.

Current shipped capabilities include:

- **Live & Scenario Analysis**: Multi-group option portfolios supporting `trial`, `active`, `amortized`, and `settlement` view modes.
- **Advanced Workspace Management**: Collapsible combo and hedge groups for efficient vertical space utilization.
- **Global Aggregation**: Global portfolio P&L tracking, global amortized aggregation, and probability analysis.
- **Enhanced Visualization**:
  - Per-group and global P&L charts.
  - Dedicated **P/L margin sub-charts** for continuous profit margin tracking.
  - Assigned-shares cost basis banners in settlement mode.
- **Session Continuity**: Full Import/Export of workspace state via JSON files, preserving simulated dates and timeline settings.
- **Historical Replay / Backtest**: A dedicated workspace mode to step through SQLite historical option chains, preview triggers, and simulate executions.
- **Live Trading Bridge**: Optional Python IBKR bridge offering live quotes, IV tracking, and managed live execution of combo orders.
  - supports trigger-based combo execution, close-group execution, concession pricing, and assignment/exercise-aware bookkeeping
- **Chart Lab**: An experimental sandbox projecting multi-leg payoff structures directly onto daily candle charts.

There is no frontend build step. The app runs from plain HTML/CSS/JavaScript files loaded in order.

## Main Entry Points

### Shared App Shell

- `index.html`

This is the main portfolio workspace. It supports:

- **Live Workspace Mode**: Connect to IBKR for real-time data and execution.
- **Historical Replay Mode**: Connect to SQLite to replay historical market conditions.
- Group editing, charting, custom dual-view probability analysis, and execution controls.
- Session import / export flow.

### Experimental Projection Page

- `chart_lab.html`

This is a sandbox page for the daily K-line payoff projection experiment.

Current state:

- Reuses the same in-memory app state and `Simulated Date` as the main page.
- Projects either one group or the included global portfolio onto a price chart.
- Uses IBKR historical daily bars when available, falling back to SQLite.
- Aligns price on the candle chart (horizontal projection width is currently normalized P&L, not strict time paths).

## Startup

### Windows

Preferred startup scripts:

- `start_option_combo.bat`
  - starts the frontend HTTP server
  - starts `ib_server.py`
  - prints the locked live workspace URL to the console

- `start_historical_replay.bat`
  - starts the frontend HTTP server
  - starts `historical_server.py`
  - prints the locked historical replay workspace URL to the console

- `install_ib_bridge_deps.bat`
  - installs the Python dependencies for the live IBKR bridge

- `powershell_scripts/start_option_combo_codex.ps1`
  - background-friendly startup used for Codex / automation flows
  - writes PID and log files into the repo root

- `powershell_scripts/start_ib_server_server_template.ps1`
  - editable server-side template for running a single background `ib_server.py`
  - writes a dedicated PID file plus stdout/stderr logs
  - intended for remote / server deployments where you want one observable backend instance

### macOS

- `start_option_combo_mac.command`
- `install_ib_bridge_deps_mac.command`

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

### Frontend + live IBKR bridge

```powershell
$PYTHON = powershell -NoProfile -ExecutionPolicy Bypass -File .\powershell_scripts\resolve_python.ps1
& $PYTHON ib_server.py
```

The live bridge defaults to:

- `ws://127.0.0.1:8765`

The browser workspace now lets you choose both a WebSocket host and port from the sidebar. That makes it possible to:

- connect one tab to your local `TWS + ib_server.py`
- connect another tab to a remote `IB Gateway + ib_server.py`
- keep both running from the same local Chrome session without using Remote Desktop

### Frontend + historical replay bridge

```powershell
$PYTHON = powershell -NoProfile -ExecutionPolicy Bypass -File .\powershell_scripts\resolve_python.ps1
& $PYTHON historical_server.py
```

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

## Live Bridge Config

`ib_server.py` reads its WebSocket bind addresses from `config.ini`:

```ini
[server]
ws_host = 127.0.0.1
ws_port = 8765
```

Important distinction:

- `tws.host` tells `ib_server.py` how to reach TWS / IB Gateway
- `server.ws_host` tells your browser how to reach `ib_server.py`

`server.ws_host` supports a comma-separated list. This lets one `ib_server.py` process listen on both loopback and a Tailscale / LAN address at the same time.

Example:

```ini
[server]
ws_host = 127.0.0.1,100.106.134.104
ws_port = 8765
```

That configuration accepts WebSocket connections on:

- `127.0.0.1:8765`
- `100.106.134.104:8765`

## Remote Access Over Tailscale

One practical deployment pattern is:

1. Run `IB Gateway` and `ib_server.py` on the remote machine.
2. Keep `tws.host = 127.0.0.1` on that remote machine if Gateway is local to it.
3. Set `server.ws_host` to include the remote machine's Tailscale IP, optionally alongside `127.0.0.1`.
4. From your own laptop, open the frontend locally in Chrome.
5. In the sidebar's `WebSocket Endpoint` controls, enter either:
   - `127.0.0.1` for your personal local account
   - the remote Tailscale IP or MagicDNS host for the company account

Current connection model:

- one browser tab connects to one backend at a time
- using two tabs is the simplest way to operate local and remote accounts side by side

Recommended safety posture:

- do not expose `8765` directly to the public internet
- prefer Tailscale reachability plus OS firewall restrictions
- if the remote bridge listens on a non-loopback host, confirm only your tailnet can reach it
- when running on a server, keep exactly one `ib_server.py` instance active and prefer the PID/log workflow in `powershell_scripts/start_ib_server_server_template.ps1`

## Product Support

### Equity / ETF option families

- default stock / ETF flow
- equity-style underlying legs supported
- amortized mode supported

### Cash-settled index option families

- `SPX`
- `NDX`

Current behavior:

- priced through product-aware metadata
- live-data contract resolution supported through the current IBKR bridge
- cash-settled behavior modeled
- amortized mode intentionally disabled

### Futures option families

- `ES`
- `NQ`
- `CL`
- `GC`
- `SI`
- `HG`

Current behavior:

- family-specific multipliers
- futures underlying legs supported
- Black-76 pricing path available
- product-aware IBKR contract building supported
- amortized mode intentionally disabled

## Historical Replay / Backtest

Historical replay is implemented as a first-class execution environment.

Current behavior includes:

- historical mode cleanly split from live mode
- replay-day quote snapshots loaded directly from SQLite
- deterministic replay timeline stepping
- historical trigger preview, test submit, and simulated fills
- `"Enter @ Replay Day"` workflow to lock past quotes as entry prices
- close simulation and expiry auto-settlement controls

Main files:

- `historical_server.py`
- `historical_data.py`
- `historical_replay_service.py`

## Major Files

| File | Responsibility |
| --- | --- |
| `index.html` | Main app shell, templates, shared controls, UI layouts |
| `chart_lab.html` | Experimental daily candle projection page |
| `style.css` | Main app styles |
| `chart_lab.css` | Chart Lab styles |
| `js/app.js` | Core application bootstrap and query parameter routing |
| `js/session_logic.js` | Import/Export core capabilities and state restoration |
| `js/product_registry.js` | Product-family metadata and capability flags |
| `js/pricing_context.js` | Underlying anchor logic, futures-pool and forward-rate context |
| `js/pricing_core.js` | Core pricing helpers and simulated pricing logic |
| `js/valuation.js` | Portfolio/group derived values |
| `js/chart.js` | P&L, amortized, and margin sub-chart renderers |
| `js/chart_controls.js` | Group/global chart control plumbing |
| `js/prob_charts.js` | Probability analysis charts and worker logic |
| `js/ws_client.js` | Browser WebSocket client for live and historical backends |
| `js/chart_lab.js` | Daily K projection lab |
| `ib_server.py` | IBKR live market data and execution bridge |
| `historical_server.py` | SQLite historical replay backend |
| `historical_data.py` | SQLite data access module |
| `historical_replay_service.py` | Historical replay payload assembly |
| `trade_execution/` | Execution engine routing structure |

## Current Known Boundaries

- `chart_lab.html` is still experimental.
- The daily K projection currently aligns the price axis only; horizontal projection width is normalized P&L, not time.
- Mixed-expiry payoff projection still needs a more explicit path assumption if you want a financially rigorous later-expiry overlay.
- `contract_specs/*.xml` exist as reference material; runtime product behavior is strictly defined in `js/product_registry.js`.
- Reloading the page does not currently reconstruct an older managed-order supervision session.

## Tests

Tests live under `tests/`.

They currently cover key shared logic areas, including:

- product registry
- pricing core / BSM / Black-76 behavior
- valuation and session logic
- WebSocket client payload assembly
- pricing-context and forward-rate functionality
- group order generation
- UI helpers

## Related Docs

- `ARCHITECTURE.md` - Core runtime design, lifecycle events, and exact module responsibilities.
- `DEV_HANDOVER.md` - Operational developer notes, including the precise state of live features vs. experimental work.
- `AGENTS.md` - Repo-specific workflow guidelines and script resolution advice for automated agents.
