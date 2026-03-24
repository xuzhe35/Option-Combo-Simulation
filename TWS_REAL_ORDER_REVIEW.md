# TWS Real Order Review

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

- there is one real backend execution path
- the frontend can trigger it from two business flows
- `preview`, `test_submit`, and `submit` are now distinct runtime behaviors
- managed repricing exists only for real `submit`
- exact leg-cost attribution from IB execution reports is implemented
- historical replay uses the same UI runtime shapes, but does not send orders to TWS

In short:

- live real-order flow is implemented
- supervision and attribution are implemented
- recovery and long-term cleanup are still incomplete

## 2. The Only Real Execution Stack

The real TWS-touching stack is:

1. `js/group_order_builder.js`
2. `js/trade_trigger_logic.js`
3. `js/ws_client.js`
4. `trade_execution/models.py`
5. `trade_execution/engine.py`
6. `trade_execution/adapters/ibkr.py`
7. `ib_server.py`

The actual backend order adapter is:

- `trade_execution/adapters/ibkr.py`

That is the only place that ultimately constructs the BAG order and calls IB order APIs.

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
2. `js/ws_client.js` builds a close-intent combo payload
3. the same backend execution stack is used
4. the difference is the payload intent and the runtime state bucket, not a separate backend adapter

### C. Continue / Concede / Cancel on a managed live order

These actions also affect real broker state:

- `resume_managed_combo_order`
- `concede_managed_combo_order`
- `cancel_managed_combo_order`

They do not create a new business feature flow, but they absolutely do touch the existing live order in TWS.

## 4. Execution Modes and Real-Order Meaning

| Mode | Reaches TWS | Managed repricing | Intended meaning |
| --- | --- | --- | --- |
| `preview` | No | No | Build preview only |
| `test_submit` | Yes | No | Send a real BAG order with a guardrail price for inspection in TWS |
| `submit` | Yes | Yes | Send a real BAG order and enter managed repricing supervision |
| historical replay `preview` / `submit` / `test_submit` | No | No | Simulated only |

Important current truth:

- `test_submit` is still a real broker-facing action.
- It is safer than `submit`, but it is not broker-isolated.
- Historical replay never sends live orders to TWS, even when it uses the same runtime message shapes.

## 5. Live Safety Gates

The real-order path is intentionally behind multiple gates.

### Frontend gate

`js/ws_client.js` blocks live submit/test-submit when:

- `allowLiveComboOrders !== true`

### Runtime-mode split

Historical replay paths use local simulated order results and do not route through the live backend submit path.

### Validation gate

Before a live submit/test-submit goes out, the frontend first requests:

- `validate_combo_order`

The backend validates:

- contract identity
- leg qualification
- combo construction viability

## 6. Actual Backend Responsibilities

### `trade_execution/models.py`

Defines the normalized DTOs for:

- combo order request
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

### `trade_execution/adapters/ibkr.py`

This is the real execution implementation.

Current real responsibilities:

- qualify option / FOP / underlying contracts
- build combo BAG contracts
- compute combo pricing inputs from live legs
- build preview payloads
- run `what-if` preview when available
- place real BAG LMT orders
- manage repricing supervision for real `submit`
- resume, concede, and cancel supervised orders

### `ib_server.py`

This file is now the live transport and IB event bridge, not the place where order logic lives.

Current real responsibilities:

- receive frontend WebSocket messages
- pass execution actions into `ExecutionEngine`
- track submitted live combo orders
- listen to IB status and execution events
- push:
  - `combo_order_status_update`
  - `combo_order_fill_cost_update`

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

- old live managed-order supervision context is not fully reconstructed into the new page session

### D. Operator model is still local-first

The app assumes:

- localhost frontend
- localhost backend
- one user driving the workflow directly

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

### 5. Extract broker-neutral repricing policy

Goal:

- keep the IBKR adapter thinner if another broker adapter is ever added

## 12. Practical Read Order

If you want the smallest accurate reading path for real-order behavior, read in this order:

1. `js/trade_trigger_logic.js`
2. `js/group_order_builder.js`
3. `js/ws_client.js`
4. `trade_execution/models.py`
5. `trade_execution/engine.py`
6. `trade_execution/adapters/ibkr.py`
7. `ib_server.py`

If you only want to inspect “what can actually change a real TWS order”, the shortest set is:

- `js/ws_client.js`
- `trade_execution/adapters/ibkr.py`
- `ib_server.py`
