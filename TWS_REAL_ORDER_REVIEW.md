# TWS Real Order Review

Checked against the working-tree execution routes on 2026-09-19. This is an
implementation map, not evidence that real orders were sent during this audit.
The current authorization contract is [EXECUTION_SAFETY_CONTRACT.md](EXECUTION_SAFETY_CONTRACT.md).

## Purpose

This document reviews only the parts of the codebase that can actually affect a real TWS order.

It intentionally excludes:

- ordinary chart rendering
- valuation-only logic
- Chart Lab projection behavior
- historical replay paths that never send live broker orders

## 1. Current Stage

The real-order pipeline is now in a usable but still local-operator-oriented stage.

Current actual shape:

- there is one execution engine with combo and hedge branches
- the frontend can trigger combo execution from trial-trigger and close-group flows
- the frontend can also trigger Delta Hedge STK / FUT execution
- combo `preview`, `test_submit`, and `submit` are distinct runtime behaviors
- Delta Hedge has broker preview / what-if, submit, and cancel behaviors
- managed repricing exists only for real `submit`
- exact combo leg-cost attribution from IB execution reports is implemented
- hedge order status / fill tracking is implemented
- historical replay uses the same UI runtime shapes, but does not send orders to TWS

In short:

- live combo and hedge order flows are implemented
- supervision and attribution are implemented
- recovery and long-term cleanup are still incomplete

## 2. Real Execution Stack

The real TWS-touching stack is:

1. `js/group_order_builder.js`
2. `js/trade_trigger_logic.js`
3. `js/order_safety.js` / `js/order_confirmation_ui.js`
4. `js/combo_order_transport.js` / `js/delta_hedge_transport.js`
5. `js/ws_client.js` / `ib_server_ws.py`
6. `trade_execution/models.py` / `trade_execution/safety.py`
7. `trade_execution/engine.py`
8. `trade_execution/adapters/ibkr.py` / `trade_execution/adapters/ibkr_hedge.py`
9. `ib_server_order_tracking.py` / `ib_server.py`

The actual backend order adapter is:

- `trade_execution/adapters/ibkr.py`

Combo BAG construction lives in `trade_execution/adapters/ibkr.py`. Single-instrument Delta Hedge order construction is mixed into that adapter from `trade_execution/adapters/ibkr_hedge.py`.

## 3. What Can Really Touch TWS

### A. Trial Trigger open flow

Current live path:

1. live underlying update arrives in `js/ws_client.js`
2. trigger rules are evaluated through `js/trade_trigger_logic.js`
3. if the group is armed and the condition is met, the frontend builds a combo-order payload
4. the frontend sends:
   - `validate_combo_order`
   - then `submit_combo_order` when validation passes
5. backend routes the request through `trade_execution/engine.py`
6. `trade_execution/adapters/ibkr.py` validates contracts, prices the combo, builds the BAG order, and may place the real order

### B. Close Group flow

Current live path:

1. the user clicks `Close Group`
2. `js/combo_order_transport.js` uses the shared builders to preview a close plan
3. the staged confirmation freezes the plan behind its own short-lived Close Plan token
4. the adapter revalidates that plan before the close flow; it may use option BAG
   orders or staged underlying delivery handling, depending on the plan
5. `cancel_close_plan` revokes a pending confirmation; cancellation of an already
   working order is a separate broker action

Global Auto Close has separate `preview_global_equivalent_close` /
`submit_global_equivalent_close` routes and a one-use plan token. It handles one
candidate expiry across included Active Groups, nets conservative ITM underlying
requirements, and leaves normal liquid legs for the Group Close flow. A working
net underlying order must fill before its Group adjustments are applied.

### C. Continue / Concede / Cancel on a managed live order

These actions also affect real broker state:

- `resume_managed_combo_order`
- `concede_managed_combo_order`
- `cancel_managed_combo_order`

They do not create a new business feature flow, but they absolutely do touch the existing live order in TWS.

### D. Delta Hedge flow

Current live path:

1. `js/valuation.js` builds portfolio Delta summary for included groups and existing hedges
2. `js/delta_hedge_logic.js` evaluates the recommendation and automation gates
3. `js/delta_hedge_ui.js` exposes recommendation preview, broker preview, submit, cancel, and clear controls
4. `js/delta_hedge_transport.js` sends hedge payloads
5. backend routes `validate_hedge_order`, `preview_hedge_order`, `submit_hedge_order`, and `cancel_hedge_order` through `trade_execution/engine.py`
6. `trade_execution/adapters/ibkr_hedge.py` qualifies the STK / FUT contract, builds the order, runs what-if preview when available, places live hedge orders, and cancels live hedge orders

Manual submit and auto-submit both use the same hedge submit action. Auto-submit is browser-supervised and gated more tightly than manual submit.

## 4. Execution Modes and Real-Order Meaning

| Mode | Places / changes live broker order | Managed repricing | Intended meaning |
| --- | --- | --- | --- |
| combo `preview` | No | No | Build combo preview only |
| combo `test_submit` | Yes | No | Send a real BAG order with a guardrail price for inspection in TWS |
| combo `submit` | Yes | Yes | Send a real BAG order and enter managed repricing supervision |
| Delta Hedge broker preview | No live order | No | Validate hedge contract and run broker preview / what-if when available |
| Delta Hedge manual submit | Yes | No | Place a real STK / FUT hedge order |
| Delta Hedge auto-submit | Yes | No | Browser-supervised submit after a fresh matching broker preview and risk gates |
| Delta Hedge cancel | Yes | No | Cancel an active hedge order by order id / perm id |
| historical replay `preview` / `submit` / `test_submit` | No | No | Simulated only |

Important current truth:

- `test_submit` is still a real broker-facing action.
- Its guardrail price does not make it broker-isolated or guarantee no fill.
- Delta Hedge `submit` and auto-submit are real broker-facing actions.
- Historical replay never sends live orders to TWS, even when it uses the same runtime message shapes.

## 5. Live Safety Gates

The real-order path is intentionally behind multiple gates.

### Frontend gate

`js/ws_client.js` blocks live submit/test-submit when:

- `allowLiveComboOrders !== true`

Delta Hedge submit has its own explicit switch:

- `allowLiveHedgeOrders === true`
- selected live TWS account
- actionable recommendation
- successful broker preview
- no active resting hedge order

Auto-submit additionally requires LMT order type, positive limit price, fresh matching broker preview, max quantity / notional / daily count checks, cooldown checks, and `deltaHedge.autoSubmitEnabled === true`.

### Runtime-mode split

Historical replay paths use local simulated order results and do not route through the live backend submit path.

### Validation gate

Before a live submit/test-submit goes out, the frontend first requests:

- `validate_combo_order`

The backend validates:

- contract identity
- leg qualification
- combo construction viability

Open Combo validation and Hedge preview issue a one-use, 60-second
execution-plan token bound to session, canonical payload and TWS position
snapshot. Submission consumes it; stale or altered evidence is rejected. Close
flows use their own Close Plan confirmation mechanism. The hedge backend also
qualifies STK/FUT identity and rejects active duplicates by account + hedge id
across live sessions; recovery cannot steal another live session's order.

## 6. Actual Backend Responsibilities

### `trade_execution/models.py`

Defines the normalized DTOs for:

- combo order request
- hedge order request
- preview payload
- submit result
- managed state metadata

### `trade_execution/engine.py`

Routes only these execution actions:

- `validate_combo_order`
- `preview_combo_order`
- `submit_combo_order`
- `resume_managed_combo_order`
- `concede_managed_combo_order`
- `cancel_managed_combo_order`
- `cancel_close_plan`
- `preview_global_equivalent_close`
- `submit_global_equivalent_close`
- `validate_hedge_order`
- `preview_hedge_order`
- `submit_hedge_order`
- `cancel_hedge_order`

### `trade_execution/adapters/ibkr.py`

This is the real execution implementation.

Current real responsibilities:

- qualify option / FOP / underlying contracts
- build combo BAG contracts
- qualify STK / FUT hedge contracts through `ibkr_hedge.py`
- build single-instrument hedge orders through `ibkr_hedge.py`
- compute combo pricing inputs from live legs
- build preview payloads
- run `what-if` preview when available
- place real BAG LMT orders
- place real STK / FUT hedge orders
- manage repricing supervision for real `submit`
- resume, concede, and cancel supervised orders
- cancel live hedge orders

### `ib_server.py`

This file composes the live backend. `ib_server_ws.py` routes requests,
`ib_server_order_tracking.py` owns tracking payloads/event consumers, and the
execution engine/adapters own order logic.

Current real responsibilities:

- receive frontend WebSocket messages
- pass execution actions into `ExecutionEngine`
- track submitted live combo orders
- track submitted live hedge orders
- provide active hedge-order snapshots after reconnect
- listen to IB status and execution events
- push:
  - `combo_order_status_update`
  - `combo_order_fill_cost_update`
  - `hedge_order_status_update`
  - `hedge_order_fill_update`
  - `hedge_order_error`

## 7. Managed Repricing: Current Real Behavior

Managed repricing exists only for `execution_mode == 'submit'`.

Current lifecycle:

1. build live combo preview
2. submit BAG LMT
3. register managed context
4. begin `_managed_reprice_loop()`
5. periodically recompute latest combo mid from current leg pricing
6. re-place the order only when drift exceeds the configured threshold
7. stop supervision on one of several terminal or safety conditions

IB disconnect or market-data invalidation stops managed repricing. The broker
order stays at its last submitted limit for manual review; reconnect does not
automatically resume or modify it.

Current stoppable states include:

- `stopped_max_reprices`
- `stopped_timeout`
- `stopped_partial_fill`
- `stopped_sign_change`

Current resumable states:

- `stopped_max_reprices`
- `stopped_timeout`

Current concession behavior:

- only meaningful when the managed order has stopped in a concession-eligible state
- reprices from the mid toward the worse side by a user-driven concession ratio

## 8. Real Fill Attribution

Execution-report attribution is one of the most important recent improvements.

### Old risk

Account-level average cost could blend identical contracts across groups.

### Current behavior

`ib_server.py` listens to IB execution details and emits:

- `combo_order_fill_cost_update`

The frontend then writes exact attributed fills back into the correct group legs.

Current write-back behavior:

- opening fills update `leg.cost`
- close fills update `leg.closePrice`
- exact broker-attributed values are marked as `execution_report`
- later generic portfolio average-cost sync does not overwrite those exact execution-report values

### Scope note

This exact fill-attribution path is for real `submit`.

`test_submit` still reaches TWS, but the main exact-fill write-back path is intentionally centered on the real live-submit flow.

Delta Hedge fills emit `hedge_order_fill_update`; the frontend folds those broker-reported fills into hedge state instead of combo leg cost fields.

## 9. Live vs Historical Order Semantics

This distinction matters a lot now and should not be blurred.

### Live

- goes through `ib_server.py`
- can reach TWS
- can place, modify, and cancel real broker orders
- can receive real status and execution reports

### Historical replay

- uses the frontend runtime shape for consistency
- can emit simulated `combo_order_submit_result`
- can emit simulated `combo_order_fill_cost_update`
- never places a live TWS order

If a bug looks like “orders are appearing in the UI but should not be live”, the first thing to verify is whether the session is actually in historical mode.

## 10. Current Known Boundaries

These are not necessarily bugs, but they are the real boundaries of the current implementation.

### A. `test_submit` is still broker-touching

This is intentional today, but it means:

- users must still treat it as a live broker action
- it is not a sandbox in the strict sense

### B. Exit-condition cancellation is still frontend-initiated

The frontend currently evaluates the trigger exit condition from live underlying updates, then requests backend cancellation.

That is workable, but it means:

- browser session continuity still matters
- the backend is not yet the sole authority for exit-condition supervision

### C. Reload recovery is incomplete

If the page is reloaded:

- old live managed combo-order supervision context is not fully reconstructed into the new page session
- active hedge-order snapshots can reattach hedge order state, but the Delta decision loop itself remains browser-supervised

### D. Delta Hedge automation is browser-supervised

The backend rejects duplicate active hedge orders by account + hedge id across
live sessions, but the full Delta decision authority is still in the browser.

### E. Operator model is still local-first

The app assumes:

- one operator driving the workflow directly
- local-first services, optionally bound to configured LAN/Tailscale addresses
- exact allowed browser origins; the ledger's remote opt-in is separate from
  workspace/admin access and broker order authorization

## 11. Later Cleanup / Deferred Work

These are the sensible future cleanup items, but they are not blockers for the current usable stage.

### 1. Move exit-condition supervision fully backend-side

Goal:

- make live order cancellation rules survive browser refreshes and reduce frontend dependence

### 2. Add stronger restart / recovery for managed live orders

Goal:

- reconnect a reloaded page to the current managed-order state more cleanly

### 3. Revisit `test_submit` semantics

Goal:

- keep its inspection value while making its broker-touching behavior even clearer in UI and docs

### 4. Improve auditability

Goal:

- make preview, submit, reprice, concede, cancel, and fill attribution easier to inspect from logs or exported diagnostics

### 5. Move Delta Hedge decision authority backend-side

Goal:

- make auto hedge decisions survive browser refreshes and produce durable backend audit records

### 6. Extract broker-neutral repricing policy

Goal:

- keep the IBKR adapter thinner if another broker adapter is ever added

## 12. Practical Read Order

If you want the smallest accurate reading path for real-order behavior, read in this order:

1. `js/trade_trigger_logic.js`
2. `js/group_order_builder.js`
3. `js/ws_client.js`
4. `js/delta_hedge_logic.js`
5. `js/delta_hedge_transport.js`
6. `trade_execution/models.py`
7. `trade_execution/engine.py`
8. `trade_execution/adapters/ibkr.py`
9. `trade_execution/adapters/ibkr_hedge.py`
10. `ib_server_order_tracking.py`
11. `ib_server.py`

If you only want to inspect “what can actually change a real TWS order”, the shortest set is:

- `js/ws_client.js`
- `trade_execution/adapters/ibkr.py`
- `trade_execution/adapters/ibkr_hedge.py`
- `ib_server.py`
