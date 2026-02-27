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
        legs: state.groups.flatMap(g => g.legs.map(leg => ({
            ...leg,
            _viewMode: g.viewMode || 'active'
        })))
    };

    card.chartInstance.draw(virtualGroup, state, minS, maxS);
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
    });

    const globalCard = document.getElementById('globalChartCard');
    const gcContainer = document.getElementById('globalChartContainer');
    if (globalCard && gcContainer && gcContainer.style.display !== 'none') {
        drawGlobalChart(globalCard);
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
    const allLegs = state.groups.flatMap(g =>
        g.legs.map(leg => processLegData(leg, state.simulatedDate, state.ivOffset))
    );
    if (allLegs.length === 0) return 0;
    const total = allLegs.reduce((sum, pLeg) => sum + pLeg.simIV, 0);
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
