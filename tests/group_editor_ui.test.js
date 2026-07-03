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
            name: 'adds an empty group and triggers a re-render',
            run() {
                const ctx = loadBrowserScripts(['js/group_order_builder.js', 'js/trade_trigger_logic.js', 'js/session_logic.js', 'js/group_editor_ui.js']);
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
                        throw new Error(`addDays should not run for an empty group: ${dateStr}, ${days}`);
                    },
                    renderGroups() {
                        renderCalls += 1;
                    },
                });

                assert.equal(state.groups.length, 1);
                assert.equal(state.groups[0].name, 'Combo Group 1');
                assert.equal(state.groups[0].isCollapsed, false);
                assert.equal(state.groups[0].syncAvgCostFromPortfolio, true);
                assert.equal(state.groups[0].livePriceMode, 'midpoint');
                assert.equal(state.groups[0].historicalAutoCloseAtExpiry, true);
                assert.equal(state.groups[0].tradeTrigger.enabled, false);
                assert.equal(state.groups[0].legs.length, 0);
                assert.equal(renderCalls, 1);
            },
        },
        {
            name: 'uses the selected simulated date as the default expiration for new legs',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const state = {
                    underlyingPrice: 432.1,
                    underlyingSymbol: 'SPY',
                    baseDate: '2026-03-15',
                    simulatedDate: '2026-04-19',
                    groups: [{ id: 'group_1', legs: [] }],
                };
                let renderCalls = 0;
                let idCounter = 0;

                ctx.OptionComboGroupEditorUI.addLegToGroupById(state, 'group_1', () => `leg_${++idCounter}`, {
                    addDays() {
                        throw new Error('addDays should not be used after the global simulated date changes');
                    },
                    renderGroups() {
                        renderCalls += 1;
                    },
                });

                assert.equal(state.groups[0].legs.length, 1);
                assert.equal(state.groups[0].legs[0].expDate, '2026-04-19');
                assert.equal(state.groups[0].legs[0].type, 'call');
                assert.equal(state.groups[0].legs[0].underlyingFutureId, '');
                assert.equal(renderCalls, 1);
            },
        },
        {
            name: 'uses the visible simulated date input when state has not synced yet',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js'], {
                    document: {
                        getElementById(id) {
                            return id === 'simulatedDate'
                                ? { value: '2026-05-22' }
                                : null;
                        },
                    },
                });
                const state = {
                    baseDate: '2026-03-15',
                    simulatedDate: '2026-03-15',
                };

                const expDate = ctx.OptionComboGroupEditorUI.resolveDefaultLegExpirationDate(state, {
                    addDays() {
                        throw new Error('selected DOM date should be preferred over baseDate + 30');
                    },
                });

                assert.equal(expDate, '2026-05-22');
            },
        },
        {
            name: 'builds expected legs for all typical combo strategies',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js'], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(id) {
                            const quotes = {
                                combo_template_SPY_20260419_P_430: { bid: 0.75, ask: 0.85 },
                                combo_template_SPY_20260419_P_435: { bid: 2.45, ask: 2.55 },
                                combo_template_SPY_20260419_C_435: { bid: 2.25, ask: 2.35 },
                                combo_template_SPY_20260419_C_440: { bid: 0.95, ask: 1.05 },
                            };
                            return quotes[id] || null;
                        },
                    },
                });
                const state = {
                    underlyingPrice: 432.1,
                    underlyingSymbol: 'SPY',
                    baseDate: '2026-03-15',
                    simulatedDate: '2026-04-19',
                    comboTemplateQuoteRequests: [{ id: 'temporary_quote' }],
                };
                const cases = [
                    {
                        strategy: 'bull_spread',
                        expected: [
                            ['call', 1, 430, '2026-04-19'],
                            ['call', -1, 440, '2026-04-19'],
                        ],
                    },
                    {
                        strategy: 'bear_spread',
                        expected: [
                            ['put', 1, 440, '2026-04-19'],
                            ['put', -1, 430, '2026-04-19'],
                        ],
                    },
                    {
                        strategy: 'straddle',
                        expected: [
                            ['call', 1, 435, '2026-04-19'],
                            ['put', 1, 435, '2026-04-19'],
                        ],
                    },
                    {
                        strategy: 'strangle',
                        expected: [
                            ['put', 1, 430, '2026-04-19'],
                            ['call', 1, 440, '2026-04-19'],
                        ],
                    },
                    {
                        strategy: 'butterfly',
                        expected: [
                            ['put', 1, 430, '2026-04-19'],
                            ['put', -1, 435, '2026-04-19'],
                            ['call', -1, 435, '2026-04-19'],
                            ['call', 1, 440, '2026-04-19'],
                        ],
                    },
                ];

                cases.forEach((testCase) => {
                    const group = { id: `group_${testCase.strategy}`, legs: [] };
                    let renderCalls = 0;
                    let subscriptionCalls = 0;
                    let idCounter = 0;

                    const result = ctx.OptionComboGroupEditorUI.applyComboTemplateToGroup(group, state, {
                        generateId() {
                            return `leg_${++idCounter}`;
                        },
                        addDays() {
                            throw new Error('template should default to the selected simulated date');
                        },
                        handleLiveSubscriptions() {
                            subscriptionCalls += 1;
                        },
                        renderGroups() {
                            renderCalls += 1;
                        },
                    }, {
                        strategy: testCase.strategy,
                        lowerStrike: 430,
                        middleStrike: 435,
                        upperStrike: 440,
                    });

                    assert.equal(result.success, true, testCase.strategy);
                    assert.equal(result.legCount, testCase.expected.length, testCase.strategy);
                    const legSummary = JSON.parse(JSON.stringify(
                        group.legs.map(leg => [leg.type, leg.pos, leg.strike, leg.expDate])
                    ));
                    assert.deepEqual(legSummary, testCase.expected, testCase.strategy);
                    assert.equal(subscriptionCalls, 1, testCase.strategy);
                    assert.equal(renderCalls, 1, testCase.strategy);
                    assert.equal(state.comboTemplateQuoteRequests.length, 0, testCase.strategy);
                    if (testCase.strategy === 'butterfly') {
                        assert.equal(group.comboTemplate.strategy, 'butterfly');
                        assert.equal(group.comboTemplate.wingWidth, 5);
                        assert.equal(group.comboTemplate.risk.maxProfit, 3);
                        assert.equal(group.comboTemplate.risk.maxLoss, 2);
                        assert.equal(group.comboTemplate.risk.profitLossRatio, 1.5);
                        assert.equal(group.liveData, true, 'butterfly template should enable market data');
                    } else {
                        assert.equal(!!group.liveData, false, testCase.strategy);
                    }
                });
            },
        },
        {
            name: 'calculates iron butterfly max profit to max loss ratio from leg prices',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);

                const risk = ctx.OptionComboGroupEditorUI._test.calculateButterflyRiskFromLegPrices({
                    lowerPut: 0.8,
                    middlePut: 2.5,
                    middleCall: 2.3,
                    upperCall: 1.0,
                }, 5);

                assert.equal(risk.maxProfit, 3);
                assert.equal(risk.maxLoss, 2);
                assert.equal(risk.profitLossRatio, 1.5);
            },
        },
        {
            name: 'builds a dense butterfly candidate grid around the middle strike',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const state = { underlyingPrice: 7558, underlyingSymbol: 'ES' };

                const candidates = ctx.OptionComboGroupEditorUI._test.buildButterflyCandidateGrid(
                    state, '2026-07-24', 7550, null
                );

                assert.ok(candidates.length > 0);
                const middles = new Set(candidates.map((candidate) => candidate.middle));
                const widths = new Set(candidates.map((candidate) => candidate.wingWidth));
                // Middle strike shifts up to +-2 increments (increment 25 at this price).
                assert.deepEqual(Array.from(middles).sort((a, b) => a - b), [7500, 7525, 7550, 7575, 7600]);
                // Widths cover every strike increment, including gaps between the
                // old presets (e.g. 125 and 175 between 100/150/200).
                assert.ok(widths.has(125));
                assert.ok(widths.has(175));
                candidates.forEach((candidate) => {
                    assert.ok(candidate.lower < candidate.middle && candidate.middle < candidate.upper);
                });
                // Deduped strike combos, bounded quote subscriptions.
                const strikeKeys = new Set(candidates.map((c) => `${c.lower}:${c.middle}:${c.upper}`));
                assert.equal(strikeKeys.size, candidates.length);
                const quoteIds = new Set();
                candidates.forEach((candidate) => {
                    candidate.quoteRequests.forEach((request) => quoteIds.add(request.id));
                });
                assert.ok(quoteIds.size <= 48, `quote subscriptions ${quoteIds.size} should stay bounded`);
            },
        },
        {
            name: 'chooses the candidate whose quote-based ratio is nearest the target',
            run() {
                const quotes = {
                    // Candidate A: credit 109.875, width 150 -> ratio ~2.739
                    'A_P_LO': { bid: 60, ask: 62 },
                    'A_P_MID': { bid: 115, ask: 117 },
                    'A_C_MID': { bid: 115, ask: 117 },
                    'A_C_UP': { bid: 60.125, ask: 62.125 },
                    // Candidate B: credit 130, width 175 -> ratio ~2.889
                    'B_P_LO': { bid: 54, ask: 56 },
                    'B_P_MID': { bid: 119, ask: 121 },
                    'B_C_MID': { bid: 119, ask: 121 },
                    'B_C_UP': { bid: 54, ask: 56 },
                };
                const ctx = loadBrowserScripts(['js/group_editor_ui.js'], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(id) {
                            return quotes[id] || null;
                        },
                    },
                });
                const makeCandidate = (prefix, lower, middle, upper, wingWidth) => ({
                    lower,
                    middle,
                    upper,
                    wingWidth,
                    quoteRequests: [
                        { id: `${prefix}_P_LO`, type: 'put', strike: lower },
                        { id: `${prefix}_P_MID`, type: 'put', strike: middle },
                        { id: `${prefix}_C_MID`, type: 'call', strike: middle },
                        { id: `${prefix}_C_UP`, type: 'call', strike: upper },
                    ],
                });
                const candidates = [
                    makeCandidate('A', 7400, 7550, 7700, 150),
                    makeCandidate('B', 7375, 7550, 7725, 175),
                ];

                const selected = ctx.OptionComboGroupEditorUI._test.chooseButterflyCandidate(candidates, '3');

                assert.equal(selected.wingWidth, 175);
                assert.ok(Math.abs(selected.risk.profitLossRatio - 2.889) < 0.01);
            },
        },
        {
            name: 'collapses butterfly quote rows to one sorted row per strike',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const makeCandidate = (wingWidth, lower, middle, upper) => ({
                    wingWidth,
                    lower,
                    middle,
                    upper,
                    quoteRequests: [
                        { id: `P_${lower}`, type: 'put', strike: lower },
                        { id: `P_${middle}`, type: 'put', strike: middle },
                        { id: `C_${middle}`, type: 'call', strike: middle },
                        { id: `C_${upper}`, type: 'call', strike: upper },
                    ],
                });

                const rows = ctx.OptionComboGroupEditorUI._test.collectButterflyQuoteRows([
                    makeCandidate(50, 7500, 7550, 7600),
                    makeCandidate(25, 7525, 7550, 7575),
                    makeCandidate(75, 7475, 7550, 7625),
                ]);
                const strikeOrder = JSON.parse(JSON.stringify(rows.map(row => row.strike)));

                // Strikes shared by several candidates appear exactly once.
                assert.deepEqual(strikeOrder, [
                    7475,
                    7500,
                    7525,
                    7550,
                    7575,
                    7600,
                    7625,
                ]);
                const middleRow = rows.find(row => row.strike === 7550);
                assert.equal(middleRow.putRequest.id, 'P_7550');
                assert.equal(middleRow.callRequest.id, 'C_7550');
                const lowerRow = rows.find(row => row.strike === 7475);
                assert.equal(lowerRow.putRequest.id, 'P_7475');
                assert.equal(lowerRow.callRequest, null);
                const upperRow = rows.find(row => row.strike === 7625);
                assert.equal(upperRow.putRequest, null);
                assert.equal(upperRow.callRequest.id, 'C_7625');
            },
        },
        {
            name: 'simulates a trial open by copying current quotes into entry costs',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js'], {
                    OptionComboWsLiveQuotes: {
                        getOptionQuote(id) {
                            return id === 'leg_call'
                                ? { bid: 2.30, ask: 2.50 }
                                : null;
                        },
                    },
                });
                const group = {
                    id: 'group_sim_open',
                    viewMode: 'trial',
                    livePriceMode: 'midpoint',
                    syncAvgCostFromPortfolio: true,
                    tradeTrigger: {
                        enabled: true,
                        pendingRequest: false,
                        status: 'armed',
                        lastPreview: { status: 'previewed' },
                        lastError: '',
                    },
                    legs: [
                        { id: 'leg_call', type: 'call', pos: 1, cost: 0, currentPrice: 0, currentPriceSource: '', closePrice: null },
                        { id: 'leg_put', type: 'put', pos: -1, cost: 0, currentPrice: 1.15, currentPriceSource: 'manual', closePrice: null },
                    ],
                };
                let renderCalls = 0;

                const result = ctx.OptionComboGroupEditorUI.simulateOpenGroup(group, { marketDataMode: 'live' }, {
                    renderGroups() {
                        renderCalls += 1;
                    },
                });

                assert.equal(result.success, true);
                assert.equal(result.updatedLegCount, 2);
                assert.equal(group.viewMode, 'active');
                assert.equal(group.syncAvgCostFromPortfolio, false);
                assert.equal(group.tradeTrigger.enabled, false);
                assert.equal(group.tradeTrigger.status, 'idle');
                assert.equal(group.tradeTrigger.lastPreview, null);
                assert.equal(group.legs[0].cost, 2.4);
                assert.equal(group.legs[0].costSource, 'simulated_open');
                assert.equal(group.legs[0].simulatedOpenPriceSource, 'live_midpoint');
                assert.equal(group.legs[0].executionReportedCost, false);
                assert.equal(group.legs[1].cost, 1.15);
                assert.equal(group.legs[1].costSource, 'simulated_open');
                assert.equal(group.legs[1].simulatedOpenPriceSource, 'manual');
                assert.equal(renderCalls, 1);
            },
        },
        {
            name: 'does not partially simulate an open when any open leg lacks a quote',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const group = {
                    id: 'group_sim_open_missing',
                    viewMode: 'trial',
                    legs: [
                        { id: 'leg_call', type: 'call', pos: 1, cost: 0, currentPrice: 2.1, currentPriceSource: 'manual', closePrice: null },
                        { id: 'leg_put', type: 'put', pos: -1, cost: 0, currentPrice: 0, currentPriceSource: 'missing', closePrice: null },
                    ],
                };
                let renderCalls = 0;

                const result = ctx.OptionComboGroupEditorUI.simulateOpenGroup(group, { marketDataMode: 'live' }, {
                    renderGroups() {
                        renderCalls += 1;
                    },
                });

                assert.equal(result.success, false);
                assert.match(result.reason, /current quote/i);
                assert.equal(group.viewMode, 'trial');
                assert.equal(group.legs[0].cost, 0);
                assert.equal(group.legs[1].cost, 0);
                assert.equal(renderCalls, 0);
            },
        },
        {
            name: 'keeps simulated open hidden in historical replay mode',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const group = {
                    id: 'group_hist_sim_open',
                    viewMode: 'trial',
                    legs: [
                        { id: 'leg_call', type: 'call', pos: 1, cost: 0, currentPrice: 2.1, currentPriceSource: 'historical', closePrice: null },
                    ],
                };

                const state = ctx.OptionComboGroupEditorUI.describeSimulatedOpenState(
                    group,
                    { marketDataMode: 'historical' },
                    'trial'
                );

                assert.equal(state.visible, false);
                assert.match(state.reason, /Enter @ Replay Day/i);
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
            name: 'moves a group to the top and re-renders once',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const state = {
                    groups: [
                        { id: 'group_1', name: 'First' },
                        { id: 'group_2', name: 'Second' },
                        { id: 'group_3', name: 'Third' },
                    ],
                };
                let renderCalls = 0;

                const moved = ctx.OptionComboGroupEditorUI.moveGroupToTop(state, 'group_3', {
                    renderGroups() {
                        renderCalls += 1;
                    },
                });

                assert.equal(moved, true);
                assert.deepEqual(state.groups.map(group => group.id), ['group_3', 'group_1', 'group_2']);
                assert.equal(renderCalls, 1);
            },
        },
        {
            name: 'moves groups up and down without re-rendering when already at the edge',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);
                const state = {
                    groups: [
                        { id: 'group_1', name: 'First' },
                        { id: 'group_2', name: 'Second' },
                        { id: 'group_3', name: 'Third' },
                    ],
                };
                let renderCalls = 0;

                const movedUp = ctx.OptionComboGroupEditorUI.moveGroupByOffset(state, 'group_2', -1, {
                    renderGroups() {
                        renderCalls += 1;
                    },
                });
                const movedPastTop = ctx.OptionComboGroupEditorUI.moveGroupByOffset(state, 'group_2', -1, {
                    renderGroups() {
                        renderCalls += 1;
                    },
                });
                const movedDown = ctx.OptionComboGroupEditorUI.moveGroupByOffset(state, 'group_2', 2, {
                    renderGroups() {
                        renderCalls += 1;
                    },
                });

                assert.equal(movedUp, true);
                assert.equal(movedPastTop, false);
                assert.equal(movedDown, true);
                assert.deepEqual(state.groups.map(group => group.id), ['group_1', 'group_3', 'group_2']);
                assert.equal(renderCalls, 2);
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
                            '.trial-trigger-concession': concessionInput,
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
                const concessionInput = { value: '', addEventListener: noop };
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
                        repriceThreshold: 0.0001,
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
                assert.equal(repriceThresholdInput.value, '0.0001');
                assert.equal(timeInForceInput.value, 'GTC');
                assert.equal(exitEnabledInput.checked, true);
                assert.equal(exitConditionInput.value, 'lte');
                assert.equal(exitPriceInput.value, '671.00');
            },
        },
        {
            name: 'converts an assigned short put into realized premium plus underlying shares',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_editor_ui.js',
                ]);

                const group = {
                    id: 'g_assign',
                    viewMode: 'active',
                    legs: [
                        {
                            id: 'put_685',
                            type: 'put',
                            pos: -4,
                            strike: 685,
                            expDate: '2026-03-27',
                            iv: 0.2,
                            cost: 12.59,
                            currentPrice: 25.12,
                            closePrice: null,
                            underlyingFutureId: '',
                        },
                    ],
                };
                let renderCalls = 0;
                let subscriptionCalls = 0;
                let idCounter = 0;

                const converted = ctx.OptionComboGroupEditorUI.applyOptionAssignmentConversion(
                    group,
                    group.legs[0],
                    { underlyingSymbol: 'SPY' },
                    {
                        getRenderableGroupViewMode() { return 'active'; },
                        supportsUnderlyingLegs() { return true; },
                        getUnderlyingProfile() { return ctx.OptionComboProductRegistry.resolveUnderlyingProfile('SPY'); },
                        generateId() { idCounter += 1; return `generated_${idCounter}`; },
                        handleLiveSubscriptions() { subscriptionCalls += 1; },
                        renderGroups() { renderCalls += 1; },
                    }
                );

                assert.equal(converted, true);
                assert.equal(group.legs[0].closePrice, 0);
                assert.equal(group.legs[0].closePriceSource, 'assignment_conversion');
                assert.equal(group.legs[0].assignmentUnderlyingQuantity, 400);
                assert.equal(group.legs[0].assignmentUnderlyingLegId, 'generated_1');
                assert.equal(group.legs.length, 2);
                assert.equal(group.legs[1].type, 'stock');
                assert.equal(group.legs[1].pos, 400);
                assert.equal(group.legs[1].cost, 685);
                assert.equal(group.legs[1].assignmentSourceLegId, 'put_685');
                assert.equal(subscriptionCalls, 1);
                assert.equal(renderCalls, 1);
            },
        },
        {
            name: 'retitles trigger execution modes for historical replay',
            run() {
                const ctx = loadBrowserScripts([
                    'js/group_order_builder.js',
                    'js/trade_trigger_logic.js',
                    'js/group_editor_ui.js',
                ]);

                const noop = () => {};
                const listeners = {};
                const previewOption = { value: 'preview', textContent: 'Preview Only' };
                const testSubmitOption = { value: 'test_submit', textContent: 'Send to TWS (Test Only)' };
                const submitOption = { value: 'submit', textContent: 'Send to TWS' };
                const helpText = { textContent: '' };
                const container = {
                    querySelector(selector) {
                        return {
                            '.trial-trigger-enabled': enabledInput,
                            '.trial-trigger-collapse-btn': collapseBtn,
                            '.trial-trigger-condition': conditionInput,
                            '.trial-trigger-price': priceInput,
                            '.trial-trigger-execution-mode': executionModeInput,
                            '.trial-trigger-reprice-threshold': repriceThresholdInput,
                            '.trial-trigger-concession': concessionInput,
                            '.trial-trigger-tif': timeInForceInput,
                            '.trial-trigger-exit-enabled': exitEnabledInput,
                            '.trial-trigger-exit-condition': exitConditionInput,
                            '.trial-trigger-exit-price': exitPriceInput,
                            '.trial-trigger-reset-btn': resetBtn,
                            '.trial-trigger-body': body,
                            '.trial-trigger-help': helpText,
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
                const executionModeInput = {
                    value: '',
                    title: '',
                    options: [previewOption, testSubmitOption, submitOption],
                    addEventListener: noop,
                };
                const repriceThresholdInput = { value: '', addEventListener: noop };
                const concessionInput = { value: '', addEventListener: noop };
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
                        status: 'armed',
                    },
                };

                ctx.OptionComboGroupEditorUI.bindTrialTriggerControls(card, group, {
                    marketDataMode: 'historical',
                    allowLiveComboOrders: false,
                }, {
                    renderGroups() {},
                });

                assert.equal(testSubmitOption.textContent, 'Simulated Test Submit');
                assert.equal(submitOption.textContent, 'Simulated Submit');
                assert.match(executionModeInput.title, /never routes orders to TWS/i);
                assert.match(helpText.textContent, /historical replay/i);
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
                            '.trial-trigger-concession': concessionInput,
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
                const concessionInput = { value: '', addEventListener: noop };
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
                            '.trial-trigger-concession': concessionInput,
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
                const concessionInput = { value: '', addEventListener: noop };
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
        {
            name: 'describes option-leg iv input without requiring pricing core globals',
            run() {
                const ctx = loadBrowserScripts(['js/group_editor_ui.js']);

                const display = ctx.OptionComboGroupEditorUI._test.describeLegIvInput({
                    iv: 0.14670187233332188,
                });

                assert.equal(display.value, '14.6702%');
                assert.equal(display.title, 'Manual IV');
            },
        },
    ],
};
