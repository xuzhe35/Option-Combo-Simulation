# Delta Hedge Current State

**Updated:** 2026-07-05

This file name is historical. The original staged implementation plan has been retired because the code now includes recommendation, broker preview, manual submit, cancel / clear, resting-order lock, stale-review, and guarded auto-preview / auto-submit flows. Treat this document as the current Delta Hedge behavior map.

## Implemented Scope

Delta Hedge is available in `index.html` only. `chart_lab.html` loads the shared transport pieces it needs for the shared shell, but it does not expose the Delta Hedge panel.

Current capabilities:

- portfolio Delta aggregation for included groups
- existing hedge rows included in net Delta
- STK and FUT hedge instruments
- target Delta, tolerance, and proactive buffer controls
- recommendation preview without broker traffic
- broker validation and what-if preview
- manual `Place Hedge`
- active order lock through `resting_locked`
- stale-review detection for resting orders
- manual `Cancel` and terminal/stale `Clear`
- optional auto-preview / auto-submit supervisor
- active hedge-order snapshot after reconnect
- shared allocation-aware position-impact confirmation before manual submit
- one-time backend execution authorization bound to session, payload, TTL, and TWS position snapshot
- FUT fill attribution, multiplier-aware Delta/P&L, and futures quote subscriptions

Out of scope today:

- cross-hedging such as SPX via ES or NDX via NQ
- multi-currency Delta aggregation
- Delta Dollar as the primary sizing unit
- backend-owned unattended Delta decision authority
- hedge-specific managed repricing

## Frontend Modules

### `js/delta_hedge_logic.js`

Pure decision logic. It does not touch DOM, WebSocket state, or broker objects.

Responsibilities:

- normalize `state.deltaHedge`
- compute STK / FUT hedge recommendations
- apply target Delta, tolerance, and proactive-buffer rules
- calculate default LMT prices from hedge quotes
- preserve user-edited LMT prices unless explicitly refreshed
- detect active resting orders
- mark resting orders stale when the recommendation no longer matches
- decide auto-preview / auto-submit / auto-cancel actions

### `js/delta_hedge_ui.js`

DOM binding and rendering for the Delta Hedge panel.

Responsibilities:

- bind user controls
- show option Delta, existing hedge Delta, net Delta, and projected Delta
- render recommendation status
- render broker preview / what-if status
- gate `Place Hedge`
- expose cancel and clear actions
- display auto-supervisor status

### `js/delta_hedge_transport.js`

WebSocket payload construction and request-state transitions.

Actions sent:

- `validate_hedge_order`
- `preview_hedge_order`
- `submit_hedge_order`
- `cancel_hedge_order`

The transport is separate from combo order transport. Hedge orders are single-instrument STK / FUT orders, not fake BAG combos.

### `js/app.js`

Owns panel binding and the auto-supervisor loop.

The auto-supervisor can:

- request a broker preview when the recommendation is actionable and no fresh matching preview exists
- submit only after a fresh matching preview exists
- request stale-order cancel when `autoCancelStaleOrders` is enabled

## Backend Modules

### `trade_execution/models.py`

Defines hedge DTOs:

- `HedgeOrderRequest`
- `HedgeOrderPreview`
- `HedgeSubmitResult`
- `HedgeValidationResult`

### `trade_execution/engine.py`

Routes hedge actions beside combo actions through `handle_hedge_action`.

It handles:

- validation result payloads
- preview result payloads
- submit result payloads
- cancel result payloads
- duplicate active hedge-order rejection through the server-provided active-order predicate

### `trade_execution/adapters/ibkr_hedge.py`

Implements the IBKR single-instrument hedge path.

Responsibilities:

- validate STK / FUT hedge requests
- qualify the hedge contract
- build LMT / MKT orders
- resolve real price increments for LMT hedges
- quantize LMT prices to the contract tick
- run what-if preview when available
- place live hedge orders
- cancel live hedge orders by order id / perm id

### `ib_server_order_tracking.py`

Owns hedge tracking payloads and event consumers.

It emits:

- `hedge_order_status_update`
- `hedge_order_error`
- `hedge_order_fill_update`
- `active_hedge_orders_snapshot`

### `ib_server.py` / `ib_server_ws.py`

`ib_server.py` wires the execution engine, active hedge-order duplicate guard, tracking maps, and event consumers.

`ib_server_ws.py` dispatches hedge actions through `ExecutionEngine` and provides `request_active_hedge_orders_snapshot`.

## State And Gates

Important top-level state:

- `state.deltaHedge`
- `state.allowLiveHedgeOrders`
- `state.selectedLiveComboOrderAccount`
- `state.greeksEnabled`
- `state.marketDataMode`
- `state.hedges`

Important runtime fields under `state.deltaHedge`:

- `lastRecommendation`
- `lastPreview`
- `lastPreviewAt`
- `pendingRequest`
- `status`
- `orderState`
- `restingOrder`
- `autoSubmitEnabled`
- `autoCancelStaleOrders`
- `autoMaxNotional`
- `autoMaxOrdersPerDay`
- `cooldownSeconds`
- `autoPreviewMaxAgeSeconds`
- `autoDecisionLog`

Live submit requires all of:

- live market-data mode
- Greeks enabled and portfolio Delta available
- actionable recommendation
- selected TWS account
- explicit `allowLiveHedgeOrders === true`
- successful broker preview
- no active resting hedge order

Auto-submit additionally requires:

- `deltaHedge.enabled === true`
- `deltaHedge.autoSubmitEnabled === true`
- order type `LMT`
- positive limit price
- fresh matching broker preview
- notional, quantity, daily-count, and cooldown limits to pass

Historical mode disables broker preview, submit, cancel, and auto-submit.

## Recommendation Rules

Recommendation input is the portfolio Delta summary plus normalized Delta Hedge config.

Core sizing:

```text
targetLower = targetDelta - tolerance
targetUpper = targetDelta + tolerance
hedgeDeltaPerUnit = multiplier * deltaPerUnit * conversionRatio
deltaToHedge = targetDelta - currentNetDelta
rawHedgeQty = deltaToHedge / hedgeDeltaPerUnit
```

The recommendation blocks when:

- Delta Hedge is disabled
- Greeks are disabled
- mode is historical
- portfolio Delta is unavailable
- hedge instrument is incomplete
- hedge Delta per unit is invalid
- an active hedge order is pending/resting
- rounded quantity is zero
- max order quantity is exceeded
- projected Delta would still land outside tolerance

## Resting Order And Stale Review

After submit, a hedge order moves through `placing` into `resting_locked` when the order is live. While locked, new hedge recommendations are blocked.

A resting order becomes `stale_needs_review` when the current recommendation no longer supports the active order, including:

- Delta moved back inside tolerance
- Delta became unavailable
- opposite side is now required
- remaining quantity no longer matches recommendation
- projected Delta would land outside tolerance
- broker status indicates a terminal or non-actionable condition

Manual clear is allowed after terminal states. A stale order that is still active must be canceled before it can be cleared.

## Market Data Dependencies

Delta Hedge depends on live option Greeks and hedge instrument quotes.

Live option Greeks use IB generic tick `106`. Market-data subscriptions are pooled in `ib_server_market_data.py`, so shared contracts reuse one TWS market-data line. If a later subscriber needs Greeks for a contract already streaming without generic tick `106`, the backend cancels and reopens that single shared line with the merged generic tick list.

Manual `sync_underlying` also uses the pooled helper. If it opens a one-shot line that no active subscription shares, it cancels the line after reading the quote.

## Current Boundaries

- Auto-submit is still frontend-supervised. Browser continuity matters.
- Backend duplicate checks are account + hedge-id scoped across live browser sessions; the backend still does not own the full Delta decision loop.
- There is no hedge-specific repricing loop.
- The app assumes a local operator and local backend.
- `test_submit` wording applies to combo orders; Delta Hedge has preview and submit, not combo-style `test_submit`.

## Tests

Node coverage in `tests/run.js` includes:

- `tests/delta_hedge_logic.test.js`
- `tests/delta_hedge_transport.test.js`
- `tests/delta_hedge_ui.test.js`
- `tests/ws_client.test.js`
- `tests/app.test.js`
- `tests/valuation.test.js`
- `tests/session_logic.test.js`

Python coverage includes:

- `tests/trade_execution_engine_test.py`
- `tests/ibkr_hedge_adapter_test.py`
- `tests/ib_server_order_tracking_test.py`
- `tests/ib_server_ws_test.py`
- `tests/order_tracking_test.py`
- `tests/smoke_delta_hedge_ws_test.py`

## Maintenance Rules

- Keep hedge order DTOs separate from combo DTOs.
- Do not route hedge orders through BAG combo construction.
- Keep pure Delta decisions in `js/delta_hedge_logic.js`.
- Keep WebSocket payload state in `js/delta_hedge_transport.js`.
- Keep DOM state in `js/delta_hedge_ui.js`.
- Keep direct IB hedge order construction in `trade_execution/adapters/ibkr_hedge.py`.
- Add tests before changing auto-submit, stale-review, duplicate-order, or live-order gate behavior.
