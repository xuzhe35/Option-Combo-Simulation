# Option Combo Simulator - Current Technical Debt and Risks

**Updated:** 2026-03-14

This document describes risks that still exist in the current implementation. Old items that were already fixed have been removed.

## 1. Global-Scope Frontend Coupling

### Risk

The frontend still depends on ordered global script loading instead of modules.

Examples of globally shared dependencies:

- `state`
- `processLegData`
- `computeSimulatedPrice`
- `PnLChart`
- `T_DIST_PARAMS_DB`

### Impact

- load order bugs are easy to introduce
- file boundaries are weaker than they appear
- refactors have a high chance of silent runtime failures instead of compile-time errors

### Recommendation

Move the frontend toward ES modules with a single entry point. The first step should be converting utility and pricing files before tackling DOM-heavy code.

## 2. Large Recalculation Loop on the Main Thread

### Risk

`updateDerivedValues()` still performs a broad synchronous pass over all groups, all legs, and all visible charts.

Even though sliders are throttled with `requestAnimationFrame`, the app still does substantial work on the main thread:

- leg normalization
- simulated valuation
- DOM updates
- visible chart redraws

### Impact

Large portfolios or many simultaneously visible charts can cause frame drops during interaction.

### Recommendation

Separate pure portfolio valuation from DOM writes, cache more intermediate leg data, and consider pushing chart input generation off the main thread for large portfolios.

## 3. Probability Repricing Is Split Across Worker and Main Thread

### Risk

The Monte Carlo worker computes terminal price density and exact expected P&L, but the main thread still recomputes the portfolio P&L curve at each bin center for rendering Chart 3.

### Impact

- the expensive part is reduced, but not fully isolated
- large portfolios still pay a noticeable main-thread cost after every probability run
- pricing logic now exists in two execution environments that must remain behaviorally aligned

### Recommendation

Consider moving the per-bin P&L curve calculation into the worker as well, or centralize a serializable portfolio-pricing payload shared by both worker and main thread.

## 4. Hardcoded Browser WebSocket Endpoint

### Risk

`ws_client.js` is hardcoded to `ws://localhost:8765`.

### Impact

- the browser client does not honor `config.ini`
- non-default deployments require source edits
- remote or LAN usage is harder than it should be

### Recommendation

Expose the WebSocket URL in the UI, load it from a lightweight config file, or inject it through the page before the client boots.

## 5. Inline Template and Style Complexity in `index.html`

### Risk

A large amount of UI structure and some mode-specific styling live directly inside `index.html` templates.

### Impact

- behavior and presentation are harder to separate
- template updates can accidentally break event assumptions in `app.js`
- settlement-mode UX is more fragile than it looks because DOM structure is tightly coupled to selectors

### Recommendation

Move embedded style blocks and repeated inline styling into `style.css`, and keep DOM structures used by JS selectors as stable, documented contracts.

## 6. Import Behavior Is Append-Only

### Risk

JSON import appends groups and hedges into the current in-memory session instead of replacing it.

### Impact

- users can accidentally merge portfolios when they expected to open one file cleanly
- debugging imported states becomes harder because the result depends on what was already loaded

### Recommendation

Offer two explicit actions:

- `Import and Merge`
- `Open and Replace`

## 7. Pricing-Model Edge Behavior Near Expiry

### Risk

Trial mode can jump between theoretical pricing and live current price when evaluating "right now" with zero IV offset.

### Impact

Near expiry, especially for thinly traded contracts, users may see a visible discontinuity between nearby simulated dates and the exact base-date view.

### Recommendation

If this becomes a UX problem, blend from theoretical pricing toward live mark over a configurable near-expiry window instead of switching immediately at the current-date condition.

## 8. Limited Validation Around User-Entered Market Data

### Risk

Many numeric fields accept direct manual edits and rely on light parsing only.

### Impact

- malformed values can degrade the experience without strong guardrails
- negative or unrealistic inputs may be accepted farther than ideal before downstream logic clamps them

### Recommendation

Add a thin validation layer around user-editable prices, IVs, positions, and settlement inputs, with inline feedback instead of silent coercion where practical.

## 9. No Automated Regression Safety Net

### Risk

The project currently relies on manual verification.

### Impact

Pricing, charting, import migration, and live-data behaviors can regress without detection.

### Recommendation

Start with a compact automated safety net:

1. unit tests for `bsm.js` date and pricing helpers
2. import-migration tests for saved JSON shapes
3. a few deterministic portfolio snapshot tests for aggregate valuation
