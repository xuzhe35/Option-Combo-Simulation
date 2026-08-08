const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function makeGreekValueEl() {
    const classes = new Set();
    return {
        textContent: '',
        classList: {
            toggle: (name, force) => {
                if (force) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
            },
            has: name => classes.has(name),
        },
    };
}

function makeGreeksCard() {
    const item = { style: {}, title: '', removeAttribute() { this.title = ''; } };
    const deltaValue = makeGreekValueEl();
    const thetaValue = makeGreekValueEl();
    return {
        item,
        deltaValue,
        thetaValue,
        card: {
            querySelector(selector) {
                if (selector === '.group-header-delta-item') return item;
                if (selector === '.group-header-delta-value') return deltaValue;
                if (selector === '.group-header-theta-value') return thetaValue;
                return null;
            },
        },
    };
}

module.exports = {
    name: 'group_ui.js',
    tests: [
        {
            name: 'renders delta and theta in one group header chip',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);
                const dom = makeGreeksCard();

                ctx.OptionComboGroupUI.applyGroupDeltaSummary(dom.card, {
                    groupDeltaDisplayable: true,
                    groupDeltaAvailable: true,
                    groupDelta: 102.5,
                    groupDeltaMissingLegCount: 0,
                    groupThetaDisplayable: true,
                    groupThetaAvailable: true,
                    groupTheta: -13.25,
                    groupThetaMissingLegCount: 0,
                });

                assert.equal(dom.item.style.display, '');
                assert.equal(dom.deltaValue.textContent, '+102.5');
                assert.equal(dom.thetaValue.textContent, '-$13.25');
                // Paying decay must read as a loss, not as a neutral figure.
                assert.equal(dom.thetaValue.classList.has('danger-text'), true);
                assert.equal(dom.thetaValue.classList.has('success-text'), false);
                assert.match(dom.item.title, /Δ:/);
                assert.match(dom.item.title, /Θ:/);
            },
        },
        {
            name: 'colours a decay-collecting group theta as a gain',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);
                const dom = makeGreeksCard();

                ctx.OptionComboGroupUI.applyGroupDeltaSummary(dom.card, {
                    groupDeltaDisplayable: true,
                    groupDeltaAvailable: true,
                    groupDelta: -40,
                    groupThetaDisplayable: true,
                    groupThetaAvailable: true,
                    groupTheta: 220.4,
                });

                // Above $100/day the cents are dropped, so the chip stays narrow.
                assert.equal(dom.thetaValue.textContent, '+$220');
                assert.equal(dom.thetaValue.classList.has('success-text'), true);
            },
        },
        {
            name: 'shows theta as pending without hiding an available group delta',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);
                const dom = makeGreeksCard();

                ctx.OptionComboGroupUI.applyGroupDeltaSummary(dom.card, {
                    groupDeltaDisplayable: true,
                    groupDeltaAvailable: true,
                    groupDelta: 25,
                    groupDeltaMissingLegCount: 0,
                    groupThetaDisplayable: true,
                    groupThetaAvailable: false,
                    groupTheta: null,
                    groupThetaMissingLegCount: 2,
                });

                assert.equal(dom.deltaValue.textContent, '+25');
                assert.equal(dom.thetaValue.textContent, 'N/A');
                assert.equal(dom.thetaValue.classList.has('text-muted'), true);
                assert.equal(dom.thetaValue.classList.has('danger-text'), false);
                assert.match(dom.item.title, /Theta is not available yet for 2 legs/);
            },
        },
        {
            name: 'hides the greeks chip entirely when the group cannot show greeks',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);
                const dom = makeGreeksCard();

                ctx.OptionComboGroupUI.applyGroupDeltaSummary(dom.card, {
                    groupDeltaDisplayable: false,
                    groupThetaDisplayable: false,
                });

                assert.equal(dom.item.style.display, 'none');
            },
        },
        {
            name: 'labels hidden stale group Greeks instead of presenting cached values',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);
                const dom = makeGreeksCard();

                ctx.OptionComboGroupUI.applyGroupDeltaSummary(dom.card, {
                    groupDeltaDisplayable: true,
                    groupDeltaAvailable: false,
                    groupDelta: null,
                    groupDeltaMissingLegCount: 1,
                    groupDeltaStaleLegCount: 1,
                    groupThetaDisplayable: true,
                    groupThetaAvailable: false,
                    groupTheta: null,
                    groupThetaMissingLegCount: 1,
                    groupThetaStaleLegCount: 1,
                });

                assert.equal(dom.deltaValue.textContent, 'N/A');
                assert.equal(dom.thetaValue.textContent, 'N/A');
                assert.match(dom.item.title, /stale values are hidden/i);
            },
        },
        {
            name: 'formats trigger preview with separate summary and leg detail sections',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const html = ctx.OptionComboGroupUI.buildTriggerPreviewHtml(
                    {
                        lastPreview: {
                            orderAction: 'BUY',
                            totalQuantity: 1,
                            comboSymbol: 'SPY',
                            limitPrice: 10.31,
                            pricingSource: 'middle',
                            timeInForce: 'GTC',
                            legs: [
                                {
                                    executionAction: 'BUY',
                                    ratio: 1,
                                    localSymbol: 'SPY   260402C00670000',
                                    mark: 10.31,
                                },
                            ],
                        },
                    },
                    new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                    })
                );

                assert.match(html, /ORDER SUMMARY/);
                assert.match(html, /Net order:/);
                assert.match(html, /LMT GTC/);
                assert.match(html, /LEG DETAILS/);
                assert.match(html, /Leg 1:/);
                assert.doesNotMatch(html, /^BUY 1 SPY @/);
            },
        },
        {
            name: 'hides absurd what-if commission sentinel values',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const html = ctx.OptionComboGroupUI.buildTriggerPreviewHtml(
                    {
                        lastPreview: {
                            orderAction: 'BUY',
                            totalQuantity: 1,
                            comboSymbol: 'SPY',
                            limitPrice: 2.18,
                            pricingSource: 'middle',
                            legs: [],
                            whatIf: {
                                commission: Number.MAX_VALUE,
                                commissionCurrency: 'USD',
                            },
                        },
                    },
                    new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                    })
                );

                assert.doesNotMatch(html, /What-if commission:/);
            },
        },
        {
            name: 'labels test-only orders distinctly and shows guardrail note',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const html = ctx.OptionComboGroupUI.buildTriggerPreviewHtml(
                    {
                        lastPreview: {
                            orderAction: 'BUY',
                            totalQuantity: 1,
                            comboSymbol: 'SPY',
                            limitPrice: 1.0,
                            pricingSource: 'test_guardrail',
                            executionMode: 'test_submit',
                            pricingNote: 'Test-only guardrail price intentionally set far below the combo mid to avoid fills.',
                            legs: [],
                        },
                    },
                    new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                    })
                );

                assert.match(html, /TEST ORDER SUMMARY/);
                assert.match(html, /Net test order:/);
                assert.match(html, /guardrail price intentionally set far below/i);
            },
        },
        {
            name: 'labels close-intent previews distinctly from open orders',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const html = ctx.OptionComboGroupUI.buildTriggerPreviewHtml(
                    {
                        lastPreview: {
                            executionIntent: 'close',
                            orderAction: 'SELL',
                            totalQuantity: 1,
                            comboSymbol: 'SPY',
                            limitPrice: 1.15,
                            pricingSource: 'middle',
                            legs: [],
                        },
                    },
                    new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                    })
                );

                assert.match(html, /CLOSE ORDER SUMMARY/);
                assert.match(html, /Net close order:/);
            },
        },
        {
            name: 'shows trial-trigger header button before expanding the trial panel',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const collapsedState = ctx.OptionComboGroupUI.resolveTradeTriggerUiState(
                    'trial',
                    {
                        enabled: false,
                        isExpanded: false,
                        pendingRequest: false,
                        lastPreview: null,
                        lastError: '',
                    }
                );
                const expandedState = ctx.OptionComboGroupUI.resolveTradeTriggerUiState(
                    'trial',
                    {
                        enabled: false,
                        isExpanded: true,
                        pendingRequest: false,
                        lastPreview: null,
                        lastError: '',
                    }
                );

                assert.equal(collapsedState.showToggle, true);
                assert.equal(collapsedState.showPanel, false);
                assert.equal(expandedState.showToggle, true);
                assert.equal(expandedState.showPanel, true);
            },
        },
        {
            name: 'keeps trial-trigger panel visible while trigger is armed or runtime exists',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const armedState = ctx.OptionComboGroupUI.resolveTradeTriggerUiState(
                    'active',
                    {
                        enabled: true,
                        isExpanded: false,
                        pendingRequest: false,
                        lastPreview: null,
                        lastError: '',
                    }
                );
                const runtimeState = ctx.OptionComboGroupUI.resolveTradeTriggerUiState(
                    'active',
                    {
                        enabled: false,
                        isExpanded: false,
                        pendingRequest: false,
                        lastPreview: { status: 'Submitted' },
                        lastError: '',
                    }
                );

                assert.equal(armedState.showToggle, true);
                assert.equal(armedState.showPanel, true);
                assert.equal(runtimeState.showToggle, true);
                assert.equal(runtimeState.showPanel, true);
                assert.equal(runtimeState.hasRuntime, true);
            },
        },
        {
            name: 'shows close-group header button before expanding the active close panel',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const collapsedState = ctx.OptionComboGroupUI.resolveCloseGroupUiState(
                    'active',
                    true,
                    {
                        isExpanded: false,
                        pendingRequest: false,
                        lastPreview: null,
                        lastError: '',
                    }
                );
                const expandedState = ctx.OptionComboGroupUI.resolveCloseGroupUiState(
                    'active',
                    true,
                    {
                        isExpanded: true,
                        pendingRequest: false,
                        lastPreview: null,
                        lastError: '',
                    }
                );

                assert.equal(collapsedState.showToggle, true);
                assert.equal(collapsedState.showPanel, false);
                assert.equal(expandedState.showToggle, true);
                assert.equal(expandedState.showPanel, true);
            },
        },
        {
            name: 'keeps close-group panel visible while close runtime data exists',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const uiState = ctx.OptionComboGroupUI.resolveCloseGroupUiState(
                    'trial',
                    false,
                    {
                        isExpanded: false,
                        pendingRequest: false,
                        lastPreview: { status: 'Submitted' },
                        lastError: '',
                    }
                );

                assert.equal(uiState.showToggle, true);
                assert.equal(uiState.showPanel, true);
                assert.equal(uiState.hasRuntime, true);
            },
        },
        {
            name: 'shows close-group header button in historical trial mode once costs are locked',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const uiState = ctx.OptionComboGroupUI.resolveCloseGroupUiState(
                    'trial',
                    true,
                    {
                        isExpanded: false,
                        pendingRequest: false,
                        lastPreview: null,
                        lastError: '',
                    },
                    true
                );

                assert.equal(uiState.showToggle, true);
                assert.equal(uiState.showPanel, false);
            },
        },
        {
            name: 'shows broker status metadata for submitted orders',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const html = ctx.OptionComboGroupUI.buildTriggerPreviewHtml(
                    {
                        lastPreview: {
                            orderAction: 'BUY',
                            totalQuantity: 1,
                            comboSymbol: 'SPY',
                            limitPrice: 0.85,
                            pricingSource: 'test_guardrail',
                            executionMode: 'test_submit',
                            account: 'F1234567',
                            status: 'Submitted',
                            orderId: 930,
                            permId: 1678156393,
                            filled: 0,
                            remaining: 1,
                            legs: [],
                        },
                    },
                    new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                    })
                );

                assert.match(html, /Broker status: Submitted/);
                assert.match(html, /Account F1234567/);
                assert.match(html, /Order ID 930/);
                assert.match(html, /Perm ID 1678156393/);
                assert.match(html, /Filled: 0, Remaining: 1/);
            },
        },
        {
            name: 'formats header live pnl values with signed styling',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const formatter = new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                });

                const profitHtml = ctx.OptionComboGroupUI.buildGroupLivePnlHtml(formatter, 1756.04);
                const lossHtml = ctx.OptionComboGroupUI.buildGroupLivePnlHtml(formatter, -250.12);

                assert.match(profitHtml, /success-text/);
                assert.match(profitHtml, /\+\$1,756\.04/);
                assert.match(lossHtml, /danger-text/);
                assert.match(lossHtml, /-\$250\.12/);
            },
        },
        {
            name: 'uses settlement summary text instead of live pnl in settlement mode',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const summary = ctx.OptionComboGroupUI.resolveGroupHeaderSummaryState({
                    activeViewMode: 'settlement',
                    isAmortizedMode: false,
                    groupPnL: 460,
                    groupHasLiveData: true,
                    groupLivePnL: 999,
                });

                assert.equal(summary.type, 'settlement');
                assert.equal(summary.label, 'Settlement P&L:');
                assert.equal(summary.value, 460);
            },
        },
        {
            name: 'uses liquidation summary instead of a stale live pnl',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const summary = ctx.OptionComboGroupUI.resolveGroupHeaderSummaryState({
                    activeViewMode: 'liquidation',
                    isAmortizedMode: false,
                    groupPnL: -2500,
                    groupHasLiveData: true,
                    groupLivePnL: 6850,
                });

                assert.equal(summary.type, 'liquidation');
                assert.equal(summary.label, 'Liquidation P&L:');
                assert.equal(summary.value, -2500);
            },
        },
        {
            name: 'keeps live summary only for non-scenario groups with live data',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const summary = ctx.OptionComboGroupUI.resolveGroupHeaderSummaryState({
                    activeViewMode: 'active',
                    isAmortizedMode: false,
                    groupPnL: 120,
                    groupHasLiveData: true,
                    groupLivePnL: 75,
                });

                assert.equal(summary.type, 'live');
                assert.equal(summary.label, 'Live P&L:');
                assert.equal(summary.value, 75);
            },
        },
        {
            name: 'shows zero remaining for terminal cancelled orders',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const html = ctx.OptionComboGroupUI.buildTriggerPreviewHtml(
                    {
                        lastPreview: {
                            orderAction: 'BUY',
                            totalQuantity: 1,
                            comboSymbol: 'SPY',
                            limitPrice: 0.85,
                            executionMode: 'test_submit',
                            status: 'Cancelled',
                            orderId: 1073,
                            permId: 1678156398,
                            filled: 0,
                            remaining: 1,
                            legs: [],
                        },
                    },
                    new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                    })
                );

                assert.match(html, /Broker status: Cancelled/);
                assert.match(html, /Filled: 0, Remaining: 0/);
            },
        },
        {
            name: 'shows managed execution drift and repricing metadata for live orders',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const html = ctx.OptionComboGroupUI.buildTriggerPreviewHtml(
                    {
                        lastPreview: {
                            orderAction: 'BUY',
                            totalQuantity: 1,
                            comboSymbol: 'SPY',
                            limitPrice: 2.18,
                            executionMode: 'submit',
                            status: 'Submitted',
                            orderId: 1337,
                            permId: 1678156402,
                            managedMode: true,
                            managedState: 'watching',
                            workingLimitPrice: 2.18,
                            latestComboMid: 2.31,
                            bestComboPrice: 2.05,
                            worstComboPrice: 2.57,
                            managedRepriceThreshold: 0.0001,
                            managedConcessionRatio: 0.2,
                            repricingCount: 2,
                            lastRepriceAt: '2026-03-17T15:30:00Z',
                            managedMessage: 'Updated working limit to 2.18 from latest combo mid 2.31.',
                            legs: [],
                        },
                    },
                    new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                    })
                );

                assert.match(html, /Managed execution: watching/);
                assert.match(html, /Working LMT \$2\.18/);
                assert.match(html, /Latest combo mid \$2\.31/);
                assert.match(html, /Drift threshold 0\.0001/);
                assert.match(html, /Concession 20%/);
                assert.match(html, /Quoted combo range: best \$2\.05 to worst \$2\.57/);
                assert.match(html, /Reprices: 2/);
                assert.match(html, /Last repriced: 2026-03-17T15:30:00Z/);
                assert.match(html, /Updated working limit to 2\.18/);
            },
        },
        {
            name: 'resolves continue-repricing action when managed retries are exhausted',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const actionState = ctx.OptionComboGroupUI.resolveTriggerActionState({
                    lastPreview: {
                        orderId: 1637,
                        managedState: 'stopped_max_reprices',
                        canContinueRepricing: true,
                        canConcedePricing: true,
                        managedManualConcessionStep: 0.25,
                    },
                });

                assert.equal(actionState.actions[0].label, 'Continue Auto-Repricing');
                assert.equal(actionState.actions[1].kind, 'concede_step');
                assert.equal(actionState.actions[1].label, 'Chase 1 Step');
                assert.equal(actionState.actions[1].stepValue, 0.25);
                const manualChaseHtml = ctx.OptionComboGroupUI.renderTriggerAction(actionState.actions[1]);
                assert.match(manualChaseHtml, /trial-trigger-concede-step-input/);
                assert.match(manualChaseHtml, /value="0\.25"/);
                assert.match(manualChaseHtml, /Chase 1 Step/);
                assert.equal(actionState.actions[2].kind, 'concede_select');
                assert.equal(
                    actionState.actions[2].options.map(option => option.label).join('|'),
                    'Concede 10%|Concede 20%|Concede 30%|Concede 50%|Concede 75%|Concede 90%'
                );
                assert.equal(actionState.actions[3].label, 'Cancel Order');
            },
        },
        {
            name: 'keeps concession action signature stable across managed reprice snapshots',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const watching = ctx.OptionComboGroupUI.resolveTriggerActionState({
                    lastPreview: {
                        orderId: 1637,
                        status: 'Submitted',
                        managedState: 'watching',
                        canContinueRepricing: false,
                        canConcedePricing: true,
                    },
                });
                const repricing = ctx.OptionComboGroupUI.resolveTriggerActionState({
                    lastPreview: {
                        orderId: 1637,
                        status: 'Submitted',
                        managedState: 'repricing',
                        workingLimitPrice: 2.24,
                        latestComboMid: 2.31,
                        canContinueRepricing: false,
                        canConcedePricing: true,
                    },
                });

                assert.equal(watching.signature, repricing.signature);
            },
        },
        {
            name: 'resolves continue-monitoring action when managed supervision times out',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                const actionState = ctx.OptionComboGroupUI.resolveTriggerActionState({
                    lastPreview: {
                        orderId: 1836,
                        managedState: 'stopped_timeout',
                        canContinueRepricing: true,
                        continueActionLabel: 'Continue Monitoring (10 More Minutes)',
                    },
                });

                assert.equal(actionState.actions[0].label, 'Continue Monitoring (10 More Minutes)');
                assert.equal(actionState.actions[1].label, 'Cancel Order');
            },
        },
        {
            name: 'shows a confirming status while broker terminal callbacks are being verified',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/group_ui.js',
                ]);

                assert.equal(
                    ctx.OptionComboGroupUI.formatTriggerStatus({
                        status: 'submitted',
                        lastPreview: {
                            status: 'Cancelled',
                            managedState: 'confirming_terminal',
                        },
                    }),
                    'Confirming broker order state...'
                );

                assert.equal(
                    ctx.OptionComboGroupUI.formatCloseExecutionStatus({
                        status: 'submitted',
                        lastPreview: {
                            status: 'Inactive',
                            managedState: 'confirming_terminal',
                        },
                    }),
                    'Confirming close-order broker state...'
                );

                assert.equal(
                    ctx.OptionComboGroupUI.formatCloseExecutionStatus({
                        status: 'plan_cancelled',
                        lastPreview: {
                            closePlanConfirmationStatus: 'cancelled',
                        },
                    }),
                    'Close Plan cancelled — no order sent'
                );
            },
        },
    ],
};
