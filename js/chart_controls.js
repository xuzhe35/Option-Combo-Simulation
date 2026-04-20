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

function _getChartAnchorPrice() {
    if (typeof OptionComboPricingContext !== 'undefined'
        && typeof OptionComboPricingContext.resolveAnchorUnderlyingPrice === 'function') {
        return OptionComboPricingContext.resolveAnchorUnderlyingPrice(state, state.underlyingPrice);
    }
    return state.underlyingPrice;
}

function _getChartAnchorDisplayInfo() {
    if (typeof OptionComboPricingContext !== 'undefined'
        && typeof OptionComboPricingContext.resolveAnchorDisplayInfo === 'function') {
        return OptionComboPricingContext.resolveAnchorDisplayInfo(state, state.underlyingPrice);
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
    card.chartInstance.draw(group, state, minS, maxS);
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
            _viewMode: g.viewMode || 'active'
        })))
    };

    _refreshChartAnchorNotes(card);
    card.chartInstance.draw(virtualGroup, state, minS, maxS);
}

function _getGlobalAmortizedVirtualGroup() {
    const amortizedGroups = state.groups.filter(g => _isGroupIncludedInGlobal(g) && (g.viewMode || 'active') === 'amortized');
    return {
        name: 'Global Amortized Portfolio',
        viewMode: 'amortized',
        legs: amortizedGroups.flatMap(g => g.legs.map(leg => ({
            ...leg,
            _viewMode: 'amortized'
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

// Return the mean IV used to scale probability distributions.
// Important: this must use each leg's usable quoted/manual IV (+ global offset),
// not the expiry-clipped simIV from processLegData(). On expiry-day scenarios
// simIV becomes 0 for pricing purposes, but probability analysis still needs a
// forward-looking volatility input from today's market.
function computePortfolioMeanSimIV() {
    const isOptionLeg = typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.isOptionLeg === 'function'
        ? OptionComboProductRegistry.isOptionLeg
        : (leg => ['call', 'put'].includes(String(leg && leg.type || '').toLowerCase()));
    const pricingContext = typeof OptionComboPricingContext === 'undefined'
        ? null
        : OptionComboPricingContext;
    const simulationDate = pricingContext && typeof pricingContext.resolveSimulationDate === 'function'
        ? pricingContext.resolveSimulationDate(state)
        : state.simulatedDate;
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

                    const processedLeg = processLegData(
                        leg,
                        simulationDate,
                        state.ivOffset,
                        quoteDate,
                        anchorPrice,
                        state.interestRate,
                        activeViewMode,
                        null,
                        state.marketDataMode
                    );

                    if (typeof hasUsableLegIv === 'function' && hasUsableLegIv(leg)) {
                        totalIv += Math.max(0.001, leg.iv + state.ivOffset);
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
