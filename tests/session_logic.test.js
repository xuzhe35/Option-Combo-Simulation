const assert = require('node:assert/strict');

const { loadBrowserScripts, loadSessionLogicContext } = require('./helpers/load-browser-scripts');

module.exports = {
    name: 'session_logic.js',
    tests: [
        {
            name: 'defaults group live price mode to midpoint',
            run() {
                const ctx = loadSessionLogicContext();

                assert.equal(ctx.OptionComboSessionLogic.normalizeGroupLivePriceMode(), 'midpoint');
                assert.equal(ctx.OptionComboSessionLogic.normalizeGroupLivePriceMode(''), 'midpoint');
                assert.equal(ctx.OptionComboSessionLogic.normalizeGroupLivePriceMode('unknown'), 'midpoint');
                assert.equal(ctx.OptionComboSessionLogic.normalizeGroupLivePriceMode('mark'), 'mark');
            },
        },
        {
            name: 'normalizes the simulation time basis and weekend weight',
            run() {
                const ctx = loadSessionLogicContext();
                const logic = ctx.OptionComboSessionLogic;

                // Unrecognized input falls back to the weighted (λ=0.3) clock,
                // not the TWS calendar convention: weekends carrying full
                // variance is the assumption we deliberately reject.
                assert.equal(logic.normalizeSimTimeBasis(), 'weighted');
                assert.equal(logic.normalizeSimTimeBasis('bogus'), 'weighted');
                assert.equal(logic.normalizeSimTimeBasis('calendar'), 'calendar');
                assert.equal(logic.normalizeSimTimeBasis('Trading'), 'trading');
                assert.equal(logic.normalizeSimTimeBasis('weighted'), 'weighted');

                assert.equal(logic.normalizeSimWeekendWeight(undefined), 0.3);
                assert.equal(logic.normalizeSimWeekendWeight('nonsense'), 0.3);
                assert.equal(logic.normalizeSimWeekendWeight(-2), 0);
                assert.equal(logic.normalizeSimWeekendWeight(5), 1);
                assert.equal(logic.normalizeSimWeekendWeight('0.45'), 0.45);

                assert.equal(logic.resolveSimWeekendWeight('calendar', 0.45), 1);
                assert.equal(logic.resolveSimWeekendWeight('trading', 0.45), 0);
                assert.equal(logic.resolveSimWeekendWeight('weighted', 0.45), 0.45);
                assert.equal(logic.resolveSimWeekendWeight('weighted', 'bad'), 0.3);
                // An unrecognized basis normalizes to 'weighted', so it honors
                // the supplied λ instead of snapping to the calendar clock's 1.
                assert.equal(logic.resolveSimWeekendWeight('unknown', 0.45), 0.45);
                assert.equal(logic.resolveSimWeekendWeight('unknown', 'bad'), 0.3);
            },
        },
        {
            name: 'forces zero-cost groups into trial for render unless settlement',
            run() {
                const ctx = loadSessionLogicContext();

                assert.equal(
                    ctx.OptionComboSessionLogic.getRenderableGroupViewMode({
                        viewMode: 'active',
                        legs: [{ cost: 0 }],
                    }),
                    'trial'
                );

                assert.equal(
                    ctx.OptionComboSessionLogic.getRenderableGroupViewMode({
                        viewMode: 'settlement',
                        legs: [{ cost: 0 }],
                    }),
                    'settlement'
                );

                assert.equal(
                    ctx.OptionComboSessionLogic.isPortfolioAvgCostSyncEnabled({
                        viewMode: 'active',
                        legs: [{ cost: 0 }],
                    }),
                    true
                );

                assert.equal(
                    ctx.OptionComboSessionLogic.isPortfolioAvgCostSyncEnabled({
                        viewMode: 'active',
                        legs: [{ cost: 2.5 }],
                    }),
                    false
                );
            },
        },
        {
            name: 'blocks amortized mode requests for non-deterministic groups',
            run() {
                const ctx = loadSessionLogicContext();

                assert.equal(
                    ctx.OptionComboSessionLogic.resolveGroupViewModeChange(
                        { viewMode: 'trial', legs: [{ cost: 0 }] },
                        'amortized'
                    ),
                    'trial'
                );

                assert.equal(
                    ctx.OptionComboSessionLogic.resolveGroupViewModeChange(
                        { viewMode: 'trial', legs: [{ cost: 1.25 }] },
                        'amortized'
                    ),
                    'amortized'
                );
            },
        },
        {
            name: 'allows settlement for zero-cost groups and preserves deterministic requested modes',
            run() {
                const ctx = loadSessionLogicContext();

                assert.equal(
                    ctx.OptionComboSessionLogic.resolveGroupViewModeChange(
                        { viewMode: 'trial', legs: [{ cost: 0 }] },
                        'settlement'
                    ),
                    'settlement'
                );

                assert.equal(
                    ctx.OptionComboSessionLogic.resolveGroupViewModeChange(
                        { viewMode: 'trial', legs: [{ cost: 2.5 }] },
                        'active'
                    ),
                    'active'
                );

                assert.equal(
                    ctx.OptionComboSessionLogic.getRenderableGroupViewMode({
                        viewMode: 'amortized',
                        legs: [{ cost: 2.5 }],
                    }),
                    'amortized'
                );
            },
        },
        {
            name: 'treats missing global-inclusion flag as included by default',
            run() {
                const ctx = loadSessionLogicContext();

                assert.equal(
                    ctx.OptionComboSessionLogic.isGroupIncludedInGlobal({}),
                    true
                );

                assert.equal(
                    ctx.OptionComboSessionLogic.isGroupIncludedInGlobal({ includedInGlobal: false }),
                    false
                );
            },
        },
        {
            name: 'normalizes legacy imports and appends groups and hedges',
            run() {
                const ctx = loadSessionLogicContext();
                let idCounter = 0;
                const nextId = () => `id_${++idCounter}`;
                const addDays = (dateStr, days) => {
                    const d = new Date(`${dateStr}T00:00:00Z`);
                    d.setUTCDate(d.getUTCDate() + days);
                    return d.toISOString().slice(0, 10);
                };

                const result = ctx.OptionComboSessionLogic.normalizeImportedState(
                    {
                        groups: [{ id: 'existing_group' }],
                        hedges: [{ id: 'existing_hedge' }],
                    },
                    {
                        underlyingSymbol: 'QQQ',
                        underlyingContractMonth: '202606',
                        underlyingPrice: 500,
                        baseDate: '2026-03-14',
                        marketDataMode: 'historical',
                        greeksEnabled: true,
                        allowLiveHedgeOrders: true,
                        historicalQuoteDate: '2025-04-07',
                        daysPassed: 3,
                        selectedLiveComboOrderAccount: 'F7654321',
                        legs: [
                            { type: 'call', dte: 30, cost: 1.5 },
                        ],
                        hedges: [
                            { symbol: 'UVXY', pos: -100 },
                        ],
                    },
                    '2026-03-01',
                    nextId,
                    addDays
                );

                assert.equal(result.underlyingSymbol, 'QQQ');
                assert.equal(result.underlyingContractMonth, '202606');
                assert.equal(result.simulatedDate, '2026-03-17');
                assert.equal(result.marketDataMode, 'historical');
                assert.equal(result.greeksEnabled, true);
                assert.equal(result.historicalQuoteDate, '2025-04-07');
                assert.equal(result.groups.length, 2);
                assert.equal(result.hedges.length, 2);
                assert.equal(result.groups[1].name, 'Legacy Combo');
                assert.equal(result.groups[1].includedInGlobal, true);
                assert.equal(result.groups[1].isCollapsed, false);
                assert.equal(result.groups[1].historicalAutoCloseAtExpiry, true);
                assert.equal(result.groups[1].syncAvgCostFromPortfolio, false);
                assert.equal(result.groups[1].legs[0].expDate, '2026-04-13');
                assert.equal(result.groups[1].legs[0].closePrice, null);
                assert.equal(result.groups[1].legs[0].underlyingFutureId, '');
                assert.equal(result.forwardRateSamples.length, 0);
                assert.equal(result.futuresPool.length, 0);
                assert.equal(Array.isArray(result.liveComboOrderAccounts), true);
                assert.equal(result.liveComboOrderAccounts.length, 0);
                assert.equal(result.liveComboOrderAccountsConnected, false);
                assert.equal(result.selectedLiveComboOrderAccount, 'F7654321');
                assert.equal(result.allowLiveHedgeOrders, false);
                assert.equal(result.requireExactContractTiming, true);
                assert.equal(result.projectionConvergenceMode, 'strict-bbo');
                assert.equal(result.hedges[1].id, 'id_3');
            },
        },
        {
            name: 'normalizes grouped imports with explicit simulated date and defaults',
            run() {
                const ctx = loadSessionLogicContext();
                let idCounter = 0;
                const nextId = () => `gid_${++idCounter}`;
                const addDays = (dateStr, days) => {
                    const d = new Date(`${dateStr}T00:00:00Z`);
                    d.setUTCDate(d.getUTCDate() + days);
                    return d.toISOString().slice(0, 10);
                };

                const result = ctx.OptionComboSessionLogic.normalizeImportedState(
                    {
                        groups: [],
                        hedges: [],
                    },
                    {
                        underlyingSymbol: 'IWM',
                        underlyingContractMonth: '',
                        underlyingPrice: 212.5,
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-20',
                        marketDataMode: 'live',
                        historicalQuoteDate: '',
                        liveQuoteDate: '2026-03-19',
                        liveQuoteAsOf: '2026-03-19T20:00:00Z',
                        projectionConvergenceMode: 'legacy-input-iv',
                        requireExactContractTiming: false,
                        selectedLiveComboOrderAccount: 'DU12345',
                        groups: [
                            {
                                id: 'legacy_group',
                                name: 'Imported Group',
                                includedInGlobal: false,
                                isCollapsed: true,
                                viewMode: 'settlement',
                                settleUnderlyingPrice: 205,
                                historicalAutoCloseAtExpiry: false,
                                tradeTrigger: {
                                    enabled: true,
                                    condition: 'gte',
                                    price: 671.01,
                                    executionMode: 'submit',
                                    repriceThreshold: 0.0001,
                                    timeInForce: 'DAY',
                                    exitEnabled: true,
                                    exitCondition: 'lte',
                                    exitPrice: 670.5,
                                    status: 'submitted',
                                    pendingRequest: true,
                                    lastTriggeredAt: '2026-03-17T18:53:49Z',
                                    lastTriggerPrice: 671.01,
                                    lastPreview: {
                                        status: 'Filled',
                                        orderId: 2360,
                                    },
                                    lastError: 'old error',
                                },
                                closeExecution: {
                                    repriceThreshold: 0.0005,
                                    timeInForce: 'GTC',
                                    status: 'submitted',
                                    pendingRequest: true,
                                    lastPreview: {
                                        status: 'Submitted',
                                        orderId: 991,
                                    },
                                    lastError: 'stale close error',
                                },
                                legs: [
                                    {
                                        id: 'legacy_leg', type: 'put', strike: 210,
                                        expDate: '2026-04-17', iv: 0.24, cost: 3.1,
                                        portfolioMarketPrice: 0,
                                        portfolioMarketPriceSource: 'tws_portfolio',
                                    },
                                ],
                            },
                        ],
                    },
                    '2026-03-15',
                    nextId,
                    addDays
                );

                assert.equal(result.underlyingSymbol, 'IWM');
                assert.equal(result.simulatedDate, '2026-03-20');
                assert.equal(result.liveQuoteDate, '');
                assert.equal(result.liveQuoteAsOf, '');
                assert.equal(result.requireExactContractTiming, true);
                assert.equal(result.projectionConvergenceMode, 'legacy-input-iv');
                assert.equal(result.selectedLiveComboOrderAccount, 'DU12345');
                assert.equal(result.groups.length, 1);
                assert.equal(result.groups[0].id, 'gid_1');
                assert.equal(result.groups[0].includedInGlobal, false);
                assert.equal(result.groups[0].isCollapsed, true);
                assert.equal(result.groups[0].livePriceMode, 'midpoint');
                assert.equal(result.groups[0].historicalAutoCloseAtExpiry, false);
                assert.equal(result.groups[0].syncAvgCostFromPortfolio, false);
                assert.equal(result.groups[0].legs[0].portfolioMarketPrice, 0);
                assert.equal(result.groups[0].legs[0].portfolioMarketPriceSource, 'tws_portfolio');
                assert.equal(result.groups[0].viewMode, 'settlement');
                assert.equal(result.groups[0].settleUnderlyingPrice, 205);
                assert.equal(result.groups[0].tradeTrigger.enabled, false);
                assert.equal(result.groups[0].tradeTrigger.condition, 'gte');
                assert.equal(result.groups[0].tradeTrigger.price, 671.01);
                assert.equal(result.groups[0].tradeTrigger.executionMode, 'submit');
                assert.equal(result.groups[0].tradeTrigger.repriceThreshold, 0.0001);
                assert.equal(result.groups[0].tradeTrigger.exitEnabled, true);
                assert.equal(result.groups[0].tradeTrigger.exitPrice, 670.5);
                assert.equal(result.groups[0].tradeTrigger.isExpanded, false);
                assert.equal(result.groups[0].tradeTrigger.status, 'idle');
                assert.equal(result.groups[0].tradeTrigger.pendingRequest, false);
                assert.equal(result.groups[0].tradeTrigger.lastPreview, null);
                assert.equal(result.groups[0].tradeTrigger.lastError, '');
                assert.equal(result.groups[0].closeExecution.repriceThreshold, 0.0005);
                assert.equal(result.groups[0].closeExecution.executionMode, 'preview');
                assert.equal(result.groups[0].closeExecution.timeInForce, 'GTC');
                assert.equal(result.groups[0].closeExecution.isExpanded, false);
                assert.equal(result.groups[0].closeExecution.status, 'idle');
                assert.equal(result.groups[0].closeExecution.pendingRequest, false);
                assert.equal(result.groups[0].closeExecution.lastPreview, null);
                assert.equal(result.groups[0].closeExecution.lastError, '');
                assert.equal(result.groups[0].legs[0].id, 'gid_2');
                assert.equal(result.groups[0].legs[0].currentPrice, 0);
                assert.equal(result.groups[0].legs[0].closePrice, null);
            },
        },
        {
            name: 'normalizes imported forward-rate samples and futures pool entries',
            run() {
                const ctx = loadSessionLogicContext();
                let idCounter = 0;
                const nextId = () => `fid_${++idCounter}`;
                const addDays = (dateStr, days) => {
                    const d = new Date(`${dateStr}T00:00:00Z`);
                    d.setUTCDate(d.getUTCDate() + days);
                    return d.toISOString().slice(0, 10);
                };

                const result = ctx.OptionComboSessionLogic.normalizeImportedState(
                    {
                        groups: [],
                        hedges: [],
                    },
                    {
                        underlyingSymbol: 'SPX',
                        baseDate: '2026-03-01',
                        simulatedDate: '2026-03-02',
                        forwardRateSamples: [
                            {
                                id: 'legacy_sample',
                                daysToExpiry: 30,
                                strike: 5750,
                                dailyCarry: 0.00042,
                                impliedRate: 0.051,
                                lastComputedAt: '2026-03-01T12:00:00Z',
                            },
                        ],
                        futuresPool: [
                            {
                                id: 'legacy_future',
                                contractMonth: '202604',
                                bid: 71.25,
                                ask: 71.31,
                                mark: 71.28,
                                lastQuotedAt: '2026-03-01T12:00:00Z',
                            },
                        ],
                        groups: [{
                            name: 'Imported',
                            legs: [{
                                type: 'call',
                                strike: 5750,
                                expDate: '2026-03-31',
                                iv: 0.2,
                                underlyingFutureId: 'legacy_future',
                            }],
                        }],
                    },
                    '2026-03-01',
                    nextId,
                    addDays
                );

                assert.equal(result.forwardRateSamples.length, 1);
                assert.equal(result.forwardRateSamples[0].id, 'fid_3');
                assert.equal(result.forwardRateSamples[0].expDate, '2026-03-31');
                assert.equal(result.forwardRateSamples[0].dailyCarry, 0.00042);
                assert.equal(result.forwardRateSamples[0].impliedRate, 0.051);
                assert.equal(result.forwardRateSamples[0].isStale, true);

                assert.equal(result.futuresPool.length, 1);
                assert.equal(result.futuresPool[0].id, 'legacy_future');
                assert.equal(result.futuresPool[0].contractMonth, '202604');
                assert.equal(result.futuresPool[0].mark, 71.28);

                assert.equal(result.groups[0].legs[0].underlyingFutureId, 'legacy_future');
            },
        },
        {
            name: 'normalizes imported delta hedge config',
            run() {
                const ctx = loadSessionLogicContext();
                let idCounter = 0;
                const nextId = () => `dh_${++idCounter}`;
                const addDays = (dateStr, days) => {
                    const d = new Date(`${dateStr}T00:00:00Z`);
                    d.setUTCDate(d.getUTCDate() + days);
                    return d.toISOString().slice(0, 10);
                };

                const result = ctx.OptionComboSessionLogic.normalizeImportedState(
                    {
                        groups: [],
                        hedges: [],
                    },
                    {
                        underlyingSymbol: 'SPY',
                        baseDate: '2026-03-01',
                        deltaHedge: {
                            enabled: true,
                            targetDelta: '10',
                            tolerance: '25',
                            proactiveBuffer: '5',
                            hedgeInstrument: {
                                secType: 'fut',
                                symbol: 'es',
                                exchange: 'cme',
                                currency: '',
                                contractMonth: '202606',
                                multiplier: '50',
                                deltaPerUnit: '1',
                            },
                            orderType: 'mkt',
                            maxOrderQuantity: '3',
                            autoMaxNotional: '25000',
                            cooldownSeconds: '120',
                            autoSubmitEnabled: true,
                            autoCancelStaleOrders: false,
                            autoMaxOrdersPerDay: '4',
                            autoPreviewMaxAgeSeconds: '15',
                            pendingOrder: {
                                orderId: 123,
                            },
                        },
                    },
                    '2026-03-01',
                    nextId,
                    addDays
                );

                assert.equal(result.deltaHedge.enabled, true);
                assert.equal(result.deltaHedge.targetDelta, 10);
                assert.equal(result.deltaHedge.tolerance, 25);
                assert.equal(result.deltaHedge.proactiveBuffer, 5);
                assert.equal(result.deltaHedge.hedgeInstrument.secType, 'FUT');
                assert.equal(result.deltaHedge.hedgeInstrument.symbol, 'ES');
                assert.equal(result.deltaHedge.hedgeInstrument.exchange, 'CME');
                assert.equal(result.deltaHedge.hedgeInstrument.currency, 'USD');
                assert.equal(result.deltaHedge.hedgeInstrument.contractMonth, '202606');
                assert.equal(result.deltaHedge.hedgeInstrument.multiplier, 50);
                assert.equal(result.deltaHedge.orderType, 'MKT');
                assert.equal(result.deltaHedge.maxOrderQuantity, 3);
                assert.equal(result.deltaHedge.autoMaxNotional, 25000);
                assert.equal(result.deltaHedge.cooldownSeconds, 120);
                assert.equal(result.deltaHedge.autoSubmitEnabled, false);
                assert.equal(result.deltaHedge.autoCancelStaleOrders, false);
                assert.equal(result.deltaHedge.autoMaxOrdersPerDay, 4);
                assert.equal(result.deltaHedge.autoPreviewMaxAgeSeconds, 15);
                assert.equal('pendingOrder' in result.deltaHedge, false);
            },
        },
        {
            name: 'builds export state as a detached snapshot and strips runtime trade trigger state',
            run() {
                const ctx = loadSessionLogicContext();
                const original = {
                    underlyingSymbol: 'SPY',
                    liveQuoteDate: '2026-03-19',
                    liveQuoteAsOf: '2026-03-19T20:00:00Z',
                    greeksEnabled: true,
                    allowLiveHedgeOrders: true,
                    deltaHedge: {
                        enabled: true,
                        targetDelta: '5',
                        tolerance: '30',
                        proactiveBuffer: '3',
                        hedgeInstrument: {
                            secType: 'stk',
                            symbol: 'spy',
                            multiplier: '1',
                            deltaPerUnit: '1',
                        },
                        orderType: 'lmt',
                        autoMaxNotional: '25000',
                        autoSubmitEnabled: true,
                        autoCancelStaleOrders: false,
                        autoMaxOrdersPerDay: '4',
                        autoPreviewMaxAgeSeconds: '15',
                        pendingOrder: {
                            orderId: 123,
                        },
                        lastError: 'stale runtime error',
                    },
                    forwardRateSamples: [{
                        id: 'sample_1',
                        daysToExpiry: 30,
                        expDate: '2026-03-31',
                        strike: 5750,
                        dailyCarry: 0.00042,
                        impliedRate: 0.051,
                        lastComputedAt: '2026-03-01T12:00:00Z',
                        isStale: false,
                    }],
                    futuresPool: [{
                        id: 'future_1',
                        contractMonth: '202604',
                        bid: 71.25,
                        ask: 71.31,
                        mark: 71.28,
                        lastQuotedAt: '2026-03-01T12:00:00Z',
                    }],
                    groups: [{
                        id: 'g1',
                        name: 'Test',
                        legs: [{
                            id: 'leg_1',
                            type: 'call',
                            underlyingFutureId: 'future_1',
                            expiryAsOf: '2026-03-20T20:00:00.000Z',
                            expiryTimingSource: 'ib_contract_details',
                            lastTradeDate: '20260320',
                            lastTradeTime: '16:00:00',
                            expiryTimeZoneId: 'US/Eastern',
                            realExpirationDate: '20260320',
                            qualifiedOptionConId: 12345,
                            qualifiedOptionLocalSymbol: 'ES TEST',
                            qualifiedOptionTradingClass: 'EW3',
                            qualifiedOptionUnderConId: 67890,
                            qualifiedOptionUnderlyingContractMonth: '202606',
                            liveQuoteIdentityStatus: 'verified',
                            liveQuoteIdentityReason: '',
                        }],
                        tradeTrigger: {
                            enabled: true,
                            condition: 'gte',
                            price: 671.01,
                            executionMode: 'submit',
                            repriceThreshold: 0.0001,
                            timeInForce: 'DAY',
                            exitEnabled: true,
                            exitCondition: 'lte',
                            exitPrice: 670.5,
                            status: 'submitted',
                            pendingRequest: true,
                            lastTriggeredAt: '2026-03-17T18:53:49Z',
                            lastTriggerPrice: 671.01,
                            lastPreview: {
                                status: 'Filled',
                                orderId: 2360,
                            },
                            lastError: 'old error',
                        },
                        closeExecution: {
                            executionMode: 'test_submit',
                            repriceThreshold: 0.0005,
                            timeInForce: 'GTC',
                            status: 'submitted',
                            pendingRequest: true,
                            lastPreview: {
                                status: 'Filled',
                                orderId: 991,
                            },
                            lastError: 'stale close error',
                        },
                    }],
                };

                const snapshot = ctx.OptionComboSessionLogic.buildExportState(original);
                snapshot.groups[0].name = 'Changed';

                assert.equal(original.groups[0].name, 'Test');
                assert.equal(snapshot.groups[0].name, 'Changed');
                assert.equal('liveQuoteDate' in snapshot, false);
                assert.equal('liveQuoteAsOf' in snapshot, false);
                assert.equal('expiryAsOf' in snapshot.groups[0].legs[0], false);
                assert.equal('expiryTimingSource' in snapshot.groups[0].legs[0], false);
                assert.equal('lastTradeTime' in snapshot.groups[0].legs[0], false);
                assert.equal('qualifiedOptionConId' in snapshot.groups[0].legs[0], false);
                assert.equal('qualifiedOptionTradingClass' in snapshot.groups[0].legs[0], false);
                assert.equal('liveQuoteIdentityStatus' in snapshot.groups[0].legs[0], false);
                assert.equal(snapshot.greeksEnabled, true);
                assert.equal(snapshot.allowLiveHedgeOrders, false);
                assert.equal(snapshot.groups[0].tradeTrigger.enabled, false);
                assert.equal(snapshot.groups[0].tradeTrigger.condition, 'gte');
                assert.equal(snapshot.groups[0].tradeTrigger.price, 671.01);
                assert.equal(snapshot.groups[0].tradeTrigger.executionMode, 'submit');
                assert.equal(snapshot.groups[0].tradeTrigger.repriceThreshold, 0.0001);
                assert.equal(snapshot.groups[0].tradeTrigger.exitEnabled, true);
                assert.equal(snapshot.groups[0].tradeTrigger.exitPrice, 670.5);
                assert.equal(snapshot.groups[0].tradeTrigger.isExpanded, false);
                assert.equal(snapshot.groups[0].tradeTrigger.status, 'idle');
                assert.equal(snapshot.groups[0].tradeTrigger.pendingRequest, false);
                assert.equal(snapshot.groups[0].tradeTrigger.lastTriggeredAt, null);
                assert.equal(snapshot.groups[0].tradeTrigger.lastPreview, null);
                assert.equal(snapshot.groups[0].tradeTrigger.lastError, '');
                assert.equal(snapshot.groups[0].closeExecution.repriceThreshold, 0.0005);
                assert.equal(snapshot.groups[0].closeExecution.executionMode, 'test_submit');
                assert.equal(snapshot.groups[0].closeExecution.timeInForce, 'GTC');
                assert.equal(snapshot.groups[0].closeExecution.isExpanded, false);
                assert.equal(snapshot.groups[0].closeExecution.status, 'idle');
                assert.equal(snapshot.groups[0].closeExecution.pendingRequest, false);
                assert.equal(snapshot.groups[0].closeExecution.lastPreview, null);
                assert.equal(snapshot.groups[0].closeExecution.lastError, '');
                assert.equal(snapshot.deltaHedge.enabled, true);
                assert.equal(snapshot.deltaHedge.targetDelta, 5);
                assert.equal(snapshot.deltaHedge.tolerance, 30);
                assert.equal(snapshot.deltaHedge.proactiveBuffer, 3);
                assert.equal(snapshot.deltaHedge.hedgeInstrument.secType, 'STK');
                assert.equal(snapshot.deltaHedge.hedgeInstrument.symbol, 'SPY');
                assert.equal(snapshot.deltaHedge.orderType, 'LMT');
                assert.equal(snapshot.deltaHedge.autoMaxNotional, 25000);
                assert.equal(snapshot.deltaHedge.autoSubmitEnabled, false);
                assert.equal(snapshot.deltaHedge.autoCancelStaleOrders, false);
                assert.equal(snapshot.deltaHedge.autoMaxOrdersPerDay, 4);
                assert.equal(snapshot.deltaHedge.autoPreviewMaxAgeSeconds, 15);
                assert.equal('pendingOrder' in snapshot.deltaHedge, false);
                assert.equal('lastError' in snapshot.deltaHedge, false);
                assert.equal(snapshot.forwardRateSamples[0].dailyCarry, 0.00042);
                assert.equal(snapshot.forwardRateSamples[0].lastComputedAt, '2026-03-01T12:00:00Z');
                assert.equal(snapshot.futuresPool[0].contractMonth, '202604');
                assert.equal(snapshot.groups[0].legs[0].underlyingFutureId, 'future_1');
                assert.equal(snapshot.futuresPool[0].bid, null);
                assert.equal(snapshot.futuresPool[0].ask, null);
                assert.equal(snapshot.futuresPool[0].mark, null);
            },
        },
        {
            name: 'creates the initial front-month Futures Pool entry once and preserves an existing quote',
            run() {
                const ctx = loadBrowserScripts([
                    'js/product_registry.js',
                    'js/session_logic.js',
                ]);
                const logic = ctx.OptionComboSessionLogic;
                const state = {
                    underlyingSymbol: 'ES',
                    underlyingContractMonth: '',
                    simulatedDate: '2026-07-20',
                    futuresPool: [],
                    groups: [{
                        legs: [{ id: 'call', type: 'call', underlyingFutureId: '' }],
                    }],
                };

                const first = logic.ensureInitialFuturesPoolEntry(state, () => 'future_sep');
                assert.equal(first.created, true);
                assert.equal(state.underlyingContractMonth, '202609');
                assert.equal(state.futuresPool.length, 1);
                assert.equal(state.futuresPool[0].contractMonth, '202609');
                assert.equal(state.groups[0].legs[0].underlyingFutureId, 'future_sep');

                state.futuresPool[0].mark = 7493.5;
                state.futuresPool[0].quoteAsOf = '2026-07-20T08:00:00Z';
                const second = logic.ensureInitialFuturesPoolEntry(state, () => 'should_not_run');
                assert.equal(second.created, false);
                assert.equal(second.entry, first.entry);
                assert.equal(state.futuresPool.length, 1);
                assert.equal(state.futuresPool[0].mark, 7493.5);
                assert.equal(state.futuresPool[0].quoteAsOf, '2026-07-20T08:00:00Z');
            },
        },
        {
            name: 'auto-binds unbound option legs when the Futures Pool has exactly one entry',
            run() {
                const ctx = loadSessionLogicContext();
                const logic = ctx.OptionComboSessionLogic;
                const state = {
                    underlyingSymbol: 'ES',
                    futuresPool: [{ id: 'future_sep', contractMonth: '202609' }],
                    groups: [{
                        legs: [
                            { id: 'call', type: 'call', underlyingFutureId: '' },
                            { id: 'put', type: 'put', underlyingFutureId: 'missing_future' },
                            { id: 'future_leg', type: 'stock', underlyingFutureId: '' },
                        ],
                    }],
                };

                assert.equal(logic.autoBindSingleFuturesPoolEntry(state), true);
                assert.equal(state.groups[0].legs[0].underlyingFutureId, 'future_sep');
                assert.equal(state.groups[0].legs[1].underlyingFutureId, 'future_sep');
                assert.equal(state.groups[0].legs[2].underlyingFutureId, '');
                assert.equal(logic.autoBindSingleFuturesPoolEntry(state), false);

                state.futuresPool.push({ id: 'future_dec', contractMonth: '202612' });
                state.groups[0].legs[0].underlyingFutureId = '';
                assert.equal(logic.autoBindSingleFuturesPoolEntry(state), false);
                assert.equal(state.groups[0].legs[0].underlyingFutureId, '');
            },
        },
        {
            name: 'resolves the weekend-weight spec from the IVTS implied-lambda entry',
            run() {
                const ctx = loadSessionLogicContext();
                const logic = ctx.OptionComboSessionLogic;
                const entry = {
                    schemaVersion: 2,
                    symbol: 'ES',
                    varianceSource: 'straddle',
                    quality: { status: 'ok', coherent: true, quoteComplete: true },
                    medianLambda: 0.12,
                    byDate: { '2026-07-18': 0.13, '2026-07-19': 0.13 },
                    coverageStart: '2026-07-18',
                    coverageEnd: '2026-07-19',
                };

                // Disabled or non-weighted basis is an explicit scalar mode.
                assert.equal(logic.resolveSimWeekendWeightSpec('weighted', 0.3, false, entry), 0.3);
                assert.equal(logic.resolveSimWeekendWeightSpec('calendar', 0.3, true, entry), 1);
                assert.equal(logic.resolveSimWeekendWeightSpec('trading', 0.3, true, entry), 0);
                // Once implied mode is enabled, missing or unqualified data
                // remains strict and cannot silently fall back to scalar.
                const missing = logic.resolveSimWeekendWeightSpec('weighted', 0.3, true, null);
                assert.equal(missing.strictByDate, true);
                assert.equal(missing.byDate, null);
                assert.equal(missing.default, 0.3);
                assert.equal(logic.resolveSimWeekendWeightSpec(
                    'weighted', 0.3, true, { ...entry, schemaVersion: 1 }
                ).strictByDate, true);
                assert.equal(logic.resolveSimWeekendWeightSpec(
                    'weighted', 0.3, true, { ...entry, varianceSource: 'vendor_iv' }
                ).byDate, null);
                const auditedVendor = {
                    ...entry,
                    varianceSource: 'vendor_iv',
                    quality: {
                        ...entry.quality,
                        estimationMode: 'best_effort',
                        sourceQuoteEvidence: 'vendor_atm_iv_fallback',
                    },
                };
                assert.equal(logic.resolveSimWeekendWeightSpec(
                    'weighted', 0.3, true, auditedVendor
                ).byDate['2026-07-18'], 0.13);

                // Enabled with dates: every required non-trading date must be
                // present. The scalar is metadata only, never a hole filler.
                const spec = logic.resolveSimWeekendWeightSpec('weighted', 0.3, true, entry);
                assert.equal(spec.default, 0.3);
                assert.equal(spec.byDate['2026-07-18'], 0.13);
                assert.equal(spec.strictByDate, true);
                assert.equal(spec.coverageStart, '2026-07-18');
                assert.equal(spec.coverageEnd, '2026-07-19');
                assert.equal(spec.fallbackSource, null);

                // Median is descriptive and never changes the fallback.
                const noMedian = logic.resolveSimWeekendWeightSpec(
                    'weighted', 0.25, true, { ...entry, medianLambda: null }
                );
                assert.equal(noMedian.default, 0.25);
                const misleadingMedian = logic.resolveSimWeekendWeightSpec(
                    'weighted', 0.25, true, { ...entry, medianLambda: 0.99 }
                );
                assert.equal(misleadingMedian.default, 0.25);

                // New and pre-implied-λ sessions default to the strict mode;
                // only an explicit false selects the scalar alternative.
                assert.equal(logic.normalizeSimUseImpliedLambda(undefined), true);
                assert.equal(logic.normalizeSimUseImpliedLambda(null), true);
                assert.equal(logic.normalizeSimUseImpliedLambda(true), true);
                assert.equal(logic.normalizeSimUseImpliedLambda(false), false);

                assert.equal(logic.normalizeProjectionConvergenceMode(undefined), 'strict-bbo');
                assert.equal(logic.normalizeProjectionConvergenceMode('strict-bbo'), 'strict-bbo');
                assert.equal(
                    logic.normalizeProjectionConvergenceMode('legacy-input-iv'),
                    'legacy-input-iv'
                );
                assert.equal(logic.normalizeProjectionConvergenceMode('loose'), 'strict-bbo');

                // The runtime cache never reaches an exported session snapshot.
                const snapshot = logic.buildExportState({
                    simUseImpliedLambda: true,
                    simImpliedLambdaEntry: entry,
                    simImpliedLambdaFileEntry: entry,
                    liveProjectionFeedConnected: true,
                    liveProjectionFeedStale: false,
                    liveProjectionLastReceivedAt: '2026-07-20T20:00:00Z',
                    groups: [],
                    hedges: [],
                    deltaHedge: logic.createDefaultDeltaHedgeConfig(),
                });
                assert.equal(snapshot.simUseImpliedLambda, true);
                assert.equal(snapshot.projectionConvergenceMode, 'strict-bbo');
                assert.equal('simImpliedLambdaEntry' in snapshot, false);
                assert.equal('simImpliedLambdaFileEntry' in snapshot, false);
                assert.equal('liveProjectionFeedConnected' in snapshot, false);
                assert.equal('liveProjectionFeedStale' in snapshot, false);
                assert.equal('liveProjectionLastReceivedAt' in snapshot, false);
            },
        },
    ],
};
