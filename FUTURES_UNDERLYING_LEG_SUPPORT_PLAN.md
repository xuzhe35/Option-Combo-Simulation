# Futures Underlying Leg Support Plan

**Created:** 2026-03-16

## 1. Current State

At the moment, a combo-group "underlying leg" is still an equity-style leg in code.

The clearest signs:

- the leg type stored in state is still `stock`
- the UI label still maps to `Underlying (Equity Only)`
- pricing treats that leg as `1x` spot exposure
- valuation titles still use stock wording unless patched by profile text
- live subscriptions for such legs go through the stock subscription path
- amortized logic treats the deliverable outcome as share-based

Relevant files:

- `js/group_editor_ui.js`
- `js/pricing_core.js`
- `js/valuation.js`
- `js/amortized.js`
- `js/ws_client.js`
- `js/group_ui.js`
- `js/prob_charts.js`

## 2. Practical Answer

So yes: **currently the combo-group underlying leg is effectively limited to equity-style exposure.**

Even though ES / NQ / SPX / NDX option families are now recognized by the app, the "underlying leg" part of the group model has not yet been generalized into a true delta-one leg abstraction.

## 3. Design Goal

The goal is **not** to bolt futures behavior onto the existing `stock` leg in an ad hoc way.

The cleaner target is:

- combo groups can contain option legs
- combo groups can optionally contain one or more delta-one underlying legs
- a delta-one underlying leg can be backed by:
  - equity / ETF spot
  - futures contract
  - later, possibly index cash placeholder or synthetic proxy

For the first implementation pass, the important new case is:

- FOP families use an underlying **futures** leg inside the group

## 4. Key Constraint

A group chart uses a single underlying-price x-axis.

That means one combo group should continue to assume a single aligned underlying contract context.

So for futures-backed groups:

- all legs should still share one underlying contract month
- the existing global `Underlying Contract Month` control remains the right model for now
- we should **not** support mixing different futures months inside one group in this phase

## 5. Recommended Model Change

### Current model

- option legs: `call` / `put`
- underlying leg: `stock`

### Recommended model

Introduce the concept of a **delta-one leg** and let product metadata decide its semantics.

Two reasonable implementation options:

1. Minimal-change path
   - keep persisted `leg.type = 'stock'` for backward compatibility
   - internally reinterpret it as "underlying leg"
   - product profile determines whether that means equity spot or futures exposure

2. Cleaner long-term path
   - add explicit leg kinds such as `call`, `put`, `underlying`
   - optionally add `underlyingSecType` or derive it from product profile
   - migrate old saved `stock` legs to `underlying` on import

Recommendation:

- use the **minimal-change path first**
- keep legacy JSON compatibility
- add helper functions so the rest of the code stops directly checking `leg.type === 'stock'`

## 6. Phase Plan

### Phase 1: Replace hard-coded stock-leg checks with helpers

Create shared helpers such as:

- `isUnderlyingLeg(leg)`
- `isOptionLeg(leg)`
- `isEquityUnderlyingLeg(leg, profile)`
- `isFuturesUnderlyingLeg(leg, profile)`

Why first:

- today many modules branch directly on `leg.type === 'stock'`
- that makes futures support fragile and repetitive

Files to touch:

- `js/pricing_core.js`
- `js/valuation.js`
- `js/amortized.js`
- `js/chart_controls.js`
- `js/group_ui.js`
- `js/prob_charts.js`
- `js/trade_trigger_logic.js`
- `js/ws_client.js`

### Phase 2: Generalize pricing math for delta-one legs

Current stock-leg rule:

- value per unit = underlying price
- contract multiplier = `1`

Needed futures-leg rule:

- value per unit = underlying futures price
- contract multiplier = futures point value
- for ES this is `50`
- for NQ this is `20`
- for CL / GC / SI / HG it should come from product metadata

Implementation approach:

- extend `product_registry` with a dedicated field for delta-one leg multiplier
- do **not** overload option multiplier assumptions without naming it clearly

Suggested new metadata fields:

- `underlyingLegMultiplier`
- `underlyingLegDisplayName`
- `underlyingLegPriceModel`

Notes:

- for ES/NQ the option multiplier and futures point value happen to match
- for clarity, the code should still use a dedicated field

### Phase 3: UI and terminology cleanup

Change the leg-type UX from:

- `Underlying (Equity Only)`

to something product-aware, for example:

- `Underlying`

and then render a hint based on current symbol:

- `Underlying (Equity)` for stock / ETF families
- `Underlying (Future)` for FOP families

Behavior:

- keep the dropdown option hidden when `supportsUnderlyingLegs === false`
- change that rule so FOP families can opt in
- use product metadata to decide the label text

Files to touch:

- `js/group_editor_ui.js`
- `js/valuation.js`
- relevant HTML template text in `index.html`

### Phase 4: Live-data support for futures underlying legs

Current behavior:

- combo stock legs subscribe through `payload.stocks`
- group underlying price already has its own `payload.underlying`

Recommended first pass:

- futures underlying legs should **not** create a second independent quote stream
- they should reuse the already subscribed group underlying stream
- the leg's displayed `currentPrice` can default to the group underlying live mark unless manually overridden

Why:

- there is only one aligned underlying contract month per combo
- duplicate futures subscriptions would add complexity without adding real information

Files to touch:

- `js/ws_client.js`
- `ib_server.py` only if separate leg-level futures subscriptions are later required

### Phase 5: Valuation and charts

For a futures underlying leg:

- scenario value should move with the group underlying x-axis
- P&L should use futures multiplier
- labels should say `future` / `futures contract`, not `stock` / `shares`

Files to touch:

- `js/valuation.js`
- `js/group_ui.js`
- `js/chart.js`

### Phase 6: Explicitly keep amortized unsupported for futures-backed groups

Do **not** try to make amortized mode support futures in the same phase.

Reason:

- current amortized engine is built around equity-style delivery semantics
- futures settlement and post-exercise exposure need a separate design

Implementation:

- continue to block amortized mode for FOP families
- ensure futures underlying legs do not accidentally re-enable it

## 7. Recommended First Implementation Slice

The safest first slice is:

1. keep saved-leg format backward compatible
2. add shared helper functions for underlying-leg classification
3. allow FOP families to opt into underlying legs
4. price futures underlying legs with product-driven multiplier
5. update UI labels from `Equity Only` to product-aware wording
6. leave amortized unsupported
7. keep one global `Underlying Contract Month` per combo context

This would unlock:

- ES/NQ combos with an actual futures underlying leg
- correct multiplier-scaled combo P&L
- cleaner UI that no longer claims the underlying leg is equity-only

## 8. Risks

### Persistence compatibility

Saved sessions may already contain `stock` legs.

Mitigation:

- preserve import compatibility
- migrate legacy data in `session_logic.js`

### Wrong multiplier semantics

Futures delta-one P&L can look numerically plausible while still being wrong by a factor.

Mitigation:

- make `underlyingLegMultiplier` explicit in metadata
- add regression tests for ES and NQ underlying-leg P&L

### Terminology drift

The code currently mixes `stock`, `underlying`, `share`, and `deliverable`.

Mitigation:

- centralize wording in product metadata where possible

## 9. Test Plan

Add regression tests for:

- FOP families exposing `supportsUnderlyingLegs = true`
- ES underlying leg scenario P&L using multiplier `50`
- NQ underlying leg scenario P&L using multiplier `20`
- UI dropdown label switching from equity wording to generic underlying wording
- legacy saved `stock` legs still loading correctly
- amortized mode staying unavailable for futures-backed groups

Relevant test files:

- `tests/product_registry.test.js`
- `tests/valuation.test.js`
- `tests/group_editor_ui.test.js`
- `tests/session_logic.test.js`

## 10. Suggested Implementation Order

1. Product metadata changes in `js/product_registry.js`
2. Helper abstraction for underlying-leg detection
3. Pricing / valuation support for futures underlying legs
4. UI label cleanup
5. Regression tests
6. Optional live-data refinements

## 11. Out of Scope for This Phase

These should not be mixed into the first futures-underlying-leg rollout:

- true Black-76 futures-option pricing
- per-leg mixed underlying contract months inside one combo group
- amortized / exercise-to-futures modeling
- commodity FOP live support unless ES / NQ path is already stable
