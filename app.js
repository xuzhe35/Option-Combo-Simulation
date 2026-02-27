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
    interestRate: 0.03, // 3% default risk-free rate
    ivOffset: 0.0, // 0%
    viewMode: 'active', // 'active' (Historical Entry Cost) or 'trial' (Current Live Price)
    groups: []
};

// Throttle flag for slider-driven updates (one rAF per frame max)
let _sliderRafPending = false;
function throttledUpdate() {
    if (!_sliderRafPending) {
        _sliderRafPending = true;
        requestAnimationFrame(() => {
            updateDerivedValues();
            _sliderRafPending = false;
        });
    }
}

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

// Visual flash effect for DOM input elements (e.g. live data updates)
function flashElement(el) {
    el.style.backgroundColor = 'rgba(74, 222, 128, 0.4)';
    setTimeout(() => {
        el.style.transition = 'background-color 0.8s ease';
        el.style.backgroundColor = 'transparent';
        setTimeout(() => el.style.transition = '', 800);
    }, 50);
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
    upSlider.addEventListener('input', (e) => {
        state.underlyingPrice = parseFloat(e.target.value);
        upInput.value = state.underlyingPrice;
        upDisplay.textContent = currencyFormatter.format(state.underlyingPrice);
        throttledUpdate();
    });

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
    dpSlider.addEventListener('input', (e) => {
        const dNum = parseInt(e.target.value, 10);
        const newDateStr = addDays(state.baseDate, dNum);
        state.simulatedDate = newDateStr;
        simDateInput.value = state.simulatedDate;
        const tradDays = calendarToTradingDays(state.baseDate, state.simulatedDate);
        dpDisplay.textContent = `+${tradDays} td / +${dNum} cd`;
        throttledUpdate();
    });

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
    ivSlider.addEventListener('input', (e) => {
        const pct = parseFloat(e.target.value);
        state.ivOffset = pct / 100.0;
        ivInput.value = pct;
        const sign = pct > 0 ? '+' : '';
        ivDisplay.textContent = `${sign}${pct.toFixed(2)}%`;
        throttledUpdate();
    });
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

function toggleSidebar() {
    const layoutGrid = document.querySelector('.layout-grid');
    if (layoutGrid) {
        layoutGrid.classList.toggle('sidebar-collapsed');
    }
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
        currentPrice: 0.00,
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

        // View Mode Toggle (Dual Charting)
        const toggleActiveBtn = card.querySelector('.toggle-view-active');
        const toggleTrialBtn = card.querySelector('.toggle-view-trial');
        const currentMode = group.viewMode || 'active'; // support group-level override
        if (currentMode === 'active') {
            toggleActiveBtn.classList.add('active');
            toggleActiveBtn.classList.remove('btn-secondary');
            toggleActiveBtn.classList.add('btn-primary');
            toggleTrialBtn.classList.remove('active', 'btn-primary');
            toggleTrialBtn.classList.add('btn-secondary');
        } else {
            toggleTrialBtn.classList.add('active');
            toggleTrialBtn.classList.remove('btn-secondary');
            toggleTrialBtn.classList.add('btn-primary');
            toggleActiveBtn.classList.remove('active', 'btn-primary');
            toggleActiveBtn.classList.add('btn-secondary');
        }

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
                ivInput.value = (leg.iv * 100).toFixed(4) + '%';
                ivInput.addEventListener('change', (e) => {
                    leg.iv = parseFloat(e.target.value) / 100.0 || 0.001;
                    e.target.value = (leg.iv * 100).toFixed(4) + '%';
                    updateDerivedValues();
                });

                const currentPriceInput = tr.querySelector('.current-price-input');
                currentPriceInput.value = leg.currentPrice.toFixed(2);
                currentPriceInput.addEventListener('input', (e) => { leg.currentPrice = parseFloat(e.target.value) || 0; updateDerivedValues(); });

                const costInput = tr.querySelector('.cost-input');
                costInput.value = leg.cost.toFixed(2);
                costInput.addEventListener('input', (e) => { leg.cost = parseFloat(e.target.value) || 0; updateDerivedValues(); });

                // Delete button
                tr.querySelector('.delete-btn').addEventListener('click', () => removeLeg(group.id, leg.id));

                tbody.appendChild(tr);
            });
        }

        // Auto-lock ViewMode to Trial if all costs are perfectly 0 to avoid confusing flatlines
        let allZeroCost = true;
        group.legs.forEach(leg => {
            if (leg.cost !== 0) allZeroCost = false;
        });
        if (allZeroCost) {
            group.viewMode = 'trial';
            const toggleTrialBtn = card.querySelector('.toggle-view-trial');
            const toggleActiveBtn = card.querySelector('.toggle-view-active');
            if (toggleTrialBtn && toggleActiveBtn) {
                toggleActiveBtn.disabled = true;
                toggleActiveBtn.title = "Add a Cost to unlock Active historical tracking.";
                toggleActiveBtn.classList.add('text-muted');
                toggleActiveBtn.style.opacity = '0.5';

                toggleTrialBtn.classList.add('active', 'btn-primary');
                toggleTrialBtn.classList.remove('btn-secondary');
                toggleActiveBtn.classList.remove('active', 'btn-primary');
                toggleActiveBtn.classList.add('btn-secondary');
            }
        }

        container.appendChild(card);
    });

    updateDerivedValues();
}

// -------------------------------------------------------------
// Core Calculations
// -------------------------------------------------------------

function setGroupViewMode(btn, mode) {
    const card = btn.closest('.group-card');
    if (!card) return;
    const groupId = card.dataset.groupId;
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return;

    group.viewMode = mode;

    // Update button styles in-place (no DOM rebuild needed)
    const toggleActiveBtn = card.querySelector('.toggle-view-active');
    const toggleTrialBtn = card.querySelector('.toggle-view-trial');
    if (mode === 'active') {
        toggleActiveBtn.classList.add('active', 'btn-primary');
        toggleActiveBtn.classList.remove('btn-secondary');
        toggleTrialBtn.classList.remove('active', 'btn-primary');
        toggleTrialBtn.classList.add('btn-secondary');
    } else {
        toggleTrialBtn.classList.add('active', 'btn-primary');
        toggleTrialBtn.classList.remove('btn-secondary');
        toggleActiveBtn.classList.remove('active', 'btn-primary');
        toggleActiveBtn.classList.add('btn-secondary');
    }

    updateDerivedValues();

    // Explicitly redraw charts related to this group
    triggerChartRedraw(btn);
    // Refresh probability simulation globally just in case (optional, depending on load)
    updateProbCharts();
}

function updateDerivedValues() {
    let globalTotalCost = 0;
    let globalSimulatedValue = 0;
    let globalLivePnL = 0;
    let hasAnyLiveData = false;

    const cards = document.querySelectorAll('.group-card');

    cards.forEach(card => {
        const groupId = card.dataset.groupId;
        const group = state.groups.find(g => g.id === groupId);
        if (!group) return;

        let groupCost = 0;
        let groupSimValue = 0;
        let groupLivePnL = 0;
        let groupHasLiveData = false;

        const rows = card.querySelectorAll('.leg-row');
        rows.forEach(tr => {
            const legId = tr.dataset.id;
            const leg = group.legs.find(l => l.id === legId);
            if (!leg) return;

            // Process leg globally to ensure perfectly synced DTE and IV
            const activeViewMode = group.viewMode || 'active';
            const pLeg = processLegData(leg, state.simulatedDate, state.ivOffset, state.baseDate, state.underlyingPrice, state.interestRate, activeViewMode);

            // Update displays for simulated variables
            tr.querySelector('.simulated-dte-display').textContent = `Sim DTE: ${pLeg.tradDTE} td / ${pLeg.calDTE} cd`;
            tr.querySelector('.simulated-iv-display').textContent = `Sim IV: ${(pLeg.simIV * 100).toFixed(2)}%`;

            // Dynamic Trial / Active Price Display
            const currentPriceInput = tr.querySelector('.current-price-input');
            if (activeViewMode === 'trial' && leg.currentPrice === 0) {
                // The system is seamlessly falling back to BSM Theoretical Price (Today)
                // We wipe the "0.00" value so the HTML placeholder can visibly expose this calculated baseline to the user
                currentPriceInput.value = "";
                currentPriceInput.placeholder = pLeg.effectiveCostPerShare.toFixed(2);
                currentPriceInput.title = "Theoretical BSM Price for Today";
            } else {
                currentPriceInput.value = leg.currentPrice.toFixed(2);
                currentPriceInput.placeholder = "0.00";
                currentPriceInput.title = "Current Live Quote (or manually entered)";
            }

            // Calculate Pricing
            groupCost += pLeg.costBasis;

            // Unified simulation price: Zero-Delta bypass handled inside bsm.js
            const simPricePerShare = computeSimulatedPrice(
                pLeg, leg, state.underlyingPrice, state.interestRate,
                activeViewMode, state.simulatedDate, state.baseDate, state.ivOffset
            );

            const simValue = pLeg.posMultiplier * simPricePerShare;

            groupSimValue += simValue;

            const pnl = simValue - pLeg.costBasis;

            tr.querySelector('.simulated-price-cell').textContent = currencyFormatter.format(simPricePerShare);
            const pnlCell = tr.querySelector('.pnl-cell');
            pnlCell.innerHTML = `<span class="${pnl >= 0 ? 'profit' : 'loss'}">${pnl >= 0 ? '+' : ''}${currencyFormatter.format(pnl)}</span>`;

            // Live P&L: (currentPrice - cost) × pos × multiplier
            // Pure market-based, no BSM simulation, directly comparable to TWS
            if (leg.currentPrice > 0 && leg.cost > 0) {
                const liveLegPnL = (leg.currentPrice - leg.cost) * pLeg.posMultiplier;
                groupLivePnL += liveLegPnL;
                groupHasLiveData = true;
            }
        });

        // Update Group Summary DOM
        const groupPnl = groupSimValue - groupCost;
        card.querySelector('.group-cost').textContent = currencyFormatter.format(groupCost);
        card.querySelector('.group-sim-value').textContent = currencyFormatter.format(groupSimValue);
        card.querySelector('.group-pnl').innerHTML = `<span class="${groupPnl >= 0 ? 'success-text' : 'danger-text'}">${groupPnl >= 0 ? '+' : ''}${currencyFormatter.format(groupPnl)}</span>`;

        // Live P&L Group Summary
        const livePnlItem = card.querySelector('.group-live-pnl-item');
        if (livePnlItem) {
            if (groupHasLiveData) {
                livePnlItem.style.display = '';
                const livePnlSpan = card.querySelector('.group-live-pnl');
                livePnlSpan.innerHTML = `<span class="${groupLivePnL >= 0 ? 'success-text' : 'danger-text'}">${groupLivePnL >= 0 ? '+' : ''}${currencyFormatter.format(groupLivePnL)}</span>`;
            } else {
                livePnlItem.style.display = 'none';
            }
        }

        // Update Chart if visible
        const chartContainer = card.querySelector('.chart-container');
        if (chartContainer && chartContainer.style.display !== 'none') {
            drawGroupChart(card, group);
        }

        globalTotalCost += groupCost;
        globalSimulatedValue += groupSimValue;
        if (groupHasLiveData) {
            globalLivePnL += groupLivePnL;
            hasAnyLiveData = true;
        }
    });

    // Update Global Summary Card
    const globalPnL = globalSimulatedValue - globalTotalCost;

    document.getElementById('totalCost').textContent = currencyFormatter.format(globalTotalCost);
    document.getElementById('simulatedValue').textContent = currencyFormatter.format(globalSimulatedValue);

    const unPnlEl = document.getElementById('unrealizedPnL');
    unPnlEl.innerHTML = `<span class="${globalPnL >= 0 ? 'profit' : 'loss'}">${globalPnL >= 0 ? '+' : ''}${currencyFormatter.format(globalPnL)}</span>`;

    // Global Live P&L
    const globalLivePnLRow = document.getElementById('globalLivePnLRow');
    if (globalLivePnLRow) {
        if (hasAnyLiveData) {
            globalLivePnLRow.style.display = '';
            const globalLivePnLEl = document.getElementById('globalLivePnL');
            globalLivePnLEl.innerHTML = `<span class="${globalLivePnL >= 0 ? 'profit' : 'loss'}">${globalLivePnL >= 0 ? '+' : ''}${currencyFormatter.format(globalLivePnL)}</span>`;
        } else {
            globalLivePnLRow.style.display = 'none';
        }
    }

    // Update Global Chart
    const globalCard = document.getElementById('globalChartCard');
    const gcContainer = document.getElementById('globalChartContainer');
    if (globalCard && gcContainer && gcContainer.style.display !== 'none') {
        if (typeof drawGlobalChart === 'function') {
            drawGlobalChart(globalCard);
        }
    }
}


// Chart Logic, Probability Analysis Helpers → see chart_controls.js

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
                        if (newLeg.currentPrice === undefined) {
                            newLeg.currentPrice = 0.00;
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
                const tradDays = calendarToTradingDays(state.baseDate, state.simulatedDate);
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

// WebSocket & Live Data Integration → see ws_client.js
