# AGENTS.md

## Purpose

This repo is a local browser app with three frontend surfaces and two optional Python backends.

Frontend surfaces:

- `index.html` for the main portfolio workspace
- `chart_lab.html` for the shared workspace plus experimental daily-bar projection
- `iv_term_structure.html` for standalone live IV term-structure monitoring

Backend entry points:

- `ib_server.py` for live IBKR data, live execution, Chart Lab bars, IV term-structure sync, and shared historical replay fallback paths
- `historical_server.py` for lightweight SQLite historical replay only

Do not assume a bare `python` command will work in every shell, especially on Windows or inside sandboxed agent sessions.

## Read These First

- `README.md` for user-facing startup, feature notes, and maintenance commands
- `ARCHITECTURE.md` for the actual runtime design and module boundaries
- `DEV_HANDOVER.md` for current developer-facing operational notes
- `powershell_scripts/` for Windows launch and Python resolution helpers

## Frontend Entry Points

- `index.html`
  - shared portfolio shell
  - supports live and historical workspaces via query params
  - loads ordered global scripts; load order matters

- `chart_lab.html`
  - experimental daily K projection page
  - reuses the main app state
  - has its own `js/chart_lab.js` rendering and socket lifecycle
  - requires `ib_server.py` for `request_historical_bars`

- `iv_term_structure.html`
  - standalone IV term-structure monitor
  - loads `js/product_registry.js`, `js/iv_term_structure_core.js`, and `js/iv_term_structure.js`
  - uses `iv_term_structure/iv_term_structure_config.json` and per-symbol history JSON files under `iv_term_structure/data/`
  - requires `ib_server.py` for `subscribe_iv_term_structure`, `connect_ib`, and IB status messages

## Startup Entry Points

### Windows

- live workspace: `start_option_combo.bat`
- historical replay workspace: `start_historical_replay.bat`
- IB bridge dependency install: `install_ib_bridge_deps.bat`
- runtime log cleanup: `cleanup_logs.bat`
- Python resolution helper: `powershell_scripts/resolve_python.ps1`
- background / Codex startup: `powershell_scripts/start_option_combo_codex.ps1`
- background / Codex restart: `powershell_scripts/restart_option_combo_codex.ps1`
- IB-only Codex launch/restart: `powershell_scripts/launch_ib_server_codex.ps1`, `powershell_scripts/restart_ib_server_codex.ps1`
- editable single-backend server template: `powershell_scripts/start_ib_server_server_template.ps1`

### macOS / POSIX

- main startup: `start_option_combo_mac.command`
- shell startup: `start_option_combo.sh`
- IB bridge dependency install: `install_ib_bridge_deps_mac.command`
- runtime log cleanup: `cleanup_logs_mac.command`

## Python Rules

- On Windows, prefer the provided launch scripts over calling bare `python`.
- If you need the interpreter path on Windows, resolve it through `powershell_scripts/resolve_python.ps1`.
- `config.local.ini` is the local override for machine-specific Python paths and is ignored by git.
- Do not commit personal filesystem paths or machine-specific Python paths into tracked files.
- `ib_server.py` and `historical_server.py` read runtime server/TWS settings from `config.ini`; `config.local.ini` is for launcher-local Python resolution.

## Architecture Notes For Agents

- The frontend is ordered global scripts loaded by HTML pages; there is no bundler or module loader.
- `js/product_registry.js`, `js/pricing_context.js`, and `js/pricing_core.js` are core runtime truth for product and pricing behavior.
- `js/valuation.js` is the main derived-state / aggregation layer.
- `js/ws_client.js` is the main transport layer for both live and historical flows in the portfolio workspace.
- `chart_lab.html` / `js/chart_lab.js` are experimental and should be treated separately from the main app shell.
- `iv_term_structure.html` / `js/iv_term_structure.js` are a standalone monitor; keep DOM-free selection and aggregation logic in `js/iv_term_structure_core.js` and `iv_term_structure_service.py`.

## Backend Notes

- Live / shared backend entry point: `ib_server.py`
  - starts IB connection in the background
  - can still serve historical replay and SQLite daily-bar fallback when TWS/Gateway is unavailable
  - handles live subscriptions, futures/stock hedge subscriptions, portfolio avg-cost updates, managed accounts, combo execution, Chart Lab daily bars, and IV term-structure sync

- Historical replay-only backend entry point: `historical_server.py`
  - binds to `127.0.0.1`
  - supports `request_historical_snapshot`
  - returns empty `portfolio_avg_cost_update`
  - does not provide live subscriptions, execution, Chart Lab bars, or IV term-structure sync

- SQLite access is mainly through `historical_data.py` and `historical_replay_service.py`.

## Agent Workflow Guidance

- Before changing startup behavior, read the scripts in `powershell_scripts/` plus the macOS/POSIX wrappers.
- If a task mentions Python resolution problems, debug the existing launcher chain before debugging `PATH`.
- If a task touches product-family behavior, read `js/product_registry.js` first.
- If a task touches pricing, date semantics, or replay valuation, read `js/pricing_context.js`, `js/pricing_core.js`, and `js/valuation.js`.
- If a task touches chart or projection semantics, read both the main charting files and `js/chart_lab.js`.
- If a task touches historical replay, check whether the change belongs in `historical_server.py`, `historical_replay_service.py`, or the shared live frontend flow via `js/ws_client.js`.
- If a task touches IV term structure, read `iv_term_structure.html`, `js/iv_term_structure.js`, `js/iv_term_structure_core.js`, `iv_term_structure_service.py`, and the IV sections in `ib_server.py`.
- If a task touches runtime logs or pid files, use or update `scripts/cleanup_runtime_logs.py`; do not clean data directories such as `Portfolio/`, `Portfolio 2/`, or `sqlite_spy/` as part of log maintenance.
