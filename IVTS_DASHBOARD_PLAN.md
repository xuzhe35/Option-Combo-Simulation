# IVTS Strategy Dashboard — Code Plan

Goal: surface the validated VRP research findings (see `VRP_RESEARCH_MEMO.md`)
as an objective, per-symbol dashboard on the IV Term Structure page, at
**suggestion level only** — no order is ever created from the dashboard. Paper
tracking happens through the existing sim-open workflow on the main pages.

## What the dashboard shows (per symbol card)

1. **Regime zone (TD slope)** — front(~7 DTE) / back(~14 DTE) ATM IV ratio on
   the trading-day clock with **frozen λ = 0.3** (the calibration the zones
   were validated under; independent of the display λ control):
   - `slope < 0.95` → zone **LONG DISPLACEMENT** (reverse iron fly)
   - `0.95 ≤ slope ≤ 1.05` → zone **STAND DOWN**
   - `slope > 1.05` → zone **SELL CALENDAR**
2. **Displacement watermark (|move|/EM)** — realized displacement over implied
   expected move, computed from the symbol's accumulated history samples
   (adjacent sample pairs 3–12 calendar days apart, time-scaled
   `ratio = |ΔS| / (EM₀·√(gap/frontDTE₀))`), rolling mean of the latest 26
   observations. Needs ≥ 8 observations before it reports; until then it
   shows a "collecting n/8" state. Below 0.95 it vetoes the reverse-fly
   suggestion (2010-14-era displacement pricing).
3. **Suggestion line** — zone × watermark mapped to the frozen playbook:
   - LONG DISPLACEMENT + watermark OK → "Reverse iron fly: buy front ATM
     straddle, sell ±EM wings. Hold to expiry (no early profit-take)."
   - LONG DISPLACEMENT + watermark < 0.95 → "Stand down — displacement is not
     underpriced in the current era."
   - SELL CALENDAR → "Calendar: sell front ATM straddle, buy ~2×DTE back.
     Exit at +50% of debit or front expiry."
   - STAND DOWN → "No options this week; delta book only."
   Every suggestion renders with the inputs it used (slope, expiries,
   watermark, n) and a fixed "suggestion only — paper/sim first" disclaimer.

## Design decisions

- **Frozen parameters** (`ZONE_LOW=0.95, ZONE_HIGH=1.05, WATERMARK_FLOOR=0.95,
  λ_SIGNAL=0.3, FRONT_TARGET=7±2 DTE, BACK=2× within [front+4, target+5]`):
  constants in the core module, mirrored from the backtest. Deliberately not
  user-tunable from the UI — coarse-and-correct beats fine-and-fitted.
- **Signal independence from display λ**: the dashboard recomputes TD IVs from
  raw calendar IVs at λ=0.3 internally, so playing with the TD IV λ input
  never moves the signal.
- **Data sources already on the page**: zone ← current card detail rows
  (needs the front/back expiries subscribed — the default 10-stream limit
  covers 5 nearest expiries, enough for 7/14 DTE); watermark ← the per-symbol
  history document that the Sample button already accumulates. No new backend
  calls, no new subscriptions.
- **DOM-free core**: all three computations live in
  `js/iv_term_structure_core.js` so they are unit-testable and reusable later
  by any auto-suggestion pipeline.

## Steps

1. **Core** (`js/iv_term_structure_core.js`)
   - `computeRegimeSignal(detailRows, options?)` → `{status, front:{expiry,dte,ivTd},
     back:{...}, slope, zone}`; `status:'insufficient'` when the required
     expiries/IVs are missing.
   - `computeDisplacementWatermark(samples, options?)` → `{status, mean, count,
     latest}` from history samples (dedupe by quote date, pair-wise ratios,
     rolling window 26, min 8).
   - `buildStrategySuggestion(signal, watermark, options?)` → `{stance,
     structure, exitRule, reasons[]}` implementing the frozen playbook.
2. **Page** (`js/iv_term_structure.js`): render a "Strategy Signal" panel in
   the card body (zone badge + slope detail, watermark value or collecting
   state, suggestion + disclaimer). Pure display; recomputed on every render.
3. **CSS** (`iv_term_structure.css`): panel layout + three zone badge colors.
4. **Tests**: core — zone boundaries/insufficient data, watermark math
   (scaling, dedupe, window, min-n), suggestion mapping incl. watermark veto;
   page — panel markup renders the pieces.
5. Version bumps, full `node tests/run.js`, browser verification.

## Explicitly out of scope (later phases)

- Handing the suggestion off to index.html as a prebuilt combo group (reuse
  `calendar_handoff.js` mechanics; add a reverse-fly template) — after paper
  tracking proves out.
- Auto-refresh cadence / notifications; ES-specific EM conventions.
- Any order creation. The existing close-plan/one-time-token safety layer is
  the model: a human confirms every transition from suggestion to order.
