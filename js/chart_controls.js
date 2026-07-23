/**
 * Chart Controls & Probability Analysis Helpers
 * ===============================================
 * Extracted from app.js for maintainability.
 *
 * Depends on (global):
 *   - state                       (app.js)
 *   - PnLChart                    (chart.js)
 *   - processLegData              (bsm.js)
 *   - updateProbCharts,
 *     redrawProbChartsFromCache    (prob_charts.js)
 */

// -------------------------------------------------------------
// Group Chart Functions
// -------------------------------------------------------------

function _isGroupIncludedInGlobal(group) {
    return group.includedInGlobal !== false;
}

function _getPricingContextApi() {
    return typeof OptionComboPricingContext !== 'undefined' && OptionComboPricingContext
        ? OptionComboPricingContext
        : null;
}

function _getProductRegistryApi() {
    return typeof OptionComboProductRegistry !== 'undefined' && OptionComboProductRegistry
        ? OptionComboProductRegistry
        : null;
}

function _getChartAnchorPrice() {
    const pricingContext = _getPricingContextApi();
    if (pricingContext && typeof pricingContext.resolveAnchorUnderlyingPrice === 'function') {
        return pricingContext.resolveAnchorUnderlyingPrice(state, state.underlyingPrice);
    }
    return state.underlyingPrice;
}

function _getChartAnchorDisplayInfo() {
    const pricingContext = _getPricingContextApi();
    if (pricingContext && typeof pricingContext.resolveAnchorDisplayInfo === 'function') {
        return pricingContext.resolveAnchorDisplayInfo(state, state.underlyingPrice);
    }

    return {
        pricingMode: 'STK',
        isFutureAnchor: false,
        price: _getChartAnchorPrice(),
        title: 'Current Underlying',
        shortLabel: state.underlyingSymbol || 'Underlying',
        lineLabel: 'Current',
        displayText: `Current Underlying: ${state.underlyingSymbol || 'Underlying'} @ $${_getChartAnchorPrice().toFixed(2)}`,
        detailText: 'Percent labels are measured from the current underlying price.',
    };
}

function _renderAnchorNote(element, anchorInfo) {
    if (!element) return;

    if (!anchorInfo || anchorInfo.isFutureAnchor !== true) {
        element.textContent = '';
        element.style.display = 'none';
        return;
    }

    element.textContent = `${anchorInfo.displayText}. ${anchorInfo.detailText}`;
    element.style.display = 'block';
}

function _refreshChartAnchorNotes(card) {
    const anchorInfo = _getChartAnchorDisplayInfo();
    _renderAnchorNote(card && typeof card.querySelector === 'function'
        ? card.querySelector('.chart-anchor-note')
        : null, anchorInfo);
    _renderAnchorNote(
        typeof document !== 'undefined' && typeof document.querySelector === 'function'
            ? document.querySelector('.global-chart-anchor-note')
            : null,
        anchorInfo
    );
}

function _getPayoffChartState(card) {
    if (!card || card.bestEffortProjectionEnabled !== true) return state;

    // This shallow copy is deliberately local to PnLChart.draw().  Never
    // mutate the workspace convergence mode: valuation, probability, session,
    // and execution surfaces must keep their existing safety semantics.
    return {
        ...state,
        projectionConvergenceMode: 'best-effort-input-iv',
    };
}

function _formatBestEffortLegLabel(leg) {
    const type = String(leg && leg.type || 'option');
    const displayType = type.charAt(0).toUpperCase() + type.slice(1);
    const expiry = String(leg && leg.expDate || '').replace(/-/g, '/');
    return expiry ? `${displayType} ${expiry}` : displayType;
}

function _renderPayoffChartQuality(card) {
    if (!card || typeof card.querySelector !== 'function') return;
    const note = card.querySelector('.payoff-chart-quality-note');
    if (!note) return;

    const enabled = card.bestEffortProjectionEnabled === true;
    if (!enabled) {
        note.textContent = '';
        note.style.display = 'none';
        note.classList.remove('is-success', 'is-warning', 'is-error');
        return;
    }

    const chart = card.chartInstance;
    const quality = chart && chart.lastProjectionQuality;
    const fallbackLegs = quality && Array.isArray(quality.fallbackLegs)
        ? quality.fallbackLegs
        : [];
    note.classList.remove('is-success', 'is-warning', 'is-error');
    note.style.display = 'block';

    if (!chart || !chart.lastRenderData) {
        // A missing curve is not automatically an evidence failure: draw()
        // also bails for purely structural reasons (nothing included, or an
        // inverted price range). Claiming degraded evidence there would be a
        // warning shown when nothing is wrong, which only teaches users to
        // ignore the actionable version of this same message.
        const emptyReason = chart && chart.lastEmptyReason;
        if (emptyReason) {
            note.textContent = emptyReason === 'no-legs'
                ? 'Best-effort mode is on. No legs are included in this chart, so there is no curve to qualify yet.'
                : 'Best-effort mode is on. The price range is empty (min ≥ max), so there is no curve to qualify yet.';
            return;
        }
        note.classList.add('is-error');
        note.textContent = 'Best-effort could not complete the curve. At least one leg still lacks usable IV, timing / implied λ coverage, or its bound underlying quote.';
        return;
    }

    if (fallbackLegs.length === 0) {
        note.classList.add('is-success');
        note.textContent = 'Best-effort mode is on, but no IV fallback was needed for this curve.';
        return;
    }

    const labels = fallbackLegs.map(_formatBestEffortLegLabel).join(', ');
    const plural = fallbackLegs.length === 1 ? 'leg uses' : 'legs use';
    const pronoun = fallbackLegs.length === 1 ? 'its' : 'their';
    note.classList.add('is-warning');
    note.textContent = `Estimated curve: ${fallbackLegs.length} ${plural} ${pronoun} current input / TWS IV because strict local BBO inversion was unavailable (${labels}). This is not a strict-BBO valuation.`;
}

function toggleBestEffortPayoffChart(btn) {
    if (!btn) return;
    const card = typeof btn.closest === 'function'
        ? (btn.closest('.group-card') || btn.closest('.global-chart-card'))
        : null;
    if (!card) return;

    card.bestEffortProjectionEnabled = card.bestEffortProjectionEnabled !== true;
    btn.classList.toggle('active', card.bestEffortProjectionEnabled);
    btn.setAttribute('aria-pressed', card.bestEffortProjectionEnabled ? 'true' : 'false');
    btn.textContent = card.bestEffortProjectionEnabled
        ? 'Use Strict BBO'
        : 'Draw Best Effort';

    if (card.id === 'globalChartCard') {
        drawGlobalChart(card);
        return;
    }
    const groupId = card.dataset.groupId;
    const group = state.groups.find(g => g.id === groupId);
    drawGroupChart(card, group);
}

function toggleChart(btn) {
    const card = btn.closest('.group-card');
    const chartContainer = card.querySelector('.chart-container');
    if (chartContainer.style.display === 'none') {
        chartContainer.style.display = 'block';
        btn.textContent = 'Hide Chart';

        // Initialize ChartInstance if not exists
        if (!card.chartInstance) {
            const canvas = card.querySelector('.pnl-canvas');
            card.chartInstance = new PnLChart(canvas);
        }

        const groupId = card.dataset.groupId;
        const group = state.groups.find(g => g.id === groupId);
        drawGroupChart(card, group);
    } else {
        chartContainer.style.display = 'none';
        btn.textContent = 'Show Chart';
    }
}

function setChartRangeMode(btn, mode) {
    const card = btn.closest('.group-card');

    // Update active button state
    card.querySelectorAll('.range-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Update inputs state
    const customInputsContainer = card.querySelector('.custom-range-inputs');
    const minInput = card.querySelector('.chart-min-input');
    const maxInput = card.querySelector('.chart-max-input');

    if (mode === 'custom') {
        customInputsContainer.style.opacity = '1';
        minInput.disabled = false;
        maxInput.disabled = false;
        const anchorPrice = _getChartAnchorPrice();
        // Seed with current values if empty
        if (!minInput.value) minInput.value = (anchorPrice * 0.9).toFixed(0);
        if (!maxInput.value) maxInput.value = (anchorPrice * 1.1).toFixed(0);
    } else {
        customInputsContainer.style.opacity = '0.5';
        minInput.disabled = true;
        maxInput.disabled = true;
    }

    const groupId = card.dataset.groupId;
    const group = state.groups.find(g => g.id === groupId);
    // Redraw
    drawGroupChart(card, group);
}

function triggerChartRedraw(inputEl) {
    const card = inputEl.closest('.group-card');
    const groupId = card.dataset.groupId;
    const group = state.groups.find(g => g.id === groupId);
    drawGroupChart(card, group);
}

function drawGroupChart(card, group) {
    if (!card.chartInstance) return;

    const modeBtn = card.querySelector('.range-mode-btn.active');
    const mode = modeBtn ? modeBtn.dataset.mode : '10';

    let minS, maxS;

    if (mode === 'custom') {
        const anchorPrice = _getChartAnchorPrice();
        minS = parseFloat(card.querySelector('.chart-min-input').value) || (anchorPrice * 0.9);
        maxS = parseFloat(card.querySelector('.chart-max-input').value) || (anchorPrice * 1.1);
        if (minS >= maxS) {
            maxS = minS + 1; // Prevent crash on bad inputs
        }
    } else {
        const pct = parseFloat(mode) / 100.0;
        const anchorPrice = _getChartAnchorPrice();
        minS = anchorPrice * (1 - pct);
        maxS = anchorPrice * (1 + pct);

        // Update display inputs just for visibility, without triggering redraw
        card.querySelector('.chart-min-input').value = minS.toFixed(0);
        card.querySelector('.chart-max-input').value = maxS.toFixed(0);
    }

    _refreshChartAnchorNotes(card);
    card.chartInstance.draw(group, _getPayoffChartState(card), minS, maxS);
    _renderPayoffChartQuality(card);
}

// -------------------------------------------------------------
// Amortization Chart Functions (Amortized Mode Only)
// -------------------------------------------------------------

function toggleAmortizationChart(btn) {
    const card = btn.closest('.group-card');
    const chartContainer = card.querySelector('.amortization-chart-container');
    if (!chartContainer) return;

    if (chartContainer.style.display === 'none') {
        chartContainer.style.display = 'block';
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            Hide Amortized Simulation
        `;

        // Initialize AmortChartInstance if not exists
        if (!card.amortChartInstance) {
            const canvas = card.querySelector('.amortization-canvas');
            const marginCanvas = card.querySelector('.margin-canvas');
            if (typeof AmortizationChart !== 'undefined') {
                card.amortChartInstance = new AmortizationChart(canvas, marginCanvas);
            } else {
                console.error("AmortizationChart class not found! Make sure chart.js is updated.");
                return;
            }
        } else {
            // Hot swap check if DOM changed
            const marginCanvas = card.querySelector('.margin-canvas');
            card.amortChartInstance.marginCanvas = marginCanvas;
            if (marginCanvas) {
                card.amortChartInstance.marginCtx = marginCanvas.getContext('2d');
            }
        }

        const groupId = card.dataset.groupId;
        const group = state.groups.find(g => g.id === groupId);
        drawAmortizationChart(card, group);
    } else {
        chartContainer.style.display = 'none';
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
                <line x1="18" y1="20" x2="18" y2="10"></line>
                <line x1="12" y1="20" x2="12" y2="4"></line>
                <line x1="6" y1="20" x2="6" y2="14"></line>
            </svg>
            Simulate Amortized Price
        `;
    }
}

function setAmortChartRangeMode(btn, mode) {
    const card = btn.closest('.group-card');

    card.querySelectorAll('.amort-range-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const customInputsContainer = card.querySelector('.amort-custom-range-inputs');
    const minInput = card.querySelector('.amort-chart-min-input');
    const maxInput = card.querySelector('.amort-chart-max-input');

    if (mode === 'custom') {
        customInputsContainer.style.opacity = '1';
        minInput.disabled = false;
        maxInput.disabled = false;
        const anchorPrice = _getChartAnchorPrice();
        if (!minInput.value) minInput.value = (anchorPrice * 0.9).toFixed(0);
        if (!maxInput.value) maxInput.value = (anchorPrice * 1.1).toFixed(0);
    } else {
        customInputsContainer.style.opacity = '0.5';
        minInput.disabled = true;
        maxInput.disabled = true;
    }

    const groupId = card.dataset.groupId;
    const group = state.groups.find(g => g.id === groupId);
    drawAmortizationChart(card, group);
}

function triggerAmortChartRedraw(inputEl) {
    const card = inputEl.closest('.group-card');
    const groupId = card.dataset.groupId;
    const group = state.groups.find(g => g.id === groupId);
    drawAmortizationChart(card, group);
}

function drawAmortizationChart(card, group) {
    if (!card.amortChartInstance) return;

    const modeBtn = card.querySelector('.amort-range-mode-btn.active');
    const mode = modeBtn ? modeBtn.dataset.mode : '10';

    let minS, maxS;

    if (mode === 'custom') {
        const anchorPrice = _getChartAnchorPrice();
        minS = parseFloat(card.querySelector('.amort-chart-min-input').value) || (anchorPrice * 0.9);
        maxS = parseFloat(card.querySelector('.amort-chart-max-input').value) || (anchorPrice * 1.1);
        if (minS >= maxS) {
            maxS = minS + 1;
        }
    } else {
        const pct = parseFloat(mode) / 100.0;
        const anchorPrice = _getChartAnchorPrice();
        minS = anchorPrice * (1 - pct);
        maxS = anchorPrice * (1 + pct);

        card.querySelector('.amort-chart-min-input').value = minS.toFixed(0);
        card.querySelector('.amort-chart-max-input').value = maxS.toFixed(0);
    }

    card.amortChartInstance.draw(group, state, minS, maxS);
}

// -------------------------------------------------------------
// Global Chart Functions
// -------------------------------------------------------------

function toggleGlobalChart(btn) {
    const card = document.getElementById('globalChartCard');
    const chartContainer = document.getElementById('globalChartContainer');
    if (chartContainer.style.display === 'none') {
        chartContainer.style.display = 'block';
        btn.textContent = 'Hide Chart';

        // Initialize ChartInstance if not exists
        if (!card.chartInstance) {
            const canvas = card.querySelector('.global-pnl-canvas');
            card.chartInstance = new PnLChart(canvas);
        }

        drawGlobalChart(card);
    } else {
        chartContainer.style.display = 'none';
        btn.textContent = 'Show Chart';
    }
}

function setGlobalChartRangeMode(btn, mode) {
    const card = document.getElementById('globalChartCard');

    card.querySelectorAll('.global-range-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const customInputsContainer = card.querySelector('.global-custom-range-inputs');
    const minInput = card.querySelector('.global-chart-min-input');
    const maxInput = card.querySelector('.global-chart-max-input');

    if (mode === 'custom') {
        customInputsContainer.style.opacity = '1';
        minInput.disabled = false;
        maxInput.disabled = false;
        const anchorPrice = _getChartAnchorPrice();
        if (!minInput.value) minInput.value = (anchorPrice * 0.9).toFixed(0);
        if (!maxInput.value) maxInput.value = (anchorPrice * 1.1).toFixed(0);
    } else {
        customInputsContainer.style.opacity = '0.5';
        minInput.disabled = true;
        maxInput.disabled = true;
    }

    drawGlobalChart(card);
}

function triggerGlobalChartRedraw() {
    const card = document.getElementById('globalChartCard');
    drawGlobalChart(card);
}

function drawGlobalChart(card) {
    if (!card.chartInstance) return;

    const modeBtn = card.querySelector('.global-range-mode-btn.active');
    const mode = modeBtn ? modeBtn.dataset.mode : '10';

    let minS, maxS;

    if (mode === 'custom') {
        const anchorPrice = _getChartAnchorPrice();
        minS = parseFloat(card.querySelector('.global-chart-min-input').value) || (anchorPrice * 0.9);
        maxS = parseFloat(card.querySelector('.global-chart-max-input').value) || (anchorPrice * 1.1);
        if (minS >= maxS) {
            maxS = minS + 1; // Prevent crash on bad inputs
        }
    } else {
        const pct = parseFloat(mode) / 100.0;
        const anchorPrice = _getChartAnchorPrice();
        minS = anchorPrice * (1 - pct);
        maxS = anchorPrice * (1 + pct);

        card.querySelector('.global-chart-min-input').value = minS.toFixed(0);
        card.querySelector('.global-chart-max-input').value = maxS.toFixed(0);
    }

    // Combine all groups' legs into one virtual group, preserving per-group viewMode
    const virtualGroup = {
        name: 'Global Portfolio',
        legs: state.groups
            .filter(_isGroupIncludedInGlobal)
            .flatMap(g => g.legs.map(leg => ({
            ...leg,
            _viewMode: g.viewMode || 'active',
            _livePriceMode: g.livePriceMode || 'midpoint'
        })))
    };

    _refreshChartAnchorNotes(card);
    card.chartInstance.draw(virtualGroup, _getPayoffChartState(card), minS, maxS);
    _renderPayoffChartQuality(card);
}

function _getGlobalAmortizedVirtualGroup() {
    const amortizedGroups = state.groups.filter(g => _isGroupIncludedInGlobal(g) && (g.viewMode || 'active') === 'amortized');
    return {
        name: 'Global Amortized Portfolio',
        viewMode: 'amortized',
        legs: amortizedGroups.flatMap(g => g.legs.map(leg => ({
            ...leg,
            _viewMode: 'amortized',
            _livePriceMode: g.livePriceMode || 'midpoint'
        })))
    };
}

function toggleGlobalAmortizedChart(btn) {
    const card = document.getElementById('globalAmortizedCard');
    const chartContainer = document.getElementById('globalAmortizedChartContainer');
    if (!card || !chartContainer) return;

    if (chartContainer.style.display === 'none') {
        chartContainer.style.display = 'block';
        btn.textContent = 'Hide Chart';

        if (!card.amortChartInstance) {
            const canvas = card.querySelector('.global-amortization-canvas');
            const marginCanvas = card.querySelector('.global-amort-margin-canvas');
            card.amortChartInstance = new AmortizationChart(canvas, marginCanvas);
        }

        drawGlobalAmortizedChart(card);
    } else {
        chartContainer.style.display = 'none';
        btn.textContent = 'Show Chart';
    }
}

function setGlobalAmortizedChartRangeMode(btn, mode) {
    const card = document.getElementById('globalAmortizedCard');
    if (!card) return;

    card.querySelectorAll('.global-amort-range-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const customInputsContainer = card.querySelector('.global-amort-custom-range-inputs');
    const minInput = card.querySelector('.global-amort-chart-min-input');
    const maxInput = card.querySelector('.global-amort-chart-max-input');

    if (mode === 'custom') {
        customInputsContainer.style.opacity = '1';
        minInput.disabled = false;
        maxInput.disabled = false;
        const anchorPrice = _getChartAnchorPrice();
        if (!minInput.value) minInput.value = (anchorPrice * 0.9).toFixed(0);
        if (!maxInput.value) maxInput.value = (anchorPrice * 1.1).toFixed(0);
    } else {
        customInputsContainer.style.opacity = '0.5';
        minInput.disabled = true;
        maxInput.disabled = true;
    }

    drawGlobalAmortizedChart(card);
}

function triggerGlobalAmortizedChartRedraw() {
    const card = document.getElementById('globalAmortizedCard');
    if (!card) return;
    drawGlobalAmortizedChart(card);
}

function drawGlobalAmortizedChart(card) {
    if (!card || !card.amortChartInstance) return;

    const virtualGroup = _getGlobalAmortizedVirtualGroup();
    if (!virtualGroup.legs.length) return;

    const modeBtn = card.querySelector('.global-amort-range-mode-btn.active');
    const mode = modeBtn ? modeBtn.dataset.mode : '10';

    let minS, maxS;

    if (mode === 'custom') {
        const anchorPrice = _getChartAnchorPrice();
        minS = parseFloat(card.querySelector('.global-amort-chart-min-input').value) || (anchorPrice * 0.9);
        maxS = parseFloat(card.querySelector('.global-amort-chart-max-input').value) || (anchorPrice * 1.1);
        if (minS >= maxS) maxS = minS + 1;
    } else {
        const pct = parseFloat(mode) / 100.0;
        const anchorPrice = _getChartAnchorPrice();
        minS = anchorPrice * (1 - pct);
        maxS = anchorPrice * (1 + pct);

        card.querySelector('.global-amort-chart-min-input').value = minS.toFixed(0);
        card.querySelector('.global-amort-chart-max-input').value = maxS.toFixed(0);
    }

    card.amortChartInstance.draw(virtualGroup, state, minS, maxS);
}

// Global window resize listener to update all visible charts
window.addEventListener('resize', () => {
    document.querySelectorAll('.group-card').forEach(card => {
        const chartContainer = card.querySelector('.chart-container');
        if (chartContainer && chartContainer.style.display !== 'none') {
            const groupId = card.dataset.groupId;
            const group = state.groups.find(g => g.id === groupId);
            drawGroupChart(card, group);
        }

        const amortContainer = card.querySelector('.amortization-chart-container');
        if (amortContainer && amortContainer.style.display !== 'none') {
            const groupId = card.dataset.groupId;
            const group = state.groups.find(g => g.id === groupId);
            drawAmortizationChart(card, group);
        }
    });

    const globalCard = document.getElementById('globalChartCard');
    const gcContainer = document.getElementById('globalChartContainer');
    if (globalCard && gcContainer && gcContainer.style.display !== 'none') {
        drawGlobalChart(globalCard);
    }

    const globalAmortizedCard = document.getElementById('globalAmortizedCard');
    const gacContainer = document.getElementById('globalAmortizedChartContainer');
    if (globalAmortizedCard && gacContainer && gacContainer.style.display !== 'none') {
        drawGlobalAmortizedChart(globalAmortizedCard);
    }

    // Redraw prob charts from cached data (no re-simulation needed)
    if (typeof redrawProbChartsFromCache === 'function') {
        redrawProbChartsFromCache();
    }
});

// -------------------------------------------------------------
// Probability Analysis Helpers (called from prob_charts.js)
// -------------------------------------------------------------

// Return the mean IV used to scale probability distributions. Each leg is
// processed at the quote anchor (not the future simulation date), so a near leg
// that expires on the target date still contributes its current IV. The result
// is the leg's weighted-clock IV, preserving anchor total variance while making
// the terminal MC distribution use the same scalar/by-date lambda clock as the
// option repricing path.
function computePortfolioMeanSimIV() {
    const productRegistry = _getProductRegistryApi();
    const underlyingProfile = productRegistry
        && typeof productRegistry.resolveUnderlyingProfile === 'function'
        ? productRegistry.resolveUnderlyingProfile(state.underlyingSymbol)
        : null;
    const isOptionLeg = productRegistry
        && typeof productRegistry.isOptionLeg === 'function'
        ? productRegistry.isOptionLeg
        : (leg => ['call', 'put'].includes(String(leg && leg.type || '').toLowerCase()));
    const pricingContext = _getPricingContextApi();
    const quoteDate = pricingContext && typeof pricingContext.resolveQuoteDate === 'function'
        ? pricingContext.resolveQuoteDate(state)
        : state.baseDate;

    const anchorPrice = _getChartAnchorPrice();
    let sawAnyOptionLeg = false;
    let sawMissingIvOnActiveLeg = false;
    let totalIv = 0;
    let ivCount = 0;

    state.groups
        .filter(_isGroupIncludedInGlobal)
        .forEach(group => {
            const activeViewMode = group.viewMode || 'active';
            group.legs
                .filter(leg => isOptionLeg(leg))
                .forEach(leg => {
                    sawAnyOptionLeg = true;

                    const legCurrentUnderlying = pricingContext
                        && typeof pricingContext.resolveLegCurrentUnderlyingPrice === 'function'
                        ? pricingContext.resolveLegCurrentUnderlyingPrice(state, leg, anchorPrice)
                        : anchorPrice;
                    const legInterestRate = pricingContext
                        && typeof pricingContext.resolveLegInterestRate === 'function'
                        ? pricingContext.resolveLegInterestRate(state, leg, state.interestRate)
                        : state.interestRate;
                    const observable = pricingContext
                        && typeof pricingContext.resolveObservableLegPrice === 'function'
                        ? pricingContext.resolveObservableLegPrice(state, group, leg)
                        : null;
                    const quotePricingInputs = pricingContext
                        && typeof pricingContext.resolveLegQuotePricingInputs === 'function'
                        ? pricingContext.resolveLegQuotePricingInputs(state, leg, {
                            underlyingPrice: anchorPrice,
                            interestRate: state.interestRate,
                        })
                        : null;

                    const processedLeg = processLegData(
                        leg,
                        quoteDate,
                        state.ivOffset,
                        quoteDate,
                        legCurrentUnderlying,
                        legInterestRate,
                        activeViewMode,
                        underlyingProfile,
                        state.marketDataMode,
                        {
                            quoteAsOf: state.liveQuoteAsOf,
                            allowLegacyQuoteCutoff: !state.marketDataMode,
                            targetAsOf: state.liveQuoteAsOf,
                            targetSource: 'quote-anchor',
                            observablePrice: observable && observable.available
                                ? observable.price
                                : null,
                            observablePriceSource: observable && observable.source || null,
                            observablePriceAsOf: observable && observable.quoteAsOf || null,
                            observablePriceFresh: observable && observable.fresh === true,
                            quotePricingInputsAvailable: quotePricingInputs
                                && quotePricingInputs.available === true,
                            quotePricingInputStatus: quotePricingInputs
                                && quotePricingInputs.status || null,
                            quoteUnderlyingPrice: quotePricingInputs
                                && quotePricingInputs.underlyingPrice,
                            quoteUnderlyingAsOf: quotePricingInputs
                                && quotePricingInputs.underlyingAsOf,
                            quoteInterestRate: quotePricingInputs
                                && quotePricingInputs.interestRate,
                        }
                    );

                    if (!processedLeg.isExpired
                        && Number.isFinite(processedLeg.simIV)
                        && processedLeg.simIV > 0) {
                        totalIv += processedLeg.simIV;
                        ivCount += 1;
                        return;
                    }

                    // Preserve the old guard for genuinely active options that
                    // still have no usable IV source.
                    if (!processedLeg.isExpired) {
                        sawMissingIvOnActiveLeg = true;
                    }
                });
        });

    if (!sawAnyOptionLeg) return 0;
    if (sawMissingIvOnActiveLeg) return null;
    return ivCount > 0 ? (totalIv / ivCount) : 0;
}

// Return { minS, maxS } using the same logic as the global P&L chart
function getGlobalChartRange() {
    const card = document.getElementById('globalChartCard');
    if (!card) {
        const pct = 0.10;
        const anchorPrice = _getChartAnchorPrice();
        return { minS: anchorPrice * (1 - pct), maxS: anchorPrice * (1 + pct) };
    }

    const modeBtn = card.querySelector('.global-range-mode-btn.active');
    const mode = modeBtn ? modeBtn.dataset.mode : '10';

    if (mode === 'custom') {
        const anchorPrice = _getChartAnchorPrice();
        let minS = parseFloat(card.querySelector('.global-chart-min-input').value) || (anchorPrice * 0.9);
        let maxS = parseFloat(card.querySelector('.global-chart-max-input').value) || (anchorPrice * 1.1);
        if (minS >= maxS) maxS = minS + 1;
        return { minS, maxS };
    } else {
        const pct = parseFloat(mode) / 100.0;
        const anchorPrice = _getChartAnchorPrice();
        return {
            minS: anchorPrice * (1 - pct),
            maxS: anchorPrice * (1 + pct)
        };
    }
}

// Toggle probability analysis panel
function toggleProbCharts(btn) {
    const container = document.getElementById('probAnalysisContainer');
    if (!container) return;
    if (container.style.display === 'none') {
        container.style.display = 'block';
        btn.textContent = 'Hide Analysis';
        if (typeof updateProbCharts === 'function') updateProbCharts();
    } else {
        container.style.display = 'none';
        btn.textContent = 'Show Analysis';
    }
}

function refreshChartAnchorAnnotations() {
    if (typeof document === 'undefined') return;

    if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('.group-card').forEach(card => {
            _refreshChartAnchorNotes(card);
        });
    }
    _refreshChartAnchorNotes(typeof document.getElementById === 'function'
        ? document.getElementById('globalChartCard')
        : null);
}

window.refreshChartAnchorAnnotations = refreshChartAnchorAnnotations;
