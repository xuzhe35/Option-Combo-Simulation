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

function resolveBootstrapRuntimeConfig() {
    const bootstrap = (typeof window !== 'undefined' && window.OptionComboBootstrap && typeof window.OptionComboBootstrap === 'object')
        ? window.OptionComboBootstrap
        : {};
    const search = typeof window !== 'undefined' && window.location && typeof window.location.search === 'string'
        ? window.location.search
        : '';
    const params = typeof URLSearchParams !== 'undefined' && search
        ? new URLSearchParams(search)
        : null;

    let workspaceVariant = String(
        bootstrap.workspaceVariant
        || bootstrap.entry
        || (params ? (params.get('workspaceVariant') || params.get('entry') || '') : '')
        || ''
    ).trim().toLowerCase();
    if (workspaceVariant !== 'historical' && workspaceVariant !== 'live') {
        workspaceVariant = '';
    }

    let requestedMode = bootstrap.marketDataMode;
    if (!requestedMode && params) {
        requestedMode = params.get('marketDataMode') || params.get('mode') || '';
    }
    if (workspaceVariant && !requestedMode) {
        requestedMode = workspaceVariant;
    }

    const marketDataMode = String(requestedMode || '').trim().toLowerCase() === 'historical'
        ? 'historical'
        : 'live';

    let marketDataModeLocked = bootstrap.marketDataModeLocked === true || bootstrap.lockMarketDataMode === true;
    if (!marketDataModeLocked && params) {
        const lockValue = String(params.get('marketDataModeLocked') || params.get('lockMarketDataMode') || '').trim().toLowerCase();
        marketDataModeLocked = lockValue === '1' || lockValue === 'true' || lockValue === 'yes';
    }
    if (workspaceVariant && bootstrap.marketDataModeLocked === undefined && bootstrap.lockMarketDataMode === undefined && !params?.has('marketDataModeLocked') && !params?.has('lockMarketDataMode')) {
        marketDataModeLocked = true;
    }

    return {
        marketDataMode: workspaceVariant === 'historical'
            ? 'historical'
            : (workspaceVariant === 'live' ? 'live' : marketDataMode),
        workspaceVariant,
        marketDataModeLocked,
    };
}

const bootstrapRuntimeConfig = resolveBootstrapRuntimeConfig();
if (typeof window !== 'undefined') {
    window.OptionComboRuntimeConfig = bootstrapRuntimeConfig;
}

const state = {
    importedSessionTitle: '',
    underlyingSymbol: 'SPY',
    underlyingContractMonth: '',
    underlyingPrice: 100.00,
    baseDate: initialDateStr, // Today local YYYY-MM-DD
    simulatedDate: initialDateStr, // Initially same as baseDate
    marketDataMode: bootstrapRuntimeConfig.marketDataMode,
    workspaceVariant: bootstrapRuntimeConfig.workspaceVariant,
    marketDataModeLocked: bootstrapRuntimeConfig.marketDataModeLocked === true,
    historicalQuoteDate: '',
    historicalAvailableStartDate: '',
    historicalAvailableEndDate: '',
    interestRate: 0.03, // 3% default risk-free rate
    ivOffset: 0.0, // 0%
    allowLiveComboOrders: false,
    forwardRateSamples: [],
    futuresPool: [],
    viewMode: 'active', // 'active' (Historical Entry Cost) or 'trial' (Current Live Price)
    groups: [],
    hedges: [] // {id, symbol, currentPrice, pos, cost, liveData}
};

window.__optionComboApp = {
    getState: () => state,
    renderGroups: () => renderGroups(),
    renderHedges: () => renderHedges(),
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
    return OptionComboValuation.isSettlementScenarioMode(viewMode);
}

function groupHasDeterministicCost(group) {
    return OptionComboSessionLogic.groupHasDeterministicCost(group);
}

function groupHasOpenPosition(group) {
    return OptionComboSessionLogic.groupHasOpenPosition(group);
}

function getUnderlyingProfile() {
    if (typeof OptionComboProductRegistry === 'undefined') {
        return null;
    }
    return OptionComboProductRegistry.resolveUnderlyingProfile(state.underlyingSymbol);
}

// -------------------------------------------------------------
// DOM Event Binding
// -------------------------------------------------------------
function bindControlPanelEvents() {
    OptionComboControlPanelUI.bindControlPanelEvents(state, currencyFormatter, {
        updateDerivedValues,
        throttledUpdate,
        handleLiveSubscriptions,
        settleHistoricalReplayGroups,
        renderGroups,
        generateId,
        addDays,
        diffDays,
        calendarToTradingDays,
    });
}

// -------------------------------------------------------------
// Group & Leg Management & Rendering
// -------------------------------------------------------------

// getMultiplier() has been unified globally in bsm.js

function addGroup() {
    OptionComboGroupEditorUI.addGroup(state, generateId, {
        addDays,
        renderGroups,
    });
}

function removeGroup(groupId) {
    OptionComboGroupEditorUI.removeGroup(state, groupId, {
        handleLiveSubscriptions,
        renderGroups,
    });
}

// -------------------------------------------------------------
// Hedge Management & Rendering
// -------------------------------------------------------------
function addHedge() {
    OptionComboHedgeEditorUI.addHedge(state, renderHedges, generateId);
}

function removeHedge(btn) {
    OptionComboHedgeEditorUI.removeHedge(state, btn, {
        handleLiveSubscriptions,
        renderHedges,
    });
}

// We expose globally so index.html templates can call it
window.addHedge = addHedge;
window.removeHedge = removeHedge;

function renderHedges() {
    OptionComboHedgeEditorUI.renderHedges(state, {
        updateDerivedValues,
        handleLiveSubscriptions,
    });
}

function toggleSidebar() {
    OptionComboControlPanelUI.toggleSidebar();
}

function addLegToGroupById(groupId) {
    OptionComboGroupEditorUI.addLegToGroupById(state, groupId, generateId, {
        addDays,
        renderGroups,
    });
}

function addLegToGroup(buttonEl) {
    OptionComboGroupEditorUI.addLegToGroup(state, buttonEl, generateId, {
        addDays,
        renderGroups,
    });
}

function removeLeg(groupId, legId) {
    OptionComboGroupEditorUI.removeLeg(state, groupId, legId, {
        handleLiveSubscriptions,
        renderGroups,
    });
}

function renderGroups() {
    OptionComboGroupEditorUI.renderGroups(state, {
        addDays,
        updateDerivedValues,
        updateProbCharts,
        handleLiveSubscriptions,
        groupHasDeterministicCost,
        groupHasOpenPosition,
        getRenderableGroupViewMode: OptionComboSessionLogic.getRenderableGroupViewMode,
        isGroupIncludedInGlobal: OptionComboSessionLogic.isGroupIncludedInGlobal,
        supportsAmortizedMode(symbol) {
            return typeof OptionComboProductRegistry === 'undefined'
                ? true
                : OptionComboProductRegistry.supportsAmortizedMode(symbol);
        },
        supportsUnderlyingLegs(symbol) {
            return typeof OptionComboProductRegistry === 'undefined'
                ? true
                : OptionComboProductRegistry.supportsUnderlyingLegs(symbol);
        },
        requestPortfolioAvgCostSnapshot,
        requestContinueManagedComboOrder,
        requestConcedeManagedComboOrder,
        requestCancelManagedComboOrder,
        requestCloseGroupComboOrder,
        enterHistoricalReplayGroup,
        syncHistoricalReplayExpirySettlement,
        getUnderlyingProfile,
        generateId,
        renderGroups,
    });
}

// -------------------------------------------------------------
// Core Calculations
// -------------------------------------------------------------

function setGroupViewMode(btn, mode) {
    if (mode === 'amortized'
        && typeof OptionComboProductRegistry !== 'undefined'
        && !OptionComboProductRegistry.supportsAmortizedMode(state.underlyingSymbol)) {
        return;
    }

    const card = btn.closest('.group-card');
    if (!card) return;
    const groupId = card.dataset.groupId;
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return;

    const nextMode = OptionComboSessionLogic.resolveGroupViewModeChange(group, mode);
    if (nextMode === (group.viewMode || 'active')) return;
    group.viewMode = nextMode;

    // Trigger a full re-render of the group to handle complex visibility toggles.
    renderGroups();

    // Explicitly redraw charts related to this group.
    triggerChartRedraw(btn);
    updateProbCharts();
}

function applyHedgeDerivedData(derivedData) {
    OptionComboHedgeUI.applyHedgeDerivedData(derivedData, currencyFormatter);
}

function applyGroupDerivedData(card, groupResult) {
    OptionComboGroupUI.applyGroupDerivedData(card, groupResult, currencyFormatter, {
        drawGroupChart,
        drawAmortizationChart,
    });
}

function applyGlobalDerivedData(derivedData) {
    OptionComboGlobalUI.applyGlobalDerivedData(derivedData, currencyFormatter, {
        drawGlobalChart,
        drawGlobalAmortizedChart,
    });
}

function updateDerivedValues() {
    const derivedData = OptionComboValuation.computePortfolioDerivedData(state);

    if (typeof OptionComboSessionUI !== 'undefined'
        && typeof OptionComboSessionUI.syncWorkspaceChrome === 'function') {
        OptionComboSessionUI.syncWorkspaceChrome(state);
    }

    applyHedgeDerivedData(derivedData);

    document.querySelectorAll('.group-card').forEach(card => {
        const groupResult = derivedData.groupResultsById.get(card.dataset.groupId);
        if (!groupResult) return;
        applyGroupDerivedData(card, groupResult);
    });

    applyGlobalDerivedData(derivedData);
}

function settleHistoricalReplayGroups() {
    if (state.marketDataMode !== 'historical') {
        return 0;
    }

    let settledCount = 0;
    state.groups.forEach((group) => {
        if (requestCloseGroupComboOrder(group)) {
            settledCount += 1;
        }
    });

    return settledCount;
}

function enterHistoricalReplayGroup(group) {
    if (state.marketDataMode !== 'historical'
        || typeof requestHistoricalReplayEntryGroup !== 'function') {
        return false;
    }

    return requestHistoricalReplayEntryGroup(group);
}

function syncHistoricalReplayExpirySettlement(group) {
    if (state.marketDataMode !== 'historical'
        || typeof requestHistoricalReplayExpirySettlementSync !== 'function') {
        return false;
    }

    return requestHistoricalReplayExpirySettlementSync(group);
}

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
    const dataStr = JSON.stringify(OptionComboSessionLogic.buildExportState(state), null, 2);
    const saveBtn = document.getElementById('saveBtn');

    if (currentFileHandle && saveBtn) {
        try {
            const writable = await currentFileHandle.createWritable();
            await writable.write(dataStr);
            await writable.close();

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
    const dataStr = JSON.stringify(OptionComboSessionLogic.buildExportState(state), null, 2);
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

function applyImportedState(normalizedState, importedSessionTitle = '') {
    state.importedSessionTitle = String(importedSessionTitle || '').trim();
    state.underlyingSymbol = normalizedState.underlyingSymbol;
    state.underlyingContractMonth = normalizedState.underlyingContractMonth;
    state.underlyingPrice = normalizedState.underlyingPrice;
    state.baseDate = normalizedState.baseDate;
    state.simulatedDate = normalizedState.simulatedDate;
    state.marketDataMode = normalizedState.marketDataMode === 'historical' ? 'historical' : 'live';
    if (state.marketDataModeLocked === true) {
        state.marketDataMode = state.workspaceVariant === 'historical' ? 'historical' : 'live';
    }
    state.historicalQuoteDate = normalizedState.historicalQuoteDate
        || (state.marketDataMode === 'historical' ? (normalizedState.baseDate || normalizedState.simulatedDate || '') : '');
    state.historicalAvailableStartDate = '';
    state.historicalAvailableEndDate = '';
    state.interestRate = normalizedState.interestRate;
    state.ivOffset = normalizedState.ivOffset;
    state.allowLiveComboOrders = normalizedState.allowLiveComboOrders === true;
    if (state.marketDataMode !== 'live') {
        state.allowLiveComboOrders = false;
    }
    state.forwardRateSamples = normalizedState.forwardRateSamples || [];
    state.futuresPool = normalizedState.futuresPool || [];
    state.groups = normalizedState.groups;
    state.hedges = normalizedState.hedges;

    if (!state.underlyingContractMonth
        && typeof OptionComboProductRegistry !== 'undefined'
        && typeof OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth === 'function') {
        state.underlyingContractMonth = OptionComboProductRegistry.resolveDefaultUnderlyingContractMonth(
            state.underlyingSymbol,
            state.simulatedDate || state.baseDate
        );
    }
}

function processImportedFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const importedState = JSON.parse(e.target.result);

            if (importedState && typeof importedState === 'object') {
                const normalizedState = OptionComboSessionLogic.normalizeImportedState(
                    state,
                    importedState,
                    initialDateStr,
                    generateId,
                    addDays
                );

                applyImportedState(normalizedState, file && typeof file.name === 'string' ? file.name : '');
                OptionComboSessionUI.syncControlPanel(state, currencyFormatter, {
                    diffDays,
                    calendarToTradingDays,
                });

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

// WebSocket & Live Data Integration -> see ws_client.js
function calculateAmortizedCost(group, evalUnderlyingPrice, globalState) {
    return OptionComboAmortized.calculateAmortizedCost(group, evalUnderlyingPrice, globalState);
}

function calculateCombinedAmortizedCost(groups, globalState) {
    return OptionComboAmortized.calculateCombinedAmortizedCost(groups, globalState);
}

window.toggleGroupCollapse = OptionComboGroupEditorUI.toggleGroupCollapse;
