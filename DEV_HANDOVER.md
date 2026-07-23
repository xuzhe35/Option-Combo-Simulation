# Option Combo Simulator - Developer Handover

**Updated:** 2026-07-19

## 1. Current Product State

This repo is a shared browser workspace with two backend flavors, not just a single-page option sandbox.

Current surfaces:

- `index.html` for the main portfolio workspace
- `chart_lab.html` for the shared workspace plus the experimental Chart Lab tab
- `iv_term_structure.html` for the standalone ETF / futures-option IV term-structure monitor
- `ib_server.py` as the live-backend composition entry point
- `ib_server_ws.py` for live backend WebSocket session routing
- `ib_server_order_tracking.py` for combo/hedge tracking payloads and IB event consumers
- `ib_server_market_data.py` for live quote fanout and historical-bars helpers
- `ib_server_iv_term_structure.py` for IV term-structure live sync helpers
- `historical_server.py` for historical replay snapshots only (chains/bars via the shared options-chain-service, rates via `sqlite_spy/rates.db`)

## 2. What Is Actually Implemented

### Shared frontend shell

- live and historical market-data environments in the same runtime
- query-param-based locked workspaces:
  - `entry=live`
  - `entry=historical`
- workspace banner / title / subtitle changes driven by `workspaceVariant` and `marketDataModeLocked`
- JSON import / save / save-as
- direct save-back when the browser File System Access API is available

### Control panel

- underlying symbol plus optional underlying futures month
- historical start date, replay date, and separate simulation date
- forward-carry sample panel for index products
- futures-pool panel for FOP products
- live-order enable switch
- live TWS account selector once accounts are discovered
- configurable browser WS endpoint in `index.html`
- Delta Hedge dialog beside Enable Greeks, persistent global operating status, broker preview, manual execution, cancel / clear, and guarded automation
- shared fail-closed Order Intent, position-impact, confirmation, and one-time backend authorization for Open Combo and Delta Hedge

### Forward / Carry / Discount infrastructure

- `js/market_curves.js` owns typed `discount`, `forward`, and `carry` curves.
  Do not bypass the runtime kind checks: Black-76 discount `r` and carry
  `r-q` are deliberately not interchangeable.
- `js/pricing_context.js` resolves per-leg discount `r(T)` and the appropriate
  pricing input: INDEX uses expiry carry/forward samples, FOP uses its bound
  Futures Pool quote, and stock/ETF remains spot BSM.
- INDEX samples use coherent call/put/spot evidence and
  `F=K+(C-P)/D(T)`. The stored row carries `F`, `r`, `D`, `r-q`, source,
  snapshot time, skew, and quality. Its tenor is the fractional interval from
  `max(call, put, spot quoteAsOf)` to the matching ContractDetails
  `expiryAsOf`; invalid evidence clears the prior sample even with the panel
  collapsed. A live sample more than two minutes behind the current payload
  timestamp is not priced.
- INDEX option legs fail closed when no usable parity sample exists; only an
  explicit index underlying leg may use spot directly. FOP legs likewise fail
  closed when their explicit Futures Pool binding has no current-generation,
  qualified, identity-matching quote within the 120-second market clock gate.
  New subscriptions and rejected/stale quotes clear the old pool mark. Do not
  restore either spot/anchor substitution.
- `OptionComboWsLiveQuotes.getForwardCarrySnapshot()` is the diagnostic/read
  API. FOP points retain entry id, family/currency, contract identity, exact
  expiry when IB supplies it, `quoteAsOf`, source, and quality. ES/MES use SPX
  and NQ/MNQ use NDX only as optional diagnostics. Reference qualification or
  subscription failure must not block FOP streams. `carryRate` stays null when
  expiry is only YYYYMM or future/reference age/skew exceeds 120 seconds; the
  outright exchange futures curve remains valid. CL/HG/GC/SI have no cash-index
  reference and never infer their curve from discount `r`.
- `yield_curve/` owns the complete current-data path: official NY Fed SOFR and
  Treasury CMT adapters, hybrid `D(T)` construction, atomic dated JSON storage,
  strict as-of repository reads, CLI, and the thin backend adapter.
- Through 30 days the curve uses latest overnight SOFR flat; 30-to-first-CMT
  uses a smooth instantaneous-forward transition; later nodes preserve the CMT
  proxy slope. SOFR Averages are diagnostics only and CMT remains explicitly
  non-zero/OIS proxy input.
- Both backends are read-only curve consumers. Missing/stale live data may
  start `sys.executable -m yield_curve update --if-needed` once; there is no
  rate provider or hourly refresh loop inside either server.
- User-facing daily maintenance is double-clickable via
  `update_yield_curve.bat` on Windows and `update_yield_curve_mac.command` on
  macOS, or runnable as `./update_yield_curve.sh` on Linux. All resolve the
  project-configured Python, force one daily update, then run `status` and leave
  interactive output visible. The Windows wrapper delegates to
  `powershell_scripts/update_yield_curve.ps1`; `-IfNeeded` opts into the
  backend-style skip guard and `-StatusOnly` performs no network request. The
  macOS `.command` is a native zsh double-click entry point, while the Linux
  script uses Bash.
- Main/Chart Lab request the curve on socket open and every six hours. IVTS uses
  the same control-socket payload. Network failure retains the prior complete
  curve; a future-dated or more-than-ten-calendar-day-old live curve is rejected,
  and the visible manual continuous `r` remains the final fallback.
- Historical replay rejects any curve dated after the replay effective date.
  A legacy rates.db Treasury curve is adapted only when no dated JSON exists;
  its scalar compatibility rate comes from that same curve. Never relax this
  strict as-of rule: it is the rate-path look-ahead guard.

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
- per-group and global TWS Leg Exists Check with signed quantity comparison
- assignment / exercise conversion into deliverable underlying legs

### Execution workflows

- live open/close confirmation warns when account-level TWS netting may reduce an existing position used by another Group
- trigger conditions in trial mode
- trigger execution modes:
  - `preview`
  - `test_submit`
  - `submit`
- close-group execution using the same combo-order pipeline
- `Close Qty` supports proportional partial closes (for example, closing 1 of a 5-lot straddle leaves 4/4) and carries realized P&L forward on the remaining legs
- Delta Hedge STK / FUT validation, broker preview, submit, cancel, and active-order recovery snapshot
- optional Delta Hedge auto-preview / auto-submit supervisor behind explicit live hedge-order gate, account selection, LMT-only policy, max quantity / notional / daily count limits, and cooldown checks
- managed repricing controls:
  - continue
  - concede
  - cancel
- execution-report cost attribution back into the group
- separate close-price attribution for close-group fills

### Historical replay

- replay snapshots via the options-chain-service (default http://127.0.0.1:8750) plus local `sqlite_spy/rates.db` for rates. The service is external and swappable; `chain_service_config.py` is the only place that knows where it lives, resolving `config.ini [historical]` with `OPTION_COMBO_CHAIN_SERVICE_URL` / `_DIR` env overrides. Blank `chain_service_dir` means remote/vendor-hosted, so the launchers report it unreachable instead of trying to start a local server
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

### IV term structure

- ETF plus FOP cards configured in `iv_term_structure/iv_term_structure_config.json`
- ATM call/put aggregation, calendar finder, bucket history, and per-symbol option-stream limits
- the primary expiry table shows lambda-independent cumulative `Total Var`
  (`W×10,000`) beside annualized adjacent-expiry `Fwd Var`
  (`(W₂−W₁)/(T₂−T₁)×10,000`), using exact quote-to-expiry horizons when
  available and otherwise calendar DTE/365. Every `W` point is numerically
  inverted from the real two-sided ATM Call+Put BBO midpoint straddle after
  parity supplies the expiry forward; the display never falls back to vendor
  IV, TD IV, or fitted lambda. Missing usable BBO therefore renders `--`.
  Cumulative drops and negative forward intervals are red hard-inversion
  candidates, not automatic arbitrage claims
- the explicit `Estimate Missing Var` table control is the only exception to
  that strict display rule. It fills a strict `--` from the same Call/Put marks
  that produced the visible ATM Straddle, preserves their `model` / `last_close`
  / asynchronous-BBO provenance, and marks both recovered cumulative and
  dependent forward values with `≈` plus an estimated style. Strict BBO values
  retain priority. Forward variance uses the immediate previous expiry only;
  it must not bridge a missing row. This UI-only mode never feeds the implied-λ
  calculation or simulator handoff
- equity/index SecDef discovery prefers the exact-symbol standard trading
  class and excludes adjusted roots such as `2SPY` from the expiry calendar
- one global `TD IV fallback λ` control (default `0.30`) that re-annualizes every card until a manual straddle calculation succeeds; the frozen price-derived per-date implied-λ curve then feeds back into TD IV, directly covered closures use their own weights, later closures visibly extrapolate the curve median for the display only, and `TD Slope` is the shorter-over-longer ratio of the displayed ATM TD IV. The simulator's synchronized V2 curve remains strict by date and never receives display extrapolations
- implied λ is a separate price-derived series, not that display scalar:
  backend protocol `20260719.5` emits complete coherent underlying/call/put
  snapshots when TWS provides all receipt evidence. `js/iv_term_structure.js`
  prefers that strict snapshot, but `Calculate λ` can atomically stamp the
  currently usable two-sided BBO subset, skip bad expiries, and publish an
  audited `best_effort` curve when callback evidence is incomplete. If TWS has
  not supplied two usable BBO expiry pairs, the button remains enabled when at
  least two visible expiries have finite ATM Call/Put IV; it then publishes an
  explicitly audited `vendor_iv` / `vendor_atm_iv_fallback` estimate. This
  final tier is intentionally syncable/exportable but must never be labeled a
  strict price-derived snapshot. The
  best-effort route reconstructs omitted expiry cutoffs from product metadata,
  prefers strict intervals when they cover equally many dates, and replaces a
  partial strict result when the audited estimate recovers more closures. Raw
  signed λ is preserved: negative inversion and values above one are quality
  labels, not rejection conditions. Weekly intervals beyond the daily-expiry
  region may use a marked nearest-pure-interval baseline extrapolation. The
  structured result stays frozen, and is persisted only when `Sync to
  Simulators` is pressed through `js/implied_lambda_handoff.js`
- never move V2 calculation or synchronization into markup/render helpers.
  Card-body redraw may be intentionally suppressed while a select/input is
  focused; market-data delivery must only flag newer source quotes and must not
  trigger estimator work
- "price-derived" is not "assumption-free": the strict/BBO routes use European
  Black-76/BSM inversion, call-put parity/discounting, and a local pure-
  trading-day forward-variance baseline. The separate last-resort vendor-IV
  tier exists for incomplete TWS books and carries explicit provenance through
  handoff and simulator coverage checks
- each expiry resolves its own shared-curve `r(T)` / `D(T)` and records curve
  source/as-of/proxy/fallback diagnostics. FUT quotes may independently check
  the parity forward; ETF/index spot is never treated as an outright forward,
  and `S*exp(rT)` is not assumed when dividends/carry are unknown
- default stream limit is 20 (10 expiry pairs). The strict route retains its
  timestamp/spread/coherence checks. Best-effort mode tolerates missing callback
  evidence and spread/skew gates, but still skips crossed books and wrong-month
  futures bindings; it publishes when the retained surface yields at least one
  official-calendar interval with a finite signed estimate.
- the main simulator accepts only validated V2 `straddle` data matching symbol,
  futures month, and `liveQuoteDate`. Implied mode is strict-by-date: an
  uncovered required weekend/holiday stops projection and never uses either
  the visible scalar λ or the sample median. Portable imports preserve the real
  quote timestamp for audit but remain usable without a wall-clock timeout.
- implied-λ interval dates are revalidated against the product's official
  exchange calendar at publication/import time. Full exchange holidays share
  the interval λ with weekends; exports retain `weekendDates`, `holidayDates`,
  `nonTradingDateKinds`, calendar provenance, and a symbol/month/quote-time
  curve id. Unknown, stale, or out-of-coverage calendars fail closed.
- live valuation keeps entry/base date, exchange-derived `liveQuoteDate`, and
  scenario target date separate. A future target equal to the near expiry is
  close/settlement; on the actual live expiry date the leg instead retains
  fractional 0DTE time until its exact IB ContractDetails last-trade cutoff.
  Contract timing is cached by conId and stripped from saved sessions because
  it is transient market metadata. In the live app, missing contract timing
  blocks target-expiry legs, all surviving FOP/INDEX legs, and all surviving
  legs inside seven days; it does not silently fall back to a profile clock.
  The websocket sends qualified identity/timing through a dedicated
  `option_contract_metadata` payload immediately after subscription attach;
  this remains true when the ticker is reused from the IVTS pool and emits no
  subsequent price tick. The browser treats this payload as metadata only, so
  it cannot refresh BBO/feed timestamps or replace price/IV. Only complete
  exact timing is cached; partial ContractDetails results retry, and concurrent
  lookups for one conId use a shared in-flight request.
- live What-If is `strict-bbo` by default across valuation, main/global charts,
  Chart Lab, probability and amortized paths. Every option still live at the
  common target needs a fresh valid two-sided midpoint and successful local IV
  inversion; target-expired intrinsic legs and historical replay are exempt.
  Option/Forward/live-clock skew is capped at 30 seconds. Structured-λ clock
  errors take priority over generic BBO failures and list missing closure dates.
  `legacy-input-iv` is the only persisted compatibility opt-out.
- structured λ coverage itself has no live closure-crossing opt-out: scalar,
  Calendar/Trading basis, an unchecked IVTS control, and even the legacy IV
  compatibility path are blocked when `coverage.required && !coverage.ready`.
- signed per-date IVTS λ remains untouched in session/handoff and option
  clocks. `js/prob_charts.js` coalesces negative closure residuals into the
  nearest positive trading segments only at the Monte Carlo boundary, keeping
  the signed aggregate horizon unchanged while ensuring every Worker variance
  block is nonnegative. Do not replace this with per-date clipping; a
  nonpositive aggregate horizon is the actual fail-closed condition.
  Only the explicit `not_required` audit state proceeds without V2 dates.
- production implied-λ export requires exact ContractDetails `expiryAsOf` for
  each contributing expiry. The equation uses fractional trading/non-trading
  interval evidence on the same exchange timezone/17:00 futures rollover clock
  as pricing; integer DTE remains only compatibility metadata.
- Chart Lab's independent socket supplies daily bars and the visual price line
  only. Projection code copies the main app state and never splices the
  auxiliary price into main-socket BBO/Forward/discount timestamps.
- qualified option identity accompanies every live quote. The browser checks
  expiry/right/strike/tradingClass plus conId/localSymbol; FOP additionally
  requires verified underConId and the requested underlying futures month. A
  mismatch invalidates old price/timing evidence rather than retaining it.
- Combo Template Straddles create the exact expiration and strike entered by the
  user. There is no IBKR preflight or automatic strike rewrite; normal live
  subscription qualification reports missing contracts for manual correction.
- standard SPX and traditional quarterly AM ES/NQ/MES/MNQ cannot be represented
  as intrinsic at their last-trade screen underlier because SET/SOQ is a later
  special fixing. Those targets fail as
  `deferred_settlement_fixing_unsupported`; weekly/EOM/PM classes are unchanged.
- at current date + exact current underlier + zero IV offset, the simulator and
  both chart grids include and use the selected observable live mark. A fresh
  valid two-sided midpoint additionally seeds a per-leg local BSM/Black-76 IV
  inversion using quote-horizon Forward/r and the exact weighted clock; future
  points hold that local IV. Model/last/Portfolio/manual sources never seed the
  inversion, and an invalid attempted BBO anchor fails closed.
- calculating a new V2 still requires a coherent quote snapshot whose oldest
  leg BBO is within 120 seconds. Once calculated or explicitly imported, the
  curve is frozen without a wall-clock expiry; its original `quoteAsOf` remains
  audit evidence. Product/month and live anchor-date identity checks still
  apply, and a user-selected file may intentionally replace an automatically
  synchronized curve for that same identity.
- when changing `implied_lambda_handoff.js`, `iv_term_structure.js`, `app.js`, or
  the Time Basis control UI, update the matching HTML query-version on every
  page that loads the file and hard refresh already-open tabs. A backend restart
  alone does not replace frontend code already running in the browser
- after changing this protocol, restart `ib_server.py`; an old backend will
  keep the λ status unavailable rather than falling back to incremental quotes
- per-symbol `Load/Resume Auto JSON` selects an existing writable auto-sample
  file as the explicit append target; `New Auto JSON` creates one, and a
  separate stop/resume control pauses or resumes the bound target
- a due sample is taken immediately after load/create, then refreshed and
  appended hourly while the page stays open; a 60s monitor plus focus and
  visibility checks only ask whether a sample is *due* — due-ness is elapsed
  time alone (`shouldRunAutoSample`), never the calendar date. A date trigger
  would be redundant with the elapsed check on every real gap, and would
  additionally fire minutes after the previous sample whenever the UTC day
  rolled over mid-cadence (00:00 UTC is ~20:00 ET, a boundary this sampler has
  no reason to care about).
- hourly automatic rows are retained, while MRR continues to dedupe by quote
  date and therefore uses the last valid sample for each date
- forward trading calendars come only from the generated official snapshot:
  NYSE public calendar plus CME Reference Data API product schedules
- run `sync_exchange_calendars_mac.command` or `sync_exchange_calendars.bat`
- the browser has no computed-holiday fallback; product `calendarId` is passed
  through date utilities, pricing, simulation controls, and IVTS. Missing or
  stale coverage is unavailable rather than assumed open. Historical replay
  receives observed exchange sessions from the chain service.
  weekly; products without official coverage remain fail-closed in IVTS

## 3. Important Entry Points

### Frontend

- `index.html`
- `chart_lab.html`
- `iv_term_structure.html`

### Backends

- `ib_server.py`
- `ib_server_ws.py`
- `ib_server_market_data.py`
- `ib_server_iv_term_structure.py`
- `historical_server.py`
- `historical_replay_service.py`
- `historical_data.py`

### Startup scripts

Windows wrappers:

- `start_option_combo.bat`
- `start_historical_replay.bat`
- `update_yield_curve.bat`
- `install_ib_bridge_deps.bat`

Underlying PowerShell scripts:

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

POSIX / macOS:

- `start_option_combo.sh`
- `update_yield_curve.sh`
- `start_option_combo_mac.command`
- `start_historical_replay_mac.command`
- `update_yield_curve_mac.command`
- `install_ib_bridge_deps_mac.command`
- `cleanup_logs_mac.command`

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
9. `js/delta_hedge_logic.js`
10. `js/combo_order_transport.js`
11. `js/ws_client.js`
12. `ib_server_order_tracking.py`
13. `ib_server.py`
14. `historical_replay_service.py`
15. `trade_execution/adapters/ibkr.py`

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

- browser product coverage includes `MES`, `MNQ`, `GC`, `SI`, and `HG`
- `ib_server.py`'s `SUPPORTED_LIVE_FAMILIES` currently hard-codes live-family defaults for `ES`, `NQ`, `MES`, `MNQ`, `CL`, and `SI`
- `MES` / `MNQ` live defaults intentionally omit unverified `trading_class` values until concrete TWS contract descriptions are confirmed
- `GC` and `HG` remain browser-pricing families until backend contract defaults are verified

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

### `js/delta_hedge_logic.js`

This is the pure Delta Hedge decision layer.

It handles:

- configuration normalization
- STK / FUT hedge recommendation sizing
- target Delta / tolerance / proactive-buffer behavior
- LMT auto-price helpers
- resting-order applicability and stale-review decisions
- auto-preview / auto-submit decision gating

It does not touch DOM or WebSocket transport.

### `js/delta_hedge_ui.js`

This module handles the Delta Hedge configuration dialog and persistent global status banner, including configuration bindings plus recommendation, broker-preview, submit, cancel, clear, stale-review, and automation status updates in the DOM.

### `js/delta_hedge_transport.js`

This module owns Delta Hedge WebSocket payload construction and frontend request state transitions for:

- `validate_hedge_order`
- `preview_hedge_order`
- `submit_hedge_order`
- `cancel_hedge_order`

### `js/ws_client.js`

This remains the main frontend transport layer.

Current responsibilities include:

- live subscribe payload assembly
- pooled manual underlying sync through `sync_underlying`
- historical snapshot requests
- portfolio average-cost syncing
- managed-account syncing
- websocket connect / reconnect and generic message fanout
- historical auto-settlement and replay-cost seeding
- incremental live-quote derived-value refreshes

### `js/combo_order_transport.js`

This module now owns the combo-order request/response state machine for:

- trigger preview / submit flow
- close-group preview / submit flow
- managed resume / concede / cancel requests
- combo preview/result/status/error/fill reducers
- historical trigger preview and historical close-group settlement shortcuts

### `ib_server.py`

Current server responsibilities:

- IB connection lifecycle
- pooled live quote subscriptions, including generic-tick upgrades for Greeks
- price-independent option contract metadata handoff for pooled subscribers
- managed-account snapshot fan-out
- portfolio average-cost snapshot fan-out
- authoritative `ib.positions()` quantity snapshot fan-out for Leg Exists and Close checks; do not use `updatePortfolioEvent` as the complete position universe
- combo preview / validation / submit dispatch through `trade_execution/`
- Delta Hedge validation / preview / submit / cancel dispatch through `trade_execution/`
- historical replay snapshots through `HistoricalReplayService`
- historical daily bars for Chart Lab
- chain-service fallback bars when IB historical bars are unavailable

Important operational detail:

- the IB connection is started in the background so replay and fallback paths can still work if TWS is down
- direct business flows should not call `ib.reqMktData` outside `ib_server_market_data.py`; use the pooled helper so duplicate contract streams do not leak TWS market-data lines

### `ib_server_order_tracking.py`

This module now owns the combo/hedge tracking consumer layer for:

- tracking lookup and snapshot update helpers
- combo / hedge order-status payload assembly
- combo / hedge error and fill payload assembly
- IB `orderStatus`, `error`, and `execDetails` event-consumer handler factories
- active hedge snapshot rebuilding after websocket reconnects

### `historical_server.py`

This is intentionally much smaller than `ib_server.py`.

Current responsibilities:

- historical quote snapshots
- empty portfolio avg-cost payloads for historical mode

Not implemented there today:

- live execution
- managed accounts
- Delta Hedge broker preview / submit / cancel
- Chart Lab bar endpoint
- IV term-structure sync

## 6. Current Known Boundaries

- `chart_lab.html` is still experimental.
- Chart Lab always opens `ws://127.0.0.1:<port>`; it does not expose a host override like `index.html`.
- Chart Lab daily bars come from `request_historical_bars`, which currently exists in `ib_server.py`, not `historical_server.py`.
- The options-chain-service daily-bar fallback for Chart Lab is therefore only reachable through `ib_server.py`.
- `historical_server.py` normalizes its bind host to localhost and is replay-only by design.
- Active-order recovery only rebinds orders when workspace/group identity and backend tracking metadata still match; browser-only automation state is not backend-persisted.
- `contract_specs/*.xml` remain reference material; runtime truth lives in `js/product_registry.js`.
- If multiple unmanaged `ib_server.py` processes are running, broker-status debugging becomes unreliable because the browser may be talking to a different process than the logs you are inspecting.

## 7. Practical Maintenance Notes

- On Windows, use `powershell_scripts/resolve_python.ps1`; do not assume bare `python`.
- Codex launcher logs and pid files now live under `logs/`; `scripts/cleanup_runtime_logs.py` also cleans legacy root-level runtime files.
- `index.html` and `chart_lab.html` are still ordered-script apps. Load order matters.
- combo-order transport now loads before `js/ws_client.js`; if combo preview/submit flows go `undefined`, check script order first.
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
- Shared backend runtime payload contracts now live in `runtime_contracts.py`; shared combo/hedge tracking shape lives in `trade_execution/order_tracking.py`.

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
- delta hedge logic / transport / UI
- app orchestration
- WebSocket client

Important nuance:

- `tests/run.js` includes every `tests/*.test.js` suite, including forward-carry and pricing-context coverage
- the full Python suite is `python -m unittest discover -s tests -p "*_test.py"` using the project-resolved interpreter
- WebSocket routing coverage for the live backend now lives in `tests/ib_server_ws_test.py`
- combo-order transport coverage now lives in `tests/combo_order_transport.test.js`
- live tracking-consumer coverage now lives in `tests/ib_server_order_tracking_test.py`
- shared combo/hedge tracking helper coverage now lives in `tests/order_tracking_test.py`
- hedge execution engine / adapter coverage lives in `tests/trade_execution_engine_test.py` and `tests/ibkr_hedge_adapter_test.py`
- `node scripts/validate_calendar_projection.js` is the read-only real-data EOD
  calendar convergence harness. It loads the production JS pricing runtime,
  refuses incomplete structured lambda dates, and keeps its ETF/EOD limitation
  explicit; it is not a substitute for an intraday ES/FOP recorder.

## 9. Suggested Read Orders

### Product / pricing changes

- `js/product_registry.js`
- `js/market_curves.js`
- `js/index_forward_rate.js`
- `js/pricing_context.js`
- `js/pricing_core.js`
- `js/valuation.js`

### Yield curve / rates changes

- `yield_curve/README.md`
- `yield_curve/builder.py`
- `yield_curve/sources/`
- `yield_curve/repository.py`
- `yield_curve/backend_adapter.py`
- `ib_server.py` and `historical_server.py` (read-only integration only)
- `js/market_curves.js`
- `js/ws_client.js`

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
- `js/delta_hedge_logic.js`
- `js/delta_hedge_ui.js`
- `js/group_editor_ui.js`
- `js/group_ui.js`
- `js/combo_order_transport.js`
- `js/ws_client.js`
- `ib_server_order_tracking.py`
- `ib_server.py`
- `trade_execution/engine.py`
- `trade_execution/adapters/ibkr.py`
