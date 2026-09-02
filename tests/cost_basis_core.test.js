const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadCore() {
    const context = loadBrowserScripts(['js/cost_basis_core.js']);
    return context.OptionComboCostBasisCore;
}

let sequence = 0;
function event(overrides) {
    sequence += 1;
    return Object.assign({
        seq: sequence,
        account: 'U1111111',
        includeInCost: true,
        fees: 0,
    }, overrides);
}

function shortPut(overrides) {
    const base = {
        kind: 'option_trade',
        tradeDate: '2026-06-01',
        right: 'P',
        strike: 45,
        expiry: '20260717',
        contracts: -5,
        price: 1.2,
        sharesPerContract: 100,
        fees: 0,
    };
    const merged = Object.assign(base, overrides || {});
    merged.cashAmount = -(merged.contracts * merged.sharesPerContract * merged.price)
        - merged.fees;
    return event(merged);
}

function putAssignment(overrides) {
    const base = {
        kind: 'option_assignment',
        tradeDate: '2026-07-17',
        right: 'P',
        strike: 45,
        expiry: '20260717',
        contracts: 5,
        sharesPerContract: 100,
        fees: 0,
    };
    const merged = Object.assign(base, overrides || {});
    merged.shares = Math.abs(merged.contracts) * merged.sharesPerContract;
    merged.price = merged.strike;
    merged.cashAmount = -(merged.shares * merged.strike) - merged.fees;
    return event(merged);
}

function shortCall(overrides) {
    return shortPut(Object.assign({
        right: 'C', strike: 60, expiry: '20260821', price: 0.9,
    }, overrides || {}));
}

function callAssignment(overrides) {
    const base = {
        kind: 'option_assignment',
        tradeDate: '2026-08-21',
        right: 'C',
        strike: 60,
        expiry: '20260821',
        contracts: 5,
        sharesPerContract: 100,
        fees: 0,
    };
    const merged = Object.assign(base, overrides || {});
    merged.shares = -Math.abs(merged.contracts) * merged.sharesPerContract;
    merged.price = merged.strike;
    merged.cashAmount = -(merged.shares * merged.strike) - merged.fees;
    return event(merged);
}

module.exports = {
    name: 'cost_basis_core.js',
    tests: [
        {
            name: 'broker timestamps order same-day events before insertion sequence',
            run() {
                const core = loadCore();
                const later = event({
                    seq: 1, kind: 'share_trade', tradeDate: '2026-08-24',
                    brokerTimestamp: '2026-08-24T15:00:00',
                    shares: -1, price: 71, cashAmount: 71,
                });
                const earlier = event({
                    seq: 2, kind: 'share_trade', tradeDate: '2026-08-24',
                    brokerTimestamp: '2026-08-24T10:00:00',
                    shares: 1, price: 69, cashAmount: -69,
                });
                const ledger = core.computeLedger([later, earlier]);
                assert.equal(ledger.rows[0].event.brokerTimestamp,
                    '2026-08-24T10:00:00');
                assert.equal(ledger.rows[1].event.brokerTimestamp,
                    '2026-08-24T15:00:00');
            },
        },
        {
            name: 'the outbound whitelist carries no order or market-data action',
            run() {
                const core = loadCore();
                const forbidden = [
                    'place_combo_order', 'submit_combo_order', 'sync_underlying',
                    'request_historical_bars', 'subscribe_iv_term_structure',
                    'place_hedge_order', 'cancel_combo_order',
                    // Compatibility/admin protocol actions have no page entry point.
                    'archive_cost_basis_book', 'list_cost_basis_snapshots',
                    'reset_cost_basis_book', 'list_cost_basis_resets',
                ];
                forbidden.forEach((action) => {
                    assert.equal(core.ALLOWED_CLIENT_ACTIONS.includes(action), false,
                        `${action} must not be reachable from the ledger page`);
                });
                assert.ok(core.ALLOWED_CLIENT_ACTIONS.includes('append_cost_basis_event'));
                assert.ok(core.ALLOWED_CLIENT_ACTIONS.includes('delete_cost_basis_book'));
                assert.ok(core.ALLOWED_CLIENT_ACTIONS.includes(
                    'request_managed_accounts_snapshot'));
                assert.ok(core.ALLOWED_CLIENT_ACTIONS.includes(
                    'request_cost_basis_executions'));
                assert.ok(core.ALLOWED_CLIENT_ACTIONS.includes(
                    'request_cost_basis_option_scenario_inputs'));
                assert.ok(Object.isFrozen(core.ALLOWED_CLIENT_ACTIONS));
            },
        },
        {
            name: 'TWS executions become fee-complete idempotent ledger events',
            run() {
                const core = loadCore();
                const result = core.buildExecutionImport([{
                    execId: '0001.01', account: 'U17775528', symbol: 'TQQQ',
                    secType: 'OPT', conId: 42, localSymbol: 'TQQQ P71',
                    expiry: '20260902', right: 'P', strike: 71, multiplier: 100,
                    side: 'SLD', quantity: 2, price: 1.25,
                    brokerTimestamp: '2026-09-01T10:15:20',
                    commission: 1.4, commissionAvailable: true,
                }], {
                    account: 'U17775528', symbol: 'TQQQ', secType: 'STK',
                    defaultSharesPerContract: 100, existingExternalRefs: [],
                });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 1);
                assert.deepEqual({
                    kind: result.events[0].kind,
                    contracts: result.events[0].contracts,
                    cashAmount: result.events[0].cashAmount,
                    source: result.events[0].source,
                    externalRef: result.events[0].externalRef,
                }, {
                    kind: 'option_trade', contracts: -2, cashAmount: 248.6,
                    source: 'execution_report', externalRef: 'ibkr-exec-0001.01',
                });
            },
        },
        {
            name: 'TWS execution import blocks until commission is present',
            run() {
                const core = loadCore();
                const result = core.buildExecutionImport([{
                    execId: 'E2', account: 'U1', symbol: 'TQQQ', secType: 'STK',
                    side: 'BOT', quantity: 100, price: 70,
                    brokerTimestamp: '2026-09-01T11:00:00',
                    commission: 0, commissionAvailable: false,
                }], { account: 'U1', symbol: 'TQQQ', secType: 'STK' });
                assert.equal(result.events.length, 0);
                assert.equal(result.problems.length, 1);
                assert.match(result.problems[0].reason, /佣金/);
            },
        },
        {
            name: 'duplicate execIds in one TWS batch are blocked before storage',
            run() {
                const core = loadCore();
                const fill = {
                    execId: 'DUPLICATE.01', account: 'U1', symbol: 'TQQQ',
                    secType: 'STK', side: 'BOT', quantity: 100, price: 70,
                    brokerTimestamp: '2026-09-01T11:00:00',
                    commission: 1, commissionAvailable: true,
                };
                const result = core.buildExecutionImport([
                    fill, Object.assign({}, fill),
                ], { account: 'U1', symbol: 'TQQQ', secType: 'STK' });
                assert.equal(result.events.length, 1);
                assert.equal(result.problems.length, 1);
                assert.equal(result.summary.problems, 1);
                assert.match(result.problems[0].reason, /execId DUPLICATE\.01 重复/);
                assert.match(result.problems[0].reason, /第 1 行/);
            },
        },
        {
            name: 'a negative IB commission becomes a positive-cash rebate event',
            run() {
                const core = loadCore();
                const result = core.buildExecutionImport([{
                    execId: 'REBATE1', account: 'U1', symbol: 'TQQQ', secType: 'OPT',
                    expiry: '20260902', right: 'P', strike: 71, multiplier: 100,
                    side: 'SLD', quantity: 1, price: 1.25,
                    brokerTimestamp: '2026-09-01T11:00:00',
                    commission: -0.18, commissionAvailable: true,
                }], { account: 'U1', symbol: 'TQQQ', secType: 'STK' });
                assert.equal(result.problems.length, 0);
                assert.equal(result.events.length, 2);
                assert.equal(result.events[0].cashAmount, 125);
                assert.deepEqual({
                    kind: result.events[1].kind,
                    cashAmount: result.events[1].cashAmount,
                    externalRef: result.events[1].externalRef,
                }, {
                    kind: 'fee', cashAmount: 0.18,
                    externalRef: 'ibkr-exec-REBATE1-rebate',
                });
            },
        },
        {
            name: 'AvgCost fallback only drafts the unexplained position gap',
            run() {
                const core = loadCore();
                const draft = core.buildTwsAvgCostGapDraft({
                    kind: 'option', account: 'U1', right: 'P', strike: 71,
                    expiry: '20260902', ledger: -1, tws: -2, difference: -1,
                    sharesPerContract: 100, twsAvgCost: 1.5,
                }, { today: '2026-09-01', secType: 'STK' });
                assert.equal(draft.contracts, -1);
                assert.equal(draft.cashAmount, 150);
                assert.match(draft.note, /whole live position/);
            },
        },
        {
            name: 'one cash formula covers buying and selling options',
            run() {
                const core = loadCore();
                assert.equal(core.deriveCashAmount({
                    kind: 'option_trade', contracts: -5, price: 1.2,
                    sharesPerContract: 100, fees: 3.25,
                }), 596.75);
                assert.equal(core.deriveCashAmount({
                    kind: 'option_trade', contracts: 5, price: 1.2,
                    sharesPerContract: 100, fees: 3.25,
                }), -603.25);
            },
        },
        {
            name: 'an assignment row is the share delivery only, never the premium',
            run() {
                const core = loadCore();
                assert.equal(core.deriveCashAmount({
                    kind: 'option_assignment', shares: 500, strike: 45, fees: 0,
                }), -22500);
            },
        },
        {
            name: 'delivery direction follows the right and the side',
            run() {
                const core = loadCore();
                assert.equal(core.deliveredShares('option_assignment', 'P', 5, 100), 500);
                assert.equal(core.deliveredShares('option_assignment', 'C', 5, 100), -500);
                assert.equal(core.deliveredShares('option_exercise', 'C', 5, 100), 500);
                assert.equal(core.deliveredShares('option_exercise', 'P', 5, 100), -500);
            },
        },
        {
            name: 'a full wheel cycle produces all three lenses',
            run() {
                const core = loadCore();
                const events = [
                    shortPut({ fees: 3.25 }),
                    putAssignment(),
                    shortCall({ tradeDate: '2026-07-20', fees: 3.25 }),
                ];
                const summary = core.computeLedger(events).combined;
                assert.equal(summary.shares, 500);
                assert.equal(summary.netCash, -21456.5);
                assert.equal(summary.realizedPremium, 596.75);
                assert.equal(summary.openPremium, 446.75);
                // Net-cash lens counts only premium no longer at risk.
                assert.equal(summary.blendedCost, 43.8065);
                assert.equal(summary.blendedCostIfExpired, 42.913);
                // The stock lens is the one that should match a broker's
                // plain average-cost column: shares came in at the strike.
                assert.equal(summary.stockAvgCost, 45);
                // The tax lens rolls the assigned contract's premium in.
                assert.equal(summary.taxAvgCost, 43.8065);
            },
        },
        {
            name: 'an expiry-price What If settles short puts without selling shares',
            run() {
                const core = loadCore();
                const existingShares = event({
                    kind: 'opening_balance', tradeDate: '2026-06-01',
                    shares: 200, price: 73, cashAmount: -14600,
                });
                const assignedPut = shortPut({
                    tradeDate: '2026-06-02', contracts: -2,
                    strike: 75, price: 2,
                });
                const expiredPut = shortPut({
                    tradeDate: '2026-06-03', contracts: -3,
                    strike: 65, price: 1, expiry: '20260821',
                });
                const scenario = core.computeOptionSettlementScenario(
                    [existingShares, assignedPut, expiredPut], 71,
                    { secType: 'STK' });
                assert.equal(scenario.available, true);
                assert.equal(scenario.shortPutContracts, 5);
                assert.equal(scenario.shortPutAssignedContracts, 2);
                assert.equal(scenario.shortPutExpiredContracts, 3);
                assert.equal(scenario.shortPutAssignedShares, 200);
                assert.equal(scenario.shortPutAssignmentCash, -15000);
                assert.equal(scenario.ledger.openOptions.length, 0);
                assert.equal(scenario.ledger.combined.shares, 400);
                assert.equal(scenario.ledger.combined.blendedCost, 72.25);
                assert.equal(scenario.ledger.combined.stockAvgCost, 74);
                assert.equal(scenario.ledger.combined.taxAvgCost, 73);
                assert.equal(scenario.baseLedger.combined.shares, 200,
                    'the scenario must not sell or mutate current shares');

                const firstExpiryOnly = core.computeOptionSettlementScenario(
                    [existingShares, assignedPut, expiredPut], 71,
                    { secType: 'STK', throughExpiry: '20260717' });
                assert.equal(firstExpiryOnly.available, true);
                assert.equal(firstExpiryOnly.throughExpiry, '20260717');
                assert.equal(firstExpiryOnly.shortPutContracts, 2);
                assert.equal(firstExpiryOnly.shortPutAssignedContracts, 2);
                assert.equal(firstExpiryOnly.shortPutExpiredContracts, 0);
                assert.equal(firstExpiryOnly.shortPutAssignedShares, 200);
                assert.equal(firstExpiryOnly.deferredOptions.length, 1);
                assert.equal(firstExpiryOnly.ledger.combined.shares, 400);
                assert.equal(firstExpiryOnly.ledger.openOptions.length, 1,
                    'later expiries must remain open and at risk');
            },
        },
        {
            name: 'realized plus open premium always equals net option premium',
            run() {
                const core = loadCore();
                const events = [
                    shortPut({ fees: 3.25 }),
                    shortPut({ tradeDate: '2026-06-10', contracts: 2, price: 0.5 }),
                    putAssignment({ contracts: 3 }),
                    shortCall({ tradeDate: '2026-07-20' }),
                ];
                const summary = core.computeLedger(events).combined;
                assert.equal(
                    Math.round((summary.realizedPremium + summary.openPremium) * 1e6) / 1e6,
                    summary.optionPremiumNet);
            },
        },
        {
            name: 'seller premium metrics exclude long option protection spend',
            run() {
                const core = loadCore();
                const longPut = shortPut({
                    tradeDate: '2026-06-02', strike: 30, expiry: '20280121',
                    contracts: 2, price: 10,
                });
                const ledger = core.computeLedger([shortPut(), longPut]);
                const summary = ledger.combined;

                assert.equal(summary.optionPremiumNet, -1400,
                    'economic cash must still include the protective Long Put');
                assert.equal(summary.openPremium, -1400,
                    'the cost engine keeps the full net option cash');
                assert.equal(summary.openShortPremium, 600,
                    'the seller card must show only the Short Put credit');
                assert.equal(summary.realizedShortPremium, 0);
                assert.equal(summary.shortOptionPremiumNet, 600);
            },
        },
        {
            name: 'underlying cost lenses exclude the full Long Option lifecycle',
            run() {
                const core = loadCore();
                const shares = event({
                    kind: 'opening_balance', tradeDate: '2026-06-01',
                    shares: 100, price: 70, cashAmount: -7000,
                });
                const shortProtectionFunding = shortPut({
                    tradeDate: '2026-06-02', contracts: -1, price: 2,
                    strike: 65, expiry: '20260918',
                });
                const longProtection = shortPut({
                    tradeDate: '2026-06-03', contracts: 1, price: 10,
                    strike: 50, expiry: '20280121',
                });
                const open = core.computeLedger([
                    shares, shortProtectionFunding, longProtection,
                ]).combined;

                assert.equal(open.netCash, -7800,
                    'the audit cash retains the $1,000 Long Put purchase');
                assert.equal(open.excludedLongOptionCash, -1000);
                assert.equal(open.costNetCash, -6800,
                    'underlying cash keeps stock and Short premium only');
                assert.equal(open.blendedCost, 70,
                    'open Short premium is still withheld by the conservative lens');
                assert.equal(open.blendedCostIfExpired, 68,
                    'only the Short premium lowers the if-expired cost');

                const longClose = shortPut({
                    tradeDate: '2026-07-01', contracts: -1, price: 12,
                    strike: 50, expiry: '20280121',
                });
                const closed = core.computeLedger([
                    shares, shortProtectionFunding, longProtection, longClose,
                ]).combined;
                assert.equal(closed.netCash, -6600,
                    'the audit cash retains the Long Put sale and its $200 gain');
                assert.equal(closed.excludedLongOptionCash, 200);
                assert.equal(closed.costNetCash, -6800);
                assert.equal(closed.blendedCost, 70);
                assert.equal(closed.blendedCostIfExpired, 68,
                    'Long Option profit must not subsidize underlying cost either');
            },
        },
        {
            name: 'premium income windows exclude realized long option pnl',
            run() {
                const core = loadCore();
                const opened = shortPut({
                    tradeDate: '2026-01-05', strike: 30, expiry: '20280121',
                    contracts: 2, price: 10,
                });
                const closed = shortPut({
                    tradeDate: '2026-06-10', strike: 30, expiry: '20280121',
                    contracts: -2, price: 12,
                });
                const ledger = core.computeLedger([opened, closed]);

                assert.equal(ledger.combined.realizedPremium, 400,
                    'the economic ledger retains the Long Put gain');
                assert.equal(ledger.combined.realizedShortPremium, 0);
                assert.equal(core.realizedPremiumWindow(
                    ledger, { since: '2026-06-01', until: '2026-06-30' }), 0);
            },
        },
        {
            name: 'seller premium allocation remains correct when one fill crosses zero',
            run() {
                const core = loadCore();
                const events = [
                    shortPut({ contracts: 2, price: 10 }),
                    shortPut({ tradeDate: '2026-06-02', contracts: -3, price: 12 }),
                    shortPut({ tradeDate: '2026-06-03', contracts: 2, price: 8 }),
                ];
                const summary = core.computeLedger(events).combined;

                assert.equal(summary.realizedShortPremium, 400,
                    'only the one-contract short round trip belongs to seller income');
                assert.equal(summary.openShortPremium, 0);
                assert.equal(summary.openPremium, -800,
                    'the final one-contract Long Put debit stays in economic cash');
            },
        },
        {
            name: 'a partial buy-back realizes a proportional slice of the credit',
            run() {
                const core = loadCore();
                const events = [
                    // +600 credit on five short puts.
                    shortPut({ contracts: -5, price: 1.2 }),
                    // Buy two back for 250: realizes 2/5 of the credit (240)
                    // and the whole debit, leaving 360 still at risk.
                    shortPut({ tradeDate: '2026-06-15', contracts: 2, price: 1.25 }),
                ];
                const summary = core.computeLedger(events).combined;
                assert.equal(summary.realizedPremium, -10);
                assert.equal(summary.openPremium, 360);
                assert.equal(summary.optionPremiumNet, 350);
            },
        },
        {
            name: 'an IBKR close without its opening never creates an inverse position',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([event({
                    kind: 'option_trade', tradeDate: '2026-08-19',
                    right: 'C', strike: 95, expiry: '20261231',
                    contracts: -3, sharesPerContract: 100, price: 1.15,
                    cashAmount: 345, tag: 'ibkr_close', source: 'csv_import',
                })]);
                assert.equal(ledger.openOptions.length, 0);
                assert.equal(ledger.combined.netCash, 0,
                    'a rejected close must not leak cash into preview totals');
                assert.equal(ledger.rows[0].runningNetCash, 0);
                assert.ok(ledger.warnings.some(
                    (warning) => warning.startsWith('closes_more_than_open:')));
            },
        },
        {
            name: 'unknown prior premium remains a persistent ledger warning',
            run() {
                const core = loadCore();
                const base = {
                    kind: 'option_trade', tradeDate: '2026-08-01',
                    right: 'C', strike: 95, expiry: '20261231',
                    contracts: 3, sharesPerContract: 100, price: 0,
                    cashAmount: 0, source: 'csv_import',
                };
                const unknown = core.computeLedger([event(Object.assign({}, base, {
                    tag: 'prior_open',
                }))]);
                assert.ok(unknown.warnings.some(
                    (warning) => warning.startsWith('unknown_prior_open:')));
                const reconstructed = core.computeLedger([event(Object.assign({}, base, {
                    tag: 'prior_basis', price: 7, cashAmount: -2100,
                }))]);
                assert.equal(reconstructed.warnings.some(
                    (warning) => warning.startsWith('unknown_prior_open:')), false);
            },
        },
        {
            name: 'an IBKR O row cannot be swallowed as a close',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    shortPut({ contracts: -1 }),
                    shortPut({ tradeDate: '2026-06-02', contracts: 1,
                        tag: 'ibkr_open', source: 'csv_import' }),
                ]);
                assert.equal(ledger.openOptions[0].contracts, -1);
                assert.equal(ledger.combined.netCash, 120,
                    'only the accepted opening credit belongs in net cash');
                assert.equal(ledger.rows[1].runningNetCash, 120);
                assert.ok(ledger.warnings.some(
                    (warning) => warning.startsWith('ibkr_open_opposes_existing:')));
            },
        },
        {
            name: 'a ledger with no shares reports a lifetime figure, never Infinity',
            run() {
                const core = loadCore();
                const summary = core.computeLedger([shortPut()]).combined;
                assert.equal(summary.shares, 0);
                assert.equal(summary.blendedCost, null);
                assert.equal(summary.blendedCostIfExpired, null);
                const rendered = core.summarizeCost(summary, 'net_cash');
                assert.equal(rendered.available, false);
                assert.equal(rendered.state, 'no_shares');
                assert.equal(rendered.lifetimeNetCash, 600);
                assert.ok(Number.isFinite(rendered.lifetimeNetCash));
            },
        },
        {
            name: 'a cost driven below zero is reported as recovered, not as an error',
            run() {
                const core = loadCore();
                const events = [
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 100, price: 10, cashAmount: -1000,
                    }),
                    event({
                        kind: 'option_trade', tradeDate: '2026-02-01', right: 'C',
                        strike: 12, expiry: '20260320', contracts: -1, price: 15,
                        sharesPerContract: 100, cashAmount: 1500,
                    }),
                    event({
                        kind: 'option_expiry', tradeDate: '2026-03-20', right: 'C',
                        strike: 12, expiry: '20260320', contracts: 1,
                        sharesPerContract: 100, cashAmount: 0,
                    }),
                ];
                const summary = core.computeLedger(events).combined;
                assert.equal(summary.blendedCost, -5);
                const rendered = core.summarizeCost(summary, 'net_cash');
                assert.equal(rendered.available, true);
                assert.equal(rendered.state, 'recovered');
                assert.equal(rendered.value, -5);
            },
        },
        {
            name: 'a call assigned without shares reports a short position',
            run() {
                const core = loadCore();
                const events = [shortCall(), callAssignment()];
                const ledger = core.computeLedger(events);
                const summary = ledger.combined;
                assert.equal(summary.shares, -500);
                assert.equal(summary.isShort, true);
                assert.ok(ledger.warnings.includes('net_short_shares'));
                assert.equal(core.summarizeCost(summary, 'net_cash').state, 'short');
            },
        },
        {
            name: 'only the final share balance decides the short-position notice',
            run() {
                const core = loadCore();
                const settlementTimestamp = '2026-08-21T16:20:00';
                const events = [
                    event({
                        kind: 'opening_balance', tradeDate: '2026-06-01',
                        shares: 200, price: 50, cashAmount: -10000,
                    }),
                    shortCall({ contracts: -3 }),
                    shortPut({ contracts: -3, expiry: '20260821' }),
                    callAssignment({
                        contracts: 3, brokerTimestamp: settlementTimestamp,
                    }),
                    putAssignment({
                        tradeDate: '2026-08-21', expiry: '20260821', contracts: 3,
                        brokerTimestamp: settlementTimestamp,
                    }),
                ];
                const ledger = core.computeLedger(events);
                assert.ok(ledger.rows.some((row) => row.runningShares < 0));
                assert.equal(ledger.combined.shares, 200);
                assert.equal(ledger.warnings.includes('net_short_shares'), false);
            },
        },
        {
            name: 'realized option premium raises a supported short-stock buy-back level',
            run() {
                const core = loadCore();
                const shortSale = event({
                    kind: 'share_trade', tradeDate: '2026-06-01',
                    shares: -100, price: 50, cashAmount: 5000,
                });
                const premium = shortPut({
                    tradeDate: '2026-06-02', contracts: -1, price: 1,
                    expiry: '20260717',
                });
                const open = core.computeLedger([shortSale, premium]).combined;
                assert.equal(open.isShort, true);
                assert.equal(open.stockAvgCost, 50);
                assert.equal(open.blendedCost, 50);
                assert.equal(open.blendedCostIfExpired, 51);

                const expired = event({
                    kind: 'option_expiry', tradeDate: '2026-07-17',
                    right: 'P', strike: 45, expiry: '20260717', contracts: 1,
                    sharesPerContract: 100, cashAmount: 0,
                });
                const closed = core.computeLedger(
                    [shortSale, premium, expired]).combined;
                assert.equal(closed.shares, -100);
                assert.equal(closed.blendedCost, 51);
                assert.equal(closed.breakEvenPrice, 51);
                assert.ok(closed.warnings.includes('net_short_shares'));
                assert.equal(core.summarizeCost(closed, 'net_cash').state, 'short');
            },
        },
        {
            name: 'a covered call assignment leaves no short warning',
            run() {
                const core = loadCore();
                const events = [
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 500, price: 40, cashAmount: -20000,
                    }),
                    shortCall(),
                    callAssignment(),
                ];
                const ledger = core.computeLedger(events);
                assert.equal(ledger.combined.shares, 0);
                assert.equal(ledger.warnings.includes('net_short_shares'), false);
            },
        },
        {
            name: 'a split scales shares and halves the average without touching cash',
            run() {
                const core = loadCore();
                const events = [
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 100, price: 40, cashAmount: -4000,
                    }),
                    event({
                        kind: 'split', tradeDate: '2026-03-01', account: '',
                        splitRatio: 2, cashAmount: 0,
                    }),
                ];
                const ledger = core.computeLedger(events);
                const summary = ledger.combined;
                assert.equal(summary.shares, 200);
                assert.equal(summary.stockAvgCost, 20);
                assert.equal(summary.netCash, -4000);
                assert.equal(summary.blendedCost, 20);
            },
        },
        {
            name: 'a book-wide split does not invent an empty account',
            run() {
                const core = loadCore();
                const events = [
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 100, price: 40, cashAmount: -4000,
                    }),
                    event({
                        kind: 'split', tradeDate: '2026-03-01', account: '',
                        splitRatio: 2, cashAmount: 0,
                    }),
                ];
                const ledger = core.computeLedger(events);
                assert.deepEqual(Array.from(ledger.accounts), ['U1111111']);
                assert.equal(ledger.perAccount[''], undefined);
            },
        },
        {
            name: 'a split across an open option is flagged for a human',
            run() {
                const core = loadCore();
                const events = [
                    shortPut({ tradeDate: '2026-01-05' }),
                    event({
                        kind: 'split', tradeDate: '2026-03-01', account: 'U1111111',
                        splitRatio: 2, cashAmount: 0,
                    }),
                ];
                const ledger = core.computeLedger(events);
                assert.ok(ledger.warnings.some(
                    (warning) => warning.startsWith('split_crosses_open_option:')));
            },
        },
        {
            name: 'the flow table running column tracks the split',
            run() {
                const core = loadCore();
                const events = [
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 100, price: 40, cashAmount: -4000,
                    }),
                    event({
                        kind: 'split', tradeDate: '2026-03-01', account: '',
                        splitRatio: 2, cashAmount: 0,
                    }),
                ];
                const rows = core.computeLedger(events).rows;
                assert.equal(rows[0].runningShares, 100);
                assert.equal(rows[1].runningShares, 200);
                assert.equal(rows[1].runningCostPerShare, 20);
            },
        },
        {
            name: 'an adjusted contract delivers its own multiplier',
            run() {
                const core = loadCore();
                const events = [
                    shortPut({ contracts: -1, sharesPerContract: 130, price: 1 }),
                    putAssignment({ contracts: 1, sharesPerContract: 130 }),
                ];
                const summary = core.computeLedger(events).combined;
                assert.equal(summary.shares, 130);
                assert.equal(summary.stockAvgCost, 45);
                assert.equal(summary.taxAvgCost, 44);
            },
        },
        {
            name: 'accounts are summarized separately and merged consistently',
            run() {
                const core = loadCore();
                const events = [
                    shortPut({ account: 'U1111111' }),
                    putAssignment({ account: 'U1111111' }),
                    shortPut({ account: 'U2222222', contracts: -2, strike: 40 }),
                    putAssignment({ account: 'U2222222', contracts: 2, strike: 40 }),
                ];
                const ledger = core.computeLedger(events);
                assert.deepEqual(Array.from(ledger.accounts), ['U1111111', 'U2222222']);
                assert.equal(ledger.perAccount.U1111111.shares, 500);
                assert.equal(ledger.perAccount.U2222222.shares, 200);
                assert.equal(ledger.combined.shares, 700);
                assert.equal(ledger.combined.stockAvgCost,
                    Math.round(((500 * 45 + 200 * 40) / 700) * 1e6) / 1e6);
            },
        },
        {
            name: 'an account filter narrows every total and the flow table',
            run() {
                const core = loadCore();
                const events = [
                    shortPut({ account: 'U1111111' }),
                    putAssignment({ account: 'U1111111' }),
                    shortPut({ account: 'U2222222', contracts: -2, strike: 40 }),
                ];
                const ledger = core.computeLedger(events, { accounts: ['U2222222'] });
                assert.deepEqual(Array.from(ledger.accounts), ['U2222222']);
                assert.equal(ledger.combined.shares, 0);
                assert.equal(ledger.rows.length, 1);
            },
        },
        {
            name: 'events are folded in trade-date order regardless of entry order',
            run() {
                const core = loadCore();
                // Recorded tail-first, the way back-filling actually happens.
                const assignment = putAssignment();
                const opened = shortPut();
                const ledger = core.computeLedger([assignment, opened]);
                assert.deepEqual(
                    Array.from(ledger.rows).map((row) => row.event.kind),
                    ['option_trade', 'option_assignment']);
                assert.equal(ledger.combined.realizedPremium, 600);
                assert.equal(ledger.combined.openPremium, 0);
            },
        },
        {
            name: 'voided rows stay in the audit trail but reach no total',
            run() {
                const core = loadCore();
                const voided = shortPut();
                voided.voidedAtUtc = '2026-06-02T00:00:00Z';
                const ledger = core.computeLedger(
                    [voided, shortPut({ tradeDate: '2026-06-03' })]);
                // Both rows are visible - an audit trail that hides its own
                // corrections is not an audit trail - but only the live one
                // moves the money.
                assert.equal(ledger.rows.length, 2);
                assert.equal(ledger.rows[0].voided, true);
                assert.equal(ledger.rows[1].voided, false);
                assert.equal(ledger.combined.optionPremiumNet, 600);
                assert.equal(ledger.combined.realizedPremium
                    + ledger.combined.openPremium, 600);
            },
        },
        {
            name: 'a voided row does not move the running columns',
            run() {
                const core = loadCore();
                const voided = shortPut({ tradeDate: '2026-06-02' });
                voided.voidedAtUtc = '2026-06-03T00:00:00Z';
                const rows = core.computeLedger([
                    event({
                        kind: 'opening_balance', tradeDate: '2026-06-01',
                        shares: 100, price: 40, cashAmount: -4000,
                    }),
                    voided,
                    shortPut({ tradeDate: '2026-06-04' }),
                ]).rows;
                assert.equal(rows[1].voided, true);
                // The running totals step straight from the row before it to
                // the row after it.
                assert.equal(rows[1].runningNetCash, rows[0].runningNetCash);
                assert.equal(rows[2].runningNetCash, -3400);
            },
        },
        {
            name: 'rows excluded from cost are shown but not counted',
            run() {
                const core = loadCore();
                const excluded = shortPut({ tradeDate: '2026-06-03' });
                excluded.includeInCost = false;
                const ledger = core.computeLedger([shortPut(), excluded]);
                assert.equal(ledger.rows.length, 2);
                assert.equal(ledger.rows[1].excluded, true);
                assert.equal(ledger.combined.optionPremiumNet, 600);
                const included = core.computeLedger(
                    [shortPut(), excluded], { includeExcluded: true });
                assert.equal(included.combined.optionPremiumNet, 1200);
            },
        },
        {
            name: 'a reference price yields break-even and liquidation figures',
            run() {
                const core = loadCore();
                const events = [shortPut(), putAssignment()];
                const summary = core.computeLedger(events, { referencePrice: 50 }).combined;
                assert.equal(summary.blendedCost, 43.8);
                assert.equal(summary.breakEvenPrice, 43.8);
                assert.equal(summary.liquidationValue, 25000);
                assert.equal(summary.lifetimeNetIfLiquidated, 3100);
                assert.equal(summary.unrealizedStockPnl, 2500);
            },
        },
        {
            name: 'open contracts are listed with the premium still at risk',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([shortPut(), shortCall({ tradeDate: '2026-06-02' })]);
                assert.equal(ledger.openOptions.length, 2);
                const put = ledger.openOptions.find((item) => item.right === 'P');
                assert.equal(put.contracts, -5);
                assert.equal(put.openPremium, 600);
            },
        },
        {
            name: 'an open credit is never counted as realized income',
            run() {
                const core = loadCore();
                // One contract still open, one opened in June and expired in
                // August. Only the second is income, and only in August.
                const ledger = core.computeLedger([
                    shortPut({ tradeDate: '2026-06-01', strike: 45, expiry: '20260918' }),
                    shortPut({ tradeDate: '2026-06-05', strike: 44, expiry: '20260717',
                               contracts: -1, price: 2 }),
                    event({
                        kind: 'option_expiry', tradeDate: '2026-08-20', right: 'P',
                        strike: 44, expiry: '20260717', contracts: 1,
                        sharesPerContract: 100, cashAmount: 0,
                    }),
                ]);
                assert.equal(core.realizedPremiumWindow(
                    ledger, { since: '2026-06-01', until: '2026-06-30' }), 0);
                assert.equal(core.realizedPremiumWindow(
                    ledger, { since: '2026-08-01', until: '2026-08-31' }), 200);
                // The open credit is still visible, just not as income.
                assert.equal(ledger.combined.openPremium, 600);
            },
        },
        {
            name: 'a contract opened and closed in different windows lands in the closing one',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    shortPut({ tradeDate: '2026-01-05', contracts: -1, price: 3 }),
                    shortPut({ tradeDate: '2026-06-10', contracts: 1, price: 1 }),
                ]);
                assert.equal(core.realizedPremiumWindow(
                    ledger, { since: '2026-01-01', until: '2026-01-31' }), 0);
                // 300 taken in, 100 paid to close: 200 realized in June.
                assert.equal(core.realizedPremiumWindow(
                    ledger, { since: '2026-06-01', until: '2026-06-30' }), 200);
            },
        },
        {
            name: 'reconciliation reports a balanced ledger as balanced',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([shortPut(), putAssignment()]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-07-20',
                    positions: [
                        { account: 'U1111111', secType: 'STK', symbol: 'TQQQ', position: 500 },
                    ],
                });
                assert.equal(result.balanced, true);
                assert.equal(result.mismatches.length, 0);
            },
        },
        {
            name: 'position rows follow TWS-style expiry order',
            run() {
                const core = loadCore();
                const rows = [
                    { kind: 'option', account: 'U1', label: 'TQQQ 20280121 P60',
                        expiry: '20280121', right: 'P', strike: 60 },
                    { kind: 'option', account: 'U1', label: 'TQQQ 20260904 C70.5',
                        expiry: '20260904', right: 'C', strike: 70.5 },
                    { kind: 'option', account: 'U1', label: 'TQQQ 20260902 P72',
                        expiry: '20260902', right: 'P', strike: 72 },
                    { kind: 'option', account: 'U1', label: 'TQQQ 20260902 C73',
                        expiry: '20260902', right: 'C', strike: 73 },
                    { kind: 'shares', account: 'U1', label: 'TQQQ shares' },
                    { kind: 'option', account: 'U1', label: 'TQQQ 20260902 C71',
                        expiry: '20260902', right: 'C', strike: 71 },
                ];
                assert.deepEqual(core.sortPositionRows(rows).map((row) => row.label), [
                    'TQQQ shares',
                    'TQQQ 20260902 C71',
                    'TQQQ 20260902 C73',
                    'TQQQ 20260902 P72',
                    'TQQQ 20260904 C70.5',
                    'TQQQ 20280121 P60',
                ]);
                assert.equal(rows[0].label, 'TQQQ 20280121 P60',
                    'sorting must not mutate the caller snapshot');
            },
        },
        {
            name: 'a vanished short put plus matching shares still requires trade history',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([shortPut()]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-07-20',
                    positions: [
                        { account: 'U1111111', secType: 'STK', symbol: 'TQQQ', position: 500 },
                    ],
                });
                const optionRow = result.rows.find((row) => row.kind === 'option');
                assert.equal(optionRow.status, 'ledger_only');
                assert.equal(optionRow.suggestion, null);
                assert.match(optionRow.advice, /TWS.*不证明历史现金流/);
                const shareRow = result.rows.find((row) => row.kind === 'shares');
                assert.equal(shareRow.unexplained, 500);
                assert.equal(shareRow.status, 'quantity_mismatch');
            },
        },
        {
            name: 'a vanished short call does not fabricate a delivery',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 500, price: 40, cashAmount: -20000,
                    }),
                    shortCall(),
                ]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-08-25',
                    positions: [],
                });
                const optionRow = result.rows.find((row) => row.kind === 'option');
                assert.equal(optionRow.suggestion, null);
                assert.match(optionRow.advice, /可能来自交割/);
            },
        },
        {
            name: 'a vanished long call does not fabricate an exercise',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    shortPut({ right: 'C', strike: 60, expiry: '20260821', contracts: 5,
                               price: 2 }),
                ]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-08-25',
                    positions: [
                        { account: 'U1111111', secType: 'STK', symbol: 'TQQQ', position: 500 },
                    ],
                });
                const optionRow = result.rows.find((row) => row.kind === 'option');
                assert.equal(optionRow.suggestion, null);
                assert.match(optionRow.advice, /请导入 CSV/);
            },
        },
        {
            name: 'a vanished option past expiry does not fabricate a zero-cash expiry',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([shortPut()]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-07-20',
                    positions: [],
                });
                const optionRow = result.rows.find((row) => row.kind === 'option');
                assert.equal(optionRow.suggestion, null);
                assert.match(optionRow.advice, /不能证明零现金作废/);
            },
        },
        {
            name: 'a vanished option before or on expiry never drafts a false expiry',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    shortPut({ expiry: '20260828', contracts: -1 }),
                ]);
                const before = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-08-26',
                    positions: [],
                }).rows.find((row) => row.kind === 'option');
                assert.equal(before.status, 'ledger_only');
                assert.equal(before.suggestion, null);
                assert.match(before.advice, /尚未到期/);

                const expiryDay = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-08-28',
                    positions: [],
                }).rows.find((row) => row.kind === 'option');
                assert.equal(expiryDay.suggestion, null);
                assert.match(expiryDay.advice, /尚未确认结算/);
            },
        },
        {
            name: 'matching shares cannot prove an early assignment by themselves',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    shortPut({ expiry: '20260828', contracts: -1 }),
                ]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-08-26',
                    positions: [{
                        account: 'U1111111', secType: 'STK',
                        symbol: 'TQQQ', position: 100,
                    }],
                });
                const row = result.rows.find((item) => item.kind === 'option');
                assert.equal(row.suggestion, null);
                assert.match(row.advice, /TWS.*不证明历史现金流/);
            },
        },
        {
            name: 'an increased short option position is never misread as assignment',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([shortPut({ contracts: -1 })]);
                const result = core.buildReconciliation({
                    ledger, symbol: 'TQQQ', today: '2026-08-26',
                    positions: [
                        { account: 'U1111111', secType: 'OPT', symbol: 'TQQQ',
                          right: 'P', strike: 45, expDate: '20260717',
                          multiplier: '100', position: -2 },
                        { account: 'U1111111', secType: 'STK', symbol: 'TQQQ',
                          position: 100 },
                    ],
                });
                const option = result.rows.find((row) => row.kind === 'option');
                assert.equal(option.difference, -1);
                assert.equal(option.suggestion, null);
                assert.match(option.advice, /数量增加或反向/);
            },
        },
        {
            name: 'one share gap cannot choose between two possible option deliveries',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    shortPut({ contracts: -1, strike: 69 }),
                    shortPut({ contracts: -1, strike: 70 }),
                ]);
                const result = core.buildReconciliation({
                    ledger, symbol: 'TQQQ', today: '2026-08-26',
                    positions: [{ account: 'U1111111', secType: 'STK',
                        symbol: 'TQQQ', position: 100 }],
                });
                const options = result.rows.filter((row) => row.kind === 'option');
                assert.equal(options.length, 2);
                options.forEach((row) => {
                    assert.equal(row.suggestion, null);
                    assert.match(row.advice, /请导入 CSV/);
                });
            },
        },
        {
            name: 'an option TWS holds is reported without fabricating a draft trade',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-07-20',
                    positions: [
                        {
                            account: 'U1111111', secType: 'OPT', symbol: 'TQQQ',
                            right: 'P', strike: 45, expDate: '20260918',
                            multiplier: '100', position: -3,
                        },
                    ],
                });
                const optionRow = result.rows.find((row) => row.kind === 'option');
                assert.equal(optionRow.status, 'tws_only');
                assert.equal(optionRow.suggestion, null);
                assert.match(optionRow.advice, /无均价/);
                assert.equal(core.buildTwsAdoptionEvent(optionRow, {
                    today: '2026-07-20',
                }), null);
            },
        },
        {
            name: 'an authoritative TWS-only option can be adopted at TWS average cost',
            run() {
                const core = loadCore();
                const result = core.buildReconciliation({
                    ledger: core.computeLedger([]),
                    symbol: 'TQQQ',
                    today: '2026-08-25',
                    positions: [{
                        account: 'U1111111', secType: 'OPT', symbol: 'TQQQ',
                        right: 'P', strike: 68.5, expDate: '20260828',
                        multiplier: '100', position: -1, conId: 998877,
                        localSymbol: 'TQQQ  260828P00068500', avgCostPerUnit: 1.23,
                    }],
                });
                const row = result.rows.find((item) => item.kind === 'option');
                const adopted = core.buildTwsAdoptionEvent(row, {
                    today: '2026-08-25', snapshotTimestamp: '2026-08-25T12:34:56',
                });
                assert.equal(row.status, 'tws_only');
                assert.equal(row.twsAvgCost, 1.23);
                assert.equal(adopted.kind, 'option_trade');
                assert.equal(adopted.tradeDate, '2026-08-25');
                assert.equal(adopted.contracts, -1);
                assert.equal(adopted.price, 1.23);
                assert.equal(adopted.cashAmount, 123);
                assert.equal(adopted.conId, 998877);
                assert.equal(adopted.source, 'reconcile');
                assert.equal(adopted.tag, 'tws_snapshot');
                assert.equal(adopted.brokerTimestamp, '2026-08-25T12:34:56');
                assert.match(adopted.note, /2026-08-25T12:34:56/);
            },
        },
        {
            name: 'a whole missing share position can be adopted but a partial gap cannot',
            run() {
                const core = loadCore();
                const position = {
                    account: 'U1111111', secType: 'STK', symbol: 'TQQQ',
                    position: 200, avgCostPerUnit: 68.2123,
                };
                const empty = core.buildReconciliation({
                    ledger: core.computeLedger([]), symbol: 'TQQQ',
                    today: '2026-08-25', positions: [position],
                });
                const emptyRow = empty.rows.find((item) => item.kind === 'shares');
                const adopted = core.buildTwsAdoptionEvent(
                    emptyRow, { today: '2026-08-25' });
                assert.equal(adopted.kind, 'opening_balance');
                assert.equal(adopted.shares, 200);
                assert.equal(adopted.price, 68.2123);
                assert.equal(adopted.cashAmount, -13642.46);

                const partial = core.buildReconciliation({
                    ledger: core.computeLedger([event({
                        kind: 'opening_balance', tradeDate: '2026-08-01',
                        shares: 100, price: 67, cashAmount: -6700,
                    })]),
                    symbol: 'TQQQ', today: '2026-08-25', positions: [position],
                });
                const partialRow = partial.rows.find((item) => item.kind === 'shares');
                assert.equal(core.buildTwsAdoptionEvent(
                    partialRow, { today: '2026-08-25' }), null);
            },
        },
        {
            name: 'a share gap with no history does not fabricate a share trade',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 500, price: 40, cashAmount: -20000,
                    }),
                ]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-07-20',
                    positions: [
                        { account: 'U1111111', secType: 'STK', symbol: 'TQQQ', position: 700 },
                    ],
                });
                const shareRow = result.rows.find((row) => row.kind === 'shares');
                assert.equal(shareRow.difference, 200);
                assert.equal(shareRow.suggestion, null);
                assert.match(shareRow.advice, /当前状态/);
            },
        },
        {
            name: 'positions for other symbols and other products are ignored',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-07-20',
                    positions: [
                        { account: 'U1111111', secType: 'STK', symbol: 'SQQQ', position: 900 },
                        { account: 'U1111111', secType: 'FUT', symbol: 'TQQQ', position: 2 },
                    ],
                });
                assert.equal(result.balanced, true);
                assert.equal(result.rows.length, 0);
            },
        },
        {
            name: 'reconciliation keeps accounts apart',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([shortPut({ account: 'U1111111' })]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-07-20',
                    positions: [
                        { account: 'U2222222', secType: 'STK', symbol: 'TQQQ', position: 500 },
                    ],
                });
                // The other account's shares must not explain this account's
                // missing contract.
                const optionRow = result.rows.find((row) => row.kind === 'option');
                assert.equal(optionRow.account, 'U1111111');
                assert.equal(optionRow.suggestion, null);
                assert.match(optionRow.advice, /零现金作废/);
                const otherAccount = result.rows.find(
                    (row) => row.kind === 'shares' && row.account === 'U2222222');
                assert.equal(otherAccount.difference, 500);
            },
        },
        {
            name: 'summarizeCost renders each lens off the same ledger',
            run() {
                const core = loadCore();
                const summary = core.computeLedger([shortPut(), putAssignment()]).combined;
                assert.equal(core.summarizeCost(summary, 'net_cash').value, 43.8);
                assert.equal(core.summarizeCost(summary, 'stock_only').value, 45);
                assert.equal(core.summarizeCost(summary, 'tax_adjusted').value, 43.8);
                assert.equal(core.summarizeCost(summary, 'nonsense').mode, 'net_cash');
                assert.equal(core.summarizeCost(null, 'net_cash').available, false);
            },
        },
        {
            name: 'a batch that closes what it never opened is reported, with the size of the gap',
            run() {
                const core = loadCore();
                // A statement that starts mid-life: the close is in the file,
                // the opening is not.
                const closed = putAssignment({ contracts: 5 });
                const gaps = core.findUnbackedCloses([closed], {});
                assert.equal(gaps.length, 1);
                assert.equal(gaps[0].missingContracts, -5);
                assert.equal(gaps[0].expiry, '20260717');
                assert.equal(gaps[0].firstDate, '2026-07-17');
            },
        },
        {
            name: 'a close the batch itself opened reports no gap',
            run() {
                const core = loadCore();
                const gaps = core.findUnbackedCloses(
                    [shortPut({ contracts: -5 }), putAssignment({ contracts: 5 })], {});
                assert.deepEqual(Array.from(gaps), []);
            },
        },
        {
            name: 'positions the ledger already holds close the gap',
            run() {
                const core = loadCore();
                const closed = putAssignment({ contracts: 5 });
                const gaps = core.findUnbackedCloses([closed], {
                    existingOpen: [{
                        account: 'U1111111', right: 'P', strike: 45,
                        expiry: '20260717', contracts: -5, sharesPerContract: 100,
                    }],
                });
                assert.deepEqual(Array.from(gaps), []);
            },
        },
        {
            name: 'a partial gap reports only the missing part',
            run() {
                const core = loadCore();
                const gaps = core.findUnbackedCloses(
                    [shortPut({ contracts: -2 }), putAssignment({ contracts: 5 })], {});
                assert.equal(gaps.length, 1);
                assert.equal(gaps[0].missingContracts, -3);
            },
        },
        {
            name: 'one contract reports one gap, not one per later row',
            run() {
                const core = loadCore();
                const gaps = core.findUnbackedCloses([
                    putAssignment({ tradeDate: '2026-07-17', contracts: 3 }),
                    putAssignment({ tradeDate: '2026-07-18', contracts: 2 }),
                ], {});
                assert.equal(gaps.length, 1);
                assert.equal(gaps[0].missingContracts, -5);
                assert.equal(gaps[0].firstDate, '2026-07-17');
            },
        },
        {
            name: 'an exercised long reports a long opening, not a short one',
            run() {
                const core = loadCore();
                const gaps = core.findUnbackedCloses([event({
                    kind: 'option_exercise', tradeDate: '2026-08-21', right: 'C',
                    strike: 60, expiry: '20260821', contracts: -3, shares: 300,
                    sharesPerContract: 100, price: 60, cashAmount: -18000,
                })], {});
                assert.equal(gaps.length, 1);
                assert.equal(gaps[0].missingContracts, 3);
            },
        },
        {
            name: 'opening stubs make an unbacked batch whole without inventing premium',
            run() {
                const core = loadCore();
                const batch = [putAssignment({ contracts: 5 })];
                const gaps = core.findUnbackedCloses(batch, {});
                const stubs = core.buildPriorOpenDrafts(gaps, { tradeDate: '2026-06-30' });
                assert.equal(stubs.length, 1);
                assert.equal(stubs[0].kind, 'option_trade');
                assert.equal(stubs[0].contracts, -5);
                assert.equal(stubs[0].tradeDate, '2026-06-30');
                assert.equal(stubs[0].tag, 'prior_open');
                // Premium is unknown; it must be zero and visible, not guessed.
                assert.equal(stubs[0].price, 0);
                assert.equal(stubs[0].cashAmount, 0);
                const repaired = stubs.concat(batch).map(
                    (item, index) => Object.assign({ seq: index + 1 }, item));
                assert.deepEqual(Array.from(core.findUnbackedCloses(repaired, {})), []);
            },
        },
        {
            name: 'gap detection ignores voided rows and never throws on junk',
            run() {
                const core = loadCore();
                const voided = putAssignment({ contracts: 5 });
                voided.voidedAtUtc = '2026-07-18T00:00:00Z';
                assert.deepEqual(Array.from(core.findUnbackedCloses([voided], {})), []);
                for (const input of [null, undefined, 'nope', [null], [{}]]) {
                    assert.ok(Array.isArray(core.findUnbackedCloses(input, {})));
                }
                assert.deepEqual(Array.from(core.buildPriorOpenDrafts(null, {})), []);
            },
        },
        {
            name: 'rolling at a loss moves the two lenses in opposite directions',
            run() {
                const core = loadCore();
                const held = [
                    event({
                        kind: 'opening_balance', tradeDate: '2026-08-24',
                        shares: 200, price: 70.5, cashAmount: -14100,
                    }),
                    // Short put collected 235.58, bought back for 421.12.
                    event({
                        kind: 'option_trade', tradeDate: '2026-08-24', right: 'P',
                        strike: 68, expiry: '20260826', contracts: -2, price: 1.18,
                        sharesPerContract: 100, fees: 0.42, cashAmount: 235.58,
                    }),
                ];
                const before = core.computeLedger(held).combined;
                const rolled = held.concat([
                    event({
                        kind: 'option_trade', tradeDate: '2026-08-25', right: 'P',
                        strike: 68, expiry: '20260826', contracts: 2, price: 2.10,
                        sharesPerContract: 100, fees: 1.12, cashAmount: -421.12,
                    }),
                    event({
                        kind: 'option_trade', tradeDate: '2026-08-25', right: 'P',
                        strike: 67, expiry: '20260902', contracts: -2, price: 2.55,
                        sharesPerContract: 100, fees: 1.12, cashAmount: 508.88,
                    }),
                ]);
                const after = core.computeLedger(rolled).combined;

                // The closed contract's whole life is realized: 235.58 in,
                // 421.12 out.
                assert.equal(after.realizedPremium, -185.54);
                assert.equal(after.openPremium, 508.88);
                // Locking in a 185.54 loss RAISES the conservative cost...
                assert.equal(
                    Math.round((after.blendedCost - before.blendedCost) * 1e4) / 1e4,
                    0.9277);
                // ...while the net 87.76 credit LOWERS the if-expired cost.
                assert.equal(
                    Math.round((before.blendedCostIfExpired
                        - after.blendedCostIfExpired) * 1e4) / 1e4,
                    0.4388);
                assert.equal(after.shares, 200);
            },
        },
        {
            name: 'closing a long and closing a short both flow through cash',
            run() {
                const core = loadCore();
                // A long bought for 738.69 and sold for 1154.28 realizes the
                // difference; nothing is left open.
                const ledger = core.computeLedger([
                    event({
                        kind: 'option_trade', tradeDate: '2026-08-07', right: 'C',
                        strike: 399, expiry: '20260821', contracts: 1, price: 7.38,
                        sharesPerContract: 100, fees: 0.69, cashAmount: -738.69,
                    }),
                    event({
                        kind: 'option_trade', tradeDate: '2026-08-20', right: 'C',
                        strike: 399, expiry: '20260821', contracts: -1, price: 11.55,
                        sharesPerContract: 100, fees: 0.72, cashAmount: 1154.28,
                    }),
                ]).combined;
                assert.equal(ledger.realizedPremium, 415.59);
                assert.equal(ledger.openPremium, 0);
                assert.equal(ledger.netCash, 415.59);
            },
        },
        {
            name: 'a ledger past one page still totals the whole book',
            run() {
                const core = loadCore();
                // 150 rows: more than the flow table's page size, so a page
                // is provably not the ledger.
                const events = [event({
                    kind: 'opening_balance', tradeDate: '2026-01-01',
                    shares: 100, price: 40, cashAmount: -4000,
                })];
                for (let index = 0; index < 149; index += 1) {
                    const day = String((index % 28) + 1).padStart(2, '0');
                    const month = String((index % 9) + 1).padStart(2, '0');
                    events.push(shortPut({
                        tradeDate: `2026-${month}-${day}`,
                        strike: 30 + index,
                        expiry: '20261218',
                        contracts: -1,
                        price: 1,
                    }));
                }
                const full = core.computeLedger(events).combined;
                assert.equal(events.length, 150);
                assert.equal(full.optionPremiumNet, 149 * 100);
                assert.equal(full.shares, 100);

                // The first hundred rows alone answer a different question -
                // which is exactly why the page must never compute from a page.
                const firstPage = core.computeLedger(events.slice(0, 100)).combined;
                assert.notEqual(firstPage.optionPremiumNet, full.optionPremiumNet);
                // Every row is represented in the flow rows, so the table can
                // page a complete, correctly-anchored timeline locally.
                assert.equal(core.computeLedger(events).rows.length, 150);
            },
        },
        {
            name: 'running columns stay anchored to the whole timeline',
            run() {
                const core = loadCore();
                const events = [
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 100, price: 40, cashAmount: -4000,
                    }),
                    shortPut({ tradeDate: '2026-02-01', contracts: -1, price: 1 }),
                    shortPut({ tradeDate: '2026-03-01', contracts: -1, price: 1 }),
                ];
                const rows = core.computeLedger(events).rows;
                // A later row's running total includes everything before it,
                // so slicing the array for display keeps the numbers honest.
                assert.equal(rows[2].runningShares, 100);
                assert.equal(rows[2].runningNetCash, -3800);
            },
        },
        {
            name: 'a standard and an adjusted contract never merge',
            run() {
                const core = loadCore();
                const standard = shortPut({ contracts: -1, sharesPerContract: 100, price: 1 });
                const adjusted = shortPut({ contracts: -1, sharesPerContract: 130, price: 1 });
                const ledger = core.computeLedger([standard, adjusted]);
                assert.equal(ledger.openOptions.length, 2);
                const sizes = Array.from(ledger.openOptions)
                    .map((item) => item.sharesPerContract).sort();
                assert.deepEqual(sizes, [100, 130]);
                assert.notEqual(core.contractKey(standard), core.contractKey(adjusted));
                // And reconciliation matches each against its own TWS row.
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-06-02',
                    defaultSharesPerContract: 100,
                    positions: [
                        { account: 'U1111111', secType: 'OPT', symbol: 'TQQQ', right: 'P',
                          strike: 45, expDate: '20260717', multiplier: '100', position: -1 },
                        { account: 'U1111111', secType: 'OPT', symbol: 'TQQQ', right: 'P',
                          strike: 45, expDate: '20260717', multiplier: '130', position: -1 },
                    ],
                });
                assert.equal(result.mismatches.length, 0);
            },
        },
        {
            name: 'a trade that crosses zero settles the old lot and opens a new one',
            run() {
                const core = loadCore();
                const trade = (day, shares, price, fees) => event({
                    kind: 'share_trade', tradeDate: `2026-06-0${day}`, shares, price,
                    fees: fees || 0, cashAmount: -(shares * price) - (fees || 0),
                });
                // Long 100 @10, then sell 200 @20: 100 closes at a 1000 gain
                // and 100 opens short at 20 - not one block at the old average.
                let summary = core.computeLedger([
                    trade(1, 100, 10), trade(2, -200, 20)]).combined;
                assert.equal(summary.shares, -100);
                assert.equal(summary.stockAvgCost, 20);
                assert.equal(summary.stockRealizedPnl, 1000);

                // Short 100 @20, then buy 200 @10: covering profits 1000.
                summary = core.computeLedger([
                    trade(1, -100, 20), trade(2, 200, 10)]).combined;
                assert.equal(summary.shares, 100);
                assert.equal(summary.stockAvgCost, 10);
                assert.equal(summary.stockRealizedPnl, 1000);

                // A partial close leaves the surviving lot at its own average.
                summary = core.computeLedger([
                    trade(1, 200, 10), trade(2, -50, 20)]).combined;
                assert.equal(summary.shares, 150);
                assert.equal(summary.stockAvgCost, 10);
                assert.equal(summary.stockRealizedPnl, 500);
            },
        },
        {
            name: 'fees on a crossing trade are split between the two parts',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({ kind: 'share_trade', tradeDate: '2026-06-01', shares: 100,
                            price: 10, fees: 0, cashAmount: -1000 }),
                    event({ kind: 'share_trade', tradeDate: '2026-06-02', shares: -200,
                            price: 20, fees: 10, cashAmount: 3990 }),
                ]).combined;
                // Half the 10 of fees belongs to the closed 100 shares and
                // half to the 100 that opened short.
                assert.equal(ledger.stockRealizedPnl, 995);
                assert.equal(ledger.stockAvgCost, 19.95);
            },
        },
        {
            name: 'two contract numbers under one structural key are never merged',
            run() {
                const core = loadCore();
                // SPX and SPXW can share an account, a right, a strike, an
                // expiry AND a multiplier. Netting them would blend two
                // unrelated positions.
                const base = {
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', sharesPerContract: 100,
                    price: 1, cashAmount: 100,
                };
                const ledger = core.computeLedger([
                    event(Object.assign({}, base, { conId: 111, contracts: -1 })),
                    event(Object.assign({}, base, { conId: 222, contracts: -1 })),
                ]);
                assert.ok(ledger.warnings.some(
                    (warning) => warning.startsWith('contract_identity_conflict:')));
                assert.equal(ledger.openOptions.length, 2);
                assert.deepEqual(Array.from(
                    ledger.openOptions, (item) => item.contracts), [-1, -1]);
                assert.deepEqual(Array.from(
                    ledger.openOptions, (item) => item.conId), ['111', '222']);
                assert.equal(ledger.openOptions.some(
                    (item) => item.identityConflict), false);
            },
        },
        {
            name: 'opposite positions with different contract numbers never cancel',
            run() {
                const core = loadCore();
                const base = {
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', sharesPerContract: 100,
                    price: 1,
                };
                const ledger = core.computeLedger([
                    event(Object.assign({}, base, {
                        conId: 111, contracts: -1, cashAmount: 100 })),
                    event(Object.assign({}, base, {
                        conId: 222, contracts: 1, cashAmount: -50 })),
                ]);
                assert.equal(ledger.openOptions.length, 2);
                assert.deepEqual(Array.from(
                    ledger.openOptions, (item) => item.contracts).sort(), [-1, 1]);
                assert.equal(ledger.combined.realizedPremium, 0);
                assert.equal(ledger.combined.openPremium, 50);
            },
        },
        {
            name: 'one contract number across many rows raises no conflict',
            run() {
                const core = loadCore();
                const base = {
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', sharesPerContract: 100,
                    price: 1, cashAmount: 100, conId: 111,
                };
                const ledger = core.computeLedger([
                    event(Object.assign({}, base, { contracts: -1 })),
                    event(Object.assign({}, base, { contracts: -1 })),
                ]);
                assert.equal(ledger.warnings.length, 0);
                assert.equal(ledger.openOptions[0].identityConflict, false);
                assert.equal(ledger.openOptions[0].contracts, -2);
            },
        },
        {
            name: 'a row with no contract number still folds with an identified one',
            run() {
                const core = loadCore();
                // Hand entry has no conId while an imported row does; they
                // must still be the same contract, or reconciliation would
                // split the very rows it exists to match.
                const base = {
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', sharesPerContract: 100,
                    price: 1, cashAmount: 100,
                };
                const ledger = core.computeLedger([
                    event(Object.assign({}, base, { conId: 111, contracts: -1 })),
                    event(Object.assign({}, base, { contracts: -1 })),
                ]);
                assert.equal(ledger.openOptions.length, 1);
                assert.equal(ledger.openOptions[0].contracts, -2);
                assert.equal(ledger.openOptions[0].identityConflict, false);
            },
        },
        {
            name: 'an unmapped local symbol never folds into the sole conId',
            run() {
                const core = loadCore();
                const base = {
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', sharesPerContract: 100,
                    price: 1,
                };
                const ledger = core.computeLedger([
                    event(Object.assign({}, base, {
                        conId: 111, localSymbol: 'AAA', contracts: -1,
                        cashAmount: 100,
                    })),
                    event(Object.assign({}, base, {
                        localSymbol: 'BBB', contracts: 1, cashAmount: -50,
                    })),
                ]);
                assert.equal(ledger.openOptions.length, 2);
                assert.deepEqual(Array.from(
                    ledger.openOptions, (item) => item.contracts).sort(), [-1, 1]);
                assert.equal(ledger.combined.realizedPremium, 0);
                assert.equal(ledger.combined.openPremium, 50);
                assert.ok(ledger.warnings.some(
                    (warning) => warning.startsWith('contract_identity_ambiguous:')));
            },
        },
        {
            name: 'an ambiguous contract is never reported as reconciled',
            run() {
                const core = loadCore();
                const base = {
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', sharesPerContract: 100,
                    price: 1, cashAmount: 100,
                };
                const ledger = core.computeLedger([
                    event(Object.assign({}, base, { conId: 111, contracts: -1 })),
                    event(Object.assign({}, base, { conId: 222, contracts: -1 })),
                ]);
                const result = core.buildReconciliation({
                    ledger,
                    symbol: 'TQQQ',
                    today: '2026-06-02',
                    defaultSharesPerContract: 100,
                    positions: [{
                        account: 'U1111111', secType: 'OPT', symbol: 'TQQQ', right: 'P',
                        strike: 45, expDate: '20260717', multiplier: '100', position: -2,
                    }],
                });
                const row = result.rows.find(
                    (item) => item.status === 'identity_conflict');
                // The quantities agree, but agreeing on a blended total is a
                // coincidence, not a reconciliation.
                assert.equal(row.status, 'identity_conflict');
                assert.equal(row.suggestion, null);
                assert.equal(result.balanced, false);
                assert.equal(result.identityConflicts.length, 1);
            },
        },
        {
            name: 'two precisely identified contracts reconcile independently',
            run() {
                const core = loadCore();
                const base = {
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', sharesPerContract: 100,
                    price: 1, cashAmount: 100,
                };
                const ledger = core.computeLedger([
                    event(Object.assign({}, base, { conId: 111, contracts: -1 })),
                    event(Object.assign({}, base, { conId: 222, contracts: -1 })),
                ]);
                const positions = [111, 222].map((conId) => ({
                    account: 'U1111111', secType: 'OPT', symbol: 'TQQQ', right: 'P',
                    strike: 45, expDate: '20260717', multiplier: '100',
                    position: -1, conId,
                }));
                const result = core.buildReconciliation({
                    ledger, symbol: 'TQQQ', today: '2026-06-02', positions,
                });
                assert.equal(result.balanced, true);
                assert.equal(result.identityConflicts.length, 0);
                assert.equal(result.rows.filter(
                    (item) => item.kind === 'option').length, 2);
            },
        },
        {
            name: 'FUT rolls carry their spread and fees into the current contract cost',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'futures_trade', tradeDate: '2026-08-01',
                        futureExpiry: '202609', futureContracts: 1,
                        sharesPerContract: 50, price: 5000, cashAmount: 0,
                    }),
                    event({
                        kind: 'option_trade', optionSecType: 'FOP',
                        tradeDate: '2026-08-02', right: 'P', strike: 4900,
                        expiry: '20260821', contracts: -1,
                        sharesPerContract: 50, price: 10, cashAmount: 500,
                    }),
                    event({
                        kind: 'option_expiry', optionSecType: 'FOP',
                        tradeDate: '2026-08-21', right: 'P', strike: 4900,
                        expiry: '20260821', contracts: 1,
                        sharesPerContract: 50, cashAmount: 0,
                    }),
                    event({
                        kind: 'futures_roll', tradeDate: '2026-08-24',
                        futureExpiry: '202609', futureContracts: 1,
                        sharesPerContract: 50, price: 5100,
                        rollToExpiry: '202612', rollToPrice: 5120,
                        rollGroup: 'roll-1', fees: 100, cashAmount: -100,
                    }),
                ], { secType: 'FUT' });
                assert.equal(ledger.combined.futuresContracts, 1);
                assert.equal(ledger.combined.futuresAvgCost, 5120);
                // 5000 + (5120 - 5100) + 100/50 - 500/50.
                assert.equal(ledger.combined.blendedCost, 5012);
                assert.equal(ledger.openFutures[0].expiry, '202612');
            },
        },
        {
            name: 'YYYYMM and YYYYMMDD identify the same FUT delivery month',
            run() {
                const core = loadCore();
                assert.equal(core.futureKey({
                    account: 'U1', futureExpiry: '202609', sharesPerContract: 50,
                }), core.futureKey({
                    account: 'U1', futureExpiry: '20260918', sharesPerContract: 50,
                }));
            },
        },
        {
            name: 'combined FUT lifetime cash includes every account settlement adjustment',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({ kind: 'manual_adjust', tradeDate: '2026-08-01',
                        account: 'U1111111', cashAmount: -40, note: 'settlement' }),
                    event({ kind: 'manual_adjust', tradeDate: '2026-08-01',
                        account: 'U2222222', cashAmount: -60, note: 'settlement' }),
                ], { secType: 'FUT' });
                assert.equal(ledger.perAccount.U1111111.lifetimeNetCash, -40);
                assert.equal(ledger.perAccount.U2222222.lifetimeNetCash, -60);
                assert.equal(ledger.combined.lifetimeNetCash, -100);
            },
        },
        {
            name: 'open FOP premium is hypothetical until expiry or close',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'futures_trade', tradeDate: '2026-08-01',
                        futureExpiry: '202609', futureContracts: 1,
                        sharesPerContract: 50, price: 5000, cashAmount: 0,
                    }),
                    event({
                        kind: 'option_trade', optionSecType: 'FOP',
                        tradeDate: '2026-08-02', right: 'P', strike: 4900,
                        expiry: '20260918', contracts: -1,
                        sharesPerContract: 50, price: 10, cashAmount: 500,
                    }),
                ], { secType: 'FUT' });
                assert.equal(ledger.combined.blendedCost, 5000);
                assert.equal(ledger.combined.blendedCostIfExpired, 4990);
            },
        },
        {
            name: 'an early FOP close applies only its net realized premium',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'futures_trade', tradeDate: '2026-08-01',
                        futureExpiry: '202609', futureContracts: 1,
                        sharesPerContract: 50, price: 5000, cashAmount: 0,
                    }),
                    event({
                        kind: 'option_trade', optionSecType: 'FOP',
                        tradeDate: '2026-08-02', right: 'P', strike: 4900,
                        expiry: '20260918', contracts: -1,
                        sharesPerContract: 50, price: 10, cashAmount: 500,
                    }),
                    event({
                        kind: 'option_trade', optionSecType: 'FOP',
                        tradeDate: '2026-08-10', right: 'P', strike: 4900,
                        expiry: '20260918', contracts: 1,
                        sharesPerContract: 50, price: 4, cashAmount: -200,
                    }),
                ], { secType: 'FUT' });
                assert.equal(ledger.combined.realizedPremium, 300);
                assert.equal(ledger.combined.openPremium, 0);
                assert.equal(ledger.combined.blendedCost, 4994);
            },
        },
        {
            name: 'realized FOP income raises a short FUT break-even sale price',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'futures_trade', tradeDate: '2026-08-01',
                        futureExpiry: '202609', futureContracts: -1,
                        sharesPerContract: 50, price: 5000, cashAmount: 0,
                    }),
                    event({
                        kind: 'option_trade', optionSecType: 'FOP',
                        tradeDate: '2026-08-02', right: 'C', strike: 5200,
                        expiry: '20260821', contracts: -1,
                        sharesPerContract: 50, price: 10, cashAmount: 500,
                    }),
                    event({
                        kind: 'option_expiry', optionSecType: 'FOP',
                        tradeDate: '2026-08-21', right: 'C', strike: 5200,
                        expiry: '20260821', contracts: 1,
                        sharesPerContract: 50, cashAmount: 0,
                    }),
                ], { secType: 'FUT' });
                assert.equal(ledger.combined.blendedCost, 5010);
                assert.equal(ledger.combined.isShort, true);
            },
        },
        {
            name: 'the same roll equation carries a short FUT basis',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'futures_trade', tradeDate: '2026-08-01',
                        futureExpiry: '202609', futureContracts: -1,
                        sharesPerContract: 50, price: 5000, cashAmount: 0,
                    }),
                    event({
                        kind: 'futures_roll', tradeDate: '2026-08-24',
                        futureExpiry: '202609', futureContracts: -1,
                        sharesPerContract: 50, price: 4900,
                        rollToExpiry: '202612', rollToPrice: 4880,
                        rollGroup: 'short-roll', cashAmount: 0,
                    }),
                ], { secType: 'FUT' });
                assert.equal(ledger.combined.futuresAvgCost, 4880);
                assert.equal(ledger.combined.blendedCost, 4980);
                assert.equal(ledger.combined.isShort, true);
            },
        },
        {
            name: 'opposite FUT directions never collapse into a fake blended cost',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'futures_trade', tradeDate: '2026-08-01',
                        futureExpiry: '202609', futureContracts: 1,
                        sharesPerContract: 50, price: 5000, cashAmount: 0,
                    }),
                    event({
                        kind: 'futures_trade', tradeDate: '2026-08-02',
                        futureExpiry: '202612', futureContracts: -1,
                        sharesPerContract: 50, price: 5100, cashAmount: 0,
                    }),
                ], { secType: 'FUT' });
                assert.equal(ledger.combined.blendedCost, null);
                assert.equal(ledger.combined.hasFutures, false);
                assert.ok(ledger.warnings.includes('mixed_future_directions'));
            },
        },
        {
            name: 'FOP assignment opens the delivered FUT at strike without notional cash',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'option_trade', optionSecType: 'FOP',
                        tradeDate: '2026-08-01', right: 'P', strike: 5000,
                        expiry: '20260821', contracts: -1,
                        sharesPerContract: 50, price: 50, cashAmount: 2500,
                    }),
                    event({
                        kind: 'option_assignment', optionSecType: 'FOP',
                        tradeDate: '2026-08-21', right: 'P', strike: 5000,
                        expiry: '20260821', contracts: 1,
                        sharesPerContract: 50, futureExpiry: '202609',
                        futureContracts: 1, price: 5000, cashAmount: 0,
                    }),
                ], { secType: 'FUT' });
                assert.equal(ledger.combined.futuresAvgCost, 5000);
                assert.equal(ledger.combined.realizedPremium, 2500);
                assert.equal(ledger.combined.blendedCost, 4950);
                assert.equal(ledger.combined.netCash, 2500);
            },
        },
        {
            name: 'FUT and FOP TWS rows reconcile without being filtered out',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'futures_trade', tradeDate: '2026-08-01',
                        futureExpiry: '202609', futureConId: 1001,
                        futureContracts: 1, sharesPerContract: 50,
                        price: 5000, cashAmount: 0,
                    }),
                    event({
                        kind: 'option_trade', optionSecType: 'FOP',
                        tradeDate: '2026-08-02', right: 'C', strike: 5200,
                        expiry: '20260918', conId: 2001, contracts: -1,
                        sharesPerContract: 50, price: 10, cashAmount: 500,
                    }),
                ], { secType: 'FUT' });
                const result = core.buildReconciliation({
                    ledger, secType: 'FUT', symbol: 'ES',
                    positions: [
                        { account: 'U1111111', secType: 'FUT', symbol: 'ES',
                          expDate: '202609', conId: 1001, multiplier: '50', position: 1 },
                        { account: 'U1111111', secType: 'FOP', symbol: 'ES',
                          expDate: '20260918', right: 'C', strike: 5200,
                          conId: 2001, multiplier: '50', position: -1 },
                    ],
                });
                assert.equal(result.rows.length, 2);
                assert.equal(result.balanced, true);
                assert.deepEqual(Array.from(result.rows, (row) => row.kind).sort(),
                    ['future', 'option']);
            },
        },
        {
            name: 'a possible FOP delivery blocks adopting only the new FUT baseline',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([event({
                    kind: 'option_trade', optionSecType: 'FOP',
                    tradeDate: '2026-08-01', right: 'P', strike: 5000,
                    expiry: '20260821', contracts: -1,
                    sharesPerContract: 50, price: 50, cashAmount: 2500,
                })], { secType: 'FUT' });
                const result = core.buildReconciliation({
                    ledger, secType: 'FUT', symbol: 'ES', today: '2026-08-26',
                    positions: [{ account: 'U1111111', secType: 'FUT', symbol: 'ES',
                        expDate: '20260918', conId: 1001, multiplier: '50',
                        position: 1, avgCostPerUnit: 5000 }],
                });
                const future = result.rows.find((row) => row.kind === 'future');
                const option = result.rows.find((row) => row.kind === 'option');
                assert.equal(future.adoptionBlocked, true);
                assert.equal(future.possibleDelivery, true);
                assert.equal(option.possibleDelivery, true);
                assert.equal(core.buildTwsAdoptionEvent(future, {
                    secType: 'FUT', today: '2026-08-26',
                }), null);
            },
        },
        {
            name: 'a premium-less prior opening marks the headline itself incomplete',
            run() {
                const core = loadCore();
                // The warning list below the table is not enough: a bare
                // number at the top of the page reads as a finished answer.
                const ledger = core.computeLedger([
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 100, price: 40, cashAmount: -4000,
                    }),
                    event({
                        kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                        strike: 45, expiry: '20260918', contracts: -1,
                        sharesPerContract: 100, price: 0, cashAmount: 0,
                        tag: 'prior_open',
                    }),
                ]);
                assert.equal(ledger.combined.costIncomplete, true);
                assert.equal(ledger.perAccount.U1111111.costIncomplete, true);
                assert.equal(
                    core.summarizeCost(ledger.combined, 'net_cash').costIncomplete, true);
                assert.ok(ledger.warnings.some(
                    (warning) => warning.startsWith('unknown_prior_open:')));
            },
        },
        {
            name: 'a basis-restored opening is complete and must not be flagged',
            run() {
                const core = loadCore();
                // prior_basis carries the broker's own Basis figure, so the
                // cost IS known; flagging it would cry wolf on every import.
                const ledger = core.computeLedger([
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        shares: 100, price: 40, cashAmount: -4000,
                    }),
                    event({
                        kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                        strike: 45, expiry: '20260918', contracts: -1,
                        sharesPerContract: 100, price: 0, cashAmount: -3371.21,
                        tag: 'prior_basis',
                    }),
                ]);
                assert.equal(ledger.combined.costIncomplete, false);
                assert.equal(
                    core.summarizeCost(ledger.combined, 'net_cash').costIncomplete, false);
                assert.equal(ledger.warnings.length, 0);
            },
        },
        {
            name: 'a closed-out book still reports its cost as incomplete',
            run() {
                const core = loadCore();
                // The shape a fully-closed prior position leaves: no shares,
                // so the headline shows a lifetime realized figure instead -
                // and that figure is just as incomplete as a per-share cost.
                const ledger = core.computeLedger([
                    event({
                        kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                        strike: 45, expiry: '20260717', contracts: -1,
                        sharesPerContract: 100, price: 0, cashAmount: 0,
                        tag: 'prior_open',
                    }),
                    event({
                        kind: 'option_expiry', tradeDate: '2026-07-17', right: 'P',
                        strike: 45, expiry: '20260717', contracts: 1,
                        sharesPerContract: 100, cashAmount: 0,
                    }),
                ]);
                const rendered = core.summarizeCost(ledger.combined, 'net_cash');
                assert.equal(rendered.available, false);
                assert.equal(rendered.state, 'no_shares');
                assert.equal(rendered.costIncomplete, true);
            },
        },
        {
            name: 'every summarizeCost path answers the completeness question',
            run() {
                const core = loadCore();
                // undefined would render as "not incomplete" at the call site,
                // which is the silent failure this flag exists to prevent.
                const clean = core.computeLedger([event({
                    kind: 'opening_balance', tradeDate: '2026-01-01',
                    shares: 100, price: 40, cashAmount: -4000,
                })]);
                [core.summarizeCost(null, 'net_cash'),
                    core.summarizeCost(clean.combined, 'net_cash'),
                    core.summarizeCost(core.computeLedger([]).combined, 'net_cash'),
                ].forEach((rendered) => {
                    assert.equal(typeof rendered.costIncomplete, 'boolean');
                });
            },
        },
        {
            name: 'an account-filtered view still applies a book-wide split',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        account: 'U1', shares: 100, price: 10, cashAmount: -1000,
                    }),
                    event({
                        kind: 'opening_balance', tradeDate: '2026-01-01',
                        account: 'U2', shares: 50, price: 20, cashAmount: -1000,
                    }),
                    event({
                        kind: 'split', tradeDate: '2026-03-01', account: '',
                        splitRatio: 2, cashAmount: 0,
                    }),
                ], { accounts: ['U1'] });
                assert.equal(ledger.combined.shares, 200);
                assert.equal(ledger.combined.stockAvgCost, 5);
                assert.deepEqual(Array.from(ledger.accounts), ['U1']);
            },
        },
        {
            name: 'local-symbol whitespace is presentation, not contract identity',
            run() {
                const core = loadCore();
                const opened = event({
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', contracts: -1,
                    sharesPerContract: 100, price: 1, cashAmount: 100,
                    localSymbol: 'TQQQ  260717P00045000',
                });
                const closed = event({
                    kind: 'option_trade', tradeDate: '2026-06-02', right: 'P',
                    strike: 45, expiry: '20260717', contracts: 1,
                    sharesPerContract: 100, price: 0.5, cashAmount: -50,
                    localSymbol: 'TQQQ 260717P00045000', tag: 'ibkr_close',
                });
                const ledger = core.computeLedger([opened, closed]);
                assert.equal(ledger.openOptions.length, 0);
                assert.equal(ledger.warnings.some(
                    (warning) => warning.includes('identity')), false);
            },
        },
        {
            name: 'a ledger-only option keeps its recorded contract multiplier',
            run() {
                const core = loadCore();
                const ledger = core.computeLedger([event({
                    kind: 'option_trade', tradeDate: '2026-06-01', right: 'P',
                    strike: 45, expiry: '20260717', contracts: -1,
                    sharesPerContract: 130, price: 1, cashAmount: 130,
                })]);
                const result = core.buildReconciliation({
                    ledger, symbol: 'TQQQ', positions: [],
                    defaultSharesPerContract: 100,
                });
                const row = result.rows.find((item) => item.kind === 'option');
                assert.equal(row.status, 'ledger_only');
                assert.equal(row.sharesPerContract, 130);
            },
        },
        {
            name: 'an IBKR closing trade with no opening is reported as a gap',
            run() {
                const core = loadCore();
                const gaps = core.findUnbackedCloses([event({
                    kind: 'option_trade', tradeDate: '2026-06-02', right: 'P',
                    strike: 45, expiry: '20260717', contracts: 1,
                    sharesPerContract: 100, price: 0.5, cashAmount: -50,
                    tag: 'ibkr_close',
                })], {});
                assert.equal(gaps.length, 1);
                assert.equal(gaps[0].missingContracts, -1);
            },
        },
        {
            name: 'malformed input never throws',
            run() {
                const core = loadCore();
                for (const input of [null, undefined, 'nope', 42, [null], [{}]]) {
                    const ledger = core.computeLedger(input);
                    assert.equal(typeof ledger.combined.netCash, 'number');
                    assert.equal(Number.isFinite(ledger.combined.netCash), true);
                }
                const reconciliation = core.buildReconciliation(null);
                assert.equal(reconciliation.balanced, true);
            },
        },
    ],
};
