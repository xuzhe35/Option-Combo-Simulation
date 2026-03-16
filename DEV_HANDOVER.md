# Option Combo Simulator - Developer Handover

**Updated:** 2026-03-15

## 1. Current Product Shape

This is a local browser app for options-combo scenario analysis with optional IBKR live data.

It started as a stock/ETF option analyzer and has now been partially generalized to support:

- equity / ETF options
- ES and NQ futures options (`FOP`) for live-data testing
- SPX and NDX index options
- contract metadata for CL / GC / SI / HG futures options

Important status:

- equity / ETF flow is still the most mature path
- ES / NQ live option subscriptions now work well enough for active testing
- SPX / NDX option legs can stream even if the underlying index quote is not updating
- FOP analytics still use the current app framework and are not yet a true futures-option analytics engine

## 2. Script Model

The frontend still depends on ordered global scripts in `index.html`.
All browser-side JavaScript lives under `js/`.

Current order:

1. `js/t_params_db.js`
2. `js/market_holidays.js`
3. `js/date_utils.js`
4. `js/product_registry.js`
5. `js/distribution_proxy_config.js`
6. `js/pricing_core.js`
7. `js/bsm.js`
8. `js/chart.js`
9. `js/prob_charts.js`
10. `js/chart_controls.js`
11. `js/amortized.js`
12. `js/valuation.js`
13. `js/session_logic.js`
14. `js/session_ui.js`
15. `js/control_panel_ui.js`
16. `js/hedge_editor_ui.js`
17. `js/group_editor_ui.js`
18. `js/hedge_ui.js`
19. `js/group_ui.js`
20. `js/global_ui.js`
21. `js/app.js`
22. `js/ws_client.js`

If something suddenly becomes `undefined` in the browser, check `index.html` script order first.

## 3. Product Abstraction Layer

The biggest recent change is `js/product_registry.js`.

This file centralizes the non-equity assumptions that used to be scattered across pricing, valuation, UI, and live-data code.

It currently defines family profiles for:

- default equity / ETF
- `ES`
- `NQ`
- `CL`
- `GC`
- `SI`
- `HG`
- `SPX`
- `NDX`

Key fields carried by the registry:

- option security type
- underlying security type
- default option and underlying symbol
- exchange
- currency
- trading class
- option multiplier
- settlement kind
- pricing-model label
- whether amortized mode is allowed
- whether current live-data path is supported
- whether stock-style underlying legs are allowed

Current important behavior:

- premium multiplier is no longer hard-coded to `100`
- `SPXW` resolves to family `SPX`
- `NDXP` resolves to family `NDX`
- FOP families expose `underlyingSecType = FUT`
- SPX / NDX expose `underlyingSecType = IND`

## 4. Supported Instrument Families

### Equity / ETF options

This is still the reference path.

- pricing uses spot-style BSM within current app assumptions
- stock legs are supported
- amortized mode is supported
- live data uses the legacy stock / option flow

### ES / NQ futures options

These are the most advanced non-equity additions so far.

- live data path is enabled
- global `Underlying Contract Month` control is used to lock the underlying futures month
- option pricing still uses the current app framework, not a dedicated Black-76 style futures-option model
- amortized mode is disabled
- stock-style underlying legs are disabled

### SPX / NDX index options

- live option subscriptions are enabled
- underlying is treated as `IND`
- cash-settled semantics are recognized
- amortized mode is disabled
- stock-style underlying legs are disabled

Current caveat:

- option quotes may stream while the underlying index quote itself is still absent or stale

### CL / GC / SI / HG futures options

Metadata has been added, but these are not fully operational in the browser yet.

- family profiles exist in `js/product_registry.js`
- XML descriptors exist in `contract_specs/`
- live-data support is not fully validated end-to-end yet

## 5. Contract Metadata

Root folder:

- `contract_specs/`

This folder stores family-level XML descriptors for instruments whose IBKR contract identity is more complex than stock / ETF options.

Current files include:

- `catalog.xml`
- `es.xml`
- `nq.xml`
- `spx.xml`
- `ndx.xml`
- `cl.xml`
- `gc.xml`
- `si.xml`
- `hg.xml`

What these XML files contain:

- product identity
- IB contract defaults
- settlement method
- multiplier
- trading class
- example local symbols
- notes on fields that vary per expiry / strike / series

Important status:

- these XML files are meant to become the long-term metadata source of truth
- they are **not yet wired into runtime loading**
- current runtime still uses `js/product_registry.js` as the active product metadata source

## 6. Pricing Source of Truth

`pricing_core.js` holds the pure pricing authority.
`valuation.js` holds pure portfolio aggregation.
`bsm.js` preserves the legacy global API used by older app code and tests.

Do not duplicate pricing logic outside:

- `processLegData(...)`
- `computeLegPrice(...)`
- `computeSimulatedPrice(...)`

Important implementation facts:

- option pricing time uses `calendar days / 365`
- trading-day counts are informational only
- `closePrice` can override simulated pricing
- stock legs bypass BSM and use the scenario underlying directly
- option multiplier now comes from the product registry, not a global `100`

Important limitation:

- FOP families are currently carried by the same overall pricing framework, so analytics are still approximate
- live market marks are useful; theoretical FOP modeling is still unfinished

## 7. Settlement and Amortized Semantics

`amortized.js` and related UI were originally written for equity-style deliverable options.

That is still true in spirit, so recent work deliberately prevents incorrect behavior from being shown for products that do not fit that model.

Current behavior:

- equity / ETF combos can use amortized mode
- FOP families cannot use amortized mode
- SPX / NDX cannot use amortized mode

Reason:

- FOPs deliver into futures, not shares
- SPX / NDX are cash-settled index options
- the current amortized engine assumes share-like delivery semantics

## 8. State Model

`app.js` owns the session state and top-level orchestration.
Pure session helpers live in `js/session_logic.js`.

Current state also includes:

- `underlyingContractMonth`

This field was added for FOP live-data qualification and is currently a **global combo-wide control**, not a per-leg field.

That design is intentional for now because P&L charts assume a single aligned underlying x-axis per combo.

Important group fields:

- `viewMode`
- `liveData`
- `settleUnderlyingPrice`
- `legs[]`

Important leg fields:

- `type`
- `pos`
- `strike`
- `expDate`
- `iv`
- `currentPrice`
- `cost`
- `closePrice`

## 9. Control-Panel and UI Notes

Relevant files:

- `js/control_panel_ui.js`
- `js/session_ui.js`
- `js/group_editor_ui.js`

Recent UI behavior:

- the control panel shows `Underlying Contract Month` only when the selected symbol resolves to a product whose underlying security type is `FUT`
- the field is disabled and marked `N/A for STK / IND` for equity / ETF and cash-settled index options
- default values for ES / NQ are generated by `OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(...)`

Default interpretation:

- the field is meant to specify the underlying futures month used for live FOP qualification
- format is `YYYYMM`

## 10. Probability Analysis

Probability analysis now has a separate proxy-mapping layer:

- `js/distribution_proxy_config.js`

Reason:

- front futures contracts like `ES` do not have a stable long-lived return history suitable for the existing Student-t fit workflow

Current mapping:

- `ES -> SPY`
- `SPX -> SPY`
- `SPXW -> SPY`
- `NQ -> QQQ`
- `NDX -> QQQ`
- `NDXP -> QQQ`
- `GC -> GLD`
- `SI -> SLV`

`js/prob_charts.js` now resolves a distribution symbol through this config before consulting `T_DIST_PARAMS_DB`.

This logic is intentionally configurable and should be extended here rather than hard-coded elsewhere.

## 11. Live Data Architecture

### Frontend

`js/ws_client.js` now sends a more structured contract payload.

The payload can include:

- `secType`
- `symbol`
- `exchange`
- `currency`
- `multiplier`
- `tradingClass`
- `contractMonth`
- `underlyingContractMonth`
- `strike`
- `right`
- `expDate`

### Backend

`ib_server.py` now dynamically builds IB contracts instead of assuming everything is `Stock(...)` or stock-style `Option(...)`.

It now handles:

- `STK`
- `IND`
- `FUT`
- `OPT`
- `FOP`

Important FOP behavior:

- the server can qualify the underlying future first
- if that succeeds, it uses `underConId` to help qualify the option
- if a first FOP attempt fails with a populated `tradingClass`, it may retry without `tradingClass`

Important SPX / NDX behavior:

- option subscriptions are allowed even if the underlying `IND` contract does not qualify or does not stream
- this was needed because the option legs themselves can still be useful for live testing

## 12. IBKR Runtime Notes

Useful runtime files:

- `ib_server.py`
- `ib_server.codex.log`
- `ib_server.codex.err.log`
- `ib_server.codex.pid`

The local server binds to `127.0.0.1:8765` by default unless changed through config.

When testing locally on this machine, Python has been available at:

- `C:\Users\xuzhe\AppData\Local\Programs\Python\Python313\python.exe`

Recommended manual startup:

1. `python -m http.server 8000`
2. `python ib_server.py`
3. open `http://localhost:8000/index.html`

Current Windows helper entry point still exists:

- `start_option_combo.bat`

## 13. What To Trust

If future notes and code disagree, trust in this order:

1. `js/product_registry.js` for current instrument-family assumptions
2. `js/pricing_core.js` for pricing behavior
3. `js/valuation.js` and `js/session_logic.js` for pure aggregation and session behavior
4. `js/ws_client.js` and `ib_server.py` for live-data contract resolution
5. UI modules for browser rendering behavior
6. `contract_specs/*.xml` for family-level IB metadata reference, but remember runtime does not yet load them

## 14. Current Caveats

- the app is no longer stock-only, but it is also not yet a general-purpose derivatives engine
- FOP pricing is still approximate within the existing framework
- ES / NQ live data assumes the whole combo shares one `underlyingContractMonth`
- if a combo truly mixes different underlying futures months, current chart semantics do not support that cleanly
- SPX / NDX option legs can stream while the underlying index quote is still missing
- CL / GC / SI / HG metadata exists, but live and analytics support is not fully finished
- `contract_specs/` and `js/product_registry.js` currently duplicate some truth and should eventually be unified

## 15. Recommended Next Steps

If work resumes from here, the most useful next steps are:

1. Load `contract_specs/*.xml` into runtime metadata so `js/product_registry.js` stops being a hand-maintained mirror.
2. Strengthen FOP contract qualification around weekly / monthly series and underlying futures month resolution.
3. Add validated live-data support for CL / GC / SI / HG.
4. Decide whether FOP analytics should remain approximate or move to a proper futures-option model.
5. Revisit SPX / NDX underlying index handling only if underlying live sync becomes necessary for the UI.

## 16. Current Test Coverage

Node-side regression coverage currently exists for:

- `market_holidays.js`
- `product_registry.js`
- `distribution_proxy_config.js`
- `bsm.js` compatibility behavior
- `amortized.js`
- `valuation.js`
- `session_logic.js`
- `session_ui.js`
- `control_panel_ui.js`
- `group_editor_ui.js`
- `hedge_editor_ui.js`

Current suite count:

- `45 passed, 0 failed`
