# FOP / Index Option Support Plan

## Goal

Extend the current single-underlying combo simulator so it can handle:

- futures options such as `ES`, `NQ`, `CL`, `GC`, `SI`, `HG`
- index options such as `SPX` and `NDX`

without forcing the codebase to pretend everything is a stock or ETF option.

This plan assumes the current app structure stays in place:

- plain HTML/CSS/JS
- one global underlying symbol and price
- group-based combo editing
- optional IBKR live quote bridge

## What Was Hardcoded Before

The current codebase originally assumed stock/ETF option semantics in several places:

1. Pricing multiplier was effectively fixed at `100` for all options.
2. The only delta-one leg inside combo groups was `stock`.
3. Amortized mode assumed exercise into `shares`.
4. IBKR live subscriptions assumed:
   - underlying = `Stock(...)`
   - options = `Option(..., exchange='SMART', multiplier='100')`
5. UI text referred to stock/ETF hedges and stock-price semantics.
6. Session flow let all deterministic products enter `amortized`, even when the settlement model was not equity-style delivery.

## What Was Adapted In This Pass

This pass intentionally stops short of full FOP support, but it creates the abstraction points needed for it.

Implemented now:

1. Added [js/product_registry.js](/C:/Users/xuzhe/OneDrive/projects/Option%20Combo%20Simulation/js/product_registry.js)
   - centralizes product-family metadata
   - separates equity, index-option, and futures-option families
   - stores premium multiplier and mode-support flags

2. Pricing now reads product-family multipliers
   - `ES` uses `50`
   - `NQ` uses `20`
   - `CL` uses `1000`
   - `GC` uses `100`
   - `SI` uses `5000`
   - `HG` uses `25000`
   - `SPX` / `NDX` remain `100`

3. Amortized mode is now explicitly gated
   - still supported for equity-style deliverable underlyings
   - blocked for futures options and cash-settled index options
   - this avoids giving misleading basis / assignment output

4. UI language is less stock-specific
   - hedge header is now generic
   - the group-leg `stock` option is labeled as equity-only

5. Legacy live-data path is now treated honestly
   - non-equity families no longer attempt the old stock-only subscription flow
   - users are prompted to use manual underlying prices for now

6. Tests were extended and all currently pass
   - `41 passed, 0 failed`

## Current Capability After This Pass

Works reasonably now:

- manual pricing and scenario evaluation for:
  - stock / ETF options
  - SPX / NDX style index options
  - FOP families, using family-specific premium multipliers
- trial / active / settlement mode valuation for those products

Deliberately not treated as "supported yet":

- amortized mode for FOP
- amortized mode for cash-settled index options
- IBKR live quote sync for FOP / SPX / NDX via the existing bridge
- true futures-option pricing model selection

## Remaining Gaps

These are the real blockers for full support.

### 1. XML Specs Are Not Yet The Runtime Source

Right now the browser uses a JS product registry.

What is still missing:

- load `contract_specs/*.xml` into runtime metadata
- validate required fields
- stop duplicating product-family settings across XML and JS

### 2. FOP Data Model Is Still Missing Underlying-Future Selection

A futures option family is not enough to identify a live underlying contract.

Still needed:

- per-leg or per-group `underlyingExpiry`
- possibly `tradingClass`
- possibly `exchange`
- optionally `localSymbol` or `conId`

Without this, `ES` alone is not enough to subscribe to the correct underlying future.

### 3. Pricing Model Selection Is Still Incomplete

The app currently uses one equity-style BSM engine.

Still needed:

- product-specific model routing
- Black-76 or equivalent futures-option pricing path
- explicit handling of cash-settled index options vs futures-deliverable options

### 4. Settlement Semantics Need To Be Split Cleanly

The current framework now distinguishes product families, but it still lacks a full settlement engine.

Still needed:

- equity delivery: shares
- cash-settled index options: cash payoff only
- futures options: resulting futures position semantics
- product-specific settlement calculations in amortized / settlement charts

### 5. IBKR Contract Resolution Must Become Product-Aware

The live bridge still needs a real contract-builder layer.

Still needed:

- generic contract payload from browser to Python bridge
- support for `STK`, `IND`, `OPT`, `FUT`, `FOP`
- family-specific exchange / tradingClass / multiplier fields
- `conId` override when provided

## Recommended Implementation Sequence

### Phase 1: Runtime Spec Loader

Goal:

- make XML specs the runtime source of truth

Tasks:

- add a small browser-side spec loader or precompiled JS manifest
- add a Python-side loader for `ib_server.py`
- normalize XML into one shared contract-family object shape

Exit criteria:

- `ES`, `SPX`, `CL` families resolve from XML instead of hand-maintained JS

### Phase 2: Contract Identity Expansion

Goal:

- let the user specify enough information to lock a concrete FOP or index option chain

Tasks:

- add optional fields for:
  - `underlyingExpiry`
  - `tradingClass`
  - `optionRoot` / effective option symbol
  - `localSymbol`
  - `conId`
- update JSON import/export

Exit criteria:

- the app can describe a concrete `ES` or `CL` option series family without ambiguity

### Phase 3: Product-Aware IB Contract Builder

Goal:

- make live subscriptions work beyond stock/ETF assumptions

Tasks:

- send normalized contract payloads from `ws_client.js`
- replace hardcoded `Stock(...)` / `Option(...)` usage in [ib_server.py](/C:/Users/xuzhe/OneDrive/projects/Option%20Combo%20Simulation/ib_server.py)
- build generic `Contract(...)` objects based on secType and metadata
- subscribe to:
  - `IND` underlyings for SPX/NDX
  - `FUT` underlyings for FOP families
  - `FOP` contracts for futures options

Exit criteria:

- live underlying sync works for at least one futures-option family and one index-option family

### Phase 4: Pricing Model Routing

Goal:

- stop pricing all products with one equity-only assumption

Tasks:

- add pricing model selection to family metadata
- keep current BSM path for equity and index options where appropriate
- add a futures-option model path for FOP
- update probability and chart code to use the selected model

Exit criteria:

- `ES` and `CL` no longer reuse the same pricing assumptions as stock options

### Phase 5: Settlement / Amortized Engine Split

Goal:

- give each product family a correct settlement story

Tasks:

- split amortized logic into:
  - equity-deliverable
  - cash-settled
  - futures-deliverable
- update chart labels and output units
- re-enable amortized only where the implementation is financially meaningful

Exit criteria:

- settlement results are product-correct instead of equity-shaped by default

## Suggested First Real Milestone

If we want the fastest path to meaningful progress, the next concrete milestone should be:

1. XML runtime loader
2. product-aware IB contract builder
3. one end-to-end live family:
   - `SPX` for index options
   - `ES` for futures options

That will validate both `IND/OPT` and `FUT/FOP` pipelines before expanding to `CL/GC/SI/HG`.
