# Option Combo Simulator Architecture

## 1. System Shape

This repo is a plain browser application plus optional Python WebSocket backends. There is no frontend build step, bundler, or module loader; each HTML page loads ordered global scripts.

Runtime surfaces:

1. `index.html`
   - main multi-group portfolio workspace
   - supports live IBKR mode and historical replay mode (options-chain-service backed)

2. `chart_lab.html`
   - shared portfolio workspace plus a separate Chart Lab tab
   - overlays portfolio payoff projections onto daily bars

3. `iv_term_structure.html`
   - standalone live ETF / futures-option IV term-structure monitor
   - syncs ATM option pairs by expiry and appends samples to per-symbol JSON history files

4. Python backends
   - `ib_server.py` for live IBKR market data, live execution, Chart Lab bars, IV term-structure sync, and historical fallback paths
   - `historical_server.py` for historical replay snapshots only (options-chain-service backed)

5. Optional Docker lifecycle layer
   - `option_combo_starter/supervisor.py` runs as PID 1
   - the HTTP server and `ib_server.py` are critical child processes
   - the backend remains the sole owner of IB reconnect attempts
   - yield-curve refresh is a separately scheduled, non-critical maintenance
     job that cannot restart the container

## 2. Frontend Entry Surfaces

### `index.html`

The main app shell owns:

- workspace chrome and locked live/historical routes
- control panel
- combo-group editor
- hedge editor
- global cards and summaries
- group/global P&L charts
- amortized and probability analysis
- trial trigger controls
- close-group execution controls
- live account selection and WebSocket endpoint controls
- Delta Hedge recommendation, broker preview, manual submit, cancel, clear, and guarded automation controls

Locked routes:

- `index.html?entry=live&marketDataMode=live&lockMarketDataMode=1`
- `index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1`

### `chart_lab.html`

Chart Lab is intentionally separate from the main shell, but it loads the same shared runtime before loading `js/chart_lab.js`.

It currently:

- reads state through `window.__optionComboApp`
- opens its own WebSocket connection
- requests `request_historical_bars` from `ib_server.py`
- falls back to chain-service daily bars through `ib_server.py` when IB bars are unavailable
- projects either one group or the included global portfolio onto a daily candle canvas

The overlay is a visualization aid, not a complete time-path model.

### `iv_term_structure.html`

The IV term-structure page is standalone and does not load the main portfolio runtime.

It currently:

- loads config from `iv_term_structure/iv_term_structure_config.json`, with embedded defaults if fetch fails
- loads bundled history from `iv_term_structure/data/*.json`
- opens one WebSocket per active symbol sync
- uses `subscribe_iv_term_structure` on `ib_server.py`
- uses `request_ib_connection_status` and `connect_ib` to show/connect IB state
- builds bucket rows in `js/iv_term_structure_core.js`
- can append samples to opened/imported per-symbol JSON history documents
- can load/resume a separate writable per-symbol auto-sample JSON as the
  visible append target, or create a new one, then refresh/append an ATM
  snapshot hourly while the page is open; manual and automatic samples are
  merged only for signal computation, not into either source file

## 3. Ordered Script Runtime

Current `index.html` load order:

1. `js/t_params_db.js`
2. `js/regime_conditional_samples.generated.js`
3. `js/official_exchange_calendars.generated.js`
4. `js/market_holidays.js`
5. `js/date_utils.js`
6. `js/implied_lambda_handoff.js`
7. `js/product_registry.js`
8. `js/market_curves.js`
9. `js/index_forward_rate.js`
10. `js/pricing_context.js`
11. `js/trade_trigger_logic.js`
12. `js/group_order_builder.js`
13. `js/leg_position_check.js`
14. `js/order_safety.js`
15. `js/order_confirmation_ui.js`
16. `js/delta_hedge_logic.js`
17. `js/distribution_proxy_config.js`
18. `js/pricing_core.js`
19. `js/bsm.js`
20. `js/chart.js`
21. `js/prob_charts.js`
22. `js/chart_controls.js`
23. `js/amortized.js`
24. `js/valuation.js`
25. `js/session_logic.js`
26. `js/session_ui.js`
27. `js/control_panel_ui.js`
28. `js/hedge_editor_ui.js`
29. `js/group_editor_ui.js`
30. `js/hedge_ui.js`
31. `js/group_ui.js`
32. `js/global_ui.js`
33. `js/page_capabilities.js`
34. `js/combo_order_transport.js`
35. `js/delta_hedge_transport.js`
36. `js/delta_hedge_ui.js`
37. `js/calendar_handoff.js`
38. `js/app.js`
39. `js/ws_client.js`

`chart_lab.html` keeps the same shared shell ordering where relevant, but intentionally omits the Delta Hedge panel logic/UI. Its tail order is:

1. `js/page_capabilities.js`
2. `js/combo_order_transport.js`
3. `js/delta_hedge_transport.js`
4. `js/app.js`
5. `js/ws_client.js`
6. `js/chart_lab.js`

`iv_term_structure.html` uses its own small runtime:

1. official calendar snapshot, `js/market_holidays.js`, and `js/date_utils.js`
2. `js/product_registry.js`
3. `js/calendar_handoff.js`
4. `js/market_curves.js`
5. `js/implied_lambda_handoff.js`
6. `js/iv_term_structure_core.js`
7. `js/iv_term_structure.js`

If browser runtime behavior suddenly becomes `undefined`, load order is still the first thing to check.

## 4. Layer Breakdown

### 4.1 Static shell and styles

- `index.html`
- `chart_lab.html`
- `iv_term_structure.html`
- `style.css`
- `chart_lab.css`
- `iv_term_structure.css`

Responsibilities:

- page layout
- templates
- containers for charts and summaries
- workspace-specific copy and controls

### 4.2 Product and pricing metadata

- `js/product_registry.js`
- `js/market_curves.js`
- `js/index_forward_rate.js`
- `js/distribution_proxy_config.js`

Responsibilities:

- product-family metadata
- option and underlying security types
- multipliers
- trading classes
- default futures-month logic
- forward-rate usage rules
- typed discount / forward / carry curve construction and bounded resolution
- hard runtime separation of discount `r`, outright `F`, and carry `r-q`
- probability-distribution proxy selection

`js/product_registry.js` is the browser-side source of truth for supported families.

#### Forward / Carry / Discount boundary

`js/market_curves.js` is the shared DOM-free curve boundary:

- Discount: `D(T)=exp(-r(T)T)`, used only for discounting
- Forward: outright `F(T)`
- Carry: `b(T)=r(T)-q(T)=ln(F(T)/S)/T`

Each curve has a distinct runtime `kind`; resolvers fail on kind mismatch. The
canonical schema-v2 discount snapshot stores `D(T)`, point-level provenance,
and source effective dates. The generic adapter preserves SOFR/blend/Treasury
proxy semantics; the old Treasury-specific adapter remains compatibility-only.

INDEX forward samples use coherent same-expiry call/put/spot quotes and exact
discount-aware parity `F=K+(C-P)/D`. FOP pricing uses the leg-bound futures
quote as `F`. Neither route passes carry `r-q` to Black-76 as discount `r`.
INDEX parity uses the fractional interval from the latest call/put/spot BBO
timestamp to the common ContractDetails `expiryAsOf`; invalid evidence clears
the old sample even while its panel is collapsed. Live FOP pool quotes are
generation-scoped and independently verified by qualified contract identity
and 120-second freshness before they can become a Black-76 input.
An INDEX option without a usable parity sample fails closed; spot remains valid
only for an explicit underlying leg. An explicitly bound FOP leg without its
future quote also fails closed. The sole degraded compatibility route is an
unbound legacy FOP workspace with exactly one Futures Pool entry.

ES/NQ daily and weekly FOP `tradingClass` values are qualification output, not
weekday-derived request constraints. The browser omits that unverified hint,
then validates the returned conId/localSymbol, expiry, right, strike,
multiplier, and authoritative underlying-futures binding. A one-entry Futures
Pool auto-binds unbound option legs, and an unchanged subscription signature
does not reset the current quote generation.

Combo Template Straddles are intentionally input-driven: the dialog creates the
requested expiration and strike without an IBKR discovery round trip or strike
rewrite. Existing subscription qualification remains the downstream
contract-existence gate and surfaces missing contracts for manual correction.

`buildForwardCarrySnapshot()` / `OptionComboWsLiveQuotes.getForwardCarrySnapshot()`
publish the product policy plus structured points. ES/MES may compare futures
with SPX and NQ/MNQ with NDX for diagnostic net carry. Those optional reference
subscriptions are non-blocking and never enter Black-76. Annualized diagnostic
carry requires exact futures expiry plus fresh future/reference timestamps with
no more than 120 seconds of quote age or skew; a failed gate leaves outright
futures points intact and sets `carryRate=null` with `carryQuality.flags`. CL/HG
and GC/SI expose their exchange futures curve directly and never manufacture
carry from USD `r`. Adjacent FOP points additionally publish log forward change,
per-day slope, and annualized roll slope only when both exact expiries exist.

Live consumers reject future-dated discount curves and fall back after ten
calendar days; historical replay instead applies strict latest-on-or-before
selection for its effective date.

### 4.3 Pricing and scenario context

Live option projections use one observable-price boundary. In the default
midpoint mode, only a fresh transport-validated two-sided BBO may seed the
local IV inversion. The inversion uses quote-horizon spot/Forward, discount
rate, and exact weighted quote-to-expiry time; target repricing holds that
per-leg local IV on the remaining clock. Model/last/Portfolio/manual prices do
not enter this calibration, and a bad BBO anchor fails closed. Live sessions
default to `projectionConvergenceMode=strict-bbo`: every option surviving the
target must have a successful local anchor, while a target-expired intrinsic
leg is exempt. Option, spot/Forward and live-clock evidence must be within 30
seconds even though general quote freshness remains 120 seconds. Historical
replay bypasses this live gate; `legacy-input-iv` is explicit saved-session
compatibility only. Websocket disconnects invalidate the gate immediately; a
5-second watchdog independently detects 120 seconds without market payloads so
a frozen `liveQuoteAsOf` cannot keep an old BBO fresh forever. A third value,
`best-effort-input-iv`, is a per-payoff-chart-card display override: for a card
with best-effort projection enabled, `js/chart_controls.js` clones the workspace
state locally for that card's `PnLChart.draw()` only, letting the projection fall
back to the leg's input IV when no live BBO anchor is available. It never mutates
the workspace convergence mode, so the valuation, probability, session, and
execution gates keep their strict semantics.
The shared preflight also treats structured λ as mandatory whenever any option
surviving the target crosses a weekend or full closure. Selecting a scalar,
Calendar/Trading basis, or disabling the IVTS box cannot bypass that gate;
`not_required` is the only exemption.

The IVTS λ solver and simulator share the same exact timestamp clock. Export
requires ContractDetails `expiryAsOf`, and interval evidence carries fractional
trading/non-trading days using exchange timezone plus CME-family 17:00
trade-date rollover. Chart Lab's auxiliary websocket is restricted to bars and
visual overlays; all projection inputs come from the main websocket state.

- `js/pricing_context.js`
- `js/pricing_core.js`
- `js/bsm.js`
- `js/amortized.js`

Responsibilities:

- anchor underlying interpretation
- quote-date and simulation-date semantics
- entry date, rolling exchange trade date, and scenario target remain separate
- futures-pool and forward-rate mapping
- BSM and Black-76 pricing
- weighted variance clocks with scalar or per-non-trading-date λ
- probability MC horizons resolved as official-calendar `[quote,target)` daily
  weights; the Worker consumes the same scalar/`byDate` λ clock instead of
  reverting to calendar-day variance. Signed negative closure residuals are
  coalesced with adjacent positive trading segments at the Worker boundary, so
  simulation blocks are nonnegative while their sum remains the exact signed
  effective horizon
- probability leg repricing carries explicit `varianceT` and calendar
  `discountT`: equity/ETF legs use BSM, while index/FOP legs use Black-76
- live 0DTE fractional time from IB ContractDetails last-trade metadata; the
  live safety gate requires contract-source timing for target-expiry legs,
  every surviving FOP/INDEX leg, and every surviving leg inside seven days
- price-independent `option_contract_metadata` handoff after each qualified
  subscription attach; pooled IVTS/portfolio reuse does not wait for another
  BBO tick, and the browser updates identity/timing without touching quote or
  feed clocks
- exact-timing cache admits only complete ContractDetails evidence (plus
  verified FOP underlying binding); partial results retry on later subscribe,
  while same-conId concurrent lookups share one in-flight request
- defensive product-profile cutoffs remain only for historical/explicit
  compatibility paths and longer-dated stock/ETF cases in live portfolio
  pricing. The separate manual IVTS estimator may use a product-profile cutoff
  as audited best-effort evidence when IB omits ContractDetails timing; this
  does not weaken the simulator leg-timing gate
- AM special-fixing contracts (standard SPX and traditional quarterly AM
  ES/NQ/MES/MNQ) fail closed after last trade because the settlement variable
  is not the contemporaneous screen underlier
- live option payload identity is verified against qualified IB contract facts;
  FOP `underConId` and actual underlying month must match the request before a
  quote or its ContractDetails timing may enter pricing
- observable live-mark anchoring at the exact current underlier/no-IV-shock
  point; neighboring scenario points stay model-priced
- underlying-leg handling
- amortized-cost math

Notes:

- `pricing_core.js` is the primary pricing implementation.
- `bsm.js` remains as a compatibility bridge for older global call sites.

### 4.4 Derived portfolio state

- `js/valuation.js`
- `js/session_logic.js`
- `js/trade_trigger_logic.js`
- `js/delta_hedge_logic.js`
- `js/group_order_builder.js`
- `js/leg_position_check.js`
- `js/order_safety.js`

Responsibilities:

- group and portfolio derived values
- global aggregation
- session import/save snapshot normalization
- trigger configuration and runtime state rules
- delta hedge recommendation, resting-order applicability, and automation rules
- open-combo and close-combo payload assembly
- complete-strategy-unit sizing for proportional partial closes
- canonical broker order intents, allocation-aware position-impact checks, and strict preview binding

Open Combo and Delta Hedge are fail-closed behind a shared confirmation surface
and a backend one-time execution authorization. Close Plan retains its richer
staged-plan confirmation and existing one-time token.

### 4.5 UI binding and DOM writes

- `js/session_ui.js`
- `js/control_panel_ui.js`
- `js/group_editor_ui.js`
- `js/hedge_editor_ui.js`
- `js/group_ui.js`
- `js/hedge_ui.js`
- `js/global_ui.js`
- `js/delta_hedge_ui.js`
- `js/order_confirmation_ui.js`

Responsibilities:

- control binding
- group and hedge editor rendering
- mode toggles
- live status rendering
- execution status rendering
- Delta Hedge configuration dialog, persistent global status banner, manual order controls, and automation status display
- derived-value writes back into the DOM

### 4.6 Charts and analysis

- `js/chart.js`
- `js/chart_controls.js`
- `js/prob_charts.js`
- `js/chart_lab.js`

Responsibilities:

- per-group P&L charts
- global P&L chart
- per-group and global amortized charts
- probability charts
- daily K projection lab

Important distinction:

- `chart.js` / `chart_controls.js` own the core payoff charting used by the main app.
- `chart_lab.js` consumes the same state and pricing helpers but renders onto a price chart instead of the standard P&L axes.

### 4.7 IV term-structure monitor

- `iv_term_structure.html`
- `iv_term_structure.css`
- `js/iv_term_structure.js`
- `js/iv_term_structure_core.js`
- `iv_term_structure_service.py`
- `iv_term_structure/iv_term_structure_config.json`
- `iv_term_structure/data/*.json`

Responsibilities:

- standalone per-symbol IV monitor UI
- bucket definitions and DTE matching
- ATM strike window selection
- standard equity/index trading-class filtering so adjusted deliverables such
  as `2SPY` do not leak into the normal expiry calendar
- live call/put IV aggregation
- calendar-day IV and trading-day IV derived through one global weekend/holiday variance weight
- a separate implied-weekend-λ path that consumes only immutable coherent
  whole-curve snapshots, exact two-sided straddle prices, per-expiry parity
  forwards, and numerical total-variance inversion
- per-expiry discount observations from the shared Discount curve; the manual
  continuous `r` is a row-level fallback, not a substitute for carry
- FUT underliers may provide an independent outright Forward check. ETF/index
  spot is never relabelled as `F` and `S*exp(rT)` is not assumed when `q` is unknown
- strict V2 handoff to the main simulator, keyed by symbol, futures contract
  month, and live quote anchor; when implied mode is enabled every required
  non-trading date must be explicitly covered and the scalar never fills holes
- coherent-snapshot events update only the latest immutable estimator input.
  V2 derivation runs only when the user presses `Calculate λ`; the result is
  frozen for inspection and live ticks merely mark it as superseded. `Sync to
  Simulators` explicitly publishes that frozen curve, and `Export JSON` writes
  the same strict document for another origin or machine
- consumers coalesce repeated same-origin storage events into one animation-
  frame refresh and defer hidden-tab valuation until visibility returns.
  Calculated and explicitly imported V2 curves are frozen without a wall-clock
  timeout; their original market `quoteAsOf` remains audit evidence. Product,
  futures-month, live anchor-date, calendar, and strict date-coverage checks
  remain mandatory
- `js/market_holidays.js` is an official-snapshot reader only; it contains no
  holiday rule engine. `js/date_utils.js` carries each product's `calendarId`
  through pricing and UI calculations and fails closed outside official
  coverage. Historical replay supplies explicit observed session dates from
  the chain service for archive years that the forward snapshot cannot cover.
- per-symbol historical sample documents
- testable DOM-free JS and Python selection helpers

### 4.8 State container, capabilities, and transport orchestration

- `js/page_capabilities.js`
- `js/app.js`
- `js/combo_order_transport.js`
- `js/delta_hedge_transport.js`
- `js/ws_client.js`

Responsibilities:

- page-kind capability gating for ordered global-script pages
- owns the in-memory `state`
- initializes UI
- coordinates render passes
- hosts the websocket connection lifecycle
- delegates combo-order request/response state to `js/combo_order_transport.js`
- delegates delta-hedge broker request/response state to `js/delta_hedge_transport.js`
- imports JSON sessions and saves JSON snapshots
- exposes `window.__optionComboApp`

`js/app.js` and `js/ws_client.js` are orchestration bridges, not the main place for combo-order or delta-hedge transport state machines.

### 4.9 Live / shared backend stack

- `ib_server.py`
- `trade_execution/engine.py`
- `trade_execution/models.py`
- `trade_execution/adapters/base.py`
- `trade_execution/adapters/ibkr.py`
- `iv_term_structure_service.py`

Responsibilities:

- single-owner background IB connection lifecycle with immediate recovery and
  fixed ten-minute retry scheduling
- exact error-326 client-ID collision handling; no other failure changes the ID
- generation-based market-data invalidation and one-time frontend subscription
  replay after unexpected/startup recovery
- pooled live underlying, option, futures, and stock-hedge subscriptions
- dedicated option contract metadata fan-out independent of market-data ticks
- product-aware IBKR contract qualification
- portfolio average-cost snapshots
- full account-level position snapshots from `ib.positions()` used by Group/Global Leg Exists Check and close validation; quantity truth does not depend on `updatePortfolioEvent`
- managed account snapshots
- historical daily bars for Chart Lab
- chain-service daily-bar fallback for Chart Lab
- historical replay snapshots through `HistoricalReplayService`
- IV term-structure catalog selection and option subscriptions
- combo validation, preview, test submit, and live submit
- pre-submit warnings when an order would reduce an existing net TWS position
- STK / FUT Delta Hedge validation, preview, submit, cancel, and active-order snapshot flows
- managed repricing and order supervision, with fail-closed pause on IB or
  market-data reset while the broker order remains live
- close-group execution through the same managed order path
- execution-report attribution back into group legs

### 4.10 Historical replay stack

- `historical_server.py`
- `historical_data.py`
- `historical_replay_service.py`

Responsibilities:

- historical quote reads: option chains + underlying bars over HTTP from the shared options-chain-service; discounting from the same dated JSON repository used live
- replay-day underlying snapshot and option snapshot payloads
- replay-date normalization
- strict latest-on-or-before discount-snapshot hydration
- read-only legacy Treasury SQLite adaptation for dates not yet backfilled, with future-date rejection
- expiry-date underlying snapshots for auto-settlement flows
- lightweight historical-mode WebSocket responses

`historical_server.py` is intentionally narrow: it does not provide live subscriptions, live execution, Chart Lab bars, or IV term-structure sync.

### 4.10.1 Standalone USD reference yield curve

- `yield_curve/__main__.py`
- `yield_curve/sources/`
- `yield_curve/builder.py`
- `yield_curve/repository.py`
- `yield_curve/backend_adapter.py`
- `[yield_curve]` in `config.ini`

`python -m yield_curve update` is the only current-data writer. It downloads
official overnight SOFR and Treasury CMT, constructs one schema-v2 discount
snapshot, and atomically replaces a real (non-symlink) `latest.json` while also
writing a dated history file. The backends are read-only consumers. In a
non-Docker launch, a missing or stale live file can trigger the independent CLI
once via `sys.executable`. The Docker config overlay disables those backend
auto-update paths so the PID-1 scheduler is its sole automatic writer. There is
no server-owned downloader or periodic Treasury task.

The builder uses SOFR through 30 calendar days, transitions in instantaneous-
forward space to the first later CMT node, then preserves the CMT proxy forward
slope. Canonical interpolation is in `-ln(D)`. SOFR 30/90/180 Averages are
backward-looking diagnostics only, and CMT is a par-yield proxy rather than an
official zero/OIS curve. Every point carries source, source effective date,
quality, and snapshot id.

### 4.11 Startup and maintenance scripts

- `start_option_combo.bat`
- `start_historical_replay.bat`
- `update_yield_curve.bat`
- `install_ib_bridge_deps.bat`
- `cleanup_logs.bat`
- `start_option_combo_mac.command`
- `start_historical_replay_mac.command`
- `update_yield_curve_mac.command`
- `start_option_combo.sh`
- `update_yield_curve.sh`
- `install_ib_bridge_deps_mac.command`
- `cleanup_logs_mac.command`
- `scripts/cleanup_runtime_logs.py`
- `powershell_scripts/*.ps1`

Responsibilities:

- Python resolution
- local service launch
- Codex/background service launch and restart
- dependency installation
- standalone official yield-curve refresh and local snapshot inspection
- local runtime log and stale pid cleanup

`option_combo_starter/` is intentionally a separate deployment layer.
`entrypoint.sh` performs checkout/config/dependency setup and then execs
`supervisor.py`. PID 1 restarts neither child for an ordinary TWS disconnect;
`ib_server.py` reconnects in-process. A critical HTTP/backend process exit
causes PID 1 to stop its peer and exit non-zero for Docker restart policy.
Yield maintenance uses the same configured data directory as both backends and
persists it in `/app/state/yield_curve`. PID 1 makes one automatic attempt at
09:30 America/New_York on each weekday and persists the attempted New York
date across container replacement. It never retries that day after a failed,
partial, timed-out, or cache-fallback result; the previous successful snapshot
remains active. The maintenance task is optional and cannot stop a critical
child or restart the container. Its settings are
`OPTION_COMBO_YIELD_DAILY_HOUR_NY` (default `9`),
`OPTION_COMBO_YIELD_DAILY_MINUTE_NY` (default `30`),
`OPTION_COMBO_YIELD_PROCESS_TIMEOUT_SECONDS` (default `120`), and
`YIELD_CURVE_DATA_DIR` (default `/app/state/yield_curve`).

## 5. Shared State Model

`js/app.js` owns a single in-memory state object. Important top-level fields include:

- `underlyingSymbol`
- `underlyingContractMonth`
- `underlyingPrice`
- `baseDate`
- `historicalQuoteDate`
- `simulatedDate`
- `marketDataMode`
- `interestRate`
- `ivOffset`
- `forwardRateSamples`
- `futuresPool`
- `selectedLiveComboOrderAccount`
- `groups`
- `hedges`
- `deltaHedge`

Important group fields include:

- `id`
- `name`
- `viewMode`
- `includedInGlobal`
- `isCollapsed`
- `tradeTrigger`
- `closeExecution`
- `settleUnderlyingPrice`
- `historicalAutoCloseAtExpiry`
- `syncAvgCostFromPortfolio`
- `livePriceDisplayMode`
- `legs`

Important leg fields include:

- `id`
- `type`
- `pos`
- `strike`
- `expDate`
- `iv`
- `currentPrice`
- `cost`
- `closePrice`
- `ivSource`
- `ivManualOverride`
- `closePriceSource`

Runtime-only fields may also be attached during broker sync and historical replay.

## 6. Product Support Model

Browser-side support in `js/product_registry.js`:

- default equity / ETF option flow
- cash-settled index options:
  - `SPX`
  - `NDX`
- futures options:
  - `ES`
  - `NQ`
  - `MES`
  - `MNQ`
  - `CL`
  - `GC`
  - `SI`
  - `HG`

Current architecture includes:

- family-aware secType and exchange resolution
- Black-76 pricing support for index/FOP paths
- BSM spot pricing for default equity/ETF paths
- product-aware multipliers
- product-aware display precision and combo increments
- futures underlying-leg support
- cash-settled index option handling

Live backend nuance:

- `ib_server.py` has explicit `SUPPORTED_LIVE_FAMILIES` defaults for `ES`, `NQ`, `MES`, `MNQ`, `CL`, and `SI`.
- `SPX` and `NDX` use index exchange fallbacks.
- The browser registry knows about `GC` and `HG`; live contract qualification may still require extra verification for those families.
- `MES` and `MNQ` backend defaults intentionally omit unverified trading classes and rely on underConId-assisted qualification paths.

## 7. Backend WebSocket Responsibilities

`ib_server.py` is now the live-backend composition layer. It owns:

- process startup and shutdown
- IB lifecycle and reconnect task wiring
- shared callback registration
- helper assembly for the WebSocket handler environment

Supporting live-backend helper modules:

- `ib_connection_supervisor.py`
  - the single persistent TWS/API connection owner
  - fixed retry scheduling and exact error-326 client-ID fallback
  - ordered disconnect/connect lifecycle callbacks
- `ib_server_ws.py`
  - WebSocket session lifecycle
  - action dispatch and connection cleanup
- `ib_server_order_tracking.py`
  - combo / hedge order tracking lookup helpers
  - order-status / error / fill payload builders
  - IB event-consumer handler factories
  - active hedge snapshot assembly
- `ib_server_market_data.py`
  - quote extraction
  - pending-ticker fanout
  - coherent `iv_term_structure_quote_snapshot` assembly: all intended option
    subscriptions, the underlying, real BBOs, receipt timestamps, and a shared
    snapshot identity must pass the age/skew gates before publication
  - historical-bars request serialization
  - pooled market-data subscription / generic tick upgrade helpers
  - market-data subscription cleanup helpers
- `ib_server_iv_term_structure.py`
  - IV term-structure subscription workflow
  - expiry/strike selection bundling
  - background sync task lifecycle

`ib_server_ws.py` owns the client session lifecycle and WebSocket action dispatch for these high-level message families:

- `subscribe`
  - live underlying/options/futures/stocks
  - optional option Greeks via generic tick `106`
- `sync_underlying`
  - manual underlying refresh through the pooled market-data helper
  - one-shot lines are canceled when no active subscription shares the contract
- `request_historical_snapshot`
  - shared historical replay through the options-chain-service
- `request_historical_bars`
  - Chart Lab bars via IB, with chain-service fallback for daily bars
- `request_portfolio_avg_cost_snapshot`
- `request_managed_accounts_snapshot`
- `request_ib_connection_status`
- `connect_ib`
- `subscribe_iv_term_structure`
- combo and hedge execution actions routed through `ExecutionEngine`
  - validate
  - preview
  - test submit
  - live submit
  - resume / concede / cancel managed combo orders
  - cancel hedge orders

The split is intentional:

- `ib_server.py` should remain the entry-point/orchestration layer
- `ib_server_ws.py` should remain the request-routing and connection-cleanup layer
- `ib_server_order_tracking.py` should remain the combo/hedge tracking-consumer layer
- `ib_server_market_data.py` should remain the live quote / bars helper layer
- `ib_server_iv_term_structure.py` should remain the IV sync helper layer
- execution-specific action semantics should remain behind `ExecutionEngine`

`historical_server.py` handles:

- `request_historical_snapshot`
- `request_portfolio_avg_cost_snapshot` with an empty item list

Any other message to `historical_server.py` returns a historical replay error.

## 8. Historical Replay Architecture

Historical replay is implemented as a first-class runtime mode in the main workspace.

Main flow:

1. frontend sets `marketDataMode = historical`
2. `js/ws_client.js` requests historical snapshots
3. `historical_server.py` or `ib_server.py` routes to `HistoricalReplayService`
4. `historical_replay_service.py` pulls data through `historical_data.py`
5. `historical_data.py` fetches option chains and underlying bars over HTTP from the options-chain-service (default `http://127.0.0.1:8750`) and reads the strict on-or-before unified curve JSON. A Treasury-only `rates.db` adapter is the marked migration fallback for dates not yet backfilled. The chain service is external and swappable — the coupling is HTTP only, and `chain_service_config.py` resolves where it lives from `config.ini [historical]` (env overrides: `OPTION_COMBO_CHAIN_SERVICE_URL` / `_DIR`), so moving this repo or buying a vendor feed is a config edit rather than a code change
6. frontend writes replayed quotes into the same state fields used by live mode
7. existing valuation and charts update through the same render pipeline

Historical replay also supports:

- trigger preview
- simulated submit
- deterministic replay fills
- replay-day entry locking
- close simulation
- expiry auto-settlement
- historical risk-free and yield-curve hydration

## 9. Chart Lab Architecture

Current data flow:

1. read current frontend state through `window.__optionComboApp.getState()`
2. request daily bars from `ib_server.py`
3. fall back to options-chain-service daily bars when IB bars are unavailable
4. read selected projection source:
   - one group
   - included global portfolio
5. compute a `price -> pnl` curve through the same pricing helpers used by the main charting pipeline
6. project that curve onto a daily candle canvas

Current boundaries:

- price-axis alignment is real
- horizontal projection width is normalized P&L magnitude
- daily bars only
- mixed-expiry projections still need more explicit later-date semantics if strict financial correctness is required

## 10. Startup and Process Model

### Live workspace

- frontend served by `python -m http.server 8000`
- backend served by `ib_server.py`
- route: `index.html?entry=live&marketDataMode=live&lockMarketDataMode=1`

### Historical replay workspace

- frontend served by `python -m http.server 8000`
- backend served by `historical_server.py`
- route: `index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1`

### Chart Lab

- served by the same frontend HTTP server
- route: `chart_lab.html`
- use `ib_server.py` for bars

### IV term structure

- served by the same frontend HTTP server
- route: `iv_term_structure.html`
- use `ib_server.py` for IB connection status and live IV sync

### Background / Codex launchers

- `powershell_scripts/start_option_combo_codex.ps1` starts HTTP and IB services with redirected logs and pid files under `logs/`
- `powershell_scripts/launch_ib_server_codex.ps1` starts only `ib_server.py`
- matching restart scripts stop existing pid-tracked processes and relaunch
- generated `logs/*.log` and `logs/*.pid` files are ignored by Git

Use `cleanup_logs.bat` or `cleanup_logs_mac.command` for periodic runtime log cleanup. The cleanup helper also scans legacy root-level runtime logs from pre-`logs/` launcher layouts.

## 11. Current Known Boundaries

- `contract_specs/*.xml` are reference assets rather than runtime truth.
- Active-order recovery requires matching workspace/group identity and backend tracking metadata; browser-only automation state is not backend-persisted.
- Chart Lab is experimental and uses daily bars only.
- The projection lab aligns price, but not true future time.
- `historical_server.py` cannot serve Chart Lab bars or IV term-structure sync.
- `ib_server.py` supports more runtime paths than the lightweight historical server.
- If multiple unmanaged `ib_server.py` processes are left running, broker-status debugging becomes unreliable because the browser may connect to a different backend than the logs you are reading.

## 12. If Notes and Code Drift

Trust in this order:

1. HTML script order in `index.html`, `chart_lab.html`, and `iv_term_structure.html`
2. `js/product_registry.js`
3. `js/pricing_context.js`
4. `js/pricing_core.js`
5. `js/valuation.js`
6. `js/session_logic.js`
7. `js/ws_client.js`
8. `ib_server.py`
9. `historical_replay_service.py`
10. `trade_execution/adapters/ibkr.py`
11. `js/iv_term_structure.js` and `js/iv_term_structure_core.js`
