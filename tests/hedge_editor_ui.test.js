const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'hedge_editor_ui.js',
    tests: [
        {
            name: 'adds a default hedge row and triggers re-render',
            run() {
                const ctx = loadBrowserScripts(['js/hedge_editor_ui.js']);
                const state = { hedges: [] };
                let renderCalls = 0;
                let idCounter = 0;

                ctx.OptionComboHedgeEditorUI.addHedge(
                    state,
                    () => {
                        renderCalls += 1;
                    },
                    () => `hid_${++idCounter}`
                );

                assert.equal(state.hedges.length, 1);
                assert.equal(state.hedges[0].id, 'hid_1');
                assert.equal(state.hedges[0].symbol, 'UVXY');
                assert.equal(state.hedges[0].pos, -100);
                assert.equal(renderCalls, 1);
            },
        },
        {
            name: 'removes a hedge row by DOM button context',
            run() {
                const ctx = loadBrowserScripts(['js/hedge_editor_ui.js']);
                const state = {
                    hedges: [
                        { id: 'hedge_1' },
                        { id: 'hedge_2' },
                    ],
                };
                let renderCalls = 0;
                let subscriptionCalls = 0;

                ctx.OptionComboHedgeEditorUI.removeHedge(state, {
                    closest(selector) {
                        assert.equal(selector, '.hedge-row');
                        return {
                            dataset: { id: 'hedge_1' },
                        };
                    },
                }, {
                    handleLiveSubscriptions() {
                        subscriptionCalls += 1;
                    },
                    renderHedges() {
                        renderCalls += 1;
                    },
                });

                assert.deepEqual(state.hedges.map(hedge => hedge.id), ['hedge_2']);
                assert.equal(subscriptionCalls, 1);
                assert.equal(renderCalls, 1);
            },
        },
    ],
};
