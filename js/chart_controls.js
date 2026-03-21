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
        // Seed with current values if empty
        if (!minInput.value) minInput.value = (state.underlyingPrice * 0.9).toFixed(0);
        if (!maxInput.value) maxInput.value = (state.underlyingPrice * 1.1).toFixed(0);
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
        minS = parseFloat(card.querySelector('.chart-min-input').value) || (state.underlyingPrice * 0.9);
        maxS = parseFloat(card.querySelector('.chart-max-input').value) || (state.underlyingPrice * 1.1);
        if (minS >= maxS) {
            maxS = minS + 1; // Prevent crash on bad inputs
        }
    } else {
        const pct = parseFloat(mode) / 100.0;
        minS = state.underlyingPrice * (1 - pct);
        maxS = state.underlyingPrice * (1 + pct);

        // Update display inputs just for visibility, without triggering redraw
        card.querySelector('.chart-min-input').value = minS.toFixed(0);
        card.querySelector('.chart-max-input').value = maxS.toFixed(0);
    }

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
        if (!minInput.value) minInput.value = (state.underlyingPrice * 0.9).toFixed(0);
        if (!maxInput.value) maxInput.value = (state.underlyingPrice * 1.1).toFixed(0);
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
        minS = parseFloat(card.querySelector('.amort-chart-min-input').value) || (state.underlyingPrice * 0.9);
        maxS = parseFloat(card.querySelector('.amort-chart-max-input').value) || (state.underlyingPrice * 1.1);
        if (minS >= maxS) {
            maxS = minS + 1;
        }
    } else {
        const pct = parseFloat(mode) / 100.0;
        minS = state.underlyingPrice * (1 - pct);
        maxS = state.underlyingPrice * (1 + pct);

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
        if (!minInput.value) minInput.value = (state.underlyingPrice * 0.9).toFixed(0);
        if (!maxInput.value) maxInput.value = (state.underlyingPrice * 1.1).toFixed(0);
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
        minS = parseFloat(card.querySelector('.global-chart-min-input').value) || (state.underlyingPrice * 0.9);
        maxS = parseFloat(card.querySelector('.global-chart-max-input').value) || (state.underlyingPrice * 1.1);
        if (minS >= maxS) {
            maxS = minS + 1; // Prevent crash on bad inputs
        }
    } else {
        const pct = parseFloat(mode) / 100.0;
        minS = state.underlyingPrice * (1 - pct);
        maxS = state.underlyingPrice * (1 + pct);

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
        if (!minInput.value) minInput.value = (state.underlyingPrice * 0.9).toFixed(0);
        if (!maxInput.value) maxInput.value = (state.underlyingPrice * 1.1).toFixed(0);
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
        minS = parseFloat(card.querySelector('.global-amort-chart-min-input').value) || (state.underlyingPrice * 0.9);
        maxS = parseFloat(card.querySelector('.global-amort-chart-max-input').value) || (state.underlyingPrice * 1.1);
        if (minS >= maxS) maxS = minS + 1;
    } else {
        const pct = parseFloat(mode) / 100.0;
        minS = state.underlyingPrice * (1 - pct);
        maxS = state.underlyingPrice * (1 + pct);

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

// Return the mean simulated IV across all legs in the portfolio
// Uses processLegData() to ensure IV calculation is in sync with bsm.js SSOT
function computePortfolioMeanSimIV() {
    const isOptionLeg = typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.isOptionLeg === 'function'
        ? OptionComboProductRegistry.isOptionLeg
        : (leg => ['call', 'put'].includes(String(leg && leg.type || '').toLowerCase()));

    const allLegs = state.groups
        .filter(_isGroupIncludedInGlobal)
        .flatMap(g =>
        g.legs
            .filter(leg => isOptionLeg(leg))
            .map(leg => processLegData(leg, state.simulatedDate, state.ivOffset))
    );
    if (allLegs.length === 0) return 0;
    if (allLegs.some(pLeg => !pLeg.isExpired && !Number.isFinite(pLeg.simIV))) {
        return null;
    }
    const total = allLegs.reduce((sum, pLeg) => sum + (Number.isFinite(pLeg.simIV) ? pLeg.simIV : 0), 0);
    return total / allLegs.length;
}

// Return { minS, maxS } using the same logic as the global P&L chart
function getGlobalChartRange() {
    const card = document.getElementById('globalChartCard');
    if (!card) {
        const pct = 0.10;
        return { minS: state.underlyingPrice * (1 - pct), maxS: state.underlyingPrice * (1 + pct) };
    }

    const modeBtn = card.querySelector('.global-range-mode-btn.active');
    const mode = modeBtn ? modeBtn.dataset.mode : '10';

    if (mode === 'custom') {
        let minS = parseFloat(card.querySelector('.global-chart-min-input').value) || (state.underlyingPrice * 0.9);
        let maxS = parseFloat(card.querySelector('.global-chart-max-input').value) || (state.underlyingPrice * 1.1);
        if (minS >= maxS) maxS = minS + 1;
        return { minS, maxS };
    } else {
        const pct = parseFloat(mode) / 100.0;
        return {
            minS: state.underlyingPrice * (1 - pct),
            maxS: state.underlyingPrice * (1 + pct)
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
