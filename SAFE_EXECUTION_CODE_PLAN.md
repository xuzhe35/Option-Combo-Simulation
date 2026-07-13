# Execution Safety Contract

**Updated:** 2026-07-11

## Goal

All broker-facing flows must use the same safety contract even though Combo BAG,
Close Plan, STK, and FUT adapters retain product-specific construction and pricing.
No live order may be submitted because a UI module is missing, from a stale preview,
or after the account position snapshot changed.

## Safety Pipeline

1. Build a canonical `OrderIntent` with owner, account, contract identity, signed quantity, and order terms.
2. Compare it with the latest account-level TWS positions and workspace allocations.
3. Qualify contracts or preview the order at the broker.
4. Freeze the exact intent behind a short-lived, one-time execution authorization.
5. Render the shared confirmation surface. Missing UI or missing position data is fail-closed.
6. Submit only when the token, session, payload fingerprint, and position snapshot still match.
7. Attribute fills to explicit Group or hedge allocations with full contract metadata.

## Current Implementation

- `js/order_safety.js`
  - canonical hedge intent
  - shared contract identity
  - Group/hedge allocation conflict analysis
  - strict broker-preview matching
- `js/order_confirmation_ui.js`
  - shared live-order confirmation surface
  - position-impact disclosure
  - fail-closed when the current TWS position snapshot is unavailable
- Open Combo
  - removed confirmation-UI fail-open
  - carries a backend one-time execution authorization from validation to submit
  - confirmation sends the frozen validated payload instead of rebuilding it from mutable UI state
  - TIF, managed reprice threshold, concession ratio, routing/contract identity, multipliers, observed pricing inputs, and profile terms are covered by the backend fingerprint
  - confirmation describes the actual managed server-pricing workflow rather than an undefined client LMT
- Close Plan
  - retains its richer staged-plan dialog and existing one-time Close Plan token
  - remains fail-closed and compatible with the common safety contract
- Delta Hedge
  - configuration Dialog and persistent global operating status
  - mandatory shared confirmation for manual submit
  - auto-submit blocked on unavailable position data or allocation conflicts
  - preview must match account, instrument, month, multiplier, side, quantity, type, and limit
  - backend authorization is one-time, session-bound, 60-second, payload-bound, and position-snapshot-bound
  - broker tick-quantized LMT prices and price increments are adopted by the client and bound into the authorization
  - active-order duplicate guard is account + hedge identity scoped rather than WebSocket-only
  - active snapshot cannot steal an order still owned by another live session
- FUT hedge completion
  - fill payload carries contract month, multiplier, and Delta/unit
  - hedge allocation stores qualified FUT identity
  - FUT hedge live quotes use the futures subscription path
  - hedge P&L and portfolio Delta apply the contract multiplier
  - a broker-qualified multiplier change invalidates the preview and forces recalculation

## Verification Gates

- Pure Node tests for intent binding and allocation conflict detection.
- Python tests for one-time token use, payload mutation rejection, and position-snapshot mutation rejection.
- Existing Combo, Close Plan, Delta Hedge, valuation, WebSocket, tracking, and IB adapter suites.
- No real TWS order is sent by automated tests.

## Deliberate Boundaries

- Auto Delta Hedge remains browser-supervised; it stops when the page is not running.
- Cross-asset Delta conversion (for example SPX hedged by ES) still requires an explicit conversion model.
- Backend restart recovery of pre-existing, untagged TWS orders cannot infer historical workspace ownership. New execution safety prevents duplicates within the running backend and across live browser sessions.
