/**
 * Group and leg editor rendering and event binding.
 */

(function attachGroupEditorUI(globalScope) {
    function addGroup(state, generateId, deps) {
        const newGroup = {
            id: generateId(),
            name: `Combo Group ${state.groups.length + 1}`,
            includedInGlobal: true,
            settleUnderlyingPrice: null,
            legs: []
        };

        state.groups.push(newGroup);
        addLegToGroupById(state, newGroup.id, generateId, deps);
    }

    function removeGroup(state, groupId, deps) {
        state.groups = state.groups.filter(group => group.id !== groupId);
        deps.handleLiveSubscriptions();
        deps.renderGroups();
    }

    function addLegToGroupById(state, groupId, generateId, deps) {
        const group = state.groups.find(entry => entry.id === groupId);
        if (!group) return;

        group.legs.push({
            id: generateId(),
            type: 'call',
            pos: 1,
            strike: state.underlyingPrice,
            expDate: deps.addDays(state.baseDate, 30),
            iv: 0.2,
            currentPrice: 0.00,
            cost: 0.00,
            closePrice: null
        });

        deps.renderGroups();
    }

    function addLegToGroup(state, buttonEl, generateId, deps) {
        const card = buttonEl.closest('.group-card');
        if (!card) return;

        addLegToGroupById(state, card.dataset.groupId, generateId, deps);
    }

    function removeLeg(state, groupId, legId, deps) {
        const group = state.groups.find(entry => entry.id === groupId);
        if (!group) return;

        group.legs = group.legs.filter(leg => leg.id !== legId);
        deps.handleLiveSubscriptions();
        deps.renderGroups();
    }

    function renderGroups(state, deps) {
        const container = document.getElementById('groupsContainer');
        const globalEmptyState = document.getElementById('globalEmptyState');
        const groupTemplate = document.getElementById('groupCardTemplate');
        const legTemplate = document.getElementById('legRowTemplate');
        if (!container || !globalEmptyState || !groupTemplate || !legTemplate) return;

        container.innerHTML = '';

        if (state.groups.length === 0) {
            globalEmptyState.style.display = 'block';
            document.getElementById('globalChartCard').style.display = 'none';
            document.getElementById('globalAmortizedCard').style.display = 'none';
            document.getElementById('probAnalysisCard').style.display = 'none';
            deps.updateDerivedValues();
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

            bindGroupHeader(card, group, state, deps);
            bindGroupLegs(card, group, state, legTemplate, deps);
            applyModeLockState(card, group, state, deps);

            container.appendChild(card);
        });

        deps.updateDerivedValues();
    }

    function bindGroupHeader(card, group, state, deps) {
        if (deps.supportsAmortizedMode
            && !deps.supportsAmortizedMode(state.underlyingSymbol)
            && group.viewMode === 'amortized') {
            group.viewMode = 'settlement';
        }

        const nameInput = card.querySelector('.group-name-input');
        nameInput.value = group.name;
        nameInput.addEventListener('change', (e) => {
            group.name = e.target.value;
        });

        const globalToggle = card.querySelector('.group-global-toggle');
        if (globalToggle) {
            globalToggle.checked = deps.isGroupIncludedInGlobal(group);
            globalToggle.addEventListener('change', (e) => {
                group.includedInGlobal = e.target.checked;
                deps.updateDerivedValues();
                if (typeof deps.updateProbCharts === 'function') {
                    deps.updateProbCharts();
                }
            });
        }

        const liveToggle = card.querySelector('.live-data-toggle');
        const statusSpan = liveToggle.parentElement.previousElementSibling;
        liveToggle.checked = !!group.liveData;
        statusSpan.textContent = group.liveData ? 'Live' : 'Offline';
        liveToggle.addEventListener('change', (e) => {
            group.liveData = e.target.checked;
            statusSpan.textContent = group.liveData ? 'Live' : 'Offline';
            deps.handleLiveSubscriptions();
        });

        applyViewModeState(card, group, deps.getRenderableGroupViewMode(group));

        const settleInput = card.querySelector('.group-settle-underlying-input');
        if (settleInput) {
            settleInput.value = group.settleUnderlyingPrice !== null && group.settleUnderlyingPrice !== undefined
                ? group.settleUnderlyingPrice.toFixed(2)
                : '';
            settleInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                group.settleUnderlyingPrice = isNaN(val) ? null : val;
                deps.updateDerivedValues();
            });
        }

        card.querySelector('.remove-group-btn').addEventListener('click', () => {
            removeGroup(state, group.id, deps);
        });
    }

    function bindGroupLegs(card, group, state, legTemplate, deps) {
        const tbody = card.querySelector('.legsTableBody');
        const table = card.querySelector('table');
        const emptyState = card.querySelector('.group-empty-state');

        if (group.legs.length === 0) {
            table.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }

        table.style.display = 'table';
        emptyState.style.display = 'none';

        group.legs.forEach(leg => {
            const legClone = legTemplate.content.cloneNode(true);
            const tr = legClone.querySelector('tr');
            tr.dataset.id = leg.id;

            bindLegRow(tr, leg, group, state, deps);
            tbody.appendChild(tr);
        });
    }

    function bindLegRow(tr, leg, group, state, deps) {
        const isStock = leg.type === 'stock';
        const supportsUnderlyingLegs = !deps.supportsUnderlyingLegs || deps.supportsUnderlyingLegs(state.underlyingSymbol);

        const typeInput = tr.querySelector('.type-input');
        typeInput.value = leg.type;
        const stockOption = Array.from(typeInput.options || []).find(option => option.value === 'stock');
        if (stockOption && !supportsUnderlyingLegs && leg.type !== 'stock') {
            stockOption.disabled = true;
            stockOption.hidden = true;
        }
        typeInput.addEventListener('change', (e) => {
            const wasStock = leg.type === 'stock';
            const nowStock = e.target.value === 'stock';
            leg.type = e.target.value;

            if (nowStock && !wasStock) {
                leg.strike = 0;
                leg.expDate = '';
                leg.iv = 0;
            } else if (!nowStock && wasStock) {
                leg.strike = state.underlyingPrice;
                leg.expDate = deps.addDays(state.baseDate, 30);
                leg.iv = 0.2;
            }

            deps.handleLiveSubscriptions();
            deps.renderGroups();
        });

        const posInput = tr.querySelector('.pos-input');
        posInput.value = leg.pos;
        posInput.addEventListener('input', (e) => {
            leg.pos = parseInt(e.target.value, 10) || 0;
            deps.updateDerivedValues();
        });

        const strikeInput = tr.querySelector('.strike-input');
        const dteInput = tr.querySelector('.dte-input');
        const ivInput = tr.querySelector('.iv-input');

        if (isStock) {
            strikeInput.style.visibility = 'hidden';
            dteInput.closest('div').style.visibility = 'hidden';
        } else {
            strikeInput.style.visibility = 'visible';
            dteInput.closest('div').style.visibility = 'visible';

            strikeInput.value = leg.strike;
            strikeInput.addEventListener('input', (e) => {
                leg.strike = parseFloat(e.target.value) || 0;
                deps.updateDerivedValues();
            });

            dteInput.value = leg.expDate;
            dteInput.addEventListener('change', (e) => {
                leg.expDate = e.target.value;
                deps.updateDerivedValues();
            });

            ivInput.value = (leg.iv * 100).toFixed(4) + '%';
            ivInput.addEventListener('change', (e) => {
                leg.iv = parseFloat(e.target.value) / 100.0 || 0.001;
                e.target.value = (leg.iv * 100).toFixed(4) + '%';
                deps.updateDerivedValues();
            });
        }

        const currentPriceInput = tr.querySelector('.current-price-input');
        currentPriceInput.value = leg.currentPrice > 0 ? leg.currentPrice.toFixed(2) : '';
        currentPriceInput.addEventListener('input', (e) => {
            leg.currentPrice = parseFloat(e.target.value) || 0;
            deps.updateDerivedValues();
        });

        const costInput = tr.querySelector('.cost-input');
        costInput.value = leg.cost > 0 ? leg.cost.toFixed(2) : '';
        costInput.addEventListener('input', (e) => {
            leg.cost = parseFloat(e.target.value) || 0;
            deps.updateDerivedValues();
        });

        const closePriceInput = tr.querySelector('.close-price-input');
        const closeLabel = tr.querySelector('.close-label');
        if (closePriceInput && closeLabel) {
            closePriceInput.style.display = 'block';
            closeLabel.style.display = 'block';
            closePriceInput.value = leg.closePrice !== null && leg.closePrice !== undefined
                ? leg.closePrice.toFixed(2)
                : '';
            closePriceInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                leg.closePrice = isNaN(val) ? null : val;
                deps.updateDerivedValues();
            });
        }

        tr.querySelector('.delete-btn').addEventListener('click', () => {
            removeLeg(state, group.id, leg.id, deps);
        });
    }

    function applyViewModeState(card, group, currentMode) {
        const toggleActiveBtn = card.querySelector('.toggle-view-active');
        const toggleTrialBtn = card.querySelector('.toggle-view-trial');
        const toggleAmortizedBtn = card.querySelector('.toggle-view-amortized');
        const toggleSettlementBtn = card.querySelector('.toggle-view-settlement');
        const settlementControls = card.querySelector('.settlement-controls');

        group.viewMode = currentMode;

        [toggleActiveBtn, toggleTrialBtn, toggleAmortizedBtn, toggleSettlementBtn].forEach(btn => {
            if (!btn) return;
            btn.classList.remove('active', 'btn-primary');
            btn.classList.add('btn-secondary');
        });

        if (currentMode === 'active' && toggleActiveBtn) {
            toggleActiveBtn.classList.remove('btn-secondary');
            toggleActiveBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'none';
            return;
        }

        if (currentMode === 'amortized' && toggleAmortizedBtn) {
            toggleAmortizedBtn.classList.remove('btn-secondary');
            toggleAmortizedBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'flex';
            return;
        }

        if (currentMode === 'settlement' && toggleSettlementBtn) {
            toggleSettlementBtn.classList.remove('btn-secondary');
            toggleSettlementBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'flex';
            return;
        }

        if (toggleTrialBtn) {
            toggleTrialBtn.classList.remove('btn-secondary');
            toggleTrialBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'none';
        }
    }

    function applyModeLockState(card, group, state, deps) {
        const currentMode = deps.getRenderableGroupViewMode(group);
        const supportsAmortizedMode = !deps.supportsAmortizedMode || deps.supportsAmortizedMode(state.underlyingSymbol);
        const toggleAmortizedBtn = card.querySelector('.toggle-view-amortized');

        if (!supportsAmortizedMode && toggleAmortizedBtn) {
            toggleAmortizedBtn.disabled = true;
            toggleAmortizedBtn.title = 'Amortized mode currently supports only equity-style deliverable underlyings.';
            toggleAmortizedBtn.classList.add('text-muted');
            toggleAmortizedBtn.style.opacity = '0.5';
        }

        if (deps.groupHasDeterministicCost(group) || currentMode === 'settlement') {
            return;
        }

        group.viewMode = 'trial';
        const toggleTrialBtn = card.querySelector('.toggle-view-trial');
        const toggleActiveBtn = card.querySelector('.toggle-view-active');

        if (!toggleTrialBtn || !toggleActiveBtn || !toggleAmortizedBtn) return;

        toggleActiveBtn.disabled = true;
        toggleActiveBtn.title = 'Add a Cost to unlock Active tracking.';
        toggleActiveBtn.classList.add('text-muted');
        toggleActiveBtn.style.opacity = '0.5';

        toggleAmortizedBtn.disabled = true;
        toggleAmortizedBtn.title = 'Add a Cost to unlock Amortized analysis.';
        toggleAmortizedBtn.classList.add('text-muted');
        toggleAmortizedBtn.style.opacity = '0.5';

        toggleTrialBtn.classList.add('active', 'btn-primary');
        toggleTrialBtn.classList.remove('btn-secondary');
        toggleActiveBtn.classList.remove('active', 'btn-primary');
        toggleActiveBtn.classList.add('btn-secondary');
        toggleAmortizedBtn.classList.remove('active', 'btn-primary');
        toggleAmortizedBtn.classList.add('btn-secondary');
    }

    globalScope.OptionComboGroupEditorUI = {
        addGroup,
        removeGroup,
        addLegToGroupById,
        addLegToGroup,
        removeLeg,
        renderGroups,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
