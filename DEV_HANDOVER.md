# Option Combo Simulator - Developer Handover

**Updated:** 2026-03-17

## 1. Current Product Shape

This is a local browser app for building and evaluating multi-leg option structures, with optional IBKR live data and live combo execution.

The codebase is no longer just a pricing sandbox. It now has three distinct responsibilities:

- scenario analysis and charting
- session persistence and cost-basis tracking
- IBKR combo preview / test-submit / real submit with managed repricing

## 2. Current Frontend Shape

The frontend still runs as ordered global scripts from `index.html`.

Current actual order:

1. `js/t_params_db.js`
2. `js/market_holidays.js`
3. `js/date_utils.js`
4. `js/product_registry.js`
5. `js/trade_trigger_logic.js`
6. `js/distribution_proxy_config.js`
7. `js/pricing_core.js`
8. `js/bsm.js`
9. `js/chart.js`
10. `js/prob_charts.js`
11. `js/chart_controls.js`
12. `js/amortized.js`
13. `js/valuation.js`
14. `js/session_logic.js`
15. `js/session_ui.js`
16. `js/control_panel_ui.js`
17. `js/hedge_editor_ui.js`
18. `js/group_editor_ui.js`
19. `js/hedge_ui.js`
20. `js/group_ui.js`
21. `js/global_ui.js`
22. `js/app.js`
23. `js/ws_client.js`

If something becomes `undefined` in the browser, script order is still the first thing to check.

## 3. Current Architecture Split

### State and orchestration

- `js/app.js`

Owns session state and drives rendering.

### Pure domain logic

- `js/pricing_core.js`
- `js/amortized.js`
- `js/valuation.js`
- `js/session_logic.js`
- `js/trade_trigger_logic.js`
- `js/product_registry.js`

These files are the most stable and should stay free of DOM concerns.

### UI rendering and binding

- `js/control_panel_ui.js`
- `js/session_ui.js`
- `js/group_editor_ui.js`
- `js/hedge_editor_ui.js`
- `js/group_ui.js`
- `js/hedge_ui.js`
- `js/global_ui.js`

### Execution stack

- `js/ws_client.js`
- `ib_server.py`
- `trade_execution/engine.py`
- `trade_execution/models.py`
- `trade_execution/adapters/base.py`
- `trade_execution/adapters/ibkr.py`

This is the most important architectural shift versus earlier versions.

`ib_server.py` is now mainly:

- IB connection
- WebSocket endpoint
- market-data subscription bridge
- execution-report / order-status broadcaster

Actual combo execution behavior lives in `trade_execution/adapters/ibkr.py`.

## 4. Trial Trigger and Live Execution

The yellow Trial Trigger block is now a real execution feature, not just UI decoration.

Supported execution modes:

- `preview`
- `test_submit`
- `submit`

Meaning:

- `Preview Only`
  - build a combo preview only
- `Send to TWS (Test Only)`
  - send a real BAG order to TWS with a deliberately unfillable guardrail price
- `Send to TWS`
  - place a real `LMT @ MID` combo and enter managed repricing

The managed repricing path currently supports:

- live combo-mid recomputation from leg quotes
- configurable drift threshold
- configurable time-in-force (`DAY` / `GTC`)
- max retry budget
- timeout window
- continue monitoring / continue retries
- manual cancel
- optional exit condition that cancels the live order if the underlying reverses

## 5. Current Runtime Config

`config.ini` now contains execution defaults:

```ini
[execution]
managed_reprice_threshold_default = 0.01
managed_reprice_interval_seconds = 2.0
managed_reprice_max_updates = 12
managed_reprice_timeout_seconds = 600
```

These are backend defaults. Per-group UI still overrides:

- drift threshold
- time-in-force

If execution behavior changes in `config.ini`, restart `ib_server.py`.

## 6. Cost Fill Behavior

There are now two different cost-fill sources:

### Portfolio avg cost fallback

- source: IB `updatePortfolio`
- frontend message: `portfolio_avg_cost_update`

This remains useful for general account sync, but it is account-level and can blend identical contracts across groups.

### Exact trigger fill attribution

- source: IB `execDetails`
- frontend message: `combo_order_fill_cost_update`

For real Trigger-submitted combo orders, the backend now attributes each leg fill by:

- `orderId / permId`
- `conId`
- expected execution side

The frontend applies those leg prices only to the originating group and marks them as `costSource = execution_report`.

Important consequence:

- later `portfolio_avg_cost_update` messages will no longer overwrite those execution-report costs

This fixed the earlier problem where identical contracts in different groups contaminated each other’s cost basis.

## 7. Session Persistence Rules

This changed recently and matters a lot for cleanup.

Session export now keeps Trigger configuration but strips Trigger runtime state.

Export/import no longer preserves:

- broker status
- order ID / perm ID
- repricing counts
- last preview payload
- last trigger time
- pending request flags
- runtime errors

It also resets `enabled` to `false`.

So a saved JSON no longer reopens with stale `Filled` or stale live-order supervision metadata.

## 8. Current Product Family Layer

`js/product_registry.js` is still the runtime product source of truth.

Current families include:

- default equity / ETF
- `ES`
- `NQ`
- `CL`
- `GC`
- `SI`
- `HG`
- `SPX`
- `NDX`

It controls:

- secType and underlying type
- multiplier
- settlement style
- amortized support
- live-data support
- whether underlying stock-style legs are allowed

`contract_specs/*.xml` still exist but are not yet loaded at runtime.

## 9. Current Known Boundaries

- Managed repricing is abstracted away from `ib_server.py`, but it still lives inside the IBKR adapter rather than a broker-neutral strategy module.
- `Exit Condition` is currently evaluated on the frontend from live underlying updates, then forwarded to backend cancel logic.
- Page reload does not reconstruct old managed execution context.
- `contract_specs/` is still reference metadata only.

## 10. What To Trust If Notes and Code Drift

Trust in this order:

1. `js/product_registry.js`
2. `js/pricing_core.js`
3. `js/session_logic.js`
4. `js/trade_trigger_logic.js`
5. `trade_execution/adapters/ibkr.py`
6. `ib_server.py`
7. `js/ws_client.js`

## 11. Current Test Status

The current Node regression suite covers:

- pricing and valuation
- session logic
- UI rendering/binding
- Trigger logic
- WebSocket message handling

Current suite status at handover:

- `75 passed, 0 failed`
