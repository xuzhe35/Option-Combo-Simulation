# Option Combo Simulator

## What This Repo Is

Option Combo Simulator is a local browser workspace for building, pricing, replaying, monitoring, and optionally executing multi-leg option structures.

The repo currently has four frontend surfaces:

1. `index.html` - main portfolio workspace
2. `chart_lab.html` - shared workspace plus experimental daily-bar projection
3. `iv_term_structure.html` - standalone live ETF / futures-option IV term-structure monitor
4. `cost_basis.html` - standalone per-account, per-underlying blended-cost ledger

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
  - `liquidation` (current intrinsic value; ignores option quotes, IV, and time value)
  - `amortized`
  - `settlement`
- Group-level execution workflows:
  - trigger conditions in trial mode
  - preview / test-submit / submit combo requests
  - managed reprice / continue / concede / cancel controls
  - close-group execution using the same combo-order path
  - one-expiry Global Auto Close for globally included Active Groups: clearly worthless OTM legs are left to expiry, deep ITM one-sided legs are hedged through one cross-Group net Underlying order, and normal liquid legs remain unchanged for the existing Group Close flow
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
  - per-weekend implied λ solved on demand through a three-tier source chain: a complete coherent two-sided ATM straddle snapshot is preferred, incomplete TWS evidence falls back to an atomic subset of usable BBO expiry pairs, and a final audited `vendor_iv` estimate uses the visible ATM Call/Put IV pairs when books are missing. Signed inversion values are preserved instead of clipped. Listed-expiry gaps of 8–31 days use an explicitly marked endpoint-variance aggregate; longer gaps use the robust median of identifiable intervals from the same frozen surface. These inferred dates are marked `≈`, retained with provenance in V2, and prevent silent holes between usable expiry endpoints. The result is frozen in the UI, then explicitly synced to same-origin simulators or exported as a V2 date array
  - configurable DTE buckets
  - per-symbol JSON history files
- Workspace persistence:
  - backend-owned SQLite workspace store is the day-to-day Save path, so
    routine saving no longer depends on browser file permissions
  - JSON import / export / save-as retained for portability, with direct
    save-back when the browser File System Access API is available
  - soft delete with restore, verified static backups, and a read-mostly
    admin page (`workspace_db_admin.html`) for database stats, the archive
    flow, and restore
- Blended cost ledger (`cost_basis.html`):
  - standalone per-underlying event ledger with its own SQLite database;
    it cannot place orders or subscribe to market data
  - three cost lenses off one event stream (net cash, stock only, tax
    adjusted), with a short share balance treated as supported state
  - IBKR Activity Statement CSV import, and TWS reconciliation that only
    ever *detects* a gap and drafts it for a human to confirm

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

### `cost_basis.html`

Standalone per-underlying blended-cost ledger. It loads only
`js/cost_basis_core.js`, `js/cost_basis_import.js`, and `js/cost_basis.js` —
never the trading shell — and writes its own `cost_basis.db`. It cannot place
an order or subscribe to market data. Full details in
[Blended Cost Ledger](#blended-cost-ledger-cost_basishtml) below.

### `workspace_db_admin.html`

Standalone, loopback-only admin page for the workspace database: size and
growth stats, the archive preview/commit flow, and restore. It loads its own
minimal client and never the trading runtime. Full details in
[Workspace Database Admin & Archive](#workspace-database-admin--archive-workspace_db_adminhtml)
below.

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

`ib_server.py` starts one persistent IB connection supervisor in the background
so the process can still serve replay and fallback paths when TWS / Gateway is
unavailable. After an unexpected disconnect, it attempts to reconnect
immediately, then retries on a fixed 600-second cadence. Manual connect requests
wake that same task instead of starting a competing reconnect loop.

The configured client ID changes only after IB reports numeric error `326`
(client ID already in use). Each such collision lowers the effective ID by one
and promptly retries; ordinary connection failures do not alter it. An
unexpected disconnect advances a market-data generation, invalidates live
evidence, and lets Main, Chart Lab, and active IVTS cards replay subscriptions
once after recovery. An explicit global stream reset remains manual.

Managed combo repricing stops when the IB session or its market-data streams
are invalidated. The broker order remains live at its last submitted limit and
requires manual review; reconnecting never silently resumes or modifies it.

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
- `sync_exchange_calendars.bat`
- `run_market_data_maintenance.bat`
- `install_ib_bridge_deps.bat`
- `cleanup_logs.bat`

These call PowerShell implementations in `powershell_scripts/` where needed.

Important PowerShell entry points:

- `powershell_scripts/start_option_combo.ps1`
- `powershell_scripts/start_historical_replay.ps1`
- `powershell_scripts/update_yield_curve.ps1`
- `powershell_scripts/sync_exchange_calendars.ps1`
- `powershell_scripts/run_market_data_maintenance.ps1`
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
- `sync_exchange_calendars_mac.command`
- `run_market_data_maintenance_mac.command`
- `start_option_combo.sh`
- `update_yield_curve.sh`
- `sync_exchange_calendars.sh`
- `run_market_data_maintenance.sh`
- `install_ib_bridge_deps_mac.command`
- `cleanup_logs_mac.command`

The macOS/POSIX launchers prefer `OPTION_COMBO_PYTHON`, `config.local.ini`, `.venv`, and `venv`, then fall back to versioned `python3` commands.

## Workspace Persistence (SQLite)

Save / Open / Save a Copy in `index.html` and `chart_lab.html` write
workspace documents to a local SQLite database owned by the Python backends
(`portfolio_store.py`, served over the existing WebSocket by
`portfolio_store_ws.py` in both `ib_server.py` and `historical_server.py`).
Routine saves need no browser file-system permission; JSON stays as the
Import/Export and migration format, and a failed database save is reported
as a failure, never silently downgraded to a file write.

- The active database lives in the platform application-data directory
  (macOS: `~/Library/Application Support/Option Combo Simulator/portfolio.db`),
  never inside this OneDrive-synced repo. Overrides:
  `OPTION_COMBO_PORTFOLIO_DB_PATH` env or `config.ini`
  `[portfolio_store] db_path`.
- Documents are UUID-identified with dense revisions. Saves carry an
  expected revision (conflicts offer open-latest / save-a-copy, never a
  silent overwrite) and a save token, so a retry after a lost ACK cannot
  create a duplicate revision.
- Every load path — database Open or JSON Import — reopens disarmed:
  live-order authorization, auto-submit, account selections, and pending
  broker state never survive a snapshot (`sessionSchemaVersion` 1).
- v1 persistence answers loopback clients only; remote browsers get
  `store_unavailable` until an authenticated remote mode exists.
- Same-browser tabs coordinate a single writer per document over
  BroadcastChannel; the server's revision check remains the real guard.
- Scheduled static backups publish atomically after saves (at most one
  attempt per `backup_interval_hours`, including incomplete/failed attempts)
  and top up on clean exit, into
  `[portfolio_store] backup_dir` — point it at a OneDrive-synced folder for
  cross-machine disaster recovery — or `<app-data>/backups` by default.
  Manual backup: `scripts/backup_portfolio_store.py` publishes the FULL
  recovery set — the active database plus every registered archive shard.
  Each main/manifest gets a generation id; an unchanged immutable shard is
  shared by later manifests instead of being copied and uploaded again.
  Only logically changed shards get a new generation-named snapshot.
  The atomically written `recovery-manifest-*.json` is published last and
  pins each member's exact name, size, and hash from locally verified staging
  bytes. Retention removes complete generations as a unit, never a member
  still shared by another manifest. Unreferenced own shard snapshots from a
  crash are reclaimed after a 48-hour grace period (including legacy names).
  The entire
  publish, including its manifest and retention pass, stays under the same
  cross-process maintenance guard the backends use (backup only; no flag
  deletes revisions). A failed publish writes no manifest and exits non-zero;
  a failure in post-publication retention/cleanup is reported as a warning
  while the already-complete manual backup still exits successfully.
  Restore: `scripts/restore_portfolio_store.py <backup.db> --yes` accepts
  only manifest-complete generations, cross-verifies every archive
  entry/tombstone against staged copies, and installs exactly those verified
  copies through destination-local temporary files. It takes the backends'
  runtime lock exclusively (a running backend fails it closed), rolls the
  whole old set back on any copy/SQLite/mid-swap failure or interrupt before
  re-raising it, and refuses missing
  shards unless the explicit `--allow-missing-shards` downgrade is given;
  degraded restore quarantines any same-named old target shard so it cannot
  be silently reused. Format-1 recovery manifests from earlier builds remain
  restorable. This is backup, not multi-master sync: two machines editing
  their own local databases fork and cannot be merged automatically.
- Revision retention (`revision_keep_recent` / `revision_keep_daily_days`)
  only defines ARCHIVE CANDIDATES. Nothing is deleted on a schedule:
  revisions beyond the policy leave the active database solely through the
  admin page's archive flow below, after a verified copy exists.
- Deleting a workspace is a soft delete: restore it yourself from
  Open → Recently Deleted. Revision history is never rewritten. After the
  30-day grace (`archive_deleted_after_days`) a deleted workspace becomes a
  whole-document archive candidate.

## Blended Cost Ledger (`cost_basis.html`)

A standalone page (own minimal WebSocket client; it loads none of the
trading scripts and can never trade, subscribe, or touch orders) that
answers one question for one IB account and one underlying: **what did this
stock or futures position actually cost this account, all in?** The active
book identity is `account + symbol + security type + currency`, so two managed
accounts may keep independent books for the same symbol. A book is explicitly either `STK`
(stock/ETF plus OPT) or `FUT` (deliverable FOP plus FUT). The ledger, CSV,
manual-entry, export, snapshot and scenario-replay paths work against either
backend. Current positions/AvgCost, recent executions, fresh prices, option IV
and discount-curve inputs require the live IB backend; without it the page
continues from CSV/ledger-inferred positions and labels them as not reconciled
to TWS.

Open it at `http://localhost:8000/cost_basis.html`.

The cash-flow section's heading has a **卖方权利金 · 按到期日查看** control,
outside the metric cards so they stay compact. Its read-only
dialog groups remaining Short Put / Call contracts and their net opening
premium by expiry (earliest first), with daily and cumulative totals. It uses
ledger replay, works without TWS, excludes Long Option cash, and allocates only
the still-open share of premium after partial closes. These are premiums
already received, not new cash payable at expiry or guaranteed final P&L;
positions remain listed until a close or settlement is recorded in the ledger.

The dashboard also includes a read-only **What If** expiry-price scenario for
stock/ETF books. It keeps the current shares, settles every open option against
one hypothetical underlying expiry price through a user-selected expiry date,
and then replays the ledger to show the resulting share count, total basis, and
per-share blended cost under the selected lens. Later expiries remain open and
at risk. For example, an ITM short put becomes an assignment while an ATM/OTM
put expires. This is an expiry outcome with zero settlement fees and no option
time value; it never records the synthetic settlement rows.

The stress-test modal values every still-open option of this book on ONE
scenario date (the selected expiry, or today + "days to reach the drop"):
options expiring by then settle at intrinsic value, live longs are marked as
assets and live shorts as liabilities (premium received minus model value),
with each contract's own TWS IV, the shared USD discount curve resolved from
that same day, a CRR American binomial with per-symbol dividend yields by
default (European BSM optional), and either the mid or a "today's spread"
lens that extrapolates today's bid/mark (longs) or ask/mark (shorts) ratio
onto the scenario value and rejects crossed or one-sided quotes. It can also
stack **cross-book protection**: a leveraged ETF book (seeded for `TQQQ`)
borrows the long Calls/Puts of a same-account, same-currency sibling book
(`QQQ`). The index is the driver: each scan point is mapped to the sibling's
price by daily-rebalanced compounding with a volatility-drag term whose path
sigma is an explicit assumption or the IV of the nearest-the-money sibling
contract still alive after the date (refused, never zero, when none exists);
a linear ratio is kept for comparison. The sibling's contracts are valued at
that price with their own IV, optionally lifted by a fixed shock or a
spot-vol beta (downside only, tenor-damped), and this book's IV shock follows
the same beta scaled by the leverage ratio. The stacked figure is the change
against today's TWS mark, so premium already paid is sunk and a crash shows
the protection as a gain; P&L versus the premium is a tooltip reference only.
The overlay reads the sibling ledger and a bounded TWS quote request only,
matches contracts by strict identity (conId, else localSymbol, else terms
plus multiplier), ignores short legs, never merges the books, and refuses to
guess when any IV, rate, mark, sigma, or price is missing. See
`CODE PLAN/COST_BASIS_CROSS_BOOK_HEDGE_OVERLAY_PLAN.md`.

The dialog sweeps a selectable price range and shows, at every point, the
numbered components (settlement, this book's live options, the sibling's) and
their total, plus blended cost and settlement counts. Option quotes come from
a bounded TWS request (short-lived streaming lines with the implied-volatility
tick, opened in batches and cancelled once each contract has its mark and, if
still alive, its IV); if anything cannot be fetched in time the affected
overlay fails closed while the ordinary expiry scenario remains usable.

The event-flow table keeps its running balances anchored to chronological
ledger replay, but displays the finished rows newest-first in 25-row pages so
the latest activity is always on page 1.

Creating a book uses the same managed-account selector as the main page's
`Enable Trade` controls. One TWS account is selected automatically; multiple
accounts require an explicit choice. When IB API is unavailable, the same
selector falls back to accounts already present in the ledger and a clearly
labelled manual-account option, so the page still works with the historical
backend. Once TWS supplies managed accounts, new books must use that live list.

### Why it is an event ledger and not a snapshot tool

IB can tell you what you hold right now, but not what you paid over the
last two years: `reqExecutions` covers only a recent window, and an
assignment is indistinguishable in a snapshot from "the option vanished
and the share count moved". So the SQLite ledger in `cost_basis.db` is the
source of truth, and the TWS position snapshot is a checksum against it.
The page's **拉取 TWS 成交** action requests the recent executions visible to
the connected API client from the last CSV timestamp, previews each stock,
option, FOP, or FUT leg, and imports only after explicit confirmation.
Because some TWS versions send execution timestamps as timezone-less wall clocks, `[tws] timezone`
in `config.ini` must match the timezone selected at TWS/Gateway login (for
example `America/New_York`). The server assigns this setting to ib_async before
connecting; it never guesses from the browser or server clock. Nonempty invalid
IANA names now stop startup before IB or ledger stores are initialized, instead
of making the decoder silently drop fills. An unset timezone still disables
ledger execution imports; configure it explicitly. Backend settings continue to
come from `config.ini`, not the launcher's `config.local.ini` Python overrides.
When an option quantity differs, that reconciliation row exposes **查找 TWS
成交** before any AvgCost fallback. All recent executions for the same account
and contract are replayed in broker-timestamp order. The replay is accepted
only when its final quantity is exactly the current TWS position; openings and
increases remain ordinary execution events, while each non-reversing reduction
is labelled **期权 Close（平仓）**. The preview keeps
broker price, commission, and signed cash. Position differences alone never
fabricate a trade, zero-price close, or cash flow. Targeted lookups only block
on errors that belong or might belong to that contract; clearly unrelated
commission-pending fills are neither imported nor allowed to block it.
For a complete TWS-only position with a valid AvgCost, the same row also keeps
an explicit **采信 TWS** fallback beside lookup, usable after lookup fails.
It requires confirmation and creates a provisional baseline, not a historical
fill. Partial-position gaps instead offer the separately labelled AvgCost
manual-draft fallback. Both paths defer to real executions and reviewed CSV.
Database insertion timestamps never substitute for a missing broker snapshot
clock. Bulk imports encountering an ambiguous legacy option baseline stay
blocked and direct the user to cancel the preview and use that contract's
**查找 TWS 成交** row action (or a reviewed full-CSV rebuild).
If that AvgCost fallback was used earlier, a later TWS pull can replace the
temporary baseline with the complete ordered execution sequence when removing
that one provisional row and replaying every fill produces the current TWS
quantity exactly. No individual fill is selected by comparing it with AvgCost
or provisional cash. The replacement and all fills are committed together only
after confirmation.
Broker `execId` values make retries idempotent; a duplicate `execId` inside one
review batch is a blocking preview problem (the first row is retained for
inspection), and BAG summary fills are excluded
to avoid counting a combo twice, and a missing commission report blocks the
batch. A negative IB commission is retained as a separate positive-cash rebate.
When one of these executions is the real trade behind an adopted TWS baseline,
the import replaces that baseline atomically only after contract, signed
quantity, timestamp, and net cash (including commission/rebate) prove the
match; ambiguous or partial overlap blocks the batch. This is useful for today's activity but does not replace a cumulative
Activity Statement when the CSV cutoff predates TWS's available window.
If those reviewed TWS fills were committed, a later CSV row is treated as the
same execution only when account, contract, signed quantity, broker timestamp,
price, and net cash all agree (or the broker execId agrees and the economics
still verify). The CSV then reuses the stored exec identity and SQLite skips it;
a suspected cross-source overlap that cannot be proved is blocked rather than
double-booked.
What If defaults to **自动跟随参考价**: the effective hero reference price also
drives the expiry scenario. Existing TWS portfolio-price pushes immediately
recalculate it without polling, extra quote requests, or ledger writes. A typed
hero reference is followed too. Selecting a book reads the existing portfolio
cache once so an initial push received before book loading is not lost. Typing
a What If price (including zero or an
empty edit) pauses following; unchecking the control freezes the displayed
assumption. Checking it again resumes following without a request. No TWS
price and no manual reference means an unavailable automatic scenario, not a
stale last quote.
The **使用当前价** button still requests a fresh one-shot TWS snapshot quote.
On success it clears the manual hero reference and resumes automatic following;
later portfolio updates replace that quote rather than leaving What If frozen.
Failure preserves the assumption, and a late response cannot overwrite a newer
edit or another book. The displayed refresh time belongs only to that one-shot
quote and is cleared when a portfolio update replaces it. Refreshing stress-test
inputs does not override a manually chosen What If price.
The automatic cadence is the existing account/portfolio feed, not streaming
tick data. IB documents updates at position changes or approximately three-minute
intervals; repeatedly reading the backend cache cannot make the broker feed
faster. See [IB account updates](https://interactivebrokers.github.io/tws-api/account_updates.html).
None of these actions leaves a new live market-data subscription behind.
**Nothing auto-writes an event.** When the ledger has none of a position and
the authoritative TWS snapshot includes both quantity and average cost, an
explicit `采信 TWS` click plus confirmation records it directly as a
current-date baseline. Partial gaps, missing TWS cost, and ledger-only gaps
still go through the review form. For a partial gap with an available AvgCost,
the fallback button only fills a clearly marked manual draft for the missing
quantity; it never writes directly because AvgCost may blend opens and closes.

### The three cost lenses

All three come off the same event stream, because the number that matches
your broker and the number you actually care about are not the same one:

- **Net cash** (default) - share investment after realized option premium,
  divided by shares. The UI presents cumulative account cash directly:
  receipts are positive and payments are negative, so a net receipt appears
  as `+1,504.31` rather than as a negative "cash outflow".
  The full-cycle cost of the shares you still hold. Counts only premium
  from contracts that are closed; premium on open contracts is money
  received but still at risk. **This number can go negative**, and a
  negative value means the position has already returned more cash than it
  consumed - the page labels it 已完全回本 rather than treating it as an
  error. With no shares left there is no per-share cost at all, so the page
  shows cumulative net cash instead of dividing by zero, while realized and
  still-at-risk option premium remain separate rows.
  A negative share balance is fully supported: the same signed calculation
  becomes the short position's buy-back break-even level. Realized option
  premium raises that level, while premium on open contracts remains excluded
  until the risk is closed. A short-position notice is based only on the final
  replayed balance, never on a temporary negative balance between same-time
  settlement rows.
- **Stock only** - plain rolling average of share trades, premium listed
  separately. This is the one that should reconcile against TWS's average
  cost column; if it does not, the ledger is missing an event and the page
  flags the gap.
- **Tax adjusted** - an assigned contract's premium rolls into the share
  basis (short put assigned: basis = `K − premium/share`; short call
  assigned: proceeds = `K + premium/share`), which explains most of the
  residual difference against a broker's cost-basis view.

The event table's **full-cash running cost** is deliberately a different audit
lens: it includes every cash flow, including long-option purchases. The large
headline blended cost excludes the full lifecycle of protective/convexity Long
Calls and Puts. A 100-share lot bought at 50 plus a long Put costing 200 will
therefore show 52 in the running full-cash column and 50 in the headline; that
is intentional, not a reconciliation error.

Those three selectable lenses apply to an `STK` book. A `FUT` book instead
shows the current FUT entry average and one blended cost in futures points:
the current contract basis, minus realized FUT P&L and realized FOP premium,
plus fees, divided by signed point exposure. Open FOP premium remains at risk
and appears only in the separate "all open options expire at zero" figure.
For a roll, this carries the old economic basis as
`old basis + new open price - old close price + fees/(contracts × multiplier)`;
the same signed equation works for long and short futures.

### Recording events

Every row stores explicit signed quantities and an explicit signed cash
amount (`cashAmount` is the account cash delta: received positive, paid
negative, fees inside). One formula covers both directions, so selling
five puts at 1.20 records `contracts = -5` and `cash = +596.75`.

The subtle one: **an assignment row's cash is the share delivery at the
strike, nothing else.** The premium was banked when the contract was
opened, so counting it again here would double it. The entry form and the
store both enforce that, along with the delivery direction (short put
assigned buys shares, short call assigned sells them) and the rule that
the share count must equal contracts × multiplier.

In a `FUT` book, FOP assignment/exercise closes the option and opens the
actual delivered FUT at the strike. It moves FUT contracts, never shares, and
the event cash is fees only: futures notional and daily variation margin are
not treated as a cash purchase. The option premium was already recorded on
the FOP trade rows.

The ledger is append-only during normal use. Corrections append a void marker
with a required reason; individual rows are never deleted, because the audit
trail is the point. The one explicitly destructive exception is deleting an
entire book, described below. Closing more contracts than the ledger shows
open at that date is refused - including when you back-date a trade that would
strand a later assignment.

### Importing IBKR statements

Import handles both a Flex Query flat CSV and a multi-section Activity
Statement. IBKR records one assignment as two rows (the option closing at
zero and the share delivery); the importer pairs them into a single event
and reports anything it cannot pair rather than booking it as an ordinary
trade. Every import runs through a preview - new / already-imported /
needs-attention, row by row - and de-duplicates on the broker's trade id,
so overlapping statements can be re-imported safely.

For `FUT` books the asset classes stay distinct (`FOP` is never guessed as
`OPT`, and `FUT` is never guessed as stock). An FOP delivery must pair uniquely
with its actual FUT delivery row. A timestamped close-old/open-new FUT pair is
a `futures_roll`; its common quantity carries the roll spread, while any excess
quantity remains an outright `futures_trade`. Ambiguous pairs block the whole
batch. If a partial-period statement starts with an existing FUT but omits its
entry price, import is blocked until an earlier statement or a reviewed
TWS/manual baseline supplies that cost.

An explicitly adopted TWS position is a provisional baseline, not a second
copy of later broker history. When a cumulative Activity Statement can
reconstruct that exact account/contract quantity at the recorded snapshot
timestamp without an unknown opening stub, the same import transaction voids
the `tws_snapshot` baseline and writes the CSV rows. A genuinely incremental
statement whose rows all occur after the snapshot keeps the baseline. Partial
or same-day-ambiguous overlap is blocked: the page asks for a complete covering
statement or a reviewed rebuild instead of retaining both cash flows.

### Rebuilding a book from scratch

When the import logic or a cost convention changes, patching dozens of events
by hand is worse than starting over. `覆盖式重建` (in the import panel) empties
the book and re-imports one complete statement in a single confirmed step.

Four guards make it safe to have:

- The full event set - voided rows included - is serialised into
  `cost_basis_book_resets` with a sha256 **before** anything is deleted. The
  active ledger ends up genuinely clean rather than littered with tombstones,
  but nothing is actually lost.
- A single confirmation dialog names the symbol, current event count, and
  replacement row count. Behind that dialog the page sends a server-generated,
  count-bearing reset token; it is re-checked inside the write transaction, so
  a ledger that changed after the preview fails instead of deleting newer rows.
- Replacement parsing ignores overlap warnings against stored TWS executions,
  because every old row is archived and removed atomically before the CSV is
  written. Append imports retain the strict cross-source duplicate checks.
- The wipe happens only after the replacement file is parsed and previewed, so
  a bad file can never leave you with an empty ledger.
- Apart from the separately confirmed whole-book deletion below, this is the
  only path that deletes events. There is no bulk row delete, arbitrary SQL,
  or delete-event-by-id.

### Permanently deleting a book

`永久删除账本` removes the selected book itself plus all of its event rows
(including voided rows), reconciliation snapshots, and reset/rebuild archives.
Nothing is archived first and the operation cannot be undone. The page first
asks the server for live counts and shows one ordinary confirmation dialog.
After confirmation it returns the server-generated account, symbol, and count
token internally; the user does not have to transcribe it. The server
recomputes that token after taking the database write lock, so any intervening
event, snapshot, or reset makes the plan stale and leaves the complete book
untouched. Another account's book for the same symbol is a different book ID
and is not affected. If the delete response is lost, the page refreshes the
authoritative book list before reporting the outcome. A missing book is shown
as already deleted rather than as a misleading failure; no deletion receipt or
other identifying residue is stored in the database.

### Reconciliation

`拉取 TWS 持仓` reads `ib.positions()` (which spans all managed accounts),
then diffs only the selected book's IB account per contract. It compares current
quantities only. A vanished option plus a matching underlying change is a
useful clue, but it cannot prove assignment rather than an independent
underlying trade; an absent expired option likewise cannot prove zero-cash
expiry rather than an earlier paid close. Those gaps therefore show advice
only and never manufacture assignment, exercise, expiry, share, or FUT
events. Import the broker statement or enter the verified historical event.

An `STK` book reconciles only `STK/OPT`; a `FUT` book reconciles only `FUT/FOP`.
Futures remain separated by actual contract month, multiplier and broker
identity, so different delivery months cannot silently cancel each other. If
a vanished FOP could explain a newly visible FUT, standalone FUT adoption is
blocked: recording only the FUT would leave the option premium incorrectly
open in the ledger.

For a whole position that exists only in TWS, `ib.positions()` also supplies
the broker average cost. `采信 TWS` records that quantity and average cost
directly after confirmation. TWS does not supply the original opening date,
so the row is deliberately tagged `tws_snapshot` and dated on the adoption
day; it is an auditable starting baseline, not invented trade history.
If a later cumulative CSV supplies the real history behind it, that CSV
atomically replaces the provisional baseline; the two costs are never added.

Caveat worth knowing: the quantity and adoption average cost come from the
all-account `ib.positions()` snapshot after filtering to the book account. The separate live average-cost
comparison and market price still come from `updatePortfolioEvent`, which
covers only the account TWS pushes portfolio updates for; those comparison
cells show 不可用 for accounts TWS is not reporting.

### Storage

`cost_basis.db` sits next to `portfolio.db` in the platform
application-data directory - a separate file on purpose: the ledger is
small, append-oriented, and must never be swept into the workspace revision
archive. Configure under `[cost_basis]` in `config.ini`; a one-off
override is `OPTION_COMBO_COST_BASIS_DB_PATH`. Loopback-only, like every
other persistence surface.

There is currently no dedicated `backup_cost_basis_store.py` command and no
automatic cost-ledger backup scheduler. Back up this database with a
SQLite-consistent backup while the backend is stopped (or with an external
SQLite backup tool); do not copy only the main `.db` file while its WAL is
active. The workspace archive/backup commands do not include `cost_basis.db`.

Databases created before schema v7 are migrated in place. Schema v5's account
migration does not rewrite event rows; schema v6 adds the per-event
`allow_overdraw` audit flag and marks only legacy closing rows that demonstrably
used that explicit exception. Schema v7 clears broker timestamps that older
builds inferred from untrusted manual free-form notes.
If all account-bearing rows in an old book agree on one account (apart from
book-wide split rows), that account is adopted as its book identity. A
genuinely mixed- or unlabelled-account old book remains
available as a clearly labelled legacy book; it is not split automatically,
because doing so would also require an operator decision about book-wide rows
and historical snapshots.

## Workspace Database Admin & Archive (`workspace_db_admin.html`)

A standalone page (own minimal WebSocket client; it loads none of the
trading scripts and can never trade, subscribe, or touch orders) for
inspecting and archiving the workspace database. Works against either
backend.

- Overview: active/deleted documents, revisions, logical payload bytes vs
  allocated/reclaimable/WAL/file bytes (never conflated), save-receipt
  ledger size, 7/30-day growth, archive shard registry, and the current
  candidate counts. Exact recount runs as a background job.
- Archive flow: `Preview archive` computes a server-side plan; you must
  type the exact phrase `ARCHIVE <N> REVISIONS`; Execute then copies the
  candidates into `<app-data>/archives/portfolio-archive-<year>-<nnn>.db`,
  verifies every payload hash byte-for-byte, takes a verified recovery
  snapshot (`<app-data>/maintenance-backups/`), and only then removes the
  verified copies from the active database in small chunk transactions.
  Anything that changed since the preview is skipped, never force-deleted.
  Cancel exists during the copy stage only.
- Restore: an archived old revision restores as a NEW head revision of its
  document (normal save path, conflict-checked); an archived deleted
  workspace restores as a copy under a new id. Every restored payload is
  re-verified against its recorded hash first.
- Both backends may run at once: maintenance (backup / archive / vacuum /
  restore) is serialized by an OS file lock plus a database lease with
  fencing tokens; the loser reports "maintenance busy" and retries later.
- `archive_auto_run` stays `false`: archiving is manual until the manual
  flow has proven itself. The opt-in auto pass runs after a verified
  backup, backs off for hours after any failure, and refuses on low disk.
- Archive shards live next to the active DB and must never sit in a synced
  folder; publish static shard backups the same way as database backups.

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
allowed_origins = http://localhost:8000,http://127.0.0.1:8000,http://[::1]:8000
option_contract_timing_timeout_seconds = 5

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

`option_contract_timing_timeout_seconds` (in `[server]`) bounds the ContractDetails
lookups that resolve an option's exact last-trade timing and verify a FOP's
underlying futures delivery month. On timeout, an otherwise IB-qualified
standard stock/ETF option may continue on the visible product-profile cutoff.
FOP/INDEX plus unverified, adjusted, or otherwise nonstandard options still fail
closed until exact timing arrives. The default is 5s; values below 0.5s are
floored.

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

`server.allowed_origins` is an exact comma-separated browser-origin allow-list
enforced during the WebSocket handshake. Loopback binding is not a browser
security boundary by itself: without this check, an unrelated website could
connect to the local service. If the frontend is served from a LAN/Tailscale
address or a different HTTP port, add that exact `http://host:port` (or HTTPS)
origin. Missing origins, `null`, wildcards, paths, and unlisted origins are
rejected; serve the frontend over HTTP rather than opening the HTML as a file.

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
logic or a periodic rate-refresh loop. Outside the Docker deployment, if the
file is missing or older than the current New York market date, a backend may
start the independent updater once; network failure retains the prior complete
file. Docker disables those backend auto-update flags so its PID-1 scheduler is
the sole automatic writer.

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
- Linux: run `./update_yield_curve.sh`.

For a combined maintenance run, the launchers update the yield curve
first and the official exchange calendars second:

- Windows: double-click `run_market_data_maintenance.bat`.
- macOS: double-click `run_market_data_maintenance_mac.command`.
- Linux: run `./run_market_data_maintenance.sh`.

The second step is not started when the yield-curve step fails. The combined
launcher updates all configured markets when CME credentials are available;
without them it automatically refreshes NYSE only and preserves existing
CME/NYMEX/COMEX entries with their original timestamps. Those preserved
entries independently become unavailable when stale. Pass `--nyse-only` on
macOS/Linux or `-NyseOnly` on PowerShell to force that scope explicitly.

For the long-running Docker deployment, `option_combo_starter/supervisor.py`
runs the same updater once at 09:30 America/New_York on each weekday. The
attempted New York date is persisted, so a later container restart does not
repeat that day's automatic attempt. A failed, partial, timed-out, or
cache-fallback attempt is not retried that day; the previous successful
snapshot remains available in the persistent `/app/state/yield_curve` volume.
Yield maintenance is optional and cannot terminate a critical child or restart
the container. The Docker config overlay sets
`auto_update_if_missing = false` and `auto_update_if_stale = false`, leaving
this scheduler as the sole automatic writer. Its supported settings are
`OPTION_COMBO_YIELD_DAILY_HOUR_NY` (default `9`),
`OPTION_COMBO_YIELD_DAILY_MINUTE_NY` (default `30`),
`OPTION_COMBO_YIELD_PROCESS_TIMEOUT_SECONDS` (default `120`), and
`YIELD_CURVE_DATA_DIR` (default `/app/state/yield_curve`).

All launchers resolve the same configured/project virtual-environment Python
used by the application, perform one update from the official sources, then
print the current local snapshot status. Interactive launchers keep their
terminal open so the source status or error remains visible. No API key is
required. A failed official-source request does not overwrite the last complete
snapshot. The manual launcher deliberately refreshes even if an earlier
snapshot exists for the date, so a morning run can be replaced after the
official sources publish newer observations.

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
- FOP defaults to European Black-76, with an independent opt-in American
  futures CRR switch for early-exercisable contracts such as SI. The American
  tree uses the leg-bound futures quote with zero risk-neutral futures drift
  (`q=r` in the generalized CRR implementation); stock/ETF and FOP model
  choices are saved independently
- cash-settled index-style paths remain European Black-76
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
   the curve median is visibly extrapolated for display horizons beyond the
   last structured expiry. The simulator remains strict by date and does not
   consume that display-only tail. Gaps between usable expiry endpoints are
   instead filled during the audited calculation: 8–31 day gaps use observed
   endpoint variance, while longer gaps use the same-surface robust median;
   those synchronized dates are visibly marked `≈`. After a frontend upgrade, hard
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
4. Per-date IVTS coverage is preferred whenever implied λ is enabled. Missing
   closure dates are listed and filled with the accepted curve median; when no
   qualified curve is loaded the configured scalar λ is used. These fallbacks
   are visibly marked as estimates instead of stopping all projections.
   Outside bundled live exchange-calendar coverage, weekdays/weekends are also
   estimated; historical replay continues to require observed trading dates.

For a live forecast such as "on 7/10, value the calendar at the 7/15 close",
set the simulation date to `7/15`, select `Weighted weekends (λ)`, and enable
the matching fresh IVTS array. A target date that is still in the future but
equals the near leg's expiry means close/settlement: the near leg is intrinsic
and the far leg retains the time from that close to its own expiry. The IVTS
status reports complete coverage, estimated fallback, or `not_required`.

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
because it can be later than the last trading instant. Live analysis uses the
visible product-profile cutoff whenever exact IB timing is pending or absent.
Explicitly rejected/not-found contracts, incompatible adjusted equity classes,
conflicting near-leg cutoffs, and deferred special settlement still fail
closed. The profile timing estimates are:

The timing handoff is independent of price ticks, including when a contract is
already pooled by IVTS. A ContractDetails response is cacheable only after it
contains a parseable exact cutoff (and, for FOP, verified underlying binding);
partial responses are retried on a later subscription. A persistent
`exact_contract_timing_missing` now means the contract identity was explicitly
rejected/not found or conflicts with a known standard equity class.

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

For an open Group approaching expiry, select **Liquidation** to keep the entry
cost basis while marking every open option at current intrinsic value against
its own resolved spot or bound Futures Pool contract. This view ignores option
BBO/model marks, IV, and time value, and carries the same intrinsic payoff into
the Group/global charts and probability analysis. Once a live contract is past
its last-trade cutoff, cached pre-expiry option marks are rejected from Active
Live P&L instead of being presented as current quotes.

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

Live What-If projections use
`projectionConvergenceMode: "best-effort-input-iv"` by default. The shared
priority is fresh local BBO inversion, best observable option-price inversion,
then the latest usable TWS/input IV. Valuation, main/global payoff charts,
Chart Lab, probability, and amortized projections all use this same policy.
Strict BBO remains available as an opt-in chart diagnostic.

The option BBO, quote-horizon Forward/spot and live portfolio clock used by a
strict local inversion must be within 30 seconds of one another. This atomic
calibration limit is deliberately tighter than the general 120-second market
quote freshness window because a two-minute skew is material when the far leg
has only hours or minutes left. A breach reports the exact local-anchor status
instead of reverting to TWS/manual IV.

Websocket health is independent of the frozen server quote clock. A 5-second
watchdog marks the feed stale when no market-data payload has arrived for 120
seconds. Stored evidence is tagged stale; analysis continues from the best
available estimate while the strict-BBO diagnostic remains unavailable.

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

Refresh the official calendars periodically; quarterly is sufficient for the
183-day safety window:

```bash
./sync_exchange_calendars_mac.command
```

```powershell
.\sync_exchange_calendars.bat
```

On Linux/POSIX:

```bash
./sync_exchange_calendars.sh
```

To update both maintained market-data inputs in one ordered run, use
`run_market_data_maintenance_mac.command`,
`run_market_data_maintenance.bat`, or
`run_market_data_maintenance.sh` for the current operating system. These run
the yield-curve updater before the calendar updater and stop on the first
failed task.

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
`-NyseOnly` on PowerShell. Existing futures calendars are retained unchanged,
including their original `fetchedAt`; they are not presented as refreshed and
IVTS remains fail-closed once they are stale. The standalone calendar updater
still fails before writing anything when no CME credentials and no explicit
NYSE-only scope are provided. The combined one-click maintenance launcher is
the exception: it automatically selects NYSE-only in that situation and prints
the degraded scope.

Generated files:

- `exchange_calendars/official_exchange_calendars.json` — reviewable source snapshot
- `js/official_exchange_calendars.generated.js` — ordered browser runtime data

The downloader verifies TLS, validates table/API structure, and refuses to
write on parsing errors. The old `scripts/sync_market_holidays.py` rule/database
diff implementation is retired; the filename now delegates to this official
sync so an old maintenance command cannot create a second calendar authority.
IVTS treats a snapshot older than 183 days as unavailable. This half-year
guard catches genuinely abandoned maintenance without coupling ordinary TD-IV
display to a weekly calendar download.
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
