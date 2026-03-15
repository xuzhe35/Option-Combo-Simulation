# Option Combo Simulator - Developer Handover

**Updated:** 2026-03-15

## 1. Current Product Shape

This is a local browser app for options-combo scenario analysis with optional IBKR live data.

The current product includes:

- option legs and stock legs inside combo groups
- separate hedge rows for live stock or ETF tracking
- four combo-group modes: `trial`, `active`, `amortized`, `settlement`
- group-level P&L charts
- group-level amortized-basis charts
- global portfolio P&L chart
- global amortized banner and global amortized chart
- probability analysis charts

## 2. Script Model

The frontend still depends on ordered global scripts in `index.html`.

Current order:

1. `t_params_db.js`
2. `market_holidays.js`
3. `bsm.js`
4. `chart.js`
5. `prob_charts.js`
6. `chart_controls.js`
7. `app.js`
8. `ws_client.js`

## 3. Pricing Source of Truth

`bsm.js` remains the math authority.

Do not duplicate pricing logic outside:

- `processLegData(...)`
- `computeLegPrice(...)`
- `computeSimulatedPrice(...)`

Important implementation facts:

- option pricing time uses `calendar days / 365`
- trading-day counts are informational only
- `closePrice` can override simulated pricing
- stock legs bypass BSM and use the scenario underlying directly

## 4. State Model

`app.js` owns the session state.

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

## 5. The Four Modes

### `trial`

- live idea mode
- current price can act as effective starting cost

### `active`

- deterministic entry-cost mode
- focuses on expected P&L from stored costs

### `amortized`

- deterministic-cost scenario mode
- intended for pre-settlement effective-basis analysis
- uses `Scenario Underlying Price` when set
- owns the yellow amortized banner
- owns the group-level amortized chart

### `settlement`

- final settlement-style scenario mode
- shares the scenario-underlying concept
- does not show amortized banner or amortized chart

Helper functions added around this split:

- `isSettlementScenarioMode(viewMode)`
- `groupHasDeterministicCost(group)`

## 6. Amortized Calculations

### Group-level

`calculateAmortizedCost(group, evalUnderlyingPrice, globalState)` in `app.js` is the canonical amortized basis calculation.

It computes:

- initial cash outflow
- residual option value
- assignment or delivery cash
- resulting net shares
- effective basis

This feeds both:

- the group-level yellow amortized banner
- `AmortizationChart` in `chart.js`

### Global-level

`calculateCombinedAmortizedCost(groups, globalState)` combines all groups currently in `amortized` mode.

This powers the global amortized banner.

Important semantic detail:

- the global amortized banner uses each amortized group's own scenario-price override when present

## 7. Global Amortized Chart

The global amortized chart was added after amortized mode became independent from settlement.

Implementation details:

- UI lives in `index.html` under `#globalAmortizedCard`
- control logic lives in `chart_controls.js`
- rendering reuses `AmortizationChart`
- the chart combines all groups currently in `amortized` mode into one virtual portfolio

Important semantic detail:

- unlike the banner, the global amortized chart uses a shared global scenario-price x-axis

So the two outputs answer related but different questions:

- banner: combined effective basis using each group's own override
- chart: combined amortized portfolio behavior across a common scenario-price range

## 8. Chart Ownership

### `chart.js`

Owns:

- `PnLChart`
- `AmortizationChart`

### `chart_controls.js`

Owns:

- group P&L chart controls
- group amortized chart controls
- global P&L chart controls
- global amortized chart controls

New global amortized functions:

- `toggleGlobalAmortizedChart(...)`
- `setGlobalAmortizedChartRangeMode(...)`
- `triggerGlobalAmortizedChartRedraw()`
- `drawGlobalAmortizedChart(...)`

## 9. Live Data Notes

`ws_client.js` now supports a local browser-side port override.

Current behavior:

- default is `localhost:8765`
- the override UI is hidden unless expanded
- the chosen port is stored in browser local storage
- the backend still reads its bind port from `config.ini`

## 10. What To Trust

If future docs and code disagree, trust:

1. `bsm.js` for pricing behavior
2. `app.js` for mode behavior and amortized aggregation
3. `chart_controls.js` and `chart.js` for chart behavior

## 11. Current Caveats

- only groups in `amortized` mode contribute to the global amortized result
- `amortized` requires deterministic costs, so zero-cost groups are forced away from it
- the global amortized banner and global amortized chart do not use identical scenario semantics by design
