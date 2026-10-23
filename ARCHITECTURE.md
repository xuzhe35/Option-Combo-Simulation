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

4. `cost_basis.html`
   - standalone per-underlying blended-cost ledger
   - event-sourced accounting over its own SQLite database; cannot trade; streams only its own underlying's quote

5. `workspace_db_admin.html`
   - standalone read-mostly admin page for the workspace database and its archive

6. Python backends
   - `ib_server.py` for live IBKR market data, live execution, Chart Lab bars, IV term-structure sync, and historical fallback paths
   - `historical_server.py` for historical replay snapshots only (options-chain-service backed)

7. Optional Docker lifecycle layer
   - `option_combo_starter/supervisor.py` runs as PID 1
   - the HTTP server and `ib_server.py` are critical child processes
   - the backend remains the sole owner of IB reconnect attempts
   - yield-curve refresh is a separately scheduled, non-critical maintenance
     job that cannot restart the container

## 2. Frontend Entry Surfaces

### `portfolio_snapshot.html` (P0/P1 preview)

An independent image-to-Portfolio review page with its own schema, DOM-free
core and OCR normalizer. It stores only a browser-memory snapshot and exposes
`window.__portfolioSnapshot.getSnapshot()` as a detached inspection copy.
Source rows retain summary/combo hierarchy; only atomic position rows enter
`positions`. Original recognition and manual changes remain separate. No
ledger, market data, pricing, order or persistence runtime is loaded.

The opt-in TWS comparison (`CODE PLAN/PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md`)
adds the DOM-free `js/portfolio_snapshot_tws_model.js` (TWS replies to normalized
positions, identity matching, the comparison report), `js/portfolio_snapshot_tws.js`
(a WebSocket client limited to the three existing snapshot reads; `ib_server_ws.py`
hands unknown actions to the order dispatcher, so the whitelist is a safety boundary)
and the panel controller `js/portfolio_snapshot_tws_panel.js`. The panel reads the
JSON through `__portfolioSnapshot.getSnapshot()` and `__portfolioSnapshotView`
(`selectPosition`, `onChange`, notified after every table render) and never writes
it or any file; the result lives only in the page. Browser storage holds one key, the
last answering backend `{host, port}`, so a remote `ib_server.py` is prefilled next time
(the ledger's saved server is on another origin and is not shared). No backend code changed.

The optional third engine, `local-codex`, uses the independent Python adapter
`scripts/portfolio_snapshot_codex.py` and DOM-free browser module
`js/portfolio_snapshot_codex.js`, loaded after the OCR normalizer. Protocol 3
returns semantic rows and source strings in its whole-image phase, not OCR words
or model-provided boxes.
It classifies headers/rows with the installed Codex CLI and ChatGPT login,
in an isolated temporary read-only run; the image goes to OpenAI's model.
No project context, golden, plugins or MCP configuration is sent. A strict
schema, parent-scope/graph checks, decimal parsing and the existing snapshot
validation gate its candidate. AI coordinates are deliberately absent, and
all values require manual review. Existing protocols 1/2 remain unchanged.
The current transport is `scripts/portfolio_snapshot_codex_transport.py`: a
private stdio app-server with an isolated configuration/model catalogue and a
reference to the existing ChatGPT login. Explicit high effort is checked in the
session response and on the turn; source-byte data URLs use original image
detail and must match the app-server user-message echo. Native offline WebSocket
wire tests decode the actual outbound bytes and verify original dimensions and
hashes, with no external inference. Neither these transport checks nor the
image echo claim numerical pixel proof. Warnings and any host/tool request fail
closed. The browser additionally requires high/original provenance before
normalizing any candidate. See validation §27 for controlled comparisons.
Capabilities separately report loopback transport and each engine's offline
or cloud processing; offline failure never automatically selects Codex.

The second protocol-3 phase is explicit `codexReview: {firstRunId}` on the same
bounded preview endpoint. `scripts/portfolio_snapshot_codex_review.py` uses
Pillow-only neutral text projections to produce up to 64 full-width source-pixel
line crops; it does not run OCR, assign numeric columns or use model coordinates.
A fresh high/original app-server session receives the original for header context
plus labelled crops, with no first-pass values. The transport verifies every
additional image echo/hash. Both HTTP replies bind to the selected engine,
protocol, model, source dimensions/hash and first run. Malformed replies abort
the whole replacement, retaining the user's previous Portfolio.
`OptionComboPortfolioSnapshotCodex.combine` independently validates bounded,
ordered crop proofs and one semantic result per crop; complete ordered body
row types must match the first pass before association by visual order. It never
matches by a potentially wrong strike/ticker/number, fills a missing value,
changes an identity or reparents a combo. Unalignable valid results stay pending.
Both raw readings and canonical interpretations are retained per field; conflicts
go in `recognition.localReviewIssues`, separate from combo `structureIssues`.
The core keeps unresolved local issues pending through ordinary confirmation.
Human edits resolve their field's pending issue while retaining history; the
page also offers one explicit batch decision for all remaining local issues.
All semantic/number guards remain; neither agreement nor a measured text band
proves that a numerical value belongs to its actual column. See validation §28.

`scripts/portfolio_snapshot_ocr_server.py` is an optional, isolated loopback
HTTP preview service on 8798. It serves only a static allowlist and bounded
JSON image requests, runs the temporary native Vision helper on macOS, and
returns untrusted words/boxes. The browser validates and maps the supported
TWS columns, then requires manual review. Vision additionally rereads bounded
text crops at two resolutions. Only aligned, agreeing short-code readings may
change a description candidate; original words, both rereads and per-field
correction evidence remain in the snapshot. Numbers and ellipsis-truncated
words cannot be changed by this step. There is no symbol dictionary/substitution.
Production `reviewProtocol: 1` additionally verifies each contract row with
2x/3x/4x bounded crops. At least two complete parsed identities must agree;
another complete identity blocks the row even if two others agree. Incomplete
readings remain in `allPasses`, without homoglyph or ticker replacements.
Only the agreeing pair supplies the measured indentation. Numeric-only rows
are unclassified candidates, not decoration, and can recover their description
from their own crop. Every average-price cell requires bounded 3x/4x agreement;
failed reads become null with a field problem. Changing a row identity also
requires independent daily-P&L cell evidence. Numeric values in other columns
stay with the original row. All before/after values, accepted and unsuccessful
crop readings survive export and batch confirmation. This protocol adds no
column tolerance or separate native calibration.
Header profiles are explicit: abbreviated FIN INSTRUMENT / PTF THETA requires
12 columns with IV; the expanded FINANCIAL INSTRUMENT / PORTF THETA presentation
may end at LAST with 11 columns. Both crop reads must agree on the profile and
all labels, and unknown labels still reject. There is no fabricated IV interval;
`columnIndex` uses only actual intervals and absent IV is annotated in field
evidence. Header padding is a bounded retry for genuinely invalid measured
coordinates, not the default; pure frame words may use pixel-measured line
bounds while retaining their loose observation rectangle. Coordinate and label
overlap checks are unchanged. Missing/invalid numeric cells (excluding LAST
prefixes) may use same-cell 3x/4x evidence; detected glyphs that remain unreadable
have `visible_numeric_ink_unread` evidence and a field problem instead of a zero.
Complete contract identity consumes the supported description, including its
exchange suffix. A label-only or malformed suffix is not a competing complete
contract; another complete contract with different terms still blocks the row.
The explicit FOP class slot also permits malformed bracket tokens as reread
inputs; only two aligned canonical class readings can change them. A visible
FOP marker retains FOP type even when its class cannot be resolved.
Separately, option-type tokens after expiry and strike accept CA/CAL and PU
prefixes as CALL/PUT, retaining their raw truncation and interpretation evidence.
The browser uniquely locates all expected column labels in order and derives
the intervals from their actual coordinates; ambiguous/missing/extra header
words refuse recognition. Two full-header crops each validate the complete
label set. Native repeated numeric right edges and nearby ink gaps propose
fused-word crop cuts; two-scale fragment text must reconstruct the fused token,
and the browser requires one supported semantic split with measured coordinates.
The known E+ instrument-header suffix is consumed explicitly; an OCR 'A' is a
sort control only with filled-triangle pixel evidence. Column calibration lives
only in the browser. Colored-square pixel evidence can exclude a distant status
badge from numeric cells; narrow, uniform vertical border evidence permits a
separate numeric crop reread with the original token and sign preserved.
For a
missing POS value, it sends bounded cell regions with the image to the helper
in a second request (same hash/dimensions/generation binding). Swift only checks
crop bounds and rereads the requested cells at 3x/4x with neutral padding.
The browser accepts one aligned
crop with two agreeing numeric readings; first-pass values, invalid existing
text and neighboring rows cannot be overwritten. The cell crop and both passes
are retained separately from original words and summary rows.
Isolated numeric glyphs missed by the line detector can be reread as repeated
copies of the same source patch, without synthetic text or character templates.
Complete repeated text, source geometry and agreeing 3x/4x values are required;
a neutral-ink contrast retry uses the existing source-ink thresholds. Evidence
retains the source patch, copy text, montage geometry and preprocessing. LAST
gets bounded rereads for missing/punctuation values, while source letter
qualifiers stay unknown. A tight numeric crop excludes a nearby ornament only
with filled-square color proof and no neutral text pixels; the original
remote-square spacing criterion is unchanged.
An unsuccessful second request preserves the original evidence, keeps unverified
contract rows unclassified, leaves missing quantity null and adds a persistent
warning; cancel/abort still cancels.
Decoration rows are skipped by hierarchy lookahead and never push, pop or clear
the parent stack. Totals and cash still close combo scope.
Bulk review presents a single acknowledgement list for machine changes to
all editable fields, then confirms positions and cash (including filtered rows),
without removing missing-field or hierarchy warnings or claiming full coverage.
Critical machine-change markers persist after review. Structure decisions bind
to the issue, run and combo graph; reasons and exclusions retain source evidence.
Rows without aligned numeric/single-contract evidence, and non-table footer
text, are decoration. Additional possible positions after cash are unresolved,
not auto-imported. Snapshot OCR account-like text is masked recursively; explicit
manual account metadata is retained. Compact JSON export/import share a 32 MiB
limit and refuse oversize exports. Row grouping follows text height rather than
a fixed image-height floor. STK value/quantity checks respect display rounding.
Combo structure is a stack of indentation levels with single-contract checks;
unknown expanded strategy names use that structure, while names only provide
hints for collapsed groups. Peer rows end a group without waiting for TOTAL.
Nested combo metadata lists visible atomic descendants once, and JSON validation
checks cycles, source roles and leg membership. Partial/unclassified structures
stay visible for review, and no expected leg count is guessed.
For indentation, the native helper measures contrasting glyph pixels within
each enlarged short-code region; OCR rectangles alone may agree on leading
background and are insufficient. Two aligned, agreeing word readings with
close glyph starts supply an interval for indentation. A child must be
strictly deeper than its parent's interval plus the existing layout tolerance;
boundary disagreement stays a visible ambiguity. Original boxes, crop boxes,
glyph measurements and parent/leg evidence survive JSON round trips.
Host/Origin/peer checks restrict the
service to loopback; raw account data and images are not logged or retained after the request.
This early OCR adapter intentionally does not alter either shared backend or
their broker-facing WebSocket dispatchers. Future WS/database integration
remains subject to the CODE PLAN; P0/P1 do not implement it.

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
- one-expiry Global Auto Close planning/execution for conservative Auto-classified equivalent tails across globally included Active Groups; v1 rejects multiple candidate expiries and does not consume normal liquid legs
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

### `cost_basis.html`

The blended-cost ledger is standalone and never loads the trading shell. It
loads the ledger/import/page scripts plus DOM-free `american_binomial.js`,
`market_curves.js`, and `cost_basis_stress_{models,core,band,worker}.js`.
The stress core compiles the ledger once, calibrates quotes to the selected
pricer, and values both books through one instrument valuation path. Scenario
costs are computed separately by replaying in-memory settlement rows through the
ledger engine in expiry order, cached per distinct delivery outcome and reused
by band members. These costs never feed back into the P&L calculation. The page
only transports inputs and renders results. The worker receives the exact
versioned dependency URLs loaded by the page; its generation and full input key
prevent stale bands from landing after a parameter, book or snapshot change.
No stress computation writes events or calls the trading shell.
Quantity drafts are identity-keyed inputs to the stress core, applied after
quote calibration and mapping-proxy selection. Current sizes are repriced as a
same-scenario comparison. Resized drafts expose current-value funding and ΔNAV,
never transplanted historical costs; optional user NAV is a display baseline.
The page defaults to ΔNAV and disables implicit future income. Its IV band adds
explicit level-sensitivity members without recalibrating the current snapshot.
Cross-book quote refreshes share a generation: load the linked ledger first,
request both snapshots concurrently, and only render after both complete.
Horizon-only scrubbing reuses a completed synchronized v2 batch with full curves,
pinning the valuation baseline to its receipt time. The core checks the original
snapshot date via `snapshotThroughExpiry` separately from the target date;
legacy/incomplete batches still require refresh. Each input cancels the prior
worker generation and clears the old chart, cards and slice before recomputing.
The live dispatcher admits at most two cost-basis snapshot tasks per connection
and four in total, rejects excess requests immediately with a correlated busy
response (no waiting queue), and cancels/awaits only the disconnected client's
tasks. Broker quote cleanup runs in the fetcher's finally block; ledger actions
remain ordered. Leaving a view only invalidates its browser-side batch.
Missing linked snapshots, marks or required quote sides can drop the linked
layer after independently validating the own book; missing own quotes can then
fall back to settlement only. Degraded results are labelled, have no band and
are disabled while fetching or in the change lens. Identity conflicts, crossed
quotes and calibration failures remain errors, never zero-valued legs.
Enabling a cached overlay also refreshes the main book; the 60-second quote-skew
gate is never bypassed. A missing broker IV can use a labelled local-IV path-sigma
proxy derived from valid marks, not a fabricated default volatility.

It currently:

- keeps one active book per account + underlying + security type + currency
  over an append-oriented event stream in its own `cost_basis.db`
- presents three lenses off the same stored cash: net cash (default), stock
  only (rolling average, compared with TWS as corroborating evidence),
  and tax adjusted
- reads TWS positions through the existing
  `request_portfolio_positions_snapshot` /
  `request_portfolio_avg_cost_snapshot` actions, and only ever *detects* a
  gap from them - nothing auto-writes an event
- imports Activity Statement and Flex CSVs, using broker IDs when available,
  otherwise occurrence-aware content references; economics are checked before
  treating a stored reference or cross-format match as a duplicate
- reviews and explicitly imports recent TWS executions by broker `execId`;
  duplicate IDs inside one batch are blocked before storage, while later CSV
  reports remain the final historical authority through strict cross-source
  matching
- supports `STK/OPT` and deliverable `FUT/FOP`, including FOP delivery and
  uniquely paired futures rolls
- derives current positions from CSV/ledger replay even when TWS is offline,
  and labels the result as uncorroborated rather than rendering an empty table
- automatically feeds the hero reference price into What If from existing
  portfolio-price pushes; manual scenario edits pause following, and resuming
  needs no request. Explicit current-price refresh remains a one-shot quote
- provides expiry-bounded What If replay plus a multi-price stress test in its
  own page view (parameters in a sticky left column, chart and cards on the right;
  any view switch or book change tears the stress job down)
  that values every still-open option of the book on one scenario date (live
  longs as assets, live shorts as liabilities) with per-contract locally calibrated IV, the
  shared discount curve, a CRR American binomial by default and a mid or
  today's-spread lens; nothing becomes a stored event
- stacks an optional cross-book protection curve (TQQQ-first): a same-account,
  same-currency sibling book's long options are valued at an index-driven,
  compounding-mapped price (explicit or nearest-ATM proxy path sigma, refused
  when absent) via the sibling's own ledger read and a bounded TWS quote
  request; short legs are ignored, nothing is merged, and no new WebSocket
  action is introduced
- treats a negative share balance as supported state: the net-cash lens
  reports the short's buy-back break-even level, and the short notice is
  raised only from the final replayed balance, never from an intermediate
  row inside one same-timestamp settlement batch

Two invariants are load-bearing and easy to break by "improving" the code:
the ledger is the source of truth, and an assignment row's cash is the share
delivery at the strike only, because the contract's premium was already
recorded when it was opened. See
`CODE PLAN/COST_BASIS_LEDGER_PAGE_PLAN.md`. The import pipeline's identity
keys, opening-position arithmetic, CSV-vs-TWS cross-source matching and the
monthly append workflow are written up in
`CODE PLAN/COST_BASIS_IMPORT_INTEGRITY.md`.

### `workspace_db_admin.html`

A standalone loopback admin surface for the workspace database. It loads its
own minimal client (`js/workspace_db_admin.js` plus the DOM-free
`js/workspace_db_admin_core.js`), never the trading runtime, and speaks the
`portfolio_admin_ws.py` protocol. Responses never carry paths, SQL, or
payloads. `Rehydrate Original` is deliberately absent until its
"archive again after restore" semantics are frozen and tested.

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
18. `js/american_binomial.js`
19. `js/pricing_core.js`
20. `js/bsm.js`
21. `js/chart.js`
22. `js/prob_charts.js`
23. `js/chart_controls.js`
24. `js/amortized.js`
25. `js/valuation.js`
26. `js/session_logic.js`
27. `js/workspace_persistence.js`
28. `js/session_ui.js`
29. `js/control_panel_ui.js`
30. `js/hedge_editor_ui.js`
31. `js/group_editor_ui.js`
32. `js/hedge_ui.js`
33. `js/group_ui.js`
34. `js/global_ui.js`
35. `js/page_capabilities.js`
36. `js/combo_order_transport.js`
37. `js/delta_hedge_transport.js`
38. `js/delta_hedge_ui.js`
39. `js/calendar_handoff.js`
40. `js/app.js`
41. `js/ws_client.js`

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
An INDEX option without a usable parity sample uses current index spot as a
visibly degraded flat-forward estimate; a valid parity sample always wins. An
explicitly bound FOP leg without its qualified, matching future quote still
fails closed because substituting another futures month is materially wrong.

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

Live option projections prefer a fresh validated two-sided BBO. If it cannot
be inverted, the analysis path tries the best observable option mark and then
the latest usable TWS/input IV. Live sessions default to
`projectionConvergenceMode=best-effort-input-iv`; strict BBO is an opt-in
per-chart diagnostic. This policy is shared by valuation, payoff, Chart Lab,
probability, and amortized surfaces, but never relaxes order validation.

Structured per-date λ is likewise preferred. Missing dates use the curve
median; an unavailable curve uses the configured scalar λ. Product-profile
expiry cutoffs are allowed while IB timing metadata is pending or absent.
Outside bundled live calendar coverage, analysis estimates weekdays versus
weekends and marks the clock degraded; historical replay still requires
observed sessions.
Explicit contract rejection, incompatible adjusted equity classes, conflicting
near-leg cutoffs, wrong/missing FOP month quotes, unknown models, and deferred
AM settlement fixings remain hard blockers.

The IVTS λ solver and simulator share the same exact timestamp clock. The strict source requires ContractDetails `expiryAsOf`; best-effort sources
retain explicit profile/date-clock provenance. Interval evidence carries fractional
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
- BSM and Black-76 pricing, plus independent opt-in American CRR paths for
  stock/ETF options and FOP. American FOP reuses the generalized tree with
  `q=r`, so the bound futures price has zero risk-neutral drift while exercise
  is checked at every node; European Black-76 remains the FOP default
- weighted variance clocks with scalar or per-non-trading-date λ
- probability MC horizons resolved as official-calendar `[quote,target)` daily
  weights; the Worker consumes the same scalar/`byDate` λ clock instead of
  reverting to calendar-day variance. Signed negative closure residuals are
  coalesced with adjacent positive trading segments at the Worker boundary, so
  simulation blocks are nonnegative while their sum remains the exact signed
  effective horizon
- probability leg repricing carries explicit `varianceT` and calendar
  `discountT`: equity/ETF legs use BSM and index/FOP legs use Black-76 unless
  their independent American switch selects the corresponding CRR price grid
- live 0DTE fractional time prefers IB ContractDetails last-trade metadata;
  missing timing may use a visible product-profile estimate. Explicit identity
  rejection, incompatible adjusted equity classes, wrong FOP bindings, cutoff
  conflicts and unsupported AM fixings remain blockers
- price-independent `option_contract_metadata` handoff after each qualified
  subscription attach; pooled IVTS/portfolio reuse does not wait for another
  BBO tick, and the browser updates identity/timing without touching quote or
  feed clocks
- exact-timing cache admits only complete ContractDetails evidence (plus
  verified FOP underlying binding); partial results retry on later subscribe,
  while same-conId concurrent lookups share one in-flight request
- product-profile cutoffs are also used by the manual IVTS best-effort
  estimator with explicit provenance; its strict source still requires exact
  ContractDetails. Neither estimate proves a special settlement fixing
- AM special-fixing contracts (standard SPX and traditional quarterly AM
  ES/NQ/MES/MNQ) fail closed after last trade because the settlement variable
  is not the contemporaneous screen underlier
- live option payload identity is verified against qualified IB contract facts;
  FOP `underConId` and actual underlying month must match the request before a
  quote or its ContractDetails timing may enter pricing
- observable live-mark anchoring at the exact current underlier/no-IV-shock
  point; neighboring scenario points stay model-priced
- explicit Group `liquidation` view: preserves entry cost while valuing open
  options at current intrinsic value, bypassing option quote/IV/time-value
  convergence gates across valuation, main/global charts, Chart Lab, and
  probability paths. The required spot or bound futures input still fails
  closed, and cached option marks are no longer observable after last trade
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
- calendar-day IV and trading-day IV using the fallback scalar until a manual
  λ calculation is available, then per-date weights with labelled tail estimates;
  the separate strategy signal remains fixed at λ=0.3
- manual implied-λ calculation prefers coherent whole-curve snapshots and
  two-sided straddle/forward evidence, then usable BBO subsets, then an audited
  vendor-ATM-IV fallback; source and estimated intervals remain explicit
- per-expiry discount observations from the shared Discount curve; the manual
  continuous `r` is a row-level fallback, not a substitute for carry
- FUT underliers may provide an independent outright Forward check. ETF/index
  spot is never relabelled as `F` and `S*exp(rT)` is not assumed when `q` is unknown
- validated V2 handoff keyed by symbol, futures month, live quote anchor and
  official calendar. Required date coverage is audited separately: default
  analysis discloses median/scalar fallbacks, strict BBO diagnostics block gaps
- coherent-snapshot events update only the latest immutable estimator input.
  V2 derivation runs only when the user presses `Calculate λ`; the result is
  frozen for inspection and live ticks merely mark it as superseded. `Sync to
  Simulators` explicitly publishes that frozen curve, and `Export JSON` writes
  the same validated document, including any best-effort provenance, for another origin or machine
- consumers coalesce repeated same-origin storage events into one animation-
  frame refresh and defer hidden-tab valuation until visibility returns.
  Calculated and explicitly imported V2 curves are frozen without a wall-clock
  timeout; their original market `quoteAsOf` remains audit evidence. Product,
  futures-month, live anchor-date and publication/import calendar checks remain
  mandatory; per-date gaps are disclosed and stop strict diagnostics
- `js/market_holidays.js` is an official-snapshot reader only; it contains no
  holiday rule engine. `js/date_utils.js` carries each product's `calendarId`
  through pricing and UI calculations. IVTS requires official coverage; ordinary
  live analysis may label weekday/weekend estimates outside it. Historical
  replay supplies explicit observed session dates from
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
- `sync_exchange_calendars.bat`
- `run_market_data_maintenance.bat`
- `install_ib_bridge_deps.bat`
- `cleanup_logs.bat`
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
- `scripts/cleanup_runtime_logs.py`
- `powershell_scripts/*.ps1`

Responsibilities:

- Python resolution
- local service launch
- ordered yield-curve and official-calendar maintenance
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

- `ib_server.py` has explicit `SUPPORTED_LIVE_FAMILIES` defaults for `ES`, `NQ`, `MES`, `MNQ`, `CL`, `GC`, `SI`, and `HG`.
- `SPX` and `NDX` use index exchange fallbacks.
- Family defaults do not prove a specific contract exists: expiry, trading class and underlying-month binding still require IB qualification.
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

`request_discount_curve` and the shared persistence, admin and ledger action
families below are also handled. Other messages return a historical replay error;
live-only ledger fetchers report unavailable through the shared ledger protocol.

### Workspace persistence (shared by both backends)

`portfolio_store.py` is the pure SQLite store (schema v2: workspace
documents + full-JSON revisions with canonical UTF-8 `payload_bytes`,
canonical-JSON validation and SHA-256 before any write transaction,
BEGIN IMMEDIATE saves writing the revision and a permanent
`workspace_save_receipts` row in one transaction — idempotent replay reads
the receipt and returns the original ACK even after the payload is
archived — soft delete, restore, verified backup publishing, and the
archive index tables: entries, tombstones, shard registry, maintenance
jobs, and the cross-process lease). `portfolio_store_ws.py` serves the
persistence actions on both sockets via `asyncio.to_thread`, enforces
loopback-only access before lazily opening the database, and schedules the
static backup after committed saves. The scheduled pass never deletes
revisions: retention only defines archive candidates.

Three sibling modules complete the archive layer. `portfolio_maintenance.py`
is the cross-process guard every maintenance path must hold: process
threading.Lock, then a non-blocking OS flock next to the database, then the
`workspace_maintenance_lease` row whose fencing token increments only on
takeover after a holder dies (a paused holder's OS lock blocks takeover
even with an expired lease). `portfolio_archive.py` owns candidate policy
(pure, clock-injected), shard schema/rollover, preview manifests with
generation fingerprints, the copy-then-verify-then-remove state machine
(commit chunks re-check the lease inside the write transaction and insert
the archive entry/tombstone in the same transaction as the delete), the
crash reconciler, restore, and the guarded opt-in auto-archive.
`portfolio_admin_ws.py` is the loopback admin protocol used by
`workspace_db_admin.html` (own minimal client: `js/workspace_db_admin.js`
+ DOM-free `js/workspace_db_admin_core.js`); plan tokens are single-use,
15-minute, bound to the issuing server instance, and responses never carry
paths, SQL, or payloads. On
the browser side `js/workspace_persistence.js` owns request correlation,
the document envelope, the canonical fingerprint for dirty detection, the
5 MiB pre-send check, and the BroadcastChannel writer lease; `js/app.js`
only hands snapshots in and applies load results atomically through the
replace-mode normalizer. Both `websockets.serve` calls share an explicit
`max_size` (`[server] max_ws_message_bytes`) because the library's 1 MiB
default would 1009-close a socket that also carries order supervision. Neither
listener passes an `origins` restriction to `websockets.serve`: arbitrary
browser origins, `null`, and missing Origin headers are accepted. The strict
localhost policy from September 2 commit `01292bc` was rolled back after it
broke previously working LAN/Nginx Proxy Manager connections with HTTP 403.
`[server] allowed_origins` and `OPTION_COMBO_WS_ALLOWED_ORIGINS` are ignored.
`websocket_security.read_allowed_ws_origins` remains only as a compatibility
shim for already-baked Docker supervisors: it returns a fixed nonempty
localhost tuple regardless of configuration and is not an authorization
policy. Origin is not authentication, and loopback binding does not prevent
an unrelated website from reaching the service through a local browser.
Deployments must protect the trading-capable socket's network/proxy ingress;
ledger peer checks, workspace/admin loopback checks, and execution safety
remain unchanged.

### Blended-cost ledger (shared by both backends)

`cost_basis_store.py` is the pure SQLite store (schema v12) behind
`cost_basis.html`: append-oriented money events keyed per book, one derivation
for every event's cash amount, per-kind field validation, client-token
idempotency, external-ref import de-duplication, voiding that replays the
contract timeline rather than deleting, and snapshot hashing. Ordering is
`trade_date -> split phase -> broker_timestamp -> seq` in the store
(`_EVENT_ORDER_SQL`), the browser engine (`compareEventOrder`) and the
importer, checked against `tests/fixtures/cost_basis_event_order_vectors.json`,
so all three agree on replay. Every write runs under BEGIN IMMEDIATE on its
own short-lived connection.

Schema v10 records standard forward splits (`CODE PLAN/COST_BASIS_CORPORATE_ACTIONS_PLAN.md`
§15) as a group of rows sharing `split_group`: a `split` header that applies at
the open of its trade date and one `option_split` row per open option series,
moving the whole position (and its open premium) to the adjusted strike.
Groups are written and voided only whole (`append_split_group`,
`void_split_group`; WebSocket `append_cost_basis_split_group`,
`void_cost_basis_split_group`); single-row, statement and rebuild writes refuse
group rows. After every write that touches an account, and after a restore,
`_validate_split_groups` replays the account and proves each group: every
series live on the split date converted exactly once, each source emptied, no
two sources merged, no plain split row on the same date. Option identities are
resolved per split epoch, because a pre-split and a post-split contract can
share a strike and an OCC symbol. Plain `split` rows keep their end-of-day
order, start no epoch, and raise a non-blocking `legacy_split_same_day` notice
when share fills of the same day sort before them. The browser core replays a
group atomically and drafts one with `planSplitGroup`; the page's split form
previews that draft, collects per-series class confirmations
(`buildSplitGroupRequest`) and writes the group, and the reconciliation table
only suggests a missing split (`suspectedSplitRatio`). The page no longer
creates plain split rows. Seller expiry, What If and stress all read the
converted positions from the replay; prices typed by hand are cleared when a
book's split records change, because they were per share in the old unit.

Schema v11 adds the standalone FOP ledger (`CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md`):
the books table is rebuilt in SQLite's documented order with foreign keys off
(a FOP book keeps no stock multiplier), plus eleven FOP tables that hold contract
records, FOP -> FUT bindings, per-event FOP details, cycle boundaries, source
records and their allocations, metadata operations, and a request log. Every FOP
write checks, inside its write transaction, that this engine supports the
ledger, the engine the request names, the identity and the reviewed ledger
version; the request log answers a retried token with its first answer and
refuses the token for any other request, and travels with a backup so a ledger
restored under its own id (also into a new database) keeps answering; a FOP
ledger's version digests its whole content, so a restore of other content
expires every older preview; and a restore proves every relation of the graph
before it writes, names each event's primary source record instead of
re-deriving it, and takes the backup's history scope. The statements are the
frozen P1 draft (`tests/fixtures/cost_basis_fop/contract/ddl_draft.sql`); a new
file is created at v10 and migrated the same way, and an existing file is first
copied and verified. `cost_basis_fop_store.py` (mixed into `CostBasisStore`)
owns that graph inside the store's transactions; `cost_basis_fop_domain.py` holds
the pure rules; `cost_basis_fop_schema.py` checks every FOP message against the
frozen types in `cost_basis_fop_protocol.json`; `cost_basis_fop_broker.py`
resolves option -> underlying pairs read-only through an injected contract-details
function. FOP writes are gated by `fop_writes_enabled`, open in both servers
since the release stage (P6) and closed again by `[cost_basis]
fop_writes_enabled = false`; a FUT book without FOP metadata stays export and
delete only. The stock modules (`js/cost_basis_core.js`, `js/cost_basis_import.js`,
`js/cost_basis.js`, the stock half of `cost_basis_store.py`) carry no FUT/FOP/ROLL
branch since P6: the stock page sends a FOP ledger to its own page, shows a
legacy FUT ledger's identity and reason only, and the stock engine and importer
refuse a FUT ledger. Schema v12 only lets the FOP request log hold statement imports; a
v10 file goes straight to v12, and a v11 file (the P2 and P3 builds) rebuilds
that one table behind the same verified backup.

Statements reach a FOP ledger through `js/cost_basis_fop_import.js`, a DOM-free
importer that reads Activity and Flex CSVs with the shared lexical layer
`js/cost_basis_import_common.js` (the stock importer uses the same layer; no
row interpretation is shared). It keys every row as `format/section/asset/event`
and gives it its status from `cost_basis_fop_capabilities.json`, which also holds
the column and section aliases both sides read. It resolves real contracts (a
delivery month from a delivery-month field or the local symbol, never an expiry
date; another root such as MCL is another ledger), reads account-local times in
one stated or statement-evidenced timezone (a repeated local time becomes a
range, a date without a time a range), pairs each assignment or exercise with
the future row it delivered, and proves opening quantities against the Open
Positions section. A Trades row of a kind it does not know blocks, never
dropped. Rows that share a second carry no order evidence: a statement's row
order is not proof, so the core refuses such rows when their order changes the
result. It matches the same fill in another format or a TWS execution one to
one, and a matched fill must then agree in fees, cash, intent, trade date and
the option's binding or the batch blocks; an order and its executions at
another granularity are the same fill only through the broker order reference
both rows name, and a stored fill of the same day that nothing proves the same
or another also blocks. It checks which periods the ledger's statements cover
(a month flat on both sides still needs its statement) and lets a statement
without new events register its period with no package. Then it builds the
ImportRequest; the core previews the result without writing, and the FOP page
shows that preview for a statement without a ledger. The store's
`import_fop_events` compares a repeated reference by its content (an equal one
is reported and left out, a different one refuses the batch), holds every
statement row through `cost_basis_fop_statement.py` to the row type its own raw
fields read as (only `real_verified` writes; a `synthetic_only` row only as a
manual event that matches it, a date-only row to the range the server works
out), voids the TWS executions a statement repeats, registers the statement's
coverage, and answers a retried batch from the request log. A statement binding
credential is issued only for option -> future pairs the server itself reads in
the statement rows. Every economic row type is `synthetic_only` until real
statements accept it.

The FOP economics live in `js/cost_basis_fop_core.js`, a DOM-free core that
replays the ledger graph exactly as the server exports it (the version 2 backup
payload): weighted-average FUT positions with gross realized results, option
premium by contract (a close releases its share, the last close what is left),
the four deliveries and expiries, Co/E/J and the seller lens (Rs/Es/Js, one
break-even only with exactly one FUT contract open), cycles derived from their
boundaries with late fees going back to the cycle of their trade (a fee or
adjustment no single cycle owns is "unattributed" and leaves the cycles it may
belong to without a complete net result), since-baseline figures net of the
opening value, as-of views (an event has happened once its time has ended or
its order evidence puts it before one that has; one still unresolved blanks
only what it could change, in the cycle it belongs to), and ROLL groups derived
at read time (they never change a figure). Nothing is rounded in between, and every
unknown figure is null with a reason. The server orders events the same way
(`cost_basis_fop_domain.build_timeline`, plan §9.2): overlapping times form
groups, a group whose order would change a result needs order evidence or the
write is refused, and a cycle boundary sits after the whole group, whichever of
its events anchors it, so a restore that renumbers events keeps its meaning. An
opening balance happens at the baseline instant it states, and the event list is
paged in this same order. The hand-worked
vectors in `tests/fixtures/cost_basis_fop/core_vectors.json` are reproduced by an
independent rational model (`tests/helpers/cost_basis_fop_model.py`), by the core
and, written through the real store, by the core again.

The FOP page (`cost_basis_fop.html`, controller `js/cost_basis_fop.js`) reads a
ledger as its version, its exported graph and its version again (equal digests
mean the graph is that version) plus the registered statement periods, and
replays the graph with the core. `js/cost_basis_fop_view.js` turns the output
into panels that name the contracts and events behind every figure;
`js/cost_basis_fop_forms.js` builds manual entries, voids and cycle operations
as the frozen requests and runs the delivery preview on a copy of the graph in
memory, with a quantity per option (a path that holds or delivers a FUT past
its last trade date, leaves an option open past its expiry, or starts before
the last recorded event, stops; both dates are exchange dates). Quotes are one
batch at a time
(`request_cost_basis_fop_market_snapshot`): the server quotes only the
ledger's own stored contracts, reads their terms from the records and reports
each contract's evidence as the broker gave it (`cost_basis_fop_broker.py`; a
-1 without a size is no quote, an option price is never negative, a FUT may
be); `js/cost_basis_fop_quotes.js` values it in the plan's fixed order, a mid,
else the side a position would close against, else a dated settlement or
close as a labelled reference, else nothing, with the broker's observation
time aged against 60 s batch sync and 120 s freshness; the summary names the
lowest level used. The page re-ages a batch at the moment its first current
quote stops being fresh (redrawing the figures only, never the forms being
filled in), and a lost connection retires it at once. A batch, a reload or an
import preview is used only for the ledger, request and version it was made
for; an import is sent against the version it was previewed on. `ib_server.py` takes quotes through the bounded, self-cancelling
`_request_cost_basis_snapshot_tickers` and runs one FOP batch at a time;
`historical_server.py` has no adapter and answers with the same action and a
capability error. A FOP backup's digest reads whole numbers as integers, so a
backup a browser downloaded and wrote again still proves itself.

The P5 closeout (plan §19) adds the workflows around that view. A statement row
that may repeat a stored fill blocks until a person decides it is that fill or
another one and states the check; the import request carries the decisions
(`duplicateDecisions`), the store reads each same-fill row from its own raw
fields (row type, contract, direction, day, price, commission, the future it
names against the option's binding), makes the rows named the same as one fill
add up to it in quantity, average price, fees and cash with its open/close
intent and exchange trade date, and keeps the decisions in the import's answer
in the request log, where a later import of the same row finds them. An option whose
future is unproven is resolved read-only at the broker; `adopt_binding` may
bring the option's or future's next revision, or the future itself, and the
binding credential must prove exactly the records they leave. The page reads
the ledger account's own TWS positions (`request_cost_basis_fop_positions`: this
account and root only, bound to the ledger version with a server credential)
and keeps quantity, AvgCost (corroboration only: same unit, one lot price, a
trade cost; the ledger agrees only when every contract does, else partial or
not comparable), binding and cash apart. A position is its ledger contract by
conId, else by local symbol, and a conId on both sides that disagrees is an
identity conflict, never matched by the symbol. `save_cost_basis_snapshot`
keeps a FOP snapshot of one version, verifies the positions' credential, holds
its quantity and AvgCost summaries to its own rows and claims "reconciled" only
when the store's own quantities match the positions. The core outputs
the buyer's options apart (`buyerOptions`: settled longs, their own fees, open
longs), never added to the totals again, and a statement's realized P&L is
compared on its own basis (FIFO lots with commissions, closes in its period)
only where that basis is certain. Manual entries are previewed in memory and
the previewed request is what a confirmation sends. js/cost_basis_fop_messages.js
puts every stable problem code into Chinese with its next step. New contract
record ids are readable and scoped to their ledger: two accounts' ledgers in
one database hold the same real contract.

The stress view (plan §13.3 P7, `CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md`)
answers what the economic P&L of the positions held now becomes if every
futures month moves (a shift plus a labelled slope per contract month), time
passes and implied volatility scales. `js/cost_basis_fop_stress.js` (DOM-free)
prices each open option off its own bound future: an American option with the
CRR tree of `js/american_binomial.js` on a future (dividendYield = rate, 201
steps), a European one with its own Black-76 and a double-precision normal
function (never `pricing_core`'s Black-76, which moves F <= 0 to 1e-4). At
expiry an option is worth its intrinsic value whatever the sign of F; before
it, F <= 0 stops the model at that point. Implied volatility is solved only
from synced mids, the bound future's too; the quote batch carries a bound
future the ledger does not hold as an anchor (`quoteState.anchors`), apart
from the ledger's marks, its lowest level and its sync window. The stress view
reads `quoteState.stress` instead: the whole batch, anchors included, held to
one sync window. An option expiring inside the horizon settles at the
scenario price, strictly in the money onto its future at the strike; an
American option may be chosen for delivery at the horizon where it is strictly
in the money there. The change is position-based and exactly 0 at the anchor;
the total is the core's replay of the graph plus the scenario's settlements,
built by the same `Forms.settlementEvent` / `withSettlements` as the delivery
preview (with order evidence for simultaneous ones), and the two agree. A run
freezes, when it starts, its parameters, the graph, the batch (asOf is the
batch's newest real-time observation) and the rate: a typed rate is a labelled
assumption, otherwise the cached dated curve read afresh for every run through
`request_cost_basis_fop_discount_curve` (both servers answer it from their
yield-curve cache with `refresh: False`) together with the backend's status; a
curve the backend answers as `cache_fallback` (older than the last market
business date) or that marks itself stale stops the run (`rate_curve_stale`).
Every stop that stands on its own is listed at once, before any implied
volatility is solved. A dollar range replaces the percentage range (the only
range at a zero reference price). Each point shows every month's scenario
price and every option's model value, beside an anchors table with each
option's mid, anchored value and implied volatility. It runs in
`js/cost_basis_fop_stress_worker.js`, loaded with the page's own versioned
scripts; an answer counts only for the latest run, key, ledger version and
batch, a changed parameter cancels a job without an answer (one still reading
its curve too), 20 s ends one, and a moved ledger, a new batch or a disconnect
retires the curve. Nothing is written or sent but the two reads.

Schema v9 ties statement coverage to reset archives, checks both archive digests
on restoration, and invalidates prior coverage after historical changes.
Import/reset/rebuild/restore require identity and version credentials. Event
pagination reads rows and digest in one transaction; the page rejects mixed
versions. JSON backup export uses a single read snapshot and file restoration
uses the same atomic archive-and-restore transaction.

`cost_basis_ws.py` is the shared protocol layer both `ib_server.py` and
`historical_server.py` mount, so Live and Historical answer with identical
response shapes and error codes. It owns ledger access enforcement, request
validation, and the sync-store to event-loop bridge (`asyncio.to_thread`).
Access defaults to loopback only. Two independent opt-ins can widen it, and a
request passes if either allows it:
`[cost_basis] trusted_peers` / `OPTION_COMBO_COST_BASIS_TRUSTED_PEERS` admits
exact remote IPs/CIDRs (the environment wins even when empty; malformed lists
deny all remote ledger access without interrupting local ledger/IB operation),
and `[cost_basis] allow_remote` / `OPTION_COMBO_COST_BASIS_ALLOW_REMOTE` admits
every peer for deployments behind Tailscale or another authenticated network
(the environment takes precedence, including false/empty values; invalid values
fail closed). Only the transport's actual TCP peer is checked, never forwarded
headers; Docker NAT addresses and private IP ranges are never treated as proof
of authentication. The gate precedes lazy DB initialization and broker
fetchers, and does not change the workspace-store/admin loopback restrictions
or broker execution authorization. A trusted proxy must protect its ingress
because it represents all clients it admits.
It never writes SQL and never leaks database paths or raw SQL errors to the
browser, and an exception must not escape it - one bad ledger request must
not tear down a socket that is also carrying live market data and order
supervision.

`rebuild_cost_basis_book` archives the full event set and replaces it inside
one transaction. Reset and archive/JSON restoration also archive and replace
active history. A server-generated reset token, complete book identity and
ledger digest are checked under the write lock; same-count changes also fail.
Batch imports pre-resolve unambiguous multipliers, insert all rows, and validate
the complete affected timelines before commit; any failure rolls everything back.
C/O rows require a genuine opposite-position reversal; pure C remains a close. `delete_cost_basis_book` is the separate, explicitly permanent
exception: after a count-bearing confirmation it removes the book, events,
snapshots and rebuild archives atomically and is not recoverable.

The browser loader generation-scopes every multi-page event fetch. Both the
select control and sidebar use the same rejection-consuming switch boundary;
old rows are cleared before loading a new book, so a disconnect cannot pair a
new title with the previous book's ledger or emit an unhandled rejection.

The workspace recovery-set publisher does not include `cost_basis.db`. No
dedicated cost-ledger backup command or automatic scheduler currently exists;
the page offers checksummed event JSON backup/recovery. For a full database
copy, use a SQLite-consistent external backup; never copy a live main DB alone.

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

### Blended-cost ledger

- served by the same frontend HTTP server
- route: `cost_basis.html`
- works against either backend; `ib_server.py` additionally supplies the TWS
  position snapshot used for reconciliation, and without it the page degrades
  to ledger-only rather than assuming an all-zero portfolio

### Workspace database admin

- served by the same frontend HTTP server
- route: `workspace_db_admin.html`
- loopback only; works against either backend

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
- The blended-cost ledger is deliberately not wired to trading: it cannot place an order, and a TWS snapshot can only produce a draft for a human to confirm. Its only market-data stream is the open stock ledger's underlying quote: `subscribe_cost_basis_underlying_quote` names a book, `ib_server.py` resolves the contract and keeps one pooled line in that socket's `client_subscriptions` as `stock_<SYMBOL>`, the shared pending-tickers handler pushes it (the payload's `stocks`), and the socket's disconnect, a TWS drop or a global stream reset ends it. `historical_server.py` answers `broker_market_data_unavailable`.
- `Rehydrate Original` on the workspace database admin page is not implemented; the backend answers `rehydrateOriginal: False` until its re-archive semantics are frozen and tested.
- Auto-archive stays opt-in and off by default.

## 12. If Notes and Code Drift

Trust in this order:

1. HTML script order in `index.html`, `chart_lab.html`, `iv_term_structure.html`, and `cost_basis.html`
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
