# Delta Hedge Implementation Plan

## Purpose

Add Delta hedge support in staged, risk-controlled increments:

1. Global Delta monitoring and hedge recommendation.
2. Manual one-click hedge order preview / submit.
3. Optional automatic Delta hedge submission only after the first two stages are stable.

This plan intentionally avoids jumping straight to unattended live orders. The first deliverable should make the portfolio Delta state visible, explainable, and actionable without placing orders automatically.

## Confirmed Product Decisions

- Portfolio Delta scope:
  - Include only groups where `includedInGlobal !== false`.
  - Exclude groups that are not included in global totals.

- Existing hedge positions:
  - Include existing `state.hedges` positions in net Delta.
  - This is required to avoid repeated hedge recommendations after a hedge has already been added.

- Target Delta:
  - Configurable by the user.
  - The UI should support a target range / tolerance band rather than assuming fixed zero Delta.

- Supported hedge instruments:
  - Support directly tradable stock / ETF hedge instruments.
  - Support futures underlyings that are clearly tradable as hedge instruments, such as ES, HG, and SI.
  - Do not initially support cash-settled index underlyings such as SPX / NDX as directly tradable hedge contracts.
  - Do not implement cross-hedging in the first architecture pass.
  - Out of scope for now: SPX via ES / SPY, NDX via NQ / QQQ, beta-adjusted hedge pairs, or other conversion-ratio hedge mappings.

- Delta measurement scope:
  - First implementation uses same-underlying / directly-tradable hedge Delta.
  - Do not implement multi-currency Delta aggregation.
  - Do not implement Delta Dollar as the primary sizing unit in the first pass.
  - The code should avoid naming that prevents a later `dollarDelta` extension, but Stage 1/2 sizing should remain based on instrument Delta units.

- Missing Delta:
  - If any included group has missing Delta, stop hedge recommendation / execution.
  - Do not use best-effort Delta for trading decisions.

- Order style:
  - Default to LMT orders.
  - Keep MKT as an explicit emergency option.
  - Default LMT price policy:
    - If the hedge recommendation is BUY, prefill a limit price 0.1% below the current hedge reference price.
    - If the hedge recommendation is SELL, prefill a limit price 0.1% above the current hedge reference price.
    - The prefilled price should be editable by the user before any manual submit.
    - The final price must be rounded to the hedge instrument's tick size / price precision.
  - A submitted resting LMT hedge order must lock the DDH workflow until it fills, is canceled / rejected, or becomes stale.
  - Do not continuously retrigger DDH while a resting hedge order is active.

- Safety posture:
  - Avoid duplicate fills and repeated orders.
  - If a pending or partial hedge order could overshoot the target range after completion, require manual intervention.
  - Automatic submission should come only after manual preview / submit is reliable.

## Architecture Decision Record

### ADR-001: Hedge Execution Is Parallel To Combo Execution

Decision:

- Add a separate single-instrument hedge execution path.
- Do not force STK / FUT hedge orders through `ComboOrderRequest`.
- Do not construct fake BAG orders for Delta hedge.
- Keep combo execution behavior stable while adding hedge execution beside it.

Rationale:

- The current live-order stack is intentionally combo-specific.
- `trade_execution/models.py` defines combo request / preview / submit DTOs.
- `trade_execution/engine.py` currently routes combo actions through `handle_combo_action`.
- `trade_execution/adapters/ibkr.py` builds BAG contracts and computes combo mid prices from legs.
- Delta hedge orders are single-instrument STK / FUT orders with different sizing, pricing, status, and fill semantics.

Implementation direction:

- Add hedge DTOs next to combo DTOs, not inside combo DTOs.
- Add `handle_hedge_action` or an equivalent dispatch branch next to `handle_combo_action`.
- Add IBKR adapter methods for hedge validation, preview, submit, and cancel.
- Reuse only safe shared concepts:
  - account selection,
  - contract qualification helpers where appropriate,
  - quote extraction helpers,
  - what-if preview pattern,
  - order status / fill event emission pattern.
- Do not directly reuse combo-only concepts:
  - BAG contract construction,
  - combo leg ratio normalization,
  - combo net-mid sign logic,
  - combo managed repricing loop,
  - combo fill attribution payloads.

Future cleanup:

- After hedge execution exists, consider extracting broker-neutral helper utilities for common order lifecycle tasks.
- Do this only after combo and hedge tests exist, so the extraction does not change behavior by accident.

### ADR-002: Managed Repricing Is Not Reused For Hedge Orders

Decision:

- Do not directly reuse the existing combo managed repricing loop for hedge orders.
- Hedge LMT logic should start as a simpler, single-contract price policy.

Rationale:

- Combo managed repricing depends on live quotes for every combo leg.
- It tracks combo mid drift, best / worst combo price, and sign flips.
- A single STK / FUT hedge order has a simpler bid / ask / mark model.
- Reusing combo repricing would make hedge code harder to reason about and easier to break.

Implementation direction:

- Stage 2 supports manual LMT / MKT hedge orders.
- If later needed, add a hedge-specific single-instrument reprice policy.
- Automatic resting LMT logic belongs in Stage 3 or later, after manual hedge order flow is proven.

### ADR-003: No Cross Hedge Or Multi-Currency In First Pass

Decision:

- First pass supports direct, same-instrument-family hedge sizing only.
- No cross hedge mapping.
- No FX conversion.
- No portfolio-wide Delta Dollar aggregation.

Rationale:

- The immediate product need is Delta control for directly tradable underlyings.
- Cross hedge requires explicit conversion ratios and possibly beta / price-ratio assumptions.
- Multi-currency aggregation requires FX rates and base-currency policy.
- Adding those now would make the safety surface larger before the basic hedge workflow is proven.

Future extension:

- Add `dollarDelta` only when cross hedge or multi-currency support becomes a real requirement.
- A future formula can be:

```text
dollarDelta = pointDelta * referencePrice * fxRateToBaseCurrency
hedgeQty = (targetDollarDelta - currentDollarDelta) / hedgeDollarDeltaPerUnit
```

For now, recommendation sizing should use direct Delta units:

```text
deltaToHedge = targetDelta - currentNetDelta
rawHedgeQty = deltaToHedge / hedgeDeltaPerUnit
```

Where:

```text
hedgeDeltaPerUnit = deltaPerUnit * multiplier
```

Examples:

- Stock / ETF hedge:
  - `deltaPerUnit = 1`
  - `multiplier = 1`
  - one share contributes 1 Delta.

- Futures hedge:
  - `deltaPerUnit = 1`
  - `multiplier = product-specific point multiplier`
  - one futures contract contributes that product's point Delta multiplier.

### ADR-004: Resting LMT Hedge Orders Lock DDH Until Re-Armed

Decision:

- A manually submitted DDH hedge order is treated as a resting order that owns the current hedge decision.
- While that order is live, DDH must not submit or recommend a second live hedge order for the same active condition.
- DDH returns to an armed / idle state only after the resting order reaches a terminal state, is manually cleared, or is explicitly marked stale and handled by the user.

Default LMT price rule:

```text
BUY  limitPrice = referencePrice * (1 - 0.001)
SELL limitPrice = referencePrice * (1 + 0.001)
```

Rules:

- The reference price should come from the hedge instrument quote, not from an unrelated option leg.
- The first implementation can use a conservative reference-price helper in this order:
  - midpoint when bid and ask are both valid,
  - mark / last when midpoint is unavailable,
  - block when no usable reference price exists.
- The calculated price must be rounded to the hedge instrument's tick size.
- The UI should prefill this price automatically, but the user may still override it before manual submit.
- If the user edits the limit price manually, automatic quote refresh should not silently overwrite that user-entered value unless the user explicitly refreshes / resets the price.

Resting order lock state:

```text
idle -> recommendation_ready -> broker_preview_ready -> placing -> resting_locked
resting_locked -> filled -> idle
resting_locked -> canceled / rejected -> idle
resting_locked -> stale_needs_review -> manual cancel / clear -> idle
```

Stale / no-longer-applicable examples:

- Current net Delta has returned inside the target band before the order fills.
- Current net Delta now requires the opposite hedge side.
- The newly calculated safe hedge quantity differs materially from the resting order quantity.
- The projected net Delta after full fill would now land outside the target band or overshoot the target.
- Required Delta or hedge quote data becomes missing or stale.
- A partial fill changes the remaining risk enough that the rest of the order may no longer be safe.

Important safety rule:

- Stale detection should stop DDH and require user review first.
- It must not silently cancel and replace orders until a later explicit automation policy is designed and tested.

## Remaining Decisions Before Live Hedge Orders

These are not blockers for Stage 1, but they should be decided before Stage 2 or Stage 3:

- Default target range:
  - Example: target center `0`, tolerance `+/- 50 Delta`.

- Hedge quantity rounding:
  - Stocks / ETFs: integer shares.
  - Futures: integer contracts using product-specific Delta multiplier.
  - Decide whether to round toward the target midpoint, nearest edge of the band, or minimum trade that re-enters the band.

- Hedge order price policy:
  - Default LMT price is now defined as 0.1% away from the hedge reference price:
    - BUY: reference price minus 0.1%.
    - SELL: reference price plus 0.1%.
  - Remaining implementation decisions:
    - exact reference-price fallback order for each instrument type,
    - tick-size source and rounding direction,
    - whether manual price edits survive recommendation refreshes.
  - Whether MKT is allowed only manually, never automatically.

- Stale data policy:
  - Maximum age for option Delta, underlying quote, and hedge instrument quote.
  - Recommended default: block recommendations when quote freshness is unknown or stale.

- Manual hedge ledger:
  - Decide whether fills update `state.hedges` directly or append to a dedicated `deltaHedgeLedger`.
  - Recommendation: keep a ledger and also reflect active net hedge position in `state.hedges`.

- Execution gate naming:
  - Decide whether to add `allowLiveHedgeOrders`.
  - Recommendation: add it instead of reusing `allowLiveComboOrders`, because hedge orders are a separate risk surface.

- Maximum risk limits:
  - Max contracts / shares per hedge order.
  - Max notional per order.
  - Max hedge orders per day.
  - Cooldown after submit / fill / cancel.

## Current Codebase Assessment

### Existing Strengths

- Live Greeks are already supported.
  - `js/ws_client.js` sends `greeksEnabled` in live subscription payloads.
  - `ib_server.py` requests generic tick `106` when Greeks are enabled.
  - Option Delta is preserved in live quote snapshots when Greeks are enabled.

- Group Delta exists.
  - `js/valuation.js` computes group Delta from live option Delta, position, and product multiplier.
  - Underlying legs already contribute Delta via underlying-leg multiplier.

- Live account selection and real-order gating already exist.
  - Live combo orders are gated by `allowLiveComboOrders`.
  - TWS account selection is already available in the main UI.

- Combo execution is mature enough to use as a pattern.
  - Validation, preview, submit, status updates, managed repricing, and fill attribution exist for combo orders.

### Current Gaps

- There is no portfolio-level Delta summary.
  - Global derived data currently aggregates P&L, not Delta.

- Existing `hedges` are tracking rows, not executable hedge-order entities.
  - They currently support live P&L tracking but do not carry enough metadata for automatic order routing, conversion ratios, order status, or fills.

- The backend execution abstraction is combo-specific.
  - `ExecutionEngine` routes combo actions only.
  - `IbkrExecutionAdapter` builds BAG contracts and combo LMT orders.
  - Single-instrument STK / FUT hedge orders should not be forced through the BAG combo path.
  - Required direction: add a parallel hedge execution path, then optionally extract shared lifecycle helpers later.

- Auto-supervision is still browser-session dependent in some places.
  - Existing managed order recovery after browser reload is incomplete.
  - Auto hedge execution should not rely only on volatile browser state.

- DDH resting LMT lock state is not implemented yet.
  - The current UI can pre-check recommendation and broker preview only.
  - The current limit price field is manually entered.
  - There is no frontend manual `Place Hedge` control yet.
  - There is no active-order lock / stale-review / re-arm state machine yet.

## Stage 1: Global Delta And Recommendation

Goal: show a reliable global Delta number and a recommended hedge action without submitting orders.

### State Additions

Add `state.deltaHedge` with a normalized shape similar to:

```js
{
  enabled: false,
  targetDelta: 0,
  tolerance: 50,
  hedgeInstrument: {
    secType: "STK",
    symbol: "SPY",
    exchange: "SMART",
    currency: "USD",
    contractMonth: "",
    multiplier: 1,
    deltaPerUnit: 1,
    conversionRatio: 1
  },
  orderType: "LMT",
  limitOffset: 0,
  maxOrderQuantity: null,
  cooldownSeconds: 60
}
```

Notes:

- `enabled` in Stage 1 means recommendation enabled, not automatic trading.
- `deltaPerUnit` is the Delta contribution of one hedge unit.
- `conversionRatio` should remain `1` in the first pass.
- Cross-hedge conversion is explicitly out of scope for now.

### Valuation Changes

Update `js/valuation.js`:

- Add hedge Delta calculation for `state.hedges`.
- Add `computePortfolioDeltaSummary(globalState, groupResults, hedgeResults)`.
- Add fields to portfolio derived data:
  - `portfolioOptionDelta`
  - `portfolioHedgeDelta`
  - `portfolioNetDelta`
  - `portfolioDeltaAvailable`
  - `portfolioDeltaMissingGroupCount`
  - `portfolioDeltaIncludedGroupCount`
  - `portfolioDeltaDisplayable`

Rules:

- Include only group results where `isIncludedInGlobal === true`.
- Require every included live group with Delta-eligible open legs to have available Delta.
- Include existing hedge positions in `portfolioHedgeDelta`.
- If any required group Delta is missing, set net Delta unavailable and block recommendation.
- Do not aggregate across currencies.
- Do not convert to Delta Dollar in Stage 1.

### Hedge Recommendation Logic

Add a new pure module:

- `js/delta_hedge_logic.js`

Responsibilities:

- Normalize Delta hedge config.
- Decide whether net Delta is outside the target band.
- Calculate recommended hedge side and quantity.
- Detect no-trade cases:
  - Delta unavailable.
  - Greeks disabled.
  - Historical mode.
  - No hedge instrument.
  - Quantity rounds to zero.
  - Pending hedge order exists.
  - Proposed hedge would overshoot outside the target band.

Sizing formula for the first implementation:

```text
targetLower = targetDelta - tolerance
targetUpper = targetDelta + tolerance
deltaToHedge = targetDelta - currentNetDelta
rawHedgeQty = deltaToHedge / hedgeDeltaPerUnit
```

Recommendation rules:

- If `currentNetDelta` is inside `[targetLower, targetUpper]`, do nothing.
- If rounded hedge quantity would still leave net Delta outside the band, block or mark as manual-review depending on the final rounding policy.
- If rounded hedge quantity would cross through the band and end outside the other side, block and require manual intervention.
- If any included group Delta is unavailable, block.

Output shape example:

```js
{
  actionable: true,
  reason: "",
  side: "BUY",
  quantity: 12,
  projectedNetDelta: 8,
  currentNetDelta: -592,
  targetLower: -50,
  targetUpper: 50
}
```

### UI Changes

Add a new Delta Hedge panel in `index.html` and `chart_lab.html` if Chart Lab should mirror the shared workspace:

- Enable recommendation.
- Target Delta.
- Tolerance.
- Hedge instrument selector / editor.
- Current portfolio option Delta.
- Existing hedge Delta.
- Net Delta.
- Recommendation status.

Keep it read-only from an order-routing perspective in Stage 1:

- No submit button yet.
- No automatic order.
- No resting order.
- The primary front-end test surface is a calculation-only `Recommendation Preview`.
- `Recommendation Preview` must show the current suggested hedge side / quantity / projected net Delta without sending any broker request.

### Tests

Add / update JS tests:

- `tests/valuation.test.js`
  - Included groups only.
  - Excluded groups ignored.
  - Existing hedges included.
  - Missing group Delta blocks global net Delta.

- New `tests/delta_hedge_logic.test.js`
  - Inside band produces no action.
  - Outside band produces correct side and quantity.
  - Rounding behavior for stock and futures.
  - Overshoot detection blocks unsafe recommendation.
  - Missing Delta blocks recommendation.

Stage 1 progress checklist:

- [x] Add normalized `deltaHedge` state.
- [x] Persist / import / export `deltaHedge` safely.
- [x] Add portfolio Delta aggregation.
- [x] Include existing hedge rows in hedge Delta.
- [x] Add pure recommendation logic.
- [x] Add read-only Delta Hedge panel.
- [x] Add calculation-only `Recommendation Preview` UI.
- [x] Add valuation tests.
- [x] Add recommendation tests.
- [x] Confirm Stage 1 UI cannot send live orders.

Current Stage 1 recommendation progress:

- [x] Added `js/delta_hedge_logic.js` as a pure calculation module.
- [x] Added tests for normalization, inside-band no-op, STK sizing, FUT multiplier sizing, missing Delta blocking, pending-order blocking, and projected-Delta manual-review blocking.
- [x] Added `deltaHedge` session import/export normalization with runtime-field stripping.
- [x] Added portfolio Delta aggregation for included groups plus existing hedge rows.
- [x] Missing Delta in any included Delta-eligible live group blocks portfolio net Delta.
- [x] Added `js/delta_hedge_ui.js` as a calculation-only Recommendation Preview panel.
- [x] Wired the Delta Hedge panel into `index.html` and `js/app.js`.
- [x] Delta-only live quote refresh now rebuilds portfolio Delta aggregates for the preview panel.
- [x] Added UI tests proving Recommendation Preview does not call broker-payload dependencies.
- [x] Fixed null Delta handling so unavailable portfolio Delta is not coerced to zero.

## Stage 2: Manual Hedge Order Preview / Submit

Goal: allow the user to manually confirm a hedge order after reviewing the recommendation.

Stage 2 architectural rule:

- Combo execution and hedge execution must remain separate workflow paths.
- Hedge execution may share helper utilities, but not BAG order construction or combo managed repricing.

### Frontend Preview Modes

Delta Hedge UI must expose two different preview levels:

1. `Recommendation Preview`
   - Pure front-end calculation from portfolio Delta summary and `state.deltaHedge`.
   - Shows what should be traded now: side, quantity, hedge instrument, projected net Delta, and block reason if not actionable.
   - Sends no WebSocket message.
   - Cannot place, preview, or validate a broker order.
   - This is the first UI surface to build and manually test.

2. `Broker Preview / What-If`
   - Manual button after `Recommendation Preview` is actionable.
   - Sends `validate_hedge_order`, then `preview_hedge_order`.
   - Never sends `submit_hedge_order`.
   - Shows qualified contract details, limit / market order details, projected net Delta, and IB what-if / margin details when available.
   - Should work before any live-submit control exists.

Submit must remain a separate third action:

- `Submit Hedge` is hidden or disabled until a separate live hedge-order gate, selected account, valid recommendation, and successful preview are present.
- Preview mode must be testable in the UI without enabling live hedge orders.
- Before submit is exposed, the UI must have automatic LMT prefill and resting-order lock behavior specified in Stage 2B.

### Backend Model

Add hedge-order DTOs separate from combo DTOs:

- `HedgeOrderRequest`
- `HedgeOrderPreview`
- `HedgeSubmitResult`
- `HedgeValidationResult`

Suggested actions:

- `validate_hedge_order`
- `preview_hedge_order`
- `submit_hedge_order`
- `cancel_hedge_order`

Do not route these through combo BAG construction.

Backend model checklist:

- [x] Add `HedgeOrderRequest`.
- [x] Add `HedgeOrderPreview`.
- [x] Add `HedgeSubmitResult`.
- [x] Add `HedgeValidationResult`.
- [x] Keep combo DTO behavior unchanged.
- [x] Add tests for hedge DTO parsing / serialization.

### Backend Adapter

Extend `trade_execution/adapters/ibkr.py` or add a focused helper class to:

- Qualify STK and FUT hedge contracts.
- Request / reuse live quotes for the hedge instrument.
- Build STK / FUT orders.
- Support LMT and MKT.
- Run what-if preview when available.
- Place live orders only after validation and account checks.

Order defaults:

- LMT by default.
- DAY TIF by default.
- MKT requires an explicit UI selection.

Adapter checklist:

- [x] Qualify STK hedge contracts.
- [x] Qualify FUT hedge contracts.
- [ ] Reuse or extract quote snapshot helpers for STK / FUT.
- [x] Build LMT hedge orders.
- [x] Build MKT hedge orders only when explicitly requested.
- [x] Run what-if preview when available.
- [x] Submit live order only after frontend validation and account checks.
- [x] Emit hedge-specific order status payloads.
- [x] Emit hedge-specific fill payloads.
- [x] Implement backend `cancel_hedge_order` for submitted STK / FUT hedge orders.
- [x] Do not call combo BAG builder.
- [x] Do not call combo managed repricing loop.

Backend submit note:

- [x] Backend submit currently requires an explicit account.
- [x] Frontend has a separate live hedge-order gate before exposing submit.

Execution engine checklist:

- [x] Add `handle_hedge_action` or equivalent dispatcher.
- [x] Route `validate_hedge_order`.
- [x] Route `preview_hedge_order`.
- [x] Route `submit_hedge_order`.
- [x] Route `cancel_hedge_order`.
- [x] Preserve existing `handle_combo_action` behavior.
- [x] Add backend unit tests for routing.
- [x] Wire hedge dispatch into `ib_server.py` before combo fallback.
- [x] Add separate hedge submit tracking callback; do not reuse combo submit tracking.

### Frontend Transport

Update `js/ws_client.js`:

- Build hedge order payload from the current recommendation.
- Require live mode.
- Require `allowLiveComboOrders === true` or introduce a separate `allowLiveHedgeOrders` gate.
- Recommendation: introduce separate `allowLiveHedgeOrders` to make the risk boundary explicit.
- Require selected account.
- First send validate, then preview or submit.

Frontend transport checklist:

- [x] Add hedge order payload builder.
- [x] Add calculation-only recommendation preview path that sends no WebSocket message.
- [x] Add manual broker preview path using validate + preview only.
- [x] Add automatic default LMT price calculation from hedge reference quote.
- [x] Preserve manual LMT price overrides until the user explicitly refreshes / resets the price.
- [x] Require live mode.
- [x] Require selected account for broker preview.
- [x] Add separate `allowLiveHedgeOrders` gate unless explicitly rejected.
- [x] Validate before broker preview.
- [x] Handle hedge preview results.
- [x] Handle hedge submit results.
- [x] Handle hedge status updates.
- [x] Handle hedge fill updates.
- [x] Block duplicate submits while a hedge order is pending.
- [x] Block submit / preview refresh when a resting hedge order is locked unless user is reviewing that order.

### UI

Add buttons:

- Refresh Recommendation / Preview Recommendation
- Broker Preview / What-If Hedge
- Submit Hedge
- Cancel Hedge Order, if pending

Show:

- Contract being traded.
- Side / quantity.
- Order type.
- Limit price or MKT warning.
- Auto-prefilled LMT price source and manual override state.
- Projected net Delta after full fill.
- What-if / margin warning if available.
- Current pending order state.

### Fill Handling

Add hedge fill event handling:

- Emit `hedge_order_status_update`.
- Emit `hedge_order_fill_update`.
- Update hedge position or ledger only from actual fills.
- Do not assume submitted quantity is filled.

Manual intervention rule:

- If a live hedge order partially fills while any quantity is still resting, stop and require user action.
- Active partial/stale orders may be canceled, but may not be cleared/re-armed until the broker order is terminal.

Stage 2 progress checklist:

- [x] Add calculation-only recommendation preview UI.
- [x] Add manual broker preview / what-if button.
- [x] Add default LMT price prefill: BUY 0.1% below reference, SELL 0.1% above reference.
- [x] Add tests for default LMT price prefill and tick rounding.
- [x] Add UI behavior for preserving user-edited LMT price.
- [x] Add manual submit button.
- [x] Add cancel button for pending hedge order.
- [x] Show projected net Delta in recommendation and broker preview.
- [ ] Show projected net Delta after partial fill when available.
- [x] Update hedge ledger / hedge rows only from actual fills.
- [x] Block DDH and require manual review after partial hedge fills with remaining quantity.
- [x] Block duplicate broker-preview requests while one is pending.
- [x] Add frontend tests for manual hedge preview flow.
- [x] Add backend tests for STK / FUT preview and submit behavior.
- [x] Add backend tests for hedge submit tracking, status payloads, fill payloads, and cleanup.
- [x] Add safe WebSocket smoke script for hedge validate / preview only.
- [x] Add tests for smoke script payload safety.
- [x] Run JS and Python regression suites after Stage 2 / Stage 3 wiring.

Current Stage 2 backend lifecycle progress:

- [x] Hedge submit result is recorded through a hedge-specific engine callback.
- [x] `ib_server.py` tracks hedge orders by `orderId` and `permId` in independent dictionaries.
- [x] Frontend Broker Preview / What-If now sends `validate_hedge_order` before `preview_hedge_order`.
- [x] Frontend Broker Preview / What-If requires live mode, connected WebSocket, selected TWS account, actionable recommendation, and positive LMT price.
- [x] Frontend Broker Preview / What-If stores validation and preview results in `state.deltaHedge` runtime fields.
- [x] Frontend Broker Preview / What-If has no submit button and no path that sends `submit_hedge_order`.
- [x] Delta Hedge panel now includes limit price and reuses the global TWS Order Account selection; it does not own a separate account selector.
- [x] Hedge status events emit `hedge_order_status_update`.
- [x] Hedge execution reports emit `hedge_order_fill_update`.
- [x] Hedge fill reports deduplicate by execution id before updating fill totals.
- [x] Hedge cancel requests use a hedge-specific adapter registry and call `cancelOrder` on the original single-instrument order.
- [x] Hedge cancel refuses orders from a different websocket session and terminal broker statuses.
- [x] Hedge tracking is removed when the owning websocket disconnects.
- [x] Frontend has consumed hedge status / fill updates.
- [x] Hedge fills update frontend `state.hedges` from actual execution reports.
- [x] Frontend marks partial hedge fills with remaining quantity as `stale_needs_review` and blocks re-arming until cancel / terminal status.

## Stage 2B: Manual Submit With Resting LMT Lock

Goal: expose manual `Place Hedge` only after DDH can safely lock around a live resting order and avoid duplicate hedge orders.

This stage is still manual. It is not automatic DDH. The user chooses to place the order after recommendation preview and broker preview.

### State Model

Add runtime-only DDH order state similar to:

```js
{
  orderState: "idle", // idle | recommendation_ready | broker_preview_ready | placing | resting_locked | stale_needs_review | filled | canceled | rejected
  restingOrder: {
    orderId: null,
    permId: null,
    conId: null,
    symbol: "",
    secType: "STK",
    side: "BUY",
    quantity: 0,
    filledQuantity: 0,
    remainingQuantity: 0,
    limitPrice: null,
    referencePrice: null,
    placedAtNetDelta: null,
    projectedNetDeltaAfterFullFill: null,
    targetDelta: 0,
    tolerance: 50,
    placedAt: "",
    status: "",
    staleReason: ""
  }
}
```

State checklist:

- [x] Define a pure DDH order-state model with explicit statuses.
- [ ] Keep broker-preview runtime fields separate from live resting-order fields.
- [x] Store enough information to decide whether a resting order is still applicable.
- [ ] Strip volatile runtime order state from saved sessions unless a recovery design is added.
- [ ] Decide whether active live order recovery belongs in backend authority before enabling auto-submit.

### LMT Price Policy

Implementation checklist:

- [x] Add a pure helper to select hedge reference price from quote data.
- [x] Add a pure helper to calculate default LMT:
  - BUY: `referencePrice * 0.999`.
  - SELL: `referencePrice * 1.001`.
- [x] Add tick-size / precision rounding.
- [x] Add tests for BUY default price.
- [x] Add tests for SELL default price.
- [x] Add tests for missing / invalid reference price blocking default LMT.
- [x] Add tests that manual price edits are not overwritten by normal quote refresh.
- [x] Wire the helper into Delta Hedge UI.
- [x] Show whether the displayed limit price is auto-filled or manually edited.

### Manual Place Flow

Implementation checklist:

- [x] Add a separate live hedge-order gate such as `allowLiveHedgeOrders`.
- [x] Add `Place Hedge` button only when:
  - recommendation is actionable,
  - broker preview is fresh and successful,
  - selected account is present,
  - live hedge-order gate is enabled,
  - no resting hedge order is locked,
  - LMT price is valid or MKT was explicitly selected.
- [x] Send `submit_hedge_order` only from the manual place flow.
- [x] Record `placing` state immediately before submit.
- [x] Transition to `resting_locked` only after broker submit acknowledgment / order id.
- [x] Show a pending / resting status instead of generating a new order.
- [x] Add frontend tests proving repeated clicks cannot submit duplicate orders.
- [x] Add frontend tests proving recommendation refresh does not submit while locked.

### Resting Order Applicability

Add a pure evaluator for active resting orders.

Applicability checklist:

- [x] If current net Delta is unavailable, mark the resting order `stale_needs_review`.
- [x] If current net Delta is now inside the target band, mark `stale_needs_review`.
- [x] If the recommended side is now opposite the resting order side, mark `stale_needs_review`.
- [x] If the newly safe quantity differs materially from the resting order remaining quantity, mark `stale_needs_review`.
- [ ] If full fill would now overshoot outside the band, mark `stale_needs_review`.
- [x] If a partial fill leaves remaining quantity resting, mark `stale_needs_review`.
- [x] While still applicable, keep DDH in `resting_locked` and suppress new hedge submissions.
- [x] Do not auto-cancel or auto-replace in Stage 2B.
- [x] Require manual cancel / clear before re-arming from `stale_needs_review`.

### Status / Fill / Cancel Handling

Implementation checklist:

- [x] Consume `hedge_order_status_update` in the frontend.
- [x] Consume `hedge_order_fill_update` in the frontend.
- [x] Update filled / remaining quantity from broker events only.
- [x] Do not update hedge ledger from submitted quantity.
- [x] Update hedge ledger or `state.hedges` only from actual fills.
- [x] Transition terminal filled / canceled / rejected statuses back toward `idle` or a review state.
- [x] Add manual `Cancel Hedge Order` action for resting orders.
- [x] Add manual `Clear / Re-arm` action only after terminal states; active stale orders require cancel first.
- [x] Add tests for partial fill requiring manual review.
- [x] Add tests for cancel / reject re-arming behavior.

### Smoke / Manual Verification

Verification checklist:

- [ ] Safe broker preview still works with auto-filled LMT price.
- [x] Manual submit is impossible until live hedge gate is enabled.
- [x] With live hedge gate disabled, UI can be manually tested without placing orders.
- [x] With a mocked / test adapter, placing enters `resting_locked`.
- [x] While locked, new recommendations do not produce duplicate submit payloads.
- [x] Stale conditions move the order to `stale_needs_review`.
- [x] Partial fill with remaining quantity moves the order to `stale_needs_review`.
- [x] Cancel path can return the UI to `idle`.
- [ ] Existing combo order flow remains unchanged.

## Stage 3: Optional Auto Submit

Goal: allow automatic hedge execution only after Stage 1 and Stage 2 prove stable.

### Additional Required Controls

- Separate `autoDeltaHedgeEnabled`.
- Separate live-order kill switch for hedge orders.
- Cooldown after every order event.
- Max orders per day.
- Max quantity per order.
- Max notional per order.
- Block when any hedge order is pending.
- Block when any Delta leg is missing or stale.
- Block when projected full fill would land outside target band.
- If partial fill leaves quantity resting, mark stale and cancel the remaining live order before re-evaluating.
- Require fresh broker preview before automatic submit.
- Do not auto-submit MKT orders; MKT remains manual-only.

### Backend Authority

Before enabling unattended auto submit, move core supervision to the backend:

- Maintain hedge order state per client/session.
- Track pending hedge orders.
- Track partial fills.
- Recalculate projected Delta after fills if the frontend provides updated Delta snapshots.
- Prefer backend-side duplicate-order prevention over browser-only flags.

### Proactive Resting LMT Orders

The manual resting LMT lock in Stage 2B is required before any auto-submit work.

Additional proactive automation can be considered only after simple manual submit and lock behavior are stable:

- User defines an outer warning band and inner target band.
- System places a resting LMT order before the hard threshold is crossed.
- The order price is intentionally away from the market.
- If Delta or market data changes such that fill would be unsafe, cancel or require manual action.

This is more complex than threshold-triggered submit and should not be part of Stage 1 or Stage 2.

Stage 3 progress checklist:

- [x] Add explicit `autoDeltaHedgeEnabled` / `autoSubmitEnabled`.
- [x] Add separate live hedge-order kill switch dependency.
- [x] Add cooldown enforcement.
- [x] Add max order quantity enforcement.
- [x] Add max notional enforcement.
- [x] Add max daily hedge order count.
- [x] Block automation when any hedge order is pending.
- [x] Block automation when Delta is missing or stale.
- [x] Require LMT and a positive limit price for auto-submit.
- [x] Require fresh matching broker preview before auto-submit.
- [x] Add configurable proactive arm buffer so DDH can place LMT before the hard tolerance boundary.
- [x] Add periodic browser-side supervisor tick for cooldown / stale-preview recovery.
- [x] Add auto cancel for active stale hedge orders when automation is enabled.
- [x] Partial fill with remaining quantity becomes stale and is eligible for auto-cancel of the remaining order.
- [x] Add backend-side duplicate active hedge-order guard for the same websocket session and hedge id.
- [ ] Move full Delta decision authority into backend.
- [x] Add reload / reconnect recovery for active hedge-order state through backend snapshot reattachment.
- [x] Add browser-side capped audit log for auto hedge decisions.
- [ ] Add durable backend audit logging for every auto hedge decision / submit / cancel.
- [x] Add tests for auto-submit gating.
- [ ] Reuse Stage 2B resting-order lock state instead of creating a second duplicate-order mechanism.
- [x] Reuse Stage 2B resting-order lock state instead of creating a second duplicate-order mechanism.

Current Stage 3 implementation note:

- The first auto-submit implementation is browser-side and intentionally conservative.
- It can request broker preview, submit only after a matching fresh preview, and cancel stale active hedge orders.
- It now also relies on the backend hedge-order registry to reject duplicate active hedge submits for the same websocket session and hedge id.
- Backend active hedge tracking survives browser websocket disconnects, records status/fills while detached, and can be reattached by the next `active_hedge_orders_snapshot`.
- The Delta decision authority is not yet backend-owned.
- Before calling this fully unattended / production-grade, finish durable audit logging and backend Delta-decision authority.

## Master Progress Checklist

### Stage 0: Planning And Guardrails

- [x] Confirm included-group-only portfolio Delta scope.
- [x] Confirm existing hedge positions must count toward net Delta.
- [x] Confirm configurable target Delta / tolerance.
- [x] Confirm missing Delta blocks recommendation.
- [x] Confirm Stage 1 is recommendation-only.
- [x] Confirm manual order flow comes before auto-submit.
- [x] Confirm no cross hedge in first pass.
- [x] Confirm no multi-currency support in first pass.
- [x] Confirm hedge execution must be parallel to combo execution.
- [x] Confirm combo managed repricing is not reused directly.

### Stage 1: Recommendation-Only

- [x] Implement normalized `deltaHedge` state.
- [x] Implement portfolio Delta aggregation.
- [x] Implement hedge Delta aggregation from existing `hedges`.
- [x] Implement recommendation module.
- [x] Implement read-only UI panel.
- [x] Add recommendation and valuation tests.
- [x] Run JS test suite for current recommendation module.

### Stage 2: Manual Hedge Orders

- [x] Add hedge DTOs.
- [x] Add hedge backend route.
- [x] Add IBKR STK / FUT hedge adapter methods.
- [x] Add hedge order status / fill tracking.
- [x] Add frontend preview flow.
- [x] Add frontend submit flow.
- [x] Add hedge preview UI.
- [x] Add hedge submit / pending-order UI.
- [x] Add frontend submit-state tests.
- [x] Add backend smoke script for WebSocket validate / preview.
- [x] Run JS and Python test suites.

### Stage 2B: Manual Resting LMT Lock

- [x] Implement automatic LMT prefill rule.
- [x] Preserve user-edited LMT values.
- [x] Add resting hedge-order state model.
- [x] Add manual place gate and submit button.
- [x] Add active-order lock that suppresses repeated DDH submits.
- [x] Add stale-order detection.
- [x] Add manual cancel / clear / re-arm flow.
- [x] Add frontend tests for lock and stale states.
- [x] Add smoke verification for submit-disabled and mocked locked states.

### Stage 3: Automatic Hedge Orders

- [x] Reassess Stage 1/2 production behavior before starting.
- [x] Add explicit auto hedge enablement.
- [x] Add complete first-pass risk limits: max quantity, max notional, cooldown, daily order count, LMT-only auto-submit.
- [x] Add backend duplicate-order guard for active hedge orders.
- [ ] Add backend Delta-decision authority.
- [x] Add partial-fill intervention workflow for remaining live orders.
- [x] Add reload / recovery behavior.
- [x] Add browser-side audit log / diagnostics.
- [ ] Add durable backend audit log / diagnostics.
- [x] Run full regression suite.

## Suggested Implementation Order

1. Add Delta hedge state normalization in `js/session_logic.js`.
2. Add portfolio Delta aggregation in `js/valuation.js`.
3. Add `js/delta_hedge_logic.js` as pure recommendation logic.
4. Add Delta Hedge panel UI bindings.
5. Add Stage 1 tests and update `tests/run.js`.
6. Add hedge order DTOs in `trade_execution/models.py`.
7. Add hedge action routing in `trade_execution/engine.py`.
8. Add STK / FUT hedge order methods in `trade_execution/adapters/ibkr.py`.
9. Add frontend manual preview request flow.
10. Add automatic LMT price prefill helpers and tests.
11. Add frontend live hedge gate and manual submit request flow.
12. Add resting-order lock / stale-review state machine.
13. Add status / fill handling and hedge ledger updates.
14. Add manual-order tests.
15. Reassess before building automatic submit.

## Acceptance Criteria For Stage 1

- Global Delta is visible only when Greeks are enabled and live data is available.
- Only included groups contribute to portfolio option Delta.
- Existing hedge positions contribute to net Delta.
- Missing Delta in any included group blocks recommendation.
- Recommendation side and quantity are deterministic and covered by tests.
- No real broker order can be placed from Stage 1 UI.
- No cross hedge or multi-currency logic is required.
- Delta Dollar is not required for Stage 1.

## Acceptance Criteria For Stage 2

- Hedge orders use a separate STK / FUT execution path, not BAG combo construction.
- Preview is available before submit.
- LMT price is auto-prefilled from the hedge reference price using the 0.1% away-from-market rule.
- User-entered LMT prices are not silently overwritten by quote refresh.
- Live submit is gated by account selection and an explicit live hedge order switch.
- Fill updates adjust hedge position / ledger from actual broker reports.
- Pending and partial orders block duplicate hedge submissions.
- A live resting hedge order locks DDH until filled, canceled / rejected, or manually reviewed as stale.
- Existing combo order behavior remains unchanged.
- Combo managed repricing is not used for hedge orders.

## Acceptance Criteria For Stage 3

- Auto submit is impossible unless Stage 2 manual order flow is stable.
- Auto submit has explicit enablement, risk limits, cooldown, stale-data checks, and pending-order checks.
- Partial fill with remaining quantity marks the order stale and cancels the remaining live order before re-evaluation.
- Projected overshoot blocks automation.
- Browser refresh does not silently lose active hedge-order safety state.
- Backend rejects duplicate active hedge submits for the same websocket session and hedge id.
- Durable backend audit logging and backend-owned Delta decision authority remain future hardening items.
