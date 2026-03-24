# Option Combo Simulator

## What This Repo Is

Option Combo Simulator is a local browser app for building, pricing, replaying, and tracking multi-leg option structures.

Current shipped capabilities include:

- live and manual scenario analysis for multi-group option portfolios
- `trial`, `active`, `amortized`, and `settlement` group modes
- global portfolio P&L and global amortized aggregation
- historical replay / backtest against SQLite option history
- optional IBKR live quotes, IV, combo preview, and managed live execution
- an experimental `Chart Lab` page that projects option payoff shapes onto a daily candle chart

There is no frontend build step. The app runs from plain HTML/CSS/JavaScript files loaded in order.

## Main Entry Points

### Shared app shell

- `index.html`

This is the main portfolio workspace. It supports:

- live workspace mode
- historical replay workspace mode
- import / export / save-back session flow
- group editing, charts, probability analysis, and execution controls

### Experimental projection page

- `chart_lab.html`

This is a sandbox page for the daily K-line payoff projection experiment.

Current state:

- reuses the same in-memory app state as the main page
- can project either one group or the included global portfolio
- uses the same `Simulated Date` as the portfolio page
- uses IBKR historical daily bars when available, with SQLite fallback
- aligns price on the candle chart, but the horizontal projection width is still normalized P&L, not true time

## Startup

### Windows

Preferred startup scripts:

- `start_option_combo.bat`
  - starts the frontend HTTP server
  - starts `ib_server.py`
  - opens the locked live workspace

- `start_historical_replay.bat`
  - starts the frontend HTTP server
  - starts `historical_server.py`
  - opens the locked historical replay workspace

- `install_ib_bridge_deps.bat`
  - installs the Python dependencies for the live IBKR bridge

- `powershell_scripts/start_option_combo_codex.ps1`
  - background-friendly startup used for Codex / automation flows
  - writes PID and log files into the repo root

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

Historical replay is implemented and no longer just a plan.

Current behavior includes:

- historical mode split from live mode
- replay-day quote loading from SQLite
- replay timeline stepping
- historical trigger preview / test submit / submit simulation
- `Enter @ Replay Day`
- close simulation
- expiry auto-settlement controls

Main files:

- `historical_server.py`
- `historical_data.py`
- `historical_replay_service.py`

## Major Files

| File | Responsibility |
| --- | --- |
| `index.html` | Main app shell, templates, shared controls, cards, charts |
| `chart_lab.html` | Experimental daily candle projection page |
| `style.css` | Main app styles |
| `chart_lab.css` | Chart Lab styles |
| `js/product_registry.js` | Product-family metadata and capability flags |
| `js/pricing_context.js` | Underlying anchor logic, futures-pool and forward-rate context |
| `js/pricing_core.js` | Core pricing helpers and simulated pricing |
| `js/valuation.js` | Portfolio/group derived values |
| `js/chart.js` | P&L and amortized chart renderers |
| `js/chart_controls.js` | Group/global chart control plumbing |
| `js/prob_charts.js` | Probability analysis charts and worker logic |
| `js/ws_client.js` | Browser WebSocket client for live and historical backends |
| `js/chart_lab.js` | Daily K projection lab |
| `ib_server.py` | IBKR live market data and execution bridge |
| `historical_server.py` | SQLite historical replay backend |
| `historical_data.py` | SQLite data access |
| `historical_replay_service.py` | Historical replay payload assembly |
| `trade_execution/` | Execution engine and IBKR adapter |

## Current Known Boundaries

- `chart_lab.html` is still experimental.
- The daily K projection currently aligns the price axis only; horizontal projection width is normalized P&L, not time.
- Mixed-expiry payoff projection still needs a more explicit path assumption if you want a financially rigorous later-expiry overlay.
- `contract_specs/*.xml` exist as reference material, but runtime product behavior currently comes from `js/product_registry.js`.
- Reloading the page does not reconstruct an old live managed-order supervision session.

## Tests

Tests live under `tests/`.

They currently cover the key shared logic areas, including:

- product registry
- pricing core / BSM / Black-76 behavior
- valuation
- session logic
- WebSocket client behavior
- pricing-context logic
- UI helpers

## Related Docs

- `ARCHITECTURE.md` for the current runtime design
- `DEV_HANDOVER.md` for operational developer notes
- `AGENTS.md` for repo-specific agent guidance
