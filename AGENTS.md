# AGENTS.md

## Purpose

This repo is a local browser app with seven frontend surfaces, two optional Python backends and an isolated OCR preview service.

Frontend surfaces:

- `index.html` for the main portfolio workspace
- `chart_lab.html` for the shared workspace plus experimental daily-bar projection
- `iv_term_structure.html` for standalone live IV term-structure monitoring
- `cost_basis.html` for the standalone per-underlying blended-cost ledger
- `cost_basis_fop.html` for the standalone FOP ledger (CL futures and options on futures)
- `workspace_db_admin.html` for the standalone workspace-database / archive admin page
- `portfolio_snapshot.html` for screenshot OCR, manual review and an in-memory Portfolio JSON (P0/P1)

Backend entry points:

- `ib_server.py` for live IBKR data, live execution, Chart Lab bars, IV term-structure sync, and shared historical replay fallback paths
- `historical_server.py` for lightweight historical replay only (chains/bars via the shared options-chain-service at http://127.0.0.1:8750; rates via dated yield_curve JSON, with sqlite_spy/rates.db only as a degraded legacy fallback)

Do not assume a bare `python` command will work in every shell, especially on Windows or inside sandboxed agent sessions.

## Read These First

- `README.md` for user-facing startup, feature notes, and maintenance commands
- `ARCHITECTURE.md` for the actual runtime design and module boundaries
- `DEV_HANDOVER.md` for current developer-facing operational notes
- `EXECUTION_SAFETY_CONTRACT.md` for the safety contract every broker-facing flow must satisfy
- `powershell_scripts/` for Windows launch and Python resolution helpers

## Frontend Entry Points

- `portfolio_snapshot.html`
  - independent screenshot Portfolio Tab, linked from `cost_basis.html`
  - loads only `portfolio_snapshot_schema.js`, `portfolio_snapshot_core.js`,
    `portfolio_snapshot_ocr.js`, `portfolio_snapshot.js`; no trading or ledger runtime
  - PNG/JPEG drop, original-image row crops, original OCR per field, manual corrections,
    JSON import/export; account/date manual, unknowns never zero-filled, combo parents excluded
  - optional isolated loopback preview: `python3 scripts/portfolio_snapshot_ocr_server.py`
    at 8798; macOS offline Vision helper, no API key, no database or broker
  - engine switch: the page sends `engine` ('rapidocr' default via
    `scripts/portfolio_snapshot_rapidocr.py`, cross-platform, needs `pip install rapidocr
    onnxruntime` in the server's Python; 'apple-vision' stays selectable and is the server's
    fallback when RapidOCR is not installed). RapidOCR answers with reviewProtocol 2: rows from pixel `rowBands`
    and every numeric cell adopted only on 3x/4x agreement whose sign matches the pixel
    `leadingDash` and whose read pixels (`readBbox`) stay inside the requested crop.
    RapidOCR is offered only when its bundled models match the pinned SHA-256; recognition
    never downloads. Vision (protocol 1) rereads every legal numeric value in its own cell
    (agreement confirms; an agreed reread that contradicts the first read leaves the value
    unknown with both readings, as does DAILY P&L; no agreement is flagged unchecked). Cash keeps
    its first reading, problem and corrections in the batch confirmation. Validation §20-§22
  - original screenshots under `Portfolio SC/` and real goldens/results under
    `tests/private_portfolio_snapshot/` are private and ignored; never commit them
  - read `CODE PLAN/PORTFOLIO_SCREENSHOT_OCR_PLAN.md` and its validation record;
    P0/P1 UI acceptance is distinct from OCR correctness; v2 matches the current
    single-image golden, but other images/layouts are not thereby verified
  - v2 short-code corrections require aligned 2x/3x crop agreement; retain the
    first reading and both rereads, never add a ticker substitution dictionary
  - expanded combos use indentation/atomic-contract structure, not a fixed strategy
    name/leg-count list; parents never enter positions, peers close groups, collapsed
    or ambiguous groups stay unresolved. Extend the structure regression suite
    whenever changing these rules; do not infer missing legs or expected leg counts

- `index.html`
  - shared portfolio shell
  - supports live and historical workspaces via query params
  - loads ordered global scripts; load order matters

- `chart_lab.html`
  - experimental daily K projection page
  - reuses the main app state
  - has its own `js/chart_lab.js` rendering and socket lifecycle
  - requires `ib_server.py` for `request_historical_bars`

- `cost_basis.html`
  - standalone blended-cost ledger for one underlying at a time
  - loads ledger/import/page scripts plus DOM-free `american_binomial.js`,
    `market_curves.js`, and `cost_basis_stress_{models,core,band,worker}.js`;
    never the trading shell. Read `CODE PLAN/STRESS_KERNEL_REFACTOR.md` before
    changing stress valuation. Do not derive stress P&L from the per-share cost.
  - reads TWS positions through the existing
    `request_portfolio_positions_snapshot` /
    `request_portfolio_avg_cost_snapshot` actions and writes its own
    `cost_basis.db`; it cannot trade. Its one market-data stream is the open
    stock ledger's own underlying quote (`subscribe_cost_basis_underlying_quote`):
    the backend derives the contract from the book, shares the pooled TWS line
    and drops it when the page switches ledgers or disconnects
  - loads `js/cost_basis_common.js` first: the shared action catalogue and
    ledger routing (`OptionComboCostBasisCore.ALLOWED_CLIENT_ACTIONS` is
    derived from it). It lists and computes STK ledgers only: a FOP ledger
    (a FUT ledger with FOP metadata) is sent to `cost_basis_fop.html`, and a
    legacy FUT ledger without FOP metadata shows its identity and the reason,
    and can only be exported (raw rows) or deleted whole; nothing computes or
    writes it. The stock core, importer and store carry no FUT/FOP/ROLL branch
    any more (plan §13.3 P6): `computeLedger`, `buildReconciliation`,
    `buildExecutionImport` and the importer's `parse` refuse a FUT ledger

- `cost_basis_fop.html`
  - standalone FOP ledger, built in phases by
    `CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md`; the phase record is
    `CODE PLAN/COST_BASIS_FOP_VALIDATION.md`
  - loads, in order, `js/cost_basis_common.js`, the FOP statement importer
    (`js/cost_basis_import_common.js`, `js/cost_basis_fop_import.js`), the FOP
    core `js/cost_basis_fop_core.js`, the DOM-free `js/cost_basis_fop_quotes.js`
    (one-shot quote batches valued mid -> one-sided -> dated reference ->
    unavailable, plan §10.3), `js/cost_basis_fop_messages.js` (every stable
    problem code in Chinese with its next step; the code and original stay),
    `js/cost_basis_fop_view.js` (every panel as data),
    `js/cost_basis_fop_forms.js` (manual entries previewed before they are
    confirmed, voids, cycle boundaries, binding adoptions from broker evidence,
    the in-memory delivery preview) and `js/cost_basis_fop_reconcile.js` (TWS
    positions against the ledger, reconciliation snapshots, a statement's
    realized P&L beside the ledger's), `js/american_binomial.js`,
    `js/market_curves.js` and the DOM-free stress module
    `js/cost_basis_fop_stress.js`, then its controller `js/cost_basis_fop.js`
    and `js/cost_basis_fop_stress_worker.js` (a plain tag; it runs only as a
    worker): never the stock ledger core, the stock stress kernel or the
    trading shell
  - the stress view follows `CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md`: each
    option priced off its own bound future (American CRR on a future, or
    Black-76), implied volatility from synced mids only, F <= 0 before expiry
    stops the model (no epsilon), change exactly 0 at the anchor and the total
    equal to the core's replay with the scenario's settlements. It runs in the
    worker, writes nothing and reads only the quote batch and the cached
    discount curve (`request_cost_basis_fop_discount_curve`, both servers,
    never a refresh, read for every run; a curve the backend answers as
    `cache_fallback` is refused). Anchors (bound futures the ledger does not
    hold) never move the ledger's marks, lowest level or sync window; the
    stress view reads `quoteState.stress`, one sync window over the batch. `tests/fixtures/cost_basis_fop/stress_vectors.json` holds
    its vectors, whose numbers come from hand working and the independent
    model `tests/helpers/cost_basis_fop_stress_model.py`, never from the
    module
  - routes ledgers (a stock ledger goes to `cost_basis.html`, a legacy FUT
    ledger shows its identity) and shows a FOP ledger in full from its exported
    graph; it sends only the catalogue's 'fop' actions (reads, one quote batch
    at a time, the cached discount curve for the stress view, the ledger
    account's own TWS positions, FOP packages, metadata commits and
    reconciliation snapshots), never an order, exercise or subscription. Its
    writes are disabled while the status says
    `writesReleased` is false (the backend's `[cost_basis] fop_writes_enabled
    = false`), every write is previewed and sent as the
    previewed request, and every answer is checked against the ledger, reload
    and version it was asked for. Possible duplicates of stored fills stay
    blocked until a person decides them with the check they rest on; the
    store checks each decision and keeps it in the import's answer. A stored
    unresolved binding that a later statement proves is offered for an
    explicit adoption (a server credential, one metadata commit), never
    adopted silently
  - `scripts/verify_cost_basis_fop_randomized.py` is the seeded release
    campaign (generated trades -> test-only statement writer -> the page's
    importer -> temporary store -> core, held to the rational model);
    `tests/cost_basis_fop_randomized_test.py` keeps a fixed slice of it
  - browser checks run `scripts/cost_basis_fop_browser_assertions.js` in the
    page against `scripts/cost_basis_fop_synthetic_backend.py` (127.0.0.1, a
    temporary database, a simulated broker; it refuses port 8765 and serves a
    blank root page that points the ledger pages at itself)
  - the frozen contract (DDL draft, protocol, core output) lives in
    `tests/fixtures/cost_basis_fop/contract/`; `node tests/run_cost_basis_fop.js
    --stage <P>` runs the phase suites
  - its economic core is `js/cost_basis_fop_core.js` (DOM-free): it replays the exported ledger graph and
    must keep reproducing `tests/fixtures/cost_basis_fop/core_vectors.json`,
    whose numbers come from the plan and the independent rational model
    `tests/helpers/cost_basis_fop_model.py`, never from production code
  - its statement importer is `js/cost_basis_fop_import.js` (DOM-free): it reads Activity and Flex CSVs
    through the shared lexical layer `js/cost_basis_import_common.js` (also
    used by the stock importer; only lexical tools belong there) and builds
    the exact import request the store checks. Row types and their status
    live in `cost_basis_fop_capabilities.json`; every economic row type is
    `synthetic_only` until a de-identified real statement accepts it (plan
    §9.7), so tests that write statement rows stand in with
    `cost_basis_fop_test_support.verified_capabilities()`

- `workspace_db_admin.html`
  - standalone, loopback-only admin page for the workspace database and its
    archive shards
  - loads `js/workspace_db_admin.js` plus the DOM-free
    `js/workspace_db_admin_core.js`; never the trading shell
  - speaks the `portfolio_admin_ws.py` protocol; responses never carry paths,
    SQL, or payloads

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
- historical replay workspace: `start_historical_replay_mac.command` (auto-starts the shared options-chain-service when it is down)
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
- Type checking (pilot): the scripts listed in `tsconfig.json` start with `// @ts-check` and carry JSDoc types checked under TypeScript `strict`; `tests/run.js` runs `tsc --noEmit` over them (`npm install` once for the dev-only compiler). Nothing is emitted, so never add a build step or `.ts` source for a page. Keep a checked module at zero errors; a `/** @type {T} */ (expr)` cast states an invariant the checker cannot see, so say which in a comment. Cross-script globals they consume are typed in `types/globals.d.ts`; a module joins by adding `// @ts-check` and its path to `tsconfig.json`, without changing runtime code.

## Backend Notes

- Live / shared backend entry point: `ib_server.py`
  - starts IB connection in the background
  - can still serve historical replay and chain-service daily-bar fallback when TWS/Gateway is unavailable
  - handles live subscriptions, futures/stock hedge subscriptions, portfolio avg-cost updates, managed accounts, combo execution, Chart Lab daily bars, and IV term-structure sync

- Historical replay-only backend entry point: `historical_server.py`
  - binds to `127.0.0.1`
  - supports `request_historical_snapshot`
  - returns empty `portfolio_avg_cost_update`
  - does not provide live subscriptions, execution, Chart Lab bars, or IV term-structure sync

- Historical data access is mainly through `historical_data.py` and `historical_replay_service.py` (options-chain-service HTTP + strict as-of yield_curve JSON; local rates.db is a legacy fallback).

- Persistence and ledger modules are mounted by BOTH backends and must keep
  identical response shapes on each:
  - `portfolio_store_ws.py` / `portfolio_store.py` for the SQLite workspace store
  - `portfolio_admin_ws.py` / `portfolio_archive.py` / `portfolio_maintenance.py`
    for the archive layer; every maintenance path must hold the cross-process
    guard in `portfolio_maintenance.py`
  - `cost_basis_ws.py` / `cost_basis_store.py` for the blended-cost ledger, with
    the standalone FOP ledger in `cost_basis_fop_store.py` (mixed into the
    store), `cost_basis_fop_domain.py` (pure rules), `cost_basis_fop_schema.py`
    (frozen message types from `cost_basis_fop_protocol.json`, which must stay
    equal to the contract fixture), `cost_basis_fop_broker.py` (read-only
    contract resolution and one-shot quote evidence for a ledger's own
    contracts; ib_server injects the adapter, historical_server has none) and
    `cost_basis_fop_statement.py` (the server's own
    reading of statement rows for capabilities, manual claims and statement
    binding credentials). FOP writes are open in both servers since the
    plan's release stage (P6); `[cost_basis] fop_writes_enabled = false` in
    `config.ini` closes them again (an unreadable value keeps them closed).
    Statement rows still write only for `real_verified` row types, and no row
    type is verified yet, so CSV rows import only as manual claims. The
    schema migration (v12) takes a verified copy of `cost_basis.db` before it
    changes anything
- Both `websockets.serve` calls must share the explicit
  `[server] max_ws_message_bytes` size. The library's 1 MiB default would
  1009-close a socket that is also carrying order supervision.

## Agent Workflow Guidance

- Before changing startup behavior, read the scripts in `powershell_scripts/` plus the macOS/POSIX wrappers.
- If a task mentions Python resolution problems, debug the existing launcher chain before debugging `PATH`.
- If a task touches product-family behavior, read `js/product_registry.js` first.
- If a task touches pricing, date semantics, or replay valuation, read `js/pricing_context.js`, `js/pricing_core.js`, and `js/valuation.js`.
- If a task touches delta hedging semantics, read `DELTA_HEDGE_CURRENT_STATE.md` for the behavior map, then `js/delta_hedge_logic.js` and `js/delta_hedge_ui.js`.
- If a task touches chart or projection semantics, read both the main charting files and `js/chart_lab.js`.
- If a task touches historical replay, check whether the change belongs in `historical_server.py`, `historical_replay_service.py`, or the shared live frontend flow via `js/ws_client.js`.
- If a task touches IV term structure, read `iv_term_structure.html`, `js/iv_term_structure.js`, `js/iv_term_structure_core.js`, `iv_term_structure_service.py`, and the IV sections in `ib_server.py`.
- If a task touches runtime logs or pid files, use or update `scripts/cleanup_runtime_logs.py`; do not clean data directories such as `Portfolio/`, `Portfolio 2/`, or `sqlite_spy/` as part of log maintenance.
- If a task touches ANY broker-facing flow, read `EXECUTION_SAFETY_CONTRACT.md` first. The one-time execution-plan token in `trade_execution/safety.py` is the boundary that stops a stale or altered preview from reaching TWS; do not add a submit path that bypasses it.
- If a task touches workspace persistence or the archive, read `CODE PLAN/PORTFOLIO_SQLITE_PERSISTENCE_PLAN.md` and `CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md` for the frozen semantics; both are implemented, and the admin plan's `Rehydrate Original` constraint still applies.
- If a task touches the blended-cost ledger, read `CODE PLAN/COST_BASIS_LEDGER_PAGE_PLAN.md` first. Two invariants there are not negotiable: the ledger is the source of truth and a TWS snapshot only ever *detects* a gap (nothing auto-writes an event), and an assignment row's cash is the share delivery only, because the premium was already recorded when the contract was opened.
- If a task touches stock splits or option adjustments in the ledger, read `CODE PLAN/COST_BASIS_CORPORATE_ACTIONS_PLAN.md` §15 first: a split is one group (`split` header plus `option_split` rows) written and voided only whole, proven by the store after every write, and option identities are resolved per split epoch.
