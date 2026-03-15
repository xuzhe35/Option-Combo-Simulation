# Option Combo Simulator - Current Technical Debt and Risks

**Updated:** 2026-03-15

This document lists risks that still matter in the current implementation.

## 1. Global-Scope Frontend Coupling

### Risk

The frontend still depends on ordered global script loading rather than modules.

### Impact

- load order bugs are easy to introduce
- file boundaries are weaker than they look
- refactors can fail at runtime instead of at build time

### Recommendation

Move gradually toward ES modules, starting with utility and pricing files.

## 2. Large Recalculation Loop on the Main Thread

### Risk

`updateDerivedValues()` still performs a broad synchronous pass over groups, legs, DOM, and visible charts.

### Impact

Large portfolios or many visible charts can still cause frame drops during interaction.

### Recommendation

Separate pure valuation from DOM writes and cache more intermediate state.

## 3. Probability Repricing Is Still Split Across Worker and Main Thread

### Risk

The Monte Carlo worker computes density and exact expected P&L, but the main thread still recomputes portfolio P&L over chart bins for rendering.

### Impact

- large portfolios still pay a noticeable main-thread cost after probability runs
- pricing behavior must stay aligned across two execution contexts

### Recommendation

Move more of the chart-input pricing into the worker, or centralize a serializable pricing payload.

## 4. Localhost-Coupled WebSocket Configuration

### Risk

The browser client now supports a local port override, but it is still intentionally tied to `localhost` and does not share one config source with `ib_server.py`.

### Impact

- the browser-stored port and `config.ini` can still drift apart
- this is acceptable for single-user local use, but it is not a unified configuration model

### Recommendation

Current implementation is good enough for local use. If the app ever expands beyond that, move frontend and backend to one shared config source.

## 5. Inline Template and Style Complexity

### Risk

A large amount of UI structure and some mode-specific styling still live directly in `index.html`.

### Impact

- behavior and presentation are tightly coupled
- selector-driven UI logic is more fragile than it appears

### Recommendation

Move more embedded styling into `style.css` and keep DOM structures used by JS selectors stable.

## 6. Import Behavior Is Append-Only

### Risk

JSON import appends groups and hedges into the current session rather than replacing it.

### Impact

- users can merge states unintentionally
- imported results depend on whatever was already loaded

### Recommendation

If this becomes confusing, add explicit `Import and Merge` vs `Open and Replace` actions.

## 7. Pricing-Model Edge Behavior Near Expiry

### Risk

Trial mode can still jump between theoretical pricing and live current price when evaluating the current date with zero IV offset.

### Impact

Near expiry, thinly traded contracts can still show a visible discontinuity.

### Recommendation

Blend from theoretical pricing toward live mark over a near-expiry window if this becomes a UX problem.

## 8. Limited Validation Around User Inputs

### Risk

Many numeric inputs still rely on light parsing only.

### Impact

- malformed values can degrade the experience
- unrealistic values may travel farther than ideal before being corrected

### Recommendation

Add a thin validation layer with inline feedback for prices, IVs, positions, and scenario inputs.

## 9. No Automated Regression Safety Net

### Risk

The project still relies mainly on manual verification.

### Impact

Pricing, import migration, chart behavior, and mode behavior can regress silently.

### Recommendation

Start with:

1. unit tests for `bsm.js` helpers
2. import-migration tests for saved JSON shapes
3. deterministic valuation snapshot tests for representative portfolios

## 10. Global Amortized Semantics Are Intentionally Split

### Risk

The global amortized banner and global amortized chart do not use identical scenario semantics.

### Impact

- the banner uses each amortized group's own scenario override
- the chart uses a shared global scenario-price axis
- future maintainers can mistake this for a bug if the distinction is not remembered

### Recommendation

Keep this documented clearly. If users later want strict one-to-one semantics, choose one interpretation and align both outputs to it.
