/**
 * Hedge editor rendering and event binding.
 */

(function attachHedgeEditorUI(globalScope) {
    function addHedge(state, renderHedges, generateId) {
        state.hedges.push({
            id: generateId(),
            symbol: 'UVXY',
            pos: -100,
            cost: 25.00,
            currentPrice: 0.00,
            liveData: false
        });
        renderHedges();
    }

    function removeHedge(state, buttonEl, deps) {
        const row = buttonEl.closest('.hedge-row');
        if (!row) return;

        state.hedges = state.hedges.filter(hedge => hedge.id !== row.dataset.id);
        deps.handleLiveSubscriptions();
        deps.renderHedges();
    }

    function renderHedges(state, deps) {
        const tbody = document.getElementById('hedgesTableBody');
        const emptyState = document.getElementById('hedgeEmptyState');
        const template = document.getElementById('hedgeRowTemplate');
        if (!tbody || !emptyState || !template) return;

        tbody.innerHTML = '';

        if (state.hedges.length === 0) {
            tbody.parentElement.style.display = 'none';
            emptyState.style.display = 'block';
            deps.updateDerivedValues();
            return;
        }

        tbody.parentElement.style.display = 'table';
        emptyState.style.display = 'none';

        state.hedges.forEach(hedge => {
            const clone = template.content.cloneNode(true);
            const tr = clone.querySelector('.hedge-row');
            tr.dataset.id = hedge.id;

            const symInput = tr.querySelector('.symbol-input');
            symInput.value = hedge.symbol;
            symInput.addEventListener('change', (e) => {
                hedge.symbol = e.target.value.toUpperCase();
                e.target.value = hedge.symbol;
                deps.handleLiveSubscriptions();
                deps.updateDerivedValues();
            });

            const cpInput = tr.querySelector('.current-price-input');
            cpInput.value = hedge.currentPrice > 0 ? hedge.currentPrice.toFixed(2) : '';
            cpInput.addEventListener('input', (e) => {
                hedge.currentPrice = parseFloat(e.target.value) || 0;
                deps.updateDerivedValues();
            });

            const posInput = tr.querySelector('.pos-input');
            posInput.value = hedge.pos;
            posInput.addEventListener('input', (e) => {
                hedge.pos = parseInt(e.target.value, 10) || 0;
                deps.updateDerivedValues();
            });

            const costInput = tr.querySelector('.cost-input');
            costInput.value = hedge.cost.toFixed(2);
            costInput.addEventListener('input', (e) => {
                hedge.cost = parseFloat(e.target.value) || 0;
                deps.updateDerivedValues();
            });

            const liveToggle = tr.querySelector('.live-data-toggle');
            liveToggle.checked = hedge.liveData;
            liveToggle.addEventListener('change', (e) => {
                hedge.liveData = e.target.checked;
                deps.handleLiveSubscriptions();
            });

            tbody.appendChild(tr);
        });

        deps.updateDerivedValues();
    }

    globalScope.OptionComboHedgeEditorUI = {
        addHedge,
        removeHedge,
        renderHedges,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
