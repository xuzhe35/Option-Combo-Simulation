# AGENTS.md

## Purpose

This repo is a local browser app plus two optional Python backends:

- `ib_server.py` for live IBKR data and execution
- `historical_server.py` for SQLite historical replay

Do not assume a bare `python` command will work in every shell, especially on Windows or inside sandboxed agent sessions.

## Read These First

- `README.md` for user-facing startup and feature notes
- `ARCHITECTURE.md` for the actual runtime design
- `DEV_HANDOVER.md` for current developer-facing operational notes
- `powershell_scripts/` for Windows launch and Python resolution helpers

## Frontend Entry Points

- `index.html`
  - shared portfolio shell
  - supports both live and historical workspaces via query params

- `chart_lab.html`
  - experimental daily K projection page
  - reuses the main app state, but has its own rendering and socket lifecycle

## Startup Entry Points

### Windows

- live workspace: `start_option_combo.bat`
- historical replay workspace: `start_historical_replay.bat`
- IB bridge dependency install: `install_ib_bridge_deps.bat`
- Python resolution helper: `powershell_scripts/resolve_python.ps1`
- background / Codex startup: `powershell_scripts/start_option_combo_codex.ps1`
- editable single-backend server template: `powershell_scripts/start_ib_server_server_template.ps1`

### macOS

- main startup: `start_option_combo_mac.command`
- IB bridge dependency install: `install_ib_bridge_deps_mac.command`

## Python Rules

- On Windows, prefer the provided launch scripts over calling bare `python`.
- If you need the interpreter path, resolve it through `powershell_scripts/resolve_python.ps1`.
- `config.local.ini` is the local override for machine-specific Python paths and is ignored by git.
- Do not commit personal filesystem paths or machine-specific Python paths into tracked files.

## Architecture Notes For Agents

- The frontend is ordered global scripts loaded by `index.html`; load order matters.
- `js/product_registry.js`, `js/pricing_context.js`, and `js/pricing_core.js` are core runtime truth for product and pricing behavior.
- `js/valuation.js` is the main derived-state / aggregation layer.
- `js/ws_client.js` is the main transport layer for both live and historical frontend flows.
- `chart_lab.html` / `js/chart_lab.js` are experimental and should be treated separately from the main app shell.

## Backend Notes

- Live backend entry point: `ib_server.py`
- Historical replay backend entry point: `historical_server.py`
- SQLite access is mainly through `historical_data.py` and `historical_replay_service.py`

## Agent Workflow Guidance

- Before changing startup behavior, read the scripts in `powershell_scripts/`.
- If a task mentions Python resolution problems, debug the existing launcher chain before debugging `PATH`.
- If a task touches product-family behavior, read `js/product_registry.js` first.
- If a task touches chart or projection semantics, read both the main charting files and `js/chart_lab.js`.
- If a task touches historical replay, check whether the change belongs in `historical_server.py` or in the shared live frontend flow via `js/ws_client.js`.
