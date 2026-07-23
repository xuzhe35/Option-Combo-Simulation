# Option Combo Simulator

## What This Repo Is

Option Combo Simulator is a local browser workspace for building, pricing, replaying, monitoring, and optionally executing multi-leg option structures.

The repo currently has three frontend surfaces:

1. `index.html` - main portfolio workspace
2. `chart_lab.html` - shared workspace plus experimental daily-bar projection
3. `iv_term_structure.html` - standalone live ETF / futures-option IV term-structure monitor

It also has two optional Python WebSocket backends:

- `ib_server.py` for live IBKR market data, combo execution, Chart Lab bars, IV term-structure sync, and shared historical fallback paths
- `historical_server.py` for historical replay snapshots only (chains via the shared options-chain-service)

There is no frontend build step. The UI is plain HTML/CSS/JavaScript loaded in ordered global-script form.

## Current Shipped Capabilities

- Live workspace and historical replay workspace in the same shared shell.
- Multi-group portfolio editing with:
  - collapsible groups
  - group reordering
  - per-group include/exclude from global totals
  - optional live-data toggle per group and hedge
  - input-driven Straddle templates that create the entered expiration and
    strike immediately; live subscription reports missing contracts afterward
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
  - partial close by complete strategy units while preserving leg ratios and realized P&L
- Cost-tracking helpers:
  - per-group portfolio average-cost sync
  - per-group and global TWS leg/quantity checks against the selected account
  - assignment / exercise conversion into deliverable underlying legs
  - execution-report fill attribution back into entry cost or close price
- Product-aware pricing controls:
  - typed Discount / Forward / Carry infrastructure (`r`, `F`, and `r-q` are separate)
  - discount-aware Forward Carry panel for cash-settled index options
  - Futures Pool panel for FOP underlyings
  - unified daily SOFR-short-end / Treasury-long-end discount snapshot with an explicit manual-rate fallback
  - product-specific price precision and combo tick increments
- Portfolio visuals:
  - per-group and global P&L charts
  - per-group and global amortized analysis
  - probability analysis
  - group-level live P&L and delta summaries when available
- Delta Hedge:
  - portfolio Delta aggregation for included groups and existing hedge rows
  - STK / FUT hedge recommendations with target Delta and tolerance controls
  - broker preview / what-if, manual submit, cancel, and clear flows
  - optional auto-preview / auto-submit supervisor behind live hedge-order gates and risk limits
- Historical replay:
  - historical entry date plus replay date timeline
  - separate simulation date in historical mode
  - replay-day trigger preview / simulated submit
  - `Enter @ Replay Day`
  - optional auto-close-at-expiry settlement
  - `Settle All Groups`
- Chart Lab:
  - daily candle chart
  - latest price overlay
  - one-group or included-global projection
  - IB daily bars with chain-service fallback through `ib_server.py`
- IV Term Structure:
  - standalone ETF / futures-option monitor
  - per-symbol sync/update from IB
  - ATM call/put IV aggregation by expiry
  - live lambda-independent cumulative `Total Var` (`W×10,000`) and adjacent-expiry `Fwd Var` (`(W₂−W₁)/(T₂−T₁)×10,000`) side by side; every W point is numerically inverted from the real two-sided ATM Call+Put BBO midpoint straddle and never falls back to vendor IV; cumulative drops and negative forward intervals are highlighted as hard inversion candidates
  - TWS calendar-day Call/Put IV plus TD IV re-annualized on the last manually calculated price-derived implied-λ curve; the visible scalar (default `0.30`) is fallback-only until a calculation is available, directly covered closures use their own weights, and the display explicitly extrapolates the curve median to later closures
  - per-weekend implied λ solved on demand through a three-tier source chain: a complete coherent two-sided ATM straddle snapshot is preferred, incomplete TWS evidence falls back to an atomic subset of usable BBO expiry pairs, and a final audited `vendor_iv` estimate uses the visible ATM Call/Put IV pairs when books are missing. Signed inversion values are preserved instead of clipped, and later weekly intervals may use explicitly marked nearest-baseline extrapolation. The result is frozen in the UI, then explicitly synced to same-origin simulators or exported as a V2 date array
  - configurable DTE buckets
  - per-symbol JSON history files
- Session persistence:
  - JSON import / save / save-as
  - direct save-back when the browser File System Access API is available

## Main Entry Points

### `index.html`

This is the main portfolio workspace.

It supports:

- live IBKR mode
- Historical replay mode (options-chain-service backed)
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
- the chain-service daily-bar fallback is also served through `ib_server.py`
- `historical_server.py` does not implement the bar endpoint

If you want Chart Lab bars, run `ib_server.py`, even if you only need the chain-service fallback path.

### `iv_term_structure.html`

This is a standalone live IV term-structure monitor.

Current behavior:

- loads the official calendar/date helpers, product registry, strict implied-λ handoff, IVTS core, and page runtime in that order
- reads `iv_term_structure/iv_term_structure_config.json`
- falls back to embedded defaults if the config file cannot be loaded
- loads bundled history files from `iv_term_structure/data/*.json`
- uses `ib_server.py` for IB connection status and live IV sync
- appends samples to an opened/imported per-symbol history JSON document
- can load/resume an existing per-symbol `*.ivts-auto.json` as the explicit
  append target, or create a new one; a due ATM snapshot is appended
  immediately, then hourly while the page remains open — elapsed time is the
  only thing that makes a sample due, so reopening a page that sat idle for
  days appends once, not once per missed day; automatic samples are combined
  with manual history for MRR while the raw hourly rows remain preserved

Default configured symbols:

- `SPY`
- `QQQ`
- `GLD`
- `SLV`
- `USO`
- `CL`
- `SI`
- `ES`

## Backend Responsibilities

### `ib_server.py`

Current responsibilities include:

- background IB connection lifecycle
- live underlying / option / futures / stock-hedge subscriptions
- optional option Greeks via IB generic tick `106`
- managed account snapshots for live order routing
- portfolio average-cost snapshots
- combo validation / preview / test-submit / submit
- authoritative account-level `ib.positions()` snapshots for leg existence checks, close validation, and pre-submit netting warnings; `updatePortfolioEvent` remains the separate average-cost/valuation feed
- delta hedge validation / preview / submit / cancel
- managed repricing supervision
- close-group execution
- execution-status and execution-fill fan-out back to the browser
- historical replay snapshots through `HistoricalReplayService`
- historical daily bars for Chart Lab, with chain-service fallback when IB bars are unavailable
- IV term-structure option-chain discovery and live option subscriptions
- IB connection-status and manual connect messages

`ib_server.py` starts the IB connection in the background so the process can still serve replay and fallback paths even if TWS / Gateway is not available.

Live market-data streams are pooled by qualified contract id. A second subscription for an already-streaming contract reuses the existing ticker; if a later subscriber needs extra generic ticks such as option Greeks tick `106`, the stream is reopened once with the merged tick list. Manual `sync_underlying` requests use the same pool and cancel one-shot lines when no active subscription shares the contract.

ES/NQ daily and weekly FOP requests deliberately omit a browser-derived
`tradingClass`; IB's qualified contract is authoritative because the listed
class cannot be inferred safely from weekday alone. A workspace with exactly
one Futures Pool entry automatically binds unbound FOP legs to it. Repeated
identical subscription intents are ignored so UI refreshes do not clear good
quotes or create new market-data generations.

Combo Template Straddles use the expiration and strike exactly as entered. The
dialog does not preflight or rewrite the strike through IBKR, so `Create Combo`
never waits on contract discovery. The normal live subscription reports a
missing contract after creation, at which point the leg can be edited manually.

Contract identity and exact expiry timing use a separate price-free metadata
handoff. A portfolio subscriber therefore receives the qualified conId and
ContractDetails timing immediately even when IVTS already owns the pooled
ticker and no new BBO tick follows. Metadata-only messages never refresh feed
health or overwrite price/IV fields. Incomplete ContractDetails results are not
positive-cached: a later subscription retries them, while concurrent requests
for the same conId share one in-flight lookup.

### `historical_server.py`

This is the lightweight historical replay server. Since 2026-07 it no longer
reads a bundled SQLite copy: option chains and underlying daily bars come from
an external **options-chain-service** over HTTP (default
`http://127.0.0.1:8750`). That service is deliberately swappable — see
[Pointing at a different chain service](#pointing-at-a-different-chain-service).
Discounting uses the same dated JSON repository under `yield_curve/data/` as
the live backend, selected strictly latest-on-or-before the replay date. The
small `sqlite_spy/rates.db` Treasury history is compatibility-only: it is
adapted as a visibly degraded proxy only when no dated JSON snapshot exists.

Current responsibilities:

- `request_historical_snapshot`
- empty `portfolio_avg_cost_update` responses for historical mode

The chain service must be running for replay to work; the start scripts probe
`/health` and launch it automatically when it is down.

Important boundaries:

- binds to `127.0.0.1` only
- ignores non-loopback `server.ws_host` values
- does not provide live subscriptions
- does not provide live execution
- does not provide Chart Lab daily bars
- does not provide IV term-structure sync

## Startup

### Windows

User-facing wrappers:

- `start_option_combo.bat`
- `start_historical_replay.bat`
- `update_yield_curve.bat`
- `install_ib_bridge_deps.bat`
- `cleanup_logs.bat`

These call PowerShell implementations in `powershell_scripts/` where needed.

Important PowerShell entry points:

- `powershell_scripts/start_option_combo.ps1`
- `powershell_scripts/start_historical_replay.ps1`
- `powershell_scripts/update_yield_curve.ps1`
- `powershell_scripts/start_option_combo_codex.ps1`
- `powershell_scripts/launch_ib_server_codex.ps1`
- `powershell_scripts/restart_option_combo_codex.ps1`
- `powershell_scripts/restart_ib_server_codex.ps1`
- `powershell_scripts/start_ib_server_server_template.ps1`
- `powershell_scripts/resolve_python.ps1`
- `powershell_scripts/python_launcher_common.ps1`

### macOS / POSIX

- `start_option_combo_mac.command`
- `start_historical_replay_mac.command`
- `update_yield_curve_mac.command`
- `start_option_combo.sh`
- `install_ib_bridge_deps_mac.command`
- `cleanup_logs_mac.command`

The macOS/POSIX launchers prefer `OPTION_COMBO_PYTHON`, `config.local.ini`, `.venv`, and `venv`, then fall back to versioned `python3` commands.

## Runtime Log Cleanup

Launcher logs and pid files now live under `logs/` and are ignored by Git.
Use the cleanup helper periodically to keep debug logs small:

```bash
./cleanup_logs_mac.command --dry-run
./cleanup_logs_mac.command
```

On Windows:

```bat
cleanup_logs.bat --dry-run
cleanup_logs.bat
```

By default the helper removes matching `http_server` / `ib_server` logs and stale pid files older than 14 days.
It also scans legacy runtime artifacts that may still be sitting at the project root from older launcher versions.

Useful options:

- `--keep-days 7` keeps only the last week
- `--all` removes all matching runtime logs and stale pid files
- `--dry-run` previews the cleanup
- `--include-active-pid` also removes active pid files and matching codex logs

The cleanup script is intentionally narrow. It does not touch portfolio folders, SQLite data, config files, source files, or IV history JSON.

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
- `http://localhost:8000/iv_term_structure.html`

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
- chain-service fallback bars for Chart Lab
- IV term-structure sync
- historical replay snapshots served by the shared backend

### Frontend + historical replay-only backend

```powershell
$PYTHON = powershell -NoProfile -ExecutionPolicy Bypass -File .\powershell_scripts\resolve_python.ps1
& $PYTHON historical_server.py
```

Use this when you only need replay snapshots for the main workspace and do not need Chart Lab bars, IV term-structure sync, or live execution.

Replay data requires the options-chain-service to be running (default
`http://127.0.0.1:8750`; bundled layout is `Options DB/chain_service`:
`python3 chain_server.py`). The `start_historical_replay` launchers
(.bat/.ps1 and `start_historical_replay_mac.command`) probe `/health` and
start it automatically; when starting `historical_server.py` by hand, start
the chain service yourself first.

## Python Resolution

Do not assume bare `python` is reliable on Windows.

Windows PowerShell launchers resolve Python in this order:

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

Do not commit personal filesystem paths into tracked config files. Use `config.local.ini` for machine-local Python overrides.

## WebSocket and Config Notes

### Live backend

`ib_server.py` reads these settings from `config.ini`:

```ini
[tws]
host = 127.0.0.1
port = 7496
client_id = 999

[server]
ws_host = 127.0.0.1
ws_port = 8765

[execution]
managed_reprice_threshold_default = 0.01
managed_reprice_interval_seconds = 2.0
managed_reprice_max_updates = 12
managed_reprice_timeout_seconds = 600

[iv_term_structure]
catalog_timeout_seconds = 75
```

`catalog_timeout_seconds` bounds IB contract/option-chain discovery for a sync
request. On expiry the browser gets an error naming the market-data (2104) and
sec-def (2158) farms instead of stalling. Raise it when a slow sec-def farm makes
wide FOP chains legitimately overrun, but keep it under the browser's own 90s
backstop — past that the client gives up first and reports no cause. Values below
1s are floored.

Optional historical data overrides:

```ini
[historical]
chain_service_url = http://127.0.0.1:8750
chain_service_dir = ../../Options DB/chain_service
rates_sqlite_db_path = sqlite_spy/rates.db
```

#### Pointing at a different chain service

The options-chain-service lives outside this repo and is meant to be replaced —
by a copy at a new path after moving the project, or by a different vendor's
feed. Nothing in the code hardcodes where it is; `chain_service_config.py`
resolves it, and everything downstream talks HTTP.

Two independent knobs, each resolved as **env var → `config.ini` → default**:

| Setting | Env override | Meaning |
| --- | --- | --- |
| `chain_service_url` | `OPTION_COMBO_CHAIN_SERVICE_URL` | Where to talk to the service. The only one that matters at runtime. |
| `chain_service_dir` | `OPTION_COMBO_CHAIN_SERVICE_DIR` | Where its `chain_server.py` lives, so the replay launchers can start it for you. Relative paths resolve against this repo, not your shell's cwd. **Leave empty when the service is remote** and not ours to start. |

Common cases:

```bash
# Moved either project: pin an absolute path (or a new relative one).
chain_service_dir = /Users/you/projects/Options DB/chain_service

# Bought a vendor feed: point the url out, and blank the dir so the launchers
# stop trying to start a local server that no longer exists.
chain_service_url = https://vendor.example/v2/chains
chain_service_dir =

# Try a provider for one run without touching tracked config:
OPTION_COMBO_CHAIN_SERVICE_URL=https://vendor.example/v2/chains \
  ./start_historical_replay_mac.command
```

Check what the stack will actually use:

```bash
python3 chain_service_config.py --url
python3 chain_service_config.py --dir     # empty output means "remote"
```

Important distinction:

- `tws.host` / `tws.port` tell `ib_server.py` how to reach TWS or IB Gateway
- `server.ws_host` / `server.ws_port` tell the browser how to reach the backend

`server.ws_host` may be a comma-separated list in `ib_server.py`, so one backend can listen on loopback plus a LAN or Tailscale address at the same time.

### Historical backend

`historical_server.py` reuses `server.ws_port`, but normalizes the bind host to `127.0.0.1` regardless of non-loopback config.

### Browser-side endpoint controls

- `index.html` exposes WebSocket host and port controls
- `iv_term_structure.html` uses the same `optionComboWsHost` and `optionComboWsPort` localStorage keys
- `chart_lab.html` currently exposes only the port control and connects to `127.0.0.1`

## Forward / Carry / Discount Curves

The pricing runtime treats three related quantities as different types:

- **Discount curve `r(T)` / `D(T)`**: continuously compounded zero-rate proxy
  and discount factor, used only for present-value discounting.
- **Forward curve `F(T)`**: outright forward/futures level. For INDEX options it
  comes from discount-aware call-put parity; for FOP legs the bound live futures
  quote remains the direct source.
- **Carry curve `b(T)=r(T)-q(T)`**: derived from spot and forward via
  `ln(F/S)/T`. It moves spot to an expiry-specific forward; it is never reused
  as the Black-76 discount rate.

`js/market_curves.js` enforces these types at runtime and rejects substitutions
such as passing a Carry observation where a Discount observation is required.
Discount factors interpolate log-linearly, forwards interpolate in log-price,
and carry rates interpolate linearly. Resolution is bounded and carries source,
as-of, snapshot, staleness, and quality metadata.

### Unified daily SOFR / Treasury reference curve

`yield_curve/` is the single rate-source boundary. Its standalone updater
downloads official New York Fed SOFR and official Treasury CMT inputs, builds
one canonical `D(T)` snapshot, and atomically writes dated JSON plus
`yield_curve/data/latest.json`. Neither Python backend contains source download
logic or an hourly rate-refresh loop. If the file is missing or older than the
current New York market date, a backend may start the independent updater once;
network failure retains the prior complete file.

Curve policy:

- through 30 calendar days, latest overnight SOFR is held flat as an explicit
  short-end proxy and converted from simple ACT/360 to continuous ACT/365F;
- from day 30 to the first Treasury node after it (normally 46 days), the
  instantaneous forward rate transitions with a smoothstep, avoiding a model-
  generated 30-day kink;
- later tenors retain the Treasury CMT proxy forward slope while remaining
  anchored to the SOFR discount level at day 30.

The 30/90/180-day SOFR Averages are backward-looking realized compounded
statistics. They are saved as diagnostics only and never become future tenor
nodes. Treasury publishes **CMT par yields**, not a daily zero/OIS curve, so
the long end also remains visibly labelled as a proxy. Canonical interpolation
uses `-ln(D)`, not nearest-tenor rates.

Main, Chart Lab, and IVTS consume the same `snapshotId`. Historical replay uses
only a dated JSON snapshot on or before its replay date. For dates not yet
backfilled, a legacy Treasury-only `rates.db` curve is adapted as one degraded
snapshot; its scalar compatibility rate is derived from that same curve.

User controls:

- Leave **Use unified daily SOFR / Treasury curve** enabled for the default.
- **Discount Rate Fallback r (%)** stays editable. It is used only if the curve
  is disabled, unavailable, stale, outside supported tenor bounds, or invalid.
- For INDEX products, add coherent call/put Forward Carry samples at the
  expiries you price. The row shows `F`, discount `r`, and carry `r-q`
  separately. Live samples older than two minutes are not used.
- For FOP products, bind every option leg to the correct Futures Pool contract;
  that futures quote supplies `F`, while the unified curve/manual `r` supplies
  discounting.

Product routing is intentionally explicit:

| Product | Pricing Forward | Carry / curve observation | Discount |
|---|---|---|---|
| SPX / NDX | same-expiry option put-call parity | parity `ln(F/S)/T` | USD curve `r(T)` |
| ES / MES | each leg's bound ES/MES future | exchange futures curve; SPX is an optional diagnostic reference only | USD curve `r(T)` |
| NQ / MNQ | each leg's bound NQ/MNQ future | exchange futures curve; NDX is an optional diagnostic reference only | USD curve `r(T)` |
| CL / HG | each leg's bound commodity future | actual exchange futures curve | USD curve `r(T)` |
| GC / SI | each leg's bound metal future | actual exchange futures curve | USD curve `r(T)` |
| Generic stock / ETF | spot BSM | explicit legacy `q=0` model fallback | USD curve `r(T)` |

The browser exposes the structured observation through
`OptionComboWsLiveQuotes.getForwardCarrySnapshot()`. Read `points[].forwardPrice`
as the executable pricing input and inspect `futuresPoolEntryId`, `contractMonth`,
`expiry`, `quoteAsOf`, `currency`, `source`, and `quality` for provenance. For
ES/NQ families, `points[].carryRate` is published only when the bound future and
SPX/NDX reference are both fresh, within 120 seconds of each other, and an exact
futures expiry is known. Otherwise the outright futures curve remains usable,
`carryRate` is `null`, and `carryQuality.flags` explains why. Reference quotes
never alter Black-76 pricing or portfolio P&L. Every FOP family also exposes
adjacent-contract `intervalLogForwardChange`, per-day `intervalLogSlope`, and
`annualizedRollSlope`; these remain `null` unless both contracts have exact IB
expiry dates and fresh, mutually coherent timestamps, so a bare YYYYMM label
or asynchronous stale quotes are never converted into a guessed tenor.

A futures `contractMonth` is always the **delivery** month, taken from
`ContractDetails.contractMonth` and tagged `contractMonthSource:
'ib_contract_details'`. It is never derived from the qualified last-trade date,
because for energy, metals, and ags the expiry leads delivery — CL Sep 2026
stops trading on 2026-08-20, so that date's leading six digits say `202608`. If
IB does not return the delivery month, the payload still carries a date-derived
`contractMonth` tagged `contractMonthSource: 'last_trade_date'`, and the browser
rejects the quote as `futures contract month unverified` rather than comparing
against a month it cannot trust.

Relevant config in `config.ini [yield_curve]`:

```ini
data_dir = yield_curve/data
auto_update_if_missing = true
auto_update_if_stale = true
source_timeout_seconds = 20
process_timeout_seconds = 60
```

Daily maintenance and inspection:

- Windows: double-click `update_yield_curve.bat`.
- macOS: double-click `update_yield_curve_mac.command`.

Both launchers resolve the same configured/project virtual-environment Python
used by the application, perform one update from the official sources, then
print the current local snapshot status. Their terminal stays open after an
interactive double-click so the source status or error remains visible. No API
key is required. A failed official-source request does not overwrite the last
complete snapshot. The manual launcher deliberately refreshes even if an
earlier snapshot exists for the date, so a morning run can be replaced after
the official sources publish newer observations.

The equivalent manual commands are:

```bash
.venv/bin/python -m yield_curve update
.venv/bin/python -m yield_curve status
```

The `--if-needed` form is the backend's lightweight self-healing path. For
non-interactive launcher automation, set `OPTION_COMBO_NO_PAUSE=1`.

See `yield_curve/README.md` for equations, file layout, fallback ordering, and
source semantics. `scripts/import_treasury_risk_free_rate.py` now exists only
for legacy `rates.db` backfill; it is not the live runtime source.

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
  - `MES`
  - `MNQ`
  - `CL`
  - `GC`
  - `SI`
  - `HG`

Current browser-side behavior:

- equity-style underlyings supported for stock / ETF products
- futures underlyings supported for FOP products
- cash-settled index options do not support underlying legs
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
  - `MES`
  - `MNQ`
  - `CL`
  - `SI`

The frontend registry knows about `GC` and `HG`, but if you are touching live contract-qualification logic, note that those families still need TWS verification before adding backend defaults.

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

## IV Term Structure

Main files:

- `iv_term_structure.html`
- `iv_term_structure.css`
- `js/iv_term_structure.js`
- `js/iv_term_structure_core.js`
- `iv_term_structure_service.py`
- `iv_term_structure/iv_term_structure_config.json`
- `iv_term_structure/data/*.json`

Current flow:

1. page loads config and bundled history JSON
2. user connects/checks IB through `ib_server.py`
3. user syncs one symbol
4. backend resolves option chains and ATM strike windows
5. backend keeps streaming incremental display quotes, but separately emits an
   `iv_term_structure_quote_snapshot` only when the underlying and every
   expected option leg form one complete, real two-sided, time-coherent batch
6. frontend aggregates call/put ATM IV by expiry and DTE bucket for display
7. frontend initially derives TD IV from the fallback `TD IV λ` lens; after a manual straddle calculation succeeds, it re-annualizes the TWS Call/Put IV without resubscribing. One common median implied λ defines the annualization unit, each directly covered closure contributes its own inferred weight, and later uncovered closures use that median as an explicitly marked display-only extrapolation. `TD Slope` is then calculated directly from the displayed ATM TD IV pair, shorter expiry on top. The separate backtested strategy signal remains frozen at λ=0.3
   The expiry table keeps `Total Var`/`Fwd Var` strict by default. **Estimate
   Missing Var** explicitly enables a display-only recovery tier: a missing
   strict row is inverted from the Call/Put marks already used by the visible
   ATM Straddle, including TWS model or last/close fallbacks. Recovered values
   are warm-colored and prefixed with `≈`; strict BBO observations always win.
   `Fwd Var` is calculated only between immediately adjacent expiry rows and
   never silently bridges a still-missing tenor. This display recovery does
   not alter, calculate, or publish the structured implied-λ snapshot.
8. implied λ prefers the complete coherent server snapshot. When TWS has delivered usable two-sided call/put BBOs but omitted one or more callback timestamps/evidence records, the manual calculation instead takes one atomic browser-side observation, skips unusable expiries, and marks the result `best_effort`; wrong futures months and crossed markets remain hard row-level rejections. For each retained BBO expiry, the
   forward comes from discount-aware call-put parity using that expiry's shared
   curve `r(T)/D(T)`, and its observed straddle is numerically inverted to total
   variance. If fewer than two usable BBO expiry pairs survive but at least two
   displayed expiries have finite ATM Call/Put IV, the same manual button can
   form a last-resort `vendor_iv` curve from that frozen screen observation.
   This route is explicitly labeled `vendor_atm_iv_fallback` and
   `best_effort`, never presented as a strict price-derived result, but it is a
   valid synchronized/exported V2 source. A FUT quote may validate
   the parity forward, but ETF/index spot is not treated as `F` and `q=0` is not
   assumed. It is price-derived, but not literally model-free: the inversion
   assumes European Black-76/BSM pricing and a locally stable trading-day
   variance baseline. The strict path uses each expiry's exact ContractDetails
   `expiryAsOf` and splits the interval to the second. Best-effort mode uses
   exact timestamps when available, otherwise reconstructs the standard cutoff
   from the product profile, and finally retains an official exchange-date
   interval if needed. When the listed chain changes from daily to weekly,
   later weekends use the nearest observed pure-trading variance baselines and
   are marked as extrapolated. The synchronized/exported entry preserves
   `estimationMode`, usable/skipped expiry counts, and quote-source provenance
9. pressing `Calculate λ` solves finite signed non-trading intervals into a
   frozen V2 per-date array. Live option ticks only mark the result as having
   newer quotes available; they do not rerun the estimator or redraw the
   calculated structure. `Sync to Simulators` writes that frozen result to all
   same-origin Portfolio/Chart Lab tabs, while `Export JSON` creates a portable
   file.
   Weekends and full exchange holidays receive the same interval λ, while
   `weekendDates`, `holidayDates`, and `nonTradingDateKinds` preserve their
   distinct official-calendar evidence. An unusable option row is skipped in
   best-effort mode; calculation stops only when the retained rows cannot form
   a finite non-trading interval or identity/calendar safety fails. Negative λ
   is an inversion signal and values above 1 are an overweight signal; neither
   is clipped. A projection still fails safely if the combined signed clock for
   a particular live option would become non-positive.
10. user samples into the selected history document, or loads/resumes an
   existing per-symbol auto JSON (or creates a new one) as the hourly append
   target

The JS core and Python service helpers are kept DOM/IB side-effect free for tests.

### Using implied λ in the simulator

1. Restart `ib_server.py` after upgrading (IVTS protocol `20260719.5`), then
   open `iv_term_structure.html` and sync the same symbol and, for FOPs, the
   same underlying futures contract month used by every FOP leg that will still
   be alive at the simulation target. Confirm the
   header shows a dated `SOFR/CMT reference curve`; `Fallback r%` is used only when a
   curve point cannot be resolved. `TD IV fallback λ` never feeds the
   implied-λ estimator; it is used only before a qualified implied curve is
   available. After that, the price-derived curve feeds back into TD IV and
   the curve median is visibly extrapolated for display horizons beyond direct
   coverage. The simulator remains strict by date and does not consume those
   extrapolated display weights. After a frontend upgrade, hard
   refresh every already-open IVTS, Portfolio, and Chart Lab tab once; restarting
   only the backend does not replace JavaScript already running in a tab.
2. Wait until the card reports either `Strict coherent source ready` or
   `Best-effort ready`, press **Calculate λ**, and inspect the frozen
   structured dates, coverage, median, source id, usable/skipped expiry count,
   and timestamps in the card.
   New option ticks do not recalculate it; the card only reports that newer
   quotes are available. Press **Sync to Simulators** to update same-origin
   Portfolio/Chart Lab tabs, or **Export JSON** to create a portable file. The default
   limit is 20 option streams (10 paired expiries); raise it when the target
   simulation crosses a weekend beyond the displayed coverage.
3. In `index.html` or `chart_lab.html`, select `Weighted weekends (λ)`, keep the
   default-enabled `IVTS implied λ per weekend` checked, and verify the status says coverage is
   complete for every required non-trading date, with the expected
   symbol/month, current live quote date, and V2 straddle source. The explicit
   Sync action updates every same-origin tab; "same origin" means the exact same scheme,
   host, and port (`localhost:8000` and `127.0.0.1:8000` are different origins).
   `Export λ` / `Load λ File` is for another origin or machine. Each export carries a `symbol[#futuresMonth]@quoteAsOf`
   curve id, complete `intervals`/`byDate`, official-calendar provenance, and a
   UTC quote timestamp in the filename so same-day observations stay distinct.
4. Coverage is strict whenever implied λ is enabled. If any open option leg
   that remains alive at the target crosses an unsampled weekend or full-day
   exchange closure between the live quote instant and that leg's expiry, the
   UI lists the missing dates and implied-mode projections stop. The sole
   exception is the explicit `not_required` state: no such still-live leg
   crosses a non-trading date, so no implied-λ observation is needed. Calendar,
   Trading days, an unchecked IVTS box, and the numeric scalar λ are diagnostic
   lenses only and cannot bypass this live projection gate; the array median is
   descriptive and is never extrapolated.

For a live forecast such as "on 7/10, value the calendar at the 7/15 close",
set the simulation date to `7/15`, select `Weighted weekends (λ)`, and enable
the matching fresh IVTS array. A target date that is still in the future but
equals the near leg's expiry means close/settlement: the near leg is intrinsic
and the far leg retains the time from that close to its own expiry. The IVTS
status must confirm complete coverage through every still-open leg's expiry.
If no surviving interval crosses a weekend/full holiday, the explicit
`not_required` state is sufficient; otherwise no scalar-clock choice can
produce a strict live forecast.

### Simulation target instant and expiry cutoff

The simulation date resolves to one portfolio-wide **instant**, not midnight
and not an assumed generic close. The same instant is used for the expiring
near leg and every surviving far leg:

- on the current live trade date with no open leg expiring that day, the target
  is the real `liveQuoteAsOf`; when a near leg expires today, its exact contract
  cutoff remains the target until that cutoff passes, so a same-day expiry
  forecast is not silently replaced by a Now valuation;
- on a future date containing an open expiring option leg, the target is that
  leg's unique last-trade cutoff;
- if no open option expires on the target date, the product-profile cutoff is
  used as the date's reference instant;
- if multiple open legs on the target date have different cutoffs, the
  projection fails as `ambiguous_near_leg_cutoff` instead of averaging them.

For a subscribed option, `ib_server.py` gives priority to IB ContractDetails:
`lastTradeDateOrContractMonth + lastTradeTime + timeZoneId` is converted to an
exact UTC `expiryAsOf`. `realExpirationDate` is retained only as diagnostics
because it can be later than the last trading instant. Live projections are
strict by default: every open leg expiring on the target date, every surviving
FOP/INDEX leg, and every surviving option with at most seven calendar days left
must have contract-source timing. Until those facts arrive, the UI reports
`exact_contract_timing_missing`, lists the affected leg ids, and every payoff/
probability surface fails closed. The following profile times remain only for
historical replay, explicit compatibility mode, or longer-dated stock/ETF legs:

The timing handoff is independent of price ticks, including when a contract is
already pooled by IVTS. A ContractDetails response is cacheable only after it
contains a parseable exact cutoff (and, for FOP, verified underlying binding);
partial responses are retried on a later subscription. Therefore a persistent
`exact_contract_timing_missing` on current code means IB did not provide a
complete cutoff or the qualified identity failed validation, rather than that
the option had only one expiry or its ticker happened to be reused.

| Product family | Profile cutoff fallback |
| --- | --- |
| Equity/ETF, SPX, NDX | 16:00 America/New_York |
| ES, MES, NQ, MNQ | 15:00 America/Chicago |
| CL | 13:30 America/Chicago |
| GC, SI, HG | 12:30 America/Chicago |

These hours are defensive fallbacks, not a replacement for the contract's IB
metadata. At or after a supported same-session settlement cutoff the expiring
leg is intrinsic; before it, a same-day 0DTE leg retains fractional hours. A far
leg is valued at that same target instant with its remaining fractional/
calendar/variance clocks.
This is why a 7/10 forecast for a 7/15 close should select 7/15 as the date;
the runtime supplies the precise close/cutoff hour automatically.

AM special-fixing contracts are an explicit exception to the intrinsic rule.
Standard monthly `SPX` and traditional quarterly AM `ES`/`NQ`/`MES`/`MNQ`
contracts can stop trading before their opening special settlement quotation
is known. When a target reaches one of these contracts, the simulator reports
`deferred_settlement_fixing_unsupported` instead of substituting the screen
index/future at the last-trade cutoff. PM/weekly/EOM classes keep the normal
same-session path. Supporting AM contracts later requires a separately sourced
SET/SOQ scenario variable, not a different choice of `r` or λ.

FOP implied-λ identity is strict `symbol#underlyingContractMonth`. A curve for
`ES#202609` never activates for `ES#202612`, and there is no nearest-month or
scalar fallback while implied mode remains checked. If the still-live FOP legs
requiring λ are bound to more than one futures month, one V2 curve cannot cover
the portfolio (`multiple_futures_months`); align the bindings or evaluate the
month groups separately. Live option quotes are also checked against the
qualified IB `conId/localSymbol/tradingClass/expiry/right/strike`; FOP quotes
must additionally prove their `underConId` and actual underlying futures month.
An identity mismatch invalidates the old quote and contract timing rather than
letting a stale, wrong-month value continue to price the leg.

The bound Futures Pool quote has an independent gate. Every live subscribe
cycle creates a new request generation and opaque wire id; only a qualified
`FUT` with the requested symbol/month/exchange/currency/multiplier (and the
same `conId` when already known) may populate that generation. A resubscribe,
wrong/late generation, identity mismatch, or quote more than 120 seconds from
the live market clock clears the old bid/ask/mark before Black-76 can use it.
The Futures Pool status and row show `pending`/`rejected` reasons, while all
payoff surfaces fail closed as a missing bound future.

INDEX parity samples use the exact common evidence clock as well:
`anchorAsOf=max(call, put, spot quoteAsOf)` and
`T=(ContractDetails expiryAsOf-anchorAsOf)/365 days`. Fractional seconds feed
both `D(T)` and annualized `r-q`; crossed, one-sided, stale, identity-mismatched,
or differently timed call/put evidence immediately clears the prior Carry.
Refreshing happens in the market-data path even while the Forward Carry panel
is collapsed.

The probability charts use that same day-by-day clock for the terminal-price
distribution. Full exchange holidays are treated like weekends, per-date λ
overrides are honored, and missing/stale calendar or implied-λ coverage stops
the simulation instead of falling back silently. A signed negative IVTS λ is
preserved in the horizon total but is not passed to the Worker as an impossible
negative-variance day: it is absorbed into the nearest positive trading
segments, producing nonnegative simulation blocks whose weights sum exactly to
the original signed horizon. A nonpositive aggregate horizon still fails
closed. At each simulated terminal price, equity/ETF
options use BSM while index and futures options use Black-76; variance time and
calendar discount time remain separate.

On the actual expiry date the meaning is different: while a live quote is
still before the contract's last-trade cutoff, the 0DTE leg remains active with
fractional time. `ib_server.py` reads `lastTradeTime` and `timeZoneId` from IB
ContractDetails, caches the resulting UTC cutoff, and sends it with the quote;
the product profile is only a fallback when IB does not provide usable timing.
At the exact current underlier with zero IV shock, the valuation and chart use
the observable live option mark. In the default `Midpoint` live-price mode, a
fresh valid two-sided BBO is also re-inverted with this runtime's own
BSM/Black-76 model, quote-to-expiry exact weighted clock, quote-horizon
Forward, and quote-horizon discount rate. Future target points then hold that
per-leg local BBO-equivalent IV constant. This removes the current-price basis
caused by feeding a TWS IV back through different model inputs.

Live What-If projections now use `projectionConvergenceMode: "strict-bbo"` by
default. Every option leg that is still alive at the portfolio target must
have that fresh valid two-sided midpoint and a successful local IV inversion;
otherwise valuation, main/global payoff charts, Chart Lab, probability and
amortized projections all fail closed. A near leg whose cutoff is at or before
the target is intrinsic and is intentionally exempt. Historical replay is
unchanged. The former live input-IV behavior is available only through the
explicit saved/imported compatibility value `"legacy-input-iv"`; missing or
unknown values normalize back to strict mode.

The option BBO, quote-horizon Forward/spot and live portfolio clock used by a
strict local inversion must be within 30 seconds of one another. This atomic
calibration limit is deliberately tighter than the general 120-second market
quote freshness window because a two-minute skew is material when the far leg
has only hours or minutes left. A breach reports the exact local-anchor status
instead of reverting to TWS/manual IV.

Websocket health is independent of the frozen server quote clock. Disconnects
immediately invalidate strict projections and trigger a redraw; a 5-second
watchdog also marks the feed stale when no market-data payload has arrived for
120 seconds. Stored quotes may remain visible for Live P&L diagnostics, but are
tagged stale and cannot pass the projection gate until fresh data arrives.

Chart Lab's auxiliary websocket is used only for daily bars and its visual live
price overlay. Projection pricing always consumes the main Portfolio websocket
state as one atomic snapshot; the auxiliary price is never combined with the
main socket's BBO timestamps, Forward/Carry, futures quotes, or discount inputs.

The calibration never treats model, last, Portfolio Mark, manual price, a
one-sided book, or an explicitly invalid BBO as a midpoint. A qualifying BBO
whose timestamp, underlying/Forward timestamp, discount input, clock, or
no-arbitrage bounds fail validation stops that leg rather than falling back
silently. Selecting `Portfolio Mark` still controls Live P&L, but it cannot
anchor a strict future projection; select `Midpoint` (or explicitly import a
legacy compatibility session) when running What-If.
This anchor removes today's model basis only—it does not predict future
smile/skew, liquidity, Forward moves, or early-exercise effects.

Calculating a new curve still requires a coherent quote snapshot whose oldest
BBO receipt is no more than 120 seconds old. Once calculated, however, the
structured lambda curve is frozen and has no wall-clock expiry. It remains in
use until the user recalculates, imports another file, withdraws it, changes to
another product/month, or the live exchange trade date no longer matches its
anchor date. Import preserves the original `quoteAsOf` for audit, and explicit
file selection is treated as the user's decision to use that frozen curve.

If IVTS reports a coherent calculation but Portfolio still reports unavailable,
hard refresh both tabs, verify their exact origin and that browser localStorage
is writable, then Sync again. Use Export/Load only when the tabs intentionally
run in different origins or browser contexts.

The optional IVTS auto-history sampler is a separate research clock: one sample
is due after 60 elapsed minutes since the last successful sample, not at the top
of each wall-clock hour, and reopening an overdue file appends at most one row.
Those hourly rows do not extend the 120-second live V2 handoff lifetime.

The current Friday-to-Monday weekend can be identified intraday only when a
real 0DTE straddle is present: subtracting its total variance removes the
remaining Friday session. Without that point, the synthetic anchor-to-first-
expiry interval is shown as `unverified_front` and is not published. A raw λ
outside `[0,1]` is likewise reported, never clipped into the simulator.

For historical diagnostics against the local options database, use the same
straddle/parity inversion rather than vendor IV:

```bash
.venv/bin/python scripts/estimate_weekend_lambda.py --symbol SPY --start 2022-01-01 --end 2026-06-26
```

The report separates raw and admissible medians and breaks estimates into DTE
bands and calendar years. `--variance-source vendor_iv` exists only as an
explicit research cross-check.

To validate a complete calendar Straddle Paper Trade against real EOD chains,
while still calling the production JS clock, IVTS lambda estimator, local-BBO
IV inversion, and pricing core, run:

```bash
node scripts/validate_calendar_projection.js
```

It performs exact-date/read-only lookups, rejects incomplete structured lambda
coverage, reports the entry forecast and the daily replay path, and then moves
one millisecond past the target BBO boundary to test numerical convergence.
The current database has ETF EOD rows only, so this is not evidence about ES
or the final intraday minutes. See `validation/历史日历组合EOD验证报告.md` for the
first real-sample results and limitations.

## Project Map

| File / Path | Responsibility |
| --- | --- |
| `index.html` | main portfolio workspace |
| `chart_lab.html` | shared workspace plus Chart Lab tab |
| `iv_term_structure.html` | standalone IV term-structure monitor |
| `style.css` | shared workspace styles |
| `chart_lab.css` | Chart Lab styling |
| `iv_term_structure.css` | IV term-structure page styling |
| `js/app.js` | state container and orchestration |
| `js/session_ui.js` | workspace chrome, locked-mode labels, document title |
| `js/control_panel_ui.js` | market-data mode, date controls, forward-carry panel, futures-pool panel |
| `js/product_registry.js` | browser product-family source of truth |
| `js/market_curves.js` | typed Discount / Forward / Carry curves, interpolation, metadata, and generic/legacy snapshot adapters |
| `js/implied_lambda_handoff.js` | strict V2 IVTS-to-simulator validation, storage, and portable import/export |
| `js/pricing_context.js` | quote-date / simulation-date / anchor resolution |
| `js/pricing_core.js` | pricing source of truth |
| `js/valuation.js` | group and portfolio derived data |
| `js/order_safety.js` | canonical order intents, preview binding, and position-impact analysis |
| `js/order_confirmation_ui.js` | shared fail-closed live-order confirmation Dialog |
| `js/delta_hedge_logic.js` | Delta Hedge recommendation, resting-order, and automation rules |
| `js/delta_hedge_ui.js` | Delta Hedge configuration dialog, global status banner, and execution controls |
| `js/group_order_builder.js` | open/close combo request payload builders |
| `js/trade_trigger_logic.js` | trigger state and order-trigger rules |
| `js/page_capabilities.js` | page kind and optional-feature capability gating |
| `js/combo_order_transport.js` | combo trigger / close-group request-response state machine |
| `js/delta_hedge_transport.js` | delta hedge broker transport state machine |
| `js/group_editor_ui.js` | group editor, trial-trigger UI, close-group UI |
| `js/group_ui.js` | group DOM writers and execution-status rendering |
| `scripts/estimate_weekend_lambda.py` | historical parity/straddle implied-λ estimator with DTE/year diagnostics |
| `scripts/validate_calendar_projection.js` | production-runtime EOD calendar Paper Trade convergence validator |
| `js/ws_client.js` | websocket connect/reconnect, subscriptions, replay requests, generic message dispatch |
| `js/chart_lab.js` | Chart Lab socket, daily bars, projection rendering |
| `js/iv_term_structure.js` | standalone IV term-structure UI and socket handling |
| `js/iv_term_structure_core.js` | DOM-free IV term-structure aggregation helpers |
| `ib_server.py` | live/shared backend |
| `ib_server_ws.py` | live backend WebSocket session routing |
| `ib_server_market_data.py` | live quote helpers and historical-bars request helpers |
| `ib_server_iv_term_structure.py` | IV term-structure live backend helpers |
| `ib_server_order_tracking.py` | combo/hedge tracking payload builders and event-consumer handlers |
| `historical_server.py` | historical replay-only backend |
| `historical_replay_service.py` | replay payload builder |
| `historical_data.py` | historical chains/bars via options-chain-service HTTP; unified dated curve JSON with read-only legacy rates fallback |
| `yield_curve/` | standalone official-source updater, hybrid D(T) builder, atomic JSON repository, and backend adapter |
| `treasury_yield_curve.py` | legacy Treasury SQLite provider retained for old rates backfill/compatibility |
| `iv_term_structure_service.py` | Python IV term-structure selection helpers |
| `trade_execution/` | execution engine and IBKR adapter |
| `trade_execution/adapters/ibkr_hedge.py` | single-instrument STK/FUT hedge execution helpers |
| `trade_execution/order_tracking.py` | shared combo/hedge order tracking helpers |
| `trade_execution/safety.py` | one-time payload- and position-bound execution authorization |
| `runtime_contracts.py` | typed shared backend payload contracts |
| `scripts/cleanup_runtime_logs.py` | local log/pid cleanup helper |
| `scripts/import_treasury_risk_free_rate.py` | legacy rates.db Treasury backfill CLI; not the live curve source |

## Official Exchange Calendar Refresh

Forward calendars are downloaded from official sources and committed as a
browser-ready snapshot:

- NYSE: public `Holidays & Trading Hours` HTML table
- CME/NYMEX/COMEX: CME Reference Data API v3 `tradingSchedules`, resolved per
  product (`ES`, `NQ`, `MES`, `MNQ`, `CL`, `GC`, `SI`, `HG`)

Run the refresh once each weekend:

```bash
./sync_exchange_calendars_mac.command
```

```powershell
.\sync_exchange_calendars.bat
```

CME requires an OAuth API ID created under CME Group Login → Customer Center →
My Profile → API Management. Both launchers read `api_id` / `api_secret` (or a
short-lived `access_token`) from the `[cme]` section of `config.local.ini`
(gitignored — copy `config.local.ini.example` and fill it in), so a
double-click or an unattended weekly job works without typing arguments.
`CME_API_ID` / `CME_API_SECRET` / `CME_ACCESS_TOKEN` already present in the
environment always win over the file, letting a scheduler inject secrets
without writing them to disk. Never commit real values. Futures/options
attributes use CME's default entitlement.

For an NYSE-only bootstrap, explicitly pass `--nyse-only` on macOS/POSIX or
`-NyseOnly` on PowerShell. This does not invent futures calendars: IVTS stays
fail-closed for any product whose official snapshot is missing or stale. If the
weekly job runs with no CME credentials **and** no `--nyse-only`, the Python
sync fails before writing anything (NYSE included), so the scheduler must
supply one or the other — monitor its exit code; non-zero means nothing was
refreshed.

Generated files:

- `exchange_calendars/official_exchange_calendars.json` — reviewable source snapshot
- `js/official_exchange_calendars.generated.js` — ordered browser runtime data

The downloader verifies TLS, validates table/API structure, and refuses to
write on parsing errors. The old `scripts/sync_market_holidays.py` rule/database
diff implementation is retired; the filename now delegates to this official
sync so an old maintenance command cannot create a second calendar authority.
IVTS treats a snapshot older than 14 days as unavailable, so missing a weekly
refresh cannot silently leave strategy advice running on stale schedules.
CME full-day closures are derived from missing weekdays in the official
Business Trade Date sequence (and from dates with no `open` event). Snapshots
created by the older `has open`-only derivation are rejected by the browser and
must be refreshed before futures IVTS suggestions are enabled.

All live/forward browser date calculations resolve the product `calendarId`
through this snapshot. There is no Easter/nth-weekday/weekend-observance rule
fallback: missing, stale, or out-of-range official data returns calendar
unavailable. Historical replay is the sole exception because the current
official downloads do not cover the full archive; it uses the chain service's
explicit observed-session list, never a holiday formula. Research backtests
overlay the official snapshot wherever its coverage overlaps the archive.

## Tests

Tests live under `tests/`.

The default Node runner is:

```powershell
node .\tests\run.js
```

The runner includes all `tests/*.test.js` suites, including forward-carry and
pricing-context coverage.

It currently runs the suites wired into `tests/run.js`, including:

- market holidays
- product registry
- distribution proxy config
- IV term-structure core
- IV term-structure page helpers
- group order builder
- trade trigger logic
- BSM / amortized / valuation
- session logic / session UI / control panel UI
- group UI / group editor UI / hedge editor UI
- combo order transport
- delta hedge logic / transport / UI
- app orchestration
- WebSocket client

Python tests also exist for selected backend helpers:

- `tests/ib_server_ws_test.py`
- `tests/ib_server_order_tracking_test.py`
- `tests/order_tracking_test.py`
- `tests/ibkr_hedge_adapter_test.py`
- `tests/ibkr_adapter_pricing_test.py`
- `tests/trade_execution_engine_test.py`
- `tests/iv_term_structure_backend_test.py`
- `tests/iv_term_structure_service_test.py`
- `tests/smoke_delta_hedge_ws_test.py`

Run the full Python suite with the resolved project interpreter:

```powershell
& $PYTHON -m unittest discover -s tests -p "*_test.py"
```

## Related Docs

- `ARCHITECTURE.md` - runtime layout and module responsibilities
- `DEV_HANDOVER.md` - developer-facing operational notes
- `AGENTS.md` - repo-specific agent guidance
