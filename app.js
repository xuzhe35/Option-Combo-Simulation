/**
 * Main Application Logic for Option Combo Simulator
 */

// Formatters
const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
});

const percentFormatter = new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
});

// App State
const today = new Date();
const initialDateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

const state = {
    underlyingSymbol: 'SPY',
    underlyingPrice: 100.00,
    baseDate: initialDateStr, // Today local YYYY-MM-DD
    simulatedDate: initialDateStr, // Initially same as baseDate
    interestRate: 0.03, // 3%
    ivOffset: 0.0, // 0%
    groups: []
};

// Date helper functions such as diffDays, addDays, calendarToTradingDays 
// have been unified globally in bsm.js

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    bindControlPanelEvents();
    renderGroups();
    updateDerivedValues();
});

// Calculate unique ID
function generateId() {
    return '_' + Math.random().toString(36).substr(2, 9);
}

// -------------------------------------------------------------
// DOM Event Binding
// -------------------------------------------------------------
function bindControlPanelEvents() {
    // Underlying Symbol
    const symInput = document.getElementById('underlyingSymbol');
    symInput.addEventListener('change', (e) => {
        state.underlyingSymbol = e.target.value.toUpperCase();
        symInput.value = state.underlyingSymbol;
        // Broadcast change if WS is connected...
        handleLiveSubscriptions();
    });

    // Underlying Price
    const upInput = document.getElementById('underlyingPrice');
    const upSlider = document.getElementById('underlyingPriceSlider');
    const upDisplay = document.getElementById('underlyingPriceDisplay');

    const updateUp = (val) => {
        state.underlyingPrice = parseFloat(val);
        upInput.value = state.underlyingPrice;
        upSlider.value = state.underlyingPrice;
        upDisplay.textContent = currencyFormatter.format(state.underlyingPrice);
        updateDerivedValues();
    };
    upInput.addEventListener('input', (e) => updateUp(e.target.value));
    upSlider.addEventListener('input', (e) => updateUp(e.target.value));

    // Expose a method to quickly adjust the price (e.g. +/- 1%)
    window.adjustUnderlying = (percentChange) => {
        const newValue = state.underlyingPrice * (1 + percentChange);
        updateUp(newValue);
    };

    // Simulated Date & Days Passed Slider
    const simDateInput = document.getElementById('simulatedDate');
    const dpSlider = document.getElementById('daysPassedSlider');
    const dpDisplay = document.getElementById('daysPassedDisplay');

    // Initialize inputs
    simDateInput.value = state.simulatedDate;
    simDateInput.min = state.baseDate;

    const updateSimDate = (newDateStr) => {
        if (new Date(newDateStr) < new Date(state.baseDate)) {
            newDateStr = state.baseDate;
            simDateInput.value = state.baseDate;
        }
        state.simulatedDate = newDateStr;
        const days = diffDays(state.baseDate, state.simulatedDate);
        const tradDays = calendarToTradingDays(state.baseDate, state.simulatedDate);
        dpSlider.value = days;
        dpDisplay.textContent = `+${tradDays} td / +${days} cd`;
        updateDerivedValues();
    };

    const updateDaysSlider = (days) => {
        const dNum = parseInt(days, 10);
        const newDateStr = addDays(state.baseDate, dNum);
        state.simulatedDate = newDateStr;
        simDateInput.value = state.simulatedDate;
        const tradDays = calendarToTradingDays(state.baseDate, state.simulatedDate);
        dpDisplay.textContent = `+${tradDays} td / +${dNum} cd`;
        updateDerivedValues();
    };

    simDateInput.addEventListener('change', (e) => updateSimDate(e.target.value));
    dpSlider.addEventListener('input', (e) => updateDaysSlider(e.target.value));

    // Interest Rate
    const irInput = document.getElementById('interestRate');
    const irDisplay = document.getElementById('interestRateDisplay');

    const updateIr = (val) => {
        const pct = parseFloat(val);
        state.interestRate = pct / 100.0;
        irDisplay.textContent = `${pct.toFixed(2)}%`;
        updateDerivedValues();
    };
    irInput.addEventListener('input', (e) => updateIr(e.target.value));

    // IV Offset
    const ivInput = document.getElementById('ivOffset');
    const ivSlider = document.getElementById('ivOffsetSlider');
    const ivDisplay = document.getElementById('ivOffsetDisplay');

    const updateIv = (val) => {
        const pct = parseFloat(val);
        state.ivOffset = pct / 100.0;
        ivInput.value = pct;
        ivSlider.value = pct;
        const sign = pct > 0 ? '+' : '';
        ivDisplay.textContent = `${sign}${pct.toFixed(2)}%`;
        updateDerivedValues();
    };
    ivInput.addEventListener('input', (e) => updateIv(e.target.value));
    ivSlider.addEventListener('input', (e) => updateIv(e.target.value));
}

// -------------------------------------------------------------
// Group & Leg Management & Rendering
// -------------------------------------------------------------

// getMultiplier() has been unified globally in bsm.js

function addGroup() {
    const newGroup = {
        id: generateId(),
        name: `Combo Group ${state.groups.length + 1}`,
        legs: []
    };
    state.groups.push(newGroup);
    // Auto-add one leg to start
    addLegToGroupById(newGroup.id);
    renderGroups();
}

function removeGroup(groupId) {
    state.groups = state.groups.filter(g => g.id !== groupId);
    handleLiveSubscriptions();
    renderGroups();
}

function addLegToGroupById(groupId) {
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return;

    const newLeg = {
        id: generateId(),
        type: 'call',
        pos: 1,
        strike: state.underlyingPrice,
        expDate: addDays(state.baseDate, 30), // Default to 30 days out
        iv: 0.2,
        cost: 0.00
    };
    group.legs.push(newLeg);
    renderGroups();
}

function addLegToGroup(buttonEl) {
    const card = buttonEl.closest('.group-card');
    if (card) {
        addLegToGroupById(card.dataset.groupId);
    }
}

function removeLeg(groupId, legId) {
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return;
    group.legs = group.legs.filter(l => l.id !== legId);
    handleLiveSubscriptions();
    renderGroups();
}

function renderGroups() {
    const container = document.getElementById('groupsContainer');
    const globalEmptyState = document.getElementById('globalEmptyState');
    const groupTemplate = document.getElementById('groupCardTemplate');
    const legTemplate = document.getElementById('legRowTemplate');

    container.innerHTML = '';

    if (state.groups.length === 0) {
        globalEmptyState.style.display = 'block';
        document.getElementById('globalChartCard').style.display = 'none';
        document.getElementById('probAnalysisCard').style.display = 'none';
        updateDerivedValues();
        return;
    }

    globalEmptyState.style.display = 'none';
    document.getElementById('globalChartCard').style.display = 'block';
    document.getElementById('probAnalysisCard').style.display = 'block';

    state.groups.forEach(group => {
        const clone = groupTemplate.content.cloneNode(true);
        const card = clone.querySelector('.group-card');
        card.dataset.groupId = group.id;

        // Group Name Binding
        const nameInput = card.querySelector('.group-name-input');
        nameInput.value = group.name;
        nameInput.addEventListener('change', (e) => { group.name = e.target.value; });

        // Live Data Toggle
        const liveToggle = card.querySelector('.live-data-toggle');
        const statusSpan = liveToggle.parentElement.previousElementSibling;
        liveToggle.checked = !!group.liveData;
        statusSpan.textContent = group.liveData ? '🟢 Live' : '🔴 Offline';

        liveToggle.addEventListener('change', (e) => {
            group.liveData = e.target.checked;
            statusSpan.textContent = group.liveData ? '🟢 Live' : '🔴 Offline';
            handleLiveSubscriptions();
        });

        // Remove Group Binding
        card.querySelector('.remove-group-btn').addEventListener('click', () => removeGroup(group.id));

        // Render Legs
        const tbody = card.querySelector('.legsTableBody');
        const table = card.querySelector('table');
        const emptyState = card.querySelector('.group-empty-state');

        if (group.legs.length === 0) {
            table.style.display = 'none';
            emptyState.style.display = 'block';
        } else {
            table.style.display = 'table';
            emptyState.style.display = 'none';

            group.legs.forEach(leg => {
                const legClone = legTemplate.content.cloneNode(true);
                const tr = legClone.querySelector('tr');
                tr.dataset.id = leg.id;

                // Populate values
                const typeInput = tr.querySelector('.type-input');
                typeInput.value = leg.type;
                typeInput.addEventListener('change', (e) => { leg.type = e.target.value; updateDerivedValues(); });

                const posInput = tr.querySelector('.pos-input');
                posInput.value = leg.pos;
                posInput.addEventListener('input', (e) => { leg.pos = parseInt(e.target.value) || 0; updateDerivedValues(); });

                const strikeInput = tr.querySelector('.strike-input');
                strikeInput.value = leg.strike;
                strikeInput.addEventListener('input', (e) => { leg.strike = parseFloat(e.target.value) || 0; updateDerivedValues(); });

                const dteInput = tr.querySelector('.dte-input');
                dteInput.value = leg.expDate;
                dteInput.addEventListener('change', (e) => {
                    leg.expDate = e.target.value;
                    updateDerivedValues();
                });

                const ivInput = tr.querySelector('.iv-input');
                ivInput.value = (leg.iv * 100).toFixed(2);
                ivInput.addEventListener('input', (e) => { leg.iv = parseFloat(e.target.value) / 100.0 || 0.001; updateDerivedValues(); });

                const costInput = tr.querySelector('.cost-input');
                costInput.value = leg.cost.toFixed(2);
                costInput.addEventListener('input', (e) => { leg.cost = parseFloat(e.target.value) || 0; updateDerivedValues(); });

                // Delete button
                tr.querySelector('.delete-btn').addEventListener('click', () => removeLeg(group.id, leg.id));

                tbody.appendChild(tr);
            });
        }

        container.appendChild(card);
    });

    updateDerivedValues();
}

// -------------------------------------------------------------
// Core Calculations
// -------------------------------------------------------------

function updateDerivedValues() {
    let globalTotalCost = 0;
    let globalSimulatedValue = 0;

    const cards = document.querySelectorAll('.group-card');

    cards.forEach(card => {
        const groupId = card.dataset.groupId;
        const group = state.groups.find(g => g.id === groupId);
        if (!group) return;

        let groupCost = 0;
        let groupSimValue = 0;

        const rows = card.querySelectorAll('.leg-row');
        rows.forEach(tr => {
            const legId = tr.dataset.id;
            const leg = group.legs.find(l => l.id === legId);
            if (!leg) return;

            // Process leg globally to ensure perfectly synced DTE and IV
            const pLeg = processLegData(leg, state.simulatedDate, state.ivOffset);

            // Update displays for simulated variables
            tr.querySelector('.simulated-dte-display').textContent = `Sim DTE: ${pLeg.tradDTE} td / ${pLeg.calDTE} cd`;
            tr.querySelector('.simulated-iv-display').textContent = `Sim IV: ${(pLeg.simIV * 100).toFixed(2)}%`;

            // Calculate Pricing
            groupCost += pLeg.costBasis;

            const simPricePerShare = computeLegPrice(pLeg, state.underlyingPrice, state.interestRate);
            const simValue = pLeg.posMultiplier * simPricePerShare;

            groupSimValue += simValue;

            const pnl = simValue - pLeg.costBasis;

            tr.querySelector('.simulated-price-cell').textContent = currencyFormatter.format(simPricePerShare);
            const pnlCell = tr.querySelector('.pnl-cell');
            pnlCell.innerHTML = `<span class="${pnl >= 0 ? 'profit' : 'loss'}">${pnl >= 0 ? '+' : ''}${currencyFormatter.format(pnl)}</span>`;
        });

        // Update Group Summary DOM
        const groupPnl = groupSimValue - groupCost;
        card.querySelector('.group-cost').textContent = currencyFormatter.format(groupCost);
        card.querySelector('.group-sim-value').textContent = currencyFormatter.format(groupSimValue);
        card.querySelector('.group-pnl').innerHTML = `<span class="${groupPnl >= 0 ? 'success-text' : 'danger-text'}">${groupPnl >= 0 ? '+' : ''}${currencyFormatter.format(groupPnl)}</span>`;

        // Update Chart if visible
        const chartContainer = card.querySelector('.chart-container');
        if (chartContainer && chartContainer.style.display !== 'none') {
            drawGroupChart(card, group);
        }

        globalTotalCost += groupCost;
        globalSimulatedValue += groupSimValue;
    });

    // Update Global Summary Card
    const globalPnL = globalSimulatedValue - globalTotalCost;

    document.getElementById('totalCost').textContent = currencyFormatter.format(globalTotalCost);
    document.getElementById('simulatedValue').textContent = currencyFormatter.format(globalSimulatedValue);

    const unPnlEl = document.getElementById('unrealizedPnL');
    unPnlEl.innerHTML = `<span class="${globalPnL >= 0 ? 'profit' : 'loss'}">${globalPnL >= 0 ? '+' : ''}${currencyFormatter.format(globalPnL)}</span>`;

    // Update Global Chart
    const globalCard = document.getElementById('globalChartCard');
    const gcContainer = document.getElementById('globalChartContainer');
    if (globalCard && gcContainer && gcContainer.style.display !== 'none') {
        if (typeof drawGlobalChart === 'function') {
            drawGlobalChart(globalCard);
        }
    }
}

// -------------------------------------------------------------
// Chart Logic
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

// Global Chart Functions
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

    // Combine all groups' legs into one virtual group
    const virtualGroup = {
        name: 'Global Portfolio',
        legs: state.groups.flatMap(g => g.legs)
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
function computePortfolioMeanSimIV() {
    const allLegs = state.groups.flatMap(g => g.legs);
    if (allLegs.length === 0) return 0;
    const total = allLegs.reduce((sum, leg) => sum + Math.max(0.001, leg.iv + state.ivOffset), 0);
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

// -------------------------------------------------------------
// Import / Export JSON
// -------------------------------------------------------------

function exportToJSON() {
    const dataStr = JSON.stringify(state, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `option_combo_sim_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importFromJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const importedState = JSON.parse(e.target.result);

            // Validate basic structure
            if (importedState && typeof importedState === 'object') {
                state.underlyingSymbol = importedState.underlyingSymbol || 'SPY';
                state.underlyingPrice = importedState.underlyingPrice || 100;
                // Handle version migrations for dates
                state.baseDate = importedState.baseDate || initialDateStr;
                if (importedState.simulatedDate) {
                    state.simulatedDate = importedState.simulatedDate;
                } else if (importedState.daysPassed !== undefined) {
                    // Legacy migration
                    state.simulatedDate = addDays(state.baseDate, importedState.daysPassed);
                } else {
                    state.simulatedDate = state.baseDate;
                }

                state.interestRate = importedState.interestRate !== undefined ? importedState.interestRate : 0.03;
                state.ivOffset = importedState.ivOffset || 0;
                let importedGroups = [];

                // Helper to migrate legacy legs to use expDate
                const migrateLegs = (legsArr) => {
                    return legsArr.map(leg => {
                        const newLeg = { ...leg, id: generateId() };
                        if (newLeg.dte !== undefined && newLeg.expDate === undefined) {
                            newLeg.expDate = addDays(state.baseDate, newLeg.dte);
                            delete newLeg.dte;
                        }
                        return newLeg;
                    });
                };

                // Handle legacy v1 imports (single array of legs)
                if (importedState.legs && Array.isArray(importedState.legs) && (!importedState.groups || importedState.groups.length === 0)) {
                    importedGroups = [{
                        id: generateId(),
                        name: 'Legacy Combo',
                        legs: migrateLegs(importedState.legs)
                    }];
                } else {
                    const parsedGroups = Array.isArray(importedState.groups) ? importedState.groups : [];
                    importedGroups = parsedGroups.map(g => ({
                        ...g,
                        id: generateId(),
                        legs: migrateLegs(Array.isArray(g.legs) ? g.legs : [])
                    }));
                }

                // Append instead of overwrite
                state.groups.push(...importedGroups);

                // Synchronize global controls DOM
                document.getElementById('underlyingSymbol').value = state.underlyingSymbol;
                document.getElementById('underlyingPrice').value = state.underlyingPrice;
                document.getElementById('underlyingPriceSlider').value = state.underlyingPrice;
                document.getElementById('underlyingPriceDisplay').textContent = currencyFormatter.format(state.underlyingPrice);

                const simDateInput = document.getElementById('simulatedDate');
                simDateInput.min = state.baseDate;
                simDateInput.value = state.simulatedDate;

                const days = diffDays(state.baseDate, state.simulatedDate);
                const tradDays = calendarToTradingDays(days);
                document.getElementById('daysPassedSlider').value = days;
                document.getElementById('daysPassedDisplay').textContent = `+${tradDays} td / +${days} cd`;

                document.getElementById('interestRate').value = (state.interestRate * 100).toFixed(2);
                document.getElementById('interestRateDisplay').textContent = `${(state.interestRate * 100).toFixed(2)}%`;

                document.getElementById('ivOffset').value = (state.ivOffset * 100).toFixed(2);
                document.getElementById('ivOffsetSlider').value = state.ivOffset * 100;
                document.getElementById('ivOffsetDisplay').textContent = `${(state.ivOffset * 100 > 0 ? '+' : '')}${(state.ivOffset * 100).toFixed(2)}%`;

                renderGroups();
                handleLiveSubscriptions();
            } else {
                alert("Invalid JSON format.");
            }
        } catch (error) {
            console.error(error);
            alert("Error parsing JSON file.");
        }
    };
    reader.readAsText(file);
    // Reset input so the same file can be loaded again if needed
    event.target.value = '';
}

// -------------------------------------------------------------
// WebSocket & Live Data Integration
// -------------------------------------------------------------

let ws = null;
let isWsConnected = false;

function connectWebSocket() {
    // Default config assuming Python server on localhost:8765
    ws = new WebSocket('ws://localhost:8765');

    ws.onopen = () => {
        isWsConnected = true;
        console.log("WebSocket Connected to IB Gateway Backend");
        handleLiveSubscriptions();
    };

    ws.onclose = () => {
        isWsConnected = false;
        console.log("WebSocket Disconnected. Reconnecting in 5s...");
        setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            processLiveMarketData(data);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    };
}

function handleLiveSubscriptions() {
    if (!isWsConnected || !ws) return;

    const payload = {
        action: 'subscribe',
        underlying: state.underlyingSymbol,
        options: []
    };

    // Collect all options from groups that have Live Data == true
    state.groups.forEach(group => {
        if (group.liveData) {
            group.legs.forEach(leg => {
                payload.options.push({
                    id: leg.id,
                    right: leg.type.charAt(0).toUpperCase(), // 'C' or 'P'
                    strike: leg.strike,
                    expDate: leg.expDate
                });
            });
        }
    });

    ws.send(JSON.stringify(payload));
}

function requestUnderlyingPriceSync() {
    if (!isWsConnected || !ws) {
        alert("Live Market Data WebSocket is not connected.");
        return;
    }

    // Create a special sync request just for the underlying
    const payload = {
        action: 'sync_underlying',
        underlying: state.underlyingSymbol
    };

    ws.send(JSON.stringify(payload));
}

let renderScheduled = false;

function processLiveMarketData(data) {
    let stateChanged = false;

    // Update Underlying Price if present
    if (data.underlyingPrice) {
        state.underlyingPrice = data.underlyingPrice;
        document.getElementById('underlyingPrice').value = state.underlyingPrice.toFixed(2);
        document.getElementById('underlyingPriceSlider').value = state.underlyingPrice;
        document.getElementById('underlyingPriceDisplay').textContent = currencyFormatter.format(state.underlyingPrice);
        stateChanged = true;
    }

    // Update Option Legs
    if (data.options) {
        state.groups.forEach(group => {
            if (group.liveData) {
                group.legs.forEach(leg => {
                    if (data.options[leg.id] !== undefined) {
                        const liveMark = data.options[leg.id].mark;

                        // Only update if there is a realistic quote and it's different
                        if (liveMark > 0 && Math.abs(liveMark - leg.cost) > 0.001) {
                            leg.cost = liveMark;
                            stateChanged = true;

                            // Try to update the input DOM directly to reflect new live cost
                            const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                            if (row) {
                                const costInput = row.querySelector('.cost-input');
                                if (costInput) costInput.value = liveMark.toFixed(2);
                            }
                        }
                    }
                });
            }
        });
    }

    // Throttle rendering request
    if (stateChanged && !renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(() => {
            updateDerivedValues();
            renderScheduled = false;
        });
    }
}

// Connect immediately on load
connectWebSocket();

