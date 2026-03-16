const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'group_editor_ui.js',
    tests: [
        {
            name: 'adds a group with one default leg and triggers a re-render',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const state = {
                    underlyingPrice: 432.1,
                    baseDate: '2026-03-15',
                    groups: [],
                };
                let renderCalls = 0;
                let idCounter = 0;
                const nextId = () => `id_${++idCounter}`;

                ctx.OptionComboGroupEditorUI.addGroup(state, nextId, {
                    addDays(dateStr, days) {
                        assert.equal(dateStr, '2026-03-15');
                        assert.equal(days, 30);
                        return '2026-04-14';
                    },
                    renderGroups() {
                        renderCalls += 1;
                    },
                });

                assert.equal(state.groups.length, 1);
                assert.equal(state.groups[0].name, 'Combo Group 1');
                assert.equal(state.groups[0].legs.length, 1);
                assert.equal(state.groups[0].legs[0].strike, 432.1);
                assert.equal(state.groups[0].legs[0].expDate, '2026-04-14');
                assert.equal(renderCalls, 1);
            },
        },
        {
            name: 'removes a leg and triggers live-subscription refresh',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const state = {
                    groups: [{
                        id: 'group_1',
                        legs: [
                            { id: 'leg_1' },
                            { id: 'leg_2' },
                        ],
                    }],
                };
                let renderCalls = 0;
                let subscriptionCalls = 0;

                ctx.OptionComboGroupEditorUI.removeLeg(state, 'group_1', 'leg_1', {
                    handleLiveSubscriptions() {
                        subscriptionCalls += 1;
                    },
                    renderGroups() {
                        renderCalls += 1;
                    },
                });

                assert.deepEqual(state.groups[0].legs.map(leg => leg.id), ['leg_2']);
                assert.equal(subscriptionCalls, 1);
                assert.equal(renderCalls, 1);
            },
        },
    ],
};
