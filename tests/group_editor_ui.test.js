const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'group_editor_ui.js',
    tests: [
        {
            name: 'exposes collapse toggle through both module and global entry points',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);

                assert.equal(typeof ctx.OptionComboGroupEditorUI.toggleGroupCollapse, 'function');
                assert.equal(ctx.toggleGroupCollapse, ctx.OptionComboGroupEditorUI.toggleGroupCollapse);
            },
        },
        {
            name: 'adds a group with one default leg and triggers a re-render',
            run() {
                const ctx = loadBrowserScripts(['js/group_order_builder.js', 'js/trade_trigger_logic.js', 'js/group_editor_ui.js']);
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
                assert.equal(state.groups[0].isCollapsed, false);
                assert.equal(state.groups[0].syncAvgCostFromPortfolio, true);
                assert.equal(state.groups[0].tradeTrigger.enabled, false);
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
        {
            name: 're-enables active mode toggle once deterministic costs exist',
            run() {
                const ctx = loadBrowserScripts([
                    'js/group_editor_ui.js',
                ], {
                    document: {
                        getElementById() { return null; },
                    },
                });

                const activeBtn = {
                    disabled: true,
                    title: 'Add a Cost to unlock Active tracking.',
                    classList: {
                        remove() {},
                        add() {},
                    },
                    style: { opacity: '0.5' },
                };
                const trialBtn = {
                    disabled: false,
                    title: '',
                    classList: {
                        remove() {},
                        add() {},
                    },
                    style: {},
                };
                const amortizedBtn = {
                    disabled: true,
                    title: 'Add a Cost to unlock Amortized analysis.',
                    classList: {
                        remove() {},
                        add() {},
                    },
                    style: { opacity: '0.5' },
                };
                const settlementBtn = {
                    disabled: false,
                    title: '',
                    classList: {
                        remove() {},
                        add() {},
                    },
                    style: {},
                };

                const card = {
                    querySelector(selector) {
                        return {
                            '.toggle-view-active': activeBtn,
                            '.toggle-view-trial': trialBtn,
                            '.toggle-view-amortized': amortizedBtn,
                            '.toggle-view-settlement': settlementBtn,
                        }[selector] || null;
                    },
                };

                const group = {
                    viewMode: 'active',
                    legs: [{ cost: 1 }],
                };
                const deps = {
                    getRenderableGroupViewMode() { return 'active'; },
                    supportsAmortizedMode() { return true; },
                    groupHasDeterministicCost() { return true; },
                };

                ctx.OptionComboGroupEditorUI.applyModeLockState(card, group, { underlyingSymbol: 'SPY' }, deps);

                assert.equal(activeBtn.disabled, false);
                assert.equal(activeBtn.title, '');
                assert.equal(activeBtn.style.opacity, '');
                assert.equal(amortizedBtn.disabled, false);
                assert.equal(amortizedBtn.title, '');
                assert.equal(amortizedBtn.style.opacity, '');
            },
        },
        {
            name: 'locks trigger price editing while trial trigger is enabled',
            run() {
                const ctx = loadBrowserScripts([
                    'js/group_order_builder.js',
                    'js/trade_trigger_logic.js',
                    'js/group_editor_ui.js',
                ]);

                const noop = () => {};
                const listeners = {};
                const container = {
                    querySelector(selector) {
                        return {
                            '.trial-trigger-enabled': enabledInput,
                            '.trial-trigger-collapse-btn': collapseBtn,
                            '.trial-trigger-condition': conditionInput,
                            '.trial-trigger-price': priceInput,
                            '.trial-trigger-execution-mode': executionModeInput,
                            '.trial-trigger-reprice-threshold': repriceThresholdInput,
                            '.trial-trigger-tif': timeInForceInput,
                            '.trial-trigger-exit-enabled': exitEnabledInput,
                            '.trial-trigger-exit-condition': exitConditionInput,
                            '.trial-trigger-exit-price': exitPriceInput,
                            '.trial-trigger-reset-btn': resetBtn,
                            '.trial-trigger-body': body,
                        }[selector] || null;
                    },
                    addEventListener(type, handler) {
                        listeners[type] = handler;
                    },
                };
                const enabledInput = { checked: false, addEventListener: noop };
                const collapseBtn = { title: '', setAttribute: noop, addEventListener: noop };
                const conditionInput = { value: '', addEventListener: noop };
                const priceInput = { value: '', disabled: false, title: '', addEventListener: noop };
                const executionModeInput = { value: '', title: '', addEventListener: noop };
                const repriceThresholdInput = { value: '', addEventListener: noop };
                const timeInForceInput = { value: '', addEventListener: noop };
                const exitEnabledInput = { checked: false, disabled: false, addEventListener: noop };
                const exitConditionInput = { value: '', disabled: false, addEventListener: noop };
                const exitPriceInput = { value: '', disabled: false, title: '', addEventListener: noop };
                const resetBtn = { addEventListener: noop };
                const body = { style: {} };
                const card = {
                    querySelector(selector) {
                        if (selector === '.trial-trigger-container') return container;
                        return null;
                    },
                };
                const group = {
                    tradeTrigger: {
                        enabled: true,
                        condition: 'gte',
                        price: 672,
                        executionMode: 'submit',
                        repriceThreshold: 0.02,
                        timeInForce: 'GTC',
                        exitEnabled: true,
                        exitCondition: 'lte',
                        exitPrice: 671,
                        isCollapsed: false,
                        status: 'armed',
                    },
                };

                ctx.OptionComboGroupEditorUI.bindTrialTriggerControls(card, group, { allowLiveComboOrders: true }, {
                    renderGroups() {},
                });

                assert.equal(priceInput.disabled, true);
                assert.match(priceInput.title, /disable trial trigger/i);
                assert.equal(repriceThresholdInput.value, '0.02');
                assert.equal(timeInForceInput.value, 'GTC');
                assert.equal(exitEnabledInput.checked, true);
                assert.equal(exitConditionInput.value, 'lte');
                assert.equal(exitPriceInput.value, '671.00');
            },
        },
        {
            name: 'continues managed repricing on pointerdown to survive live rerenders',
            run() {
                const ctx = loadBrowserScripts([
                    'js/group_order_builder.js',
                    'js/trade_trigger_logic.js',
                    'js/group_editor_ui.js',
                ]);

                const noop = () => {};
                const listeners = {};
                const container = {
                    querySelector(selector) {
                        return {
                            '.trial-trigger-enabled': enabledInput,
                            '.trial-trigger-collapse-btn': collapseBtn,
                            '.trial-trigger-condition': conditionInput,
                            '.trial-trigger-price': priceInput,
                            '.trial-trigger-execution-mode': executionModeInput,
                            '.trial-trigger-reprice-threshold': repriceThresholdInput,
                            '.trial-trigger-tif': timeInForceInput,
                            '.trial-trigger-exit-enabled': exitEnabledInput,
                            '.trial-trigger-exit-condition': exitConditionInput,
                            '.trial-trigger-exit-price': exitPriceInput,
                            '.trial-trigger-reset-btn': resetBtn,
                            '.trial-trigger-body': body,
                        }[selector] || null;
                    },
                    addEventListener(type, handler) {
                        listeners[type] = handler;
                    },
                };
                const enabledInput = { checked: false, addEventListener: noop };
                const collapseBtn = { title: '', setAttribute: noop, addEventListener: noop };
                const conditionInput = { value: '', addEventListener: noop };
                const priceInput = { value: '', disabled: false, title: '', addEventListener: noop };
                const executionModeInput = { value: '', title: '', addEventListener: noop };
                const repriceThresholdInput = { value: '', addEventListener: noop };
                const timeInForceInput = { value: '', addEventListener: noop };
                const exitEnabledInput = { checked: false, disabled: false, addEventListener: noop };
                const exitConditionInput = { value: '', disabled: false, addEventListener: noop };
                const exitPriceInput = { value: '', disabled: false, title: '', addEventListener: noop };
                const resetBtn = { addEventListener: noop };
                const body = { style: {} };
                const card = {
                    querySelector(selector) {
                        if (selector === '.trial-trigger-container') return container;
                        return null;
                    },
                };
                const group = {
                    tradeTrigger: {
                        enabled: false,
                        condition: 'gte',
                        price: 672,
                        executionMode: 'submit',
                        repriceThreshold: 0.01,
                        timeInForce: 'DAY',
                        exitEnabled: false,
                        exitCondition: 'lte',
                        exitPrice: null,
                        isCollapsed: false,
                        status: 'submitted',
                        lastPreview: {
                            orderId: 2096,
                        },
                    },
                };
                let continueCalls = 0;

                ctx.OptionComboGroupEditorUI.bindTrialTriggerControls(card, group, { allowLiveComboOrders: true }, {
                    renderGroups() {},
                    requestContinueManagedComboOrder() {
                        continueCalls += 1;
                    },
                });

                listeners.pointerdown({
                    target: {
                        closest(selector) {
                            return selector === '.trial-trigger-continue-repricing-btn' ? {} : null;
                        },
                    },
                    preventDefault() {},
                });

                assert.equal(continueCalls, 1);
            },
        },
        {
            name: 'requests managed order cancellation from the action area',
            run() {
                const ctx = loadBrowserScripts([
                    'js/group_order_builder.js',
                    'js/trade_trigger_logic.js',
                    'js/group_editor_ui.js',
                ]);

                const noop = () => {};
                const listeners = {};
                const container = {
                    querySelector(selector) {
                        return {
                            '.trial-trigger-enabled': enabledInput,
                            '.trial-trigger-collapse-btn': collapseBtn,
                            '.trial-trigger-condition': conditionInput,
                            '.trial-trigger-price': priceInput,
                            '.trial-trigger-execution-mode': executionModeInput,
                            '.trial-trigger-reprice-threshold': repriceThresholdInput,
                            '.trial-trigger-tif': timeInForceInput,
                            '.trial-trigger-exit-enabled': exitEnabledInput,
                            '.trial-trigger-exit-condition': exitConditionInput,
                            '.trial-trigger-exit-price': exitPriceInput,
                            '.trial-trigger-reset-btn': resetBtn,
                            '.trial-trigger-body': body,
                        }[selector] || null;
                    },
                    addEventListener(type, handler) {
                        listeners[type] = handler;
                    },
                };
                const enabledInput = { checked: false, addEventListener: noop };
                const collapseBtn = { title: '', setAttribute: noop, addEventListener: noop };
                const conditionInput = { value: '', addEventListener: noop };
                const priceInput = { value: '', disabled: false, title: '', addEventListener: noop };
                const executionModeInput = { value: '', title: '', addEventListener: noop };
                const repriceThresholdInput = { value: '', addEventListener: noop };
                const timeInForceInput = { value: '', addEventListener: noop };
                const exitEnabledInput = { checked: false, disabled: false, addEventListener: noop };
                const exitConditionInput = { value: '', disabled: false, addEventListener: noop };
                const exitPriceInput = { value: '', disabled: false, title: '', addEventListener: noop };
                const resetBtn = { addEventListener: noop };
                const body = { style: {} };
                const card = {
                    querySelector(selector) {
                        if (selector === '.trial-trigger-container') return container;
                        return null;
                    },
                };
                const group = {
                    tradeTrigger: {
                        enabled: false,
                        condition: 'gte',
                        price: 672,
                        executionMode: 'submit',
                        repriceThreshold: 0.01,
                        timeInForce: 'DAY',
                        exitEnabled: false,
                        exitCondition: 'lte',
                        exitPrice: null,
                        isCollapsed: false,
                        status: 'submitted',
                        lastPreview: {
                            orderId: 2187,
                        },
                    },
                };
                let cancelCalls = 0;

                ctx.OptionComboGroupEditorUI.bindTrialTriggerControls(card, group, { allowLiveComboOrders: true }, {
                    renderGroups() {},
                    requestCancelManagedComboOrder() {
                        cancelCalls += 1;
                    },
                });

                listeners.pointerdown({
                    target: {
                        closest(selector) {
                            return selector === '.trial-trigger-cancel-order-btn' ? {} : null;
                        },
                    },
                    preventDefault() {},
                });

                assert.equal(cancelCalls, 1);
            },
        },
    ],
};
