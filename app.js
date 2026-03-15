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
    groups: [],
    hedges: [] // {id, symbol, currentPrice, pos, cost, liveData}
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

document.addEventListener('DOMContentLoaded', () => {
    bindControlPanelEvents();
    renderGroups();
    renderHedges();
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

function isSettlementScenarioMode(viewMode) {
    return viewMode === 'amortized' || viewMode === 'settlement';
}

function groupHasDeterministicCost(group) {
    return group.legs.some(leg => Math.abs(parseFloat(leg.cost) || 0) > 0);
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
        settleUnderlyingPrice: null,
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

// -------------------------------------------------------------
// Hedge Management & Rendering
// -------------------------------------------------------------
function addHedge() {
    const newHedge = {
        id: generateId(),
        symbol: 'UVXY',
        pos: -100,
        cost: 25.00,
        currentPrice: 0.00,
        liveData: false
    };
    state.hedges.push(newHedge);
    renderHedges();
}

function removeHedge(btn) {
    const row = btn.closest('.hedge-row');
    if (!row) return;
    const id = row.dataset.id;
    state.hedges = state.hedges.filter(h => h.id !== id);
    handleLiveSubscriptions();
    renderHedges();
}

// We expose globally so index.html templates can call it
window.addHedge = addHedge;
window.removeHedge = removeHedge;

function renderHedges() {
    const tbody = document.getElementById('hedgesTableBody');
    const emptyState = document.getElementById('hedgeEmptyState');
    const template = document.getElementById('hedgeRowTemplate');
    if (!tbody || !emptyState || !template) return;

    tbody.innerHTML = '';

    if (state.hedges.length === 0) {
        tbody.parentElement.style.display = 'none';
        emptyState.style.display = 'block';
        updateDerivedValues();
        return;
    }

    tbody.parentElement.style.display = 'table';
    emptyState.style.display = 'none';

    state.hedges.forEach(hedge => {
        const clone = template.content.cloneNode(true);
        const tr = clone.querySelector('.hedge-row');
        tr.dataset.id = hedge.id;

        // Bind Symbol
        const symInput = tr.querySelector('.symbol-input');
        symInput.value = hedge.symbol;
        symInput.addEventListener('change', (e) => {
            hedge.symbol = e.target.value.toUpperCase();
            e.target.value = hedge.symbol;
            handleLiveSubscriptions();
            updateDerivedValues();
        });

        // Bind Current Price
        const cpInput = tr.querySelector('.current-price-input');
        cpInput.value = hedge.currentPrice > 0 ? hedge.currentPrice.toFixed(2) : '';
        cpInput.addEventListener('input', (e) => {
            hedge.currentPrice = parseFloat(e.target.value) || 0;
            updateDerivedValues();
        });

        // Bind Position
        const posInput = tr.querySelector('.pos-input');
        posInput.value = hedge.pos;
        posInput.addEventListener('input', (e) => {
            hedge.pos = parseInt(e.target.value) || 0;
            updateDerivedValues();
        });

        // Bind Cost Base
        const costInput = tr.querySelector('.cost-input');
        costInput.value = hedge.cost.toFixed(2);
        costInput.addEventListener('input', (e) => {
            hedge.cost = parseFloat(e.target.value) || 0;
            updateDerivedValues();
        });

        // Bind Live Data Toggle
        const liveToggle = tr.querySelector('.live-data-toggle');
        liveToggle.checked = hedge.liveData;
        liveToggle.addEventListener('change', (e) => {
            hedge.liveData = e.target.checked;
            handleLiveSubscriptions();
        });

        tbody.appendChild(tr);
    });

    updateDerivedValues();
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
        cost: 0.00,
        closePrice: null
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
        document.getElementById('globalAmortizedCard').style.display = 'none';
        document.getElementById('probAnalysisCard').style.display = 'none';
        updateDerivedValues();
        return;
    }

    globalEmptyState.style.display = 'none';
    document.getElementById('globalChartCard').style.display = 'block';
    document.getElementById('globalAmortizedCard').style.display = 'block';
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

        // View Mode Toggle (4-way)
        const toggleActiveBtn = card.querySelector('.toggle-view-active');
        const toggleTrialBtn = card.querySelector('.toggle-view-trial');
        const toggleAmortizedBtn = card.querySelector('.toggle-view-amortized');
        const toggleSettlementBtn = card.querySelector('.toggle-view-settlement');
        const settlementControls = card.querySelector('.settlement-controls');
        
        const currentMode = group.viewMode || 'active'; // support group-level override
        
        [toggleActiveBtn, toggleTrialBtn, toggleAmortizedBtn, toggleSettlementBtn].forEach(btn => {
            if (!btn) return;
            btn.classList.remove('active', 'btn-primary');
            btn.classList.add('btn-secondary');
        });
        
        if (currentMode === 'active' && toggleActiveBtn) {
            toggleActiveBtn.classList.remove('btn-secondary');
            toggleActiveBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'none';
        } else if (currentMode === 'amortized' && toggleAmortizedBtn) {
            toggleAmortizedBtn.classList.remove('btn-secondary');
            toggleAmortizedBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'flex';
        } else if (currentMode === 'settlement' && toggleSettlementBtn) {
            toggleSettlementBtn.classList.remove('btn-secondary');
            toggleSettlementBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'flex';
        } else if (toggleTrialBtn) {
            toggleTrialBtn.classList.remove('btn-secondary');
            toggleTrialBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'none';
        }

        // Settlement Underlying Price Binding
        const settleUldInput = card.querySelector('.group-settle-underlying-input');
        if (settleUldInput) {
            settleUldInput.value = (group.settleUnderlyingPrice !== null && group.settleUnderlyingPrice !== undefined) ? group.settleUnderlyingPrice.toFixed(2) : '';
            settleUldInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                group.settleUnderlyingPrice = isNaN(val) ? null : val;
                updateDerivedValues();
            });
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

                const isStock = leg.type === 'stock';

                // Populate values
                const typeInput = tr.querySelector('.type-input');
                typeInput.value = leg.type;
                typeInput.addEventListener('change', (e) => {
                    const wasStock = leg.type === 'stock';
                    const nowStock = e.target.value === 'stock';
                    leg.type = e.target.value;
                    // Reset fields when switching to/from stock
                    if (nowStock && !wasStock) {
                        leg.strike = 0;
                        leg.expDate = '';
                        leg.iv = 0;
                    } else if (!nowStock && wasStock) {
                        leg.strike = state.underlyingPrice;
                        leg.expDate = addDays(state.baseDate, 30);
                        leg.iv = 0.2;
                    }
                    handleLiveSubscriptions();
                    renderGroups();
                });

                const posInput = tr.querySelector('.pos-input');
                posInput.value = leg.pos;
                posInput.addEventListener('input', (e) => { leg.pos = parseInt(e.target.value) || 0; updateDerivedValues(); });

                const strikeInput = tr.querySelector('.strike-input');
                const dteInput = tr.querySelector('.dte-input');
                const ivInput = tr.querySelector('.iv-input');

                if (isStock) {
                    // Hide option-specific fields for stock legs without breaking table columns
                    strikeInput.style.visibility = 'hidden';
                    dteInput.closest('div').style.visibility = 'hidden';
                } else {
                    strikeInput.style.visibility = 'visible';
                    dteInput.closest('div').style.visibility = 'visible';
                    strikeInput.value = leg.strike;
                    strikeInput.addEventListener('input', (e) => { leg.strike = parseFloat(e.target.value) || 0; updateDerivedValues(); });

                    dteInput.value = leg.expDate;
                    dteInput.addEventListener('change', (e) => {
                        leg.expDate = e.target.value;
                        updateDerivedValues();
                    });

                    ivInput.value = (leg.iv * 100).toFixed(4) + '%';
                    ivInput.addEventListener('change', (e) => {
                        leg.iv = parseFloat(e.target.value) / 100.0 || 0.001;
                        e.target.value = (leg.iv * 100).toFixed(4) + '%';
                        updateDerivedValues();
                    });
                }

                const currentPriceInput = tr.querySelector('.current-price-input');
                currentPriceInput.value = leg.currentPrice > 0 ? leg.currentPrice.toFixed(2) : '';
                currentPriceInput.addEventListener('input', (e) => { leg.currentPrice = parseFloat(e.target.value) || 0; updateDerivedValues(); });

                const costInput = tr.querySelector('.cost-input');
                costInput.value = leg.cost > 0 ? leg.cost.toFixed(2) : '';
                costInput.addEventListener('input', (e) => { leg.cost = parseFloat(e.target.value) || 0; updateDerivedValues(); });

                // Close Price Binding & Visibility
                const closePriceInput = tr.querySelector('.close-price-input');
                const closeLabel = tr.querySelector('.close-label');
                if (closePriceInput && closeLabel) {
                    // Always show the close price input since it now applies universally
                    closePriceInput.style.display = 'block';
                    closeLabel.style.display = 'block';
                    closePriceInput.value = (leg.closePrice !== null && leg.closePrice !== undefined) ? leg.closePrice.toFixed(2) : '';
                    closePriceInput.addEventListener('input', (e) => {
                        const val = parseFloat(e.target.value);
                        leg.closePrice = isNaN(val) ? null : val;
                        updateDerivedValues();
                    });
                }

                // Delete button
                tr.querySelector('.delete-btn').addEventListener('click', () => removeLeg(group.id, leg.id));

                tbody.appendChild(tr);
            });
        }

        // Auto-lock ViewMode to Trial if all costs are perfectly 0 to avoid confusing flatlines.
        // Amortized mode requires deterministic costs, but settlement is still allowed.
        const allZeroCost = !groupHasDeterministicCost(group);
        if (allZeroCost && currentMode !== 'settlement') {
            group.viewMode = 'trial';
            const toggleTrialBtn = card.querySelector('.toggle-view-trial');
            const toggleActiveBtn = card.querySelector('.toggle-view-active');
            const toggleAmortizedBtn = card.querySelector('.toggle-view-amortized');
            if (toggleTrialBtn && toggleActiveBtn && toggleAmortizedBtn) {
                toggleActiveBtn.disabled = true;
                toggleActiveBtn.title = "Add a Cost to unlock Active tracking.";
                toggleActiveBtn.classList.add('text-muted');
                toggleActiveBtn.style.opacity = '0.5';
                toggleAmortizedBtn.disabled = true;
                toggleAmortizedBtn.title = "Add a Cost to unlock Amortized analysis.";
                toggleAmortizedBtn.classList.add('text-muted');
                toggleAmortizedBtn.style.opacity = '0.5';

                toggleTrialBtn.classList.add('active', 'btn-primary');
                toggleTrialBtn.classList.remove('btn-secondary');
                toggleActiveBtn.classList.remove('active', 'btn-primary');
                toggleActiveBtn.classList.add('btn-secondary');
                toggleAmortizedBtn.classList.remove('active', 'btn-primary');
                toggleAmortizedBtn.classList.add('btn-secondary');
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

    if (mode === 'amortized' && !groupHasDeterministicCost(group)) {
        return;
    }

    group.viewMode = mode;

    // Trigger a full re-render of the group to handle complex visibility toggles (Close inputs, settlement controls)
    renderGroups();

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

    let globalHedgePnL = 0;
    let hasAnyHedgeLivePnL = false;

    // ----- Hedges -----
    const hedgeRows = document.querySelectorAll('.hedge-row');
    hedgeRows.forEach(tr => {
        const id = tr.dataset.id;
        const hedge = state.hedges.find(h => h.id === id);
        if (!hedge) return;

        let pnl = 0;
        if (hedge.currentPrice > 0) {
            // Live P&L = (Current - Cost) * Pos
            pnl = (hedge.currentPrice - hedge.cost) * hedge.pos;
            globalHedgePnL += pnl;
            hasAnyHedgeLivePnL = true;
        }

        const pnlCell = tr.querySelector('.pnl-cell');
        if (pnlCell) {
            pnlCell.innerHTML = `<span class="${pnl >= 0 ? 'success-text' : 'danger-text'}">${pnl >= 0 ? '+' : ''}${currencyFormatter.format(pnl)}</span>`;
        }
    });

    // ----- Options Combo Groups -----
    const cards = document.querySelectorAll('.group-card');

    cards.forEach(card => {
        const groupId = card.dataset.groupId;
        const group = state.groups.find(g => g.id === groupId);
        if (!group) return;

        let groupCost = 0;
        let groupSimValue = 0;
        let groupLivePnL = 0;
        let groupHasLiveData = false;

        const activeViewMode = group.viewMode || 'active';
        const usesScenarioUnderlying = isSettlementScenarioMode(activeViewMode);
        const isAmortizedMode = activeViewMode === 'amortized';

        // Scenario mode underlying override
        const evalUnderlyingPrice = (usesScenarioUnderlying && group.settleUnderlyingPrice !== null) 
                                    ? group.settleUnderlyingPrice 
                                    : state.underlyingPrice;

        const rows = card.querySelectorAll('.leg-row');
        rows.forEach(tr => {
            const legId = tr.dataset.id;
            const leg = group.legs.find(l => l.id === legId);
            if (!leg) return;

            // Process leg globally to ensure perfectly synced DTE and IV
            const pLeg = processLegData(leg, state.simulatedDate, state.ivOffset, state.baseDate, evalUnderlyingPrice, state.interestRate, activeViewMode);

            // Update displays for simulated variables (skip for stock legs — fields are hidden)
            if (leg.type !== 'stock') {
                const dteDisplay = tr.querySelector('.simulated-dte-display');
                const ivDisplay = tr.querySelector('.simulated-iv-display');
                if (dteDisplay) dteDisplay.textContent = `Sim DTE: ${pLeg.tradDTE} td / ${pLeg.calDTE} cd`;
                if (ivDisplay) ivDisplay.textContent = `Sim IV: ${(pLeg.simIV * 100).toFixed(2)}%`;
            }

            // Dynamic Trial / Active Price Display
            const currentPriceInput = tr.querySelector('.current-price-input');
            if (leg.type === 'stock') {
                // Stock legs: show underlying price as placeholder when no live price
                if (leg.currentPrice === 0) {
                    currentPriceInput.value = "";
                    currentPriceInput.placeholder = evalUnderlyingPrice.toFixed(2);
                    currentPriceInput.title = "Current Stock Price (defaults to underlying)";
                } else {
                    currentPriceInput.value = leg.currentPrice.toFixed(2);
                    currentPriceInput.placeholder = "0.00";
                    currentPriceInput.title = "Current Stock Price";
                }
            } else if (activeViewMode === 'trial' && leg.currentPrice === 0) {
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
                pLeg, leg, evalUnderlyingPrice, state.interestRate,
                activeViewMode, state.simulatedDate, state.baseDate, state.ivOffset
            );

            const simValue = pLeg.posMultiplier * simPricePerShare;

            groupSimValue += simValue;

            const pnl = simValue - pLeg.costBasis;

            let simPriceHtml = currencyFormatter.format(simPricePerShare);
            
            // Show "Closed" universally
            if (leg.closePrice !== null && leg.closePrice !== '') {
                simPriceHtml += ` <span class="badge" style="background: var(--primary-color); font-size: 0.65rem; vertical-align: middle;">Closed</span>`;
            } else if (usesScenarioUnderlying) {
                if (pLeg.isExpired) {
                    if (simPricePerShare > 0) {
                        simPriceHtml += ` <span class="badge" style="background: var(--success-color); font-size: 0.65rem; vertical-align: middle;">Exercised</span>`;
                    } else {
                        simPriceHtml += ` <span class="badge bg-secondary" style="font-size: 0.65rem; vertical-align: middle;">Expired</span>`;
                    }
                } else {
                    simPriceHtml += ` <span class="badge" style="background: var(--warning-color); font-size: 0.65rem; vertical-align: middle;">Active</span>`;
                }
            }

            tr.querySelector('.simulated-price-cell').innerHTML = simPriceHtml;
            const pnlCell = tr.querySelector('.pnl-cell');
            const isClosedGlobally = (leg.closePrice !== null && leg.closePrice !== '');
            
            if (isClosedGlobally) {
                pnlCell.innerHTML = `<span class="badge ${pnl >= 0 ? 'bg-success' : 'bg-danger'}" style="font-size: 0.85rem; padding: 4px 6px;">Realized: <br/>${pnl >= 0 ? '+' : ''}${currencyFormatter.format(pnl)}</span>`;
            } else {
                pnlCell.innerHTML = `<span class="${pnl >= 0 ? 'profit' : 'loss'}">${pnl >= 0 ? '+' : ''}${currencyFormatter.format(pnl)}</span>`;
            }

            const livePnlCell = tr.querySelector('.live-pnl-cell');

            // Live P&L: (currentPrice - cost) × pos × multiplier
            // If the leg is closed, its live P&L is locked to its realized PnL.
            if (leg.cost !== 0 || leg.currentPrice !== 0 || isClosedGlobally) {
                const liveLegPnL = (leg.currentPrice - leg.cost) * pLeg.posMultiplier;
                const effectiveLivePnL = isClosedGlobally ? pnl : liveLegPnL;
                
                groupLivePnL += effectiveLivePnL;
                groupHasLiveData = true;

                if (livePnlCell) {
                    if (isClosedGlobally) {
                        livePnlCell.style.display = 'none';
                    } else {
                        livePnlCell.innerHTML = `<span class="${liveLegPnL >= 0 ? 'success-text' : 'danger-text'}">${liveLegPnL >= 0 ? '+' : ''}${currencyFormatter.format(liveLegPnL)}</span>`;
                        livePnlCell.style.display = 'block';
                    }
                }
            } else if (livePnlCell) {
                livePnlCell.style.display = 'none';
            }
        });

        // Update Group Summary DOM
        const groupPnl = groupSimValue - groupCost;
        card.querySelector('.group-cost').textContent = currencyFormatter.format(groupCost);
        card.querySelector('.group-sim-value').textContent = currencyFormatter.format(groupSimValue);
        card.querySelector('.group-pnl').innerHTML = `<span class="${groupPnl >= 0 ? 'success-text' : 'danger-text'}">${groupPnl >= 0 ? '+' : ''}${currencyFormatter.format(groupPnl)}</span>`;

        // --------------------------------------------------------------------------
        // Calculate & Layout Amortized Stock Cost Basis Automatically in Amortized mode
        // --------------------------------------------------------------------------
        const amContainer = card.querySelector('.amortization-container');
        const settleControls = card.querySelector('.settlement-controls');

        const simulateBtn = card.querySelector('.btn-simulate-amortized');

        if (usesScenarioUnderlying) {
            if (settleControls) settleControls.style.display = 'flex';
            if (simulateBtn) simulateBtn.style.display = isAmortizedMode ? 'inline-flex' : 'none';
        } else {
            if (settleControls) settleControls.style.display = 'none';
            if (simulateBtn) simulateBtn.style.display = 'none';
        }

        if (isAmortizedMode) {
            if (amContainer) {
                const result = calculateAmortizedCost(group, evalUnderlyingPrice, state);
                const amText = card.querySelector('.amortization-text');
                
                if (result.netShares !== 0 && amText) {
                    const action = result.netShares > 0 ? 'Assigned' : 'Delivered';
                    amText.textContent = `${action} ${Math.abs(result.netShares)} shares with effective basis of ${currencyFormatter.format(result.basis)}`;
                    amContainer.style.display = 'block';
                } else {
                    amContainer.style.display = 'none';
                }
            }
        } else {
            if (amContainer) amContainer.style.display = 'none';
            // Also hide the amort chart if we leave amortized mode
            const amortChartContainer = card.querySelector('.amortization-chart-container');
            if (amortChartContainer) {
                amortChartContainer.style.display = 'none';
                if (simulateBtn) {
                    simulateBtn.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
                            <line x1="18" y1="20" x2="18" y2="10"></line>
                            <line x1="12" y1="20" x2="12" y2="4"></line>
                            <line x1="6" y1="20" x2="6" y2="14"></line>
                        </svg>
                        Simulate Amortized Price
                    `;
                }
            }
        }

        // Highlight P&L in Settlement Mode
        const pnlContainer = card.querySelector('.pnl-container');
        const pnlLabel = card.querySelector('.group-pnl-label');
        if (pnlContainer && pnlLabel) {
            if (activeViewMode === 'settlement') {
                pnlLabel.textContent = 'Settlement P&L:';
                pnlContainer.classList.add('settlement-highlight');
            } else {
                pnlLabel.textContent = 'P&L:';
                pnlContainer.classList.remove('settlement-highlight');
            }
        }

        // Update Table Headers and Button Visibility
        const simPnlHeader = card.querySelector('.sim-pnl-header-text');
        const livePnlHeader = card.querySelector('.live-pnl-header-text');
        const showChartBtn = card.querySelector('.toggle-chart-btn');

        if (simPnlHeader && livePnlHeader) {
            if (usesScenarioUnderlying) {
                simPnlHeader.textContent = isAmortizedMode ? 'AMORTIZED P&L' : 'SETTLEMENT P&L';
                livePnlHeader.style.display = 'none';
                if (showChartBtn) showChartBtn.style.display = 'none';
            } else {
                simPnlHeader.textContent = 'Sim P&L';
                if (groupHasLiveData) livePnlHeader.style.display = 'inline';
                if (showChartBtn) showChartBtn.style.display = 'inline-block';
            }
        }

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

        const amortChartContainer = card.querySelector('.amortization-chart-container');
        if (amortChartContainer && amortChartContainer.style.display !== 'none') {
            const amortCanvas = amortChartContainer.querySelector('.amortization-canvas');
            const marginCanvas = amortChartContainer.querySelector('.margin-canvas');
            if (amortCanvas) drawAmortizationChart(card, group, amortCanvas, marginCanvas);
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

    // Global Live P&L (Options)
    const globalLivePnLRow = document.getElementById('globalLivePnLRow');
    if (globalLivePnLRow) {
        if (hasAnyLiveData) {
            globalLivePnLRow.style.display = '';
            const globalLivePnLEl = document.getElementById('globalLivePnL');
            globalLivePnLEl.innerHTML = `<span class="${globalLivePnL >= 0 ? 'success-text' : 'danger-text'}">${globalLivePnL >= 0 ? '+' : ''}${currencyFormatter.format(globalLivePnL)}</span>`;
        } else {
            globalLivePnLRow.style.display = 'none';
        }
    }

    // Hedge Live P&L
    const hedgeLivePnLRow = document.getElementById('hedgeLivePnLRow');
    if (hedgeLivePnLRow) {
        if (hasAnyHedgeLivePnL) {
            hedgeLivePnLRow.style.display = '';
            const hedgeLivePnLEl = document.getElementById('hedgeLivePnL');
            hedgeLivePnLEl.innerHTML = `<span class="${globalHedgePnL >= 0 ? 'success-text' : 'danger-text'}">${globalHedgePnL >= 0 ? '+' : ''}${currencyFormatter.format(globalHedgePnL)}</span>`;
        } else {
            hedgeLivePnLRow.style.display = 'none';
        }
    }

    // Total Live P&L (Options + Hedges)
    const totalLivePnLRow = document.getElementById('totalLivePnLRow');
    if (totalLivePnLRow) {
        if (hasAnyLiveData || hasAnyHedgeLivePnL) {
            totalLivePnLRow.style.display = '';
            const combinedLivePnL = globalLivePnL + globalHedgePnL;
            const totalLivePnLEl = document.getElementById('totalLivePnL');
            totalLivePnLEl.innerHTML = `<span class="${combinedLivePnL >= 0 ? 'success-text' : 'danger-text'}">${combinedLivePnL >= 0 ? '+' : ''}${currencyFormatter.format(combinedLivePnL)}</span>`;
        } else {
            totalLivePnLRow.style.display = 'none';
        }
    }

    // Global Amortized Result (combines groups currently in Amortized mode)
    const globalAmortizedCard = document.getElementById('globalAmortizedCard');
    const globalAmortizedBanner = document.getElementById('globalAmortizedBanner');
    const globalAmortizedText = document.getElementById('globalAmortizedText');
    const globalAmortizedInfoText = document.getElementById('globalAmortizedInfoText');

    if (globalAmortizedCard && globalAmortizedBanner && globalAmortizedText && globalAmortizedInfoText) {
        const amortizedGroups = state.groups.filter(g => (g.viewMode || 'active') === 'amortized');

        if (amortizedGroups.length > 0) {
            const result = calculateCombinedAmortizedCost(amortizedGroups, state);
            globalAmortizedCard.style.display = 'block';
            globalAmortizedBanner.style.display = 'block';
            globalAmortizedInfoText.textContent = `Banner uses each amortized group's scenario override when set. Chart uses a shared global scenario price axis.`;

            if (result.netShares > 0) {
                globalAmortizedText.textContent = `Assigned ${result.netShares} shares with combined effective basis of ${currencyFormatter.format(result.basis)}`;
            } else if (result.netShares < 0) {
                globalAmortizedText.textContent = `Delivered ${Math.abs(result.netShares)} shares with combined effective basis of ${currencyFormatter.format(result.basis)}`;
            } else {
                globalAmortizedText.textContent = 'No net assigned or delivered shares across the current amortized groups.';
            }
        } else {
            globalAmortizedCard.style.display = 'none';
            globalAmortizedBanner.style.display = 'none';
            globalAmortizedText.textContent = '';
            globalAmortizedInfoText.textContent = '';
            const globalAmortizedChartContainer = document.getElementById('globalAmortizedChartContainer');
            if (globalAmortizedChartContainer) globalAmortizedChartContainer.style.display = 'none';
            const globalAmortizedToggleBtn = globalAmortizedCard.querySelector('.toggle-global-amortized-chart-btn');
            if (globalAmortizedToggleBtn) globalAmortizedToggleBtn.textContent = 'Show Chart';
        }

        const globalAmortizedChartContainer = document.getElementById('globalAmortizedChartContainer');
        if (globalAmortizedChartContainer && globalAmortizedChartContainer.style.display !== 'none'
            && globalAmortizedCard.style.display !== 'none'
            && typeof drawGlobalAmortizedChart === 'function') {
            drawGlobalAmortizedChart(globalAmortizedCard);
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

let currentFileHandle = null;

async function handleImportBtnClick() {
    if (window.showOpenFilePicker) {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [{
                    description: 'JSON Files',
                    accept: {
                        'application/json': ['.json'],
                    },
                }],
                multiple: false
            });
            currentFileHandle = fileHandle;
            const file = await fileHandle.getFile();
            document.getElementById('saveBtn').style.display = 'inline-flex';
            processImportedFile(file);
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error("Error opening file picker:", error);
                document.getElementById('importFile').click();
            }
        }
    } else {
        document.getElementById('importFile').click();
    }
}

async function saveToJSON() {
    const dataStr = JSON.stringify(state, null, 2);
    const saveBtn = document.getElementById('saveBtn');
    
    if (currentFileHandle && saveBtn) {
        try {
            const writable = await currentFileHandle.createWritable();
            await writable.write(dataStr);
            await writable.close();
            
            // Visual feedback
            const originalHTML = saveBtn.innerHTML;
            saveBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Saved!`;
            setTimeout(() => {
                saveBtn.innerHTML = originalHTML;
            }, 2000);
            return;
        } catch (error) {
            console.error("Error saving directly to file:", error);
        }
    }
    
    exportToJSON();
}

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

    currentFileHandle = null;
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) saveBtn.style.display = 'none';

    processImportedFile(file);
    event.target.value = '';
}

function processImportedFile(file) {
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
                        if (newLeg.closePrice === undefined) {
                            newLeg.closePrice = null;
                        }
                        return newLeg;
                    });
                };

                // Handle legacy v1 imports (single array of legs)
                if (importedState.legs && Array.isArray(importedState.legs) && (!importedState.groups || importedState.groups.length === 0)) {
                    importedGroups = [{
                        id: generateId(),
                        name: 'Legacy Combo',
                        settleUnderlyingPrice: null,
                        legs: migrateLegs(importedState.legs)
                    }];
                } else {
                    const parsedGroups = Array.isArray(importedState.groups) ? importedState.groups : [];
                    importedGroups = parsedGroups.map(g => ({
                        ...g,
                        id: generateId(),
                        settleUnderlyingPrice: g.settleUnderlyingPrice !== undefined ? g.settleUnderlyingPrice : null,
                        legs: migrateLegs(Array.isArray(g.legs) ? g.legs : [])
                    }));
                }

                // Append instead of overwrite for Groups
                state.groups.push(...importedGroups);

                // Import tracking hedges
                if (importedState.hedges && Array.isArray(importedState.hedges)) {
                    const parsedHedges = importedState.hedges.map(h => ({
                        ...h,
                        id: generateId()
                    }));
                    state.hedges.push(...parsedHedges);
                }

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
                renderHedges();
                handleLiveSubscriptions();
            } else {
                alert("Invalid JSON format.");
            }
        } catch (error) {
            console.error("JSON Import Error:", error);
            alert("Error parsing JSON file or loading state. Check the console for details.");
        }
    };
    reader.readAsText(file);
}

// WebSocket & Live Data Integration → see ws_client.js
/**
 * Common Logic for Amortized Cost Calculation
 * Used by UI banner, simulation chart, and tooltips.
 */
function calculateAmortizedCost(group, evalUnderlyingPrice, globalState) {
    let netShares = 0;
    let initialCashOutflow = 0;
    let residualValue = 0;
    let assignmentCash = 0;

    // 1. Calculate the real initial net cash spent on ALL positions (Stock + Options)
    group.legs.forEach(leg => {
        const pLeg = processLegData(leg, globalState.simulatedDate, globalState.ivOffset, globalState.baseDate, evalUnderlyingPrice, globalState.interestRate, group.viewMode || 'active');
        initialCashOutflow += pLeg.costBasis;
        if (leg.type.toLowerCase() === 'stock') {
            netShares += leg.pos * 1; 
        }
    });

    let currentCash = -initialCashOutflow; // Start with debt
    
    // 2. Adjust cash flow for options being closed or assigned
    group.legs.forEach(leg => {
        if (leg.type.toLowerCase() === 'stock') return;
        
        const pos = leg.pos;
        const multiplier = 100;
        const activeViewMode = leg._viewMode || group.viewMode || 'active';
        
        if (leg.closePrice !== null && leg.closePrice !== '') {
            currentCash += parseFloat(leg.closePrice) * pos * multiplier;
        } else {
            const pLeg = processLegData(leg, globalState.simulatedDate, globalState.ivOffset, globalState.baseDate, evalUnderlyingPrice, globalState.interestRate, activeViewMode);
            const simPricePerShare = computeSimulatedPrice(
                pLeg, leg, evalUnderlyingPrice, globalState.interestRate,
                activeViewMode, globalState.simulatedDate, globalState.baseDate, globalState.ivOffset
            );
            
            if (!pLeg.isExpired) {
                // Premature close (cashing out the option's residual value)
                const value = simPricePerShare * pos * multiplier;
                currentCash += value;
                residualValue += value;
            } else if (simPricePerShare > 0) {
                // Expired ITM -> Assignment
                let assignmentShares = 0;
                if (leg.type.toLowerCase() === 'call') assignmentShares = pos * multiplier;
                else if (leg.type.toLowerCase() === 'put') assignmentShares = -pos * multiplier;
                
                netShares += assignmentShares;
                const flow = -assignmentShares * leg.strike;
                currentCash += flow; 
                assignmentCash += flow;
            }
        }
    });

    // 3. Final metrics
    let basis = 0;
    if (netShares !== 0) {
        if (netShares > 0) {
            basis = (-currentCash) / netShares;
        } else {
            basis = currentCash / Math.abs(netShares);
        }
    }

    return { 
        netShares, 
        basis, 
        nocf: currentCash, 
        totalCash: currentCash,
        residualValue,
        assignmentCash,
        initialCost: initialCashOutflow
    };
}

function calculateCombinedAmortizedCost(groups, globalState) {
    let netShares = 0;
    let totalCash = 0;
    let residualValue = 0;
    let assignmentCash = 0;
    let initialCost = 0;

    groups.forEach(group => {
        const evalUnderlyingPrice = (group.settleUnderlyingPrice !== null && group.settleUnderlyingPrice !== undefined)
            ? group.settleUnderlyingPrice
            : globalState.underlyingPrice;
        const result = calculateAmortizedCost(group, evalUnderlyingPrice, globalState);
        netShares += result.netShares;
        totalCash += result.totalCash;
        residualValue += result.residualValue;
        assignmentCash += result.assignmentCash;
        initialCost += result.initialCost;
    });

    let basis = 0;
    if (netShares > 0) {
        basis = (-totalCash) / netShares;
    } else if (netShares < 0) {
        basis = totalCash / Math.abs(netShares);
    }

    return {
        netShares,
        basis,
        totalCash,
        residualValue,
        assignmentCash,
        initialCost
    };
}
